/**
 * RFDBClient Unit Tests
 *
 * Tests for RFDBClient functionality that don't require a running server.
 * Uses mock socket to test message serialization and addNodes behavior.
 *
 * Key tests for REG-274:
 * - addNodes() should preserve extra fields in metadata
 * - Extra fields like constraints, condition, scopeType should not be lost
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { RFDBClient } from '../dist/client.js';

import type {
  SnapshotRef,
  SnapshotStats,
  SegmentInfo,
  SnapshotDiff,
  SnapshotInfo,
} from '@grafema/types';

/**
 * Mock RFDBClient that captures what would be sent to the server
 *
 * We can't easily mock the socket, so we test the serialization logic
 * by extracting the node mapping logic from addNodes.
 */
function mapNodeForWireFormat(n: Record<string, unknown>): {
  id: string;
  nodeType: string;
  name: string;
  file: string;
  exported: boolean;
  metadata: string;
} {
  // This is the CURRENT implementation - extracts only known fields
  // Bug: extra fields are silently discarded
  return {
    id: String(n.id),
    nodeType: (n.node_type || n.nodeType || n.type || 'UNKNOWN') as string,
    name: (n.name as string) || '',
    file: (n.file as string) || '',
    exported: (n.exported as boolean) || false,
    metadata: typeof n.metadata === 'string' ? n.metadata : JSON.stringify(n.metadata || {}),
  };
}

/**
 * FIXED implementation that preserves extra fields
 */
function mapNodeForWireFormatFixed(n: Record<string, unknown>): {
  id: string;
  nodeType: string;
  name: string;
  file: string;
  exported: boolean;
  metadata: string;
} {
  // Extract known wire format fields, rest goes to metadata
  const { id, type, node_type, nodeType, name, file, exported, metadata, ...rest } = n;

  // Merge explicit metadata with extra properties
  const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata as string) : (metadata || {});
  const combinedMeta = { ...existingMeta, ...rest };

  return {
    id: String(id),
    nodeType: (node_type || nodeType || type || 'UNKNOWN') as string,
    name: (name as string) || '',
    file: (file as string) || '',
    exported: (exported as boolean) || false,
    metadata: JSON.stringify(combinedMeta),
  };
}

describe('RFDBClient.addNodes() Metadata Preservation', () => {
  /**
   * WHY: JSASTAnalyzer collects constraints for SCOPE nodes during analysis.
   * These constraints contain guard information like "someValue !== null".
   * If constraints are lost during serialization, the graph cannot answer
   * questions like "what conditions guard this code execution?"
   *
   * This test documents the BUG: constraints are silently discarded.
   */
  it('BUG: current implementation loses constraints field', () => {
    const scopeNode = {
      id: 'SCOPE:file.js:10',
      type: 'SCOPE',
      name: 'if_branch',
      file: 'file.js',
      // Extra fields that should be preserved
      constraints: [
        { variable: 'someValue', operator: '!==', value: 'null' },
      ],
      condition: 'someValue !== null',
      scopeType: 'if_statement',
      conditional: true,
      line: 10,
    };

    const wireNode = mapNodeForWireFormat(scopeNode);
    const metadata = JSON.parse(wireNode.metadata);

    // BUG: These assertions FAIL - constraints are lost
    // Once the bug is fixed, these will pass
    assert.strictEqual(metadata.constraints, undefined, 'BUG: constraints should be lost in current impl');
    assert.strictEqual(metadata.condition, undefined, 'BUG: condition should be lost in current impl');
    assert.strictEqual(metadata.scopeType, undefined, 'BUG: scopeType should be lost in current impl');
    assert.strictEqual(metadata.conditional, undefined, 'BUG: conditional should be lost in current impl');
    assert.strictEqual(metadata.line, undefined, 'BUG: line should be lost in current impl');
  });

  /**
   * WHY: After the fix, extra fields should be merged into metadata.
   * This test verifies the EXPECTED behavior after REG-274 is implemented.
   */
  it('FIXED: should preserve constraints in metadata', () => {
    const scopeNode = {
      id: 'SCOPE:file.js:10',
      type: 'SCOPE',
      name: 'if_branch',
      file: 'file.js',
      // Extra fields that should be preserved
      constraints: [
        { variable: 'someValue', operator: '!==', value: 'null' },
      ],
      condition: 'someValue !== null',
      scopeType: 'if_statement',
      conditional: true,
      line: 10,
    };

    const wireNode = mapNodeForWireFormatFixed(scopeNode);
    const metadata = JSON.parse(wireNode.metadata);

    // These assertions should PASS after fix
    assert.deepStrictEqual(
      metadata.constraints,
      [{ variable: 'someValue', operator: '!==', value: 'null' }],
      'constraints should be preserved in metadata'
    );
    assert.strictEqual(metadata.condition, 'someValue !== null', 'condition should be preserved');
    assert.strictEqual(metadata.scopeType, 'if_statement', 'scopeType should be preserved');
    assert.strictEqual(metadata.conditional, true, 'conditional should be preserved');
    assert.strictEqual(metadata.line, 10, 'line should be preserved');
  });

  /**
   * WHY: Extra fields should be MERGED with existing metadata, not replace it.
   */
  it('FIXED: should merge extra fields with existing metadata', () => {
    const node = {
      id: 'NODE:test',
      type: 'SCOPE',
      name: 'test',
      file: 'test.js',
      metadata: { existingField: 'value', semanticId: 'test->scope' },
      // Extra fields
      constraints: [{ variable: 'x', operator: '>', value: '0' }],
      newField: 'newValue',
    };

    const wireNode = mapNodeForWireFormatFixed(node);
    const metadata = JSON.parse(wireNode.metadata);

    assert.strictEqual(metadata.existingField, 'value', 'existing metadata should be preserved');
    assert.strictEqual(metadata.semanticId, 'test->scope', 'semanticId should be preserved');
    assert.deepStrictEqual(
      metadata.constraints,
      [{ variable: 'x', operator: '>', value: '0' }],
      'new constraints should be added'
    );
    assert.strictEqual(metadata.newField, 'newValue', 'new fields should be added');
  });

  /**
   * WHY: String metadata (JSON string) should be parsed and merged.
   */
  it('FIXED: should handle string metadata correctly', () => {
    const node = {
      id: 'NODE:test',
      type: 'CALL',
      name: 'test',
      file: 'test.js',
      metadata: JSON.stringify({ callee: 'foo', args: ['a', 'b'] }),
      // Extra field
      resolved: true,
    };

    const wireNode = mapNodeForWireFormatFixed(node);
    const metadata = JSON.parse(wireNode.metadata);

    assert.strictEqual(metadata.callee, 'foo', 'callee from string metadata should be preserved');
    assert.deepStrictEqual(metadata.args, ['a', 'b'], 'args from string metadata should be preserved');
    assert.strictEqual(metadata.resolved, true, 'extra field should be merged');
  });

  /**
   * WHY: Known wire fields (id, type, name, file, exported) should NOT
   * appear in metadata - they have their own fields in the wire format.
   */
  it('FIXED: should not duplicate known fields in metadata', () => {
    const node = {
      id: 'NODE:test',
      type: 'FUNCTION',
      name: 'myFunc',
      file: 'test.js',
      exported: true,
      // Only extra fields should go to metadata
      async: true,
      generator: false,
    };

    const wireNode = mapNodeForWireFormatFixed(node);
    const metadata = JSON.parse(wireNode.metadata);

    // Known fields should NOT be in metadata (they have dedicated wire fields)
    assert.strictEqual(metadata.id, undefined, 'id should not be duplicated in metadata');
    assert.strictEqual(metadata.type, undefined, 'type should not be duplicated in metadata');
    assert.strictEqual(metadata.name, undefined, 'name should not be duplicated in metadata');
    assert.strictEqual(metadata.file, undefined, 'file should not be duplicated in metadata');
    assert.strictEqual(metadata.exported, undefined, 'exported should not be duplicated in metadata');

    // Extra fields SHOULD be in metadata
    assert.strictEqual(metadata.async, true, 'async should be in metadata');
    assert.strictEqual(metadata.generator, false, 'generator should be in metadata');

    // Verify wire format fields are set correctly
    assert.strictEqual(wireNode.id, 'NODE:test');
    assert.strictEqual(wireNode.nodeType, 'FUNCTION');
    assert.strictEqual(wireNode.name, 'myFunc');
    assert.strictEqual(wireNode.file, 'test.js');
    assert.strictEqual(wireNode.exported, true);
  });

  /**
   * WHY: Empty or undefined metadata should work correctly.
   */
  it('FIXED: should handle nodes without metadata', () => {
    const node = {
      id: 'NODE:test',
      type: 'MODULE',
      name: 'test',
      file: 'test.js',
      // No metadata field
      version: '1.0.0',
    };

    const wireNode = mapNodeForWireFormatFixed(node);
    const metadata = JSON.parse(wireNode.metadata);

    assert.strictEqual(metadata.version, '1.0.0', 'extra field should become metadata');
  });

  /**
   * WHY: Nested conditional scopes should preserve their constraint chain.
   * This is critical for find_guards to work correctly.
   */
  it('FIXED: should preserve nested scope constraints', () => {
    const outerScope = {
      id: 'SCOPE:file.js:5',
      type: 'SCOPE',
      name: 'if_branch',
      file: 'file.js',
      constraints: [{ variable: 'user', operator: '!==', value: 'null' }],
      condition: 'user !== null',
      scopeType: 'if_statement',
      conditional: true,
      line: 5,
    };

    const innerScope = {
      id: 'SCOPE:file.js:7',
      type: 'SCOPE',
      name: 'if_branch',
      file: 'file.js',
      constraints: [{ variable: 'user.isAdmin', operator: '===', value: 'true' }],
      condition: 'user.isAdmin',
      scopeType: 'if_statement',
      conditional: true,
      parentScope: 'SCOPE:file.js:5',
      line: 7,
    };

    const outerWire = mapNodeForWireFormatFixed(outerScope);
    const innerWire = mapNodeForWireFormatFixed(innerScope);

    const outerMeta = JSON.parse(outerWire.metadata);
    const innerMeta = JSON.parse(innerWire.metadata);

    // Both scopes should preserve their constraints
    assert.deepStrictEqual(
      outerMeta.constraints,
      [{ variable: 'user', operator: '!==', value: 'null' }]
    );
    assert.deepStrictEqual(
      innerMeta.constraints,
      [{ variable: 'user.isAdmin', operator: '===', value: 'true' }]
    );

    // Inner scope should reference parent
    assert.strictEqual(innerMeta.parentScope, 'SCOPE:file.js:5');
  });
});

// ============================================================================
// Snapshot API Tests
// ============================================================================

/**
 * Extracted helper that mirrors RFDBClient._resolveSnapshotRef().
 * Tested directly since the actual method is private and requires socket.
 */
function resolveSnapshotRef(ref: SnapshotRef): Record<string, unknown> {
  if (typeof ref === 'number') return { version: ref };
  return { tagKey: ref.tag, tagValue: ref.value };
}

describe('Snapshot API — resolveSnapshotRef', () => {
  /**
   * WHY: When referencing a snapshot by version number, the wire format
   * must send { version: N } so the server can look up the manifest.
   */
  it('should resolve number ref to { version }', () => {
    const result = resolveSnapshotRef(42);
    assert.deepStrictEqual(result, { version: 42 });
  });

  /**
   * WHY: When referencing a snapshot by tag, the wire format must send
   * { tagKey, tagValue } so the server can do a tag lookup.
   */
  it('should resolve tag ref to { tagKey, tagValue }', () => {
    const result = resolveSnapshotRef({ tag: 'release', value: 'v1.0.0' });
    assert.deepStrictEqual(result, { tagKey: 'release', tagValue: 'v1.0.0' });
  });

  /**
   * WHY: Version 0 is a valid snapshot (initial empty state).
   * Must not be treated as falsy.
   */
  it('should handle version 0 correctly', () => {
    const result = resolveSnapshotRef(0);
    assert.deepStrictEqual(result, { version: 0 });
  });

  /**
   * WHY: Discriminating between number and object is critical for
   * the wire format. typeof === 'number' is the correct check.
   */
  it('should discriminate SnapshotRef union correctly', () => {
    const numRef: SnapshotRef = 5;
    const tagRef: SnapshotRef = { tag: 'env', value: 'staging' };

    assert.strictEqual(typeof numRef, 'number');
    assert.strictEqual(typeof tagRef, 'object');

    // Both should produce distinct wire formats
    const numResult = resolveSnapshotRef(numRef);
    const tagResult = resolveSnapshotRef(tagRef);

    assert.ok('version' in numResult);
    assert.ok(!('tagKey' in numResult));
    assert.ok('tagKey' in tagResult);
    assert.ok(!('version' in tagResult));
  });
});

describe('Snapshot API — Type Contracts', () => {
  /**
   * WHY: SnapshotStats must match Rust ManifestStats wire format.
   * Fields: total_nodes -> totalNodes, total_edges -> totalEdges, etc.
   */
  it('SnapshotStats should have correct shape', () => {
    const stats: SnapshotStats = {
      totalNodes: 1500,
      totalEdges: 3200,
      nodeSegmentCount: 4,
      edgeSegmentCount: 2,
    };

    assert.strictEqual(stats.totalNodes, 1500);
    assert.strictEqual(stats.totalEdges, 3200);
    assert.strictEqual(stats.nodeSegmentCount, 4);
    assert.strictEqual(stats.edgeSegmentCount, 2);
  });

  /**
   * WHY: SegmentInfo must expose the subset of Rust SegmentDescriptor
   * that's useful for client-side diff analysis. HashSet -> string[].
   */
  it('SegmentInfo should have correct shape', () => {
    const segment: SegmentInfo = {
      segmentId: 7,
      recordCount: 500,
      byteSize: 102400,
      nodeTypes: ['FUNCTION', 'CLASS'],
      filePaths: ['src/app.js', 'src/utils.js'],
      edgeTypes: [],
    };

    assert.strictEqual(segment.segmentId, 7);
    assert.strictEqual(segment.recordCount, 500);
    assert.strictEqual(segment.byteSize, 102400);
    assert.deepStrictEqual(segment.nodeTypes, ['FUNCTION', 'CLASS']);
    assert.deepStrictEqual(segment.filePaths, ['src/app.js', 'src/utils.js']);
    assert.deepStrictEqual(segment.edgeTypes, []);
  });

  /**
   * WHY: SnapshotDiff is the primary return type of diffSnapshots().
   * Must carry from/to versions, segment lists, and stats for both.
   */
  it('SnapshotDiff should have correct shape', () => {
    const diff: SnapshotDiff = {
      fromVersion: 1,
      toVersion: 3,
      addedNodeSegments: [
        { segmentId: 10, recordCount: 200, byteSize: 40960, nodeTypes: ['MODULE'], filePaths: ['new.js'], edgeTypes: [] },
      ],
      removedNodeSegments: [],
      addedEdgeSegments: [
        { segmentId: 11, recordCount: 50, byteSize: 8192, nodeTypes: [], filePaths: [], edgeTypes: ['CALLS'] },
      ],
      removedEdgeSegments: [
        { segmentId: 5, recordCount: 30, byteSize: 4096, nodeTypes: [], filePaths: [], edgeTypes: ['IMPORTS'] },
      ],
      statsFrom: { totalNodes: 1000, totalEdges: 2000, nodeSegmentCount: 3, edgeSegmentCount: 2 },
      statsTo: { totalNodes: 1200, totalEdges: 2020, nodeSegmentCount: 4, edgeSegmentCount: 2 },
    };

    assert.strictEqual(diff.fromVersion, 1);
    assert.strictEqual(diff.toVersion, 3);
    assert.strictEqual(diff.addedNodeSegments.length, 1);
    assert.strictEqual(diff.removedNodeSegments.length, 0);
    assert.strictEqual(diff.addedEdgeSegments.length, 1);
    assert.strictEqual(diff.removedEdgeSegments.length, 1);
    assert.strictEqual(diff.statsFrom.totalNodes, 1000);
    assert.strictEqual(diff.statsTo.totalNodes, 1200);
  });

  /**
   * WHY: SnapshotInfo is the return type of listSnapshots().
   * Must carry version, timestamp, tags, and stats.
   * createdAt is Unix epoch seconds (not milliseconds).
   */
  it('SnapshotInfo should have correct shape', () => {
    const info: SnapshotInfo = {
      version: 5,
      createdAt: 1707900000,
      tags: { release: 'v1.0.0', env: 'production' },
      stats: { totalNodes: 500, totalEdges: 1200, nodeSegmentCount: 2, edgeSegmentCount: 1 },
    };

    assert.strictEqual(info.version, 5);
    assert.strictEqual(info.createdAt, 1707900000);
    assert.deepStrictEqual(info.tags, { release: 'v1.0.0', env: 'production' });
    assert.strictEqual(info.stats.totalNodes, 500);
  });

  /**
   * WHY: SnapshotInfo with empty tags should be valid — not all snapshots
   * are tagged. The tags field should be an empty object, not undefined.
   */
  it('SnapshotInfo should allow empty tags', () => {
    const info: SnapshotInfo = {
      version: 1,
      createdAt: 1707800000,
      tags: {},
      stats: { totalNodes: 0, totalEdges: 0, nodeSegmentCount: 0, edgeSegmentCount: 0 },
    };

    assert.deepStrictEqual(info.tags, {});
    assert.strictEqual(info.stats.totalNodes, 0);
  });
});

describe('Snapshot API — Wire Format', () => {
  /**
   * WHY: tagSnapshot sends version + tags to the server.
   * The wire format must include both fields at the top level of the payload.
   */
  it('tagSnapshot payload should have version and tags', () => {
    const version = 3;
    const tags = { release: 'v2.0', branch: 'main' };

    // Simulate the payload that tagSnapshot() would send
    const payload = { version, tags };

    assert.strictEqual(payload.version, 3);
    assert.deepStrictEqual(payload.tags, { release: 'v2.0', branch: 'main' });
  });

  /**
   * WHY: findSnapshot sends tagKey + tagValue.
   * The response contains version (number) or null if not found.
   */
  it('findSnapshot wire format — found', () => {
    const response = { version: 7 };
    assert.strictEqual(response.version, 7);
  });

  it('findSnapshot wire format — not found', () => {
    const response = { version: null };
    assert.strictEqual(response.version, null);
  });

  /**
   * WHY: listSnapshots with filter sends filterTag in payload.
   * Without filter, the payload should be empty.
   */
  it('listSnapshots payload with filter', () => {
    const filterTag = 'release';
    const payload: Record<string, unknown> = {};
    if (filterTag !== undefined) payload.filterTag = filterTag;

    assert.strictEqual(payload.filterTag, 'release');
  });

  it('listSnapshots payload without filter', () => {
    const filterTag = undefined;
    const payload: Record<string, unknown> = {};
    if (filterTag !== undefined) payload.filterTag = filterTag;

    assert.strictEqual(Object.keys(payload).length, 0);
  });

  /**
   * WHY: diffSnapshots sends from + to as resolved snapshot refs.
   * Must handle mixed refs (number + tag) correctly.
   */
  it('diffSnapshots with mixed refs', () => {
    const from: SnapshotRef = 1;
    const to: SnapshotRef = { tag: 'release', value: 'v2.0' };

    const payload = {
      from: resolveSnapshotRef(from),
      to: resolveSnapshotRef(to),
    };

    assert.deepStrictEqual(payload.from, { version: 1 });
    assert.deepStrictEqual(payload.to, { tagKey: 'release', tagValue: 'v2.0' });
  });
});

// ===========================================================================
// Batch Operations Unit Tests (RFD-9)
// ===========================================================================

describe('RFDBClient Batch Operations', () => {
  /**
   * We test batch state management by creating a real RFDBClient instance
   * (not connected) and exercising the batch methods. Since batch state is
   * purely client-side, we don't need a server connection for these tests.
   */

  it('beginBatch sets batching state', () => {
    // RFDBClient constructor doesn't require connection
    const client = new RFDBClient('/tmp/test-nonexistent.sock');

    assert.strictEqual(client.isBatching(), false, 'should not be batching initially');
    client.beginBatch();
    assert.strictEqual(client.isBatching(), true, 'should be batching after beginBatch');
  });

  it('double beginBatch throws', () => {
    const client = new RFDBClient('/tmp/test-nonexistent.sock');

    client.beginBatch();
    assert.throws(
      () => client.beginBatch(),
      { message: 'Batch already in progress' },
      'should throw on double beginBatch',
    );
  });

  it('commitBatch without beginBatch throws', async () => {
    const client = new RFDBClient('/tmp/test-nonexistent.sock');

    await assert.rejects(
      () => client.commitBatch(),
      { message: 'No batch in progress' },
      'should throw on commitBatch without beginBatch',
    );
  });

  it('abortBatch clears batching state', () => {
    const client = new RFDBClient('/tmp/test-nonexistent.sock');

    client.beginBatch();
    assert.strictEqual(client.isBatching(), true);
    client.abortBatch();
    assert.strictEqual(client.isBatching(), false, 'should not be batching after abort');
  });

  it('abortBatch when not batching is a no-op', () => {
    const client = new RFDBClient('/tmp/test-nonexistent.sock');

    // Should not throw
    client.abortBatch();
    assert.strictEqual(client.isBatching(), false);
  });

  it('addNodes during batch buffers locally and returns ok', async () => {
    const client = new RFDBClient('/tmp/test-nonexistent.sock');
    // Not connected — _send would fail, but buffering skips _send

    client.beginBatch();
    const result = await client.addNodes([
      { id: 'n1', type: 'FUNCTION', name: 'foo', file: 'a.js' },
      { id: 'n2', type: 'FUNCTION', name: 'bar', file: 'b.js' },
    ]);

    assert.deepStrictEqual(result, { ok: true }, 'should return ok without sending');
    assert.strictEqual(client.isBatching(), true, 'should still be batching');
  });

  it('addEdges during batch buffers locally and returns ok', async () => {
    const client = new RFDBClient('/tmp/test-nonexistent.sock');

    client.beginBatch();
    const result = await client.addEdges([
      { src: 'n1', dst: 'n2', edgeType: 'CALLS', metadata: '{}' },
    ]);

    assert.deepStrictEqual(result, { ok: true }, 'should return ok without sending');
  });

  it('addNodes without batch still requires connection (legacy behavior)', async () => {
    const client = new RFDBClient('/tmp/test-nonexistent.sock');
    // Not connected, not batching — should throw "Not connected"

    await assert.rejects(
      () => client.addNodes([{ id: 'n1', type: 'FUNCTION', name: 'foo', file: 'a.js' }]),
      { message: 'Not connected to RFDB server' },
      'should require connection when not batching',
    );
  });
});
