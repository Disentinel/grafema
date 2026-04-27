/**
 * Tests for behaviorDiff helper (REG-1117 Layer 1 helper).
 *
 * Pure-function tests, no RFDB involvement.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffBehaviors,
  behaviorDiffSize,
  formatBehaviorDiff,
} from '@grafema/util/regression/behaviorDiff';

const meta = (hash, effects = [], coreNodeCount = 1, depth = 10) => ({
  hash,
  effects,
  coreNodeCount,
  depth,
});

describe('behaviorDiff: empty inputs', () => {
  it('two empty maps → empty diff, size 0', () => {
    const d = diffBehaviors(new Map(), new Map());
    assert.equal(behaviorDiffSize(d), 0);
    assert.deepEqual(d.added, []);
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.hashChanged, []);
    assert.deepEqual(d.effectsChangedSameHash, []);
  });

  it('formatBehaviorDiff returns clean message when empty', () => {
    const d = diffBehaviors(new Map(), new Map());
    assert.equal(formatBehaviorDiff(d), 'No behavior changes vs golden.');
  });
});

describe('behaviorDiff: identical snapshots', () => {
  it('same hash, same effects → no changes', () => {
    const golden = new Map([['cli:command:analyze', meta('aaa', ['IO'], 5)]]);
    const current = new Map([['cli:command:analyze', meta('aaa', ['IO'], 5)]]);
    const d = diffBehaviors(golden, current);
    assert.equal(behaviorDiffSize(d), 0);
  });
});

describe('behaviorDiff: added / removed features', () => {
  it('feature only in current → added', () => {
    const golden = new Map();
    const current = new Map([['cli:command:foo', meta('h1')]]);
    const d = diffBehaviors(golden, current);
    assert.deepEqual(d.added, ['cli:command:foo']);
    assert.deepEqual(d.removed, []);
  });

  it('feature only in golden → removed', () => {
    const golden = new Map([['cli:command:foo', meta('h1')]]);
    const current = new Map();
    const d = diffBehaviors(golden, current);
    assert.deepEqual(d.removed, ['cli:command:foo']);
    assert.deepEqual(d.added, []);
  });

  it('added/removed lists are sorted lexicographically', () => {
    const golden = new Map();
    const current = new Map([
      ['cli:command:bbb', meta('h1')],
      ['cli:command:aaa', meta('h2')],
    ]);
    const d = diffBehaviors(golden, current);
    assert.deepEqual(d.added, ['cli:command:aaa', 'cli:command:bbb']);
  });
});

describe('behaviorDiff: hash changed', () => {
  it('different hash, same effects → hashChanged with empty effect deltas', () => {
    const golden = new Map([['x', meta('h1', ['IO'], 5)]]);
    const current = new Map([['x', meta('h2', ['IO'], 7)]]);
    const d = diffBehaviors(golden, current);
    assert.equal(d.hashChanged.length, 1);
    const c = d.hashChanged[0];
    assert.equal(c.featureId, 'x');
    assert.equal(c.oldHash, 'h1');
    assert.equal(c.newHash, 'h2');
    assert.equal(c.oldCoreNodeCount, 5);
    assert.equal(c.newCoreNodeCount, 7);
    assert.deepEqual(c.effectsAdded, []);
    assert.deepEqual(c.effectsRemoved, []);
  });

  it('hash + effects both changed → captures both', () => {
    const golden = new Map([['x', meta('h1', ['IO', 'PURE'])]]);
    const current = new Map([['x', meta('h2', ['IO', 'ASYNC'])]]);
    const d = diffBehaviors(golden, current);
    assert.equal(d.hashChanged.length, 1);
    assert.deepEqual(d.hashChanged[0].effectsAdded, ['ASYNC']);
    assert.deepEqual(d.hashChanged[0].effectsRemoved, ['PURE']);
  });
});

describe('behaviorDiff: effects changed (same hash)', () => {
  it('same hash, different effects → effectsChangedSameHash', () => {
    const golden = new Map([['x', meta('h1', ['IO'])]]);
    const current = new Map([['x', meta('h1', ['IO', 'NETWORK_OUT'])]]);
    const d = diffBehaviors(golden, current);
    assert.equal(d.hashChanged.length, 0);
    assert.equal(d.effectsChangedSameHash.length, 1);
    assert.deepEqual(d.effectsChangedSameHash[0].effectsAdded, ['NETWORK_OUT']);
    assert.deepEqual(d.effectsChangedSameHash[0].effectsRemoved, []);
  });

  it('does not fire when both lists are equal', () => {
    const golden = new Map([['x', meta('h1', ['B', 'A'])]]);
    const current = new Map([['x', meta('h1', ['A', 'B'])]]);
    const d = diffBehaviors(golden, current);
    // setDiff sees identical sets despite different order.
    assert.equal(d.effectsChangedSameHash.length, 0);
  });
});

describe('behaviorDiff: deterministic ordering', () => {
  it('hashChanged sorted by featureId', () => {
    const golden = new Map([
      ['z', meta('hg1')],
      ['a', meta('hg2')],
      ['m', meta('hg3')],
    ]);
    const current = new Map([
      ['z', meta('hc1')],
      ['a', meta('hc2')],
      ['m', meta('hc3')],
    ]);
    const d = diffBehaviors(golden, current);
    const ids = d.hashChanged.map((c) => c.featureId);
    assert.deepEqual(ids, ['a', 'm', 'z']);
  });
});

describe('behaviorDiff: format includes hint context', () => {
  it('format string is multi-line and references each section', () => {
    const golden = new Map([['gone', meta('hg', ['IO'])]]);
    const current = new Map([['new', meta('hn')]]);
    const d = diffBehaviors(golden, current);
    const s = formatBehaviorDiff(d);
    assert.match(s, /Added features/);
    assert.match(s, /Removed features/);
  });
});
