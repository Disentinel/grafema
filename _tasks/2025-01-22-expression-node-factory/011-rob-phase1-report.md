# Phase 1: ArgumentExpressionNode Infrastructure - Implementation Report

**Date:** 2025-01-22
**Author:** Rob Pike (Implementation Engineer)
**Status:** COMPLETE

---

## Summary

Phase 1 successfully implemented the ArgumentExpressionNode infrastructure without breaking changes. All 19 tests in `ArgumentExpression.test.js` pass.

## Files Created

### 1. `/Users/vadimr/grafema/packages/core/src/core/nodes/ArgumentExpressionNode.ts`

New node class that provides call argument context for EXPRESSION nodes.

**Key decisions:**
- **Not extending ExpressionNode class**: TypeScript's static property inheritance constraints don't allow extending readonly tuple types with additional elements. Instead, ArgumentExpressionNode is a standalone class that:
  - Copies `TYPE` from `ExpressionNode.TYPE`
  - Defines its own `REQUIRED` and `OPTIONAL` arrays that include both base and extended fields
  - Delegates to `ExpressionNode.create()` for base node creation
  - Delegates to `ExpressionNode.validate()` for base validation

- **ID format**: `{file}:EXPRESSION:{expressionType}:{line}:{column}` with optional counter suffix `:{counter}`

- **Required fields**: `parentCallId`, `argIndex` (in addition to base ExpressionNode required fields)

- **Optional fields**: `counter` (for disambiguation when same location has multiple expressions)

## Files Modified

### 2. `/Users/vadimr/grafema/packages/core/src/core/nodes/index.ts`

Added export:
```typescript
export { ArgumentExpressionNode, type ArgumentExpressionNodeRecord, type ArgumentExpressionNodeOptions } from './ArgumentExpressionNode.js';
```

### 3. `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`

- Added `ArgumentExpressionNode` import
- Added `ArgumentExpressionOptions` interface
- Added `createArgumentExpression()` method with full JSDoc documentation

### 4. `/Users/vadimr/grafema/packages/core/src/index.ts`

Added public export:
```typescript
export { ArgumentExpressionNode, type ArgumentExpressionNodeRecord, type ArgumentExpressionNodeOptions } from './core/nodes/ArgumentExpressionNode.js';
```

## Test Results

```
node --test test/unit/ArgumentExpression.test.js

# tests 19
# suites 6
# pass 19
# fail 0
```

All test suites pass:
- ArgumentExpressionNode.create() - 8 tests
- ArgumentExpressionNode.validate() - 3 tests
- NodeFactory.createArgumentExpression() - 3 tests
- ID format validation - 3 tests
- REQUIRED and OPTIONAL field constants - 2 tests

## API Reference

### ArgumentExpressionNode.create()

```typescript
ArgumentExpressionNode.create(
  expressionType: string,      // 'BinaryExpression', 'LogicalExpression', etc.
  file: string,                // Absolute file path
  line: number,                // Line number
  column: number,              // Column position
  options: {
    parentCallId: string,      // REQUIRED: ID of the call site
    argIndex: number,          // REQUIRED: Argument position (0-indexed)
    counter?: number,          // Optional: Disambiguation counter
    // ...all ExpressionNode optional fields
  }
): ArgumentExpressionNodeRecord
```

### NodeFactory.createArgumentExpression()

Same signature as above. Delegates to `ArgumentExpressionNode.create()`.

## Design Notes

1. **Composition over inheritance**: Due to TypeScript limitations with static readonly tuple types, ArgumentExpressionNode uses composition (calling ExpressionNode.create/validate) rather than class inheritance.

2. **ID format consistency**: Uses the same colon-based format as ExpressionNode (`{file}:EXPRESSION:{type}:{line}:{column}`) with optional counter suffix for disambiguation.

3. **Validation inheritance**: validate() calls ExpressionNode.validate() first, then adds ArgumentExpression-specific checks.

4. **No breaking changes**: This phase only adds new infrastructure. Existing code continues to work.

## Next Steps

Phase 2 should migrate VariableVisitor.ts to use NodeFactory.createExpression() instead of inline object creation with hash-based IDs.
