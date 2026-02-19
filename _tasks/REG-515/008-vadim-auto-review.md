## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK
**Commit quality:** OK

---

### Acceptance Criteria Check

**1. ISSUES panel shows grouped issues — OK**

`issuesProvider.ts` implements three groups: Violations, Connectivity, Warnings.
Classification logic in `loadIssues()` is correct:
- `issue:connectivity` nodeType → connectivity bucket (regardless of severity)
- `severity === 'error'` → violations bucket
- everything else (warning, info, unknown) → warnings bucket

Empty sections are suppressed (only non-empty sections appear). Empty state shows a single "No issues found." status item. Disconnected state shows "Not connected to graph." Both are correct.

**2. Badge count on tab — OK**

`updateBadge()` sets `this.treeView.badge` with `{ value: total, tooltip: '...' }`.
Registration uses `createTreeView` (not `registerTreeDataProvider`), which is required for badge support. `setTreeView()` is called in `extension.ts` after creation. Badge clears to `undefined` when count reaches 0.

**3. Click issue → jump to code — OK**

`getTreeItem()` for `kind === 'issue'` sets `item.command` to `grafema.gotoLocation` with `[node.file, metadata.line, metadata.column ?? 0]` when both `node.file` and `metadata.line` are defined. Items without location have no command (no crash, no incorrect navigation).

**4. Guarantee violations also appear in Problems panel — OK**

`updateDiagnostics()` populates `diagnosticCollection` with violations (all) and error-severity connectivity nodes. `diag.source = 'Grafema'` and `diag.code = node.nodeType` are set. `createDiagnosticCollection('grafema')` is called in `extension.ts` and passed to the provider via `setDiagnosticCollection()`. Both `issuesView` and `diagnosticCollection` are added to `context.subscriptions`.

**5. Refreshes on reanalysis — OK**

Two refresh paths:
- `clientManager.on('reconnected', ...)` in constructor clears cache and fires `_onDidChangeTreeData`.
- `grafema.refreshIssues` command calls `provider.refresh()` (same effect).

Both are wired correctly in `extension.ts`.

---

### Dijkstra Gaps Check

**GAP 1: Default DiagnosticSeverity fallback — ADDRESSED**

`mapDiagnosticSeverity()` function implemented (lines 68-72 of `issuesProvider.ts`):
```typescript
function mapDiagnosticSeverity(severity: string | undefined): vscode.DiagnosticSeverity {
  if (severity === 'error') return vscode.DiagnosticSeverity.Error;
  if (severity === 'info') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}
```
Violations bucket uses `forceError: true` which bypasses `mapDiagnosticSeverity` and always uses `DiagnosticSeverity.Error` directly. This matches Dijkstra's recommendation exactly: nodes in the violations bucket are always Error regardless of metadata.severity.

**GAP 2: Null guard in getChildren(section) — ADDRESSED**

Lines 203-211 of `issuesProvider.ts`:
```typescript
const arr = element.sectionKind === 'violation' ? this.violations
  : element.sectionKind === 'connectivity' ? this.connectivity
    : this.warnings;
return (arr ?? []).map(...)
```
`?? []` guard present for all three cases.

**GAP 3: workspaceRoot guard for relative paths — ADDRESSED**

Lines 368-369 of `issuesProvider.ts`:
```typescript
// GAP 3 fix: skip if path is non-absolute
if (!absPath.startsWith('/')) continue;
```
Relative paths when `workspaceRoot` is undefined are skipped rather than producing bad URIs.

**GAP 4: Test for malformed metadata — ADDRESSED**

T16 test added in `issuesProvider.test.ts` (lines 860-899). Verifies that a node with invalid JSON metadata (`'this is not valid JSON {{{'`) lands in the warnings section without crashing, and `getTreeItem` returns a valid item.

---

### Test Coverage Assessment

16 tests covering:
- T1, T2: Empty graph and disconnected states
- T3, T4, T5: All three severity grouping scenarios
- T6: Section children expansion
- T7, T8: `getTreeItem` with and without location
- T9, T10, T11: DiagnosticCollection population, skip, and clear-on-refresh
- T12: Reconnect cache clear and event fire
- T13: Unknown plugin-defined category via getAllNodes fallback
- T14: Badge tooltip singular/plural/zero
- T15: Section tree item shape
- T16: Malformed metadata (added per Dijkstra GAP 4)

Test infrastructure follows the `callersProvider.test.ts` pattern exactly: module-level vscode mock, `MockClientManager` with emit support, `MockDiagnosticCollection` spy tracking `setCalls` and `clearCalls`. All test scenarios from the plan are present.

One minor observation: T12 tests that the change event fires and that re-fetch works after reconnect, but does not explicitly assert that `violations`, `connectivity`, `warnings` are `null` immediately after the reconnect event (before the next getChildren call). This is a gap in assertion coverage but not a correctness gap — the test does verify the externally observable behavior (event fires + re-fetch succeeds).

---

### Edge Cases and Regressions

No regressions identified:
- `extension.ts` imports `IssuesProvider` and registers it cleanly after the CALLERS block, before CodeLens.
- `issuesView` and `diagnosticCollection` are added to `context.subscriptions` (lines 173-174).
- The `grafema.refreshIssues` command is registered in `registerCommands()` (lines 552-555).
- No existing commands, providers, or subscriptions are modified.
- The existing `reconnected` event handler in `extension.ts` (line 149) only clears edgesProvider history — the IssuesProvider's own reconnect handler is registered in the constructor and is independent. No interference.

---

### Scope Check

The implementation is focused and minimal. The only noted scope expansion beyond the spec is: error-severity connectivity nodes are also surfaced in the Problems panel. Don's plan explicitly calls this out and justifies it ("they represent broken structure"). This is a deliberate, documented addition with clear rationale — not scope creep.

`package.json` changes are correct and complete:
- `"onView:grafemaIssues"` added to `activationEvents`.
- The old `grafemaIssues` viewsWelcome placeholder is removed.
- `grafema.refreshIssues` command added to `commands` and `menus.view/title`.

---

### Commit Quality

No TODOs, FIXMEs, HACKs, or commented-out code. All three Dijkstra gap fixes are labeled inline with comments (`// GAP 2 fix`, `// GAP 3 fix`, `// GAP 1 fix`). The implementation file has a JSDoc header explaining the module purpose and grouping logic.
