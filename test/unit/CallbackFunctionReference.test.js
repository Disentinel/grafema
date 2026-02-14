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
    it('should create callback CALLS edge from myHOF CALL to callback FUNCTION (REG-401: user-defined HOF)', async () => {
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

      // REG-401: Callback CALLS edge SHOULD now exist because myHOF invokes its parameter fn
      // Analysis detects fn() inside myHOF body, enricher creates callback CALLS edge
      const callbackCallEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === myHOFCall.id && e.dst === callbackFunc.id
      );
      assert.ok(
        callbackCallEdge,
        'Should have callback CALLS edge from myHOF CALL to callback FUNCTION (REG-401: parameter invocation detected)'
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

  // ============================================================================
  // 10. Function-level method calls (inside function bodies)
  // ============================================================================
  describe('Function-level callback resolution', () => {
    it('should create CALLS edge for forEach(fn) inside a function body', async () => {
      await setupTest(backend, {
        'index.js': `
function invokeCleanup(hook) {
  if (typeof hook._cleanup === 'function') hook._cleanup();
}

function unmount(component) {
  component.hooks.forEach(invokeCleanup);
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const cleanupFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'invokeCleanup'
      );
      assert.ok(cleanupFunc, 'Should find invokeCleanup FUNCTION node');

      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node inside unmount()');

      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === forEachCall.id && e.dst === cleanupFunc.id
      );
      assert.ok(
        callsEdge,
        `Should have CALLS edge from forEach (${forEachCall?.id}) to invokeCleanup (${cleanupFunc?.id})`
      );
    });

    it('should create CALLS edge for nested member forEach(fn) inside a function body', async () => {
      await setupTest(backend, {
        'index.js': `
function invokeEffect(hook) {
  hook._effect();
}

function flushEffects(component) {
  component.__hooks._pendingEffects.forEach(invokeEffect);
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const effectFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'invokeEffect'
      );
      assert.ok(effectFunc, 'Should find invokeEffect FUNCTION node');

      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node (nested member)');

      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === forEachCall.id && e.dst === effectFunc.id
      );
      assert.ok(
        callsEdge,
        `Should have CALLS edge from nested forEach (${forEachCall?.id}) to invokeEffect (${effectFunc?.id})`
      );
    });

    it('should create CALLS edge for map(fn) inside a function body', async () => {
      await setupTest(backend, {
        'index.js': `
function double(x) { return x * 2; }

function processItems(items) {
  return items.map(double);
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const doubleFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'double'
      );
      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'map'
      );
      assert.ok(doubleFunc, 'Should find double FUNCTION node');
      assert.ok(mapCall, 'Should find map CALL node');

      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === mapCall.id && e.dst === doubleFunc.id
      );
      assert.ok(
        callsEdge,
        `Should have CALLS edge from map to double inside function body`
      );
    });

    it('should NOT create CALLS edge for non-HOF method calls inside function body', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 1; }

function setup() {
  registry.register(handler);
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      const registerCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'register'
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node');
      assert.ok(registerCall, 'Should find register CALL node');

      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === registerCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        !callsEdge,
        'Should NOT have CALLS edge for register() — not a known HOF'
      );
    });
  });

  // ============================================================================
  // REG-401: User-defined HOF — multiple params, only one invoked
  // ============================================================================
  describe('User-defined HOF: multiple params, only one invoked (REG-401)', () => {
    it('should create callback CALLS edge only for the invoked param', async () => {
      await setupTest(backend, {
        'index.js': `
function doWork() { return 42; }
function storeIt() { return 'stored'; }
function myExecutor(fn, logger) { return fn(); }
myExecutor(doWork, storeIt);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const doWorkFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'doWork'
      );
      const storeItFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'storeIt'
      );
      const myExecutorCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'myExecutor' && !n.object
      );
      assert.ok(doWorkFunc, 'Should find doWork FUNCTION node');
      assert.ok(storeItFunc, 'Should find storeIt FUNCTION node');
      assert.ok(myExecutorCall, 'Should find myExecutor CALL node');

      // fn (param index 0) is invoked — should have callback CALLS edge to doWork
      const callbackEdgeToDoWork = allEdges.find(e =>
        e.type === 'CALLS' && e.src === myExecutorCall.id && e.dst === doWorkFunc.id
      );
      assert.ok(
        callbackEdgeToDoWork,
        'Should have callback CALLS edge to doWork (param index 0 is invoked)'
      );

      // logger (param index 1) is NOT invoked — should NOT have callback CALLS edge to storeIt
      const callbackEdgeToStoreIt = allEdges.find(e =>
        e.type === 'CALLS' && e.src === myExecutorCall.id && e.dst === storeItFunc.id
      );
      assert.ok(
        !callbackEdgeToStoreIt,
        'Should NOT have callback CALLS edge to storeIt (param index 1 is not invoked)'
      );
    });
  });

  // ============================================================================
  // REG-401: Store/register pattern — no parameter invocation detected
  // ============================================================================
  describe('Store pattern: no parameter invocation (REG-401)', () => {
    it('should NOT create callback CALLS edge when function stores param without calling it', async () => {
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
      assert.ok(passesArgEdge, 'Should have PASSES_ARGUMENT edge');

      // NO callback CALLS edge: register does NOT invoke fn (only pushes it)
      const callbackCallsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === registerCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        !callbackCallsEdge,
        'Should NOT have callback CALLS edge — register stores fn, does not invoke it'
      );
    });
  });

  // ============================================================================
  // REG-402: Method reference callbacks (this.method)
  // ============================================================================
  describe('Method reference callbacks (this.method) [REG-402]', () => {
    it('should create CALLS edge from forEach to this.handler in class', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {
  handler(item) { return item * 2; }

  process(arr) {
    arr.forEach(this.handler);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the handler function (class method)
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

    it('should create PASSES_ARGUMENT edge from map to this.handler', async () => {
      await setupTest(backend, {
        'index.js': `
class Processor {
  transform(x) { return x + 1; }

  run(items) {
    return items.map(this.transform);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const transformFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'transform'
      );
      assert.ok(transformFunc, 'Should find transform FUNCTION node');

      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'map'
      );
      assert.ok(mapCall, 'Should find map CALL node');

      // PASSES_ARGUMENT edge
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === mapCall.id && e.dst === transformFunc.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from map (${mapCall.id}) to transform (${transformFunc.id})`
      );

      // CALLS edge too
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === mapCall.id && e.dst === transformFunc.id
      );
      assert.ok(
        callsEdge,
        `Should have CALLS edge from map (${mapCall.id}) to transform (${transformFunc.id})`
      );
    });

    it('should handle multiple methods in same class used as callbacks', async () => {
      await setupTest(backend, {
        'index.js': `
class Pipeline {
  validate(item) { return item != null; }
  transform(item) { return item * 2; }

  run(data) {
    const valid = data.filter(this.validate);
    return valid.map(this.transform);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const validateFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'validate'
      );
      const transformFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'transform'
      );
      assert.ok(validateFunc, 'Should find validate FUNCTION node');
      assert.ok(transformFunc, 'Should find transform FUNCTION node');

      const filterCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'filter'
      );
      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'map'
      );
      assert.ok(filterCall, 'Should find filter CALL node');
      assert.ok(mapCall, 'Should find map CALL node');

      // filter -> validate (use any filter CALL node — inline duplicates may exist)
      const filterCallIds = new Set(allNodes.filter(n => n.type === 'CALL' && n.method === 'filter').map(n => n.id));
      const filterCallsEdge = allEdges.find(e =>
        e.type === 'CALLS' && filterCallIds.has(e.src) && e.dst === validateFunc.id
      );
      assert.ok(filterCallsEdge, 'filter should have CALLS edge to validate');

      // map -> transform (use any map CALL node)
      const mapCallIds = new Set(allNodes.filter(n => n.type === 'CALL' && n.method === 'map').map(n => n.id));
      const mapCallsEdge = allEdges.find(e =>
        e.type === 'CALLS' && mapCallIds.has(e.src) && e.dst === transformFunc.id
      );
      assert.ok(mapCallsEdge, 'map should have CALLS edge to transform');
    });

    it('should NOT create CALLS edge for this.handler in non-HOF', async () => {
      await setupTest(backend, {
        'index.js': `
class Service {
  handler() { return 42; }

  register() {
    registry.add(this.handler);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      const addCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'add'
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node');
      assert.ok(addCall, 'Should find add CALL node');

      // No CALLS edge (add is not a known HOF)
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === addCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        !callsEdge,
        'Should NOT have CALLS edge for add() — not a known HOF'
      );
    });

    it('should NOT create CALLS edge for obj.method (out of scope)', async () => {
      await setupTest(backend, {
        'index.js': `
function process(items, parser) {
  items.forEach(parser.parse);
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node');

      // No callback CALLS edge for obj.method (can't resolve without type info)
      const callbackCallsEdges = allEdges.filter(e =>
        e.type === 'CALLS' && e.src === forEachCall.id &&
        e.metadata?.callType === 'callback'
      );
      assert.strictEqual(
        callbackCallsEdges.length,
        0,
        'Should NOT have callback CALLS edge for parser.parse — no type info available'
      );
    });
  });

  // ============================================================================
  // REG-417: Destructured and rest parameter invocation detection
  // ============================================================================

  // Analysis-time detection: verify invokesParamIndexes metadata is set
  // correctly for destructured parameters. End-to-end callback CALLS edge
  // resolution for destructured params requires the enricher to resolve
  // through object/array literals at call sites — tracked separately.

  describe('Destructured param invocation metadata (ObjectPattern) [REG-417]', () => {
    it('should set invokesParamIndexes on FUNCTION when destructured param binding is called', async () => {
      await setupTest(backend, {
        'index.js': `
function apply({ fn }) { fn(); }
`
      });

      const allNodes = await backend.getAllNodes();

      const applyFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'apply'
      );
      assert.ok(applyFunc, 'Should find apply FUNCTION node');

      // fn() inside body should detect param index 0 as invoked
      const invokesIndexes = applyFunc.invokesParamIndexes ?? applyFunc.metadata?.invokesParamIndexes;
      assert.ok(
        Array.isArray(invokesIndexes) && invokesIndexes.includes(0),
        `apply FUNCTION should have invokesParamIndexes containing 0, got: ${JSON.stringify(invokesIndexes)}`
      );
    });
  });

  describe('Destructured param invocation metadata (nested ObjectPattern) [REG-417]', () => {
    it('should set invokesParamIndexes for deeply nested destructured param', async () => {
      await setupTest(backend, {
        'index.js': `
function execute({ callbacks: { onSuccess } }) { onSuccess(); }
`
      });

      const allNodes = await backend.getAllNodes();

      const executeFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'execute'
      );
      assert.ok(executeFunc, 'Should find execute FUNCTION node');

      const invokesIndexes = executeFunc.invokesParamIndexes ?? executeFunc.metadata?.invokesParamIndexes;
      assert.ok(
        Array.isArray(invokesIndexes) && invokesIndexes.includes(0),
        `execute FUNCTION should have invokesParamIndexes containing 0, got: ${JSON.stringify(invokesIndexes)}`
      );
    });
  });

  describe('Array destructured param invocation metadata (ArrayPattern) [REG-417]', () => {
    it('should set invokesParamIndexes for array-destructured param binding', async () => {
      await setupTest(backend, {
        'index.js': `
function runFirst([fn]) { fn(); }
`
      });

      const allNodes = await backend.getAllNodes();

      const runFirstFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'runFirst'
      );
      assert.ok(runFirstFunc, 'Should find runFirst FUNCTION node');

      const invokesIndexes = runFirstFunc.invokesParamIndexes ?? runFirstFunc.metadata?.invokesParamIndexes;
      assert.ok(
        Array.isArray(invokesIndexes) && invokesIndexes.includes(0),
        `runFirst FUNCTION should have invokesParamIndexes containing 0, got: ${JSON.stringify(invokesIndexes)}`
      );
    });
  });

  describe('Rest param array access invocation [REG-417]', () => {
    it('should create callback CALLS edge for rest param invoked via member expression', async () => {
      await setupTest(backend, {
        'index.js': `
function applyAll(...fns) { fns[0](); }
function step1() { return 1; }
applyAll(step1);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const applyAllFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'applyAll'
      );
      assert.ok(applyAllFunc, 'Should find applyAll FUNCTION node');

      const step1Func = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'step1'
      );
      assert.ok(step1Func, 'Should find step1 FUNCTION node');

      const applyAllCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'applyAll' && !n.object
      );
      assert.ok(applyAllCall, 'Should find applyAll CALL node');

      // RestElement param ...fns, invoked via fns[0]()
      // End-to-end: individual args are passed via PASSES_ARGUMENT at their argIndex,
      // so step1 at argIndex 0 resolves directly to a FUNCTION node
      const callbackCallsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === applyAllCall.id && e.dst === step1Func.id
      );
      assert.ok(
        callbackCallsEdge,
        `Should have callback CALLS edge from applyAll CALL (${applyAllCall.id}) to step1 FUNCTION (${step1Func.id})`
      );
    });
  });

  describe('Destructured param NOT invoked (stored, not called) [REG-417]', () => {
    it('should NOT set invokesParamIndexes when destructured param is stored, not called', async () => {
      await setupTest(backend, {
        'index.js': `
function storeHandler({ fn }) { registry.push(fn); }
`
      });

      const allNodes = await backend.getAllNodes();

      const storeHandlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'storeHandler'
      );
      assert.ok(storeHandlerFunc, 'Should find storeHandler FUNCTION node');

      // fn is referenced but NOT called — should NOT have invokesParamIndexes
      const invokesIndexes = storeHandlerFunc.invokesParamIndexes ?? storeHandlerFunc.metadata?.invokesParamIndexes;
      assert.ok(
        !invokesIndexes || (Array.isArray(invokesIndexes) && invokesIndexes.length === 0),
        `storeHandler should NOT have invokesParamIndexes, got: ${JSON.stringify(invokesIndexes)}`
      );
    });
  });

  describe('Default-with-destructuring param invocation metadata [REG-417]', () => {
    it('should set invokesParamIndexes for destructured param with default value', async () => {
      await setupTest(backend, {
        'index.js': `
function withDefaults({ fn } = {}) { fn(); }
`
      });

      const allNodes = await backend.getAllNodes();

      const withDefaultsFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'withDefaults'
      );
      assert.ok(withDefaultsFunc, 'Should find withDefaults FUNCTION node');

      const invokesIndexes = withDefaultsFunc.invokesParamIndexes ?? withDefaultsFunc.metadata?.invokesParamIndexes;
      assert.ok(
        Array.isArray(invokesIndexes) && invokesIndexes.includes(0),
        `withDefaults FUNCTION should have invokesParamIndexes containing 0, got: ${JSON.stringify(invokesIndexes)}`
      );
    });
  });
});
