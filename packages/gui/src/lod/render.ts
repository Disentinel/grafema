/**
 * DAI-22 Chunk-8b — Per-frame rendering wiring for LOD visibility.
 *
 * Pure helpers that consume `layoutStore.{regionTree,hullCache}` plus the
 * current camera zoom and return exactly what the Three.js render layers
 * need to draw for this frame:
 *
 *   - `visibleHulls`  — which regions' polygons should be on-screen,
 *                       sorted by depth ASC so deeper hulls render last
 *                       (painter's algorithm — deeper = on top).
 *   - `symbolsVisible` — whether the instanced symbol layer should draw
 *                        at all (true only at top zoom).
 *
 * The helpers are intentionally pure — no store subscriptions, no Three
 * imports — so they are trivial to unit-test and cheap to call per-frame.
 * Consumers (HullLayer / HexLayer wiring in `canvasBuild.ts`) read the
 * zustand stores once per frame and hand the snapshot to these helpers.
 *
 * Camera-zoom normalisation follows the same boundaries `controller/lod.ts`
 * uses for LOD-band selection, so the hull depth sweep aligns with the
 * existing label-density bands:
 *   perspective.distance    ortho effective dist    zoom01
 *     ≤ 35                    ≤ 35                    1.00
 *     = 110                   = 110                   0.67
 *     = 500                   = 500                   0.33
 *     ≥ 2000 (clamp)          ≥ 2000                  0.00
 *
 * The mapping is piecewise-linear between those anchors. Anchors chosen
 * to match `LOD_THRESHOLD_{PACKAGE,DIRECTORY,FILE}` in controller/lod.ts
 * so the four label bands and the nine hull depth bands stay coherent.
 */

import type { CameraView } from '../controller/lod.js';
import type { HullGeometry } from '../hulls/computeHulls.js';
import type { RegionInfo, RegionTree } from '../store/layoutStore.js';
import {
  DEFAULT_LOD_POLICY,
  symbolsVisibleAtZoom,
  visibleAtZoom,
  type LodPolicy,
} from './visibility.js';

// ---------------------------------------------------------------------------
// Zoom normalisation — CameraView → zoom01 in [0, 1]
// ---------------------------------------------------------------------------

/** Effective distance anchors (world units) matched to controller/lod.ts. */
const ANCHOR_MAX_DISTANCE = 2000; // fully zoomed-out clamp
const ANCHOR_FAR = 500;
const ANCHOR_MID = 110;
const ANCHOR_NEAR = 35;

/** Piecewise-linear interpolator for distance → zoom01. */
function distanceToZoom01(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 1;
  if (distance >= ANCHOR_MAX_DISTANCE) return 0;
  if (distance >= ANCHOR_FAR) {
    // [ANCHOR_FAR, ANCHOR_MAX_DISTANCE] → [0.33, 0]
    const t = (distance - ANCHOR_FAR) / (ANCHOR_MAX_DISTANCE - ANCHOR_FAR);
    return 0.33 * (1 - t);
  }
  if (distance >= ANCHOR_MID) {
    // [ANCHOR_MID, ANCHOR_FAR] → [0.67, 0.33]
    const t = (distance - ANCHOR_MID) / (ANCHOR_FAR - ANCHOR_MID);
    return 0.67 - 0.34 * t;
  }
  if (distance >= ANCHOR_NEAR) {
    // [ANCHOR_NEAR, ANCHOR_MID] → [1.0, 0.67]
    const t = (distance - ANCHOR_NEAR) / (ANCHOR_MID - ANCHOR_NEAR);
    return 1.0 - 0.33 * t;
  }
  // distance < ANCHOR_NEAR: fully zoomed-in.
  return 1;
}

/**
 * Camera-kind-aware normalisation. Perspective uses the camera-to-target
 * distance directly; orthographic uses the standard effective distance
 * (`frustumHeight / zoom`) — same transform `controller/lod.ts` uses
 * for its band selection, so the two layers agree on what "zoomed in"
 * means.
 */
export function normalizeZoom(view: CameraView): number {
  if (view.kind === 'perspective') return distanceToZoom01(view.distance);
  if (view.zoom <= 0) return 0;
  return distanceToZoom01(view.frustumHeight / view.zoom);
}

// ---------------------------------------------------------------------------
// Region list + depth computation
// ---------------------------------------------------------------------------

/** One entry in the derived visibility list — ready for HullLayer to draw. */
export interface VisibleHullEntry {
  regionId: string;
  region: RegionInfo;
  geometry: HullGeometry;
}

/** Max observed depth across the tree — fed to `visibleAtZoom` via effectiveDMax. */
export function computeDMax(tree: RegionTree): number {
  let max = 0;
  for (const info of tree.byId.values()) {
    if (info.depth > max) max = info.depth;
  }
  return max;
}

/**
 * Full frame-state helper used by both HullLayer and HexLayer wiring.
 *
 * Walks every region in `regionTree`, pairs it with its cached polygon set
 * from `hullCache`, and filters by `visibleAtZoom(region, zoom01, D_max)`.
 * Uses `HullGeometry.area` as `leafCount` — the hex-cell count post-close
 * is a fair proxy for "how much screen space this region paints".
 *
 * Output is sorted by depth ASC so callers can render in order and deeper
 * (smaller) hulls end up on top of shallower (larger) parents — the
 * painter's-algorithm z-order the plan calls for.
 */
export function deriveLodVisibility(params: {
  regionTree: RegionTree;
  hullCache: Map<string, HullGeometry>;
  zoom01: number;
  policy?: LodPolicy;
}): { visibleHulls: VisibleHullEntry[]; symbolsVisible: boolean } {
  const { regionTree, hullCache, zoom01 } = params;
  const policy = params.policy ?? DEFAULT_LOD_POLICY;
  const dMax = computeDMax(regionTree);

  const candidates: VisibleHullEntry[] = [];
  for (const [regionId, geometry] of hullCache) {
    const region = regionTree.byId.get(regionId);
    if (region === undefined) continue; // stale cache entry — drop
    const like = { depth: region.depth, leafCount: geometry.area };
    if (!visibleAtZoom(like, zoom01, dMax, policy)) continue;
    candidates.push({ regionId, region, geometry });
  }

  // Stable sort by depth ASC (shallower first → deeper drawn last → on top).
  // JS sort is stable in all modern runtimes. Ties keep insertion order.
  candidates.sort((a, b) => a.region.depth - b.region.depth);

  return {
    visibleHulls: candidates,
    symbolsVisible: symbolsVisibleAtZoom(zoom01, policy),
  };
}
