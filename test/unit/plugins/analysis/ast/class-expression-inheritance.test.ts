/**
 * Class Expression Inheritance Tests (REG-596)
 *
 * Tests for EXTENDS/IMPLEMENTS edges on ClassExpression nodes.
 *
 * What we verify:
 * - ClassExpression with `extends Base` produces EXTENDS deferred
 * - ClassExpression with `implements IFoo, IBar` produces IMPLEMENTS edges + stub INTERFACE nodes
 * - Named class expressions declare name in class scope (not enclosing scope)
 * - Anonymous class expressions still get EXTENDS/IMPLEMENTS edges
 * - No regression: class declarations still work correctly
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../../helpers/createTestOrchestrator.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-classexpr-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-classexpr-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  writeFileSync(
    join(testDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        strict: true
      }
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

// =============================================================================
// TESTS: Class Expression Inheritance (REG-596)
// =============================================================================

describe('Class Expression Inheritance (REG-596)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // TEST 1: Class expression with extends
  // ===========================================================================

  describe('EXTENDS edge', () => {
    it('should create EXTENDS deferred for class expression with Identifier superclass', async () => {
      await setupTest(backend, {
        'index.ts': `
class Base {
  baseMethod() {}
}

const Derived = class extends Base {
  derivedMethod() {}
};
        `
      });

      const classNodes = await getNodesByType(backend, 'CLASS');
      const extendsEdges = await getEdgesByType(backend, 'EXTENDS');

      const baseClass = classNodes.find(n => n.name === 'Base');
      const derivedClass = classNodes.find(n => n.name === '<anonymous>');

      assert.ok(baseClass, 'Should have CLASS node for Base');
      assert.ok(derivedClass, 'Should have CLASS node for anonymous class expression');

      const extendsEdge = extendsEdges.find(e => e.src === derivedClass!.id);
      assert.ok(
        extendsEdge,
        `Should have EXTENDS edge from anonymous class expression. Edges: ${JSON.stringify(extendsEdges)}`
      );
      assert.strictEqual(extendsEdge!.dst, baseClass!.id, 'EXTENDS edge should point to Base');
    });

    it('should set superClass metadata on class expression node', async () => {
      await setupTest(backend, {
        'index.ts': `
class Parent {}
const Child = class extends Parent {};
        `
      });

      const classNodes = await getNodesByType(backend, 'CLASS');
      const childClass = classNodes.find(n => n.name === '<anonymous>');

      assert.ok(childClass, 'Should have anonymous class expression node');
      assert.strictEqual(
        (childClass as Record<string, unknown>).superClass,
        'Parent',
        'Should have superClass metadata set to "Parent"'
      );
    });
  });

  // ===========================================================================
  // TEST 2: Class expression with implements
  // ===========================================================================

  describe('IMPLEMENTS edges', () => {
    it('should create IMPLEMENTS edges and stub INTERFACE nodes for class expression', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IFoo {
  foo(): void;
}
interface IBar {
  bar(): void;
}

const Impl = class implements IFoo, IBar {
  foo() {}
  bar() {}
};
        `
      });

      const classNodes = await getNodesByType(backend, 'CLASS');
      const interfaceNodes = await getNodesByType(backend, 'INTERFACE');
      const implementsEdges = await getEdgesByType(backend, 'IMPLEMENTS');

      const implClass = classNodes.find(n => n.name === '<anonymous>');
      assert.ok(implClass, 'Should have anonymous class expression node');

      assert.ok(
        interfaceNodes.some(n => n.name === 'IFoo'),
        `Should have INTERFACE node for IFoo. Interfaces: ${interfaceNodes.map(n => n.name).join(', ')}`
      );
      assert.ok(
        interfaceNodes.some(n => n.name === 'IBar'),
        `Should have INTERFACE node for IBar. Interfaces: ${interfaceNodes.map(n => n.name).join(', ')}`
      );

      const implEdgesFromClass = implementsEdges.filter(e => e.src === implClass!.id);
      assert.strictEqual(
        implEdgesFromClass.length,
        2,
        `Should have 2 IMPLEMENTS edges from class expression. Got ${implEdgesFromClass.length}: ${JSON.stringify(implEdgesFromClass)}`
      );
    });
  });

  // ===========================================================================
  // TEST 3: Named class expression with extends + implements
  // ===========================================================================

  describe('Named class expression with full inheritance', () => {
    it('should create EXTENDS + IMPLEMENTS edges for named class expression', async () => {
      await setupTest(backend, {
        'index.ts': `
class Base {}
interface IBaz {
  baz(): void;
}

const X = class MyClass extends Base implements IBaz {
  baz() {}
};
        `
      });

      const classNodes = await getNodesByType(backend, 'CLASS');
      const extendsEdges = await getEdgesByType(backend, 'EXTENDS');
      const implementsEdges = await getEdgesByType(backend, 'IMPLEMENTS');

      const myClass = classNodes.find(n => n.name === 'MyClass');
      assert.ok(myClass, `Should have CLASS node for MyClass. Classes: ${classNodes.map(n => n.name).join(', ')}`);

      const extendsEdge = extendsEdges.find(e => e.src === myClass!.id);
      assert.ok(extendsEdge, 'Named class expression should have EXTENDS edge');

      const baseClass = classNodes.find(n => n.name === 'Base');
      assert.ok(baseClass, 'Should have CLASS node for Base');
      assert.strictEqual(extendsEdge!.dst, baseClass!.id, 'EXTENDS should point to Base');

      const implEdges = implementsEdges.filter(e => e.src === myClass!.id);
      assert.strictEqual(implEdges.length, 1, 'Should have 1 IMPLEMENTS edge from MyClass');
    });
  });

  // ===========================================================================
  // TEST 4: Anonymous class expression with extends (no name, no declare)
  // ===========================================================================

  describe('Anonymous class expression', () => {
    it('should create EXTENDS edge for module.exports = class extends Base {}', async () => {
      await setupTest(backend, {
        'index.ts': `
class Base {
  greet() { return 'hello'; }
}

module.exports = class extends Base {
  greet() { return 'world'; }
};
        `
      });

      const classNodes = await getNodesByType(backend, 'CLASS');
      const extendsEdges = await getEdgesByType(backend, 'EXTENDS');

      const baseClass = classNodes.find(n => n.name === 'Base');
      const anonClass = classNodes.find(n => n.name === '<anonymous>');

      assert.ok(baseClass, 'Should have CLASS node for Base');
      assert.ok(anonClass, 'Should have anonymous CLASS node for class expression');

      const extendsEdge = extendsEdges.find(e => e.src === anonClass!.id);
      assert.ok(
        extendsEdge,
        `Anonymous class expression should have EXTENDS edge. All EXTENDS: ${JSON.stringify(extendsEdges)}`
      );
      assert.strictEqual(extendsEdge!.dst, baseClass!.id, 'EXTENDS should point to Base');
    });
  });

  // ===========================================================================
  // TEST 5: Class declaration still works (no regression)
  // ===========================================================================

  describe('No regression on class declarations', () => {
    it('should still create EXTENDS edge for class declaration', async () => {
      await setupTest(backend, {
        'index.ts': `
class Animal {
  speak() {}
}

class Dog extends Animal {
  bark() {}
}
        `
      });

      const classNodes = await getNodesByType(backend, 'CLASS');
      const extendsEdges = await getEdgesByType(backend, 'EXTENDS');

      const animal = classNodes.find(n => n.name === 'Animal');
      const dog = classNodes.find(n => n.name === 'Dog');

      assert.ok(animal, 'Should have CLASS node for Animal');
      assert.ok(dog, 'Should have CLASS node for Dog');

      const extendsEdge = extendsEdges.find(e => e.src === dog!.id);
      assert.ok(extendsEdge, 'Dog should have EXTENDS edge');
      assert.strictEqual(extendsEdge!.dst, animal!.id, 'EXTENDS should point to Animal');
    });
  });
});
