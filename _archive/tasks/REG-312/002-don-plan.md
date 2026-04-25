# Don Melton Plan: REG-312 - Track Member Expression Updates

## Executive Summary

**STOP. This requires architectural decision.**

Member expression updates (`obj.prop++`, `arr[i]++`) are NOT simple extensions of REG-288. They sit at the intersection of three existing patterns:

1. **UPDATE_EXPRESSION** (REG-288) - tracks increment/decrement operations
2. **ObjectMutation** - tracks property assignment (`obj.prop = value`)
3. **ArrayMutation** - tracks element assignment (`arr[i] = value`)

The question is: **Which semantic do we follow?**

## The Semantic Problem

### What Does `obj.prop++` Mean?

From AST perspective:
```javascript
obj.prop++
```

Is syntactic sugar for:
```javascript
temp = obj.prop;
obj.prop = temp + 1;
return temp;  // for postfix
```

So it's **both**:
- A read of `obj.prop`
- An increment operation
- A write back to `obj.prop`

### Current State Analysis

**REG-288 (UPDATE_EXPRESSION)** creates:
```
UPDATE_EXPRESSION node:
  - variableName: "i"
  - operator: "++"
  - prefix: false

Edges:
  - UPDATE_EXPRESSION --MODIFIES--> VARIABLE(i)
  - VARIABLE(i) --READS_FROM--> VARIABLE(i)  // self-loop
```

**ObjectMutation** creates:
```
FLOWS_INTO edge:
  - source --FLOWS_INTO--> object
  - mutationType: "property"
  - propertyName: "count"
```

**ArrayMutation** creates:
```
FLOWS_INTO edge:
  - source --FLOWS_INTO--> array
  - mutationType: "array_element"
  - index: 0 (or computed)
```

### The Architectural Tension

If we create UPDATE_EXPRESSION nodes for `obj.prop++`, we have conflicting patterns:

**Option A: UPDATE_EXPRESSION as primary**
```
UPDATE_EXPRESSION(obj.prop++) --MODIFIES--> ???
```
Problem: MODIFIES points to VARIABLE in REG-288. But `obj.prop` is not a VARIABLE node.

**Option B: Mutation pattern as primary**
```
FLOWS_INTO edge with special mutationType: "update_expression"?
```
Problem: This loses the semantic that it's an increment operation, not assignment.

**Option C: Hybrid - both patterns**
```
UPDATE_EXPRESSION node + FLOWS_INTO edge
```
Problem: Duplication. Two different ways to query the same thing.

## Deep Dive: How Object Mutations Work Now

From `detectObjectPropertyAssignment` (JSASTAnalyzer.ts:3805):

```typescript
// Handles: obj.prop = value
if (assignNode.left.type !== 'MemberExpression') return;

// Extract object name
if (memberExpr.object.type === 'Identifier') {
  objectName = memberExpr.object.name;  // "obj"
} else if (memberExpr.object.type === 'ThisExpression') {
  objectName = 'this';
  enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
} else {
  // Complex: obj.nested.prop = value
  return;  // Skip (documented limitation)
}

// Extract property name
if (!memberExpr.computed) {
  propertyName = memberExpr.property.name;  // "prop"
  mutationType = 'property';
} else if (memberExpr.property.type === 'StringLiteral') {
  propertyName = memberExpr.property.value;
  mutationType = 'property';
} else {
  propertyName = '<computed>';
  mutationType = 'computed';
  computedPropertyVar = memberExpr.property.name;  // "i" in arr[i]
}
```

Then `bufferObjectMutationEdges` (GraphBuilder.ts):
```typescript
// Find object variable or parameter
const objectVar = variableDeclarations.find(v => v.name === objectName && v.file === file);
const objectNodeId = objectVar?.id;

// Create FLOWS_INTO edge
FLOWS_INTO edge:
  - src: sourceVariableId (the value being assigned)
  - dst: objectNodeId (the object being mutated)
  - mutationType: 'property' | 'computed'
  - propertyName: "prop"
  - computedPropertyVar: "i" (if applicable)
```

## The Right Answer

**Follow the mutation pattern, NOT the update expression pattern.**

### Why?

1. **Semantic accuracy**: `obj.prop++` is fundamentally a property mutation, not a variable update
2. **Query alignment**: Users ask "what mutates this object?" not "what update expressions exist?"
3. **Consistency**: We already track `obj.prop = value` as mutation, `obj.prop++` should follow same pattern
4. **Edge structure**: FLOWS_INTO already has mutation metadata (mutationType, propertyName)

### What About UPDATE_EXPRESSION Nodes?

**Don't create them for member expressions.**

Rationale:
- UPDATE_EXPRESSION nodes in REG-288 are for **variable modification tracking**
- Member expressions modify **object properties**, not variables
- Creating UPDATE_EXPRESSION for both would muddy the semantic distinction

The graph already tells the story through different node types:
- `i++` → UPDATE_EXPRESSION (modifies variable)
- `obj.prop++` → ObjectMutation (mutates object property)

## Proposed Solution

### 1. Extend ObjectMutationInfo Type

Add new field to track update operations:

```typescript
// packages/core/src/plugins/analysis/ast/types.ts
export interface ObjectMutationInfo {
  // ... existing fields ...
  
  // REG-312: Track increment/decrement on properties
  updateOperator?: '++' | '--';  // Only set for obj.prop++/-- cases
  updatePrefix?: boolean;        // true for ++obj.prop, false for obj.prop++
}
```

### 2. Modify collectUpdateExpression

**Current:**
```typescript
if (updateNode.argument.type !== 'Identifier') {
  return;  // Skip member expressions
}
```

**New approach - delegate to mutation handler:**
```typescript
if (updateNode.argument.type !== 'Identifier') {
  // Member expression update: obj.prop++, arr[i]++
  // Delegate to object/array mutation tracking
  this.collectMemberExpressionUpdate(updateNode, module, objectMutations, arrayMutations, scopeTracker);
  return;
}
```

### 3. New Method: collectMemberExpressionUpdate

```typescript
private collectMemberExpressionUpdate(
  updateNode: t.UpdateExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  arrayMutations: ArrayMutationInfo[],
  scopeTracker?: ScopeTracker
): void {
  if (updateNode.argument.type !== 'MemberExpression') return;
  
  const memberExpr = updateNode.argument;
  
  // Determine if array or object mutation
  // If computed with NumericLiteral: arr[0]++ → array mutation
  // Otherwise: obj.prop++, obj['key']++, obj[i]++ → object mutation
  
  if (memberExpr.computed && memberExpr.property.type === 'NumericLiteral') {
    // Array element update: arr[0]++
    this.collectArrayElementUpdate(updateNode, memberExpr, module, arrayMutations);
  } else {
    // Object property update: obj.prop++, obj[key]++
    this.collectObjectPropertyUpdate(updateNode, memberExpr, module, objectMutations, scopeTracker);
  }
}
```

### 4. collectObjectPropertyUpdate

Follows exact same pattern as `detectObjectPropertyAssignment`, but:
- No value extraction (it's always `+1` or `-1`)
- Add `updateOperator` and `updatePrefix` fields

```typescript
private collectObjectPropertyUpdate(
  updateNode: t.UpdateExpression,
  memberExpr: t.MemberExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker
): void {
  // Extract object name (same logic as detectObjectPropertyAssignment)
  let objectName: string;
  let enclosingClassName: string | undefined;
  
  if (memberExpr.object.type === 'Identifier') {
    objectName = memberExpr.object.name;
  } else if (memberExpr.object.type === 'ThisExpression') {
    objectName = 'this';
    if (scopeTracker) {
      enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
    }
  } else {
    // Complex: obj.nested.prop++ (skip for now)
    return;
  }
  
  // Extract property name (same logic)
  let propertyName: string;
  let mutationType: 'property' | 'computed';
  let computedPropertyVar: string | undefined;
  
  if (!memberExpr.computed) {
    if (memberExpr.property.type === 'Identifier') {
      propertyName = memberExpr.property.name;
      mutationType = 'property';
    } else {
      return;
    }
  } else {
    if (memberExpr.property.type === 'StringLiteral') {
      propertyName = memberExpr.property.value;
      mutationType = 'property';
    } else {
      propertyName = '<computed>';
      mutationType = 'computed';
      if (memberExpr.property.type === 'Identifier') {
        computedPropertyVar = memberExpr.property.name;
      }
    }
  }
  
  // Create mutation info with update metadata
  const line = updateNode.loc?.start.line ?? 0;
  const column = updateNode.loc?.start.column ?? 0;
  
  let mutationId: string | undefined;
  if (scopeTracker) {
    const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:${objectName}.${propertyName}:${updateNode.operator}`);
    mutationId = computeSemanticId('OBJECT_MUTATION', `${objectName}.${propertyName}`, scopeTracker.getContext(), { discriminator });
  }
  
  objectMutations.push({
    id: mutationId,
    objectName,
    enclosingClassName,
    propertyName,
    mutationType,
    computedPropertyVar,
    file: module.file,
    line,
    column,
    
    // REG-312: Update operation metadata
    updateOperator: updateNode.operator,
    updatePrefix: updateNode.prefix,
    
    // Value is implicit: +1 or -1
    value: {
      valueType: 'LITERAL',
      literalValue: 1  // Conceptually
    }
  });
}
```

### 5. collectArrayElementUpdate

Similar pattern for array mutations:

```typescript
private collectArrayElementUpdate(
  updateNode: t.UpdateExpression,
  memberExpr: t.MemberExpression,
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[]
): void {
  // Extract array name
  if (memberExpr.object.type !== 'Identifier') return;
  const arrayName = memberExpr.object.name;
  
  // Extract index
  if (memberExpr.property.type !== 'NumericLiteral') return;
  const index = memberExpr.property.value;
  
  // Create array mutation with update metadata
  arrayMutations.push({
    arrayName,
    index,
    file: module.file,
    line: updateNode.loc?.start.line ?? 0,
    column: updateNode.loc?.start.column ?? 0,
    
    // REG-312: Update operation metadata
    updateOperator: updateNode.operator,
    updatePrefix: updateNode.prefix,
    
    value: {
      valueType: 'LITERAL',
      literalValue: 1
    }
  });
}
```

### 6. Graph Edges

**No changes needed to GraphBuilder.**

Existing `bufferObjectMutationEdges` and `bufferArrayMutationEdges` will handle the new mutations.

The FLOWS_INTO edges will carry the mutation metadata:
```
VARIABLE(obj) --FLOWS_INTO--> VARIABLE(obj)  // self-loop (reads current value)
  mutationType: "property"
  propertyName: "count"
  updateOperator: "++"
  updatePrefix: false
```

**Wait, that's wrong.** FLOWS_INTO is for data flow between variables.

## ARCHITECTURAL PROBLEM DETECTED

### The Real Issue

Object mutations currently create **FLOWS_INTO** edges:
```
sourceVariable --FLOWS_INTO--> objectVariable
```

But `obj.prop++` doesn't have a source variable. It's:
```
obj.prop = obj.prop + 1
```

So it should be:
```
objectVariable --READS_FROM--> objectVariable  // self-loop
```

But that's what UPDATE_EXPRESSION does for variables!

### The Pattern Already Exists

REG-288 established:
```
i++ creates:
  - VARIABLE(i) --READS_FROM--> VARIABLE(i)  // self-loop
  - UPDATE_EXPRESSION --MODIFIES--> VARIABLE(i)
```

So for consistency:
```
obj.prop++ should create:
  - VARIABLE(obj) --READS_FROM--> VARIABLE(obj)  // self-loop
  - ??? --MODIFIES--> VARIABLE(obj)
```

**What is the ??? node?**

### The Missing Piece

We need a first-class node for property mutations, just like UPDATE_EXPRESSION is for variable updates.

**Option 1: Reuse UPDATE_EXPRESSION**
```
UPDATE_EXPRESSION(obj.prop++) --MODIFIES--> VARIABLE(obj)
  propertyName: "count"
  mutationType: "property"
```

**Option 2: New node type PROPERTY_UPDATE**
```
PROPERTY_UPDATE(obj.prop++) --MODIFIES--> VARIABLE(obj)
  propertyName: "count"
  operator: "++"
```

**Option 3: Don't create nodes, just edges**
```
VARIABLE(obj) --MUTATES_PROPERTY--> VARIABLE(obj)
  propertyName: "count"
  operator: "++"
```

## Decision Framework

Let's consult existing patterns:

1. **Variable update**: `i++` → UPDATE_EXPRESSION node + MODIFIES edge
2. **Property assignment**: `obj.prop = x` → FLOWS_INTO edge (no node)
3. **Array assignment**: `arr[0] = x` → FLOWS_INTO edge (no node)

So:
- Updates get nodes (UPDATE_EXPRESSION)
- Assignments get edges (FLOWS_INTO)

Therefore:
- Property updates should get... nodes? Or edges?

### The Semantic Test

Question: "What increments obj.count?"

Answer options:
- A: "An UPDATE_EXPRESSION at line 42"
- B: "A FLOWS_INTO edge from... wait, from what?"
- C: "The variable obj has a self-READS_FROM loop"

Only A makes sense.

### The Query Test

Query: `find_node('UPDATE_EXPRESSION', {variableName: 'count'})`

Expected results:
- `count++` ✓
- `obj.count++` ✓ or ✗?

If we want ✓, we need UPDATE_EXPRESSION nodes for member expressions.

But then `variableName: 'count'` is misleading (it's a property, not a variable).

### The Right Abstraction

**UPDATE_EXPRESSION should store the full expression being updated.**

Current (REG-288):
```typescript
{
  type: 'UPDATE_EXPRESSION',
  variableName: 'i',  // Just the identifier
  operator: '++',
  prefix: false
}
```

Extended (REG-312):
```typescript
{
  type: 'UPDATE_EXPRESSION',
  targetType: 'IDENTIFIER' | 'MEMBER_EXPRESSION',
  
  // For IDENTIFIER:
  variableName: 'i',
  
  // For MEMBER_EXPRESSION:
  objectName: 'obj',
  propertyName: 'count',
  mutationType: 'property' | 'computed',
  computedPropertyVar: 'key',  // For obj[key]++
  
  operator: '++',
  prefix: false
}
```

MODIFIES edge points to:
- IDENTIFIER: VARIABLE node
- MEMBER_EXPRESSION: VARIABLE node (the object)

This is clean, consistent, and queryable.

## Final Recommendation

### 1. Extend UpdateExpressionInfo Type

```typescript
// packages/core/src/plugins/analysis/ast/types.ts
export interface UpdateExpressionInfo {
  // Common fields
  operator: '++' | '--';
  prefix: boolean;
  file: string;
  line: number;
  column: number;
  parentScopeId?: string;
  
  // Target type discriminator
  targetType: 'IDENTIFIER' | 'MEMBER_EXPRESSION';
  
  // For IDENTIFIER (existing REG-288 behavior)
  variableName?: string;
  variableLine?: number;
  
  // For MEMBER_EXPRESSION (new REG-312)
  objectName?: string;
  objectLine?: number;
  enclosingClassName?: string;  // For this.prop++
  propertyName?: string;
  mutationType?: 'property' | 'computed';
  computedPropertyVar?: string;
}
```

### 2. Modify collectUpdateExpression

```typescript
private collectUpdateExpression(
  updateNode: t.UpdateExpression,
  module: VisitorModule,
  updateExpressions: UpdateExpressionInfo[],
  parentScopeId: string | undefined,
  scopeTracker?: ScopeTracker
): void {
  const operator = updateNode.operator as '++' | '--';
  const prefix = updateNode.prefix;
  const line = getLine(updateNode);
  const column = getColumn(updateNode);
  
  if (updateNode.argument.type === 'Identifier') {
    // Simple identifier: i++, --count (REG-288)
    const variableName = updateNode.argument.name;
    
    updateExpressions.push({
      targetType: 'IDENTIFIER',
      variableName,
      variableLine: getLine(updateNode.argument),
      operator,
      prefix,
      file: module.file,
      line,
      column,
      parentScopeId
    });
    
  } else if (updateNode.argument.type === 'MemberExpression') {
    // Member expression: obj.prop++, arr[i]++ (REG-312)
    const memberExpr = updateNode.argument;
    
    // Extract object name
    let objectName: string;
    let enclosingClassName: string | undefined;
    
    if (memberExpr.object.type === 'Identifier') {
      objectName = memberExpr.object.name;
    } else if (memberExpr.object.type === 'ThisExpression') {
      objectName = 'this';
      if (scopeTracker) {
        enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
      }
    } else {
      // Complex: obj.nested.prop++ (skip)
      return;
    }
    
    // Extract property name
    let propertyName: string;
    let mutationType: 'property' | 'computed';
    let computedPropertyVar: string | undefined;
    
    if (!memberExpr.computed) {
      if (memberExpr.property.type === 'Identifier') {
        propertyName = memberExpr.property.name;
        mutationType = 'property';
      } else {
        return;
      }
    } else {
      if (memberExpr.property.type === 'StringLiteral') {
        propertyName = memberExpr.property.value;
        mutationType = 'property';
      } else {
        propertyName = '<computed>';
        mutationType = 'computed';
        if (memberExpr.property.type === 'Identifier') {
          computedPropertyVar = memberExpr.property.name;
        }
      }
    }
    
    updateExpressions.push({
      targetType: 'MEMBER_EXPRESSION',
      objectName,
      objectLine: getLine(memberExpr.object),
      enclosingClassName,
      propertyName,
      mutationType,
      computedPropertyVar,
      operator,
      prefix,
      file: module.file,
      line,
      column,
      parentScopeId
    });
  }
}
```

### 3. Modify bufferUpdateExpressionEdges (GraphBuilder)

```typescript
private bufferUpdateExpressionEdges(
  updateExpressions: UpdateExpressionInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[],
  classDeclarations: ClassDeclarationInfo[]  // Add for this.prop++
): void {
  // Build lookup caches
  const varLookup = new Map<string, VariableDeclarationInfo>();
  for (const v of variableDeclarations) {
    varLookup.set(`${v.file}:${v.name}`, v);
  }
  
  const paramLookup = new Map<string, ParameterInfo>();
  for (const p of parameters) {
    paramLookup.set(`${p.file}:${p.name}`, p);
  }
  
  for (const update of updateExpressions) {
    if (update.targetType === 'IDENTIFIER') {
      // REG-288: Simple identifier (existing logic)
      this.bufferIdentifierUpdate(update, varLookup, paramLookup);
      
    } else if (update.targetType === 'MEMBER_EXPRESSION') {
      // REG-312: Member expression
      this.bufferMemberExpressionUpdate(update, varLookup, paramLookup, classDeclarations);
    }
  }
}

private bufferIdentifierUpdate(
  update: UpdateExpressionInfo,
  varLookup: Map<string, VariableDeclarationInfo>,
  paramLookup: Map<string, ParameterInfo>
): void {
  // Existing REG-288 logic (extracted for clarity)
  const targetVar = varLookup.get(`${update.file}:${update.variableName}`);
  const targetParam = !targetVar ? paramLookup.get(`${update.file}:${update.variableName}`) : null;
  const targetNodeId = targetVar?.id ?? targetParam?.id;
  
  if (!targetNodeId) return;
  
  const updateId = `${update.file}:UPDATE_EXPRESSION:${update.operator}:${update.line}:${update.column}`;
  
  this._bufferNode({
    type: 'UPDATE_EXPRESSION',
    id: updateId,
    name: `${update.prefix ? update.operator : ''}${update.variableName}${update.prefix ? '' : update.operator}`,
    targetType: 'IDENTIFIER',
    operator: update.operator,
    prefix: update.prefix,
    variableName: update.variableName,
    file: update.file,
    line: update.line,
    column: update.column
  });
  
  this._bufferEdge({
    type: 'READS_FROM',
    src: targetNodeId,
    dst: targetNodeId
  });
  
  this._bufferEdge({
    type: 'MODIFIES',
    src: updateId,
    dst: targetNodeId
  });
  
  if (update.parentScopeId) {
    this._bufferEdge({
      type: 'CONTAINS',
      src: update.parentScopeId,
      dst: updateId
    });
  }
}

private bufferMemberExpressionUpdate(
  update: UpdateExpressionInfo,
  varLookup: Map<string, VariableDeclarationInfo>,
  paramLookup: Map<string, ParameterInfo>,
  classDeclarations: ClassDeclarationInfo[]
): void {
  // Find target object node
  let objectNodeId: string | null = null;
  
  if (update.objectName !== 'this') {
    // Regular object
    const targetVar = varLookup.get(`${update.file}:${update.objectName}`);
    const targetParam = !targetVar ? paramLookup.get(`${update.file}:${update.objectName}`) : null;
    objectNodeId = targetVar?.id ?? targetParam?.id ?? null;
  } else {
    // this.prop++ (follow REG-152 pattern)
    if (!update.enclosingClassName) return;
    
    const fileBasename = basename(update.file);
    const classDecl = classDeclarations.find(c => 
      c.name === update.enclosingClassName && c.file === fileBasename
    );
    objectNodeId = classDecl?.id ?? null;
  }
  
  if (!objectNodeId) return;
  
  // Create UPDATE_EXPRESSION node
  const updateId = `${update.file}:UPDATE_EXPRESSION:${update.operator}:${update.line}:${update.column}`;
  
  const displayName = update.objectName === 'this' 
    ? `this.${update.propertyName}${update.prefix ? '' : update.operator}`
    : `${update.objectName}.${update.propertyName}${update.prefix ? '' : update.operator}`;
  
  this._bufferNode({
    type: 'UPDATE_EXPRESSION',
    id: updateId,
    name: displayName,
    targetType: 'MEMBER_EXPRESSION',
    operator: update.operator,
    prefix: update.prefix,
    objectName: update.objectName,
    propertyName: update.propertyName,
    mutationType: update.mutationType,
    computedPropertyVar: update.computedPropertyVar,
    file: update.file,
    line: update.line,
    column: update.column
  });
  
  // Create READS_FROM self-loop (object reads from itself)
  this._bufferEdge({
    type: 'READS_FROM',
    src: objectNodeId,
    dst: objectNodeId
  });
  
  // Create MODIFIES edge
  this._bufferEdge({
    type: 'MODIFIES',
    src: updateId,
    dst: objectNodeId
  });
  
  // Create CONTAINS edge
  if (update.parentScopeId) {
    this._bufferEdge({
      type: 'CONTAINS',
      src: update.parentScopeId,
      dst: updateId
    });
  }
}
```

## Implementation Steps

1. **Type changes** (types.ts)
   - Add `targetType` discriminator
   - Add member expression fields
   
2. **Collection changes** (JSASTAnalyzer.ts)
   - Extend `collectUpdateExpression` to handle MemberExpression
   - Extract object name, property name (reuse detectObjectPropertyAssignment logic)
   
3. **Graph building changes** (GraphBuilder.ts)
   - Split `bufferUpdateExpressionEdges` into IDENTIFIER and MEMBER_EXPRESSION paths
   - Add classDeclarations parameter for this.prop++
   
4. **Tests** (UpdateExpression.test.js)
   - Add cases for obj.prop++
   - Add cases for arr[i]++
   - Add cases for this.prop++
   - Add cases for obj[key]++ (computed)
   - Verify MODIFIES edges point to object VARIABLE
   - Verify READS_FROM self-loops exist

## Alignment with Existing Patterns

- **REG-288**: Established UPDATE_EXPRESSION nodes for variable updates
- **REG-152**: Established this.prop mutation tracking with enclosingClassName
- **Object mutations**: Established property/computed/assign mutationType vocabulary
- **Compound operators**: Established READS_FROM self-loops for read-modify-write

This solution:
- ✓ Extends UPDATE_EXPRESSION consistently
- ✓ Reuses mutation metadata patterns
- ✓ Follows this-handling from REG-152
- ✓ Preserves read-before-write semantics with self-loops

## Architectural Concerns

### 1. Scope Resolution

Same limitation as object mutations (documented in bufferObjectMutationEdges):
```
CURRENT LIMITATION: Uses file-level variable lookup, not scope-aware.
Shadowed variables in nested scopes will incorrectly resolve to outer scope variable.
```

This affects `obj.prop++` the same way it affects `obj.prop = value`.

**Resolution**: Accept limitation for now, fix in future scope-aware refactoring.

### 2. Chained Access

`obj.nested.prop++` is currently skipped (just like `obj.nested.prop = value`).

Reason: `memberExpr.object.type` would be `MemberExpression`, not `Identifier`.

**Resolution**: Accept limitation, document it, consider for future enhancement.

### 3. Array vs Object Ambiguity

`arr[0]++` - is this array or object?

Current object mutation handler:
```typescript
if (memberExpr.computed && memberExpr.property.type === 'NumericLiteral') {
  return; // Let array mutation handler deal with this
}
```

**Resolution**: Follow same pattern. Numeric literal index = array mutation.

### 4. Query Interface

How do users query these?

```javascript
// Find all increments of any property named 'count'
find_node('UPDATE_EXPRESSION', {propertyName: 'count'})

// Find all updates to object 'obj'
find_edges({dst: 'obj_variable_id', type: 'MODIFIES'}).src

// Find what obj.count reads from
find_edges({src: 'obj_variable_id', type: 'READS_FROM'})
```

**Resolution**: Existing query interface already supports this.

## Conclusion

**This is the RIGHT thing to do.**

Member expression updates belong in UPDATE_EXPRESSION nodes because:
1. They ARE update expressions (++ and --)
2. Users query by operation semantics, not AST details
3. Consistent with REG-288 pattern (operation → node)
4. Enables precise "what increments this?" queries

The discriminated union (`targetType`) keeps identifier and member expression paths clear while sharing the common "update operation" semantic.

**No architectural compromises. No hacks. Just proper extension of existing pattern.**

## Test Coverage Required

From acceptance criteria + edge cases:

1. **Basic property update**: `obj.prop++`, `--obj.prop`
2. **Array element update**: `arr[0]++`, `--arr[5]`
3. **Computed property**: `obj[key]++`, `arr[i]++`
4. **This reference**: `this.count++` (in class method)
5. **Prefix vs postfix**: Verify both captured correctly
6. **Edge verification**:
   - UPDATE_EXPRESSION --MODIFIES--> VARIABLE(obj)
   - VARIABLE(obj) --READS_FROM--> VARIABLE(obj)
   - SCOPE --CONTAINS--> UPDATE_EXPRESSION
7. **Skip cases**:
   - Chained access: `obj.nested.prop++` (not tracked)
   - Complex object: `(obj || fallback).prop++` (not tracked)

Estimated: 15-20 test cases
