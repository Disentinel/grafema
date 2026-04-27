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
  /**
   * Phase 4 — string-table interning. Per-node frames carry `f` / `r` /
   * `rs` indices into these tables instead of inlining the strings.
   * Older server builds omit them; the parser then falls back to the
   * raw `file` / `region` / `unplaced_reason` fields.
   */
  fileTable?: string[];
  regionTable?: string[];
  reasonTable?: string[];
}

interface NodeMsg {
  type: 'node';
  i: number;
  t: number;
  id: string;
  name: string;
  /** Phase 4 — index into header.fileTable. Either this or `file`. */
  f?: number;
  /** Legacy back-compat — full file path. Either this or `f`. */
  file?: string;
  /** Phase 4 — index into header.regionTable. Either this or `region`. */
  r?: number;
  /** Legacy back-compat — full region id. Either this or `r`. */
  region?: string;
  degree: number;
  metrics?: Record<string, number>;
  pos?: { q: number; r: number } | null;
  /**
   * DAI-22 §B.3 discriminator. When null the node is placed (render it);
   * otherwise caller decides whether to skip atlas rendering, surface
   * via the empty-layout overlay, or count toward the overflow badge.
   * Phase 4 — `rs` (number) preferred; index into header.reasonTable.
   */
  unplaced_reason?: 'excluded' | 'missing_layout' | 'skipped_overflow' | null;
  rs?: number;
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

/**
 * Up-front denominators for the progress UI. Server emits this right
 * after `header` so the GUI can render `loaded/total` from the first
 * byte instead of only learning the total at `done`. `edges` is 0 when
 * the request set `noEdges=1` (default GUI bootstrap).
 */
interface TotalsMsg {
  type: 'totals';
  nodes: number;
  edges: number;
}

/**
 * Phase 3 — nodes are emitted in depth-bucketed groups. Each bucket
 * is wrapped by an `open` frame announcing depth + count, then the
 * usual `node` frames, then a `close` frame so progressive renderers
 * can hand off the just-arrived bucket to the GPU before continuing.
 */
interface NodesBucketOpenMsg {
  type: 'nodes_bucket_open';
  depth: number;
  count: number;
}
interface NodesBucketCloseMsg {
  type: 'nodes_bucket_close';
  depth: number;
}

/**
 * Phase 2 of streaming overhaul — server now batches every
 * `unplaced_reason="excluded"` node into one frame at the tail of the
 * stream rather than emitting them as 300k+ individual `node` frames.
 * Other reasons (`missing_layout`, `skipped_overflow`) still come
 * through per-node so the existing overlay layers don't need rewiring.
 *
 * When present, parser populates `unplacedNodes` from this batch;
 * when absent (older server) the legacy per-node `unplaced_reason`
 * branch handles it.
 */
interface ExcludedNodesMsg {
  type: 'excluded_nodes';
  /** Phase 4 — shared reason index (every entry in the batch is the
   *  same reason — `"excluded"` — so it's hoisted to the envelope).
   *  Older server builds omit `rs` and put `reason: "excluded"` per
   *  entry; parser handles both. */
  rs?: number;
  nodes: {
    i: number;
    id: string;
    t: number;
    n: string;
    /** Phase 4 — index into header.fileTable, OR raw string for older server. */
    f: number | string;
    r: number | string;
    d: number;
    reason?: 'excluded';
  }[];
}

/**
 * Phase 1 of streaming overhaul — server emits per-region hull polygons
 * as a single frame right after the header. Each loop is closed (first
 * vertex repeated at end). When this frame is present the client SKIPS
 * its own client-side `computeHullsForRegions` pass and uses these
 * polygons directly. When absent (older server, missing layout, etc.)
 * the legacy client-side compute path runs as before.
 */
interface HullsMsg {
  type: 'hulls';
  regions: {
    /** RegionId in lowercase hex (matches header.regions[].id). */
    rid: string;
    /** Cell count after morph-close + hole-fill. Used by the GUI for
     *  label-size scaling (square-root of area drives font size). */
    area: number;
    /** Closed polygon loops in world (x, y) coordinates. Each pair is
     *  `[x, y]`; first pair is repeated at the loop's end. */
    polys: [number, number][][];
  }[];
}

type StreamMsg =
  | HeaderMsg
  | NodeMsg
  | EdgeMsg
  | NodesDoneMsg
  | DoneMsg
  | LayoutMetaMsg
  | HullsMsg
  | ExcludedNodesMsg
  | TotalsMsg
  | NodesBucketOpenMsg
  | NodesBucketCloseMsg;

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
  // ~487k edge frames + ~28k node frames + an excluded-nodes batch
  // means JSON.parse runs hundreds of thousands of times — without
  // periodic yields the main thread can't service input events
  // (mouse cursor visibly freezes during ingest). Yielding every
  // YIELD_EVERY parses gives the browser room to repaint cursors,
  // tooltips, scroll, etc. The 8-bit cap is small enough that one
  // batch is well under a frame budget on a modern laptop, large
  // enough that the cumulative yield overhead stays trivial.
  const YIELD_EVERY = 1024;
  let parsedSinceYield = 0;
  const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

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
          parsedSinceYield++;
          if (parsedSinceYield >= YIELD_EVERY) {
            parsedSinceYield = 0;
            await yieldNow();
          }
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
// MODULE / SERVICE used to be filtered here client-side because the
// orchestrator placed them as visible tiles even though they're region
// metadata, not code entities. The server now drops them in
// `layout_types::PLACEABLE_TYPES`, so they arrive in the
// `excluded_nodes` batch instead and the client filter is a no-op.
// Keeping an empty set here so the loop guard below is a one-line
// stable check (and so back-compat with older servers that still emit
// MODULE as placed continues to work).
const EXCLUDED_TYPES = new Set<string>();

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
  // Phase 1 — server-precomputed hulls. When the stream carries a
  // `hulls` frame we skip the client-side `computeHullsForRegions`
  // pass and feed these polygons straight into the layoutStore.
  let precomputedHulls: HullsMsg | null = null;
  // Phase 2 — server-batched excluded-node summary. Replaces 300k+
  // per-node frames with one tail message; populated only when the
  // stream actually carries the batch frame (older servers fall back
  // to the per-node `unplaced_reason` branch).
  let excludedBatch: ExcludedNodesMsg | null = null;

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
      case 'totals':
        // Up-front denominators. Tucked between header and the bucket
        // open frames; client-side progress UI can switch from "starting"
        // to "0 / N" the instant this lands.
        if (import.meta.env?.DEV) console.log('[parseStream] totals:', msg.nodes, 'nodes,', msg.edges, 'edges');
        onProgress('totals', msg.nodes, msg.edges);
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
      case 'hulls':
        precomputedHulls = msg;
        if (import.meta.env?.DEV) {
          console.log(`[parseStream] hulls frame: ${msg.regions.length} regions`);
        }
        onProgress('hulls', msg.regions.length);
        break;
      case 'excluded_nodes':
        excludedBatch = msg;
        if (import.meta.env?.DEV) {
          console.log(`[parseStream] excluded_nodes batch: ${msg.nodes.length} nodes`);
        }
        onProgress('excluded_nodes', msg.nodes.length);
        break;
      case 'nodes_bucket_open':
        if (import.meta.env?.DEV) {
          console.log(`[parseStream] bucket open: depth=${msg.depth} count=${msg.count}`);
        }
        onProgress('bucket_open', msg.depth, msg.count);
        break;
      case 'nodes_bucket_close':
        if (import.meta.env?.DEV) {
          console.log(`[parseStream] bucket close: depth=${msg.depth}`);
        }
        onProgress('bucket_close', msg.depth);
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
  //
  // Phase 4 — header may carry fileTable/regionTable/reasonTable; node
  // frames then reference them via numeric indices (`f`, `r`, `rs`).
  // Older servers omit the tables and inline strings (`file`, `region`,
  // `unplaced_reason`); both shapes are accepted via these resolvers.
  const fileTable = header.fileTable ?? [];
  const regionTable = header.regionTable ?? [];
  const reasonTable = header.reasonTable ?? ['excluded', 'missing_layout', 'skipped_overflow'];
  const resolveFile = (raw: NodeMsg): string =>
    raw.f !== undefined ? (fileTable[raw.f] ?? '') : (raw.file ?? '');
  const resolveRegion = (raw: NodeMsg): string =>
    raw.r !== undefined ? (regionTable[raw.r] ?? '') : (raw.region ?? '');
  const resolveReason = (raw: NodeMsg): NodeMsg['unplaced_reason'] => {
    if (raw.unplaced_reason !== undefined) return raw.unplaced_reason;
    if (raw.rs !== undefined) {
      const s = reasonTable[raw.rs];
      if (s === 'excluded' || s === 'missing_layout' || s === 'skipped_overflow') return s;
    }
    return null;
  };

  const oldToLayout = new Map<number, number>();
  const nodes: GraphNode[] = [];
  const unplacedNodes: NonNullable<LayoutResult['unplacedNodes']> = [];
  let droppedNoPos = 0;
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i];
    const typeName = header.typeTable[raw.t] ?? 'UNKNOWN';
    const reason = resolveReason(raw);
    const fileStr = resolveFile(raw);
    const regionStr = resolveRegion(raw);

    if (reason !== null && reason !== undefined) {
      unplacedNodes.push({
        id: raw.id,
        type: typeName,
        name: raw.name,
        file: fileStr,
        region: regionStr,
        degree: raw.degree,
        metrics: raw.metrics,
        serverIdx: raw.i,
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
    // Key oldToLayout off the SERVER-emitted index (`raw.i`), not the
    // rawNodes loop counter — depth-bucketed emit means the loop counter
    // and `nr.idx` diverge. Edges keyed against server indices were
    // silently mis-remapping (the `noEdges=1` default fetch hid this for
    // a long time). Same `raw.i` is stashed on the GraphNode below as
    // `serverIdx` so lazy /api/edges fetches can rebuild this map on
    // demand.
    oldToLayout.set(raw.i, li);
    nodes.push({
      id: raw.id,
      type: typeName,
      name: raw.name,
      file: fileStr,
      region: regionStr,
      x,
      z,
      metrics: raw.metrics,
      degree: raw.degree,
      serverIdx: raw.i,
    });
  }

  if (droppedNoPos > 0) {
    console.warn(`[parseStream] dropped ${droppedNoPos} nodes without server positions`);
  }

  // Phase 2 — fold the batched `excluded_nodes` frame into `unplacedNodes`
  // alongside any per-node entries collected by the legacy path. Newer
  // server only emits the batch, older server only emits per-node;
  // running both unconditionally is safe because the partition is
  // disjoint by construction.
  if (excludedBatch) {
    // Phase 4 — `f` / `r` may be table indices (number) or raw strings
    // (legacy server build). `reason` is hoisted to the envelope (`rs`)
    // when the server interns it; otherwise per-entry `reason` carries
    // the literal string. Default to "excluded" since this batch only
    // ever contains excluded nodes.
    const batchReason: 'excluded' | 'missing_layout' | 'skipped_overflow' =
      excludedBatch.rs !== undefined
        ? ((reasonTable[excludedBatch.rs] as 'excluded') ?? 'excluded')
        : 'excluded';
    for (const n of excludedBatch.nodes) {
      const typeName = header.typeTable[n.t] ?? 'UNKNOWN';
      const fileStr = typeof n.f === 'number' ? (fileTable[n.f] ?? '') : (n.f ?? '');
      const regionStr = typeof n.r === 'number' ? (regionTable[n.r] ?? '') : (n.r ?? '');
      unplacedNodes.push({
        id: n.id,
        type: typeName,
        name: n.n,
        file: fileStr,
        region: regionStr,
        degree: n.d,
        serverIdx: n.i,
        unplacedReason: n.reason ?? batchReason,
      });
    }
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

  // Phase 1 — convert wire-format hulls (flat [x,y] pairs per loop) into
  // the {x,y} object form the rest of the GUI uses. Only emitted when
  // the server actually shipped a hulls frame; absent for fixture
  // sources or older server builds.
  const precomputedHullsResult = precomputedHulls
    ? precomputedHulls.regions.map((r) => ({
        regionId: r.rid,
        area: r.area,
        polygons: r.polys.map((loop) => loop.map(([x, y]) => ({ x, y }))),
      }))
    : undefined;

  return {
    nodes,
    edges,
    regions,
    typeTable: [...typeSet],
    edgeTypeTable: [...edgeTypeSet],
    layoutMeta,
    regionTree,
    unplacedNodes,
    precomputedHulls: precomputedHullsResult,
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
  hydrateLayoutStoreFromLayout(layout);

  // Clear routes (no routes from live data)
  useRouteStore.getState().setRoutes([]);

  opts.onProgress?.('complete', layout.nodes.length, layout.edges.length);
}

/**
 * DAI-22 Chunk-6/8 — hydrate layoutStore (layoutMeta, regionTree,
 * hullCache) from a parsed LayoutResult. Idempotent: `reset()` is
 * called first so stale values from a previous stream don't leak.
 *
 * Called from both `loadStream` (URL-param bootstrap path) and
 * `loadFromSource` (prop-driven path) so the EmptyLayoutOverlay,
 * OverflowBadge layer, and HullLayer render in both cases.
 *
 * Split out of loadStream for Chunk-10b: prior to this split,
 * `source={kind:'stream',...}` consumers (the production SPA host
 * at /ui/{db}) had layoutMeta === null because only `setGraphData`
 * was called. Badges and hulls silently never rendered.
 */
export function hydrateLayoutStoreFromLayout(layout: LayoutResult): void {
  const layoutStore = useLayoutStore.getState();
  layoutStore.reset();
  if (layout.layoutMeta !== undefined) {
    layoutStore.setLayoutMeta(layout.layoutMeta);
  }
  if (layout.regionTree !== undefined) {
    layoutStore.setRegionTree(layout.regionTree);

    // Phase 1 — server precomputes hulls and ships them in the header
    // frame. The bucketing now mirrors `buildPlacedForBucketing` (every
    // symbol → its file region), so the polygons match what the
    // client-side compute would produce — fills no longer "разъезжаются".
    // Falls back to client-side compute when the stream didn't ship
    // hulls (older server, fixture source, missing layout).
    try {
      if (layout.precomputedHulls && layout.precomputedHulls.length > 0) {
        const hulls = new Map<string, { polygons: { x: number; y: number }[][]; area: number }>();
        for (const r of layout.precomputedHulls) {
          hulls.set(r.regionId, { polygons: r.polygons, area: r.area });
        }
        layoutStore.setHullCache(hulls);
      } else {
        // Use layout.regionTree directly (not layoutStore.regionTree): the
        // `layoutStore` variable is a snapshot captured at getState() time —
        // before setRegionTree mutated state — so reading .regionTree off it
        // would get the pre-update tree (empty on fresh load). This was the
        // DAI-22 Chunk-10b WARN-#3 "hullCache empty" root cause.
        const placed = buildPlacedForBucketing(layout, layout.regionTree);
        const symbolsByRegion = bucketSymbolsByRegion(placed);
        const hulls = computeHullsForRegions(layout.regionTree, symbolsByRegion, {
          hexSize: TILE_SIZE,
        });
        layoutStore.setHullCache(hulls);
      }
    } catch (err) {
      // Hull compute failure must not break the stream load — renderers
      // fall back to "no hulls" when the cache is empty.
      console.warn('[hydrateLayoutStore] hull computation failed:', err);
    }
  }
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
 * Each symbol belongs to its containing file's REGION — looked up via
 * `tree.byFile` keyed on the node's file path.
 *
 * History: an earlier version used `n.region`, but the server emits
 * `region` as a mix of file paths (when the enclosing region is the file
 * itself) and scope names like `"FUNCTION:<expression>"` / `"METHOD:render"`
 * (when the symbol is nested in a function/method). `byFile` is keyed on
 * actual file paths, so scope-name lookups always missed → hullCache was
 * silently empty → HullLayer rendered zero hulls. Use `n.file` which is
 * unambiguous (DAI-22 Chunk-10b WARN #3/#5 fix).
 */
export function buildPlacedForBucketing(
  layout: LayoutResult,
  tree: RegionTree,
): Array<{ regionId: string; q: number; r: number }> {
  const out: Array<{ regionId: string; q: number; r: number }> = [];
  for (const n of layout.nodes) {
    const regionId = tree.byFile.get(n.file);
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
