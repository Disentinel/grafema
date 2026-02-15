/**
 * Integration test: concurrent TS clients against the same RFDB server.
 *
 * Validates that two independent clients can:
 * - Open separate ephemeral databases on the same server
 * - Run independent batch commits without interference
 * - Each see only their own data (database isolation)
 * - Operate concurrently (parallel addNodes, flush, queries)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, cleanupAllTestDatabases } from '../../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);

describe('concurrent RFDB clients', () => {
  it('two clients see independent data in separate databases', async () => {
    const db1 = await createTestDatabase();
    const db2 = await createTestDatabase();

    // Client 1 adds functions
    await db1.backend.addNodes([
      { id: 'fn-alpha', type: 'FUNCTION', name: 'alpha', file: 'src/a.js' },
      { id: 'fn-beta', type: 'FUNCTION', name: 'beta', file: 'src/a.js' },
    ]);

    // Client 2 adds classes
    await db2.backend.addNodes([
      { id: 'cls-Foo', type: 'CLASS', name: 'Foo', file: 'src/b.js' },
      { id: 'cls-Bar', type: 'CLASS', name: 'Bar', file: 'src/b.js' },
      { id: 'cls-Baz', type: 'CLASS', name: 'Baz', file: 'src/c.js' },
    ]);

    // Each client sees only its own data
    const count1 = await db1.backend.nodeCount();
    const count2 = await db2.backend.nodeCount();

    assert.equal(count1, 2, 'client 1 should see 2 nodes');
    assert.equal(count2, 3, 'client 2 should see 3 nodes');

    // Type queries are isolated
    const fns = await db1.backend.findByType('FUNCTION');
    const classes = await db2.backend.findByType('CLASS');

    assert.equal(fns.length, 2, 'client 1 should find 2 functions');
    assert.equal(classes.length, 3, 'client 2 should find 3 classes');

    // Cross-check: client 1 should not see client 2's classes
    const classesInDb1 = await db1.backend.findByType('CLASS');
    assert.equal(classesInDb1.length, 0, 'client 1 should see 0 classes');

    // Cross-check: client 2 should not see client 1's functions
    const fnsInDb2 = await db2.backend.findByType('FUNCTION');
    assert.equal(fnsInDb2.length, 0, 'client 2 should see 0 functions');

    await db1.cleanup();
    await db2.cleanup();
  });

  it('parallel operations do not interfere', async () => {
    const db1 = await createTestDatabase();
    const db2 = await createTestDatabase();

    // Run addNodes in parallel on both clients
    await Promise.all([
      db1.backend.addNodes([
        { id: 'p1-a', type: 'FUNCTION', name: 'a', file: 'src/x.js' },
        { id: 'p1-b', type: 'FUNCTION', name: 'b', file: 'src/x.js' },
      ]),
      db2.backend.addNodes([
        { id: 'p2-a', type: 'FUNCTION', name: 'a', file: 'src/y.js' },
        { id: 'p2-b', type: 'FUNCTION', name: 'b', file: 'src/y.js' },
        { id: 'p2-c', type: 'FUNCTION', name: 'c', file: 'src/y.js' },
      ]),
    ]);

    // Add edges in parallel
    await Promise.all([
      db1.backend.addEdges([
        { src: 'p1-a', dst: 'p1-b', type: 'CALLS' },
      ]),
      db2.backend.addEdges([
        { src: 'p2-a', dst: 'p2-b', type: 'CALLS' },
        { src: 'p2-b', dst: 'p2-c', type: 'CALLS' },
      ]),
    ]);

    // Verify counts in parallel
    const [count1, count2, edgeCount1, edgeCount2] = await Promise.all([
      db1.backend.nodeCount(),
      db2.backend.nodeCount(),
      db1.backend.edgeCount(),
      db2.backend.edgeCount(),
    ]);

    assert.equal(count1, 2);
    assert.equal(count2, 3);
    assert.equal(edgeCount1, 1);
    assert.equal(edgeCount2, 2);

    await db1.cleanup();
    await db2.cleanup();
  });

  it('batch commit on one client does not affect another', async () => {
    const db1 = await createTestDatabase();
    const db2 = await createTestDatabase();

    // Client 1: batch commit for src/a.js
    db1.backend.client.beginBatch();
    await db1.backend.client.addNodes([
      { id: 'batch-fn1', nodeType: 'FUNCTION', name: 'fn1', file: 'src/a.js', metadata: '{}' },
      { id: 'batch-fn2', nodeType: 'FUNCTION', name: 'fn2', file: 'src/a.js', metadata: '{}' },
    ]);
    await db1.backend.client.commitBatch();

    // Client 2: add data independently (non-batch)
    await db2.backend.addNodes([
      { id: 'other-fn', type: 'FUNCTION', name: 'other', file: 'src/b.js' },
    ]);

    // Client 1's batch data visible to client 1
    const c1Count = await db1.backend.nodeCount();
    assert.equal(c1Count, 2, 'client 1 should have batch-committed nodes');

    // Client 2 unaffected
    const c2Count = await db2.backend.nodeCount();
    assert.equal(c2Count, 1, 'client 2 should have only its own node');

    await db1.cleanup();
    await db2.cleanup();
  });

  it('flush on one client does not affect another', async () => {
    const db1 = await createTestDatabase();
    const db2 = await createTestDatabase();

    await db1.backend.addNodes([
      { id: 'fl-a', type: 'FUNCTION', name: 'a', file: 'src/a.js' },
    ]);
    await db2.backend.addNodes([
      { id: 'fl-b', type: 'FUNCTION', name: 'b', file: 'src/b.js' },
    ]);

    // Flush client 1 only
    await db1.backend.flush();

    // Both clients should still see only their data
    const c1 = await db1.backend.nodeCount();
    const c2 = await db2.backend.nodeCount();

    assert.equal(c1, 1, 'client 1 should still see 1 node after flush');
    assert.equal(c2, 1, 'client 2 should still see 1 node (unaffected by flush)');

    await db1.cleanup();
    await db2.cleanup();
  });

  it('traversal queries are isolated between clients', async () => {
    const db1 = await createTestDatabase();
    const db2 = await createTestDatabase();

    // Client 1: chain A -> B -> C
    await db1.backend.addNodes([
      { id: 'chain-a', type: 'FUNCTION', name: 'a', file: 'src/chain.js' },
      { id: 'chain-b', type: 'FUNCTION', name: 'b', file: 'src/chain.js' },
      { id: 'chain-c', type: 'FUNCTION', name: 'c', file: 'src/chain.js' },
    ]);
    await db1.backend.addEdges([
      { src: 'chain-a', dst: 'chain-b', type: 'CALLS' },
      { src: 'chain-b', dst: 'chain-c', type: 'CALLS' },
    ]);

    // Client 2: single node, no edges
    await db2.backend.addNodes([
      { id: 'lone-x', type: 'FUNCTION', name: 'x', file: 'src/lone.js' },
    ]);

    // BFS from client 1 finds chain
    const bfsResult = await db1.backend.bfs(['chain-a'], 10, ['CALLS']);
    assert.ok(bfsResult.length >= 2, 'BFS should find chain nodes');

    // Client 2 has no edges to traverse
    const edgeCount = await db2.backend.edgeCount();
    assert.equal(edgeCount, 0, 'client 2 should have no edges');

    await db1.cleanup();
    await db2.cleanup();
  });

  it('delete on one client does not affect another', async () => {
    const db1 = await createTestDatabase();
    const db2 = await createTestDatabase();

    // Both clients add a node with same semantic id
    await db1.backend.addNodes([
      { id: 'shared-name', type: 'FUNCTION', name: 'shared', file: 'src/s.js' },
    ]);
    await db2.backend.addNodes([
      { id: 'shared-name', type: 'FUNCTION', name: 'shared', file: 'src/s.js' },
    ]);

    // Delete from client 1
    await db1.backend.deleteNode('shared-name');

    // Client 1 should not have the node
    const exists1 = await db1.backend.nodeExists('shared-name');
    assert.equal(exists1, false, 'deleted node should not exist in client 1');

    // Client 2 should still have the node
    const exists2 = await db2.backend.nodeExists('shared-name');
    assert.equal(exists2, true, 'node should still exist in client 2');

    await db1.cleanup();
    await db2.cleanup();
  });
});
