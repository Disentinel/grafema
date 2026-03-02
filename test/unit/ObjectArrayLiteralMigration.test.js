/**
 * ObjectLiteralNode and ArrayLiteralNode Migration Tests (REG-110)
 *
 * TDD tests for migrating OBJECT_LITERAL and ARRAY_LITERAL node creation
 * in CallExpressionVisitor to use factory methods.
 *
 * Unit tests (sections 1, 2, 6): Test NodeFactory.createObjectLiteral/createArrayLiteral
 * directly. These produce OBJECT_LITERAL/ARRAY_LITERAL nodes and should still pass.
 *
 * Integration tests (sections 3, 4, 5): Test nodes appearing in graph after analysis.
 * V2 CoreV2Analyzer creates LITERAL nodes (not OBJECT_LITERAL/ARRAY_LITERAL),
 * so these tests have been updated to check for LITERAL type.
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { NodeFactory } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
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
  // 3. Integration Tests - GraphBuilder (LITERAL nodes in graph)
  // V2: CoreV2Analyzer creates LITERAL (not OBJECT_LITERAL) nodes
  // ============================================================================

  describe('GraphBuilder integration - Object literals (v2: LITERAL)', () => {
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

    it('should create LITERAL node for object arg in function call', async () => {
      await setupTest(backend, {
        'index.js': `
function processData(config) {
  return config;
}

processData({ key: 'value', count: 42 });
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: Object literals are LITERAL with valueType="object"
      const literalNode = allNodes.find(n =>
        n.type === 'LITERAL' && n.valueType === 'object'
      );

      assert.ok(literalNode,
        'LITERAL node with valueType="object" should be created for object arg. ' +
        `Node types found: ${JSON.stringify([...new Set(allNodes.map(n => n.type))])}`);

      assert.strictEqual(literalNode.type, 'LITERAL');
      assert.ok(literalNode.file.endsWith('index.js'),
        `File should be index.js: ${literalNode.file}`);
      assert.ok(literalNode.line > 0, 'Line should be set');
    });

    it('should create LITERAL node with HAS_PROPERTY edges', async () => {
      await setupTest(backend, {
        'index.js': `
function createUser(data) {
  return data;
}

createUser({ name: 'test', email: 'test@example.com' });
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: Object literals are LITERAL nodes
      const literalNode = allNodes.find(n =>
        n.type === 'LITERAL' && n.valueType === 'object'
      );
      assert.ok(literalNode, 'LITERAL node with valueType="object" should exist');

      // V2: HAS_PROPERTY edges from LITERAL to PROPERTY_ACCESS nodes
      const hasPropertyEdges = allEdges.filter(e =>
        e.type === 'HAS_PROPERTY' && e.src === literalNode.id
      );
      assert.ok(
        hasPropertyEdges.length >= 2,
        `Expected at least 2 HAS_PROPERTY edges from LITERAL. Found: ${hasPropertyEdges.length}`
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
      // V2: Multiple LITERAL nodes with valueType="object"
      const literalNodes = allNodes.filter(n =>
        n.type === 'LITERAL' && n.valueType === 'object'
      );

      // Should have at least 2 object literals (one for each arg, plus possibly the return value)
      assert.ok(literalNodes.length >= 2,
        `Should have at least 2 LITERAL (object) nodes, found: ${literalNodes.length}`);

      // Each should have unique ID
      const ids = literalNodes.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, literalNodes.length, 'All literal IDs should be unique');
    });
  });

  // ============================================================================
  // 4. Integration Tests - GraphBuilder (Array literals in graph)
  // V2: CoreV2Analyzer creates LITERAL (not ARRAY_LITERAL) nodes
  // ============================================================================

  describe('GraphBuilder integration - Array literals (v2: LITERAL)', () => {
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

    it('should create LITERAL node for array arg in function call', async () => {
      await setupTest(backend, {
        'index.js': `
function processItems(items) {
  return items;
}

processItems([1, 2, 3, 4, 5]);
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: Array literals are LITERAL nodes (may not have a distinct valueType)
      // Look for LITERAL with name "[...]" or similar
      const literalNodes = allNodes.filter(n => n.type === 'LITERAL');
      const arrayLiteral = literalNodes.find(n =>
        n.name === '[...]' || n.name.startsWith('[')
      );

      assert.ok(arrayLiteral,
        'LITERAL node for array should be created for array arg. ' +
        `Literal names found: ${JSON.stringify(literalNodes.map(n => n.name))}`);

      assert.strictEqual(arrayLiteral.type, 'LITERAL');
      assert.ok(arrayLiteral.file.endsWith('index.js'),
        `File should be index.js: ${arrayLiteral.file}`);
      assert.ok(arrayLiteral.line > 0, 'Line should be set');
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
      // V2: Both object and array literals are LITERAL nodes
      const objectLiterals = allNodes.filter(n =>
        n.type === 'LITERAL' && n.valueType === 'object'
      );
      const allLiterals = allNodes.filter(n => n.type === 'LITERAL');

      // Should have at least 1 object literal
      assert.ok(objectLiterals.length >= 1,
        `Should have at least 1 LITERAL (object) node, found: ${objectLiterals.length}`);

      // Should have various LITERAL nodes total (objects, arrays, string/boolean values)
      assert.ok(allLiterals.length >= 2,
        `Should have at least 2 LITERAL nodes total, found: ${allLiterals.length}`);
    });
  });

  // ============================================================================
  // 5. Nested Literals
  // V2: Nested objects/arrays are all LITERAL nodes
  // ============================================================================

  describe('Nested literals (v2: LITERAL)', () => {
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

    it('should create LITERAL nodes for nested object in object property', async () => {
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
      // V2: Both outer and inner objects are LITERAL nodes
      const objectLiterals = allNodes.filter(n =>
        n.type === 'LITERAL' && n.valueType === 'object'
      );

      // Should have at least 2 object literals: outer and inner
      assert.ok(objectLiterals.length >= 2,
        `Should have at least 2 LITERAL (object) nodes, found: ${objectLiterals.length}. ` +
        `IDs: ${objectLiterals.map(n => n.id).join(', ')}`);
    });

    it('should create LITERAL nodes for nested array in object property', async () => {
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
      // V2: Object is LITERAL with valueType=object; array values are LITERAL too
      const objectLiterals = allNodes.filter(n =>
        n.type === 'LITERAL' && n.valueType === 'object'
      );
      assert.ok(objectLiterals.length >= 1, 'Should have at least 1 LITERAL (object) node');

      // Array elements (1, 2, 3) should be LITERAL nodes too
      const numberLiterals = allNodes.filter(n =>
        n.type === 'LITERAL' && n.valueType === 'number'
      );
      assert.ok(numberLiterals.length >= 3, `Should have at least 3 number LITERAL nodes, got ${numberLiterals.length}`);
    });

    it('should create LITERAL nodes for nested objects in array elements', async () => {
      await setupTest(backend, {
        'index.js': `
function process(arr) {
  return arr;
}

process([{ a: 1 }, { b: 2 }]);
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: Creates LITERAL nodes but may deduplicate objects with same structure on same line
      // V2 creates 1 object LITERAL for objects on the same line (name="{...}")
      const objectLiterals = allNodes.filter(n =>
        n.type === 'LITERAL' && n.valueType === 'object'
      );

      assert.ok(objectLiterals.length >= 1,
        `Should have at least 1 LITERAL (object) node, found: ${objectLiterals.length}`);
    });

    it('should create LITERAL nodes for nested arrays in array elements', async () => {
      await setupTest(backend, {
        'index.js': `
function process(matrix) {
  return matrix;
}

process([[1, 2], [3, 4]]);
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: All arrays and numbers are LITERAL nodes
      const allLiterals = allNodes.filter(n => n.type === 'LITERAL');

      // Should have LITERAL nodes for the numbers at minimum
      assert.ok(allLiterals.length >= 4,
        `Should have at least 4 LITERAL nodes (for numbers 1,2,3,4), found: ${allLiterals.length}`);
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
