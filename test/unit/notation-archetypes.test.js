/**
 * Tests for notation/archetypes — edge-to-archetype mapping
 *
 * Verifies:
 * - Every EDGE_TYPE key has a mapping
 * - Every mapping has valid fields
 * - lookupEdge returns fallback for unknown types
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { EDGE_TYPE } from '../../packages/types/dist/edges.js';
import { EDGE_ARCHETYPE_MAP, lookupEdge } from '../../packages/util/dist/notation/index.js';

const VALID_ARCHETYPES = new Set([
  'contains', 'flow_out', 'flow_in', 'write',
  'exception', 'depends', 'publishes', 'gates', 'governs',
]);

describe('EDGE_ARCHETYPE_MAP', () => {
  it('should map every EDGE_TYPE to an archetype', () => {
    const edgeTypeKeys = Object.values(EDGE_TYPE);
    const unmapped = [];

    for (const key of edgeTypeKeys) {
      if (!EDGE_ARCHETYPE_MAP[key]) {
        unmapped.push(key);
      }
    }

    assert.deepStrictEqual(
      unmapped, [],
      `Unmapped edge types: ${unmapped.join(', ')}`,
    );
  });

  it('should have valid archetype for every mapping', () => {
    for (const [key, mapping] of Object.entries(EDGE_ARCHETYPE_MAP)) {
      assert.ok(
        VALID_ARCHETYPES.has(mapping.archetype),
        `${key}: invalid archetype "${mapping.archetype}"`,
      );
    }
  });

  it('should have a non-empty verb for every mapping', () => {
    for (const [key, mapping] of Object.entries(EDGE_ARCHETYPE_MAP)) {
      assert.ok(
        typeof mapping.verb === 'string' && mapping.verb.length > 0,
        `${key}: missing verb`,
      );
    }
  });

  it('should have a numeric sortOrder for every mapping', () => {
    for (const [key, mapping] of Object.entries(EDGE_ARCHETYPE_MAP)) {
      assert.ok(
        typeof mapping.sortOrder === 'number',
        `${key}: missing sortOrder`,
      );
    }
  });

  it('should have empty operator for containment archetypes', () => {
    for (const [key, mapping] of Object.entries(EDGE_ARCHETYPE_MAP)) {
      if (mapping.archetype === 'contains') {
        assert.strictEqual(
          mapping.operator, '',
          `${key}: containment should have empty operator, got "${mapping.operator}"`,
        );
      }
    }
  });

  it('should have non-empty operator for non-containment archetypes', () => {
    for (const [key, mapping] of Object.entries(EDGE_ARCHETYPE_MAP)) {
      if (mapping.archetype !== 'contains') {
        assert.ok(
          mapping.operator.length > 0,
          `${key}: non-containment archetype "${mapping.archetype}" should have operator`,
        );
      }
    }
  });
});

describe('lookupEdge', () => {
  it('should return mapping for known edge types', () => {
    const result = lookupEdge('CALLS');
    assert.strictEqual(result.archetype, 'flow_out');
    assert.strictEqual(result.operator, '>');
    assert.strictEqual(result.verb, 'calls');
  });

  it('should return fallback for unknown edge types', () => {
    const result = lookupEdge('TOTALLY_UNKNOWN');
    assert.strictEqual(result.archetype, 'flow_out');
    assert.strictEqual(result.operator, '>');
    assert.strictEqual(result.verb, 'totally unknown');
  });

  it('should map CONTAINS to containment archetype', () => {
    const result = lookupEdge('CONTAINS');
    assert.strictEqual(result.archetype, 'contains');
    assert.strictEqual(result.operator, '');
  });

  it('should map THROWS to exception archetype', () => {
    const result = lookupEdge('THROWS');
    assert.strictEqual(result.archetype, 'exception');
    assert.strictEqual(result.operator, '>x');
  });

  it('should map EMITS_EVENT to publishes archetype', () => {
    const result = lookupEdge('EMITS_EVENT');
    assert.strictEqual(result.archetype, 'publishes');
    assert.strictEqual(result.operator, '~>>');
  });

  it('should map WRITES_TO to write archetype', () => {
    const result = lookupEdge('WRITES_TO');
    assert.strictEqual(result.archetype, 'write');
    assert.strictEqual(result.operator, '=>');
  });

  it('should map READS_FROM to flow_in archetype', () => {
    const result = lookupEdge('READS_FROM');
    assert.strictEqual(result.archetype, 'flow_in');
    assert.strictEqual(result.operator, '<');
  });

  it('should map HAS_CONDITION to gates archetype', () => {
    const result = lookupEdge('HAS_CONDITION');
    assert.strictEqual(result.archetype, 'gates');
    assert.strictEqual(result.operator, '?|');
  });

  it('should map GOVERNS to governs archetype', () => {
    const result = lookupEdge('GOVERNS');
    assert.strictEqual(result.archetype, 'governs');
    assert.strictEqual(result.operator, '|=');
  });

  it('should map DEPENDS_ON to depends archetype', () => {
    const result = lookupEdge('DEPENDS_ON');
    assert.strictEqual(result.archetype, 'depends');
    assert.strictEqual(result.operator, 'o-');
  });
});
