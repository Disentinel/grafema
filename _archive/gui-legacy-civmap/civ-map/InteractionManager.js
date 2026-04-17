import * as THREE from 'three';
import { PIN_COLOR, PIN_HEIGHT, PIN_BOB_SPEED, PIN_BOB_AMPLITUDE, MAX_PINS } from './constants.js';

export class InteractionManager {
    /**
     * @param {import('./SceneManager.js').SceneManager} sceneManager
     * @param {import('./HexGrid.js').HexGrid} tileGrid
     * @param {import('./EdgeRenderer.js').EdgeRenderer} edgeRenderer
     * @param {import('./DataLoader.js').DataLoader} data
     */
    constructor(sceneManager, tileGrid, edgeRenderer, data) {
        this.sceneManager = sceneManager;
        this.tileGrid = tileGrid;
        this.edgeRenderer = edgeRenderer;
        this.data = data;

        // State
        this.activeTiles = new Set();     // Set of sequential indices
        this.activeGlobals = new Set();   // Set of global indices (for edge filtering)
        this.hoveredTile = -1;
        this.connectedTiles = new Set();  // tiles connected to hovered tile

        // Pin pool
        this.pins = [];
        this._pinPool = [];
        this._initPinPool();

        // Mouse tracking
        this._mouse = new THREE.Vector2();
        this._tooltip = null;
        this._tooltipTimeout = null;

        // Bind events
        const canvas = sceneManager.renderer.domElement;
        canvas.addEventListener('mousemove', e => this._onMouseMove(e));
        canvas.addEventListener('dblclick', e => this._onDoubleClick(e));
        canvas.addEventListener('click', e => this._onClick(e));

        // Keyboard
        document.addEventListener('keydown', e => this._onKeyDown(e));

        // Render callback for pin animation
        sceneManager.onRender((dt, elapsed) => this._animatePins(elapsed));
    }

    _initPinPool() {
        const needleGeo = new THREE.CylinderGeometry(0.15, 0.15, PIN_HEIGHT, 8);
        const headGeo = new THREE.SphereGeometry(0.8, 16, 12);
        const needleMat = new THREE.MeshBasicMaterial({ color: 0x881111 });
        const headMat = new THREE.MeshBasicMaterial({ color: PIN_COLOR });

        for (let i = 0; i < MAX_PINS; i++) {
            const group = new THREE.Group();
            const needle = new THREE.Mesh(needleGeo, needleMat);
            needle.position.y = PIN_HEIGHT / 2;
            const head = new THREE.Mesh(headGeo, headMat);
            head.position.y = PIN_HEIGHT;
            group.add(needle, head);
            group.visible = false;
            group.userData = { tileIdx: -1, baseY: 0 };
            this._pinPool.push(group);
            this.sceneManager.scene.add(group);
        }
    }

    _onMouseMove(event) {
        const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
        this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        this._mouseClientX = event.clientX;
        this._mouseClientY = event.clientY;

        // Debounce hover
        clearTimeout(this._tooltipTimeout);
        this._tooltipTimeout = setTimeout(() => this._updateHover(), 16);
    }

    _updateHover() {
        const idx = this.tileGrid.raycast(this._mouse, this.sceneManager.camera);

        if (idx === this.hoveredTile) return;

        // Unhighlight previous
        if (this.hoveredTile >= 0) {
            this._unhighlightConnected();
        }

        this.hoveredTile = idx;

        if (idx >= 0) {
            this._highlightConnected(idx);
            this._showTooltip(idx);
        } else {
            this._hideTooltip();
        }
    }

    _highlightConnected(seqIdx) {
        // Find all tiles connected by edges to this tile
        this.connectedTiles.clear();
        this.connectedTiles.add(seqIdx);

        const globalIdx = this.data.tileGlobalIdx[seqIdx];
        const gs = this.data.globalToSeq;

        for (let i = 0; i < this.data.edgeCount; i++) {
            if (this.data.edgeSrc[i] === globalIdx) {
                const seq = gs.get(this.data.edgeDst[i]);
                if (seq !== undefined) this.connectedTiles.add(seq);
            }
            if (this.data.edgeDst[i] === globalIdx) {
                const seq = gs.get(this.data.edgeSrc[i]);
                if (seq !== undefined) this.connectedTiles.add(seq);
            }
        }

        // Dim all non-connected, brighten connected
        for (let i = 0; i < this.data.tileCount; i++) {
            if (this.connectedTiles.has(i) || this.activeTiles.has(i)) {
                this.tileGrid.setOpacity(i, 1.0);
            } else {
                this.tileGrid.setOpacity(i, 0.25);
            }
        }
    }

    _unhighlightConnected() {
        // Restore all opacities (LODController will re-apply appropriate values)
        for (let i = 0; i < this.data.tileCount; i++) {
            this.tileGrid.setOpacity(i, this.activeTiles.has(i) ? 1.0 : 0.8);
        }
        this.connectedTiles.clear();
    }

    async _showTooltip(seqIdx) {
        const globalIdx = this.data.tileGlobalIdx[seqIdx];
        const typeName = this.data.metadata?.type_table?.[this.data.tileTypeIdx[seqIdx]] ?? 'UNKNOWN';
        const degree = this.data.tileDegree[seqIdx];
        const regionIdx = this.data.tileRegionIdx[seqIdx];
        const regionPath = this.data.metadata?.regions?.[regionIdx]?.path ?? '';
        const etTable = this.data.metadata?.edge_type_table ?? [];

        // Compute edge type breakdown for this tile
        const edgeBreakdown = {};
        for (let i = 0; i < this.data.edgeCount; i++) {
            if (this.data.edgeSrc[i] === globalIdx || this.data.edgeDst[i] === globalIdx) {
                const typeName = etTable[this.data.edgeType[i]] ?? 'UNKNOWN';
                edgeBreakdown[typeName] = (edgeBreakdown[typeName] ?? 0) + 1;
            }
        }

        if (this.onTooltip) {
            // Async fetch for full details
            try {
                const resp = await fetch(`/api/node?index=${globalIdx}`);
                const detail = await resp.json();
                this.onTooltip({
                    seqIdx, globalIdx, type: typeName,
                    name: detail.name ?? '',
                    file: detail.file ?? regionPath,
                    degree, regionPath,
                    lodLevel: this.data.tileLodLevel[seqIdx],
                    isFiller: this.data.tileIsFiller?.[seqIdx] ?? 0,
                    edgeBreakdown,
                }, this._mouseClientX, this._mouseClientY);
            } catch {
                this.onTooltip({
                    seqIdx, globalIdx, type: typeName, name: '', file: regionPath,
                    degree, regionPath, lodLevel: this.data.tileLodLevel[seqIdx],
                    edgeBreakdown,
                }, this._mouseClientX, this._mouseClientY);
            }
        }
    }

    _hideTooltip() {
        if (this.onTooltip) this.onTooltip(null);
    }

    _onDoubleClick(event) {
        const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
        this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        const idx = this.tileGrid.raycast(this._mouse, this.sceneManager.camera);
        if (idx < 0) return;

        this.toggleActive(idx);
    }

    _onClick(event) {
        // Click on pin head: fly to that tile
        // For now, handled by double-click only
    }

    _onKeyDown(event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
            event.preventDefault();
            if (this.onSearchFocus) this.onSearchFocus();
        }
        if (event.key === 'Escape') {
            if (this.activeTiles.size > 0) {
                this.clearActive();
            }
        }
    }

    toggleActive(seqIdx) {
        if (this.activeTiles.has(seqIdx)) {
            this.activeTiles.delete(seqIdx);
            this.activeGlobals.delete(this.data.tileGlobalIdx[seqIdx]);
            this._removePin(seqIdx);
        } else {
            this.activeTiles.add(seqIdx);
            this.activeGlobals.add(this.data.tileGlobalIdx[seqIdx]);
            this._addPin(seqIdx);
        }
        this._updateActiveEdges();
        if (this.onActiveChange) this.onActiveChange(this.activeTiles.size);
    }

    addActive(seqIdx) {
        if (this.activeTiles.has(seqIdx)) return;
        this.activeTiles.add(seqIdx);
        this.activeGlobals.add(this.data.tileGlobalIdx[seqIdx]);
        this._addPin(seqIdx);
        this._updateActiveEdges();
        if (this.onActiveChange) this.onActiveChange(this.activeTiles.size);
    }

    clearActive() {
        this.activeTiles.clear();
        this.activeGlobals.clear();
        for (const pin of this._pinPool) {
            pin.visible = false;
            pin.userData.tileIdx = -1;
        }
        this.pins = [];
        this.edgeRenderer.showForTiles(this.activeGlobals);
        if (this.onActiveChange) this.onActiveChange(0);
    }

    _addPin(seqIdx) {
        // Find unused pin from pool
        const pin = this._pinPool.find(p => !p.visible);
        if (!pin) return;

        const x = this.data.worldX[seqIdx];
        const z = this.data.worldZ[seqIdx];
        pin.position.set(x, 0, z);
        pin.visible = true;
        pin.userData.tileIdx = seqIdx;
        pin.userData.baseY = 0;
        this.pins.push(pin);
    }

    _removePin(seqIdx) {
        const pin = this._pinPool.find(p => p.userData.tileIdx === seqIdx);
        if (pin) {
            pin.visible = false;
            pin.userData.tileIdx = -1;
            this.pins = this.pins.filter(p => p !== pin);
        }
    }

    _updateActiveEdges() {
        this.edgeRenderer.showForTiles(this.activeGlobals);
    }

    _animatePins(elapsed) {
        const dist = this.sceneManager.getCameraDistance();
        // Scale pins so they stay visible at all zoom levels
        const scale = Math.max(1.0, Math.min(8, dist / 40));

        for (const pin of this.pins) {
            if (!pin.visible) continue;
            const bob = Math.sin(elapsed * PIN_BOB_SPEED) * PIN_BOB_AMPLITUDE;
            pin.position.y = pin.userData.baseY + bob;
            pin.scale.setScalar(scale);
        }
    }

    // Search integration
    flyToTile(seqIdx) {
        const x = this.data.worldX[seqIdx];
        const z = this.data.worldZ[seqIdx];
        this.sceneManager.flyTo(x, z);
        this.addActive(seqIdx);
    }

    flyToWorld(x, z) {
        this.sceneManager.flyTo(x, z);
    }

    // Callbacks (set by CivMap)
    onTooltip = null;        // (tooltipData | null) => void
    onSearchFocus = null;    // () => void
    onActiveChange = null;   // (count) => void

    dispose() {
        for (const pin of this._pinPool) {
            pin.traverse(c => {
                if (c.geometry) c.geometry.dispose();
                if (c.material) c.material.dispose();
            });
            this.sceneManager.scene.remove(pin);
        }
    }
}
