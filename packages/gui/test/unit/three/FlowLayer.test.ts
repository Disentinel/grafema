/**
 * Unit tests for FlowLayer — tube vs line rendering styles (C-Layer-Flow).
 *
 * FlowLayer renders code edges as either:
 *  - 'tube' (default): THREE.TubeGeometry meshes on a curved Bezier path.
 *    Heavy & expressive — good for perspective 3D.
 *  - 'line': flat LineSegments2 (from three/examples/jsm/lines) — sharp on
 *    orthographic 2D cameras, thin but with configurable linewidth.
 *
 * Contract tested here:
 *  - Default style is 'tube' and renders one tube + one arrow per edge.
 *  - setStyle('line') disposes tubes/arrows and adds LineSegments2 instead.
 *  - setStyle('tube') returns to tube representation.
 *  - Per-flow visibility (setFlowVisible) survives style switches.
 *  - recolorByNodes(fn) recolors the current style (tube or line).
 *  - setDensityCap(N) caps the number of edges rendered (first-N).
 *
 * Uses real Three.js (no renderer / WebGL needed for geometry/material
 * construction and scene graph assertions).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';

import { FlowLayer } from '../../../src/three/FlowLayer.js';
import type { GraphNode, GraphEdge } from '../../../src/store/dataStore.js';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

function makeNodes(n: number): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: `n${i}`,
      type: 'FUNCTION',
      name: `fn${i}`,
      file: `f${i}.ts`,
      region: 'r',
      x: i * 5,
      z: (i % 2) * 5,
      degree: 2,
    });
  }
  return nodes;
}

/** 10 edges of a single flow preset (all 'IMPORTS_FROM' → deps flow). */
function makeEdges(count: number): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 0; i < count; i++) {
    edges.push({ source: i, target: (i + 1) % count, type: 'IMPORTS_FROM' });
  }
  return edges;
}

// ----------------------------------------------------------------------------
// Scene-graph helpers (traverse the layer root)
// ----------------------------------------------------------------------------

function countTubeMeshes(layer: FlowLayer): number {
  // A "tube" edge = one Mesh with TubeGeometry. Each edge also creates an
  // arrow (ConeGeometry) — we count only tubes here.
  let count = 0;
  layer.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.TubeGeometry) {
      count++;
    }
  });
  return count;
}

function countArrows(layer: FlowLayer): number {
  let count = 0;
  layer.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.ConeGeometry) {
      count++;
    }
  });
  return count;
}

function findLineSegments2(layer: FlowLayer): LineSegments2[] {
  const out: LineSegments2[] = [];
  layer.group.traverse((obj) => {
    if (obj instanceof LineSegments2) out.push(obj);
  });
  return out;
}

/** Total number of line segments (vertex pairs) across all LineSegments2. */
function totalLineSegmentCount(layer: FlowLayer): number {
  let total = 0;
  for (const seg of findLineSegments2(layer)) {
    // LineSegmentsGeometry stores `instanceStart` count = number of segments.
    const attr = seg.geometry.attributes.instanceStart;
    if (attr) total += attr.count;
  }
  return total;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('FlowLayer: default tube style', () => {
  let scene: THREE.Scene;
  let layer: FlowLayer;

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new FlowLayer(scene);
    const nodes = makeNodes(10);
    const edges = makeEdges(10);
    layer.build(nodes, edges);
    // 'deps' preset is not alwaysOn — make it visible so rendering is testable.
    layer.setFlowVisible('deps', true);
  });

  it('starts with 10 tube meshes (one per edge)', () => {
    assert.equal(countTubeMeshes(layer), 10, 'expected 10 tubes');
    assert.equal(countArrows(layer), 10, 'expected 10 arrow cones');
  });

  it('has no LineSegments2 in the default tube style', () => {
    assert.equal(findLineSegments2(layer).length, 0);
  });
});

describe('FlowLayer: setStyle switching', () => {
  let scene: THREE.Scene;
  let layer: FlowLayer;

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new FlowLayer(scene);
    const nodes = makeNodes(10);
    const edges = makeEdges(10);
    layer.build(nodes, edges);
    layer.setFlowVisible('deps', true);
  });

  it('setStyle("line") disposes tubes and creates LineSegments2 with 10 segments', () => {
    layer.setStyle('line');

    assert.equal(countTubeMeshes(layer), 0, 'all tubes must be disposed');
    assert.equal(countArrows(layer), 0, 'all arrows must be disposed');

    const segs = findLineSegments2(layer);
    assert.ok(segs.length >= 1, 'expected at least one LineSegments2');
    assert.equal(totalLineSegmentCount(layer), 10,
      `expected 10 line segments, got ${totalLineSegmentCount(layer)}`);
  });

  it('setStyle("tube") after "line" recreates tubes and removes line segments', () => {
    layer.setStyle('line');
    layer.setStyle('tube');

    assert.equal(countTubeMeshes(layer), 10, 'tubes must be restored');
    assert.equal(countArrows(layer), 10, 'arrows must be restored');
    assert.equal(findLineSegments2(layer).length, 0, 'line segments gone');
  });

  it('repeated setStyle calls are idempotent (no leak)', () => {
    layer.setStyle('tube'); // no-op
    layer.setStyle('tube');
    assert.equal(countTubeMeshes(layer), 10);

    layer.setStyle('line');
    layer.setStyle('line'); // no-op
    assert.equal(totalLineSegmentCount(layer), 10);
    assert.equal(countTubeMeshes(layer), 0);
  });
});

describe('FlowLayer: visibility survives style switches', () => {
  let scene: THREE.Scene;
  let layer: FlowLayer;

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new FlowLayer(scene);
    // Mix flows: some 'deps' (IMPORTS_FROM) and some 'bridges' (REMOTE_CALL).
    const nodes = makeNodes(8);
    const edges: GraphEdge[] = [
      { source: 0, target: 1, type: 'IMPORTS_FROM' },
      { source: 1, target: 2, type: 'IMPORTS_FROM' },
      { source: 2, target: 3, type: 'IMPORTS_FROM' },
      { source: 3, target: 4, type: 'REMOTE_CALL' },
      { source: 4, target: 5, type: 'REMOTE_CALL' },
      { source: 5, target: 6, type: 'REMOTE_CALL' },
    ];
    layer.build(nodes, edges);
  });

  it('setFlowVisible("bridges", false) after style change honours visibility in line style', () => {
    // 'bridges' has alwaysOn:true → starts visible.
    assert.equal(layer.isFlowVisible('bridges'), true);

    layer.setStyle('line');
    layer.setFlowVisible('bridges', false);

    assert.equal(layer.isFlowVisible('bridges'), false,
      'bridges must report hidden after setFlowVisible(false)');

    // And in the actual scene: the bridges' LineSegments2 (or containing
    // group) must not be visible.
    let bridgesVisible = false;
    layer.group.traverse((obj) => {
      if (obj instanceof LineSegments2 && obj.visible && obj.parent?.visible) {
        // Check if this segment belongs to the bridges flow via parent group name.
        const groupName = obj.parent?.name ?? '';
        if (groupName === 'bridges' && obj.parent?.visible === true) {
          bridgesVisible = true;
        }
      }
    });
    assert.equal(bridgesVisible, false,
      'no visible LineSegments2 for bridges flow after setFlowVisible(false)');
  });

  it('visibility state persists across tube→line→tube round-trip', () => {
    // 'deps' is not alwaysOn — default hidden. Make it visible first.
    layer.setFlowVisible('deps', true);
    assert.equal(layer.isFlowVisible('deps'), true);

    // Hide bridges (was alwaysOn visible by default).
    layer.setFlowVisible('bridges', false);

    layer.setStyle('line');
    assert.equal(layer.isFlowVisible('deps'), true,
      'deps visibility preserved after switch to line');
    assert.equal(layer.isFlowVisible('bridges'), false,
      'bridges hidden state preserved after switch to line');

    layer.setStyle('tube');
    assert.equal(layer.isFlowVisible('deps'), true,
      'deps visibility preserved after switch back to tube');
    assert.equal(layer.isFlowVisible('bridges'), false,
      'bridges hidden state preserved after switch back to tube');
  });
});

describe('FlowLayer: setDensityCap', () => {
  let scene: THREE.Scene;
  let layer: FlowLayer;

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new FlowLayer(scene);
  });

  it('setDensityCap(5) before build limits to 5 edges in tube style', () => {
    layer.setDensityCap(5);
    const nodes = makeNodes(10);
    const edges = makeEdges(10);
    layer.build(nodes, edges);
    layer.setFlowVisible('deps', true);

    assert.equal(countTubeMeshes(layer), 5,
      `expected 5 tubes after cap, got ${countTubeMeshes(layer)}`);
  });

  it('setDensityCap applies to line style too', () => {
    layer.setDensityCap(5);
    const nodes = makeNodes(10);
    const edges = makeEdges(10);
    layer.build(nodes, edges);
    layer.setFlowVisible('deps', true);
    layer.setStyle('line');

    assert.equal(totalLineSegmentCount(layer), 5,
      `expected 5 line segments after cap, got ${totalLineSegmentCount(layer)}`);
  });

  it('setDensityCap after build re-applies cap in current style', () => {
    const nodes = makeNodes(10);
    const edges = makeEdges(10);
    layer.build(nodes, edges);
    layer.setFlowVisible('deps', true);
    assert.equal(countTubeMeshes(layer), 10);

    layer.setDensityCap(3);
    assert.equal(countTubeMeshes(layer), 3,
      'tube count must drop to 3 after setDensityCap(3)');
  });
});

describe('FlowLayer: recolorByNodes in line style', () => {
  let scene: THREE.Scene;
  let layer: FlowLayer;

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new FlowLayer(scene);
    const nodes = makeNodes(10);
    const edges = makeEdges(10);
    layer.build(nodes, edges);
    layer.setFlowVisible('deps', true);
  });

  it('recolorByNodes after setStyle("line") picks up new color on line segments', () => {
    layer.setStyle('line');

    // Sanity: line segments exist.
    const segs = findLineSegments2(layer);
    assert.ok(segs.length >= 1);

    // Apply a green color function.
    const GREEN = 0x00ff00;
    layer.recolorByNodes(() => new THREE.Color(GREEN));

    // Inspect vertex colors on at least one segment. The blended target color
    // (dst-weighted 0.7 from src+dst of same GREEN) must equal pure green.
    let foundGreenVertex = false;
    for (const seg of segs) {
      const colorAttr = seg.geometry.attributes.instanceColorStart
        ?? seg.geometry.attributes.instanceColorEnd;
      if (!colorAttr) continue;
      for (let i = 0; i < colorAttr.count; i++) {
        const r = colorAttr.getX(i);
        const g = colorAttr.getY(i);
        const b = colorAttr.getZ(i);
        if (Math.abs(r) < 0.01 && Math.abs(g - 1.0) < 0.01 && Math.abs(b) < 0.01) {
          foundGreenVertex = true;
          break;
        }
      }
      if (foundGreenVertex) break;
    }
    assert.equal(foundGreenVertex, true,
      'expected at least one green-colored vertex in LineSegments2 after recolorByNodes');
  });

  it('recolorByNodes(null) after setStyle("line") resets to preset color', () => {
    layer.setStyle('line');
    // Recolor to red first.
    layer.recolorByNodes(() => new THREE.Color(0xff0000));
    // Reset.
    layer.recolorByNodes(null);

    // 'deps' preset color is 0x00d4ff. Decode via THREE.Color so that any
    // sRGB→linear conversion the renderer applies is accounted for.
    const presetColor = new THREE.Color(0x00d4ff);
    const presetR = presetColor.r;
    const presetG = presetColor.g;
    const presetB = presetColor.b;

    let foundPresetVertex = false;
    for (const seg of findLineSegments2(layer)) {
      const colorAttr = seg.geometry.attributes.instanceColorStart
        ?? seg.geometry.attributes.instanceColorEnd;
      if (!colorAttr) continue;
      for (let i = 0; i < colorAttr.count; i++) {
        const r = colorAttr.getX(i);
        const g = colorAttr.getY(i);
        const b = colorAttr.getZ(i);
        if (
          Math.abs(r - presetR) < 0.02 &&
          Math.abs(g - presetG) < 0.02 &&
          Math.abs(b - presetB) < 0.02
        ) {
          foundPresetVertex = true;
          break;
        }
      }
      if (foundPresetVertex) break;
    }
    assert.equal(foundPresetVertex, true,
      'expected preset color (0x00d4ff) on line vertices after recolorByNodes(null)');
  });
});
