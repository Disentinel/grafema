/**
 * Level-of-detail (LOD) computation for the hex map.
 *
 * Pure logic, no Three.js imports. Drives label visibility, tile density,
 * and edge thinning from the current camera view. Supports both the
 * legacy perspective camera and the new orthographic 2D mode where
 * "distance" is meaningless — only `zoom` and `frustumHeight` are
 * available.
 *
 * Thresholds were extracted from `components/Labels.tsx`, which tiers
 * labels by `minDist`:
 *   - package / external   visible while distance ≤ 500
 *   - depth-3 region       visible while distance ≤ 220, hidden beyond ~110 gap
 *   - module / class       visible while distance ≤ 60
 *   - function / method    visible while distance ≤ 35
 *   - variable / constant  visible while distance ≤ 30
 *
 * Collapsed to four LOD bands (matching `mapStore.lodLevel`):
 *   0 = Package    (dist > 500)        — only package blobs + external labels
 *   1 = Directory  (500 ≥ dist > 110)  — adds depth-3 region labels
 *   2 = File       (110 ≥ dist > 35)   — adds module/class labels
 *   3 = Function   (dist ≤ 35)         — adds function/variable labels
 *
 * For an orthographic camera, the effective on-screen "distance" is
 * `frustumHeight / zoom`. Zooming in (higher zoom) OR using a smaller
 * frustum both shrink the effective distance, so the same bands apply.
 */

export type CameraView =
  | { kind: 'perspective'; distance: number }
  | { kind: 'orthographic'; zoom: number; frustumHeight: number };

/** 0 = coarsest (package), 3 = finest (function). */
export type LodLevel = 0 | 1 | 2 | 3;

/** Distance thresholds in world units, coarse → fine. */
const LOD_THRESHOLD_PACKAGE = 500;
const LOD_THRESHOLD_DIRECTORY = 110;
const LOD_THRESHOLD_FILE = 35;

/**
 * Map an effective distance to an LOD band. Larger distance → coarser LOD.
 * Boundaries are `> threshold` so that at exactly the threshold value we
 * already snap to the finer band (matching Labels.tsx `dist > minDist`).
 */
function lodFromEffectiveDistance(distance: number): LodLevel {
  if (distance > LOD_THRESHOLD_PACKAGE) return 0;
  if (distance > LOD_THRESHOLD_DIRECTORY) return 1;
  if (distance > LOD_THRESHOLD_FILE) return 2;
  return 3;
}

/**
 * Compute the LOD level for a camera view.
 *
 * Monotonicity invariant: for two views of the same kind, if view `a` is
 * "zoomed in more" than view `b` (smaller effective distance), then
 * `lodFromView(a) >= lodFromView(b)`. Zooming in never returns to a
 * coarser LOD.
 */
export function lodFromView(view: CameraView): LodLevel {
  if (view.kind === 'perspective') {
    return lodFromEffectiveDistance(view.distance);
  }
  // Orthographic: effective distance = frustumHeight / zoom.
  // Guard against zoom = 0 (degenerate) — treat as infinitely far out.
  if (view.zoom <= 0) return 0;
  const effective = view.frustumHeight / view.zoom;
  return lodFromEffectiveDistance(effective);
}
