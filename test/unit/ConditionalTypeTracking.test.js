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

    it('should create TYPE node with conditionalType=true for conditional types', async () => {
      await setupTest(backend, {
        'index.ts': `
export type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
        `
      });

      const allNodes = await backend.getAllNodes();
      const unwrap = allNodes.find(n => n.name === 'UnwrapPromise' && n.type === 'TYPE');

      assert.ok(unwrap, 'UnwrapPromise TYPE node should exist');
      assert.strictEqual(unwrap.conditionalType, true);
      assert.strictEqual(unwrap.checkType, 'T');
      assert.strictEqual(unwrap.extendsType, 'Promise<infer U>');
      assert.strictEqual(unwrap.trueType, 'U');
      assert.strictEqual(unwrap.falseType, 'T');
    });

    it('should produce correct aliasOf string for conditional types', async () => {
      await setupTest(backend, {
        'index.ts': `
export type IsString<T> = T extends string ? 'yes' : 'no';
        `
      });

      const allNodes = await backend.getAllNodes();
      const isStr = allNodes.find(n => n.name === 'IsString' && n.type === 'TYPE');

      assert.ok(isStr, 'IsString TYPE node should exist');
      assert.strictEqual(isStr.conditionalType, true);
      assert.strictEqual(isStr.checkType, 'T');
      assert.strictEqual(isStr.extendsType, 'string');
      // aliasOf should be the full string representation
      assert.ok(isStr.aliasOf.includes('extends'), `aliasOf should contain conditional: ${isStr.aliasOf}`);
    });

    it('should NOT set conditionalType for simple alias', async () => {
      await setupTest(backend, {
        'index.ts': `
export type UserId = string;
export type Result = string | number;
        `
      });

      const allNodes = await backend.getAllNodes();
      const userId = allNodes.find(n => n.name === 'UserId' && n.type === 'TYPE');
      const result = allNodes.find(n => n.name === 'Result' && n.type === 'TYPE');

      assert.ok(userId, 'UserId TYPE node should exist');
      assert.strictEqual(userId.conditionalType, undefined);
      assert.strictEqual(userId.checkType, undefined);

      assert.ok(result, 'Result TYPE node should exist');
      assert.strictEqual(result.conditionalType, undefined);
    });

    it('should handle nested conditional types', async () => {
      await setupTest(backend, {
        'index.ts': `
export type Nested<T> = T extends Array<infer U> ? U extends Promise<infer V> ? V : U : T;
        `
      });

      const allNodes = await backend.getAllNodes();
      const nested = allNodes.find(n => n.name === 'Nested' && n.type === 'TYPE');

      assert.ok(nested, 'Nested TYPE node should exist');
      assert.strictEqual(nested.conditionalType, true);
      assert.strictEqual(nested.checkType, 'T');
      assert.strictEqual(nested.extendsType, 'Array<infer U>');
      // trueType contains the nested conditional as a string
      assert.ok(nested.trueType.includes('extends'), `trueType should contain nested conditional: ${nested.trueType}`);
      assert.strictEqual(nested.falseType, 'T');
    });

    it('should handle infer keyword in extendsType string', async () => {
      await setupTest(backend, {
        'index.ts': `
export type ReturnType<T> = T extends (...args: unknown[]) => infer R ? R : never;
        `
      });

      const allNodes = await backend.getAllNodes();
      const retType = allNodes.find(n => n.name === 'ReturnType' && n.type === 'TYPE');

      assert.ok(retType, 'ReturnType TYPE node should exist');
      assert.strictEqual(retType.conditionalType, true);
      assert.strictEqual(retType.trueType, 'R');
      assert.strictEqual(retType.falseType, 'never');
    });
  });
});
