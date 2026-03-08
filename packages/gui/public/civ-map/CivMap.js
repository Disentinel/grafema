import { DataLoader } from './DataLoader.js';
import { SceneManager } from './SceneManager.js';
import { HexGrid } from './HexGrid.js';
import { RegionRenderer } from './RegionRenderer.js';
import { LODController } from './LODController.js';
import { EdgeRenderer } from './EdgeRenderer.js';
import { InteractionManager } from './InteractionManager.js';
import { UIPanel } from './UIPanel.js';
import { TYPE_LIGHTNESS } from './constants.js';

export class CivMap {
    constructor({ container }) {
        this.container = container;
        this.data = null;
        this.scene = null;
        this.tileGrid = null;
        this.fillGrid = null;
        this.regionRenderer = null;
        this.lodController = null;
        this.edgeRenderer = null;
        this.interaction = null;
        this.ui = null;
    }

    async load(url) {
        // Show loading
        const loadingEl = document.getElementById('loading');
        if (loadingEl) loadingEl.style.display = 'flex';

        // 1. Load data
        this.data = new DataLoader();
        await this.data.load(url);

        // 2. Create scene
        this.scene = new SceneManager(this.container);

        // 3. Create tile grid (detail hexes)
        const tileCount = this.data.tileCount;
        this.tileGrid = new HexGrid(tileCount, this.data.metadata?.tile_size ?? 1.0);
        this.tileGrid.setTiles(this.data.worldX, this.data.worldZ, tileCount);
        this._colorTiles();
        this.tileGrid.addTo(this.scene.scene);

        // 4. Create fill grid (region base hexes, slightly larger)
        this.fillGrid = new HexGrid(tileCount, this.data.metadata?.tile_size ?? 1.0, { scale: 1.05 });
        this.fillGrid.setTiles(this.data.worldX, this.data.worldZ, tileCount);
        this._colorFills();
        this.fillGrid.mesh.position.y = -0.05; // below tile grid
        this.fillGrid.addTo(this.scene.scene);

        // 5. Region renderer (hierarchy borders + labels)
        this.regionRenderer = new RegionRenderer(this.scene.scene, this.data);

        // 6. Edge renderer
        this.edgeRenderer = new EdgeRenderer(this.scene.scene, this.data);

        // 7. LOD controller (pass fillGrid too so LOD controls both layers)
        this.lodController = new LODController(this.scene, this.regionRenderer, this.tileGrid, this.data, this.fillGrid);

        // 8. Interaction manager
        this.interaction = new InteractionManager(this.scene, this.tileGrid, this.edgeRenderer, this.data);

        // 9. UI Panel
        this.ui = new UIPanel(this.data, this.edgeRenderer, this.lodController, this.tileGrid);

        // 10. Wire callbacks
        this.interaction.onTooltip = (data, mx, my) => this.ui.showTooltip(data, mx, my);
        this.interaction.onSearchFocus = () => this.ui.focusSearch();
        this.interaction.onActiveChange = (count) => {
            this.ui.updateActiveBadge(count);
        };

        this.ui.onSearchSelect = (result) => {
            if (result.tileIndex !== null) {
                const seqIdx = this.data.globalToSeq.get(result.tileIndex);
                if (seqIdx !== undefined) {
                    this.interaction.flyToTile(seqIdx);
                } else {
                    this.interaction.flyToWorld(result.worldX, result.worldZ);
                }
            } else {
                this.interaction.flyToWorld(result.worldX, result.worldZ);
            }
        };

        // Clear button
        document.getElementById('clear-active')?.addEventListener('click', () => {
            this.interaction.clearActive();
        });

        // 11. Render loop hooks
        this.scene.onRender(() => {
            this.lodController.update();
            this.tileGrid.lerpOpacity();
            this.fillGrid.lerpOpacity();
            this.regionRenderer.updateLabels(this.scene.camera);
        });

        // Hide loading
        if (loadingEl) loadingEl.style.display = 'none';
    }

    _colorTiles() {
        const regions = this.data.metadata?.regions ?? [];
        const typeTable = this.data.metadata?.type_table ?? [];
        const color = { h: 0, s: 0, l: 0 };

        for (let i = 0; i < this.data.tileCount; i++) {
            const regionIdx = this.data.tileRegionIdx[i];
            const region = regions[regionIdx];
            const hue = region?.hue ?? 0;
            const typeName = typeTable[this.data.tileTypeIdx[i]] ?? 'DEFAULT';
            const lightness = (TYPE_LIGHTNESS[typeName] ?? TYPE_LIGHTNESS.DEFAULT) / 100;
            const isFiller = this.data.tileIsFiller?.[i] ?? 0;

            // Convert HSL to RGB
            const h = hue / 360;
            const s = isFiller ? 0.3 : 0.7;
            const l = isFiller ? 0.15 : lightness;
            const rgb = hslToRgb(h, s, l);
            this.tileGrid.setColor(i, rgb[0], rgb[1], rgb[2]);
        }
        this.tileGrid.commitColors();
    }

    _colorFills() {
        const regions = this.data.metadata?.regions ?? [];

        for (let i = 0; i < this.data.tileCount; i++) {
            const regionIdx = this.data.tileRegionIdx[i];
            const region = regions[regionIdx];
            const hue = region?.hue ?? 0;
            const isFiller = this.data.tileIsFiller?.[i] ?? 0;

            const h = hue / 360;
            const s = 0.6;
            const l = isFiller ? 0.1 : 0.2;
            const rgb = hslToRgb(h, s, l);
            this.fillGrid.setColor(i, rgb[0], rgb[1], rgb[2]);
        }
        this.fillGrid.commitColors();
    }

    dispose() {
        this.interaction?.dispose();
        this.edgeRenderer?.dispose();
        this.regionRenderer?.dispose();
        this.tileGrid?.dispose();
        this.fillGrid?.dispose();
        this.scene?.dispose();
    }
}

// HSL to RGB conversion
function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    return [r, g, b];
}
