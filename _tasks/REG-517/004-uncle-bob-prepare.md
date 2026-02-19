# Uncle Bob PREPARE Review: REG-517

Reviewer: Robert Martin (Uncle Bob)
Date: 2026-02-19
Task: REG-517 — Edge filtering (hidden edge types) and bookmark management for the Explorer panel

---

## Uncle Bob PREPARE Review: `src/edgesProvider.ts`

**File size:** 453 lines — OK (below 500)

**Methods to modify (per task scope):**
- `getChildren` (lines 241–369) — 128 lines
- `getTreeItem` (lines 156–236) — 80 lines
- constructor (lines 37–44) — 8 lines
- New state fields to add: `hiddenEdgeTypes`, bookmark storage

**File-level:**
- File is 453 lines and serves a single coherent purpose: TreeDataProvider for graph navigation. No split required before implementation.
- `getChildren` at 128 lines is the most concerning method. It handles three conceptually distinct cases (root, node, edge) each with their own logic blocks. With the new `hiddenEdgeTypes` filter being added inside the node-children branch, this method will grow further.
- `setRootNode` (lines 50–63) and `clearAndSetRoot` (lines 116–128) contain near-identical logic: save current root to history, enforce MAX_HISTORY, clear path, set new root, fire event. This is duplication that already exists; the task must not add a third copy.
- `getChildren` for the node case (lines 283–340) loops over outgoing then incoming edges with two structurally identical blocks. Each block: get edges, deduplicate with a Set, pre-fetch target node, push to array. Adding filter logic inside both loops will worsen this existing duplication.

**Method-level: `edgesProvider.ts:getChildren`**
- **Recommendation:** REFACTOR before adding filter logic
- Current length: 128 lines. Adding hidden-edge-type filtering inside both the outgoing and incoming loops will push it to ~145+ lines.
- The `if (state.status !== 'connected')` guard uses 6 separate if-blocks (lines 245–267) that each `return []`. This is verbose but acceptable since each branch could diverge later.
- The outgoing and incoming loops (lines 294–332) are structurally duplicated. Extract a private helper `fetchEdgesWithTargets(nodeId, direction)` that handles deduplication and target pre-fetch for one direction. Filter logic then lives in one place, not two.
- **Specific action:** Before the implementer adds `hiddenEdgeTypes` filtering, extract a `buildEdgeItems(nodeId: string, direction: 'outgoing' | 'incoming', visitedNodeIds: Set<string>, seenEdges: Set<string>): Promise<GraphTreeItem[]>` helper. The filter check (`if (hiddenEdgeTypes.has(edge.edgeType)) continue`) is added once inside that helper.

**Method-level: `edgesProvider.ts:getTreeItem`**
- **Recommendation:** SKIP (no structural change needed)
- Length: 80 lines. Handles two cases (node, edge) cleanly with an if/else. The edge branch (lines 188–235) will need to render filtered edges differently — but since hidden edges are excluded from `getChildren`, `getTreeItem` should not need changes for the filter feature.
- The bookmark indicator (if any visual marker is needed for bookmarked nodes) would be added in the node branch (lines 157–186) as a small icon/description change. This is isolated and does not require extraction.

**Method-level: `edgesProvider.ts:setRootNode` vs `clearAndSetRoot`**
- **Recommendation:** SKIP (existing duplication, out of scope for this task)
- Both methods share identical history-save logic. This is pre-existing duplication. The task must not create a third copy when adding bookmark state. If a `bookmarkNode` method is added, it must NOT replicate the history logic inline.

**Risk:** LOW
**Estimated scope:** 20–35 lines added (hiddenEdgeTypes Set + getter/setter + filter in extracted helper + bookmark storage Set + bookmark add/remove/query methods)

---

## Uncle Bob PREPARE Review: `src/extension.ts`

**File size:** 719 lines — CRITICAL (exceeds 700 line threshold)

**Methods to modify (per task scope):**
- `registerCommands` (lines 204–614) — 410 lines
- `activate` (lines 42–198) — 156 lines

**File-level:**
- CRITICAL: 719 lines. This file is already over the hard limit. The task adds more commands (filter toggle, bookmark add/remove) which will push `registerCommands` further beyond 410 lines.
- `registerCommands` at 410 lines is a god-function. It registers 20+ commands by concatenating them linearly. It also initializes the status bar and registers the cursor listener — three distinct responsibilities in one function.
- The three `findAndSetXxxAtCursor` functions (lines 620–711) are structurally identical: null-guard, get editor, check scheme, resolve relative path, call findNodeAtCursor, conditionally set provider. This is a clear extraction candidate.
- The task MUST NOT add new command registrations directly in `registerCommands` without a split plan. Adding 2–3 more 15-line command blocks to an already-410-line function worsens the existing violation.

**Mandatory refactor before implementation:**
The file exceeds 700 lines. The CLAUDE.md Root Cause Policy requires stopping to address the architectural mismatch before adding more code. However, given the prepare-review role, I flag this as a MUST SPLIT recommendation without prescribing the exact split (that is the implementer's decision with user confirmation).

Suggested split (for discussion, not a directive):
- `registerEdgeFilterCommands.ts` — filter and bookmark commands for the Explorer panel
- OR at minimum: extract `registerXxxPanelCommands(disposables, ...)` private helpers grouped by panel

**Method-level: `extension.ts:registerCommands`**
- **Recommendation:** REFACTOR — mandatory before adding more commands
- Length: 410 lines. Adding 2–3 new command handlers at 10–20 lines each will make this ~445 lines.
- The searchNodes command inline closure (lines 232–382) is 150 lines by itself. This is the largest single command handler. It should be extracted to its own function `registerSearchCommand(disposables, clientManager, edgesProvider, debugProvider)`.
- Filter/bookmark commands to be added for REG-517 are short (5–15 lines each), but adding to an already-bloated function is not acceptable.
- **Specific action:** Extract at minimum the `searchNodes` handler to a standalone function before adding new commands. This brings `registerCommands` to ~270 lines, making room for new additions within reason.

**Method-level: `extension.ts:findAndTraceAtCursor` / `findAndSetCallersAtCursor` / `findAndSetBlastRadiusAtCursor`**
- **Recommendation:** REFACTOR — extract shared cursor-resolution logic
- Lines 620–711: Three functions sharing identical 12-line boilerplate (null-guard → get editor → check scheme → resolve relative path). Only the final `if (node && ...)` differs.
- Extract `resolveNodeAtCursor(): Promise<WireNode | null>` that handles the common path. Each panel function becomes 5–8 lines.
- This refactor does NOT affect the task's new commands directly, but reduces file size by ~25 lines before the new code is added, helping stay below 750 lines post-task.

**Risk:** HIGH — file is already over CRITICAL threshold; adding more code without splitting first creates compounding debt
**Estimated scope:** 2–3 new command registrations (~40 lines) + filter state initialization (~5 lines). Without refactor, file reaches ~765 lines.

---

## Uncle Bob PREPARE Review: `src/types.ts`

**File size:** 243 lines — OK (well below 500)

**Methods to modify (per task scope):**
- `GraphTreeItem` type (lines 23–25) — adding `bookmark-section` and bookmark kinds
- Possibly new exported types for bookmark items

**File-level:**
- 243 lines, single responsibility: type definitions and a small number of pure formatting functions. No split required.
- The file follows a clean pattern: interface/type declaration → JSDoc → next declaration. New additions must maintain this pattern.
- `GraphTreeItem` is a union type on lines 23–25. It currently has two members. Adding a `bookmark-section` kind and a `bookmark` kind extends the union. This is a mechanical change.
- The file already hosts types for five distinct panels (ValueTrace, Callers, BlastRadius, Issues, GraphTree). Adding bookmark kinds for the Explorer panel is consistent with this pattern.

**Method-level: `types.ts:GraphTreeItem`**
- **Recommendation:** SKIP (mechanical extension, no structural risk)
- Adding new union members is additive and does not affect existing members.
- If `bookmark-section` and `bookmark` are only used within the Explorer panel (edgesProvider), they belong here alongside the existing node/edge kinds.
- The new members must include JSDoc comments consistent with the existing CallersItem and BlastRadiusItem documentation style.

**Method-level: `types.ts:formatNodeLabel` / `formatEdgeLabel`**
- **Recommendation:** SKIP
- These pure functions are not in scope for modification. They are 3–10 lines each, well-named, and single-purpose.

**Risk:** LOW
**Estimated scope:** 4–8 lines (2 new union members with inline documentation)

---

## Uncle Bob PREPARE Review: `packages/vscode/package.json`

**File size:** 337 lines — OK (below 500; JSON manifest)

**Sections to modify (per task scope):**
- `commands` array (lines 43–149): add new filter/bookmark command entries
- `menus.view/title` (lines 151–231): add menu entries for Explorer panel toolbar
- `menus.view/item/context` or `view/item/inline` (lines 233–256): add bookmark context menu entries

**File-level:**
- 337 lines of JSON manifest. No split applies (JSON cannot be split; VS Code requires a single package.json).
- The `commands` array currently has 19 entries. Adding 2–4 new commands (e.g., `grafema.filterEdgeTypes`, `grafema.bookmarkNode`, `grafema.removeBookmark`, `grafema.clearBookmarks`) is consistent with the existing pattern and scale.
- The `menus.view/title` section for `grafemaExplore` already has 7 entries (navigation@0 through navigation@6). Adding filter/bookmark toolbar buttons adds entries; verify the toolbar does not become overcrowded (VS Code clips overflow to `...` menu automatically, but icon choices matter for discoverability).
- Bookmark context menu entries in `view/item/context` require correct `when` expressions (e.g., `viewItem == grafemaNode`). The existing entries at lines 233–255 are the model to follow.

**Method-level:** N/A (JSON manifest, no methods)

**Specific structural concerns:**
- Command `title` strings must follow the existing convention: panel-specific commands use short titles without prefix (`"Refresh"`, `"Toggle Direction"`); global commands use the `"Grafema: ..."` prefix. New bookmark commands that appear only in context menus should use short titles; commands reachable from the command palette need the prefix.
- The `when` clause for bookmark-related items in `view/item/context` must match the `contextValue` set in `edgesProvider.ts`. If `contextValue = 'grafemaNode'` is the only value, the `when` expression is `viewItem == grafemaNode`. If bookmark nodes get a different `contextValue` (e.g., `grafemaBookmarkedNode`), the `package.json` menu `when` clause must match exactly.
- The `activationEvents` array (lines 13–20) does not need changes — bookmarks live within the already-activated `grafemaExplore` view.

**Risk:** LOW
**Estimated scope:** 4–8 new command entries (~20–40 lines), 2–6 new menu entries (~15–30 lines)

---

## Summary

| File | Lines | Status | Refactor Required |
|---|---|---|---|
| `src/edgesProvider.ts` | 453 | OK | YES — extract loop helper before adding filter logic |
| `src/extension.ts` | 719 | CRITICAL | YES — file exceeds hard limit; must split or extract before adding commands |
| `src/types.ts` | 243 | OK | NO — mechanical union extension |
| `package.json` | 337 | OK | NO — additive JSON changes |

### Overall Recommendation: CONDITIONAL PROCEED

Two files require refactoring before implementation begins:

**Blocking (MUST fix before coding):**
1. `extension.ts` (719 lines, CRITICAL): Extract at minimum the `searchNodes` command handler to a standalone function. This is required by the project's own hard limit. Consider whether filter+bookmark commands belong in a separate `registerExplorerCommands.ts` module.

**Recommended (do before adding filter logic):**
2. `edgesProvider.ts:getChildren`: Extract the outgoing/incoming loop duplication into a private helper. The filter logic (`hiddenEdgeTypes.has(edge.edgeType)`) then lives in one place, not two.

**Safe to proceed as-is:**
3. `types.ts`: Mechanical union extension. Follow existing JSDoc style.
4. `package.json`: Additive manifest entries. Follow existing title/when clause conventions.

**Guard rails for implementation:**
- Do not add a third copy of the history-save pattern in `edgesProvider.ts`.
- `contextValue` strings in `edgesProvider.ts` must align exactly with `when` clauses in `package.json`.
- The cursor tracker's `findAndSetBlastRadiusAtCursor` / `findAndSetCallersAtCursor` / `findAndTraceAtCursor` shared boilerplate is a pre-existing issue — do not worsen it, and consider extracting `resolveNodeAtCursor()` as part of the STEP 2.5 refactor.
