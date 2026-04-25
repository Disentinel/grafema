## Uncle Bob PREPARE Review: VariableVisitor.ts + JSASTAnalyzer.ts

---

## Uncle Bob PREPARE Review: VariableVisitor.ts

**File size:** 484 lines — OK (under 500 hard limit)
**Methods to modify:** `getHandlers` (lines 178–483, ~305 lines)

**File-level:**
- OK. Single responsibility: module-level variable declaration handling. No splitting needed.

**Method-level:** VariableVisitor.ts:getHandlers
- **Length:** ~305 lines. Well over the 50-line candidate threshold. However, the method is a closure factory — it sets up shared locals and returns a visitor map object. The inner `VariableDeclaration` handler is where the actual logic lives. This is pre-existing; we are NOT refactoring it in STEP 2.5.
- **The change is surgical:** two lines are touched. Line 253: remove `|| isNewExpression` from `shouldBeConstant`. Lines 282–294: move the `classInstantiations.push()` block from inside the `if (shouldBeConstant)` branch to after the if/else block. The change is about 8 lines relocated, zero new abstractions needed.
- **Nesting depth:** The handler body is deep (VariableDeclaration callback -> forEach declarator -> forEach varInfo). This is pre-existing. The fix does not add nesting; it reduces it by pulling `classInstantiations.push()` one level out of the `if (shouldBeConstant)` branch.
- **Naming:** `isNewExpression`, `shouldBeConstant`, `classInstantiations` are clear. `isNewExpression` will become a dead variable after `|| isNewExpression` is removed from `shouldBeConstant` — but it is still needed for the relocated `if (isNewExpression)` block below. No rename required.
- **Recommendation:** SKIP refactoring. Proceed with the bug fix only.

**Risk:** LOW
**Estimated scope:** ~10 lines affected (1 line edited for shouldBeConstant, ~8 lines relocated for classInstantiations block, 1 comment update)

---

## Uncle Bob PREPARE Review: JSASTAnalyzer.ts

**File size:** 4283 lines — CRITICAL by absolute measure, but this is a pre-existing condition outside task scope.

Context: JSASTAnalyzer.ts is a known 4000+ line file. Splitting it is not a STEP 2.5 action — it is a separate refactoring task that requires careful planning and would exceed the 20% time budget. Record as tech debt.

**Methods to modify:** `handleVariableDeclaration` (lines 2050–2217, ~167 lines)

**File-level:**
- CRITICAL line count is pre-existing and out of scope for this task. No action in this PREPARE phase. A tech debt issue should be created separately for JSASTAnalyzer decomposition.

**Method-level:** JSASTAnalyzer.ts:handleVariableDeclaration
- **Length:** ~167 lines. Over the 50-line threshold but this is pre-existing structure. The method handles one coherent concern (variable declaration node creation and assignment tracking), split internally into loop-variable vs regular branches. Not a candidate for splitting within this task.
- **Parameter count:** 14 parameters. This is a pre-existing problem — well over the 3-parameter guideline. A Parameter Object refactor would be appropriate but belongs in a separate task, not STEP 2.5 here.
- **The change is surgical:** identical to VariableVisitor fix. Line 2084: remove `|| isNewExpression` from `shouldBeConstant`. Lines 2119–2129: move the `classInstantiations.push()` block outside the `if (shouldBeConstant)` branch.
- **Nesting depth:** Two levels of forEach (declarator -> variables). Pre-existing. The fix does not add depth.
- **Recommendation:** SKIP refactoring. Proceed with the bug fix only.

**Risk:** LOW
**Estimated scope:** ~10 lines affected (same as VariableVisitor: 1 line edited, ~8 lines relocated)

---

## Overall Assessment

Both changes are minimal, symmetric, and low-risk. The pattern is identical in both files: remove one boolean operand, relocate one block outside a conditional. No new abstractions, no signature changes, no control flow restructuring.

The pre-existing issues (305-line closure in VariableVisitor, 4283-line JSASTAnalyzer, 14-parameter method) are real code quality debts but are NOT blockers for this fix. They should be filed as separate tech debt items.

**Proceed to implementation.**
