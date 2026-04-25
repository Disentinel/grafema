# Anders Hejlsberg Review: RFDB v2 Architecture & Roadmap

> Date: 2026-02-11
> Role: Practical Type Systems / Tooling Consultant
> Input: rfdb-v2-architecture-final.md, rfdb-v2-roadmap (002-roadmap.md), Steve Jobs review (003-steve-review.md), SemanticId.ts, existing codebase

---

## Executive Summary

The RFDB v2 design is architecturally sound and well-phased. The core decisions -- immutable columnar segments, semantic ID as first-class identity, batch commit with snapshot isolation, LSM-tree storage -- are the right choices for a code analysis database at this scale. I have spent decades building tools where identity, incremental computation, and interactive latency are existential concerns. This review focuses on the practical implications that become visible only when you have built and operated such systems at scale.

My overall assessment: **the architecture will work**, but there are five areas where the current design either under-specifies critical behavior or makes assumptions that will bite you at 50M+ nodes. I will detail each below.

---

## 1. Semantic ID as Identity

### 1.1. The Decision is Correct -- With Caveats

Making `semantic_id` (e.g., `src/app.js->global->FUNCTION->processData`) a first-class columnar field with u128 BLAKE3 as derived index is the right identity model for code analysis. Let me explain why by comparing to how other systems handle this.

**Kythe** uses [VNames](https://kythe.io/docs/kythe-storage.html) -- a 5-tuple of (signature, corpus, root, path, language). The signature is language-specific and assigned by the analyzer. VNames are the primary identity, and everything else (facts, edges) references them. This is conceptually identical to Grafema's semantic ID approach: a structured, human-readable identity with a hash for fast lookup. The key difference is that Kythe's VName is a fixed-schema tuple while Grafema's semantic ID is a path-encoded string. Both work. Grafema's is more readable for debugging, Kythe's is more structured for programmatic manipulation.

**CodeQL** uses a [relational model](https://codeql.github.com/docs/codeql-overview/about-codeql/) where identity is implicit in the TRAP extraction -- each entity gets a unique key during extraction, and the relational schema enforces referential integrity. There is no stable cross-extraction identity; re-extraction produces a fresh database. This is simpler but means CodeQL cannot do incremental updates -- every analysis is a full rebuild. Grafema's semantic ID explicitly solves this limitation.

**Glean** (Meta's code indexing system) uses [fact IDs](https://glean.software/blog/incremental/) that are database-internal integers, but tracks ownership via "units" (typically files). Glean's stacked immutable databases are remarkably similar to RFDB v2's immutable segments with tombstones. The critical difference: Glean propagates ownership through the fact graph to determine which facts to hide when a file changes, while Grafema uses file-field on nodes and `_owner` on enrichment edges. Grafema's approach is simpler and more explicit, which I prefer.

**Sourcetrail** used [SQLite with integer IDs](https://github.com/CoatiSoftware/Sourcetrail/blob/master/DOCUMENTATION.md) -- no semantic identity at all. Every re-indexing produced fresh IDs. This made incremental updates impossible and is why Sourcetrail was always slow to re-index. Do not follow this path.

**Verdict:** Semantic ID as first-class identity is the right call. It gives you: (a) stable identity across re-analysis, (b) human-readable debugging, (c) natural file-based ownership, (d) efficient hashing for internal operations.

### 1.2. Refactoring Operations: The Real Problem

When a developer renames `processData` to `handleData`, the semantic ID changes from `src/app.js->global->FUNCTION->processData` to `src/app.js->global->FUNCTION->handleData`. When they move a function to a different file, the file prefix changes. When they move it to a different scope (e.g., into a class), the scope path changes.

**What happens to the graph?**

The current design handles this correctly but implicitly: re-analysis of the affected file produces new nodes with new semantic IDs, the old file's nodes get tombstoned, and edges get rebuilt. This is the "re-analyze is recovery" principle from the architecture doc. But there is an important subtlety the roadmap does not address:

**Cross-file edges from enrichment become stale.** If `fileA.js` has a function that calls `processData` from `fileB.js`, and `processData` gets renamed in `fileB.js`, then:
1. `fileB.js` gets re-analyzed -- new nodes with new semantic IDs, old nodes tombstoned. Correct.
2. But `fileA.js` was NOT re-analyzed. Its CALLS edge still points to the old u128 hash of `src/fileB.js->global->FUNCTION->processData`, which is now tombstoned.
3. The enrichment layer needs to detect this and re-run -- but how?

The `CommitBatch` delta returns `changedFiles`, `nodesAdded`, `nodesRemoved`. The orchestrator can see that nodes were removed and trigger re-enrichment. But the enrichment re-run only processes nodes from the changed files. The stale edge in `fileA.js`'s enrichment shard points to a now-tombstoned node. This is a **dangling reference**.

**Recommendation:** The architecture needs an explicit strategy for dangling edge detection. Two options:

1. **Lazy invalidation (recommended for MVP):** When querying neighbors, skip edges whose dst/src resolves to a tombstoned node. Report these as "stale" in the response. The orchestrator can schedule re-enrichment for the affected file. This adds zero cost to the write path and O(1) per edge on the read path (bloom filter check on the target node).

2. **Eager invalidation (better but more complex):** On CommitBatch, for every removed node ID, check if any enrichment edges reference it. Tombstone those enrichment edges and include the enricher owner in the delta. This requires a reverse index from node IDs to enrichment edges referencing them.

I strongly favor option 1 for MVP because it preserves the clean separation between RFDB (storage) and the orchestrator (policy). Dangling edges are a transient state that gets cleaned up on the next enrichment pass. The key is: **never return a dangling edge to the client without flagging it**.

### 1.3. Anonymous Functions and Dynamic Constructs

The current `computeSemanticId` handles anonymous functions via discriminators: `src/app.js->processData->CALL->console.log#0` (the `#0` suffix). This uses line/column-based ordering to assign stable indices to same-named items in the same scope.

**This is fragile.** Adding a new `console.log` call before the existing one changes the discriminator of the existing call from `#0` to `#1`. Every edge pointing to the old `#0` breaks.

Compare to TypeScript's approach: in the language service, we do NOT use positions as identity. Symbols are identified by their declaration node in the AST, and when the AST is incrementally updated, we preserve symbol identity by matching declaration structure, not position. The key insight: **position is a property of a node, not its identity**.

For Grafema's use case (analyzing legacy untyped code), perfect structural matching is not always possible. But the current discriminator scheme has a specific failure mode: **inserting a statement before an existing call site changes the semantic ID of the existing call site**. This is the same problem that line-number-based IDs had -- just slightly less fragile.

**Recommendations:**

1. **For named entities (functions, classes, variables, parameters):** The current scheme is fine. Names are stable across edits. No change needed.

2. **For anonymous/positional entities (call sites, literals, expressions):** Consider using a content-based discriminator instead of position-based. For example, `console.log` calls could be discriminated by their argument structure: `console.log#arg("error message")` or a hash of the call expression's AST subtree. This is more stable across insertions/deletions. The tradeoff: content changes also change the discriminator. But content changes naturally trigger re-analysis anyway, so this is acceptable.

3. **For computed property names (`obj[expr]`) and fully dynamic constructs:** Accept that these cannot have stable semantic IDs. Use a position-based fallback with an explicit `UNSTABLE` marker in the ID format. AI agents querying the graph should know that `UNSTABLE` nodes may change identity across analyses.

4. **Document the stability contract.** Every node type should declare whether its semantic ID is "stable" (survives unrelated edits), "semi-stable" (survives unrelated edits within the same scope), or "positional" (may change on any edit to the containing scope). This is metadata the orchestrator and AI agents need.

### 1.4. How TypeScript Handles Symbol Identity (Lessons to Transfer)

In TypeScript's compiler, a Symbol is created during binding. Its identity is the declaration AST node itself -- a pointer into the syntax tree. When the tree is incrementally updated:
- Unchanged subtrees keep their nodes (pointer identity preserved).
- Changed subtrees get new nodes (new symbols).
- The checker lazily recomputes types only for symbols whose declarations changed.

The lesson for Grafema: **identity should be structural, not positional**. The semantic ID path (`file->scope->type->name`) IS structural for named entities. The problem is only with unnamed/repeated entities. The discriminator scheme is the weakest link in the identity chain, and it deserves more attention than a simple position-based counter.

---

## 2. Wire Protocol API Design

### 2.1. The Batch API is Ergonomic

`BeginBatch` -> `AddNodes/AddEdges` -> `CommitBatch` is clean and natural. The backward compatibility (auto-commit without `BeginBatch`) is well thought out. This mirrors how TypeScript's project system handles updates: `updateSourceFile()` is a single-file operation, but the program update batches multiple file changes before re-checking.

**One concern:** The roadmap says edge ownership is determined by the src node's file. But what happens during a batch that adds nodes and edges where the src node was added in a previous batch (not the current one)? RFDB needs to look up the src node to find its file. If the src node is in the current write buffer (same batch), that is fine. If it is in an older segment, RFDB needs a read-during-write. The roadmap does not address this interaction between the write buffer and existing segments during ownership resolution.

**Recommendation:** Clarify that during CommitBatch, RFDB resolves edge ownership by: (1) checking the current batch's write buffer first, (2) falling back to the existing snapshot for nodes not in the batch. This is the natural behavior, but it should be documented as a guarantee because enrichment edges frequently reference nodes from older batches.

### 2.2. The Black Box Principle is Correct -- Mostly

The client not knowing about shards, segments, or manifests is the right abstraction. Compare to how database drivers work: you do not expose B-tree pages to the application. The client sends nodes with a `file` field, and RFDB handles the rest.

**Where the black box leaks:** The `CommitBatch` response includes `changedFiles`. This is file-level information that the client already knows (it just sent those files). The more useful information is what the orchestrator cannot easily compute itself: `changedNodeTypes` and `changedEdgeTypes`. These are derived from RFDB's diff computation and are genuinely valuable for incremental enrichment decisions.

**Suggestion:** Consider also returning `removedNodeIds` (or at least `removedNodeIdCount`) in the delta. The orchestrator needs this to detect potential dangling references (as discussed in section 1.2). Currently the delta gives `nodesRemoved` as a count, but not which nodes. For incremental enrichment, knowing WHICH nodes disappeared (not just how many) is critical for targeted re-enrichment.

**Counter-argument to myself:** Returning all removed node IDs could be expensive for large batch operations (re-analyzing 100 files might remove 50K nodes). A compromise: return removed node IDs only if the count is below a threshold (say, 1000), otherwise return just the count and let the orchestrator use `DiffSnapshots` for the full list. This keeps the common case (1-10 files changed) fast and informative.

### 2.3. Request IDs and Streaming

Request IDs for multiplexing are the right complexity level. This is standard in modern protocols (HTTP/2 stream IDs, LSP request IDs). The streaming response format (`{ requestId, chunk, done }`) is simple and correct.

**One practical concern from TypeScript language server experience:** Streaming is valuable for large result sets, but most AI agent queries return small results (find a function: 1 node; trace calls: 10-50 edges; check dependencies: 50-200 nodes). For these, streaming adds overhead (frame parsing, reassembly) with no benefit.

**Recommendation:** Make streaming opt-in per request. Default to non-streaming (single response frame). Client sends `{ requestId: "r1", cmd: "queryNodes", stream: true, ... }` to enable streaming. This avoids paying the streaming tax on the 95% of queries that return < 100 results.

---

## 3. Incremental Analysis via Delta

### 3.1. Is the Delta Sufficient?

The `CommitBatch` delta returns:
```
{
  changedFiles: ["src/auth/login.ts", ...],
  nodesAdded: 15,
  nodesRemoved: 12,
  nodesModified: 3,
  edgesAdded: 20,
  edgesRemoved: 18,
  changedNodeTypes: ["FUNCTION", "VARIABLE"],
  changedEdgeTypes: ["CALLS", "CONTAINS"]
}
```

**For enrichment decisions, this is sufficient.** The orchestrator maintains a mapping of enricher -> input node types. If `changedNodeTypes` intersects an enricher's input types, re-run that enricher for the changed files. This is correct.

**For guarantee checking, this is sufficient.** Datalog rules declare which node/edge types they depend on. If `changedNodeTypes` or `changedEdgeTypes` intersects a rule's dependencies, re-evaluate that rule. This is correct.

**For AI agent notifications ("your context changed"), this is insufficient.** An AI agent working with `processData` needs to know specifically: "the function you were looking at changed." The type-level delta ("some FUNCTION changed") is too coarse. The agent would need to re-query to find out if its specific function was affected.

### 3.2. The Right Granularity Question

TypeScript's incremental system tracks affected files via the module dependency graph. When `fileB.ts` changes, TypeScript walks the import graph backward to find all files that (transitively) depend on `fileB.ts` and marks them for re-checking. This is file-level granularity -- not node-level.

Grafema's delta is also file-level (`changedFiles`), which is the right granularity for the RFDB layer. Node-level change tracking at the storage layer would require per-node versioning, which contradicts the immutable-segment model. The decision to keep this at file granularity is correct.

**However:** the `DiffSnapshots` command provides node-level granularity on demand:
```
DiffSnapshots { from: 42, to: 43 }
-> { addedNodes: [...], removedNodes: [...], modifiedNodes: [...] }
```

This is the right layering: cheap summary in CommitBatch response, detailed diff available on demand. The orchestrator or AI agent can call `DiffSnapshots` when it needs node-level detail. No wasted work for the common case.

### 3.3. Missing: Dependency Graph at the Orchestrator Level

The roadmap explicitly says orchestrator redesign is out of scope. But I want to flag a structural gap: RFDB provides the *data* for incremental analysis, but the *policy* of "which enrichers to re-run" requires a dependency graph that RFDB does not maintain.

Consider: enricher A produces edges of type X. Enricher B consumes edges of type X as input (via a Datalog rule). When enricher A's output changes, enricher B needs to re-run. This is a second-order dependency. The `changedEdgeTypes` in the delta can trigger this, but only if the orchestrator maintains the enricher dependency graph. This is not an RFDB concern, but it is a gap that will bite when implementing incremental enrichment.

**Recommendation:** When the orchestrator research starts, make enricher dependency ordering a first-class concern. RFDB provides the primitives; the orchestrator needs a topological sort of enrichers. This is analogous to how TypeScript orders type-checking passes: parsing -> binding -> checking -> emit, with each pass consuming the previous pass's output.

---

## 4. Query Model for AI Agents

### 4.1. Latency Impact of Disk-Based Storage

This is the area where I have the strongest concerns. Grafema's thesis is "AI queries the graph, not reads code." For this to work, graph queries must be *faster and more informative* than reading code. Let me quantify:

An AI agent reading a file: ~50ms to read from disk + processing time. Effectively instant.

An AI agent querying RFDB v2 at Level 0 (pre-compaction):
- Point lookup: O(shards) bloom filter checks. With 300 shards, each bloom filter in RAM (~2 bytes per key, nanoseconds per check), this is ~microseconds. Then one segment read from disk (mmap). If the page is cached by the OS: ~microseconds. If not: one SSD random read, ~50-200 microseconds. **Total: low hundreds of microseconds.** Acceptable.
- Attribute search (e.g., find all FUNCTIONs named "login"): manifest pruning reduces to relevant shards, then columnar scan. With small L0 segments (~500-2000 nodes), this scans perhaps 10-40 KB per matching shard. **Total: low milliseconds.** Acceptable.
- Neighbors query: bloom filter on edge segments, then scan. Similar to point lookup but across edge segments. **Total: low milliseconds.** Acceptable.
- BFS depth=3 from a node: multiple rounds of neighbor queries. If each round is ~1ms, depth-3 with branching factor 10 means ~10 queries x 1ms = **~10ms.** Acceptable.

Post-compaction (Level 1+):
- Point lookup via global index: binary search, O(log N). For 50M nodes, ~26 comparisons. With mmap'd index, this is **~microseconds.** Excellent.
- Attribute search via inverted index: O(1) per shard. **~microseconds to low milliseconds.** Excellent.

**My assessment:** The latency is acceptable for AI agent workflows. AI agents operate on a timescale of seconds (LLM inference dominates). Graph queries returning in 1-10ms are negligible compared to the seconds an agent spends thinking. The concern about disk-based latency is theoretically valid but practically irrelevant for the AI-agent use case.

**Where latency DOES matter:** When an AI agent issues many sequential queries in a chain (e.g., "find function X, find its callers, for each caller find their file, for each file find all exports..."). If each step takes 5ms and the chain has 20 steps, that is 100ms. Still acceptable, but this is where a hot cache layer would help.

### 4.2. What Queries Do AI Agents Need?

From my experience building developer tools and from analyzing the Grafema MCP/CLI commands:

1. **Find entity by name/type** -- "What is `processData`?" -> `queryNodes({name: "processData", type: "FUNCTION"})`. Covered.
2. **Trace call chain** -- "Who calls `processData`?" -> `neighbors(nodeId, {edgeType: "CALLS", direction: "incoming"})`. Covered.
3. **Understand context** -- "What is the context around `processData`?" -> `context(nodeId)` (the REG-406 feature). This composes neighbors + node lookup. Covered.
4. **Impact analysis** -- "If I change `processData`, what breaks?" -> `DiffSnapshots` + `Reachability`. Covered in v2.
5. **Pattern search** -- "Find all HTTP endpoints that call a database function." -> Datalog query composing edge types. Covered.
6. **File-level overview** -- "What is in this file?" -> `queryNodes({file: "src/app.js"})`. Covered.
7. **Cross-reference** -- "Where is this variable used?" -> neighbors + BFS. Covered.

**What is NOT covered and matters:**

8. **Fuzzy/substring search** -- "Find functions related to 'auth'." The roadmap says "MVP: columnar scan + SIMD, post-MVP: trigram index." For AI agents, this is the most natural query type (agents think in natural language, not exact identifiers). The lack of efficient substring search at MVP will limit the AI agent experience.

9. **Aggregation queries** -- "How many functions are in this module?" "What is the most-called function?" These require either Datalog rules or a separate aggregation layer. Not covered but straightforward to add.

10. **Temporal queries** -- "When was this function last changed?" With snapshot tags tied to git commits, this is answerable via `ListSnapshots` + `DiffSnapshots`, but it requires scanning snapshots sequentially. For frequently-asked temporal questions, a materialized "last-modified" metadata field on nodes would be more efficient.

### 4.3. Comparison to TypeScript Language Server Protocol

The TypeScript language server provides:
- `textDocument/definition` -- find definition (= point lookup + edge traversal)
- `textDocument/references` -- find all references (= reverse neighbors)
- `textDocument/hover` -- get type info at position (= node lookup + type metadata)
- `textDocument/completion` -- suggest completions (= scope-aware query)
- `textDocument/signatureHelp` -- function signature (= node metadata)
- `textDocument/rename` -- find all rename locations (= reverse neighbors + validation)

Grafema's query model covers the data needs behind all of these except completion (which requires scope-aware ranking and type compatibility checking -- a feature, not a storage concern).

**The concept that transfers most directly:** TypeScript's "find all references" is essentially `Reachability` with `edgeTypes: ["REFERENCES"]` and `backward: true`. The language server returns results incrementally (as files are processed), which maps to RFDB v2's streaming responses. Good alignment.

**The concept that does NOT transfer:** TypeScript's incremental checking uses a "semantic diagnostics" concept where changing one file invalidates diagnostics only for files in the dependency closure. This is graph-based invalidation. RFDB v2 provides the primitives (`changedFiles` + edges for the dependency graph), but the orchestrator must implement the invalidation logic. This is correctly out of RFDB's scope.

### 4.4. Recommendation: Query Composition Primitives

The current query model is sufficient for basic agent use. But to make the graph *superior* to reading code (the project vision), consider adding:

**Multi-hop query** -- A single command that does "find node X, traverse edges of type Y to depth N, return all visited nodes with their edges." Currently this requires multiple round-trips (getNode -> neighbors -> neighbors -> ...). A single `Traverse` command would reduce latency by N rounds and is the single highest-leverage improvement for AI agents.

This is listed in the existing API as `BFS`, but BFS returns only node IDs at each depth. A richer traversal that returns the full subgraph (nodes + edges) in a single call would be more useful. Think of it as "give me the neighborhood of this node" -- the most common AI agent question.

---

## 5. Scale and Performance Pragmatics

### 5.1. Is LSM-Tree the Right Architecture?

Yes. Let me explain by comparing the alternatives:

**B-tree (e.g., SQLite, Sourcetrail's approach):** Good for read-heavy workloads, poor for write-heavy bulk loading. Code analysis is fundamentally write-heavy during analysis and read-heavy during querying. A B-tree would bottleneck on the initial analysis phase. Sourcetrail's SQLite-based approach was notoriously slow for large projects.

**Pure in-memory (v1's approach):** Excellent latency, impossible to scale. 20 GB for 1.3M nodes makes 50M nodes require ~770 GB. Not viable.

**LSM-tree:** Write-optimized for bulk loading, progressively read-optimized via compaction. This matches Grafema's lifecycle perfectly: heavy writes during analysis, then background compaction, then fast reads during querying. [RocksDB](https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide) demonstrates this architecture working at much larger scales (petabytes at Facebook).

**Graph-native databases (Neo4j, JanusGraph):** Optimized for traversal but not for the columnar attribute search patterns that code analysis requires (find all nodes of type X, filter by file, scan metadata). Code analysis is more "relational with graph traversal" than "pure graph traversal." The custom LSM-tree with columnar segments is the right call.

### 5.2. Real-World Latency Requirements

For interactive AI agent use, the latency budget is roughly:
- **Point lookup:** < 1ms (agent asking "what is this function?")
- **Neighbor query:** < 5ms (agent asking "who calls this?")
- **BFS depth-3:** < 50ms (agent asking "what is the call chain?")
- **Full attribute scan:** < 100ms (agent asking "find all HTTP endpoints")
- **Datalog query:** < 500ms (agent asking "find all endpoints that bypass auth")

Based on the architecture:
- Level 0 (pre-compaction): point lookups will be 100-500 microseconds. Neighbor queries 1-5ms. Attribute scans 10-50ms. **Meets requirements.**
- Level 1+ (post-compaction): everything improves by 5-10x due to inverted indexes and global index. **Exceeds requirements.**

**The critical gap:** The time between initial analysis and compaction. During this window, the graph is at Level 0 performance. If the project is large (100K files, ~50M nodes), the initial analysis produces 300+ L0 segments. Queries during this window scan all segments without inverted indexes. For attribute searches across all shards, this could be 300 x 10KB = 3MB of columnar scans. With mmap and OS page cache, this is probably 10-50ms. Acceptable, but close to the budget.

**Recommendation:** Prioritize compaction of heavily-queried shards. After initial analysis, the orchestrator likely queries certain "hot" shards more than others (e.g., the entry-point file, shared utilities). A "priority compaction" hint from the orchestrator would help: "compact shard X first because I will query it heavily." This is a Phase 7/8 optimization, not a blocker.

### 5.3. The Missing Hot Cache Layer

The roadmap mentions Phase 8 (Resource Adaptation) but has no explicit caching strategy. The architecture relies on mmap and OS page cache for "free" caching. This is pragmatic for MVP but has a known limitation: **the OS does not know which pages are hot for your workload**. It caches based on recency, not relevance.

For a code analysis tool, the hot set is predictable:
- Bloom filters (all of them, always) -- already in RAM per the architecture. Good.
- Global index (post-compaction) -- mmap'd, OS will cache after first access. Good.
- Frequently-accessed shards (entry points, shared modules) -- OS may or may not cache these depending on memory pressure.

**Recommendation for Phase 8:** Add an explicit "pin" mechanism. The orchestrator can tell RFDB: "these shards are hot, keep them in cache." RFDB uses `madvise(MADV_WILLNEED)` or explicit memory mapping to ensure those pages stay resident. This is a single `PinShard` command on the wire protocol with trivial implementation.

At the 50M node / 350M edge scale, the total data on disk is ~25 GB. With 64 GB RAM, the entire dataset could fit in the page cache. With 8 GB RAM, only ~30% fits. The pin mechanism ensures the *right* 30% stays cached.

### 5.4. Compaction Strategy Deserves More Attention

The roadmap says compaction is "Phase 7" and "optimization, not correctness." This is true for correctness, but it is critical for *usability*. An AI agent experiencing 50ms attribute queries (Level 0) versus 1ms attribute queries (Level 1+) will have a qualitatively different experience.

From RocksDB's [tuning guide](https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide): the most impactful compaction decision is the trigger policy -- when to compact and what to compact first. A poor policy leads to write amplification (compacting too often) or read amplification (compacting too rarely).

**Recommendation:** When implementing Phase 7, study RocksDB's leveled compaction strategy. For Grafema's use case, a simple policy would be: compact a shard when it has > 5 L0 segments. This keeps the maximum read amplification at 5x (scanning 5 segments instead of 1). After compaction, the shard has 1 L1 segment with inverted indexes. Combined with the priority compaction hint from section 5.2, this gives a practical, tunable compaction strategy.

---

## 6. Additional Observations

### 6.1. Glean's Stacked Database Model -- Relevant Prior Art

[Glean's incremental indexing](https://glean.software/blog/incremental/) uses stacked immutable databases, remarkably similar to RFDB v2's immutable segments. Key lessons from Glean:

1. **Ownership propagation is expensive but necessary.** Glean tracks which "unit" (file) owns which fact, then propagates ownership through the fact graph. This is needed to determine which facts to hide when a file changes. RFDB v2 uses `file` field on nodes and `_owner` on enrichment edges -- simpler and more explicit. Good.

2. **Query overhead on stacked databases is 10-15%.** Glean measured that queries on an incremental stack (base + delta) are ~10% slower than on a single flat database, after optimizations. Expect similar overhead for RFDB v2 at Level 0 (multiple segments per shard). This validates the "compaction reduces to single segment" strategy.

3. **Ownership computation cost is language-dependent.** Glean found 2-3% overhead for Python, more for C++. RFDB v2's approach (file field is set by the analyzer, not computed) avoids this cost entirely. Good design.

### 6.2. String Interning at the Segment Level is Correct

Per-segment string tables (for names, files, types, semantic IDs) are the right granularity. A global string table would require coordination across shards during writes, defeating parallelism. Per-segment tables are independently constructible and never need updating (segments are immutable).

One suggestion: **compress the file path strings.** In a typical project, most nodes in a shard share the same file prefix (e.g., `src/controllers/auth/`). A prefix compression or dictionary encoding for file paths within a segment could reduce string table size by 50-70%. This is a Phase 0 detail worth implementing early because it affects the segment binary format, which is hard to change later.

### 6.3. The 120-Test Gate is the Right Quality Strategy

Phase 5's requirement that all ~120 existing protocol and Datalog tests pass on the v2 engine is exactly right. This is what TypeScript does on every compiler change: the entire test suite (50,000+ tests) must pass. The test suite IS the specification. Any test that fails means the new engine has a behavioral regression, not that the test is wrong.

Steve Jobs' review correctly notes that Phase 5 may be under-estimated. I agree. In my experience, making 120 existing tests pass against a rewritten engine always reveals edge cases that the architecture assumed away. Budget 2x the estimated time for Phase 5.

### 6.4. Datalog Interaction is Under-Specified

The roadmap says "Datalog engine stays as-is." But the Datalog evaluator currently operates against an in-memory HashMap. With v2, every `engine.find_by_type()` or `engine.get_node()` call goes through the segment-based query path. Two concerns:

1. **Ordering assumptions.** If Datalog rules assume `find_by_type` returns nodes in insertion order, v2 may return them in different order (segment order, not insertion order). Check the Datalog evaluator for ordering dependencies.

2. **Performance regression.** Datalog rules that do repeated `get_node()` calls in a tight loop will feel the difference between HashMap O(1) and bloom-filter-then-scan. If a Datalog rule calls `get_node()` 10,000 times, the cost goes from ~1ms (HashMap) to ~50ms (bloom filter path). This is a 50x regression that may push Datalog queries past the 500ms budget.

**Recommendation:** Profile Datalog query patterns against the v2 engine early (Phase 5, not Phase 9). If performance regressions are found, consider a Datalog-specific optimization: prefetch all nodes referenced by a Datalog rule into a local cache before evaluation. This is a one-time read of the relevant segments, amortizing the per-lookup overhead.

---

## 7. Summary of Recommendations

| # | Area | Recommendation | Priority | Phase |
|---|------|---------------|----------|-------|
| 1 | Identity | Add lazy dangling-edge detection in neighbor queries | High | 4 |
| 2 | Identity | Use content-based discriminators for anonymous/positional entities | Medium | 0 (format) |
| 3 | Identity | Document stability contract per node type (stable/semi-stable/positional) | Medium | 0 |
| 4 | Wire Protocol | Clarify edge ownership resolution across batch boundaries | High | 4 |
| 5 | Wire Protocol | Return removed node IDs (up to threshold) in CommitBatch delta | Medium | 4 |
| 6 | Wire Protocol | Make streaming opt-in per request | Low | 5 |
| 7 | Delta | Return removed node IDs for targeted re-enrichment | Medium | 4 |
| 8 | AI Queries | Add rich subgraph traversal command (nodes + edges in one call) | High | 5 |
| 9 | AI Queries | Prioritize substring/fuzzy search for AI agent experience | High | 7+ |
| 10 | Performance | Add PinShard command for explicit hot-set caching | Medium | 8 |
| 11 | Performance | Implement priority compaction hints from orchestrator | Medium | 7 |
| 12 | Performance | Compress file path strings in segment string tables | Low | 0 |
| 13 | Performance | Profile Datalog queries against v2 engine in Phase 5, not Phase 9 | High | 5 |
| 14 | Architecture | Enricher dependency ordering in orchestrator design | High | 6 (TS side) |

---

## 8. Conclusion

This is a well-designed storage engine for code analysis at scale. The core architectural decisions are sound and align with how successful systems in this space (Kythe, Glean, CodeQL) handle similar problems. The phasing is disciplined, the proof strategy is rigorous, and the scope is clearly bounded.

The semantic ID as first-class identity is the right call -- it gives you stable, human-readable, file-ownable identity that enables incremental updates. The main risk is in the discriminator scheme for anonymous entities, which I have addressed above.

The batch commit API with snapshot isolation is clean and practical. The delta information is sufficient for the storage layer, with richer information available on demand via DiffSnapshots.

For AI agent use, the latency profile is acceptable even at Level 0, and excellent post-compaction. The missing pieces are: rich subgraph traversal (reducing round-trips), substring search (matching how AI agents think), and explicit cache management (ensuring hot data stays resident).

Build it. Phase by phase. The architecture is right.

---

*Sources consulted:*
- [Kythe Storage Model](https://kythe.io/docs/kythe-storage.html) -- VName identity, fact-based graph storage
- [Kythe Schema Overview](https://kythe.io/docs/schema-overview.html) -- Cross-reference data model
- [Glean Incremental Indexing](https://glean.software/blog/incremental/) -- Stacked immutable databases, ownership propagation
- [Glean: Indexing Code at Scale (Meta Engineering)](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/) -- Production-scale code indexing
- [CodeQL Overview](https://codeql.github.com/docs/codeql-overview/about-codeql/) -- Relational extraction, TRAP files, database schema
- [Sourcetrail Architecture (DeepWiki)](https://deepwiki.com/CoatiSoftware/Sourcetrail) -- SQLite-based code graph, limitations
- [SourcetrailDB](https://github.com/CoatiSoftware/SourcetrailDB) -- Database export format for custom indexers
- [RocksDB Tuning Guide](https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide) -- LSM-tree compaction, bloom filters, mmap
- [RocksDB Bloom Filter](https://github.com/facebook/rocksdb/wiki/RocksDB-Bloom-Filter) -- Bloom filter design for point lookups
- [RocksDB File Read Latency Analysis](https://rocksdb.org/blog/2015/11/16/analysis-file-read-latency-by-level.html) -- Per-level latency measurement
- [TypeScript Language Service API](https://github.com/microsoft/typescript/wiki/using-the-language-service-api) -- Incremental program updates
- [TypeScript Compiler Notes: Glossary](https://github.com/microsoft/TypeScript-Compiler-Notes/blob/main/GLOSSARY.md) -- Symbol identity, binding, incremental parsing
- [TypeScript Binder: SymbolTable](https://basarat.gitbook.io/typescript/overview/binder/binder-symboltable) -- Declaration-based symbol identity
