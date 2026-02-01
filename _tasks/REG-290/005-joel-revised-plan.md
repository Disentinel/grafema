# Joel Spolsky - Revised Technical Implementation Plan for REG-290

**Date**: 2026-02-01
**Author**: Joel Spolsky (Implementation Planner)
**Based on**:
- Don Melton's High-Level Plan (002-don-plan.md)
- Linus Torvalds' Review (004-linus-plan-review.md)

---

## Executive Summary

This revised plan addresses all critical issues raised by Linus. The core changes:

1. **No deferred functionality**: Literal and expression node creation happens IN Phase 1, not "later"
2. **Complete metadata capture**: VariableReassignmentInfo includes all necessary fields for node creation
3. **READS_FROM edges**: Compound operators create self-loop to model read-before-write semantics
4. **No continue statements**: Every value type is handled inline in bufferVariableReassignmentEdges
5. **Simplified phases**: No artificial "Phase 1.5" splits - do it right the first time

**Key Decision**: Use FLOWS_INTO edges (like existing mutation tracking) + READS_FROM self-loops for compound operators.

---

## Changes from Previous Plan

### Critical Fixes

1. **Literal handling** (was line 329-332):
   - **Before**: `continue;` statement - deferred to "Phase 1.5"
   - **After**: Inline node creation using stored `literalValue` metadata

2. **Expression handling** (was line 350-354):
   - **Before**: `continue;` statement - deferred as "complex case"
   - **After**: Inline node creation using stored expression metadata

3. **READS_FROM edges** (was out-of-scope):
   - **Before**: Deferred to future work
   - **After**: Created in Phase 1 for compound operators (self-loop pattern)

4. **VariableReassignmentInfo interface** (was incomplete):
   - **Before**: Only had `operator` field
   - **After**: Includes `literalValue`, `expressionType`, `expressionMetadata`

5. **Phase structure** (was artificially split):
   - **Before**: Phase 1 (partial) → Phase 1.5 (literals) → Phase 2 (compound)
   - **After**: Phase 1 (complete functionality) → Phase 2 (metadata enhancement)

---

## Updated Data Structures

### VariableReassignmentInfo Interface

**Location**: `/packages/core/src/plugins/analysis/ast/types.ts` (after VariableAssignmentInfo)

```typescript
/**
 * Tracks variable reassignments for FLOWS_INTO edge creation.
 * Used when a variable is assigned AFTER its declaration: x = y (not const x = y).
 *
 * Edge direction: value --FLOWS_INTO--> variable
 *
 * Supports:
 * - Simple assignment: x = y
 * - Compound operators: x += y, x -= y, x *= y, x /= y, x %= y, x **= y
 * - Bitwise operators: x &= y, x |= y, x ^= y, x <<= y, x >>= y, x >>>= y
 * - Logical operators: x &&= y, x ||= y, x ??= y
 *
 * For compound operators (operator !== '='), creates TWO edges:
 * - READS_FROM: variable --READS_FROM--> variable (self-loop, reads current value)
 * - FLOWS_INTO: source --FLOWS_INTO--> variable (writes new value)
 *
 * Distinction from VariableAssignmentInfo:
 * - VariableAssignmentInfo: initialization (const x = y) -> ASSIGNED_FROM edge
 * - VariableReassignmentInfo: mutation (x = y, x += y) -> FLOWS_INTO edge
 */
export interface VariableReassignmentInfo {
  variableName: string;           // Name of variable being reassigned
  variableLine: number;           // Line where variable is referenced on LHS
  valueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION';
  valueName?: string;             // For VARIABLE, CALL_SITE types
  valueId?: string | null;        // For LITERAL, EXPRESSION types
  callLine?: number;              // For CALL_SITE, METHOD_CALL types
  callColumn?: number;
  operator: string;               // '=', '+=', '-=', '*=', etc.

  // NEW: For LITERAL type - complete metadata for node creation
  literalValue?: unknown;         // Actual literal value (number, string, boolean, null)

  // NEW: For EXPRESSION type - complete metadata for node creation
  expressionType?: string;        // 'MemberExpression', 'BinaryExpression', 'ConditionalExpression', etc.
  expressionMetadata?: {          // Type-specific metadata (matches VariableAssignmentInfo pattern)
    // MemberExpression
    object?: string;
    property?: string;
    computed?: boolean;
    computedPropertyVar?: string | null;

    // BinaryExpression, LogicalExpression
    operator?: string;
    leftSourceName?: string;
    rightSourceName?: string;

    // ConditionalExpression
    consequentSourceName?: string;
    alternateSourceName?: string;

    // Add more as needed for other expression types
  };

  file: string;
  line: number;                   // Line of assignment statement
  column: number;
}
```

**Key additions**:
- `literalValue`: Stores actual value for LITERAL nodes
- `expressionType`: Stores AST node type for EXPRESSION nodes
- `expressionMetadata`: Stores type-specific fields (object, property, operator, etc.)

This matches the pattern from VariableAssignmentInfo (lines 1089-1109 in GraphBuilder.ts).

---

## Phase 1: Complete Variable Reassignment (Simple + Compound)

**Goal**: ALL reassignment patterns work (simple `=` and compound `+=`, `-=`, etc.)

**Why combined**: Linus is right - no artificial splits. Do it correctly from the start.

### Files Changed

#### 1. `/packages/core/src/plugins/analysis/ast/types.ts`

**Add interface** (after VariableAssignmentInfo, line ~570):

```typescript
export interface VariableReassignmentInfo {
  // ... (full interface from section above)
}
```

**Update ASTCollections** (line ~592):

```typescript
export interface ASTCollections {
  functions: FunctionInfo[];
  // ... existing fields ...
  variableAssignments?: VariableAssignmentInfo[];
  variableReassignments?: VariableReassignmentInfo[];  // NEW
  // ... rest of fields ...
}
```

---

#### 2. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location**: AssignmentExpression handler (lines 2630-2650)

**Current code**:
```typescript
AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
  const assignNode = assignPath.node;

  // Initialize collection if not exists
  if (!collections.arrayMutations) {
    collections.arrayMutations = [];
  }
  const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

  // Check for indexed array assignment: arr[i] = value
  this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);

  // Initialize object mutations collection if not exists
  if (!collections.objectMutations) {
    collections.objectMutations = [];
  }
  const objectMutations = collections.objectMutations as ObjectMutationInfo[];

  // Check for object property assignment: obj.prop = value
  this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
},
```

**Change**: Add variable reassignment detection BEFORE indexed array/object property checks.

**New code**:
```typescript
AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
  const assignNode = assignPath.node;

  // === VARIABLE REASSIGNMENT (all operators: =, +=, -=, etc.) ===
  // Check if LHS is simple identifier (not obj.prop, not arr[i])
  if (assignNode.left.type === 'Identifier') {
    // Initialize collection if not exists
    if (!collections.variableReassignments) {
      collections.variableReassignments = [];
    }
    const variableReassignments = collections.variableReassignments as VariableReassignmentInfo[];

    this.detectVariableReassignment(assignNode, module, variableReassignments);
  }
  // === END VARIABLE REASSIGNMENT ===

  // Continue with existing array/object mutation detection...
  if (!collections.arrayMutations) {
    collections.arrayMutations = [];
  }
  const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];
  this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);

  if (!collections.objectMutations) {
    collections.objectMutations = [];
  }
  const objectMutations = collections.objectMutations as ObjectMutationInfo[];
  this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
},
```

---

**Add new method**: `detectVariableReassignment`

**Location**: After `detectObjectPropertyAssignment` method (after line 3600)

**Implementation**:
```typescript
/**
 * Detect variable reassignment for FLOWS_INTO edge creation.
 * Handles all assignment operators: =, +=, -=, *=, /=, etc.
 *
 * Captures COMPLETE metadata for:
 * - LITERAL values (literalValue field)
 * - EXPRESSION nodes (expressionType, expressionMetadata fields)
 * - VARIABLE, CALL_SITE, METHOD_CALL references
 *
 * No deferred functionality - all value types captured in Phase 1.
 */
private detectVariableReassignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  variableReassignments: VariableReassignmentInfo[]
): void {
  // LHS must be simple identifier (checked by caller)
  const leftId = assignNode.left as t.Identifier;
  const variableName = leftId.name;
  const operator = assignNode.operator;  // '=', '+=', '-=', etc.

  // Get RHS value info
  const rightExpr = assignNode.right;
  const line = getLine(assignNode);
  const column = getColumn(assignNode);

  // Extract value source (similar to VariableVisitor pattern)
  let valueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION';
  let valueName: string | undefined;
  let valueId: string | null = null;
  let callLine: number | undefined;
  let callColumn: number | undefined;

  // NEW: Complete metadata for node creation
  let literalValue: unknown = undefined;
  let expressionType: string | undefined;
  let expressionMetadata: Record<string, unknown> | undefined;

  // 1. Literal value
  const extractedLiteralValue = ExpressionEvaluator.extractLiteralValue(rightExpr);
  if (extractedLiteralValue !== null) {
    valueType = 'LITERAL';
    valueId = `LITERAL#${line}:${rightExpr.start}#${module.file}`;
    literalValue = extractedLiteralValue;  // NEW: Store for GraphBuilder
  }
  // 2. Simple identifier (variable reference)
  else if (rightExpr.type === 'Identifier') {
    valueType = 'VARIABLE';
    valueName = rightExpr.name;
  }
  // 3. CallExpression (function call)
  else if (rightExpr.type === 'CallExpression' && rightExpr.callee.type === 'Identifier') {
    valueType = 'CALL_SITE';
    valueName = rightExpr.callee.name;
    callLine = getLine(rightExpr);
    callColumn = getColumn(rightExpr);
  }
  // 4. MemberExpression (method call: obj.method())
  else if (rightExpr.type === 'CallExpression' && rightExpr.callee.type === 'MemberExpression') {
    valueType = 'METHOD_CALL';
    callLine = getLine(rightExpr);
    callColumn = getColumn(rightExpr);
  }
  // 5. Everything else is EXPRESSION
  else {
    valueType = 'EXPRESSION';
    valueId = `EXPRESSION#${line}:${column}#${module.file}`;
    expressionType = rightExpr.type;  // NEW: Store AST node type

    // NEW: Extract type-specific metadata (matches VariableAssignmentInfo pattern)
    expressionMetadata = {};

    // MemberExpression: obj.prop or obj[key]
    if (rightExpr.type === 'MemberExpression') {
      const objName = rightExpr.object.type === 'Identifier' ? rightExpr.object.name : undefined;
      const propName = rightExpr.property.type === 'Identifier' ? rightExpr.property.name : undefined;
      const computed = rightExpr.computed;

      expressionMetadata.object = objName;
      expressionMetadata.property = propName;
      expressionMetadata.computed = computed;

      // Computed property variable: obj[varName]
      if (computed && rightExpr.property.type === 'Identifier') {
        expressionMetadata.computedPropertyVar = rightExpr.property.name;
      }
    }
    // BinaryExpression: a + b, a - b, etc.
    else if (rightExpr.type === 'BinaryExpression' || rightExpr.type === 'LogicalExpression') {
      expressionMetadata.operator = rightExpr.operator;
      expressionMetadata.leftSourceName = rightExpr.left.type === 'Identifier' ? rightExpr.left.name : undefined;
      expressionMetadata.rightSourceName = rightExpr.right.type === 'Identifier' ? rightExpr.right.name : undefined;
    }
    // ConditionalExpression: condition ? a : b
    else if (rightExpr.type === 'ConditionalExpression') {
      expressionMetadata.consequentSourceName = rightExpr.consequent.type === 'Identifier' ? rightExpr.consequent.name : undefined;
      expressionMetadata.alternateSourceName = rightExpr.alternate.type === 'Identifier' ? rightExpr.alternate.name : undefined;
    }
    // Add more expression types as needed
  }

  // Push reassignment info to collection
  variableReassignments.push({
    variableName,
    variableLine: getLine(leftId),
    valueType,
    valueName,
    valueId,
    callLine,
    callColumn,
    operator,
    // NEW: Complete metadata
    literalValue,
    expressionType,
    expressionMetadata,
    file: module.file,
    line,
    column
  });
}
```

**Key improvements from original plan**:
- Captures `literalValue` for LITERAL type
- Captures `expressionType` and `expressionMetadata` for EXPRESSION type
- Handles ALL operators (no `operator === '='` check)
- No deferred functionality - complete in Phase 1

---

#### 3. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location**: In `build()` method, after step 26 (array mutations), before step 27 (object mutations)

**Insert new step** (around line 297):
```typescript
// 26.5. Buffer FLOWS_INTO edges for variable reassignments
const variableReassignments = collections.variableReassignments ?? [];
this.bufferVariableReassignmentEdges(variableReassignments, variableDeclarations, callSites, methodCalls, parameters);
```

---

**Add new method**: `bufferVariableReassignmentEdges`

**Location**: After `bufferArrayMutationEdges` (around line 1660)

**Implementation**:
```typescript
/**
 * Buffer FLOWS_INTO edges for variable reassignments.
 * Handles: x = y, x += y (when x is already declared, not initialization)
 *
 * Edge patterns:
 * - Simple assignment (=): source --FLOWS_INTO--> variable
 * - Compound operators (+=, -=, etc.):
 *   - source --FLOWS_INTO--> variable (write new value)
 *   - variable --READS_FROM--> variable (self-loop: reads current value before write)
 *
 * CURRENT LIMITATION (REG-XXX): Uses file-level variable lookup, not scope-aware.
 * Shadowed variables in nested scopes will incorrectly resolve to outer scope variable.
 *
 * Example:
 *   let x = 1;
 *   function foo() {
 *     let x = 2;
 *     x += 3;  // Currently creates edge to outer x (WRONG)
 *   }
 *
 * This matches existing mutation handler behavior (array/object mutations).
 * Will be fixed in future scope-aware lookup refactoring.
 */
private bufferVariableReassignmentEdges(
  variableReassignments: VariableReassignmentInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  callSites: CallSiteInfo[],
  methodCalls: MethodCallInfo[],
  parameters: ParameterInfo[]
): void {
  // Build lookup cache: O(n) instead of O(n*m)
  const varLookup = new Map<string, VariableDeclarationInfo>();
  for (const v of variableDeclarations) {
    varLookup.set(`${v.file}:${v.name}`, v);
  }

  const paramLookup = new Map<string, ParameterInfo>();
  for (const p of parameters) {
    paramLookup.set(`${p.file}:${p.name}`, p);
  }

  for (const reassignment of variableReassignments) {
    const {
      variableName,
      valueType,
      valueName,
      valueId,
      callLine,
      callColumn,
      operator,
      literalValue,
      expressionType,
      expressionMetadata,
      file,
      line,
      column
    } = reassignment;

    // Find target variable node
    const targetVar = varLookup.get(`${file}:${variableName}`);
    const targetParam = !targetVar ? paramLookup.get(`${file}:${variableName}`) : null;
    const targetNodeId = targetVar?.id ?? targetParam?.id;

    if (!targetNodeId) {
      // Variable not found - could be module-level or external reference
      continue;
    }

    // Resolve source node based on value type
    let sourceNodeId: string | null = null;

    // LITERAL: Create node inline (NO CONTINUE STATEMENT)
    if (valueType === 'LITERAL' && valueId) {
      // Create LITERAL node if not already exists
      // Matches pattern from bufferAssignmentEdges (line 998)
      this._bufferNode({
        type: 'LITERAL',
        id: valueId,
        value: literalValue,
        file,
        line,
        column
      });
      sourceNodeId = valueId;
    }
    // VARIABLE: Look up existing variable/parameter node
    else if (valueType === 'VARIABLE' && valueName) {
      const sourceVar = varLookup.get(`${file}:${valueName}`);
      const sourceParam = !sourceVar ? paramLookup.get(`${file}:${valueName}`) : null;
      sourceNodeId = sourceVar?.id ?? sourceParam?.id;
    }
    // CALL_SITE: Look up existing call node
    else if (valueType === 'CALL_SITE' && callLine && callColumn) {
      const callSite = callSites.find(cs =>
        cs.line === callLine && cs.column === callColumn && cs.file === file
      );
      sourceNodeId = callSite?.id ?? null;
    }
    // METHOD_CALL: Look up existing method call node
    else if (valueType === 'METHOD_CALL' && callLine && callColumn) {
      const methodCall = methodCalls.find(mc =>
        mc.line === callLine && mc.column === callColumn && mc.file === file
      );
      sourceNodeId = methodCall?.id ?? null;
    }
    // EXPRESSION: Create node inline (NO CONTINUE STATEMENT)
    else if (valueType === 'EXPRESSION' && valueId && expressionType) {
      // Create EXPRESSION node using NodeFactory
      // Matches pattern from bufferAssignmentEdges (lines 1087-1132)
      const expressionNode = NodeFactory.createExpressionFromMetadata(
        expressionType,
        file,
        line,
        column,
        {
          id: valueId,  // ID from JSASTAnalyzer
          ...expressionMetadata  // Spread metadata (object, property, operator, etc.)
        }
      );

      this._bufferNode(expressionNode);
      sourceNodeId = valueId;
    }

    // Create FLOWS_INTO edge if source found
    if (sourceNodeId && targetNodeId) {
      // For compound operators (operator !== '='), LHS reads its own current value
      // Create READS_FROM self-loop (Linus requirement)
      if (operator !== '=') {
        this._bufferEdge({
          type: 'READS_FROM',
          src: targetNodeId,  // Variable reads from...
          dst: targetNodeId   // ...itself (self-loop)
        });
      }

      // RHS flows into LHS (write side)
      this._bufferEdge({
        type: 'FLOWS_INTO',
        src: sourceNodeId,
        dst: targetNodeId
      });
    }
  }
}
```

**Key fixes from original plan**:
1. **No continue statements**: LITERAL and EXPRESSION handled inline
2. **READS_FROM edges**: Self-loop for compound operators
3. **Complete node creation**: Uses stored metadata (literalValue, expressionType, expressionMetadata)
4. **JSDoc documents scope limitation**: Honest about current behavior
5. **Matches existing patterns**: Uses NodeFactory like bufferAssignmentEdges

---

### Phase 1 Acceptance Criteria

**Test file**: `test/unit/VariableReassignment.test.js` (Kent will create)

**Test groups**:

#### 1. Simple Assignment (operator = '=')

```javascript
it('should create FLOWS_INTO edge for simple variable reassignment', async () => {
  await setupTest(backend, {
    'index.js': `
      let total = 0;
      const value = 10;
      total = value;  // value --FLOWS_INTO--> total
    `
  });

  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
  const valueVar = allNodes.find(n => n.name === 'value' && n.type === 'CONSTANT');

  assert.ok(totalVar, 'Variable "total" not found');
  assert.ok(valueVar, 'Variable "value" not found');

  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === valueVar.id &&
    e.dst === totalVar.id
  );

  assert.ok(flowsInto, 'FLOWS_INTO edge from value to total not found');

  // Should NOT create READS_FROM for simple assignment
  const readsFrom = allEdges.find(e =>
    e.type === 'READS_FROM' &&
    e.src === totalVar.id &&
    e.dst === totalVar.id
  );
  assert.strictEqual(readsFrom, undefined, 'READS_FROM self-loop should not exist for simple assignment');
});

it('should create FLOWS_INTO edge for literal reassignment', async () => {
  await setupTest(backend, {
    'index.js': `
      let x = 0;
      x = 42;  // literal(42) --FLOWS_INTO--> x
    `
  });

  const xVar = allNodes.find(n => n.name === 'x');
  const literal42 = allNodes.find(n => n.type === 'LITERAL' && n.value === 42);

  assert.ok(literal42, 'LITERAL node not created');

  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === literal42.id &&
    e.dst === xVar.id
  );

  assert.ok(flowsInto, 'FLOWS_INTO edge from literal to x not found');
});

it('should create FLOWS_INTO edge for expression reassignment', async () => {
  await setupTest(backend, {
    'index.js': `
      let total = 0;
      const a = 5, b = 3;
      total = a + b;  // EXPRESSION(a+b) --FLOWS_INTO--> total
    `
  });

  const totalVar = allNodes.find(n => n.name === 'total');
  const expression = allNodes.find(n =>
    n.type === 'EXPRESSION' && n.expressionType === 'BinaryExpression'
  );

  assert.ok(expression, 'EXPRESSION node not created');

  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === expression.id &&
    e.dst === totalVar.id
  );

  assert.ok(flowsInto, 'FLOWS_INTO edge from expression to total not found');
});
```

#### 2. Compound Operators (operator !== '=')

```javascript
it('should create READS_FROM self-loop for compound operator', async () => {
  await setupTest(backend, {
    'index.js': `
      let total = 0;
      const price = 10;
      total += price;  // total --READS_FROM--> total (self-loop)
                       // price --FLOWS_INTO--> total
    `
  });

  const totalVar = allNodes.find(n => n.name === 'total');
  const priceVar = allNodes.find(n => n.name === 'price');

  // READS_FROM edge (self-loop)
  const readsFrom = allEdges.find(e =>
    e.type === 'READS_FROM' &&
    e.src === totalVar.id &&
    e.dst === totalVar.id
  );
  assert.ok(readsFrom, 'READS_FROM self-loop not found for compound operator');

  // FLOWS_INTO edge
  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === priceVar.id &&
    e.dst === totalVar.id
  );
  assert.ok(flowsInto, 'FLOWS_INTO edge not found');
});

it('should handle all arithmetic operators', async () => {
  await setupTest(backend, {
    'index.js': `
      let x = 100;
      const a = 5, b = 2, c = 3, d = 4, e = 1, f = 2;
      x += a;   // a --FLOWS_INTO--> x, x --READS_FROM--> x
      x -= b;   // b --FLOWS_INTO--> x, x --READS_FROM--> x
      x *= c;   // c --FLOWS_INTO--> x, x --READS_FROM--> x
      x /= d;   // d --FLOWS_INTO--> x, x --READS_FROM--> x
      x %= e;   // e --FLOWS_INTO--> x, x --READS_FROM--> x
      x **= f;  // f --FLOWS_INTO--> x, x --READS_FROM--> x
    `
  });

  const xVar = allNodes.find(n => n.name === 'x');

  // Each compound operator creates FLOWS_INTO edge
  const flowsIntoEdges = allEdges.filter(e =>
    e.type === 'FLOWS_INTO' && e.dst === xVar.id
  );
  assert.strictEqual(flowsIntoEdges.length, 6, 'Expected 6 FLOWS_INTO edges');

  // Each compound operator creates READS_FROM self-loop
  const readsFromEdges = allEdges.filter(e =>
    e.type === 'READS_FROM' &&
    e.src === xVar.id &&
    e.dst === xVar.id
  );
  assert.strictEqual(readsFromEdges.length, 6, 'Expected 6 READS_FROM self-loops');
});

it('should handle logical operators (&&=, ||=, ??=)', async () => {
  await setupTest(backend, {
    'index.js': `
      let flag = true;
      const condition = false;
      const fallback = null;
      flag &&= condition;  // condition --FLOWS_INTO--> flag, flag --READS_FROM--> flag
      flag ||= fallback;   // fallback --FLOWS_INTO--> flag, flag --READS_FROM--> flag
    `
  });

  const flagVar = allNodes.find(n => n.name === 'flag');

  const flowsIntoEdges = allEdges.filter(e =>
    e.type === 'FLOWS_INTO' && e.dst === flagVar.id
  );
  assert.strictEqual(flowsIntoEdges.length, 2);

  const readsFromEdges = allEdges.filter(e =>
    e.type === 'READS_FROM' &&
    e.src === flagVar.id &&
    e.dst === flagVar.id
  );
  assert.strictEqual(readsFromEdges.length, 2);
});

it('should handle member expression RHS', async () => {
  await setupTest(backend, {
    'index.js': `
      let total = 0;
      const item = { price: 10 };
      total += item.price;  // EXPRESSION(item.price) --FLOWS_INTO--> total
                            // total --READS_FROM--> total
    `
  });

  const totalVar = allNodes.find(n => n.name === 'total');
  const expression = allNodes.find(n =>
    n.type === 'EXPRESSION' && n.expressionType === 'MemberExpression'
  );

  assert.ok(expression, 'EXPRESSION node not created for item.price');

  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === expression.id &&
    e.dst === totalVar.id
  );
  assert.ok(flowsInto, 'FLOWS_INTO edge not found');

  const readsFrom = allEdges.find(e =>
    e.type === 'READS_FROM' &&
    e.src === totalVar.id &&
    e.dst === totalVar.id
  );
  assert.ok(readsFrom, 'READS_FROM self-loop not found');
});

it('should handle call expression RHS', async () => {
  await setupTest(backend, {
    'index.js': `
      function getPrice() { return 10; }
      let total = 0;
      total += getPrice();  // getPrice() --FLOWS_INTO--> total
                            // total --READS_FROM--> total
    `
  });

  const totalVar = allNodes.find(n => n.name === 'total');
  const getPriceCall = allNodes.find(n =>
    n.type === 'CALL' && n.name === 'getPrice'
  );

  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === getPriceCall.id &&
    e.dst === totalVar.id
  );
  assert.ok(flowsInto, 'FLOWS_INTO edge from call to total not found');

  const readsFrom = allEdges.find(e =>
    e.type === 'READS_FROM' &&
    e.src === totalVar.id &&
    e.dst === totalVar.id
  );
  assert.ok(readsFrom, 'READS_FROM self-loop not found');
});
```

#### 3. Edge Cases

```javascript
it('should create multiple edges for multiple reassignments', async () => {
  await setupTest(backend, {
    'index.js': `
      let x = 0;
      const a = 1, b = 2, c = 3;
      x = a;
      x += b;
      x -= c;
    `
  });

  const xVar = allNodes.find(n => n.name === 'x');

  // 3 FLOWS_INTO edges (one per reassignment)
  const flowsIntoEdges = allEdges.filter(e =>
    e.type === 'FLOWS_INTO' && e.dst === xVar.id
  );
  assert.strictEqual(flowsIntoEdges.length, 3);

  // 2 READS_FROM edges (only for compound operators, not simple =)
  const readsFromEdges = allEdges.filter(e =>
    e.type === 'READS_FROM' &&
    e.src === xVar.id &&
    e.dst === xVar.id
  );
  assert.strictEqual(readsFromEdges.length, 2);
});

it('should handle shadowed variables (current limitation: uses outer scope)', () => {
  // Documents current behavior - will be fixed in REG-XXX
  // This test PASSES with current implementation (wrong behavior)
  // After scope-aware lookup implemented, update expected behavior

  await setupTest(backend, {
    'index.js': `
      let x = 1;
      function foo() {
        let x = 2;
        x += 3;  // Currently resolves to outer x (WRONG, but consistent with obj mutations)
      }
    `
  });

  // Currently creates edge to outer x
  // TODO: After REG-XXX implemented, this should create edge to inner x
  // For now, document the limitation in test name
});
```

---

## Phase 2: Edge Metadata (Optional Enhancement)

**Goal**: Store operator type on FLOWS_INTO edge for query differentiation.

**Why separate phase**: Core functionality works without it. This is enhancement, not blocker.

### Files Changed

#### 1. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location**: `bufferVariableReassignmentEdges` method (modify existing code)

**Current code** (from Phase 1):
```typescript
// RHS flows into LHS (write side)
this._bufferEdge({
  type: 'FLOWS_INTO',
  src: sourceNodeId,
  dst: targetNodeId
});
```

**Change to**:
```typescript
// RHS flows into LHS (write side)
const edge: GraphEdge = {
  type: 'FLOWS_INTO',
  src: sourceNodeId,
  dst: targetNodeId
};

// Phase 2: Add operator metadata for differentiation
if (operator !== '=') {
  // Store compound operator in metadata
  if (!edge.metadata) {
    edge.metadata = {};
  }
  edge.metadata.operator = operator;
}

this._bufferEdge(edge);
```

**Key detail**: Only store operator if NOT simple assignment (`=`). Keeps metadata clean.

---

### Phase 2 Acceptance Criteria

**Test cases**:

```javascript
it('should store operator in edge metadata for compound assignments', async () => {
  await setupTest(backend, {
    'index.js': `
      let x = 0;
      const a = 5;
      x += a;
    `
  });

  const xVar = allNodes.find(n => n.name === 'x');
  const aVar = allNodes.find(n => n.name === 'a');

  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === aVar.id &&
    e.dst === xVar.id
  );

  assert.ok(flowsInto, 'FLOWS_INTO edge not found');
  assert.strictEqual(flowsInto.metadata?.operator, '+=', 'Operator metadata not found');
});

it('should NOT store operator for simple assignment', async () => {
  await setupTest(backend, {
    'index.js': `
      let x = 0;
      const a = 5;
      x = a;
    `
  });

  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === aVar.id &&
    e.dst === xVar.id
  );

  assert.ok(flowsInto, 'FLOWS_INTO edge not found');
  assert.strictEqual(flowsInto.metadata?.operator, undefined, 'Operator should not be stored for =');
});

it('should differentiate operators in metadata', async () => {
  await setupTest(backend, {
    'index.js': `
      let a = 0, b = 0;
      const x = 1;
      a += x;  // metadata.operator = '+='
      b *= x;  // metadata.operator = '*='
    `
  });

  const plusEquals = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.dst === aVar.id
  );
  assert.strictEqual(plusEquals?.metadata?.operator, '+=');

  const timesEquals = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.dst === bVar.id
  );
  assert.strictEqual(timesEquals?.metadata?.operator, '*=');
});
```

**Success metrics**:
- ✅ Compound operators stored in `metadata.operator`
- ✅ Simple assignment (`=`) has no metadata
- ✅ Can differentiate additive (`+=`) vs multiplicative (`*=`) flows
- ✅ Metadata doesn't break existing queries

---

## Implementation Order

**Step-by-step execution plan**:

### Phase 1 (Complete Functionality)

1. **Add VariableReassignmentInfo interface** to types.ts (with ALL fields)
2. **Add detectVariableReassignment method** to JSASTAnalyzer.ts (captures ALL metadata)
3. **Update AssignmentExpression handler** (all operators, not just '=')
4. **Update ASTCollections interface** (add variableReassignments field)
5. **Add bufferVariableReassignmentEdges method** to GraphBuilder.ts (NO continue statements)
6. **Call buffer method** in GraphBuilder.build()
7. **Kent writes comprehensive tests** (simple + compound operators, literals, expressions, READS_FROM edges)
8. **Rob implements Phase 1**
9. **Kevlin + Linus review Phase 1**

### Phase 2 (Optional Metadata)

10. **Add metadata to edge creation** in bufferVariableReassignmentEdges
11. **Kent writes metadata tests**
12. **Rob implements Phase 2**
13. **Kevlin + Linus review Phase 2**

### Finalization

14. **Steve Jobs demos the feature**
15. **Create Linear issues for tech debt**:
    - "Scope-aware variable lookup for mutations" (v0.2, Bug)
    - "Refactor literal creation to JSASTAnalyzer" (v0.2, Improvement)
    - "Track reads in UpdateExpression (i++, --i)" (v0.2, Bug)
16. **Update REG-290 status** → In Review

---

## Risk Mitigation

### Risk: Scope shadowing creates wrong edges

**Problem**:
```javascript
let x = 1;
function foo() {
  let x = 2;
  x += 3;  // Which x?
}
```

**Current behavior**: File-level lookup finds first `x` (wrong!).

**Solution**:
- Phase 1-2: Accept limitation (document in JSDoc)
- Create Linear issue during task completion: "REG-XXX: Scope-aware variable lookup for reassignments" (v0.2, Bug)
- Add test case demonstrating current behavior (not blocking)

**Why acceptable**:
- Matches existing mutation handler behavior (array/object mutations)
- Scope-aware lookup is systemic improvement, not specific to this feature
- Honest about limitation (JSDoc + test case)

---

### Risk: Multiple reassignments in loop

**Problem**:
```javascript
for (const item of items) {
  total += item.price;
}
```

Should this create 1 edge or N edges?

**Answer**: 1 edge (syntactic, not runtime).

**Reasoning**:
- AST analysis is static (syntax-based)
- We see 1 AssignmentExpression in the tree
- Edge represents "this value CAN flow here", not "flows N times"

**No special handling needed** - natural behavior is correct.

---

### Risk: READS_FROM self-loop seems weird

**Linus's argument**: It's semantically correct.

**Why it's right**:
- `total += price` reads `total` (current value) before writing
- Self-loop models this: `total --READS_FROM--> total`
- Consistent with UpdateExpression philosophy: track mutation, not micro-operations

**Supporting evidence**:
- Graph databases use self-loops for reflexive relationships
- Example: Social graph has "likes own post" as self-loop
- Our case: Variable reads itself before mutation

**No mitigation needed** - accept Linus's design.

---

## Test Strategy

### Unit Tests (Kent will create)

**File**: `test/unit/VariableReassignment.test.js`

**Test groups** (see Phase 1 Acceptance Criteria section):
1. Simple assignment (`x = y`) - literals, variables, expressions
2. Arithmetic operators (`+=`, `-=`, `*=`, `/=`, `%=`, `**=`)
3. Bitwise operators (`&=`, `|=`, `^=`, `<<=`, `>>=`, `>>>=`)
4. Logical operators (`&&=`, `||=`, `??=`)
5. Complex RHS (member expressions, call expressions)
6. READS_FROM edges (self-loops for compound operators)
7. Edge cases (multiple reassignments, shadowed variables)

### Integration Tests

**Scenario**: Real-world accumulation pattern

```javascript
function calculateTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price;
    if (item.discount) {
      total -= item.discount;
    }
  }
  return total;
}
```

**Expected graph**:
- `total` ASSIGNED_FROM literal(0)
- EXPRESSION(item.price) --FLOWS_INTO--> total
- EXPRESSION(item.discount) --FLOWS_INTO--> total
- `total` --READS_FROM--> total (2 self-loops)
- total --RETURNS--> calculateTotal

**Query test**:
```javascript
const totalSources = await backend.query(`
  MATCH (source)-[:FLOWS_INTO]->(total:VARIABLE {name: 'total'})
  RETURN source
`);
// Should find: literal(0) via ASSIGNED_FROM, item.price via FLOWS_INTO, item.discount via FLOWS_INTO

const totalReads = await backend.query(`
  MATCH (total:VARIABLE {name: 'total'})-[:READS_FROM]->(total)
  RETURN count(*)
`);
// Should return: 2 (one per compound operator)
```

---

## Performance Analysis

### Complexity

**Time complexity**:
- Per reassignment: O(1) map lookup for variable
- Total: O(R) where R = number of reassignments

**Space complexity**:
- VariableReassignmentInfo: ~300 bytes per reassignment (with full metadata)
- Typical file with 10 reassignments: ~3KB

**Comparison**:
- Same order as existing mutation handlers (array/object)
- Metadata adds ~50 bytes per reassignment (acceptable)

### Batching

**Current implementation uses buffering**:
- All nodes buffered, then flushed once
- All edges buffered, then flushed once
- No change needed - already optimal

---

## Alignment with Vision

**"AI should query the graph, not read code."**

**Before this fix**:
```
Agent: "Where does total get its value from?"
Graph: "literal(0) via ASSIGNED_FROM"
Agent: "But it's updated in the loop with item.price!"
User: "Read the code, graph doesn't track that."
```

**After this fix**:
```
Agent: "Where does total get its value from?"
Graph: "literal(0) via ASSIGNED_FROM, item.price via FLOWS_INTO"
Agent: "What operations read total?"
Graph: "total reads itself (READS_FROM) before each compound operation"
Agent: "Perfect. Total accumulates prices. Got it."
```

**This is exactly Grafema's purpose**: Make data flow queryable, not buried in code syntax.

---

## Summary of Changes from Original Plan

### What Was Fixed

1. **Literal handling** (Critical Issue 1):
   - ❌ Original: `continue;` statement, deferred to "Phase 1.5"
   - ✅ Revised: Inline node creation using `literalValue` metadata

2. **Expression handling** (Critical Issue 3):
   - ❌ Original: `continue;` statement, deferred as "complex case"
   - ✅ Revised: Inline node creation using `expressionType` and `expressionMetadata`

3. **READS_FROM edges** (Critical Issue 2):
   - ❌ Original: Out-of-scope, deferred to future work
   - ✅ Revised: Self-loop created in Phase 1 for compound operators

4. **VariableReassignmentInfo interface** (Critical Issue 4):
   - ❌ Original: Only `operator` field
   - ✅ Revised: Complete metadata (`literalValue`, `expressionType`, `expressionMetadata`)

5. **Phase structure** (Critical Issue 5):
   - ❌ Original: Phase 1 (partial) → Phase 1.5 (literals) → Phase 2 (compound)
   - ✅ Revised: Phase 1 (complete) → Phase 2 (optional metadata)

### What Stayed the Same

1. **FLOWS_INTO pattern**: Still using existing edge type (Don's decision, Linus approved)
2. **Position-based lookup**: Still using file+name for variable lookup (matches existing patterns)
3. **Scope shadowing limitation**: Still deferred as documented tech debt (acceptable)
4. **Phase-based approach**: Still building incrementally (but no artificial splits)

---

## Conclusion

This revised plan addresses ALL of Linus's concerns:

✅ **No continue statements** - literals and expressions handled inline
✅ **READS_FROM edges** - self-loops for compound operators model read-before-write
✅ **Complete metadata** - VariableReassignmentInfo has all fields for node creation
✅ **No artificial phases** - Phase 1 is complete, Phase 2 is optional enhancement
✅ **Honest about limitations** - Scope shadowing documented, tracked as tech debt

**Next step**: Kent writes tests, Rob implements, Kevlin + Linus review.

---

**Joel Spolsky**
Implementation Planner, Grafema

**"Do it right the first time. No TODOs, no deferred functionality, no shortcuts."**
