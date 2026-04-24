/**
 * JSONL streaming loader for live RFDB data.
 *
 * Fetches /api/graph-stream, parses line-by-line, and consumes server-provided
 * layout positions directly — no client-side SA.
 *
 * Two public entry points:
 *   - `parseStream(opts, signal?)` — transport primitive that returns a
 *     `LayoutResult`. No store writes. Suitable for the unified
 *     `fetchLayout` dispatcher in `../layout/layoutClient.ts`.
 *   - `loadStream(opts)` — back-compat wrapper that calls `parseStream`
 *     then writes to `useDataStore` and `useRouteStore`. Preserved so
 *     App.tsx and other callers don't need edits.
 */

import { useDataStore, type GraphNode, type GraphEdge, type Region } from './dataStore';
import { useRouteStore } from './routeStore';
import {
  useLayoutStore,
  buildRegionTree,
  type LayoutMeta,
  type RegionNodeRaw,
  type RegionTree,
  type RegionInfo,
} from './layoutStore';
import { cubeToWorld } from '../geom/hex';
import { computeHullsForRegions, bucketSymbolsByRegion } from '../hulls/computeHulls.js';
import type { LayoutResult } from '../layout/types';

export interface StreamOptions {
  /** URL override. Defaults to `/api/graph-stream`. */
  url?: string;
  packages?: string;
  nodeTypes?: string;
  edgeTypes?: string;
  maxNodes?: number;
  /** Container hierarchy level for region grouping (e.g. "package", "directory"). */
  lodLevel?: string;
  onProgress?: (phase: string, count: number, total?: number) => void;
}

/**
 * Flat region entry (legacy SA layout). Kept for back-compat — older
 * server builds emit this shape; DAI-22 Chunk-6+ emit a nested tree.
 * See §B.3 of 004-plan-revised.md.
 */
interface FlatRegionEntry {
  path: string;
  depth: number;
  tileCount: number;
  parentIdx: number | null;
}

interface HeaderMsg {
  type: 'header';
  typeTable: string[];
  edgeTypeTable: string[];
  /**
   * Either a legacy flat list (older server) or a tree of RegionNodeRaw
   * (DAI-22 Chunk-6+). We detect by probing for the `id` field.
   */
  regions: FlatRegionEntry[] | RegionNodeRaw[];
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
  /**
   * DAI-22 §B.3 discriminator. When null the node is placed (render it);
   * otherwise caller decides whether to skip atlas rendering, surface
   * via the empty-layout overlay, or count toward the overflow badge.
   */
  unplaced_reason?: 'excluded' | 'missing_layout' | 'skipped_overflow' | null;
}

interface LayoutMetaMsg extends LayoutMeta {
  type: 'layout_meta';
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

type StreamMsg =
  | HeaderMsg
  | NodeMsg
  | EdgeMsg
  | NodesDoneMsg
  | DoneMsg
  | LayoutMetaMsg;

/**
 * Detect whether a header's regions array is the new nested-tree shape
 * (RegionNodeRaw, with `id` + optional `children`) rather than the
 * legacy flat SA entries (which lack `id`).
 */
function isRegionTreeRoots(
  regions: FlatRegionEntry[] | RegionNodeRaw[],
): regions is RegionNodeRaw[] {
  if (regions.length === 0) return true; // empty — safe either way
  const first = regions[0] as Partial<RegionNodeRaw>;
  return typeof first.id === 'string';
}

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

const TILE_SIZE = 3.0;
// Exclude container types — they are region metadata, not code entities.
const EXCLUDED_TYPES = new Set(['SERVICE', 'MODULE']);

/**
 * Transport primitive: fetch an NDJSON graph stream and build a
 * LayoutResult. Does not touch any store. Throws AbortError if the
 * provided signal is aborted before/during fetch.
 */
export async function parseStream(
  opts: StreamOptions = {},
  signal?: AbortSignal,
): Promise<LayoutResult> {
  const params = new URLSearchParams();
  if (opts.packages) params.set('packages', opts.packages);
  if (opts.nodeTypes) params.set('nodeTypes', opts.nodeTypes);
  if (opts.edgeTypes) params.set('edgeTypes', opts.edgeTypes);
  if (opts.maxNodes) params.set('maxNodes', String(opts.maxNodes));
  if (opts.lodLevel) params.set('lodLevel', opts.lodLevel);

  const baseUrl = opts.url ?? '/api/graph-stream';
  const search = params.toString();
  const url = search ? `${baseUrl}?${search}` : baseUrl;

  if (import.meta.env?.DEV) console.log('[parseStream] fetching:', url);
  const resp = await fetch(url, { signal });
  if (import.meta.env?.DEV) console.log('[parseStream] response:', resp.status, resp.headers.get('content-type'));
  if (!resp.ok) throw new Error(`graph-stream failed: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error('No response body — streaming not supported');

  let header: HeaderMsg | null = null;
  let layoutMeta: LayoutMeta | null = null;
  const rawNodes: NodeMsg[] = [];
  const rawEdges: EdgeMsg[] = [];

  const onProgress = opts.onProgress ?? (() => {});

  if (import.meta.env?.DEV) console.log('[parseStream] starting NDJSON parse...');
  for await (const msg of parseNDJSON(resp.body)) {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    switch (msg.type) {
      case 'header':
        header = msg;
        if (import.meta.env?.DEV) console.log('[parseStream] header received:', msg.typeTable.length, 'types,', msg.regions.length, 'regions');
        onProgress('header', 0);
        break;
      case 'node':
        rawNodes.push(msg);
        if (rawNodes.length % 500 === 0) onProgress('nodes', rawNodes.length);
        break;
      case 'nodes_done':
        if (import.meta.env?.DEV) console.log('[parseStream] nodes done:', msg.count);
        onProgress('nodes_done', msg.count);
        break;
      case 'edge':
        rawEdges.push(msg);
        if (rawEdges.length % 1000 === 0) onProgress('edges', rawEdges.length);
        break;
      case 'done':
        if (import.meta.env?.DEV) console.log('[parseStream] done:', msg.nodeCount, 'nodes,', msg.edgeCount, 'edges,', msg.elapsed, 'ms');
        onProgress('done', msg.nodeCount, msg.edgeCount);
        break;
      case 'layout_meta': {
        // Strip the `type` discriminator before storing.
        const { type: _t, ...rest } = msg;
        void _t;
        layoutMeta = rest;
        if (import.meta.env?.DEV) {
          console.log('[parseStream] layout_meta:', layoutMeta.source, layoutMeta.symbol_count);
        }
        break;
      }
    }
  }

  if (import.meta.env?.DEV) console.log('[parseStream] stream parsed:', rawNodes.length, 'nodes,', rawEdges.length, 'edges');

  if (!header || rawNodes.length === 0) {
    throw new Error('Empty graph received from server');
  }

  // ── Build GraphNode[] directly from server positions ──
  // Pass 1: collect nodes that participate in layout and remap indices.
  // §B.3: nodes with `unplaced_reason !== null` are excluded from the
  // atlas render set but surfaced via `unplacedNodes` so host search /
  // tooltip datasets keep them queryable.
  const oldToLayout = new Map<number, number>();
  const nodes: GraphNode[] = [];
  const unplacedNodes: NonNullable<LayoutResult['unplacedNodes']> = [];
  let droppedNoPos = 0;
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i];
    const typeName = header.typeTable[raw.t] ?? 'UNKNOWN';
    const reason = raw.unplaced_reason ?? null;

    // Server-side hint wins. Fallback: legacy EXCLUDED_TYPES filter for
    // back-compat with builds that don't emit `unplaced_reason`.
    if (reason !== null) {
      unplacedNodes.push({
        id: raw.id,
        type: typeName,
        name: raw.name,
        file: raw.file,
        region: raw.region,
        degree: raw.degree,
        metrics: raw.metrics,
        unplacedReason: reason,
      });
      continue;
    }

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
    console.warn(`[parseStream] dropped ${droppedNoPos} nodes without server positions`);
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

  // Build regions from header (canonical) joined with per-node centroid
  // data. Supports both the legacy flat shape and the DAI-22 nested
  // tree — the tree is flattened into a list of {path, depth} entries
  // for the existing `Region[]` consumer, while the richer RegionTree
  // index is produced separately below for layoutStore.
  let regionTree: RegionTree | undefined;
  const flatRegionEntries: { path: string; depth: number }[] = [];
  if (isRegionTreeRoots(header.regions)) {
    regionTree = buildRegionTree(header.regions);
    for (const info of regionTree.byId.values()) {
      flatRegionEntries.push({ path: info.path, depth: info.depth });
    }
  } else {
    for (const hr of header.regions) {
      flatRegionEntries.push({ path: hr.path, depth: hr.depth });
    }
  }

  const regions: Region[] = flatRegionEntries.map((hr) => {
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

  (globalThis as Record<string, unknown>).__grafemaTileSize = TILE_SIZE;

  return {
    nodes,
    edges,
    regions,
    typeTable: [...typeSet],
    edgeTypeTable: [...edgeTypeSet],
    layoutMeta,
    regionTree,
    unplacedNodes,
  };
}

/**
 * Back-compat entry that also populates stores (dataStore + routeStore).
 *
 * Keeps App.tsx / loadLiveLayout.ts callers working without edits. New
 * code should prefer `fetchLayout({source:{kind:'stream',...}})` from
 * `../layout/layoutClient.ts` and wire the store write at the call site.
 */
export async function loadStream(opts: StreamOptions = {}) {
  const store = useDataStore.getState();
  store.setLoading(true);

  let layout: LayoutResult;
  try {
    layout = await parseStream(opts);
  } catch (err) {
    store.setLoading(false);
    throw err;
  }

  if (import.meta.env?.DEV) console.log(
    '[loadStream] setting graph data:',
    layout.nodes.length, 'nodes,',
    layout.edges.length, 'edges,',
    layout.regions.length, 'regions',
  );
  store.setGraphData(layout);

  // DAI-22 Chunk-6: feed layout_meta + regionTree into the layoutStore
  // so HexAtlas (overlay) and OverflowBadge can subscribe without
  // reaching into parseStream. `reset()` first to avoid stale values
  // if a previous stream populated them.
  const layoutStore = useLayoutStore.getState();
  layoutStore.reset();
  if (layout.layoutMeta !== undefined) {
    layoutStore.setLayoutMeta(layout.layoutMeta);
  }
  if (layout.regionTree !== undefined) {
    layoutStore.setRegionTree(layout.regionTree);

    // DAI-22 Chunk-8: compute per-region hulls once per stream load.
    // We skip depth 0 (root) per Chunk-7's 580ms flood-fill finding —
    // the root hull would cover the entire atlas and its cost
    // dominates aggregation. Nested regions carry all the visual
    // hierarchy we need; the root is implicit.
    try {
      const placed = buildPlacedForBucketing(layout, layoutStore.regionTree);
      const symbolsByRegion = bucketSymbolsByRegion(placed);
      const filteredTree = filterOutDepthZero(layoutStore.regionTree);
      // hexSize=TILE_SIZE so polygon coordinates live in the same
      // world-space frame as HexLayer tiles — Chunk-8b renderers can
      // read from hullCache without an extra scaling pass.
      const hulls = computeHullsForRegions(filteredTree, symbolsByRegion, {
        hexSize: TILE_SIZE,
      });
      layoutStore.setHullCache(hulls);
    } catch (err) {
      // Hull compute failure must not break the stream load — renderers
      // fall back to "no hulls" when the cache is empty.
      console.warn('[loadStream] hull computation failed:', err);
    }
  }

  // Clear routes (no routes from live data)
  useRouteStore.getState().setRoutes([]);

  opts.onProgress?.('complete', layout.nodes.length, layout.edges.length);
}

// ---------------------------------------------------------------------------
// DAI-22 Chunk-8 — helpers for per-region hull aggregation on stream load.
// ---------------------------------------------------------------------------

/**
 * Invert `cubeToWorld` to recover axial (q, r) from a placed node's
 * world-space (x, z). Same math as `src/geom/hex.mjs::cubeToWorld`.
 * Exported for tests that exercise the bucketing path.
 */
export function worldToAxial(
  x: number,
  z: number,
  size: number = TILE_SIZE,
): { q: number; r: number } {
  const q = x / (size * 1.5);
  const r = z / (size * Math.sqrt(3)) - q / 2;
  // Round to integers — layout emits exact hex centres, but floating
  // point noise can produce 3.9999-style results after round-trip.
  return { q: Math.round(q), r: Math.round(r) };
}

/**
 * Build a flat placed-symbol list keyed by region id for hull bucketing.
 * Resolves each node's `region` path to a region id via the tree's
 * `byFile` index (which also covers non-file region kinds — see
 * layoutStore.buildRegionTree).
 */
export function buildPlacedForBucketing(
  layout: LayoutResult,
  tree: RegionTree,
): Array<{ regionId: string; q: number; r: number }> {
  const out: Array<{ regionId: string; q: number; r: number }> = [];
  // byFile is keyed by path, and node.region is the region path — the
  // parser populated it from the server's `region` field verbatim. If a
  // node's region isn't in the index, it's dropped (defensive: usually
  // indicates stale nodes from an old stream).
  for (const n of layout.nodes) {
    const regionId = tree.byFile.get(n.region);
    if (regionId === undefined) continue;
    const { q, r } = worldToAxial(n.x, n.z);
    out.push({ regionId, q, r });
  }
  return out;
}

/**
 * Return a region tree view with depth-0 roots elided. Root hulls would
 * cover the entire atlas (Chunk-7 measured ~580ms to aggregate), and
 * visually they add no information over the union of their children.
 *
 * Implementation: shallow-copy `byId` minus depth-0 entries, promote
 * depth-1 regions whose parent was a root to `null` parent, and rebuild
 * `roots` from the surviving depth-1 ids.
 */
export function filterOutDepthZero(tree: RegionTree): RegionTree {
  const byId = new Map<string, RegionInfo>();
  const roots: string[] = [];
  const droppedRoots = new Set<string>();
  for (const info of tree.byId.values()) {
    if (info.depth === 0) {
      droppedRoots.add(info.id);
      continue;
    }
    byId.set(info.id, info);
  }
  // Rebuild parent chain — depth-1 nodes that pointed at a dropped root
  // become new roots (parentId = null).
  for (const [id, info] of byId) {
    if (info.parentId !== null && droppedRoots.has(info.parentId)) {
      byId.set(id, { ...info, parentId: null });
      roots.push(id);
    } else if (info.parentId === null) {
      roots.push(id);
    }
  }
  return { roots, byId, byFile: tree.byFile };
}
