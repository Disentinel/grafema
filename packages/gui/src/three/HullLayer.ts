import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/**
 * HullLayer — renders the outer boundary of one or more groups of hex tiles
 * as line segments. Each group's "hull" is the union of hex sides whose
 * neighbouring tile is NOT in the same group. This is the actual concave
 * boundary (NOT a convex hull) so it follows L-shapes, holes, etc.
 *
 * Multiple HullLayer instances can be stacked at different Y-elevations
 * to show nested hierarchy: e.g.
 *   - level 0 (sub-region): y = 0.4, thin line
 *   - level 1 (package):    y = 1.0, medium line
 *   - level 2 (top-level):  y = 1.6, thick line
 *
 * Each higher level encompasses more tiles than the level below it, so
 * the lines are drawn at progressively bigger elevation.
 */

export interface HullGroup {
  /** Stable identifier (used for color hashing if no explicit color given). */
  id: string;
  /** World-space (x, z) tile centers belonging to this group. */
  tiles: { x: number; z: number }[];
}

export interface HullLayerOptions {
  /** Hex radius — must match HexLayer's geometry. */
  hexSize: number;
  /** Elevation above the hex plane. Higher levels draw on top. */
  elevation: number;
  /** Single solid color for all hull lines, or null to color by group hash. */
  color?: THREE.ColorRepresentation;
  /** Opacity 0..1. */
  opacity?: number;
  /** Line width hint (renderer dependent — three.js LineBasicMaterial
   *  ignores this on most platforms but ShaderMaterial respects it). */
  linewidth?: number;
  /**
   * If true, gaps between same-group tiles get filled with virtual
   * "interior" tiles before the boundary is traced — so the resulting
   * hull wraps around all same-group islands as one bag instead of
   * outlining each island separately. Use for higher-level hulls
   * (package, top-level) that should encompass nested sub-regions.
   */
  fillInteriorGaps?: boolean;
}

/**
 * Build the 6 corner offsets for a flat-top hex with the same orientation
 * as HexLayer's geometry: angles 0°, 60°, … 300° in the xz plane.
 */
function hexCornerOffsets(size: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    out.push({ x: Math.cos(a) * size, z: Math.sin(a) * size });
  }
  return out;
}

/** Round world coords to a stable key for tile lookup.
 *  IMPORTANT: normalise negative zero. Float arithmetic can produce
 *  -0 when subtracting equal positives, and `(-0).toFixed(2)` returns
 *  "-0.00" while `(0).toFixed(2)` returns "0.00" — those are different
 *  string keys but represent the same hex position. Adding 0 collapses
 *  -0 → +0 cleanly. */
function tileKey(x: number, z: number): string {
  return `${(x + 0).toFixed(2)},${(z + 0).toFixed(2)}`;
}

/** 6 neighbour-direction offsets for the flat-top hex layout used by HexLayer. */
function makeSideOffsets(hexSize: number): { dx: number; dz: number }[] {
  const out: { dx: number; dz: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * (i + 0.5);
    out.push({
      dx: Math.cos(a) * hexSize * Math.sqrt(3),
      dz: Math.sin(a) * hexSize * Math.sqrt(3),
    });
  }
  return out;
}

/** Round a corner coordinate to a stable key (snaps floating-point drift).
 *  Normalises negative zero (see tileKey for details). */
function cornerKey(x: number, z: number): string {
  return `${(x + 0).toFixed(2)},${(z + 0).toFixed(2)}`;
}

/**
 * Compute the boundary of a group as one OR MORE closed polylines
 * (loops). Each loop is an ordered list of corner positions where
 * consecutive corners share a hex edge. This lets the renderer use
 * Line2 with continuous joins instead of independent segments
 * (which leave gaps at corners with LineSegments2).
 *
 * Algorithm:
 *   1. Collect all boundary edges (same as before — sides whose
 *      neighbour isn't in the group).
 *   2. Build a corner-to-edges adjacency map. Each boundary edge has
 *      two corner endpoints. Each corner is shared by 0, 2, or more
 *      boundary edges.
 *   3. Walk: pick any unvisited edge, follow corner → next edge →
 *      next corner until we return to the start. That's one loop.
 *      Repeat until all edges are visited.
 */
function _computeGroupBoundaryLoops(
  tiles: { x: number; z: number }[],
  isMember: (k: string) => boolean,
  sideOffsets: { dx: number; dz: number }[],
  cornerOffsets: { x: number; z: number }[],
): { x: number; z: number }[][] {
  // Step 1: collect boundary edges as (corner-a, corner-b) pairs.
  type Pt = { x: number; z: number };
  const edges: { a: Pt; b: Pt }[] = [];
  for (const tile of tiles) {
    for (let i = 0; i < 6; i++) {
      const nbr = sideOffsets[i];
      const nx = tile.x + nbr.dx;
      const nz = tile.z + nbr.dz;
      if (isMember(tileKey(nx, nz))) continue;
      const ca = cornerOffsets[i];
      const cb = cornerOffsets[(i + 1) % 6];
      edges.push({
        a: { x: tile.x + ca.x, z: tile.z + ca.z },
        b: { x: tile.x + cb.x, z: tile.z + cb.z },
      });
    }
  }
  if (edges.length === 0) return [];

  // Step 2: build corner-to-edges adjacency. Two edges that share a
  // corner are guaranteed to come from neighbouring tiles' boundary
  // sides — they form a continuous polyline join.
  const cornerEdges = new Map<string, number[]>();
  const addEdge = (k: string, idx: number) => {
    const list = cornerEdges.get(k);
    if (list) list.push(idx);
    else cornerEdges.set(k, [idx]);
  };
  for (let i = 0; i < edges.length; i++) {
    addEdge(cornerKey(edges[i].a.x, edges[i].a.z), i);
    addEdge(cornerKey(edges[i].b.x, edges[i].b.z), i);
  }

  // Step 3: walk loops. Mark edges as used as we go.
  const used = new Array(edges.length).fill(false);
  const loops: Pt[][] = [];

  for (let startIdx = 0; startIdx < edges.length; startIdx++) {
    if (used[startIdx]) continue;
    const loop: Pt[] = [];
    let curEdgeIdx = startIdx;
    let curEdge = edges[curEdgeIdx];
    let curCorner = curEdge.a;
    loop.push(curCorner);
    used[curEdgeIdx] = true;

    // Walk: from curEdge, the OTHER endpoint is the next corner.
    // From that corner, find the next unused edge that shares it
    // and isn't curEdge itself. Repeat until we return to start.
    let safety = edges.length * 4;
    while (safety-- > 0) {
      const nextCorner = sameCorner(curCorner, curEdge.a)
        ? curEdge.b
        : curEdge.a;
      loop.push(nextCorner);

      const k = cornerKey(nextCorner.x, nextCorner.z);
      const candidates = cornerEdges.get(k) ?? [];
      let nextEdgeIdx = -1;
      for (const ci of candidates) {
        if (ci === curEdgeIdx) continue;
        if (used[ci]) continue;
        nextEdgeIdx = ci;
        break;
      }
      if (nextEdgeIdx === -1) break; // dead end
      used[nextEdgeIdx] = true;
      curEdgeIdx = nextEdgeIdx;
      curEdge = edges[curEdgeIdx];
      curCorner = nextCorner;

      // Closed the loop?
      if (sameCorner(loop[0], curCorner)) {
        // The next iteration will add the start corner again — but
        // we should still continue once to traverse the closing edge
        // and then stop. Easier: stop here, the renderer will close
        // visually when start == end.
        break;
      }
    }
    if (loop.length >= 2) loops.push(loop);
  }
  return loops;
}

function sameCorner(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  return Math.abs(a.x - b.x) < 0.005 && Math.abs(a.z - b.z) < 0.005;
}

/**
 * Find empty tiles that are interior to a group via morphological
 * closing (dilate then erode).
 *
 * Why not flood-fill from outside? Because the gaps between sub-clusters
 * inside one package are 1 hex wide (canClaim's gap rule). A flood-fill
 * from outside can WALK THROUGH such a gap and mark it as exterior,
 * incorrectly leaving each sub-cluster wrapped separately.
 *
 * Closing collapses 1-hex gaps without affecting actual exterior:
 *   1. Dilate: take the group ∪ all neighbours of group tiles. This
 *      adds a 1-hex outer ring AND fills all 1-hex interior gaps
 *      (because both sides of the gap dilate into it).
 *   2. Erode: keep only dilated cells whose ALL 6 hex neighbours are
 *      also in the dilated set. This strips the outer ring back
 *      (its outward neighbours are NOT in the dilated set), but the
 *      gap-fill cells survive (all their neighbours are dilated).
 *
 * Result: original group ∪ 1-hex interior gaps. Exactly what we want.
 */
function findInteriorGaps(
  groupTiles: { x: number; z: number }[],
  sideOffsets: { dx: number; dz: number }[],
): { x: number; z: number }[] {
  if (groupTiles.length < 2) return [];

  const groupKeys = new Set<string>();
  for (const t of groupTiles) groupKeys.add(tileKey(t.x, t.z));

  // ── Step 1: dilate ─────────────────────────────────────────────
  // Build the dilated set: original tiles + all 6-hex neighbours of
  // each tile (even if the neighbour is empty or in another group).
  const dilatedKeys = new Set<string>(groupKeys);
  // Cache the explicit positions of dilated cells so we can iterate
  // them during erosion.
  const dilatedPos: { x: number; z: number }[] = [...groupTiles];
  for (const t of groupTiles) {
    for (let i = 0; i < 6; i++) {
      const nx = t.x + sideOffsets[i].dx;
      const nz = t.z + sideOffsets[i].dz;
      const k = tileKey(nx, nz);
      if (!dilatedKeys.has(k)) {
        dilatedKeys.add(k);
        dilatedPos.push({ x: nx, z: nz });
      }
    }
  }

  // ── Step 2: iterative erosion to fixed point ─────────────────
  // A single erosion pass leaves cells whose neighbours got eroded
  // in the same pass — boundary tracing then sees those neighbours
  // as "non-member" and emits spurious internal edges. We must erode
  // ITERATIVELY until no more cells need to be removed.
  //
  // Original group tiles always survive (they're either surrounded by
  // other original tiles or their dilation always includes their
  // immediate neighbours).
  //
  // The outer dilation ring shrinks each pass. Interior gap cells
  // survive iff every neighbour is also a survivor.
  const workSet = new Set<string>(dilatedKeys);
  // Cache positions for the cells we still need to check
  const posByKey = new Map<string, { x: number; z: number }>();
  for (const c of dilatedPos) posByKey.set(tileKey(c.x, c.z), c);

  while (true) {
    const toRemove: string[] = [];
    for (const k of workSet) {
      // Original group tiles are always kept
      if (groupKeys.has(k)) continue;
      const c = posByKey.get(k);
      if (!c) { toRemove.push(k); continue; }
      let allIn = true;
      for (let i = 0; i < 6; i++) {
        const nk = tileKey(c.x + sideOffsets[i].dx, c.z + sideOffsets[i].dz);
        if (!workSet.has(nk)) { allIn = false; break; }
      }
      if (!allIn) toRemove.push(k);
    }
    if (toRemove.length === 0) break;
    for (const k of toRemove) workSet.delete(k);
  }

  // Return only the NEW cells (gap fills) — the original group is
  // re-added by the caller.
  const gapTiles: { x: number; z: number }[] = [];
  for (const k of workSet) {
    if (groupKeys.has(k)) continue;
    const c = posByKey.get(k);
    if (c) gapTiles.push(c);
  }
  return gapTiles;
}

/** Stable string hash → 0..360° hue. */
function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

export class HullLayer {
  readonly meshes: LineSegments2[];
  private _materials: LineMaterial[];
  readonly elevation: number;

  constructor(groups: HullGroup[], opts: HullLayerOptions, scene: THREE.Scene) {
    this.elevation = opts.elevation;
    this.meshes = [];
    this._materials = [];

    const cornerOffsets = hexCornerOffsets(opts.hexSize);
    const sideOffsets = makeSideOffsets(opts.hexSize);

    const tmpColor = new THREE.Color();

    for (const g of groups) {
      // Optionally fill interior gaps via morphological close so the
      // hull wraps multiple disconnected sub-groups as one bag.
      let workTiles = g.tiles;
      if (opts.fillInteriorGaps) {
        const gaps = findInteriorGaps(g.tiles, sideOffsets);
        if (gaps.length > 0) workTiles = [...g.tiles, ...gaps];
      }
      const memberKeys = new Set<string>();
      for (const t of workTiles) memberKeys.add(tileKey(t.x, t.z));

      // Collect boundary edges (independent segments). Polyline tracing
      // attempts produced spurious tiny loops at certain corners; the
      // simpler per-edge representation is robust and corner gaps are
      // hidden by sufficient line width.
      const segments: number[] = [];
      for (const tile of workTiles) {
        for (let i = 0; i < 6; i++) {
          const nbr = sideOffsets[i];
          const nx = tile.x + nbr.dx;
          const nz = tile.z + nbr.dz;
          if (memberKeys.has(tileKey(nx, nz))) continue;
          const ca = cornerOffsets[i];
          const cb = cornerOffsets[(i + 1) % 6];
          segments.push(
            tile.x + ca.x, opts.elevation, tile.z + ca.z,
            tile.x + cb.x, opts.elevation, tile.z + cb.z,
          );
        }
      }
      if (segments.length === 0) continue;

      if (opts.color != null) {
        tmpColor.set(opts.color);
      } else {
        const hue = hueFromString(g.id) / 360;
        tmpColor.setHSL(hue, 0.6, 0.65);
      }

      const geo = new LineSegmentsGeometry();
      geo.setPositions(segments);

      const mat = new LineMaterial({
        color: tmpColor.getHex(),
        linewidth: opts.linewidth ?? 2,
        transparent: true,
        opacity: opts.opacity ?? 0.9,
        depthTest: false,
        depthWrite: false,
        worldUnits: false,
      });
      mat.resolution.set(window.innerWidth, window.innerHeight);

      const line = new LineSegments2(geo, mat);
      line.computeLineDistances();
      line.renderOrder = 100 + Math.round(opts.elevation * 10);
      scene.add(line);
      this.meshes.push(line);
      this._materials.push(mat);
    }
  }

  setOpacity(o: number): void {
    for (const m of this._materials) m.opacity = o;
  }

  setResolution(w: number, h: number): void {
    for (const m of this._materials) m.resolution.set(w, h);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    for (const m of this._materials) m.dispose();
    this.meshes.length = 0;
    this._materials.length = 0;
  }
}
