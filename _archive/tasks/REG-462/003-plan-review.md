## Auto-Review: Don's Plan

**Date:** 2026-02-15
**Verdict:** REJECT

---

## Vision & Architecture: GOOD

**Alignment with project vision:** ✓
- Don's analysis correctly identifies this as an architectural problem (1,248 lines) that needs immediate action
- Extraction strategy is sound: pull out distinct concerns while keeping orchestration logic in place
- Follows existing pattern: PhaseRunner extraction (RFD-16) proved this approach works

**Modular architecture:** ✓
- Proposed boundaries are clean and respect single responsibility
- No circular dependencies introduced
- Public API surface remains unchanged (backward compatibility preserved)

**Extraction strategy:** ✓
- Don correctly identifies 7 distinct concerns
- Option A+ (4 class extraction) is reasonable: GraphInitializer, DiscoveryManager, GuaranteeChecker, ParallelAnalysisRunner
- Gradual extraction plan (one class at a time) is safe

---

## Practical Quality: CRITICAL ISSUE

**Line count verification:** ✓
- Don's count (1,248 lines) is accurate
- File indeed exceeds 700-line CRITICAL threshold by 77%

**Extraction math:** ❌ **PROBLEM FOUND**
- Don claims extracting ~420 lines (4 classes)
- Don's projection: Orchestrator drops from 1,248 → ~800 lines
- **User acceptance criteria: Orchestrator must be < 500 lines**
- **Don's plan leaves ~800 lines remaining — DOES NOT MEET ACCEPTANCE CRITERIA**

**Proposed extraction breakdown:**
- GraphInitializer: 78 lines (createGraphMetaNode + registerPluginNodes + declarePluginFields)
- DiscoveryManager: 193 lines (discover + discoverInRoot + buildIndexingUnits)
- GuaranteeChecker: 53 lines (runGuaranteeCheck + checkCoverageGaps)
- ParallelAnalysisRunner: 150 lines (runParallelAnalysis + startRfdbServer + stopRfdbServer)

**Total extracted: ~474 lines**
**Remaining after extraction: 1,248 - 474 = 774 lines**

**Don's estimate of ~800 lines is approximately correct, but still 54% over target (774 vs 500).**

---

## Gap Analysis: WHAT'S LEFT IN THE 774 LINES?

I verified the actual Orchestrator.ts to understand what remains after Don's extraction:

### Remaining Code (after Option A+ extraction):

1. **Constructor** (173-230): 58 lines
   - Dependency injection for 17 private fields
   - PhaseRunner instantiation
   - Auto-add SimpleProjectDiscovery logic

2. **run() method** (335-611): **277 lines** ← LARGEST CHUNK
   - Path resolution, forceAnalysis graph clear
   - Calls: registerPluginNodes, declarePluginFields
   - Calls: discover (or creates synthetic manifest for entrypoint override)
   - Calls: buildIndexingUnits
   - Service filtering logic
   - **INDEXING phase: batch processing loop (lines 428-488) — ~60 lines**
   - indexOnly early exit
   - **ANALYSIS phase: batch processing loop OR parallel (lines 498-561) — ~63 lines**
   - **ENRICHMENT phase: delegation + strict mode barrier (lines 566-583) — ~18 lines**
   - Calls: runGuaranteeCheck
   - **VALIDATION phase: delegation (lines 589-594) — ~6 lines**
   - Graph flush, profiling summary, cleanup

3. **runMultiRoot() method** (618-789): **172 lines** ← SECOND LARGEST CHUNK
   - Multi-root workspace coordination (REG-76)
   - Similar structure to run() but loops over roots
   - Per-root discovery, indexing, analysis
   - Global enrichment + validation

4. **Helper methods:**
   - runPhase() (1002-1004): 3 lines (delegation to PhaseRunner)
   - getDiagnostics() (1009-1011): 3 lines (getter)

5. **Imports, exports, interfaces, types:** ~60 lines

### The Math:
- Imports/exports/types: ~60 lines
- Constructor: 58 lines
- run(): 277 lines
- runMultiRoot(): 172 lines
- Helpers (runPhase, getDiagnostics): 6 lines
- **Total: ~573 lines**

Wait, that's LESS than 774. Let me recalculate:

Actually, Don's extracted code includes some overhead (method signatures, error handling, logging). The ACTUAL extraction would be closer to:
- GraphInitializer: 78 LOC (lines of code) → ~100 lines with class structure
- DiscoveryManager: 193 LOC → ~230 lines with class structure
- GuaranteeChecker: 53 LOC → ~80 lines with class structure
- ParallelAnalysisRunner: 150 LOC → ~200 lines with class structure

**Realistic remaining after extraction: ~800 lines** (Don's estimate was correct)

---

## The Real Problem: run() and runMultiRoot() Are Still Too Big

**Core insight:** After extracting helpers, the workflow coordination itself is still massive:
- `run()`: 277 lines — contains FIVE phase loops with progress callbacks, batch processing, error handling
- `runMultiRoot()`: 172 lines — similar structure but loops over roots

**Why is run() 277 lines?**
1. Phase setup/teardown boilerplate repeated 5 times
2. Batch processing logic inline in each phase (INDEXING, ANALYSIS)
3. Progress callbacks scattered throughout
4. Inline service filtering, manifest building, early exits

**Don's plan says:** "We can extract WorkflowExecutor later to get under 500 lines if desired."

**THIS IS THE MISSING PIECE.** Without extracting workflow coordination logic from run()/runMultiRoot(), we cannot reach < 500 lines.

---

## Recommendations: Plan Needs Fifth Extraction

**Current plan (Option A+):** Extract 4 helpers → 800 lines remaining ❌

**Required plan (Option B):** Extract 5 classes → < 500 lines remaining ✓

Add **fifth extraction** to Don's plan:

### 5. WorkflowExecutor (or PhaseCoordinator)
Extract batch processing and phase coordination from run() and runMultiRoot():
- `executeSingleRootWorkflow(manifest, units, projectPath)` — replaces bulk of run()
- `executeMultiRootWorkflow(roots, workspacePath)` — replaces bulk of runMultiRoot()
- Batch processing logic (INDEXING, ANALYSIS phases)
- Progress callback orchestration
- Phase barrier logic (indexOnly, strictMode checks)

**Lines extracted:** ~250-300 lines from run() + runMultiRoot()

**Orchestrator after all 5 extractions:**
- Constructor: 58 lines
- run(): ~50 lines (path resolution, call WorkflowExecutor, return manifest)
- runMultiRoot(): ~30 lines (validate roots, call WorkflowExecutor, return manifest)
- Helpers: 9 lines (runPhase, getDiagnostics)
- Imports/exports: 60 lines
- **Total: ~210-230 lines** ✓ UNDER 500

---

## Specific Extraction Plan for WorkflowExecutor

**What moves to WorkflowExecutor:**

From run() (lines 335-611):
- Lines 428-488: INDEXING batch loop → `executeIndexingPhase(units, manifest)`
- Lines 498-561: ANALYSIS batch loop / parallel → `executeAnalysisPhase(units, manifest)`
- Lines 566-583: ENRICHMENT + strict barrier → `executeEnrichmentPhase(manifest)`
- Lines 589-594: VALIDATION → `executeValidationPhase(manifest)`

From runMultiRoot() (lines 618-789):
- Lines 645-722: Per-root INDEXING + ANALYSIS loops → `processRoot(rootPath, rootName)`
- Lines 739-769: ENRICHMENT + VALIDATION → reuse single-root executors

**Dependencies WorkflowExecutor needs:**
- PhaseRunner (for runPhase delegation)
- Profiler (for timing)
- Logger
- onProgress callback
- Graph backend
- DiagnosticCollector (for strict mode checks)

**Orchestrator.run() becomes:**
```typescript
async run(projectPath: string): Promise<DiscoveryManifest> {
  const absoluteProjectPath = resolve(projectPath);

  if (this.workspaceRoots?.length > 0) {
    return this.workflowExecutor.executeMultiRoot(absoluteProjectPath, this.workspaceRoots);
  }

  if (this.forceAnalysis && this.graph.clear) {
    await this.graph.clear();
  }

  await this.graphInitializer.registerPluginNodes();
  await this.graphInitializer.declarePluginFields();
  await this.graphInitializer.createGraphMetaNode(absoluteProjectPath);

  const manifest = this.entrypoint
    ? this.createSyntheticManifest(absoluteProjectPath)
    : await this.discoveryManager.discover(absoluteProjectPath);

  const units = this.discoveryManager.buildIndexingUnits(manifest);
  const filtered = this.applyServiceFilter(units);

  return this.workflowExecutor.executeSingleRoot(manifest, filtered, absoluteProjectPath);
}
```

**Result:** run() shrinks from 277 lines → ~50 lines.

---

## Revised Execution Plan

Don's original plan was:
1. GraphInitializer (78 lines)
2. GuaranteeChecker (53 lines)
3. DiscoveryManager (193 lines)
4. ParallelAnalysisRunner (150 lines)

**Revised plan:**
1. GraphInitializer (78 lines) — simplest, no state
2. GuaranteeChecker (53 lines) — self-contained
3. DiscoveryManager (193 lines) — medium complexity
4. ParallelAnalysisRunner (150 lines) — highest complexity
5. **WorkflowExecutor (250-300 lines)** — batch processing + phase coordination

**Each extraction is atomic:**
- Extract class
- Update Orchestrator to call it
- Run tests
- Commit

**After all 5 extractions:** Orchestrator drops to ~210-230 lines ✓

---

## Summary

**What Don got right:**
- Accurate diagnosis: file is 1,248 lines, far over threshold
- Solid extraction boundaries for 4 helper classes
- Safe migration strategy (atomic commits, tests first)
- Correct risk assessment (medium)

**What Don missed:**
- **Acceptance criteria requires < 500 lines, not < 800 lines**
- After extracting 4 helpers, Orchestrator still has 800 lines remaining
- The core problem is run()/runMultiRoot() workflow logic (449 lines combined)
- **Fifth extraction (WorkflowExecutor) is REQUIRED to meet acceptance criteria**

**Action required:**
- Don must revise plan to include WorkflowExecutor extraction
- Update line count projections to show < 500 lines final result
- Re-present plan for approval

---

## Next Steps

1. Don revises plan to add WorkflowExecutor extraction
2. Update projections: 1,248 → ~210-230 lines (instead of ~800)
3. Re-run auto-review
4. Present to user for final approval
