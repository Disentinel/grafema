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
  private _composer: EffectComposer | null;
  private _bloom: UnrealBloomPass | null;
  private _bloomEnabled = true;
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
      this._composer.addPass(this._bloom);
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
      // Ortho-specific: top-down requires a positive Y. If we're swapping
      // into ortho and the prior camera's Y was <= 0 (shouldn't happen in
      // practice but guard it), hoist it up.
      if (nextCamera instanceof THREE.OrthographicCamera && nextCamera.position.y <= 0) {
        nextCamera.position.y = ORTHO_Y;
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
      const frustumSize = this._mode?.frustumSize ?? (this.camera.top - this.camera.bottom) / 2;
      this._applyOrthoFrustum(this.camera, frustumSize, w / h);
    } else {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.setSize(w, h);
    this._composer?.setSize(w, h);
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

  private _animate = () => {
    if (this._disposed) return;
    requestAnimationFrame(this._animate);
    const dt = this._clock.getDelta();
    this._tickFly(dt);

    this.controls.update();
    for (const cb of this._callbacks) cb(dt);

    // Render — prefer the composer (bloom) when available; otherwise
    // (injected renderer in tests) bail out, there's nothing to render.
    if (this._composer) {
      this._composer.render();
    }
  };
}

function cloneSceneMode(m: SceneMode): SceneMode {
  return {
    ...m,
    cameraUp: [m.cameraUp[0], m.cameraUp[1], m.cameraUp[2]],
  };
}

