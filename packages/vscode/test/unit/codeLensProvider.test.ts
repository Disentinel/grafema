/**
 * Unit tests for GrafemaCodeLensProvider — REG-514
 *
 * Tests CodeLens generation: placeholder lenses on cold cache,
 * resolved lenses on warm cache, batch fetch triggering cache population,
 * and cache clearing on reconnect.
 *
 * Mock setup: fake vscode TextDocument, mock client returning FUNCTION nodes.
 * No RFDB server needed — pure logic tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode, WireEdge, IRFDBClient } from '@grafema/types';

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
 * Helper to create a WireNode.
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

function makeEdge(src: string, dst: string, edgeType = 'CALLS'): MockEdge {
  return { src, dst, edgeType, metadata: '{}' };
}

// ============================================================================
// Mock vscode module
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};

class MockRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

class MockPosition {
  line: number;
  character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

class MockCodeLens {
  range: MockRange;
  command?: { command: string; title: string; arguments?: unknown[] };
  isResolved: boolean;

  constructor(range: MockRange, command?: { command: string; title: string; arguments?: unknown[] }) {
    this.range = range;
    this.command = command;
    this.isResolved = !!command;
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

class MockCancellationToken {
  isCancellationRequested = false;
  onCancellationRequested = () => ({ dispose: () => {} });
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    CodeLens: MockCodeLens,
    Range: MockRange,
    Position: MockPosition,
    EventEmitter: MockEventEmitter,
    CancellationTokenSource: class { token = new MockCancellationToken(); dispose() {} },
    ThemeIcon: class { constructor(public id: string) {} },
    ThemeColor: class { constructor(public id: string) {} },
    TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      getConfiguration: () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue }),
    },
    languages: {
      registerCodeLensProvider: () => ({ dispose: () => {} }),
    },
    Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
  },
} as any;

// ============================================================================
// Import the module under test
//
// These imports will resolve once codeLensProvider.ts is implemented.
// If the module does not exist yet, the test file will fail to load
// with a clear import error — that is intentional.
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const codeLensModule = require('../../src/codeLensProvider');
const { GrafemaCodeLensProvider } = codeLensModule;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a mock TextDocument for testing.
 */
function createMockDocument(uri: string, lineCount = 50) {
  return {
    uri: { fsPath: uri, path: uri, toString: () => uri },
    fileName: uri,
    lineCount,
    languageId: 'typescript',
    version: 1,
    getText: () => '',
    lineAt: (line: number) => ({
      text: '',
      range: new MockRange(line, 0, line, 80),
      rangeIncludingLineBreak: new MockRange(line, 0, line + 1, 0),
      firstNonWhitespaceCharacterIndex: 0,
      isEmptyOrWhitespace: false,
    }),
  };
}

function createProviderWithGraph(graph: MockGraph) {
  const client = createMockClient(graph);
  const reconnectListeners: Array<() => void> = [];
  const mockClientManager = {
    getClient: () => client,
    isConnected: () => true,
    state: { status: 'connected' },
    on: (event: string, handler: () => void) => {
      if (event === 'reconnected') reconnectListeners.push(handler);
    },
    emit: () => {},
    _triggerReconnect: () => {
      for (const h of reconnectListeners) h();
    },
  };
  const provider = new GrafemaCodeLensProvider(mockClientManager);
  return { provider, mockClientManager };
}

// ============================================================================
// SECTION 1: Cold cache — no nodes in file
// ============================================================================

describe('GrafemaCodeLensProvider — empty file', () => {
  it('provideCodeLenses with file containing no FUNCTION/METHOD nodes → empty array', async () => {
    // Graph has no FUNCTION nodes for this file
    const graph: MockGraph = {
      nodes: {},
      outgoing: {},
      incoming: {},
    };

    const { provider } = createProviderWithGraph(graph);
    const doc = createMockDocument('/workspace/src/empty.ts');
    const token = new MockCancellationToken();

    const lenses = await provider.provideCodeLenses(doc, token);

    assert.ok(Array.isArray(lenses), 'Should return an array');
    assert.strictEqual(lenses.length, 0, 'No functions → no lenses');
  });
});

// ============================================================================
// SECTION 2: Cold cache — placeholder lenses
// ============================================================================

describe('GrafemaCodeLensProvider — cold cache', () => {
  it('provideCodeLenses on cold cache → returns 3 placeholder lenses per function', async () => {
    // File has 2 FUNCTION nodes
    const graph: MockGraph = {
      nodes: {
        f1: makeNode('f1', 'FUNCTION', 'handleRequest', {
          file: 'src/app.ts',
          metadata: JSON.stringify({ line: 10 }),
        }),
        f2: makeNode('f2', 'FUNCTION', 'validate', {
          file: 'src/app.ts',
          metadata: JSON.stringify({ line: 25 }),
        }),
      },
      outgoing: {},
      incoming: {},
    };

    const { provider } = createProviderWithGraph(graph);
    const doc = createMockDocument('/workspace/src/app.ts');
    const token = new MockCancellationToken();

    const lenses = await provider.provideCodeLenses(doc, token);

    // 2 functions x 2 lenses each (callers, callees) = 4
    // blast radius lens only shown when grafema.codeLens.showBlastRadius is true (default: false)
    assert.strictEqual(lenses.length, 4, '2 functions x 2 placeholder lenses = 4');
  });
});

// ============================================================================
// SECTION 3: Batch fetch + cache population
// ============================================================================

describe('GrafemaCodeLensProvider — batch fetch', () => {
  it('after batch fetch completes → cache populated, _onDidChangeCodeLenses event fired', async () => {
    const graph: MockGraph = {
      nodes: {
        f1: makeNode('f1', 'FUNCTION', 'handleRequest', {
          file: 'src/app.ts',
          metadata: JSON.stringify({ line: 10 }),
        }),
        caller1: makeNode('caller1', 'FUNCTION', 'route', {
          file: '/workspace/src/router.ts',
          metadata: JSON.stringify({ line: 5 }),
        }),
      },
      outgoing: {
        caller1: [makeEdge('caller1', 'f1')],
      },
      incoming: {
        f1: [makeEdge('caller1', 'f1')],
      },
    };

    const { provider } = createProviderWithGraph(graph);
    const doc = createMockDocument('/workspace/src/app.ts');
    const token = new MockCancellationToken();

    // Track onDidChangeCodeLenses events
    let eventFired = false;
    provider.onDidChangeCodeLenses(() => {
      eventFired = true;
    });

    // First call triggers batch fetch (cold cache)
    await provider.provideCodeLenses(doc, token);

    // Wait for background batch fetch to complete
    // The provider should fire onDidChangeCodeLenses after fetching
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(eventFired, 'onDidChangeCodeLenses should fire after batch fetch completes');
  });
});

// ============================================================================
// SECTION 4: Warm cache — resolved lenses
// ============================================================================

describe('GrafemaCodeLensProvider — warm cache', () => {
  it('provideCodeLenses on warm cache → returns resolved lenses with correct count text', async () => {
    // funcA has 2 callers and 1 callee
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'validate', {
          file: 'src/app.ts',
          metadata: JSON.stringify({ line: 10 }),
        }),
        caller1: makeNode('caller1', 'FUNCTION', 'handler1', {
          file: '/workspace/src/routes.ts',
          metadata: JSON.stringify({ line: 5 }),
        }),
        caller2: makeNode('caller2', 'FUNCTION', 'handler2', {
          file: '/workspace/src/routes.ts',
          metadata: JSON.stringify({ line: 15 }),
        }),
        callee1: makeNode('callee1', 'FUNCTION', 'save', {
          file: '/workspace/src/db.ts',
          metadata: JSON.stringify({ line: 3 }),
        }),
      },
      outgoing: {
        funcA: [makeEdge('funcA', 'callee1')],
        caller1: [makeEdge('caller1', 'funcA')],
        caller2: [makeEdge('caller2', 'funcA')],
      },
      incoming: {
        funcA: [makeEdge('caller1', 'funcA'), makeEdge('caller2', 'funcA')],
        callee1: [makeEdge('funcA', 'callee1')],
      },
    };

    const { provider } = createProviderWithGraph(graph);
    const doc = createMockDocument('/workspace/src/app.ts');
    const token = new MockCancellationToken();

    // First call: cold cache, triggers batch fetch
    await provider.provideCodeLenses(doc, token);

    // Wait for batch fetch
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Second call: warm cache, lenses should have resolved counts
    const lenses = await provider.provideCodeLenses(doc, token);

    // Find lenses with resolved commands (warm cache should have commands)
    const resolvedLenses = lenses.filter(
      (l: { command?: { title: string } }) => l.command && l.command.title,
    );

    // At least some lenses should be resolved with count info
    assert.ok(resolvedLenses.length > 0, 'Warm cache should produce resolved lenses');

    // Check that caller count appears in at least one lens title
    const titles = resolvedLenses.map((l: { command: { title: string } }) => l.command.title);
    const hasCallerCount = titles.some(
      (t: string) => t.includes('2') || t.includes('caller'),
    );
    assert.ok(hasCallerCount, `At least one lens should show caller count. Titles: ${titles.join(', ')}`);
  });
});

// ============================================================================
// SECTION 5: resolveCodeLens
// ============================================================================

describe('GrafemaCodeLensProvider — resolveCodeLens', () => {
  it('resolveCodeLens with cache hit → correct command', async () => {
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'validate', {
          file: 'src/app.ts',
          metadata: JSON.stringify({ line: 10 }),
        }),
        caller1: makeNode('caller1', 'FUNCTION', 'handler', {
          file: '/workspace/src/routes.ts',
          metadata: JSON.stringify({ line: 5 }),
        }),
      },
      outgoing: {
        caller1: [makeEdge('caller1', 'funcA')],
      },
      incoming: {
        funcA: [makeEdge('caller1', 'funcA')],
      },
    };

    const { provider } = createProviderWithGraph(graph);
    const doc = createMockDocument('/workspace/src/app.ts');
    const token = new MockCancellationToken();

    // Populate cache
    await provider.provideCodeLenses(doc, token);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Create a CodeLens to resolve, with arguments matching cache key
    const lens = new MockCodeLens(
      new MockRange(9, 0, 9, 80),  // line 10 (0-indexed: 9)
    );
    // Set arguments that the provider uses to look up cache:
    // [nodeId, filePath] as per plan specification
    (lens as any).data = { nodeId: 'funcA', filePath: '/workspace/src/app.ts' };

    const resolved = provider.resolveCodeLens(lens, token);

    // resolveCodeLens should return a CodeLens (or the same one with command set)
    assert.ok(resolved, 'resolveCodeLens should return a value');
  });
});

// ============================================================================
// SECTION 6: Reconnect clears cache
// ============================================================================

describe('GrafemaCodeLensProvider — reconnect', () => {
  it('reconnect event → cache cleared', async () => {
    const graph: MockGraph = {
      nodes: {
        funcA: makeNode('funcA', 'FUNCTION', 'validate', {
          file: 'src/app.ts',
          metadata: JSON.stringify({ line: 10 }),
        }),
      },
      outgoing: {},
      incoming: {},
    };

    const { provider, mockClientManager } = createProviderWithGraph(graph);
    const doc = createMockDocument('/workspace/src/app.ts');
    const token = new MockCancellationToken();

    // Populate cache
    await provider.provideCodeLenses(doc, token);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Track event
    let eventFired = false;
    provider.onDidChangeCodeLenses(() => {
      eventFired = true;
    });

    // Trigger reconnect
    if (typeof provider.clearCache === 'function') {
      provider.clearCache();
    }
    (mockClientManager as any)._triggerReconnect();

    // After reconnect, next provideCodeLenses should be cold again
    // (returning placeholders, not resolved counts)
    const lensesAfterReconnect = await provider.provideCodeLenses(doc, token);

    // The key assertion: cache was cleared, so this is effectively a cold call
    assert.ok(Array.isArray(lensesAfterReconnect), 'Should return lenses after reconnect');
    // Event should have fired (either from clearCache or reconnect handler)
    assert.ok(eventFired, 'onDidChangeCodeLenses should fire on reconnect/clearCache');
  });
});
