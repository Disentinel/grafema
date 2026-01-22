# Rob Pike - Phase 1 Implementation Report

**Task:** REG-116 - Extract indexed array assignment detection into a reusable helper method
**Phase:** 1 - Helper Extraction
**Date:** 2025-01-22

---

## Summary

Phase 1 is complete. Extracted the duplicated indexed array assignment detection logic into a private helper method `detectIndexedArrayAssignment`.

---

## Changes Made

### File: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

#### 1. Added new helper method (after line 1809, at end of class)

```typescript
/**
 * Detect indexed array assignment: arr[i] = value
 * Creates ArrayMutationInfo for FLOWS_INTO edge generation in GraphBuilder
 *
 * @param assignNode - The assignment expression node
 * @param module - Current module being analyzed
 * @param arrayMutations - Collection to push mutation info into
 */
private detectIndexedArrayAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[]
): void {
  // Check for indexed array assignment: arr[i] = value
  if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
    const memberExpr = assignNode.left;

    // Get array name (only simple identifiers for now)
    if (memberExpr.object.type === 'Identifier') {
      const arrayName = memberExpr.object.name;
      const value = assignNode.right;

      const argInfo: ArrayMutationArgument = {
        argIndex: 0,
        isSpread: false,
        valueType: 'EXPRESSION'
      };

      // Determine value type
      const literalValue = ExpressionEvaluator.extractLiteralValue(value);
      if (literalValue !== null) {
        argInfo.valueType = 'LITERAL';
        argInfo.literalValue = literalValue;
      } else if (value.type === 'Identifier') {
        argInfo.valueType = 'VARIABLE';
        argInfo.valueName = value.name;
      } else if (value.type === 'ObjectExpression') {
        argInfo.valueType = 'OBJECT_LITERAL';
      } else if (value.type === 'ArrayExpression') {
        argInfo.valueType = 'ARRAY_LITERAL';
      } else if (value.type === 'CallExpression') {
        argInfo.valueType = 'CALL';
        argInfo.callLine = value.loc?.start.line;
        argInfo.callColumn = value.loc?.start.column;
      }

      // Use defensive loc checks instead of ! assertions
      const line = assignNode.loc?.start.line ?? 0;
      const column = assignNode.loc?.start.column ?? 0;

      arrayMutations.push({
        arrayName,
        mutationMethod: 'indexed',
        file: module.file,
        line: line,
        column: column,
        arguments: [argInfo]
      });
    }
  }
}
```

#### 2. Replaced first occurrence (module-level, ~line 910)

**Before:** ~42 lines of duplicated detection logic
**After:**
```typescript
// Check for indexed array assignment at module level: arr[i] = value
this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);
```

#### 3. Replaced second occurrence (function-level, inside `analyzeFunctionBody`)

**Before:** ~52 lines including collection initialization + detection logic
**After:**
```typescript
// Detect indexed array assignments: arr[i] = value
AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
  const assignNode = assignPath.node;

  // Initialize collection if not exists
  if (!collections.arrayMutations) {
    collections.arrayMutations = [];
  }
  const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

  // Check for indexed array assignment: arr[i] = value
  this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);
},
```

---

## Key Decisions

### 1. Defensive `loc` checks
Changed from:
```typescript
line: assignNode.loc!.start.line,
column: assignNode.loc!.start.column,
```
To:
```typescript
const line = assignNode.loc?.start.line ?? 0;
const column = assignNode.loc?.start.column ?? 0;
```

This prevents potential runtime errors if Babel returns nodes without location info.

### 2. Kept `arguments` property name
Per spec, the property remains named `arguments`. Phase 2 will rename it to `insertedValues`.

### 3. Collection initialization stays with caller
The helper method expects `arrayMutations` array to exist. Collection initialization (`if (!collections.arrayMutations)`) remains in the caller (function-level context) because:
- Module-level already has `arrayMutations` initialized
- Function-level needs to check/initialize from collections object

---

## Verification

### Build
```bash
npm run build
# Result: SUCCESS - All packages built without errors
```

### Tests
```bash
npm test
# Result: 228 pass, 36 fail, 1 skipped
```

**Analysis of failures:**
- All 36 failures are **pre-existing** - they expect `FLOWS_INTO` edges which are not yet implemented in GraphBuilder
- These tests were written by Kent to lock **desired future behavior**
- Core analysis tests pass (DataFlowTracking, ParameterDataFlow, Expression, EvalBanValidator, etc.)

**Specific test results:**
- `DataFlowTracking.test.js`: 9/9 pass
- `EvalBanValidator.test.js`: 2/2 pass
- `Expression.test.js`: 12/12 pass (one skipped)
- `ParameterDataFlow.test.js`: 9/9 pass
- `AliasTracker.test.js`: 6/6 pass

---

## Lines Changed

| Location | Before | After | Reduction |
|----------|--------|-------|-----------|
| Module-level (~910-952) | 42 lines | 2 lines | -40 lines |
| Function-level (~1280-1332) | 52 lines | 12 lines | -40 lines |
| New helper method | 0 lines | 59 lines | +59 lines |
| **Net reduction** | **94 lines** | **73 lines** | **-21 lines** |

Zero duplication remains for indexed assignment detection logic.

---

## Next Steps (Phase 2)

1. Rename `arguments` property to `insertedValues` in:
   - `ArrayMutationInfo` interface in `types.ts`
   - The new `detectIndexedArrayAssignment` helper
   - `CallExpressionVisitor.detectArrayMutation`

2. Add explicit `: void` return type to `CallExpressionVisitor.detectArrayMutation`

3. Add defensive `loc` checks to `CallExpressionVisitor.detectArrayMutation`

---

## Conclusion

Phase 1 complete. The extraction preserves behavioral identity - all core tests pass, only tests expecting not-yet-implemented FLOWS_INTO edges fail (as expected). Ready for Phase 2 review.

---

**Rob Pike**
Implementation Engineer
2025-01-22
