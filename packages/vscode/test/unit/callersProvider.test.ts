/**
 * Unit tests for CallersProvider — REG-514
 *
 * Tests the CALLERS panel TreeDataProvider: incoming/outgoing sections,
 * cycle detection, test file & node_modules filtering, branching factor cap,
 * depth limits, and direction modes.
 *
 * Mock setup: in-memory graph with FUNCTION nodes and directed CALLS edges.
 * No RFDB server needed — pure logic tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode, WireEdge, IRFDBClient } from '@grafema/types';
import { parseNodeMetadata } from '../../src/types.js';
import type { NodeMetadata } from '../../src/types.js';

// ============================================================================
// Types for CallersProvider (defined here — Rob will implement the module)
// ============================================================================

interface CallersItemRoot {
  kind: 'root';
  node: WireNode;
  metadata: NodeMetadata;
}

interface CallersItemSection {
  kind: 'section';
  label: string;
  icon: string;
  direction: 'incoming' | 'outgoing';
  count: number;
}

interface CallersItemCallNode {
  kind: 'call-node';
  node: WireNode;
  metadata: NodeMetadata;
  direction: 'incoming' | 'outgoing';
  depth: number;
  visitedIds: Set<string>;
}

interface CallersItemStatus {
  kind: 'status';
  message: string;
}

interface CallersItemMore {
  kind: 'more';
  count: number;
}

type CallersItem =
  | CallersItemRoot
  | CallersItemSection
  | CallersItemCallNode
  | CallersItemStatus
  | CallersItemMore;

// ============================================================================
// Mock infrastructure (same pattern as traceEngine.test.ts)
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
 * Implements:
 *   - getNode(id) -> WireNode | null
 *   - getOutgoingEdges(id, edgeTypes) -> WireEdge[]
 *   - getIncomingEdges(id, edgeTypes) -> WireEdge[]
 *   - getAllNodes(query) -> WireNode[]
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
    getAllNodes: async (query?: { file?: string; nodeType?: string }) => {
      return Object.values(graph.nodes).filter((n) => {
        if (query?.file && n.file !== query.file) return false;
        if (query?.nodeType && n.nodeType !== query.nodeType) return false;
        return true;
      });
    },
  } as IRFDBClient;
}

/**
 * Helper to create a WireNode with sensible defaults for FUNCTION nodes.
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
 * Helper to create a CALLS edge for MockGraph.
 * CALLS edge convention: src --CALLS--> dst means src calls dst.
 * Incoming CALLS edges of a function = its callers.
 * Outgoing CALLS edges of a function = its callees.
 */
function makeEdge(src: string, dst: string, edgeType = 'CALLS'): MockEdge {
  return { src, dst, edgeType, metadata: '{}' };
}

// ============================================================================
// Mock vscode module
//
// CallersProvider uses vscode.TreeItem, vscode.TreeItemCollapsibleState, etc.
// We inject a minimal mock before importing the module under test.
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};

class MockTreeItem {
  label: string;
  collapsibleState: number;
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;

  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? 0;
  }
}

class MockEventEmitter {
  private _handler: ((e: unknown) => void) | null = null;
  event = (handler: (e: unknown) => void) => {
    this._handler = handler;
    return { dispose: () => { this._handler = null; } };
  };
  fire(data?: unknown) {
    if (this._handler) this._handler(data);
  }
}

class MockThemeIcon {
  id: string;
  color?: unknown;
  constructor(id: string, color?: unknown) {
    this.id = id;
    this.color = color;
  }
}

class MockThemeColor {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    TreeItem: MockTreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: MockEventEmitter,
    ThemeIcon: MockThemeIcon,
    ThemeColor: MockThemeColor,
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
    languages: { registerCodeLensProvider: () => ({ dispose: () => {} }) },
    Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
  },
} as any;

// ============================================================================
// Import the module under test
//
// These imports will resolve once callersProvider.ts is implemented.
// If the module does not exist yet, the test file will fail to load
// with a clear import error — that is intentional.
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const callersModule = require('../../src/callersProvider');
const { CallersProvider } = callersModule;

// ============================================================================
// Helper: create a CallersProvider with a mock client manager
// ============================================================================

function createProvider(graph: MockGraph) {
  const client = createMockClient(graph);
  const mockClientManager = {
    getClient: () => client,
    isConnected: () => true,
    state: { status: 'connected' },
    on: () => {},
    emit: () => {},
  };
  return new CallersProvider(mockClientManager);
}

// ============================================================================
// SECTION 1: Incoming & Outgoing sections
// ============================================================================

describe('CallersProvider — incoming & outgoing sections', () => {
  it('setRootNode(funcNode) → getChildren(section-incoming) includes callers from incoming CALLS edges', async () => {
    // funcA calls funcB, funcC calls funcB
    // funcB's incoming CALLS edges: funcA, funcC (these are its callers)
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'handleRequest'),
        funcB: makeNode('funcB', 'FUNCTION', 'validate'),
        funcC: makeNode('funcC', 'FUNCTION', 'process'),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'funcB')],
        funcC: [makeEdge('funcC', 'funcB')],
      },
      incoming: {
        funcB: [makeEdge('funcA', 'funcB'), makeEdge('funcC', 'funcB')],
      },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcB);

    // Wait for async fetchCounts to complete
    await new Promise((r) => setTimeout(r, 50));

    // Get top-level children (sections)
    const sections = await provider.getChildren(undefined);
    const incomingSection = sections.find(
      (s: CallersItem) => s.kind === 'section' && s.direction === 'incoming',
    ) as CallersItemSection | undefined;

    assert.ok(incomingSection, 'Should have an incoming section');
    assert.strictEqual(incomingSection.count, 2, 'funcB has 2 callers');

    // Get children of incoming section
    const callers = await provider.getChildren(incomingSection);
    const callerIds = callers
      .filter((c: CallersItem) => c.kind === 'call-node')
      .map((c: CallersItemCallNode) => c.node.id)
      .sort();

    assert.deepStrictEqual(callerIds, ['funcA', 'funcC'], 'Both callers should appear');
  });

  it('setRootNode(funcNode) → getChildren(section-outgoing) includes callees from outgoing CALLS edges', async () => {
    // funcA calls funcB and funcC
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'main'),
        funcB: makeNode('funcB', 'FUNCTION', 'validate'),
        funcC: makeNode('funcC', 'FUNCTION', 'save'),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'funcB'), makeEdge('funcA', 'funcC')],
      },
      incoming: {
        funcB: [makeEdge('funcA', 'funcB')],
        funcC: [makeEdge('funcA', 'funcC')],
      },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcA);

    // Wait for async fetchCounts to complete
    await new Promise((r) => setTimeout(r, 50));

    const sections = await provider.getChildren(undefined);
    const outgoingSection = sections.find(
      (s: CallersItem) => s.kind === 'section' && s.direction === 'outgoing',
    ) as CallersItemSection | undefined;

    assert.ok(outgoingSection, 'Should have an outgoing section');
    assert.strictEqual(outgoingSection.count, 2, 'funcA calls 2 functions');

    const callees = await provider.getChildren(outgoingSection);
    const calleeIds = callees
      .filter((c: CallersItem) => c.kind === 'call-node')
      .map((c: CallersItemCallNode) => c.node.id)
      .sort();

    assert.deepStrictEqual(calleeIds, ['funcB', 'funcC'], 'Both callees should appear');
  });
});

// ============================================================================
// SECTION 2: Cycle detection
// ============================================================================

describe('CallersProvider — cycle detection', () => {
  it('A calls B, B calls A → recursive expansion terminates (no infinite loop)', async () => {
    // Mutual recursion: funcA calls funcB, funcB calls funcA
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'ping'),
        funcB: makeNode('funcB', 'FUNCTION', 'pong'),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'funcB')],
        funcB: [makeEdge('funcB', 'funcA')],
      },
      incoming: {
        funcA: [makeEdge('funcB', 'funcA')],
        funcB: [makeEdge('funcA', 'funcB')],
      },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcA);

    // Get outgoing section
    const sections = await provider.getChildren(undefined);
    const outgoingSection = sections.find(
      (s: CallersItem) => s.kind === 'section' && s.direction === 'outgoing',
    ) as CallersItemSection;

    // Expand outgoing: funcA calls funcB
    const callees = await provider.getChildren(outgoingSection);
    assert.strictEqual(callees.length, 1, 'funcA calls one function');

    const funcBItem = callees[0] as CallersItemCallNode;
    assert.strictEqual(funcBItem.node.id, 'funcB');

    // Expand funcB's children: funcB calls funcA, but funcA is in visitedIds
    // So the expansion should terminate (empty children or cycle marker)
    const funcBChildren = await provider.getChildren(funcBItem);

    // The key assertion: recursive expansion must terminate.
    // Either returns empty (cycle detected) or includes funcA as non-expandable leaf.
    // Either way, expanding further should not hang.
    if (funcBChildren.length > 0) {
      const funcAChild = funcBChildren.find(
        (c: CallersItem) => c.kind === 'call-node',
      ) as CallersItemCallNode | undefined;
      if (funcAChild) {
        // funcA child should not be expandable (cycle)
        const deepChildren = await provider.getChildren(funcAChild);
        assert.strictEqual(deepChildren.length, 0, 'Cycle leaf must have no children');
      }
    }
    // If funcBChildren is empty, cycle was detected at the section level — also valid.
    assert.ok(true, 'Expansion terminated without infinite loop');
  });
});

// ============================================================================
// SECTION 3: Filters
// ============================================================================

describe('CallersProvider — filters', () => {
  it('test file excluded when hideTestFiles = true', async () => {
    // funcB is called by funcA (src/app.ts) and testFunc (test/app.test.ts)
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'handler', { file: 'src/app.ts' }),
        funcB: makeNode('funcB', 'FUNCTION', 'validate', { file: 'src/validate.ts' }),
        testFunc: makeNode('testFunc', 'FUNCTION', 'testValidate', { file: 'test/validate.test.ts' }),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'funcB')],
        testFunc: [makeEdge('testFunc', 'funcB')],
      },
      incoming: {
        funcB: [makeEdge('funcA', 'funcB'), makeEdge('testFunc', 'funcB')],
      },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcB);
    provider.setHideTestFiles(true);

    const sections = await provider.getChildren(undefined);
    const incomingSection = sections.find(
      (s: CallersItem) => s.kind === 'section' && s.direction === 'incoming',
    ) as CallersItemSection;

    const callers = await provider.getChildren(incomingSection);
    const callerIds = callers
      .filter((c: CallersItem) => c.kind === 'call-node')
      .map((c: CallersItemCallNode) => c.node.id);

    assert.ok(!callerIds.includes('testFunc'), 'Test file caller should be excluded');
    assert.ok(callerIds.includes('funcA'), 'Non-test caller should remain');
  });

  it('node_modules file excluded when hideNodeModules = true', async () => {
    // funcB is called by funcA (src/) and lodashGet (node_modules/)
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'handler', { file: 'src/app.ts' }),
        funcB: makeNode('funcB', 'FUNCTION', 'validate', { file: 'src/validate.ts' }),
        lodashGet: makeNode('lodashGet', 'FUNCTION', 'get', { file: 'node_modules/lodash/get.js' }),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'funcB')],
        lodashGet: [makeEdge('lodashGet', 'funcB')],
      },
      incoming: {
        funcB: [makeEdge('funcA', 'funcB'), makeEdge('lodashGet', 'funcB')],
      },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcB);
    provider.setHideNodeModules(true);

    const sections = await provider.getChildren(undefined);
    const incomingSection = sections.find(
      (s: CallersItem) => s.kind === 'section' && s.direction === 'incoming',
    ) as CallersItemSection;

    const callers = await provider.getChildren(incomingSection);
    const callerIds = callers
      .filter((c: CallersItem) => c.kind === 'call-node')
      .map((c: CallersItemCallNode) => c.node.id);

    assert.ok(!callerIds.includes('lodashGet'), 'node_modules caller should be excluded');
    assert.ok(callerIds.includes('funcA'), 'Non-node_modules caller should remain');
  });
});

// ============================================================================
// SECTION 4: Branching factor cap
// ============================================================================

describe('CallersProvider — branching factor', () => {
  it('MAX_BRANCHING_FACTOR cap: 6 callers → returns 5 call-nodes + 1 more item', async () => {
    // funcTarget has 6 callers: caller1..caller6
    const nodes: Record<string, WireNode> = {
      funcTarget: makeNode('funcTarget', 'FUNCTION', 'target'),
    };
    const incomingEdges: MockEdge[] = [];
    for (let i = 1; i <= 6; i++) {
      const id = `caller${i}`;
      nodes[id] = makeNode(id, 'FUNCTION', `caller${i}`);
      incomingEdges.push(makeEdge(id, 'funcTarget'));
    }

    const graph: MockGraph = {
      nodes,
      outgoing: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`caller${i + 1}`, [makeEdge(`caller${i + 1}`, 'funcTarget')]]),
      ),
      incoming: { funcTarget: incomingEdges },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcTarget);

    const sections = await provider.getChildren(undefined);
    const incomingSection = sections.find(
      (s: CallersItem) => s.kind === 'section' && s.direction === 'incoming',
    ) as CallersItemSection;

    const items = await provider.getChildren(incomingSection);
    const callNodes = items.filter((c: CallersItem) => c.kind === 'call-node');
    const moreItems = items.filter((c: CallersItem) => c.kind === 'more');

    assert.strictEqual(callNodes.length, 5, 'Should cap at 5 call-nodes (MAX_BRANCHING_FACTOR)');
    assert.strictEqual(moreItems.length, 1, 'Should have exactly 1 "more" item');
    assert.strictEqual(
      (moreItems[0] as CallersItemMore).count,
      1,
      '"more" item should indicate 1 remaining caller',
    );
  });
});

// ============================================================================
// SECTION 5: Depth limit
// ============================================================================

describe('CallersProvider — depth limit', () => {
  it('maxDepth=1 → call-node at depth 0 has children, call-node at depth 1 returns empty', async () => {
    // Chain: funcA calls funcB calls funcC calls funcD
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'a'),
        funcB: makeNode('funcB', 'FUNCTION', 'b'),
        funcC: makeNode('funcC', 'FUNCTION', 'c'),
        funcD: makeNode('funcD', 'FUNCTION', 'd'),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'funcB')],
        funcB: [makeEdge('funcB', 'funcC')],
        funcC: [makeEdge('funcC', 'funcD')],
      },
      incoming: {
        funcB: [makeEdge('funcA', 'funcB')],
        funcC: [makeEdge('funcB', 'funcC')],
        funcD: [makeEdge('funcC', 'funcD')],
      },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcA);
    provider.setMaxDepth(1);

    // Get outgoing section
    const sections = await provider.getChildren(undefined);
    const outgoingSection = sections.find(
      (s: CallersItem) => s.kind === 'section' && s.direction === 'outgoing',
    ) as CallersItemSection;

    // Depth 0: funcA calls funcB — should have children
    const depth0 = await provider.getChildren(outgoingSection);
    const funcBItem = depth0.find(
      (c: CallersItem) => c.kind === 'call-node',
    ) as CallersItemCallNode;
    assert.ok(funcBItem, 'funcB should appear at depth 0');

    // Depth 1: funcB calls funcC — should return empty (depth limit reached)
    const depth1 = await provider.getChildren(funcBItem);
    assert.strictEqual(depth1.length, 0, 'At maxDepth=1, depth 1 call-nodes should have no children');
  });
});

// ============================================================================
// SECTION 6: Direction modes
// ============================================================================

describe('CallersProvider — direction modes', () => {
  it("direction 'incoming' → only incoming section shown (no outgoing)", async () => {
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'caller'),
        funcB: makeNode('funcB', 'FUNCTION', 'target'),
        funcC: makeNode('funcC', 'FUNCTION', 'callee'),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'funcB')],
        funcB: [makeEdge('funcB', 'funcC')],
      },
      incoming: {
        funcB: [makeEdge('funcA', 'funcB')],
        funcC: [makeEdge('funcB', 'funcC')],
      },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcB);
    provider.setDirection('incoming');

    const sections = await provider.getChildren(undefined);
    const directions = sections
      .filter((s: CallersItem) => s.kind === 'section')
      .map((s: CallersItemSection) => s.direction);

    assert.ok(directions.includes('incoming'), 'Should have incoming section');
    assert.ok(!directions.includes('outgoing'), 'Should NOT have outgoing section');
  });

  it("direction 'outgoing' → only outgoing section shown (no incoming)", async () => {
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'caller'),
        funcB: makeNode('funcB', 'FUNCTION', 'target'),
        funcC: makeNode('funcC', 'FUNCTION', 'callee'),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'funcB')],
        funcB: [makeEdge('funcB', 'funcC')],
      },
      incoming: {
        funcB: [makeEdge('funcA', 'funcB')],
        funcC: [makeEdge('funcB', 'funcC')],
      },
    };

    const provider = createProvider(graph);
    provider.setRootNode(graph.nodes.funcB);
    provider.setDirection('outgoing');

    const sections = await provider.getChildren(undefined);
    const directions = sections
      .filter((s: CallersItem) => s.kind === 'section')
      .map((s: CallersItemSection) => s.direction);

    assert.ok(directions.includes('outgoing'), 'Should have outgoing section');
    assert.ok(!directions.includes('incoming'), 'Should NOT have incoming section');
  });
});

// ============================================================================
// SECTION 7: Empty state
// ============================================================================

describe('CallersProvider — empty state', () => {
  it('no root node set → returns status item with message', async () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const provider = createProvider(graph);

    // Do NOT call setRootNode — provider starts without root

    const items = await provider.getChildren(undefined);
    assert.strictEqual(items.length, 1, 'Should return exactly one item');
    assert.strictEqual(items[0].kind, 'status', 'Item should be a status item');
    assert.ok(
      (items[0] as CallersItemStatus).message.length > 0,
      'Status message should not be empty',
    );
  });
});
