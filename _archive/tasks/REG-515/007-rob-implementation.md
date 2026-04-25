# REG-515: Rob Pike Implementation Report

**Date:** 2026-02-19
**Author:** Rob Pike (Implementation Engineer)
**Task:** ISSUES panel with badge

---

## Files Modified

### 1. `packages/vscode/src/types.ts`
- Added `IssueSectionKind` type alias
- Added `IssueItem` union type (section | issue | status)
- Appended after existing CALLERS PANEL TYPES section

### 2. `packages/vscode/src/issuesProvider.ts` (NEW)
- Created `IssuesProvider` class implementing `TreeDataProvider<IssueItem>`
- Module-level constant `KNOWN_ISSUE_CATEGORIES`
- Module-level helpers: `getSeverityIcon()`, `buildIssueDescription()`, `buildIssueTooltip()`, `mapDiagnosticSeverity()`
- Full class with: constructor, setTreeView, setDiagnosticCollection, refresh, getTreeItem, getChildren, getParent, loadIssues, fetchAllIssueNodes, updateBadge, updateDiagnostics

### 3. `packages/vscode/package.json`
- Added `"onView:grafemaIssues"` to `activationEvents`
- Removed the `grafemaIssues` welcome message from `viewsWelcome` (panel now has real content)
- Added `grafema.refreshIssues` command with refresh icon
- Added `grafema.refreshIssues` to `view/title` menus for `grafemaIssues`

### 4. `packages/vscode/src/extension.ts`
- Added import for `IssuesProvider`
- Added module-level `issuesProvider` variable
- In `activate()`: creates provider, `createTreeView`, `setTreeView`, `createDiagnosticCollection`, `setDiagnosticCollection`
- Added `issuesView` and `diagnosticCollection` to `context.subscriptions`
- Registered `grafema.refreshIssues` command in `registerCommands()`

---

## Dijkstra's Gaps Addressed

### GAP 1 (BLOCKING): Missing default DiagnosticSeverity
- Added `mapDiagnosticSeverity()` helper with `Warning` as default fallback
- In `updateDiagnostics()`, violations bucket nodes always get `DiagnosticSeverity.Error` via `forceError` flag, regardless of metadata.severity

### GAP 2 (BLOCKING): Null dereference in getChildren(section)
- Used `(arr ?? []).map(...)` pattern in the section-children branch of `getChildren()`

### GAP 3 (MEDIUM): Missing workspaceRoot guard in updateDiagnostics
- Added `if (!absPath.startsWith('/')) continue;` guard after path resolution

### GAP 4 (LOW): Test coverage for malformed metadata
- No code change needed (test-side concern for Kent)

---

## Decisions Made During Implementation

1. **TypeScript `unknown` handling for metadata fields**: `NodeMetadata` uses `[key: string]: unknown` index signature. Accessing `metadata.severity` or `metadata.plugin` returns `unknown`. Used `typeof metadata.severity === 'string'` type guards consistently throughout the provider, avoiding unsafe casts.

2. **URI handling in updateDiagnostics**: Used `vscode.Uri.file()` to create URIs, then `uri.toString()` as Map key, and `vscode.Uri.parse()` to reconstruct for `diagnosticCollection.set()`. This avoids URI normalization issues and follows VS Code's recommended pattern.

3. **Connectivity error nodes in diagnostics**: Per Don's plan, error-severity connectivity nodes are also sent to the DiagnosticCollection (Problems panel), not just violations. The `forceError` flag is only set for the violations bucket; connectivity error nodes get their severity from `mapDiagnosticSeverity()`.

---

## Deviations from Plan

None. The implementation follows Don's plan exactly, with Dijkstra's gap fixes integrated.

---

## Verification

- `tsc --noEmit` passes with zero errors
- `esbuild` bundle succeeds ("Build complete")
- All existing code patterns followed (indentation, naming, comment style)
- No TODOs, FIXMEs, or commented-out code
