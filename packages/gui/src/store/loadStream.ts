/**
 * JSONL streaming loader for live RFDB data.
 *
 * Fetches /api/graph-stream, parses line-by-line, runs SA layout,
 * and populates the data store — same contract as loadFixture.
 */

import { useDataStore, type GraphNode, type GraphEdge, type Region } from './dataStore';
import { useRouteStore } from './routeStore';
import { annealingLayout, type LayoutNode } from './hexLayout';
import { cubeToWorld } from './loadFixture';

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

interface DoneMsg {
  type: 'done';
  nodeCount: number;
  edgeCount: number;
  elapsed: number;
}

type StreamMsg = HeaderMsg | NodeMsg | EdgeMsg | NodesDoneMsg | DoneMsg;

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

  const url = `/api/graph-stream?${params.toString()}`;
  console.log('[loadStream] fetching:', url);
  const resp = await fetch(url);
  console.log('[loadStream] response:', resp.status, resp.headers.get('content-type'));
  if (!resp.ok) throw new Error(`graph-stream failed: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error('No response body — streaming not supported');

  let header: HeaderMsg | null = null;
  const rawNodes: NodeMsg[] = [];
  const rawEdges: EdgeMsg[] = [];
  let _nodesDone = false;

  const onProgress = opts.onProgress ?? (() => {});

  console.log('[loadStream] starting NDJSON parse...');
  for await (const msg of parseNDJSON(resp.body)) {
    switch (msg.type) {
      case 'header':
        header = msg;
        console.log('[loadStream] header received:', msg.typeTable.length, 'types,', msg.regions.length, 'regions');
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
        break;
      case 'edge':
        rawEdges.push(msg);
        if (rawEdges.length % 1000 === 0) onProgress('edges', rawEdges.length);
        break;
      case 'done':
        console.log('[loadStream] done:', msg.nodeCount, 'nodes,', msg.edgeCount, 'edges,', msg.elapsed, 'ms');
        onProgress('done', msg.nodeCount, msg.edgeCount);
        break;
    }
  }

  console.log('[loadStream] stream parsed:', rawNodes.length, 'nodes,', rawEdges.length, 'edges');

  if (!header || rawNodes.length === 0) {
    store.setLoading(false);
    throw new Error('Empty graph received from server');
  }

  // ── Build layout input ──
  const TILE_SIZE = 3.0;

  // Exclude container types from layout (same as loadFixture)
  const EXCLUDED_TYPES = new Set(['SERVICE', 'MODULE']);
  const codeNodes: { raw: NodeMsg; oldIdx: number }[] = [];
  for (let i = 0; i < rawNodes.length; i++) {
    const typeName = header.typeTable[rawNodes[i].t] ?? '';
    if (!EXCLUDED_TYPES.has(typeName)) {
      codeNodes.push({ raw: rawNodes[i], oldIdx: i });
    }
  }

  // Remap indices for layout
  const oldToLayout = new Map<number, number>();
  const layoutNodes: LayoutNode[] = [];
  for (let li = 0; li < codeNodes.length; li++) {
    const { raw, oldIdx } = codeNodes[li];
    oldToLayout.set(oldIdx, li);
    layoutNodes.push({
      id: raw.id,
      type: header.typeTable[raw.t] ?? 'UNKNOWN',
      name: raw.name,
      file: raw.file,
      region: raw.region,
      degree: raw.degree,
    });
  }

  // Remap edges (skip edges touching excluded nodes)
  const layoutEdges: GraphEdge[] = [];
  for (const e of rawEdges) {
    const src = oldToLayout.get(e.s);
    const dst = oldToLayout.get(e.d);
    if (src !== undefined && dst !== undefined) {
      layoutEdges.push({
        source: src,
        target: dst,
        type: header.edgeTypeTable[e.t] ?? 'UNKNOWN',
      });
    }
  }

  // Collect unique region names from layout nodes
  const regionNames = [...new Set(layoutNodes.map(n => n.region))];

  console.log('[loadStream] layout input:', layoutNodes.length, 'nodes,', layoutEdges.length, 'edges,', regionNames.length, 'regions');
  onProgress('layout', layoutNodes.length);

  // Run simulated annealing
  console.log('[loadStream] starting SA...');
  const saStart = performance.now();
  const { tileCoords } = annealingLayout(layoutNodes, layoutEdges, regionNames);
  console.log('[loadStream] SA done in', Math.round(performance.now() - saStart), 'ms,', tileCoords.size, 'tiles');

  // Build GraphNode[] with world positions
  const nodes: GraphNode[] = [];
  for (let li = 0; li < layoutNodes.length; li++) {
    const tile = tileCoords.get(li);
    if (!tile) continue;
    const ln = layoutNodes[li];
    const { raw } = codeNodes[li];
    const { x, z } = cubeToWorld(tile.q, tile.r, TILE_SIZE);

    nodes[li] = {
      id: ln.id,
      type: ln.type,
      name: ln.name,
      file: ln.file,
      region: ln.region,
      x,
      z,
      metrics: raw.metrics,
      degree: ln.degree,
    };
  }

  // Build regions
  const regions: Region[] = regionNames.map(rpath => {
    const regionNodes = nodes.filter(n => n && n.region === rpath);
    let cx = 0, cz = 0;
    for (const n of regionNodes) { cx += n.x; cz += n.z; }
    if (regionNodes.length > 0) { cx /= regionNodes.length; cz /= regionNodes.length; }
    // Find depth from header regions
    const headerRegion = header!.regions.find(r => r.path === rpath);
    return {
      path: rpath,
      depth: headerRegion?.depth ?? 0,
      tileCount: regionNodes.length,
      border: [],
      centroid: { x: cx, z: cz },
    };
  });

  const typeSet = new Set(layoutNodes.map(n => n.type));
  const edgeTypeSet = new Set(layoutEdges.map(e => e.type));

  console.log('[loadStream] setting graph data:', nodes.length, 'nodes,', layoutEdges.length, 'edges,', regions.length, 'regions');
  (globalThis as Record<string, unknown>).__grafemaTileCoords = tileCoords;
  (globalThis as Record<string, unknown>).__grafemaTileSize = TILE_SIZE;

  store.setGraphData({
    nodes,
    edges: layoutEdges,
    regions,
    typeTable: [...typeSet],
    edgeTypeTable: [...edgeTypeSet],
  });

  // Clear routes (no routes from live data)
  useRouteStore.getState().setRoutes([]);

  onProgress('complete', nodes.length, layoutEdges.length);
}
