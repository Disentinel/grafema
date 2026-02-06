# Joel Spolsky (Implementation Planner) - Technical Spec for REG-271

## Task: Track Class Static Blocks and Private Fields

**Date:** 2026-02-05
**Input:** Don's plan (002-don-plan.md)
**Complexity Estimate:** Medium (2-3 days)

---

## Table of Contents

1. [Implementation Order](#1-implementation-order)
2. [Type Extensions](#2-type-extensions)
3. [ClassVisitor Changes](#3-classvisitor-changes)
4. [GraphBuilder Changes](#4-graphbuilder-changes)
5. [Test Matrix](#5-test-matrix)
6. [Big-O Complexity Analysis](#6-big-o-complexity-analysis)
7. [Edge Cases](#7-edge-cases)
8. [Risk Mitigation](#8-risk-mitigation)

---

## 1. Implementation Order

### Phase 1: Types (30 min)
1. Extend `ClassDeclarationInfo` in `types.ts`
2. Add `isPrivate` and `isStatic` flags to `FunctionInfo`
3. Add `isPrivate` and `isStatic` flags to `VariableDeclarationInfo`

### Phase 2: Static Blocks (1-2 hours)
1. Add `StaticBlock` handler in `ClassVisitor.ts`
2. Update `GraphBuilder.ts` to create SCOPE nodes with `scopeType: 'static_block'`
3. Write tests for static blocks

### Phase 3: Private Fields (2-3 hours)
1. Add `ClassPrivateProperty` handler in `ClassVisitor.ts`
2. Extend `ClassDeclarationInfo` with `properties` array
3. Update `GraphBuilder.bufferClassDeclarationNodes()` to create HAS_PROPERTY edges
4. Write tests for private fields

### Phase 4: Private Methods (2-3 hours)
1. Add `ClassPrivateMethod` handler in `ClassVisitor.ts`
2. Handle getter/setter/method kinds
3. Write tests for private methods

### Phase 5: Integration Testing (1-2 hours)
1. Test all combinations
2. Edge case testing
3. Regression testing

---

## 2. Type Extensions

### 2.1 FunctionInfo (types.ts)

**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Location:** Lines 19-34

```typescript
// BEFORE
export interface FunctionInfo {
  id: string;
  type: 'FUNCTION';
  name: string;
  file: string;
  line: number;
  column: number;
  async?: boolean;
  generator?: boolean;
  arrowFunction?: boolean;
  isAssignment?: boolean;
  isCallback?: boolean;
  parentScopeId?: string;
  controlFlow?: ControlFlowMetadata;
}

// AFTER - Add isPrivate, isStatic, methodKind
export interface FunctionInfo {
  id: string;
  type: 'FUNCTION';
  name: string;
  file: string;
  line: number;
  column: number;
  async?: boolean;
  generator?: boolean;
  arrowFunction?: boolean;
  isAssignment?: boolean;
  isCallback?: boolean;
  parentScopeId?: string;
  controlFlow?: ControlFlowMetadata;
  // REG-271: Private methods support
  isPrivate?: boolean;   // true for #privateMethod
  isStatic?: boolean;    // true for static #method()
  methodKind?: 'constructor' | 'method' | 'get' | 'set';
}
```

### 2.2 VariableDeclarationInfo (types.ts)

**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Location:** Lines 194-205

```typescript
// BEFORE
export interface VariableDeclarationInfo {
  id: string;
  semanticId?: string;
  type: 'VARIABLE' | 'CONSTANT';
  name: string;
  file: string;
  line: number;
  column?: number;
  value?: unknown;
  parentScopeId?: string;
}

// AFTER - Add isPrivate, isStatic, isClassProperty
export interface VariableDeclarationInfo {
  id: string;
  semanticId?: string;
  type: 'VARIABLE' | 'CONSTANT';
  name: string;
  file: string;
  line: number;
  column?: number;
  value?: unknown;
  parentScopeId?: string;
  // REG-271: Private fields support
  isPrivate?: boolean;      // true for #privateField
  isStatic?: boolean;       // true for static #field
  isClassProperty?: boolean; // true for class properties (vs local variables)
}
```

### 2.3 ClassDeclarationInfo (types.ts)

**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Location:** Lines 288-300

```typescript
// BEFORE
export interface ClassDeclarationInfo {
  id: string;
  semanticId?: string;
  type: 'CLASS';
  name: string;
  file: string;
  line: number;
  column?: number;
  superClass?: string;
  implements?: string[];
  methods: string[];
}

// AFTER - Add properties and staticBlocks arrays
export interface ClassDeclarationInfo {
  id: string;
  semanticId?: string;
  type: 'CLASS';
  name: string;
  file: string;
  line: number;
  column?: number;
  superClass?: string;
  implements?: string[];
  methods: string[];
  // REG-271: Additional class members
  properties?: string[];     // IDs of class properties (including private)
  staticBlocks?: string[];   // IDs of static block scopes
}
```

### 2.4 ScopeInfo Extension

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

The existing `ScopeInfo` interface is sufficient. We'll use `scopeType: 'static_block'` for static blocks. The `parentScopeId` will point to the parent scope, and we'll store the class ID in a new field `parentClassId` for CONTAINS edge creation.

```typescript
// ADD to ScopeInfo (already supports various scopeTypes)
export interface ScopeInfo {
  // ... existing fields ...
  parentClassId?: string;  // REG-271: For static blocks, the containing class ID
}
```

---

## 3. ClassVisitor Changes

### 3.1 File Location
**File:** `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

### 3.2 Import Updates

Add imports for new Babel types:

```typescript
import type {
  ClassDeclaration,
  ClassMethod,
  ClassProperty,
  ClassPrivateProperty,    // NEW
  ClassPrivateMethod,      // NEW
  StaticBlock,             // NEW
  PrivateName,             // NEW
  Identifier,
  ArrowFunctionExpression,
  FunctionExpression,
  Decorator,
  Node
} from '@babel/types';
```

### 3.3 Static Block Handler

Add inside `classPath.traverse({...})` after the `ClassMethod` handler (line ~384):

```typescript
StaticBlock: (staticBlockPath: NodePath) => {
  const staticBlockNode = staticBlockPath.node as StaticBlock;

  // Skip if not direct child of current class
  if (staticBlockPath.parent !== classNode.body) {
    return;
  }

  const blockLine = getLine(staticBlockNode);
  const blockColumn = getColumn(staticBlockNode);

  // Enter static block scope for tracking
  const { discriminator } = scopeTracker.enterCountedScope('static_block');

  // Generate semantic ID for static block scope
  const staticBlockScopeId = computeSemanticId('SCOPE', `static_block#${discriminator}`, scopeTracker.getContext());

  // Add to class staticBlocks array for CONTAINS edge
  if (!currentClass.staticBlocks) {
    currentClass.staticBlocks = [];
  }
  currentClass.staticBlocks.push(staticBlockScopeId);

  // Create SCOPE node for static block
  (scopes as ScopeInfo[]).push({
    id: staticBlockScopeId,
    semanticId: computeSemanticId('SCOPE', `static_block#${discriminator}`, scopeTracker.getContext()),
    type: 'SCOPE',
    scopeType: 'static_block',
    name: `${className}:static_block#${discriminator}`,
    conditional: false,
    file: module.file,
    line: blockLine,
    parentClassId: currentClass.id  // For CONTAINS edge creation
  });

  // Analyze static block body using existing infrastructure
  // Static blocks have a 'body' array of statements (like FunctionBody)
  analyzeFunctionBody(staticBlockPath, staticBlockScopeId, module, collections);

  // Exit static block scope
  scopeTracker.exitScope();
}
```

### 3.4 Private Property Handler

Add inside `classPath.traverse({...})`:

```typescript
ClassPrivateProperty: (propPath: NodePath) => {
  const propNode = propPath.node as ClassPrivateProperty;

  // Skip if not direct child of current class
  if (propPath.parent !== classNode.body) {
    return;
  }

  // Extract name: PrivateName.id.name is WITHOUT # prefix
  // For #privateField, key.id.name = "privateField"
  const privateName = (propNode.key as PrivateName).id.name;
  const displayName = `#${privateName}`;  // Prepend # for clarity

  const propLine = getLine(propNode);
  const propColumn = getColumn(propNode);

  // Check if value is a function (arrow function or function expression)
  if (propNode.value &&
      (propNode.value.type === 'ArrowFunctionExpression' ||
       propNode.value.type === 'FunctionExpression')) {
    // Handle as private method (function-valued property)
    const funcNode = propNode.value as ArrowFunctionExpression | FunctionExpression;

    const functionId = computeSemanticId('FUNCTION', displayName, scopeTracker.getContext());

    // Add to class methods list for CONTAINS edges
    currentClass.methods.push(functionId);

    (functions as ClassFunctionInfo[]).push({
      id: functionId,
      type: 'FUNCTION',
      name: displayName,
      file: module.file,
      line: propLine,
      column: propColumn,
      async: funcNode.async || false,
      generator: funcNode.type === 'FunctionExpression' ? funcNode.generator || false : false,
      arrowFunction: funcNode.type === 'ArrowFunctionExpression',
      isClassProperty: true,
      isPrivate: true,
      isStatic: propNode.static || false,
      className: className
    });

    // Enter method scope for tracking
    scopeTracker.enterScope(displayName, 'FUNCTION');

    // Create PARAMETER nodes if needed
    if (parameters) {
      createParameterNodes(funcNode.params, functionId, module.file, propLine, parameters as ParameterInfo[], scopeTracker);
    }

    // Create SCOPE for property function body
    const propBodyScopeId = `SCOPE#${className}.${displayName}:body#${module.file}#${propLine}`;
    const propBodySemanticId = computeSemanticId('SCOPE', 'body', scopeTracker.getContext());
    (scopes as ScopeInfo[]).push({
      id: propBodyScopeId,
      semanticId: propBodySemanticId,
      type: 'SCOPE',
      scopeType: 'property_body',
      name: `${className}.${displayName}:body`,
      conditional: false,
      file: module.file,
      line: propLine,
      parentFunctionId: functionId
    });

    const funcPath = propPath.get('value') as NodePath<ArrowFunctionExpression | FunctionExpression>;
    analyzeFunctionBody(funcPath, propBodyScopeId, module, collections);

    // Exit method scope
    scopeTracker.exitScope();
  } else {
    // Handle as private field (non-function property)
    const variableId = computeSemanticId('VARIABLE', displayName, scopeTracker.getContext());

    // Add to class properties list for HAS_PROPERTY edges
    if (!currentClass.properties) {
      currentClass.properties = [];
    }
    currentClass.properties.push(variableId);

    // Track value for assignment edge if present
    const hasValue = propNode.value !== null;

    // Add to variableDeclarations for VARIABLE node creation
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
      parentScopeId: currentClass.id  // Use class ID as parent for HAS_PROPERTY edge
    });

    // Extract decorators if present
    const propNodeWithDecorators = propNode as ClassPrivateProperty & { decorators?: Decorator[] };
    if (propNodeWithDecorators.decorators && propNodeWithDecorators.decorators.length > 0 && decorators) {
      for (const decorator of propNodeWithDecorators.decorators) {
        const decoratorInfo = this.extractDecoratorInfo(decorator, variableId, 'PROPERTY', module);
        if (decoratorInfo) {
          (decorators as DecoratorInfo[]).push(decoratorInfo);
        }
      }
    }
  }
}
```

### 3.5 Private Method Handler

Add inside `classPath.traverse({...})`:

```typescript
ClassPrivateMethod: (methodPath: NodePath) => {
  const methodNode = methodPath.node as ClassPrivateMethod;

  // Skip if not direct child of current class
  if (methodPath.parent !== classNode.body) {
    return;
  }

  // Extract name: PrivateName.id.name is WITHOUT # prefix
  const privateName = (methodNode.key as PrivateName).id.name;
  const displayName = `#${privateName}`;  // Prepend # for clarity

  const methodLine = getLine(methodNode);
  const methodColumn = getColumn(methodNode);

  // Use semantic ID as primary ID
  const functionId = computeSemanticId('FUNCTION', displayName, scopeTracker.getContext());

  // Add method to class methods list for CONTAINS edges
  currentClass.methods.push(functionId);

  const funcData: ClassFunctionInfo = {
    id: functionId,
    type: 'FUNCTION',
    name: displayName,
    file: module.file,
    line: methodLine,
    column: methodColumn,
    async: methodNode.async || false,
    generator: methodNode.generator || false,
    isClassMethod: true,
    isPrivate: true,
    isStatic: methodNode.static || false,
    className: className,
    methodKind: methodNode.kind as 'get' | 'set' | 'method'
  };
  (functions as ClassFunctionInfo[]).push(funcData);

  // Extract method decorators
  const methodNodeWithDecorators = methodNode as ClassPrivateMethod & { decorators?: Decorator[] };
  if (methodNodeWithDecorators.decorators && methodNodeWithDecorators.decorators.length > 0 && decorators) {
    for (const decorator of methodNodeWithDecorators.decorators) {
      const decoratorInfo = this.extractDecoratorInfo(decorator, functionId, 'METHOD', module);
      if (decoratorInfo) {
        (decorators as DecoratorInfo[]).push(decoratorInfo);
      }
    }
  }

  // Enter method scope for tracking
  scopeTracker.enterScope(displayName, 'FUNCTION');

  // Create PARAMETER nodes
  if (parameters) {
    createParameterNodes(methodNode.params, functionId, module.file, methodLine, parameters as ParameterInfo[], scopeTracker);
  }

  // Create SCOPE for method body
  const methodBodyScopeId = `SCOPE#${className}.${displayName}:body#${module.file}#${methodLine}`;
  const methodBodySemanticId = computeSemanticId('SCOPE', 'body', scopeTracker.getContext());
  (scopes as ScopeInfo[]).push({
    id: methodBodyScopeId,
    semanticId: methodBodySemanticId,
    type: 'SCOPE',
    scopeType: 'method_body',
    name: `${className}.${displayName}:body`,
    conditional: false,
    file: module.file,
    line: methodLine,
    parentFunctionId: functionId
  });

  analyzeFunctionBody(methodPath, methodBodyScopeId, module, collections);

  // Exit method scope
  scopeTracker.exitScope();
}
```

---

## 4. GraphBuilder Changes

### 4.1 File Location
**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### 4.2 Update bufferClassDeclarationNodes

**Location:** Line ~983

```typescript
private bufferClassDeclarationNodes(classDeclarations: ClassDeclarationInfo[]): void {
  for (const classDecl of classDeclarations) {
    const { id, type, name, file, line, column, superClass, methods, properties, staticBlocks } = classDecl;

    // Buffer CLASS node
    this._bufferNode({
      id,
      type,
      name,
      file,
      line,
      column,
      superClass
    });

    // Buffer CONTAINS edges: CLASS -> METHOD
    for (const methodId of methods) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: id,
        dst: methodId
      });
    }

    // REG-271: Buffer HAS_PROPERTY edges: CLASS -> VARIABLE (private fields)
    if (properties) {
      for (const propertyId of properties) {
        this._bufferEdge({
          type: 'HAS_PROPERTY',
          src: id,
          dst: propertyId
        });
      }
    }

    // REG-271: Buffer CONTAINS edges: CLASS -> SCOPE (static blocks)
    if (staticBlocks) {
      for (const staticBlockId of staticBlocks) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: id,
          dst: staticBlockId
        });
      }
    }

    // If superClass, buffer DERIVES_FROM edge with computed ID
    if (superClass) {
      const globalContext = { file, scopePath: [] as string[] };
      const superClassId = computeSemanticId('CLASS', superClass, globalContext);

      this._bufferEdge({
        type: 'DERIVES_FROM',
        src: id,
        dst: superClassId
      });
    }
  }
}
```

### 4.3 Update bufferVariableEdges (Optional)

For class properties with `isClassProperty: true`, we should NOT create DECLARES edges from a SCOPE (they use HAS_PROPERTY from CLASS). The existing code already handles this correctly since `parentScopeId` for class properties is set to the class ID, not a scope ID.

However, we need to verify that variable nodes with `isClassProperty: true` don't get DECLARES edges. Update the buffer method:

```typescript
private bufferVariableEdges(variableDeclarations: VariableDeclarationInfo[]): void {
  for (const varDecl of variableDeclarations) {
    const { parentScopeId, isClassProperty, ...varData } = varDecl;

    // REG-271: Skip class properties - they get HAS_PROPERTY edges from CLASS, not DECLARES from SCOPE
    if (isClassProperty) {
      continue;
    }

    // SCOPE -> DECLARES -> VARIABLE
    if (parentScopeId) {
      this._bufferEdge({
        type: 'DECLARES',
        src: parentScopeId,
        dst: varData.id
      });
    }
  }
}
```

---

## 5. Test Matrix

### 5.1 Test File Location
Create: `test/unit/plugins/analysis/ast/class-private-members.test.ts`

### 5.2 Static Blocks Tests

| Test | Input | Expected Graph |
|------|-------|----------------|
| Single static block | `class Foo { static { init(); } }` | CLASS -[CONTAINS]-> SCOPE(static_block#0), SCOPE -[CONTAINS]-> CALL |
| Multiple static blocks | `class Foo { static { a(); } static { b(); } }` | CLASS -[CONTAINS]-> SCOPE(static_block#0), CLASS -[CONTAINS]-> SCOPE(static_block#1) |
| Static block with variables | `class Foo { static { const x = 1; } }` | SCOPE -[DECLARES]-> VARIABLE(x) |
| Static block accessing class methods | `class Foo { static { Foo.init(); } static init() {} }` | SCOPE -[CONTAINS]-> CALL(Foo.init) |

### 5.3 Private Fields Tests

| Test | Input | Expected Graph |
|------|-------|----------------|
| Private instance field | `class Foo { #count = 0; }` | CLASS -[HAS_PROPERTY]-> VARIABLE(#count, isPrivate:true) |
| Private static field | `class Foo { static #instances = []; }` | CLASS -[HAS_PROPERTY]-> VARIABLE(#instances, isPrivate:true, isStatic:true) |
| Private field without initializer | `class Foo { #field; }` | CLASS -[HAS_PROPERTY]-> VARIABLE(#field, isPrivate:true) |
| Private field with function value | `class Foo { #handler = () => {}; }` | CLASS -[CONTAINS]-> FUNCTION(#handler, isPrivate:true) |

### 5.4 Private Methods Tests

| Test | Input | Expected Graph |
|------|-------|----------------|
| Private instance method | `class Foo { #validate() { return true; } }` | CLASS -[CONTAINS]-> FUNCTION(#validate, isPrivate:true) |
| Private static method | `class Foo { static #configure() {} }` | CLASS -[CONTAINS]-> FUNCTION(#configure, isPrivate:true, isStatic:true) |
| Private getter | `class Foo { get #prop() { return this._p; } }` | CLASS -[CONTAINS]-> FUNCTION(#prop, isPrivate:true, methodKind:'get') |
| Private setter | `class Foo { set #prop(v) { this._p = v; } }` | CLASS -[CONTAINS]-> FUNCTION(#prop, isPrivate:true, methodKind:'set') |
| Private async method | `class Foo { async #fetch() {} }` | CLASS -[CONTAINS]-> FUNCTION(#fetch, isPrivate:true, async:true) |

### 5.5 Edge Cases Tests

| Test | Input | Expected Graph |
|------|-------|----------------|
| Class with only private members | `class Foo { #x = 1; #y() {} }` | No public methods, still correct edges |
| Private method calling private method | `class Foo { #a() { this.#b(); } #b() {} }` | Both methods tracked, call site recorded |
| Private field in constructor | `class Foo { #x; constructor() { this.#x = 1; } }` | Field tracked, assignment edge created |
| Nested class with private members | `class Outer { static Inner = class { #x; } }` | Inner class private field tracked |
| Private getter+setter pair | `class Foo { get #x() {} set #x(v) {} }` | Two separate FUNCTION nodes |

### 5.6 Test Code Template

```typescript
/**
 * Class Private Members Tests (REG-271)
 *
 * Tests for:
 * - StaticBlock: static { ... } creates SCOPE with scopeType='static_block'
 * - ClassPrivateProperty: #privateField creates VARIABLE with isPrivate=true
 * - ClassPrivateMethod: #privateMethod() creates FUNCTION with isPrivate=true
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../../helpers/createTestOrchestrator.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;
let db: Awaited<ReturnType<typeof createTestDatabase>>;

// Helper functions (copy from existing test patterns)
async function setupTest(backend, files) { /* ... */ }
async function getNodesByType(backend, type) { /* ... */ }
async function getEdgesByType(backend, type) { /* ... */ }

describe('Class Private Members Analysis (REG-271)', () => {
  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('Static Blocks', () => {
    it('should create SCOPE node with scopeType=static_block', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  static {
    console.log('initialized');
  }
}
        `
      });

      const scopes = await getNodesByType(db.backend, 'SCOPE');
      const staticBlockScope = scopes.find(s => s.scopeType === 'static_block');

      assert.ok(staticBlockScope, 'Static block SCOPE node should exist');
      assert.strictEqual(staticBlockScope.scopeType, 'static_block');
    });

    it('should create CLASS -[CONTAINS]-> SCOPE edge for static block', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  static {
    init();
  }
}
        `
      });

      const classes = await getNodesByType(db.backend, 'CLASS');
      const scopes = await getNodesByType(db.backend, 'SCOPE');

      const fooClass = classes.find(c => c.name === 'Foo');
      const staticBlockScope = scopes.find(s => s.scopeType === 'static_block');

      const containsEdges = await getEdgesByType(db.backend, 'CONTAINS');
      const classToBlock = containsEdges.find(e =>
        e.src === fooClass.id && e.dst === staticBlockScope.id
      );

      assert.ok(classToBlock, 'CLASS -[CONTAINS]-> SCOPE(static_block) edge should exist');
    });
  });

  describe('Private Fields', () => {
    it('should create VARIABLE node with isPrivate=true for private field', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  #count = 0;
}
        `
      });

      const variables = await getNodesByType(db.backend, 'VARIABLE');
      const privateField = variables.find(v => v.name === '#count');

      assert.ok(privateField, 'Private field VARIABLE node should exist');
      assert.strictEqual(privateField.isPrivate, true);
      assert.strictEqual(privateField.isStatic, false);
    });

    it('should create HAS_PROPERTY edge from CLASS to private field', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  #secret = 42;
}
        `
      });

      const hasPropertyEdges = await getEdgesByType(db.backend, 'HAS_PROPERTY');
      const classes = await getNodesByType(db.backend, 'CLASS');
      const variables = await getNodesByType(db.backend, 'VARIABLE');

      const fooClass = classes.find(c => c.name === 'Foo');
      const secretField = variables.find(v => v.name === '#secret');

      const edge = hasPropertyEdges.find(e =>
        e.src === fooClass.id && e.dst === secretField.id
      );

      assert.ok(edge, 'CLASS -[HAS_PROPERTY]-> VARIABLE(#secret) edge should exist');
    });

    it('should mark static private field with isStatic=true', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  static #instances = [];
}
        `
      });

      const variables = await getNodesByType(db.backend, 'VARIABLE');
      const staticPrivateField = variables.find(v => v.name === '#instances');

      assert.ok(staticPrivateField, 'Static private field should exist');
      assert.strictEqual(staticPrivateField.isPrivate, true);
      assert.strictEqual(staticPrivateField.isStatic, true);
    });
  });

  describe('Private Methods', () => {
    it('should create FUNCTION node with isPrivate=true for private method', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  #validate() {
    return true;
  }
}
        `
      });

      const functions = await getNodesByType(db.backend, 'FUNCTION');
      const privateMethod = functions.find(f => f.name === '#validate');

      assert.ok(privateMethod, 'Private method FUNCTION node should exist');
      assert.strictEqual(privateMethod.isPrivate, true);
    });

    it('should create CLASS -[CONTAINS]-> FUNCTION edge for private method', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  #process() {}
}
        `
      });

      const containsEdges = await getEdgesByType(db.backend, 'CONTAINS');
      const classes = await getNodesByType(db.backend, 'CLASS');
      const functions = await getNodesByType(db.backend, 'FUNCTION');

      const fooClass = classes.find(c => c.name === 'Foo');
      const privateMethod = functions.find(f => f.name === '#process');

      const edge = containsEdges.find(e =>
        e.src === fooClass.id && e.dst === privateMethod.id
      );

      assert.ok(edge, 'CLASS -[CONTAINS]-> FUNCTION(#process) edge should exist');
    });

    it('should track private getter with methodKind=get', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  get #value() { return this._v; }
}
        `
      });

      const functions = await getNodesByType(db.backend, 'FUNCTION');
      const getter = functions.find(f => f.name === '#value');

      assert.ok(getter, 'Private getter should exist');
      assert.strictEqual(getter.isPrivate, true);
      assert.strictEqual(getter.methodKind, 'get');
    });

    it('should track private static method with isStatic=true', async () => {
      await setupTest(db.backend, {
        'index.js': `
class Foo {
  static #configure() {}
}
        `
      });

      const functions = await getNodesByType(db.backend, 'FUNCTION');
      const staticMethod = functions.find(f => f.name === '#configure');

      assert.ok(staticMethod, 'Static private method should exist');
      assert.strictEqual(staticMethod.isPrivate, true);
      assert.strictEqual(staticMethod.isStatic, true);
    });
  });
});
```

---

## 6. Big-O Complexity Analysis

### 6.1 Traversal Complexity

All changes are within the existing class traversal path:

| Operation | Complexity | Justification |
|-----------|------------|---------------|
| ClassVisitor traversal | O(m) where m = class members | Visits each member once |
| Static block handler | O(1) per static block | Just node creation |
| Private property handler | O(1) per property | Just node creation |
| Private method handler | O(1) per method | Just node creation |

**Total complexity for analysis:** O(c * m) where c = classes, m = avg members per class

This is NOT O(n) over all nodes - it's O(class_members) during class traversal.

### 6.2 GraphBuilder Complexity

| Operation | Complexity | Justification |
|-----------|------------|---------------|
| bufferClassDeclarationNodes | O(c * m) | Iterates classes, then methods/properties |
| HAS_PROPERTY edge creation | O(p) per class | p = properties count |
| CONTAINS edge for static blocks | O(s) per class | s = static blocks count |

**No O(n) over all nodes.** All operations are scoped to class members.

---

## 7. Edge Cases

### 7.1 PrivateName Handling

The `#` prefix is NOT stored in `PrivateName.id.name`. We must prepend it:

```javascript
// For #privateField:
// node.key = PrivateName { id: Identifier { name: "privateField" } }
// We display/store as "#privateField"
const displayName = `#${privateName.id.name}`;
```

### 7.2 Computed Private Fields

Private fields cannot have computed names (SyntaxError in JS):
```javascript
// INVALID: class Foo { #[expr] = 1; }
```
No handling needed.

### 7.3 Private Field with Function Value

`#handler = () => {}` should create a FUNCTION node, not a VARIABLE node. The handler checks `propNode.value.type`:
- ArrowFunctionExpression -> FUNCTION
- FunctionExpression -> FUNCTION
- Everything else -> VARIABLE

### 7.4 Static Block with `this`

In static blocks, `this` refers to the class constructor, not an instance. No special handling needed - it's valid JavaScript.

### 7.5 Multiple Static Blocks

A class can have multiple static blocks. Each gets a unique discriminator:
- `static_block#0`, `static_block#1`, etc.

---

## 8. Risk Mitigation

### 8.1 HAS_PROPERTY Edge Semantics

**Risk:** HAS_PROPERTY is currently used for OBJECT_LITERAL -> values. Using it for CLASS -> VARIABLE might cause confusion.

**Mitigation:** HAS_PROPERTY is semantically correct - a class HAS a PROPERTY. The edge connects to a VARIABLE node, not an OBJECT_LITERAL. No conflict.

**Alternative if needed:** Create HAS_FIELD edge type for class fields. But HAS_PROPERTY is simpler and follows the existing pattern.

### 8.2 Backward Compatibility

**Risk:** New fields (`isPrivate`, `isStatic`, `properties`, `staticBlocks`) might break existing code.

**Mitigation:** All new fields are optional. Existing code that doesn't check these fields will continue to work.

### 8.3 analyzeFunctionBody for Static Blocks

**Risk:** `analyzeFunctionBody` expects a FunctionExpression/ArrowFunctionExpression path, but StaticBlock has a different structure.

**Mitigation:** StaticBlock has `body: Statement[]` which is similar to FunctionBody. The `analyzeFunctionBody` callback should handle this. If not, we may need to create a separate `analyzeStaticBlockBody` or generalize the callback.

**Verification step:** Check if analyzeFunctionBody works with StaticBlock. If issues arise, create specialized handler.

---

## Summary

This technical spec provides:

1. **Exact type changes** - 4 interfaces extended with new optional fields
2. **Exact file changes** - ClassVisitor.ts (~120 LOC), GraphBuilder.ts (~30 LOC), types.ts (~20 LOC)
3. **Test matrix** - 14 specific test cases covering all scenarios
4. **Complexity analysis** - O(class_members), not O(all_nodes)
5. **Edge case handling** - PrivateName prefix, function-valued properties, multiple static blocks

**Ready for implementation by Rob Pike (Kent Beck writes tests first).**
