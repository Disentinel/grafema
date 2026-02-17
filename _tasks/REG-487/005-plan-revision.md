# REG-487: Plan Revision — Addressing Dijkstra's Gaps

## Changes from Original Plan (003-don-plan.md)

### Gap 1 Fix: Move rebuildIndexes() into JSASTAnalyzer.execute()

**Problem**: The original plan placed `rebuildIndexes()` in the Orchestrator AFTER `runPhase('ANALYSIS')` completes. But downstream ANALYSIS plugins (SQLiteAnalyzer, SocketAnalyzer, FetchAnalyzer, etc.) run WITHIN the ANALYSIS phase and query nodes written by JSASTAnalyzer. They'd find empty results with stale indexes.

**Fix**: JSASTAnalyzer calls `graph.rebuildIndexes()` at the end of its `execute()` method, after `pool.processQueue(queue)` completes (~line 443), BEFORE returning. Since PhaseRunner runs plugins in dependency order (JSASTAnalyzer first, then dependents), all downstream plugins see rebuilt indexes.

```typescript
// In JSASTAnalyzer.execute(), after pool.processQueue(queue):
await pool.processQueue(queue);
clearInterval(progressInterval);

// Rebuild indexes after all deferred commits (REG-487)
if (context.deferIndexing && graph.rebuildIndexes) {
    logger.info('Rebuilding indexes after deferred bulk load...');
    await graph.rebuildIndexes();
}
```

### Gap 2 Fix: Automatic — No runMultiRoot() Change Needed

Since `rebuildIndexes()` is inside JSASTAnalyzer (not Orchestrator), it works identically in both `run()` and `runMultiRoot()` paths. No Orchestrator changes needed for the rebuild call.

### Orchestrator Changes (Simplified)

The Orchestrator still needs to:
1. Detect initial analysis: `deferIndexing = forceAnalysis || (nodeCount === 0)`
2. Pass `deferIndexing` through `PhaseRunnerDeps` → `PluginContext`
3. Pass higher `workerCount` when BatchHandle is available

But it does NOT need to call `rebuildIndexes()` itself.

### INDEXING Phase Deferred Indexing

The INDEXING phase also does per-module commits. But:
- INDEXING writes MODULE nodes, which are needed by JSASTAnalyzer's `getModuleNodes()`
- JSASTAnalyzer queries MODULE nodes at the start of its `execute()`
- If INDEXING deferred its indexes, MODULE nodes wouldn't be queryable

**Decision**: Apply deferred indexing to INDEXING phase too, BUT add `rebuildIndexes()` at the end of the INDEXING batch phase (in `runBatchPhase`), before ANALYSIS starts. This is safe because nothing queries INDEXING results between the last INDEXING commit and the ANALYSIS phase start.

Actually — simpler approach: Apply `deferIndex` to the INDEXING phase's `commitBatch` calls too. The `runBatchPhase()` method in Orchestrator already wraps each unit in a batch. Add `rebuildIndexes()` call after `runBatchPhase('INDEXING')` returns. This is the ONE Orchestrator-level rebuild call:

```typescript
// In Orchestrator.run() and runMultiRoot():
await this.runBatchPhase('INDEXING', units);

// Rebuild indexes after deferred INDEXING commits
if (this._deferIndexing && this.graph.rebuildIndexes) {
    this.logger.info('Rebuilding indexes after INDEXING phase...');
    await this.graph.rebuildIndexes();
}

// ANALYSIS phase — JSASTAnalyzer will rebuild indexes itself after all module commits
await this.runPhase('ANALYSIS', { ... deferIndexing: this._deferIndexing });
```

This means:
- INDEXING: deferred commits → Orchestrator rebuilds → MODULE nodes queryable
- ANALYSIS (JSASTAnalyzer): deferred commits → JSASTAnalyzer rebuilds → FUNCTION/CALL/CLASS nodes queryable
- ANALYSIS (downstream): sees rebuilt indexes from both INDEXING and JSASTAnalyzer
- ENRICHMENT/VALIDATION: all indexes fully built, normal operation

## Updated File Changes Summary

| # | File | Change |
|---|------|--------|
| 1 | `rfdb-server/src/graph/engine.rs` | Add `flush_data_only()` + `rebuild_indexes()` |
| 2 | `rfdb-server/src/graph/mod.rs` | Add to `GraphStore` trait |
| 3 | `rfdb-server/src/bin/rfdb_server.rs` | `deferIndex` on CommitBatch + `RebuildIndexes` command |
| 4 | `packages/rfdb/ts/client.ts` | `deferIndex` param, `rebuildIndexes()`, `BatchHandle`, `createBatch()` |
| 5 | `packages/core/src/storage/backends/RFDBServerBackend.ts` | Expose `rebuildIndexes()`, `createBatch()` |
| 6 | `packages/core/src/plugins/Plugin.ts` | `deferIndexing?: boolean` in PluginContext |
| 7 | `packages/core/src/PhaseRunner.ts` | `deferIndexing` in PhaseRunnerDeps, pass to context, pass to commitBatch |
| 8 | `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | BatchHandle pattern + `rebuildIndexes()` after pool completes |
| 9 | `packages/core/src/Orchestrator.ts` | Detect initial analysis, `deferIndexing` flag, `rebuildIndexes()` after INDEXING, higher `workerCount` |

## Rebuild Points (2 total)

1. **After INDEXING phase** — Orchestrator calls `graph.rebuildIndexes()` in both `run()` and `runMultiRoot()`
2. **After JSASTAnalyzer module analysis** — JSASTAnalyzer calls `graph.rebuildIndexes()` within its `execute()`

Both are conditional on `deferIndexing === true`.
