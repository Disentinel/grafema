# Dijkstra Plan Verification: REG-556

**Verdict:** REJECT — three defects require fixing before implementation.

**Completeness tables:** 5 built

**Gaps found:**
- [Critical] `NewExpressionHandler.ts` Identifier branch `callSites.push` omits `column` field; Fix 5B's position lookup will fail
- [Significant] `ArgumentExtractor.extract` signature is `ArgumentInfo[]`, not `CallArgumentInfo[]`; Fix 3 casts through `unknown` and the existing code already does this, but the mechanism is fragile and undocumented
- [Significant] `CallFlowBuilder.bufferArgumentEdges` is never passed `constructorCalls`; Fix 5B requires adding it to the signature — but the current `buffer()` method does not destructure `constructorCalls` from `ASTCollections`. Plan identifies this but does not say which callers of `bufferArgumentEdges` must also be updated.

**Precondition issues:**
- [Critical] For Fix 5 (new-expression args): the CONSTRUCTOR_CALL node exists at the position *of the `new` keyword*. The CALL node (`ctx.callSites.push`) in the Identifier branch of `NewExpressionHandler.ts` (line 122) is missing `column` — `getColumn(newNode)` is computed (line 41) inside the `constructorKey` block but is not carried into the `callSites.push` struct. Fix 3 proposes to use `ArgumentExtractor.extract(... newCallId ...)` and Fix 5B would look up the *nested* CONSTRUCTOR_CALL node by `nestedCallLine`/`nestedCallColumn` from inside a parent call's argInfo. These are different CALL nodes and different lookup paths. The plan is internally consistent here, but relies on a lookup that cannot succeed when the `callSites` entry is missing its `column`.
- For Fix 4 (MemberExpression `b.c` fallback): the plan's code fragment has a duplicated condition (`objectName !== 'this' && objectName !== 'this'`). This is a typo — harmless but indicates the code was not reviewed.
- For Fix 1 (direct calls in function bodies): `callId` is computed at line 3415 via `computeSemanticId`; it is in scope at the proposed insertion point (after line 3434). No precondition issue here.

---

## Detailed Enumeration

### Table 1 — Call Expression Sites and Argument Extraction Coverage

| Call Kind | Location | Node pushed | `ArgumentExtractor.extract` called? | After fix |
|---|---|---|---|---|
| `foo(a, b)` at module level | `CallExpressionVisitor.handleDirectCall` | `callSites` | YES (line 336–342) | No change needed |
| `obj.method(a)` at module level | `CallExpressionVisitor.handleSimpleMethodCall` | `methodCalls` | YES (line 467–473) | No change needed |
| `foo(a, b)` inside function body | `JSASTAnalyzer.handleCallExpression` Identifier branch | `callSites` | NO | Fix 1 adds it |
| `obj.method(a)` inside function body | `JSASTAnalyzer.handleCallExpression` MemberExpression branch | `methodCalls` | YES (line 3486–3488) | No change needed |
| `new Foo(a)` at module level — Identifier callee | `CallExpressionVisitor.handleNewExpression` Identifier branch | `callSites` | NO | Fix 2 adds it |
| `new ns.Foo(a)` at module level — MemberExpression callee | `CallExpressionVisitor.handleNewExpression` MemberExpression branch | `methodCalls` | NO | Fix 2 adds it |
| `new Foo(a)` inside function body — Identifier callee | `NewExpressionHandler` Identifier branch (line 122) | `ctx.callSites` | NO | Fix 3 adds it |
| `new ns.Foo(a)` inside function body — MemberExpression callee | `NewExpressionHandler` MemberExpression branch (line 160) | `ctx.methodCalls` | NO | Fix 3 adds it |
| `new Foo(a)` (CONSTRUCTOR_CALL) anywhere | `NewExpressionHandler` constructor block (line 45) | `ctx.constructorCalls` | YES (line 61–66) | No change needed |
| `new Foo(a)` (CONSTRUCTOR_CALL) at module level | `JSASTAnalyzer` (line 2104) | `constructorCalls` | YES | No change needed |

**Finding:** All 3 gaps correctly identified. No missed gaps in this table.

---

### Table 2 — Argument Type Handling in `ArgumentExtractor.extract`

| Argument AST type | Branch in `extract` | `targetType` set | `targetId` set | Edge created? |
|---|---|---|---|---|
| `ObjectExpression` | lines 54–99 | `OBJECT_LITERAL` | YES (new node) | Yes |
| `ArrayExpression` | lines 101–158 | `ARRAY_LITERAL` | YES (new node) | Yes |
| Primitive Literal | lines 160–178 | `LITERAL` | YES (new LITERAL node) | Yes |
| `Identifier` | lines 180–183 | `VARIABLE` | NO (resolved by name in `CallFlowBuilder`) | Yes if var found |
| `ArrowFunctionExpression` / `FunctionExpression` | lines 185–189 | `FUNCTION` | NO (resolved by position) | Yes if func found |
| `CallExpression` | lines 191–196 | `CALL` | NO (resolved by position in callSites/methodCalls) | Yes if call found |
| `MemberExpression` | lines 198–208 | `EXPRESSION` | NO | No edge currently |
| `BinaryExpression` / `LogicalExpression` | lines 210–249 | `EXPRESSION` | YES (new EXPRESSION node) | Yes |
| `SpreadElement` | lines 47–51 | (unwrapped to inner) | — | Depends on inner |
| `NewExpression` | falls to final `else` (lines 251–254) | `EXPRESSION` | NO | No edge |
| All other types | final `else` (lines 251–254) | `EXPRESSION` | NO | No edge |

**Finding:** The plan correctly identifies that `NewExpression` and `MemberExpression` have no edge. The plan proposes fixes for both. The proposed `NewExpression` fix (add `NewExpression` branch → `targetType: 'CONSTRUCTOR_CALL'`) is correct in `ArgumentExtractor.extract`. The `MemberExpression` fallback fix is in `CallFlowBuilder`, not in `ArgumentExtractor` — also correct.

---

### Table 3 — `CallFlowBuilder.bufferArgumentEdges` Target Resolution

| `targetType` | Resolution method | Precondition | Fail mode |
|---|---|---|---|
| `VARIABLE` | `variableDeclarations.find(v => v.name === targetName && v.file === file)` | Variable must be in same file | Soft fail: no edge |
| `EXPRESSION` + `MemberExpression` + `this.method` | `functions.find(...)` by className + propertyName | Class + method must exist in same file | Soft fail: no edge |
| `EXPRESSION` + `MemberExpression` + other | **No resolution** (existing gap, Fix 4 adds it) | — | No edge |
| `FUNCTION` | `functions.find(f => f.file === file && f.line === functionLine && f.column === functionColumn)` | Position must be exact | Soft fail: no edge |
| `CALL` | `callSites.find` or `methodCalls.find` by file + line + column | Call node must have `column` set | Soft fail: no edge |
| `CONSTRUCTOR_CALL` (proposed new) | `constructorCalls.find(c => c.file === file && c.line === nestedCallLine && c.column === nestedCallColumn)` | `constructorCalls` must be passed in; node must have matching position | Soft fail: no edge |
| `LITERAL` / `OBJECT_LITERAL` / `ARRAY_LITERAL` | `targetId` already set | `targetId` must be non-null | Soft fail: no edge |

**Critical finding for Fix 5B:** `CallFlowBuilder.buffer()` currently does NOT destructure `constructorCalls` from `data`. The plan acknowledges this and says to add it. `ASTCollections.constructorCalls` is `ConstructorCallInfo[] | undefined` (optional). The plan is correct that it must be added. The current `bufferArgumentEdges` signature has 6 parameters; adding a 7th requires updating the single call site at line 54. The plan describes this correctly. No additional callers of `bufferArgumentEdges` exist (it is private). Safe.

---

### Table 4 — `NewExpressionHandler.ts` Identifier Branch: `column` Field

This is the most critical defect in the plan.

**Source code at lines 122–133:**
```typescript
ctx.callSites.push({
  id: newCallId,
  type: 'CALL',
  name: constructorName,
  file: ctx.module.file,
  line: getLine(newNode),    // ← line is set
  // MISSING: column         // ← column is NOT set
  endLine: getEndLocation(newNode).line,
  endColumn: getEndLocation(newNode).column,
  parentScopeId: ctx.getCurrentScopeId(),
  targetFunctionName: constructorName,
  isNew: true
});
```

`getColumn(newNode)` is computed at line 41 (`const column = getColumn(newNode);`) but this is inside the `constructorKey` block (lines 37–102) and scoped there only — the `column` const is not in scope at line 122. Compare with `CallExpressionVisitor.handleNewExpression` (line 580–615) which also omits `column` from its `callInfo` push.

**Consequence:** When Fix 3 calls `ArgumentExtractor.extract(newNode.arguments, newCallId, ...)`, any nested-call argument in those arguments will set `nestedCallLine`/`nestedCallColumn` on the argInfo. `CallFlowBuilder.bufferArgumentEdges` then attempts to find the call by `(file, line, column)`. Since `column` is absent from the CALL node, the lookup `callSites.find(c => c.file === file && c.line === nestedCallLine && c.column === nestedCallColumn)` may spuriously match or fail.

**However:** Fix 3 is about extracting arguments of a `new Foo(a, b)` call — not about `new Foo(a, b)` being used *as* an argument. Fix 5 handles the second case. The `column` omission is a pre-existing bug in `NewExpressionHandler.ts` (not introduced by this plan), but Fix 5B's CONSTRUCTOR_CALL lookup requires `ConstructorCallInfo.column` to be set — and it is, at line 41/column stored on the constructorCalls push (line 50). So Fix 5B will work for finding the CONSTRUCTOR_CALL node. The missing `column` on the CALL node in `ctx.callSites` is a separate pre-existing issue.

**Revised assessment:** The `column` omission on `ctx.callSites.push` is pre-existing. However, Rob must be made aware of it so as not to assume position-based lookup of these CALL nodes works. For the purpose of this plan's fixes, it does not break Fix 3 directly (Fix 3 adds argument extraction, not position-based lookup of the new Foo() node itself).

---

### Table 5 — `s.callArguments` vs `ArgumentExtractor.extract` Type Shape

`CallExpressionVisitor` initializes `s.callArguments` as `(this.collections.callArguments ?? []) as ArgumentInfo[]` (line 177). `ArgumentExtractor.extract` takes `ArgumentInfo[]`. These are from the same interface (`call-expression-types.ts`). Compatible.

`NewExpressionHandler.ts` accesses `ctx.collections.callArguments` which is `CallArgumentInfo[]` (from `ASTVisitor.ts` line 65, which imports from `ast/types.ts`). Don's Fix 3 casts with `as unknown as ArgumentInfo[]`. This cast is already the pattern used at line 63 for CONSTRUCTOR_CALL extraction — same file, same handler. The cast is unsafe but pre-existing and accepted in the codebase. `CallArgumentInfo` and `ArgumentInfo` are structurally compatible (same fields, `CallArgumentInfo.file` is `string?` vs `ArgumentInfo.file` is `string` — populated the same way). Not a new risk.

**Finding:** The dual-type issue is pre-existing and the plan correctly uses the `as unknown as` cast pattern already established at line 63. No new risk introduced.

---

## Specific Issues for Rob

### Issue 1 (Critical, must fix): Fix 5B — `bufferArgumentEdges` signature change

The plan proposes adding `constructorCalls: ConstructorCallInfo[]` to `bufferArgumentEdges`. The plan correctly notes that `buffer()` must destructure `constructorCalls = []` from `data`. The implementation must:
1. Add `constructorCalls = []` to the destructuring in `buffer()` (line 43–52)
2. Pass it to `bufferArgumentEdges` (line 54)
3. Add `constructorCalls: ConstructorCallInfo[]` as 7th parameter to `bufferArgumentEdges`
4. Add the new `CONSTRUCTOR_CALL` branch inside `bufferArgumentEdges`

This is safe — `bufferArgumentEdges` is a private method with one call site. No other callers.

### Issue 2 (Low, typo): Fix 4 code fragment

The proposed fallback code in Fix 4:
```typescript
if (!targetNodeId && objectName && objectName !== 'this' && objectName !== 'this') {
```
Has `objectName !== 'this'` duplicated. Should be `objectName !== 'this'` once, or also exclude `undefined`/empty checks already done. Cosmetic but must be corrected.

### Issue 3 (Informational): `extractMethodCallArguments` does not handle `NewExpression` as argument

The plan acknowledges this and adds a `isNewExpression` branch (Fix 5 Part A). The existing `else if (t.isCallExpression(arg))` branch at line 3669 does NOT match `NewExpression` because `t.isCallExpression` checks for type `'CallExpression'` only. The new branch must be inserted before the final `else` at line 3690. The plan places it correctly.

### Issue 4 (Confirmed safe): `callId` is in scope for Fix 1

At line 3415, `callId = computeSemanticId(...)` or `callId = legacyId`. The `callSites.push` uses `callId` inside the `id` field. The proposed insertion point (after the closing `}` of `callSites.push({...})`) is after line 3434. `callId` is declared at line 3412 in the same block scope. In scope. Confirmed.

### Issue 5 (Confirmed safe): `s.module` and `s.callArguments` for Fix 2

`CallExpressionVisitor.handleNewExpression` receives `s: HandlerState`. `s.module` (line 37), `s.callArguments` (line 42), `s.literals` (line 41), `s.literalCounterRef` (line 43), `this.collections` and `s.scopeTracker` (line 46) are all present. `callInfo.id` is set before `s.callSites.push(callInfo)` at line 615. `callInfo.id` will be the correct ID at that point. Fix 2 uses `callInfo.id` — correct.

For the MemberExpression branch: `methodCallInfo.id` is set before `s.methodCalls.push(methodCallInfo)` at line 662. Fix 2 uses `methodCallInfo.id` — correct.

### Issue 6 (Confirmed safe): `ctx.collections.callArguments` for Fix 3

Pattern already established at lines 58–66 of `NewExpressionHandler.ts` for CONSTRUCTOR_CALL. The proposed Fix 3 code is structurally identical. `newCallId` is declared at line 116 and in scope at the insertion point (after line 133). `newMethodCallId` is declared at line 154 and in scope after line 173. Both confirmed in scope.

---

## Verdict Summary

The plan is **substantially correct** — it correctly identifies all three gaps, correctly locates all insertion points, and correctly describes the infrastructure needed. Two issues require correction before implementation:

1. **Fix 4 code has a duplicated condition** — must correct `objectName !== 'this' && objectName !== 'this'` to a single check.
2. **Fix 5B signature change** — the plan text is accurate but Rob must implement all four steps atomically (destructure, pass, signature, branch). The plan describes them in scattered sections; Rob should implement as one cohesive change to `CallFlowBuilder.ts`.

One informational note: the missing `column` on `NewExpressionHandler`'s `ctx.callSites.push` (Identifier branch) is a **pre-existing bug** in the codebase, not introduced by this plan. It does not block these fixes but should be filed as a separate issue.

The plan is **approved with corrections** — Rob must fix the typo in Fix 4 and implement Fix 5B atomically.
