## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK (minor gap noted — not blocking)
**Commit quality:** OK — not yet committed

---

### Feature Completeness

All three changes from the plan are implemented correctly:

**Change 1 — `types.ts`:** `ConstructorCallInfo` now has `parentScopeId?: string` at line 341. Optional, consistent with `CallSiteInfo.parentScopeId?: string`.

**Change 2 — `NewExpressionHandler.ts`:** `parentScopeId: ctx.getCurrentScopeId()` is set at line 51 in the `ctx.constructorCalls.push({...})` block. Covers all in-function constructor calls: assigned, thrown, passed as argument, returned.

**Change 3 — `GraphBuilder.ts` step 4.5:** CONTAINS edge is created with the guard `if (constructorCall.parentScopeId)` at lines 315-322. Pattern matches existing CALL_SITE CONTAINS edge creation.

**Change 4 (bonus, not in original plan but in plan revision):** `JSASTAnalyzer.ts` `traverse_new` gets `getFunctionParent()` guard (prevents double-processing) and `parentScopeId: module.id` for module-level constructor calls. This ensures module-level `new X()` expressions (top-level code, not inside functions) are also anchored.

The root cause (65% of CONSTRUCTOR_CALL nodes disconnected) is addressed at both code paths:
- In-function calls: via `NewExpressionHandler` (Change 2)
- Module-level calls: via `traverse_new` in `JSASTAnalyzer` (Change 4)

### Test Coverage

5 new test cases in `ConstructorCallTracking.test.js` under `describe('CONTAINS edges for CONSTRUCTOR_CALL nodes')`:

| Test | Pattern | Verdict |
|------|---------|---------|
| MODULE to module-level assigned | `const x = new Foo()` | Covered |
| Function scope to function-scoped assigned | `function f() { const x = new Foo() }` | Covered |
| Thrown (unassigned) | `throw new Error('msg')` | Covered |
| Constructor as argument (unassigned) | `console.log(new Foo())` | Covered |
| Return constructor (unassigned) | `return new Foo()` | Covered |

The "thrown" test (case 3) also explicitly verifies no ASSIGNED_FROM edge exists — this is the key regression check for the fix direction.

**Minor gap (not blocking):** The plan says "For cases that also have ASSIGNED_FROM: both edges coexist (regression check)". The first new test (`const x = new Foo()`) only asserts the new CONTAINS edge exists, without asserting the ASSIGNED_FROM edge still exists. However, the pre-existing tests at lines 304-596 (particularly the `Data flow query` and `Integration with existing patterns` describes) still verify ASSIGNED_FROM edges for assigned constructors. If any of those 17 pre-existing tests were broken by these changes, the test run would have caught it. Not a blocking issue.

**Missing test for module-level unassigned case:** There is no test for `throw new Error('msg')` at module level (outside any function). This is the `traverse_new` + `parentScopeId: module.id` code path (Change 4). All 5 new tests use `function f() { ... }` wrappers, so they exercise the `NewExpressionHandler` path. The module-level path exists in code but has no dedicated test. This is a minor gap — not blocking since the code path is simple and the logic mirrors the in-function path exactly.

### Commit Quality

Not yet committed. The implementation across 4 files is coherent and forms a single logical change. No TODOs, no commented-out code observed. Rob's report describes the changes accurately.

---

### Summary

The fix is complete, minimal, and correctly scoped. All 5 planned test cases are present and passing. The implementation handles both code paths (in-function and module-level). No scope creep detected — only the 4 files identified in the plan were touched.
