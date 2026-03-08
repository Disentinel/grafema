/**
 * RegionRenderer — tile-based region borders + LOD-aware labels.
 *
 * Borders: computed directly from tile hex coordinates and hierarchy
 * indices (pkgIdx, regionIdx). Each tile checks its 6 neighbors —
 * if a neighbor has a different group index (or doesn't exist), a border
 * segment is emitted. This produces perfect borders for any shape,
 * including disconnected regions and regions with holes.
 *
 * Uses LineSegments2/LineMaterial for thick anti-aliased borders
 * (WebGL LineBasicMaterial is capped at 1px on most GPUs).
 *
 * Labels: hierarchy-based sprites with screen-space occlusion culling.
 * Each frame, labels are projected to screen coordinates and sorted
 * by importance (hierarchy level, tile count). Overlapping labels are
 * hidden, keeping only the most important visible ones.
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export class RegionRenderer {
    /**
     * @param {THREE.Scene} scene
     * @param {import('./DataLoader.js').DataLoader} data
     */
    constructor(scene, data) {
        this.scene = scene;
        this.data = data;

        this._pkgBorders = null;
        this._fileBorders = null;
        this._labels = [];         // { sprite, tier, level, tileCount, worldX, worldZ }
        this._labelGroups = new Map(); // tier -> THREE.Group

        this._buildBorders();
        this._buildLabels();
    }

    // ── Borders (tile-based, computed client-side) ──────────────────

    _buildBorders() {
        const data = this.data;
        if (!data.tileCount) return;

        const ts = data.metadata?.tile_size ?? 1.0;

        // coord → seqIdx lookup (packed int key)
        const coordMap = new Map();
        for (let i = 0; i < data.tileCount; i++) {
            const key = (data.tileQ[i] + 32768) * 65536 + (data.tileR[i] + 32768);
            coordMap.set(key, i);
        }

        // Flat-top hex neighbor offsets (axial coords)
        const NB = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

        // Hex vertex positions (7 values: 0°..360° for wrap-around)
        const vx = [], vz = [];
        for (let v = 0; v <= 6; v++) {
            const a = Math.PI / 3 * v;
            vx.push(Math.cos(a) * ts);
            vz.push(Math.sin(a) * ts);
        }

        // For each neighbor direction d, which pair of vertex indices
        // form the shared edge. Derived from matching neighbor world-angle
        // to hex edge midpoint angle.
        //   d=0 (+1, 0)  → 30°  → edge v0–v1
        //   d=1 (+1,-1)  → 330° → edge v5–v0 (use v6=wrap of v0)
        //   d=2 ( 0,-1)  → 270° → edge v4–v5
        //   d=3 (-1, 0)  → 210° → edge v3–v4
        //   d=4 (-1,+1)  → 150° → edge v2–v3
        //   d=5 ( 0,+1)  → 90°  → edge v1–v2
        const EV = [[0, 1], [5, 6], [4, 5], [3, 4], [2, 3], [1, 2]];

        const pkgPositions = [];
        const filePositions = [];

        for (let i = 0; i < data.tileCount; i++) {
            const q = data.tileQ[i], r = data.tileR[i];
            const cx = data.worldX[i], cz = data.worldZ[i];
            const myPkg = data.tilePkgIdx[i];
            const myRegion = data.tileRegionIdx[i];

            for (let d = 0; d < 6; d++) {
                const nq = q + NB[d][0], nr = r + NB[d][1];
                const nKey = (nq + 32768) * 65536 + (nr + 32768);
                const nIdx = coordMap.get(nKey);

                const e = EV[d];
                const x1 = cx + vx[e[0]], z1 = cz + vz[e[0]];
                const x2 = cx + vx[e[1]], z2 = cz + vz[e[1]];

                // Package border: different package or no neighbor
                if (nIdx === undefined || data.tilePkgIdx[nIdx] !== myPkg) {
                    pkgPositions.push(x1, 0.15, z1, x2, 0.15, z2);
                }

                // File border: different region or no neighbor
                if (nIdx === undefined || data.tileRegionIdx[nIdx] !== myRegion) {
                    filePositions.push(x1, 0.08, z1, x2, 0.08, z2);
                }
            }
        }

        const res = new THREE.Vector2(window.innerWidth, window.innerHeight);

        if (pkgPositions.length > 0) {
            const geo = new LineSegmentsGeometry();
            geo.setPositions(pkgPositions);
            const mat = new LineMaterial({
                color: 0x00e5ff, linewidth: 3,
                transparent: true, opacity: 0.9,
                resolution: res,
            });
            this._pkgBorders = new LineSegments2(geo, mat);
            this._pkgBorders.renderOrder = 5;
            this.scene.add(this._pkgBorders);
        }

        if (filePositions.length > 0) {
            const geo = new LineSegmentsGeometry();
            geo.setPositions(filePositions);
            const mat = new LineMaterial({
                color: 0x445566, linewidth: 1.5,
                transparent: true, opacity: 0.4,
                resolution: res,
            });
            this._fileBorders = new LineSegments2(geo, mat);
            this._fileBorders.renderOrder = 2;
            this.scene.add(this._fileBorders);
        }
    }

    // ── Labels (hierarchy-based) ────────────────────────────────────

    _buildLabels() {
        const hierarchy = this.data.hierarchy;
        if (!hierarchy || hierarchy.length === 0) {
            this._buildLabelsFromRegions();
            return;
        }

        const kindNames = ['Root', 'Package', 'Directory', 'File', 'Function', 'Block'];

        for (const tier of ['pkg', 'dir', 'file']) {
            const group = new THREE.Group();
            group.name = `labels-${tier}`;
            this._labelGroups.set(tier, group);
            this.scene.add(group);
        }

        for (const node of hierarchy) {
            const kindName = kindNames[node.kind] ?? '';
            if (kindName === 'Function' || kindName === 'Block' || kindName === 'Root') continue;

            const minTiles = kindName === 'Package' ? 0 : kindName === 'Directory' ? 50 : 30;
            if (node.allTileCount < minTiles) continue;

            // Region bounding box for label sizing
            let bboxW = 10, bboxH = 10;
            if (node.border.length >= 3) {
                let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
                for (const [x, z] of node.border) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (z < minZ) minZ = z;
                    if (z > maxZ) maxZ = z;
                }
                bboxW = maxX - minX;
                bboxH = maxZ - minZ;
            }

            const tier = kindName === 'Package' ? 'pkg' : kindName === 'Directory' ? 'dir' : 'file';
            const yOff = tier === 'pkg' ? 1.0 : tier === 'dir' ? 0.6 : 0.3;

            const sprite = this._createLabel(node.id, node.allTileCount, node.hue, bboxW, bboxH);
            sprite.position.set(node.center[0], yOff, node.center[1]);

            this._labelGroups.get(tier).add(sprite);
            this._labels.push({
                sprite, tier,
                level: node.level,
                tileCount: node.allTileCount,
                worldX: node.center[0],
                worldZ: node.center[1],
            });
        }
    }

    _buildLabelsFromRegions() {
        const regions = this.data.metadata?.regions;
        if (!regions) return;

        const group = new THREE.Group();
        group.name = 'labels-file';
        this._labelGroups.set('file', group);
        this.scene.add(group);

        for (const region of regions) {
            const name = region.path.split('/').pop() || region.path;
            const sprite = this._createLabel(name, region.tile_count, region.hue, 10, 10);
            sprite.position.set(region.center[0], 0.3, region.center[1]);
            group.add(sprite);

            this._labels.push({
                sprite, tier: 'file',
                level: 3,
                tileCount: region.tile_count,
                worldX: region.center[0],
                worldZ: region.center[1],
            });
        }
    }

    _createLabel(text, tileCount, hue, regionW, regionH) {
        // Extract short human-readable name
        let shortName;
        if (text.includes('/')) {
            const parts = text.split('/');
            if (parts.length <= 2) {
                shortName = parts[parts.length - 1];
            } else if (text.includes('.')) {
                shortName = parts.slice(-2).join('/');
            } else {
                shortName = parts[parts.length - 1];
            }
        } else {
            shortName = text;
        }

        const fontSize = Math.max(14, Math.min(48, 14 + Math.sqrt(tileCount) * 2));
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        ctx.font = `bold ${fontSize}px monospace`;
        const metrics = ctx.measureText(shortName);
        canvas.width = Math.ceil(metrics.width) + 8;
        canvas.height = Math.ceil(fontSize * 1.4);

        // Redraw after resize
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = `hsl(${hue}, 80%, 50%)`;
        ctx.shadowBlur = 4;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(shortName, 4, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;

        const spriteMat = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
        });
        const sprite = new THREE.Sprite(spriteMat);

        // Scale to fit within region bounding box (capped)
        const aspect = canvas.width / canvas.height;
        const maxExtent = Math.min(regionW || 10, regionH || 10) * 0.6;
        const scale = Math.max(2, Math.min(maxExtent, Math.sqrt(tileCount) * 0.8, 50));
        sprite.scale.set(scale * aspect, scale, 1);

        return sprite;
    }

    // ── Screen-space label occlusion ────────────────────────────────

    /**
     * Update label visibility based on screen-space overlap detection.
     * Closer/more-important labels occlude farther/less-important ones.
     * Call every frame (or every few frames).
     * @param {THREE.PerspectiveCamera} camera
     */
    updateLabels(camera) {
        if (this._labels.length === 0) return;

        const w = window.innerWidth;
        const h = window.innerHeight;
        const fovRad = camera.fov * Math.PI / 180;
        const tanHalfFov = Math.tan(fovRad / 2);
        const camPos = camera.position;
        const vec = new THREE.Vector3();

        const projected = [];

        for (const label of this._labels) {
            // Skip labels in hidden group
            const group = this._labelGroups.get(label.tier);
            if (!group || !group.visible) {
                label.sprite.visible = false;
                continue;
            }

            // Project to screen
            vec.set(label.worldX, label.sprite.position.y, label.worldZ);
            vec.project(camera);

            const screenX = (vec.x * 0.5 + 0.5) * w;
            const screenY = (-vec.y * 0.5 + 0.5) * h;
            const depth = vec.z;

            // Behind camera or far outside viewport
            if (depth < 0 || depth > 1 ||
                screenX < -150 || screenX > w + 150 ||
                screenY < -150 || screenY > h + 150) {
                label.sprite.visible = false;
                continue;
            }

            // Estimate screen-space size
            vec.set(label.worldX, 0, label.worldZ);
            const dist = camPos.distanceTo(vec);
            const pixelsPerUnit = h / (2 * dist * tanHalfFov);
            const rectW = label.sprite.scale.x * pixelsPerUnit;
            const rectH = label.sprite.scale.y * pixelsPerUnit;

            // Skip tiny labels
            if (rectW < 15) {
                label.sprite.visible = false;
                continue;
            }

            // Priority: tier rank (pkg > dir > file), then tileCount, then closeness
            const tierRank = label.tier === 'pkg' ? 2 : label.tier === 'dir' ? 1 : 0;
            const priority = tierRank * 1e8 + label.tileCount * 100 + (1000 - Math.min(dist, 999));

            projected.push({ label, screenX, screenY, rectW, rectH, priority });
        }

        // Sort by priority descending (most important first)
        projected.sort((a, b) => b.priority - a.priority);

        const placed = [];
        for (const p of projected) {
            const r = {
                x: p.screenX - p.rectW / 2,
                y: p.screenY - p.rectH / 2,
                w: p.rectW,
                h: p.rectH,
            };

            const overlaps = placed.some(pr =>
                r.x < pr.x + pr.w && r.x + r.w > pr.x &&
                r.y < pr.y + pr.h && r.y + r.h > pr.y
            );

            if (overlaps) {
                p.label.sprite.visible = false;
            } else {
                p.label.sprite.visible = true;
                placed.push(r);
            }
        }
    }

    // ── LOD control ─────────────────────────────────────────────────

    /**
     * Set visibility based on camera LOD level.
     * @param {number} lodLevel - 0 (very far) to 4 (very close)
     */
    setLODLevel(lodLevel) {
        // Package borders: always visible, fade at close zoom
        if (this._pkgBorders) {
            this._pkgBorders.visible = true;
            this._pkgBorders.material.opacity = lodLevel <= 1 ? 0.9 : 0.5;
        }

        // File borders: visible from LOD 2+
        if (this._fileBorders) {
            this._fileBorders.visible = lodLevel >= 2;
            this._fileBorders.material.opacity = lodLevel >= 3 ? 0.4 : 0.2;
        }

        // Label tier visibility
        const pkgLabels = this._labelGroups.get('pkg');
        const dirLabels = this._labelGroups.get('dir');
        const fileLabels = this._labelGroups.get('file');

        if (pkgLabels) pkgLabels.visible = true;       // always
        if (dirLabels) dirLabels.visible = lodLevel >= 1;
        if (fileLabels) fileLabels.visible = lodLevel >= 2;
    }

    /**
     * Legacy interface called by LODController.
     * Converts level opacity map to LOD level.
     * @param {Map<number, number>} levelOpacity
     */
    setLevelVisibility(levelOpacity) {
        let lodLevel = 0;
        if ((levelOpacity.get(1) ?? 0) > 0.01) lodLevel = 1;
        for (let i = 2; i <= 4; i++) {
            if ((levelOpacity.get(i) ?? 0) > 0.01) lodLevel = Math.max(lodLevel, 2);
        }
        for (let i = 5; i <= 10; i++) {
            if ((levelOpacity.get(i) ?? 0) > 0.01) lodLevel = Math.max(lodLevel, 3);
        }
        this.setLODLevel(lodLevel);
    }

    dispose() {
        if (this._pkgBorders) {
            this._pkgBorders.geometry.dispose();
            this._pkgBorders.material.dispose();
            this.scene.remove(this._pkgBorders);
        }
        if (this._fileBorders) {
            this._fileBorders.geometry.dispose();
            this._fileBorders.material.dispose();
            this.scene.remove(this._fileBorders);
        }
        for (const [, group] of this._labelGroups) {
            group.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (child.material.map) child.material.map.dispose();
                    child.material.dispose();
                }
            });
            this.scene.remove(group);
        }
        this._labels = [];
        this._labelGroups.clear();
    }
}
