/**
 * SocketAnalyzer Tests (REG-432)
 *
 * Tests that SocketAnalyzer detects Unix domain socket and TCP socket patterns
 * from Node.js net module and creates correct node types:
 * - os:unix-socket (Unix domain socket client)
 * - os:unix-server (Unix domain socket server)
 * - net:tcp-connection (TCP socket client)
 * - net:tcp-server (TCP socket server)
 *
 * Also tests CONTAINS and MAKES_REQUEST edge creation.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { SocketAnalyzer } from '@grafema/core';

let testCounter = 0;

/**
 * Helper to create a test project with given files and run analysis
 * including the SocketAnalyzer plugin.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-socket-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-socket-${testCounter}`,
      main: 'index.js'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, {
    forceAnalysis: true,
    extraPlugins: [new SocketAnalyzer()]
  });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Find nodes by type from all nodes in the graph
 */
async function findNodesByType(backend, type) {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n) => n.type === type);
}

/**
 * Find edges by type from all edges in the graph
 */
async function findEdgesByType(backend, edgeType) {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter((e) => e.type === edgeType);
}

describe('SocketAnalyzer - Unix socket client detection (REG-432)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should detect net.connect({ path }) as os:unix-socket', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

function connectToSocket() {
  const client = net.connect({ path: '/tmp/app.sock' });
  return client;
}
      `
    });

    const unixSockets = await findNodesByType(backend, 'os:unix-socket');
    assert.ok(unixSockets.length >= 1, `Should detect at least 1 os:unix-socket node. Found: ${unixSockets.length}`);

    const socket = unixSockets.find((n) => n.path === '/tmp/app.sock');
    assert.ok(socket, 'Should have os:unix-socket with path /tmp/app.sock');
    assert.strictEqual(socket.protocol, 'unix', 'Protocol should be unix');
  });

  it('should detect net.createConnection(path) as os:unix-socket', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

function connectToRfdb() {
  const client = net.createConnection('/var/run/rfdb.sock');
  return client;
}
      `
    });

    const unixSockets = await findNodesByType(backend, 'os:unix-socket');
    assert.ok(unixSockets.length >= 1, `Should detect at least 1 os:unix-socket node. Found: ${unixSockets.length}`);

    const socket = unixSockets.find((n) => n.path === '/var/run/rfdb.sock');
    assert.ok(socket, 'Should have os:unix-socket with path /var/run/rfdb.sock');
    assert.strictEqual(socket.protocol, 'unix', 'Protocol should be unix');
  });
});

describe('SocketAnalyzer - TCP socket client detection (REG-432)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should detect net.connect({ port, host }) as net:tcp-connection', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

function connectToServer() {
  const client = net.connect({ port: 3000, host: 'localhost' });
  return client;
}
      `
    });

    const tcpConnections = await findNodesByType(backend, 'net:tcp-connection');
    assert.ok(tcpConnections.length >= 1, `Should detect at least 1 net:tcp-connection node. Found: ${tcpConnections.length}`);

    const conn = tcpConnections.find((n) => n.port === 3000 || n.port === '3000');
    assert.ok(conn, 'Should have net:tcp-connection with port 3000');
    assert.strictEqual(conn.protocol, 'tcp', 'Protocol should be tcp');
  });

  it('should detect net.connect(port) as net:tcp-connection', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

function connectToBackup() {
  const client = net.connect(8080);
  return client;
}
      `
    });

    const tcpConnections = await findNodesByType(backend, 'net:tcp-connection');
    assert.ok(tcpConnections.length >= 1, `Should detect at least 1 net:tcp-connection node. Found: ${tcpConnections.length}`);

    const conn = tcpConnections.find((n) => n.port === 8080 || n.port === '8080');
    assert.ok(conn, 'Should have net:tcp-connection with port 8080');
    assert.strictEqual(conn.protocol, 'tcp', 'Protocol should be tcp');
  });
});

describe('SocketAnalyzer - Unix socket server detection (REG-432)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should detect net.createServer().listen(path) as os:unix-server', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

const server = net.createServer((socket) => {
  socket.write('Hello');
}).listen('/tmp/app.sock');
      `
    });

    const unixServers = await findNodesByType(backend, 'os:unix-server');
    assert.ok(unixServers.length >= 1, `Should detect at least 1 os:unix-server node. Found: ${unixServers.length}`);

    const server = unixServers.find((n) => n.path === '/tmp/app.sock');
    assert.ok(server, 'Should have os:unix-server with path /tmp/app.sock');
    assert.strictEqual(server.protocol, 'unix', 'Protocol should be unix');
  });
});

describe('SocketAnalyzer - TCP socket server detection (REG-432)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should detect net.createServer().listen(port) as net:tcp-server', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

const server = net.createServer((socket) => {
  socket.write('Hello from TCP');
  socket.end();
}).listen(3000);
      `
    });

    const tcpServers = await findNodesByType(backend, 'net:tcp-server');
    assert.ok(tcpServers.length >= 1, `Should detect at least 1 net:tcp-server node. Found: ${tcpServers.length}`);

    const server = tcpServers.find((n) => n.port === 3000 || n.port === '3000');
    assert.ok(server, 'Should have net:tcp-server with port 3000');
    assert.strictEqual(server.protocol, 'tcp', 'Protocol should be tcp');
  });

  it('should detect net.createServer().listen({ port, host }) as net:tcp-server', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    console.log(data.toString());
  });
}).listen({ port: 8080, host: '0.0.0.0' });
      `
    });

    const tcpServers = await findNodesByType(backend, 'net:tcp-server');
    assert.ok(tcpServers.length >= 1, `Should detect at least 1 net:tcp-server node. Found: ${tcpServers.length}`);

    const server = tcpServers.find((n) => n.port === 8080 || n.port === '8080');
    assert.ok(server, 'Should have net:tcp-server with port 8080');
    assert.strictEqual(server.protocol, 'tcp', 'Protocol should be tcp');
  });
});

describe('SocketAnalyzer - CONTAINS edge (REG-432)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should create CONTAINS edge from MODULE to os:unix-socket node', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

const client = net.connect({ path: '/tmp/test.sock' });
      `
    });

    const unixSockets = await findNodesByType(backend, 'os:unix-socket');
    assert.ok(unixSockets.length >= 1, 'Should detect at least 1 os:unix-socket node');

    const containsEdges = await findEdgesByType(backend, 'CONTAINS');
    const allNodes = await backend.getAllNodes();
    const moduleNodes = allNodes.filter((n) => n.type === 'MODULE');

    // Find CONTAINS edge from a MODULE to a unix-socket node
    const socketIds = new Set(unixSockets.map((n) => n.id));
    const moduleIds = new Set(moduleNodes.map((n) => n.id));

    const moduleToSocket = containsEdges.find(
      (e) => moduleIds.has(e.src) && socketIds.has(e.dst)
    );

    assert.ok(moduleToSocket, 'Should have CONTAINS edge from MODULE to os:unix-socket');
  });

  it('should create CONTAINS edge from MODULE to net:tcp-connection node', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

const client = net.connect({ port: 5000, host: 'localhost' });
      `
    });

    const tcpConns = await findNodesByType(backend, 'net:tcp-connection');
    assert.ok(tcpConns.length >= 1, 'Should detect at least 1 net:tcp-connection node');

    const containsEdges = await findEdgesByType(backend, 'CONTAINS');
    const allNodes = await backend.getAllNodes();
    const moduleNodes = allNodes.filter((n) => n.type === 'MODULE');

    const connIds = new Set(tcpConns.map((n) => n.id));
    const moduleIds = new Set(moduleNodes.map((n) => n.id));

    const moduleToConn = containsEdges.find(
      (e) => moduleIds.has(e.src) && connIds.has(e.dst)
    );

    assert.ok(moduleToConn, 'Should have CONTAINS edge from MODULE to net:tcp-connection');
  });

  it('should create CONTAINS edge from MODULE to os:unix-server node', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

const server = net.createServer(() => {}).listen('/tmp/server.sock');
      `
    });

    const unixServers = await findNodesByType(backend, 'os:unix-server');
    assert.ok(unixServers.length >= 1, 'Should detect at least 1 os:unix-server node');

    const containsEdges = await findEdgesByType(backend, 'CONTAINS');
    const allNodes = await backend.getAllNodes();
    const moduleNodes = allNodes.filter((n) => n.type === 'MODULE');

    const serverIds = new Set(unixServers.map((n) => n.id));
    const moduleIds = new Set(moduleNodes.map((n) => n.id));

    const moduleToServer = containsEdges.find(
      (e) => moduleIds.has(e.src) && serverIds.has(e.dst)
    );

    assert.ok(moduleToServer, 'Should have CONTAINS edge from MODULE to os:unix-server');
  });

  it('should create CONTAINS edge from MODULE to net:tcp-server node', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

const server = net.createServer(() => {}).listen(9090);
      `
    });

    const tcpServers = await findNodesByType(backend, 'net:tcp-server');
    assert.ok(tcpServers.length >= 1, 'Should detect at least 1 net:tcp-server node');

    const containsEdges = await findEdgesByType(backend, 'CONTAINS');
    const allNodes = await backend.getAllNodes();
    const moduleNodes = allNodes.filter((n) => n.type === 'MODULE');

    const serverIds = new Set(tcpServers.map((n) => n.id));
    const moduleIds = new Set(moduleNodes.map((n) => n.id));

    const moduleToServer = containsEdges.find(
      (e) => moduleIds.has(e.src) && serverIds.has(e.dst)
    );

    assert.ok(moduleToServer, 'Should have CONTAINS edge from MODULE to net:tcp-server');
  });
});

describe('SocketAnalyzer - MAKES_REQUEST edge (REG-432)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should create MAKES_REQUEST edge from FUNCTION to os:unix-socket', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

function connectToApp() {
  const client = net.connect({ path: '/tmp/app.sock' });
  return client;
}
      `
    });

    const unixSockets = await findNodesByType(backend, 'os:unix-socket');
    assert.ok(unixSockets.length >= 1, 'Should detect at least 1 os:unix-socket node');

    const makesRequestEdges = await findEdgesByType(backend, 'MAKES_REQUEST');
    const allNodes = await backend.getAllNodes();

    const socketIds = new Set(unixSockets.map((n) => n.id));
    const functionNodes = allNodes.filter((n) => n.type === 'FUNCTION');
    const functionIds = new Set(functionNodes.map((n) => n.id));

    const funcToSocket = makesRequestEdges.find(
      (e) => functionIds.has(e.src) && socketIds.has(e.dst)
    );

    assert.ok(funcToSocket, 'Should have MAKES_REQUEST edge from FUNCTION to os:unix-socket');
  });

  it('should create MAKES_REQUEST edge from CALL to net:tcp-connection', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

function connectToServer() {
  const client = net.connect({ port: 3000, host: 'localhost' });
  return client;
}
      `
    });

    const tcpConns = await findNodesByType(backend, 'net:tcp-connection');
    assert.ok(tcpConns.length >= 1, 'Should detect at least 1 net:tcp-connection node');

    const makesRequestEdges = await findEdgesByType(backend, 'MAKES_REQUEST');
    const allNodes = await backend.getAllNodes();

    const connIds = new Set(tcpConns.map((n) => n.id));
    const callNodes = allNodes.filter((n) => n.type === 'CALL');
    const callIds = new Set(callNodes.map((n) => n.id));

    const callToConn = makesRequestEdges.find(
      (e) => callIds.has(e.src) && connIds.has(e.dst)
    );

    assert.ok(callToConn, 'Should have MAKES_REQUEST edge from CALL to net:tcp-connection');
  });

  it('should create MAKES_REQUEST edge from FUNCTION to net:tcp-server', async () => {
    await setupTest(backend, {
      'index.js': `
const net = require('net');

function startServer() {
  const server = net.createServer((socket) => {
    socket.write('hello');
  }).listen(4000);
  return server;
}
      `
    });

    const tcpServers = await findNodesByType(backend, 'net:tcp-server');
    assert.ok(tcpServers.length >= 1, 'Should detect at least 1 net:tcp-server node');

    const makesRequestEdges = await findEdgesByType(backend, 'MAKES_REQUEST');
    const allNodes = await backend.getAllNodes();

    const serverIds = new Set(tcpServers.map((n) => n.id));
    const functionNodes = allNodes.filter((n) => n.type === 'FUNCTION');
    const functionIds = new Set(functionNodes.map((n) => n.id));

    const funcToServer = makesRequestEdges.find(
      (e) => functionIds.has(e.src) && serverIds.has(e.dst)
    );

    assert.ok(funcToServer, 'Should have MAKES_REQUEST edge from FUNCTION to net:tcp-server');
  });
});

describe('SocketAnalyzer - fixture integration (REG-432)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should detect all socket types from fixture 10-socket-connections', async () => {
    const fixtureDir = join(process.cwd(), 'test/fixtures/10-socket-connections');

    const orchestrator = createTestOrchestrator(backend, {
      forceAnalysis: true,
      extraPlugins: [new SocketAnalyzer()]
    });
    await orchestrator.run(fixtureDir);

    // Check Unix socket clients
    const unixSockets = await findNodesByType(backend, 'os:unix-socket');
    assert.ok(
      unixSockets.length >= 2,
      `Should detect at least 2 os:unix-socket nodes from unix-client.js. Found: ${unixSockets.length}`
    );

    // Check TCP connection clients
    const tcpConns = await findNodesByType(backend, 'net:tcp-connection');
    assert.ok(
      tcpConns.length >= 2,
      `Should detect at least 2 net:tcp-connection nodes from tcp-client.js. Found: ${tcpConns.length}`
    );

    // Check Unix socket servers
    const unixServers = await findNodesByType(backend, 'os:unix-server');
    assert.ok(
      unixServers.length >= 1,
      `Should detect at least 1 os:unix-server node from unix-server.js. Found: ${unixServers.length}`
    );

    // Check TCP servers
    const tcpServers = await findNodesByType(backend, 'net:tcp-server');
    assert.ok(
      tcpServers.length >= 2,
      `Should detect at least 2 net:tcp-server nodes from tcp-server.js. Found: ${tcpServers.length}`
    );
  });
});

describe('SocketAnalyzer - no false positives (REG-432)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should not detect socket nodes in file without net module', async () => {
    await setupTest(backend, {
      'index.js': `
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Hello');
});
server.listen(3000);
      `
    });

    const unixSockets = await findNodesByType(backend, 'os:unix-socket');
    const unixServers = await findNodesByType(backend, 'os:unix-server');
    const tcpConns = await findNodesByType(backend, 'net:tcp-connection');
    const tcpServers = await findNodesByType(backend, 'net:tcp-server');

    assert.strictEqual(unixSockets.length, 0, 'Should not detect os:unix-socket nodes');
    assert.strictEqual(unixServers.length, 0, 'Should not detect os:unix-server nodes');
    assert.strictEqual(tcpConns.length, 0, 'Should not detect net:tcp-connection nodes');
    assert.strictEqual(tcpServers.length, 0, 'Should not detect net:tcp-server nodes');
  });

  it('should not create socket nodes for non-net connect calls', async () => {
    await setupTest(backend, {
      'index.js': `
const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/mydb');
      `
    });

    const unixSockets = await findNodesByType(backend, 'os:unix-socket');
    const tcpConns = await findNodesByType(backend, 'net:tcp-connection');

    assert.strictEqual(unixSockets.length, 0, 'Should not detect mongoose.connect as os:unix-socket');
    assert.strictEqual(tcpConns.length, 0, 'Should not detect mongoose.connect as net:tcp-connection');
  });
});
