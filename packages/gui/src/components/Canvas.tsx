import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { SceneManager } from '../three/SceneManager';
import { HexLayer } from '../three/HexLayer';
import { RegionLayer } from '../three/RegionLayer';
import { FlowLayer } from '../three/FlowLayer';
import { Labels } from './Labels';
import { useDataStore } from '../store/dataStore';
import { useMapStore } from '../store/mapStore';

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

export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneManager | null>(null);
  const hexLayerRef = useRef<HexLayer | null>(null);
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

    // --- Hover ---
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let hoveredIdx = -1;

    const onMouseMove = (e: MouseEvent) => {
      const rect = containerRef.current!.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, sm.camera);

      const newIdx = layer.raycast(raycaster);
      if (newIdx === hoveredIdx) return;

      if (hoveredIdx >= 0) {
        layer.animateTo(hoveredIdx, 'elevation', 0, 200);
        layer.animateTo(hoveredIdx, 'outlineWidth', 0, 200);
      }
      hoveredIdx = newIdx;
      if (hoveredIdx >= 0) {
        layer.animateTo(hoveredIdx, 'elevation', 1.5, 200);
        layer.animateTo(hoveredIdx, 'outlineWidth', 0.15, 200);
        layer.setOutlineColor(hoveredIdx, 0x00e5ff);
      }
    };
    sm.renderer.domElement.addEventListener('mousemove', onMouseMove);

    // --- Camera ---
    let cx = 0, cz = 0;
    for (const n of nodes) { cx += n.x; cz += n.z; }
    cx /= nodes.length;
    cz /= nodes.length;
    sm.controls.target.set(cx, 0, cz);
    sm.camera.position.set(cx, 80, cz + 80);

    return () => {
      sm.renderer.domElement.removeEventListener('mousemove', onMouseMove);
    };
  }, [loaded, nodes, edges, regions]);

  return (
    <div ref={containerRef} className="canvas-container">
      <Labels sceneManager={sm} />
    </div>
  );
}
