// Tree-aware hue assignment — port of `sandbox/hex-sandbox/src/pack.js:assignTreeHues`.
//
// Slices the cyan-centred hue range [60°, 300°] hierarchically. Each
// folder occupies a sub-slice of its parent's range; siblings get
// adjacent sub-slices in deterministic order (sorted by name). Nested
// subtrees therefore stay visually grouped while individual folders
// keep distinct hues — fixes the "everything-is-blue" effect of a
// flat depth-warmed palette.
//
// Range [60°, 300°] = green → cyan → blue → purple. Avoids wrap-around
// into red/orange which clashes with the dark theme.

import type { RegionTree } from '../store/layoutStore';

const HUE_START = 60;
const HUE_END = 300;

/**
 * Compute Map<regionId, hueDeg> from a region tree. Hues are stable
 * across calls for the same input tree (deterministic sort + recursion).
 *
 * Returns an empty map when the tree has no roots.
 */
export function computeFolderHues(tree: RegionTree): Map<string, number> {
  const out = new Map<string, number>();
  if (tree.roots.length === 0) return out;

  const assign = (regionId: string, hueStart: number, hueEnd: number): void => {
    const info = tree.byId.get(regionId);
    if (!info) return;
    const mid = (hueStart + hueEnd) / 2;
    out.set(regionId, ((mid % 360) + 360) % 360);
    const children = info.childIds
      .map((id) => tree.byId.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (children.length === 0) return;
    const span = hueEnd - hueStart;
    for (let i = 0; i < children.length; i++) {
      const cs = hueStart + (span * i) / children.length;
      const ce = hueStart + (span * (i + 1)) / children.length;
      assign(children[i].id, cs, ce);
    }
  };

  const totalSpan = HUE_END - HUE_START;
  for (let i = 0; i < tree.roots.length; i++) {
    const cs = HUE_START + (totalSpan * i) / tree.roots.length;
    const ce = HUE_START + (totalSpan * (i + 1)) / tree.roots.length;
    assign(tree.roots[i], cs, ce);
  }
  return out;
}
