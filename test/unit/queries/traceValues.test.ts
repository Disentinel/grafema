/**
 * Tests for traceValues utility (REG-244)
 *
 * Tests the core utility for tracing variable values through the graph.
 * Starting from a node, follows ASSIGNED_FROM/DERIVES_FROM edges backwards
 * to find literal values or mark as unknown (parameter, call result, etc.)
 *
 * Graph structure:
 * ```
 * VARIABLE -[ASSIGNED_FROM]-> LITERAL (concrete value)
 * VARIABLE -[ASSIGNED_FROM]-> PARAMETER (unknown: runtime input)
 * VARIABLE -[ASSIGNED_FROM]-> CALL (unknown: function return)
 * VARIABLE -[DERIVES_FROM]-> EXPRESSION (check nondeterministic patterns)
 * VARIABLE -[ASSIGNED_FROM]-> VARIABLE (chain - recurse)
 * ```
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  traceValues,
  aggregateValues,
  type TracedValue,
  type TraceValuesGraphBackend,
} from '@grafema/core';

// =============================================================================
// MOCK BACKEND
// =============================================================================

/**
 * Minimal mock backend that implements TraceValuesGraphBackend.
 *
 * We store nodes and edges in Maps for fast lookup.
 * No real DB operations - all in-memory for fast tests.
 */
class MockGraphBackend implements TraceValuesGraphBackend {
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
}

interface MockNode {
  id: string;
  type: string;
  nodeType?: string;
  value?: unknown;
  file?: string;
  line?: number;
  expressionType?: string;
  object?: string;
  property?: string;
  name?: string;
}

interface MockEdge {
  src: string;
  dst: string;
  type: string;
}

// =============================================================================
// TESTS: Basic Tracing
// =============================================================================

describe('traceValues', () => {
  let backend: MockGraphBackend;

  beforeEach(() => {
    backend = new MockGraphBackend();
  });

  describe('basic tracing', () => {
    /**
     * WHY: Simplest case - tracing a LITERAL node returns its value directly.
     * No traversal needed, just return the literal value.
     */
    it('should return literal value for LITERAL node', async () => {
      // Setup: single LITERAL node
      await backend.addNode({
        id: 'lit-1',
        type: 'LITERAL',
        value: 'hello',
        file: 'file.js',
        line: 5,
      });

      const results = await traceValues(backend, 'lit-1');

      assert.strictEqual(results.length, 1, 'Should return one traced value');
      assert.strictEqual(results[0].value, 'hello');
      assert.strictEqual(results[0].isUnknown, false);
      assert.strictEqual(results[0].source.id, 'lit-1');
      assert.strictEqual(results[0].source.file, 'file.js');
      assert.strictEqual(results[0].source.line, 5);
    });

    /**
     * WHY: Basic chain - VARIABLE assigned from LITERAL.
     * Must follow ASSIGNED_FROM edge to find the literal value.
     */
    it('should trace through ASSIGNED_FROM to LITERAL', async () => {
      // Setup: VARIABLE -[ASSIGNED_FROM]-> LITERAL
      await backend.addNode({ id: 'var-1', type: 'VARIABLE', name: 'x', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-1', type: 'LITERAL', value: 42, file: 'file.js', line: 1 });

      await backend.addEdge({ src: 'var-1', dst: 'lit-1', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-1');

      assert.strictEqual(results.length, 1, 'Should find one value');
      assert.strictEqual(results[0].value, 42);
      assert.strictEqual(results[0].isUnknown, false);
      assert.strictEqual(results[0].source.id, 'lit-1');
    });

    /**
     * WHY: Conditional assignment creates multiple ASSIGNED_FROM edges.
     * Both branches must be traced.
     *
     * Graph:
     * ```
     * const x = condition ? 'yes' : 'no';
     * VARIABLE -[ASSIGNED_FROM]-> LITERAL('yes')
     *          -[ASSIGNED_FROM]-> LITERAL('no')
     * ```
     */
    it('should trace through multiple ASSIGNED_FROM edges (conditional)', async () => {
      // Setup: x = condition ? 'yes' : 'no'
      await backend.addNode({ id: 'var-x', type: 'VARIABLE', name: 'x', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-yes', type: 'LITERAL', value: 'yes', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-no', type: 'LITERAL', value: 'no', file: 'file.js', line: 1 });

      await backend.addEdge({ src: 'var-x', dst: 'lit-yes', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-x', dst: 'lit-no', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-x');

      assert.strictEqual(results.length, 2, 'Should find both values');
      const values = results.map((r) => r.value).sort();
      assert.deepStrictEqual(values, ['no', 'yes']);
      assert.ok(results.every((r) => r.isUnknown === false), 'All should be known values');
    });

    /**
     * WHY: DERIVES_FROM edges represent computed values (e.g., string concatenation).
     * Must follow DERIVES_FROM by default to trace component values.
     *
     * Graph:
     * ```
     * const greeting = 'Hello, ' + name;
     * VARIABLE -[DERIVES_FROM]-> LITERAL('Hello, ')
     *          -[DERIVES_FROM]-> VARIABLE(name)
     * ```
     */
    it('should follow DERIVES_FROM edges', async () => {
      // Setup: greeting = 'Hello, ' + name (where name = 'World')
      await backend.addNode({ id: 'var-greeting', type: 'VARIABLE', name: 'greeting', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-hello', type: 'LITERAL', value: 'Hello, ', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-name', type: 'VARIABLE', name: 'name', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-world', type: 'LITERAL', value: 'World', file: 'file.js', line: 0 });

      await backend.addEdge({ src: 'var-greeting', dst: 'lit-hello', type: 'DERIVES_FROM' });
      await backend.addEdge({ src: 'var-greeting', dst: 'var-name', type: 'DERIVES_FROM' });
      await backend.addEdge({ src: 'var-name', dst: 'lit-world', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-greeting');

      assert.strictEqual(results.length, 2, 'Should find both component values');
      const values = results.map((r) => r.value).sort();
      assert.deepStrictEqual(values, ['Hello, ', 'World']);
    });

    /**
     * WHY: Multi-level chain tracing - value flows through multiple variables.
     *
     * Graph:
     * ```
     * a = 'original'
     * b = a
     * c = b
     * Trace c -> b -> a -> 'original'
     * ```
     */
    it('should trace through variable chains', async () => {
      // Setup: c = b = a = 'original'
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-b', type: 'VARIABLE', name: 'b', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'var-c', type: 'VARIABLE', name: 'c', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'lit-orig', type: 'LITERAL', value: 'original', file: 'file.js', line: 1 });

      await backend.addEdge({ src: 'var-a', dst: 'lit-orig', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-b', dst: 'var-a', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-c', dst: 'var-b', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-c');

      assert.strictEqual(results.length, 1, 'Should trace to original literal');
      assert.strictEqual(results[0].value, 'original');
      assert.strictEqual(results[0].isUnknown, false);
    });
  });

  // ===========================================================================
  // TESTS: Terminal Nodes (Unknown Values)
  // ===========================================================================

  describe('terminal nodes (unknown values)', () => {
    /**
     * WHY: Function parameters are runtime inputs - value is unknown at static analysis.
     * Must mark as unknown with reason: 'parameter'.
     */
    it('should mark PARAMETER as unknown with reason', async () => {
      // Setup: function(userId) { ... userId traced ... }
      await backend.addNode({ id: 'param-userId', type: 'PARAMETER', name: 'userId', file: 'file.js', line: 1 });

      const results = await traceValues(backend, 'param-userId');

      assert.strictEqual(results.length, 1, 'Should return one result');
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'parameter');
      assert.strictEqual(results[0].value, undefined);
      assert.strictEqual(results[0].source.id, 'param-userId');
    });

    /**
     * WHY: Function call results are computed at runtime - unknown at static analysis.
     * Must mark as unknown with reason: 'call_result'.
     */
    it('should mark CALL as unknown with reason', async () => {
      // Setup: const result = getUser();
      await backend.addNode({ id: 'call-getUser', type: 'CALL', name: 'getUser', file: 'file.js', line: 5 });

      const results = await traceValues(backend, 'call-getUser');

      assert.strictEqual(results.length, 1, 'Should return one result');
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'call_result');
      assert.strictEqual(results[0].value, undefined);
    });

    /**
     * WHY: METHOD_CALL is treated the same as CALL - runtime return value.
     */
    it('should mark METHOD_CALL as unknown', async () => {
      // Setup: const data = response.json();
      await backend.addNode({
        id: 'mcall-json',
        type: 'METHOD_CALL',
        name: 'json',
        object: 'response',
        file: 'file.js',
        line: 10,
      });

      const results = await traceValues(backend, 'mcall-json');

      assert.strictEqual(results.length, 1, 'Should return one result');
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'call_result');
    });

    /**
     * WHY: A node without outgoing ASSIGNED_FROM/DERIVES_FROM edges
     * means we can't determine its value. Mark as unknown.
     */
    it('should mark nodes without edges as unknown (no_sources)', async () => {
      // Setup: variable with no assignment edges
      await backend.addNode({ id: 'var-orphan', type: 'VARIABLE', name: 'orphan', file: 'file.js', line: 1 });

      const results = await traceValues(backend, 'var-orphan');

      assert.strictEqual(results.length, 1, 'Should return one result');
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'no_sources');
    });

    /**
     * WHY: Variable assigned from parameter - trace to parameter, mark unknown.
     */
    it('should trace variable to PARAMETER and mark unknown', async () => {
      // Setup: function(id) { const userId = id; }
      await backend.addNode({ id: 'param-id', type: 'PARAMETER', name: 'id', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-userId', type: 'VARIABLE', name: 'userId', file: 'file.js', line: 2 });

      await backend.addEdge({ src: 'var-userId', dst: 'param-id', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-userId');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'parameter');
      assert.strictEqual(results[0].source.id, 'param-id');
    });

    /**
     * WHY: Variable assigned from call result - trace to call, mark unknown.
     */
    it('should trace variable to CALL and mark unknown', async () => {
      // Setup: const user = getUser();
      await backend.addNode({ id: 'call-getUser', type: 'CALL', name: 'getUser', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'var-user', type: 'VARIABLE', name: 'user', file: 'file.js', line: 5 });

      await backend.addEdge({ src: 'var-user', dst: 'call-getUser', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-user');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'call_result');
      assert.strictEqual(results[0].source.id, 'call-getUser');
    });
  });

  // ===========================================================================
  // TESTS: Nondeterministic Pattern Detection
  // ===========================================================================

  describe('nondeterministic pattern detection', () => {
    /**
     * WHY: process.env.* is environment-specific - value unknown at static analysis.
     * These patterns represent external/user input that varies at runtime.
     */
    it('should detect process.env access', async () => {
      // Setup: const apiKey = process.env.API_KEY;
      await backend.addNode({
        id: 'expr-env',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'process',
        property: 'env',
        file: 'file.js',
        line: 1,
      });

      const results = await traceValues(backend, 'expr-env');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'nondeterministic');
    });

    /**
     * WHY: req.body contains user input - always nondeterministic.
     */
    it('should detect req.body access', async () => {
      await backend.addNode({
        id: 'expr-body',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'req',
        property: 'body',
        file: 'file.js',
        line: 3,
      });

      const results = await traceValues(backend, 'expr-body');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'nondeterministic');
    });

    /**
     * WHY: req.query contains URL query parameters - user input.
     */
    it('should detect req.query access', async () => {
      await backend.addNode({
        id: 'expr-query',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'req',
        property: 'query',
        file: 'file.js',
        line: 4,
      });

      const results = await traceValues(backend, 'expr-query');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'nondeterministic');
    });

    /**
     * WHY: req.params contains route parameters - user input.
     */
    it('should detect req.params access', async () => {
      await backend.addNode({
        id: 'expr-params',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'req',
        property: 'params',
        file: 'file.js',
        line: 5,
      });

      const results = await traceValues(backend, 'expr-params');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'nondeterministic');
    });

    /**
     * WHY: ctx.request is Koa's request object - similar to Express req.
     */
    it('should detect ctx.request access', async () => {
      await backend.addNode({
        id: 'expr-ctx',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'ctx',
        property: 'request',
        file: 'file.js',
        line: 6,
      });

      const results = await traceValues(backend, 'expr-ctx');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'nondeterministic');
    });

    /**
     * WHY: Regular MemberExpression like obj.property should NOT be marked
     * nondeterministic. Only specific patterns are nondeterministic.
     */
    it('should NOT mark regular MemberExpression as nondeterministic', async () => {
      // Setup: const name = user.name; (trace user.name)
      // This is a regular property access, not process.env or req.body
      await backend.addNode({
        id: 'expr-user-name',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'user',
        property: 'name',
        file: 'file.js',
        line: 7,
      });

      const results = await traceValues(backend, 'expr-user-name');

      // Regular MemberExpression without ASSIGNED_FROM edges = no_sources, not nondeterministic
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'no_sources', 'Should be no_sources, not nondeterministic');
    });

    /**
     * WHY: Nested nondeterministic access like process.env.API_KEY should be detected.
     * The object 'process.env' is in NONDETERMINISTIC_OBJECTS list.
     */
    it('should detect nested nondeterministic (process.env.VAR)', async () => {
      // Setup: const apiKey = process.env.API_KEY;
      // Here the object is 'process.env' and property is 'API_KEY'
      await backend.addNode({
        id: 'expr-env-var',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'process.env',
        property: 'API_KEY',
        file: 'file.js',
        line: 1,
      });

      const results = await traceValues(backend, 'expr-env-var');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'nondeterministic');
    });

    /**
     * WHY: req.body.userId should be detected - object starts with 'req.body'.
     */
    it('should detect req.body.field access', async () => {
      await backend.addNode({
        id: 'expr-body-field',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'req.body',
        property: 'userId',
        file: 'file.js',
        line: 8,
      });

      const results = await traceValues(backend, 'expr-body-field');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'nondeterministic');
    });

    /**
     * WHY: Variable traced to nondeterministic expression should be unknown.
     */
    it('should trace variable to nondeterministic expression', async () => {
      // Setup: const userId = req.body.userId;
      await backend.addNode({ id: 'var-userId', type: 'VARIABLE', name: 'userId', file: 'file.js', line: 5 });
      await backend.addNode({
        id: 'expr-body-userId',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'req.body',
        property: 'userId',
        file: 'file.js',
        line: 5,
      });

      await backend.addEdge({ src: 'var-userId', dst: 'expr-body-userId', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-userId');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'nondeterministic');
      assert.strictEqual(results[0].source.id, 'expr-body-userId');
    });
  });

  // ===========================================================================
  // TESTS: Cycle Detection
  // ===========================================================================

  describe('cycle detection', () => {
    /**
     * WHY: Self-cycle (A -> A) must not cause infinite loop.
     * visited set prevents re-visiting the same node.
     */
    it('should handle self-cycle (A -> A)', async () => {
      // Setup: malformed graph where variable points to itself
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });

      await backend.addEdge({ src: 'var-a', dst: 'var-a', type: 'ASSIGNED_FROM' });

      // Should complete without hanging
      const results = await traceValues(backend, 'var-a');

      // Self-referential with no other sources = visited, no results (or depends on implementation)
      // The key assertion is that it doesn't hang
      assert.ok(Array.isArray(results), 'Should return array without hanging');
    });

    /**
     * WHY: Mutual cycle (A -> B -> A) must not cause infinite loop.
     */
    it('should handle mutual cycle (A -> B -> A)', async () => {
      // Setup: a = b; b = a; (impossible in real code but graph can have it)
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-b', type: 'VARIABLE', name: 'b', file: 'file.js', line: 2 });

      await backend.addEdge({ src: 'var-a', dst: 'var-b', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-b', dst: 'var-a', type: 'ASSIGNED_FROM' });

      // Should complete without hanging
      const results = await traceValues(backend, 'var-a');

      assert.ok(Array.isArray(results), 'Should return array without hanging');
    });

    /**
     * WHY: Longer cycles (A -> B -> C -> A) must be handled.
     */
    it('should handle longer cycles (A -> B -> C -> A)', async () => {
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-b', type: 'VARIABLE', name: 'b', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'var-c', type: 'VARIABLE', name: 'c', file: 'file.js', line: 3 });

      await backend.addEdge({ src: 'var-a', dst: 'var-b', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-b', dst: 'var-c', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-c', dst: 'var-a', type: 'ASSIGNED_FROM' });

      // Should complete without hanging
      const results = await traceValues(backend, 'var-a');

      assert.ok(Array.isArray(results), 'Should return array without hanging');
    });

    /**
     * WHY: Cycle with exit - should find the literal even with cycle in graph.
     *
     * Graph:
     * ```
     * a -[ASSIGNED_FROM]-> b
     * b -[ASSIGNED_FROM]-> c
     * c -[ASSIGNED_FROM]-> a (cycle)
     * c -[ASSIGNED_FROM]-> lit (exit)
     * ```
     */
    it('should find values despite cycle if exit exists', async () => {
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-b', type: 'VARIABLE', name: 'b', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'var-c', type: 'VARIABLE', name: 'c', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'lit-val', type: 'LITERAL', value: 'found', file: 'file.js', line: 4 });

      await backend.addEdge({ src: 'var-a', dst: 'var-b', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-b', dst: 'var-c', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-c', dst: 'var-a', type: 'ASSIGNED_FROM' }); // cycle
      await backend.addEdge({ src: 'var-c', dst: 'lit-val', type: 'ASSIGNED_FROM' }); // exit

      const results = await traceValues(backend, 'var-a');

      assert.ok(results.length >= 1, 'Should find at least the literal');
      const foundValue = results.find((r) => r.value === 'found');
      assert.ok(foundValue, 'Should find the literal value');
      assert.strictEqual(foundValue!.isUnknown, false);
    });
  });

  // ===========================================================================
  // TESTS: Depth Limit
  // ===========================================================================

  describe('depth limit', () => {
    /**
     * WHY: Prevent infinite/deep traversal by limiting depth.
     * When depth exceeded, mark as unknown with reason: 'max_depth'.
     */
    it('should stop at maxDepth and mark as unknown', async () => {
      // Setup: chain of 15 variables (longer than default maxDepth=10)
      const chainLength = 15;
      for (let i = 0; i < chainLength; i++) {
        await backend.addNode({ id: `var-${i}`, type: 'VARIABLE', name: `v${i}`, file: 'file.js', line: i + 1 });
        if (i > 0) {
          await backend.addEdge({ src: `var-${i - 1}`, dst: `var-${i}`, type: 'ASSIGNED_FROM' });
        }
      }
      // Final literal at end of chain
      await backend.addNode({ id: 'lit-end', type: 'LITERAL', value: 'end', file: 'file.js', line: chainLength + 1 });
      await backend.addEdge({ src: `var-${chainLength - 1}`, dst: 'lit-end', type: 'ASSIGNED_FROM' });

      // Default maxDepth=10 should not reach the literal
      const results = await traceValues(backend, 'var-0');

      assert.ok(results.length >= 1, 'Should return results');
      const maxDepthResult = results.find((r) => r.reason === 'max_depth');
      assert.ok(maxDepthResult, 'Should have max_depth result');
      assert.strictEqual(maxDepthResult!.isUnknown, true);
    });

    /**
     * WHY: Custom maxDepth option should be respected.
     */
    it('should respect custom maxDepth option', async () => {
      // Setup: chain of 5 variables + literal
      for (let i = 0; i < 5; i++) {
        await backend.addNode({ id: `var-${i}`, type: 'VARIABLE', name: `v${i}`, file: 'file.js', line: i + 1 });
        if (i > 0) {
          await backend.addEdge({ src: `var-${i - 1}`, dst: `var-${i}`, type: 'ASSIGNED_FROM' });
        }
      }
      await backend.addNode({ id: 'lit-end', type: 'LITERAL', value: 'reached', file: 'file.js', line: 6 });
      await backend.addEdge({ src: 'var-4', dst: 'lit-end', type: 'ASSIGNED_FROM' });

      // With maxDepth=3, should NOT reach the literal (chain is 5 deep)
      const resultsShallow = await traceValues(backend, 'var-0', { maxDepth: 3 });
      const maxDepthResult = resultsShallow.find((r) => r.reason === 'max_depth');
      assert.ok(maxDepthResult, 'Should hit max_depth with shallow limit');

      // With maxDepth=10, should reach the literal
      const resultsDeep = await traceValues(backend, 'var-0', { maxDepth: 10 });
      const literalResult = resultsDeep.find((r) => r.value === 'reached');
      assert.ok(literalResult, 'Should reach literal with deep limit');
    });

    /**
     * WHY: When depth is sufficient, should trace fully without max_depth.
     */
    it('should trace fully when depth is sufficient', async () => {
      // Setup: chain of 3 variables + literal (well within default limit)
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-b', type: 'VARIABLE', name: 'b', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'var-c', type: 'VARIABLE', name: 'c', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'lit-val', type: 'LITERAL', value: 'success', file: 'file.js', line: 4 });

      await backend.addEdge({ src: 'var-a', dst: 'var-b', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-b', dst: 'var-c', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-c', dst: 'lit-val', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-a');

      assert.strictEqual(results.length, 1, 'Should find exactly one value');
      assert.strictEqual(results[0].value, 'success');
      assert.strictEqual(results[0].isUnknown, false);
      assert.strictEqual(results[0].reason, undefined, 'Should not have reason for known value');
    });
  });

  // ===========================================================================
  // TESTS: Options
  // ===========================================================================

  describe('options', () => {
    /**
     * WHY: followDerivesFrom=false should only follow ASSIGNED_FROM edges.
     * Useful when you only want direct assignments, not computed values.
     */
    it('should NOT follow DERIVES_FROM when followDerivesFrom=false', async () => {
      // Setup: a = b + c where b = 'hello' (DERIVES_FROM to b)
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-b', type: 'VARIABLE', name: 'b', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'lit-hello', type: 'LITERAL', value: 'hello', file: 'file.js', line: 2 });

      await backend.addEdge({ src: 'var-a', dst: 'var-b', type: 'DERIVES_FROM' });
      await backend.addEdge({ src: 'var-b', dst: 'lit-hello', type: 'ASSIGNED_FROM' });

      // With followDerivesFrom=false, should NOT follow the DERIVES_FROM edge
      const results = await traceValues(backend, 'var-a', { followDerivesFrom: false });

      // Should have no_sources since there's no ASSIGNED_FROM on var-a
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      assert.strictEqual(results[0].reason, 'no_sources');
    });

    /**
     * WHY: followDerivesFrom=true (default) should follow both edge types.
     */
    it('should follow DERIVES_FROM when followDerivesFrom=true (default)', async () => {
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-b', type: 'VARIABLE', name: 'b', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'lit-hello', type: 'LITERAL', value: 'hello', file: 'file.js', line: 2 });

      await backend.addEdge({ src: 'var-a', dst: 'var-b', type: 'DERIVES_FROM' });
      await backend.addEdge({ src: 'var-b', dst: 'lit-hello', type: 'ASSIGNED_FROM' });

      // Default should follow DERIVES_FROM
      const results = await traceValues(backend, 'var-a');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].value, 'hello');
      assert.strictEqual(results[0].isUnknown, false);
    });

    /**
     * WHY: detectNondeterministic=false should treat process.env etc. as regular nodes.
     * Useful when you want to trace through them instead of stopping.
     */
    it('should NOT detect nondeterministic when detectNondeterministic=false', async () => {
      // Setup: process.env expression
      await backend.addNode({
        id: 'expr-env',
        type: 'EXPRESSION',
        expressionType: 'MemberExpression',
        object: 'process',
        property: 'env',
        file: 'file.js',
        line: 1,
      });

      // With detectNondeterministic=false, should not mark as nondeterministic
      const results = await traceValues(backend, 'expr-env', { detectNondeterministic: false });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].isUnknown, true);
      // Should be 'no_sources' since there are no outgoing edges, not 'nondeterministic'
      assert.strictEqual(results[0].reason, 'no_sources');
    });

    /**
     * WHY: Multiple options should work together.
     */
    it('should combine multiple options correctly', async () => {
      await backend.addNode({ id: 'var-a', type: 'VARIABLE', name: 'a', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-b', type: 'VARIABLE', name: 'b', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'var-c', type: 'VARIABLE', name: 'c', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'lit-val', type: 'LITERAL', value: 'combined', file: 'file.js', line: 4 });

      await backend.addEdge({ src: 'var-a', dst: 'var-b', type: 'DERIVES_FROM' });
      await backend.addEdge({ src: 'var-b', dst: 'var-c', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-c', dst: 'lit-val', type: 'ASSIGNED_FROM' });

      // maxDepth=1 with followDerivesFrom=true should hit max_depth at var-c
      const results = await traceValues(backend, 'var-a', {
        maxDepth: 1,
        followDerivesFrom: true,
      });

      assert.ok(results.length >= 1);
      // Should either find max_depth result or reach var-c
    });
  });

  // ===========================================================================
  // TESTS: OBJECT_LITERAL Special Case
  // ===========================================================================

  describe('OBJECT_LITERAL special case', () => {
    /**
     * WHY: OBJECT_LITERAL without edges is a valid empty object {}.
     * Should NOT be marked as unknown with 'no_sources'.
     */
    it('should not mark OBJECT_LITERAL without edges as unknown', async () => {
      // Setup: const obj = {};
      await backend.addNode({
        id: 'obj-lit',
        type: 'OBJECT_LITERAL',
        file: 'file.js',
        line: 1,
      });

      const results = await traceValues(backend, 'obj-lit');

      // OBJECT_LITERAL is valid even without edges
      // Implementation may return empty or a result without 'no_sources'
      if (results.length > 0) {
        assert.notStrictEqual(results[0].reason, 'no_sources', 'OBJECT_LITERAL should not have no_sources reason');
      }
    });
  });

  // ===========================================================================
  // TESTS: Source Location
  // ===========================================================================

  describe('source location', () => {
    /**
     * WHY: Each traced value should include correct source location.
     * This is essential for error messages and navigation.
     */
    it('should include correct source for each traced value', async () => {
      await backend.addNode({
        id: 'lit-1',
        type: 'LITERAL',
        value: 'test',
        file: '/src/app.js',
        line: 42,
      });

      const results = await traceValues(backend, 'lit-1');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].source.file, '/src/app.js');
      assert.strictEqual(results[0].source.line, 42);
    });

    /**
     * WHY: Source should reference the terminal node (LITERAL, PARAMETER, etc.),
     * not the starting node.
     */
    it('should include node ID in source', async () => {
      await backend.addNode({ id: 'var-x', type: 'VARIABLE', name: 'x', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-origin', type: 'LITERAL', value: 100, file: 'file.js', line: 5 });

      await backend.addEdge({ src: 'var-x', dst: 'lit-origin', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-x');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].source.id, 'lit-origin', 'Source should be the terminal node');
    });

    /**
     * WHY: Multiple values should each have their own source.
     */
    it('should include separate source for each value in multi-value trace', async () => {
      await backend.addNode({ id: 'var-x', type: 'VARIABLE', name: 'x', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-a', type: 'LITERAL', value: 'A', file: 'branch1.js', line: 10 });
      await backend.addNode({ id: 'lit-b', type: 'LITERAL', value: 'B', file: 'branch2.js', line: 20 });

      await backend.addEdge({ src: 'var-x', dst: 'lit-a', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-x', dst: 'lit-b', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-x');

      assert.strictEqual(results.length, 2);
      const sourceA = results.find((r) => r.value === 'A');
      const sourceB = results.find((r) => r.value === 'B');

      assert.ok(sourceA);
      assert.ok(sourceB);
      assert.strictEqual(sourceA!.source.file, 'branch1.js');
      assert.strictEqual(sourceA!.source.line, 10);
      assert.strictEqual(sourceB!.source.file, 'branch2.js');
      assert.strictEqual(sourceB!.source.line, 20);
    });
  });

  // ===========================================================================
  // TESTS: Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    /**
     * WHY: Non-existent node should return empty results.
     * Don't throw error, gracefully handle.
     */
    it('should return empty for non-existent node', async () => {
      const results = await traceValues(backend, 'non-existent-id');

      assert.strictEqual(results.length, 0, 'Should return empty array for non-existent node');
    });

    /**
     * WHY: Node with nodeType field (alternative to type) should be handled.
     * Some backends use nodeType instead of type.
     */
    it('should handle nodeType field as alternative to type', async () => {
      await backend.addNode({
        id: 'lit-alt',
        nodeType: 'LITERAL',
        type: '', // Empty type, nodeType takes precedence
        value: 'alternative',
        file: 'file.js',
        line: 1,
      });

      const results = await traceValues(backend, 'lit-alt');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].value, 'alternative');
      assert.strictEqual(results[0].isUnknown, false);
    });

    /**
     * WHY: Mixed known and unknown values should all be returned.
     */
    it('should return both known and unknown values in mixed trace', async () => {
      // Setup: x = condition ? 'known' : getUnknown()
      await backend.addNode({ id: 'var-x', type: 'VARIABLE', name: 'x', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-known', type: 'LITERAL', value: 'known', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-unknown', type: 'CALL', name: 'getUnknown', file: 'file.js', line: 1 });

      await backend.addEdge({ src: 'var-x', dst: 'lit-known', type: 'ASSIGNED_FROM' });
      await backend.addEdge({ src: 'var-x', dst: 'call-unknown', type: 'ASSIGNED_FROM' });

      const results = await traceValues(backend, 'var-x');

      assert.strictEqual(results.length, 2, 'Should return both values');

      const known = results.find((r) => !r.isUnknown);
      const unknown = results.find((r) => r.isUnknown);

      assert.ok(known, 'Should have known value');
      assert.ok(unknown, 'Should have unknown value');
      assert.strictEqual(known!.value, 'known');
      assert.strictEqual(unknown!.reason, 'call_result');
    });

    /**
     * WHY: Literal with various types (string, number, boolean, null) should work.
     */
    it('should handle different literal types', async () => {
      await backend.addNode({ id: 'lit-str', type: 'LITERAL', value: 'hello', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'lit-num', type: 'LITERAL', value: 42, file: 'file.js', line: 2 });
      await backend.addNode({ id: 'lit-bool', type: 'LITERAL', value: true, file: 'file.js', line: 3 });
      await backend.addNode({ id: 'lit-null', type: 'LITERAL', value: null, file: 'file.js', line: 4 });

      const [strRes] = await traceValues(backend, 'lit-str');
      const [numRes] = await traceValues(backend, 'lit-num');
      const [boolRes] = await traceValues(backend, 'lit-bool');
      const [nullRes] = await traceValues(backend, 'lit-null');

      assert.strictEqual(strRes.value, 'hello');
      assert.strictEqual(numRes.value, 42);
      assert.strictEqual(boolRes.value, true);
      assert.strictEqual(nullRes.value, null);
    });
  });
});

// =============================================================================
// TESTS: aggregateValues
// =============================================================================

describe('aggregateValues', () => {
  /**
   * WHY: aggregateValues should remove duplicate values.
   * Multiple paths to same literal should result in one value.
   */
  it('should deduplicate values', () => {
    const traced: TracedValue[] = [
      { value: 'hello', source: { id: 'lit-1', file: 'a.js', line: 1 }, isUnknown: false },
      { value: 'hello', source: { id: 'lit-2', file: 'b.js', line: 2 }, isUnknown: false },
      { value: 'world', source: { id: 'lit-3', file: 'c.js', line: 3 }, isUnknown: false },
    ];

    const result = aggregateValues(traced);

    assert.strictEqual(result.values.length, 2, 'Should deduplicate to 2 unique values');
    assert.ok(result.values.includes('hello'));
    assert.ok(result.values.includes('world'));
    assert.strictEqual(result.hasUnknown, false);
  });

  /**
   * WHY: hasUnknown should be true if ANY traced value is unknown.
   */
  it('should set hasUnknown if any trace is unknown', () => {
    const traced: TracedValue[] = [
      { value: 'known', source: { id: 'lit-1', file: 'a.js', line: 1 }, isUnknown: false },
      { value: undefined, source: { id: 'param-1', file: 'b.js', line: 2 }, isUnknown: true, reason: 'parameter' },
    ];

    const result = aggregateValues(traced);

    assert.strictEqual(result.hasUnknown, true);
    assert.strictEqual(result.values.length, 1);
    assert.strictEqual(result.values[0], 'known');
  });

  /**
   * WHY: All unknown traces should result in empty values array.
   */
  it('should return empty values for all-unknown traces', () => {
    const traced: TracedValue[] = [
      { value: undefined, source: { id: 'param-1', file: 'a.js', line: 1 }, isUnknown: true, reason: 'parameter' },
      { value: undefined, source: { id: 'call-1', file: 'b.js', line: 2 }, isUnknown: true, reason: 'call_result' },
    ];

    const result = aggregateValues(traced);

    assert.strictEqual(result.values.length, 0, 'Should have no concrete values');
    assert.strictEqual(result.hasUnknown, true);
  });

  /**
   * WHY: null and undefined values should be filtered out from aggregated values.
   * These are not meaningful concrete values.
   */
  it('should filter null and undefined values', () => {
    const traced: TracedValue[] = [
      { value: null, source: { id: 'lit-1', file: 'a.js', line: 1 }, isUnknown: false },
      { value: undefined, source: { id: 'lit-2', file: 'b.js', line: 2 }, isUnknown: false },
      { value: 'valid', source: { id: 'lit-3', file: 'c.js', line: 3 }, isUnknown: false },
    ];

    const result = aggregateValues(traced);

    assert.strictEqual(result.values.length, 1, 'Should only include non-null/undefined value');
    assert.strictEqual(result.values[0], 'valid');
  });

  /**
   * WHY: Empty input should return empty values and hasUnknown=false.
   */
  it('should handle empty traced array', () => {
    const traced: TracedValue[] = [];

    const result = aggregateValues(traced);

    assert.strictEqual(result.values.length, 0);
    assert.strictEqual(result.hasUnknown, false);
  });

  /**
   * WHY: Different types of values should not interfere with deduplication.
   */
  it('should handle mixed value types', () => {
    const traced: TracedValue[] = [
      { value: 42, source: { id: 'lit-1', file: 'a.js', line: 1 }, isUnknown: false },
      { value: '42', source: { id: 'lit-2', file: 'b.js', line: 2 }, isUnknown: false },
      { value: true, source: { id: 'lit-3', file: 'c.js', line: 3 }, isUnknown: false },
      { value: false, source: { id: 'lit-4', file: 'd.js', line: 4 }, isUnknown: false },
    ];

    const result = aggregateValues(traced);

    assert.strictEqual(result.values.length, 4, 'Should keep all distinct values');
    assert.ok(result.values.includes(42));
    assert.ok(result.values.includes('42'));
    assert.ok(result.values.includes(true));
    assert.ok(result.values.includes(false));
  });

  /**
   * WHY: Zero should be a valid value (not filtered like null/undefined).
   */
  it('should include zero as valid value', () => {
    const traced: TracedValue[] = [
      { value: 0, source: { id: 'lit-1', file: 'a.js', line: 1 }, isUnknown: false },
      { value: '', source: { id: 'lit-2', file: 'b.js', line: 2 }, isUnknown: false },
    ];

    const result = aggregateValues(traced);

    // Note: implementation may filter empty string - check tech plan
    // Zero should definitely be included
    assert.ok(result.values.includes(0), 'Zero should be included');
  });
});

// =============================================================================
// TESTS: HTTP_RECEIVES Edge Following (REG-252 Phase D)
// =============================================================================

describe('traceValues with HTTP_RECEIVES edges', () => {
  let backend: MockGraphBackend;

  beforeEach(() => {
    backend = new MockGraphBackend();
  });

  /**
   * WHY: traceValues should follow HTTP_RECEIVES edges at CALL terminals.
   * This enables cross-service value tracing:
   *
   * Frontend:
   *   const data = await response.json();  // CALL node
   *
   * Backend:
   *   res.json({ users: [] });  // OBJECT_LITERAL
   *
   * Graph:
   *   CALL (response.json()) --[HTTP_RECEIVES]--> OBJECT_LITERAL ({ users: [] })
   *
   * When tracing `data`, we reach the CALL terminal. Instead of stopping
   * with "call_result" unknown, we should follow HTTP_RECEIVES edge to
   * find the backend OBJECT_LITERAL.
   */
  it('should trace through HTTP_RECEIVES edge to backend response', async () => {
    // Setup graph:
    // Frontend: data variable assigned from response.json() CALL
    // Backend: OBJECT_LITERAL with response data
    // HTTP_RECEIVES edge connects them

    // Frontend side
    await backend.addNode({
      id: 'var-data',
      type: 'VARIABLE',
      name: 'data',
      file: 'client.js',
      line: 3,
    });
    await backend.addNode({
      id: 'call-json',
      type: 'CALL',
      object: 'response',
      method: 'json',
      file: 'client.js',
      line: 3,
    });

    // Backend side
    await backend.addNode({
      id: 'obj-response',
      type: 'OBJECT_LITERAL',
      file: 'server.js',
      line: 5,
    });

    // Data flow edges
    await backend.addEdge({ src: 'var-data', dst: 'call-json', type: 'ASSIGNED_FROM' });

    // HTTP_RECEIVES edge (CALL -> OBJECT_LITERAL)
    await backend.addEdge({ src: 'call-json', dst: 'obj-response', type: 'HTTP_RECEIVES' });

    // Trace from frontend variable
    const results = await traceValues(backend, 'var-data');

    // Should NOT stop at CALL with "call_result"
    // Should follow HTTP_RECEIVES to OBJECT_LITERAL
    assert.ok(results.length >= 1, 'Should have traced results');

    // Check if we reached the OBJECT_LITERAL
    const hasObjectLiteral = results.some((r) => r.source.id === 'obj-response');
    assert.ok(
      hasObjectLiteral,
      `Should trace through HTTP_RECEIVES to OBJECT_LITERAL. ` +
        `Results: ${JSON.stringify(results.map((r) => ({ id: r.source.id, reason: r.reason })))}`
    );
  });

  /**
   * WHY: When frontend variable is traced, it should ultimately find the
   * backend OBJECT_LITERAL through the HTTP boundary.
   *
   * Full chain:
   * VARIABLE(data) --ASSIGNED_FROM--> CALL(response.json()) --HTTP_RECEIVES--> OBJECT_LITERAL
   */
  it('should find OBJECT_LITERAL from backend when tracing frontend variable', async () => {
    // Setup: complete frontend-to-backend trace

    // Frontend variable
    await backend.addNode({
      id: 'var-users',
      type: 'VARIABLE',
      name: 'users',
      file: 'frontend/api.js',
      line: 10,
    });

    // Frontend CALL (response.json())
    await backend.addNode({
      id: 'call-response-json',
      type: 'CALL',
      object: 'response',
      method: 'json',
      file: 'frontend/api.js',
      line: 9,
    });

    // Backend response data
    await backend.addNode({
      id: 'obj-users-response',
      type: 'OBJECT_LITERAL',
      value: { users: [], count: 0 },
      file: 'backend/routes/users.js',
      line: 15,
    });

    // Edges
    await backend.addEdge({ src: 'var-users', dst: 'call-response-json', type: 'ASSIGNED_FROM' });
    await backend.addEdge({ src: 'call-response-json', dst: 'obj-users-response', type: 'HTTP_RECEIVES' });

    // Trace
    const results = await traceValues(backend, 'var-users');

    // Should find the backend OBJECT_LITERAL
    assert.ok(results.length >= 1, 'Should have results');

    const backendResult = results.find((r) => r.source.file === 'backend/routes/users.js');
    assert.ok(
      backendResult,
      `Should find result from backend file. Results: ${JSON.stringify(
        results.map((r) => ({ file: r.source.file, id: r.source.id }))
      )}`
    );
    assert.strictEqual(
      backendResult!.source.id,
      'obj-users-response',
      'Should trace to the specific OBJECT_LITERAL in backend'
    );
  });

  /**
   * WHY: If CALL node has no HTTP_RECEIVES edge, traceValues should
   * still return "call_result" unknown (original behavior preserved).
   */
  it('should still mark CALL as unknown when no HTTP_RECEIVES edge exists', async () => {
    // Setup: CALL without HTTP_RECEIVES edge
    await backend.addNode({
      id: 'var-result',
      type: 'VARIABLE',
      name: 'result',
      file: 'file.js',
      line: 1,
    });
    await backend.addNode({
      id: 'call-some-fn',
      type: 'CALL',
      name: 'someFunction',
      file: 'file.js',
      line: 1,
    });

    await backend.addEdge({ src: 'var-result', dst: 'call-some-fn', type: 'ASSIGNED_FROM' });
    // No HTTP_RECEIVES edge

    const results = await traceValues(backend, 'var-result');

    assert.strictEqual(results.length, 1, 'Should have one result');
    assert.strictEqual(results[0].isUnknown, true);
    assert.strictEqual(results[0].reason, 'call_result');
  });

  /**
   * WHY: Multiple HTTP_RECEIVES edges (from conditional backend responses)
   * should all be followed, returning multiple possible values.
   */
  it('should follow multiple HTTP_RECEIVES edges for conditional responses', async () => {
    // Setup: CALL with multiple HTTP_RECEIVES edges (conditional backend responses)
    await backend.addNode({
      id: 'var-data',
      type: 'VARIABLE',
      name: 'data',
      file: 'client.js',
      line: 5,
    });
    await backend.addNode({
      id: 'call-json',
      type: 'CALL',
      object: 'response',
      method: 'json',
      file: 'client.js',
      line: 4,
    });

    // Two possible backend responses
    await backend.addNode({
      id: 'obj-success',
      type: 'OBJECT_LITERAL',
      value: { success: true },
      file: 'server.js',
      line: 10,
    });
    await backend.addNode({
      id: 'obj-error',
      type: 'OBJECT_LITERAL',
      value: { error: 'Not found' },
      file: 'server.js',
      line: 8,
    });

    // Edges
    await backend.addEdge({ src: 'var-data', dst: 'call-json', type: 'ASSIGNED_FROM' });
    await backend.addEdge({ src: 'call-json', dst: 'obj-success', type: 'HTTP_RECEIVES' });
    await backend.addEdge({ src: 'call-json', dst: 'obj-error', type: 'HTTP_RECEIVES' });

    const results = await traceValues(backend, 'var-data');

    // Should find both backend responses
    assert.strictEqual(results.length, 2, 'Should find both conditional responses');

    const foundIds = results.map((r) => r.source.id).sort();
    assert.deepStrictEqual(
      foundIds,
      ['obj-error', 'obj-success'],
      'Should include both success and error responses'
    );
  });

  /**
   * WHY: Ensure OBJECT_LITERAL terminal is handled correctly after HTTP_RECEIVES.
   * OBJECT_LITERAL without edges should not return "no_sources".
   */
  it('should handle OBJECT_LITERAL terminal correctly after HTTP_RECEIVES', async () => {
    await backend.addNode({
      id: 'call-json',
      type: 'CALL',
      object: 'response',
      method: 'json',
      file: 'client.js',
      line: 3,
    });
    await backend.addNode({
      id: 'obj-response',
      type: 'OBJECT_LITERAL',
      file: 'server.js',
      line: 5,
    });

    await backend.addEdge({ src: 'call-json', dst: 'obj-response', type: 'HTTP_RECEIVES' });

    // Trace starting from the CALL node
    const results = await traceValues(backend, 'call-json');

    // Should reach OBJECT_LITERAL and NOT mark as "no_sources"
    assert.ok(results.length >= 1, 'Should have results');

    const objectLiteralResult = results.find((r) => r.source.id === 'obj-response');
    assert.ok(objectLiteralResult, 'Should find OBJECT_LITERAL result');

    // OBJECT_LITERAL should not have "no_sources" reason
    if (objectLiteralResult!.isUnknown) {
      assert.notStrictEqual(
        objectLiteralResult!.reason,
        'no_sources',
        'OBJECT_LITERAL should not have no_sources reason'
      );
    }
  });

  /**
   * WHY: HTTP_RECEIVES should work together with other edge types.
   * If OBJECT_LITERAL has HAS_PROPERTY edges, those should be traceable too.
   */
  it('should allow further tracing from OBJECT_LITERAL properties', async () => {
    // Frontend
    await backend.addNode({
      id: 'var-users',
      type: 'VARIABLE',
      name: 'users',
      file: 'client.js',
      line: 5,
    });
    await backend.addNode({
      id: 'call-json',
      type: 'CALL',
      object: 'response',
      method: 'json',
      file: 'client.js',
      line: 4,
    });

    // Backend OBJECT_LITERAL with property pointing to array
    await backend.addNode({
      id: 'obj-response',
      type: 'OBJECT_LITERAL',
      file: 'server.js',
      line: 10,
    });
    await backend.addNode({
      id: 'array-users',
      type: 'ARRAY_LITERAL',
      value: [],
      file: 'server.js',
      line: 10,
    });

    // Edges
    await backend.addEdge({ src: 'var-users', dst: 'call-json', type: 'ASSIGNED_FROM' });
    await backend.addEdge({ src: 'call-json', dst: 'obj-response', type: 'HTTP_RECEIVES' });
    // Note: HAS_PROPERTY is not followed by traceValues (different traversal)
    // This test just verifies HTTP_RECEIVES doesn't break other functionality

    const results = await traceValues(backend, 'var-users');

    assert.ok(results.length >= 1, 'Should have results after HTTP_RECEIVES');
    assert.ok(
      results.some((r) => r.source.id === 'obj-response'),
      'Should reach OBJECT_LITERAL through HTTP_RECEIVES'
    );
  });
});
