---
name: hex-grid-sequential-bfs-layout
description: |
  Fix scattered/torn regions in hex-grid simulated annealing layouts that
  use "competitive flood-fill" (one tile per region per outer iteration).
  Use when: (1) regions of >20 tiles end up dispersed instead of forming
  compact blobs, (2) maxDist/sqrt(N) dispersion ratio is 10×+ worse than
  the ideal compact blob, (3) tiles assigned to one region show up in
  multiple disconnected fragments across the layout, (4) the visualization
  has a "trypophobia ring" pattern at the perimeter where some regions
  spill into a perimeter spiral, (5) an overflow spiral fallback exists
  in the layout code and frequently kicks in for large regions, (6) bigger
  regions look worse than smaller ones (small regions stay compact, big
  ones shred). Root cause: interleaved competitive flood-fill (round-robin
  one tile at a time across all regions) lets large regions get boxed in
  by neighbors before they finish growing — the unfilled remainder is
  dumped into the overflow spiral at the perimeter, far from the seed.
  Fix: replace with sequential region-by-region BFS — process regions in
  size-descending order, fully claim each region's N contiguous tiles
  before moving to the next.
author: Claude Code
version: 1.0.0
date: 2026-04-07
---

# Hex Grid Sequential BFS Layout

## Problem

A hex-grid SA layout uses competitive flood-fill where each "iteration"
gives every region one tile. The intent is fairness — every region grows
at the same rate. The reality on graphs with 30+ regions of varying sizes:

- The biggest region (e.g. 76 tiles) gets a couple of tiles per iteration,
  same as the smallest (4 tiles).
- After ~20 iterations the small regions are done. Their final tiles form
  a wall around the big region's seed.
- The big region is now boxed in by claimed tiles in every direction. It
  can't grow further with the gap rule (canClaim) blocking foreign-region
  neighbors.
- The flood-fill loop finishes leaving the big region with maybe 15 of its
  76 needed tiles.
- Code falls back to an "overflow spiral" — placing the remaining 61 tiles
  in a hex spiral at radius `max(|q|,|r|) + 3` from origin, FAR from the
  region seed.
- Result: 15 tiles of the region near the seed, 61 tiles scattered around
  the perimeter. The visual is a "ring of mixed colors" instead of
  distinct color blobs.

This bug is hard to spot because:

1. It only manifests above some region count threshold (~30+ regions).
2. SA migration moves don't fix it (they preserve connectivity but can't
   teleport perimeter tiles back to the seed cluster).
3. The render shows 39 "good" small blobs and looks plausible until you
   measure dispersion.
4. Small graphs (fixtures with <20 regions) work fine, masking the bug
   in tests.

## Context / Trigger Conditions

- Hex SA layout in TS/JS, region-coloring view (one color per region).
- Regions are paths like `packages/util` or `src/api/users`.
- Visualization shows tiles forming concentric rings instead of distinct
  blocky regions.
- `regionTiles[regionName]` (the tiles claimed for one region) contains
  coordinates spread across the entire grid extent rather than clustered
  around the region's seed.
- A diagnostic that computes per-region centroid + maxDist from centroid
  shows ratios `maxDist / sqrt(tileCount) >> sqrt(TILE_SIZE)`. For a
  perfect blob the ratio should be ≈ TILE_SIZE in world coords (≈1 in
  tile coords).
- The layout code has an `overflow spiral` block that places "unplaced
  nodes" in a hex spiral starting from `overflowRadius`.
- Smaller regions (4-15 tiles) look fine but bigger ones (40-76 tiles)
  are scattered.
- The "competitive flood-fill" loop pattern:
  ```ts
  for (let iter = 0; iter < N; iter++) {
    for (const region of regionNames) {
      // claim ONE tile for this region this iteration
    }
  }
  ```

## Solution

Replace the competitive flood-fill with a **sequential region-by-region
BFS**. Each region claims all its tiles before the next region starts.
Large regions go first so they get the central, room-rich slots.

```ts
const sorted = [...regionNames].sort(
  (a, b) => regionSize(b) - regionSize(a),
);

for (const region of sorted) {
  const need = regionSize(region);

  // Find a seed slot near a related/origin target.
  const target = pickRelatedSeedOrOrigin(region);
  const seed = findSeedSlot(region, need, target);
  if (!seed) continue;

  seeds.set(region, seed);
  growRegion(region, seed, need);
}
```

The two helpers:

```ts
// Walk a hex spiral from `target` looking for the first unclaimed tile
// that satisfies the gap rule and has at least one open neighbor.
function findSeedSlot(region, need, target) {
  if (canStartHere(target)) return target;
  for (let rad = 1; rad < maxRadius; rad++) {
    for (const tile of hexRing(target, rad)) {
      if (canStartHere(tile, region)) return tile;
    }
  }
  return null;
}

// BFS-expand from seed, picking each next tile to maximise compactness.
function growRegion(region, seed, need) {
  claim(seed, region);
  const frontier = openNeighbors(seed);
  let count = 1;
  while (count < need) {
    let best = null;
    let bestScore = -1;
    let bestDist = Infinity;
    for (const k of frontier) {
      if (claimed.has(k)) continue;
      if (!canClaim(k, region)) continue;
      // Score: same-region neighbors (compactness)
      const score = sameRegionNeighborCount(k, region);
      const dist = hexDistance(k, seed);
      if (score > bestScore || (score === bestScore && dist < bestDist)) {
        best = k;
        bestScore = score;
        bestDist = dist;
      }
    }
    if (!best) break; // boxed in — region truncated
    claim(best, region);
    frontier.delete(best);
    addOpenNeighborsToFrontier(best, region, frontier);
    count++;
  }
}
```

Key properties:

- **Largest first**: the biggest region gets origin (or near-origin) and
  has unlimited free space in every direction.
- **Fully claim before moving on**: by the time the next region starts,
  the previous one has all its tiles. Subsequent regions grow around
  the first region but never starve it.
- **Compact tile picking**: picking the frontier candidate with the
  most same-region neighbors is the standard "minimize perimeter"
  greedy. Tiebreaker by distance-to-seed prevents radial drift.
- **No overflow spiral needed**: every tile is claimed in `growRegion`.
  Delete the overflow code path entirely.
- **canClaim still enforces gaps**: regions whose immediate parents
  differ get a 1-tile gap; siblings (sharing a non-trivial parent path)
  may touch directly.

## Verification

After applying the fix, measure dispersion per region:

```ts
function regionStats(nodes) {
  const byRegion = {};
  for (const n of nodes) {
    (byRegion[n.region] ||= []).push({ x: n.x, z: n.z });
  }
  return Object.entries(byRegion).map(([r, ts]) => {
    let cx = 0, cz = 0;
    for (const t of ts) { cx += t.x; cz += t.z; }
    cx /= ts.length; cz /= ts.length;
    let maxDist = 0;
    for (const t of ts) {
      maxDist = Math.max(maxDist, Math.hypot(t.x - cx, t.z - cz));
    }
    return { region: r, n: ts.length, maxDist, ratio: maxDist / Math.sqrt(ts.length) };
  });
}
```

Healthy output: every ratio in 2–4 (world coords with TILE_SIZE 3), no
matter the region size. Example for 39 packages × 575 files:

```
packages/util         n=76 ratio=3   ← was 14
packages/rfdb-server  n=56 ratio=4
packages/cli          n=43 ratio=4   ← was 20
...
packages/lang-defs    n=3  ratio=2
bad (ratio>5): 0
```

Visually: distinct hexagonal color blobs, one per region, packed against
each other. No perimeter rings, no scattered tiles.

## Example

In `packages/gui/src/store/hexLayout.ts`, the original layout used:

```ts
// ❌ Competitive flood-fill — large regions get scattered.
for (let iter = 0; iter < 500; iter++) {
  let any = false;
  for (const region of regionNames) {
    const need = remaining.get(region) ?? 0;
    if (need <= 0) continue;
    // pick one tile for this region
    if (!bestTile) continue;
    claimed.set(bestTile, region);
    remaining.set(region, need - 1);
    any = true;
  }
  if (!any) break;
}

// fallback: overflow spiral for unplaced nodes
for (let i = 0; i < N; i++) {
  if (!tileCoords.has(i)) {
    // place at outer hex spiral — far from region seed
  }
}
```

For 575 nodes / 39 packages, `packages/util` (76 tiles) ended up with
~15 tiles near the seed and 61 tiles scattered at radius 80+ from
origin. Dispersion ratio 14 vs ideal ~3.

After replacement:

```ts
// ✅ Sequential per-region BFS — every region is a compact blob.
const sorted = [...regionNames].sort(
  (a, b) => regionIndices.get(b)!.length - regionIndices.get(a)!.length,
);
for (const region of sorted) {
  const need = regionIndices.get(region)?.length ?? 1;
  const target = bestRelatedSeed(region) ?? { q: 0, r: 0 };
  const seed = findSeedSlot(region, need, target);
  if (!seed) continue;
  seeds.set(region, seed);
  growRegion(region, seed, need);
}
// no overflow spiral
```

Result: all 39 regions have ratio 2–4. `packages/util` = compact 76-tile
blue blob in the centre, surrounded by other packages each as their own
color blob.

## Notes

- **Order matters**: largest first. Smallest first is symmetric but the
  small ones will block the large ones from finding seed slots.
- **Seed slot search radius** must scale with N — `maxRadius =
  Math.max(80, Math.ceil(Math.sqrt(N)) * 4)` is a safe bound.
- **Sibling fusing** (allowing same-parent regions to touch without a
  gap) still works under sequential BFS because canClaim is per-tile,
  not per-iteration.
- **Connectivity** is automatically preserved: BFS only adds tiles
  adjacent to the existing region, so regions are connected by
  construction. The `wouldDisconnect` check is only needed for SA
  migration moves (which can vacate interior tiles), not initial layout.
- **Truncation edge case**: if a region can't grow to its full N (rare
  — only happens if geometry boxes it in), the remaining nodes get
  placed by a deterministic fallback. In practice with `findSeedSlot`
  picking room-rich slots, this never triggers for realistic graphs.
- **Performance**: O(total_tiles × max_region_size) — same big-O as
  competitive flood-fill but faster in practice because there are no
  cross-region competition retries.
- **Related skill**: `hex-grid-sa-o1-connectivity` covers a different
  hex-SA bug — slow connectivity checks during migrate moves. Both fixes
  are needed for a working layout on >200 tiles.

## Related Files

- `packages/gui/src/store/hexLayout.ts:189` — layout entry point
- `packages/gui/src/store/hexLayout.ts:findSeedSlot` — seed search
- `packages/gui/src/store/hexLayout.ts:growRegion` — BFS expansion
- `.claude/skills/hex-grid-sa-o1-connectivity/SKILL.md` — sibling skill
