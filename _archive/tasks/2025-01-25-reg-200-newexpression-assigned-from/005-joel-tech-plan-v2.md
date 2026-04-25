# Joel Spolsky: REG-200 Technical Specification v2 (Simplified)

## Overview

After Linus review, simplified to:
- **CONSTRUCTOR_CALL** nodes with `isBuiltin` field
- **ASSIGNED_FROM** edges only
- No BUILTIN_JS singletons
- No INVOKES edges

## Type Definitions

### packages/core/src/core/nodes/ConstructorCallNode.ts (NEW FILE)

```typescript
/**
 * ConstructorCallNode - contract for CONSTRUCTOR_CALL node
 *
 * Represents a `new ClassName()` expression.
 * Used for data flow tracking - ASSIGNED_FROM edges point to this node.
 *
 * ID format: {file}:CONSTRUCTOR_CALL:{className}:{line}:{column}
 */

interface ConstructorCallNodeRecord extends BaseNodeRecord {
  type: 'CONSTRUCTOR_CALL';
  className: string;       // Date, Map, MyClass, etc.
  column: number;
  isBuiltin: boolean;      // true for Date, Map, Set, etc.
  parentScopeId?: string;
}
```

### VariableAssignmentInfo Update

```typescript
export interface VariableAssignmentInfo {
  variableId: string;
  sourceId?: string | null;
  sourceType: 'LITERAL' | 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'FUNCTION'
            | 'EXPRESSION' | 'CLASS' | 'CONSTRUCTOR_CALL' | 'DERIVES_FROM_VARIABLE';
  className?: string;
  // For CONSTRUCTOR_CALL:
  column?: number;
  file?: string;
  isBuiltinConstructor?: boolean;
}
```

## Implementation Steps

### Step 1: Create ConstructorCallNode.ts

File: `packages/core/src/core/nodes/ConstructorCallNode.ts`

- Define ConstructorCallNodeRecord interface
- Static BUILTIN_CONSTRUCTORS Set for detection
- create() method with ID generation
- isBuiltinConstructor() helper

### Step 2: Update nodes/index.ts

Add export for ConstructorCallNode.

### Step 3: Update NodeFactory.ts

Add:
- createConstructorCall(className, file, line, column, options)
- generateConstructorCallId(className, file, line, column)
- isBuiltinConstructor(className)

### Step 4: Update JSASTAnalyzer.trackVariableAssignment()

Change NewExpression handling from:
```typescript
sourceType: 'CLASS'
```

To:
```typescript
sourceType: 'CONSTRUCTOR_CALL',
sourceId: constructorCallId,
column,
isBuiltinConstructor
```

### Step 5: Update GraphBuilder.bufferAssignmentEdges()

Add handling for CONSTRUCTOR_CALL:
- Create CONSTRUCTOR_CALL node
- Create ASSIGNED_FROM edge: VARIABLE -> CONSTRUCTOR_CALL

### Step 6: Add CONSTRUCTOR_CALL to NODE_TYPE

In `packages/types/src/nodes.ts`.

## Edge Model

```
VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL
```

That's it. Clean and simple.

## Test Scenarios

1. `const date = new Date()` - creates CONSTRUCTOR_CALL node with isBuiltin=true, ASSIGNED_FROM edge
2. `const map = new Map()` - same pattern
3. `const db = new Database()` - creates CONSTRUCTOR_CALL node with isBuiltin=false, ASSIGNED_FROM edge
4. Multiple constructors in same file - distinct CONSTRUCTOR_CALL nodes
5. Data flow query - "trace where value comes from" returns CONSTRUCTOR_CALL

## Files Summary

| File | Action |
|------|--------|
| `packages/core/src/core/nodes/ConstructorCallNode.ts` | CREATE |
| `packages/core/src/core/nodes/index.ts` | MODIFY |
| `packages/core/src/core/NodeFactory.ts` | MODIFY |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | MODIFY |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | MODIFY |
| `packages/core/src/plugins/analysis/ast/types.ts` | MODIFY |
| `packages/types/src/nodes.ts` | MODIFY |
| `test/unit/DataFlowTracking.test.js` | MODIFY |
