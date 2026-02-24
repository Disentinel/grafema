/**
 * Test: RFDB Client Request ID Protocol (RFD-3)
 *
 * Tests requestId echo, concurrent request matching, and timeout isolation.
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'child_process';
import { existsSync, rmSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { setTimeout as sleep } from 'timers/promises';
import { createConnection } from 'net';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { encode, decode } = require('../../packages/rfdb/node_modules/@msgpack/msgpack');

import { RFDBClient } from '@grafema/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testDir = mkdtempSync(join(tmpdir(), 'rfdb-reqid-'));
const TEST_DB_PATH = join(testDir, 'graph.rfdb');
const TEST_SOCKET_PATH = join(testDir, 'rfdb.sock');
const SERVER_BINARY = join(__dirname, '../../packages/rfdb-server/target/debug/rfdb-server');

describe('RFDB Request IDs (RFD-3)', () => {
  let serverProcess = null;
  let client = null;

  before(async () => {
    if (!existsSync(SERVER_BINARY)) {
      const { execSync } = await import('child_process');
      execSync('cargo build --bin rfdb-server', {
        cwd: join(__dirname, '../../packages/rfdb-server'),
        stdio: 'inherit'
      });
    }

    serverProcess = spawn(SERVER_BINARY, [TEST_DB_PATH, '--socket', TEST_SOCKET_PATH], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stderr.on('data', (data) => {
      // Suppress server logs unless debugging
    });

    await sleep(1500);
    assert.ok(existsSync(TEST_SOCKET_PATH), 'Server socket should exist');

    client = new RFDBClient(TEST_SOCKET_PATH);
    await client.connect();
  });

  after(async () => {
    if (client) {
      try { await client.shutdown(); } catch { /* Expected */ }
    }
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(500);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should echo requestId in response', async () => {
    // Use raw socket to verify the wire protocol includes requestId
    const result = await rawRequest(TEST_SOCKET_PATH, {
      cmd: 'ping',
      requestId: 'r42',
    });
    assert.strictEqual(result.requestId, 'r42', 'Response should echo requestId');
    assert.ok(result.pong, 'Ping should succeed');
  });

  it('should omit requestId when not sent', async () => {
    // Verify server doesn't inject requestId if client didn't send one
    const result = await rawRequest(TEST_SOCKET_PATH, { cmd: 'ping' });
    assert.strictEqual(result.requestId, undefined, 'Response should not have requestId');
    assert.ok(result.pong, 'Ping should succeed');
  });

  it('should match concurrent requests correctly', async () => {
    // Set up test data
    await client.addNodes([
      { id: 'RID#1', type: 'FUNCTION', name: 'alpha', file: 'a.js' },
      { id: 'RID#2', type: 'FUNCTION', name: 'beta', file: 'b.js' },
      { id: 'RID#3', type: 'CLASS', name: 'Gamma', file: 'c.js' },
    ]);

    // Fire 10 requests concurrently — each should get the correct response
    const promises = [
      client.ping(),
      client.nodeCount(),
      client.findByType('FUNCTION'),
      client.findByType('CLASS'),
      client.nodeExists('RID#1'),
      client.nodeExists('NONEXISTENT'),
      client.getNode('RID#1'),
      client.getNode('RID#2'),
      client.edgeCount(),
      client.ping(),
    ];

    const results = await Promise.all(promises);

    // Verify each result matches its expected type
    assert.ok(results[0], 'ping 1 should return version');
    assert.strictEqual(typeof results[1], 'number', 'nodeCount should be number');
    assert.ok(results[1] >= 3, 'nodeCount should be >= 3');
    assert.ok(Array.isArray(results[2]), 'findByType FUNCTION should return array');
    assert.strictEqual(results[2].length, 2, 'Should find 2 FUNCTION nodes');
    assert.ok(Array.isArray(results[3]), 'findByType CLASS should return array');
    assert.strictEqual(results[3].length, 1, 'Should find 1 CLASS node');
    assert.strictEqual(results[4], true, 'RID#1 should exist');
    assert.strictEqual(results[5], false, 'NONEXISTENT should not exist');
    assert.ok(results[6], 'getNode RID#1 should return node');
    assert.strictEqual(results[6].name, 'alpha', 'RID#1 name should be alpha');
    assert.ok(results[7], 'getNode RID#2 should return node');
    assert.strictEqual(results[7].name, 'beta', 'RID#2 name should be beta');
    assert.strictEqual(typeof results[8], 'number', 'edgeCount should be number');
    assert.ok(results[9], 'ping 2 should return version');
  });

  it('should handle rapid sequential requests after concurrent batch', async () => {
    // Verify the client's internal counter and matching work after heavy concurrent use
    for (let i = 0; i < 20; i++) {
      const version = await client.ping();
      assert.ok(version, `Sequential ping ${i} should succeed`);
    }
  });
});

/**
 * Send a raw msgpack request to the server and return the decoded response.
 * This bypasses RFDBClient to test the wire protocol directly.
 */
function rawRequest(socketPath, requestObj) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const msgBytes = encode(requestObj);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(msgBytes.length);

    let buffer = Buffer.alloc(0);

    socket.on('connect', () => {
      socket.write(Buffer.concat([header, Buffer.from(msgBytes)]));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length >= 4 + msgLen) {
          const msgBytes = buffer.subarray(4, 4 + msgLen);
          const response = decode(msgBytes);
          socket.destroy();
          resolve(response);
        }
      }
    });

    socket.on('error', reject);

    setTimeout(() => {
      socket.destroy();
      reject(new Error('Raw request timeout'));
    }, 5000);
  });
}
