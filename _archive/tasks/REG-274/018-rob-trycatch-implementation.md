# Rob Pike: Try/Catch/Finally Scope Tracking Implementation

## Summary

Refactored `handleTryStatement` to follow the same pattern as `createIfStatementHandler` and `createLoopScopeHandler`. The key change is removing `tryPath.skip()` to allow normal Babel traversal, enabling `CallExpression` and `NewExpression` visitors to see calls inside try/catch/finally blocks.

## Changes Made

### 1. Added TryScopeInfo Interface (line 160-165)

```typescript
interface TryScopeInfo {
  tryScopeId: string;
  catchScopeId: string | null;
  finallyScopeId: string | null;
  currentBlock: 'try' | 'catch' | 'finally';
}
```

### 2. Created `createTryStatementHandler` Method

Factory method returning `{ enter, exit }` callbacks that:
- Create try-block scope on enter
- Pre-create catch/finally scopes (store in map for transitions)
- Push try scope to `scopeIdStack`
- Pop on exit

Key difference from old `handleTryStatement`: **NO `skip()` call** - allows normal traversal.

### 3. Created `createCatchClauseHandler` Method

Handles:
- Scope transition from try to catch (swap on stack)
- Catch parameter (error variable) - creates VARIABLE node with correct parentScopeId
- Semantic ID tracking via scopeTracker

### 4. Updated `createBlockStatementHandler` (renamed from `createIfElseBlockStatementHandler`)

Added finally block handling:
- Detects when entering `finalizer` block of TryStatement
- Transitions scope from try/catch to finally
- Updates both `scopeIdStack` and `scopeTracker`

### 5. Updated `analyzeFunctionBody`

- Added `tryScopeMap` for tracking try/catch/finally transitions
- Registered `TryStatement` with new handler
- Added `CatchClause` handler
- Updated `BlockStatement` to use new combined handler

### 6. Deleted Obsolete Code

- `handleTryStatement` method (162 lines)
- `processBlockVariables` method (75 lines)

## Test Results

All 16 tests in `ScopeContainsEdges.test.js` now pass:

| Suite | Tests | Status |
|-------|-------|--------|
| Call inside if statement | 2 | PASS |
| Call inside nested if statements | 2 | PASS |
| Call inside else block | 2 | PASS |
| Call inside for loop | 3 | PASS |
| Call outside conditional | 2 | PASS |
| Variable inside conditional scope | 2 | PASS |
| Try/catch/finally scopes | 2 | PASS |
| CONTAINS edge source verification | 1 | PASS |

The previously failing tests now pass:
- `should link call in try block to try-scope` - PASS
- `should link call in finally block to finally-scope` - PASS

## Pattern Alignment

The new implementation follows the established patterns:

1. **Loop pattern** (`createLoopScopeHandler`): Single scope, push/pop on enter/exit
2. **If/else pattern** (`createIfStatementHandler` + `createBlockStatementHandler`): Pre-create both scopes, transition on alternate block entry
3. **Try/catch/finally pattern** (new): Pre-create all scopes, transition on CatchClause and finalizer block entry

All three patterns use the same `scopeIdStack` mechanism for dynamic scope tracking, enabling `getCurrentScopeId()` to return the correct scope for CONTAINS edges.

## Files Modified

- `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
  - Added TryScopeInfo interface
  - Added createTryStatementHandler method
  - Added createCatchClauseHandler method
  - Updated createBlockStatementHandler (renamed, added finally handling)
  - Updated analyzeFunctionBody (added tryScopeMap, new visitor registration)
  - Deleted handleTryStatement method
  - Deleted processBlockVariables method

## Net Code Change

- Added: ~180 lines (new handlers)
- Deleted: ~237 lines (old methods)
- Net: ~57 lines removed

The new implementation is more consistent with existing patterns and fixes the scope tracking bug.
