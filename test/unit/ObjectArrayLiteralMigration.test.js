/**
 * ObjectLiteralNode and ArrayLiteralNode Migration Tests (REG-110)
 *
 * TDD tests for migrating OBJECT_LITERAL and ARRAY_LITERAL node creation
 * in CallExpressionVisitor to use factory methods.
 *
 * Verifies:
 * 1. ObjectLiteralNode.create() generates correct ID format with argIndex
 * 2. ObjectLiteralNode.create() generates correct ID format without argIndex (nested)
 * 3. ArrayLiteralNode.create() generates correct ID format with argIndex
 * 4. ArrayLiteralNode.create() generates correct ID format without argIndex (nested)
 * 5. Counter increments correctly for unique IDs
 * 6. All required fields are set on created nodes
 * 7. Integration: OBJECT_LITERAL and ARRAY_LITERAL nodes appear in graph after analysis
 *
 * ID formats:
 * - With argIndex: OBJECT_LITERAL#arg{N}#{file}#{line}:{column}:{counter}
 * - Without argIndex: OBJECT_LITERAL#obj#{file}#{line}:{column}:{counter}
 * - Array with argIndex: ARRAY_LITERAL#arg{N}#{file}#{line}:{column}:{counter}
 * - Array without argIndex: ARRAY_LITERAL#arr#{file}#{line}:{column}:{counter}
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * Some tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { NodeFactory } from '@grafema/core';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-literal-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-literal-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

// ============================================================================
// 1. ObjectLiteralNode Factory Tests (Unit Tests)
// ============================================================================

describe('ObjectArrayLiteralMigration (REG-110)', () => {
  describe('ObjectLiteralNode factory behavior', () => {
    it('should generate ID with arg{N} suffix when argIndex is provided', () => {
      const node = NodeFactory.createObjectLiteral(
        '/project/src/api.js',
        10,
        5,
        {
          parentCallId: 'CALL#test#/project/src/api.js#10:0',
          argIndex: 0,
          counter: 0
        }
      );

      // ID format: OBJECT_LITERAL#arg{N}#{file}#{line}:{column}:{counter}
      assert.strictEqual(
        node.id,
        'OBJECT_LITERAL#arg0#/project/src/api.js#10:5:0',
        'ID should include arg0 suffix for argIndex=0'
      );
    });

    it('should generate ID with arg{N} suffix for different argIndex values', () => {
      const node1 = NodeFactory.createObjectLiteral('/file.js', 5, 0, { argIndex: 0, counter: 0 });
      const node2 = NodeFactory.createObjectLiteral('/file.js', 5, 10, { argIndex: 1, counter: 1 });
      const node3 = NodeFactory.createObjectLiteral('/file.js', 5, 20, { argIndex: 2, counter: 2 });

      assert.ok(node1.id.includes('#arg0#'), `First arg should have arg0: ${node1.id}`);
      assert.ok(node2.id.includes('#arg1#'), `Second arg should have arg1: ${node2.id}`);
      assert.ok(node3.id.includes('#arg2#'), `Third arg should have arg2: ${node3.id}`);
    });

    it('should generate ID with obj suffix when argIndex is NOT provided', () => {
      const node = NodeFactory.createObjectLiteral(
        '/project/src/data.js',
        15,
        8,
        {
          counter: 5
        }
      );

      // ID format: OBJECT_LITERAL#obj#{file}#{line}:{column}:{counter}
      assert.strictEqual(
        node.id,
        'OBJECT_LITERAL#obj#/project/src/data.js#15:8:5',
        'ID should use obj suffix when no argIndex'
      );
    });

    it('should include counter in ID for uniqueness', () => {
      const node1 = NodeFactory.createObjectLiteral('/file.js', 10, 0, { counter: 0 });
      const node2 = NodeFactory.createObjectLiteral('/file.js', 10, 0, { counter: 1 });
      const node3 = NodeFactory.createObjectLiteral('/file.js', 10, 0, { counter: 2 });

      assert.notStrictEqual(node1.id, node2.id, 'Different counters should produce different IDs');
      assert.notStrictEqual(node2.id, node3.id, 'Different counters should produce different IDs');
      assert.ok(node1.id.endsWith(':0'), `First ID should end with :0: ${node1.id}`);
      assert.ok(node2.id.endsWith(':1'), `Second ID should end with :1: ${node2.id}`);
      assert.ok(node3.id.endsWith(':2'), `Third ID should end with :2: ${node3.id}`);
    });

    it('should set all required fields correctly', () => {
      const node = NodeFactory.createObjectLiteral(
        '/project/models/user.js',
        25,
        4,
        {
          parentCallId: 'CALL#createUser#/project/models/user.js#25:0',
          argIndex: 0,
          counter: 3
        }
      );

      assert.strictEqual(node.type, 'OBJECT_LITERAL');
      assert.strictEqual(node.name, '<object>');
      assert.strictEqual(node.file, '/project/models/user.js');
      assert.strictEqual(node.line, 25);
      assert.strictEqual(node.column, 4);
      assert.strictEqual(node.parentCallId, 'CALL#createUser#/project/models/user.js#25:0');
      assert.strictEqual(node.argIndex, 0);
    });

    it('should work without optional parentCallId', () => {
      const node = NodeFactory.createObjectLiteral(
        '/file.js',
        10,
        0,
        { counter: 0 }
      );

      assert.strictEqual(node.type, 'OBJECT_LITERAL');
      assert.strictEqual(node.parentCallId, undefined);
      assert.strictEqual(node.argIndex, undefined);
    });

    it('should create consistent IDs for same parameters', () => {
      const node1 = NodeFactory.createObjectLiteral('/file.js', 10, 5, { argIndex: 0, counter: 0 });
      const node2 = NodeFactory.createObjectLiteral('/file.js', 10, 5, { argIndex: 0, counter: 0 });

      assert.strictEqual(node1.id, node2.id, 'Same parameters should produce same ID');
    });
  });

  // ============================================================================
  // 2. ArrayLiteralNode Factory Tests (Unit Tests)
  // ============================================================================

  describe('ArrayLiteralNode factory behavior', () => {
    it('should generate ID with arg{N} suffix when argIndex is provided', () => {
      const node = NodeFactory.createArrayLiteral(
        '/project/src/api.js',
        10,
        5,
        {
          parentCallId: 'CALL#test#/project/src/api.js#10:0',
          argIndex: 0,
          counter: 0
        }
      );

      // ID format: ARRAY_LITERAL#arg{N}#{file}#{line}:{column}:{counter}
      assert.strictEqual(
        node.id,
        'ARRAY_LITERAL#arg0#/project/src/api.js#10:5:0',
        'ID should include arg0 suffix for argIndex=0'
      );
    });

    it('should generate ID with arg{N} suffix for different argIndex values', () => {
      const node1 = NodeFactory.createArrayLiteral('/file.js', 5, 0, { argIndex: 0, counter: 0 });
      const node2 = NodeFactory.createArrayLiteral('/file.js', 5, 10, { argIndex: 1, counter: 1 });
      const node3 = NodeFactory.createArrayLiteral('/file.js', 5, 20, { argIndex: 2, counter: 2 });

      assert.ok(node1.id.includes('#arg0#'), `First arg should have arg0: ${node1.id}`);
      assert.ok(node2.id.includes('#arg1#'), `Second arg should have arg1: ${node2.id}`);
      assert.ok(node3.id.includes('#arg2#'), `Third arg should have arg2: ${node3.id}`);
    });

    it('should generate ID with arr suffix when argIndex is NOT provided', () => {
      const node = NodeFactory.createArrayLiteral(
        '/project/src/data.js',
        15,
        8,
        {
          counter: 5
        }
      );

      // ID format: ARRAY_LITERAL#arr#{file}#{line}:{column}:{counter}
      assert.strictEqual(
        node.id,
        'ARRAY_LITERAL#arr#/project/src/data.js#15:8:5',
        'ID should use arr suffix when no argIndex'
      );
    });

    it('should include counter in ID for uniqueness', () => {
      const node1 = NodeFactory.createArrayLiteral('/file.js', 10, 0, { counter: 0 });
      const node2 = NodeFactory.createArrayLiteral('/file.js', 10, 0, { counter: 1 });
      const node3 = NodeFactory.createArrayLiteral('/file.js', 10, 0, { counter: 2 });

      assert.notStrictEqual(node1.id, node2.id, 'Different counters should produce different IDs');
      assert.notStrictEqual(node2.id, node3.id, 'Different counters should produce different IDs');
      assert.ok(node1.id.endsWith(':0'), `First ID should end with :0: ${node1.id}`);
      assert.ok(node2.id.endsWith(':1'), `Second ID should end with :1: ${node2.id}`);
      assert.ok(node3.id.endsWith(':2'), `Third ID should end with :2: ${node3.id}`);
    });

    it('should set all required fields correctly', () => {
      const node = NodeFactory.createArrayLiteral(
        '/project/models/items.js',
        30,
        8,
        {
          parentCallId: 'CALL#createItems#/project/models/items.js#30:0',
          argIndex: 1,
          counter: 2
        }
      );

      assert.strictEqual(node.type, 'ARRAY_LITERAL');
      assert.strictEqual(node.name, '<array>');
      assert.strictEqual(node.file, '/project/models/items.js');
      assert.strictEqual(node.line, 30);
      assert.strictEqual(node.column, 8);
      assert.strictEqual(node.parentCallId, 'CALL#createItems#/project/models/items.js#30:0');
      assert.strictEqual(node.argIndex, 1);
    });

    it('should work without optional parentCallId', () => {
      const node = NodeFactory.createArrayLiteral(
        '/file.js',
        10,
        0,
        { counter: 0 }
      );

      assert.strictEqual(node.type, 'ARRAY_LITERAL');
      assert.strictEqual(node.parentCallId, undefined);
      assert.strictEqual(node.argIndex, undefined);
    });

    it('should create consistent IDs for same parameters', () => {
      const node1 = NodeFactory.createArrayLiteral('/file.js', 10, 5, { argIndex: 0, counter: 0 });
      const node2 = NodeFactory.createArrayLiteral('/file.js', 10, 5, { argIndex: 0, counter: 0 });

      assert.strictEqual(node1.id, node2.id, 'Same parameters should produce same ID');
    });
  });

  // ============================================================================
  // 3. Integration Tests - GraphBuilder (OBJECT_LITERAL nodes in graph)
  // These tests verify that after analysis, literal nodes appear in the graph.
  // NOTE: Currently GraphBuilder does NOT buffer object/array literals to graph.
  // These tests document the expected behavior AFTER migration.
  // ============================================================================

  describe('GraphBuilder integration - OBJECT_LITERAL', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    it('should create OBJECT_LITERAL node for object arg in function call', async () => {
      await setupTest(backend, {
        'index.js': `
function processData(config) {
  return config;
}

processData({ key: 'value', count: 42 });
        `
      });

      const allNodes = await backend.getAllNodes();
      const objectLiteralNode = allNodes.find(n => n.type === 'OBJECT_LITERAL');

      // After migration: OBJECT_LITERAL node should exist in graph
      assert.ok(objectLiteralNode,
        'OBJECT_LITERAL node should be created for object arg');

      // Verify node fields
      assert.strictEqual(objectLiteralNode.type, 'OBJECT_LITERAL');
      assert.ok(objectLiteralNode.file.endsWith('index.js'),
        `File should be index.js: ${objectLiteralNode.file}`);
      assert.ok(objectLiteralNode.line > 0, 'Line should be set');
    });

    it('should create OBJECT_LITERAL node with correct ID format (arg suffix)', async () => {
      await setupTest(backend, {
        'index.js': `
function createUser(data) {
  return data;
}

createUser({ name: 'test', email: 'test@example.com' });
        `
      });

      const allNodes = await backend.getAllNodes();
      const objectLiteralNode = allNodes.find(n => n.type === 'OBJECT_LITERAL');

      assert.ok(objectLiteralNode, 'OBJECT_LITERAL node should exist');

      // ID should use factory format: OBJECT_LITERAL#arg{N}#...
      assert.ok(
        objectLiteralNode.id.includes('#arg'),
        `ID should include #arg suffix: ${objectLiteralNode.id}`
      );
    });

    it('should handle multiple object literals in same call', async () => {
      await setupTest(backend, {
        'index.js': `
function merge(a, b) {
  return { ...a, ...b };
}

merge({ x: 1 }, { y: 2 });
        `
      });

      const allNodes = await backend.getAllNodes();
      const objectLiteralNodes = allNodes.filter(n => n.type === 'OBJECT_LITERAL');

      // Should have 2 object literals (one for each arg)
      assert.strictEqual(objectLiteralNodes.length, 2,
        `Should have 2 OBJECT_LITERAL nodes, found: ${objectLiteralNodes.length}`);

      // Each should have unique ID
      const ids = objectLiteralNodes.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 2, 'All object literal IDs should be unique');
    });
  });

  // ============================================================================
  // 4. Integration Tests - GraphBuilder (ARRAY_LITERAL nodes in graph)
  // ============================================================================

  describe('GraphBuilder integration - ARRAY_LITERAL', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    it('should create ARRAY_LITERAL node for array arg in function call', async () => {
      await setupTest(backend, {
        'index.js': `
function processItems(items) {
  return items;
}

processItems([1, 2, 3, 4, 5]);
        `
      });

      const allNodes = await backend.getAllNodes();
      const arrayLiteralNode = allNodes.find(n => n.type === 'ARRAY_LITERAL');

      // After migration: ARRAY_LITERAL node should exist in graph
      assert.ok(arrayLiteralNode,
        'ARRAY_LITERAL node should be created for array arg');

      // Verify node fields
      assert.strictEqual(arrayLiteralNode.type, 'ARRAY_LITERAL');
      assert.ok(arrayLiteralNode.file.endsWith('index.js'),
        `File should be index.js: ${arrayLiteralNode.file}`);
      assert.ok(arrayLiteralNode.line > 0, 'Line should be set');
    });

    it('should create ARRAY_LITERAL node with correct ID format (arg suffix)', async () => {
      await setupTest(backend, {
        'index.js': `
function sum(numbers) {
  return numbers.reduce((a, b) => a + b, 0);
}

sum([10, 20, 30]);
        `
      });

      const allNodes = await backend.getAllNodes();
      const arrayLiteralNode = allNodes.find(n => n.type === 'ARRAY_LITERAL');

      assert.ok(arrayLiteralNode, 'ARRAY_LITERAL node should exist');

      // ID should use factory format: ARRAY_LITERAL#arg{N}#...
      assert.ok(
        arrayLiteralNode.id.includes('#arg'),
        `ID should include #arg suffix: ${arrayLiteralNode.id}`
      );
    });

    it('should handle mixed object and array literals', async () => {
      await setupTest(backend, {
        'index.js': `
function init(config, items) {
  return { config, items };
}

init({ debug: true }, ['a', 'b', 'c']);
        `
      });

      const allNodes = await backend.getAllNodes();
      const objectLiteralNodes = allNodes.filter(n => n.type === 'OBJECT_LITERAL');
      const arrayLiteralNodes = allNodes.filter(n => n.type === 'ARRAY_LITERAL');

      // Should have 1 object literal and 1 array literal
      assert.strictEqual(objectLiteralNodes.length, 1,
        `Should have 1 OBJECT_LITERAL node, found: ${objectLiteralNodes.length}`);
      assert.strictEqual(arrayLiteralNodes.length, 1,
        `Should have 1 ARRAY_LITERAL node, found: ${arrayLiteralNodes.length}`);
    });
  });

  // ============================================================================
  // 5. Nested Literals (Breaking Change Tests)
  // After migration, nested literals will use 'obj'/'arr' suffix instead of
  // property names or 'elem{N}' indices.
  // ============================================================================

  describe('Nested literals ID format (breaking change)', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    it('should use obj suffix for nested object in object property (not property name)', async () => {
      await setupTest(backend, {
        'index.js': `
function process(data) {
  return data;
}

process({
  config: { nested: true }
});
        `
      });

      const allNodes = await backend.getAllNodes();
      const objectLiteralNodes = allNodes.filter(n => n.type === 'OBJECT_LITERAL');

      // Should have 2 object literals: outer (arg0) and inner (obj)
      assert.strictEqual(objectLiteralNodes.length, 2,
        `Should have 2 OBJECT_LITERAL nodes, found: ${objectLiteralNodes.length}`);

      // Nested object should use 'obj' suffix, NOT 'config'
      const nestedNode = objectLiteralNodes.find(n => n.id.includes('#obj#'));
      assert.ok(nestedNode,
        `Nested object should use #obj# suffix. IDs found: ${objectLiteralNodes.map(n => n.id).join(', ')}`);

      // Should NOT use property name in ID
      const hasPropertyNameInId = objectLiteralNodes.some(n => n.id.includes('#config#'));
      assert.ok(!hasPropertyNameInId,
        'Nested object ID should NOT contain property name');
    });

    it('should use arr suffix for nested array in object property (not property name)', async () => {
      await setupTest(backend, {
        'index.js': `
function process(data) {
  return data;
}

process({
  items: [1, 2, 3]
});
        `
      });

      const allNodes = await backend.getAllNodes();
      const arrayLiteralNodes = allNodes.filter(n => n.type === 'ARRAY_LITERAL');

      // Should have array literal with 'arr' suffix, NOT 'items'
      assert.ok(arrayLiteralNodes.length >= 1, 'Should have at least 1 ARRAY_LITERAL node');

      const nestedNode = arrayLiteralNodes.find(n => n.id.includes('#arr#'));
      assert.ok(nestedNode,
        `Nested array should use #arr# suffix. IDs found: ${arrayLiteralNodes.map(n => n.id).join(', ')}`);

      // Should NOT use property name in ID
      const hasPropertyNameInId = arrayLiteralNodes.some(n => n.id.includes('#items#'));
      assert.ok(!hasPropertyNameInId,
        'Nested array ID should NOT contain property name');
    });

    it('should use obj suffix for nested object in array element (not elem{N})', async () => {
      await setupTest(backend, {
        'index.js': `
function process(arr) {
  return arr;
}

process([{ a: 1 }, { b: 2 }]);
        `
      });

      const allNodes = await backend.getAllNodes();
      const objectLiteralNodes = allNodes.filter(n => n.type === 'OBJECT_LITERAL');

      // Should have 2 nested objects with 'obj' suffix
      assert.ok(objectLiteralNodes.length >= 2, 'Should have at least 2 OBJECT_LITERAL nodes');

      // All nested objects should use 'obj' suffix, NOT 'elem0', 'elem1'
      const nodesWithObjSuffix = objectLiteralNodes.filter(n => n.id.includes('#obj#'));
      assert.strictEqual(nodesWithObjSuffix.length, 2,
        `Should have 2 nodes with #obj# suffix. IDs: ${objectLiteralNodes.map(n => n.id).join(', ')}`);

      // Should NOT use elem{N} in ID
      const hasElemInId = objectLiteralNodes.some(n => /elem\d/.test(n.id));
      assert.ok(!hasElemInId,
        'Nested object in array should NOT use elem{N} in ID');
    });

    it('should use arr suffix for nested array in array element (not elem{N})', async () => {
      await setupTest(backend, {
        'index.js': `
function process(matrix) {
  return matrix;
}

process([[1, 2], [3, 4]]);
        `
      });

      const allNodes = await backend.getAllNodes();
      const arrayLiteralNodes = allNodes.filter(n => n.type === 'ARRAY_LITERAL');

      // Should have 3 arrays: outer (arg0) and 2 inner (arr)
      assert.strictEqual(arrayLiteralNodes.length, 3,
        `Should have 3 ARRAY_LITERAL nodes, found: ${arrayLiteralNodes.length}`);

      // Nested arrays should use 'arr' suffix
      const nodesWithArrSuffix = arrayLiteralNodes.filter(n => n.id.includes('#arr#'));
      assert.strictEqual(nodesWithArrSuffix.length, 2,
        `Should have 2 nodes with #arr# suffix. IDs: ${arrayLiteralNodes.map(n => n.id).join(', ')}`);

      // Should NOT use elem{N} in ID
      const hasElemInId = arrayLiteralNodes.some(n => /elem\d/.test(n.id));
      assert.ok(!hasElemInId,
        'Nested array in array should NOT use elem{N} in ID');
    });
  });

  // ============================================================================
  // 6. Validation Tests
  // ============================================================================

  describe('NodeFactory validation', () => {
    it('should pass validation for ObjectLiteralNode', () => {
      const node = NodeFactory.createObjectLiteral(
        '/project/file.js',
        10,
        5,
        { parentCallId: 'CALL#test', argIndex: 0, counter: 0 }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for ArrayLiteralNode', () => {
      const node = NodeFactory.createArrayLiteral(
        '/project/file.js',
        10,
        5,
        { parentCallId: 'CALL#test', argIndex: 0, counter: 0 }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });

    it('should fail validation for missing file in ObjectLiteralNode', () => {
      assert.throws(
        () => NodeFactory.createObjectLiteral('', 10, 5, { counter: 0 }),
        /file is required/,
        'Should throw when file is empty'
      );
    });

    it('should fail validation for missing file in ArrayLiteralNode', () => {
      assert.throws(
        () => NodeFactory.createArrayLiteral('', 10, 5, { counter: 0 }),
        /file is required/,
        'Should throw when file is empty'
      );
    });
  });
});
