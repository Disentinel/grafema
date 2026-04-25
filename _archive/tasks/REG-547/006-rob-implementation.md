# REG-547: Rob Implementation Report

## Summary

Removed the legacy CALL(isNew) code path from NewExpression handling. All changes are deletions -- no new logic added.

## Files Changed

### 1. `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`
- **Deleted lines 105-171**: Two CALL(isNew) blocks:
  - "Handle simple constructor: new Foo()" block that pushed to `ctx.callSites` with `isNew: true`
  - "Handle namespaced constructor: new ns.Constructor()" block that pushed to `ctx.methodCalls` with `isNew: true`
- **Removed unused import**: `computeSemanticId` from `SemanticId.js` (only used by deleted code)
- **Kept intact**: CONSTRUCTOR_CALL creation logic (lines 34-103)

### 2. `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
- **Deleted line 202**: `NewExpression` handler registration (`NewExpression: (path) => this.handleNewExpression(path, s)`)
- **Deleted entire `handleNewExpression()` method** (was lines 471-567): ~96 lines of CALL(isNew) creation for module-level new expressions
- **Removed unused import**: `NewExpression` type from `@babel/types`
- **Simplified**: `extractFirstLiteralArg` signature from `CallExpression | NewExpression` to `CallExpression`
- **Updated JSDoc**: Removed "Constructor calls" from the handled list

### 3. `packages/core/src/plugins/analysis/ast/visitors/call-expression-types.ts`
- **Removed** `isNew?: boolean` from `CallSiteInfo` interface (was line 112)
- **Removed** `isNew?: boolean` from `MethodCallInfo` interface (was line 132)

### 4. `packages/core/src/plugins/analysis/ast/types.ts`
- **Removed** `isNew?: boolean` from `CallSiteInfo` interface (was line 302)
- **Removed** `isNew?: boolean` from `MethodCallInfo` interface (was line 328)

### 5. Snapshot files (auto-regenerated)
- Updated by `UPDATE_SNAPSHOTS=true` to reflect reduced CALL node counts (no more duplicate CALL(isNew) nodes alongside CONSTRUCTOR_CALL nodes)

## Build Result

`pnpm build` -- clean success, zero TypeScript errors.

## Test Results

| Test File | Tests | Pass | Fail |
|-----------|-------|------|------|
| ConstructorCallTracking.test.js | 30 | 30 | 0 |
| CallExpressionVisitorSemanticIds.test.js | 24 | 24 | 0 |
| GraphSnapshot.test.js | 6 | 6 | 0 |
| **Total** | **60** | **60** | **0** |

## Verification

```
grep -r '\bisNew\b' packages/core/src/ --include="*.ts"
```
Result: **zero matches**. No `isNew` references remain in production source code.

Test files still reference `isNew` in assertions that verify the field does NOT exist on CALL nodes -- these are the REG-547 regression tests confirming the fix works.

## Issues Encountered

None. All changes were pure deletions as planned.
