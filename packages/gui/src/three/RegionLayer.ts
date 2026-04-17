import * as THREE from 'three';
import type { GraphNode, Region } from '../store/dataStore';
import { cubeToWorld } from '../store/loadFixture';

const CUBE_DIRS = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

/**
 * RegionLayer — fills the gap between hex tiles at region borders
 * with colored quads that follow hex edges exactly.
 */
export class RegionLayer {
  private _group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    scene.add(this._group);
  }

  build(nodes: GraphNode[], _regions: Region[]) {
    this._clear();

    const tileCoords = (globalThis as Record<string, unknown>).__grafemaTileCoords as Map<number, { q: number; r: number }> | undefined;
    const tileSize = ((globalThis as Record<string, unknown>).__grafemaTileSize as number) ?? 3.0;
    if (!tileCoords) return;

    // Build region membership
    const tileToRegion = new Map<string, string>();
    for (let i = 0; i < nodes.length; i++) {
      const coord = tileCoords.get(i);
      if (!coord) continue;
      tileToRegion.set(`${coord.q},${coord.r}`, nodes[i].region);
    }

    // Hex corner positions (flat-top)
    function hexCorner(q: number, r: number, cornerIdx: number) {
      const { x: cx, z: cz } = cubeToWorld(q, r, tileSize);
      const angle = (Math.PI / 3) * cornerIdx;
      return {
        x: cx + Math.cos(angle) * tileSize,
        z: cz + Math.sin(angle) * tileSize,
      };
    }

    // Inner corner (shrunk by tile gap) — at tileSize * 0.92
    const innerScale = 0.92;
    function innerCorner(q: number, r: number, cornerIdx: number) {
      const { x: cx, z: cz } = cubeToWorld(q, r, tileSize);
      const angle = (Math.PI / 3) * cornerIdx;
      return {
        x: cx + Math.cos(angle) * tileSize * innerScale,
        z: cz + Math.sin(angle) * tileSize * innerScale,
      };
    }

    // Collect border quads: for each border edge, create a quad
    // from inner edge of this tile to outer edge (full tileSize)
    const vertices: number[] = [];
    const borderY = 0.06;

    for (const [key, region] of tileToRegion) {
      const [q, r] = key.split(',').map(Number);

      for (let d = 0; d < 6; d++) {
        const nq = q + CUBE_DIRS[d].q;
        const nr = r + CUBE_DIRS[d].r;
        const nKey = `${nq},${nr}`;
        const neighborRegion = tileToRegion.get(nKey);

        // Border if neighbor is different region or empty
        if (neighborRegion === region) continue;

        // Quad: inner edge of this tile → outer edge (full hex corner)
        const ic1 = innerCorner(q, r, d);
        const ic2 = innerCorner(q, r, (d + 1) % 6);
        const oc1 = hexCorner(q, r, d);
        const oc2 = hexCorner(q, r, (d + 1) % 6);

        // Two triangles forming the quad
        vertices.push(
          ic1.x, borderY, ic1.z,
          oc1.x, borderY, oc1.z,
          ic2.x, borderY, ic2.z,

          ic2.x, borderY, ic2.z,
          oc1.x, borderY, oc1.z,
          oc2.x, borderY, oc2.z,
        );
      }
    }

    if (vertices.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

    const mat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this._group.add(new THREE.Mesh(geo, mat));
  }

  setVisible(v: boolean) {
    this._group.visible = v;
  }

  private _clear() {
    while (this._group.children.length) {
      const c = this._group.children[0];
      this._group.remove(c);
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
  }

  dispose() { this._clear(); }
}
