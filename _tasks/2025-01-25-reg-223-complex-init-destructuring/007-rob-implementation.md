# REG-223 Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2025-01-25
**Status:** COMPLETE

## Summary

Implemented ASSIGNED_FROM edges for destructuring with complex init expressions (CallExpression, AwaitExpression). All 10 new tests pass.

## Changes Made

### 1. Types Extension (`packages/core/src/plugins/analysis/ast/types.ts`)

Added new fields to `VariableAssignmentInfo` interface for call-based destructuring:

```typescript
// Call-based destructuring support (REG-223)
callSourceLine?: number;     // Line of the CallExpression
callSourceColumn?: number;   // Column of the CallExpression
callSourceFile?: string;     // File containing the call
callSourceName?: string;     // Function name (for lookup disambiguation)
sourceMetadata?: {
  sourceType: 'call' | 'variable' | 'method-call';
};
```

### 2. JSASTAnalyzer (`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`)

#### Added Helper Methods (lines 838-900)

- `unwrapAwaitExpression(node)` - Recursively unwrap AwaitExpression to get the underlying CallExpression
- `extractCallInfo(node)` - Extract call site information (line, column, name, isMethodCall) from CallExpression
- `isCallOrAwaitExpression(node)` - Check if expression is CallExpression or AwaitExpression wrapping a call

#### Updated `trackDestructuringAssignment` (lines 902-1127)

Extended to handle Phase 2 (REG-223) in addition to Phase 1 (REG-201):

- **Phase 1 (existing):** Simple Identifier init expressions (`const { x } = obj`)
- **Phase 2 (new):** CallExpression/AwaitExpression init (`const { x } = getConfig()`, `const { x } = await fetchUser()`)

For Phase 2:
- Unwrap await expressions to get the inner CallExpression
- Extract call info (line, column, name)
- Create EXPRESSION assignments with call source metadata
- Handle rest elements with direct CALL_SITE assignment

#### Added Column to CALL_SITE (line 2603)

```typescript
callSites.push({
  // ...
  column: getColumn(callNode),  // REG-223: Add column for coordinate-based lookup
  // ...
});
```

### 3. VariableVisitor (`packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`)

#### Added Helper Methods and Interface (lines 104-178)

Same helpers as JSASTAnalyzer for consistency:
- `CallInfo` interface
- `unwrapAwaitExpression()`
- `isCallOrAwaitExpression()`
- `extractCallInfo()`

#### Updated Destructuring Handling (lines 289-426)

Extended the inline destructuring handling to support CallExpression/AwaitExpression:
- Phase 1: Simple Identifier init (unchanged)
- Phase 2: CallExpression or AwaitExpression (new)

Creates EXPRESSION assignments with call source metadata for GraphBuilder lookup.

### 4. GraphBuilder (`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`)

#### Added Call-based DERIVES_FROM Lookup (lines 943-986)

For EXPRESSION nodes with `callSourceLine` metadata:
1. Look up CALL_SITE by coordinates (line, column, name)
2. Fall back to methodCalls for method calls
3. Create DERIVES_FROM edge to the found call node
4. Log warning if lookup fails (per Linus review - no silent failures)

## Test Results

All 10 new tests pass:

1. **Basic CallExpression** - `const { apiKey } = getConfig()`
2. **AwaitExpression** - `const { name } = await fetchUser()`
3. **Method Call (array)** - `const [first] = arr.filter(x => x > 0)`
4. **Method Call (object)** - `const { x } = obj.getConfig()`
5. **Nested Destructuring with Call** - `const { data } = fetchConfig()`
6. **Nested Await Destructuring** - `const { user: { name } } = await fetchProfile()`
7. **Mixed Pattern with Call** - `const { items: [first] } = fetchItems()`
8. **Rest Element with Call** - `const { x, ...rest } = fetchAll()`
9. **Coordinate Validation (await)** - Verifies await unwrapping uses correct coordinates
10. **Multiple Calls Same Line** - Verifies disambiguation works

Plus REG-201 regression test passes.

## Architecture Notes

The implementation maintains two parallel code paths:
1. **VariableVisitor** - Handles module-level variables
2. **JSASTAnalyzer.handleVariableDeclaration** - Handles variables inside functions

Both now support:
- Simple Identifier init (REG-201)
- CallExpression/AwaitExpression init (REG-223)

The GraphBuilder creates DERIVES_FROM edges from EXPRESSION nodes to CALL_SITE nodes, enabling data flow tracing through function calls.

## Files Modified

1. `/packages/core/src/plugins/analysis/ast/types.ts` - Extended VariableAssignmentInfo
2. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Added helpers and Phase 2 handling
3. `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts` - Added helpers and Phase 2 handling
4. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Added call-based DERIVES_FROM lookup
