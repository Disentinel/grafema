# REG-554: Implementation Plan — PROPERTY_ASSIGNMENT Nodes

**Author:** Don Melton, Tech Lead
**Date:** 2026-02-22
**Branch:** task/REG-554

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
- The node→CLASS containment edge direction is a semantic decision that must be made explicitly (see Section 3 below)
- RHS resolution reuses `MutationBuilder` logic but lives in a different builder — must avoid duplication while remaining cohesive

A Single Agent would be appropriate only if this were a single-builder, single-concept change with under 50 LOC. This is not that.

---

## 2. Files to Modify (Exact Paths)

| # | File | Change |
|---|------|--------|
| 1 | `/Users/regina/workspace/grafema-worker-3/packages/types/src/nodes.ts` | Add `PROPERTY_ASSIGNMENT` to `NODE_TYPE`; add `PropertyAssignmentNodeRecord` interface; add to `NodeRecord` union |
| 2 | `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/types.ts` | Add `PropertyAssignmentInfo` interface; add `propertyAssignments?` and `propertyAssignmentCounterRef?` to `ASTCollections` |
| 3 | `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Extend `detectObjectPropertyAssignment()` to also push to `propertyAssignments` collection |
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

**Location:** After `PropertyAccessInfo` (after line 293). Mirror the `PropertyAccessInfo` shape exactly, changing only what differs.

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
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL';
  valueName?: string;              // For VARIABLE type: the RHS variable name
  valueNodeId?: string;            // For LITERAL/OBJECT_LITERAL/ARRAY_LITERAL: pre-resolved node ID
}
```

**Why include `valueType`/`valueName` here:** The RHS is already extracted in `detectObjectPropertyAssignment()` via `extractMutationValue()`. Carrying that info through `PropertyAssignmentInfo` avoids re-parsing in `CoreBuilder`. This matches how `ObjectMutationInfo` carries `value: ObjectMutationValue`.

**Add to `ASTCollections`** (after line 1208, after `propertyAccesses`):

```typescript
// Property assignment tracking for PROPERTY_ASSIGNMENT nodes (REG-554)
propertyAssignments?: PropertyAssignmentInfo[];
// Counter ref for property assignment tracking (REG-554)
propertyAssignmentCounterRef?: CounterRef;
```

---

### STEP 4: Extend `detectObjectPropertyAssignment()` in `JSASTAnalyzer.ts`

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Lines 4184–4286. The method already collects everything needed. We need to add a second push, after the existing `objectMutations.push(...)` at line 4272.

**Change the method signature** to also accept `propertyAssignments`:

```typescript
private detectObjectPropertyAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker,
  propertyAssignments?: PropertyAssignmentInfo[],      // ADD THIS
  propertyAssignmentCounterRef?: CounterRef            // ADD THIS
): void {
```

**After the existing `objectMutations.push(...)` block (after line 4285)**, add:

```typescript
// REG-554: Also collect PROPERTY_ASSIGNMENT node info for 'this.prop = value'
// Only when inside a class context (enclosingClassName must be set)
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
    valueType: valueInfo.valueType,
    valueName: valueInfo.valueName,
    valueNodeId: valueInfo.valueNodeId,
  });
}
```

**Important:** The guard `objectName === 'this' && enclosingClassName` ensures:
1. We only create PROPERTY_ASSIGNMENT for `this.x = value`, not `obj.x = value` (non-`this` cases are tracked by FLOWS_INTO edges only, which is sufficient for the initial scope).
2. Module-level `this.x = value` (where there is no class) is excluded — `enclosingClassName` will be `undefined`.

**Update the two call sites** to pass the new args:

**Call site 1 — module-level** (`JSASTAnalyzer.ts` line 1942):

```typescript
// Before
this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);

// After
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

---

### STEP 5: Update `VariableHandler.ts`

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

Add `PropertyAssignmentInfo` and `CounterRef` to imports at the top of `VariableHandler.ts`.

---

### STEP 6: Add `bufferPropertyAssignmentNodes()` to `CoreBuilder.ts`

**File:** `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts`

**Step 6a: Add import.** Add `PropertyAssignmentInfo` to the import block at the top (line 9–25 area):

```typescript
import type {
  // ... existing imports ...
  PropertyAssignmentInfo,
} from '../types.js';
```

**Step 6b: Destructure from `data` in `buffer()`.** In `buffer()` (lines 31–57), after `classDeclarations = []`:

```typescript
propertyAssignments = [],
```

**Step 6c: Call the new method.** In `buffer()`, after line 52 (`this.bufferPropertyAccessNodes(...)`):

```typescript
this.bufferPropertyAssignmentNodes(module, propertyAssignments, variableDeclarations, parameters, classDeclarations);
```

**Step 6d: Add the method.** Insert after `bufferPropertyAccessNodes()` (after line 299), before `bufferCallbackEdges()`:

```typescript
/**
 * Buffer PROPERTY_ASSIGNMENT nodes, CLASS->CONTAINS edges, and ASSIGNED_FROM edges (REG-554).
 *
 * Creates nodes for property writes (this.prop = value),
 * CONTAINS edges from the owning CLASS node (semantic parent, not syntactic),
 * and ASSIGNED_FROM edges to the source variable or parameter.
 *
 * Only handles this.prop = value inside a class body. Non-this assignments
 * are tracked via FLOWS_INTO edges in MutationBuilder.
 */
private bufferPropertyAssignmentNodes(
  module: ModuleNode,
  propertyAssignments: PropertyAssignmentInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[],
  classDeclarations: ClassDeclarationInfo[]
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
    // Only resolve VARIABLE type in initial implementation (CALL, LITERAL, etc. are future work)
    if (propAssign.valueType === 'VARIABLE' && propAssign.valueName) {
      const scopePath = propAssign.scopePath ?? [];
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
    }

    // Pre-resolved node IDs (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL from valueNodeId)
    if (propAssign.valueNodeId) {
      this.ctx.bufferEdge({
        type: 'ASSIGNED_FROM',
        src: propAssign.id,
        dst: propAssign.valueNodeId,
      });
    }
  }
}
```

**Design decision on edge direction — CLASS CONTAINS PROPERTY_ASSIGNMENT:** The Linear issue description says `CONTAINED_IN → CLASS` (child→parent). The codebase convention is `CONTAINS` (parent→child). The existing `bufferPropertyAccessNodes()` at line 246 uses `CONTAINS` with `src = parentScopeId, dst = propAccess.id`. We must be consistent: `CLASS --CONTAINS--> PROPERTY_ASSIGNMENT`. This is also semantically correct: the class owns the assignment site.

---

## 4. Test Plan (What Kent Should Write)

**File to create:** `/Users/regina/workspace/grafema-worker-3/test/unit/PropertyAssignmentTracking.test.js`

**Pattern to follow:** `ObjectMutationTracking.test.js` — same `setupTest()` helper, same `createTestOrchestrator` + `createTestDatabase` pattern.

### Required test cases

**Test group 1: Basic constructor assignments**

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
6. Each has an `ASSIGNED_FROM` edge to the corresponding PARAMETER node (query: edge `type=ASSIGNED_FROM, src=<node.id>`)

**Test group 2: Assignment in regular method (not constructor)**

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

**Test group 3: Non-`this` assignments do NOT create PROPERTY_ASSIGNMENT nodes**

Fixture:
```javascript
const obj = {};
const handler = () => {};
obj.handler = handler;
```

Assertions:
1. 0 nodes with `type === 'PROPERTY_ASSIGNMENT'` exist
2. FLOWS_INTO edge from `handler` to `obj` still exists (regression guard — must not break existing behavior)

**Test group 4: Module-level `this.x = value` does NOT create a PROPERTY_ASSIGNMENT node**

Fixture:
```javascript
this.globalProp = 'value';
```

Assertions:
1. 0 nodes with `type === 'PROPERTY_ASSIGNMENT'` exist (no class context → no node)

**Test group 5: Semantic ID stability**

Same fixture as Test group 1. Run orchestrator twice on the same code. Assert that the `semanticId` for each PROPERTY_ASSIGNMENT node is identical across both runs. This guards against counter drift.

---

## 5. What NOT to Change — Scope Boundaries

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

---

## 6. Open Questions and Risks

### Risk 1: `computeSemanticIdV2` availability in `JSASTAnalyzer.ts`

`computeSemanticIdV2` is already imported and used in `JSASTAnalyzer.ts` (confirmed by its use in `PropertyAccessVisitor.ts` via shared utilities). Verify the import is present; if not, add it alongside the existing `computeSemanticId` import.

**Mitigation:** Rob must verify the import path before implementing Step 4. `computeSemanticIdV2` is in `SemanticId.ts` — same file as `computeSemanticId`. The import will be `import { computeSemanticIdV2 } from '../../../utils/SemanticId.js'` or equivalent.

### Risk 2: `propertyAssignmentCounterRef` initialization in module-level path

The module-level path in `JSASTAnalyzer.ts` accesses `allCollections` which is the same `ASTCollections` object used by both module-level and function-level analyzers. Initializing `propertyAssignmentCounterRef` once on `allCollections` is correct — it must be shared so the discriminator counter is monotonically increasing across both call sites for the same file.

**Mitigation:** Initialize in the same place as other counterRefs in JSASTAnalyzer.ts (near the start of the analysis loop). Cross-reference how `callSiteCounterRef` is initialized.

### Risk 3: Basename normalization mismatch

Exactly the same constraint as `PROPERTY_ACCESS`. The `classDeclarations` list uses basename (e.g., `service.ts`), but `PropertyAssignmentInfo.file` will be the full path (e.g., `/abs/path/to/service.ts`). The `basename(propAssign.file)` call in `bufferPropertyAssignmentNodes()` handles this — but it must be tested with a fixture where the file is NOT in the project root (a subdirectory file) to confirm the lookup succeeds.

**Mitigation:** Test group 1 fixture should be in a subdirectory, e.g., `src/services/graph.js`, not `index.js`. Kent should include at least one test with a subdirectory path.

### Risk 4: Multiple assignments to the same property

`this.graph = a; this.graph = b;` — two PROPERTY_ASSIGNMENT nodes for the same property name. The `discriminator` from `getItemCounter(PROPERTY_ASSIGNMENT:this.graph)` handles this. Both nodes will have different `id`s. This is correct behavior (each assignment site is distinct). No additional action needed, but a test case would be good for confirmation.

### Open Question: Should `obj.prop = value` (non-`this`) also get PROPERTY_ASSIGNMENT nodes?

The current design gates on `objectName === 'this'`. Non-`this` property writes are already tracked via FLOWS_INTO edges, which is sufficient for data flow queries. If a future task expands PROPERTY_ASSIGNMENT to non-`this` cases, the guard can be removed and the `enclosingClassName` becomes optional (as designed in the interface). No structural changes needed — just remove the `&& enclosingClassName` guard and handle the `CONTAINS` parent differently (use `parentScopeId` instead of `classDecl.id`).

### Open Question: ASSIGNED_FROM for CALL type RHS

`this.graph = buildGraph()` — the RHS is a CALL, not a VARIABLE. The current plan handles `LITERAL` via `valueNodeId` if available, and `VARIABLE` via scope resolution. `CALL` type resolution requires finding the CALL node by line+column (same approach as `AssignmentBuilder.bufferAssignmentEdges()`). This is deferred for V1 — the acceptance criteria only require the constructor-with-3-field-assignments case. If the RHS is a CALL, the PROPERTY_ASSIGNMENT node is still created; only the ASSIGNED_FROM edge is skipped.

---

## 7. Implementation Order Summary

For Rob (implementer):

1. Write tests first (coordinate with Kent on test file)
2. `packages/types/src/nodes.ts` — PROPERTY_ASSIGNMENT to NODE_TYPE + NodeRecord
3. `packages/core/src/plugins/analysis/ast/types.ts` — PropertyAssignmentInfo interface + ASTCollections fields
4. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` — extend `detectObjectPropertyAssignment()` signature and body; update both call sites
5. `packages/core/src/plugins/analysis/ast/handlers/VariableHandler.ts` — initialize collection, pass to detector
6. `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` — add import, destructure, call, implement `bufferPropertyAssignmentNodes()`
7. `pnpm build && node --test test/unit/PropertyAssignmentTracking.test.js`

Each step should leave the build passing. Steps 4 and 5 can be done together (they are the two call sites of the same method change).
