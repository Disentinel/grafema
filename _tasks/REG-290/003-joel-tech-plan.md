# Joel Spolsky - Technical Implementation Plan for REG-290

**Date**: 2026-02-01
**Author**: Joel Spolsky (Implementation Planner)
**Based on**: Don Melton's High-Level Plan (002-don-plan.md)

---

## Executive Summary

This plan details the exact file changes, data structures, and implementation order to track compound assignment operators (`+=`, `-=`, etc.) using the FLOWS_INTO pattern. The implementation is split into 3 phases, each building on the previous:

1. **Phase 1**: Simple variable reassignment (`x = y` after declaration)
2. **Phase 2**: Compound operators (`x += y`)
3. **Phase 3**: Edge metadata (optional operator storage)

**Key Decision**: Use FLOWS_INTO edges (not ASSIGNED_FROM, not new edge types) for consistency with existing mutation tracking.

---

## Answers to Don's Open Questions

### Q1: Variable lookup - semantic IDs or position-based?

**Answer**: Position-based lookup (file + name) for consistency with existing mutation handlers.

**Reasoning**:
- `bufferObjectMutationEdges` (line 1663) uses: `variableDeclarations.find(v => v.name === objectName && v.file === file)`
- `bufferArrayMutationEdges` (line 1581) uses map lookup: `varLookup.set(${v.file}:${v.name}, v)`
- Semantic IDs are for node creation, not for cross-collection lookups during edge buffering

**Implementation**: Follow the pattern from `bufferArrayMutationEdges` - build a `Map<string, VariableDeclarationInfo>` keyed by `${file}:${name}`.

### Q2: Scope resolution - how to handle shadowed variables?

**Answer**: File-level scope only (same as current mutation handlers).

**Reasoning**:
- Current mutation handlers don't perform scope-based shadowing resolution
- They use simple name lookup within same file: `v.name === objectName && v.file === file`
- Proper shadowing resolution requires scope traversal - that's a future enhancement (separate issue)

**Decision**: Match existing behavior. Create issue for scope-aware lookup if needed.

### Q3: Edge deduplication - multiple `x += y` create multiple edges?

**Answer**: Allow multiple edges (same as array mutations).

**Reasoning**:
- `arr.push(x)` called 3 times creates 3 FLOWS_INTO edges
- Compound assignment in a loop should create multiple edges (represents multiple data flows)
- Graph queries can aggregate via COUNT if needed

**Example**:
```javascript
for (const item of items) {
  total += item.price;  // Each iteration = separate data flow event
}
```

This creates N edges (N = items.length at runtime), but we only see 1 syntactic assignment. We'll create 1 edge per syntactic occurrence, not per runtime execution.

### Q4: Operator metadata - store on edge or skip?

**Answer**: Store in Phase 3 (optional, non-blocking).

**Reasoning**:
- Core functionality works without it
- Useful for differentiating `+=` (additive) vs `=` (overwrite) in taint analysis
- GraphEdge interface already supports `metadata?: Record<string, unknown>`

**Implementation**: Add `operator?: string` field to edge metadata in Phase 3.

---

## Phase 1: Simple Variable Reassignment

**Goal**: `x = y` (when x already declared) creates FLOWS_INTO edge.

**Why first**: Compound operators desugar to reassignment (`x += y` ≈ `x = x + y`). If simple reassignment works, compound is just RHS extraction.

### Files Changed

#### 1. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

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

**New code** (insert at line 2631, after `const assignNode = assignPath.node;`):
```typescript
// === PHASE 1: Simple variable reassignment ===
// Check if LHS is simple identifier (not obj.prop, not arr[i])
if (assignNode.operator === '=' && assignNode.left.type === 'Identifier') {
  // Initialize collection if not exists
  if (!collections.variableReassignments) {
    collections.variableReassignments = [];
  }
  const variableReassignments = collections.variableReassignments as VariableReassignmentInfo[];

  this.detectVariableReassignment(assignNode, module, variableReassignments);
}
// === END PHASE 1 ===

// Continue with existing array/object mutation detection...
```

**Why this location**:
- Before indexed array check: ensures simple variables are handled first
- Inside AssignmentExpression handler: all `=` operators go through here
- Matches existing pattern: detectIndexedArrayAssignment, detectObjectPropertyAssignment

#### 2. Add new method: `detectVariableReassignment`

**Location**: After `detectObjectPropertyAssignment` method (after line 3600)

**Signature**:
```typescript
private detectVariableReassignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  variableReassignments: VariableReassignmentInfo[]
): void
```

**Implementation**:
```typescript
private detectVariableReassignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  variableReassignments: VariableReassignmentInfo[]
): void {
  // LHS must be simple identifier (checked by caller)
  const leftId = assignNode.left as t.Identifier;
  const variableName = leftId.name;

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

  // 1. Literal value
  const literalValue = ExpressionEvaluator.extractLiteralValue(rightExpr);
  if (literalValue !== null) {
    valueType = 'LITERAL';
    // Create literal ID matching VariableVisitor pattern
    valueId = `LITERAL#${line}:${rightExpr.start}#${module.file}`;
    // Note: Literal node creation happens in GraphBuilder, not here
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
  // 5. Everything else is EXPRESSION (BinaryExpression, ConditionalExpression, etc.)
  else {
    valueType = 'EXPRESSION';
    // Expression nodes are created in GraphBuilder with unique IDs
    valueId = `EXPRESSION#${line}:${column}#${module.file}`;
  }

  // Push reassignment info to collection
  variableReassignments.push({
    variableName,
    variableLine: getLine(leftId),  // Line where variable is referenced on LHS
    valueType,
    valueName,
    valueId,
    callLine,
    callColumn,
    file: module.file,
    line,
    column
  });
}
```

**Key details**:
- Similar to VariableVisitor.handleVariableInit (lines 580-750)
- Reuses existing patterns: ExpressionEvaluator, getLine/getColumn
- Defers literal/expression node creation to GraphBuilder (separation of concerns)

#### 3. `/packages/core/src/plugins/analysis/ast/types.ts`

**Location**: After `VariableAssignmentInfo` (after line 570)

**Add new interface**:
```typescript
// === VARIABLE REASSIGNMENT INFO ===
/**
 * Tracks variable reassignments for FLOWS_INTO edge creation.
 * Used when a variable is assigned AFTER its declaration: x = y (not const x = y).
 *
 * Edge direction: value --FLOWS_INTO--> variable
 *
 * Distinction from VariableAssignmentInfo:
 * - VariableAssignmentInfo: initialization (const x = y) -> ASSIGNED_FROM edge
 * - VariableReassignmentInfo: mutation (x = y later) -> FLOWS_INTO edge
 */
export interface VariableReassignmentInfo {
  variableName: string;           // Name of variable being reassigned
  variableLine: number;           // Line where variable is referenced on LHS
  valueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION';
  valueName?: string;             // For VARIABLE, CALL_SITE types
  valueId?: string | null;        // For LITERAL, EXPRESSION types
  callLine?: number;              // For CALL_SITE, METHOD_CALL types
  callColumn?: number;
  file: string;
  line: number;                   // Line of assignment statement
  column: number;
}
```

**Also update ASTCollections** (line 592):
```typescript
export interface ASTCollections {
  functions: FunctionInfo[];
  // ... existing fields ...
  variableAssignments?: VariableAssignmentInfo[];
  variableReassignments?: VariableReassignmentInfo[];  // NEW
  // ... rest of fields ...
}
```

#### 4. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location**: In `build()` method, after step 26 (array mutations), before step 27 (object mutations)

**Insert new step** (around line 297):
```typescript
// 26.5. Buffer FLOWS_INTO edges for variable reassignments (Phase 1: simple reassignment)
const variableReassignments = collections.variableReassignments ?? [];
this.bufferVariableReassignmentEdges(variableReassignments, variableDeclarations, callSites, methodCalls, parameters);
```

**Add new method** (after `bufferArrayMutationEdges`, around line 1660):
```typescript
/**
 * Buffer FLOWS_INTO edges for variable reassignments.
 * Handles: x = y (when x is already declared, not initialization)
 *
 * Edge direction: source --FLOWS_INTO--> variable
 *
 * Phase 1: Simple reassignment (operator = '=')
 * Phase 2: Will be extended for compound operators (operator = '+=', '-=', etc.)
 */
private bufferVariableReassignmentEdges(
  variableReassignments: VariableReassignmentInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  callSites: CallSiteInfo[],
  methodCalls: MethodCallInfo[],
  parameters: ParameterInfo[]
): void {
  // Build lookup cache: O(n) instead of O(n*m) with find() per reassignment
  const varLookup = new Map<string, VariableDeclarationInfo>();
  for (const v of variableDeclarations) {
    varLookup.set(`${v.file}:${v.name}`, v);
  }

  const paramLookup = new Map<string, ParameterInfo>();
  for (const p of parameters) {
    paramLookup.set(`${p.file}:${p.name}`, p);
  }

  for (const reassignment of variableReassignments) {
    const { variableName, valueType, valueName, valueId, callLine, callColumn, file } = reassignment;

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

    if (valueType === 'LITERAL' && valueId) {
      // Literal node - create if not exists (similar to bufferAssignmentEdges)
      // Note: JSASTAnalyzer doesn't create literal nodes for reassignments
      // We need to buffer it here
      // TODO: Refactor to ensure literals are created in JSASTAnalyzer phase
      // For now, skip literal reassignments (will be handled in Phase 1.5)
      continue;
    } else if (valueType === 'VARIABLE' && valueName) {
      // Source is another variable
      const sourceVar = varLookup.get(`${file}:${valueName}`);
      const sourceParam = !sourceVar ? paramLookup.get(`${file}:${valueName}`) : null;
      sourceNodeId = sourceVar?.id ?? sourceParam?.id;
    } else if (valueType === 'CALL_SITE' && callLine && callColumn) {
      // Source is function call
      const callSite = callSites.find(cs =>
        cs.line === callLine && cs.column === callColumn && cs.file === file
      );
      sourceNodeId = callSite?.id ?? null;
    } else if (valueType === 'METHOD_CALL' && callLine && callColumn) {
      // Source is method call
      const methodCall = methodCalls.find(mc =>
        mc.line === callLine && mc.column === callColumn && mc.file === file
      );
      sourceNodeId = methodCall?.id ?? null;
    } else if (valueType === 'EXPRESSION' && valueId) {
      // Expression node - will be created separately
      // For Phase 1, skip expressions (complex case)
      continue;
    }

    // Create FLOWS_INTO edge if source found
    if (sourceNodeId && targetNodeId) {
      this._bufferEdge({
        type: 'FLOWS_INTO',
        src: sourceNodeId,
        dst: targetNodeId
      });
    }
  }
}
```

**Key design decisions**:
- Uses same lookup pattern as `bufferArrayMutationEdges` (Map-based, O(n) complexity)
- Handles variable-to-variable reassignment first (simplest case)
- Defers literal/expression handling (noted with TODO comments)
- Follows existing edge buffering pattern: `this._bufferEdge({ type: 'FLOWS_INTO', ... })`

### Phase 1 Acceptance Criteria

**Test case** (to be written by Kent):
```javascript
// test/unit/VariableReassignment.test.js
it('should create FLOWS_INTO edge for simple variable reassignment', async () => {
  await setupTest(backend, {
    'index.js': `
      let total = 0;
      const value = 10;
      total = value;  // Should create: value --FLOWS_INTO--> total
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
});
```

**Success metrics**:
- ✅ `x = y` creates FLOWS_INTO edge (variable source)
- ✅ `x = foo()` creates FLOWS_INTO edge (call source)
- ✅ Edge direction: source --FLOWS_INTO--> destination
- ✅ No duplicate edges for same assignment
- ✅ Works with both `let` and `var` declarations

---

## Phase 2: Compound Assignment Operators

**Goal**: `x += y`, `x -= y`, etc. create FLOWS_INTO edges from RHS to LHS.

**Why after Phase 1**: Compound operators are just reassignment with different RHS extraction.

### Files Changed

#### 1. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location**: AssignmentExpression handler (modify Phase 1 code)

**Current Phase 1 code**:
```typescript
if (assignNode.operator === '=' && assignNode.left.type === 'Identifier') {
  // ... detectVariableReassignment ...
}
```

**Change to**:
```typescript
// === PHASE 2: Support compound operators ===
if (assignNode.left.type === 'Identifier') {
  // Simple variable on LHS (not obj.prop, not arr[i])

  // Initialize collection if not exists
  if (!collections.variableReassignments) {
    collections.variableReassignments = [];
  }
  const variableReassignments = collections.variableReassignments as VariableReassignmentInfo[];

  this.detectVariableReassignment(assignNode, module, variableReassignments);
}
// === END PHASE 2 ===
```

**Key change**: Remove `operator === '='` check. Now handles ALL operators.

#### 2. Update `detectVariableReassignment` method

**Location**: Same method, add operator handling

**Changes**:

**A. Extract operator**:
```typescript
private detectVariableReassignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  variableReassignments: VariableReassignmentInfo[]
): void {
  const leftId = assignNode.left as t.Identifier;
  const variableName = leftId.name;
  const operator = assignNode.operator;  // NEW: '=', '+=', '-=', etc.

  // For compound operators, RHS is the value being added/subtracted/etc.
  // For simple assignment, RHS is the new value
  const rightExpr = assignNode.right;
  // ... rest of method ...
```

**B. Add operator to reassignment info**:
```typescript
// Push reassignment info to collection
variableReassignments.push({
  variableName,
  variableLine: getLine(leftId),
  valueType,
  valueName,
  valueId,
  callLine,
  callColumn,
  operator,  // NEW: store operator
  file: module.file,
  line,
  column
});
```

#### 3. Update `VariableReassignmentInfo` interface

**Location**: `/packages/core/src/plugins/analysis/ast/types.ts`

**Add operator field**:
```typescript
export interface VariableReassignmentInfo {
  variableName: string;
  variableLine: number;
  valueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION';
  valueName?: string;
  valueId?: string | null;
  callLine?: number;
  callColumn?: number;
  operator: string;  // NEW: '=', '+=', '-=', '*=', etc.
  file: string;
  line: number;
  column: number;
}
```

**Documentation update**:
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
 * Distinction from VariableAssignmentInfo:
 * - VariableAssignmentInfo: initialization (const x = y) -> ASSIGNED_FROM edge
 * - VariableReassignmentInfo: mutation (x = y, x += y) -> FLOWS_INTO edge
 */
```

#### 4. No changes to GraphBuilder needed

**Why**: `bufferVariableReassignmentEdges` already ignores operator field. It only cares about:
- Source node (RHS)
- Destination node (LHS)
- Edge type (FLOWS_INTO)

The operator field is metadata, not used for edge creation (yet).

### Phase 2 Acceptance Criteria

**Test cases** (to be written by Kent):

```javascript
describe('Compound Assignment Operators', () => {
  it('should create FLOWS_INTO edge for += operator', async () => {
    await setupTest(backend, {
      'index.js': `
        let total = 0;
        const price = 10;
        total += price;  // Should create: price --FLOWS_INTO--> total
      `
    });

    const totalVar = allNodes.find(n => n.name === 'total');
    const priceVar = allNodes.find(n => n.name === 'price');

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
        let x = 10;
        const a = 5, b = 2, c = 3, d = 4, e = 1;
        x += a;   // x --FLOWS_INTO--> a
        x -= b;   // x --FLOWS_INTO--> b
        x *= c;   // x --FLOWS_INTO--> c
        x /= d;   // x --FLOWS_INTO--> d
        x %= e;   // x --FLOWS_INTO--> e
      `
    });

    // Each reassignment creates separate FLOWS_INTO edge
    const flowsIntoEdges = allEdges.filter(e =>
      e.type === 'FLOWS_INTO' && e.dst === xVar.id
    );

    assert.strictEqual(flowsIntoEdges.length, 5, 'Expected 5 FLOWS_INTO edges');
  });

  it('should handle logical operators (&&=, ||=, ??=)', async () => {
    await setupTest(backend, {
      'index.js': `
        let flag = true;
        const condition = false;
        const fallback = null;
        flag &&= condition;  // condition --FLOWS_INTO--> flag
        flag ||= fallback;   // fallback --FLOWS_INTO--> flag
      `
    });

    const flagVar = allNodes.find(n => n.name === 'flag');
    const flowsIntoEdges = allEdges.filter(e =>
      e.type === 'FLOWS_INTO' && e.dst === flagVar.id
    );

    assert.strictEqual(flowsIntoEdges.length, 2);
  });

  it('should handle member expression RHS', async () => {
    await setupTest(backend, {
      'index.js': `
        let total = 0;
        const item = { price: 10 };
        total += item.price;  // Should create EXPRESSION node for item.price
      `
    });

    // This is EXPRESSION type (member access)
    // Should create EXPRESSION node and FLOWS_INTO edge
    const totalVar = allNodes.find(n => n.name === 'total');
    const flowsIntoEdges = allEdges.filter(e =>
      e.type === 'FLOWS_INTO' && e.dst === totalVar.id
    );

    assert.ok(flowsIntoEdges.length > 0, 'FLOWS_INTO edge not found');
  });

  it('should handle call expression RHS', async () => {
    await setupTest(backend, {
      'index.js': `
        function getPrice() { return 10; }
        let total = 0;
        total += getPrice();  // getPrice() --FLOWS_INTO--> total
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
  });
});
```

**Success metrics**:
- ✅ All arithmetic operators tracked: `+=`, `-=`, `*=`, `/=`, `%=`, `**=`
- ✅ All bitwise operators tracked: `&=`, `|=`, `^=`, `<<=`, `>>=`, `>>>=`
- ✅ All logical operators tracked: `&&=`, `||=`, `??=`
- ✅ Variable RHS: creates edge to source variable
- ✅ Call RHS: creates edge to call node
- ✅ Member RHS: creates EXPRESSION node and edge
- ✅ Multiple reassignments create multiple edges

---

## Phase 3: Edge Metadata (Optional Enhancement)

**Goal**: Store operator type on FLOWS_INTO edge for differentiation.

**Why optional**: Core functionality works without it. Useful for advanced queries.

### Files Changed

#### 1. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location**: `bufferVariableReassignmentEdges` method

**Current code** (end of method):
```typescript
if (sourceNodeId && targetNodeId) {
  this._bufferEdge({
    type: 'FLOWS_INTO',
    src: sourceNodeId,
    dst: targetNodeId
  });
}
```

**Change to**:
```typescript
if (sourceNodeId && targetNodeId) {
  const edge: GraphEdge = {
    type: 'FLOWS_INTO',
    src: sourceNodeId,
    dst: targetNodeId
  };

  // Phase 3: Add operator metadata for differentiation
  if (operator && operator !== '=') {
    // Store compound operator in metadata
    if (!edge.metadata) {
      edge.metadata = {};
    }
    edge.metadata.operator = operator;
  }

  this._bufferEdge(edge);
}
```

**Key detail**: Only store operator if NOT simple assignment (`=`). This keeps metadata clean.

### Phase 3 Acceptance Criteria

**Test case**:
```javascript
it('should store operator in edge metadata for compound assignments', async () => {
  await setupTest(backend, {
    'index.js': `
      let x = 0;
      const a = 5;
      x += a;
    `
  });

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
```

**Success metrics**:
- ✅ Compound operators stored in `metadata.operator`
- ✅ Simple assignment (`=`) has no metadata
- ✅ Metadata doesn't break existing queries
- ✅ Can differentiate additive (`+=`) vs overwrite (`=`) flows

---

## Implementation Order

### Step-by-step execution plan:

1. **Phase 1.1**: Add `VariableReassignmentInfo` interface to types.ts
2. **Phase 1.2**: Add `detectVariableReassignment` method to JSASTAnalyzer.ts (simple `=` only)
3. **Phase 1.3**: Add handler in AssignmentExpression visitor
4. **Phase 1.4**: Add `bufferVariableReassignmentEdges` to GraphBuilder.ts
5. **Phase 1.5**: Update ASTCollections interface
6. **Phase 1.6**: Call buffer method in GraphBuilder.build()
7. **Kent writes tests for Phase 1**
8. **Rob implements Phase 1**
9. **Kevlin + Linus review Phase 1**

10. **Phase 2.1**: Remove `operator === '='` check from handler
11. **Phase 2.2**: Add `operator` field to VariableReassignmentInfo
12. **Phase 2.3**: Capture operator in detectVariableReassignment
13. **Kent writes tests for Phase 2 (all operators)**
14. **Rob implements Phase 2**
15. **Kevlin + Linus review Phase 2**

16. **Phase 3.1**: Add metadata to edge creation in GraphBuilder
17. **Kent writes tests for Phase 3**
18. **Rob implements Phase 3**
19. **Kevlin + Linus review Phase 3**

20. **Steve Jobs demos the feature**
21. **Update Linear issue, create tech debt tickets if needed**

---

## Data Flow Diagram

```
JSASTAnalyzer.ts (ANALYSIS phase)
  │
  ├─ AssignmentExpression handler
  │   └─ detectVariableReassignment()
  │       └─ Populates: collections.variableReassignments[]
  │
  └─ ASTCollections passed to GraphBuilder

GraphBuilder.ts (ENRICHMENT phase)
  │
  ├─ build() method
  │   └─ Step 26.5: bufferVariableReassignmentEdges()
  │
  └─ bufferVariableReassignmentEdges()
      ├─ Lookup source node (variable/call/method)
      ├─ Lookup target node (variable/parameter)
      └─ Buffer FLOWS_INTO edge: source --FLOWS_INTO--> target

RFDB (STORAGE)
  │
  └─ Edges: { type: 'FLOWS_INTO', src: '...', dst: '...', metadata: { operator: '+=' } }
```

---

## Risk Mitigation

### Risk: Literal reassignment not creating nodes

**Problem**: `x = 42` after declaration doesn't create LITERAL node in JSASTAnalyzer.

**Current behavior**:
- VariableVisitor creates LITERAL nodes during initialization
- AssignmentExpression handler doesn't create nodes, only detects patterns

**Solution options**:

**Option A** (preferred): Create LITERAL nodes in GraphBuilder
- In `bufferVariableReassignmentEdges`, check if `valueType === 'LITERAL'`
- If literal doesn't exist, buffer it: `this._bufferNode({ type: 'LITERAL', ... })`
- Matches existing pattern from `bufferAssignmentEdges` (line 998)

**Option B**: Move literal creation to JSASTAnalyzer
- Modify `detectVariableReassignment` to push to `collections.literals`
- More consistent with initialization pattern
- But requires passing literals collection to method

**Decision**: Use Option A for Phase 1. Create tech debt issue for Option B refactoring.

### Risk: Expression reassignment creates duplicate nodes

**Problem**: `x = a + b` creates EXPRESSION node. If same expression appears twice, do we create 2 nodes?

**Current behavior**: Expression IDs include position: `EXPRESSION#${line}:${column}#${file}`

**Solution**: Position-based IDs are already unique. No deduplication needed.

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
- Phase 1-3: Accept limitation (document in code comments)
- Create Linear issue: "REG-XXX: Scope-aware variable lookup for reassignments"
- Tag as `v0.2` (tech debt)

**Mitigation**: Add test case demonstrating current behavior (not blocking).

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

## Test Strategy

### Unit Tests (Kent will create)

**File**: `test/unit/CompoundAssignment.test.js`

**Test groups**:
1. Simple reassignment (`x = y`)
   - Variable source
   - Call source
   - Method call source
   - Literal source

2. Arithmetic operators
   - `+=`, `-=`, `*=`, `/=`, `%=`, `**=`

3. Bitwise operators
   - `&=`, `|=`, `^=`, `<<=`, `>>=`, `>>>=`

4. Logical operators
   - `&&=`, `||=`, `??=`

5. Complex RHS
   - Member expressions: `total += obj.prop`
   - Call expressions: `total += getPrice()`
   - Binary expressions: `total += a + b`

6. Edge cases
   - Multiple reassignments to same variable
   - Reassignment in loop
   - Shadowed variables (document current limitation)

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
- `item.price` --FLOWS_INTO--> total
- `item.discount` --FLOWS_INTO--> total
- total --RETURNS--> calculateTotal

**Query test**:
```javascript
const totalSources = await backend.query(`
  MATCH (source)-[:FLOWS_INTO]->(total:VARIABLE {name: 'total'})
  RETURN source
`);
// Should find: literal(0), item.price, item.discount
```

---

## Performance Analysis

### Complexity

**Time complexity**:
- Per reassignment: O(1) map lookup for variable
- Total: O(R) where R = number of reassignments

**Space complexity**:
- VariableReassignmentInfo: ~200 bytes per reassignment
- Typical file with 10 reassignments: ~2KB

**Comparison**:
- Same as existing mutation handlers (array/object)
- No additional overhead

### Batching

**Current implementation uses buffering**:
- All nodes buffered, then flushed once
- All edges buffered, then flushed once
- No change needed - already optimal

---

## Alignment with Vision

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
Agent: "So total accumulates prices. Got it."
```

**This is exactly Grafema's purpose**: Make data flow queryable, not buried in code syntax.

---

## Conclusion

This plan provides:
- ✅ Exact line numbers and file locations
- ✅ Complete code snippets for each change
- ✅ Clear test cases with expected behavior
- ✅ Step-by-step implementation order
- ✅ Risk mitigation for edge cases
- ✅ Performance analysis
- ✅ Alignment with project vision

**Next step**: Kent writes tests, Rob implements, Kevlin + Linus review.

---

**Joel Spolsky**
Implementation Planner, Grafema
