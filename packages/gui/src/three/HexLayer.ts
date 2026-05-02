import * as THREE from 'three';
import { easeInOutQuad } from './easing';

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
  // Per-vertex (not per-instance) — 0 for bottom rim/center of the prism,
  // 1 for the top. Geometry now extrudes a hex column from y=0 to y=1
  // unscaled; the vertex shader stretches the top up to aElevation so
  // the tile renders as a tower rather than a floating disc.
  attribute float aIsTop;

  varying float vOpacity;
  varying vec3 vNormal;
  varying vec3 vInstanceColor;
  varying vec3 vOutlineColor;
  varying float vOutlineWidth;
  varying vec2 vLocalPos;
  varying float vIsTop;

  void main() {
    vOpacity = aOpacity;
    vInstanceColor = instanceColor;
    vOutlineColor = aOutlineColor;
    vOutlineWidth = aOutlineWidth;
    vNormal = normalMatrix * normal;
    vIsTop = aIsTop;

    // Scale XZ only — Y stays at the geometry's 0/1 so aElevation alone
    // controls column height. Scaling Y too would cause a degree-0 tile
    // (aScale=1, aElevation=0) to collapse correctly, but a pinned tile
    // (aScale=1.15) would be subtly taller, which we don't want.
    vec3 scaled = vec3(position.x * aScale, position.y, position.z * aScale);
    vLocalPos = scaled.xz;

    vec4 wp = instanceMatrix * vec4(scaled, 1.0);
    wp.y += aIsTop * aElevation;

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
  varying float vIsTop;

  void main() {
    if (vOpacity < 0.01) discard;

    // Top-down lighting — sides receive less than tops by design (the
    // up-facing dot product collapses on vertical walls), so columns
    // get free shading without a separate side material.
    float light = max(dot(vNormal, vec3(0.0, 1.0, 0.0)), 0.4);
    vec3 baseColor = vInstanceColor * (0.6 + light * 0.3);

    // Glow + rim are XZ-radial — they should only paint the top face.
    // On side walls vLocalPos sits at corner radius (≈ size) which would
    // trigger the rim everywhere; gate by vIsTop so sides stay flat.
    float dist = length(vLocalPos);
    float innerGlow = (1.0 - smoothstep(0.0, 0.9, dist)) * vIsTop;
    baseColor += vInstanceColor * innerGlow * 0.15;

    float rimGlow = smoothstep(0.75, 0.95, dist) * (1.0 - smoothstep(0.95, 1.0, dist)) * vIsTop;
    baseColor += vInstanceColor * rimGlow * 0.2;

    // Outline (top face only — bottom is hidden, sides shade themselves).
    float hasOutline = step(0.001, vOutlineWidth) * vIsTop;
    float edgeMix = smoothstep(1.0 - vOutlineWidth - 0.08, 1.0 - vOutlineWidth, dist);
    float haloMix = smoothstep(1.0 - vOutlineWidth - 0.25, 1.0 - vOutlineWidth - 0.08, dist);
    baseColor = mix(baseColor, baseColor + vOutlineColor * 0.5, haloMix * hasOutline);
    vec3 color = mix(baseColor, vOutlineColor * 3.0, edgeMix * hasOutline);

    gl_FragColor = vec4(color, vOpacity);
  }
`;

function createHexGeometry(size: number): THREE.BufferGeometry {
  // Hex prism — bottom hex at y=0, top hex at y=1. Vertex shader scales
  // the top up to aElevation per instance, so geometry can stay as a
  // single shared unit-height prism. Bottom face is omitted (never seen
  // from above, saves 6 triangles × 28k tiles per draw).
  //
  //   verts: 0     = bottom center
  //          1..6  = bottom corners (CCW)
  //          7     = top center
  //          8..13 = top corners (CCW, same angles as bottom)
  const v: number[] = [];
  const isTop: number[] = [];
  // Bottom center + corners
  v.push(0, 0, 0); isTop.push(0);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    v.push(Math.cos(a) * size, 0, Math.sin(a) * size); isTop.push(0);
  }
  // Top center + corners
  v.push(0, 1, 0); isTop.push(1);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    v.push(Math.cos(a) * size, 1, Math.sin(a) * size); isTop.push(1);
  }

  const idx: number[] = [];
  // Top face — winding viewed from +Y so normals point up after computeVertexNormals
  for (let i = 0; i < 6; i++) {
    idx.push(7, 8 + i, 8 + ((i + 1) % 6));
  }
  // Side walls — 6 quads (2 tris each), outward winding
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6;
    const bL = 1 + i;
    const bR = 1 + next;
    const tL = 8 + i;
    const tR = 8 + next;
    idx.push(bL, tR, tL);
    idx.push(bL, bR, tR);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setAttribute('aIsTop', new THREE.Float32BufferAttribute(isTop, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build a thin hex ring (annulus) as a triangle strip for the pin overlay.
 * Used in 2D mode where elevation is disabled and pins need a flat visual
 * marker. Produced as one flat quad-ring so a single InstancedMesh can
 * stamp one ring per pinned tile in a single draw call.
 */
function createHexRingGeometry(size: number, thickness: number): THREE.BufferGeometry {
  const innerR = size;
  const outerR = size + thickness;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    verts.push(cx * innerR, 0, cz * innerR); // inner vertex (2*i)
    verts.push(cx * outerR, 0, cz * outerR); // outer vertex (2*i + 1)
  }
  // Two triangles per side, 6 sides → 12 triangles total.
  for (let i = 0; i < 6; i++) {
    const i0 = 2 * i;
    const i1 = 2 * i + 1;
    const i2 = 2 * ((i + 1) % 6);
    const i3 = 2 * ((i + 1) % 6) + 1;
    idx.push(i0, i1, i3, i0, i3, i2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
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
  cancelled: boolean;
}

interface ColorTweenEntry {
  index: number;
  prop: 'color' | 'outlineColor';
  from: THREE.Color;
  to: THREE.Color;
  elapsed: number;
  duration: number;
  cancelled: boolean;
}

/**
 * Mode options that HexLayer cares about — a subset of `SceneMode`.
 * The full `SceneMode` lives in `./types.ts`; this interface is kept
 * local so HexLayer does not depend on orthogonal camera/flow/label
 * settings. SceneManager will pass through only these fields.
 */
export interface HexLayerModeInput {
  tileElevation: 'on' | 'flat';
  hoverLift: number;
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
  /**
   * Logical (requested) elevation per tile. In `'on'` mode this mirrors
   * `_elevation`; in `'flat'` mode `_elevation` is forced to 0 and this
   * cache keeps the requested value so toggling back to `'on'` restores
   * it without the caller having to replay setElevation / animateTo.
   */
  private _elevationCache: Float32Array;
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
  /** Index into `_tweens` by `${index}:${prop}` for O(1) cancellation.
   *  `animateTo` previously did a linear scan over all active tweens to
   *  evict the prior tween for the same (index, prop) — under heavy
   *  route-highlight bursts (DAI-22 Chunk-9 stutter hunt) the cost was
   *  ~100ms per applyRoutes call. Stays in sync via splice helper. */
  private _tweenKey: Map<string, number> = new Map();
  private _colorTweenKey: Map<string, number> = new Map();

  // Position lerp for progressive SA updates
  private _targetX: Float32Array | null = null;
  private _targetZ: Float32Array | null = null;
  private _lerpRate = 0.08; // exponential decay per frame

  // Scene-mode state
  private _mode: HexLayerModeInput = { tileElevation: 'on', hoverLift: 0 };
  private _hoveredIdx = -1;

  /**
   * Pin-ring overlay — a separate InstancedMesh that draws a flat ring
   * outline at the XZ of each pinned tile. Used in 2D ('flat') mode
   * where elevation can no longer signal pin status. Hidden in 3D mode
   * so the existing elevation + outline remains the sole pin visual.
   *
   * Sized to `count` (one ring per tile at most); we drive visibility by
   * writing the used prefix to `pinRings.count` so Three draws only the
   * populated instances. Cheaper than allocating per-pin LineSegments
   * and avoids any per-frame garbage from recreating line objects.
   */
  pinRings: THREE.InstancedMesh;
  private _pinRingOrder: number[] = []; // slot index → tile index

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
    // Disable frustum culling — InstancedMesh's per-instance frustum
    // check uses the geometry's bounding sphere (centered at the mesh
    // origin with radius ≈ hexSize). We don't recompute that sphere
    // after `setTile` populates instance matrices, so tiles far from
    // the mesh origin can be culled both for rendering AND for
    // raycaster.intersectObject — visible as "I see the tile but
    // hover gives me the hull tooltip below it". 28k tiles cost ~one
    // draw call regardless of culling so the perf hit is irrelevant.
    this.mesh.frustumCulled = false;

    // Allocate per-instance attribute arrays
    this._opacity = new Float32Array(count).fill(1.0);
    this._elevation = new Float32Array(count).fill(0);
    this.elevationArray = this._elevation; // shared reference
    this._elevationCache = new Float32Array(count).fill(0);
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

    // Pin-ring overlay. Shared across all pinned tiles; one draw call.
    // The ring is 5% larger than the hex radius so it reads as an
    // outline around the tile rather than occluding it. Y=0.02 places
    // it just above the tile face to avoid z-fighting.
    const ringGeo = createHexRingGeometry(hexSize * 1.025, hexSize * 0.06);
    const ringMat = new THREE.MeshBasicMaterial({
      vertexColors: false,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.pinRings = new THREE.InstancedMesh(ringGeo, ringMat, count);
    this.pinRings.count = 0; // nothing pinned yet
    this.pinRings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pinRings.visible = this._mode.tileElevation === 'flat';
    scene.add(this.pinRings);
  }

  /**
   * Switch the rendering mode used by this layer. Pass the relevant
   * slice of a `SceneMode`:
   *  - `tileElevation: 'on'`  — honor all elevation writes (3D default);
   *  - `tileElevation: 'flat'` — force rendered Y to 0 for every tile
   *    (2D default). `setProperty('elevation')` and `animateTo('elevation')`
   *    still update an internal cache so switching back to `'on'` restores
   *    the logical elevation without replaying animations.
   *  - `hoverLift` — extra Y offset applied to the hovered tile. 0
   *    disables the lift entirely (useful for 2D where hover is signalled
   *    by color/scale instead).
   *
   * Pin-ring visibility follows `tileElevation`: rings show in 'flat'
   * mode and hide in 'on' mode, since 3D uses elevation + outline as
   * the pin visual.
   *
   * NOTE: the full `SceneMode` contains many more fields (projection,
   * fog, flowStyle, …) that don't concern HexLayer; SceneManager is
   * expected to forward only these two. If more hex-specific knobs
   * appear later (e.g. per-mode outline intensity) they should extend
   * `HexLayerModeInput` and be applied here.
   */
  setMode(mode: HexLayerModeInput): void {
    const prev = this._mode;
    this._mode = { tileElevation: mode.tileElevation, hoverLift: mode.hoverLift };

    const switchingToFlat =
      prev.tileElevation === 'on' && mode.tileElevation === 'flat';
    const switchingToOn =
      prev.tileElevation === 'flat' && mode.tileElevation === 'on';

    if (switchingToFlat) {
      // Preserve the current rendered elevation back into the cache
      // (minus any active hover offset), then zero the rendered Y.
      for (let i = 0; i < this.count; i++) {
        const hoverOffset = i === this._hoveredIdx ? prev.hoverLift : 0;
        this._elevationCache[i] = this._elevation[i] - hoverOffset;
        this._elevation[i] = 0;
      }
      this._elevationAttr.needsUpdate = true;
    } else if (switchingToOn) {
      // Restore cached elevation + re-apply hover lift if any.
      for (let i = 0; i < this.count; i++) {
        const hoverOffset = i === this._hoveredIdx ? mode.hoverLift : 0;
        this._elevation[i] = this._elevationCache[i] + hoverOffset;
      }
      this._elevationAttr.needsUpdate = true;
    } else if (mode.tileElevation === 'on') {
      // Same mode but hoverLift may have changed — rebalance the
      // hovered tile's Y (other tiles unaffected).
      if (this._hoveredIdx >= 0) {
        this._elevation[this._hoveredIdx] =
          this._elevationCache[this._hoveredIdx] + mode.hoverLift;
        this._elevationAttr.needsUpdate = true;
      }
    }

    // Pin rings follow the 2D/3D split.
    this.pinRings.visible = mode.tileElevation === 'flat';
  }

  /**
   * Set the hovered tile. `-1` clears the hover. The previous hovered
   * tile's Y returns to its base (cached) elevation; the new hovered
   * tile's Y becomes base + hoverLift.
   *
   * In 'flat' mode base elevation is always 0, so this effectively sets
   * the hovered tile to `hoverLift`. With `hoverLift: 0` (2D default)
   * this is a no-op — callers should signal hover via color/scale.
   */
  setHovered(idx: number): void {
    if (idx === this._hoveredIdx) return;
    const lift = this._mode.hoverLift;

    // Drop the lift from the previously hovered tile.
    if (this._hoveredIdx >= 0 && this._hoveredIdx < this.count) {
      const base = this._mode.tileElevation === 'flat'
        ? 0
        : this._elevationCache[this._hoveredIdx];
      this._elevation[this._hoveredIdx] = base;
    }

    this._hoveredIdx = idx;

    if (idx >= 0 && idx < this.count && lift !== 0) {
      const base = this._mode.tileElevation === 'flat'
        ? 0
        : this._elevationCache[idx];
      this._elevation[idx] = base + lift;
    }

    this._elevationAttr.needsUpdate = true;
  }

  /**
   * Update the pin-ring overlay. The `pins` map is keyed by tile index;
   * each entry contributes one ring at the tile's XZ with the given
   * color. Pins not in the map are removed. In 3D mode the rings mesh
   * stays invisible regardless of this call, so `setPins` is safe to
   * invoke in both modes.
   *
   * Complexity: O(pins.size). Each ring writes one Matrix4 + one
   * Color to the instance buffers — both flagged as DynamicDraw so the
   * GPU sees the delta without re-uploading the whole buffer.
   */
  setPins(pins: Map<number, { color: number }>): void {
    const newCount = pins.size;
    if (newCount > this.count) {
      // Shouldn't happen (one ring per tile max) but guard anyway.
      throw new Error(
        `HexLayer.setPins: ${newCount} pins exceeds tile count ${this.count}`,
      );
    }

    this._pinRingOrder.length = 0;
    let slot = 0;
    const ringY = 0.02; // sit just above the tile face
    for (const [tileIdx, info] of pins) {
      if (tileIdx < 0 || tileIdx >= this.count) continue;
      this._pinRingOrder.push(tileIdx);
      this._dummy.position.set(this.worldX[tileIdx], ringY, this.worldZ[tileIdx]);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.scale.set(1, 1, 1);
      this._dummy.updateMatrix();
      this.pinRings.setMatrixAt(slot, this._dummy.matrix);
      this._tmpColor.set(info.color);
      this.pinRings.setColorAt(slot, this._tmpColor);
      slot++;
    }

    this.pinRings.count = slot;
    this.pinRings.instanceMatrix.needsUpdate = true;
    if (this.pinRings.instanceColor) this.pinRings.instanceColor.needsUpdate = true;
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
    if (prop === 'elevation') {
      // Elevation has a cache so mode toggles don't lose the logical value.
      // In 'flat' mode the rendered elevation stays 0 regardless of the
      // caller's request; the cache still records what they asked for.
      // In 'on' mode we additionally account for hoverLift on the active
      // hovered tile so setProperty does not overwrite the hover offset.
      this._elevationCache[i] = value;
      if (this._mode.tileElevation === 'flat') {
        this._elevation[i] = 0;
      } else {
        this._elevation[i] = value + (i === this._hoveredIdx ? this._mode.hoverLift : 0);
      }
      this._elevationAttr.needsUpdate = true;
      return;
    }
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

  /** Animate a scalar property to target over duration (ms). Cancels any existing tween for same (index, prop). */
  animateTo(i: number, prop: 'opacity' | 'elevation' | 'scale' | 'outlineWidth', to: number, duration: number) {
    const key = `${i}:${prop}`;
    const existingIdx = this._tweenKey.get(key);
    if (existingIdx !== undefined) {
      // Tombstone — actual array compaction happens in tick() so we
      // don't pay splice O(N) per cancel during burst routes.
      this._tweens[existingIdx].cancelled = true;
      this._tweenKey.delete(key);
    }
    if (prop === 'elevation' && this._mode.tileElevation === 'flat') {
      this._elevationCache[i] = to;
      this._elevation[i] = 0;
      this._elevationAttr.needsUpdate = true;
      return;
    }
    const arr = this._getArray(prop);
    this._tweens.push({ index: i, prop, from: arr[i], to, elapsed: 0, duration: duration / 1000, cancelled: false });
    this._tweenKey.set(key, this._tweens.length - 1);
  }

  /** Animate color for tile i */
  animateColor(i: number, prop: 'color' | 'outlineColor', to: THREE.Color | number, duration: number) {
    const key = `${i}:${prop}`;
    const existingIdx = this._colorTweenKey.get(key);
    if (existingIdx !== undefined) {
      this._colorTweens[existingIdx].cancelled = true;
      this._colorTweenKey.delete(key);
    }
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
    this._colorTweens.push({ index: i, prop, from: fromColor, to: toColor, elapsed: 0, duration: duration / 1000, cancelled: false });
    this._colorTweenKey.set(key, this._colorTweens.length - 1);
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
  /**
   * Set target positions for progressive SA layout.
   * Tiles will lerp toward these positions in tick().
   */
  setTargetPositions(targetX: Float32Array, targetZ: Float32Array) {
    this._targetX = targetX;
    this._targetZ = targetZ;
  }

  tick(dt: number) {
    let dirty = false;

    // Position lerp toward SA target positions
    if (this._targetX && this._targetZ) {
      const rate = this._lerpRate;
      let moved = 0;
      for (let i = 0; i < this.count; i++) {
        const dx = this._targetX[i] - this.worldX[i];
        const dz = this._targetZ[i] - this.worldZ[i];
        if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
          this.worldX[i] += dx * rate;
          this.worldZ[i] += dz * rate;
          this._dummy.position.set(this.worldX[i], 0, this.worldZ[i]);
          this._dummy.updateMatrix();
          this.mesh.setMatrixAt(i, this._dummy.matrix);
          moved++;
        }
      }
      if (moved > 0) {
        this.mesh.instanceMatrix.needsUpdate = true;
        dirty = true;
      }
      if (moved === 0) {
        // All tiles reached target — clear
        this._targetX = null;
        this._targetZ = null;
      }
    }

    // Scalar tweens — per-prop dirty so we only re-upload Float32Arrays
    // that actually changed. Compact in a single pass: live tweens copy
    // forward, cancelled/finished entries drop out. Avoids splice O(N²)
    // and avoids dirtying 5 attributes when only one moved. (DAI-22)
    let dirtyOpacity = false;
    let dirtyElevation = false;
    let dirtyScale = false;
    let dirtyOutlineWidth = false;
    let writeIdx = 0;
    for (let t = 0; t < this._tweens.length; t++) {
      const tw = this._tweens[t];
      if (tw.cancelled) continue;
      tw.elapsed += dt;
      const progress = Math.min(tw.elapsed / tw.duration, 1);
      const eased = easeInOutQuad(progress);
      const arr = this._getArray(tw.prop);
      arr[tw.index] = tw.from + (tw.to - tw.from) * eased;
      switch (tw.prop) {
        case 'elevation': {
          const hoverOffset = tw.index === this._hoveredIdx ? this._mode.hoverLift : 0;
          this._elevationCache[tw.index] = arr[tw.index] - hoverOffset;
          dirtyElevation = true;
          break;
        }
        case 'opacity': dirtyOpacity = true; break;
        case 'scale': dirtyScale = true; break;
        case 'outlineWidth': dirtyOutlineWidth = true; break;
      }
      dirty = true;
      if (progress >= 1) {
        this._tweenKey.delete(`${tw.index}:${tw.prop}`);
        continue; // drop from compacted array
      }
      if (writeIdx !== t) {
        this._tweens[writeIdx] = tw;
        this._tweenKey.set(`${tw.index}:${tw.prop}`, writeIdx);
      }
      writeIdx++;
    }
    if (writeIdx !== this._tweens.length) this._tweens.length = writeIdx;

    // Color tweens — same compaction strategy.
    let dirtyColor = false;
    let dirtyOutlineColor = false;
    let cWriteIdx = 0;
    for (let t = 0; t < this._colorTweens.length; t++) {
      const tw = this._colorTweens[t];
      if (tw.cancelled) continue;
      tw.elapsed += dt;
      const progress = Math.min(tw.elapsed / tw.duration, 1);
      const eased = easeInOutQuad(progress);
      this._tmpColor.lerpColors(tw.from, tw.to, eased);

      if (tw.prop === 'color') {
        this.mesh.setColorAt(tw.index, this._tmpColor);
        dirtyColor = true;
      } else {
        this._outlineColor[tw.index * 3] = this._tmpColor.r;
        this._outlineColor[tw.index * 3 + 1] = this._tmpColor.g;
        this._outlineColor[tw.index * 3 + 2] = this._tmpColor.b;
        dirtyOutlineColor = true;
      }
      dirty = true;
      if (progress >= 1) {
        this._colorTweenKey.delete(`${tw.index}:${tw.prop}`);
        continue;
      }
      if (cWriteIdx !== t) {
        this._colorTweens[cWriteIdx] = tw;
        this._colorTweenKey.set(`${tw.index}:${tw.prop}`, cWriteIdx);
      }
      cWriteIdx++;
    }
    if (cWriteIdx !== this._colorTweens.length) this._colorTweens.length = cWriteIdx;

    if (dirtyOpacity) this._opacityAttr.needsUpdate = true;
    if (dirtyElevation) this._elevationAttr.needsUpdate = true;
    if (dirtyScale) this._scaleAttr.needsUpdate = true;
    if (dirtyOutlineWidth) this._outlineWidthAttr.needsUpdate = true;
    if (dirtyOutlineColor) this._outlineColorAttr.needsUpdate = true;
    if (dirtyColor && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    void dirty;
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
