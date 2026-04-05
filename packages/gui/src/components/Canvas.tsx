import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { SceneManager } from '../three/SceneManager';
import { HexLayer } from '../three/HexLayer';
import { RegionLayer } from '../three/RegionLayer';
import { FlowLayer } from '../three/FlowLayer';
import { RouteLayer } from '../three/RouteLayer';
import { RouteLabels } from './RouteLabels';
import { Labels } from './Labels';
import { CoordGrid } from './CoordGrid';
import { useDataStore } from '../store/dataStore';
import { useMapStore } from '../store/mapStore';
import { useViewStore } from '../store/viewStore';
import { useRouteStore } from '../store/routeStore';
import { FLOWS } from '../config/flows';
import { LENSES } from '../config/lenses';
import { useDiffStore } from '../store/diffStore';
import { mapController } from '../api/MapController';

const TILE_SIZE = 3.0;

// Exported so Sidebar can control flows
export let flowLayerRef: FlowLayer | null = null;
// Exported so Sidebar can toggle coord grid
export let setShowCoordsRef: ((v: boolean) => void) | null = null;

export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneManager | null>(null);
  const hexLayerRef = useRef<HexLayer | null>(null);
  const [showCoords, setShowCoords] = useState(false);
  setShowCoordsRef = setShowCoords;
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; type: string; region: string; edges: string[] } | null>(null);
  const regionLayerRef = useRef<RegionLayer | null>(null);
  const flowLayerLocalRef = useRef<FlowLayer | null>(null);
  const routeLayerRef = useRef<RouteLayer | null>(null);
  const [sm, setSm] = useState<SceneManager | null>(null);
  const [routeLayerState, setRouteLayerState] = useState<RouteLayer | null>(null);

  const nodes = useDataStore((s) => s.nodes);
  const edges = useDataStore((s) => s.edges);
  const regions = useDataStore((s) => s.regions);
  const loaded = useDataStore((s) => s.loaded);
  const setCameraDistance = useMapStore((s) => s.setCameraDistance);

  // Initialize Three.js scene once
  useEffect(() => {
    if (!containerRef.current) return;
    const scene = new SceneManager(containerRef.current);
    sceneRef.current = scene;
    setSm(scene);

    scene.controls.addEventListener('change', () => {
      setCameraDistance(scene.getCameraDistance());
    });

    return () => { scene.dispose(); setSm(null); };
  }, [setCameraDistance]);

  // Build scene when data loads
  useEffect(() => {
    const sm = sceneRef.current;
    if (!sm || !loaded || nodes.length === 0) return;

    // Expose flyTo to MapController
    mapController.setScene({ flyTo: (x, z, d) => sm.flyTo(x, z, d) });

    // --- Hex tiles ---
    if (hexLayerRef.current) sm.scene.remove(hexLayerRef.current.mesh);
    const layer = new HexLayer(nodes.length, TILE_SIZE * 0.92, sm.scene);
    for (let i = 0; i < nodes.length; i++) {
      layer.setTile(i, nodes[i].x, nodes[i].z, 0x000000);
    }

    // Apply lens coloring
    function applyLens(lensName: string) {
      const lens = LENSES[lensName] ?? LENSES.region;
      for (let i = 0; i < nodes.length; i++) {
        const color = lens.colorFn(nodes[i], nodes);
        layer.animateColor(i, 'color', color, 400);
      }
    }
    // Initial coloring (immediate, no animation)
    const initialLens = LENSES[useViewStore.getState().lens] ?? LENSES.region;
    for (let i = 0; i < nodes.length; i++) {
      const color = initialLens.colorFn(nodes[i], nodes);
      layer.setTile(i, nodes[i].x, nodes[i].z, color);
    }
    layer.finalize();

    // Subscribe to lens changes (also recolors edges — uses flowLayerLocalRef)
    const unsubLens = useViewStore.subscribe((state, prev) => {
      if (state.lens !== prev.lens) {
        applyLens(state.lens);
        // Recolor edges: heatmap lenses recolor by node metrics, region/type reset
        const lens = LENSES[state.lens];
        if (lens?.legend === 'gradient') {
          flowLayerLocalRef.current?.recolorByNodes((ni) => lens.colorFn(nodes[ni], nodes));
        } else {
          flowLayerLocalRef.current?.recolorByNodes(null); // reset to preset colors
        }
      }
    });

    // Subscribe to diff mode
    const unsubDiff = useDiffStore.subscribe((state, prev) => {
      if (state.active === prev.active && state.added === prev.added) return;

      if (state.active) {
        // Enter diff mode — nodes
        const diffActive = new Set<number>();
        for (let i = 0; i < nodes.length; i++) {
          if (state.removed.has(i)) {
            // Removed: elevated ghost with red outline
            layer.animateTo(i, 'opacity', 0.25, 500);
            layer.animateTo(i, 'elevation', 1.2, 500);
            layer.animateTo(i, 'outlineWidth', 0.2, 300);
            layer.setOutlineColor(i, 0xff4466);
            layer.animateColor(i, 'color', 0xff4466, 500);
            diffActive.add(i);
          } else if (state.added.has(i)) {
            // Added: bright green, elevated
            layer.animateTo(i, 'elevation', 1.5, 500);
            layer.animateTo(i, 'outlineWidth', 0.2, 300);
            layer.setOutlineColor(i, 0x22cc66);
            layer.animateColor(i, 'color', 0x22cc66, 500);
            diffActive.add(i);
          } else if (state.changed.has(i)) {
            // Changed: yellow outline, elevated
            layer.animateTo(i, 'outlineWidth', 0.18, 300);
            layer.setOutlineColor(i, 0xffaa00);
            layer.animateTo(i, 'elevation', 1.0, 400);
            layer.animateColor(i, 'color', 0xffaa00, 500);
            diffActive.add(i);
          } else {
            // Unchanged: dim
            layer.animateTo(i, 'opacity', 0.3, 400);
          }
        }

        // Diff edges: highlight edges touching diff nodes, dim the rest
        flowLayerLocalRef.current?.highlightEdges(diffActive);
      } else {
        // Exit diff mode — restore everything
        const lens = LENSES[useViewStore.getState().lens] ?? LENSES.region;
        for (let i = 0; i < nodes.length; i++) {
          layer.animateTo(i, 'opacity', 1.0, 400);
          layer.animateTo(i, 'elevation', 0, 400);
          layer.animateTo(i, 'outlineWidth', 0, 300);
          layer.animateColor(i, 'color', lens.colorFn(nodes[i], nodes), 500);
        }
        flowLayerLocalRef.current?.highlightEdges(null);
      }
    });

    sm.onRender((dt) => layer.tick(dt));
    hexLayerRef.current = layer;

    // --- Region borders ---
    if (regionLayerRef.current) regionLayerRef.current.dispose();
    const regionLayer = new RegionLayer(sm.scene);
    regionLayer.build(nodes, regions);
    regionLayerRef.current = regionLayer;

    // --- Flow edges ---
    if (flowLayerLocalRef.current) flowLayerLocalRef.current.dispose();
    const flowLayer = new FlowLayer(sm.scene);
    flowLayer.build(nodes, edges);
    // Share the SAME elevation array — FlowLayer reads HexLayer's values each tick
    flowLayer.setElevationSource(layer.elevationArray);
    sm.onRender(() => flowLayer.tick());
    flowLayerLocalRef.current = flowLayer;
    flowLayerRef = flowLayer; // expose to sidebar

    // --- Shared interaction state (declared early for applyRoutes access) ---
    let hoveredIdx = -1;
    let selectedIdx = -1;
    let selectedConnected = new Set<number>();

    // --- Routes ---
    if (routeLayerRef.current) routeLayerRef.current.dispose();
    const routeLayer = new RouteLayer(sm.scene);
    routeLayerRef.current = routeLayer;
    setRouteLayerState(routeLayer);

    // Elevate route nodes + rebuild on route changes
    let prevRouteNodes = new Set<number>();
    function applyRoutes() {
      routeLayer.update(useRouteStore.getState().routes, nodes, edges);
      const newRouteNodes = routeLayer.activeNodeIndices;

      // Lower nodes that were in routes but aren't anymore
      for (const i of prevRouteNodes) {
        if (!newRouteNodes.has(i) && i !== selectedIdx && !selectedConnected.has(i)) {
          layer.animateTo(i, 'elevation', 0, 300);
          layer.animateTo(i, 'outlineWidth', 0, 200);
        }
      }

      // Elevate nodes in visible routes
      for (const i of newRouteNodes) {
        if (i !== selectedIdx && !selectedConnected.has(i)) {
          layer.animateTo(i, 'elevation', 1.5, 300);
          layer.animateTo(i, 'outlineWidth', 0.1, 200);
          layer.setOutlineColor(i, 0xffffff);
        }
      }

      prevRouteNodes = new Set(newRouteNodes);

      // Highlight edges between route nodes (both endpoints in route)
      if (newRouteNodes.size > 0) {
        flowLayer.highlightEdges(newRouteNodes, 'both');
      } else {
        flowLayer.highlightEdges(null);
      }
    }
    applyRoutes();
    sm.onRender((dt) => routeLayer.tick(dt));
    const unsubRoutes = useRouteStore.subscribe(applyRoutes);

    // --- Interaction: hover = light outline, click = elevate + dim ---
    // Build per-flow adjacency: edge type → flow name lookup
    const edgeTypeToFlow = new Map<string, string>();
    for (const [name, preset] of Object.entries(FLOWS)) {
      for (const t of preset.types) edgeTypeToFlow.set(t, name);
    }

    // Get connected nodes filtered by currently enabled flows
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

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function updateMouse(e: MouseEvent) {
      const rect = containerRef.current!.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function clearSelection() {
      const routeNodes = routeLayer.activeNodeIndices;
      for (let i = 0; i < nodes.length; i++) {
        // Preserve route elevation
        if (routeNodes.has(i)) {
          layer.animateTo(i, 'elevation', 1.5, 300);
          layer.animateTo(i, 'outlineWidth', 0.1, 200);
          layer.setOutlineColor(i, 0xffffff);
        } else {
          layer.animateTo(i, 'elevation', 0, 300);
          layer.animateTo(i, 'outlineWidth', 0, 200);
        }
        layer.animateTo(i, 'opacity', 1.0, 200);
      }
      flowLayer.highlightEdges(null);
      selectedIdx = -1;
      selectedConnected.clear();
    }

    const onMouseMove = (e: MouseEvent) => {
      updateMouse(e);
      raycaster.setFromCamera(mouse, sm.camera);
      const newIdx = layer.raycast(raycaster);

      if (newIdx === hoveredIdx) return;

      // Remove hover outline from previous (unless it's selected)
      if (hoveredIdx >= 0 && hoveredIdx !== selectedIdx && !selectedConnected.has(hoveredIdx)) {
        layer.setProperty(hoveredIdx, 'outlineWidth', 0);
      }

      hoveredIdx = newIdx;

      // Light outline on hover (doesn't affect selection state)
      if (hoveredIdx >= 0 && hoveredIdx !== selectedIdx && !selectedConnected.has(hoveredIdx)) {
        layer.setOutlineColor(hoveredIdx, 0x00e5ff);
        layer.setProperty(hoveredIdx, 'outlineWidth', 0.1);
      }
    };

    const onClick = (e: MouseEvent) => {
      updateMouse(e);
      raycaster.setFromCamera(mouse, sm.camera);
      const clickIdx = layer.raycast(raycaster);

      // Click same node or empty → deselect
      if (clickIdx === selectedIdx || clickIdx < 0) {
        clearSelection();
        setTooltip(null);
        return;
      }

      // Clear previous selection, then set new (order matters for tween override)
      const prevSelected = selectedIdx;
      const prevConnected = new Set(selectedConnected);
      selectedIdx = clickIdx;
      const connected = getVisibleConnected(clickIdx);
      selectedConnected = connected;

      // Apply all at once: selected + connected = elevate, rest = dim
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
          // Preserve route elevation for route nodes
          const routeNodes = routeLayer.activeNodeIndices;
          if (routeNodes.has(i)) {
            layer.animateTo(i, 'elevation', 1.5, 300);
            layer.animateTo(i, 'outlineWidth', 0.1, 200);
            layer.setOutlineColor(i, 0xffffff);
          } else {
            layer.animateTo(i, 'elevation', 0, 300);
            layer.animateTo(i, 'outlineWidth', 0, 200);
          }
          layer.animateTo(i, 'opacity', 0.25, 200);
        }
      }

      // Dim edges not connected to selection
      const activeSet = new Set(connected);
      activeSet.add(clickIdx);
      flowLayer.highlightEdges(activeSet);

      // Show tooltip with node info + edge types
      const edgeInfo = flowLayer.getConnectedEdgeInfo(clickIdx);
      const edgeLabels = edgeInfo.map((ei) => {
        const otherIdx = ei.srcIdx === clickIdx ? ei.dstIdx : ei.srcIdx;
        const otherNode = nodes[otherIdx];
        const dir = ei.srcIdx === clickIdx ? '→' : '←';
        return `${ei.edgeType} ${dir} ${otherNode?.name ?? '?'}`;
      });
      const rect = containerRef.current!.getBoundingClientRect();
      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        name: nodes[clickIdx].name,
        type: nodes[clickIdx].type,
        region: nodes[clickIdx].region,
        edges: edgeLabels,
      });
    };

    sm.renderer.domElement.addEventListener('mousemove', onMouseMove);
    sm.renderer.domElement.addEventListener('click', onClick);

    // --- Camera ---
    let cx = 0, cz = 0;
    for (const n of nodes) { cx += n.x; cz += n.z; }
    cx /= nodes.length;
    cz /= nodes.length;
    sm.controls.target.set(cx, 0, cz);
    sm.camera.position.set(cx, 80, cz + 80);

    return () => {
      sm.renderer.domElement.removeEventListener('mousemove', onMouseMove);
      sm.renderer.domElement.removeEventListener('click', onClick);
      unsubRoutes();
      unsubLens();
      unsubDiff();
    };
  }, [loaded, nodes, edges, regions]);

  return (
    <div ref={containerRef} className="canvas-container">
      <Labels sceneManager={sm} />
      <CoordGrid sceneManager={sm} visible={showCoords} />
      <RouteLabels sceneManager={sm} routeLayer={routeLayerState} />
      {tooltip && (
        <div className="node-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}>
          <div className="tt-type">{tooltip.type}</div>
          <div className="tt-name">{tooltip.name}</div>
          <div className="tt-region">{tooltip.region}</div>
          {tooltip.edges.length > 0 && (
            <div className="tt-edges">
              {tooltip.edges.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
