import * as THREE from 'three';
import type { GraphNode, GraphEdge } from '../store/dataStore';
import { FLOWS, type FlowPreset } from '../config/flows';

const CURVE_SEGMENTS = 16;
const BASE_Y = 0.8;

interface EdgeBinding {
  line: THREE.Mesh; // TubeGeometry mesh
  arrow: THREE.Mesh;
  srcIdx: number;
  dstIdx: number;
  edgeType: string;
  /** Midpoint lift amount */
  lift: number;
  srcWorld: { x: number; z: number };
  dstWorld: { x: number; z: number };
}

/**
 * FlowLayer — renders edges as colored curved lines grouped by flow preset.
 *
 * Reads elevations from a shared Float32Array (owned by HexLayer or Canvas)
 * each tick, so edges follow node elevation with zero latency.
 */
export class FlowLayer {
  private _group = new THREE.Group();
  // Render order above hex tiles (default 0)
  private static RENDER_ORDER = 10;
  private _flowGroups = new Map<string, THREE.Group>();
  private _bindings: EdgeBinding[] = [];
  private _nodes: GraphNode[] = [];

  /** Shared elevation array — set via setElevationSource() */
  private _elevations: Float32Array | null = null;
  /** Snapshot of last-applied elevations to skip unchanged bindings */
  private _prevElev: Float32Array = new Float32Array(0);
  /** Set of node indices whose elevation changed this frame */
  private _dirty = new Set<number>();

  constructor(scene: THREE.Scene) {
    scene.add(this._group);
  }

  /**
   * Point to the SAME Float32Array that HexLayer uses for elevation.
   * This avoids message passing — FlowLayer reads the source of truth directly.
   */
  setElevationSource(arr: Float32Array) {
    this._elevations = arr;
    this._prevElev = new Float32Array(arr.length);
  }

  build(nodes: GraphNode[], edges: GraphEdge[]) {
    this._nodes = nodes;
    this._clear();

    const typeToFlow = new Map<string, string>();
    for (const [name, preset] of Object.entries(FLOWS)) {
      for (const t of preset.types) typeToFlow.set(t, name);
    }

    const edgesByFlow = new Map<string, GraphEdge[]>();
    for (const edge of edges) {
      const flowName = typeToFlow.get(edge.type);
      if (!flowName) continue;
      if (!edgesByFlow.has(flowName)) edgesByFlow.set(flowName, []);
      edgesByFlow.get(flowName)!.push(edge);
    }

    for (const [flowName, flowEdges] of edgesByFlow) {
      const preset = FLOWS[flowName];
      const group = this._buildFlowGroup(flowEdges, preset);
      group.visible = preset.alwaysOn ?? false;
      this._flowGroups.set(flowName, group);
      this._group.add(group);
    }
  }

  /**
   * Call in render loop. Diffs elevation array, updates only changed bindings.
   */
  tick() {
    if (!this._elevations) return;

    // Find which nodes changed elevation
    this._dirty.clear();
    for (let i = 0; i < this._elevations.length; i++) {
      if (Math.abs(this._elevations[i] - this._prevElev[i]) > 0.001) {
        this._dirty.add(i);
        this._prevElev[i] = this._elevations[i];
      }
    }

    if (this._dirty.size === 0) return;

    // Update only bindings touching dirty nodes
    for (const b of this._bindings) {
      if (!this._dirty.has(b.srcIdx) && !this._dirty.has(b.dstIdx)) continue;
      if (!b.line.parent?.visible) continue;

      const srcE = this._elevations[b.srcIdx];
      const dstE = this._elevations[b.dstIdx];

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(b.srcWorld.x, BASE_Y + srcE, b.srcWorld.z),
        new THREE.Vector3(
          (b.srcWorld.x + b.dstWorld.x) / 2,
          BASE_Y + b.lift + (srcE + dstE) / 2,
          (b.srcWorld.z + b.dstWorld.z) / 2,
        ),
        new THREE.Vector3(b.dstWorld.x, BASE_Y + dstE, b.dstWorld.z),
      );

      const points = curve.getPoints(CURVE_SEGMENTS);
      // Rebuild tube geometry (can't update TubeGeometry positions in-place)
      b.line.geometry.dispose();
      const tubePath = new THREE.CatmullRomCurve3(points);
      b.line.geometry = new THREE.TubeGeometry(tubePath, CURVE_SEGMENTS, 0.15, 4, false);

      // Arrow
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      b.arrow.position.copy(last);
      b.arrow.lookAt(last.clone().add(last.clone().sub(prev).normalize()));
    }
  }

  /**
   * Recolor edges based on a per-node color function (e.g., from lens).
   * Each edge takes the color of its target node (data flows TO target).
   * Pass null to reset to flow preset colors.
   */
  recolorByNodes(colorFn: ((nodeIdx: number) => THREE.Color) | null) {
    for (const b of this._bindings) {
      const lineMat = b.line.material as THREE.MeshBasicMaterial;
      const arrowMat = b.arrow.material as THREE.MeshBasicMaterial;

      if (!colorFn) {
        // Reset to flow preset color — find parent group's default
        lineMat.color.copy(this._getPresetColor(b));
        arrowMat.color.copy(this._getPresetColor(b));
      } else {
        // Blend source and target colors (target-weighted)
        const srcColor = colorFn(b.srcIdx);
        const dstColor = colorFn(b.dstIdx);
        const blended = srcColor.clone().lerp(dstColor, 0.7); // bias toward target
        lineMat.color.copy(blended);
        arrowMat.color.copy(blended);
      }
    }
  }

  private _getPresetColor(b: EdgeBinding): THREE.Color {
    // Find which flow preset this edge belongs to
    const typeToFlow = new Map<string, string>();
    for (const [name, preset] of Object.entries(FLOWS)) {
      for (const t of preset.types) typeToFlow.set(t, name);
    }
    const flowName = typeToFlow.get(b.edgeType);
    const preset = flowName ? FLOWS[flowName] : null;
    return new THREE.Color(preset?.color ?? 0x444466);
  }

  /**
   * Highlight edges connected to a set of nodes, dim the rest.
   * Pass null to reset all edges to full opacity.
   */
  highlightEdges(activeNodes: Set<number> | null) {
    for (const b of this._bindings) {
      if (!b.line.parent?.visible) continue;
      const lineMat = b.line.material as THREE.MeshBasicMaterial;
      const arrowMat = b.arrow.material as THREE.MeshBasicMaterial;

      if (!activeNodes) {
        // Reset
        lineMat.opacity = 0.6;
        arrowMat.opacity = 0.7;
      } else if (activeNodes.has(b.srcIdx) || activeNodes.has(b.dstIdx)) {
        // Connected to active — bright
        lineMat.opacity = 0.9;
        arrowMat.opacity = 1.0;
      } else {
        // Not connected — dim
        lineMat.opacity = 0.06;
        arrowMat.opacity = 0.06;
      }
    }
  }

  /**
   * Get edge info for edges connected to a node (for tooltip display).
   * Returns only edges from visible flows.
   */
  getConnectedEdgeInfo(nodeIdx: number): { srcIdx: number; dstIdx: number; edgeType: string }[] {
    const result: { srcIdx: number; dstIdx: number; edgeType: string }[] = [];
    for (const b of this._bindings) {
      if (!b.line.parent?.visible) continue;
      if (b.srcIdx === nodeIdx || b.dstIdx === nodeIdx) {
        result.push({ srcIdx: b.srcIdx, dstIdx: b.dstIdx, edgeType: b.edgeType });
      }
    }
    return result;
  }

  setFlowVisible(flowName: string, visible: boolean) {
    const group = this._flowGroups.get(flowName);
    if (group) group.visible = visible;
  }

  isFlowVisible(flowName: string): boolean {
    return this._flowGroups.get(flowName)?.visible ?? false;
  }

  private _buildFlowGroup(edges: GraphEdge[], preset: FlowPreset): THREE.Group {
    const group = new THREE.Group();
    const color = new THREE.Color(preset.color);

    for (const edge of edges) {
      const src = this._nodes[edge.source];
      const dst = this._nodes[edge.target];
      if (!src || !dst) continue;

      const dist = Math.sqrt((dst.x - src.x) ** 2 + (dst.z - src.z) ** 2);
      const lift = Math.min(dist * 0.15, 5);

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(src.x, BASE_Y, src.z),
        new THREE.Vector3((src.x + dst.x) / 2, BASE_Y + lift, (src.z + dst.z) / 2),
        new THREE.Vector3(dst.x, BASE_Y, dst.z),
      );

      const points = curve.getPoints(CURVE_SEGMENTS);

      // Thick tube instead of thin line
      const tubePath = new THREE.CatmullRomCurve3(points);
      const tubeGeo = new THREE.TubeGeometry(tubePath, CURVE_SEGMENTS, 0.15, 4, false);
      const tubeMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        depthTest: false, // always visible, never hidden by tiles
      });
      const line = new THREE.Mesh(tubeGeo, tubeMat);
      line.renderOrder = FlowLayer.RENDER_ORDER;
      group.add(line);

      // Small arrow head
      const lastSeg = points[points.length - 1].clone().sub(points[points.length - 2]).normalize();
      const arrowGeo = new THREE.ConeGeometry(0.2, 0.5, 4);
      arrowGeo.rotateX(Math.PI / 2);
      const arrowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthTest: false });
      const arrow = new THREE.Mesh(arrowGeo, arrowMat);
      arrow.renderOrder = FlowLayer.RENDER_ORDER;
      arrow.position.copy(points[points.length - 1]);
      arrow.lookAt(points[points.length - 1].clone().add(lastSeg));
      group.add(arrow);

      this._bindings.push({
        line,
        arrow,
        srcIdx: edge.source,
        dstIdx: edge.target,
        edgeType: edge.type,
        lift,
        srcWorld: { x: src.x, z: src.z },
        dstWorld: { x: dst.x, z: dst.z },
      });
    }

    return group;
  }

  private _clear() {
    for (const [, group] of this._flowGroups) {
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      this._group.remove(group);
    }
    this._flowGroups.clear();
    this._bindings = [];
  }

  dispose() { this._clear(); }
}
