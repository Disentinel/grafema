# Rob Pike Implementation Report: REG-409 Edge Deduplication

## Summary

Implemented edge deduplication in RFDB's `GraphEngine` by adding an `edge_keys: HashSet<(u128, u128, String)>` field that enforces the uniqueness invariant: at most one edge per `(src, dst, edge_type)` triple. All changes are confined to a single file: `packages/rfdb-server/src/graph/engine.rs`.

## Changes Made

All 10 changes from Joel's tech plan were implemented exactly as specified.

### Production Code Changes

**Change 1: Added `edge_keys` field to `GraphEngine` struct (line ~127)**
- New field: `edge_keys: HashSet<(u128, u128, String)>`
- Placed after `deleted_segment_ids` with doc comment explaining its purpose

**Change 2: Initialize in `create()` (line ~158)**
- Added `edge_keys: HashSet::new()` to the `Self { ... }` initializer

**Change 3: Initialize in `create_ephemeral()` (line ~201)**
- Added `edge_keys: HashSet::new()` to the `Self { ... }` initializer

**Change 4: Populate in `open()` (lines ~246-264)**
- Replaced the separate `get_src`/`get_dst` checks with a combined `if let (Some(src), Some(dst))` pattern
- Added `edge_keys` HashSet population in the same loop as adjacency building
- Added `edge_keys` to the returned `Self { ... }` block

**Change 5: Dedup in `add_edges()` (lines ~987-992)**
- Added edge key construction: `(edge.src, edge.dst, edge.edge_type.clone().unwrap_or_default())`
- Uses `self.edge_keys.insert(edge_key)` which returns `false` if already present -> `continue`
- Check placed after validation, before delta_log write

**Change 6: Remove from `edge_keys` in `delete_edge()` (line ~1010)**
- Added `self.edge_keys.remove(&(src, dst, edge_type.to_string()))` after `apply_delta`
- Enables re-adding a previously deleted edge in the same session

**Change 7: Dedup in `flush()` (lines ~1133-1170)**
- Replaced naive `Vec` collection with `HashMap<(u128, u128, String), EdgeRecord>` dedup
- Delta edges inserted first (more recent, take priority)
- Segment edges only fill gaps (skip if key already in map)
- Final `all_edges` collected from `edges_map.into_values()`

**Change 8: Rebuild `edge_keys` after flush (lines ~1198, 1216-1228)**
- Added `self.edge_keys.clear()` alongside other delta cleanup
- Extended post-flush adjacency rebuild loop to also populate `edge_keys`
- Uses combined `if let (Some(src), Some(dst))` pattern matching open() style

**Change 9: Clear in `clear()` (line ~398)**
- Added `self.edge_keys.clear()` after `self.reverse_adjacency.clear()`

**Change 10: Clear deleted entries in `delete_version()` (lines ~460-465)**
- After marking edges as deleted, iterates again to remove matching keys from `edge_keys`
- Only removes edges that match both `edge.deleted` and `edge.version == version`

### Tests Added (7 tests)

All tests placed in the existing `#[cfg(test)] mod tests` block under the `REG-409: Edge Deduplication Tests` section header.

| Test | What it verifies |
|------|------------------|
| `test_add_edges_dedup_same_session` | Same edge added twice in-memory yields count of 1 |
| `test_flush_dedup_segment_plus_delta` | Edge in segment cannot be re-added in delta; flush preserves count of 1 |
| `test_dedup_survives_reopen` | After flush+reopen, `edge_keys` is populated from segment, blocking duplicates |
| `test_different_edge_types_not_deduped` | Same src/dst with different edge types are all kept (3 edges) |
| `test_delete_then_readd_edge` | Delete removes from `edge_keys`, allowing re-add |
| `test_clear_resets_edge_keys` | `clear()` resets `edge_keys`, allowing re-add |
| `test_get_outgoing_edges_no_duplicates_after_flush` | Regression test: `get_outgoing_edges` and `get_incoming_edges` return exactly 1 after flush+attempted re-add |

## Test Results

```
running 213 tests
...
test graph::engine::tests::test_add_edges_dedup_same_session ... ok
test graph::engine::tests::test_clear_resets_edge_keys ... ok
test graph::engine::tests::test_delete_then_readd_edge ... ok
test graph::engine::tests::test_different_edge_types_not_deduped ... ok
test graph::engine::tests::test_dedup_survives_reopen ... ok
test graph::engine::tests::test_flush_dedup_segment_plus_delta ... ok
test graph::engine::tests::test_get_outgoing_edges_no_duplicates_after_flush ... ok
...
test result: ok. 213 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

All 213 tests pass (206 pre-existing + 7 new).

## Clippy Status

Clippy reports 1 error that is **pre-existing** (unrelated to this change):
- `absurd_extreme_comparisons` on `AUTO_FLUSH_THRESHOLD` (line 479) -- comparing against `usize::MAX`

Verified by running clippy on the baseline (before changes) -- same error exists. No new warnings introduced by this change.

## Scope

- **Lines of production code changed:** ~65
- **Lines of test code added:** ~130
- **Files modified:** 1 (`packages/rfdb-server/src/graph/engine.rs`)
- **No dependencies added**
