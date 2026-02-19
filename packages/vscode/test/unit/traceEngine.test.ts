/**
 * Unit tests for traceEngine.ts — REG-513
 *
 * Tests backward/forward BFS traversal, source classification,
 * gap detection, and branching factor limits.
 *
 * Mock setup: in-memory graph with nodes and directed edges.
 * No RFDB server needed — pure logic tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode, WireEdge, IRFDBClient } from '@grafema/types';
import { parseNodeMetadata } from '../../src/types.js';
import type { NodeMetadata } from '../../src/types.js';

// ============================================================================
// Types used by traceEngine (defined here until src/types.ts is updated)
// ============================================================================

type SourceKind = 'user-input' | 'literal' | 'config' | 'external' | 'unknown';

interface TraceNode {
  node: WireNode;
  metadata: NodeMetadata;
  edgeType: string;
  depth: number;
  sourceKind?: SourceKind;
  children: TraceNode[];
  hasMoreChildren?: boolean;
}

interface TraceGap {
  nodeId: string;
  nodeName: string;
  description: string;
  heuristic: 'no-origins';
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
  outgoing: Record<string, MockEdge[]>;
  incoming: Record<string, MockEdge[]>;
}

/**
 * Create a mock IRFDBClient backed by an in-memory graph.
 *
 * Only implements the three methods traceEngine uses:
 *   - getNode(id) -> WireNode | null
 *   - getOutgoingEdges(id, edgeTypes) -> WireEdge[]
 *   - getIncomingEdges(id, edgeTypes) -> WireEdge[]
 */
function createMockClient(graph: MockGraph): IRFDBClient {
  return {
    getNode: async (id: string) => graph.nodes[id] ?? null,
    getOutgoingEdges: async (id: string, edgeTypes?: string[] | null) => {
      const edges = graph.outgoing[id] ?? [];
      if (!edgeTypes) return edges as unknown as WireEdge[];
      return edges.filter((e) => edgeTypes.includes(e.edgeType)) as unknown as WireEdge[];
    },
    getIncomingEdges: async (id: string, edgeTypes?: string[] | null) => {
      const edges = graph.incoming[id] ?? [];
      if (!edgeTypes) return edges as unknown as WireEdge[];
      return edges.filter((e) => edgeTypes.includes(e.edgeType)) as unknown as WireEdge[];
    },
  } as IRFDBClient;
}

/**
 * Helper to create a WireNode with sensible defaults.
 *
 * @param id - Unique node identifier
 * @param nodeType - Graph node type (VARIABLE, LITERAL, PARAMETER, etc.)
 * @param name - Human-readable name
 * @param overrides - Override any WireNode field
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
    file: 'test.ts',
    exported: false,
    metadata: JSON.stringify({ line: 1 }),
    ...overrides,
  };
}

/**
 * Helper to create an edge record for MockGraph.
 */
function makeEdge(src: string, dst: string, edgeType: string): MockEdge {
  return { src, dst, edgeType, metadata: '{}' };
}

// ============================================================================
// Import the module under test
//
// These imports will resolve once traceEngine.ts is implemented.
// If the module does not exist yet, the test file will fail to load
// with a clear import error — that is intentional.
// ============================================================================

// Use require() because vscode package is CJS (no "type":"module" in package.json)
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const traceEngine = require('../../src/traceEngine');
const { traceBackward, traceForward, classifySource, detectGaps, computeCoverage } = traceEngine;

// ============================================================================
// SECTION 1: traceBackward
// ============================================================================

describe('traceBackward', () => {
  it('empty graph (no outgoing edges) returns empty array', async () => {
    const graph: MockGraph = {
      nodes: { A: makeNode('A', 'VARIABLE', 'x') },
      outgoing: {},
      incoming: {},
    };
    const client = createMockClient(graph);

    const { nodes: result, truncated } = await traceBackward(client, 'A', 3);

    assert.strictEqual(result.length, 0, 'No origins expected when node has no outgoing edges');
    assert.strictEqual(truncated, false);
  });

  it('depth 1 — single ASSIGNED_FROM edge returns one origin', async () => {
    // Graph: A --ASSIGNED_FROM--> B (A gets its value from B)
    const graph: MockGraph = {
      nodes: {
        A: makeNode('A', 'VARIABLE', 'a'),
        B: makeNode('B', 'VARIABLE', 'b'),
      },
      outgoing: {
        A: [makeEdge('A', 'B', 'ASSIGNED_FROM')],
      },
      incoming: {
        B: [makeEdge('A', 'B', 'ASSIGNED_FROM')],
      },
    };
    const client = createMockClient(graph);

    const { nodes: result } = await traceBackward(client, 'A', 3);

    assert.strictEqual(result.length, 1, 'Should find exactly one origin');
    assert.strictEqual(result[0].node.id, 'B');
    assert.strictEqual(result[0].edgeType, 'ASSIGNED_FROM');
    assert.strictEqual(result[0].depth, 0, 'First hop is depth 0');
    assert.strictEqual(result[0].children.length, 0, 'B has no further origins');
    assert.strictEqual(result[0].sourceKind, 'unknown', 'VARIABLE leaf with no origins is unknown');
  });

  it('depth 3 — linear chain A->B->C->D returns nested tree', async () => {
    // A gets value from B, B from C, C from D (LITERAL)
    const graph: MockGraph = {
      nodes: {
        A: makeNode('A', 'VARIABLE', 'a'),
        B: makeNode('B', 'VARIABLE', 'b', { metadata: JSON.stringify({ line: 10 }) }),
        C: makeNode('C', 'VARIABLE', 'c', { metadata: JSON.stringify({ line: 20 }) }),
        D: makeNode('D', 'LITERAL', '"value"', { metadata: JSON.stringify({ line: 30 }) }),
      },
      outgoing: {
        A: [makeEdge('A', 'B', 'ASSIGNED_FROM')],
        B: [makeEdge('B', 'C', 'ASSIGNED_FROM')],
        C: [makeEdge('C', 'D', 'ASSIGNED_FROM')],
      },
      incoming: {},
    };
    const client = createMockClient(graph);

    const { nodes: result } = await traceBackward(client, 'A', 3);

    assert.strictEqual(result.length, 1, 'One direct origin: B');
    assert.strictEqual(result[0].node.id, 'B');
    assert.strictEqual(result[0].depth, 0);

    assert.strictEqual(result[0].children.length, 1, 'B has one child: C');
    assert.strictEqual(result[0].children[0].node.id, 'C');
    assert.strictEqual(result[0].children[0].depth, 1);

    assert.strictEqual(result[0].children[0].children.length, 1, 'C has one child: D');
    const leafD = result[0].children[0].children[0];
    assert.strictEqual(leafD.node.id, 'D');
    assert.strictEqual(leafD.depth, 2);
    assert.strictEqual(leafD.children.length, 0, 'D is a leaf');
    assert.strictEqual(leafD.sourceKind, 'literal', 'LITERAL leaf classified as literal');
  });

  it('cycle A->B->A terminates without hanging', async () => {
    // A --ASSIGNED_FROM--> B, B --ASSIGNED_FROM--> A (cycle)
    const graph: MockGraph = {
      nodes: {
        A: makeNode('A', 'VARIABLE', 'a'),
        B: makeNode('B', 'VARIABLE', 'b'),
      },
      outgoing: {
        A: [makeEdge('A', 'B', 'ASSIGNED_FROM')],
        B: [makeEdge('B', 'A', 'ASSIGNED_FROM')],
      },
      incoming: {},
    };
    const client = createMockClient(graph);

    // Use large maxDepth to verify cycle detection, not depth limit, stops recursion
    const { nodes: result } = await traceBackward(client, 'A', 10);

    assert.strictEqual(result.length, 1, 'Direct origin: B');
    assert.strictEqual(result[0].node.id, 'B');

    // B tries to trace back to A, but A is in visited set -> cycle leaf
    assert.strictEqual(result[0].children.length, 1, 'B has one child: A (cycle leaf)');
    assert.strictEqual(result[0].children[0].node.id, 'A');
    assert.strictEqual(result[0].children[0].children.length, 0, 'Cycle leaf has no further children');
  });

  it('branching — two ASSIGNED_FROM edges return two origins', async () => {
    // A --ASSIGNED_FROM--> B, A --ASSIGNED_FROM--> C
    const graph: MockGraph = {
      nodes: {
        A: makeNode('A', 'VARIABLE', 'a'),
        B: makeNode('B', 'LITERAL', '"foo"'),
        C: makeNode('C', 'LITERAL', '"bar"'),
      },
      outgoing: {
        A: [
          makeEdge('A', 'B', 'ASSIGNED_FROM'),
          makeEdge('A', 'C', 'ASSIGNED_FROM'),
        ],
      },
      incoming: {},
    };
    const client = createMockClient(graph);

    const { nodes: result } = await traceBackward(client, 'A', 3);

    assert.strictEqual(result.length, 2, 'Two origins expected');
    const ids = result.map((r) => r.node.id).sort();
    assert.deepStrictEqual(ids, ['B', 'C']);
    assert.strictEqual(result[0].sourceKind, 'literal');
    assert.strictEqual(result[1].sourceKind, 'literal');
  });

  it('MAX_BRANCHING_FACTOR caps at 5 edges, sets hasMoreChildren', async () => {
    // Node A has 7 ASSIGNED_FROM edges -> B1..B7
    const nodes: Record<string, WireNode> = {
      A: makeNode('A', 'VARIABLE', 'a'),
    };
    const edges: MockEdge[] = [];
    for (let i = 1; i <= 7; i++) {
      const id = `B${i}`;
      nodes[id] = makeNode(id, 'LITERAL', `"v${i}"`);
      edges.push(makeEdge('A', id, 'ASSIGNED_FROM'));
    }

    const graph: MockGraph = {
      nodes,
      outgoing: { A: edges },
      incoming: {},
    };
    const client = createMockClient(graph);

    const { nodes: result, truncated } = await traceBackward(client, 'A', 3);

    assert.strictEqual(result.length, 5, 'Capped at MAX_BRANCHING_FACTOR=5');
    assert.strictEqual(truncated, true, 'Top-level truncated flag is set');
    // hasMoreChildren should NOT be on the last child — it belongs on the parent
    assert.strictEqual(result[4].hasMoreChildren, undefined, 'Last child must not have hasMoreChildren');
  });
});

// ============================================================================
// SECTION 2: traceForward
// ============================================================================

describe('traceForward', () => {
  it('single consumer — B ASSIGNED_FROM A finds B', async () => {
    // B --ASSIGNED_FROM--> A means B gets value from A.
    // Forward trace of A: getIncomingEdges(A, [...]) -> edge with src=B -> follow B
    const graph: MockGraph = {
      nodes: {
        A: makeNode('A', 'VARIABLE', 'a'),
        B: makeNode('B', 'VARIABLE', 'b'),
      },
      outgoing: {
        B: [makeEdge('B', 'A', 'ASSIGNED_FROM')],
      },
      incoming: {
        A: [makeEdge('B', 'A', 'ASSIGNED_FROM')],
      },
    };
    const client = createMockClient(graph);

    const { nodes: result } = await traceForward(client, 'A', 3);

    assert.strictEqual(result.length, 1, 'Should find one consumer');
    assert.strictEqual(result[0].node.id, 'B');
  });

  it('empty graph (no incoming edges) returns empty array', async () => {
    const graph: MockGraph = {
      nodes: { A: makeNode('A', 'VARIABLE', 'x') },
      outgoing: {},
      incoming: {},
    };
    const client = createMockClient(graph);

    const { nodes: result } = await traceForward(client, 'A', 3);

    assert.strictEqual(result.length, 0, 'No consumers expected');
  });

  it('cycle B->A, A->B terminates without hanging', async () => {
    // Mutual assignment: B ASSIGNED_FROM A, A ASSIGNED_FROM B
    // Forward trace of A: finds B (incoming edge src=B),
    //   then B's forward: finds A (incoming edge src=A), but A is visited -> stop
    const graph: MockGraph = {
      nodes: {
        A: makeNode('A', 'VARIABLE', 'a'),
        B: makeNode('B', 'VARIABLE', 'b'),
      },
      outgoing: {
        A: [makeEdge('A', 'B', 'ASSIGNED_FROM')],
        B: [makeEdge('B', 'A', 'ASSIGNED_FROM')],
      },
      incoming: {
        A: [makeEdge('B', 'A', 'ASSIGNED_FROM')],
        B: [makeEdge('A', 'B', 'ASSIGNED_FROM')],
      },
    };
    const client = createMockClient(graph);

    const { nodes: result } = await traceForward(client, 'A', 10);

    assert.strictEqual(result.length, 1, 'Should find B as consumer');
    assert.strictEqual(result[0].node.id, 'B');
    // B's forward would find A, but A is visited -> no infinite loop
  });
});

// ============================================================================
// SECTION 3: classifySource
// ============================================================================

describe('classifySource', () => {
  it('LITERAL node returns "literal"', () => {
    const node = makeNode('L1', 'LITERAL', '"admin"');
    assert.strictEqual(classifySource(node), 'literal');
  });

  it('http:request node returns "user-input"', () => {
    const node = makeNode('HR1', 'http:request', 'request');
    assert.strictEqual(classifySource(node), 'user-input');
  });

  it('PARAMETER named "req" returns "user-input"', () => {
    const node = makeNode('P1', 'PARAMETER', 'req');
    assert.strictEqual(classifySource(node), 'user-input');
  });

  it('PARAMETER named "body" returns "user-input"', () => {
    const node = makeNode('P2', 'PARAMETER', 'body');
    assert.strictEqual(classifySource(node), 'user-input');
  });

  it('PARAMETER named "ctx" returns "user-input"', () => {
    const node = makeNode('P3', 'PARAMETER', 'ctx');
    assert.strictEqual(classifySource(node), 'user-input');
  });

  it('CONSTANT node returns "config"', () => {
    const node = makeNode('C1', 'CONSTANT', 'MAX_RETRIES');
    assert.strictEqual(classifySource(node), 'config');
  });

  it('db:query node returns "external"', () => {
    const node = makeNode('DB1', 'db:query', 'db.findOne');
    assert.strictEqual(classifySource(node), 'external');
  });

  it('EXTERNAL node returns "external"', () => {
    const node = makeNode('EX1', 'EXTERNAL', 'lodash.get');
    assert.strictEqual(classifySource(node), 'external');
  });

  it('regular VARIABLE returns "unknown"', () => {
    const node = makeNode('V1', 'VARIABLE', 'counter');
    assert.strictEqual(classifySource(node), 'unknown');
  });

  it('PARAMETER with non-HTTP name returns "unknown"', () => {
    const node = makeNode('P4', 'PARAMETER', 'callback');
    assert.strictEqual(classifySource(node), 'unknown');
  });
});

// ============================================================================
// SECTION 4: detectGaps
// ============================================================================

describe('detectGaps', () => {
  it('VARIABLE leaf with sourceKind="unknown" is a gap', () => {
    const traceNodes: TraceNode[] = [
      {
        node: makeNode('X', 'VARIABLE', 'x'),
        metadata: parseNodeMetadata(makeNode('X', 'VARIABLE', 'x')),
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: 'unknown',
        children: [],
      },
    ];

    const gaps = detectGaps(traceNodes);

    assert.strictEqual(gaps.length, 1);
    assert.strictEqual(gaps[0].nodeId, 'X');
    assert.strictEqual(gaps[0].heuristic, 'no-origins');
    assert.ok(
      gaps[0].description.includes('x'),
      'Gap description should mention the node name',
    );
  });

  it('LITERAL leaf is NOT a gap', () => {
    const traceNodes: TraceNode[] = [
      {
        node: makeNode('L', 'LITERAL', '"admin"'),
        metadata: parseNodeMetadata(makeNode('L', 'LITERAL', '"admin"')),
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: 'literal',
        children: [],
      },
    ];

    const gaps = detectGaps(traceNodes);

    assert.strictEqual(gaps.length, 0, 'Literal leaf is intentional, not a gap');
  });

  it('nested VARIABLE gap is detected inside children', () => {
    // Parent has children, one child is a gap
    const childGap: TraceNode = {
      node: makeNode('Y', 'VARIABLE', 'y'),
      metadata: parseNodeMetadata(makeNode('Y', 'VARIABLE', 'y')),
      edgeType: 'ASSIGNED_FROM',
      depth: 1,
      sourceKind: 'unknown',
      children: [],
    };

    const traceNodes: TraceNode[] = [
      {
        node: makeNode('B', 'VARIABLE', 'b'),
        metadata: parseNodeMetadata(makeNode('B', 'VARIABLE', 'b')),
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: undefined,
        children: [childGap],
      },
    ];

    const gaps = detectGaps(traceNodes);

    assert.strictEqual(gaps.length, 1);
    assert.strictEqual(gaps[0].nodeId, 'Y');
  });

  it('CONSTANT leaf is NOT a gap', () => {
    const traceNodes: TraceNode[] = [
      {
        node: makeNode('C', 'CONSTANT', 'API_KEY'),
        metadata: parseNodeMetadata(makeNode('C', 'CONSTANT', 'API_KEY')),
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: 'config',
        children: [],
      },
    ];

    const gaps = detectGaps(traceNodes);

    assert.strictEqual(gaps.length, 0, 'CONSTANT leaf is intentional config, not a gap');
  });
});

// ============================================================================
// SECTION 5: computeCoverage
// ============================================================================

describe('computeCoverage', () => {
  it('empty trace returns 0/0', () => {
    const { traced, total } = computeCoverage([]);
    assert.strictEqual(traced, 0);
    assert.strictEqual(total, 0);
  });

  it('all traced leaves count correctly', () => {
    const traceNodes: TraceNode[] = [
      {
        node: makeNode('L1', 'LITERAL', '"foo"'),
        metadata: parseNodeMetadata(makeNode('L1', 'LITERAL', '"foo"')),
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: 'literal',
        children: [],
      },
      {
        node: makeNode('H1', 'http:request', 'req'),
        metadata: parseNodeMetadata(makeNode('H1', 'http:request', 'req')),
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: 'user-input',
        children: [],
      },
    ];

    const { traced, total } = computeCoverage(traceNodes);
    assert.strictEqual(total, 2, 'Two leaf paths');
    assert.strictEqual(traced, 2, 'Both have known sourceKind');
  });

  it('mixed traced and unknown leaves', () => {
    const traceNodes: TraceNode[] = [
      {
        node: makeNode('B', 'VARIABLE', 'b'),
        metadata: parseNodeMetadata(makeNode('B', 'VARIABLE', 'b')),
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: undefined,
        children: [
          {
            node: makeNode('L1', 'LITERAL', '"val"'),
            metadata: parseNodeMetadata(makeNode('L1', 'LITERAL', '"val"')),
            edgeType: 'ASSIGNED_FROM',
            depth: 1,
            sourceKind: 'literal',
            children: [],
          },
          {
            node: makeNode('V1', 'VARIABLE', 'x'),
            metadata: parseNodeMetadata(makeNode('V1', 'VARIABLE', 'x')),
            edgeType: 'ASSIGNED_FROM',
            depth: 1,
            sourceKind: 'unknown',
            children: [],
          },
        ],
      },
    ];

    const { traced, total } = computeCoverage(traceNodes);
    assert.strictEqual(total, 2, 'Two leaf paths (L1 and V1)');
    assert.strictEqual(traced, 1, 'Only L1 is traced');
  });
});
