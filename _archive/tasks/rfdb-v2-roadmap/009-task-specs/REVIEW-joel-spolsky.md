# Joel Spolsky Review: RFDB v2 Task Specs

> Date: 2026-02-12
> Scope: All 25 task specs in `009-task-specs/`, milestones doc, roadmap, orchestrator design, semantic ID research
> Status: REVIEW COMPLETE

---

## Executive Summary

The specs are impressively thorough. The architectural vision is sound -- columnar storage with immutable segments, manifest-based MVCC, and the hybrid v1/v2 strategy are all defensible choices. The level of detail on data structures, binary formats, and nuances is above what I typically see.

That said, I found **12 substantive issues** ranging from hidden quadratic algorithms to interface gaps between tasks. None are fatal, but several would block a developer mid-implementation if not addressed before coding starts.

**Overall verdict:** Good enough to start M1 (all 4 tasks are independent and well-defined). M2-M3 specs need the fixes below before implementation begins.

---

## 1. Critical Issues (Must Fix Before Implementation)

### 1.1 T3.1: Quadratic Tombstone Computation in CommitBatch -- O(files x nodes_in_file)

**File:** `T3.1-tombstones-batch-commit.md`, CommitBatch Logic section

The `commit_batch()` pseudocode calls `self.query_nodes_by_file(file)` for each file in the batch, then `self.query_edges_by_file(file)`. But `query_nodes_by_file` does a zone-map-pruned columnar scan across all segments.

**The problem:** For a 10-file batch on a graph with 100 segments, this is 10 calls x (zone map check on ~100 segments + scan matching segments). That's fine. But `query_edges_by_file(file)` is worse -- edge segments don't have a `file` field. Edges have `src` and `dst` (both u128). To find "edges owned by file X," you need:

1. Find all node IDs in file X (node query)
2. Find all edges where `src` is one of those IDs (edge scan)

Step 2 is **O(all_edges)** for each file unless you have an index on src. Pre-compaction, this means scanning all edge segments for each file in the batch. For a 10-file batch on a 100K-edge graph: 10 x 100K = **1M edge scans**.

**The spec says:** "CommitBatch (1 file, 100 nodes) <10ms." That target is achievable for nodes (zone map prunes well) but likely NOT for edges without an explicit plan.

**Fix:** The spec must define `query_edges_by_file()` precisely. Options:
- **A.** Use src bloom filter: collect all node IDs for file, check src bloom on each edge segment, then scan matching segments. This is O(file_node_ids x segments), which is fine.
- **B.** During CommitBatch, only tombstone edges that are in the NEW batch's edge set (by src match), not ALL existing edges for the file. This is subtly different semantics -- you'd lose edges from a previous enrichment pass that aren't being re-created.

Option A is correct. The spec should spell out the bloom-filter-assisted edge tombstone algorithm.

**Big-O:** With bloom filters, edge tombstoning is O(file_node_count x edge_segments) bloom checks + O(matching_segments) scans. Acceptable, but the spec doesn't analyze this path.

### 1.2 T3.1: `changed_edge_types` in CommitDelta is Never Populated

**File:** `T3.1-tombstones-batch-commit.md`, `compute_delta()` function

The `compute_delta()` function collects `changed_node_types` from new and removed nodes. But `changed_edge_types` is declared but **never populated** -- there is no code to compute it.

```rust
// The spec shows:
let mut changed_edge_types: HashSet<String> = HashSet::new();
// ... but never adds to it!
```

To populate `changed_edge_types`, you need to iterate the new edges AND the old (tombstoned) edges, collecting their types. The old edges come from the same `query_edges_by_file()` call (see issue 1.1 above). The new edges come from the batch.

**Fix:** Add edge type collection to `compute_delta()`:
```rust
// From new edges:
for edge in &new_edges {
    changed_edge_types.insert(edge.edge_type.clone());
}
// From removed edges (already collected for tombstoning):
for (_, _, type_hash) in &tombstone_edges {
    // Need the actual string, not just the hash!
}
```

This reveals another issue: the tombstone stores `u64` hash of edge_type, but `changed_edge_types` needs the actual string. Either store the string alongside the hash during tombstone collection, or keep a separate `HashSet<String>` for delta computation.

### 1.3 T2.1 / T3.1: `find_snapshot()` is O(manifest_chain_length) -- Unbounded Linear Scan

**File:** `T2.1-manifest-snapshot-chain.md`, `find_snapshot()` method

```rust
pub fn find_snapshot(&self, tag_key: &str, tag_value: &str) -> Result<Option<u64>> {
    let mut version = self.current_version();
    loop {
        let manifest = self.load_manifest(version)?;  // disk read!
        // ... walk parent chain
    }
}
```

This walks the entire manifest chain from current to first manifest. Each step is a file read. After 1000 commits, this is 1000 file reads for a single `find_snapshot()` call.

The spec acknowledges this under "Nuance 6" and suggests caching. But the problem is that **T3.3 (Client Snapshot API)** depends on this being reasonably fast, and there's no spec for the cache.

**Fix:** Either:
- **A.** Add a tag index file: `tag_index.json` mapping tag key/value pairs to version numbers, updated on each commit. O(1) lookup.
- **B.** `list_snapshots()` reads the manifest directory (filesystem listing, no chain walking) and caches results. `find_snapshot()` uses this cache.
- **C.** Document that `find_snapshot()` is O(n) and acceptable for MVP (tags are rare, called infrequently).

Option C is honest and probably fine for MVP. But the spec should state this explicitly rather than leaving it as a "future optimization."

### 1.4 T1.4: Collision Resolution Requires Deferred Edge ID Fixup -- Not Fully Specified

**File:** `T1.4-semantic-id-v2.md`, "Critical Nuances" section 1

The spec correctly identifies that two-pass ID assignment means edges created during traversal reference provisional IDs. It proposes three approaches (A: deferred edges, B: symbolic references, C: per-scope resolve).

But it doesn't pick one definitively. "Recommendation: Approach A" is stated, but the interaction with the current `GraphBuilder` (which is the thing that collects nodes and edges) is not specified. Specifically:

1. When does `resolveCollisions()` get called relative to edge creation?
2. How does the fixup pass work? Does it walk all edges and replace src/dst strings?
3. What about edges where src is in file A and dst is in file B (cross-file)? Those reference IDs from a different file's collision resolution.

**Fix:** The spec must define the integration point with `GraphBuilder` or the visitor architecture. Specifically:
- Where in the pipeline does collision resolution happen (after all visitors for a file complete, before edges are sent to RFDB)?
- Cross-file edge references: collision resolution is per-file, but edges can reference nodes in other files. Those node IDs were resolved in a previous file's pass. This is fine as long as the resolved ID is used when creating the edge (the src file's nodes already have final IDs when the edge-creating code in another file references them). The spec should confirm this assumption.

---

## 2. Significant Issues (Should Fix Before Implementation)

### 2.1 T2.3: Edge Routing -- "Edge Stored in Src's Shard" Conflicts with CommitBatch File Grouping

**File:** `T2.3-multi-shard.md`, "Cross-Shard Edges" nuance

T2.3 says: "Edge stored in src's shard." But T3.1 says CommitBatch groups nodes by `file` field and tombstones all edges for that file. If edge from file A to file B is stored in shard A, and you CommitBatch file A, the edge is correctly tombstoned (src is in file A).

But what about analysis-phase edges where both src and dst are in the same file? Those edges are straightforward. The tricky case is when the ORCHESTRATOR creates edges during analysis between files (e.g., an IMPORT edge where src is in file A but the import node was created during file A's analysis). This is fine -- file A's CommitBatch will include both the import node and its edges.

The **actual conflict** is with enrichment edges: an enricher might create an edge where src is a node in file B but the enricher is processing file A. Under T3.1's model ("tombstone by src file"), CommitBatch for file A would NOT tombstone this edge (src is in file B). Under T5.1's enrichment model, the edge is in enrichment shard `__enrichment__/enricher/A`, which IS correctly scoped.

**Fix:** This is actually correct as designed, but the spec for T2.3 should explicitly state that the "edge in src's shard" rule applies ONLY to analysis-phase edges. Enrichment edges follow the enrichment shard model (T5.1). Currently the T2.3 spec mentions this briefly in nuance 4 but should be more prominent.

### 2.2 T1.1: mmap Alignment Padding is Not Accounted for in Column Offset Computation

**File:** `T1.1-segment-format.md`, Read Path section

The spec says column offsets are "computed arithmetically from header" and shows a padding calculation between u32 columns and u128 columns. But the `NodeSegmentV2::open()` implementation doesn't show how these offsets are calculated. Since the padding depends on `record_count`, the formula is:

```
u32_section_size = 5 * record_count * 4  // 5 u32 columns
padding = (16 - (32 + u32_section_size) % 16) % 16
u128_start = 32 + u32_section_size + padding
u64_start = u128_start + record_count * 16
```

This is straightforward but error-prone. A bug here means all column reads are wrong.

**Fix:** Add the explicit formula for each column offset in the spec. Or better: store column offsets in the header/footer (costs ~40 bytes but eliminates bugs). The Parquet approach is to store offsets, not compute them.

### 2.3 T4.1: "~120 Adapted Tests" is Underspecified

**File:** `T4.1-wire-protocol-v3.md`

"ALL ~120 existing protocol + Datalog tests pass (adapted for removed commands)" is the gate criterion. But the spec doesn't enumerate WHICH tests need adaptation, or what "adapted" means for each category.

This is THE most critical task in the entire roadmap. "Adapt tests" can easily become a 2-week yak-shave if the scope isn't clear.

**Fix:** Before T4.1 implementation begins, create a test inventory:
- Category A: Tests that should pass with zero changes (pure read operations)
- Category B: Tests that reference removed commands (DeleteNode, GetAllEdges) -- need rewrite
- Category C: Tests that check wire format details -- may need updates for requestId
- Category D: Tests using v1 internal APIs (HashMap access) -- need rewrite against trait

Even a rough count per category (A: ~80, B: ~15, C: ~10, D: ~15) would help scope the work.

### 2.4 T5.2: Enricher Selection Logic Has a Type Mismatch

**File:** `T5.2-orchestrator-batch-protocol.md`, Selective Enrichment section

```typescript
// Delta-driven selection: does this enricher care about what changed?
const relevantTypes = analysisDelta.changedNodeTypes;
if (!enricher.metadata.consumes.some(t => relevantTypes.includes(t))) {
    continue;  // Skip
}
```

But `enricher.metadata.consumes` is `EdgeType[]` (edge types the enricher reads), NOT node types. The spec for T1.2 explicitly says: "consumes only for edge types, not node types." So comparing edge types against `changedNodeTypes` is a type mismatch.

The correct check is: does the analysis delta contain edge types that this enricher consumes? But analysis creates CONTAINS, ASSIGNED_FROM, etc. -- these are analysis-phase edge types, not enricher-produced ones. So the first enrichers in the chain (ImportExportLinker, InstanceOfResolver) have `consumes: []` (they consume no enricher-produced edges) and consume only analysis-produced edges.

**Fix:** Enricher selection for the first wave (after analysis commit) should be based on:
1. `changedNodeTypes` intersection with the node types the enricher QUERIES (documented in T1.2 audit table as "Queries (node types)")
2. `changedEdgeTypes` intersection with `enricher.metadata.consumes`

This requires adding a `queriesNodeTypes: string[]` field to `EnricherMetadata`, or accepting that all enrichers in level 0 always run (conservative but correct).

### 2.5 T3.1: BatchState is Per-Connection, but Engine is Shared

**File:** `T3.1-tombstones-batch-commit.md`

`BatchState` accumulates nodes/edges. But `GraphEngineV2` is shared across connections (via `DatabaseManager`). The spec shows `batch_state` as a field of the engine.

If two clients open batches on the same database simultaneously, whose batch state wins? The spec for T4.1 (nuance 3) mentions "per-connection state" with a `ConnectionState` struct, but T3.1 puts `BatchState` inside the engine.

**Fix:** T3.1 should explicitly state that `BatchState` lives in `ConnectionState` (server-side, per connection), NOT in `GraphEngineV2`. The engine's `commit_batch()` takes the batch data as parameters, not from internal state.

```rust
// Correct: batch state outside engine
fn commit_batch(
    &mut self,
    nodes: Vec<NodeRecordV2>,
    edges: Vec<EdgeRecordV2>,
    tags: Option<HashMap<String, String>>,
) -> Result<CommitDelta>
```

### 2.6 T2.2: Equivalence Tests Are Critical but Underspecified

**File:** `T2.2-single-shard-read-write.md`, tests 20-23

"Same data in v1 HashMap engine and v2 shard -> identical query results" -- this is the most important test in T2.2. But "identical" needs definition:

- Node ordering? (v1 HashMap iteration is non-deterministic)
- Metadata field ordering in JSON?
- Edge dedup behavior? (v1 deduplicates by `(src, dst, type)`, v2 should too -- and the spec addresses this)
- `version` field? (v1 nodes have it, v2 doesn't)
- `exported` field? (v1 has it as a column, v2 moves to metadata)

**Fix:** Define "identical" precisely. Recommendation: compare as **sets** (not ordered lists), ignoring fields that are intentionally different (version, exported column). Create a `assertNodeSetEqual()` helper that handles these differences.

---

## 3. Dependency Issues

### 3.1 T3.2 Can Start Earlier

**File:** `008-milestones-and-tasks.md`, dependency graph

T3.2 (Client Batch API) depends on T3.1 (Rust Batch) + T1.3 (Request IDs). But T3.2 is mostly TS type definitions (`CommitDelta`, `beginBatch()`, `commitBatch()`). The TYPE definitions and client-side logic can be written and UNIT tested without the Rust server. Only INTEGRATION tests need T3.1.

**Optimization:** T3.2 can start as soon as T3.1's wire protocol is **specified** (not implemented). The spec already defines `CommitDelta` and the batch protocol. This unblocks Track 3 earlier.

### 3.2 T5.1 Should Depend on T3.1, Not Just T4.1

**File:** `T5.1-enrichment-virtual-shards.md`

T5.1 depends on T4.1 (working v2 engine). But T5.1 specifically extends CommitBatch with `file_context` parameter. The CommitBatch implementation is in T3.1, not T4.1. T4.1 integrates it into the wire protocol.

If T5.1 modifies the CommitBatch internals, it logically depends on T3.1's batch code more than T4.1's protocol layer.

**Impact:** Low -- the dependency is technically T4.1 (because T5.1 needs the full working system). But implementers should read T3.1's batch code first.

### 3.3 T1.4 Has Hidden Dependencies on Test Infrastructure

T1.4 (Semantic ID v2) needs "Full analysis of test fixtures" (test 31-33). This requires the analysis pipeline to work with the new ID format. But the analysis pipeline currently uses v1 IdGenerator. Switching IdGenerator to v2 mode requires updating ALL visitors.

The spec lists the visitor changes, but the dependency tree within T1.4 is deep:
1. ScopeTracker.getNamedParent() -- independent
2. computeSemanticIdV2() -- independent
3. ContentHasher -- independent
4. CollisionResolver -- independent
5. IdGenerator v2 mode -- depends on 1-4
6. All visitor updates -- depends on 5
7. Integration tests -- depends on 6

This is effectively **7 sequential sub-tasks**. The 600 LOC estimate may be tight given the number of visitors (8) that need changes.

---

## 4. Missing Specs / Gap Analysis

### 4.1 No Spec for `GraphEngine` Trait Definition

The milestones doc shows the `GraphEngine` trait with method signatures. But there's no task spec that defines the FULL trait (all methods, return types, error types). T2.2 creates `engine_v2.rs` implementing it. T4.1 switches handlers to use it.

**Gap:** Who defines the trait itself? T2.2 creates the v2 implementation, but the TRAIT should be defined first (possibly as part of T2.2 or as a sub-task of T1.1).

**Recommendation:** Add trait definition as the first sub-task of T2.2 (before implementing methods).

### 4.2 No Spec for `QueryEdges` Command (Replacement for `GetAllEdges`)

T4.1 says `GetAllEdges` is removed and replaced with "streaming QueryEdges with filters." But there's no spec for `QueryEdges` -- what filters does it support? Edge type? Src/dst ID? File?

Without this spec, T4.1 implementer has to design it on the fly.

### 4.3 No Spec for Ephemeral Database Semantics in v2

Multiple specs mention ephemeral databases casually ("write buffer only, no segments"). But the behavior needs full specification:

- Does CommitBatch work on ephemeral databases? (T3.1)
- Does manifest chain exist in memory? (T2.1)
- Are snapshots/tags available? (T3.3)
- How large can an ephemeral database get before OOM?

Ephemeral databases are critical for tests (every test creates one). If they break, ALL tests break.

### 4.4 No Spec for Datalog Engine Interaction with v2

The Datalog engine (unchanged in v2) queries the graph via `GraphEngine` trait methods. But Datalog has its own query patterns (full scans, joins). The spec assumes Datalog "just works" through the trait, but:

- Datalog's `findAll()` scans ALL nodes -- this becomes a multi-segment, multi-shard scan in v2
- Datalog's joins may create O(n^2) intermediate results if not careful
- Performance of Datalog queries may regress significantly with v2's scan-based approach

**Recommendation:** T4.4 (Integration Gate) should include specific Datalog performance benchmarks, not just "Datalog tests pass."

---

## 5. Big-O Complexity Analysis

### 5.1 Point Lookup: get_node(id)

**v1:** O(1) HashMap lookup.

**v2 pre-compaction:** O(shards) bloom checks + O(1) segment scan.
- Bloom check: O(k) hash computations per segment per shard. k=7 hashes.
- For S shards with average N segments each: O(S * N * 7) hash ops.
- 10 shards, 5 segments each = 350 hash ops. At ~10ns each = ~3.5us. Fine.

**v2 post-compaction:** O(log n) binary search in global index. Best case.

**Verdict:** Acceptable. The 50us target is achievable.

### 5.2 Attribute Query: query_nodes({type: "FUNCTION"})

**v1:** O(n) scan of HashMap values. n = total nodes.

**v2 pre-compaction:** O(segments) zone map checks + O(matching_segments * records_per_segment).
- Zone map eliminates ~90% of segments (only segments containing FUNCTION survive).
- Remaining segments: columnar scan of type column. Very cache-friendly.
- Roughly: O(0.1 * total_segments * avg_records_per_segment) = O(0.1 * n). Better constant factor than v1 due to columnar scan.

**v2 post-compaction:** O(result_set) via inverted index. Optimal.

**Verdict:** Good. May actually be FASTER than v1 for selective queries.

### 5.3 CommitBatch Delta Computation

**Current spec:** O(old_nodes_for_file + new_nodes) set operations.
- `old_nodes_for_file`: zone-map-pruned scan. O(matching_segments * records).
- Set difference/intersection: O(max(old, new)).

For a typical file re-analysis (100 nodes), this is O(100) for a well-sharded graph. But if the file is in a shard with 10,000 other nodes and 5 segments, the zone-map-pruned scan reads those segments (file zone map should narrow to 1-2 segments per file).

**Verdict:** O(file_nodes) as claimed, assuming zone maps work correctly. Acceptable.

### 5.4 find_snapshot() Chain Walk

As noted in issue 1.3: O(manifest_chain_length) disk reads. Worst case O(n) where n = total commits.

**Verdict:** Needs mitigation for production use. OK for MVP.

### 5.5 V1EnricherAdapter: Run-Once-Filter-Many

**T1.2 spec:** Legacy enricher runs once (O(all_nodes)), results cached. Each `processFile()` call filters by file: O(all_edges) per call if not pre-indexed.

With N files: N * O(all_edges) = **O(N * E)** where E = total enricher edges.

The spec suggests pre-indexing by file after first run: "store edges in Map<file, edges[]>". This makes it O(E) for the first call (build index) + O(file_edges) per subsequent call. Total: O(E + N * avg_file_edges) = O(E). Correct.

**But:** The `edgeBelongsToFile()` function needs `getNode(src)` and `getNode(dst)` to determine which file an edge belongs to. That's 2 * E node lookups. In v2, each is a bloom-filter-assisted scan.

**Verdict:** O(E * bloom_check_cost) for the index-building phase. For 10K edges and 10 shards: 10K * 10 * 7 * 10ns = ~7ms. Acceptable for a transitional adapter.

### 5.6 Compaction Merge (T6.1)

Merge K L0 segments into 1 L1 segment:
- Read all records: O(total_records_in_L0)
- Sort by u128 id: O(n log n)
- Dedup + tombstone apply: O(n)
- Write L1 + build indexes: O(n)

For a shard with 10 L0 segments of 1000 records each: n=10K. Sort: 10K * 14 = 140K comparisons. At ~5ns each = ~0.7ms. Writing 10K records: ~20ms (500K/sec target).

**Verdict:** Fast. Compaction is not a bottleneck.

### 5.7 Enricher Dependency Propagation (T5.3)

Worst case: all E enrichers re-run for all F files. O(E * F) enricher invocations. With 17 enrichers and 10 changed files: 170 invocations. Each invocation is one `processFile()` call.

**Verdict:** Bounded by E * F. With DAG termination guarantee, this is safe.

---

## 6. Risk Assessment

### High Risk Tasks

| Task | Risk | Why |
|------|------|-----|
| **T4.1** (Wire Protocol v3) | HIGH | ~120 test adaptations. Largest integration surface. Single point of failure for the entire project. |
| **T1.4** (Semantic ID v2) | HIGH | Touches 8 visitors. Two-pass ID assignment changes the fundamental node creation flow. If IDs are wrong, everything downstream breaks. |
| **T3.1** (Tombstones + Batch) | MEDIUM-HIGH | Complex state machine (batch open/close). Edge tombstoning algorithm not fully specified. Delta computation has edge-type gap. |
| **T6.1** (Compaction) | MEDIUM-HIGH | Concurrent reads during compaction. GC safety. Blue/green swap. Many subtle failure modes. |

### Medium Risk Tasks

| Task | Risk | Why |
|------|------|-----|
| **T2.2** (Single Shard) | MEDIUM | 2000 LOC, largest single task. Write buffer + segment union semantics are tricky. |
| **T5.2** (Orchestrator Batch) | MEDIUM | Orchestrator.ts is 1248 LOC of complex pipeline code. Refactoring it is risky. |
| **T1.1** (Segment Format) | MEDIUM | Binary format bugs are hard to find. mmap alignment issues are platform-dependent. |

### Low Risk Tasks

| Task | Risk | Why |
|------|------|-----|
| **T1.2** (Enricher Contract) | LOW | Pure types + metadata. No runtime behavior change. |
| **T1.3** (Request IDs) | LOW | Small, well-bounded change. Clear backward compat story. |
| **T3.2, T3.3** (Client APIs) | LOW | Thin wrappers over wire protocol. |
| **T4.2, T4.3** (Client Wire/Streaming) | LOW | Client-side only, well-specified. |
| **T7.x** (Migration/Validation) | LOW | No new architecture. Testing what already exists. |

---

## 7. Interface Boundary Review

### Well-Defined Boundaries (Good)

- **T1.1 <-> T2.1:** Segment format is frozen after T1.1. Manifest references segments by descriptor. Clean interface.
- **T1.2 <-> T5.2:** EnricherV2 interface is fully specified. Orchestrator consumes it. No ambiguity.
- **T1.3 <-> T4.3:** Request IDs enable streaming. The chunk format (`{requestId, done, nodes}`) is clear.

### Fuzzy Boundaries (Need Attention)

- **T3.1 <-> T4.1:** CommitBatch is defined in T3.1 (engine internals) AND T4.1 (wire protocol). The boundary is: T3.1 owns the logic, T4.1 owns the handler. But T4.1 spec also shows handler logic that duplicates T3.1's description. **Risk:** Implementers of T4.1 might re-implement what T3.1 already did.

- **T5.1 <-> T5.2:** T5.1 adds `file_context` to CommitBatch (Rust side). T5.2 uses it from TS orchestrator. The interface is `commitBatch({ fileContext: "..." })` in the wire protocol. But T5.1 doesn't specify the wire format for `file_context`, and T5.2 assumes it exists. **Fix:** T5.1 should include the wire protocol addition (Request variant).

- **T2.2 <-> T2.3:** T2.2 creates single-shard engine. T2.3 makes it multi-shard. The boundary is `GraphEngineV2` struct: T2.2 has `shard: Shard`, T2.3 changes to `shards: HashMap<String, Shard>`. This means T2.3 **rewrites** the engine struct, not just extends it. **Recommendation:** T2.2 should already use `shards: HashMap` with a single "default" shard, making T2.3 a configuration change rather than a structural rewrite.

---

## 8. Missing Edge Cases

### 8.1 File Paths with Special Characters

Shard naming uses directory paths. What about:
- Spaces in paths: `src/my app/index.js`
- Unicode paths: `src/komponenter/...`
- Windows-style paths (if someone runs on WSL)
- Paths with `__enrichment__` in them (collision with enrichment shard prefix!)

**Recommendation:** ShardPlanner should sanitize paths. The `__enrichment__` prefix must be documented as reserved.

### 8.2 Empty CommitBatch

What happens if `beginBatch()` then `commitBatch()` with zero nodes and zero edges? The spec doesn't address this.

Expected behavior: no manifest update, empty delta (`nodesAdded: 0`, etc.), no error.

### 8.3 Concurrent CommitBatch on Same Database

T3.1 mentions "snapshot isolation" for readers, but what about two concurrent writers? If client A and client B both call `commitBatch()` simultaneously on the same database:

1. Both compute tombstones against the SAME current manifest
2. Both create new manifests (different version numbers?)
3. Both try to commit (atomic rename of `current.json`)

Only one `rename()` wins (last writer wins). The other client's manifest becomes an orphan.

**This is a data loss scenario:** Client A's commit succeeds, then client B's commit succeeds (overwriting A's pointer). Client A's changes are lost.

**Fix:** The engine needs a mutex around the commit path, or optimistic concurrency (check `current.json` version before rename, retry if changed). The spec should address this explicitly.

### 8.4 Manifest JSON Compatibility

Manifest format is JSON. What if a field is added in a future version? `serde_json` will fail on unknown fields by default.

**Fix:** Add `#[serde(deny_unknown_fields)]` explicitly (or don't -- `serde_json` ignores unknown fields by default, which is correct for forward compatibility). Document the decision.

---

## 9. Spec Quality Notes (Non-Blocking)

### Consistently Excellent

- **T1.1** (Segment Format): Best spec in the set. Every field, every byte offset, every nuance documented. Binary format is fully specified. Test plan covers all categories.
- **T1.2** (Enricher Contract): Thorough enricher audit. Dependency graph is validated. Migration strategy is clear.
- **T2.1** (Manifest): Crash safety analysis is solid. GC two-phase design is elegant.
- **T3.1** (Tombstones + Batch): Rich test plan. Delta computation is well-thought-out (aside from the edge-type gap).

### Needs More Detail

- **T5.1** (Enrichment Virtual Shards): Only 1 page. Missing: wire protocol for `file_context`, shard naming sanitization, cross-enricher query fan-out details. This is 700 LOC estimated -- the spec should be proportionally detailed.
- **T6.1** (Compaction): 1.5 pages for 1500 LOC. Missing: concurrent compaction of multiple shards, memory budget during compaction (reading all L0 into memory could be large), error recovery (partial compaction failure).
- **T6.2** (Resource Adaptation): Very thin. Missing: how RSS is monitored (polling interval?), what triggers "memory pressure" (threshold?), how are adaptive parameters recalculated (on each commit? periodically?).
- **T7.x** (All validation tasks): Validation checklists are good but don't specify HOW each check is implemented. For example, "bit-for-bit query equivalence" -- is this a test that runs both v1 and v2, or is it a manual comparison? Who runs it?

---

## 10. Summary of Recommendations

### Must Fix (Before Implementation)

1. **T3.1:** Specify bloom-filter-assisted edge tombstone algorithm for `query_edges_by_file()`
2. **T3.1:** Populate `changed_edge_types` in `compute_delta()`
3. **T3.1:** Move `BatchState` to `ConnectionState`, not `GraphEngineV2`
4. **T1.4:** Specify the exact integration point for CollisionResolver with GraphBuilder/visitors
5. **Concurrent writers:** Address the race condition in CommitBatch (mutex or optimistic concurrency)

### Should Fix (Before Implementation of Affected Task)

6. **T2.1:** Document O(n) cost of `find_snapshot()` explicitly; add tag index for T3.3
7. **T1.1:** Add explicit column offset formulas or store offsets in footer
8. **T4.1:** Create test inventory categorizing ~120 tests before implementation
9. **T5.2:** Fix enricher selection type mismatch (edge types vs node types)
10. **T5.1:** Expand spec: wire protocol for `file_context`, shard naming rules

### Nice to Have

11. **T2.2:** Start with `shards: HashMap` (single entry) to ease T2.3 transition
12. **T2.2:** Define `assertNodeSetEqual()` helper for equivalence tests
13. **T4.1:** Add `QueryEdges` command spec (replacement for `GetAllEdges`)
14. **General:** Specify ephemeral database semantics across all relevant tasks
15. **T3.1:** Document empty CommitBatch behavior

---

*Joel Spolsky, Implementation Planner*
*"The specs are good. The devil is in the six places where they're not."*
