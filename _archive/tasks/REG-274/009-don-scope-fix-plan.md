# Don Melton: Scope Tracking Architecture Fix

## Root Cause

The disconnect happens because:
1. **ScopeTracker** is used for **semantic ID generation** - correctly tracks if/else/loop nesting
2. **parentScopeId** is used for **CONTAINS edges** - fixed value passed into analyzeFunctionBody, never updated

These two systems evolved separately. ScopeTracker was added for stable semantic IDs; parentScopeId predates it.

## Evidence

- CALL semantic ID: `test-guards.js->processUser->if#0->if#0->CALL->deleteAllRecords#0` (correct)
- CONTAINS edge: `function_body --CONTAINS--> CALL` (wrong - should be from innermost if-scope)

## Proposed Fix

**Track current scope ID dynamically:**

1. Add `currentScopeId` variable in `analyzeFunctionBody`
2. Initialize to function body scope ID
3. When entering conditional scope (if/loop/try):
   - Push current scope to stack
   - Set currentScopeId to new scope's ID
4. When exiting:
   - Pop from stack / restore previous value
5. Pass `currentScopeId` (not fixed `parentScopeId`) to call handlers

## Files Requiring Changes

1. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`:
   - `analyzeFunctionBody` - add scope ID tracking
   - `createIfStatementHandler` - push/pop scope ID
   - `createLoopScopeHandler` - push/pop scope ID
   - `handleCallExpression` - use current scope ID
   - `handleTryStatement` - push/pop scope ID

2. No changes needed:
   - `GraphBuilder.ts` - already uses parentScopeId correctly
   - `ScopeTracker.ts` - already works correctly
   - MCP handlers - find_guards is correct

## Impact

- Semantic IDs: unchanged
- CONTAINS edges: become more precise (actual scope, not function body)
- Existing queries for functions/variables: unaffected
- find_guards: will work correctly after fix
