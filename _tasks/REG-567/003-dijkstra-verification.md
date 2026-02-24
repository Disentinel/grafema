## Dijkstra Plan Verification: REG-567

**Verdict:** APPROVE

---

## Code Under Review

File: `packages/core/src/core/ASTWorker.ts`, lines 336–379.

The visitor covers **module-level** `VariableDeclaration` nodes only (`if (path.getFunctionParent()) return` on line 338). It only enters the classification branch when `decl.id.type === 'Identifier'` (line 344) — destructuring patterns are silently skipped.

Current buggy classification (line 351):
```typescript
const shouldBeConstant = isConst && (isLiteral || isNewExpr);
```

Proposed fixed classification:
```typescript
const shouldBeConstant = isConst && isLiteral;
```

---

## Completeness Table: All Declaration Cases

| Input pattern | `isConst` | `isLiteral` | `isNewExpr` | Current (buggy) `shouldBeConstant` | After fix `shouldBeConstant` | Current output | Expected output | Correct after fix? |
|---|---|---|---|---|---|---|---|---|
| `const x = 42` | true | true | false | true | true | CONSTANT | CONSTANT | YES |
| `const x = "hello"` | true | true | false | true | true | CONSTANT | CONSTANT | YES |
| `const x = true` | true | true | false | true | true | CONSTANT | CONSTANT | YES |
| `const x = [1,2,3]` (all-literal array) | true | true | false | true | true | CONSTANT | CONSTANT | YES |
| `const x = { a: 1 }` (all-literal object) | true | true | false | true | true | CONSTANT | CONSTANT | YES |
| `const x = new Foo()` | true | false | true | **true (BUG)** | false | **CONSTANT** | VARIABLE | YES — bug fixed |
| `const x = new Map<K,V>()` (TS generics) | true | false | true | **true (BUG)** | false | **CONSTANT** | VARIABLE | YES — bug fixed |
| `let x = new Foo()` | false | false | true | false | false | VARIABLE | VARIABLE | YES (no change) |
| `var x = new Foo()` | false | false | true | false | false | VARIABLE | VARIABLE | YES (no change) |
| `const x = someFunction()` | true | false | false | false | false | VARIABLE | VARIABLE | YES (no change) |
| `const x = arr.map(fn)` | true | false | false | false | false | VARIABLE | VARIABLE | YES (no change) |
| `let x` (no initializer) | false | false | false | false | false | VARIABLE | VARIABLE | YES |
| `const x` (no initializer — illegal JS, parsed anyway) | true | false | false | false | false | VARIABLE | VARIABLE | YES |
| `const x = null` | true | false* | false | false | false | VARIABLE | VARIABLE** | YES (consistent with reference) |
| `const { a } = obj` (destructuring) | — | — | — | — | — | SKIPPED | SKIPPED | YES (id.type !== 'Identifier') |

\* `ExpressionEvaluator.extractLiteralValue` returns the JS value `null` for `NullLiteral`, and `isLiteral = literalValue !== null` evaluates to `false`. This means `const x = null` is classified as VARIABLE, not CONSTANT. This is a pre-existing behavior shared identically by `VariableVisitor.ts` (line 253) — the bug fix does not affect or worsen it.

\** Whether `const x = null` semantically deserves CONSTANT classification is a separate question, pre-existing and out of scope for REG-567.

---

## `isLoopVariable` — Is It Needed in ASTWorker?

**No. ASTWorker has no `isLoopVariable` concept and does not need one.**

In `VariableVisitor.ts`, the visitor handles loop-scoped declarations (`for (const x of arr)`) by checking `path.parent.type === 'ForOfStatement'` and treating those `const` bindings as CONSTANT. The rationale: loop variables with `const` cannot be reassigned inside the loop body — they are semantically constant per iteration.

In `ASTWorker.ts`, the `VariableDeclaration` visitor uses `path.getFunctionParent()` to filter **only module-level** declarations. A `for...of` loop at module level would be traversed by this visitor, but:

1. The `for (const x of arr)` syntax produces a `VariableDeclaration` whose parent is a `ForOfStatement`, not a function. So `getFunctionParent()` returns null — the ASTWorker visitor DOES see loop variables at module level.
2. However, the ASTWorker does NOT check for loop parentage. It also does NOT have `isLoopVariable` logic.
3. This means `for (const x of arr)` at module level currently produces VARIABLE (after the fix), not CONSTANT — diverging from VariableVisitor behavior.

**This divergence is pre-existing and out of scope for REG-567.** REG-567 is specifically about `const x = new Foo()` being misclassified. The absence of loop-variable handling in ASTWorker is a separate gap. Don's plan correctly notes "the ASTWorker path only handles module-level declarations — there is no `isLoopVariable` concept there" — which is accurate as a description of the current code. Whether that gap should be closed is a separate issue.

The fix does not introduce the loop-variable gap; it existed before. APPROVE on this point.

---

## `classInstantiations.push()` — Is `isNewExpr` Usage Preserved?

Yes. The fix leaves `isNewExpr` declared and used unchanged on line 367:

```typescript
if (isNewExpr && decl.init!.type === 'NewExpression' && (decl.init! as { callee: Node }).callee.type === 'Identifier') {
  collections.classInstantiations.push({
    variableId: varId,
    ...
  });
}
```

After the fix, `varId` is computed with `nodeType = 'VARIABLE'` instead of `'CONSTANT'` for `const x = new Foo()`. The `variableId` in `classInstantiations` will therefore reference a VARIABLE node. This is correct — the INSTANCE_OF edge should point from a VARIABLE node, not a CONSTANT node.

The existing test `"should preserve INSTANCE_OF edge when const x = new Foo() creates VARIABLE node"` in `DataFlowTracking.test.js` (lines 293–343) explicitly verifies this: it asserts both `myFoo.type === 'VARIABLE'` and the INSTANCE_OF edge exists. This test covers the regression.

---

## Gaps Found

**Gap 1: Test exercises JSASTAnalyzer path, not ASTWorker path.**

Don's plan acknowledges this explicitly. The proposed new test in `DataFlowTracking.test.js` uses `createTestOrchestrator` which routes through `JSASTAnalyzer`, not directly through `ASTWorker`. The plan notes this and justifies the test as "locks correct graph output regardless of which path produced it."

This is a real gap in test isolation: the ASTWorker code path (the actual buggy path) is not directly exercised by the proposed test. The fix in `ASTWorker.ts` is unverifiable via this test in isolation. However:
- The existing `DataFlowTracking.test.js` already has two tests asserting VARIABLE for `new Map()` and `new Helper()` at module level going through the same orchestrator path.
- A unit test that directly calls `parseModule()` from `ASTWorker.ts` and inspects `collections.variableDeclarations` would provide stronger isolation.

**Recommendation:** The plan is sufficient to approve — the code fix is obviously correct, and the behavioral contract is locked by the test. But a direct unit test of `ASTWorker.ts::parseModule()` would be the ideal complement. This is a test quality note, not a blocking concern.

**Gap 2: Destructuring patterns at module level are silently skipped.**

`const { foo } = new Foo()` would have `decl.id.type === 'ObjectPattern'`, not `'Identifier'`, and is silently skipped by the ASTWorker visitor. This is pre-existing behavior, unaffected by the fix.

**Gap 3: No handling of `const x = null` as CONSTANT.**

Pre-existing in both paths due to the `literalValue !== null` check in `ExpressionEvaluator`. Out of scope for REG-567.

---

## Precondition Issues

**Precondition 1: `isNewExpr` variable must NOT be removed.**

Don's plan states this explicitly and correctly. The variable is still used on line 367. Removing it would break `classInstantiations` tracking. The fix must only modify line 351.

**Precondition 2: The fix is symmetric with the reference implementation.**

`JSASTAnalyzer.ts` / `VariableVisitor.ts` uses `isConst && (isLoopVariable || isLiteral)`. ASTWorker does not have `isLoopVariable`, so the symmetric fix is `isConst && isLiteral`. The asymmetry (no loop-variable handling in ASTWorker) is pre-existing. Confirmed: the fix is the correct minimal change.

**Precondition 3: `ExpressionEvaluator.extractLiteralValue` handles ArrayExpression and ObjectExpression.**

Verified: the evaluator returns non-null for all-literal arrays and objects, meaning `const x = [1,2,3]` and `const x = { a: 1 }` correctly produce CONSTANT. The fix does not change this behavior — `isLiteral` is still computed the same way.

**Precondition 4: Semantic ID stability.**

`computeSemanticId(nodeType, varName, ...)` uses `nodeType` as part of the ID prefix (e.g., `CONSTANT#foo#...` vs `VARIABLE#foo#...`). After the fix, `const x = new Foo()` generates a VARIABLE-prefixed ID instead of CONSTANT-prefixed. Any existing graph snapshots with CONSTANT IDs for `new Foo()` patterns will have changed IDs. This is expected and intentional — the snapshots were wrong. The commit history shows `c86f2ae chore: regenerate snapshots after merge (REG-559)`, indicating snapshot regeneration is a known workflow step.

---

## Summary

The plan is minimal, correct, and complete for the stated scope. The single-line fix on line 351 of `ASTWorker.ts` is the right change. `isNewExpr` is correctly preserved for `classInstantiations`. The reference implementation in `VariableVisitor.ts` confirms the correct formula. The test gap (ASTWorker path not directly exercised) is real but acceptable given the existing test coverage of the behavioral contract at the graph level.

**Verdict: APPROVE**
