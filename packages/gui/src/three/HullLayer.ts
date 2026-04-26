import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import type { HexCoord } from '../geom/hex.js';
import {
  computeHullPolygonsBatched,
  type HullLoop,
  type RegionTiles,
} from '../geom/hull.js';
import { hueFromString } from '../geom/color.js';

/**
 * HullLayer — draws the exact concave boundary of each region as
 * line segments in 3-D.
 *
 * Historical note: the earlier in-class implementation collected
 * boundary edges plus an optional morphological close (dilate + erode)
 * per region per level. That pipeline was O(tiles² × levels) and hung
 * the main thread on real-project graphs (15k tiles × 5 levels → tens
 * of seconds, see Canvas.tsx's "Hull rendering disabled" note).
 *
 * The current algorithm delegates exact-boundary tracing to
 * `computeHullPolygonsBatched` (O(|boundary|) per region, no morph
 * operations, polyfilled `requestIdleCallback` between regions). The
 * layer keeps a root `THREE.Group` it owns — `setRegions` clears then
 * repopulates it per region per loop, yielding one line mesh per loop.
 *
 * Coordinate contract: `computeHullPolygons` emits loops in 2-D pixel
 * space (`x`, `y`). We convert to 3-D world space by mapping
 * `(x, y) → (x, elevation, y)` — the hex plane sits on XZ with Y-up.
 */

/** Input shape for `setRegions`. One region = one region's tiles. */
export interface HullRegion {
  /** Region identifier (e.g. package path). Used for deterministic
   *  color hashing and traceability. */
  path: string;
  /** Tile coordinates (axial q, r). Empty array → no mesh produced. */
  tiles: HexCoord[];
}

/**
 * DAI-22 Chunk-8b — precomputed-polygon variant of `setRegions`.
 * One entry per region, polygons already traced (from `computeHullsForRegions`
 * via `layoutStore.hullCache`). Lets callers bypass the internal hull-
 * tracing step and render directly from the per-region cache — the
 * render layer becomes a thin polygon-to-mesh adaptor.
 */
export interface HullRegionPrecomputed {
  /** Region identifier — stable, deterministic colour input for
   *  depth-based palette (`depth` drives hue) and traceability. */
  regionId: string;
  /** Region depth in the tree. Colour warms with depth. */
  depth: number;
  /** Already-closed polygon loops in pixel/world coordinates (same
   *  coordinate frame HullLayer emits for the internally-traced path). */
  polygons: HullLoop[];
  /** Optional precomputed hue (degrees, 0-360). When present, the
   *  layer renders this hue with a depth-driven lightness ramp instead
   *  of falling back to the internal `_depthColor` palette. Lets
   *  callers inject a tree-aware palette (siblings get distinct hues)
   *  without HullLayer needing access to the tree. */
  hue?: number;
}

/** Rendering mode for the layer. `hidden` hides the root group
 *  (cheaper than disposing), `line` shows it. Reserved for
 *  C-SceneManager wiring — additional modes (dashed, filled) can be
 *  added without breaking callers. */
export type HullStyle = 'line' | 'hidden';

/** Default elevation above the hex plane. Keeps lines visible over
 *  extruded tiles without z-fighting. */
const DEFAULT_ELEVATION = 0.35;

/** Budget for a full `setRegions` call. Real production targets are
 *  500 regions × 5 levels ≤ 500ms. When exceeded we log a warning
 *  so perf regressions surface early without throwing in prod. */
const SET_REGIONS_BUDGET_MS = 500;

export class HullLayer {
  /** Root group holding one line mesh per hull loop. Owned and
   *  attached to the passed-in scene on construction. Exposed as
   *  readonly so SceneManager / tests can observe children but must
   *  mutate through `setRegions` / `setVisible`. */
  readonly group: THREE.Group;

  private _scene: THREE.Scene;
  private _materials: Array<LineMaterial | THREE.LineBasicMaterial | THREE.MeshBasicMaterial> = [];
  private _elevation = DEFAULT_ELEVATION;
  /** Cached precomputed polygons by regionId. Populated by primeRegions
   *  once when the hullCache identity changes; setRegionHulls reads from
   *  here to assemble the merged geometries on each bucket change.
   *  Replaces the per-region mesh pool — instead of 1000+ Object3Ds in
   *  the scene graph (one per region per loop), we keep two single
   *  merged meshes (one for outlines, one for fills) and rebuild their
   *  buffers per bucket change. (DAI-22 architectural fix.) */
  private _polygonCache: Map<string, { polygons: readonly HullLoop[]; depth: number; hue?: number }> = new Map();
  /** Single merged outline mesh. `null` until the first non-empty
   *  setRegionHulls call. Reused across rebuilds — only the underlying
   *  position/color attributes change, the Three.Mesh stays the same so
   *  scene-graph traversal stays cheap. */
  private _lineMesh: LineSegments2 | THREE.LineSegments | null = null;
  /** Single merged fill mesh. Same lifecycle as `_lineMesh`. */
  private _fillMesh: THREE.Mesh | null = null;
  /** Monotonic token — any in-flight `setRegions` whose token is
   *  stale at the time of yield aborts before mutating the group.
   *  Guards against "call #2 clears scene mid-way through call #1". */
  private _generation = 0;

  constructor(scene: THREE.Scene, elevation: number = DEFAULT_ELEVATION) {
    this._scene = scene;
    this._elevation = elevation;
    this.group = new THREE.Group();
    this.group.name = 'HullLayer';
    scene.add(this.group);
  }

  /**
   * Rebuild all hull meshes from the supplied regions.
   *
   * Contract:
   *   - Clears the group up-front (synchronous) so the old outline
   *     disappears even if the caller doesn't await.
   *   - Then iterates via `computeHullPolygonsBatched`, which yields
   *     one region per idle slot. Each yielded region's loops are
   *     converted to LineSegments2 and appended to the group before
   *     the generator resumes.
   *   - Resolves only after the generator finishes.
   *   - Total wall time target: ≤ 500ms for 500 regions × 5 levels.
   *     Emits a `console.warn` (no throw) if exceeded.
   *   - Optional `signal` aborts cleanly at the next batch yield when
   *     triggered — the already-cleared root group stays empty, no
   *     "disposed object" errors propagate (E14 dual-abort: the same
   *     signal that cancels the upstream layout fetch also cancels the
   *     async hull rebuild so a mode-toggle mid-flight stays coherent).
   */
  async setRegions(
    regions: readonly HullRegion[],
    tileSize: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const myGen = ++this._generation;
    this._clear();

    if (signal?.aborted) return;

    const t0 =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

    // Adapt HullRegion[] → Iterable<RegionTiles>. We keep the order
    // (computeHullPolygonsBatched preserves input order) so any color
    // hashing tied to `path` stays stable across runs.
    const regionIter: RegionTiles[] = regions.map((r) => ({
      regionId: r.path,
      tiles: r.tiles,
    }));

    // Index path → HullRegion for fast per-batch lookup (we emit
    // mesh-per-loop and need the path hash for colour).
    const byId = new Map<string, HullRegion>();
    for (const r of regions) byId.set(r.path, r);

    for await (const batch of computeHullPolygonsBatched(regionIter, tileSize)) {
      if (signal?.aborted) return; // dual-abort (E14)
      if (this._generation !== myGen) return; // superseded
      if (batch.loops.length === 0) continue;
      const region = byId.get(batch.regionId);
      if (!region) continue; // paranoia — can't happen given our own map

      for (const loop of batch.loops) {
        this._appendLoopMesh(loop, region.path);
      }
    }

    const elapsed =
      (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()) - t0;
    if (elapsed > SET_REGIONS_BUDGET_MS) {
       
      console.warn(
        `[HullLayer] setRegions took ${elapsed.toFixed(1)}ms ` +
          `(budget ${SET_REGIONS_BUDGET_MS}ms) for ${regions.length} regions`,
      );
    }
  }

  /** Toggle visibility of the root group (cheaper than dispose). */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** Per-frame fill opacity. Caller (canvasBuild applyFrame) drives
   *  this from `zoom01` so the hull tint fades out as the user zooms
   *  in to the per-tile LOD — at deep zoom the hexes are the focus
   *  and a tinted overlay obscures them; at far zoom the tint provides
   *  the regional grouping signal. Cheap — material is shared, single
   *  uniform write per call. Outline opacity stays constant since the
   *  border lines remain useful at every LOD. */
  setFillOpacity(opacity: number): void {
    if (this._fillMesh) {
      const mat = this._fillMesh.material as THREE.MeshBasicMaterial;
      if (mat && typeof mat.opacity === 'number' && mat.opacity !== opacity) {
        mat.opacity = opacity;
        mat.needsUpdate = true;
      }
    }
  }

  /**
   * Point-in-polygon hit test in world (XZ) coordinates against every
   * cached region. Returns the deepest matching region (sandbox
   * priority — most specific folder wins) or null. The polygon cache is
   * populated by `primeRegions`; if it's empty (no stream loaded yet),
   * this returns null.
   *
   * O(regions × loop verts). Real-world ≤ 5 ms for 700 cached regions
   * with mostly small loops. Called from the hover handler on
   * mousemove, so it must be cheap; no allocation on the hot path.
   */
  hitTestWorld(worldX: number, worldZ: number): { regionId: string; depth: number } | null {
    let best: { regionId: string; depth: number } | null = null;
    for (const [regionId, entry] of this._polygonCache) {
      if (best && entry.depth <= best.depth) continue; // already have a deeper hit
      let inside = false;
      for (const loop of entry.polygons) {
        // Standard ray-cast (Jordan curve) — `loop` is a closed polygon
        // (first === last); iterate edges as consecutive pairs. The
        // hull cache writes loop vertices as {x, y} where y = world Z.
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
          const xi = loop[i].x, zi = loop[i].y;
          const xj = loop[j].x, zj = loop[j].y;
          const intersects = ((zi > worldZ) !== (zj > worldZ)) &&
            (worldX < ((xj - xi) * (worldZ - zi)) / (zj - zi || 1e-9) + xi);
          if (intersects) inside = !inside;
        }
      }
      if (inside) best = { regionId, depth: entry.depth };
    }
    return best;
  }

  /**
   * DAI-22 Chunk-8b — synchronous rebuild from precomputed polygons.
   *
   * Replaces the async `setRegions` → `computeHullPolygonsBatched`
   * pipeline for callers that already have polygons in hand (i.e. read
   * them from `layoutStore.hullCache`). Per-region `depth` drives the
   * colour palette: deeper nesting gets a warmer hue (sky-blue at
   * depth 0, orange-red at the deepest end).
   *
   * Callers should supply `regions` already sorted by depth ASC so
   * Three's insertion order aligns with the painter's-algorithm
   * z-order (deeper meshes drawn last → on top).
   *
   * No batching / signal handling — this is O(polygon count) and runs
   * in < 1ms for typical (< 500 regions × < 10 loops) atlases. For
   * the cache-less path, callers should still use `setRegions`.
   */
  setRegionHulls(regions: readonly HullRegionPrecomputed[]): void {
    const tStart = performance.now();
    this._rebuildMerged(regions);
    const dt = performance.now() - tStart;
    if (dt > 8) {
      console.warn(
        `[perf] HullLayer.setRegionHulls ${dt.toFixed(1)}ms (visible ${regions.length}, cache ${this._polygonCache.size})`,
      );
    }
  }

  /** Cache precomputed polygons + depth for every region in `all`. Call
   *  ONCE per hullCache identity change (stream load / reload). After
   *  this point `setRegionHulls(visible)` is a pure buffer-rewrite,
   *  no Object3D allocation. */
  primeRegions(all: readonly HullRegionPrecomputed[]): void {
    const tStart = performance.now();
    this._polygonCache.clear();
    for (const r of all) {
      this._polygonCache.set(r.regionId, { polygons: r.polygons, depth: r.depth, hue: r.hue });
    }
    console.warn(
      `[perf] HullLayer.primeRegions ${(performance.now() - tStart).toFixed(1)}ms ` +
      `(cached ${this._polygonCache.size} regions)`,
    );
  }

  /** Build (or rebuild) a single merged outline mesh and a single
   *  merged fill mesh from `regions`. Replaces what was previously
   *  ~1500 Object3Ds with two — drops scene-graph traversal cost from
   *  O(regions × loops) to O(1). The buffers themselves are O(verts),
   *  but verts are typically ≤ 5000 across a viewport-visible set. */
  private _rebuildMerged(regions: readonly HullRegionPrecomputed[]): void {
    // Sort by depth so painter's-algorithm renders deeper hulls on top.
    const sorted = [...regions].sort((a, b) => a.depth - b.depth);

    // ── Outline lines (LineSegments2) ──
    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const yLine = this._elevation;
    for (const r of sorted) {
      const color = this._regionColor(r, 'line');
      for (const loop of r.polygons) {
        if (loop.length < 2) continue;
        for (let i = 0; i < loop.length - 1; i++) {
          const a = loop[i];
          const b = loop[i + 1];
          linePositions.push(a.x, yLine, a.y, b.x, yLine, b.y);
          // LineSegmentsGeometry.setColors wants 3 floats per VERTEX,
          // not per segment — 6 floats per segment pair.
          lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
        }
      }
    }
    this._updateLineMesh(linePositions, lineColors);

    // ── Filled polygons (one merged BufferGeometry) ──
    // For each loop, triangulate via THREE.ShapeUtils. Concatenate
    // positions + colors into single buffers. Average loop is < 50 verts
    // so triangulation is fast even with 100 visible regions.
    const fillPositions: number[] = [];
    const fillColors: number[] = [];
    let vertOffset = 0;
    const fillIndices: number[] = [];
    for (const r of sorted) {
      const color = this._regionColor(r, 'fill');
      const yFill = this._elevation - 0.02 - r.depth * 0.002;
      for (const loop of r.polygons) {
        if (loop.length < 4) continue; // closed loop = first==last; need ≥3 distinct
        const pts: THREE.Vector2[] = [];
        for (let i = 0; i < loop.length - 1; i++) {
          pts.push(new THREE.Vector2(loop[i].x, loop[i].y));
        }
        const tris = THREE.ShapeUtils.triangulateShape(pts, []);
        for (const p of pts) {
          fillPositions.push(p.x, yFill, p.y);
          fillColors.push(color.r, color.g, color.b);
        }
        for (const tri of tris) {
          fillIndices.push(vertOffset + tri[0], vertOffset + tri[1], vertOffset + tri[2]);
        }
        vertOffset += pts.length;
      }
    }
    this._updateFillMesh(fillPositions, fillColors, fillIndices);
  }

  private _updateLineMesh(positions: number[], colors: number[]): void {
    if (positions.length === 0) {
      if (this._lineMesh) this._lineMesh.visible = false;
      return;
    }
    if (this._lineMesh === null) {
      try {
        const geo = new LineSegmentsGeometry();
        geo.setPositions(positions);
        geo.setColors(colors);
        const mat = new LineMaterial({
          vertexColors: true,
          linewidth: 2,
          transparent: true,
          opacity: 0.75,
          // Honour scene depth so elevated tiles (pinned y≈1.5) draw on
          // top instead of being hidden behind hull lines (y≈0.35).
          // depthWrite stays off — transparent meshes shouldn't pollute
          // the depth buffer for downstream alpha-blended geometry.
          depthTest: true,
          depthWrite: false,
          worldUnits: false,
        });
        if (typeof window !== 'undefined') {
          mat.resolution.set(window.innerWidth, window.innerHeight);
        }
        const mesh = new LineSegments2(geo, mat);
        mesh.computeLineDistances();
        mesh.renderOrder = 100;
        this.group.add(mesh);
        this._lineMesh = mesh;
        this._materials.push(mat);
      } catch {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const mat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.75,
          depthTest: true,
          depthWrite: false,
        });
        const mesh = new THREE.LineSegments(geo, mat);
        mesh.renderOrder = 100;
        this.group.add(mesh);
        this._lineMesh = mesh;
        this._materials.push(mat);
      }
    } else if (this._lineMesh instanceof LineSegments2) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(positions);
      geo.setColors(colors);
      this._lineMesh.geometry.dispose();
      this._lineMesh.geometry = geo;
      this._lineMesh.computeLineDistances();
    } else {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      this._lineMesh.geometry.dispose();
      this._lineMesh.geometry = geo;
    }
    this._lineMesh.visible = true;
  }

  private _updateFillMesh(positions: number[], colors: number[], indices: number[]): void {
    if (positions.length === 0) {
      if (this._fillMesh) this._fillMesh.visible = false;
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    if (this._fillMesh === null) {
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        // Lower fill opacity + honour depth so elevated tiles read
        // through the hull tint instead of being buried under it.
        opacity: 0.30,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      // Positions are already in world (x, y, z) frame — see
      // _rebuildMerged where each vertex is pushed as `(p.x, yFill, p.y)`,
      // mapping loop.y → world Z directly. No rotation needed (the old
      // per-region path used THREE.Shape in XY and rotated the resulting
      // XY geometry into XZ; we skip the intermediate frame).
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 50;
      this.group.add(mesh);
      this._fillMesh = mesh;
      this._materials.push(mat);
    } else {
      this._fillMesh.geometry.dispose();
      this._fillMesh.geometry = geo;
    }
    this._fillMesh.visible = true;
  }

  /** Pick the colour for one region. Prefers a caller-injected hue
   *  (tree-aware palette via `computeFolderHues`) and applies a
   *  depth-driven lightness ramp so nested folders read as a hue-
   *  preserving dark-light gradient. Falls back to the legacy depth-
   *  warmed palette when no hue is provided. */
  private _regionColor(r: HullRegionPrecomputed, layer: 'line' | 'fill'): THREE.Color {
    if (r.hue !== undefined) {
      const baseLight = layer === 'line' ? 0.62 : 0.45;
      const floor = layer === 'line' ? 0.42 : 0.28;
      const lightness = Math.max(floor, baseLight - r.depth * 0.05);
      return new THREE.Color().setHSL(r.hue / 360, 0.65, lightness);
    }
    const lightness = layer === 'line' ? 0.55 : 0.42;
    return this._depthColor(r.regionId, r.depth, lightness);
  }

  /** Depth-warmed palette: hue interpolates from sky-blue (shallow) to
   *  orange-red (deep), with a small per-region perturbation so siblings
   *  stay visually distinguishable. Used as fallback when callers don't
   *  inject a hue (legacy / no regionTree available). */
  private _depthColor(regionId: string, depth: number, lightness: number): THREE.Color {
    const depthNorm = Math.min(1, depth / 10);
    const jitter = ((hueFromString(regionId) % 20) - 10) / 360;
    const hue = ((210 - 195 * depthNorm) / 360 + jitter + 1) % 1;
    return new THREE.Color().setHSL(hue, 0.65, lightness);
  }

  /** Rendering mode — currently binary. Reserved for SceneManager
   *  wiring; additional styles (e.g. 'dashed', 'filled') can be added
   *  without changing call sites. */
  setStyle(style: HullStyle): void {
    switch (style) {
      case 'line':
        this.group.visible = true;
        break;
      case 'hidden':
        this.group.visible = false;
        break;
    }
  }

  /** Update LineMaterial resolution — required for LineMaterial's
   *  world-unit fallback to compute consistent pixel widths on
   *  window resize. No-op for LineBasicMaterial (fallback path). */
  setResolution(w: number, h: number): void {
    for (const m of this._materials) {
      if (m instanceof LineMaterial) m.resolution.set(w, h);
    }
  }

  /** Drop the persistent mesh pool + dispose all current meshes, but
   *  keep the layer attached to the scene. Callers invoke this when
   *  the underlying hullCache identity changes (new graph loaded) so
   *  subsequent `setRegionHulls` doesn't leak stale entries. */
  resetPool(): void {
    this._clear();
  }

  /** Remove all hull meshes, dispose their GPU resources, detach the
   *  root group from the scene. Safe to call multiple times. */
  dispose(): void {
    this._clear();
    this._scene.remove(this.group);
  }

  // ── Internals ─────────────────────────────────────────────────

  /** Clear children and dispose their geometry/materials. Also drops
   *  the polygon cache so subsequent setRegionHulls calls show nothing
   *  until primeRegions is called again. */
  private _clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const mesh = child as THREE.Object3D & {
        geometry?: { dispose?: () => void };
      };
      mesh.geometry?.dispose?.();
    }
    for (const m of this._materials) m.dispose();
    this._materials.length = 0;
    this._polygonCache.clear();
    this._lineMesh = null;
    this._fillMesh = null;
  }

  /** Convert one 2-D hull loop → a LineSegments2 (or LineBasicMaterial
   *  LineSegments fallback) mesh placed at the layer's elevation and
   *  coloured from the region's path hash. */
  private _appendLoopMesh(loop: HullLoop, regionPath: string): void {
    // Build flat positions for LineSegmentsGeometry: each edge =
    // two consecutive corners, emitted as (a, b) pairs. This matches
    // the original HullLayer's independent-segment approach (robust,
    // no corner gaps when linewidth is large).
    if (loop.length < 2) return;
    const flat: number[] = [];
    const y = this._elevation;
    for (let i = 0; i < loop.length - 1; i++) {
      const a = loop[i];
      const b = loop[i + 1];
      flat.push(a.x, y, a.y, b.x, y, b.y);
    }
    if (flat.length === 0) return;

    const hue = hueFromString(regionPath) / 360;
    const color = new THREE.Color().setHSL(hue, 0.6, 0.65);

    // Prefer LineSegments2 (respects linewidth on all platforms) but
    // fall back to LineBasicMaterial + LineSegments if anything in the
    // import chain is unavailable (keeps the layer resilient in tests
    // and restricted runtimes where LineMaterial.resolution needs
    // a DOM-ish setup).
    try {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(flat);
      const mat = new LineMaterial({
        color: color.getHex(),
        linewidth: 2,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
        worldUnits: false,
      });
      if (typeof window !== 'undefined') {
        mat.resolution.set(window.innerWidth, window.innerHeight);
      }
      const mesh = new LineSegments2(geo, mat);
      mesh.computeLineDistances();
      mesh.renderOrder = 100 + Math.round(this._elevation * 10);
      this.group.add(mesh);
      this._materials.push(mat);
    } catch {
      // Fallback: plain LineSegments. Used when LineSegments2's GPU
      // prerequisites aren't available (extremely rare in practice;
      // covers stubbed / hostile environments).
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
      const mat = new THREE.LineBasicMaterial({
        color: color.getHex(),
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.LineSegments(geo, mat);
      mesh.renderOrder = 100 + Math.round(this._elevation * 10);
      this.group.add(mesh);
      this._materials.push(mat);
    }
  }
}
