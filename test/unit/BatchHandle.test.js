/**
 * BatchHandle Tests (REG-487)
 *
 * Verifies the isolated batch handle for concurrent-safe batching:
 * 1. createBatch() returns a BatchHandle with own buffers
 * 2. Two concurrent handles don't interfere with each other
 * 3. BatchHandle.abort() discards buffered data
 * 4. BatchHandle.commit() on empty handle is a safe no-op
 * 5. BatchHandle doesn't affect instance-level beginBatch/commitBatch
 * 6. BatchHandle supports deferIndex parameter
 *
 * BatchHandle solves the race condition where multiple workers using
 * the same RFDBClient instance would clobber each other's shared
 * _batching/_batchNodes/_batchEdges state.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

describe('BatchHandle (REG-487)', () => {
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

  describe('createBatch', () => {
    it('should return a BatchHandle instance', () => {
      const handle = backend.client.createBatch();
      assert.ok(handle, 'createBatch should return a handle');
      assert.strictEqual(typeof handle.addNode, 'function', 'Handle should have addNode method');
      assert.strictEqual(typeof handle.addEdge, 'function', 'Handle should have addEdge method');
      assert.strictEqual(typeof handle.addFile, 'function', 'Handle should have addFile method');
      assert.strictEqual(typeof handle.commit, 'function', 'Handle should have commit method');
      assert.strictEqual(typeof handle.abort, 'function', 'Handle should have abort method');

      // Cleanup: abort the handle so it doesn't hold state
      handle.abort();
    });

    it('should not affect client batching state', () => {
      const handle = backend.client.createBatch();

      // Creating a BatchHandle should NOT put client into batching mode
      assert.strictEqual(backend.client.isBatching(), false,
        'Client should not be in batching mode after createBatch');

      handle.abort();
    });
  });

  describe('BatchHandle.commit', () => {
    it('should commit nodes and edges to the server', async () => {
      const handle = backend.client.createBatch();

      handle.addNode({
        id: 'fn-1', nodeType: 'FUNCTION', name: 'hello',
        file: 'test.js', exported: false, metadata: '{}',
      });
      handle.addNode({
        id: 'fn-2', nodeType: 'FUNCTION', name: 'world',
        file: 'test.js', exported: true, metadata: '{}',
      });
      handle.addEdge({
        src: 'fn-1', dst: 'fn-2', edgeType: 'CALLS', metadata: '{}',
      });

      const delta = await handle.commit(['batch-test']);
      assert.ok(delta, 'commit should return a delta');
      assert.strictEqual(delta.nodesAdded, 2, 'Should add 2 nodes');
      assert.strictEqual(delta.edgesAdded, 1, 'Should add 1 edge');

      // Verify data is persisted
      const nodeCount = await backend.nodeCount();
      const edgeCount = await backend.edgeCount();
      assert.strictEqual(nodeCount, 2, 'Should have 2 nodes');
      assert.strictEqual(edgeCount, 1, 'Should have 1 edge');
    });

    it('should support deferIndex parameter', async () => {
      const handle = backend.client.createBatch();

      handle.addNode({
        id: 'mod-1', nodeType: 'MODULE', name: 'app',
        file: 'app.js', exported: false, metadata: '{}',
      });

      // commit with deferIndex=true should not throw
      const delta = await handle.commit(['indexing'], true);
      assert.ok(delta, 'commit with deferIndex should return a delta');
      assert.strictEqual(delta.nodesAdded, 1, 'Should add 1 node');

      // rebuildIndexes should succeed
      await backend.client.rebuildIndexes();

      const count = await backend.nodeCount();
      assert.strictEqual(count, 1, 'Node should exist after rebuild');
    });

    it('should handle empty commit gracefully', async () => {
      const handle = backend.client.createBatch();

      // Commit with nothing in the handle
      const delta = await handle.commit(['empty-batch']);
      assert.ok(delta, 'Empty commit should still return a delta');
      assert.strictEqual(delta.nodesAdded, 0, 'Should add 0 nodes');
      assert.strictEqual(delta.edgesAdded, 0, 'Should add 0 edges');
    });

    it('should clear buffers after commit', async () => {
      const handle = backend.client.createBatch();

      handle.addNode({
        id: 'fn-once', nodeType: 'FUNCTION', name: 'once',
        file: 'once.js', exported: false, metadata: '{}',
      });

      // First commit
      const delta1 = await handle.commit(['first']);
      assert.strictEqual(delta1.nodesAdded, 1, 'First commit should add 1 node');

      // Second commit on same handle — should be empty (buffers cleared)
      const delta2 = await handle.commit(['second']);
      assert.strictEqual(delta2.nodesAdded, 0, 'Second commit should add 0 nodes (buffers cleared)');
    });
  });

  describe('BatchHandle.abort', () => {
    it('should discard all buffered data', async () => {
      const handle = backend.client.createBatch();

      handle.addNode({
        id: 'fn-discard', nodeType: 'FUNCTION', name: 'discard',
        file: 'discard.js', exported: false, metadata: '{}',
      });
      handle.addEdge({
        src: 'fn-discard', dst: 'fn-discard', edgeType: 'CALLS', metadata: '{}',
      });

      // Abort discards everything
      handle.abort();

      // Commit after abort should be empty
      const delta = await handle.commit(['after-abort']);
      assert.strictEqual(delta.nodesAdded, 0, 'Should add 0 nodes after abort');
      assert.strictEqual(delta.edgesAdded, 0, 'Should add 0 edges after abort');

      // Graph should be empty
      const count = await backend.nodeCount();
      assert.strictEqual(count, 0, 'Graph should be empty — aborted data not committed');
    });
  });

  describe('Concurrent handles (isolation)', () => {
    it('should allow two handles to buffer independently', async () => {
      const handleA = backend.client.createBatch();
      const handleB = backend.client.createBatch();

      // Worker A adds modules
      handleA.addNode({
        id: 'mod-a', nodeType: 'MODULE', name: 'modA',
        file: 'a.js', exported: false, metadata: '{}',
      });
      handleA.addFile('a.js');

      // Worker B adds functions
      handleB.addNode({
        id: 'fn-b', nodeType: 'FUNCTION', name: 'fnB',
        file: 'b.js', exported: true, metadata: '{}',
      });
      handleB.addFile('b.js');

      // Commit A
      const deltaA = await handleA.commit(['worker-a']);
      assert.strictEqual(deltaA.nodesAdded, 1, 'Handle A should add 1 node');
      assert.deepStrictEqual(deltaA.changedFiles, ['a.js'], 'Handle A should report a.js');

      // Commit B — should be independent of A
      const deltaB = await handleB.commit(['worker-b']);
      assert.strictEqual(deltaB.nodesAdded, 1, 'Handle B should add 1 node');
      assert.deepStrictEqual(deltaB.changedFiles, ['b.js'], 'Handle B should report b.js');

      // Both should be in the graph
      const count = await backend.nodeCount();
      assert.strictEqual(count, 2, 'Both handles should contribute to the graph');
    });

    it('should not clobber data when one handle aborts', async () => {
      const handleKeep = backend.client.createBatch();
      const handleDiscard = backend.client.createBatch();

      // Add data to both
      handleKeep.addNode({
        id: 'fn-keep', nodeType: 'FUNCTION', name: 'keep',
        file: 'keep.js', exported: false, metadata: '{}',
      });
      handleDiscard.addNode({
        id: 'fn-discard', nodeType: 'FUNCTION', name: 'discard',
        file: 'discard.js', exported: false, metadata: '{}',
      });

      // Abort one, commit the other
      handleDiscard.abort();
      const delta = await handleKeep.commit(['kept']);

      assert.strictEqual(delta.nodesAdded, 1, 'Should add only the kept node');

      const count = await backend.nodeCount();
      assert.strictEqual(count, 1, 'Only the committed handle should contribute data');
    });
  });

  describe('BatchHandle does not affect instance-level batching', () => {
    it('should coexist with beginBatch/commitBatch', async () => {
      // Start instance-level batch
      backend.client.beginBatch();
      await backend.client.addNodes([
        { id: 'inst-1', nodeType: 'VARIABLE', name: 'instVar', file: 'inst.js', exported: false, metadata: '{}' },
      ]);

      // Create a handle while instance batch is active
      const handle = backend.client.createBatch();
      handle.addNode({
        id: 'handle-1', nodeType: 'FUNCTION', name: 'handleFn',
        file: 'handle.js', exported: false, metadata: '{}',
      });

      // Commit the handle — should not affect instance batch
      const handleDelta = await handle.commit(['handle-commit']);
      assert.strictEqual(handleDelta.nodesAdded, 1, 'Handle should add 1 node');

      // Instance batch should still be active
      assert.strictEqual(backend.client.isBatching(), true,
        'Instance-level batch should still be active after handle commit');

      // Commit instance batch
      const instDelta = await backend.client.commitBatch(['instance-commit']);
      assert.strictEqual(instDelta.nodesAdded, 1, 'Instance batch should add 1 node');

      // Both contributions should be in the graph
      const count = await backend.nodeCount();
      assert.strictEqual(count, 2, 'Both handle and instance batch should contribute data');
    });
  });

  describe('addFile method', () => {
    it('should track files for changedFiles in delta', async () => {
      const handle = backend.client.createBatch();

      // Add nodes without files, but manually track files
      handle.addNode({
        id: 'fn-nofile', nodeType: 'FUNCTION', name: 'noFile',
        file: '', exported: false, metadata: '{}',
      });
      handle.addFile('manual.js');

      const delta = await handle.commit(['file-tracking']);
      assert.ok(delta.changedFiles.includes('manual.js'),
        'changedFiles should include manually added file');
    });

    it('should auto-track file from node', async () => {
      const handle = backend.client.createBatch();

      handle.addNode({
        id: 'fn-auto', nodeType: 'FUNCTION', name: 'autoFile',
        file: 'auto.js', exported: false, metadata: '{}',
      });

      const delta = await handle.commit(['auto-file']);
      assert.ok(delta.changedFiles.includes('auto.js'),
        'changedFiles should include file from node');
    });
  });
});
