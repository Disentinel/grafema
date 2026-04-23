/**
 * DAI-22 Chunk-8 — Depth-aware LOD visibility policy.
 *
 * Given a region and the current zoom level, decides whether the region's
 * hull should render. Also decides the symbol-layer zoom gate. All
 * functions are pure — no store access, no side effects — so they're
 * trivial to unit-test and cheap to call per-frame.
 *
 * Policy (from plan §C.3):
 *   depthNorm = region.depth / max(1, D_max)
 *   minZoom   = 1 - depthNorm - 0.1         // deeper appear later
 *   sizeOK    = leafCount * hexArea(zoom) >= MIN_VISIBLE_PIXELS
 *   visible   = zoom >= minZoom && sizeOK
 *
 * Symbols are gated at a single top-zoom threshold (default 0.9).
 *
 * D_max fallbacks:
 *   - D_max <  9  — shallow codebase. Collapse thresholds so at least
 *                   3 depth bands are visible at any zoom >= 0 (min
 *                   visible bands = 3). Achieved by clamping the
 *                   effective D_max floor to 3.
 *   - D_max >= 15 — very deep. Clamp the effective D_max to 12 so
 *                   ultra-deep regions collapse into their parent at
 *                   low zoom (i.e. they all share a minZoom once the
 *                   normalisation saturates).
 *
 * The "zoom" scalar is consumer-defined and should live in [0, 1] where
 * 0 = fully zoomed-out (fit-all) and 1 = fully zoomed-in. Callers that
 * work in distance/FOV units should normalise before calling.
 */
export interface LodPolicy {
  /** Pixel-area threshold for a region to remain visible. Default 64. */
  minVisiblePixels: number;
  /** Symbol-layer zoom gate; symbols render only when zoom >= this. */
  symbolZoomThreshold: number;
  /** Hex radius at zoom=0 — pixels per tile at the most-zoomed-out view. */
  hexPixelAtZoomZero: number;
  /** Hex radius at zoom=1 — pixels per tile when fully zoomed-in. */
  hexPixelAtZoomOne: number;
}

export const DEFAULT_LOD_POLICY: LodPolicy = {
  minVisiblePixels: 64,
  symbolZoomThreshold: 0.9,
  hexPixelAtZoomZero: 1,
  hexPixelAtZoomOne: 24,
};

/** Minimal shape required — keeps this module independent of layoutStore. */
export interface RegionLike {
  depth: number;
  leafCount: number;
}

/**
 * Per-tile pixel area at a given zoom, linearly interpolated between
 * the policy's zoom-zero and zoom-one hex radii. Regular hex area =
 * (3*sqrt(3)/2) * r^2 where r is the centre-to-corner distance.
 */
export function hexAreaAtZoom(zoom: number, policy: LodPolicy = DEFAULT_LOD_POLICY): number {
  const z = Math.max(0, Math.min(1, zoom));
  const r = policy.hexPixelAtZoomZero + (policy.hexPixelAtZoomOne - policy.hexPixelAtZoomZero) * z;
  return (3 * Math.sqrt(3) / 2) * r * r;
}

/**
 * Effective max depth used for normalisation. Clamps the raw tree
 * observed D_max per the fallback rules.
 */
export function effectiveDMax(observedDMax: number): number {
  if (observedDMax < 1) return 1;
  if (observedDMax < 9) {
    // Ensure >= 3 visible depth bands — the floor of 3 on normalised
    // denominator gives us bands for depths 0, 1, 2 even when the real
    // tree is only a handful of levels.
    return Math.max(3, observedDMax);
  }
  if (observedDMax >= 15) return 12;
  return observedDMax;
}

/**
 * `leafCount * hexArea(zoom) >= minVisiblePixels` → big enough to paint.
 * Pulled out as a helper so tests can exercise pixel-area logic directly.
 */
export function pixelThreshold(
  zoom: number,
  region: RegionLike,
  policy: LodPolicy = DEFAULT_LOD_POLICY,
): boolean {
  if (region.leafCount <= 0) return false;
  return region.leafCount * hexAreaAtZoom(zoom, policy) >= policy.minVisiblePixels;
}

/**
 * Main LOD predicate — should this region render at the given zoom?
 *
 * @param region      The region under test (just needs depth + leafCount).
 * @param zoom        Normalised zoom in [0, 1].
 * @param dMax        Observed max depth across the tree.
 * @param policy      Optional override (defaults: 64 px², symbols @ zoom >= 0.9).
 */
export function visibleAtZoom(
  region: RegionLike,
  zoom: number,
  dMax: number,
  policy: LodPolicy = DEFAULT_LOD_POLICY,
): boolean {
  const dMaxEff = effectiveDMax(dMax);
  const depthNorm = region.depth / dMaxEff;
  const minZoom = 1.0 - depthNorm - 0.1;
  if (zoom < minZoom) return false;
  return pixelThreshold(zoom, region, policy);
}

/**
 * Symbol-layer gate. Symbols (leaves) render only at top zoom — below
 * the policy threshold the instanced mesh should be hidden entirely.
 */
export function symbolsVisibleAtZoom(
  zoom: number,
  policy: LodPolicy = DEFAULT_LOD_POLICY,
): boolean {
  return zoom >= policy.symbolZoomThreshold;
}
