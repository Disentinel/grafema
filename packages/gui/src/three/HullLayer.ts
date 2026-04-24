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
  private _materials: Array<LineMaterial | THREE.LineBasicMaterial> = [];
  private _elevation = DEFAULT_ELEVATION;
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
    this._generation++; // invalidate any in-flight async setRegions
    this._clear();
    for (const r of regions) {
      for (const loop of r.polygons) {
        this._appendLoopMeshDepthColored(loop, r.regionId, r.depth);
      }
    }
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

  /** Remove all hull meshes, dispose their GPU resources, detach the
   *  root group from the scene. Safe to call multiple times. */
  dispose(): void {
    this._clear();
    this._scene.remove(this.group);
  }

  // ── Internals ─────────────────────────────────────────────────

  /** Clear children and dispose their geometry/materials. */
  private _clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      // Line meshes (both LineSegments2 and LineSegments) carry a
      // BufferGeometry/LineSegmentsGeometry — both expose .dispose().
      const mesh = child as THREE.Object3D & {
        geometry?: { dispose?: () => void };
      };
      mesh.geometry?.dispose?.();
    }
    for (const m of this._materials) m.dispose();
    this._materials.length = 0;
  }

  /**
   * Depth-warmed palette for precomputed-polygon rendering.
   * Hue interpolates from sky-blue (shallow) to orange-red (deep) with a
   * small path-hash perturbation so same-depth siblings stay visually
   * distinguishable. Alpha in [0.15, 0.3] keeps the fill subtle so
   * overlapping hulls read cleanly.
   */
  private _appendLoopMeshDepthColored(
    loop: HullLoop,
    regionId: string,
    depth: number,
  ): void {
    if (loop.length < 2) return;
    const flat: number[] = [];
    const y = this._elevation;
    for (let i = 0; i < loop.length - 1; i++) {
      const a = loop[i];
      const b = loop[i + 1];
      flat.push(a.x, y, a.y, b.x, y, b.y);
    }
    if (flat.length === 0) return;

    // Normalise depth against a soft ceiling (10 is the plan's practical
    // max after effectiveDMax caps at 12). Linearly walk hue from 210°
    // (sky blue) down to 15° (orange-red). Small per-region perturbation
    // (±10°) keeps siblings distinct without breaking the gradient.
    const depthNorm = Math.min(1, depth / 10);
    const jitter = ((hueFromString(regionId) % 20) - 10) / 360;
    const hue = ((210 - 195 * depthNorm) / 360 + jitter + 1) % 1;
    const color = new THREE.Color().setHSL(hue, 0.65, 0.55);
    const opacity = 0.15 + depthNorm * 0.15; // 0.15..0.30

    try {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(flat);
      const mat = new LineMaterial({
        color: color.getHex(),
        linewidth: 2,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
        worldUnits: false,
      });
      if (typeof window !== 'undefined') {
        mat.resolution.set(window.innerWidth, window.innerHeight);
      }
      const mesh = new LineSegments2(geo, mat);
      mesh.computeLineDistances();
      // Deeper regions get a higher renderOrder — on top.
      mesh.renderOrder = 100 + depth;
      this.group.add(mesh);
      this._materials.push(mat);
    } catch {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
      const mat = new THREE.LineBasicMaterial({
        color: color.getHex(),
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.LineSegments(geo, mat);
      mesh.renderOrder = 100 + depth;
      this.group.add(mesh);
      this._materials.push(mat);
    }
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
