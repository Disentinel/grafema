import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { SceneManager } from '../three/SceneManager';
import { HexLayer } from '../three/HexLayer';
import { RegionLayer } from '../three/RegionLayer';
import { FlowLayer } from '../three/FlowLayer';
import { Labels } from './Labels';
import { CoordGrid } from './CoordGrid';
import { useDataStore } from '../store/dataStore';
import { useMapStore } from '../store/mapStore';
import { useViewStore } from '../store/viewStore';
import { FLOWS } from '../config/flows';

/**
 * Region-based coloring: each region gets a stable hue,
 * node type shifts lightness within that hue.
 */
const TYPE_LIGHTNESS: Record<string, number> = {
  SERVICE:          55,
  MODULE:           42,
  CLASS:            45,
  INTERFACE:        43,
  FUNCTION:         35,
  METHOD:           33,
  GETTER:           33,
  VARIABLE:         28,
  PARAMETER:        26,
  CONSTANT:         40,
  CALL:             25,
  EXPRESSION:       22,
  LITERAL:          20,
  IMPORT:           30,
  EXPORT:           32,
  EXTERNAL:         38,
  PROPERTY_ACCESS:  25,
  PROJECT:          50,
};

/** Stable hash for region name → hue (0..360) */
function regionHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return ((h % 360) + 360) % 360;
}

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
  const regionLayerRef = useRef<RegionLayer | null>(null);
  const flowLayerLocalRef = useRef<FlowLayer | null>(null);
  const [sm, setSm] = useState<SceneManager | null>(null);

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

    // --- Hex tiles ---
    if (hexLayerRef.current) sm.scene.remove(hexLayerRef.current.mesh);
    const layer = new HexLayer(nodes.length, TILE_SIZE * 0.92, sm.scene);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      // Region hue + type lightness variation
      const hue = regionHue(n.region) / 360;
      const lightness = (TYPE_LIGHTNESS[n.type] ?? 30) / 100;
      layer.setTile(i, n.x, n.z, 0x000000); // placeholder
      layer.setColorHSL(i, hue, 0.5, lightness);
    }
    layer.finalize();
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
    let hoveredIdx = -1;
    let selectedIdx = -1;
    let selectedConnected = new Set<number>();

    function updateMouse(e: MouseEvent) {
      const rect = containerRef.current!.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function clearSelection() {
      for (let i = 0; i < nodes.length; i++) {
        layer.animateTo(i, 'elevation', 0, 300);
        layer.animateTo(i, 'outlineWidth', 0, 200);
        layer.animateTo(i, 'opacity', 1.0, 200);
      }
      flowLayer.highlightEdges(null); // reset edge opacity
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
          layer.animateTo(i, 'elevation', 0, 300);
          layer.animateTo(i, 'outlineWidth', 0, 200);
          layer.animateTo(i, 'opacity', 0.25, 200);
        }
      }

      // Dim edges not connected to selection
      const activeSet = new Set(connected);
      activeSet.add(clickIdx);
      flowLayer.highlightEdges(activeSet);
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
    };
  }, [loaded, nodes, edges, regions]);

  return (
    <div ref={containerRef} className="canvas-container">
      <Labels sceneManager={sm} />
      <CoordGrid sceneManager={sm} visible={showCoords} />
    </div>
  );
}
