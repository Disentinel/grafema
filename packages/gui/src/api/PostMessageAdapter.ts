/**
 * PostMessage adapter — receives commands from parent window (VS Code webview)
 * and forwards to MapController. Sends events back via postMessage.
 *
 * Protocol: JSON-RPC 2.0 over postMessage
 *
 * Inbound:
 *   { jsonrpc: "2.0", method: "flyTo", params: { nodeId: "..." }, id: 1 }
 *
 * Outbound (response):
 *   { jsonrpc: "2.0", result: { ok: true }, id: 1 }
 *
 * Outbound (event):
 *   { jsonrpc: "2.0", method: "event", params: { type: "nodeClick", ... } }
 */

import { mapController } from './MapController';

export function initPostMessageAdapter() {
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    // JSON-RPC request
    if (msg.jsonrpc === '2.0' && msg.method) {
      const result = mapController.handleRPC({
        method: msg.method,
        params: msg.params ?? {},
      });

      // Send response if id is present
      if (msg.id !== undefined) {
        const response = {
          jsonrpc: '2.0' as const,
          result,
          id: msg.id,
        };
        window.parent.postMessage(response, '*');
      }
      return;
    }

    // Legacy format: { command: "highlightNode", ... }
    if (msg.command) {
      let result;
      switch (msg.command) {
        case 'highlightNode':
          result = mapController.flyTo({ nodeName: msg.nodeName, nodeId: msg.nodeId });
          break;
        case 'setLens':
          result = mapController.setLens({ name: msg.lens });
          break;
        case 'toggleFlow':
          result = mapController.toggleFlow({ name: msg.flow });
          break;
        default:
          result = { ok: false, error: `Unknown command: ${msg.command}` };
      }
      if (msg.id) window.parent.postMessage({ id: msg.id, ...result }, '*');
    }
  });

  console.log('[PostMessageAdapter] Listening for commands');
}

/** Send an event to parent */
export function emitEvent(type: string, data: Record<string, unknown>) {
  window.parent.postMessage({
    jsonrpc: '2.0',
    method: 'event',
    params: { type, ...data },
  }, '*');
}
