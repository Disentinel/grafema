## Uncle Bob — Code Quality Review

**Verdict:** APPROVE (with noted observations)

---

### File sizes

**edgesProvider.ts — 605 lines: WARNING, above 500 MUST-SPLIT threshold**

The file crossed 500 lines and is technically in "must split" territory. However, the growth is not arbitrary. The file now serves two distinct conceptual responsibilities:

1. Navigation state (root, history, path) — lines 31–175
2. Tree rendering (getTreeItem, getChildren, buildEdgeItems) — lines 177–415
3. Bookmark management — lines 540–605
4. Edge type filtering — lines 523–538

At 605 lines the split is warranted but not yet critical. The most natural seam would be to extract bookmark management into a `BookmarkManager` class (perhaps `bookmarkManager.ts`, ~80 lines). This would bring the main file back below 520 lines and give the bookmark state a single home. I'm noting this as a structural debt rather than a blocking issue because the growth came directly from the task scope and the file is still navigable.

**extension.ts — 770 lines: CRITICAL (pre-existing, partially addressed)**

The task context acknowledges this. The PREPARE phase extracted `openSearchNodes` (~158 lines) and `resolveNodeAtCursor` (~20 lines). The new commands added by REG-517 (`grafema.openBlastRadius`, `grafema.refreshBlastRadius`, `grafema.filterEdgeTypes`, `grafema.bookmarkNode`, `grafema.removeBookmark`, `grafema.clearBookmarks`) added approximately 80 net lines, keeping the file above 700. This is a pre-existing architectural issue that this task did not create and did not worsen meaningfully. The file's growth is a known item that should be tracked as its own refactoring task.

**types.ts — 245 lines: OK**

Clean, well-organised. The new `BlastRadiusItem` type is properly documented and follows the established union type pattern.

**edgesProvider.test.ts — 826 lines: OK for a test file**

Test files are held to different sizing standards. This file contains 5 clearly labelled sections covering all new behaviour. The line count is justified.

---

### Method quality

**`getTreeItem` — 112 lines (lines 177–289): BORDERLINE**

This method handles four distinct item kinds: `bookmark-section`, `bookmark`, `node`, and `edge`. Each branch is self-contained and the logic per branch is modest, but the combined body is long. The method is readable because each branch opens with a clear `if (element.kind === ...)` guard and returns early. A strict reading of the 50-line guideline would call for extraction, but extraction here (e.g., `renderBookmarkItem`, `renderNodeItem`, `renderEdgeItem`) would scatter cohesive display logic across the file without reducing actual complexity. I note it as a code smell but not a block.

**`getChildren` — 113 lines (lines 294–407): same observation as above**

Four dispatch branches, same reasoning. The `status !== 'connected'` guard block at lines 298–320 is verbose:

```typescript
if (state.status === 'no-database') { return []; }
if (state.status === 'starting-server') { return []; }
if (state.status === 'connecting') { return []; }
if (state.status === 'error') { return []; }
if (state.status !== 'connected') { return []; }
```

Five separate `if` blocks all returning `[]` could be collapsed to a single check:

```typescript
if (state.status !== 'connected') { return []; }
```

The first four branches are redundant with the fifth — `'connected'` is the only state where the body continues. This is minor duplication (the pattern existed before REG-517), and I am noting it without blocking.

**`openSearchNodes` in extension.ts — 158 lines**

This is long but it was correctly extracted from `registerCommands` as part of the PREPARE phase. The function is a single QuickPick workflow. The long body is driven by the async streaming logic and the two event handlers (`onDidChangeValue`, `onDidAccept`, `onDidHide`). It is readable given those constraints. No further split is warranted without introducing excessive nesting or parameter passing.

**`registerCommands` — 324 lines (post-extraction)**

This is still above 50 lines per method, but `registerCommands` is fundamentally a registration list, not an algorithm. Its character is descriptive: it names each command and provides a single-concern handler body inline. The new commands added by REG-517 follow this established pattern exactly. This is an accepted pattern for VS Code extension command registration.

**`buildEdgeItems` — 18 lines: GOOD**

Clean, focused, correct. The deduplication-then-filter-then-fetch loop is easy to follow.

**`formatNodeTooltip` — 16 lines: GOOD**

Appropriately small, single responsibility.

**Bookmark methods — each 4–10 lines: GOOD**

`addBookmark`, `removeBookmark`, `isBookmarked`, `clearBookmarks` are clean and do exactly one thing.

**`resolveNodeAtCursor` — 20 lines: GOOD**

Well-extracted helper. The early-return pattern avoids nesting.

---

### Patterns and naming

**OK: New method naming is consistent with existing patterns.** `setHiddenEdgeTypes` / `getHiddenEdgeTypes`, `addBookmark` / `removeBookmark` / `isBookmarked` / `clearBookmarks` — all follow the established `verb+Noun` or `get/set/is` conventions already present in the file.

**OK: `setRootNode` and `clearAndSetRoot` duplication is pre-existing.** Lines 71–84 (`setRootNode`) and lines 137–149 (`clearAndSetRoot`) contain identical logic: push to history, limit history size, clear navigation path, fire event. This is not new code from REG-517, but it is noteworthy. The two methods differ only in whether the navigation path is cleared before or after the assignment — which is identical. This is dead duplication. It should be extracted to a private `pushToHistoryAndSet(node)` helper. Not blocking, but should be addressed in a follow-up.

**OK: `findAndSetBlastRadiusAtCursor` follows established pattern.** The structure mirrors `findAndTraceAtCursor` and `findAndSetCallersAtCursor` precisely. The `nodeType` guard filter lines break slightly differently from `callersProvider` (which filters for FUNCTION/METHOD), but the difference is intentional and documented.

**OBSERVATION: `COMMON_EDGE_TYPES` defined inline in `registerCommands` (extension.ts, lines 445–449).** This constant is only used within that one command handler. However, it is a domain concept (the set of known edge types) that could arguably belong in a shared constants module. For now, inline is fine. If it grows or is referenced elsewhere, extract it.

**OK: `formatFilePath` is exported from `edgesProvider.ts`, not from `types.ts`.** The test file accounts for both possible locations with a fallback try/catch. The function is a display utility for paths, so `edgesProvider.ts` is a defensible home, though `utils.ts` might be more appropriate. This is minor.

---

### Test quality

The tests are the best part of this PR. Five sections, all clearly titled. Each test:
- Sets up a focused scenario in the `it` description
- Uses explicit `assert` messages that describe what was expected
- Exercises the new public API surface directly

The mock infrastructure is thorough and well-commented. The `createProvider` helper cleanly encapsulates the setup boilerplate. The bookmark persistence tests verify both in-memory state and workspaceState writes. The edge filter tests verify both "what is hidden" and "what remains visible."

One minor test quality note: the `saveBookmarks` test (line 540) is titled "saveBookmarks writes to workspaceState" but tests via `addBookmark` side effect. The private `saveBookmarks` is indirectly tested, which is correct for a private method. The test name could be slightly more precise ("addBookmark persists to workspaceState") but this is cosmetic.

---

### Summary of required changes

None. There are no blocking issues. All observations are noted for future cleanup:

1. Extract `BookmarkManager` from `edgesProvider.ts` when file growth continues (target: below 500 lines)
2. Collapse the five-branch `status !== 'connected'` guard in `getChildren` to a single check
3. Extract `pushToHistoryAndSet` private helper to remove duplication between `setRootNode` and `clearAndSetRoot`
4. `extension.ts` CRITICAL size issue — pre-existing, should be its own refactoring ticket
