/**
 * EdgeFactory Unit Tests (REG-541)
 *
 * TDD tests for EdgeFactory.create() — the single static method that
 * creates EdgeRecord objects from type, src, dst, and optional fields.
 *
 * EdgeFactory is a thin wrapper: no database, no side effects.
 * Tests validate the shape and validation behavior of the returned EdgeRecord.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// EdgeFactory does not exist yet — these imports will fail until implementation.
// That is the TDD contract: tests first, implementation follows.
import { EdgeFactory } from '@grafema/core';

describe('EdgeFactory', () => {

  describe('create()', () => {

    it('should create edge with type, src, dst', () => {
      const edge = EdgeFactory.create('CALLS', 'fn:main:10', 'fn:greet:20');

      assert.strictEqual(edge.type, 'CALLS');
      assert.strictEqual(edge.src, 'fn:main:10');
      assert.strictEqual(edge.dst, 'fn:greet:20');
    });

    it('should return EdgeRecord with correct shape', () => {
      const edge = EdgeFactory.create('CONTAINS', 'MODULE:app.js', 'FUNCTION:handler');

      // Must have exactly the fields of EdgeRecord: src, dst, type, and optionally index/metadata
      assert.strictEqual(typeof edge.type, 'string');
      assert.strictEqual(typeof edge.src, 'string');
      assert.strictEqual(typeof edge.dst, 'string');

      // When no options provided, index and metadata should be absent or undefined
      assert.strictEqual(edge.index, undefined);
      assert.strictEqual(edge.metadata, undefined);
    });

    it('should include index when provided in options', () => {
      const edge = EdgeFactory.create('PASSES_ARGUMENT', 'CALL:foo:10', 'LITERAL:42:10', {
        index: 0,
      });

      assert.strictEqual(edge.index, 0);
    });

    it('should include metadata when provided in options', () => {
      const metadata = { matchType: 'path', path: '/var/run/app.sock' };
      const edge = EdgeFactory.create('INTERACTS_WITH', 'client:1', 'server:1', {
        metadata,
      });

      assert.deepStrictEqual(edge.metadata, metadata);
    });

    it('should include both index and metadata when both provided', () => {
      const edge = EdgeFactory.create('HAS_ELEMENT', 'ARRAY:arr:5', 'LITERAL:42:5', {
        index: 2,
        metadata: { elementIndex: 2 },
      });

      assert.strictEqual(edge.index, 2);
      assert.deepStrictEqual(edge.metadata, { elementIndex: 2 });
    });

    it('should throw on empty type', () => {
      assert.throws(
        () => EdgeFactory.create('', 'src:1', 'dst:1'),
        /type/i
      );
    });

    it('should throw on empty src', () => {
      assert.throws(
        () => EdgeFactory.create('CALLS', '', 'dst:1'),
        /src/i
      );
    });

    it('should throw on empty dst', () => {
      assert.throws(
        () => EdgeFactory.create('CALLS', 'src:1', ''),
        /dst/i
      );
    });

    it('should preserve string values without mutation', () => {
      const type = 'IMPORTS';
      const src = 'MODULE:index.js';
      const dst = 'EXTERNAL_MODULE:lodash';
      const edge = EdgeFactory.create(type, src, dst);

      // Verify values are exactly what was passed (no trimming, no transformation)
      assert.strictEqual(edge.type, 'IMPORTS');
      assert.strictEqual(edge.src, 'MODULE:index.js');
      assert.strictEqual(edge.dst, 'EXTERNAL_MODULE:lodash');
    });

  });

});
