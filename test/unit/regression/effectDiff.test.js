/**
 * Tests for effectDiff helper (REG-1117 Layer 4 helper).
 *
 * Pure-function tests. Verifies category assignment per effect class.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffEffects,
  effectDiffSize,
  effectEscalationCount,
  formatEffectDiff,
  ESCALATION_EFFECTS,
} from '@grafema/util/regression/effectDiff';

describe('effectDiff: empty inputs', () => {
  it('two empty maps → no changes', () => {
    const d = diffEffects(new Map(), new Map());
    assert.equal(effectDiffSize(d), 0);
    assert.equal(effectEscalationCount(d), 0);
    assert.equal(formatEffectDiff(d), 'No effect-surface changes vs golden.');
  });
});

describe('effectDiff: feature add/remove', () => {
  it('feature only in current → added', () => {
    const d = diffEffects(new Map(), new Map([['x', ['IO']]]));
    assert.deepEqual(d.added, ['x']);
  });

  it('feature only in golden → removed', () => {
    const d = diffEffects(new Map([['x', ['IO']]]), new Map());
    assert.deepEqual(d.removed, ['x']);
  });
});

describe('effectDiff: identical sets', () => {
  it('different order, same elements → no change', () => {
    const golden = new Map([['x', ['ASYNC', 'IO']]]);
    const current = new Map([['x', ['IO', 'ASYNC']]]);
    const d = diffEffects(golden, current);
    assert.equal(d.changed.length, 0);
  });
});

describe('effectDiff: escalation classification', () => {
  for (const effect of ESCALATION_EFFECTS) {
    it(`adding ${effect} → ESCALATION`, () => {
      const golden = new Map([['x', []]]);
      const current = new Map([['x', [effect]]]);
      const d = diffEffects(golden, current);
      assert.equal(d.changed.length, 1);
      assert.equal(d.changed[0].category, 'ESCALATION');
      assert.deepEqual(d.changed[0].added, [effect]);
      assert.equal(effectEscalationCount(d), 1);
    });
  }

  it('adding only IO (read class) → NOTE, not ESCALATION', () => {
    const golden = new Map([['x', []]]);
    const current = new Map([['x', ['IO']]]);
    const d = diffEffects(golden, current);
    assert.equal(d.changed[0].category, 'NOTE');
    assert.equal(effectEscalationCount(d), 0);
  });

  it('removing FS_WRITE → NOTE (only adds escalate)', () => {
    const golden = new Map([['x', ['FS_WRITE']]]);
    const current = new Map([['x', []]]);
    const d = diffEffects(golden, current);
    assert.equal(d.changed[0].category, 'NOTE');
    assert.deepEqual(d.changed[0].removed, ['FS_WRITE']);
  });

  it('add IO + add FS_WRITE → ESCALATION (because of FS_WRITE)', () => {
    const golden = new Map([['x', []]]);
    const current = new Map([['x', ['FS_WRITE', 'IO']]]);
    const d = diffEffects(golden, current);
    assert.equal(d.changed[0].category, 'ESCALATION');
  });
});

describe('effectDiff: deterministic ordering', () => {
  it('changed list sorted by featureId; effect arrays sorted', () => {
    const golden = new Map([
      ['z', ['IO']],
      ['a', ['IO']],
    ]);
    const current = new Map([
      ['z', ['IO', 'ASYNC']],
      ['a', ['IO', 'NETWORK_IN']],
    ]);
    const d = diffEffects(golden, current);
    assert.deepEqual(
      d.changed.map((c) => c.featureId),
      ['a', 'z'],
    );
    // Each `added` array sorted.
    assert.deepEqual(d.changed[0].added, ['NETWORK_IN']);
    assert.deepEqual(d.changed[1].added, ['ASYNC']);
  });
});

describe('effectDiff: format', () => {
  it('non-empty diff produces multi-line report with category labels', () => {
    const d = diffEffects(
      new Map([['gone', ['IO']]]),
      new Map([['x', ['FS_WRITE']]]),
    );
    const s = formatEffectDiff(d);
    assert.match(s, /Added features/);
    assert.match(s, /Removed features/);
  });
});
