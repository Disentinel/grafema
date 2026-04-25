# RFDB v2: Static Analysis & Dataflow Soundness Review

> Author: Patrick Cousot (consulting)
> Date: 2026-02-11
> Input: 002-roadmap.md, rfdb-v2-architecture-final.md, Grafema codebase
> Scope: Incremental analysis soundness, snapshot isolation, Datalog over sharded storage, tombstone semantics, change blast radius

---

## Executive Summary

The RFDB v2 architecture is a well-designed storage layer rewrite. The LSM-tree with immutable segments, snapshot isolation via atomic manifest swap, and tombstone-based incremental updates are all sound engineering choices. However, the **boundary between RFDB (storage) and the orchestrator (analysis logic)** is where the critical soundness questions live. RFDB v2 provides correct storage primitives, but the **orchestrator's use of those primitives** determines whether incremental analysis is sound.

I identify five areas requiring formal attention, ordered by risk:

1. **Transitive dependency re-checking** -- the most significant soundness gap (HIGH risk)
2. **Enrichment-guarantee ordering** -- subtle but important consistency window (MEDIUM risk)
3. **Datalog evaluation over sharded storage** -- requires interface adaptation but is fundamentally tractable (LOW risk)
4. **Tombstone semantics for dataflow chains** -- sound under stated assumptions, with caveats (LOW risk)
5. **Change blast radius correctness** -- sound over-approximation with known limitations (LOW risk)

---

## 1. Incremental Analysis Soundness

### 1.1. The Proposed Mechanism

From Phase 4 of the roadmap:

```
CommitBatch returns:
  changedNodeTypes: set of node types in delta
  changedEdgeTypes: set of edge types in delta

Orchestrator:
  changedNodeTypes ∩ rule_dependencies → which guarantees to re-check
```

The question: **Is this sound? Can we miss violations?**

### 1.2. Formal Model

Let us define the problem precisely.

Let G be the program graph, R = {r_1, ..., r_k} be the set of guarantee rules. Each rule r_i has a set of **type dependencies** deps(r_i) -- the node and edge types it queries. A rule r_i is a Datalog query over G that returns violations.

After a file change, a new graph G' is produced. The delta is:

```
delta = (addedNodes, removedNodes, modifiedNodes, addedEdges, removedEdges)
changedTypes = {type(n) | n in addedNodes U removedNodes U modifiedNodes}
             U {type(e) | e in addedEdges U removedEdges}
```

The proposed incremental strategy: re-evaluate r_i if and only if `deps(r_i) ∩ changedTypes != {}`.

**Claim:** This is sound for rules whose dependencies are **fully captured by type information**.

**Proof sketch:** If deps(r_i) ∩ changedTypes = {}, then no node or edge of a type mentioned in r_i has changed. Since r_i can only bind variables to nodes/edges of types in deps(r_i), and none of those changed, the result set of r_i on G' equals its result set on G. Therefore, no new violations can appear and no existing violations can disappear.

### 1.3. The Transitive Dependency Problem (SOUNDNESS GAP)

**This analysis is incomplete.** Consider the following scenario:

```
Guarantee rule:
  violation(X) :- node(X, "http:handler"), \+ edge(X, _, "VALIDATES_INPUT").

Enrichment creates VALIDATES_INPUT edges based on import resolution.
```

Now suppose file A changes. The orchestrator:
1. Re-analyzes file A (tombstones old nodes, creates new)
2. CommitBatch returns changedNodeTypes = {"FUNCTION", "VARIABLE"}
3. The guarantee rule depends on {"http:handler", "VALIDATES_INPUT"}
4. changedTypes ∩ deps(rule) = {} ... so the rule is NOT re-checked

**But:** File B imports a validator from file A. The import resolution enricher needs to re-run for file B. If it does, it might produce (or remove) a VALIDATES_INPUT edge for an http:handler in file B. That guarantee violation in file B would be **missed**.

This is the classic **transitive dependency** problem in incremental analysis. The roadmap acknowledges this implicitly in the enrichment re-run logic (Section 5.3 of the architecture, step 7), but the guarantee checking in Phase 4 uses only the **direct delta from CommitBatch**, not the **post-enrichment delta**.

### 1.4. Comparison with Prior Art

**Facebook Infer** solves this via [compositional analysis](https://cacm.acm.org/research/scaling-static-analyses-at-facebook/): each procedure is analyzed independently, producing a summary. When a procedure changes, only its direct callers need re-analysis (one level), because summaries abstract away transitive dependencies. This is sound because the summary contract is the abstraction boundary.

**IncA** ([Incremental whole-program analysis in Datalog with lattices](https://dl.acm.org/doi/10.1145/3453483.3454026)) takes a different approach: it tracks fine-grained dependencies at the Datalog tuple level. When a base fact changes, only the derived tuples that depend on it (transitively through the derivation tree) are invalidated. This gives optimal incrementality but requires instrumentation of the Datalog evaluator itself.

**DDlog** ([Differential Datalog](https://github.com/vmware-archive/differential-datalog)) automates incremental maintenance using differential dataflow, where both additions and deletions propagate automatically through the rule evaluation. This handles transitive dependencies by construction.

Grafema's current approach is **coarser than all three**: it tracks dependencies at the type level, not at the tuple or procedure level. This is a pragmatic choice (simple, fast), but it means soundness depends on the orchestrator correctly computing the **full transitive closure** of changes before checking guarantees.

### 1.5. Formal Requirement

For soundness, the guarantee check must happen **after** all enrichment re-runs triggered by the change. The correct sequence is:

```
1. CommitBatch(file changes) -> delta_1 (direct changes)
2. Re-enrichment(delta_1)    -> delta_2 (enrichment changes)
3. CommitBatch(enrichment)   -> delta_3 (enrichment delta)
4. Check guarantees where deps ∩ (changedTypes(delta_1) U changedTypes(delta_3)) != {}
```

**The changedTypes for guarantee checking must include both the file-change delta AND the enrichment delta.** The roadmap's Phase 4 description is ambiguous about this -- it mentions `changedNodeTypes` from CommitBatch but does not explicitly state that the enrichment delta is also fed into guarantee selection.

### 1.6. Is This a Monotone Framework?

Strictly speaking, no. A monotone framework (in the sense of Kildall/Kam-Ullman) requires that:
- The analysis domain is a lattice
- Transfer functions are monotone on that lattice
- The solution is the least fixed point

Grafema's guarantee system is **not computing a fixed point**. It evaluates Datalog queries over a materialized graph. The graph itself is the "solution" -- it is not iteratively refined. What changes is the graph state (via file changes + enrichment), and guarantees are re-checked on the new state.

This is closer to a **demand-driven recomputation** model (cf. [Demanded Abstract Interpretation](https://manu.sridharan.net/files/PLDI21Demanded.pdf)): guarantees are queries evaluated on demand over the current graph state. Soundness then reduces to: "is the graph state complete when guarantees are checked?"

**Recommendation:** The graph state is "complete" only after enrichment. Document and enforce this ordering invariant in the orchestrator.

---

## 2. Snapshot Isolation vs Analysis Consistency

### 2.1. The Consistency Window

The roadmap defines clear snapshot isolation semantics:

```
Before commit() -> readers see previous consistent snapshot
After commit()  -> readers see new consistent snapshot
Between         -> impossible (atomic manifest swap)
```

This is correct for RFDB as a storage layer. But the **analysis pipeline** has multiple phases:

```
ANALYSIS (per-file) -> ENRICHMENT (cross-file) -> VALIDATION (guarantees)
```

The question: **Can a guarantee check run on a partially-enriched graph?**

### 2.2. Current Orchestrator Behavior

Looking at the current `Orchestrator.run()` in `packages/core/src/Orchestrator.ts`:

```typescript
// PHASE 2: ANALYSIS
await this.runPhase('ANALYSIS', ...);

// PHASE 3: ENRICHMENT
await this.runPhase('ENRICHMENT', ...);

// PHASE 4: VALIDATION
await this.runPhase('VALIDATION', ...);

// Flush
await this.graph.flush();
```

Phases are strictly sequential. VALIDATION (which includes guarantee checks) runs only after all enrichment is complete. This is sound for the **batch analysis** case.

### 2.3. The Watch Mode Problem

In watch mode (real-time), the architecture describes:

```
File changed
  -> RE-ANALYSIS -> tombstones + new segment
  -> INCREMENTAL RE-ENRICHMENT -> affected nodes only
  -> QUERY immediately (L0 scan, skip tombstones)
```

The risk: if a user (or AI agent) queries the graph **between re-analysis and re-enrichment**, they see a state where:
- File A's nodes are updated (new analysis)
- But cross-file edges from/to A are stale (old enrichment)

This is an **analyzed but not enriched** window. Snapshot isolation guarantees that the graph is atomically consistent at the storage level, but it does not guarantee **semantic** consistency (analysis + enrichment being in sync).

### 2.4. Analysis

There are two views on this:

**Pragmatic view:** This is acceptable for interactive queries. The user is querying an evolving graph; staleness is expected. The graph is always eventually consistent (after enrichment catches up).

**Formal view:** Any guarantee checked in this window may produce false positives or false negatives. A guarantee that checks for cross-file edges (e.g., "every export has a matching import") would see stale data.

### 2.5. Recommendation

Define two levels of graph consistency:

1. **Storage-consistent**: RFDB guarantee. Reads see a complete, non-torn snapshot. Always true.
2. **Analysis-consistent**: Orchestrator guarantee. All enrichment has been applied for the current analysis version. True only after enrichment completes.

For guarantee checking, the orchestrator MUST ensure analysis-consistency. Options:

- **Epoch-based**: Each CommitBatch + re-enrichment cycle produces an "epoch". Guarantees are only checked at epoch boundaries.
- **Dirty flag**: The orchestrator tracks whether enrichment is pending. Guarantee checks refuse to run (or warn) if enrichment is stale.
- **Batched updates**: In watch mode, debounce file changes and commit analysis + enrichment as a single logical operation before allowing guarantee checks. The roadmap already mentions debouncing; tie it to the consistency model.

---

## 3. Datalog over Sharded Storage

### 3.1. Current Datalog Implementation

The current Datalog evaluator in `packages/rfdb-server/src/datalog/eval.rs` operates directly on the `GraphEngine`:

```rust
pub struct Evaluator<'a> {
    engine: &'a GraphEngine,
    rules: HashMap<String, Vec<Rule>>,
}
```

Built-in predicates like `node(X, Type)` call `self.engine.find_by_type()`, which currently scans an in-memory `type_index` HashMap. The evaluator uses a standard left-to-right, top-down evaluation with conjunction unfolding -- essentially a nested-loop join with early termination.

### 3.2. Impact of v2 Sharded Storage

With v2, `find_by_type()` becomes a multi-shard query:
1. Check manifest stats to prune shards without the requested type
2. For each matching shard: bloom filter check, then columnar scan (L0) or inverted index (L1+)
3. Merge results from all shards

**Key question:** Does this break Datalog's fixed-point semantics?

**Answer: No.** Grafema's Datalog evaluator does **not** compute a fixed point in the traditional sense. It does not use semi-naive evaluation or iterative stratification. It evaluates queries by directly scanning the graph (the `node`, `edge`, `attr` predicates are direct lookups, not derived). User-defined rules are evaluated by expanding rule bodies, which recursively call built-in predicates.

The `path` predicate (reachability) is the closest thing to a fixed-point computation, and it uses BFS internally via `GraphEngine`, not Datalog iteration.

Therefore, the Datalog evaluator needs no algorithmic changes. It needs only an **interface guarantee**: that `find_by_type()`, `get_node()`, `get_outgoing_edges()`, etc., return complete, consistent results regardless of internal sharding.

### 3.3. Negation and Stratification

The evaluator supports negation (`\+` in Datalog syntax, `Literal::Negative` in code):

```rust
Literal::Negative(atom) => {
    let results = self.eval_atom(&substituted);
    if results.is_empty() {
        next.push(bindings.clone());
    }
}
```

This is **negation-as-failure**, evaluated inline. It is sound as long as:
1. All variables in the negated atom are bound (safety condition) -- the evaluator substitutes from current bindings
2. The query to the negated atom sees a complete snapshot

Condition (2) is guaranteed by snapshot isolation: within a single query, all reads go to the same manifest version. Sharding does not affect this because the manifest is the single source of truth for "which segments are active."

**No stratification changes needed.** The current evaluator does not use stratified evaluation (it evaluates negation inline during left-to-right evaluation), and sharding does not change this.

### 3.4. Performance Concerns

The real concern is not correctness but **performance**. Consider:

```
violation(X) :- node(X, "http:handler"), \+ edge(X, _, "VALIDATES_INPUT").
```

Step 1: `node(X, "http:handler")` -- find all nodes of type "http:handler". With sharding, this fans out to all shards containing this type. Manifest stats pruning limits this to relevant shards.

Step 2: For each binding of X, `edge(X, _, "VALIDATES_INPUT")` -- check outgoing edges. This is a point query per X, which uses bloom filters.

With v2, step 1 may incur more I/O (multiple segment reads vs one HashMap lookup), but the number of http:handler nodes is typically small (hundreds, not millions). Step 2 is a series of point lookups, which bloom filters make efficient.

**For Grafema's use case, performance should be acceptable.** The Datalog rules query specific, small node types (http:handler, queue:publish, etc.), not all nodes. The design explicitly avoids O(all_nodes) patterns (Steve Jobs' complexity checklist).

### 3.5. Future Consideration: Incremental Datalog

If Grafema ever needs to move from "re-evaluate entire rules" to "incrementally maintain rule results," the options from the literature are:

- **[DDlog](https://github.com/vmware-archive/differential-datalog)**: Differential Datalog, based on differential dataflow. Handles both additions and deletions efficiently. VMware built this; now archived but the approach is sound.
- **[IncA](https://www.pl.informatik.uni-mainz.de/files/2021/04/inca-whole-program.pdf)**: Incremental lattice-based Datalog. Tracks derivation dependencies at the tuple level. Better for lattice-valued analyses.
- **[Elastic incrementalization for Datalog](https://souffle-lang.github.io/pdf/ppdp21incremental.pdf)**: Souffle team's work on adding incrementality to their engine.

For now, re-evaluating affected rules from scratch on each change is the right choice. The rules are cheap (targeted queries), and the overhead of incremental Datalog infrastructure would not be justified.

---

## 4. Tombstone Semantics for Dataflow

### 4.1. The Concern

When a file is re-analyzed, all its nodes and edges are tombstoned, then new ones are created. Consider a dataflow chain:

```
file_A: node_1 --DATA_FLOW--> node_2 --DATA_FLOW--> node_3 :file_B
                                ^
                        (node_2 is in file_A)
```

If file A is re-analyzed:
1. node_1 and node_2 are tombstoned
2. New node_1' and node_2' are created
3. Edge node_1 -> node_2 is tombstoned (owned by file A)
4. Edge node_2 -> node_3 is tombstoned (owned by file A, since src is in A)
5. New edges node_1' -> node_2' are created by analysis
6. But edge node_2' -> node_3 must be recreated by **enrichment** (cross-file edge)

### 4.2. Analysis

The tombstone + recreate approach is sound **if and only if enrichment correctly recreates all cross-file edges**. Specifically:

**Intra-file dataflow** (edges where both src and dst are in the same file): These are recreated by re-analysis of the file. Sound by construction.

**Cross-file dataflow** (edges where src is in file A, dst is in file B or vice versa): These are owned by the src file's shard (or the enrichment virtual shard). When file A is re-analyzed:
- Edges with src in A are tombstoned (they live in A's shard or enrichment shard with _owner)
- Edges with dst in A but src elsewhere are NOT tombstoned (they live in the src's shard)

The second case is the subtle one. If node_3 in file_B has an edge to the old node_2 in file_A, that edge is NOT automatically tombstoned when file_A changes. It now points to a tombstoned node (dangling reference).

### 4.3. Dangling Edge Resolution

The roadmap's Phase 4 acknowledges this: "Cross-reference integrity: edges pointing to tombstoned nodes -> handled gracefully."

For dataflow soundness, "handled gracefully" must mean:
1. During enrichment re-run: the enricher detects that dst (old node_2) is tombstoned, and either (a) finds the replacement node_2' via semantic ID matching, or (b) removes the stale edge
2. During query: the query engine skips edges where either endpoint is tombstoned

Option (2) is the minimum requirement for correctness. Option (1) is needed for completeness (not losing valid dataflow paths).

### 4.4. Semantic ID as Stability Anchor

The v2 design's use of semantic IDs is critical here. When file A is re-analyzed:
- Old node: semantic_id = "src/A.js->global->FUNCTION->processData", u128 = BLAKE3(semantic_id)
- New node: same semantic_id, same u128 (if the function still exists with the same semantic path)

This means **edges from other files that reference this node by u128 still point to the correct node** (the new one has the same u128). The tombstone is for the old segment entry, but the new segment entry has the same u128 key.

**This is a major soundness advantage.** Unlike systems that generate fresh IDs on re-analysis, Grafema's semantic ID scheme means that edges from unchanged files remain valid without re-enrichment, as long as the target node's semantic identity is preserved.

### 4.5. When Semantic IDs Change

If a function is renamed or moved:
- Old semantic_id: "src/A.js->global->FUNCTION->processData"
- New semantic_id: "src/A.js->global->FUNCTION->handleData"
- Different u128 -> edges from other files become dangling

In this case, enrichment MUST re-run for all affected files. The delta will show the old semantic_id as "removed" and the new one as "added," which correctly triggers re-enrichment.

### 4.6. Recommendation

The tombstone + recreate approach is sound for dataflow under these conditions:
1. **Semantic ID stability**: Same code entity -> same semantic_id -> same u128. Verified.
2. **Query-time tombstone filtering**: Edges to/from tombstoned nodes are skipped. Must be verified in query path.
3. **Post-change enrichment**: After re-analysis, enrichment runs for changed nodes, recreating any cross-file edges that reference renamed/moved entities.
4. **No intermediate queries during enrichment gap**: Guarantees/validations run only after enrichment completes (see Section 2).

---

## 5. Change Blast Radius Correctness

### 5.1. The Proposed Approach

```
delta = DiffSnapshots(from, to)
affected = Reachability(
  startIds: delta.modifiedNodes + delta.addedNodes,
  maxDepth: 5,
  edgeTypes: ["CALLS", "IMPORTS", "DEPENDS_ON"],
  backward: true
)
```

Reverse BFS from changed nodes, following specific edge types backward, with a depth limit.

### 5.2. Formal Analysis

**Is this a sound over-approximation?**

In change impact analysis (cf. [Ryder, Tip: Chianti](https://www.researchgate.net/publication/4200463_Chianti_A_change_impact_analysis_tool_for_programs)), a sound over-approximation of "affected code" must include every code unit whose behavior could be influenced by the change. Formally:

Let `changed` = set of changed nodes. Let `affected(changed)` = {n in G | exists a path from n to some c in changed via dependency edges}. A sound over-approximation S satisfies: `affected(changed) ⊆ S`.

Reverse BFS from `changed` computes exactly `affected(changed)` (the backward-reachable set), so **without depth limiting, this is exact, not merely an over-approximation**.

### 5.3. Effect of Depth Limit

The `maxDepth: 5` introduces an under-approximation risk. If the actual dependency chain is:

```
module_A -> module_B -> module_C -> module_D -> module_E -> module_F -> changed_node
```

And maxDepth=5, then module_A would be missed (it's at depth 6).

**Is this a problem in practice?** For Grafema's target codebases:
- CALLS chains of depth >5 are rare in direct call graphs (A calls B calls C... 6+ deep is unusual for meaningful impact)
- IMPORTS chains of depth >5 are very common (transitive re-exports in JS/TS), but the impact attenuates rapidly

**Recommendation:** Make maxDepth configurable (not hardcoded to 5). For blast radius queries, a reasonable default is 5-10 for CALLS, but IMPORTS transitivity should have a higher limit or be handled differently (since import chains are cheap to follow and the fan-out is bounded).

### 5.4. Missing Cases

The reverse BFS approach can miss:

1. **Dynamic dispatch / indirect calls**: If module_A calls a function pointer that resolves to the changed function at runtime, the static call graph may not have the edge. This is a fundamental limitation of static analysis, not specific to RFDB v2.

2. **Data-flow dependencies**: If the changed function writes to a shared resource (database, file, global variable) that another function reads, the CALLS/IMPORTS/DEPENDS_ON edge set does not capture this. Grafema would need DATA_FLOW or WRITES_TO/READS_FROM edges to capture this.

3. **Removed nodes**: The proposed approach uses `delta.modifiedNodes + delta.addedNodes` but not `delta.removedNodes`. If a function was deleted, callers of that function are affected (they now have a broken reference). The blast radius should include `removedNodes` as start points too.

4. **Edge changes without node changes**: If an enrichment change adds or removes an edge between two unchanged nodes, neither node appears in the delta, but the relationship changed. This is captured by edge deltas but the proposed blast radius only starts from node changes.

### 5.5. Comparison with Literature

The standard approach in change impact analysis ([Ryder & Tip, 2001](https://www.researchgate.net/publication/221292790_Change_impact_analysis_for_object_oriented_programs); Chianti tool) decomposes changes into "atomic changes" and computes affected tests via call graph reachability. The key insight is that **impact is computed per atomic change, not per file**.

Grafema's approach computes impact per file (tombstone + recreate is file-granular). This is coarser but simpler and aligns with the storage model. For the target use case (understanding blast radius for code review), file-level granularity is usually sufficient.

The [IFDS/IDE framework](https://dl.acm.org/doi/10.1145/199448.199462) by Reps, Horwitz, and Sagiv computes precise interprocedural dataflow analysis via graph reachability. Grafema's blast radius is a simplified version (fewer edge types, bounded depth), which is appropriate for the use case.

### 5.6. Recommendation

1. Include `removedNodes` in the start set for blast radius computation.
2. Make `maxDepth` configurable, with a sensible default per edge type.
3. Consider adding edge-change-only blast radius (start from endpoints of added/removed edges).
4. Document that blast radius is an **approximation** -- sound for the modeled edge types, but not for effects mediated through unmodeled channels (dynamic dispatch, shared state).

---

## 6. Summary of Recommendations

### Critical (Must Fix Before Implementation)

| # | Issue | Location | Recommendation |
|---|-------|----------|----------------|
| 1 | Guarantee checking must use post-enrichment delta, not just CommitBatch delta | Phase 4, Orchestrator | Collect changedTypes from BOTH the file-change CommitBatch AND the enrichment CommitBatch. Union them for guarantee selection. |
| 2 | Ordering invariant: guarantees only checked after enrichment | Phase 4 + Phase 6 | Formalize "analysis-consistent" state. Enforce in orchestrator. |

### Important (Should Address in Design)

| # | Issue | Location | Recommendation |
|---|-------|----------|----------------|
| 3 | Query-time tombstone filtering for edges | Phase 4 | Edges where src OR dst is tombstoned must be invisible to queries, including Datalog. |
| 4 | Blast radius should include removedNodes | Phase 5 (DiffSnapshots) | Add removedNodes to start set for reverse reachability. |
| 5 | Watch mode consistency model | Architecture | Define "epochs" or dirty flags to prevent guarantee checks on stale enrichment. |

### Nice to Have (Future Consideration)

| # | Issue | Location | Recommendation |
|---|-------|----------|----------------|
| 6 | Configurable blast radius depth per edge type | DiffSnapshots + Reachability | Default maxDepth=5 is a trade-off; make it tunable. |
| 7 | Edge-change blast radius | DiffSnapshots | Start BFS from endpoints of changed edges, not just changed nodes. |
| 8 | Incremental Datalog (DDlog/IncA style) | Future | Not needed now; re-evaluating rules from scratch is fast enough for targeted queries. |

---

## 7. Formal Soundness Statement

Under the following conditions, the RFDB v2 incremental analysis approach is **sound** (no false negatives in guarantee checking):

**Preconditions:**
1. The Datalog evaluator sees a **storage-consistent** snapshot (guaranteed by RFDB snapshot isolation).
2. Guarantee rules are evaluated only after the graph is **analysis-consistent** (all enrichment for the current version has been applied).
3. The set of guarantee rules to re-evaluate is determined by the **union** of changedTypes from all CommitBatches in the current update cycle (file changes + enrichment changes).
4. Semantic IDs are stable for unchanged code entities (guaranteed by BLAKE3 of semantic path).
5. Edges to/from tombstoned nodes are filtered out in the query path.

**Theorem (informal):** Under preconditions 1-5, for any guarantee rule r_i:
- If r_i is re-evaluated: the result is correct for the current graph state.
- If r_i is not re-evaluated (deps(r_i) ∩ changedTypes = {}): the result from the previous evaluation remains valid.

**Proof obligation:** The orchestrator must maintain preconditions 2, 3, and 5. RFDB maintains 1 and 4.

---

## References

- [Incremental whole-program analysis in Datalog with lattices (IncA)](https://dl.acm.org/doi/10.1145/3453483.3454026) -- Szabo et al., PLDI 2021
- [Differential Datalog (DDlog)](https://github.com/vmware-archive/differential-datalog) -- VMware, incremental Datalog via differential dataflow
- [Scaling Static Analyses at Facebook (Infer)](https://cacm.acm.org/research/scaling-static-analyses-at-facebook/) -- Distefano et al., CACM 2019
- [Demanded Abstract Interpretation](https://manu.sridharan.net/files/PLDI21Demanded.pdf) -- Stein et al., PLDI 2021
- [Chianti: Change Impact Analysis](https://www.researchgate.net/publication/4200463_Chianti_A_change_impact_analysis_tool_for_programs) -- Ryder, Tip, 2001
- [Precise Interprocedural Dataflow Analysis via Graph Reachability (IFDS)](https://dl.acm.org/doi/10.1145/199448.199462) -- Reps, Horwitz, Sagiv, POPL 1995
- [Towards Elastic Incrementalization for Datalog](https://souffle-lang.github.io/pdf/ppdp21incremental.pdf) -- Zhao et al., PPDP 2021
- [Souffle: On Fast Large-Scale Program Analysis in Datalog](https://souffle-lang.github.io/pdf/cc.pdf) -- Scholz et al., CC 2016
- [Program Analysis Correctness (CMU lecture notes)](https://www.cs.cmu.edu/~clegoues/courses/15-819O-16sp/notes/notes04-dataflow-correctness.pdf) -- Le Goues, 2016
- [Incremental Static Analysis with Differential Datalog](https://pergamos.lib.uoa.gr/uoa/dl/frontend/file/lib/default/data/2882821/theFile) -- Univ. of Athens thesis
- [Porting Doop to Souffle](https://dl.acm.org/doi/10.1145/3088515.3088522) -- Antoniadis et al., SOAP 2017
