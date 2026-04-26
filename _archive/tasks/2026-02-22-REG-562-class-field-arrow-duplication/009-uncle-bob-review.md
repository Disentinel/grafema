# Uncle Bob Code Quality Review: REG-562

**Reviewer:** Robert C. Martin (Uncle Bob)
**Date:** 2026-02-22
**Verdict: APPROVE**

---

## Files Reviewed

1. `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` — guard in `ArrowFunctionExpression`
2. `test/unit/ClassFieldArrowDedup.test.js` — new test file
3. `test/unit/ArrowFunctionArgDedup.test.js` — updated test file (Test 4 / regression anchor)

---

## Checklist

### 1. The New Guard

**Location:** `FunctionVisitor.ts`, lines 298–300

```typescript
// Skip arrow functions used as class field initializers — ClassVisitor is authoritative (REG-562)
const parent = path.parent;
if (parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty') return;
```

**Readable?** Yes. The guard is two lines of code: one variable hoist, one conditional. There is nothing to puzzle over.

**Comment explains WHY?** Yes. The comment answers the question a future reader would immediately ask: "why are we skipping these?" The answer — "ClassVisitor is authoritative" — communicates the design contract, not the mechanism. The REG-562 ticket reference allows anyone to trace full history. This is exactly how comments should work.

**Placed correctly?** Yes. The guard sits immediately after the existing `getFunctionParent()` early-return guard, which handles the nested-function case. Ordering is logical: first check for function parent (general nesting), then check for class field parent (specific context). Both guards share the same structural purpose: "is this arrow something FunctionVisitor should skip?" Placing the new guard anywhere else would scatter the early-exit logic.

**Variable hoist side-effect?** The `const parent` declaration was previously at line 311, inside the block that follows all early returns. Moving it to line 299 to serve the new guard is the correct refactoring — `parent` is now used before that former location. This is not a hack; it is honest variable placement. No forbidden patterns introduced.

---

### 2. Method Size

`ArrowFunctionExpression` handler: the guard adds 3 lines (comment + variable declaration + conditional), removes 1 line (the former `const parent` at its old location). Net change: +2 lines.

Pre-change the handler was approximately 97 lines. Post-change it is approximately 99 lines. Still under 100. No concern.

The method was already approaching the boundary. That is pre-existing technical debt outside this ticket's scope, and correctly left alone per the project's refactoring policy (refactoring belongs in STEP 2.5, not in a bug fix).

---

### 3. Test File Quality (`ClassFieldArrowDedup.test.js`)

**Test names:**
All 8 test names are imperative and specific. They communicate the expected cardinality ("exactly 1", "exactly 2") and the scenario. A failing test name alone tells you what broke. This is the standard.

**Test coverage:**
The 8 cases are well chosen and complete:
- Basic field (the core bug)
- Multi-param field (same mechanism, different shape)
- Multiple fields (verifies no cross-field interference)
- Static field (exercises `ClassProperty` static path)
- Private field (exercises `ClassPrivateProperty` path — the second branch of the guard)
- Nested inner arrow (verifies the guard does not suppress inner arrows that NestedFunctionHandler should handle)
- Field alongside class method (mixed-member class, regression for method count)
- Class expression (not just class declaration)

Test 5 (private field) and Test 6 (nested inner) are particularly important. Test 5 verifies the second branch of the guard (`ClassPrivateProperty`). Test 6 verifies the guard's precision: the outer arrow is skipped (correct), but the inner arrow inside the field's body is not skipped (correct — it goes through NestedFunctionHandler). Without Test 6, a too-broad guard could be missed.

**Assertions:**
Each test makes two assertions: (a) named function count = 1, and (b) total function count = expected. The error messages include the actual data (name:id pairs), which means a failing test self-reports what went wrong without needing a debugger. This is good practice.

**Arrange / Act / Assert structure:**
All tests follow the same pattern: `setupTest` (Arrange + Act together, which is acceptable here because Act is a full pipeline run), then `getAllNodes()`, then assertions. Clean and consistent.

**Setup duplication:**
`setupTest` is extracted as a shared helper. The `beforeEach` / `after` lifecycle is consistent. No duplication in setup logic.

One minor observation: `setupTest` returns `{ testDir }` but no test uses `testDir`. This is dead return value. It is not a defect — nothing is wrong — but it is mild noise. This pattern exists identically in `ArrowFunctionArgDedup.test.js`, so it is inherited infrastructure, not new tech debt from this ticket.

**Forbidden patterns:**
None. No TODOs, FIXMEs, HACKs, empty implementations, or commented-out code.

---

### 4. `ArrowFunctionArgDedup.test.js` — Test 4 Update

The former "known bug / skipped" placeholder for the class field arrow case has been replaced with a live passing test that anchors the REG-562 fix as a regression guard inside the REG-559 test suite. The comment in the test explains the before/after behavior. This is the right approach: one suite owns the deep coverage (ClassFieldArrowDedup), and the sibling suite keeps a smoke-level regression anchor.

---

### 5. Naming Clarity

The comment `// Skip arrow functions used as class field initializers — ClassVisitor is authoritative (REG-562)` is unambiguous. "Initializers" is the correct domain term for this AST construct. "Authoritative" expresses the design decision (ownership), not just the effect. The ticket reference is present. Full marks.

---

## Summary

This is a minimal, correct, well-tested fix. The guard is placed correctly, commented correctly, and exercises no side-effects. The test file is thorough, covers both branches of the guard, and includes the boundary case (nested inner arrow) that would catch an overly broad implementation. No forbidden patterns. Method size remains acceptable.

The only observable noise — `setupTest` returning `testDir` that callers ignore — is inherited infrastructure, not introduced by this change.

**APPROVE**
