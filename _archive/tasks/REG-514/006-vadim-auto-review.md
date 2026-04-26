## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK (with one minor observation)
**Commit quality:** OK

---

### Feature Completeness Check

Checked each acceptance criterion against the implemented code:

**AC1: CALLERS panel shows incoming/outgoing call hierarchy**
- `CallersProvider.getChildren()` returns `section` items for `incoming` and `outgoing` directions.
- Sections expand to `call-node` items fetched via `getIncomingEdges` / `getOutgoingEdges` with `CALLS` edge type.
- Root node is displayed at the top with file:line description and goto command.
- Status items are shown when disconnected or no node is pinned.
- **PASS.**

**AC2: Recursive expansion works (caller's callers)**
- `getChildren` on a `call-node` calls `fetchCallNodes` recursively.
- Cycle detection via `visitedIds: Set<string>` — parent IDs are accumulated and checked before adding children.
- The `'both' -> 'incoming' -> 'outgoing' -> 'both'` cycle via `cycleDirection()` is wired up.
- **PASS.**

**AC3: Depth control and test/node_modules filter**
- `setMaxDepth(1..5)` is clamped with `Math.max(1, Math.min(5, depth))` and exposed via `grafema.setCallersDepth` Quick Pick command.
- `hideTestFiles` / `hideNodeModules` flags with 8-pattern test file detection; toggled via `grafema.toggleCallersFilter` Quick Pick.
- Initial values read from workspace configuration (`grafema.callers.defaultDepth`, `grafema.callers.hideTestFiles`, `grafema.callers.hideNodeModules`).
- Configuration schema declared in `package.json`.
- **PASS.**

**AC4: CodeLens shows counts above functions**
- `GrafemaCodeLensProvider.provideCodeLenses` queries all nodes in file, filters to `FUNCTION`/`METHOD`, places lenses at `line - 1` position.
- Two-phase approach: cold path returns placeholder lenses (`callers: ...`, `callees: ...`), warm path returns resolved counts.
- `batchFetchCounts` runs `Promise.all` over all functions in file, populates `cache`, fires `onDidChangeCodeLenses`.
- Disabled when `grafema.codeLens.enabled` is false.
- **PASS.**

**AC5: CodeLens segments clickable — open relevant panel**
- `callers` lens command: `grafema.openCallers` with `[nodeId, filePath, 'callers']`.
- `callees` lens command: `grafema.openCallers` with `[nodeId, filePath, 'callees']`.
- `grafema.openCallers` in `extension.ts` (B4 fix): reads `nodeId` and `lensType` from args, calls `setRootNode(node)` then `setDirection('incoming')` or `setDirection('outgoing')` accordingly.
- Blast radius lens: `grafema.blastRadiusPlaceholder` shows informational message — appropriate Phase 4 placeholder.
- **PASS.**

**AC6: Performance acceptable (no visible delay on scroll)**
- Cold path returns immediately from `provideCodeLenses` with pre-built placeholder lenses; batch fetch runs in background.
- `inFlight` set prevents duplicate concurrent fetches for the same file.
- Cache is per-file and persists across calls; `resolveCodeLens` reads from cache without async work.
- `onDidChangeCodeLenses` triggers re-render only once after all per-file counts are fetched.
- **PASS.**

---

### Dijkstra's Blockers Verification

**B1: `getTreeItem` CollapsibleState.None for non-expandable items, `getChildren` returns `[]` fallback**
- `getTreeItem` for `call-node`: `CollapsibleState.None` when `depth + 1 >= maxDepth`, `Collapsed` otherwise. Correct.
- `getTreeItem` for `status`, `more`, `root`: all use `CollapsibleState.None`. Correct.
- `getChildren` default case at bottom: `return []`. Correct.
- **ADDRESSED.**

**B2: `resolveCodeLens` reads `filePath` from `arguments[1]`**
- Implementation at line 106: `const filePath = codeLens.command?.arguments?.[1] as string | undefined;`
- Matches the lens construction: `arguments: [node.id, filePath, lensType]` — index 1 is `filePath`.
- **ADDRESSED.**

**B3: Cold path creates 3 placeholder lenses per function (2 when `showBlast` defaults to false)**
- `buildPlaceholderLenses`: emits callers + callees unconditionally, blast only if `showBlast` is true.
- Test in `codeLensProvider.test.ts` Section 2 asserts `4` lenses for 2 functions (i.e., 2 per function), confirming `showBlast=false` default.
- Comment in source says "3 placeholder lenses" but the code correctly emits 2 when `showBlast=false`. The comment is slightly misleading but the logic is correct.
- **ADDRESSED (minor comment inaccuracy is cosmetic, not a defect).**

**B4: `grafema.openCallers` uses `nodeId+direction` from args when provided**
- `extension.ts` line 467: command handler signature `(nodeId?, _filePath?, lensType?)`, fetches node by ID, calls `setDirection('incoming')` for `lensType==='callers'` and `setDirection('outgoing')` for `lensType==='callees'`.
- Falls back to cursor detection when args not provided.
- **ADDRESSED.**

---

### Test Coverage

**callersProvider.test.ts** — 7 test suites covering:
1. Incoming section: count and caller node IDs
2. Outgoing section: count and callee node IDs
3. Cycle detection: mutual recursion terminates
4. Filters: test file exclusion, node_modules exclusion
5. Branching factor cap: 6 callers → 5 call-nodes + 1 more item
6. Depth limit: `maxDepth=1` stops expansion at depth 1
7. Direction modes: `incoming`-only, `outgoing`-only

All happy paths and key failure/edge modes are covered. The cycle test correctly asserts termination without hanging.

**codeLensProvider.test.ts** — 6 test suites covering:
1. Empty file: no lenses returned
2. Cold cache: placeholder lenses (2 per function, verifying `showBlast=false` default)
3. Batch fetch: `onDidChangeCodeLenses` fires after background fetch
4. Warm cache: resolved lenses contain correct count text
5. `resolveCodeLens`: returns a value (lenient assertion — see observation below)
6. Reconnect: cache cleared, event fired

**Observation — `resolveCodeLens` test (Section 5) is weak:**
The test sets `lens.data = { nodeId, filePath }` (a `.data` property that the real implementation never reads) and then only asserts `resolved` is truthy. The implementation reads `arguments[0..2]` from `codeLens.command?.arguments`, but the test constructs a lens without a `command` set. The test passes because `resolveCodeLens` returns the codeLens unchanged when `nodeId` is undefined. This test does not actually verify the cache-hit path of `resolveCodeLens`. The warm-cache test in Section 4 compensates by verifying resolved counts in the returned lenses from `provideCodeLenses`, which indirectly covers the resolved path. Not a blocker — the warm-path is covered end-to-end via Section 4 — but the `resolveCodeLens` unit test is superficial.

---

### Forbidden Patterns

- No `TODO`, `FIXME`, `HACK`, `XXX` in production files.
- No commented-out code.
- No `mock`/`stub`/`fake` outside test files.
- No empty implementations (`return null`, `{}`).
- All `catch` blocks either log or return meaningful empty values — none are silent swallows without rationale.

---

### Scope Check

- Changes are limited to: `callersProvider.ts` (new), `codeLensProvider.ts` (new), `extension.ts` (registration + commands), `types.ts` (CallersItem type added), `package.json` (view, commands, configuration, menus).
- No unrelated changes observed.
- `grafemaBlastRadius` and `grafemaIssues` views are registered as placeholders with `viewsWelcome` messages — appropriate and in-scope for Phase 2 scaffolding.

---

### Summary

The implementation fully satisfies all six acceptance criteria. All four Dijkstra blockers are addressed correctly. Tests cover core logic paths including edge cases (cycles, branching cap, depth limits, filters). The only finding is a cosmetic method comment discrepancy (B3) and one weak `resolveCodeLens` unit test — neither warrants rejection.
