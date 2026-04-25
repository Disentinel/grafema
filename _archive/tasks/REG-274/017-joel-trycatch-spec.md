# Joel Spolsky: Try/Catch/Finally Scope Tracking Tech Spec

## Summary

Refactor `handleTryStatement` to follow the same pattern as `createIfStatementHandler`:
- Return `{ enter, exit }` callbacks
- Use `scopeIdStack` for dynamic scope tracking
- Remove `tryPath.skip()` to allow normal traversal

## Key Changes

### 1. Create `createTryStatementHandler` Method

Returns `{ enter, exit }` callbacks that:
- Create try-block scope on enter
- Pre-create catch/finally scopes (store in map)
- Push try scope to `scopeIdStack`
- Pop on exit

### 2. Create `createCatchClauseHandler` Method

Handles:
- Transition from try-scope to catch-scope
- Catch parameter (error variable) - NOT a VariableDeclaration, needs special handling

### 3. Update `createBlockStatementHandler`

Add finally block transition handling (similar to if/else transition).

### 4. Add Type Definition

```typescript
interface TryScopeInfo {
  tryScopeId: string;
  catchScopeId: string | null;
  finallyScopeId: string | null;
  currentBlock: 'try' | 'catch' | 'finally';
}
```

### 5. Update Visitor Registration

Add `tryScopeMap`, replace TryStatement with new handler, add CatchClause handler.

### 6. Delete Obsolete Code

- `handleTryStatement` - replaced by new handler
- `processBlockVariables` - main VariableDeclaration visitor handles it

## Implementation Order

1. Add TryScopeInfo type
2. Create createTryStatementHandler
3. Create createCatchClauseHandler
4. Update createBlockStatementHandler for finally
5. Add tryScopeMap to analyzeFunctionBody
6. Update visitor registration
7. Delete handleTryStatement
8. Delete processBlockVariables
9. Run tests

## Tests That Must Pass

- `should link call in try block to try-scope`
- `should link call in finally block to finally-scope`
- Catch parameter creates VARIABLE with correct parentScopeId
