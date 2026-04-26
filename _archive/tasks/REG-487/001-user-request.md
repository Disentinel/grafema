# REG-487: Disable RFDB indexing during initial analysis, index in background after

## Problem

Per-module batch commits (v0.2.11) correctly write data incrementally during ANALYSIS phase to prevent connection timeouts. However, RFDB server-side indexing runs on every `commitBatch`, causing O(n²) performance as the graph grows — each commit's index update gets slower with graph size. On grafema itself (330 modules), analysis takes 22+ minutes instead of ~2 minutes.

Additionally, with WorkerPool running 10 parallel async workers, multiple workers call `beginBatch`/`commitBatch` on the same shared RFDB client, causing race conditions on batch state (`_batching` flag, `_batchNodes`/`_batchEdges` buffers).

## Proposed Solution

1. **Orchestrator must distinguish initial vs incremental analysis** — initial = `--clear` or first run (no existing graph), incremental = subsequent runs with existing graph
2. **During initial analysis**: disable server-side indexing on commits. RFDB should accept data without building indexes.
3. **After all phases complete**: trigger background indexing. The graph is fully populated, indexes can be built once.
4. **During incremental analysis**: keep current behavior (indexes maintained per-commit, since changes are small).

This requires:
- RFDB protocol extension: `setIndexMode('deferred' | 'immediate')` or similar
- Orchestrator flag: pass `initialAnalysis: boolean` into PluginContext or handle at PhaseRunner level
- Background index build: `buildIndexes()` async call after flush

## Race condition (parallel workers)

Separate from indexing: 10 parallel WorkerPool workers sharing one RFDB client's batch state is fundamentally broken. Fix options:
- Serialize workers (workerCount=1) when batching
- Give each worker its own batch buffer, merge at commit time
- Remove batch management from workers entirely

## Acceptance Criteria

- [ ] `grafema analyze --clear` on grafema itself completes in <3 minutes
- [ ] Per-module commits still happen (no connection timeouts)
- [ ] Incremental re-analysis keeps indexes up to date
- [ ] No race conditions with parallel workers
