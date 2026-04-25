# REG-489: Don Melton — Exploration Notes

## Request Quality Gate

Request passes: clear problem statement, root cause identified, evidence provided (330→14 MODULE nodes),
acceptance criteria defined, performance baseline specified. Proceeding.

---

## The Failure Chain — Step by Step

### What REG-487 Did

REG-487 introduced `deferIndex=true` on `commitBatch`. Before REG-487:
- Every `commitBatch` triggered `engine.flush()` — a full index rebuild.
- This caused O(n²) behavior: N modules × N rebuild passes = quadratic time.
- Fix: use `engine.flush_data_only()` during bulk load, rebuild indexes once at the end.

### The commitBatch Contract (handle_commit_batch, rfdb_server.rs:1483–1614)

```
for each file in changed_files:
    find all nodes where node.file == file
    delete all incoming and outgoing edges for each such node
    delete each such node

add all new nodes from the request
add all new edges from the request
flush (data only if deferIndex, full if not)
```

This is **replace semantics**: any file in `changed_files` gets fully wiped before new data is written. There is no partial update, no type filtering, no additive mode.

### How changed_files Gets Built (client.ts:1097–1110)

`_batchFiles` is a `Set<string>` that accumulates the `file` field of every node pushed via `batchNode()` or `addNodes()`. On `commitBatch()`, all of `_batchFiles` becomes `changedFiles` in the wire message.

Key: the set is file-path based, not node-type based. If ANY node for file X is in the batch, the server deletes ALL nodes for file X before adding the batch.

### INDEXING Phase — What It Creates

`JSModuleIndexer.execute()` uses `graph.addNode()` (NOT batch). The PhaseRunner wraps it in a batch via `runPluginWithBatch` (PhaseRunner.ts:94–98):

```
graph.beginBatch()
plugin.execute(context)   // calls graph.addNode() for each MODULE
graph.commitBatch(tags, deferIndex)
```

So each MODULE node's `file` path gets added to `_batchFiles` as addNode goes through the batch buffer. The INDEXING commitBatch deletes old data for all those files, then adds the new MODULE nodes. After INDEXING, indexes are rebuilt (`graph.rebuildIndexes()`), making MODULE nodes queryable.

**JSModuleIndexer creates:**
- MODULE nodes (one per file)
- SERVICE→CONTAINS→MODULE edges
- MODULE→DEPENDS_ON→MODULE edges (deferred to `addEdges`)

**It does NOT create IMPORT or EXPORT nodes.** The task description's mention of "IMPORT/EXPORT nodes also created in indexing" is INCORRECT — those are created by JSASTAnalyzer in ANALYSIS phase.

### ANALYSIS Phase — What It Creates (The Problematic Path)

JSASTAnalyzer has `managesBatch: true`, so PhaseRunner's `runPluginWithBatch` skips wrapping it. JSASTAnalyzer runs its own internal WorkerPool and wraps each module in its own `beginBatch/commitBatch` pair (JSASTAnalyzer.ts:392–404).

For each module `X.ts`, the analysis batch:
1. `graph.beginBatch()` — starts accumulating
2. `analyzeModule(module, graph, projectPath)` — runs all visitors, collects FUNCTION/SCOPE/BRANCH/PARAMETER/IMPORT/EXPORT nodes
3. Inside `analyzeModule`, `GraphBuilder.build()` is called
4. `GraphBuilder.build()` calls `updateModuleImportMetaMetadata` and `updateModuleTopLevelAwaitMetadata`
   - These call `graph.getNode(module.id)` to read the existing MODULE from server
   - These call `graph.addNode(existingNode)` — which during batching pushes the MODULE node into `_batchNodes` and adds `module.file` to `_batchFiles`
   - BUT: `updateModuleImportMetaMetadata` returns early if `importMetaProps.length === 0`
   - AND: `updateModuleTopLevelAwaitMetadata` returns early if `!hasTopLevelAwait`
5. `graph.commitBatch(['JSASTAnalyzer', 'ANALYSIS', module.file], deferIndex)`
   - `changedFiles` = `_batchFiles` = all files of nodes pushed during this batch
   - If no import.meta and no top-level await: `changedFiles` includes `module.file` ONLY because SCOPE/FUNCTION nodes have the same file, NOT because MODULE was re-added
   - Server deletes all nodes for `module.file` (includes MODULE from INDEXING)
   - Server adds FUNCTION, SCOPE, BRANCH, PARAMETER, IMPORT, EXPORT nodes (no MODULE unless re-added)
   - MODULE is GONE

### Why 14 Survive

"Surviving 14 are files JSASTAnalyzer never processed (no batch commit)."

Files JSASTAnalyzer skips (cached, failed to parse, or filtered) never have a batch commit from ANALYSIS. Their MODULE nodes persist because the delete-then-add cycle never runs for them.

### The Core Conflict

Two phases use `commitBatch` for the same file:
- INDEXING creates structural nodes (MODULE, DEPENDS_ON relationships)
- ANALYSIS creates semantic nodes (FUNCTION, SCOPE, etc.) for the same file

`commitBatch`'s replace semantics treat a file as an atomic unit owned by whoever last committed. This is correct for within-phase idempotency (re-running analysis overwrites stale analysis data), but wrong for cross-phase ownership (analysis should NOT own the MODULE node created by indexing).

### Cross-Phase Node Ownership Table

| Node Type | Created By | Should Survive Analysis commitBatch? |
|-----------|-----------|--------------------------------------|
| MODULE    | INDEXING (JSModuleIndexer) | YES — structural node, cross-phase |
| CONTAINS  | INDEXING (JSModuleIndexer) | YES — structural edge |
| DEPENDS_ON| INDEXING (JSModuleIndexer) | YES — structural edge |
| FUNCTION  | ANALYSIS (JSASTAnalyzer) | YES — owned by analysis |
| SCOPE     | ANALYSIS (JSASTAnalyzer) | YES — owned by analysis |
| BRANCH    | ANALYSIS (JSASTAnalyzer) | YES — owned by analysis |
| PARAMETER | ANALYSIS (JSASTAnalyzer) | YES — owned by analysis |
| IMPORT    | ANALYSIS (JSASTAnalyzer) | YES — owned by analysis |
| EXPORT    | ANALYSIS (JSASTAnalyzer) | YES — owned by analysis |
| EXTERNAL_MODULE | ANALYSIS (JSASTAnalyzer) | YES — owned by analysis |

Key insight: **MODULE nodes are the only cross-phase nodes that live at the same file path as analysis nodes.**

---

## External Research: How Other Graph Databases Handle This

### Neo4j Approach
Neo4j's bulk import (`neo4j-admin import`) treats the import as a one-shot operation. For multi-phase imports on a live database, Neo4j uses `MERGE` semantics (find-or-create) rather than replace semantics. The equivalent of Grafema's issue would be solved in Neo4j by separating structural nodes (loaded once, never deleted) from semantic nodes (replaced per-run). Reference: [Neo4j bulk import](https://neo4j.com/docs/operations-manual/current/tools/neo4j-admin/neo4j-admin-import/)

### JanusGraph Approach
JanusGraph bulk loading uses separate transaction contexts per "layer." Structural schema/vertex type definitions are committed first and treated as immutable during subsequent bulk loads. The pattern: different vertex label namespaces get separate loading phases. Reference: [JanusGraph bulk loading](https://nitinpoddar.medium.com/bulk-loading-data-into-janusgraph-ace7d146af05)

### Common Pattern Across Graph DBs

The universal pattern for multi-phase graph construction:
1. **Phase 1**: Create backbone nodes (structural, persistent) — never delete these
2. **Phase 2**: Create semantic/analytical nodes — safe to replace per file
3. **Key principle**: Separate ownership by node type or namespace, not by file

Grafema's `commitBatch` uses file-path ownership. This is correct for within-phase idempotency but wrong for cross-phase co-existence.

---

## Evaluation of Each Proposed Approach

### Approach A: JSASTAnalyzer Re-Creates MODULE Node

**Mechanism**: Before committing the analysis batch for file X, JSASTAnalyzer reads the MODULE node from the graph and includes it in the batch so it survives the delete-then-add.

**Analysis**:
- GraphBuilder already does this for import.meta and hasTopLevelAwait — but conditionally (returns early if nothing to update).
- The fix would be: always call `graph.addNode(moduleNode)` in the analysis batch, unconditionally.
- This means: ANALYSIS batch = MODULE node + FUNCTION + SCOPE + BRANCH + etc.
- The MODULE node is re-added correctly, no net data loss.

**Problems**:
1. **Duplication of ownership** — the MODULE node is now "created" by both INDEXING and ANALYSIS. Future enrichers or validators that check which phase creates MODULE will be confused.
2. **Re-read overhead** — every module analysis requires a `getNode` round-trip to the server to fetch the MODULE before committing. For 330 modules this is 330 extra round-trips, but minimal compared to the analysis work itself.
3. **Fragile** — any new analyzer that uses `commitBatch` for the same file must also remember to re-include MODULE nodes. This is a maintenance trap.
4. **CONTAINS and DEPENDS_ON edges** — analysis batch would not include these. Are they also deleted? Yes — handle_commit_batch deletes ALL edges where src OR dst is a deleted node. Since MODULE is deleted and re-created, the CONTAINS edge (SERVICE→MODULE) and DEPENDS_ON edges (MODULE→MODULE) are deleted. Re-creating just the MODULE node without re-creating those edges leaves the graph disconnected.

This approach is **fundamentally incomplete** unless it also re-creates all edges connected to the MODULE node. That means ANALYSIS phase would need to re-create INDEXING-phase edges — extreme coupling between phases.

**Verdict: REJECT** — incomplete (edges lost) and creates cross-phase ownership confusion.

### Approach B: commitBatch Gets `additive` Mode (Skip Deletion for Certain Phases)

**Mechanism**: Add a flag to the wire protocol — `additive: true`. When set, skip the delete-then-add phase; only add new nodes.

**Analysis**:
- Preserves REG-487 performance (no extra round-trips, still deferred index).
- Clean separation: INDEXING uses replace mode (creates fresh), ANALYSIS uses additive mode (adds to existing).
- `handle_commit_batch` change: skip the deletion loop when `additive: true`.

**Problems**:
1. **Re-run idempotency broken** — if ANALYSIS runs twice (incremental re-analysis of changed files), additive mode would accumulate duplicate FUNCTION/SCOPE/BRANCH nodes for the re-analyzed file. You'd get double counts.
2. **Requires wire protocol change** — both rfdb_server.rs and client.ts need to be updated. That's two layers (Rust + TypeScript).
3. **Still needs scoping** — additive at the file level means old analysis nodes for the file are never cleaned up. This is worse than the current bug for incremental analysis.

The insight here: additive mode is wrong at the whole-file level. What we need is **selective replacement** — replace nodes owned by ANALYSIS, preserve nodes owned by INDEXING.

**Verdict: REJECT** — breaks incremental re-analysis idempotency.

### Approach C: Phase-Scoped File Contexts (Virtual Prefix like `indexing::X.ts`)

**Mechanism**: Different phases write nodes with different `file` field values. INDEXING writes `file = "src/X.ts"`, ANALYSIS writes `file = "analysis::src/X.ts"`. The delete scope never overlaps.

**Analysis**:
- Elegant in theory — completely eliminates the conflict by namespace separation.
- `file_context` parameter already exists in `handle_commit_batch` for enrichment! (rfdb_server.rs:1489–1508: "When file_context is provided, the batch operates in enrichment mode... injects `__file_context` into each edge's metadata via `enrichment_edge_metadata()`")

**Problems**:
1. **Massive downstream impact** — every graph query that uses `file` as a filter would need to know which prefix to use, or query both. Tools like `getNode`, `queryNodes({ file: X })`, and graph traversal queries would break.
2. **MODULE and FUNCTION nodes would have different `file` values for the same source file** — this breaks cross-phase edges like FUNCTION→MODULE (HAS_SCOPE) which rely on matching file references.
3. **MCP tools, CLI queries, and all user-facing operations** currently assume `file = "actual/path/to/file.ts"`. This would break everything.
4. The `file_context` enrichment mode IS this approach but restricted to enrichment edges (which are purely additive, non-structural). That design decision was deliberate — enrichment is different from structural data.

**Verdict: REJECT** — breaks file-based queries, massive downstream impact, fundamentally changes the data model.

### Approach D: Protected Node Types That Survive Cross-Phase Commits

**Mechanism**: Add a `protectedTypes: string[]` parameter to the wire protocol. When deleting nodes for a file, skip deletion of nodes whose type is in `protectedTypes`. SERVER-SIDE filtering: `if protectedTypes.contains(node.type) { skip delete }`.

**Analysis**:
- Minimal wire protocol change (one optional array field).
- Server change is localized to the deletion loop in `handle_commit_batch`.
- No change to client data model, no change to query API.
- Caller (JSASTAnalyzer) passes `protectedTypes: ['MODULE']` to tell the server: "delete all analysis nodes for this file, but preserve the MODULE node."
- CONTAINS and DEPENDS_ON edges are attached to MODULE node. If MODULE is preserved, those edges survive too.

**Correctness check**:
- Delete loop: for each node where `file == "X.ts"`, if node.type in `protectedTypes` → SKIP node deletion.
- Edge deletion: edges are deleted only when their src/dst node is deleted. If MODULE is not deleted, its edges survive.
- On re-run (incremental analysis): analysis nodes for the file ARE deleted (they're not protected), MODULE survives. Clean.

**Problems**:
1. **Wire protocol change** — both rfdb_server.rs and client.ts need updating.
2. **Caller must know which types to protect** — this is a concern because it requires the analysis plugin to know about indexing's node types. However, this is acceptable: the protected types are a static list (`['MODULE']`), and they could be passed from the Orchestrator which has cross-phase knowledge.
3. **What if a future phase creates other structural node types?** The protected list would need to grow. But this is manageable — it's a config-time decision, not runtime code.

**Verdict: STRONG CANDIDATE** — correct, minimal scope, preserves edges correctly.

### Approach E: Two-Tier Commit — Structural vs Semantic Ownership

**Mechanism**: Restructure the pipeline so that structural nodes (MODULE, CONTAINS, DEPENDS_ON) are written in a separate non-overlapping namespace from semantic nodes (FUNCTION, SCOPE, etc.). Specifically:
- INDEXING phase: `commitBatch` with structural nodes, using file key `struct::X.ts`
- ANALYSIS phase: `commitBatch` with semantic nodes, using file key `analysis::X.ts`
- But node `file` field remains `X.ts` (only the deletion key changes)

This is a variation of C but uses a separate "deletion key" concept distinct from the `file` field.

**Analysis**:
- Would require a new `deletionKey` field in the wire protocol separate from the node's `file` attribute.
- More complex than D — two layers of indirection.
- Benefits: clean separation, no shared deletion scope.

**Problems**:
1. Significant protocol change.
2. Node file field stays `X.ts` but deletion key differs — confusing mental model.
3. Complexity cost is higher than D with no additional correctness benefit.

**Verdict: REJECT** — more complex than D, equivalent correctness, not worth it.

---

## The Real Fix: Approach D (Protected Types)

After analysis, approach D is the right solution:

1. Add `protected_types: Vec<String>` optional field to the `commitBatch` wire message.
2. In `handle_commit_batch`: during deletion phase, skip any node whose `node_type` is in `protected_types`.
3. In `client.ts`: add `protectedTypes?: string[]` parameter to `commitBatch()` and pass it through.
4. In `JSASTAnalyzer` (or Orchestrator): pass `protectedTypes: ['MODULE']` when committing analysis batches.

The key insight is that the server, not the client, should enforce the protection. The server is the atomic authority over what gets deleted.

### Why MODULE Edges Survive Automatically

When MODULE is not deleted, its edges are not touched:
- `handle_commit_batch` only deletes edges where src or dst is a node being deleted
- If MODULE node is not in the delete set, MODULE's edges are not in the edge delete set
- CONTAINS (SERVICE→MODULE) and DEPENDS_ON (MODULE→MODULE) both survive

This is the correct behavior with zero additional work.

### The `importMetaProps` / `hasTopLevelAwait` Problem

GraphBuilder currently reads MODULE and re-adds it to update metadata. With approach D, this is no longer needed for survival — MODULE will survive regardless. HOWEVER, those metadata updates (import.meta properties, hasTopLevelAwait flag) are still valid enrichments to the MODULE node.

The question is: should these be re-done as `addNode` (upsert/update) calls or as enrichment? Currently they go through the batch which triggers replace semantics. With approach D (protectedTypes: ['MODULE']), these addNode calls would re-add MODULE to the batch — which is fine because the protected-types rule means the old MODULE is NOT deleted, and the new one (from the batch) replaces it. This is correct upsert behavior.

Wait — need to think carefully. If MODULE is in `protected_types`, the server skips deleting the old MODULE. Then the server calls `engine.add_nodes(node_records)` which includes the new MODULE from the batch (from updateModuleImportMetaMetadata). This would be an upsert (add_nodes is upsert in RFDB). Result: MODULE is updated with new metadata. Correct.

If no import.meta and no hasTopLevelAwait (most files): GraphBuilder never calls addNode for MODULE. The server skips deleting the old MODULE (because of protectedTypes). The server adds zero MODULE nodes from the batch. Result: old MODULE from INDEXING survives intact. Correct.

Both cases are correct.

---

## Files to Be Modified

| File | Change Type | What |
|------|-------------|------|
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Rust server | Add `protected_types` field to `CommitBatch` message handler; skip delete for protected node types |
| `packages/rfdb/ts/client.ts` | TypeScript client | Add `protectedTypes?: string[]` param to `commitBatch()` and `_sendCommitBatch()` |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | TS plugin | Pass `protectedTypes: ['MODULE']` when calling `graph.commitBatch()` |
| `packages/core/src/PhaseRunner.ts` | TS orchestration | Pass `protectedTypes` through context if needed (check if PhaseRunner wraps any analysis phase that needs it) |

Note: PhaseRunner's `runPluginWithBatch` uses `plugin.metadata.managesBatch` to skip wrapping JSASTAnalyzer. So the protected types need to be passed directly in JSASTAnalyzer's own `graph.commitBatch()` call (JSASTAnalyzer.ts:396–399).

---

## Edge Cases and Concerns

1. **Incremental re-analysis**: When a file changes, ANALYSIS re-runs. The old analysis nodes are deleted (they're not protected), new ones added. MODULE survives. Correct.

2. **forceAnalysis**: Graph is cleared entirely before re-analysis. MODULE doesn't exist yet when INDEXING runs. INDEXING creates it. Then ANALYSIS runs with protectedTypes — nothing to protect (MODULE is newly created from this run's INDEXING). Correct.

3. **modulesBatched from INDEXING to ANALYSIS**: The `getModuleNodes` call in JSASTAnalyzer queries all MODULE nodes BEFORE any analysis batch is committed. So `module.file` is known correctly. Protected types won't interfere with the query.

4. **The 14 surviving files**: These were files JSASTAnalyzer never processed. With the fix, all 330 modules would survive. The 14 that currently survive are correctly handled already (no analysis batch = no delete).

5. **Ghost edges after fix**: With protectedTypes, MODULE nodes survive, their edges survive, no ghost edges. The "SCOPE ← FUNCTION ← NULL" pattern disappears.

6. **Multi-root workspace**: Same fix applies. Each root processes files independently, but the protectedTypes mechanism is file-path agnostic — it protects by node type, not by file path.

7. **ParallelAnalysisRunner** (alternate path in Orchestrator): Would need to pass protectedTypes the same way. Need to check that code path.

8. **SERVICE node** — created by what phase? Not by JSModuleIndexer (which creates MODULE). Need to verify service node is not at risk.
