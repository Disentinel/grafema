# Joel Spolsky: Technical Specification for Scope Tracking Fix

## Problem Summary

CONTAINS edges always link CALL/VARIABLE nodes to the function body scope, not to the actual conditional scope that contains them.

## Solution: Add Dynamic Scope ID Stack

### Step 1: Add Scope ID Stack to `analyzeFunctionBody`

```typescript
// Track current scope ID for CONTAINS edges
const scopeIdStack: string[] = [parentScopeId];
const getCurrentScopeId = (): string => scopeIdStack[scopeIdStack.length - 1];
```

### Step 2-5: Update Handlers to Push/Pop

Each conditional scope handler needs to:
- **On enter**: Push scope ID to stack
- **On exit**: Pop scope ID from stack

Handlers to update:
- `createIfStatementHandler` - push ifScopeId, swap to elseScopeId
- `createIfElseBlockStatementHandler` - swap if/else scope IDs
- `createLoopScopeHandler` - push/pop loop scope ID
- `handleTryStatement` - push/pop try/catch/finally scope IDs

### Step 6-10: Update Node Handlers to Use Current Scope

Change from `parentScopeId` to `getCurrentScopeId()`:
- `CallExpression` handler
- `NewExpression` handler
- `VariableDeclaration` handler

## Test Cases

1. Call inside single if → parentScopeId includes 'if'
2. Call inside nested if → parentScopeId is innermost if
3. Call inside else → parentScopeId includes 'else'
4. Call inside for loop → parentScopeId includes 'for'
5. Call outside conditional → parentScopeId is function body
6. Variable inside conditional → parentScopeId is the scope

## Implementation Order

1. Update ifElseScopeMap type to include scope IDs
2. Add scopeIdStack and getCurrentScopeId in analyzeFunctionBody
3. Update createLoopScopeHandler
4. Update createIfStatementHandler
5. Update createIfElseBlockStatementHandler
6. Update handleTryStatement
7. Update traverse visitor calls
8. Update CallExpression handler
9. Update NewExpression handler
10. Update VariableDeclaration handler
11. Write and run tests
