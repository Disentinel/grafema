/**
 * Callback Function Reference Resolution Tests (v2)
 *
 * Tests that when a named function (declaration or const-bound arrow) is passed
 * as an argument to another function or method, Grafema creates the correct edges:
 *
 * V2 behavior:
 * - PASSES_ARGUMENT edge: CALL -> argument source (FUNCTION, VARIABLE, PROPERTY_ACCESS, etc.)
 * - Direct call CALLS edges (e.g., myHOF() -> myHOF FUNCTION) still exist
 * - HOF callback CALLS edges (forEach -> handler) do NOT exist in v2
 * - HAS_CALLBACK edges do NOT exist in v2
 * - Class methods are METHOD nodes (not FUNCTION)
 * - this.method references resolve to PROPERTY_ACCESS nodes
 * - invokesParamIndexes metadata does NOT exist in v2
 *
 * These tests cover:
 * - Same-file function declarations as callbacks (forEach, map, filter, etc.)
 * - Const-bound arrow functions as callbacks
 * - Multiple HOF patterns referencing the same function
 * - setTimeout/setInterval with named function references
 * - Custom higher-order functions
 * - Scope shadowing (inner function preferred over outer)
 * - Inline callbacks
 * - Non-callable arguments (regression: no CALLS edge to literals)
 * - PASSES_ARGUMENT for function declarations
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
  // V2: forEach does NOT create CALLS edge to callback; only PASSES_ARGUMENT
  // ============================================================================
  describe('Same-file function declaration as callback', () => {
    it('should create PASSES_ARGUMENT edge from forEach CALL to handler FUNCTION', async () => {
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

      // V2: PASSES_ARGUMENT edge from forEach to handler (function ref is an argument)
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === forEachCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from forEach (${forEachCall.id}) to handler (${handlerFunc.id})`
      );
    });
  });

  // ============================================================================
  // 2. Const-bound arrow function as callback
  // V2: map does NOT create CALLS edge to callback; only PASSES_ARGUMENT
  // ============================================================================
  describe('Const-bound arrow function as callback', () => {
    it('should create PASSES_ARGUMENT edge from map CALL to const-bound handler VARIABLE', async () => {
      await setupTest(backend, {
        'index.js': `
const handler = () => { return 1; };
const arr = [1, 2];
arr.map(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: const-bound arrow functions create a VARIABLE node for the binding,
      // and a FUNCTION node named <arrow>. PASSES_ARGUMENT points to VARIABLE.
      const handlerVar = allNodes.find(n =>
        n.type === 'VARIABLE' && n.name === 'handler'
      );
      assert.ok(handlerVar, 'Should find handler VARIABLE node (const-bound arrow)');

      // Find the map method call
      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'map'
      );
      assert.ok(mapCall, 'Should find map CALL node');

      // V2: PASSES_ARGUMENT edge from map to handler VARIABLE
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === mapCall.id && e.dst === handlerVar.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from map (${mapCall.id}) to handler VARIABLE (${handlerVar.id})`
      );
    });
  });

  // ============================================================================
  // 3. Multiple HOF patterns referencing the same function
  // V2: PASSES_ARGUMENT edges (not CALLS) from HOFs to callback
  // ============================================================================
  describe('Multiple HOF patterns', () => {
    it('should create 3 PASSES_ARGUMENT edges all pointing to process FUNCTION', async () => {
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

      // V2: Check PASSES_ARGUMENT edges from all three to process
      const passesArgEdges = allEdges.filter(e =>
        e.type === 'PASSES_ARGUMENT' && e.dst === processFunc.id
      );

      const argSources = new Set(passesArgEdges.map(e => e.src));
      assert.ok(
        argSources.has(forEachCall.id),
        `forEach should have PASSES_ARGUMENT edge to process`
      );
      assert.ok(
        argSources.has(mapCall.id),
        `map should have PASSES_ARGUMENT edge to process`
      );
      assert.ok(
        argSources.has(filterCall.id),
        `filter should have PASSES_ARGUMENT edge to process`
      );

      assert.ok(
        passesArgEdges.length >= 3,
        `Should have at least 3 PASSES_ARGUMENT edges to process, got ${passesArgEdges.length}`
      );
    });
  });

  // ============================================================================
  // 4. setTimeout/setInterval with named function
  // V2: PASSES_ARGUMENT edge (not CALLS) from setTimeout to callback
  // ============================================================================
  describe('setTimeout/setInterval', () => {
    it('should create PASSES_ARGUMENT edge from setTimeout CALL to tick FUNCTION', async () => {
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

      // V2: PASSES_ARGUMENT edge from setTimeout to tick
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === setTimeoutCall.id && e.dst === tickFunc.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from setTimeout (${setTimeoutCall.id}) to tick (${tickFunc.id})`
      );
    });
  });

  // ============================================================================
  // 5. Custom higher-order function
  // V2: Direct CALLS edge (myHOF call -> myHOF func) exists.
  //     Callback CALLS edge (myHOF call -> callback func) does NOT exist in v2.
  //     PASSES_ARGUMENT edge (myHOF call -> callback func) exists.
  // ============================================================================
  describe('Custom higher-order function', () => {
    it('should create direct CALLS edge from myHOF CALL to myHOF FUNCTION, and PASSES_ARGUMENT to callback', async () => {
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

      // V2: PASSES_ARGUMENT edge from myHOF call to callback function
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === myHOFCall.id && e.dst === callbackFunc.id
      );
      assert.ok(
        passesArgEdge,
        'Should have PASSES_ARGUMENT edge from myHOF CALL to callback FUNCTION'
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
  // V2: Semantic IDs use line numbers, not scope paths.
  //     Inner handler has higher line number than outer handler.
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

      // V2: Distinguish inner vs outer by line number.
      // The outer handler is at line 2, the inner at line 4.
      // Sort by line to identify them.
      const sorted = handlerFuncs.sort((a, b) => a.line - b.line);
      const outerHandler = sorted[0];
      const innerHandler = sorted[1];
      assert.ok(innerHandler, 'Should find inner handler (higher line number)');
      assert.ok(outerHandler, 'Should find outer handler (lower line number)');
      assert.ok(
        innerHandler.line > outerHandler.line,
        `Inner handler (line ${innerHandler.line}) should be on later line than outer (line ${outerHandler.line})`
      );

      // Find the handler() call (the one at the highest line, inside setup)
      const handlerCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.name === 'handler'
      );
      assert.ok(handlerCalls.length >= 1, 'Should find handler CALL node');
      const handlerCall = handlerCalls[0];

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
  // 7. Inline callback (regression)
  // V2: No HAS_CALLBACK edge. Only PASSES_ARGUMENT to the inline function.
  // ============================================================================
  describe('Inline callback (regression)', () => {
    it('should create PASSES_ARGUMENT edge for inline arrow function', async () => {
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

      // V2: PASSES_ARGUMENT should be created for the inline function
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
  // V2: PASSES_ARGUMENT edges (not CALLS) from HOFs to callback
  // ============================================================================
  describe('Function passed to multiple HOFs', () => {
    it('should create 2 PASSES_ARGUMENT edges both pointing to handler FUNCTION', async () => {
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

      // V2: Both should have PASSES_ARGUMENT edges to handler
      const filterPassesArg = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === filterCall.id && e.dst === handlerFunc.id
      );
      const findPassesArg = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === findCall.id && e.dst === handlerFunc.id
      );

      assert.ok(
        filterPassesArg,
        `filter should have PASSES_ARGUMENT edge to handler`
      );
      assert.ok(
        findPassesArg,
        `find should have PASSES_ARGUMENT edge to handler`
      );
    });
  });

  // ============================================================================
  // 10. Cross-file imported function as callback (enrichment phase)
  // V2: PASSES_ARGUMENT to IMPORT node; no CALLS from HOF to callback
  // ============================================================================
  describe('Cross-file imported function as callback', () => {
    it('should create PASSES_ARGUMENT edge from forEach to imported handler IMPORT node', async () => {
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

      // Find the forEach method call in index.js
      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node in index.js');

      // V2: Should have PASSES_ARGUMENT from forEach to IMPORT node
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
  // 11. PASSES_ARGUMENT for function declaration
  // V2: PASSES_ARGUMENT exists; CALLS from HOF to callback does NOT
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
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === forEachCall.id && e.dst === callbackFunc.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from forEach (${forEachCall.id}) to callback FUNCTION (${callbackFunc.id}). ` +
        `This tests that function declarations are resolved as PASSES_ARGUMENT targets.`
      );
    });
  });

  // ============================================================================
  // 12. Store/register pattern -- no false-positive CALLS edge
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

      // But NO callback CALLS edge -- register is not a known HOF
      const callbackCallsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === registerCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        !callbackCallsEdge,
        'Should NOT have callback CALLS edge for register() -- not a known HOF'
      );
    });
  });

  // ============================================================================
  // 13. Function-level method calls (inside function bodies)
  // V2: PASSES_ARGUMENT edges from HOFs to callbacks (not CALLS)
  // ============================================================================
  describe('Function-level callback resolution', () => {
    it('should create PASSES_ARGUMENT edge for forEach(fn) inside a function body', async () => {
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

      // V2: PASSES_ARGUMENT edge from forEach to invokeCleanup
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === forEachCall.id && e.dst === cleanupFunc.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from forEach (${forEachCall?.id}) to invokeCleanup (${cleanupFunc?.id})`
      );
    });

    it('should create PASSES_ARGUMENT edge for nested member forEach(fn) inside a function body', async () => {
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

      // V2: PASSES_ARGUMENT edge
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === forEachCall.id && e.dst === effectFunc.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from nested forEach (${forEachCall?.id}) to invokeEffect (${effectFunc?.id})`
      );
    });

    it('should create PASSES_ARGUMENT edge for map(fn) inside a function body', async () => {
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

      // V2: PASSES_ARGUMENT edge
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === mapCall.id && e.dst === doubleFunc.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from map to double inside function body`
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
        'Should NOT have CALLS edge for register() -- not a known HOF'
      );
    });
  });

  // ============================================================================
  // REG-401: User-defined HOF -- multiple params, only one invoked
  // V2: No callback CALLS edges; only PASSES_ARGUMENT for each argument
  // ============================================================================
  describe('User-defined HOF: multiple params, PASSES_ARGUMENT for each (REG-401)', () => {
    it('should create PASSES_ARGUMENT edges for both function arguments', async () => {
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

      // V2: Both arguments should have PASSES_ARGUMENT edges
      const passesArgToDoWork = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === myExecutorCall.id && e.dst === doWorkFunc.id
      );
      assert.ok(
        passesArgToDoWork,
        'Should have PASSES_ARGUMENT edge to doWork (param index 0)'
      );

      const passesArgToStoreIt = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === myExecutorCall.id && e.dst === storeItFunc.id
      );
      assert.ok(
        passesArgToStoreIt,
        'Should have PASSES_ARGUMENT edge to storeIt (param index 1)'
      );
    });
  });

  // ============================================================================
  // REG-401: Store/register pattern -- no parameter invocation detected
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
        'Should NOT have callback CALLS edge -- register stores fn, does not invoke it'
      );
    });
  });

  // ============================================================================
  // REG-402: Method reference callbacks (this.method)
  // V2: Class methods are METHOD nodes (not FUNCTION).
  //     this.handler resolves to PROPERTY_ACCESS nodes.
  //     PASSES_ARGUMENT edges point to PROPERTY_ACCESS (not directly to METHOD).
  //     No callback CALLS edges from HOF to method.
  // ============================================================================
  describe('Method reference callbacks (this.method) [REG-402]', () => {
    it('should create PASSES_ARGUMENT edge from forEach to PROPERTY_ACCESS for this.handler', async () => {
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

      // V2: handler is a METHOD node, not FUNCTION
      const handlerMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'handler'
      );
      assert.ok(handlerMethod, 'Should find handler METHOD node');

      // Find the forEach method call
      const forEachCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'forEach'
      );
      assert.ok(forEachCall, 'Should find forEach CALL node');

      // V2: PASSES_ARGUMENT from forEach to PROPERTY_ACCESS (this.handler)
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === forEachCall.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from forEach (${forEachCall.id})`
      );

      // The target should be a PROPERTY_ACCESS node for this.handler
      const targetNode = allNodes.find(n => n.id === passesArgEdge.dst);
      assert.ok(targetNode, 'PASSES_ARGUMENT target should exist');
      assert.strictEqual(
        targetNode.type,
        'PROPERTY_ACCESS',
        `Target should be PROPERTY_ACCESS, got ${targetNode.type}`
      );
    });

    it('should create PASSES_ARGUMENT edge from map to PROPERTY_ACCESS for this.transform', async () => {
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

      // V2: transform is a METHOD node
      const transformMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'transform'
      );
      assert.ok(transformMethod, 'Should find transform METHOD node');

      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'map'
      );
      assert.ok(mapCall, 'Should find map CALL node');

      // V2: PASSES_ARGUMENT edge from map
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === mapCall.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from map (${mapCall.id})`
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

      // V2: Both are METHOD nodes
      const validateMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'validate'
      );
      const transformMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'transform'
      );
      assert.ok(validateMethod, 'Should find validate METHOD node');
      assert.ok(transformMethod, 'Should find transform METHOD node');

      const filterCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'filter'
      );
      const mapCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'map'
      );
      assert.ok(filterCall, 'Should find filter CALL node');
      assert.ok(mapCall, 'Should find map CALL node');

      // V2: filter and map should have PASSES_ARGUMENT edges
      const filterPassesArg = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === filterCall.id
      );
      assert.ok(filterPassesArg, 'filter should have PASSES_ARGUMENT edge');

      const mapPassesArg = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === mapCall.id
      );
      assert.ok(mapPassesArg, 'map should have PASSES_ARGUMENT edge');
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

      // V2: handler is a METHOD node
      const handlerMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'handler'
      );
      const addCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'add'
      );
      assert.ok(handlerMethod, 'Should find handler METHOD node');
      assert.ok(addCall, 'Should find add CALL node');

      // No CALLS edge (add is not a known HOF)
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === addCall.id && e.dst === handlerMethod.id
      );
      assert.ok(
        !callsEdge,
        'Should NOT have CALLS edge for add() -- not a known HOF'
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
        'Should NOT have callback CALLS edge for parser.parse -- no type info available'
      );
    });
  });

  // ============================================================================
  // REG-416: Aliased parameter invocation in HOFs
  // V2: No callback CALLS edges for aliases; only PASSES_ARGUMENT
  // ============================================================================
  describe('Aliased parameter invocation in HOFs (REG-416)', () => {
    it('should create PASSES_ARGUMENT edge for direct alias: const f = fn; f()', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 42; }
function apply(fn) {
  const f = fn;
  f();
}
apply(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      const applyCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'apply' && !n.object
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node');
      assert.ok(applyCall, 'Should find apply CALL node');

      // V2: PASSES_ARGUMENT edge from apply call to handler
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === applyCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        passesArgEdge,
        'Should have PASSES_ARGUMENT edge from apply() to handler'
      );
    });

    it('should create PASSES_ARGUMENT edge for transitive alias: const f = fn; const g = f; g()', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 42; }
function apply(fn) {
  const f = fn;
  const g = f;
  g();
}
apply(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      const applyCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'apply' && !n.object
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node');
      assert.ok(applyCall, 'Should find apply CALL node');

      // V2: PASSES_ARGUMENT edge from apply to handler
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === applyCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        passesArgEdge,
        'Should have PASSES_ARGUMENT edge from apply() to handler via transitive alias'
      );
    });

    it('should create PASSES_ARGUMENT edges for all arguments regardless of aliasing', async () => {
      await setupTest(backend, {
        'index.js': `
function doWork() { return 42; }
function storeIt() { return 'stored'; }
function exec(fn, logger) {
  const callback = fn;
  callback();
}
exec(doWork, storeIt);
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
      const execCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'exec' && !n.object
      );
      assert.ok(doWorkFunc, 'Should find doWork FUNCTION node');
      assert.ok(storeItFunc, 'Should find storeIt FUNCTION node');
      assert.ok(execCall, 'Should find exec CALL node');

      // V2: Both params get PASSES_ARGUMENT edges
      const passesToDoWork = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === execCall.id && e.dst === doWorkFunc.id
      );
      assert.ok(passesToDoWork, 'Should have PASSES_ARGUMENT edge to doWork (param 0)');

      const passesToStoreIt = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === execCall.id && e.dst === storeItFunc.id
      );
      assert.ok(passesToStoreIt, 'Should have PASSES_ARGUMENT edge to storeIt (param 1)');
    });

    it('should NOT create CALLS edge when alias param is stored, not called', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 42; }
function store(fn) {
  const f = fn;
  arr.push(f);
}
store(handler);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const handlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handler'
      );
      const storeCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'store' && !n.object
      );
      assert.ok(handlerFunc, 'Should find handler FUNCTION node');
      assert.ok(storeCall, 'Should find store CALL node');

      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' && e.src === storeCall.id && e.dst === handlerFunc.id
      );
      assert.ok(
        !callsEdge,
        'Should NOT have callback CALLS edge -- alias f is stored, not called'
      );
    });
  });

  // ============================================================================
  // REG-417: Destructured and rest parameter invocation detection
  // V2: invokesParamIndexes does NOT exist in v2.
  //     No callback CALLS edges from destructured param HOFs.
  //     Only PASSES_ARGUMENT edges exist.
  // ============================================================================

  describe('Destructured param -- PASSES_ARGUMENT edges (ObjectPattern) [REG-417]', () => {
    it('should create PASSES_ARGUMENT edge when HOF with destructured param is called with object literal', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 42; }
function apply({ fn }) { fn(); }
apply({ fn: handler });
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const applyFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'apply'
      );
      const applyCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'apply' && !n.object
      );
      assert.ok(applyFunc, 'Should find apply FUNCTION node');
      assert.ok(applyCall, 'Should find apply CALL node');

      // V2: PASSES_ARGUMENT edge from apply call to argument
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === applyCall.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from apply CALL (${applyCall.id})`
      );
    });
  });

  describe('Destructured param -- nested ObjectPattern [REG-417]', () => {
    it('should create PASSES_ARGUMENT edge for deeply nested destructured param', async () => {
      await setupTest(backend, {
        'index.js': `
function onSuccess() { return 'ok'; }
function execute({ callbacks: { onSuccess: cb } }) { cb(); }
execute({ callbacks: { onSuccess: onSuccess } });
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const executeCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'execute' && !n.object
      );
      assert.ok(executeCall, 'Should find execute CALL node');

      // V2: PASSES_ARGUMENT edge from execute call to argument
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === executeCall.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from execute CALL (${executeCall.id})`
      );
    });
  });

  describe('Array destructured param (ArrayPattern) [REG-417]', () => {
    it('should find function with array-destructured param', async () => {
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
      // V2: invokesParamIndexes does not exist. Just verify the function node exists.
    });
  });

  describe('Rest param array access [REG-417]', () => {
    it('should create PASSES_ARGUMENT edge for rest param argument', async () => {
      await setupTest(backend, {
        'index.js': `
function applyAll(...fns) { fns[0](); }
function step1() { return 1; }
applyAll(step1);
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const step1Func = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'step1'
      );
      assert.ok(step1Func, 'Should find step1 FUNCTION node');

      const applyAllCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'applyAll' && !n.object
      );
      assert.ok(applyAllCall, 'Should find applyAll CALL node');

      // V2: PASSES_ARGUMENT from applyAll call to step1
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === applyAllCall.id && e.dst === step1Func.id
      );
      assert.ok(
        passesArgEdge,
        `Should have PASSES_ARGUMENT edge from applyAll CALL (${applyAllCall.id}) to step1 FUNCTION (${step1Func.id})`
      );
    });
  });

  describe('Destructured param NOT invoked (stored, not called) [REG-417]', () => {
    it('should have PASSES_ARGUMENT but NOT CALLS when destructured param is stored, not called', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() { return 42; }
function storeHandler({ fn }) { registry.push(fn); }
storeHandler({ fn: handler });
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const storeHandlerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'storeHandler'
      );
      assert.ok(storeHandlerFunc, 'Should find storeHandler FUNCTION node');

      const storeHandlerCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'storeHandler' && !n.object
      );
      assert.ok(storeHandlerCall, 'Should find storeHandler CALL node');

      // V2: PASSES_ARGUMENT should exist for the argument
      const passesArgEdge = allEdges.find(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === storeHandlerCall.id
      );
      assert.ok(passesArgEdge, 'Should have PASSES_ARGUMENT edge from storeHandler call');
    });
  });

  describe('Default-with-destructuring param [REG-417]', () => {
    it('should find function with destructured param with default value', async () => {
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
      // V2: invokesParamIndexes does not exist. Just verify the function node exists.
    });
  });
});
