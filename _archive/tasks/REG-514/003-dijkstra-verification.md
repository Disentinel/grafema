# Dijkstra Plan Verification — REG-514

**Verifier:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-19
**Plan reviewed:** `_tasks/REG-514/002-don-plan.md`

---

## Verdict: CONDITIONAL APPROVE

The plan is structurally sound and the core traversal logic is correct. However, seven gaps require resolution before implementation begins. Three gaps are blockers (would produce incorrect runtime behavior); four are issues that Kent/Rob must address explicitly during implementation.

---

## Completeness Tables

### Table 1: CallersItem Kind Universe

Every kind must be reachable AND every kind must have a defined handler in `getTreeItem()` AND `getChildren()`.

| Kind | Reachable? | getTreeItem defined? | getChildren defined? | Notes |
|------|-----------|---------------------|---------------------|-------|
| `root` | YES — always first child of root level when rootNode is set | YES (plan §5.5) | Not applicable — plan says `.collapsed = None`; getChildren called with it? | **GAP: what does getChildren() return when called with a `root` element?** |
| `section` | YES — second/third child of root level | YES (plan §5.5) | YES (plan §5.3 "Section element") | OK |
| `call-node` | YES — children of section or call-node | YES (plan §5.5) | YES (plan §5.3 "call-node element") | OK |
| `status` | YES — root level when disconnected or no rootNode | YES (plan §5.5) | **MISSING** — no definition | **GAP: getChildren() is not specified for `status` kind** |
| `more` | YES — appended when filtered.length > MAX_BRANCHING_FACTOR | YES (plan §5.5) | **MISSING** — no definition | **GAP: getChildren() is not specified for `more` kind** |
| `error` | NO — not in the type union | — | — | **GAP: no error state kind; errors during expansion silently drop children** |

**Finding 1 (blocker):** `getChildren()` is specified for `root` (implicitly — CollapsibleState.None means not expanded), `section`, and `call-node`. It is NOT specified for `status` and `more`. In `valueTraceProvider.ts` (the reference implementation), `getChildren()` falls through to `return []` for `gap` and `more` kinds because neither matches the handled cases — VSCode never calls `getChildren()` for items with `CollapsibleState.None`. The plan MUST explicitly set `CollapsibleState.None` for `status`, `more`, and `root` items in `getTreeItem()`. This is implied by "None" in plan §5.5 but NOT stated as a constraint on `getChildren()`. If implementer accidentally marks `status` as Collapsed, VSCode calls `getChildren(statusItem)` and gets undefined behavior. The plan must explicitly state: all three non-expandable kinds MUST return `TreeItemCollapsibleState.None`, and `getChildren()` MUST return `[]` as fallback for all unrecognized kinds.

**Finding 2:** There is no `error` kind for the state where `getChildren()` itself throws. `edgesProvider.ts` handles this with `this.setStatusMessage('Error fetching edges')` — it fires a refresh and returns `[]`. The plan says "silent fail" in `findAndSetCallersAtCursor()` but does not specify what `getChildren()` returns when `client.getIncomingEdges()` throws mid-expansion. The plan MUST specify error behavior for the section expansion path.

---

### Table 2: getChildren() Element Type Dispatch

Every possible value of `element` passed to `getChildren(element)` must be handled.

| element value | When it occurs | Plan handles? |
|--------------|----------------|--------------|
| `undefined` | VSCode calls for root level | YES — returns status OR [root, section, section] |
| `{ kind: 'root', ... }` | User expands the root label row | **UNCLEAR** — plan §5.5 says CollapsibleState.None for root, so VSCode should not call this. But if it does? |
| `{ kind: 'section', direction: 'incoming' }` | User expands Incoming section | YES |
| `{ kind: 'section', direction: 'outgoing' }` | User expands Outgoing section | YES |
| `{ kind: 'call-node', depth < maxDepth, ... }` | User expands a caller/callee | YES |
| `{ kind: 'call-node', depth >= maxDepth, ... }` | User expands at depth limit | YES — returns `[]` |
| `{ kind: 'status', ... }` | Never expected (CollapsibleState.None) | NOT specified |
| `{ kind: 'more', ... }` | Never expected (CollapsibleState.None) | NOT specified |

**Finding 3:** The `getChildren()` implementation pseudocode in §5.3 handles only `section` and `call-node`. It does not have a final `default: return []` branch. TypeScript exhaustiveness is only enforced at compile time if the dispatch is a switch with a `never` branch. The plan must require an explicit `return []` fallback.

---

### Table 3: Node Types with CALLS Edges

The plan targets FUNCTION and METHOD for CodeLens and CALLERS panel auto-update. I enumerate ALL node types that could plausibly have outgoing or incoming CALLS edges in the graph schema.

| Node Type | Can have CALLS edges? | Plan targets it? | Verdict |
|-----------|----------------------|-----------------|---------|
| `FUNCTION` | YES — primary target | YES | OK |
| `METHOD` | YES — primary target | YES | OK |
| `FUNCTION` with `arrowFunction: true` | YES — same node type as FUNCTION | YES (implicitly, same nodeType) | OK |
| `FUNCTION` with `isClassMethod: true` | YES — this is a FUNCTION node, not METHOD | YES (same nodeType FUNCTION) | OK |
| `MethodNodeRecord.kind = 'constructor'` | Constructors: `kind: 'method' \| 'get' \| 'set' \| 'constructor'` — they ARE a METHOD node | YES (nodeType = METHOD) | OK — covered |
| `MethodNodeRecord.kind = 'get'` | Getter — may CALLS other things | YES (nodeType = METHOD) | OK |
| `MethodNodeRecord.kind = 'set'` | Setter — may CALLS other things | YES (nodeType = METHOD) | OK |
| `CALL` | `CallNodeRecord` — a call SITE node, not a callable. Has CALLS edges from FUNCTION to CALL? Or is CALL the edge target? | NOT targeted | **GAP: needs clarification** |
| `express:middleware` | Could be called as a function | NOT targeted | Acceptable for Phase 2 |
| `http:route` | Handler — called by framework | NOT targeted | Acceptable for Phase 2 |
| `VARIABLE` | Could hold a function (func = () => {}) | NOT targeted | Acceptable for Phase 2 |

**Finding 4:** The `MethodNodeRecord` schema (from `nodes.ts` line 141-147) shows that `kind: 'constructor'` is a valid METHOD kind. A constructor IS a METHOD node. The plan correctly includes METHOD in both CodeLens and follow-cursor targeting. This is verified correct.

**Finding 5 (clarification needed):** The `CALL` node type (`CallNodeRecord`) represents a call SITE. In the graph schema, CALLS edges connect `FUNCTION --CALLS--> FUNCTION`. But `CALL` nodes also exist as a separate entity. The plan does not clarify whether `getIncomingEdges(FUNCTION.id, ['CALLS'])` can return edges where `src` is a CALL node (not a FUNCTION/METHOD). If the graph stores `FUNCTION --CALLS--> FUNCTION` directly, this is not an issue. If it stores `FUNCTION --CALLS--> CALL --?--> FUNCTION`, the callers panel would show CALL nodes rather than the calling FUNCTION nodes. This assumption needs verification during implementation (see plan §13 Risk 1 — the plan acknowledges this must be dogfooded).

---

### Table 4: Test File Filter Pattern Completeness

The plan specifies: `/test/`, `\.test\.`, `\.spec\.`, `__tests__`

I enumerate all common test file conventions in JS/TS ecosystems:

| Pattern | Example | Plan covers? |
|---------|---------|-------------|
| `/test/` directory | `src/test/foo.js` | YES |
| `__tests__` directory | `src/__tests__/foo.js` | YES |
| `.test.js` / `.test.ts` | `foo.test.js` | YES (`\.test\.`) |
| `.spec.js` / `.spec.ts` | `foo.spec.js` | YES (`\.spec\.`) |
| `.test.jsx` / `.test.tsx` | `Foo.test.tsx` | YES (pattern is substring) |
| `.spec.jsx` / `.spec.tsx` | `Foo.spec.tsx` | YES |
| `tests/` directory (plural, no leading slash) | `tests/foo.js` | **NO** — `/test/` requires leading slash; `tests/foo.js` does NOT match `/test/` |
| `e2e/` directory | `e2e/login.spec.js` | **NO** |
| `cypress/` directory | `cypress/integration/foo.spec.js` | **NO** (but `.spec.` catches most Cypress files) |
| `__test__` (singular, non-standard) | `__test__/foo.js` | **NO** |
| `.stories.js` / `.stories.tsx` (Storybook) | `Foo.stories.tsx` | NO — but these are not test files per se |
| `fixtures/` | `fixtures/data.js` | NO — fixture files, not tests themselves |
| `test.js` (file named test.js at root) | `test.js` | **Ambiguous** — `/test/` would not match `test.js` |

**Finding 6 (gap, non-blocker):** The pattern `/test/` requires a leading slash and trailing slash, which means it matches `src/test/foo.js` but NOT `tests/foo.js` (plural). The `tests/` directory convention is extremely common (used by Node.js core, many npm packages). The plan should use `/(tests?|__tests?__)\/` or check if `peerNode.file` includes `/tests/` as a separate pattern. This is a correctness gap — functions in `tests/` will NOT be filtered.

**Finding 7 (gap, non-blocker):** `e2e/` and `cypress/` directories are common but not covered. For Phase 2 scope, these are acceptable omissions, but they should be documented in the settings description so users know.

---

### Table 5: Direction State Machine

The plan states: cycle `both → incoming → outgoing → both`

I enumerate all states and transitions:

| Current State | After cycleDirection() | Expected panel contents |
|--------------|----------------------|------------------------|
| `'both'` | `'incoming'` | Incoming section only |
| `'incoming'` | `'outgoing'` | Outgoing section only |
| `'outgoing'` | `'both'` | Both sections |

The cycle array in the plan (§5.6, command): "Toggle direction: both → incoming → outgoing → both"

Comparing to `valueTraceProvider.ts` which implements: `['both', 'backward', 'forward']` cycling via `(idx + 1) % cycle.length`.

The CALLERS plan direction cycle maps cleanly. The `getChildren(undefined)` logic at root level must implement:
- `showDirection !== 'outgoing'` → show incoming section (covers 'both' and 'incoming')
- `showDirection !== 'incoming'` → show outgoing section (covers 'both' and 'outgoing')

This boolean algebra is correct. Enumeration:

| showDirection | Show incoming? | Show outgoing? |
|--------------|----------------|----------------|
| `'both'` | `'both' !== 'outgoing'` = TRUE | `'both' !== 'incoming'` = TRUE | Correct |
| `'incoming'` | `'incoming' !== 'outgoing'` = TRUE | `'incoming' !== 'incoming'` = FALSE | Correct |
| `'outgoing'` | `'outgoing' !== 'outgoing'` = FALSE | `'outgoing' !== 'incoming'` = TRUE | Correct |

**Verification: direction state machine is correct and complete.**

---

### Table 6: CodeLens Cache Lifecycle

States: cold → fetching → warm → invalidated

| State | Trigger | provideCodeLenses behavior | resolveCodeLens behavior | Notes |
|-------|---------|--------------------------|------------------------|-------|
| Cold (no cache, no inFlight) | File opened first time | Returns placeholders, launches batchFetchCounts | Returns placeholder (cache miss) | OK |
| Fetching (inFlight.has(filePath)) | File opened again during fetch | Returns placeholders, does NOT re-launch batch (inFlight guard) | Returns placeholder | OK |
| Warm (cache.has(filePath)) | `_onDidChangeCodeLenses` fired after batch | Returns resolved lenses immediately | Returns resolved from cache instantly | OK |
| Invalidated (reconnect) | `clientManager.on('reconnected')` | cache.clear() + fire event → cold state | Same as cold | OK |
| Invalidated (manual refresh) | **NOT SPECIFIED** | **GAP** | — | **GAP: no grafema.refreshCodeLens command** |

**Finding 8 (gap, non-blocker):** There is no `grafema.refreshCodeLens` command in the plan. If the user re-runs `grafema analyze` without restarting VSCode, the cache will be stale. The `reconnected` event clears it, but only if the RFDB connection is restarted. If the graph is rebuilt while the socket stays connected (hot-reload of the graph), the cache is never invalidated. The plan should document this limitation explicitly.

**Finding 9 (race condition — blocker):** The `batchFetchCounts` function fires `_onDidChangeCodeLenses.fire()` when complete. This triggers VSCode to call `provideCodeLenses` again. The second call checks `cache.has(filePath)` — cache is set by `this.cache.set(filePath, counts)` BEFORE the fire. This is correct sequencing.

However: between `provideCodeLenses` returning placeholders and `batchFetchCounts` completing, the user may close and reopen the file. When the file reopens, `provideCodeLenses` is called again. At this point:
1. `cache` does NOT yet have the result (batch still running)
2. `inFlight` HAS the filePath (batch is running)
3. So the second call returns placeholders and does NOT re-launch batch

This is correct behavior. When the original batch completes, it calls `cache.set` and fires the event. VSCode re-calls `provideCodeLenses` for the current file, gets warm results.

**BUT:** The batch holds a reference to `funcNodes` and `filePath` from when it was launched. If the file was renamed between launch and completion — the cache is set with the old filePath. This is a theoretical edge case; acceptable for Phase 2.

**Finding 10 (race condition — blocker):** `_onDidChangeCodeLenses.fire()` inside `batchFetchCounts` triggers `provideCodeLenses` which calls `batchFetchCounts` again... No, it does NOT, because the second call finds `cache.has(filePath)` = true and returns resolved lenses without launching another batch. **Verified: no infinite loop.** This is correct.

**Finding 11 (blocker):** The `resolveCodeLens` implementation in plan §6.6 states:
```
const filePath = /* derive from current document */ '';
```
This is a TODO placeholder — the actual derivation is not specified in the pseudocode. The plan then says in the same section: "embed the filePath in the arguments array: `arguments: [nodeId, filePath]`". So `resolveCodeLens` must extract `filePath` from `codeLens.command?.arguments?.[1]`. The pseudocode leaves this as a comment. This is an **implementation gap** that Kent/Rob must handle explicitly — it is not left as an open question, it is answered in the paragraph but NOT reflected in the code pseudocode. The discrepancy will cause a runtime null-dereference if implementer follows the pseudocode literally.

The pseudocode should read:
```
const nodeId = codeLens.command?.arguments?.[0] as string | undefined;
const filePath = codeLens.command?.arguments?.[1] as string | undefined;
```

---

### Table 7: Edge Direction Verification

The plan claims: `src --CALLS--> dst` means src calls dst.

Verified against `packages/types/src/edges.ts`:
- `CALLS` edge type exists (line 32)
- `CallsEdge` interface: `src`, `dst`, optional `argumentCount` (lines 138-141)
- Schema does not specify direction semantics — it only defines the type

Verified against plan §1 which cites the API:
- `getIncomingEdges(F.id, ['CALLS'])` → edges where `F.id = dst` → `edge.src` = caller
- `getOutgoingEdges(F.id, ['CALLS'])` → edges where `F.id = src` → `edge.dst` = callee

This is the standard call graph convention and is consistent with the plan's section expansion logic:
- Incoming section: `edge.src = peerId` (the caller)
- Outgoing section: `edge.dst = peerId` (the callee)

**Verification: edge direction convention is internally consistent.** The plan's Risk 1 correctly notes this must be confirmed with actual graph data.

---

### Table 8: Empty States

| State | Expected behavior | Specified in plan? |
|-------|------------------|-------------------|
| Root level, no connection | `{ kind: 'status', message: 'Not connected' }` | YES (§5.3) |
| Root level, connected, no rootNode | `{ kind: 'status', message: ... }` | YES (§5.3) |
| Root level, connected, rootNode set | root + 0-2 sections | YES (§5.3) |
| Section expansion, 0 CALLS edges after filtering | section returns `[]` | **IMPLICIT** — not explicitly stated but follows from the code |
| Section expansion, 0 CALLS edges BEFORE filtering | section returns `[]` | **IMPLICIT** |
| Section expansion, ALL edges filtered out | section returns `[]` | **IMPLICIT** — the `more` item is added only if `filtered.length > MAX_BRANCHING_FACTOR`, not if filtered is empty. Correct. |
| call-node expansion at depth = maxDepth | returns `[]` | YES (§5.3) |
| call-node with 0 CALLS edges | returns `[]` (no children) | **IMPLICIT** |
| call-node where ALL children are in visitedIds | returns `[]` (all skipped) | **IMPLICIT** — but `more` logic: `filtered.slice(0, MAX_BRANCHING_FACTOR)` iterates and skips visited. Then `if filtered.length > MAX_BRANCHING_FACTOR: push more`. This checks the PRE-filter count (filtered after file filters, pre-cycle-check). So a `more` item may appear even if all non-visited items fit in MAX_BRANCHING_FACTOR. |
| File with 0 FUNCTION/METHOD nodes | CodeLens returns `[]` | YES (§6.2, step 6) |

**Finding 12 (gap, non-blocker):** When `getChildren()` is called on a `section` element and produces 0 children (all edges filtered), the section header remains expandable (CollapsibleState.Expanded) but expands to nothing. The user sees an empty section. This is visually acceptable but the plan should specify whether sections with 0 visible children should be hidden or shown as empty. The `valueTraceProvider.ts` reference does NOT hide empty sections — it shows them. This inconsistency with user expectation (why show "Incoming (0 callers)" as expandable?) is a UX gap, not a blocker.

---

### Table 9: Reconnection During Expansion

| Scenario | Expected behavior | Plan specifies? |
|---------|------------------|----------------|
| Connection drops while section expansion in progress | `client.getIncomingEdges()` throws | YES — plan implies `try/catch` via "silent fail" pattern |
| Connection drops while call-node expansion in progress | Same — throws | **NOT SPECIFIED** for callersProvider.getChildren() |
| Connection drops between `getIncomingEdges` and `getNode(peerId)` | First call succeeds, second throws | **NOT SPECIFIED** |
| Reconnect fires while panel is expanded | `clientManager.on('reconnected')` sets `rootNode = null`, fires tree refresh | YES (§5.1 constructor) |
| Reconnect fires after partial expansion | Tree refreshes to empty state | YES |

**Finding 13 (non-blocker):** The plan specifies the `reconnected` handler resets `rootNode = null` and fires the event. But the constructor listens on `'reconnected'` (plan §5.1). Looking at `extension.ts` and `valueTraceProvider.ts`, the actual event used is also `'reconnected'`. The `edgesProvider.ts` uses `'stateChange'`. The plan should specify which event: `'reconnected'` (plan) vs `'stateChange'` (edgesProvider pattern). These have different semantics — `'reconnected'` fires only on successful reconnection; `'stateChange'` fires on every state change including disconnect. For the CALLERS panel, `'reconnected'` (as planned) is correct — we only reset on reconnect, not on disconnect. Verified consistent with `valueTraceProvider.ts`.

---

### Table 10: Depth Boundary Condition

The plan states: `if (element.depth >= maxDepth): return []`

Enumerate edge cases:

| maxDepth | call-node depth | Returns children? | Correct? |
|---------|-----------------|------------------|----------|
| 1 | 0 | `0 >= 1` = FALSE → YES, returns children | Correct — direct callers of callers shown |
| 1 | 1 | `1 >= 1` = TRUE → NO, returns [] | Correct — stops at depth 1 |
| 3 | 0 | FALSE → children shown | Correct |
| 3 | 2 | FALSE → children shown | Correct |
| 3 | 3 | TRUE → no children | Correct |
| 5 | 4 | FALSE → children shown | Correct |
| 5 | 5 | TRUE → no children | Correct |

**Verification: depth boundary uses `>=` which is correct. At maxDepth=1, depth-0 items show their children (depth-1), but depth-1 items do not expand further. This gives exactly 1 level of recursion beyond the root, which is correct.**

**Finding 14:** The section expansion sets `depth: 0` for its children (plan §5.3: `depth: 0`). The root is not a call-node and has no depth. The section is not a call-node and has no depth. Therefore the first expandable call-nodes start at depth 0, and with `maxDepth=1`, they return children (depth 0 < maxDepth 1), giving one level of recursion. This matches the Quick Pick label "Max call hierarchy depth" — maxDepth=1 shows ONE level of caller-callers beyond direct callers. This is correct but potentially counterintuitive to users who may expect maxDepth=1 to mean "only direct callers". The plan should clarify this in the settings description.

---

### Table 11: CodeLens Three-Lens-Per-Function Completeness

For each function node, 3 lenses are created at the same range position.

| Lens # | Title (cold) | Title (warm) | Command | Arguments |
|--------|-------------|-------------|---------|-----------|
| 1 | `loading...` | `N callers` | `grafema.openCallers` | `[nodeId, filePath, 'incoming']` |
| 2 | `loading...` | `M callees` | `grafema.openCallers` | `[nodeId, filePath, 'outgoing']` |
| 3 | `loading...` | `blast: ?` | `grafema.blastRadiusPlaceholder` | `[nodeId, filePath]` |

**Finding 15 (gap — blocker):** The plan shows three lenses per function (§6.5) but the `provideCodeLenses` pseudocode (§6.2) creates only ONE lens per function node:
```
lens = new vscode.CodeLens(range)
lens.command = { command: 'grafema.codeLensPlaceholder', title: 'Grafema: loading...' }
return lens   ← single lens
```
The pseudocode says `lenses = funcNodes.map(node => { ... return lens })` — one lens per node. But the plan requires THREE lenses per node. The implementation pseudocode contradicts the decision in §6.5. Either:
a) The map must return `[lens1, lens2, lens3]` per node and flatten; OR
b) The cache-warm path in §6.4 builds three lenses per function.

This is a direct internal inconsistency. The cold path returns 1 placeholder, but the warm path (§6.4: "use cached counts to build resolved lenses immediately") should return 3. The transition from placeholder (1 lens) to resolved (3 lenses) via `_onDidChangeCodeLenses.fire()` means VSCode re-calls `provideCodeLenses` for the warm case. The warm `provideCodeLenses` must return 3 lenses per function. The cold `provideCodeLenses` returns 1 placeholder per function (for position-only). This asymmetry means the lens count changes between cold and warm renders — which may confuse VSCode's internal lens tracking. **The plan should clarify: does cold return 3 placeholder lenses or 1?** Common VSCode pattern is to return 3 placeholder lenses immediately and resolve each. The plan's pseudocode is incomplete.

---

### Table 12: `grafema.openCallers` Command Arguments

The command is registered as: `grafema.openCallers` with `{ nodeId, direction: 'incoming' | 'outgoing' }`.

Called from:
1. CodeLens click (lens 1: direction='incoming', lens 2: direction='outgoing')
2. `findAndSetCallersAtCursor()` calls `callersProvider.setRootNode(node)` directly — NOT via command
3. Status bar (no mention)
4. Command palette (no args — finds at cursor)

| Caller | Provides nodeId? | Provides direction? | Provider reacts? |
|--------|-----------------|--------------------|-----------------:|
| CodeLens lens 1 | YES | incoming | Must look up node by nodeId and set root + direction |
| CodeLens lens 2 | YES | outgoing | Same |
| Command palette (no args) | NO | NO | Must fallback to cursor-based node lookup |

**Finding 16 (gap — non-blocker):** The plan's command registration (§11) shows:
```typescript
vscode.commands.registerCommand('grafema.openCallers', async () => {
  await vscode.commands.executeCommand('grafemaCallers.focus');
  await findAndSetCallersAtCursor();
})
```
This version takes NO arguments. But CodeLens lenses call it WITH `{ nodeId, direction }` arguments (plan §6.5). The command handler ignores the arguments entirely — it calls `findAndSetCallersAtCursor()` which reads from cursor position, not from the provided nodeId. Clicking "3 callers" in CodeLens would focus the CALLERS panel and then set root to WHATEVER is at the current cursor position — which may be a different function than the one whose CodeLens was clicked.

This is a **behavioral correctness gap**. The command must accept optional `(args?: { nodeId?: string; direction?: string })` and, when `nodeId` is provided, look up the node and call `callersProvider.setRootNode(node)` with the specified direction.

---

## Summary of Gaps

### Blockers (must fix before implementation)

| # | Gap | Location in Plan |
|---|-----|-----------------|
| B1 | `getTreeItem()` must set `CollapsibleState.None` for `root`, `status`, `more` kinds explicitly; `getChildren()` must have a `return []` fallback for all unhandled kinds | §5.3, §5.5 |
| B2 | `resolveCodeLens` pseudocode uses `/* derive from current document */` placeholder but the plan already specifies the answer (`arguments[1]`). Pseudocode must be corrected to not leave this as an implicit derive | §6.6 |
| B3 | `provideCodeLenses` cold path creates 1 placeholder per function; warm path must create 3 lenses per function. The asymmetry and the transition mechanic must be explicitly specified | §6.2, §6.4, §6.5 |
| B4 | `grafema.openCallers` command ignores `nodeId` and `direction` arguments from CodeLens clicks. Command must handle both the zero-argument case (cursor) and the two-argument case (CodeLens click with nodeId+direction) | §11 |

### Non-Blockers (must be addressed during implementation)

| # | Gap | Location in Plan |
|---|-----|-----------------|
| N1 | Test file pattern `/test/` does not match `tests/` (plural). Add `/(tests?\/|__tests?__)` or separate `tests/` pattern | §2.5 |
| N2 | `e2e/` and `cypress/` not in test filter patterns — document limitation in settings description | §9 |
| N3 | No `grafema.refreshCodeLens` command — cache may be stale after hot-reload of graph without RFDB reconnect. Document limitation | §6, §9 |
| N4 | Empty sections (0 visible children after filter) remain expandable — no plan to suppress them. Acceptable but should be a conscious decision | §5.3 |

---

## Precondition Issues

### P1: CALLS edge population (Risk 1 in plan)

The plan correctly identifies that CALLS edge density is unverified. However, the plan does not specify a minimum verification step before declaring Phase 2 complete. **Precondition required:** the `grafema.refreshCallers` manual test checklist must include a step where the implementer runs `client.countEdgesByType(['CALLS'])` via debug output and confirms count > 0.

### P2: `getAllNodes({ file })` returns FUNCTION and METHOD nodes

The plan assumes `client.getAllNodes({ file: filePath })` returns nodes including FUNCTION and METHOD types for CodeLens. The plan audits this API as "confirmed" but does not show verification of the `{ file }` filter actually working for per-file CodeLens scoping. If `getAllNodes({ file })` is not implemented or returns all nodes, CodeLens would create lenses for nodes from all files on every file open.

### P3: MAX_BRANCHING_FACTOR import

The plan says "import and reuse MAX_BRANCHING_FACTOR from `src/traceEngine.ts`". Verified: `traceEngine.ts` exports `export const MAX_BRANCHING_FACTOR = 5` (line 26). This import will work. Correct.

### P4: `FunctionNodeRecord.arrowFunction` and CodeLens positions

Arrow functions `const fn = () => {}` have `nodeType = 'FUNCTION'` and `arrowFunction: true`. The plan filters by `nodeType === 'FUNCTION'`. Their `line` metadata points to the arrow function token position — NOT the `const` declaration line. CodeLens will appear at the arrow position. This is acceptable behavior but may confuse users who expect the lens on the `const` line. Not a correctness issue.

---

## Confirmed Correct

1. **Direction state machine** — boolean algebra is correct and complete (Table 5)
2. **Cycle detection** — visitedIds Set passed through call-node items, checked before recursion (Table 10 + §5.3)
3. **Depth boundary** — `depth >= maxDepth` with depth starting at 0 for direct callers is correct
4. **Edge direction convention** — `getIncomingEdges(F, ['CALLS']) → callers`, `getOutgoingEdges(F, ['CALLS']) → callees` is correct and internally consistent
5. **Cache race condition** — inFlight Set prevents duplicate batch launches; cache.set before fire prevents second batch launch; no infinite loop
6. **reconnected event** — correct event (not `stateChange`), consistent with valueTraceProvider pattern
7. **Constructor coverage** — `MethodNodeRecord.kind = 'constructor'` has nodeType `METHOD`, so constructors ARE included in the targeting
8. **Three-lens position** — multiple CodeLens objects on the same Range is valid VSCode API (confirmed by plan §6.5 note)
9. **Lazy loading decision** — correct architectural decision; VALUE TRACE's eager loading would be too expensive for call hierarchy
10. **CallHierarchyProvider rejection** — the reasons given (no LSP, filter incompatibility, panel consistency) are all valid

---

**Verdict: CONDITIONAL APPROVE**

The plan is approved conditional on resolution of the 4 blockers (B1-B4) before Kent/Rob begin implementation. The non-blockers should be addressed inline during implementation. The precondition checks (P1-P2) should be added to the manual test checklist.
