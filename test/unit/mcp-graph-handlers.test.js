/**
 * Tests for MCP graph handler logic — REG-521
 *
 * Tests three new MCP tools: get_node, get_neighbors, traverse_graph.
 *
 * These handlers expose low-level graph traversal operations for agents
 * that need direct graph access beyond Datalog queries.
 *
 * Test strategy: We import the internal logic functions that accept a
 * backend parameter directly, bypassing ensureAnalyzed(). This matches
 * the pattern used in FileOverview.test.js and DataFlowValidator.test.js.
 *
 * The handler module exports:
 * - handleGetNode / handleGetNeighbors / handleTraverseGraph (public, call ensureAnalyzed)
 * - getNodeLogic / getNeighborsLogic / traverseGraphLogic (internal, accept backend)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getNodeLogic,
  getNeighborsLogic,
  traverseGraphLogic,
} from '../../packages/mcp/dist/handlers/graph-handlers.js';

// ============================================================================
// Mock Backend
// ============================================================================

/**
 * Creates a mock graph backend with pre-loaded nodes and edges.
 *
 * Implements the GraphBackend subset used by graph-handlers:
 * - getNode(id) -> node | null
 * - getOutgoingEdges(id, types?) -> edges[]
 * - getIncomingEdges(id, types?) -> edges[]
 */
function createMockBackend(nodes, edges) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  return {
    async getNode(id) {
      return nodeMap.get(id) ?? null;
    },

    async getOutgoingEdges(nodeId, edgeTypes = null) {
      return edges.filter(e => {
        if (e.src !== nodeId) return false;
        if (edgeTypes && edgeTypes.length > 0 && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },

    async getIncomingEdges(nodeId, edgeTypes = null) {
      return edges.filter(e => {
        if (e.dst !== nodeId) return false;
        if (edgeTypes && edgeTypes.length > 0 && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },
  };
}

// ============================================================================
// Test Helpers
// ============================================================================

/** Extract text content from ToolResult */
function getText(result) {
  return result.content[0].text;
}

/** Check if ToolResult is an error */
function isError(result) {
  return result.isError === true;
}

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Simple linear graph: A -> B -> C
 *
 *   [FUNCTION] processData (A)
 *       |
 *       | CALLS
 *       v
 *   [FUNCTION] validate (B)
 *       |
 *       | CALLS
 *       v
 *   [FUNCTION] sanitize (C)
 */
function linearChainGraph() {
  const nodes = [
    { id: 'mod/fn/processData', type: 'FUNCTION', name: 'processData', file: 'src/app.js', line: 10 },
    { id: 'mod/fn/validate', type: 'FUNCTION', name: 'validate', file: 'src/utils.js', line: 20 },
    { id: 'mod/fn/sanitize', type: 'FUNCTION', name: 'sanitize', file: 'src/utils.js', line: 40 },
  ];

  const edges = [
    { src: 'mod/fn/processData', dst: 'mod/fn/validate', type: 'CALLS' },
    { src: 'mod/fn/validate', dst: 'mod/fn/sanitize', type: 'CALLS' },
  ];

  return { nodes, edges };
}

/**
 * Graph with multiple edge types and directions
 *
 *   [CLASS] UserService
 *       |                \
 *       | CONTAINS        \ EXTENDS
 *       v                  v
 *   [FUNCTION] getUser    [CLASS] BaseService
 *       |
 *       | CALLS
 *       v
 *   [FUNCTION] findById
 */
function mixedEdgeGraph() {
  const nodes = [
    { id: 'cls/UserService', type: 'CLASS', name: 'UserService', file: 'src/user.js', line: 1 },
    { id: 'fn/getUser', type: 'FUNCTION', name: 'getUser', file: 'src/user.js', line: 5 },
    { id: 'cls/BaseService', type: 'CLASS', name: 'BaseService', file: 'src/base.js', line: 1 },
    { id: 'fn/findById', type: 'FUNCTION', name: 'findById', file: 'src/db.js', line: 10 },
  ];

  const edges = [
    { src: 'cls/UserService', dst: 'fn/getUser', type: 'CONTAINS' },
    { src: 'cls/UserService', dst: 'cls/BaseService', type: 'EXTENDS' },
    { src: 'fn/getUser', dst: 'fn/findById', type: 'CALLS' },
  ];

  return { nodes, edges };
}

/**
 * Graph with a cycle: A -> B -> A
 */
function cyclicGraph() {
  const nodes = [
    { id: 'fn/ping', type: 'FUNCTION', name: 'ping', file: 'src/net.js', line: 1 },
    { id: 'fn/pong', type: 'FUNCTION', name: 'pong', file: 'src/net.js', line: 10 },
  ];

  const edges = [
    { src: 'fn/ping', dst: 'fn/pong', type: 'CALLS' },
    { src: 'fn/pong', dst: 'fn/ping', type: 'CALLS' },
  ];

  return { nodes, edges };
}

// ============================================================================
// Tests: get_node
// ============================================================================

describe('getNodeLogic', () => {
  it('should return full node data for a valid semantic ID', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNodeLogic(db, { semanticId: 'mod/fn/processData' });

    assert.equal(isError(result), false);
    const text = getText(result);
    assert.ok(text.includes('processData'), 'Result should contain node name');
    assert.ok(text.includes('FUNCTION'), 'Result should contain node type');
    assert.ok(text.includes('src/app.js'), 'Result should contain file path');
  });

  it('should return error for a non-existent semantic ID', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNodeLogic(db, { semanticId: 'does/not/exist' });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(text.includes('does/not/exist'), 'Error should mention the requested ID');
  });

  it('should return error for empty string semantic ID', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNodeLogic(db, { semanticId: '' });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(
      text.toLowerCase().includes('empty') || text.toLowerCase().includes('required'),
      'Error should indicate that semantic ID is required'
    );
  });
});

// ============================================================================
// Tests: get_neighbors
// ============================================================================

describe('getNeighborsLogic', () => {
  it('should return outgoing and incoming edges grouped by type for both directions', async () => {
    const { nodes, edges } = mixedEdgeGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNeighborsLogic(db, {
      semanticId: 'cls/UserService',
      direction: 'both',
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // UserService has outgoing CONTAINS and EXTENDS edges
    assert.ok(text.includes('CONTAINS'), 'Should include CONTAINS edge type');
    assert.ok(text.includes('EXTENDS'), 'Should include EXTENDS edge type');
  });

  it('should return only outgoing edges when direction is outgoing', async () => {
    const { nodes, edges } = mixedEdgeGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNeighborsLogic(db, {
      semanticId: 'fn/getUser',
      direction: 'outgoing',
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // fn/getUser has outgoing CALLS edge to fn/findById
    assert.ok(text.includes('CALLS'), 'Should include outgoing CALLS edge');
    assert.ok(text.includes('findById'), 'Should include target node name');
  });

  it('should return only incoming edges when direction is incoming', async () => {
    const { nodes, edges } = mixedEdgeGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNeighborsLogic(db, {
      semanticId: 'fn/getUser',
      direction: 'incoming',
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // fn/getUser has incoming CONTAINS edge from cls/UserService
    assert.ok(text.includes('CONTAINS'), 'Should include incoming CONTAINS edge');
    assert.ok(text.includes('UserService'), 'Should include source node name');
  });

  it('should return empty groups for a node with no edges', async () => {
    const nodes = [
      { id: 'fn/isolated', type: 'FUNCTION', name: 'isolated', file: 'src/orphan.js', line: 1 },
    ];
    const db = createMockBackend(nodes, []);

    const result = await getNeighborsLogic(db, {
      semanticId: 'fn/isolated',
      direction: 'both',
    });

    assert.equal(isError(result), false);
    const parsed = JSON.parse(getText(result));
    // Empty groups: outgoing and incoming should be empty objects
    assert.deepEqual(parsed.outgoing, {}, 'Outgoing should be empty');
    assert.deepEqual(parsed.incoming, {}, 'Incoming should be empty');
  });

  it('should filter edges by type when edgeTypes is provided', async () => {
    const { nodes, edges } = mixedEdgeGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNeighborsLogic(db, {
      semanticId: 'cls/UserService',
      direction: 'outgoing',
      edgeTypes: ['CONTAINS'],
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    assert.ok(text.includes('CONTAINS'), 'Should include filtered CONTAINS edges');
    // EXTENDS should NOT be present when filtering to CONTAINS only
    assert.ok(!text.includes('EXTENDS'), 'Should NOT include EXTENDS when filtering to CONTAINS');
  });

  it('should return error for empty edgeTypes array', async () => {
    const { nodes, edges } = mixedEdgeGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNeighborsLogic(db, {
      semanticId: 'cls/UserService',
      direction: 'both',
      edgeTypes: [],
    });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(
      text.toLowerCase().includes('empty') || text.toLowerCase().includes('edgetype'),
      'Error should mention empty edgeTypes'
    );
  });

  it('should return error for non-existent node', async () => {
    const { nodes, edges } = mixedEdgeGraph();
    const db = createMockBackend(nodes, edges);

    const result = await getNeighborsLogic(db, {
      semanticId: 'does/not/exist',
      direction: 'both',
    });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(text.includes('does/not/exist'), 'Error should mention the requested ID');
  });
});

// ============================================================================
// Tests: traverse_graph
// ============================================================================

describe('traverseGraphLogic', () => {
  it('should traverse a linear chain A->B->C with correct depth tracking', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/processData'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 5,
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // Should find all three nodes in the chain
    assert.ok(text.includes('processData'), 'Should include start node');
    assert.ok(text.includes('validate'), 'Should include depth-1 node');
    assert.ok(text.includes('sanitize'), 'Should include depth-2 node');
  });

  it('should follow outgoing edges in outgoing direction', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/validate'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 5,
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // Starting from validate, outgoing should reach sanitize only
    assert.ok(text.includes('validate'), 'Should include start node');
    assert.ok(text.includes('sanitize'), 'Should include outgoing neighbor');
    // processData is upstream -- should NOT appear in outgoing traversal
    assert.ok(!text.includes('processData'), 'Should NOT include upstream node in outgoing traversal');
  });

  it('should follow incoming edges in incoming direction', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/sanitize'],
      edgeTypes: ['CALLS'],
      direction: 'incoming',
      maxDepth: 5,
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // Starting from sanitize, incoming should reach validate and processData
    assert.ok(text.includes('sanitize'), 'Should include start node');
    assert.ok(text.includes('validate'), 'Should include incoming caller');
    assert.ok(text.includes('processData'), 'Should include transitive incoming caller');
  });

  it('should respect maxDepth limit (depth 1 does not reach depth 2 nodes)', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/processData'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 1,
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // maxDepth=1: start node (depth 0) + validate (depth 1), NOT sanitize (depth 2)
    assert.ok(text.includes('processData'), 'Should include start node (depth 0)');
    assert.ok(text.includes('validate'), 'Should include depth-1 node');
    assert.ok(!text.includes('sanitize'), 'Should NOT include depth-2 node when maxDepth=1');
  });

  it('should handle cycles without infinite loop (A->B->A)', async () => {
    const { nodes, edges } = cyclicGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['fn/ping'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 10,
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // BFS with visited-set should find both nodes without hanging
    assert.ok(text.includes('ping'), 'Should include start node');
    assert.ok(text.includes('pong'), 'Should include cycle neighbor');
  });

  it('should deduplicate startNodeIds', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/processData', 'mod/fn/processData', 'mod/fn/processData'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 0,
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    // With maxDepth=0 we get only start nodes. 3 duplicates should collapse to 1.
    assert.ok(text.includes('processData'), 'processData should appear in results');
  });

  it('should return only start nodes when maxDepth is 0', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/processData'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 0,
    });

    assert.equal(isError(result), false);
    const text = getText(result);
    assert.ok(text.includes('processData'), 'Should include start node');
    assert.ok(!text.includes('validate'), 'Should NOT include neighbors at maxDepth=0');
    assert.ok(!text.includes('sanitize'), 'Should NOT include depth-2 nodes at maxDepth=0');
  });

  it('should return error when maxDepth exceeds 20', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/processData'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 21,
    });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(
      text.includes('20') || text.toLowerCase().includes('max'),
      'Error should mention the maximum depth limit'
    );
  });

  it('should return error when maxDepth is negative', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/processData'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: -1,
    });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(
      text.toLowerCase().includes('negative') || text.includes('0') || text.includes('invalid'),
      'Error should indicate negative depth is invalid'
    );
  });

  it('should return error when startNodeIds is empty', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: [],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 5,
    });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(
      text.toLowerCase().includes('empty') || text.toLowerCase().includes('required') || text.toLowerCase().includes('start'),
      'Error should indicate startNodeIds is required'
    );
  });

  it('should return error when edgeTypes is empty', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['mod/fn/processData'],
      edgeTypes: [],
      direction: 'outgoing',
      maxDepth: 5,
    });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(
      text.toLowerCase().includes('empty') || text.toLowerCase().includes('edgetype'),
      'Error should indicate edgeTypes is required'
    );
  });

  it('should return error for non-existent start node', async () => {
    const { nodes, edges } = linearChainGraph();
    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['does/not/exist'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 5,
    });

    assert.equal(isError(result), true);
    const text = getText(result);
    assert.ok(text.includes('does/not/exist'), 'Error should mention the non-existent node');
  });

  it('should enforce result limit of 10,000 nodes', async () => {
    // Star topology: one center node with 10,001 leaf nodes
    const nodes = [
      { id: 'center', type: 'FUNCTION', name: 'center', file: 'src/big.js', line: 1 },
    ];
    const edges = [];

    for (let i = 0; i < 10_001; i++) {
      const nodeId = `leaf/${i}`;
      nodes.push({ id: nodeId, type: 'FUNCTION', name: `leaf${i}`, file: 'src/big.js', line: i + 2 });
      edges.push({ src: 'center', dst: nodeId, type: 'CALLS' });
    }

    const db = createMockBackend(nodes, edges);

    const result = await traverseGraphLogic(db, {
      startNodeIds: ['center'],
      edgeTypes: ['CALLS'],
      direction: 'outgoing',
      maxDepth: 1,
    });

    // Handler should truncate at 10,000 or warn about the limit
    const text = getText(result);
    assert.ok(
      text.includes('10,000') || text.includes('10000') || text.includes('limit') || text.toLowerCase().includes('truncat'),
      'Should mention the result limit when exceeded'
    );
  });
});
