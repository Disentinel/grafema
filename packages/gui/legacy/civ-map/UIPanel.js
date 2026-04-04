export class UIPanel {
    /**
     * @param {import('./DataLoader.js').DataLoader} data
     * @param {import('./EdgeRenderer.js').EdgeRenderer} edgeRenderer
     * @param {import('./LODController.js').LODController} lodController
     * @param {import('./HexGrid.js').HexGrid} tileGrid
     */
    constructor(data, edgeRenderer, lodController, tileGrid) {
        this.data = data;
        this.edgeRenderer = edgeRenderer;
        this.lodController = lodController;
        this.tileGrid = tileGrid;

        this._tooltipEl = document.getElementById('tooltip');
        this._statsEl = document.getElementById('stats-panel');
        this._edgePanelEl = document.getElementById('edge-panel');
        this._typePanelEl = document.getElementById('type-panel');
        this._lodSliderEl = document.getElementById('lod-slider');
        this._searchInput = document.getElementById('search-input');
        this._searchResults = document.getElementById('search-results');
        this._activeBadge = document.getElementById('active-badge');
        this._activeCount = document.getElementById('active-count');

        this._init();
    }

    _init() {
        this._buildStats();
        this._buildEdgePanel();
        this._buildTypePanel();
        this._buildLodSlider();
        this._setupSearch();
    }

    _buildStats() {
        if (!this._statsEl) return;
        const meta = this.data.metadata;
        const hierLevels = new Set(this.data.hierarchy.map(h => h.level)).size;

        this._statsEl.innerHTML = `
            <div class="stat-row"><span>Tiles</span><span>${this.data.tileCount.toLocaleString()}</span></div>
            <div class="stat-row"><span>Edges</span><span>${this.data.edgeCount.toLocaleString()}</span></div>
            <div class="stat-row"><span>Regions</span><span>${meta?.regions?.length ?? 0}</span></div>
            <div class="stat-row"><span>Hierarchy levels</span><span>${hierLevels}</span></div>
            <div class="stat-row"><span>Containers</span><span>${meta?.containers?.length ?? 0}</span></div>
            <div class="stat-row"><span>Max depth</span><span>${meta?.max_depth ?? 0}</span></div>
        `;
    }

    _buildEdgePanel() {
        if (!this._edgePanelEl) return;
        const etTable = this.data.metadata?.edge_type_table ?? [];

        // Count edges per type
        const counts = new Map();
        for (let i = 0; i < this.data.edgeCount; i++) {
            const t = this.data.edgeType[i];
            counts.set(t, (counts.get(t) ?? 0) + 1);
        }

        let html = '<div class="panel-title">Edge Types</div>';
        html += '<div class="panel-buttons"><button id="edges-all">All</button><button id="edges-none">None</button></div>';

        for (let i = 0; i < etTable.length; i++) {
            const name = etTable[i];
            const count = counts.get(i) ?? 0;
            html += `
                <label class="edge-type-row">
                    <input type="checkbox" data-edge-type="${i}" checked>
                    <span class="edge-swatch" style="background:${this._edgeColor(name)}"></span>
                    <span>${name}</span>
                    <span class="edge-count">${count}</span>
                </label>`;
        }

        // Sliders
        html += `
            <div class="slider-group">
                <label>Brightness <input type="range" id="edge-brightness" min="50" max="500" value="100"></label>
                <label>Opacity <input type="range" id="edge-opacity" min="10" max="100" value="60"></label>
                <label>Thickness <input type="range" id="edge-thickness" min="1" max="8" value="2"></label>
                <label>Max edges <input type="range" id="edge-max" min="500" max="50000" value="5000" step="500"></label>
            </div>`;

        this._edgePanelEl.innerHTML = html;

        // Event handlers
        this._edgePanelEl.querySelectorAll('input[data-edge-type]').forEach(cb => {
            cb.addEventListener('change', () => this._onEdgeTypeToggle());
        });
        document.getElementById('edges-all')?.addEventListener('click', () => this._toggleAllEdges(true));
        document.getElementById('edges-none')?.addEventListener('click', () => this._toggleAllEdges(false));

        ['edge-brightness', 'edge-opacity', 'edge-thickness', 'edge-max'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', () => this._onEdgeSettingsChange());
        });
    }

    _buildTypePanel() {
        if (!this._typePanelEl) return;
        const typeTable = this.data.metadata?.type_table ?? [];

        // Count tiles per type
        const counts = new Map();
        for (let i = 0; i < this.data.tileCount; i++) {
            const t = this.data.tileTypeIdx[i];
            counts.set(t, (counts.get(t) ?? 0) + 1);
        }

        // Sort by count descending
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

        let html = '<div class="panel-title">Node Types</div>';
        html += '<div class="panel-buttons"><button id="types-all">All</button><button id="types-none">None</button><button id="types-defs">Defs</button></div>';

        for (const [typeIdx, count] of sorted) {
            const name = typeTable[typeIdx] ?? 'UNKNOWN';
            html += `
                <label class="type-row">
                    <input type="checkbox" data-node-type="${typeIdx}" checked>
                    <span>${name}</span>
                    <span class="type-count">${count}</span>
                </label>`;
        }

        this._typePanelEl.innerHTML = html;

        this._typePanelEl.querySelectorAll('input[data-node-type]').forEach(cb => {
            cb.addEventListener('change', () => this._onTypeToggle());
        });
        document.getElementById('types-all')?.addEventListener('click', () => this._toggleAllTypes(true));
        document.getElementById('types-none')?.addEventListener('click', () => this._toggleAllTypes(false));
        document.getElementById('types-defs')?.addEventListener('click', () => this._toggleDefinitions());
    }

    _buildLodSlider() {
        if (!this._lodSliderEl) return;
        const maxLevel = this.lodController.maxLevel;
        this._lodSliderEl.innerHTML = `
            <label>Detail Level
                <input type="range" id="lod-range" min="0" max="4" value="4" step="1">
                <span id="lod-value">Auto</span>
            </label>`;

        document.getElementById('lod-range')?.addEventListener('input', e => {
            const val = parseInt(e.target.value);
            // 4 = auto, 0-3 = manual levels
            if (val >= 4) {
                this.lodController.setManualLevel(null);
                document.getElementById('lod-value').textContent = 'Auto';
            } else {
                this.lodController.setManualLevel(val);
                const labels = ['Packages', 'Directories', 'Files', 'Functions'];
                document.getElementById('lod-value').textContent = labels[val] ?? val;
            }
        });
    }

    _setupSearch() {
        if (!this._searchInput) return;

        let debounceTimer;
        let results = [];
        let selectedIdx = -1;

        this._searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            const q = this._searchInput.value.trim();
            if (!q) {
                this._searchResults.style.display = 'none';
                return;
            }
            debounceTimer = setTimeout(() => this._doSearch(q), 200);
        });

        this._searchInput.addEventListener('keydown', (e) => {
            const items = this._searchResults?.querySelectorAll('.search-item') ?? [];
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
                this._highlightSearchResult(items, selectedIdx);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIdx = Math.max(selectedIdx - 1, 0);
                this._highlightSearchResult(items, selectedIdx);
            } else if (e.key === 'Enter' && selectedIdx >= 0 && selectedIdx < items.length) {
                e.preventDefault();
                items[selectedIdx].click();
            } else if (e.key === 'Escape') {
                this._searchResults.style.display = 'none';
                this._searchInput.blur();
            }
        });

        // Store for external access
        this._searchSelectedIdx = () => selectedIdx;
        this._resetSearchIdx = () => { selectedIdx = -1; };
    }

    async _doSearch(query) {
        try {
            const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=20`);
            const results = await resp.json();
            this._renderSearchResults(results);
        } catch {
            this._searchResults.style.display = 'none';
        }
    }

    _renderSearchResults(results) {
        if (!this._searchResults) return;
        if (results.length === 0) {
            this._searchResults.style.display = 'none';
            return;
        }

        this._searchResults.style.display = 'block';
        this._searchResults.innerHTML = results.map((r, i) => {
            const icon = r.isContainer ? '&#x1f4e6;' : '&bull;';
            const file = r.file ? r.file.split('/').slice(-2).join('/') : '';
            return `<div class="search-item" data-idx="${i}" data-world-x="${r.worldX}" data-world-z="${r.worldZ}" data-tile="${r.tileIndex ?? ''}" data-container="${r.containerIdx ?? ''}">
                <span class="search-icon">${icon}</span>
                <span class="search-name">${r.name}</span>
                <span class="search-type">${r.type}</span>
                <span class="search-file">${file}</span>
            </div>`;
        }).join('');

        this._searchResults.querySelectorAll('.search-item').forEach(item => {
            item.addEventListener('click', () => {
                const wx = parseFloat(item.dataset.worldX);
                const wz = parseFloat(item.dataset.worldZ);
                const tileIdx = item.dataset.tile;

                if (this.onSearchSelect) {
                    this.onSearchSelect({
                        worldX: wx, worldZ: wz,
                        tileIndex: tileIdx !== '' ? parseInt(tileIdx) : null,
                        containerIdx: item.dataset.container !== '' ? parseInt(item.dataset.container) : null,
                    });
                }

                this._searchResults.style.display = 'none';
                this._searchInput.value = '';
            });
        });
    }

    _highlightSearchResult(items, idx) {
        items.forEach((item, i) => {
            item.classList.toggle('selected', i === idx);
        });
    }

    // Tooltip — follows cursor, shows edge breakdown
    showTooltip(data, mouseX, mouseY) {
        if (!this._tooltipEl) return;
        if (!data) {
            this._tooltipEl.style.display = 'none';
            return;
        }

        // Position near cursor
        this._tooltipEl.style.position = 'fixed';
        this._tooltipEl.style.left = (mouseX + 16) + 'px';
        this._tooltipEl.style.top = (mouseY - 10) + 'px';
        this._tooltipEl.style.right = 'auto';

        // Edge type breakdown
        let edgeHtml = '';
        if (data.edgeBreakdown && Object.keys(data.edgeBreakdown).length > 0) {
            const lines = Object.entries(data.edgeBreakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => {
                    const color = this._edgeColor(type);
                    return `<span style="color:${color}">${type}</span>: ${count}`;
                })
                .join(' · ');
            edgeHtml = `<div class="tt-edges">${lines}</div>`;
        }

        this._tooltipEl.style.display = 'block';
        this._tooltipEl.innerHTML = `
            <div class="tt-type">${data.type}${data.isFiller ? ' (filler)' : ''}</div>
            ${data.name ? `<div class="tt-name">${data.name}</div>` : ''}
            <div class="tt-file">${data.file}</div>
            <div class="tt-degree">Connections: ${data.degree}</div>
            ${edgeHtml}
        `;
    }

    // Active badge
    updateActiveBadge(count) {
        if (!this._activeBadge) return;
        this._activeBadge.style.display = count > 0 ? 'flex' : 'none';
        if (this._activeCount) this._activeCount.textContent = count;
    }

    // Edge panel helpers
    _edgeColor(name) {
        const colors = {
            CALLS: '#ff6b6b', READS_FROM: '#4ecdc4', WRITES_TO: '#ffe66d',
            RETURNS: '#a8e6cf', INHERITS: '#dda0dd', IMPLEMENTS: '#b0e0e6',
            IMPORTS: '#87ceeb', EXPORTS: '#ffa07a', TYPE_OF: '#d8bfd8',
            ARGUMENT_OF: '#f0e68c', CONDITION_OF: '#ffb6c1',
        };
        return colors[name] ?? '#666666';
    }

    _onEdgeTypeToggle() {
        this.edgeRenderer.visibleTypes.clear();
        this._edgePanelEl.querySelectorAll('input[data-edge-type]:checked').forEach(cb => {
            this.edgeRenderer.visibleTypes.add(parseInt(cb.dataset.edgeType));
        });
        this.edgeRenderer.refresh();
    }

    _toggleAllEdges(checked) {
        this._edgePanelEl.querySelectorAll('input[data-edge-type]').forEach(cb => {
            cb.checked = checked;
        });
        this._onEdgeTypeToggle();
    }

    _onTypeToggle() {
        const visibleTypes = new Set();
        this._typePanelEl.querySelectorAll('input[data-node-type]:checked').forEach(cb => {
            visibleTypes.add(parseInt(cb.dataset.nodeType));
        });

        for (let i = 0; i < this.data.tileCount; i++) {
            const typeIdx = this.data.tileTypeIdx[i];
            this.tileGrid.setOpacity(i, visibleTypes.has(typeIdx) ? 1.0 : 0.15);
        }
    }

    _toggleAllTypes(checked) {
        this._typePanelEl.querySelectorAll('input[data-node-type]').forEach(cb => {
            cb.checked = checked;
        });
        this._onTypeToggle();
    }

    _toggleDefinitions() {
        const defTypes = ['FUNCTION', 'METHOD', 'CLASS', 'INTERFACE', 'STRUCT', 'ENUM'];
        const typeTable = this.data.metadata?.type_table ?? [];
        this._typePanelEl.querySelectorAll('input[data-node-type]').forEach(cb => {
            const idx = parseInt(cb.dataset.nodeType);
            cb.checked = defTypes.includes(typeTable[idx]);
        });
        this._onTypeToggle();
    }

    _onEdgeSettingsChange() {
        this.edgeRenderer.setSettings({
            brightness: parseInt(document.getElementById('edge-brightness')?.value ?? 100) / 100,
            opacity: parseInt(document.getElementById('edge-opacity')?.value ?? 60) / 100,
            linewidth: parseInt(document.getElementById('edge-thickness')?.value ?? 2),
            maxEdges: parseInt(document.getElementById('edge-max')?.value ?? 5000),
        });
    }

    // Callbacks
    onSearchSelect = null;  // (result) => void

    focusSearch() {
        this._searchInput?.focus();
    }

    dispose() {}
}
