# REG-554: Plan — Index `this.property = value` Assignments as PROPERTY_ASSIGNMENT Nodes

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-22

---

## Executive Summary

Currently `this.x = value` creates a `FLOWS_INTO` edge from the RHS value to the CLASS node — data flow is partially captured but the assignment itself has no first-class graph representation. This makes it impossible to ask "what fields does class Foo have?" or "what is assigned to `this.graph`?".

REG-554 adds a new `PROPERTY_ASSIGNMENT` node type that reifies the assignment as a graph entity, with:
- `ASSIGNED_FROM` edge → the RHS node (the value being assigned)
- `CONTAINS` edge from the owning CLASS node (CLASS → CONTAINS → PROPERTY_ASSIGNMENT, consistent with existing containment patterns)

The `this.x = value` detection already exists in `detectObjectPropertyAssignment` (JSASTAnalyzer.ts:4184). We reuse that detection path rather than adding a new traversal. The implementation adds: (1) a new `PropertyAssignmentInfo` type collected alongside `objectMutations`, (2) a new builder that creates the nodes and edges, (3) node type registration in `packages/types`.

---

## Codebase Understanding

### Existing detection: `detectObjectPropertyAssignment`

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`, lines 4184–4279

This private method is already called from two sites:
- Module-level: `JSASTAnalyzer.ts` line ~1942, inside the `AssignmentExpression` handler for module-level traversal.
- Function-level: `VariableHandler.ts` line 91, via `AnalyzerDelegate`.

It correctly identifies `this.prop = value` assignments, extracts:
- `objectName` ("this")
- `enclosingClassName` (via `scopeTracker.getEnclosingScope('CLASS')`)
- `propertyName`
- `mutationType`
- `value` (via `extractMutationValue`) — distinguishes LITERAL, VARIABLE, CALL, EXPRESSION types

**Key gap:** it records an `ObjectMutationInfo` for `FLOWS_INTO` edges to the CLASS node (handled by `MutationBuilder`). But there is no `PROPERTY_ASSIGNMENT` node being created.

### Existing `FLOWS_INTO` → CLASS (REG-152)

**File:** `packages/core/src/plugins/analysis/ast/builders/MutationBuilder.ts`, lines 170–233

For `this.x = value` (`objectName === 'this'`), `MutationBuilder.bufferObjectMutationEdges` creates:
```
value_node --FLOWS_INTO--> CLASS_node  (with mutationType: 'this_property', propertyName: 'x')
```

This is **preserved** — REG-554 adds NEW nodes/edges on top of the existing behavior, does not replace it.

### VARIABLE node pattern (reference pattern to follow)

VARIABLE nodes are created by `CoreBuilder.bufferVariableEdges` using data from `ASTCollections.variableDeclarations`. The assignment edge (`ASSIGNED_FROM`) is created by `AssignmentBuilder.bufferAssignmentEdges`.

For PROPERTY_ASSIGNMENT, we follow the same split:
- Detection phase (JSASTAnalyzer): collect `PropertyAssignmentInfo` into a new collection
- Build phase: a new `PropertyAssignmentBuilder` creates the nodes and edges

### Edge type `ASSIGNED_FROM`

Already defined in `packages/types/src/edges.ts` line 57. Direction: `PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> <rhs node>` (same as VARIABLE → ASSIGNED_FROM → source).

### Edge type `CONTAINS` (for CLASS → PROPERTY_ASSIGNMENT)

The design spec mentions `CONTAINED_IN → CLASS`. The existing graph schema uses `CONTAINS` (parent→child), not `CONTAINED_IN`. To remain consistent with all existing CONTAINS usage (MODULE→FUNCTION, FUNCTION→SCOPE, CLASS→METHOD, etc.), we use `CLASS --CONTAINS--> PROPERTY_ASSIGNMENT`.

### Node type `PROPERTY_ASSIGNMENT`

Does not exist. Must be added to `NODE_TYPE` in `packages/types/src/nodes.ts` (line 6–48).

### ASTCollections

`packages/core/src/plugins/analysis/ast/types.ts`, line 1154–1238. We add a new optional collection field `propertyAssignments?: PropertyAssignmentInfo[]`.

### TS non-null unwrapping (`options.graph!`)

`extractMutationValue` (`JSASTAnalyzer.ts`, line 4522) does NOT unwrap `TSNonNullExpression`. The RHS of `this.graph = options.graph!` will be classified as `valueType: 'EXPRESSION'`. The `ASSIGNED_FROM` edge will link to an EXPRESSION node. This is acceptable for the first implementation — the acceptance criteria uses `options.graph!` as an example but the test should use a plain identifier for simplicity (like the existing `this.handler = handler` tests).

---

## Plan

### Step 1: Add `PROPERTY_ASSIGNMENT` to `NODE_TYPE`

**File:** `packages/types/src/nodes.ts`
**Location:** line 24 (after `PROPERTY_ACCESS: 'PROPERTY_ACCESS'`)

```ts
// Call graph
CALL: 'CALL',
PROPERTY_ACCESS: 'PROPERTY_ACCESS',
PROPERTY_ASSIGNMENT: 'PROPERTY_ASSIGNMENT',  // NEW (REG-554): this.x = value
```

Also add the interface and add it to the `NodeRecord` union (line 354–381):

```ts
// Property assignment node (this.x = value inside class)
export interface PropertyAssignmentNodeRecord extends BaseNodeRecord {
  type: 'PROPERTY_ASSIGNMENT';
  objectName: string;   // Always 'this'
  className?: string;   // Enclosing class name
}
```

Add `| PropertyAssignmentNodeRecord` to the `NodeRecord` union before `| BaseNodeRecord`.

**File lines:** `packages/types/src/nodes.ts` — ~6 lines added.

---

### Step 2: Add `PropertyAssignmentInfo` type to `types.ts`

**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Location:** After `PropertyAccessInfo` (line 293), before `CallSiteInfo` (line 295)

```ts
// === PROPERTY ASSIGNMENT INFO ===
export interface PropertyAssignmentInfo {
  id: string;
  semanticId?: string;       // Stable ID: file->scope->PROPERTY_ASSIGNMENT->name#N
  type: 'PROPERTY_ASSIGNMENT';
  name: string;              // Property name (e.g., 'graph')
  objectName: string;        // Always 'this'
  enclosingClassName?: string; // Class name from ScopeTracker
  file: string;
  line: number;
  column: number;
  parentScopeId?: string;    // Enclosing function scope ID
  mutationScopePath?: string[]; // Scope path for source node resolution
  // Value info (mirrors ObjectMutationValue)
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL';
  valueName?: string;        // For VARIABLE: name of the variable being assigned
  callLine?: number;         // For CALL: line of call expression
  callColumn?: number;       // For CALL: column of call expression
}
```

Also add `propertyAssignments?: PropertyAssignmentInfo[]` to `ASTCollections` (line ~1188, after `objectMutations`):

```ts
// Property assignment tracking for PROPERTY_ASSIGNMENT nodes (REG-554)
propertyAssignments?: PropertyAssignmentInfo[];
```

**File lines:** `packages/core/src/plugins/analysis/ast/types.ts` — ~20 lines added.

---

### Step 3: Collect `PropertyAssignmentInfo` in `detectObjectPropertyAssignment`

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** Lines 4184–4279 (`detectObjectPropertyAssignment` method)

Change signature to also accept and populate a `PropertyAssignmentInfo[]`:

```ts
private detectObjectPropertyAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker,
  propertyAssignments?: PropertyAssignmentInfo[]  // NEW (REG-554)
): void
```

At the end of the method (after `objectMutations.push({...})`), if `objectName === 'this'` and `enclosingClassName` is defined, also push to `propertyAssignments`:

```ts
// REG-554: Create PROPERTY_ASSIGNMENT node data for 'this.x = value' patterns
if (propertyAssignments && objectName === 'this' && enclosingClassName) {
  const paId = scopeTracker
    ? computeSemanticId('PROPERTY_ASSIGNMENT', `this.${propertyName}`, scopeTracker.getContext(), {
        discriminator: scopeTracker.getItemCounter(`PROPERTY_ASSIGNMENT:this.${propertyName}`)
      })
    : `PROPERTY_ASSIGNMENT#${propertyName}#${module.file}#${line}:${column}`;

  propertyAssignments.push({
    id: paId,
    semanticId: paId,
    type: 'PROPERTY_ASSIGNMENT',
    name: propertyName,
    objectName: 'this',
    enclosingClassName,
    file: module.file,
    line,
    column,
    mutationScopePath: scopePath,
    valueType: valueInfo.valueType,
    valueName: valueInfo.valueName,
    callLine: valueInfo.callLine,
    callColumn: valueInfo.callColumn,
  });
}
```

**Call sites to update:**

1. **Module-level** (JSASTAnalyzer.ts, ~line 1942): Pass `allCollections.propertyAssignments`.

   ```ts
   if (!allCollections.propertyAssignments) {
     allCollections.propertyAssignments = [];
   }
   this.detectObjectPropertyAssignment(
     assignNode, module, objectMutations, scopeTracker,
     allCollections.propertyAssignments  // NEW
   );
   ```

2. **Function-level** (`VariableHandler.ts`, line 91): calls `analyzer.detectObjectPropertyAssignment(...)`. This goes through `AnalyzerDelegate`. Update:
   - `AnalyzerDelegate.ts`: add `propertyAssignments` to the delegate method signature
   - `VariableHandler.ts`: pass `ctx.collections.propertyAssignments` (initialize if needed)

**File lines affected:**
- `JSASTAnalyzer.ts`: ~20 lines modified/added
- `VariableHandler.ts`: ~5 lines
- `AnalyzerDelegate.ts`: ~5 lines

---

### Step 4: Create `PropertyAssignmentBuilder`

**File:** `packages/core/src/plugins/analysis/ast/builders/PropertyAssignmentBuilder.ts` (NEW FILE)

```ts
/**
 * PropertyAssignmentBuilder - creates PROPERTY_ASSIGNMENT nodes and edges.
 *
 * For each 'this.x = value' inside a class method/constructor, creates:
 * - PROPERTY_ASSIGNMENT node (name=property, objectName='this')
 * - CLASS --CONTAINS--> PROPERTY_ASSIGNMENT edge
 * - PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> <rhs node> edge (if rhs is a VARIABLE/PARAMETER)
 *
 * REG-554
 */
import type {
  ModuleNode,
  ASTCollections,
  PropertyAssignmentInfo,
  VariableDeclarationInfo,
  ParameterInfo,
  ClassDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class PropertyAssignmentBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      propertyAssignments = [],
      variableDeclarations = [],
      parameters = [],
      classDeclarations = [],
      callSites = [],
      methodCalls = [],
    } = data;

    this.bufferPropertyAssignments(
      module,
      propertyAssignments,
      variableDeclarations,
      parameters,
      classDeclarations,
      callSites,
      methodCalls
    );
  }

  private bufferPropertyAssignments(
    module: ModuleNode,
    propertyAssignments: PropertyAssignmentInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    classDeclarations: ClassDeclarationInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[]
  ): void {
    for (const pa of propertyAssignments) {
      // Buffer PROPERTY_ASSIGNMENT node
      this.ctx.bufferNode({
        id: pa.id,
        type: 'PROPERTY_ASSIGNMENT',
        name: pa.name,
        objectName: pa.objectName,
        className: pa.enclosingClassName,
        file: pa.file,
        line: pa.line,
        column: pa.column,
        semanticId: pa.semanticId,
      });

      // CLASS --CONTAINS--> PROPERTY_ASSIGNMENT
      if (pa.enclosingClassName) {
        const classDecl = classDeclarations.find(c =>
          c.name === pa.enclosingClassName && c.file === pa.file
        );
        if (classDecl) {
          this.ctx.bufferEdge({
            type: 'CONTAINS',
            src: classDecl.id,
            dst: pa.id
          });
        }
      }

      // PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> <rhs node>
      const scopePath = pa.mutationScopePath ?? [];
      let sourceNodeId: string | null = null;

      if (pa.valueType === 'VARIABLE' && pa.valueName) {
        // Scope-chain lookup: variable first, then parameter
        const sourceVar = this.ctx.resolveVariableInScope(
          pa.valueName, scopePath, pa.file, variableDeclarations
        );
        const sourceParam = !sourceVar
          ? this.ctx.resolveParameterInScope(pa.valueName, scopePath, pa.file, parameters)
          : null;
        sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? null;
      } else if (pa.valueType === 'CALL' && pa.callLine !== undefined && pa.callColumn !== undefined) {
        const callSite = callSites.find(cs =>
          cs.line === pa.callLine && cs.column === pa.callColumn && cs.file === pa.file
        );
        const methodCall = !callSite
          ? methodCalls.find(mc =>
              mc.line === pa.callLine && mc.column === pa.callColumn && mc.file === pa.file
            )
          : null;
        sourceNodeId = callSite?.id ?? methodCall?.id ?? null;
      }
      // LITERAL, EXPRESSION, OBJECT_LITERAL, ARRAY_LITERAL: skip ASSIGNED_FROM edge for now
      // (consistent with MutationBuilder.bufferObjectMutationEdges which also only handles VARIABLE)

      if (sourceNodeId) {
        this.ctx.bufferEdge({
          type: 'ASSIGNED_FROM',
          src: pa.id,
          dst: sourceNodeId
        });
      }
    }
  }
}
```

**File lines:** ~100 lines (new file).

---

### Step 5: Register `PropertyAssignmentBuilder` in `GraphBuilder`

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

1. Import `PropertyAssignmentBuilder` at the top (alongside other builder imports, line 23–34).

2. Add private field `private readonly _propertyAssignmentBuilder: PropertyAssignmentBuilder;`

3. In constructor, instantiate: `this._propertyAssignmentBuilder = new PropertyAssignmentBuilder(ctx);`

4. In the `build()` method, call `this._propertyAssignmentBuilder.buffer(module, data)` after `this._mutationBuilder.buffer(...)`.

**File lines:** ~6 lines added.

---

### Step 6: Export from builders index

**File:** `packages/core/src/plugins/analysis/ast/builders/index.ts`

Add: `export { PropertyAssignmentBuilder } from './PropertyAssignmentBuilder.js';`

**File lines:** 1 line.

---

### Step 7: Write the test

**File:** `test/unit/PropertyAssignmentTracking.test.js` (NEW FILE)

Test structure follows `ObjectMutationTracking.test.js` pattern exactly.

**Test cases:**

1. **Constructor with 3 field assignments, all traced correctly** (acceptance criteria test):
   ```js
   class Config {
     constructor(graph, router, logger) {
       this.graph = graph;
       this.router = router;
       this.logger = logger;
     }
   }
   ```
   Asserts:
   - 3 PROPERTY_ASSIGNMENT nodes with `name` = 'graph', 'router', 'logger'
   - Each has `type === 'PROPERTY_ASSIGNMENT'`
   - CLASS "Config" --CONTAINS--> each PROPERTY_ASSIGNMENT
   - Each PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> the corresponding PARAMETER node

2. **Single this.x = parameter in constructor**:
   ```js
   class Service { constructor(dep) { this.dep = dep; } }
   ```
   Asserts: PROPERTY_ASSIGNMENT "dep" exists with ASSIGNED_FROM → PARAMETER "dep".

3. **this.x = local variable in method**:
   ```js
   class Svc { init() { const helper = () => {}; this.helper = helper; } }
   ```
   Asserts: PROPERTY_ASSIGNMENT "helper" exists with ASSIGNED_FROM → VARIABLE "helper".

4. **this.x = literal — PROPERTY_ASSIGNMENT node created, no ASSIGNED_FROM**:
   ```js
   class Config { constructor() { this.port = 3000; } }
   ```
   Asserts: PROPERTY_ASSIGNMENT "port" exists (the node is created). No ASSIGNED_FROM edge.

5. **this.x = value outside class — NO PROPERTY_ASSIGNMENT created**:
   ```js
   function standalone(x) { this.x = x; }
   ```
   Asserts: 0 PROPERTY_ASSIGNMENT nodes.

6. **CLASS --CONTAINS--> PROPERTY_ASSIGNMENT edge direction**:
   ```js
   class Foo { constructor(bar) { this.bar = bar; } }
   ```
   Asserts: edge with `type === 'CONTAINS'`, `src === classNode.id`, `dst === paNode.id`.

**File lines:** ~180 lines (new file).

---

## Files to Modify

| File | Status | Change |
|------|--------|--------|
| `packages/types/src/nodes.ts` | Modify | Add `PROPERTY_ASSIGNMENT` to `NODE_TYPE` + `PropertyAssignmentNodeRecord` interface + union member (~15 lines) |
| `packages/core/src/plugins/analysis/ast/types.ts` | Modify | Add `PropertyAssignmentInfo` interface + `propertyAssignments?` to `ASTCollections` (~22 lines) |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Modify | Extend `detectObjectPropertyAssignment` signature + populate `propertyAssignments` + update 2 call sites (~25 lines) |
| `packages/core/src/plugins/analysis/ast/handlers/VariableHandler.ts` | Modify | Pass `propertyAssignments` collection to `detectObjectPropertyAssignment` call site (~5 lines) |
| `packages/core/src/plugins/analysis/ast/handlers/AnalyzerDelegate.ts` | Modify | Add `propertyAssignments` to delegate method signature (~5 lines) |
| `packages/core/src/plugins/analysis/ast/builders/PropertyAssignmentBuilder.ts` | New | Full builder implementation (~100 lines) |
| `packages/core/src/plugins/analysis/ast/builders/index.ts` | Modify | Add export for `PropertyAssignmentBuilder` (~1 line) |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Modify | Import + instantiate + call `PropertyAssignmentBuilder` (~6 lines) |
| `test/unit/PropertyAssignmentTracking.test.js` | New | TDD test file (~180 lines) |

**Total new code:** ~359 lines across 9 files (2 new files, 7 modified).

---

## Edge Cases

### 1. `this.x.y = z` — nested LHS (complex base)

`detectObjectPropertyAssignment` already handles this: when `memberExpr.object.type` is neither `Identifier` nor `ThisExpression`, it returns early (line 4215–4217). So `this.x.y = z` (where LHS object is `this.x`, a MemberExpression) is **skipped**. No PROPERTY_ASSIGNMENT created. Documented as known limitation.

### 2. `this[key] = z` — computed property

`detectObjectPropertyAssignment` handles computed properties (lines 4233–4245). When computed and property is an Identifier (variable key), `propertyName = '<computed>'`. We DO create a PROPERTY_ASSIGNMENT with `name === '<computed>'`. This is correct behavior for tracking that an assignment exists, even if we don't know the property name statically.

### 3. `this['literal'] = z` — string literal bracket notation

Handled: property name is the string value (line 4237). PROPERTY_ASSIGNMENT with the literal string as name.

### 4. `this.x += z` — compound assignment

Babel represents `this.x += z` as `AssignmentExpression` with `operator: '+='`. `detectObjectPropertyAssignment` does not check the operator — it processes all AssignmentExpressions with MemberExpression LHS. The RHS is the right side of `+=` (i.e., `z`, NOT the full result). We create a PROPERTY_ASSIGNMENT for this case. The compound nature is not captured in the node, but the `ASSIGNED_FROM` still correctly points to `z`. Acceptable for v1.

### 5. `this.x = value` in standalone function (not in class)

`enclosingClassName` will be `undefined` (ScopeTracker has no enclosing CLASS scope). The guard `if (propertyAssignments && objectName === 'this' && enclosingClassName)` prevents creation. No PROPERTY_ASSIGNMENT node.

### 6. Class file basename vs full path

`ClassDeclarationInfo.file` is set by `ClassVisitor` which passes `module.file` — this is the full path (same as what `detectObjectPropertyAssignment` uses via `module.file`). The `PropertyAssignmentBuilder` looks up `c.file === pa.file` — both are `module.file`. This is correct. (Note: REG-555's `CoreBuilder` had a basename issue because it compared from two different sources; we avoid that by using the same `module.file` throughout.)

### 7. `AnalyzerDelegate` signature update

`AnalyzerDelegate.ts` wraps `JSASTAnalyzer` methods for use by `VariableHandler`. We must add `propertyAssignments?: PropertyAssignmentInfo[]` parameter to `detectObjectPropertyAssignment` in `AnalyzerDelegate` and pass it through. This is a mechanical change.

---

## Implementation Order (Strict)

1. **Write test first** (`test/unit/PropertyAssignmentTracking.test.js`) — all tests RED
2. Add `PROPERTY_ASSIGNMENT` to `NODE_TYPE` in `packages/types/src/nodes.ts` + `PropertyAssignmentNodeRecord` interface
3. Add `PropertyAssignmentInfo` + `propertyAssignments?` to `packages/core/src/plugins/analysis/ast/types.ts`
4. Extend `detectObjectPropertyAssignment` in `JSASTAnalyzer.ts` + update module-level call site
5. Update `AnalyzerDelegate.ts` + `VariableHandler.ts` (function-level call site)
6. Create `PropertyAssignmentBuilder.ts`
7. Register in `GraphBuilder.ts` + `builders/index.ts`
8. `pnpm build` → run tests → all GREEN

---

## Complexity Assessment

- **Time:** Low. The detection is already done; we reuse `detectObjectPropertyAssignment` output. The builder is a simple loop — O(P × (V + Pa)) where P = property assignments, V = variables, Pa = parameters.
- **Space:** O(P) new per-file entries in `propertyAssignments`.
- **Risk:** Low. All changes are additive. The existing `FLOWS_INTO → CLASS` edges from MutationBuilder are preserved. Worst case: new nodes created unnecessarily — but guards prevent that (only when `enclosingClassName` is known).
- **Test coverage:** 6 tests covering happy path, edge cases, and wrong-context suppression.

---

## Not Doing (Out of Scope)

- `this.x.y = z` nested LHS support — existing limitation, follow-up task
- Enrichment-phase linking to TypeScript class property declarations — separate concern
- Reusing VARIABLE with `isField: true` — the design explored this but a distinct type is cleaner for Datalog queries (`type(X, "PROPERTY_ASSIGNMENT")` vs `type(X, "VARIABLE"), attr(X, "isField", true)`)
- `ASSIGNED_FROM` edges for LITERAL/EXPRESSION/OBJECT_LITERAL RHS values — consistent with existing MutationBuilder behavior which also only handles VARIABLE for this.x assignments
