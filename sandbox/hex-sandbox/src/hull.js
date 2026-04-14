import { HEX_DIRS, axialToPixel, hexKey } from './hex.js';

// Corner-pair index (0..5, CCW from east) → index into HEX_DIRS of the
// neighbour on that side. Derivation (flat-top hex, corners at angles
// 0°, 60°, 120°, 180°, 240°, 300°):
//
//   edge 0 = corners[0]→corners[1]   outward at  30° → E  (HEX_DIRS[0])
//   edge 1 = corners[1]→corners[2]   outward at  90° → SE (HEX_DIRS[5])
//   edge 2 = corners[2]→corners[3]   outward at 150° → SW (HEX_DIRS[4])
//   edge 3 = corners[3]→corners[4]   outward at 210° → W  (HEX_DIRS[3])
//   edge 4 = corners[4]→corners[5]   outward at 270° → NW (HEX_DIRS[2])
//   edge 5 = corners[5]→corners[0]   outward at 330° → NE (HEX_DIRS[1])
const EDGE_TO_DIR = [0, 5, 4, 3, 2, 1];

/** Stable string key for a pixel coord, robust to float drift. */
function coordKey(p) {
  // Quantize to 1/1000 pixel — well below any real drift between
  // adjacent hexes that nominally share the same corner.
  return `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 0.005 && Math.abs(a.y - b.y) < 0.005;
}

/**
 * Trace the outer boundary of a hex tile set as one or more closed
 * polygon loops in pixel coordinates.
 *
 * Algorithm:
 *   1. For each tile, for each of its 6 sides, if the neighbour is
 *      NOT in the set, the side is a boundary edge. Collect all
 *      boundary edges as (corner_a, corner_b) pairs.
 *   2. Build a corner → edge-index map. Each boundary corner is
 *      shared by exactly two boundary edges (for well-formed regions
 *      without degenerate narrow necks).
 *   3. Walk loops: start from any unvisited edge, follow corner →
 *      next edge → next corner until we return to the start.
 *
 * Concave shapes, holes, and multiple disconnected islands produce
 * multiple loops. Canvas2D `fill` handles them via non-zero winding.
 *
 * Complexity: O(|tiles|) for edge collection, O(|boundary_edges|)
 * for walking. No morphological operations; the hull is the exact
 * boundary, not a filled-in approximation.
 *
 * @param {Iterable<{ q: number, r: number }>} tiles
 * @param {number} size  hex radius used for pixel conversion
 * @returns {{x: number, y: number}[][]} loops — each a closed polyline
 */
export function computeHullPolygons(tiles, size) {
  const tileSet = new Set();
  const tileList = [];
  for (const t of tiles) {
    const key = hexKey(t.q, t.r);
    if (!tileSet.has(key)) {
      tileSet.add(key);
      tileList.push({ q: t.q, r: t.r });
    }
  }
  if (tileList.length === 0) return [];

  // Precompute the 6 corner offsets for a flat-top hex.
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    corners.push({ x: size * Math.cos(a), y: size * Math.sin(a) });
  }

  // ── Collect boundary edges ────────────────────────────────────
  /** @type {Array<[{x:number,y:number}, {x:number,y:number}]>} */
  const edges = [];
  for (const t of tileList) {
    const center = axialToPixel(t, size);
    for (let ei = 0; ei < 6; ei++) {
      const d = HEX_DIRS[EDGE_TO_DIR[ei]];
      if (tileSet.has(hexKey(t.q + d.q, t.r + d.r))) continue;
      const a = { x: center.x + corners[ei].x, y: center.y + corners[ei].y };
      const b = {
        x: center.x + corners[(ei + 1) % 6].x,
        y: center.y + corners[(ei + 1) % 6].y,
      };
      edges.push([a, b]);
    }
  }
  if (edges.length === 0) return [];

  // ── Build corner → edges map for loop-walking ────────────────
  /** @type {Map<string, number[]>} */
  const byCorner = new Map();
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i];
    const ka = coordKey(a);
    const kb = coordKey(b);
    let la = byCorner.get(ka); if (!la) { la = []; byCorner.set(ka, la); }
    let lb = byCorner.get(kb); if (!lb) { lb = []; byCorner.set(kb, lb); }
    la.push(i);
    lb.push(i);
  }

  // ── Walk loops ────────────────────────────────────────────────
  const used = new Array(edges.length).fill(false);
  /** @type {{x:number,y:number}[][]} */
  const loops = [];
  const safetyCap = edges.length * 4 + 8;

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const loop = [];
    let curIdx = start;
    let curEdge = edges[curIdx];
    let curPoint = curEdge[0];
    loop.push({ x: curPoint.x, y: curPoint.y });
    used[curIdx] = true;

    let safety = safetyCap;
    while (safety-- > 0) {
      const other = samePoint(curPoint, curEdge[0]) ? curEdge[1] : curEdge[0];
      loop.push({ x: other.x, y: other.y });

      if (samePoint(other, loop[0])) break;

      const neigh = byCorner.get(coordKey(other));
      if (!neigh) break;
      let nextIdx = -1;
      for (const ni of neigh) {
        if (ni === curIdx) continue;
        if (used[ni]) continue;
        nextIdx = ni;
        break;
      }
      if (nextIdx === -1) break;
      used[nextIdx] = true;
      curIdx = nextIdx;
      curEdge = edges[curIdx];
      curPoint = other;
    }

    if (loop.length >= 4) loops.push(loop);
  }

  return loops;
}
