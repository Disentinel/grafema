/**
 * HoverController — manages hover state, raycasting, tooltip, and highlighting.
 *
 * Coordinates between HexLayer instances and EdgeRenderer to provide
 * interactive hover: raycast -> find connected -> highlight layers -> show edges -> tooltip.
 */
import * as THREE from 'three';

export class HoverController {
  /**
   * @param {object} opts
   * @param {THREE.Camera} opts.camera
   * @param {HTMLElement} opts.domElement - renderer canvas
   * @param {import('./hex-layer.js').HexLayer[]} opts.layers - raycast targets (first match wins)
   * @param {import('./edge-renderer.js').EdgeRenderer} opts.edgeRenderer
   * @param {object} opts.edgeData
   * @param {Uint32Array} opts.edgeData.src
   * @param {Uint32Array} opts.edgeData.dst
   * @param {Uint8Array} opts.edgeData.typeIdx
   * @param {string[]} opts.edgeData.typeTable
   * @param {Int32Array} opts.edgeData.globalToSeq
   * @param {object} opts.edgeData.visibility - { edgeTypeName: boolean }
   * @param {object} opts.tileData - per-tile arrays (indexed by sequential idx)
   * @param {Uint8Array} opts.tileData.typeIdx
   * @param {Uint16Array} opts.tileData.degree
   * @param {Uint8Array} opts.tileData.lodLevel
   * @param {Uint32Array} opts.tileData.globalIdx
   * @param {Uint16Array} opts.tileData.regionIdx
   * @param {Float32Array} opts.tileData.worldX
   * @param {Float32Array} opts.tileData.worldZ
   * @param {object} opts.meta - server metadata (regions, type_table)
   * @param {HTMLElement} opts.tooltip - tooltip DOM element
   * @param {function} [opts.onHover] - callback(idx, connectedSet) on hover change
   * @param {function} [opts.onUnhover] - callback() on unhover
   */
  constructor({ camera, domElement, layers, edgeRenderer, edgeData, tileData, meta, tooltip, onHover, onUnhover }) {
    this._camera = camera;
    this._layers = layers;
    this._edgeRenderer = edgeRenderer;
    this._edgeData = edgeData;
    this._tileData = tileData;
    this._meta = meta;
    this._tooltip = tooltip;
    this._onHover = onHover;
    this._onUnhover = onUnhover;

    this._hoveredIdx = -1;
    this._tooltipCache = new Map();
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    domElement.addEventListener('mousemove', (e) => this._onMouseMove(e));
  }

  get hoveredIdx() { return this._hoveredIdx; }

  /** Reset hover state (call on LOD change, etc.) */
  reset() {
    this._hoveredIdx = -1;
    this._tooltip.style.display = 'none';
    this._onUnhover?.();
  }

  _onMouseMove(e) {
    this._mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this._mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this._camera);

    // Raycast all visible layers, take first hit
    let newIdx = -1;
    for (const layer of this._layers) {
      const idx = layer.raycast(this._raycaster);
      if (idx >= 0) { newIdx = idx; break; }
    }

    this._tooltip.style.left = e.clientX + 12 + 'px';
    this._tooltip.style.top = e.clientY + 12 + 'px';

    if (newIdx === this._hoveredIdx) return;
    this._hoveredIdx = newIdx;

    if (newIdx === -1) {
      this._tooltip.style.display = 'none';
      this._onUnhover?.();
      return;
    }

    // Find connected tiles via edges
    const { src, dst, typeIdx, typeTable, globalToSeq, visibility } = this._edgeData;
    const E = src.length;
    const connected = new Set([newIdx]);
    const hoverEdgeIndices = [];

    for (let i = 0; i < E; i++) {
      const si = src[i] < globalToSeq.length ? globalToSeq[src[i]] : -1;
      const di = dst[i] < globalToSeq.length ? globalToSeq[dst[i]] : -1;
      if (si >= 0 && si === newIdx) { connected.add(di); hoverEdgeIndices.push(i); }
      if (di >= 0 && di === newIdx) { connected.add(si); hoverEdgeIndices.push(i); }
    }

    // Highlight all layers
    for (const layer of this._layers) {
      layer.highlight(connected);
    }

    // Show hover edges
    this._edgeRenderer.showEdges(hoverEdgeIndices, {
      edgeSrc: src,
      edgeDst: dst,
      edgeTypeIdx: typeIdx,
      edgeTypeTable: typeTable,
      globalToSeq,
      worldX: this._tileData.worldX,
      worldZ: this._tileData.worldZ,
      visibility,
    });

    this._onHover?.(newIdx, connected);
    this._showTooltip(newIdx);
  }

  async _showTooltip(idx) {
    const { typeIdx, degree, lodLevel, globalIdx, regionIdx } = this._tileData;
    const typeName = this._meta.type_table[typeIdx[idx]] || '?';

    this._tooltip.style.display = 'block';
    this._tooltip.innerHTML = `<div style="color:#00d4ff;font-weight:600">${typeName}</div>
      <div style="color:#555;font-size:0.65rem;margin-top:2px">degree: ${degree[idx]} · lod: ${lodLevel[idx]}</div>
      <div style="color:#444;font-size:0.6rem">loading...</div>`;

    const gIdx = globalIdx[idx];
    if (!this._tooltipCache.has(gIdx)) {
      try {
        const r = await fetch(`/api/node?index=${gIdx}`);
        if (r.ok) this._tooltipCache.set(gIdx, await r.json());
      } catch {}
    }

    const d = this._tooltipCache.get(gIdx);
    if (d && this._hoveredIdx === idx) {
      const metaObj = typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata;
      const line = metaObj?.line || '';
      const regionPath = this._meta.regions[regionIdx[idx]]?.path || '?';
      this._tooltip.innerHTML = `<div style="color:#00d4ff;font-weight:600">${d.type}</div>
        <div style="margin-top:2px">${d.name || '(anonymous)'}</div>
        <div style="color:#555;font-size:0.65rem;margin-top:2px">${d.file || ''}${line ? ':' + line : ''}</div>
        <div style="color:#444;font-size:0.6rem;margin-top:2px">degree: ${degree[idx]} · region: ${regionPath}</div>`;
    }
  }
}
