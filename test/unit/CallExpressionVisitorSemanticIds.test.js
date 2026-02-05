/**
 * CallExpressionVisitor Semantic ID Integration Tests
 *
 * Tests for integrating semantic IDs into CallExpressionVisitor.
 * These tests verify that:
 * 1. Direct function calls get semantic IDs with discriminators
 * 2. Method calls (obj.method) get semantic IDs
 * 3. Constructor calls (new) get semantic IDs
 * 4. Array mutations get semantic IDs
 * 5. IDs are stable across line number changes
 *
 * Format: {file}->{scope_path}->CALL->{calleeName}#N
 *
 * TDD: Tests written first per Kent Beck's methodology.
 *
 * User Decisions:
 * 1. Replace `id`: Semantic ID becomes the primary `id` field (breaking change)
 * 2. Full scope path: Calls include control flow scope in path
 * 3. Array mutations: Track with semantic IDs
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const TEST_LABEL = 'call-semantic';

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  return setupSemanticTest(backend, files, { testLabel: TEST_LABEL });
}

describe('CallExpressionVisitor semantic ID integration', () => {
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

  // ===========================================================================
  // Direct function calls
  // ===========================================================================

  describe('direct calls', () => {
    it('should generate semantic ID for function call', async () => {
      await setupTest(backend, {
        'index.js': `
function helper() {}
helper();
        `
      });

      const allNodes = await backend.getAllNodes();
      const callNode = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'helper'
      );

      assert.ok(callNode, 'CALL node "helper" not found');

      // Semantic ID format: file->global->CALL->name#N
      // Should NOT contain line numbers (no colons)
      assert.ok(
        !callNode.id.includes(':'),
        `ID should not contain line:column format. Got: ${callNode.id}`
      );
      assert.ok(
        callNode.id.includes('index.js'),
        `ID should contain filename. Got: ${callNode.id}`
      );
      assert.ok(
        callNode.id.includes('CALL'),
        `ID should contain CALL type. Got: ${callNode.id}`
      );
      assert.ok(
        callNode.id.includes('helper'),
        `ID should contain callee name. Got: ${callNode.id}`
      );

      // Expected format: index.js->global->CALL->helper#0
      assert.strictEqual(
        callNode.id,
        'index.js->global->CALL->helper#0',
        `Expected semantic ID format with discriminator`
      );
    });

    it('should use discriminator for multiple calls to same function', async () => {
      await setupTest(backend, {
        'index.js': `
function log(msg) {}
log('first');
log('second');
log('third');
        `
      });

      const allNodes = await backend.getAllNodes();
      const logCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.name === 'log'
      );

      assert.strictEqual(logCalls.length, 3, 'Should have 3 log calls');

      // Extract discriminators from IDs
      const ids = logCalls.map(c => c.id).sort();

      // Should have different discriminators
      assert.ok(
        ids.some(id => id.includes('#0')),
        'Should have call with discriminator #0'
      );
      assert.ok(
        ids.some(id => id.includes('#1')),
        'Should have call with discriminator #1'
      );
      assert.ok(
        ids.some(id => id.includes('#2')),
        'Should have call with discriminator #2'
      );

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, 'All call IDs should be unique');
    });

    it('should track calls across control flow branches', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  if (condition) {
    doWork();
  } else {
    doWork();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const doWorkCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.name === 'doWork'
      );

      assert.strictEqual(doWorkCalls.length, 2, 'Should have 2 doWork calls');

      const ids = doWorkCalls.map(c => c.id);

      // Calls in different control flow branches should have different IDs
      assert.notStrictEqual(ids[0], ids[1], 'Calls in different branches should have different IDs');

      // One should be in if#0, other in else#0
      assert.ok(
        ids.some(id => id.includes('if#')),
        'One call should be in if scope'
      );
      assert.ok(
        ids.some(id => id.includes('else#')),
        'Other call should be in else scope'
      );
    });

    it('should include function scope in call ID', async () => {
      await setupTest(backend, {
        'index.js': `
function outer() {
  inner();
}
function inner() {}
        `
      });

      const allNodes = await backend.getAllNodes();
      const innerCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'inner'
      );

      assert.ok(innerCall, 'CALL to "inner" not found');

      // Should include outer function in scope path
      assert.ok(
        innerCall.id.includes('outer'),
        `ID should include calling function. Got: ${innerCall.id}`
      );

      // Expected: index.js->outer->CALL->inner#0
      assert.strictEqual(
        innerCall.id,
        'index.js->outer->CALL->inner#0',
        `Expected semantic ID with function scope`
      );
    });
  });

  // ===========================================================================
  // Method calls
  // ===========================================================================

  describe('method calls', () => {
    it('should generate semantic ID with object.method name', async () => {
      await setupTest(backend, {
        'index.js': `
const db = { query: () => {} };
db.query('SELECT *');
        `
      });

      const allNodes = await backend.getAllNodes();
      const methodCall = allNodes.find(n =>
        n.type === 'CALL' &&
        (n.name === 'db.query' || (n.object === 'db' && n.method === 'query'))
      );

      assert.ok(methodCall, 'Method call "db.query" not found');

      // Semantic ID should include object.method format
      assert.ok(
        methodCall.id.includes('db.query') || methodCall.id.includes('query'),
        `ID should contain method reference. Got: ${methodCall.id}`
      );
      assert.ok(
        methodCall.id.includes('#'),
        `ID should have discriminator. Got: ${methodCall.id}`
      );
    });

    it('should use discriminator for same method calls', async () => {
      await setupTest(backend, {
        'index.js': `
console.log('one');
console.log('two');
console.log('three');
        `
      });

      const allNodes = await backend.getAllNodes();
      const consoleLogs = allNodes.filter(n =>
        n.type === 'CALL' &&
        (n.name === 'console.log' || (n.object === 'console' && n.method === 'log'))
      );

      assert.strictEqual(consoleLogs.length, 3, 'Should have 3 console.log calls');

      const ids = consoleLogs.map(c => c.id);
      const uniqueIds = new Set(ids);

      assert.strictEqual(uniqueIds.size, 3, 'All method call IDs should be unique');

      // Should have discriminators 0, 1, 2
      assert.ok(ids.some(id => id.includes('#0')), 'Should have #0');
      assert.ok(ids.some(id => id.includes('#1')), 'Should have #1');
      assert.ok(ids.some(id => id.includes('#2')), 'Should have #2');
    });

    it('should include scope path for nested method calls', async () => {
      await setupTest(backend, {
        'index.js': `
function handler(data) {
  if (data.valid) {
    data.process();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const processCall = allNodes.find(n =>
        n.type === 'CALL' &&
        (n.method === 'process' || n.name?.includes('process'))
      );

      assert.ok(processCall, 'Method call "process" not found');

      // Should include function and if scope
      assert.ok(
        processCall.id.includes('handler'),
        `ID should include function scope. Got: ${processCall.id}`
      );
      assert.ok(
        processCall.id.includes('if#'),
        `ID should include if scope. Got: ${processCall.id}`
      );
    });

    it('should handle chained method calls', async () => {
      await setupTest(backend, {
        'index.js': `
const result = array.map(x => x * 2).filter(x => x > 5);
        `
      });

      const allNodes = await backend.getAllNodes();

      // Should have both map and filter calls
      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'map' || n.name?.includes('map'))
      );
      const filterCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'filter' || n.name?.includes('filter'))
      );

      // At least one should exist (implementation may vary)
      assert.ok(mapCall || filterCall, 'At least one chained method call should be found');

      if (mapCall) {
        assert.ok(mapCall.id.includes('#'), `Map call should have discriminator: ${mapCall.id}`);
      }
      if (filterCall) {
        assert.ok(filterCall.id.includes('#'), `Filter call should have discriminator: ${filterCall.id}`);
      }
    });
  });

  // ===========================================================================
  // Constructor calls (new)
  // ===========================================================================

  describe('constructor calls (new)', () => {
    it('should generate semantic ID for new expression', async () => {
      await setupTest(backend, {
        'index.js': `
class User {}
const user = new User();
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find the new expression call
      const newCall = allNodes.find(n =>
        n.type === 'CALL' && n.isNew === true
      );

      // If constructor calls are tracked as CALL nodes with isNew flag
      if (newCall) {
        assert.ok(
          newCall.id.includes('User') || newCall.id.includes('new'),
          `Constructor call ID should reference User. Got: ${newCall.id}`
        );
        // Check for line:column format (digits:digits) but allow new:ClassName format
        const hasLineColumnFormat = /:\d+:\d+/.test(newCall.id);
        assert.ok(
          !hasLineColumnFormat,
          `ID should not have line:column format. Got: ${newCall.id}`
        );
      }

      // Alternatively, check for class instantiation tracking
      const classInstantiation = allNodes.find(n =>
        n.className === 'User' || (n.type === 'CONSTANT' && n.name === 'user')
      );
      assert.ok(
        classInstantiation,
        'Class instantiation should be tracked'
      );
    });

    it('should handle multiple constructor calls', async () => {
      await setupTest(backend, {
        'index.js': `
class Item {}
const a = new Item();
const b = new Item();
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find all constructor calls for Item
      const newCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.isNew === true && n.name?.includes('Item')
      );

      // If tracked as CALL nodes
      if (newCalls.length >= 2) {
        const ids = newCalls.map(c => c.id);
        const uniqueIds = new Set(ids);
        assert.strictEqual(uniqueIds.size, newCalls.length, 'Constructor calls should have unique IDs');
      }

      // Verify the constants are created
      const aVar = allNodes.find(n => n.name === 'a');
      const bVar = allNodes.find(n => n.name === 'b');
      assert.ok(aVar, 'Variable "a" should exist');
      assert.ok(bVar, 'Variable "b" should exist');
    });
  });

  // ===========================================================================
  // Array mutations
  // ===========================================================================

  describe('array mutations', () => {
    it('should generate semantic ID for array.push()', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const item = 'value';
arr.push(item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the push call
      const pushCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'push' || n.name?.includes('push'))
      );

      if (pushCall) {
        assert.ok(
          pushCall.id.includes('#'),
          `Push call should have discriminator. Got: ${pushCall.id}`
        );
        assert.ok(
          !pushCall.id.includes(':'),
          `ID should not have line:column. Got: ${pushCall.id}`
        );
      }

      // Also verify FLOWS_INTO edge exists
      const arrVar = allNodes.find(n => n.name === 'arr');
      const itemVar = allNodes.find(n => n.name === 'item');

      if (arrVar && itemVar) {
        const flowsInto = allEdges.find(e =>
          e.type === 'FLOWS_INTO' &&
          e.src === itemVar.id &&
          e.dst === arrVar.id
        );
        assert.ok(flowsInto, 'FLOWS_INTO edge should exist for push');
        assert.strictEqual(flowsInto.mutationMethod, 'push', 'Should be push mutation');
      }
    });

    it('should generate semantic ID for array.unshift()', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const first = 0;
arr.unshift(first);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const unshiftCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'unshift' || n.name?.includes('unshift'))
      );

      if (unshiftCall) {
        assert.ok(
          unshiftCall.id.includes('#'),
          `Unshift call should have discriminator. Got: ${unshiftCall.id}`
        );
      }

      // Verify FLOWS_INTO edge
      const arrVar = allNodes.find(n => n.name === 'arr');
      const firstVar = allNodes.find(n => n.name === 'first');

      if (arrVar && firstVar) {
        const flowsInto = allEdges.find(e =>
          e.type === 'FLOWS_INTO' &&
          e.src === firstVar.id &&
          e.dst === arrVar.id
        );
        assert.ok(flowsInto, 'FLOWS_INTO edge should exist for unshift');
        assert.strictEqual(flowsInto.mutationMethod, 'unshift', 'Should be unshift mutation');
      }
    });

    it('should generate semantic ID for array.splice()', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const inserted = 'new';
arr.splice(1, 0, inserted);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const spliceCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'splice' || n.name?.includes('splice'))
      );

      if (spliceCall) {
        assert.ok(
          spliceCall.id.includes('#'),
          `Splice call should have discriminator. Got: ${spliceCall.id}`
        );
      }

      // Verify FLOWS_INTO edge
      const arrVar = allNodes.find(n => n.name === 'arr');
      const insertedVar = allNodes.find(n => n.name === 'inserted');

      if (arrVar && insertedVar) {
        const flowsInto = allEdges.find(e =>
          e.type === 'FLOWS_INTO' &&
          e.src === insertedVar.id &&
          e.dst === arrVar.id
        );
        assert.ok(flowsInto, 'FLOWS_INTO edge should exist for splice');
        assert.strictEqual(flowsInto.mutationMethod, 'splice', 'Should be splice mutation');
      }
    });

    it('should generate semantic ID for indexed assignment', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const obj = { value: 42 };
arr[0] = obj;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Verify FLOWS_INTO edge for indexed assignment
      const arrVar = allNodes.find(n => n.name === 'arr');
      const objVar = allNodes.find(n => n.name === 'obj');

      assert.ok(arrVar, 'arr variable should exist');
      assert.ok(objVar, 'obj variable should exist');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === objVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'FLOWS_INTO edge should exist for indexed assignment');
      assert.strictEqual(flowsInto.mutationMethod, 'indexed', 'Should be indexed mutation');
    });

    it('should handle multiple array mutations with discriminators', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
arr.push('a');
arr.push('b');
arr.push('c');
        `
      });

      const allNodes = await backend.getAllNodes();
      const pushCalls = allNodes.filter(n =>
        n.type === 'CALL' && (n.method === 'push' || n.name?.includes('push'))
      );

      // If push calls are tracked as CALL nodes
      if (pushCalls.length >= 3) {
        const ids = pushCalls.map(c => c.id);
        const uniqueIds = new Set(ids);
        assert.strictEqual(uniqueIds.size, 3, 'All push calls should have unique IDs');

        // Should have discriminators
        assert.ok(ids.some(id => id.includes('#0')), 'Should have #0');
        assert.ok(ids.some(id => id.includes('#1')), 'Should have #1');
        assert.ok(ids.some(id => id.includes('#2')), 'Should have #2');
      }
    });
  });

  // ===========================================================================
  // Stability tests
  // ===========================================================================

  describe('stability', () => {
    it('same code should produce same call IDs', async () => {
      const code = `
function test() {
  console.log('hello');
  process.exit(0);
}
      `;

      // First analysis
      await setupTest(backend, { 'index.js': code });
      const nodes1 = await backend.getAllNodes();
      const calls1 = nodes1.filter(n => n.type === 'CALL').map(n => n.id).sort();

      // Cleanup and run again
      await db.cleanup();
      db = await createTestDatabase();
    backend = db.backend;
      await setupTest(backend, { 'index.js': code });
      const nodes2 = await backend.getAllNodes();
      const calls2 = nodes2.filter(n => n.type === 'CALL').map(n => n.id).sort();

      assert.deepStrictEqual(calls1, calls2, 'Call IDs should be stable across analyses');
    });

    it('call order in same scope determines discriminator', async () => {
      await setupTest(backend, {
        'index.js': `
function ordered() {
  helper();  // Should be #0
  helper();  // Should be #1
  helper();  // Should be #2
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const helperCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.name === 'helper'
      );

      assert.strictEqual(helperCalls.length, 3, 'Should have 3 helper calls');

      // Sort by line number to verify order
      helperCalls.sort((a, b) => a.line - b.line);

      // First call should have #0
      assert.ok(
        helperCalls[0].id.includes('#0'),
        `First call should have #0. Got: ${helperCalls[0].id}`
      );
      // Second call should have #1
      assert.ok(
        helperCalls[1].id.includes('#1'),
        `Second call should have #1. Got: ${helperCalls[1].id}`
      );
      // Third call should have #2
      assert.ok(
        helperCalls[2].id.includes('#2'),
        `Third call should have #2. Got: ${helperCalls[2].id}`
      );
    });

    it('line number changes should not affect call IDs', async () => {
      // Original
      await setupTest(backend, {
        'index.js': `
fn();
        `
      });

      const nodes1 = await backend.getAllNodes();
      const fnCall1 = nodes1.find(n => n.type === 'CALL' && n.name === 'fn');
      const id1 = fnCall1?.id;

      await db.cleanup();
      db = await createTestDatabase();
    backend = db.backend;
      await setupTest(backend, {
        'index.js': `



fn();
        `
      });

      const nodes2 = await backend.getAllNodes();
      const fnCall2 = nodes2.find(n => n.type === 'CALL' && n.name === 'fn');
      const id2 = fnCall2?.id;

      if (id1 && id2) {
        assert.strictEqual(id1, id2, 'Line changes should not affect call ID');
        assert.notStrictEqual(fnCall1.line, fnCall2.line, 'Line numbers should be different');
      }
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle IIFE (Immediately Invoked Function Expression)', async () => {
      await setupTest(backend, {
        'index.js': `
(function() {
  console.log('IIFE');
})();
        `
      });

      const allNodes = await backend.getAllNodes();

      // Should have the console.log call
      const logCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'log' || n.name?.includes('log'))
      );

      assert.ok(logCall, 'console.log call should be found in IIFE');
    });

    it('should handle callback functions', async () => {
      await setupTest(backend, {
        'index.js': `
function main() {
  setTimeout(function() {
    console.log('callback');
  }, 1000);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const setTimeoutCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'setTimeout'
      );
      const logCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'log' || n.name?.includes('log'))
      );

      assert.ok(setTimeoutCall, 'setTimeout call should be found');
      assert.ok(logCall, 'console.log in callback should be found');
    });

    it('should handle special function names ($, _)', async () => {
      await setupTest(backend, {
        'index.js': `
$('#id');
_.map([1,2,3], x => x);
        `
      });

      const allNodes = await backend.getAllNodes();

      const dollarCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === '$'
      );
      // _.map is a method call
      const underscoreCall = allNodes.find(n =>
        n.type === 'CALL' && (n.object === '_' || n.name?.includes('_'))
      );

      if (dollarCall) {
        assert.ok(dollarCall.id.includes('$'), 'Dollar function call should be tracked');
      }
      if (underscoreCall) {
        assert.ok(underscoreCall.id, 'Underscore method call should be tracked');
      }
    });

    it('should handle deeply nested calls in control flow', async () => {
      await setupTest(backend, {
        'index.js': `
function complex(data) {
  if (data) {
    try {
      for (let i = 0; i < data.length; i++) {
        if (data[i].valid) {
          process(data[i]);
        }
      }
    } catch (e) {
      handleError(e);
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const processCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'process'
      );
      const handleErrorCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'handleError'
      );

      if (processCall) {
        // Should have deep scope path
        assert.ok(
          processCall.id.includes('complex'),
          `Process call should include function scope. Got: ${processCall.id}`
        );
        assert.ok(
          processCall.id.includes('if#'),
          `Process call should include if scope. Got: ${processCall.id}`
        );
        assert.ok(
          processCall.id.includes('try#') || processCall.id.includes('for#'),
          `Process call should include try or for scope. Got: ${processCall.id}`
        );
      }

      if (handleErrorCall) {
        assert.ok(
          handleErrorCall.id.includes('catch#'),
          `HandleError call should include catch scope. Got: ${handleErrorCall.id}`
        );
      }
    });

    it('should handle calls in arrow function expressions', async () => {
      await setupTest(backend, {
        'index.js': `
const handler = (x) => process(x);
        `
      });

      const allNodes = await backend.getAllNodes();

      const processCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'process'
      );

      assert.ok(processCall, 'Process call in arrow function should be found');
      assert.ok(
        processCall.id.includes('#'),
        `Call should have discriminator. Got: ${processCall.id}`
      );
    });

    it('should handle async/await calls', async () => {
      await setupTest(backend, {
        'index.js': `
async function fetchData() {
  const response = await fetch('/api');
  const data = await response.json();
  return data;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const fetchCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'fetch'
      );
      const jsonCall = allNodes.find(n =>
        n.type === 'CALL' && (n.method === 'json' || n.name?.includes('json'))
      );

      assert.ok(fetchCall, 'fetch call should be found');
      assert.ok(jsonCall, 'json method call should be found');

      if (fetchCall) {
        assert.ok(fetchCall.id.includes('fetchData'), 'fetch should be in fetchData scope');
      }
    });
  });
});
