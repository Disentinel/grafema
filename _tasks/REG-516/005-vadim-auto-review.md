## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK
**Commit quality:** OK

---

### Acceptance Criteria Check

- [x] Panel shows direct/indirect dependents grouped
  - `blastRadiusProvider.ts` returns `section` items of `sectionKind: 'direct'` and `sectionKind: 'indirect'` from `getChildren(undefined)`, populated via BFS in `blastRadiusEngine.ts`.

- [x] "via X" shows dependency chain for indirect
  - `blastRadiusEngine.ts` builds `viaPath: string[]` during BFS (lines 220–224). The provider renders it in `getTreeItem` for `kind: 'dependent'` with `isIndirect=true`: `via ${names.join(', ')}${suffix}` (blastRadiusProvider.ts lines 165–168). Truncated to first 2 names + "..." when path is longer.

- [x] Guarantees at risk listed
  - `discoverGuarantees()` in `blastRadiusEngine.ts` uses GOVERNS-edge-first discovery (module → incoming GOVERNS → guarantee node), covering both `GUARANTEE` and namespaced `guarantee:*` types. Renders in a `sectionKind: 'guarantee'` section with `$(warning)` icon.

- [x] Impact score calculated and shown
  - `computeImpactScore()` implements the specified formula: `direct × 3 + indirect × 1 + guarantees × 10`. LOW/MEDIUM/HIGH thresholds correct (0–10 / 11–30 / 31+). Score shown in root item label as `[LOW]`/`[MEDIUM]`/`[HIGH]`, with matching icons `$(pass)` / `$(warning)` / `$(error)`.

- [x] Click any node → jump to source
  - All clickable item kinds (`root`, `dependent`, `guarantee`) attach `grafema.gotoLocation` with `[file, line, column=0]` arguments when `file` and `line` are present. Guarantee nodes without a file correctly omit the command (no crash).

---

### Dijkstra Blocking Issues Resolution

**B1: BFS depth guard (`depth > maxDepth` → `depth >= maxDepth`)** — RESOLVED.
`blastRadiusEngine.ts` line 172: `if (depth >= maxDepth) { continue; }`. The comment even references the fix: "Guard: do not fetch edges for nodes at maxDepth (Dijkstra fix B1)".

**B2: Guarantee node type query — GOVERNS-edge-first path only** — RESOLVED.
`discoverGuarantees()` never calls `queryNodes({ nodeType: 'GUARANTEE' })`. It queries MODULE nodes and follows incoming GOVERNS edges. The engine test file (`blastRadiusEngine.test.ts` lines 452–485) explicitly tests the `guarantee:queue` namespaced type, confirming this works.

**B3: VARIABLE node trigger — decision documented and implemented** — RESOLVED.
`extension.ts` `findAndSetBlastRadiusAtCursor()` (lines 700–705) triggers on `FUNCTION`, `METHOD`, `VARIABLE`, and `CONSTANT`. The provider's no-root message reads: "Move cursor to a function or variable to see its blast radius." The task spec mention of "function/variable" is honoured. This is broader than CALLERS (FUNCTION/METHOD only), which is a reasonable and explicit product decision.

---

### Detailed Analysis

#### blastRadiusEngine.ts

Correct BFS with depth semantics matching spec. Global cap at `MAX_BLAST_NODES = 150` (not per-node), which is the appropriate strategy for a panel that needs total count upfront. Root node added to `visited` before BFS begins, preventing it from appearing as its own dependent. Null node handling present (`if (!peerNode) { continue; }`). Every RFDB call wrapped in try/catch. Guarantee discovery wraps each step in try/catch and deduplicates by `seenIds`.

One minor observation (not blocking): the BFS dequeues at depth 0 to find direct dependents, then enqueues those at depth 1. Nodes at depth 1 are dequeued and their incoming edges produce nodes at depth 2, which land in `indirectDependents`. The logic is correct. However, the max-blast cap (`totalDiscovered >= MAX_BLAST_NODES`) is checked before the outer queue loop exits AND inside the per-edge loop, which is correct: both the inner edge loop and the outer queue loop respect the cap.

#### blastRadiusProvider.ts

All `BlastRadiusItem` kinds handled in `getTreeItem` with no unguarded `default` fallthrough (there is a `default: return new vscode.TreeItem('Unknown item')` safety net). Empty sections hidden cleanly (only added to items array when count > 0), which matches the ISSUES panel pattern and Dijkstra's N1 recommendation. Summary line shown only when there are dependents (in the non-`allZero` branch). `allZero` case correctly returns a single status message instead of sections.

Race condition handled via `requestId` counter (lines 33, 62, 82, 105, 112, 118). On `setRootNode`, `requestId++` increments before `runBFS` is called; inside `runBFS`, the result is discarded if `this.requestId !== myRequestId`.

Reconnect clears `rootNode`, `result`, and `loading`, then fires the change event — matching the CallersProvider pattern.

#### types.ts

`BlastRadiusItem` union type added cleanly at lines 215–222. Additive change only. The type matches what the provider constructs. `section` item's `sectionKind` is typed as `'direct' | 'indirect' | 'guarantee'`, which is sufficient and consistent with how CallersItem handles direction.

#### extension.ts

`BlastRadiusProvider` imported, instantiated, registered via `createTreeView` (Pattern B), and pushed to `context.subscriptions`. `grafema.openBlastRadius` command accepts optional `nodeId` from CodeLens, falling back to cursor scan. `grafema.refreshBlastRadius` command calls `blastRadiusProvider?.refresh()`. `findAndSetBlastRadiusAtCursor()` wired into the debounced selection-change handler alongside the existing cursor trackers.

`grafema.blastRadiusPlaceholder` command is gone — fully replaced by `grafema.openBlastRadius`. No dead registrations remain.

#### package.json

`"onView:grafemaBlastRadius"` in `activationEvents`. View `grafemaBlastRadius` declared with `"visibility": "collapsed"` (appropriate default). `viewsWelcome` for `grafemaBlastRadius` is absent — the placeholder "Coming in Phase 4." has been removed, as required. Commands `grafema.openBlastRadius` and `grafema.refreshBlastRadius` declared. Toolbar button for `grafema.refreshBlastRadius` in `view/title` menus with correct `when: "view == grafemaBlastRadius"` guard.

#### codeLensProvider.ts

Blast CodeLens now uses `grafema.openBlastRadius` (not `grafema.blastRadiusPlaceholder`). Consistent in both placeholder and resolved paths.

---

### Test Coverage

**blastRadiusEngine.test.ts** — 10 test groups covering:
- `computeImpactScore` at all boundary values (0, 10, 11, 30, 31) and formula components
- `DEPENDENCY_EDGE_TYPES` content
- Empty graph (0 dependents)
- Single direct dependent
- 2-hop indirect dependent with viaPath
- Cycle detection (A←B←A terminates, no duplicates)
- Null node mid-traversal (ghost node silently skipped)
- GUARANTEE node discovery via GOVERNS edge
- Namespaced `guarantee:queue` type discovered via GOVERNS (Dijkstra's T_NEW for B2)
- Root node with no file (guarantee discovery returns empty, no crash)
- Unique file count (2 callers in same file + 1 in different = fileCount 2)

**blastRadiusProvider.test.ts** — 12 test groups covering:
- Not connected status
- No root status
- Change event fires on `setRootNode`
- Single direct dependent + LOW impact label
- Multiple direct + indirect with viaPath in description
- Guarantee section expansion
- All-zero → "No dependents" status
- Summary line format (total, files, guarantees)
- Impact level badge in root label
- `gotoLocation` command on dependent with file+line
- Reconnect clears result + fires event
- BFS race condition (second `setRootNode` during active BFS — stale result discarded)

Tests are meaningful: they check actual data, not just "doesn't throw." Happy paths and failure modes are both covered. Race condition test is a real concurrent scenario, not a mock.

**Missing from Don's original list that are present anyway:** null-node handling (T_NEW from Dijkstra), race condition (N2 from Dijkstra), namespaced guarantee (T_NEW from Dijkstra). All three Dijkstra T_NEW additions are present.

---

### No Scope Creep

The changeset is minimal and focused:
- 2 new source files (`blastRadiusEngine.ts`, `blastRadiusProvider.ts`)
- 2 new test files
- 3 targeted modifications (`types.ts`, `extension.ts`, `package.json`, `codeLensProvider.ts`)
- No changes to RFDB client, core packages, MCP, or CLI

No TODOs, FIXMEs, commented-out code, or mock/stub patterns in production files. No empty implementations.
