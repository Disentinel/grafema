/**
 * Unit tests for GrafemaClientManager — REG-528
 *
 * Tests the negotiateAndSelectDatabase() logic which runs after connecting
 * to rfdb-server. Since the method is private, we test through the public
 * connect() flow using WebSocket transport (avoids filesystem/server-start
 * complexity of Unix socket mode).
 *
 * Scenarios:
 *   1. Happy path: hello + openDatabase succeed
 *   2. Database not found, others available: helpful error with names
 *   3. No databases at all: error suggests `grafema analyze`
 *   4. Network error during openDatabase: re-thrown as-is
 *   5. hello() failure: error with protocol negotiation context
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ============================================================================
// Mock infrastructure
// ============================================================================

/**
 * Configuration store for the mock vscode.workspace.getConfiguration().
 * Keys are section.key (e.g. "grafema.rfdbTransport").
 */
let mockConfigValues: Record<string, unknown> = {};

function setMockConfig(values: Record<string, unknown>): void {
  mockConfigValues = values;
}

// ============================================================================
// Mock vscode module
// ============================================================================

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};

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

require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    TreeItem: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: MockEventEmitter,
    ThemeIcon: class { id: string; constructor(id: string) { this.id = id; } },
    ThemeColor: class { id: string; constructor(id: string) { this.id = id; } },
    workspace: {
      workspaceFolders: [],
      getConfiguration: (section?: string) => ({
        get: (key: string, defaultValue?: unknown) => {
          const fullKey = section ? `${section}.${key}` : key;
          return fullKey in mockConfigValues
            ? mockConfigValues[fullKey]
            : defaultValue;
        },
        // inspect() surfaces whether a user explicitly set a value at any
        // scope. Tests drive this via mockConfigValues — any key present
        // is treated as "explicitly set" at workspace scope.
        inspect: (key: string) => {
          const fullKey = section ? `${section}.${key}` : key;
          if (fullKey in mockConfigValues) {
            return {
              key,
              defaultValue: undefined,
              globalValue: undefined,
              workspaceValue: mockConfigValues[fullKey],
              workspaceFolderValue: undefined,
            };
          }
          return { key, defaultValue: undefined };
        },
      }),
    },
    languages: { registerCodeLensProvider: () => ({ dispose: () => {} }) },
    Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
  },
} as any;

// ============================================================================
// Mock @grafema/rfdb-client
//
// We intercept require('@grafema/rfdb-client') so that new RFDBClient(...)
// and new RFDBWebSocketClient(...) return our controllable mock instances.
// ============================================================================

interface MockClientMethods {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  ping: () => Promise<string | false>;
  hello: () => Promise<{ ok: boolean; protocolVersion: number; serverVersion: string; features: string[] }>;
  openDatabase: (name: string, mode?: string) => Promise<{ ok: boolean; databaseId: string; mode: string; nodeCount: number; edgeCount: number }>;
  listDatabases: () => Promise<{ databases: Array<{ name: string; ephemeral: boolean; nodeCount: number; edgeCount: number; connectionCount: number }> }>;
}

/**
 * The mock client instance that will be returned by RFDBWebSocketClient
 * constructor. Set this before calling connect() to control behavior.
 */
let mockWsClient: MockClientMethods | null = null;

/**
 * Create a mock client with configurable method implementations.
 */
function createMockClient(overrides?: Partial<MockClientMethods>): MockClientMethods {
  return {
    connect: async () => {},
    close: async () => {},
    ping: async () => 'rfdb-server 0.1.0',
    hello: async () => ({ ok: true, protocolVersion: 3, serverVersion: '0.1.0', features: [] }),
    openDatabase: async () => ({ ok: true, databaseId: 'default', mode: 'rw', nodeCount: 100, edgeCount: 200 }),
    listDatabases: async () => ({ databases: [] }),
    ...overrides,
  };
}

// Intercept @grafema/rfdb-client module resolution
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  if (request === '@grafema/rfdb-client') return '@grafema/rfdb-client';
  return originalResolve.call(this, request, ...args);
};

require.cache['@grafema/rfdb-client'] = {
  id: '@grafema/rfdb-client',
  filename: '@grafema/rfdb-client',
  loaded: true,
  exports: {
    RFDBClient: class MockRFDBClient {
      constructor() {
        // Return mock client methods
        return mockWsClient || createMockClient();
      }
    },
    RFDBWebSocketClient: class MockRFDBWebSocketClient {
      constructor() {
        // Return mock client methods
        return mockWsClient || createMockClient();
      }
    },
  },
} as any;

// ============================================================================
// Import the module under test
// ============================================================================

const grafemaClientModule = require('../../src/grafemaClient');
const { GrafemaClientManager } = grafemaClientModule;

// ============================================================================
// Helper: configure for WebSocket transport
//
// Using WebSocket mode avoids filesystem checks (existsSync for DB file)
// and server auto-start logic, giving us a clean path to test
// negotiateAndSelectDatabase() in isolation.
// ============================================================================

function configureWebSocketTransport(): void {
  setMockConfig({
    'grafema.rfdbTransport': 'websocket',
    'grafema.rfdbWebSocketUrl': 'ws://localhost:7474',
  });
}

// ============================================================================
// SECTION 1: Happy path — hello + openDatabase succeed
// ============================================================================

describe('GrafemaClientManager — negotiateAndSelectDatabase', () => {
  beforeEach(() => {
    mockWsClient = null;
    setMockConfig({});
  });

  describe('happy path', () => {
    it('hello() succeeds, openDatabase("default") succeeds -> state is connected', async () => {
      configureWebSocketTransport();

      let helloCalled = false;
      let openDatabaseCalledWith: { name: string; mode: string } | null = null;

      mockWsClient = createMockClient({
        hello: async () => {
          helloCalled = true;
          return { ok: true, protocolVersion: 3, serverVersion: '0.1.0', features: [] };
        },
        openDatabase: async (name: string, mode?: string) => {
          openDatabaseCalledWith = { name, mode: mode || 'rw' };
          return { ok: true, databaseId: 'default', mode: 'rw', nodeCount: 42, edgeCount: 84 };
        },
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.ok(helloCalled, 'hello() should have been called');
      assert.deepStrictEqual(
        openDatabaseCalledWith,
        { name: 'default', mode: 'rw' },
        'openDatabase should be called with "default" and "rw"',
      );
      assert.strictEqual(manager.state.status, 'connected', 'State should be connected');
      assert.ok(manager.isConnected(), 'isConnected() should return true');
    });
  });

  // ==========================================================================
  // SECTION 2: Database not found, others available
  // ==========================================================================

  describe('database not found with alternatives available', () => {
    it('openDatabase throws "not found", listDatabases returns databases -> error includes available names', async () => {
      configureWebSocketTransport();

      mockWsClient = createMockClient({
        openDatabase: async () => {
          throw new Error("Database 'default' not found");
        },
        listDatabases: async () => ({
          databases: [
            { name: 'test', ephemeral: false, nodeCount: 10, edgeCount: 20, connectionCount: 0 },
            { name: 'staging', ephemeral: false, nodeCount: 30, edgeCount: 60, connectionCount: 0 },
          ],
        }),
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      // connect() catches the error and sets state to 'error'
      assert.strictEqual(manager.state.status, 'error', 'State should be error');
      assert.ok(
        manager.state.message.includes('Available: test, staging'),
        `Error message should list available databases, got: "${manager.state.message}"`,
      );
      assert.ok(
        manager.state.message.includes('grafema analyze'),
        `Error message should mention grafema analyze, got: "${manager.state.message}"`,
      );
    });

    it('openDatabase throws "not found", listDatabases returns single database -> error includes that name', async () => {
      configureWebSocketTransport();

      mockWsClient = createMockClient({
        openDatabase: async () => {
          throw new Error("Database 'default' not found");
        },
        listDatabases: async () => ({
          databases: [
            { name: 'myproject', ephemeral: false, nodeCount: 50, edgeCount: 100, connectionCount: 1 },
          ],
        }),
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.strictEqual(manager.state.status, 'error', 'State should be error');
      assert.ok(
        manager.state.message.includes('Available: myproject'),
        `Error message should list the available database, got: "${manager.state.message}"`,
      );
    });
  });

  // ==========================================================================
  // SECTION 3: No databases at all
  // ==========================================================================

  describe('no databases available', () => {
    it('openDatabase throws "not found", listDatabases returns empty -> error suggests grafema analyze', async () => {
      configureWebSocketTransport();

      mockWsClient = createMockClient({
        openDatabase: async () => {
          throw new Error("Database 'default' not found");
        },
        listDatabases: async () => ({
          databases: [],
        }),
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.strictEqual(manager.state.status, 'error', 'State should be error');
      assert.ok(
        manager.state.message.includes('No graph databases found'),
        `Error message should indicate no databases found, got: "${manager.state.message}"`,
      );
      assert.ok(
        manager.state.message.includes('grafema analyze'),
        `Error message should suggest running grafema analyze, got: "${manager.state.message}"`,
      );
    });
  });

  // ==========================================================================
  // SECTION 4: Network error during openDatabase (not "not found")
  // ==========================================================================

  describe('network error during openDatabase', () => {
    it('openDatabase throws non-"not found" error -> error re-thrown as-is, listDatabases NOT called', async () => {
      configureWebSocketTransport();

      let listDatabasesCalled = false;

      mockWsClient = createMockClient({
        openDatabase: async () => {
          throw new Error('Connection reset by peer');
        },
        listDatabases: async () => {
          listDatabasesCalled = true;
          return { databases: [] };
        },
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.strictEqual(manager.state.status, 'error', 'State should be error');
      assert.ok(
        manager.state.message.includes('Connection reset'),
        `Error message should contain original error, got: "${manager.state.message}"`,
      );
      assert.ok(
        !listDatabasesCalled,
        'listDatabases should NOT be called for non-"not found" errors',
      );
    });

    it('openDatabase throws generic "timeout" error -> listDatabases NOT called', async () => {
      configureWebSocketTransport();

      let listDatabasesCalled = false;

      mockWsClient = createMockClient({
        openDatabase: async () => {
          throw new Error('Request timeout after 60000ms');
        },
        listDatabases: async () => {
          listDatabasesCalled = true;
          return { databases: [] };
        },
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.strictEqual(manager.state.status, 'error', 'State should be error');
      assert.ok(
        !listDatabasesCalled,
        'listDatabases should NOT be called for timeout errors',
      );
    });
  });

  // ==========================================================================
  // SECTION 5: hello() failure
  // ==========================================================================

  describe('hello() failure', () => {
    it('hello() throws -> state is error with protocol negotiation context', async () => {
      configureWebSocketTransport();

      let openDatabaseCalled = false;

      mockWsClient = createMockClient({
        hello: async () => {
          throw new Error('Protocol version mismatch');
        },
        openDatabase: async () => {
          openDatabaseCalled = true;
          return { ok: true, databaseId: 'default', mode: 'rw', nodeCount: 0, edgeCount: 0 };
        },
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.strictEqual(manager.state.status, 'error', 'State should be error');
      assert.ok(
        manager.state.message.includes('Protocol version mismatch'),
        `Error message should include hello error, got: "${manager.state.message}"`,
      );
      assert.ok(
        !openDatabaseCalled,
        'openDatabase should NOT be called when hello() fails',
      );
    });

    it('hello() throws network error -> state is error', async () => {
      configureWebSocketTransport();

      mockWsClient = createMockClient({
        hello: async () => {
          throw new Error('ECONNREFUSED');
        },
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.strictEqual(manager.state.status, 'error', 'State should be error');
      assert.ok(
        manager.state.message.includes('ECONNREFUSED'),
        `Error message should include connection error, got: "${manager.state.message}"`,
      );
    });
  });

  // ==========================================================================
  // SECTION 6: Call ordering verification
  // ==========================================================================

  describe('call ordering', () => {
    it('hello() is called before openDatabase()', async () => {
      configureWebSocketTransport();

      const callOrder: string[] = [];

      mockWsClient = createMockClient({
        hello: async () => {
          callOrder.push('hello');
          return { ok: true, protocolVersion: 3, serverVersion: '0.1.0', features: [] };
        },
        openDatabase: async () => {
          callOrder.push('openDatabase');
          return { ok: true, databaseId: 'default', mode: 'rw', nodeCount: 0, edgeCount: 0 };
        },
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.deepStrictEqual(
        callOrder,
        ['hello', 'openDatabase'],
        'hello() must be called before openDatabase()',
      );
    });

    it('listDatabases is called only after openDatabase fails with "not found"', async () => {
      configureWebSocketTransport();

      const callOrder: string[] = [];

      mockWsClient = createMockClient({
        hello: async () => {
          callOrder.push('hello');
          return { ok: true, protocolVersion: 3, serverVersion: '0.1.0', features: [] };
        },
        openDatabase: async () => {
          callOrder.push('openDatabase');
          throw new Error("Database 'default' not found");
        },
        listDatabases: async () => {
          callOrder.push('listDatabases');
          return { databases: [{ name: 'test', ephemeral: false, nodeCount: 5, edgeCount: 10, connectionCount: 0 }] };
        },
      });

      const manager = new GrafemaClientManager('/tmp/test-workspace');
      await manager.connect();

      assert.deepStrictEqual(
        callOrder,
        ['hello', 'openDatabase', 'listDatabases'],
        'Call order should be hello -> openDatabase -> listDatabases (on not-found)',
      );
    });
  });
});

// ============================================================================
// DAI-15: getRfdbHttpPort lockfile + resolution order
// ============================================================================

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

const {
  readRfdbHttpPortLockfile,
  _resetActiveRfdbHttpPortForTests,
  getRfdbHttpPort,
} = grafemaClientModule as {
  readRfdbHttpPortLockfile: (root: string) => number | undefined;
  _resetActiveRfdbHttpPortForTests: () => void;
  getRfdbHttpPort: (workspaceRoot?: string) => number | undefined;
};

describe('readRfdbHttpPortLockfile — DAI-15', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = pathJoin(tmpdir(), `grafema-lock-${Date.now()}-${Math.random()}`);
    mkdirSync(pathJoin(workspace, '.grafema'), { recursive: true });
  });

  it('returns undefined when lockfile is missing', () => {
    assert.strictEqual(readRfdbHttpPortLockfile(workspace), undefined);
  });

  it('reads the port integer from the lockfile', () => {
    writeFileSync(pathJoin(workspace, '.grafema', 'rfdb-http.port'), '45123\n');
    assert.strictEqual(readRfdbHttpPortLockfile(workspace), 45123);
  });

  it('returns undefined on unparseable content', () => {
    writeFileSync(pathJoin(workspace, '.grafema', 'rfdb-http.port'), 'not-a-port');
    assert.strictEqual(readRfdbHttpPortLockfile(workspace), undefined);
  });

  it('returns undefined for out-of-range values', () => {
    writeFileSync(pathJoin(workspace, '.grafema', 'rfdb-http.port'), '99999');
    assert.strictEqual(readRfdbHttpPortLockfile(workspace), undefined);
  });
});

describe('getRfdbHttpPort — resolution order (DAI-15)', () => {
  let workspace: string;
  const originalFolders = (
    require.cache['vscode'] as unknown as { exports: { workspace: { workspaceFolders: unknown } } }
  ).exports.workspace.workspaceFolders;

  beforeEach(() => {
    _resetActiveRfdbHttpPortForTests();
    setMockConfig({});
    workspace = pathJoin(tmpdir(), `grafema-port-${Date.now()}-${Math.random()}`);
    mkdirSync(pathJoin(workspace, '.grafema'), { recursive: true });
    delete process.env.GRAFEMA_RFDB_HTTP_PORT;
  });

  it('falls back to lockfile when no explicit config and no active port', () => {
    writeFileSync(pathJoin(workspace, '.grafema', 'rfdb-http.port'), '42042');
    assert.strictEqual(getRfdbHttpPort(workspace), 42042);
  });

  it('prefers explicitly-pinned config over lockfile', () => {
    // User pinned a specific port — must win even if a lockfile advertises
    // a different port (e.g., a background server bound elsewhere).
    setMockConfig({ 'grafema.rfdbHttpPort': 7777 });
    writeFileSync(pathJoin(workspace, '.grafema', 'rfdb-http.port'), '51234');
    assert.strictEqual(getRfdbHttpPort(workspace), 7777);
  });

  it('falls through to lockfile when config is not explicitly set', () => {
    setMockConfig({}); // nothing pinned
    writeFileSync(pathJoin(workspace, '.grafema', 'rfdb-http.port'), '51234');
    assert.strictEqual(getRfdbHttpPort(workspace), 51234);
  });

  it('falls back to DEFAULT when nothing else is available', () => {
    rmSync(pathJoin(workspace, '.grafema', 'rfdb-http.port'), { force: true });
    assert.strictEqual(getRfdbHttpPort(workspace), 3335);
  });

  it('honors GRAFEMA_RFDB_HTTP_PORT env var over default', () => {
    process.env.GRAFEMA_RFDB_HTTP_PORT = '9090';
    assert.strictEqual(getRfdbHttpPort(workspace), 9090);
    delete process.env.GRAFEMA_RFDB_HTTP_PORT;
  });

  // keep vscode workspace untouched
  void originalFolders;
});
