# Dijkstra Plan Verification: REG-478

**Date:** 2026-02-16
**Verdict:** **REJECT**

## Summary

Joel's technical plan contains **critical gaps** in execution path coverage and line number accuracy. The plan assumes unified behavior across execution modes, but the actual code has **three distinct paths** (single-root, multi-root, parallel) that must be verified independently. Additionally, **line numbers are incorrect** due to code changes since the plan was written.

## Critical Gaps Found

### Gap 1: Multi-root ANALYSIS placement is WRONG

**Issue:** Joel's plan (Step 2b, lines 132-168) places global ANALYSIS BEFORE the `indexOnly` check.

**Actual code structure (lines 322-334):**
```typescript
// Create unified manifest (line 323-327)
const unifiedManifest: DiscoveryManifest = { ... };

// Skip remaining phases if indexOnly (line 330-334)
if (this.indexOnly) {
  const totalTime = ...;
  this.logger.info('indexOnly mode - skipping remaining phases', ...);
  return unifiedManifest;
}

// ENRICHMENT → validation epilogue (line 337)
await this.runPipelineEpilogue(unifiedManifest, workspacePath);
```

**Joel's proposed insertion point (line 320, "after unifiedManifest"):**
```typescript
// ANALYSIS phase (global across all roots, like ENRICHMENT)
if (!this.indexOnly) {
  // ... ANALYSIS code ...
}
```

**The problem:**
- Joel wraps ANALYSIS in `if (!this.indexOnly)` check (line 156)
- BUT then proposes inserting it BEFORE the existing `indexOnly` barrier (line 330)
- This creates DUPLICATE checks and ambiguous flow

**Correct placement:** ANALYSIS must run AFTER line 334 (the `indexOnly` early return), not before it.

**Impact:** If implemented as written, indexOnly mode behavior is ambiguous. Will ANALYSIS run or not?

---

### Gap 2: Line numbers are stale

**Issue:** Joel specifies exact line numbers, but they don't match current code.

| Joel's plan | Actual location | Shift |
|-------------|----------------|-------|
| Step 1: lines 237-245 | Correct | ✓ |
| Step 2a: lines 298-303 | Lines 298-303 ✓ | ✓ |
| Step 2b: insert after line 320 | Insert after line 334 | +14 lines |
| Step 3: lines 345-348 | Correct | ✓ |

**Evidence:**
- Joel says "insert between lines 320-329"
- Actual `indexOnly` check is at lines 330-334 (after unifiedManifest creation)
- Joel's insertion point is BEFORE the barrier, not after

**Impact:** Implementation will place code in wrong location, breaking indexOnly mode.

---

### Gap 3: ParallelRunner path not verified

**Issue:** Joel assumes ParallelRunner "already global, no changes needed" (line 440).

**Verification needed:**
1. Does `ParallelAnalysisRunner.run()` accept `DiscoveryManifest` as input?
2. What happens in multi-root mode when `this.parallelRunner` is enabled?
3. Is ParallelRunner called ONCE or per-root?

**Current code (single-root, line 240-241):**
```typescript
if (this.parallelRunner) {
  await this.parallelRunner.run(manifest);
}
```

**Current code (multi-root, lines 298-303):**
```typescript
// Inside per-root loop
if (!this.indexOnly) {
  await this.runBatchPhase('ANALYSIS', units, rootManifest, rootOpts);
}
```

**The question:** Does multi-root mode call ParallelRunner? Or only the fallback path?

**Missing from plan:**
- No explicit change to multi-root ParallelRunner path
- Assumes it "works unchanged" without verification

**Impact:** Multi-root + parallel mode might still run ANALYSIS per-root (745×).

---

## Completeness Tables

### Execution Path Coverage

| Path | Handled by plan? | Evidence | Gap? |
|------|-----------------|----------|------|
| Single-root + fallback | YES | Step 1 (lines 237-245) | ✓ |
| Single-root + parallel | ASSUMED | "ParallelRunner already global" | ⚠️ Unverified |
| Multi-root + fallback | YES | Step 2 (lines 298-303, 320-334) | **✗ Wrong placement** |
| Multi-root + parallel | NO | Not mentioned | **✗ Missing** |
| indexOnly mode (single) | YES | Early return at line 231-234 | ✓ |
| indexOnly mode (multi) | UNCLEAR | Conflicting checks (line 156 vs 330) | **✗ Ambiguous** |
| Empty project (0 services) | ASSUMED | Not mentioned | ⚠️ Edge case |
| forceAnalysis mode | ASSUMED | JSASTAnalyzer dedup discussion | ✓ |

**Verdict:** 3 critical gaps (multi-root placement, multi-root parallel, indexOnly flow), 2 unverified assumptions.

---

### Change 1: `run()` method (Step 1)

| Verification | Status | Notes |
|--------------|--------|-------|
| Line numbers correct? | ✓ | Lines 237-245 match |
| `runPhase` signature? | ✓ | Accepts `Partial<PluginContext> & { graph }` |
| `manifest` available? | ✓ | `manifest` from DISCOVERY (line 191) |
| `graph` available? | ✓ | `this.graph` |
| `workerCount` available? | ✓ | `this.workerCount` |
| Progress message correct? | ✓ | "Analyzing all modules..." (not "units") |
| ParallelRunner branch? | ✓ | Unchanged (line 240-241) |
| Timing log added? | ✓ | `analysisStart`, `logger.info` |

**Verdict:** APPROVE for single-root fallback path.

---

### Change 2a: `runMultiRoot()` — remove per-root ANALYSIS

| Verification | Status | Notes |
|--------------|--------|-------|
| Line numbers correct? | ✓ | Lines 298-303 match |
| Removes `runBatchPhase('ANALYSIS', ...)` | ✓ | Lines 301-302 deleted |
| Removes `indexOnly` check | ✓ | Outer check removed (will be global) |
| Comment updated? | ✓ | "INDEXING phase for this root" |

**Verdict:** APPROVE for removal part.

---

### Change 2b: `runMultiRoot()` — add global ANALYSIS

| Verification | Status | Notes |
|--------------|--------|-------|
| Insertion point correct? | **✗** | Joel says "after line 320", but should be after 334 |
| Uses `unifiedManifest`? | ✓ | Yes (line 163) |
| Respects `indexOnly`? | **✗** | Duplicate check (line 156) conflicts with existing (line 330) |
| ParallelRunner branch? | **?** | Not mentioned for multi-root case |
| Timing log added? | ✓ | Yes |

**Verdict:** **REJECT** — wrong placement, indexOnly logic broken, parallel path missing.

---

### Change 3: `runBatchPhase()` docstring

| Verification | Status | Notes |
|--------------|--------|-------|
| Line numbers correct? | ✓ | Lines 345-348 match |
| Docstring update accurate? | ✓ | Documents INDEXING-only usage |
| Method signature unchanged? | ✓ | No code changes |

**Verdict:** APPROVE.

---

## Precondition Issues

### Precondition 1: `manifest` is `DiscoveryManifest` at ANALYSIS point

**Assumption:** `runPhase('ANALYSIS', { manifest, ... })` expects full `DiscoveryManifest`.

**Verification:**
- Single-root: `manifest` from DISCOVERY (line 191) — ✓
- Multi-root: `unifiedManifest` built from all roots (lines 323-327) — ✓

**Status:** SATISFIED.

---

### Precondition 2: `unifiedManifest` exists before ANALYSIS in multi-root

**Assumption:** Multi-root ANALYSIS uses `unifiedManifest`.

**Verification:**
- `unifiedManifest` created at lines 323-327
- Joel's insertion point: "after line 320"
- Actual earliest safe point: after line 327 (after manifest creation)
- But must be after line 334 (after indexOnly barrier)

**Status:** PARTIALLY VIOLATED — plan specifies wrong insertion point.

---

### Precondition 3: All plugins are service-context-agnostic

**Assumption:** ANALYSIS plugins don't use `manifest.service`.

**Verification:** Don's audit (lines 66-89 in his plan) found ZERO plugins use `manifest.service`.

**Status:** SATISFIED.

---

### Precondition 4: ParallelRunner accepts `DiscoveryManifest`

**Assumption:** `ParallelAnalysisRunner.run(manifest)` works with full manifest.

**Verification:** NOT DONE in plan. Need to check:
- `ParallelAnalysisRunner.run()` signature
- Does it use `manifest` or ignore it?
- Multi-root case: does it get called?

**Status:** UNVERIFIED.

---

## Edge Cases Analysis

### Edge Case 1: Empty project (0 services)

**Question:** What happens if `unitsToProcess.length === 0`?

**Code path (single-root):**
```typescript
// Line 227: runBatchPhase('INDEXING', unitsToProcess, manifest)
// If unitsToProcess = [], loop runs 0 times — OK
```

**After change:**
```typescript
// Line 243 (new): runPhase('ANALYSIS', { manifest, ... })
// Plugins call getModules(graph) → returns [] — OK
```

**Status:** Should work, but not explicitly tested in plan.

---

### Edge Case 2: Multi-root + parallel + indexOnly

**Question:** What happens if `workspaceRoots`, `parallelConfig`, and `indexOnly` are all set?

**Current code:** Per-root loop checks `indexOnly` before ANALYSIS (line 301).

**After change (Joel's proposal):**
```typescript
if (!this.indexOnly) {
  // ... global ANALYSIS ...
  if (this.parallelRunner) { ... }
}
```

**Problem:** Joel's insertion point is BEFORE the indexOnly barrier (line 330). This creates duplicate logic.

**Correct flow:**
1. Loop over roots → INDEXING only
2. Build unifiedManifest
3. Check indexOnly → early return if true
4. Run global ANALYSIS (parallel OR fallback)
5. Run epilogue

**Joel's flow (as written):**
1. Loop over roots → INDEXING only
2. Build unifiedManifest
3. Run ANALYSIS with nested `if (!indexOnly)` check ← WRONG PLACEMENT
4. Check indexOnly → early return ← UNREACHABLE if ANALYSIS already ran

**Status:** **BROKEN** — indexOnly logic is ambiguous.

---

### Edge Case 3: Plugin throws during global ANALYSIS

**Question:** What happens if a plugin throws during the single global run?

**Current behavior (per-service):**
- Plugin throws on service 5/745
- Error caught, rest of services continue (lines 383-400 show try/catch per unit)

**After change (global):**
- Plugin throws during global run
- Error propagates → entire ANALYSIS phase fails
- No partial results

**Risk assessment:**
- HIGHER blast radius (one failure kills entire phase)
- BUT: plugins should be defensive (skip broken modules, continue)
- JSASTAnalyzer already has per-module error handling

**Status:** Acceptable risk IF plugins are defensive. Plan doesn't discuss error handling.

---

### Edge Case 4: Multi-root service with same name

**Question:** What if two roots have services with the same name?

**Current code (lines 306-312):**
```typescript
for (const svc of rootManifest.services) {
  allServices.push({
    ...svc,
    path: svc.path ? `${rootName}/${svc.path.replace(rootAbsolutePath + '/', '')}` : undefined,
  });
}
```

**Service uniqueness:** Paths are prefixed with `rootName`, so names can collide but paths won't.

**ANALYSIS impact:** Plugins query by path, not name → no collision.

**Status:** Safe.

---

## Line Number Verification

| Plan reference | Actual line | Match? | Correct line |
|----------------|-------------|--------|--------------|
| Step 1: lines 237-245 | 237-245 | ✓ | 237-245 |
| Step 2a: lines 298-303 | 298-303 | ✓ | 298-303 |
| Step 2b: "after line 320" | N/A | **✗** | Should be after 334 |
| Step 2b: "insert between lines 320-329" | N/A | **✗** | Should be after 334, before 337 |
| Step 3: lines 345-348 | 345-348 | ✓ | 345-348 |

**Critical discrepancy:** Joel's insertion point for multi-root ANALYSIS is wrong by 14 lines.

---

## Recommendations

### 1. Fix multi-root ANALYSIS placement

**Current plan (WRONG):**
> "Insert between lines 320-329"

**Correct placement:**
> Insert AFTER line 334 (after indexOnly early return), BEFORE line 337 (runPipelineEpilogue).

**Correct code structure:**
```typescript
// Line 323-327: Build unifiedManifest
const unifiedManifest: DiscoveryManifest = { ... };

// Line 330-334: indexOnly barrier
if (this.indexOnly) {
  return unifiedManifest; // EARLY EXIT
}

// [INSERT ANALYSIS HERE] ← AFTER indexOnly check
// ANALYSIS phase (global across all roots, like ENRICHMENT)
const analysisStart = Date.now();
this.profiler.start('ANALYSIS');
this.onProgress({ ... });
if (this.parallelRunner) {
  await this.parallelRunner.run(unifiedManifest);
} else {
  await this.runPhase('ANALYSIS', { manifest: unifiedManifest, graph: this.graph, workerCount: this.workerCount });
}
this.profiler.end('ANALYSIS');
this.logger.info('ANALYSIS phase complete', { duration: ((Date.now() - analysisStart) / 1000).toFixed(2) });

// Line 337: runPipelineEpilogue
await this.runPipelineEpilogue(unifiedManifest, workspacePath);
```

**Rationale:** ANALYSIS must be skipped in indexOnly mode. The only safe way is to place it AFTER the early return.

---

### 2. Remove duplicate `indexOnly` check

**Current plan (line 156 in Step 2b):**
```typescript
if (!this.indexOnly) {
  // ... ANALYSIS code ...
}
```

**Problem:** Unnecessary — already protected by early return at line 334.

**Fix:** Remove the outer `if (!this.indexOnly)` wrapper. Just run ANALYSIS directly after the early return.

---

### 3. Verify ParallelRunner in multi-root mode

**Missing verification:**
- Does current code call `this.parallelRunner` in multi-root mode?
- Answer: NO — lines 298-303 show only fallback path (`runBatchPhase`).

**Required change (not in plan):**
- Multi-root ANALYSIS must ALSO check `if (this.parallelRunner)` branch
- Joel's code (line 160-164) includes this check — ✓

**But:** Need to verify `ParallelAnalysisRunner.run()` accepts `DiscoveryManifest` (not just `UnitManifest`).

---

### 4. Document error handling change

**Risk:** Global ANALYSIS has different error semantics than per-service.

**Recommendation:**
- Add comment explaining blast radius change
- Ensure plugins have per-module error handling
- Test with intentionally broken plugin to verify graceful degradation

---

### 5. Add explicit test for multi-root + parallel + indexOnly

**Current test plan (lines 299-354 in Joel's plan):**
- Test 1: single-root ✓
- Test 2: multi-root ✓
- Test 4: indexOnly ✓
- Test 5: parallel ✓

**Missing:** Combined test for multi-root + parallel + indexOnly.

**Add to test plan:**
```bash
# Test 6: Multi-root + parallel + indexOnly
GRAFEMA_PARALLEL_ANALYSIS=true grafema analyze /workspace \
  --workspace-roots packages/a,packages/b --index-only \
  --log-level debug > test6.log 2>&1

grep "ANALYSIS" test6.log
# Expected: no ANALYSIS phase logs (indexOnly respected)

grep "ParallelAnalysisRunner" test6.log
# Expected: no parallel runner logs
```

---

## Final Verdict

**REJECT** — Critical gaps in multi-root implementation.

**Blocking issues:**
1. Multi-root ANALYSIS placement is wrong (before indexOnly barrier instead of after)
2. Duplicate `indexOnly` check creates ambiguous control flow
3. Line numbers are stale (off by 14 lines)
4. ParallelRunner path in multi-root not verified

**Non-blocking issues:**
5. Edge case testing incomplete (multi-root + parallel + indexOnly)
6. Error handling change not documented

**Required fixes:**
- Move multi-root ANALYSIS insertion point to after line 334
- Remove duplicate `indexOnly` check (line 156 in plan)
- Verify ParallelRunner.run() signature accepts DiscoveryManifest
- Update line numbers to match current code

**Estimated fix time:** 30 minutes (mostly adjusting placement and removing duplicate check).

---

## Proof by Enumeration

### All control flow paths through ANALYSIS phase

| Mode | Parallel? | indexOnly? | Expected behavior | Plan handles correctly? |
|------|-----------|-----------|-------------------|------------------------|
| Single-root | No | No | runPhase('ANALYSIS', full manifest) | ✓ YES (Step 1) |
| Single-root | No | Yes | Skip ANALYSIS | ✓ YES (early return line 231-234) |
| Single-root | Yes | No | ParallelRunner.run(manifest) | ⚠️ ASSUMED (line 240) |
| Single-root | Yes | Yes | Skip ANALYSIS | ✓ YES (early return line 231-234) |
| Multi-root | No | No | runPhase('ANALYSIS', unifiedManifest) | **✗ WRONG PLACEMENT** |
| Multi-root | No | Yes | Skip ANALYSIS | **✗ AMBIGUOUS** (duplicate checks) |
| Multi-root | Yes | No | ParallelRunner.run(unifiedManifest) | **✗ NOT VERIFIED** |
| Multi-root | Yes | Yes | Skip ANALYSIS | **✗ AMBIGUOUS** |

**Summary:** 4 out of 8 paths have issues (multi-root cases).

---

## Appendix: Correct Multi-Root Diff

**File:** `packages/core/src/Orchestrator.ts`

**Lines 298-303 (Step 2a — REMOVE per-root ANALYSIS):**
```diff
-      // INDEXING + ANALYSIS phases for this root
+      // INDEXING phase for this root (per-unit, needs service context)
       const rootOpts = { rootPrefix: rootName };
       await this.runBatchPhase('INDEXING', units, rootManifest, rootOpts);
-      if (!this.indexOnly) {
-        await this.runBatchPhase('ANALYSIS', units, rootManifest, rootOpts);
-      }
```

**Lines 323-337 (Step 2b — ADD global ANALYSIS after indexOnly barrier):**
```diff
     // Create unified manifest
     const unifiedManifest: DiscoveryManifest = {
       services: allServices,
       entrypoints: allEntrypoints,
       projectPath: workspacePath,
     };

     // Skip remaining phases if indexOnly
     if (this.indexOnly) {
       const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
       this.logger.info('indexOnly mode - skipping remaining phases', { duration: totalTime });
       return unifiedManifest;
     }

+    // ANALYSIS phase (global across all roots, like ENRICHMENT)
+    const analysisStart = Date.now();
+    this.profiler.start('ANALYSIS');
+    this.onProgress({ phase: 'analysis', currentPlugin: 'Starting analysis...', message: 'Analyzing all modules...', totalFiles: 0, processedFiles: 0 });
+    if (this.parallelRunner) {
+      await this.parallelRunner.run(unifiedManifest);
+    } else {
+      await this.runPhase('ANALYSIS', { manifest: unifiedManifest, graph: this.graph, workerCount: this.workerCount });
+    }
+    this.profiler.end('ANALYSIS');
+    this.logger.info('ANALYSIS phase complete', { duration: ((Date.now() - analysisStart) / 1000).toFixed(2) });
+
     // ENRICHMENT → strict barrier → guarantee → VALIDATION → flush
     await this.runPipelineEpilogue(unifiedManifest, workspacePath);
```

**Key difference from Joel's plan:**
- Inserted AFTER line 334 (indexOnly early return), not "after line 320"
- NO outer `if (!this.indexOnly)` check — already protected by early return
