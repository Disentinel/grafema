# REG-556: Link CALL node arguments via PASSES_ARGUMENT edges — Don Melton Plan

## Executive Summary

The issue is NOT "PASSES_ARGUMENT does not exist." The infrastructure is already there: `ArgumentExtractor`, `CallFlowBuilder.bufferArgumentEdges`, `callArguments` collection. The issue is **three specific gaps** where CALL nodes are created but `ArgumentExtractor.extract()` is never called:

1. **Direct function calls inside function bodies** — `handleCallExpression` in `JSASTAnalyzer` handles `callee.type === 'Identifier'` (e.g. `foo(a, b)` inside a function) but never calls `extractMethodCallArguments` for that branch.
2. **`new Foo(a, b)` CALL nodes at module level** — `CallExpressionVisitor.handleNewExpression` creates CALL nodes in `callSites` for `new Foo()` but never calls `ArgumentExtractor.extract`.
3. **`new Foo(a, b)` CALL nodes inside function bodies** — `NewExpressionHandler` creates CALL nodes in `ctx.callSites` (the `new Foo()` path, ~line 122) but only calls `ArgumentExtractor.extract` for the CONSTRUCTOR_CALL node, not for the CALL node counterpart.

Note: CONSTRUCTOR_CALL `ArgumentExtractor.extract` calls ARE already in place in both `JSASTAnalyzer` (line 2104) and `NewExpressionHandler` (line 61). Those will produce `callArguments` entries with `callId = constructorCallId`. However, `CallFlowBuilder.bufferArgumentEdges` does `callSites.find(c => c.id === callId) || methodCalls.find(...)` to look up the call — this lookup is used for the callback whitelist. CONSTRUCTOR_CALL ids won't be found there, but the `PASSES_ARGUMENT` edge creation at line 183–195 does NOT depend on this lookup succeeding; it only requires `targetNodeId` to be set. So CONSTRUCTOR_CALL argument edges DO get created already for argument types with known targetIds (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL). The only risk is the VARIABLE resolution and FUNCTION resolution paths (lines 87–115) may fail to resolve argument targets for constructor calls — but those are soft failures (no edge created, not a crash). This is a secondary concern.

The primary gap is gap #1 (direct function-body calls) and gaps #2–3 (new-expression CALL nodes).

---

## Files to Modify

### 1. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Why:** Contains `handleCallExpression`, which processes direct identifier calls (`foo(a, b)`) inside function bodies. The method-call branch (lines 3485–3488) already calls `this.extractMethodCallArguments(callNode, methodCallId, module, collections)`, but the direct-call branch (lines 3401–3435) does not.

**Where exactly:** After `callSites.push(...)` in the `callee.type === 'Identifier'` branch (after line 3434), add:

```typescript
// REG-556: Extract arguments for direct function calls
if (callNode.arguments.length > 0) {
  this.extractMethodCallArguments(callNode, callId, module, collections);
}
```

`extractMethodCallArguments` already exists (lines 3612–3697) and is already used for method calls. It handles all the argument types needed (VARIABLE, LITERAL, FUNCTION, CALL, MemberExpression, etc.).

### 2. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Why:** Contains `handleNewExpression`, which processes `new Foo()` and `new ns.Foo()` at module level. It creates CALL nodes in `s.callSites` / `s.methodCalls` but never calls `ArgumentExtractor.extract`. Compare this to `handleDirectCall` (line 336–342) and `handleSimpleMethodCall` (lines 467–484), which both call `ArgumentExtractor.extract` when `callNode.arguments.length > 0`.

**Where exactly — Identifier callee case:** After `s.callSites.push(callInfo)` at the end of the `newNode.callee.type === 'Identifier'` branch (after line 615), add:

```typescript
// REG-556: Extract arguments for PASSES_ARGUMENT edges
if (newNode.arguments.length > 0) {
  ArgumentExtractor.extract(
    newNode.arguments, callInfo.id, s.module,
    s.callArguments, s.literals, s.literalCounterRef,
    this.collections, s.scopeTracker
  );
}
```

**Where exactly — MemberExpression callee case:** After `s.methodCalls.push(methodCallInfo)` at the end of the `newNode.callee.type === 'MemberExpression'` branch (after line 662), add the same pattern using `methodCallInfo.id`.

### 3. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`

**Why:** Handles `new Foo()` inside function bodies. It creates two separate node entries:
- A CONSTRUCTOR_CALL node (`ctx.constructorCalls.push(...)` at line 45) — argument extraction is already done at line 61–66 for this.
- A CALL node (`ctx.callSites.push(...)` at line 122 for `Identifier` callee, and `ctx.methodCalls.push(...)` at line 160 for `MemberExpression` callee).

The CALL node does NOT get `ArgumentExtractor.extract` called.

**Where exactly — Identifier callee CALL node (line ~133):** After `ctx.callSites.push({...})` in the "Handle simple constructor: new Foo()" block, add:

```typescript
// REG-556: Extract arguments for PASSES_ARGUMENT edges on CALL node
if (newNode.arguments.length > 0) {
  if (!ctx.collections.callArguments) {
    ctx.collections.callArguments = [];
  }
  ArgumentExtractor.extract(
    newNode.arguments, newCallId, ctx.module,
    ctx.collections.callArguments as unknown as ArgumentInfo[],
    ctx.literals as unknown as ExtractorLiteralInfo[],
    ctx.literalCounterRef, ctx.collections, ctx.scopeTracker
  );
}
```

**Where exactly — MemberExpression callee CALL node (line ~173):** After `ctx.methodCalls.push({...})` in the `MemberExpression` branch, add the same using `newMethodCallId`.

---

## How Each Argument Type Is Handled

All argument types are already fully handled by the existing `ArgumentExtractor.extract` and `extractMethodCallArguments` methods. No new argument-type logic is needed. The types handled:

| Argument Type | Example | What happens |
|---|---|---|
| Identifier (variable) | `foo(a)` | `targetType: 'VARIABLE'`, `targetName: 'a'` → resolved to VARIABLE node in CallFlowBuilder |
| MemberExpression | `foo(b.c)` | `targetType: 'EXPRESSION'`, `expressionType: 'MemberExpression'`, `objectName`, `propertyName` set |
| NewExpression | `foo(new X())` | `targetType: 'CALL'` with `nestedCallLine`/`nestedCallColumn` → resolved by position |
| LogicalExpression | `foo(a && b)` | `targetType: 'EXPRESSION'`, creates EXPRESSION node → targeted by `targetId` |
| BinaryExpression | `foo(x + y)` | Same as LogicalExpression |
| Literal | `foo(42)` | `targetType: 'LITERAL'`, creates LITERAL node → targeted by `targetId` |
| ArrowFunction/FunctionExpression | `foo(() => {})` | `targetType: 'FUNCTION'` with line/column → resolved to FUNCTION node |
| SpreadElement | `foo(...args)` | Unwraps to underlying argument, sets `isSpread: true` |
| CallExpression | `foo(bar())` | `targetType: 'CALL'` → linked by position |
| ObjectExpression | `foo({x: 1})` | `targetType: 'OBJECT_LITERAL'`, creates OBJECT_LITERAL node |
| ArrayExpression | `foo([1,2])` | `targetType: 'ARRAY_LITERAL'`, creates ARRAY_LITERAL node |

---

## Edge Cases

### Calls with no arguments
`callNode.arguments.length > 0` guard is already the pattern everywhere. If no args, skip. No change needed.

### Rest/spread arguments (`...args`)
`ArgumentExtractor.extract` already handles `SpreadElement` at line 48–51: unwraps to `arg.argument` and sets `argInfo.isSpread = true`. Works correctly.

### Optional chaining calls (`foo?.()`)
Optional chaining call nodes have type `OptionalCallExpression` in older Babel, or the `CallExpression` with `optional: true` flag in newer Babel. The existing handlers process `CallExpression` nodes; optional calls are a separate concern not in scope for this task.

### Duplicate argument extraction for `new Foo()` CALL and CONSTRUCTOR_CALL
When `new Foo(a, b)` is processed, both a CALL node and a CONSTRUCTOR_CALL node are created. After this fix, `callArguments` will have entries for both node IDs. Each entry references only its own node's ID as `callId`. So both CALL → PASSES_ARGUMENT → arg AND CONSTRUCTOR_CALL → PASSES_ARGUMENT → arg edges will be created. This is correct — they are different nodes, both need their own edges.

### `CallFlowBuilder` lookup for constructor call IDs
`bufferArgumentEdges` does `callSites.find(c => c.id === callId) || methodCalls.find(c => c.id === callId)` to find the call node — this is used only for the callback whitelist check (CALLS edge for HOF). For CONSTRUCTOR_CALL ids, this lookup returns `undefined`, meaning the callback whitelist check is skipped. That is correct behavior — CONSTRUCTOR_CALL is not an HOF. The `PASSES_ARGUMENT` edge creation does not depend on this lookup.

### `extractMethodCallArguments` does not handle `NewExpression` arguments specifically
`NewExpression` as an argument (`foo(new Bar())`) falls through to the `t.isCallExpression` branch — but `NewExpression` is not a `CallExpression`. Currently it falls to the final `else` branch: `argInfo.targetType = 'EXPRESSION'`. This means the `PASSES_ARGUMENT` edge will point to nothing (no `targetId`, no `targetName` for a `CALL` type). This is a pre-existing limitation, not introduced by this change.

Actually, re-checking `ArgumentExtractor.extract`: it checks `actualArg.type === 'CallExpression'` — but `NewExpression` has `type === 'NewExpression'`, so it falls to the else/fallback. The result: `targetType: 'EXPRESSION'`, `expressionType: 'NewExpression'`. No edge will be created (no targetId). This is a pre-existing limitation, not in scope.

---

## Unit Test Location and Pattern

**File to create:** `/Users/vadimr/grafema-worker-1/test/unit/CallNodePassesArgument.test.js`

**Pattern:** Follow `ConstructorCallTracking.test.js` — uses `setupTest` helper with inline JS code written to a temp directory, then runs orchestrator and queries the graph backend.

**Test cases:**

```javascript
// Test 1: foo(a, b.c, new X()) at module level → 3 PASSES_ARGUMENT edges from CALL node 'foo'
// Test 2: Direct function call inside function body → PASSES_ARGUMENT edges
// Test 3: new Foo(a) CALL node → PASSES_ARGUMENT edge
// Test 4: new Foo(a) CONSTRUCTOR_CALL node → PASSES_ARGUMENT edge (already works, verify)
// Test 5: Method call with args (already works, regression guard)
// Test 6: logical expression arg: foo(a && b) → EXPRESSION node with PASSES_ARGUMENT
```

The required acceptance-criteria test (`foo(a, b.c, new X()) → 3 PASSES_ARGUMENT edges`) translates to:
- `a` → VARIABLE argument → PASSES_ARGUMENT → VARIABLE node for `a`
- `b.c` → MemberExpression → PASSES_ARGUMENT → EXPRESSION node (type MemberExpression) — note: no edge will be created unless targetNodeId is set, which for MemberExpression is NOT set (no EXPRESSION node is created, just info on argInfo). This is a pre-existing limitation.
- `new X()` → falls to else branch in `extractMethodCallArguments` → `targetType: 'EXPRESSION'` — again no edge.

Wait — this needs re-examination. Let me re-read the acceptance criteria: "Works for: identifier args, property access args, new expressions, logical expressions."

For `b.c` (MemberExpression): `ArgumentExtractor.extract` sets `targetType: 'EXPRESSION'` with `expressionType: 'MemberExpression'` but NO `targetId`. In `CallFlowBuilder.bufferArgumentEdges`, the `EXPRESSION` + `MemberExpression` branch (line 117–144) tries to find a method node for `this.method` patterns. For non-`this` member expressions, `targetNodeId` remains `undefined`, so no edge is created.

This means the acceptance criteria as literally stated (property access args, new expression args) require NEW handling in `CallFlowBuilder.bufferArgumentEdges` OR in `ArgumentExtractor.extract`. Currently neither creates a target node for plain `b.c` or `new X()` arguments.

**Architectural insight:** To support `b.c` as a PASSES_ARGUMENT target, we'd need to either:
- Create an EXPRESSION node for the member expression (similar to how BinaryExpression/LogicalExpression creates nodes)
- Or resolve `b` to a VARIABLE node and create the edge to that

For `new X()` as argument, the CONSTRUCTOR_CALL node for `X` is already created separately. We could resolve it by position (line/column lookup in constructorCalls, similar to the `CALL` argument resolution by `nestedCallLine`/`nestedCallColumn`).

**Revised plan for the three problematic argument types:**

### Property access args (`b.c`):
The task says these should work. Currently `ArgumentExtractor.extract` sets `targetType: 'EXPRESSION'` for MemberExpression without creating a node or setting `targetId`. For `CallFlowBuilder` to create a PASSES_ARGUMENT edge, either:
1. Create an EXPRESSION node for the MemberExpression argument (like BinaryExpression does)
2. Or resolve `b` to a VARIABLE node (available in `variableDeclarations`) and use that as the edge target

Option 2 is simpler and more useful for data flow: `CALL --PASSES_ARGUMENT--> VARIABLE(b)`. This already happens via the `objectName` field in the argInfo when `targetType === 'EXPRESSION' && expressionType === 'MemberExpression'`.

Looking at `CallFlowBuilder.bufferArgumentEdges` lines 116–144: the existing MemberExpression handler ONLY resolves `this.property` (for `this.method` callbacks). It does NOT resolve `b.c` to the VARIABLE `b`.

**Fix:** In `CallFlowBuilder.bufferArgumentEdges`, add a fallback for `targetType === 'EXPRESSION' && expressionType === 'MemberExpression'` that resolves `objectName` to a VARIABLE node (similar to the VARIABLE branch).

### New expression args (`new X()`):
`extractMethodCallArguments` / `ArgumentExtractor.extract` falls to else → `targetType: 'EXPRESSION'`, no targetId. The CONSTRUCTOR_CALL node for X already exists and has an ID computable by position.

**Fix:** In `extractMethodCallArguments` (JSASTAnalyzer) and `ArgumentExtractor.extract`, add a branch for `NewExpression` arguments: set `targetType: 'CALL'` and set `nestedCallLine`/`nestedCallColumn` to the NewExpression's position. Then in `CallFlowBuilder.bufferArgumentEdges`, the existing CALL-type resolution by position will find the corresponding CONSTRUCTOR_CALL node OR CALL node at those coordinates.

Actually — looking more carefully: the CALL-type resolution in `CallFlowBuilder` (line 154–163) looks in `callSites` and `methodCalls`. It does NOT look in `constructorCalls`. But a `new X()` creates a CONSTRUCTOR_CALL node at those coordinates. So even with `targetType: 'CALL'` and position set, the lookup will fail.

**Simplest correct fix:** In `CallFlowBuilder.bufferArgumentEdges`, when `targetType === 'CALL'` and the position lookup in callSites/methodCalls fails, also search `constructorCalls` by position.

BUT: `constructorCalls` is not currently passed to `bufferArgumentEdges`. It's available in `data` (ASTCollections) but not destructured in `CallFlowBuilder.buffer`. Need to pass it through.

### Logical expression args (already works):
`ArgumentExtractor.extract` creates an EXPRESSION node via `NodeFactory.createArgumentExpression` and sets `targetId`. `CallFlowBuilder` finds the `targetId` set → creates edge. **Already works.**

---

## Revised Concrete Implementation Plan

### Fix 1: Direct function calls inside function bodies
**File:** `JSASTAnalyzer.ts`, line ~3434
**Change:** After `callSites.push(...)` in the `callee.type === 'Identifier'` branch, add:
```typescript
// REG-556: Extract arguments for direct function calls
if (callNode.arguments.length > 0) {
  this.extractMethodCallArguments(callNode, callId, module, collections);
}
```

### Fix 2: New expression CALL nodes at module level
**File:** `CallExpressionVisitor.ts`, `handleNewExpression` method
**Change:** After each `s.callSites.push(callInfo)` and `s.methodCalls.push(methodCallInfo)`, add `ArgumentExtractor.extract` calls.

### Fix 3: New expression CALL nodes inside function bodies
**File:** `NewExpressionHandler.ts`
**Change:** After `ctx.callSites.push({...})` (line ~133) and `ctx.methodCalls.push({...})` (line ~173), add `ArgumentExtractor.extract` calls.

### Fix 4: Property access args (`b.c`)
**File:** `CallFlowBuilder.ts`, `bufferArgumentEdges`
**Change:** In the `EXPRESSION + MemberExpression` branch, after the `this.method` resolution, add fallback to resolve `objectName` to a VARIABLE node:
```typescript
// Fallback: resolve objectName to a VARIABLE node
if (!targetNodeId && objectName && objectName !== 'this' && objectName !== 'this') {
  const varNode = variableDeclarations.find(v => v.name === objectName && v.file === file);
  if (varNode) {
    targetNodeId = varNode.id;
  }
}
```

### Fix 5: New expression args (`new X()`)
**Part A — `extractMethodCallArguments` in JSASTAnalyzer.ts (~line 3690):** Add a branch before the final `else`:
```typescript
} else if (t.isNewExpression(arg)) {
  argInfo.targetType = 'CONSTRUCTOR_CALL';
  argInfo.nestedCallLine = getLine(arg);
  argInfo.nestedCallColumn = getColumn(arg);
}
```

**Part A' — `ArgumentExtractor.extract` (~line 191):** Add a branch for `NewExpression`:
```typescript
else if (actualArg.type === 'NewExpression') {
  argInfo.targetType = 'CONSTRUCTOR_CALL';
  argInfo.nestedCallLine = actualArg.loc?.start.line;
  argInfo.nestedCallColumn = actualArg.loc?.start.column;
}
```

**Part B — `CallFlowBuilder.ts`, `buffer` and `bufferArgumentEdges`:**
1. Destructure `constructorCalls = []` from data in `buffer()`
2. Pass `constructorCalls` to `bufferArgumentEdges`
3. In `bufferArgumentEdges`, add handling for `targetType === 'CONSTRUCTOR_CALL'`:
```typescript
else if (targetType === 'CONSTRUCTOR_CALL' && nestedCallLine && nestedCallColumn) {
  const constructorCall = constructorCalls.find(c =>
    c.file === file && c.line === nestedCallLine && c.column === nestedCallColumn
  );
  if (constructorCall) {
    targetNodeId = constructorCall.id;
  }
}
```

Note: `CallArgumentInfo` interface (in `ast/types.ts`) may need a `'CONSTRUCTOR_CALL'` string added to `targetType` (currently untyped as `string?`, so no change needed there).

---

## Type Changes Needed

- `ArgumentInfo` in `call-expression-types.ts`: `targetType` is `string?` — no change needed.
- `CallArgumentInfo` in `ast/types.ts`: `targetType` is also likely `string?` — verify and confirm no change needed.
- `CallFlowBuilder.bufferArgumentEdges` signature: add `constructorCalls: ConstructorCallInfo[]` parameter.
- `ConstructorCallInfo` type: check if it's exported from `ast/types.ts` — it is (line 1171 references it).

---

## Where to Write the Unit Test

**File:** `/Users/vadimr/grafema-worker-1/test/unit/CallNodePassesArgument.test.js`

**Pattern to follow:** `ConstructorCallTracking.test.js` — inline code → temp dir → orchestrator.run → graph queries.

**Core test (acceptance criteria):**
```javascript
it('should create 3 PASSES_ARGUMENT edges for foo(a, b.c, new X())', async () => {
  await setupTest(backend, {
    'index.js': `
      const a = 1;
      const b = { c: 2 };
      function foo(x, y, z) {}
      foo(a, b.c, new Error('msg'));
    `
  });

  const calls = await backend.getAllNodes({ type: 'CALL' });
  const fooCall = calls.find(c => c.name === 'foo');
  assert.ok(fooCall, 'Should have foo CALL node');

  const edges = await backend.getOutgoingEdges(fooCall.id, ['PASSES_ARGUMENT']);
  assert.strictEqual(edges.length, 3, 'foo(a, b.c, new X()) should have 3 PASSES_ARGUMENT edges');
});
```

**Additional tests:**
1. Direct function call inside function body gets PASSES_ARGUMENT edges
2. Method call (regression — already works)
3. CONSTRUCTOR_CALL node gets PASSES_ARGUMENT edges (already works via NewExpressionHandler, regression guard)
4. Module-level `new Foo(arg)` CALL node gets PASSES_ARGUMENT edge
5. Logical expression arg gets PASSES_ARGUMENT edge (already works, regression guard)

---

## Summary of Changes

| File | Change | Reason |
|---|---|---|
| `JSASTAnalyzer.ts` | Add `extractMethodCallArguments` call in direct-call branch | Gap #1: identifier calls in function bodies |
| `CallExpressionVisitor.ts` | Add `ArgumentExtractor.extract` calls in `handleNewExpression` | Gap #2: new-expr CALL nodes at module level |
| `NewExpressionHandler.ts` | Add `ArgumentExtractor.extract` calls after CALL node pushes | Gap #3: new-expr CALL nodes in function bodies |
| `ArgumentExtractor.ts` | Add `NewExpression` branch → `targetType: 'CONSTRUCTOR_CALL'` | Support new-expr as argument |
| `JSASTAnalyzer.ts` `extractMethodCallArguments` | Add `isNewExpression` branch | Support new-expr as argument (function-body path) |
| `CallFlowBuilder.ts` | Accept `constructorCalls`, resolve `CONSTRUCTOR_CALL` by position | Resolve new-expr argument targets |
| `CallFlowBuilder.ts` | Resolve `objectName` → VARIABLE for MemberExpression args | Support property access args |
| `test/unit/CallNodePassesArgument.test.js` | New test file | Acceptance criteria + regression |
