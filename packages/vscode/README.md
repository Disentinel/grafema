# Grafema Explore — VS Code Extension

Interactive graph navigation for Grafema code analysis.

## Features

- **Find Node at Cursor** (Cmd+Shift+G) — Find the graph node at your cursor position
- **Explore Edges** — Expand nodes to see incoming/outgoing edges
- **Navigate Graph** — Click on edges to explore connected nodes
- **Go to Source** — Click on any node to jump to its location in code
- **Path Highlighting** — Green markers show your navigation trail
- **Copy Tree State** — Copy the current exploration tree for debugging

## Requirements

- Grafema graph database (`.grafema/graph.rfdb`) in your workspace
- Run `grafema analyze` first to create the graph

## Installation from Source

```bash
cd packages/vscode
./scripts/install-local.sh
```

## Usage

1. Open a project that has been analyzed with `grafema analyze`
2. Open the "Grafema Explore" panel in the Explorer sidebar
3. Press **Cmd+Shift+G** (Mac) or **Ctrl+Shift+G** (Windows/Linux) to find the node at cursor
4. Expand nodes to explore their edges
5. Click on nodes to navigate to source code

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `grafema.rfdbBinaryPath` | Custom path to rfdb-server binary | Auto-detected |
| `grafema.rfdbTransport` | Transport type: "unix" or "websocket" | "unix" |
| `grafema.rfdbWebSocketUrl` | WebSocket URL (when transport is "websocket") | "ws://localhost:7474" |

### WebSocket Transport (for Web / Remote Environments)

For browser-based VS Code (vscode.dev) or remote development (code-server, Gitpod), configure WebSocket transport:

1. Start rfdb-server with WebSocket support:
   ```bash
   rfdb-server ./path/to/graph.rfdb --socket /tmp/rfdb.sock --ws-port 7474
   ```

2. Configure the extension:
   ```json
   {
     "grafema.rfdbTransport": "websocket",
     "grafema.rfdbWebSocketUrl": "ws://localhost:7474"
   }
   ```

For remote access via SSH tunnel:
```bash
ssh -L 7474:127.0.0.1:7474 user@remote-server
```

## Development

```bash
# Build
pnpm build

# Watch mode
pnpm watch

# Run in VS Code
# 1. Open packages/vscode in VS Code
# 2. Press F5 to launch Extension Development Host
```
