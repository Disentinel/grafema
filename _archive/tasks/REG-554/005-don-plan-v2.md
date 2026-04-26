# REG-554: Implementation Plan v2 — PROPERTY_ASSIGNMENT Nodes

**Author:** Don Melton, Tech Lead
**Date:** 2026-02-22
**Branch:** task/REG-554
**Supersedes:** `003-don-plan.md`
**Incorporates:** Dijkstra verification `004-dijkstra-verification.md` (all blockers fixed)

---

## Summary of Changes from v1

This plan fixes two blockers and incorporates the user decision on AC1:

- **BLOCKER 1 fixed:** `valueNodeId` removed from `PropertyAssignmentInfo` and the dead branch removed from `bufferPropertyAssignmentNodes()`.
- **BLOCKER 2 fixed:** Explicit import statement specified at the exact line in `JSASTAnalyzer.ts`.
- **AC1 decision implemented (option 2):** `this.graph = options.graph!` must produce a PROPERTY_ASSIGNMENT node AND an ASSIGNED_FROM edge pointing to the PROPERTY_ACCESS node for `options.graph`. This requires `TSNonNullExpression` unwrapping and `MemberExpression` handling in `extractMutationValue()`, plus PROPERTY_ACCESS node lookup in `bufferPropertyAssignmentNodes()`.

All other content from v1 is preserved and updated for consistency.

---

## Prior Art: How Industry Tools Model Property Assignment

Before prescribing a specific design, it is worth grounding our choices against established AST analysis tools.

**Joern (Code Property Graph):** Joern models all assignments — including `this.x = value` — as calls to a built-in `<operator>.assignment` node. The LHS (the member expression) and RHS (the value) are both children of that operator call node in the CPG. Data flow is tracked through def-use chains that pass through the assignment operator node. The key insight: *the assignment itself is a first-class node*, not just an edge. Source: [Joern CPG docs](https://docs.joern.io/code-property-graph/).

**CodeQL (JavaScript/TypeScript):** CodeQL exposes `AssignmentExpr` nodes where `.getLhs()` is the target and `.getRhs()` is the source. For `this.prop = value`, the LHS resolves to a `PropAccess` node on `this`. The data-flow library tracks from RHS through the assignment to downstream reads. Source: [CodeQL JS AST classes](https://codeql.github.com/docs/codeql-language-guides/abstract-syntax-tree-classes-for-working-with-javascript-and-typescript-programs/).

**Grafema's design:** We do not model every operator as a node — we selectively add nodes where query value justifies it. `PROPERTY_ASSIGNMENT` follows the same philosophy as `PROPERTY_ACCESS` (REG-395): a node for every write site, enabling "what flows into this class field?" queries. This is sound and aligns with industry practice.

---

## 1. Complexity Assessment

**Verdict: Mini-MLA is correct.** Do not downgrade to Single Agent.

Reasons:
- 6 files must be modified across 3 packages (`types`, `core/analysis/ast/types`, `core/analysis/ast/builders`, `core/analysis/JSASTAnalyzer`, `core/analysis/ast/handlers`)
- 1 new test file with multiple describe blocks
- The `detectObjectPropertyAssignment()` method (lines 4184–4286) already has subtle logic around basename normalization and `this` vs. regular object resolution — any mistake produces silent missing nodes, not crashes
- The node→CLASS containment edge direction is a semantic decision that differs from PROPERTY_ACCESS (see Section 3 below)
- `extractMutationValue()` must now handle `TSNonNullExpression` and `MemberExpression` to satisfy AC1

A Single Agent would be appropriate only if this were a single-builder, single-concept change with under 50 LOC. This is not that.

---

## 2. Files to Modify (Exact Paths)

| # | File | Change |
|---|------|--------|
| 1 | `/Users/regina/workspace/grafema-worker-3/packages/types/src/nodes.ts` | Add `PROPERTY_ASSIGNMENT` to `NODE_TYPE`; add `PropertyAssignmentNodeRecord` interface; add to `NodeRecord` union |
| 2 | `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/types.ts` | Add `PropertyAssignmentInfo` interface (no `valueNodeId`); add `propertyAssignments?` and `propertyAssignmentCounterRef?` to `ASTCollections` |
| 3 | `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Fix import (line 55); extend `extractMutationValue()` with `TSNonNullExpression` + `MemberExpression`; extend `detectObjectPropertyAssignment()` to push to `propertyAssignments` collection |
| 4 | `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/handlers/VariableHandler.ts` | Initialize `propertyAssignments` collection and pass `propertyAssignmentCounterRef` in `AssignmentExpression` handler |
| 5 | `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` | Add `bufferPropertyAssignmentNodes()` method; wire into `buffer()` |
| 6 | `NEW: /Users/regina/workspace/grafema-worker-3/test/unit/PropertyAssignmentTracking.test.js` | Unit tests (written first — TDD) |

**No new edge types are needed.** `ASSIGNED_FROM` (edges.ts line 57) and `CONTAINS` (edges.ts line 8) already exist.

**No changes to** `MutationBuilder.ts`, `GraphBuilder.ts`, `PropertyAccessVisitor.ts`, `AnalyzerDelegate.ts`, or `edges.ts`.

---

## 3. Step-by-Step Implementation

### STEP 0 (TDD): Write the failing test first

**Before touching any source file**, Kent writes the test. The test must fail on the current codebase, then pass after implementation.

See Section 4 (Test Plan) for the full spec.

---

### STEP 1: Add `PROPERTY_ASSIGNMENT` to `NODE_TYPE`

**File:** `packages/types/src/nodes.ts`

**Location:** After line 24 (`PROPERTY_ACCESS: 'PROPERTY_ACCESS',`), in the "Call graph" group.

```typescript
// Call graph
CALL: 'CALL',
PROPERTY_ACCESS: 'PROPERTY_ACCESS',
PROPERTY_ASSIGNMENT: 'PROPERTY_ASSIGNMENT',  // ADD THIS
```

**Rationale:** Grouped with `PROPERTY_ACCESS` because they are the read/write pair of the same concept (member expression on the LHS vs. RHS).

---

### STEP 2: Add `PropertyAssignmentNodeRecord` interface

**File:** `packages/types/src/nodes.ts`

**Location:** After the `PropertyAccessNodeRecord` interface (after line 205).

```typescript
// Property assignment node (this.prop = value, obj.prop = value)
export interface PropertyAssignmentNodeRecord extends BaseNodeRecord {
  type: 'PROPERTY_ASSIGNMENT';
  objectName: string;      // 'this' or the object variable name
  className?: string;      // enclosing class name when objectName === 'this'
  computed?: boolean;      // true for obj[x] = value patterns
}
```

**Note on `className` vs. `enclosingClassName`:** The stored field is `className` (short, matches what you'd query: "which class does this assignment belong to?"). The `Info` struct (AST layer, internal) uses `enclosingClassName` to match the `PropertyAccessInfo` convention. The NodeRecord field name is what ends up in the graph — keep it concise.

**Add to `NodeRecord` union** (after line 363, after `PropertyAccessNodeRecord`):

```typescript
| PropertyAssignmentNodeRecord
```

---

### STEP 3: Add `PropertyAssignmentInfo` interface

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Location:** After `PropertyAccessInfo` (after line 293). Mirror the `PropertyAccessInfo` shape, changing only what differs.

```typescript
// === PROPERTY ASSIGNMENT INFO ===
export interface PropertyAssignmentInfo {
  id: string;
  semanticId?: string;       // Stable ID: file->scope->PROPERTY_ASSIGNMENT->objectName.propertyName#N
  type: 'PROPERTY_ASSIGNMENT';
  objectName: string;        // 'this' or object variable name
  propertyName: string;      // 'graph', '<computed>', etc.
  computed?: boolean;        // true for obj[x] = value
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  parentScopeId?: string;
  scopePath?: string[];
  enclosingClassName?: string;     // class name when objectName === 'this'
  // RHS value info (for ASSIGNED_FROM edge resolution)
  // Note: extractMutationValue() does NOT pre-resolve node IDs. There is no valueNodeId field.
  // LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, CALL, EXPRESSION RHS types produce no ASSIGNED_FROM
  // edge in V1. Only VARIABLE and MEMBER_EXPRESSION are resolved.
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'MEMBER_EXPRESSION';
  valueName?: string;              // For VARIABLE type: the RHS variable name
  // For MEMBER_EXPRESSION type: object and property of the RHS member expression
  // Example: this.graph = options.graph! → memberObject='options', memberProperty='graph'
  memberObject?: string;
  memberProperty?: string;
  // Source line/column of RHS member expression for PROPERTY_ACCESS node lookup
  memberLine?: number;
  memberColumn?: number;
}
```

**Why no `valueNodeId`:** `extractMutationValue()` (JSASTAnalyzer.ts lines 4536–4559) never populates a `valueNodeId`. It only sets `valueType`, `valueName`, `callLine`, `callColumn`, and `literalValue`. The field was in v1 but is dead code — Dijkstra BLOCKER 1 fix. Do not add it.

**Add to `ASTCollections`** (after line 1208, after `propertyAccesses`):

```typescript
// Property assignment tracking for PROPERTY_ASSIGNMENT nodes (REG-554)
propertyAssignments?: PropertyAssignmentInfo[];
// Counter ref for property assignment tracking (REG-554)
propertyAssignmentCounterRef?: CounterRef;
```

---

### STEP 4: Fix import in `JSASTAnalyzer.ts` and extend `extractMutationValue()`

#### Sub-step 4a: Fix the import (BLOCKER 2 fix)

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Line 55 (current import):
```typescript
import { computeSemanticId } from '../../core/SemanticId.js';
```

**Replace with:**
```typescript
import { computeSemanticId, computeSemanticIdV2 } from '../../core/SemanticId.js';
```

This is the same SemanticId module already used by `PropertyAccessVisitor.ts` (which imports from `'../../../../core/SemanticId.js'` — the path differs because JSASTAnalyzer.ts is two levels up from the visitors directory). The path `'../../core/SemanticId.js'` is correct for JSASTAnalyzer.ts — it matches the existing `computeSemanticId` import that is already there.

#### Sub-step 4b: Extend `extractMutationValue()` with TSNonNullExpression and MemberExpression

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** The `extractMutationValue()` method, lines 4536–4559. Currently:

```typescript
private extractMutationValue(value: t.Expression): ObjectMutationValue {
  const valueInfo: ObjectMutationValue = {
    valueType: 'EXPRESSION'  // Default
  };

  const literalValue = ExpressionEvaluator.extractLiteralValue(value);
  if (literalValue !== null) {
    valueInfo.valueType = 'LITERAL';
    valueInfo.literalValue = literalValue;
  } else if (value.type === 'Identifier') {
    valueInfo.valueType = 'VARIABLE';
    valueInfo.valueName = value.name;
  } else if (value.type === 'ObjectExpression') {
    valueInfo.valueType = 'OBJECT_LITERAL';
  } else if (value.type === 'ArrayExpression') {
    valueInfo.valueType = 'ARRAY_LITERAL';
  } else if (value.type === 'CallExpression') {
    valueInfo.valueType = 'CALL';
    valueInfo.callLine = value.loc?.start.line;
    valueInfo.callColumn = value.loc?.start.column;
  }

  return valueInfo;
}
```

**Replace with:**

```typescript
private extractMutationValue(value: t.Expression): ObjectMutationValue {
  const valueInfo: ObjectMutationValue = {
    valueType: 'EXPRESSION'  // Default
  };

  // REG-554: Unwrap TSNonNullExpression before evaluating the inner expression.
  // Handles: this.graph = options.graph! (TSNonNullExpression wrapping a MemberExpression)
  const effectiveValue: t.Expression =
    value.type === 'TSNonNullExpression' ? value.expression : value;

  const literalValue = ExpressionEvaluator.extractLiteralValue(effectiveValue);
  if (literalValue !== null) {
    valueInfo.valueType = 'LITERAL';
    valueInfo.literalValue = literalValue;
  } else if (effectiveValue.type === 'Identifier') {
    valueInfo.valueType = 'VARIABLE';
    valueInfo.valueName = effectiveValue.name;
  } else if (effectiveValue.type === 'ObjectExpression') {
    valueInfo.valueType = 'OBJECT_LITERAL';
  } else if (effectiveValue.type === 'ArrayExpression') {
    valueInfo.valueType = 'ARRAY_LITERAL';
  } else if (effectiveValue.type === 'CallExpression') {
    valueInfo.valueType = 'CALL';
    valueInfo.callLine = effectiveValue.loc?.start.line;
    valueInfo.callColumn = effectiveValue.loc?.start.column;
  } else if (
    effectiveValue.type === 'MemberExpression' &&
    effectiveValue.object.type === 'Identifier' &&
    !effectiveValue.computed &&
    effectiveValue.property.type === 'Identifier'
  ) {
    // REG-554: Simple member expression: options.graph, config.timeout, etc.
    // Only handle the simple (non-computed, identifier-keyed) case.
    // Chained or computed member expressions (a.b.c, obj[key]) fall through to EXPRESSION.
    valueInfo.valueType = 'MEMBER_EXPRESSION';
    valueInfo.memberObject = effectiveValue.object.name;
    valueInfo.memberProperty = effectiveValue.property.name;
    valueInfo.memberLine = effectiveValue.loc?.start.line;
    valueInfo.memberColumn = effectiveValue.loc?.start.column;
  }

  return valueInfo;
}
```

**Note on `ObjectMutationValue` type:** The `ObjectMutationValue` interface in `types.ts` must be extended to carry the new fields. Find the `ObjectMutationValue` interface definition and add:

```typescript
valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'MEMBER_EXPRESSION';
memberObject?: string;     // For MEMBER_EXPRESSION: the object name (e.g., 'options')
memberProperty?: string;   // For MEMBER_EXPRESSION: the property name (e.g., 'graph')
memberLine?: number;       // Source location for PROPERTY_ACCESS node lookup
memberColumn?: number;
```

Locate `ObjectMutationValue` in `types.ts` and update its `valueType` union and add the four new optional fields. Rob: search for `interface ObjectMutationValue` or `ObjectMutationValue` in `types.ts` and update in place.

---

### STEP 5: Extend `detectObjectPropertyAssignment()` in `JSASTAnalyzer.ts`

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Lines 4184–4286.

#### Sub-step 5a: Change the method signature

Current signature (line 4184–4188):
```typescript
private detectObjectPropertyAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker
): void {
```

New signature (add two optional parameters):
```typescript
private detectObjectPropertyAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker,
  propertyAssignments?: PropertyAssignmentInfo[],      // REG-554
  propertyAssignmentCounterRef?: CounterRef            // REG-554
): void {
```

Add `PropertyAssignmentInfo` and `CounterRef` to the imports at the top of `JSASTAnalyzer.ts`. Search for the existing import from `'./ast/types.js'` and add both types if not already present.

#### Sub-step 5b: Add the `propertyAssignments.push(...)` block

**After the existing `objectMutations.push(...)` block (after line 4285)**, add the following block before the closing `}` of the method:

```typescript
// REG-554: Also collect PROPERTY_ASSIGNMENT node info for 'this.prop = value'
// Only when inside a class context (enclosingClassName must be set).
// Non-'this' assignments are tracked by FLOWS_INTO edges only (MutationBuilder).
// Static method 'this.x = value' is included (enclosingClassName is set; known edge case).
if (propertyAssignments && objectName === 'this' && enclosingClassName) {
  let assignmentId: string;
  const fullName = `${objectName}.${propertyName}`;
  if (scopeTracker && propertyAssignmentCounterRef) {
    const discriminator = scopeTracker.getItemCounter(`PROPERTY_ASSIGNMENT:${fullName}`);
    assignmentId = computeSemanticIdV2(
      'PROPERTY_ASSIGNMENT',
      fullName,
      module.file,
      scopeTracker.getNamedParent(),
      undefined,
      discriminator
    );
  } else {
    const cnt = propertyAssignmentCounterRef ? propertyAssignmentCounterRef.value++ : 0;
    assignmentId = `PROPERTY_ASSIGNMENT#${fullName}#${module.file}#${line}:${column}:${cnt}`;
  }

  propertyAssignments.push({
    id: assignmentId,
    semanticId: assignmentId,
    type: 'PROPERTY_ASSIGNMENT',
    objectName,
    propertyName,
    computed: mutationType === 'computed',
    file: module.file,
    line,
    column,
    scopePath,
    enclosingClassName,
    valueType: valueInfo.valueType as PropertyAssignmentInfo['valueType'],
    valueName: valueInfo.valueName,
    memberObject: valueInfo.memberObject,
    memberProperty: valueInfo.memberProperty,
    memberLine: valueInfo.memberLine,
    memberColumn: valueInfo.memberColumn,
  });
}
```

#### Sub-step 5c: Update the call sites

**Call site 1 — module-level AssignmentExpression handler in `JSASTAnalyzer.ts`** (near line 1942):

```typescript
// Before:
this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);

// After:
if (!allCollections.propertyAssignments) {
  allCollections.propertyAssignments = [];
}
if (!allCollections.propertyAssignmentCounterRef) {
  allCollections.propertyAssignmentCounterRef = { value: 0 };
}
this.detectObjectPropertyAssignment(
  assignNode, module, objectMutations, scopeTracker,
  allCollections.propertyAssignments,
  allCollections.propertyAssignmentCounterRef
);
```

Rob: find the exact line by searching for `detectObjectPropertyAssignment` in `JSASTAnalyzer.ts` — there are two call sites. This is the one in the module-level visitor (`allCollections` context). The other is in `VariableHandler.ts` (covered in STEP 6).

---

### STEP 6: Update `VariableHandler.ts`

**File:** `packages/core/src/plugins/analysis/ast/handlers/VariableHandler.ts`

**Location:** Lines 85–91 (the existing `objectMutations` initialization + `detectObjectPropertyAssignment` call).

```typescript
// Initialize object mutations collection if not exists
if (!ctx.collections.objectMutations) {
  ctx.collections.objectMutations = [];
}
const objectMutations = ctx.collections.objectMutations as ObjectMutationInfo[];

// REG-554: Initialize property assignments collection
if (!ctx.collections.propertyAssignments) {
  ctx.collections.propertyAssignments = [];
}
if (!ctx.collections.propertyAssignmentCounterRef) {
  ctx.collections.propertyAssignmentCounterRef = { value: 0 };
}
const propertyAssignments = ctx.collections.propertyAssignments as PropertyAssignmentInfo[];
const propertyAssignmentCounterRef = ctx.collections.propertyAssignmentCounterRef as CounterRef;

// Check for object property assignment: obj.prop = value
analyzer.detectObjectPropertyAssignment(
  assignNode, ctx.module, objectMutations, ctx.scopeTracker,
  propertyAssignments, propertyAssignmentCounterRef
);
```

Add `PropertyAssignmentInfo` and `CounterRef` to the import from `'../types.js'` at the top of `VariableHandler.ts`.

---

### STEP 7: Add `bufferPropertyAssignmentNodes()` to `CoreBuilder.ts`

**File:** `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts`

#### Sub-step 7a: Add import

Add `PropertyAssignmentInfo` to the import block at the top (lines 9–25 area):

```typescript
import type {
  // ... existing imports ...
  PropertyAssignmentInfo,
} from '../types.js';
```

#### Sub-step 7b: Destructure from `data` in `buffer()`

In `buffer()` (lines 31–57), after `classDeclarations = []`, add:

```typescript
propertyAssignments = [],
```

The full destructure block will look like:
```typescript
const {
  functions,
  scopes,
  variableDeclarations,
  callSites,
  methodCalls = [],
  methodCallbacks = [],
  propertyAccesses = [],
  literals = [],
  objectLiterals = [],
  arrayLiterals = [],
  parameters = [],
  classDeclarations = [],
  propertyAssignments = [],   // ADD THIS
} = data;
```

#### Sub-step 7c: Call the new method

In `buffer()`, after line 52 (`this.bufferPropertyAccessNodes(...)`):

```typescript
this.bufferPropertyAssignmentNodes(module, propertyAssignments, variableDeclarations, parameters, classDeclarations, propertyAccesses);
```

Note: `propertyAccesses` is passed so we can look up PROPERTY_ACCESS nodes for MEMBER_EXPRESSION RHS resolution. At this point in `buffer()`, `bufferPropertyAccessNodes()` has already been called (line 52), so those nodes are already buffered in the graph. The lookup here is against the in-memory `PropertyAccessInfo[]` collection (not the graph), so ordering does not matter for the lookup itself.

#### Sub-step 7d: Add the method

Insert after `bufferPropertyAccessNodes()` (after line 299), before `bufferCallbackEdges()`:

```typescript
/**
 * Buffer PROPERTY_ASSIGNMENT nodes, CLASS->CONTAINS edges, and ASSIGNED_FROM edges (REG-554).
 *
 * Creates nodes for property writes (this.prop = value),
 * CONTAINS edges from the owning CLASS node (semantic parent, not syntactic parent),
 * and ASSIGNED_FROM edges to the source node (variable, parameter, or PROPERTY_ACCESS).
 *
 * CONTAINS edge direction note: CLASS --CONTAINS--> PROPERTY_ASSIGNMENT uses the CLASS node
 * as the semantic owner. This differs from PROPERTY_ACCESS CONTAINS edges, which use
 * parentScopeId (the syntactic scope: function, scope, or module). PROPERTY_ASSIGNMENT's
 * parent is always the class because the write site is always inside a class method.
 *
 * Only handles this.prop = value inside a class body. Non-this assignments
 * are tracked via FLOWS_INTO edges in MutationBuilder.
 *
 * ASSIGNED_FROM resolution by valueType:
 *   VARIABLE  → look up VARIABLE or PARAMETER node by name in scope chain
 *   MEMBER_EXPRESSION → look up PROPERTY_ACCESS node by objectName+propertyName+file+line+column
 *   LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, CALL, EXPRESSION → no ASSIGNED_FROM edge in V1
 *     (extractMutationValue() does not pre-resolve node IDs for these types)
 *
 * Known limitation: classDeclarations lookup uses basename comparison (same as bufferPropertyAccessNodes).
 * Two classes with the same name in different directories may match incorrectly.
 * This is a pre-existing constraint, not introduced by REG-554.
 *
 * Known edge case: static method 'this.x = value' will create a PROPERTY_ASSIGNMENT node
 * with className set to the enclosing class. This is unusual JS but semantically acceptable.
 */
private bufferPropertyAssignmentNodes(
  module: ModuleNode,
  propertyAssignments: PropertyAssignmentInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[],
  classDeclarations: ClassDeclarationInfo[],
  propertyAccesses: PropertyAccessInfo[]
): void {
  for (const propAssign of propertyAssignments) {
    // Buffer the PROPERTY_ASSIGNMENT node
    this.ctx.bufferNode({
      id: propAssign.id,
      type: 'PROPERTY_ASSIGNMENT',
      name: propAssign.propertyName,
      objectName: propAssign.objectName,
      className: propAssign.enclosingClassName,
      file: propAssign.file,
      line: propAssign.line,
      column: propAssign.column,
      endLine: propAssign.endLine,
      endColumn: propAssign.endColumn,
      semanticId: propAssign.semanticId,
      computed: propAssign.computed,
    } as GraphNode);

    // CLASS --CONTAINS--> PROPERTY_ASSIGNMENT
    // Use basename for classDeclarations lookup (ScopeTracker stores basename, module.file is full path)
    if (propAssign.enclosingClassName) {
      const fileBasename = basename(propAssign.file);
      const classDecl = classDeclarations.find(c =>
        c.name === propAssign.enclosingClassName && c.file === fileBasename
      );
      if (classDecl) {
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: classDecl.id,
          dst: propAssign.id,
        });
      }
    }

    // PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> RHS node
    const scopePath = propAssign.scopePath ?? [];

    if (propAssign.valueType === 'VARIABLE' && propAssign.valueName) {
      // Resolve VARIABLE: look up variable declaration or parameter in scope chain
      const sourceVar = this.ctx.resolveVariableInScope(
        propAssign.valueName, scopePath, propAssign.file, variableDeclarations
      );
      const sourceParam = !sourceVar
        ? this.ctx.resolveParameterInScope(propAssign.valueName, scopePath, propAssign.file, parameters)
        : null;
      const sourceNodeId = sourceVar?.id ?? sourceParam?.id;

      if (sourceNodeId) {
        this.ctx.bufferEdge({
          type: 'ASSIGNED_FROM',
          src: propAssign.id,
          dst: sourceNodeId,
        });
      }
    } else if (
      propAssign.valueType === 'MEMBER_EXPRESSION' &&
      propAssign.memberObject !== undefined &&
      propAssign.memberProperty !== undefined
    ) {
      // Resolve MEMBER_EXPRESSION: find the PROPERTY_ACCESS node that was created for the
      // RHS member expression (e.g., options.graph in this.graph = options.graph!).
      // The PropertyAccessVisitor creates a PROPERTY_ACCESS node for every member expression
      // read — including RHS expressions. We locate it by objectName + propertyName + file
      // + line/column (the most precise match available without a pre-assigned node ID).
      //
      // Ordering guarantee: bufferPropertyAccessNodes() is called before this method
      // in buffer(), so the PROPERTY_ACCESS node is already buffered in the graph
      // before we create the ASSIGNED_FROM edge here.
      const memberObject = propAssign.memberObject;
      const memberProperty = propAssign.memberProperty;
      const memberLine = propAssign.memberLine;
      const memberColumn = propAssign.memberColumn;

      const propAccessNode = propertyAccesses.find(pa =>
        pa.objectName === memberObject &&
        pa.propertyName === memberProperty &&
        pa.file === propAssign.file &&
        (memberLine === undefined || pa.line === memberLine) &&
        (memberColumn === undefined || pa.column === memberColumn)
      );

      if (propAccessNode) {
        this.ctx.bufferEdge({
          type: 'ASSIGNED_FROM',
          src: propAssign.id,
          dst: propAccessNode.id,
        });
      }
      // If not found: no ASSIGNED_FROM edge, no crash. This can happen if the RHS
      // member expression was not tracked by PropertyAccessVisitor (e.g., filtered out).
    }
    // LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, CALL, EXPRESSION: no ASSIGNED_FROM edge in V1.
    // extractMutationValue() does not pre-resolve node IDs for these types.
    // Future: CALL can be resolved by callLine/callColumn lookup against callSites collection.
  }
}
```

---

## 4. CONTAINS Edge Direction — Verification

**Claim from v1 (confirmed by Dijkstra):** `CLASS --CONTAINS--> PROPERTY_ASSIGNMENT` is the correct direction.

**How `bufferPropertyAccessNodes()` creates its CONTAINS edge (lines 246–252 of CoreBuilder.ts):**
```typescript
// SCOPE/FUNCTION/MODULE -> CONTAINS -> PROPERTY_ACCESS
const containsSrc = propAccess.parentScopeId ?? module.id;
this.ctx.bufferEdge({
  type: 'CONTAINS',
  src: containsSrc,
  dst: propAccess.id
});
```

PROPERTY_ACCESS uses `parentScopeId` (the syntactic scope: the function, scope, or module node). PROPERTY_ASSIGNMENT uses the CLASS node (the semantic owner). These are intentionally different:

- A `this.graph = options.graph` statement inside a constructor is syntactically contained by the constructor function scope. But semantically, the property belongs to the class, not the method.
- Grafema models this consistently: FLOWS_INTO edges from `MutationBuilder` for `this.prop = value` also target the CLASS node (or constructor FUNCTION node per REG-557), not the method scope.
- The PROPERTY_ASSIGNMENT CONTAINS parent is the class, mirroring this semantic ownership.

This difference is by design and is correct. `bufferFunctionEdges()` (lines 59–79) also uses `parentScopeId` for function containment. The PROPERTY_ASSIGNMENT choice of CLASS as CONTAINS source is the odd one out — and intentionally so, because the question "which class owns this assignment?" is more useful than "which scope syntactically contains it?"

**Direction confirmed: `src = classDecl.id, dst = propAssign.id`. Do not reverse.**

---

## 5. MemberExpression RHS and PROPERTY_ACCESS Ordering

**Question:** Does a PROPERTY_ACCESS node for `options.graph` exist at the time PROPERTY_ASSIGNMENT is buffered?

**Answer: Yes.** Here is the ordering:

1. AST traversal phase (JSASTAnalyzer + visitors): All collectors run, populating the `ASTCollections` object. `PropertyAccessVisitor` visits the RHS `options.graph` MemberExpression and pushes a `PropertyAccessInfo` entry into `collections.propertyAccesses`. `detectObjectPropertyAssignment()` visits the `AssignmentExpression` node and pushes a `PropertyAssignmentInfo` entry into `collections.propertyAssignments`. Both entries end up in the same `ASTCollections` object.

2. Builder phase (`CoreBuilder.buffer()`): All builders run against the completed `ASTCollections`. In `buffer()`:
   - Line 52: `this.bufferPropertyAccessNodes(...)` — creates PROPERTY_ACCESS nodes in the graph.
   - After line 52 (new): `this.bufferPropertyAssignmentNodes(...)` — creates PROPERTY_ASSIGNMENT nodes and looks up PROPERTY_ACCESS nodes from the in-memory `propertyAccesses` array.

The MEMBER_EXPRESSION lookup in `bufferPropertyAssignmentNodes()` is against the `PropertyAccessInfo[]` array (in-memory), not the graph. The lookup does not require the graph node to be buffered first — it only needs the `PropertyAccessInfo.id` to construct the ASSIGNED_FROM edge. The actual node buffering order is irrelevant for this lookup.

**Conclusion:** No ordering problem. The lookup is safe regardless of which builder runs first.

---

## 6. Test Plan (What Kent Should Write)

**File to create:** `/Users/regina/workspace/grafema-worker-3/test/unit/PropertyAssignmentTracking.test.js`

**Pattern to follow:** `ObjectMutationTracking.test.js` — same `setupTest()` helper, same `createTestOrchestrator` + `createTestDatabase` pattern.

### Required test cases

**Test group 1: Basic constructor assignments (AC3)**

Fixture:
```javascript
class GraphService {
  constructor(options) {
    this.graph = options.graph;
    this.logger = options.logger;
    this.config = options.config;
  }
}
```

Assertions (after `setupTest`):
1. 3 nodes with `type === 'PROPERTY_ASSIGNMENT'` exist in the graph
2. Their `name` values are `'graph'`, `'logger'`, `'config'`
3. Their `objectName` is `'this'`
4. Their `className` is `'GraphService'`
5. Each has a `CONTAINS` edge inbound from the `GraphService` CLASS node (query: edge `type=CONTAINS, dst=<node.id>`, verify `src === classNode.id`)
6. Each has an `ASSIGNED_FROM` edge (query: edge `type=ASSIGNED_FROM, src=<node.id>`)
7. The `ASSIGNED_FROM` destination for `this.graph` is a PROPERTY_ACCESS node with `objectName='options'` and `name='graph'` (AC1 — MemberExpression resolution)

**Test group 2: TSNonNullExpression unwrapping (AC1)**

Fixture (TypeScript):
```typescript
class GraphService {
  constructor(options: { graph: Graph }) {
    this.graph = options.graph!;
  }
}
```

Assertions:
1. 1 PROPERTY_ASSIGNMENT node exists with `name === 'graph'`
2. Has an `ASSIGNED_FROM` edge
3. The `ASSIGNED_FROM` destination is a PROPERTY_ACCESS node with `objectName='options'` and `name='graph'`
4. No error thrown during analysis (regression: TSNonNullExpression must not crash `extractMutationValue`)

**Test group 3: Assignment in regular method (not constructor)**

Fixture:
```javascript
class Cache {
  setItem(key, value) {
    this.data = value;
  }
}
```

Assertions:
1. 1 PROPERTY_ASSIGNMENT node exists with `name === 'data'`
2. Has `CONTAINS` edge from CLASS node
3. Has `ASSIGNED_FROM` edge pointing to `value` parameter node

**Test group 4: Non-`this` assignments do NOT create PROPERTY_ASSIGNMENT nodes**

Fixture:
```javascript
const obj = {};
const handler = () => {};
obj.handler = handler;
```

Assertions:
1. 0 nodes with `type === 'PROPERTY_ASSIGNMENT'` exist
2. FLOWS_INTO edge from `handler` to `obj` still exists (regression guard — must not break existing behavior)

**Test group 5: Module-level `this.x = value` does NOT create a PROPERTY_ASSIGNMENT node**

Fixture:
```javascript
this.globalProp = 'value';
```

Assertions:
1. 0 nodes with `type === 'PROPERTY_ASSIGNMENT'` exist (no class context → no node)

**Test group 6: Semantic ID stability**

Same fixture as Test group 1. Run orchestrator twice on the same code. Assert that the `id` (semanticId) for each PROPERTY_ASSIGNMENT node is identical across both runs. This guards against counter drift.

Note for Kent: To retrieve `semanticId` from the graph, query by node ID and access the `semanticId` attribute. If the test pattern from `ObjectMutationTracking.test.js` only queries edges, you may need to use `backend.getNode(id)` or equivalent to check node attributes directly.

**Test group 7: LITERAL RHS — PROPERTY_ASSIGNMENT node created, no ASSIGNED_FROM edge**

Fixture:
```javascript
class Config {
  constructor() {
    this.maxRetries = 3;
  }
}
```

Assertions:
1. 1 PROPERTY_ASSIGNMENT node exists with `name === 'maxRetries'`
2. Has `CONTAINS` edge from CLASS node
3. Zero `ASSIGNED_FROM` edges with `src === <node.id>` (no edge for literal RHS in V1)

**Test group 8: Multiple assignments to the same property — both nodes created with distinct IDs**

Fixture:
```javascript
class Foo {
  constructor(a) {
    this.x = a;
  }
  reset(b) {
    this.x = b;
  }
}
```

Assertions:
1. 2 PROPERTY_ASSIGNMENT nodes exist with `name === 'x'`
2. Both have distinct `id` values (discriminator ensures uniqueness)
3. Both have `CONTAINS` edges from the `Foo` CLASS node

---

## 7. What NOT to Change — Scope Boundaries

The following are explicitly out of scope for this task. Do not touch them, do not "improve" them while passing through.

| Out of Scope | Reason |
|---|---|
| `MutationBuilder.bufferObjectMutationEdges()` | The existing FLOWS_INTO edges must remain. We add nodes alongside, not instead of. |
| `PropertyAccessVisitor.ts` / `PropertyAccessHandler.ts` | PROPERTY_ACCESS pipeline is complete and unrelated. |
| `edges.ts` | No new edge types needed. |
| `AnalyzerDelegate.ts` | `detectObjectPropertyAssignment()` is a method on `JSASTAnalyzer` called directly — no delegate indirection needed for this change. |
| `GraphBuilder.ts` | `data: ASTCollections` is passed through wholesale to builders. If `propertyAssignments` is populated in the collection, `CoreBuilder` will receive it without any change to `GraphBuilder`. |
| `obj.prop = value` (non-`this`) | Tracked by FLOWS_INTO only. PROPERTY_ASSIGNMENT nodes are only for `this.prop = value` in V1. |
| Enrichment / semantic resolution phases | No enrichment changes needed — all resolution happens at graph-build time using scope chain. |
| `computeSemanticIdV2` internals | Use as-is, same call pattern as `PropertyAccessVisitor.ts` line 151. |
| CALL, EXPRESSION, OBJECT_LITERAL, ARRAY_LITERAL RHS | No ASSIGNED_FROM edge in V1. These are explicitly deferred. |

---

## 8. Edge Cases and Their Behavior

| Case | Behavior | Correct? |
|------|----------|----------|
| `this.x = value` at module level (no class) | `enclosingClassName` is `undefined`; guard fails; no PROPERTY_ASSIGNMENT node | Correct |
| `this.x = value` in derived class method | `enclosingClassName` = derived class name; node created with derived class | Correct |
| `this.x = value` in static method | `enclosingClassName` set; node created (unusual but valid JS; documented in code comment) | Acceptable for V1 |
| `this.x = value` in class field initializer | Not an `AssignmentExpression`; `detectObjectPropertyAssignment` never called; no node | Correct (by design) |
| `this['x'] = value` (string literal key) | `mutationType = 'property'`, `computed: false`, `propertyName = 'x'` — produces normal node | Correct |
| `this[key] = value` (computed key) | `mutationType = 'computed'`, `propertyName = '<computed>'` | Correct |
| `obj.prop = value` (non-`this`) | Guard `objectName === 'this'` fails; no PROPERTY_ASSIGNMENT node | Correct (in-scope) |
| RHS = VARIABLE (identifier) | `valueType: 'VARIABLE'`, `valueName` set; ASSIGNED_FROM edge resolved via scope | Correct |
| RHS = LITERAL (string/number/bool/null) | `valueType: 'LITERAL'`; no ASSIGNED_FROM edge in V1 | Correct |
| RHS = CALL expression | `valueType: 'CALL'`; no ASSIGNED_FROM edge in V1 | Correct |
| RHS = MemberExpression (`this.x = options.graph`) | `valueType: 'MEMBER_EXPRESSION'`; ASSIGNED_FROM edge to PROPERTY_ACCESS node | Correct (AC1) |
| RHS = `options.graph!` (TSNonNullExpression) | Unwrapped to MemberExpression; same as above | Correct (AC1) |
| RHS = `this.y` (self-reference) | `valueType: 'MEMBER_EXPRESSION'`; ASSIGNED_FROM edge to PROPERTY_ACCESS node for `this.y` | Correct |
| RHS = `a.b.c` (chained) | `effectiveValue.object.type !== 'Identifier'`; falls through to `'EXPRESSION'`; no ASSIGNED_FROM edge | Correct for V1 |
| RHS = `new Foo()` | `valueType: 'EXPRESSION'`; no ASSIGNED_FROM edge | Correct for V1 |
| RHS = template literal | `valueType: 'EXPRESSION'`; no ASSIGNED_FROM edge | Correct for V1 |
| MEMBER_EXPRESSION: PROPERTY_ACCESS node not found | `propAccessNode` is `undefined`; no ASSIGNED_FROM edge; no crash | Correct |
| Variable not found in scope | `sourceVar` and `sourceParam` both `null`; no ASSIGNED_FROM edge; no crash | Correct |
| Two classes with same basename | Wrong CLASS node may be linked by `classDeclarations.find()` | Known limitation, pre-existing |
| Two properties with same name in same class, different methods | Different `getNamedParent()`; distinct semantic IDs | Correct |
| Constructor vs method assignment of same property | Different `getNamedParent()`; distinct semantic IDs | Correct |
| No CLASS node exists yet when PROPERTY_ASSIGNMENT buffered | `classDecl` is `undefined`; CONTAINS edge silently skipped | Correct (same as PROPERTY_ACCESS) |

---

## 9. Implementation Order Summary

For Rob (implementer):

1. Write tests first (coordinate with Kent on test file) — all test groups must fail before implementation
2. `packages/types/src/nodes.ts` — PROPERTY_ASSIGNMENT to NODE_TYPE + PropertyAssignmentNodeRecord + NodeRecord union
3. `packages/core/src/plugins/analysis/ast/types.ts` — ObjectMutationValue union extension (add MEMBER_EXPRESSION + 4 new fields); PropertyAssignmentInfo interface (no valueNodeId); ASTCollections fields
4. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`:
   - Sub-step 4a: Fix line 55 import (`computeSemanticId, computeSemanticIdV2`)
   - Sub-step 4b: Extend `extractMutationValue()` with TSNonNullExpression unwrapping and MemberExpression case
   - Sub-step 5a: Extend `detectObjectPropertyAssignment()` signature
   - Sub-step 5b: Add `propertyAssignments.push(...)` block after `objectMutations.push(...)`
   - Sub-step 5c: Update module-level call site
5. `packages/core/src/plugins/analysis/ast/handlers/VariableHandler.ts` — initialize collection, update call site
6. `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts`:
   - Sub-step 7a: Add `PropertyAssignmentInfo` import
   - Sub-step 7b: Destructure `propertyAssignments` from `data` in `buffer()`
   - Sub-step 7c: Call `bufferPropertyAssignmentNodes()` in `buffer()`
   - Sub-step 7d: Implement `bufferPropertyAssignmentNodes()` method
7. `pnpm build && node --test test/unit/PropertyAssignmentTracking.test.js`

Each step should leave the build passing. Steps 4 (JSASTAnalyzer changes) and 5 (VariableHandler) can be done together as they are tightly coupled call sites of the same method change.

**Minimum viable build order:** types → core/ast/types.ts → JSASTAnalyzer.ts → VariableHandler.ts → CoreBuilder.ts → tests pass.
