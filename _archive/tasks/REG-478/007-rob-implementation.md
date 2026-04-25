# Rob Pike -- Implementation Report: REG-478

**Date:** 2026-02-16
**File changed:** `packages/core/src/Orchestrator.ts`

## Changes Made

### Change 1: `run()` method -- single-root ANALYSIS (lines 237-249)

Replaced per-unit `runBatchPhase('ANALYSIS', unitsToProcess, manifest)` with global `runPhase('ANALYSIS', { manifest, graph, workerCount: 1 })`.

- Comment updated: "PHASE 2: ANALYSIS (global, like ENRICHMENT)"
- Progress message: "Analyzing all modules..." with `totalFiles: 0, processedFiles: 0` (matches ENRICHMENT pattern)
- Added timing log: `logger.info('ANALYSIS phase complete', ...)`
- ParallelRunner branch unchanged (already global)
- `workerCount: 1` -- see "Bug Found" section below

### Change 2a: `runMultiRoot()` -- remove per-root ANALYSIS (lines 302-304)

Removed `if (!this.indexOnly) { await this.runBatchPhase('ANALYSIS', ...) }` from the per-root loop. Comment updated to "INDEXING phase for this root (per-unit, needs service context)".

### Change 2b: `runMultiRoot()` -- add global ANALYSIS (lines 337-349)

Added global ANALYSIS **after** the `indexOnly` early return (line 334), **before** `runPipelineEpilogue` (line 352). Per Dijkstra's correction:
- No `if (!this.indexOnly)` wrapper -- already protected by the early return above
- Includes ParallelRunner branch
- Matches single-root implementation exactly

### Change 3: `runBatchPhase()` docstring (lines 360-365)

Updated to document INDEXING-only usage: "Run INDEXING phase per-unit in batches. Used only for INDEXING (requires service context for DFS). ANALYSIS now runs globally like ENRICHMENT."

## Bug Found During Implementation

**Issue:** Initial implementation passed `workerCount: this.workerCount` (default 10) to `runPhase('ANALYSIS', ...)`. This caused 8 test failures (6 snapshot tests + 1 callback test + their parent suite).

**Root cause:** `JSASTAnalyzer` uses `context.workerCount` to configure its internal `WorkerPool` concurrency. With `workerCount: 10`, up to 10 modules are analyzed concurrently via `Promise.all`. The concurrent graph writes cause race conditions in the RFDB backend, resulting in missing `HAS_CALLBACK` edges and other graph mutations.

The old `runBatchPhase` always passed `workerCount: 1` (line 403), processing one module at a time sequentially. This was unintentional but safe.

**Fix:** Set `workerCount: 1` in both `run()` and `runMultiRoot()` ANALYSIS calls, with a comment explaining why. This preserves the previous sequential module analysis behavior.

**Note:** This is existing tech debt -- `ParallelAnalysisRunner` exists specifically for concurrent analysis with proper worker thread isolation. The in-process `WorkerPool` with concurrent graph writes was never safe at `workerCount > 1`. This should be a separate issue if concurrent ANALYSIS is desired.

## Test Results

### Targeted tests
- `OrchestratorStrictSuppressed.test.js`: 5/5 pass
- `OrchestratorMultiRootStrict.test.js`: 2/2 pass

### Full unit suite
```
# tests 2031
# suites 857
# pass 2004
# fail 0
# cancelled 0
# skipped 5
# todo 22
# duration_ms 130923
```

All 2004 tests pass. 0 failures. 5 skipped and 22 todo are pre-existing.

## Diff Summary

Net effect: +17 lines, -7 lines in `Orchestrator.ts`.

| Section | Lines changed | Description |
|---------|--------------|-------------|
| `run()` ANALYSIS block | 237-249 | `runBatchPhase` -> `runPhase` with timing |
| `runMultiRoot()` per-root loop | 302-304 | Removed per-root ANALYSIS (3 lines deleted) |
| `runMultiRoot()` global ANALYSIS | 337-349 | New block after indexOnly barrier |
| `runBatchPhase()` docstring | 360-365 | Updated to document INDEXING-only usage |
