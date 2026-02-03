# User Request: VS Code Extension MVP

## Goal

VS Code extension for interactive graph navigation (like File Explorer for code graph).

**User flow:**
1. Click anywhere in code → panel shows node at cursor as root
2. Node has collapsible children = its edges
3. Expand edge → shows target node's edges (recursive)
4. Collapse → hides children
5. Double-click or context menu → goto file:line:column

## Package Location

`packages/vscode/` — new package in monorepo

## File Structure

```
packages/vscode/
├── package.json          # Extension manifest
├── tsconfig.json
├── esbuild.config.mjs    # Bundling
├── src/
│   ├── extension.ts      # Activation, cursor tracking, commands
│   ├── grafemaClient.ts  # RFDB connection manager
│   ├── graphProvider.ts  # TreeDataProvider (recursive graph tree)
│   ├── nodeLocator.ts    # cursor position → graph node
│   └── types.ts          # GraphTreeItem (node or edge)
└── resources/
    └── grafema-icon.svg
```

## Implementation Steps

### Step 1: Scaffold package

Create `packages/vscode/package.json`:
```json
{
  "name": "grafema-explore",
  "displayName": "Grafema Explore",
  "version": "0.0.1",
  "engines": { "vscode": "^1.74.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onView:grafemaExplore"],
  "contributes": {
    "views": {
      "explorer": [{
        "id": "grafemaExplore",
        "name": "Grafema Explore"
      }]
    },
    "commands": [
      { "command": "grafema.gotoLocation", "title": "Go to Location" },
      { "command": "grafema.refreshEdges", "title": "Refresh", "icon": "$(refresh)" }
    ]
  },
  "dependencies": {
    "@grafema/rfdb-client": "workspace:*",
    "@grafema/types": "workspace:*"
  },
  "devDependencies": {
    "@types/vscode": "^1.74.0",
    "esbuild": "^0.19.0",
    "typescript": "^5.9.3"
  }
}
```

### Step 2: RFDB Client Manager (with auto-start)

`src/grafemaClient.ts`:
- Lazy connection on first use
- Socket path: `{workspaceRoot}/.grafema/rfdb.sock`
- DB path: `{workspaceRoot}/.grafema/graph.rfdb`

**Auto-start logic:**
1. Check if `.grafema/graph.rfdb` exists → if not, show "Run `grafema analyze` first"
2. Try connect to socket
3. If connection fails but DB exists → **spawn rfdb-server**
4. Retry connection

**Server spawn (copy pattern from RFDBServerBackend):**
```typescript
import { spawn } from 'child_process';

// Find binary: packages/rfdb-server/target/release/rfdb-server
// or fallback to @grafema/rfdb npm package
const serverProcess = spawn(binaryPath, [
  '--socket', socketPath,
  '--db', dbPath
], { stdio: 'ignore', detached: true });
serverProcess.unref(); // Don't block VS Code
```

**States:**
- No DB → "No graph. Run `grafema analyze`"
- DB exists, server starting → "Starting graph server..."
- Connected → normal operation

### Step 3: Node Locator

`src/nodeLocator.ts`:
```typescript
async function findNodeAtCursor(client, filePath, line, column): Promise<WireNode | null> {
  const fileNodes = await client.getAllNodes({ file: filePath });
  return fileNodes.find(n => {
    const meta = JSON.parse(n.metadata);
    return meta.line === line;
  });
}
```

### Step 4: EdgesProvider (Recursive Tree)

`src/edgesProvider.ts`:
- TreeDataProvider with **recursive** structure (like File Explorer)
- Each node = collapsible item showing its edges
- `getChildren(element)`:
  - `element === undefined` → return root node (node at cursor)
  - `element.kind === 'node'` → return its edges (outgoing + incoming)
  - `element.kind === 'edge'` → return target node (which is itself expandable)
- Every item with edges has `collapsibleState: Collapsed`
- Double-click command → goto file:line

**Tree structure:**
```
▼ VARIABLE "userId"              ← root, expanded by default
  ├─ ▶ → ASSIGNED_FROM: CALL     ← edge item, collapsible (has target node)
  ├─ ▶ → READS: PARAMETER        ← edge item
  └─ ▶ ← CONTAINS: FUNCTION      ← incoming edge (← arrow)
```

**On expand edge:**
```
▼ VARIABLE "userId"
  ├─ ▼ → ASSIGNED_FROM: CALL "getUser"   ← expanded
  │   ├─ ▶ → CALLS: FUNCTION "api.get"   ← target node's edges
  │   └─ ▶ → ARG: VARIABLE "url"
  └─ ▶ → READS: PARAMETER
```

### Step 5: Extension Entry

`src/extension.ts`:
- Register TreeView
- `onDidChangeTextEditorSelection` with 150ms debounce
- Register `grafema.gotoLocation` command
- Cleanup on deactivate

### Step 6: Build Config

`esbuild.config.mjs`:
```javascript
import esbuild from 'esbuild';
esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node'
});
```

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package location | Monorepo | Share workspace deps |
| Communication | Direct RFDB client | Fastest, no MCP overhead |
| Cursor tracking | 150ms debounce | Prevent query flood |
| Tree structure | Recursive expand/collapse | Like File Explorer, expand to drill down |
| Error handling | Show in panel | No dialogs, graceful |

## Not in MVP (future)

- [ ] Filter by edge/node types (checkboxes in toolbar)
- [ ] Value domain display (show possible values for variables)
- [ ] File node caching (cache getAllNodes per file)
- [ ] Activity bar icon (use explorer sidebar for now)
- [ ] Search in graph (find node by name)

## Verification

1. **Build:**
   ```bash
   cd packages/vscode && pnpm build
   ```

2. **Test manually:**
   - Open workspace with `.grafema/rfdb.sock`
   - Ensure RFDB server running (`grafema analyze` was run)
   - Press F5 to launch Extension Host
   - Click on code → panel shows edges
   - Click edge → navigates to target

3. **Error states:**
   - No `.grafema/graph.rfdb` → panel shows "No graph. Run `grafema analyze`"
   - Server auto-started → panel shows "Starting..." briefly, then normal
   - No node at cursor → panel shows "No graph node at cursor"

## Critical Files Reference

- `packages/rfdb/dist/client.d.ts` — RFDBClient API
- `packages/types/src/rfdb.ts` — WireNode, WireEdge interfaces
- `packages/core/src/storage/backends/RFDBServerBackend.ts:419` — metadata parsing pattern
- `packages/core/src/storage/backends/RFDBServerBackend.ts:161` — `_findServerBinary()` for locating rfdb-server
- `packages/core/src/storage/backends/RFDBServerBackend.ts:197` — `_startServer()` for spawning server process
