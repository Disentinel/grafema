---
name: rfdb-v2-clear-ephemeral-trap
description: |
  Fix RFDB V2 graph data silently not persisting to disk after analysis. Use when:
  (1) rfdb-server reports "0 nodes, 0 edges" on restart despite successful analysis,
  (2) segment directories exist but are empty (no .bin files), (3) manifest_index.json
  shows total_nodes: 0 despite analysis logging 70k+ nodes, (4) Docker builds produce
  empty graph databases, (5) --clear flag used before analyze command. Root cause:
  GraphEngineV2::clear() replaces the store with MultiShardStore::ephemeral() which
  has path: None, causing all flush operations to write to in-memory buffers only.
author: Claude Code
version: 1.0.0
date: 2026-02-20
---

# RFDB V2 Clear Makes Engine Ephemeral

## Problem

After running `grafema analyze --clear`, the analysis completes successfully and reports
tens of thousands of nodes/edges, but on restart the database is empty (0 nodes, 0 edges).
The data was never persisted to disk despite multiple flush operations succeeding without
error.

## Context / Trigger Conditions

- `grafema analyze --clear --auto-start` reports successful analysis with node/edge counts
- On restart, rfdb-server logs "Default database: 0 nodes, 0 edges"
- `manifest_index.json` shows `"total_nodes": 0, "total_edges": 0`
- Segment directories (`segments/00/`, `segments/01/`, etc.) exist but are empty
- No error messages anywhere in the logs
- The `tracing::info!("Flushing...")` message from `collect_and_write_data()` never appears
  (because CommitBatch already flushed, but to ephemeral storage)

## Root Cause

`GraphEngineV2::clear()` (engine_v2.rs:572-578) replaces the store and manifest with
ephemeral versions:

```rust
fn clear(&mut self) {
    self.store = MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT);  // path: None!
    self.manifest = ManifestStore::ephemeral();
    // ...
}
```

`MultiShardStore::ephemeral()` creates shards with `path: None`. When `Shard::flush_with_ids()`
runs (shard.rs:710), it checks `if let Some(path) = &self.path` — ephemeral shards take the
`else` branch which writes to an in-memory `Cursor<Vec<u8>>` instead of disk files.

The data lives in memory segments and is queryable (nodeCount/edgeCount return correct values),
but nothing is written to disk. When the process exits, all data is lost.

## Why It's Hard to Detect

1. **No errors**: All operations succeed — add_nodes, flush, nodeCount all work correctly
2. **Counts are correct**: The server reports accurate node/edge counts from in-memory segments
3. **CommitBatch masks the issue**: Each CommitBatch internally calls flush(), which succeeds
   (to memory). The subsequent explicit `flush()` from the CLI finds an empty delta_log and
   returns early — so the `tracing::info!("Flushing...")` message never appears
4. **Segments directory structure exists**: The directories are created during initial DB
   creation before clear() is called

## Solution

**Don't use `--clear` when you need data to persist.** For fresh builds (Docker, CI):

```dockerfile
# BAD: --clear makes V2 engine ephemeral, data lost
RUN grafema analyze /build --clear --auto-start

# GOOD: No --clear needed for fresh build (no existing DB)
RUN grafema analyze /build --auto-start
```

If you truly need to clear and re-analyze an existing database, the proper approach is to
delete the database directory before starting the server, rather than using `--clear`:

```bash
rm -rf .grafema/graph.rfdb
grafema analyze . --auto-start
```

## Verification

After analysis completes, check that segments contain actual data:

```bash
# Should show .bin files with non-zero size
ls -la .grafema/graph.rfdb/segments/00/

# Should show total_nodes > 0
cat .grafema/graph.rfdb/manifest_index.json
```

## Notes

- This is a V2-specific issue. V1 engine's `clear()` resets in-place without making
  shards ephemeral.
- The `--clear` flag sends a `Clear` command to the server which calls `engine.clear()`.
- `create_ephemeral()` is designed for test databases that don't need persistence.
  Using it in `clear()` is an architectural shortcut that creates this trap.
- Related MEMORY note: "Ephemeral databases skip flush" — this is the V2 manifestation
  of the same concept documented for V1.
