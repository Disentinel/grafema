# Don Melton — Plan: REG-478

**Date:** 2026-02-16
**Task:** Run ANALYSIS phase globally, not per-service

## Exploration Findings

### Orchestrator: How ANALYSIS runs today

**File:** `packages/core/src/Orchestrator.ts`

**Current flow (lines 237-245):**
```typescript
// PHASE 2: ANALYSIS
this.profiler.start('ANALYSIS');
this.onProgress({ phase: 'analysis', currentPlugin: 'Starting analysis...', message: 'Analyzing all units...', totalFiles: unitsToProcess.length, processedFiles: 0 });
if (this.parallelRunner) {
  await this.parallelRunner.run(manifest);
} else {
  await this.runBatchPhase('ANALYSIS', unitsToProcess, manifest);
}
this.profiler.end('ANALYSIS');
```

**The problem (lines 349-406):**
- `runBatchPhase('ANALYSIS', unitsToProcess, manifest)` iterates over ALL units (services/entrypoints)
- For each unit, it creates a `UnitManifest` with `service: { ...unit }` (line 378)
- Then calls `await this.runPhase('ANALYSIS', { manifest: unitManifest, ... })` (line 383)
- This runs ALL 16 ANALYSIS plugins FOR EACH UNIT

**Evidence from Knuth's analysis:**
- 745 services in large project → 745 iterations
- 16 ANALYSIS plugins × 745 = 11,920 plugin executions
- But every plugin ignores the `unitManifest.service` and queries ALL modules globally

### How ENRICHMENT runs (the model to follow)

**File:** `packages/core/src/Orchestrator.ts` (lines 413-419)

```typescript
// ENRICHMENT phase (global)
const enrichmentStart = Date.now();
this.profiler.start('ENRICHMENT');
this.onProgress({ phase: 'enrichment', currentPlugin: 'Starting enrichment...', message: 'Enriching graph data...', totalFiles: 0, processedFiles: 0 });
const enrichmentTypes = await this.runPhase('ENRICHMENT', { manifest, graph: this.graph, workerCount: this.workerCount });
this.profiler.end('ENRICHMENT');
this.logger.info('ENRICHMENT phase complete', { duration: ((Date.now() - enrichmentStart) / 1000).toFixed(2) });
```

**Key difference:**
- ENRICHMENT calls `runPhase()` ONCE with the FULL `DiscoveryManifest` (not per-unit)
- No iteration over units
- Plugins process the entire graph in one pass

VALIDATION follows the same pattern (lines 438-444) — one global run.

### Plugin service context usage audit

**Base class:** `packages/core/src/plugins/Plugin.ts`
- Provides `getModules(graph)` helper (lines 67-74)
- Queries ALL MODULE nodes globally: `graph.queryNodes({ type: 'MODULE' })`
- No filtering by service context

**All 15 ANALYSIS plugins searched:**

| Plugin | Uses `manifest.service`? | Evidence |
|--------|-------------------------|----------|
| JSASTAnalyzer.ts | **NO** | Calls `getModuleNodes(graph)` which queries ALL modules (line 352). Has `analyzedModules` dedup set to avoid re-analysis across calls (lines 245, 358, 390). |
| ExpressAnalyzer.ts | **NO** | Uses `this.getModules(graph)` from base class (line 97) |
| ExpressResponseAnalyzer.ts | **NO** | (needs confirmation, but follows pattern) |
| ExpressRouteAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 87) |
| FetchAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 95) |
| DatabaseAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 69) |
| SQLiteAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 76) |
| NestJSRouteAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 163) |
| SystemDbAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 74) |
| ServiceLayerAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 111) |
| ReactAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 70) |
| SocketAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 88) |
| SocketIOAnalyzer.ts | **NO** | Uses `this.getModules(graph)` (line 108) |
| RustAnalyzer.ts | **NO** | Queries `graph.queryNodes({ nodeType: 'RUST_MODULE' })` globally (line 211) |
| IncrementalAnalysisPlugin.ts | (assumed NO, not directly checked) |

**Grep results:**
```bash
# Searched across all analysis plugins
grep -r "manifest\.service" packages/core/src/plugins/analysis/
# Result: No matches found
```

**CRITICAL FINDING:** ZERO analysis plugins use `manifest.service`. They all query the entire graph globally. The per-service loop is pure overhead.

**JSASTAnalyzer dedup mechanism:**
- Instance variable `analyzedModules: Set<string>` (line 245)
- Before analyzing, checks `if (this.analyzedModules.has(module.id))` (line 358)
- After queuing, adds `this.analyzedModules.add(module.id)` (line 390)
- Cleared on `forceAnalysis=true` (line 349)

This dedup works BECAUSE plugins are singleton instances reused across per-service calls. Without this, JSASTAnalyzer would analyze each module 745 times.

### ParallelAnalysisRunner (alternative execution path)

**File:** `packages/core/src/ParallelAnalysisRunner.ts`

**When enabled:** `if (this.parallelRunner)` (Orchestrator.ts line 240)

**How it works (lines 45-108):**
- Queries ALL MODULE nodes globally: `graph.queryNodes({ type: 'MODULE' })` (line 70)
- Queues per-file analysis tasks (line 73-79)
- Workers process tasks in parallel, writing to RFDB server
- **Already runs globally** — no per-service loop

**Finding:** ParallelAnalysisRunner already does what we need — global execution. The bug is ONLY in the fallback path (`runBatchPhase`).

### Test coverage

**Search results:**
```bash
grep -r "runBatchPhase\|runPhase.*ANALYSIS" test/unit/*.test.js
# Result: No direct tests found
```

**Existing Orchestrator tests:**
- `/test/unit/OrchestratorStrictSuppressed.test.js` — strict mode behavior
- `/test/unit/OrchestratorMultiRootStrict.test.js` — multi-root workspace

**Indirect coverage:**
- Plugin-specific tests (e.g., `test/unit/plugins/InfraAnalyzer.test.js`) run full Orchestrator
- Integration tests likely cover the full pipeline

**Finding:** No dedicated tests for ANALYSIS phase orchestration. Changes must be verified by existing integration tests passing.

## Plan

### Approach

**Goal:** Make fallback ANALYSIS execution match ParallelAnalysisRunner's global behavior.

**Strategy:** Mirror ENRICHMENT phase structure (lines 413-419):
1. Run ANALYSIS plugins ONCE globally after INDEXING completes
2. Pass full `DiscoveryManifest` instead of per-unit `UnitManifest`
3. Remove the per-service loop for ANALYSIS
4. Keep INDEXING per-service (it needs service context for DFS traversal)

**Why this is safe:**
- All 15 ANALYSIS plugins already ignore service context
- JSASTAnalyzer's `analyzedModules` dedup still works (cleared only on `forceAnalysis`)
- ParallelAnalysisRunner already uses global execution — we're unifying the code paths
- ENRICHMENT/VALIDATION already use this pattern successfully

### Changes required

#### File: `packages/core/src/Orchestrator.ts`

**Change 1: Update `run()` method (lines 237-245)**

Before:
```typescript
// PHASE 2: ANALYSIS
this.profiler.start('ANALYSIS');
this.onProgress({ phase: 'analysis', currentPlugin: 'Starting analysis...', message: 'Analyzing all units...', totalFiles: unitsToProcess.length, processedFiles: 0 });
if (this.parallelRunner) {
  await this.parallelRunner.run(manifest);
} else {
  await this.runBatchPhase('ANALYSIS', unitsToProcess, manifest);
}
this.profiler.end('ANALYSIS');
```

After:
```typescript
// PHASE 2: ANALYSIS (global, like ENRICHMENT)
const analysisStart = Date.now();
this.profiler.start('ANALYSIS');
this.onProgress({ phase: 'analysis', currentPlugin: 'Starting analysis...', message: 'Analyzing all modules...', totalFiles: 0, processedFiles: 0 });
if (this.parallelRunner) {
  await this.parallelRunner.run(manifest);
} else {
  await this.runPhase('ANALYSIS', { manifest, graph: this.graph, workerCount: this.workerCount });
}
this.profiler.end('ANALYSIS');
this.logger.info('ANALYSIS phase complete', { duration: ((Date.now() - analysisStart) / 1000).toFixed(2) });
```

**Change 2: Update `runMultiRoot()` method (lines 298-302)**

Before:
```typescript
// INDEXING + ANALYSIS phases for this root
const rootOpts = { rootPrefix: rootName };
await this.runBatchPhase('INDEXING', units, rootManifest, rootOpts);
if (!this.indexOnly) {
  await this.runBatchPhase('ANALYSIS', units, rootManifest, rootOpts);
}
```

After:
```typescript
// INDEXING phase for this root (per-unit, needs service context)
const rootOpts = { rootPrefix: rootName };
await this.runBatchPhase('INDEXING', units, rootManifest, rootOpts);
```

Then, AFTER the multi-root loop completes (after line 320), add global ANALYSIS:
```typescript
// ANALYSIS phase (global across all roots, like ENRICHMENT)
if (!this.indexOnly) {
  const analysisStart = Date.now();
  this.profiler.start('ANALYSIS');
  this.onProgress({ phase: 'analysis', currentPlugin: 'Starting analysis...', message: 'Analyzing all modules...', totalFiles: 0, processedFiles: 0 });
  await this.runPhase('ANALYSIS', { manifest: unifiedManifest, graph: this.graph, workerCount: this.workerCount });
  this.profiler.end('ANALYSIS');
  this.logger.info('ANALYSIS phase complete', { duration: ((Date.now() - analysisStart) / 1000).toFixed(2) });
}
```

**Change 3: Update `runBatchPhase()` comment (line 346)**

Before:
```typescript
/**
 * Run a per-unit phase (INDEXING or ANALYSIS) in batches.
 * Common batch processing logic extracted from run() (REG-462).
 */
```

After:
```typescript
/**
 * Run INDEXING phase per-unit in batches.
 * Used only for INDEXING (requires service context for DFS).
 * ANALYSIS now runs globally like ENRICHMENT.
 * Common batch processing logic extracted from run() (REG-462).
 */
```

And optionally rename the method to `runIndexingBatchPhase` for clarity (but not required).

### Risk analysis

**What could break:**

1. **JSASTAnalyzer's `analyzedModules` dedup**
   - Risk: LOW
   - Reason: Dedup set is instance-level, persists across `execute()` calls
   - With global run: `execute()` called once → dedup still works
   - With per-service run: `execute()` called 745 times → dedup saves us from 745× re-analysis
   - **Both cases work** — dedup is defensive against multiple runs

2. **Progress reporting**
   - Risk: LOW
   - Current: Shows per-service progress (`[1-10/745]`)
   - After: Shows global progress (like ENRICHMENT)
   - Just a UI change, no functional impact

3. **Plugin assumptions about context.manifest**
   - Risk: ZERO (verified by audit)
   - No plugin uses `manifest.service`
   - All plugins query graph globally

4. **Multi-root workspace mode**
   - Risk: LOW
   - Need to ensure ANALYSIS runs ONCE after ALL roots are indexed
   - Placement: after unified manifest is built (line 323)

5. **ParallelAnalysisRunner interaction**
   - Risk: ZERO
   - ParallelRunner already uses global execution
   - No change needed to ParallelRunner itself

**Verification strategy:**

1. Run existing Orchestrator tests:
   ```bash
   node --test test/unit/OrchestratorStrictSuppressed.test.js
   node --test test/unit/OrchestratorMultiRootStrict.test.js
   ```

2. Run full test suite:
   ```bash
   pnpm build
   node --test --test-concurrency=1 'test/unit/*.test.js'
   ```

3. Test on real project:
   ```bash
   grafema analyze /path/to/large/project
   ```
   - Verify stats: 16 ANALYSIS plugin executions (not 11,920)
   - Verify graph: same nodes/edges as before
   - Verify duration: ~745× faster ANALYSIS phase

4. Test multi-root mode:
   ```bash
   grafema analyze /path/to/workspace --workspace-roots packages/a,packages/b
   ```

### Acceptance criteria

1. **Functional correctness:**
   - [ ] All existing tests pass
   - [ ] Graph structure identical before/after (same nodes, edges, metadata)
   - [ ] No regressions in strict mode, multi-root, parallel mode

2. **Performance improvement:**
   - [ ] ANALYSIS plugins execute 16 times total (not 16 × services count)
   - [ ] ANALYSIS phase duration: ~745× faster on large projects
   - [ ] IPC calls: 12 `getModules()` calls (not 12 × 745)

3. **Code quality:**
   - [ ] `runBatchPhase()` used only for INDEXING (comment updated)
   - [ ] ANALYSIS follows same pattern as ENRICHMENT/VALIDATION
   - [ ] No behavioral change to ParallelAnalysisRunner

4. **Edge cases:**
   - [ ] Multi-root mode: ANALYSIS runs once after all roots indexed
   - [ ] indexOnly mode: ANALYSIS skipped correctly
   - [ ] forceAnalysis mode: JSASTAnalyzer dedup cleared, re-analyzes

## Implementation notes

**Before starting:**
- Verify current behavior with debug logging
- Capture baseline metrics (plugin execution count, duration)

**After implementation:**
- Compare metrics: should see exactly 16 plugin executions
- Run on actual monorepo to confirm speedup

**If issues arise:**
- Most likely: progress reporting UI needs adjustment
- Unlikely: plugin assumes per-service execution (none found in audit)

## References

- **Parent issue:** REG-477 (Knuth Big-O analysis)
- **Knuth's analysis:** `_tasks/REG-477/003-knuth-bigo-analysis.md`
- **Similar issue:** ParallelAnalysisRunner already solved this (REG-462)
- **Pattern to follow:** ENRICHMENT phase (Orchestrator.ts lines 413-419)
