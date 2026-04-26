# Steve Jobs Review: RFDB v2 Roadmap

**Verdict: APPROVE**

---

## Vision Alignment

This roadmap is the single most important piece of work for Grafema's future. The project vision is "AI should query the graph, not read code." But right now, the graph falls over at 2,500 files with 20 GB of RAM and 5-minute flushes. That is not a graph worth querying. It is a liability.

The v2 architecture directly enables everything we need:
- **Massive legacy codebases** (the target) require 50M-500M nodes. v1 cannot even handle 1.3M without collapsing. v2 with O(metadata) RAM and disk-backed columnar segments makes this physically possible.
- **Watch mode / incremental updates** are table-stakes for developer workflow. v1 requires full graph reload. v2 with tombstones + batch commit + snapshot isolation enables O(changed_file) updates.
- **Snapshot diffing** tied to git commits enables "what changed between these two commits?" queries. This is exactly the kind of question that makes the graph superior to reading code.
- **Semantic ID as first-class citizen** eliminates the identity crisis (4 different ID representations) that causes metadata bloat and round-trip fragility.

This is not an optimization. This is removing the single biggest obstacle between Grafema and its reason for existing.

## Architecture Checklist

### 1. Complexity Check

**PASS.** The architecture is methodical about avoiding O(total_graph) operations:

- Point lookups: bloom filter O(shards) at Level 0, O(log N) global index post-compaction. Not O(N).
- Attribute search: manifest stats prune irrelevant shards, then columnar scan of matching segments only. Not scanning all nodes.
- Neighbors: bloom filter on edge segments narrows to relevant shards. Not scanning all edges.
- Re-analysis: O(file_nodes) via tombstone + new segment. Not O(total_nodes).
- Batch commit: RFDB groups by file field, tombstones per-file. O(batch_size), not O(graph).
- CommitBatch delta: computed from manifest diff (set difference of segment lists), not node-by-node comparison.

The only O(N)-over-all-nodes operation is compaction, and that runs in the background, does not block readers, and is explicitly marked as "optimization, not correctness." Correct design.

### 2. Plugin Architecture

**PASS.** Forward registration everywhere:

- Analyzers produce nodes with `file` field. RFDB groups by file automatically. No backward scanning.
- Enrichers produce edges with `_owner` metadata. RFDB routes to virtual shards. Forward registration.
- Selector/Processor contract: enricher declares its input types (forward), orchestrator feeds matching nodes. Enricher never scans the graph looking for patterns.
- CommitBatch returns `changedNodeTypes`/`changedEdgeTypes` -- the delta tells the orchestrator which enrichers to re-run. This is forward propagation of change information, not backward scanning to discover what changed.

### 3. Extensibility

**PASS.** Adding support for a new framework/library requires:
- New analyzer plugin (produces nodes with appropriate types and `file` field). No changes to RFDB.
- New enricher plugin (declares input types via Selector, implements Processor). No changes to RFDB.
- RFDB storage, sharding, compaction, queries -- all unchanged. They operate on generic nodes/edges.

The enrichment virtual shard model is particularly clean: `__enrichment__/{enricher_name}/` means RFDB treats enricher output exactly like analysis output. One infrastructure for everything.

### 4. No Brute-Force

**PASS.** Every query path has a targeted access pattern:
- Point lookup: bloom filter skip, then binary search within segment.
- Type query: manifest stats prune shards that don't contain the type, then columnar scan or inverted index.
- Neighbors: bloom filter on src/dst in edge segments.
- Diff: manifest comparison (which segments changed), not node-by-node diff.

No operation requires scanning all nodes or all edges. The design is structurally incapable of brute-force at the query level.

## What's Right

**1. The phasing is correct.** Each phase builds on proven foundations:
- Phase 0 (segment format) has zero dependencies and can be tested in total isolation with property-based tests. This is the atomic building block.
- Phase 5 (wire protocol integration) is the hard gate: all ~120 existing tests must pass. This is the moment of truth, and the roadmap calls it out explicitly.
- Phases 6-8 (enrichment, compaction, resources) are enhancements to a working system, not prerequisites for correctness.

**2. The proof strategy is rigorous.** Every phase has concrete, testable correctness criteria:
- Property-based tests for segment roundtrip (proptest -- any Vec<NodeRecord> survives write/read).
- Equivalence tests against v1 (same data, same query results).
- Crash simulation for atomic manifest swap.
- Real codebase validation at Phase 9 (the ultimate proof).

This is not "we'll test later." This is "we prove each layer before building the next."

**3. The ID unification is overdue and exactly right.** The current system has 4 ID representations plus `_origSrc`/`_origDst` metadata duplication. ~30-40% of metadata is identity garbage. Making semantic_id a first-class columnar field, with u128 as a derived index, eliminates all of this. Clean, correct, no ambiguity about what THE identity is.

**4. Batch commit is the right abstraction.** The client sends AddNodes/AddEdges (which already have `file` field). RFDB handles file grouping, edge ownership, tombstoning, and atomic manifest swap internally. The client does not know about shards, segments, or manifests. This is a genuinely clean API boundary -- the "black box principle" is the right call.

**5. Snapshot versioning replaces per-node mutation.** Immutable segments cannot support per-node `UpdateNodeVersion`. The snapshot chain (manifest v42 -> v43) IS the version history. DiffSnapshots computes the delta from manifest comparison. No extra storage. Tags tie snapshots to git commits. This composes beautifully with blast radius analysis: DiffSnapshots + Reachability = blast radius, from existing primitives. No dedicated "blast radius" command needed.

**6. The scope is clearly bounded.** The "What We're NOT Building" section is explicit: no multi-machine sharding, no WAL, no Cypher, no orchestrator redesign within this track. Each exclusion has a reason. This discipline prevents scope creep.

**7. The backward compatibility story is credible.** AddNodes/AddEdges without BeginBatch = implicit auto-commit. No requestId = FIFO matching. Legacy clients (protocol v1) continue working. The migration is not a flag day.

## What's Wrong / Concerning

**1. The roadmap is silent on time estimates.** The "rough estimates, NOT commitments" table gives LOC counts and test counts but no duration. I understand the user request said "no rush, no deadline pressure" -- and that is correct. But there is a difference between "no artificial deadline" and "no estimate at all." Nine phases at roughly 1500-2000 LOC per serious phase, each requiring tests-first and proof-of-correctness, is substantial. Are we talking 3 months? 6 months? A year? The team should have a rough sense of cadence even without pressure. This is not a blocking concern -- it is a planning gap.

**2. Phase 5 is load-bearing but under-specified.** This is THE critical gate ("all ~120 existing tests pass"), and it is estimated at only ~500 LOC of refactoring with 0 new tests (relying on existing). But it also introduces request IDs, streaming responses, DiffSnapshots wire protocol, and the removal of 3 commands (GetAllEdges, UpdateNodeVersion, DeleteNode/DeleteEdge). That is a lot of surface area for "~500 LOC refactor." The streaming implementation alone (chunked responses with `{ chunk, done }` frames, client reassembly, backpressure) could easily be 500 LOC by itself. I suspect this phase is under-estimated. Not a reason to reject, but flag it for re-estimation when Phase 4 completes.

**3. The TypeScript client changes are mentioned but not phased.** The roadmap says "Updated TypeScript RFDBClient (batch commit, streaming, diff methods)" and "Updated TypeScript RFDBServerBackend (no more metadata ID hacks)" in Phase 5 deliverables. But the TS client is a separate codebase with its own test suite, and the changes are nontrivial (removing all `originalId`/`_origSrc`/`_origDst` metadata hacking, adding batch commit API, adding streaming support). These deserve their own sub-plan within Phase 5, not a bullet point.

**4. The enrichment virtual shard model (Phase 6) depends on orchestrator changes that are explicitly out of scope.** The architecture doc says "Orchestrator redesign -- separate research." The roadmap's Phase 6 says "This phase requires parallel work on the TypeScript orchestrator side (separate research)." But the Selector/Processor contract is fundamental to incremental enrichment. If the orchestrator research concludes that a different contract is needed, Phase 6's Rust-side work could need rework. This is a risk, not a flaw -- but it should be acknowledged more prominently.

**5. No mention of how Datalog interacts with the new engine.** The roadmap says "Datalog engine stays as-is." But the Datalog evaluator currently calls `engine.find_by_type()`, `engine.get_node()`, `engine.neighbors()`, etc. These methods will have different performance characteristics in v2 (bloom filter checks, segment scans vs. HashMap lookups). Is the Datalog evaluator still correct when `find_by_type` returns results from multiple segments in arbitrary order? Are there ordering assumptions? The Datalog tests are part of the ~120 test suite, so they should catch regressions -- but this implicit dependency deserves a note.

## Questions That Must Be Answered

**Before Phase 0 begins:**
1. What is the target segment size range? The architecture doc mentions "500-2000 nodes" for Level 0 segments and "50-100K+" for compacted segments. The roadmap should nail down these thresholds (even if adaptive) because they affect bloom filter sizing, string table design, and the boundary between "columnar scan is fine" and "need inverted index."

**Before Phase 4 begins:**
2. How does RFDB determine "edge ownership" for edges that cross file boundaries within a single AddEdges call? The roadmap says "edge owned by src node's file." But what if the src node was added in a previous batch and its file field is not in the current batch's write buffer? RFDB needs to look up the src node to determine its file. Is this a read-during-write? How does this interact with snapshot isolation?

**Before Phase 5 begins:**
3. What is the streaming backpressure model? If the client is slow and RFDB is sending 50K nodes in chunks, what happens when the Unix socket buffer fills? Does RFDB block the writer thread? Does it buffer in memory (defeating the purpose of streaming)?

**Before Phase 6 begins:**
4. Has the orchestrator research started? Phase 6 explicitly requires parallel TS-side work. If that work is not yet scoped, Phase 6 cannot be completed even if the Rust side is ready. What is the plan?

## Final Assessment

This roadmap is RIGHT. Not just "good enough" -- it is the correct architecture for Grafema's scale ambitions, properly phased, with honest proof strategies at every layer.

The research is thorough (Iceberg, LSM-tree, BACH, TAO, NebulaGraph, LiveGraph -- all the right references). The design decisions are grounded in real measurements (20 GB RAM, 4 root causes, per-record byte calculations). The phasing respects dependencies and puts the hardest gate (Phase 5: all existing tests pass) at exactly the right point.

The concerns I raised are real but not blocking:
- Time estimates are a planning gap, not an architecture gap.
- Phase 5 may be under-estimated, but the gate criterion (existing tests pass) will force correctness regardless.
- TypeScript client changes need a sub-plan, but the Rust architecture does not depend on them.
- Orchestrator research for enrichment is a risk that the team is already aware of.
- Datalog interaction is covered by existing tests.

I approve because:
1. The architecture directly serves the vision (massive legacy codebases, O(metadata) RAM, incremental updates).
2. The phasing is sound (each layer proven before building the next).
3. The proof strategy is rigorous (property-based tests, equivalence tests, real codebase validation).
4. The scope is bounded (explicit "not building" list).
5. The backward compatibility is credible (existing protocol preserved).
6. There are no "MVP limitations" that defeat the purpose. Every phase delivers real, usable capability. Phase 5 is the first externally useful checkpoint, and it requires ALL existing tests to pass -- no half-measures.

Ship this. Phase by phase. Prove each layer. Do not rush.
