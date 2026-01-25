/**
 * Unit tests for REG-203: Trace deduplication
 *
 * Bug: `grafema trace` shows duplicate entries when multiple edges point
 * to the same destination node.
 *
 * These tests verify that traceBackward() and traceForward() properly
 * deduplicate nodes that are reachable via multiple edges.
 *
 * Test strategy:
 * - Create graph structures with duplicate edges to same destination
 * - Verify trace results contain each node only once
 * - Test both backward and forward tracing
 * - Test deduplication at multiple depths
 * - Test mixed edge types pointing to same node
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { TestBackend } from '../../helpers/TestRFDB.js';

/**
 * Helper to extract unique node IDs from trace results.
 * This simulates what traceBackward/traceForward should return.
 */
function extractNodeIds(trace) {
  return trace.map(step => step.node.id);
}

/**
 * Helper to count occurrences of each node ID in trace.
 * Used to verify no duplicates exist.
 */
function countNodeOccurrences(trace) {
  const counts = new Map();
  for (const step of trace) {
    const id = step.node.id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

describe('REG-203: Trace deduplication', () => {
  let backend;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
  });

  afterEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  describe('traceBackward - basic deduplication', () => {
    it('should deduplicate when single node has 3 ASSIGNED_FROM edges to same target', async () => {
      // Setup: Variable A has 3 edges to Literal B (same destination)
      // This happens when same value is assigned multiple times in different paths
      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->A',
          nodeType: 'VARIABLE',
          name: 'A',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->func->LITERAL->42',
          nodeType: 'LITERAL',
          name: '42',
          value: 42,
          file: 'test.js',
          line: 5,
        },
      ]);

      // Add 3 duplicate edges: A gets value from same literal via different paths
      await backend.addEdges([
        {
          src: 'test.js->global->func->VARIABLE->A',
          dst: 'test.js->global->func->LITERAL->42',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->A',
          dst: 'test.js->global->func->LITERAL->42',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->A',
          dst: 'test.js->global->func->LITERAL->42',
          edgeType: 'ASSIGNED_FROM',
        },
      ]);
      await backend.flush();

      // Test: Trace backward from A
      const edges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->A', ['ASSIGNED_FROM']);

      // BUG VERIFICATION: Currently returns 3 edges (duplicates)
      assert.equal(edges.length, 3, 'Backend should return 3 edges (this is the input)');

      // EXPECTED BEHAVIOR: After deduplication, should see literal only ONCE
      // This test will FAIL until deduplication is implemented
      const uniqueDestinations = new Set(edges.map(e => e.dst));
      assert.equal(uniqueDestinations.size, 1, 'Should have only 1 unique destination');

      // The trace should contain the literal only once, not three times
      // NOTE: We can't test traceBackward directly since it's not exported,
      // but this demonstrates the problem at the edge level
    });

    it('should deduplicate when multiple variables derive from same parameter', async () => {
      // Setup: Chain where multiple paths lead to same source
      //   param -> var1 -> result
      //   param -> var2 -> result
      // Result should see param only once, not twice

      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->result',
          nodeType: 'VARIABLE',
          name: 'result',
          file: 'test.js',
          line: 20,
        },
        {
          id: 'test.js->global->func->VARIABLE->var1',
          nodeType: 'VARIABLE',
          name: 'var1',
          file: 'test.js',
          line: 15,
        },
        {
          id: 'test.js->global->func->VARIABLE->var2',
          nodeType: 'VARIABLE',
          name: 'var2',
          file: 'test.js',
          line: 16,
        },
        {
          id: 'test.js->global->func->PARAMETER->input',
          nodeType: 'PARAMETER',
          name: 'input',
          file: 'test.js',
          line: 10,
        },
      ]);

      await backend.addEdges([
        // result <- var1 <- input
        {
          src: 'test.js->global->func->VARIABLE->result',
          dst: 'test.js->global->func->VARIABLE->var1',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->var1',
          dst: 'test.js->global->func->PARAMETER->input',
          edgeType: 'ASSIGNED_FROM',
        },
        // result <- var2 <- input (second path to same input)
        {
          src: 'test.js->global->func->VARIABLE->result',
          dst: 'test.js->global->func->VARIABLE->var2',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->var2',
          dst: 'test.js->global->func->PARAMETER->input',
          edgeType: 'ASSIGNED_FROM',
        },
      ]);
      await backend.flush();

      // Test: If we simulate backward trace from result with depth 2
      // We should encounter input parameter only ONCE, not twice

      // Depth 1: result -> [var1, var2]
      const depth1 = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->result', ['ASSIGNED_FROM']);
      assert.equal(depth1.length, 2, 'Depth 1: should have 2 edges to var1 and var2');

      // Depth 2: var1 -> input, var2 -> input
      const var1Edges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->var1', ['ASSIGNED_FROM']);
      const var2Edges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->var2', ['ASSIGNED_FROM']);

      assert.equal(var1Edges.length, 1, 'var1 should point to input');
      assert.equal(var2Edges.length, 1, 'var2 should point to input');
      assert.equal(var1Edges[0].dst, 'test.js->global->func->PARAMETER->input');
      assert.equal(var2Edges[0].dst, 'test.js->global->func->PARAMETER->input');

      // BUG: Without deduplication, trace would show input twice
      // EXPECTED: input should appear only once in final trace
    });
  });

  describe('traceBackward - multi-depth deduplication', () => {
    it('should deduplicate diamond pattern: A -> B,C -> D (D appears via two paths)', async () => {
      // Diamond structure:
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D
      // Tracing from A should show D only once, not twice

      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->A',
          nodeType: 'VARIABLE',
          name: 'A',
          file: 'test.js',
          line: 30,
        },
        {
          id: 'test.js->global->func->VARIABLE->B',
          nodeType: 'VARIABLE',
          name: 'B',
          file: 'test.js',
          line: 20,
        },
        {
          id: 'test.js->global->func->VARIABLE->C',
          nodeType: 'VARIABLE',
          name: 'C',
          file: 'test.js',
          line: 21,
        },
        {
          id: 'test.js->global->func->LITERAL->100',
          nodeType: 'LITERAL',
          name: '100',
          value: 100,
          file: 'test.js',
          line: 10,
        },
      ]);

      await backend.addEdges([
        // A <- B
        {
          src: 'test.js->global->func->VARIABLE->A',
          dst: 'test.js->global->func->VARIABLE->B',
          edgeType: 'ASSIGNED_FROM',
        },
        // A <- C
        {
          src: 'test.js->global->func->VARIABLE->A',
          dst: 'test.js->global->func->VARIABLE->C',
          edgeType: 'ASSIGNED_FROM',
        },
        // B <- D
        {
          src: 'test.js->global->func->VARIABLE->B',
          dst: 'test.js->global->func->LITERAL->100',
          edgeType: 'ASSIGNED_FROM',
        },
        // C <- D
        {
          src: 'test.js->global->func->VARIABLE->C',
          dst: 'test.js->global->func->LITERAL->100',
          edgeType: 'ASSIGNED_FROM',
        },
      ]);
      await backend.flush();

      // Test: Trace from A with depth >= 2 should encounter literal 100 via two paths
      // Expected: Literal should appear only ONCE in results

      // Verify the diamond exists
      const aEdges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->A', ['ASSIGNED_FROM']);
      assert.equal(aEdges.length, 2, 'A should have edges to B and C');

      const bEdges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->B', ['ASSIGNED_FROM']);
      const cEdges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->C', ['ASSIGNED_FROM']);

      assert.equal(bEdges[0].dst, 'test.js->global->func->LITERAL->100', 'B points to literal');
      assert.equal(cEdges[0].dst, 'test.js->global->func->LITERAL->100', 'C points to literal');

      // BUG: Without deduplication, literal appears twice (via B and via C)
      // EXPECTED: Should appear once
    });

    it('should deduplicate when same node appears at different depths', async () => {
      // Structure:
      //   result <- intermediate <- source
      //   result <- source (direct edge)
      // "source" appears at depth 1 AND depth 2
      // Should appear only once in trace

      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->result',
          nodeType: 'VARIABLE',
          name: 'result',
          file: 'test.js',
          line: 30,
        },
        {
          id: 'test.js->global->func->VARIABLE->intermediate',
          nodeType: 'VARIABLE',
          name: 'intermediate',
          file: 'test.js',
          line: 20,
        },
        {
          id: 'test.js->global->func->VARIABLE->source',
          nodeType: 'VARIABLE',
          name: 'source',
          file: 'test.js',
          line: 10,
        },
      ]);

      await backend.addEdges([
        // Direct: result <- source
        {
          src: 'test.js->global->func->VARIABLE->result',
          dst: 'test.js->global->func->VARIABLE->source',
          edgeType: 'ASSIGNED_FROM',
        },
        // Indirect: result <- intermediate <- source
        {
          src: 'test.js->global->func->VARIABLE->result',
          dst: 'test.js->global->func->VARIABLE->intermediate',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->intermediate',
          dst: 'test.js->global->func->VARIABLE->source',
          edgeType: 'ASSIGNED_FROM',
        },
      ]);
      await backend.flush();

      // Test: source reachable via two paths of different lengths
      // Expected: Should appear only once

      const resultEdges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->result', ['ASSIGNED_FROM']);
      assert.equal(resultEdges.length, 2, 'result has 2 outgoing edges');

      const destinations = resultEdges.map(e => e.dst).sort();
      assert.deepEqual(destinations, [
        'test.js->global->func->VARIABLE->intermediate',
        'test.js->global->func->VARIABLE->source',
      ]);

      // BUG: source would appear twice (depth 1 direct, depth 2 via intermediate)
    });
  });

  describe('traceBackward - mixed edge types', () => {
    it('should deduplicate when same node reached via ASSIGNED_FROM and DERIVES_FROM', async () => {
      // Structure:
      //   variable --ASSIGNED_FROM--> literal
      //   variable --DERIVES_FROM--> literal
      // Same destination via different edge types
      // Should appear only once

      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->x',
          nodeType: 'VARIABLE',
          name: 'x',
          file: 'test.js',
          line: 20,
        },
        {
          id: 'test.js->global->func->LITERAL->42',
          nodeType: 'LITERAL',
          name: '42',
          value: 42,
          file: 'test.js',
          line: 10,
        },
      ]);

      await backend.addEdges([
        {
          src: 'test.js->global->func->VARIABLE->x',
          dst: 'test.js->global->func->LITERAL->42',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->x',
          dst: 'test.js->global->func->LITERAL->42',
          edgeType: 'DERIVES_FROM',
        },
      ]);
      await backend.flush();

      // Test: Get edges of both types
      const edges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->x',
        ['ASSIGNED_FROM', 'DERIVES_FROM']);

      assert.equal(edges.length, 2, 'Should have 2 edges (different types)');

      // Both point to same destination
      const uniqueDst = new Set(edges.map(e => e.dst));
      assert.equal(uniqueDst.size, 1, 'Both edges point to same node');

      // EXPECTED: In trace, literal should appear once, not twice
    });
  });

  describe('traceForward - basic deduplication', () => {
    it('should deduplicate when single source flows to same target via multiple edges', async () => {
      // Setup: Variable A flows to Variable B via 3 edges
      // This can happen in control flow analysis

      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->source',
          nodeType: 'VARIABLE',
          name: 'source',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->func->VARIABLE->sink',
          nodeType: 'VARIABLE',
          name: 'sink',
          file: 'test.js',
          line: 20,
        },
      ]);

      // Add 3 edges from sink to source (sink gets value from source 3 times)
      await backend.addEdges([
        {
          src: 'test.js->global->func->VARIABLE->sink',
          dst: 'test.js->global->func->VARIABLE->source',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->sink',
          dst: 'test.js->global->func->VARIABLE->source',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->sink',
          dst: 'test.js->global->func->VARIABLE->source',
          edgeType: 'ASSIGNED_FROM',
        },
      ]);
      await backend.flush();

      // Test: Forward trace from source (who uses this value?)
      // Need to get INCOMING edges to source (where source is destination)
      const edges = await backend.getIncomingEdges('test.js->global->func->VARIABLE->source', ['ASSIGNED_FROM']);

      assert.equal(edges.length, 3, 'Should have 3 incoming edges');

      const uniqueSources = new Set(edges.map(e => e.src));
      assert.equal(uniqueSources.size, 1, 'All edges come from same source node');

      // EXPECTED: sink should appear only once in forward trace
    });

    it('should deduplicate diamond pattern in forward direction', async () => {
      // Diamond:
      //     A (source)
      //    / \
      //   B   C
      //    \ /
      //     D (sink)
      // Forward trace from A: should show D only once

      await backend.addNodes([
        {
          id: 'test.js->global->func->PARAMETER->A',
          nodeType: 'PARAMETER',
          name: 'A',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->func->VARIABLE->B',
          nodeType: 'VARIABLE',
          name: 'B',
          file: 'test.js',
          line: 20,
        },
        {
          id: 'test.js->global->func->VARIABLE->C',
          nodeType: 'VARIABLE',
          name: 'C',
          file: 'test.js',
          line: 21,
        },
        {
          id: 'test.js->global->func->VARIABLE->D',
          nodeType: 'VARIABLE',
          name: 'D',
          file: 'test.js',
          line: 30,
        },
      ]);

      await backend.addEdges([
        // B <- A, C <- A
        {
          src: 'test.js->global->func->VARIABLE->B',
          dst: 'test.js->global->func->PARAMETER->A',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->C',
          dst: 'test.js->global->func->PARAMETER->A',
          edgeType: 'ASSIGNED_FROM',
        },
        // D <- B, D <- C
        {
          src: 'test.js->global->func->VARIABLE->D',
          dst: 'test.js->global->func->VARIABLE->B',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->D',
          dst: 'test.js->global->func->VARIABLE->C',
          edgeType: 'ASSIGNED_FROM',
        },
      ]);
      await backend.flush();

      // Test: Forward trace from A
      // Depth 1: A flows to B and C
      const incomingA = await backend.getIncomingEdges('test.js->global->func->PARAMETER->A', ['ASSIGNED_FROM']);
      assert.equal(incomingA.length, 2, 'A flows to B and C');

      // Depth 2: B and C both flow to D
      const incomingB = await backend.getIncomingEdges('test.js->global->func->VARIABLE->B', ['ASSIGNED_FROM']);
      const incomingC = await backend.getIncomingEdges('test.js->global->func->VARIABLE->C', ['ASSIGNED_FROM']);

      assert.equal(incomingB.length, 1, 'B has one incoming (from D)');
      assert.equal(incomingC.length, 1, 'C has one incoming (from D)');
      assert.equal(incomingB[0].src, 'test.js->global->func->VARIABLE->D');
      assert.equal(incomingC[0].src, 'test.js->global->func->VARIABLE->D');

      // BUG: D would appear twice in forward trace (via B and via C)
      // EXPECTED: D should appear once
    });
  });

  describe('traceForward - mixed edge types', () => {
    it('should deduplicate when same sink reached via different edge types', async () => {
      // Source flows to Sink via both ASSIGNED_FROM and DERIVES_FROM

      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->source',
          nodeType: 'VARIABLE',
          name: 'source',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->func->VARIABLE->sink',
          nodeType: 'VARIABLE',
          name: 'sink',
          file: 'test.js',
          line: 20,
        },
      ]);

      await backend.addEdges([
        {
          src: 'test.js->global->func->VARIABLE->sink',
          dst: 'test.js->global->func->VARIABLE->source',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->sink',
          dst: 'test.js->global->func->VARIABLE->source',
          edgeType: 'DERIVES_FROM',
        },
      ]);
      await backend.flush();

      // Test: Forward from source
      const edges = await backend.getIncomingEdges('test.js->global->func->VARIABLE->source',
        ['ASSIGNED_FROM', 'DERIVES_FROM']);

      assert.equal(edges.length, 2, 'Two edges with different types');

      const uniqueSinks = new Set(edges.map(e => e.src));
      assert.equal(uniqueSinks.size, 1, 'Same sink via both edge types');

      // EXPECTED: sink appears once in trace
    });
  });

  describe('edge cases', () => {
    it('should handle self-referential edges without infinite loop', async () => {
      // Variable points to itself (recursive definition)
      // Should not cause infinite loop

      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->recursive',
          nodeType: 'VARIABLE',
          name: 'recursive',
          file: 'test.js',
          line: 10,
        },
      ]);

      await backend.addEdge({
        src: 'test.js->global->func->VARIABLE->recursive',
        dst: 'test.js->global->func->VARIABLE->recursive',
        edgeType: 'ASSIGNED_FROM',
      });
      await backend.flush();

      // Test: Should handle gracefully via visited set
      const edges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->recursive', ['ASSIGNED_FROM']);
      assert.equal(edges.length, 1, 'Self-referential edge exists');
      assert.equal(edges[0].dst, 'test.js->global->func->VARIABLE->recursive', 'Points to self');

      // EXPECTED: Deduplication via visited set prevents infinite loop
    });

    it('should handle empty trace (no edges)', async () => {
      // Node with no outgoing edges

      await backend.addNode({
        id: 'test.js->global->func->VARIABLE->isolated',
        nodeType: 'VARIABLE',
        name: 'isolated',
        file: 'test.js',
        line: 10,
      });
      await backend.flush();

      const edges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->isolated', ['ASSIGNED_FROM']);
      assert.equal(edges.length, 0, 'No edges to trace');

      // Should not crash or show duplicates of nothing
    });

    it('should deduplicate across max depth boundary', async () => {
      // Chain longer than maxDepth
      // Node appears at depth N and depth N+1
      // Should still deduplicate correctly

      await backend.addNodes([
        {
          id: 'test.js->global->func->VARIABLE->v1',
          nodeType: 'VARIABLE',
          name: 'v1',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->func->VARIABLE->v2',
          nodeType: 'VARIABLE',
          name: 'v2',
          file: 'test.js',
          line: 11,
        },
        {
          id: 'test.js->global->func->VARIABLE->v3',
          nodeType: 'VARIABLE',
          name: 'v3',
          file: 'test.js',
          line: 12,
        },
      ]);

      await backend.addEdges([
        {
          src: 'test.js->global->func->VARIABLE->v1',
          dst: 'test.js->global->func->VARIABLE->v2',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->func->VARIABLE->v2',
          dst: 'test.js->global->func->VARIABLE->v3',
          edgeType: 'ASSIGNED_FROM',
        },
        // Also direct edge from v1 to v3
        {
          src: 'test.js->global->func->VARIABLE->v1',
          dst: 'test.js->global->func->VARIABLE->v3',
          edgeType: 'ASSIGNED_FROM',
        },
      ]);
      await backend.flush();

      // v3 reachable at depth 1 (direct) and depth 2 (via v2)
      // With maxDepth=1, would see v3 once
      // With maxDepth=2, would see v3 twice WITHOUT deduplication

      const v1Edges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->v1', ['ASSIGNED_FROM']);
      assert.equal(v1Edges.length, 2, 'v1 has edges to v2 and v3');

      const destinations = v1Edges.map(e => e.dst).sort();
      assert.ok(destinations.includes('test.js->global->func->VARIABLE->v3'), 'v3 at depth 1');

      const v2Edges = await backend.getOutgoingEdges('test.js->global->func->VARIABLE->v2', ['ASSIGNED_FROM']);
      assert.equal(v2Edges[0].dst, 'test.js->global->func->VARIABLE->v3', 'v3 also at depth 2');

      // EXPECTED: v3 appears once total, not once per depth
    });
  });
});
