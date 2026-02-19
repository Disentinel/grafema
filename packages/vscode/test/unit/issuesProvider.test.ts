/**
 * Unit tests for IssuesProvider -- REG-515
 *
 * Tests the ISSUES panel TreeDataProvider: severity grouping (violations,
 * connectivity, warnings), badge count, DiagnosticCollection integration,
 * reconnect behavior, unknown categories, and malformed metadata handling.
 *
 * Mock setup: in-memory issue nodes with controlled countNodesByType,
 * queryNodes, getAllNodes. No RFDB server needed -- pure logic tests.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode, IRFDBClient } from '@grafema/types';
import { parseNodeMetadata } from '../../src/types.js';
import type { NodeMetadata } from '../../src/types.js';

// ============================================================================
// Types for IssuesProvider (defined here -- Rob will implement the module)
// ============================================================================

type IssueSectionKind = 'violation' | 'connectivity' | 'warning';

type IssueItem =
  | { kind: 'section'; label: string; icon: string; sectionKind: IssueSectionKind; count: number }
  | { kind: 'issue'; node: WireNode; metadata: NodeMetadata; sectionKind: IssueSectionKind }
  | { kind: 'status'; message: string };

// ============================================================================
// Mock vscode module
//
// IssuesProvider uses vscode.TreeItem, vscode.TreeItemCollapsibleState,
// vscode.ThemeIcon, vscode.EventEmitter, vscode.Uri, vscode.Range,
// vscode.Diagnostic, vscode.DiagnosticSeverity.
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

class MockRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

class MockDiagnostic {
  range: MockRange;
  message: string;
  severity: number;
  source?: string;
  code?: string;
  constructor(range: MockRange, message: string, severity?: number) {
    this.range = range;
    this.message = message;
    this.severity = severity ?? 0;
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
    Range: MockRange,
    Diagnostic: MockDiagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
    languages: { registerCodeLensProvider: () => ({ dispose: () => {} }) },
    Uri: { file: (p: string) => ({ fsPath: p, path: p, toString: () => `file://${p}` }) },
  },
} as any;

// ============================================================================
// Import the module under test
//
// These imports will resolve once issuesProvider.ts is implemented.
// If the module does not exist yet, the test file will fail to load
// with a clear import error -- that is intentional.
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const issuesModule = require('../../src/issuesProvider');
const { IssuesProvider } = issuesModule;

// ============================================================================
// Helper: create a WireNode representing an issue
// ============================================================================

function createIssueNode(
  overrides: Partial<WireNode> & { severity?: string; line?: number; column?: number; plugin?: string; category?: string; message?: string },
): WireNode {
  const {
    severity = 'warning',
    line,
    column,
    plugin,
    category = 'test',
    message = 'Test issue',
    ...nodeOverrides
  } = overrides;
  return {
    id: 'issue:test#' + Math.random().toString(36).slice(2, 8),
    nodeType: 'issue:security',
    name: 'Test issue',
    file: 'src/test.js',
    exported: false,
    metadata: JSON.stringify({ severity, line, column, plugin, category, message }),
    ...nodeOverrides,
  } as WireNode;
}

// ============================================================================
// Helper: create a mock IRFDBClient for IssuesProvider
//
// IssuesProvider uses:
//   - countNodesByType() -> Record<string, number>
//   - queryNodes(query) -> AsyncGenerator<WireNode>
//   - getAllNodes(query?) -> Promise<WireNode[]>
// ============================================================================

interface MockIssueGraph {
  /** Return value for countNodesByType() */
  typeCounts: Record<string, number>;
  /** Nodes returned by queryNodes for each nodeType */
  nodesByType: Record<string, WireNode[]>;
  /** All nodes (for getAllNodes fallback) */
  allNodes: WireNode[];
}

function createMockClient(graph: MockIssueGraph): IRFDBClient {
  return {
    countNodesByType: async () => graph.typeCounts,
    queryNodes: async function* (query: { nodeType?: string }) {
      const nodes = query.nodeType ? (graph.nodesByType[query.nodeType] ?? []) : [];
      for (const node of nodes) {
        yield node;
      }
    },
    getAllNodes: async () => graph.allNodes,
    // Stubs for interface compliance (not used by IssuesProvider)
    getNode: async () => null,
    getOutgoingEdges: async () => [],
    getIncomingEdges: async () => [],
  } as unknown as IRFDBClient;
}

// ============================================================================
// Helper: create an IssuesProvider with a mock client manager
// ============================================================================

interface MockClientManager {
  getClient: () => IRFDBClient;
  isConnected: () => boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

interface MockTreeView {
  badge?: { value: number; tooltip: string } | undefined;
  dispose: () => void;
}

interface MockDiagnosticCollection {
  set: (...args: unknown[]) => void;
  clear: () => void;
  dispose: () => void;
  setCalls: unknown[][];
  clearCalls: number;
}

function createMockTreeView(): MockTreeView {
  return {
    badge: undefined,
    dispose: () => {},
  };
}

function createMockDiagnosticCollection(): MockDiagnosticCollection {
  const mock: MockDiagnosticCollection = {
    setCalls: [],
    clearCalls: 0,
    set(...args: unknown[]) {
      mock.setCalls.push(args);
    },
    clear() {
      mock.clearCalls++;
    },
    dispose: () => {},
  };
  return mock;
}

function createProvider(
  graph: MockIssueGraph,
  options?: { connected?: boolean; workspaceRoot?: string },
) {
  const connected = options?.connected ?? true;
  const workspaceRoot = options?.workspaceRoot ?? '/workspace';
  const client = createMockClient(graph);

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

  const provider = new IssuesProvider(mockClientManager, workspaceRoot);
  const mockTreeView = createMockTreeView();
  const mockDiagnosticCollection = createMockDiagnosticCollection();

  provider.setTreeView(mockTreeView);
  provider.setDiagnosticCollection(mockDiagnosticCollection);

  return { provider, mockClientManager, mockTreeView, mockDiagnosticCollection };
}

// ============================================================================
// SECTION 1: Empty states
// ============================================================================

describe('IssuesProvider -- empty states', () => {
  it('T1: Empty graph (connected, no issue nodes) -- returns "No issues found." status', async () => {
    const graph: MockIssueGraph = {
      typeCounts: {},
      nodesByType: {},
      allNodes: [],
    };

    const { provider, mockTreeView } = createProvider(graph);
    const children = await provider.getChildren(undefined);

    assert.strictEqual(children.length, 1, 'Should return exactly one item');
    assert.strictEqual(children[0].kind, 'status');
    assert.strictEqual(children[0].message, 'No issues found.');

    // Badge should be undefined (no issues)
    assert.strictEqual(mockTreeView.badge, undefined, 'Badge should be undefined when no issues');
  });

  it('T2: Not connected -- returns "Not connected to graph." status', async () => {
    const graph: MockIssueGraph = {
      typeCounts: {},
      nodesByType: {},
      allNodes: [],
    };

    const { provider } = createProvider(graph, { connected: false });
    const children = await provider.getChildren(undefined);

    assert.strictEqual(children.length, 1, 'Should return exactly one item');
    assert.strictEqual(children[0].kind, 'status');
    assert.strictEqual(children[0].message, 'Not connected to graph.');
  });
});

// ============================================================================
// SECTION 2: Severity grouping
// ============================================================================

describe('IssuesProvider -- severity grouping', () => {
  it('T3: Error severity nodes only -- only violations section, badge = count', async () => {
    const node1 = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'eval() is banned',
      severity: 'error',
      line: 10,
    });
    const node2 = createIssueNode({
      id: 'issue:sec#002',
      nodeType: 'issue:security',
      name: 'SQL injection risk',
      severity: 'error',
      line: 20,
    });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 2 },
      nodesByType: { 'issue:security': [node1, node2] },
      allNodes: [node1, node2],
    };

    const { provider, mockTreeView } = createProvider(graph);
    const children = await provider.getChildren(undefined);

    // Should have exactly one section: violations
    const sections = children.filter((c: IssueItem) => c.kind === 'section');
    assert.strictEqual(sections.length, 1, 'Should have exactly 1 section');
    assert.strictEqual(sections[0].sectionKind, 'violation', 'Section should be violation');
    assert.strictEqual(sections[0].count, 2, 'Violation count should be 2');

    // Badge should be 2
    assert.ok(mockTreeView.badge, 'Badge should be set');
    assert.strictEqual(mockTreeView.badge.value, 2, 'Badge value should be 2');
  });

  it('T4: Mixed severity nodes -- three sections in correct order, badge = total', async () => {
    const securityNode = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'eval() is banned',
      severity: 'error',
      line: 10,
    });
    const perfNode = createIssueNode({
      id: 'issue:perf#001',
      nodeType: 'issue:performance',
      name: 'N+1 query',
      severity: 'warning',
      line: 30,
    });
    const connNode = createIssueNode({
      id: 'issue:conn#001',
      nodeType: 'issue:connectivity',
      name: 'Unconnected route /api/health',
      severity: 'warning',
      line: 50,
    });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 1, 'issue:performance': 1, 'issue:connectivity': 1 },
      nodesByType: {
        'issue:security': [securityNode],
        'issue:performance': [perfNode],
        'issue:connectivity': [connNode],
      },
      allNodes: [securityNode, perfNode, connNode],
    };

    const { provider, mockTreeView } = createProvider(graph);
    const children = await provider.getChildren(undefined);

    const sections = children.filter((c: IssueItem) => c.kind === 'section');
    assert.strictEqual(sections.length, 3, 'Should have 3 sections');

    // Order: violations, connectivity, warnings
    assert.strictEqual(sections[0].sectionKind, 'violation', 'First section should be violation');
    assert.strictEqual(sections[1].sectionKind, 'connectivity', 'Second section should be connectivity');
    assert.strictEqual(sections[2].sectionKind, 'warning', 'Third section should be warning');

    assert.strictEqual(sections[0].count, 1);
    assert.strictEqual(sections[1].count, 1);
    assert.strictEqual(sections[2].count, 1);

    // Badge = 3
    assert.ok(mockTreeView.badge, 'Badge should be set');
    assert.strictEqual(mockTreeView.badge.value, 3, 'Badge value should be 3');
  });

  it('T5: Only warning/info nodes -- only warnings section', async () => {
    const styleNodes = [
      createIssueNode({ id: 'issue:style#001', nodeType: 'issue:style', name: 'Unused variable', severity: 'warning' }),
      createIssueNode({ id: 'issue:style#002', nodeType: 'issue:style', name: 'Long function', severity: 'warning' }),
      createIssueNode({ id: 'issue:style#003', nodeType: 'issue:style', name: 'Magic number', severity: 'warning' }),
    ];

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:style': 3 },
      nodesByType: { 'issue:style': styleNodes },
      allNodes: styleNodes,
    };

    const { provider } = createProvider(graph);
    const children = await provider.getChildren(undefined);

    const sections = children.filter((c: IssueItem) => c.kind === 'section');
    assert.strictEqual(sections.length, 1, 'Should have exactly 1 section');
    assert.strictEqual(sections[0].sectionKind, 'warning', 'Section should be warning');
    assert.strictEqual(sections[0].count, 3, 'Warning count should be 3');
  });
});

// ============================================================================
// SECTION 3: Section children
// ============================================================================

describe('IssuesProvider -- section children', () => {
  it('T6: getChildren(section) returns issue items with parsed metadata', async () => {
    const node1 = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'eval() is banned',
      severity: 'error',
      line: 10,
      column: 5,
    });
    const node2 = createIssueNode({
      id: 'issue:sec#002',
      nodeType: 'issue:security',
      name: 'SQL injection',
      severity: 'error',
      line: 20,
    });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 2 },
      nodesByType: { 'issue:security': [node1, node2] },
      allNodes: [node1, node2],
    };

    const { provider } = createProvider(graph);

    // First call to get sections
    const sections = await provider.getChildren(undefined);
    const violationSection = sections.find(
      (c: IssueItem) => c.kind === 'section' && c.sectionKind === 'violation',
    );
    assert.ok(violationSection, 'Should have a violation section');

    // Get children of the section
    const issueItems = await provider.getChildren(violationSection);
    assert.strictEqual(issueItems.length, 2, 'Should have 2 issue items');

    for (const item of issueItems) {
      assert.strictEqual(item.kind, 'issue', 'Each child should be an issue item');
      assert.strictEqual(item.sectionKind, 'violation', 'Each child should be in violation section');
      assert.ok(item.node, 'Issue item should have a node');
      assert.ok(item.metadata, 'Issue item should have parsed metadata');
    }
  });
});

// ============================================================================
// SECTION 4: getTreeItem
// ============================================================================

describe('IssuesProvider -- getTreeItem', () => {
  it('T7: Issue item WITH location -- has gotoLocation command', async () => {
    const node = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'eval() is banned',
      file: 'src/a.js',
      severity: 'error',
      line: 5,
      column: 0,
    });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 1 },
      nodesByType: { 'issue:security': [node] },
      allNodes: [node],
    };

    const { provider } = createProvider(graph);

    // Load sections first
    const sections = await provider.getChildren(undefined);
    const violationSection = sections.find(
      (c: IssueItem) => c.kind === 'section' && c.sectionKind === 'violation',
    );

    // Get the issue items
    const items = await provider.getChildren(violationSection);
    assert.strictEqual(items.length, 1);

    const issueItem = items[0] as IssueItem;
    const treeItem = provider.getTreeItem(issueItem);

    assert.ok(treeItem.command, 'Should have a command');
    assert.strictEqual(treeItem.command.command, 'grafema.gotoLocation', 'Command should be grafema.gotoLocation');
    assert.deepStrictEqual(
      treeItem.command.arguments,
      ['src/a.js', 5, 0],
      'Command arguments should be [file, line, column]',
    );

    // Description should show file:line
    assert.ok(
      treeItem.description && treeItem.description.includes('src/a.js') && treeItem.description.includes('5'),
      'Description should contain file:line',
    );
  });

  it('T8: Issue item WITHOUT location -- no command', async () => {
    const node = createIssueNode({
      id: 'issue:style#001',
      nodeType: 'issue:style',
      name: 'some issue',
      file: undefined as unknown as string,
      severity: 'warning',
    });
    // Remove line/column from metadata
    node.metadata = JSON.stringify({ severity: 'warning' });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:style': 1 },
      nodesByType: { 'issue:style': [node] },
      allNodes: [node],
    };

    const { provider } = createProvider(graph);

    const sections = await provider.getChildren(undefined);
    const warningsSection = sections.find(
      (c: IssueItem) => c.kind === 'section' && c.sectionKind === 'warning',
    );

    const items = await provider.getChildren(warningsSection);
    const issueItem = items[0] as IssueItem;
    const treeItem = provider.getTreeItem(issueItem);

    assert.strictEqual(treeItem.command, undefined, 'Should have no command when no location');
  });

  it('T15: Section item -- Expanded state, correct icon, description = count', () => {
    const graph: MockIssueGraph = {
      typeCounts: {},
      nodesByType: {},
      allNodes: [],
    };

    const { provider } = createProvider(graph);

    const sectionItem: IssueItem = {
      kind: 'section',
      label: 'Violations',
      icon: 'error',
      sectionKind: 'violation',
      count: 3,
    };

    const treeItem = provider.getTreeItem(sectionItem);

    // TreeItemCollapsibleState.Expanded = 2
    assert.strictEqual(treeItem.collapsibleState, 2, 'Section should be Expanded');
    assert.ok(treeItem.iconPath, 'Should have an icon');
    assert.strictEqual(treeItem.iconPath.id, 'error', 'Icon should be "error"');
    assert.strictEqual(treeItem.description, '3', 'Description should be the count as string');
  });
});

// ============================================================================
// SECTION 5: DiagnosticCollection
// ============================================================================

describe('IssuesProvider -- DiagnosticCollection', () => {
  it('T9: DiagnosticCollection populated after load -- set() called with correct URI and severity', async () => {
    const node = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'eval() is banned',
      file: 'src/a.js',
      severity: 'error',
      line: 10,
      column: 5,
    });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 1 },
      nodesByType: { 'issue:security': [node] },
      allNodes: [node],
    };

    const { provider, mockDiagnosticCollection } = createProvider(graph, { workspaceRoot: '/workspace' });

    // Trigger load
    await provider.getChildren(undefined);

    // Verify diagnosticCollection.set() was called
    assert.ok(mockDiagnosticCollection.setCalls.length > 0, 'set() should have been called');

    // Find the call that sets diagnostics for our file
    const setCall = mockDiagnosticCollection.setCalls.find(
      (call: unknown[]) => {
        const uri = call[0] as { fsPath: string };
        return uri.fsPath.includes('src/a.js');
      },
    );
    assert.ok(setCall, 'set() should have been called with URI containing src/a.js');

    const diagnostics = setCall[1] as MockDiagnostic[];
    assert.strictEqual(diagnostics.length, 1, 'Should have 1 diagnostic');
    // DiagnosticSeverity.Error = 0
    assert.strictEqual(diagnostics[0].severity, 0, 'Diagnostic severity should be Error (0)');
    assert.strictEqual(diagnostics[0].source, 'Grafema', 'Diagnostic source should be "Grafema"');
  });

  it('T10: DiagnosticCollection skips nodes without file or line', async () => {
    const node = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'global issue',
      file: undefined as unknown as string,
      severity: 'error',
    });
    node.metadata = JSON.stringify({ severity: 'error' });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 1 },
      nodesByType: { 'issue:security': [node] },
      allNodes: [node],
    };

    const { provider, mockDiagnosticCollection } = createProvider(graph);

    // Trigger load
    await provider.getChildren(undefined);

    // clear() should have been called, but set() should NOT (no file means skip)
    assert.ok(mockDiagnosticCollection.clearCalls > 0, 'clear() should have been called');
    assert.strictEqual(mockDiagnosticCollection.setCalls.length, 0, 'set() should NOT have been called');
  });

  it('T11: DiagnosticCollection cleared on refresh', async () => {
    const node = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'eval() is banned',
      file: 'src/a.js',
      severity: 'error',
      line: 10,
    });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 1 },
      nodesByType: { 'issue:security': [node] },
      allNodes: [node],
    };

    const { provider, mockDiagnosticCollection } = createProvider(graph);

    // Initial load
    await provider.getChildren(undefined);
    const initialClearCount = mockDiagnosticCollection.clearCalls;

    // Refresh
    provider.refresh();

    // Trigger re-load
    await provider.getChildren(undefined);

    // clear() should have been called again during refresh
    assert.ok(
      mockDiagnosticCollection.clearCalls > initialClearCount,
      'clear() should have been called again after refresh',
    );
  });
});

// ============================================================================
// SECTION 6: Reconnect behavior
// ============================================================================

describe('IssuesProvider -- reconnect behavior', () => {
  it('T12: Reconnect clears cache and re-fires change event', async () => {
    const node = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'eval() is banned',
      severity: 'error',
      line: 10,
    });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 1 },
      nodesByType: { 'issue:security': [node] },
      allNodes: [node],
    };

    const { provider, mockClientManager } = createProvider(graph);

    // Initial load
    const initialChildren = await provider.getChildren(undefined);
    const initialSections = initialChildren.filter((c: IssueItem) => c.kind === 'section');
    assert.ok(initialSections.length > 0, 'Should have sections initially');

    // Track _onDidChangeTreeData fires via onDidChangeTreeData event
    let changeEventFired = false;
    provider.onDidChangeTreeData(() => {
      changeEventFired = true;
    });

    // Emit reconnected event
    mockClientManager.emit('reconnected');

    assert.ok(changeEventFired, 'Change event should have fired after reconnect');

    // After reconnect, cache is cleared. Next getChildren() triggers a fresh loadIssues()
    const childrenAfterReconnect = await provider.getChildren(undefined);
    // This should work normally (re-fetch from the same mock client)
    assert.ok(childrenAfterReconnect.length > 0, 'Should still get data after reconnect');
  });
});

// ============================================================================
// SECTION 7: Unknown categories
// ============================================================================

describe('IssuesProvider -- unknown categories', () => {
  it('T13: Unknown issue category (plugin-defined) -- falls back to getAllNodes, appears in warnings', async () => {
    const customNode1 = createIssueNode({
      id: 'issue:custom#001',
      nodeType: 'issue:custom-plugin',
      name: 'Custom plugin finding 1',
      severity: 'warning',
      line: 5,
    });
    const customNode2 = createIssueNode({
      id: 'issue:custom#002',
      nodeType: 'issue:custom-plugin',
      name: 'Custom plugin finding 2',
      severity: 'warning',
      line: 15,
    });

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:custom-plugin': 2 },
      nodesByType: {}, // known categories don't have these nodes
      allNodes: [customNode1, customNode2], // getAllNodes fallback returns them
    };

    const { provider } = createProvider(graph);
    const children = await provider.getChildren(undefined);

    const sections = children.filter((c: IssueItem) => c.kind === 'section');
    assert.strictEqual(sections.length, 1, 'Should have exactly 1 section');
    assert.strictEqual(sections[0].sectionKind, 'warning', 'Unknown category should land in warnings');
    assert.strictEqual(sections[0].count, 2, 'Should have 2 warnings from custom plugin');
  });
});

// ============================================================================
// SECTION 8: Badge tooltip
// ============================================================================

describe('IssuesProvider -- badge', () => {
  it('T14: Badge tooltip singular/plural and undefined when 0', async () => {
    // 1 issue -- singular tooltip
    const singleNode = createIssueNode({
      id: 'issue:sec#001',
      nodeType: 'issue:security',
      name: 'eval() is banned',
      severity: 'error',
      line: 10,
    });

    const graph1: MockIssueGraph = {
      typeCounts: { 'issue:security': 1 },
      nodesByType: { 'issue:security': [singleNode] },
      allNodes: [singleNode],
    };

    const { provider: p1, mockTreeView: tv1 } = createProvider(graph1);
    await p1.getChildren(undefined);

    assert.ok(tv1.badge, 'Badge should be set for 1 issue');
    assert.strictEqual(tv1.badge.value, 1, 'Badge value should be 1');
    assert.strictEqual(tv1.badge.tooltip, '1 issue in graph', 'Singular tooltip');

    // 3 issues -- plural tooltip
    const threeNodes = [
      createIssueNode({ id: 'issue:sec#001', nodeType: 'issue:security', severity: 'error' }),
      createIssueNode({ id: 'issue:perf#001', nodeType: 'issue:performance', severity: 'warning' }),
      createIssueNode({ id: 'issue:conn#001', nodeType: 'issue:connectivity', severity: 'warning' }),
    ];

    const graph3: MockIssueGraph = {
      typeCounts: { 'issue:security': 1, 'issue:performance': 1, 'issue:connectivity': 1 },
      nodesByType: {
        'issue:security': [threeNodes[0]],
        'issue:performance': [threeNodes[1]],
        'issue:connectivity': [threeNodes[2]],
      },
      allNodes: threeNodes,
    };

    const { provider: p3, mockTreeView: tv3 } = createProvider(graph3);
    await p3.getChildren(undefined);

    assert.ok(tv3.badge, 'Badge should be set for 3 issues');
    assert.strictEqual(tv3.badge.value, 3, 'Badge value should be 3');
    assert.strictEqual(tv3.badge.tooltip, '3 issues in graph', 'Plural tooltip');

    // 0 issues -- badge undefined
    const graphEmpty: MockIssueGraph = {
      typeCounts: {},
      nodesByType: {},
      allNodes: [],
    };

    const { provider: p0, mockTreeView: tv0 } = createProvider(graphEmpty);
    await p0.getChildren(undefined);

    assert.strictEqual(tv0.badge, undefined, 'Badge should be undefined when 0 issues');
  });
});

// ============================================================================
// SECTION 9: Malformed metadata (Dijkstra GAP 4 -- T16)
// ============================================================================

describe('IssuesProvider -- malformed metadata', () => {
  it('T16: Node with bad JSON metadata -- appears in warnings, no crash', async () => {
    const malformedNode: WireNode = {
      id: 'issue:bad#001',
      nodeType: 'issue:security',
      name: 'Issue with bad metadata',
      file: 'src/bad.js',
      exported: false,
      metadata: 'this is not valid JSON {{{',
    } as WireNode;

    const graph: MockIssueGraph = {
      typeCounts: { 'issue:security': 1 },
      nodesByType: { 'issue:security': [malformedNode] },
      allNodes: [malformedNode],
    };

    const { provider } = createProvider(graph);

    // Should not throw
    const children = await provider.getChildren(undefined);

    // The node has malformed metadata. parseNodeMetadata returns {}.
    // metadata.severity is undefined -> unknown severity -> warnings bucket.
    // Since nodeType is NOT 'issue:connectivity', and severity is not 'error',
    // the node goes to warnings.
    const sections = children.filter((c: IssueItem) => c.kind === 'section');
    assert.ok(sections.length >= 1, 'Should have at least one section');

    const warningsSection = sections.find((s: IssueItem) => s.kind === 'section' && s.sectionKind === 'warning');
    assert.ok(warningsSection, 'Malformed-metadata node should land in warnings section');
    assert.strictEqual(warningsSection.count, 1, 'Should have 1 warning');

    // Verify getTreeItem does not crash
    const issueItems = await provider.getChildren(warningsSection);
    assert.strictEqual(issueItems.length, 1, 'Should have 1 issue item');
    const treeItem = provider.getTreeItem(issueItems[0]);
    assert.ok(treeItem, 'getTreeItem should return a valid TreeItem');
    assert.ok(treeItem.label, 'TreeItem should have a label');
  });
});
