# Dijkstra Plan Verification — REG-487

**Verdict: REJECT**

Two critical correctness gaps found. The deferred-index invariant is violated by other ANALYSIS plugins. The multi-root path is unaddressed. Both would produce silent data corruption (wrong/empty queryNodes results) without any error surfaced to the user.

---

## 1. "When to Defer" Logic — Completeness Table

Plan states: `forceAnalysis=true → defer` / `forceAnalysis=false AND empty → defer` / `forceAnalysis=false AND has data → no defer`.

| forceAnalysis | Graph State | Phase | Expected behavior | Plan handles? |
|---|---|---|---|---|
| true | empty (--clear was called) | ANALYSIS | defer | YES — `this.forceAnalysis` is true |
| true | non-empty (edge case: --clear failed or race) | ANALYSIS | defer | YES — condition is purely flag-based, independent of actual state |
| false | empty (first run, no --clear) | ANALYSIS | defer | YES — `isEmptyGraph()` check before analysis |
| false | non-empty (incremental) | ANALYSIS | no defer | YES — `isEmptyGraph()` returns false |
| false | non-empty | ENRICHMENT | no defer | YES — only ANALYSIS defers, ENRICHMENT always uses normal commitBatch |
| false | non-empty | INDEXING | no defer | YES — plan explicitly out-of-scope for INDEXING |
| any | any | multi-root runMultiRoot() | defer? | **NO — see Gap 1 below** |

**Precondition issue**: `isEmptyGraph()` is called BEFORE `runBatchPhase('INDEXING', ...)`. INDEXING writes MODULE nodes. So at the time `isEmptyGraph()` is evaluated, the graph is empty after `graph.clear()`. This is correct: the empty check happens at the right moment. VERIFIED OK.

**Timing issue**: `this._deferIndexing` is computed once at run start. Confirmed by Orchestrator.ts:178–182 (clear happens before `isEmptyGraph()` is called). VERIFIED OK.

---

## 2. Index Correctness During Deferred Mode — CRITICAL REJECTION POINT

### 2a. JSASTAnalyzer `getModuleNodes()` — SAFE

`getModuleNodes` (JSASTAnalyzer.ts:1315–1321) calls `graph.queryNodes({ type: 'MODULE' })`. MODULE nodes are written by the INDEXING phase, which uses normal `flush()` (not deferred). Their indexes are fully built before ANALYSIS begins. SAFE.

### 2b. JSASTAnalyzer `shouldAnalyzeModule()` — SAFE (plan's claim correct)

`shouldAnalyzeModule` (JSASTAnalyzer.ts:306–340): when `forceAnalysis=true`, returns `true` immediately at line 307-308 without calling `queryNodes`. The `queryNodes({ type: 'FUNCTION', file: ... })` at line 333 is inside the `else` branch that only executes when `forceAnalysis=false`. With `deferIndexing=true`, `forceAnalysis` is always true (or graph was empty). SAFE.

### 2c. OTHER ANALYSIS PLUGINS — CRITICAL FAILURE (Gap 1)

The plan claims "ANALYSIS only queries the delta (in-memory), so deferred indexing is safe." This is FALSE. Multiple other ANALYSIS plugins query the graph for FUNCTION and other nodes written by JSASTAnalyzer, AFTER JSASTAnalyzer commits them with deferred indexes:

| Plugin | queryNodes call | What it queries | Status |
|---|---|---|---|
| `SQLiteAnalyzer.ts:310` | `graph.queryNodes({ type: 'FUNCTION', file: module.file })` | Functions written by JSASTAnalyzer | **BROKEN** |
| `SocketAnalyzer.ts:167` | `graph.queryNodes({ type: 'FUNCTION', file: module.file! })` | Functions written by JSASTAnalyzer | **BROKEN** |
| `SocketAnalyzer.ts:171` | `graph.queryNodes({ type: 'CALL', file: module.file! })` | Calls written by JSASTAnalyzer | **BROKEN** |
| `FetchAnalyzer.ts:331` | `graph.queryNodes({ type: 'FUNCTION', file: module.file! })` | Functions written by JSASTAnalyzer | **BROKEN** |
| `FetchAnalyzer.ts:335` | `graph.queryNodes({ type: 'CALL', file: module.file! })` | Calls written by JSASTAnalyzer | **BROKEN** |
| `ExpressRouteAnalyzer.ts:441` | `graph.queryNodes(...)` | Nodes written by earlier analysis | **BROKEN** |
| `DatabaseAnalyzer.ts:123` | `graph.queryNodes({ type: 'FUNCTION', file })` | Functions written by JSASTAnalyzer | **BROKEN** |
| `ServiceLayerAnalyzer.ts:374` | `graph.queryNodes({ type: 'SERVICE_CLASS', ... })` | Nodes from ANALYSIS | **BROKEN** |
| `NestJSRouteAnalyzer.ts:130` | `graph.queryNodes(filter)` | ANALYSIS nodes | **BROKEN** |
| `ExpressResponseAnalyzer.ts:69,423,431,443` | Multiple `queryNodes` calls | ANALYSIS nodes | **BROKEN** |
| `GraphBuilder.ts:594` | `graph.queryNodes(...)` (called from analyzeModule) | CLASS nodes | **potentially BROKEN** |
| `JSASTAnalyzer.ts:333` | `graph.queryNodes({ type: 'FUNCTION', file })` in `shouldAnalyzeModule` | But only when forceAnalysis=false | SAFE (as above) |

**Root cause**: After `commitBatch(..., deferIndex=true)`, the RFDB server calls `flush_data_only()`. The delta is flushed to segment, but `index_set` is NOT rebuilt. Subsequent `queryNodes` calls use `find_by_attr()` (engine.rs:805), which:
1. Searches `delta_nodes` — EMPTY (delta was cleared by flush)
2. Searches segment via `index_set` — RETURNS NOTHING (index not rebuilt yet)

This means ALL queryNodes calls during the deferred window return EMPTY RESULTS. The downstream ANALYSIS plugins (SQLiteAnalyzer, SocketAnalyzer, FetchAnalyzer, etc.) all run WITHIN `runPhase('ANALYSIS', ...)` — they run after JSASTAnalyzer (due to `dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']`), but BEFORE the plan's proposed `rebuildIndexes()` call which happens AFTER the entire ANALYSIS phase completes.

Verified: All secondary ANALYSIS plugins declare `dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']` (SQLiteAnalyzer.ts:64, SocketAnalyzer.ts:77). PhaseRunner runs them in topological order. JSASTAnalyzer finishes all 330 deferred commits, then SQLiteAnalyzer/SocketAnalyzer/etc. start — and find an empty index.

**Consequence**: On the first `grafema analyze --clear`, all SQLite queries, socket detection, fetch analysis, and database analysis yield empty results. The graph is built, but enrichment/analysis pass silently produces wrong output. No error is thrown — plugins just find no functions and produce no relationships.

### 2d. JSASTAnalyzer `analyzeModule` — INTERNAL QUERY

`GraphBuilder.ts:594` calls `graph.queryNodes(...)` for CLASS nodes from within `analyzeModule`. This is called while a BatchHandle is active (the module's own batch). At that point, the CLASS nodes for OTHER modules have been flushed with deferred index. The CLASS nodes for the CURRENT module haven't been committed yet (they're in the BatchHandle). So:
- Current module's classes: in the BatchHandle, visible via delta ONLY to the current batch owner (not to the server yet)
- Other modules' classes: flushed to segment but NOT indexed

This could break cross-module class lookups in GraphBuilder. Needs analysis of whether CLASS cross-module queries happen during analyzeModule.

---

## 3. BatchHandle Race Freedom

### 3a. BatchHandle isolation — CORRECT

BatchHandle stores state in private instance fields (`_nodes`, `_edges`, `_files`). Each worker creates its own BatchHandle. Workers are async coroutines (same event loop thread). No concurrent mutation of BatchHandle fields is possible since JavaScript is single-threaded.

### 3b. Concurrent `_sendCommitBatch` calls — CORRECT

Multiple `BatchHandle.commit()` calls at `await` points will each call `_sendCommitBatch`. Each `_send` creates a Promise, writes to the socket, and puts a resolve function in `this.pending`. The server (`handle_client`, rfdb_server.rs:1922) processes one client's requests sequentially in a single `loop`. Multiple concurrent `_send` calls from the same client will be queued at the socket level and processed one at a time. The `pending` map correlates responses by `requestId`. This is safe.

**However**: The plan says `BatchHandle.commit()` calls `this.client._sendCommitBatch(...)`. This is an INTERNAL method that doesn't exist yet — it needs to be extracted from `commitBatch()`. The current `commitBatch()` checks `if (!this._batching) throw`. The new `_sendCommitBatch` must bypass this check. This is an implementation detail but must be done carefully to not break the existing `commitBatch()` path.

### 3c. Concurrent BatchHandle commits + server-side engine locking

The RFDB server uses `Arc<RwLock<dyn GraphStore>>` for the engine. `with_engine_write` takes a write lock. Two concurrent `commitBatch` requests from the same client connection are serialized by the server's sequential `read_message` loop — no simultaneous write locks possible from the same connection. SAFE.

---

## 4. Protocol Compatibility

Completeness table for existing `commitBatch` callers:

| Caller | Current behavior | After change | Compatible? |
|---|---|---|---|
| `JSASTAnalyzer` (main path) | `graph.beginBatch()` + `graph.commitBatch()` | `BatchHandle.commit(tags, deferIndex)` | YES — plan explicitly replaces this |
| `PhaseRunner.runPluginWithBatch()` (line 92,95) | `graph.beginBatch()` + `graph.commitBatch(tags)` | Unchanged | YES — still calls instance `commitBatch` |
| Old `commitBatch(tags)` signature | `commitBatch(tags?: string[])` | `commitBatch(tags?: string[], deferIndex?: boolean)` | YES — optional param, backwards compatible |
| Old client omitting `deferIndex` | Server gets no field | Server uses `#[serde(default)]` → false | YES |
| `RebuildIndexes` command (new) | Did not exist | New handler added | YES — new command |
| `BatchHandle` callers (new) | Did not exist | New class | YES — additive |

**Gap**: `GraphBackend` interface — the plan adds `rebuildIndexes()` and `createBatch()` as optional methods checked before use. The plan says "callers check for existence before using them, consistent with the existing `beginBatch`/`commitBatch` checks." This is consistent with the existing pattern (PhaseRunner.ts:81). SAFE.

---

## 5. INDEXING Phase — Is <3 Min Target Achievable?

The plan explicitly defers INDEXING optimization. Let me enumerate the timeline:

INDEXING phase: runs `JSModuleIndexer` per unit. For a 330-module codebase, this also does per-module commits with full `flush()`. If INDEXING accounts for a significant portion of the 15-minute total, fixing only ANALYSIS may not achieve <3 min.

**Plan acknowledges this**: "Not changing INDEXING phase... if INDEXING proves slow, it becomes REG-488."

The acceptance criterion is `grafema analyze --clear` < 3 minutes. Without benchmarking, we cannot verify this criterion is achievable with INDEXING still doing O(n²). The plan should either:
1. Benchmark INDEXING separately to confirm it's not the bottleneck, OR
2. Hedge the acceptance criterion

**Verdict**: This is a risk, not a correctness gap. The plan correctly notes REG-488 as a potential follow-up. ACCEPTABLE with caveat.

---

## 6. Edge Cases

### 6a. Empty project (0 modules) with --clear

`forceAnalysis=true` → `deferIndexing=true`. ANALYSIS runs over 0 modules (WorkerPool processes empty queue). `rebuildIndexes()` is called on an empty segment. This should be safe — rebuilding an empty segment produces empty indexes. SAFE.

### 6b. Single module project

One module analyzed, one deferred commit. `rebuildIndexes()` called after. SAFE.

### 6c. RebuildIndexes called without any prior deferred commits

`rebuildIndexes()` is called unconditionally if `this._deferIndexing=true`, even if all modules were cached and produced 0 commits. This just rebuilds the existing index (no-op if nothing changed). SAFE.

### 6d. RebuildIndexes called twice

If somehow called twice, the second call re-scans the already-built index and produces the same result. Idempotent. SAFE.

### 6e. Process crash between deferred commit and rebuildIndexes

Data is flushed to segment (persisted) but index is not built. On restart, RFDB server loads the segment. What happens? The existing server startup likely calls `flush()` or `rebuild_from_segment()` on load. This needs verification — if the server does NOT rebuild indexes on startup, the recovered graph would have orphaned segment data without index. **UNKNOWN — needs verification.** For `--clear` use case, the user would re-run `analyze --clear` anyway, so this is acceptable in practice.

### 6f. Incremental analysis after initial analysis with deferred mode

Second run: `forceAnalysis=false`, `isEmptyGraph()=false` → `deferIndexing=false`. Normal path. SAFE.

### 6g. Mixed deferred/non-deferred

With `deferIndexing=true`, ALL modules go through deferred path. There is no "some deferred, some not" — the flag is global. SAFE.

### 6h. runMultiRoot() — GAP 2

The plan adds `rebuildIndexes()` after `runPhase('ANALYSIS', ...)` in `Orchestrator.run()` (line ~248). But `runMultiRoot()` (line 344) has a separate `runPhase('ANALYSIS', ...)` call. The plan does NOT show the `rebuildIndexes` addition to `runMultiRoot()`.

If a multi-root workspace uses `--clear`, the deferred indexing fix would apply but `rebuildIndexes()` would never be called in the multi-root path. ANALYSIS plugins downstream of JSASTAnalyzer would find empty indexes.

**Gap**: The fix must also be applied to `runMultiRoot()` at Orchestrator.ts:344.

---

## Summary of Gaps

### Gap 1 — CRITICAL: Other ANALYSIS plugins query stale indexes (BLOCKS implementation)

The plan's safety invariant ("ANALYSIS only queries the delta") is FALSE. Plugins including SQLiteAnalyzer, SocketAnalyzer, FetchAnalyzer, DatabaseAnalyzer, ServiceLayerAnalyzer, ExpressRouteAnalyzer, NestJSRouteAnalyzer, and ExpressResponseAnalyzer all call `queryNodes()` for FUNCTION/CALL/etc. nodes written by JSASTAnalyzer — AFTER JSASTAnalyzer's deferred commits, BEFORE `rebuildIndexes()`.

**Root cause**: `rebuildIndexes()` is called after the ENTIRE `runPhase('ANALYSIS', ...)` completes, but the downstream ANALYSIS plugins run WITHIN that phase.

**Required fix**: One of:
- Option A: Call `rebuildIndexes()` between JSASTAnalyzer completing and the next ANALYSIS plugin starting. This requires PhaseRunner awareness of the deferred-index barrier — complex to implement cleanly.
- Option B: After JSASTAnalyzer commits all modules, trigger `rebuildIndexes()` WITHIN the ANALYSIS phase, before other plugins run. Since JSASTAnalyzer runs first (toposort), this means JSASTAnalyzer itself calls `rebuildIndexes()` at the end of its `execute()` method (after all module commits). The Orchestrator-level `rebuildIndexes()` would then be redundant (a second no-cost rebuild or skipped).
- Option C: Restrict deferred indexing to ONLY JSASTAnalyzer (the only plugin with per-module commits). All other ANALYSIS plugins run with normal (non-deferred) behavior. JSASTAnalyzer triggers its own `rebuildIndexes()` at the end of `execute()`. Orchestrator does NOT need a separate call.

Option C is the simplest and safest: JSASTAnalyzer defers its own commits, rebuilds at the end of its own `execute()`, and all downstream ANALYSIS plugins see correct indexes.

### Gap 2 — HIGH: runMultiRoot() path missing rebuildIndexes call (BLOCKS implementation)

The proposed `rebuildIndexes()` call in `Orchestrator.run()` at line ~248 has no equivalent in `runMultiRoot()` (line ~344). Multi-root workspace analysis with `--clear` would produce wrong results.

**Required fix**: Apply the same `rebuildIndexes()` logic to `runMultiRoot()`.

---

## Completeness Tables

### Table 1: "When to Defer" State Machine

| State | Handled | Verdict |
|---|---|---|
| forceAnalysis=true, run() | YES | CORRECT |
| forceAnalysis=false, empty, run() | YES | CORRECT |
| forceAnalysis=false, non-empty, run() | YES | CORRECT |
| forceAnalysis=true, runMultiRoot() | PARTIAL — deferred, but no rebuild | BROKEN (Gap 2) |
| forceAnalysis=false, empty, runMultiRoot() | PARTIAL | BROKEN (Gap 2) |

### Table 2: queryNodes Calls During Deferred ANALYSIS

| Plugin | Query | Index at call time | Safe? |
|---|---|---|---|
| JSASTAnalyzer:getModuleNodes | MODULE nodes (from INDEXING) | Built by INDEXING's full flush | SAFE |
| JSASTAnalyzer:shouldAnalyzeModule | FUNCTION nodes | Bypassed when forceAnalysis=true | SAFE |
| SQLiteAnalyzer:310 | FUNCTION nodes (from JSASTAnalyzer) | STALE — deferred | **BROKEN** |
| SocketAnalyzer:167,171 | FUNCTION, CALL nodes | STALE — deferred | **BROKEN** |
| FetchAnalyzer:331,335 | FUNCTION, CALL nodes | STALE — deferred | **BROKEN** |
| DatabaseAnalyzer:123 | FUNCTION nodes | STALE — deferred | **BROKEN** |
| ServiceLayerAnalyzer:374 | SERVICE_CLASS nodes | STALE — deferred | **BROKEN** |
| ExpressRouteAnalyzer:441 | Nodes from JSASTAnalyzer | STALE — deferred | **BROKEN** |
| NestJSRouteAnalyzer:130 | Various | STALE — deferred | **BROKEN** |
| ExpressResponseAnalyzer:69,423,431,443 | http:route and other nodes | STALE — deferred | **BROKEN** |

### Table 3: Backwards Compatibility

| Caller | Compatible? | Notes |
|---|---|---|
| PhaseRunner.runPluginWithBatch | YES | Uses instance commitBatch, unchanged |
| Old clients (no deferIndex field) | YES | #[serde(default)] → false |
| graphInitializer.init() batch operations | YES | Not affected |
| ENRICHMENT phase batches | YES | Plan explicitly excludes these |
| VALIDATION phase batches | YES | Plan explicitly excludes these |
| Existing test suite | RISK | Need to verify existing ClearAndRebuild tests |

---

## Verdict

**REJECT**

Two gaps must be addressed before implementation:

1. **Gap 1 (CRITICAL)**: Move `rebuildIndexes()` call to the end of `JSASTAnalyzer.execute()` (after all per-module deferred commits), not to the Orchestrator level. This ensures all downstream ANALYSIS plugins see correct indexes. Alternatively, have the Orchestrator call `rebuildIndexes()` between phases within ANALYSIS — but this requires deeper changes to PhaseRunner.

2. **Gap 2 (HIGH)**: Add `rebuildIndexes()` call to `runMultiRoot()` after its `runPhase('ANALYSIS', ...)`, mirroring the fix in `run()`.

The rest of the plan (BatchHandle design, protocol changes, INDEXING scope decision, backwards compatibility) is sound and should proceed once these two gaps are addressed.
