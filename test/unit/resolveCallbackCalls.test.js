/**
 * resolveCallbackCalls — Unit Tests
 *
 * Tests for the pure function that creates CALLS edges from inner
 * parameter-invocation CALL nodes to actual callback functions.
 *
 * Called from ArgumentParameterLinker after RECEIVES_ARGUMENT edges exist.
 *
 * Algorithm under test:
 * 1. Check if RECEIVES_ARGUMENT.dst is callable (FUNCTION, IMPORT, VARIABLE)
 * 2. Resolve dst to a FUNCTION id (direct, or via IMPORTS_FROM/ASSIGNED_FROM chains)
 * 3. Find parent FUNCTION via incoming HAS_PARAMETER edge on parameterNode
 * 4. Collect callable names: param.name + aliases (VARIABLE nodes with ASSIGNED_FROM -> param)
 * 5. Walk scope tree of parent FUNCTION (HAS_SCOPE -> SCOPE -> CONTAINS*, recursive)
 * 6. Find CALL nodes whose name matches collected names
 * 7. Create CALLS edge: inner CALL -> resolved FUNCTION (dedup via Set)
 *
 * Each test manually builds graph state simulating post-ArgumentParameterLinker
 * processing, then calls resolveCallbackCalls() directly.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// The function does not exist yet (TDD). This import will fail until implementation.
import { resolveCallbackCalls } from '@grafema/core';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

describe('resolveCallbackCalls', () => {

  // ============================================================================
  // Helper: setup a fresh test database
  // ============================================================================
  async function setup() {
    const db = await createTestDatabase();
    return { db, backend: db.backend };
  }

  // ============================================================================
  // 1. Basic named function callback
  // ============================================================================
  describe('Basic named function callback', () => {
    it('should create CALLS edge from inner CALL to the passed function', async () => {
      // function run(cb) { cb() }
      // run(myFn)
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/index.js', line: 1 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/index.js', line: 1 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/index.js', line: 1 },
          { id: 'func-myFn', type: 'FUNCTION', name: 'myFn', file: '/project/index.js', line: 5 },
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/index.js', line: 7 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-cb-inner' },
          // RECEIVES_ARGUMENT: param-cb receives myFn from call-run
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'func-myFn', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'func-myFn', metadata: { argIndex: 0, callId: 'call-run' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 1, 'Should create exactly 1 CALLS edge');

        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Inner CALL should have 1 CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'func-myFn', 'CALLS edge should point to myFn');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 2. Arrow function callback
  // ============================================================================
  describe('Arrow function callback', () => {
    it('should create CALLS edge when an arrow function is passed as callback', async () => {
      // run(() => x * 2)
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/index.js', line: 1 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/index.js', line: 1 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/index.js', line: 2 },
          { id: 'func-arrow', type: 'FUNCTION', name: '<anonymous>', file: '/project/index.js', line: 5 },
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/index.js', line: 5 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-cb-inner' },
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'func-arrow', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'func-arrow', metadata: { argIndex: 0, callId: 'call-run' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 1, 'Should create 1 CALLS edge for arrow callback');

        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Inner CALL should have 1 CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'func-arrow', 'CALLS edge should point to the arrow function');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 3. Multiple params - only called one resolves
  // ============================================================================
  describe('Multiple params - only called one resolves', () => {
    it('should only create CALLS edge for the parameter that is actually called', async () => {
      // function apply(fn, x) { return fn(x) }
      // apply(handler, 42)
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-apply', type: 'FUNCTION', name: 'apply', file: '/project/index.js', line: 1 },
          { id: 'param-fn', type: 'PARAMETER', name: 'fn', file: '/project/index.js', line: 1, index: 0 },
          { id: 'param-x', type: 'PARAMETER', name: 'x', file: '/project/index.js', line: 1, index: 1 },
          { id: 'scope-apply', type: 'SCOPE', name: 'apply_body', file: '/project/index.js', line: 1 },
          { id: 'call-fn-inner', type: 'CALL', name: 'fn', file: '/project/index.js', line: 2 },
          { id: 'func-handler', type: 'FUNCTION', name: 'handler', file: '/project/index.js', line: 5 },
          { id: 'literal-42', type: 'LITERAL', name: '42', file: '/project/index.js', line: 7, value: 42 },
          { id: 'call-apply', type: 'CALL', name: 'apply', file: '/project/index.js', line: 7 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-apply', dst: 'param-fn' },
          { type: 'HAS_PARAMETER', src: 'func-apply', dst: 'param-x' },
          { type: 'HAS_SCOPE', src: 'func-apply', dst: 'scope-apply' },
          { type: 'CONTAINS', src: 'scope-apply', dst: 'call-fn-inner' },
          // fn receives handler (callable)
          { type: 'RECEIVES_ARGUMENT', src: 'param-fn', dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-apply' } },
          // x receives 42 (not callable)
          { type: 'RECEIVES_ARGUMENT', src: 'param-x', dst: 'literal-42', metadata: { argIndex: 1, callId: 'call-apply' } },
        ]);

        await backend.flush();

        // Call for the callable param (fn -> handler)
        const paramFn = { id: 'param-fn', name: 'fn', index: 0, file: '/project/index.js' };
        const recvEdgeFn = { dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-apply' } };
        const countFn = await resolveCallbackCalls(backend, paramFn, recvEdgeFn);
        assert.strictEqual(countFn, 1, 'Should create 1 CALLS edge for fn param');

        // Call for the non-callable param (x -> 42)
        const paramX = { id: 'param-x', name: 'x', index: 1, file: '/project/index.js' };
        const recvEdgeX = { dst: 'literal-42', metadata: { argIndex: 1, callId: 'call-apply' } };
        const countX = await resolveCallbackCalls(backend, paramX, recvEdgeX);
        assert.strictEqual(countX, 0, 'Should create 0 CALLS edges for non-callable param x');

        // Verify fn's inner call got the CALLS edge
        const fnCallEdges = await backend.getOutgoingEdges('call-fn-inner', ['CALLS']);
        assert.strictEqual(fnCallEdges.length, 1, 'Inner CALL(fn) should have CALLS edge');
        assert.strictEqual(fnCallEdges[0].dst, 'func-handler', 'Should point to handler');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 4. Multiple call sites
  // ============================================================================
  describe('Multiple call sites', () => {
    it('should create CALLS edges for each RECEIVES_ARGUMENT to different functions', async () => {
      // run(fnA); run(fnB)
      // Both fnA and fnB passed to same parameter cb
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/index.js', line: 1 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/index.js', line: 1 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/index.js', line: 2 },
          { id: 'func-fnA', type: 'FUNCTION', name: 'fnA', file: '/project/index.js', line: 5 },
          { id: 'func-fnB', type: 'FUNCTION', name: 'fnB', file: '/project/index.js', line: 8 },
          { id: 'call-run-1', type: 'CALL', name: 'run', file: '/project/index.js', line: 11 },
          { id: 'call-run-2', type: 'CALL', name: 'run', file: '/project/index.js', line: 12 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-cb-inner' },
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'func-fnA', metadata: { argIndex: 0, callId: 'call-run-1' } },
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'func-fnB', metadata: { argIndex: 0, callId: 'call-run-2' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/index.js' };

        // Resolve for fnA
        const recvEdgeA = { dst: 'func-fnA', metadata: { argIndex: 0, callId: 'call-run-1' } };
        const countA = await resolveCallbackCalls(backend, parameterNode, recvEdgeA);
        assert.strictEqual(countA, 1, 'Should create 1 CALLS edge for fnA');

        // Resolve for fnB
        const recvEdgeB = { dst: 'func-fnB', metadata: { argIndex: 0, callId: 'call-run-2' } };
        const countB = await resolveCallbackCalls(backend, parameterNode, recvEdgeB);
        assert.strictEqual(countB, 1, 'Should create 1 CALLS edge for fnB');

        // Verify both CALLS edges exist on the inner call
        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 2, 'Inner CALL should have 2 CALLS edges');

        const destinations = callsEdges.map(e => e.dst).sort();
        assert.deepStrictEqual(destinations, ['func-fnA', 'func-fnB'].sort(),
          'CALLS edges should point to fnA and fnB');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 5. No callback - no false edges
  // ============================================================================
  describe('No callback - no false edges', () => {
    it('should create 0 edges when RECEIVES_ARGUMENT dst is not callable', async () => {
      // function add(a, b) { return a + b }
      // add(1, 2)
      // RECEIVES_ARGUMENT dst = LITERAL — not callable
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-add', type: 'FUNCTION', name: 'add', file: '/project/index.js', line: 1 },
          { id: 'param-a', type: 'PARAMETER', name: 'a', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-add', type: 'SCOPE', name: 'add_body', file: '/project/index.js', line: 1 },
          { id: 'literal-1', type: 'LITERAL', name: '1', file: '/project/index.js', line: 3, value: 1 },
          { id: 'call-add', type: 'CALL', name: 'add', file: '/project/index.js', line: 3 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-add', dst: 'param-a' },
          { type: 'HAS_SCOPE', src: 'func-add', dst: 'scope-add' },
          { type: 'RECEIVES_ARGUMENT', src: 'param-a', dst: 'literal-1', metadata: { argIndex: 0, callId: 'call-add' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-a', name: 'a', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'literal-1', metadata: { argIndex: 0, callId: 'call-add' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 0, 'Should create 0 edges for non-callable LITERAL arg');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 6. Idempotency
  // ============================================================================
  describe('Idempotency', () => {
    it('should not create duplicate CALLS edges when run twice', async () => {
      // Run resolveCallbackCalls twice on same data
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/index.js', line: 1 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/index.js', line: 1 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/index.js', line: 2 },
          { id: 'func-myFn', type: 'FUNCTION', name: 'myFn', file: '/project/index.js', line: 5 },
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/index.js', line: 7 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-cb-inner' },
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'func-myFn', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'func-myFn', metadata: { argIndex: 0, callId: 'call-run' } };

        // First run
        const count1 = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);
        assert.strictEqual(count1, 1, 'First run should create 1 CALLS edge');

        // Second run (idempotent)
        const count2 = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);
        assert.strictEqual(count2, 0, 'Second run should create 0 new edges (dedup)');

        // Verify no duplicates
        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Should still have exactly 1 CALLS edge');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 7. Import callback (cross-file)
  // ============================================================================
  describe('Import callback (cross-file)', () => {
    it('should resolve IMPORT dst through IMPORTS_FROM -> EXPORT -> FUNCTION chain', async () => {
      // import { fn } from './utils'; run(fn)
      // RECEIVES_ARGUMENT.dst = IMPORT(fn)
      // IMPORT -> IMPORTS_FROM -> EXPORT -> FUNCTION(fn in utils.js)
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          // The HOF that receives the callback
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/main.js', line: 3 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/main.js', line: 3, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/main.js', line: 3 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/main.js', line: 4 },
          // The import in main.js
          { id: 'import-fn', type: 'IMPORT', name: 'fn', file: '/project/main.js', line: 1, source: './utils', importType: 'named', imported: 'fn', local: 'fn' },
          // The export and function in utils.js
          { id: 'export-fn', type: 'EXPORT', name: 'fn', file: '/project/utils.js', line: 1, exportType: 'named', local: 'fn' },
          { id: 'func-fn-utils', type: 'FUNCTION', name: 'fn', file: '/project/utils.js', line: 1 },
          // The call site
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/main.js', line: 7 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-cb-inner' },
          // Import chain
          { type: 'IMPORTS_FROM', src: 'import-fn', dst: 'export-fn' },
          // RECEIVES_ARGUMENT points to the IMPORT node
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'import-fn', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/main.js' };
        const receivesArgEdge = { dst: 'import-fn', metadata: { argIndex: 0, callId: 'call-run' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 1, 'Should create 1 CALLS edge through import chain');

        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Inner CALL should have 1 CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'func-fn-utils',
          'CALLS edge should point to the actual function in utils.js');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 8. Callback inside if statement
  // ============================================================================
  describe('Callback inside if statement', () => {
    it('should find CALL node via recursive scope walk through nested CONTAINS', async () => {
      // function run(cb) { if (x) { cb() } }
      // SCOPE(run_body) -> CONTAINS -> SCOPE(if) -> CONTAINS -> CALL(cb)
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/index.js', line: 1 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/index.js', line: 1 },
          { id: 'scope-if', type: 'SCOPE', name: 'if_block', file: '/project/index.js', line: 2 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/index.js', line: 3 },
          { id: 'func-myFn', type: 'FUNCTION', name: 'myFn', file: '/project/index.js', line: 7 },
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/index.js', line: 9 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          // Nested scope: run_body contains if_block which contains the call
          { type: 'CONTAINS', src: 'scope-run', dst: 'scope-if' },
          { type: 'CONTAINS', src: 'scope-if', dst: 'call-cb-inner' },
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'func-myFn', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'func-myFn', metadata: { argIndex: 0, callId: 'call-run' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 1, 'Should find CALL(cb) through nested scope and create 1 CALLS edge');

        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Nested CALL should have 1 CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'func-myFn', 'Should resolve to myFn');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 9. Nested closure
  // ============================================================================
  describe('Nested closure', () => {
    it('should find CALL node inside nested function scope', async () => {
      // function outer(cb) { function inner() { cb() } }
      // FUNCTION(outer) -> HAS_SCOPE -> SCOPE(outer_body) -> CONTAINS -> FUNCTION(inner)
      //   -> HAS_SCOPE -> SCOPE(inner_body) -> CONTAINS -> CALL(cb)
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-outer', type: 'FUNCTION', name: 'outer', file: '/project/index.js', line: 1 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-outer', type: 'SCOPE', name: 'outer_body', file: '/project/index.js', line: 1 },
          { id: 'func-inner', type: 'FUNCTION', name: 'inner', file: '/project/index.js', line: 2 },
          { id: 'scope-inner', type: 'SCOPE', name: 'inner_body', file: '/project/index.js', line: 2 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/index.js', line: 3 },
          { id: 'func-handler', type: 'FUNCTION', name: 'handler', file: '/project/index.js', line: 7 },
          { id: 'call-outer', type: 'CALL', name: 'outer', file: '/project/index.js', line: 9 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-outer', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-outer', dst: 'scope-outer' },
          // outer_body contains inner function
          { type: 'CONTAINS', src: 'scope-outer', dst: 'func-inner' },
          // inner function has its own scope containing the call
          { type: 'HAS_SCOPE', src: 'func-inner', dst: 'scope-inner' },
          { type: 'CONTAINS', src: 'scope-inner', dst: 'call-cb-inner' },
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-outer' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-outer' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 1, 'Should find CALL(cb) inside nested closure and create 1 CALLS edge');

        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'CALL inside inner should have CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'func-handler', 'Should resolve to handler');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 10. Aliased param
  // ============================================================================
  describe('Aliased param', () => {
    it('should find CALL by alias name when param is reassigned to a local variable', async () => {
      // function run(cb) { const fn = cb; fn() }
      // PARAMETER(cb) <- ASSIGNED_FROM <- VARIABLE(fn)
      // Inner CALL name is 'fn', not 'cb'
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/index.js', line: 1 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/index.js', line: 1 },
          { id: 'var-fn', type: 'VARIABLE', name: 'fn', file: '/project/index.js', line: 2 },
          // The inner CALL uses alias name 'fn', not 'cb'
          { id: 'call-fn-inner', type: 'CALL', name: 'fn', file: '/project/index.js', line: 3 },
          { id: 'func-handler', type: 'FUNCTION', name: 'handler', file: '/project/index.js', line: 6 },
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/index.js', line: 8 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'var-fn' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-fn-inner' },
          // Alias chain: VARIABLE(fn) -> ASSIGNED_FROM -> PARAMETER(cb)
          { type: 'ASSIGNED_FROM', src: 'var-fn', dst: 'param-cb' },
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-run' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 1, 'Should create 1 CALLS edge via alias resolution');

        // The CALL named 'fn' (the alias) should get the CALLS edge
        const callsEdges = await backend.getOutgoingEdges('call-fn-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'CALL(fn) alias should have CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'func-handler', 'Should resolve to handler through alias');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 11. Variable callback
  // ============================================================================
  describe('Variable callback', () => {
    it('should resolve VARIABLE dst through ASSIGNED_FROM chain to FUNCTION', async () => {
      // const myFn = () => {}; run(myFn)
      // RECEIVES_ARGUMENT.dst = VARIABLE(myFn)
      // VARIABLE(myFn) -> ASSIGNED_FROM -> FUNCTION(arrow)
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/index.js', line: 5 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 5, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/index.js', line: 5 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/index.js', line: 6 },
          // The variable and its assigned arrow function
          { id: 'var-myFn', type: 'VARIABLE', name: 'myFn', file: '/project/index.js', line: 1 },
          { id: 'func-arrow', type: 'FUNCTION', name: 'myFn', file: '/project/index.js', line: 1 },
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/index.js', line: 8 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-cb-inner' },
          // Variable -> ASSIGNED_FROM -> Function
          { type: 'ASSIGNED_FROM', src: 'var-myFn', dst: 'func-arrow' },
          // RECEIVES_ARGUMENT points to VARIABLE, not FUNCTION directly
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'var-myFn', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'var-myFn', metadata: { argIndex: 0, callId: 'call-run' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 1, 'Should create 1 CALLS edge through VARIABLE resolution');

        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Inner CALL should have 1 CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'func-arrow',
          'CALLS edge should point to the arrow function (resolved through variable)');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 12. Rest param
  // ============================================================================
  describe('Rest param', () => {
    it('should handle rest parameter pattern if CALL name matches param name', async () => {
      // function run(...fns) { fns[0]() }
      // The inner CALL for fns[0]() — in the AST this typically produces a CALL
      // with name 'fns' (the computed member access base).
      // If name matches 'fns' -> should resolve.
      // This test documents current behavior: if CALL name = param name, it resolves.
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/index.js', line: 1 },
          { id: 'param-fns', type: 'PARAMETER', name: 'fns', file: '/project/index.js', line: 1, index: 0, rest: true },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/index.js', line: 1 },
          // fns[0]() may be represented as CALL with name 'fns' in many parsers
          { id: 'call-fns-inner', type: 'CALL', name: 'fns', file: '/project/index.js', line: 2 },
          { id: 'func-handler', type: 'FUNCTION', name: 'handler', file: '/project/index.js', line: 5 },
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/index.js', line: 7 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-fns' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-fns-inner' },
          { type: 'RECEIVES_ARGUMENT', src: 'param-fns', dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-fns', name: 'fns', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-run' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        // If CALL name matches param name, the edge should be created.
        // If the CALL node for fns[0]() has a different name (e.g., computed), this documents the gap.
        assert.strictEqual(count, 1, 'Should create 1 CALLS edge when CALL name matches rest param name');

        const callsEdges = await backend.getOutgoingEdges('call-fns-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Rest param inner CALL should have CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'func-handler', 'Should resolve to handler');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 13. Nested function parameter shadowing (false positive guard)
  // ============================================================================
  describe('Nested function parameter shadowing', () => {
    it('should NOT create CALLS edge when nested function re-declares same parameter name', async () => {
      // function outer(cb) { function inner(cb) { cb() } }
      // inner(cb) shadows outer(cb) — the inner cb() refers to inner's own param, not outer's
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-outer', type: 'FUNCTION', name: 'outer', file: '/project/index.js', line: 1 },
          { id: 'param-cb-outer', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 1, index: 0 },
          { id: 'scope-outer', type: 'SCOPE', name: 'outer_body', file: '/project/index.js', line: 1 },
          { id: 'func-inner', type: 'FUNCTION', name: 'inner', file: '/project/index.js', line: 2 },
          { id: 'param-cb-inner', type: 'PARAMETER', name: 'cb', file: '/project/index.js', line: 2, index: 0 },
          { id: 'scope-inner', type: 'SCOPE', name: 'inner_body', file: '/project/index.js', line: 2 },
          { id: 'call-cb-inside-inner', type: 'CALL', name: 'cb', file: '/project/index.js', line: 3 },
          { id: 'func-handler', type: 'FUNCTION', name: 'handler', file: '/project/index.js', line: 7 },
          { id: 'call-outer', type: 'CALL', name: 'outer', file: '/project/index.js', line: 9 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-outer', dst: 'param-cb-outer' },
          { type: 'HAS_SCOPE', src: 'func-outer', dst: 'scope-outer' },
          { type: 'CONTAINS', src: 'scope-outer', dst: 'func-inner' },
          // Inner function has its own 'cb' parameter
          { type: 'HAS_PARAMETER', src: 'func-inner', dst: 'param-cb-inner' },
          { type: 'HAS_SCOPE', src: 'func-inner', dst: 'scope-inner' },
          { type: 'CONTAINS', src: 'scope-inner', dst: 'call-cb-inside-inner' },
          // outer(cb) receives handler
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb-outer', dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-outer' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb-outer', name: 'cb', index: 0, file: '/project/index.js' };
        const receivesArgEdge = { dst: 'func-handler', metadata: { argIndex: 0, callId: 'call-outer' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 0, 'Should create 0 CALLS edges — inner cb() refers to inner param, not outer');

        const callsEdges = await backend.getOutgoingEdges('call-cb-inside-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 0, 'No CALLS edge on shadowed inner call');
      } finally {
        await db.cleanup();
      }
    });
  });

  // ============================================================================
  // 14. Variable-to-import chain
  // ============================================================================
  describe('Variable-to-import chain', () => {
    it('should resolve VARIABLE -> ASSIGNED_FROM -> IMPORT -> IMPORTS_FROM -> EXPORT -> FUNCTION', async () => {
      // const fn = require('./utils').fn; run(fn)
      // VARIABLE(fn) -> ASSIGNED_FROM -> IMPORT(fn) -> IMPORTS_FROM -> EXPORT(fn) -> FUNCTION
      const { db, backend } = await setup();
      try {
        await backend.addNodes([
          { id: 'func-run', type: 'FUNCTION', name: 'run', file: '/project/main.js', line: 3 },
          { id: 'param-cb', type: 'PARAMETER', name: 'cb', file: '/project/main.js', line: 3, index: 0 },
          { id: 'scope-run', type: 'SCOPE', name: 'run_body', file: '/project/main.js', line: 3 },
          { id: 'call-cb-inner', type: 'CALL', name: 'cb', file: '/project/main.js', line: 4 },
          // Variable assigned from import
          { id: 'var-fn', type: 'VARIABLE', name: 'fn', file: '/project/main.js', line: 1 },
          { id: 'import-fn', type: 'IMPORT', name: 'fn', file: '/project/main.js', line: 1 },
          // Export and function in utils
          { id: 'export-fn', type: 'EXPORT', name: 'fn', file: '/project/utils.js', line: 1, local: 'fn' },
          { id: 'func-fn-utils', type: 'FUNCTION', name: 'fn', file: '/project/utils.js', line: 1 },
          { id: 'call-run', type: 'CALL', name: 'run', file: '/project/main.js', line: 5 },
        ]);

        await backend.addEdges([
          { type: 'HAS_PARAMETER', src: 'func-run', dst: 'param-cb' },
          { type: 'HAS_SCOPE', src: 'func-run', dst: 'scope-run' },
          { type: 'CONTAINS', src: 'scope-run', dst: 'call-cb-inner' },
          // Variable -> Import -> Export chain
          { type: 'ASSIGNED_FROM', src: 'var-fn', dst: 'import-fn' },
          { type: 'IMPORTS_FROM', src: 'import-fn', dst: 'export-fn' },
          // RECEIVES_ARGUMENT points to variable
          { type: 'RECEIVES_ARGUMENT', src: 'param-cb', dst: 'var-fn', metadata: { argIndex: 0, callId: 'call-run' } },
        ]);

        await backend.flush();

        const parameterNode = { id: 'param-cb', name: 'cb', index: 0, file: '/project/main.js' };
        const receivesArgEdge = { dst: 'var-fn', metadata: { argIndex: 0, callId: 'call-run' } };

        const count = await resolveCallbackCalls(backend, parameterNode, receivesArgEdge);

        assert.strictEqual(count, 1, 'Should create 1 CALLS edge through VARIABLE -> IMPORT chain');

        const callsEdges = await backend.getOutgoingEdges('call-cb-inner', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1);
        assert.strictEqual(callsEdges[0].dst, 'func-fn-utils',
          'Should resolve through VARIABLE -> IMPORT -> EXPORT -> FUNCTION');
      } finally {
        await db.cleanup();
      }
    });
  });
});
