# Don's Plan: RFD-29 — Make v2 edge write-buffer upsert semantics explicit

## Context

`WriteBuffer::add_edge` currently performs upsert (insert-or-update) but hides this behind an `add_*` name and a `bool` return value. The return type is opaque (`true` = inserted, `false` = updated), and no callsite actually inspects the return value.

This task makes the semantics explicit with better naming and return types.

## Design Decisions

1. **Return type**: Use an enum `EdgeWriteOp { Inserted, Updated }` instead of `bool`
   - More Rust-idiomatic than separate insert/update/upsert methods
   - Simpler API surface — one method that's explicit about what happened
   - Self-documenting at callsites

2. **Method naming**: Rename `add_edge` → `upsert_edge`, `add_edges` → `upsert_edges`
   - No backward compat needed — this is internal storage API, not public crate
   - Matches Rust community conventions (e.g., `HashMap::entry().or_insert()`)

3. **Batch return**: `upsert_edges` returns `UpsertStats { inserted: usize, updated: usize }`
   - More useful than just count of insertions
   - Zero overhead (just two counters)

4. **Callsite updates**: All layers (shard, multi-shard, engine) update to new names
   - Since no one inspects return values, this is mechanical
   - Most callsites can ignore the return value (`.upsert_edges()` instead of `.add_edges()`)

## Files Modified

- `packages/rfdb-server/src/storage_v2/write_buffer.rs` — core upsert logic, tests
- `packages/rfdb-server/src/storage_v2/shard.rs` — delegates to WriteBuffer
- `packages/rfdb-server/src/storage_v2/multi_shard.rs` — delegates to Shard
- `packages/rfdb-server/src/graph/engine_v2.rs` — delegates to MultiShardStore

## Implementation Steps

### Step 1: Define EdgeWriteOp and UpsertStats in write_buffer.rs

**Changes:**
- Add `EdgeWriteOp` enum: `Inserted`, `Updated`
- Add `UpsertStats` struct with `inserted: usize, updated: usize` counters
- Update existing tests to use the new enum

**Tests:**
- Update `test_edge_dedup` to check `EdgeWriteOp::Inserted` vs `Updated`
- Update `test_edge_upsert_replaces_metadata` to assert `Updated` on second call

**LOC:** ~15 lines (enum + struct + test updates)

### Step 2: Rename add_edge → upsert_edge, update return type

**Changes:**
- `pub fn add_edge(&mut self, record) -> bool` → `pub fn upsert_edge(&mut self, record) -> EdgeWriteOp`
- Change implementation: `return true` → `return EdgeWriteOp::Inserted`, `return false` → `return EdgeWriteOp::Updated`
- Update test assertions

**Tests:**
- All existing tests should pass with updated assertions

**LOC:** ~10 lines changed

### Step 3: Rename add_edges → upsert_edges, update return type

**Changes:**
- `pub fn add_edges(&mut self, records) -> usize` → `pub fn upsert_edges(&mut self, records) -> UpsertStats`
- Update implementation to count insertions and updates separately
- Update doc comments to reflect upsert semantics

**Tests:**
- Update tests to destructure `UpsertStats` or ignore it

**LOC:** ~15 lines changed

### Step 4: Update Shard layer

**Changes:**
- `pub fn add_edges(&mut self, records)` → `pub fn upsert_edges(&mut self, records)`
- Update delegation to `self.write_buffer.upsert_edges(records)`
- Update doc comments

**Tests:**
- Update all `add_edges` calls in shard tests to `upsert_edges`

**LOC:** ~5 lines changed + ~30 test callsites

### Step 5: Update MultiShardStore layer

**Changes:**
- `pub fn add_edges(&mut self, records) -> Result<()>` → `pub fn upsert_edges(&mut self, records) -> Result<()>`
- Update delegation to `self.shards[shard_id].upsert_edges(edges)`
- Update doc comments

**Tests:**
- Update all `add_edges` calls in multi_shard tests to `upsert_edges`

**LOC:** ~5 lines changed + ~40 test callsites

### Step 6: Update GraphEngineV2 layer

**Changes:**
- Update internal `store.add_edges(v2_edges)` → `store.upsert_edges(v2_edges)`
- Public API `GraphStore::add_edges` stays the same (v1 compat layer)

**Tests:**
- No changes needed (public API unchanged)

**LOC:** ~3 lines changed

### Step 7: Final verification

**Tests:**
- Run full test suite: `pnpm build && node --test test/unit/*.test.js`
- Run Rust unit tests: `cargo test --package rfdb-server`

**Verification:**
- All tests pass
- No public API changes (only internal storage layer)
- Semantics unchanged — only names and return types explicit

## Total Scope

**Files:** 4 files modified  
**LOC:** ~70 lines changed (mostly test callsite updates)  
**Breaking changes:** None (internal API only)  
**Risk:** Low (mechanical refactoring with strong type safety)

## Critical Files for Implementation

- `packages/rfdb-server/src/storage_v2/write_buffer.rs` — Core upsert logic and new types
- `packages/rfdb-server/src/storage_v2/shard.rs` — First delegation layer
- `packages/rfdb-server/src/storage_v2/multi_shard.rs` — Second delegation layer
- `packages/rfdb-server/src/graph/engine_v2.rs` — Top-level engine integration
