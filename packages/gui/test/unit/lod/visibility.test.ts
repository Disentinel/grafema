/**
 * Tests for DAI-22 Chunk-8 LOD visibility policy.
 *
 * Runs under `node --import tsx --test`. Pure functions only — no
 * Three.js, no stores.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  visibleAtZoom,
  symbolsVisibleAtZoom,
  effectiveDMax,
  pixelThreshold,
  hexAreaAtZoom,
  DEFAULT_LOD_POLICY,
  type LodPolicy,
} from '../../../src/lod/visibility.js';

// A cheap, permissive policy used when we want the pixel gate to be
// a no-op so we can isolate the depth/zoom logic.
const ALWAYS_PASS_SIZE: LodPolicy = {
  ...DEFAULT_LOD_POLICY,
  minVisiblePixels: 0,
};

// The opposite: everything fails the pixel gate regardless of zoom.
const ALWAYS_FAIL_SIZE: LodPolicy = {
  ...DEFAULT_LOD_POLICY,
  minVisiblePixels: Number.POSITIVE_INFINITY,
};

describe('effectiveDMax fallbacks', () => {
  it('clamps shallow trees (D_max < 9) up to at least 3', () => {
    assert.equal(effectiveDMax(0), 1); // degenerate → 1 to avoid div/0
    assert.equal(effectiveDMax(1), 3);
    assert.equal(effectiveDMax(2), 3);
    assert.equal(effectiveDMax(3), 3);
    assert.equal(effectiveDMax(5), 5); // mid-range unchanged
    assert.equal(effectiveDMax(8), 8);
  });

  it('passes mid-range 9..14 through untouched', () => {
    assert.equal(effectiveDMax(9), 9);
    assert.equal(effectiveDMax(14), 14);
  });

  it('caps very deep trees at 12', () => {
    assert.equal(effectiveDMax(15), 12);
    assert.equal(effectiveDMax(20), 12);
    assert.equal(effectiveDMax(100), 12);
  });
});

describe('hexAreaAtZoom', () => {
  it('returns zoom-zero area at zoom=0', () => {
    const a = hexAreaAtZoom(0);
    // Default hexPixelAtZoomZero = 1, area = (3*sqrt(3)/2)*1 ≈ 2.598
    assert.ok(a > 2 && a < 3);
  });
  it('is monotonically non-decreasing in zoom', () => {
    const vals = [0, 0.25, 0.5, 0.75, 1].map((z) => hexAreaAtZoom(z));
    for (let i = 1; i < vals.length; i++) {
      assert.ok(vals[i] >= vals[i - 1], `not monotonic at ${i}`);
    }
  });
  it('clamps zoom outside [0,1]', () => {
    assert.equal(hexAreaAtZoom(-1), hexAreaAtZoom(0));
    assert.equal(hexAreaAtZoom(2), hexAreaAtZoom(1));
  });
});

describe('pixelThreshold', () => {
  it('rejects regions with 0 leaves regardless of zoom', () => {
    assert.equal(pixelThreshold(1, { depth: 0, leafCount: 0 }), false);
  });
  it('passes large regions even at low zoom (default 64 px²)', () => {
    // With 100 leaves × ~2.6 px² = 260 px² > 64
    assert.equal(pixelThreshold(0, { depth: 0, leafCount: 100 }), true);
  });
  it('rejects tiny regions at low zoom', () => {
    // 1 leaf × ~2.6 px² = 2.6 px² < 64
    assert.equal(pixelThreshold(0, { depth: 0, leafCount: 1 }), false);
  });
  it('respects a custom minVisiblePixels override', () => {
    const policy = { ...DEFAULT_LOD_POLICY, minVisiblePixels: 1 };
    assert.equal(pixelThreshold(0, { depth: 0, leafCount: 1 }, policy), true);
  });
});

describe('visibleAtZoom (depth × zoom matrix)', () => {
  // Isolate depth logic by neutralising the size gate
  it('D_max=3: depth 0 visible from zoom=0, depth 1 from mid, depth 2 top', () => {
    const dMax = 3;
    // depth 0: depthNorm = 0, minZoom = 0.9  → needs zoom >= 0.9
    assert.equal(visibleAtZoom({ depth: 0, leafCount: 100 }, 1.0, dMax, ALWAYS_PASS_SIZE), true);
    assert.equal(visibleAtZoom({ depth: 0, leafCount: 100 }, 0.9, dMax, ALWAYS_PASS_SIZE), true);
    assert.equal(visibleAtZoom({ depth: 0, leafCount: 100 }, 0.5, dMax, ALWAYS_PASS_SIZE), false);

    // depth 1 @ dMax=3: depthNorm = 1/3, minZoom = 1 - 0.333 - 0.1 ≈ 0.566
    assert.equal(visibleAtZoom({ depth: 1, leafCount: 100 }, 1.0, dMax, ALWAYS_PASS_SIZE), true);
    assert.equal(visibleAtZoom({ depth: 1, leafCount: 100 }, 0.6, dMax, ALWAYS_PASS_SIZE), true);
    assert.equal(visibleAtZoom({ depth: 1, leafCount: 100 }, 0.3, dMax, ALWAYS_PASS_SIZE), false);

    // depth 2: depthNorm = 2/3, minZoom = 1 - 0.666 - 0.1 ≈ 0.233
    assert.equal(visibleAtZoom({ depth: 2, leafCount: 100 }, 0.3, dMax, ALWAYS_PASS_SIZE), true);
    assert.equal(visibleAtZoom({ depth: 2, leafCount: 100 }, 0.0, dMax, ALWAYS_PASS_SIZE), false);
  });

  it('D_max=9: deeper regions appear at lower zoom than D_max=3 case', () => {
    // depth 5 @ dMax=9 (effective 9): depthNorm = 5/9 ≈ 0.555, minZoom ≈ 0.344
    assert.equal(visibleAtZoom({ depth: 5, leafCount: 100 }, 0.4, 9, ALWAYS_PASS_SIZE), true);
    assert.equal(visibleAtZoom({ depth: 5, leafCount: 100 }, 0.3, 9, ALWAYS_PASS_SIZE), false);
  });

  it('D_max=15: clamped to 12 — depth 5 visible from same zoom as D_max=12', () => {
    // With effective dMax = 12, depth 5 depthNorm ≈ 0.416, minZoom ≈ 0.483
    assert.equal(visibleAtZoom({ depth: 5, leafCount: 100 }, 0.5, 15, ALWAYS_PASS_SIZE), true);
    assert.equal(visibleAtZoom({ depth: 5, leafCount: 100 }, 0.4, 15, ALWAYS_PASS_SIZE), false);
    // Same result for D_max=12 and D_max=20 — clamp behavior.
    assert.equal(
      visibleAtZoom({ depth: 5, leafCount: 100 }, 0.5, 20, ALWAYS_PASS_SIZE),
      visibleAtZoom({ depth: 5, leafCount: 100 }, 0.5, 12, ALWAYS_PASS_SIZE),
    );
  });

  it('size gate overrides depth — tiny region hidden even at high zoom', () => {
    // Depth predicate alone would say "visible" at max zoom, but the
    // pixel threshold is impossibly high so it's still hidden.
    assert.equal(
      visibleAtZoom({ depth: 0, leafCount: 100 }, 1.0, 3, ALWAYS_FAIL_SIZE),
      false,
    );
  });

  it('shallow tree fallback: depth 0 still gated at top zoom only', () => {
    // D_max=2 → effective 3. Depth 0 depthNorm = 0, minZoom = 0.9.
    assert.equal(visibleAtZoom({ depth: 0, leafCount: 50 }, 1.0, 2, ALWAYS_PASS_SIZE), true);
    assert.equal(visibleAtZoom({ depth: 0, leafCount: 50 }, 0.5, 2, ALWAYS_PASS_SIZE), false);
  });
});

describe('symbolsVisibleAtZoom', () => {
  it('default threshold = 0.9', () => {
    assert.equal(symbolsVisibleAtZoom(1.0), true);
    assert.equal(symbolsVisibleAtZoom(0.9), true);
    assert.equal(symbolsVisibleAtZoom(0.89), false);
    assert.equal(symbolsVisibleAtZoom(0), false);
  });
  it('honours a custom threshold', () => {
    const policy = { ...DEFAULT_LOD_POLICY, symbolZoomThreshold: 0.5 };
    assert.equal(symbolsVisibleAtZoom(0.5, policy), true);
    assert.equal(symbolsVisibleAtZoom(0.49, policy), false);
  });
});
