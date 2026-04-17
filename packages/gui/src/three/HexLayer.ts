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

    // Top-down lighting — keep colors vivid
    float light = max(dot(vNormal, vec3(0.0, 1.0, 0.0)), 0.4);
    vec3 baseColor = vInstanceColor * (0.6 + light * 0.3);

    // Subtle inner glow — brighter center, darker edges
    float dist = length(vLocalPos);
    float innerGlow = 1.0 - smoothstep(0.0, 0.9, dist);
    baseColor += vInstanceColor * innerGlow * 0.15;

    // Hex edge: subtle bright rim
    float rimGlow = smoothstep(0.75, 0.95, dist) * (1.0 - smoothstep(0.95, 1.0, dist));
    baseColor += vInstanceColor * rimGlow * 0.2;

    // Outline — bright enough for bloom, colored by outline color
    float hasOutline = step(0.001, vOutlineWidth);
    float edgeMix = smoothstep(1.0 - vOutlineWidth - 0.08, 1.0 - vOutlineWidth, dist);
    // Also add a soft glow halo around the outline (wider, softer)
    float haloMix = smoothstep(1.0 - vOutlineWidth - 0.25, 1.0 - vOutlineWidth - 0.08, dist);
    baseColor = mix(baseColor, baseColor + vOutlineColor * 0.5, haloMix * hasOutline);
    vec3 color = mix(baseColor, vOutlineColor * 3.0, edgeMix * hasOutline);

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
}

interface ColorTweenEntry {
  index: number;
  prop: 'color' | 'outlineColor';
  from: THREE.Color;
  to: THREE.Color;
  elapsed: number;
  duration: number;
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
    // Cancel existing tween for this (index, prop)
    for (let t = this._tweens.length - 1; t >= 0; t--) {
      if (this._tweens[t].index === i && this._tweens[t].prop === prop) {
        this._tweens.splice(t, 1);
      }
    }
    if (prop === 'elevation' && this._mode.tileElevation === 'flat') {
      // Flat mode: skip the tween entirely. Update the cache so a later
      // switch to 'on' mode will animate-in to this value, but keep the
      // rendered elevation clamped to 0 right now.
      this._elevationCache[i] = to;
      this._elevation[i] = 0;
      this._elevationAttr.needsUpdate = true;
      return;
    }
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

    // Scalar tweens
    for (let t = this._tweens.length - 1; t >= 0; t--) {
      const tw = this._tweens[t];
      tw.elapsed += dt;
      const progress = Math.min(tw.elapsed / tw.duration, 1);
      const eased = easeInOutQuad(progress);
      const arr = this._getArray(tw.prop);
      arr[tw.index] = tw.from + (tw.to - tw.from) * eased;
      if (tw.prop === 'elevation') {
        // Keep the cache in sync during/after the tween so later mode
        // toggles see the current logical value. The tween is only
        // queued in 'on' mode (flat mode short-circuits animateTo), so
        // any hoverLift contribution is subtracted out before caching.
        const hoverOffset = tw.index === this._hoveredIdx ? this._mode.hoverLift : 0;
        this._elevationCache[tw.index] = arr[tw.index] - hoverOffset;
      }
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
