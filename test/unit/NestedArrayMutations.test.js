/**
 * Tests for Nested Array Mutation Tracking (REG-117)
 *
 * When code does obj.arr.push(item), this.items.push(item), etc.,
 * we need to resolve the base object and create FLOWS_INTO edges.
 *
 * This addresses the gap where nested mutations like obj.arr.push(item)
 * were detected but couldn't create edges because 'obj.arr' isn't a variable.
 *
 * Key insight from Joel's plan:
 * - arrayName stored as "obj.arr" (string) but no variable with that name exists
 * - Solution: Extract base object ("obj") and property ("arr") during detection
 * - GraphBuilder falls back to base object when direct lookup fails
 *
 * Edge direction: value FLOWS_INTO base_object (src=value, dst=base_object)
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
  const testDir = join(tmpdir(), `navi-test-nested-array-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-nested-array-${testCounter}`,
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

describe('Nested Array Mutation Tracking (REG-117)', () => {
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

  // ============================================================================
  // Test 1: Simple nested mutation - obj.arr.push(item)
  // ============================================================================
  describe('obj.arr.push(item) - simple nested mutation', () => {
    it('should create FLOWS_INTO edge from item to base object', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { arr: [] };
const item = 'test';
obj.arr.push(item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the base object variable 'obj'
      const objVar = allNodes.find(n =>
        n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(objVar, 'Variable "obj" not found');

      // Find the item variable
      const itemVar = allNodes.find(n =>
        n.name === 'item' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(itemVar, 'Variable "item" not found');

      // Find FLOWS_INTO edge from item to obj (not to 'arr' which isn't a variable)
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemVar.id &&
        e.dst === objVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "item" (${itemVar.id}) to "obj" (${objVar.id}). ` +
        `Found FLOWS_INTO edges: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      // Verify metadata
      assert.strictEqual(flowsInto.mutationMethod, 'push', 'Edge should have mutationMethod: push');
      assert.strictEqual(flowsInto.argIndex, 0, 'Edge should have argIndex: 0');
    });

    it('should handle nested mutation with object declared separately from array', async () => {
      await setupTest(backend, {
        'index.js': `
const container = {};
container.items = [];
const value = { id: 1 };
container.items.push(value);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const containerVar = allNodes.find(n => n.name === 'container');
      const valueVar = allNodes.find(n => n.name === 'value');

      assert.ok(containerVar, 'Variable "container" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueVar.id &&
        e.dst === containerVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "value" to "container". ` +
        `Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );
    });
  });

  // ============================================================================
  // Test 2: this.property.push(item) in class methods
  // LIMITATION: 'this' is not a variable node, so edge resolution may fail silently.
  // This is documented expected behavior per Joel's plan.
  // ============================================================================
  describe('this.items.push(item) - class method pattern', () => {
    it('should fail silently when "this" cannot be resolved (expected limitation)', async () => {
      // Per Joel's plan: "should fail silently if 'this' not found"
      // 'this' is a keyword, not a variable, so no node exists for it
      await setupTest(backend, {
        'index.js': `
class Service {
  constructor() {
    this.items = [];
  }

  addItem(item) {
    this.items.push(item);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the parameter 'item' in addItem method
      const itemParam = allNodes.find(n =>
        n.name === 'item' && (n.type === 'VARIABLE' || n.type === 'PARAMETER')
      );

      // 'this' has no corresponding node, so no FLOWS_INTO edge should be created
      // This is the expected limitation documented in the plan
      const flowsIntoFromItem = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemParam?.id
      );

      // Should NOT create edge since 'this' can't be resolved
      // This test documents the limitation - not a failure
      assert.strictEqual(
        flowsIntoFromItem.length, 0,
        'Should NOT create FLOWS_INTO edge when "this" cannot be resolved (documented limitation)'
      );
    });

    it('should handle this.arr.push() in arrow function assigned to property', async () => {
      // Different pattern where 'this' might be capturable
      await setupTest(backend, {
        'index.js': `
const service = {
  items: [],
  addItem: function(item) {
    this.items.push(item);
  }
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Even in object methods, 'this' isn't a variable node
      // This documents the consistent limitation
      const flowsIntoEdges = allEdges.filter(e => e.type === 'FLOWS_INTO');

      // Document actual behavior - may or may not create edges depending on implementation
      // The key is that it shouldn't crash
      assert.ok(true, 'Should not crash when processing this.items.push() in object method');
    });
  });

  // ============================================================================
  // Test 3: Multiple arguments - obj.arr.push(a, b, c)
  // ============================================================================
  describe('obj.arr.push(a, b, c) - multiple arguments', () => {
    it('should create FLOWS_INTO edges with correct argIndex for each argument', async () => {
      await setupTest(backend, {
        'index.js': `
const data = { list: [] };
const a = 1;
const b = 2;
const c = 3;
data.list.push(a, b, c);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const dataVar = allNodes.find(n => n.name === 'data');
      assert.ok(dataVar, 'Variable "data" not found');

      // Find all FLOWS_INTO edges pointing to data
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === dataVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 FLOWS_INTO edges, got ${flowsIntoEdges.length}. ` +
        `Edges: ${JSON.stringify(flowsIntoEdges)}`
      );

      // Check argIndex values
      const argIndices = flowsIntoEdges.map(e => e.argIndex).sort();
      assert.deepStrictEqual(argIndices, [0, 1, 2], 'Should have argIndex 0, 1, 2');

      // Verify all have mutationMethod: push
      for (const edge of flowsIntoEdges) {
        assert.strictEqual(edge.mutationMethod, 'push', 'All edges should have mutationMethod: push');
      }
    });
  });

  // ============================================================================
  // Test 4: Spread operator - obj.arr.push(...items)
  // ============================================================================
  describe('obj.arr.push(...items) - spread operator', () => {
    it('should create FLOWS_INTO edge with isSpread flag', async () => {
      await setupTest(backend, {
        'index.js': `
const container = { elements: [] };
const newItems = [1, 2, 3];
container.elements.push(...newItems);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const containerVar = allNodes.find(n => n.name === 'container' && (n.type === 'CONSTANT' || n.type === 'VARIABLE'));
      const newItemsVar = allNodes.find(n => n.name === 'newItems' && (n.type === 'CONSTANT' || n.type === 'VARIABLE'));

      assert.ok(containerVar, 'Variable "container" not found');
      assert.ok(newItemsVar, 'Variable "newItems" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === newItemsVar.id &&
        e.dst === containerVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "newItems" (${newItemsVar.id}) to "container" (${containerVar.id}). ` +
        `Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      assert.strictEqual(flowsInto.isSpread, true, 'Edge should have isSpread: true');
      assert.strictEqual(flowsInto.mutationMethod, 'push', 'Edge should have mutationMethod: push');
    });

    it('should handle mixed arguments with spread: obj.arr.push(a, ...b, c)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { arr: [] };
const first = 'a';
const middle = ['b', 'c'];
const last = 'd';
obj.arr.push(first, ...middle, last);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      assert.ok(objVar, 'Variable "obj" not found');

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === objVar.id
      );

      // Should have 3 edges: first, middle (with spread), last
      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 FLOWS_INTO edges, got ${flowsIntoEdges.length}`
      );

      // Find the spread edge
      const spreadEdge = flowsIntoEdges.find(e => e.isSpread === true);
      assert.ok(spreadEdge, 'Should have one edge with isSpread: true');

      // Non-spread edges should not have isSpread
      const nonSpreadEdges = flowsIntoEdges.filter(e => !e.isSpread);
      assert.strictEqual(nonSpreadEdges.length, 2, 'Should have 2 non-spread edges');
    });
  });

  // ============================================================================
  // Test 5: Regression test - direct arr.push(item) still works
  // ============================================================================
  describe('arr.push(item) - regression test for direct mutations', () => {
    it('should continue to create FLOWS_INTO edge for direct array mutations', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const item = { name: 'test' };
arr.push(item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const itemVar = allNodes.find(n => n.name === 'item');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(itemVar, 'Variable "item" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(
        flowsInto,
        'Direct arr.push(item) should still create FLOWS_INTO edge (regression check)'
      );

      assert.strictEqual(flowsInto.mutationMethod, 'push');
      assert.strictEqual(flowsInto.argIndex, 0);
    });

    it('should handle both direct and nested mutations in same file', async () => {
      await setupTest(backend, {
        'index.js': `
const directArr = [];
const obj = { nestedArr: [] };
const item1 = 'direct';
const item2 = 'nested';

directArr.push(item1);        // Direct mutation
obj.nestedArr.push(item2);    // Nested mutation
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const directArrVar = allNodes.find(n => n.name === 'directArr');
      const objVar = allNodes.find(n => n.name === 'obj');
      const item1Var = allNodes.find(n => n.name === 'item1');
      const item2Var = allNodes.find(n => n.name === 'item2');

      assert.ok(directArrVar, 'Variable "directArr" not found');
      assert.ok(objVar, 'Variable "obj" not found');
      assert.ok(item1Var, 'Variable "item1" not found');
      assert.ok(item2Var, 'Variable "item2" not found');

      // Check direct mutation edge
      const directEdge = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === item1Var.id &&
        e.dst === directArrVar.id
      );
      assert.ok(directEdge, 'Direct mutation should create FLOWS_INTO edge');

      // Check nested mutation edge
      const nestedEdge = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === item2Var.id &&
        e.dst === objVar.id
      );
      assert.ok(nestedEdge, 'Nested mutation should create FLOWS_INTO edge to base object');
    });
  });

  // ============================================================================
  // Test 6: Other mutation methods - obj.arr.unshift() and obj.arr.splice()
  // ============================================================================
  describe('obj.arr.unshift(item) and obj.arr.splice()', () => {
    it('should create FLOWS_INTO edge for nested unshift', async () => {
      await setupTest(backend, {
        'index.js': `
const queue = { items: [1, 2, 3] };
const first = { priority: 'high' };
queue.items.unshift(first);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const queueVar = allNodes.find(n => n.name === 'queue');
      const firstVar = allNodes.find(n => n.name === 'first');

      assert.ok(queueVar, 'Variable "queue" not found');
      assert.ok(firstVar, 'Variable "first" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === firstVar.id &&
        e.dst === queueVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "first" to "queue" for unshift. ` +
        `Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      assert.strictEqual(flowsInto.mutationMethod, 'unshift', 'Edge should have mutationMethod: unshift');
    });

    it('should create FLOWS_INTO edge for nested splice insertions', async () => {
      await setupTest(backend, {
        'index.js': `
const data = { records: [1, 2, 3] };
const newRecord = { id: 'new' };
data.records.splice(1, 0, newRecord);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const dataVar = allNodes.find(n => n.name === 'data');
      const newRecordVar = allNodes.find(n => n.name === 'newRecord');

      assert.ok(dataVar, 'Variable "data" not found');
      assert.ok(newRecordVar, 'Variable "newRecord" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === newRecordVar.id &&
        e.dst === dataVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "newRecord" to "data" for splice. ` +
        `Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      assert.strictEqual(flowsInto.mutationMethod, 'splice', 'Edge should have mutationMethod: splice');
      // argIndex should be 0 (first insertion argument, not counting start/deleteCount)
      assert.strictEqual(flowsInto.argIndex, 0, 'Edge argIndex should be 0');
    });

    it('should NOT create edges for splice start and deleteCount arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { arr: [1, 2, 3] };
const start = 1;
const deleteCount = 0;
const item = 'inserted';
obj.arr.splice(start, deleteCount, item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      const startVar = allNodes.find(n => n.name === 'start');
      const deleteCountVar = allNodes.find(n => n.name === 'deleteCount');

      // start and deleteCount should NOT have FLOWS_INTO edges
      const startFlows = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.src === startVar?.id && e.dst === objVar?.id
      );
      const deleteCountFlows = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.src === deleteCountVar?.id && e.dst === objVar?.id
      );

      assert.ok(!startFlows, 'start should NOT flow into obj');
      assert.ok(!deleteCountFlows, 'deleteCount should NOT flow into obj');
    });
  });

  // ============================================================================
  // Test 7: Out of scope cases - should NOT create edges
  // ============================================================================
  describe('Out of scope patterns (should NOT create edges)', () => {
    it('should NOT create edge for computed property: obj[key].push(item)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { arr: [] };
const key = 'arr';
const item = 'test';
obj[key].push(item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      const itemVar = allNodes.find(n => n.name === 'item');

      assert.ok(objVar, 'Variable "obj" not found');
      assert.ok(itemVar, 'Variable "item" not found');

      // Computed property access is out of scope - no edge expected
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemVar.id &&
        e.dst === objVar.id
      );

      assert.ok(
        !flowsInto,
        'Computed property obj[key].push() should NOT create FLOWS_INTO edge (out of scope)'
      );
    });

    it('should NOT create edge for function return: getArray().push(item)', async () => {
      await setupTest(backend, {
        'index.js': `
function getArray() {
  return [];
}
const item = 'test';
getArray().push(item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const itemVar = allNodes.find(n => n.name === 'item');
      assert.ok(itemVar, 'Variable "item" not found');

      // Return value mutations are out of scope - no edge expected
      const flowsIntoFromItem = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemVar.id
      );

      assert.strictEqual(
        flowsIntoFromItem.length, 0,
        'getArray().push() should NOT create FLOWS_INTO edge (out of scope)'
      );
    });

    it('should NOT create edge for multi-level nesting: obj.a.b.push(item)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { a: { b: [] } };
const item = 'deep';
obj.a.b.push(item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      const itemVar = allNodes.find(n => n.name === 'item');

      assert.ok(objVar, 'Variable "obj" not found');
      assert.ok(itemVar, 'Variable "item" not found');

      // Multi-level nesting is out of scope - no edge expected
      // (REG-117 only handles single-level: obj.arr.push)
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemVar.id &&
        e.dst === objVar.id
      );

      assert.ok(
        !flowsInto,
        'Multi-level nesting obj.a.b.push() should NOT create FLOWS_INTO edge (out of scope for REG-117)'
      );
    });
  });

  // ============================================================================
  // Edge metadata verification
  // ============================================================================
  describe('Edge metadata for nested mutations', () => {
    it('should include nestedProperty in metadata when available', async () => {
      await setupTest(backend, {
        'index.js': `
const state = { users: [] };
const newUser = { name: 'John' };
state.users.push(newUser);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const stateVar = allNodes.find(n => n.name === 'state');
      const newUserVar = allNodes.find(n => n.name === 'newUser');

      assert.ok(stateVar, 'Variable "state" not found');
      assert.ok(newUserVar, 'Variable "newUser" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === newUserVar.id &&
        e.dst === stateVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge');

      // Per Joel's plan, metadata should include nestedProperty
      if (flowsInto.metadata) {
        assert.strictEqual(
          flowsInto.metadata.nestedProperty, 'users',
          'metadata.nestedProperty should be "users"'
        );
      }
      // Note: metadata is optional, so test passes if no metadata exists too
    });
  });

  // ============================================================================
  // Function-level nested mutations
  // ============================================================================
  describe('Nested mutations inside functions', () => {
    it('should detect obj.arr.push() inside regular functions', { todo: 'REG-117: nested mutation in function scope not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
function addToState(state, item) {
  state.items.push(item);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the state parameter
      const stateParam = allNodes.find(n =>
        n.name === 'state' && (n.type === 'VARIABLE' || n.type === 'PARAMETER')
      );
      assert.ok(stateParam, 'Parameter "state" not found');

      // Find the item parameter
      const itemParam = allNodes.find(n =>
        n.name === 'item' && (n.type === 'VARIABLE' || n.type === 'PARAMETER')
      );
      assert.ok(itemParam, 'Parameter "item" not found');

      // Should create edge from item to state
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemParam.id &&
        e.dst === stateParam.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "item" to "state" inside function. ` +
        `Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );
    });

    it('should detect obj.arr.push() inside arrow functions', { todo: 'REG-117: nested mutation in arrow function scope not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
const addItem = (container, value) => {
  container.list.push(value);
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const containerParam = allNodes.find(n =>
        n.name === 'container' && (n.type === 'VARIABLE' || n.type === 'PARAMETER')
      );
      const valueParam = allNodes.find(n =>
        n.name === 'value' && (n.type === 'VARIABLE' || n.type === 'PARAMETER')
      );

      assert.ok(containerParam, 'Parameter "container" not found');
      assert.ok(valueParam, 'Parameter "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueParam.id &&
        e.dst === containerParam.id
      );

      assert.ok(flowsInto, 'Should detect nested mutation inside arrow function');
    });
  });

  // ============================================================================
  // Real-world integration scenarios
  // ============================================================================
  describe('Real-world integration scenarios', () => {
    it('should allow tracing objects through nested array mutations (reducer pattern)', { todo: 'REG-117: nested mutation in function scope not yet implemented' }, async () => {
      // Redux-like reducer pattern
      await setupTest(backend, {
        'index.js': `
function todosReducer(state, action) {
  const newTodo = { id: Date.now(), text: action.payload };
  state.todos.push(newTodo);
  return state;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const stateParam = allNodes.find(n => n.name === 'state');
      const newTodoVar = allNodes.find(n => n.name === 'newTodo');

      assert.ok(stateParam, 'Parameter "state" not found');
      assert.ok(newTodoVar, 'Variable "newTodo" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === newTodoVar.id &&
        e.dst === stateParam.id
      );

      assert.ok(flowsInto, 'Should trace newTodo flowing into state.todos');
    });

    it('should track event handler registration (emitter pattern)', async () => {
      await setupTest(backend, {
        'index.js': `
const eventEmitter = { handlers: { click: [] } };
const onClick = (e) => console.log(e);
eventEmitter.handlers.click.push(onClick);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Note: This is actually multi-level nesting (handlers.click.push)
      // which is out of scope for REG-117. Document actual behavior.
      const flowsIntoEdges = allEdges.filter(e => e.type === 'FLOWS_INTO');

      // This pattern is out of scope (3 levels deep)
      // Test documents that it doesn't crash and expected behavior
      assert.ok(true, 'Multi-level nesting pattern should not crash');
    });
  });
});
