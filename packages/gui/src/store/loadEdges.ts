/**
 * Lazy edge fetcher.
 *
 * Hits `GET /api/edges?types=CALLS,IMPORTS_FROM,...` and parses the
 * NDJSON stream into client-shape `GraphEdge[]` keyed against the
 * existing `nodes[]` array (uses each node's `serverIdx` to remap the
 * server-side visibility-lifted indices back to client positions).
 *
 * Edges whose endpoints aren't present in the visible `nodes[]` (e.g.
 * referencing a server-emitted node the client filtered as excluded /
 * type-suppressed) are silently dropped. The caller can dedup against
 * an existing `edges[]` set if running incremental fetches.
 */

import type { GraphNode, GraphEdge } from './dataStore';

interface EdgesHeaderMsg {
  type: 'edges_header';
  edgeTypeTable: string[];
}
interface EdgesTotalsMsg {
  type: 'totals';
  edges: number;
}
interface EdgeFrameMsg {
  type: 'edge';
  s: number;
  d: number;
  t: number;
}
interface EdgesDoneMsg {
  type: 'done';
  edgeCount: number;
  elapsed: number;
}
type EdgesMsg = EdgesHeaderMsg | EdgesTotalsMsg | EdgeFrameMsg | EdgesDoneMsg;

export interface LoadEdgesOptions {
  types: string[];
  url?: string;
  /** Reports `(loaded, total)` after totals frame and on each edge tick. */
  onProgress?: (loaded: number, total: number) => void;
}

/** Parse an NDJSON ReadableStream into `EdgesMsg` objects. */
async function* parseNDJSON(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EdgesMsg> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as EdgesMsg;
      } catch (e) {
        console.warn('[loadEdges] bad NDJSON line:', line.slice(0, 80), e);
      }
    }
  }
  const tail = buf.trim();
  if (tail) {
    try { yield JSON.parse(tail) as EdgesMsg; } catch { /* ignore */ }
  }
}

export async function loadEdges(
  nodes: ReadonlyArray<GraphNode>,
  opts: LoadEdgesOptions,
  signal?: AbortSignal,
): Promise<{ edges: GraphEdge[]; types: string[] }> {
  const baseUrl = opts.url ?? '/api/edges';
  const url = `${baseUrl}?types=${encodeURIComponent(opts.types.join(','))}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`/api/edges failed: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error('/api/edges has no body');

  const idxMap = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) idxMap.set(nodes[i].serverIdx, i);

  let edgeTypeTable: string[] = [];
  const edges: GraphEdge[] = [];
  let total = 0;
  let loaded = 0;
  const onProgress = opts.onProgress ?? (() => {});

  for await (const msg of parseNDJSON(resp.body)) {
    switch (msg.type) {
      case 'edges_header':
        edgeTypeTable = msg.edgeTypeTable;
        break;
      case 'totals':
        total = msg.edges;
        onProgress(0, total);
        break;
      case 'edge': {
        const src = idxMap.get(msg.s);
        const dst = idxMap.get(msg.d);
        if (src !== undefined && dst !== undefined) {
          edges.push({ source: src, target: dst, type: edgeTypeTable[msg.t] ?? 'UNKNOWN' });
        }
        loaded++;
        if (loaded % 500 === 0) onProgress(loaded, total);
        break;
      }
      case 'done':
        onProgress(msg.edgeCount, msg.edgeCount);
        break;
    }
  }

  return { edges, types: edgeTypeTable };
}
