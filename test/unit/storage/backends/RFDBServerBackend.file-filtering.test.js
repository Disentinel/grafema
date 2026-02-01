/**
 * RFDBServerBackend File Filtering Test (REG-308)
 *
 * Verifies that server-side file filtering in queryNodes() works correctly.
 * Previously, file filtering had issues requiring client-side workarounds.
 *
 * Key behaviors tested:
 * 1. queryNodes({ file: path }) returns only nodes for that file
 * 2. Combined filters (type + file) work correctly
 * 3. File filtering works after flush (segment data)
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { RFDBServerBackend } from '@grafema/core';

let testCounter = 0;

/**
 * Create unique test paths for each test run
 */
function createTestPaths() {
  const testId = `file-filter-${Date.now()}-${testCounter++}`;
  const testDir = join(tmpdir(), `.grafema-test-${testId}`);
  const dbPath = join(testDir, 'graph.rfdb');
  const socketPath = join(testDir, 'rfdb.sock');

  mkdirSync(testDir, { recursive: true });

  return { testDir, dbPath, socketPath };
}

describe('RFDBServerBackend File Filtering (REG-308)', () => {
  let testPaths;
  let backend;

  before(async () => {
    testPaths = createTestPaths();
    backend = new RFDBServerBackend({
      dbPath: testPaths.dbPath,
      socketPath: testPaths.socketPath
    });
    await backend.connect();
  });

  after(async () => {
    if (backend?.connected) {
      await backend.close();
    }
    // Cleanup test directory
    if (testPaths?.testDir) {
      try {
        rmSync(testPaths.testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should filter nodes by file path (delta/unflushed)', async () => {
    // Add nodes in different files
    await backend.addNodes([
      { id: 'func:a:utils', type: 'FUNCTION', name: 'funcA', file: 'src/utils.js' },
      { id: 'func:b:utils', type: 'FUNCTION', name: 'funcB', file: 'src/utils.js' },
      { id: 'func:c:other', type: 'FUNCTION', name: 'funcC', file: 'src/other.js' },
      { id: 'var:x:utils', type: 'VARIABLE', name: 'x', file: 'src/utils.js' },
    ]);

    // Query for nodes in src/utils.js
    const utilsNodes = [];
    for await (const node of backend.queryNodes({ file: 'src/utils.js' })) {
      utilsNodes.push(node);
    }

    // Should find 3 nodes in src/utils.js
    assert.strictEqual(utilsNodes.length, 3, `Expected 3 nodes in src/utils.js, got ${utilsNodes.length}`);

    // Verify all returned nodes are from the correct file
    for (const node of utilsNodes) {
      assert.strictEqual(
        node.file,
        'src/utils.js',
        `Node ${node.id} has wrong file: ${node.file}`
      );
    }

    // Query for nodes in src/other.js
    const otherNodes = [];
    for await (const node of backend.queryNodes({ file: 'src/other.js' })) {
      otherNodes.push(node);
    }

    assert.strictEqual(otherNodes.length, 1, `Expected 1 node in src/other.js, got ${otherNodes.length}`);
    assert.strictEqual(otherNodes[0].name, 'funcC');
  });

  it('should filter nodes by file path combined with type', async () => {
    // Query for FUNCTION nodes in src/utils.js
    const functions = [];
    for await (const node of backend.queryNodes({ nodeType: 'FUNCTION', file: 'src/utils.js' })) {
      functions.push(node);
    }

    // Should find 2 FUNCTION nodes in src/utils.js (funcA and funcB)
    assert.strictEqual(functions.length, 2, `Expected 2 FUNCTION nodes in src/utils.js, got ${functions.length}`);

    const names = functions.map(n => n.name).sort();
    assert.deepStrictEqual(names, ['funcA', 'funcB']);
  });

  it('should filter nodes by file path after flush (segment data)', async () => {
    // Flush data to disk
    await backend.flush();

    // Query for nodes in src/utils.js (now from segment)
    const utilsNodes = [];
    for await (const node of backend.queryNodes({ file: 'src/utils.js' })) {
      utilsNodes.push(node);
    }

    // Should still find 3 nodes in src/utils.js
    assert.strictEqual(utilsNodes.length, 3, `Expected 3 nodes in src/utils.js after flush, got ${utilsNodes.length}`);

    // Verify all returned nodes are from the correct file
    for (const node of utilsNodes) {
      assert.strictEqual(
        node.file,
        'src/utils.js',
        `Node ${node.id} has wrong file after flush: ${node.file}`
      );
    }
  });

  it('should return empty result for non-existent file', async () => {
    const nodes = [];
    for await (const node of backend.queryNodes({ file: 'src/nonexistent.js' })) {
      nodes.push(node);
    }

    assert.strictEqual(nodes.length, 0, 'Should return no nodes for non-existent file');
  });
});
