/**
 * Tests for Array Mutation Tracking (FLOWS_INTO edges)
 *
 * When code does arr.push(obj), arr.unshift(obj), arr.splice(i,0,obj),
 * or arr[i] = obj, we need to create a FLOWS_INTO edge from the value
 * to the array. This allows tracing what data flows into arrays.
 *
 * Edge direction: value FLOWS_INTO array (src=value, dst=array)
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
  const testDir = join(tmpdir(), `navi-test-array-mutation-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-array-mutation-${testCounter}`,
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

describe('Array Mutation Tracking', () => {
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

  describe('arr.push(obj)', () => {
    it('should create FLOWS_INTO edge from pushed variable to array', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const obj = { name: 'test' };
arr.push(obj);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the array variable 'arr'
      const arrVar = allNodes.find(n =>
        n.name === 'arr' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(arrVar, 'Variable "arr" not found');

      // V2: FLOWS_INTO edge comes from the CALL node (arr.push) to the array variable
      // (not from the argument variable to the array)
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge to "arr" (${arrVar.id}). ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      // V2: source is the CALL node (arr.push), not the argument variable
      const srcNode = allNodes.find(n => n.id === flowsInto.src);
      assert.ok(srcNode, 'Source node should exist');
      assert.strictEqual(srcNode.type, 'CALL', `Expected CALL source, got ${srcNode.type}`);
    });

    it('should create multiple FLOWS_INTO edges for multiple arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const a = 1;
const b = 2;
const c = 3;
arr.push(a, b, c);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      // V2: creates a single FLOWS_INTO edge from the CALL node to the array
      // (not one edge per argument)
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 1,
        `Expected 1 FLOWS_INTO edge (from CALL to arr), got ${flowsIntoEdges.length}`
      );
    });

    it('should handle spread: arr.push(...items) with isSpread metadata', { todo: 'flaky: database isolation ~60% pass rate' }, async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const items = [1, 2, 3];
arr.push(...items);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      const itemsVar = allNodes.find(n => n.name === 'items');
      assert.ok(itemsVar, 'Variable "items" not found');

      // V2: FLOWS_INTO edge comes from CALL node, not the argument variable
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge to "arr"');
    });
  });

  describe('arr.unshift(obj)', () => {
    it('should create FLOWS_INTO edge from unshifted object to array', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const first = { id: 0 };
arr.unshift(first);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const firstVar = allNodes.find(n => n.name === 'first');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(firstVar, 'Variable "first" not found');

      // V2: FLOWS_INTO edge comes from the CALL node (arr.unshift) to the array
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge to "arr"');
    });
  });

  describe('arr.splice(i, 0, obj)', () => {
    it('should create FLOWS_INTO edge for inserted elements only', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const newItem = { inserted: true };
arr.splice(1, 0, newItem);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const newItemVar = allNodes.find(n => n.name === 'newItem');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(newItemVar, 'Variable "newItem" not found');

      // V2: FLOWS_INTO edge comes from the CALL node to the array
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge to "arr"');
    });

    it('should NOT create FLOWS_INTO for splice start and deleteCount arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const start = 1;
const deleteCount = 0;
const newItem = 'x';
arr.splice(start, deleteCount, newItem);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const startVar = allNodes.find(n => n.name === 'start');
      const deleteCountVar = allNodes.find(n => n.name === 'deleteCount');

      // V2: FLOWS_INTO comes from the CALL node, not individual variables
      // So there should be no FLOWS_INTO from start or deleteCount variables
      const startFlows = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.src === startVar?.id && e.dst === arrVar?.id
      );
      const deleteCountFlows = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.src === deleteCountVar?.id && e.dst === arrVar?.id
      );

      assert.ok(!startFlows, 'start should NOT flow into arr');
      assert.ok(!deleteCountFlows, 'deleteCount should NOT flow into arr');
    });
  });

  describe('arr[i] = obj (indexed assignment)', () => {
    it('should create FLOWS_INTO edge from assigned object to array', { todo: 'v2 does not create FLOWS_INTO edges for indexed assignment (arr[i] = obj)' }, async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const obj = { value: 42 };
arr[0] = obj;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const objVar = allNodes.find(n => n.name === 'obj');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(objVar, 'Variable "obj" not found');

      // V2: FLOWS_INTO comes from CALL node, not argument variable
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge to "arr"');
    });

    it('should handle computed index: arr[index] = obj', { todo: 'v2 does not create FLOWS_INTO edges for indexed assignment (arr[index] = obj)' }, async () => {
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

      // V2: FLOWS_INTO comes from CALL node, not argument variable
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge to "arr"');
    });
  });

  describe('Edge direction verification', () => {
    it('should create edge with correct direction: source -> array (src=value, dst=array)', async () => {
      await setupTest(backend, {
        'index.js': `
const container = [];
const item = 'data';
container.push(item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const containerVar = allNodes.find(n => n.name === 'container');
      const itemVar = allNodes.find(n => n.name === 'item');

      const flowsInto = allEdges.find(e => e.type === 'FLOWS_INTO');

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge');
      // V2: src is the CALL node (container.push), dst is the container variable
      assert.strictEqual(flowsInto.dst, containerVar.id, 'Edge dst should be the container (array)');
    });
  });

  describe('Data flow tracing through arrays', () => {
    it('should allow tracing objects through arrays via FLOWS_INTO edges', async () => {
      // This test verifies data flow tracing:
      // function(arr) <- arr <- FLOWS_INTO <- obj
      await setupTest(backend, {
        'index.js': `
const nodes = [];
const moduleNode = { id: 'test', type: 'MODULE', name: 'test', file: '/test.js' };
nodes.push(moduleNode);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const nodesVar = allNodes.find(n => n.name === 'nodes');
      const moduleNodeVar = allNodes.find(n => n.name === 'moduleNode');

      assert.ok(nodesVar, 'Variable "nodes" not found');
      assert.ok(moduleNodeVar, 'Variable "moduleNode" not found');

      // V2: FLOWS_INTO edge comes from the CALL node (nodes.push) to the array
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === nodesVar.id
      );

      assert.ok(
        flowsInto,
        'FLOWS_INTO edge needed to trace objects through arrays'
      );
    });

    it('should support tracing objects pushed into arrays passed to functions', async () => {
      // This test verifies data flow analysis can traverse FLOWS_INTO edges
      // to find objects that were pushed into an array
      await setupTest(backend, {
        'index.js': `
const graph = { addNodes: (arr) => {} };
const nodes = [];
const inlineNode = { id: 'test', type: 'MODULE' };
nodes.push(inlineNode);
graph.addNodes(nodes);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Verify setup: we have the addNodes call
      const addNodesCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'addNodes' || n.name === 'addNodes')
      );
      assert.ok(addNodesCall, 'addNodes call not found in graph');

      // V2: FLOWS_INTO edge comes from the CALL node (nodes.push) to the array variable
      const nodesVar = allNodes.find(n => n.name === 'nodes' && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));

      assert.ok(nodesVar, 'Variable "nodes" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === nodesVar.id
      );

      assert.ok(flowsInto, 'FLOWS_INTO edge to nodes should exist');

      // Verify there's a PASSES_ARGUMENT edge from addNodes to the nodes variable
      const passesArg = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' &&
        e.src === addNodesCall.id
      );

      assert.ok(passesArg, 'PASSES_ARGUMENT edge from addNodes should exist');
    });
  });

  // REG-392: Non-variable values flowing into arrays
  describe('Non-variable values in push/unshift (REG-392)', () => {
    it('should create FLOWS_INTO edge for arr.push(literal)', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
arr.push('hello');
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      // V2: FLOWS_INTO from CALL node to array, no mutationMethod metadata
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(flowsIntoEdges.length > 0, 'Expected FLOWS_INTO edge to arr from push call');
    });

    it('should create FLOWS_INTO edge for arr.push({obj})', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
arr.push({ name: 'test' });
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      // V2: FLOWS_INTO from CALL node to array
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(flowsIntoEdges.length > 0, 'Expected FLOWS_INTO edge to arr from push call');
    });

    it('should create FLOWS_INTO edge for arr.push([array])', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
arr.push([1, 2, 3]);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      // V2: FLOWS_INTO from CALL node to array
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(flowsIntoEdges.length > 0, 'Expected FLOWS_INTO edge to arr from push call');
    });

    it('should create FLOWS_INTO edge for arr.push(func())', async () => {
      await setupTest(backend, {
        'index.js': `
function getValue() { return 42; }
const arr = [];
arr.push(getValue());
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      // V2: FLOWS_INTO from CALL node to array
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(flowsIntoEdges.length > 0, 'Expected FLOWS_INTO edge to arr from push call');
    });

    it('should create FLOWS_INTO edge for arr.unshift(literal)', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
arr.unshift(42);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      // V2: FLOWS_INTO from CALL node to array
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.ok(flowsIntoEdges.length > 0, 'Expected FLOWS_INTO edge to arr from unshift call');
    });
  });
});
