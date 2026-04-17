---
name: hex-grid-morphological-close-hull
description: |
  Compute a unified outer hull around a group of hex tiles that includes
  multiple disconnected sub-clusters separated by 1-tile gaps. Use when:
  (1) rendering nested hierarchy hulls (e.g. "package" hull wrapping
  multiple "sub-region" hex islands), (2) the naive boundary trace
  outlines each island separately instead of as one bag, (3) flood-fill
  from outside walks THROUGH the 1-hex gaps and marks them exterior,
  (4) heuristic "non-adjacent same-group neighbours" over-fills L-shape
  concavities, (5) axial-only opposite-pair filling misses non-axial
  bridges between islands. Solution: morphological close (dilate + erode)
  on the hex grid — fills exactly the interior 1-hex gaps without
  affecting exterior corners, then trace boundary on the closed shape.
author: Claude Code
version: 1.0.0
date: 2026-04-08
---

# Hex Grid Morphological Close for Hierarchical Hulls

## Problem

You have a hex tile layout where regions are grouped into hierarchies
(e.g. files → sub-directories → packages). At a higher hierarchy level
you want to draw ONE outer hull around a "package" — a group composed
of several disconnected "sub-region" tile islands separated by exactly
one empty hex (the gap rule enforced by your layout).

The naive approach — for each tile in the group, emit hex sides whose
neighbours are NOT in the group — outlines each sub-region separately,
not the whole package as one bag. The user sees N small outlines per
package instead of one wrapping shape.

Several "obvious" fixes don't work:

1. **Flood-fill from outside, mark unreached cells as interior**
   Fails because the BFS walks THROUGH the 1-hex gap between two
   sub-region islands of the same package and marks the gap cell as
   exterior. The package hull then still wraps each island separately.

2. **Heuristic "≥2 same-group neighbours on non-adjacent slots"**
   Over-fills cells at L-shape concavities of the group: a tile at the
   inner corner of an L has same-group neighbours on slots 2 apart and
   gets falsely marked as interior, producing a bumpy hull that bulges
   into exterior space.

3. **Heuristic "axial opposite pair (slots 0+3 / 1+4 / 2+5)"**
   Catches straight-line 1-tile bridges between sub-regions but misses
   bridges that aren't perfectly aligned with a hex axis. Many bridges
   fail this check, leaving sub-regions wrapped separately.

## Context / Trigger Conditions

- Computing a "super-hull" for a group of hex tiles that contains
  multiple disconnected sub-clusters, where the disconnections are
  intentional 1-hex gaps (e.g. enforced by a `canClaim` rule that
  forbids tiles of different sub-regions from touching).
- Rendering nested hierarchy outlines: thin sub-region hulls + thick
  "package" hulls that should wrap many sub-region islands.
- Naive `for each tile, emit boundary sides` produces N outlines per
  group instead of 1.
- Flood-fill-from-outside marks the bridge cells as exterior because
  the BFS legitimately walks through them.
- Per-tile heuristics over-fill L-corners or under-fill non-axial
  bridges.
- Visual symptom: package hull is "torn" — some sub-regions of the
  same package are wrapped, others are not, or the hull has zigzag
  ribbon patterns where it bridges some islands but not others.

## Solution

Use **morphological closing** on the tile set before tracing the
boundary. Closing is `erode(dilate(S))` and has exactly the property
we need: it fills interior holes/gaps up to a specified radius without
affecting the exterior.

For a 1-hex gap, ONE iteration of close is enough.

```ts
// Step 1: dilate
//   dilatedSet = group ∪ {all 6-hex neighbours of every group tile}
const dilatedKeys = new Set<string>(groupKeys);
const dilatedPositions = [...groupTiles];
for (const t of groupTiles) {
  for (let i = 0; i < 6; i++) {
    const nx = t.x + sideOffsets[i].dx;
    const nz = t.z + sideOffsets[i].dz;
    const k = tileKey(nx, nz);
    if (!dilatedKeys.has(k)) {
      dilatedKeys.add(k);
      dilatedPositions.push({ x: nx, z: nz });
    }
  }
}

// Step 2: erode
//   keep only cells whose ALL 6 neighbours are in the dilated set
const survivors: { x: number; z: number }[] = [];
for (const c of dilatedPositions) {
  let allIn = true;
  for (let i = 0; i < 6; i++) {
    const nk = tileKey(c.x + sideOffsets[i].dx, c.z + sideOffsets[i].dz);
    if (!dilatedKeys.has(nk)) { allIn = false; break; }
  }
  if (allIn) survivors.push(c);
}

// Survivors = original group ∪ filled 1-hex interior gaps.
// Use survivors as the "augmented group" for boundary tracing.
const augmentedKeys = new Set(survivors.map(c => tileKey(c.x, c.z)));
const boundary = computeBoundary(survivors, k => augmentedKeys.has(k));
```

### Why this works

For each cell in the dilated set, ask "do all 6 neighbours land in the
dilated set?":

- **Original group tile**: yes — all its neighbours are in the dilated
  set (because they were either originally in the group or got added
  by dilation as neighbours of this tile). **Survives.**
- **Outer ring tile** (added by dilation, on the convex perimeter):
  no — at least one of its neighbours is exterior empty space far from
  any group tile. **Removed by erosion.**
- **Interior 1-hex gap tile** (added by dilation, surrounded by group):
  yes — every neighbour is either an original group tile OR another
  dilated-from-the-other-side gap tile. **Survives.**

Result: original group + interior 1-hex gap fills. Exactly what hull
boundary tracing needs to render multiple islands as one bag.

### Properties

- **Correct for any concave shape**: doesn't depend on axis alignment
  or special-case heuristics.
- **Handles any 1-hex gap orientation**: the bridge can be at any of
  the 3 hex axes; closing closes them all.
- **Doesn't fill 2-hex gaps**: a 2-hex-wide channel survives because
  the middle cell still has 2+ neighbours OUTSIDE the dilated set. If
  you need to bridge wider gaps, run `close` N times where N = half
  the max gap width.
- **Doesn't bulge exterior**: outer ring cells get eroded back. The
  result is the SAME as the original on the convex perimeter and
  ONLY changes interior gap cells.
- **O(N × 6)** per pass — cheap.

## Verification

1. Count boundary segments per group BEFORE and AFTER applying close.
   For a clean closed perimeter, segment count should drop dramatically
   (e.g. 6900 → 1367 in our test) and approach the actual perimeter
   length, not `tile_count × 6`.

2. Visualize: each group should have ONE closed polygon (or N polygons
   if there are multiple connected components separated by gaps wider
   than 1 hex). No "ribbon" or "torn" sections.

3. Test on a simple synthetic case:
   ```
   X X X . X X X
   ```
   Two 3-tile groups separated by 1 empty hex. After close: the gap
   gets filled, the boundary is one closed polygon wrapping all 7
   positions. Without close: two separate polygons.

## Example

In `packages/gui/src/three/HullLayer.ts`, `findInteriorGaps` is
implemented exactly as above. Used for the package-level hull layer
(elevation 1.2, white, thicker line) on top of per-sub-region hulls
(elevation 0.4, grey, thinner line). The package hull wraps all
sub-region islands of one package as a single bag because the 1-hex
gaps between sub-region tiles get filled by morphological close.

```ts
// Package hull (top layer, fills interior gaps)
new HullLayer([...pkgGroupsMap.values()], {
  hexSize: TILE_SIZE,
  elevation: 1.2,
  color: 0xffffff,
  linewidth: 2.5,
  fillInteriorGaps: true, // ← runs morphological close
}, scene);

// Sub-region hull (bottom layer, raw boundaries — no fill)
new HullLayer([...subGroupsMap.values()], {
  hexSize: TILE_SIZE,
  elevation: 0.4,
  color: 0x666666,
  linewidth: 1,
  // no fillInteriorGaps — each sub-region traced separately
}, scene);
```

For 575 tiles across 39 packages and 104 sub-regions:
- Without close: package layer had per-tile boundary count, ~6900
  segments total
- With close: 1367 segments total — close to the actual sum of package
  perimeters

## Notes

- **Image processing roots**: this is the standard "closing" operation
  from binary morphology, applied to a hex grid instead of a square
  pixel grid. The "structuring element" is the 6-neighbour hex disk.
- **Multiple iterations**: run close N times to bridge gaps up to 2N-1
  hexes wide. For 1-hex gaps (the canClaim default), N=1 suffices.
- **Don't render the gap fill**: the morphological close output is
  used ONLY for boundary tracing, not for actual tile rendering. The
  gap cells remain visually empty between sub-region islands; only the
  package hull line wraps around them.
- **Tile coordinate alignment**: the dilation step uses precomputed
  6-direction offsets (`sideOffsets`) that must match the exact world-
  coordinate spacing produced by your `cubeToWorld()` (or equivalent).
  Tile-key rounding tolerance must be tight enough to distinguish
  adjacent hex centers but loose enough to absorb floating-point drift
  (2 decimal places works for typical 1.0–10.0 unit hex sizes).
- **Don't combine with flood-fill**: the previous failed approach used
  flood-fill from outside as a "ground truth" for interior detection.
  Morphological close REPLACES that — flood-fill is incorrect for the
  use case where intentional gaps exist between same-group tiles.
- **Per-edge segment rendering**: even with the correct closed shape,
  rendering each boundary edge as an INDEPENDENT line segment can
  produce visible corner artifacts where segments meet. If this is a
  problem, post-process the boundary edges into closed polylines and
  render with `Line2 + LineGeometry` (continuous polyline) instead of
  `LineSegments2 + LineSegmentsGeometry`.
- **Related skill**: `hex-grid-sequential-bfs-layout` covers the
  initial tile placement that produces the 1-hex gaps in the first
  place. This skill is the visualization counterpart for those layouts.

## Related Files

- `packages/gui/src/three/HullLayer.ts:findInteriorGaps` — the
  morphological close implementation
- `packages/gui/src/three/HullLayer.ts:computeGroupBoundary` — boundary
  tracing on the augmented (closed) tile set
- `packages/gui/src/components/Canvas.tsx` — wires sub-region and
  package hulls at different elevations
- `.claude/skills/hex-grid-sequential-bfs-layout/SKILL.md` — sibling
  skill on sequential placement
- `.claude/skills/hex-grid-sa-o1-connectivity/SKILL.md` — another
  hex-grid layout skill

## References

- Morphological image processing: dilation, erosion, opening, closing
  ([Wikipedia](https://en.wikipedia.org/wiki/Mathematical_morphology))
- Hex grid coordinates and neighbour math
  ([Red Blob Games hexagonal grids](https://www.redblobgames.com/grids/hexagons/))
