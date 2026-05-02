// Tree-aware hue assignment — port of `sandbox/hex-sandbox/src/pack.js:assignTreeHues`.
//
// Slices the cyan-centred hue range [60°, 300°] hierarchically. Each
// folder occupies a sub-slice of its parent's range; siblings get
// adjacent sub-slices in deterministic order (sorted by name). Nested
// subtrees therefore stay visually grouped while individual folders
// keep distinct hues — fixes the "everything-is-blue" effect of a
// flat depth-warmed palette.
//
// Range [0°, 240°] = red → orange → yellow → green → cyan → blue.
// Skips magenta / purple (240°-360°) which felt heavy + monotone on
// the dark theme; the warm-to-cool sweep gives folders much more
// hue separation when there are many siblings.

import type { RegionTree } from '../store/layoutStore';

const HUE_START = 0;
const HUE_END = 240;
/** Golden-ratio conjugate. Maximises sibling hue contrast within a
 *  parent slice — when applied to consecutive child indices it spreads
 *  them out instead of stacking adjacent ones in similar hues, which
 *  was the visible bug at deep nesting (20+ children sharing a 12°
 *  slice all looked like the same colour). */
const PHI = 0.6180339887498949;
/** Depth-driven hue rotation (degrees). Each nesting level rotates the
 *  child mid-hue by this amount so deep grandchildren visibly diverge
 *  from their parent's local zone, giving "the deeper, the stronger
 *  the contrast" effect even after the parent slice has narrowed. */
const DEPTH_ROTATION = 47;

/**
 * Compute Map<regionId, hueDeg> from a region tree. Hues are stable
 * across calls for the same input tree (deterministic sort + recursion).
 *
 * Algorithm — recursive subdivide-and-spread:
 *   1. Each region gets a hue based on its parent's slice midpoint +
 *      a depth-driven rotation (so subtrees DON'T all sit in narrow
 *      slices that look monochrome at deep levels).
 *   2. Children within a parent are spread across the parent's slice
 *      via a golden-ratio offset (PHI), which gives maximum perceptual
 *      separation between consecutive siblings — far better than equal
 *      subdivision when there are many siblings.
 *
 * Returns an empty map when the tree has no roots.
 */
export function computeFolderHues(tree: RegionTree): Map<string, number> {
  const out = new Map<string, number>();
  if (tree.roots.length === 0) return out;

  const assign = (
    regionId: string,
    hueStart: number,
    hueEnd: number,
    depth: number,
  ): void => {
    const info = tree.byId.get(regionId);
    if (!info) return;
    const mid = (hueStart + hueEnd) / 2 + depth * DEPTH_ROTATION;
    out.set(regionId, ((mid % 360) + 360) % 360);
    const children = info.childIds
      .map((id) => tree.byId.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (children.length === 0) return;
    const span = hueEnd - hueStart;
    // Per-child slice width — narrow enough that children stay roughly
    // grouped under their parent at far zoom, wide enough that PHI
    // offset gives visible separation at deep zoom.
    const childWidth = span / Math.max(children.length, 1);
    for (let i = 0; i < children.length; i++) {
      // PHI-spread offset within the parent's slice — `(i * PHI) % 1`
      // returns values that are far apart for consecutive `i`.
      const t = ((i * PHI) % 1 + 1) % 1;
      const childMid = hueStart + t * span;
      const cs = childMid - childWidth / 2;
      const ce = childMid + childWidth / 2;
      assign(children[i].id, cs, ce, depth + 1);
    }
  };

  const totalSpan = HUE_END - HUE_START;
  for (let i = 0; i < tree.roots.length; i++) {
    const cs = HUE_START + (totalSpan * i) / tree.roots.length;
    const ce = HUE_START + (totalSpan * (i + 1)) / tree.roots.length;
    assign(tree.roots[i], cs, ce, 0);
  }
  return out;
}
