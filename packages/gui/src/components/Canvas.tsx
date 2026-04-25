import { useEffect, useRef, useState } from 'react';
import { SceneManager } from '../three/SceneManager';
import type { FlowLayer } from '../three/FlowLayer';
import type { RegionLayer } from '../three/RegionLayer';
import type { RouteLayer } from '../three/RouteLayer';
import { RouteLabels } from './RouteLabels';
import { EdgeLabels, type EdgeLabelData } from './EdgeLabels';
import { CoordGrid } from './CoordGrid';
import { useDataStore } from '../store/dataStore';
import { useMapStore } from '../store/mapStore';
import { useViewStore } from '../store/viewStore';
import { lodFromView } from '../controller/lod';
import { mapController } from '../controller/MapController';
import { setLiveLayoutSink } from '../store/loadLiveLayout';
import type { TooltipContent } from '../controller/tooltip';
import { SceneApiProvider } from '../controller/SceneApiContext';
import type { SceneApi } from '../controller/SceneApi';
import { ToponymsLayer } from '../ToponymsLayer';
import {
  buildHexLayerWithSubscriptions,
  buildRegionLayer,
  buildHullLayer,
  buildFlowLayer,
  setupRoutes,
  setupInteraction,
  computeAutofit,
  createSceneApi,
} from '../hooks/canvasBuild';

/**
 * Canvas — the root Three.js surface + all imperative layer wiring.
 *
 * The concrete construction/subscription work is factored into
 * `hooks/canvasBuild.ts` (C-Canvas-refactor-v2). Canvas now owns:
 *   1. SceneManager lifecycle (one useEffect, mount/unmount).
 *   2. Scene build lifecycle (one useEffect, reruns on data change) —
 *      delegates every step to a named helper from `canvasBuild`.
 *   3. React state for the SceneApi + tooltip + showCoords toggle.
 *
 * No effect body exceeds ~80 lines; each helper has a single purpose.
 */
export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneManager | null>(null);

  const [showCoords, setShowCoords] = useState(false);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: TooltipContent; edges: string[] } | null>(null);

  // Mutable label store — Canvas mutates, EdgeLabels reads each RAF tick.
  // useRef keeps a stable array reference across renders.
  const edgeLabelsRef = useRef<EdgeLabelData[]>([]);

  const [sm, setSm] = useState<SceneManager | null>(null);
  const [routeLayerState, setRouteLayerState] = useState<RouteLayer | null>(null);
  const [sceneApi, setSceneApi] = useState<SceneApi | null>(null);

  const nodes = useDataStore((s) => s.nodes);
  const edges = useDataStore((s) => s.edges);
  const regions = useDataStore((s) => s.regions);
  const loaded = useDataStore((s) => s.loaded);
  const setCameraDistance = useMapStore((s) => s.setCameraDistance);
  const setLodLevel = useMapStore((s) => s.setLodLevel);
  const setZoom = useMapStore((s) => s.setZoom);

  // Initialize Three.js scene once (mount). Handles mode-change
  // subscription so OrbitControls' `change` listener stays attached
  // when SceneManager rebuilds controls on camera-kind swap.
  useEffect(() => {
    if (!containerRef.current) return;
    const scene = new SceneManager(containerRef.current);
    sceneRef.current = scene;
    setSm(scene);
    scene.setMode(useViewStore.getState().mode);

    const onControlsChange = () => {
      const view = scene.getView();
      setLodLevel(lodFromView(view));
      if (view.kind === 'perspective') {
        setCameraDistance(view.distance);
      } else {
        setCameraDistance(0);
        setZoom(view.zoom);
      }
    };
    scene.controls.addEventListener('change', onControlsChange);

    const unsubMode = useViewStore.subscribe((state, prev) => {
      if (state.mode === prev.mode) return;
      scene.setMode(state.mode);
      scene.controls.addEventListener('change', onControlsChange);
      onControlsChange();
    });

    return () => {
      unsubMode();
      scene.dispose();
      setSm(null);
    };
  }, [setCameraDistance, setLodLevel, setZoom]);

  // Build scene when data loads. This effect is intentionally short —
  // every cohesive step is a named helper from canvasBuild.ts. When data
  // changes (React rerenders with fresh nodes/edges/regions) React tears
  // down the previous build via the cleanup closure below.
  useEffect(() => {
    const sm = sceneRef.current;
    const container = containerRef.current;
    if (!sm || !container || !loaded || nodes.length === 0) return;

    const abort = new AbortController();
    // Shared state between routes + interaction — refs so the route
    // subscription and the click handler observe each other's writes.
    const selectedConnectedRef = { current: new Set<number>() };
    let flowLayerForLens: FlowLayer | null = null;

    const { layer: hexLayer, unsubscribe: unsubBuildSubs } =
      buildHexLayerWithSubscriptions(sm, nodes, () => flowLayerForLens);
    const regionLayer: RegionLayer = buildRegionLayer(sm, nodes, regions);
    const { layer: hullLayer, unsubscribe: unsubHull } =
      buildHullLayer(sm, nodes, regions, abort.signal);
    const flowLayer: FlowLayer = buildFlowLayer(sm, nodes, edges, hexLayer);
    flowLayerForLens = flowLayer;

    // Attach layers + sync mode to the ones we just built.
    sm.attachLayers({ hexLayer, flowLayer, hullLayer });
    sm.setMode(useViewStore.getState().mode);

    const { routeLayer, unsubscribe: unsubRoutes } = setupRoutes(
      sm, hexLayer, flowLayer, nodes, edges, selectedConnectedRef,
      () => {
        const sel = useViewStore.getState().selection;
        const it = sel.values().next();
        return it.done ? -1 : (it.value as number);
      },
    );
    setRouteLayerState(routeLayer);

    const detachInteraction = setupInteraction({
      sm, container, hexLayer, flowLayer, routeLayer, hullLayer,
      nodes, edges, edgeLabelsRef, setTooltip, selectedConnectedRef,
    });

    // Debug — DEV mode OR opt-in via `?debug=1` query param (for Playwright
    // verification against production bundle). Production hosts that don't
    // set the flag stay clean. (P2.1; extended for DAI-22 Chunk-10b.)
    const debugOptIn =
      typeof window !== 'undefined' &&
      typeof window.location !== 'undefined' &&
      /[?&]debug=1\b/.test(window.location.search);
    if (import.meta.env?.DEV || debugOptIn) {
      (window as unknown as Record<string, unknown>).debugScene = sm.scene;
      (window as unknown as Record<string, unknown>).debugHexLayer = hexLayer;
      (window as unknown as Record<string, unknown>).debugHullLayer = hullLayer;
    }

    // Autofit + SceneApi
    const { cx, cz, dist } = computeAutofit(nodes);
    sm.controls.target.set(cx, 0, cz);
    sm.camera.position.set(cx, dist, cz + dist);

    const api = createSceneApi({
      sm, hexLayer, flowLayer, nodes, cx, cz, dist, setShowCoords,
    });
    setSceneApi(api);
    mapController.setScene(api);
    setLiveLayoutSink(api);

    const onResize = () => {
      hullLayer.setResolution(window.innerWidth, window.innerHeight);
    };
    onResize();
    window.addEventListener('resize', onResize);

    return () => {
      // Abort first so any in-flight HullLayer.setRegions exits before
      // we dispose the layer (E14 dual-abort).
      abort.abort();
      detachInteraction();
      window.removeEventListener('resize', onResize);
      unsubRoutes();
      unsubBuildSubs();
      unsubHull();
      hullLayer.dispose();
      flowLayer.dispose();
      regionLayer.dispose();
      setLiveLayoutSink(null);
      mapController.setScene(null);
      setSceneApi(null);
    };
  }, [loaded, nodes, edges, regions]);

  return (
    <SceneApiProvider api={sceneApi}>
      <div ref={containerRef} className="canvas-container">
        <CoordGrid sceneManager={sm} visible={showCoords} />
        <RouteLabels sceneManager={sm} routeLayer={routeLayerState} />
        <EdgeLabels sceneManager={sm} labels={edgeLabelsRef.current} />
        <ToponymsLayer api={sceneApi} />
        {tooltip && (
          <div className="node-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}>
            {tooltip.content.subtitle && <div className="tt-type">{tooltip.content.subtitle}</div>}
            <div className="tt-name">{tooltip.content.title}</div>
            {tooltip.content.rows.map((r, i) => (
              <div key={i} className="tt-region">
                <span className="tt-label">{r.label}:</span> {r.value}
              </div>
            ))}
            {tooltip.edges.length > 0 && (
              <div className="tt-edges">
                {tooltip.edges.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </SceneApiProvider>
  );
}
