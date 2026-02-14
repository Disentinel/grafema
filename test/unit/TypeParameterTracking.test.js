/**
 * Type Parameter Tracking Tests (REG-303)
 *
 * TDD tests for TYPE_PARAMETER node creation, HAS_TYPE_PARAMETER edges,
 * and EXTENDS edges for constrained type parameters.
 *
 * Verifies:
 * 1. TypeParameterNode.create() generates correct ID format: {parentId}:TYPE_PARAMETER:{name}
 * 2. TypeParameterNode validation works for required/optional fields
 * 3. Full pipeline integration: functions, arrow functions, classes, methods,
 *    interfaces, type aliases all produce correct TYPE_PARAMETER nodes and edges
 * 4. Edge cases: primitive constraints (no EXTENDS edge), variance annotations, defaults
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { TypeParameterNode, NodeFactory } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

let testCounter = 0;

/**
 * Helper to create a test project with given files and analyze it.
 * Files must be discoverable through the dependency tree.
 * We use index.ts as entry point.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-typeparam-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-typeparam-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

// ============================================================================
// 1. TypeParameterNode contract (unit tests)
// ============================================================================

describe('Type Parameter Tracking (REG-303)', () => {
  describe('TypeParameterNode.create() contract', () => {
    it('creates node with correct ID format: {parentId}:TYPE_PARAMETER:{name}', () => {
      const node = TypeParameterNode.create(
        'T',
        '/src/types.ts:INTERFACE:Container:5',
        '/src/types.ts',
        5,
        20
      );

      assert.strictEqual(
        node.id,
        '/src/types.ts:INTERFACE:Container:5:TYPE_PARAMETER:T',
        'ID should be {parentId}:TYPE_PARAMETER:{name}'
      );
    });

    it('sets type to TYPE_PARAMETER', () => {
      const node = TypeParameterNode.create(
        'T',
        '/src/fn.ts:FUNCTION:identity:3',
        '/src/fn.ts',
        3,
        20
      );

      assert.strictEqual(node.type, 'TYPE_PARAMETER');
    });

    it('includes constraint when provided', () => {
      const node = TypeParameterNode.create(
        'T',
        '/src/fn.ts:FUNCTION:process:10',
        '/src/fn.ts',
        10,
        25,
        { constraint: 'Serializable' }
      );

      assert.strictEqual(node.constraint, 'Serializable');
    });

    it('includes defaultType when provided', () => {
      const node = TypeParameterNode.create(
        'T',
        '/src/fn.ts:FUNCTION:create:15',
        '/src/fn.ts',
        15,
        20,
        { defaultType: 'string' }
      );

      assert.strictEqual(node.defaultType, 'string');
    });

    it('includes variance when provided', () => {
      const node = TypeParameterNode.create(
        'T',
        '/src/types.ts:INTERFACE:Producer:5',
        '/src/types.ts',
        5,
        22,
        { variance: 'out' }
      );

      assert.strictEqual(node.variance, 'out');
    });

    it('omits optional fields when not provided', () => {
      const node = TypeParameterNode.create(
        'T',
        '/src/fn.ts:FUNCTION:identity:1',
        '/src/fn.ts',
        1,
        10
      );

      assert.strictEqual(node.constraint, undefined,
        'constraint should be absent when not provided');
      assert.strictEqual(node.defaultType, undefined,
        'defaultType should be absent when not provided');
      assert.strictEqual(node.variance, undefined,
        'variance should be absent when not provided');
      // Verify the keys are not present (not just undefined values)
      assert.ok(!('constraint' in node),
        'constraint key should not be present');
      assert.ok(!('defaultType' in node),
        'defaultType key should not be present');
      assert.ok(!('variance' in node),
        'variance key should not be present');
    });

    it('throws when name is missing', () => {
      assert.throws(
        () => TypeParameterNode.create(
          '',
          '/src/fn.ts:FUNCTION:identity:1',
          '/src/fn.ts',
          1,
          0
        ),
        /name is required/,
        'Should throw when name is empty'
      );
    });

    it('throws when parentId is missing', () => {
      assert.throws(
        () => TypeParameterNode.create(
          'T',
          '',
          '/src/fn.ts',
          1,
          0
        ),
        /parentId is required/,
        'Should throw when parentId is empty'
      );
    });
  });

  // ============================================================================
  // 2. TypeParameterNode validation
  // ============================================================================

  describe('TypeParameterNode validation', () => {
    it('returns empty errors for valid node', () => {
      const node = TypeParameterNode.create(
        'T',
        '/src/fn.ts:FUNCTION:identity:3',
        '/src/fn.ts',
        3,
        20
      );

      const errors = TypeParameterNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });

    it('detects invalid type', () => {
      const node = {
        id: '/src/fn.ts:FUNCTION:identity:3:TYPE_PARAMETER:T',
        type: 'WRONG_TYPE',
        name: 'T',
        file: '/src/fn.ts',
        line: 3,
        column: 20,
      };

      const errors = TypeParameterNode.validate(node);
      assert.ok(errors.length > 0, 'Should have validation errors');
      assert.ok(
        errors.some(e => e.includes('TYPE_PARAMETER')),
        `Should report type mismatch: ${JSON.stringify(errors)}`
      );
    });

    it('detects missing required fields', () => {
      const node = {
        id: '/src/fn.ts:FUNCTION:identity:3:TYPE_PARAMETER:T',
        type: 'TYPE_PARAMETER',
        name: 'T',
        // missing: file, line, column
      };

      const errors = TypeParameterNode.validate(node);
      assert.ok(errors.length > 0, 'Should have validation errors for missing fields');
    });
  });

  // ============================================================================
  // 3. NodeFactory.createTypeParameter compatibility
  // ============================================================================

  describe('NodeFactory.createTypeParameter compatibility', () => {
    it('produces same result as TypeParameterNode.create', () => {
      const viaFactory = NodeFactory.createTypeParameter(
        'T',
        '/src/fn.ts:FUNCTION:identity:3',
        '/src/fn.ts',
        3,
        20,
        { constraint: 'Serializable' }
      );

      const viaDirect = TypeParameterNode.create(
        'T',
        '/src/fn.ts:FUNCTION:identity:3',
        '/src/fn.ts',
        3,
        20,
        { constraint: 'Serializable' }
      );

      // NodeFactory wraps with brandNode but the shape should match
      assert.strictEqual(viaFactory.id, viaDirect.id,
        'IDs should match');
      assert.strictEqual(viaFactory.type, viaDirect.type);
      assert.strictEqual(viaFactory.name, viaDirect.name);
      assert.strictEqual(viaFactory.constraint, viaDirect.constraint);
    });

    it('passes validation through NodeFactory', () => {
      const node = NodeFactory.createTypeParameter(
        'K',
        '/src/types.ts:TYPE:Pair:10',
        '/src/types.ts',
        10,
        15,
        { defaultType: 'string' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });
  });

  // ============================================================================
  // 4. Integration tests - Functions
  // ============================================================================

  describe('Type parameter tracking - Functions', () => {
    let db;
    let backend;

    beforeEach(async () => {
      if (db) await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;
    });

    after(async () => {
      if (db) await db.cleanup();
    });

    it('tracks simple type parameter on function', async () => {
      await setupTest(backend, {
        'index.ts': `
export function identity<T>(x: T): T { return x; }
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find TYPE_PARAMETER node
      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');

      // Verify no constraint
      assert.strictEqual(tpNode.constraint, undefined,
        'Simple type parameter should have no constraint');

      // Find parent function
      const fnNode = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'identity'
      );
      assert.ok(fnNode, 'FUNCTION node identity should exist');

      // HAS_TYPE_PARAMETER edge from function to type parameter
      const hasTPEdge = allEdges.find(e =>
        e.type === 'HAS_TYPE_PARAMETER' &&
        e.src === fnNode.id &&
        e.dst === tpNode.id
      );
      assert.ok(hasTPEdge,
        `HAS_TYPE_PARAMETER edge from ${fnNode.id} to ${tpNode.id} should exist`);
    });

    it('tracks type parameter with constraint', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface Serializable { serialize(): string; }
export function process<T extends Serializable>(item: T): string { return item.serialize(); }
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // TYPE_PARAMETER node
      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');
      assert.strictEqual(tpNode.constraint, 'Serializable',
        'Constraint should be Serializable');

      // EXTENDS edge from TYPE_PARAMETER to constraint type
      const extendsEdge = allEdges.find(e =>
        e.type === 'EXTENDS' && e.src === tpNode.id
      );
      assert.ok(extendsEdge,
        `EXTENDS edge from TYPE_PARAMETER T should exist`);

      // EXTENDS dst should point to Serializable interface (or external ref)
      const dstNode = allNodes.find(n => n.id === extendsEdge.dst);
      assert.ok(dstNode, 'EXTENDS target node should exist');
      assert.strictEqual(dstNode.name, 'Serializable',
        'EXTENDS target should be Serializable');
    });

    it('tracks multiple type parameters', async () => {
      await setupTest(backend, {
        'index.ts': `
export function pair<A, B>(a: A, b: B): [A, B] { return [a, b]; }
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const fnNode = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'pair'
      );
      assert.ok(fnNode, 'FUNCTION node pair should exist');

      // Two TYPE_PARAMETER nodes
      const tpA = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'A'
      );
      const tpB = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'B'
      );
      assert.ok(tpA, 'TYPE_PARAMETER node A should exist');
      assert.ok(tpB, 'TYPE_PARAMETER node B should exist');

      // Both should have unique IDs
      assert.notStrictEqual(tpA.id, tpB.id,
        'A and B should have different IDs');

      // Two HAS_TYPE_PARAMETER edges
      const hasTPEdges = allEdges.filter(e =>
        e.type === 'HAS_TYPE_PARAMETER' && e.src === fnNode.id
      );
      assert.strictEqual(hasTPEdges.length, 2,
        `Should have 2 HAS_TYPE_PARAMETER edges from pair, found: ${hasTPEdges.length}`);
    });

    it('tracks type parameter with default', async () => {
      await setupTest(backend, {
        'index.ts': `
export function create<T = string>(): T { return '' as unknown as T; }
        `
      });

      const allNodes = await backend.getAllNodes();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');
      assert.strictEqual(tpNode.defaultType, 'string',
        'defaultType should be string');
    });
  });

  // ============================================================================
  // 5. Integration tests - Arrow functions
  // ============================================================================

  describe('Type parameter tracking - Arrow functions', () => {
    let db;
    let backend;

    beforeEach(async () => {
      if (db) await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;
    });

    after(async () => {
      if (db) await db.cleanup();
    });

    it('tracks type params on arrow function', async () => {
      await setupTest(backend, {
        'index.ts': `
export const identity = <T>(x: T): T => x;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist on arrow function');

      // Should have HAS_TYPE_PARAMETER edge from parent
      const hasTPEdge = allEdges.find(e =>
        e.type === 'HAS_TYPE_PARAMETER' && e.dst === tpNode.id
      );
      assert.ok(hasTPEdge,
        'HAS_TYPE_PARAMETER edge should exist pointing to T');
    });
  });

  // ============================================================================
  // 6. Integration tests - Classes
  // ============================================================================

  describe('Type parameter tracking - Classes', () => {
    let db;
    let backend;

    beforeEach(async () => {
      if (db) await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;
    });

    after(async () => {
      if (db) await db.cleanup();
    });

    it('tracks type params on class', async () => {
      await setupTest(backend, {
        'index.ts': `
export class Container<T> {
  value: T;
  constructor(v: T) { this.value = v; }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n =>
        n.type === 'CLASS' && n.name === 'Container'
      );
      assert.ok(classNode, 'CLASS node Container should exist');

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');

      const hasTPEdge = allEdges.find(e =>
        e.type === 'HAS_TYPE_PARAMETER' &&
        e.src === classNode.id &&
        e.dst === tpNode.id
      );
      assert.ok(hasTPEdge,
        `HAS_TYPE_PARAMETER edge from Container to T should exist`);
    });

    it('tracks type params with constraint on class', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface Entity { id: string; }
export class Repository<T extends Entity> {
  items: T[] = [];
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');
      assert.strictEqual(tpNode.constraint, 'Entity',
        'Constraint should be Entity');

      // EXTENDS edge from TYPE_PARAMETER to Entity
      const extendsEdge = allEdges.find(e =>
        e.type === 'EXTENDS' && e.src === tpNode.id
      );
      assert.ok(extendsEdge,
        'EXTENDS edge from TYPE_PARAMETER T should exist');

      const entityNode = allNodes.find(n => n.id === extendsEdge.dst);
      assert.ok(entityNode, 'EXTENDS target should exist');
      assert.strictEqual(entityNode.name, 'Entity',
        'EXTENDS target should be Entity');
    });

    it('tracks type params on class methods', async () => {
      await setupTest(backend, {
        'index.ts': `
export class Mapper {
  map<U>(fn: (x: number) => U): U { return fn(0); }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'U'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node U should exist on method');

      // HAS_TYPE_PARAMETER should come from the method function node
      const hasTPEdge = allEdges.find(e =>
        e.type === 'HAS_TYPE_PARAMETER' && e.dst === tpNode.id
      );
      assert.ok(hasTPEdge,
        'HAS_TYPE_PARAMETER edge to U should exist');

      // The source should be a function node (the method)
      const parentNode = allNodes.find(n => n.id === hasTPEdge.src);
      assert.ok(parentNode, 'Parent node of TYPE_PARAMETER should exist');
      assert.strictEqual(parentNode.type, 'FUNCTION',
        'Parent should be a FUNCTION node (class method)');
    });
  });

  // ============================================================================
  // 7. Integration tests - Interfaces
  // ============================================================================

  describe('Type parameter tracking - Interfaces', () => {
    let db;
    let backend;

    beforeEach(async () => {
      if (db) await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;
    });

    after(async () => {
      if (db) await db.cleanup();
    });

    it('tracks type params on interface', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface Collection<T> {
  items: T[];
  add(item: T): void;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const ifaceNode = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'Collection'
      );
      assert.ok(ifaceNode, 'INTERFACE node Collection should exist');

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');

      const hasTPEdge = allEdges.find(e =>
        e.type === 'HAS_TYPE_PARAMETER' &&
        e.src === ifaceNode.id &&
        e.dst === tpNode.id
      );
      assert.ok(hasTPEdge,
        `HAS_TYPE_PARAMETER edge from Collection to T should exist`);
    });

    it('tracks type params with constraint on interface', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface Comparable<T> {
  compareTo(other: T): number;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');
      // Comparable<T> has no constraint, so no EXTENDS edge expected
      assert.strictEqual(tpNode.constraint, undefined,
        'Unconstrained type parameter should have no constraint');
    });
  });

  // ============================================================================
  // 8. Integration tests - Type aliases
  // ============================================================================

  describe('Type parameter tracking - Type aliases', () => {
    let db;
    let backend;

    beforeEach(async () => {
      if (db) await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;
    });

    after(async () => {
      if (db) await db.cleanup();
    });

    it('tracks type params on type alias', async () => {
      await setupTest(backend, {
        'index.ts': `
export type Pair<A, B> = { first: A; second: B; };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const typeNode = allNodes.find(n =>
        n.type === 'TYPE' && n.name === 'Pair'
      );
      assert.ok(typeNode, 'TYPE node Pair should exist');

      const tpA = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'A'
      );
      const tpB = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'B'
      );
      assert.ok(tpA, 'TYPE_PARAMETER node A should exist');
      assert.ok(tpB, 'TYPE_PARAMETER node B should exist');

      // HAS_TYPE_PARAMETER edges from Pair to A and B
      const hasTPEdges = allEdges.filter(e =>
        e.type === 'HAS_TYPE_PARAMETER' && e.src === typeNode.id
      );
      assert.strictEqual(hasTPEdges.length, 2,
        `Should have 2 HAS_TYPE_PARAMETER edges from Pair, found: ${hasTPEdges.length}`);
    });

    it('tracks intersection constraint', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface HasName { name: string; }
export interface HasAge { age: number; }
export type Named<T extends HasName & HasAge> = T;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');

      // Constraint should capture the full intersection type
      assert.ok(
        tpNode.constraint && tpNode.constraint.includes('HasName'),
        `Constraint should include HasName: ${tpNode.constraint}`
      );
      assert.ok(
        tpNode.constraint && tpNode.constraint.includes('HasAge'),
        `Constraint should include HasAge: ${tpNode.constraint}`
      );

      // EXTENDS edges to both HasName and HasAge
      const extendsEdges = allEdges.filter(e =>
        e.type === 'EXTENDS' && e.src === tpNode.id
      );
      assert.strictEqual(extendsEdges.length, 2,
        `Should have 2 EXTENDS edges (one to HasName, one to HasAge), found: ${extendsEdges.length}`);

      const extendsTargetNames = extendsEdges.map(e => {
        const target = allNodes.find(n => n.id === e.dst);
        return target ? target.name : 'UNKNOWN';
      });
      assert.ok(extendsTargetNames.includes('HasName'),
        'Should have EXTENDS edge to HasName');
      assert.ok(extendsTargetNames.includes('HasAge'),
        'Should have EXTENDS edge to HasAge');
    });
  });

  // ============================================================================
  // 9. Edge cases - ID uniqueness (unit tests, no DB needed)
  // ============================================================================

  describe('Type parameter tracking - ID edge cases', () => {
    it('ID format is unique per parent and name', () => {
      const node1 = TypeParameterNode.create(
        'T',
        '/src/a.ts:FUNCTION:foo:1',
        '/src/a.ts',
        1,
        10
      );
      const node2 = TypeParameterNode.create(
        'T',
        '/src/a.ts:FUNCTION:bar:5',
        '/src/a.ts',
        5,
        10
      );
      const node3 = TypeParameterNode.create(
        'U',
        '/src/a.ts:FUNCTION:foo:1',
        '/src/a.ts',
        1,
        15
      );

      assert.notStrictEqual(node1.id, node2.id,
        'Same name but different parents should have different IDs');
      assert.notStrictEqual(node1.id, node3.id,
        'Same parent but different names should have different IDs');
    });

    it('creates consistent IDs for same parameters', () => {
      const node1 = TypeParameterNode.create(
        'T',
        '/src/fn.ts:FUNCTION:identity:3',
        '/src/fn.ts',
        3,
        20
      );
      const node2 = TypeParameterNode.create(
        'T',
        '/src/fn.ts:FUNCTION:identity:3',
        '/src/fn.ts',
        3,
        20
      );

      assert.strictEqual(node1.id, node2.id,
        'Same parameters should produce same ID');
    });
  });

  // ============================================================================
  // 10. Edge cases - Integration (primitive constraints, variance)
  // ============================================================================

  describe('Type parameter tracking - Edge cases (integration)', () => {
    let db;
    let backend;

    beforeEach(async () => {
      if (db) await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;
    });

    after(async () => {
      if (db) await db.cleanup();
    });

    it('does not create EXTENDS for primitive constraints', async () => {
      await setupTest(backend, {
        'index.ts': `
export function parse<T extends string>(input: T): T { return input; }
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');
      assert.strictEqual(tpNode.constraint, 'string',
        'Constraint should be string');

      // No EXTENDS edge for primitive constraint
      const extendsEdge = allEdges.find(e =>
        e.type === 'EXTENDS' && e.src === tpNode.id
      );
      assert.ok(!extendsEdge,
        'Should NOT create EXTENDS edge for primitive constraint "string"');
    });

    it('tracks variance annotation: out', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface Producer<out T> {
  produce(): T;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');
      assert.strictEqual(tpNode.variance, 'out',
        'Variance should be "out"');
    });

    it('tracks variance annotation: in', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface Consumer<in T> {
  consume(item: T): void;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');
      assert.strictEqual(tpNode.variance, 'in',
        'Variance should be "in"');
    });

    it('tracks variance annotation: in out', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface Mutable<in out T> {
  get(): T;
  set(value: T): void;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const tpNode = allNodes.find(n =>
        n.type === 'TYPE_PARAMETER' && n.name === 'T'
      );
      assert.ok(tpNode, 'TYPE_PARAMETER node T should exist');
      assert.strictEqual(tpNode.variance, 'in out',
        'Variance should be "in out"');
    });
  });
});
