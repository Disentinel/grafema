# REG-552: Technical Plan — Index Class Property Declarations

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-22

---

## 1. Files to Modify

### Primary file

**`packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`**

This is the only file that needs new logic. It already handles `ClassProperty` (for function-valued properties) and `ClassPrivateProperty` (for private fields via REG-271). The gap is that `ClassProperty` with a non-function value is silently ignored — no node is created for `private graph: GraphBackend`, `public name: string`, etc.

The change goes inside `ClassDeclaration` and `ClassExpression` handlers at the `ClassProperty` visitor branch, in the `else` path after the existing `if (propNode.value && (Arrow|Function))` check. Currently that path is empty. We add it.

### Secondary file (types only — if needed)

**`packages/core/src/plugins/analysis/ast/types.ts`**

The existing `VariableDeclarationInfo` interface already has `isPrivate`, `isStatic`, and `isClassProperty` fields. We extend it with two optional fields for class-property-specific metadata:

```typescript
  modifier?: 'private' | 'public' | 'protected' | 'readonly';
  declaredType?: string;  // TypeScript type annotation string, e.g. "GraphBackend"
```

No other type files need changes.

### No changes needed in

- `GraphBuilder.ts` / `CoreBuilder.ts` / `TypeSystemBuilder.ts` — the existing `bufferVariableEdges` already skips `isClassProperty` nodes from DECLARES edges, and `TypeSystemBuilder.bufferClassDeclarationNodes` already emits `HAS_PROPERTY` edges for all IDs in `classDecl.properties`. Both paths are already wired; we just need to populate them correctly.
- `packages/types/src/nodes.ts` — `BaseNodeRecord.metadata` is `Record<string, unknown>`, so modifier and type can go in there without touching the type definition. No new node type is needed (see section 2).

---

## 2. Node Type

**Use the existing `VARIABLE` type. Do not add a new node type.**

Rationale:

1. `ClassPrivateProperty` non-function fields (REG-271) already create `VARIABLE` nodes with `isClassProperty: true`. The pattern is established and tested.
2. `VariableDeclarationInfo` is already the type that `variableDeclarations` collection holds, and `CoreBuilder.bufferVariableEdges` already handles the `isClassProperty` skip for `DECLARES` edges.
3. `TypeSystemBuilder.bufferClassDeclarationNodes` already emits `HAS_PROPERTY` edges from the CLASS node to all IDs in `classDecl.properties`. This works regardless of how the VARIABLE node was created.
4. Adding a new type (e.g. `CLASS_PROPERTY`) would require: new `NodeRecord` variant in `packages/types`, new factory, new builder path, new edge type decisions, and migration cost. For a field declaration, `VARIABLE` with `isClassProperty: true` and metadata is the right level of abstraction.

The modifier and TS type go into `metadata` on the VARIABLE node. `BaseNodeRecord.metadata` is already `Record<string, unknown>`.

---

## 3. AST Node Types

The parser used is **Babel** (`@babel/traverse`, `@babel/types`), confirmed by imports in `ClassVisitor.ts`.

**Relevant Babel AST node type: `ClassProperty`**

This covers both JavaScript class fields and TypeScript class property declarations with access modifiers.

Key fields on `ClassProperty`:

| Field | Type | Notes |
|-------|------|-------|
| `key` | `Expression` | Usually `Identifier` — the field name |
| `value` | `Expression \| null` | Initializer if present; `null` for bare `private graph: GraphBackend` |
| `static` | `boolean` | `true` for `static` fields |
| `accessibility` | `'public' \| 'private' \| 'protected' \| null` | TypeScript access modifier |
| `readonly` | `boolean` | TypeScript `readonly` keyword |
| `typeAnnotation` | `TSTypeAnnotation \| null` | TypeScript type (e.g., `: GraphBackend`) |
| `decorators` | `Decorator[]` | Already handled in the decorator extraction path |

**The existing handler already visits `ClassProperty` but only acts when `propNode.value` is a function.** The non-function path (the `else` branch after the `if`) is currently empty.

For the modifier value to store in metadata, the logic is:

```typescript
// Babel's accessibility field handles private/public/protected
// TypeScript 'private' keyword -> accessibility: 'private'
// TypeScript 'readonly' may appear with or without another modifier
function extractModifier(propNode: ClassProperty): string {
  if (propNode.readonly) return 'readonly';
  if (propNode.accessibility) return propNode.accessibility;  // 'public'|'private'|'protected'
  return 'public';  // implicit default
}
```

Note: `readonly` takes precedence because it is the most semantically significant for graph queries. If both `readonly` and `private` are present (e.g. `private readonly x`), the combined modifier `private readonly` should be stored — see implementation approach below.

For the TS type annotation:

```typescript
// propNode.typeAnnotation is TSTypeAnnotation { typeAnnotation: TSType }
// typeNodeToString() already handles all TS type forms
import { typeNodeToString } from './TypeScriptVisitor.js';

function extractDeclaredType(propNode: ClassProperty): string | undefined {
  const ann = (propNode as any).typeAnnotation;
  if (!ann || ann.type !== 'TSTypeAnnotation') return undefined;
  return typeNodeToString(ann.typeAnnotation);
}
```

`typeNodeToString` is already exported from `TypeScriptVisitor.ts` and handles primitives, generics, union/intersection, arrays, etc.

---

## 4. Implementation Approach

### Where exactly

In `ClassVisitor.ts`, inside **both** the `ClassDeclaration` and `ClassExpression` handlers, in the `ClassProperty` sub-visitor. The existing structure is:

```typescript
ClassProperty: (propPath: NodePath) => {
  // ... extract propName, propLine, propColumn
  // ... extract decorators (for all properties, already done)

  // Only process if value is a function
  if (propNode.value && (Arrow | Function)) {
    // ... creates FUNCTION node and SCOPE
  }
  // <-- HERE: currently empty, falls off end
}
```

**Add an `else` branch** after the function-valued check:

```typescript
} else {
  // Non-function class property: private graph: GraphBackend; public name: string; etc.
  const propertyId = computeSemanticIdV2('VARIABLE', propName, module.file, scopeTracker.getNamedParent());

  // Add to class properties for HAS_PROPERTY edge (same as private fields in REG-271)
  if (!currentClass.properties) {
    currentClass.properties = [];
  }
  currentClass.properties.push(propertyId);

  // Compute modifier string
  const propNodeTS = propNode as ClassProperty & { accessibility?: string; readonly?: boolean };
  const parts: string[] = [];
  if (propNodeTS.accessibility && propNodeTS.accessibility !== 'public') parts.push(propNodeTS.accessibility);
  if (propNodeTS.readonly) parts.push('readonly');
  const modifier = parts.length > 0 ? parts.join(' ') : 'public';

  // Extract TypeScript type annotation
  const ann = (propNode as any).typeAnnotation;
  let declaredType: string | undefined;
  if (ann?.type === 'TSTypeAnnotation') {
    declaredType = typeNodeToString(ann.typeAnnotation);
  }

  (collections.variableDeclarations as VariableDeclarationInfo[]).push({
    id: propertyId,
    semanticId: propertyId,
    type: 'VARIABLE',
    name: propName,
    file: module.file,
    line: propLine,
    column: propColumn,
    isClassProperty: true,
    isStatic: propNode.static || false,
    parentScopeId: currentClass.id,  // For HAS_PROPERTY edge routing
    metadata: {
      modifier,
      ...(declaredType !== undefined ? { type: declaredType } : {})
    }
  });

  // Decorators already extracted above (the existing decorator block runs for all properties)
}
```

**The same `else` block must be added in the `ClassExpression` sub-handler** (lines ~728 onwards), which is a near-duplicate of the `ClassDeclaration` block.

### Import addition

Add `typeNodeToString` to the existing import from `'./TypeScriptVisitor.js'` at the top of `ClassVisitor.ts`:

```typescript
import { extractTypeParameters, typeNodeToString } from './TypeScriptVisitor.js';
```

### VariableDeclarationInfo extension

In `packages/core/src/plugins/analysis/ast/types.ts`, add two optional fields to `VariableDeclarationInfo`:

```typescript
export interface VariableDeclarationInfo {
  // ... existing fields ...
  isPrivate?: boolean;
  isStatic?: boolean;
  isClassProperty?: boolean;
  // REG-552: TypeScript class property declaration metadata
  modifier?: string;     // 'public' | 'private' | 'protected' | 'readonly' | 'private readonly' etc.
  declaredType?: string; // TypeScript type annotation string
}
```

Wait — on reflection, `modifier` and `declaredType` should go on the `VariableDeclarationInfo` type so `CoreBuilder` can pass them through to the graph node. Currently `CoreBuilder.bufferVariableEdges` skips `isClassProperty` nodes entirely. The metadata must be passed to the node buffer via `bufferNode`, which happens elsewhere. Let's trace how private fields (REG-271) carry their `isPrivate` and `isStatic` onto graph nodes.

Looking at `CoreBuilder.bufferVariableEdges`: it only creates `DECLARES` edges, skipping `isClassProperty` nodes. The actual node buffering for VARIABLE nodes happens in a different place — let's check if GraphBuilder creates VARIABLE nodes from `variableDeclarations`.

The `bufferVariableEdges` in `CoreBuilder` only creates edges. The node creation for VARIABLEs must happen in `bufferVariableEdges` too — but looking at the code again at line 119-135 of `CoreBuilder.ts`, it only creates edges, not nodes.

This means: VARIABLE node creation must be done separately. Check how REG-271 private fields (`isClassProperty: true`) get their nodes created. The answer is in the `JSASTAnalyzer` or `GraphBuilder.build()` — need to verify.

Let me note this as a critical verification point: **the implementer must trace how `variableDeclarations` items with `isClassProperty: true` get their VARIABLE graph nodes created.** If `CoreBuilder` only creates DECLARES edges and skips isClassProperty, who creates the actual VARIABLE nodes for private fields?

Looking at the test `ClassPrivateMembers.test.js` — it confirms private fields DO create VARIABLE nodes that are discoverable. The node creation must happen somewhere. The implementer needs to find the `addNode`/`bufferNode` call path for `variableDeclarations` entries.

**Action for implementer:** Search `GraphBuilder.ts` (all of it, beyond the 120 lines read) for where VARIABLE nodes are buffered from `variableDeclarations`. This is likely in `CoreBuilder` before or after `bufferVariableEdges`, or in `JSASTAnalyzer` directly. The node creation for class-property variables must carry `metadata` with modifier and type. If the node buffering code strips `metadata`, that field must be explicitly passed through.

---

## 5. Semantic ID Format

Follow the exact pattern established for `ClassPrivateProperty` non-function fields in REG-271 (lines 546 in `ClassVisitor.ts`):

```typescript
const propertyId = computeSemanticIdV2('VARIABLE', propName, module.file, scopeTracker.getNamedParent());
```

`scopeTracker.getNamedParent()` returns the class name at this point in traversal (the class scope has been entered via `scopeTracker.enterScope(className, 'CLASS')`).

**Resulting format:**

```
/path/to/file.ts->VARIABLE->graph[in:GraphAnalyzer]
/path/to/file.ts->VARIABLE->config[in:Orchestrator]
```

This is consistent with the v2 semantic ID format used throughout the codebase for FUNCTION and VARIABLE nodes. No discriminator is needed unless two fields in the same class have the same name, which TypeScript does not allow.

---

## 6. Test Approach

**Test file:** `test/unit/ClassPropertyDeclarations.test.js`

Follow the exact pattern of `ClassPrivateMembers.test.js` — it is the canonical reference for this feature area.

### Setup pattern

```javascript
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
```

Use `.ts` files (TypeScript) so access modifiers and type annotations are present. Requires `tsconfig.json` in the test directory (see `TypeScriptClassExtraction.test.js` setup helper for the pattern).

### Test cases required (minimum for acceptance criteria)

**1. Three fields with different modifiers all indexed**

```javascript
it('should create VARIABLE nodes for all three fields with correct modifiers', async () => {
  await setupTest(backend, {
    'index.ts': `
class Service {
  private graph: GraphBackend;
  public name: string;
  protected config: Config;
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const variables = allNodes.filter(n => n.type === 'VARIABLE');

  const graphField = variables.find(v => v.name === 'graph');
  const nameField = variables.find(v => v.name === 'name');
  const configField = variables.find(v => v.name === 'config');

  assert.ok(graphField, 'private graph field should exist');
  assert.ok(nameField, 'public name field should exist');
  assert.ok(configField, 'protected config field should exist');

  assert.strictEqual(graphField.metadata?.modifier, 'private');
  assert.strictEqual(nameField.metadata?.modifier, 'public');
  assert.strictEqual(configField.metadata?.modifier, 'protected');
});
```

**2. TypeScript type annotation stored in metadata.type**

```javascript
it('should store TypeScript type annotation in metadata.type', async () => {
  await setupTest(backend, {
    'index.ts': `
class Repo {
  private db: Database;
  public items: string[];
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const variables = allNodes.filter(n => n.type === 'VARIABLE');

  const dbField = variables.find(v => v.name === 'db');
  const itemsField = variables.find(v => v.name === 'items');

  assert.ok(dbField, 'db field should exist');
  assert.strictEqual(dbField.metadata?.type, 'Database');

  assert.ok(itemsField, 'items field should exist');
  assert.strictEqual(itemsField.metadata?.type, 'string[]');
});
```

**3. HAS_PROPERTY edge from CLASS to field VARIABLE**

```javascript
it('should create HAS_PROPERTY edge from CLASS to field VARIABLE', async () => {
  await setupTest(backend, {
    'index.ts': `
class Worker {
  private queue: string[];
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  const workerClass = allNodes.find(n => n.type === 'CLASS' && n.name === 'Worker');
  const queueField = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'queue');

  assert.ok(workerClass, 'Worker class should exist');
  assert.ok(queueField, 'queue field should exist');

  const edge = allEdges.find(e =>
    e.type === 'HAS_PROPERTY' && e.src === workerClass.id && e.dst === queueField.id
  );
  assert.ok(edge, 'CLASS -[HAS_PROPERTY]-> VARIABLE(queue) edge should exist');
});
```

**4. Field has correct file, line, column**

```javascript
it('should record correct position for field', async () => {
  await setupTest(backend, {
    'index.ts': `
class Foo {
  private bar: number;
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const barField = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'bar');

  assert.ok(barField, 'bar field should exist');
  assert.ok(barField.file, 'bar field should have file');
  assert.strictEqual(typeof barField.line, 'number', 'bar field should have line');
  assert.ok(barField.line > 0, 'line should be positive');
});
```

**5. readonly modifier**

```javascript
it('should handle readonly modifier', async () => {
  await setupTest(backend, {
    'index.ts': `
class Config {
  readonly maxRetries: number;
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const field = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'maxRetries');

  assert.ok(field, 'maxRetries field should exist');
  assert.ok(
    field.metadata?.modifier?.includes('readonly'),
    `modifier should include readonly, got: ${field.metadata?.modifier}`
  );
});
```

**6. Class field without type annotation (JS-style or bare field)**

```javascript
it('should handle field without type annotation', async () => {
  await setupTest(backend, {
    'index.ts': `
class Counter {
  count = 0;
}
    `
  });

  // count has an initializer (0), not a bare declaration.
  // This is different from 'private count: number' which has no value.
  // The field should still be indexed.
  const allNodes = await backend.getAllNodes();
  const countField = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'count');
  assert.ok(countField, 'count field should exist');
});
```

**7. Mixed: existing function-valued property still works**

```javascript
it('should not break function-valued class properties', async () => {
  await setupTest(backend, {
    'index.ts': `
class Handler {
  private name: string;
  handle = () => { return 'handled'; };
}
    `
  });

  const allNodes = await backend.getAllNodes();

  // name -> VARIABLE with modifier
  const nameField = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'name');
  assert.ok(nameField, 'name field should exist as VARIABLE');
  assert.strictEqual(nameField.metadata?.modifier, 'private');

  // handle -> FUNCTION (existing behavior)
  const handleFunc = allNodes.filter(n => n.type === 'FUNCTION').find(f => f.name === 'handle');
  assert.ok(handleFunc, 'handle should exist as FUNCTION (arrow function property)');
});
```

### What NOT to test (out of scope for this task)

- Constructor parameter properties (`constructor(private name: string)`) — these are a separate AST node (`TSParameterProperty`) and a separate task.
- Semantic ID format verification via node IDs — the existing pattern in `ClassPrivateMembers.test.js` skips this with a noted known issue in the RFDB backend (returns numeric IDs). Follow the same skip pattern if needed.

---

## Summary: What Makes This Right

The existing REG-271 private field path in `ClassVisitor.ts` is essentially the entire blueprint for this feature. The only difference is:

1. `ClassPrivateProperty` → `ClassProperty` (public/protected/private modifier instead of hard-coded `isPrivate: true`)
2. The name comes from `Identifier.name` not `PrivateName.id.name`
3. We extract `accessibility` and `readonly` from the node instead of inferring `isPrivate: true`
4. We extract `typeAnnotation` and convert it to a string

The graph wiring (`HAS_PROPERTY` edges, `variableDeclarations` collection, `isClassProperty: true`) is identical. No new infrastructure is needed.
