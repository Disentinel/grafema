# Don Melton — Plan for REG-514

**Role:** Tech Lead
**Persona:** "I don't care if it works, is it RIGHT?"
**Scope:** Phase 2 — CALLERS panel (call hierarchy TreeView) + CodeLens

---

## 1. Current State Audit

**Extension source files (13 files after Phase 1/REG-513):**

| File | Purpose | LOC |
|------|---------|-----|
| `src/extension.ts` | Activation, command registration, status bar, follow-cursor | ~500 |
| `src/edgesProvider.ts` | `EdgesProvider implements TreeDataProvider<GraphTreeItem>` — Explorer panel | ~454 |
| `src/grafemaClient.ts` | `GrafemaClientManager extends EventEmitter` — RFDB connection lifecycle | ~438 |
| `src/nodeLocator.ts` | `findNodeAtCursor()` — cursor-to-node resolution | ~103 |
| `src/statusProvider.ts` | `StatusProvider implements TreeDataProvider<StatusItem>` | ~124 |
| `src/debugProvider.ts` | `DebugProvider implements TreeDataProvider<DebugItem>` | ~102 |
| `src/types.ts` | Types, parse helpers, `ValueTraceItem` union | ~181 |
| `src/utils.ts` | `debounce()`, `getIconName()`, `getNodeIcon()` | ~81 |
| `src/traceEngine.ts` | BFS for value trace — `traceBackward()`, `traceForward()` | ~281 |
| `src/hoverProvider.ts` | `GrafemaHoverProvider implements vscode.HoverProvider` | ~140 |
| `src/valueTraceProvider.ts` | `ValueTraceProvider implements TreeDataProvider<ValueTraceItem>` | ~332 |
| `src/cursorTracker.ts` | `findAndSetRoot()`, `updateStatusBar()` | ~188 |
| `src/treeStateExporter.ts` | Tree state export for debugging | ~(unknown) |

**Graph API (fully confirmed):**
- `client.getIncomingEdges(id, edgeTypes?)` — incoming CALLS edges give callers
- `client.getOutgoingEdges(id, edgeTypes?)` — outgoing CALLS edges give callees
- `client.getAllNodes({ file })` — all nodes in a file (for CodeLens)
- `client.getAllNodes({ nodeType: 'FUNCTION' })` — all FUNCTION nodes
- `client.countEdgesByType(edgeTypes?)` — count edges by type (EXISTS and is relevant)
- `client.findByType(nodeType)` — returns IDs of nodes by type
- `client.bfs(startIds, maxDepth, edgeTypes?)` — server-side forward BFS

**CALLS edge confirmed in schema (`packages/types/src/edges.ts`):**
```
CALLS: 'CALLS'
```
Also present: `CALLS_API`. The CALLERS panel uses `CALLS` edges only.

Edge direction for CALLS (standard call graph convention):
- `src --CALLS--> dst` means the function at `src` calls the function at `dst`.
- **Callers of F** = `getIncomingEdges(F.id, ['CALLS'])` → `edge.src` = the calling function
- **Callees of F** = `getOutgoingEdges(F.id, ['CALLS'])` → `edge.dst` = the called function

**Node types relevant to Phase 2:**
- `FUNCTION` — top-level functions
- `METHOD` — class methods (same traversal applies)
- Both are function-like; CodeLens targets both.

**package.json views already registered (Phase 0):**
```json
{ "id": "grafemaCallers", "name": "Callers", "visibility": "collapsed" }
```
The view is pre-registered with a placeholder `viewsWelcome`. Phase 2 replaces the welcome message with a real TreeDataProvider.

**No existing CodeLens implementation.** The `packages/vscode/src/` directory has no `codelens*.ts` file. This is net-new code.

**Test infrastructure:** `packages/vscode/test/unit/` with `node:test` and `node:assert/strict`. Mock `IRFDBClient` pattern established in `traceEngine.test.ts`. Phase 2 tests follow the same pattern.

**Build:** Single esbuild entry point (`src/extension.ts`), CJS output. All new source files are auto-bundled by esbuild — no build config changes needed.

---

## 2. Architecture Decisions

### 2.1 TreeView vs. VSCode Native `CallHierarchyProvider`

VSCode has a built-in `CallHierarchyProvider` interface that produces the standard "Call Hierarchy" panel. It is **not** appropriate here.

**Reasons to use custom TreeView instead:**

1. **Data source is the Grafema graph, not the language server.** `CallHierarchyProvider` is integrated with LSP and language servers. Grafema's graph is independent of any language server — it has its own node IDs and edge structure. There is no sensible mapping from graph nodes to `vscode.CallHierarchyItem` without fabricating `vscode.Uri` + position data.

2. **`CallHierarchyProvider` requires accurate source positions.** It opens files and places markers. Our graph nodes have `line`/`column` in metadata but the UI entry point is the Grafema Activity Bar panel, not a right-click context menu.

3. **Grafema panel consistency.** The existing VALUE TRACE and Explorer panels are custom TreeViews. The CALLERS panel should be architecturally identical — a `TreeDataProvider` registered with `vscode.window.registerTreeDataProvider`. Deviating to a different API would create two incompatible patterns in the same extension.

4. **Filters are panel-native.** The `CallHierarchyProvider` interface provides no way to inject test-file or node_modules filters. Our CALLERS panel needs them.

**Decision: Custom `TreeDataProvider<CallersItem>` for the `grafemaCallers` view.**

### 2.2 CALLERS Panel Structure

The panel has two modes: **Incoming** (who calls this) and **Outgoing** (what does this call). The user toggles between them, or shows both simultaneously.

Structure at root level:
```
[Function: "handleRequest"]    ← pinned root node label
  Incoming (3 callers)         ← section header
    ← CALLS  FUNCTION "router.get"   routes/api.js:45
        ← CALLS  FUNCTION "app.use"  app.js:12
    ← CALLS  FUNCTION "router.post"  routes/api.js:78
    ← CALLS  FUNCTION "testRequest"  test/api.test.js:33  [test]
  Outgoing (2 callees)         ← section header
    → CALLS  FUNCTION "validateInput"  utils/validate.js:8
    → CALLS  FUNCTION "db.findUser"    db/users.js:22
```

This parallels the VALUE TRACE panel's Origins/Destinations structure. Three potential sections:
- `Incoming` — callers (incoming CALLS edges)
- `Outgoing` — callees (outgoing CALLS edges)
- A pinned root label at the top

**Decision: Three-section flat root structure. Recursive expansion on demand.**

### 2.3 Lazy vs. Eager Loading for Call Hierarchy

VALUE TRACE pre-loads the full trace when `traceNode()` is called. For call hierarchy this would be expensive: a popular function might have 50 callers, each with their own callers.

**Decision: Lazy per-node loading.** `getChildren()` fetches CALLS edges on demand when a node is expanded. The top-level callers/callees of the root are fetched immediately (same as VALUE TRACE), but second-level and beyond are fetched lazily on expand.

This means `CallersItem` nodes do NOT pre-fetch their children. Children are fetched when `getChildren(element)` is called with that element.

### 2.4 Depth Control Strategy

The Quick Pick depth control sets `maxDepth` on the provider. At `maxDepth=1`, the tree shows only direct callers/callees. At `maxDepth=3`, each caller's callers are also shown (up to 3 levels). At `maxDepth=5` (max), five levels deep.

**Decision: `maxDepth` controls whether `getChildren()` returns data or shows a "max depth reached" leaf.** It is NOT server-side BFS — it is per-expand client-side depth tracking (same cycle-detection visited-set pattern as `EdgesProvider`).

### 2.5 Filters Implementation

Two filters:
1. **Hide test files** — check `node.file` for patterns: `/test/`, `\.test\.`, `\.spec\.`, `__tests__`
2. **Hide node_modules** — check `node.file` for `node_modules/`

Filters are applied in `getChildren()` when building the child list. They do NOT require re-querying the graph — just filter the already-fetched edges.

Filter state is held on the provider instance, toggled via commands.

### 2.6 CodeLens Architecture

`vscode.languages.registerCodeLensProvider` requires a `CodeLensProvider` implementation:

```typescript
interface CodeLensProvider {
  provideCodeLenses(document, token): ProviderResult<CodeLens[]>;
  resolveCodeLens?(codeLens, token): ProviderResult<CodeLens>;
}
```

**Workflow:**
1. `provideCodeLenses` is called when a file is opened or scrolled.
2. It queries all FUNCTION/METHOD nodes in the current file.
3. For each function node, creates a `CodeLens` with a placeholder command.
4. Returns all `CodeLens` objects. VSCode then calls `resolveCodeLens` for each visible one.
5. `resolveCodeLens` fetches the actual caller/callee counts from the graph and sets the command.

**Two-phase approach (provideCodeLenses + resolveCodeLens):** This is the standard VSCode pattern. `provideCodeLenses` is fast (returns positions), `resolveCodeLens` is where the expensive per-lens data fetch happens. VSCode only calls `resolveCodeLens` for lenses that are visible in the current viewport.

**However:** `resolveCodeLens` runs sequentially for each visible lens. For a file with 20 visible functions, this means 20 sequential `getIncomingEdges` + `getOutgoingEdges` calls. At ~5ms per call, that's ~200ms latency — borderline but acceptable.

**Better approach: Batch in `provideCodeLenses`, cache results, return pre-resolved lenses from `resolveCodeLens`.**

Strategy:
1. `provideCodeLenses` fetches all nodes for the file (single `getAllNodes({ file })` call).
2. Filters to FUNCTION/METHOD nodes.
3. Launches a single background batch-fetch of all edge counts (parallel `Promise.all`).
4. Returns `CodeLens` objects with placeholder text while batch runs.
5. When batch completes, fires `onDidChangeCodeLenses` event to trigger re-resolution.
6. `resolveCodeLens` reads from in-memory cache — returns instantly.

**Cache invalidation:** On `clientManager 'reconnected'` event — same pattern as other providers.

**CodeLens text format:**
```
3 callers · 2 callees · blast: ?
```
The "blast" segment is a placeholder until Phase 4. For Phase 2, show `blast: ?` or omit it entirely with a `grafema.codeLens.showBlast` setting.

### 2.7 "Blast Radius" Placeholder

The task spec says: "'blast: 5 files' → opens BLAST RADIUS panel (or placeholder if Phase 4 not done)".

**Decision:** Show `blast: ?` in the CodeLens text for Phase 2. The command opens a "Coming in Phase 4" information message. This is honest and explicit — no fake data. When Phase 4 is implemented, the CodeLens provider is updated in place.

### 2.8 Follow Cursor for CALLERS Panel

When follow-cursor mode is active and the cursor is on a FUNCTION node, the CALLERS panel should auto-focus on that function.

**Decision: Hook into the existing follow-cursor mechanism in `extension.ts`.** The existing `debounce(onDidChangeTextEditorSelection, 150)` handler already calls `findAndSetRoot` (Explorer) and `findAndTraceAtCursor` (VALUE TRACE). Add a third call: `findAndSetCallersAtCursor()`.

This function:
1. Finds the node at cursor (reusing `findNodeAtCursor`).
2. Checks if it's a FUNCTION or METHOD node.
3. If yes, calls `callersProvider.setRootNode(node)`.
4. If no, does nothing (CALLERS panel stays on its last pinned function).

---

## 3. Files to Create/Modify

### New Files

| File | Purpose | Estimated LOC |
|------|---------|---------------|
| `src/callersProvider.ts` | `CallersProvider implements TreeDataProvider<CallersItem>` — CALLERS panel | ~320 |
| `src/codeLensProvider.ts` | `GrafemaCodeLensProvider implements CodeLensProvider` — CodeLens above functions | ~200 |
| `test/unit/callersProvider.test.ts` | Unit tests for call hierarchy traversal logic | ~220 |
| `test/unit/codeLensProvider.test.ts` | Unit tests for CodeLens batch fetch and cache | ~120 |

**Total new: ~860 LOC**

### Modified Files

| File | Changes | Estimated Delta LOC |
|------|---------|---------------------|
| `src/types.ts` | Add `CallersItem` union type | +60 |
| `src/extension.ts` | Register `CallersProvider`, `CodeLensProvider`, add commands (`grafema.openCallers`, `grafema.setCallersDepth`, `grafema.toggleCallersFilter`, `grafema.toggleCallersDirection`, `grafema.refreshCallers`), add `findAndSetCallersAtCursor()` to follow-cursor handler | +100 |
| `package.json` | Remove `viewsWelcome` for `grafemaCallers`, add commands, add menus for CALLERS title bar, add `activationEvent` for `grafemaCallers`, add `grafema.codeLens.*` settings | +70 |

**Total modified: ~230 LOC delta**

### Not Modified

- `src/grafemaClient.ts` — no changes (API is sufficient)
- `src/nodeLocator.ts` — reused as-is
- `src/edgesProvider.ts` — no changes
- `src/statusProvider.ts` — no changes
- `src/debugProvider.ts` — no changes
- `src/hoverProvider.ts` — no changes
- `src/valueTraceProvider.ts` — no changes
- `src/traceEngine.ts` — no changes
- `src/utils.ts` — reuse `getNodeIcon()`, `debounce()`
- `src/cursorTracker.ts` — no changes (follow-cursor logic stays there)
- `esbuild.config.mjs` — no changes (single entry point, new files auto-bundled)

---

## 4. Type Definitions (`src/types.ts` additions)

```typescript
// === CALLERS PANEL TYPES ===

/**
 * Union type for all items in the CALLERS TreeDataProvider.
 *
 * Kinds:
 *   - 'root'    : pinned root node label (the function being analyzed)
 *   - 'section' : "Incoming (N callers)" or "Outgoing (N callees)" header
 *   - 'call-node': a caller or callee function node (recursively expandable)
 *   - 'status'  : placeholder when not connected / no node pinned
 *   - 'more'    : "N+ more — use Explorer for full view" leaf
 */
export type CallersItem =
  | { kind: 'root'; node: WireNode; metadata: NodeMetadata }
  | { kind: 'section'; label: string; icon: string; direction: 'incoming' | 'outgoing'; count: number }
  | { kind: 'call-node'; node: WireNode; metadata: NodeMetadata; direction: 'incoming' | 'outgoing'; depth: number; visitedIds: Set<string> }
  | { kind: 'status'; message: string }
  | { kind: 'more'; count: number };
```

**Note on `visitedIds`:** Passed into each `call-node` to detect cycles during recursive expansion — same pattern as `EdgesProvider.getChildren()` which uses `visitedNodeIds: Set<string>` on `GraphTreeItem`.

---

## 5. `CallersProvider` Implementation

### 5.1 Class Structure

```typescript
export class CallersProvider implements vscode.TreeDataProvider<CallersItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<...>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNode: WireNode | null = null;
  private incomingCount: number = 0;   // cached count for section header
  private outgoingCount: number = 0;   // cached count for section header
  private maxDepth: number = 3;        // Quick Pick configurable (1-5)
  private hideTestFiles: boolean = true;
  private hideNodeModules: boolean = true;
  private showDirection: 'incoming' | 'outgoing' | 'both' = 'both';

  constructor(private clientManager: GrafemaClientManager) {
    clientManager.on('reconnected', () => {
      this.rootNode = null;
      this._onDidChangeTreeData.fire();
    });
  }
}
```

### 5.2 `setRootNode(node: WireNode | null)`

```
- Store rootNode
- Reset incomingCount / outgoingCount to 0
- Fire _onDidChangeTreeData (triggers re-render with new root)
- Then async: fetch and cache incoming/outgoing counts for the section headers
```

Counts are fetched once when root is set, then used to show `"Incoming (3 callers)"` in the section header. This avoids fetching counts on every `getChildren()` call.

### 5.3 `getChildren(element?)`

**Root level (no element):**
Returns:
1. `{ kind: 'status', message }` if not connected or no root
2. `{ kind: 'root', node, metadata }` — the pinned function label
3. `{ kind: 'section', direction: 'incoming', count: incomingCount }` (if `showDirection !== 'outgoing'`)
4. `{ kind: 'section', direction: 'outgoing', count: outgoingCount }` (if `showDirection !== 'incoming'`)

**Section element:**
```
edges = await client.getIncomingEdges(rootNode.id, ['CALLS'])   // for 'incoming'
      OR getOutgoingEdges(rootNode.id, ['CALLS'])               // for 'outgoing'
filtered = applyFilters(edges)
capped = filtered.slice(0, MAX_BRANCHING_FACTOR)
items = capped.map(edge => {
  peerId = direction === 'incoming' ? edge.src : edge.dst
  peerNode = await client.getNode(peerId)
  return { kind: 'call-node', node: peerNode, direction, depth: 0, visitedIds: new Set([rootNode.id]) }
})
if (filtered.length > MAX_BRANCHING_FACTOR): items.push({ kind: 'more', count: filtered.length - MAX_BRANCHING_FACTOR })
```

**call-node element:**
```
if (element.depth >= maxDepth): return []   // depth limit

peerEdges = getIncomingEdges(element.node.id, ['CALLS'])   // if direction is 'incoming'
           OR getOutgoingEdges(element.node.id, ['CALLS'])  // if direction is 'outgoing'
filtered = applyFilters(peerEdges)
newVisited = new Set([...element.visitedIds, element.node.id])

children = []
for edge of filtered.slice(0, MAX_BRANCHING_FACTOR):
  peerId = direction === 'incoming' ? edge.src : edge.dst
  if newVisited.has(peerId): skip   // cycle prevention
  peerNode = await client.getNode(peerId)
  children.push({ kind: 'call-node', ..., depth: element.depth + 1, visitedIds: newVisited })

if filtered.length > MAX_BRANCHING_FACTOR: children.push({ kind: 'more', count: ... })
return children
```

### 5.4 Filter Helper

```typescript
function applyFilters(edges: WireEdge[], nodes: Map<string, WireNode>, opts: FilterOpts): WireEdge[] {
  // ...filter based on node.file for test patterns and node_modules
}
```

However, to filter we need the nodes. The filter is applied AFTER fetching peer nodes, or we can filter on the edge's metadata if it carries file information. In practice, we fetch the peer node anyway (to display its name and location), so we filter after `getNode()`.

**Revised approach:**
```
for edge of edges:
  peerId = ...
  peerNode = await client.getNode(peerId)
  if !peerNode: skip
  if hideTestFiles && isTestFile(peerNode.file): skip
  if hideNodeModules && peerNode.file.includes('node_modules/'): skip
  children.push(...)
```

This is correct but serializes the node fetches. For performance on the first-level expansion (which is the most common), we accept this. Parallelizing with `Promise.all` is an option but adds complexity.

**Decision:** For Phase 2, serial fetch is acceptable. Add a `// TODO: parallelize with Promise.all` comment for future optimization.

### 5.5 `getTreeItem(element: CallersItem)`

- `root` kind: Label = `FUNCTION "name"`, icon = `getNodeIcon('FUNCTION')`, collapsed = None. Click = `grafema.gotoLocation`.
- `section` kind: Label = `Incoming (3 callers)` / `Outgoing (2 callees)`, collapsed = Expanded, icon = `'arrow-circle-left'`/`'arrow-circle-right'`.
- `call-node` kind: Label = direction arrow + function name, description = `file:line`, click = `grafema.gotoLocation`. Icon = `getNodeIcon(node.nodeType)`. Collapsed = Collapsed (children fetched lazily). Tooltip = full node info.
- `status` kind: Message text, `info` icon, None.
- `more` kind: `"N+ more — use Explorer for full call graph"`, ellipsis icon.

### 5.6 Commands

| Command ID | Title | Purpose |
|-----------|-------|---------|
| `grafema.openCallers` | `Grafema: Open Callers` | Pin function at cursor in CALLERS panel |
| `grafema.setCallersDepth` | `Set Max Depth` | Quick Pick depth 1-5 |
| `grafema.toggleCallersFilter` | `Toggle Filters` | Quick Pick to toggle test/node_modules filter |
| `grafema.toggleCallersDirection` | `Toggle Direction` | Cycle incoming → outgoing → both |
| `grafema.refreshCallers` | `Refresh` | Clear cache, re-fetch for current root |

---

## 6. CodeLens Provider Implementation

### 6.1 File: `src/codeLensProvider.ts`

```typescript
export class GrafemaCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  // Cache: fileUri -> Map<nodeId, { callers: number; callees: number }>
  private cache: Map<string, Map<string, { callers: number; callees: number }>> = new Map();

  constructor(private clientManager: GrafemaClientManager) {
    clientManager.on('reconnected', () => {
      this.cache.clear();
      this._onDidChangeCodeLenses.fire();
    });
  }
}
```

### 6.2 `provideCodeLenses(document, token)`

```
1. Guard: if !clientManager.isConnected(): return []
2. Guard: if !config.get('grafema.codeLens.enabled'): return []

3. filePath = relative path from workspace root
4. fileNodes = await client.getAllNodes({ file: filePath })
5. funcNodes = fileNodes.filter(n => n.nodeType === 'FUNCTION' || n.nodeType === 'METHOD')
6. if funcNodes.length === 0: return []

7. Launch background batch: batchFetchCounts(filePath, funcNodes)
   (Does NOT await here — returns placeholder lenses immediately)

8. lenses = funcNodes.map(node => {
     meta = parseNodeMetadata(node)
     if meta.line === undefined: skip
     pos = new vscode.Position(meta.line - 1, meta.column ?? 0)
     range = new vscode.Range(pos, pos)
     lens = new vscode.CodeLens(range)
     lens.command = {
       command: 'grafema.codeLensPlaceholder',
       title: 'Grafema: loading...',
       arguments: [node.id]
     }
     return lens
   })

9. return lenses
```

### 6.3 `batchFetchCounts(filePath, funcNodes)`

```typescript
private async batchFetchCounts(filePath: string, funcNodes: WireNode[]): Promise<void> {
  const counts = new Map<string, { callers: number; callees: number }>();

  // Parallel fetch for all function nodes in the file
  await Promise.all(funcNodes.map(async (node) => {
    const [incoming, outgoing] = await Promise.all([
      client.getIncomingEdges(node.id, ['CALLS']),
      client.getOutgoingEdges(node.id, ['CALLS']),
    ]);
    counts.set(node.id, {
      callers: incoming.length,
      callees: outgoing.length,
    });
  }));

  this.cache.set(filePath, counts);
  this._onDidChangeCodeLenses.fire();  // triggers VSCode to re-call provideCodeLenses
}
```

**Caching rationale:** When `_onDidChangeCodeLenses.fire()` triggers VSCode to re-call `provideCodeLenses`, the second call finds the cache populated and returns pre-resolved lenses immediately.

### 6.4 Revised `provideCodeLenses` with cache check

```
7. Check cache: if cache.has(filePath):
     use cached counts to build resolved lenses immediately (skip background fetch)
   else:
     launch batchFetchCounts() (fire-and-forget)
     return placeholder lenses
```

### 6.5 CodeLens text format

From cache, build the command title:
```
"3 callers · 2 callees · blast: ?"
```

Three segments = three separate CodeLens objects stacked on the same line:
- Lens 1: `"3 callers"` → command `grafema.openCallers` with `{ nodeId, direction: 'incoming' }`
- Lens 2: `"2 callees"` → command `grafema.openCallers` with `{ nodeId, direction: 'outgoing' }`
- Lens 3: `"blast: ?"` → command `grafema.blastRadiusPlaceholder`

**Decision: Three separate `CodeLens` objects per function, placed on the same line.** VSCode renders multiple lenses on the same range by concatenating them horizontally. This is the correct pattern for multi-segment CodeLens (e.g., git blame shows multiple lenses on one line).

**Alternative considered:** A single `CodeLens` with the full `"3 callers · 2 callees · blast: ?"` title as one command. Simpler, but then clicking anywhere triggers only one action. The spec requires each segment to be independently clickable. Therefore: three lenses.

### 6.6 `resolveCodeLens(codeLens, token)`

Since we fire `_onDidChangeCodeLenses` after caching, `provideCodeLenses` returns pre-resolved lenses on the second call. `resolveCodeLens` is only needed for the initial load when cache is empty.

```typescript
resolveCodeLens(codeLens: vscode.CodeLens, _token: vscode.CancellationToken): vscode.CodeLens {
  // If command is still the placeholder, check cache
  const nodeId = codeLens.command?.arguments?.[0] as string | undefined;
  if (!nodeId) return codeLens;

  const filePath = /* derive from current document */ '';
  const cached = this.cache.get(filePath)?.get(nodeId);
  if (cached) {
    codeLens.command = buildCommand(nodeId, cached);
  }
  return codeLens;
}
```

However, `resolveCodeLens` does not receive the document — only the CodeLens. We must embed the filePath in the CodeLens's argument array for lookup.

**Decision:** `arguments` array: `[nodeId, filePath]`. Both `provideCodeLenses` and `resolveCodeLens` use this.

### 6.7 Registration in `extension.ts`

```typescript
const codeLensProvider = new GrafemaCodeLensProvider(clientManager);
const codeLensDisposable = vscode.languages.registerCodeLensProvider(
  [
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'typescriptreact' },
  ],
  codeLensProvider
);
```

---

## 7. Graph Queries Required

| Query | Client API | When Used |
|-------|-----------|-----------|
| Get callers of function F | `client.getIncomingEdges(F.id, ['CALLS'])` | CALLERS panel section expansion |
| Get callees of function F | `client.getOutgoingEdges(F.id, ['CALLS'])` | CALLERS panel section expansion |
| Get all functions in file | `client.getAllNodes({ file: filePath })` then filter by nodeType | CodeLens `provideCodeLenses` |
| Count callers/callees for CodeLens | `getIncomingEdges(F.id, ['CALLS']).length` + `getOutgoingEdges(F.id, ['CALLS']).length` | CodeLens batch fetch |
| Resolve node ID to WireNode | `client.getNode(id)` | CALLERS panel call-node expansion |

**Are current APIs sufficient?** Yes. All required queries are already in `RFDBClient`. No new server-side commands needed.

**One performance consideration:** `getIncomingEdges` / `getOutgoingEdges` return full edge objects including metadata. For the CALLERS panel, we need only the peer node ID (`edge.src` or `edge.dst`). For CodeLens counts, we need only `.length`. The current API returns full edge data — this is acceptable for Phase 2 (edge objects are small).

---

## 8. Performance Considerations

### CALLERS Panel

- **First-level expansion** (callers/callees of root): One `getIncomingEdges` + one `getOutgoingEdges` = 2 RPCs. Fast (~10ms each).
- **Count fetch on root set**: `getIncomingEdges + getOutgoingEdges` = 2 RPCs run immediately when root is set, before user expands sections.
- **Recursive expansion**: Each expand = 1 RPC per node expanded. Depth-limited by `maxDepth`. With `MAX_BRANCHING_FACTOR=5` and `maxDepth=3`, worst case = 5^0 + 5^1 + 5^2 + 5^3 = 156 nodes. This is pathological — typical functions have 2-10 callers.
- **Cycle detection**: `visitedIds` set prevents infinite recursion on mutual recursion.

### CodeLens

- **`provideCodeLenses` (cold)**: 1 RPC (`getAllNodes`) + N × 2 RPCs (one per function). For a file with 20 functions: 41 RPCs in parallel. At ~5ms each, parallel execution: ~5-15ms total. Acceptable.
- **`provideCodeLenses` (warm, cache hit)**: 1 RPC (`getAllNodes`) for node positions only, counts from cache. Very fast.
- **Cache lifetime**: Cleared on `reconnected` event (re-analyze). Not time-based — counts are stable until the graph is re-built.
- **Viewport optimization**: VSCode only calls `resolveCodeLens` for lenses in the visible viewport. With our background-batch approach, all counts are fetched at once (not per-viewport-item), which is more efficient for typical files.

### Blast Radius Placeholder

The `blast: ?` lens fires a one-liner info message. Zero graph queries. Phase 4 will replace this.

---

## 9. Settings & Configuration

Add to `package.json` `contributes.configuration.properties`:

```json
"grafema.codeLens.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Show Grafema CodeLens above functions (caller/callee counts)."
},
"grafema.codeLens.showBlastRadius": {
  "type": "boolean",
  "default": false,
  "description": "Show blast radius count in CodeLens. Requires Phase 4 (Blast Radius panel)."
},
"grafema.callers.defaultDepth": {
  "type": "number",
  "default": 3,
  "minimum": 1,
  "maximum": 5,
  "description": "Default max depth for call hierarchy expansion in CALLERS panel."
},
"grafema.callers.hideTestFiles": {
  "type": "boolean",
  "default": true,
  "description": "Hide test files from CALLERS panel."
},
"grafema.callers.hideNodeModules": {
  "type": "boolean",
  "default": true,
  "description": "Hide node_modules from CALLERS panel."
}
```

---

## 10. package.json Changes

### Remove `viewsWelcome` for `grafemaCallers`

The Phase 0 placeholder:
```json
{
  "view": "grafemaCallers",
  "contents": "Call hierarchy shows who calls this function and what it calls.\n\nComing in Phase 2."
}
```
Remove this. The provider's empty state message replaces it.

### Add activation event

```json
"activationEvents": [
  "onView:grafemaStatus",
  "onView:grafemaExplore",
  "onView:grafemaValueTrace",
  "onView:grafemaCallers"
]
```

### Add commands

```json
{ "command": "grafema.openCallers", "title": "Grafema: Open Callers" },
{ "command": "grafema.setCallersDepth", "title": "Set Max Depth", "icon": "$(layers)" },
{ "command": "grafema.toggleCallersFilter", "title": "Toggle Filters", "icon": "$(filter)" },
{ "command": "grafema.toggleCallersDirection", "title": "Toggle Direction", "icon": "$(arrow-swap)" },
{ "command": "grafema.refreshCallers", "title": "Refresh", "icon": "$(refresh)" },
{ "command": "grafema.blastRadiusPlaceholder", "title": "Blast Radius (coming Phase 4)" }
```

### Add menus for CALLERS title bar

```json
"view/title": [
  { "command": "grafema.toggleCallersDirection", "when": "view == grafemaCallers", "group": "navigation@0" },
  { "command": "grafema.toggleCallersFilter", "when": "view == grafemaCallers", "group": "navigation@1" },
  { "command": "grafema.setCallersDepth", "when": "view == grafemaCallers", "group": "navigation@2" },
  { "command": "grafema.refreshCallers", "when": "view == grafemaCallers", "group": "navigation@3" }
]
```

---

## 11. extension.ts Changes

### Registration (in `activate()`)

```typescript
// CALLERS panel
const callersProvider = new CallersProvider(clientManager);
const callersRegistration = vscode.window.registerTreeDataProvider('grafemaCallers', callersProvider);

// CodeLens
const codeLensProvider = new GrafemaCodeLensProvider(clientManager);
const codeLensDisposable = vscode.languages.registerCodeLensProvider([...], codeLensProvider);
```

### New follow-cursor trigger

In `debounce(onDidChangeTextEditorSelection, 150)` handler:
```typescript
if (followCursor && clientManager?.isConnected()) {
  await findAndSetRoot(clientManager, edgesProvider, debugProvider, false);
  await findAndTraceAtCursor();           // VALUE TRACE
  await findAndSetCallersAtCursor();      // CALLERS panel
}
```

### `findAndSetCallersAtCursor()` (new function, ~25 LOC)

```typescript
async function findAndSetCallersAtCursor(): Promise<void> {
  if (!callersProvider || !clientManager) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  if (!clientManager.isConnected()) return;
  if (editor.document.uri.scheme !== 'file') return;

  const position = editor.selection.active;
  const absPath = editor.document.uri.fsPath;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const filePath = workspaceRoot && absPath.startsWith(workspaceRoot)
    ? absPath.slice(workspaceRoot.length + 1)
    : absPath;

  try {
    const client = clientManager.getClient();
    const node = await findNodeAtCursor(client, filePath, position.line + 1, position.character);
    if (node && (node.nodeType === 'FUNCTION' || node.nodeType === 'METHOD')) {
      callersProvider.setRootNode(node);
    }
  } catch {
    // Silent fail
  }
}
```

### New commands to register

```typescript
// Open CALLERS panel at cursor
vscode.commands.registerCommand('grafema.openCallers', async () => {
  await vscode.commands.executeCommand('grafemaCallers.focus');
  await findAndSetCallersAtCursor();
})

// Quick Pick depth control
vscode.commands.registerCommand('grafema.setCallersDepth', async () => {
  const items = ['1', '2', '3', '4', '5'].map(d => ({
    label: d,
    description: d === String(callersProvider?.getMaxDepth()) ? '(current)' : '',
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Max call hierarchy depth' });
  if (picked) callersProvider?.setMaxDepth(parseInt(picked.label));
})

// Toggle test/node_modules filter via Quick Pick checkboxes
vscode.commands.registerCommand('grafema.toggleCallersFilter', async () => {
  // ... Quick Pick with canPickMany for filter options
})

// Toggle direction: both → incoming → outgoing → both
vscode.commands.registerCommand('grafema.toggleCallersDirection', () => {
  callersProvider?.cycleDirection();
})

// Refresh
vscode.commands.registerCommand('grafema.refreshCallers', () => {
  callersProvider?.refresh();
})

// Blast radius placeholder
vscode.commands.registerCommand('grafema.blastRadiusPlaceholder', () => {
  vscode.window.showInformationMessage('Blast Radius analysis is coming in Phase 4.');
})
```

---

## 12. Test Plan

### Unit Tests: `test/unit/callersProvider.test.ts`

Use the same mock client pattern from `traceEngine.test.ts`.

1. `setRootNode(funcNode)` — section children include callers from incoming CALLS edges
2. `setRootNode(funcNode)` — section children include callees from outgoing CALLS edges
3. Cycle A calls B, B calls A — recursive expansion terminates (visitedIds)
4. Filter: test file is excluded when `hideTestFiles = true`
5. Filter: node_modules file is excluded when `hideNodeModules = true`
6. `MAX_BRANCHING_FACTOR` cap — at 6 callers, returns 5 + `more` item
7. `maxDepth=1` — call-node returns empty children (depth limit)
8. Direction toggle: `'incoming'` mode shows only callers, no callees section
9. Direction toggle: `'outgoing'` mode shows only callees, no callers section
10. No root node → returns status item

### Unit Tests: `test/unit/codeLensProvider.test.ts`

1. `provideCodeLenses` with no FUNCTION nodes → returns empty array
2. `provideCodeLenses` on cold cache → returns placeholder lenses
3. After `batchFetchCounts` completes → cache populated, `_onDidChangeCodeLenses` fired
4. `provideCodeLenses` on warm cache → returns resolved lenses with correct counts
5. `resolveCodeLens` with cache hit → returns lens with correct command title
6. Reconnect event clears cache

### Manual Test Checklist

- [ ] Click on a FUNCTION in editor → CALLERS panel shows incoming/outgoing sections
- [ ] Expand incoming section → shows actual callers with file:line
- [ ] Expand a caller node → shows ITS callers (recursive)
- [ ] Set depth to 1 → recursive expansion shows no sub-callers
- [ ] Toggle filter → test files appear/disappear from caller list
- [ ] Toggle direction → only incoming or only outgoing sections visible
- [ ] CodeLens appears above each function: `N callers · M callees · blast: ?`
- [ ] Click "N callers" → CALLERS panel opens focused on that function, incoming direction
- [ ] Click "M callees" → CALLERS panel opens focused on that function, outgoing direction
- [ ] Click "blast: ?" → info message "Coming in Phase 4"
- [ ] `grafema.codeLens.enabled = false` → no CodeLens shown
- [ ] Follow-cursor: moving cursor to function updates CALLERS panel
- [ ] Reconnect: CodeLens cache clears, counts refresh
- [ ] Cycle detection: mutual recursion does not hang expansion

---

## 13. Risks and Open Questions

### Risk 1: CALLS edge direction confirmed but needs dogfooding

The direction `src --CALLS--> dst` (caller to callee) follows standard call graph convention. It is in the graph schema. However, the actual density of CALLS edges in a real analyzed codebase needs verification via dogfooding.

**If the graph has no CALLS edges** (only ASSIGNED_FROM, etc.), the panel will show empty callers/callees. Root cause would be in the analyzer, not the extension. Build the extension correctly and flag any empty results as a graph coverage gap.

**Verification during implementation:** Use `client.countEdgesByType(['CALLS'])` to confirm CALLS edges exist in the test graph before assuming coverage.

### Risk 2: FUNCTION nodes may not have precise line/column metadata

`findNodeAtCursor()` relies on `metadata.line`. If FUNCTION nodes lack this, the follow-cursor trigger (`findAndSetCallersAtCursor`) won't be able to identify the function at cursor.

**Mitigation:** Follow-cursor is best-effort. The explicit `grafema.openCallers` command (manually triggered) is the primary interaction — it focuses the panel regardless. Follow-cursor is a convenience.

### Risk 3: CodeLens may fire rapidly on file open/scroll

VSCode calls `provideCodeLenses` on every visible range change. With `_onDidChangeCodeLenses.fire()` in the batch callback, there is a risk of re-entrant calls if the batch for file A fires while file B is being processed.

**Mitigation:** The cache is keyed by `filePath`. Each file's batch is independent. A `Set<string>` of `inFlightFetches` prevents launching the same file's batch twice:

```typescript
private inFlight: Set<string> = new Set();
// In provideCodeLenses: if inFlight.has(filePath): return placeholders
// In batchFetchCounts: inFlight.add(filePath) at start, inFlight.delete(filePath) at end
```

### Risk 4: `resolveCodeLens` does not receive `document`

Confirmed API limitation — `resolveCodeLens` gets only the `CodeLens` object. We must embed `filePath` in the arguments array: `arguments: [nodeId, filePath]`. This is safe and idiomatic.

### Risk 5: Three CodeLens objects per function may look crowded

On a file with 20 functions, each with 3 lenses, we create 60 `CodeLens` objects. VSCode handles this fine. The visual output is:
```
▌ 3 callers   2 callees   blast: ?
function handleRequest(...) {
```
This is standard CodeLens formatting — each lens is its own clickable pill.

### Risk 6: METHOD nodes in classes

CLASS method nodes (nodeType `METHOD`) should also get CodeLens. They have the same CALLS edge structure. The CodeLens filter should include both `FUNCTION` and `METHOD` node types. CALLERS panel auto-updates when cursor is on a METHOD.

---

## 14. Implementation Order (for Kent/Rob)

1. **Add `CallersItem` to `src/types.ts`** — type definition only
2. **Create `src/callersProvider.ts`** — `CallersProvider` with section structure, lazy loading, cycle detection, filters
3. **Write `test/unit/callersProvider.test.ts`** — mock client, all 10 test cases
4. **Create `src/codeLensProvider.ts`** — batch fetch, cache, three-lens-per-function pattern
5. **Write `test/unit/codeLensProvider.test.ts`** — cache warm/cold, reconnect invalidation
6. **Modify `src/extension.ts`** — register providers, add commands, add `findAndSetCallersAtCursor`
7. **Modify `package.json`** — remove `viewsWelcome`, add commands, menus, settings, activation event
8. **Build and test** — `pnpm build`, install in VSCode, manual checklist above

---

## 15. What to Reuse vs. Build New

| Reuse | Source |
|-------|--------|
| `getNodeIcon()` | `src/utils.ts` |
| `debounce()` | `src/utils.ts` |
| `grafema.gotoLocation` command | `src/extension.ts` |
| `parseNodeMetadata()` | `src/types.ts` |
| `findNodeAtCursor()` | `src/nodeLocator.ts` |
| Mock client pattern | `test/unit/traceEngine.test.ts` |
| `MAX_BRANCHING_FACTOR = 5` | `src/traceEngine.ts` (import and reuse) |
| Follow-cursor architecture | `src/extension.ts` — add third call |
| RFDB client connection lifecycle | `GrafemaClientManager` — unchanged |

| Build New | Why |
|-----------|-----|
| `src/callersProvider.ts` | New panel — different data model (CALLS edges vs data-flow edges) |
| `src/codeLensProvider.ts` | Net-new capability — no existing CodeLens |
| `findAndSetCallersAtCursor()` in `extension.ts` | Parallel to `findAndTraceAtCursor()` — same structure |

---

## 16. Sources Consulted

- Linear issue [REG-514](https://linear.app/reginaflow/issue/REG-514/)
- `_tasks/REG-514/001-user-request.md`
- `_tasks/REG-513/002-don-plan.md` (Phase 1 architecture decisions — patterns directly reused)
- `packages/vscode/package.json` (current view registrations, all commands, settings)
- `packages/vscode/src/extension.ts` (full activation flow, command registration patterns)
- `packages/vscode/src/valueTraceProvider.ts` (TreeDataProvider pattern — directly mirrors CALLERS panel structure)
- `packages/vscode/src/edgesProvider.ts` (cycle detection with `visitedNodeIds` Set — reused for CALLERS)
- `packages/vscode/src/traceEngine.ts` (`MAX_BRANCHING_FACTOR`, BFS pattern)
- `packages/vscode/src/grafemaClient.ts` (GrafemaClientManager API)
- `packages/vscode/src/types.ts` (existing types, parse helpers)
- `packages/vscode/src/utils.ts` (`getNodeIcon`, `debounce`)
- `packages/vscode/src/nodeLocator.ts` (`findNodeAtCursor` — reused for `findAndSetCallersAtCursor`)
- `packages/rfdb/ts/client.ts` (full RFDBClient API — confirmed `getIncomingEdges`, `getOutgoingEdges`, `countEdgesByType`)
- `packages/types/src/edges.ts` (confirmed `CALLS` edge type, direction convention)
- `packages/types/src/nodes.ts` (confirmed `FUNCTION` and `METHOD` node types)
- `packages/vscode/test/unit/traceEngine.test.ts` (mock client pattern, test structure)
- `packages/vscode/esbuild.config.mjs` (single entry point — confirmed no build config changes needed)
- [VSCode CodeLensProvider API](https://code.visualstudio.com/api/references/vscode-api#CodeLensProvider)
- [VSCode CallHierarchyProvider API](https://code.visualstudio.com/api/references/vscode-api#CallHierarchyProvider) — evaluated and rejected
