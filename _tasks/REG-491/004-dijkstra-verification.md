# Dijkstra Plan Verification: REG-491

**Verdict:** REJECT

**Reason:** The plan addresses constructor calls inside functions but leaves module-level constructor calls disconnected. The module-level `traverse_new` traversal in `JSASTAnalyzer.ts` pushes entries to `constructorCalls` with no `parentScopeId`, and the plan does not touch this code path.

---

## 1. Two Code Paths That Collect Constructor Calls

The plan says "Change 2 — `NewExpressionHandler.ts`: Capture `parentScopeId`" as if there is one collection point. There are two:

**Code Path A — Inside functions (via `analyzeFunctionBody`):**
File: `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`, lines 43-51.
Called by `FunctionVisitor` and `ClassVisitor` for every function body.
`ctx.getCurrentScopeId()` returns the enclosing function-body scope ID — always a non-empty string.

**Code Path B — Module-level traversal:**
File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`, lines 1727-1800.
A standalone `traverse(ast, { NewExpression: ... })` that visits ALL NewExpression nodes in the file.
There is NO `getFunctionParent()` guard — it visits nodes inside functions AND at module level.
It pushes to `constructorCalls` with no `parentScopeId` field (the interface currently lacks it, so it is simply absent).

The plan only modifies Code Path A. Code Path B remains unchanged.

---

## 2. Completeness Table: Which Contexts Get a CONTAINS Edge Under the Plan

| Context | Code Path | `parentScopeId` available? | CONTAINS edge created? |
|---------|-----------|---------------------------|------------------------|
| `const x = new Foo()` inside function | A (NewExpressionHandler) | YES — function body scope | YES |
| `throw new Error()` inside function | A (NewExpressionHandler) | YES — function body scope | YES |
| `fn(new Foo())` inside function | A (NewExpressionHandler) | YES — function body scope | YES |
| `return new Foo()` inside function | A (NewExpressionHandler) | YES — function body scope | YES |
| `const x = new Foo()` at module top-level | B (traverse_new only) | NO — not captured | NO — still disconnected |
| `throw new Error()` at module top-level | B (traverse_new only) | NO — not captured | NO — still disconnected |
| `new SideEffect()` at module top-level | B (traverse_new only) | NO — not captured | NO — still disconnected |
| `for (const x of new Foo())` at module top-level | B (traverse_new only) | NO — not captured | NO — still disconnected |

The plan's test case "Assigned at module level: `const x = new Foo()` (top of file)" asserts `MODULE CONTAINS CONSTRUCTOR_CALL`. This test will FAIL because the module-level traversal does not capture `parentScopeId`, so no CONTAINS edge is created for this case.

---

## 3. Deduplication Analysis: Double-Processing of In-Function Calls

Constructor calls INSIDE functions are visited by BOTH code paths:
- Code Path A (`NewExpressionHandler`) processes them during `traverse_functions` (line 1524-1532)
- Code Path B (`traverse_new`) processes them again at lines 1727-1800 — there is no `getFunctionParent()` guard

Each path uses its own deduplication set (`ctx.processedCallSites` vs `processedConstructorCalls`), so the same constructor call is pushed to the `constructorCalls` array twice — both with the same `id` (deterministic from className+file+line+column).

GraphBuilder iterates over ALL entries in `constructorCalls`. After the fix:
- Entry from Code Path A: has `parentScopeId` → creates CONTAINS edge (correct)
- Entry from Code Path B: no `parentScopeId` → guard `if (constructorCall.parentScopeId)` skips edge creation

`_bufferNode` is called twice for the same node ID. This is pre-existing behavior, not introduced by this plan, but it means the graph database receives duplicate node writes. Whether this is idempotent depends on the RFDB implementation. This is a pre-existing issue, not a blocker for this plan specifically.

The CONTAINS edge is created once (from Code Path A entry). No double-CONTAINS edge.

---

## 4. Guard Condition: When Is `parentScopeId` Undefined?

`getCurrentScopeId()` is defined as:
```typescript
const scopeIdStack: string[] = [parentScopeId];
const getCurrentScopeId = (): string => scopeIdStack[scopeIdStack.length - 1];
```

`parentScopeId: string` is typed as non-optional in `createFunctionBodyContext`. It is always a string (function body scope ID) when `analyzeFunctionBody` is called. Therefore, inside functions, `ctx.getCurrentScopeId()` always returns a non-empty string. The `if (constructorCall.parentScopeId)` guard in GraphBuilder is vacuously never triggered for Code Path A entries. It only matters for Code Path B entries (which have no `parentScopeId` at all).

This means the guard is correct as a defensive pattern, but it does not solve the module-level problem — it silently skips those entries.

---

## 5. Test Coverage Gap

The test plan includes:
> "Assigned at module level: `const x = new Foo()` (top of file) | MODULE CONTAINS CONSTRUCTOR_CALL"

This test will fail with the plan as written. The module-level traversal (Code Path B) pushes the entry without `parentScopeId`, and the GraphBuilder guard skips edge creation. No CONTAINS edge is produced. The test will be RED after implementation — not because the code is wrong, but because the plan is incomplete.

---

## 6. Missing Fix: What the Plan Must Add

To fix module-level constructor calls, Code Path B must also capture the module scope ID. The natural approach (following the CALL_SITE pattern) is to also pass the module ID as the parent scope for module-level constructor calls.

There are two sub-options:
- Option B1: Add `getFunctionParent()` guard to `traverse_new` so it only processes truly module-level calls, then pass `module.id` as `parentScopeId` for those. This eliminates the duplicate processing of in-function calls.
- Option B2: Keep `traverse_new` as-is but add `parentScopeId: module.id` to all entries it pushes. In-function calls get two entries (one with function scope, one with module scope), producing two CONTAINS edges — which is incorrect (a constructor call cannot be CONTAINS-ed by both the function scope and the module scope).

Option B1 is correct. The `traverse_new` loop should add `getFunctionParent()` skipping and pass `module.id` for the remaining top-level calls.

---

## 7. Precondition Issues

**Precondition unverified:** The plan states "Every `new ClassName()` expression in analyzed JS/TS produces a SCOPE → CONTAINS → CONSTRUCTOR_CALL edge" as an acceptance criterion. This requires that ALL collection paths capture `parentScopeId`. Only one of two paths is fixed. The acceptance criterion is not achievable with the changes described.

**Assumption unverified:** The plan says `ctx.getCurrentScopeId()` is "already used at lines 112 and 151 in the same handler." This is true, but those are CALL_SITE nodes — they go through Code Path A only. CONSTRUCTOR_CALL nodes also go through Code Path B. The plan does not verify whether Code Path B exists.

---

## Summary of Gaps

| Gap | Severity | Specific location |
|-----|----------|-------------------|
| Module-level `traverse_new` (JSASTAnalyzer.ts:1731-1799) does not set `parentScopeId` | CRITICAL — 65% of disconnected nodes likely include module-level ones | JSASTAnalyzer.ts lines 1748-1762 |
| Test case "Assigned at module level" will fail after implementation | HIGH — test written for behavior the plan does not deliver | test plan, first row |
| No `getFunctionParent()` guard in `traverse_new` causes in-function calls to be double-processed | MEDIUM — pre-existing, not introduced here, but plan should address it for correctness | JSASTAnalyzer.ts:1731 |

**Required addition to plan:**
Change 4 — `JSASTAnalyzer.ts`: In `traverse_new` (lines 1731-1799):
1. Add `const functionParent = newPath.getFunctionParent();` check, skip if inside a function (those are handled by Code Path A).
2. For remaining module-level calls, add `parentScopeId: module.id` to the `constructorCalls.push({...})` call.

This change is ~5 LOC and follows the precedent of other module-level traversals that skip function-internal nodes (e.g., `traverse_updates` at line 1619).

---

## Verdict: REJECT

Return to Don with the following specific gaps:

1. **CRITICAL:** `traverse_new` in `JSASTAnalyzer.ts` (lines 1731-1799) is a second constructor-call collection path that the plan does not address. Module-level `new X()` calls will remain disconnected after the fix.

2. **TEST FAILURE:** The test case "Assigned at module level: `const x = new Foo()` (top of file)" asserts `MODULE CONTAINS CONSTRUCTOR_CALL`. This will fail because the module-level traversal does not capture a `parentScopeId`.

3. **REQUIRED ADDITION:** Plan needs Change 4 — add `getFunctionParent()` guard and `parentScopeId: module.id` to the `traverse_new` push block in `JSASTAnalyzer.ts`.
