/**
 * TestRFDB - Helpers for creating test databases
 *
 * NEW PATTERN (Fast - ~10ms per test):
 *   const db = await createTestDatabase();
 *   await db.backend.addNodes([...]);
 *   await db.cleanup(); // or automatic on disconnect
 *
 * OLD PATTERN (Slow - ~5s per test):
 *   const backend = createTestBackend();  // DEPRECATED - throws error
 */

import { RFDBClient } from '../../packages/rfdb/dist/client.js';
import { RFDBServerBackend } from '@grafema/core';
import { join, dirname } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

let testCounter = 0;

// ===========================================================================
// Shared Test Server (Singleton)
// ===========================================================================

let sharedServerInstance = null;
let sharedServerStarting = null;

/**
 * Configuration for shared test server
 */
const SHARED_SERVER_CONFIG = {
  socketPath: '/tmp/rfdb-test-shared.sock',
  dbPath: '/tmp/rfdb-test-shared/default.rfdb',
  dataDir: '/tmp/rfdb-test-shared',
};

/**
 * Get or create the shared test server
 *
 * This server is started once and shared across all tests.
 * Each test creates an ephemeral database on this server.
 *
 * @returns {Promise<{client: RFDBClient, socketPath: string, serverProcess: ChildProcess}>}
 */
export async function getSharedServer() {
  if (sharedServerInstance) {
    return sharedServerInstance;
  }

  // Prevent race condition when multiple tests start simultaneously
  if (sharedServerStarting) {
    return sharedServerStarting;
  }

  sharedServerStarting = _startSharedServer();
  sharedServerInstance = await sharedServerStarting;
  sharedServerStarting = null;

  return sharedServerInstance;
}

async function _startSharedServer() {
  const { socketPath, dbPath, dataDir } = SHARED_SERVER_CONFIG;

  // Create data directory
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });

  // Remove stale socket
  if (existsSync(socketPath)) {
    rmSync(socketPath, { force: true });
  }

  // Find server binary
  const binaryPath = _findServerBinary();
  if (!binaryPath) {
    throw new Error(
      'RFDB server binary not found. Run: cargo build --release -p rfdb-server'
    );
  }

  // Start server
  const serverProcess = spawn(
    binaryPath,
    [dbPath, '--socket', socketPath],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );

  serverProcess.unref();

  // Wait for socket to appear
  let attempts = 0;
  while (!existsSync(socketPath) && attempts < 50) {
    await sleep(100);
    attempts++;
  }

  if (!existsSync(socketPath)) {
    throw new Error(
      `Shared RFDB server failed to start after ${attempts * 100}ms. ` +
        'Check server binary and permissions.'
    );
  }

  // Create client and negotiate protocol v2
  const client = new RFDBClient(socketPath);
  await client.connect();
  await client.hello(2);

  return {
    client,
    socketPath,
    serverProcess,
  };
}

function _findServerBinary() {
  const candidates = [
    join(process.cwd(), 'packages/rfdb-server/target/release/rfdb-server'),
    join(process.cwd(), 'packages/rfdb-server/target/debug/rfdb-server'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// ===========================================================================
// Test Database (New Pattern)
// ===========================================================================

/**
 * Create a test database on the shared server
 *
 * Usage:
 *   const db = await createTestDatabase();
 *   await db.backend.addNodes([...]);
 *   await db.cleanup(); // or automatic on disconnect
 *
 * @returns {Promise<TestDatabase>}
 */
export async function createTestDatabase() {
  const server = await getSharedServer();
  const dbName = `test-${Date.now()}-${testCounter++}`;

  // Create ephemeral database on shared server
  await server.client.createDatabase(dbName, true);

  // Create a dedicated client for this test
  const testClient = new RFDBClient(server.socketPath);
  await testClient.connect();
  await testClient.hello(2);
  await testClient.openDatabase(dbName);

  // Create backend wrapper
  const backend = new TestDatabaseBackend(testClient, dbName);

  return new TestDatabase(backend, dbName, server);
}

/**
 * TestDatabase - wrapper for test database with cleanup
 */
class TestDatabase {
  constructor(backend, dbName, server) {
    this.backend = backend;
    this.dbName = dbName;
    this._server = server;
    this._cleaned = false;
  }

  /**
   * Cleanup the test database
   *
   * For ephemeral databases, this just closes the connection.
   * The server automatically removes the database when all connections close.
   */
  async cleanup() {
    if (this._cleaned) return;
    this._cleaned = true;

    try {
      await this.backend.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * TestDatabaseBackend - Backend wrapper that works with multi-database client
 *
 * Provides the same interface as RFDBServerBackend but uses a pre-connected
 * multi-database client.
 */
class TestDatabaseBackend {
  constructor(client, dbName) {
    this._client = client;
    this.dbName = dbName;
    this.connected = true;
  }

  get client() {
    return this._client;
  }

  // === Write Operations ===
  async addNode(node) {
    return this._client.addNodes([node]);
  }

  async addNodes(nodes) {
    return this._client.addNodes(nodes);
  }

  async addEdge(edge) {
    return this._client.addEdges([edge]);
  }

  async addEdges(edges, skipValidation = false) {
    return this._client.addEdges(edges, skipValidation);
  }

  async deleteNode(id) {
    return this._client.deleteNode(id);
  }

  async deleteEdge(src, dst, edgeType) {
    return this._client.deleteEdge(src, dst, edgeType);
  }

  async clear() {
    return this._client.clear();
  }

  async updateNodeVersion(id, version) {
    return this._client.updateNodeVersion(id, version);
  }

  // === Read Operations ===
  async getNode(id) {
    return this._client.getNode(id);
  }

  async nodeExists(id) {
    return this._client.nodeExists(id);
  }

  async findByType(nodeType) {
    return this._client.findByType(nodeType);
  }

  async findByAttr(query) {
    return this._client.findByAttr(query);
  }

  async *queryNodes(query) {
    yield* this._client.queryNodes(query);
  }

  async getAllNodes(query = {}) {
    return this._client.getAllNodes(query);
  }

  async getAllEdges() {
    return this._client.getAllEdges();
  }

  async isEndpoint(id) {
    return this._client.isEndpoint(id);
  }

  async getNodeIdentifier(id) {
    return this._client.getNodeIdentifier(id);
  }

  // === Traversal ===
  async neighbors(id, edgeTypes = []) {
    return this._client.neighbors(id, edgeTypes);
  }

  async bfs(startIds, maxDepth, edgeTypes = []) {
    return this._client.bfs(startIds, maxDepth, edgeTypes);
  }

  async dfs(startIds, maxDepth, edgeTypes = []) {
    return this._client.dfs(startIds, maxDepth, edgeTypes);
  }

  async reachability(startIds, maxDepth, edgeTypes = [], backward = false) {
    return this._client.reachability(startIds, maxDepth, edgeTypes, backward);
  }

  async getOutgoingEdges(id, edgeTypes = null) {
    return this._client.getOutgoingEdges(id, edgeTypes);
  }

  async getIncomingEdges(id, edgeTypes = null) {
    return this._client.getIncomingEdges(id, edgeTypes);
  }

  // === Stats ===
  async nodeCount() {
    return this._client.nodeCount();
  }

  async edgeCount() {
    return this._client.edgeCount();
  }

  async countNodesByType(types = null) {
    return this._client.countNodesByType(types);
  }

  async countEdgesByType(edgeTypes = null) {
    return this._client.countEdgesByType(edgeTypes);
  }

  // === Control ===
  async flush() {
    return this._client.flush();
  }

  async compact() {
    return this._client.compact();
  }

  async ping() {
    return this._client.ping();
  }

  // === Datalog ===
  async datalogLoadRules(source) {
    return this._client.datalogLoadRules(source);
  }

  async datalogClearRules() {
    return this._client.datalogClearRules();
  }

  async datalogQuery(query) {
    return this._client.datalogQuery(query);
  }

  async checkGuarantee(ruleSource) {
    return this._client.checkGuarantee(ruleSource);
  }

  // === Additional methods for compatibility with RFDBServerBackend ===
  async findNodes(predicate) {
    const allNodes = await this.getAllNodes();
    return allNodes.filter(predicate);
  }

  async getAllEdgesAsync() {
    return this.getAllEdges();
  }

  async getStats() {
    const nodeCount = await this.nodeCount();
    const edgeCount = await this.edgeCount();
    return { nodeCount, edgeCount };
  }

  // === Connection ===
  async connect() {
    // Already connected in constructor
    return;
  }

  async close() {
    if (this._client) {
      try {
        await this._client.closeDatabase();
      } catch {
        // Ignore close errors
      }
      await this._client.close();
      this._client = null;
      this.connected = false;
    }
  }

  // Alias for compatibility
  async cleanup() {
    await this.close();
  }
}

// ===========================================================================
// Legacy Pattern (Deprecated)
// ===========================================================================

/**
 * @deprecated Use createTestDatabase() instead for 10x faster tests.
 *
 * This function now throws an error to force migration.
 */
export function createTestBackend() {
  throw new Error(
    `DEPRECATED: createTestBackend() is deprecated.

Use createTestDatabase() instead for 10x faster tests.

Migration:
  // Before:
  const backend = createTestBackend();
  await backend.connect();

  // After:
  const db = await createTestDatabase();
  const backend = db.backend;
`
  );
}

/**
 * @deprecated Use createTestDatabase() instead.
 */
export class TestBackend {
  constructor() {
    throw new Error(
      'DEPRECATED: TestBackend class is deprecated. Use createTestDatabase() instead.'
    );
  }
}
