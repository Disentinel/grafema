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
        this._precomputeFillColors();
        this._fillColorLevel = -1;
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

            // Switch fill colors when LOD level changes (progressive disclosure)
            const level = this.lodController.getLevel();
            if (level !== this._fillColorLevel) {
                this._fillColorLevel = level;
                this._applyFillColors(level);
            }

            this.tileGrid.lerpOpacity();
            this.fillGrid.lerpOpacity();
            this.regionRenderer.updateLabels(this.scene.camera);
        });

        // Hide loading
        if (loadingEl) loadingEl.style.display = 'none';
    }

    _colorTiles() {
        const hierarchy = this.data.hierarchy ?? [];
        const typeTable = this.data.metadata?.type_table ?? [];

        for (let i = 0; i < this.data.tileCount; i++) {
            const fileNode = hierarchy[this.data.tileFileIdx[i]];
            const hue = (fileNode?.hue ?? 0) / 360;
            const fileSat = (fileNode?.saturation ?? 75) / 100;
            const fileLight = (fileNode?.lightness ?? 30) / 100;
            const typeName = typeTable[this.data.tileTypeIdx[i]] ?? 'DEFAULT';
            const typeLightMod = (TYPE_LIGHTNESS[typeName] ?? TYPE_LIGHTNESS.DEFAULT) / 100;
            const isFiller = this.data.tileIsFiller?.[i] ?? 0;

            // Tile lightness: blend file's base lightness with type-based modifier
            const s = isFiller ? fileSat * 0.4 : fileSat;
            const l = isFiller ? fileLight * 0.5 : fileLight * 0.6 + typeLightMod * 0.4;
            const rgb = hslToRgb(hue, s, l);
            this.tileGrid.setColor(i, rgb[0], rgb[1], rgb[2]);
        }
        this.tileGrid.commitColors();
    }

    /**
     * Pre-compute 3 fill color sets for progressive disclosure:
     *   pkgColors  — all tiles in same package get uniform color
     *   dirColors  — tiles in same directory get directory-shade of package hue
     *   fileColors — tiles colored by file region (current graph coloring)
     */
    _precomputeFillColors() {
        const n = this.data.tileCount;
        const hierarchy = this.data.hierarchy ?? [];

        this._pkgFillColors = new Float32Array(n * 3);
        this._dirFillColors = new Float32Array(n * 3);
        this._fileFillColors = new Float32Array(n * 3);

        for (let i = 0; i < n; i++) {
            const isFiller = this.data.tileIsFiller?.[i] ?? 0;
            const i3 = i * 3;

            // Package-level: uniform color per package
            const pkgNode = hierarchy[this.data.tilePkgIdx[i]];
            const pkgHue = (pkgNode?.hue ?? 0) / 360;
            const pkgRgb = hslToRgb(pkgHue, isFiller ? 0.4 : 0.7, isFiller ? 0.12 : 0.25);
            this._pkgFillColors[i3] = pkgRgb[0];
            this._pkgFillColors[i3 + 1] = pkgRgb[1];
            this._pkgFillColors[i3 + 2] = pkgRgb[2];

            // Directory-level: shade variation within package hue
            const dirNode = hierarchy[this.data.tileDirIdx[i]];
            const dirHue = (dirNode?.hue ?? pkgNode?.hue ?? 0) / 360;
            const dirSat = (dirNode?.saturation ?? 70) / 100;
            const dirLight = (dirNode?.lightness ?? 25) / 100;
            const dirRgb = hslToRgb(dirHue, isFiller ? dirSat * 0.5 : dirSat,
                                     isFiller ? dirLight * 0.5 : dirLight);
            this._dirFillColors[i3] = dirRgb[0];
            this._dirFillColors[i3 + 1] = dirRgb[1];
            this._dirFillColors[i3 + 2] = dirRgb[2];

            // File-level: per-file shade of package hue (from hierarchy)
            const fileNode = hierarchy[this.data.tileFileIdx[i]];
            const fileHue = (fileNode?.hue ?? pkgNode?.hue ?? 0) / 360;
            const fileSat = (fileNode?.saturation ?? 70) / 100;
            const fileLight = (fileNode?.lightness ?? 25) / 100;
            const fileRgb = hslToRgb(fileHue, isFiller ? fileSat * 0.4 : fileSat,
                                      isFiller ? fileLight * 0.4 : fileLight);
            this._fileFillColors[i3] = fileRgb[0];
            this._fileFillColors[i3 + 1] = fileRgb[1];
            this._fileFillColors[i3 + 2] = fileRgb[2];
        }
    }

    /**
     * Apply fill colors matching the current LOD level.
     * LOD 0-1: package colors (uniform per package)
     * LOD 1: directory colors (shade variations within package hue)
     * LOD 2+: file colors (individual file hues)
     */
    _applyFillColors(level) {
        const n = this.data.tileCount;
        const colors = level <= 0 ? this._pkgFillColors
                     : level <= 1 ? this._dirFillColors
                     : this._fileFillColors;

        for (let i = 0; i < n; i++) {
            const i3 = i * 3;
            this.fillGrid.setColor(i, colors[i3], colors[i3 + 1], colors[i3 + 2]);
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
