import * as THREE from 'three';

/**
 * HexLayer — InstancedMesh wrapper for hex tiles with animatable properties.
 *
 * Per-instance attributes:
 *   - color (vec3) — base tile color
 *   - opacity (float) — 0..1
 *   - elevation (float) — y-offset above ground plane
 *   - height (float) — tile extrusion thickness
 *   - scale (float) — uniform XZ scale multiplier
 *   - outlineColor (vec3) — ring color at hex edge
 *   - outlineWidth (float) — 0..1, fraction of hex radius
 */

const VERT = /* glsl */ `
  // Custom per-instance attributes (instanceMatrix + instanceColor injected by Three.js)
  attribute float aOpacity;
  attribute float aElevation;
  attribute float aScale;
  attribute vec3 aOutlineColor;
  attribute float aOutlineWidth;

  varying float vOpacity;
  varying vec3 vNormal;
  varying vec3 vInstanceColor;
  varying vec3 vOutlineColor;
  varying float vOutlineWidth;
  varying vec2 vLocalPos;

  void main() {
    vOpacity = aOpacity;
    vInstanceColor = instanceColor;
    vOutlineColor = aOutlineColor;
    vOutlineWidth = aOutlineWidth;
    vNormal = normalMatrix * normal;

    // Scale position within hex
    vec3 scaled = position * aScale;
    vLocalPos = scaled.xz;

    vec4 wp = instanceMatrix * vec4(scaled, 1.0);
    wp.y += aElevation;

    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  varying float vOpacity;
  varying vec3 vNormal;
  varying vec3 vInstanceColor;
  varying vec3 vOutlineColor;
  varying float vOutlineWidth;
  varying vec2 vLocalPos;

  void main() {
    if (vOpacity < 0.01) discard;

    // Top-down lighting
    float light = max(dot(vNormal, vec3(0.0, 1.0, 0.0)), 0.3);
    vec3 baseColor = vInstanceColor * (0.7 + light * 0.3);

    // Hex edge detection for outline (approximate via distance from center)
    float dist = length(vLocalPos);
    float edgeMix = smoothstep(1.0 - vOutlineWidth - 0.05, 1.0 - vOutlineWidth, dist);
    vec3 color = mix(baseColor, vOutlineColor, edgeMix * step(0.001, vOutlineWidth));

    gl_FragColor = vec4(color, vOpacity);
  }
`;

function createHexGeometry(size: number): THREE.BufferGeometry {
  const v: number[] = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    v.push(Math.cos(a) * size, 0, Math.sin(a) * size);
  }
  const idx: number[] = [];
  for (let i = 0; i < 6; i++) idx.push(0, i + 1, ((i + 1) % 6) + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export interface TileProps {
  color?: THREE.Color | number;
  opacity?: number;
  elevation?: number;
  scale?: number;
  outlineColor?: THREE.Color | number;
  outlineWidth?: number;
}

interface TweenEntry {
  index: number;
  prop: 'opacity' | 'elevation' | 'scale' | 'outlineWidth';
  from: number;
  to: number;
  elapsed: number;
  duration: number;
}

interface ColorTweenEntry {
  index: number;
  prop: 'color' | 'outlineColor';
  from: THREE.Color;
  to: THREE.Color;
  elapsed: number;
  duration: number;
}

export class HexLayer {
  mesh: THREE.InstancedMesh;
  count: number;

  /** World positions cache */
  worldX: Float32Array;
  worldZ: Float32Array;

  private _opacity: Float32Array;
  /** Elevation array — exposed so FlowLayer can read it directly */
  readonly elevationArray: Float32Array;
  private _elevation: Float32Array;
  private _scale: Float32Array;
  private _outlineColor: Float32Array;
  private _outlineWidth: Float32Array;

  private _opacityAttr: THREE.InstancedBufferAttribute;
  private _elevationAttr: THREE.InstancedBufferAttribute;
  private _scaleAttr: THREE.InstancedBufferAttribute;
  private _outlineColorAttr: THREE.InstancedBufferAttribute;
  private _outlineWidthAttr: THREE.InstancedBufferAttribute;

  private _dummy = new THREE.Object3D();
  private _tmpColor = new THREE.Color();

  private _tweens: TweenEntry[] = [];
  private _colorTweens: ColorTweenEntry[] = [];

  constructor(count: number, hexSize: number, scene: THREE.Scene) {
    this.count = count;

    const geo = createHexGeometry(hexSize);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.count = count;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Allocate per-instance attribute arrays
    this._opacity = new Float32Array(count).fill(1.0);
    this._elevation = new Float32Array(count).fill(0);
    this.elevationArray = this._elevation; // shared reference
    this._scale = new Float32Array(count).fill(1.0);
    this._outlineColor = new Float32Array(count * 3).fill(0);
    this._outlineWidth = new Float32Array(count).fill(0);

    this._opacityAttr = new THREE.InstancedBufferAttribute(this._opacity, 1);
    this._elevationAttr = new THREE.InstancedBufferAttribute(this._elevation, 1);
    this._scaleAttr = new THREE.InstancedBufferAttribute(this._scale, 1);
    this._outlineColorAttr = new THREE.InstancedBufferAttribute(this._outlineColor, 3);
    this._outlineWidthAttr = new THREE.InstancedBufferAttribute(this._outlineWidth, 1);

    geo.setAttribute('aOpacity', this._opacityAttr);
    geo.setAttribute('aElevation', this._elevationAttr);
    geo.setAttribute('aScale', this._scaleAttr);
    geo.setAttribute('aOutlineColor', this._outlineColorAttr);
    geo.setAttribute('aOutlineWidth', this._outlineWidthAttr);

    this.worldX = new Float32Array(count);
    this.worldZ = new Float32Array(count);

    scene.add(this.mesh);
  }

  /** Place tile at world position with initial color */
  setTile(i: number, x: number, z: number, color: number | THREE.Color) {
    this.worldX[i] = x;
    this.worldZ[i] = z;
    this._dummy.position.set(x, 0, z);
    this._dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this._dummy.matrix);

    if (typeof color === 'number') this._tmpColor.set(color);
    else this._tmpColor.copy(color);
    this.mesh.setColorAt(i, this._tmpColor);
  }

  /** Set color by HSL */
  setColorHSL(i: number, h: number, s: number, l: number) {
    this._tmpColor.setHSL(h, s, l);
    this.mesh.setColorAt(i, this._tmpColor);
  }

  /** Set a scalar property immediately (no animation) */
  setProperty(i: number, prop: 'opacity' | 'elevation' | 'scale' | 'outlineWidth', value: number) {
    const arr = this._getArray(prop);
    arr[i] = value;
    this._getAttr(prop).needsUpdate = true;
  }

  /** Set outline color immediately */
  setOutlineColor(i: number, color: number | THREE.Color) {
    if (typeof color === 'number') this._tmpColor.set(color);
    else this._tmpColor.copy(color);
    this._outlineColor[i * 3] = this._tmpColor.r;
    this._outlineColor[i * 3 + 1] = this._tmpColor.g;
    this._outlineColor[i * 3 + 2] = this._tmpColor.b;
    this._outlineColorAttr.needsUpdate = true;
  }

  /** Animate a scalar property to target over duration (ms) */
  animateTo(i: number, prop: 'opacity' | 'elevation' | 'scale' | 'outlineWidth', to: number, duration: number) {
    const arr = this._getArray(prop);
    this._tweens.push({ index: i, prop, from: arr[i], to, elapsed: 0, duration: duration / 1000 });
  }

  /** Animate color for tile i */
  animateColor(i: number, prop: 'color' | 'outlineColor', to: THREE.Color | number, duration: number) {
    const toColor = typeof to === 'number' ? new THREE.Color(to) : to.clone();
    const fromColor = new THREE.Color();
    if (prop === 'color') {
      this.mesh.getColorAt(i, fromColor);
    } else {
      fromColor.setRGB(
        this._outlineColor[i * 3],
        this._outlineColor[i * 3 + 1],
        this._outlineColor[i * 3 + 2],
      );
    }
    this._colorTweens.push({ index: i, prop, from: fromColor, to: toColor, elapsed: 0, duration: duration / 1000 });
  }

  /** Must call after all setTile() calls */
  finalize() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this._opacityAttr.needsUpdate = true;
    this._elevationAttr.needsUpdate = true;
    this._scaleAttr.needsUpdate = true;
    this._outlineColorAttr.needsUpdate = true;
    this._outlineWidthAttr.needsUpdate = true;
  }

  /** Raycast → instanceId or -1 */
  raycast(raycaster: THREE.Raycaster): number {
    if (!this.mesh.visible) return -1;
    const hits = raycaster.intersectObject(this.mesh);
    return hits.length > 0 ? hits[0].instanceId! : -1;
  }

  /** Tick animations. Call in render loop. */
  tick(dt: number) {
    let dirty = false;

    // Scalar tweens
    for (let t = this._tweens.length - 1; t >= 0; t--) {
      const tw = this._tweens[t];
      tw.elapsed += dt;
      const progress = Math.min(tw.elapsed / tw.duration, 1);
      const eased = easeInOutQuad(progress);
      const arr = this._getArray(tw.prop);
      arr[tw.index] = tw.from + (tw.to - tw.from) * eased;
      dirty = true;
      if (progress >= 1) this._tweens.splice(t, 1);
    }

    // Color tweens
    for (let t = this._colorTweens.length - 1; t >= 0; t--) {
      const tw = this._colorTweens[t];
      tw.elapsed += dt;
      const progress = Math.min(tw.elapsed / tw.duration, 1);
      const eased = easeInOutQuad(progress);
      this._tmpColor.lerpColors(tw.from, tw.to, eased);

      if (tw.prop === 'color') {
        this.mesh.setColorAt(tw.index, this._tmpColor);
      } else {
        this._outlineColor[tw.index * 3] = this._tmpColor.r;
        this._outlineColor[tw.index * 3 + 1] = this._tmpColor.g;
        this._outlineColor[tw.index * 3 + 2] = this._tmpColor.b;
      }
      dirty = true;
      if (progress >= 1) this._colorTweens.splice(t, 1);
    }

    if (dirty) {
      this._opacityAttr.needsUpdate = true;
      this._elevationAttr.needsUpdate = true;
      this._scaleAttr.needsUpdate = true;
      this._outlineColorAttr.needsUpdate = true;
      this._outlineWidthAttr.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  private _getArray(prop: 'opacity' | 'elevation' | 'scale' | 'outlineWidth'): Float32Array {
    switch (prop) {
      case 'opacity': return this._opacity;
      case 'elevation': return this._elevation;
      case 'scale': return this._scale;
      case 'outlineWidth': return this._outlineWidth;
    }
  }

  private _getAttr(prop: 'opacity' | 'elevation' | 'scale' | 'outlineWidth'): THREE.InstancedBufferAttribute {
    switch (prop) {
      case 'opacity': return this._opacityAttr;
      case 'elevation': return this._elevationAttr;
      case 'scale': return this._scaleAttr;
      case 'outlineWidth': return this._outlineWidthAttr;
    }
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
