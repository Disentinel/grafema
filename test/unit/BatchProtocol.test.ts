/**
 * BatchProtocol — Integration tests for RFDBClient batch operations (RFD-16)
 *
 * Tests the beginBatch/commitBatch/abortBatch lifecycle against a real RFDB
 * server, verifying that:
 * - Buffered nodes/edges are committed atomically
 * - CommitDelta reports correct counts and types
 * - abortBatch discards buffered data without persisting
 * - Tags are accepted without error
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);

describe('BatchProtocol', () => {
  it('beginBatch/commitBatch lifecycle — commits nodes and edges', async () => {
    const db = await createTestDatabase();
    const client = db.backend.client;

    client.beginBatch();

    await client.addNodes([
      { id: 'func:hello#test.js', type: 'FUNCTION', name: 'hello', file: 'test.js' },
      { id: 'func:world#test.js', type: 'FUNCTION', name: 'world', file: 'test.js' },
    ]);

    await client.addEdges([
      { src: 'func:hello#test.js', dst: 'func:world#test.js', edgeType: 'CALLS', metadata: '{}' },
    ]);

    const delta = await client.commitBatch();

    assert.ok(delta, 'commitBatch should return a CommitDelta');
    assert.ok(delta.nodesAdded >= 2, `expected nodesAdded >= 2, got ${delta.nodesAdded}`);
    assert.ok(delta.edgesAdded >= 1, `expected edgesAdded >= 1, got ${delta.edgesAdded}`);
    assert.ok(Array.isArray(delta.changedFiles), 'changedFiles should be an array');
    assert.ok(delta.changedFiles.includes('test.js'), 'changedFiles should include test.js');

    // Verify data actually persisted
    const nodeCount = await client.nodeCount();
    assert.ok(nodeCount >= 2, `expected nodeCount >= 2 after commit, got ${nodeCount}`);
  });

  it('commitBatch returns correct changedNodeTypes', async () => {
    const db = await createTestDatabase();
    const client = db.backend.client;

    client.beginBatch();

    await client.addNodes([
      { id: 'func:myFunc#types.js', type: 'FUNCTION', name: 'myFunc', file: 'types.js' },
    ]);

    const delta = await client.commitBatch();

    assert.ok(delta, 'commitBatch should return a CommitDelta');
    assert.ok(Array.isArray(delta.changedNodeTypes), 'changedNodeTypes should be an array');
    assert.ok(
      delta.changedNodeTypes.includes('FUNCTION'),
      `changedNodeTypes should include FUNCTION, got: ${JSON.stringify(delta.changedNodeTypes)}`,
    );
  });

  it('commitBatch returns correct changedEdgeTypes', async () => {
    const db = await createTestDatabase();
    const client = db.backend.client;

    client.beginBatch();

    await client.addNodes([
      { id: 'func:caller#edge.js', type: 'FUNCTION', name: 'caller', file: 'edge.js' },
      { id: 'func:callee#edge.js', type: 'FUNCTION', name: 'callee', file: 'edge.js' },
    ]);

    await client.addEdges([
      { src: 'func:caller#edge.js', dst: 'func:callee#edge.js', edgeType: 'CALLS', metadata: '{}' },
    ]);

    const delta = await client.commitBatch();

    assert.ok(delta, 'commitBatch should return a CommitDelta');
    assert.ok(Array.isArray(delta.changedEdgeTypes), 'changedEdgeTypes should be an array');
    assert.ok(
      delta.changedEdgeTypes.includes('CALLS'),
      `changedEdgeTypes should include CALLS, got: ${JSON.stringify(delta.changedEdgeTypes)}`,
    );
  });

  it('abortBatch discards buffered data — nothing persisted', async () => {
    const db = await createTestDatabase();
    const client = db.backend.client;

    const nodeCountBefore = await client.nodeCount();

    client.beginBatch();

    await client.addNodes([
      { id: 'func:ghost#abort.js', type: 'FUNCTION', name: 'ghost', file: 'abort.js' },
    ]);

    client.abortBatch();

    // Verify node was NOT added
    const nodeCountAfter = await client.nodeCount();
    assert.strictEqual(
      nodeCountAfter,
      nodeCountBefore,
      `nodeCount should be unchanged after abortBatch (before: ${nodeCountBefore}, after: ${nodeCountAfter})`,
    );

    // Also verify the node doesn't exist
    const node = await client.getNode('func:ghost#abort.js');
    assert.strictEqual(node, null, 'aborted node should not exist in the graph');
  });

  it('commitBatch with tags does not throw and returns valid delta', async () => {
    const db = await createTestDatabase();
    const client = db.backend.client;

    client.beginBatch();

    await client.addNodes([
      { id: 'func:tagged#tags.js', type: 'FUNCTION', name: 'tagged', file: 'tags.js' },
    ]);

    await client.addEdges([
      // Self-edge to have at least one edge in the batch
      { src: 'func:tagged#tags.js', dst: 'func:tagged#tags.js', edgeType: 'REFERENCES', metadata: '{}' },
    ]);

    const delta = await client.commitBatch(['test-plugin', 'ENRICHMENT']);

    assert.ok(delta, 'commitBatch with tags should return a CommitDelta');
    assert.ok(typeof delta.nodesAdded === 'number', 'nodesAdded should be a number');
    assert.ok(typeof delta.nodesRemoved === 'number', 'nodesRemoved should be a number');
    assert.ok(typeof delta.edgesAdded === 'number', 'edgesAdded should be a number');
    assert.ok(typeof delta.edgesRemoved === 'number', 'edgesRemoved should be a number');
    assert.ok(Array.isArray(delta.changedFiles), 'changedFiles should be an array');
    assert.ok(Array.isArray(delta.changedNodeTypes), 'changedNodeTypes should be an array');
    assert.ok(Array.isArray(delta.changedEdgeTypes), 'changedEdgeTypes should be an array');
    assert.ok(delta.nodesAdded >= 1, `expected nodesAdded >= 1 with tags, got ${delta.nodesAdded}`);
  });
});
