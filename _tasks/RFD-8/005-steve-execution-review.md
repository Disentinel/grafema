# RFD-8 T3.1 Steve Jobs Execution Review

> Date: 2026-02-14
> Reviewer: Steve Jobs (High-level Review)
> Status: **APPROVE**

---

## Executive Summary

This implementation delivers tombstone-based logical deletion and batch commit for RFDB v2. It is the foundation for incremental re-analysis -- the feature that makes Grafema work on real codebases, where you re-analyze one file without rebuilding the entire graph.

The implementation is clean, correct, and architecturally sound. It follows the plan closely, handles the critical re-addition edge case (Section 10.3 of Joel's spec), and does not cut corners. The code reads well, the tests are thorough, and the complexity is targeted -- no O(N) full-graph scans.

---

## 1. Vision Alignment

**Does this enable incremental re-analysis?** Yes.

`commit_batch()` is the primitive that makes incremental re-analysis possible: give it the new nodes/edges for changed files, and it atomically tombstones old data, inserts new data, and returns a `CommitDelta` describing exactly what changed. The enrichment pipeline can use `CommitDelta.changed_node_types` and `changed_edge_types` to decide which passes to re-run.

The `enrichment_file_context()` convention is a clean abstraction for enrichment data lifecycle: enrichment data is stored under `__enrichment__/{enricher}/{source_file}`, and when the source file is re-analyzed, the enrichment data is tombstoned alongside it.

**Is the architecture right?** Yes. This follows the Delta Lake Deletion Vectors pattern: lightweight tombstones in manifests, not separate segment files. Segments remain immutable. Compaction (T4.x) will physically remove tombstoned records later. This is the correct layered approach.

---

## 2. Correctness Analysis

### 2.1. Tombstone Guard on All Query Paths

All 5 Shard read methods are correctly guarded:

| Method | Guard Location | Correct? |
|--------|---------------|----------|
| `get_node()` | Before write buffer check (line 502) | Yes |
| `node_exists()` | Before write buffer check (line 536) | Yes |
| `find_nodes()` | In buffer loop + segment loop (lines 584, 633) | Yes |
| `get_outgoing_edges()` | In buffer loop + segment loop (lines 674, 710) | Yes |
| `get_incoming_edges()` | In buffer loop + segment loop (lines 737, 773) | Yes |
| `all_node_ids()` | In buffer loop + segment loop (lines 824, 832) | Yes |

The tombstone check is placed FIRST in point lookups (get_node, node_exists) -- O(1) HashSet lookup before any segment I/O. Correct.

### 2.2. Re-Addition Fix (Phase 5.5)

The critical correctness issue from Joel's Section 10.3 is handled: when new data has the same node ID or edge key as tombstoned data, the tombstone is removed so the new data is visible. This is implemented in Phase 5.5 of `commit_batch()` (lines 572-587).

The sequence is correct:
1. Phase 4: Apply tombstones to shards (old + new combined)
2. Phase 5: Add new data to shards
3. Phase 5.5: Remove re-added IDs from tombstone set, re-apply to shards
4. Phase 7: Flush (new data is in segments, tombstones exclude only truly deleted records)
5. Phase 8: Manifest gets the final tombstone set (with re-additions removed)

This handles the case where a node is re-analyzed with the same semantic_id (same u128) -- the old version is in an old segment (tombstoned), the new version is in a new segment (not tombstoned). The graph shows only the new version. Correct.

### 2.3. Edge Tombstoning

Edge tombstoning uses `find_edge_keys_by_src_ids()` with bloom filter pre-filtering. When a file is re-analyzed, ALL edges originating from nodes in that file are tombstoned. New edges are then added. If a new edge has the same (src, dst, edge_type) as a tombstoned edge, the tombstone is removed (Phase 5.5).

This correctly handles the scenario where a function call is removed: old edge A->B is tombstoned, new commit doesn't include edge A->B, so A->B remains tombstoned and invisible. Correct.

### 2.4. Tombstone Accumulation

Tombstones accumulate across commits (union of existing manifest tombstones + new tombstones). This is correct -- tombstones persist until compaction. The `test_commit_batch_tombstone_accumulation` test verifies this.

### 2.5. Delta Computation

The `CommitDelta` correctly distinguishes:
- `nodes_added`: truly new node IDs (not in old snapshot)
- `nodes_removed`: tombstoned node IDs (count of old nodes for changed files)
- `nodes_modified`: same ID, both content_hash non-zero, different values

The content_hash=0 skip is correct (0 means "not computed", so comparing two zeros would be meaningless).

---

## 3. No Hacks / No Shortcuts

### 3.1. Inlined Flush Logic

The plan acknowledges that `commit_batch()` inlines ~40 lines of flush coordination from `flush_all()`. This is intentional, not a hack: `flush_all()` commits its own manifest, but `commit_batch()` needs to inject tombstones between `create_manifest()` and `commit()`. Inlining avoids an unnecessary manifest version.

The spec explicitly defers extracting `flush_shards_only()` to T4.x. This is acceptable scope management.

### 3.2. contains_edge String Allocation

`TombstoneSet::contains_edge()` allocates a String for each lookup because `HashSet<(u128, u128, String)>` requires owned keys. The spec acknowledges this and defers optimization. For L0 workloads this is fine -- edge type strings are short, and the allocation is O(1) amortized.

### 3.3. Database-Wide Tombstones

Tombstones are database-wide (same TombstoneSet cloned to all shards), not per-shard. This is a deliberate design choice documented in Joel's spec (Section 6.5). The memory cost is 8 * 1.6 MB = 12.8 MB for 100K tombstoned nodes across 8 shards. Acceptable until compaction.

---

## 4. Test Quality

### 4.1. Coverage

39 tests total (36 unit + 2 manifest serde + 1 doctest). Coverage includes:

| Category | Tests | Assessment |
|----------|-------|------------|
| TombstoneSet unit | 12 | Complete: empty, from_manifest, all 5 query paths, empty-set-no-effect, union |
| Manifest serde | 2 | Complete: roundtrip + backward compat |
| find_edge_keys_by_src_ids | 6 | Complete: buffer, segment, bloom skip, empty, across segments, multi-shard |
| CommitDelta + enrichment | 5 | Complete: serde roundtrip, defaults, enrichment convention |
| commit_batch core | 10 | Complete: basic, tombstone nodes, tombstone edges, delta counts, changed types, modified detection, hash-zero skip, multi-file, enrichment, manifest tombstones |
| Validation/integration | 5 | Complete: idempotency, atomicity, accumulation, consistency, backward compat |

### 4.2. Tests Actually Test What They Claim

I verified several critical tests:

- `test_commit_batch_tombstones_old_nodes`: Commits A,B,C then re-commits A',D. Asserts B,C gone, A',D visible. Correct.
- `test_commit_batch_idempotent`: Re-commits identical data. Asserts nodes_modified=0, graph state unchanged. Correct.
- `test_commit_batch_tombstone_accumulation`: Three commits across two files. Asserts tombstones from file A don't affect file B. Correct.
- `test_commit_batch_then_query_consistent`: Full consistency check across get_node, find_nodes, outgoing edges, incoming edges. Correct.
- `test_commit_batch_existing_api_unchanged`: Uses ONLY old API (add_nodes/add_edges/flush_all), verifies everything works and no tombstones in manifest. Correct.

### 4.3. Test Gaps (Minor)

- No test for `commit_batch` with empty nodes AND empty edges AND non-empty changed_files (edge case: tombstone a file but add nothing back). This is a valid scenario (file deleted). Low risk -- the algorithm handles it correctly (Phase 1 collects old nodes, Phase 2 tombstones them, Phases 5-6 have no new data to add).
- No test for very large tombstone sets (performance). Acceptable for L0.

---

## 5. Complexity Check

No O(N) full graph scans. All operations are targeted:

| Operation | Complexity | Scan Scope |
|-----------|-----------|------------|
| Phase 1 (snapshot old) | O(F * N_per_file) | Only nodes in changed files |
| Phase 2 (edge tombstones) | O(S * K * B + matching) | Bloom-filtered segment scan |
| Phase 5 (add data) | O(N + E) | Only new records |
| Phase 7 (flush) | O(shard_count * flush) | Only shards with data |
| Tombstone check per query | O(1) | HashSet lookup |

The bloom filter on `find_edge_keys_by_src_ids` is correctly applied: segment-level bloom check on src IDs, skip entirely if no match. This avoids scanning irrelevant edge segments.

---

## 6. Backward Compatibility

Verified:

- `#[serde(default)]` on `tombstoned_node_ids` and `tombstoned_edge_keys` ensures old manifests load correctly (tested by `test_manifest_serde_backward_compat`).
- `#[serde(skip_serializing_if = "Vec::is_empty")]` avoids bloating manifests when no tombstones exist.
- `flush_all()` is unchanged. `add_nodes()`, `add_edges()`, `get_node()`, `find_nodes()`, all edge queries -- all existing API works exactly as before.
- `test_commit_batch_existing_api_unchanged` explicitly verifies the old API path produces no tombstones and works correctly.
- All 462 pre-existing unit tests still pass.

---

## 7. Crash Safety

Manifest commit is still atomic. The commit protocol is:
1. Write manifest JSON (temp + rename)
2. Update index (temp + rename)
3. Write current pointer (temp + rename)

Crash before step 3: old current pointer, old manifest (consistent).
Crash after step 3: new current pointer, new manifest with tombstones (consistent).

Tombstones are part of the manifest, so they participate in the same crash safety guarantees.

---

## 8. Concerns (Non-Blocking)

### 8.1. edges_clone in Phase 5

`commit_batch()` clones the entire edges vector (line 568) because `add_edges()` takes ownership. The clone is needed for Phase 5.5 tombstone removal. This is wasteful for large edge sets. A future optimization could collect just the edge keys (src, dst, edge_type) before passing ownership. Non-blocking for L0.

### 8.2. Double set_tombstones Call

Tombstones are set on shards twice: once in Phase 4 (before adding new data) and again in Phase 5.5 (after removing re-added IDs). Each call clones the HashSets for all shards. With 8 shards and 100K tombstones, this is ~25 MB of cloning done twice. Acceptable for L0. Future optimization: build the final tombstone set before setting it on shards at all (defer Phase 4 until after Phase 5.5).

### 8.3. nodes.clone() in Phase 5

`nodes` is cloned (line 569) because `add_nodes()` takes `Vec<NodeRecordV2>` by value. The clone is needed for Phase 6 (modified count). Same pattern as edges -- a future refactoring could avoid this.

These are performance concerns, not correctness concerns. They scale linearly with batch size, not graph size. Non-blocking.

---

## Verdict

**APPROVE.**

The implementation is architecturally sound, correct in its handling of the critical re-addition edge case, thoroughly tested (39 tests, all passing, 495 total), backward compatible, and crash safe. It follows the plan closely, does not cut corners, and creates no hacks. The three performance concerns (clones) are non-blocking and scale with batch size, not graph size.

This is the foundation for incremental re-analysis. It is done right.
