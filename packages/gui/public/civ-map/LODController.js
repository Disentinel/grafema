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

        this._computeThresholds();
    }

    /**
     * Compute LOD distance thresholds from actual data extents.
     * Uses viewport diagonal: at what camera distance does a given
     * world-space extent fill a fraction of the screen?
     */
    _computeThresholds() {
        const data = this.data;
        const fovRad = (this.sceneManager.camera.fov || 60) * Math.PI / 180;
        const tanHalf = Math.tan(fovRad / 2);
        const aspect = window.innerWidth / window.innerHeight;
        // Visible diagonal at distance d = d * visPerDist
        const visPerDist = 2 * tanHalf * Math.sqrt(1 + aspect * aspect);

        // Graph bounding box diagonal
        let gx0 = Infinity, gx1 = -Infinity, gz0 = Infinity, gz1 = -Infinity;
        for (let i = 0; i < data.tileCount; i++) {
            const x = data.worldX[i], z = data.worldZ[i];
            if (x < gx0) gx0 = x; if (x > gx1) gx1 = x;
            if (z < gz0) gz0 = z; if (z > gz1) gz1 = z;
        }
        const graphDiag = Math.sqrt((gx1 - gx0) ** 2 + (gz1 - gz0) ** 2) || 100;

        // Largest package diagonal
        let maxPkgDiag = 0;
        for (const node of (data.hierarchy ?? [])) {
            if (node.kind !== 1 || node.border.length < 3) continue;
            let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
            for (const [x, z] of node.border) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (z < z0) z0 = z; if (z > z1) z1 = z;
            }
            const d = Math.sqrt((x1 - x0) ** 2 + (z1 - z0) ** 2);
            if (d > maxPkgDiag) maxPkgDiag = d;
        }

        // Largest directory diagonal
        let maxDirDiag = 0;
        for (const node of (data.hierarchy ?? [])) {
            if (node.kind !== 2 || node.border.length < 3) continue;
            let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
            for (const [x, z] of node.border) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (z < z0) z0 = z; if (z > z1) z1 = z;
            }
            const d = Math.sqrt((x1 - x0) ** 2 + (z1 - z0) ** 2);
            if (d > maxDirDiag) maxDirDiag = d;
        }

        if (maxPkgDiag === 0) maxPkgDiag = graphDiag * 0.4;
        if (maxDirDiag === 0) maxDirDiag = maxPkgDiag * 0.3;

        // LOD thresholds (camera distance):
        // LOD 0→1: entire graph fills 100% of viewport diagonal
        // LOD 1→2: largest package fills 50% of viewport
        // LOD 2→3: largest directory fills 50% of viewport
        // LOD 3→4: directory fills 200% (very close)
        this._lodThresholds = [
            graphDiag / (1.0 * visPerDist),
            maxPkgDiag / (0.5 * visPerDist),
            maxDirDiag / (0.5 * visPerDist),
            maxDirDiag / (2.0 * visPerDist),
        ];

        console.log('LOD thresholds:', this._lodThresholds.map(t => t.toFixed(0)),
            `graph=${graphDiag.toFixed(0)} pkg=${maxPkgDiag.toFixed(0)} dir=${maxDirDiag.toFixed(0)}`);
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
        const t = this._lodThresholds;
        if (distance > t[0]) return 0;
        if (distance > t[1]) return 1;
        if (distance > t[2]) return 2;
        if (distance > t[3]) return 3;
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
        // Progressive disclosure: at far zoom fills show solid region color,
        // at close zoom individual tiles become visible with type-based color.
        if (this.tileGrid && this.data) {
            for (let i = 0; i < this.data.tileCount; i++) {
                const isFiller = this.data.tileIsFiller?.[i] ?? 0;

                if (level >= 3) {
                    // Close zoom: full detail
                    this.tileGrid.setOpacity(i, isFiller ? 0.3 : 1.0);
                    if (this.fillGrid) this.fillGrid.setOpacity(i, isFiller ? 0.15 : 0.4);
                } else if (level >= 2) {
                    // Files visible: tiles appear, fills as background
                    this.tileGrid.setOpacity(i, isFiller ? 0.15 : 0.6);
                    if (this.fillGrid) this.fillGrid.setOpacity(i, isFiller ? 0.1 : 0.4);
                } else if (level >= 1) {
                    // Directories: fills show dir-level color, tiles dimmed
                    this.tileGrid.setOpacity(i, 0.0);
                    if (this.fillGrid) this.fillGrid.setOpacity(i, isFiller ? 0.2 : 0.7);
                } else {
                    // Packages only: fills show solid package color
                    this.tileGrid.setOpacity(i, 0.0);
                    if (this.fillGrid) this.fillGrid.setOpacity(i, isFiller ? 0.3 : 0.85);
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
