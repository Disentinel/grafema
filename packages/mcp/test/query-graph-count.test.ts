/**
 * Tests for `count: true` parameter on query_graph MCP tool (REG-507)
 *
 * When `count: true` is passed to handleQueryGraph:
 * 1. Run Datalog query normally
 * 2. Return "Count: N" as text (N = number of results)
 * 3. Do NOT return enriched node data
 * 4. When `explain: true` is also passed, explain wins (count ignored)
 * 5. When query returns 0 results, return "Count: 0"
 *
 * These tests are TDD — written BEFORE implementation.
 * Expected: all count-related tests FAIL until implementation is added.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// --- Mock Backend with checkGuarantee support ---

interface MockBinding {
  bindings: Array<{ name: string; value: string }>;
}

/**
 * Creates a mock backend that supports checkGuarantee for Datalog queries.
 * Allows configuring query results per test.
 */
function createQueryMockBackend(queryResults: MockBinding[] = []) {
  const nodes = new Map<string, Record<string, unknown>>();

  return {
    // Core GraphBackend methods
    async nodeCount() { return nodes.size; },
    async edgeCount() { return 0; },
    async countNodesByType() {
      const counts: Record<string, number> = {};
      for (const node of nodes.values()) {
        const t = node.type as string;
        counts[t] = (counts[t] || 0) + 1;
      }
      return counts;
    },
    async countEdgesByType() { return {}; },
    async getNode(id: string) { return nodes.get(id) ?? null; },
    async findByType() { return []; },
    async findByAttr() { return []; },
    async getOutgoingEdges() { return []; },
    async getIncomingEdges() { return []; },
    async *queryNodes() { /* no-op */ },
    async getAllNodes() { return []; },

    // checkGuarantee — the Datalog query method
    async checkGuarantee(query: string, explain?: true) {
      if (explain) {
        return {
          bindings: queryResults.map(r => {
            const obj: Record<string, string> = {};
            for (const b of r.bindings) {
              obj[b.name] = b.value;
            }
            return obj;
          }),
          stats: {
            nodesVisited: 10,
            edgesTraversed: 5,
            ruleEvaluations: 2,
            totalResults: queryResults.length,
          },
          profile: { totalDurationUs: 1234 },
          explainSteps: [],
          warnings: [],
        };
      }
      return queryResults;
    },

    // Helper to add nodes for enrichment tests
    addNode(node: Record<string, unknown>) {
      nodes.set(node.id as string, node);
    },
  };
}

// --- Mock ensureAnalyzed ---

let mockBackend: ReturnType<typeof createQueryMockBackend>;

// Must mock BEFORE importing the handler
mock.module('../dist/analysis.js', {
  namedExports: {
    ensureAnalyzed: async () => mockBackend,
  },
});

// Import handler AFTER mocking
const { handleQueryGraph } = await import('../dist/handlers/query-handlers.js');

// === TESTS ===

describe('query_graph count parameter (REG-507)', () => {
  describe('count: true with results', () => {
    beforeEach(() => {
      // Setup: 3 matching results
      const results: MockBinding[] = [
        { bindings: [{ name: 'X', value: 'FUNCTION:app.js:handleRequest' }] },
        { bindings: [{ name: 'X', value: 'FUNCTION:app.js:processData' }] },
        { bindings: [{ name: 'X', value: 'FUNCTION:app.js:sendResponse' }] },
      ];
      mockBackend = createQueryMockBackend(results);

      // Add nodes so enrichment would work if called
      mockBackend.addNode({
        id: 'FUNCTION:app.js:handleRequest',
        type: 'FUNCTION',
        name: 'handleRequest',
        file: 'app.js',
        line: 10,
      });
      mockBackend.addNode({
        id: 'FUNCTION:app.js:processData',
        type: 'FUNCTION',
        name: 'processData',
        file: 'app.js',
        line: 20,
      });
      mockBackend.addNode({
        id: 'FUNCTION:app.js:sendResponse',
        type: 'FUNCTION',
        name: 'sendResponse',
        file: 'app.js',
        line: 30,
      });
    });

    /**
     * WHY: The primary use case. count:true should return just the count,
     * not the full enriched result set. This saves tokens for the LLM agent
     * when it only needs to know "how many" rather than "what exactly".
     */
    it('should return "Count: N" text when count is true', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "FUNCTION")',
        count: true,
      });

      assert.ok(!result.isError, 'Should not be an error');
      const text = result.content[0].text;
      assert.strictEqual(text, 'Count: 3');
    });

    /**
     * WHY: count:true must NOT return enriched node data.
     * The whole point is to avoid the overhead of node enrichment.
     * Result text should be ONLY the count string, nothing else.
     */
    it('should NOT include enriched node data', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "FUNCTION")',
        count: true,
      });

      const text = result.content[0].text;
      // Must not contain JSON array, node IDs, or function names
      assert.ok(!text.includes('handleRequest'), 'Should not contain node names');
      assert.ok(!text.includes('FUNCTION:app.js'), 'Should not contain node IDs');
      assert.ok(!text.includes('['), 'Should not contain JSON array');
      assert.ok(!text.includes('result(s)'), 'Should not contain normal result text');
    });
  });

  describe('count: true with zero results', () => {
    beforeEach(() => {
      mockBackend = createQueryMockBackend([]);
    });

    /**
     * WHY: Even when there are zero results, count:true should return "Count: 0"
     * and NOT the normal "no results" hint with type suggestions.
     * The agent asked for a count — give it a count.
     */
    it('should return "Count: 0" when no results match', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "NONEXISTENT")',
        count: true,
      });

      assert.ok(!result.isError, 'Should not be an error');
      const text = result.content[0].text;
      assert.strictEqual(text, 'Count: 0');
    });

    /**
     * WHY: count:true with zero results must NOT trigger the "Did you mean..." hint.
     * Hint logic is expensive (calls countNodesByType/countEdgesByType) and irrelevant
     * when the caller only wants a count.
     */
    it('should NOT include type suggestion hints', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "NONEXISTENT")',
        count: true,
      });

      const text = result.content[0].text;
      assert.ok(!text.includes('Hint'), 'Should not contain hints');
      assert.ok(!text.includes('Did you mean'), 'Should not contain type suggestions');
      assert.ok(!text.includes('Graph:'), 'Should not contain graph stats');
    });
  });

  describe('count: true + explain: true', () => {
    beforeEach(() => {
      const results: MockBinding[] = [
        { bindings: [{ name: 'X', value: 'FUNCTION:app.js:handleRequest' }] },
      ];
      mockBackend = createQueryMockBackend(results);
    });

    /**
     * WHY: explain:true is a diagnostic mode that provides step-by-step Datalog
     * execution trace. When both explain and count are requested, explain wins
     * because explain already includes the result count in its output, and the
     * detailed execution trace is strictly more informative.
     */
    it('should return explain output when both explain and count are true', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "FUNCTION")',
        count: true,
        explain: true,
      });

      assert.ok(!result.isError, 'Should not be an error');
      const text = result.content[0].text;
      // Explain output contains "Query returned N result(s)" and stats
      assert.ok(text.includes('result(s)'), 'Should contain explain result count');
      assert.ok(text.includes('Statistics'), 'Should contain explain statistics');
      // Should NOT be just "Count: 1"
      assert.notStrictEqual(text, 'Count: 1');
    });
  });

  describe('count: false (normal behavior)', () => {
    beforeEach(() => {
      const results: MockBinding[] = [
        { bindings: [{ name: 'X', value: 'FUNCTION:app.js:handleRequest' }] },
      ];
      mockBackend = createQueryMockBackend(results);
      mockBackend.addNode({
        id: 'FUNCTION:app.js:handleRequest',
        type: 'FUNCTION',
        name: 'handleRequest',
        file: 'app.js',
        line: 10,
      });
    });

    /**
     * WHY: count:false must not change the existing behavior.
     * The handler should still return enriched node data as before.
     */
    it('should return enriched results when count is false', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "FUNCTION")',
        count: false,
      });

      assert.ok(!result.isError, 'Should not be an error');
      const text = result.content[0].text;
      assert.ok(text.includes('Found 1 result(s)'), 'Should contain normal result text');
      assert.ok(text.includes('handleRequest'), 'Should contain node name');
    });
  });

  describe('count: undefined (normal behavior)', () => {
    beforeEach(() => {
      const results: MockBinding[] = [
        { bindings: [{ name: 'X', value: 'FUNCTION:app.js:processData' }] },
      ];
      mockBackend = createQueryMockBackend(results);
      mockBackend.addNode({
        id: 'FUNCTION:app.js:processData',
        type: 'FUNCTION',
        name: 'processData',
        file: 'app.js',
        line: 20,
      });
    });

    /**
     * WHY: When count is not specified (undefined), behavior must be identical
     * to count:false — full enriched results. This ensures backward compatibility.
     */
    it('should return enriched results when count is not specified', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "FUNCTION")',
      });

      assert.ok(!result.isError, 'Should not be an error');
      const text = result.content[0].text;
      assert.ok(text.includes('Found 1 result(s)'), 'Should contain normal result text');
      assert.ok(text.includes('processData'), 'Should contain node name');
    });
  });

  describe('count: true + limit', () => {
    beforeEach(() => {
      // Setup: 5 matching results, but limit will be 2
      const results: MockBinding[] = [];
      for (let i = 1; i <= 5; i++) {
        results.push({
          bindings: [{ name: 'X', value: `FUNCTION:app.js:func${i}` }],
        });
      }
      mockBackend = createQueryMockBackend(results);

      for (let i = 1; i <= 5; i++) {
        mockBackend.addNode({
          id: `FUNCTION:app.js:func${i}`,
          type: 'FUNCTION',
          name: `func${i}`,
          file: 'app.js',
          line: i * 10,
        });
      }
    });

    /**
     * WHY: count:true should return the TOTAL number of results, not the limited
     * count. The limit parameter exists for pagination of enriched results.
     * When counting, the agent wants to know total matches regardless of
     * display limits.
     */
    it('should return total count ignoring limit', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "FUNCTION")',
        count: true,
        limit: 2,
      });

      assert.ok(!result.isError, 'Should not be an error');
      const text = result.content[0].text;
      assert.strictEqual(text, 'Count: 5', 'Should return total count, not limited count');
    });

    /**
     * WHY: Verify that limit still works normally when count is not set.
     * This is a regression guard — adding count support must not break pagination.
     */
    it('should still paginate results when count is false with limit', async () => {
      const result = await handleQueryGraph({
        query: 'node(X, "FUNCTION")',
        count: false,
        limit: 2,
      });

      assert.ok(!result.isError, 'Should not be an error');
      const text = result.content[0].text;
      assert.ok(text.includes('Found 5 result(s)'), 'Should show total count');
      assert.ok(text.includes('showing 2'), 'Should show limited display count');
    });
  });
});
