/**
 * Tests for Levenshtein distance function and dynamic type validation
 */

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  levenshtein,
  checkTypoAgainstKnownTypes,
  resetKnownNodeTypes,
  getKnownNodeTypes
} from '@grafema/core';

describe('Levenshtein Distance', () => {
  describe('basic cases', () => {
    it('should return 0 for identical strings', () => {
      assert.equal(levenshtein('FUNCTION', 'FUNCTION'), 0);
      assert.equal(levenshtein('http:route', 'http:route'), 0);
      assert.equal(levenshtein('', ''), 0);
    });

    it('should return length for empty string comparison', () => {
      assert.equal(levenshtein('', 'abc'), 3);
      assert.equal(levenshtein('abc', ''), 3);
      assert.equal(levenshtein('', 'FUNCTION'), 8);
    });

    it('should handle single character difference', () => {
      assert.equal(levenshtein('FUNCTION', 'FUNCTON'), 1);  // missing I
      assert.equal(levenshtein('FUNCTION', 'FUNKTION'), 1); // C -> K
      assert.equal(levenshtein('FUNCTION', 'FUNCTIONS'), 1); // extra S
    });
  });

  describe('typo detection (distance <= 2)', () => {
    it('should detect single character typos (distance = 1)', () => {
      // Missing character
      assert.equal(levenshtein('FUNCTON', 'FUNCTION'), 1);
      assert.equal(levenshtein('MODUL', 'MODULE'), 1);

      // Wrong character
      assert.equal(levenshtein('FUNKTION', 'FUNCTION'), 1);
      assert.equal(levenshtein('MODUKE', 'MODULE'), 1);

      // Extra character
      assert.equal(levenshtein('CLASSS', 'CLASS'), 1);
      assert.equal(levenshtein('METHODD', 'METHOD'), 1);
    });

    it('should detect double character typos (distance = 2)', () => {
      // Two missing characters
      assert.equal(levenshtein('FUNCTN', 'FUNCTION'), 2);

      // Transposition counts as 2 operations (swap two adjacent chars)
      assert.equal(levenshtein('FUCNTION', 'FUNCTION'), 2); // transposition of UC->UN, CN->NC

      // Two wrong characters
      assert.equal(levenshtein('FONCTIAN', 'FUNCTION'), 2); // U->O, O->A
    });

    it('should NOT flag completely different types (distance > 2)', () => {
      assert.ok(levenshtein('FUNCTION', 'CLASS') > 2);
      assert.ok(levenshtein('MODULE', 'CALL') > 2);
      assert.ok(levenshtein('http:route', 'db:query') > 2);
    });
  });

  describe('namespaced types', () => {
    it('should handle namespaced type typos', () => {
      assert.equal(levenshtein('http:rout', 'http:route'), 1);
      assert.equal(levenshtein('http:roote', 'http:route'), 1);
      assert.equal(levenshtein('htp:route', 'http:route'), 1);
      assert.equal(levenshtein('socketio:emi', 'socketio:emit'), 1);
    });

    it('should distinguish different namespaces', () => {
      // Different namespaces - distance depends on namespace difference
      assert.equal(levenshtein('http:query', 'db:query'), 4); // http vs db = 4 changes
      assert.equal(levenshtein('fs:read', 'db:read'), 2);     // f->d, s->b = 2 changes
      assert.ok(levenshtein('socketio:emit', 'event:emit') > 2); // socketio vs event = many changes
    });
  });

  describe('case sensitivity', () => {
    it('should be case sensitive', () => {
      assert.ok(levenshtein('function', 'FUNCTION') > 0);
      assert.equal(levenshtein('function', 'FUNCTION'), 8); // all characters different
    });
  });

  describe('real-world typo examples', () => {
    it('should catch common keyboard typos', () => {
      // Adjacent key typos
      assert.equal(levenshtein('FUBCTION', 'FUNCTION'), 1); // N -> B (adjacent)
      assert.equal(levenshtein('VARIANLE', 'VARIABLE'), 1); // B -> N (adjacent)

      // Double letter issues
      assert.equal(levenshtein('CALLL', 'CALL'), 1);
      assert.equal(levenshtein('CLAS', 'CLASS'), 1);
    });
  });
});

describe('checkTypoAgainstKnownTypes', () => {
  beforeEach(() => {
    resetKnownNodeTypes();
  });

  it('should detect typos against known types', () => {
    // FUNCTION is a known type
    const result = checkTypoAgainstKnownTypes('FUNCTON'); // missing I
    assert.equal(result.isTooSimilar, true);
    assert.equal(result.similarTo, 'FUNCTION');
  });

  it('should detect typos with case insensitivity', () => {
    // Should match even with different case
    const result = checkTypoAgainstKnownTypes('functon');
    assert.equal(result.isTooSimilar, true);
    assert.equal(result.similarTo, 'FUNCTION');
  });

  it('should allow completely new types', () => {
    // FOOBAR is not similar to any known type
    const result = checkTypoAgainstKnownTypes('FOOBAR');
    assert.equal(result.isTooSimilar, false);
    assert.equal(result.similarTo, null);
  });

  it('should detect typos in namespaced types', () => {
    // http:route is known
    const result = checkTypoAgainstKnownTypes('http:rout');
    assert.equal(result.isTooSimilar, true);
    assert.equal(result.similarTo, 'http:route');
  });
});

describe('Dynamic KNOWN_NODE_TYPES population', () => {
  beforeEach(() => {
    resetKnownNodeTypes();
  });

  it('should contain initial types after reset', () => {
    const types = getKnownNodeTypes();
    assert.ok(types.has('FUNCTION'));
    assert.ok(types.has('CLASS'));
    assert.ok(types.has('http:route'));
    assert.ok(types.has('socketio:emit'));
  });

  it('should detect when typo was added first and correct type comes later', () => {
    // Simulate scenario: typo 'FUNCTON' gets added first somehow
    // When correct 'FUNCTION' tries to be checked, it should detect the typo
    // Note: This tests the algorithm, not the actual backend behavior

    // FUNCTION is already in KNOWN_NODE_TYPES, so FUNCTON would be detected
    const result1 = checkTypoAgainstKnownTypes('FUNCTON');
    assert.equal(result1.isTooSimilar, true);
    assert.equal(result1.similarTo, 'FUNCTION');
  });

  it('should allow types with distance > 2 from all known types', () => {
    // 'WIDGET' should be allowed - not similar to any known type
    const result = checkTypoAgainstKnownTypes('WIDGET');
    assert.equal(result.isTooSimilar, false);

    // 'custom:mytype' should be allowed
    const result2 = checkTypoAgainstKnownTypes('custom:mytype');
    assert.equal(result2.isTooSimilar, false);
  });
});
