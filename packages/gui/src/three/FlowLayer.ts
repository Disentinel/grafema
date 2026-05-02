import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { GraphNode, GraphEdge } from '../store/dataStore';
import { FLOWS } from '../config/flows';

const CURVE_SEGMENTS = 16;
const BASE_Y = 0.8;

/**
 * Plan for one edge — style-agnostic. Built once in `build()` from the
 * raw GraphEdge + resolved node positions, then projected into the active
 * rendering style (tube or line).
 */
interface EdgePlan {
  flowName: string;
  srcIdx: number;
  dstIdx: number;
  edgeType: string;
  /** Midpoint lift amount for curved path (tube) */
  lift: number;
  srcWorld: { x: number; z: number };
  dstWorld: { x: number; z: number };
  presetColor: THREE.Color;
}

interface TubeBinding {
  kind: 'tube';
  line: THREE.Mesh; // TubeGeometry mesh
  arrow: THREE.Mesh;
  plan: EdgePlan;
}

interface LineBinding {
  kind: 'line';
  /** Index into the owning flow's LineSegments2 geometry (segment index). */
  segIdx: number;
  /** Parent LineSegments2 — shared with other line bindings of same flow. */
  segments: LineSegments2;
  plan: EdgePlan;
}

type EdgeBinding = TubeBinding | LineBinding;

/**
 * Per-flow rendering state. In tube style, `group` holds Mesh pairs
 * (tube + arrow) per edge. In line style, `group` holds a single
 * LineSegments2 spanning all edges of the flow.
 */
interface FlowSlot {
  name: string;
  group: THREE.Group;
  visible: boolean;
  /** Bindings belonging to this flow. Invariant: either all tube OR all line. */
  bindings: EdgeBinding[];
}

export type FlowStyle = 'tube' | 'line';

/**
 * FlowLayer — renders edges as colored lines grouped by flow preset.
 *
 * Supports two rendering styles:
 *  - 'tube' (default): thick curved Bezier tubes (TubeGeometry) with arrow cones.
 *    Rich look suited to perspective 3D view.
 *  - 'line': flat LineSegments2 with thick lines (three/examples/jsm/lines).
 *    Sharp on orthographic 2D cameras; cheaper per-edge.
 *
 * Reads elevations from a shared Float32Array (owned by HexLayer or Canvas)
 * each tick, so tube edges follow node elevation with zero latency. In line
 * style, tick is a no-op (line segments are flat).
 */
export class FlowLayer {
  private _group = new THREE.Group();
  // Render order above hex tiles (default 0)
  private static RENDER_ORDER = 10;

  /** Public read access for tests / introspection — mutate via methods only. */
  get group(): THREE.Group { return this._group; }

  private _slots = new Map<string, FlowSlot>();

  /** All edge plans built from the last `build(nodes, edges)` call. */
  private _plans: EdgePlan[] = [];
  /** Nodes last passed to build(), retained for reference. */
  private _nodes: GraphNode[] = [];

  /** Active rendering style. */
  private _style: FlowStyle = 'tube';
  /** Maximum edges rendered per flow. null = no cap. */
  private _densityCap: number | null = null;

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

  /**
   * Build the edge set. Preserves the current style and density cap, and
   * resets all flows to their preset default visibility (alwaysOn or hidden).
   */
  build(nodes: GraphNode[], edges: GraphEdge[]) {
    this._nodes = nodes;
    this._clearAll();
    this._plans = [];

    const typeToFlow = new Map<string, string>();
    for (const [name, preset] of Object.entries(FLOWS)) {
      for (const t of preset.types) typeToFlow.set(t, name);
    }

    // Build style-agnostic edge plans.
    for (const edge of edges) {
      const flowName = typeToFlow.get(edge.type);
      if (!flowName) continue;
      const src = nodes[edge.source];
      const dst = nodes[edge.target];
      if (!src || !dst) continue;

      const preset = FLOWS[flowName];
      const dist = Math.sqrt((dst.x - src.x) ** 2 + (dst.z - src.z) ** 2);
      const lift = Math.min(dist * 0.15, 5);

      this._plans.push({
        flowName,
        srcIdx: edge.source,
        dstIdx: edge.target,
        edgeType: edge.type,
        lift,
        srcWorld: { x: src.x, z: src.z },
        dstWorld: { x: dst.x, z: dst.z },
        presetColor: new THREE.Color(preset.color),
      });
    }

    // Initialise a slot per flow present in plans, seeded with preset visibility.
    const seen = new Set<string>();
    for (const plan of this._plans) seen.add(plan.flowName);
    for (const flowName of seen) {
      const preset = FLOWS[flowName];
      const group = new THREE.Group();
      group.name = flowName;
      group.visible = preset.alwaysOn ?? false;
      this._group.add(group);
      this._slots.set(flowName, {
        name: flowName,
        group,
        visible: preset.alwaysOn ?? false,
        bindings: [],
      });
    }

    this._buildActiveStyle();
  }

  /**
   * Switch rendering style. Disposes the inactive representation and
   * rebuilds the active one from the cached edge plans. Per-flow visibility
   * and density cap are preserved.
   */
  setStyle(style: FlowStyle) {
    if (style === this._style) return;
    this._style = style;
    this._rebuildSlots();
  }

  /** Current rendering style. */
  getStyle(): FlowStyle { return this._style; }

  /**
   * Set the maximum number of edges rendered per flow. Re-applies immediately
   * to the active style. Pass a non-positive value to remove the cap.
   */
  setDensityCap(cap: number) {
    this._densityCap = cap > 0 ? cap : null;
    this._rebuildSlots();
  }

  /**
   * Call in render loop. Diffs elevation array, updates only changed bindings.
   * No-op in line style (line segments are flat at BASE_Y).
   */
  tick() {
    if (this._style !== 'tube') return;
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

    // Update only tube bindings touching dirty nodes
    for (const slot of this._slots.values()) {
      if (!slot.group.visible) continue;
      for (const b of slot.bindings) {
        if (b.kind !== 'tube') continue;
        const p = b.plan;
        if (!this._dirty.has(p.srcIdx) && !this._dirty.has(p.dstIdx)) continue;

        const srcE = this._elevations[p.srcIdx];
        const dstE = this._elevations[p.dstIdx];

        const curve = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(p.srcWorld.x, BASE_Y + srcE, p.srcWorld.z),
          new THREE.Vector3(
            (p.srcWorld.x + p.dstWorld.x) / 2,
            BASE_Y + p.lift + (srcE + dstE) / 2,
            (p.srcWorld.z + p.dstWorld.z) / 2,
          ),
          new THREE.Vector3(p.dstWorld.x, BASE_Y + dstE, p.dstWorld.z),
        );

        const points = curve.getPoints(CURVE_SEGMENTS);
        b.line.geometry.dispose();
        const tubePath = new THREE.CatmullRomCurve3(points);
        b.line.geometry = new THREE.TubeGeometry(tubePath, CURVE_SEGMENTS, 0.4, 8, false);

        const last = points[points.length - 1];
        const prev = points[points.length - 2];
        b.arrow.position.copy(last);
        b.arrow.lookAt(last.clone().add(last.clone().sub(prev).normalize()));
      }
    }
  }

  /**
   * Recolor edges based on a per-node color function (e.g., from lens).
   * Each edge takes the blended source/target color (target-weighted).
   * Pass null to reset to flow preset colors.
   */
  recolorByNodes(colorFn: ((nodeIdx: number) => THREE.Color) | null) {
    for (const slot of this._slots.values()) {
      if (this._style === 'tube') {
        for (const b of slot.bindings) {
          if (b.kind !== 'tube') continue;
          const lineMat = b.line.material as THREE.MeshBasicMaterial;
          const arrowMat = b.arrow.material as THREE.MeshBasicMaterial;
          const color = this._edgeColor(b.plan, colorFn);
          lineMat.color.copy(color);
          arrowMat.color.copy(color);
        }
      } else {
        // Line style — update instanceColorStart / instanceColorEnd attributes.
        // We rebuild the color arrays per flow (one LineSegments2 per flow).
        const segments = this._getOrCreateLineSegments(slot);
        if (!segments) continue;
        const colorsArr = new Float32Array(slot.bindings.length * 6);
        for (let i = 0; i < slot.bindings.length; i++) {
          const b = slot.bindings[i];
          if (b.kind !== 'line') continue;
          const color = this._edgeColor(b.plan, colorFn);
          const off = i * 6;
          colorsArr[off + 0] = color.r;
          colorsArr[off + 1] = color.g;
          colorsArr[off + 2] = color.b;
          colorsArr[off + 3] = color.r;
          colorsArr[off + 4] = color.g;
          colorsArr[off + 5] = color.b;
        }
        segments.geometry.setColors(colorsArr as unknown as number[]);
      }
    }
  }

  /** Compute per-edge color given the user's color function (null = preset). */
  private _edgeColor(
    plan: EdgePlan,
    colorFn: ((nodeIdx: number) => THREE.Color) | null,
  ): THREE.Color {
    if (!colorFn) return plan.presetColor.clone();
    const srcColor = colorFn(plan.srcIdx);
    const dstColor = colorFn(plan.dstIdx);
    // Bias toward target (data flows TO target).
    return srcColor.clone().lerp(dstColor, 0.7);
  }

  /**
   * Highlight edges connected to a set of nodes, dim the rest.
   * Pass null to reset all edges to full opacity. Tube style only —
   * line style currently ignores highlight (no-op).
   * @param mode 'any' = either endpoint matches (default), 'both' = both endpoints must match
   */
  highlightEdges(activeNodes: Set<number> | null, mode: 'any' | 'both' = 'any') {
    if (this._style !== 'tube') return;
    for (const slot of this._slots.values()) {
      if (!slot.group.visible) continue;
      for (const b of slot.bindings) {
        if (b.kind !== 'tube') continue;
        const lineMat = b.line.material as THREE.MeshBasicMaterial;
        const arrowMat = b.arrow.material as THREE.MeshBasicMaterial;
        const presetColor = b.plan.presetColor;

        if (!activeNodes) {
          lineMat.opacity = 0.6;
          arrowMat.opacity = 0.7;
          lineMat.color.copy(presetColor);
          arrowMat.color.copy(presetColor);
        } else {
          const match = mode === 'both'
            ? activeNodes.has(b.plan.srcIdx) && activeNodes.has(b.plan.dstIdx)
            : activeNodes.has(b.plan.srcIdx) || activeNodes.has(b.plan.dstIdx);
          if (match) {
            lineMat.color.copy(presetColor).multiplyScalar(2.0);
            arrowMat.color.copy(presetColor).multiplyScalar(2.0);
            lineMat.opacity = 1.0;
            arrowMat.opacity = 1.0;
          } else {
            lineMat.color.copy(presetColor);
            arrowMat.color.copy(presetColor);
            lineMat.opacity = 0.06;
            arrowMat.opacity = 0.06;
          }
        }
      }
    }
  }

  /**
   * Pointer hit-test against per-edge tube meshes. Returns the edge under
   * the cursor (closest intersection) or null when no tube is hit. Only
   * meaningful in `tube` style — line-style geometry is one merged
   * `LineSegments2`, which would need per-segment hit math out of scope
   * here. Visible flows only: hidden slots' children are ignored by the
   * raycaster because their group.visible is false.
   */
  raycastEdge(raycaster: THREE.Raycaster): { srcIdx: number; dstIdx: number; edgeType: string } | null {
    if (this._style !== 'tube') return null;
    const hits = raycaster.intersectObject(this._group, true);
    for (const h of hits) {
      const tag = (h.object as THREE.Object3D).userData?.edge as
        | { srcIdx: number; dstIdx: number; edgeType: string }
        | undefined;
      if (tag) return tag;
    }
    return null;
  }

  /**
   * Get edge info for edges connected to a node (for tooltip display).
   * Returns only edges from visible flows.
   */
  getConnectedEdgeInfo(nodeIdx: number): { srcIdx: number; dstIdx: number; edgeType: string }[] {
    const result: { srcIdx: number; dstIdx: number; edgeType: string }[] = [];
    for (const slot of this._slots.values()) {
      if (!slot.group.visible) continue;
      for (const b of slot.bindings) {
        const p = b.plan;
        if (p.srcIdx === nodeIdx || p.dstIdx === nodeIdx) {
          result.push({ srcIdx: p.srcIdx, dstIdx: p.dstIdx, edgeType: p.edgeType });
        }
      }
    }
    return result;
  }

  /**
   * Get midpoint positions + edge types for highlighted edges.
   * For rendering labels on tubes when nodes are selected/pinned.
   */
  getHighlightedEdgeLabels(activeNodes: Set<number>): { worldX: number; worldZ: number; worldY: number; edgeType: string; srcIdx: number; dstIdx: number }[] {
    const result: { worldX: number; worldZ: number; worldY: number; edgeType: string; srcIdx: number; dstIdx: number }[] = [];
    for (const slot of this._slots.values()) {
      if (!slot.group.visible) continue;
      for (const b of slot.bindings) {
        const p = b.plan;
        if (!activeNodes.has(p.srcIdx) && !activeNodes.has(p.dstIdx)) continue;

        const srcE = this._elevations?.[p.srcIdx] ?? 0;
        const dstE = this._elevations?.[p.dstIdx] ?? 0;
        const midX = (p.srcWorld.x + p.dstWorld.x) / 2;
        const midZ = (p.srcWorld.z + p.dstWorld.z) / 2;
        const midY = this._style === 'tube'
          ? BASE_Y + p.lift + (srcE + dstE) / 2
          : BASE_Y;

        result.push({
          worldX: midX, worldZ: midZ, worldY: midY,
          edgeType: p.edgeType, srcIdx: p.srcIdx, dstIdx: p.dstIdx,
        });
      }
    }
    return result;
  }

  setFlowVisible(flowName: string, visible: boolean) {
    const slot = this._slots.get(flowName);
    if (!slot) return;
    slot.visible = visible;
    slot.group.visible = visible;
    // Force elevation re-sync on next tick (new tubes built at BASE_Y)
    if (visible && this._style === 'tube') this._prevElev.fill(0);
  }

  isFlowVisible(flowName: string): boolean {
    return this._slots.get(flowName)?.visible ?? false;
  }

  /**
   * Rebuild the active-style representation for every flow.
   * Preserves per-flow visibility. Called by setStyle and setDensityCap.
   */
  private _rebuildSlots() {
    for (const slot of this._slots.values()) {
      this._disposeSlotBindings(slot);
    }
    this._buildActiveStyle();
  }

  /**
   * Build style-specific bindings into each slot from `_plans`, respecting
   * the current density cap.
   */
  private _buildActiveStyle() {
    // Group plans by flow (order preserved).
    const plansByFlow = new Map<string, EdgePlan[]>();
    for (const plan of this._plans) {
      let arr = plansByFlow.get(plan.flowName);
      if (!arr) {
        arr = [];
        plansByFlow.set(plan.flowName, arr);
      }
      arr.push(plan);
    }

    for (const [flowName, plans] of plansByFlow) {
      const slot = this._slots.get(flowName);
      if (!slot) continue;
      const capped = this._densityCap != null ? plans.slice(0, this._densityCap) : plans;

      if (this._style === 'tube') {
        for (const plan of capped) {
          slot.bindings.push(this._buildTubeBinding(slot, plan));
        }
      } else {
        // Build a single LineSegments2 for the whole flow.
        this._buildLineBindings(slot, capped);
      }
    }
  }

  private _buildTubeBinding(slot: FlowSlot, plan: EdgePlan): TubeBinding {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(plan.srcWorld.x, BASE_Y, plan.srcWorld.z),
      new THREE.Vector3(
        (plan.srcWorld.x + plan.dstWorld.x) / 2,
        BASE_Y + plan.lift,
        (plan.srcWorld.z + plan.dstWorld.z) / 2,
      ),
      new THREE.Vector3(plan.dstWorld.x, BASE_Y, plan.dstWorld.z),
    );

    const points = curve.getPoints(CURVE_SEGMENTS);
    const tubePath = new THREE.CatmullRomCurve3(points);
    const tubeGeo = new THREE.TubeGeometry(tubePath, CURVE_SEGMENTS, 0.4, 8, false);
    const tubeMat = new THREE.MeshBasicMaterial({
      // Brighten the base preset color so tubes pop against the dark
      // tile/wall background (the original 0.6-opacity tube blended in
      // with the city).
      color: plan.presetColor.clone().multiplyScalar(1.4),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: false,
    });
    const line = new THREE.Mesh(tubeGeo, tubeMat);
    line.renderOrder = FlowLayer.RENDER_ORDER;
    // Tag the tube so a Raycaster hit can identify the underlying edge
    // without an extra reverse-lookup table. canvasBuild's hover handler
    // reads this on intersect to populate the edge tooltip.
    line.userData = {
      edge: { srcIdx: plan.srcIdx, dstIdx: plan.dstIdx, edgeType: plan.edgeType },
    };
    slot.group.add(line);

    const lastSeg = points[points.length - 1].clone().sub(points[points.length - 2]).normalize();
    const arrowGeo = new THREE.ConeGeometry(0.2, 0.5, 4);
    arrowGeo.rotateX(Math.PI / 2);
    const arrowMat = new THREE.MeshBasicMaterial({
      color: plan.presetColor.clone().multiplyScalar(1.4),
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    arrow.renderOrder = FlowLayer.RENDER_ORDER;
    arrow.position.copy(points[points.length - 1]);
    arrow.lookAt(points[points.length - 1].clone().add(lastSeg));
    slot.group.add(arrow);

    return { kind: 'tube', line, arrow, plan };
  }

  private _buildLineBindings(slot: FlowSlot, plans: EdgePlan[]) {
    if (plans.length === 0) return;

    const positions = new Float32Array(plans.length * 6);
    const colors = new Float32Array(plans.length * 6);
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const off = i * 6;
      // Start vertex
      positions[off + 0] = plan.srcWorld.x;
      positions[off + 1] = BASE_Y;
      positions[off + 2] = plan.srcWorld.z;
      // End vertex
      positions[off + 3] = plan.dstWorld.x;
      positions[off + 4] = BASE_Y;
      positions[off + 5] = plan.dstWorld.z;
      // Color (same for both endpoints — preset default)
      const c = plan.presetColor;
      colors[off + 0] = c.r;
      colors[off + 1] = c.g;
      colors[off + 2] = c.b;
      colors[off + 3] = c.r;
      colors[off + 4] = c.g;
      colors[off + 5] = c.b;
    }

    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions as unknown as number[]);
    geo.setColors(colors as unknown as number[]);

    const mat = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      linewidth: 2,
    });
    const segments = new LineSegments2(geo, mat);
    segments.renderOrder = FlowLayer.RENDER_ORDER;
    slot.group.add(segments);

    for (let i = 0; i < plans.length; i++) {
      slot.bindings.push({
        kind: 'line',
        segIdx: i,
        segments,
        plan: plans[i],
      });
    }
  }

  /**
   * Find the owning LineSegments2 for a flow slot in line style (if any).
   * All line bindings of a slot share the same LineSegments2 instance.
   */
  private _getOrCreateLineSegments(slot: FlowSlot): LineSegments2 | null {
    for (const b of slot.bindings) {
      if (b.kind === 'line') return b.segments;
    }
    return null;
  }

  /**
   * Dispose bindings for a single slot and clear its THREE.Group children.
   * Preserves slot identity (and therefore .visible state).
   */
  private _disposeSlotBindings(slot: FlowSlot) {
    for (const b of slot.bindings) {
      if (b.kind === 'tube') {
        b.line.geometry.dispose();
        (b.line.material as THREE.Material).dispose();
        b.arrow.geometry.dispose();
        (b.arrow.material as THREE.Material).dispose();
      }
    }
    // Line bindings share a single LineSegments2 per flow — dispose once via
    // the group children scan below.
    while (slot.group.children.length > 0) {
      const child = slot.group.children[0];
      if (child instanceof LineSegments2) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      } else if (child instanceof THREE.Mesh) {
        // Already disposed above in tube case, but be defensive.
        child.geometry.dispose();
        const mat = child.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      slot.group.remove(child);
    }
    slot.bindings = [];
  }

  /** Dispose every slot and remove all flow groups. Used by build() and dispose(). */
  private _clearAll() {
    for (const slot of this._slots.values()) {
      this._disposeSlotBindings(slot);
      this._group.remove(slot.group);
    }
    this._slots.clear();
  }

  dispose() {
    this._clearAll();
    this._plans = [];
  }
}
