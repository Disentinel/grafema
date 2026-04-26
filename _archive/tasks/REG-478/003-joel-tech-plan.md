# Joel Spolsky — Technical Plan: REG-478

**Date:** 2026-02-16
**Task:** Run ANALYSIS phase globally, not per-service

## Big-O Analysis

**Knuth's variables:**
- S = services count (745 in large project)
- P = analysis plugins count (16)
- M = MODULE nodes count (~12,000 in large project)

**Before (per-service execution):**
```
ANALYSIS phase = S × P × O(M)
               = 745 × 16 × O(12,000)
               = 11,920 plugin executions
               = 8,940,000 IPC calls (12 getModules per plugin × 745)
```

**After (global execution):**
```
ANALYSIS phase = P × O(M)
               = 16 × O(12,000)
               = 16 plugin executions
               = 12 IPC calls (one getModules per plugin)
```

**Speedup:** O(S) → O(1) = 745× reduction in plugin executions

**Wall clock impact:**
- Before: ~5-10 minutes for 745 services
- After: <1 second for global run
- Bottleneck shifts from orchestration overhead to actual AST parsing work

## Step-by-step Implementation

### Step 1: Update `run()` method — single-root mode

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/Orchestrator.ts`
**Lines:** 237-245

**Before:**
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

**After:**
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

**Changes:**
1. Comment updated: "global, like ENRICHMENT"
2. Progress message: "Analyzing all modules..." (not "all units")
3. Progress counts: `totalFiles: 0, processedFiles: 0` (not per-unit counts)
4. Fallback path: `runPhase('ANALYSIS', ...)` instead of `runBatchPhase(...)`
5. Context passed to `runPhase`: full `DiscoveryManifest` (not `UnitManifest`)
6. Added timing log: `logger.info('ANALYSIS phase complete', ...)`

**Rationale:**
- Matches ENRICHMENT pattern (lines 413-419)
- `runPhase()` signature accepts `Partial<PluginContext> & { graph }` — we pass `manifest, graph, workerCount`
- Progress UI shows "0/0" during ANALYSIS — acceptable, ENRICHMENT does the same
- Timing log helps verify the speedup

**Edge cases:**
- `unitsToProcess` variable still used for INDEXING phase (line 227) — no conflict
- `manifest` is `DiscoveryManifest` with full `services` and `entrypoints` arrays
- `ParallelAnalysisRunner` path unchanged — already global

**Impact on `unitsToProcess`:**
- Still needed for INDEXING phase (line 227)
- No longer used for ANALYSIS (removed from line 243)
- Variable scope limited to `run()` method — safe

---

### Step 2: Update `runMultiRoot()` method — multi-root workspace mode

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/Orchestrator.ts`
**Lines:** 298-303 (remove ANALYSIS), 320-334 (add global ANALYSIS)

**Change 2a: Remove per-root ANALYSIS loop**

**Before (lines 298-303):**
```typescript
      // INDEXING + ANALYSIS phases for this root
      const rootOpts = { rootPrefix: rootName };
      await this.runBatchPhase('INDEXING', units, rootManifest, rootOpts);
      if (!this.indexOnly) {
        await this.runBatchPhase('ANALYSIS', units, rootManifest, rootOpts);
      }
```

**After:**
```typescript
      // INDEXING phase for this root (per-unit, needs service context)
      const rootOpts = { rootPrefix: rootName };
      await this.runBatchPhase('INDEXING', units, rootManifest, rootOpts);
```

**Changes:**
1. Comment updated: "INDEXING phase for this root"
2. Removed `if (!this.indexOnly)` check — moved to global ANALYSIS block
3. Removed `runBatchPhase('ANALYSIS', ...)` call

**Rationale:**
- INDEXING still needs per-root execution (DFS traversal uses service context)
- ANALYSIS will run globally after ALL roots are indexed

**Change 2b: Add global ANALYSIS after multi-root loop**

**Location:** After line 320 (after `unifiedManifest` is built, before `indexOnly` check)

**Insert between lines 320-329:**
```typescript
    // Create unified manifest
    const unifiedManifest: DiscoveryManifest = {
      services: allServices,
      entrypoints: allEntrypoints,
      projectPath: workspacePath,
    };

    // [INSERT HERE] ← NEW CODE GOES HERE

    // Skip remaining phases if indexOnly
    if (this.indexOnly) {
      const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
      this.logger.info('indexOnly mode - skipping remaining phases', { duration: totalTime });
      return unifiedManifest;
    }
```

**New code to insert:**
```typescript
    // ANALYSIS phase (global across all roots, like ENRICHMENT)
    if (!this.indexOnly) {
      const analysisStart = Date.now();
      this.profiler.start('ANALYSIS');
      this.onProgress({ phase: 'analysis', currentPlugin: 'Starting analysis...', message: 'Analyzing all modules...', totalFiles: 0, processedFiles: 0 });
      if (this.parallelRunner) {
        await this.parallelRunner.run(unifiedManifest);
      } else {
        await this.runPhase('ANALYSIS', { manifest: unifiedManifest, graph: this.graph, workerCount: this.workerCount });
      }
      this.profiler.end('ANALYSIS');
      this.logger.info('ANALYSIS phase complete', { duration: ((Date.now() - analysisStart) / 1000).toFixed(2) });
    }
```

**Rationale:**
- ANALYSIS runs ONCE after ALL roots are indexed
- Uses `unifiedManifest` (contains all services from all roots)
- Respects `indexOnly` flag — skipped if true
- Mirrors single-root implementation (Step 1)

**Edge cases:**
- `unifiedManifest` at this point has services with `rootPrefix` in paths (lines 306-319) — correct
- `ParallelAnalysisRunner` accepts `DiscoveryManifest` — compatible
- Progress reporting: same "0/0" behavior as single-root mode

**Placement justification:**
- Must be AFTER `unifiedManifest` is built (line 323)
- Must be BEFORE `indexOnly` check (line 330) — checked inside ANALYSIS block
- Must be BEFORE `runPipelineEpilogue` (line 337) — correct order

---

### Step 3: Update `runBatchPhase()` docstring

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/Orchestrator.ts`
**Lines:** 345-348

**Before:**
```typescript
  /**
   * Run a per-unit phase (INDEXING or ANALYSIS) in batches.
   * Common batch processing logic extracted from run() (REG-462).
   */
```

**After:**
```typescript
  /**
   * Run INDEXING phase per-unit in batches.
   * Used only for INDEXING (requires service context for DFS).
   * ANALYSIS now runs globally like ENRICHMENT.
   * Common batch processing logic extracted from run() (REG-462).
   */
```

**Rationale:**
- Clarifies that method is now INDEXING-specific
- Documents why ANALYSIS doesn't use it
- Future maintainers won't try to add ANALYSIS back

**Optional:** Rename method to `runIndexingBatchPhase` for clarity — NOT required, but would be cleaner. Recommend deferring to separate refactoring task to keep this change minimal.

---

### Step 4: JSASTAnalyzer dedup mechanism — no changes needed

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Lines:** 245, 348-350, 358-359

**Current implementation:**
```typescript
export class JSASTAnalyzer extends Plugin {
  private analyzedModules: Set<string>; // Line 245

  constructor() {
    super();
    this.analyzedModules = new Set();
  }

  async execute(context: AnalyzeContext): Promise<PluginResult> {
    // Line 348-350
    if (forceAnalysis) {
      this.analyzedModules.clear();
    }

    // Line 358-359
    for (const module of allModules) {
      if (this.analyzedModules.has(module.id)) {
        skippedCount++;
        continue;
      }
      // ... queue for analysis ...
      this.analyzedModules.add(module.id); // (line 390)
    }
  }
}
```

**Analysis:**
- `analyzedModules` is an instance variable (persists across `execute()` calls)
- Cleared only when `forceAnalysis=true` (line 348)
- Used to skip re-analysis of same module across multiple `execute()` calls

**Before (per-service execution):**
- `execute()` called 745 times (once per service)
- Dedup prevents analyzing same module 745 times
- Set grows to ~12,000 entries (all modules)

**After (global execution):**
- `execute()` called 1 time
- Dedup still works — prevents re-analysis within single run
- Set grows to ~12,000 entries (same as before)

**Conclusion:** No changes needed. Dedup mechanism is defensive (handles both scenarios correctly).

**Tech debt opportunity (separate task):**
- With global execution, dedup is only useful if `execute()` is called multiple times in same session
- Could simplify to local `Set` inside `execute()` instead of instance variable
- NOT part of this task — document for future optimization

---

## Test Plan

### Unit Tests

**Test files to run:**
```bash
pnpm build  # CRITICAL: tests run against dist/, not src/

# Orchestrator tests
node --test test/unit/OrchestratorStrictSuppressed.test.js
node --test test/unit/OrchestratorMultiRootStrict.test.js

# Full unit suite
node --test --test-concurrency=1 'test/unit/*.test.js'
```

**Expected:**
- All existing tests pass without modification
- No changes to test files needed (behavior unchanged)

### Verification Tests (manual)

**Test 1: Single-root mode**
```bash
# Use real project or test fixture
grafema analyze /path/to/project --log-level debug > analysis.log 2>&1

# Check log for ANALYSIS plugin execution count
grep "Running plugin.*ANALYSIS" analysis.log | wc -l
# Expected: 16 (not 11,920)

# Check ANALYSIS phase duration
grep "ANALYSIS phase complete" analysis.log
# Expected: <1s (not 5-10 minutes)
```

**Test 2: Multi-root mode**
```bash
grafema analyze /path/to/workspace --workspace-roots packages/a,packages/b --log-level debug > multiroot.log 2>&1

grep "ANALYSIS phase complete" multiroot.log
# Expected: appears once, after all roots indexed
```

**Test 3: Graph equivalence**
```bash
# Before applying changes
grafema analyze /path/to/project
grafema query "get_stats" > before.json

# Apply changes, rebuild
pnpm build
grafema analyze /path/to/project --force-analysis
grafema query "get_stats" > after.json

# Compare node/edge counts
diff before.json after.json
# Expected: identical (except timestamps)
```

**Test 4: indexOnly mode**
```bash
grafema analyze /path/to/project --index-only --log-level debug > indexonly.log 2>&1

grep "ANALYSIS" indexonly.log
# Expected: no ANALYSIS phase logs
```

**Test 5: ParallelAnalysisRunner path**
```bash
# Enable parallel mode in config or via env
GRAFEMA_PARALLEL_ANALYSIS=true grafema analyze /path/to/project --log-level debug > parallel.log 2>&1

grep "ParallelAnalysisRunner" parallel.log
# Expected: ParallelRunner used, no runBatchPhase('ANALYSIS') calls
```

### Assertion Checklist

After implementation, verify:

- [ ] ANALYSIS plugins execute 16 times total (not 16 × S)
- [ ] Progress UI shows "Analyzing all modules... 0/0" (not per-service counts)
- [ ] Graph stats (nodes, edges) identical before/after
- [ ] ANALYSIS phase duration: <1s on large projects (was 5-10min)
- [ ] Multi-root mode: ANALYSIS runs once after all roots indexed
- [ ] indexOnly mode: ANALYSIS skipped correctly
- [ ] No regressions in strict mode tests
- [ ] No regressions in multi-root tests

---

## Migration Notes

### Deployment Considerations

**Breaking changes:** NONE
- External API unchanged (Orchestrator public methods same)
- Graph output identical (same nodes, edges, metadata)
- CLI behavior unchanged (same commands, same results)

**Performance impact:**
- ANALYSIS phase: 745× faster on large projects
- Total `grafema analyze` duration: depends on bottleneck
  - If INDEXING dominates (large projects): total speedup ~2-3×
  - If ANALYSIS dominated (many services, small codebase): total speedup ~10-20×

**Monitoring:**
- Check logs for "ANALYSIS phase complete" duration
- Expected: <1s for most projects
- If >5s → investigate (possible regression)

### Rollback Plan

If issues found after deployment:

1. Revert commits (atomic change, easy rollback)
2. Or: hotfix by adding feature flag:
   ```typescript
   const USE_GLOBAL_ANALYSIS = process.env.GRAFEMA_GLOBAL_ANALYSIS !== 'false';
   if (USE_GLOBAL_ANALYSIS) {
     await this.runPhase('ANALYSIS', ...);
   } else {
     await this.runBatchPhase('ANALYSIS', ...); // old path
   }
   ```
3. Investigate root cause with debug logging

**Rollback risk:** LOW (change is isolated, no schema changes)

---

## Edge Cases & Gotchas

### 1. Progress Reporting

**Issue:** Progress shows "0/0" during ANALYSIS (like ENRICHMENT)

**Impact:** LOW — users won't see per-service ANALYSIS progress

**Alternatives:**
- Show per-plugin progress (16 steps)
- Show "Analyzing..." without counts
- Keep "0/0" (consistent with ENRICHMENT)

**Decision:** Keep "0/0" (matches ENRICHMENT, minimal change)

**Future improvement:** Add per-plugin progress for ANALYSIS phase (separate task)

### 2. JSASTAnalyzer Dedup Set

**Issue:** `analyzedModules` set still grows to full size (12k entries)

**Impact:** NONE — memory usage identical before/after

**Tech debt:** Could simplify dedup to local variable (global run = single `execute()` call)

**Decision:** Leave as-is (defensive, works in both modes)

**Future optimization:** Track in REG-478 follow-up issue

### 3. ParallelAnalysisRunner Path

**Issue:** ParallelRunner already global, no changes needed

**Verification:** Test with `parallelConfig.enabled=true`

**Expected:** Works unchanged (already uses global `getModules()` query)

### 4. Multi-Root Service Context

**Issue:** `rootPrefix` passed to ANALYSIS plugins, but they ignore it

**Impact:** NONE — plugins query graph globally, context unused

**Verification:** Multi-root tests pass unchanged

### 5. ForceAnalysis Mode

**Issue:** `forceAnalysis` flag clears JSASTAnalyzer dedup set

**Impact:** NONE — still works correctly

**Verification:** `--force-analysis` re-analyzes all modules

---

## Implementation Order

**Recommended sequence:**

1. **Commit 1:** Update `run()` (Step 1) + docstring (Step 3)
   - Single-root mode working
   - Tests pass for single-root
   - ~80% of usage covered

2. **Commit 2:** Update `runMultiRoot()` (Step 2)
   - Multi-root mode working
   - Tests pass for multi-root
   - ~20% of usage covered

3. **Commit 3:** (Optional) Add metrics/logging
   - Log plugin execution count
   - Log ANALYSIS phase speedup
   - Helps verify deployment

**Atomic commits:** Each commit must pass tests independently.

---

## Success Metrics

**Before (baseline):**
- Plugin executions: 11,920 (16 × 745)
- IPC calls: ~8,940,000
- ANALYSIS duration: 5-10 minutes
- Total analyze duration: 15-20 minutes

**After (target):**
- Plugin executions: 16
- IPC calls: 12
- ANALYSIS duration: <1 second
- Total analyze duration: 5-10 minutes (bottleneck shifts to INDEXING)

**Acceptance criteria:**
1. Plugin executions reduced by factor of S (services count)
2. ANALYSIS phase duration <1s on all projects
3. Graph output identical (diff node/edge counts = 0)
4. All existing tests pass
5. No performance regressions in INDEXING or ENRICHMENT

---

## Related Work

**Parent issue:** REG-477 (Knuth Big-O analysis)

**Similar patterns:**
- ENRICHMENT phase (already global) — lines 413-419
- VALIDATION phase (already global) — lines 438-444
- ParallelAnalysisRunner (already global) — packages/core/src/ParallelAnalysisRunner.ts

**Follow-up tasks (NOT part of REG-478):**
- Simplify JSASTAnalyzer dedup (instance → local variable)
- Add per-plugin progress reporting for ANALYSIS
- Rename `runBatchPhase` → `runIndexingBatchPhase`

**Tech debt introduced:** NONE (pure simplification)

---

## References

- Don's plan: `_tasks/REG-478/002-don-plan.md`
- Knuth's analysis: `_tasks/REG-477/003-knuth-bigo-analysis.md`
- Orchestrator source: `packages/core/src/Orchestrator.ts`
- PhaseRunner source: `packages/core/src/PhaseRunner.ts`
- JSASTAnalyzer source: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
