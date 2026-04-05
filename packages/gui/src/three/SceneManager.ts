import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const BACKGROUND = 0x000000;

export class SceneManager {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  private _callbacks: ((dt: number) => void)[] = [];
  private _clock = new THREE.Clock();
  private _flyTarget: THREE.Vector3 | null = null;
  private _flyStart: THREE.Vector3 | null = null;
  private _flyProgress = 0;
  private _flyDuration = 0;
  private _composer: EffectComposer;
  private _bloom: UnrealBloomPass;
  private _bloomEnabled = true;

  /** Toggle bloom post-processing on/off */
  setBloom(enabled: boolean) {
    this._bloomEnabled = enabled;
    this._bloom.enabled = enabled;
  }

  get bloomEnabled() { return this._bloomEnabled; }

  constructor(container: HTMLElement) {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BACKGROUND);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(BACKGROUND, 0.0006);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      5000,
    );
    this.camera.position.set(0, 200, 200);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxDistance = 2000;
    this.controls.minDistance = 5;
    this.controls.maxPolarAngle = Math.PI * 0.45;
    this.controls.screenSpacePanning = false;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };

    // Post-processing: bloom
    this._composer = new EffectComposer(this.renderer);
    this._composer.addPass(new RenderPass(this.scene, this.camera));

    this._bloom = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.15,  // strength (subtle — ~20% of default)
      0.3,   // radius
      0.9,   // threshold (higher = only bright things bloom)
    );
    this._composer.addPass(this._bloom);

    // Resize
    const ro = new ResizeObserver(() => this._onResize(container));
    ro.observe(container);

    // Start render loop
    this._animate();
  }

  onRender(cb: (dt: number) => void) {
    this._callbacks.push(cb);
  }

  getCameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  flyTo(x: number, z: number, duration = 800) {
    this._flyStart = this.controls.target.clone();
    this._flyTarget = new THREE.Vector3(x, 0, z);
    this._flyProgress = 0;
    this._flyDuration = duration / 1000;
  }

  private _disposed = false;

  dispose() {
    this._disposed = true;
    this.renderer.domElement.remove();
    this._composer.dispose();
    this.renderer.dispose();
    this.controls.dispose();
  }

  private _onResize(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this._composer.setSize(w, h);
  }

  private _animate = () => {
    if (this._disposed) return;
    requestAnimationFrame(this._animate);
    const dt = this._clock.getDelta();

    if (this._flyTarget && this._flyStart) {
      this._flyProgress += dt / this._flyDuration;
      if (this._flyProgress >= 1) {
        this.controls.target.copy(this._flyTarget);
        this._flyTarget = null;
        this._flyStart = null;
      } else {
        const t = easeInOutQuad(this._flyProgress);
        this.controls.target.lerpVectors(this._flyStart, this._flyTarget, t);
      }
    }

    this.controls.update();
    for (const cb of this._callbacks) cb(dt);

    // Render with bloom
    this._composer.render();
  };
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
