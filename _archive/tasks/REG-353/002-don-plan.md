# Don Melton - Technical Plan for REG-353

## Analysis

This is a straightforward debugging feature. The VS Code extension already has all the data needed, we just need to expose it via a command.

## Implementation Plan

### 1. EdgesProvider - Add getters for internal state

```typescript
getRootNode(): WireNode | null
getNavigationPath(): string[]  // Array of node IDs on path
getNavigationHistory(): WireNode[]  // For context
```

### 2. package.json - Register command

- Add `grafema.copyTreeState` command with clipboard icon
- Add to view/title menu (group navigation@5)
- Add keybinding: `cmd+shift+c` (Mac) / `ctrl+shift+c` (Win/Linux) when `view == grafemaExplore && focusedView == grafemaExplore`

### 3. extension.ts - Implement command

Track selection and implement serialization:

1. Track `selectedItem: GraphTreeItem | null` via `treeView.onDidChangeSelection`
2. Add command that:
   - Gets connection status from `clientManager.state`
   - Gets server version via `client.ping()` (returns version string)
   - Gets stats via `client.nodeCount()` and `client.edgeCount()`
   - Gets root node from `edgesProvider.getRootNode()`
   - Gets selected node from tracked selection
   - For selected node, fetches visible edges (outgoing + incoming)
   - Serializes to JSON
   - Copies to clipboard via `vscode.env.clipboard.writeText()`
   - Shows info message "Tree state copied to clipboard"

### Output Format

```json
{
  "connection": "connected",
  "serverVersion": "0.2.5",
  "stats": { "nodes": 150000, "edges": 800000 },
  "rootNode": {
    "id": "function:src/index.ts->main",
    "type": "FUNCTION",
    "name": "main",
    "file": "src/index.ts",
    "line": 42
  },
  "selectedNode": {
    "id": "function:src/handlers.ts->handleRequest",
    "type": "FUNCTION",
    "name": "handleRequest",
    "file": "src/handlers.ts",
    "line": 88
  },
  "visibleEdges": [
    { "direction": "outgoing", "type": "CALLS", "target": "function:validateInput" },
    { "direction": "incoming", "type": "CALLED_BY", "source": "function:main" }
  ],
  "navigationPath": ["function:main", "function:processRequest"],
  "historyDepth": 3
}
```

### Decision: Clipboard (Option C)

Clipboard is the right choice because:
- Most direct for the use case (paste to Claude)
- No extra window to manage
- Works offline/anywhere
- Simple UX

### Scope

- 3 files to modify: package.json, edgesProvider.ts, extension.ts
- ~80 LOC total
- No architectural changes needed
