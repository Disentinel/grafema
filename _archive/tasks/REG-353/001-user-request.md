# REG-353: VS Code: Add "Copy tree state as text" command for debugging

## Goal

Add command to serialize current tree view state to text/JSON for copy-paste debugging.

## Use case

User can copy current state and paste to Claude for remote debugging without screen sharing.

## Implementation

1. Add command `grafema.copyTreeState`
2. Serialize expanded nodes, selected node, visible data
3. Output to:
   * Option A: New text editor panel (editable, easy copy)
   * Option B: Output channel (read-only)
   * Option C: Clipboard directly

## Output format

```json
{
  "connection": "connected",
  "serverVersion": "0.2.4",
  "stats": { "nodes": 1500000, "edges": 8000000 },
  "expandedNodes": ["file:src/index.ts", "function:main"],
  "selectedNode": {
    "id": "function:main->handleRequest",
    "type": "FUNCTION",
    "file": "src/handlers.ts",
    "line": 42
  },
  "visibleEdges": [
    { "type": "CALLS", "to": "function:validateInput" }
  ]
}
```

## Keyboard shortcut

Cmd+Shift+C when tree panel focused (or via command palette)
