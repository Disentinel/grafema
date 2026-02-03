# Grafema Explore - VS Code Extension

Interactive graph navigation for Grafema code analysis.

## Features

- **Find Node at Cursor** (Cmd+Shift+G) - Find the graph node at your cursor position
- **Explore Edges** - Expand nodes to see incoming/outgoing edges
- **Navigate Graph** - Click on edges to explore connected nodes
- **Go to Source** - Click on any node to jump to its location in code
- **Path Highlighting** - Green markers show your navigation trail

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
