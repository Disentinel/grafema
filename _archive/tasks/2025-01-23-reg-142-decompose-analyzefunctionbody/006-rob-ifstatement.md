# Rob Pike: Extract IfStatement Handler

## Task
Extract the IfStatement handler (~73 lines) into separate private methods.

## Changes Made

### 1. Created `createIfStatementHandler` method (lines 1298-1378)

Factory method that creates the IfStatement visitor handler. Returns an object with `enter` and `exit` methods.

**Parameters:**
- `parentScopeId` - Parent scope ID for scope nodes
- `module` - Module context
- `scopes` - Collection to push scope nodes to
- `ifScopeCounterRef` - Counter for unique if scope IDs
- `scopeTracker` - Tracker for semantic ID generation
- `sourceCode` - Source code for extracting condition text
- `ifElseScopeMap` - Map to track if/else scope transitions

**Behavior:**
- Enter: Creates if scope with condition parsing (ConditionParser.parse), generates semantic ID, handles optional else branch creation
- Exit: Exits the current scope via scopeTracker, cleans up ifElseScopeMap

### 2. Created `createIfElseBlockStatementHandler` method (lines 1387-1406)

Factory method that creates the BlockStatement handler for tracking if/else transitions.

**Parameters:**
- `scopeTracker` - Tracker for scope management
- `ifElseScopeMap` - Map tracking if/else state

**Behavior:**
- When entering an else block (BlockStatement that is the alternate of an IfStatement), switches scope from if to else by calling `scopeTracker.exitScope()` and `scopeTracker.enterCountedScope('else')`

### 3. Updated `analyzeFunctionBody` method (lines 1929-1941)

Replaced inline handlers with delegation to factory methods:

```typescript
// Before (73 lines):
IfStatement: {
  enter: (ifPath: NodePath<t.IfStatement>) => {
    // ... 56 lines ...
  },
  exit: (ifPath: NodePath<t.IfStatement>) => {
    // ... 12 lines ...
  }
},
BlockStatement: {
  enter: (blockPath: NodePath<t.BlockStatement>) => {
    // ... 12 lines ...
  }
},

// After (11 lines):
IfStatement: this.createIfStatementHandler(
  parentScopeId,
  module,
  scopes,
  ifScopeCounterRef,
  scopeTracker,
  collections.code ?? '',
  ifElseScopeMap
),
BlockStatement: this.createIfElseBlockStatementHandler(scopeTracker, ifElseScopeMap),
```

## State Management

The `ifElseScopeMap` is a closure variable defined in `analyzeFunctionBody`. The factory methods receive it as a parameter, maintaining the same behavior as the original inline implementation. This allows proper tracking of if/else scope transitions across the IfStatement and BlockStatement handlers.

## Verification

1. **Build**: `npm run build` passes
2. **Control Flow Tests**: 17/18 tests pass (1 failure unrelated to this change - console.error detection in catch blocks)
3. **ScopeNodeSemanticId Tests**: 20/20 pass
4. **SemanticIdPipelineIntegration Tests**: 13/13 pass

## Pattern Consistency

The implementation follows the same pattern as `createLoopScopeHandler`:
- Factory method taking all required parameters
- Returns object with enter/exit methods
- Handles scope tracking via scopeTracker
- Pushes to scopes collection

## File
`/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

## Lines Changed
- Added: 1285-1406 (new methods)
- Modified: 1929-1941 (delegation)
- Net reduction in `analyzeFunctionBody`: ~62 lines
