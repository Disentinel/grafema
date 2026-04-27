/**
 * WallLayer — vertical "city walls" extruded along hull polygon edges.
 *
 * In City view (heightmap on) each region's hull outlines a cluster of
 * extruded hex columns. WallLayer renders a translucent wall along
 * every polygon edge from `y=0` up to `y=height` so packages read as
 * walled districts rather than free-floating column clusters.
 *
 * Geometry:
 *   - One quad per polygon edge (2 triangles).
 *   - All hulls merged into a single InstancedMesh-free BufferGeometry
 *     so the whole layer is a single draw call (~hundreds of regions
 *     × tens of edges each = a few thousand triangles).
 *
 * Lifecycle:
 *   - Built fresh on each `setHullPolygons(...)` call.
 *   - `setHeight(h)` rebuilds Y-coordinates only — geometry buffers are
 *     reused, just the top-vertex y values get overwritten.
 *   - Disposed on `dispose()`; reusable thereafter.
 *
 * Why a separate layer (not part of HullLayer):
 *   - HullLayer's group is lifted (`group.position.y = maxBase + 1`)
 *     so its outline rides on top of the columns. Walls need to span
 *     world `y=0..maxBase`, which is awkward to express inside a
 *     translated parent group.
 *   - Independent toggle path — Flat view keeps WallLayer disposed,
 *     City view rebuilds it without touching HullLayer.
 */

import * as THREE from 'three';
import type { HullLoop } from '../geom/hull';

const VERT = /* glsl */ `
  varying float vY;
  varying float vAlpha;
  uniform float uHeight;

  void main() {
    // position.y is 0 (bottom rim) or 1 (top rim) in geometry space;
    // scale to world height via uniform so we can re-tune without
    // rebuilding the buffer.
    vec3 wp = position;
    if (wp.y > 0.5) wp.y = uHeight;
    vY = wp.y;
    vAlpha = wp.y > 0.5 ? 1.0 : 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying float vY;
  varying float vAlpha;
  uniform float uHeight;
  uniform vec3 uColor;
  uniform float uOpacity;

  void main() {
    // Three layers compose the fence look:
    //   1. A dim body fading to near-zero at the bottom — keeps columns
    //      readable through the wall while still hinting at enclosure.
    //   2. A bright neon coping stripe in the top 8% — this is the
    //      "fence top" silhouette that reads as a clear boundary line
    //      from any zoom.
    //   3. A subtle vertical-bar texture (low frequency) so close-up
    //      reads as panels rather than blank glass.
    float t = clamp(vY / max(uHeight, 0.001), 0.0, 1.0);
    float bodyAlpha = uOpacity * pow(t, 1.2);
    float topStripe = smoothstep(0.88, 0.995, t);
    vec3 col = uColor * (0.6 + 2.0 * topStripe);
    float a = bodyAlpha + topStripe * 0.85;
    gl_FragColor = vec4(col, a);
  }
`;

export class WallLayer {
  readonly group: THREE.Group;
  private _scene: THREE.Scene;
  private _mesh: THREE.Mesh | null = null;
  private _material: THREE.ShaderMaterial;
  private _height: number = 1.0;

  constructor(scene: THREE.Scene, color: number = 0x66ddff) {
    this._scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'WallLayer';
    scene.add(this.group);

    this._material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHeight: { value: this._height },
        uColor: { value: new THREE.Color(color) },
        // Low base alpha — walls are an envelope, not a wall of paint.
        // Multiple hulls in nested regions stack visually; high opacity
        // turns the city into a blue cube. 0.18 keeps the gradient
        // legible without obscuring columns underneath.
        uOpacity: { value: 0.22 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /** Top y-coordinate the walls extrude to (world units). */
  setHeight(h: number): void {
    this._height = Math.max(0, h);
    this._material.uniforms.uHeight.value = this._height;
    this._material.uniformsNeedUpdate = true;
  }

  /**
   * Rebuild the wall geometry from a flat list of polygon loops. Each
   * loop is a closed Point2D[] (last point repeated). Multiple loops
   * across multiple regions are merged into one BufferGeometry so the
   * whole layer renders in a single draw call.
   *
   * Empty input clears the mesh (handy for Flat-mode teardown without
   * having to dispose the whole layer).
   */
  setHullPolygons(polygons: ReadonlyArray<readonly HullLoop[]>): void {
    if (this._mesh) {
      this.group.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._mesh = null;
    }
    if (polygons.length === 0) return;

    // Pre-count edges so we can size buffers once instead of growing.
    let edgeCount = 0;
    for (const loops of polygons) {
      for (const loop of loops) {
        if (loop.length >= 2) edgeCount += loop.length - 1;
      }
    }
    if (edgeCount === 0) return;

    const positions = new Float32Array(edgeCount * 4 * 3); // 4 verts/quad × xyz
    const indices = new Uint32Array(edgeCount * 6);        // 2 tris × 3 idx

    let vOff = 0;
    let iOff = 0;
    let vIdx = 0;
    for (const loops of polygons) {
      for (const loop of loops) {
        for (let i = 0; i < loop.length - 1; i++) {
          const a = loop[i];
          const b = loop[i + 1];
          // 4 verts per quad: A_bot, B_bot, B_top, A_top.
          // y values are 0 / 1 in geometry space — vertex shader scales
          // top to uHeight so live retune doesn't need a rebuild.
          positions[vOff++] = a.x; positions[vOff++] = 0; positions[vOff++] = a.y;
          positions[vOff++] = b.x; positions[vOff++] = 0; positions[vOff++] = b.y;
          positions[vOff++] = b.x; positions[vOff++] = 1; positions[vOff++] = b.y;
          positions[vOff++] = a.x; positions[vOff++] = 1; positions[vOff++] = a.y;
          // Two triangles, CCW from outside (winding handled by DoubleSide).
          indices[iOff++] = vIdx;     indices[iOff++] = vIdx + 1; indices[iOff++] = vIdx + 2;
          indices[iOff++] = vIdx;     indices[iOff++] = vIdx + 2; indices[iOff++] = vIdx + 3;
          vIdx += 4;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    this._mesh = new THREE.Mesh(geo, this._material);
    this._mesh.renderOrder = 1; // draw after hulls so the gradient blends
    this.group.add(this._mesh);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    if (this._mesh) {
      this.group.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._mesh = null;
    }
    this._material.dispose();
    this._scene.remove(this.group);
  }
}
