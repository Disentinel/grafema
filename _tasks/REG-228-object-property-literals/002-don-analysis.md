# Don Melton's Analysis: REG-228 Object Property Literal Tracking

## Current State Analysis

### 1. What Already Exists

**Good news**: Most of the infrastructure is already in place!

- **LITERAL node type**: Defined in `packages/types/src/nodes.ts` (line 14)
- **OBJECT_LITERAL node type**: Exists in `packages/core/src/core/nodes/ObjectLiteralNode.ts`
- **HAS_PROPERTY edge type**: Already defined in `packages/types/src/edges.ts` (line 43)
- **ObjectPropertyInfo type**: Fully defined in `packages/core/src/plugins/analysis/ast/types.ts` (lines 335-352)
- **Data collection**: `CallExpressionVisitor` already collects `objectProperties` with all needed metadata

### 2. The Gap

**Critical finding**: The `objectProperties` collection is collected but **never passed to GraphBuilder and never processed**.

Evidence:
- In `JSASTAnalyzer.ts`, line 1338-1368, the `graphBuilder.build()` call passes:
  - `objectLiterals` (line 1366)
  - `arrayLiterals` (line 1367)
  - **BUT NOT `objectProperties`**
  - **BUT NOT `arrayElements`**

- In `GraphBuilder.ts`:
  - `bufferObjectLiteralNodes()` method exists (lines 1476-1489) - creates OBJECT_LITERAL nodes
  - **NO method exists to create HAS_PROPERTY edges from `objectProperties`**

### 3. Data Flow

Current flow:
```
CallExpressionVisitor.extractObjectProperties()
  → populates objectProperties[] collection
  → stores propertyName, valueType, valueNodeId, literalValue, etc.
  → BUT this data is never used by GraphBuilder
```

The `ObjectPropertyInfo` structure has everything we need:
```typescript
interface ObjectPropertyInfo {
  objectId: string;           // Parent OBJECT_LITERAL node ID
  propertyName: string;       // Property name for edge metadata
  valueNodeId?: string;       // ID of the value node (LITERAL, nested OBJECT_LITERAL, etc.)
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'SPREAD';
  valueName?: string;         // For VARIABLE type
  literalValue?: unknown;     // For LITERAL type
  // ... location fields
}
```

## Files That Need Changes

### File 1: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Change needed**: Pass `objectProperties` to GraphBuilder.build()

### File 2: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Changes needed**:
1. Extract `objectProperties` from data parameter
2. Add new method `bufferObjectPropertyEdges()` to create HAS_PROPERTY edges
3. Call this method in `build()` after buffering LITERAL and OBJECT_LITERAL nodes

## Implementation Plan

### Phase 1: Pass Collections to GraphBuilder
1. In `JSASTAnalyzer.ts`, add `objectProperties` to the `graphBuilder.build()` call

### Phase 2: Create HAS_PROPERTY Edges
2. In `GraphBuilder.ts`, add method:
```typescript
private bufferObjectPropertyEdges(objectProperties: ObjectPropertyInfo[]): void {
  for (const prop of objectProperties) {
    if (prop.valueNodeId) {
      this._bufferEdge({
        type: 'HAS_PROPERTY',
        src: prop.objectId,
        dst: prop.valueNodeId,
        propertyName: prop.propertyName
      });
    }
  }
}
```

3. Call this method in `build()` after `bufferObjectLiteralNodes()`

## Architectural Considerations

1. **Order matters**: HAS_PROPERTY edges must be created AFTER both OBJECT_LITERAL and LITERAL nodes are buffered.

2. **Edge direction**: Per the types definition, `HAS_PROPERTY` goes from container to value: `OBJECT_LITERAL -> property value`

3. **Metadata**: The `ObjectStructureEdge` interface already has `propertyName?: string` for HAS_PROPERTY edges.

## Scope

The fix is minimal and surgical:
- LITERAL nodes for property values - **Already working**
- HAS_PROPERTY edges - **Missing, this is the fix**
