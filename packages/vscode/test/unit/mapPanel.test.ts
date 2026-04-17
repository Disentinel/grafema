/**
 * Unit tests for MapPanel — retarget to rfdb-server /ui/{db} (C0 + C16)
 *
 * Tests that MapPanel:
 * 1. Iframes http://localhost:{port}/ui/{db} using port from grafemaClient
 * 2. Emits CSP meta allowing frame-src http://localhost:*
 * 3. Forwards highlightNode / showTrace messages to webview
 * 4. Contains no references to legacy grafema-gui binary / download / spawn
 *
 * Pure logic test — no RFDB server, no webview host, just HTML snapshot
 * assertions on the emitted getMapHtml() output.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ============================================================================
// Mock vscode module
// ============================================================================

interface PostedMessage {
  command: string;
  [key: string]: unknown;
}

class MockWebview {
  html = '';
  postedMessages: PostedMessage[] = [];
  private _onDidReceiveMessageHandler: ((msg: unknown) => void) | null = null;

  onDidReceiveMessage(handler: (msg: unknown) => void): { dispose: () => void } {
    this._onDidReceiveMessageHandler = handler;
    return { dispose: () => { this._onDidReceiveMessageHandler = null; } };
  }

  async postMessage(message: PostedMessage): Promise<boolean> {
    this.postedMessages.push(message);
    return true;
  }

  fireReceive(msg: unknown): void {
    this._onDidReceiveMessageHandler?.(msg);
  }
}

class MockWebviewPanel {
  webview = new MockWebview();
  viewColumn = 2;
  revealed = false;
  disposed = false;
  private _onDidDisposeHandler: (() => void) | null = null;

  reveal(_viewColumn?: unknown): void {
    this.revealed = true;
  }

  onDidDispose(handler: () => void, _thisArg?: unknown, _disposables?: unknown[]): void {
    this._onDidDisposeHandler = handler;
  }

  dispose(): void {
    this.disposed = true;
    this._onDidDisposeHandler?.();
  }
}

let lastCreatedPanel: MockWebviewPanel | null = null;
let mockRfdbHttpPort: number | undefined = 3335;
let mockDbName = 'default';
let mockWorkspaceRoot = '/tmp/test-workspace';
let mockOpenedDocument: { file: string; line: number } | null = null;

function resetMocks(): void {
  lastCreatedPanel = null;
  mockRfdbHttpPort = 3335;
  mockDbName = 'default';
  mockWorkspaceRoot = '/tmp/test-workspace';
  mockOpenedDocument = null;
}

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};

require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    ViewColumn: { Active: 1, Beside: 2 },
    Range: class {
      constructor(public startLine: number, public startCol: number, public endLine: number, public endCol: number) {}
    },
    Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }) },
    window: {
      createWebviewPanel: (
        _viewType: string,
        _title: string,
        _showOptions: unknown,
        _options: unknown,
      ) => {
        const panel = new MockWebviewPanel();
        lastCreatedPanel = panel;
        return panel;
      },
      showTextDocument: async (uri: { fsPath: string }, options: { selection?: { startLine: number } }) => {
        mockOpenedDocument = {
          file: uri.fsPath,
          line: options.selection?.startLine ?? 0,
        };
        return { document: { uri } };
      },
      showErrorMessage: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
    },
    workspace: {
      get workspaceFolders() {
        return [{ uri: { fsPath: mockWorkspaceRoot } }];
      },
      getConfiguration: () => ({
        get: (_key: string, defaultValue?: unknown) => defaultValue,
      }),
    },
  },
} as unknown as NodeModule;

// ============================================================================
// Mock grafemaClient module so MapPanel can import getRfdbHttpPort() from it
// ============================================================================

// The MapPanel will look up the rfdb http port via a helper. We provide
// a function that can be imported. Using a shared module-level path so
// MapPanel can `require('./grafemaClient')` and get our mock.

// We install the mock via require.cache by registering under the fully
// resolved path of the actual module file. But since MapPanel imports
// by relative path './grafemaClient', we use a different strategy:
// set a global holder that MapPanel code reads.

(globalThis as unknown as { __mockRfdbHttpPort: () => number | undefined }).__mockRfdbHttpPort =
  () => mockRfdbHttpPort;
(globalThis as unknown as { __mockRfdbDbName: () => string }).__mockRfdbDbName =
  () => mockDbName;
// Skip the /api/stats health check — we want MapPanel to render the
// iframe HTML unconditionally so we can assert on it.
(globalThis as unknown as { __mapPanelSkipServerCheck: boolean }).__mapPanelSkipServerCheck =
  true;

// ============================================================================
// Import the module under test (after mocks are installed)
// ============================================================================

// Mock global fetch to simulate rfdb server responding at /api/stats.
// MapPanel polls this to confirm the server is up before loading the iframe.
const globalAny = globalThis as Record<string, unknown>;
const originalFetch = globalAny.fetch as typeof fetch | undefined;
let mockFetchOk = true;
let fetchCallCount = 0;
const mockFetchImpl = async (_url: string | URL) => {
  fetchCallCount++;
  return {
    ok: mockFetchOk,
    json: async () => ({ nodeCount: 100, tileCount: 50 }),
    status: mockFetchOk ? 200 : 500,
    statusText: mockFetchOk ? 'OK' : 'Error',
  };
};
globalAny.fetch = mockFetchImpl as unknown as typeof fetch;

const mapPanelModule = require('../../src/mapPanel');
const { MapPanel } = mapPanelModule;

// ============================================================================
// Assertions on the source itself (forbidden patterns)
// ============================================================================

describe('MapPanel — source-level invariants', () => {
  const sourcePath = join(__dirname, '..', '..', 'src', 'mapPanel.ts');
  const source = readFileSync(sourcePath, 'utf-8');

  it('does not reference grafema-gui binary', () => {
    assert.ok(!source.includes('grafema-gui'), 'mapPanel.ts should not mention grafema-gui');
  });

  it('does not define findGuiBinary', () => {
    assert.ok(!source.includes('findGuiBinary'), 'mapPanel.ts should not have findGuiBinary');
  });

  it('does not define downloadGuiBinary', () => {
    assert.ok(!source.includes('downloadGuiBinary'), 'mapPanel.ts should not have downloadGuiBinary');
  });

  it('does not reference GITHUB_REPO', () => {
    assert.ok(!source.includes('GITHUB_REPO'), 'mapPanel.ts should not have GITHUB_REPO');
  });

  it('does not reference hex-topology.html', () => {
    assert.ok(!source.includes('hex-topology'), 'mapPanel.ts should not iframe hex-topology.html');
  });

  it('does not use spawn() from child_process', () => {
    assert.ok(
      !source.includes("from 'child_process'"),
      'mapPanel.ts should not import child_process',
    );
    assert.ok(!source.match(/\bspawn\(/), 'mapPanel.ts should not call spawn()');
  });
});

// ============================================================================
// Behavioral tests — MapPanel.createOrShow() and message handling
// ============================================================================

describe('MapPanel — behavior', () => {
  beforeEach(() => {
    resetMocks();
    mockFetchOk = true;
    // Clear singleton between tests
    MapPanel.currentPanel = undefined;
  });

  describe('createOrShow()', () => {
    it('creates a webview panel with HTML that embeds rfdb /ui/{db}', async () => {
      MapPanel.createOrShow();
      assert.ok(lastCreatedPanel, 'Should create a webview panel');

      // Wait for async ensureServerAndLoad() to settle
      await new Promise((r) => setTimeout(r, 200));

      const html = lastCreatedPanel!.webview.html;
      assert.match(
        html,
        /src=".*http:\/\/localhost:3335\/ui\/default"/,
        `HTML should iframe http://localhost:3335/ui/default (fetch calls: ${fetchCallCount}), got: ${html.slice(0, 500)}`,
      );
    });

    it('HTML contains CSP meta allowing frame-src http://localhost:*', async () => {
      MapPanel.createOrShow();
      await new Promise((r) => setTimeout(r, 200));

      const html = lastCreatedPanel!.webview.html;
      assert.match(html, /http-equiv="Content-Security-Policy"/, 'HTML should have CSP meta');
      assert.match(
        html,
        /frame-src[^;"]*http:\/\/localhost:\*/,
        `CSP should allow frame-src http://localhost:*, got: ${html}`,
      );
    });

    it('CSP also allows http://127.0.0.1:*', async () => {
      MapPanel.createOrShow();
      await new Promise((r) => setTimeout(r, 200));

      const html = lastCreatedPanel!.webview.html;
      assert.match(
        html,
        /frame-src[^;"]*http:\/\/127\.0\.0\.1:\*/,
        `CSP should allow frame-src http://127.0.0.1:*, got: ${html}`,
      );
    });

    it('uses the port returned by grafemaClient.getRfdbHttpPort()', async () => {
      mockRfdbHttpPort = 4444;
      MapPanel.createOrShow();
      await new Promise((r) => setTimeout(r, 200));

      const html = lastCreatedPanel!.webview.html;
      assert.match(
        html,
        /http:\/\/localhost:4444\/ui\//,
        `HTML should use port 4444, got: ${html}`,
      );
    });

    it('reveals existing panel instead of creating a new one when called twice', () => {
      MapPanel.createOrShow();
      const firstPanel = lastCreatedPanel;
      assert.ok(firstPanel, 'First call creates a panel');

      MapPanel.createOrShow();
      assert.strictEqual(lastCreatedPanel, firstPanel, 'Second call reuses the same panel');
      assert.ok(firstPanel!.revealed, 'Existing panel should be revealed');
    });
  });

  describe('highlightNode() and showTrace()', () => {
    it('highlightNode posts a message to the webview', async () => {
      MapPanel.createOrShow();
      await new Promise((r) => setTimeout(r, 200));
      const panel = MapPanel.currentPanel;

      panel.highlightNode('myFunc', 'FUNCTION', 'src/app.ts');

      const messages = lastCreatedPanel!.webview.postedMessages;
      const highlightMsg = messages.find((m) => m.command === 'highlightNode');
      assert.ok(highlightMsg, 'Should have posted a highlightNode message');
      assert.strictEqual(highlightMsg!.nodeName, 'myFunc');
      assert.strictEqual(highlightMsg!.nodeType, 'FUNCTION');
      assert.strictEqual(highlightMsg!.file, 'src/app.ts');
    });

    it('showTrace posts a message to the webview', async () => {
      MapPanel.createOrShow();
      await new Promise((r) => setTimeout(r, 200));
      const panel = MapPanel.currentPanel;

      panel.showTrace(['A', 'B', 'C']);

      const messages = lastCreatedPanel!.webview.postedMessages;
      const traceMsg = messages.find((m) => m.command === 'showTrace');
      assert.ok(traceMsg, 'Should have posted a showTrace message');
      assert.deepStrictEqual(traceMsg!.nodeNames, ['A', 'B', 'C']);
    });
  });

  describe('onDidReceiveMessage — nodeSelected', () => {
    it('opens file in editor when iframe posts nodeSelected', async () => {
      MapPanel.createOrShow();
      await new Promise((r) => setTimeout(r, 200));

      lastCreatedPanel!.webview.fireReceive({
        command: 'nodeSelected',
        file: 'src/app.ts',
        line: 42,
      });

      // showTextDocument is async; give it a tick
      await new Promise((r) => setTimeout(r, 10));

      assert.ok(mockOpenedDocument, 'Should have opened a document');
      assert.ok(
        mockOpenedDocument!.file.endsWith('src/app.ts'),
        `Should have opened src/app.ts, got ${mockOpenedDocument!.file}`,
      );
    });
  });
});

// ============================================================================
// Cleanup
// ============================================================================

if (originalFetch) {
  globalAny.fetch = originalFetch;
}
