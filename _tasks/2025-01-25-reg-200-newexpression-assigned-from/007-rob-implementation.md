# REG-200: Implementation Report

## Summary

Implemented CONSTRUCTOR_CALL nodes and ASSIGNED_FROM edges for NewExpression per the Linus-approved spec:

```
VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL
```

## Changes Made

### 1. Created ConstructorCallNode.ts
**File:** `/packages/core/src/core/nodes/ConstructorCallNode.ts`

- New node type for `new ClassName()` expressions
- Properties: `id`, `type`, `name`, `className`, `isBuiltin`, `file`, `line`, `column`
- ID format: `{file}:CONSTRUCTOR_CALL:{className}:{line}:{column}`
- Static methods:
  - `generateId()` - generates node ID
  - `isBuiltinConstructor()` - checks if className is a built-in JS constructor
  - `create()` - creates the node record
  - `validate()` - validates node structure
- Includes comprehensive list of built-in constructors (Date, Map, Set, Array, Promise, etc.)

### 2. Updated nodes/index.ts
**File:** `/packages/core/src/core/nodes/index.ts`

- Added export for ConstructorCallNode and ConstructorCallNodeRecord type

### 3. Updated NodeFactory.ts
**File:** `/packages/core/src/core/NodeFactory.ts`

- Added import for ConstructorCallNode
- Added `ConstructorCallOptions` interface
- Added `createConstructorCall()` factory method
- Added `generateConstructorCallId()` helper
- Added `isBuiltinConstructor()` helper
- Added CONSTRUCTOR_CALL to validators map

### 4. Updated ast/types.ts
**File:** `/packages/core/src/plugins/analysis/ast/types.ts`

- Added `ConstructorCallInfo` interface
- Added `constructorCalls` to `ASTCollections` interface

### 5. Updated JSASTAnalyzer.ts
**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Two key changes:

#### 5a. Module-level NewExpression traversal (new)
Added dedicated traversal for ALL NewExpressions (lines 1127-1166):
- Creates CONSTRUCTOR_CALL info for every `new X()` expression
- Works at module level and inside functions
- Handles both simple (`new Date()`) and member expression callees (`new module.Class()`)

#### 5b. Updated trackVariableAssignment()
Changed NewExpression handling from `sourceType: 'CLASS'` to `sourceType: 'CONSTRUCTOR_CALL'` with additional location info:
- `className` - constructor name
- `file`, `line`, `column` - location info for matching

### 6. Updated GraphBuilder.ts
**File:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

- Added import for ConstructorCallInfo
- Added extraction of `constructorCalls` collection
- Added step 4.5: Buffer CONSTRUCTOR_CALL nodes from collection
- Updated bufferAssignmentEdges to create ASSIGNED_FROM edges to existing CONSTRUCTOR_CALL nodes (no longer creates inline nodes to avoid duplicates)

## Key Design Decisions

1. **No BUILTIN_JS singletons** - Each NewExpression creates a unique CONSTRUCTOR_CALL node with location info
2. **No INVOKES edges** - Per simplified spec, we don't create INVOKES edges from CONSTRUCTOR_CALL to CLASS
3. **`isBuiltin` property** - Distinguishes built-in JS constructors (Date, Map, etc.) from user-defined classes
4. **Node creation in visitor** - CONSTRUCTOR_CALL nodes are created in the NewExpression visitor, not inline during assignment processing. This ensures all NewExpressions get nodes, even chained ones like `new Builder().build()`

## Tests

All 18 tests pass:
- Built-in constructors (3 tests)
- User-defined class constructors (2 tests)
- Multiple constructors in same file (1 test)
- Data flow query (1 test)
- CONSTRUCTOR_CALL node attributes (2 tests)
- Edge cases (5 tests, including chained `new Builder().build()`)
- Integration with existing patterns (2 tests)
- No INVOKES edges (1 test)

## Files Modified

1. `/packages/core/src/core/nodes/ConstructorCallNode.ts` (NEW)
2. `/packages/core/src/core/nodes/index.ts`
3. `/packages/core/src/core/NodeFactory.ts`
4. `/packages/core/src/plugins/analysis/ast/types.ts`
5. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
6. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
