/**
 * SocketConnectionEnricher Tests (REG-432)
 *
 * Tests INTERACTS_WITH edge creation between socket clients and servers:
 * - os:unix-socket -> os:unix-server (matched by path)
 * - net:tcp-connection -> net:tcp-server (matched by port + host)
 *
 * Follows the same MockGraphBackend pattern as HTTPConnectionEnricher.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// =============================================================================
// MOCK GRAPH BACKEND
// =============================================================================

class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  addNode(node) {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge) {
    this.edges.push(edge);
  }

  async *queryNodes(filter) {
    for (const node of this.nodes.values()) {
      if (filter?.type && node.type !== filter.type) continue;
      yield node;
    }
  }

  getEdges() {
    return this.edges;
  }

  findEdge(type, src, dst) {
    return this.edges.find(e => e.type === type && e.src === src && e.dst === dst);
  }
}

// =============================================================================
// SIMPLIFIED ENRICHER LOGIC (for testing the matching algorithm)
// =============================================================================

/**
 * Normalize Unix socket path for comparison.
 * Strips trailing slashes and handles relative paths.
 */
function normalizeSocketPath(path) {
  if (!path) return '';
  // Strip trailing slashes
  return path.replace(/\/+$/, '');
}

/**
 * Match Unix socket clients to servers by path equality.
 *
 * os:unix-socket -> os:unix-server when paths match after normalization.
 */
async function matchUnixSockets(graph) {
  const clients = [];
  for await (const node of graph.queryNodes({ type: 'os:unix-socket' })) {
    clients.push(node);
  }

  const servers = [];
  for await (const node of graph.queryNodes({ type: 'os:unix-server' })) {
    servers.push(node);
  }

  const edges = [];

  for (const client of clients) {
    if (!client.path) continue;
    // Skip dynamic paths (template literals with variables)
    if (client.dynamicPath) continue;

    const normalizedClientPath = normalizeSocketPath(client.path);

    for (const server of servers) {
      if (!server.path) continue;

      const normalizedServerPath = normalizeSocketPath(server.path);

      if (normalizedClientPath === normalizedServerPath) {
        edges.push({
          type: 'INTERACTS_WITH',
          src: client.id,
          dst: server.id,
          metadata: { matchType: 'path', path: normalizedClientPath },
          protocol: 'unix'
        });
        break; // One client -> one server (first match)
      }
    }
  }

  return edges;
}

/**
 * Match TCP socket clients to servers by port (and optionally host).
 *
 * net:tcp-connection -> net:tcp-server when port matches.
 * Host defaults to 'localhost' when not specified.
 */
async function matchTcpSockets(graph) {
  const clients = [];
  for await (const node of graph.queryNodes({ type: 'net:tcp-connection' })) {
    clients.push(node);
  }

  const servers = [];
  for await (const node of graph.queryNodes({ type: 'net:tcp-server' })) {
    servers.push(node);
  }

  const edges = [];

  for (const client of clients) {
    if (client.port == null) continue;

    const clientPort = Number(client.port);
    const clientHost = client.host || 'localhost';

    for (const server of servers) {
      if (server.port == null) continue;

      const serverPort = Number(server.port);
      const serverHost = server.host || 'localhost';

      // Port must match
      if (clientPort !== serverPort) continue;

      // Host comparison: exact match or server listens on all interfaces (0.0.0.0)
      // V1: exact match only (0.0.0.0 wildcard is future)
      if (clientHost === serverHost || serverHost === '0.0.0.0') {
        edges.push({
          type: 'INTERACTS_WITH',
          src: client.id,
          dst: server.id,
          metadata: { matchType: 'port', port: clientPort, host: clientHost },
          protocol: 'tcp'
        });
        break; // One client -> one server (first match)
      }
    }
  }

  return edges;
}

/**
 * Full socket connection matching (combines Unix and TCP).
 */
async function matchSocketConnections(graph) {
  const unixEdges = await matchUnixSockets(graph);
  const tcpEdges = await matchTcpSockets(graph);
  return [...unixEdges, ...tcpEdges];
}

// =============================================================================
// TESTS
// =============================================================================

describe('SocketConnectionEnricher - Unix socket matching (REG-432)', () => {

  describe('Basic Unix socket path matching', () => {

    it('should link Unix socket client to server by exact path', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'unix-client:app-sock',
        type: 'os:unix-socket',
        protocol: 'unix',
        path: '/tmp/app.sock',
        library: 'net',
      });

      graph.addNode({
        id: 'unix-server:app-sock',
        type: 'os:unix-server',
        protocol: 'unix',
        path: '/tmp/app.sock',
      });

      const edges = await matchUnixSockets(graph);

      assert.strictEqual(edges.length, 1, 'Should create 1 INTERACTS_WITH edge');
      assert.strictEqual(edges[0].src, 'unix-client:app-sock');
      assert.strictEqual(edges[0].dst, 'unix-server:app-sock');
      assert.strictEqual(edges[0].type, 'INTERACTS_WITH');
      assert.strictEqual(edges[0].protocol, 'unix');
    });

    it('should NOT link when paths differ', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'unix-client:app-sock',
        type: 'os:unix-socket',
        protocol: 'unix',
        path: '/tmp/app.sock',
        library: 'net',
      });

      graph.addNode({
        id: 'unix-server:other-sock',
        type: 'os:unix-server',
        protocol: 'unix',
        path: '/tmp/other.sock',
      });

      const edges = await matchUnixSockets(graph);

      assert.strictEqual(edges.length, 0, 'Should NOT create edge when paths differ');
    });

    it('should match relative paths after normalization', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'unix-client:rfdb',
        type: 'os:unix-socket',
        protocol: 'unix',
        path: '.grafema/rfdb.sock',
        library: 'net',
      });

      graph.addNode({
        id: 'unix-server:rfdb',
        type: 'os:unix-server',
        protocol: 'unix',
        path: '.grafema/rfdb.sock',
      });

      const edges = await matchUnixSockets(graph);

      assert.strictEqual(edges.length, 1, 'Should match relative paths');
      assert.strictEqual(edges[0].src, 'unix-client:rfdb');
      assert.strictEqual(edges[0].dst, 'unix-server:rfdb');
    });
  });

  describe('Dynamic path handling', () => {

    it('should skip clients with dynamic paths (template literals)', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'unix-client:dynamic',
        type: 'os:unix-socket',
        protocol: 'unix',
        path: '${projectPath}/app.sock',
        library: 'net',
        dynamicPath: true,
      });

      graph.addNode({
        id: 'unix-server:app-sock',
        type: 'os:unix-server',
        protocol: 'unix',
        path: '/tmp/app.sock',
      });

      const edges = await matchUnixSockets(graph);

      assert.strictEqual(edges.length, 0, 'Should NOT match dynamic path client to static server');
    });
  });

  describe('Missing path edge cases', () => {

    it('should skip client without path', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'unix-client:no-path',
        type: 'os:unix-socket',
        protocol: 'unix',
        // no path
        library: 'net',
      });

      graph.addNode({
        id: 'unix-server:app',
        type: 'os:unix-server',
        protocol: 'unix',
        path: '/tmp/app.sock',
      });

      const edges = await matchUnixSockets(graph);

      assert.strictEqual(edges.length, 0, 'Should not match client without path');
    });

    it('should skip server without path', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'unix-client:app',
        type: 'os:unix-socket',
        protocol: 'unix',
        path: '/tmp/app.sock',
        library: 'net',
      });

      graph.addNode({
        id: 'unix-server:no-path',
        type: 'os:unix-server',
        protocol: 'unix',
        // no path
      });

      const edges = await matchUnixSockets(graph);

      assert.strictEqual(edges.length, 0, 'Should not match server without path');
    });
  });

  describe('Multiple clients and servers', () => {

    it('should match correct client to correct server when multiple exist', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'unix-client:app',
        type: 'os:unix-socket',
        protocol: 'unix',
        path: '/tmp/app.sock',
        library: 'net',
      });

      graph.addNode({
        id: 'unix-client:rfdb',
        type: 'os:unix-socket',
        protocol: 'unix',
        path: '/tmp/rfdb.sock',
        library: 'net',
      });

      graph.addNode({
        id: 'unix-server:app',
        type: 'os:unix-server',
        protocol: 'unix',
        path: '/tmp/app.sock',
      });

      graph.addNode({
        id: 'unix-server:rfdb',
        type: 'os:unix-server',
        protocol: 'unix',
        path: '/tmp/rfdb.sock',
      });

      const edges = await matchUnixSockets(graph);

      assert.strictEqual(edges.length, 2, 'Should create 2 INTERACTS_WITH edges');

      const appEdge = edges.find(e => e.src === 'unix-client:app');
      assert.ok(appEdge, 'Should have edge from app client');
      assert.strictEqual(appEdge.dst, 'unix-server:app', 'App client should connect to app server');

      const rfdbEdge = edges.find(e => e.src === 'unix-client:rfdb');
      assert.ok(rfdbEdge, 'Should have edge from rfdb client');
      assert.strictEqual(rfdbEdge.dst, 'unix-server:rfdb', 'RFDB client should connect to rfdb server');
    });
  });
});

describe('SocketConnectionEnricher - TCP socket matching (REG-432)', () => {

  describe('Basic TCP port matching', () => {

    it('should link TCP client to server by matching port', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'tcp-client:3000',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: 3000,
        host: 'localhost',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-server:3000',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 3000,
        host: 'localhost',
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 1, 'Should create 1 INTERACTS_WITH edge');
      assert.strictEqual(edges[0].src, 'tcp-client:3000');
      assert.strictEqual(edges[0].dst, 'tcp-server:3000');
      assert.strictEqual(edges[0].type, 'INTERACTS_WITH');
      assert.strictEqual(edges[0].protocol, 'tcp');
    });

    it('should NOT link when ports differ', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'tcp-client:3000',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: 3000,
        host: 'localhost',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-server:8080',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 8080,
        host: 'localhost',
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 0, 'Should NOT create edge when ports differ');
    });
  });

  describe('Host matching', () => {

    it('should match with default host (localhost) when host not specified', async () => {
      const graph = new MockGraphBackend();

      // Client without host (defaults to localhost)
      graph.addNode({
        id: 'tcp-client:5000',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: 5000,
        // no host - defaults to localhost
        library: 'net',
      });

      // Server without host (defaults to localhost)
      graph.addNode({
        id: 'tcp-server:5000',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 5000,
        // no host - defaults to localhost
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 1, 'Should match when both default to localhost');
    });

    it('should NOT match when hosts differ (V1: exact match)', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'tcp-client:remote',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: 3000,
        host: '192.168.1.100',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-server:local',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 3000,
        host: 'localhost',
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 0, 'Should NOT match when hosts differ');
    });

    it('should match server with 0.0.0.0 (all interfaces) to any client host', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'tcp-client:local',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: 8080,
        host: 'localhost',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-server:all-interfaces',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 8080,
        host: '0.0.0.0',
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 1, 'Should match 0.0.0.0 server to any client');
      assert.strictEqual(edges[0].src, 'tcp-client:local');
      assert.strictEqual(edges[0].dst, 'tcp-server:all-interfaces');
    });
  });

  describe('Port as string vs number', () => {

    it('should match port regardless of string vs number type', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'tcp-client:str-port',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: '3000',  // String
        host: 'localhost',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-server:num-port',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 3000,  // Number
        host: 'localhost',
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 1, 'Should match string port to number port');
    });
  });

  describe('Missing port edge cases', () => {

    it('should skip client without port', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'tcp-client:no-port',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        // no port
        host: 'localhost',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-server:3000',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 3000,
        host: 'localhost',
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 0, 'Should not match client without port');
    });

    it('should skip server without port', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'tcp-client:3000',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: 3000,
        host: 'localhost',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-server:no-port',
        type: 'net:tcp-server',
        protocol: 'tcp',
        // no port
        host: 'localhost',
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 0, 'Should not match server without port');
    });
  });

  describe('Multiple TCP connections', () => {

    it('should match correct client to correct server when multiple exist', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'tcp-client:3000',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: 3000,
        host: 'localhost',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-client:8080',
        type: 'net:tcp-connection',
        protocol: 'tcp',
        port: 8080,
        host: 'localhost',
        library: 'net',
      });

      graph.addNode({
        id: 'tcp-server:3000',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 3000,
        host: 'localhost',
      });

      graph.addNode({
        id: 'tcp-server:8080',
        type: 'net:tcp-server',
        protocol: 'tcp',
        port: 8080,
        host: '0.0.0.0',
      });

      const edges = await matchTcpSockets(graph);

      assert.strictEqual(edges.length, 2, 'Should create 2 INTERACTS_WITH edges');

      const edge3000 = edges.find(e => e.src === 'tcp-client:3000');
      assert.ok(edge3000, 'Should have edge from port 3000 client');
      assert.strictEqual(edge3000.dst, 'tcp-server:3000');

      const edge8080 = edges.find(e => e.src === 'tcp-client:8080');
      assert.ok(edge8080, 'Should have edge from port 8080 client');
      assert.strictEqual(edge8080.dst, 'tcp-server:8080');
    });
  });
});

describe('SocketConnectionEnricher - Combined matching (REG-432)', () => {

  it('should match both Unix and TCP connections in same graph', async () => {
    const graph = new MockGraphBackend();

    // Unix socket pair
    graph.addNode({
      id: 'unix-client:app',
      type: 'os:unix-socket',
      protocol: 'unix',
      path: '/tmp/app.sock',
      library: 'net',
    });

    graph.addNode({
      id: 'unix-server:app',
      type: 'os:unix-server',
      protocol: 'unix',
      path: '/tmp/app.sock',
    });

    // TCP socket pair
    graph.addNode({
      id: 'tcp-client:3000',
      type: 'net:tcp-connection',
      protocol: 'tcp',
      port: 3000,
      host: 'localhost',
      library: 'net',
    });

    graph.addNode({
      id: 'tcp-server:3000',
      type: 'net:tcp-server',
      protocol: 'tcp',
      port: 3000,
      host: 'localhost',
    });

    const edges = await matchSocketConnections(graph);

    assert.strictEqual(edges.length, 2, 'Should create 2 INTERACTS_WITH edges (1 Unix + 1 TCP)');

    const unixEdge = edges.find(e => e.protocol === 'unix');
    assert.ok(unixEdge, 'Should have Unix socket edge');
    assert.strictEqual(unixEdge.src, 'unix-client:app');
    assert.strictEqual(unixEdge.dst, 'unix-server:app');

    const tcpEdge = edges.find(e => e.protocol === 'tcp');
    assert.ok(tcpEdge, 'Should have TCP socket edge');
    assert.strictEqual(tcpEdge.src, 'tcp-client:3000');
    assert.strictEqual(tcpEdge.dst, 'tcp-server:3000');
  });

  it('should not cross-match Unix clients with TCP servers', async () => {
    const graph = new MockGraphBackend();

    // Unix socket client
    graph.addNode({
      id: 'unix-client:app',
      type: 'os:unix-socket',
      protocol: 'unix',
      path: '/tmp/app.sock',
      library: 'net',
    });

    // TCP server (different namespace, should NOT match)
    graph.addNode({
      id: 'tcp-server:3000',
      type: 'net:tcp-server',
      protocol: 'tcp',
      port: 3000,
      host: 'localhost',
    });

    const edges = await matchSocketConnections(graph);

    assert.strictEqual(edges.length, 0, 'Should NOT cross-match Unix client with TCP server');
  });
});

describe('SocketConnectionEnricher - Empty graph edge cases (REG-432)', () => {

  it('should handle graph with no socket nodes', async () => {
    const graph = new MockGraphBackend();

    // Only non-socket nodes
    graph.addNode({
      id: 'http:request-1',
      type: 'http:request',
      method: 'GET',
      url: '/api/users',
    });

    const edges = await matchSocketConnections(graph);

    assert.strictEqual(edges.length, 0, 'Should produce no edges from non-socket nodes');
  });

  it('should handle graph with only clients and no servers', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'unix-client:orphan',
      type: 'os:unix-socket',
      protocol: 'unix',
      path: '/tmp/orphan.sock',
      library: 'net',
    });

    graph.addNode({
      id: 'tcp-client:orphan',
      type: 'net:tcp-connection',
      protocol: 'tcp',
      port: 9999,
      host: 'localhost',
      library: 'net',
    });

    const edges = await matchSocketConnections(graph);

    assert.strictEqual(edges.length, 0, 'Should produce no edges when no servers exist');
  });

  it('should handle graph with only servers and no clients', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'unix-server:orphan',
      type: 'os:unix-server',
      protocol: 'unix',
      path: '/tmp/orphan.sock',
    });

    graph.addNode({
      id: 'tcp-server:orphan',
      type: 'net:tcp-server',
      protocol: 'tcp',
      port: 9999,
      host: 'localhost',
    });

    const edges = await matchSocketConnections(graph);

    assert.strictEqual(edges.length, 0, 'Should produce no edges when no clients exist');
  });
});
