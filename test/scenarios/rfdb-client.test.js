/**
 * Test: RFDB Client-Server Communication
 *
 * Tests the RFDBClient connecting to rfdb-server over Unix socket
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'child_process';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { RFDBClient } from '@grafema/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DB_PATH = '/tmp/rfdb-test-db';
const TEST_SOCKET_PATH = '/tmp/rfdb-test.sock';
const SERVER_BINARY = join(__dirname, '../../rust-engine/target/debug/rfdb-server');

describe('RFDB Client-Server', () => {
  let serverProcess = null;
  let client = null;

  before(async () => {
    // Clean up any previous test data
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true });
    }
    if (existsSync(TEST_SOCKET_PATH)) {
      rmSync(TEST_SOCKET_PATH);
    }

    // Check if server binary exists
    if (!existsSync(SERVER_BINARY)) {
      console.log('Building rfdb-server...');
      const { execSync } = await import('child_process');
      execSync('cargo build --bin rfdb-server', {
        cwd: join(__dirname, '../../rust-engine'),
        stdio: 'inherit'
      });
    }

    // Start server
    console.log('Starting rfdb-server...');
    serverProcess = spawn(SERVER_BINARY, [TEST_DB_PATH, '--socket', TEST_SOCKET_PATH], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', (data) => {
      console.log(`[server stdout] ${data.toString().trim()}`);
    });

    serverProcess.stderr.on('data', (data) => {
      console.log(`[server stderr] ${data.toString().trim()}`);
    });

    // Wait for server to start
    await sleep(1000);

    // Verify socket exists
    assert.ok(existsSync(TEST_SOCKET_PATH), 'Server socket should exist');

    // Create client and connect
    client = new RFDBClient(TEST_SOCKET_PATH);
    await client.connect();
    console.log('Client connected');
  });

  after(async () => {
    // Close client
    if (client) {
      try {
        await client.shutdown();
      } catch (e) {
        // Expected
      }
    }

    // Kill server if still running
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(500);
    }

    // Clean up
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true });
    }
    if (existsSync(TEST_SOCKET_PATH)) {
      rmSync(TEST_SOCKET_PATH);
    }
  });

  it('should ping the server', async () => {
    const version = await client.ping();
    console.log('Server version:', version);
    assert.ok(version, 'Should receive server version');
  });

  it('should add and retrieve nodes', async () => {
    // Add nodes
    await client.addNodes([
      { id: 'NODE#1', type: 'FUNCTION', name: 'foo', file: 'test.js' },
      { id: 'NODE#2', type: 'FUNCTION', name: 'bar', file: 'test.js' },
      { id: 'NODE#3', type: 'CLASS', name: 'MyClass', file: 'test.js' },
    ]);

    // Check counts
    const nodeCount = await client.nodeCount();
    assert.strictEqual(nodeCount, 3, 'Should have 3 nodes');

    // Get a node
    const node = await client.getNode('NODE#1');
    assert.ok(node, 'Node should exist');
    assert.strictEqual(node.name, 'foo');
  });

  it('should add and retrieve edges', async () => {
    // Add edges
    await client.addEdges([
      { src: 'NODE#1', dst: 'NODE#2', type: 'CALLS' },
      { src: 'NODE#3', dst: 'NODE#1', type: 'CONTAINS' },
    ]);

    // Check counts
    const edgeCount = await client.edgeCount();
    assert.strictEqual(edgeCount, 2, 'Should have 2 edges');

    // Get outgoing edges
    const outgoing = await client.getOutgoingEdges('NODE#1');
    assert.strictEqual(outgoing.length, 1, 'NODE#1 should have 1 outgoing edge');
  });

  it('should find nodes by type', async () => {
    const functions = await client.findByType('FUNCTION');
    assert.strictEqual(functions.length, 2, 'Should find 2 FUNCTION nodes');

    const classes = await client.findByType('CLASS');
    assert.strictEqual(classes.length, 1, 'Should find 1 CLASS node');
  });

  it('should traverse graph with BFS', async () => {
    const reachable = await client.bfs(['NODE#3'], 2, ['CONTAINS', 'CALLS']);
    console.log('BFS from NODE#3:', reachable);
    assert.ok(reachable.length >= 1, 'Should find reachable nodes');
  });

  it('should count nodes by type', async () => {
    const counts = await client.countNodesByType();
    console.log('Node counts by type:', counts);
    assert.strictEqual(counts['FUNCTION'], 2);
    assert.strictEqual(counts['CLASS'], 1);
  });

  it('should flush data', async () => {
    const result = await client.flush();
    assert.ok(result.ok, 'Flush should succeed');
  });
});
