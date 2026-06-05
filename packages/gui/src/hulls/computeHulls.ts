/**
 * DAI-22 Chunk-7 — Morphological-close hull computation per REGION.
 *
 * For each region in the region tree, produce a set of closed polygons
 * (hex-coordinate boundaries) that wrap all symbols placed in that region
 * and in every descendant region.
 *
 * Pipeline (per region, per plan §C.2):
 *   1. Collect member cells = union of `symbolsByRegion[leafRegion]` for
 *      every descendant (incl. self) that has symbols.
 *   2. Morphological close with radius r (default r=1):
 *        - dilate: add every 6-neighbour of every member cell (r times)
 *        - erode : keep only cells whose 6 neighbours are all in the
 *                  dilated set (r times)
 *      Net effect: 1-cell interior gaps get filled, exterior is unchanged.
 *   3. Flood-fill from outside a bounding rect; anything not reached AND
 *      not in the closed set is a hole — fill it (policy: drop holes).
 *   4. Boundary trace: emit the outer perimeter of each connected
 *      component as an ordered polygon (first vertex repeated at the end).
 *
 * Policies (matched to tests):
 *   - 1-cell region                 → single hex polygon, no close.
 *   - Disjoint cells (gap > 2·r)    → multiple polygons per region.
 *   - Ring with hole                → hole filled; one polygon, no inner loop.
 *   - Zero-leaf folder              → map entry absent (function skips it).
 *   - Overlapping siblings          → allowed; caller handles z-order.
 *
 * Determinism: we iterate sorted coordinate lists, emit edges in a fixed
 * orientation order, and pick seeds as the lexicographically-smallest
 * unvisited boundary edge. Identical input → identical output (including
 * polygon vertex order).
 *
 * Pure, no store mutations. ~O(total_cells * r) — cheap.
 */

import type { HexCoord } from '../geom/hex.js';
import { computeHullPolygons, type HullLoop } from '../geom/hull.js';
import type { RegionTree } from '../store/layoutStore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ordered vertices of a closed polygon in pixel (x, y) coordinates, as
 *  produced by `geom/hull.ts::computeHullPolygons`. First vertex is
 *  repeated at the end (closed ring). */
export type Polygon = HullLoop;

/** All polygons required to render one region's hull. */
export interface HullGeometry {
  polygons: Polygon[];
  /** Number of hex cells in the closed set (post-close, post-hole-fill). */
  area: number;
}

export interface ComputeHullsOptions {
  /** Morphological-close radius in hex cells. Default 1. */
  radius?: number;
  /** Hex radius (centre → corner) used for pixel-space polygon output.
   *  Default 1. Chunk-8 consumers scale/position based on this. */
  hexSize?: number;
}

// ---------------------------------------------------------------------------
// Hex math (axial, flat-top — must match geom/hex.mjs ordering)
// ---------------------------------------------------------------------------

/** Six axial-coord neighbour offsets. Order matches HEX_DIRS in geom/hex.mjs:
 *  E, NE, NW, W, SW, SE (clockwise from east). */
const NEIGHBOURS: readonly HexCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function key(q: number, r: number): string {
  return `${q},${r}`;
}

function parseKey(k: string): HexCoord {
  const [q, r] = k.split(',').map(Number);
  return { q, r };
}

// ---------------------------------------------------------------------------
// Morphological close
// ---------------------------------------------------------------------------

function dilate(cells: Set<string>): Set<string> {
  const out = new Set<string>(cells);
  for (const k of cells) {
    const { q, r } = parseKey(k);
    for (const d of NEIGHBOURS) {
      out.add(key(q + d.q, r + d.r));
    }
  }
  return out;
}

function erode(cells: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const k of cells) {
    const { q, r } = parseKey(k);
    let all = true;
    for (const d of NEIGHBOURS) {
      if (!cells.has(key(q + d.q, r + d.r))) {
        all = false;
        break;
      }
    }
    if (all) out.add(k);
  }
  return out;
}

/**
 * Morphological close: dilate r times, then erode r times.
 * Net effect: fills interior gaps of width ≤ 2r-1; exterior unchanged.
 */
function morphologicalClose(cells: Set<string>, radius: number): Set<string> {
  if (radius <= 0 || cells.size <= 1) return new Set(cells);
  let s = cells;
  for (let i = 0; i < radius; i++) s = dilate(s);
  for (let i = 0; i < radius; i++) s = erode(s);
  // Union with the original — erosion can, in pathological shapes, remove
  // an original cell that is on the outer convex perimeter. Originals must
  // always survive: close is supposed to be ⊇ original.
  for (const k of cells) s.add(k);
  return s;
}

// ---------------------------------------------------------------------------
// Hole fill: flood from outside a bounding rect, fill unreached
// ---------------------------------------------------------------------------

function fillHoles(cells: Set<string>): Set<string> {
  if (cells.size === 0) return cells;
  let minQ = Infinity, maxQ = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const k of cells) {
    const { q, r } = parseKey(k);
    if (q < minQ) minQ = q;
    if (q > maxQ) maxQ = q;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  // Pad bbox by 1 so the flood has a free outer ring to start from.
  minQ -= 1; maxQ += 1; minR -= 1; maxR += 1;

  const outside = new Set<string>();
  const stack: HexCoord[] = [];
  // Seed from the entire outer frame (any exterior cell reaches all exterior).
  for (let q = minQ; q <= maxQ; q++) {
    stack.push({ q, r: minR });
    stack.push({ q, r: maxR });
  }
  for (let r = minR; r <= maxR; r++) {
    stack.push({ q: minQ, r });
    stack.push({ q: maxQ, r });
  }
  while (stack.length > 0) {
    const c = stack.pop()!;
    if (c.q < minQ || c.q > maxQ || c.r < minR || c.r > maxR) continue;
    const k = key(c.q, c.r);
    if (cells.has(k)) continue;
    if (outside.has(k)) continue;
    outside.add(k);
    for (const d of NEIGHBOURS) stack.push({ q: c.q + d.q, r: c.r + d.r });
  }

  // Fill: every cell inside the bbox NOT reached and NOT a member is a hole.
  const out = new Set<string>(cells);
  for (let q = minQ; q <= maxQ; q++) {
    for (let r = minR; r <= maxR; r++) {
      const k = key(q, r);
      if (cells.has(k)) continue;
      if (outside.has(k)) continue;
      out.add(k);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boundary trace — delegates to the exact tracer in geom/hull.ts.
//
// Rationale: `computeHullPolygons` already solves the
// "turn a cell-set into ordered closed polygon loops" problem, with
// deterministic output and full parity with the sandbox reference. We
// feed it the morphologically-closed + hole-filled cell set and use the
// loops it returns directly as our `Polygon[]`.
// ---------------------------------------------------------------------------

function traceBoundary(cells: Set<string>, hexSize: number): Polygon[] {
  const coords: HexCoord[] = [];
  for (const k of cells) coords.push(parseKey(k));
  // Sort for determinism — computeHullPolygons iterates input order for
  // edge collection, and sorted-input → deterministic loop walk.
  coords.sort((a, b) => (a.q - b.q) || (a.r - b.r));
  return computeHullPolygons(coords, hexSize);
}

// ---------------------------------------------------------------------------
// Region descendant aggregation
// ---------------------------------------------------------------------------

/**
 * Collect all placed cells for a region, including recursive descendants.
 * Returns a deduplicated Set of hex keys.
 */
function collectMemberCells(
  regionId: string,
  tree: RegionTree,
  symbolsByRegion: ReadonlyMap<string, readonly HexCoord[]>,
): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [regionId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const info = tree.byId.get(id);
    if (!info) continue;
    const direct = symbolsByRegion.get(id);
    if (direct) {
      for (const c of direct) out.add(key(c.q, c.r));
    }
    for (const childId of info.childIds) stack.push(childId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute hull geometry for every region in `tree` that has at least one
 * placed symbol (directly or via a descendant). Regions with no symbols
 * are omitted from the returned map (zero-leaf policy).
 *
 * @param tree              RegionTree from `layoutStore`.
 * @param symbolsByRegion   Map from leaf-region id → placed symbol cells.
 *                          Caller bucket; see `bucketSymbolsByRegion`.
 * @param options.radius    Morphological-close radius (default 1).
 */
export function computeHullsForRegions(
  tree: RegionTree,
  symbolsByRegion: ReadonlyMap<string, readonly HexCoord[]>,
  options: ComputeHullsOptions = {},
): Map<string, HullGeometry> {
  const radius = options.radius ?? 1;
  const hexSize = options.hexSize ?? 1;
  const result = new Map<string, HullGeometry>();

  // Iterate region ids in sorted order for deterministic output.
  const regionIds = [...tree.byId.keys()].sort();
  for (const regionId of regionIds) {
    const members = collectMemberCells(regionId, tree, symbolsByRegion);
    if (members.size === 0) continue;

    let closed: Set<string>;
    if (members.size === 1) {
      // Single-cell policy: skip morphological close — the cell itself IS
      // the hull, traced as a 6-vertex polygon.
      closed = members;
    } else {
      closed = morphologicalClose(members, radius);
      closed = fillHoles(closed);
    }

    const polygons = traceBoundary(closed, hexSize);
    if (polygons.length === 0) continue;

    result.set(regionId, { polygons, area: closed.size });
  }

  return result;
}

/**
 * Helper: bucket a flat list of placed nodes into per-region arrays.
 * Caller provides each node's `regionId` (resolved via CONTAINS chain →
 * file region). Returns a Map suitable for `computeHullsForRegions`.
 *
 * Pure, deterministic. Empty input → empty map.
 */
export function bucketSymbolsByRegion(
  placed: ReadonlyArray<{ regionId: string; q: number; r: number }>,
): Map<string, HexCoord[]> {
  const out = new Map<string, HexCoord[]>();
  for (const p of placed) {
    let arr = out.get(p.regionId);
    if (!arr) {
      arr = [];
      out.set(p.regionId, arr);
    }
    arr.push({ q: p.q, r: p.r });
  }
  return out;
}
