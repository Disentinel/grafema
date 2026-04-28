/**
 * Extracted side-effects for the Canvas component.
 *
 * The "monster useEffect" in Canvas.tsx used to construct layers, subscribe
 * to every store, wire pointer events, and expose a SceneApi in one 600+
 * line block. This module factors each cohesive step into a named helper
 * so Canvas becomes a thin orchestrator. Each helper:
 *
 *   1. Takes just the dependencies it needs (plain refs / primitives).
 *   2. Returns a small result object — typically the constructed layer
 *      (so Canvas can hand it to the next helper) plus a `dispose` or
 *      `unsubscribe` closure for React's useEffect cleanup.
 *   3. Has no React concerns of its own (no hooks, no state). It's the
 *      imperative glue Canvas delegates to; Canvas owns the lifecycle.
 *
 * Splitting into helpers (instead of custom hooks with their own
 * useEffect) keeps the single-useEffect cleanup semantics the original
 * code relied on — teardown order is preserved exactly.
 */

import * as THREE from 'three';
import { HexLayer } from '../three/HexLayer';
import {
  HullLayer,
  type HullRegion,
  type HullRegionPrecomputed,
} from '../three/HullLayer';
import { WallLayer } from '../three/WallLayer';
import type { HexCoord } from '../geom/hex';
import { worldToAxial } from '../store/loadStream';
import { loadEdges } from '../store/loadEdges';
import { RegionLayer } from '../three/RegionLayer';
import { FlowLayer } from '../three/FlowLayer';
import { RouteLayer } from '../three/RouteLayer';
import type { SceneManager } from '../three/SceneManager';
import type { GraphNode, GraphEdge } from '../store/dataStore';
import type { EdgeLabelData } from '../components/EdgeLabels';
import { useDataStore } from '../store/dataStore';
import { useViewStore } from '../store/viewStore';
import { useRouteStore } from '../store/routeStore';
import { useDiffStore, type NodeChange } from '../store/diffStore';
import { useLayoutStore, type RegionInfo } from '../store/layoutStore';
import { computeFolderHues } from '../hulls/folderHues';
import { deriveLodVisibility, normalizeZoom } from '../lod/render';
import { filterVisibleRoutes } from '../lod/routeGate';
import { LENSES } from '../config/lenses';
import { FLOWS } from '../config/flows';
import { reduceSelection, type FocusIntent } from '../controller/focus';
import { routeTooltip, type HoverTarget, type TooltipContent } from '../controller/tooltip';
import type { SceneApi } from '../controller/SceneApi';

export const TILE_SIZE = 3.0;

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing.
// ---------------------------------------------------------------------------

/**
 * Build HullRegion[] from live nodes + regions. Tile axial coords come
 * from the layout's `globalThis.__grafemaTileCoords` table (same source
 * RegionLayer reads). If the globals table is missing we degrade to
 * empty tiles per region — HullLayer renders nothing in that case.
 */
export function buildHullRegions(
  nodes: ReadonlyArray<{ region: string }>,
  regions: ReadonlyArray<{ path: string }>,
): HullRegion[] {
  const tileCoords = (globalThis as Record<string, unknown>).__grafemaTileCoords as
    | Map<number, { q: number; r: number }>
    | undefined;
  const byRegion = new Map<string, HexCoord[]>();
  for (const r of regions) byRegion.set(r.path, []);
  if (tileCoords) {
    for (let i = 0; i < nodes.length; i++) {
      const coord = tileCoords.get(i);
      if (!coord) continue;
      const bucket = byRegion.get(nodes[i].region);
      if (bucket) bucket.push({ q: coord.q, r: coord.r });
    }
  }
  return regions.map((r) => ({ path: r.path, tiles: byRegion.get(r.path) ?? [] }));
}

/** Translate id-keyed pins into the index-keyed shape HexLayer.setPins consumes. */
export function buildPinIndexMap(
  nodes: ReadonlyArray<{ id: string }>,
  pins: ReadonlyMap<string, { color: string }>,
): Map<number, { color: number }> {
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) idToIdx.set(nodes[i].id, i);
  const result = new Map<number, { color: number }>();
  for (const [id, info] of pins) {
    const idx = idToIdx.get(id);
    if (idx === undefined) continue;
    const parsed = parseInt(info.color.replace(/^#/, ''), 16);
    result.set(idx, { color: Number.isFinite(parsed) ? parsed : 0xffffff });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

/**
 * Build the hex tile layer from nodes, apply the current lens, and
 * subscribe to lens + diff store changes. Returns the layer and an
 * unsubscribe closure that tears down both subscriptions.
 */
export function buildHexLayerWithSubscriptions(
  sm: SceneManager,
  nodes: GraphNode[],
  getFlowLayer: () => FlowLayer | null,
): { layer: HexLayer; unsubscribe: () => void } {
  const layer = new HexLayer(nodes.length, TILE_SIZE * 0.92, sm.scene);
  for (let i = 0; i < nodes.length; i++) {
    layer.setTile(i, nodes[i].x, nodes[i].z, 0x000000);
  }

  // Heightmap — per-tile base elevation derived from node degree.
  // sqrt compresses the power-law tail (a few hubs at degree 100+,
  // long tail at 1-3) so high-degree nodes don't dwarf the rest.
  // baseElevation lives separately from pin/diff overrides so unpin
  // restores it instead of clamping to 0 and erasing the heightmap.
  const baseElevation = new Float32Array(nodes.length);
  function recomputeBase(mult: number) {
    let maxBase = 0;
    for (let i = 0; i < nodes.length; i++) {
      const v = Math.sqrt(Math.max(0, nodes[i].degree)) * mult;
      baseElevation[i] = v;
      if (v > maxBase) maxBase = v;
    }
    // Stashed on globalThis so HullLayer's heightmap subscriber can lift
    // its group above the tallest column without a direct dep on this
    // closure (HullLayer is built in a separate helper). Updated every
    // recompute so a `__setElev` tweak relifts hulls in lockstep. The
    // event covers the case where buildHullLayer runs BEFORE this hex
    // builder — in that ordering, hull's initial liftHullsForHeightmap
    // would have read undefined, leaving hulls buried.
    (globalThis as Record<string, unknown>).__hexMaxBase = maxBase;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('grafema:heightmap-recomputed'));
    }
  }
  // SceneManager is render-on-demand: `_dirty=false` after each frame
  // so a Zustand-subscriber-driven animation (no mouse / control events
  // keeping the loop alive) freezes mid-tween. `sm.pumpRender(ms)`
  // keeps the loop dirty for the animation duration; same helper is
  // reused by the click / select handlers downstream.
  function applyHeightmap(mult: number, animate: boolean) {
    recomputeBase(mult);
    if (animate) {
      for (let i = 0; i < nodes.length; i++) {
        layer.animateTo(i, 'elevation', baseElevation[i], 600);
      }
      sm.pumpRender(700);
    } else {
      for (let i = 0; i < nodes.length; i++) {
        layer.setProperty(i, 'elevation', baseElevation[i]);
      }
      sm.requestRender();
    }
  }
  applyHeightmap(useViewStore.getState().heightMultiplier, false);
  // Expose elevation array so pin/unpin handlers (built later in
  // setupPointerInteractions) can do additive offsets without a
  // second store subscription.
  (layer as unknown as { _baseElevation: Float32Array })._baseElevation = baseElevation;

  // DevTools convenience — `__setElev(2.5)` to retune live without
  // poking the store. Drops on dispose via the unsub closure below.
  (globalThis as Record<string, unknown>).__setElev = (n: number) => {
    useViewStore.getState().setHeightMultiplier(n);
  };
  // Debug: expose the layer + base array so we can verify the heightmap
  // path end-to-end from a Playwright probe.
  (globalThis as Record<string, unknown>).__hexLayer = layer;
  (globalThis as Record<string, unknown>).__baseElev = baseElevation;
  (globalThis as Record<string, unknown>).__heightmapDiag = () => {
    const el = layer.elevationArray;
    let max = 0, sum = 0, nonZero = 0;
    for (let i = 0; i < el.length; i++) {
      if (el[i] > max) max = el[i];
      if (el[i] > 0) nonZero++;
      sum += el[i];
    }
    let baseMax = 0, baseSum = 0, baseNonZero = 0;
    for (let i = 0; i < baseElevation.length; i++) {
      if (baseElevation[i] > baseMax) baseMax = baseElevation[i];
      if (baseElevation[i] > 0) baseNonZero++;
      baseSum += baseElevation[i];
    }
    return {
      mult: useViewStore.getState().heightMultiplier,
      mode: useViewStore.getState().mode,
      nodeCount: nodes.length,
      degreeSample: nodes.slice(0, 5).map((n) => n.degree),
      baseElev: { max: baseMax, mean: baseSum / baseElevation.length, nonZero: baseNonZero },
      liveElev: { max, mean: sum / el.length, nonZero },
    };
  };

  const unsubHeightmap = useViewStore.subscribe((state, prev) => {
    if (state.heightMultiplier === prev.heightMultiplier) return;
    applyHeightmap(state.heightMultiplier, true);
  });

  function applyLens(lensName: string) {
    const lens = LENSES[lensName] ?? LENSES.region;
    for (let i = 0; i < nodes.length; i++) {
      const color = lens.colorFn(nodes[i], nodes);
      layer.animateColor(i, 'color', color, 400);
    }
  }
  // Initial coloring — immediate, no animation.
  const initialLens = LENSES[useViewStore.getState().lens] ?? LENSES.region;
  for (let i = 0; i < nodes.length; i++) {
    const color = initialLens.colorFn(nodes[i], nodes);
    layer.setTile(i, nodes[i].x, nodes[i].z, color);
  }
  layer.finalize();

  const unsubLens = useViewStore.subscribe((state, prev) => {
    if (state.lens !== prev.lens) {
      applyLens(state.lens);
      const lens = LENSES[state.lens];
      const fl = getFlowLayer();
      if (lens?.legend === 'gradient') {
        fl?.recolorByNodes((ni) => lens.colorFn(nodes[ni], nodes));
      } else {
        fl?.recolorByNodes(null);
      }
    }
  });

  const unsubDiff = useDiffStore.subscribe((state, prev) => {
    if (state.active === prev.active && state.added === prev.added) return;
    const fl = getFlowLayer();
    if (state.active) {
      const diffActive = new Set<number>();
      for (let i = 0; i < nodes.length; i++) {
        if (state.removed.has(i)) {
          layer.animateTo(i, 'opacity', 0.25, 500);
          layer.animateTo(i, 'elevation', 1.2, 500);
          layer.animateTo(i, 'outlineWidth', 0.2, 300);
          layer.setOutlineColor(i, 0xff4466);
          layer.animateColor(i, 'color', 0xff4466, 500);
          diffActive.add(i);
        } else if (state.added.has(i)) {
          layer.animateTo(i, 'elevation', 1.5, 500);
          layer.animateTo(i, 'outlineWidth', 0.2, 300);
          layer.setOutlineColor(i, 0x22cc66);
          layer.animateColor(i, 'color', 0x22cc66, 500);
          diffActive.add(i);
        } else if (state.changed.has(i)) {
          layer.animateTo(i, 'outlineWidth', 0.3, 300);
          layer.setOutlineColor(i, 0xffaa00);
          layer.animateTo(i, 'elevation', 1.0, 400);
          layer.animateColor(i, 'color', 0xffaa00, 500);
          diffActive.add(i);
        } else {
          layer.animateTo(i, 'opacity', 0.3, 400);
        }
      }
      fl?.highlightEdges(diffActive);
    } else {
      const lens = LENSES[useViewStore.getState().lens] ?? LENSES.region;
      for (let i = 0; i < nodes.length; i++) {
        layer.animateTo(i, 'opacity', 1.0, 400);
        layer.animateTo(i, 'elevation', 0, 400);
        layer.animateTo(i, 'outlineWidth', 0, 300);
        layer.animateColor(i, 'color', lens.colorFn(nodes[i], nodes), 500);
      }
      fl?.highlightEdges(null);
    }
  });

  sm.onRender((dt) => layer.tick(dt));

  // Heightmap demo (April 2026) — keep the instanced tile mesh visible
  // at every zoom so per-tile elevation forms a 3D landscape even at
  // package/region LOD. The DAI-22 LOD gate that hid tiles below
  // `symbolZoomThreshold` saved a single instanced draw call (~35k
  // instances) — cheap on modern GPUs, and losing the heightmap at
  // zoomed-out views (the default load state) defeats the visual.
  layer.mesh.visible = true;
  void normalizeZoom; void deriveLodVisibility; // re-imported for hulls below.

  return {
    layer,
    unsubscribe: () => {
      unsubLens();
      unsubDiff();
      unsubHeightmap();
    },
  };
}

/** Build the region border layer (gap-fill quads). */
export function buildRegionLayer(
  sm: SceneManager,
  nodes: GraphNode[],
  regions: ReadonlyArray<{ path: string }>,
): RegionLayer {
  const regionLayer = new RegionLayer(sm.scene);
  // RegionLayer.build reads the original Region[] shape (with border/centroid);
  // the caller passes the full dataStore regions so the types line up.
  regionLayer.build(nodes, regions as Parameters<RegionLayer['build']>[1]);
  return regionLayer;
}

/**
 * DAI-22 Chunk-8b — build the hull layer wired to `layoutStore.hullCache`.
 *
 * Reads precomputed polygons from the layout store (Chunk-7/8 populated
 * by `computeHullsForRegions` on stream load), applies per-frame LOD
 * filtering via `deriveLodVisibility`, and rebuilds hull meshes
 * whenever either the camera zoom or the cache itself changes.
 *
 * The legacy `__grafemaTileCoords` + `buildHullRegions` path is no
 * longer reached from Canvas — retained in this module for
 * back-compat only (tests may still exercise it, and some downstream
 * hosts read `buildHullRegions` directly).
 *
 * Returns both the layer and the teardown closure so Canvas can undo
 * the store subscriptions on scene dispose. `signal` is accepted for
 * API parity with the old builder — since the precomputed-polygon path
 * is synchronous there is nothing to abort mid-flight, but the param
 * is preserved so callers don't have to branch.
 */
export function buildHullLayer(
  sm: SceneManager,
  _nodes: GraphNode[],
  _regions: ReadonlyArray<{ path: string }>,
  _signal?: AbortSignal,
): { layer: HullLayer; unsubscribe: () => void } {
  const hullLayer = new HullLayer(sm.scene);
  hullLayer.setStyle(useViewStore.getState().mode.hullStyle);

  // City-mode walls along hull borders. Built / refreshed alongside
  // hulls in `applyFrame` below; height tracks `__hexMaxBase` so walls
  // align with the tallest column. Hidden when heightMultiplier=0
  // (Flat view) — flat hulls don't need walls.
  const wallLayer = new WallLayer(sm.scene);

  // Last-applied zoom bucket (quantised) so we skip rebuilds when the
  // camera barely moved. 3 digits of precision ≈ 0.1% zoom steps —
  // tight enough that boundary crossings still fire, loose enough to
  // avoid rebuilding at 60Hz during a continuous pan.
  let lastBucket = -1;
  let lastCacheRef: unknown = null;
  // Tree-aware hue palette. Recomputed on regionTree identity change
  // (a fresh stream load); read on every applyFrame so visible-bucket
  // changes inherit the hue without re-walking the tree.
  let huesByRegion: Map<string, number> = new Map();
  let lastTreeRef: unknown = null;

  let frameCounter = 0;
  let frameWindowStart = performance.now();
  const applyFrame = () => {
    frameCounter++;
    const now = performance.now();
    if (now - frameWindowStart > 1000) {
      if (frameCounter > 65) {
        console.warn(`[perf] canvasBuild.applyFrame fired ${frameCounter}× in ${(now - frameWindowStart).toFixed(0)}ms`);
      }
      frameCounter = 0;
      frameWindowStart = now;
    }
    const { regionTree, hullCache } = useLayoutStore.getState();
    const zoom01 = normalizeZoom(sm.getView());
    const bucket = Math.round(zoom01 * 1000);
    if (regionTree !== lastTreeRef) {
      huesByRegion = computeFolderHues(regionTree);
      lastTreeRef = regionTree;
    }
    // Distance fade has to retick continuously (not just on bucket
    // changes) since orbit-controls can shift distance without crossing
    // a quantised zoom step. Apply it on every frame call BEFORE the
    // bucket short-circuit so the fade is smooth.
    {
      const dist = sm.camera.position.distanceTo(sm.controls.target);
      const distFade = Math.max(0, Math.min(1, (dist - 70) / 100));
      const baseFill = 0.30 - 0.24 * Math.min(1, Math.max(0, zoom01));
      hullLayer.setFillOpacity(baseFill * distFade);
      wallLayer.setOpacityScale(distFade);
    }
    if (bucket === lastBucket && hullCache === lastCacheRef) return;
    console.warn(`[perf] canvasBuild bucket ${lastBucket}→${bucket} cache ${hullCache === lastCacheRef ? 'same' : 'changed'}`);
    // Cache identity change (new stream load): drop the mesh pool and
    // PRIME all region meshes up-front. Without priming, the first zoom
    // into a previously-hidden region would lazy-allocate 5-20 meshes
    // in one frame — triggers a GC pause visible as a freeze-then-jump
    // cycle on continuous pan/zoom. Prime eats the cost once, then
    // bucket changes only flip `mesh.visible`.
    if (hullCache !== lastCacheRef) {
      hullLayer.resetPool();
      if (hullCache.size > 0) {
        const allEntries: HullRegionPrecomputed[] = [];
        for (const [regionId, geometry] of hullCache) {
          const region = regionTree.byId.get(regionId);
          if (!region) continue;
          allEntries.push({ regionId, depth: region.depth, polygons: geometry.polygons, hue: huesByRegion.get(regionId) });
        }
        hullLayer.primeRegions(allEntries);
      }
    }
    lastBucket = bucket;
    lastCacheRef = hullCache;

    if (hullCache.size === 0) {
      hullLayer.setRegionHulls([]);
      return;
    }
    const { visibleHulls } = deriveLodVisibility({
      regionTree,
      hullCache,
      zoom01,
    });
    const entries: HullRegionPrecomputed[] = visibleHulls.map((v) => ({
      regionId: v.regionId,
      depth: v.region.depth,
      polygons: v.geometry.polygons,
      hue: huesByRegion.get(v.regionId),
    }));
    hullLayer.setRegionHulls(entries);
    // LOD-aware fill opacity: at fit-all (zoom01≈0) the hull tint is
    // the primary regional cue, so keep it visible; as the user zooms
    // in to per-tile LOD (zoom01→1) the tiles become the focus and the
    // overlay would just obscure them. Lerp 0.30 → 0.06 across the
    // zoom range. Outline lines stay full opacity (border is useful
    // at every level).
    // (Fill / wall fade applied above in the always-on prefix so the
    // bucket short-circuit doesn't gate it.)
  };

  // Initial paint — covers the case where the hull cache is already
  // populated at the time Canvas builds the scene (common: stream load
  // finishes before data flows through to React).
  applyFrame();

  // Cache-change driver — stream-load hydration fires this.
  const unsubLayout = useLayoutStore.subscribe((state, prev) => {
    if (state.hullCache !== prev.hullCache) {
      applyFrame();
      sm.requestRender();
    }
  });

  // Per-frame driver — cheap: applyFrame short-circuits when the
  // quantised zoom bucket and cache identity are unchanged.
  sm.onRender(applyFrame);

  // Heightmap-aware lift — keep hulls above the tallest column so the
  // outline never sinks into the terrain. `__hexMaxBase` is written by
  // buildHexLayerWithSubscriptions on every recompute (initial + each
  // `__setElev` tweak); read it on the same subscription so the lift
  // tracks the multiplier in lockstep. +1.0 buffer prevents Z-fighting
  // when the tallest column happens to land on an integer height.
  function liftHullsForHeightmap() {
    const maxBase = (globalThis as Record<string, unknown>).__hexMaxBase as
      | number
      | undefined;
    // +3.0 buffer puts the hull cloud well above the tallest column —
    // +1.0 grazed the column tops and looked like the cloud was sitting
    // on the city. The extra 2 units of air read as "ceiling".
    const top = (maxBase ?? 0) + 3.0;
    hullLayer.group.position.y = top;
    // Walls extrude from y=0 to the same top so the outline sits at
    // the wall's crown. Hide walls in Flat mode (mult=0) — the
    // heightmap is off so there's nothing to enclose.
    const mult = useViewStore.getState().heightMultiplier;
    wallLayer.setHeight(top);
    wallLayer.setVisible(mult > 0);
    sm.requestRender();
  }

  // Walls follow the same precomputed polygons HullLayer uses. Rebuild
  // happens on hullCache identity change OR heightmap recompute (via
  // event) — same triggers as `liftHullsForHeightmap`. Folded into
  // applyFrame's bucket-change branch would over-rebuild on every zoom
  // bucket; we only need a rebuild when the polygon set changes.
  let lastWallCacheRef: unknown = null;
  function rebuildWalls() {
    const { hullCache, regionTree } = useLayoutStore.getState();
    if (hullCache === lastWallCacheRef) return;
    lastWallCacheRef = hullCache;
    if (hullCache.size === 0) {
      wallLayer.setHullPolygons([]);
      return;
    }
    // Skip file-level hulls (per-file fences would create one fence per
    // tile cluster — visual noise). Keep package + sub-folder envelopes
    // (depth ≤ 3) so the city reads as walled districts at every zoom.
    const allPolys: Array<readonly import('../geom/hull').HullLoop[]> = [];
    for (const [regionId, geometry] of hullCache) {
      const region = regionTree.byId.get(regionId);
      if (!region || region.depth > 3) continue;
      allPolys.push(geometry.polygons);
    }
    wallLayer.setHullPolygons(allPolys);
    sm.requestRender();
  }
  rebuildWalls();
  liftHullsForHeightmap();
  // Single source of truth: hex builder dispatches `heightmap-recomputed`
  // after every recomputeBase (initial setProperty + each animateTo
  // batch). Listening covers both the post-build initial sync and live
  // tweaks via __setElev — no need to also subscribe to viewStore here.
  const onHeightmapEvent = () => liftHullsForHeightmap();
  window.addEventListener('grafema:heightmap-recomputed', onHeightmapEvent);

  // Rebuild walls when stream-load hydration repopulates the hull
  // cache (same trigger HullLayer uses to repaint).
  const unsubWalls = useLayoutStore.subscribe((state, prev) => {
    if (state.hullCache !== prev.hullCache) {
      rebuildWalls();
      liftHullsForHeightmap();
    }
  });

  return {
    layer: hullLayer,
    unsubscribe: () => {
      unsubLayout();
      unsubWalls();
      window.removeEventListener('grafema:heightmap-recomputed', onHeightmapEvent);
      wallLayer.dispose();
    },
  };
}

/**
 * Build the flow (edge) layer. Edges are downsampled when the count
 * exceeds `MAX_FLOW_EDGES` because FlowLayer creates one Mesh per edge,
 * which stalls the main thread beyond a few thousand tubes.
 */
export function buildFlowLayer(
  sm: SceneManager,
  nodes: GraphNode[],
  edges: GraphEdge[],
  hexLayer: HexLayer,
): FlowLayer {
  const flowLayer = new FlowLayer(sm.scene);
  const MAX_FLOW_EDGES = 20000;
  let flowEdges = edges;
  if (edges.length > MAX_FLOW_EDGES) {
    const step = Math.ceil(edges.length / MAX_FLOW_EDGES);
    flowEdges = edges.filter((_, i) => i % step === 0);
    if (import.meta.env?.DEV) {
       
      console.log(
        `[Canvas] downsampled edges for FlowLayer: ${edges.length} → ${flowEdges.length} (step=${step})`,
      );
    }
  }
  flowLayer.build(nodes, flowEdges);
  flowLayer.setElevationSource(hexLayer.elevationArray);
  sm.onRender(() => flowLayer.tick());
  return flowLayer;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Wire the route layer + its elevation-propagation side-effects. The
 * caller supplies mutable selection state (`selectedConnectedRef`,
 * `getSelectedIdx`) so route highlights can coexist with click
 * selection and pin elevations.
 *
 * Returns the unsubscribe closure; the RouteLayer itself is returned
 * separately so the SceneApi can close over it.
 */
export function setupRoutes(
  sm: SceneManager,
  hexLayer: HexLayer,
  flowLayer: FlowLayer,
  nodes: GraphNode[],
  edges: GraphEdge[],
  selectedConnectedRef: { current: Set<number> },
  getSelectedIdx: () => number,
): { routeLayer: RouteLayer; unsubscribe: () => void } {
  const routeLayer = new RouteLayer(sm.scene);
  let prevRouteNodes = new Set<number>();

  function applyRoutes() {
    const allRoutes = useRouteStore.getState().routes;
    // Fast path — no routes, nothing to highlight, no tweens to schedule.
    // Without this, every zoom-bucket change still ran deriveLodVisibility
    // + filterVisibleRoutes + a routeLayer.update on empty input, which
    // showed up as 50-100ms of self-time during pan in the DAI-22 trace.
    if (allRoutes.length === 0 && prevRouteNodes.size === 0) return;
    const { regionTree, hullCache } = useLayoutStore.getState();
    const zoom01 = normalizeZoom(sm.getView());
    let routesToRender = allRoutes;
    if (hullCache.size > 0 && regionTree.byId.size > 0) {
      const { visibleHulls } = deriveLodVisibility({ regionTree, hullCache, zoom01 });
      const visibleRegionIds = new Set(visibleHulls.map((h) => h.regionId));
      const fileToRegionId = (file: string) => regionTree.byFile.get(file);
      routesToRender = filterVisibleRoutes(
        allRoutes,
        nodes,
        visibleRegionIds,
        fileToRegionId,
      );
    }
    routeLayer.update(routesToRender, nodes, edges);
    const newRouteNodes = routeLayer.activeNodeIndices;
    const selIdx = getSelectedIdx();

    const baseElev = (hexLayer as unknown as { _baseElevation?: Float32Array })
      ._baseElevation;
    const baseOf = (i: number) => baseElev?.[i] ?? 0;
    for (const i of prevRouteNodes) {
      if (!newRouteNodes.has(i) && i !== selIdx && !selectedConnectedRef.current.has(i)) {
        hexLayer.animateTo(i, 'elevation', baseOf(i), 300);
        hexLayer.animateTo(i, 'outlineWidth', 0, 200);
      }
    }
    for (const i of newRouteNodes) {
      if (i !== selIdx && !selectedConnectedRef.current.has(i)) {
        hexLayer.animateTo(i, 'elevation', baseOf(i) + 1.5, 300);
        hexLayer.animateTo(i, 'outlineWidth', 0.1, 200);
        hexLayer.setOutlineColor(i, 0xffffff);
      }
    }
    prevRouteNodes = new Set(newRouteNodes);

    if (newRouteNodes.size > 0) {
      flowLayer.highlightEdges(newRouteNodes, 'both');
    } else {
      flowLayer.highlightEdges(null);
    }
    // Render-on-demand pump for the elevation/outline animations
    // queued above (longest 350ms).
    if (prevRouteNodes.size > 0 || newRouteNodes.size > 0) {
      sm.pumpRender(450);
    }
    // reference edges only to keep the closure capture live; the flow
    // layer reads edges through its own stored reference already.
    void edges;
  }

  applyRoutes();
  sm.onRender((dt) => routeLayer.tick(dt));

  // Re-apply when zoom bucket changes so the LOD gate (DAI-22 §C.5)
  // updates as the user zooms. Quantise to 1% zoom steps to avoid
  // per-frame churn.
  let lastRouteBucket = -1;
  let lastRouteCacheRef: unknown = null;
  sm.onRender(() => {
    const { hullCache } = useLayoutStore.getState();
    const z = normalizeZoom(sm.getView());
    const bucket = Math.round(z * 100);
    if (bucket === lastRouteBucket && hullCache === lastRouteCacheRef) return;
    lastRouteBucket = bucket;
    lastRouteCacheRef = hullCache;
    const tStart = performance.now();
    applyRoutes();
    const dt = performance.now() - tStart;
    if (dt > 4) console.warn(`[perf] applyRoutes ${dt.toFixed(1)}ms (bucket ${bucket})`);
  });

  const unsubRoutes = useRouteStore.subscribe(applyRoutes);
  const unsubLayoutForRoutes = useLayoutStore.subscribe((s, prev) => {
    if (s.hullCache !== prev.hullCache) applyRoutes();
  });
  return {
    routeLayer,
    unsubscribe: () => {
      unsubRoutes();
      unsubLayoutForRoutes();
    },
  };
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

export interface InteractionDeps {
  sm: SceneManager;
  container: HTMLDivElement;
  hexLayer: HexLayer;
  flowLayer: FlowLayer;
  routeLayer: RouteLayer;
  /** Optional — interaction handlers use it for hull tooltip hit-tests
   *  (point-in-poly against cached region polygons). When absent, hull
   *  hover is silently skipped (legacy callers / SSR pre-mount). */
  hullLayer?: HullLayer;
  nodes: GraphNode[];
  edges: GraphEdge[];
  edgeLabelsRef: { current: EdgeLabelData[] };
  setTooltip: (t: {
    x: number;
    y: number;
    content: TooltipContent;
    edges: string[];
  } | null) => void;
  /** Shared selection state mutated by click handler, read by routes. */
  selectedConnectedRef: { current: Set<number> };
}

/**
 * Attach pointer interaction (hover, click, dblclick) to the renderer
 * canvas. Returns a cleanup closure that removes all listeners.
 *
 * The handler graph:
 *   - `mousemove` → raycast → hover outline + hover tooltip.
 *   - `click` → delayed (250ms) to distinguish from dblclick → selection
 *     reducer → elevation / outline / opacity per node → flow + tooltip.
 *   - `dblclick` → toggle pin → visual pin marker.
 *
 * Extracted from the original monster useEffect verbatim; logic is
 * unchanged so existing Playwright flows keep passing.
 */
export function setupInteraction(deps: InteractionDeps): () => void {
  const {
    sm, container, hexLayer: layer, flowLayer, routeLayer, hullLayer,
    nodes, edges, edgeLabelsRef, setTooltip, selectedConnectedRef,
  } = deps;

  let hoveredIdx = -1;
  // True when the current edge highlight on FlowLayer was set by hover
  // (not click selection / route activation). Used to avoid stomping
  // those owners when hover leaves a node.
  let hoverHighlightActive = false;

  // Reused buffers for hull hover ray-plane intersection. Allocated
  // once outside the hot path — onMouseMove fires on every pointer
  // event and we don't want GC pressure from per-event Vector3 churn.
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const groundHit = new THREE.Vector3();

  // axial(q,r) → node index. Built once at setup so the hover
  // fallback (when HexLayer.raycast misses the inner-92% hex
  // geometry but the cursor IS over the cell) can resolve the tile
  // without a linear scan. Mirrors the axial conversion the layout
  // emitter uses, so a node placed at (q,r) is found by hovering
  // anywhere inside its hull cell.
  const axialToNodeIdx = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const { q, r } = worldToAxial(nodes[i].x, nodes[i].z);
    axialToNodeIdx.set(`${q},${r}`, i);
  }

  // Cached "leaf-files in subtree" count per regionId. Populated lazily
  // on first hull-hover, invalidated when the regionTree identity flips
  // (fresh stream load). The hover handler reads this for the hull
  // tooltip's `files` row — a true count rather than direct-childIds.
  let regionLeafCountTreeRef: unknown = null;
  const regionLeafCount = new Map<string, number>();
  function leafCount(regionId: string, byId: Map<string, RegionInfo>): number {
    const cached = regionLeafCount.get(regionId);
    if (cached !== undefined) return cached;
    const info = byId.get(regionId);
    if (!info) { regionLeafCount.set(regionId, 0); return 0; }
    if (info.kind === 'file') { regionLeafCount.set(regionId, 1); return 1; }
    let sum = 0;
    for (const cid of info.childIds) sum += leafCount(cid, byId);
    regionLeafCount.set(regionId, sum);
    return sum;
  }

  const edgeTypeToFlow = new Map<string, string>();
  for (const [name, preset] of Object.entries(FLOWS)) {
    for (const t of preset.types) edgeTypeToFlow.set(t, name);
  }

  function getVisibleConnected(nodeIdx: number): Set<number> {
    const enabled = useViewStore.getState().enabledFlows;
    const connected = new Set<number>();
    for (const edge of edges) {
      const flowName = edgeTypeToFlow.get(edge.type);
      if (!flowName || !enabled.has(flowName)) continue;
      if (edge.source === nodeIdx) connected.add(edge.target);
      if (edge.target === nodeIdx) connected.add(edge.source);
    }
    return connected;
  }

  function getSelectedIdx(): number {
    const sel = useViewStore.getState().selection;
    const it = sel.values().next();
    return it.done ? -1 : (it.value as number);
  }

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  function updateMouse(e: MouseEvent) {
    const rect = container.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function clearSelection() {
    const routeNodes = routeLayer.activeNodeIndices;
    const pins = useViewStore.getState().pins;
    const baseElev = (layer as unknown as { _baseElevation?: Float32Array })
      ._baseElevation;
    const baseOf = (i: number) => baseElev?.[i] ?? 0;
    for (let i = 0; i < nodes.length; i++) {
      const isPinned = pins.has(nodes[i].id);
      if (routeNodes.has(i)) {
        layer.animateTo(i, 'elevation', baseOf(i) + 1.5, 300);
        layer.animateTo(i, 'outlineWidth', 0.1, 200);
        layer.setOutlineColor(i, 0xffffff);
      } else if (isPinned) {
        layer.animateTo(i, 'elevation', baseOf(i) + 1.5, 300);
        layer.animateTo(i, 'outlineWidth', 0.3, 200);
        layer.setOutlineColor(i, 0xff0044);
        layer.animateTo(i, 'scale', 1.15, 200);
      } else {
        layer.animateTo(i, 'elevation', baseOf(i), 300);
        layer.animateTo(i, 'outlineWidth', 0, 200);
        layer.animateTo(i, 'scale', 1.0, 200);
      }
      layer.animateTo(i, 'opacity', 1.0, 200);
    }
    flowLayer.highlightEdges(null);
    edgeLabelsRef.current.length = 0;
    selectedConnectedRef.current.clear();
  }

  // Throttle the hull point-in-poly check — running it on every mouse
  // tick makes pan/hover noticeably laggy with 700+ regions. 60ms is a
  // good compromise: faster than human perception of stale tooltips,
  // ≥3× cheaper than per-tick. Edge raycast is cheap (per-mesh
  // intersection) so it stays per-tick.
  let lastHullCheck = 0;
  let lastHullTarget: HoverTarget = { kind: 'empty' };

  const onMouseMove = (e: MouseEvent) => {
    updateMouse(e);
    raycaster.setFromCamera(mouse, sm.camera);
    let newIdx = layer.raycast(raycaster);
    // Fallback: HexLayer geometry is rendered at ~92% of TILE_SIZE so
    // there's a small visual gap between adjacent tiles. The cursor
    // can land in that 8% rim and miss the per-instance raycast,
    // sending the user to the hull tooltip below — which feels
    // wrong because there's clearly a tile right there. Project the
    // ray onto the ground plane and look up by axial coord; this
    // gives node priority back over the full hex cell area.
    if (newIdx < 0 && raycaster.ray.intersectPlane(groundPlane, groundHit)) {
      const { q, r } = worldToAxial(groundHit.x, groundHit.z);
      const fallback = axialToNodeIdx.get(`${q},${r}`);
      if (fallback !== undefined) newIdx = fallback;
    }
    const selIdx = getSelectedIdx();

    // ── Node-hover state machine (outline gets toggled even while the
    //    other tooltip targets churn). Compares to previous hoveredIdx
    //    so the work below only runs on actual node-membership changes. ──
    if (newIdx !== hoveredIdx) {
      if (hoveredIdx >= 0 && hoveredIdx !== selIdx && !selectedConnectedRef.current.has(hoveredIdx)) {
        const prevNode = nodes[hoveredIdx];
        const pins = useViewStore.getState().pins;
        if (prevNode && pins.has(prevNode.id)) {
          layer.setOutlineColor(hoveredIdx, 0xff0044);
          layer.setProperty(hoveredIdx, 'outlineWidth', 0.3);
        } else {
          layer.setProperty(hoveredIdx, 'outlineWidth', 0);
        }
      }
      hoveredIdx = newIdx;
      if (hoveredIdx >= 0 && hoveredIdx !== selIdx && !selectedConnectedRef.current.has(hoveredIdx)) {
        layer.setOutlineColor(hoveredIdx, 0x00e5ff);
        layer.setProperty(hoveredIdx, 'outlineWidth', 0.1);
      }
    }

    // ── Hover incident-link highlight (sandbox D3). Only when nothing
    //    is click-selected — click selection / route activation own the
    //    flow highlight when present. ──
    if (selIdx < 0) {
      if (hoveredIdx >= 0) {
        flowLayer.highlightEdges(new Set([hoveredIdx]));
        hoverHighlightActive = true;
      } else if (hoverHighlightActive) {
        flowLayer.highlightEdges(null);
        hoverHighlightActive = false;
      }
    }

    // ── Tooltip dispatch. Priority chain: node > edge > nothing.
    //    Hull tooltip was deliberately removed — when the cursor lands
    //    on a phantom hex cell (one that morph-close added to make the
    //    hull contiguous but where no symbol was actually placed),
    //    a hull tooltip felt misleading: the user saw "files: 58"
    //    while pointing at empty space. Toponym + outline still
    //    convey region identity at a glance; tooltip stays silent
    //    unless there's a real tile or edge under the cursor.
    let target: HoverTarget = { kind: 'empty' };
    if (hoveredIdx >= 0) {
      target = { kind: 'node', nodeIdx: hoveredIdx };
    } else {
      const edgeHit = flowLayer.raycastEdge(raycaster);
      if (edgeHit) {
        target = { kind: 'edge', ...edgeHit };
      }
    }

    const content = routeTooltip(target, nodes);
    if (content) {
      const rect = container.getBoundingClientRect();
      setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, content, edges: [] });
    } else {
      setTooltip(null);
    }
  };

  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  const onClick = (e: MouseEvent) => {
    if (clickTimer) clearTimeout(clickTimer);
    const ex = e.clientX, ey = e.clientY;
    clickTimer = setTimeout(() => {
      clickTimer = null;
      const rect = container.getBoundingClientRect();
      mouse.x = ((ex - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ey - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, sm.camera);
      handleClick(ex - rect.left, ey - rect.top);
    }, 250);
  };

  const handleClick = (tooltipX: number, tooltipY: number) => {
    const clickIdx = layer.raycast(raycaster);
    const intent: FocusIntent = {
      kind: 'click',
      target: clickIdx >= 0 ? clickIdx : null,
    };
    const { selection: currentSelection, setSelection } = useViewStore.getState();
    const nextSelection = reduceSelection(currentSelection, intent);
    setSelection(nextSelection as Set<number>);

    if (nextSelection.size === 0) {
      clearSelection();
      // Same render-on-demand reason as below — clearSelection writes
      // 1.0 into the opacity tween targets, but without a pump those
      // tweens never tick back up to the target.
      sm.pumpRender(450);
      setTooltip(null);
      return;
    }

    const connected = getVisibleConnected(clickIdx);
    selectedConnectedRef.current = connected;

    const baseElev = (layer as unknown as { _baseElevation?: Float32Array })
      ._baseElevation;
    const baseOf = (i: number) => baseElev?.[i] ?? 0;

    for (let i = 0; i < nodes.length; i++) {
      if (i === clickIdx) {
        layer.animateTo(i, 'elevation', baseOf(i) + 2.0, 300);
        layer.animateTo(i, 'outlineWidth', 0.2, 200);
        layer.setOutlineColor(i, 0x00e5ff);
        layer.animateTo(i, 'opacity', 1.0, 200);
      } else if (connected.has(i)) {
        layer.animateTo(i, 'elevation', baseOf(i) + 1.0, 350);
        layer.animateTo(i, 'outlineWidth', 0.12, 250);
        layer.setOutlineColor(i, 0x00aacc);
        layer.animateTo(i, 'opacity', 1.0, 200);
      } else {
        const routeNodes = routeLayer.activeNodeIndices;
        const currentPins = useViewStore.getState().pins;
        const isPinned = currentPins.has(nodes[i].id);
        if (routeNodes.has(i)) {
          layer.animateTo(i, 'elevation', baseOf(i) + 1.5, 300);
          layer.animateTo(i, 'outlineWidth', 0.1, 200);
          layer.setOutlineColor(i, 0xffffff);
        } else if (isPinned) {
          layer.animateTo(i, 'elevation', baseOf(i) + 1.5, 300);
          layer.animateTo(i, 'outlineWidth', 0.3, 200);
          layer.setOutlineColor(i, 0xff0044);
        } else {
          layer.animateTo(i, 'elevation', baseOf(i), 300);
          layer.animateTo(i, 'outlineWidth', 0, 200);
        }
        layer.animateTo(i, 'opacity', isPinned ? 1.0 : 0.25, 200);
      }
    }

    const activeSet = new Set(connected);
    activeSet.add(clickIdx);
    // Pump renders for the duration of the per-tile fade animations
    // (longest above is 350ms). Without this the loop above queues
    // 28k tweens and `tick()` never advances them — non-connected
    // tiles freeze at whatever opacity the single post-click frame
    // happened to capture, and clearSelection later writes 1.0 into
    // the same frozen array but again never tick-advances back to it.
    sm.pumpRender(450);

    flowLayer.highlightEdges(activeSet);
    // Click took ownership of the edge highlight — release the hover
    // claim so a subsequent hover-leave won't clear what click set.
    hoverHighlightActive = false;

    const edgeMidpoints = flowLayer.getHighlightedEdgeLabels(activeSet);
    edgeLabelsRef.current.length = 0;
    for (const em of edgeMidpoints) {
      edgeLabelsRef.current.push({
        worldX: em.worldX, worldZ: em.worldZ, worldY: em.worldY, text: em.edgeType,
      });
    }

    const edgeInfo = flowLayer.getConnectedEdgeInfo(clickIdx);
    const edgeLabels = edgeInfo.map((ei) => {
      const otherIdx = ei.srcIdx === clickIdx ? ei.dstIdx : ei.srcIdx;
      const otherNode = nodes[otherIdx];
      const dir = ei.srcIdx === clickIdx ? '→' : '←';
      return `${ei.edgeType} ${dir} ${otherNode?.name ?? '?'}`;
    });
    const clickContent = routeTooltip({ kind: 'node', nodeIdx: clickIdx }, nodes);
    if (clickContent) {
      setTooltip({ x: tooltipX, y: tooltipY, content: clickContent, edges: edgeLabels });
    } else {
      setTooltip(null);
    }
  };

  const onDblClick = (e: MouseEvent) => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    updateMouse(e);
    raycaster.setFromCamera(mouse, sm.camera);
    const idx = layer.raycast(raycaster);
    if (idx < 0) return;

    const node = nodes[idx];
    const { pins, addPin, removePin } = useViewStore.getState();
    const baseElev = (layer as unknown as { _baseElevation?: Float32Array })
      ._baseElevation;
    const baseOfIdx = baseElev?.[idx] ?? 0;
    if (pins.has(node.id)) {
      removePin(node.id);
      layer.animateTo(idx, 'outlineWidth', 0, 200);
      layer.animateTo(idx, 'scale', 1.0, 200);
      layer.animateTo(idx, 'elevation', baseOfIdx, 300);
      setTooltip(null);
    } else {
      addPin(node.id, '#ff2222', node.name);
      layer.setOutlineColor(idx, 0xff0044);
      layer.animateTo(idx, 'outlineWidth', 0.3, 200);
      layer.animateTo(idx, 'scale', 1.15, 200);
      layer.animateTo(idx, 'elevation', baseOfIdx + 1.5, 300);
      const rect = container.getBoundingClientRect();
      const pinContent = routeTooltip({ kind: 'node', nodeIdx: idx }, nodes);
      if (pinContent) {
        setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, content: pinContent, edges: [] });
      } else {
        setTooltip(null);
      }
    }
    // Render-on-demand pump for the per-tile animations queued above.
    sm.pumpRender(450);
  };

  sm.renderer.domElement.addEventListener('mousemove', onMouseMove);
  sm.renderer.domElement.addEventListener('click', onClick);
  sm.renderer.domElement.addEventListener('dblclick', onDblClick);

  // ──────────────────────────────────────────────────────────────────
  // WSAD pan — strafe the camera+target in the camera's XZ plane.
  // Continuous-hold via a key-state set + rAF loop; speed scales with
  // current orbit distance so pan feels consistent at any zoom.
  // Skipped while typing in an input/textarea so the keys don't fight
  // form fields. Listener attached on `window` (not the canvas) so the
  // map responds even when keyboard focus is on the sidebar.
  // ──────────────────────────────────────────────────────────────────
  const pressed = new Set<string>();
  const tmpForward = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();
  const tmpDelta = new THREE.Vector3();
  let panRaf: number | null = null;
  function isTypingTarget(t: EventTarget | null): boolean {
    if (!t || !(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
  }
  function panLoop() {
    if (pressed.size === 0) { panRaf = null; return; }
    sm.camera.getWorldDirection(tmpForward);
    tmpForward.y = 0;
    if (tmpForward.lengthSq() < 1e-6) { panRaf = requestAnimationFrame(panLoop); return; }
    tmpForward.normalize();
    // Right vector via right-hand rule: right = forward × up (Y-up).
    // For forward=(fx,0,fz), up=(0,1,0): right = (-fz, 0, fx). The
    // previous (fz, 0, -fx) flipped X — pressing D moved left.
    tmpRight.set(-tmpForward.z, 0, tmpForward.x);
    const distance = sm.camera.position.distanceTo(sm.controls.target);
    const speed = Math.max(2, distance * 0.025); // world units per frame
    tmpDelta.set(0, 0, 0);
    if (pressed.has('w')) tmpDelta.addScaledVector(tmpForward, speed);
    if (pressed.has('s')) tmpDelta.addScaledVector(tmpForward, -speed);
    if (pressed.has('d')) tmpDelta.addScaledVector(tmpRight, speed);
    if (pressed.has('a')) tmpDelta.addScaledVector(tmpRight, -speed);
    if (tmpDelta.lengthSq() > 0) {
      sm.camera.position.add(tmpDelta);
      sm.controls.target.add(tmpDelta);
      sm.controls.update();
      sm.requestRender();
    }
    panRaf = requestAnimationFrame(panLoop);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();
    if (k !== 'w' && k !== 'a' && k !== 's' && k !== 'd') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    pressed.add(k);
    e.preventDefault();
    if (panRaf === null) panRaf = requestAnimationFrame(panLoop);
  }
  function onKeyUp(e: KeyboardEvent) {
    pressed.delete(e.key.toLowerCase());
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    sm.renderer.domElement.removeEventListener('mousemove', onMouseMove);
    sm.renderer.domElement.removeEventListener('click', onClick);
    sm.renderer.domElement.removeEventListener('dblclick', onDblClick);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    if (panRaf !== null) cancelAnimationFrame(panRaf);
    pressed.clear();
  };
}

// ---------------------------------------------------------------------------
// Autofit + SceneApi
// ---------------------------------------------------------------------------

/**
 * Reframe the camera so the entire tile set is visible. Called once on
 * scene build; the returned `{cx, cz, dist}` is reused by SceneApi.fitToScene.
 */
export function computeAutofit(nodes: GraphNode[]): { cx: number; cz: number; dist: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.z < minZ) minZ = n.z;
    if (n.z > maxZ) maxZ = n.z;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const extent = Math.max(maxX - minX, maxZ - minZ);
  const dist = Math.max(80, extent * 1.0);
  return { cx, cz, dist };
}

export interface SceneApiDeps {
  sm: SceneManager;
  hexLayer: HexLayer;
  flowLayer: FlowLayer;
  nodes: GraphNode[];
  cx: number; cz: number; dist: number;
  setShowCoords: (v: boolean) => void;
  /** Used by SceneApi.unpin to clear any pin-tooltip when the user
   *  removes a pin via the PinPanel (the dblclick path already does
   *  this; the panel-driven path needs the same hook to avoid leaving
   *  a floating tooltip after the pinned node disappears). */
  setTooltip: (t: {
    x: number;
    y: number;
    content: TooltipContent;
    edges: string[];
  } | null) => void;
  edgeLabelsRef: { current: EdgeLabelData[] };
}

/**
 * Build the imperative SceneApi that panels / MapController call. The
 * api closes over the passed-in layers; callers must invalidate the
 * returned object when layers are disposed.
 */
export function createSceneApi(deps: SceneApiDeps): SceneApi {
  const { sm, hexLayer: layer, flowLayer, nodes, cx, cz, dist, setShowCoords, setTooltip, edgeLabelsRef } = deps;
  return {
    setMode: (mode) => useViewStore.getState().setMode(mode),
    getMode: () => useViewStore.getState().mode,
    getView: () => sm.getView(),
    projectWorldToNdc: (wx, wy, wz) => {
      const v = new THREE.Vector3(wx, wy, wz).project(sm.camera);
      return { x: v.x, y: v.y, z: v.z };
    },
    getScene: () => sm.scene,
    flyTo: (x, z, ms) => sm.flyTo(x, z, ms),
    fitToScene: () => {
      sm.controls.target.set(cx, 0, cz);
      sm.camera.position.set(cx, dist, cz + dist);
    },
    setShowCoords: (v) => setShowCoords(v),
    setFlowVisible: (name, visible) => flowLayer.setFlowVisible(name, visible),
    recolorFlowsByNodes: (colorFn) => {
      if (colorFn === null) {
        flowLayer.recolorByNodes(null);
      } else {
        flowLayer.recolorByNodes((ni) => new THREE.Color(colorFn(ni)));
      }
    },
    loadEdgesByTypes: async (types) => {
      // Lazy edge fetch — call /api/edges, dedup against current store
      // edges, append new ones, and rebuild FlowLayer in place. Uses
      // the lightweight `setEdges` setter (NOT setGraphData) so the
      // Canvas main useEffect — which lives outside this closure —
      // doesn't see a fresh `edges` reference and tear down the entire
      // scene. The flow rebuild happens here directly.
      //
      // Filters out flow types we ALREADY have in the store before
      // hitting the network, so re-toggling a flow is a no-op (the
      // server takes 3s to lift edges; skipping that on a known flow
      // keeps the toggle snappy).
      const ds = useDataStore.getState();
      const knownTypes = new Set(ds.edges.map((e) => e.type));
      const missing = types.filter((t) => !knownTypes.has(t));
      let result: { edges: GraphEdge[] } = { edges: [] };
      if (missing.length > 0) {
        // Drive the Sidebar's LOADING section through dataStore.progress
        // so the user sees a bar instead of a silent 3-5s freeze while
        // /api/edges runs the bulk lift. `phase: 'streaming'` is what
        // Sidebar's render gate keys on — switched back to 'done' when
        // the fetch resolves (or fails).
        ds.setProgress({ phase: 'streaming', edgesLoaded: 0, edgesTotal: 0 });
        try {
          result = await loadEdges(ds.nodes, {
            types: missing,
            onProgress: (loaded, total) => {
              ds.setProgress({ edgesLoaded: loaded, edgesTotal: total });
            },
          });
        } finally {
          ds.setProgress({ phase: 'done' });
        }
      }
      const existing = new Set(
        ds.edges.map((e) => `${e.source}|${e.target}|${e.type}`),
      );
      const merged = ds.edges.slice();
      let added = 0;
      for (const e of result.edges) {
        const k = `${e.source}|${e.target}|${e.type}`;
        if (existing.has(k)) continue;
        existing.add(k);
        merged.push(e);
        added++;
      }
      if (added > 0) {
        ds.setEdges(merged);
        const MAX_FLOW_EDGES = 20000;
        let toRender = merged;
        if (merged.length > MAX_FLOW_EDGES) {
          const step = Math.ceil(merged.length / MAX_FLOW_EDGES);
          toRender = merged.filter((_, i) => i % step === 0);
        }
        flowLayer.build(nodes, toRender);
        flowLayer.setElevationSource(layer.elevationArray);
        sm.requestRender();
      }
      return { added, total: merged.length };
    },
    applyLens: (lensName) => useViewStore.getState().setLens(lensName),
    addRoute: (id, nodeIndices, color, label) => {
      useRouteStore.getState().addRoute({
        id, label,
        color: `#${color.toString(16).padStart(6, '0')}`,
        nodeIndices,
      });
    },
    removeRoute: (id) => useRouteStore.getState().removeRoute(id),
    setRouteVisible: (id, visible) => {
      const r = useRouteStore.getState().routes.find((r) => r.id === id);
      if (!r || r.visible === visible) return;
      useRouteStore.getState().toggleRoute(id);
    },
    pin: (nodeIdx, color, label) => {
      const node = nodes[nodeIdx];
      if (!node) return;
      const hex = `#${color.toString(16).padStart(6, '0')}`;
      useViewStore.getState().addPin(node.id, hex, label);
      layer.setOutlineColor(nodeIdx, color);
      layer.setProperty(nodeIdx, 'outlineWidth', 0.3);
      layer.setProperty(nodeIdx, 'scale', 1.15);
      const base = (layer as unknown as { _baseElevation?: Float32Array })
        ._baseElevation?.[nodeIdx] ?? 0;
      layer.setProperty(nodeIdx, 'elevation', base + 1.5);
      layer.setPins(buildPinIndexMap(nodes, useViewStore.getState().pins));
    },
    unpin: (nodeIdx) => {
      const node = nodes[nodeIdx];
      if (!node) return;
      useViewStore.getState().removePin(node.id);
      layer.setProperty(nodeIdx, 'outlineWidth', 0);
      layer.setProperty(nodeIdx, 'scale', 1.0);
      const base = (layer as unknown as { _baseElevation?: Float32Array })
        ._baseElevation?.[nodeIdx] ?? 0;
      layer.setProperty(nodeIdx, 'elevation', base);
      layer.setPins(buildPinIndexMap(nodes, useViewStore.getState().pins));
      // Drop any tooltip + edge labels — the pin that anchored them is
      // gone (PinPanel-driven unpin missed this; the dblclick handler
      // already does it). Without this the tooltip floats over an
      // empty tile and the edge labels stay glued to the now-hidden
      // highlight.
      setTooltip(null);
      edgeLabelsRef.current.length = 0;
      flowLayer.highlightEdges(null);
      sm.requestRender();
    },
    enterDiff: (removed, changed) => {
      const changedMap = new Map<number, NodeChange[]>();
      for (const [idx, val] of changed) changedMap.set(idx, val as NodeChange[]);
      useDiffStore.getState().enterDiff([], [...removed], changedMap);
    },
    exitDiff: () => useDiffStore.getState().exitDiff(),
    setTargetPositions: (x, z) => layer.setTargetPositions(x, z),
    dispose: () => sm.dispose(),
  };
}

// Re-export for tests that used to reach into Canvas's unexported helpers.
export { useDataStore };
