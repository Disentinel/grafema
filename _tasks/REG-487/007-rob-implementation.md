# Rob Pike -- Implementation Report: REG-487

**Task:** Deferred RFDB Indexing + Batch Race Fix
**Date:** 2026-02-17
**Branch:** `task/REG-487`

## Summary

Implemented deferred RFDB indexing to eliminate O(n^2) index rebuilding during `grafema analyze --clear` on large codebases. Previously, each per-module `commitBatch` triggered a full `flush()` that rebuilt ALL secondary indexes from scratch. For 330 modules, this meant 330 index rebuilds on growing data (~5.5 million node iterations, ~15 minutes). Now, per-module commits use `flush_data_only()` (writes data to disk, skips index rebuild), and a single `rebuild_indexes()` runs once when bulk load completes.

Also implemented `BatchHandle` class for isolated per-worker batch buffers (future parallel work), though the parallel `workerCount > 1` increase was deferred (see Deferred Work below).

## Changes by File

### Rust Layer (RFDB Server)

**`packages/rfdb-server/src/graph/engine.rs`** (lines 1296-1481)
- Added `flush_data_only()` (~145 lines): Same data collection and disk write as `flush()` but skips `index_set.rebuild_from_segment()` and adjacency/reverse_adjacency/edge_keys rebuild. Reloads segments so data is readable but indexes are stale.
- Added `rebuild_indexes()` (~35 lines): Clears and rebuilds `index_set`, `adjacency`, `reverse_adjacency`, `edge_keys` from current segments. Single O(n) pass over all data.

**`packages/rfdb-server/src/graph/mod.rs`**
- Added `flush_data_only()` to `GraphStore` trait with default implementation delegating to `flush()` (backward-compatible).
- Added `rebuild_indexes()` as required trait method.

**`packages/rfdb-server/src/graph/engine_v2.rs`**
- Added stub `rebuild_indexes()` that delegates to `flush()` (V2 manages indexes internally).

**`packages/rfdb-server/src/bin/rfdb_server.rs`**
- Added `defer_index: bool` field to `CommitBatch` variant with `#[serde(default, rename = "deferIndex")]` -- backward-compatible, old clients default to `false`.
- Added `RebuildIndexes` variant to `Request` enum.
- Updated `handle_commit_batch()` to call `flush_data_only()` when `defer_index == true`, otherwise `flush()`.
- Added `Request::RebuildIndexes` match arm calling `engine.rebuild_indexes()`.

### TypeScript Layer

**`packages/types/src/rfdb.ts`**
- Added `'rebuildIndexes'` to `RFDBCommand` union type.

**`packages/types/src/plugins.ts`**
- Added `deferIndexing?: boolean` to `PluginContext` interface.
- Added `rebuildIndexes?(): Promise<void>` and `createBatch?(): unknown` to `GraphBackend` interface.
- Updated `commitBatch?` signature to accept optional `deferIndex` parameter.

**`packages/rfdb/ts/client.ts`**
- Refactored `commitBatch()` to extract chunking logic into `_sendCommitBatch()` helper.
- Added `deferIndex` parameter to both `commitBatch()` and `_sendCommitBatch()`.
- Added `rebuildIndexes()` method.
- Added `createBatch(): BatchHandle` factory method.
- Added `BatchHandle` class (exported) with isolated `_nodes/_edges/_files` buffers, `addNode()`, `addEdge()`, `addFile()`, `commit()`, `abort()` methods.

**`packages/rfdb/ts/index.ts`**
- Added `BatchHandle` to exports.

**`packages/core/src/storage/backends/RFDBServerBackend.ts`**
- Added `rebuildIndexes()` method delegating to client.
- Added `createBatch()` method delegating to client.
- Updated `commitBatch()` to pass `deferIndex` parameter through.

**`packages/core/src/PhaseRunner.ts`**
- Added `deferIndexing?: boolean` to `PhaseRunnerDeps` interface.
- Added `deferIndexing` to `buildPluginContext()` output.
- Updated `runPluginWithBatch()` to pass `deferIndex` to `graph.commitBatch()`.

**`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`**
- Captures `deferIndex` from context before pool registration.
- Passes `deferIndex` to per-module `commitBatch()` calls.
- After `pool.processQueue()` completes, calls `graph.rebuildIndexes()` if deferring was active.

**`packages/core/src/Orchestrator.ts`**
- Added `_deferIndexing: boolean` field.
- Detection logic: `deferIndexing = forceAnalysis || (nodeCount === 0)` -- only defers during initial/full analysis.
- Calls `rebuildIndexes()` after INDEXING phase in both `run()` and `runMultiRoot()`.
- Passes `deferIndexing` to ANALYSIS phase context.
- Resets `_deferIndexing = false` before ENRICHMENT/VALIDATION.
- Added `_isEmptyGraph()` helper.
- Added `_updatePhaseRunnerDeferIndexing()` helper to recreate PhaseRunner with updated deps.

## Two Rebuild Points

Per Dijkstra's plan verification (005-plan-revision.md):

1. **After INDEXING phase** (in `Orchestrator.run()` / `runMultiRoot()`): Indexes rebuilt so ANALYSIS phase can query them.
2. **After ANALYSIS module pool completes** (in `JSASTAnalyzer.execute()`): Indexes rebuilt after all per-module deferred commits.

The Orchestrator resets `_deferIndexing = false` after ANALYSIS, so ENRICHMENT and VALIDATION phases use normal `flush()` with index rebuild (they do fewer commits and need fresh indexes for queries).

## Test Results

- **Rust:** 653 tests pass, 0 failures (587 unit + 57 protocol + 9 crash recovery; stress tests running separately)
- **TypeScript:** 2058 tests pass, 0 failures, 5 skipped, 22 todo

## Deferred Work

**Parallel `workerCount > 1` for ANALYSIS phase** was not implemented because `analyzeModule()` calls `graph.addNode()`/`graph.addEdge()` through `GraphBuilder.build()`, which uses the shared `RFDBClient` instance. Redirecting these calls to per-worker `BatchHandle` instances would require deep refactoring of `analyzeModule`, `GraphBuilder`, and all graph call sites within. The `BatchHandle` class is ready for this future work, but the actual parallelization requires a separate task.

The primary performance win is the deferred indexing optimization: reducing 330 index rebuilds to 2 during full analysis. This is the dominant cost factor (~15 minutes on large codebases).

## Protocol Backward Compatibility

- `deferIndex` uses `#[serde(default)]` so old clients that don't send it get `false` (normal flush behavior).
- `RebuildIndexes` is a new command that old clients never send.
- `commitBatch()` and `GraphBackend.commitBatch?()` accept optional `deferIndex` parameter -- existing callers without the parameter get `false`.
- `rebuildIndexes?()` and `createBatch?()` are optional on `GraphBackend` -- only `RFDBServerBackend` implements them.
