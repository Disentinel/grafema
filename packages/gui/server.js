/**
 * Grafema GUI Server
 *
 * Serves compact binary graph data for 3D visualization.
 * Node details fetched on-demand from RFDB by index.
 */

import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { RFDBClient } from '@grafema/rfdb-client';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = parseInt(process.env.GUI_PORT || '3333', 10);
const SOCKET_PATH = process.env.RFDB_SOCKET || '/tmp/rfdb.sock';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

let client = null;

async function connectRFDB() {
  if (client?.connected) return client;
  client = new RFDBClient(SOCKET_PATH, 'gui-server');
  await client.connect();
  console.log(`Connected to RFDB at ${SOCKET_PATH}`);
  return client;
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseQuery(url) {
  return Object.fromEntries(new URL(url, 'http://localhost').searchParams.entries());
}

function safeParseJSON(str) {
  if (!str) return {};
  try { return JSON.parse(str); }
  catch { return {}; }
}

// Server-side index→id mapping (rebuilt on each /api/graph-binary call)
let currentNodeIds = [];

// Cached /api/graph-hex response (computed once, invalidated manually)
let hexCache = null; // { key, response, nodeIds }
let expandCache = null; // Map<containerIdx, { childNodeIds, reservedTiles }>

// ──── Hex tile math (cube coordinates) ────

function cubeDistance(a, b) {
  return Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
}

function cubeToWorld(q, r, tileSize) {
  const x = tileSize * (3/2 * q);
  const z = tileSize * (Math.sqrt(3)/2 * q + Math.sqrt(3) * r);
  return { x, z };
}

const CUBE_DIRS = [
  {q:1,r:0}, {q:0,r:1}, {q:-1,r:1},
  {q:-1,r:0}, {q:0,r:-1}, {q:1,r:-1}
];

// Hex corner offsets for flat-top hex (for border computation)
function hexCorners(q, r, tileSize) {
  const { x, z } = cubeToWorld(q, r, tileSize);
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 3 * i;
    corners.push({ x: x + Math.cos(angle) * tileSize, z: z + Math.sin(angle) * tileSize });
  }
  return corners;
}

function hexRing(center, radius) {
  if (radius === 0) return [{ q: center.q, r: center.r }];
  const results = [];
  let q = center.q + radius * CUBE_DIRS[4].q;
  let r = center.r + radius * CUBE_DIRS[4].r;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < radius; j++) {
      results.push({ q, r });
      q += CUBE_DIRS[i].q;
      r += CUBE_DIRS[i].r;
    }
  }
  return results;
}

function hexSpiral(center, maxRadius) {
  const tiles = [];
  for (let rad = 0; rad <= maxRadius; rad++) {
    tiles.push(...hexRing(center, rad));
  }
  return tiles;
}

const tileKey = (q, r) => `${q},${r}`;

function growCluster(seed, count, availableSet) {
  const cluster = [];
  const used = new Set();
  const queue = [seed];

  while (cluster.length < count && queue.length > 0) {
    const tile = queue.shift();
    const k = tileKey(tile.q, tile.r);
    if (used.has(k) || !availableSet.has(k)) continue;
    used.add(k);
    cluster.push(tile);
    availableSet.delete(k);
    for (const dir of CUBE_DIRS) {
      const nk = tileKey(tile.q + dir.q, tile.r + dir.r);
      if (!used.has(nk) && availableSet.has(nk)) {
        queue.push({ q: tile.q + dir.q, r: tile.r + dir.r });
      }
    }
  }
  return cluster;
}

function orderByConnectivity(children, edgeWeights) {
  if (children.length <= 1) return children;
  const ordered = [];
  const remaining = new Set(children.map((_, i) => i));

  // Start with largest child
  let best = 0;
  for (const i of remaining) {
    if (children[i].totalCount > children[best].totalCount) best = i;
  }
  ordered.push(children[best]);
  remaining.delete(best);

  while (remaining.size > 0) {
    let bestNext = -1, bestScore = -1;
    for (const i of remaining) {
      let score = 0;
      for (const placed of ordered) {
        const key1 = `${children[i].path}|${placed.path}`;
        const key2 = `${placed.path}|${children[i].path}`;
        score += (edgeWeights.get(key1) || 0) + (edgeWeights.get(key2) || 0);
      }
      if (bestNext === -1 || score > bestScore) {
        bestNext = i; bestScore = score;
      }
    }
    ordered.push(children[bestNext]);
    remaining.delete(bestNext);
  }
  return ordered;
}

function findSeedNear(target, availableSet) {
  // Find closest available tile to target coordinates
  let bestTile = null, bestDist = Infinity;
  for (const k of availableSet) {
    const [q, r] = k.split(',').map(Number);
    const d = cubeDistance({ q, r }, target);
    if (d < bestDist) { bestDist = d; bestTile = { q, r }; }
    if (bestDist <= 1) break; // good enough
  }
  return bestTile || target;
}

/**
 * Recursive hex space allocation.
 * Returns Map<dirPath, tile[]> mapping each leaf directory to its assigned tiles.
 */
function allocateHexTiles(dirNode, availableSet, center, interDirEdges) {
  const leafTiles = new Map();

  if (!dirNode.children || dirNode.children.length === 0) {
    const tiles = growCluster(center, dirNode.totalCount, availableSet);
    leafTiles.set(dirNode.path, tiles);
    return leafTiles;
  }

  const children = orderByConnectivity(dirNode.children, interDirEdges);
  const placedCentroids = new Map();

  for (const child of children) {
    const fraction = child.totalCount / Math.max(dirNode.totalCount, 1);
    const childTileCount = Math.max(1, Math.ceil(fraction * availableSet.size * 0.65));

    // Find seed near connected siblings or center
    let seedTarget = center;
    let bestWeight = 0;
    for (const [placedPath, centroid] of placedCentroids) {
      const k1 = `${child.path}|${placedPath}`;
      const k2 = `${placedPath}|${child.path}`;
      const w = (interDirEdges.get(k1) || 0) + (interDirEdges.get(k2) || 0);
      if (w > bestWeight) { bestWeight = w; seedTarget = centroid; }
    }

    const seed = findSeedNear(seedTarget, availableSet);
    const childTiles = growCluster(seed, childTileCount, availableSet);

    if (childTiles.length === 0) continue;

    // Remove 1-tile buffer around cluster
    const bufferKeys = new Set();
    for (const tile of childTiles) {
      for (const dir of CUBE_DIRS) {
        bufferKeys.add(tileKey(tile.q + dir.q, tile.r + dir.r));
      }
    }
    for (const k of bufferKeys) availableSet.delete(k);

    // Compute centroid
    const cx = Math.round(childTiles.reduce((s, t) => s + t.q, 0) / childTiles.length);
    const cr = Math.round(childTiles.reduce((s, t) => s + t.r, 0) / childTiles.length);
    placedCentroids.set(child.path, { q: cx, r: cr });

    // Recurse
    const childAvailable = new Set(childTiles.map(t => tileKey(t.q, t.r)));
    const childLeaves = allocateHexTiles(child, childAvailable, { q: cx, r: cr }, interDirEdges);
    for (const [path, tiles] of childLeaves) leafTiles.set(path, tiles);
  }

  return leafTiles;
}

/**
 * Place nodes within their leaf tiles using BFS from highest-degree node.
 * Returns Map<nodeIndex, {q, r}> — tile assignment for each node.
 */
function placeNodesInTiles(leafTiles, nodesByDir, edgeSrcArr, edgeDstArr, _dirPrefix) {
  const nodeTiles = new Map();

  // Compute degrees
  const degree = new Map();
  for (let i = 0; i < edgeSrcArr.length; i++) {
    degree.set(edgeSrcArr[i], (degree.get(edgeSrcArr[i]) || 0) + 1);
    degree.set(edgeDstArr[i], (degree.get(edgeDstArr[i]) || 0) + 1);
  }

  // Build adjacency per node
  const adj = new Map();
  for (let i = 0; i < edgeSrcArr.length; i++) {
    if (!adj.has(edgeSrcArr[i])) adj.set(edgeSrcArr[i], []);
    if (!adj.has(edgeDstArr[i])) adj.set(edgeDstArr[i], []);
    adj.get(edgeSrcArr[i]).push(edgeDstArr[i]);
    adj.get(edgeDstArr[i]).push(edgeSrcArr[i]);
  }

  for (const [dirPath, tiles] of leafTiles) {
    const indices = nodesByDir.get(dirPath);
    if (!indices || indices.length === 0) continue;

    // Sort by degree descending
    const sorted = [...indices].sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0));

    const availTiles = [...tiles];
    const placedPositions = new Map(); // nodeIdx → tile

    for (const nodeIdx of sorted) {
      if (availTiles.length === 0) break;

      // Find tile minimizing distance to already-placed connected nodes
      const neighbors = (adj.get(nodeIdx) || []).filter(n => placedPositions.has(n));

      let bestTileIdx = 0;
      if (neighbors.length > 0) {
        let bestCost = Infinity;
        for (let ti = 0; ti < availTiles.length; ti++) {
          let cost = 0;
          for (const n of neighbors) {
            cost += cubeDistance(availTiles[ti], placedPositions.get(n));
          }
          if (cost < bestCost) { bestCost = cost; bestTileIdx = ti; }
        }
      }

      const tile = availTiles.splice(bestTileIdx, 1)[0];
      placedPositions.set(nodeIdx, tile);
      nodeTiles.set(nodeIdx, tile);
    }
  }

  return nodeTiles;
}

/**
 * Compute region border polylines from tile sets.
 * Returns array of border coordinate arrays.
 */
function computeRegionBorders(regionTiles, tileSize) {
  const tileSet = new Set(regionTiles.map(t => tileKey(t.q, t.r)));
  const borderSegments = [];

  for (const tile of regionTiles) {
    const corners = hexCorners(tile.q, tile.r, tileSize);
    for (let i = 0; i < 6; i++) {
      const nq = tile.q + CUBE_DIRS[i].q;
      const nr = tile.r + CUBE_DIRS[i].r;
      if (!tileSet.has(tileKey(nq, nr))) {
        // This edge is a border — add the two corner points
        const c1 = corners[i];
        const c2 = corners[(i + 1) % 6];
        borderSegments.push({ x1: c1.x, z1: c1.z, x2: c2.x, z2: c2.z });
      }
    }
  }

  if (borderSegments.length === 0) return [];

  // Walk segments to form ordered polyline(s)
  const endpointMap = new Map(); // "x,z" → [{x1,z1,x2,z2}, ...]
  const ptKey = (x, z) => `${Math.round(x * 100)},${Math.round(z * 100)}`;

  for (const seg of borderSegments) {
    const k1 = ptKey(seg.x1, seg.z1);
    const k2 = ptKey(seg.x2, seg.z2);
    if (!endpointMap.has(k1)) endpointMap.set(k1, []);
    if (!endpointMap.has(k2)) endpointMap.set(k2, []);
    endpointMap.get(k1).push(seg);
    endpointMap.get(k2).push(seg);
  }

  const usedSegments = new Set();
  const polylines = [];

  for (let si = 0; si < borderSegments.length; si++) {
    if (usedSegments.has(si)) continue;

    const polyline = [];
    let currentSeg = borderSegments[si];
    usedSegments.add(si);
    polyline.push([currentSeg.x1, currentSeg.z1]);
    polyline.push([currentSeg.x2, currentSeg.z2]);

    // Walk forward
    let currentEnd = ptKey(currentSeg.x2, currentSeg.z2);
    let walking = true;
    while (walking) {
      walking = false;
      const candidates = endpointMap.get(currentEnd) || [];
      for (const cand of candidates) {
        const ci = borderSegments.indexOf(cand);
        if (usedSegments.has(ci)) continue;
        usedSegments.add(ci);

        const k1 = ptKey(cand.x1, cand.z1);
        const k2 = ptKey(cand.x2, cand.z2);
        if (k1 === currentEnd) {
          polyline.push([cand.x2, cand.z2]);
          currentEnd = k2;
        } else {
          polyline.push([cand.x1, cand.z1]);
          currentEnd = k1;
        }
        walking = true;
        break;
      }
    }

    polylines.push(polyline);
  }

  // Return the longest polyline (main border)
  polylines.sort((a, b) => b.length - a.length);
  return polylines[0] || [];
}

/**
 * Build directory tree from file paths.
 * Returns { root, allDirs } where each dir node has children, nodeCount, depth.
 */
function buildDirTree(filePaths) {
  const counts = new Map(); // dir → node count (direct files only)
  for (const file of filePaths) {
    const dir = file.substring(0, file.lastIndexOf('/')) || '/';
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }

  // Find common prefix to strip
  const allDirs = [...counts.keys()].sort();
  let prefix = '';
  if (allDirs.length > 1) {
    const first = allDirs[0], last = allDirs[allDirs.length - 1];
    let i = 0;
    while (i < first.length && i < last.length && first[i] === last[i]) i++;
    prefix = first.substring(0, first.lastIndexOf('/', i));
  } else if (allDirs.length === 1) {
    prefix = allDirs[0].substring(0, allDirs[0].lastIndexOf('/'));
  }

  // Build tree structure
  const tree = new Map(); // path → { name, path, children[], directCount, totalCount, depth }
  const root = { name: '/', path: prefix || '/', children: [], directCount: 0, totalCount: 0, depth: 0 };
  tree.set(root.path, root);

  for (const [dir, count] of counts) {
    const rel = prefix ? dir.substring(prefix.length) : dir;
    const parts = rel.split('/').filter(Boolean);

    let current = root;
    let currentPath = prefix;
    for (let i = 0; i < parts.length; i++) {
      currentPath += '/' + parts[i];
      if (!tree.has(currentPath)) {
        const node = { name: parts[i], path: currentPath, children: [], directCount: 0, totalCount: 0, depth: i + 1 };
        tree.set(currentPath, node);
        current.children.push(node);
      }
      current = tree.get(currentPath);
    }
    current.directCount = count;
  }

  // Compute totalCount bottom-up
  function computeTotal(node) {
    node.totalCount = node.directCount;
    for (const child of node.children) {
      computeTotal(child);
      node.totalCount += child.totalCount;
    }
  }
  computeTotal(root);

  // Collapse single-child chains (a/b/c with only c having files → "a/b/c")
  function collapse(node) {
    for (let i = 0; i < node.children.length; i++) {
      let child = node.children[i];
      while (child.children.length === 1 && child.directCount === 0) {
        const grandchild = child.children[0];
        grandchild.name = child.name + '/' + grandchild.name;
        child = grandchild;
      }
      node.children[i] = child;
      collapse(child);
    }
  }
  collapse(root);

  // Reassign depths after collapse
  function setDepth(node, d) {
    node.depth = d;
    for (const child of node.children) setDepth(child, d + 1);
  }
  setDepth(root, 0);

  return { root, prefix };
}

/**
 * Hexagonal layout: pack directory tree into nested hexagons.
 * Each hex: { cx, cz, radius, name, depth, children[] }
 */
function hexLayout(dirNode, cx, cz, radius) {
  const hex = {
    name: dirNode.name,
    path: dirNode.path,
    cx, cz, radius,
    depth: dirNode.depth,
    nodeCount: dirNode.totalCount,
    children: [],
  };

  const kids = dirNode.children.slice().sort((a, b) => b.totalCount - a.totalCount);
  if (kids.length === 0) return hex;

  // Inner radius available for children (leave margin for label)
  const innerR = radius * 0.85;

  if (kids.length === 1) {
    hex.children.push(hexLayout(kids[0], cx, cz, innerR));
  } else {
    // Distribute children around center, sized by totalCount
    const totalCount = kids.reduce((s, k) => s + k.totalCount, 0);
    const angleStep = (2 * Math.PI) / kids.length;

    for (let i = 0; i < kids.length; i++) {
      const fraction = kids[i].totalCount / totalCount;
      const childR = innerR * Math.sqrt(fraction) * 0.9;
      const angle = angleStep * i - Math.PI / 2;
      const dist = innerR - childR;
      const childCx = cx + Math.cos(angle) * dist * 0.6;
      const childCz = cz + Math.sin(angle) * dist * 0.6;
      hex.children.push(hexLayout(kids[i], childCx, childCz, Math.max(childR, 3)));
    }
  }

  return hex;
}

/**
 * Compute geographic positions from file paths using hex layout.
 * Nodes positioned within their leaf hex using golden spiral.
 * Y = -depth * stepY (deeper dirs are lower).
 */
function computePositions(filePaths, mapSize) {
  const N = filePaths.length;
  const positions = new Float32Array(N * 3);
  const half = mapSize / 2;
  const Y_STEP = 4;

  // Group by directory
  const dirIndices = new Map();
  for (let i = 0; i < N; i++) {
    const dir = filePaths[i].substring(0, filePaths[i].lastIndexOf('/')) || '/';
    if (!dirIndices.has(dir)) dirIndices.set(dir, []);
    dirIndices.get(dir).push(i);
  }

  const { root, prefix } = buildDirTree(filePaths);
  const rootHex = hexLayout(root, 0, 0, half);

  // Collect leaf hexes and map back to directory paths
  function collectLeaves(hex, leaves) {
    if (hex.children.length === 0) {
      leaves.set(hex.path, hex);
    } else {
      for (const child of hex.children) collectLeaves(child, leaves);
    }
  }
  const leaves = new Map();
  collectLeaves(rootHex, leaves);

  // Position nodes within their leaf hex
  for (const [dir, indices] of dirIndices) {
    // Find matching leaf hex
    let hex = leaves.get(dir);
    if (!hex) {
      // Try prefix match
      for (const [path, h] of leaves) {
        if (dir.startsWith(path) || path.endsWith(dir.substring(prefix.length))) {
          hex = h; break;
        }
      }
    }
    if (!hex) hex = { cx: 0, cz: 0, radius: 10, depth: 0 };

    const count = indices.length;
    for (let i = 0; i < count; i++) {
      const idx = indices[i];
      if (count === 1) {
        positions[idx * 3] = hex.cx;
        positions[idx * 3 + 2] = hex.cz;
      } else {
        const angle = i * 2.399963;
        const r = Math.sqrt(i / count) * hex.radius * 0.7;
        positions[idx * 3] = hex.cx + Math.cos(angle) * r;
        positions[idx * 3 + 2] = hex.cz + Math.sin(angle) * r;
      }
      positions[idx * 3 + 1] = -hex.depth * Y_STEP;
    }
  }

  return positions;
}

// Cached hex layout for /api/hex-layout
let currentHexLayout = null;

const TYPE_PRIORITY = [
  'MODULE', 'FUNCTION', 'CLASS', 'METHOD', 'SERVICE',
  'VARIABLE', 'CALL', 'IMPORT', 'EXPORT', 'EXTERNAL_MODULE',
];

const STRUCTURAL_TYPES = new Set(['MODULE', 'CLASS', 'SERVICE', 'INTERFACE', 'EXTERNAL_MODULE']);

const apiRoutes = {
  '/api/stats': async (_req, res) => {
    const db = await connectRFDB();
    const [nodeCount, edgeCount, nodesByType, edgesByType] = await Promise.all([
      db.nodeCount(),
      db.edgeCount(),
      db.countNodesByType(),
      db.countEdgesByType(),
    ]);
    json(res, { nodeCount, edgeCount, nodesByType, edgesByType });
  },

  /**
   * Compact binary graph for rendering.
   * Positions computed server-side (geographic layout from file paths).
   *
   * Wire: [headerLen:u32LE][headerJSON][nodeData][edgeData]
   *   header: { nodeCount, edgeCount, typeTable, edgeTypeTable }
   *   nodeData: per node [typeIdx:u8][x:f32LE][y:f32LE][z:f32LE] = 13 bytes
   *   edgeData: per edge [src:u32LE][dst:u32LE][typeIdx:u8] = 9 bytes
   *
   * Hover uses /api/node?index=N → server resolves index→id → RFDB getNode.
   */
  '/api/graph-binary': async (req, res) => {
    const db = await connectRFDB();
    const q = parseQuery(req.url);
    const wantNodeTypes = q.nodeTypes ? q.nodeTypes.split(',') : null;
    const wantEdgeTypes = q.edgeTypes ? q.edgeTypes.split(',') : null;
    const MAX_NODES = parseInt(q.limit || '100', 10);
    const MAP_SIZE = parseFloat(q.mapSize || '200');

    console.time('graph-binary');

    const typeTable = [];
    const typeIdx = new Map();

    const nodeIds = [];
    const nodeTypesArr = [];
    const nodeFilePaths = []; // for layout computation
    const nodeIdMap = new Map();

    const nodesByType = await db.countNodesByType();
    const allTypes = wantNodeTypes
      ? Object.keys(nodesByType).filter(t => wantNodeTypes.includes(t))
      : Object.keys(nodesByType);
    const typesToFetch = [
      ...TYPE_PRIORITY.filter(t => allTypes.includes(t)),
      ...allTypes.filter(t => !TYPE_PRIORITY.includes(t)),
    ];

    let idx = 0;
    outer:
    for (const nodeType of typesToFetch) {
      for await (const node of db.queryNodes({ type: nodeType })) {
        let ti = typeIdx.get(node.nodeType);
        if (ti === undefined) { ti = typeTable.length; typeTable.push(node.nodeType); typeIdx.set(node.nodeType, ti); }

        nodeIdMap.set(node.id, idx);
        nodeIds.push(node.id);
        nodeTypesArr.push(ti);
        nodeFilePaths.push(node.file || '');
        idx++;
        if (idx >= MAX_NODES) break outer;
      }
    }

    currentNodeIds = nodeIds;
    const nodeCount = idx;

    // Compute geographic positions server-side + cache hex layout
    const { root, prefix } = buildDirTree(nodeFilePaths);
    const rootHex = hexLayout(root, 0, 0, MAP_SIZE / 2);
    currentHexLayout = rootHex;
    const positions = computePositions(nodeFilePaths, MAP_SIZE);

    // Edges
    const edgeTypeTable = [];
    const edgeTypeMap = new Map();
    const edgeSrc = [];
    const edgeDst = [];
    const edgeTypesArr = [];

    for (const [nodeId, si] of nodeIdMap) {
      const outEdges = await db.getOutgoingEdges(nodeId, wantEdgeTypes);
      for (const edge of outEdges) {
        const di = nodeIdMap.get(edge.dst);
        if (di === undefined) continue;
        const et = edge.edgeType || edge.type;
        if (wantEdgeTypes && !wantEdgeTypes.includes(et)) continue;
        let eti = edgeTypeMap.get(et);
        if (eti === undefined) { eti = edgeTypeTable.length; edgeTypeTable.push(et); edgeTypeMap.set(et, eti); }
        edgeSrc.push(si);
        edgeDst.push(di);
        edgeTypesArr.push(eti);
      }
    }

    const edgeCount = edgeSrc.length;
    console.log(`${nodeCount} nodes, ${edgeCount} edges`);

    // Binary: node = [typeIdx:u8][x:f32][y:f32][z:f32] = 13 bytes
    const header = JSON.stringify({ nodeCount, edgeCount, typeTable, edgeTypeTable });
    const headerBuf = Buffer.from(header, 'utf8');

    const nodeBuf = Buffer.alloc(nodeCount * 13);
    for (let i = 0; i < nodeCount; i++) {
      const off = i * 13;
      nodeBuf.writeUInt8(nodeTypesArr[i], off);
      nodeBuf.writeFloatLE(positions[i * 3], off + 1);
      nodeBuf.writeFloatLE(positions[i * 3 + 1], off + 5);
      nodeBuf.writeFloatLE(positions[i * 3 + 2], off + 9);
    }

    const edgeBuf = Buffer.alloc(edgeCount * 9);
    for (let i = 0; i < edgeCount; i++) {
      edgeBuf.writeUInt32LE(edgeSrc[i], i * 9);
      edgeBuf.writeUInt32LE(edgeDst[i], i * 9 + 4);
      edgeBuf.writeUInt8(edgeTypesArr[i], i * 9 + 8);
    }

    const totalLen = 4 + headerBuf.length + nodeBuf.length + edgeBuf.length;
    const response = Buffer.alloc(totalLen);
    let off = 0;
    response.writeUInt32LE(headerBuf.length, off); off += 4;
    headerBuf.copy(response, off); off += headerBuf.length;
    nodeBuf.copy(response, off); off += nodeBuf.length;
    edgeBuf.copy(response, off);

    console.timeEnd('graph-binary');
    console.log(`${totalLen} bytes`);

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': totalLen,
    });
    res.end(response);
  },

  /**
   * Extended binary graph with directory index + batch number per node.
   * For WebGPU physics simulation with streaming reveal.
   *
   * Wire: [headerLen:u32LE][headerJSON][nodeData][edgeData]
   *   header: { nodeCount, edgeCount, typeTable, edgeTypeTable, directories[] }
   *   directories: [{ path, cx, cz, radius, depth }] — indexed by dirIdx in node data
   *   nodeData: per node [typeIdx:u8][x:f32LE][y:f32LE][z:f32LE][dirIdx:u16LE][batch:u8] = 16 bytes
   *   edgeData: per edge [src:u32LE][dst:u32LE][typeIdx:u8] = 9 bytes
   */
  '/api/graph-binary-full': async (req, res) => {
    const db = await connectRFDB();
    const q = parseQuery(req.url);
    const wantNodeTypes = q.nodeTypes ? q.nodeTypes.split(',') : null;
    const wantEdgeTypes = q.edgeTypes ? q.edgeTypes.split(',') : null;
    const MAX_NODES = parseInt(q.limit || '1000', 10);
    const MAP_SIZE = parseFloat(q.mapSize || '200');
    const BATCH_SIZE = parseInt(q.batchSize || '100', 10);

    console.time('graph-binary-full');

    const typeTable = [];
    const typeIdx = new Map();
    const nodeIds = [];
    const nodeTypesArr = [];
    const nodeFilePaths = [];
    const nodeIdMap = new Map();

    const nodesByType = await db.countNodesByType();
    const allTypes = wantNodeTypes
      ? Object.keys(nodesByType).filter(t => wantNodeTypes.includes(t))
      : Object.keys(nodesByType);
    const typesToFetch = [
      ...TYPE_PRIORITY.filter(t => allTypes.includes(t)),
      ...allTypes.filter(t => !TYPE_PRIORITY.includes(t)),
    ];

    let idx = 0;
    outer:
    for (const nodeType of typesToFetch) {
      for await (const node of db.queryNodes({ type: nodeType })) {
        let ti = typeIdx.get(node.nodeType);
        if (ti === undefined) { ti = typeTable.length; typeTable.push(node.nodeType); typeIdx.set(node.nodeType, ti); }
        nodeIdMap.set(node.id, idx);
        nodeIds.push(node.id);
        nodeTypesArr.push(ti);
        nodeFilePaths.push(node.file || '');
        idx++;
        if (idx >= MAX_NODES) break outer;
      }
    }

    currentNodeIds = nodeIds;
    const nodeCount = idx;

    // Compute geographic positions + hex layout
    const { root, prefix } = buildDirTree(nodeFilePaths);
    const rootHex = hexLayout(root, 0, 0, MAP_SIZE / 2);
    currentHexLayout = rootHex;
    const positions = computePositions(nodeFilePaths, MAP_SIZE);

    // Build directory index from leaf hexes
    const dirTable = [];
    const dirPathToIdx = new Map();
    function collectDirs(hex) {
      if (hex.children.length === 0) {
        dirPathToIdx.set(hex.path, dirTable.length);
        dirTable.push({
          path: hex.name,
          cx: Math.round(hex.cx * 100) / 100,
          cz: Math.round(hex.cz * 100) / 100,
          radius: Math.round(hex.radius * 100) / 100,
          depth: hex.depth,
        });
      } else {
        for (const child of hex.children) collectDirs(child);
      }
    }
    collectDirs(rootHex);

    // Map each node to its directory index
    const nodeDirIndices = new Uint16Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const file = nodeFilePaths[i];
      const dir = file.substring(0, file.lastIndexOf('/')) || '/';
      // Try exact match first, then prefix match
      let di = dirPathToIdx.get(dir);
      if (di === undefined) {
        for (const [path, pidx] of dirPathToIdx) {
          if (dir.startsWith(path) || path.endsWith(dir.substring(prefix.length))) {
            di = pidx; break;
          }
        }
      }
      nodeDirIndices[i] = di !== undefined ? di : 0;
    }

    // Assign batch numbers (batch 0..N, BATCH_SIZE nodes each)
    const nodeBatches = new Uint8Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      nodeBatches[i] = Math.floor(i / BATCH_SIZE);
    }

    // Edges
    const edgeTypeTable = [];
    const edgeTypeMap = new Map();
    const edgeSrc = [];
    const edgeDst = [];
    const edgeTypesArr = [];

    for (const [nodeId, si] of nodeIdMap) {
      const outEdges = await db.getOutgoingEdges(nodeId, wantEdgeTypes);
      for (const edge of outEdges) {
        const di = nodeIdMap.get(edge.dst);
        if (di === undefined) continue;
        const et = edge.edgeType || edge.type;
        if (wantEdgeTypes && !wantEdgeTypes.includes(et)) continue;
        let eti = edgeTypeMap.get(et);
        if (eti === undefined) { eti = edgeTypeTable.length; edgeTypeTable.push(et); edgeTypeMap.set(et, eti); }
        edgeSrc.push(si);
        edgeDst.push(di);
        edgeTypesArr.push(eti);
      }
    }

    const edgeCount = edgeSrc.length;
    console.log(`graph-binary-full: ${nodeCount} nodes, ${edgeCount} edges, ${dirTable.length} dirs`);

    // Binary: node = [typeIdx:u8][x:f32][y:f32][z:f32][dirIdx:u16][batch:u8] = 16 bytes
    const header = JSON.stringify({
      nodeCount, edgeCount, typeTable, edgeTypeTable,
      directories: dirTable,
    });
    const headerBuf = Buffer.from(header, 'utf8');

    const nodeBuf = Buffer.alloc(nodeCount * 16);
    for (let i = 0; i < nodeCount; i++) {
      const off = i * 16;
      nodeBuf.writeUInt8(nodeTypesArr[i], off);
      nodeBuf.writeFloatLE(positions[i * 3], off + 1);
      nodeBuf.writeFloatLE(positions[i * 3 + 1], off + 5);
      nodeBuf.writeFloatLE(positions[i * 3 + 2], off + 9);
      nodeBuf.writeUInt16LE(nodeDirIndices[i], off + 13);
      nodeBuf.writeUInt8(nodeBatches[i], off + 15);
    }

    const edgeBuf = Buffer.alloc(edgeCount * 9);
    for (let i = 0; i < edgeCount; i++) {
      edgeBuf.writeUInt32LE(edgeSrc[i], i * 9);
      edgeBuf.writeUInt32LE(edgeDst[i], i * 9 + 4);
      edgeBuf.writeUInt8(edgeTypesArr[i], i * 9 + 8);
    }

    const totalLen = 4 + headerBuf.length + nodeBuf.length + edgeBuf.length;
    const response = Buffer.alloc(totalLen);
    let off = 0;
    response.writeUInt32LE(headerBuf.length, off); off += 4;
    headerBuf.copy(response, off); off += headerBuf.length;
    nodeBuf.copy(response, off); off += nodeBuf.length;
    edgeBuf.copy(response, off);

    console.timeEnd('graph-binary-full');
    console.log(`${totalLen} bytes`);

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': totalLen,
    });
    res.end(response);
  },

  /**
   * Hex layout tree for directory zones overlay.
   * Returns nested hex structure: { name, cx, cz, radius, depth, children[] }
   */
  '/api/hex-layout': async (_req, res) => {
    if (!currentHexLayout) {
      json(res, { error: 'No layout computed yet. Call /api/graph-binary first.' }, 400);
      return;
    }
    // Strip nodeCount to keep payload small, flatten for rendering
    function flatten(hex) {
      return {
        n: hex.name,
        cx: Math.round(hex.cx * 100) / 100,
        cz: Math.round(hex.cz * 100) / 100,
        r: Math.round(hex.radius * 100) / 100,
        d: hex.depth,
        c: hex.children.map(flatten),
      };
    }
    json(res, flatten(currentHexLayout));
  },

  /**
   * Get node details by render index. Server resolves index→id and queries RFDB.
   */
  '/api/node': async (req, res) => {
    const db = await connectRFDB();
    const q = parseQuery(req.url);

    let nodeId;
    if (q.index !== undefined) {
      const i = parseInt(q.index, 10);
      if (i < 0 || i >= currentNodeIds.length) { json(res, { error: 'index out of range' }, 400); return; }
      nodeId = currentNodeIds[i];
    } else if (q.id) {
      nodeId = q.id;
    } else {
      json(res, { error: 'missing index or id' }, 400); return;
    }

    const node = await db.getNode(nodeId);
    if (!node) { json(res, { error: 'not found' }, 404); return; }
    const meta = safeParseJSON(node.metadata);
    json(res, {
      id: node.id,
      type: node.nodeType,
      name: node.name,
      file: node.file,
      exported: node.exported,
      semanticId: node.semanticId,
      ...meta,
    });
  },

  /**
   * Hex-tile geographic map with LOD edges.
   * One global hex grid — every entity on one tile, deterministic placement.
   *
   * Wire: [headerLen:u32LE][headerJSON][nodeData: N×8][edgeData: E×9][aggEdgeData: A×7]
   *   nodeData: [typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8] = 8 bytes
   *   edgeData: [src:u32LE][dst:u32LE][typeIdx:u8] = 9 bytes
   *   aggEdge: [srcRegion:u16LE][dstRegion:u16LE][count:u16LE][dominantTypeIdx:u8] = 7 bytes
   */
  '/api/graph-hex': async (req, res) => {
    const q = parseQuery(req.url);
    const wantNodeTypes = q.nodeTypes ? q.nodeTypes.split(',') : null;
    const wantEdgeTypes = q.edgeTypes ? q.edgeTypes.split(',') : null;
    const MAX_NODES = parseInt(q.limit || '1000', 10);
    const TILE_SIZE = parseFloat(q.tileSize || '1.2');
    const structureOnly = q.structureOnly === 'true';

    // Cache key from query params
    const cacheKey = `${MAX_NODES}:${TILE_SIZE}:${structureOnly}:${wantNodeTypes || ''}:${wantEdgeTypes || ''}`;
    if (hexCache && hexCache.key === cacheKey) {
      currentNodeIds = hexCache.nodeIds;
      const cached = hexCache.response;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': cached.length,
      });
      res.end(cached);
      return;
    }

    const db = await connectRFDB();
    console.time('graph-hex');

    // ── Fetch nodes by type priority ──
    const typeTable = [];
    const typeIdx = new Map();
    const nodeIds = [];
    const nodeTypesArr = [];
    const nodeFilePaths = [];
    const nodeIdMap = new Map();

    const nodesByType = await db.countNodesByType();
    const allTypes = wantNodeTypes
      ? Object.keys(nodesByType).filter(t => wantNodeTypes.includes(t))
      : Object.keys(nodesByType);
    let typesToFetch = [
      ...TYPE_PRIORITY.filter(t => allTypes.includes(t)),
      ...allTypes.filter(t => !TYPE_PRIORITY.includes(t)),
    ];
    if (structureOnly) typesToFetch = typesToFetch.filter(t => STRUCTURAL_TYPES.has(t));

    let idx = 0;
    outer:
    for (const nodeType of typesToFetch) {
      for await (const node of db.queryNodes({ type: nodeType })) {
        let ti = typeIdx.get(node.nodeType);
        if (ti === undefined) { ti = typeTable.length; typeTable.push(node.nodeType); typeIdx.set(node.nodeType, ti); }
        nodeIdMap.set(node.id, idx);
        nodeIds.push(node.id);
        nodeTypesArr.push(ti);
        nodeFilePaths.push(node.file || '');
        idx++;
        if (idx >= MAX_NODES) break outer;
      }
    }

    currentNodeIds = nodeIds;
    const nodeCount = idx;

    // ── Fetch all edges ──
    const edgeTypeTable = [];
    const edgeTypeMap = new Map();
    const edgeSrc = [];
    const edgeDst = [];
    const edgeTypesArr = [];
    const containerChildIds = new Map(); // containerIdx → [childNodeId, ...]

    for (const [nodeId, si] of nodeIdMap) {
      // When structureOnly, fetch all edge types to track CONTAINS children
      const outEdges = await db.getOutgoingEdges(nodeId, structureOnly ? null : wantEdgeTypes);
      for (const edge of outEdges) {
        const et = edge.edgeType || edge.type;
        const di = nodeIdMap.get(edge.dst);

        // Track children of containers for lazy expansion
        if (structureOnly && et === 'CONTAINS' && di === undefined) {
          if (!containerChildIds.has(si)) containerChildIds.set(si, []);
          containerChildIds.get(si).push(edge.dst);
          continue;
        }

        if (di === undefined) continue;
        if (wantEdgeTypes && !wantEdgeTypes.includes(et)) continue;
        let eti = edgeTypeMap.get(et);
        if (eti === undefined) { eti = edgeTypeTable.length; edgeTypeTable.push(et); edgeTypeMap.set(et, eti); }
        edgeSrc.push(si);
        edgeDst.push(di);
        edgeTypesArr.push(eti);
      }
    }

    // ── Build containment tree from CONTAINS edges ──
    const containmentChildren = new Map(); // parentIdx → [childIdx, ...]
    const nodeParent = new Int16Array(nodeCount).fill(-1);
    const containsTypeIdx = edgeTypeMap.get('CONTAINS');
    if (containsTypeIdx !== undefined) {
      for (let i = 0; i < edgeSrc.length; i++) {
        if (edgeTypesArr[i] === containsTypeIdx) {
          const parent = edgeSrc[i];
          const child = edgeDst[i];
          if (!containmentChildren.has(parent)) containmentChildren.set(parent, []);
          containmentChildren.get(parent).push(child);
          nodeParent[child] = parent;
        }
      }
    }

    // Compute containment depth (0 = root-level, 1 = child, 2 = grandchild, ...)
    const containmentDepth = new Uint8Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      let depth = 0;
      let cur = i;
      while (nodeParent[cur] >= 0 && depth < 7) {
        depth++;
        cur = nodeParent[cur];
      }
      containmentDepth[i] = depth;
    }

    // ── Build directory tree ──
    const { root, prefix } = buildDirTree(nodeFilePaths);

    // Map nodes to their directory paths (matching buildDirTree's format)
    const nodesByDir = new Map();
    for (let i = 0; i < nodeCount; i++) {
      const file = nodeFilePaths[i];
      const dir = file.substring(0, file.lastIndexOf('/')) || '/';
      if (!nodesByDir.has(dir)) nodesByDir.set(dir, []);
      nodesByDir.get(dir).push(i);
    }

    // ── Compute inter-directory edge weights ──
    const fileDirMap = new Map(); // nodeIdx → dir path
    for (const [dir, indices] of nodesByDir) {
      for (const i of indices) fileDirMap.set(i, dir);
    }

    const interDirEdges = new Map(); // "dirA|dirB" → count
    for (let i = 0; i < edgeSrc.length; i++) {
      const srcDir = fileDirMap.get(edgeSrc[i]);
      const dstDir = fileDirMap.get(edgeDst[i]);
      if (srcDir && dstDir && srcDir !== dstDir) {
        const key = `${srcDir}|${dstDir}`;
        interDirEdges.set(key, (interDirEdges.get(key) || 0) + 1);
      }
    }

    // ── Allocate hex tiles ──
    // Generate enough available tiles (spiral from center)
    const spiralRadius = Math.ceil(Math.sqrt(nodeCount) * 1.5);
    const allTiles = hexSpiral({ q: 0, r: 0 }, spiralRadius);
    const availableSet = new Set(allTiles.map(t => tileKey(t.q, t.r)));

    const leafTiles = allocateHexTiles(root, availableSet, { q: 0, r: 0 }, interDirEdges);

    // ── Place nodes in tiles ──
    // Match nodesByDir keys to leafTiles keys.
    // Nodes in non-leaf dirs (e.g. "ast/") need to map to the closest leaf descendant (e.g. "ast/builders").
    // Nodes in dirs above any leaf need to map to the closest leaf child.
    const remappedNodesByDir = new Map();
    const leafPaths = [...leafTiles.keys()];

    for (const [rawDir, indices] of nodesByDir) {
      // 1. Exact match
      if (leafTiles.has(rawDir)) {
        const existing = remappedNodesByDir.get(rawDir) || [];
        remappedNodesByDir.set(rawDir, existing.concat(indices));
        continue;
      }
      // 2. rawDir is an ancestor of a leaf — find closest descendant leaf
      let bestLeaf = null, bestLen = Infinity;
      for (const lp of leafPaths) {
        if (lp.startsWith(rawDir + '/')) {
          // Prefer shortest path (closest descendant)
          const extra = lp.substring(rawDir.length);
          if (extra.length < bestLen) { bestLen = extra.length; bestLeaf = lp; }
        }
      }
      if (bestLeaf) {
        const existing = remappedNodesByDir.get(bestLeaf) || [];
        remappedNodesByDir.set(bestLeaf, existing.concat(indices));
        continue;
      }
      // 3. rawDir is a descendant of a leaf (shouldn't happen after collapse, but safety)
      let parentLeaf = null;
      for (const lp of leafPaths) {
        if (rawDir.startsWith(lp + '/') || rawDir === lp) {
          parentLeaf = lp; break;
        }
      }
      if (parentLeaf) {
        const existing = remappedNodesByDir.get(parentLeaf) || [];
        remappedNodesByDir.set(parentLeaf, existing.concat(indices));
        continue;
      }
      // 4. No match — assign to first leaf (fallback)
      if (leafPaths.length > 0) {
        const fallback = leafPaths[0];
        const existing = remappedNodesByDir.get(fallback) || [];
        remappedNodesByDir.set(fallback, existing.concat(indices));
      }
    }

    const nodeTileMap = placeNodesInTiles(
      leafTiles, remappedNodesByDir,
      edgeSrc, edgeDst, prefix);

    // Assign fallback positions for unplaced nodes
    const unplacedTiles = hexSpiral({ q: spiralRadius + 5, r: 0 }, Math.ceil(Math.sqrt(nodeCount)));
    let unplacedIdx = 0;
    for (let i = 0; i < nodeCount; i++) {
      if (!nodeTileMap.has(i)) {
        nodeTileMap.set(i, unplacedTiles[unplacedIdx] || { q: spiralRadius + 5 + unplacedIdx, r: 0 });
        unplacedIdx++;
      }
    }

    // ── Reserve tiles for container expansion (structureOnly mode) ──
    const containers = [];
    let totalReserved = 0;
    if (structureOnly && containerChildIds.size > 0) {
      const occupiedTiles = new Set();
      for (const [, tile] of nodeTileMap) {
        occupiedTiles.add(tileKey(tile.q, tile.r));
      }
      const totalChildren = [...containerChildIds.values()].reduce((s, ids) => s + ids.length, 0);
      const expandedRadius = spiralRadius + Math.ceil(Math.sqrt(totalChildren));
      const expandedTiles = hexSpiral({ q: 0, r: 0 }, expandedRadius);
      const reserveAvailable = new Set(expandedTiles.map(t => tileKey(t.q, t.r)));
      for (const k of occupiedTiles) reserveAvailable.delete(k);

      expandCache = new Map();
      for (const [containerIdx, childIds] of containerChildIds) {
        const containerTile = nodeTileMap.get(containerIdx);
        if (!containerTile) continue;

        const seed = findSeedNear(containerTile, reserveAvailable);
        const reserved = growCluster(seed, childIds.length, reserveAvailable);

        expandCache.set(containerIdx, {
          childNodeIds: childIds,
          reservedTiles: reserved,
        });

        containers.push({ nodeIdx: containerIdx, childCount: childIds.length });
        totalReserved += reserved.length;
      }
    } else {
      expandCache = null;
    }

    // ── Compute node degrees ──
    const nodeDegrees = new Uint16Array(nodeCount);
    for (let i = 0; i < edgeSrc.length; i++) {
      nodeDegrees[edgeSrc[i]]++;
      nodeDegrees[edgeDst[i]]++;
    }

    // ── Build regions list ──
    const regions = [];
    const regionIdMap = new Map(); // dirPath → regionId
    const nodeRegions = new Uint16Array(nodeCount);

    // Collect all leaf directories and their ancestor paths
    function collectRegions(node, parentId) {
      const regionId = regions.length;
      regionIdMap.set(node.path, regionId);

      // Collect all tiles for this region (union of all descendant leaves)
      const regionTileList = [];
      function collectDescendantTiles(n) {
        const lt = leafTiles.get(n.path);
        if (lt) regionTileList.push(...lt);
        for (const child of (n.children || [])) collectDescendantTiles(child);
      }
      collectDescendantTiles(node);

      const border = computeRegionBorders(regionTileList, TILE_SIZE);

      regions.push({
        id: regionId,
        path: node.name || node.path,
        depth: node.depth,
        tileCount: regionTileList.length,
        parentId: parentId,
        border,
      });

      for (const child of (node.children || [])) {
        collectRegions(child, regionId);
      }
    }
    collectRegions(root, null);

    // Map nodes to leaf regions
    for (let i = 0; i < nodeCount; i++) {
      const dir = fileDirMap.get(i);
      // Find the deepest region matching this dir
      let bestRegion = 0;
      for (const [path, rid] of regionIdMap) {
        if (dir && (dir === path || dir.startsWith(path) || path.endsWith(dir.substring(prefix.length)))) {
          if (regions[rid].depth >= regions[bestRegion].depth) bestRegion = rid;
        }
      }
      nodeRegions[i] = bestRegion;
    }

    // ── Compute hub flags ──
    // Hub = highest degree in its leaf region
    const regionMaxDegree = new Map();
    const regionMaxNode = new Map();
    for (let i = 0; i < nodeCount; i++) {
      const rid = nodeRegions[i];
      if (!regionMaxDegree.has(rid) || nodeDegrees[i] > regionMaxDegree.get(rid)) {
        regionMaxDegree.set(rid, nodeDegrees[i]);
        regionMaxNode.set(rid, i);
      }
    }
    const nodeFlags = new Uint8Array(nodeCount);
    for (const [, nodeIdx] of regionMaxNode) {
      nodeFlags[nodeIdx] |= 0x01; // bit0 = hub
    }

    // Mark containers and encode containment depth in flags
    // bit1 = is_container, bits 2-4 = containment depth (0-7)
    for (const parentIdx of containmentChildren.keys()) {
      nodeFlags[parentIdx] |= 0x02;
    }
    for (let i = 0; i < nodeCount; i++) {
      nodeFlags[i] |= (containmentDepth[i] & 0x07) << 2;
    }

    // ── Edge aggregation ──
    const aggMap = new Map(); // "srcRegion|dstRegion" → { count, typeCounts }
    for (let i = 0; i < edgeSrc.length; i++) {
      const srcReg = nodeRegions[edgeSrc[i]];
      const dstReg = nodeRegions[edgeDst[i]];
      if (srcReg === dstReg) continue;
      const key = srcReg < dstReg ? `${srcReg}|${dstReg}` : `${dstReg}|${srcReg}`;
      if (!aggMap.has(key)) aggMap.set(key, { count: 0, typeCounts: new Map() });
      const agg = aggMap.get(key);
      agg.count++;
      const et = edgeTypesArr[i];
      agg.typeCounts.set(et, (agg.typeCounts.get(et) || 0) + 1);
    }

    const aggEdges = [];
    for (const [key, agg] of aggMap) {
      const [srcReg, dstReg] = key.split('|').map(Number);
      let dominantType = 0, maxCount = 0;
      for (const [et, count] of agg.typeCounts) {
        if (count > maxCount) { maxCount = count; dominantType = et; }
      }
      aggEdges.push({ srcReg, dstReg, count: agg.count, dominantType });
    }

    const edgeCount = edgeSrc.length;
    const aggEdgeCount = aggEdges.length;
    console.log(`graph-hex: ${nodeCount} nodes, ${edgeCount} edges, ${aggEdgeCount} agg edges, ${regions.length} regions, ${containmentChildren.size} containers`);

    // ── Serialize ──
    const header = JSON.stringify({
      nodeCount, edgeCount, aggEdgeCount,
      typeTable, edgeTypeTable,
      tileSize: TILE_SIZE,
      regions,
      nodeRegions: Array.from(nodeRegions),
      nodeParents: Array.from(nodeParent),
      ...(containers.length > 0 ? { containers, totalReserved } : {}),
    });
    const headerBuf = Buffer.from(header, 'utf8');

    // Node: 8 bytes = [typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8]
    const nodeBuf = Buffer.alloc(nodeCount * 8);
    for (let i = 0; i < nodeCount; i++) {
      const tile = nodeTileMap.get(i) || { q: 0, r: 0 };
      const off = i * 8;
      nodeBuf.writeUInt8(nodeTypesArr[i], off);
      nodeBuf.writeInt16LE(tile.q, off + 1);
      nodeBuf.writeInt16LE(tile.r, off + 3);
      nodeBuf.writeUInt16LE(nodeDegrees[i], off + 5);
      nodeBuf.writeUInt8(nodeFlags[i], off + 7);
    }

    // Edge: 9 bytes = [src:u32LE][dst:u32LE][typeIdx:u8]
    const edgeBuf = Buffer.alloc(edgeCount * 9);
    for (let i = 0; i < edgeCount; i++) {
      edgeBuf.writeUInt32LE(edgeSrc[i], i * 9);
      edgeBuf.writeUInt32LE(edgeDst[i], i * 9 + 4);
      edgeBuf.writeUInt8(edgeTypesArr[i], i * 9 + 8);
    }

    // AggEdge: 7 bytes = [srcRegion:u16LE][dstRegion:u16LE][count:u16LE][dominantTypeIdx:u8]
    const aggBuf = Buffer.alloc(aggEdgeCount * 7);
    for (let i = 0; i < aggEdgeCount; i++) {
      const ae = aggEdges[i];
      aggBuf.writeUInt16LE(ae.srcReg, i * 7);
      aggBuf.writeUInt16LE(ae.dstReg, i * 7 + 2);
      aggBuf.writeUInt16LE(Math.min(ae.count, 65535), i * 7 + 4);
      aggBuf.writeUInt8(ae.dominantType, i * 7 + 6);
    }

    const totalLen = 4 + headerBuf.length + nodeBuf.length + edgeBuf.length + aggBuf.length;
    const response = Buffer.alloc(totalLen);
    let off = 0;
    response.writeUInt32LE(headerBuf.length, off); off += 4;
    headerBuf.copy(response, off); off += headerBuf.length;
    nodeBuf.copy(response, off); off += nodeBuf.length;
    edgeBuf.copy(response, off); off += edgeBuf.length;
    aggBuf.copy(response, off);

    // Cache the computed result
    hexCache = { key: cacheKey, response, nodeIds: nodeIds };

    console.timeEnd('graph-hex');
    console.log(`graph-hex: ${totalLen} bytes (${(totalLen/1024).toFixed(1)}KB) — cached`);

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': totalLen,
    });
    res.end(response);
  },

  /**
   * Expand a container: return its children and edges.
   * Uses expandCache built by structureOnly graph-hex request.
   *
   * Wire: [headerLen:u32LE][headerJSON][nodeData: M×8][edgeData: E×9]
   */
  '/api/graph-hex-expand': async (req, res) => {
    const q = parseQuery(req.url);
    const containerIdx = parseInt(q.container, 10);

    if (!expandCache || !expandCache.has(containerIdx)) {
      json(res, { error: 'Container not found in expand cache' }, 400);
      return;
    }

    const db = await connectRFDB();
    const { childNodeIds, reservedTiles } = expandCache.get(containerIdx);
    const startIndex = currentNodeIds.length;

    console.time('graph-hex-expand');

    // Fetch child nodes
    const typeTable = [];
    const typeIdx = new Map();
    const childNodes = [];

    for (const childId of childNodeIds) {
      const node = await db.getNode(childId);
      if (!node) continue;

      let ti = typeIdx.get(node.nodeType);
      if (ti === undefined) { ti = typeTable.length; typeTable.push(node.nodeType); typeIdx.set(node.nodeType, ti); }

      childNodes.push({ id: childId, typeIdx: ti });
    }

    // Build combined ID→index map (structural set + this expansion batch)
    const allIdMap = new Map();
    for (let i = 0; i < currentNodeIds.length; i++) {
      allIdMap.set(currentNodeIds[i], i);
    }
    for (let i = 0; i < childNodes.length; i++) {
      allIdMap.set(childNodes[i].id, startIndex + i);
    }

    // Fetch edges for children (only include edges where both endpoints are loaded)
    const edgeTypeTable = [];
    const edgeTypeMap = new Map();
    const edgeSrc = [];
    const edgeDst = [];
    const edgeTypesArr = [];

    for (let i = 0; i < childNodes.length; i++) {
      const outEdges = await db.getOutgoingEdges(childNodes[i].id);
      for (const edge of outEdges) {
        const di = allIdMap.get(edge.dst);
        if (di === undefined) continue;
        const et = edge.edgeType || edge.type;
        let eti = edgeTypeMap.get(et);
        if (eti === undefined) { eti = edgeTypeTable.length; edgeTypeTable.push(et); edgeTypeMap.set(et, eti); }
        edgeSrc.push(startIndex + i);
        edgeDst.push(di);
        edgeTypesArr.push(eti);
      }
    }

    const nodeCount = childNodes.length;
    const edgeCount = edgeSrc.length;

    // Compute per-child degree from this batch's edges
    const childDegrees = new Uint16Array(nodeCount);
    for (let e = 0; e < edgeCount; e++) {
      const si = edgeSrc[e] - startIndex;
      if (si >= 0 && si < nodeCount) childDegrees[si]++;
      const di = edgeDst[e] - startIndex;
      if (di >= 0 && di < nodeCount) childDegrees[di]++;
    }

    console.log(`graph-hex-expand: container ${containerIdx}, ${nodeCount} children, ${edgeCount} edges`);

    // Serialize
    const header = JSON.stringify({
      containerIdx,
      startIndex,
      nodeCount,
      edgeCount,
      typeTable,
      edgeTypeTable,
    });
    const headerBuf = Buffer.from(header, 'utf8');

    // Node: 8 bytes = [typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8]
    const nodeBuf = Buffer.alloc(nodeCount * 8);
    for (let i = 0; i < nodeCount; i++) {
      const tile = reservedTiles[i] || { q: 0, r: 0 };
      const off = i * 8;
      nodeBuf.writeUInt8(childNodes[i].typeIdx, off);
      nodeBuf.writeInt16LE(tile.q, off + 1);
      nodeBuf.writeInt16LE(tile.r, off + 3);
      nodeBuf.writeUInt16LE(childDegrees[i], off + 5);
      nodeBuf.writeUInt8(0, off + 7);
    }

    // Edge: 9 bytes = [src:u32LE][dst:u32LE][typeIdx:u8]
    const edgeBuf = Buffer.alloc(edgeCount * 9);
    for (let i = 0; i < edgeCount; i++) {
      edgeBuf.writeUInt32LE(edgeSrc[i], i * 9);
      edgeBuf.writeUInt32LE(edgeDst[i], i * 9 + 4);
      edgeBuf.writeUInt8(edgeTypesArr[i], i * 9 + 8);
    }

    const totalLen = 4 + headerBuf.length + nodeBuf.length + edgeBuf.length;
    const response = Buffer.alloc(totalLen);
    let off = 0;
    response.writeUInt32LE(headerBuf.length, off); off += 4;
    headerBuf.copy(response, off); off += headerBuf.length;
    nodeBuf.copy(response, off); off += nodeBuf.length;
    edgeBuf.copy(response, off);

    // Append child IDs to currentNodeIds so /api/node hover works
    for (const child of childNodes) {
      currentNodeIds.push(child.id);
    }

    console.timeEnd('graph-hex-expand');

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': totalLen,
    });
    res.end(response);
  },
};

async function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  let filePath = join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Content-Length': content.length,
    });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (apiRoutes[pathname]) {
    try { await apiRoutes[pathname](req, res); }
    catch (err) {
      console.error(`API error ${pathname}:`, err.message);
      if (!res.headersSent) json(res, { error: err.message }, 500);
    }
  } else {
    await serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`Grafema GUI: http://localhost:${PORT}`);
  console.log(`RFDB socket: ${SOCKET_PATH}`);
});
