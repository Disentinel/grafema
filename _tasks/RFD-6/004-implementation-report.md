# RFD-6: T2.2 Implementation Report (Rob Pike)

> Date: 2026-02-13
> Author: Rob Pike (Implementation Engineer)
> Status: Implementation complete, all tests passing

---

## Summary

Implemented the single-shard read/write unit for RFDB v2 per Joel's tech spec (003-joel-tech-plan.md). Created two new files and updated one existing file. All 34 tests pass. No changes to any existing code beyond 4 lines added to `mod.rs`.

---

## Files Changed

| File | Action | LOC |
|---|---|---|
| `packages/rfdb-server/src/storage_v2/write_buffer.rs` | **NEW** | 360 |
| `packages/rfdb-server/src/storage_v2/shard.rs` | **NEW** | 1274 |
| `packages/rfdb-server/src/storage_v2/mod.rs` | **UPDATED** | +4 lines |
| **Total** | | **~1638 LOC** |

---

## What Was Built

### 1. WriteBuffer (`write_buffer.rs`, 360 LOC)

In-memory accumulation buffer analogous to an LSM-tree memtable. Stores nodes in `HashMap<u128, NodeRecordV2>` for O(1) point lookup and upsert, and edges in `Vec<EdgeRecordV2>` with `HashSet<(u128, u128, String)>` for deduplication. Matches the v1 `delta_nodes` / `edge_keys` patterns.

**Public API (19 methods + Default impl):**
- Constructors: `new()`
- Write: `add_node()`, `add_nodes()`, `add_edge() -> bool`, `add_edges() -> usize`
- Read: `get_node()`, `iter_nodes()`, `iter_edges()`
- Query: `find_nodes_by_type()`, `find_nodes_by_file()`, `find_edges_by_src()`, `find_edges_by_dst()`, `find_edges_by_type()`
- Management: `node_count()`, `edge_count()`, `is_empty()`, `drain_nodes()`, `drain_edges()`

**Tests: 8** -- all passing.

### 2. Shard (`shard.rs`, 1274 LOC)

Primary read/write unit. Directory of immutable columnar segments + write buffer. Supports three query patterns and a flush-to-disk write path.

**Data structures:**
- `FlushResult` -- returned by flush, contains `SegmentMeta` for manifest update
- `Shard` -- the main struct with path, shard_id, write_buffer, segments, and descriptors

**Public API (15 methods):**
- Constructors: `create(path)`, `open(path, db_path, node_descs, edge_descs)`, `ephemeral()`
- Write: `add_nodes()`, `add_edges()`
- Flush: `flush_with_ids(node_seg_id, edge_seg_id) -> Result<Option<FlushResult>>`
- Point lookup: `get_node()`, `node_exists()`
- Attribute search: `find_nodes(node_type, file)`
- Neighbor queries: `get_outgoing_edges(node_id, edge_types)`, `get_incoming_edges(node_id, edge_types)`
- Stats: `node_count()`, `edge_count()`, `segment_count()`, `write_buffer_size()`

**Private helpers:**
- `segment_file_path()` -- derives file path within shard directory
- `build_descriptor()` -- constructs SegmentDescriptor from flush metadata

**Tests: 26** -- all passing across 6 phases:
- Phase 2: 8 tests (shard core + flush)
- Phase 3: 4 tests (point lookup)
- Phase 4: 4 tests (attribute search)
- Phase 5: 4 tests (neighbor queries)
- Phase 6: 6 tests (integration + equivalence)

### 3. mod.rs Update (+4 lines)

Added module declarations and re-exports:
```rust
pub mod write_buffer;
pub mod shard;
pub use write_buffer::WriteBuffer;
pub use shard::{Shard, FlushResult};
```

---

## Key Algorithms Implemented

### Point Lookup (`get_node`)
1. Check write buffer O(1) HashMap lookup
2. Scan segments newest-to-oldest, bloom filter short-circuits ~99.2% of segments
3. Linear scan of ID column within bloom-positive segments

### Attribute Search (`find_nodes`)
1. Scan ALL buffer nodes to build `seen_ids` set (authoritative dedup)
2. Collect buffer nodes matching filter into results
3. Scan segments newest-to-oldest with 3-layer pruning:
   - Descriptor-level zone map (O(1))
   - Segment-level zone map (O(1))
   - Columnar scan with dedup via `seen_ids`

### Neighbor Queries (`get_outgoing_edges` / `get_incoming_edges`)
1. Scan buffer edges by src/dst
2. Scan edge segments with bloom filter on src/dst
3. Optional edge type zone map pruning
4. Linear scan of matching segments
5. No dedup needed (edges don't have unique IDs)

### Flush (`flush_with_ids`)
1. Check buffer empty -> Ok(None)
2. Drain nodes from buffer -> NodeSegmentWriter -> disk file or Cursor<Vec<u8>>
3. Drain edges from buffer -> EdgeSegmentWriter -> disk file or Cursor<Vec<u8>>
4. Load new segments immediately (mmap or from_bytes)
5. Build local descriptors for zone map pruning
6. Return FlushResult with SegmentMeta

---

## Bug Found and Fixed During Implementation

**Bug in spec pseudocode:** The `find_nodes` algorithm in Section 3.3 of the tech spec adds buffer node IDs to `seen_ids` only when the node matches the filter. This is incorrect -- if a buffer node doesn't match the filter (e.g., node type was updated from "FUNCTION" to "METHOD"), its ID is NOT added to `seen_ids`, which allows the old segment version (with type "FUNCTION") to leak through into results.

**Fix:** In Step 1 of `find_nodes`, ALL buffer node IDs are added to `seen_ids` BEFORE the filter check. This ensures the buffer is fully authoritative -- segment versions are always shadowed by buffer presence, regardless of filter match. The test `test_find_nodes_dedup_buffer_wins` specifically verifies this behavior.

This is the correct semantics because:
- If a node exists in the write buffer, that IS the current version
- Old segment versions should never be visible, even for different query filters
- Same principle as `get_node()`: buffer wins unconditionally

---

## Build Status

- `cargo build`: clean (0 new warnings, 4 pre-existing warnings from v1 storage code)
- `cargo test --lib storage_v2::write_buffer`: 8/8 pass
- `cargo test --lib storage_v2::shard`: 26/26 pass
- Total: **34/34 tests passing**

---

## What Was NOT Built (per spec)

- No compaction, tombstones, multi-shard, WAL, concurrent access
- No adjacency index, inverted index
- No sorted segments, range queries, shard routing
- No segment eviction / cache
- No changes to existing files beyond mod.rs
