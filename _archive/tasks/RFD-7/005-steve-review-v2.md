# Steve Jobs Review v2: RFD-7 Multi-Shard Implementation

**Date:** 2026-02-13
**Reviewer:** Steve Jobs (High-level Review)
**Task:** RFD-7 (T2.3 Multi-Shard)

---

## Verdict: APPROVE

All three critical issues from my previous REJECT have been resolved correctly. The implementation is clean, well-structured, and properly integrated with the existing storage layer. The code shows clear evidence that someone actually traced through the real APIs this time.

---

## Critical Issue Resolution

### Issue #1: ManifestStore API Misuse -- FIXED

**Previous problem:** Spec called `manifest_store.commit(descs)` -- wrong signature.

**What was implemented** (`multi_shard.rs` lines 279-348):

```rust
// Step 1: Start with current segments
let mut all_node_segs = manifest_store.current().node_segments.clone();
let mut all_edge_segs = manifest_store.current().edge_segments.clone();

// Step 2: Extend with NEW segments
all_node_segs.extend(new_node_descs);
all_edge_segs.extend(new_edge_descs);

// Step 3: Create manifest (full list)
let manifest = manifest_store.create_manifest(
    all_node_segs,
    all_edge_segs,
    None,
)?;

// Step 4: Commit
manifest_store.commit(manifest)?;
```

This is exactly the two-step protocol I showed in my "What Good Looks Like" appendix. Current segments are cloned first, new descriptors are appended, then `create_manifest()` gets the FULL list, then `commit()` gets the manifest object.

Segment IDs are allocated via `manifest_store.next_segment_id()` BEFORE each shard flush (lines 290-298), with conditional allocation only when the write buffer has data. This is correct -- no wasted IDs.

**Verdict: Correctly fixed.**

---

### Issue #2: GraphError::InvalidOperation Doesn't Exist -- FIXED

**Previous problem:** Spec used `GraphError::InvalidOperation` which doesn't exist.

**What was implemented** (`multi_shard.rs` line 255):

```rust
let shard_id = self.node_to_shard.get(&edge.src)
    .copied()
    .ok_or(GraphError::NodeNotFound(edge.src))?;
```

Uses the existing `GraphError::NodeNotFound(u128)` variant (confirmed at `error.rs` line 10). Semantically correct -- the error IS that the node wasn't found, not that the operation is invalid.

Test at line 644-661 (`test_add_edges_src_not_found`) explicitly asserts `GraphError::NodeNotFound(id)` with the correct ID.

**Verdict: Correctly fixed.**

---

### Issue #3: Segment Path Mismatch -- FIXED

**Previous problem:** Shard would write to `<db_path>/shards/NN/`, but `SegmentDescriptor::file_path()` expects `<db_path>/segments/NN/`.

**What was implemented:**

The implementation chose Option B from my review ("pass `<db_path>/segments/<shard_id>/` as shard_path"), which I acknowledged as working.

Path construction in `multi_shard.rs` line 502-504:

```rust
fn shard_dir(db_path: &Path, shard_id: u16) -> PathBuf {
    db_path.join("segments").join(format!("{:02}", shard_id))
}
```

This produces `<db_path>/segments/00/`, `<db_path>/segments/01/`, etc.

`SegmentDescriptor::file_path(db_path)` with `shard_id = Some(0)` produces:
`<db_path>/segments/00/seg_000001_nodes.seg`

`segment_file_path(shard_path, seg_id, "nodes")` with `shard_path = <db_path>/segments/00/` produces:
`<db_path>/segments/00/seg_000001_nodes.seg`

**These paths are identical.** The alignment is verified by the disk integration tests (`test_open_existing_db`, `test_create_disk_db`, `test_node_to_shard_rebuilt_on_open`) which create, flush, reopen, and query successfully.

New methods added to `shard.rs`:
- `create_for_shard(path, shard_id)` (line 154) -- sets `shard_id` so flush produces descriptors with correct shard assignment
- `open_for_shard(path, db_path, shard_id, node_descs, edge_descs)` (line 175) -- uses `desc.file_path(db_path)` for segment resolution

The doc comments in `multi_shard.rs` lines 13-26 explicitly show the storage layout with `segments/00/`, `segments/01/` -- clear and correct.

**Verdict: Correctly fixed.**

---

### Issue #4 (Optimization): node_to_shard Rebuild Efficiency -- FIXED

**Previous problem:** Spec used `find_nodes(None, None)` which allocates full `NodeRecordV2` records (~200 bytes each) just to extract IDs.

**What was implemented:**

New method in `shard.rs` lines 620-631:

```rust
/// Return all node IDs (write buffer + segments).
///
/// Used for rebuilding `node_to_shard` map on MultiShardStore::open().
/// Returns only IDs (16 bytes each), NOT full NodeRecordV2 records
/// (~200 bytes each).
pub fn all_node_ids(&self) -> Vec<u128> {
    let mut ids = Vec::new();
    for node in self.write_buffer.iter_nodes() {
        ids.push(node.id);
    }
    for seg in &self.node_segments {
        for j in 0..seg.record_count() {
            ids.push(seg.get_id(j));
        }
    }
    ids
}
```

Used in `MultiShardStore::open()` at lines 193-198:

```rust
for (shard_id, shard) in shards.iter().enumerate() {
    for node_id in shard.all_node_ids() {
        node_to_shard.insert(node_id, shard_id as u16);
    }
}
```

This returns `Vec<u128>` (16 bytes per entry) instead of `Vec<NodeRecordV2>` (~200 bytes per entry). ~12x memory reduction for the rebuild operation. The doc comment even explains the rationale. Good.

Could further optimize with `for_each_node_id` callback pattern (zero intermediate Vec), but for L0 this is fine. The allocation is proportional to node count, not record size.

**Verdict: Correctly fixed.**

---

## Code Quality

### multi_shard.rs (~1100 LOC)

**Structure:** Clean separation into logical sections with `impl` blocks: Constructors, Write Operations, Flush, Point Lookup, Attribute Search, Neighbor Queries, Stats. Easy to navigate.

**Documentation:** Module-level doc comment clearly explains routing strategy (nodes by directory hash, edges by source node, queries fan-out). Storage layout diagram is correct.

**Edge routing in `add_edges()`:** Returns `Result<()>` because source node must exist in `node_to_shard`. This is the correct semantic -- nodes before edges is a required invariant.

**Fan-out queries:** `get_node()` has fast path via `node_to_shard` with defensive fallback. `get_incoming_edges()` correctly always fans out (incoming edges can be in any shard). `get_outgoing_edges()` uses fast path (edges are in source node's shard). These are all correct.

**Defensive dedup in `find_nodes()`:** Uses `HashSet<u128>` to deduplicate. Comment notes this "shouldn't happen in normal operation" but is cheap insurance. Good engineering.

### shard_planner.rs (~200 LOC)

**Simple and correct.** Blake3 hash of parent directory mod shard_count. Deterministic across platforms and Rust versions (important for database consistency after reopening).

`plan()` method for batch assignment is clean and useful for testing.

### shard.rs additions (~50 LOC of new code)

Three new methods: `create_for_shard`, `open_for_shard`, `all_node_ids`. All are minimal, focused, and follow the existing patterns in the file.

`open_for_shard` correctly takes both `path` (shard directory) and `db_path` (database root), uses `desc.file_path(db_path)` for segment resolution. This matches the existing `open()` method's pattern.

### mod.rs

Exports are clean: `DatabaseConfig`, `MultiShardStore`, `ShardStats`, `ShardPlanner`.

---

## Test Coverage

### shard_planner.rs tests (7 tests)

- Determinism (`test_compute_shard_id_deterministic`)
- Same directory locality (`test_same_directory_same_shard`)
- Distribution across shards (`test_different_directories_likely_different_shards`)
- Batch planning (`test_plan_groups_files_correctly`, `test_plan_all_files_assigned`)
- Edge cases (`test_single_shard_all_same`, `test_root_files_same_shard`)
- Panic on zero (`test_zero_shards_panics`)

Good coverage. Tests verify the core invariant (same directory = same shard) and boundary conditions.

### multi_shard.rs tests (16 tests)

**Config tests:** `test_config_roundtrip`, `test_config_read_nonexistent` -- basic persistence.

**Core operations:**
- `test_ephemeral_multi_shard_add_query` -- add + query roundtrip
- `test_add_nodes_distributes_by_directory` -- verifies actual distribution (at least 2 shards non-empty)
- `test_add_edges_routes_to_source_shard` -- edge routing
- `test_add_edges_src_not_found` -- **Critical:** verifies `GraphError::NodeNotFound` with correct ID

**Flush tests:**
- `test_flush_all_commits_manifest` -- verifies manifest version bump and segment count
- `test_flush_empty_shards_skipped` -- no-op flush returns 0
- `test_multiple_flush_cycles` -- accumulating segments across flushes

**Cross-shard tests:**
- `test_cross_shard_edges` -- outgoing AND incoming edges across shards
- `test_incoming_edges_fan_out` -- 4 callers from (likely) different shards to 1 target
- `test_outgoing_edges_type_filter` -- edge type filtering works through multi-shard layer

**Integration tests:**
- `test_create_disk_db` -- disk layout verification (shard dirs exist)
- `test_open_existing_db` -- **Critical:** create -> flush -> reopen -> query cycle
- `test_node_to_shard_rebuilt_on_open` -- verifies rebuild works after reopen
- `test_equivalence_single_vs_multi` -- **Excellent:** same data in single Shard vs MultiShardStore produces identical query results

**Edge cases:**
- `test_empty_shards_ok` -- 8 shards, 1 node
- `test_node_count_edge_count` -- aggregation across shards

**Assessment:** The test suite is thorough. It covers the critical paths (flush protocol, edge routing, cross-shard queries, disk persistence, reopen) and includes the equivalence test which is the strongest possible correctness guarantee.

One minor gap: no test for `find_nodes` with file filter across multiple shards. But `test_find_nodes_fan_out` covers type filter, and the single-shard find_nodes tests cover file filtering. The multi-shard layer just delegates, so this is acceptable.

---

## Architectural Concerns

### None blocking.

**Directory partitioning limitations** (hot shard for flat directory structures) -- acknowledged in the previous review. This is a known limitation for L0 that doesn't defeat the feature's purpose. Multi-shard works correctly; some configurations will be more balanced than others. Monitoring and rebalancing are future work.

**Shard count selection** -- hardcoded to caller's choice. No auto-tuning. Acceptable for L0 infrastructure layer.

**Sequential flush** -- flushes shards one at a time in `flush_all`. Could be parallel but sequential is correct and simpler. Good for L0.

---

## Did We Do The Right Thing?

**Yes.** This is infrastructure code for the storage layer. It:

1. Correctly integrates with the existing ManifestStore protocol
2. Uses the correct error types
3. Aligns segment paths between write and read paths
4. Optimizes the rebuild path as recommended
5. Has comprehensive tests including an equivalence test
6. Is cleanly structured and well-documented
7. Doesn't hack around the existing API -- it extends it properly

The three new `Shard` methods (`create_for_shard`, `open_for_shard`, `all_node_ids`) are minimal additions that don't change the existing single-shard behavior.

---

## Would This Embarrass Us?

No. This is clean infrastructure code. The API is clear, the tests are thorough, and the integration with the existing storage layer is correct. Someone reading this code six months from now would understand exactly what it does and why.

---

## Decision

**APPROVE** -- All three critical issues from the previous review have been correctly resolved. The optimization recommendation was also addressed. The code is clean, well-tested, and properly integrated with the existing storage layer.

Escalating to Vadim for final confirmation.

---

**End of review.**
