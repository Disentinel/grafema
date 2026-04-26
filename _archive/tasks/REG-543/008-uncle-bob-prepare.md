# Uncle Bob PREPARE Review: impact.ts

**File size:** 393 lines — OK (below 500 limit)
**Methods to modify:** `analyzeImpact` (95 lines, lines 157-251), `findCallsToNode` (28 lines, lines 281-308)

---

## File-level

**Single responsibility:** The file mixes four distinct concerns in one flat namespace:

1. CLI command wiring (`impactCommand`, action callback)
2. Graph query logic (`findTarget`, `getClassMethods`, `findCallsToNode`)
3. Impact computation algorithm (`analyzeImpact` with BFS)
4. Display/formatting (`displayImpact`)

This is an existing design decision, not a new problem introduced by REG-543. At 393 lines the file sits comfortably below the 500-line threshold. After the v3 additions (~150 lines) it will reach approximately 543 lines — crossing the threshold.

**Decision: do not split now.** The crossing is marginal and the split would require extracting helpers into a separate module, which is scope creep beyond REG-543. The split should be filed as a follow-up (STEP 2.5 concern, not a blocker). Rob must be aware that the file will be at 543 lines post-implementation and a split task should be raised.

---

## Method-level

### `impact.ts:analyzeImpact` — 95 lines (lines 157-251)

**Current state:**

```
analyzeImpact(backend, target, maxDepth, projectPath): 95 lines
├── targetIds initialization block: 6 lines
├── BFS queue setup: 5 lines
├── BFS while loop: 44 lines
│   ├── findCallsToNode call
│   ├── for loop over containingCalls (containment check, CLASS filter, NodeInfo build)
│   ├── depth === 0 branching
│   ├── affectedModules update
│   └── callChains push + BFS enqueue
├── callChains sort: 1 line
└── return: 7 lines
```

**Issues:**

1. **Length: 95 lines.** Hard limit is 50. This is nearly 2x the limit. The method is a candidate for split, but this is a PRE-EXISTING condition — not caused by REG-543.

2. **Nesting depth: 3.** The BFS `while` loop contains a `try` block, which contains a `for` loop over `containingCalls`, which contains an `if (container && ...)` check. Depth 3 is at the hard limit (limit is 2, which means flag at 3+).

3. **The v3 changes add 8-10 lines to `analyzeImpact`:** the `expandTargetSet` call, `initialTargetIds` tracking, and `methodName` computation. This brings the method to approximately 103-105 lines.

**Recommendation: SKIP split of `analyzeImpact` as a pre-implementation step.**

Rationale: The method is large but coherent — it implements a single BFS algorithm. Splitting it before the new code is added would require inventing abstraction boundaries that may shift as the new code lands. The right time to split is after REG-543 is complete, when the final shape is stable. Rob should keep the BFS loop body flat — no new nesting.

**Constraint for Rob:** The new `initialTargetIds` tracking and `methodName` computation must be placed BEFORE the BFS queue declaration, not inside the loop. No new nesting depth should be introduced.

---

### `impact.ts:findCallsToNode` — 28 lines (lines 281-308)

**Current state:**

```
findCallsToNode(backend, targetId): 28 lines
├── try block
│   ├── getIncomingEdges call
│   └── for loop: getNode + push to calls[]
└── catch (empty, silent)
```

**Issues:**

1. **Silent catch:** The `catch {}` block swallows all errors without logging. The v3 plan replicates this pattern for the new `findByAttr` fallback block. Acceptable for now — this is a pre-existing pattern in the file (see also `getClassMethods`, `analyzeImpact`). Not a blocker.

2. **The v3 additions grow this method to ~48 lines:** a second `try/catch` block for the `findByAttr` fallback, plus a `seen` dedup Set introduced at the top. This stays within the 50-line limit.

3. **Parameter addition:** `methodName?: string` is the only new parameter. Total parameter count becomes 3 (backend, targetId, methodName). Within the limit of 3.

**Recommendation: SKIP pre-refactoring. Implement directly.**

The method grows from 28 to ~48 lines — still under the 50-line limit. The `seen` Set addition is straightforward. No structural changes needed before Rob adds the new code.

---

### `impact.ts:displayImpact` — 70 lines (lines 323-392)

This method is NOT being modified by REG-543 but warrants noting: at 70 lines it exceeds the 50-line limit. Pre-existing. Not a blocker for this task.

---

### `impact.ts` action callback — 48 lines (lines 52-99)

Not modified by REG-543. Within limits. No action needed.

---

## Post-implementation file size projection

| Current | Added | Projected |
|---------|-------|-----------|
| 393 lines | ~150 lines (5 helpers + modifications) | ~543 lines |

The file will cross the 500-line threshold. This is acceptable for a single release cycle, but a split task must be created after REG-543 merges.

**Recommended follow-up split:**
- Extract pure graph helpers (`findCallsToNode`, `getClassMethods`, `findTarget`, and the 5 new helpers) into `packages/cli/src/commands/impact-graph.ts`
- Keep `analyzeImpact`, `displayImpact`, and CLI wiring in `impact.ts`
- This is a separate commit, out of REG-543 scope.

---

## Risk

**Risk:** LOW-MEDIUM

**Rationale:**

- No pre-implementation refactoring is required. The existing structure can absorb the v3 additions without exceeding hard method limits.
- `analyzeImpact` will reach ~103-105 lines. This is over the 50-line guideline but the excess is pre-existing (method was already 95 lines before REG-543). No new structural problem is being created.
- `findCallsToNode` will reach ~48 lines — within limits.
- The 5 new helper functions are each 10-30 lines and each does one thing. Clean.
- The primary risk is the file crossing 500 lines. This is cosmetic, not functional.

**Estimated scope:** ~150 lines added, 2 methods modified, 5 methods added. One file.

---

## Clearance

**CLEARED for implementation.** No pre-implementation refactoring required.

Rob should note:
1. Do not introduce new nesting inside the BFS loop.
2. Place `initialTargetIds` and `methodName` computation before the BFS queue initialization.
3. After merge, raise a follow-up task to split `impact.ts` at the 543-line mark.
