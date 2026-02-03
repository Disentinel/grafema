# Rob Pike Implementation Report: REG-329

## Summary

Implemented scope chain resolution for variable lookups in object property values, following Joel's technical plan.

## Changes Made

### 1. `packages/core/src/plugins/analysis/ast/types.ts`
- Added `valueScopePath?: string[]` field to `ObjectPropertyInfo` interface
- This stores the scope context where the variable reference was found

### 2. `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
- Added `valueScopePath?: string[]` field to local `ObjectPropertyInfo` interface
- Modified `extractObjectProperties()` method to capture scope path when value is an Identifier:
  ```typescript
  propertyInfo.valueScopePath = this.scopeTracker?.getContext().scopePath ?? [];
  ```
- Same change applied to spread properties with identifier values

### 3. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
- Modified `bufferObjectPropertyEdges()` method signature to accept `variableDeclarations` and `parameters`
- Added scope-aware variable resolution for VARIABLE property values using existing `resolveVariableInScope()` infrastructure
- Fixed type check to include CONSTANT (not just VARIABLE) since `const` declarations have type 'CONSTANT'
- Updated call site to pass required collections

## Key Bug Fix

During testing, discovered that `resolveVariableInScope()` only checked for `parsed.type === 'VARIABLE'`, but `const` declarations create nodes with type 'CONSTANT'. Fixed by checking for both:

```typescript
if (parsed && (parsed.type === 'VARIABLE' || parsed.type === 'CONSTANT')) {
```

## Scope Limitation

The fix applies to **module-level call expressions only**. CallExpressionVisitor intentionally skips calls inside function bodies (line 1086-1088) because they're processed by `analyzeFunctionBody` through a different code path.

```typescript
// Skip if inside function - they will be processed by analyzeFunctionBody
if (callNode.callee.type === 'Identifier') {
  if (functionParent) {
    return;  // Skips processing
  }
```

This means the target use case (`res.json({ key: API_KEY })` at module level) is covered, but nested function calls need separate handling if required.

## Test File

Created `test/unit/ObjectPropertyScopeResolution.test.js` with tests for:
- Module-level CONSTANT resolution
- Module-level VARIABLE resolution
- Multiple properties with different variable references
- Shorthand property syntax
- Mixed literal and variable properties

Tests document the scope limitation in the file header.

## Files Changed

1. `packages/core/src/plugins/analysis/ast/types.ts`
2. `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
3. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
4. `test/unit/ObjectPropertyScopeResolution.test.js` (new)
