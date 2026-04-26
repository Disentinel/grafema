# REG-515: Don Melton Implementation Plan

**Date:** 2026-02-19
**Author:** Don Melton (Tech Lead)
**Task:** ISSUES panel with badge

---

## Decisions and Deviations from Task Spec

### 1. "Analysis Warnings" Section — SKIP for Phase 3

**Task spec says:** Files that failed to parse, skipped files, plugin errors. Icon: `$(info)` blue.

**Reality:** These are NOT in the graph. `DiagnosticCollector` emits them to CLI stdout. There is no RFDB query that returns parse failures or plugin errors. Building this section would require either: (a) a new `issue:analysis` category implemented in core, or (b) reading a sidecar file written by the CLI — both are out of scope for Phase 3.

**Decision:** The "Analysis Warnings" section is REMOVED from Phase 3. In its place, the three groups become:

| Group | Maps To | Icon |
|---|---|---|
| Violations | All `issue:*` nodes with `severity === 'error'` | `$(error)` red |
| Warnings | All `issue:*` nodes with `severity === 'warning'` | `$(warning)` yellow |
| Connectivity | All `issue:connectivity` nodes (any severity) | `$(debug-disconnect)` |

**Rationale:** This mapping is clean, future-proof (new categories added by plugins fall into correct severity buckets), and based entirely on data that IS available in the graph today. Connectivity gets its own group as spec'd, since `issue:connectivity` is a specific category with distinct semantics.

**SPEC DEVIATION:** Three groups are preserved but labels and content differ from spec. "Guarantee Violations" → "Violations (Errors)". "Connectivity Gaps" → "Connectivity". "Analysis Warnings" → "Warnings". The spec's "Analysis warnings" intent (warn the user about problems) is served by the Warnings group, which covers `issue:performance`, `issue:style`, `issue:smell` etc.

**FLAG:** The spec's acceptance criterion "Refreshes on reanalysis" is met. The criterion "Badge count on tab" is met. The criterion "Guarantee violations also appear in Problems panel" is met via DiagnosticCollection. The criterion "Click issue → jump to code" is met. The only gap is the "files that failed to parse" scenario, which requires future work in the core package.

---

### 2. Grouping Strategy

Three sections in display order:

1. **"Violations (N)"** — all `issue:*` nodes where `metadata.severity === 'error'`
   - Covers: `issue:security` errors, data flow errors, any future error-severity issues
   - Icon: `$(error)`
   - DiagnosticSeverity: `Error`

2. **"Connectivity (N)"** — all `issue:connectivity` nodes (regardless of severity)
   - Covers: unconnected routes, unresolved imports detected by `UnconnectedRouteValidator`, `BrokenImportValidator`, `CallResolverValidator`
   - Icon: `$(debug-disconnect)`
   - DiagnosticSeverity: determined by `metadata.severity` field

3. **"Warnings (N)"** — all remaining `issue:*` nodes with `severity === 'warning'` or `severity === 'info'` that are NOT `issue:connectivity`
   - Covers: `issue:performance`, `issue:style`, `issue:smell`, future plugin-defined categories
   - Icon: `$(warning)` for warning severity, `$(info)` for info severity (applied per-item, section uses `$(warning)`)
   - DiagnosticSeverity: `Warning` or `Information`

Badge total = sum of all three groups.

Empty panel state (no issues): single `status` item "No issues found."

---

### 3. Query Strategy

**Problem:** `client.queryNodes()` accepts a single exact `nodeType`, not a prefix.

**Solution:** Two-pass strategy.

**Pass 1 — Query known categories** (5 parallel calls using `Promise.all`):
```
categories = ['security', 'performance', 'style', 'smell', 'connectivity']
for each: client.queryNodes({ nodeType: `issue:${cat}` })
```

**Pass 2 — Guard against unknown categories:** After collecting all known-category nodes, use `client.countNodesByType()` which returns `Record<string, number>`. Any key starting with `issue:` that is NOT in the known list AND has count > 0 indicates a plugin-defined category. If any such unknown category is found, perform a `client.getAllNodes({})` call filtered client-side.

This two-pass approach handles the extension point without making a full scan on every refresh when no unknown categories exist. In practice (most cases), only Pass 1 runs.

**Private method in IssuesProvider:** `private async fetchAllIssueNodes(): Promise<WireNode[]>`

Steps inside `fetchAllIssueNodes`:
1. `const counts = await client.countNodesByType()` — get counts for all types
2. Extract keys starting with `issue:` from counts
3. For each such key, if it is in KNOWN_CATEGORIES, collect normally via `queryNodes`; if unknown, fall back to `getAllNodes` filter
4. Return flat array of all issue WireNodes

KNOWN_CATEGORIES constant (module-level, not a class member): `['security', 'performance', 'style', 'smell', 'connectivity']`

---

## IssueItem Type Definition

Add to `/Users/vadimr/grafema-worker-1/packages/vscode/src/types.ts` after the CALLERS PANEL TYPES section:

```typescript
// === ISSUES PANEL TYPES ===

/**
 * Severity groups used in the ISSUES panel.
 * 'violation' = error severity, 'connectivity' = issue:connectivity category,
 * 'warning' = warning/info severity (non-connectivity)
 */
export type IssueSectionKind = 'violation' | 'connectivity' | 'warning';

/**
 * Union type for all items in the ISSUES TreeDataProvider.
 *
 * Kinds:
 *   - 'section'  : group header (Violations, Connectivity, Warnings) with count
 *   - 'issue'    : a single issue node from the graph
 *   - 'status'   : placeholder when not connected / no issues
 */
export type IssueItem =
  | { kind: 'section'; label: string; icon: string; sectionKind: IssueSectionKind; count: number }
  | { kind: 'issue'; node: WireNode; metadata: NodeMetadata; sectionKind: IssueSectionKind }
  | { kind: 'status'; message: string };
```

Notes:
- No `'more'` kind. Issues are a flat list per section, not a deep tree. If a section has many issues, show them all (no truncation needed for Phase 3 — issues should be a small number in practice).
- `metadata` is pre-parsed and stored on the item so `getTreeItem()` does not need to re-parse.
- `sectionKind` on `'issue'` items enables `getChildren()` to return the correct set per section without re-classifying.

---

## issuesProvider.ts — Class Structure

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/issuesProvider.ts`

### Module-level constants

```typescript
const KNOWN_ISSUE_CATEGORIES = ['security', 'performance', 'style', 'smell', 'connectivity'] as const;
```

### IssuesProvider class

```typescript
export class IssuesProvider implements vscode.TreeDataProvider<IssueItem> {
```

#### Private fields

```typescript
private _onDidChangeTreeData = new vscode.EventEmitter<IssueItem | undefined | null | void>();
readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

// Cached results from last fetch. null = not yet fetched. [] = fetched, empty.
private violations: WireNode[] | null = null;
private connectivity: WireNode[] | null = null;
private warnings: WireNode[] | null = null;

// Injected TreeView reference (set by extension.ts after createTreeView)
private treeView: vscode.TreeView<IssueItem> | null = null;

// DiagnosticCollection reference (set by extension.ts after creation)
private diagnosticCollection: vscode.DiagnosticCollection | null = null;

// Workspace root for path resolution
private workspaceRoot: string | undefined;
```

#### Constructor

```typescript
constructor(private clientManager: GrafemaClientManager, workspaceRoot?: string) {
  this.workspaceRoot = workspaceRoot;
  clientManager.on('reconnected', () => {
    this.violations = null;
    this.connectivity = null;
    this.warnings = null;
    this._onDidChangeTreeData.fire();
  });
}
```

#### setTreeView(treeView)

```typescript
setTreeView(treeView: vscode.TreeView<IssueItem>): void
```

Called by `extension.ts` after `createTreeView`. Stored to allow badge updates.

#### setDiagnosticCollection(collection)

```typescript
setDiagnosticCollection(collection: vscode.DiagnosticCollection): void
```

Called by `extension.ts` after `createDiagnosticCollection`. Stored to allow population after refresh.

#### refresh()

```typescript
refresh(): void {
  this.violations = null;
  this.connectivity = null;
  this.warnings = null;
  this._onDidChangeTreeData.fire();
}
```

Clears cache and fires change event. `getChildren()` will re-fetch on next render.

#### getTreeItem(element: IssueItem): vscode.TreeItem

Switch on `element.kind`:

- `'section'`: `TreeItemCollapsibleState.Expanded`, `iconPath = new ThemeIcon(element.icon)`, `description = String(element.count)`
- `'issue'`: `TreeItemCollapsibleState.None`, icon from `getSeverityIcon(element.sectionKind, element.metadata)`, label = `element.node.name` (the message, already truncated by graph), `description = buildIssueDescription(element.node, element.metadata)` (format: `file.js:42`), `tooltip = buildIssueTooltip(element.node, element.metadata)`, `contextValue = 'grafemaIssue'`
  - If `metadata.line !== undefined` and `element.node.file`: set `command` = `grafema.gotoLocation` with args `[element.node.file, metadata.line, metadata.column ?? 0]`
- `'status'`: `TreeItemCollapsibleState.None`, `iconPath = new ThemeIcon('info')`

#### async getChildren(element?: IssueItem): Promise<IssueItem[]>

Root level (no element):
1. If not connected: return `[{ kind: 'status', message: 'Not connected to graph.' }]`
2. If cache is null: call `await this.loadIssues()` — populates `this.violations`, `this.connectivity`, `this.warnings`
3. If all three arrays are empty: return `[{ kind: 'status', message: 'No issues found.' }]`
4. Otherwise: return section headers for non-empty sections only:
   - `{ kind: 'section', label: 'Violations', icon: 'error', sectionKind: 'violation', count: this.violations.length }` (only if violations.length > 0)
   - `{ kind: 'section', label: 'Connectivity', icon: 'debug-disconnect', sectionKind: 'connectivity', count: this.connectivity.length }` (only if > 0)
   - `{ kind: 'section', label: 'Warnings', icon: 'warning', sectionKind: 'warning', count: this.warnings.length }` (only if > 0)

Section level (element.kind === 'section'):
- Map the correct array (violations / connectivity / warnings) based on `element.sectionKind`
- Return each node as `{ kind: 'issue', node, metadata: parseNodeMetadata(node), sectionKind: element.sectionKind }`

Other elements: return `[]`

#### getParent(_element: IssueItem): null

Always return null. (Flat tree structure.)

#### private async loadIssues(): Promise<void>

1. If not connected: set all arrays to `[]`, return
2. Call `this.fetchAllIssueNodes()` — returns `WireNode[]`
3. Classify each node:
   - If `node.nodeType === 'issue:connectivity'` → connectivity bucket
   - Else parse metadata, check `metadata.severity`:
     - `'error'` → violations bucket
     - `'warning'` or `'info'` → warnings bucket
     - unknown → warnings bucket (safe default)
4. Set `this.violations`, `this.connectivity`, `this.warnings`
5. Call `this.updateBadge()`
6. Call `this.updateDiagnostics()`

#### private async fetchAllIssueNodes(): Promise<WireNode[]>

1. Get `client.countNodesByType()` — returns `Record<string, number>`
2. Filter keys by `key.startsWith('issue:')` and `count > 0` → `activeTypes: string[]`
3. Known types in activeTypes: query each via `client.queryNodes({ nodeType })`; collect via async for-of into array
4. Unknown types in activeTypes (types not in KNOWN_ISSUE_CATEGORIES): call `client.getAllNodes({})` once (if any unknown type found), filter client-side by `n.nodeType.startsWith('issue:')` and `n.nodeType` in unknownTypes set
5. Merge and deduplicate by `node.id` (use a Map)
6. Return merged array

**Error handling:** Wrap in try/catch, return `[]` on error. Log error to console.

#### private updateBadge(): void

```typescript
private updateBadge(): void {
  if (!this.treeView) return;
  const total = (this.violations?.length ?? 0)
    + (this.connectivity?.length ?? 0)
    + (this.warnings?.length ?? 0);
  if (total === 0) {
    this.treeView.badge = undefined;
  } else {
    this.treeView.badge = {
      value: total,
      tooltip: `${total} issue${total === 1 ? '' : 's'} in graph`,
    };
  }
}
```

#### private updateDiagnostics(): void

Populates `this.diagnosticCollection` from violations only (per spec: "Guarantee violations also appear in Problems panel").

Steps:
1. If `!this.diagnosticCollection`, return
2. `diagnosticCollection.clear()`
3. Build `Map<string, vscode.Diagnostic[]>` keyed by URI string
4. Iterate `this.violations` (and ALSO include connectivity nodes with severity 'error' from `this.connectivity`):
   - Skip if `!node.file` or `meta.line === undefined`
   - Resolve absolute path: `this.workspaceRoot && !node.file.startsWith('/') ? \`${this.workspaceRoot}/${node.file}\` : node.file`
   - Create `vscode.Uri.file(absPath)`
   - Create `vscode.Range`: line = `Math.max(0, meta.line - 1)`, column = `meta.column ?? 0`, end = same line, column + 100
   - Map severity: `'error'` → `DiagnosticSeverity.Error`, `'warning'` → `DiagnosticSeverity.Warning`, `'info'` → `DiagnosticSeverity.Information`
   - Create `new vscode.Diagnostic(range, node.name, severity)`
   - Set `diag.source = 'Grafema'`
   - Set `diag.code = node.nodeType` (e.g., `'issue:security'`)
   - Accumulate in map
5. For each entry in the map: `diagnosticCollection.set(uri, diagnostics)`

**Scope note:** The spec says "guarantee violations also appear in Problems panel." Connectivity errors are also surfaced since they represent broken structure, not just style.

---

### Module-level helper functions (not exported)

#### getSeverityIcon(sectionKind, metadata): vscode.ThemeIcon

```
sectionKind 'violation' → ThemeIcon('error')
sectionKind 'connectivity' → ThemeIcon('debug-disconnect')
sectionKind 'warning' → metadata.severity === 'info' ? ThemeIcon('info') : ThemeIcon('warning')
```

#### buildIssueDescription(node, metadata): string

Format: `"src/auth.js:42"` (file:line if available, file only otherwise, empty string if neither).

#### buildIssueTooltip(node, metadata): string

Lines:
- `Type: ${node.nodeType}`
- `Message: ${node.name}`
- `File: ${node.file ?? '(unknown)'}`
- `Line: ${metadata.line}` (if defined)
- `Severity: ${metadata.severity ?? 'unknown'}`
- `Plugin: ${metadata.plugin ?? 'unknown'}`

---

## Badge Implementation

**Pattern:** Use `vscode.window.createTreeView` (not `registerTreeDataProvider`).

In `extension.ts`, the registration differs from all other panels:

```typescript
// extension.ts (new code)
issuesProvider = new IssuesProvider(clientManager, workspaceRoot);
const issuesView = vscode.window.createTreeView('grafemaIssues', {
  treeDataProvider: issuesProvider,
});
issuesProvider.setTreeView(issuesView);

const diagnosticCollection = vscode.languages.createDiagnosticCollection('grafema');
issuesProvider.setDiagnosticCollection(diagnosticCollection);
```

The `issuesView` and `diagnosticCollection` are both added to `context.subscriptions`.

**Badge update lifecycle:**
1. Panel opens → `getChildren(undefined)` is called → `loadIssues()` runs → `updateBadge()` sets the count
2. `refresh()` is called (by command or reconnect) → cache cleared → `getChildren()` called again → `loadIssues()` → `updateBadge()`
3. On disconnect/reconnect: `reconnected` event → `refresh()` → badge cleared → then refetched

The badge reflects the last known state. It does NOT auto-refresh on a timer. The user must trigger `grafema.refreshIssues` or the reconnect event refreshes it.

---

## package.json Changes

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/package.json`

### 1. Add to `activationEvents`

```json
"onView:grafemaIssues"
```

Current array ends with `"onView:grafemaCallers"`. Add after it.

### 2. Remove the viewsWelcome entry for grafemaIssues

The current placeholder:
```json
{
  "view": "grafemaIssues",
  "contents": "Issues panel shows guarantee violations and connectivity gaps.\n\nComing in Phase 3."
}
```
Must be removed. The panel will have real content now. The "No issues found." status item handles the empty state.

### 3. Add two new commands to `contributes.commands`

```json
{
  "command": "grafema.refreshIssues",
  "title": "Refresh",
  "icon": "$(refresh)"
},
{
  "command": "grafema.openIssue",
  "title": "Grafema: Open Issue"
}
```

`grafema.openIssue` is the internal command invoked when a tree item is clicked (via `item.command`). However, since click-to-navigate uses the existing `grafema.gotoLocation` command (already registered), `grafema.openIssue` is NOT needed — `gotoLocation` is reused. Only `grafema.refreshIssues` needs to be added.

**Revised:** Only add `grafema.refreshIssues` to commands.

### 4. Add to `contributes.menus` under `view/title`

```json
{
  "command": "grafema.refreshIssues",
  "when": "view == grafemaIssues",
  "group": "navigation@0"
}
```

---

## extension.ts Changes

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/extension.ts`

### Additions needed (exact integration points)

**1. Import (after existing imports, line ~23):**
```typescript
import { IssuesProvider } from './issuesProvider';
```

**2. Module-level variable declarations (after `callersProvider` declaration, ~line 33):**
```typescript
let issuesProvider: IssuesProvider | null = null;
```

**3. In `activate()` — after the CALLERS registration block (~line 99), before CodeLens registration:**
```typescript
// Register ISSUES panel provider
issuesProvider = new IssuesProvider(clientManager, workspaceRoot);
const issuesView = vscode.window.createTreeView('grafemaIssues', {
  treeDataProvider: issuesProvider,
});
issuesProvider.setTreeView(issuesView);

const diagnosticCollection = vscode.languages.createDiagnosticCollection('grafema');
issuesProvider.setDiagnosticCollection(diagnosticCollection);
```

**4. In `context.subscriptions.push()` (~line 156) — add:**
```typescript
issuesView,
diagnosticCollection,
```

**5. In `registerCommands()` — add new command (after `grafema.refreshCallers` block):**
```typescript
disposables.push(vscode.commands.registerCommand('grafema.refreshIssues', () => {
  issuesProvider?.refresh();
}));
```

**No changes to `findAndSetRoot`, `findAndTraceAtCursor`, `findAndSetCallersAtCursor`** — the ISSUES panel is not cursor-driven. It shows ALL issues in the graph.

---

## types.ts Changes

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/types.ts`

Append at the end of the file (after the CALLERS PANEL TYPES section):

```typescript
// === ISSUES PANEL TYPES ===

/**
 * Severity groups for the ISSUES panel sections.
 */
export type IssueSectionKind = 'violation' | 'connectivity' | 'warning';

/**
 * Union type for all items in the ISSUES TreeDataProvider.
 *
 * Kinds:
 *   - 'section' : group header with count
 *   - 'issue'   : a single ISSUE node from the graph
 *   - 'status'  : placeholder when not connected or no issues found
 */
export type IssueItem =
  | { kind: 'section'; label: string; icon: string; sectionKind: IssueSectionKind; count: number }
  | { kind: 'issue'; node: WireNode; metadata: NodeMetadata; sectionKind: IssueSectionKind }
  | { kind: 'status'; message: string };
```

---

## utils.ts Changes

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/utils.ts`

No changes required. Severity icon logic is self-contained in `issuesProvider.ts` as a private module-level function `getSeverityIcon()`. The existing `getNodeIcon()` handles generic node types and is not the right abstraction for issue severity display.

---

## File-by-File Change List (Implementation Order)

### Step 1: types.ts

Add `IssueSectionKind` and `IssueItem` types. No existing code modified.

Verify: TypeScript compiles with new types. Run `pnpm build`.

### Step 2: issuesProvider.ts (new file)

Create `/Users/vadimr/grafema-worker-1/packages/vscode/src/issuesProvider.ts`.

Implement:
1. Module-level constant `KNOWN_ISSUE_CATEGORIES`
2. Module-level helpers: `getSeverityIcon`, `buildIssueDescription`, `buildIssueTooltip`
3. `IssuesProvider` class with all methods described above

Build and verify TypeScript compiles.

### Step 3: test/unit/issuesProvider.test.ts (new file)

Create `/Users/vadimr/grafema-worker-1/packages/vscode/test/unit/issuesProvider.test.ts`.

Write tests BEFORE the provider logic is finalized. Tests drive correct behavior. See Test Plan section below.

### Step 4: package.json

- Add `"onView:grafemaIssues"` to `activationEvents`
- Remove the `grafemaIssues` welcome message from `viewsWelcome`
- Add `grafema.refreshIssues` command to `commands`
- Add `grafema.refreshIssues` to `menus.view/title`

### Step 5: extension.ts

- Add import for `IssuesProvider`
- Add module-level `issuesProvider` variable
- Add provider instantiation, `createTreeView`, `setTreeView`, `createDiagnosticCollection`, `setDiagnosticCollection`
- Add `issuesView` and `diagnosticCollection` to subscriptions
- Register `grafema.refreshIssues` command in `registerCommands()`

---

## Test Plan for issuesProvider.test.ts

Follow the exact pattern from `/Users/vadimr/grafema-worker-1/packages/vscode/test/unit/callersProvider.test.ts`.

The test creates a mock `GrafemaClientManager` and a fake `IRFDBClient` with controllable node data. No RFDB server required.

### Test scenarios

**T1: Empty graph (connected, no issue nodes)**
- `countNodesByType()` returns `{}`
- `getChildren(undefined)` returns `[{ kind: 'status', message: 'No issues found.' }]`
- Badge: `treeView.badge` is `undefined`

**T2: Not connected**
- `isConnected()` returns `false`
- `getChildren(undefined)` returns `[{ kind: 'status', message: 'Not connected to graph.' }]`
- `loadIssues()` never called

**T3: Error severity nodes only**
- `countNodesByType()` returns `{ 'issue:security': 2 }`
- `queryNodes({ nodeType: 'issue:security' })` yields 2 nodes with `metadata: JSON.stringify({ severity: 'error', line: 10 })`
- `getChildren(undefined)` returns exactly one section: `{ kind: 'section', sectionKind: 'violation', count: 2 }`
- Badge value = 2

**T4: Mixed severity nodes**
- `countNodesByType()` returns `{ 'issue:security': 1, 'issue:performance': 1, 'issue:connectivity': 1 }`
- Security node has `severity: 'error'`, performance node has `severity: 'warning'`, connectivity node any severity
- `getChildren(undefined)` returns three sections: violation (1), connectivity (1), warnings (1)
- Badge value = 3
- Sections order: violations, connectivity, warnings

**T5: Only warning/info nodes**
- `countNodesByType()` returns `{ 'issue:style': 3 }`
- All three nodes have `severity: 'warning'`
- Sections: only warnings section (count 3), no violations or connectivity sections

**T6: Section children — violations section**
- Given 2 violation nodes in state
- `getChildren({ kind: 'section', sectionKind: 'violation', ... })` returns 2 `{ kind: 'issue' }` items
- Each item has `node`, `metadata` (parsed), `sectionKind: 'violation'`

**T7: getTreeItem — issue item WITH location**
- `element = { kind: 'issue', node: { file: 'src/a.js', name: 'eval() is banned', ... }, metadata: { line: 5, column: 0 }, sectionKind: 'violation' }`
- `getTreeItem(element)` returns item with:
  - `command.command === 'grafema.gotoLocation'`
  - `command.arguments === ['src/a.js', 5, 0]`
  - `description === 'src/a.js:5'`

**T8: getTreeItem — issue item WITHOUT location**
- `element = { kind: 'issue', node: { file: undefined, name: 'some issue', ... }, metadata: {}, sectionKind: 'warning' }`
- `getTreeItem(element)` returns item with no `command`
- `description` is empty string

**T9: DiagnosticCollection populated after loadIssues**
- 1 violation node with `file: 'src/a.js'`, `metadata.line: 10`, `metadata.severity: 'error'`
- After `loadIssues()` completes, `diagnosticCollection.set()` called once with `vscode.Uri.file(workspaceRoot + '/src/a.js')` and an array of 1 `Diagnostic` with severity `Error`

**T10: DiagnosticCollection skips nodes without file or line**
- 1 violation node with `file: undefined`, `metadata.line: undefined`
- After `loadIssues()`, `diagnosticCollection.set()` never called (only `clear()`)

**T11: DiagnosticCollection cleared on refresh**
- Initially has 2 diagnostics
- `refresh()` called
- `diagnosticCollection.clear()` called during next `loadIssues()`

**T12: Reconnect clears cache and re-fetches**
- Provider is loaded with 2 issues
- `clientManager.emit('reconnected')`
- `violations`, `connectivity`, `warnings` are all `null`
- `_onDidChangeTreeData` event fired
- Next `getChildren(undefined)` call triggers `loadIssues()` again

**T13: Unknown issue category (plugin-defined)**
- `countNodesByType()` returns `{ 'issue:custom-plugin': 2 }`
- `'custom-plugin'` not in KNOWN_ISSUE_CATEGORIES
- Falls back to `getAllNodes({})` and filters client-side
- Both nodes (with `severity: 'warning'`) appear in warnings section

**T14: Badge tooltip text**
- 1 total issue: `tooltip === '1 issue in graph'`
- 3 total issues: `tooltip === '3 issues in graph'`
- 0 issues: `badge === undefined`

**T15: getTreeItem — section item**
- `element = { kind: 'section', label: 'Violations', icon: 'error', sectionKind: 'violation', count: 3 }`
- Returns `TreeItem` with `collapsibleState === Expanded`, `iconPath = ThemeIcon('error')`, `description === '3'`

---

## Open Questions for Rob/Kent

1. **`getAllNodes` signature** — the exploration shows `client.getAllNodes({})` with empty AttrQuery. Verify this compiles without TS error by checking the `IRFDBClient` interface in the test mock. The mock in `callersProvider.test.ts` may not implement `getAllNodes` yet — check and add if missing.

2. **`countNodesByType` return type** — confirmed as `Record<string, number>` per exploration report. Verify with actual TypeScript type in `packages/rfdb/ts/client.ts`.

3. **Badge type compatibility** — `TreeView.badge` accepts `{ value: number; tooltip: string }`. Verify `@types/vscode` at `^1.74.0` has this type. Exploration confirmed it was introduced in VS Code 1.74, and the engines requirement is `^1.74.0`. Should be safe.

4. **Test mock for `createDiagnosticCollection`** — the tests for `issuesProvider.test.ts` need a mock `vscode.DiagnosticCollection`. Check how `callersProvider.test.ts` handles the vscode mock structure and follow the same pattern. If the vscode test harness doesn't provide `createDiagnosticCollection`, create a minimal spy object.

---

## Summary: Scope vs Spec

| Spec Item | Plan Decision | Reason |
|---|---|---|
| Badge on tab | INCLUDED | Via `createTreeView` + `treeView.badge` |
| Three groups | MODIFIED | "Analysis Warnings" → "Warnings" (non-connectivity, non-error issues). Data for parse failures not in graph. |
| Guarantee violations group | INCLUDED as "Violations (Errors)" | All `issue:*` with severity=error |
| Connectivity gaps group | INCLUDED as "Connectivity" | All `issue:connectivity` nodes |
| Analysis warnings group | REPLACED | All `issue:*` with severity=warning/info, excluding connectivity |
| Click → jump to code | INCLUDED | `grafema.gotoLocation` command on tree items |
| Guarantee violations → Problems panel | INCLUDED | DiagnosticCollection with Error severity |
| Connectivity → Problems panel | ADDED (not in spec) | Error-severity connectivity nodes also shown in Problems panel |
| Refresh on reanalysis/reconnect | INCLUDED | `reconnected` event + `grafema.refreshIssues` command |
| Files that failed to parse | DEFERRED | Not in graph. Requires future `issue:analysis` category in core package. |
