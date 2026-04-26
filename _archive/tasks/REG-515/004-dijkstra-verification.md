# REG-515: Dijkstra Plan Verification

**Date:** 2026-02-19
**Author:** Edsger Dijkstra (Plan Verifier)
**Verified:** Don Melton's plan `003-don-plan.md`

---

## Verdict: APPROVE WITH CONDITIONS

The plan is structurally sound and most logic is enumerable. Four gaps require Rob to address before shipping. None is a showstopper; all have clear, small fixes. The plan may proceed to implementation with the conditions below.

---

## Completeness Tables

### Table 1: Node classification in `loadIssues()`

Classification rule: "if nodeType === 'issue:connectivity' → connectivity; else parse metadata.severity → bucket."

| Input | Expected bucket | Handled? |
|-------|----------------|----------|
| `nodeType = 'issue:connectivity'`, any severity | connectivity | YES — first branch, short-circuits severity check |
| `nodeType = 'issue:security'`, `severity = 'error'` | violations | YES |
| `nodeType = 'issue:performance'`, `severity = 'warning'` | warnings | YES |
| `nodeType = 'issue:style'`, `severity = 'info'` | warnings | YES |
| `nodeType = 'issue:smell'`, `severity = 'warning'` | warnings | YES |
| `nodeType = 'issue:custom'` (unknown category), `severity = 'error'` | violations | YES — falls through to severity check after unknown category is fetched via getAllNodes |
| `nodeType = 'issue:connectivity'`, `severity = 'error'` | connectivity | YES — but NOTE: `updateDiagnostics()` plan says "iterate violations AND connectivity nodes with severity 'error'". Connectivity-error nodes land in the connectivity bucket, not violations, so `updateDiagnostics` must explicitly check both. Plan says it does. Correct. |
| metadata string is malformed JSON (not valid JSON) | `parseNodeMetadata` returns `{}`, so `metadata.severity` is `undefined` | PARTIALLY HANDLED — plan says "unknown severity → warnings bucket". `parseNodeMetadata` in `types.ts` catches JSON.parse errors and returns `{}`. So `metadata.severity` will be `undefined`. The plan falls through to the `unknown` case: "unknown → warnings bucket". This is safe but the test plan (T3, T4) does not test malformed metadata. GAP: add a test case for malformed metadata JSON. |
| metadata is an empty string `""` | `JSON.parse("")` throws → returns `{}` | HANDLED by existing `parseNodeMetadata` try/catch |
| metadata is `null` or `undefined` (WireNode.metadata not set) | `JSON.parse(null)` → throws or parses to `null`. `parseNodeMetadata` returns `{}`. | VERIFY: The WireNode type in `@grafema/types` — is `metadata` typed as `string` or `string | undefined`? The existing `parseNodeMetadata` code is `JSON.parse(node.metadata)` with no null-guard before the parse call. If `node.metadata` is `undefined` or `null`, `JSON.parse(undefined)` throws `SyntaxError`, which the catch block handles. Returns `{}`. Safe. |

**Verdict on Table 1:** Classification is complete. The `unknown severity → warnings` default is correct and consistent with the spec's intent ("safe default"). One test gap: no test for malformed metadata.

---

### Table 2: Severity mapping in `updateDiagnostics()`

| `metadata.severity` value | Expected DiagnosticSeverity | Handled? |
|--------------------------|---------------------------|----------|
| `'error'` | `DiagnosticSeverity.Error` | YES |
| `'warning'` | `DiagnosticSeverity.Warning` | YES |
| `'info'` | `DiagnosticSeverity.Information` | YES |
| `undefined` (missing from metadata) | ??? | GAP — plan does not state what happens. If `metadata.severity` is undefined, the severity mapping switch/if will fall through to no match. The plan doesn't specify a default DiagnosticSeverity. This is a **real gap** — the diagnostic will be created with `undefined` severity if the map lacks a default. Rob must add a default: `DiagnosticSeverity.Warning` for unknown/undefined severity. |
| `null` | Same gap as `undefined` |
| any other string (e.g., `'critical'` from a future plugin) | Same gap |

**Verdict on Table 2:** CONDITIONAL APPROVAL. Rob must add a default/fallback DiagnosticSeverity. Suggested: `DiagnosticSeverity.Warning` for anything that is not `'error'` or `'info'`. A node in the violations bucket (classified as 'error' in `loadIssues`) must always produce `DiagnosticSeverity.Error` regardless of what `metadata.severity` says, since it was already classified as a violation. The plan should clarify: for nodes in the violations bucket, always use `DiagnosticSeverity.Error`.

---

### Table 3: `fetchAllIssueNodes()` — query strategy correctness

| Scenario | Expected behavior | Handled? |
|---------|------------------|----------|
| `countNodesByType()` returns `{}` (empty graph) | `activeTypes = []`, no queries issued, returns `[]` | YES — empty loop |
| `countNodesByType()` returns `{ 'issue:security': 3 }` (known category) | Query via `queryNodes({ nodeType: 'issue:security' })`, collect 3 nodes | YES |
| `countNodesByType()` returns `{ 'issue:custom': 2 }` (unknown category) | Fall back to `getAllNodes({})`, filter by `n.nodeType === 'issue:custom'` | YES — plan says "filter by unknownTypes set" |
| `countNodesByType()` returns both known and unknown types | Run known via queryNodes, run getAllNodes for unknown in the same call | YES — plan says "getAllNodes once if any unknown type found". Correct. |
| `countNodesByType()` returns `{ 'function': 1000, 'issue:security': 2 }` | Only issue:* keys processed | YES — plan filters by `key.startsWith('issue:')` |
| `countNodesByType()` returns `{ 'issue:security': 5 }` but `queryNodes` returns only 3 nodes (timing gap — nodes deleted between count and query) | Returns 3 nodes, count in section header will say 3 (from loaded array), badge = 3 | ACCEPTABLE — the badge and sections reflect loaded data, not stale counts. The `count` field on the section item is `this.violations.length` not the countNodesByType value. Correct. |
| `queryNodes` returns nodes whose `nodeType` is NOT in the expected category (graph corruption) | No explicit guard — node gets classified by severity anyway | ACCEPTABLE — the severity fallback handles it. Not a correctness issue. |
| Deduplication by `node.id` — can same node appear twice? | Yes if: both a known category passes AND getAllNodes is called for unknown + the node also matches the known category somehow. Actually: node is either known-type or unknown-type, not both. So dedup is technically unnecessary but harmless. | HARMLESS — dedup by id is defensive. Correct. |
| `countNodesByType()` throws (connection error) | Outer try/catch in `fetchAllIssueNodes` catches, returns `[]` | YES — plan says "wrap in try/catch, return [] on error" |
| `queryNodes` throws mid-stream | The try/catch in `fetchAllIssueNodes` catches the error | NEEDS VERIFICATION — `queryNodes` is an async generator. Iterating it with `for await...of` will throw inside the loop if the stream fails. The try/catch around the whole method will catch it. Acceptable. |
| `getAllNodes({})` — what does an empty AttrQuery return? | All nodes in the graph. This is confirmed by the client code: `getAllNodes(query = {})` calls `queryNodes({})`, which sends `query: {}` to the server (empty filter = all nodes). Large graphs: this could be very slow. | KNOWN RISK — Don flagged this. Plan says "in practice only runs when unknown categories exist". Acceptable for Phase 3. |

**Verdict on Table 3:** Query strategy is correct and complete for the stated scope.

---

### Table 4: DiagnosticCollection path resolution

| Input `node.file` | `workspaceRoot` | Expected behavior | Handled? |
|------------------|----------------|------------------|----------|
| `'src/auth.js'` (relative) | `'/Users/foo/myproject'` | Resolve to `'/Users/foo/myproject/src/auth.js'` | YES |
| `'/absolute/path/auth.js'` | any | Use as-is | YES — plan checks `!node.file.startsWith('/')` |
| `''` (empty string) | any | Skip — `!node.file` is truthy for empty string | YES — plan says "skip if `!node.file`". Empty string is falsy. |
| `undefined` | any | Skip — `!node.file` | YES |
| `'./src/auth.js'` (relative with leading `./`) | `'/Users/foo/myproject'` | Resolves to `'/Users/foo/myproject/./src/auth.js'` which is valid on most systems, but non-canonical. VS Code's `Uri.file()` normalizes paths. | ACCEPTABLE — minor cosmetic issue, not a correctness bug. |
| `'../outside/file.js'` (path escapes workspace) | `'/Users/foo/myproject'` | Resolves to `'/Users/foo/outside/file.js'` — outside workspace. VS Code will try to open it. | EDGE CASE — not a blocking issue for Phase 3. |
| `workspaceRoot` is `undefined` (no workspace open) | `undefined` | `undefined && ...` = `undefined`, so `absPath = node.file`. If file is relative, `vscode.Uri.file('src/auth.js')` creates a URI with a relative path which will fail silently or resolve incorrectly. | GAP — plan does not handle the case where `workspaceRoot` is undefined and `node.file` is relative. The existing pattern in `extension.ts` (grafema.gotoLocation) has the same behavior but it is an interactive command. For diagnostics, a silent bad URI is worse. Rob must: skip diagnostic creation if `workspaceRoot` is undefined AND `node.file` is not absolute. |

**Verdict on Table 4:** One real gap: relative paths when workspaceRoot is undefined.

---

### Table 5: Badge update lifecycle

| State | Badge behavior | Handled? |
|-------|---------------|----------|
| Panel never opened (lazy — `getChildren` not yet called) | Badge not set. `loadIssues()` never called. | YES — badge is `undefined` by default. This is correct: no badge before first load. |
| `setTreeView()` called after `createTreeView()` | `treeView` reference set, badge updates on `updateBadge()` calls | YES |
| `setTreeView()` never called (misconfiguration in extension.ts) | `updateBadge()` returns early (`if (!this.treeView) return`). No crash. | YES |
| 0 issues after load | `badge = undefined` (clears badge) | YES |
| 1 issue | `badge = { value: 1, tooltip: '1 issue in graph' }` | YES |
| `refresh()` called before `setTreeView()` | Cache cleared, `_onDidChangeTreeData.fire()` | SAFE — treeView is null, badge update returns early |
| Reconnect event fires | `violations = connectivity = warnings = null`, event fired | YES |
| Panel is collapsed when badge updates | VS Code updates the badge regardless of panel visibility | YES — badge is on the view container, not dependent on expansion state |
| `loadIssues()` is called multiple times concurrently (two rapid refreshes) | Second call runs while first is in progress. Both set the same fields. No lock. | RACE CONDITION — If `refresh()` is called twice rapidly, two concurrent `loadIssues()` invocations can race. The last one to complete wins. This is the same pattern as other providers in the extension (callersProvider has the same race). Acceptable for Phase 3. |

**Verdict on Table 5:** Badge lifecycle is correct. The concurrent refresh race exists but is pre-existing behavior across all providers.

---

### Table 6: `getChildren()` precondition completeness

| Input element | Expected return | Handled? |
|--------------|----------------|----------|
| `undefined` (root level), not connected | `[{ kind: 'status', message: 'Not connected to graph.' }]` | YES |
| `undefined`, connected, cache is null | calls `loadIssues()`, then classifies | YES |
| `undefined`, connected, cache populated, all empty | `[{ kind: 'status', message: 'No issues found.' }]` | YES |
| `undefined`, connected, cache populated, some non-empty | returns section items for non-empty sections only | YES |
| `{ kind: 'section', sectionKind: 'violation' }` | returns violation WireNodes as `{ kind: 'issue' }` items | YES |
| `{ kind: 'section', sectionKind: 'connectivity' }` | returns connectivity WireNodes | YES |
| `{ kind: 'section', sectionKind: 'warning' }` | returns warnings WireNodes | YES |
| `{ kind: 'issue', ... }` | returns `[]` | YES — "other elements: return []" |
| `{ kind: 'status', ... }` | returns `[]` | YES — "other elements: return []" |
| `{ kind: 'section', sectionKind: 'violation' }` but `this.violations` is `null` | Bug: `null.map(...)` would throw. This can happen if `getChildren(section)` is called before `loadIssues()` completes (tree expand while loading). | GAP — plan says "Map the correct array based on sectionKind". If `violations` is null, mapping it crashes. Rob must guard: `return (this.violations ?? []).map(...)`. Same for connectivity and warnings. |

**Verdict on Table 6:** One real gap — null-dereference when section expanded before loadIssues completes.

---

## Gaps Found

### GAP 1 (BLOCKING): Missing default DiagnosticSeverity in `updateDiagnostics()`

**Where:** `private updateDiagnostics()` — the severity mapping step.

**Problem:** If `metadata.severity` is `undefined` (node has no severity in metadata), the plan does not specify a fallback DiagnosticSeverity. The resulting `vscode.Diagnostic` will be constructed with `undefined` as severity, which is a TypeScript type error and runtime undefined behavior.

**Fix:** Add explicit fallback. Suggestion:
```typescript
function mapSeverity(sev: string | undefined): vscode.DiagnosticSeverity {
  if (sev === 'error') return vscode.DiagnosticSeverity.Error;
  if (sev === 'info') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning; // default for 'warning' and unknown
}
```
Additionally, for nodes in the violations bucket: regardless of metadata.severity, use `DiagnosticSeverity.Error` since they were already classified as errors. The current plan iterates `this.violations` and re-reads `metadata.severity` — this is inconsistent. A node may have been classified to violations because its severity was `'error'`, but if metadata.severity is missing/malformed, the diagnostic would get the wrong severity.

**Severity of gap:** HIGH — produces runtime error or wrong diagnostic severity.

---

### GAP 2 (BLOCKING): Null dereference in `getChildren(section)` before `loadIssues()` completes

**Where:** `getChildren(element)` when `element.kind === 'section'`.

**Problem:** The plan maps `this.violations` / `this.connectivity` / `this.warnings` to issue items. These are initialized to `null`, not `[]`. If VS Code requests section children before `loadIssues()` resolves (possible if tree is expanded very quickly after first render), the `.map()` call will crash with "Cannot read properties of null".

**Fix:** Guard with null coalescing in the section child rendering:
```typescript
case 'section':
  const arr = element.sectionKind === 'violation' ? this.violations
            : element.sectionKind === 'connectivity' ? this.connectivity
            : this.warnings;
  return (arr ?? []).map(node => ({ kind: 'issue', node, metadata: parseNodeMetadata(node), sectionKind: element.sectionKind }));
```

**Severity of gap:** HIGH — crash in production when sections are expanded rapidly.

---

### GAP 3 (MEDIUM): Missing workspaceRoot guard in `updateDiagnostics()`

**Where:** `private updateDiagnostics()` — path resolution.

**Problem:** When `workspaceRoot` is `undefined` and `node.file` is a relative path, the code resolves to the relative path directly and passes it to `vscode.Uri.file()`. This produces an incorrect URI and silently registers diagnostics at wrong locations.

**Fix:** Add guard:
```typescript
const absPath = this.workspaceRoot && !node.file.startsWith('/')
  ? `${this.workspaceRoot}/${node.file}`
  : node.file;
// Guard: skip if we'd produce a relative URI
if (!absPath.startsWith('/')) continue; // or: if (!this.workspaceRoot && !node.file.startsWith('/')) continue;
```

**Severity of gap:** MEDIUM — diagnostics silently placed at wrong locations when no workspace is open. Does not crash.

---

### GAP 4 (LOW): No test case for malformed metadata JSON

**Where:** Test plan — no T case for `metadata = "not json"` or `metadata = null`.

**Problem:** `parseNodeMetadata` handles this correctly (try/catch returns `{}`), but the test plan does not verify this path. A future refactor could break the error handling silently.

**Fix:** Add T16: node with malformed metadata string — verify it appears in warnings section (not crashes), `getTreeItem` returns valid item, no diagnostic created.

**Severity of gap:** LOW — behavior is already correct, just not tested.

---

## Precondition Verification

### Precondition 1: `countNodesByType()` returns `Record<string, number>`

**Status: VERIFIED.** Actual signature in `packages/rfdb/ts/client.ts` line 651:
```typescript
async countNodesByType(types: NodeType[] | null = null): Promise<Record<string, number>>
```
Called with no argument (null default) returns counts for ALL types. Plan calls `client.countNodesByType()` with no arguments — correct.

**Subtlety:** The return type is `Record<string, number>` where keys are `NodeType` string values. Issue type keys like `'issue:security'` will appear exactly as stored. The `key.startsWith('issue:')` filter is correct.

### Precondition 2: `queryNodes()` is an async generator, not a Promise

**Status: VERIFIED.** `queryNodes` in client.ts line 696 is `async *queryNodes(query: AttrQuery)`. Plan uses `for await (const node of client.queryNodes(...))` — correct.

### Precondition 3: `getAllNodes({})` with empty AttrQuery returns all nodes

**Status: VERIFIED.** `getAllNodes` at line 784:
```typescript
async getAllNodes(query: AttrQuery = {}): Promise<WireNode[]>
```
It calls `queryNodes({})` which builds `_buildServerQuery({})` → empty `serverQuery = {}` → sent to server. Empty filter = all nodes. Plan is correct.

**Risk:** On large graphs, this is a full table scan. Plan acknowledges this. Acceptable for Phase 3.

### Precondition 4: Badge API available at VS Code ^1.74.0

**Status: VERIFIED.** `package.json` engines: `"vscode": "^1.74.0"`. Badge was introduced in 1.74. `@types/vscode` dev dep is `^1.74.0`. The `treeView.badge` property will be available in the type definitions.

### Precondition 5: `parseNodeMetadata` handles all error cases

**Status: VERIFIED.** `types.ts` line 51-57:
```typescript
export function parseNodeMetadata(node: WireNode): NodeMetadata {
  try {
    return JSON.parse(node.metadata) as NodeMetadata;
  } catch {
    return {};
  }
}
```
Try/catch covers malformed JSON and undefined metadata. Returns `{}` on any error. Safe.

### Precondition 6: `NodeMetadata` interface allows `severity`, `line`, `column`, `plugin` fields

**Status: VERIFIED.** `NodeMetadata` in `types.ts` line 10-16:
```typescript
export interface NodeMetadata {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  [key: string]: unknown;
}
```
The index signature `[key: string]: unknown` allows `metadata.severity`, `metadata.plugin`, `metadata.message`, etc. However: TypeScript will type these as `unknown`, not `string`. The plan code `metadata.severity === 'error'` requires a cast or type guard. Rob must either:
1. Cast: `(metadata.severity as string) === 'error'`
2. Or use a type guard: `typeof metadata.severity === 'string' && metadata.severity === 'error'`

This is a TypeScript correctness issue, not a runtime issue (values will compare correctly). But it may cause `tsc --strict` to reject the comparison. Rob should verify during implementation.

### Precondition 7: `onView:grafemaIssues` must be added to activationEvents

**Status: VERIFIED.** Current `package.json` activationEvents (line 13-18):
```json
["onView:grafemaStatus", "onView:grafemaExplore", "onView:grafemaValueTrace", "onView:grafemaCallers"]
```
`onView:grafemaIssues` is absent. Plan correctly identifies this and adds it. Don's exploration (section 2) correctly noted this. Without it, the extension does not activate when the Issues panel is opened.

### Precondition 8: `callersRegistration` is currently `registerTreeDataProvider` — Issues must use `createTreeView`

**Status: VERIFIED.** `extension.ts` lines 95-99:
```typescript
callersProvider = new CallersProvider(clientManager);
const callersRegistration = vscode.window.registerTreeDataProvider('grafemaCallers', callersProvider);
```
Issues panel uses `createTreeView` (for badge). This is a different pattern from all other providers. Plan acknowledges and accounts for this correctly.

---

## Query Strategy Correctness Analysis

The two-pass strategy (countNodesByType → known queryNodes + unknown getAllNodes) has one latent issue worth noting:

**Race between countNodesByType and queryNodes:** `countNodesByType` returns type X with count=5. Between that call and the subsequent `queryNodes({nodeType: X})`, if nodes are deleted/added (another analysis run), the counts may differ. This is a benign TOCTOU: the panel shows loaded data, not stale count data. The section header count comes from `this.violations.length` (actual loaded array size), not from `countNodesByType`. **This is correct and consistent.**

**Why is countNodesByType used at all?** Solely to discover what `issue:*` categories exist. It is used for discovery, not for display counts. This is the correct use.

**Deduplication:** The plan deduplicates by `node.id`. Analysis: a node can appear in both known-category `queryNodes` results and `getAllNodes` results only if the same node is somehow yielded twice. In the current strategy, if a type is "known", it is queried via `queryNodes` only. If "unknown", it is retrieved via `getAllNodes` filter. These sets are disjoint by `nodeType`, so deduplication is technically unnecessary. It is defensive and harmless.

---

## Open Question Resolution (Don's Questions 1-4)

**Q1: `getAllNodes` signature** — CONFIRMED. `getAllNodes(query: AttrQuery = {})` with default `{}` is valid. Test mock must implement `getAllNodes`. Current `callersProvider.test.ts` mock likely does not have it. Rob must add it.

**Q2: `countNodesByType` return type** — CONFIRMED. `Promise<Record<string, number>>`. Matches plan.

**Q3: Badge type compatibility** — CONFIRMED. `@types/vscode ^1.74.0` includes `TreeView.badge`. Safe.

**Q4: Test mock for DiagnosticCollection** — The existing test harness (see `callersProvider.test.ts`) uses a lightweight mock. `vscode.DiagnosticCollection` is not a simple object — it has `set(uri, diagnostics)`, `clear()`, `delete(uri)`, `get(uri)`, `has(uri)`, `forEach()`, `dispose()`. The test mock needs at minimum `set()`, `clear()`, and inspection of what was set. Rob should create a spy object tracking calls.

---

## Summary

| Gap | Severity | Fix Required Before Ship? |
|-----|---------|--------------------------|
| GAP 1: No default DiagnosticSeverity fallback | HIGH | YES |
| GAP 2: Null dereference in getChildren(section) before load | HIGH | YES |
| GAP 3: No workspaceRoot guard for relative paths in diagnostics | MEDIUM | YES (simple 2-line fix) |
| GAP 4: No test for malformed metadata | LOW | Recommended (add T16) |

All four gaps are small and localizable to `issuesProvider.ts`. No architectural changes needed. Plan is otherwise complete, well-researched, and follows established codebase patterns.

**Approve with the condition that Rob addresses GAP 1, GAP 2, and GAP 3 before marking the task complete.**
