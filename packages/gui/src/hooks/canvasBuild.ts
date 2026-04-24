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
import type { HexCoord } from '../geom/hex';
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
import { useLayoutStore } from '../store/layoutStore';
import { deriveLodVisibility, normalizeZoom } from '../lod/render';
import { LENSES } from '../config/lenses';
import { FLOWS } from '../config/flows';
import { reduceSelection, type FocusIntent } from '../controller/focus';
import { routeTooltip, type TooltipContent } from '../controller/tooltip';
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

  // DAI-22 Chunk-8b — gate the instanced symbol mesh on the per-frame
  // zoom level. Hidden below `symbolZoomThreshold` (default 0.9) so
  // distant/package-level views skip the ~35k-instance draw entirely.
  // Pin rings ride along so they stay coherent with tile visibility.
  let lastVisible = true;
  sm.onRender(() => {
    const zoom01 = normalizeZoom(sm.getView());
    const wantVisible = useLayoutStore.getState().hullCache.size === 0
      // No precomputed hulls — we haven't been through the new layout
      // pipeline; keep legacy behaviour and always show symbols.
      ? true
      : deriveLodVisibility({
          regionTree: useLayoutStore.getState().regionTree,
          hullCache: useLayoutStore.getState().hullCache,
          zoom01,
        }).symbolsVisible;
    if (wantVisible === lastVisible) return;
    lastVisible = wantVisible;
    layer.mesh.visible = wantVisible;
    // pinRings mode-driven visibility stays with HexLayer itself —
    // not overridden here so 2D pin rings keep their own gating.
  });

  return { layer, unsubscribe: () => { unsubLens(); unsubDiff(); } };
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

  // Last-applied zoom bucket (quantised) so we skip rebuilds when the
  // camera barely moved. 3 digits of precision ≈ 0.1% zoom steps —
  // tight enough that boundary crossings still fire, loose enough to
  // avoid rebuilding at 60Hz during a continuous pan.
  let lastBucket = -1;
  let lastCacheRef: unknown = null;

  const applyFrame = () => {
    const { regionTree, hullCache } = useLayoutStore.getState();
    const zoom01 = normalizeZoom(sm.getView());
    const bucket = Math.round(zoom01 * 1000);
    // Cache identity change (new stream load) forces a rebuild even
    // if the zoom bucket is the same.
    if (bucket === lastBucket && hullCache === lastCacheRef) return;
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
    }));
    hullLayer.setRegionHulls(entries);
  };

  // Initial paint — covers the case where the hull cache is already
  // populated at the time Canvas builds the scene (common: stream load
  // finishes before data flows through to React).
  applyFrame();

  // Cache-change driver — stream-load hydration fires this.
  const unsubLayout = useLayoutStore.subscribe((state, prev) => {
    if (state.hullCache !== prev.hullCache) applyFrame();
  });

  // Per-frame driver — cheap: applyFrame short-circuits when the
  // quantised zoom bucket and cache identity are unchanged.
  sm.onRender(applyFrame);

  return { layer: hullLayer, unsubscribe: unsubLayout };
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
  const MAX_FLOW_EDGES = 2000;
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
    routeLayer.update(useRouteStore.getState().routes, nodes, edges);
    const newRouteNodes = routeLayer.activeNodeIndices;
    const selIdx = getSelectedIdx();

    for (const i of prevRouteNodes) {
      if (!newRouteNodes.has(i) && i !== selIdx && !selectedConnectedRef.current.has(i)) {
        hexLayer.animateTo(i, 'elevation', 0, 300);
        hexLayer.animateTo(i, 'outlineWidth', 0, 200);
      }
    }
    for (const i of newRouteNodes) {
      if (i !== selIdx && !selectedConnectedRef.current.has(i)) {
        hexLayer.animateTo(i, 'elevation', 1.5, 300);
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
    // reference edges only to keep the closure capture live; the flow
    // layer reads edges through its own stored reference already.
    void edges;
  }

  applyRoutes();
  sm.onRender((dt) => routeLayer.tick(dt));
  const unsubRoutes = useRouteStore.subscribe(applyRoutes);
  return { routeLayer, unsubscribe: unsubRoutes };
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
    sm, container, hexLayer: layer, flowLayer, routeLayer,
    nodes, edges, edgeLabelsRef, setTooltip, selectedConnectedRef,
  } = deps;

  let hoveredIdx = -1;

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
    for (let i = 0; i < nodes.length; i++) {
      const isPinned = pins.has(nodes[i].id);
      if (routeNodes.has(i)) {
        layer.animateTo(i, 'elevation', 1.5, 300);
        layer.animateTo(i, 'outlineWidth', 0.1, 200);
        layer.setOutlineColor(i, 0xffffff);
      } else if (isPinned) {
        layer.animateTo(i, 'elevation', 1.5, 300);
        layer.animateTo(i, 'outlineWidth', 0.3, 200);
        layer.setOutlineColor(i, 0xff0044);
        layer.animateTo(i, 'scale', 1.15, 200);
      } else {
        layer.animateTo(i, 'elevation', 0, 300);
        layer.animateTo(i, 'outlineWidth', 0, 200);
        layer.animateTo(i, 'scale', 1.0, 200);
      }
      layer.animateTo(i, 'opacity', 1.0, 200);
    }
    flowLayer.highlightEdges(null);
    edgeLabelsRef.current.length = 0;
    selectedConnectedRef.current.clear();
  }

  const onMouseMove = (e: MouseEvent) => {
    updateMouse(e);
    raycaster.setFromCamera(mouse, sm.camera);
    const newIdx = layer.raycast(raycaster);
    if (newIdx === hoveredIdx) return;

    const selIdx = getSelectedIdx();
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

    if (hoveredIdx >= 0) {
      if (hoveredIdx !== selIdx && !selectedConnectedRef.current.has(hoveredIdx)) {
        layer.setOutlineColor(hoveredIdx, 0x00e5ff);
        layer.setProperty(hoveredIdx, 'outlineWidth', 0.1);
      }
      const rect = container.getBoundingClientRect();
      const content = routeTooltip({ kind: 'node', nodeIdx: hoveredIdx }, nodes);
      if (content) {
        setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, content, edges: [] });
      } else {
        setTooltip(null);
      }
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
      setTooltip(null);
      return;
    }

    const connected = getVisibleConnected(clickIdx);
    selectedConnectedRef.current = connected;

    for (let i = 0; i < nodes.length; i++) {
      if (i === clickIdx) {
        layer.animateTo(i, 'elevation', 2.0, 300);
        layer.animateTo(i, 'outlineWidth', 0.2, 200);
        layer.setOutlineColor(i, 0x00e5ff);
        layer.animateTo(i, 'opacity', 1.0, 200);
      } else if (connected.has(i)) {
        layer.animateTo(i, 'elevation', 1.0, 350);
        layer.animateTo(i, 'outlineWidth', 0.12, 250);
        layer.setOutlineColor(i, 0x00aacc);
        layer.animateTo(i, 'opacity', 1.0, 200);
      } else {
        const routeNodes = routeLayer.activeNodeIndices;
        const currentPins = useViewStore.getState().pins;
        const isPinned = currentPins.has(nodes[i].id);
        if (routeNodes.has(i)) {
          layer.animateTo(i, 'elevation', 1.5, 300);
          layer.animateTo(i, 'outlineWidth', 0.1, 200);
          layer.setOutlineColor(i, 0xffffff);
        } else if (isPinned) {
          layer.animateTo(i, 'elevation', 1.5, 300);
          layer.animateTo(i, 'outlineWidth', 0.3, 200);
          layer.setOutlineColor(i, 0xff0044);
        } else {
          layer.animateTo(i, 'elevation', 0, 300);
          layer.animateTo(i, 'outlineWidth', 0, 200);
        }
        layer.animateTo(i, 'opacity', isPinned ? 1.0 : 0.25, 200);
      }
    }

    const activeSet = new Set(connected);
    activeSet.add(clickIdx);
    flowLayer.highlightEdges(activeSet);

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
    if (pins.has(node.id)) {
      removePin(node.id);
      layer.animateTo(idx, 'outlineWidth', 0, 200);
      layer.animateTo(idx, 'scale', 1.0, 200);
      layer.animateTo(idx, 'elevation', 0, 300);
      setTooltip(null);
    } else {
      addPin(node.id, '#ff2222', node.name);
      layer.setOutlineColor(idx, 0xff0044);
      layer.animateTo(idx, 'outlineWidth', 0.3, 200);
      layer.animateTo(idx, 'scale', 1.15, 200);
      layer.animateTo(idx, 'elevation', 1.5, 300);
      const rect = container.getBoundingClientRect();
      const pinContent = routeTooltip({ kind: 'node', nodeIdx: idx }, nodes);
      if (pinContent) {
        setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, content: pinContent, edges: [] });
      } else {
        setTooltip(null);
      }
    }
  };

  sm.renderer.domElement.addEventListener('mousemove', onMouseMove);
  sm.renderer.domElement.addEventListener('click', onClick);
  sm.renderer.domElement.addEventListener('dblclick', onDblClick);

  return () => {
    sm.renderer.domElement.removeEventListener('mousemove', onMouseMove);
    sm.renderer.domElement.removeEventListener('click', onClick);
    sm.renderer.domElement.removeEventListener('dblclick', onDblClick);
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
}

/**
 * Build the imperative SceneApi that panels / MapController call. The
 * api closes over the passed-in layers; callers must invalidate the
 * returned object when layers are disposed.
 */
export function createSceneApi(deps: SceneApiDeps): SceneApi {
  const { sm, hexLayer: layer, flowLayer, nodes, cx, cz, dist, setShowCoords } = deps;
  return {
    setMode: (mode) => useViewStore.getState().setMode(mode),
    getMode: () => useViewStore.getState().mode,
    getView: () => sm.getView(),
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
      layer.setProperty(nodeIdx, 'elevation', 1.5);
      layer.setPins(buildPinIndexMap(nodes, useViewStore.getState().pins));
    },
    unpin: (nodeIdx) => {
      const node = nodes[nodeIdx];
      if (!node) return;
      useViewStore.getState().removePin(node.id);
      layer.setProperty(nodeIdx, 'outlineWidth', 0);
      layer.setProperty(nodeIdx, 'scale', 1.0);
      layer.setProperty(nodeIdx, 'elevation', 0);
      layer.setPins(buildPinIndexMap(nodes, useViewStore.getState().pins));
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
