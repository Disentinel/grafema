/**
 * SceneManager — Three.js scene, camera, renderer, controls, render loop.
 *
 * Provides: perspective camera with OrbitControls (left-drag = pan,
 * right-drag = orbit, scroll = zoom), exponential fog, fly-to animation,
 * and a callback-based render loop.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BACKGROUND } from './constants.js';

export class SceneManager {
    constructor(container) {
        this.container = container;
        this.callbacks = [];
        this._clock = new THREE.Clock();
        this._flyTarget = null;
        this._flyStart = null;
        this._flyDuration = 1000;

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(BACKGROUND);
        container.appendChild(this.renderer.domElement);

        // Camera
        this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
        this.camera.position.set(0, 300, 200);
        this.camera.lookAt(0, 0, 0);

        // Scene
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(BACKGROUND, 0.0008);

        // Controls — left-drag = pan, right-drag = orbit (map-style navigation)
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;
        this.controls.maxDistance = 2000;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.PAN,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.ROTATE,
        };

        // WASD keyboard navigation (uses e.code for layout-independent physical keys)
        this._keys = {};
        this._onKeyDown = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            this._keys[e.code] = true;
        };
        this._onKeyUp = (e) => { this._keys[e.code] = false; };
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);

        // Resize
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
        this.resize();

        // Start render loop
        this._animate();
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    /** Register a callback invoked every frame: cb(dt, elapsedTime) */
    onRender(callback) {
        this.callbacks.push(callback);
    }

    /** Smoothly fly the camera to look at (x, z) on the ground plane */
    flyTo(x, z, duration = 1000) {
        this._flyTarget = new THREE.Vector3(x, 0, z);
        this._flyStartPos = this.camera.position.clone();
        this._flyStartTarget = this.controls.target.clone();
        this._flyEndPos = new THREE.Vector3(x, 40, z + 30);
        this._flyStart = performance.now();
        this._flyDuration = duration;
    }

    /** Distance from camera to orbit target */
    getCameraDistance() {
        return this.camera.position.distanceTo(this.controls.target);
    }

    _animate() {
        requestAnimationFrame(() => this._animate());

        // Fly-to animation (ease-in-out quad)
        if (this._flyTarget) {
            const t = Math.min((performance.now() - this._flyStart) / this._flyDuration, 1);
            const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
            this.camera.position.lerpVectors(this._flyStartPos, this._flyEndPos, ease);
            this.controls.target.lerpVectors(this._flyStartTarget, this._flyTarget, ease);
            if (t >= 1) this._flyTarget = null;
        }

        // WASD movement — camera-relative pan on XZ plane
        const speed = this.getCameraDistance() * 0.8;
        const dt0 = this._clock.getDelta();
        const move = speed * dt0;

        // Camera forward/right projected onto XZ plane
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        const delta = new THREE.Vector3();
        if (this._keys['KeyW'] || this._keys['ArrowUp'])    delta.addScaledVector(forward, move);
        if (this._keys['KeyS'] || this._keys['ArrowDown'])  delta.addScaledVector(forward, -move);
        if (this._keys['KeyA'] || this._keys['ArrowLeft'])  delta.addScaledVector(right, -move);
        if (this._keys['KeyD'] || this._keys['ArrowRight']) delta.addScaledVector(right, move);

        if (delta.lengthSq() > 0) {
            this.camera.position.add(delta);
            this.controls.target.add(delta);
        }

        // Q/E for zoom in/out
        if (this._keys['KeyQ']) {
            const dir = this.camera.position.clone().sub(this.controls.target).normalize();
            this.camera.position.addScaledVector(dir, move);
        }
        if (this._keys['KeyE']) {
            const dir = this.camera.position.clone().sub(this.controls.target).normalize();
            this.camera.position.addScaledVector(dir, -move);
        }

        this.controls.update();

        const dt = dt0;
        const elapsed = this._clock.elapsedTime;
        for (const cb of this.callbacks) cb(dt, elapsed);

        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        window.removeEventListener('resize', this._onResize);
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        this.renderer.dispose();
        this.controls.dispose();
    }
}
