/**
 * Conditional Type Tracking Tests (REG-304)
 *
 * Verifies:
 * 1. TypeNode.create() stores conditional type metadata
 * 2. NodeFactory.createType() passes through conditional fields
 * 3. Integration: .ts file with conditional type → TYPE node with metadata
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { TypeNode, NodeFactory } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-conditional-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-conditional-${testCounter}`,
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
// 1. TypeNode.create() with conditional metadata (Unit)
// ============================================================================

describe('Conditional Type Tracking (REG-304)', () => {
  describe('TypeNode.create() with conditional metadata', () => {
    it('should store all conditional fields', () => {
      const node = TypeNode.create(
        'UnwrapPromise',
        '/src/types.ts',
        5,
        0,
        {
          aliasOf: 'T extends Promise<infer U> ? U : T',
          conditionalType: true,
          checkType: 'T',
          extendsType: 'Promise',
          trueType: 'U',
          falseType: 'T',
        }
      );

      assert.strictEqual(node.conditionalType, true);
      assert.strictEqual(node.checkType, 'T');
      assert.strictEqual(node.extendsType, 'Promise');
      assert.strictEqual(node.trueType, 'U');
      assert.strictEqual(node.falseType, 'T');
    });

    it('should leave conditional fields undefined for non-conditional types', () => {
      const node = TypeNode.create('UserId', '/src/types.ts', 10, 0, { aliasOf: 'string' });

      assert.strictEqual(node.conditionalType, undefined);
      assert.strictEqual(node.checkType, undefined);
    });

    it('should pass validation with conditional fields', () => {
      const node = TypeNode.create(
        'UnwrapPromise', '/src/types.ts', 5, 0,
        { conditionalType: true, checkType: 'T', extendsType: 'Promise', trueType: 'U', falseType: 'T' }
      );

      const errors = TypeNode.validate(node);
      assert.strictEqual(errors.length, 0, `Validation errors: ${errors.join(', ')}`);
    });

    it('should include conditional fields in OPTIONAL array', () => {
      assert.ok(TypeNode.OPTIONAL.includes('conditionalType'));
      assert.ok(TypeNode.OPTIONAL.includes('checkType'));
      assert.ok(TypeNode.OPTIONAL.includes('extendsType'));
      assert.ok(TypeNode.OPTIONAL.includes('trueType'));
      assert.ok(TypeNode.OPTIONAL.includes('falseType'));
    });
  });

  // ============================================================================
  // 2. NodeFactory.createType() with conditional metadata
  // ============================================================================

  describe('NodeFactory.createType() with conditional metadata', () => {
    it('should pass conditional fields through', () => {
      const node = NodeFactory.createType(
        'IsString', '/src/utils.ts', 15, 0,
        {
          aliasOf: 'T extends string ? true : false',
          conditionalType: true,
          checkType: 'T',
          extendsType: 'string',
          trueType: 'true',
          falseType: 'false',
        }
      );

      assert.strictEqual(node.conditionalType, true);
      assert.strictEqual(node.checkType, 'T');
      assert.strictEqual(node.extendsType, 'string');
      assert.strictEqual(node.trueType, 'true');
      assert.strictEqual(node.falseType, 'false');
    });
  });

  // ============================================================================
  // 3. Integration: analyze conditional types
  // ============================================================================

  describe('Integration: analyze conditional types', () => {
    let db;
    let backend;

    beforeEach(async () => {
      if (db) await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;
    });

    after(async () => {
      if (db) await db.cleanup();
      await cleanupAllTestDatabases();
    });

    it('should create TYPE_ALIAS node with linked CONDITIONAL_TYPE for conditional types', async () => {
      await setupTest(backend, {
        'index.ts': `
export type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: TYPE -> TYPE_ALIAS
      const unwrap = allNodes.find(n => n.name === 'UnwrapPromise' && n.type === 'TYPE_ALIAS');
      assert.ok(unwrap, 'UnwrapPromise TYPE_ALIAS node should exist');

      // V2: Conditional info is in a separate CONDITIONAL_TYPE node
      // linked via ASSIGNED_FROM from TYPE_ALIAS
      const assignedFromEdges = allEdges.filter(e => e.src === unwrap.id && e.type === 'ASSIGNED_FROM');
      const conditionalNode = assignedFromEdges.length > 0
        ? allNodes.find(n => n.id === assignedFromEdges[0].dst && n.type === 'CONDITIONAL_TYPE')
        : null;

      assert.ok(conditionalNode, 'Should have CONDITIONAL_TYPE node linked via ASSIGNED_FROM');

      // V2: The conditional structure is expressed via edges:
      // CONDITIONAL_TYPE -> HAS_CONDITION -> TYPE_REFERENCE(T)  [checkType]
      // CONDITIONAL_TYPE -> EXTENDS -> TYPE_REFERENCE(Promise)  [extendsType]
      // CONDITIONAL_TYPE -> INFERS -> INFER_TYPE(U)
      // CONDITIONAL_TYPE -> RETURNS -> TYPE_REFERENCE(U, T)  [trueType, falseType]
      const condEdges = allEdges.filter(e => e.src === conditionalNode.id);
      const hasCondition = condEdges.find(e => e.type === 'HAS_CONDITION');
      const extendsEdge = condEdges.find(e => e.type === 'EXTENDS');

      assert.ok(hasCondition, 'CONDITIONAL_TYPE should have HAS_CONDITION edge');
      assert.ok(extendsEdge, 'CONDITIONAL_TYPE should have EXTENDS edge');

      // Check checkType
      const checkNode = allNodes.find(n => n.id === hasCondition.dst);
      assert.ok(checkNode, 'Check type node should exist');
      assert.strictEqual(checkNode.name, 'T', 'Check type should be T');

      // Check extendsType
      const extendsNode = allNodes.find(n => n.id === extendsEdge.dst);
      assert.ok(extendsNode, 'Extends type node should exist');
      assert.strictEqual(extendsNode.name, 'Promise', 'Extends type should be Promise');
    });

    it('should produce TYPE_ALIAS with CONDITIONAL_TYPE for IsString', async () => {
      await setupTest(backend, {
        'index.ts': `
export type IsString<T> = T extends string ? 'yes' : 'no';
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: TYPE -> TYPE_ALIAS
      const isStr = allNodes.find(n => n.name === 'IsString' && n.type === 'TYPE_ALIAS');
      assert.ok(isStr, 'IsString TYPE_ALIAS node should exist');

      // V2: Should have CONDITIONAL_TYPE linked via ASSIGNED_FROM
      const assignedFromEdges = allEdges.filter(e => e.src === isStr.id && e.type === 'ASSIGNED_FROM');
      const conditionalNode = assignedFromEdges.length > 0
        ? allNodes.find(n => n.id === assignedFromEdges[0].dst && n.type === 'CONDITIONAL_TYPE')
        : null;

      assert.ok(conditionalNode, 'Should have CONDITIONAL_TYPE for IsString');

      // Check extends edge points to string
      const condEdges = allEdges.filter(e => e.src === conditionalNode.id);
      const extendsEdge = condEdges.find(e => e.type === 'EXTENDS');
      assert.ok(extendsEdge, 'CONDITIONAL_TYPE should have EXTENDS edge');
      const extendsNode = allNodes.find(n => n.id === extendsEdge.dst);
      assert.strictEqual(extendsNode.name, 'string', 'Extends type should be string');
    });

    it('should NOT have CONDITIONAL_TYPE for simple alias', async () => {
      await setupTest(backend, {
        'index.ts': `
export type UserId = string;
export type Result = string | number;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: TYPE -> TYPE_ALIAS
      const userId = allNodes.find(n => n.name === 'UserId' && n.type === 'TYPE_ALIAS');
      const result = allNodes.find(n => n.name === 'Result' && n.type === 'TYPE_ALIAS');

      assert.ok(userId, 'UserId TYPE_ALIAS node should exist');
      assert.ok(result, 'Result TYPE_ALIAS node should exist');

      // V2: Simple aliases should NOT link to CONDITIONAL_TYPE
      const userIdAssigned = allEdges.filter(e => e.src === userId.id && e.type === 'ASSIGNED_FROM');
      const conditionalForUserId = userIdAssigned
        .map(e => allNodes.find(n => n.id === e.dst))
        .filter(n => n && n.type === 'CONDITIONAL_TYPE');
      assert.strictEqual(conditionalForUserId.length, 0,
        'UserId should not have CONDITIONAL_TYPE');

      const resultAssigned = allEdges.filter(e => e.src === result.id && e.type === 'ASSIGNED_FROM');
      const conditionalForResult = resultAssigned
        .map(e => allNodes.find(n => n.id === e.dst))
        .filter(n => n && n.type === 'CONDITIONAL_TYPE');
      assert.strictEqual(conditionalForResult.length, 0,
        'Result should not have CONDITIONAL_TYPE');
    });

    it('should handle nested conditional types', async () => {
      await setupTest(backend, {
        'index.ts': `
export type Nested<T> = T extends Array<infer U> ? U extends Promise<infer V> ? V : U : T;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: TYPE -> TYPE_ALIAS
      const nested = allNodes.find(n => n.name === 'Nested' && n.type === 'TYPE_ALIAS');
      assert.ok(nested, 'Nested TYPE_ALIAS node should exist');

      // V2: Should link to CONDITIONAL_TYPE
      const assignedFromEdges = allEdges.filter(e => e.src === nested.id && e.type === 'ASSIGNED_FROM');
      const conditionalNode = assignedFromEdges.length > 0
        ? allNodes.find(n => n.id === assignedFromEdges[0].dst && n.type === 'CONDITIONAL_TYPE')
        : null;

      assert.ok(conditionalNode, 'Should have CONDITIONAL_TYPE for Nested');

      // Verify EXTENDS edge exists (extends Array)
      const condEdges = allEdges.filter(e => e.src === conditionalNode.id);
      const extendsEdge = condEdges.find(e => e.type === 'EXTENDS');
      assert.ok(extendsEdge, 'Nested conditional should have EXTENDS edge');

      // V2: There should be at least 1 CONDITIONAL_TYPE node
      // (V2 may flatten nested conditionals into a single node)
      const allConditionals = allNodes.filter(n => n.type === 'CONDITIONAL_TYPE');
      assert.ok(allConditionals.length >= 1,
        `Should have at least 1 CONDITIONAL_TYPE node for nested conditional, got ${allConditionals.length}`);
    });

    it('should handle infer keyword with CONDITIONAL_TYPE', async () => {
      await setupTest(backend, {
        'index.ts': `
export type ReturnType<T> = T extends (...args: unknown[]) => infer R ? R : never;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: TYPE -> TYPE_ALIAS
      const retType = allNodes.find(n => n.name === 'ReturnType' && n.type === 'TYPE_ALIAS');
      assert.ok(retType, 'ReturnType TYPE_ALIAS node should exist');

      // V2: Should link to CONDITIONAL_TYPE
      const assignedFromEdges = allEdges.filter(e => e.src === retType.id && e.type === 'ASSIGNED_FROM');
      const conditionalNode = assignedFromEdges.length > 0
        ? allNodes.find(n => n.id === assignedFromEdges[0].dst && n.type === 'CONDITIONAL_TYPE')
        : null;

      assert.ok(conditionalNode, 'Should have CONDITIONAL_TYPE for ReturnType');

      // V2: Should have INFERS edge for the infer keyword
      const condEdges = allEdges.filter(e => e.src === conditionalNode.id);
      const infersEdge = condEdges.find(e => e.type === 'INFERS');
      assert.ok(infersEdge, 'CONDITIONAL_TYPE should have INFERS edge');

      // V2: Should have RETURNS edges for trueType and falseType
      const returnsEdges = condEdges.filter(e => e.type === 'RETURNS');
      assert.ok(returnsEdges.length >= 2,
        `CONDITIONAL_TYPE should have at least 2 RETURNS edges, got ${returnsEdges.length}`);
    });
  });
});
