# Rob Pike - Phase 2b Implementation Report

## Task
Migrate VariableVisitor EXPRESSION node creation to use NodeFactory.createExpression().

## Changes Made

### File: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

1. **Added NodeFactory import** (line 22):
```typescript
import { NodeFactory } from '../../../../core/NodeFactory.js';
```

2. **Replaced inline EXPRESSION object creation** (lines 229-245):

Before:
```typescript
const expressionId = `EXPRESSION#${expressionPath}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}`;

// Create EXPRESSION node representing the property access
(literals as LiteralExpressionInfo[]).push({
  id: expressionId,
  type: 'EXPRESSION',
  expressionType: varInfo.propertyPath ? 'MemberExpression' : 'ArrayAccess',
  path: expressionPath,
  baseName: initName,
  propertyPath: varInfo.propertyPath || null,
  arrayIndex: varInfo.arrayIndex,
  file: module.file,
  line: varInfo.loc.start.line
});
```

After:
```typescript
// Create EXPRESSION node representing the property access
const expressionType = varInfo.propertyPath ? 'MemberExpression' : 'ArrayAccess';
const expressionNode = NodeFactory.createExpression(
  expressionType,
  module.file,
  varInfo.loc.start.line,
  varInfo.loc.start.column,
  {
    path: expressionPath,
    baseName: initName,
    propertyPath: varInfo.propertyPath || undefined,
    arrayIndex: varInfo.arrayIndex
  }
);

const expressionId = expressionNode.id;
(literals as LiteralExpressionInfo[]).push(expressionNode as LiteralExpressionInfo);
```

## ID Format Change

- **Old format (legacy):** `EXPRESSION#obj.prop#/path/file.js#3:8`
- **New format (colon):** `/path/file.js:EXPRESSION:MemberExpression:3:8`

## Verification

### Build
```
npm run build - SUCCESS
```

### Tests

1. **NoLegacyExpressionIds.test.js** - VariableVisitor tests PASS:
   - `VariableVisitor should use NodeFactory.createExpression()` - PASS
   - `key files should import NodeFactory` (for VariableVisitor) - PASS

2. **DestructuringDataFlow.test.js** - All 6 tests PASS:
   - ObjectPattern destructuring works with new ID format
   - ArrayPattern destructuring works with new ID format
   - Value domain analysis integration works

### Remaining Test Failures (NOT caused by this change)

The following failures are pre-existing or relate to Phase 2c (CallExpressionVisitor):
- CallExpressionVisitor still uses legacy `EXPRESSION#` format (Phase 2c scope)
- Expression.test.js has failures in LogicalExpression/TemplateLiteral (unrelated)
- Other pre-existing failures in ClearAndRebuild, EnumNode, etc.

## Summary

Phase 2b complete. VariableVisitor now:
1. Imports NodeFactory
2. Uses `NodeFactory.createExpression()` for destructuring EXPRESSION nodes
3. Generates colon-format IDs (e.g., `file:EXPRESSION:MemberExpression:line:column`)
4. No longer constructs inline `EXPRESSION#` hash-format IDs

All destructuring data flow functionality preserved with the new ID format.
