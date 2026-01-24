/**
 * RFDBServerBackend Data Persistence Test (REG-181)
 *
 * Verifies that data written by one RFDBServerBackend instance persists
 * after that backend closes, and is visible to a second backend instance
 * connecting to the same database.
 *
 * This is the core use case for MCP: CLI analyzes, MCP queries.
 * The bug was that close() killed the server, losing in-memory data.
 *
 * Key behaviors tested:
 * 1. Data persists after first backend closes
 * 2. Second backend sees the same data
 * 3. Node count > 1 (not just the SERVICE node)
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { RFDBServerBackend } from '@grafema/core';

let testCounter = 0;

/**
 * Create unique test paths for each test run
 */
function createTestPaths() {
  const testId = `data-persist-${Date.now()}-${testCounter++}`;
  const testDir = join(tmpdir(), `.grafema-test-${testId}`);
  const dbPath = join(testDir, 'graph.rfdb');
  const socketPath = join(testDir, 'rfdb.sock');

  mkdirSync(testDir, { recursive: true });

  return { testDir, dbPath, socketPath };
}

/**
 * Kill any RFDB server using the given socket path
 */
async function killServerBySocket(socketPath) {
  if (existsSync(socketPath)) {
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // Ignore
    }
  }
}

describe('RFDBServerBackend Data Persistence (REG-181)', () => {
  let testPaths;

  before(() => {
    testPaths = createTestPaths();
  });

  after(async () => {
    // Cleanup test directory
    if (testPaths?.testDir) {
      try {
        rmSync(testPaths.testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should preserve data between backend instances (simulates CLI -> MCP)', async () => {
    const { dbPath, socketPath } = testPaths;

    // =========================================================================
    // STEP 1: First backend writes data (simulates CLI analyze)
    // =========================================================================
    const backend1 = new RFDBServerBackend({ dbPath, socketPath });
    await backend1.connect();

    // Add multiple nodes (not just one, per Linus's feedback)
    await backend1.addNodes([
      { id: 'func:hello', type: 'FUNCTION', name: 'hello', file: 'test.js' },
      { id: 'func:world', type: 'FUNCTION', name: 'world', file: 'test.js' },
      { id: 'var:x', type: 'VARIABLE', name: 'x', file: 'test.js' },
      { id: 'class:MyClass', type: 'CLASS', name: 'MyClass', file: 'test.js' },
    ]);

    await backend1.addEdges([
      { src: 'func:hello', dst: 'func:world', type: 'CALLS' },
      { src: 'class:MyClass', dst: 'func:hello', type: 'CONTAINS' },
    ]);

    // Explicit flush (as CLI does)
    await backend1.flush();

    const nodeCountBeforeClose = await backend1.nodeCount();
    const edgeCountBeforeClose = await backend1.edgeCount();

    // Verify data was written
    assert.strictEqual(nodeCountBeforeClose, 4, 'Should have 4 nodes before close');
    assert.strictEqual(edgeCountBeforeClose, 2, 'Should have 2 edges before close');

    // =========================================================================
    // STEP 2: First backend closes (simulates CLI exiting)
    // =========================================================================
    await backend1.close();

    // =========================================================================
    // STEP 3: Second backend connects (simulates MCP starting)
    // =========================================================================
    const backend2 = new RFDBServerBackend({ dbPath, socketPath });
    await backend2.connect();

    // =========================================================================
    // STEP 4: Verify data is still there
    // =========================================================================
    const nodeCountAfterReconnect = await backend2.nodeCount();
    const edgeCountAfterReconnect = await backend2.edgeCount();

    // The bug: nodeCount would be 0 or 1 (only SERVICE node) because
    // backend1.close() killed the server, losing in-memory data

    // Per Linus's feedback: assert > 1, not just > 0
    assert.ok(
      nodeCountAfterReconnect > 1,
      `Expected more than 1 node after reconnect, got ${nodeCountAfterReconnect}. ` +
      `This indicates the server was killed on close(), losing data.`
    );

    assert.strictEqual(
      nodeCountAfterReconnect,
      nodeCountBeforeClose,
      `Node count should match: before=${nodeCountBeforeClose}, after=${nodeCountAfterReconnect}`
    );

    assert.strictEqual(
      edgeCountAfterReconnect,
      edgeCountBeforeClose,
      `Edge count should match: before=${edgeCountBeforeClose}, after=${edgeCountAfterReconnect}`
    );

    // =========================================================================
    // STEP 5: Verify specific nodes are queryable
    // =========================================================================
    const functions = [];
    for await (const node of backend2.queryNodes({ nodeType: 'FUNCTION' })) {
      functions.push(node);
    }

    assert.strictEqual(functions.length, 2, 'Should find 2 FUNCTION nodes');

    const functionNames = functions.map(f => f.name).sort();
    assert.deepStrictEqual(functionNames, ['hello', 'world'], 'Should find hello and world functions');

    // =========================================================================
    // STEP 6: Cleanup - close second backend
    // =========================================================================
    await backend2.close();
  });

  it('should allow multiple sequential connect/close cycles', async () => {
    // Create fresh paths for this test
    const paths = createTestPaths();
    const { dbPath, socketPath } = paths;

    try {
      // First cycle: write data
      const backend1 = new RFDBServerBackend({ dbPath, socketPath });
      await backend1.connect();
      await backend1.addNodes([
        { id: 'node:1', type: 'FUNCTION', name: 'fn1', file: 'a.js' },
        { id: 'node:2', type: 'FUNCTION', name: 'fn2', file: 'a.js' },
      ]);
      await backend1.flush();
      await backend1.close();

      // Second cycle: add more data
      const backend2 = new RFDBServerBackend({ dbPath, socketPath });
      await backend2.connect();
      const countAfterFirst = await backend2.nodeCount();
      assert.strictEqual(countAfterFirst, 2, 'Should see 2 nodes from first cycle');

      await backend2.addNodes([
        { id: 'node:3', type: 'FUNCTION', name: 'fn3', file: 'b.js' },
      ]);
      await backend2.flush();
      await backend2.close();

      // Third cycle: verify all data
      const backend3 = new RFDBServerBackend({ dbPath, socketPath });
      await backend3.connect();
      const finalCount = await backend3.nodeCount();

      // Per Linus's feedback: assert > 1
      assert.ok(finalCount > 1, `Expected > 1 nodes, got ${finalCount}`);
      assert.strictEqual(finalCount, 3, 'Should see all 3 nodes after multiple cycles');

      await backend3.close();
    } finally {
      // Cleanup
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  });
});
