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
// Auto-cleanup Registry
// ===========================================================================

/** @type {Set<TestDatabase>} */
const activeTestDatabases = new Set();

// Forceful cleanup on process exit - destroy all sockets synchronously
// This ensures the process can exit even if tests don't call cleanup()
process.on('exit', () => {
  // Force close all test database connections
  for (const db of activeTestDatabases) {
    try {
      if (db.backend._client?.socket) {
        db.backend._client.socket.destroy();
      }
    } catch {
      // Ignore
    }
  }
  activeTestDatabases.clear();

  // Force close shared server connection
  if (sharedServerInstance?.client?.socket) {
    try {
      sharedServerInstance.client.socket.destroy();
    } catch {
      // Ignore
    }
  }
});

// Also handle beforeExit for async cleanup when possible
process.on('beforeExit', async () => {
  if (activeTestDatabases.size > 0) {
    const cleanupPromises = [];
    for (const db of activeTestDatabases) {
      cleanupPromises.push(db.cleanup().catch(() => {}));
    }
    await Promise.all(cleanupPromises);
    activeTestDatabases.clear();
  }

  // Close shared server connection
  if (sharedServerInstance?.client) {
    try {
      await sharedServerInstance.client.close();
    } catch {
      // Ignore
    }
  }
});

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

  // Check if socket already exists - another test file might have started the server
  if (existsSync(socketPath)) {
    try {
      // Try to connect to existing server
      const client = new RFDBClient(socketPath);
      await client.connect();
      await client.hello(2);

      // Connection succeeded - reuse existing server
      return {
        client,
        socketPath,
        serverProcess: null, // We didn't start it
      };
    } catch {
      // Connection failed - socket is stale, remove it
      rmSync(socketPath, { force: true });
    }
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

  // Keep socket ref'd during tests (removed unref to fix early exit)

  // Create backend wrapper
  const backend = new TestDatabaseBackend(testClient, dbName);

  const testDb = new TestDatabase(backend, dbName, server);

  // Register for auto-cleanup
  activeTestDatabases.add(testDb);

  return testDb;
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

    // Remove from auto-cleanup registry
    activeTestDatabases.delete(this);

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

  /**
   * Parse a wire format node into the expected application format.
   * Wire format has metadata as JSON string, this parses and spreads it.
   */
  _parseNode(wireNode) {
    if (!wireNode) return null;

    const metadata = wireNode.metadata
      ? (typeof wireNode.metadata === 'string' ? JSON.parse(wireNode.metadata) : wireNode.metadata)
      : {};

    // Parse nested JSON strings in metadata
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
        try {
          metadata[key] = JSON.parse(value);
        } catch {
          // Keep as string
        }
      }
    }

    const humanId = metadata.originalId || wireNode.id;

    // Exclude standard fields from metadata to prevent overwriting
    const {
      id: _id,
      type: _type,
      name: _name,
      file: _file,
      exported: _exported,
      nodeType: _nodeType,
      originalId: _originalId,
      ...safeMetadata
    } = metadata;

    return {
      id: humanId,
      type: wireNode.nodeType,
      name: wireNode.name,
      file: wireNode.file,
      exported: wireNode.exported,
      ...safeMetadata,
    };
  }

  // === Write Operations ===
  /**
   * Store originalId in metadata to preserve semantic IDs through RFDB's numeric ID system.
   * This mirrors RFDBServerBackend.addNodes behavior.
   */
  _prepareNodes(nodes) {
    return nodes.map(node => {
      const { id, type, metadata, ...rest } = node;
      // Parse existing metadata if it's a string
      const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
      // Store original semantic ID in metadata
      return {
        ...rest,
        id,
        type,
        metadata: JSON.stringify({ originalId: String(id), ...existingMeta }),
      };
    });
  }

  async addNode(node) {
    return this._client.addNodes(this._prepareNodes([node]));
  }

  async addNodes(nodes) {
    return this._client.addNodes(this._prepareNodes(nodes));
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
    const wireNode = await this._client.getNode(id);
    return this._parseNode(wireNode);
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
    for await (const wireNode of this._client.queryNodes(query)) {
      yield this._parseNode(wireNode);
    }
  }

  async getAllNodes(query = {}) {
    const wireNodes = await this._client.getAllNodes(query);
    return wireNodes.map(n => this._parseNode(n));
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

  /**
   * Translate numeric ID to semantic ID using metadata.originalId
   */
  async _translateId(numericId) {
    const wireNode = await this._client.getNode(numericId);
    if (!wireNode) return numericId;

    const metadata = wireNode.metadata
      ? (typeof wireNode.metadata === 'string' ? JSON.parse(wireNode.metadata) : wireNode.metadata)
      : {};

    return metadata.originalId || numericId;
  }

  async getOutgoingEdges(id, edgeTypes = null) {
    const edges = await this._client.getOutgoingEdges(id, edgeTypes);
    // Translate numeric IDs to semantic IDs
    return Promise.all(edges.map(async (edge) => ({
      ...edge,
      src: await this._translateId(edge.src),
      dst: await this._translateId(edge.dst),
    })));
  }

  async getIncomingEdges(id, edgeTypes = null) {
    const edges = await this._client.getIncomingEdges(id, edgeTypes);
    // Translate numeric IDs to semantic IDs
    return Promise.all(edges.map(async (edge) => ({
      ...edge,
      src: await this._translateId(edge.src),
      dst: await this._translateId(edge.dst),
    })));
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
// Cleanup Helpers
// ===========================================================================

/**
 * Cleanup all active test databases and close shared server connection.
 *
 * Call this in your test file's `after()` hook:
 *   import { after } from 'node:test';
 *   import { cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
 *   after(cleanupAllTestDatabases);
 */
export async function cleanupAllTestDatabases() {
  const cleanupPromises = [];
  for (const db of activeTestDatabases) {
    cleanupPromises.push(db.cleanup().catch(() => {}));
  }
  await Promise.all(cleanupPromises);
  activeTestDatabases.clear();

  // Close shared server connection and unref so process can exit
  if (sharedServerInstance?.client) {
    try {
      // Unref to allow process exit, then close
      sharedServerInstance.client.unref();
      await sharedServerInstance.client.close();
    } catch {
      // Ignore cleanup errors
    }
    sharedServerInstance = null;
  }

  // Unref all remaining handles to allow process exit
  // This handles any sockets that weren't properly cleaned up
  for (const handle of process._getActiveHandles()) {
    if (handle.unref && typeof handle.unref === 'function') {
      try {
        handle.unref();
      } catch {
        // Ignore unref errors
      }
    }
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
