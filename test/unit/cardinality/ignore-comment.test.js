/**
 * Ignore Comment Tests - REG-314 Phase 5
 *
 * Tests for `// @grafema-ignore cardinality` escape hatch.
 *
 * When this comment appears before a loop, CardinalityEnricher should skip
 * that loop and NOT add cardinality metadata to its ITERATES_OVER edge.
 *
 * Test scenarios:
 * 1. Loop with ignore comment -> no cardinality metadata
 * 2. Loop without comment -> processed normally (cardinality added)
 * 3. Wrong rule name -> still processed (ignore only affects matching rule)
 * 4. Block comment not supported -> still processed (only line comments)
 * 5. Only affects next statement -> comment on line 5, loop on line 10 -> still processed
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CardinalityEnricher } from '../../../packages/core/dist/plugins/enrichment/CardinalityEnricher.js';

// =============================================================================
// MOCK GRAPH BACKEND
// =============================================================================

/**
 * MockGraphBackend for testing CardinalityEnricher with ignoreCardinality flag.
 *
 * Extends the pattern from CardinalityEnricher.test.js with support for
 * the ignoreCardinality field on LOOP nodes.
 */
class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  addNode(node) {
    this.nodes.set(node.id, node);
  }

  async getNode(id) {
    return this.nodes.get(id) ?? null;
  }

  async addEdge(edge) {
    this.edges.push(edge);
  }

  async deleteEdge(src, dst, type) {
    this.edges = this.edges.filter(
      e => !(e.src === src && e.dst === dst && e.type === type)
    );
  }

  async *queryNodes(filter) {
    for (const node of this.nodes.values()) {
      if (filter?.type && node.type !== filter.type) continue;
      if (filter?.nodeType && node.type !== filter.nodeType) continue;
      yield node;
    }
  }

  async getOutgoingEdges(nodeId, types) {
    return this.edges.filter(e => {
      if (e.src !== nodeId) return false;
      if (types && !types.includes(e.type)) return false;
      return true;
    });
  }

  async getIncomingEdges(nodeId, types) {
    return this.edges.filter(e => {
      if (e.dst !== nodeId) return false;
      if (types && !types.includes(e.type)) return false;
      return true;
    });
  }

  // Helper: find specific ITERATES_OVER edge
  findIteratesOverEdge(loopId) {
    return this.edges.find(e => e.src === loopId && e.type === 'ITERATES_OVER');
  }

  // Helper: get all ITERATES_OVER edges
  getAllIteratesOverEdges() {
    return this.edges.filter(e => e.type === 'ITERATES_OVER');
  }
}

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a minimal PluginContext for testing
 */
function createContext(graph, projectPath = '/test/project') {
  return {
    graph,
    manifest: {
      projectPath,
      service: {
        id: 'test-service',
        name: 'TestService',
        path: 'index.js',
      },
    },
    phase: 'ENRICHMENT',
  };
}

/**
 * Helper: Create a LOOP node with optional ignoreCardinality flag
 */
function createLoopNode(id, loopType, file, line, parentScopeId, ignoreCardinality = false) {
  const node = {
    id,
    type: 'LOOP',
    name: `loop@${line}`,
    loopType,
    file,
    line,
    parentScopeId,
  };
  if (ignoreCardinality) {
    node.ignoreCardinality = true;
  }
  return node;
}

/**
 * Helper: Create a VARIABLE or CONSTANT node
 */
function createVariableNode(id, name, kind, parentScopeId) {
  return {
    id,
    type: kind,
    name,
    parentScopeId,
  };
}

/**
 * Helper: Create a CALL node (representing a function call)
 */
function createCallNode(id, name, file, line, object, method) {
  return {
    id,
    type: 'CALL',
    name,
    file,
    line,
    object,
    method,
  };
}

/**
 * Helper: Create an ITERATES_OVER edge (without cardinality)
 */
function createIteratesOverEdge(loopId, collectionId, iterates) {
  return {
    src: loopId,
    dst: collectionId,
    type: 'ITERATES_OVER',
    metadata: { iterates },
  };
}

/**
 * Helper: Create a DERIVES_FROM edge (variable assigned from call result)
 */
function createDerivesFromEdge(variableId, callId) {
  return {
    src: variableId,
    dst: callId,
    type: 'DERIVES_FROM',
  };
}

/**
 * Helper: Execute CardinalityEnricher with optional config
 */
async function executeEnricher(graph, options = {}) {
  const enricher = new CardinalityEnricher(options);
  const context = createContext(graph);
  await enricher.execute(context);
}

/**
 * Helper: Setup graph with call -> variable -> loop pattern
 * Returns the loop node ID for later verification
 */
async function setupLoopWithCall(graph, {
  callName,
  loopId,
  loopLine,
  ignoreCardinality = false
}) {
  const callNode = createCallNode('call:1', callName, 'test.js', 5);
  const variableNode = createVariableNode('var:items', 'items', 'CONSTANT', 'scope:func');
  const loopNode = createLoopNode(loopId, 'for-of', 'test.js', loopLine, 'scope:func', ignoreCardinality);

  graph.addNode(callNode);
  graph.addNode(variableNode);
  graph.addNode(loopNode);

  await graph.addEdge(createDerivesFromEdge('var:items', 'call:1'));
  await graph.addEdge(createIteratesOverEdge(loopId, 'var:items', 'values'));

  return loopId;
}

// =============================================================================
// TESTS: Ignore Comment Feature (REG-314 Phase 5)
// =============================================================================

describe('CardinalityEnricher - Ignore Comment (REG-314 Phase 5)', () => {
  let graph;

  beforeEach(() => {
    graph = new MockGraphBackend();
  });

  // ===========================================================================
  // SCENARIO 1: Loop with ignore comment -> no cardinality metadata
  // ===========================================================================

  describe('Loop with ignore comment', () => {
    /**
     * Test scenario:
     * - LOOP node has ignoreCardinality: true (set by JSASTAnalyzer when it sees the comment)
     * - Code pattern:
     *   const items = fetchAllItems(); // would normally get cardinality
     *   // @grafema-ignore cardinality
     *   for (const item of items) {...}
     * - Expected: ITERATES_OVER edge has NO cardinality metadata
     */
    it('should NOT add cardinality when loop has ignoreCardinality: true', async () => {
      // Setup: Loop with ignoreCardinality flag
      const loopId = await setupLoopWithCall(graph, {
        callName: 'fetchAllItems', // Would normally match heuristic
        loopId: 'loop:ignored',
        loopLine: 7,
        ignoreCardinality: true // The key flag!
      });

      // Execute enricher
      await executeEnricher(graph);

      // Verify: ITERATES_OVER edge should NOT have cardinality
      const edge = graph.findIteratesOverEdge(loopId);
      assert.ok(edge, 'ITERATES_OVER edge should exist');

      const cardinality = edge?.metadata?.cardinality;
      assert.strictEqual(
        cardinality,
        undefined,
        'Ignored loop should NOT have cardinality metadata'
      );
    });

    it('should preserve iterates metadata even when ignoring cardinality', async () => {
      // Setup: Loop with ignoreCardinality flag
      const loopId = await setupLoopWithCall(graph, {
        callName: 'fetchAllItems',
        loopId: 'loop:ignored',
        loopLine: 7,
        ignoreCardinality: true
      });

      // Execute enricher
      await executeEnricher(graph);

      // Verify: iterates metadata should still be preserved
      const edge = graph.findIteratesOverEdge(loopId);
      assert.strictEqual(edge?.metadata?.iterates, 'values', 'Should preserve iterates metadata');
      assert.strictEqual(edge?.metadata?.cardinality, undefined, 'Should NOT have cardinality');
    });
  });

  // ===========================================================================
  // SCENARIO 2: Loop without comment -> processed normally
  // ===========================================================================

  describe('Loop without ignore comment', () => {
    /**
     * Test scenario:
     * - LOOP node does NOT have ignoreCardinality flag
     * - Code pattern:
     *   const items = fetchAllItems();
     *   for (const item of items) {...}  // No ignore comment
     * - Expected: ITERATES_OVER edge HAS cardinality metadata (normal processing)
     */
    it('should add cardinality when loop does NOT have ignoreCardinality flag', async () => {
      // Setup: Normal loop without ignoreCardinality
      const loopId = await setupLoopWithCall(graph, {
        callName: 'fetchAllItems',
        loopId: 'loop:normal',
        loopLine: 7,
        ignoreCardinality: false // No ignore flag
      });

      // Execute enricher
      await executeEnricher(graph);

      // Verify: ITERATES_OVER edge SHOULD have cardinality
      const edge = graph.findIteratesOverEdge(loopId);
      assert.ok(edge, 'ITERATES_OVER edge should exist');

      const cardinality = edge?.metadata?.cardinality;
      assert.ok(cardinality, 'Normal loop SHOULD have cardinality metadata');
      assert.strictEqual(cardinality?.scale, 'nodes', 'fetch* -> nodes');
      assert.strictEqual(cardinality?.confidence, 'heuristic');
    });
  });

  // ===========================================================================
  // SCENARIO 3: Wrong rule name -> still processed
  // ===========================================================================

  describe('Wrong rule name in ignore comment', () => {
    /**
     * Test scenario:
     * - Comment: `// @grafema-ignore other-rule` (not 'cardinality')
     * - JSASTAnalyzer would NOT set ignoreCardinality flag
     * - Expected: ITERATES_OVER edge HAS cardinality (processed normally)
     *
     * Note: This tests the contract between JSASTAnalyzer and CardinalityEnricher.
     * JSASTAnalyzer only sets ignoreCardinality: true for `@grafema-ignore cardinality`.
     * Other rule names are ignored.
     */
    it('should process normally when ignore comment has wrong rule name', async () => {
      // Setup: Loop WITHOUT ignoreCardinality flag (JSASTAnalyzer didn't set it)
      // This simulates: // @grafema-ignore other-rule
      const loopId = await setupLoopWithCall(graph, {
        callName: 'queryUsers', // Would match heuristic
        loopId: 'loop:wrong-rule',
        loopLine: 7,
        ignoreCardinality: false // Wrong rule name -> no flag
      });

      // Execute enricher
      await executeEnricher(graph);

      // Verify: ITERATES_OVER edge SHOULD have cardinality (not ignored)
      const edge = graph.findIteratesOverEdge(loopId);
      const cardinality = edge?.metadata?.cardinality;

      assert.ok(cardinality, 'Should process normally when rule name does not match');
      assert.strictEqual(cardinality?.scale, 'nodes', 'query* -> nodes');
    });
  });

  // ===========================================================================
  // SCENARIO 4: Block comment not supported -> still processed
  // ===========================================================================

  describe('Block comment not supported', () => {
    /**
     * Test scenario:
     * - Block comment with @grafema-ignore cardinality
     * - JSASTAnalyzer would NOT set ignoreCardinality flag (only line comments)
     * - Expected: ITERATES_OVER edge HAS cardinality (processed normally)
     *
     * Note: This tests the contract that only line comments are supported.
     * Block comments are intentionally not supported to match eslint behavior.
     */
    it('should process normally when ignore is in block comment', async () => {
      // Setup: Loop WITHOUT ignoreCardinality flag (block comment was ignored)
      // This simulates: /* @grafema-ignore cardinality */
      const loopId = await setupLoopWithCall(graph, {
        callName: 'getAllItems',
        loopId: 'loop:block-comment',
        loopLine: 7,
        ignoreCardinality: false // Block comment -> no flag
      });

      // Execute enricher
      await executeEnricher(graph);

      // Verify: ITERATES_OVER edge SHOULD have cardinality (not ignored)
      const edge = graph.findIteratesOverEdge(loopId);
      const cardinality = edge?.metadata?.cardinality;

      assert.ok(cardinality, 'Block comment should NOT trigger ignore');
      assert.strictEqual(cardinality?.scale, 'nodes', 'getAll* -> nodes');
    });
  });

  // ===========================================================================
  // SCENARIO 5: Only affects next statement
  // ===========================================================================

  describe('Only affects next statement', () => {
    /**
     * Test scenario:
     * - Ignore comment on line 5
     * - Loop on line 10 (not immediately after)
     * - JSASTAnalyzer would NOT set ignoreCardinality flag
     * - Expected: ITERATES_OVER edge HAS cardinality (processed normally)
     *
     * This follows the eslint-disable-next-line pattern.
     */
    it('should process normally when loop is not immediately after comment', async () => {
      // Setup: Loop WITHOUT ignoreCardinality flag (not immediately after comment)
      // Comment on line 5, loop on line 10 -> too far apart
      const loopId = await setupLoopWithCall(graph, {
        callName: 'listRecords',
        loopId: 'loop:distant',
        loopLine: 10, // Line 10, comment would be on line 5
        ignoreCardinality: false // Not next line -> no flag
      });

      // Execute enricher
      await executeEnricher(graph);

      // Verify: ITERATES_OVER edge SHOULD have cardinality (not ignored)
      const edge = graph.findIteratesOverEdge(loopId);
      const cardinality = edge?.metadata?.cardinality;

      assert.ok(cardinality, 'Distant comment should NOT affect loop');
      assert.strictEqual(cardinality?.scale, 'nodes', 'list* -> nodes');
    });
  });

  // ===========================================================================
  // SCENARIO 6: Mixed - one ignored, one processed
  // ===========================================================================

  describe('Mixed loops - one ignored, one processed', () => {
    /**
     * Test scenario:
     * - Two loops iterating over same collection
     * - First loop has ignoreCardinality: true
     * - Second loop has ignoreCardinality: false
     * - Expected: Only second loop gets cardinality
     */
    it('should only ignore loops with ignoreCardinality flag', async () => {
      // Setup: Two loops, one ignored, one normal
      const callNode = createCallNode('call:1', 'fetchAllUsers', 'test.js', 5);
      const variableNode = createVariableNode('var:users', 'users', 'CONSTANT', 'scope:func');
      const ignoredLoop = createLoopNode('loop:ignored', 'for-of', 'test.js', 7, 'scope:func', true);
      const normalLoop = createLoopNode('loop:normal', 'for-of', 'test.js', 12, 'scope:func', false);

      graph.addNode(callNode);
      graph.addNode(variableNode);
      graph.addNode(ignoredLoop);
      graph.addNode(normalLoop);

      await graph.addEdge(createDerivesFromEdge('var:users', 'call:1'));
      await graph.addEdge(createIteratesOverEdge('loop:ignored', 'var:users', 'values'));
      await graph.addEdge(createIteratesOverEdge('loop:normal', 'var:users', 'values'));

      // Execute enricher
      await executeEnricher(graph);

      // Verify: Ignored loop has no cardinality
      const ignoredEdge = graph.findIteratesOverEdge('loop:ignored');
      assert.strictEqual(
        ignoredEdge?.metadata?.cardinality,
        undefined,
        'Ignored loop should NOT have cardinality'
      );

      // Verify: Normal loop HAS cardinality
      const normalEdge = graph.findIteratesOverEdge('loop:normal');
      assert.ok(
        normalEdge?.metadata?.cardinality,
        'Normal loop SHOULD have cardinality'
      );
      assert.strictEqual(normalEdge?.metadata?.cardinality?.scale, 'nodes');
    });
  });

  // ===========================================================================
  // SCENARIO 7: Nested loops - only inner ignored
  // ===========================================================================

  describe('Nested loops - only inner ignored', () => {
    /**
     * Test scenario:
     * - Outer loop: for (const group of groups) {...}
     * - Inner loop: for (const item of items) {...} with ignoreCardinality
     * - Expected: Outer loop gets cardinality, inner loop doesn't
     */
    it('should only ignore the loop with the flag, not parent', async () => {
      // Setup: Outer loop iterating over groups
      const groupsCall = createCallNode('call:groups', 'fetchAllGroups', 'test.js', 5);
      const groupsVar = createVariableNode('var:groups', 'groups', 'CONSTANT', 'scope:func');
      const outerLoop = createLoopNode('loop:outer', 'for-of', 'test.js', 6, 'scope:func', false);

      // Inner loop iterating over items (inside outer loop scope)
      const itemsCall = createCallNode('call:items', 'getItems', 'test.js', 8);
      const itemsVar = createVariableNode('var:items', 'items', 'CONSTANT', 'loop:outer');
      const innerLoop = createLoopNode('loop:inner', 'for-of', 'test.js', 10, 'loop:outer', true);

      graph.addNode(groupsCall);
      graph.addNode(groupsVar);
      graph.addNode(outerLoop);
      graph.addNode(itemsCall);
      graph.addNode(itemsVar);
      graph.addNode(innerLoop);

      await graph.addEdge(createDerivesFromEdge('var:groups', 'call:groups'));
      await graph.addEdge(createIteratesOverEdge('loop:outer', 'var:groups', 'values'));
      await graph.addEdge(createDerivesFromEdge('var:items', 'call:items'));
      await graph.addEdge(createIteratesOverEdge('loop:inner', 'var:items', 'values'));

      // Execute enricher
      await executeEnricher(graph);

      // Verify: Outer loop HAS cardinality
      const outerEdge = graph.findIteratesOverEdge('loop:outer');
      assert.ok(
        outerEdge?.metadata?.cardinality,
        'Outer loop SHOULD have cardinality'
      );
      assert.strictEqual(outerEdge?.metadata?.cardinality?.scale, 'nodes');

      // Verify: Inner loop has NO cardinality (ignored)
      const innerEdge = graph.findIteratesOverEdge('loop:inner');
      assert.strictEqual(
        innerEdge?.metadata?.cardinality,
        undefined,
        'Inner loop with ignoreCardinality should NOT have cardinality'
      );
    });
  });

  // ===========================================================================
  // SCENARIO 8: Config-declared cardinality also ignored
  // ===========================================================================

  describe('Config-declared cardinality also ignored', () => {
    /**
     * Test scenario:
     * - Config declares entry point: graph.queryNodes returns 'nodes'
     * - Loop has ignoreCardinality: true
     * - Expected: Loop is still ignored (ignoreCardinality takes priority)
     */
    it('should ignore loop even when config matches', async () => {
      // Setup: Loop with ignoreCardinality, using config-matched call
      const callNode = createCallNode('call:1', 'queryNodes', 'test.js', 5, 'graph', 'queryNodes');
      const variableNode = createVariableNode('var:nodes', 'nodes', 'CONSTANT', 'scope:func');
      const loopNode = createLoopNode('loop:ignored', 'for-of', 'test.js', 6, 'scope:func', true);

      graph.addNode(callNode);
      graph.addNode(variableNode);
      graph.addNode(loopNode);

      await graph.addEdge(createDerivesFromEdge('var:nodes', 'call:1'));
      await graph.addEdge(createIteratesOverEdge('loop:ignored', 'var:nodes', 'values'));

      // Execute enricher WITH config that would match
      await executeEnricher(graph, {
        entryPoints: [{ pattern: 'graph.queryNodes', returns: 'nodes' }]
      });

      // Verify: Loop is still ignored despite config match
      const edge = graph.findIteratesOverEdge('loop:ignored');
      assert.strictEqual(
        edge?.metadata?.cardinality,
        undefined,
        'ignoreCardinality should take priority over config match'
      );
    });
  });
});
