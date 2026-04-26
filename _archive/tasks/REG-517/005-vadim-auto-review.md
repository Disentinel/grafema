## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK (with two minor notes)
**Test coverage:** OK
**Commit quality:** N/A (uncommitted working tree — review is pre-commit)

---

### Feature-by-Feature Analysis

#### 1. Search nodes by name — OK

Search via `grafema.searchNodes` was already working before REG-517. The improvement requested — showing exported status in labels — is present in `extension.ts` lines 709-711:

```typescript
const exportedTag = node.exported ? ' [exported]' : '';
// ...
description: `${node.file}${loc}${exportedTag}`,
```

The `[exported]` tag is appended to the QuickPick item description. This satisfies the acceptance criterion.

Note: the task says "use queryNodesStream" but the plan correctly explains that `client.queryNodes()` already auto-delegates to `queryNodesStream()` when streaming is supported. The implementation uses `queryNodes` (line 669 of `extension.ts`), which is correct.

#### 2. Edge type filter — OK

QuickPick with checkboxes (`canPickMany: true`) is implemented in `extension.ts` lines 451-478 as `grafema.filterEdgeTypes`. All 14 common edge types from the plan are listed:

```
CALLS, IMPORTS, IMPORTS_FROM, EXPORTS, EXPORTS_TO, ASSIGNED_FROM,
DERIVES_FROM, CONTAINS, DEFINES, USES, PASSES_ARGUMENT, RETURNS,
EXTENDS, IMPLEMENTS
```

Filtering is applied in `edgesProvider.ts` in `buildEdgeItems()` at line 435:
```typescript
if (this.hiddenEdgeTypes.has(edge.edgeType)) continue;
```

The `getHiddenEdgeTypes()` returns a copy (defensive clone, line 529), and `setHiddenEdgeTypes()` fires the change event (line 537). The command is registered in `package.json` menus for `grafemaExplore` at `navigation@6`.

Minor note: when the user unchecks all items in the QuickPick, the code shows an info message and returns early without updating `hiddenEdgeTypes` (lines 467-470). This means "hide all" is not actually achievable. This is a UX edge case but not a blocking defect.

#### 3. Bookmarks — OK

All required operations are implemented in `edgesProvider.ts`:
- `addBookmark(node)` — deduplication by id, cap at 20, saves to workspaceState, fires change event
- `removeBookmark(nodeId)` — filters list, saves, fires change event
- `clearBookmarks()` — clears array, saves, fires change event
- `isBookmarked(nodeId)` — membership check

**Persistence:** Uses `context.workspaceState.update('grafema.bookmarks', ...)` (line 558). Loaded in constructor when context is provided (lines 56-59). `Array.isArray` guard is present in `loadBookmarks()` (line 548).

**Commands registered:**
- `grafema.bookmarkNode` — context menu on `grafemaNode` items
- `grafema.removeBookmark` — context menu on `grafemaBookmark` items
- `grafema.clearBookmarks` — registered as a command (palette only)

Minor note: `grafema.clearBookmarks` is defined in `package.json` commands list but has no menu entry (no `view/title` toolbar button and no `view/item/context` entry). It is only accessible via the command palette. The plan suggested it as "optional" so this is acceptable.

The `setAsRoot` command handles `bookmark` items (extension.ts line 249: `else if (item.kind === 'bookmark')`), allowing users to navigate to a bookmarked node.

#### 4. Improved labels — OK

In `edgesProvider.ts` lines 225-227:
```typescript
const filePart = formatFilePath(element.node.file);
const exportedPart = element.node.exported ? ' exported' : '';
item.description = `${filePart}${exportedPart}`;
```

The `formatFilePath()` helper (lines 26-29) returns the last 2 path segments for compact display, exported from `edgesProvider.ts` so it is also testable. Path-on-navigation overrides this with `'← path'` (line 222), which is correct.

Bookmark items also show `formatFilePath(element.node.file)` as their description (line 191).

---

### Test Coverage Analysis

Tests in `test/unit/edgesProvider.test.ts` cover all 4 features:

**Edge type filtering (Section 1):** 4 tests
- `setHiddenEdgeTypes` fires change event
- `getHiddenEdgeTypes` returns a defensive copy
- Hidden edges are excluded from `getChildren`
- Non-hidden edges pass through
- Default (empty set) shows all edges

**Bookmarks (Section 2):** 11 tests
- Load from workspaceState on construction
- Corrupt data (non-array) guard
- Missing key returns empty
- Add, no-duplicate, cap at 20, fires change event
- Remove by id, fires change event
- isBookmarked true/false
- Save writes to workspaceState

**formatFilePath (Section 3):** 4 tests — multi-segment, single, empty, two-segment

**Node description in getTreeItem (Section 4):** 4 tests
- Shows file + exported
- Shows file only when not exported
- Shows `← path` when on navigation path
- Handles empty file path without crash

**Tree structure with bookmarks (Section 5):** 4 tests
- Root returns bookmark-section + node when both exist
- Root returns only node when no bookmarks
- Root returns only bookmark-section when rootNode null
- bookmark-section expands to bookmark items

Tests are meaningful — they cover happy paths AND failure/edge cases (corrupt data, empty files, duplicates, cap overflow). The mock infrastructure is self-contained and does not require an RFDB server.

---

### Scope Creep Check

No scope creep detected. The changes are confined to:
- `packages/vscode/src/types.ts` — 2 new union members for `GraphTreeItem`
- `packages/vscode/src/edgesProvider.ts` — edge filter, bookmarks, improved labels
- `packages/vscode/src/extension.ts` — 3 new commands + improved search labels
- `packages/vscode/package.json` — new commands + menu entries
- `packages/vscode/test/unit/edgesProvider.test.ts` — new test file

No other packages were modified.

---

### Forbidden Patterns Check

No `TODO`, `FIXME`, `HACK`, `XXX`, `mock`, `stub`, or `fake` found in production code (`src/`). The word "mock" appears only in the test file (`edgesProvider.test.ts`), which is the correct location.

---

### Summary

All 4 acceptance criteria are met:
- [x] Can search nodes by name (existing, label enhanced with exported status)
- [x] Can filter displayed edges by type (QuickPick with 14 types, client-side filtering)
- [x] Can bookmark/pin nodes (add via context menu, remove via context menu, clear via palette)
- [x] Bookmarks persist across sessions (workspaceState with Array.isArray guard)

Two minor non-blocking notes:
1. "Hide all edges" path in the filter QuickPick returns early without updating state — cosmetic UX gap.
2. `grafema.clearBookmarks` is palette-only, no toolbar button — plan noted it as optional.

Neither warrants a REJECT.
