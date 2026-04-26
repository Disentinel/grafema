# RFDB Write Throughput — Analysis & Safe Limits

*2026-04-26 · RFD-67*

## Problem Summary

The RFDB server saturated during enricher `addEdges` write storms. A single `addEdges` call
could block ALL reads for seconds (observed: 5–15 min of effective unresponsiveness).

## Root Cause

`GraphEngineV2::add_edges()` called `maybe_auto_flush()` at the end. This function has two
trigger paths:

**Path 1 — buffer overflow:**
```rust
if self.store.any_shard_needs_flush(node_limit, byte_limit) { flush_all(); }
```
Triggers when write buffer exceeds adaptive limits (default: 50K nodes or 100MB total).

**Path 2 — memory pressure (THE BUG):**
```rust
if memory_pressure > 0.7 && total_write_buffer_nodes() >= 500 { flush_all(); }
```
Triggers when system RAM > 70% used AND write buffer has ≥500 nodes.

The bug: after `grafema analyze`, the write buffer still contains analysis nodes (before
explicit `Compact`). When an enricher sends `addEdges`, if system memory > 70%, the first
call triggers a full flush of ALL those analysis nodes — a large disk I/O operation that
holds the exclusive write lock, blocking every other request.

`flush_all()` is O(shards × buffer_size). For Grafema's own graph (~80K nodes, 4 shards),
this can take seconds while holding the write lock.

## Fix (committed in RFD-67)

Added `maybe_auto_flush_edges()` — a byte-limit-only variant:
- No memory-pressure path
- Node limit = `usize::MAX` (edges alone never trigger a node flush)
- Byte limit = same adaptive limit (100MB) as before — genuine OOM safeguard

`add_edges` now calls `maybe_auto_flush_edges()` instead of `maybe_auto_flush()`.
`add_nodes` still calls `maybe_auto_flush()` (nodes are 120 bytes each, OOM risk is real).

## Safe Write Throughput (as of RFD-67)

| Operation | Write lock hold time | Auto-flush trigger |
|-----------|---------------------|-------------------|
| `addNodes` 100 nodes | ~0.1ms | at 50K nodes or 100MB |
| `addEdges` 10 edges | ~0.01ms | at 100MB (edges only) |
| `addEdges` flush | seconds | (only at true OOM risk) |
| `Flush` explicit | 50–500ms | — always |
| `Compact` | 2–30s | — always |

**Edge write storm capacity**: up to 100MB / 98 bytes ≈ **1M edges** before auto-flush.
At 10 edges/batch: **100K batches** before auto-flush triggers. This is far beyond any
enricher's need; enrichers should `Flush` explicitly when they finish.

## Enricher Contract

Enrichers MUST call `Flush` (or `Compact`) after their write phase:

```javascript
await enrichBehaviors(client, lookup, { maxDepth: 10, flushBatchSize: 50 });
await client.flush();  // ← required for durability and to clear write buffer
```

Without explicit flush, edges remain in the write buffer until the next `analyze`/`compact`
cycle. This is safe (no data loss within a session) but the buffer grows unboundedly.

**Recommended `flushBatchSize`**: 50–200 edges. Smaller batches increase request overhead
(socket round-trips). Larger batches increase per-request latency. 50 is a good default.

## Architecture Note

The fundamental fix would be to move disk I/O off the write-lock critical path entirely
(background flush thread, write-buffer swap pattern). This is a larger refactor tracked
as a future improvement. The RFD-67 fix eliminates the specific bug (edge writes triggering
node flushes) without restructuring the locking model.

If enrichers emit both nodes AND edges (currently they don't), the `add_nodes` path still
has the memory-pressure flush risk. At that point the background flush approach becomes
necessary.

## Diagnosis Checklist

If RFDB saturates again:
1. `RFDB_VERBOSE=1` — logs every request with timing; look for `Flush`/`CompactBatch` taking > 1s
2. `GetStats` → check `shardDiagnostics.writeBufferNodes` — high numbers indicate unflushed data
3. `samply record` on `rfdb-server` PID — look for `flush_with_ids` holding the write lock
4. Check enricher code: does it call `Flush` after writes?
