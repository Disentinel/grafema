# RFDB v2 Roadmap: Expert Concerns & Recommendations

> Consolidated from: Steve Jobs, Robert Tarjan, Patrick Cousot, Anders Hejlsberg reviews
> Date: 2026-02-11
> Status: addressing one by one

---

## Critical (must address before implementation)

### C1. Guarantee check must use post-enrichment delta
**Source:** Cousot (HIGH), Hejlsberg
**Problem:** changedTypes from CommitBatch captures only the direct file-change delta. If file A changes and enrichment re-runs for file B (which depends on A), the enrichment may add/remove edges that affect guarantees about B. Using only the file-change delta misses these.
**Solution:** Guarantee selection uses union of changedTypes from ALL CommitBatches in the update cycle (file changes + enrichment changes). Sequence: CommitBatch(files) -> re-enrich -> CommitBatch(enrichment) -> check guarantees using union of both deltas.
**Decision:** [ ]

### C2. Ordering invariant: guarantees only after enrichment
**Source:** Cousot (MEDIUM), Hejlsberg
**Problem:** In watch mode, there is a window where the graph is "analyzed but not enriched" — file nodes updated but cross-file edges stale. Guarantee check in this window = false positives/negatives.
**Solution:** Epoch-based consistency or dirty flag. Orchestrator must enforce analysis-consistent state before guarantee checks.
**Decision:** [ ]

### C3. Dangling edges — graceful resolve(u128) -> None
**Source:** Tarjan, Cousot, Hejlsberg
**Problem:** When a function is deleted or renamed, edges from unchanged files point to a tombstoned node. Query engine must not return these edges as valid.
**Solution:** All traversal/query code filters edges where src OR dst is tombstoned. Lazy invalidation at query time (MVP). Enrichment eventually cleans up.
**Decision:** [ ]

### C4. Blast radius must include removedNodes
**Source:** Tarjan, Cousot
**Problem:** Current composition: DiffSnapshots + Reachability starts from modifiedNodes + addedNodes. Misses callers of *deleted* functions. Need reverse reachability from removedNodes on the *old* snapshot.
**Decision:** [ ]

---

## Important (should address in design)

### I1. Phase 5 likely under-estimated
**Source:** Steve, Hejlsberg
**Problem:** Estimated ~500 LOC for streaming + request IDs + removed commands + TypeScript client. Streaming alone could be 500 LOC. TypeScript client changes (remove metadata ID hacks, add batch/streaming/diff) deserve sub-plan.
**Decision:** [ ]

### I2. Edge ownership resolution across batch boundaries
**Source:** Steve, Hejlsberg
**Problem:** Edge ownership = src node's file. But if src node was added in a *previous* batch, RFDB needs read-during-write to find its file field.
**Solution:** During CommitBatch: (1) check current batch write buffer, (2) fall back to existing snapshot. Document as guarantee.
**Decision:** [ ]

### I3. Datalog performance — profile in Phase 5
**Source:** Hejlsberg, Steve
**Problem:** find_by_type() called 10000 times: HashMap O(1) ~1ms vs bloom filter path ~50ms. Potential 50x regression for Datalog rules with many get_node() calls.
**Solution:** Profile Datalog query patterns against v2 engine in Phase 5. If regression found, consider Datalog-specific prefetch cache.
**Decision:** [ ]

### I4. Diff "modified" detection — false positives
**Source:** Tarjan
**Problem:** intersection(removed_ids, added_ids) marks nodes as "modified" even when file re-analyzed without actual changes (same content). Content comparison needed for accuracy.
**Solution:** Compare node content (hash of all fields) to distinguish "same semantic_id, same content" from "same semantic_id, different content."
**Decision:** [ ]

### I5. Enricher dependency ordering (orchestrator concern)
**Source:** Hejlsberg
**Problem:** Enricher A produces edges of type X. Enricher B consumes edges of type X. When A's output changes, B must re-run. This second-order dependency requires topological sort of enrichers. Not RFDB's concern, but a gap.
**Solution:** Flag for orchestrator research. Enricher dependency graph = first-class concern.
**Decision:** [ ]

### I6. Semantic ID discriminator for anonymous entities
**Source:** Hejlsberg
**Problem:** Position-based discriminators (call site index, expression position) are fragile — inserting code above shifts positions. Worse: scope path contains positional discriminators (`if#0`) that **cascade to all children**, including named entities.
**Solution:** Semantic ID v2 — remove scope path from ID entirely. New format: `file->TYPE->name[in:namedParent]`. Disambiguation via content hash + counter fallback. See `007-semantic-id-stability-research.md`.
**Decision:** [x] Semantic ID v2 adopted. Breaking change, ships with RFDB v2.

### I7. Streaming should be opt-in per request
**Source:** Hejlsberg
**Problem:** 95% of AI agent queries return < 100 results. Streaming adds frame parsing overhead for small responses.
**Solution:** Default to non-streaming. Client sends `{ stream: true }` to enable chunked response. Small responses never streamed.
**Decision:** [ ]

---

## Nice to have (future consideration / Phase 7+)

### N1. Rich subgraph traversal command
**Source:** Hejlsberg
**Problem:** AI agents need "give me the neighborhood of this node" (nodes + edges) in one call. Current BFS returns only node IDs, requiring multiple round-trips.
**Solution:** `Traverse` command returning full subgraph (visited nodes + connecting edges) in single response.
**Decision:** [ ]

### N2. Substring/fuzzy search for AI agents
**Source:** Hejlsberg
**Problem:** AI agents think in natural language ("find functions related to auth"). Without fuzzy search, agents must know exact identifiers.
**Solution:** Trigram index post-MVP. Columnar scan + SIMD for MVP (already planned).
**Decision:** [ ]

### N3. PinShard command for hot caching
**Source:** Hejlsberg
**Problem:** OS page cache doesn't know which shards are hot. On 8GB machine, only ~30% of data fits in cache.
**Solution:** `PinShard` command -> `madvise(MADV_WILLNEED)`. Orchestrator hints which shards to keep resident.
**Decision:** [ ]

### N4. Priority compaction hints
**Source:** Hejlsberg
**Problem:** After initial analysis, some shards are queried heavily (entry points, shared modules). Default compaction order may not prioritize them.
**Solution:** Orchestrator tells RFDB "compact shard X first." Phase 7 consideration.
**Decision:** [ ]

### N5. File path prefix compression in string tables
**Source:** Hejlsberg
**Problem:** Most nodes in a shard share same file path prefix. Dictionary encoding could reduce string table 50-70%.
**Solution:** Implement in Phase 0 because it affects binary format (hard to change later).
**Decision:** [ ]

### N6. Configurable blast radius maxDepth per edge type
**Source:** Cousot
**Problem:** maxDepth=5 is trade-off. CALLS chains >5 are rare, but IMPORTS chains can be deep.
**Solution:** Per-edge-type depth limits. Higher for IMPORTS (cheap, bounded fan-out).
**Decision:** [ ]

### N7. CommitBatch return removed node IDs (up to threshold)
**Source:** Hejlsberg
**Problem:** Delta gives nodesRemoved as count but not which nodes. For targeted re-enrichment, knowing WHICH nodes disappeared is critical.
**Solution:** Return removed node IDs if count < 1000, otherwise count only + use DiffSnapshots.
**Decision:** [ ]

### N8. Reverse edge bloom filter per shard
**Source:** Tarjan
**Problem:** Reverse traversal (find incoming edges) requires fan-out across all shards — expensive.
**Solution:** Per-shard bloom filter on dst field of edges. Phase 7 compaction optimization.
**Decision:** [ ]

### N9. Segment pinning for long-running queries
**Source:** Tarjan
**Problem:** Long-running traversals pin old segments, causing temporary disk space amplification during compaction.
**Solution:** Document as known behavior. GC respects reader references. No fix needed, just awareness.
**Decision:** [ ]

### N10. Tagged manifests must pin their segments
**Source:** Tarjan
**Problem:** If compaction GC's old segments before DiffSnapshots query, diff fails. Tagged snapshots must retain their segments.
**Solution:** GC rule: never remove segments referenced by any tagged manifest.
**Decision:** [ ]

---

## Questions to answer before specific phases

### Q1. Target segment size range (before Phase 0)
**Source:** Steve
**Question:** L0 segments: 500-2000 nodes? Compacted: 50-100K? Nail down thresholds — they affect bloom filter sizing, string table design, boundary between "scan is fine" vs "need index."

### Q2. Streaming backpressure model (before Phase 5)
**Source:** Steve
**Question:** Client slow + RFDB sending 50K nodes in chunks. Socket buffer fills — block writer thread or buffer in memory? Neither is great. Need explicit policy.

### Q3. Orchestrator research timeline (before Phase 6)
**Source:** Steve
**Question:** Phase 6 requires parallel TS-side work. If orchestrator research not scoped yet, Phase 6 cannot complete even if Rust side is ready.

---

## Addressing log

| # | Concern | Decision | Track | Date | Notes |
|---|---------|----------|-------|------|-------|
| C1+C2 | Guarantee check timing & delta | Merged. Invariant: guarantees only after full cycle (analysis+enrichment). MVP: check all rules. Optimization: selective via changedTypes from delta (if I3 profiling shows need). RFDB always returns changedTypes in CommitBatch delta. | Track 2 (Orchestrator) | 2026-02-11 | C1 reduced to C2 — "when" matters more than "which delta" |
| C3 | Dangling edges — tombstoned nodes | Not a problem requiring special handling. (1) RFDB filters edges with tombstoned src/dst at query time — built into architecture. (2) Enrichment replaces ALL edges owned by a file on re-enrichment — old dangling edges disappear naturally. (3) If target node is tombstoned/missing, enricher doesn't create edge (optionally creates ISSUE node for unresolved reference). (4) Between tombstoning and re-enrichment, blast radius (C4) triggers re-enrichment of dependent files. No special "dangling edge handler" needed. | Track 1 (RFDB) + Track 2 (Orchestrator) | 2026-02-11 | Dangling edges = transient state, not product feature. Key mechanisms: tombstone filtering (RFDB) + edge ownership replacement (enrichment) + blast radius (orchestrator) |
| C4 | Blast radius must include removedNodes | Separation in time (TRIZ). Orchestrator queries dependents BEFORE CommitBatch, not after. Protocol: (1) before commit: query "edges where dst.file ∈ changedFiles, src.file ∉ changedFiles" → dependent files {C, D}. (2) CommitBatch (tombstones old, writes new). (3) Re-enrich {C, D, ...}. This avoids C3↔C4 contradiction: C3 filtering hides tombstoned dst edges, but pre-commit query runs on live graph where everything is visible. No special query modes, no C3 violation. File-level query, O(edges_to_changed_files). | Track 2 (Orchestrator) | 2026-02-11 | Cousot verified: post-commit query unsound for deleted/renamed entities (C3 hides exactly the edges C4 needs). Pre-commit query resolves contradiction cleanly. |
| I1 | Phase 5 under-estimated | Addressed by Track 3 (TS RFDB Client v3). Phase 5 scope will be decomposed into sub-tasks during Track 3 detailed design. | Track 3 (Client) | 2026-02-11 | Not an architectural concern — scoping issue resolved by parallel track |
| I2 | Edge ownership across batch boundaries | Solved by partition key design. Enrichment edges use composite file context: `__enrichment__/{enricher}/{source_file}`. Ownership = shard = file context string. No read-during-write needed — RFDB doesn't look up src.file, it uses the CommitBatch's file context. Analysis shards (`app.ts`) and enrichment shards (`__enrichment__/calls/app.ts`) don't collide. Granular re-enrichment: replace one enricher's edges for one file without touching anything else. 17K virtual files for 17 enrichers × 1000 files — LSM compaction handles naturally. | Track 1 (RFDB) contract | 2026-02-11 | Model 3 chosen over: Model 1 (analysis↔enrichment collision, needs layers) and Model 2 (no per-file granularity, can't incrementally re-enrich) |
| I3 | Datalog performance — find_by_type() | Per-segment zone maps in segment footer (Phase 0). Each segment stores set of distinct values per key field (nodeType, type, file). Query skips segments that can't contain target value → eliminates 90%+ of scan. Zone maps: built at segment write time (free), stored in footer (bytes, not MB), immutable, mmap'd. If insufficient after Phase 5 profiling → built-in secondary index as separate segment type (not RocksDB — avoid LSM-in-LSM). Zone maps are the columnar DB approach (Parquet/DuckDB row group statistics). | Track 1 (RFDB) Phase 0 | 2026-02-11 | Full in-memory index rejected: 8MB per field per 500K nodes, doesn't scale. Zone maps = right level of abstraction. |
| I4 | Diff "modified" false positives | Two-level content hash per node. (1) **fieldHash** (u64): hash of DB fields (name, type, metadata, etc.) — computed by RFDB at write time. Detects field-level changes. (2) **contentHash** (u64): hash of source text span — computed by ANALYZER, sent as node field. Detects body/semantic changes even when DB fields are identical. Diff logic: same semanticId + same contentHash = unchanged. contentHash changed + children/edges unchanged = **analyzer coverage canary** — either non-semantic change (whitespace) or analyzer gap. Safe action: treat as modified (over-approximate). Diagnostic value: "content changed but analysis unchanged" = signal to improve analyzer coverage. Cost: 16 bytes per node. Phase 0 format decision. | Track 1 (RFDB) Phase 0 + Track 2 (Orchestrator) | 2026-02-11 | contentHash serves dual purpose: precision blast radius + analyzer coverage quality metric. Domain logic ("what is content") stays in analyzer, RFDB stays generic. |
| I5 | Enricher dependency ordering | Track 2 concern. Enricher dependency graph is first-class orchestrator concept. Current orchestrator already toposorts enrichers. For incremental re-enrichment: if enricher A's output changes, enricher B (consuming A's output) must re-run. RFDB provides the data (edge delta per enricher shard via I2 composite file context), orchestrator owns the logic. | Track 2 (Orchestrator) | 2026-02-11 | RFDB is agnostic to enrichers — they're just CommitBatch clients with different file contexts. |
| I6 | Semantic ID discriminator for anonymous entities | **Semantic ID v2 adopted** (see `007-semantic-id-stability-research.md`). Root cause: scope path in ID (`if#0->for#1->`) causes cascading instability — adding an if-block changes IDs of ALL children including named entities. Solution (TRIZ: separate identity from address): remove scope path from ID entirely. New format: `file->TYPE->name[in:namedParent]` where namedParent = nearest named function/class. Disambiguation: content hash `[in:parent,h:xxxx]` for collisions (99.9%), counter `#N` only for identical-content leaf duplicates (no cascade). `[in:]` always present, uniform format. Breaking change — requires full re-analysis, aligns with RFDB v2 migration. `stability_tier` metadata no longer needed. | Track 2 (Analyzer) | 2026-02-11 | Cascading instability discovered and eliminated. All nodes effectively Tier 1-2 stability. |
| I7 | Streaming opt-in per request | Track 3 (Client protocol). Default: non-streaming (single response). Opt-in: `{ stream: true }` for large result sets. Non-streaming for: node lookups, enricher queries, guarantee checks, CommitBatch delta, blast radius, Datalog rules. Streaming for: find_by_type on common types (100K+), deep BFS traversal, DiffSnapshots on major refactors, export/backup, unbounded AI agent queries. Auto-fallback: RFDB switches to streaming if result exceeds threshold (e.g., 1000 items) even without opt-in — client gets `streaming: true` header, OOM protection. | Track 3 (Client) | 2026-02-11 | 95% of queries = non-streaming. Streaming = safety valve for large results. |
| N1 | Rich subgraph traversal command | Phase 7+. `Traverse` command: input = start node + depth + edge type filters. Output = full subgraph (visited nodes with all fields + connecting edges) in single response. Use case: AI agent asks "show me the neighborhood of function X" — gets nodes + edges in one call instead of BFS → IDs → batch get (2 round-trips). MVP workaround: BFS returns IDs, client does batch GetNode. Traverse is optimization that eliminates round-trip. Combine with streaming (I7) for large subgraphs. | Phase 7+ | 2026-02-11 | Nice UX optimization for AI agents. Not a blocker — MVP workaround exists. |
| N2 | Substring/fuzzy search for AI agents | Phase 7+. **Trigram index** on `name` field: breaks strings into 3-char grams, builds inverted index gram → node IDs. Query "auth" → trigrams ["aut","uth"] → intersection of posting lists → candidate nodes → verify. Enables: `search("auth")` returns `authenticate`, `authMiddleware`, `isAuthorized`. MVP workaround: columnar scan of `name` field + SIMD string matching (zone maps from I3 help skip irrelevant segments). Trigram index = persistent structure, built during compaction. Size: ~2x name field size. Implementation: Phase 7 compaction feature. | Phase 7+ | 2026-02-11 | Critical for AI agent UX — agents think in natural language. MVP scan is acceptable for <100K nodes. |
| N3 | PinShard command for hot caching | Phase 7+. `PinShard { file: "src/app.ts" }` → RFDB calls `madvise(MADV_WILLNEED)` on segment pages for that shard. OS pre-faults pages into memory. Use case: orchestrator knows which files are entry points / frequently queried → hints RFDB to keep them hot. Without this: OS page cache evicts based on LRU, not domain importance. On 8GB machine with 4GB graph, only ~50% fits in cache. With pinning: hot shards always resident, cold shards evicted. Implementation: segment-level `madvise` call, orchestrator sends hints after initial analysis. | Phase 7+ | 2026-02-11 | Performance optimization for large codebases. Not needed until graph exceeds available RAM. |
| N4 | Priority compaction hints | Phase 7+. `CompactPriority { file: "src/app.ts", priority: HIGH }` → RFDB prioritizes compacting this shard's segments first. Use case: after initial analysis, entry point shards have many L0 segments (lots of writes). Query performance degrades with many segments. Orchestrator hints "compact these first." Default compaction: by segment count or size. Priority compaction: domain-aware ordering. Implementation: priority queue in compaction scheduler. | Phase 7+ | 2026-02-11 | Compaction optimization. Default strategy sufficient for MVP. |
| N5 | File path prefix compression in string tables | **Not needed in Phase 0.** In file-scoped shards, `file` field has ONE unique value per shard — standard string table dedup handles this (store once, reference N times). Other string fields (nodeType, type, name, metadata) don't have meaningful shared prefixes. Prefix compression only helps after compaction (Phase 4+) when segments from different files merge and multiple file paths appear in one segment. Compacted segments are written from scratch → can use enhanced format without breaking Phase 0 format. No format reservation needed. | Phase 4+ (compaction) | 2026-02-11 | Original concern assumed multi-file segments. With file-scoped shards (I2 decision), prefix compression is a compaction-time optimization, not a format constraint. |
| N6 | Configurable blast radius maxDepth per edge type | Phase 7+. Current: uniform maxDepth=5 for all edge types. Problem: CALLS chains rarely exceed 5, but IMPORTS chains can be 10+ deep (re-exports, barrel files). Solution: per-edge-type depth config: `{ CALLS: 5, IMPORTS: 15, DEPENDS_ON: 3 }`. Implementation: blast radius query accepts depth map, BFS respects per-type limits. Also useful: edge type weights (IMPORTS = cheap/bounded fan-out, CALLS = expensive/wide fan-out). | Phase 7+ (Track 2) | 2026-02-11 | Precision tuning for blast radius. Uniform depth is acceptable for MVP. |
| N7 | CommitBatch return removed node IDs | **Phase 2-3 (with CommitBatch).** Delta always returns full list of removed node semantic IDs (strings). No threshold — CommitBatch is file-scoped (I2), one file = 10-500 nodes max, removed count naturally bounded. For extreme cases, streaming (I7) as fallback. Implementation: during tombstoning, collect semantic IDs of old nodes not matched by new nodes. Low cost — already iterating old nodes during diff. **Connects to C4**: pre-commit blast radius query needs to know which nodes will be removed → this data available during CommitBatch processing. | Phase 2-3 | 2026-02-11 | Threshold removed — file-scoped batches naturally bound response size. |
| N8 | Reverse edge bloom filter per segment | **Phase 0 (include in format).** Per-segment bloom filter on `dst` field of edges, stored in segment footer alongside existing `src` bloom. Required for C4 blast radius hot path: pre-commit query "edges where dst.file = B" runs on fresh L0 segments immediately after CommitBatch. Without dst bloom → full scan of all edge segments. With dst bloom → skip 95%+ segments. Unlike N5 (prefix compression), this cannot wait for compaction — L0 segments need it too. Implementation: built during segment write (same as src bloom). Size: ~1KB per segment. Cost: minimal — already building src bloom in same pass, dst bloom is parallel construction. | Phase 0 | 2026-02-11 | Promoted from nice-to-have. C4 blast radius depends on reverse edge lookup being fast on fresh segments. |
| N9 | Segment pinning for long-running queries | Document as known behavior. Long BFS/traversal pins old segments via reader reference count. Compaction cannot GC pinned segments → temporary disk space amplification. Not a bug — LSM standard behavior. Mitigation: query timeout (10 min max per CLAUDE.md). If query finishes, segments unpin, GC proceeds. No code change needed, just documentation. | N/A (document) | 2026-02-11 | Known LSM behavior. Document in RFDB ops guide. |
| N10 | Tagged manifests must pin their segments | **Phase 3 GC design requirement.** Not a standalone concern — part of TagSnapshot definition of done. GC implementation depends on phase: Phase 0-2 (no tagged snapshots) = simple "remove segments not in current manifest." Phase 3 (TagSnapshot) = GC must respect multiple manifests. Two approaches: (a) ref-counting per segment (refcount=0 → eligible for GC), (b) manifest scan (union of all tagged manifest segments → exclude from GC). Choice depends on expected number of tagged snapshots — few = scan is fine, many = ref-counting. Design decision deferred to Phase 3. | Phase 3 (with TagSnapshot) | 2026-02-11 | Not a separate concern — GC design naturally handles this when snapshots are introduced. |
| Q1 | Target segment size range | L0 segments: file-scoped (I2), size determined by file content — not configurable. Small file (10 nodes) = small segment, large file (2000 nodes) = large segment. Compacted segments: target size is a tuning parameter. Typical LSM: 2MB-64MB. For RFDB: 10K-100K nodes per compacted segment — depends on average node size. Affects bloom filter FPR, zone map selectivity, read amplification. **Concrete numbers determined by benchmarks in Phase 4 (compaction).** Phase 0: no compaction, L0 only, size = file. | Phase 4 (benchmarks) | 2026-02-11 | L0 size is data-driven, not configurable. Compacted segment size = tuning parameter for Phase 4. |
| Q2 | Streaming backpressure model | Track 3 (Client protocol), Phase 5. Standard approach: TCP backpressure via Unix socket buffer. When client is slow: socket buffer fills → RFDB write() blocks → writer task yields (async runtime handles this). No buffering in RFDB memory — OS socket buffer is the buffer. Policy: if client doesn't read for N seconds → abort stream, log warning. Design detail for Track 3 streaming spec. | Track 3, Phase 5 | 2026-02-11 | Standard TCP backpressure. Not a blocker for Phase 0-4. |
| Q3 | Orchestrator research timeline | Resolved by parallel tracks decision. Track 2 (Orchestrator v2) runs parallel to Track 1 (RFDB v2). Phase 6 (enrichment contract) depends on both tracks reaching sufficient maturity. Track 2 design doc (`005-orchestrator-design.md`) to be written as next deliverable. | Track 2 | 2026-02-11 | Already addressed by 3-track parallel structure. |
