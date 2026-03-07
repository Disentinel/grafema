/**
 * Shared utilities for Grafema 3D views
 */

// Node type → color mapping
export const NODE_COLORS = {
  MODULE:           0x00d4ff,
  FUNCTION:         0x4488ff,
  CLASS:            0x22cc88,
  METHOD:           0x33bb77,
  GETTER:           0x33aa66,
  VARIABLE:         0xaa66ff,
  PARAMETER:        0x8855dd,
  CONSTANT:         0xffaa00,
  LITERAL:          0x887744,
  CALL:             0xff4466,
  IMPORT:           0x66aacc,
  EXPORT:           0x66ccaa,
  SCOPE:            0x333355,
  BRANCH:           0xddaa33,
  LOOP:             0xdd8833,
  EXPRESSION:       0x665588,
  PROPERTY_ACCESS:  0x7766aa,
  PROPERTY:         0x6655aa,
  PROPERTY_ASSIGNMENT: 0x7766aa,
  EXTERNAL:         0xff6633,
  EXTERNAL_MODULE:  0xff8844,
  PROJECT:          0xffffff,
  SERVICE:          0x00ffaa,
  FILE:             0x335577,
  SIDE_EFFECT:      0xff3355,
  INTERFACE:        0x44bbaa,
  TYPE_ALIAS:       0x33aa99,
  TYPE_REFERENCE:   0x226655,
  LITERAL_TYPE:     0x556644,
  TRY_BLOCK:        0x886633,
  CATCH_BLOCK:      0xaa4422,
  FINALLY_BLOCK:    0x885533,
  CASE:             0xbbaa33,
  // Namespaced
  'http:route':     0x00ff88,
  'http:request':   0x00cc66,
  'db:query':       0xff6600,
  'redis:read':     0xcc3300,
  'redis:write':    0xff4400,
  'grafema:plugin': 0x00ffdd,
};

export const DEFAULT_COLOR = 0x444466;

// Edge type → color mapping
export const EDGE_COLORS = {
  CALLS:          0xff4466,
  CALLS_ON:       0xdd3355,
  IMPORTS_FROM:   0x00d4ff,
  DEPENDS_ON:     0x00aacc,
  CONTAINS:       0x222233,
  HAS_SCOPE:      0x1a1a33,
  HAS_BODY:       0x1a1a33,
  EXTENDS:        0x22cc88,
  IMPLEMENTS:     0x22aa77,
  ASSIGNED_FROM:  0xaa66ff,
  FLOWS_INTO:     0x8855dd,
  READS_FROM:     0x443366,
  WRITES_TO:      0xbb44ff,
  DEFINES:        0x445566,
  USES:           0x334455,
  DECLARES:       0x334466,
  MODIFIES:       0x664488,
  RETURNS:        0x33aaff,
  HAS_MEMBER:     0x228866,
  HANDLED_BY:     0x00ff88,
  ROUTES_TO:      0x00dd77,
  HAS_PROPERTY:   0x444466,
  HAS_CONDITION:  0x665533,
  HAS_CONSEQUENT: 0x554422,
  CAPTURES:       0x556677,
  PASSES_ARGUMENT: 0x553344,
  RECEIVES_ARGUMENT: 0x443355,
  HAS_TYPE:       0x224444,
  EXPORTS:        0x55aa88,
  IMPORTS:        0x5588aa,
};

export const DEFAULT_EDGE_COLOR = 0x181822;

export function colorToVec3(hex) {
  return [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  ];
}

/**
 * Fetch graph data as compact binary.
 * Returns { header, nodeTypes, nodeFiles, edges, nodeIds }
 *
 * Binary format:
 *   [headerLen:u32LE][headerJSON][nodeDataLen:u32LE][nodeData][edgeDataLen:u32LE][edgeData][idTableLen:u32LE][idTable]
 *   nodeData: per node [typeIdx:u8][fileIdx:u16LE] = 3 bytes
 *   edgeData: per edge [src:u32LE][dst:u32LE][typeIdx:u8] = 9 bytes
 */
export async function fetchGraphBinary({ nodeTypes, edgeTypes, onProgress } = {}) {
  const params = new URLSearchParams();
  if (nodeTypes) params.set('nodeTypes', nodeTypes.join(','));
  if (edgeTypes) params.set('edgeTypes', edgeTypes.join(','));

  const res = await fetch(`/api/graph-binary?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  onProgress?.('Downloading...');
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  let offset = 0;

  // Header (length-prefixed JSON)
  const headerLen = view.getUint32(offset, true); offset += 4;
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, offset, headerLen)));
  offset += headerLen;

  onProgress?.(`Parsing ${header.nodeCount.toLocaleString()} nodes...`);

  // Node data: [typeIdx:u8][x:f32LE][y:f32LE][z:f32LE] × N = 13 bytes each
  const N = header.nodeCount;
  const nodeView = new DataView(buf, offset, N * 13);
  offset += N * 13;

  const nodeTypeIndices = new Uint8Array(N);
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const o = i * 13;
    nodeTypeIndices[i] = nodeView.getUint8(o);
    positions[i * 3]     = nodeView.getFloat32(o + 1, true);
    positions[i * 3 + 1] = nodeView.getFloat32(o + 5, true);
    positions[i * 3 + 2] = nodeView.getFloat32(o + 9, true);
  }

  // Edge data: [src:u32LE][dst:u32LE][typeIdx:u8] × E = 9 bytes each
  const E = header.edgeCount;
  const edgeView = new DataView(buf, offset, E * 9);
  offset += E * 9;

  const edgeSrc = new Uint32Array(E);
  const edgeDst = new Uint32Array(E);
  const edgeTypeIndices = new Uint8Array(E);
  for (let i = 0; i < E; i++) {
    edgeSrc[i] = edgeView.getUint32(i * 9, true);
    edgeDst[i] = edgeView.getUint32(i * 9 + 4, true);
    edgeTypeIndices[i] = edgeView.getUint8(i * 9 + 8);
  }

  onProgress?.('Ready');

  return {
    header,
    nodeTypeIndices,   // Uint8Array[N] — index into header.typeTable
    positions,         // Float32Array[N*3] — x,y,z pre-computed on server
    edgeSrc,           // Uint32Array[E]
    edgeDst,           // Uint32Array[E]
    edgeTypeIndices,   // Uint8Array[E] — index into header.edgeTypeTable
  };
}

/**
 * Fetch extended binary graph with directory index + batch number.
 * 16-byte nodes: [typeIdx:u8][x:f32][y:f32][z:f32][dirIdx:u16][batch:u8]
 *
 * Returns { header, nodeTypeIndices, positions, dirIndices, batches,
 *           edgeSrc, edgeDst, edgeTypeIndices }
 *   header.directories: [{ path, cx, cz, radius, depth }]
 */
export async function fetchGraphBinaryFull({ nodeTypes, edgeTypes, limit, batchSize, onProgress } = {}) {
  const params = new URLSearchParams();
  if (nodeTypes) params.set('nodeTypes', nodeTypes.join(','));
  if (edgeTypes) params.set('edgeTypes', edgeTypes.join(','));
  if (limit) params.set('limit', String(limit));
  if (batchSize) params.set('batchSize', String(batchSize));

  const res = await fetch(`/api/graph-binary-full?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  onProgress?.('Downloading...');
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  let offset = 0;

  const headerLen = view.getUint32(offset, true); offset += 4;
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, offset, headerLen)));
  offset += headerLen;

  onProgress?.(`Parsing ${header.nodeCount.toLocaleString()} nodes...`);

  const N = header.nodeCount;
  const nodeView = new DataView(buf, offset, N * 16);
  offset += N * 16;

  const nodeTypeIndices = new Uint8Array(N);
  const positions = new Float32Array(N * 3);
  const dirIndices = new Uint16Array(N);
  const batches = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    const o = i * 16;
    nodeTypeIndices[i] = nodeView.getUint8(o);
    positions[i * 3]     = nodeView.getFloat32(o + 1, true);
    positions[i * 3 + 1] = nodeView.getFloat32(o + 5, true);
    positions[i * 3 + 2] = nodeView.getFloat32(o + 9, true);
    dirIndices[i]        = nodeView.getUint16(o + 13, true);
    batches[i]           = nodeView.getUint8(o + 15);
  }

  const E = header.edgeCount;
  const edgeView = new DataView(buf, offset, E * 9);
  offset += E * 9;

  const edgeSrc = new Uint32Array(E);
  const edgeDst = new Uint32Array(E);
  const edgeTypeIndices = new Uint8Array(E);
  for (let i = 0; i < E; i++) {
    edgeSrc[i] = edgeView.getUint32(i * 9, true);
    edgeDst[i] = edgeView.getUint32(i * 9 + 4, true);
    edgeTypeIndices[i] = edgeView.getUint8(i * 9 + 8);
  }

  onProgress?.('Ready');

  return {
    header,
    nodeTypeIndices,
    positions,
    dirIndices,
    batches,
    edgeSrc,
    edgeDst,
    edgeTypeIndices,
  };
}

/**
 * Fetch single node details (on hover/click)
 */
export async function fetchNodeDetails(id) {
  const res = await fetch(`/api/node?id=${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Build directory tree from nodes for geographic layout.
 * Returns Map<dirPath, nodeIndices[]>
 */
export function buildDirectoryTree(nodes) {
  const dirs = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const file = nodes[i].f || '';
    const dir = file.substring(0, file.lastIndexOf('/')) || '/';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(i);
  }
  return dirs;
}

/**
 * Treemap layout: assigns rectangular regions to directories.
 */
export function treemapLayout(dirs, totalWidth = 200, totalHeight = 200) {
  const entries = [...dirs.entries()]
    .map(([path, indices]) => ({ path, count: indices.length, indices }))
    .sort((a, b) => b.count - a.count);

  const total = entries.reduce((s, e) => s + e.count, 0);
  const regions = new Map();
  squarify(entries, 0, 0, totalWidth, totalHeight, total, regions);
  return regions;
}

function squarify(items, x, z, w, h, total, regions) {
  if (items.length === 0) return;
  if (items.length === 1) {
    regions.set(items[0].path, { x, z, w, h, indices: items[0].indices });
    return;
  }

  const horizontal = w >= h;
  let sum = 0;
  let splitIdx = 0;
  const half = total / 2;

  for (let i = 0; i < items.length; i++) {
    sum += items[i].count;
    if (sum >= half) { splitIdx = i + 1; break; }
  }
  if (splitIdx === 0) splitIdx = 1;
  if (splitIdx >= items.length) splitIdx = items.length - 1;

  const ratio = sum / total;
  const left = items.slice(0, splitIdx);
  const right = items.slice(splitIdx);
  const leftTotal = left.reduce((s, e) => s + e.count, 0);
  const rightTotal = right.reduce((s, e) => s + e.count, 0);

  if (horizontal) {
    const splitW = w * ratio;
    squarify(left, x, z, splitW, h, leftTotal, regions);
    squarify(right, x + splitW, z, w - splitW, h, rightTotal, regions);
  } else {
    const splitH = h * ratio;
    squarify(left, x, z, w, splitH, leftTotal, regions);
    squarify(right, x, z + splitH, w, h - splitH, rightTotal, regions);
  }
}

/**
 * Compute geographic positions for all nodes.
 */
export function computeGeographicPositions(nodes, mapSize = 200) {
  const dirs = buildDirectoryTree(nodes);
  const regions = treemapLayout(dirs, mapSize, mapSize);
  const positions = new Float32Array(nodes.length * 3);
  const halfSize = mapSize / 2;

  for (const [, region] of regions) {
    const { x, z, w, h, indices } = region;
    const count = indices.length;

    for (let i = 0; i < count; i++) {
      const idx = indices[i];
      let nx, nz;

      if (count === 1) {
        nx = x + w / 2;
        nz = z + h / 2;
      } else {
        const angle = i * 2.399963;
        const radius = Math.sqrt(i / count) * Math.min(w, h) * 0.45;
        nx = x + w / 2 + Math.cos(angle) * radius;
        nz = z + h / 2 + Math.sin(angle) * radius;
      }

      positions[idx * 3] = nx - halfSize;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = nz - halfSize;
    }
  }

  return positions;
}

/**
 * Compute node colors from type
 */
export function computeNodeColors(nodes) {
  const colors = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    const hex = NODE_COLORS[nodes[i].t] || DEFAULT_COLOR;
    colors[i * 3] = ((hex >> 16) & 0xff) / 255;
    colors[i * 3 + 1] = ((hex >> 8) & 0xff) / 255;
    colors[i * 3 + 2] = (hex & 0xff) / 255;
  }
  return colors;
}

/**
 * Compute node sizes from type
 */
export function computeNodeSizes(nodes) {
  const sizes = new Float32Array(nodes.length);
  const sizeMap = {
    PROJECT: 8, SERVICE: 6, MODULE: 4, CLASS: 3, FUNCTION: 2,
    METHOD: 1.8, GETTER: 1.8, INTERFACE: 2.5, VARIABLE: 1,
    CALL: 0.8, IMPORT: 0.8, EXPORT: 0.8, EXPRESSION: 0.6,
    LITERAL: 0.5, PROPERTY_ACCESS: 0.5, TYPE_REFERENCE: 0.4,
  };
  for (let i = 0; i < nodes.length; i++) {
    sizes[i] = sizeMap[nodes[i].t] || 0.7;
  }
  return sizes;
}

/**
 * Create edge position arrays
 */
export function computeEdgePositions(edges, nodePositions) {
  const positions = new Float32Array(edges.length * 6);
  const colors = new Float32Array(edges.length * 6);

  for (let i = 0; i < edges.length; i++) {
    const [si, di, type] = edges[i];
    const offset = i * 6;
    positions[offset] = nodePositions[si * 3];
    positions[offset + 1] = nodePositions[si * 3 + 1];
    positions[offset + 2] = nodePositions[si * 3 + 2];
    positions[offset + 3] = nodePositions[di * 3];
    positions[offset + 4] = nodePositions[di * 3 + 1];
    positions[offset + 5] = nodePositions[di * 3 + 2];

    const hex = EDGE_COLORS[type] || DEFAULT_EDGE_COLOR;
    const r = ((hex >> 16) & 0xff) / 255;
    const g = ((hex >> 8) & 0xff) / 255;
    const b = (hex & 0xff) / 255;
    colors[offset] = r;     colors[offset + 1] = g;     colors[offset + 2] = b;
    colors[offset + 3] = r; colors[offset + 4] = g;     colors[offset + 5] = b;
  }

  return { positions, colors };
}

/**
 * HUD overlay
 */
export function createHUD(title) {
  const hud = document.createElement('div');
  hud.innerHTML = `
    <div style="position:fixed;top:0;left:0;right:0;padding:16px 24px;
      background:linear-gradient(180deg,rgba(10,10,15,0.9),transparent);
      pointer-events:none;z-index:100">
      <div style="font-size:0.7rem;letter-spacing:0.15em;color:#555;margin-bottom:4px">GRAFEMA</div>
      <div style="font-size:1.2rem;font-weight:300;color:#e0e0e0">${title}</div>
      <div id="hud-stats" style="font-size:0.75rem;color:#666;margin-top:4px"></div>
      <div id="hud-progress" style="font-size:0.7rem;color:#444;margin-top:2px"></div>
    </div>
    <div id="hud-tooltip" style="position:fixed;display:none;padding:8px 12px;
      background:rgba(18,18,26,0.95);border:1px solid #2a2a4e;border-radius:6px;
      font-size:0.75rem;color:#ccc;pointer-events:none;z-index:200;max-width:400px">
    </div>
    <div style="position:fixed;bottom:16px;left:24px;font-size:0.7rem;color:#444;pointer-events:none;z-index:100">
      Orbit: drag &middot; Zoom: scroll &middot; Pan: right-drag
    </div>
    <a href="/" style="position:fixed;top:16px;right:24px;color:#555;text-decoration:none;
      font-size:0.8rem;z-index:100;pointer-events:all">&larr; Back</a>
  `;
  document.body.appendChild(hud);
  return {
    setStats: (text) => document.getElementById('hud-stats').textContent = text,
    setProgress: (text) => document.getElementById('hud-progress').textContent = text,
    tooltip: document.getElementById('hud-tooltip'),
  };
}

/**
 * Loading overlay
 */
export function showLoading(message = 'Loading graph...') {
  const el = document.createElement('div');
  el.id = 'loading';
  el.style.cssText = `position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    background:#0a0a0f;color:#555;font-size:0.9rem;z-index:1000;letter-spacing:0.05em`;
  el.textContent = message;
  document.body.appendChild(el);
  return {
    update: (msg) => el.textContent = msg,
    hide: () => el.remove(),
  };
}

/**
 * Convert cube coordinates to world position.
 */
export function cubeToWorld(q, r, tileSize) {
  const x = tileSize * (3/2 * q);
  const z = tileSize * (Math.sqrt(3)/2 * q + Math.sqrt(3) * r);
  return { x, z };
}

/**
 * Fetch hex-tile graph data from /api/graph-hex.
 * Binary format: [headerLen:u32LE][headerJSON][nodes: N×8][edges: E×9][aggEdges: A×7]
 */
export async function fetchGraphHex({ limit, tileSize, structureOnly, nodeTypes, edgeTypes, onProgress } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (tileSize) params.set('tileSize', String(tileSize));
  if (structureOnly) params.set('structureOnly', 'true');
  if (nodeTypes) params.set('nodeTypes', nodeTypes.join(','));
  if (edgeTypes) params.set('edgeTypes', edgeTypes.join(','));

  const res = await fetch(`/api/graph-hex?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  onProgress?.('Downloading...');
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  let offset = 0;

  const headerLen = view.getUint32(offset, true); offset += 4;
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, offset, headerLen)));
  offset += headerLen;

  const N = header.nodeCount;
  const E = header.edgeCount;
  const A = header.aggEdgeCount;

  onProgress?.(`Parsing ${N.toLocaleString()} nodes...`);

  // Node: 8 bytes = [typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8]
  const nodeTypeIndices = new Uint8Array(N);
  const nodeQ = new Int16Array(N);
  const nodeR = new Int16Array(N);
  const nodeDegree = new Uint16Array(N);
  const nodeFlags = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    nodeTypeIndices[i] = view.getUint8(offset);
    nodeQ[i] = view.getInt16(offset + 1, true);
    nodeR[i] = view.getInt16(offset + 3, true);
    nodeDegree[i] = view.getUint16(offset + 5, true);
    nodeFlags[i] = view.getUint8(offset + 7);
    offset += 8;
  }

  // Edge: 9 bytes = [src:u32LE][dst:u32LE][typeIdx:u8]
  const edgeSrc = new Uint32Array(E);
  const edgeDst = new Uint32Array(E);
  const edgeTypeIndices = new Uint8Array(E);

  for (let i = 0; i < E; i++) {
    edgeSrc[i] = view.getUint32(offset, true);
    edgeDst[i] = view.getUint32(offset + 4, true);
    edgeTypeIndices[i] = view.getUint8(offset + 8);
    offset += 9;
  }

  // AggEdge: 7 bytes = [srcRegion:u16][dstRegion:u16][count:u16][typeIdx:u8]
  const aggSrcRegion = new Uint16Array(A);
  const aggDstRegion = new Uint16Array(A);
  const aggCount = new Uint16Array(A);
  const aggTypeIdx = new Uint8Array(A);

  for (let i = 0; i < A; i++) {
    aggSrcRegion[i] = view.getUint16(offset, true);
    aggDstRegion[i] = view.getUint16(offset + 2, true);
    aggCount[i] = view.getUint16(offset + 4, true);
    aggTypeIdx[i] = view.getUint8(offset + 6);
    offset += 7;
  }

  onProgress?.('Ready');

  return {
    header, nodeTypeIndices, nodeQ, nodeR, nodeDegree, nodeFlags,
    edgeSrc, edgeDst, edgeTypeIndices,
    aggSrcRegion, aggDstRegion, aggCount, aggTypeIdx,
  };
}

/**
 * Fetch hex topology stream from /api/hex-stream.
 * Wire format: repeating [batchType:u8][batchLen:u32LE][payload...]
 *
 * Batch type 0: JSON metadata (regions, type tables, agg edges)
 * Batch type 1: Binary region data
 *   [regionIdx:u16LE][tileCount:u32LE]
 *   tiles × [globalIdx:u32LE][typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8][lodLevel:u8] = 13 bytes
 *   [edgeCount:u32LE]
 *   edges × [src:u32LE][dst:u32LE][typeIdx:u8] = 9 bytes
 *
 * Returns { meta, tiles, edges } where:
 *   meta: { regions, typeTable, edgeTypeTable, tileSize, totalTiles, totalEdges, aggEdges }
 *   tiles: { globalIdx, typeIdx, q, r, degree, flags, lodLevel, regionIdx }[] (typed arrays)
 *   edges: { src, dst, typeIdx }[] (typed arrays)
 */
export async function fetchHexStream({ onProgress, onBatch } = {}) {
  const res = await fetch('/api/hex-stream');
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  onProgress?.('Downloading...');
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  let offset = 0;

  let meta = null;

  // Collect all tiles and edges across batches
  const allTiles = [];
  const allEdges = [];

  while (offset < buf.byteLength) {
    const batchType = view.getUint8(offset); offset += 1;
    const batchLen = view.getUint32(offset, true); offset += 4;

    if (batchType === 0) {
      // Region metadata (JSON)
      const json = new TextDecoder().decode(new Uint8Array(buf, offset, batchLen));
      meta = JSON.parse(json);
      onProgress?.(`Metadata: ${meta.total_tiles.toLocaleString()} tiles, ${meta.regions.length} regions`);
    } else if (batchType === 1) {
      // Binary region tile data
      let bOff = offset;
      const regionIdx = view.getUint16(bOff, true); bOff += 2;
      const tileCount = view.getUint32(bOff, true); bOff += 4;

      for (let i = 0; i < tileCount; i++) {
        const globalIdx = view.getUint32(bOff, true); bOff += 4;
        const typeIdx = view.getUint8(bOff); bOff += 1;
        const q = view.getInt16(bOff, true); bOff += 2;
        const r = view.getInt16(bOff, true); bOff += 2;
        const degree = view.getUint16(bOff, true); bOff += 2;
        const flags = view.getUint8(bOff); bOff += 1;
        const lodLevel = view.getUint8(bOff); bOff += 1;
        allTiles.push({ globalIdx, typeIdx, q, r, degree, flags, lodLevel, regionIdx });
      }

      const edgeCount = view.getUint32(bOff, true); bOff += 4;
      for (let i = 0; i < edgeCount; i++) {
        const src = view.getUint32(bOff, true); bOff += 4;
        const dst = view.getUint32(bOff, true); bOff += 4;
        const typeIdx = view.getUint8(bOff); bOff += 1;
        allEdges.push({ src, dst, typeIdx });
      }

      onBatch?.(regionIdx, tileCount, edgeCount);
    }

    offset += batchLen;
  }

  // Build typed arrays for fast rendering
  const N = allTiles.length;
  const E = allEdges.length;

  const tileGlobalIdx = new Uint32Array(N);
  const tileTypeIdx = new Uint8Array(N);
  const tileQ = new Int16Array(N);
  const tileR = new Int16Array(N);
  const tileDegree = new Uint16Array(N);
  const tileFlags = new Uint8Array(N);
  const tileLodLevel = new Uint8Array(N);
  const tileRegionIdx = new Uint16Array(N);

  for (let i = 0; i < N; i++) {
    const t = allTiles[i];
    tileGlobalIdx[i] = t.globalIdx;
    tileTypeIdx[i] = t.typeIdx;
    tileQ[i] = t.q;
    tileR[i] = t.r;
    tileDegree[i] = t.degree;
    tileFlags[i] = t.flags;
    tileLodLevel[i] = t.lodLevel;
    tileRegionIdx[i] = t.regionIdx;
  }

  const edgeSrc = new Uint32Array(E);
  const edgeDst = new Uint32Array(E);
  const edgeTypeIdx = new Uint8Array(E);

  for (let i = 0; i < E; i++) {
    edgeSrc[i] = allEdges[i].src;
    edgeDst[i] = allEdges[i].dst;
    edgeTypeIdx[i] = allEdges[i].typeIdx;
  }

  onProgress?.('Ready');

  return {
    meta,
    tileCount: N,
    edgeCount: E,
    tileGlobalIdx, tileTypeIdx, tileQ, tileR, tileDegree, tileFlags, tileLodLevel, tileRegionIdx,
    edgeSrc, edgeDst, edgeTypeIdx,
  };
}

/**
 * Fetch children of an expanded container.
 * Same binary format as graph-hex for the child subset.
 * Returns { header, nodeTypeIndices, nodeQ, nodeR, nodeDegree, nodeFlags,
 *           edgeSrc, edgeDst, edgeTypeIndices }
 */
export async function fetchHexExpand(containerIdx) {
  const res = await fetch(`/api/graph-hex-expand?container=${containerIdx}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  let offset = 0;

  const headerLen = view.getUint32(offset, true); offset += 4;
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, offset, headerLen)));
  offset += headerLen;

  const N = header.nodeCount;
  const E = header.edgeCount;

  // Node: 8 bytes = [typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8]
  const nodeTypeIndices = new Uint8Array(N);
  const nodeQ = new Int16Array(N);
  const nodeR = new Int16Array(N);
  const nodeDegree = new Uint16Array(N);
  const nodeFlags = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    nodeTypeIndices[i] = view.getUint8(offset);
    nodeQ[i] = view.getInt16(offset + 1, true);
    nodeR[i] = view.getInt16(offset + 3, true);
    nodeDegree[i] = view.getUint16(offset + 5, true);
    nodeFlags[i] = view.getUint8(offset + 7);
    offset += 8;
  }

  // Edge: 9 bytes = [src:u32LE][dst:u32LE][typeIdx:u8]
  const edgeSrc = new Uint32Array(E);
  const edgeDst = new Uint32Array(E);
  const edgeTypeIndices = new Uint8Array(E);

  for (let i = 0; i < E; i++) {
    edgeSrc[i] = view.getUint32(offset, true);
    edgeDst[i] = view.getUint32(offset + 4, true);
    edgeTypeIndices[i] = view.getUint8(offset + 8);
    offset += 9;
  }

  return {
    header, nodeTypeIndices, nodeQ, nodeR, nodeDegree, nodeFlags,
    edgeSrc, edgeDst, edgeTypeIndices,
  };
}
