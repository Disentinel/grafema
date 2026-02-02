# Rob Pike - Implementation Report for REG-276

## Summary

Successfully implemented RETURNS edges for complex expressions (BinaryExpression, ConditionalExpression, MemberExpression, etc.). When a function returns a complex expression, we now create:

1. An EXPRESSION node representing the return value
2. DERIVES_FROM edges connecting the EXPRESSION to its source variables/parameters
3. A RETURNS edge connecting the EXPRESSION to the function

## Changes Made

### 1. Extended ReturnStatementInfo (types.ts)

Added new fields to support source variable extraction for expressions:

```typescript
// For BinaryExpression/LogicalExpression
operator?: string;
leftSourceName?: string;
rightSourceName?: string;

// For ConditionalExpression
consequentSourceName?: string;
alternateSourceName?: string;

// For MemberExpression
object?: string;
property?: string;
computed?: boolean;
objectSourceName?: string;

// For TemplateLiteral
expressionSourceNames?: string[];

// For UnaryExpression
unaryArgSourceName?: string;
```

### 2. Updated JSASTAnalyzer ReturnStatement Handler

Modified the ReturnStatement handler to extract source variable names for each expression type:

- **BinaryExpression**: Extracts `leftSourceName` and `rightSourceName` for identifiers
- **LogicalExpression**: Same as BinaryExpression with `operator`
- **ConditionalExpression**: Extracts `consequentSourceName` and `alternateSourceName`
- **UnaryExpression**: Extracts `unaryArgSourceName`
- **MemberExpression**: Extracts `object`, `property`, and `objectSourceName`
- **TemplateLiteral**: Extracts all `expressionSourceNames` for embedded identifiers

Each expression type now generates a stable EXPRESSION ID using `NodeFactory.generateExpressionId()`.

### 3. Updated Implicit Arrow Function Handlers

Applied the same EXPRESSION handling to THREE locations:
1. Top-level implicit arrow returns (around line 2576)
2. Nested arrow function implicit returns (around line 3142)
3. ReturnStatement handler (around line 2771)

**Important TypeScript fix**: Moved TemplateLiteral checks BEFORE `isLiteral` checks because `TemplateLiteral` extends `Literal` in Babel types. Without this, TypeScript narrowing caused type errors.

### 4. Updated GraphBuilder.bufferReturnEdges

Replaced the empty `case 'EXPRESSION'` block with full implementation:

```typescript
case 'EXPRESSION': {
  // Skip if no expression ID was generated
  if (!returnValueId) break;

  // Create EXPRESSION node using NodeFactory
  const expressionNode = NodeFactory.createExpressionFromMetadata(...);
  this._bufferNode(expressionNode);
  sourceNodeId = returnValueId;

  // Helper to find source variable or parameter
  const findSource = (name: string): string | null => {...};

  // Buffer DERIVES_FROM edges based on expression type
  // MemberExpression, BinaryExpression, LogicalExpression,
  // ConditionalExpression, UnaryExpression, TemplateLiteral
  ...
}
```

### 5. Updated Test File

Changed the "documented gap" test to expect edges now that the feature is implemented:

```javascript
// Before (documented gap)
it('should NOT create RETURNS edge for arrow function with expression body (documented gap)', ...)

// After (implemented)
it('should create RETURNS edge for arrow function with expression body (REG-276)', ...)
```

## Files Modified

| File | Changes |
|------|---------|
| `packages/core/src/plugins/analysis/ast/types.ts` | +20 lines (new fields in ReturnStatementInfo) |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | +250 lines (expression handling in 3 locations) |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | +120 lines (EXPRESSION case implementation) |
| `test/unit/ReturnStatementEdges.test.js` | Updated 1 test from gap to expectation |

## Test Results

All 35 tests pass:

```
ok 1 - RETURNS Edges (REG-263)
  - Return literal (2 tests)
  - Return variable (2 tests)
  - Return function call (2 tests)
  - Return method call (2 tests)
  - Multiple returns (2 tests)
  - Arrow function block body (2 tests)
  - Arrow function implicit return (4 tests)
  - Bare return (3 tests)
  - Return parameter (3 tests)
  - Nested functions (1 test)
  - Class methods (2 tests)
  - Async functions (1 test)
  - Edge direction verification (1 test)
  - No duplicates on re-run (1 test)
  - Return expressions REG-276 (8 tests)
```

## Design Decisions

1. **TemplateLiteral order**: Moved TemplateLiteral check before `isLiteral` to handle TypeScript narrowing correctly (TemplateLiteral extends Literal).

2. **Helper function for source lookup**: Created `findSource()` helper in GraphBuilder to check both `variableDeclarations` and `parameters`, reducing code duplication.

3. **ID generation**: Uses existing `NodeFactory.generateExpressionId()` pattern from assignment handling for consistency.

4. **DERIVES_FROM edges**: Only created when source identifier is found - we don't create edges for literals or nested expressions in operands.

## Limitations / Future Work

1. **Nested expressions**: Only extracts top-level identifiers from operands. `return a.b + c` creates DERIVES_FROM to `a` but not to property access chain.

2. **Chained method calls**: Already documented gap - `items.filter().map()` doesn't create RETURNS edge.

3. **Destructured parameters**: Still a gap - `return name` from `function({ name })` doesn't find source.
