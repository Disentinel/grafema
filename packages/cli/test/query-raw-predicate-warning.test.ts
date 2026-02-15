/**
 * Tests for unknown Datalog predicate warning in --raw queries - REG-242
 *
 * When a --raw query returns no results, Grafema should warn the user
 * if the query contains predicates not in the built-in set. This helps
 * catch typos and misunderstandings of the Datalog schema.
 *
 * Tests cover:
 * - extractPredicates: parsing predicate names from Datalog queries
 * - extractRuleHeads: identifying user-defined rule heads
 * - getUnknownPredicates: combining extraction with built-in check
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPredicates,
  extractRuleHeads,
  getUnknownPredicates,
  BUILTIN_PREDICATES,
} from '../src/commands/query.js';

// =============================================================================
// TESTS: extractPredicates
// =============================================================================

describe('extractPredicates', () => {
  it('should extract a single predicate', () => {
    const result = extractPredicates('type(X, "FUNCTION")');
    assert.deepStrictEqual(result, ['type']);
  });

  it('should extract multiple predicates', () => {
    const result = extractPredicates('type(X, "FUNCTION"), attr(X, "name", N)');
    assert.deepStrictEqual(result, ['type', 'attr']);
  });

  it('should deduplicate repeated predicates', () => {
    const result = extractPredicates('node(X, "F"), node(Y, "G"), attr(X, "name", N)');
    assert.deepStrictEqual(result, ['node', 'attr']);
  });

  it('should extract predicates from rule body and head', () => {
    const result = extractPredicates('violation(X) :- node(X, "F").');
    assert.deepStrictEqual(result, ['violation', 'node']);
  });

  it('should handle negation (\\+)', () => {
    const result = extractPredicates('node(X, "F"), \\+ edge(X, _, "CALLS")');
    assert.deepStrictEqual(result, ['node', 'edge']);
  });

  it('should return empty array for empty string', () => {
    const result = extractPredicates('');
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array for garbage input', () => {
    const result = extractPredicates('hello world 123');
    assert.deepStrictEqual(result, []);
  });

  it('should handle predicates with underscores', () => {
    const result = extractPredicates('starts_with(X, "foo"), not_starts_with(Y, "bar")');
    assert.deepStrictEqual(result, ['starts_with', 'not_starts_with']);
  });

  it('should handle predicates with no spaces', () => {
    const result = extractPredicates('node(X,"F"),attr(X,"name",N)');
    assert.deepStrictEqual(result, ['node', 'attr']);
  });

  it('should handle multi-line queries', () => {
    const result = extractPredicates(
      'node(X, "FUNCTION"),\n  attr(X, "name", N),\n  edge(X, Y, "CALLS")'
    );
    assert.deepStrictEqual(result, ['node', 'attr', 'edge']);
  });

  it('should not match string contents as predicates', () => {
    // "FUNCTION" contains no predicate call; attr_edge(...) is the predicate
    const result = extractPredicates('attr_edge(X, Y, "calls")');
    assert.deepStrictEqual(result, ['attr_edge']);
  });

  it('should handle path predicate', () => {
    const result = extractPredicates('path(X, Y, "CALLS")');
    assert.deepStrictEqual(result, ['path']);
  });

  it('should handle incoming predicate', () => {
    const result = extractPredicates('incoming(X, Y, "CONTAINS")');
    assert.deepStrictEqual(result, ['incoming']);
  });
});

// =============================================================================
// TESTS: extractRuleHeads
// =============================================================================

describe('extractRuleHeads', () => {
  it('should extract single rule head', () => {
    const result = extractRuleHeads('violation(X) :- node(X, "F").');
    assert.deepStrictEqual(result, new Set(['violation']));
  });

  it('should extract multiple rule heads', () => {
    const result = extractRuleHeads(
      'bad(X) :- node(X, "F"). ugly(Y) :- edge(Y, _, "CALLS").'
    );
    assert.deepStrictEqual(result, new Set(['bad', 'ugly']));
  });

  it('should return empty set for direct query (no rules)', () => {
    const result = extractRuleHeads('type(X, "FUNCTION")');
    assert.deepStrictEqual(result, new Set());
  });

  it('should return empty set for empty string', () => {
    const result = extractRuleHeads('');
    assert.deepStrictEqual(result, new Set());
  });

  it('should handle multi-line rule', () => {
    const result = extractRuleHeads(
      'unused_fn(X) :-\n  node(X, "FUNCTION"),\n  \\+ edge(_, X, "CALLS").'
    );
    assert.deepStrictEqual(result, new Set(['unused_fn']));
  });

  it('should handle rule head with multiple arguments', () => {
    const result = extractRuleHeads('calls_pair(X, Y) :- edge(X, Y, "CALLS").');
    assert.deepStrictEqual(result, new Set(['calls_pair']));
  });

  it('should not treat query predicates as rule heads', () => {
    // node(X, "F") is not followed by :-, so it's not a rule head
    const result = extractRuleHeads('node(X, "FUNCTION"), attr(X, "name", N)');
    assert.deepStrictEqual(result, new Set());
  });
});

// =============================================================================
// TESTS: getUnknownPredicates
// =============================================================================

describe('getUnknownPredicates', () => {
  it('should return empty array when all predicates are built-in', () => {
    const result = getUnknownPredicates('node(X, "FUNCTION"), attr(X, "name", N)');
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array for type predicate (documented alias)', () => {
    const result = getUnknownPredicates('type(X, "FUNCTION")');
    assert.deepStrictEqual(result, []);
  });

  it('should detect unknown predicate', () => {
    const result = getUnknownPredicates('foo_bar(X, Y)');
    assert.deepStrictEqual(result, ['foo_bar']);
  });

  it('should return only unknown predicates in a mixed query', () => {
    const result = getUnknownPredicates('node(X, "F"), custom_check(X)');
    assert.deepStrictEqual(result, ['custom_check']);
  });

  it('should exclude rule heads from unknowns', () => {
    // violation is defined as a rule head, so it is NOT unknown
    const result = getUnknownPredicates('violation(X) :- node(X, "F").');
    assert.deepStrictEqual(result, []);
  });

  it('should exclude rule heads but flag other unknowns in rule body', () => {
    // my_rule is a rule head (not unknown), but bad_pred in body is unknown
    const result = getUnknownPredicates('my_rule(X) :- bad_pred(X, Y).');
    assert.deepStrictEqual(result, ['bad_pred']);
  });

  it('should handle multiple rules with mixed predicates', () => {
    const query = 'a(X) :- node(X, "F"). b(Y) :- unknown_thing(Y).';
    const result = getUnknownPredicates(query);
    assert.deepStrictEqual(result, ['unknown_thing']);
  });

  it('should return empty array for empty query', () => {
    const result = getUnknownPredicates('');
    assert.deepStrictEqual(result, []);
  });

  it('should handle all built-in predicates without false positives', () => {
    const allBuiltins = [
      'node(X, "F")',
      'type(X, "F")',
      'edge(X, Y, "CALLS")',
      'incoming(X, Y, "CALLS")',
      'path(X, Y, "CALLS")',
      'attr(X, "name", N)',
      'attr_edge(X, Y, "label")',
      'neq(X, Y)',
      'starts_with(N, "get")',
      'not_starts_with(N, "test")',
    ].join(', ');
    const result = getUnknownPredicates(allBuiltins);
    assert.deepStrictEqual(result, []);
  });

  it('should detect multiple unknown predicates', () => {
    const result = getUnknownPredicates('alpha(X), beta(Y), node(Z, "F")');
    assert.deepStrictEqual(result, ['alpha', 'beta']);
  });

  it('should handle negated unknown predicate', () => {
    const result = getUnknownPredicates('node(X, "F"), \\+ nonexistent(X, Y)');
    assert.deepStrictEqual(result, ['nonexistent']);
  });
});

// =============================================================================
// TESTS: BUILTIN_PREDICATES constant
// =============================================================================

describe('BUILTIN_PREDICATES', () => {
  it('should contain all documented RFDB built-in predicates', () => {
    const expected = [
      'node', 'type', 'edge', 'incoming', 'path',
      'attr', 'attr_edge', 'neq', 'starts_with', 'not_starts_with',
    ];
    for (const pred of expected) {
      assert.ok(
        BUILTIN_PREDICATES.has(pred),
        `BUILTIN_PREDICATES should contain '${pred}'`
      );
    }
  });

  it('should have exactly the expected number of predicates', () => {
    // Guard against accidentally adding or removing predicates without updating tests
    assert.strictEqual(BUILTIN_PREDICATES.size, 10);
  });
});
