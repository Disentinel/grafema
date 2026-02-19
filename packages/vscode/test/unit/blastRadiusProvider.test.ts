/**
 * Unit tests for BlastRadiusProvider -- REG-516
 *
 * Tests the BLAST RADIUS panel TreeDataProvider: status messages,
 * dependency grouping (direct/indirect), guarantee sections,
 * impact score display, summary line, gotoLocation commands,
 * reconnect behavior, and BFS race condition handling.
 *
 * Mock setup: in-memory graph with FUNCTION/MODULE/GUARANTEE nodes
 * and directed CALLS/GOVERNS edges. Follows the exact mock pattern
 * from callersProvider.test.ts and issuesProvider.test.ts.
 * No RFDB server needed -- pure logic tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode, WireEdge } from '@grafema/types';

// ============================================================================
// Types for BlastRadiusProvider (mirrors actual types from types.ts)
// ============================================================================

type BlastRadiusItem =
  | { kind: 'root'; label: string; impactLevel: 'LOW' | 'MEDIUM' | 'HIGH'; file?: string; line?: number }
  | { kind: 'section'; label: string; sectionKind: 'direct' | 'indirect' | 'guarantee'; count: number }
  | { kind: 'dependent'; name: string; file?: string; line?: number; nodeType: string; viaPath: string[]; isIndirect: boolean }
  | { kind: 'guarantee'; name: string; file?: string; metadata?: Record<string, unknown> }
  | { kind: 'summary'; text: string }
  | { kind: 'status'; message: string }
  | { kind: 'loading' };

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

function makeEdge(src: string, dst: string, edgeType = 'CALLS'): MockEdge {
  return { src, dst, edgeType, metadata: '{}' };
}

function createMockRFDBClient(graph: MockGraph) {
  return {
    getNode: async (id: string): Promise<WireNode | null> => {
      return graph.nodes[id] ?? null;
    },
    getIncomingEdges: async (id: string, edgeTypes?: string[] | null): Promise<WireEdge[]> => {
      const edges = graph.incoming[id] ?? [];
      if (!edgeTypes) return edges as unknown as WireEdge[];
      return edges.filter((e) => edgeTypes.includes(e.edgeType)) as unknown as WireEdge[];
    },
    getOutgoingEdges: async () => [],
    queryNodes: async function* (query: { nodeType?: string; file?: string }) {
      for (const node of Object.values(graph.nodes)) {
        if (query.nodeType && node.nodeType !== query.nodeType) continue;
        if (query.file && node.file !== query.file) continue;
        yield node;
      }
    },
    getAllNodes: async () => Object.values(graph.nodes),
  };
}

// ============================================================================
// Mock vscode module
//
// BlastRadiusProvider uses vscode.TreeItem, vscode.TreeItemCollapsibleState,
// vscode.ThemeIcon, vscode.EventEmitter, vscode.ThemeColor, vscode.Uri.
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
  command?: { command: string; title: string; arguments?: unknown[] };

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
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const providerModule = require('../../src/blastRadiusProvider');
const { BlastRadiusProvider } = providerModule;

// ============================================================================
// Helper: create a BlastRadiusProvider with a mock client manager
// ============================================================================

interface MockClientManager {
  getClient: () => ReturnType<typeof createMockRFDBClient>;
  isConnected: () => boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

interface MockTreeView {
  badge?: { value: number; tooltip: string } | undefined;
  message?: string;
  dispose: () => void;
}

function createMockTreeView(): MockTreeView {
  return {
    badge: undefined,
    message: undefined,
    dispose: () => {},
  };
}

function createProvider(
  graph: MockGraph,
  options?: { connected?: boolean },
) {
  const connected = options?.connected ?? true;
  const client = createMockRFDBClient(graph);

  const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const mockClientManager: MockClientManager = {
    getClient: () => client,
    isConnected: () => connected,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    },
    emit: (event: string, ...args: unknown[]) => {
      const handlers = eventHandlers[event] ?? [];
      for (const h of handlers) h(...args);
    },
  };

  const provider = new BlastRadiusProvider(mockClientManager);
  const mockTreeView = createMockTreeView();
  provider.setTreeView(mockTreeView);

  return { provider, mockClientManager, mockTreeView };
}

/**
 * Wait for async BFS to complete. The provider triggers BFS
 * asynchronously after setRootNode, so we need a small delay.
 */
async function waitForBFS(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// SECTION 1: Not connected state
// ============================================================================

describe('BlastRadiusProvider -- not connected', () => {
  it('T1: returns status "Not connected to graph"', async () => {
    const graph: MockGraph = { nodes: {}, incoming: {} };
    const { provider } = createProvider(graph, { connected: false });

    const items = await provider.getChildren(undefined);
    assert.strictEqual(items.length, 1, 'Should return exactly one item');
    assert.strictEqual(items[0].kind, 'status');
    assert.ok(
      (items[0] as { kind: 'status'; message: string }).message.includes('Not connected'),
      'Message should indicate not connected',
    );
  });
});

// ============================================================================
// SECTION 2: No root node
// ============================================================================

describe('BlastRadiusProvider -- no root node', () => {
  it('T2: returns status about moving cursor', async () => {
    const graph: MockGraph = { nodes: {}, incoming: {} };
    const { provider } = createProvider(graph);

    // Do NOT call setRootNode
    const items = await provider.getChildren(undefined);
    assert.strictEqual(items.length, 1, 'Should return exactly one item');
    assert.strictEqual(items[0].kind, 'status');
    assert.ok(
      (items[0] as { kind: 'status'; message: string }).message.toLowerCase().includes('cursor')
        || (items[0] as { kind: 'status'; message: string }).message.toLowerCase().includes('function'),
      'Message should guide user to move cursor to a function',
    );
  });
});

// ============================================================================
// SECTION 3: Change event fires when root node set
// ============================================================================

describe('BlastRadiusProvider -- change event', () => {
  it('T3: fires _onDidChangeTreeData when setRootNode called', () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate');
    const graph: MockGraph = {
      nodes: { root: rootNode },
      incoming: {},
    };

    const { provider } = createProvider(graph);

    let changeEventFired = false;
    provider.onDidChangeTreeData(() => {
      changeEventFired = true;
    });

    provider.setRootNode(rootNode);
    assert.ok(changeEventFired, 'Change event should fire when root node is set');
  });
});

// ============================================================================
// SECTION 4: Single direct dependent
// ============================================================================

describe('BlastRadiusProvider -- single direct dependent', () => {
  it('T4: direct section with 1 item, score = 3 -> LOW', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const callerNode = makeNode('caller1', 'FUNCTION', 'handler', {
      file: 'src/handler.ts',
      metadata: JSON.stringify({ line: 10, column: 5 }),
    });

    const graph: MockGraph = {
      nodes: { root: rootNode, caller1: callerNode },
      incoming: {
        root: [makeEdge('caller1', 'root', 'CALLS')],
      },
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);
    await waitForBFS();

    const topItems: BlastRadiusItem[] = await provider.getChildren(undefined);

    // Find the direct section
    const directSection = topItems.find(
      (item) => item.kind === 'section' && item.sectionKind === 'direct',
    );
    assert.ok(directSection, 'Should have a "direct" section');
    assert.strictEqual(
      (directSection as { kind: 'section'; count: number }).count,
      1,
      'Direct section should have count 1',
    );

    // Expand direct section
    const directChildren: BlastRadiusItem[] = await provider.getChildren(directSection);
    const dependentItems = directChildren.filter(
      (item) => item.kind === 'dependent',
    );
    assert.strictEqual(dependentItems.length, 1, 'Direct section should have 1 dependent');
    assert.strictEqual(
      (dependentItems[0] as { kind: 'dependent'; name: string }).name,
      'handler',
    );

    // Verify impact level is LOW (1 direct * 3 = 3 -> LOW)
    const rootItem = topItems.find((item) => item.kind === 'root');
    assert.ok(rootItem, 'Should have a root item');
    assert.strictEqual(
      (rootItem as { kind: 'root'; impactLevel: string }).impactLevel,
      'LOW',
      'Impact level should be LOW',
    );

    // Root label should contain [LOW]
    assert.ok(
      (rootItem as { kind: 'root'; label: string }).label.includes('[LOW]'),
      'Root label should contain [LOW]',
    );
  });
});

// ============================================================================
// SECTION 5: Multiple direct + indirect dependents
// ============================================================================

describe('BlastRadiusProvider -- multiple direct and indirect', () => {
  it('T5: correct grouping, indirect has viaPath in description', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const callerA = makeNode('callerA', 'FUNCTION', 'handlerA', { file: 'src/handlerA.ts' });
    const callerB = makeNode('callerB', 'FUNCTION', 'handlerB', { file: 'src/handlerB.ts' });
    // indirectC depends on callerA (2 hops from root)
    const indirectC = makeNode('indirectC', 'FUNCTION', 'processOrder', { file: 'src/order.ts' });

    const graph: MockGraph = {
      nodes: { root: rootNode, callerA, callerB, indirectC },
      incoming: {
        root: [
          makeEdge('callerA', 'root', 'CALLS'),
          makeEdge('callerB', 'root', 'CALLS'),
        ],
        callerA: [
          makeEdge('indirectC', 'callerA', 'CALLS'),
        ],
      },
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);
    await waitForBFS();

    const topItems: BlastRadiusItem[] = await provider.getChildren(undefined);

    // Direct section
    const directSection = topItems.find(
      (item) => item.kind === 'section' && item.sectionKind === 'direct',
    );
    assert.ok(directSection, 'Should have a direct section');
    assert.strictEqual(
      (directSection as { kind: 'section'; count: number }).count,
      2,
      'Direct section should have 2 items',
    );

    // Indirect section
    const indirectSection = topItems.find(
      (item) => item.kind === 'section' && item.sectionKind === 'indirect',
    );
    assert.ok(indirectSection, 'Should have an indirect section');
    assert.strictEqual(
      (indirectSection as { kind: 'section'; count: number }).count,
      1,
      'Indirect section should have 1 item',
    );

    // Expand indirect section and verify viaPath is rendered
    const indirectChildren: BlastRadiusItem[] = await provider.getChildren(indirectSection);
    const indirectItems = indirectChildren.filter(
      (item) => item.kind === 'dependent',
    );
    assert.strictEqual(indirectItems.length, 1, 'Should have 1 indirect dependent');

    const indirectDep = indirectItems[0] as { kind: 'dependent'; name: string; isIndirect: boolean; viaPath: string[] };
    assert.strictEqual(indirectDep.name, 'processOrder');
    assert.ok(indirectDep.isIndirect, 'Should be marked as indirect');
    assert.ok(indirectDep.viaPath.length > 0, 'Should have viaPath entries');

    // Verify the tree item description shows "via"
    const treeItem = provider.getTreeItem(indirectItems[0]);
    assert.ok(
      treeItem.description && treeItem.description.includes('via'),
      'Indirect node description should contain "via" for the intermediate path',
    );
  });
});

// ============================================================================
// SECTION 6: Guarantee at risk
// ============================================================================

describe('BlastRadiusProvider -- guarantee at risk', () => {
  it('T6: guarantee section appears when guarantees are at risk', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'processPayment', {
      file: 'src/payment.ts',
    });
    const moduleNode = makeNode('MODULE:src/payment.ts', 'MODULE', 'src/payment.ts', {
      file: 'src/payment.ts',
    });
    const guaranteeNode = makeNode('GUARANTEE:no-direct-db', 'GUARANTEE', 'no-direct-db', {
      file: '',
      metadata: JSON.stringify({ description: 'No direct DB access' }),
    });

    const graph: MockGraph = {
      nodes: {
        root: rootNode,
        'MODULE:src/payment.ts': moduleNode,
        'GUARANTEE:no-direct-db': guaranteeNode,
      },
      incoming: {
        'MODULE:src/payment.ts': [
          makeEdge('GUARANTEE:no-direct-db', 'MODULE:src/payment.ts', 'GOVERNS'),
        ],
      },
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);
    await waitForBFS();

    const topItems: BlastRadiusItem[] = await provider.getChildren(undefined);

    // Guarantee section
    const guaranteeSection = topItems.find(
      (item) => item.kind === 'section' && item.sectionKind === 'guarantee',
    );
    assert.ok(guaranteeSection, 'Should have a guarantee section');
    assert.strictEqual(
      (guaranteeSection as { kind: 'section'; count: number }).count,
      1,
      'Guarantee section should have 1 item',
    );

    // Expand guarantee section
    const guaranteeChildren: BlastRadiusItem[] = await provider.getChildren(guaranteeSection);
    const guaranteeItems = guaranteeChildren.filter(
      (item) => item.kind === 'guarantee',
    );
    assert.strictEqual(guaranteeItems.length, 1, 'Should have 1 guarantee item');
    assert.strictEqual(
      (guaranteeItems[0] as { kind: 'guarantee'; name: string }).name,
      'no-direct-db',
    );
  });
});

// ============================================================================
// SECTION 7: All counts zero
// ============================================================================

describe('BlastRadiusProvider -- all counts zero', () => {
  it('T7: returns status "No dependents found"', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'isolatedFunc', { file: 'src/isolated.ts' });

    const graph: MockGraph = {
      nodes: { root: rootNode },
      incoming: {},
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);
    await waitForBFS();

    const topItems: BlastRadiusItem[] = await provider.getChildren(undefined);

    // When all counts are 0, should show a "No dependents" status
    const statusItems = topItems.filter(
      (item) => item.kind === 'status',
    );
    assert.ok(statusItems.length > 0, 'Should have a status item when no dependents');
    assert.ok(
      (statusItems[0] as { kind: 'status'; message: string }).message.toLowerCase().includes('no dependent'),
      'Status should indicate no dependents found',
    );
  });
});

// ============================================================================
// SECTION 8: Summary line format
// ============================================================================

describe('BlastRadiusProvider -- summary line', () => {
  it('T8: format includes total count, file count, and guarantee count', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const callerA = makeNode('callerA', 'FUNCTION', 'handlerA', { file: 'src/handlerA.ts' });
    const callerB = makeNode('callerB', 'FUNCTION', 'handlerB', { file: 'src/handlerB.ts' });

    const moduleNode = makeNode('MODULE:src/validate.ts', 'MODULE', 'src/validate.ts', {
      file: 'src/validate.ts',
    });
    const guaranteeNode = makeNode('GUARANTEE:g1', 'GUARANTEE', 'test-guarantee', { file: '' });

    const graph: MockGraph = {
      nodes: {
        root: rootNode,
        callerA,
        callerB,
        'MODULE:src/validate.ts': moduleNode,
        'GUARANTEE:g1': guaranteeNode,
      },
      incoming: {
        root: [
          makeEdge('callerA', 'root', 'CALLS'),
          makeEdge('callerB', 'root', 'CALLS'),
        ],
        'MODULE:src/validate.ts': [
          makeEdge('GUARANTEE:g1', 'MODULE:src/validate.ts', 'GOVERNS'),
        ],
      },
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);
    await waitForBFS();

    const topItems: BlastRadiusItem[] = await provider.getChildren(undefined);

    const summaryItem = topItems.find(
      (item) => item.kind === 'summary',
    );
    assert.ok(summaryItem, 'Should have a summary item');

    // Summary should contain total count, file count, and guarantee count
    const text = (summaryItem as { kind: 'summary'; text: string }).text;
    assert.ok(text.includes('2'), 'Summary should include total dependent count (2)');
    assert.ok(text.includes('file'), 'Summary should mention files');
    assert.ok(text.includes('guarantee'), 'Summary should mention guarantees');
  });
});

// ============================================================================
// SECTION 9: Impact score shown in root label
// ============================================================================

describe('BlastRadiusProvider -- impact score in root label', () => {
  it('T9: root label contains impact level badge [LOW], [MEDIUM], or [HIGH]', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const callerNode = makeNode('caller1', 'FUNCTION', 'handler', { file: 'src/handler.ts' });

    const graph: MockGraph = {
      nodes: { root: rootNode, caller1: callerNode },
      incoming: {
        root: [makeEdge('caller1', 'root', 'CALLS')],
      },
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);
    await waitForBFS();

    const topItems: BlastRadiusItem[] = await provider.getChildren(undefined);
    const rootItem = topItems.find(
      (item) => item.kind === 'root',
    );
    assert.ok(rootItem, 'Should have a root item');

    const treeItem = provider.getTreeItem(rootItem);
    // Label should contain the impact level: [LOW], [MEDIUM], or [HIGH]
    assert.ok(
      treeItem.label.includes('[LOW]') || treeItem.label.includes('[MEDIUM]') || treeItem.label.includes('[HIGH]'),
      `Root label should contain impact level badge, got: "${treeItem.label}"`,
    );
  });
});

// ============================================================================
// SECTION 10: Click dependent node -> gotoLocation command
// ============================================================================

describe('BlastRadiusProvider -- gotoLocation command', () => {
  it('T10: dependent node with file+line has gotoLocation command', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const callerNode = makeNode('caller1', 'FUNCTION', 'handler', {
      file: 'src/handler.ts',
      metadata: JSON.stringify({ line: 42, column: 8 }),
    });

    const graph: MockGraph = {
      nodes: { root: rootNode, caller1: callerNode },
      incoming: {
        root: [makeEdge('caller1', 'root', 'CALLS')],
      },
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);
    await waitForBFS();

    const topItems: BlastRadiusItem[] = await provider.getChildren(undefined);
    const directSection = topItems.find(
      (item) => item.kind === 'section' && item.sectionKind === 'direct',
    );
    assert.ok(directSection, 'Should have a direct section');

    const directChildren: BlastRadiusItem[] = await provider.getChildren(directSection);
    const dependentItem = directChildren.find(
      (item) => item.kind === 'dependent',
    );
    assert.ok(dependentItem, 'Should have a dependent item');

    const treeItem = provider.getTreeItem(dependentItem);
    assert.ok(treeItem.command, 'Dependent node should have a command');
    assert.strictEqual(treeItem.command.command, 'grafema.gotoLocation', 'Command should be grafema.gotoLocation');
    assert.deepStrictEqual(
      treeItem.command.arguments,
      ['src/handler.ts', 42, 0],
      'Command arguments should be [file, line, column=0]',
    );
  });
});

// ============================================================================
// SECTION 11: Reconnect clears cached result
// ============================================================================

describe('BlastRadiusProvider -- reconnect', () => {
  it('T11: reconnect clears cached result and fires change event', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'validate', { file: 'src/validate.ts' });
    const callerNode = makeNode('caller1', 'FUNCTION', 'handler', { file: 'src/handler.ts' });

    const graph: MockGraph = {
      nodes: { root: rootNode, caller1: callerNode },
      incoming: {
        root: [makeEdge('caller1', 'root', 'CALLS')],
      },
    };

    const { provider, mockClientManager } = createProvider(graph);
    provider.setRootNode(rootNode);
    await waitForBFS();

    // Verify initial load worked
    const initialItems: BlastRadiusItem[] = await provider.getChildren(undefined);
    const initialSections = initialItems.filter(
      (item) => item.kind === 'section',
    );
    assert.ok(initialSections.length > 0, 'Should have sections initially');

    // Track change events
    let changeEventFired = false;
    provider.onDidChangeTreeData(() => {
      changeEventFired = true;
    });

    // Emit reconnected event
    mockClientManager.emit('reconnected');

    assert.ok(changeEventFired, 'Change event should have fired after reconnect');

    // After reconnect, root is cleared. getChildren should show no-root status.
    const afterItems: BlastRadiusItem[] = await provider.getChildren(undefined);
    assert.ok(afterItems.length > 0, 'Should still return items after reconnect');
    // Provider clears rootNode on reconnect, so should show "move cursor" status
    const statusItem = afterItems.find((item) => item.kind === 'status');
    assert.ok(statusItem, 'After reconnect, should show status (root cleared)');
  });
});

// ============================================================================
// SECTION 12: BFS race condition
// ============================================================================

describe('BlastRadiusProvider -- BFS race condition', () => {
  it('T12: second setRootNode during active BFS -> first result discarded', async () => {
    const firstRoot = makeNode('first', 'FUNCTION', 'firstFunc', { file: 'src/first.ts' });
    const firstCaller = makeNode('firstCaller', 'FUNCTION', 'callerOfFirst', { file: 'src/a.ts' });

    const secondRoot = makeNode('second', 'FUNCTION', 'secondFunc', { file: 'src/second.ts' });
    const secondCaller = makeNode('secondCaller', 'FUNCTION', 'callerOfSecond', { file: 'src/b.ts' });

    const graph: MockGraph = {
      nodes: {
        first: firstRoot,
        firstCaller,
        second: secondRoot,
        secondCaller,
      },
      incoming: {
        first: [makeEdge('firstCaller', 'first', 'CALLS')],
        second: [makeEdge('secondCaller', 'second', 'CALLS')],
      },
    };

    const { provider } = createProvider(graph);

    // Set first root (triggers BFS)
    provider.setRootNode(firstRoot);

    // Immediately set second root (before first BFS completes)
    provider.setRootNode(secondRoot);

    // Wait for all BFS operations to complete
    await waitForBFS(200);

    // The final result should be for the SECOND root, not the first
    const topItems: BlastRadiusItem[] = await provider.getChildren(undefined);
    const rootItem = topItems.find(
      (item) => item.kind === 'root',
    );

    if (rootItem) {
      const rootLabel = (rootItem as { kind: 'root'; label: string }).label;
      // Root label should contain secondFunc's name, not firstFunc's
      assert.ok(
        rootLabel.includes('secondFunc'),
        `Root label should reference secondFunc, got: "${rootLabel}"`,
      );
    }

    // Verify we see the second root's callers, not the first's
    const directSection = topItems.find(
      (item) => item.kind === 'section' && item.sectionKind === 'direct',
    );
    if (directSection) {
      const children: BlastRadiusItem[] = await provider.getChildren(directSection);
      const dependentNames = children
        .filter((item) => item.kind === 'dependent')
        .map((item) => (item as { kind: 'dependent'; name: string }).name);

      assert.ok(
        !dependentNames.includes('callerOfFirst'),
        'First root callers should not appear (stale BFS discarded)',
      );
      assert.ok(
        dependentNames.includes('callerOfSecond'),
        'Second root callers should appear',
      );
    }
  });
});
