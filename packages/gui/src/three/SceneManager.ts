import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { CameraView } from '../controller/lod';
import { sceneModesEqual, type SceneMode } from './types';
import { easeInOutQuad } from './easing';

const BACKGROUND = 0x000000;
/** Constant Y used by the orthographic camera. Top-down view — the
 *  actual height doesn't matter visually (ortho is parallel), but we
 *  keep it fixed and high enough that any scene content is within
 *  near/far. Public to allow callers to position the scene knowing
 *  the camera's Y plane. */
const ORTHO_Y = 100;

/**
 * Subset of HexLayer used by SceneManager. Kept as a structural type
 * so tests can pass minimal stubs without pulling in the full layer
 * (which constructs InstancedMesh + shaders).
 */
interface HexLayerLike {
  setMode(mode: { tileElevation: 'on' | 'flat'; hoverLift: number }): void;
}

interface FlowLayerLike {
  setStyle(style: 'tube' | 'line'): void;
  setDensityCap(cap: number): void;
}

interface HullLayerLike {
  setStyle(style: 'line' | 'hidden'): void;
}

export interface AttachedLayers {
  hexLayer?: HexLayerLike;
  flowLayer?: FlowLayerLike;
  hullLayer?: HullLayerLike;
}

/**
 * Minimal renderer surface SceneManager needs outside the render pass
 * itself. Used as the type of an injected renderer for tests.
 */
interface MinimalRenderer {
  domElement: HTMLCanvasElement;
  setPixelRatio(ratio: number): void;
  setSize(w: number, h: number): void;
  setClearColor(color: number | THREE.Color): void;
  dispose(): void;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
}

export interface SceneManagerOptions {
  /**
   * Pre-built renderer to inject (for headless tests where no WebGL
   * context is available). When provided, SceneManager skips all
   * post-processing setup as well — the EffectComposer requires a real
   * GL context.
   */
  renderer?: MinimalRenderer;
}

export class SceneManager {
  renderer: MinimalRenderer;
  scene: THREE.Scene;
  /** Active camera. Widened to include OrthographicCamera because
   *  `setMode({projection:'orthographic'})` swaps the instance in. */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;

  private _container: HTMLElement | null;
  private _callbacks: ((dt: number) => void)[] = [];
  private _clock = new THREE.Clock();
  /** Render-on-demand: skip the render pass when nothing changed.
   *  Set true on user-driven camera change, layer mutation, fly tween,
   *  resize, etc. Cleared after a successful render. Without this flag
   *  the bloom composer ran 50-120ms per frame on a static scene,
   *  spending the budget for nothing. (DAI-22 stutter hunt.) */
  private _dirty = true;
  private _flyStart: THREE.Vector3 | null = null;
  private _flyTarget: THREE.Vector3 | null = null;
  private _flyProgress = 0;
  private _flyDuration = 0;
  /** Current active scene mode — `null` until `setMode` is called
   *  (preserving historical constructor behavior for call sites that
   *  never opt into the two-mode system). Stored as a defensive deep
   *  copy so caller mutations don't retroactively change "is this a
   *  no-op?" checks. */
  private _mode: SceneMode | null = null;
  /**
   * Half-height of the orthographic frustum currently applied, or 0 when
   * the active camera is perspective. Lets `onResize` preserve the
   * actual fitted extent (may differ from `SceneMode.frustumSize` when
   * the value was derived from the prior perspective distance).
   */
  private _orthoHalfExtent = 0;
  private _composer: EffectComposer | null;
  private _bloom: UnrealBloomPass | null;
  private _bloomEnabled = false;
  /** Layer handles — populated by `attachLayers`. `setMode` forwards
   *  its slice of SceneMode here, or silently skips when unattached. */
  private _layers: AttachedLayers = {};

  /** Toggle bloom post-processing on/off */
  setBloom(enabled: boolean) {
    this._bloomEnabled = enabled;
    if (this._bloom) this._bloom.enabled = enabled;
  }

  get bloomEnabled() { return this._bloomEnabled; }

  constructor(container: HTMLElement, options: SceneManagerOptions = {}) {
    this._container = container;

    // Renderer — optionally injected. When injected we skip post-processing
    // (EffectComposer needs a real WebGL context).
    if (options.renderer) {
      this.renderer = options.renderer;
    } else {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      r.setClearColor(BACKGROUND);
      r.setSize(container.clientWidth, container.clientHeight);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.0;
      container.appendChild(r.domElement);
      this.renderer = r;
    }

    // Scene
    this.scene = new THREE.Scene();
    // Fog tuned for large real-project graphs: at the prior 0.0006 density
    // a ~4000-unit extent is >90% fogged and content is invisible. Reduced
    // to effectively-off at this scale; a camera-distance-based fade is a
    // future improvement.
    this.scene.fog = new THREE.FogExp2(BACKGROUND, 0.00005);

    // Camera — far plane bumped from 5000 to 50000 to accommodate
    // real-project layouts. Initial position is a placeholder; Canvas
    // autofit immediately overwrites it.
    const perspective = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      50000,
    );
    perspective.position.set(0, 200, 200);
    this.camera = perspective;

    // Controls — maxDistance raised from 2000 to 20000 to allow zoom-out
    // past large-layout autofit distances.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxDistance = 20000;
    this.controls.minDistance = 5;
    this.controls.maxPolarAngle = Math.PI * 0.45;
    this.controls.screenSpacePanning = false;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    // Render-on-demand: any user-driven camera change marks the scene
    // dirty so `_animate` will run a single render pass next frame
    // instead of every frame.
    this.controls.addEventListener('change', () => { this._dirty = true; });
    this.controls.addEventListener('start', () => { this._dirty = true; });
    this.controls.addEventListener('end', () => { this._dirty = true; });

    // Post-processing: bloom — only when we own a real WebGLRenderer.
    // Stubbed renderers in tests can't create an EffectComposer.
    if (!options.renderer) {
      this._composer = new EffectComposer(this.renderer as unknown as THREE.WebGLRenderer);
      this._composer.addPass(new RenderPass(this.scene, this.camera));
      this._bloom = new UnrealBloomPass(
        new THREE.Vector2(container.clientWidth, container.clientHeight),
        0.4,   // strength
        0.5,   // radius (wider spread)
        0.6,   // threshold (lower = more things glow)
      );
      this._bloom.enabled = this._bloomEnabled;
      if (this._bloomEnabled) this._composer.addPass(this._bloom);
    } else {
      this._composer = null;
      this._bloom = null;
    }

    // Resize — only hook up ResizeObserver when we have a real browser
    // environment. Skipping in tests avoids holding the event loop open.
    if (!options.renderer && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.onResize(container.clientWidth, container.clientHeight));
      ro.observe(container);
    }

    // Start render loop (inert in tests that mock RAF).
    this._animate();
  }

  onRender(cb: (dt: number) => void) {
    this._callbacks.push(cb);
  }

  /** Mark the scene as needing a render. Call this from any layer
   *  that just mutated geometry / material / visibility. The next RAF
   *  tick will render once and clear the flag. Idempotent within a
   *  frame — multiple calls in the same tick coalesce. */
  requestRender(): void {
    this._dirty = true;
  }

  /**
   * Keep the render loop dirty for `durationMs` so a tween initiated
   * from a non-camera-event path (Zustand subscriber, pointer click,
   * lazy fetch completion, etc.) actually advances each frame.
   *
   * Without this pump the render-on-demand loop exits after a single
   * tick — `_dirty=false` — and any HexLayer / FlowLayer animateTo
   * stays frozen mid-interpolation. Call this once with the slowest
   * tween's duration (plus a small slack) right after pushing the
   * batch of `animateTo` calls.
   *
   * Coalesces overlapping calls — a second `pumpRender` while one is
   * already running cancels the previous handle and restarts with the
   * new duration. Safe to call from anywhere that has a SceneManager
   * reference; no-op once the duration elapses.
   */
  pumpRender(durationMs: number): void {
    const start = performance.now();
    if (this._pumpHandle !== null) cancelAnimationFrame(this._pumpHandle);
    const step = () => {
      this._dirty = true;
      if (performance.now() - start < durationMs) {
        this._pumpHandle = requestAnimationFrame(step);
      } else {
        this._pumpHandle = null;
      }
    };
    this._pumpHandle = requestAnimationFrame(step);
  }
  private _pumpHandle: number | null = null;

  /**
   * Register layer references so `setMode` can push its per-layer
   * slice (tile elevation, flow style, hull style) through to them.
   * Safe to call multiple times — later calls replace earlier ones.
   * Passing `undefined` for a specific layer detaches only that layer.
   *
   * Does not re-apply the current mode automatically — call `setMode`
   * explicitly after attaching to sync layer state. This keeps layer
   * wiring free of re-entrancy: construction doesn't force a mode
   * unless the caller asks for one.
   */
  attachLayers(layers: AttachedLayers): void {
    this._layers = { ...this._layers, ...layers };
    this._dirty = true;
  }

  /**
   * Apply a complete SceneMode. Idempotent via structural equality:
   * calling with the same values (even a fresh-but-equal object) is
   * a full no-op (no camera rebuild, no layer callbacks).
   *
   * Swap rules:
   *  - `projection` changes → fresh camera of the new kind, position
   *    and controls target copied across, OrbitControls re-bound.
   *  - Same projection → keep camera instance, update `up`, frustum
   *    fields, background, fog, and OrbitControls constraints in place.
   *
   * Layer forwarding: attached layers (see {@link attachLayers}) get
   * the relevant slice of SceneMode (HexLayer: tileElevation+hoverLift,
   * FlowLayer: flowStyle+flowDensityCap, HullLayer: hullStyle). If a
   * layer isn't attached the call silently skips — legacy call sites
   * that never attach layers are unaffected.
   */
  setMode(mode: SceneMode): void {
    if (this._mode && sceneModesEqual(this._mode, mode)) return;

    const prevProjection = this._mode?.projection ?? 'perspective';
    const projectionChanged = prevProjection !== mode.projection;

    // --- Camera swap / reconfigure -----------------------------------
    if (projectionChanged) {
      const aspect = this._aspect();
      const nextCamera = this._buildCameraForMode(mode, aspect);
      // Copy position from the outgoing camera so the view doesn't jump.
      nextCamera.position.copy(this.camera.position);
      // Ortho-specific: to get a true top-down view, the camera must sit
      // directly above the controls target. Copying the perspective
      // position verbatim leaves the ortho camera oblique (looking down
      // at 45°) and orthographic projection at that angle collapses the
      // layout into a thin band — what shipped in REG-1100 looked like
      // "tiles near-invisible" but was really tiles squeezed to a line.
      // Snap X/Z to the target and push Y up to ORTHO_Y so the camera
      // looks straight down at the ground plane. (DAI-21)
      if (nextCamera instanceof THREE.OrthographicCamera) {
        // Fit the ortho frustum so tiles appear the same apparent size
        // as they did in perspective. At fov=60° the visible half-height
        // at distance D is `D * tan(30°) ≈ D * 0.577`. DEFAULT_2D_MODE's
        // `frustumSize: 200` is a placeholder that only makes sense for
        // a perspective view with distance ~346 — for real layouts the
        // actual prior distance is what we need. Derive halfHeight from
        // it directly (overriding DEFAULT_2D_MODE.frustumSize) so 3D → 2D
        // preserves apparent tile size on every scene. The computed
        // value is persisted back into `mode.frustumSize` below so
        // `onResize` has a correct half-extent to preserve.
        let halfHeight = mode.frustumSize;
        if (this.camera instanceof THREE.PerspectiveCamera) {
          const dist = this.camera.position.distanceTo(this.controls.target);
          if (dist > 0) halfHeight = dist * 0.577;
        }
        this._applyOrthoFrustum(nextCamera, halfHeight, aspect);
        nextCamera.position.x = this.controls.target.x;
        nextCamera.position.z = this.controls.target.z;
        nextCamera.position.y = ORTHO_Y;
        // Stash the actually-applied half-extent so `onResize` preserves
        // it across container size changes. The declared
        // `DEFAULT_2D_MODE.frustumSize` (a placeholder 200) is not
        // authoritative once we derive halfHeight from the prior
        // perspective distance.
        this._orthoHalfExtent = halfHeight;
      } else {
        this._orthoHalfExtent = 0;
      }
      // Dispose old controls and rebuild against the new camera. OrbitControls
      // caches the camera reference internally, so we can't just swap it.
      const prevTarget = this.controls.target.clone();
      this.controls.dispose();
      this.camera = nextCamera;
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.target.copy(prevTarget);
      // RenderPass holds a camera reference too — rebuild it for post-processing.
      if (this._composer) {
        // Reset passes so the new RenderPass takes over cleanly.
        this._composer.passes.length = 0;
        this._composer.addPass(new RenderPass(this.scene, this.camera));
        if (this._bloom) this._composer.addPass(this._bloom);
      }
    } else {
      // Same projection — apply frustum / up updates on the existing camera.
      if (mode.projection === 'orthographic' && this.camera instanceof THREE.OrthographicCamera) {
        this._applyOrthoFrustum(this.camera, mode.frustumSize, this._aspect());
      }
    }

    this.camera.up.fromArray(mode.cameraUp);
    this.camera.updateProjectionMatrix();

    // --- Background, fog, lighting -----------------------------------
    this.scene.background = new THREE.Color(mode.background);
    if (mode.fog === 'linear') {
      // Tuned for typical world-space extents; the bloom pass on top
      // further softens distance in 3D. Values are intentionally gentle
      // so existing autofit distances stay readable.
      this.scene.fog = new THREE.Fog(mode.background, 200, 4000);
    } else {
      this.scene.fog = null;
    }

    // --- Bloom on 3D only --------------------------------------------
    // Bloom was tuned for the dark 3D background where a magenta tile
    // against near-black produces a crisp glow. Against the 2D white
    // background the same pass desaturates tiles to a pale wash (it
    // effectively adds a bright halo into every light-ish area). Turn
    // it off in 2D so tile colors stay readable.
    if (this._bloom) {
      const wantBloom = mode.kind === '3d' && this._bloomEnabled;
      this._bloom.enabled = wantBloom;
    }

    // --- OrbitControls constraints per mode --------------------------
    if (mode.kind === '2d') {
      this.controls.enableRotate = false;
      this.controls.enablePan = true;
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = 0; // pin top-down
      // Ortho's natural "up" is along -Z; pin the target to the ground plane.
      this.controls.target.y = 0;
    } else {
      this.controls.enableRotate = true;
      this.controls.enablePan = true;
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = Math.PI;
    }

    // --- Forward to attached layers ---------------------------------
    this._layers.hexLayer?.setMode({
      tileElevation: mode.tileElevation,
      hoverLift: mode.hoverLift,
    });
    this._layers.flowLayer?.setStyle(mode.flowStyle);
    this._layers.flowLayer?.setDensityCap(mode.flowDensityCap);
    this._layers.hullLayer?.setStyle(mode.hullStyle);

    // Store a defensive deep copy so future equality checks see the
    // snapshot we applied — not whatever the caller does with `mode`.
    this._mode = cloneSceneMode(mode);
  }

  /**
   * Camera-kind-aware view descriptor for LOD and any other logic that
   * needs to know "how zoomed in are we?". For perspective cameras this
   * returns the distance from camera to target; for orthographic cameras
   * it returns `zoom` and `frustumHeight` so callers can derive an
   * effective distance (`frustumHeight / zoom`).
   */
  getView(): CameraView {
    if (this.camera instanceof THREE.OrthographicCamera) {
      return {
        kind: 'orthographic',
        zoom: this.camera.zoom,
        frustumHeight: this.camera.top - this.camera.bottom,
      };
    }
    return {
      kind: 'perspective',
      distance: this.camera.position.distanceTo(this.controls.target),
    };
  }

  /**
   * @deprecated Use {@link getView} instead. This shim only works for
   * perspective cameras — throws for orthographic views where "distance"
   * is undefined.
   */
  getCameraDistance(): number {
    const view = this.getView();
    if (view.kind !== 'perspective') {
      throw new Error(
        'getCameraDistance() is only defined for perspective cameras; use getView() to handle both modes.',
      );
    }
    return view.distance;
  }

  /**
   * Animate the camera view toward the XZ target. Branches on the
   * active camera kind:
   *  - Perspective: the OrbitControls `target` lerps from its current
   *    value to `(x, 0, z)` over `duration` ms (legacy behavior).
   *  - Orthographic: the camera's `position.x` and `position.z` lerp
   *    to `(x, z)` while `position.y` (ORTHO_Y) stays fixed. Zoom is
   *    deliberately untouched — callers combine with a separate
   *    zoom control if they want.
   */
  flyTo(x: number, z: number, duration = 800) {
    if (this.camera instanceof THREE.OrthographicCamera) {
      // Ortho pan — animate camera.position; controls.target follows for
      // keyboard/mouse consistency but visually ortho doesn't need it.
      this._flyStart = this.camera.position.clone();
      this._flyTarget = new THREE.Vector3(x, this.camera.position.y, z);
    } else {
      this._flyStart = this.controls.target.clone();
      this._flyTarget = new THREE.Vector3(x, 0, z);
    }
    this._flyProgress = 0;
    this._flyDuration = duration / 1000;
  }

  private _disposed = false;

  dispose() {
    this._disposed = true;
    // Renderer's domElement.remove() is only present on real canvases.
    // Stubs usually noop or omit it — guard to stay safe in tests.
    const dom = this.renderer.domElement as HTMLCanvasElement & { remove?: () => void };
    dom.remove?.();
    this._composer?.dispose();
    this.renderer.dispose();
    this.controls.dispose();
  }

  /**
   * Handle viewport resize. Updates the camera projection and the
   * renderer / composer dimensions. Works for both camera kinds:
   *  - Perspective: updates `aspect`.
   *  - Orthographic: keeps the half-extent (frustumSize) constant and
   *    recomputes left/right/top/bottom from the new aspect.
   *
   * Public so tests can drive the resize path deterministically; the
   * production ResizeObserver also calls it.
   */
  onResize(w: number, h: number): void {
    if (this.camera instanceof THREE.OrthographicCamera) {
      // Prefer the actually-applied half-extent (see setMode). Fall back
      // to the declared mode value, then the current frustum half-height.
      const frustumSize = this._orthoHalfExtent > 0
        ? this._orthoHalfExtent
        : this._mode?.frustumSize ?? (this.camera.top - this.camera.bottom) / 2;
      this._applyOrthoFrustum(this.camera, frustumSize, w / h);
    } else {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.setSize(w, h);
    this._composer?.setSize(w, h);
    this._dirty = true;
  }

  // ── Internals ───────────────────────────────────────────────────

  private _aspect(): number {
    if (this._container) {
      return this._container.clientWidth / this._container.clientHeight;
    }
    return 1;
  }

  /** Build a fresh camera for the requested mode using the layout
   *  constants that previously lived inline in the constructor. Kept
   *  separate so setMode's camera-swap path doesn't duplicate them. */
  private _buildCameraForMode(
    mode: SceneMode,
    aspect: number,
  ): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    if (mode.projection === 'orthographic') {
      const cam = new THREE.OrthographicCamera();
      this._applyOrthoFrustum(cam, mode.frustumSize, aspect);
      cam.near = 0.1;
      cam.far = 50000;
      return cam;
    }
    const persp = new THREE.PerspectiveCamera(60, aspect, 0.1, 50000);
    return persp;
  }

  /** Apply an ortho camera's frustum from (halfExtent, aspect). The
   *  half-extent is the vertical half-height; horizontal scales by
   *  aspect so square content stays square. */
  private _applyOrthoFrustum(cam: THREE.OrthographicCamera, halfExtent: number, aspect: number): void {
    cam.left = -halfExtent * aspect;
    cam.right = halfExtent * aspect;
    cam.top = halfExtent;
    cam.bottom = -halfExtent;
    cam.updateProjectionMatrix();
  }

  /**
   * Advance the fly tween by `dt` seconds. Exposed (via underscore) so
   * unit tests can drive completion deterministically without spinning
   * up a render loop. Production calls it from `_animate` each frame.
   */
  private _tickFly(dt: number): void {
    if (!this._flyTarget || !this._flyStart) return;
    this._flyProgress += dt / this._flyDuration;
    if (this._flyProgress >= 1) {
      if (this.camera instanceof THREE.OrthographicCamera) {
        this.camera.position.copy(this._flyTarget);
      } else {
        this.controls.target.copy(this._flyTarget);
      }
      this._flyTarget = null;
      this._flyStart = null;
      return;
    }
    const t = easeInOutQuad(this._flyProgress);
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.camera.position.lerpVectors(this._flyStart, this._flyTarget, t);
    } else {
      this.controls.target.lerpVectors(this._flyStart, this._flyTarget, t);
    }
  }

  private _frameTimes: number[] = [];
  private _lastPerfFlush = performance.now();
  private _animate = () => {
    if (this._disposed) return;
    requestAnimationFrame(this._animate);
    const tStart = performance.now();
    const dt = this._clock.getDelta();
    // Active fly tween keeps the scene dirty until it lands.
    if (this._flyStart !== null) this._dirty = true;
    this._tickFly(dt);
    // controls.update() only triggers a 'change' event (→ dirty) while
    // damping inertia is decaying. After it stops, no event fires and
    // we naturally idle.
    this.controls.update();

    if (!this._dirty) return; // ←─ render-on-demand: skip the entire
                              //   callback + render pass when nothing
                              //   has changed. This is the single
                              //   biggest perf win on a static atlas:
                              //   bloom composer was eating 50-120ms
                              //   per idle frame.

    const tCallbacks = performance.now();
    let slowestCb = 0;
    let slowestIdx = -1;
    for (let i = 0; i < this._callbacks.length; i++) {
      const tCb = performance.now();
      this._callbacks[i](dt);
      const cbDt = performance.now() - tCb;
      if (cbDt > slowestCb) {
        slowestCb = cbDt;
        slowestIdx = i;
      }
    }
    const cbTotal = performance.now() - tCallbacks;

    let renderMs = 0;
    if (this._composer) {
      const tRender = performance.now();
      this._composer.render();
      renderMs = performance.now() - tRender;
    }
    this._dirty = false;

    const total = performance.now() - tStart;
    this._frameTimes.push(total);
    if (total > 16) {
      console.warn(
        `[perf] SceneManager._animate ${total.toFixed(1)}ms ` +
        `(callbacks ${cbTotal.toFixed(1)}ms slowest #${slowestIdx} ${slowestCb.toFixed(1)}ms, render ${renderMs.toFixed(1)}ms)`,
      );
    }
    if (tStart - this._lastPerfFlush > 1000) {
      if (this._frameTimes.length > 0) {
        const sorted = this._frameTimes.slice().sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const avg = sum / sorted.length;
        const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
        const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
        const max = sorted[sorted.length - 1] ?? 0;
        console.warn(
          `[perf] SceneManager ${sorted.length}fr/${((tStart - this._lastPerfFlush)/1000).toFixed(1)}s ` +
          `avg ${avg.toFixed(1)} p50 ${p50.toFixed(1)} p95 ${p95.toFixed(1)} p99 ${p99.toFixed(1)} max ${max.toFixed(1)}ms ` +
          `(${this._callbacks.length} cbs, bloom ${this._bloomEnabled ? 'ON' : 'OFF'})`,
        );
      }
      this._frameTimes = [];
      this._lastPerfFlush = tStart;
    }
  };
}

function cloneSceneMode(m: SceneMode): SceneMode {
  return {
    ...m,
    cameraUp: [m.cameraUp[0], m.cameraUp[1], m.cameraUp[2]],
  };
}

