/**
 * Unit tests for reduceSelection (Canvas focus/selection transitions).
 *
 * Pure state-transition logic extracted from Canvas.tsx event handlers.
 * No DOM or Three.js dependency — these tests run in plain Node.
 *
 * Rules under test:
 *  - click + target=null              → empty selection
 *  - click + target=N                 → {N} (replace)
 *  - shiftClick + N ∈ current         → current minus N (deselect)
 *  - shiftClick + N ∉ current         → current plus N (add)
 *  - shiftClick + target=null         → unchanged
 *  - ctrlClick                        → same as shiftClick (additive toggle)
 *  - drag + boxTargets=S              → union(current, S) (marquee adds)
 *
 * Invariants:
 *  - returned Set is NEVER the same instance as input (immutability)
 *  - deterministic: same input → same output
 *  - idempotent: click(empty, null) on empty → still empty
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reduceSelection, type FocusIntent, type SelectionSet } from '../../../src/controller/focus.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function sel(...ids: number[]): Set<number> {
  return new Set(ids);
}

function toSortedArray(s: ReadonlySet<number>): number[] {
  return [...s].sort((a, b) => a - b);
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('reduceSelection — click', () => {
  it('click on empty space clears selection', () => {
    const current: SelectionSet = sel(1, 2, 3);
    const intent: FocusIntent = { kind: 'click', target: null };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), []);
  });

  it('click on node replaces selection with just that node', () => {
    const current: SelectionSet = sel(1, 2, 3);
    const intent: FocusIntent = { kind: 'click', target: 42 };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [42]);
  });

  it('click on already-selected node still replaces to {N}', () => {
    const current: SelectionSet = sel(5, 7);
    const intent: FocusIntent = { kind: 'click', target: 5 };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [5]);
  });
});

describe('reduceSelection — shiftClick', () => {
  it('shiftClick on unselected node adds it', () => {
    const current: SelectionSet = sel(1, 2);
    const intent: FocusIntent = { kind: 'shiftClick', target: 5 };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 2, 5]);
  });

  it('shiftClick on selected node removes it', () => {
    const current: SelectionSet = sel(1, 2, 5);
    const intent: FocusIntent = { kind: 'shiftClick', target: 2 };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 5]);
  });

  it('shiftClick on empty space leaves selection unchanged', () => {
    const current: SelectionSet = sel(1, 2, 3);
    const intent: FocusIntent = { kind: 'shiftClick', target: null };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 2, 3]);
  });

  it('shiftClick from empty selection adds the target', () => {
    const current: SelectionSet = sel();
    const intent: FocusIntent = { kind: 'shiftClick', target: 7 };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [7]);
  });
});

describe('reduceSelection — ctrlClick', () => {
  it('ctrlClick on unselected node adds it (same as shiftClick)', () => {
    const current: SelectionSet = sel(1, 2);
    const intent: FocusIntent = { kind: 'ctrlClick', target: 5 };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 2, 5]);
  });

  it('ctrlClick on selected node removes it (toggle)', () => {
    const current: SelectionSet = sel(1, 2, 5);
    const intent: FocusIntent = { kind: 'ctrlClick', target: 2 };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 5]);
  });

  it('ctrlClick on empty space leaves selection unchanged', () => {
    const current: SelectionSet = sel(1, 2, 3);
    const intent: FocusIntent = { kind: 'ctrlClick', target: null };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 2, 3]);
  });
});

describe('reduceSelection — drag (marquee)', () => {
  it('drag adds boxTargets to current selection (union)', () => {
    const current: SelectionSet = sel(1, 2);
    const intent: FocusIntent = {
      kind: 'drag',
      target: null,
      boxTargets: sel(3, 4, 5),
    };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 2, 3, 4, 5]);
  });

  it('drag with overlapping boxTargets produces a union with no duplicates', () => {
    const current: SelectionSet = sel(1, 2, 3);
    const intent: FocusIntent = {
      kind: 'drag',
      target: null,
      boxTargets: sel(3, 4, 5),
    };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 2, 3, 4, 5]);
  });

  it('drag with empty boxTargets leaves selection unchanged (contents)', () => {
    const current: SelectionSet = sel(1, 2);
    const intent: FocusIntent = {
      kind: 'drag',
      target: null,
      boxTargets: sel(),
    };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 2]);
  });

  it('drag with no boxTargets field leaves selection unchanged (contents)', () => {
    const current: SelectionSet = sel(1, 2);
    const intent: FocusIntent = { kind: 'drag', target: null };
    const next = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(next), [1, 2]);
  });
});

describe('reduceSelection — invariants', () => {
  it('returned Set is never the same instance as input (immutability)', () => {
    const current = sel(1, 2, 3);
    const intents: FocusIntent[] = [
      { kind: 'click', target: null },
      { kind: 'click', target: 10 },
      { kind: 'shiftClick', target: 1 },
      { kind: 'shiftClick', target: 10 },
      { kind: 'shiftClick', target: null },
      { kind: 'ctrlClick', target: 1 },
      { kind: 'ctrlClick', target: 10 },
      { kind: 'ctrlClick', target: null },
      { kind: 'drag', target: null, boxTargets: sel(4, 5) },
      { kind: 'drag', target: null, boxTargets: sel() },
      { kind: 'drag', target: null },
    ];
    for (const intent of intents) {
      const next = reduceSelection(current, intent);
      assert.notStrictEqual(
        next,
        current,
        `returned Set must be a fresh instance for intent ${JSON.stringify(intent)}`,
      );
    }
  });

  it('does not mutate the input Set', () => {
    const current = sel(1, 2, 3);
    const snapshot = [...current].sort((a, b) => a - b);
    reduceSelection(current, { kind: 'click', target: 42 });
    reduceSelection(current, { kind: 'shiftClick', target: 2 });
    reduceSelection(current, { kind: 'ctrlClick', target: 99 });
    reduceSelection(current, { kind: 'drag', target: null, boxTargets: sel(7, 8) });
    assert.deepEqual([...current].sort((a, b) => a - b), snapshot);
  });

  it('is deterministic: same input → same output', () => {
    const current: SelectionSet = sel(1, 2, 3);
    const intent: FocusIntent = { kind: 'shiftClick', target: 10 };
    const a = reduceSelection(current, intent);
    const b = reduceSelection(current, intent);
    assert.deepEqual(toSortedArray(a), toSortedArray(b));
  });

  it('click(empty, null) is idempotent on empty selection', () => {
    let current: SelectionSet = sel();
    for (let i = 0; i < 3; i++) {
      current = reduceSelection(current, { kind: 'click', target: null });
      assert.deepEqual(toSortedArray(current), []);
    }
  });
});
