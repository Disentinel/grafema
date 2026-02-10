/**
 * Callback Function Reference Resolution Tests
 *
 * Tests that when a named function (declaration or const-bound arrow) is passed
 * as an argument to another function or method, Grafema creates the correct edges:
 *
 * 1. CALLS edge: CALL/METHOD_CALL -> FUNCTION (callback is called indirectly)
 * 2. PASSES_ARGUMENT edge: CALL/METHOD_CALL -> FUNCTION (the function ref is an argument)
 *
 * These tests cover:
 * - Same-file function declarations as callbacks (forEach, map, filter, etc.)
 * - Const-bound arrow functions as callbacks
 * - Multiple HOF patterns referencing the same function
 * - setTimeout/setInterval with named function references
 * - Custom higher-order functions
 * - Scope shadowing (inner function preferred over outer)
 * - Inline callbacks (regression: HAS_CALLBACK still works)
 * - Non-callable arguments (regression: no CALLS edge to literals)
 * - PASSES_ARGUMENT for function declarations (was missing before)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files, analyze, and return backend.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-callback-ref-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json required for project discovery
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-callback-ref-${testCounter}`,
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

describe('Callback Function Reference Resolution', () => {
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
  // 1. Same-file function declaration as callback
  // ============================================================================
  describe('Same-file function declaration as callback', () => {
    it('should create CALLS edge from forEach METHOD_CALL to handler FUNCTION', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 1; }
const arr = [1, 2];
arr.forEach(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the handler function
      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node');

      // Find the forEach method call
      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node');

      // Check CALLS edge from forEach to handler
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === forEachCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        callsEdge,
        `Should have CALLS edge from forEach (${forEachCall.id}) to handler (${handlerFunc.id})`
      );
    });
  });

  // ============================================================================
  // 2. Const-bound arrow function as callback
  // ============================================================================
  describe('Const-bound arrow function as callback', () => {
    it('should create CALLS edge from map METHOD_CALL to const-bound handler', async () => {
      await setupTest(backend, {
        'index.js': `
const handler = () => { return 1; };
const arr = [1, 2];
arr.map(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the handler function (const-bound arrow)
      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node (const-bound arrow)');

      // Find the map method call
      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'map'
      );
      assert.ok(mapCall, 'Should find map CALL node');

      // Check CALLS edge from map to handler
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === mapCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        callsEdge,
        `Should have CALLS edge from map (${mapCall.id}) to handler (${handlerFunc.id})`
      );
    });
  });

  // ============================================================================
  // 3. Multiple HOF patterns referencing the same function
  // ============================================================================
  describe('Multiple HOF patterns', () => {
    it('should create 3 CALLS edges all pointing to process FUNCTION', async () => {
      await setupTest(backend, {
        'index.js': `
function process(x) { return x * 2; }
const arr = [1, 2, 3];
arr.forEach(process);
arr.map(process);
arr.filter(process);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the process function
      const processFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'process'
      );
      assert.ok(processFunc, 'Should find process FUNCTION node');

      // Find all three method calls
      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'map'
      );
      const filterCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'filter'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node');
      assert.ok(mapCall, 'Should find map CALL node');
      assert.ok(filterCall, 'Should find filter CALL node');

      // Check CALLS edges from all three to process
      const callsEdges = allEdges.filter(e =>
        e.type === 'CALLS' && e.dst === processFunc.id
      );

      // All three method calls should have CALLS edges to process
      const callSources = new Set(callsEdges.map(e => e.src));
      assert.ok(
        callSources.has(forEachCall.id),
        `forEach should have CALLS edge to process`
      );
      assert.ok(
        callSources.has(mapCall.id),
        `map should have CALLS edge to process`
      );
      assert.ok(
        callSources.has(filterCall.id),
        `filter should have CALLS edge to process`
      );

      assert.ok(
        callsEdges.length >= 3,
        `Should have at least 3 CALLS edges to process, got ${callsEdges.length}`
      );
    });
  });

  // ============================================================================
  // 4. setTimeout/setInterval with named function
  // ============================================================================
  describe('setTimeout/setInterval', () => {
    it('should create CALLS edge from setTimeout CALL to tick FUNCTION', async () => {
      await setupTest(backend, {
        'index.js': `
function tick() { console.log('tick'); }
setTimeout(tick, 1000);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the tick function
      const tickFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'tick'
      );
      assert.ok(tickFunc, 'Should find tick FUNCTION node');

      // Find the setTimeout call (it's a direct call, not a method call)
      const setTimeoutCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'setTimeout'
      );
      assert.ok(setTimeoutCall, 'Should find setTimeout CALL node');

      // Check CALLS edge from setTimeout to tick
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === setTimeoutCall.id && e.dst === tickFunc.id
      );
      assert.ok(
        callsEdge,
        `Should have CALLS edge from setTimeout (${setTimeoutCall.id}) to tick (${tickFunc.id})`
      );
    });
  });

  // ============================================================================
  // 5. Custom higher-order function
  // ============================================================================
  describe('Custom higher-order function', () => {
    it('should create CALLS edge from myHOF CALL to myHOF FUNCTION (direct call) but NOT callback CALLS', async () => {
      await setupTest(backend, {
        'index.js': `
function callback() { return true; }
function myHOF(fn) { return fn(); }
myHOF(callback);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find both functions
      const callbackFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'callback'
      );
      const myHOFFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'myHOF'
      );
      assert.ok(callbackFunc, 'Should find callback FUNCTION node');
      assert.ok(myHOFFunc, 'Should find myHOF FUNCTION node');

      // Find the myHOF call site
      const myHOFCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'myHOF' && !n.object
      );
      assert.ok(myHOFCall, 'Should find myHOF CALL node');

      // CALLS edge from myHOF call to myHOF function (direct call resolution)
      const directCallEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === myHOFCall.id && e.dst === myHOFFunc.id
      );
      assert.ok(
        directCallEdge,
        'Should have CALLS edge from myHOF CALL to myHOF FUNCTION (direct call)'
      );

      // NO callback CALLS edge: myHOF is not a known HOF (whitelist-based verification)
      // Prevents false positives for store/register patterns
      const callbackCallEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === myHOFCall.id && e.dst === callbackFunc.id
      );
      assert.ok(
        !callbackCallEdge,
        'Should NOT have callback CALLS edge for unknown HOF (whitelist-based verification)'
      );
    });

    it('should create PASSES_ARGUMENT edge from myHOF CALL to callback FUNCTION', async () => {
      await setupTest(backend, {
        'index.js': `
function callback() { return true; }
function myHOF(fn) { return fn(); }
myHOF(callback);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const callbackFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'callback'
      );
      const myHOFCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'myHOF' && !n.object
      );
      assert.ok(callbackFunc, 'Should find callback FUNCTION node');
      assert.ok(myHOFCall, 'Should find myHOF CALL node');

      // PASSES_ARGUMENT edge from myHOF call to callback function
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === myHOFCall.id && e.dst === callbackFunc.id
      );
      assert.ok(
        passesArgEdge,
        'Should have PASSES_ARGUMENT edge from myHOF CALL to callback FUNCTION'
      );
    });
  });

  // ============================================================================
  // 6. Scope shadowing - inner function preferred (direct call)
  // ============================================================================
  describe('Scope shadowing', () => {
    it('should create CALLS edge from direct call to INNER handler (not outer)', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 'outer'; }
function setup() {
  function handler() { return 'inner'; }
  handler();
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find both handler functions
      const handlerFuncs = allNodes.filter(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      assert.ok(
        handlerFuncs.length >= 2,
        `Should find at least 2 handler FUNCTION nodes, found ${handlerFuncs.length}`
      );

      // The inner handler should be in the scope of setup
      // Its semantic ID should include 'setup' in the scope path
      const innerHandler = handlerFuncs.find(f => f.id.includes('setup'));
      const outerHandler = handlerFuncs.find(f => !f.id.includes('setup'));
      assert.ok(innerHandler, 'Should find inner handler (scope includes "setup")');
      assert.ok(outerHandler, 'Should find outer handler (scope does not include "setup")');

      // Find the handler() call (inside setup)
      const handlerCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'handler' && n.id.includes('setup')
      );
      assert.ok(handlerCall, 'Should find handler CALL node inside setup');

      // CALLS edge should point to inner handler, not outer
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === handlerCall.id
      );
      assert.ok(callsEdge, 'Should have CALLS edge from handler() call');
      assert.strictEqual(
        callsEdge.dst,
        innerHandler.id,
        `CALLS edge should point to inner handler (${innerHandler.id}), not outer (${outerHandler.id}). Got: ${callsEdge.dst}`
      );
    });
  });

  // ============================================================================
  // 7. Inline callback still works (regression)
  // ============================================================================
  describe('Inline callback (regression)', () => {
    it('should create HAS_CALLBACK edge for inline arrow function', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2];
arr.forEach(() => { console.log('inline'); });
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the forEach call
      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node');

      // Find the inline arrow function
      const inlineFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && !n.name && n.file?.includes('index.js')
      );

      // HAS_CALLBACK edge should exist for inline callbacks
      const hasCallbackEdge = allEdges.find(e =>
        e.type === 'HAS_CALLBACK' && e.src === forEachCall.id
      );
      assert.ok(
        hasCallbackEdge,
        'Should have HAS_CALLBACK edge from forEach to inline function'
      );

      // PASSES_ARGUMENT should also be created for the inline function
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === forEachCall.id &&
        e.dst !== undefined
      );
      assert.ok(
        passesArgEdge,
        'Should have PASSES_ARGUMENT edge from forEach for the inline callback'
      );
    });
  });

  // ============================================================================
  // 8. Non-callable argument (regression)
  // ============================================================================
  describe('Non-callable argument (regression)', () => {
    it('should not create CALLS edge to literal argument', async () => {
      await setupTest(backend, {
        'index.js': `
function fn(x) { return x; }
fn(42);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find fn function
      const fnFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'fn'
      );
      assert.ok(fnFunc, 'Should find fn FUNCTION node');

      // Find fn call
      const fnCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'fn' && !n.object
      );
      assert.ok(fnCall, 'Should find fn CALL node');

      // CALLS edge should point to fn function (direct call)
      const directCallEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === fnCall.id && e.dst === fnFunc.id
      );
      assert.ok(directCallEdge, 'Should have CALLS edge from fn call to fn function');

      // Find the literal node for 42
      const literal42 = allNodes.find(n =>
        n.type === 'LITERAL' && n.value === 42
      );

      // PASSES_ARGUMENT should point to the literal
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === fnCall.id
      );
      assert.ok(passesArgEdge, 'Should have PASSES_ARGUMENT edge from fn call');

      if (literal42) {
        assert.strictEqual(
          passesArgEdge.dst,
          literal42.id,
          'PASSES_ARGUMENT should point to LITERAL(42)'
        );
      }

      // No CALLS edge should point to the literal
      const callsToLiteral = allEdges.filter(e =>
        e.type === 'CALLS' && e.src === fnCall.id && literal42 && e.dst === literal42.id
      );
      assert.strictEqual(
        callsToLiteral.length,
        0,
        'Should NOT have CALLS edge to literal 42'
      );
    });
  });

  // ============================================================================
  // 9. Function passed to multiple HOFs
  // ============================================================================
  describe('Function passed to multiple HOFs', () => {
    it('should create 2 CALLS edges both pointing to handler FUNCTION', async () => {
      await setupTest(backend, {
        'index.js': `
function handler(x) { return x > 0; }
const a = [1, 2, 3];
a.filter(handler);
a.find(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find handler function
      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node');

      // Find filter and find method calls
      const filterCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'filter'
      );
      const findCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'find'
      );
      assert.ok(filterCall, 'Should find filter CALL node');
      assert.ok(findCall, 'Should find find CALL node');

      // Both should have CALLS edges to handler
      const filterCallsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === filterCall.id && e.dst === handlerFunc.id
      );
      const findCallsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === findCall.id && e.dst === handlerFunc.id
      );

      assert.ok(
        filterCallsEdge,
        `filter should have CALLS edge to handler`
      );
      assert.ok(
        findCallsEdge,
        `find should have CALLS edge to handler`
      );
    });
  });

  // ============================================================================
  // 10. Cross-file imported function as callback (enrichment phase)
  // ============================================================================
  describe('Cross-file imported function as callback', () => {
    it('should create CALLS edge from forEach to imported handler via CallbackCallResolver', async () => {
      await setupTest(backend, {
        'utils.js': `
export function handler(x) { return x * 2; }
`,
        'index.js': `
import { handler } from './utils.js';
const arr = [1, 2, 3];
arr.forEach(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the handler function in utils.js
      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler' && n.file?.includes('utils.js')
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node in utils.js');

      // Find the forEach method call in index.js
      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node in index.js');

      // Check CALLS edge from forEach to handler (created by CallbackCallResolver)
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === forEachCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        callsEdge,
        `Should have CALLS edge from forEach (${forEachCall.id}) to imported handler (${handlerFunc.id}). ` +
        `This tests the CallbackCallResolver enrichment plugin cross-file resolution.`
      );

      // Should also have PASSES_ARGUMENT from forEach to IMPORT node
      const importNode = allNodes.find(n =>
        n.type === 'IMPORT' && n.name === 'handler' && n.file?.includes('index.js')
      );
      assert.ok(importNode, 'Should find handler IMPORT node in index.js');

      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === forEachCall.id && e.dst === importNode.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from forEach to IMPORT node`
      );
    });
  });

  // ============================================================================
  // 11. PASSES_ARGUMENT for function declaration (was missing before)
  // ============================================================================
  describe('PASSES_ARGUMENT for function declaration', () => {
    it('should create PASSES_ARGUMENT edge from forEach to callback FUNCTION', async () => {
      await setupTest(backend, {
        'index.js': `
function callback() {}
const arr = [1];
arr.forEach(callback);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find callback function
      const callbackFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'callback'
      );
      assert.ok(callbackFunc, 'Should find callback FUNCTION node');

      // Find forEach call
      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node');

      // PASSES_ARGUMENT edge should exist from forEach to callback function
      // This was missing before because function declarations weren't in variableDeclarations
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === forEachCall.id && e.dst === callbackFunc.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from forEach (${forEachCall.id}) to callback FUNCTION (${callbackFunc.id}). ` +
        `This tests that function declarations are resolved as PASSES_ARGUMENT targets.`
      );

      // CALLS edge should also exist
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === forEachCall.id && e.dst === callbackFunc.id
      );
      assert.ok(
        callsEdge,
        `Should also have CALLS edge from forEach to callback FUNCTION`
      );
    });
  });

  // ============================================================================
  // 12. Store/register pattern — no false-positive CALLS edge
  // ============================================================================
  describe('Store/register pattern (false positive prevention)', () => {
    it('should NOT create callback CALLS edge for unknown function (store pattern)', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 42; }
function register(fn) { globalRegistry.push(fn); }
register(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      const registerCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'register' && !n.object
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node');
      assert.ok(registerCall, 'Should find register CALL node');

      // PASSES_ARGUMENT should exist (function reference IS an argument)
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === registerCall.id && e.dst === handlerFunc.id
      );
      assert.ok(passesArgEdge, 'Should have PASSES_ARGUMENT edge (function IS an argument)');

      // But NO callback CALLS edge — register is not a known HOF
      const callbackCallsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === registerCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        !callbackCallsEdge,
        'Should NOT have callback CALLS edge for register() — not a known HOF'
      );
    });
  });
});
