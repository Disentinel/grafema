## Uncle Bob PREPARE Review: REG-567

### ASTWorker.ts
**File size:** 566 lines — MUST SPLIT

**Method being modified:** `parseModule`, lines 179–546, **367 lines**

**File-level:** CRITICAL. 566 lines is 13% over the hard 500-line limit. The `parseModule` function is 367 lines — a single monolithic function that drives the entire parallel-path analysis. It contains at least seven distinct `traverse(ast, {...})` call blocks, each of which is a separable concern:
1. Import extraction
2. Export extraction (named)
3. Export extraction (default)
4. Variable declaration extraction (the section being modified)
5. Function and class declaration extraction
6. Call site / method call extraction
7. HTTP request extraction (inferred from `httpRequests` collection)

This is not a function — it is a module disguised as a function.

**Method-level:**
- **Recommendation:** SKIP (for this task — refactor is warranted but must not block REG-567)
- The specific change for REG-567 is surgical: on line 351, `isNewExpr` must be removed from the `shouldBeConstant` condition. The affected region (lines 336–379) is 43 lines and is self-contained within the `VariableDeclaration` traverse block. The fix is a one-line deletion or correction of a boolean predicate.
- Refactoring `parseModule` into sub-functions (`extractVariables`, `extractFunctions`, `extractCallSites`, etc.) is the correct long-term move but is **out of scope for REG-567**. It belongs in a dedicated cleanup task.
- **Do NOT refactor `parseModule` as part of this task.** Change only what REG-567 requires.

**Risk:** LOW for the specific change. The bug (`isNewExpr` included in `shouldBeConstant`) is isolated to lines 350–351. The classInstantiation push (lines 367–375) already runs inside `if (isNewExpr)` independently of `shouldBeConstant`, so removing `isNewExpr` from the constant predicate does not disturb instantiation tracking. The tests in `DataFlowTracking.test.js` will confirm correct behavior after the fix.

---

### DataFlowTracking.test.js
**File size:** 481 lines — OK (under 500)

**Section being modified:** `describe('NewExpression Assignments', ...)`, lines 193–344, **151 lines**

**File-level:** OK. 481 lines is within limits. The describe-block structure is clean and well-separated by concern.

**Method-level:**
- **Recommendation:** SKIP
- The existing `NewExpression Assignments` block already contains the relevant regression tests added for REG-546. No new tests need to be invented from scratch — REG-567 may need to add one targeted test for the ASTWorker parallel path (`const x = new Foo()` at module level producing VARIABLE, not CONSTANT), distinct from the VariableVisitor and JSASTAnalyzer paths already covered at lines 227–245 and 247–270.
- If a test for the ASTWorker module-level path is missing, it must be added inside the existing `NewExpression Assignments` block — **not** in a new describe block.
- The test at line 293 (`should preserve INSTANCE_OF edge when const x = new Foo() creates VARIABLE node`) already covers the combined scenario. Verify whether it exercises the ASTWorker code path specifically before adding a duplicate.

---

**Overall verdict:** Proceed with implementation? **YES**

The fix is a single predicate correction in a well-understood 43-line block. The file-size violation in `ASTWorker.ts` is pre-existing technical debt — it is real and must be tracked, but it must not block a targeted bug fix. Log a follow-up task to decompose `parseModule` into extract-* sub-functions. The test file is healthy. Proceed.
