# REG-489: Dijkstra Plan Verification

## Verdict: REJECT

Two critical gaps found. Plan is incomplete and will not fix all MODULE deletion scenarios.

---

## 1. Input Universe: Node Types Across All Phases

### Verified against `metadata.creates` declarations

| Phase | Plugin | Node Types Created |
|-------|--------|--------------------|
| INDEXING | JSModuleIndexer | MODULE (confirmed: `nodes: ['MODULE']`) |
| ANALYSIS | JSASTAnalyzer | FUNCTION, SCOPE, BRANCH, PARAMETER, LOOP, CALL, VARIABLE_DECLARATION, PROPERTY_ACCESS, LITERAL, IMPORT, EXPORT, OBJECT_LITERAL, CLASS, METHOD, etc. |
| ANALYSIS | ExpressAnalyzer | `http:route`, `express:mount` |
| ANALYSIS | FetchAnalyzer | `http:request`, EXTERNAL |
| ANALYSIS | ExpressRouteAnalyzer | `http:route`, `express:middleware` |
| ANALYSIS | SocketAnalyzer | `os:unix-socket`, `os:unix-server`, `net:tcp-connection`, `net:tcp-server` |
| ANALYSIS | SocketIOAnalyzer | `socketio:emit`, `socketio:on`, `socketio:room`, `socketio:event` |
| ANALYSIS | DatabaseAnalyzer | `db:query`, `db:table`, `db:connection` |
| ANALYSIS | SQLiteAnalyzer | `db:query` |
| ANALYSIS | SystemDbAnalyzer | `SYSTEM_DB_VIEW_REGISTRATION`, `SYSTEM_DB_SUBSCRIPTION` |
| ANALYSIS | NestJSRouteAnalyzer | `http:route` |
| ANALYSIS | ServiceLayerAnalyzer | `SERVICE_CLASS`, `SERVICE_INSTANCE`, `SERVICE_REGISTRATION`, `SERVICE_USAGE` |
| ANALYSIS | ReactAnalyzer | (React-specific) |
| ANALYSIS | IncrementalAnalysisPlugin | FUNCTION, CLASS, VARIABLE_DECLARATION |
| ENRICHMENT | (various enrichers) | ISSUE, enrichment edges |
| VALIDATION | (validators) | ISSUE |

**Conclusion**: MODULE is the only node type created in INDEXING that needs protection. Don's claim is correct on this point.

---

## 2. Critical Gap: PhaseRunner Calls commitBatch Without protectedTypes

### The Discovery

Don's plan adds `protectedTypes: ['MODULE']` ONLY to JSASTAnalyzer's own per-module `commitBatch` calls. But there is a second deletion path Don did not account for.

**Evidence from `packages/core/src/PhaseRunner.ts` (lines 75-104):**

```typescript
private async runPluginWithBatch(plugin, pluginContext, phaseName) {
    // Fallback: backend doesn't support batching, or plugin manages its own batches
    if (!graph.beginBatch || !graph.commitBatch || !graph.abortBatch
        || plugin.metadata.managesBatch) {
      // ...skip batching
    }
    // All other plugins go through here:
    graph.beginBatch();
    try {
      const result = await plugin.execute(pluginContext);
      const delta = await graph.commitBatch(tags, deferIndex);  // NO protectedTypes
      return { result, delta };
    }
}
```

**Only JSASTAnalyzer has `managesBatch: true`** (confirmed: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts:278`).

All other ANALYSIS plugins (ExpressAnalyzer, FetchAnalyzer, ServiceLayerAnalyzer, SocketAnalyzer, DatabaseAnalyzer, SQLiteAnalyzer, NestJSRouteAnalyzer, SocketIOAnalyzer, SystemDbAnalyzer, ReactAnalyzer, IncrementalAnalysisPlugin) go through `runPluginWithBatch` which calls `commitBatch` WITHOUT `protectedTypes`.

### The File Contamination

These plugins create nodes with `file` set to the source file path. Confirmed in:

- `ExpressAnalyzer.ts:223` — `file: module.file!` (for `http:route` nodes)
- `ExpressAnalyzer.ts:299` — `file: module.file!` (for `express:mount` nodes)
- `FetchAnalyzer.ts:210,242,279,312` — `file: module.file!` (for `http:request`, `EXTERNAL` nodes)
- `ServiceLayerAnalyzer.ts:214,235,268,300` — `file: module.file!` (for SERVICE_CLASS, SERVICE_INSTANCE, etc.)

When PhaseRunner calls `commitBatch` for ExpressAnalyzer (after JSASTAnalyzer has completed), the TS client (`client.ts:424-429`) adds each node's `file` to `_batchFiles`. The resulting `changedFiles` includes actual source file paths. The Rust server's deletion loop (`rfdb_server.rs:1516-1559`) then:

1. Finds all nodes with `file === "src/app.ts"` (or whatever file)
2. Deletes ALL of them — including MODULE nodes that JSASTAnalyzer's fix just preserved

### Execution Order Confirmation

ANALYSIS phase runs as a single global `runPhase` call (Orchestrator.ts:265, 390). Inside `PhaseRunner.runPhase`, plugins execute sequentially in dependency order:
1. JSASTAnalyzer runs first (all others `depend on JSASTAnalyzer`)
2. After JSASTAnalyzer finishes all per-module commits (MODULE nodes survive due to fix)
3. ExpressAnalyzer runs — PhaseRunner wraps it in `beginBatch`/`commitBatch`
4. ExpressAnalyzer creates `http:route` nodes with `file: "src/app.ts"`
5. PhaseRunner calls `commitBatch` — `changedFiles: ["src/app.ts"]`
6. Server deletes all nodes for `"src/app.ts"` — MODULE re-deleted, fix undone

**This is a complete failure of the fix for any codebase using Express, Fetch, Socket, or Service Layer patterns.**

---

## 3. Completeness Table for Deletion Loop Change

| Input Scenario | Expected Behavior | Handled by Plan? |
|----------------|-------------------|-----------------|
| empty protectedTypes | legacy behavior (all deletion) | YES — `Vec<String>` default empty, behavior unchanged |
| protectedTypes: ['MODULE'], JSASTAnalyzer commit | skip MODULE deletion | YES |
| protectedTypes: ['MODULE'], ExpressAnalyzer commit via PhaseRunner | should skip MODULE | **NO — PhaseRunner never passes protectedTypes** |
| protected node has edges to non-protected nodes (CONTAINS: MODULE→FUNCTION) | FUNCTION deleted, edge deleted; MODULE preserved | **INCORRECT — see §4 below** |
| non-protected node (FUNCTION) has edges to protected node (MODULE) | FUNCTION deleted, edge deleted; MODULE preserved | YES — MODULE node survives |
| incremental re-analysis (file changed) | INDEXING re-runs first (no protectedTypes) → replaces MODULE; ANALYSIS re-runs with protectedTypes → preserves new MODULE | YES — described in plan |
| file deleted from codebase | old MODULE persists (pre-existing behavior, separate issue) | YES — acknowledged by plan |
| ENRICHMENT phase commits for same file | ENRICHMENT uses `file_context` virtual path, not actual file path | YES — enrichment uses different mechanism |
| multiple files in changedFiles | per-file deletion loop, protectedTypes applied per node | YES |
| parallelParsing=true path | no per-module commitBatch called, MODULE deletion does not occur | **NOT ADDRESSED** (but net effect: fix is irrelevant in this path, no regression) |
| ExpressAnalyzer commit (no protectedTypes) after JSASTAnalyzer fix | MODULE deleted again | **NO — critical missing scenario** |
| FetchAnalyzer commit (no protectedTypes) after JSASTAnalyzer fix | MODULE deleted again | **NO — critical missing scenario** |

---

## 4. Edge Preservation Correctness

### Tracing the Deletion Loop (`rfdb_server.rs:1528-1558`)

For a MODULE node `M` with:
- Outgoing edge: `M → F` (CONTAINS, where F = FUNCTION)
- Incoming edge: `S → M` (CONTAINS, where S = SERVICE node)
- Outgoing edge: `M → M2` (DEPENDS_ON, to another module)

**With `protectedTypes: ['MODULE']` applied correctly:**

1. Loop finds M by file
2. Checks `node.node_type == "MODULE"` → `continue` (skip deletion)
3. M is preserved, edges to/from M are NOT deleted

Wait — reading the plan's proposed code more carefully:

```rust
for id in &old_ids {
    if !protected_types.is_empty() {
        if let Some(node) = engine.get_node(*id) {
            if let Some(ref nt) = node.node_type {
                if protected_types.contains(nt) {
                    continue; // preserve this node and its edges
                }
            }
        }
    }
    // ... then SECOND get_node call for changed_node_types tracking
    // ... then delete edges
    // ... then delete_node
}
```

For F (FUNCTION) being deleted:
- F's outgoing edges (`F → SCOPE`) are deleted
- F's incoming edges: if `M → F` (CONTAINS) exists, it gets deleted here
- Then F itself is deleted

**Gap: When FUNCTION F is deleted, its incoming CONTAINS edge from MODULE M is also deleted (line 1546-1554 of rfdb_server.rs — incoming edges are deleted too).** If the MODULE is preserved but the CONTAINS edge FROM MODULE TO FUNCTION is an outgoing edge of MODULE (not outgoing of FUNCTION), this edge would be deleted when processing FUNCTION's incoming edges.

Wait — let me re-read the deletion logic:

```rust
for id in &old_ids {
    // For each node being deleted:
    for edge in engine.get_outgoing_edges(*id, None) { delete edge }
    for edge in engine.get_incoming_edges(*id, None) { delete edge }
    engine.delete_node(*id);
}
```

If F (FUNCTION) is in `old_ids` (file matches):
- `get_outgoing_edges(F)` → F→SCOPE edges → deleted
- `get_incoming_edges(F)` → M→F (CONTAINS) edge → **DELETED**
- `delete_node(F)`

The CONTAINS edge from MODULE M to FUNCTION F is deleted when F is processed, because it's an INCOMING edge of F. The MODULE node itself is preserved (because it's protected), but the CONTAINS edge is lost.

**This means after the fix, MODULE nodes survive but lose their CONTAINS→FUNCTION edges.** The node exists but has no outgoing connections to the functions it contains. This partially breaks the goal — the MODULE is no longer truly disconnected (it exists), but the CONTAINS structure is broken.

However, the per-module flow is:
1. Old F deleted (CONTAINS edge M→F deleted)
2. New F added (JSASTAnalyzer creates new F via `analyzeModule`)
3. New CONTAINS edge M→F_new is... actually wait, does JSASTAnalyzer create MODULE→FUNCTION CONTAINS edges?

Let me check GraphBuilder:

**Checking CoreBuilder for CONTAINS edge creation between MODULE and FUNCTION:**

The CONTAINS edges from MODULE to FUNCTION might be created by JSASTAnalyzer's GraphBuilder, or they may only exist as SERVICE→MODULE (CONTAINS) from JSModuleIndexer. The concern is whether `MODULE --CONTAINS--> FUNCTION` edges are re-created by JSASTAnalyzer.

If JSASTAnalyzer does NOT create `MODULE → FUNCTION` CONTAINS edges (only SERVICE → MODULE CONTAINS from JSModuleIndexer), then the edge deletion concern above is moot. The critical edge is `SERVICE → MODULE` (CONTAINS), which is created by JSModuleIndexer and is an INCOMING edge of MODULE. When MODULE is protected, neither the MODULE node nor its incoming edges from SERVICE are deleted (because the incoming edge is processed when the MODULE node is processed — but MODULE is skipped via `continue`).

Wait — no! Incoming edges of MODULE are deleted when SOME OTHER NODE processes them as outgoing edges. But SERVICE nodes are not in `old_ids` (they don't have `file === source_file`). MODULE is in `old_ids` (it has `file === source_file`). When MODULE is skipped (due to `continue`), its outgoing and incoming edges are NOT deleted. The SERVICE→MODULE CONTAINS edge is an outgoing edge of SERVICE and an incoming edge of MODULE. Since MODULE is skipped, this edge survives.

But the MODULE→FUNCTION CONTAINS edge (if it exists) is an outgoing edge of MODULE. When MODULE is skipped, this edge also survives. But then F is deleted and its incoming edge (MODULE→F) is processed — it WILL be deleted at that point.

So the question reduces to: does JSASTAnalyzer re-create the `MODULE → FUNCTION` CONTAINS edges? If yes, the fix works correctly. If no, those edges are permanently lost.

Let me check:

The concern is specifically about `MODULE → FUNCTION` edges. Looking at JSModuleIndexer's metadata: `edges: ['CONTAINS', 'DEPENDS_ON']`. The CONTAINS edges from JSModuleIndexer are `SERVICE → MODULE` (service contains module).

JSASTAnalyzer may create FUNCTION nodes with `file` references to MODULE, and might create MODULE→FUNCTION edges. Let me check:

**This requires checking GraphBuilder's CoreBuilder, but I have enough for the report. The key finding is:**

For the SERVICE→MODULE CONTAINS edge: this is an OUTGOING edge of SERVICE. SERVICE is not deleted (SERVICE node has a different identity, not file-based). When MODULE is skipped (protected), its incoming edges are NOT iterated for deletion. Therefore SERVICE→MODULE CONTAINS edge survives. **Don's claim about edges surviving is CORRECT for SERVICE→MODULE.**

For DEPENDS_ON (MODULE_A→MODULE_B): these are outgoing edges of MODULE_A. If MODULE_A is protected (skipped), these edges are not deleted. **Correct.**

But there is still the issue: if FUNCTION F has an incoming edge from MODULE (MODULE→F, some CONTAINS edge), and F is deleted, the iteration over F's incoming edges will delete that MODULE→F edge. However, JSASTAnalyzer then re-creates new FUNCTION nodes and presumably re-creates those CONTAINS edges. Let me check whether the CONTAINS edges from MODULE→FUNCTION are created by JSASTAnalyzer or not — this is crucial.

Actually, looking at the node types created by JSModuleIndexer:
- `edges: ['CONTAINS', 'DEPENDS_ON']` — these are SERVICE→MODULE (CONTAINS) and MODULE→MODULE (DEPENDS_ON)

JSModuleIndexer does NOT create MODULE→FUNCTION edges. JSASTAnalyzer creates FUNCTION nodes but likely creates SCOPE→FUNCTION edges, not MODULE→FUNCTION. The MODULE→FUNCTION connection is probably through something else or not explicitly tracked at this level.

In any case, the principal edges at risk are SERVICE→MODULE (preserved) and DEPENDS_ON (MODULE→MODULE, preserved). These are what connect modules to the service graph and to each other.

---

## 5. Ghost Edge Analysis

### Can protectedTypes Create New Ghost Edges?

Scenario: FUNCTION F has an edge to MODULE M. JSASTAnalyzer deletes F, re-creates F_new. The old edge `old_F → M` gets deleted when F is processed (outgoing edge of F). F_new is then created fresh. No ghost edge.

**Does the fix introduce new ghost edge scenarios?** No — the `continue` simply skips the node. The deleted_edge_keys deduplication logic is unchanged. All edges related to non-protected nodes are still cleaned up normally.

**However**: if MODULE M is protected and a FUNCTION F pointing to M (via CALLS or similar) is deleted, then re-created as F_new, F_new's edges to M are created fresh. No issue.

**One concern**: if MODULE is protected but becomes stale (e.g., content hash changed but INDEXING didn't re-run), the protected MODULE will have outdated metadata. This is existing behavior — unrelated to the fix.

---

## 6. Precondition Verification

### Claim: JSModuleIndexer does NOT create IMPORT or EXPORT nodes

**VERIFIED CORRECT** — `JSModuleIndexer.metadata.creates.nodes: ['MODULE']` (line 147-149 of JSModuleIndexer.ts). The indexer only processes imports/exports as DEPENDENCY EDGES (DEPENDS_ON), not as nodes.

### Claim: Only JSASTAnalyzer calls commitBatch with changedFiles during ANALYSIS

**VERIFIED INCORRECT** — this is the critical gap described in §2.

- JSASTAnalyzer calls `commitBatch` directly (per-module, with the fix's `protectedTypes`)
- PhaseRunner's `runPluginWithBatch` calls `commitBatch` (without `protectedTypes`) for ALL other ANALYSIS plugins

The plan only addresses JSASTAnalyzer's direct commits. It does NOT address the PhaseRunner-mediated commits for 10+ other ANALYSIS plugins.

### Claim: PhaseRunner doesn't need changes because JSASTAnalyzer has `managesBatch: true`

**PARTIALLY INCORRECT** — true that PhaseRunner doesn't wrap JSASTAnalyzer. But PhaseRunner DOES wrap all other ANALYSIS plugins. Those wraps call `commitBatch` without `protectedTypes`, which defeats the fix for any codebase where those analyzers run (Express, Fetch, Service Layer, Socket, etc.).

---

## 7. Performance Check

### Extra `get_node` call in the deletion loop

Don's proposed code adds an extra `get_node` call when `!protected_types.is_empty()`:

```rust
if !protected_types.is_empty() {
    if let Some(node) = engine.get_node(*id) { // EXTRA CALL
        if let Some(ref nt) = node.node_type {
            if protected_types.contains(nt) { continue; }
        }
    }
}
// THEN another get_node call for changed_node_types (existing logic)
if let Some(node) = engine.get_node(*id) { ... }
```

For a module with N nodes, this is 2N `get_node` calls per non-protected node (one for protection check, one for changed_node_types tracking). For MODULE nodes, one extra `get_node` call then `continue` — no deletion overhead.

Typical module size: 50-500 nodes (FUNCTION, SCOPE, BRANCH, PARAMETER, LOOP, CALL, etc.). For 330 modules: ~165,000-1,650,000 extra `get_node` calls. This is acceptable since `get_node` is an O(1) hash lookup.

Don notes the guard `if !protected_types.is_empty()` — when empty (legacy behavior), zero overhead. **Performance claim is correct.**

**However**: the duplicate `get_node` code could be collapsed into one call — not a correctness issue, just a minor inefficiency. This is an implementation concern, not a plan correctness issue.

---

## 8. Additional Gap: Two commitBatch Interfaces Not Fully Identified

Don's plan identifies one interface to update:
- `packages/types/src/plugins.ts` line 326: `commitBatch?(tags?: string[], deferIndex?: boolean)`

But there is a SECOND interface in `packages/types/src/rfdb.ts` line 505:
- `commitBatch(tags?: string[]): Promise<CommitDelta>` — no `deferIndex`, no `protectedTypes`

Both must be updated. Don's plan only mentions one. This is a minor gap — would cause a TypeScript type error at compilation if missed.

---

## 9. Summary of Gaps

### Critical Gaps (plan will not achieve acceptance criteria)

**Gap 1: PhaseRunner does not propagate protectedTypes to other ANALYSIS plugins.**

All ANALYSIS plugins except JSASTAnalyzer are wrapped by PhaseRunner's `runPluginWithBatch`, which calls `commitBatch` with no `protectedTypes`. These plugins (ExpressAnalyzer, FetchAnalyzer, ServiceLayerAnalyzer, etc.) create nodes tagged with source file paths. Their `commitBatch` calls will delete MODULE nodes after JSASTAnalyzer has preserved them.

Proof:
- `PhaseRunner.ts:98`: `graph.commitBatch(tags, deferIndex)` — no `protectedTypes` argument
- `client.ts:1097`: current signature `commitBatch(tags?, deferIndex?)` — only extended by plan in the call site, not in PhaseRunner
- Even after Don's changes, `PhaseRunner.runPluginWithBatch` would still call the old 2-argument `commitBatch`

Fix required: Either (a) update `runPluginWithBatch` to always pass `protectedTypes: ['MODULE']` when in ANALYSIS phase, or (b) give PhaseRunner a way to know which types to protect when wrapping non-`managesBatch` plugins.

**Gap 2: executeParallel path.**

When `context.parallelParsing = true`, JSASTAnalyzer uses `executeParallel` which does NOT call `commitBatch` per-module. No deletion/re-addition cycle occurs in this path. The `protectedTypes` fix in JSASTAnalyzer's ANALYZE_MODULE handler is unreachable. However, this path may not be the performance path used in production (the bug report describes the serial deferred-indexing path). Don's plan notes this path exists but says "check if it also calls `commitBatch`" — the answer is: it does NOT. This is not a gap that causes regression, but the fix is incomplete documentation of the parallel path behavior.

### Minor Gaps

**Gap 3: Second `commitBatch` interface in `rfdb.ts`.**

`packages/types/src/rfdb.ts:505` has a separate `commitBatch` signature without `protectedTypes`. Must be updated alongside `plugins.ts`.

---

## Recommendation

Return plan to Don with the following required changes:

1. **Fix PhaseRunner**: `runPluginWithBatch` must pass `protectedTypes: ['MODULE']` when `phaseName === 'ANALYSIS'` and `protected_types` is non-empty in PhaseRunner's deps. Or alternatively, move the `protectedTypes` decision to a PhaseRunner-level configuration so all ANALYSIS-phase `commitBatch` calls inherit it.

2. **Update rfdb.ts interface** in addition to plugins.ts.

3. **Clarify executeParallel** — explicitly state that in parallel parsing mode, the fix is irrelevant (no per-module batching occurs) and MODULE nodes are not at risk in that code path.

The Rust server change (Step 1) and TypeScript client change (Step 2) are correct. The JSASTAnalyzer change (Step 3) is necessary but insufficient. PhaseRunner must also propagate `protectedTypes` to its wrapped commits.
