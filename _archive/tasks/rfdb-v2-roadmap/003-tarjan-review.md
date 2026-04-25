# RFDB v2 Roadmap: Graph Theory Review

> Author: Robert Tarjan (consulting)
> Date: 2026-02-11
> Scope: Graph-theoretic correctness analysis of RFDB v2 architecture
> Input: rfdb-v2-architecture-final.md, 002-roadmap.md

---

## Executive Summary

The RFDB v2 design is architecturally sound from a graph theory perspective. The choice of immutable segments with atomic manifest swaps gives you something most graph databases struggle to achieve: point-in-time snapshot consistency for free. However, I identify **six specific risks** that must be addressed, three of which are serious enough to affect correctness if ignored. The most critical is the **dangling edge problem** during incremental re-analysis, which the current design acknowledges but does not fully specify how to resolve.

I ground this analysis in recent prior art from three LSM-based graph database systems: **LSMGraph** (SIGMOD 2024), **BACH** (VLDB 2025), and **Aster/Poly-LSM** (SIGMOD 2025), all of which face similar challenges and have published solutions.

---

## 1. Graph Query Correctness Under Sharding

### 1.1. The Fundamental Question

When the graph G = (V, E) is partitioned into shards S_1, S_2, ..., S_k based on directory structure, we have:

- V = V_1 union V_2 union ... union V_k (disjoint: each node in exactly one shard)
- E is NOT partitioned cleanly: an edge (u, v) where u in S_i, v in S_j is a **cross-shard edge**

The design assigns edge ownership to the **source node's shard** (or `__enrichment__` virtual shards for enrichment edges). This means:

- **Forward neighbors** (outgoing edges from node u): all edges with src=u are in u's shard. Single shard read. **Correct and efficient.**
- **Reverse neighbors** (incoming edges to node v): edges with dst=v are scattered across all shards that contain nodes calling v. **Requires fan-out across all shards.**

### 1.2. Correctness Analysis

**Point lookups** (`getNode`): Correct. Bloom filter fan-out across shards, exactly one shard will contain the node. The bloom filter's zero false-negative guarantee means we never miss.

**Forward neighbor queries**: Correct. All outgoing edges co-located with source node's shard.

**Reverse neighbor queries**: **Correct but expensive.** Must scan edge segments in ALL shards for `dst=nodeId`. With 100-300 shards, this is O(shards) bloom filter checks + scan of matching segments. This is the known cost of edge-cut partitioning.

**BFS/DFS traversal** (as in `traversal.rs`): The current traversal code uses a closure `get_neighbors(u128) -> Vec<u128>`. Under sharding, each call to `get_neighbors` may touch multiple shards. For forward-only traversal (following CALLS edges forward), this is efficient -- each hop hits one shard. For **reverse traversal** (blast radius: "who calls this function?"), each hop requires fan-out. With BFS depth d and average out-degree k, reverse BFS visits O(k^d) nodes, each requiring O(shards) bloom checks.

**Datalog queries**: The Datalog engine stays as-is per the roadmap. It operates on the logical graph, not physical shards. As long as `queryNodes` and `neighbors` return correct results (which they do under the snapshot model), Datalog correctness is preserved.

### 1.3. Specific Risk: SCC Computation

Strongly connected component algorithms (Tarjan's algorithm, Kosaraju's, etc.) require both forward AND reverse edge traversal. With edge ownership on source node's shard:

- Forward pass: efficient (one shard per node)
- Reverse pass: expensive (fan-out per node)

This is not a correctness issue, but a **performance cliff** if SCC queries are ever needed (e.g., for cycle detection in dependency graphs). Note that the current v1 engine stores all edges in a single HashMap, so SCC is O(V+E) today. Under v2, SCC becomes O(V * shards) for the reverse pass.

### 1.4. Recommendation

**Verdict: CORRECT, with performance caveat.**

The design is correct for all graph operations under sharding. No graph algorithm becomes incorrect -- they may become slower for reverse traversal. Two mitigations to consider:

1. **Reverse edge index** (deferred, Phase 7+): During compaction, build a reverse adjacency index (dst -> list of src) per shard. This converts reverse neighbor lookups from O(all_shards) scan to O(1) per shard that actually has relevant edges. LSMGraph and BACH both build similar indexes.

2. **Manifest stats for pruning** (already in design): The manifest records `edge_types` per segment. For reverse queries, skip shards whose segments don't contain the relevant edge type. This is already planned and will help significantly.

3. **Cross-shard edge bloom filter**: Consider adding a per-shard bloom filter on dst IDs in addition to the existing one on src/node IDs. This would let reverse queries skip shards with zero false negatives, same as forward queries. Cost: ~2 MB additional bloom filters (negligible). This is analogous to what Aster calls "pivot entries" for high-degree vertices.

---

## 2. Tombstone Semantics for Graph Integrity

This is the most critical section. The tombstone lifecycle is:

```
File F re-analyzed:
  1. All nodes with file=F get tombstoned (new tombstone segment)
  2. All edges owned by file F get tombstoned
  3. New nodes/edges written as new segment
  4. Atomic manifest swap
```

### 2.1. Dangling Edges from Unchanged Files

**The Problem:** Suppose file A.ts contains function `processData()` which calls `validate()` in file B.ts. The edge `processData --CALLS--> validate` is owned by A.ts's shard (source node's file). Now B.ts is re-analyzed: all nodes in B.ts are tombstoned and recreated. The `validate` function gets a new node with the **same semantic_id** (because semantic IDs are deterministic from path), therefore the **same u128 hash**.

**Analysis:** This is actually safe in the RFDB v2 design, because:

1. Edges store `dst` as u128, which is BLAKE3(semantic_id).
2. If `validate()` is recreated with the same semantic_id, the u128 is identical.
3. The edge from A.ts still points to a valid u128 that resolves to the new node.
4. **No dangling edge.**

However, there is a subtle case: **if the re-analysis of B.ts removes `validate()` entirely** (e.g., the function was deleted). Then:

1. The old `validate` node is tombstoned.
2. No new `validate` node is created.
3. The edge `processData --CALLS--> validate` from A.ts still exists, pointing to a u128 that resolves to... nothing.
4. **Dangling edge.**

This is the classic **referential integrity** problem in graph databases. NebulaGraph explicitly allows dangling edges (application-level concern). JanusGraph silently ignores them. Neo4j prevents them with constraints.

### 2.2. Impact on Graph Algorithms

Dangling edges (edges pointing to tombstoned/deleted nodes) affect algorithms differently:

| Algorithm | Impact | Severity |
|-----------|--------|----------|
| Point lookup | None (edge target not found, returns empty) | None |
| Forward neighbors | Returns edge with unresolvable dst | **Medium** |
| BFS/DFS | Traversal hits dead end (node not found), stops at that branch | **Low** (graceful degradation) |
| Reachability | May undercount reachable set if intermediate node deleted | **Medium** |
| SCC | Incorrect (missing back-edges through deleted nodes) | **High** |
| Datalog joins | Edge joins with node table produce no match for dangling dst | **Low** (equivalent to edge not existing) |

### 2.3. The Brief Inconsistency Window

The design claims: "Before commit() -> readers see previous consistent snapshot. After commit() -> readers see new consistent snapshot. Between -> impossible (atomic manifest swap)."

This is **correct** for single-batch commits. However, consider the **multi-file re-analysis scenario** in watch mode:

```
Time 0: Graph consistent. A.ts calls B.ts calls C.ts.
Time 1: B.ts and C.ts change simultaneously.
Time 2: Orchestrator batches both into single CommitBatch. Atomic swap. Consistent.
```

If the orchestrator sends them as **separate batches** (e.g., file watcher fires twice):

```
Time 0: Graph consistent. A.ts calls B.ts calls C.ts.
Time 1: B.ts re-analyzed, batch committed. B.ts nodes updated, but edges from A.ts to old B.ts nodes now point to new B.ts nodes (same semantic_id = same u128). OK.
Time 2: C.ts re-analyzed, batch committed. Same story.
```

This works because semantic_id stability means u128 values don't change for the "same" entity. The design's reliance on semantic_id as stable identity is what saves it here. **This is a strong design choice.**

### 2.4. The Real Risk: Enrichment Edge Staleness

The more dangerous case is **enrichment edges**. Consider:

```
Time 0: ImportExportLinker created edge: A.ts:import_X --RESOLVES_TO--> B.ts:export_X
Time 1: B.ts re-analyzed. export_X still exists with same semantic_id. Edge still valid.
Time 2: B.ts re-analyzed again. export_X renamed to export_Y. New semantic_id = new u128.
         The old enrichment edge points to the OLD u128. DANGLING.
```

The enrichment edge lives in `__enrichment__/imports/` virtual shard. It was NOT tombstoned because B.ts's re-analysis only tombstones B.ts's own shard and edges owned by B.ts. The enrichment edge is owned by the enricher, not by B.ts.

**This is correctly handled by the incremental re-enrichment step (Section 5.3 of the architecture doc)**: after re-analysis, the orchestrator identifies affected enrichers and re-runs them, which tombstones old enrichment edges and creates new ones. The key question is: **what happens between step 6 (manifest swap for B.ts) and step 7 (re-enrichment)?**

During this window, the graph has:
- New B.ts nodes (export_Y)
- Stale enrichment edge pointing to old u128 (export_X, which no longer exists)
- Readers see a snapshot with a dangling enrichment edge

### 2.5. Recommendations

**Verdict: CORRECT with caveats. Specific actions needed:**

1. **Document the dangling edge contract**: The system MUST specify that edges may point to non-existent nodes (dangling edges). All query code must handle `resolve(u128) -> None` gracefully. BFS/DFS must skip unresolvable neighbors without error. This is already how Datalog joins work (no match = row excluded), but traversal code must be equally robust.

2. **Atomic enrichment within CommitBatch** (recommended): Consider extending CommitBatch to include re-enrichment results in the same atomic swap. The orchestrator would:
   - Re-analyze files -> new nodes/edges
   - Run affected enrichers -> new enrichment edges
   - Single CommitBatch with both analysis and enrichment results
   - Single atomic manifest swap

   This eliminates the dangling enrichment edge window entirely. The architecture already supports this (CommitBatch groups by file, enrichment edges go to virtual shards). The only change is the orchestrator batching enrichment into the same transaction.

3. **Graph integrity validation command** (Phase 9): Add a `ValidateGraph` command that scans all edges and checks that both src and dst resolve to existing nodes. Report dangling edges. Run this as part of the migration validation suite.

4. **Tombstone cascade option** (future, not MVP): When a node is tombstoned, optionally tombstone all edges pointing TO it from other shards. This requires a reverse index (see Section 1.4) and is expensive. Not needed for MVP if the dangling edge contract is well-defined.

---

## 3. Snapshot Isolation for Graph Traversal

### 3.1. The Guarantee

The RFDB v2 snapshot model is:

- Reader acquires a reference to manifest v_N at time T.
- All reads go through v_N: segments listed in v_N, tombstones listed in v_N.
- Writer creates manifest v_{N+1} with new/updated segments. Atomic rename of `current.json`.
- Reader's reference to v_N is unaffected by the swap to v_{N+1}.
- Old segments stay on disk until no reader references them (GC).

This is a textbook MVCC approach. The key insight is that **immutable segments + atomic manifest pointer = serializable snapshot isolation** without any locking.

### 3.2. Can a Traversal See a "Torn" Graph?

A "torn" graph would mean a BFS that starts reading from manifest v_N but mid-traversal starts seeing data from v_{N+1}. Under the RFDB v2 design, this is **impossible** because:

1. The reader holds a reference to manifest v_N for the entire traversal.
2. All segment reads go through v_N's segment list.
3. New segments (in v_{N+1}) are invisible to this reader.
4. Old segments (tombstoned in v_{N+1}) are still on disk and still readable by this reader.

**This is correct.** The BFS in `traversal.rs` calls `get_neighbors` repeatedly. Each call resolves against the same manifest snapshot. No torn reads possible.

### 3.3. Comparison to Prior Art

This model is identical to how **BACH** (VLDB 2025) achieves snapshot isolation: "a cooperative in-memory lifetime interval-based and on-disk file snapshot-based multi-version concurrent control scheme." BACH uses file-level snapshots (which files are active) while RFDB v2 uses manifest-level snapshots (which segments are active). Both achieve the same guarantee.

**LSMGraph** takes a different approach with vertex-grained version control, which is more fine-grained but also more complex. LSMGraph needs this because it uses mutable CSR structures within levels, whereas RFDB v2's immutable segments make this unnecessary. The RFDB v2 approach is simpler and equally correct.

**Aster/Poly-LSM** delegates to RocksDB's MVCC, assigning timestamps to each transaction. This is heavier than manifest-based snapshots but supports true multi-version reads (reading at any historical timestamp). RFDB v2's manifest chain provides a similar capability through DiffSnapshots.

### 3.4. Edge Case: Long-Running Traversal vs. GC

If a BFS takes minutes (large graph, deep traversal) and meanwhile multiple commits happen, the reader's manifest v_N pins all segments referenced by v_N. These segments cannot be GC'd. If compaction creates new merged segments (in v_{N+1}, v_{N+2}, ...), the old un-compacted segments from v_N must stay on disk.

**Risk: disk space amplification during long queries.** With a 25 GB graph and active compaction, you could temporarily have 2x disk usage (old segments for readers + new compacted segments).

### 3.5. Recommendation

**Verdict: CORRECT. The snapshot isolation model is sound and well-supported by prior art.**

One additional safeguard:

1. **Reader timeout / manifest pinning limit**: Consider a maximum snapshot hold time (e.g., 5 minutes). If a reader holds a manifest reference beyond this, log a warning. Do NOT forcibly invalidate it (that would cause torn reads), but track it for debugging GC delays.

2. **Manifest reference counting for GC**: The GC must track which manifests have active readers. A simple approach: atomic reference count per manifest. When a reader starts, increment v_N's count. When done, decrement. GC can only reclaim segments unique to manifests with zero readers. This is straightforward and already implied by the design.

---

## 4. Diff Computation Correctness

### 4.1. The Algorithm

The DiffSnapshots algorithm as described:

```
Manifest v42: segments [a, b, c, d]
Manifest v43: segments [a, b, e, f]

Removed segments: {c, d} - {a, b, e, f} = {c, d}
Added segments:   {e, f} - {a, b, c, d} = {e, f}

Read removed segments -> set of removed IDs (R)
Read added segments   -> set of added IDs (A)

Modified nodes = R intersection A  (same semantic_id in both removed and added)
Truly removed  = R \ A             (in removed but not in added)
Truly added    = A \ R             (in added but not in removed)
```

### 4.2. Correctness Analysis

**Case 1: Node unchanged.** File re-analyzed, function `foo` has same semantic_id and same content. The roadmap says "skip re-enrichment when delta is empty (file touched but unchanged)." If the delta computation correctly detects unchanged nodes by comparing content (not just semantic_id), this is correct.

But wait -- the diff algorithm uses segment-level comparison, not content comparison. If file F is re-analyzed and produces identical nodes, but they're in a NEW segment (because re-analysis always writes a new segment), then:
- Old segment c (containing F's nodes) is in "removed segments"
- New segment e (containing F's identical nodes) is in "added segments"
- R intersection A = all of F's node IDs
- These are classified as "modified" even though content is identical.

**This is a false positive for "modified."** The architecture doc mentions "delta computation: diff(old segments, new segments) to detect actual changes" and "skip re-enrichment when delta is empty." This implies content comparison happens, but it's not specified in the DiffSnapshots algorithm.

**Case 2: Node content changes.** Function `foo` exists in both old and new with same semantic_id but different metadata (e.g., line number changed). R intersection A correctly identifies this as "modified."

**Case 3: Node added.** New function `bar` in the re-analyzed file. Not in R, present in A. Correctly classified as "truly added."

**Case 4: Node removed.** Function `baz` deleted. In R, not in A. Correctly classified as "truly removed."

**Case 5: Node moved across files.** Function `foo` moved from file A.ts to file B.ts in the same commit. Same semantic_id? No -- semantic_id includes file path (e.g., `src/A.ts->global->FUNCTION->foo`). So moving a function creates a NEW semantic_id. The old node is "truly removed", the new node is "truly added." Edges from other files pointing to the old u128 become dangling.

This is correct behavior: a move IS a delete + create from the graph's perspective. But it means blast radius analysis will show the moved function as both a removal and an addition, which may confuse users.

**Case 6: Non-consecutive manifests.** DiffSnapshots(v40, v43). Segments in v40: {a, b, c}. Segments in v43: {a, d, e}. Removed: {b, c}. Added: {d, e}. This correctly captures ALL changes between v40 and v43, even if intermediate manifests v41, v42 existed. The diff is based purely on segment sets, not on the chain of intermediate manifests.

But there is a subtlety: if node X was added in v41 and then modified in v42, the diff(v40, v43) sees X as "added" (not in v40's segments, present in v43's segments). The intermediate "modification" is invisible. **This is correct** -- from v40's perspective, X is indeed new.

However, if node Y existed in v40, was deleted in v41, and then re-added with the same semantic_id in v42, diff(v40, v43) sees Y in both R (from removed segments) and A (from added segments), classifying it as "modified." Whether this is correct depends on semantics: Y was deleted and recreated, but semantically it's a "modification" (same identity, potentially different content). This seems acceptable.

### 4.3. Compaction Interference

**Critical concern:** What if compaction happens between v40 and v43? Compaction merges segments {b, c} -> {bc_merged} in v41. Then:

```
v40: segments [a, b, c]
v41: segments [a, bc_merged]        (compaction)
v42: segments [a, bc_merged, d]     (new data)
v43: segments [a, d, e]             (file re-analysis: bc_merged tombstoned, e is new)
```

DiffSnapshots(v40, v43):
- Removed: {b, c} (from v40's set, not in v43)
- Added: {d, e} (in v43, not in v40)

But wait -- segments b and c no longer exist on disk! They were merged into bc_merged and the originals were GC'd (if v40's manifest has no active readers).

**This is a real problem.** DiffSnapshots must read the removed segments to extract node IDs. If those segments have been GC'd, the diff fails.

### 4.4. Recommendations

**Verdict: MOSTLY CORRECT, with two issues to address.**

1. **Manifest retention for diff**: DiffSnapshots(from, to) requires that all segments referenced by the `from` manifest still exist on disk. This means:
   - Tagged snapshots (git commits) must pin their segments against GC.
   - Compaction must NOT delete segments referenced by any retained manifest.
   - The GC policy in Section 1 of the roadmap already states "GC only removes segments not referenced by ANY remaining snapshot." This is correct IF tagged manifests are never GC'd without explicit deletion. **Verify this invariant in the implementation.**

2. **Content-level diff for "modified" detection**: The current algorithm (R intersection A) detects "same semantic_id in removed and added segments." For accurate delta reporting (especially for skip-re-enrichment optimization), add a content comparison step:
   - For each ID in R intersection A: compare metadata JSON from removed vs added segment.
   - If identical: classify as "unchanged" (not "modified").
   - If different: classify as "modified."
   - This prevents false positive "modified" classifications and unnecessary re-enrichment.

3. **Document the non-consecutive diff semantics**: Make explicit that DiffSnapshots(v40, v43) returns the net delta, not the intermediate changes. Users should understand that intermediate additions/deletions are collapsed.

---

## 5. Compaction and Graph Invariants

### 5.1. The Compaction Process

```
Multiple L0 segments in shard S: [seg1, seg2, seg3, tombstones_t1]
Compaction merges: sorted union of all records, minus tombstoned IDs
Result: single L1 segment with inverted index
Old segments moved to gc/ after manifest swap
```

### 5.2. Invariant Preservation

**Invariant 1: Every node has a unique semantic_id (and therefore unique u128).**

At L0, duplicate semantic_ids CAN exist: if file F is re-analyzed, the old segment has the old version and the new segment has the new version. The tombstone marks the old one as deleted. During reads, the query path skips tombstoned records, so only the new version is visible. Uniqueness holds.

After compaction, tombstoned records are physically removed. The compacted segment contains only live records. **Uniqueness holds after compaction IF the compaction correctly applies tombstones.** The proof is straightforward: compaction reads all records, filters out tombstoned IDs, deduplicates by u128 (keeping the latest), writes result.

**Invariant 2: Edge endpoints exist.**

This invariant does NOT hold in general (see Section 2: dangling edges). Compaction does not change this: if an edge pointed to a non-existent node before compaction, it still does after. Compaction neither creates nor resolves dangling edges.

However, compaction MUST NOT create NEW dangling edges. This could happen if:
- Compaction tombstones a node but not the edges pointing to it.
- This cannot happen because compaction applies tombstones within a single shard. Edges in OTHER shards are not touched. Cross-shard dangling edges exist before and after compaction equally.

**Invariant 3: No duplicate edges.**

Edges can be duplicated across segments (if enrichment runs twice without proper tombstoning). Compaction should deduplicate: same (src, dst, type) = keep one (latest). The deduplication key for edges should be (src, dst, type, _owner) to distinguish enrichment edges from different enrichers.

**Invariant 4: Query equivalence pre/post compaction.**

This is the fundamental invariant stated in Phase 7: "results before compaction = results after compaction." The proof structure:

Let Q be any query. Let S = {seg1, ..., segN, tomb1, ..., tombM} be the pre-compaction state. Let S' = {compacted_seg} be the post-compaction state.

For Q to return the same results:
1. For point lookups: any live node ID in S must be in S'. Any tombstoned ID in S must NOT be in S'. Follows from correct tombstone application.
2. For attribute search: any node matching predicate P in S (minus tombstoned) must match P in S'. Follows from correct record preservation.
3. For neighbors: any live edge in S must be in S'. Any tombstoned edge must not. Same argument.
4. For BFS/DFS: follows from 1-3 (traversal is composed of point lookups and neighbor queries).

**The proof obligation is on the compaction implementation**: it must be a pure function from (segments, tombstones) -> compacted_segment that preserves all live records exactly and removes all tombstoned records exactly.

### 5.3. Comparison to Prior Art

LSMGraph's compaction has an additional challenge: it must update the multi-level index (vertex -> position in CSR). This requires the vertex-grained version control mechanism to prevent readers from seeing partially updated indexes. RFDB v2's approach is simpler: compaction produces a new segment, manifest swap makes it visible atomically. No incremental index updates during compaction.

### 5.4. Recommendations

**Verdict: CORRECT, with proof obligations clearly defined.**

1. **Compaction equivalence test** (already in roadmap Phase 7): For every test, run the query before compaction and after compaction, assert identical results. This is the right approach. I suggest making this a **property-based test**: generate random graphs, random tombstone patterns, compact, verify query equivalence.

2. **Edge deduplication key**: Specify explicitly that edge identity is (src, dst, type) for analysis edges and (src, dst, type, _owner) for enrichment edges. Compaction must deduplicate by this key, keeping the version from the newest segment.

3. **Compaction must not span shards**: Each shard compacts independently. Cross-shard edges are never merged with intra-shard edges. This is already implied by the design (compaction is per-shard) but should be stated as an invariant.

---

## 6. Blast Radius via DiffSnapshots + Reachability Composition

### 6.1. The Composition

```
Step 1: delta = DiffSnapshots(from_snapshot, to_snapshot)
        -> {modifiedNodes, addedNodes, removedNodes, modifiedEdges, ...}

Step 2: affected = Reachability(
           startIds: delta.modifiedNodes + delta.addedNodes,
           maxDepth: 5,
           edgeTypes: ["CALLS", "IMPORTS", "DEPENDS_ON"],
           backward: true
         )
```

This computes: "which nodes transitively depend on the changed nodes?"

### 6.2. Soundness Analysis

**The blast radius is computed on the NEW snapshot** (to_snapshot). The Reachability query traverses the graph as it exists AFTER the change. This is the correct choice: we want to know "who is affected in the current state of the code?"

**Case 1: Function `foo` modified.** Backward reachability from `foo` finds all callers, callers' callers, etc. **Correct.**

**Case 2: Function `foo` added.** Backward reachability from `foo` finds nothing (no one calls it yet, since other files haven't changed). **Correct** -- a new function has zero blast radius until someone calls it. However, if `foo` was added AND an edge `bar --CALLS--> foo` was added in the same commit, then `bar` is in the affected set. **Correct.**

**Case 3: Function `foo` removed.** It's in `removedNodes`. But we're doing reachability on the NEW snapshot, where `foo` doesn't exist. We can't do backward reachability from a non-existent node.

**This is the critical gap.** The blast radius composition uses `delta.modifiedNodes + delta.addedNodes` as start IDs. It EXCLUDES `removedNodes`. But removals ARE blast-radius-relevant: if `foo` was removed, all callers of `foo` are now broken.

The fix is to do backward reachability from `removedNodes` on the OLD snapshot (from_snapshot):

```
Step 2a: affected_by_modifications = Reachability(
            startIds: delta.modifiedNodes + delta.addedNodes,
            snapshot: to_snapshot,    // NEW graph
            backward: true
         )

Step 2b: affected_by_removals = Reachability(
            startIds: delta.removedNodes,
            snapshot: from_snapshot,   // OLD graph (before deletion)
            backward: true
         )

Step 3: total_affected = affected_by_modifications union affected_by_removals
```

### 6.3. Transitive Dependencies Through Deleted Intermediates

**Scenario:** A -> B -> C (A calls B calls C). In the new version, B is deleted.

- `removedNodes` = {B}
- Backward reachability from B on OLD snapshot: A is affected. **Correct.**
- But what about C? C lost its only caller (B). C is not in the blast radius because C didn't change and no one changed who calls C.

Wait -- C is actually fine. C still exists, it just has one fewer caller. The real question is: does A now have a runtime error because B doesn't exist? That depends on the language semantics, not graph structure. The blast radius correctly identifies A as affected.

**Scenario:** A -> B -> C. B is modified (not deleted). The modification changes B such that B no longer calls C.

- `modifiedNodes` = {B}
- `modifiedEdges` includes removal of edge B->C
- Backward reachability from B on NEW snapshot: finds A. **Correct.**
- C is NOT in the blast radius. But C lost a caller. Should C be affected?

This depends on the definition of "affected." If "affected" means "could behave differently," then C is not affected (its code didn't change). If "affected" means "its caller graph changed," then we need to also do reachability from endpoints of removed edges.

### 6.4. Edge-Level Diff for Complete Blast Radius

For a fully sound blast radius, consider also:

```
Step 2c: affected_by_removed_edges = union over (src, dst) in delta.removedEdges:
            Reachability(startIds: [dst], snapshot: from_snapshot, backward: true)
```

This captures: "nodes that were reachable through now-removed edges." In the A->B->C example where B->C edge is removed, this would find B and A as affected through the old C backward reachability.

Whether this level of precision is needed depends on the use case. For "which tests to re-run?" it's probably overkill. For "which files could break?", it might be useful.

### 6.5. Recommendations

**Verdict: SOUND for the common case (modifications and additions). INCOMPLETE for removals.**

1. **Handle removals explicitly**: The blast radius must include backward reachability from `removedNodes` on the OLD snapshot. This requires that DiffSnapshots provides the `from_snapshot` manifest for Reachability to read against. The manifest chain already supports this (readers can hold references to any manifest). Add this as an explicit step in the blast radius documentation.

2. **Document the blast radius semantics**: Specify precisely what "affected" means. Recommended definition: "A node N is in the blast radius if its behavior could change due to the diff." This includes:
   - Nodes whose own content changed (in delta.modifiedNodes)
   - Nodes that transitively call a modified/added node (backward reachability on new snapshot)
   - Nodes that transitively called a removed node (backward reachability on old snapshot)

3. **Phase 9 validation**: The roadmap lists "Blast radius composition" as a Phase 9 critical gate. The test should cover all three cases above: modification, addition, and removal. Use a real codebase scenario: function deleted -> verify all callers are in blast radius.

4. **Depth limit awareness**: The `maxDepth: 5` limit in the example means blast radius truncates at 5 hops. For deep call chains (A -> B -> C -> D -> E -> F -> changed_function), F is outside the blast radius. This is a deliberate tradeoff (completeness vs. performance). Document it explicitly: blast radius is a **bounded approximation**, not an exact transitive closure.

---

## Summary of Recommendations by Priority

### Must Fix (Correctness)

| # | Issue | Phase | Action |
|---|-------|-------|--------|
| 1 | Dangling edges not handled in traversal code | Phase 4 | All graph traversal code must handle `resolve(u128) -> None` gracefully. BFS/DFS must skip unresolvable neighbors. |
| 2 | Blast radius ignores removedNodes | Phase 5+ | Add backward reachability from removedNodes on OLD snapshot. |
| 3 | DiffSnapshots fails if segments are GC'd | Phase 1 | Enforce: tagged manifests pin their segments. DiffSnapshots returns error if segments missing. |

### Should Fix (Robustness)

| # | Issue | Phase | Action |
|---|-------|-------|--------|
| 4 | Content-level diff for false positive "modified" | Phase 1 | Add content comparison step in DiffSnapshots for R intersection A. |
| 5 | Atomic enrichment within CommitBatch | Phase 6 | Orchestrator batches enrichment into same CommitBatch to eliminate dangling enrichment edge window. |
| 6 | Edge deduplication key spec | Phase 7 | Specify (src, dst, type) for analysis edges, (src, dst, type, _owner) for enrichment edges. |

### Nice to Have (Performance)

| # | Issue | Phase | Action |
|---|-------|-------|--------|
| 7 | Reverse edge bloom filter per shard | Phase 7 | Build bloom on dst IDs for reverse neighbor pruning. |
| 8 | ValidateGraph command | Phase 9 | Scan all edges, report dangling references. |
| 9 | Reader timeout for manifest pinning | Phase 8 | Log warning for long-held manifests to debug GC delays. |

---

## Prior Art References

- [LSMGraph: A High-Performance Dynamic Graph Storage System with Multi-Level CSR](https://arxiv.org/html/2411.06392v1) (SIGMOD 2024) -- vertex-grained version control for compaction correctness, snapshot isolation via timestamps
- [BACH: Bridging Adjacency List and CSR Format using LSM-Trees](https://www.vldb.org/pvldb/vol18/p1509-miao.pdf) (VLDB 2025) -- file-level snapshot isolation for hybrid graph workloads, lightweight multi-version scheme
- [Aster: Enhancing LSM-structures for Scalable Graph Database](https://arxiv.org/html/2501.06570v1) (SIGMOD 2025) -- Poly-LSM hybrid storage, adaptive edge handling (delta vs pivot updates)
- [LiveGraph: A Transactional Graph Storage System](https://vldb.org/pvldb/vol13/p1020-zhu.pdf) (VLDB 2020) -- purely sequential adjacency list scans, snapshot isolation for graph analytics
- [NebulaGraph: Dangling Edges](https://docs.nebula-graph.io/3.1.0/8.service-tuning/2.graph-modeling/) -- explicit dangling edge policy as application-level concern
- [Scalable and Robust Snapshot Isolation for High-Performance Storage Engines](https://www.vldb.org/pvldb/vol16/p1426-alhomssi.pdf) (VLDB 2023) -- formal treatment of snapshot isolation with immutable structures
