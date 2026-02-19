/**
 * Unit tests for EdgesProvider enhancements -- REG-517
 *
 * Tests the EXPLORER panel EdgesProvider additions:
 * 1. Edge type filtering (hiddenEdgeTypes)
 * 2. Bookmarks (workspaceState persistence, add/remove/cap)
 * 3. Improved labels (formatFilePath, file+exported description)
 * 4. Tree structure with bookmark sections
 *
 * Mock setup: in-memory graph with FUNCTION/MODULE nodes and directed edges.
 * Follows the exact mock pattern from callersProvider.test.ts and
 * blastRadiusProvider.test.ts. No RFDB server needed -- pure logic tests.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode, WireEdge } from '@grafema/types';

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
    getOutgoingEdges: async (id: string, edgeTypes?: string[] | null): Promise<WireEdge[]> => {
      const edges = graph.outgoing[id] ?? [];
      if (!edgeTypes) return edges as unknown as WireEdge[];
      return edges.filter((e) => edgeTypes.includes(e.edgeType)) as unknown as WireEdge[];
    },
    getIncomingEdges: async (id: string, edgeTypes?: string[] | null): Promise<WireEdge[]> => {
      const edges = graph.incoming[id] ?? [];
      if (!edgeTypes) return edges as unknown as WireEdge[];
      return edges.filter((e) => edgeTypes.includes(e.edgeType)) as unknown as WireEdge[];
    },
    getAllNodes: async () => Object.values(graph.nodes),
  };
}

// ============================================================================
// Mock vscode module
//
// EdgesProvider uses vscode.TreeItem, vscode.TreeItemCollapsibleState,
// vscode.ThemeIcon, vscode.EventEmitter, vscode.ThemeColor, vscode.Uri.
// We inject a minimal mock before importing the module under test.
// ============================================================================

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

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
//
// These imports will resolve once edgesProvider.ts enhancements are built.
// If the new methods do not exist yet, the test file will fail at runtime
// with a clear error -- that is intentional (tests define the contract).
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const edgesModule = require('../../src/edgesProvider');
const { EdgesProvider } = edgesModule;

// Import formatFilePath helper -- Rob will export from types.ts or edgesProvider.ts.
// Try both locations; fall through gracefully if neither exports it yet.
let formatFilePath: ((path: string) => string) | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const typesModule = require('../../src/types');
  if (typeof typesModule.formatFilePath === 'function') {
    formatFilePath = typesModule.formatFilePath;
  }
} catch { /* not yet exported from types */ }
if (!formatFilePath) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const edgesMod = require('../../src/edgesProvider');
    if (typeof edgesMod.formatFilePath === 'function') {
      formatFilePath = edgesMod.formatFilePath;
    }
  } catch { /* not yet exported from edgesProvider */ }
}

// ============================================================================
// Mock workspaceState for bookmark persistence
// ============================================================================

interface MockWorkspaceState {
  storage: Record<string, unknown>;
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): Promise<void>;
}

function createMockWorkspaceState(initial?: Record<string, unknown>): MockWorkspaceState {
  const storage: Record<string, unknown> = { ...initial };
  return {
    storage,
    get<T>(key: string, defaultValue?: T): T {
      if (key in storage) return storage[key] as T;
      return defaultValue as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      storage[key] = value;
    },
  };
}

// ============================================================================
// Helper: create an EdgesProvider with a mock client manager and context
// ============================================================================

function createProvider(
  graph: MockGraph,
  options?: { connected?: boolean; workspaceState?: MockWorkspaceState },
) {
  const connected = options?.connected ?? true;
  const client = createMockRFDBClient(graph);
  const workspaceState = options?.workspaceState ?? createMockWorkspaceState();

  const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const mockClientManager = {
    getClient: () => client,
    isConnected: () => connected,
    state: { status: connected ? 'connected' : 'disconnected' } as { status: string; message?: string },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    },
    emit: (event: string, ...args: unknown[]) => {
      const handlers = eventHandlers[event] ?? [];
      for (const h of handlers) h(...args);
    },
  };

  const mockContext = {
    workspaceState,
  };

  const provider = new EdgesProvider(mockClientManager, mockContext);

  return { provider, mockClientManager, workspaceState };
}

// ============================================================================
// SECTION 1: Edge type filtering
// ============================================================================

describe('EdgesProvider -- edge type filtering', () => {
  it('setHiddenEdgeTypes updates internal state and fires change event', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    let changeEventFired = false;
    provider.onDidChangeTreeData(() => {
      changeEventFired = true;
    });

    provider.setHiddenEdgeTypes(new Set(['CALLS', 'IMPORTS']));
    assert.ok(changeEventFired, 'Change event should fire when hidden edge types are set');
  });

  it('getHiddenEdgeTypes returns a copy (not the internal set)', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    provider.setHiddenEdgeTypes(new Set(['CALLS']));
    const result = provider.getHiddenEdgeTypes();

    // Mutating the returned set should not affect internal state
    result.add('IMPORTS');
    const result2 = provider.getHiddenEdgeTypes();
    assert.strictEqual(result2.size, 1, 'Internal set should not be mutated by external changes');
    assert.ok(result2.has('CALLS'), 'Internal set should still contain CALLS');
    assert.ok(!result2.has('IMPORTS'), 'Internal set should NOT contain IMPORTS (added to copy)');
  });

  it('getChildren for a node filters out edges with hidden edge types', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'main');
    const childA = makeNode('childA', 'FUNCTION', 'validate');
    const childB = makeNode('childB', 'MODULE', 'utils');

    const graph: MockGraph = {
      nodes: { root: rootNode, childA, childB },
      outgoing: {
        root: [
          makeEdge('root', 'childA', 'CALLS'),
          makeEdge('root', 'childB', 'IMPORTS'),
        ],
      },
      incoming: {},
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);

    // Hide CALLS edges
    provider.setHiddenEdgeTypes(new Set(['CALLS']));

    // Get root item first
    const rootItems = await provider.getChildren(undefined);
    assert.ok(rootItems.length > 0, 'Should have root items');

    // Find the actual node item (may be wrapped in bookmark section structure)
    const nodeItem = rootItems.find((item: any) => item.kind === 'node');
    assert.ok(nodeItem, 'Should have a node item');

    // Get children of root node -- should only show IMPORTS edges, not CALLS
    const children = await provider.getChildren(nodeItem);
    const edgeItems = children.filter((c: any) => c.kind === 'edge');

    // Only IMPORTS edge should remain (CALLS is hidden)
    assert.strictEqual(edgeItems.length, 1, 'Should have 1 edge (CALLS filtered out)');
    assert.strictEqual(edgeItems[0].edge.edgeType, 'IMPORTS', 'Remaining edge should be IMPORTS');
  });

  it('getChildren for a node shows edges NOT in hidden set', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'main');
    const childA = makeNode('childA', 'FUNCTION', 'validate');
    const childB = makeNode('childB', 'MODULE', 'utils');

    const graph: MockGraph = {
      nodes: { root: rootNode, childA, childB },
      outgoing: {
        root: [
          makeEdge('root', 'childA', 'CALLS'),
          makeEdge('root', 'childB', 'IMPORTS'),
        ],
      },
      incoming: {},
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);

    // Hide IMPORTS edges -- CALLS should still show
    provider.setHiddenEdgeTypes(new Set(['IMPORTS']));

    const rootItems = await provider.getChildren(undefined);
    const nodeItem = rootItems.find((item: any) => item.kind === 'node');
    assert.ok(nodeItem, 'Should have a node item');

    const children = await provider.getChildren(nodeItem);
    const edgeItems = children.filter((c: any) => c.kind === 'edge');

    assert.strictEqual(edgeItems.length, 1, 'Should have 1 edge (IMPORTS filtered out)');
    assert.strictEqual(edgeItems[0].edge.edgeType, 'CALLS', 'Remaining edge should be CALLS');
  });

  it('empty hiddenEdgeTypes shows all edges (default behavior)', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'main');
    const childA = makeNode('childA', 'FUNCTION', 'validate');
    const childB = makeNode('childB', 'MODULE', 'utils');

    const graph: MockGraph = {
      nodes: { root: rootNode, childA, childB },
      outgoing: {
        root: [
          makeEdge('root', 'childA', 'CALLS'),
          makeEdge('root', 'childB', 'IMPORTS'),
        ],
      },
      incoming: {},
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);

    // Default: no hidden edge types
    const rootItems = await provider.getChildren(undefined);
    const nodeItem = rootItems.find((item: any) => item.kind === 'node');
    assert.ok(nodeItem, 'Should have a node item');

    const children = await provider.getChildren(nodeItem);
    const edgeItems = children.filter((c: any) => c.kind === 'edge');

    assert.strictEqual(edgeItems.length, 2, 'Should have 2 edges (nothing filtered)');
    const edgeTypes = edgeItems.map((e: any) => e.edge.edgeType).sort();
    assert.deepStrictEqual(edgeTypes, ['CALLS', 'IMPORTS'], 'Both edge types should be present');
  });
});

// ============================================================================
// SECTION 2: Bookmarks
// ============================================================================

describe('EdgesProvider -- bookmarks', () => {
  it('loadBookmarks reads from workspaceState', () => {
    const bookmarkedNode = makeNode('bm1', 'FUNCTION', 'bookmarked');
    const workspaceState = createMockWorkspaceState({
      'grafema.bookmarks': [bookmarkedNode],
    });

    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph, { workspaceState });

    // After construction, bookmarks should be loaded from workspaceState
    const bookmarks = provider.getBookmarks();
    assert.strictEqual(bookmarks.length, 1, 'Should have 1 bookmark from workspaceState');
    assert.strictEqual(bookmarks[0].id, 'bm1', 'Bookmark should be the stored node');
  });

  it('loadBookmarks handles corrupt data (non-array) gracefully -> returns []', () => {
    const workspaceState = createMockWorkspaceState({
      'grafema.bookmarks': 'not-an-array',
    });

    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph, { workspaceState });

    const bookmarks = provider.getBookmarks();
    assert.strictEqual(bookmarks.length, 0, 'Corrupt data should result in empty bookmarks');
  });

  it('loadBookmarks handles missing key -> returns []', () => {
    const workspaceState = createMockWorkspaceState({});

    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph, { workspaceState });

    const bookmarks = provider.getBookmarks();
    assert.strictEqual(bookmarks.length, 0, 'Missing key should result in empty bookmarks');
  });

  it('addBookmark adds node and persists', async () => {
    const workspaceState = createMockWorkspaceState();
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph, { workspaceState });

    const node = makeNode('bm1', 'FUNCTION', 'myFunc');
    provider.addBookmark(node);

    const bookmarks = provider.getBookmarks();
    assert.strictEqual(bookmarks.length, 1, 'Should have 1 bookmark after add');
    assert.strictEqual(bookmarks[0].id, 'bm1', 'Bookmark id should match');

    // Verify persistence to workspaceState
    const stored = workspaceState.get<WireNode[]>('grafema.bookmarks', []);
    assert.strictEqual(stored.length, 1, 'workspaceState should have 1 bookmark');
  });

  it('addBookmark does not add duplicate (same id)', () => {
    const workspaceState = createMockWorkspaceState();
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph, { workspaceState });

    const node = makeNode('bm1', 'FUNCTION', 'myFunc');
    provider.addBookmark(node);
    provider.addBookmark(node); // duplicate

    const bookmarks = provider.getBookmarks();
    assert.strictEqual(bookmarks.length, 1, 'Should still have 1 bookmark (no duplicates)');
  });

  it('addBookmark caps at 20 bookmarks', () => {
    const workspaceState = createMockWorkspaceState();
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph, { workspaceState });

    // Add 25 bookmarks
    for (let i = 0; i < 25; i++) {
      const node = makeNode(`bm${i}`, 'FUNCTION', `func${i}`);
      provider.addBookmark(node);
    }

    const bookmarks = provider.getBookmarks();
    assert.ok(bookmarks.length <= 20, `Should cap at 20 bookmarks, got ${bookmarks.length}`);
  });

  it('addBookmark fires change event', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    let changeEventFired = false;
    provider.onDidChangeTreeData(() => {
      changeEventFired = true;
    });

    const node = makeNode('bm1', 'FUNCTION', 'myFunc');
    provider.addBookmark(node);

    assert.ok(changeEventFired, 'Change event should fire when bookmark is added');
  });

  it('removeBookmark removes by id and persists', () => {
    const workspaceState = createMockWorkspaceState();
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph, { workspaceState });

    const node1 = makeNode('bm1', 'FUNCTION', 'func1');
    const node2 = makeNode('bm2', 'FUNCTION', 'func2');
    provider.addBookmark(node1);
    provider.addBookmark(node2);

    provider.removeBookmark('bm1');

    const bookmarks = provider.getBookmarks();
    assert.strictEqual(bookmarks.length, 1, 'Should have 1 bookmark after removal');
    assert.strictEqual(bookmarks[0].id, 'bm2', 'Remaining bookmark should be bm2');

    // Verify persistence
    const stored = workspaceState.get<WireNode[]>('grafema.bookmarks', []);
    assert.strictEqual(stored.length, 1, 'workspaceState should have 1 bookmark');
  });

  it('removeBookmark fires change event', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    const node = makeNode('bm1', 'FUNCTION', 'myFunc');
    provider.addBookmark(node);

    let changeEventFired = false;
    provider.onDidChangeTreeData(() => {
      changeEventFired = true;
    });

    provider.removeBookmark('bm1');
    assert.ok(changeEventFired, 'Change event should fire when bookmark is removed');
  });

  it('isBookmarked returns true for bookmarked nodes', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    const node = makeNode('bm1', 'FUNCTION', 'myFunc');
    provider.addBookmark(node);

    assert.strictEqual(provider.isBookmarked('bm1'), true, 'Should return true for bookmarked node');
  });

  it('isBookmarked returns false for non-bookmarked nodes', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    assert.strictEqual(provider.isBookmarked('nonexistent'), false, 'Should return false for non-bookmarked node');
  });

  it('saveBookmarks writes to workspaceState', () => {
    const workspaceState = createMockWorkspaceState();
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph, { workspaceState });

    const node1 = makeNode('bm1', 'FUNCTION', 'func1');
    const node2 = makeNode('bm2', 'FUNCTION', 'func2');
    provider.addBookmark(node1);
    provider.addBookmark(node2);

    const stored = workspaceState.get<WireNode[]>('grafema.bookmarks', []);
    assert.strictEqual(stored.length, 2, 'workspaceState should contain 2 bookmarks');
    assert.strictEqual(stored[0].id, 'bm1');
    assert.strictEqual(stored[1].id, 'bm2');
  });
});

// ============================================================================
// SECTION 3: Improved labels -- formatFilePath
// ============================================================================

describe('EdgesProvider -- formatFilePath', () => {
  it('formatFilePath returns last 2 path segments', () => {
    assert.ok(formatFilePath, 'formatFilePath must be exported (from types.ts or edgesProvider.ts)');
    const result = formatFilePath!('src/utils/helpers/format.ts');
    assert.strictEqual(result, 'helpers/format.ts', 'Should return last 2 segments');
  });

  it('formatFilePath handles single segment path', () => {
    assert.ok(formatFilePath, 'formatFilePath must be exported');
    const result = formatFilePath!('app.ts');
    assert.strictEqual(result, 'app.ts', 'Single segment should return as-is');
  });

  it('formatFilePath handles empty string', () => {
    assert.ok(formatFilePath, 'formatFilePath must be exported');
    const result = formatFilePath!('');
    assert.strictEqual(result, '', 'Empty string should return empty string');
  });

  it('formatFilePath handles two-segment path', () => {
    assert.ok(formatFilePath, 'formatFilePath must be exported');
    const result = formatFilePath!('src/app.ts');
    assert.strictEqual(result, 'src/app.ts', 'Two-segment path should return both segments');
  });
});

// ============================================================================
// SECTION 4: Improved labels -- node description
// ============================================================================

describe('EdgesProvider -- node description in getTreeItem', () => {
  it('node description shows file and exported status', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    const node = makeNode('n1', 'FUNCTION', 'myFunc', {
      file: 'src/utils/helpers/format.ts',
      exported: true,
    });

    const element = {
      kind: 'node' as const,
      node,
      metadata: { line: 10 },
      isRoot: false,
    };

    const treeItem = provider.getTreeItem(element);

    // Description should contain shortened file path
    assert.ok(
      treeItem.description && treeItem.description.includes('helpers/format.ts'),
      `Description should include shortened file path, got: "${treeItem.description}"`,
    );
    // Description should indicate exported
    assert.ok(
      treeItem.description && treeItem.description.includes('exported'),
      `Description should include exported status, got: "${treeItem.description}"`,
    );
  });

  it('node description shows only file when not exported', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    const node = makeNode('n1', 'FUNCTION', 'myFunc', {
      file: 'src/utils/format.ts',
      exported: false,
    });

    const element = {
      kind: 'node' as const,
      node,
      metadata: { line: 10 },
      isRoot: false,
    };

    const treeItem = provider.getTreeItem(element);

    // Description should contain file but not 'exported'
    assert.ok(
      treeItem.description && treeItem.description.includes('utils/format.ts'),
      `Description should include file path, got: "${treeItem.description}"`,
    );
    assert.ok(
      !treeItem.description || !treeItem.description.includes('exported'),
      `Description should NOT include 'exported' when not exported, got: "${treeItem.description}"`,
    );
  });

  it("node description shows '<- path' when on navigation path", () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    const node = makeNode('n1', 'FUNCTION', 'myFunc', {
      file: 'src/utils/format.ts',
      exported: true,
    });

    const element = {
      kind: 'node' as const,
      node,
      metadata: { line: 10 },
      isOnPath: true,
      isRoot: false,
    };

    const treeItem = provider.getTreeItem(element);

    // When on path, description should show path marker instead of file
    assert.ok(
      treeItem.description && treeItem.description.includes('path'),
      `Description should show path marker when on navigation path, got: "${treeItem.description}"`,
    );
  });

  it('node description handles empty/falsy file gracefully', () => {
    const graph: MockGraph = { nodes: {}, outgoing: {}, incoming: {} };
    const { provider } = createProvider(graph);

    const node = makeNode('n1', 'FUNCTION', 'myFunc', {
      file: '',
      exported: false,
    });

    const element = {
      kind: 'node' as const,
      node,
      metadata: { line: 10 },
      isRoot: false,
    };

    const treeItem = provider.getTreeItem(element);

    // Should not crash with empty file
    // Description may be undefined or empty string -- that is fine
    assert.ok(
      treeItem.description === undefined
        || treeItem.description === ''
        || typeof treeItem.description === 'string',
      'Should handle empty file without crashing',
    );
  });
});

// ============================================================================
// SECTION 5: Tree structure with bookmarks
// ============================================================================

describe('EdgesProvider -- tree structure with bookmarks', () => {
  it('getChildren root returns bookmark-section + root node when both exist', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'main');
    const bmNode = makeNode('bm1', 'FUNCTION', 'bookmarked');

    const graph: MockGraph = {
      nodes: { root: rootNode, bm1: bmNode },
      outgoing: {},
      incoming: {},
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);
    provider.addBookmark(bmNode);

    const children = await provider.getChildren(undefined);

    // Should have at least 2 items: bookmark section + root node
    assert.ok(children.length >= 2, `Should have at least 2 root children, got ${children.length}`);

    // One should be a bookmark section and one should be the root node
    const hasBookmarkSection = children.some(
      (c: any) => c.kind === 'bookmark-section' || c.kind === 'bookmarks',
    );
    const hasNodeItem = children.some((c: any) => c.kind === 'node');

    assert.ok(hasBookmarkSection, 'Should have a bookmark section');
    assert.ok(hasNodeItem, 'Should have a node item');
  });

  it('getChildren root returns only root node when no bookmarks', async () => {
    const rootNode = makeNode('root', 'FUNCTION', 'main');

    const graph: MockGraph = {
      nodes: { root: rootNode },
      outgoing: {},
      incoming: {},
    };

    const { provider } = createProvider(graph);
    provider.setRootNode(rootNode);

    const children = await provider.getChildren(undefined);

    // Should have just the root node (no bookmark section)
    const nodeItems = children.filter((c: any) => c.kind === 'node');
    const bookmarkSections = children.filter(
      (c: any) => c.kind === 'bookmark-section' || c.kind === 'bookmarks',
    );

    assert.ok(nodeItems.length >= 1, 'Should have at least 1 node item');
    assert.strictEqual(bookmarkSections.length, 0, 'Should have no bookmark section when no bookmarks');
  });

  it('getChildren root returns only bookmark-section when rootNode is null', async () => {
    const bmNode = makeNode('bm1', 'FUNCTION', 'bookmarked');

    const graph: MockGraph = {
      nodes: { bm1: bmNode },
      outgoing: {},
      incoming: {},
    };

    const { provider } = createProvider(graph);
    // Do NOT set root node
    provider.addBookmark(bmNode);

    const children = await provider.getChildren(undefined);

    // Should have bookmark section but no root node
    const hasBookmarkSection = children.some(
      (c: any) => c.kind === 'bookmark-section' || c.kind === 'bookmarks',
    );
    const hasNodeItem = children.some((c: any) => c.kind === 'node');

    assert.ok(hasBookmarkSection, 'Should have a bookmark section when bookmarks exist');
    assert.ok(!hasNodeItem, 'Should NOT have a root node item when rootNode is null');
  });

  it('getChildren bookmark-section returns bookmark items', async () => {
    const bmNode1 = makeNode('bm1', 'FUNCTION', 'bookmarked1');
    const bmNode2 = makeNode('bm2', 'FUNCTION', 'bookmarked2');

    const graph: MockGraph = {
      nodes: { bm1: bmNode1, bm2: bmNode2 },
      outgoing: {},
      incoming: {},
    };

    const { provider } = createProvider(graph);
    provider.addBookmark(bmNode1);
    provider.addBookmark(bmNode2);

    // Get root level items (should include bookmark section)
    const rootChildren = await provider.getChildren(undefined);
    const bookmarkSection = rootChildren.find(
      (c: any) => c.kind === 'bookmark-section' || c.kind === 'bookmarks',
    );
    assert.ok(bookmarkSection, 'Should have a bookmark section');

    // Get children of bookmark section
    const bookmarkChildren = await provider.getChildren(bookmarkSection);
    assert.strictEqual(bookmarkChildren.length, 2, 'Bookmark section should have 2 children');

    // Verify the bookmark children reference the correct nodes
    const bookmarkIds = bookmarkChildren
      .filter((c: any) => c.kind === 'node' || c.kind === 'bookmark')
      .map((c: any) => c.node?.id ?? c.id)
      .sort();

    assert.ok(
      bookmarkIds.includes('bm1') && bookmarkIds.includes('bm2'),
      `Bookmark children should include bm1 and bm2, got: ${JSON.stringify(bookmarkIds)}`,
    );
  });
});
