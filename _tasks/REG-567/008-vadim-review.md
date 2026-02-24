## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK (with one minor gap noted)
**Commit quality:** N/A — not yet committed

---

### Acceptance Criteria Checklist

**AC1: ASTWorker.ts line 351 region removes `isNewExpr` from `shouldBeConstant` logic**
PASS. Line 351 reads `const shouldBeConstant = isConst && isLiteral;` — `isNewExpr` is absent from the condition. The variable `isNewExpr` is still declared on line 350 (used only for the classInstantiations push on line 367), which is correct.

**AC2: `const x = new SomeClass()` creates VARIABLE nodes in parallel analysis**
PASS. With `shouldBeConstant = isConst && isLiteral`, a NewExpression initializer yields `isLiteral = false` (ExpressionEvaluator.extractLiteralValue returns null for NewExpression), so `shouldBeConstant = false` and the node type becomes VARIABLE.

**AC3: INSTANCE_OF edges are created for all NewExpression regardless of const/let**
PASS. The classInstantiations push (lines 367-375) is conditioned only on `isNewExpr` and callee type — not on `shouldBeConstant`. A separate test at line 293 ("should preserve INSTANCE_OF edge when const x = new Foo() creates VARIABLE node") verifies INSTANCE_OF and ASSIGNED_FROM edges explicitly.

**AC4: Unit test verifies parallel path behavior matches sequential path**
PASS. Test at line 345 ("should create VARIABLE node for const x = new SomeService() in ASTWorker parallel path (REG-567)") covers the regression scenario. The comment in the test body is accurate and traceable to the issue.

**AC5: All existing tests pass**
PASS. Reported 2308 pass, 0 fail.

---

### Observations

**Minor gap — REG-567 dedicated test does not assert INSTANCE_OF edges.**
The REG-567-specific test (line 345) only asserts node type. It does not assert that `myService` receives an INSTANCE_OF edge to `SomeService`. This gap is mitigated by the pre-existing test at line 293 which does verify INSTANCE_OF preservation, but that test uses a different fixture (inline class `Foo`). The REG-567 test would be stronger if it also confirmed the edge. This does not warrant a REJECT since the combined test suite covers the behavior, but is worth noting for future completeness.

**Change is minimal and focused.**
The diff touches only the `shouldBeConstant` assignment on line 351 — one logical change, no unrelated modifications. No scope creep detected.

**No regressions detected.**
The `isNewExpr` variable remains in scope and its downstream use (classInstantiations push) is unchanged. The fix is surgical.
