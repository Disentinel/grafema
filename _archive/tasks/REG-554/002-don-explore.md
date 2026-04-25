# REG-554: Don Melton Exploration Report
## Index `this.property = value` assignments as PROPERTY_ASSIGNMENT nodes

**Reviewer:** Don Melton, Tech Lead
**Date:** 2026-02-22
**Branch:** grafema-worker-3 (task/REG-554)

---

## Summary

I explored the entire pipeline from AST traversal to graph write for property access and object mutation. What follows is a precise account of what exists, what's missing, and the exact insertion points for PROPERTY_ASSIGNMENT.

---

## 1. Node Type Definitions

**File:** `/Users/regina/workspace/grafema-worker-3/packages/types/src/nodes.ts`

### What exists

`NODE_TYPE` constant (lines 6-48) has: `PROPERTY_ACCESS` (line 24), `VARIABLE` (line 11), `CONSTANT` (line 13), `EXPRESSION` (line 15), etc.

**`PROPERTY_ASSIGNMENT` does NOT exist.** It is not in `NODE_TYPE`, not in `NAMESPACED_TYPE`, and there is no `PropertyAssignmentNodeRecord` interface.

### What needs to be added

A new entry in `NODE_TYPE`:
```typescript
PROPERTY_ASSIGNMENT: 'PROPERTY_ASSIGNMENT',
```

And a new interface `PropertyAssignmentNodeRecord`:
```typescript
export interface PropertyAssignmentNodeRecord extends BaseNodeRecord {
  type: 'PROPERTY_ASSIGNMENT';
  objectName: string;      // 'this', or object name
  className?: string;      // enclosing class name when objectName === 'this'
  computed?: boolean;      // true for obj[x] = value
}
```

And add it to the `NodeRecord` union (line 354-381) and `ASTCollections` (in `types.ts`).

---

## 2. Edge Type Definitions

**File:** `/Users/regina/workspace/grafema-worker-3/packages/types/src/edges.ts`

### What exists

All relevant edges already exist (lines 6-120):
- `ASSIGNED_FROM` (line 57) — already used for variable init assignments, use for RHS link
- `CONTAINS` (line 8) — already used everywhere for parent->child containment
- `WRITES_TO` (line 59) — semantically: "node writes to target" — possible alternative

**No new edge types are needed.** The issue design says `ASSIGNED_FROM` for RHS link and `CONTAINS` (or `CONTAINED_IN`) for class relationship.

**Decision needed:** The Linear issue says `CONTAINED_IN → CLASS`. The codebase convention is `CONTAINS` (parent→child), not `CONTAINED_IN` (child→parent). Recommend: create edge `CLASS --CONTAINS--> PROPERTY_ASSIGNMENT`, matching all existing containment patterns.

---

## 3. AST Traversal: Where `this.x = value` Is Currently Handled

### Key finding: `this.x = value` IS already detected — just not as a graph node

`this.x = value` is detected in `detectObjectPropertyAssignment()`:

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (lines 4184-4286)

This method:
1. Checks `assignNode.left.type === 'MemberExpression'` (line 4191)
2. When `memberExpr.object.type === 'ThisExpression'` (line 4208): sets `objectName = 'this'` and captures `enclosingClassName` via `scopeTracker.getEnclosingScope('CLASS')` (lines 4208-4213)
3. Captures `enclosingFunctionName` via `scopeTracker.getEnclosingScope('FUNCTION')` (line 4222-4224) — identifies constructor vs method
4. Extracts `propertyName` (lines 4226-4252)
5. Extracts `valueInfo` via `extractMutationValue()` (line 4256)
6. Pushes to `objectMutations` (lines 4272-4285)

**Currently the data ends up in `ObjectMutationInfo` → `MutationBuilder.bufferObjectMutationEdges()` creates only `FLOWS_INTO` edges** to the CLASS node. There is no node created for the assignment itself.

### Where this detection is called from

**Module-level:** `JSASTAnalyzer.ts` line 1942 — called from the `AssignmentExpression` visitor in module traversal.

**Function-body level:** `VariableHandler.ts` line 91 — called from the `AssignmentExpression` handler in `analyzeFunctionBody()` traverse.

Both paths already have access to `scopeTracker` which can provide enclosing class and function context.

---

## 4. How PROPERTY_ACCESS Nodes Are Created (the Pattern to Follow)

### Step 1: Data type definition

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/types.ts` (lines 277-293)

```typescript
export interface PropertyAccessInfo {
  id: string;
  semanticId?: string;
  type: 'PROPERTY_ACCESS';
  objectName: string;
  propertyName: string;
  optional?: boolean;
  computed?: boolean;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  parentScopeId?: string;
  scopePath?: string[];
  enclosingClassName?: string;
}
```

**We need an analogous `PropertyAssignmentInfo` interface.**

### Step 2: Collection in `ASTCollections`

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/types.ts` (lines 1156-1240)

`ASTCollections` has `propertyAccesses?: PropertyAccessInfo[]` (line 1208) and `propertyAccessCounterRef?: CounterRef` (line 1231).

We need to add:
```typescript
propertyAssignments?: PropertyAssignmentInfo[];
propertyAssignmentCounterRef?: CounterRef;
```

### Step 3: Extraction (visitor/handler layer)

`PROPERTY_ACCESS` extraction is in:
- **Module-level:** `PropertyAccessVisitor.ts` (visitor), invoked from `JSASTAnalyzer.ts`
- **Function-level:** `PropertyAccessHandler.ts` (handler), invoked from `analyzeFunctionBody()`

The key static method is `PropertyAccessVisitor.extractPropertyAccesses()` (line 114) — shared by both levels.

**For PROPERTY_ASSIGNMENT**, extraction should happen:
1. In `detectObjectPropertyAssignment()` in `JSASTAnalyzer.ts` — currently only creates `ObjectMutationInfo`. It must also push to `propertyAssignments` when `objectName === 'this'` (or always, depending on scope).
2. Alternatively, a new dedicated method `extractPropertyAssignment()` could be added and called from:
   - `JSASTAnalyzer.ts` line 1942 area (module-level)
   - `VariableHandler.ts` line 91 area (function-body level)

### Step 4: ID generation

`PROPERTY_ACCESS` uses `computeSemanticIdV2()` from `SemanticId.ts`:

```typescript
// PropertyAccessVisitor.ts line 151
id = computeSemanticIdV2(
  'PROPERTY_ACCESS',
  fullName,                      // objectName.propertyName
  module.file,
  scopeTracker.getNamedParent(),
  undefined,
  discriminator
);
```

Same pattern applies to `PROPERTY_ASSIGNMENT` — use `computeSemanticIdV2('PROPERTY_ASSIGNMENT', ...)`.

### Step 5: Graph node and edge buffering

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` (lines 222-298)

Method `bufferPropertyAccessNodes()` (line 222):
1. Calls `this.ctx.bufferNode(...)` with `type: 'PROPERTY_ACCESS'` (line 231-244)
2. Creates `CONTAINS` edge from `propAccess.parentScopeId ?? module.id` to the node (lines 246-252)
3. Creates `READS_FROM` edge: when `objectName === 'this'`, finds `CLASS` node via `classDeclarations.find(...)` (lines 258-274); for regular objects, resolves via scope chain (lines 279-296)

**For PROPERTY_ASSIGNMENT**, we need a similar `bufferPropertyAssignmentNodes()` method that:
1. Buffers the node with `type: 'PROPERTY_ASSIGNMENT'`
2. Creates `CONTAINS` edge from **CLASS node** → PROPERTY_ASSIGNMENT (matching the issue's requirement: "linked to owning CLASS node")
3. Creates `ASSIGNED_FROM` edge: PROPERTY_ASSIGNMENT → RHS node (variable, parameter, literal, etc.)

---

## 5. The `ObjectMutationInfo` / `MutationBuilder` Connection

**Critical insight:** `this.x = value` currently flows through:

1. `detectObjectPropertyAssignment()` → pushes `ObjectMutationInfo` to `objectMutations`
2. `MutationBuilder.bufferObjectMutationEdges()` (lines 171-246) → creates `FLOWS_INTO` edge:
   - src = RHS variable node (e.g., `options` VARIABLE node)
   - dst = CLASS node (for `this.x`) with `mutationType: 'this_property'` and `propertyName`

This creates data-flow edges but **no node for the assignment site itself**. The `PROPERTY_ASSIGNMENT` node is the missing piece between the class and its fields.

**Important:** The existing `FLOWS_INTO` edges should be kept. The new `PROPERTY_ASSIGNMENT` nodes add **extra information** (assignment semantics), they don't replace the mutation tracking.

---

## 6. RHS Node Resolution: What exists for "assigned from"

For `this.x = value`, the RHS value extraction happens in `extractMutationValue()` (called from `detectObjectPropertyAssignment()`, line 4256). This sets `value.valueType`:
- `'VARIABLE'` — when RHS is `Identifier`
- `'CALL'` — when RHS is `CallExpression`
- `'LITERAL'` — when RHS is a literal
- `'OBJECT_LITERAL'`, `'ARRAY_LITERAL'`, `'EXPRESSION'` — other cases

`MutationBuilder.bufferObjectMutationEdges()` currently only creates a `FLOWS_INTO` edge for `valueType === 'VARIABLE'` (line 219). Other types are silently ignored (lines 244 comment: "For literals, object literals, etc. - we just track variable -> object flows for now").

**For `ASSIGNED_FROM`**, we need to handle at minimum `VARIABLE` type for the acceptance criteria. The richer resolution (CALL, LITERAL, etc.) can follow the same patterns as `AssignmentBuilder.bufferAssignmentEdges()`.

---

## 7. Where the `classDeclarations` List Lives

`PROPERTY_ACCESS` uses `classDeclarations` in `CoreBuilder.bufferPropertyAccessNodes()` (line 228). It does:
```typescript
const fileBasename = basename(propAccess.file);
const classDecl = classDeclarations.find(c =>
  c.name === propAccess.enclosingClassName && c.file === fileBasename
);
```

**Note the basename mismatch**: `classDeclarations` use basename (set by `ScopeTracker`), but `propertyAccesses` use the full module path. This is a documented pattern — the same approach must be used for `PROPERTY_ASSIGNMENT`.

---

## 8. Existing Tests for Similar Features

### Tests to study as patterns

| File | What it tests |
|------|--------------|
| `/Users/regina/workspace/grafema-worker-3/test/unit/ObjectMutationTracking.test.js` | `obj.prop = value` → FLOWS_INTO edges |
| `/Users/regina/workspace/grafema-worker-3/test/unit/ClassPrivateMembers.test.js` | Class private fields as VARIABLE nodes |
| `/Users/regina/workspace/grafema-worker-3/test/unit/ClassVisitorClassNode.test.js` | CLASS node creation with semantic IDs |
| `/Users/regina/workspace/grafema-worker-3/test/unit/GraphBuilderClassEdges.test.js` | CLASS-related edge patterns |
| `/Users/regina/workspace/grafema-worker-3/test/unit/VariableAssignmentCoverage.test.js` | ASSIGNED_FROM edge patterns |

**No existing test file for PROPERTY_ASSIGNMENT nodes.** A new test file must be created: `/Users/regina/workspace/grafema-worker-3/test/unit/PropertyAssignmentTracking.test.js`

### Test structure pattern (from ObjectMutationTracking.test.js)

```javascript
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

async function setupTest(backend, files) {
  // create tmpdir, write package.json + files, run orchestrator
  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);
}

describe('Property Assignment Tracking', () => {
  // constructor with 3 field assignments, all traced correctly
});
```

---

## 9. Complete Pipeline Map for PROPERTY_ASSIGNMENT

Here is the exact sequence of files to touch:

### A. Type definitions (new data shape)

**File:** `/Users/regina/workspace/grafema-worker-3/packages/types/src/nodes.ts`
- Add `PROPERTY_ASSIGNMENT: 'PROPERTY_ASSIGNMENT'` to `NODE_TYPE` (after line 24)
- Add `PropertyAssignmentNodeRecord` interface
- Add to `NodeRecord` union

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/types.ts`
- Add `PropertyAssignmentInfo` interface (analogous to `PropertyAccessInfo`, lines 277-293)
- Add `propertyAssignments?: PropertyAssignmentInfo[]` to `ASTCollections` (around line 1208)
- Add `propertyAssignmentCounterRef?: CounterRef` to `ASTCollections`

### B. Extraction (AST layer)

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- In `detectObjectPropertyAssignment()` (line 4184), after building `ObjectMutationInfo`, also push to `propertyAssignments` collection when relevant.
- OR: add a separate `collectPropertyAssignment()` method called alongside `detectObjectPropertyAssignment()`.

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/handlers/VariableHandler.ts`
- In `AssignmentExpression` handler (line 58), call the new collection logic.

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/handlers/AnalyzerDelegate.ts`
- Add method signature for any new delegate method.

### C. Graph building (CoreBuilder or new PropertyAssignmentBuilder)

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts`
- Add `bufferPropertyAssignmentNodes()` method (analogous to `bufferPropertyAccessNodes()`, lines 222-298)
- Call it from `buffer()` (line 52)
- Must accept `classDeclarations` to find the CLASS node for containment

**File:** `/Users/regina/workspace/grafema-worker-3/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
- Pass `propertyAssignments` collection to `CoreBuilder` via the `data: ASTCollections` object (already done — `data` is passed through, so if collection is populated it will be available)

---

## 10. Key Constraints and Surprises

### Constraint 1: `classDeclarations` use basename, not full path

In `CoreBuilder.bufferPropertyAccessNodes()` (line 264):
```typescript
const fileBasename = basename(propAccess.file);
const classDecl = classDeclarations.find(c =>
  c.name === propAccess.enclosingClassName && c.file === fileBasename
);
```
This is because `ScopeTracker` stores only the basename in `classDeclarations`. Must use the same pattern for `PROPERTY_ASSIGNMENT`.

### Constraint 2: `enclosingClassName` and `enclosingFunctionName` are already available

`detectObjectPropertyAssignment()` (lines 4204-4224) already extracts both. `enclosingFunctionName` is captured specifically to distinguish constructor from other methods (REG-557). This data is already in `ObjectMutationInfo` — we can reuse the same detection logic and add `PropertyAssignmentInfo` alongside.

### Constraint 3: Module-level `this.prop = value` is unlikely but handled

The module-level `AssignmentExpression` traversal (line 1942) also calls `detectObjectPropertyAssignment()`. At module level, there's no enclosing class, so `enclosingClassName` will be `undefined`. The collection logic should guard: only create `PROPERTY_ASSIGNMENT` when `enclosingClassName` is set.

### Constraint 4: Node ID generation must use SemanticIdV2

Following `PropertyAccessVisitor.ts` line 151:
```typescript
id = computeSemanticIdV2(
  'PROPERTY_ASSIGNMENT',
  `${objectName}.${propertyName}`,
  module.file,
  scopeTracker.getNamedParent(),
  undefined,
  discriminator
);
```

### Constraint 5: The Linear issue design has an ambiguity

The issue says `CONTAINED_IN → CLASS` but Grafema's convention is `CONTAINS` (parent→child). The correct pattern to follow is `CLASS --CONTAINS--> PROPERTY_ASSIGNMENT`, matching `CoreBuilder.bufferPropertyAccessNodes()` lines 246-252 where `parentScopeId --CONTAINS--> PROPERTY_ACCESS`.

However, for PROPERTY_ASSIGNMENT the "parent scope" should be the CLASS node, not the function scope. This is a deliberate design choice: the assignment lives in the class semantically, even though syntactically it's inside a constructor method.

### Constraint 6: RHS node resolution complexity

`ASSIGNED_FROM` edge requires finding the RHS node. For `this.x = options.graph`, the RHS is a `MemberExpression`, not a simple variable. The initial scope should handle at minimum `VARIABLE` type (simple identifier RHS). The `valueType` is already classified by `extractMutationValue()`.

### Constraint 7: `objectName !== 'this'` cases

The issue is specifically about `this.property = value`. However, the same mechanism could apply to `obj.property = value`. For the initial implementation, scoping to `this` is correct (most impactful for class field data flow). Non-`this` assignments already create `FLOWS_INTO` edges.

---

## 11. Acceptance Criteria Mapping to Code

| Criterion | Code Location |
|-----------|--------------|
| `this.graph = options.graph!` → PROPERTY_ASSIGNMENT node | New logic in `detectObjectPropertyAssignment()` + `bufferPropertyAssignmentNodes()` |
| PROPERTY_ASSIGNMENT + `ASSIGNED_FROM` edge to RHS | `bufferPropertyAssignmentNodes()` — resolve RHS variable, create `ASSIGNED_FROM` edge |
| PROPERTY_ASSIGNMENT linked to owning CLASS node | `bufferPropertyAssignmentNodes()` — find classDecl, create `CONTAINS` edge |
| Unit test: constructor with 3 field assignments | New file: `test/unit/PropertyAssignmentTracking.test.js` |

---

## 12. Recommended Implementation Order

1. Add `PROPERTY_ASSIGNMENT` to `NODE_TYPE` in `packages/types/src/nodes.ts`
2. Add `PropertyAssignmentNodeRecord` interface in same file
3. Add `PropertyAssignmentInfo` interface to `packages/core/src/plugins/analysis/ast/types.ts`
4. Add `propertyAssignments` to `ASTCollections` in same file
5. Extend `detectObjectPropertyAssignment()` in `JSASTAnalyzer.ts` to also populate `propertyAssignments`
6. Add `bufferPropertyAssignmentNodes()` to `CoreBuilder.ts` and wire into `buffer()`
7. Write test file `test/unit/PropertyAssignmentTracking.test.js` first (TDD)

The test should cover:
- Constructor with 3 `this.x = value` assignments → 3 PROPERTY_ASSIGNMENT nodes
- Each PROPERTY_ASSIGNMENT has `CONTAINS` edge from CLASS node
- Each PROPERTY_ASSIGNMENT has `ASSIGNED_FROM` edge to the assigned variable
- Non-`this` assignments are not affected (no spurious PROPERTY_ASSIGNMENT nodes)
