# Joel Spolsky Technical Plan: REG-312 - Track Member Expression Updates

## Executive Summary

Extending UPDATE_EXPRESSION support from simple identifiers (REG-288) to member expressions (obj.prop++, arr[i]++). Don's architectural decision: **extend UpdateExpressionInfo with discriminated union pattern** to handle both identifier and member expression targets.

This maintains semantic consistency: all increment/decrement operations create UPDATE_EXPRESSION nodes, regardless of whether they target variables or properties.

## Implementation Overview

**Three-file change:**
1. **types.ts** - Extend UpdateExpressionInfo interface with discriminated union
2. **JSASTAnalyzer.ts** - Extend collectUpdateExpression to handle MemberExpression
3. **GraphBuilder.ts** - Split bufferUpdateExpressionEdges into two paths

**Test file:**
- Create `test/unit/UpdateExpressionMember.test.js` with 15-20 test cases

## Part 1: Type Changes (types.ts)

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/types.ts`

**Current UpdateExpressionInfo (from REG-288):**
```typescript
export interface UpdateExpressionInfo {
  variableName: string;           // Name of variable being modified
  variableLine: number;           // Line where variable is referenced
  operator: '++' | '--';          // Increment or decrement
  prefix: boolean;                // ++i (true) vs i++ (false)
  file: string;
  line: number;                   // Line of update expression
  column: number;
  parentScopeId?: string;         // Containing scope for CONTAINS edge
}
```

**New UpdateExpressionInfo (REG-312):**

Replace the current interface (search for `export interface UpdateExpressionInfo`) with:

```typescript
export interface UpdateExpressionInfo {
  // Common fields for all update expressions
  operator: '++' | '--';          // Increment or decrement
  prefix: boolean;                // ++i (true) vs i++ (false)
  file: string;
  line: number;                   // Line of update expression
  column: number;
  parentScopeId?: string;         // Containing scope for CONTAINS edge

  // Discriminator: IDENTIFIER (i++) vs MEMBER_EXPRESSION (obj.prop++)
  targetType: 'IDENTIFIER' | 'MEMBER_EXPRESSION';

  // ===== IDENTIFIER fields (REG-288 behavior) =====
  variableName?: string;          // Name of variable being modified (for i++)
  variableLine?: number;          // Line where variable is referenced

  // ===== MEMBER_EXPRESSION fields (REG-312 new) =====
  objectName?: string;            // Object name ("obj" from obj.prop++, "this" from this.count++)
  objectLine?: number;            // Line where object is referenced (for scope resolution)
  enclosingClassName?: string;    // Class name when objectName === 'this' (follows REG-152 pattern)
  propertyName?: string;          // Property name ("prop" from obj.prop++, "<computed>" for obj[key]++)
  mutationType?: 'property' | 'computed';  // 'property' for obj.prop++, 'computed' for obj[key]++
  computedPropertyVar?: string;   // Variable name for computed access: obj[i]++ -> "i"
}
```

**Location:** Around line 656 in types.ts (after VariableReassignmentInfo, before CounterRef)

**Notes:**
- All fields except `operator`, `prefix`, `file`, `line`, `column`, `targetType` are optional
- For `targetType: 'IDENTIFIER'`: variableName and variableLine must be set
- For `targetType: 'MEMBER_EXPRESSION'`: objectName, propertyName, mutationType must be set
- Pattern mirrors ObjectMutationInfo structure (reuses mutation vocabulary)

## Part 2: Collection Changes (JSASTAnalyzer.ts)

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

### 2.1: Modify collectUpdateExpression Method

**Current location:** Search for `private collectUpdateExpression(`

**Current code (REG-288):**
```typescript
private collectUpdateExpression(
  updateNode: t.UpdateExpression,
  module: VisitorModule,
  updateExpressions: UpdateExpressionInfo[],
  parentScopeId: string | undefined
): void {
  // Only handle simple identifiers (i++, --count)
  // Ignore member expressions (obj.prop++, arr[i]++) - will be handled separately
  if (updateNode.argument.type !== 'Identifier') {
    return;
  }

  const variableName = updateNode.argument.name;
  const operator = updateNode.operator as '++' | '--';
  const prefix = updateNode.prefix;
  const line = getLine(updateNode);
  const column = getColumn(updateNode);

  updateExpressions.push({
    variableName,
    variableLine: getLine(updateNode.argument),
    operator,
    prefix,
    file: module.file,
    line,
    column,
    parentScopeId
  });
}
```

**New implementation (REG-312):**

Replace entire method with:

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

  // CASE 1: Simple identifier (i++, --count) - REG-288 behavior
  if (updateNode.argument.type === 'Identifier') {
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
    return;
  }

  // CASE 2: Member expression (obj.prop++, arr[i]++) - REG-312 new
  if (updateNode.argument.type === 'MemberExpression') {
    const memberExpr = updateNode.argument;

    // Extract object name (reuses detectObjectPropertyAssignment pattern)
    let objectName: string;
    let enclosingClassName: string | undefined;

    if (memberExpr.object.type === 'Identifier') {
      objectName = memberExpr.object.name;
    } else if (memberExpr.object.type === 'ThisExpression') {
      objectName = 'this';
      // REG-152: Extract enclosing class name from scope context
      if (scopeTracker) {
        enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
      }
    } else {
      // Complex expressions: obj.nested.prop++, (obj || fallback).count++
      // Skip for now (documented limitation, same as detectObjectPropertyAssignment)
      return;
    }

    // Extract property name (reuses detectObjectPropertyAssignment pattern)
    let propertyName: string;
    let mutationType: 'property' | 'computed';
    let computedPropertyVar: string | undefined;

    if (!memberExpr.computed) {
      // obj.prop++
      if (memberExpr.property.type === 'Identifier') {
        propertyName = memberExpr.property.name;
        mutationType = 'property';
      } else {
        return; // Unexpected property type
      }
    } else {
      // obj['prop']++ or obj[key]++
      if (memberExpr.property.type === 'StringLiteral') {
        // obj['prop']++ - static string
        propertyName = memberExpr.property.value;
        mutationType = 'property';
      } else {
        // obj[key]++, arr[i]++ - computed property
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

**Key changes:**
1. Added `scopeTracker?: ScopeTracker` parameter (needed for this.prop++ class resolution)
2. Removed early return for non-Identifier - now handles MemberExpression
3. Structured as two clear cases with targetType discriminator
4. Reuses exact pattern from detectObjectPropertyAssignment (lines 3813-3900)
5. Same limitations: skips complex expressions like obj.nested.prop++

### 2.2: Update Module-Level Call Sites

**Location 1:** Search for `traverse_updates` (module-level updates)

**Current code:**
```typescript
this.collectUpdateExpression(updatePath.node, module, updateExpressions, undefined);
```

**New code:**
```typescript
this.collectUpdateExpression(updatePath.node, module, updateExpressions, undefined, scopeTracker);
```

**Location 2:** Search for `UpdateExpression:` in analyzeFunctionBody (function-level updates)

**Current code:**
```typescript
this.collectUpdateExpression(updatePath.node, module, funcUpdateExpressions, getCurrentScopeId());
```

**New code:**
```typescript
this.collectUpdateExpression(updatePath.node, module, funcUpdateExpressions, getCurrentScopeId(), scopeTracker);
```

**Note:** Must pass scopeTracker to both call sites for this.prop++ support.

## Part 3: Graph Building Changes (GraphBuilder.ts)

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### 3.1: Modify bufferUpdateExpressionEdges Method

**Current location:** Search for `private bufferUpdateExpressionEdges(`

**Current signature:**
```typescript
private bufferUpdateExpressionEdges(
  updateExpressions: UpdateExpressionInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[]
): void
```

**New signature (add classDeclarations):**
```typescript
private bufferUpdateExpressionEdges(
  updateExpressions: UpdateExpressionInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[],
  classDeclarations: ClassDeclarationInfo[]  // NEW: for this.prop++ resolution
): void
```

**Current implementation strategy:**
- Single loop through updateExpressions
- Assumes all are IDENTIFIER targets
- Creates UPDATE_EXPRESSION node + MODIFIES + READS_FROM edges

**New implementation strategy:**
- Split into two helper methods: bufferIdentifierUpdate and bufferMemberExpressionUpdate
- Main method dispatches based on targetType
- Reuse lookup caches across both paths

**New implementation:**

Replace entire method body with:

```typescript
private bufferUpdateExpressionEdges(
  updateExpressions: UpdateExpressionInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[],
  classDeclarations: ClassDeclarationInfo[]
): void {
  // Build lookup caches: O(n) instead of O(n*m)
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
      // REG-288: Simple identifier (i++, --count)
      this.bufferIdentifierUpdate(update, varLookup, paramLookup);
    } else if (update.targetType === 'MEMBER_EXPRESSION') {
      // REG-312: Member expression (obj.prop++, arr[i]++)
      this.bufferMemberExpressionUpdate(update, varLookup, paramLookup, classDeclarations);
    }
  }
}
```

### 3.2: Extract bufferIdentifierUpdate Helper

**Add new private method** (after bufferUpdateExpressionEdges):

```typescript
/**
 * Buffer UPDATE_EXPRESSION node and edges for simple identifier updates (i++, --count)
 * REG-288: Original implementation extracted for clarity
 */
private bufferIdentifierUpdate(
  update: UpdateExpressionInfo,
  varLookup: Map<string, VariableDeclarationInfo>,
  paramLookup: Map<string, ParameterInfo>
): void {
  const {
    variableName,
    operator,
    prefix,
    file,
    line,
    column,
    parentScopeId
  } = update;

  // Find target variable node
  const targetVar = varLookup.get(`${file}:${variableName}`);
  const targetParam = !targetVar ? paramLookup.get(`${file}:${variableName}`) : null;
  const targetNodeId = targetVar?.id ?? targetParam?.id;

  if (!targetNodeId) {
    // Variable not found - could be module-level or external reference
    return;
  }

  // Create UPDATE_EXPRESSION node
  const updateId = `${file}:UPDATE_EXPRESSION:${operator}:${line}:${column}`;

  this._bufferNode({
    type: 'UPDATE_EXPRESSION',
    id: updateId,
    name: `${prefix ? operator : ''}${variableName}${prefix ? '' : operator}`,
    targetType: 'IDENTIFIER',  // NEW: discriminator field
    operator,
    prefix,
    variableName,
    file,
    line,
    column
  });

  // Create READS_FROM self-loop
  this._bufferEdge({
    type: 'READS_FROM',
    src: targetNodeId,
    dst: targetNodeId
  });

  // Create MODIFIES edge
  this._bufferEdge({
    type: 'MODIFIES',
    src: updateId,
    dst: targetNodeId
  });

  // Create CONTAINS edge
  if (parentScopeId) {
    this._bufferEdge({
      type: 'CONTAINS',
      src: parentScopeId,
      dst: updateId
    });
  }
}
```

**Key change:** Added `targetType: 'IDENTIFIER'` to node buffer (line 18 in snippet above)

### 3.3: Add bufferMemberExpressionUpdate Helper

**Add new private method** (after bufferIdentifierUpdate):

```typescript
/**
 * Buffer UPDATE_EXPRESSION node and edges for member expression updates (obj.prop++, arr[i]++)
 * REG-312: New implementation for member expression targets
 *
 * Creates:
 * - UPDATE_EXPRESSION node with member expression metadata
 * - MODIFIES edge: UPDATE_EXPRESSION -> VARIABLE(object)
 * - READS_FROM self-loop: VARIABLE(object) -> VARIABLE(object)
 * - CONTAINS edge: SCOPE -> UPDATE_EXPRESSION
 */
private bufferMemberExpressionUpdate(
  update: UpdateExpressionInfo,
  varLookup: Map<string, VariableDeclarationInfo>,
  paramLookup: Map<string, ParameterInfo>,
  classDeclarations: ClassDeclarationInfo[]
): void {
  const {
    objectName,
    propertyName,
    mutationType,
    computedPropertyVar,
    enclosingClassName,
    operator,
    prefix,
    file,
    line,
    column,
    parentScopeId
  } = update;

  // Find target object node
  let objectNodeId: string | null = null;

  if (objectName !== 'this') {
    // Regular object: obj.prop++, arr[i]++
    const targetVar = varLookup.get(`${file}:${objectName}`);
    const targetParam = !targetVar ? paramLookup.get(`${file}:${objectName}`) : null;
    objectNodeId = targetVar?.id ?? targetParam?.id ?? null;
  } else {
    // this.prop++ - follow REG-152 pattern from bufferObjectMutationEdges
    if (!enclosingClassName) return;

    const fileBasename = basename(file);
    const classDecl = classDeclarations.find(c =>
      c.name === enclosingClassName && c.file === fileBasename
    );
    objectNodeId = classDecl?.id ?? null;
  }

  if (!objectNodeId) {
    // Object not found - external reference or scope issue
    return;
  }

  // Create UPDATE_EXPRESSION node
  const updateId = `${file}:UPDATE_EXPRESSION:${operator}:${line}:${column}`;

  // Display name: "obj.prop++" or "this.count++" or "arr[i]++"
  const displayName = (() => {
    if (objectName === 'this') {
      return `this.${propertyName}${prefix ? '' : operator}`;
    }
    if (mutationType === 'computed') {
      const computedPart = computedPropertyVar || '?';
      return `${objectName}[${computedPart}]${prefix ? '' : operator}`;
    }
    return `${objectName}.${propertyName}${prefix ? '' : operator}`;
  })();

  this._bufferNode({
    type: 'UPDATE_EXPRESSION',
    id: updateId,
    name: displayName,
    targetType: 'MEMBER_EXPRESSION',  // Discriminator
    operator,
    prefix,
    objectName,
    propertyName,
    mutationType,
    computedPropertyVar,
    file,
    line,
    column
  });

  // Create READS_FROM self-loop (object reads from itself)
  this._bufferEdge({
    type: 'READS_FROM',
    src: objectNodeId,
    dst: objectNodeId
  });

  // Create MODIFIES edge (UPDATE_EXPRESSION modifies object)
  this._bufferEdge({
    type: 'MODIFIES',
    src: updateId,
    dst: objectNodeId
  });

  // Create CONTAINS edge
  if (parentScopeId) {
    this._bufferEdge({
      type: 'CONTAINS',
      src: parentScopeId,
      dst: updateId
    });
  }
}
```

**Notes:**
- Follows REG-152 pattern for this.prop++ (uses basename, looks up class)
- Display name shows property access: "obj.prop++" not just "obj++"
- MODIFIES edge points to object VARIABLE (not property)
- READS_FROM self-loop on object (reads current property value before increment)
- Pattern matches bufferObjectMutationEdges structure

### 3.4: Update Call Site

**Location:** Search for `this.bufferUpdateExpressionEdges` in `build()` method

**Current code:**
```typescript
this.bufferUpdateExpressionEdges(updateExpressions, variableDeclarations, parameters);
```

**New code:**
```typescript
this.bufferUpdateExpressionEdges(updateExpressions, variableDeclarations, parameters, classDeclarations);
```

**Note:** Must add classDeclarations parameter to support this.prop++ resolution.

### 3.5: Import basename

**Add to imports at top of file:**

```typescript
import { basename } from 'node:path';
```

**Check if already imported** - it's used in bufferObjectMutationEdges, so likely already there.

## Part 4: Testing (New Test File)

**File:** Create `/Users/vadimr/grafema-worker-4/test/unit/UpdateExpressionMember.test.js`

**Test structure:** 15-20 test cases covering:

### Test Categories

**4.1: Basic Member Expression Updates (5 tests)**
1. Postfix property update: `obj.count++`
2. Prefix property update: `++obj.count`
3. Decrement property: `obj.count--`, `--obj.count`
4. Verify UPDATE_EXPRESSION node fields (targetType, objectName, propertyName, mutationType)
5. Verify edges: UPDATE_EXPRESSION --MODIFIES--> VARIABLE(obj), VARIABLE(obj) --READS_FROM--> VARIABLE(obj)

**4.2: Computed Property Updates (3 tests)**
1. Array index: `arr[0]++`
2. Variable index: `arr[i]++`
3. String literal index: `obj['key']++`
4. Verify mutationType: 'computed', computedPropertyVar populated

**4.3: This Reference Updates (3 tests)**
1. Class method: `this.counter++`
2. Verify MODIFIES points to CLASS node
3. Verify enclosingClassName captured

**4.4: Scope Integration (3 tests)**
1. Module-level: `obj.count++` at top level
2. Function-level: inside function body
3. Nested scope: inside if statement
4. Verify SCOPE --CONTAINS--> UPDATE_EXPRESSION chain

**4.5: Edge Cases (3 tests)**
1. Chained access skipped: `obj.nested.prop++` (should NOT create node)
2. Complex object skipped: `(obj || fallback).count++`
3. Mixed with identifier updates: both `i++` and `obj.i++` in same file

**4.6: Real-World Patterns (3 tests)**
1. For-loop with array element: `for (let i = 0; i < 10; i++) arr[i]++`
2. Counter in object literal: `const stats = { hits: 0 }; stats.hits++`
3. Multiple properties on same object: `obj.a++; obj.b++; obj.c++`

**Test template structure:**

```javascript
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestGraph, parseCode } from '../helpers/test-utils.js';

describe('UpdateExpression - Member Expressions (REG-312)', () => {
  test('obj.prop++ creates UPDATE_EXPRESSION with MEMBER_EXPRESSION target', async () => {
    const code = `
      const obj = { count: 0 };
      obj.count++;
    `;

    const graph = await createTestGraph(code);

    // Find UPDATE_EXPRESSION node
    const updateNodes = await graph.find_node('UPDATE_EXPRESSION');
    assert.equal(updateNodes.length, 1, 'Should create one UPDATE_EXPRESSION node');

    const updateNode = updateNodes[0];
    assert.equal(updateNode.targetType, 'MEMBER_EXPRESSION');
    assert.equal(updateNode.objectName, 'obj');
    assert.equal(updateNode.propertyName, 'count');
    assert.equal(updateNode.mutationType, 'property');
    assert.equal(updateNode.operator, '++');
    assert.equal(updateNode.prefix, false);

    // Find MODIFIES edge
    const modifiesEdges = await graph.find_edges({ type: 'MODIFIES', src: updateNode.id });
    assert.equal(modifiesEdges.length, 1, 'Should have MODIFIES edge');

    // Find target object VARIABLE
    const objVar = await graph.find_node('VARIABLE', { name: 'obj' });
    assert.equal(modifiesEdges[0].dst, objVar[0].id, 'MODIFIES should point to obj variable');

    // Verify READS_FROM self-loop
    const readsFromEdges = await graph.find_edges({
      type: 'READS_FROM',
      src: objVar[0].id,
      dst: objVar[0].id
    });
    assert.equal(readsFromEdges.length, 1, 'Should have READS_FROM self-loop on obj');
  });

  // ... 14-19 more tests following similar pattern
});
```

**Pattern reference:** Look at `test/unit/UpdateExpression.test.js` (REG-288 tests) for structure

## Part 5: Implementation Checklist

### Phase 1: Types
- [ ] Modify UpdateExpressionInfo in types.ts
- [ ] Add targetType discriminator
- [ ] Add member expression fields (objectName, propertyName, mutationType, etc.)
- [ ] Verify TypeScript compilation: `npm run build`

### Phase 2: Collection
- [ ] Modify collectUpdateExpression signature (add scopeTracker parameter)
- [ ] Implement IDENTIFIER case (extract existing code, add targetType)
- [ ] Implement MEMBER_EXPRESSION case (reuse detectObjectPropertyAssignment pattern)
- [ ] Update module-level call site (pass scopeTracker)
- [ ] Update function-level call site (pass scopeTracker)
- [ ] Verify TypeScript compilation

### Phase 3: Graph Building
- [ ] Modify bufferUpdateExpressionEdges signature (add classDeclarations)
- [ ] Rewrite main method to dispatch by targetType
- [ ] Extract bufferIdentifierUpdate (add targetType to node)
- [ ] Implement bufferMemberExpressionUpdate (follow REG-152 pattern)
- [ ] Update call site in build() method
- [ ] Verify basename import exists
- [ ] Verify TypeScript compilation

### Phase 4: Testing
- [ ] Create test/unit/UpdateExpressionMember.test.js
- [ ] Write 5 basic tests (obj.prop++, --obj.prop, node/edge verification)
- [ ] Write 3 computed property tests (arr[i]++, obj[key]++)
- [ ] Write 3 this reference tests (this.count++ in class)
- [ ] Write 3 scope integration tests (module/function/nested)
- [ ] Write 3 edge case tests (chained access, complex object, mixed)
- [ ] Write 3 real-world pattern tests (for-loop, object literal, multiple properties)
- [ ] Run tests: `node --test test/unit/UpdateExpressionMember.test.js`
- [ ] All tests pass

### Phase 5: Integration Verification
- [ ] Run full test suite: `npm test`
- [ ] No regressions in existing UPDATE_EXPRESSION tests (REG-288)
- [ ] Run grafema analyze on test fixture
- [ ] Verify UPDATE_EXPRESSION nodes appear for member expressions
- [ ] Verify MODIFIES edges point to correct objects
- [ ] Verify READS_FROM self-loops exist

## Expected Results

**Before (REG-288):**
```javascript
i++;  // ✓ Creates UPDATE_EXPRESSION
obj.count++;  // ✗ Skipped
```

**After (REG-312):**
```javascript
i++;  // ✓ Creates UPDATE_EXPRESSION (targetType: 'IDENTIFIER')
obj.count++;  // ✓ Creates UPDATE_EXPRESSION (targetType: 'MEMBER_EXPRESSION')
```

**Graph structure for `obj.count++`:**
```
Nodes:
- VARIABLE(obj)
- UPDATE_EXPRESSION(obj.count++) {
    targetType: 'MEMBER_EXPRESSION',
    objectName: 'obj',
    propertyName: 'count',
    mutationType: 'property',
    operator: '++',
    prefix: false
  }

Edges:
- UPDATE_EXPRESSION --MODIFIES--> VARIABLE(obj)
- VARIABLE(obj) --READS_FROM--> VARIABLE(obj)  // self-loop
- SCOPE --CONTAINS--> UPDATE_EXPRESSION
```

## Known Limitations (Documented, Not Blocking)

1. **Chained access:** `obj.nested.prop++` - skipped (same as detectObjectPropertyAssignment)
2. **Complex object expressions:** `(obj || fallback).count++` - skipped
3. **Scope resolution:** Uses file-level variable lookup, not scope-aware (existing limitation)

These are architectural limitations that affect object mutations broadly, not specific to REG-312. Will be addressed in future scope-aware refactoring.

## Alignment with Existing Patterns

✓ **REG-288:** Extends UPDATE_EXPRESSION pattern with discriminated union
✓ **REG-152:** Reuses this.prop handling with enclosingClassName
✓ **Object mutations:** Reuses mutation vocabulary (mutationType, computedPropertyVar)
✓ **detectObjectPropertyAssignment:** Same property extraction logic
✓ **Compound assignments:** Same READS_FROM self-loop pattern

**No architectural compromises. Clean extension of existing patterns.**

## Estimated Effort

- **Types:** 10 minutes
- **Collection:** 30 minutes
- **Graph Building:** 45 minutes
- **Testing:** 90 minutes
- **Integration/Debug:** 30 minutes

**Total:** ~3.5 hours for complete implementation and testing.

## Success Criteria (from Linear REG-312)

1. ✓ `obj.prop++` creates UPDATE_EXPRESSION node
2. ✓ `arr[i]++` creates UPDATE_EXPRESSION node
3. ✓ `this.count++` in class creates UPDATE_EXPRESSION node
4. ✓ UPDATE_EXPRESSION --MODIFIES--> VARIABLE(object) edge
5. ✓ VARIABLE(object) --READS_FROM--> VARIABLE(object) self-loop
6. ✓ All existing tests pass (no regressions)
7. ✓ 15+ new tests covering all cases

---

**Ready for Kent Beck (tests) and Rob Pike (implementation).**
