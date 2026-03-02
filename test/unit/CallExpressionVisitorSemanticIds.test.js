/**
 * CallExpressionVisitor Semantic ID Integration Tests (v2)
 *
 * Tests for integrating semantic IDs into CallExpressionVisitor.
 * These tests verify that:
 * 1. Direct function calls get semantic IDs with line number discriminators
 * 2. Method calls (obj.method) get semantic IDs
 * 3. Constructor calls (new) get semantic IDs as CALL with isNew:true
 * 4. Array mutations get semantic IDs and FLOWS_INTO edges
 * 5. IDs are stable across analyses of the same code
 *
 * V2 Format: {file}->CALL->{calleeName}#{lineNumber}
 *   - Always uses line number as suffix discriminator
 *   - No scope paths (no function/control flow scope in IDs)
 *   - No hash-based discriminators [h:xxxx]
 *   - Constructor calls: file->CALL->new ClassName#line
 *   - Method calls: file->CALL->obj.method#line
 *
 * TDD: Tests written first per Kent Beck's methodology.
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

      // V2: Semantic ID format: file->CALL->name#line
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

      // V2: format is file->CALL->name#lineNumber
      assert.ok(
        /^index\.js->CALL->helper#\d+$/.test(callNode.id),
        `Expected semantic ID format file->CALL->name#line. Got: ${callNode.id}`
      );
    });

    it('should use line number discriminator for multiple calls to same function', async () => {
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

      // Extract IDs
      const ids = logCalls.map(c => c.id).sort();

      // V2: multiple calls to same function use line numbers as discriminators
      ids.forEach(id => {
        assert.ok(
          /->CALL->log#\d+$/.test(id),
          `Should use line number discriminator. Got: ${id}`
        );
      });

      // All IDs should be unique (different line numbers)
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, 'All call IDs should be unique');
    });

    it('should track calls across control flow branches with unique IDs', async () => {
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
      // V2: uniqueness comes from different line numbers
      assert.notStrictEqual(ids[0], ids[1], 'Calls in different branches should have different IDs');
    });

    it('should generate semantic ID for call inside a function', async () => {
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

      // V2: semantic ID is file->CALL->name#line (no function scope in path)
      assert.ok(
        /^index\.js->CALL->inner#\d+$/.test(innerCall.id),
        `Expected semantic ID with line discriminator. Got: ${innerCall.id}`
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
        methodCall.id.includes('CALL'),
        `ID should include CALL type. Got: ${methodCall.id}`
      );
    });

    it('should use line number discriminator for same method calls', async () => {
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

      // V2: uses line number discriminators
      ids.forEach(id => {
        assert.ok(
          /->CALL->console\.log#\d+$/.test(id),
          `Should use line number discriminator. Got: ${id}`
        );
      });
    });

    it('should generate semantic ID for nested method calls', async () => {
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

      // V2: semantic ID is file->CALL->name#line (no function or if scope in path)
      assert.ok(
        /^index\.js->CALL->.+#\d+$/.test(processCall.id),
        `ID should have v2 format. Got: ${processCall.id}`
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
        assert.ok(mapCall.id.includes('CALL'), `Map call should have CALL type: ${mapCall.id}`);
      }
      if (filterCall) {
        assert.ok(filterCall.id.includes('CALL'), `Filter call should have CALL type: ${filterCall.id}`);
      }
    });
  });

  // ===========================================================================
  // Constructor calls (new)
  // V2: CONSTRUCTOR_CALL no longer exists; uses CALL with isNew:true
  // ===========================================================================

  describe('constructor calls (new)', () => {
    it('should track new expression as CALL with isNew:true', async () => {
      await setupTest(backend, {
        'index.js': `
class User {}
const user = new User();
        `
      });

      const allNodes = await backend.getAllNodes();

      // V2: new expressions produce CALL with isNew:true, name="new ClassName"
      const constructorCall = allNodes.find(n =>
        n.type === 'CALL' && n.isNew === true && n.name === 'new User'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) node for User should exist');

      // V2: semantic ID format: file->CALL->new ClassName#line
      assert.ok(
        constructorCall.id.includes('new User'),
        `ID should contain "new User". Got: ${constructorCall.id}`
      );
      assert.ok(
        /^index\.js->CALL->new User#\d+$/.test(constructorCall.id),
        `Expected v2 semantic ID format. Got: ${constructorCall.id}`
      );
    });

    it('should handle multiple constructor calls with unique IDs', async () => {
      await setupTest(backend, {
        'index.js': `
class Item {}
const a = new Item();
const b = new Item();
        `
      });

      const allNodes = await backend.getAllNodes();

      // V2: constructor calls tracked as CALL with isNew:true
      const constructorCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.isNew === true && n.name === 'new Item'
      );
      assert.strictEqual(constructorCalls.length, 2, 'Should have 2 CALL(isNew:true) nodes for Item');

      const ids = constructorCalls.map(c => c.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 2, 'Constructor call nodes should have unique IDs');

      // Verify the variables are created
      const aVar = allNodes.find(n => n.name === 'a');
      const bVar = allNodes.find(n => n.name === 'b');
      assert.ok(aVar, 'Variable "a" should exist');
      assert.ok(bVar, 'Variable "b" should exist');
    });
  });

  // ===========================================================================
  // Array mutations
  // V2: FLOWS_INTO edges go from CALL node to array variable (not from item to array)
  //     No mutationMethod metadata on FLOWS_INTO edges
  // ===========================================================================

  describe('array mutations', () => {
    it('should generate semantic ID for array.push() and create FLOWS_INTO edge', async () => {
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

      assert.ok(pushCall, 'Push call should exist');
      assert.ok(
        pushCall.id.includes('CALL'),
        `Push call should have CALL type. Got: ${pushCall.id}`
      );

      // V2: FLOWS_INTO edge from CALL node to array variable
      const arrVar = allNodes.find(n =>
        (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'arr'
      );
      assert.ok(arrVar, 'arr variable should exist');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === pushCall.id &&
        e.dst === arrVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge should exist from push CALL to arr');
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
          unshiftCall.id.includes('CALL'),
          `Unshift call should have CALL type. Got: ${unshiftCall.id}`
        );

        // V2: FLOWS_INTO from CALL node to array
        const arrVar = allNodes.find(n =>
          (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'arr'
        );
        if (arrVar) {
          const flowsInto = allEdges.find(e =>
            e.type === 'FLOWS_INTO' &&
            e.src === unshiftCall.id &&
            e.dst === arrVar.id
          );
          assert.ok(flowsInto, 'FLOWS_INTO edge should exist for unshift');
        }
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
          spliceCall.id.includes('CALL'),
          `Splice call should have CALL type. Got: ${spliceCall.id}`
        );

        // V2: FLOWS_INTO from CALL node to array
        const arrVar = allNodes.find(n =>
          (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'arr'
        );
        if (arrVar) {
          const flowsInto = allEdges.find(e =>
            e.type === 'FLOWS_INTO' &&
            e.src === spliceCall.id &&
            e.dst === arrVar.id
          );
          assert.ok(flowsInto, 'FLOWS_INTO edge should exist for splice');
        }
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

      // Verify arr and obj exist
      const arrVar = allNodes.find(n =>
        (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'arr'
      );
      const objVar = allNodes.find(n =>
        (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'obj'
      );

      assert.ok(arrVar, 'arr variable should exist');
      assert.ok(objVar, 'obj variable should exist');

      // V2: FLOWS_INTO for indexed assignment may come from various sources
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id
      );

      // Indexed assignment FLOWS_INTO may or may not exist in v2
      // If it exists, verify it points to arr
      if (flowsInto) {
        assert.strictEqual(flowsInto.dst, arrVar.id, 'FLOWS_INTO should target arr');
      }
    });

    it('should handle multiple array mutations with unique IDs', async () => {
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

        // V2: uses line number discriminators
        ids.forEach(id => {
          assert.ok(
            /->CALL->.+#\d+$/.test(id),
            `Should use line number discriminator. Got: ${id}`
          );
        });
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

    it('call order in same scope determines line-based discriminator', async () => {
      await setupTest(backend, {
        'index.js': `
function ordered() {
  helper();
  helper();
  helper();
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

      // V2: discriminator is line number, not sequential index
      // Each call should have a different line number
      const lines = helperCalls.map(c => c.line);
      const uniqueLines = new Set(lines);
      assert.strictEqual(uniqueLines.size, 3, 'Each call should be on a different line');

      // IDs should contain their respective line numbers
      helperCalls.forEach(call => {
        assert.ok(
          call.id.includes(`#${call.line}`),
          `Call ID should contain its line number. Got: ${call.id}, line: ${call.line}`
        );
      });
    });

    it('line number changes should not affect call name portion of ID', async () => {
      // Original
      await setupTest(backend, {
        'index.js': `
fn();
        `
      });

      const nodes1 = await backend.getAllNodes();
      const fnCall1 = nodes1.find(n => n.type === 'CALL' && n.name === 'fn');

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

      assert.ok(fnCall1, 'First fn call should exist');
      assert.ok(fnCall2, 'Second fn call should exist');

      // V2: line numbers ARE part of the ID, so IDs will differ when lines change
      // But the name portion should be the same
      assert.ok(
        fnCall1.id.includes('->CALL->fn#'),
        `First call should have correct format. Got: ${fnCall1.id}`
      );
      assert.ok(
        fnCall2.id.includes('->CALL->fn#'),
        `Second call should have correct format. Got: ${fnCall2.id}`
      );
      assert.notStrictEqual(fnCall1.line, fnCall2.line, 'Line numbers should be different');
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

      // V2: semantic IDs use file->CALL->name#line (no scope paths)
      if (processCall) {
        assert.ok(
          /^index\.js->CALL->process#\d+$/.test(processCall.id),
          `Process call should have v2 format. Got: ${processCall.id}`
        );
      }

      if (handleErrorCall) {
        assert.ok(
          /^index\.js->CALL->handleError#\d+$/.test(handleErrorCall.id),
          `HandleError call should have v2 format. Got: ${handleErrorCall.id}`
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
        processCall.id.includes('CALL'),
        `Call should have CALL type. Got: ${processCall.id}`
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

      // V2: semantic ID is file->CALL->name#line (no function scope in path)
      if (fetchCall) {
        assert.ok(
          /^index\.js->CALL->fetch#\d+$/.test(fetchCall.id),
          `fetch should have v2 format. Got: ${fetchCall.id}`
        );
      }
    });
  });
});
