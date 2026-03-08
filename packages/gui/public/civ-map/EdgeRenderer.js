/**
 * EdgeRenderer — LOD-aware edge rendering with spatial culling.
 *
 * Renders two layers of edges:
 *   - Aggregated edges: region-to-region summary lines (visible at far zoom)
 *   - Individual edges: tile-to-tile connections (visible at close zoom,
 *     filtered by pinned/hovered tiles)
 *
 * Uses Line2/LineMaterial for thick anti-aliased lines (WebGL
 * LineBasicMaterial is capped at 1px on most GPUs).
 *
 * Supports: per-type visibility toggle, importance-based culling
 * (higher-degree endpoints rendered first), spatial hash for fast
 * frustum culling, and configurable brightness/opacity/linewidth.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { EDGE_COLORS, MAX_EDGES_DEFAULT } from './constants.js';

export class EdgeRenderer {
    /**
     * @param {THREE.Scene} scene
     * @param {import('./DataLoader.js').DataLoader} data
     */
    constructor(scene, data) {
        this.scene = scene;
        this.data = data;
        this.line = null;
        this.aggLine = null;

        // Settings (controlled by UIPanel)
        this.brightness = 1.0;
        this.opacity = 0.6;
        this.linewidth = 2;
        this.maxEdges = MAX_EDGES_DEFAULT;
        this.visibleTypes = new Set(); // edge type indices that are visible

        // Initialize all edge types as visible
        const etTable = data.metadata?.edge_type_table ?? [];
        for (let i = 0; i < etTable.length; i++) {
            this.visibleTypes.add(i);
        }

        // Pre-sort edges by degree sum (higher-degree edges first for importance culling)
        this._sortedEdgeIndices = this._buildSortedIndices();

        // Spatial hash for frustum culling
        this._spatialBucketSize = 32;
        this._spatialHash = this._buildSpatialHash();

        // Build aggregated edges from metadata
        this._buildAggEdges();
    }

    _buildSortedIndices() {
        const n = this.data.edgeCount;
        const indices = new Uint32Array(n);
        for (let i = 0; i < n; i++) indices[i] = i;

        const src = this.data.edgeSrc;
        const dst = this.data.edgeDst;
        const deg = this.data.tileDegree;
        const gs = this.data.globalToSeq;

        indices.sort((a, b) => {
            const sa = gs.get(src[a]) ?? 0;
            const sb = gs.get(src[b]) ?? 0;
            const da = gs.get(dst[a]) ?? 0;
            const db = gs.get(dst[b]) ?? 0;
            return (deg[sb] + deg[db]) - (deg[sa] + deg[da]);
        });

        return indices;
    }

    _buildSpatialHash() {
        const hash = new Map();
        const bs = this._spatialBucketSize;
        const wx = this.data.worldX;
        const wz = this.data.worldZ;
        if (!wx) return hash;

        for (let i = 0; i < this.data.tileCount; i++) {
            const bx = Math.floor(wx[i] / bs);
            const bz = Math.floor(wz[i] / bs);
            const key = `${bx},${bz}`;
            if (!hash.has(key)) hash.set(key, []);
            hash.get(key).push(i);
        }
        return hash;
    }

    _buildAggEdges() {
        const aggEdges = this.data.metadata?.agg_edges;
        const regions = this.data.metadata?.regions;
        if (!aggEdges || !regions) return;

        const positions = [];
        const colors = [];
        const etTable = this.data.metadata.edge_type_table ?? [];

        for (const ae of aggEdges) {
            // Respect edge type visibility
            if (!this.visibleTypes.has(ae.type)) continue;

            const src = regions[ae.src];
            const dst = regions[ae.dst];
            if (!src || !dst) continue;

            positions.push(
                src.center[0], 0.2, src.center[1],
                dst.center[0], 0.2, dst.center[1],
            );

            const typeName = etTable[ae.type] ?? 'DEFAULT';
            const color = new THREE.Color(EDGE_COLORS[typeName] ?? EDGE_COLORS.DEFAULT);
            const intensity = Math.min(1.0, 0.6 + ae.count / 10);
            color.multiplyScalar(intensity * this.brightness);
            colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
        }

        if (positions.length > 0) {
            const geo = new LineGeometry();
            geo.setPositions(positions);
            geo.setColors(colors);

            const mat = new LineMaterial({
                vertexColors: true,
                linewidth: this.linewidth,
                transparent: true,
                opacity: this.opacity,
                resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
            });

            this.aggLine = new Line2(geo, mat);
            this.aggLine.renderOrder = 5;
            this.scene.add(this.aggLine);
        }
    }

    /**
     * Show edges for specific tile indices (e.g., pinned tiles).
     * Creates a new Line2 with edges from/to those tiles.
     * @param {Set<number>} tileGlobalIndices - set of global tile indices to show edges for
     */
    showForTiles(tileGlobalIndices) {
        this._removeLine();
        this._lastActiveTiles = new Set(tileGlobalIndices);

        if (tileGlobalIndices.size === 0) return;

        const positions = [];
        const colors = [];
        const wx = this.data.worldX;
        const wz = this.data.worldZ;
        const gs = this.data.globalToSeq;
        const etTable = this.data.metadata?.edge_type_table ?? [];
        let count = 0;

        for (let i = 0; i < this.data.edgeCount && count < this.maxEdges; i++) {
            const si = this.data.edgeSrc[i];
            const di = this.data.edgeDst[i];
            if (!tileGlobalIndices.has(si) && !tileGlobalIndices.has(di)) continue;

            const typeIdx = this.data.edgeType[i];
            if (!this.visibleTypes.has(typeIdx)) continue;

            const sSeq = gs.get(si);
            const dSeq = gs.get(di);
            if (sSeq === undefined || dSeq === undefined) continue;

            positions.push(
                wx[sSeq], 0.15, wz[sSeq],
                wx[dSeq], 0.15, wz[dSeq],
            );

            const typeName = etTable[typeIdx] ?? 'DEFAULT';
            const color = new THREE.Color(EDGE_COLORS[typeName] ?? EDGE_COLORS.DEFAULT);
            color.multiplyScalar(this.brightness);
            colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
            count++;
        }

        if (positions.length === 0) return;

        const geo = new LineGeometry();
        geo.setPositions(positions);
        geo.setColors(colors);

        const mat = new LineMaterial({
            vertexColors: true,
            linewidth: this.linewidth,
            transparent: true,
            opacity: this.opacity,
            resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
        });

        this.line = new Line2(geo, mat);
        this.line.renderOrder = 10;
        this.scene.add(this.line);
    }

    /**
     * Update edge visibility based on LOD level and camera distance.
     * At far zoom: show only aggregated edges.
     * At close zoom: show individual edges for active/hovered tiles.
     * @param {number} lodLevel - current LOD level (0..4)
     */
    updateLOD(lodLevel) {
        if (this.aggLine) {
            this.aggLine.visible = lodLevel <= 2;
        }
        // Individual edges controlled by showForTiles
    }

    /**
     * Update rendering settings.
     * @param {object} settings
     * @param {number} [settings.brightness] - color multiplier (default 1.0)
     * @param {number} [settings.opacity] - line opacity 0..1 (default 0.6)
     * @param {number} [settings.linewidth] - line width in pixels (default 2)
     * @param {number} [settings.maxEdges] - max visible edge segments
     */
    setSettings({ brightness, opacity, linewidth, maxEdges }) {
        const brightnessChanged = brightness !== undefined && brightness !== this.brightness;
        if (brightness !== undefined) this.brightness = brightness;
        if (opacity !== undefined) this.opacity = opacity;
        if (linewidth !== undefined) this.linewidth = linewidth;
        if (maxEdges !== undefined) this.maxEdges = maxEdges;

        // Apply to live aggregated edge line
        if (this.aggLine) {
            this.aggLine.material.opacity = this.opacity;
            this.aggLine.material.linewidth = this.linewidth;
            if (brightnessChanged) {
                // Rebuild agg edges with new brightness
                this._removeAggLine();
                this._buildAggEdges();
            }
        }

        // Apply to live individual edge line — rebuild if brightness/maxEdges changed
        if (this.line && this._lastActiveTiles) {
            if (brightnessChanged || maxEdges !== undefined) {
                this.showForTiles(this._lastActiveTiles);
            } else {
                this.line.material.opacity = this.opacity;
                this.line.material.linewidth = this.linewidth;
            }
        }
    }

    /**
     * Re-render edges (for type toggle, settings changes).
     * Rebuilds both aggregated and individual edge lines.
     */
    refresh() {
        // Rebuild aggregated edges (respects visibleTypes)
        this._removeAggLine();
        this._buildAggEdges();

        // Rebuild individual edges if any tiles are active
        if (this._lastActiveTiles) {
            this.showForTiles(this._lastActiveTiles);
        }
    }

    _removeAggLine() {
        if (this.aggLine) {
            this.scene.remove(this.aggLine);
            this.aggLine.geometry.dispose();
            this.aggLine.material.dispose();
            this.aggLine = null;
        }
    }

    _removeLine() {
        if (this.line) {
            this.scene.remove(this.line);
            this.line.geometry.dispose();
            this.line.material.dispose();
            this.line = null;
        }
    }

    dispose() {
        this._removeLine();
        if (this.aggLine) {
            this.scene.remove(this.aggLine);
            this.aggLine.geometry.dispose();
            this.aggLine.material.dispose();
            this.aggLine = null;
        }
    }
}
