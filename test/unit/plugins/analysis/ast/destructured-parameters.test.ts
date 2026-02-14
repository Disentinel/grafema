/**
 * Destructured Parameters Tests (REG-399)
 *
 * Tests for PARAMETER nodes created from destructured function parameters.
 * These tests verify that destructuring patterns in function signatures are
 * properly analyzed and converted into PARAMETER nodes with appropriate metadata.
 *
 * What will be created:
 * - PARAMETER nodes for each destructured binding
 * - propertyPath metadata for object destructuring
 * - arrayIndex metadata for array destructuring
 * - isRest flag for rest elements in destructuring
 * - hasDefault flag for defaults at any level
 *
 * Test cases verify the acceptance criteria from REG-399:
 * - Object destructuring: function foo({ maxBodyLength }) {}
 * - Nested destructuring: function foo({ data: { user } }) {}
 * - Renaming: function foo({ old: newName }) {}
 * - Array destructuring: function foo([first, second]) {}
 * - Rest in destructuring: function foo({ a, ...rest }) {}
 * - Default values: function foo({ x = 42 }) {}
 * - Arrow functions: ({ x }) => x
 * - Mixed simple + destructured params
 * - Pattern-level defaults: function foo({ x } = {}) {}
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../../helpers/createTestOrchestrator.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-destructured-params-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to the first file
  const mainFile = Object.keys(files)[0] || 'index.js';
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-destructured-params-${testCounter}`,
      type: 'module',
      main: mainFile
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

/**
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Get edges by type from backend
 */
async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];

  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

// =============================================================================
// TESTS: Destructured Parameter Nodes
// =============================================================================

describe('Destructured Parameters Analysis (REG-399)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // GROUP 1: Object Destructuring - Basic
  // ===========================================================================

  describe('Object destructuring - basic cases', () => {
    it('should create PARAMETER node for simple object destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ maxBodyLength }) {
  return maxBodyLength;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const maxBodyLengthParam = paramNodes.find((p: NodeRecord) => p.name === 'maxBodyLength');

      assert.ok(maxBodyLengthParam, 'Should have PARAMETER node for maxBodyLength');
      assert.strictEqual(maxBodyLengthParam.type, 'PARAMETER', 'Node type should be PARAMETER');
      assert.strictEqual(maxBodyLengthParam.name, 'maxBodyLength', 'Parameter name should be maxBodyLength');
      assert.strictEqual(maxBodyLengthParam.index, 0, 'Parameter should be at index 0');
    });

    it('should include propertyPath metadata for object destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ maxBodyLength }) {
  return maxBodyLength;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const maxBodyLengthParam = paramNodes.find((p: NodeRecord) => p.name === 'maxBodyLength');

      assert.ok(maxBodyLengthParam, 'Should have PARAMETER node');
      const propertyPath = (maxBodyLengthParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.ok(propertyPath, 'Should have propertyPath metadata');
      assert.deepStrictEqual(propertyPath, ['maxBodyLength'], 'propertyPath should be ["maxBodyLength"]');
    });

    it('should create multiple PARAMETER nodes for multiple properties', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ a, b, c }) {
  return a + b + c;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const bParam = paramNodes.find((p: NodeRecord) => p.name === 'b');
      const cParam = paramNodes.find((p: NodeRecord) => p.name === 'c');

      assert.ok(aParam, 'Should have PARAMETER for a');
      assert.ok(bParam, 'Should have PARAMETER for b');
      assert.ok(cParam, 'Should have PARAMETER for c');

      // All should be at index 0 (same parameter position)
      assert.strictEqual(aParam.index, 0, 'a should be at index 0');
      assert.strictEqual(bParam.index, 0, 'b should be at index 0');
      assert.strictEqual(cParam.index, 0, 'c should be at index 0');
    });
  });

  // ===========================================================================
  // GROUP 2: Object Destructuring - Nested
  // ===========================================================================

  describe('Object destructuring - nested patterns', () => {
    it('should create PARAMETER node for nested destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ data: { user } }) {
  return user;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const userParam = paramNodes.find((p: NodeRecord) => p.name === 'user');

      assert.ok(userParam, 'Should have PARAMETER node for user');
      assert.strictEqual(userParam.name, 'user', 'Parameter name should be user');
    });

    it('should include full propertyPath for nested destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ data: { user } }) {
  return user;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const userParam = paramNodes.find((p: NodeRecord) => p.name === 'user');

      assert.ok(userParam, 'Should have PARAMETER node');
      const propertyPath = (userParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.ok(propertyPath, 'Should have propertyPath metadata');
      assert.deepStrictEqual(propertyPath, ['data', 'user'], 'propertyPath should be ["data", "user"]');
    });

    it('should handle deeply nested destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ config: { api: { endpoint } } }) {
  return endpoint;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const endpointParam = paramNodes.find((p: NodeRecord) => p.name === 'endpoint');

      assert.ok(endpointParam, 'Should have PARAMETER node for endpoint');
      const propertyPath = (endpointParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.deepStrictEqual(
        propertyPath,
        ['config', 'api', 'endpoint'],
        'propertyPath should track full nesting'
      );
    });
  });

  // ===========================================================================
  // GROUP 3: Object Destructuring - Renaming
  // ===========================================================================

  describe('Object destructuring - property renaming', () => {
    it('should create PARAMETER with new name when renaming', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ old: newName }) {
  return newName;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const newNameParam = paramNodes.find((p: NodeRecord) => p.name === 'newName');
      const oldParam = paramNodes.find((p: NodeRecord) => p.name === 'old');

      assert.ok(newNameParam, 'Should have PARAMETER named newName');
      assert.ok(!oldParam, 'Should NOT have PARAMETER named old');
    });

    it('should include original property name in propertyPath when renaming', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ old: newName }) {
  return newName;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const newNameParam = paramNodes.find((p: NodeRecord) => p.name === 'newName');

      assert.ok(newNameParam, 'Should have PARAMETER node');
      const propertyPath = (newNameParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.deepStrictEqual(propertyPath, ['old'], 'propertyPath should contain original property name');
    });

    it('should handle renaming in nested destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ response: { data: result } }) {
  return result;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const resultParam = paramNodes.find((p: NodeRecord) => p.name === 'result');

      assert.ok(resultParam, 'Should have PARAMETER named result');
      const propertyPath = (resultParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.deepStrictEqual(
        propertyPath,
        ['response', 'data'],
        'propertyPath should track original property names'
      );
    });
  });

  // ===========================================================================
  // GROUP 4: Array Destructuring
  // ===========================================================================

  describe('Array destructuring', () => {
    it('should create PARAMETER nodes for array destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo([first, second]) {
  return first + second;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const firstParam = paramNodes.find((p: NodeRecord) => p.name === 'first');
      const secondParam = paramNodes.find((p: NodeRecord) => p.name === 'second');

      assert.ok(firstParam, 'Should have PARAMETER for first');
      assert.ok(secondParam, 'Should have PARAMETER for second');
    });

    it('should include arrayIndex metadata for array elements', async () => {
      await setupTest(backend, {
        'index.js': `
function foo([first, second]) {
  return first + second;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const firstParam = paramNodes.find((p: NodeRecord) => p.name === 'first');
      const secondParam = paramNodes.find((p: NodeRecord) => p.name === 'second');

      assert.ok(firstParam, 'Should have first param');
      assert.ok(secondParam, 'Should have second param');

      assert.strictEqual(
        (firstParam as Record<string, unknown>).arrayIndex,
        0,
        'first should have arrayIndex=0'
      );
      assert.strictEqual(
        (secondParam as Record<string, unknown>).arrayIndex,
        1,
        'second should have arrayIndex=1'
      );
    });

    it('should handle sparse array destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo([, , third]) {
  return third;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const thirdParam = paramNodes.find((p: NodeRecord) => p.name === 'third');

      assert.ok(thirdParam, 'Should have PARAMETER for third');
      assert.strictEqual(
        (thirdParam as Record<string, unknown>).arrayIndex,
        2,
        'third should have arrayIndex=2'
      );
    });

    it('should have same index for all elements from same array parameter', async () => {
      await setupTest(backend, {
        'index.js': `
function foo([a, b, c]) {
  return a + b + c;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const bParam = paramNodes.find((p: NodeRecord) => p.name === 'b');
      const cParam = paramNodes.find((p: NodeRecord) => p.name === 'c');

      // All should be from parameter position 0
      assert.strictEqual(aParam?.index, 0, 'a should be at index 0');
      assert.strictEqual(bParam?.index, 0, 'b should be at index 0');
      assert.strictEqual(cParam?.index, 0, 'c should be at index 0');
    });
  });

  // ===========================================================================
  // GROUP 5: Rest Parameters in Destructuring
  // ===========================================================================

  describe('Rest parameters in destructuring', () => {
    it('should create PARAMETER with isRest for object rest', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ a, ...rest }) {
  return rest;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const restParam = paramNodes.find((p: NodeRecord) => p.name === 'rest');

      assert.ok(aParam, 'Should have PARAMETER for a');
      assert.ok(restParam, 'Should have PARAMETER for rest');

      assert.strictEqual(
        (aParam as Record<string, unknown>).isRest,
        undefined,
        'a should not be rest parameter'
      );
      assert.strictEqual(
        (restParam as Record<string, unknown>).isRest,
        true,
        'rest should have isRest=true'
      );
    });

    it('should create PARAMETER with isRest for array rest', async () => {
      await setupTest(backend, {
        'index.js': `
function foo([first, ...rest]) {
  return rest;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const firstParam = paramNodes.find((p: NodeRecord) => p.name === 'first');
      const restParam = paramNodes.find((p: NodeRecord) => p.name === 'rest');

      assert.ok(firstParam, 'Should have PARAMETER for first');
      assert.ok(restParam, 'Should have PARAMETER for rest');

      assert.strictEqual(
        (firstParam as Record<string, unknown>).isRest,
        undefined,
        'first should not be rest parameter'
      );
      assert.strictEqual(
        (restParam as Record<string, unknown>).isRest,
        true,
        'rest should have isRest=true'
      );
      assert.strictEqual(
        (restParam as Record<string, unknown>).arrayIndex,
        1,
        'rest should have arrayIndex for position in array'
      );
    });
  });

  // ===========================================================================
  // GROUP 6: Default Values
  // ===========================================================================

  describe('Default values in destructuring', () => {
    it('should mark PARAMETER with hasDefault for property-level defaults', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ x = 42 }) {
  return x;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');

      assert.ok(xParam, 'Should have PARAMETER for x');
      assert.strictEqual(
        (xParam as Record<string, unknown>).hasDefault,
        true,
        'x should have hasDefault=true'
      );
    });

    it('should mark PARAMETER with hasDefault for pattern-level defaults', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ x, y } = {}) {
  return x + y;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');
      const yParam = paramNodes.find((p: NodeRecord) => p.name === 'y');

      assert.ok(xParam, 'Should have PARAMETER for x');
      assert.ok(yParam, 'Should have PARAMETER for y');

      assert.strictEqual(
        (xParam as Record<string, unknown>).hasDefault,
        true,
        'x should have hasDefault=true from pattern-level default'
      );
      assert.strictEqual(
        (yParam as Record<string, unknown>).hasDefault,
        true,
        'y should have hasDefault=true from pattern-level default'
      );
    });

    it('should handle defaults at multiple levels', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ x = 1, y: { z = 2 } = {} }) {
  return x + z;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');
      const zParam = paramNodes.find((p: NodeRecord) => p.name === 'z');

      assert.ok(xParam, 'Should have PARAMETER for x');
      assert.ok(zParam, 'Should have PARAMETER for z');

      assert.strictEqual(
        (xParam as Record<string, unknown>).hasDefault,
        true,
        'x should have hasDefault=true'
      );
      assert.strictEqual(
        (zParam as Record<string, unknown>).hasDefault,
        true,
        'z should have hasDefault=true'
      );
    });

    it('should handle array destructuring with defaults', async () => {
      await setupTest(backend, {
        'index.js': `
function foo([x = 10, y = 20] = []) {
  return x + y;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');
      const yParam = paramNodes.find((p: NodeRecord) => p.name === 'y');

      assert.ok(xParam, 'Should have PARAMETER for x');
      assert.ok(yParam, 'Should have PARAMETER for y');

      assert.strictEqual(
        (xParam as Record<string, unknown>).hasDefault,
        true,
        'x should have hasDefault=true'
      );
      assert.strictEqual(
        (yParam as Record<string, unknown>).hasDefault,
        true,
        'y should have hasDefault=true'
      );
    });
  });

  // ===========================================================================
  // GROUP 7: Arrow Functions
  // ===========================================================================

  describe('Arrow functions with destructuring', () => {
    it('should create PARAMETER nodes for arrow function with object destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
const foo = ({ x }) => x;
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');

      assert.ok(xParam, 'Should have PARAMETER for x in arrow function');
      assert.strictEqual(xParam.type, 'PARAMETER', 'Should be PARAMETER node');
      const propertyPath = (xParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.deepStrictEqual(propertyPath, ['x'], 'Should have propertyPath');
    });

    it('should create PARAMETER nodes for arrow function with array destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
const foo = ([a, b]) => a + b;
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const bParam = paramNodes.find((p: NodeRecord) => p.name === 'b');

      assert.ok(aParam, 'Should have PARAMETER for a');
      assert.ok(bParam, 'Should have PARAMETER for b');

      assert.strictEqual(
        (aParam as Record<string, unknown>).arrayIndex,
        0,
        'a should have arrayIndex=0'
      );
      assert.strictEqual(
        (bParam as Record<string, unknown>).arrayIndex,
        1,
        'b should have arrayIndex=1'
      );
    });
  });

  // ===========================================================================
  // GROUP 8: Mixed Simple and Destructured Parameters
  // ===========================================================================

  describe('Mixed simple and destructured parameters', () => {
    it('should create PARAMETER nodes for both simple and destructured params', async () => {
      await setupTest(backend, {
        'index.js': `
function foo(a, { b, c }, d) {
  return a + b + c + d;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const bParam = paramNodes.find((p: NodeRecord) => p.name === 'b');
      const cParam = paramNodes.find((p: NodeRecord) => p.name === 'c');
      const dParam = paramNodes.find((p: NodeRecord) => p.name === 'd');

      assert.ok(aParam, 'Should have PARAMETER for a');
      assert.ok(bParam, 'Should have PARAMETER for b');
      assert.ok(cParam, 'Should have PARAMETER for c');
      assert.ok(dParam, 'Should have PARAMETER for d');

      // Check indices
      assert.strictEqual(aParam.index, 0, 'a should be at index 0');
      assert.strictEqual(bParam.index, 1, 'b should be at index 1');
      assert.strictEqual(cParam.index, 1, 'c should be at index 1');
      assert.strictEqual(dParam.index, 2, 'd should be at index 2');

      // Check propertyPath only on destructured params
      const aPropertyPath = (aParam as Record<string, unknown>).propertyPath;
      const bPropertyPath = (bParam as Record<string, unknown>).propertyPath;
      const dPropertyPath = (dParam as Record<string, unknown>).propertyPath;

      assert.strictEqual(aPropertyPath, undefined, 'a should not have propertyPath (simple param)');
      assert.ok(bPropertyPath, 'b should have propertyPath (destructured)');
      assert.strictEqual(dPropertyPath, undefined, 'd should not have propertyPath (simple param)');
    });

    it('should handle complex mixed parameter patterns', async () => {
      await setupTest(backend, {
        'index.js': `
function foo(name, { config: { port } }, [x, y], ...rest) {
  return { name, port, x, y, rest };
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const nameParam = paramNodes.find((p: NodeRecord) => p.name === 'name');
      const portParam = paramNodes.find((p: NodeRecord) => p.name === 'port');
      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');
      const yParam = paramNodes.find((p: NodeRecord) => p.name === 'y');
      const restParam = paramNodes.find((p: NodeRecord) => p.name === 'rest');

      assert.ok(nameParam, 'Should have PARAMETER for name');
      assert.ok(portParam, 'Should have PARAMETER for port');
      assert.ok(xParam, 'Should have PARAMETER for x');
      assert.ok(yParam, 'Should have PARAMETER for y');
      assert.ok(restParam, 'Should have PARAMETER for rest');

      assert.strictEqual(nameParam.index, 0, 'name at index 0');
      assert.strictEqual(portParam.index, 1, 'port at index 1');
      assert.strictEqual(xParam.index, 2, 'x at index 2');
      assert.strictEqual(yParam.index, 2, 'y at index 2');
      assert.strictEqual(restParam.index, 3, 'rest at index 3');

      assert.strictEqual(
        (restParam as Record<string, unknown>).isRest,
        true,
        'rest should have isRest=true'
      );
    });
  });

  // ===========================================================================
  // GROUP 9: Semantic ID Uniqueness
  // ===========================================================================

  describe('Semantic ID uniqueness', () => {
    it('should generate unique IDs for multiple destructured params at same index', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ a, b }) {
  return a + b;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const bParam = paramNodes.find((p: NodeRecord) => p.name === 'b');

      assert.ok(aParam, 'Should have PARAMETER for a');
      assert.ok(bParam, 'Should have PARAMETER for b');

      // IDs must be unique
      assert.notStrictEqual(aParam.id, bParam.id, 'a and b should have different IDs');
    });

    it('should generate unique IDs for params with same name in different destructuring patterns', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ x }, { x: y }) {
  return x + y;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');
      const yParam = paramNodes.find((p: NodeRecord) => p.name === 'y');

      assert.ok(xParam, 'Should have PARAMETER for x');
      assert.ok(yParam, 'Should have PARAMETER for y');

      // Both come from property 'x' but should have unique IDs
      assert.notStrictEqual(xParam.id, yParam.id, 'x and y should have different IDs');

      // Check indices
      assert.strictEqual(xParam.index, 0, 'x from first param at index 0');
      assert.strictEqual(yParam.index, 1, 'y from second param at index 1');
    });

    it('should generate unique IDs for all params across multiple destructured positions', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ a, b }, { c, d }) {
  return a + b + c + d;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const bParam = paramNodes.find((p: NodeRecord) => p.name === 'b');
      const cParam = paramNodes.find((p: NodeRecord) => p.name === 'c');
      const dParam = paramNodes.find((p: NodeRecord) => p.name === 'd');

      assert.ok(aParam && bParam && cParam && dParam, 'Should have all params');

      const ids = [aParam.id, bParam.id, cParam.id, dParam.id];
      const uniqueIds = new Set(ids);

      assert.strictEqual(uniqueIds.size, 4, 'All parameter IDs should be unique');
    });
  });

  // ===========================================================================
  // GROUP 10: HAS_PARAMETER Edge Connectivity
  // ===========================================================================

  describe('HAS_PARAMETER edge connectivity', () => {
    it('should create HAS_PARAMETER edges from FUNCTION to destructured PARAMETER nodes', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ x, y }) {
  return x + y;
}
        `
      });

      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const hasParamEdges = await getEdgesByType(backend, 'HAS_PARAMETER');

      const fooFunc = functionNodes.find((f: NodeRecord) => f.name === 'foo');
      assert.ok(fooFunc, 'Should have FUNCTION node for foo');

      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');
      const yParam = paramNodes.find((p: NodeRecord) => p.name === 'y');

      assert.ok(xParam, 'Should have PARAMETER for x');
      assert.ok(yParam, 'Should have PARAMETER for y');

      // Verify edges exist from function to parameters
      const edgeToX = hasParamEdges.find(
        (e: EdgeRecord) => e.src === fooFunc.id && e.dst === xParam.id
      );
      const edgeToY = hasParamEdges.find(
        (e: EdgeRecord) => e.src === fooFunc.id && e.dst === yParam.id
      );

      assert.ok(edgeToX, 'Should have HAS_PARAMETER edge from foo to x');
      assert.ok(edgeToY, 'Should have HAS_PARAMETER edge from foo to y');
    });

    it('should create edges for all params including simple and destructured', async () => {
      await setupTest(backend, {
        'index.js': `
function foo(a, { b, c }, d) {
  return a + b + c + d;
}
        `
      });

      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      const hasParamEdges = await getEdgesByType(backend, 'HAS_PARAMETER');

      const fooFunc = functionNodes.find((f: NodeRecord) => f.name === 'foo');
      assert.ok(fooFunc, 'Should have FUNCTION node');

      const edgesFromFoo = hasParamEdges.filter((e: EdgeRecord) => e.src === fooFunc.id);

      // Should have 4 HAS_PARAMETER edges (one for each parameter: a, b, c, d)
      assert.ok(
        edgesFromFoo.length >= 4,
        `Should have at least 4 HAS_PARAMETER edges, got ${edgesFromFoo.length}`
      );
    });
  });

  // ===========================================================================
  // GROUP 11: Edge Cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle empty object destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({}) {
  return 'empty';
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const fooParams = paramNodes.filter((p: NodeRecord) => {
        // Filter to params belonging to foo function by checking if they're in same file
        return p.file && p.file.includes('index.js');
      });

      // Empty destructuring should create no PARAMETER nodes
      assert.strictEqual(
        fooParams.length,
        0,
        'Empty object destructuring should create no parameters'
      );
    });

    it('should handle empty array destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo([]) {
  return 'empty';
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const fooParams = paramNodes.filter((p: NodeRecord) => p.file && p.file.includes('index.js'));

      assert.strictEqual(
        fooParams.length,
        0,
        'Empty array destructuring should create no parameters'
      );
    });

    it('should handle mixed object and array destructuring', async () => {
      await setupTest(backend, {
        'index.js': `
function foo({ items: [first, second] }) {
  return first + second;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const firstParam = paramNodes.find((p: NodeRecord) => p.name === 'first');
      const secondParam = paramNodes.find((p: NodeRecord) => p.name === 'second');

      assert.ok(firstParam, 'Should have PARAMETER for first');
      assert.ok(secondParam, 'Should have PARAMETER for second');

      // Should have both propertyPath (for 'items') and arrayIndex
      const firstPropertyPath = (firstParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.ok(firstPropertyPath, 'first should have propertyPath');
      assert.ok(
        firstPropertyPath.includes('items'),
        'propertyPath should include items property'
      );
    });

    it('should handle destructuring with complex patterns', async () => {
      // Tests that complex but valid JS destructuring works
      await setupTest(backend, {
        'index.js': `
function foo({ x, y: { z } }) {
  return x + z;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const xParam = paramNodes.find((p: NodeRecord) => p.name === 'x');
      const zParam = paramNodes.find((p: NodeRecord) => p.name === 'z');

      assert.ok(xParam, 'Should have PARAMETER for x');
      assert.ok(zParam, 'Should have PARAMETER for z');
      const zPropertyPath = (zParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.deepStrictEqual(zPropertyPath, ['y', 'z'], 'z should have propertyPath ["y", "z"]');
    });

    it('should handle destructuring in method parameters', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {
  process({ data }) {
    return data;
  }
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const dataParam = paramNodes.find((p: NodeRecord) => p.name === 'data');

      assert.ok(dataParam, 'Should have PARAMETER for data in method');
      const propertyPath = (dataParam as Record<string, unknown>).propertyPath as string[] | undefined;
      assert.deepStrictEqual(propertyPath, ['data'], 'Method param should have propertyPath');
    });
  });

  // ===========================================================================
  // GROUP 12: Backward Compatibility
  // ===========================================================================

  describe('Backward compatibility', () => {
    it('should not break existing simple parameter handling', async () => {
      await setupTest(backend, {
        'index.js': `
function foo(a, b, c) {
  return a + b + c;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const bParam = paramNodes.find((p: NodeRecord) => p.name === 'b');
      const cParam = paramNodes.find((p: NodeRecord) => p.name === 'c');

      assert.ok(aParam, 'Should still create PARAMETER for simple params');
      assert.ok(bParam, 'Should still create PARAMETER for simple params');
      assert.ok(cParam, 'Should still create PARAMETER for simple params');

      // Simple params should NOT have propertyPath or arrayIndex
      assert.strictEqual(
        (aParam as Record<string, unknown>).propertyPath,
        undefined,
        'Simple params should not have propertyPath'
      );
      assert.strictEqual(
        (aParam as Record<string, unknown>).arrayIndex,
        undefined,
        'Simple params should not have arrayIndex'
      );
    });

    it('should handle existing default parameter patterns', async () => {
      await setupTest(backend, {
        'index.js': `
function foo(a = 1, b = 2) {
  return a + b;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const aParam = paramNodes.find((p: NodeRecord) => p.name === 'a');
      const bParam = paramNodes.find((p: NodeRecord) => p.name === 'b');

      assert.ok(aParam, 'Should handle simple default params');
      assert.ok(bParam, 'Should handle simple default params');

      assert.strictEqual(
        (aParam as Record<string, unknown>).hasDefault,
        true,
        'Should preserve hasDefault for simple params'
      );
      assert.strictEqual(
        (bParam as Record<string, unknown>).hasDefault,
        true,
        'Should preserve hasDefault for simple params'
      );
    });

    it('should handle existing rest parameter patterns', async () => {
      await setupTest(backend, {
        'index.js': `
function foo(a, b, ...rest) {
  return rest;
}
        `
      });

      const paramNodes = await getNodesByType(backend, 'PARAMETER');
      const restParam = paramNodes.find((p: NodeRecord) => p.name === 'rest');

      assert.ok(restParam, 'Should handle simple rest params');
      assert.strictEqual(
        (restParam as Record<string, unknown>).isRest,
        true,
        'Should preserve isRest for simple rest params'
      );
    });
  });
});
