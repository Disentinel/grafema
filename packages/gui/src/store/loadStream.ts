/**
 * JSONL streaming loader for live RFDB data.
 *
 * Fetches /api/graph-stream, parses line-by-line, runs SA layout,
 * and populates the data store — same contract as loadFixture.
 */

import { useDataStore, type GraphNode, type GraphEdge, type Region } from './dataStore';
import { useRouteStore } from './routeStore';
import { annealingLayout, IncrementalLayout, type LayoutNode } from './hexLayout';
import { cubeToWorld } from './loadFixture';

const TILE_SIZE_CONST = 3.0;

type HexLayerLike = { setTargetPositions: (x: Float32Array, z: Float32Array) => void };

// Abort controller for cancelling previous stream (React StrictMode)
let _activeAbort: AbortController | null = null;

function getHexLayer(): HexLayerLike | null {
  return (globalThis as Record<string, unknown>).__hexLayerRef as HexLayerLike | null;
}

/** Move a few random tiles to their SA-optimized positions (visual progress indicator) */
function applyPartialPositions(engine: IncrementalLayout, layoutNodes: LayoutNode[], count: number) {
  const hexLayer = getHexLayer();
  if (!hexLayer) return;
  const n = layoutNodes.length;
  const targetX = new Float32Array(n);
  const targetZ = new Float32Array(n);

  // Start with current world positions (keep everything in place)
  for (let i = 0; i < n; i++) {
    const tile = engine.tileCoords.get(i);
    if (tile) {
      const { x, z } = cubeToWorld(tile.q, tile.r, TILE_SIZE_CONST);
      targetX[i] = x;
      targetZ[i] = z;
    }
  }
  // Only update `count` random tiles that actually moved
  hexLayer.setTargetPositions(targetX, targetZ);
}

/**
 * Render nodes immediately with flood fill layout (no SA, no edges).
 * Called as soon as nodes_done arrives, before edges are computed.
 */
function renderNodesImmediate(
  store: ReturnType<typeof useDataStore.getState>,
  header: HeaderMsg,
  rawNodes: NodeMsg[],
  onProgress: (phase: string, count: number, total?: number) => void,
) {
  // No client-side filtering — server already sends only requested nodeTypes.
  // Indices must match server-side SA positions exactly.
  const layoutNodes: LayoutNode[] = rawNodes.map((raw, _i) => ({
    id: raw.id,
    type: header.typeTable[raw.t] ?? 'UNKNOWN',
    name: raw.name,
    file: raw.file,
    region: raw.region,
    degree: raw.degree,
  }));

  const regionNames = [...new Set(layoutNodes.map(n => n.region))];
  // Flood fill only (no SA yet) — IncrementalLayout constructor does this
  const engine = new IncrementalLayout(layoutNodes, [], regionNames);

  const nodes: GraphNode[] = [];
  for (let li = 0; li < layoutNodes.length; li++) {
    const tile = engine.tileCoords.get(li);
    if (!tile) continue;
    const ln = layoutNodes[li];
    const { x, z } = cubeToWorld(tile.q, tile.r, TILE_SIZE_CONST);
    nodes[li] = {
      id: ln.id, type: ln.type, name: ln.name, file: ln.file,
      region: ln.region, x, z, degree: ln.degree,
    };
  }

  const regions: Region[] = regionNames.map(rpath => {
    const rn = nodes.filter(n => n && n.region === rpath);
    let cx = 0, cz = 0;
    for (const n of rn) { cx += n.x; cz += n.z; }
    if (rn.length > 0) { cx /= rn.length; cz /= rn.length; }
    const hr = header.regions.find(r => r.path === rpath);
    return { path: rpath, depth: hr?.depth ?? 0, tileCount: rn.length, border: [], centroid: { x: cx, z: cz } };
  });

  const typeSet = new Set(layoutNodes.map(n => n.type));
  (globalThis as Record<string, unknown>).__grafemaTileCoords = engine.tileCoords;
  (globalThis as Record<string, unknown>).__grafemaTileSize = TILE_SIZE_CONST;

  console.log('[loadStream] rendering', nodes.length, 'nodes immediately (no edges yet)');
  store.setGraphData({
    nodes, edges: [], regions,
    typeTable: [...typeSet], edgeTypeTable: [],
  });
  useRouteStore.getState().setRoutes([]);
  onProgress('layout_rendered', nodes.length);
}

/** Lerp ALL tiles to final SA positions */
function applyAllPositions(engine: IncrementalLayout, layoutNodes: LayoutNode[]) {
  const hexLayer = getHexLayer();
  if (!hexLayer) return;
  const n = layoutNodes.length;
  const targetX = new Float32Array(n);
  const targetZ = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tile = engine.tileCoords.get(i);
    if (tile) {
      const { x, z } = cubeToWorld(tile.q, tile.r, TILE_SIZE_CONST);
      targetX[i] = x;
      targetZ[i] = z;
    }
  }
  hexLayer.setTargetPositions(targetX, targetZ);
}

export interface StreamOptions {
  packages?: string;
  nodeTypes?: string;
  edgeTypes?: string;
  maxNodes?: number;
  onProgress?: (phase: string, count: number, total?: number) => void;
}

interface HeaderMsg {
  type: 'header';
  typeTable: string[];
  edgeTypeTable: string[];
  regions: { path: string; depth: number; tileCount: number; parentIdx: number | null }[];
}

interface NodeMsg {
  type: 'node';
  i: number;
  t: number;
  id: string;
  name: string;
  file: string;
  region: string;
  degree: number;
  metrics?: Record<string, number>;
}

interface EdgeMsg {
  type: 'edge';
  s: number;
  d: number;
  t: number;
}

interface NodesDoneMsg {
  type: 'nodes_done';
  count: number;
}

interface EdgesDoneMsg {
  type: 'edges_done';
  count: number;
  edgeTypeTable?: string[];
}

interface PositionsMsg {
  type: 'positions';
  coords: [number, number, number][]; // [idx, q, r]
  iteration: number;
  cost: number;
  settled?: boolean;
}

interface DoneMsg {
  type: 'done';
  nodeCount: number;
  edgeCount: number;
  elapsed: number;
}

type StreamMsg = HeaderMsg | NodeMsg | EdgeMsg | NodesDoneMsg | EdgesDoneMsg | PositionsMsg | DoneMsg;

/**
 * Parse a ReadableStream<Uint8Array> as newline-delimited JSON.
 * Yields one parsed object per line.
 */
async function* parseNDJSON(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamMsg> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          yield JSON.parse(line) as StreamMsg;
        }
      }
    }
    // Flush remaining
    const remaining = buffer.trim();
    if (remaining.length > 0) {
      yield JSON.parse(remaining) as StreamMsg;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function loadStream(opts: StreamOptions = {}) {
  const store = useDataStore.getState();
  store.setLoading(true);

  const params = new URLSearchParams();
  if (opts.packages) params.set('packages', opts.packages);
  if (opts.nodeTypes) params.set('nodeTypes', opts.nodeTypes);
  if (opts.edgeTypes) params.set('edgeTypes', opts.edgeTypes);
  if (opts.maxNodes) params.set('maxNodes', String(opts.maxNodes));

  // Abort previous request (React StrictMode fires effect twice)
  if (_activeAbort) _activeAbort.abort();
  const abortController = new AbortController();
  _activeAbort = abortController;

  const url = `/api/graph-stream?${params.toString()}`;
  console.log('[loadStream] fetching:', url);
  const resp = await fetch(url, { signal: abortController.signal });
  console.log('[loadStream] response:', resp.status, resp.headers.get('content-type'));
  if (!resp.ok) throw new Error(`graph-stream failed: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error('No response body — streaming not supported');

  let header: HeaderMsg | null = null;
  const rawNodes: NodeMsg[] = [];
  let nodesRendered = false;
  const rawEdges: EdgeMsg[] = [];
  let _nodesDone = false;

  const onProgress = opts.onProgress ?? (() => {});

  console.log('[loadStream] starting NDJSON parse...');
  for await (const msg of parseNDJSON(resp.body)) {
    switch (msg.type) {
      case 'header':
        header = msg;
        console.log('[loadStream] header:', msg.typeTable.length, 'types,', msg.regions.length, 'regions');
        onProgress('header', 0);
        break;
      case 'node':
        rawNodes.push(msg);
        if (rawNodes.length % 500 === 0) onProgress('nodes', rawNodes.length);
        break;
      case 'nodes_done':
        _nodesDone = true;
        console.log('[loadStream] nodes done:', msg.count);
        onProgress('nodes_done', msg.count);
        if (header && rawNodes.length > 0 && !nodesRendered) {
          nodesRendered = true;
          renderNodesImmediate(store, header, rawNodes, onProgress);
        }
        break;
      case 'edge':
        rawEdges.push(msg);
        if (rawEdges.length % 1000 === 0) onProgress('edges', rawEdges.length);
        break;
      case 'edges_done':
        console.log('[loadStream] edges done:', msg.count);
        if (msg.edgeTypeTable) {
          header!.edgeTypeTable = msg.edgeTypeTable;
        }
        onProgress('edges', msg.count);
        break;
      case 'positions': {
        // Server-side SA position update — morph tiles
        const hexLayer = getHexLayer();
        if (hexLayer && rawNodes.length > 0) {
          const n = rawNodes.length;
          const targetX = new Float32Array(n);
          const targetZ = new Float32Array(n);
          for (const [idx, q, r] of msg.coords) {
            if (idx < n) {
              const { x, z } = cubeToWorld(q, r, TILE_SIZE_CONST);
              targetX[idx] = x;
              targetZ[idx] = z;
            }
          }
          hexLayer.setTargetPositions(targetX, targetZ);
        }
        onProgress('sa_refine', msg.iteration, msg.cost);
        if (msg.settled && hexLayer) {
          console.log('[loadStream] SA settled:', msg.iteration, 'iter, cost:', msg.cost);
          // After morph completes, rebuild graph data → updates region borders
          const settledCoords = msg.coords;
          (hexLayer as HexLayerLike & { onSettled: (() => void) | null }).onSettled = () => {
            // Build final node positions from SA coords
            const finalNodes: GraphNode[] = [];
            for (let i = 0; i < rawNodes.length; i++) {
              const coord = settledCoords.find((c: [number, number, number]) => c[0] === i);
              if (!coord) continue;
              const raw = rawNodes[i];
              const { x, z } = cubeToWorld(coord[1], coord[2], TILE_SIZE_CONST);
              finalNodes[i] = {
                id: raw.id, type: header!.typeTable[raw.t] ?? 'UNKNOWN',
                name: raw.name, file: raw.file, region: raw.region,
                x, z, degree: raw.degree,
              };
            }
            const regionNames = [...new Set(rawNodes.map(n => n.region))];
            const regions: Region[] = regionNames.map(rpath => {
              const rn = finalNodes.filter(n => n && n.region === rpath);
              let cx = 0, cz = 0;
              for (const n of rn) { cx += n.x; cz += n.z; }
              if (rn.length > 0) { cx /= rn.length; cz /= rn.length; }
              return { path: rpath, depth: 0, tileCount: rn.length, border: [], centroid: { x: cx, z: cz } };
            });
            const typeSet = new Set(finalNodes.filter(Boolean).map(n => n.type));
            const edgeTypeSet = new Set(rawEdges.map(e => header!.edgeTypeTable[e.t] ?? 'UNKNOWN'));
            store.setGraphData({
              nodes: finalNodes, edges: rawEdges.map(e => ({
                source: e.s, target: e.d, type: header!.edgeTypeTable[e.t] ?? 'UNKNOWN',
              })),
              regions, typeTable: [...typeSet], edgeTypeTable: [...edgeTypeSet],
            });
            console.log('[loadStream] borders updated after morph');
            onProgress('complete', finalNodes.length, rawEdges.length);
          };
        }
        break;
      }
      case 'done':
        console.log('[loadStream] done:', msg.nodeCount, 'nodes,', msg.edgeCount, 'edges,', msg.elapsed, 'ms');
        // 'done' arrives after SA settled — completion handled by onSettled callback
        break;
    }
  }

  console.log('[loadStream] stream complete:', rawNodes.length, 'nodes,', rawEdges.length, 'edges');

  if (!header || rawNodes.length === 0) {
    store.setLoading(false);
    throw new Error('Empty graph received from server');
  }

  // SA layout is handled server-side. Position updates arrive as `positions`
  // messages in the stream and are applied via HexLayer.setTargetPositions().
  // No client-side SA needed.
}
