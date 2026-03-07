/**
 * EdgeRenderer — manages edge line rendering with visibility filters.
 *
 * Uses Line2/LineMaterial for thick, visible lines (WebGL LineBasicMaterial
 * is capped at 1px on most platforms).
 *
 * Supports: per-type visibility toggle, frustum culling,
 * hover mode (show only connected), camera-distance LOD.
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { EDGE_COLORS, DEFAULT_EDGE_COLOR, colorToVec3 } from './shared.js';

export class EdgeRenderer {
  /**
   * @param {object} opts
   * @param {number} [opts.maxEdges=500] - max visible edge segments
   * @param {number} [opts.y=0.3] - Y position of edges
   * @param {THREE.Scene} opts.scene
   * @param {number} [opts.opacity=0.8]
   * @param {number} [opts.brightness=2.0] - color multiplier
   * @param {number} [opts.linewidth=2] - line width in pixels
   */
  constructor({ maxEdges = 500, y = 0.3, scene, opacity = 0.8, brightness = 2.0, linewidth = 2 }) {
    this.maxEdges = maxEdges;
    this.y = y;
    this.brightness = brightness;

    this._positions = new Float32Array(maxEdges * 6);
    this._colors = new Float32Array(maxEdges * 6);

    this._geo = new LineSegmentsGeometry();
    this._mat = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      depthWrite: false,
      linewidth,
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });

    this.lines = new LineSegments2(this._geo, this._mat);
    this.lines.visible = false;
    scene.add(this.lines);
  }

  /** Update opacity (0..1) */
  setOpacity(v) { this._mat.opacity = v; }

  /** Update brightness multiplier (colors are multiplied by this) */
  setBrightness(v) { this.brightness = v; }

  /** Update line width in pixels */
  setLinewidth(v) { this._mat.linewidth = v; }

  /** Update max visible edges (reallocates buffers + geometry) */
  setMaxEdges(v) {
    this.maxEdges = v;
    this._positions = new Float32Array(v * 6);
    this._colors = new Float32Array(v * 6);
    this._geo.dispose();
    this._geo = new LineSegmentsGeometry();
    this.lines.geometry = this._geo;
  }

  /** Call on window resize */
  updateResolution(w, h) { this._mat.resolution.set(w, h); }

  /**
   * Render a set of edges.
   * @param {number[]} edgeIndices - which edges to show (indices into data arrays)
   * @param {object} ctx - rendering context
   * @param {Uint32Array} ctx.edgeSrc
   * @param {Uint32Array} ctx.edgeDst
   * @param {Uint8Array} ctx.edgeTypeIdx
   * @param {string[]} ctx.edgeTypeTable
   * @param {Int32Array} ctx.globalToSeq
   * @param {Float32Array} ctx.worldX
   * @param {Float32Array} ctx.worldZ
   * @param {object} [ctx.visibility] - { edgeTypeName: boolean }
   */
  showEdges(edgeIndices, ctx) {
    const { edgeSrc, edgeDst, edgeTypeIdx, edgeTypeTable, globalToSeq, worldX, worldZ, visibility } = ctx;
    let vi = 0;

    for (const ei of edgeIndices) {
      if (vi >= this.maxEdges * 6) break;

      const etName = edgeTypeTable[edgeTypeIdx[ei]];
      if (visibility && !visibility[etName]) continue;

      const srcId = edgeSrc[ei], dstId = edgeDst[ei];
      const si = srcId < globalToSeq.length ? globalToSeq[srcId] : -1;
      const di = dstId < globalToSeq.length ? globalToSeq[dstId] : -1;
      if (si < 0 || di < 0) continue;

      this._positions[vi]   = worldX[si]; this._positions[vi+1] = this.y; this._positions[vi+2] = worldZ[si];
      this._positions[vi+3] = worldX[di]; this._positions[vi+4] = this.y; this._positions[vi+5] = worldZ[di];

      const hex = EDGE_COLORS[etName] || DEFAULT_EDGE_COLOR;
      const c = colorToVec3(hex);
      const b = this.brightness;
      const r = Math.min(1.0, c[0] * b), g = Math.min(1.0, c[1] * b), bl = Math.min(1.0, c[2] * b);
      this._colors[vi]   = r; this._colors[vi+1] = g; this._colors[vi+2] = bl;
      this._colors[vi+3] = r; this._colors[vi+4] = g; this._colors[vi+5] = bl;
      vi += 6;
    }

    const edgeCount = vi / 6;
    if (!this._logged) {
      console.log(`[EdgeRenderer] ${edgeCount} edges rendered from ${edgeIndices.length} candidates`);
      this._logged = true;
    }

    if (edgeCount > 0) {
      this._geo.setPositions(this._positions.subarray(0, vi));
      this._geo.setColors(this._colors.subarray(0, vi));
      this.lines.computeLineDistances();
      this.lines.visible = true;
    } else {
      this.lines.visible = false;
    }
  }

  /**
   * Show edges filtered by frustum + LOD, sorted by weight.
   */
  showFiltered({ sortedIndices, camera, controls, lodMaxLevel, tileData, ctx }) {
    const dist = camera.position.distanceTo(controls.target);
    if (dist > 800) { this.clear(); return; }

    const frustum = new THREE.Frustum();
    const projMatrix = new THREE.Matrix4();
    projMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projMatrix);

    const visibleTiles = new Set();
    const testPoint = new THREE.Vector3();
    for (let i = 0; i < tileData.count; i++) {
      if (tileData.lodLevel[i] > lodMaxLevel) continue;
      testPoint.set(ctx.worldX[i], 0, ctx.worldZ[i]);
      if (frustum.containsPoint(testPoint)) visibleTiles.add(i);
    }

    const filtered = [];
    for (const ei of sortedIndices) {
      if (filtered.length >= this.maxEdges) break;

      const etName = ctx.edgeTypeTable[ctx.edgeTypeIdx[ei]];
      if (ctx.visibility && !ctx.visibility[etName]) continue;

      const srcId = ctx.edgeSrc[ei], dstId = ctx.edgeDst[ei];
      const si = srcId < ctx.globalToSeq.length ? ctx.globalToSeq[srcId] : -1;
      const di = dstId < ctx.globalToSeq.length ? ctx.globalToSeq[dstId] : -1;
      if (si < 0 || di < 0) continue;
      if (tileData.lodLevel[si] > lodMaxLevel || tileData.lodLevel[di] > lodMaxLevel) continue;
      if (!visibleTiles.has(si) && !visibleTiles.has(di)) continue;

      filtered.push(ei);
    }

    this.showEdges(filtered, ctx);
  }

  clear() {
    this.lines.visible = false;
  }
}
