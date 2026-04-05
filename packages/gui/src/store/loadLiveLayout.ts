/**
 * Live layout loader: JSONL stream + WebSocket SA position updates.
 *
 * Phase 1: Fetch /api/graph-stream → parse NDJSON → quick client-side SA → render
 * Phase 2: Connect WS /api/layout-live → receive binary position snapshots → lerp tiles
 */

import { loadStream, type StreamOptions } from './loadStream';
import { cubeToWorld } from './loadFixture';

const TILE_SIZE = 3.0;

export interface LiveLayoutOptions extends StreamOptions {
  /** Base URL for the Rust RFDB HTTP server (default: same origin) */
  serverUrl?: string;
  onSAProgress?: (iteration: number, cost: number, temperature: number, settled: boolean) => void;
}

/** Reference to HexLayer for position updates (set by Canvas after layer creation) */
let _hexLayerRef: { setTargetPositions: (x: Float32Array, z: Float32Array) => void } | null = null;

export function setHexLayerRef(ref: typeof _hexLayerRef) {
  _hexLayerRef = ref;
}

export async function loadLiveLayout(opts: LiveLayoutOptions = {}) {
  // Phase 1: Load graph data via JSONL stream + quick client-side SA
  await loadStream(opts);

  // Phase 2: WS SA disabled until index alignment is fixed
  // (server SA uses all-node indices, client filters out MODULE → index mismatch)
  // TODO: either server filters same as client, or client uses server indices
  // connectLayoutWebSocket(opts);
}

function connectLayoutWebSocket(opts: LiveLayoutOptions) {
  const params = new URLSearchParams();
  if (opts.packages) params.set('packages', opts.packages);
  if (opts.maxNodes) params.set('maxNodes', String(opts.maxNodes));

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = opts.serverUrl || window.location.host;
  const url = `${protocol}//${host}/api/layout-live?${params.toString()}`;

  console.log('[liveLayout] connecting WS:', url);
  const ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[liveLayout] WS connected');
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      // JSON control frame
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'started':
          console.log('[liveLayout] SA started');
          break;
        case 'progress':
          opts.onSAProgress?.(msg.iteration, msg.cost, msg.temperature, msg.settled);
          if (msg.settled) {
            console.log('[liveLayout] SA settled, cost:', msg.cost, 'iterations:', msg.iteration);
          }
          break;
        case 'settled':
          console.log('[liveLayout] SA complete');
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

  ws.onerror = (e) => {
    console.warn('[liveLayout] WS error — server-side SA unavailable, using client layout');
  };

  ws.onclose = () => {
    console.log('[liveLayout] WS closed');
  };
}

function applyPositionSnapshot(buffer: ArrayBuffer) {
  if (!_hexLayerRef) return;

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

  _hexLayerRef.setTargetPositions(targetX, targetZ);
}
