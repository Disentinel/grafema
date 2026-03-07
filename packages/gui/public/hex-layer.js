/**
 * HexLayer — InstancedMesh wrapper for hex tile layers.
 *
 * Encapsulates: geometry, ShaderMaterial with per-instance opacity,
 * positioning, coloring, raycasting, highlight, animated opacity lerp.
 */
import * as THREE from 'three';

const VERT = `
  attribute float opacity;
  varying float vOpacity;
  varying vec3 vNormal;
  varying vec3 vInstanceColor;
  void main() {
    vOpacity = opacity;
    vInstanceColor = instanceColor;
    vNormal = normalMatrix * normal;
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;

const FRAG = `
  varying float vOpacity;
  varying vec3 vNormal;
  varying vec3 vInstanceColor;
  void main() {
    float light = max(dot(vNormal, vec3(0.0, 1.0, 0.0)), 0.3);
    vec3 c = vInstanceColor * (0.7 + light * 0.3);
    if (vOpacity < 0.01) discard;
    gl_FragColor = vec4(c, vOpacity);
  }
`;

function createHexGeometry(size) {
  const v = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 3 * i;
    v.push(Math.cos(a) * size, 0, Math.sin(a) * size);
  }
  const idx = [];
  for (let i = 0; i < 6; i++) idx.push(0, i + 1, ((i + 1) % 6) + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export class HexLayer {
  /**
   * @param {object} opts
   * @param {number} opts.count - number of hex instances
   * @param {number} opts.hexSize - hex radius (use tileSize for seamless, tileSize*0.92 for gapped)
   * @param {number} [opts.y=0] - Y position of this layer
   * @param {THREE.Scene} opts.scene - scene to add to
   */
  constructor({ count, hexSize, y = 0, scene }) {
    this.count = count;
    this.y = y;

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

    this._opacity = new Float32Array(count).fill(1.0);
    this._target = new Float32Array(count).fill(1.0);
    this._opacityAttr = new THREE.InstancedBufferAttribute(this._opacity, 1);
    geo.setAttribute('opacity', this._opacityAttr);

    this.worldX = new Float32Array(count);
    this.worldZ = new Float32Array(count);

    this._d = new THREE.Object3D();
    this._c = new THREE.Color();

    scene.add(this.mesh);
  }

  /** Set position + color for instance i */
  setTile(i, x, z, color) {
    this.worldX[i] = x;
    this.worldZ[i] = z;
    this._d.position.set(x, this.y, z);
    this._d.updateMatrix();
    this.mesh.setMatrixAt(i, this._d.matrix);
    if (typeof color === 'number') this._c.set(color);
    else this._c.copy(color);
    this.mesh.setColorAt(i, this._c);
  }

  /** Set color by HSL */
  setColorHSL(i, h, s, l) {
    this._c.setHSL(h, s, l);
    this.mesh.setColorAt(i, this._c);
  }

  /** Call after all setTile/setColorHSL calls */
  finalize() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Set target opacity for a single instance */
  setOpacity(i, value) {
    this._target[i] = value;
  }

  /** Set all target opacities at once */
  setAllOpacity(value) {
    this._target.fill(value);
  }

  /** Highlight: connected set gets 1.0, rest gets dimmed */
  highlight(connectedSet, bright = 1.0, dim = 0.25) {
    for (let i = 0; i < this.count; i++) {
      this._target[i] = connectedSet.has(i) ? bright : dim;
    }
  }

  /** Reset all opacities to 1.0 */
  resetOpacity() {
    this._target.fill(1.0);
  }

  get visible() { return this.mesh.visible; }
  set visible(v) { this.mesh.visible = v; }

  /** Raycast → instanceId or -1 */
  raycast(raycaster) {
    if (!this.mesh.visible) return -1;
    const hits = raycaster.intersectObject(this.mesh);
    return hits.length > 0 ? hits[0].instanceId : -1;
  }

  /** Lerp opacity toward target. Call in RAF. Returns true if still animating. */
  animate(factor = 0.08) {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      const diff = this._target[i] - this._opacity[i];
      if (Math.abs(diff) > 0.001) {
        this._opacity[i] += diff * factor;
        dirty = true;
      }
    }
    if (dirty) this._opacityAttr.needsUpdate = true;
    return dirty;
  }
}
