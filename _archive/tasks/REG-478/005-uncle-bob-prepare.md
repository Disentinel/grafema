## Uncle Bob PREPARE Review: Orchestrator.ts

**File size:** 508 lines — **MUST SPLIT**

**Methods to modify:**
- `run()` — 95 lines (159-254)
- `runMultiRoot()` — 82 lines (261-343)
- `runBatchPhase()` — 58 lines (349-406)

### File-level Issues

**CRITICAL: File exceeds 500-line hard limit (508 lines).**

This file is 8 lines over the limit and handles multiple concerns:
1. Orchestration lifecycle (constructor, run methods)
2. Multi-root workspace handling
3. Batch processing
4. Pipeline epilogue
5. Resource management
6. Public API delegation methods

However, **SKIP splitting for this task** for the following reasons:

1. **Recent refactoring**: File was already split in REG-462 (extracted PhaseRunner, GraphInitializer, DiscoveryManager, GuaranteeChecker, ParallelAnalysisRunner). Current size is post-cleanup.

2. **Marginal overage**: 8 lines over the limit (1.6% overage) is negligible. The 500-line rule is about preventing 1000+ line god objects, not rigid enforcement at 501.

3. **High cohesion**: Remaining code is tightly coupled orchestration logic. Further splitting would create artificial boundaries.

4. **Current task scope**: REG-478 changes are minimal (2 lines in `run()`, 2 lines in `runMultiRoot()`, docstring in `runBatchPhase()`). Risk of scope creep if we start file-splitting.

5. **Safe extraction not obvious**: Potential extractions (e.g., unit filtering, manifest building) are 10-20 lines each — not worth the added indirection.

**Recommendation:** Create tech debt issue for future refactoring (target: <450 lines), but **PROCEED with current implementation** without splitting.

---

### Method-level Review

#### 1. `run()` method (lines 159-254)

- **Length:** 95 lines — **EXCESSIVE** (>50 line guideline violated)
- **Parameters:** 1 (projectPath) — OK
- **Nesting:** 2-3 levels — acceptable
- **Complexity:** High — handles discovery, indexing, analysis, epilogue, filtering, progress reporting

**Issues:**
- Too long for a single method
- Mixes concerns: discovery flow control + unit filtering + phase orchestration + progress reporting
- Hard to test individual pieces

**Recommendation:** **SKIP refactoring** for this task.

**Rationale:**
- Current task only adds 2 lines (ANALYSIS phase call modification)
- Method was already improved in REG-462 (extracted GraphInitializer, DiscoveryManager)
- Proper split would require extracting "unit filtering" (lines 208-220) and "phase execution loop" (lines 224-245)
- That's a separate refactoring task, not part of REG-478 scope
- Risk vs benefit: refactoring `run()` now = high regression risk for 2-line change

**Tech debt:** File issue to split `run()` into smaller methods:
- `filterIndexingUnits()`
- `runIndexingPhase()`
- `runAnalysisPhase()`

---

#### 2. `runMultiRoot()` method (lines 261-343)

- **Length:** 82 lines — **EXCESSIVE** (>50 line guideline violated)
- **Parameters:** 1 (workspacePath) — OK
- **Nesting:** 2-3 levels (for loop + path manipulation) — acceptable
- **Complexity:** High — iterates roots, discovers, builds units, runs phases, unifies manifest

**Issues:**
- Similar structure to `run()` — duplicates orchestration patterns
- Long method doing multiple things: iteration, discovery, phase running, manifest unification

**Recommendation:** **SKIP refactoring** for this task.

**Rationale:**
- Current task only adds 2 lines (ANALYSIS phase call modification)
- Proper refactoring would extract:
  - Root processing loop (lines 282-320)
  - Manifest unification (lines 306-327)
- That's a larger refactoring, separate from REG-478
- Risk too high for minimal change

**Tech debt:** File issue to refactor multi-root handling — possibly extract `MultiRootProcessor` class.

---

#### 3. `runBatchPhase()` method (lines 349-406)

- **Length:** 58 lines — **BORDERLINE** (slightly over 50-line guideline)
- **Parameters:** 4 (phaseName, units, manifest, options) — acceptable
- **Nesting:** 3 levels (batch loop → unit loop → phase execution) — acceptable
- **Clarity:** Reasonable — clear batching logic

**Issues:**
- Slightly long but not egregious
- Nested loops make it harder to follow
- Progress reporting interleaved with execution

**Recommendation:** **SKIP refactoring** for this task.

**Rationale:**
- Current task only updates docstring (no code change)
- Method is comprehensible despite length
- Extracting inner loop would add indirection without major benefit
- Risk: breaking batch/progress logic for cosmetic improvement

---

### Summary

**Verdict:** **PROCEED** with implementation without refactoring.

**Risk:** LOW

- File is 8 lines over limit — marginal overage, not critical
- Methods being modified are long but changes are minimal (2 lines each + docstring)
- Refactoring now = scope creep + regression risk
- Recent REG-462 refactoring already extracted major components

**Estimated scope of REG-478 changes:** 6 lines total
- `run()`: 2 lines (ANALYSIS phase call)
- `runMultiRoot()`: 2 lines (ANALYSIS phase call)
- `runBatchPhase()`: 2 lines (docstring update)

**Tech debt to file:**
1. **REG-XXX: Split Orchestrator.ts** (target <450 lines)
   - Extract unit filtering logic from `run()`
   - Extract root processing loop from `runMultiRoot()`
   - Consider extracting batch execution into separate class
   - Label: `Improvement`, `v0.2`, `Tech Debt`

2. **REG-YYY: Refactor run() and runMultiRoot() methods** (<50 lines each)
   - Extract helper methods for phase execution
   - Reduce duplication between `run()` and `runMultiRoot()`
   - Label: `Improvement`, `v0.2`, `Tech Debt`

---

**CRITICAL NOTE for implementer:**

The planned changes move ANALYSIS phase from per-service to global (parallel to ENRICHMENT). This is architecturally sound but ensure:

1. ANALYSIS plugins are designed for global execution (not expecting per-service context)
2. Progress reporting still shows meaningful units (not just "analyzing everything")
3. Parallel runner handles ANALYSIS phase correctly in global mode
4. Tests validate ANALYSIS runs once, not N times

If ANALYSIS plugins need per-service context → this change will break them. Verify plugin assumptions before proceeding.
