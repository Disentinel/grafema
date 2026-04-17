/**
 * TypeScript port of sandbox/hex-sandbox/src/hull.js.
 *
 * `computeHullPolygons(tiles, size)` — exact-boundary trace of a hex
 * tile-set as one or more closed polygon loops in pixel coordinates.
 *
 * Algorithm (unchanged from the sandbox reference):
 *   1. For each tile × 6 sides: if the neighbour isn't in the set, the
 *      side is a boundary edge. Collect all as (corner_a, corner_b)
 *      pairs in 2-D pixel space.
 *   2. Build a corner → edge-index map. Each boundary corner is shared
 *      by exactly two boundary edges (for well-formed regions).
 *   3. Walk loops: start from any unvisited edge, follow corner → next
 *      edge → next corner until back at the start.
 *
 * Concave shapes, holes, and disjoint islands emit multiple loops.
 * Complexity: O(|tiles|) for edge collection, O(|boundary_edges|) for
 * walking. No morphological operations; exact outline, not a filled-in
 * approximation.
 *
 * Also exposes `computeHullPolygonsBatched(regions, size)` — an async
 * generator that yields one region per iteration, deferring each to the
 * next idle slot so long hull jobs can be spread across frames instead
 * of blocking the main thread (Dijkstra P2-B9).
 */
import { HEX_DIRS, axialToPixel, hexKey } from './hex.js';
import type { HexCoord } from './hex.js';

/**
 * Mapping from corner-pair index (0..5, CCW from east) into HEX_DIRS.
 * See sandbox/hex-sandbox/src/hull.js for the derivation.
 */
const EDGE_TO_DIR: readonly number[] = [0, 5, 4, 3, 2, 1] as const;

/** 2-D point in pixel space. */
interface Point2D {
  x: number;
  y: number;
}

/** A closed polygon loop — first and last point coincide. */
export type HullLoop = Point2D[];

/** A region's tile set, tagged for batched processing. */
export interface RegionTiles {
  regionId: string;
  tiles: Iterable<HexCoord>;
}

/** One yielded batch from `computeHullPolygonsBatched`. */
export interface HullBatchResult {
  regionId: string;
  loops: HullLoop[];
}

/** Stable string key for a pixel coord, robust to small float drift.
 * Quantises to 1/1000 px — well below any drift between adjacent
 * hexes that nominally share the same corner. */
function coordKey(p: Point2D): string {
  return `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
}

function samePoint(a: Point2D, b: Point2D): boolean {
  return Math.abs(a.x - b.x) < 0.005 && Math.abs(a.y - b.y) < 0.005;
}

/**
 * Trace the outer boundary of a hex tile set as one or more closed
 * polygon loops in pixel coordinates.
 *
 * @param tiles  Tile coordinates (deduplicated internally).
 * @param size   Hex radius used for pixel conversion.
 */
export function computeHullPolygons(
  tiles: Iterable<HexCoord>,
  size: number,
): HullLoop[] {
  // Dedup input into a fixed list + membership set.
  const tileSet = new Set<string>();
  const tileList: HexCoord[] = [];
  for (const t of tiles) {
    const key = hexKey(t.q, t.r);
    if (!tileSet.has(key)) {
      tileSet.add(key);
      tileList.push({ q: t.q, r: t.r });
    }
  }
  if (tileList.length === 0) return [];

  // Precompute the 6 corner offsets for a flat-top hex (radius = size).
  const corners: Point2D[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    corners.push({ x: size * Math.cos(a), y: size * Math.sin(a) });
  }

  // ── Collect boundary edges ────────────────────────────────────
  const edges: [Point2D, Point2D][] = [];
  for (const t of tileList) {
    const center = axialToPixel(t, size);
    for (let ei = 0; ei < 6; ei++) {
      const d = HEX_DIRS[EDGE_TO_DIR[ei]];
      if (tileSet.has(hexKey(t.q + d.q, t.r + d.r))) continue;
      const a: Point2D = {
        x: center.x + corners[ei].x,
        y: center.y + corners[ei].y,
      };
      const b: Point2D = {
        x: center.x + corners[(ei + 1) % 6].x,
        y: center.y + corners[(ei + 1) % 6].y,
      };
      edges.push([a, b]);
    }
  }
  if (edges.length === 0) return [];

  // ── Corner → edges lookup for loop-walking ────────────────────
  const byCorner = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i];
    const ka = coordKey(a);
    const kb = coordKey(b);
    let la = byCorner.get(ka);
    if (!la) { la = []; byCorner.set(ka, la); }
    let lb = byCorner.get(kb);
    if (!lb) { lb = []; byCorner.set(kb, lb); }
    la.push(i);
    lb.push(i);
  }

  // ── Walk loops ────────────────────────────────────────────────
  const used: boolean[] = new Array(edges.length).fill(false);
  const loops: HullLoop[] = [];
  const safetyCap = edges.length * 4 + 8;

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const loop: Point2D[] = [];
    let curIdx = start;
    let curEdge = edges[curIdx];
    let curPoint: Point2D = curEdge[0];
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

/**
 * Minimal `requestIdleCallback` polyfill for environments that lack it
 * (Node, Safari). We only need "schedule for later" semantics — a
 * microtask via Promise.resolve() is fine. No React or Three.js deps.
 */
function scheduleIdle(): Promise<void> {
  type MaybeIdleCallback = (cb: () => void) => void;
  const g = globalThis as unknown as { requestIdleCallback?: MaybeIdleCallback };
  if (typeof g.requestIdleCallback === 'function') {
    return new Promise<void>((resolve) => {
      g.requestIdleCallback!(() => resolve());
    });
  }
  return Promise.resolve();
}

/**
 * Async-generator variant of `computeHullPolygons` that processes one
 * region per iteration and yields to the event loop between regions.
 * Callers can drive it from a `for await ... of` loop inside a React
 * effect / Three.js animation frame handler; each yielded batch can be
 * rendered before the next one is computed.
 *
 * Contract: preserves input order. Regions with 0 tiles yield `loops: []`.
 */
export async function* computeHullPolygonsBatched(
  regions: Iterable<RegionTiles>,
  size: number,
): AsyncGenerator<HullBatchResult, void, void> {
  for (const r of regions) {
    await scheduleIdle();
    const loops = computeHullPolygons(r.tiles, size);
    yield { regionId: r.regionId, loops };
  }
}
