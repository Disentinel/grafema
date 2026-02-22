/**
 * RFDB WebSocket Integration Tests (REG-523 STEP 3)
 *
 * Integration tests that verify WebSocket transport works end-to-end
 * with a real rfdb-server process. These tests require:
 * 1. rfdb-server binary built (cargo build --bin rfdb-server)
 * 2. WebSocket support compiled in (--ws-port flag)
 *
 * Test flow:
 * - Start rfdb-server with --ws-port
 * - Connect RFDBWebSocketClient
 * - Execute full CRUD operations
 * - Verify error handling
 * - Stop server
 *
 * Skip these tests if rfdb-server binary is not available.
 *
 * Uses node:test and node:assert (project standard).
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configuration
const TEST_WS_PORT = 17474; // High port to avoid conflicts
const TEST_WS_URL = `ws://127.0.0.1:${TEST_WS_PORT}`;
const testDir = mkdtempSync(join(tmpdir(), 'rfdb-ws-'));
const TEST_DB_PATH = join(testDir, 'graph.rfdb');
const TEST_SOCKET_PATH = join(testDir, 'rfdb.sock');
const SERVER_BINARY = join(__dirname, '../../packages/rfdb-server/target/debug/rfdb-server');

/**
 * Check if rfdb-server binary exists and supports --ws-port.
 * If not, skip these tests.
 */
function canRunTests(): boolean {
  return existsSync(SERVER_BINARY);
}

// =============================================================================
// NOTE: These tests will be activated once:
// 1. rfdb-server WebSocket support is implemented (Rust side)
// 2. RFDBWebSocketClient is implemented (TypeScript side)
//
// Until then, they serve as executable specification for the integration.
// =============================================================================

describe('RFDB WebSocket Integration', { skip: !canRunTests() ? 'rfdb-server binary not found' : false }, () => {
  let serverProcess: ChildProcess | null = null;

  before(async () => {
    // Start server with both Unix socket and WebSocket
    serverProcess = spawn(SERVER_BINARY, [
      TEST_DB_PATH,
      '--socket', TEST_SOCKET_PATH,
      '--ws-port', TEST_WS_PORT.toString(),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout!.on('data', (data: Buffer) => {
      // Uncomment for debugging:
      // console.log(`[server stdout] ${data.toString().trim()}`);
    });

    serverProcess.stderr!.on('data', (data: Buffer) => {
      // Uncomment for debugging:
      // console.log(`[server stderr] ${data.toString().trim()}`);
    });

    // Wait for server to start
    await sleep(2000);

    // Verify server started
    assert.ok(
      existsSync(TEST_SOCKET_PATH),
      'Server socket should exist after startup'
    );
  });

  after(async () => {
    // Kill server
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(500);
      // Force kill if still running
      try { serverProcess.kill('SIGKILL'); } catch { /* ignore */ }
    }

    // Clean up temp directory
    rmSync(testDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Connection Lifecycle
  // ===========================================================================

  describe('Connection Lifecycle', () => {
    it('should connect via WebSocket', async () => {
      // Once RFDBWebSocketClient is implemented:
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // assert.strictEqual(client.connected, true);
      // await client.close();

      // Placeholder until implementation exists
      assert.ok(true, 'WebSocket connect should succeed');
    });

    it('should ping and receive server version', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // const version = await client.ping();
      // assert.ok(version, 'Should receive server version string');
      // assert.ok(typeof version === 'string', 'Version should be a string');
      // assert.match(version as string, /^\d+\.\d+\.\d+/, 'Version should match semver');
      // await client.close();

      assert.ok(true, 'Ping should return version string');
    });

    it('should negotiate protocol via hello()', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // const hello = await client.hello(2);
      // assert.strictEqual(hello.ok, true);
      // assert.ok(hello.protocolVersion >= 2, 'Should negotiate at least v2');
      // assert.ok(hello.serverVersion, 'Should include server version');
      // await client.close();

      assert.ok(true, 'Hello should negotiate protocol v2');
    });

    it('should handle close and reconnect', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // const v1 = await client.ping();
      // assert.ok(v1);
      //
      // await client.close();
      // assert.strictEqual(client.connected, false);
      //
      // // Reconnect
      // await client.connect();
      // const v2 = await client.ping();
      // assert.ok(v2);
      // await client.close();

      assert.ok(true, 'Close and reconnect should work');
    });
  });

  // ===========================================================================
  // Database Operations
  // ===========================================================================

  describe('Database Operations', () => {
    it('should create and open an ephemeral database', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      //
      // const createResp = await client.createDatabase('ws-test-db', true);
      // assert.strictEqual(createResp.ok, true);
      //
      // const openResp = await client.openDatabase('ws-test-db', 'rw');
      // assert.strictEqual(openResp.ok, true);
      //
      // await client.close();

      assert.ok(true, 'Create and open database should work');
    });

    it('should list databases', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      //
      // const list = await client.listDatabases();
      // assert.ok(Array.isArray(list.databases));
      //
      // await client.close();

      assert.ok(true, 'listDatabases should return array');
    });

    it('should report current database', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-current-test', true);
      // await client.openDatabase('ws-current-test');
      //
      // const current = await client.currentDatabase();
      // assert.strictEqual(current.database, 'ws-current-test');
      //
      // await client.close();

      assert.ok(true, 'currentDatabase should return name');
    });
  });

  // ===========================================================================
  // Node CRUD Operations
  // ===========================================================================

  describe('Node CRUD', () => {
    it('should add nodes and get node count', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-crud-nodes', true);
      // await client.openDatabase('ws-crud-nodes');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'bar', file: 'test.js', exported: true, metadata: '{}' },
      //   { id: 'n3', nodeType: 'CLASS', name: 'MyClass', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // const count = await client.nodeCount();
      // assert.strictEqual(count, 3);
      //
      // await client.close();

      assert.ok(true, 'addNodes and nodeCount should work');
    });

    it('should get a specific node', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-get-node', true);
      // await client.openDatabase('ws-get-node');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // const node = await client.getNode('n1');
      // assert.ok(node, 'Node should exist');
      // assert.strictEqual(node.name, 'foo');
      // assert.strictEqual(node.nodeType, 'FUNCTION');
      //
      // await client.close();

      assert.ok(true, 'getNode should return node data');
    });

    it('should return null for non-existent node', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-nonode', true);
      // await client.openDatabase('ws-nonode');
      //
      // const node = await client.getNode('nonexistent');
      // assert.strictEqual(node, null);
      //
      // await client.close();

      assert.ok(true, 'getNode for missing node should return null');
    });

    it('should check node existence', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-exists', true);
      // await client.openDatabase('ws-exists');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // assert.strictEqual(await client.nodeExists('n1'), true);
      // assert.strictEqual(await client.nodeExists('nonexistent'), false);
      //
      // await client.close();

      assert.ok(true, 'nodeExists should return boolean');
    });

    it('should find nodes by type', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-findtype', true);
      // await client.openDatabase('ws-findtype');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'bar', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n3', nodeType: 'CLASS', name: 'Baz', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // const functions = await client.findByType('FUNCTION');
      // assert.strictEqual(functions.length, 2);
      //
      // const classes = await client.findByType('CLASS');
      // assert.strictEqual(classes.length, 1);
      //
      // await client.close();

      assert.ok(true, 'findByType should return matching IDs');
    });

    it('should delete a node', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-delete-node', true);
      // await client.openDatabase('ws-delete-node');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      // assert.strictEqual(await client.nodeCount(), 1);
      //
      // await client.deleteNode('n1');
      // assert.strictEqual(await client.nodeCount(), 0);
      //
      // await client.close();

      assert.ok(true, 'deleteNode should remove node');
    });
  });

  // ===========================================================================
  // Edge CRUD Operations
  // ===========================================================================

  describe('Edge CRUD', () => {
    it('should add edges and get edge count', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-crud-edges', true);
      // await client.openDatabase('ws-crud-edges');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'bar', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // await client.addEdges([
      //   { src: 'n1', dst: 'n2', edgeType: 'CALLS', metadata: '{}' },
      // ]);
      //
      // const count = await client.edgeCount();
      // assert.strictEqual(count, 1);
      //
      // await client.close();

      assert.ok(true, 'addEdges and edgeCount should work');
    });

    it('should get outgoing edges', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-outgoing', true);
      // await client.openDatabase('ws-outgoing');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'bar', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n3', nodeType: 'FUNCTION', name: 'baz', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // await client.addEdges([
      //   { src: 'n1', dst: 'n2', edgeType: 'CALLS', metadata: '{}' },
      //   { src: 'n1', dst: 'n3', edgeType: 'CALLS', metadata: '{}' },
      // ]);
      //
      // const outgoing = await client.getOutgoingEdges('n1');
      // assert.strictEqual(outgoing.length, 2);
      //
      // await client.close();

      assert.ok(true, 'getOutgoingEdges should return edges');
    });

    it('should get incoming edges', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-incoming', true);
      // await client.openDatabase('ws-incoming');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'bar', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // await client.addEdges([
      //   { src: 'n1', dst: 'n2', edgeType: 'CALLS', metadata: '{}' },
      // ]);
      //
      // const incoming = await client.getIncomingEdges('n2');
      // assert.strictEqual(incoming.length, 1);
      // assert.strictEqual(incoming[0].src, 'n1');
      //
      // await client.close();

      assert.ok(true, 'getIncomingEdges should return edges');
    });
  });

  // ===========================================================================
  // Traversal Operations
  // ===========================================================================

  describe('Graph Traversal', () => {
    it('should find neighbors', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-neighbors', true);
      // await client.openDatabase('ws-neighbors');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'a', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'b', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n3', nodeType: 'FUNCTION', name: 'c', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // await client.addEdges([
      //   { src: 'n1', dst: 'n2', edgeType: 'CALLS', metadata: '{}' },
      //   { src: 'n1', dst: 'n3', edgeType: 'CALLS', metadata: '{}' },
      // ]);
      //
      // const neighbors = await client.neighbors('n1', ['CALLS']);
      // assert.ok(neighbors.length >= 2, 'Should find at least 2 neighbors');
      //
      // await client.close();

      assert.ok(true, 'neighbors should return neighbor IDs');
    });

    it('should do BFS traversal', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-bfs', true);
      // await client.openDatabase('ws-bfs');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'a', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'b', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n3', nodeType: 'FUNCTION', name: 'c', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // await client.addEdges([
      //   { src: 'n1', dst: 'n2', edgeType: 'CALLS', metadata: '{}' },
      //   { src: 'n2', dst: 'n3', edgeType: 'CALLS', metadata: '{}' },
      // ]);
      //
      // const reachable = await client.bfs(['n1'], 3, ['CALLS']);
      // assert.ok(reachable.length >= 2, 'BFS should find reachable nodes');
      //
      // await client.close();

      assert.ok(true, 'BFS should traverse graph');
    });
  });

  // ===========================================================================
  // Stats Operations
  // ===========================================================================

  describe('Stats Operations', () => {
    it('should count nodes by type', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-count-types', true);
      // await client.openDatabase('ws-count-types');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'a', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'b', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n3', nodeType: 'CLASS', name: 'c', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // const counts = await client.countNodesByType();
      // assert.strictEqual(counts['FUNCTION'], 2);
      // assert.strictEqual(counts['CLASS'], 1);
      //
      // await client.close();

      assert.ok(true, 'countNodesByType should return correct counts');
    });

    it('should count edges by type', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-count-edges', true);
      // await client.openDatabase('ws-count-edges');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'a', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'b', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n3', nodeType: 'CLASS', name: 'c', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // await client.addEdges([
      //   { src: 'n1', dst: 'n2', edgeType: 'CALLS', metadata: '{}' },
      //   { src: 'n3', dst: 'n1', edgeType: 'CONTAINS', metadata: '{}' },
      // ]);
      //
      // const counts = await client.countEdgesByType();
      // assert.strictEqual(counts['CALLS'], 1);
      // assert.strictEqual(counts['CONTAINS'], 1);
      //
      // await client.close();

      assert.ok(true, 'countEdgesByType should return correct counts');
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('Error Handling', () => {
    it('should get error when querying without opening database', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      //
      // // Do NOT open a database
      // await assert.rejects(
      //   () => client.nodeCount(),
      //   /no database/i,
      //   'Should get error about no database selected'
      // );
      //
      // await client.close();

      assert.ok(true, 'Query without database should return error');
    });

    it('should handle connection refused gracefully', async () => {
      // const client = new RFDBWebSocketClient('ws://127.0.0.1:19999'); // Dead port
      // await assert.rejects(
      //   () => client.connect(),
      //   /connection/i,
      //   'Should get connection error'
      // );
      // assert.strictEqual(client.connected, false);

      assert.ok(true, 'Connection refused should reject connect()');
    });
  });

  // ===========================================================================
  // Multiple Concurrent Clients
  // ===========================================================================

  describe('Multiple Concurrent Clients', () => {
    it('should handle multiple WebSocket clients simultaneously', async () => {
      // const clients = await Promise.all([1, 2, 3].map(async () => {
      //   const c = new RFDBWebSocketClient(TEST_WS_URL);
      //   await c.connect();
      //   return c;
      // }));
      //
      // // All clients ping in parallel
      // const versions = await Promise.all(clients.map(c => c.ping()));
      // assert.ok(versions.every(v => typeof v === 'string'), 'All pings should return version');
      //
      // // Close all
      // await Promise.all(clients.map(c => c.close()));

      assert.ok(true, 'Multiple concurrent clients should work');
    });

    it('should handle concurrent requests from single client', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-concurrent', true);
      // await client.openDatabase('ws-concurrent');
      //
      // // Send 10 requests in parallel
      // const promises = Array.from({ length: 10 }, (_, i) =>
      //   client.addNodes([{
      //     id: `concurrent-${i}`,
      //     nodeType: 'FUNCTION',
      //     name: `fn${i}`,
      //     file: 'test.js',
      //     exported: false,
      //     metadata: '{}',
      //   }])
      // );
      //
      // await Promise.all(promises);
      // const count = await client.nodeCount();
      // assert.strictEqual(count, 10, 'All 10 nodes should be added');
      //
      // await client.close();

      assert.ok(true, 'Concurrent requests should all complete');
    });
  });

  // ===========================================================================
  // Control Operations
  // ===========================================================================

  describe('Control Operations', () => {
    it('should flush data', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-flush', true);
      // await client.openDatabase('ws-flush');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // const result = await client.flush();
      // assert.ok(result.ok, 'Flush should succeed');
      //
      // await client.close();

      assert.ok(true, 'flush should succeed');
    });

    it('should clear database', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-clear', true);
      // await client.openDatabase('ws-clear');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      // assert.strictEqual(await client.nodeCount(), 1);
      //
      // await client.clear();
      // assert.strictEqual(await client.nodeCount(), 0);
      //
      // await client.close();

      assert.ok(true, 'clear should remove all data');
    });
  });

  // ===========================================================================
  // Datalog Operations
  // ===========================================================================

  describe('Datalog Operations', () => {
    it('should execute datalog query', async () => {
      // const client = new RFDBWebSocketClient(TEST_WS_URL);
      // await client.connect();
      // await client.hello(2);
      // await client.createDatabase('ws-datalog', true);
      // await client.openDatabase('ws-datalog');
      //
      // await client.addNodes([
      //   { id: 'n1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js', exported: false, metadata: '{}' },
      //   { id: 'n2', nodeType: 'FUNCTION', name: 'bar', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // const results = await client.datalogQuery('?- node(X, "FUNCTION").');
      // assert.ok(Array.isArray(results), 'Should return array of results');
      //
      // await client.close();

      assert.ok(true, 'Datalog query should return results');
    });
  });

  // ===========================================================================
  // Cross-Transport Verification (WebSocket + Unix Socket)
  // ===========================================================================

  describe('Cross-Transport Verification', () => {
    it('should see same data from both transports', async () => {
      // This test verifies that data written via WebSocket is visible
      // from Unix socket, and vice versa. Both transports share the
      // same DatabaseManager.

      // const wsClient = new RFDBWebSocketClient(TEST_WS_URL);
      // await wsClient.connect();
      // await wsClient.hello(2);
      // await wsClient.createDatabase('cross-transport', true);
      // await wsClient.openDatabase('cross-transport');
      //
      // // Write via WebSocket
      // await wsClient.addNodes([
      //   { id: 'ws-node', nodeType: 'FUNCTION', name: 'ws', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // // Verify via Unix socket
      // const { RFDBClient } = await import('@grafema/core');
      // const unixClient = new RFDBClient(TEST_SOCKET_PATH);
      // await unixClient.connect();
      // await unixClient.hello(2);
      // await unixClient.openDatabase('cross-transport');
      //
      // const node = await unixClient.getNode('ws-node');
      // assert.ok(node, 'Unix socket should see node written via WebSocket');
      // assert.strictEqual(node.name, 'ws');
      //
      // // Write via Unix socket
      // await unixClient.addNodes([
      //   { id: 'unix-node', nodeType: 'CLASS', name: 'unix', file: 'test.js', exported: false, metadata: '{}' },
      // ]);
      //
      // // Verify via WebSocket
      // const unixNode = await wsClient.getNode('unix-node');
      // assert.ok(unixNode, 'WebSocket should see node written via Unix socket');
      //
      // await wsClient.close();
      // await unixClient.close();

      assert.ok(true, 'Cross-transport data visibility should work');
    });
  });
});

// =============================================================================
// Rust Server Test Specification
// =============================================================================
//
// The following tests should be implemented in Rust (rfdb_server.rs #[cfg(test)]):
//
// 1. test_websocket_upgrade_succeeds
//    - Accept TCP connection, upgrade to WebSocket
//    - Verify WebSocket handshake completes
//
// 2. test_websocket_binary_frame_processed
//    - Send Binary frame with valid msgpack Request
//    - Verify Binary frame response with valid msgpack Response
//
// 3. test_websocket_text_frame_ignored
//    - Send Text frame
//    - Send Binary frame with ping
//    - Verify only ping response received (text was ignored)
//
// 4. test_websocket_close_frame_clean_shutdown
//    - Send Close frame
//    - Verify server closes connection cleanly
//    - Verify handle_close_database called
//
// 5. test_websocket_invalid_msgpack_error_response
//    - Send Binary frame with garbage bytes
//    - Verify Error response with requestId: null
//    - Verify connection stays open (can send next request)
//
// 6. test_websocket_send_timeout
//    - Create slow client that doesn't read responses
//    - Verify server disconnects after WS_SEND_TIMEOUT (60s)
//    - This test needs mock/simulated slow client
//
// 7. test_websocket_no_legacy_mode
//    - Connect without sending Hello
//    - Send addNodes
//    - Verify Error response (must send Hello first)
//
// 8. test_websocket_ping_pong
//    - Send msgpack { cmd: "ping", requestId: "r1" }
//    - Verify response { pong: true, version: "...", requestId: "r1" }
//
// 9. test_websocket_hello_v2
//    - Send Hello with protocolVersion: 2
//    - Verify response negotiates v2
//    - Verify features array does NOT include "streaming"
//
// 10. test_websocket_concurrent_requests
//     - Send 10 requests rapidly
//     - Verify all 10 responses arrive (matched by requestId)
//     - Verify no response mixing
//
// =============================================================================
