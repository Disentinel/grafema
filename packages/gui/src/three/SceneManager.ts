import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BACKGROUND = 0x0a0e14;

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

  constructor(container: HTMLElement) {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BACKGROUND);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(BACKGROUND, 0.0008);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      5000,
    );
    this.camera.position.set(0, 200, 200);

    // Controls: left=pan, right=orbit (matches civ-map)
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

    // Resize
    const ro = new ResizeObserver(() => this._onResize(container));
    ro.observe(container);

    // Start render loop
    this._animate();
  }

  /** Register a callback to run each frame */
  onRender(cb: (dt: number) => void) {
    this._callbacks.push(cb);
  }

  /** Current camera distance to orbit target */
  getCameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Smooth fly-to animation */
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
    this.renderer.dispose();
    this.controls.dispose();
  }

  private _onResize(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private _animate = () => {
    if (this._disposed) return;
    requestAnimationFrame(this._animate);
    const dt = this._clock.getDelta();

    // Fly-to animation
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

    this.renderer.render(this.scene, this.camera);
  };
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
