# REG-515: Don Melton Exploration Report

**Date:** 2026-02-19
**Author:** Don Melton (Tech Lead)
**Task:** ISSUES panel with badge — codebase exploration

---

## 1. VSCode Extension Architecture and File Structure

The extension lives at `packages/vscode/`. Its entry point is `src/extension.ts`.

```
packages/vscode/src/
  extension.ts          — activation, command registration, provider wiring
  grafemaClient.ts      — GrafemaClientManager (RFDB connection + lifecycle)
  types.ts              — shared TypeScript types and union types for all providers
  utils.ts              — getNodeIcon(), getIconName(), debounce()
  nodeLocator.ts        — findNodeAtCursor(), findNodesInFile()
  callersProvider.ts    — CALLERS panel (primary template for new panel)
  valueTraceProvider.ts — VALUE TRACE panel
  edgesProvider.ts      — EXPLORER panel (graph tree navigation)
  statusProvider.ts     — STATUS panel (connection state display)
  debugProvider.ts      — DEBUG LOG panel (query log)
  hoverProvider.ts      — Hover tooltips
  codeLensProvider.ts   — CodeLens above functions
  traceEngine.ts        — BFS trace logic (shared between hover + valueTrace)
  cursorTracker.ts      — Cursor-following logic
  treeStateExporter.ts  — Clipboard debug export
test/unit/
  callersProvider.test.ts
  codeLensProvider.test.ts
  hoverMarkdown.test.ts
  traceEngine.test.ts
```

### Extension Build System

The extension bundles with esbuild (`esbuild.config.mjs`). It imports from two workspace packages:
- `@grafema/rfdb-client` (socket client)
- `@grafema/types` (shared type definitions)

TypeScript is transpiled to `dist/extension.js` (single bundle).

---

## 2. Current View Registrations in package.json

The `package.json` already defines `grafemaIssues` as a view but with a placeholder welcome message:

```json
{ "id": "grafemaIssues", "name": "Issues", "visibility": "collapsed" }
```

And a welcome message stub:
```json
{
  "view": "grafemaIssues",
  "contents": "Issues panel shows guarantee violations and connectivity gaps.\n\nComing in Phase 3."
}
```

The `activationEvents` array does NOT yet include `onView:grafemaIssues`. This must be added.

---

## 3. Existing TreeView Patterns — The Template

### Primary template: `callersProvider.ts` (REG-514, most recent and cleanest)

The `CallersProvider` is the best template because:
- Created in the most recent sprint (REG-514)
- Has section headers with counts
- Has refresh logic
- Has reconnect handling
- Uses `CallersItem` union type (discriminated union with `kind` field)

**Pattern summary:**

```typescript
// 1. Discriminated union for all tree items
export type CallersItem =
  | { kind: 'root'; node: WireNode; metadata: NodeMetadata }
  | { kind: 'section'; label: string; icon: string; direction: 'incoming' | 'outgoing'; count: number }
  | { kind: 'call-node'; ... }
  | { kind: 'status'; message: string }
  | { kind: 'more'; count: number };

// 2. Provider class with EventEmitter
export class CallersProvider implements vscode.TreeDataProvider<CallersItem> {
  private _onDidChangeTreeData =
    new vscode.EventEmitter<CallersItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // State
  private rootNode: WireNode | null = null;

  constructor(private clientManager: GrafemaClientManager) {
    clientManager.on('reconnected', () => {
      this.rootNode = null;
      this._onDidChangeTreeData.fire();
    });
  }

  // 3. refresh() = clear state + re-fire
  refresh(): void {
    this.rootNode = null;
    this._onDidChangeTreeData.fire();
    // ...re-fetch if needed
  }

  // 4. getTreeItem() — switch on element.kind
  getTreeItem(element: CallersItem): vscode.TreeItem {
    switch (element.kind) {
      case 'status': {
        const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
      case 'section': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(element.icon);
        return item;
      }
      // ...
    }
  }

  // 5. getChildren() — root level returns sections
  async getChildren(element?: CallersItem): Promise<CallersItem[]> {
    if (!element) {
      if (!this.clientManager.isConnected()) {
        return [{ kind: 'status', message: 'Not connected to graph.' }];
      }
      // Return root-level items
    }
    // Handle children of sections
  }

  getParent(_element: CallersItem): null { return null; }
}
```

### Registration pattern (from `extension.ts`):

```typescript
// 1. Create provider
callersProvider = new CallersProvider(clientManager);

// 2. Register with VS Code
const callersRegistration = vscode.window.registerTreeDataProvider(
  'grafemaCallers',
  callersProvider
);

// 3. Add to subscriptions
context.subscriptions.push(callersRegistration);
```

For the ISSUES panel, `registerTreeDataProvider` is sufficient (no need for `createTreeView` unless a badge is required — see Section 6).

---

## 4. Graph Client Capabilities

### `GrafemaClientManager` (`src/grafemaClient.ts`)

The `GrafemaClientManager` wraps `RFDBClient` and handles:
- Auto-start of `rfdb-server` binary
- Connection state machine (`disconnected` → `connecting` → `connected`)
- Reconnect on socket changes (watches `.grafema/`)
- `getClient()` — throws if not connected (direct access to `RFDBClient`)
- `withReconnect(fn)` — auto-reconnect wrapper
- `isConnected()` — boolean check
- Event: `'stateChange'` — emitted on any connection state change
- Event: `'reconnected'` — emitted after successful reconnect (providers clear caches)

### `RFDBClient` (`packages/rfdb/ts/client.ts`) — available methods

**Querying ISSUE nodes:**

```typescript
// Query all nodes of nodeType starting with 'issue:'
// The queryNodes method accepts AttrQuery with nodeType field
const issueNodes: WireNode[] = [];
for await (const node of client.queryNodes({ nodeType: 'issue:security' })) {
  issueNodes.push(node);
}

// To get ALL issue types (issue:security, issue:performance, etc.),
// we need to query each type separately OR use getAllNodes and filter client-side
const allNodes = await client.getAllNodes({});
const issueNodes = allNodes.filter(n => n.nodeType.startsWith('issue:'));
```

**Key read methods available to the extension:**
- `client.queryNodes(query: AttrQuery)` — async generator (nodeType, name, file, exported)
- `client.getAllNodes(query: AttrQuery)` — collects all matches to array
- `client.getNode(id: string)` — get single node by ID
- `client.findByType(nodeType: NodeType)` — returns string[] of IDs
- `client.getOutgoingEdges(id, edgeTypes?)` — get outgoing edges with metadata
- `client.getIncomingEdges(id, edgeTypes?)` — get incoming edges with metadata
- `client.countNodesByType(types?)` — returns `Record<string, number>` — useful for badge count
- `client.datalogQuery(query: string)` — execute Datalog
- `client.ping()` — returns version string or false

**CRITICAL NOTE:** `queryNodes` accepts a single `nodeType` value, not a prefix. There is no server-side "starts with" query. To fetch all ISSUE nodes across all categories (`issue:security`, `issue:performance`, `issue:style`, `issue:smell`), the implementation must either:
1. Query each known category separately (4 calls)
2. Use `getAllNodes({})` and filter client-side on `nodeType.startsWith('issue:')`
3. Use Datalog: `node(X, T), starts_with(T, "issue:")` — but Datalog support for string ops needs verification

Option 2 is safest but requires full node scan. Option 1 is preferred if the category list is known. Given `IssueNode.getCategories()` returns `['security', 'performance', 'style', 'smell']`, option 1 is the right approach.

---

## 5. ISSUE Node Type Details

### Source: `packages/core/src/core/nodes/IssueNode.ts`

Issue nodes use a namespaced type pattern: `issue:<category>` (e.g., `issue:security`, `issue:performance`, `issue:style`, `issue:smell`).

**IssueNodeRecord interface:**
```typescript
export interface IssueNodeRecord extends BaseNodeRecord {
  type: IssueType;          // "issue:security", "issue:performance", etc.
  severity: IssueSeverity;  // 'error' | 'warning' | 'info'
  category: string;         // 'security', 'performance', 'style', 'smell'
  message: string;          // Human-readable description
  plugin: string;           // Plugin that created this issue
  targetNodeId?: string;    // ID of affected node
  createdAt: number;        // Timestamp
  context?: Record<string, unknown>; // Additional data
}
```

**WireNode representation** (what RFDB stores and returns):
The `IssueNodeRecord` is converted to a `WireNode` when stored:
- `node.nodeType` = `"issue:security"` (or other category)
- `node.name` = message text (truncated to 100 chars): `message.substring(0, 100)`
- `node.file` = file path where the issue was detected
- `node.metadata` = JSON string containing `{ severity, category, message, plugin, targetNodeId, createdAt, context, line, column }`

**ID format:** `issue:<category>#<hash12>` (deterministic, same issue = same ID)

**Categories registered:** `security`, `performance`, `style`, `smell`

**Severity levels:** `'error'` | `'warning'` | `'info'`

### AFFECTS Edge

When a VALIDATION plugin calls `context.reportIssue(issue)`, `PhaseRunner.ts` creates:
1. An issue node via `NodeFactory.createIssue()`
2. If `issue.targetNodeId` is provided: an `AFFECTS` edge from issue node to target node

```
issue:security#abc123 --AFFECTS--> FUNCTION "processInput"
```

Direction for graph query:
- `client.getOutgoingEdges(issueNodeId, ['AFFECTS'])` → the affected code node
- `client.getIncomingEdges(codeNodeId, ['AFFECTS'])` → issues affecting this code node

**Source of truth for AFFECTS edge type:** `packages/types/src/edges.ts`
```typescript
AFFECTS: 'AFFECTS',
```

### Where ISSUE nodes are created — validators in `packages/core/src/plugins/validation/`

- `AwaitInLoopValidator.ts` — creates `issue:performance` nodes
- `SQLInjectionValidator.ts` — creates `issue:security` nodes
- `UnconnectedRouteValidator.ts` — creates `issue:connectivity` (not in the base category list — this is extensible via `issue:<category>`)
- `DataFlowValidator.ts` — issue nodes for data flow problems
- `ShadowingDetector.ts` — issue nodes for variable shadowing
- `BrokenImportValidator.ts` — broken import issues
- `CallResolverValidator.ts` — unresolved call issues
- `EvalBanValidator.ts` — security issues for eval usage
- `PackageCoverageValidator.ts` — package coverage warnings
- `TypeScriptDeadCodeValidator.ts` — dead code detection

The `issue:connectivity` category is used by `UnconnectedRouteValidator` — so the base category list is `['security', 'performance', 'style', 'smell', 'connectivity']` in practice. The panel should query generically (not assume a fixed list).

---

## 6. Badge and Decoration API

**VS Code TreeView badge:** To show a number badge on a panel tab, the extension must use `vscode.window.createTreeView()` (not `registerTreeDataProvider`) and set `treeView.badge`:

```typescript
// Must use createTreeView to get the badge API
const issuesView = vscode.window.createTreeView('grafemaIssues', {
  treeDataProvider: issuesProvider,
});

// Set badge (number shown on the tab)
issuesView.badge = {
  value: 42,        // The count to display
  tooltip: '42 issues in graph',
};

// Clear badge
issuesView.badge = undefined;
```

The CALLERS panel uses `registerTreeDataProvider` (no badge needed). The Issues panel is different — it needs `createTreeView` to support the badge.

**No existing badge usage** in the extension. This will be new.

---

## 7. Connectivity Gap Data Availability

### Current implementation in `src/traceEngine.ts`

Connectivity gaps are detected **client-side** in the VSCode extension during value tracing. The `detectGaps()` function operates on backward trace results:

```typescript
export function detectGaps(backward: TraceNode[]): TraceGap[] {
  // Gap = leaf node with sourceKind='unknown' AND nodeType in {VARIABLE, PARAMETER, EXPRESSION}
  // These are nodes where the analyzer missed an assignment edge
}

export interface TraceGap {
  nodeId: string;
  nodeName: string;
  description: string;
  heuristic: 'no-origins';
}
```

**Key finding:** Connectivity gaps are computed on-demand during value trace, not stored as ISSUE nodes in the graph. They are ephemeral — detected when the user hovers/traces a specific variable.

**For the ISSUES panel:** The task description includes "Connectivity gaps" as a panel section. There are two interpretations:
1. **Graph-stored gaps:** The graph may contain `issue:connectivity` nodes created by `UnconnectedRouteValidator` (routes with no frontend consumers). These ARE in the graph.
2. **Trace gaps:** The `TraceGap` objects from `traceEngine.ts` are not in the graph. They are transient.

For Phase 3, interpretation 1 is most actionable: query `issue:connectivity` nodes from the graph. The trace gaps (`TraceGap` from `valueTraceProvider.ts`) are already shown in the VALUE TRACE panel and are not suitable for the ISSUES panel since they require a specific node to be traced first.

**Recommendation:** The ISSUES panel "Connectivity Gaps" section should query `issue:connectivity` nodes from the graph, not repeat the VALUE TRACE logic.

---

## 8. Analysis Warnings Data

### What exists in the graph

The task description mentions "files that failed to parse", "skipped files", and "plugin errors" as analysis warnings. These are NOT currently stored as ISSUE nodes in the graph. They exist as:

1. **CLI-side diagnostics:** `DiagnosticCollector` in `packages/core/src/diagnostics/` collects parse failures and plugin errors during analysis. These are emitted to the CLI output but not persisted to the graph.

2. **Plugin-level warnings:** `PluginResult.warnings` array — returned by each plugin but not stored as nodes.

3. **RFDB server logs:** Server-side errors are logged but not queryable via the client.

**Key finding:** There is no mechanism to query "analysis warnings" (parse failures, plugin errors) from the graph via RFDB. These would require either:
- A new ISSUE category (e.g., `issue:analysis`) where the INDEXING/ANALYSIS phase stores them
- Or a new data source entirely

**Recommendation for Phase 3:** Limit the ISSUES panel to data that IS available in the graph:
- `issue:security`, `issue:performance`, `issue:style`, `issue:smell`, `issue:connectivity` nodes
- Possibly group them by category rather than inventing new categories

The "Analysis warnings" section from the task spec should be deferred or scoped to graph-stored issues only. This should be flagged during planning.

---

## 9. VS Code DiagnosticCollection

**Current state:** Zero usage in the extension. No `vscode.languages.createDiagnosticCollection()` calls exist.

**What it does:** `DiagnosticCollection` creates squiggly underlines in the editor and entries in the "Problems" panel (View > Problems). It requires file URIs and position ranges.

**How to use:**

```typescript
// Create once in activate()
const diagnosticCollection = vscode.languages.createDiagnosticCollection('grafema');
context.subscriptions.push(diagnosticCollection);

// Populate with issue nodes that have file+line info
const fileMap = new Map<string, vscode.Diagnostic[]>();
for (const issue of issueNodes) {
  const meta = parseNodeMetadata(issue);
  if (!issue.file || meta.line === undefined) continue;

  const absPath = resolveAbsPath(workspaceRoot, issue.file);
  const uri = vscode.Uri.file(absPath);
  const range = new vscode.Range(
    new vscode.Position(Math.max(0, (meta.line ?? 1) - 1), meta.column ?? 0),
    new vscode.Position(Math.max(0, (meta.line ?? 1) - 1), (meta.column ?? 0) + 100)
  );
  const severity = mapSeverity(issue); // vscode.DiagnosticSeverity.Error/Warning/Information

  const diag = new vscode.Diagnostic(range, issue.name, severity);
  diag.source = 'Grafema';
  diag.code = issue.nodeType; // "issue:security" etc.

  if (!fileMap.has(uri.toString())) fileMap.set(uri.toString(), []);
  fileMap.get(uri.toString())!.push(diag);
}

// Apply all at once
diagnosticCollection.clear();
for (const [uriStr, diags] of fileMap) {
  diagnosticCollection.set(vscode.Uri.parse(uriStr), diags);
}
```

**Severity mapping:**
- `issue.severity === 'error'` → `vscode.DiagnosticSeverity.Error`
- `issue.severity === 'warning'` → `vscode.DiagnosticSeverity.Warning`
- `issue.severity === 'info'` → `vscode.DiagnosticSeverity.Information`

---

## 10. Key Files to Modify

1. **`packages/vscode/package.json`**
   - Add `onView:grafemaIssues` to `activationEvents`
   - Remove `viewsWelcome` entry for `grafemaIssues` (or keep for empty state)
   - Add new commands: `grafema.refreshIssues`, `grafema.openIssue`, plus any toolbar items
   - Add menu entries under `view/title` for `grafemaIssues`

2. **`packages/vscode/src/extension.ts`**
   - Import new `IssuesProvider`
   - Declare `issuesProvider` variable
   - Create `issuesProvider = new IssuesProvider(clientManager)`
   - Use `createTreeView('grafemaIssues', { treeDataProvider: issuesProvider })` for badge support
   - Create `diagnosticCollection` and pass to provider or manage in extension
   - Register `grafema.refreshIssues` command
   - Add `issuesView` and `diagnosticCollection` to `context.subscriptions`

3. **`packages/vscode/src/types.ts`**
   - Add `IssueItem` union type (discriminated union with `kind` field)
   - No changes to existing types needed

4. **`packages/vscode/src/utils.ts`**
   - Possibly add `getIssueSeverityIcon()` helper
   - Possibly extend `getNodeIcon()` for `issue:*` types

---

## 11. New File to Create

**`packages/vscode/src/issuesProvider.ts`** — the primary deliverable

Following the `callersProvider.ts` template:
- Implements `vscode.TreeDataProvider<IssueItem>`
- Fetches all issue nodes from graph on demand
- Organizes into 3 sections: "Guarantee Violations", "Connectivity Gaps", "Analysis Warnings"
- Updates `treeView.badge` with total count
- Updates `diagnosticCollection` with file-mapped issues
- Handles reconnect event (clear + refetch)
- Exposes `refresh()` method

**`packages/vscode/test/unit/issuesProvider.test.ts`** — unit tests (TDD)

---

## 12. The IssueItem Union Type Design

Based on the pattern from `CallersItem` and `ValueTraceItem`:

```typescript
// In types.ts

export type IssueItem =
  | { kind: 'status'; message: string }
  | { kind: 'section'; label: string; icon: string; category: 'violation' | 'connectivity' | 'warning'; count: number }
  | { kind: 'issue'; node: WireNode; metadata: NodeMetadata; category: string; severity: string; }
  | { kind: 'more'; count: number };
```

---

## 13. Query Strategy for ISSUE Nodes

The correct query approach, given `client.queryNodes()` takes a single `nodeType`:

```typescript
// Option A: Query each category (preferred — avoids full scan)
const ISSUE_CATEGORIES = ['security', 'performance', 'style', 'smell', 'connectivity'];
const allIssues: WireNode[] = [];
for (const cat of ISSUE_CATEGORIES) {
  for await (const node of client.queryNodes({ nodeType: `issue:${cat}` })) {
    allIssues.push(node);
  }
}

// Option B: Full scan + client-side filter (fallback if new categories exist)
const allNodes = await client.getAllNodes({});
const allIssues = allNodes.filter(n => n.nodeType.startsWith('issue:'));
```

Option A is preferred. But the implementation should fall back gracefully if new categories appear.

**Metadata fields available on WireNode for issue nodes:**
- `node.nodeType` — `"issue:security"`, `"issue:performance"`, etc.
- `node.name` — message text (truncated to 100 chars)
- `node.file` — file path (relative)
- `node.metadata` — JSON string with `{ severity, category, message, plugin, line, column, createdAt, context }`

To get `severity` and `line`: `parseNodeMetadata(node)` → check `metadata.severity`, `metadata.line`, `metadata.column`.

---

## 14. Grouping Strategy for the Panel

The task spec defines 3 groups:
1. **Guarantee Violations** — ISSUE nodes linked to guarantee nodes via graph queries (or any `issue:*` with severity `'error'`)
2. **Connectivity Gaps** — ISSUE nodes with `nodeType === 'issue:connectivity'`
3. **Analysis Warnings** — remaining ISSUE nodes (severity `'warning'` or `'info'`)

A practical grouping that maps to available data:
- Section 1: All `issue:security` nodes (errors/warnings) — "Security Issues"
- Section 2: `issue:connectivity` nodes — "Connectivity Gaps"
- Section 3: `issue:performance`, `issue:style`, `issue:smell` — "Code Quality"

Or simpler, group by severity: errors → warnings → info. This avoids the need to know all possible categories.

The best approach aligns with the task spec categories but maps cleanly to what is queryable:
- "Issues" section: all `issue:*` nodes with severity `error`
- "Warnings" section: all `issue:*` nodes with severity `warning`
- "Info" section: all `issue:*` nodes with severity `info`

This is clean, future-proof, and doesn't hard-code category names.

---

## 15. Testing Approach

Following the pattern from `callersProvider.test.ts`:

The test creates a mock `GrafemaClientManager` that wraps a fake `IRFDBClient`. The fake client has an in-memory map of nodes. No RFDB server needed.

Key test cases:
- Empty graph → shows "No issues found" status item
- Not connected → shows "Not connected to graph" status item
- N issue nodes → sections with correct counts, badge = N
- Click on issue node → `grafema.gotoLocation` command with correct args
- DiagnosticCollection populated correctly after refresh
- Reconnect → provider clears and re-fetches
- Issue nodes without `file` → excluded from DiagnosticCollection, still shown in tree

---

## 16. Critical Gaps / Risks

1. **"Analysis warnings" are not in the graph.** Files that failed to parse, skipped files, and plugin errors are emitted to CLI stdout via `DiagnosticCollector` but not stored as ISSUE nodes. The ISSUES panel cannot show these without a new graph schema. Must be flagged to user.

2. **`queryNodes` does not support prefix matching.** Must query each category separately. Number of round-trips = number of categories. Currently 5 known categories; new categories added by custom plugins would be missed.

3. **Badge API requires `createTreeView`, not `registerTreeDataProvider`.** This is a different registration pattern from all other panels. The `issuesView` reference must be kept (like `treeView` for the Explorer panel) and stored in `context.subscriptions`.

4. **Connectivity gaps from `traceEngine.ts` are NOT in the graph.** They are ephemeral, computed on-demand. The "Connectivity Gaps" section in the ISSUES panel maps to graph-stored `issue:connectivity` nodes, not the live trace gaps in VALUE TRACE.

5. **File path resolution for DiagnosticCollection.** RFDB stores relative paths (e.g., `src/utils.js`). VS Code `DiagnosticCollection` needs absolute URIs. The resolution pattern `wsRoot && !file.startsWith('/') ? \`${wsRoot}/${file}\` : file` is established in `extension.ts` (see `grafema.gotoLocation`).

6. **Badge value type.** VS Code's `TreeViewOptions.badge` was introduced in VS Code 1.74. The extension's minimum engine requirement is `"vscode": "^1.74.0"` — the badge API is available.

---

## 17. Summary: Files Used as Templates

| Template | Use for |
|---|---|
| `callersProvider.ts` | Primary template: TreeDataProvider structure, section headers, refresh, reconnect |
| `extension.ts` | Registration pattern for `createTreeView`, DiagnosticCollection lifecycle |
| `valueTraceProvider.ts` | Multi-section panel with status items and gap display |
| `types.ts` | Union type pattern (`IssueItem` follows `CallersItem` / `ValueTraceItem`) |
| `utils.ts` | Icon helpers — extend `getNodeIcon` for `issue:*` types |

---

## 18. Files Requiring Changes — Summary Table

| File | Change Type | Scope |
|---|---|---|
| `package.json` | Modify | Add activation event, commands, menus |
| `src/extension.ts` | Modify | Import, instantiate, register IssuesProvider + DiagnosticCollection |
| `src/types.ts` | Modify | Add `IssueItem` union type |
| `src/utils.ts` | Modify | Add severity icon helper |
| `src/issuesProvider.ts` | Create | New file — primary implementation |
| `test/unit/issuesProvider.test.ts` | Create | New file — TDD tests |
