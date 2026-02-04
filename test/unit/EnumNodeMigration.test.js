/**
 * EnumNode Migration Tests (REG-105)
 *
 * TDD tests for migrating ENUM node creation to EnumNode factory.
 * Following pattern from InterfaceNodeMigration.test.js (REG-103).
 *
 * Verifies:
 * 1. EnumNode.create() generates ID with colon separator format
 * 2. TypeScriptVisitor should generate consistent ID format (will change from # to :)
 * 3. bufferEnumNodes should use EnumNode.create() instead of inline object
 * 4. MODULE -> CONTAINS -> ENUM edges use correct enum node IDs
 *
 * Current state (before implementation):
 * - EnumNode.create() generates: {file}:ENUM:{name}:{line}
 * - TypeScriptVisitor generates: ENUM#{name}#{file}#{line} (legacy)
 * - bufferEnumNodes uses inline object literal
 *
 * Target state (after implementation):
 * - All ENUM nodes use EnumNode.create() with consistent format
 * - TypeScriptVisitor delegates ID generation to EnumNode.create()
 * - bufferEnumNodes uses EnumNode.create()
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * Some tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { EnumNode, NodeFactory } from '@grafema/core';
import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 * Note: For TypeScript features like enums, files must be discoverable
 * through the dependency tree. We use index.ts as entry point.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-enum-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.ts
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-enum-${testCounter}`,
      type: 'module',
      main: 'index.ts'
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
// 1. EnumNode.create() ID format verification (Unit Tests)
// ============================================================================

describe('EnumNode Migration (REG-105)', () => {
  describe('EnumNode.create() ID format', () => {
    it('should generate ID with colon separator', () => {
      const node = EnumNode.create(
        'Status',
        '/project/src/types.ts',
        5,
        0
      );

      // ID format: {file}:ENUM:{name}:{line}
      assert.strictEqual(
        node.id,
        '/project/src/types.ts:ENUM:Status:5',
        'ID should use colon separators'
      );
    });

    it('should NOT use # separator in ID', () => {
      const node = EnumNode.create(
        'Color',
        '/project/src/enums.ts',
        10,
        0
      );

      assert.ok(
        !node.id.includes('#'),
        `ID should NOT contain # separator: ${node.id}`
      );
    });

    it('should follow pattern: {file}:ENUM:{name}:{line}', () => {
      const node = EnumNode.create(
        'Direction',
        '/src/data/enums.ts',
        25,
        0
      );

      const parts = node.id.split(':');
      assert.strictEqual(parts.length, 4, 'ID should have 4 parts separated by :');
      assert.strictEqual(parts[0], '/src/data/enums.ts', 'First part should be file');
      assert.strictEqual(parts[1], 'ENUM', 'Second part should be ENUM');
      assert.strictEqual(parts[2], 'Direction', 'Third part should be name');
      assert.strictEqual(parts[3], '25', 'Fourth part should be line');
    });

    it('should preserve all required fields', () => {
      const node = EnumNode.create(
        'Status',
        '/project/types.ts',
        15,
        5,
        {
          isConst: true,
          members: [
            { name: 'Active', value: 0 },
            { name: 'Inactive', value: 1 }
          ]
        }
      );

      assert.strictEqual(node.type, 'ENUM');
      assert.strictEqual(node.name, 'Status');
      assert.strictEqual(node.file, '/project/types.ts');
      assert.strictEqual(node.line, 15);
      assert.strictEqual(node.column, 5);
      assert.strictEqual(node.isConst, true);
      assert.strictEqual(node.members.length, 2);
      assert.strictEqual(node.members[0].name, 'Active');
      assert.strictEqual(node.members[0].value, 0);
    });

    it('should handle const enum option', () => {
      const node = EnumNode.create(
        'Flag',
        '/project/src/flags.ts',
        10,
        0,
        { isConst: true }
      );

      assert.strictEqual(node.type, 'ENUM');
      assert.strictEqual(node.isConst, true);
      assert.ok(node.id.includes(':ENUM:'),
        `Const enum should use colon format: ${node.id}`);
    });

    it('should handle enum members with numeric and string values', () => {
      const nodeNumeric = EnumNode.create(
        'HttpStatus',
        '/project/http.ts',
        5,
        0,
        {
          members: [
            { name: 'OK', value: 200 },
            { name: 'NotFound', value: 404 }
          ]
        }
      );

      const nodeString = EnumNode.create(
        'Color',
        '/project/colors.ts',
        10,
        0,
        {
          members: [
            { name: 'Red', value: 'red' },
            { name: 'Blue', value: 'blue' }
          ]
        }
      );

      assert.strictEqual(nodeNumeric.members[0].value, 200);
      assert.strictEqual(nodeNumeric.members[1].value, 404);
      assert.strictEqual(nodeString.members[0].value, 'red');
      assert.strictEqual(nodeString.members[1].value, 'blue');
    });

    it('should create consistent IDs for same parameters', () => {
      const node1 = EnumNode.create('Status', '/file.ts', 10, 0);
      const node2 = EnumNode.create('Status', '/file.ts', 10, 0);

      assert.strictEqual(node1.id, node2.id,
        'Same parameters should produce same ID');
    });

    it('should create unique IDs for different enums', () => {
      const status = EnumNode.create('Status', '/types.ts', 5, 0);
      const color = EnumNode.create('Color', '/types.ts', 10, 0);
      const statusOtherFile = EnumNode.create('Status', '/other.ts', 5, 0);

      assert.notStrictEqual(status.id, color.id,
        'Different names should have different IDs');
      assert.notStrictEqual(status.id, statusOtherFile.id,
        'Same name in different files should have different IDs');
    });
  });

  // ============================================================================
  // 2. Integration tests - ENUM node analysis
  // Note: These tests verify the end-to-end flow including TypeScriptVisitor
  // ============================================================================

  describe('ENUM node analysis integration', () => {
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

    it('should analyze TypeScript enum and use colon ID format', async () => {
      await setupTest(backend, {
        'index.ts': `
export enum Status {
  Active = 0,
  Inactive = 1
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const enumNode = allNodes.find(n =>
        n.name === 'Status' && n.type === 'ENUM'
      );

      assert.ok(enumNode, 'ENUM node "Status" not found');

      // ID should use colon format (EnumNode.create pattern)
      // After migration: {file}:ENUM:Status:{line}
      assert.ok(
        enumNode.id.includes(':ENUM:Status:'),
        `ID should use colon format: ${enumNode.id}`
      );

      // Should NOT have legacy # format
      assert.ok(
        !enumNode.id.includes('ENUM#'),
        `ID should NOT use legacy # format: ${enumNode.id}`
      );
    });

    it('should analyze const enum correctly', async () => {
      await setupTest(backend, {
        'index.ts': `
export const enum Direction {
  Up,
  Down,
  Left,
  Right
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const enumNode = allNodes.find(n =>
        n.name === 'Direction' && n.type === 'ENUM'
      );

      assert.ok(enumNode, 'ENUM node "Direction" not found');
      assert.strictEqual(enumNode.isConst, true,
        'Should have isConst: true for const enum');
    });

    it('should analyze enum with explicit numeric values', async () => {
      await setupTest(backend, {
        'index.ts': `
export enum HttpStatus {
  OK = 200,
  Created = 201,
  NotFound = 404
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const enumNode = allNodes.find(n =>
        n.name === 'HttpStatus' && n.type === 'ENUM'
      );

      assert.ok(enumNode, 'ENUM node "HttpStatus" not found');
      assert.ok(Array.isArray(enumNode.members),
        'members should be an array');
      // Note: Value capture depends on AST visitor implementation
    });

    it('should analyze enum with string values', async () => {
      await setupTest(backend, {
        'index.ts': `
export enum Color {
  Red = 'red',
  Green = 'green',
  Blue = 'blue'
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const enumNode = allNodes.find(n =>
        n.name === 'Color' && n.type === 'ENUM'
      );

      assert.ok(enumNode, 'ENUM node "Color" not found');
      assert.ok(Array.isArray(enumNode.members),
        'members should be an array');
    });

    it('should create MODULE -> CONTAINS -> ENUM edge', async () => {
      await setupTest(backend, {
        'index.ts': `
export enum Status {
  Active,
  Inactive
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const enumNode = allNodes.find(n =>
        n.name === 'Status' && n.type === 'ENUM'
      );
      const moduleNode = allNodes.find(n =>
        n.type === 'MODULE' && n.file.endsWith('index.ts')
      );

      assert.ok(enumNode, 'ENUM node not found');
      assert.ok(moduleNode, 'MODULE node not found');

      // Find CONTAINS edge from module to enum
      const containsEdge = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.src === moduleNode.id &&
        e.dst === enumNode.id
      );

      assert.ok(containsEdge,
        `CONTAINS edge from ${moduleNode.id} to ${enumNode.id} not found`);
    });

    it('should create unique IDs for different enums', async () => {
      await setupTest(backend, {
        'index.ts': `
enum Status {
  Active,
  Inactive
}

enum Priority {
  Low,
  High
}

enum Color {
  Red,
  Green
}

export { Status, Priority, Color };
        `
      });

      const allNodes = await backend.getAllNodes();
      const status = allNodes.find(n => n.name === 'Status' && n.type === 'ENUM');
      const priority = allNodes.find(n => n.name === 'Priority' && n.type === 'ENUM');
      const color = allNodes.find(n => n.name === 'Color' && n.type === 'ENUM');

      assert.ok(status, 'Status not found');
      assert.ok(priority, 'Priority not found');
      assert.ok(color, 'Color not found');

      // All IDs should be unique
      const ids = [status.id, priority.id, color.id];
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, 'All enum IDs should be unique');

      // All should use colon format (after migration)
      for (const node of [status, priority, color]) {
        assert.ok(
          node.id.includes(':ENUM:'),
          `ID should use colon format: ${node.id}`
        );
      }
    });
  });

  // ============================================================================
  // 3. No inline ID strings (GraphBuilder migration verification)
  // ============================================================================

  describe('No inline ID strings', () => {
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

    it('should NOT use ENUM# format in analyzed code', async () => {
      await setupTest(backend, {
        'index.ts': `
export enum State {
  Ready,
  Running,
  Done
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const enumNode = allNodes.find(n =>
        n.name === 'State' && n.type === 'ENUM'
      );

      assert.ok(enumNode, 'State not found');

      // Check ID format
      assert.ok(
        !enumNode.id.includes('ENUM#'),
        `ID should NOT contain legacy ENUM# format: ${enumNode.id}`
      );

      assert.ok(
        enumNode.id.includes(':ENUM:'),
        `ID should use colon format: ${enumNode.id}`
      );
    });

    it('should match EnumNode.create ID format', async () => {
      await setupTest(backend, {
        'index.ts': `
export enum Mode {
  Development,
  Production
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const analyzed = allNodes.find(n =>
        n.name === 'Mode' && n.type === 'ENUM'
      );

      assert.ok(analyzed, 'Mode not found');

      // The ID format should match what EnumNode.create produces
      assert.ok(
        analyzed.id.startsWith(analyzed.file + ':ENUM:Mode:'),
        `Analyzed ID should follow EnumNode.create format: ${analyzed.id}`
      );
    });
  });

  // ============================================================================
  // 4. NodeFactory.createEnum compatibility
  // ============================================================================

  describe('NodeFactory.createEnum compatibility', () => {
    it('should be alias for EnumNode.create', () => {
      const viaNodeFactory = NodeFactory.createEnum(
        'Status',
        '/file.ts',
        10,
        0,
        {
          isConst: true,
          members: [{ name: 'Active', value: 0 }]
        }
      );

      const viaEnumNode = EnumNode.create(
        'Status',
        '/file.ts',
        10,
        0,
        {
          isConst: true,
          members: [{ name: 'Active', value: 0 }]
        }
      );

      assert.deepStrictEqual(viaNodeFactory, viaEnumNode,
        'NodeFactory.createEnum should produce same result as EnumNode.create');
    });

    it('should pass validation for created enums', () => {
      const node = NodeFactory.createEnum(
        'Priority',
        '/project/enums.ts',
        15,
        0,
        {
          isConst: false,
          members: [
            { name: 'Low', value: 0 },
            { name: 'High', value: 1 }
          ]
        }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });
  });
});
