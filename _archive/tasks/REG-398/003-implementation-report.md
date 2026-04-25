# REG-398 Phase 1: Implementation Report

## Summary

Added ID hash index to RFDB GraphEngine, replacing O(n) linear scan with O(1) HashMap lookup for node-by-ID queries.

## Changes

### New file: `packages/rfdb-server/src/graph/index_set.rs`
- `IndexSet` struct with `id_index: HashMap<u128, usize>`
- `new()`, `rebuild_from_segment()`, `clear()`, `find_node_index()` methods
- 4 unit tests covering: empty index, clear, rebuild, rebuild replaces previous

### Modified: `packages/rfdb-server/src/graph/mod.rs`
- Added `pub mod index_set;`

### Modified: `packages/rfdb-server/src/graph/engine.rs`
- Added `index_set: IndexSet` field to `GraphEngine`
- Initialized in `create()`, `create_ephemeral()`
- Built from segment in `open()`
- Rebuilt in `flush()` (after segment reopen, before adjacency rebuild)
- Cleared in `clear()`
- Replaced 4 `segment.find_index(id)` call sites:
  - `get_node_internal()` line 342
  - `get_node_strings()` line 505
  - `get_node_strings_with_metadata()` line 531
  - `get_node_identifier()` line 663
- Added 6 integration tests:
  - `test_index_get_node_after_flush`
  - `test_index_survives_reopen`
  - `test_index_delta_takes_priority_over_segment`
  - `test_index_deleted_segment_node_not_returned`
  - `test_index_get_node_strings_after_flush`
  - `test_index_rebuilt_after_flush_with_new_nodes`

### Modified: `packages/rfdb-server/src/storage/segment.rs`
- Removed `NodesSegment::find_index()` method (O(n) linear scan)

## Test Results

214 tests pass:
- 194 unit tests (including 10 new index tests)
- 20 integration/protocol tests
- 10 doc tests (2 ignored)

## Steve Jobs Review Note

Steve initially rejected citing "no index invalidation on node deletion." This was incorrect — the existing deletion pipeline already prevents stale reads:
1. Delta deletions: `delta_nodes` checked FIRST (before index)
2. Segment deletions: `deleted_segment_ids` checked BEFORE index lookup

Added `test_index_deleted_segment_node_not_returned` to prove correctness.

## Complexity Analysis

- **Before:** `get_node(id)` → O(n) linear scan over all u128 IDs in mmap segment
- **After:** `get_node(id)` → O(1) HashMap lookup
- **Rebuild cost:** O(n) single pass, same as adjacency lists (~5-10ms for 1M nodes)
- **Memory:** ~48 bytes/entry → ~48MB for 1M nodes (comparable to adjacency lists)
