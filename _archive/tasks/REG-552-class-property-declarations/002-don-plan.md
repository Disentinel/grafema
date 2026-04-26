# REG-552: Index Class Property Declarations — Don Melton Plan

**Date:** 2026-02-22
**Author:** Don Melton (Tech Lead)
**Status:** Ready for implementation

---

## Phase 1: Red Flag Check

No red flags. This is a straightforward missing-feature: class field declarations (non-function `ClassProperty` nodes with TypeScript access modifiers like `private`, `public`, `protected`) are currently silently dropped. The `ClassPrivateProperty` case (JS private `#field` syntax) already creates VARIABLE nodes via REG-271; this task extends the same pattern to TypeScript-style modifier fields. The approach is fully aligned with the existing architecture.

One design question resolved: the task description says "e.g. `CLASS_PROPERTY` or `VARIABLE` with modifier metadata." After exploration, the correct choice is to reuse `VARIABLE` (with `isClassProperty: true` and metadata), matching exactly what REG-271 did for `#privateField`. A new `CLASS_PROPERTY` node type would introduce unnecessary complexity and break the existing HAS_PROPERTY edge infrastructure.

---

## Phase 2: Exploration Findings

### What Currently Happens for TypeScript Class Fields

`ClassVisitor.ts` has a `ClassProperty` handler (lines 249–334 for `ClassDeclaration`, lines 728–781 for `ClassExpression`). That handler currently has TWO code paths:

1. **If value is a function** (`ArrowFunctionExpression` or `FunctionExpression`) → creates a FUNCTION node and processes it. Correct. Already works.

2. **If value is NOT a function** → falls through with no action. **This is the gap.** The field is completely ignored.

The gap exists because the handler only checks `if (propNode.value && (... === 'ArrowFunctionExpression' || ...))` and does nothing in the else case for non-function-valued properties.

For `ClassPrivateProperty` (the `#field` syntax), REG-271 added an explicit `else` branch (lines 544–579) that creates a VARIABLE node with `isClassProperty: true` and pushes the ID to `currentClass.properties`. That pattern is the exact model to follow.

### TypeScript Modifier Information in Babel AST

Babel's `ClassProperty` node (and its parent `@babel/types`) exposes:

- `propNode.accessibility`: `"public"` | `"private"` | `"protected"` | `undefined`
  - `undefined` means the modifier was omitted (implicit `public` in TypeScript)
- `propNode.readonly`: `boolean` — true for `readonly` fields
- `propNode.static`: `boolean` — true for `static` fields
- `propNode.typeAnnotation`: a `TSTypeAnnotation` AST node if a type was declared (e.g., `private graph: GraphBackend`)
  - The actual type string is at `propNode.typeAnnotation.typeAnnotation` (the outer one is the wrapper, the inner one is the type node itself)
  - The existing `typeNodeToString()` helper in `TypeScriptVisitor.ts` can convert it to a string

The `ClassPrivateProperty` node does not have an `accessibility` field (JS private fields have no access modifiers), so that case is handled differently.

### How Nodes Enter the Graph — Full Pipeline

The pipeline for `ClassProperty` non-function fields is a three-stage process:

**Stage 1 — Collection** (`ClassVisitor.ts`): Field info is pushed to `collections.variableDeclarations` as a `VariableDeclarationInfo` with `isClassProperty: true` and `parentScopeId: currentClass.id`. The field ID is also pushed to `currentClass.properties[]` for edge creation later.

**Stage 2 — Node buffering** (`GraphBuilder.ts`, lines 275–278): ALL items in `variableDeclarations` are buffered as graph nodes via `this._bufferNode(varDecl as unknown as GraphNode)`. The `CoreBuilder.bufferVariableEdges()` only controls edge creation — it skips `DECLARES` edges for class properties (`if (isClassProperty) continue`) but does not affect node creation. Node creation happens unconditionally in `GraphBuilder`'s main loop.

**Stage 3 — Edge buffering** (`TypeSystemBuilder.ts`, `bufferClassDeclarationNodes()`, lines 94–103): For each ID in `currentClass.properties`, creates a `CLASS -> HAS_PROPERTY -> VARIABLE` edge.

### Current REG-271 Pattern (ClassPrivateProperty non-function)

```typescript
// In ClassVisitor, ClassPrivateProperty handler, else branch (lines 544–579):
const variableId = computeSemanticIdV2('VARIABLE', displayName, module.file, scopeTracker.getNamedParent());

if (!currentClass.properties) currentClass.properties = [];
currentClass.properties.push(variableId);

(collections.variableDeclarations as VariableDeclarationInfo[]).push({
  id: variableId,
  semanticId: variableId,
  type: 'VARIABLE',
  name: displayName,
  file: module.file,
  line: propLine,
  column: propColumn,
  isPrivate: true,
  isStatic: propNode.static || false,
  isClassProperty: true,
  parentScopeId: currentClass.id
});
```

TypeSystemBuilder then creates the `HAS_PROPERTY` edge (line 94–103):
```typescript
if (properties) {
  for (const propertyId of properties) {
    this.ctx.bufferEdge({ type: 'HAS_PROPERTY', src: id, dst: propertyId });
  }
}
```

---

### Where Variable Nodes Are Buffered — CONFIRMED

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`, lines 275–278:

```typescript
// 3. Buffer variables (keep parentScopeId on node for queries)
for (const varDecl of variableDeclarations) {
  this._bufferNode(varDecl as unknown as GraphNode);
}
```

VARIABLE nodes are buffered directly in `GraphBuilder.ts` by passing the `VariableDeclarationInfo` object as a `GraphNode`. **All fields on `varDecl` become top-level fields on the graph node.** This means `modifier` and `tsType` added to `VariableDeclarationInfo` would appear as top-level node properties, not nested under `metadata`.

**The task requires `metadata.modifier` and `metadata.type`**, not top-level properties. Therefore, the variable buffering loop in `GraphBuilder.ts` must be enhanced to move `modifier` and `tsType` into `metadata` — exactly as lines 207–226 do for FUNCTION nodes (`invokesParamIndexes` → `metadata.invokesParamIndexes`).

This is the established pattern:
```typescript
// 1. Buffer all functions (without edges)
// REG-401: Strip invokesParamIndexes from node data and store in metadata
for (const func of functions) {
  const { invokesParamIndexes: _invokesParamIndexes, ...funcData } = func;
  const node = funcData as GraphNode;
  if (_invokesParamIndexes?.length > 0) {
    if (!node.metadata) node.metadata = {};
    (node.metadata as Record<string, unknown>).invokesParamIndexes = _invokesParamIndexes;
  }
  this._bufferNode(node);
}
```

---

## Phase 3: Implementation Plan

### Design Decision: Reuse VARIABLE NodeType

Do NOT add a new `CLASS_PROPERTY` node type to `NODE_TYPE` in `packages/types/src/nodes.ts`. The task description explicitly says "e.g. `CLASS_PROPERTY` or `VARIABLE` with modifier metadata." VARIABLE with metadata is the right choice because:

1. The REG-271 pattern (for `#privateField`) already established this precedent
2. `HAS_PROPERTY` edges already connect CLASS nodes to VARIABLE nodes for class fields
3. Adding a new node type requires updating `NODE_TYPE`, `NodeRecord` union, and potentially query/filter code — unnecessary complexity
4. Modifier info goes into `metadata` field on `BaseNodeRecord`, which is already `Record<string, unknown>`
5. Type annotation goes into `metadata.type`

### What to Store in VariableDeclarationInfo

The existing `VariableDeclarationInfo` type (in `packages/core/src/plugins/analysis/ast/types.ts`) supports arbitrary extra fields via `[key: string]: unknown` on the base. For passing modifier and type to the graph, we should store them in the `metadata` object.

However, `VariableDeclarationInfo` does not currently have a `metadata` field. The cleanest approach is to add optional metadata fields directly to `VariableDeclarationInfo`, matching how `FunctionNodeRecord` stores `controlFlow` at the top level of the interface. Alternatively, add a `metadata` field to `VariableDeclarationInfo`.

Actually: the **simplest and most consistent** approach is to add optional `modifier` and `tsType` fields to `VariableDeclarationInfo` and let the node-buffering code translate them into the `metadata` field when creating the graph node.

Looking at how the graph builder handles the translation: for VARIABLE nodes created via `variableDeclarations`, the code that calls `bufferNode()` must translate the `VariableDeclarationInfo` to a `GraphNode`. That's where `metadata.modifier` and `metadata.type` would be set.

### Concrete Changes

#### Change 1: Add modifier/tsType fields to `VariableDeclarationInfo`

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Location:** `VariableDeclarationInfo` interface (lines 247–262)

Add:
```typescript
export interface VariableDeclarationInfo {
  // ... existing fields ...
  isPrivate?: boolean;
  isStatic?: boolean;
  isClassProperty?: boolean;
  // NEW: TypeScript modifier and type annotation for class properties
  modifier?: 'private' | 'public' | 'protected' | 'readonly';
  tsType?: string;   // TypeScript type annotation as string (e.g., "GraphBackend")
}
```

#### Change 2: Handle non-function ClassProperty in ClassVisitor (ClassDeclaration handler)

**File:** `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

**Location:** `ClassProperty` handler inside `ClassDeclaration` traversal (line 249)

Current code:
```typescript
// Only process if value is a function
if (propNode.value &&
    (propNode.value.type === 'ArrowFunctionExpression' ||
     propNode.value.type === 'FunctionExpression')) {
  // ... function handling ...
}
// ← NO ELSE BRANCH — fields with no function value are silently dropped
```

Add an `else` branch after the function-handling `if`:
```typescript
} else {
  // Non-function class property (field declaration)
  // Only process if key is a simple identifier (skip computed keys: class { [Symbol.iterator]() {} })
  if (propNode.key.type !== 'Identifier') return;

  const fieldId = computeSemanticIdV2('VARIABLE', propName, module.file, scopeTracker.getNamedParent());

  // Track in class.properties for HAS_PROPERTY edge
  if (!currentClass.properties) currentClass.properties = [];
  currentClass.properties.push(fieldId);

  // Determine modifier
  const propNodeTyped = propNode as ClassProperty & {
    accessibility?: 'public' | 'private' | 'protected';
    readonly?: boolean;
  };
  const modifier: 'private' | 'public' | 'protected' | 'readonly' | undefined =
    propNodeTyped.readonly
      ? 'readonly'
      : propNodeTyped.accessibility ?? 'public';

  // Extract TypeScript type annotation
  const typeAnnotationNode = (propNode as any).typeAnnotation?.typeAnnotation;
  const tsType = typeAnnotationNode ? typeNodeToString(typeAnnotationNode) : undefined;

  (collections.variableDeclarations as VariableDeclarationInfo[]).push({
    id: fieldId,
    semanticId: fieldId,
    type: 'VARIABLE',
    name: propName,
    file: module.file,
    line: propLine,
    column: propColumn,
    isStatic: propNode.static || false,
    isClassProperty: true,
    parentScopeId: currentClass.id,
    modifier,
    tsType,
  });
}
```

The same change must be applied to the **`ClassExpression` handler** (line 728) which contains a duplicate `ClassProperty` block. Both `ClassDeclaration` and `ClassExpression` handlers need the else branch.

#### Change 3: Move modifier and tsType into metadata in GraphBuilder variable buffering loop

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location:** Lines 275–278 (the variable buffering loop)

Current code:
```typescript
// 3. Buffer variables (keep parentScopeId on node for queries)
for (const varDecl of variableDeclarations) {
  this._bufferNode(varDecl as unknown as GraphNode);
}
```

Replace with:
```typescript
// 3. Buffer variables (keep parentScopeId on node for queries)
// REG-552: Move modifier and tsType into metadata for class property fields
for (const varDecl of variableDeclarations) {
  const { modifier: _modifier, tsType: _tsType, ...varData } = varDecl;
  const node = varData as unknown as GraphNode;
  if (_modifier || _tsType) {
    if (!node.metadata) node.metadata = {};
    if (_modifier) (node.metadata as Record<string, unknown>).modifier = _modifier;
    if (_tsType) (node.metadata as Record<string, unknown>).type = _tsType;
  }
  this._bufferNode(node);
}
```

This mirrors exactly the REG-401 pattern used for FUNCTION nodes at lines 207–226.

#### Change 4: Import `typeNodeToString` in ClassVisitor

**File:** `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

Currently imports from `TypeScriptVisitor.ts`:
```typescript
import { extractTypeParameters } from './TypeScriptVisitor.js';
```

Add:
```typescript
import { extractTypeParameters, typeNodeToString } from './TypeScriptVisitor.js';
```

Verify `typeNodeToString` is exported from `TypeScriptVisitor.ts` (it is — it's the helper used by InterfaceProperty handling at line 305).

#### Change 5: Unit Test

**File:** `test/unit/plugins/analysis/ast/class-property-declarations.test.ts` (new file)

Test structure (follows `property-access.test.ts` pattern):

```typescript
describe('Class Property Declarations (REG-552)', () => {
  describe('TypeScript modifier fields', () => {
    it('should create VARIABLE nodes for class fields with modifiers', async () => {
      await setupTest(backend, {
        'index.ts': `
class MyService {
  private graph: GraphBackend;
  protected config: OrchestratorOptions;
  public name: string;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const varNodes = allNodes.filter(n => n.type === 'VARIABLE' && n.isClassProperty);

      assert.strictEqual(varNodes.length, 3, 'Should have 3 VARIABLE nodes for class fields');

      const graphField = varNodes.find(n => n.name === 'graph');
      assert.ok(graphField, 'Should have VARIABLE node for "graph"');
      assert.strictEqual(graphField.metadata?.modifier, 'private');
      assert.strictEqual(graphField.metadata?.type, 'GraphBackend');

      const configField = varNodes.find(n => n.name === 'config');
      assert.ok(configField, 'Should have VARIABLE node for "config"');
      assert.strictEqual(configField.metadata?.modifier, 'protected');

      const nameField = varNodes.find(n => n.name === 'name');
      assert.ok(nameField, 'Should have VARIABLE node for "name"');
      assert.strictEqual(nameField.metadata?.modifier, 'public');
    });

    it('should store correct line and column', async () => {
      await setupTest(backend, {
        'index.ts': `
class Foo {
  private x: number;
}
        `
      });
      const allNodes = await backend.getAllNodes();
      const xField = allNodes.find(n => n.type === 'VARIABLE' && n.name === 'x');
      assert.ok(xField, 'Should have VARIABLE node');
      assert.strictEqual(xField.line, 3); // line 3 in source
      assert.ok(typeof xField.column === 'number');
    });

    it('should create HAS_PROPERTY edge from CLASS to field VARIABLE', async () => {
      await setupTest(backend, {
        'index.ts': `
class Bar {
  private value: string;
}
        `
      });
      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Bar');
      const fieldNode = allNodes.find(n => n.type === 'VARIABLE' && n.name === 'value');

      assert.ok(classNode, 'Should have CLASS node');
      assert.ok(fieldNode, 'Should have VARIABLE node');

      const edges = await backend.getOutgoingEdges(classNode.id);
      const hasPropEdge = edges.find(e => e.type === 'HAS_PROPERTY' && e.dst === fieldNode.id);
      assert.ok(hasPropEdge, 'Should have HAS_PROPERTY edge from CLASS to VARIABLE');
    });

    it('should handle readonly modifier', async () => {
      await setupTest(backend, {
        'index.ts': `
class Config {
  readonly maxRetries: number;
}
        `
      });
      const allNodes = await backend.getAllNodes();
      const field = allNodes.find(n => n.type === 'VARIABLE' && n.name === 'maxRetries');
      assert.ok(field, 'Should have VARIABLE node for readonly field');
      assert.strictEqual(field.metadata?.modifier, 'readonly');
    });

    it('should not create nodes for function-valued class properties (those become FUNCTION)', async () => {
      await setupTest(backend, {
        'index.ts': `
class Baz {
  private handler = () => {};
  private value: string;
}
        `
      });
      const allNodes = await backend.getAllNodes();
      const functionNodes = allNodes.filter(n => n.type === 'FUNCTION' && n.name === 'handler');
      assert.ok(functionNodes.length >= 1, 'Arrow function class property creates FUNCTION node');

      const varNodes = allNodes.filter(n => n.type === 'VARIABLE' && n.isClassProperty);
      // Only "value" should produce a VARIABLE node, not "handler"
      assert.strictEqual(varNodes.length, 1, 'Only non-function fields produce VARIABLE nodes');
      assert.strictEqual(varNodes[0].name, 'value');
    });
  });
});
```

---

## Phase 4: Risk Assessment

### Risk 1: TypeScript `accessibility` field not in `@babel/types` typings

**Probability:** Low. Babel's `ClassProperty` type in `@babel/types` may not include `accessibility` and `readonly` in its TypeScript type definition (they are parsed but might only appear in `@babel/types` as part of the `ClassAccessorProperty` or via a looser type). The code currently casts with `as any` for similar patterns throughout `ClassVisitor.ts` (e.g., `(classNode as any).typeParameters`).

**Mitigation:** Cast `propNode` with `as ClassProperty & { accessibility?: 'public' | 'private' | 'protected'; readonly?: boolean }` as shown in the implementation plan. This is consistent with how other TypeScript-specific fields are accessed in the codebase.

### Risk 2: ClassExpression handler duplication

**Probability:** High (will happen). The `ClassExpression` handler (line 668–836) duplicates the `ClassDeclaration` traversal logic for `ClassProperty`. The same `else` branch must be added there too. If missed, fields on anonymous class expressions (common in React patterns) will not be indexed.

**Mitigation:** Review the full `ClassVisitor.ts` — the `ClassExpression` `ClassProperty` handler is at lines 728–781 and the function-only check is at line 738. Add the same `else` branch.

### Risk 3: Snapshot test failures

**Probability:** High. Adding new nodes will cause existing snapshot tests to fail as the node count and HAS_PROPERTY edge count changes for any fixture that has TypeScript class fields with modifiers.

**Mitigation:** Run all snapshot tests after implementation, review failures, and regenerate snapshots where appropriate. This is expected behavior for a node-count-expanding feature.

### Risk 4: Decorator interaction

**Probability:** Low. The existing decorator handling for `ClassProperty` (lines 264–274 in `ClassVisitor`) extracts decorators even for non-function properties and pushes to `decorators`. The new `else` branch should co-exist with this code. The decorator handling runs BEFORE the function/else check, so the `propertyTargetId` used for decorator association (`PROPERTY#${className}.${propName}#...`) differs from the new VARIABLE node ID (semantic ID). This is acceptable — decorators and field nodes will exist independently and be linked by the `DECORATED_BY` edge from the decorator to the target ID, which is a separate concern.

**Mitigation:** Verify the decorator target ID used in line 268 (`PROPERTY#...`) is consistent with how decorators on class fields are used elsewhere. If decorator linking uses `variableId` for its target, update the `propertyTargetId` in the decorator extraction to use `fieldId` (the new variable's semantic ID). This needs a targeted check.

---

## Phase 5: Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/ast/types.ts` | Add `modifier?` and `tsType?` to `VariableDeclarationInfo` |
| `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` | Add else branch in `ClassProperty` handler for both `ClassDeclaration` (line 278) and `ClassExpression` (line 738) traversal blocks; add `typeNodeToString` to import from `TypeScriptVisitor.ts` |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Enhance variable buffering loop (lines 275–278) to extract `modifier` and `tsType` from `varDecl` into `node.metadata`, mirroring REG-401 FUNCTION pattern |
| `test/unit/plugins/analysis/ast/class-property-declarations.test.ts` | New test file |

---

## Phase 6: Files for Uncle Bob Review in STEP 2.5

Uncle Bob should review these files to verify there is no refactoring debt before implementation begins:

1. **`packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`** — specifically the duplication between `ClassDeclaration` and `ClassExpression` traversal blocks. If the duplication is already considered tech debt, STEP 2.5 should extract a shared `processClassProperty()` helper before adding the new else branch (to avoid tripling the duplication).

2. **`packages/core/src/plugins/analysis/ast/types.ts`** — `VariableDeclarationInfo` interface. Verify that adding `modifier` and `tsType` fields is consistent with how other node metadata is tracked in similar info types (e.g., `FunctionInfo` for `controlFlow`, `ParameterInfo` for `propertyPath`).

3. **The node-buffering path for VARIABLE declarations** — wherever `bufferNode()` is called for `variableDeclarations` items, verify the code does not need restructuring before adding the metadata propagation.

---

## Summary

| Item | Decision |
|------|----------|
| New NodeType? | No — reuse `VARIABLE` with `metadata.modifier` and `metadata.type` |
| Pattern to follow | REG-271 `ClassPrivateProperty` else-branch in `ClassVisitor.ts` |
| Primary change location | `ClassVisitor.ts` — add else branch in ClassProperty handlers (2 locations) |
| Modifier extraction | `propNode.accessibility` (Babel AST field: `"public"` / `"private"` / `"protected"` / `undefined`) + `propNode.readonly` |
| Type extraction | `typeNodeToString((propNode as any).typeAnnotation?.typeAnnotation)` |
| Edge type | `CLASS -> HAS_PROPERTY -> VARIABLE` (already exists via TypeSystemBuilder for properties array) |
| Test file | `test/unit/plugins/analysis/ast/class-property-declarations.test.ts` |
| Implicit `public` | When `accessibility === undefined` and `readonly === false`, store `"public"` as modifier |
| Out of scope | Static fields can be supported immediately (add `isStatic: propNode.static || false` — same as private field pattern) |
