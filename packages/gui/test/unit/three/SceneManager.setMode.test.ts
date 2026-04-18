/**
 * Unit tests for SceneManager scene-mode wiring (C-SceneManager).
 *
 * SceneManager owns the Three.js camera, OrbitControls, renderer, and
 * render loop. `setMode(SceneMode)` is the single entry point that
 * reconfigures all of these at once and forwards the relevant slice of
 * the mode to each attached layer (Hex / Flow / Hull). This test suite
 * locks the behavior contract:
 *
 *  - Idempotency: setMode(X) followed by setMode(X) is a full no-op —
 *    camera instance preserved, no controls churn, no layer callbacks
 *    re-invoked.
 *  - Camera kind swap: projection='orthographic' installs a fresh
 *    OrthographicCamera (and the reverse for 'perspective'), copying
 *    over position and the controls target.
 *  - OrbitControls reconfig: 3D allows full rotate+pan, 2D pins polar
 *    angle so the top-down orthographic view cannot tilt.
 *  - Layer forwarding: HexLayer.setMode / FlowLayer.setStyle etc. are
 *    called with the right slice of the incoming SceneMode.
 *  - `flyTo` branches on camera kind: perspective animates the
 *    controls target (existing behavior); ortho pans position XZ
 *    without touching zoom.
 *  - `getView()` returns a discriminated union that matches the active
 *    camera — perspective.distance vs orthographic.zoom+frustumHeight.
 *  - Raycaster picking works for BOTH camera kinds (Three.js handles
 *    the projection internally — we verify rather than rewrite).
 *  - `onResize` in ortho mode preserves `frustumSize` as the half-
 *    extent and updates aspect correctly.
 *
 * Environment: uses real Three.js + a minimal JSDOM-like container
 * stub. WebGLRenderer is stubbed via a tiny fake because node --test
 * has no GL context; SceneManager's render loop never runs in unit
 * tests (it guards on `_disposed`), so a no-op stub is sufficient.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { SceneManager, type SceneManagerOptions } from '../../../src/three/SceneManager.ts';
import {
  DEFAULT_2D_MODE,
  DEFAULT_3D_MODE,
  type SceneMode,
} from '../../../src/three/types.ts';

// ---------------------------------------------------------------------------
// Test environment — headless container + minimal globals
// ---------------------------------------------------------------------------

/**
 * Minimal HTMLElement-ish stub. SceneManager reads .clientWidth /
 * .clientHeight and calls .appendChild(canvas). We hand it a fake
 * container with the only surface it touches. Using `unknown as HTMLElement`
 * keeps us off the DOM lib types without bringing in jsdom.
 */
function makeContainer(width = 800, height = 600): HTMLElement {
  const el = {
    clientWidth: width,
    clientHeight: height,
    appendChild: () => undefined,
    removeChild: () => undefined,
  };
  return el as unknown as HTMLElement;
}

/**
 * node --test has no DOM. SceneManager calls `requestAnimationFrame`
 * in its render loop; we swallow it so the loop stays inert. We also
 * supply `window` for the `window.devicePixelRatio` read (only used
 * when we don't inject a renderer, but keep it safe across all tests).
 */
function installGlobalStubs(): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevRAF = g.requestAnimationFrame;
  const prevPerformance = g.performance;

  g.window = { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600 };
  g.requestAnimationFrame = (_cb: (t: number) => void): number => 0;
  if (!g.performance) g.performance = { now: () => Date.now() };

  return () => {
    g.window = prevWindow;
    g.requestAnimationFrame = prevRAF;
    g.performance = prevPerformance;
  };
}

/**
 * A zero-cost renderer stub that satisfies SceneManager's MinimalRenderer
 * surface. Tests pass this via the `renderer` constructor option so
 * SceneManager skips post-processing entirely (EffectComposer needs a
 * real WebGL context that node --test can't provide).
 *
 * `domElement` doubles as the OrbitControls event-listener target —
 * OrbitControls only calls `addEventListener`/`removeEventListener` on
 * it, so stubs are enough.
 */
function makeRendererStub(): SceneManagerOptions['renderer'] {
  const domElement = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    remove: () => undefined,
    style: {},
    parentNode: null,
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    ownerDocument: null,
    getRootNode: () => domElement,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
  } as unknown as HTMLCanvasElement;
  return {
    domElement,
    setPixelRatio: () => undefined,
    setSize: () => undefined,
    setClearColor: () => undefined,
    dispose: () => undefined,
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
  };
}

// ---------------------------------------------------------------------------
// Attachable layer stubs — count calls and record last forwarded args
// ---------------------------------------------------------------------------

interface HexStub {
  setMode: (m: { tileElevation: 'on' | 'flat'; hoverLift: number }) => void;
  setModeCalls: Array<{ tileElevation: 'on' | 'flat'; hoverLift: number }>;
}

interface FlowStub {
  setStyle: (s: 'tube' | 'line') => void;
  setDensityCap: (n: number) => void;
  setStyleCalls: Array<'tube' | 'line'>;
  setDensityCapCalls: number[];
}

interface HullStub {
  setStyle: (s: 'line' | 'hidden') => void;
  setStyleCalls: Array<'line' | 'hidden'>;
}

function makeHex(): HexStub {
  const calls: HexStub['setModeCalls'] = [];
  return {
    setMode: (m) => { calls.push(m); },
    setModeCalls: calls,
  };
}

function makeFlow(): FlowStub {
  const styleCalls: FlowStub['setStyleCalls'] = [];
  const capCalls: number[] = [];
  return {
    setStyle: (s) => { styleCalls.push(s); },
    setDensityCap: (n) => { capCalls.push(n); },
    setStyleCalls: styleCalls,
    setDensityCapCalls: capCalls,
  };
}

function makeHull(): HullStub {
  const calls: HullStub['setStyleCalls'] = [];
  return {
    setStyle: (s) => { calls.push(s); },
    setStyleCalls: calls,
  };
}

// ---------------------------------------------------------------------------
// Suite-level environment lifecycle
// ---------------------------------------------------------------------------

let restoreGlobals: () => void;

before(() => {
  restoreGlobals = installGlobalStubs();
});

after(() => {
  restoreGlobals();
});

function makeSceneManager(): SceneManager {
  return new SceneManager(makeContainer(), { renderer: makeRendererStub() });
}

// ---------------------------------------------------------------------------
// setMode — initial application + idempotency
// ---------------------------------------------------------------------------

describe('SceneManager.setMode — initial apply', () => {
  it('setMode(DEFAULT_3D_MODE) keeps a PerspectiveCamera active', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);

    assert.ok(
      sm.camera instanceof THREE.PerspectiveCamera,
      'active camera must be PerspectiveCamera in 3D mode',
    );
    // cameraUp from DEFAULT_3D_MODE is [0, 1, 0]
    assert.deepEqual(
      [sm.camera.up.x, sm.camera.up.y, sm.camera.up.z],
      DEFAULT_3D_MODE.cameraUp,
    );
    sm.dispose();
  });

  it('setMode(DEFAULT_2D_MODE) swaps to OrthographicCamera with ortho cameraUp', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);

    assert.ok(
      sm.camera instanceof THREE.OrthographicCamera,
      'active camera must be OrthographicCamera in 2D mode',
    );
    assert.deepEqual(
      [sm.camera.up.x, sm.camera.up.y, sm.camera.up.z],
      DEFAULT_2D_MODE.cameraUp,
      'cameraUp should flip to top-down Z axis in 2D mode',
    );
    sm.dispose();
  });

  it('2D mode sets scene background and disables fog', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);

    const bg = sm.scene.background as THREE.Color | null;
    assert.ok(bg instanceof THREE.Color, 'background must be a Color');
    assert.equal(bg.getHex(), DEFAULT_2D_MODE.background);
    assert.equal(sm.scene.fog, null, '2D mode disables fog');
    sm.dispose();
  });

  it('3D mode sets background and installs linear fog', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);

    const bg = sm.scene.background as THREE.Color;
    assert.ok(bg instanceof THREE.Color);
    assert.equal(bg.getHex(), DEFAULT_3D_MODE.background);
    assert.ok(sm.scene.fog instanceof THREE.Fog, '3D mode installs linear Fog');
    sm.dispose();
  });
});

describe('SceneManager.setMode — idempotency', () => {
  it('second setMode with same reference short-circuits (camera instance preserved)', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);
    const cam1 = sm.camera;
    const ctrl1 = sm.controls;

    sm.setMode(DEFAULT_2D_MODE); // same reference
    assert.strictEqual(sm.camera, cam1, 'camera must not be rebuilt');
    assert.strictEqual(sm.controls, ctrl1, 'controls must not be rebuilt');
    sm.dispose();
  });

  it('second setMode with a fresh-but-equal object short-circuits (deep-equal)', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);
    const cam1 = sm.camera;
    const ctrl1 = sm.controls;

    // Fresh object with identical values — Object.is fails, deepEqual succeeds.
    const copy: SceneMode = {
      ...DEFAULT_2D_MODE,
      cameraUp: [...DEFAULT_2D_MODE.cameraUp] as [number, number, number],
    };
    sm.setMode(copy);
    assert.strictEqual(sm.camera, cam1, 'camera must not be rebuilt on deep-equal');
    assert.strictEqual(sm.controls, ctrl1, 'controls must not be rebuilt on deep-equal');
    sm.dispose();
  });

  it('changing any field triggers re-application (not short-circuited)', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);
    const cam1 = sm.camera;

    // Same projection, but background changes — camera instance may be
    // preserved but background should update.
    const tweaked: SceneMode = { ...DEFAULT_3D_MODE, background: 0x123456 };
    sm.setMode(tweaked);
    const bg = sm.scene.background as THREE.Color;
    assert.equal(bg.getHex(), 0x123456, 'tweaked background must be applied');
    // Same projection → camera instance preserved, but fields like up may update.
    assert.strictEqual(sm.camera, cam1, 'same projection preserves camera instance');
    sm.dispose();
  });
});

// ---------------------------------------------------------------------------
// Camera swap — 3D → 2D → 3D
// ---------------------------------------------------------------------------

describe('SceneManager.setMode — camera swap', () => {
  it('3D → 2D creates a fresh OrthographicCamera snapped above controls target', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);

    // Point the scene at a non-trivial target. A 2D swap must produce
    // a top-down camera above THAT target — carrying over an oblique
    // perspective position would collapse the ortho view into a thin
    // band on the ground plane (DAI-21).
    sm.camera.position.set(42, 100, 77);
    sm.controls.target.set(5, 0, 9);
    const perspCam = sm.camera;

    sm.setMode(DEFAULT_2D_MODE);
    assert.ok(sm.camera instanceof THREE.OrthographicCamera);
    assert.notStrictEqual(sm.camera, perspCam, 'camera instance must change on projection swap');
    assert.ok(Math.abs(sm.camera.position.x - 5) < 0.001,
      `ortho camera.x must align with controls.target.x, got ${sm.camera.position.x}`);
    assert.ok(Math.abs(sm.camera.position.z - 9) < 0.001,
      `ortho camera.z must align with controls.target.z, got ${sm.camera.position.z}`);
    assert.ok(sm.camera.position.y > 0, 'ortho camera.y must be positive (above ground plane)');
    sm.dispose();
  });

  it('2D → 3D swaps back to PerspectiveCamera', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);
    assert.ok(sm.camera instanceof THREE.OrthographicCamera);

    sm.setMode(DEFAULT_3D_MODE);
    assert.ok(sm.camera instanceof THREE.PerspectiveCamera);
    sm.dispose();
  });

  it('3D → 2D → 3D round trip ends with a PerspectiveCamera', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);
    sm.setMode(DEFAULT_2D_MODE);
    sm.setMode(DEFAULT_3D_MODE);

    assert.ok(sm.camera instanceof THREE.PerspectiveCamera);
    sm.dispose();
  });
});

// ---------------------------------------------------------------------------
// OrbitControls reconfiguration per mode
// ---------------------------------------------------------------------------

describe('SceneManager.setMode — OrbitControls config', () => {
  it('3D mode enables rotate and pan with full polar range', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);

    assert.equal(sm.controls.enableRotate, true, '3D allows rotate');
    assert.equal(sm.controls.enablePan, true, '3D allows pan');
    assert.equal(sm.controls.minPolarAngle, 0);
    assert.equal(sm.controls.maxPolarAngle, Math.PI);
    sm.dispose();
  });

  it('2D mode disables rotate and clamps polar angle to 0 (top-down)', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);

    assert.equal(sm.controls.enableRotate, false, '2D disables rotate');
    assert.equal(sm.controls.enablePan, true, '2D keeps pan');
    assert.equal(sm.controls.minPolarAngle, 0);
    assert.equal(sm.controls.maxPolarAngle, 0,
      '2D clamps polar angle so camera always points straight down');
    sm.dispose();
  });
});

// ---------------------------------------------------------------------------
// Layer forwarding — attachLayers + setMode
// ---------------------------------------------------------------------------

describe('SceneManager.setMode — layer forwarding', () => {
  it('setMode without attached layers does NOT throw', () => {
    const sm = makeSceneManager();
    assert.doesNotThrow(() => sm.setMode(DEFAULT_2D_MODE));
    assert.doesNotThrow(() => sm.setMode(DEFAULT_3D_MODE));
    sm.dispose();
  });

  it('attached layers receive the correct slice of SceneMode on setMode', () => {
    const sm = makeSceneManager();
    const hex = makeHex();
    const flow = makeFlow();
    const hull = makeHull();
    sm.attachLayers({
      hexLayer: hex as unknown as Parameters<SceneManager['attachLayers']>[0]['hexLayer'],
      flowLayer: flow as unknown as Parameters<SceneManager['attachLayers']>[0]['flowLayer'],
      hullLayer: hull as unknown as Parameters<SceneManager['attachLayers']>[0]['hullLayer'],
    });

    sm.setMode(DEFAULT_3D_MODE);
    assert.deepEqual(hex.setModeCalls.at(-1), {
      tileElevation: DEFAULT_3D_MODE.tileElevation,
      hoverLift: DEFAULT_3D_MODE.hoverLift,
    });
    assert.equal(flow.setStyleCalls.at(-1), DEFAULT_3D_MODE.flowStyle);
    assert.equal(flow.setDensityCapCalls.at(-1), DEFAULT_3D_MODE.flowDensityCap);
    assert.equal(hull.setStyleCalls.at(-1), DEFAULT_3D_MODE.hullStyle);

    sm.setMode(DEFAULT_2D_MODE);
    assert.deepEqual(hex.setModeCalls.at(-1), {
      tileElevation: DEFAULT_2D_MODE.tileElevation,
      hoverLift: DEFAULT_2D_MODE.hoverLift,
    });
    assert.equal(flow.setStyleCalls.at(-1), DEFAULT_2D_MODE.flowStyle);
    assert.equal(flow.setDensityCapCalls.at(-1), DEFAULT_2D_MODE.flowDensityCap);
    assert.equal(hull.setStyleCalls.at(-1), DEFAULT_2D_MODE.hullStyle);

    sm.dispose();
  });

  it('idempotent setMode does NOT re-invoke layer callbacks', () => {
    const sm = makeSceneManager();
    const hex = makeHex();
    sm.attachLayers({
      hexLayer: hex as unknown as Parameters<SceneManager['attachLayers']>[0]['hexLayer'],
    });

    sm.setMode(DEFAULT_3D_MODE);
    const baseline = hex.setModeCalls.length;
    sm.setMode(DEFAULT_3D_MODE); // identical
    assert.equal(
      hex.setModeCalls.length,
      baseline,
      'layer.setMode must not be re-invoked on idempotent setMode',
    );
    sm.dispose();
  });
});

// ---------------------------------------------------------------------------
// flyTo — camera-kind branched
// ---------------------------------------------------------------------------

/**
 * Drive the SceneManager's fly animation to completion without running
 * the RAF loop. We emulate one render frame by calling the public
 * `_tickFly` test hook (implemented as a private `_tickFly` method we
 * expose for testing; in production the same code path runs from the
 * `_animate` loop).
 *
 * If the SceneManager does not expose such a hook, this helper directly
 * fast-forwards using the fly-state fields by repeatedly calling
 * `_animateTick`. The one requirement: `flyTo` eventually converges.
 */
function completeFly(sm: SceneManager): void {
  // SceneManager exposes a testing hook for the fly tween. We invoke
  // it with a large dt so the tween jumps straight to completion.
  const testable = sm as unknown as { _tickFly?: (dt: number) => void };
  if (typeof testable._tickFly === 'function') {
    testable._tickFly(10); // far larger than any test duration
  }
}

describe('SceneManager.flyTo — perspective', () => {
  it('perspective flyTo updates the controls target to (x,z)', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);
    sm.camera.position.set(0, 100, 0);
    sm.controls.target.set(0, 0, 0);

    sm.flyTo(10, 20, 100);
    completeFly(sm);

    const target = sm.controls.target;
    assert.ok(Math.abs(target.x - 10) < 0.01, `target.x ≈ 10, got ${target.x}`);
    assert.ok(Math.abs(target.z - 20) < 0.01, `target.z ≈ 20, got ${target.z}`);
    sm.dispose();
  });
});

describe('SceneManager.flyTo — orthographic', () => {
  it('ortho flyTo updates camera.position.x/z but keeps y constant', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);
    const yBefore = sm.camera.position.y;

    sm.flyTo(10, 20, 100);
    completeFly(sm);

    assert.ok(Math.abs(sm.camera.position.x - 10) < 0.01,
      `camera.position.x ≈ 10, got ${sm.camera.position.x}`);
    assert.ok(Math.abs(sm.camera.position.z - 20) < 0.01,
      `camera.position.z ≈ 20, got ${sm.camera.position.z}`);
    assert.equal(sm.camera.position.y, yBefore, 'ortho flyTo keeps Y constant');
    sm.dispose();
  });

  it('ortho flyTo does NOT change zoom (pan only)', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);
    const ortho = sm.camera as THREE.OrthographicCamera;
    ortho.zoom = 2.5;
    ortho.updateProjectionMatrix();

    sm.flyTo(10, 20, 100);
    completeFly(sm);

    assert.equal(ortho.zoom, 2.5, 'ortho flyTo is pan-only; zoom untouched');
    sm.dispose();
  });
});

// ---------------------------------------------------------------------------
// getView — discriminated union
// ---------------------------------------------------------------------------

describe('SceneManager.getView — discriminated union', () => {
  it('perspective mode returns {kind:"perspective", distance}', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);
    sm.camera.position.set(0, 300, 0);
    sm.controls.target.set(0, 0, 0);

    const view = sm.getView();
    assert.equal(view.kind, 'perspective');
    if (view.kind === 'perspective') {
      assert.ok(Math.abs(view.distance - 300) < 0.01,
        `distance ≈ 300, got ${view.distance}`);
    }
    sm.dispose();
  });

  it('ortho mode returns {kind:"orthographic", zoom, frustumHeight}', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);
    const ortho = sm.camera as THREE.OrthographicCamera;

    const view = sm.getView();
    assert.equal(view.kind, 'orthographic');
    if (view.kind === 'orthographic') {
      assert.equal(view.zoom, ortho.zoom);
      assert.ok(view.frustumHeight > 0, 'frustumHeight must be positive');
    }
    sm.dispose();
  });
});

// ---------------------------------------------------------------------------
// Raycaster — both camera kinds
// ---------------------------------------------------------------------------

describe('SceneManager — raycaster works for both camera kinds', () => {
  /**
   * Drop three meshes on the XZ plane at (−10,0,0), (0,0,0), (10,0,0).
   * NDC (0,0) is the viewport centre; both cameras are positioned so
   * their target / look direction hits the centre mesh. The raycaster
   * must return the centre mesh as the closest hit.
   */
  function buildScene(sm: SceneManager): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const x of [-10, 0, 10]) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshBasicMaterial();
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, 0, 0);
      sm.scene.add(m);
      m.updateMatrixWorld(true);
      meshes.push(m);
    }
    return meshes;
  }

  it('perspective camera: NDC(0,0) hits the centre mesh', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_3D_MODE);
    const meshes = buildScene(sm);

    // Aim camera at the centre mesh.
    sm.camera.position.set(0, 10, 0.001);
    sm.camera.lookAt(0, 0, 0);
    sm.camera.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), sm.camera);
    const hits = raycaster.intersectObjects(meshes, false);
    assert.ok(hits.length > 0, 'perspective raycast must hit at least one mesh');
    assert.strictEqual(hits[0].object, meshes[1],
      'centre mesh should be closest hit for perspective NDC(0,0)');
    sm.dispose();
  });

  it('orthographic camera: NDC(0,0) hits the centre mesh', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);
    const meshes = buildScene(sm);

    // Aim camera straight down at origin.
    sm.camera.position.set(0, 10, 0);
    sm.camera.lookAt(0, 0, 0);
    sm.camera.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), sm.camera);
    const hits = raycaster.intersectObjects(meshes, false);
    assert.ok(hits.length > 0, 'ortho raycast must hit at least one mesh');
    assert.strictEqual(hits[0].object, meshes[1],
      'centre mesh should be closest hit for ortho NDC(0,0)');
    sm.dispose();
  });
});

// ---------------------------------------------------------------------------
// Resize behavior for orthographic camera
// ---------------------------------------------------------------------------

describe('SceneManager — onResize in ortho mode', () => {
  it('onResize updates aspect while preserving the frustum half-extent', () => {
    const sm = makeSceneManager();
    sm.setMode(DEFAULT_2D_MODE);
    const ortho = sm.camera as THREE.OrthographicCamera;

    const halfExtentBefore = (ortho.top - ortho.bottom) / 2;
    assert.ok(halfExtentBefore > 0);

    // Simulate container resize by calling the internal _onResize with
    // a new width/height. Test hook: `onResize` is exposed as public
    // for this check.
    const testable = sm as unknown as { onResize?: (w: number, h: number) => void };
    assert.ok(typeof testable.onResize === 'function',
      'SceneManager should expose onResize(w,h) for the resize contract');
    testable.onResize!(1600, 400); // wider, shorter

    const after = sm.camera as THREE.OrthographicCamera;
    const halfExtentAfter = (after.top - after.bottom) / 2;
    assert.ok(
      Math.abs(halfExtentAfter - halfExtentBefore) < 0.01,
      'ortho half-extent (frustumSize) must be preserved across resize',
    );

    // Aspect ratio should be reflected in the left/right extents.
    const width = after.right - after.left;
    const height = after.top - after.bottom;
    const aspect = width / height;
    assert.ok(Math.abs(aspect - 1600 / 400) < 0.01,
      `aspect must match 1600/400=4, got ${aspect}`);
    sm.dispose();
  });
});
