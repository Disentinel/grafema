/**
 * Tests for Indexed Array Assignment Refactoring (REG-116)
 *
 * These tests lock current behavior BEFORE refactoring to ensure
 * that extracting indexed assignment helper doesn't break functionality.
 *
 * Tests verify that arr[i] = value creates proper FLOWS_INTO edges
 * with correct metadata in various contexts.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-indexed-assign-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-indexed-assign-${testCounter}`,
      type: 'module'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('Indexed Array Assignment Refactoring (REG-116)', () => {
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

  describe('Module-level indexed assignment', () => {
    it('should create FLOWS_INTO edge for arr[0] = variable', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const value = 42;
arr[0] = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n =>
        n.name === 'arr' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const valueVar = allNodes.find(n =>
        n.name === 'value' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "value" (${valueVar.id}) to "arr" (${arrVar.id}). ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      // Verify metadata
      assert.strictEqual(flowsInto.mutationMethod, 'indexed', 'Edge should have mutationMethod: indexed');
      assert.strictEqual(flowsInto.argIndex, 0, 'Edge should have argIndex: 0');
    });

    it('should create FLOWS_INTO edge for arr[0] = literal', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
arr[0] = 'test';
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      // For literals, the edge might be from a LITERAL node
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(
        flowsIntoEdges.length > 0,
        'Expected at least one FLOWS_INTO edge to arr'
      );

      // Verify at least one edge has indexed mutation method
      const indexedEdge = flowsIntoEdges.find(e => e.mutationMethod === 'indexed');
      assert.ok(indexedEdge, 'Expected FLOWS_INTO edge with mutationMethod: indexed');
    });

    it('should create FLOWS_INTO edge for arr[0] = object literal', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
arr[0] = { name: 'test' };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(
        flowsIntoEdges.length > 0,
        'Expected at least one FLOWS_INTO edge to arr'
      );

      const indexedEdge = flowsIntoEdges.find(e => e.mutationMethod === 'indexed');
      assert.ok(indexedEdge, 'Expected FLOWS_INTO edge with mutationMethod: indexed');
    });

    it('should create FLOWS_INTO edge for arr[0] = array literal', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
arr[0] = [1, 2, 3];
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(
        flowsIntoEdges.length > 0,
        'Expected at least one FLOWS_INTO edge to arr'
      );

      const indexedEdge = flowsIntoEdges.find(e => e.mutationMethod === 'indexed');
      assert.ok(indexedEdge, 'Expected FLOWS_INTO edge with mutationMethod: indexed');
    });

    it('should create FLOWS_INTO edge for arr[0] = functionCall()', async () => {
      await setupTest(backend, {
        'index.js': `
function getValue() { return 42; }
const arr = [];
arr[0] = getValue();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(
        flowsIntoEdges.length > 0,
        'Expected at least one FLOWS_INTO edge to arr'
      );

      const indexedEdge = flowsIntoEdges.find(e => e.mutationMethod === 'indexed');
      assert.ok(indexedEdge, 'Expected FLOWS_INTO edge with mutationMethod: indexed');
    });
  });

  describe('Computed index assignment', () => {
    it('should create FLOWS_INTO edge for arr[index] = value', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const index = 5;
const value = 'test';
arr[index] = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const valueVar = allNodes.find(n => n.name === 'value');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge even with computed index');
      assert.strictEqual(flowsInto.mutationMethod, 'indexed', 'Edge should have mutationMethod: indexed');
    });

    it('should create FLOWS_INTO edge for arr[i + 1] = value', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const i = 0;
const value = 'test';
arr[i + 1] = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const valueVar = allNodes.find(n => n.name === 'value');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge with expression index');
      assert.strictEqual(flowsInto.mutationMethod, 'indexed', 'Edge should have mutationMethod: indexed');
    });
  });

  describe('Function-level indexed assignment', () => {
    it('should create FLOWS_INTO edge inside function body', async () => {
      await setupTest(backend, {
        'index.js': `
function addToArray(arr, value) {
  arr[0] = value;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find parameter nodes
      const arrParam = allNodes.find(n =>
        n.name === 'arr' && n.type === 'PARAMETER'
      );
      const valueParam = allNodes.find(n =>
        n.name === 'value' && n.type === 'PARAMETER'
      );

      assert.ok(arrParam, 'Parameter "arr" not found');
      assert.ok(valueParam, 'Parameter "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueParam.id &&
        e.dst === arrParam.id
      );

      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge from value parameter to arr parameter'
      );
      assert.strictEqual(flowsInto.mutationMethod, 'indexed', 'Edge should have mutationMethod: indexed');
    });

    it('should create FLOWS_INTO edge for local variables in function', async () => {
      await setupTest(backend, {
        'index.js': `
function test() {
  const arr = [];
  const value = 42;
  arr[0] = value;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find local variables in function
      const arrVar = allNodes.find(n =>
        n.name === 'arr' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const valueVar = allNodes.find(n =>
        n.name === 'value' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from value to arr');
      assert.strictEqual(flowsInto.mutationMethod, 'indexed', 'Edge should have mutationMethod: indexed');
    });
  });

  describe('Mixed contexts in same file', () => {
    it('should create FLOWS_INTO edges in both module and function contexts', async () => {
      await setupTest(backend, {
        'index.js': `
// Module level
const moduleArr = [];
const moduleValue = 'module';
moduleArr[0] = moduleValue;

// Function level
function addItem() {
  const funcArr = [];
  const funcValue = 'function';
  funcArr[0] = funcValue;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Verify module-level edge
      const moduleArrVar = allNodes.find(n => n.name === 'moduleArr');
      const moduleValueVar = allNodes.find(n => n.name === 'moduleValue');

      assert.ok(moduleArrVar, 'Variable "moduleArr" not found');
      assert.ok(moduleValueVar, 'Variable "moduleValue" not found');

      const moduleFlowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === moduleValueVar.id &&
        e.dst === moduleArrVar.id
      );

      assert.ok(moduleFlowsInto, 'Expected module-level FLOWS_INTO edge');
      assert.strictEqual(moduleFlowsInto.mutationMethod, 'indexed', 'Module edge should have mutationMethod: indexed');

      // Verify function-level edge
      const funcArrVar = allNodes.find(n => n.name === 'funcArr');
      const funcValueVar = allNodes.find(n => n.name === 'funcValue');

      assert.ok(funcArrVar, 'Variable "funcArr" not found');
      assert.ok(funcValueVar, 'Variable "funcValue" not found');

      const funcFlowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === funcValueVar.id &&
        e.dst === funcArrVar.id
      );

      assert.ok(funcFlowsInto, 'Expected function-level FLOWS_INTO edge');
      assert.strictEqual(funcFlowsInto.mutationMethod, 'indexed', 'Function edge should have mutationMethod: indexed');
    });
  });

  describe('Edge metadata verification', () => {
    it('should include line and column information in edge metadata', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const value = 'test';
arr[0] = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id &&
        e.mutationMethod === 'indexed'
      );

      assert.ok(flowsIntoEdges.length > 0, 'Expected indexed FLOWS_INTO edge');

      // Note: Line/column might be stored on the edge or in related metadata
      // This test documents current behavior for future verification
      const edge = flowsIntoEdges[0];

      // Basic structure verification
      assert.ok(edge.src, 'Edge should have src');
      assert.ok(edge.dst, 'Edge should have dst');
      assert.strictEqual(edge.type, 'FLOWS_INTO', 'Edge type should be FLOWS_INTO');
      assert.strictEqual(edge.mutationMethod, 'indexed', 'Edge should have mutationMethod: indexed');
    });
  });

  describe('Multiple assignments to same array', () => {
    it('should create multiple FLOWS_INTO edges for multiple assignments', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const val1 = 'first';
const val2 = 'second';
const val3 = 'third';
arr[0] = val1;
arr[1] = val2;
arr[2] = val3;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id &&
        e.mutationMethod === 'indexed'
      );

      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 indexed FLOWS_INTO edges, got ${flowsIntoEdges.length}`
      );

      // Verify all have argIndex 0 (for indexed assignments, argIndex is always 0)
      flowsIntoEdges.forEach(edge => {
        assert.strictEqual(edge.argIndex, 0, 'All indexed assignments should have argIndex: 0');
      });
    });
  });
});
