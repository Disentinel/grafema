---
name: rfdb-write-lock-edge-flush-gotcha
description: |
  RFDB server becomes unresponsive (60s+ timeouts) during enricher addEdges write storms.
  Use when: (1) RFDB CPU spikes to 60-90% after addEdges calls; (2) subsequent reads time out
  at 60s; (3) server stays catatonic for 5-15 min after a write storm; (4) Tokio main thread
  parked (write-lock contention). Root cause: add_edges() calls maybe_auto_flush() which has a
  memory-pressure path that fires on NODE count — not edge count — and holds the exclusive write
  lock during disk I/O. Fix: separate maybe_auto_flush_edges() uses byte-limit only.
author: Claude Code
version: 1.0.0
date: 2026-04-26
---

# RFDB Write Lock Edge-Flush Gotcha (RFD-67)

## Problem

RFDB server saturates during enricher write storms. A single `addEdges` call can hold the
exclusive write lock (`db.engine.write()`) for seconds while flushing data to disk,
blocking ALL reads and other writes during that time.

## Context / Trigger Conditions

- Enrichers (`behaviorEnricher`, `packageApiEnricher`) call `client.addEdges()` repeatedly
- Server was previously used for `grafema analyze` (analysis nodes still in write buffer)
- System memory > 70% used (very common on dev machines)
- First `addEdges` call spikes CPU; subsequent calls time out at 60s

## Root Cause (code trace)

```
client.addEdges(10 edges)
  → with_engine_write()               ← acquires EXCLUSIVE write lock
    → engine.add_edges()
      → store.upsert_edges()          ← fast, in-memory (~0.01ms)
      → self.maybe_auto_flush()       ← ← ← THE BUG
        Path 2: memory_pressure > 0.7 && total_write_buffer_nodes() >= 500
          → store.flush_all()         ← DISK I/O (seconds) under write lock!
  → lock released
```

`maybe_auto_flush` has two paths:
1. Buffer overflow: `any_shard_needs_flush(node_limit, byte_limit)` — fine
2. **Memory pressure**: `memory_pressure > 0.7 && total_write_buffer_nodes() >= 500` — BUG

Path 2 fires based on **nodes**, not edges. After `grafema analyze`, the write buffer holds
analysis nodes. The enricher's first `addEdges` call triggers a full flush of all those
analysis nodes — the edge write causes a massive node flush.

Files involved:
- `packages/rfdb-server/src/graph/engine_v2.rs` — `add_edges()`, `maybe_auto_flush()`
- `packages/rfdb-server/src/bin/rfdb_server.rs` — `with_engine_write()` (line ~2289)
- `packages/rfdb-server/src/database_manager.rs` — `Database.engine: RwLock<Box<dyn GraphStore>>`

## Fix (applied in RFD-67)

Replace `maybe_auto_flush()` call in `add_edges` with `maybe_auto_flush_edges()`:

```rust
fn maybe_auto_flush_edges(&mut self) {
    // Byte-limit only — never fires on memory pressure / node count.
    // Prevents edge writes from triggering node flushes under write lock.
    if self.store.any_shard_needs_flush(usize::MAX, self.cached_profile.write_buffer_byte_limit) {
        if let Err(e) = self.store.flush_all(&mut self.manifest) {
            tracing::warn!("auto-flush (edges) failed: {}", e);
        }
    }
}
```

Key invariant: `add_nodes` keeps `maybe_auto_flush()` (nodes are 120 bytes, OOM risk is real).
`add_edges` uses `maybe_auto_flush_edges()` (edges are 98 bytes, byte limit = 100MB default).

## Verification

Test: `test_edge_writes_do_not_block_reads` in `engine_v2.rs` — wraps engine in RwLock,
runs concurrent writer + reader threads, asserts reads complete in < 1s during edge storm.

## Enricher Contract After Fix

Enrichers must call `Flush` explicitly after their write phase:

```javascript
await enrichBehaviors(client, lookup, { flushBatchSize: 50 });
await client.flush();  // required — edges won't auto-flush during normal write storms
```

Recommended `flushBatchSize`: 50–200 edges per batch. Under 50: excessive socket round-trips.
Over 200: diminishing returns, larger per-request latency.

## Diagnosis Checklist

If RFDB saturates again:
1. `RFDB_VERBOSE=1` — log every request; look for `AddEdges`/`Flush` taking > 1s
2. `GetStats` → `shardDiagnostics.writeBufferNodes` — high = unflushed analysis nodes
3. `samply record` on rfdb-server PID → look for `flush_with_ids` holding write lock
4. Check if enricher calls `client.flush()` after writes

## Notes

The fundamental fix (moving disk I/O off the write-lock path entirely via background flush
thread) is deferred. The current fix eliminates the specific bug: edge writes triggering node
flushes. If enrichers begin emitting both nodes AND edges, the `add_nodes` memory-pressure path
could trigger — at that point a background flush thread becomes necessary.

Safe write throughput: up to ~100K addEdges batches (at 10 edges each) before auto-flush.
That's 1M edges before the byte limit triggers. No enricher should hit this in practice.
