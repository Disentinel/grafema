# RFD-39: Implementation Report

## Root Cause Analysis

**Two bugs found, not one:**

### Bug 1: `node_count()`/`edge_count()` double-counting (reported)
`node_count()` used naive `segment + delta` sum. After flush, when the same node
gets re-added to delta (shared modules), it exists in both → counted twice.

### Bug 2: `flush()` writes duplicate nodes to segment (discovered during testing)
The flush code collected ALL segment nodes, then appended ALL delta nodes — even
overlapping ones. It logged "delta overwrites segment" but never actually removed the
segment version. Result: segment file accumulates duplicate records across flushes,
making `segment.node_count()` unreliable.

This is why the inflation was 29x (not 2x): each flush added more duplicates to the
segment file, compounding across multiple flush cycles.

## Fix

### 1. `flush()` — Prevent duplicate writes
When collecting segment nodes, skip those that have delta overrides. Delta nodes are
then added without possibility of overlap. This ensures the segment file never contains
duplicate IDs.

### 2. `node_count()` — Deduplicate segment/delta overlap
Uses `index_set` (O(1) HashMap lookup) to detect delta nodes that also exist in segment.
Accounts for:
- New live nodes in delta only → add
- Deleted nodes (segment deleted directly via `deleted_segment_ids`) → subtract
- Deleted nodes (segment overridden via delta with `deleted=true`) → subtract
- Live overrides (delta node with same ID as segment) → already counted in segment

Complexity: O(delta_nodes) with O(1) index lookups.

### 3. `edge_count()` — Account for deleted edges
Edges are deduplicated at insertion time via `edge_keys` HashSet, so delta/segment
overlap doesn't occur. Fixed to properly subtract deleted segment edges and only count
live delta edges.

### 4. Trait comment update
Changed from "Количество нод (включая deleted)" to "Количество живых нод (без deleted,
с дедупликацией segment/delta)". All callers (stats display, CLI, heartbeat) expect live
counts.

## Tests Added (6)

1. `test_node_count_no_double_count_after_flush` — Core bug: flush → re-add → verify no inflation
2. `test_edge_count_no_double_count_after_flush` — Same for edges
3. `test_node_count_after_delete` — Deletion from segment and delta
4. `test_node_count_delete_re_added_node` — Delete node in both segment and delta
5. `test_node_count_across_multiple_flushes` — 3 flush cycles with overlaps and deletes
6. `test_edge_count_after_delete` — Edge deletion from segment

## Test Results

All 582 tests pass (576 existing + 6 new).

## Files Changed

- `packages/rfdb-server/src/graph/engine.rs` — flush dedup, node_count, edge_count, 6 tests
- `packages/rfdb-server/src/graph/mod.rs` — trait comment update
