# User Request: REG-523

**Source:** Linear issue REG-523
**Date:** 2026-02-20

## RFDB: WebSocket transport for web environments and browser clients

### Goal

Add WebSocket transport to RFDB server alongside existing Unix socket. This unblocks VS Code web extension (vscode.dev, code-server) and browser clients that don't have access to Unix sockets or raw TCP connections.

### Why WebSocket, not TCP

Browser context (VS Code web extension) doesn't have access to `net.Socket` — only `fetch` and `WebSocket`. Raw TCP from browser is unavailable, so TCP would require a proxy layer. WebSocket is the native browser transport, works directly.

### Motivation

- VS Code web extension connects via `new WebSocket('ws://localhost:7432')`
- Opens demo environment: code-server + Grafema extension + RFDB via WebSocket
- Unified transport for browser clients, Playwright tests, Gobii agents
- Gitpod / StackBlitz scenarios for early access without local installation

### Plan

1. Add `--ws-port <port>` flag to rfdb-server CLI (alongside `--socket`)
2. Start both transports simultaneously (Unix for local dev, WebSocket for web/remote)
3. Update `rfdb-client` — add `WebSocketTransport` alongside `UnixTransport`
4. Configuration in VS Code extension: transport selection (unix | websocket) + host/port

### Acceptance Criteria

- [ ] `rfdb-server ./graph.rfdb --socket /tmp/rfdb.sock --ws-port 7432` starts both transports
- [ ] VS Code web extension connects via `ws://localhost:7432`
- [ ] Protocol is identical (same framing, same commands)
- [ ] Documentation: "Web / Remote setup" section

### Related

- Unblocks: REG-524 (demo environment code-server)
- See also: REG-432 (socket analysis in graph — already Done)
