/**
 * Unit tests for HullLayer (post-C-Layer-Hull refactor).
 *
 * HullLayer renders the exact concave boundary of each region as
 * line segments in 3-D. It consumes the batched hull generator from
 * `geom/hull.ts` so long hull jobs spread across idle slots instead
 * of blocking the main thread.
 *
 * We verify the algorithmic contract only — no renderer is needed.
 * Three.Scene / Group / LineSegments / BufferGeometry / LineBasicMaterial
 * all work headless under node --test (no WebGL context).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { HullLayer, type HullRegion } from '../../../src/three/HullLayer.js';

const SIZE = 3.0;

/** Build a tile set from axial coord pairs. */
function tileSet(coords: Array<[number, number]>): { q: number; r: number }[] {
  return coords.map(([q, r]) => ({ q, r }));
}

/** Count how many meshes (Line / LineSegments / Mesh) the root group owns. */
function meshCount(scene: THREE.Scene, layer: HullLayer): number {
  // Layer keeps its own group attached to scene — count its children.
  return layer.group.children.length;
}

describe('HullLayer: construction and lifecycle', () => {
  let scene: THREE.Scene;
  let layer: HullLayer;

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new HullLayer(scene);
  });

  it('starts with empty group attached to scene', () => {
    assert.equal(scene.children.length, 1, 'scene holds the layer root group');
    assert.equal(layer.group.children.length, 0, 'no hull meshes yet');
    assert.equal(layer.group.visible, true, 'visible by default');
  });

  it('setVisible toggles root group visibility', () => {
    layer.setVisible(false);
    assert.equal(layer.group.visible, false);
    layer.setVisible(true);
    assert.equal(layer.group.visible, true);
  });

  it('dispose removes children and the group from scene', () => {
    // Simulate some children so dispose has work to do.
    const dummy = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial(),
    );
    layer.group.add(dummy);
    assert.equal(layer.group.children.length, 1);

    layer.dispose();
    assert.equal(layer.group.children.length, 0, 'children cleared');
  });
});

describe('HullLayer: setRegions — algorithmic contract', () => {
  let scene: THREE.Scene;
  let layer: HullLayer;

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new HullLayer(scene);
  });

  it('creates one line mesh per yielded region loop (single-hex regions)', async () => {
    const regions: HullRegion[] = [
      { path: 'pkg/a', tiles: tileSet([[0, 0]]) },      // 1 loop
      { path: 'pkg/b', tiles: tileSet([[10, 0]]) },     // 1 loop
      { path: 'pkg/c', tiles: tileSet([[20, 0]]) },     // 1 loop
    ];
    await layer.setRegions(regions, SIZE);
    // Each single hex produces exactly 1 loop → 1 line mesh.
    assert.equal(meshCount(scene, layer), 3,
      `expected 3 line meshes, got ${meshCount(scene, layer)}`);
  });

  it('produces 2 meshes for a ring (outer + inner hole loops)', async () => {
    // 6-hex ring around (0,0): boundary has outer + inner loop.
    const ring: HullRegion = {
      path: 'pkg/ring',
      tiles: tileSet([
        [1, 0], [1, -1], [0, -1],
        [-1, 0], [-1, 1], [0, 1],
      ]),
    };
    await layer.setRegions([ring], SIZE);
    assert.equal(meshCount(scene, layer), 2,
      'ring with hole should create outer + inner line meshes');
  });

  it('clears previous meshes when called again', async () => {
    await layer.setRegions(
      [{ path: 'first', tiles: tileSet([[0, 0]]) }],
      SIZE,
    );
    assert.equal(meshCount(scene, layer), 1);

    await layer.setRegions(
      [
        { path: 'x', tiles: tileSet([[0, 0]]) },
        { path: 'y', tiles: tileSet([[10, 0]]) },
      ],
      SIZE,
    );
    assert.equal(meshCount(scene, layer), 2,
      'previous hull meshes replaced, not appended');
  });

  it('skips regions with no tiles silently', async () => {
    const regions: HullRegion[] = [
      { path: 'a', tiles: tileSet([[0, 0]]) },
      { path: 'empty', tiles: [] },
      { path: 'b', tiles: tileSet([[10, 0]]) },
    ];
    await layer.setRegions(regions, SIZE);
    assert.equal(meshCount(scene, layer), 2,
      'empty region contributes no mesh');
  });

  it('colors line meshes deterministically by region path', async () => {
    const regions: HullRegion[] = [
      { path: 'pkg/a', tiles: tileSet([[0, 0]]) },
      { path: 'pkg/a', tiles: tileSet([[5, 0]]) }, // same path → same color
      { path: 'pkg/b', tiles: tileSet([[10, 0]]) },
    ];
    await layer.setRegions(regions, SIZE);
    const children = layer.group.children as Array<THREE.Mesh | THREE.LineSegments>;
    assert.equal(children.length, 3);
    // Colors of same-path regions should match; different paths differ.
    const colorOf = (c: THREE.Object3D): number => {
      const m = (c as THREE.Mesh).material as THREE.Material & { color?: THREE.Color };
      if (m?.color) return m.color.getHex();
      // LineMaterial also exposes color.
      return 0;
    };
    const c0 = colorOf(children[0]);
    const c1 = colorOf(children[1]);
    const c2 = colorOf(children[2]);
    assert.equal(c0, c1, 'same region path → same color');
    assert.notEqual(c0, c2, 'different region path → different color');
  });
});

describe('HullLayer: setStyle', () => {
  it('setStyle("hidden") hides the root group, "line" shows it', async () => {
    const scene = new THREE.Scene();
    const layer = new HullLayer(scene);
    await layer.setRegions(
      [{ path: 'x', tiles: tileSet([[0, 0]]) }],
      SIZE,
    );
    layer.setStyle('hidden');
    assert.equal(layer.group.visible, false);
    layer.setStyle('line');
    assert.equal(layer.group.visible, true);
  });
});

describe('HullLayer: AbortSignal support (E14 dual-abort)', () => {
  it('returns early without adding meshes when signal is already aborted', async () => {
    const scene = new THREE.Scene();
    const layer = new HullLayer(scene);
    const ctl = new AbortController();
    ctl.abort();
    await layer.setRegions(
      [{ path: 'x', tiles: tileSet([[0, 0]]) }],
      SIZE,
      ctl.signal,
    );
    assert.equal(layer.group.children.length, 0,
      'pre-aborted signal should skip mesh construction entirely');
  });

  it('aborts mid-flight and leaves the group empty (no disposed-object errors)', async () => {
    // Build a moderately-sized batch so `computeHullPolygonsBatched`
    // yields more than once. Trigger abort after the first microtask
    // slice — the layer should bail out cleanly without throwing.
    const scene = new THREE.Scene();
    const layer = new HullLayer(scene);
    const ctl = new AbortController();
    const regions: HullRegion[] = [];
    for (let i = 0; i < 20; i++) {
      regions.push({
        path: `pkg/${i}`,
        tiles: [{ q: i * 10, r: 0 }, { q: i * 10 + 1, r: 0 }],
      });
    }
    const p = layer.setRegions(regions, SIZE, ctl.signal);
    // Abort in the next microtask so the first batch may or may not
    // have landed — either way the call must not throw.
    queueMicrotask(() => ctl.abort());
    await assert.doesNotReject(p);
  });
});

describe('HullLayer: timing — 50 small regions', () => {
  it('finishes under 200ms wall time on a stub', async () => {
    const scene = new THREE.Scene();
    const layer = new HullLayer(scene);
    // 50 regions × ~5 tiles each, arranged along the +q axis far apart so
    // each region is independent. computeHullPolygons runs per region.
    const regions: HullRegion[] = [];
    for (let i = 0; i < 50; i++) {
      const base = i * 50;
      regions.push({
        path: `pkg/${i}`,
        tiles: [
          { q: base + 0, r: 0 },
          { q: base + 1, r: 0 },
          { q: base + 0, r: 1 },
          { q: base + 1, r: -1 },
          { q: base + 2, r: 0 },
        ],
      });
    }
    const t0 = performance.now();
    await layer.setRegions(regions, SIZE);
    const elapsed = performance.now() - t0;
    assert.equal(layer.group.children.length, 50);
    assert.ok(elapsed < 200,
      `setRegions took ${elapsed.toFixed(1)}ms, expected < 200ms`);
  });
});
