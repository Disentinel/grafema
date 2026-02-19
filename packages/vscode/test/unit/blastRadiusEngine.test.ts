/**
 * Unit tests for BlastRadiusEngine -- REG-516
 *
 * Tests the pure BFS computation engine for blast radius analysis:
 * impact score computation, dependency BFS traversal, cycle detection,
 * guarantee discovery, and null-node handling.
 *
 * Mock setup: in-memory graph with FUNCTION/MODULE/GUARANTEE nodes
 * and directed CALLS/IMPORTS_FROM/GOVERNS edges.
 * No RFDB server needed -- pure logic tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode, WireEdge } from '@grafema/types';

// ============================================================================
// Types for BlastRadiusEngine (mirrors actual interfaces in blastRadiusEngine.ts)
// ============================================================================

interface BlastNode {
  id: string;
  name: string;
  file?: string;
  line?: number;
  nodeType: string;
  viaPath: string[];
}

interface GuaranteeInfo {
  id: string;
  name: string;
  file?: string;
  metadata?: Record<string, unknown>;
}

interface BlastRadiusResult {
  rootId: string;
  rootName: string;
  directDependents: BlastNode[];
  indirectDependents: BlastNode[];
  guaranteesAtRisk: GuaranteeInfo[];
  totalCount: number;
  fileCount: number;
  impactScore: number;
  impactLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

// ============================================================================
// Mock infrastructure
// ============================================================================

interface MockEdge {
  src: string;
  dst: string;
  edgeType: string;
  metadata: string;
}

interface MockGraph {
  nodes: Record<string, WireNode>;
  incoming: Record<string, MockEdge[]>;
}

/**
 * Helper to create a WireNode with sensible defaults.
 */
function makeNode(
  id: string,
  nodeType: string,
  name: string,
  overrides?: Partial<WireNode>,
): WireNode {
  return {
    id,
    nodeType: nodeType as WireNode['nodeType'],
    name,
    file: 'src/app.ts',
    exported: false,
    metadata: JSON.stringify({ line: 1 }),
    ...overrides,
  };
}

/**
 * Helper to create a directed edge for MockGraph.
 * For CALLS: src --CALLS--> dst means src calls dst.
 * For IMPORTS_FROM: src --IMPORTS_FROM--> dst means src imports from dst.
 * Incoming edges to a node = edges where dst is that node.
 */
function makeEdge(src: string, dst: string, edgeType = 'CALLS'): MockEdge {
  return { src, dst, edgeType, metadata: '{}' };
}

/**
 * Create a mock client backed by an in-memory graph.
 *
 * Implements the subset of RFDBClient used by blastRadiusEngine:
 *   - getIncomingEdges(id, edgeTypes) -> WireEdge[]
 *   - getNode(id) -> WireNode | null
 *   - queryNodes(query) -> AsyncGenerator<WireNode>
 */
function createMockClient(graph: MockGraph) {
  return {
    getNode: async (id: string): Promise<WireNode | null> => {
      return graph.nodes[id] ?? null;
    },
    getIncomingEdges: async (id: string, edgeTypes?: string[] | null): Promise<WireEdge[]> => {
      const edges = graph.incoming[id] ?? [];
      if (!edgeTypes) return edges as unknown as WireEdge[];
      return edges.filter((e) => edgeTypes.includes(e.edgeType)) as unknown as WireEdge[];
    },
    queryNodes: async function* (query: { nodeType?: string; file?: string }) {
      for (const node of Object.values(graph.nodes)) {
        if (query.nodeType && node.nodeType !== query.nodeType) continue;
        if (query.file && node.file !== query.file) continue;
        yield node;
      }
    },
  };
}

// ============================================================================
// Mock vscode module (needed because blastRadiusEngine may import from
// shared types that reference vscode)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    TreeItem: class { label: string; collapsibleState: number; constructor(l: string, c?: number) { this.label = l; this.collapsibleState = c ?? 0; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class { event = () => ({ dispose: () => {} }); fire() {} },
    ThemeIcon: class { id: string; constructor(id: string) { this.id = id; } },
    ThemeColor: class { id: string; constructor(id: string) { this.id = id; } },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
    Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
  },
} as any;

// ============================================================================
// Import the module under test
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const engineModule = require('../../src/blastRadiusEngine');
const { computeBlastRadius, computeImpactScore, DEPENDENCY_EDGE_TYPES } = engineModule;

// ============================================================================
// SECTION 1: computeImpactScore -- boundary values
// ============================================================================

describe('BlastRadiusEngine -- computeImpactScore', () => {
  it('score 0 (all zeros) -> LOW', () => {
    const result = computeImpactScore(0, 0, 0);
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.level, 'LOW');
  });

  it('score 10 (boundary) -> LOW', () => {
    // 10 indirect = 10 * 1 = 10
    const result = computeImpactScore(0, 10, 0);
    assert.strictEqual(result.score, 10);
    assert.strictEqual(result.level, 'LOW');
  });

  it('score 11 (boundary) -> MEDIUM', () => {
    // 11 indirect = 11 * 1 = 11
    const result = computeImpactScore(0, 11, 0);
    assert.strictEqual(result.score, 11);
    assert.strictEqual(result.level, 'MEDIUM');
  });

  it('score 30 (boundary) -> MEDIUM', () => {
    // 30 indirect = 30 * 1 = 30
    const result = computeImpactScore(0, 30, 0);
    assert.strictEqual(result.score, 30);
    assert.strictEqual(result.level, 'MEDIUM');
  });

  it('score 31 (boundary) -> HIGH', () => {
    // 31 indirect = 31 * 1 = 31
    const result = computeImpactScore(0, 31, 0);
    assert.strictEqual(result.score, 31);
    assert.strictEqual(result.level, 'HIGH');
  });

  it('formula: direct*3 + indirect*1 + guarantees*10', () => {
    // 4 direct + 5 indirect + 1 guarantee = 12 + 5 + 10 = 27
    const result = computeImpactScore(4, 5, 1);
    assert.strictEqual(result.score, 27);
    assert.strictEqual(result.level, 'MEDIUM');
  });

  it('guarantees alone: 1 guarantee = 10 -> LOW boundary', () => {
    const result = computeImpactScore(0, 0, 1);
    assert.strictEqual(result.score, 10);
    assert.strictEqual(result.level, 'LOW');
  });

  it('guarantees alone: 2 guarantees = 20 -> MEDIUM', () => {
    const result = computeImpactScore(0, 0, 2);
    assert.strictEqual(result.score, 20);
    assert.strictEqual(result.level, 'MEDIUM');
  });

  it('direct alone: 3 direct = 9 -> LOW, 4 direct = 12 -> MEDIUM', () => {
    const r1 = computeImpactScore(3, 0, 0);
    assert.strictEqual(r1.score, 9);
    assert.strictEqual(r1.level, 'LOW');

    const r2 = computeImpactScore(4, 0, 0);
    assert.strictEqual(r2.score, 12);
    assert.strictEqual(r2.level, 'MEDIUM');
  });
});

// ============================================================================
// SECTION 2: DEPENDENCY_EDGE_TYPES constant
// ============================================================================

describe('BlastRadiusEngine -- DEPENDENCY_EDGE_TYPES', () => {
  it('includes CALLS, IMPORTS_FROM, DEPENDS_ON, USES', () => {
    assert.ok(Array.isArray(DEPENDENCY_EDGE_TYPES), 'Should be an array');
    assert.ok(DEPENDENCY_EDGE_TYPES.includes('CALLS'), 'Should include CALLS');
    assert.ok(DEPENDENCY_EDGE_TYPES.includes('IMPORTS_FROM'), 'Should include IMPORTS_FROM');
    assert.ok(DEPENDENCY_EDGE_TYPES.includes('DEPENDS_ON'), 'Should include DEPENDS_ON');
    assert.ok(DEPENDENCY_EDGE_TYPES.includes('USES'), 'Should include USES');
  });
});

// ============================================================================
// SECTION 3: computeBlastRadius -- empty graph
// ============================================================================

describe('BlastRadiusEngine -- computeBlastRadius empty graph', () => {
  it('root node with no incoming edges -> 0 dependents', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'myFunc');

    const graph: MockGraph = {
      nodes: { root: rootNode },
      incoming: {},
    };

    const client = createMockClient(graph);
    const result: BlastRadiusResult = await computeBlastRadius(client, 'root', 3);

    assert.strictEqual(result.directDependents.length, 0, 'No direct dependents');
    assert.strictEqual(result.indirectDependents.length, 0, 'No indirect dependents');
    assert.strictEqual(result.totalCount, 0, 'Total count should be 0');
    assert.strictEqual(result.fileCount, 0, 'File count should be 0');
    assert.strictEqual(result.impactLevel, 'LOW', 'Impact level should be LOW');
  });
});

// ============================================================================
// SECTION 4: computeBlastRadius -- single direct dependent (1 hop)
// ============================================================================

describe('BlastRadiusEngine -- computeBlastRadius single direct dependent', () => {
  it('one node calls the root -> 1 direct dependent', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const callerNode = makeNode('caller1', 'FUNCTION', 'handleRequest', { file: 'src/handler.ts' });

    const graph: MockGraph = {
      nodes: { root: rootNode, caller1: callerNode },
      incoming: {
        root: [makeEdge('caller1', 'root', 'CALLS')],
      },
    };

    const client = createMockClient(graph);
    const result: BlastRadiusResult = await computeBlastRadius(client, 'root', 3);

    assert.strictEqual(result.directDependents.length, 1, 'Should have 1 direct dependent');
    assert.strictEqual(result.directDependents[0].id, 'caller1');
    assert.strictEqual(result.directDependents[0].name, 'handleRequest');
    assert.deepStrictEqual(result.directDependents[0].viaPath, [], 'Direct dependents have empty viaPath');
    assert.strictEqual(result.indirectDependents.length, 0, 'No indirect dependents');
    assert.strictEqual(result.totalCount, 1, 'Total count should be 1');
  });
});

// ============================================================================
// SECTION 5: computeBlastRadius -- indirect dependent (2 hops) with viaPath
// ============================================================================

describe('BlastRadiusEngine -- computeBlastRadius indirect dependent', () => {
  it('root <- A <- B (2 hops) -> B is indirect with viaPath containing A', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const nodeA = makeNode('nodeA', 'FUNCTION', 'handleRequest', { file: 'src/handler.ts' });
    const nodeB = makeNode('nodeB', 'FUNCTION', 'processOrder', { file: 'src/order.ts' });

    const graph: MockGraph = {
      nodes: { root: rootNode, nodeA: nodeA, nodeB: nodeB },
      incoming: {
        root: [makeEdge('nodeA', 'root', 'CALLS')],
        nodeA: [makeEdge('nodeB', 'nodeA', 'CALLS')],
      },
    };

    const client = createMockClient(graph);
    const result: BlastRadiusResult = await computeBlastRadius(client, 'root', 3);

    assert.strictEqual(result.directDependents.length, 1, 'Should have 1 direct dependent (A)');
    assert.strictEqual(result.directDependents[0].id, 'nodeA');

    assert.strictEqual(result.indirectDependents.length, 1, 'Should have 1 indirect dependent (B)');
    assert.strictEqual(result.indirectDependents[0].id, 'nodeB');

    // viaPath for B should contain A's name
    assert.ok(
      result.indirectDependents[0].viaPath.length > 0,
      'Indirect dependent should have a non-empty viaPath',
    );
    assert.ok(
      result.indirectDependents[0].viaPath.includes('handleRequest'),
      'viaPath should include the intermediate node name (handleRequest)',
    );

    assert.strictEqual(result.totalCount, 2, 'Total count should be 2');
  });
});

// ============================================================================
// SECTION 6: computeBlastRadius -- cycle detection (A -> B -> A)
// ============================================================================

describe('BlastRadiusEngine -- computeBlastRadius cycle detection', () => {
  it('A <- B <- A (cycle) -> terminates without infinite loop', async () => {
    const nodeA = makeNode('nodeA', 'FUNCTION', 'ping', { file: 'src/ping.ts' });
    const nodeB = makeNode('nodeB', 'FUNCTION', 'pong', { file: 'src/pong.ts' });

    // Mutual dependency: A calls B and B calls A
    // Incoming to A: B calls A
    // Incoming to B: A calls B
    const graph: MockGraph = {
      nodes: { nodeA, nodeB },
      incoming: {
        nodeA: [makeEdge('nodeB', 'nodeA', 'CALLS')],
        nodeB: [makeEdge('nodeA', 'nodeB', 'CALLS')],
      },
    };

    const client = createMockClient(graph);

    // This must terminate -- if it hangs, the test will timeout
    const result: BlastRadiusResult = await computeBlastRadius(client, 'nodeA', 5);

    // B should appear as a direct dependent of A
    assert.strictEqual(result.directDependents.length, 1, 'Should find B as direct dependent');
    assert.strictEqual(result.directDependents[0].id, 'nodeB');

    // A should NOT appear as indirect (visited set prevents re-visiting root)
    const allIds = [
      ...result.directDependents.map((d: BlastNode) => d.id),
      ...result.indirectDependents.map((d: BlastNode) => d.id),
    ];
    const uniqueIds = new Set(allIds);
    assert.strictEqual(allIds.length, uniqueIds.size, 'No duplicate nodes in results');
    assert.ok(!allIds.includes('nodeA'), 'Root node should not appear in dependents');
  });
});

// ============================================================================
// SECTION 7: computeBlastRadius -- getNode returns null mid-traversal
// ============================================================================

describe('BlastRadiusEngine -- computeBlastRadius null node handling', () => {
  it('getNode returns null for a dependent -> silently skipped', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const realCaller = makeNode('caller1', 'FUNCTION', 'handler', { file: 'src/handler.ts' });
    // ghost node is referenced by an edge but does not exist in the graph

    const graph: MockGraph = {
      nodes: {
        root: rootNode,
        caller1: realCaller,
        // ghost NOT in nodes -- getNode will return null
      },
      incoming: {
        root: [
          makeEdge('ghost', 'root', 'CALLS'),
          makeEdge('caller1', 'root', 'CALLS'),
        ],
      },
    };

    const client = createMockClient(graph);
    const result: BlastRadiusResult = await computeBlastRadius(client, 'root', 3);

    // Ghost node should be silently skipped, only real caller returned
    assert.strictEqual(result.directDependents.length, 1, 'Only non-null node should appear');
    assert.strictEqual(result.directDependents[0].id, 'caller1');
  });
});

// ============================================================================
// SECTION 8: computeBlastRadius -- guarantee discovery via GOVERNS edge
// ============================================================================

describe('BlastRadiusEngine -- computeBlastRadius guarantee discovery', () => {
  it('MODULE node with incoming GOVERNS edge -> guarantee found', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'processPayment', {
      file: 'src/payment.ts',
      metadata: JSON.stringify({ line: 10 }),
    });

    const moduleNode = makeNode('MODULE:src/payment.ts', 'MODULE', 'src/payment.ts', {
      file: 'src/payment.ts',
    });

    const guaranteeNode = makeNode('GUARANTEE:no-direct-db', 'GUARANTEE', 'no-direct-db', {
      file: '',
      metadata: JSON.stringify({ description: 'No direct DB access in controllers' }),
    });

    const graph: MockGraph = {
      nodes: {
        root: rootNode,
        'MODULE:src/payment.ts': moduleNode,
        'GUARANTEE:no-direct-db': guaranteeNode,
      },
      incoming: {
        // No callers for root -- we only test guarantee discovery
        // MODULE has incoming GOVERNS from guarantee
        'MODULE:src/payment.ts': [
          makeEdge('GUARANTEE:no-direct-db', 'MODULE:src/payment.ts', 'GOVERNS'),
        ],
      },
    };

    const client = createMockClient(graph);
    const result: BlastRadiusResult = await computeBlastRadius(client, 'root', 3);

    assert.strictEqual(result.guaranteesAtRisk.length, 1, 'Should find 1 guarantee at risk');
    assert.strictEqual(result.guaranteesAtRisk[0].id, 'GUARANTEE:no-direct-db');
    assert.strictEqual(result.guaranteesAtRisk[0].name, 'no-direct-db');
  });

  it('namespaced guarantee type (guarantee:queue) discovered via GOVERNS edge', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'enqueueJob', {
      file: 'src/queue.ts',
    });

    const moduleNode = makeNode('MODULE:src/queue.ts', 'MODULE', 'src/queue.ts', {
      file: 'src/queue.ts',
    });

    const guaranteeNode = makeNode('guarantee:queue#orders', 'guarantee:queue', 'orders-queue-guarantee', {
      file: '',
      metadata: JSON.stringify({ description: 'Queue ordering guarantee' }),
    });

    const graph: MockGraph = {
      nodes: {
        root: rootNode,
        'MODULE:src/queue.ts': moduleNode,
        'guarantee:queue#orders': guaranteeNode,
      },
      incoming: {
        'MODULE:src/queue.ts': [
          makeEdge('guarantee:queue#orders', 'MODULE:src/queue.ts', 'GOVERNS'),
        ],
      },
    };

    const client = createMockClient(graph);
    const result: BlastRadiusResult = await computeBlastRadius(client, 'root', 3);

    assert.strictEqual(result.guaranteesAtRisk.length, 1, 'Namespaced guarantee should be found via GOVERNS');
    assert.strictEqual(result.guaranteesAtRisk[0].id, 'guarantee:queue#orders');
    assert.strictEqual(result.guaranteesAtRisk[0].name, 'orders-queue-guarantee');
  });
});

// ============================================================================
// SECTION 9: computeBlastRadius -- root node with no file
// ============================================================================

describe('BlastRadiusEngine -- computeBlastRadius no file on root', () => {
  it('root node with no file -> guarantee discovery returns empty, no crash', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'noFileFunc', {
      file: '', // empty file
    });

    const graph: MockGraph = {
      nodes: { root: rootNode },
      incoming: {},
    };

    const client = createMockClient(graph);
    const result: BlastRadiusResult = await computeBlastRadius(client, 'root', 3);

    assert.strictEqual(result.guaranteesAtRisk.length, 0, 'No guarantees when root has no file');
    assert.strictEqual(result.totalCount, 0);
  });
});

// ============================================================================
// SECTION 10: computeBlastRadius -- file count is unique file count
// ============================================================================

describe('BlastRadiusEngine -- computeBlastRadius unique file count', () => {
  it('multiple dependents in the same file -> fileCount counts unique files', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    // Two callers in the same file, one in a different file
    const callerA = makeNode('callerA', 'FUNCTION', 'handlerA', { file: 'src/handler.ts' });
    const callerB = makeNode('callerB', 'FUNCTION', 'handlerB', { file: 'src/handler.ts' }); // same file
    const callerC = makeNode('callerC', 'FUNCTION', 'processOrder', { file: 'src/order.ts' });

    const graph: MockGraph = {
      nodes: { root: rootNode, callerA, callerB, callerC },
      incoming: {
        root: [
          makeEdge('callerA', 'root', 'CALLS'),
          makeEdge('callerB', 'root', 'CALLS'),
          makeEdge('callerC', 'root', 'CALLS'),
        ],
      },
    };

    const client = createMockClient(graph);
    const result: BlastRadiusResult = await computeBlastRadius(client, 'root', 3);

    assert.strictEqual(result.directDependents.length, 3, 'Should have 3 direct dependents');
    assert.strictEqual(result.totalCount, 3, 'Total count should be 3');
    // callerA and callerB share 'src/handler.ts', callerC is in 'src/order.ts'
    assert.strictEqual(result.fileCount, 2, 'File count should be 2 (unique files only)');
  });
});
