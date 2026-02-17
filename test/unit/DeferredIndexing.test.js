/**
 * Deferred Indexing Tests (REG-487)
 *
 * Verifies the deferred indexing mode for bulk loads:
 * 1. commitBatch with deferIndex=true writes data but skips index rebuild
 * 2. rebuildIndexes() rebuilds secondary indexes after deferred commits
 * 3. Default behavior (deferIndex unset) still rebuilds indexes immediately
 * 4. Multiple deferred commits followed by single rebuild
 * 5. rebuildIndexes on empty graph is a safe no-op
 * 6. rebuildIndexes is idempotent
 *
 * Note: The observable effect of deferIndex depends on the engine type.
 * V2 engine (used by ephemeral test databases) falls back to full flush,
 * so deferred indexing has no observable effect on query results.
 * These tests verify the protocol plumbing works correctly: commands are
 * accepted, no errors are thrown, and data is persisted regardless.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

describe('Deferred Indexing (REG-487)', () => {
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

  describe('commitBatch with deferIndex=true', () => {
    it('should accept deferIndex=true and persist data', async () => {
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'fn-1', nodeType: 'FUNCTION', name: 'hello', file: 'test.js', exported: false, metadata: '{}' },
        { id: 'fn-2', nodeType: 'FUNCTION', name: 'world', file: 'test.js', exported: true, metadata: '{}' },
      ]);
      const delta = await backend.client.commitBatch(['test-tag'], true);

      // Data should be committed (delta reflects what was added)
      assert.ok(delta, 'commitBatch should return a delta');
      assert.strictEqual(delta.nodesAdded, 2, 'Should report 2 nodes added');
      assert.deepStrictEqual(delta.changedFiles, ['test.js'], 'Should report changed files');

      // Nodes should be retrievable (V2 engine does full flush regardless)
      const count = await backend.nodeCount();
      assert.strictEqual(count, 2, 'Should have 2 nodes after deferred commit');
    });

    it('should persist edges with deferIndex=true', async () => {
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'fn-a', nodeType: 'FUNCTION', name: 'fnA', file: 'a.js', exported: false, metadata: '{}' },
        { id: 'fn-b', nodeType: 'FUNCTION', name: 'fnB', file: 'a.js', exported: false, metadata: '{}' },
      ]);
      await backend.client.addEdges([
        { src: 'fn-a', dst: 'fn-b', edgeType: 'CALLS', metadata: '{}' },
      ]);
      const delta = await backend.client.commitBatch(['test-edges'], true);

      assert.strictEqual(delta.nodesAdded, 2, 'Should add 2 nodes');
      assert.strictEqual(delta.edgesAdded, 1, 'Should add 1 edge');

      const edgeCount = await backend.edgeCount();
      assert.strictEqual(edgeCount, 1, 'Should have 1 edge after deferred commit');
    });
  });

  describe('rebuildIndexes', () => {
    it('should succeed after deferred commits', async () => {
      // Commit data with deferred indexing
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'mod-1', nodeType: 'MODULE', name: 'app', file: 'app.js', exported: false, metadata: '{}' },
      ]);
      await backend.client.commitBatch(['indexing'], true);

      // Rebuild should succeed without error
      await backend.client.rebuildIndexes();

      // Data should be queryable
      const count = await backend.nodeCount();
      assert.strictEqual(count, 1, 'Node should be queryable after rebuild');
    });

    it('should be idempotent — calling twice produces same result', async () => {
      // Add data with deferred indexing
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'cls-1', nodeType: 'CLASS', name: 'MyClass', file: 'cls.ts', exported: true, metadata: '{}' },
        { id: 'fn-ctor', nodeType: 'FUNCTION', name: 'constructor', file: 'cls.ts', exported: false, metadata: '{}' },
      ]);
      await backend.client.addEdges([
        { src: 'cls-1', dst: 'fn-ctor', edgeType: 'HAS_METHOD', metadata: '{}' },
      ]);
      await backend.client.commitBatch(['analysis'], true);

      // First rebuild
      await backend.client.rebuildIndexes();
      const count1 = await backend.nodeCount();
      const edgeCount1 = await backend.edgeCount();

      // Second rebuild — should produce identical results
      await backend.client.rebuildIndexes();
      const count2 = await backend.nodeCount();
      const edgeCount2 = await backend.edgeCount();

      assert.strictEqual(count2, count1, 'Node count should be identical after second rebuild');
      assert.strictEqual(edgeCount2, edgeCount1, 'Edge count should be identical after second rebuild');
    });

    it('should be a safe no-op on empty graph', async () => {
      // Empty graph — rebuildIndexes should not throw
      await backend.client.rebuildIndexes();

      const count = await backend.nodeCount();
      assert.strictEqual(count, 0, 'Empty graph should remain empty after rebuild');
    });
  });

  describe('Default behavior (no deferIndex)', () => {
    it('should rebuild indexes immediately when deferIndex is not set', async () => {
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'var-1', nodeType: 'VARIABLE', name: 'x', file: 'vars.js', exported: false, metadata: '{}' },
        { id: 'var-2', nodeType: 'VARIABLE', name: 'y', file: 'vars.js', exported: false, metadata: '{}' },
      ]);
      const delta = await backend.client.commitBatch(['normal-commit']);

      // Should work exactly as before — data queryable immediately
      assert.strictEqual(delta.nodesAdded, 2, 'Should add 2 nodes');

      const count = await backend.nodeCount();
      assert.strictEqual(count, 2, 'Nodes should be queryable immediately without rebuildIndexes');
    });

    it('should rebuild indexes immediately when deferIndex=false', async () => {
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'imp-1', nodeType: 'IMPORT', name: 'React', file: 'app.jsx', exported: false, metadata: '{}' },
      ]);
      const delta = await backend.client.commitBatch(['import-commit'], false);

      assert.strictEqual(delta.nodesAdded, 1, 'Should add 1 node');

      const count = await backend.nodeCount();
      assert.strictEqual(count, 1, 'Node should be queryable immediately with deferIndex=false');
    });
  });

  describe('Multiple deferred commits then rebuild', () => {
    it('should handle multiple deferred commits followed by single rebuild', async () => {
      // Commit 1: modules
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'mod-a', nodeType: 'MODULE', name: 'moduleA', file: 'a.js', exported: false, metadata: '{}' },
        { id: 'mod-b', nodeType: 'MODULE', name: 'moduleB', file: 'b.js', exported: false, metadata: '{}' },
      ]);
      await backend.client.commitBatch(['indexing-1'], true);

      // Commit 2: functions
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'fn-x', nodeType: 'FUNCTION', name: 'fnX', file: 'a.js', exported: true, metadata: '{}' },
        { id: 'fn-y', nodeType: 'FUNCTION', name: 'fnY', file: 'b.js', exported: false, metadata: '{}' },
      ]);
      await backend.client.addEdges([
        { src: 'fn-x', dst: 'fn-y', edgeType: 'CALLS', metadata: '{}' },
      ]);
      await backend.client.commitBatch(['analysis-1'], true);

      // Commit 3: more edges
      backend.client.beginBatch();
      await backend.client.addEdges([
        { src: 'mod-a', dst: 'fn-x', edgeType: 'CONTAINS', metadata: '{}' },
        { src: 'mod-b', dst: 'fn-y', edgeType: 'CONTAINS', metadata: '{}' },
      ]);
      await backend.client.commitBatch(['analysis-2'], true);

      // Single rebuild after all deferred commits
      await backend.client.rebuildIndexes();

      // All data should be queryable
      const nodeCount = await backend.nodeCount();
      const edgeCount = await backend.edgeCount();

      assert.strictEqual(nodeCount, 4, 'Should have 4 nodes (2 modules + 2 functions)');
      assert.strictEqual(edgeCount, 3, 'Should have 3 edges (1 CALLS + 2 CONTAINS)');
    });
  });

  describe('Backend-level API', () => {
    it('should expose rebuildIndexes on RFDBServerBackend via TestDatabaseBackend', async () => {
      // The backend.client is the underlying RFDBClient, which has rebuildIndexes
      assert.strictEqual(typeof backend.client.rebuildIndexes, 'function',
        'RFDBClient should have rebuildIndexes method');
    });

    it('should support deferIndex parameter on commitBatch', async () => {
      // Verify the commitBatch signature accepts deferIndex
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'test-n', nodeType: 'FUNCTION', name: 'test', file: 't.js', exported: false, metadata: '{}' },
      ]);

      // Should not throw with deferIndex as third positional concept
      // (actually second arg after tags)
      const delta = await backend.client.commitBatch(['tag'], true);
      assert.ok(delta, 'Should return delta with deferIndex=true');
    });
  });
});
