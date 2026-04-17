/**
 * Tests for the TS port of the exact-boundary-trace hull algorithm
 * (originally in sandbox/hex-sandbox/src/hull.js).
 *
 * Acceptance:
 *  - single hex: 1 loop of 7 points (first == last).
 *  - 7-hex flower: 1 loop with ~24 points (12 boundary edges × 2 endpoints,
 *    de-duplicated where consecutive share a corner).
 *  - two disjoint islands: 2 loops.
 *  - ring with hole: 2 loops (outer + inner).
 *  - empty input: [].
 *  - linear row of 10: 1 loop.
 *  - parity with sandbox implementation on a shared fixture: same number
 *    of loops and same vertex set per loop (rotation-tolerant).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHullPolygons,
  computeHullPolygonsBatched,
} from '../../../src/geom/hull.js';
// Parity reference — the original JS implementation.
// Use relative import, not a tsconfig path alias, so node --test resolves it.
import { computeHullPolygons as refHull } from '../../../../../sandbox/hex-sandbox/src/hull.js';

type Loop = { x: number; y: number }[];

/** Canonicalise a loop: drop closing duplicate, then rotate so its
 * lexicographically-smallest vertex is first. Makes comparison
 * rotation-invariant. Winding direction is NOT normalised (the reference
 * always winds one way, so we can compare directly). */
function canonicalLoop(loop: Loop, quant = 1000): string {
  if (loop.length === 0) return '';
  // Drop closing vertex if it repeats the first.
  const pts = loop.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.abs(first.x - last.x) < 1 / quant && Math.abs(first.y - last.y) < 1 / quant) {
    pts.pop();
  }
  // Quantise to avoid float drift.
  const q = pts.map((p) => ({
    x: Math.round(p.x * quant) / quant,
    y: Math.round(p.y * quant) / quant,
  }));
  // Find rotation start: lexicographically smallest (x, then y).
  let best = 0;
  for (let i = 1; i < q.length; i++) {
    const a = q[i];
    const b = q[best];
    if (a.x < b.x || (a.x === b.x && a.y < b.y)) best = i;
  }
  const rotated = q.slice(best).concat(q.slice(0, best));
  return rotated.map((p) => `${p.x},${p.y}`).join('|');
}

/** Multiset of loops — order-independent. */
function canonicalLoopSet(loops: Loop[]): string[] {
  return loops.map((l) => canonicalLoop(l)).sort();
}

const SIZE = 3;

describe('hull: empty input', () => {
  it('returns []', () => {
    const loops = computeHullPolygons([], SIZE);
    assert.deepEqual(loops, []);
  });
});

describe('hull: single hex', () => {
  it('produces exactly 1 loop with 7 points (closed)', () => {
    const loops = computeHullPolygons([{ q: 0, r: 0 }], SIZE);
    assert.equal(loops.length, 1);
    assert.equal(loops[0].length, 7, 'single hex loop has 7 points (6 corners + closing)');
    // First and last should match (closed loop).
    const first = loops[0][0];
    const last = loops[0][loops[0].length - 1];
    assert.ok(Math.abs(first.x - last.x) < 1e-6);
    assert.ok(Math.abs(first.y - last.y) < 1e-6);
  });
});

describe('hull: 7-hex flower (center + 6 neighbours)', () => {
  it('produces 1 loop with ~24 points (18 unique + closing)', () => {
    const tiles = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ];
    const loops = computeHullPolygons(tiles, SIZE);
    assert.equal(loops.length, 1);
    // 18 boundary edges for a 7-hex flower (6 outer hexes × 3 outer sides each)
    // = 18 points + 1 closing. Sandbox may emit 19..24 depending on how it
    // traces; allow range.
    assert.ok(loops[0].length >= 19 && loops[0].length <= 30,
      `flower loop length: ${loops[0].length}`);
  });
});

describe('hull: two disjoint islands', () => {
  it('produces 2 loops', () => {
    const tiles = [
      { q: 0, r: 0 }, // far from island 2
      { q: 50, r: 0 }, // island 2
    ];
    const loops = computeHullPolygons(tiles, SIZE);
    assert.equal(loops.length, 2);
    for (const l of loops) {
      assert.equal(l.length, 7, 'each isolated hex is a 7-point loop');
    }
  });
});

describe('hull: ring with hole in center', () => {
  it('produces 2 loops (outer + inner)', () => {
    // 6-hex ring around (0,0): neighbours only, center missing.
    const tiles = [
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ];
    const loops = computeHullPolygons(tiles, SIZE);
    assert.equal(loops.length, 2, 'ring has outer hull + inner hole');
  });
});

describe('hull: linear row of 10 edge-connected hexes', () => {
  it('produces 1 loop', () => {
    // A straight E–W run along +q axis.
    const tiles = [];
    for (let q = 0; q < 10; q++) tiles.push({ q, r: 0 });
    const loops = computeHullPolygons(tiles, SIZE);
    assert.equal(loops.length, 1);
    // Row of 10 flat-top hexes: 10×6 sides − 2×9 shared = 42 boundary
    // edges, so ~42 vertices + 1 closing ≈ 43. Allow some slack for
    // tracer implementation details.
    assert.ok(loops[0].length >= 35 && loops[0].length <= 55,
      `row loop length: ${loops[0].length}`);
  });
});

describe('hull: parity with sandbox hull.js', () => {
  function parityCase(name: string, tiles: { q: number; r: number }[]) {
    it(name, () => {
      const ours = computeHullPolygons(tiles, SIZE);
      const theirs = refHull(tiles, SIZE);
      assert.equal(ours.length, theirs.length, 'loop count');
      const a = canonicalLoopSet(ours);
      const b = canonicalLoopSet(theirs);
      assert.deepEqual(a, b, 'canonical loop sets match');
    });
  }

  parityCase('single hex', [{ q: 0, r: 0 }]);
  parityCase('two islands', [{ q: 0, r: 0 }, { q: 20, r: 10 }]);
  parityCase('flower', [
    { q: 0, r: 0 },
    { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
    { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
  ]);
  parityCase('ring with hole', [
    { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
    { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
  ]);
  parityCase('row of 10', Array.from({ length: 10 }, (_, q) => ({ q, r: 0 })));
  parityCase('L-shape (concave)', [
    { q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 },
    { q: 0, r: 1 }, { q: 0, r: 2 },
  ]);
});

describe('hull: computeHullPolygonsBatched', () => {
  it('yields one result per region (via async iteration)', async () => {
    const regions = [
      { regionId: 'A', tiles: [{ q: 0, r: 0 }] },
      { regionId: 'B', tiles: [{ q: 10, r: 0 }] },
      { regionId: 'C', tiles: [] },
    ];
    const out: Array<{ regionId: string; loopCount: number }> = [];
    for await (const item of computeHullPolygonsBatched(regions, SIZE)) {
      out.push({ regionId: item.regionId, loopCount: item.loops.length });
    }
    assert.equal(out.length, 3);
    assert.deepEqual(
      out,
      [
        { regionId: 'A', loopCount: 1 },
        { regionId: 'B', loopCount: 1 },
        { regionId: 'C', loopCount: 0 },
      ],
    );
  });

  it('yielded loops match synchronous result', async () => {
    const tiles = [
      { q: 0, r: 0 }, { q: 1, r: 0 }, { q: 1, r: -1 },
    ];
    const regions = [{ regionId: 'only', tiles }];
    let yielded: Loop[] = [];
    for await (const item of computeHullPolygonsBatched(regions, SIZE)) {
      yielded = item.loops;
    }
    const direct = computeHullPolygons(tiles, SIZE);
    assert.deepEqual(canonicalLoopSet(yielded), canonicalLoopSet(direct));
  });
});
