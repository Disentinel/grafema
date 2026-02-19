# Don Melton — Tech Lead Plan: REG-517

**Task:** VSCode Phase 5: EXPLORER enhancements (search, filters, bookmarks)

---

## Phase 1: Exploration Findings

### 1.1 Extension Structure

**Package location:** `/packages/vscode/`
**Build:** esbuild bundles `src/extension.ts` → `dist/extension.js`
**Dependencies:** `@grafema/rfdb-client` (workspace), `@grafema/types` (workspace)

The extension is registered in `package.json` with:
- One activity bar container: `grafema`
- Seven views: Status, Value Trace, Callers, Blast Radius, Issues, Explorer (`grafemaExplore`), Debug Log
- Multiple commands registered in `contributes.commands`
- Menu slots: `view/title`, `view/item/context`, `view/item/inline`

### 1.2 Current Graph Explorer (`grafemaExplore`)

**Core file:** `src/edgesProvider.ts` — `EdgesProvider` implements `vscode.TreeDataProvider<GraphTreeItem>`

**How the tree works:**
- `rootNode: WireNode | null` — the single node being explored
- `getChildren(element?)`:
  - Root level (no element): returns `[{ kind: 'node', node: rootNode, isRoot: true }]`
  - Node element: fetches `getOutgoingEdges` + `getIncomingEdges`, deduplicates, returns edge items
  - Edge element: fetches target node, returns it as a node item
- Cycle detection via `visitedNodeIds: Set<string>` threaded through tree items
- Navigation history stack (`rootHistory: WireNode[]`, max 20)
- Navigation path set (breadcrumb highlighting)

**GraphTreeItem union type** (`src/types.ts`):
```typescript
type GraphTreeItem =
  | { kind: 'node'; node: WireNode; metadata: NodeMetadata; isOnPath?: boolean; visitedNodeIds?: Set<string>; isRoot?: boolean }
  | { kind: 'edge'; edge: WireEdge & Record<string, unknown>; direction: 'outgoing' | 'incoming'; targetNode?: WireNode; isOnPath?: boolean; visitedNodeIds?: Set<string> };
```

**Current node label format:** `formatNodeLabel` → `"${nodeType} "${name}""` (e.g., `FUNCTION "handleLogin"`)

**Current edge label format:** `"${edgeType} → ${targetNode.nodeType} "${targetNode.name}""` with direction icon

**Display in `getTreeItem` for node items:**
- `label`: `formatNodeLabel(node)` — type + name
- `description`: set to `'← path'` for path nodes, otherwise empty
- `iconPath`: based on nodeType via `getNodeIcon()`
- Click command: `grafema.gotoLocation` if line metadata present

**Existing commands on Explorer view (view/title):**
- `grafema.searchNodes` — search via QuickPick (already exists!)
- `grafema.goBack`, `grafema.toggleFollowCursor`, `grafema.findAtCursor`
- `grafema.refreshEdges`, `grafema.filterTree`, `grafema.copyTreeState`

**Context item commands (view/item/context and view/item/inline):**
- `grafema.setAsRoot` — for `grafemaNode` and `grafemaEdge` contextValues

### 1.3 Search — Existing Implementation

**Critically: search is already partially implemented.** The `grafema.searchNodes` command in `extension.ts` (lines 232–382) provides:

- A `vscode.QuickPick` with debounced input (300ms)
- Supports `TYPE:name` syntax parsing
- Calls `client.queryNodes(query)` as an async generator (streaming)
- Cancels previous search on new input via `AbortController`
- Limits to 50 results (`SEARCH_MAX_RESULTS`)
- Times out after 5000ms (`SEARCH_TIMEOUT_MS`)
- On accept: calls `edgesProvider.navigateToNode(node)`

**What it does NOT do:**
- It calls `client.queryNodes()` not `client.queryNodesStream()` by name. However, looking at `client.ts`, `queryNodes()` auto-delegates to `queryNodesStream()` when server supports streaming (`if (this._supportsStreaming) { yield* this.queryNodesStream(query); return; }`). So the streaming behavior is already present — `queryNodes` is the correct call.
- The search is invoked through the title bar icon; there is no always-visible search input field.

### 1.4 RFDB Client API

**Key methods available:**
- `queryNodes(query: AttrQuery)` — async generator, auto-uses streaming when server supports it
- `queryNodesStream(query: AttrQuery)` — explicit streaming via `StreamQueue`
- `getOutgoingEdges(id, edgeTypes?)` — filter by edge types
- `getIncomingEdges(id, edgeTypes?)` — filter by edge types
- `countEdgesByType(edgeTypes?)` — returns `Record<string, number>`

**`AttrQuery` interface:** `{ nodeType?, name?, file?, exported? }` — no substring search in the protocol itself; substring filtering must be done client-side.

**Streaming note:** `queryNodesStream` uses a `StreamQueue` pattern; `queryNodes` already delegates to it when streaming is supported. The task description says "use queryNodesStream" but `queryNodes` is the correct public interface that auto-uses streaming.

**`getOutgoingEdges`/`getIncomingEdges` edge type filtering:** Both methods accept `edgeTypes: EdgeType[] | null = null`. Passing a non-null array filters at the server level. This is the primary mechanism for edge type filtering.

### 1.5 Edge Types (from `packages/types/src/edges.ts`)

The full edge type list relevant to the Explorer:
- Call-related: `CALLS`, `HAS_CALLBACK`, `PASSES_ARGUMENT`, `RECEIVES_ARGUMENT`, `RETURNS`, `DELEGATES_TO`
- Import/Export: `IMPORTS`, `EXPORTS`, `IMPORTS_FROM`, `EXPORTS_TO`
- Data flow: `ASSIGNED_FROM`, `READS_FROM`, `WRITES_TO`, `DERIVES_FROM`, `FLOWS_INTO`, `USES`, `MODIFIES`
- Structure: `CONTAINS`, `DEFINES`, `DECLARES`, `HAS_SCOPE`
- Inheritance: `EXTENDS`, `IMPLEMENTS`
- HTTP/Routes: `ROUTES_TO`, `HANDLED_BY`, `MAKES_REQUEST`
- Other: `GOVERNS`, `VIOLATES`, `AFFECTS`

The task specifically names: CALLS, IMPORTS, ASSIGNED_FROM as defaults.

### 1.6 VSCode API Patterns Already in Use

- `vscode.TreeDataProvider<T>` — all panels use this pattern
- `vscode.window.createTreeView()` — Pattern B, used by Issues and Blast Radius (gives access to `.badge` and `.message`)
- `vscode.window.registerTreeDataProvider()` — Pattern A, used by Status, ValueTrace, Callers
- `vscode.window.createQuickPick()` — used in searchNodes command
- `vscode.window.showQuickPick()` — used in `setCallersDepth` and `toggleCallersFilter`
- `vscode.workspace.getConfiguration()` — read settings
- `context.workspaceState` — workspace-scoped persistent storage

**The Callers panel's filter toggle is the exact pattern needed for edge type filter:**
```typescript
// From extension.ts, toggleCallersFilter
const items: vscode.QuickPickItem[] = [
  { label: 'Hide test files', picked: callersProvider.getHideTestFiles() },
  { label: 'Hide node_modules', picked: callersProvider.getHideNodeModules() },
];
const picked = await vscode.window.showQuickPick(items, {
  placeHolder: 'Toggle callers filters',
  canPickMany: true,
});
```

### 1.7 Workspace State for Persistence

VSCode extensions have `context.workspaceState` (workspace-scoped) and `context.globalState` (global). Bookmarks should use `workspaceState` so each project has its own bookmark set. The `ExtensionContext` is available in `activate()` and must be threaded to providers that need it.

### 1.8 Existing Search/Filter/Bookmark Functionality

- **Search:** Already implemented as QuickPick command (`grafema.searchNodes`). Needs enhancement for improved labels showing module path and exported status.
- **Filter:** Partial — `grafema.filterTree` uses VS Code's built-in list find widget (text filter on tree labels). No edge-type filter exists.
- **Bookmarks:** None.
- **Improved labels:** The description field in node tree items is currently only used for `'← path'`. Module path and exported status are not shown.

---

## Phase 2: Implementation Plan

### Feature 1: Search Enhancements (Improved QuickPick Labels)

**Scope:** The search command `grafema.searchNodes` already works. The task asks for "improved labels: show more context in description (module path, exported status)."

In the current search result rendering (extension.ts lines 325–344):
```typescript
items.push({
  label: `$(symbol-${getIconName(node.nodeType)}) ${node.nodeType} "${node.name}"`,
  description: `${node.file}${loc}`,
  detail: displayId,
});
```

The description already shows `file:line`. The enhancement is to add exported status.

**Files to modify:**
- `src/extension.ts` — in `grafema.searchNodes` handler, enhance the `items.push()` to include `node.exported` in description or label

**Change:** Add `[exported]` badge or `$(pass)` icon when `node.exported === true`. Example:
```typescript
description: `${node.file}${loc}${node.exported ? '  $(pass) exported' : ''}`,
```

**VSCode API:** `QuickPickItem.description` already supports text with icon strings when using `createQuickPick()` (which is already used here).

**Risk:** Low. Purely additive label change.

---

### Feature 2: Edge Type Filter for Explorer

**Goal:** A Quick Pick with checkboxes that lets the user show/hide specific edge types. Affects what edges are displayed when expanding a node in the Explorer.

**Design decision:** Filter state belongs in `EdgesProvider`. It holds `rootNode` and controls tree rendering. The filter command opens a QuickPick, user picks types to show, provider stores the set, and re-renders.

**How filtering works at the API level:**
`client.getOutgoingEdges(nodeId, edgeTypes?)` and `client.getIncomingEdges(nodeId, edgeTypes?)` both accept an optional `EdgeType[]` filter. However, to show "all types except selected", we need the inverse: query all, then filter client-side — OR — not pass a filter array and filter the results. Since the allowed set is dynamic and the complement approach is simpler (filter client-side from the full result), we will fetch all edges and filter in `getChildren`.

**Alternative considered:** Query with server-side `edgeTypes` filter. This is more efficient but requires us to know the full universe of edge types. Using `countEdgesByType()` we could build the universe dynamically, but that adds an extra round-trip. For now, client-side filtering of the full edge list is simpler and correct.

**Implementation:**

**Files to modify:**
1. `src/edgesProvider.ts` — add `hiddenEdgeTypes: Set<string>` field, expose getter/setter, apply filter in `getChildren` when building edge items
2. `src/extension.ts` — add `grafema.filterEdgeTypes` command registration + view/title menu entry
3. `package.json` — add `grafema.filterEdgeTypes` command definition + menu entry under `view/title` for `grafemaExplore`

**EdgesProvider changes:**
```typescript
private hiddenEdgeTypes: Set<string> = new Set();

getHiddenEdgeTypes(): Set<string> { return new Set(this.hiddenEdgeTypes); }

setHiddenEdgeTypes(types: Set<string>): void {
  this.hiddenEdgeTypes = types;
  this._onDidChangeTreeData.fire();
}
```

In `getChildren()` for `element.kind === 'node'`, after building the `edges` array, filter out items where `edge.edgeType` is in `hiddenEdgeTypes`.

**Command handler in extension.ts:**
```typescript
disposables.push(vscode.commands.registerCommand('grafema.filterEdgeTypes', async () => {
  if (!edgesProvider) return;

  // Build items from known edge types (most common ones pre-populated)
  const COMMON_EDGE_TYPES = [
    'CALLS', 'IMPORTS', 'IMPORTS_FROM', 'EXPORTS', 'EXPORTS_TO',
    'ASSIGNED_FROM', 'DERIVES_FROM', 'CONTAINS', 'DEFINES',
    'USES', 'PASSES_ARGUMENT', 'RETURNS', 'EXTENDS', 'IMPLEMENTS',
  ];
  const hidden = edgesProvider.getHiddenEdgeTypes();
  const items: vscode.QuickPickItem[] = COMMON_EDGE_TYPES.map((t) => ({
    label: t,
    picked: !hidden.has(t),  // checked = shown
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select edge types to show',
    canPickMany: true,
  });
  if (picked) {
    const shown = new Set(picked.map((p) => p.label));
    const newHidden = new Set(COMMON_EDGE_TYPES.filter((t) => !shown.has(t)));
    edgesProvider.setHiddenEdgeTypes(newHidden);
  }
}));
```

**package.json changes:**
- Add command `grafema.filterEdgeTypes` with title `"Filter Edge Types"` and icon `$(filter)`
- Add to `view/title` menu: `{ "command": "grafema.filterEdgeTypes", "when": "view == grafemaExplore", "group": "navigation@5" }` — shifting existing `filterTree` and `copyTreeState` groups

**Risk:** Low to medium. The existing `grafema.filterTree` command uses VS Code's built-in find widget (text filter on labels). The new `grafema.filterEdgeTypes` is a separate command for structural filtering. The only concern is group numbering in the menu — we need to renumber `navigation@5` and `navigation@6` for the existing `filterTree` and `copyTreeState`.

---

### Feature 3: Bookmarks

**Goal:** Pin frequently visited nodes for quick access. Persisted in workspace state.

**Design:** Bookmarks are a separate section in the Explorer tree (or a separate tree view). The simplest approach that does not require a new view is to show bookmarks at the top of the Explorer tree, above the current root node. However, mixing bookmarks and navigation in one tree complicates the data model.

**Recommendation:** Add bookmarks as a new top-level section within the `grafemaExplore` tree. When `rootNode` is set, display: (1) Bookmarks section (if any), then (2) current root node and its edges. When no rootNode, display only bookmarks.

**Alternatively:** A second tree view `grafemaBookmarks` is cleaner architecturally but requires a new view registration. Given the task says "enhance existing explorer," keeping it in the same view is preferred.

**Chosen design:** Add bookmarks as a first-class section in `EdgesProvider`. The tree shows:
- `{ kind: 'bookmark-section' }` — collapsed by default, shows count
  - `{ kind: 'bookmark', node: WireNode }` — each bookmarked node
- `{ kind: 'node', ..., isRoot: true }` — current root (if set)
  - edges and their target nodes (existing behavior)

**Persistence:** Use `vscode.ExtensionContext.workspaceState`. The `ExtensionContext` is passed to `EdgesProvider` constructor. Bookmarks stored as `WireNode[]` serialized as JSON under key `'grafema.bookmarks'`.

**Files to modify:**
1. `src/types.ts` — extend `GraphTreeItem` union with `bookmark-section` and `bookmark` kinds
2. `src/edgesProvider.ts` — add bookmark management (add, remove, persist, load from workspace state)
3. `src/extension.ts` — add `grafema.bookmarkNode` and `grafema.removeBookmark` commands + menu entries + pass `context` to `EdgesProvider`
4. `package.json` — add bookmark commands + context menu entries for `grafemaNode` contextValue + possibly a new `grafemaBookmark` contextValue

**GraphTreeItem new kinds:**
```typescript
| { kind: 'bookmark-section'; count: number }
| { kind: 'bookmark'; node: WireNode; metadata: NodeMetadata }
```

**EdgesProvider changes:**
- Constructor receives `ExtensionContext` (for workspaceState)
- `private bookmarks: WireNode[] = []` — in-memory list
- `loadBookmarks()` — reads from `context.workspaceState.get<WireNode[]>('grafema.bookmarks', [])`
- `saveBookmarks()` — writes to `context.workspaceState.update('grafema.bookmarks', this.bookmarks)`
- `addBookmark(node: WireNode)` — push if not already present (by id), save, refresh
- `removeBookmark(nodeId: string)` — filter out, save, refresh
- `isBookmarked(nodeId: string): boolean`
- `getBookmarks(): WireNode[]`
- `getChildren()` modified to prepend bookmark-section when `bookmarks.length > 0`
- `getTreeItem()` extended to handle `bookmark-section` and `bookmark` kinds

**Commands to add:**
- `grafema.bookmarkNode` — triggered from context menu on `grafemaNode` items. Adds node to bookmarks.
- `grafema.removeBookmark` — triggered from context menu on `grafemaBookmark` items. Removes from bookmarks.
- `grafema.clearBookmarks` — optional, clears all bookmarks (can be title bar of explorer or palette command)

**Context menu for bookmarking (package.json `view/item/context`):**
```json
{
  "command": "grafema.bookmarkNode",
  "when": "view == grafemaExplore && viewItem == grafemaNode",
  "group": "navigation@2"
},
{
  "command": "grafema.removeBookmark",
  "when": "view == grafemaExplore && viewItem == grafemaBookmark",
  "group": "navigation@1"
}
```

**Inline action for bookmarks:**
```json
{
  "command": "grafema.setAsRoot",
  "when": "view == grafemaExplore && viewItem == grafemaBookmark",
  "group": "inline"
}
```

**Bookmark node display in getTreeItem:**
- `contextValue = 'grafemaBookmark'`
- `label`: `formatNodeLabel(node)` (type + name)
- `description`: `node.file` (module path)
- `iconPath`: star icon (`$(star-full)`) to distinguish from regular nodes
- Click command: `grafema.gotoLocation` if line metadata available
- Allows `setAsRoot` inline to navigate to it

**Risk:** Medium. The main concern is threading `ExtensionContext` to `EdgesProvider`. Currently `EdgesProvider` only receives `GrafemaClientManager`. We need to add `context: vscode.ExtensionContext` to its constructor. This is a clean change — no circular dependencies.

A secondary concern: the `WireNode` objects stored in `workspaceState` may become stale after re-analysis (node IDs change). The stored `WireNode` represents a snapshot in time. When displaying, we display what was stored. When using "set as root", we navigate using the stored node directly. If the node no longer exists, `getChildren()` will show no edges (graceful degradation). We could add a "verify on load" step but that adds complexity.

**Decision:** Accept stale-node risk for v1. Add a note in the bookmark-section tooltip: "Bookmarks may become stale after re-analysis."

---

### Feature 4: Improved Labels (Node Description)

**Goal:** Show more context in the description field of node items in the Explorer tree.

Currently in `EdgesProvider.getTreeItem()` for `kind === 'node'`:
- `label`: `formatNodeLabel(node)` = `${nodeType} "${name}"`
- `description`: `'← path'` if on path, otherwise undefined/empty

The task asks to show "module path, exported status" in description.

**Design:** When a node is NOT on the navigation path, set `description` to:
- `node.file` (the module path, already stored in WireNode)
- Plus `[exported]` if `node.exported === true`

**Example:** `FUNCTION "handleLogin"` with description `src/auth/login.js  exported`

**Files to modify:**
1. `src/edgesProvider.ts` — modify `getTreeItem()` for `kind === 'node'` to set description

**Change:**
```typescript
// In getTreeItem, for element.kind === 'node':
if (isOnPath) {
  item.description = '← path';
} else {
  const parts: string[] = [];
  if (element.node.file) parts.push(element.node.file);
  if (element.node.exported) parts.push('exported');
  item.description = parts.join('  ') || undefined;
}
```

**Risk:** Low. Purely additive. The description field in VS Code tree items accepts a string; when shown, it appears next to the label in a lighter color.

**Concern:** Long file paths can make the tree items visually crowded. We may want to show only the basename of the file path or a shortened version. A simple mitigation: show only the last two path segments (e.g., `auth/login.js` instead of the full path). We can extract a helper `formatFilePath(path: string): string` that does this.

---

## Summary: Files to Create/Modify

| File | Action | What Changes |
|------|--------|-------------|
| `src/types.ts` | Modify | Add `bookmark-section` and `bookmark` kinds to `GraphTreeItem` |
| `src/edgesProvider.ts` | Modify | Add `hiddenEdgeTypes`, bookmark management (load/save/add/remove), improved node description, updated `getTreeItem`/`getChildren` |
| `src/extension.ts` | Modify | Add `grafema.filterEdgeTypes` command, `grafema.bookmarkNode`, `grafema.removeBookmark` commands; pass `context` to `EdgesProvider`; improve search result labels |
| `package.json` | Modify | Add new commands, menu entries for filter and bookmark commands |

**No new files needed.** All 4 features fit within the existing module structure.

---

## Key Architectural Decisions

### 1. Search: No Change to Core Logic
The existing `queryNodes` call already auto-delegates to `queryNodesStream` when the server supports it (see `client.ts` line 699–711). The task's "use queryNodesStream" is already satisfied. Only the label rendering needs updating.

### 2. Edge Filter: Client-Side After Full Fetch
We fetch all edges and filter in `getChildren()` rather than using the server-side `edgeTypes` parameter. This is simpler for the QuickPick "show/hide" UX. The `getOutgoingEdges`/`getIncomingEdges` server-side filter would require knowing the complement set. If performance is a concern on graphs with thousands of edges, this can be revisited.

### 3. Bookmarks: Stored in `workspaceState` as Serialized `WireNode[]`
`WireNode` is a plain object (no class methods), so it serializes cleanly to/from JSON via `workspaceState`. The key is `'grafema.bookmarks'`. Max bookmark count should be capped (suggested: 20) to prevent state bloat.

### 4. Bookmark Section Position in Tree
Bookmark section appears ABOVE the current root node, at the top of the Explorer tree. This follows the principle that bookmarks are "always accessible" regardless of current navigation state.

### 5. No New Tree View
All features are contained in the existing `grafemaExplore` tree. This avoids adding another entry to the activity bar sidebar, which is already crowded with 7 views.

---

## Risks and Concerns

1. **`ExtensionContext` threading:** `EdgesProvider` needs `context` for `workspaceState`. This is a constructor change. All existing tests for `EdgesProvider` will need to pass a mock context. Check test files: `test/unit/callersProvider.test.ts` and others — `EdgesProvider` has its own test file `test/unit/blastRadiusProvider.test.ts`, but there is no `edgesProvider.test.ts`. So no test breakage from constructor change.

2. **Stale bookmarks:** After `grafema analyze` re-runs, node IDs may change. Bookmarked nodes may no longer exist. Graceful handling: when a bookmarked node is used as root and has no edges, the tree simply shows an empty node with no children. Users can remove stale bookmarks manually.

3. **Edge type discovery:** The filter QuickPick shows a hardcoded list of common edge types. Edges in the actual graph may differ by project type. A better UX would query `countEdgesByType()` to show only edge types actually present. This is a future enhancement; hardcoded list works for v1.

4. **Group numbering in `view/title` menu:** The existing navigation groups for grafemaExplore go from `navigation@0` to `navigation@6`. Adding `grafema.filterEdgeTypes` requires either inserting at a new group number or renumbering. VSCode sorts `navigation@N` groups by N. We add `filterEdgeTypes` at `navigation@5` and shift `filterTree` to `navigation@6` and `copyTreeState` to `navigation@7`. This is safe — order is just visual preference.

5. **Search label with icons:** The `description` field in `QuickPickItem` from `createQuickPick()` supports ThemeIcon syntax (`$(icon-name)`). This should work for adding the exported badge.

---

## Implementation Order (for Rob)

The 4 features are independent but share the `edgesProvider.ts` and `extension.ts` files. Suggested order to minimize merge conflicts:

1. **Improved labels** (smallest change, just `edgesProvider.ts` getTreeItem) — establishes pattern
2. **Search label improvement** (just `extension.ts` search handler) — isolated
3. **Edge type filter** (new command + EdgesProvider field) — medium complexity
4. **Bookmarks** (largest, involves types.ts + EdgesProvider + extension.ts + package.json) — most complex, save for last

All four can be committed as a single atomic PR since they are part of the same acceptance criteria set.
