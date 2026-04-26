# Rob Pike - Implementation Report: Semantic IDs Pipeline

## Summary

Implemented semantic ID integration for REG-123 following Joel's technical plan. The implementation adds ScopeTracker support to VariableVisitor and CallExpressionVisitor, and updates JSASTAnalyzer to pass ScopeTracker through the pipeline.

## Files Modified

### 1. `/packages/core/src/plugins/analysis/ast/types.ts`
- Added `id?: string` field to `ArrayMutationInfo` interface for semantic IDs
- Added `scopeTracker` field to `ASTCollections` interface

### 2. `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`
- Added imports for `ScopeTracker` and `computeSemanticId`
- Added optional `scopeTracker` parameter to constructor
- Updated `getHandlers()` to generate semantic IDs when scopeTracker is available
- Falls back to legacy IDs when scopeTracker is not provided

### 3. `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
- Added imports for `ScopeTracker` and `computeSemanticId`
- Added optional `scopeTracker` parameter to constructor
- Updated direct call ID generation to use semantic IDs
- Updated method call ID generation to use semantic IDs
- Updated constructor call (NewExpression) ID generation
- Updated `detectArrayMutation()` to include semantic ID in ArrayMutationInfo

### 4. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- Added `basename` import from `path`
- Added `computeSemanticId` import
- Added `scopeTracker` to `Collections` interface
- Created ScopeTracker with `basename(module.file)` for readable IDs
- Updated VariableVisitor instantiation to pass scopeTracker
- Updated CallExpressionVisitor instantiation to pass scopeTracker
- Added scopeTracker to allCollections
- Updated `analyzeFunctionBody()` variable declarations to use semantic IDs
- Updated `analyzeFunctionBody()` direct call sites to use semantic IDs
- Updated `analyzeFunctionBody()` NewExpression calls to use semantic IDs

## Test Results

**Before implementation:** All semantic ID tests failing (17 tests)

**After implementation:**
- VariableVisitorSemanticIds.test.js: 12 passing, 5 failing
- CallExpressionVisitorSemanticIds.test.js: 13 passing, 11 failing
- **Total: 25 passing, 16 failing**

### Passing Tests
- Module-level const/let/var declarations
- Function-scoped basic variables
- Class method variables
- Arrow function scoped variables
- Module-level direct calls
- Module-level method calls
- Module-level constructor calls
- Multiple same-named calls with discriminators at module level
- Async function calls (basic)

### Failing Tests
The remaining failures are related to **control flow scope tracking** which requires significant additional work:

1. **Variables inside control flow** (if/for/while/try blocks)
   - Tests expect `functionName->if#0->VARIABLE->name` format
   - Currently produces `functionName->VARIABLE->name` (missing control flow scope)

2. **Calls inside control flow blocks**
   - Same issue - control flow scopes not tracked in semantic IDs

3. **Discriminators for same-named variables**
   - Need discriminator logic when same variable name appears multiple times

4. **Array mutation semantic IDs** (FLOWS_INTO edges)
   - Array mutations aren't creating edges properly in tests

## Architectural Notes

### Why Control Flow Scopes Are Not Yet Implemented

The `analyzeFunctionBody` method processes control flow statements (if/for/while) but doesn't integrate with `ScopeTracker.enterScope()/exitScope()` for these constructs. The current implementation:

1. Creates SCOPE nodes for control flow
2. Processes contents with legacy IDs
3. Doesn't update scopeTracker state

Proper implementation would require:
1. Calling `scopeTracker.enterCountedScope('if')` before processing if-block
2. Processing contents (variables, calls) with updated scope context
3. Calling `scopeTracker.exitScope()` after processing

This is a larger refactoring task that affects multiple handlers in `analyzeFunctionBody`:
- IfStatement handler (~100 lines)
- ForStatement handler
- WhileStatement handler
- TryStatement handler

### Design Decisions

1. **Basename for file path**: Used `basename(module.file)` to create shorter, more readable semantic IDs (e.g., `index.js` vs full path)

2. **Fallback to legacy IDs**: When scopeTracker is not available, code falls back to legacy ID format for backward compatibility

3. **Discriminators**: Using `scopeTracker.getItemCounter()` for same-named items in the same scope

## Recommendations for Follow-up

1. **Priority 1**: Update `analyzeFunctionBody` control flow handlers to use scopeTracker
   - Enter/exit scopes for if/for/while/try blocks
   - This will fix the majority of remaining test failures

2. **Priority 2**: Add discriminator logic for same-named variables
   - Currently variables with same name in same scope don't get discriminators

3. **Priority 3**: Verify array mutation edge creation
   - The `detectArrayMutation()` method now sets `id` but edge creation needs verification

## Code Quality

- All changes follow existing patterns (FunctionVisitor reference implementation)
- No new dependencies added
- Backward compatible (scopeTracker is optional)
- Build passes with no TypeScript errors
