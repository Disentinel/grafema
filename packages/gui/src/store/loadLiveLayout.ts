/**
 * Live layout loader: JSONL stream + WebSocket SA position updates.
 *
 * Phase 1: Fetch /api/graph-stream → parse NDJSON → quick client-side SA → render
 * Phase 2: Connect WS /api/layout-live → receive binary position snapshots → lerp tiles
 *
 * The module exposes `setLiveLayoutSink(sink)` (DAI-6) so Canvas.tsx can
 * route incoming WS position snapshots into `sceneApi.setTargetPositions`
 * without this non-React module holding a Three.js-typed reference.
 */

import { loadStream, type StreamOptions } from './loadStream';
import { cubeToWorld } from '../geom/hex';

const TILE_SIZE = 3.0;

export interface LiveLayoutOptions extends StreamOptions {
  /** Base URL for the Rust RFDB HTTP server (default: same origin) */
  serverUrl?: string;
  onSAProgress?: (iteration: number, cost: number, temperature: number, settled: boolean) => void;
}

/**
 * Narrow sink that only exposes the one method this module calls. Canvas
 * wires in a concrete `SceneApi` (which satisfies this shape) so the
 * WebSocket snapshot handler below can forward positions without this
 * module importing Three.js or `SceneApi` directly.
 */
export interface LiveLayoutSink {
  setTargetPositions(x: Float32Array, z: Float32Array): void;
}

/** Sink reference populated by Canvas.tsx once SceneApi is constructed. */
let _sink: LiveLayoutSink | null = null;

/**
 * Register the sink that will receive WebSocket SA position snapshots.
 * Pass `null` during teardown so a disposed scene does not keep receiving
 * frames. Replaces the former `setHexLayerRef` singleton.
 */
export function setLiveLayoutSink(sink: LiveLayoutSink | null) {
  _sink = sink;
}

export async function loadLiveLayout(opts: LiveLayoutOptions = {}) {
  // Phase 1: Load graph data via JSONL stream + quick client-side SA
  await loadStream(opts);

  // Phase 2: WS SA disabled until index alignment is fixed.
  // (server SA uses all-node indices, client filters out MODULE → index
  // mismatch.) Re-enable by calling `_connectLayoutWebSocket(opts)` once
  // server + client agree on an index space.
  // connectLayoutWebSocket(opts);
}

function _connectLayoutWebSocket(opts: LiveLayoutOptions) {
  const params = new URLSearchParams();
  if (opts.packages) params.set('packages', opts.packages);
  if (opts.maxNodes) params.set('maxNodes', String(opts.maxNodes));

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = opts.serverUrl || window.location.host;
  const url = `${protocol}//${host}/api/layout-live?${params.toString()}`;

  if (import.meta.env?.DEV) console.log('[liveLayout] connecting WS:', url);
  const ws = new WebSocket(url);

  ws.onopen = () => {
    if (import.meta.env?.DEV) console.log('[liveLayout] WS connected');
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      // JSON control frame
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'started':
          if (import.meta.env?.DEV) console.log('[liveLayout] SA started');
          break;
        case 'progress':
          opts.onSAProgress?.(msg.iteration, msg.cost, msg.temperature, msg.settled);
          if (msg.settled) {
            if (import.meta.env?.DEV) console.log('[liveLayout] SA settled, cost:', msg.cost, 'iterations:', msg.iteration);
          }
          break;
        case 'settled':
          if (import.meta.env?.DEV) console.log('[liveLayout] SA complete');
          ws.close();
          break;
      }
    } else if (event.data instanceof Blob) {
      // Binary position frame: [u32 idx, i16 q, i16 r] × N = 8 bytes/node
      event.data.arrayBuffer().then((buffer) => {
        applyPositionSnapshot(buffer);
      });
    }
  };

  ws.onerror = (_e) => {
    console.warn('[liveLayout] WS error — server-side SA unavailable, using client layout');
  };

  ws.onclose = () => {
    if (import.meta.env?.DEV) console.log('[liveLayout] WS closed');
  };
}

function applyPositionSnapshot(buffer: ArrayBuffer) {
  if (!_sink) return;

  const view = new DataView(buffer);
  const nodeCount = view.byteLength / 8;

  // Find max index to size the arrays
  let maxIdx = 0;
  for (let i = 0; i < nodeCount; i++) {
    const idx = view.getUint32(i * 8, true);
    if (idx > maxIdx) maxIdx = idx;
  }

  const targetX = new Float32Array(maxIdx + 1);
  const targetZ = new Float32Array(maxIdx + 1);

  for (let i = 0; i < nodeCount; i++) {
    const idx = view.getUint32(i * 8, true);
    const q = view.getInt16(i * 8 + 4, true);
    const r = view.getInt16(i * 8 + 6, true);
    const { x, z } = cubeToWorld(q, r, TILE_SIZE);
    targetX[idx] = x;
    targetZ[idx] = z;
  }

  _sink.setTargetPositions(targetX, targetZ);
}
