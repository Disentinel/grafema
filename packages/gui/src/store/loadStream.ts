/**
 * JSONL streaming loader for live RFDB data.
 *
 * Fetches /api/graph-stream, parses line-by-line, and consumes server-provided
 * tectonic layout positions directly — no client-side SA.
 */

import { useDataStore, type GraphNode, type GraphEdge, type Region } from './dataStore';
import { useRouteStore } from './routeStore';
import { cubeToWorld } from './loadFixture';

export interface StreamOptions {
  packages?: string;
  nodeTypes?: string;
  edgeTypes?: string;
  maxNodes?: number;
  /** Container hierarchy level for region grouping (e.g. "package", "directory"). */
  lodLevel?: string;
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
  pos?: { q: number; r: number } | null;
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

interface TectonicMetaMsg {
  type: 'tectonic_meta';
  num_atoms: number;
  phase3_initial_cost: number;
  phase3_final_cost: number;
  pipeline_ms: number;
}

type StreamMsg =
  | HeaderMsg
  | NodeMsg
  | EdgeMsg
  | NodesDoneMsg
  | DoneMsg
  | TectonicMetaMsg;

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
  if (opts.lodLevel) params.set('lodLevel', opts.lodLevel);

  const url = `/api/graph-stream?${params.toString()}`;
  console.log('[loadStream] fetching:', url);
  const resp = await fetch(url);
  console.log('[loadStream] response:', resp.status, resp.headers.get('content-type'));
  if (!resp.ok) throw new Error(`graph-stream failed: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error('No response body — streaming not supported');

  let header: HeaderMsg | null = null;
  const rawNodes: NodeMsg[] = [];
  const rawEdges: EdgeMsg[] = [];
  let tectonicMeta: TectonicMetaMsg | null = null;

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
      case 'tectonic_meta':
        tectonicMeta = msg;
        console.log(
          '[loadStream] tectonic_meta:',
          `atoms=${msg.num_atoms}`,
          `cost=${msg.phase3_initial_cost}→${msg.phase3_final_cost}`,
          `pipeline=${msg.pipeline_ms}ms`,
        );
        break;
    }
  }

  console.log('[loadStream] stream parsed:', rawNodes.length, 'nodes,', rawEdges.length, 'edges');

  if (!header || rawNodes.length === 0) {
    store.setLoading(false);
    throw new Error('Empty graph received from server');
  }

  // Expose tectonic_meta for debug/diagnostic access
  (globalThis as Record<string, unknown>).__grafemaTectonicMeta = tectonicMeta;

  // ── Build GraphNode[] directly from server positions ──
  const TILE_SIZE = 3.0;

  // Exclude container types — they are region metadata, not code entities.
  const EXCLUDED_TYPES = new Set(['SERVICE', 'MODULE']);

  // Pass 1: collect nodes that participate in layout and remap indices.
  const oldToLayout = new Map<number, number>();
  const nodes: GraphNode[] = [];
  let droppedNoPos = 0;
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i];
    const typeName = header.typeTable[raw.t] ?? 'UNKNOWN';
    if (EXCLUDED_TYPES.has(typeName)) continue;
    if (!raw.pos) {
      droppedNoPos++;
      continue;
    }
    const { x, z } = cubeToWorld(raw.pos.q, raw.pos.r, TILE_SIZE);
    const li = nodes.length;
    oldToLayout.set(i, li);
    nodes.push({
      id: raw.id,
      type: typeName,
      name: raw.name,
      file: raw.file,
      region: raw.region,
      x,
      z,
      metrics: raw.metrics,
      degree: raw.degree,
    });
  }

  if (droppedNoPos > 0) {
    console.warn(`[loadStream] dropped ${droppedNoPos} nodes without server positions`);
  }

  // Pass 2: remap edges (skip edges touching excluded / positionless nodes).
  const edges: GraphEdge[] = [];
  for (const e of rawEdges) {
    const src = oldToLayout.get(e.s);
    const dst = oldToLayout.get(e.d);
    if (src !== undefined && dst !== undefined) {
      edges.push({
        source: src,
        target: dst,
        type: header.edgeTypeTable[e.t] ?? 'UNKNOWN',
      });
    }
  }

  // Build regions from header (canonical) joined with per-node centroid data.
  const regions: Region[] = header.regions.map((hr) => {
    const regionNodes = nodes.filter((n) => n.region === hr.path);
    let cx = 0, cz = 0;
    for (const n of regionNodes) { cx += n.x; cz += n.z; }
    if (regionNodes.length > 0) { cx /= regionNodes.length; cz /= regionNodes.length; }
    return {
      path: hr.path,
      depth: hr.depth,
      tileCount: regionNodes.length,
      border: [],
      centroid: { x: cx, z: cz },
    };
  });

  const typeSet = new Set(nodes.map((n) => n.type));
  const edgeTypeSet = new Set(edges.map((e) => e.type));

  console.log('[loadStream] setting graph data:', nodes.length, 'nodes,', edges.length, 'edges,', regions.length, 'regions');
  (globalThis as Record<string, unknown>).__grafemaTileSize = TILE_SIZE;

  store.setGraphData({
    nodes,
    edges,
    regions,
    typeTable: [...typeSet],
    edgeTypeTable: [...edgeTypeSet],
  });

  // Clear routes (no routes from live data)
  useRouteStore.getState().setRoutes([]);

  onProgress('complete', nodes.length, edges.length);
}
