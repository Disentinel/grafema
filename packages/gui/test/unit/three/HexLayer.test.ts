/**
 * Unit tests for HexLayer scene-mode support.
 *
 * HexLayer renders hex tiles via THREE.InstancedMesh. Elevation is applied
 * in the vertex shader through the `aElevation` per-instance attribute —
 * so the tile's rendered Y is NOT stored in instanceMatrix, it's stored in
 * `elevationArray` (exposed field). All Y assertions here inspect that
 * array directly, which is also the source of truth the shader consumes.
 *
 * Covered behavior (C-Layer-Hex):
 *  - setMode({ tileElevation: 'flat' }) forces rendered elevation to 0
 *    even when setProperty('elevation', v) / animateTo('elevation', ...)
 *    is called, and caches the requested value for later restoration.
 *  - Toggling 'flat' → 'on' restores the cached elevation. Toggling
 *    'on' → 'flat' zeroes the rendered elevation without losing the
 *    cached logical value.
 *  - setHovered(idx) respects `hoverLift`: 0 ⇒ no Y change; >0 ⇒ tile
 *    lifted by that delta above its base elevation. Un-hovering restores
 *    the base.
 *  - setPins(map) in flat mode creates a visible ring overlay positioned
 *    at the pinned tile's XZ. In 3D mode the ring overlay is hidden.
 *
 * Three.js is loaded normally — `tsx` handles the ESM import. A minimal
 * scene stub is sufficient because HexLayer only needs `scene.add(mesh)`.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { HexLayer } from '../../../src/three/HexLayer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TILE_COUNT = 10;
const HEX_SIZE = 1;

function makeLayer(): { layer: HexLayer; scene: THREE.Scene } {
  const scene = new THREE.Scene();
  const layer = new HexLayer(TILE_COUNT, HEX_SIZE, scene);
  // Lay tiles along the X axis so we can distinguish their XZ positions later.
  for (let i = 0; i < TILE_COUNT; i++) {
    layer.setTile(i, i * 2, 0, 0x888888);
  }
  layer.finalize();
  return { layer, scene };
}

// Tick one frame with enough dt to complete any in-flight tween.
function tickToCompletion(layer: HexLayer): void {
  // Durations used in tests are 100ms — 1 second is more than enough.
  layer.tick(1);
}

/**
 * `elevationArray` is a Float32Array, so any value we feed in (e.g. 1.8)
 * is rounded to the nearest float32 on store. Assert equality against
 * that same representation to avoid spurious precision failures.
 */
const f32 = (n: number): number => Math.fround(n);

// ---------------------------------------------------------------------------
// setMode — tileElevation
// ---------------------------------------------------------------------------

describe('HexLayer.setMode: tileElevation flat locks rendered Y to 0', () => {
  it('setProperty(elevation, 5) writes cache but keeps rendered Y=0 in flat mode', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });

    layer.setProperty(0, 'elevation', 5);

    assert.equal(layer.elevationArray[0], 0, 'rendered elevation should be 0 in flat mode');
  });

  it('animateTo(elevation, 3, 100ms) is a no-op on rendered Y in flat mode', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });

    layer.animateTo(2, 'elevation', 3, 100);
    tickToCompletion(layer);

    assert.equal(layer.elevationArray[2], 0, 'animation must not raise the tile in flat mode');
  });
});

describe('HexLayer.setMode: toggling preserves logical elevation', () => {
  it('on → flat → on restores the elevation set while on', () => {
    const { layer } = makeLayer();

    // Start in 'on' mode (default).
    layer.setProperty(4, 'elevation', 2.5);
    assert.equal(layer.elevationArray[4], f32(2.5));

    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });
    assert.equal(layer.elevationArray[4], 0, 'flat mode zeros rendered elevation');

    layer.setMode({ tileElevation: 'on', hoverLift: 0.4 });
    assert.equal(layer.elevationArray[4], f32(2.5), 'on mode restores cached elevation');
  });

  it('writes made while flat persist when switching back to on', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });

    // This write should update the cache even though rendered Y stays 0.
    layer.setProperty(6, 'elevation', 1.8);
    assert.equal(layer.elevationArray[6], 0);

    layer.setMode({ tileElevation: 'on', hoverLift: 0.4 });
    assert.equal(layer.elevationArray[6], f32(1.8), 'cached value from flat mode surfaces in on mode');
  });
});

// ---------------------------------------------------------------------------
// setHovered — hoverLift
// ---------------------------------------------------------------------------

describe('HexLayer.setHovered respects hoverLift', () => {
  it('hoverLift=0 leaves elevation unchanged', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });

    layer.setHovered(5);
    assert.equal(layer.elevationArray[5], 0, 'no lift with hoverLift=0');
  });

  it('hoverLift>0 adds to the hovered tile elevation', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'on', hoverLift: 2 });

    layer.setHovered(5);
    assert.equal(layer.elevationArray[5], 2, 'tile 5 raised by hoverLift');
  });

  it('un-hovering (setHovered(-1)) restores the base elevation', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'on', hoverLift: 2 });
    layer.setProperty(3, 'elevation', 1.5); // base for tile 3

    layer.setHovered(3);
    assert.equal(layer.elevationArray[3], f32(3.5), 'base 1.5 + lift 2');

    layer.setHovered(-1);
    assert.equal(layer.elevationArray[3], f32(1.5), 'un-hover restores base');
  });

  it('switching hover between tiles restores the previous and lifts the new', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'on', hoverLift: 1 });

    layer.setHovered(1);
    assert.equal(layer.elevationArray[1], 1);

    layer.setHovered(7);
    assert.equal(layer.elevationArray[1], 0, 'previous hover tile restored to base');
    assert.equal(layer.elevationArray[7], 1, 'new hover tile lifted');
  });
});

// ---------------------------------------------------------------------------
// setPins — flat-mode ring overlay
// ---------------------------------------------------------------------------

describe('HexLayer.setPins: ring overlay', () => {
  it('exposes a pinRings mesh attached to the scene', () => {
    const { layer, scene } = makeLayer();

    assert.ok(layer.pinRings, 'pinRings mesh should exist');
    assert.ok(
      scene.children.includes(layer.pinRings),
      'pinRings mesh should be added to the scene',
    );
  });

  it('flat mode + setPins([3]) renders a ring at tile 3 XZ', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });

    layer.setPins(new Map([[3, { color: 0xff0000 }]]));

    assert.equal(layer.pinRings.visible, true, 'rings visible in flat mode');
    assert.equal(layer.pinRings.count, 1, 'one ring rendered');

    // Read the first ring's translation from its instanceMatrix. THREE.Matrix4
    // is column-major, so translation XYZ are at elements 12, 13, 14.
    const mat = new THREE.Matrix4();
    layer.pinRings.getMatrixAt(0, mat);
    const el = mat.elements;
    assert.equal(el[12], layer.worldX[3], 'ring X matches tile 3');
    assert.equal(el[14], layer.worldZ[3], 'ring Z matches tile 3');
    assert.ok(el[13] > 0 && el[13] < 0.1, `ring Y slightly above ground (got ${el[13]})`);
  });

  it('unpinning removes the ring', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });

    layer.setPins(new Map([[3, { color: 0xff0000 }]]));
    assert.equal(layer.pinRings.count, 1);

    layer.setPins(new Map());
    assert.equal(layer.pinRings.count, 0, 'no rings after all pins removed');
  });

  it('ring overlay is hidden in 3D mode (tileElevation=on)', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'on', hoverLift: 0.4 });

    layer.setPins(new Map([[3, { color: 0xff0000 }]]));

    assert.equal(layer.pinRings.visible, false, 'rings hidden in 3D mode');
  });

  it('switching flat → on hides existing rings; on → flat reveals them', () => {
    const { layer } = makeLayer();
    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });
    layer.setPins(new Map([[1, { color: 0x00ff00 }]]));
    assert.equal(layer.pinRings.visible, true);

    layer.setMode({ tileElevation: 'on', hoverLift: 0.4 });
    assert.equal(layer.pinRings.visible, false, 'on mode hides rings');

    layer.setMode({ tileElevation: 'flat', hoverLift: 0 });
    assert.equal(layer.pinRings.visible, true, 'flat mode re-shows rings');
  });
});
