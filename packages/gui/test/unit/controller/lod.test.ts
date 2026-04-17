import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lodFromView, type CameraView, type LodLevel } from '../../../src/controller/lod.ts';

describe('lodFromView — perspective', () => {
  it('far distance → coarsest level (0)', () => {
    assert.equal(lodFromView({ kind: 'perspective', distance: 10000 }), 0);
  });

  it('very close distance → finest level (3)', () => {
    assert.equal(lodFromView({ kind: 'perspective', distance: 1 }), 3);
  });

  it('mid distance around directory threshold → level 1 or 2', () => {
    const lvl = lodFromView({ kind: 'perspective', distance: 200 });
    assert.ok(lvl === 1 || lvl === 2, `expected 1|2, got ${lvl}`);
  });

  it('monotonicity: larger distance never maps to finer LOD', () => {
    // Sample 100 distances in [1, 10000] (log-spaced to hit all bands)
    const distances: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = i / 99; // 0..1
      // Log-spaced from 1 to 10000 to sample all bands densely
      const d = Math.exp(Math.log(1) + t * (Math.log(10000) - Math.log(1)));
      distances.push(d);
    }
    // distances is non-decreasing; lod must be non-increasing (finer → coarser)
    let prev: LodLevel = lodFromView({ kind: 'perspective', distance: distances[0] });
    for (let i = 1; i < distances.length; i++) {
      const cur = lodFromView({ kind: 'perspective', distance: distances[i] });
      assert.ok(
        cur <= prev,
        `monotonicity violated at i=${i}: d=${distances[i]} lod=${cur}, prev d=${distances[i - 1]} lod=${prev}`,
      );
      prev = cur;
    }
  });

  it('all four levels are reachable across [1, 20000]', () => {
    const levels = new Set<LodLevel>();
    for (let d = 1; d <= 20000; d *= 1.1) {
      levels.add(lodFromView({ kind: 'perspective', distance: d }));
    }
    assert.deepEqual([...levels].sort(), [0, 1, 2, 3]);
  });
});

describe('lodFromView — orthographic', () => {
  it('returns a valid LOD level at sane defaults', () => {
    const lvl = lodFromView({ kind: 'orthographic', zoom: 1, frustumHeight: 1000 });
    assert.ok(lvl === 0 || lvl === 1 || lvl === 2 || lvl === 3);
  });

  it('doubling zoom moves toward finer LOD (or stays equal)', () => {
    const before = lodFromView({ kind: 'orthographic', zoom: 1, frustumHeight: 1000 });
    const after = lodFromView({ kind: 'orthographic', zoom: 2, frustumHeight: 1000 });
    assert.ok(after >= before, `expected LOD to increase or stay equal, before=${before} after=${after}`);
  });

  it('halving frustumHeight moves toward finer LOD (or stays equal)', () => {
    const before = lodFromView({ kind: 'orthographic', zoom: 1, frustumHeight: 1000 });
    const after = lodFromView({ kind: 'orthographic', zoom: 1, frustumHeight: 500 });
    assert.ok(after >= before, `expected LOD to increase or stay equal, before=${before} after=${after}`);
  });

  it('monotonicity over effective distance (frustumHeight / zoom)', () => {
    // Fix frustumHeight, sweep zoom from 0.1 to 100 (effective dist: 10000 → 10)
    const frustumHeight = 1000;
    const zooms: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = i / 99;
      // Log-spaced zoom 0.1..100 → effective 10000..10
      zooms.push(Math.exp(Math.log(0.1) + t * (Math.log(100) - Math.log(0.1))));
    }
    // zoom ascending → effective distance descending → lod non-decreasing
    let prev: LodLevel = lodFromView({ kind: 'orthographic', zoom: zooms[0], frustumHeight });
    for (let i = 1; i < zooms.length; i++) {
      const cur = lodFromView({ kind: 'orthographic', zoom: zooms[i], frustumHeight });
      assert.ok(
        cur >= prev,
        `monotonicity violated at i=${i}: zoom=${zooms[i]} lod=${cur}, prev zoom=${zooms[i - 1]} lod=${prev}`,
      );
      prev = cur;
    }
  });

  it('ortho at max zoom matches perspective at min distance (finest LOD)', () => {
    const perspMin = lodFromView({ kind: 'perspective', distance: 1 });
    const orthoMax = lodFromView({ kind: 'orthographic', zoom: 1000, frustumHeight: 1 });
    assert.equal(orthoMax, perspMin);
    assert.equal(perspMin, 3);
  });
});

describe('lodFromView — equivalence between perspective and orthographic', () => {
  it('ortho effectiveDistance = perspective distance → same LOD (mid-range)', () => {
    const D = 300; // lands in level 1 band
    const persp: CameraView = { kind: 'perspective', distance: D };
    // effective = frustumHeight / zoom = 300 → pick frustumHeight=600, zoom=2
    const ortho: CameraView = { kind: 'orthographic', zoom: 2, frustumHeight: 600 };
    const a = lodFromView(persp);
    const b = lodFromView(ortho);
    assert.equal(a, b, `persp d=${D} → ${a}, ortho h=600 z=2 (eff=300) → ${b}`);
  });

  it('ortho effectiveDistance = perspective distance → same LOD (coarse band)', () => {
    const D = 5000;
    const a = lodFromView({ kind: 'perspective', distance: D });
    const b = lodFromView({ kind: 'orthographic', zoom: 1, frustumHeight: D });
    assert.equal(a, b);
  });

  it('ortho effectiveDistance = perspective distance → same LOD (fine band)', () => {
    const D = 20;
    const a = lodFromView({ kind: 'perspective', distance: D });
    const b = lodFromView({ kind: 'orthographic', zoom: 5, frustumHeight: 100 });
    assert.equal(a, b);
  });
});
