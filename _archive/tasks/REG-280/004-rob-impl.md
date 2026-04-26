# Rob Pike Implementation Report: HAS_CONDITION Edge for LOOP Nodes (REG-280)

## Summary

Successfully implemented HAS_CONDITION edge from LOOP nodes to their condition EXPRESSION for while/do-while/for loops. This follows the existing pattern established for BRANCH nodes (if/switch statements).

## Changes Made

### 1. `packages/core/src/plugins/analysis/ast/types.ts`

Added condition fields to `LoopInfo` interface:

```typescript
// For while/do-while/for: condition expression (REG-280)
conditionExpressionId?: string;     // ID of EXPRESSION/CALL node for condition
conditionExpressionType?: string;   // 'Identifier', 'BinaryExpression', 'CallExpression', etc.
conditionLine?: number;             // Line of condition expression
conditionColumn?: number;           // Column of condition expression
```

### 2. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Updated `createLoopScopeHandler()` to extract condition expressions for while/do-while/for loops:

- **while/do-while loops**: Extract `node.test` using existing `extractDiscriminantExpression()`
- **for loops**: Extract `node.test` if present (null for infinite loops: `for(;;)`)
- **for-in/for-of loops**: No condition extraction (they use ITERATES_OVER instead)

The implementation reuses the existing `extractDiscriminantExpression()` method, which already handles:
- Identifier: `while (x)`
- MemberExpression: `while (obj.prop)`
- CallExpression: `while (fn())`
- BinaryExpression: `while (i < 10)`
- And other expression types

### 3. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

Added two new methods and updated existing code:

#### `bufferLoopConditionEdges(loops, callSites)`
- Creates HAS_CONDITION edge from LOOP to condition expression
- For CallExpression conditions, looks up existing CALL_SITE by coordinates (semantic ID mismatch)
- Skips for-in/for-of loops (no test expression)
- Skips infinite for loops (no test expression)

#### `bufferLoopConditionExpressions(loops)`
- Creates EXPRESSION nodes for non-CallExpression conditions
- CallExpression conditions reuse existing CALL_SITE nodes
- Only creates nodes for IDs containing `:EXPRESSION:` pattern

#### Updated `build()` method
- Added calls to `bufferLoopConditionEdges()` and `bufferLoopConditionExpressions()`
- Updated LOOP node buffering to exclude condition metadata fields

## Edge Semantics

```
LOOP --HAS_CONDITION--> EXPRESSION/CALL
```

- **Source**: LOOP node (while, do-while, for)
- **Destination**: EXPRESSION node (for most conditions) or CALL node (for function call conditions)
- **Created for**: while, do-while, for loops with conditions
- **NOT created for**: for-in, for-of (use ITERATES_OVER), infinite for loops (no condition)

## Test Results

All 13 HAS_CONDITION tests pass:

1. should create HAS_CONDITION edge from while LOOP to condition expression
2. should create HAS_CONDITION edge from do-while LOOP to condition expression
3. should create HAS_CONDITION edge from for LOOP to test expression
4. should NOT create HAS_CONDITION edge for infinite for loop (;;)
5. should NOT create HAS_CONDITION edge for for-of loop (no test expression)
6. should NOT create HAS_CONDITION edge for for-in loop (no test expression)
7. should handle simple Identifier as condition (while variable)
8. should handle CallExpression as condition (while fn())
9. should handle MemberExpression as condition (while obj.prop)
10. should handle UnaryExpression (negation) as condition (while !done)
11. should handle LogicalExpression as condition (while a && b)
12. should create separate HAS_CONDITION edges for nested loops
13. should have valid HAS_CONDITION edge connectivity

All existing loop tests continue to pass (66 total tests in loop-nodes.test.ts).

## Files Modified

1. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/types.ts`
   - Added 4 fields to LoopInfo interface

2. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
   - Added condition extraction in createLoopScopeHandler() (28 lines)

3. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
   - Added bufferLoopConditionEdges() method (35 lines)
   - Added bufferLoopConditionExpressions() method (29 lines)
   - Updated LOOP node buffering to exclude condition fields
   - Added method calls in build()

## Design Notes

- **Reuses existing infrastructure**: Leverages `extractDiscriminantExpression()` from BRANCH handling
- **Consistent pattern**: Follows the same HAS_CONDITION edge pattern as BRANCH nodes
- **Efficient**: CallExpression conditions reuse existing CALL_SITE nodes instead of creating duplicates
- **Clean separation**: Condition metadata is used for edge creation but not stored on LOOP nodes
