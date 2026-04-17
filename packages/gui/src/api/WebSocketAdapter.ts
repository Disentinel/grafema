/**
 * WebSocket adapter — connects to a WS server for external control.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket
 * Same commands as PostMessageAdapter.
 *
 * Connection: ws://localhost:{port}/ws
 * The port is configurable via ?wsPort=XXXX query param.
 */

import { mapController } from './MapController';

let ws: WebSocket | null = null;

export function initWebSocketAdapter() {
  const params = new URLSearchParams(window.location.search);
  const port = params.get('wsPort');
  if (!port) {
    console.log('[WS] No wsPort param — WebSocket adapter disabled');
    return;
  }

  const url = `ws://localhost:${port}/ws`;
  console.log(`[WS] Connecting to ${url}...`);

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] Connected');
    sendEvent('connected', { version: '2.0' });
  };

  ws.onmessage = (event) => {
    let msg: { jsonrpc?: string; method?: string; params?: Record<string, unknown>; id?: number };
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn('[WS] Invalid JSON:', event.data);
      return;
    }

    if (msg.jsonrpc === '2.0' && msg.method) {
      const result = mapController.handleRPC({
        method: msg.method,
        params: msg.params ?? {},
      });

      if (msg.id !== undefined) {
        ws?.send(JSON.stringify({
          jsonrpc: '2.0',
          result,
          id: msg.id,
        }));
      }
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected');
    // Auto-reconnect after 3s
    setTimeout(initWebSocketAdapter, 3000);
  };

  ws.onerror = (err) => {
    console.warn('[WS] Error:', err);
  };
}

export function sendEvent(type: string, data: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: { type, ...data },
    }));
  }
}
