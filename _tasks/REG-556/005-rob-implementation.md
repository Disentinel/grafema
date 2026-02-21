# REG-556: Implementation Report

## Summary

Implemented five fixes to ensure CALL nodes created for direct function calls, module-level `new Foo()`, and function-body `new Foo()` all get `PASSES_ARGUMENT` edges via `ArgumentExtractor.extract()`. Also added support for `NewExpression` arguments (e.g., `foo(new Bar())`) and `MemberExpression` argument fallback resolution (e.g., `foo(b.c)`).

## Changes

### Fix 1: Direct function calls inside function bodies
**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Added `extractMethodCallArguments` call after `callSites.push(...)` in the `callee.type === 'Identifier'` branch of `handleCallExpression`. This mirrors the existing pattern used for the `MemberExpression` branch (line 3485-3488).

### Fix 2: Module-level `new Foo()` CALL nodes
**File:** `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

Added `ArgumentExtractor.extract` calls in `handleNewExpression` after both:
- `s.callSites.push(callInfo)` (Identifier callee branch)
- `s.methodCalls.push(methodCallInfo)` (MemberExpression callee branch)

Pattern follows `handleDirectCall` and `handleSimpleMethodCall` which already extract arguments.

### Fix 3: Function-body `new Foo()` CALL nodes
**File:** `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`

Added `ArgumentExtractor.extract` calls after both:
- `ctx.callSites.push({...})` (Identifier callee CALL node)
- `ctx.methodCalls.push({...})` (MemberExpression callee CALL node)

Note: The CONSTRUCTOR_CALL node already had argument extraction (line 61-66). This fix adds extraction for the companion CALL node.

### Fix 4: MemberExpression argument fallback in CallFlowBuilder
**File:** `packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts`

In `bufferArgumentEdges`, within the `EXPRESSION + MemberExpression` branch, added fallback resolution: when `this.method` resolution doesn't apply (non-`this` objects), resolve `objectName` to a VARIABLE node. This enables `foo(b.c)` to create a `PASSES_ARGUMENT` edge pointing to the VARIABLE node for `b`.

### Fix 5: NewExpression argument support
**File A:** `packages/core/src/plugins/analysis/ast/visitors/ArgumentExtractor.ts`

Added `NewExpression` branch before the `MemberExpression` branch: sets `targetType: 'CONSTRUCTOR_CALL'` with `nestedCallLine`/`nestedCallColumn` position data.

**File A':** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (`extractMethodCallArguments`)

Added `isNewExpression` branch before the `isMemberExpression` branch with same `CONSTRUCTOR_CALL` target type pattern.

**File B:** `packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts`

- Added `constructorCalls = []` to destructured data in `buffer()`
- Passed `constructorCalls` through to `bufferArgumentEdges`
- Added `constructorCalls: ConstructorCallInfo[]` parameter
- Added `CONSTRUCTOR_CALL` resolution by position (line/column lookup in `constructorCalls` array)

### Snapshot Updates

Updated 6 graph snapshot golden files to reflect the new PASSES_ARGUMENT and DERIVES_FROM edges:
- `03-complex-async`, `04-control-flow`, `nodejs-builtins`, `02-api-service`, `06-socketio`, `07-http-requests`

## Test Results

```
# tests 2289
# suites 987
# pass 2262
# fail 0
# cancelled 0
# skipped 5
# todo 22
```

All tests pass. Zero regressions. The 5 skipped and 22 todo are pre-existing.

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Fix 1 (direct call args) + Fix 5a' (NewExpression branch) |
| `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts` | Fix 2 (module-level new-expr args) |
| `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts` | Fix 3 (function-body new-expr args) |
| `packages/core/src/plugins/analysis/ast/visitors/ArgumentExtractor.ts` | Fix 5a (NewExpression branch) |
| `packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts` | Fix 4 (MemberExpr fallback) + Fix 5b (CONSTRUCTOR_CALL resolution) |
| `test/snapshots/*.snapshot.json` | Updated 6 golden files |
