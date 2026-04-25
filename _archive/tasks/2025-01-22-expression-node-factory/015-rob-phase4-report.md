# Phase 4: GraphBuilder EXPRESSION Node Migration - Implementation Report

**Date:** 2025-01-22
**Author:** Rob Pike (Implementation Engineer)
**Task:** REG-107 Part 2.3 - GraphBuilder Migration

---

## Summary

Successfully migrated GraphBuilder EXPRESSION node creation from inline object construction to `NodeFactory.createExpressionFromMetadata()`.

---

## Changes Made

### 1. GraphBuilder.ts

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Change:** Replaced inline EXPRESSION node construction (lines 830-855) with factory method call.

**Before:**
```typescript
// EXPRESSION node creation
else if (sourceType === 'EXPRESSION' && sourceId) {
  const {
    expressionType,
    object,
    property,
    computed,
    computedPropertyVar,
    operator,
    objectSourceName,
    leftSourceName,
    rightSourceName,
    consequentSourceName,
    alternateSourceName,
    file: exprFile,
    line: exprLine
  } = assignment;

  const expressionNode: GraphNode = {
    id: sourceId,
    type: 'EXPRESSION',
    expressionType,
    file: exprFile,
    line: exprLine
  };

  if (expressionType === 'MemberExpression') {
    expressionNode.object = object;
    expressionNode.property = property;
    expressionNode.computed = computed;
    if (computedPropertyVar) {
      expressionNode.computedPropertyVar = computedPropertyVar;
    }
    expressionNode.name = `${object}.${property}`;
  } else if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
    expressionNode.operator = operator;
    expressionNode.name = `<${expressionType}>`;
  } else if (expressionType === 'ConditionalExpression') {
    expressionNode.name = '<ternary>';
  } else if (expressionType === 'TemplateLiteral') {
    expressionNode.name = '<template>';
  }

  this._bufferNode(expressionNode);
```

**After:**
```typescript
// EXPRESSION node creation using NodeFactory
else if (sourceType === 'EXPRESSION' && sourceId) {
  const {
    expressionType,
    object,
    property,
    computed,
    computedPropertyVar,
    operator,
    objectSourceName,
    leftSourceName,
    rightSourceName,
    consequentSourceName,
    alternateSourceName,
    file: exprFile,
    line: exprLine,
    column: exprColumn
  } = assignment;

  // Create node from upstream metadata using factory
  const expressionNode = NodeFactory.createExpressionFromMetadata(
    expressionType || 'Unknown',
    exprFile || '',
    exprLine || 0,
    exprColumn || 0,
    {
      id: sourceId,  // ID from JSASTAnalyzer
      object,
      property,
      computed,
      computedPropertyVar: computedPropertyVar ?? undefined,
      operator
    }
  );

  this._bufferNode(expressionNode);
```

### 2. ExpressionNode.ts - Name Computation Enhancement

**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/ExpressionNode.ts`

**Change:** Updated `_computeName()` to handle all expression types consistently with previous GraphBuilder behavior.

**Before:**
```typescript
private static _computeName(expressionType: string, options: ExpressionNodeOptions): string {
  if (options.path) {
    return options.path;
  }
  if (options.object && options.property) {
    return `${options.object}.${options.property}`;
  }
  return expressionType;
}
```

**After:**
```typescript
/**
 * Compute name from expression properties
 *
 * Naming conventions:
 * - MemberExpression: "object.property"
 * - BinaryExpression: "<BinaryExpression>"
 * - LogicalExpression: "<LogicalExpression>"
 * - ConditionalExpression: "<ternary>"
 * - TemplateLiteral: "<template>"
 * - Other: expressionType
 */
private static _computeName(expressionType: string, options: ExpressionNodeOptions): string {
  if (options.path) {
    return options.path;
  }
  if (options.object && options.property) {
    return `${options.object}.${options.property}`;
  }
  // Special naming for non-MemberExpression types
  switch (expressionType) {
    case 'BinaryExpression':
    case 'LogicalExpression':
      return `<${expressionType}>`;
    case 'ConditionalExpression':
      return '<ternary>';
    case 'TemplateLiteral':
      return '<template>';
    default:
      return expressionType;
  }
}
```

---

## Key Design Decisions

### 1. Use Pre-generated ID from Upstream

GraphBuilder receives `sourceId` from JSASTAnalyzer (which generated it using `ExpressionNode.generateId()`). This ID is passed to `createExpressionFromMetadata()` to ensure consistency between ID generation and node creation.

### 2. Edge Creation Logic Preserved

All edge creation logic (ASSIGNED_FROM, DERIVES_FROM) remains unchanged at lines 849-950. Only the node construction was migrated to the factory.

### 3. Name Computation Centralized

Previously, name computation was duplicated:
- `ExpressionNode._computeName()` - partial implementation
- `GraphBuilder` lines 838-853 - type-specific logic

Now all name computation is in `ExpressionNode._computeName()`, ensuring consistent naming across all EXPRESSION node creation paths.

### 4. Column Field Added

Added `column: exprColumn` to destructuring from assignment metadata. This was already available in `VariableAssignmentInfo` (types.ts line 405) but wasn't being extracted.

---

## Test Results

### Expression.test.js

```
# pass 17
# fail 2
```

**Passed tests include:**
- MemberExpression node creation
- ASSIGNED_FROM edge from VARIABLE to EXPRESSION
- DERIVES_FROM edge from EXPRESSION to object variable
- Computed property access
- BinaryExpression node creation
- BinaryExpression DERIVES_FROM edges
- ConditionalExpression node creation
- ConditionalExpression DERIVES_FROM edges
- LogicalExpression (|| and &&) node creation
- Datalog queries for data flow
- Alias tracking via EXPRESSION
- TemplateLiteral node creation
- TemplateLiteral DERIVES_FROM edges
- Simple template literal as LITERAL (not EXPRESSION)

**Pre-existing failures (not caused by this migration):**
1. `LogicalExpression: should create ASSIGNED_FROM edges for both branches`
2. `TemplateLiteral: should create ASSIGNED_FROM edges from template to expressions`

These tests expect 2+ ASSIGNED_FROM edges but receive 1. This is an issue with edge creation logic, not node creation.

### NoLegacyExpressionIds.test.js

Migration improved test results:
- **Before migration:** 4 passed, 12 failed
- **After migration:** 13 passed, 3 failed

Remaining failures:
1. `GraphBuilder should validate colon-based EXPRESSION IDs` - Test expects `:EXPRESSION:` pattern in GraphBuilder.ts. With factory pattern, validation is in ExpressionNode.ts.
2. `NodeFactory should import ArgumentExpressionNode` - Unrelated test checking imports
3. `should not have EXPRESSION# concatenation patterns` - Bash syntax error in test

These are test design issues, not implementation issues.

---

## Verification

```bash
npm run build  # Success
node --test test/unit/Expression.test.js  # 17 pass, 2 fail (pre-existing)
```

---

## Architecture Alignment

This migration follows the architecture established in Joel's plan:

1. **JSASTAnalyzer** generates IDs using `ExpressionNode.generateId()`
2. **GraphBuilder** creates nodes using `NodeFactory.createExpressionFromMetadata()`
3. **ID format** is consistent: `{file}:EXPRESSION:{type}:{line}:{column}`
4. **Edge creation** unchanged - uses the same `sourceId`

---

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Replaced inline EXPRESSION node construction with factory call |
| `packages/core/src/core/nodes/ExpressionNode.ts` | Enhanced `_computeName()` to handle all expression types |

---

## Next Steps

1. **Update NoLegacyExpressionIds.test.js** - The test at line 198-213 needs to be updated to reflect that ID validation now happens in the factory, not GraphBuilder
2. **Investigate ASSIGNED_FROM edge failures** - The 2 pre-existing Expression.test.js failures need investigation (separate task)
