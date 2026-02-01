/**
 * Tests for findCallsInFunction utility (REG-254)
 *
 * Tests the core utility for finding CALL and METHOD_CALL nodes within a function scope.
 *
 * Graph structure:
 * ```
 * FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL
 *                         SCOPE -[CONTAINS]-> METHOD_CALL
 *                         SCOPE -[CONTAINS]-> SCOPE (nested blocks)
 * ```
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { findCallsInFunction, type CallInfo } from '@grafema/core';

// =============================================================================
// MOCK BACKEND
// =============================================================================

/**
 * Minimal mock backend that implements the interface required by findCallsInFunction.
 *
 * We store nodes and edges in Maps for fast lookup.
 * No real DB operations - all in-memory for fast tests.
 */
class MockGraphBackend {
  private nodes: Map<string, MockNode> = new Map();
  private edges: MockEdge[] = [];

  async addNode(node: MockNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge: MockEdge): Promise<void> {
    this.edges.push(edge);
  }

  async getNode(id: string): Promise<MockNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async getOutgoingEdges(nodeId: string, edgeTypes: string[] | null): Promise<MockEdge[]> {
    return this.edges.filter(
      (e) => e.src === nodeId && (edgeTypes === null || edgeTypes.includes(e.type))
    );
  }

  async getIncomingEdges(nodeId: string, edgeTypes: string[] | null): Promise<MockEdge[]> {
    return this.edges.filter(
      (e) => e.dst === nodeId && (edgeTypes === null || edgeTypes.includes(e.type))
    );
  }
}

interface MockNode {
  id: string;
  type: string;
  name: string;
  file?: string;
  line?: number;
  object?: string;
}

interface MockEdge {
  src: string;
  dst: string;
  type: string;
}

// =============================================================================
// TESTS: Direct Calls
// =============================================================================

describe('findCallsInFunction', () => {
  let backend: MockGraphBackend;

  beforeEach(() => {
    backend = new MockGraphBackend();
  });

  describe('direct calls', () => {
    /**
     * WHY: Basic case - function has a single CALL node in its scope.
     * This is the simplest graph structure we need to support.
     */
    it('should find CALL nodes in function scope', async () => {
      // Setup: FUNCTION -> HAS_SCOPE -> SCOPE -> CONTAINS -> CALL
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'myFunction', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'helperFunction', file: 'file.js', line: 3 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-1', type: 'CONTAINS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 1, 'Should find one call');
      assert.strictEqual(calls[0].name, 'helperFunction');
      assert.strictEqual(calls[0].type, 'CALL');
      assert.strictEqual(calls[0].file, 'file.js');
      assert.strictEqual(calls[0].line, 3);
    });

    /**
     * WHY: METHOD_CALL is a distinct node type for obj.method() patterns.
     * We must find both CALL and METHOD_CALL nodes.
     */
    it('should find METHOD_CALL nodes in function scope', async () => {
      // Setup: FUNCTION -> HAS_SCOPE -> SCOPE -> CONTAINS -> METHOD_CALL
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'processUser', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'mcall-1', type: 'METHOD_CALL', name: 'json', file: 'file.js', line: 5, object: 'response' });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'mcall-1', type: 'CONTAINS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 1, 'Should find one method call');
      assert.strictEqual(calls[0].name, 'json');
      assert.strictEqual(calls[0].type, 'METHOD_CALL');
      assert.strictEqual(calls[0].object, 'response');
    });

    /**
     * WHY: Nested functions have their own scope hierarchy.
     * We must NOT enter inner function scopes - they're separate units.
     *
     * Graph:
     * ```
     * myFunction -[HAS_SCOPE]-> scope1 -[CONTAINS]-> innerFunction
     *                                  -[CONTAINS]-> call-A (should be found)
     * innerFunction -[HAS_SCOPE]-> scope2 -[CONTAINS]-> call-B (should NOT be found)
     * ```
     */
    it('should not enter nested functions', async () => {
      // Outer function with one call
      await backend.addNode({ id: 'outer-func', type: 'FUNCTION', name: 'outer', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'outer-scope', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-outer', type: 'CALL', name: 'outerCall', file: 'file.js', line: 2 });

      // Inner function definition (child of outer scope)
      await backend.addNode({ id: 'inner-func', type: 'FUNCTION', name: 'inner', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'inner-scope', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'call-inner', type: 'CALL', name: 'innerCall', file: 'file.js', line: 6 });

      // Edges
      await backend.addEdge({ src: 'outer-func', dst: 'outer-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'outer-scope', dst: 'call-outer', type: 'CONTAINS' });
      await backend.addEdge({ src: 'outer-scope', dst: 'inner-func', type: 'CONTAINS' });

      await backend.addEdge({ src: 'inner-func', dst: 'inner-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'inner-scope', dst: 'call-inner', type: 'CONTAINS' });

      const calls = await findCallsInFunction(backend, 'outer-func');

      assert.strictEqual(calls.length, 1, 'Should find only outer call');
      assert.strictEqual(calls[0].name, 'outerCall', 'Should find outerCall, not innerCall');
    });

    /**
     * WHY: If statements, loops, and other blocks create nested SCOPE nodes.
     * We MUST traverse into these nested scopes (unlike nested functions).
     *
     * Graph:
     * ```
     * myFunction -[HAS_SCOPE]-> body -[CONTAINS]-> if_scope -[CONTAINS]-> call
     * ```
     */
    it('should handle nested scopes (if blocks, loops)', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'process', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'body-scope', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'if-scope', type: 'SCOPE', name: 'if_branch', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'loop-scope', type: 'SCOPE', name: 'for_body', file: 'file.js', line: 7 });
      await backend.addNode({ id: 'call-in-if', type: 'CALL', name: 'callInIf', file: 'file.js', line: 4 });
      await backend.addNode({ id: 'call-in-loop', type: 'CALL', name: 'callInLoop', file: 'file.js', line: 8 });

      await backend.addEdge({ src: 'func-1', dst: 'body-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'body-scope', dst: 'if-scope', type: 'CONTAINS' });
      await backend.addEdge({ src: 'body-scope', dst: 'loop-scope', type: 'CONTAINS' });
      await backend.addEdge({ src: 'if-scope', dst: 'call-in-if', type: 'CONTAINS' });
      await backend.addEdge({ src: 'loop-scope', dst: 'call-in-loop', type: 'CONTAINS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 2, 'Should find calls in nested scopes');
      const callNames = calls.map((c) => c.name).sort();
      assert.deepStrictEqual(callNames, ['callInIf', 'callInLoop']);
    });

    /**
     * WHY: Edge case - function with no calls should return empty array.
     * This is important to distinguish "no calls" from errors.
     */
    it('should return empty array for function with no calls', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'empty', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-1', type: 'VARIABLE', name: 'x', file: 'file.js', line: 2 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'var-1', type: 'CONTAINS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 0, 'Should return empty array');
    });

    /**
     * WHY: Function with both CALL and METHOD_CALL nodes.
     * Must return all call types.
     */
    it('should find both CALL and METHOD_CALL nodes', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'mixed', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'regularCall', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'mcall-1', type: 'METHOD_CALL', name: 'methodCall', file: 'file.js', line: 3, object: 'obj' });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-1', type: 'CONTAINS' });
      await backend.addEdge({ src: 'scope-1', dst: 'mcall-1', type: 'CONTAINS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 2, 'Should find both call types');
      const types = calls.map((c) => c.type).sort();
      assert.deepStrictEqual(types, ['CALL', 'METHOD_CALL']);
    });
  });

  // ===========================================================================
  // TESTS: Resolution Status
  // ===========================================================================

  describe('resolution status', () => {
    /**
     * WHY: A call is "resolved" when it has a CALLS edge to a target function.
     * This means we found the function definition in the graph.
     */
    it('should mark calls with CALLS edge as resolved=true', async () => {
      // Setup: CALL has CALLS edge to target FUNCTION
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'caller', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'targetFunc', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'target-func', type: 'FUNCTION', name: 'targetFunc', file: 'file.js', line: 10 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-1', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-1', dst: 'target-func', type: 'CALLS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].resolved, true, 'Call with CALLS edge should be resolved');
      assert.ok(calls[0].target, 'Resolved call should have target');
      assert.strictEqual(calls[0].target!.name, 'targetFunc');
      assert.strictEqual(calls[0].target!.id, 'target-func');
    });

    /**
     * WHY: A call without CALLS edge is "unresolved" - we couldn't find its target.
     * This happens with external/dynamic calls.
     */
    it('should mark calls without CALLS edge as resolved=false', async () => {
      // Setup: CALL without CALLS edge (unresolved)
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'caller', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'externalFunc', file: 'file.js', line: 3 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-1', type: 'CONTAINS' });
      // No CALLS edge

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].resolved, false, 'Call without CALLS edge should be unresolved');
      assert.strictEqual(calls[0].target, undefined, 'Unresolved call should not have target');
    });

    /**
     * WHY: Mixed scenario - some calls resolved, some not.
     * Each call must have correct resolution status.
     */
    it('should handle mix of resolved and unresolved calls', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'caller', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-resolved', type: 'CALL', name: 'localFunc', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'call-unresolved', type: 'CALL', name: 'externalFunc', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'target-func', type: 'FUNCTION', name: 'localFunc', file: 'file.js', line: 10 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-resolved', type: 'CONTAINS' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-unresolved', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-resolved', dst: 'target-func', type: 'CALLS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 2);

      const resolvedCall = calls.find((c) => c.name === 'localFunc');
      const unresolvedCall = calls.find((c) => c.name === 'externalFunc');

      assert.ok(resolvedCall, 'Should find local call');
      assert.ok(unresolvedCall, 'Should find external call');
      assert.strictEqual(resolvedCall!.resolved, true);
      assert.strictEqual(unresolvedCall!.resolved, false);
    });
  });

  // ===========================================================================
  // TESTS: Transitive Mode
  // ===========================================================================

  describe('transitive mode', () => {
    /**
     * WHY: transitive=true should follow CALLS edges to find indirect calls.
     * A calls B, B calls C -> we should see both B and C.
     *
     * Graph:
     * ```
     * funcA -[HAS_SCOPE]-> scopeA -[CONTAINS]-> callB -[CALLS]-> funcB
     * funcB -[HAS_SCOPE]-> scopeB -[CONTAINS]-> callC -[CALLS]-> funcC
     * ```
     */
    it('should follow resolved CALLS edges when transitive=true', async () => {
      // Function A calls B
      await backend.addNode({ id: 'func-A', type: 'FUNCTION', name: 'funcA', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-A', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-B', type: 'CALL', name: 'funcB', file: 'file.js', line: 2 });

      // Function B calls C
      await backend.addNode({ id: 'func-B', type: 'FUNCTION', name: 'funcB', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'scope-B', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'call-C', type: 'CALL', name: 'funcC', file: 'file.js', line: 11 });

      // Function C (leaf)
      await backend.addNode({ id: 'func-C', type: 'FUNCTION', name: 'funcC', file: 'file.js', line: 20 });

      // Edges
      await backend.addEdge({ src: 'func-A', dst: 'scope-A', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-A', dst: 'call-B', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-B', dst: 'func-B', type: 'CALLS' });

      await backend.addEdge({ src: 'func-B', dst: 'scope-B', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-B', dst: 'call-C', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-C', dst: 'func-C', type: 'CALLS' });

      const calls = await findCallsInFunction(backend, 'func-A', { transitive: true });

      assert.strictEqual(calls.length, 2, 'Should find direct and transitive calls');
      const callNames = calls.map((c) => c.name).sort();
      assert.deepStrictEqual(callNames, ['funcB', 'funcC']);
    });

    /**
     * WHY: Depth field helps agents understand call hierarchy.
     * depth=0 is direct call, depth=1 is one level deep, etc.
     */
    it('should add depth field for transitive calls', async () => {
      // A calls B, B calls C
      await backend.addNode({ id: 'func-A', type: 'FUNCTION', name: 'funcA', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-A', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-B', type: 'CALL', name: 'funcB', file: 'file.js', line: 2 });

      await backend.addNode({ id: 'func-B', type: 'FUNCTION', name: 'funcB', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'scope-B', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'call-C', type: 'CALL', name: 'funcC', file: 'file.js', line: 11 });

      await backend.addNode({ id: 'func-C', type: 'FUNCTION', name: 'funcC', file: 'file.js', line: 20 });

      await backend.addEdge({ src: 'func-A', dst: 'scope-A', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-A', dst: 'call-B', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-B', dst: 'func-B', type: 'CALLS' });

      await backend.addEdge({ src: 'func-B', dst: 'scope-B', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-B', dst: 'call-C', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-C', dst: 'func-C', type: 'CALLS' });

      const calls = await findCallsInFunction(backend, 'func-A', { transitive: true });

      const callB = calls.find((c) => c.name === 'funcB');
      const callC = calls.find((c) => c.name === 'funcC');

      assert.ok(callB, 'Should find call to funcB');
      assert.ok(callC, 'Should find call to funcC');
      assert.strictEqual(callB!.depth, 0, 'Direct call should have depth=0');
      assert.strictEqual(callC!.depth, 1, 'Indirect call should have depth=1');
    });

    /**
     * WHY: Prevent infinite traversal by limiting depth.
     * Default transitiveDepth=5 prevents explosion.
     */
    it('should stop at transitiveDepth limit', async () => {
      // Create deep call chain: A -> B -> C -> D -> E -> F
      const funcs = ['A', 'B', 'C', 'D', 'E', 'F'];

      for (let i = 0; i < funcs.length; i++) {
        const name = funcs[i];
        await backend.addNode({ id: `func-${name}`, type: 'FUNCTION', name: `func${name}`, file: 'file.js', line: i * 10 + 1 });
        await backend.addNode({ id: `scope-${name}`, type: 'SCOPE', name: 'function_body', file: 'file.js', line: i * 10 + 1 });

        if (i < funcs.length - 1) {
          const nextName = funcs[i + 1];
          await backend.addNode({ id: `call-${nextName}`, type: 'CALL', name: `func${nextName}`, file: 'file.js', line: i * 10 + 2 });
          await backend.addEdge({ src: `scope-${name}`, dst: `call-${nextName}`, type: 'CONTAINS' });
          await backend.addEdge({ src: `call-${nextName}`, dst: `func-${nextName}`, type: 'CALLS' });
        }

        await backend.addEdge({ src: `func-${name}`, dst: `scope-${name}`, type: 'HAS_SCOPE' });
      }

      // With transitiveDepth=2, should stop at C (depth 2)
      const calls = await findCallsInFunction(backend, 'func-A', {
        transitive: true,
        transitiveDepth: 2,
      });

      // Should have: B (depth 0), C (depth 1), D (depth 2)
      // Should NOT have: E, F (beyond depth limit)
      const callNames = calls.map((c) => c.name).sort();
      assert.ok(callNames.includes('funcB'), 'Should include funcB');
      assert.ok(callNames.includes('funcC'), 'Should include funcC');
      assert.ok(callNames.includes('funcD'), 'Should include funcD');
      assert.ok(!callNames.includes('funcE'), 'Should NOT include funcE (beyond limit)');
      assert.ok(!callNames.includes('funcF'), 'Should NOT include funcF (beyond limit)');
    });

    /**
     * WHY: Recursive function (A calls A) must not cause infinite loop.
     * We track seen functions to detect cycles.
     */
    it('should handle recursive functions (A calls A)', async () => {
      // A calls itself
      await backend.addNode({ id: 'func-A', type: 'FUNCTION', name: 'funcA', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-A', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-A', type: 'CALL', name: 'funcA', file: 'file.js', line: 5 });

      await backend.addEdge({ src: 'func-A', dst: 'scope-A', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-A', dst: 'call-A', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-A', dst: 'func-A', type: 'CALLS' });

      // Should complete without hanging
      const calls = await findCallsInFunction(backend, 'func-A', { transitive: true });

      // Should find the recursive call exactly once
      assert.strictEqual(calls.length, 1, 'Should find recursive call once');
      assert.strictEqual(calls[0].name, 'funcA');
      assert.strictEqual(calls[0].depth, 0);
    });

    /**
     * WHY: Mutual recursion (A calls B calls A) must not cause infinite loop.
     * Same cycle detection logic applies.
     */
    it('should handle cycles (A calls B calls A)', async () => {
      // A calls B, B calls A
      await backend.addNode({ id: 'func-A', type: 'FUNCTION', name: 'funcA', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-A', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-B-from-A', type: 'CALL', name: 'funcB', file: 'file.js', line: 2 });

      await backend.addNode({ id: 'func-B', type: 'FUNCTION', name: 'funcB', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'scope-B', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'call-A-from-B', type: 'CALL', name: 'funcA', file: 'file.js', line: 11 });

      await backend.addEdge({ src: 'func-A', dst: 'scope-A', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-A', dst: 'call-B-from-A', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-B-from-A', dst: 'func-B', type: 'CALLS' });

      await backend.addEdge({ src: 'func-B', dst: 'scope-B', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-B', dst: 'call-A-from-B', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-A-from-B', dst: 'func-A', type: 'CALLS' });

      // Should complete without hanging
      const calls = await findCallsInFunction(backend, 'func-A', { transitive: true });

      // Should find: B (direct from A), A (from B at depth 1)
      // But A is the function we're querying, so cycle detection should prevent re-traversing A
      assert.strictEqual(calls.length, 2, 'Should find calls without infinite loop');
      const callNames = calls.map((c) => c.name).sort();
      assert.deepStrictEqual(callNames, ['funcA', 'funcB']);
    });

    /**
     * WHY: transitive=false (default) should only return direct calls.
     * This is the baseline behavior.
     */
    it('should return only direct calls when transitive=false (default)', async () => {
      // A calls B, B calls C
      await backend.addNode({ id: 'func-A', type: 'FUNCTION', name: 'funcA', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-A', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-B', type: 'CALL', name: 'funcB', file: 'file.js', line: 2 });

      await backend.addNode({ id: 'func-B', type: 'FUNCTION', name: 'funcB', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'scope-B', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'call-C', type: 'CALL', name: 'funcC', file: 'file.js', line: 11 });

      await backend.addEdge({ src: 'func-A', dst: 'scope-A', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-A', dst: 'call-B', type: 'CONTAINS' });
      await backend.addEdge({ src: 'call-B', dst: 'func-B', type: 'CALLS' });

      await backend.addEdge({ src: 'func-B', dst: 'scope-B', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-B', dst: 'call-C', type: 'CONTAINS' });

      // Default: transitive=false
      const calls = await findCallsInFunction(backend, 'func-A');

      assert.strictEqual(calls.length, 1, 'Should return only direct calls');
      assert.strictEqual(calls[0].name, 'funcB');
    });
  });

  // ===========================================================================
  // TESTS: Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    /**
     * WHY: Function without HAS_SCOPE edge should return empty array.
     * This handles malformed graph data gracefully.
     */
    it('should handle function without HAS_SCOPE edge', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'orphan', file: 'file.js', line: 1 });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 0, 'Should return empty array');
    });

    /**
     * WHY: Non-existent function ID should return empty array.
     * Don't throw error, just return empty.
     */
    it('should handle non-existent function ID', async () => {
      const calls = await findCallsInFunction(backend, 'non-existent');

      assert.strictEqual(calls.length, 0, 'Should return empty array for non-existent function');
    });

    /**
     * WHY: Multiple HAS_SCOPE edges (unusual but possible).
     * Should traverse all scopes.
     */
    it('should handle multiple scopes', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'multiScope', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'scope1', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-2', type: 'SCOPE', name: 'scope2', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'callInScope1', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'call-2', type: 'CALL', name: 'callInScope2', file: 'file.js', line: 11 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'func-1', dst: 'scope-2', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-1', type: 'CONTAINS' });
      await backend.addEdge({ src: 'scope-2', dst: 'call-2', type: 'CONTAINS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 2, 'Should find calls in all scopes');
    });

    /**
     * WHY: CLASS nodes should stop scope traversal like FUNCTION nodes.
     */
    it('should not enter nested classes', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'outer', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-outer', type: 'CALL', name: 'outerCall', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'class-1', type: 'CLASS', name: 'InnerClass', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'class-scope', type: 'SCOPE', name: 'class_body', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'call-inner', type: 'CALL', name: 'innerCall', file: 'file.js', line: 6 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-outer', type: 'CONTAINS' });
      await backend.addEdge({ src: 'scope-1', dst: 'class-1', type: 'CONTAINS' });
      await backend.addEdge({ src: 'class-1', dst: 'class-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'class-scope', dst: 'call-inner', type: 'CONTAINS' });

      const calls = await findCallsInFunction(backend, 'func-1');

      assert.strictEqual(calls.length, 1, 'Should find only outer call');
      assert.strictEqual(calls[0].name, 'outerCall');
    });
  });
});
