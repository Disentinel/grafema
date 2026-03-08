import { LOD, LOD_TRANSITION_MS } from './constants.js';

export class LODController {
    /**
     * @param {import('./SceneManager.js').SceneManager} sceneManager
     * @param {import('./RegionRenderer.js').RegionRenderer} regionRenderer
     * @param {import('./HexGrid.js').HexGrid} tileGrid
     * @param {import('./DataLoader.js').DataLoader} data
     * @param {import('./HexGrid.js').HexGrid} [fillGrid]
     */
    constructor(sceneManager, regionRenderer, tileGrid, data, fillGrid) {
        this.sceneManager = sceneManager;
        this.regionRenderer = regionRenderer;
        this.tileGrid = tileGrid;
        this.fillGrid = fillGrid ?? null;
        this.data = data;
        this.manualLevel = null;
        this._currentLevel = -1;

        this.maxLevel = 0;
        if (data.hierarchy) {
            for (const node of data.hierarchy) {
                if (node.level > this.maxLevel) this.maxLevel = node.level;
            }
        }
        if (this.maxLevel === 0) this.maxLevel = data.metadata?.max_depth ?? 4;
    }

    update() {
        const dist = this.sceneManager.getCameraDistance();
        const level = this.manualLevel ?? this._distanceToLevel(dist);

        if (level !== this._currentLevel) {
            this._currentLevel = level;
        }

        // Always apply — tiles use smooth lerp, so repeated calls are fine
        this._applyLevel(this._currentLevel, dist);
        return this._currentLevel;
    }

    _distanceToLevel(distance) {
        if (distance > LOD.PACKAGES_ONLY) return 0;
        if (distance > LOD.DIRECTORIES) return 1;
        if (distance > LOD.FILES) return 2;
        if (distance > LOD.FUNCTIONS) return 3;
        return 4;
    }

    _applyLevel(level, distance) {
        // Region hierarchy visibility
        const levelOpacity = new Map();
        for (let i = 0; i <= this.maxLevel; i++) {
            if (i === 0) {
                // Root: show at far zoom only
                levelOpacity.set(i, level <= 0 ? 0.5 : 0);
            } else if (i === 1) {
                // Packages: always visible
                levelOpacity.set(i, 1.0);
            } else if (i <= 2) {
                // Directories: visible from level 1+
                levelOpacity.set(i, level >= 1 ? 1.0 : 0);
            } else if (i <= 4) {
                // Files: visible from level 2+
                levelOpacity.set(i, level >= 2 ? 1.0 : 0);
            } else {
                // Functions/Blocks: visible from level 3+
                levelOpacity.set(i, level >= 3 ? 0.7 : 0);
            }
        }
        this.regionRenderer.setLevelVisibility(levelOpacity);

        // Tile visibility based on LOD level
        if (this.tileGrid && this.data) {
            for (let i = 0; i < this.data.tileCount; i++) {
                const isFiller = this.data.tileIsFiller?.[i] ?? 0;

                if (level >= 3) {
                    // Close zoom: show all tiles
                    this.tileGrid.setOpacity(i, isFiller ? 0.3 : 1.0);
                    if (this.fillGrid) this.fillGrid.setOpacity(i, isFiller ? 0.15 : 0.5);
                } else if (level >= 2) {
                    // Medium zoom: show tiles at reduced opacity
                    this.tileGrid.setOpacity(i, isFiller ? 0.15 : 0.6);
                    if (this.fillGrid) this.fillGrid.setOpacity(i, isFiller ? 0.1 : 0.4);
                } else if (level >= 1) {
                    // Far zoom: dim tiles, keep fills visible
                    this.tileGrid.setOpacity(i, 0.15);
                    if (this.fillGrid) this.fillGrid.setOpacity(i, 0.3);
                } else {
                    // Very far: hide tiles, keep fill barely visible
                    this.tileGrid.setOpacity(i, 0.0);
                    if (this.fillGrid) this.fillGrid.setOpacity(i, 0.2);
                }
            }
        }
    }

    setManualLevel(level) {
        this.manualLevel = level === null ? null : Math.max(0, Math.min(4, level));
    }

    getLevel() {
        return this._currentLevel;
    }
}
