# REG-516: BLAST RADIUS Panel — Don Melton Implementation Plan

**Date:** 2026-02-19
**Author:** Don Melton (Tech Lead)
**Task:** VSCode Phase 4 — BLAST RADIUS panel

---

## 1. Exploration Findings

### 1.1 VSCode Extension Structure

The extension lives at `packages/vscode/src/`. The current panel inventory:

| View ID | Provider Class | File | Registration pattern |
|---|---|---|---|
| `grafemaStatus` | `StatusProvider` | `statusProvider.ts` | `registerTreeDataProvider` |
| `grafemaValueTrace` | `ValueTraceProvider` | `valueTraceProvider.ts` | `registerTreeDataProvider` |
| `grafemaCallers` | `CallersProvider` | `callersProvider.ts` | `registerTreeDataProvider` |
| `grafemaIssues` | `IssuesProvider` | `issuesProvider.ts` | `createTreeView` (needs badge) |
| `grafemaExplore` | `EdgesProvider` | `edgesProvider.ts` | `createTreeView` (navigation) |
| `grafemaDebug` | `DebugProvider` | `debugProvider.ts` | `registerTreeDataProvider` |

**BLAST RADIUS is already declared** in `package.json` as view `grafemaBlastRadius` with a placeholder welcome message. The view slot exists; only the provider and wiring are missing.

### 1.2 Panel Registration Pattern

Two patterns exist:

**Pattern A — `registerTreeDataProvider`** (simple panels: no badge, no `createTreeView`-specific features):
```typescript
const registration = vscode.window.registerTreeDataProvider('grafemaCallers', callersProvider);
context.subscriptions.push(registration);
```

**Pattern B — `createTreeView`** (panels needing badge or `treeView.message`):
```typescript
const view = vscode.window.createTreeView('grafemaIssues', { treeDataProvider: issuesProvider });
issuesProvider.setTreeView(view);
context.subscriptions.push(view);
```

BLAST RADIUS should use Pattern B because the spec requires:
- A summary line (implemented as `treeView.message` or as a dedicated tree item)
- Potential future badge showing impact score

### 1.3 TreeDataProvider Pattern (from CALLERS and ISSUES)

Every provider implements `vscode.TreeDataProvider<T>` where `T` is a discriminated union type:
```typescript
// Union type in types.ts
export type CallersItem =
  | { kind: 'root'; ... }
  | { kind: 'section'; ... }
  | { kind: 'call-node'; ... }
  | { kind: 'status'; ... }
  | { kind: 'more'; ... };
```

`getChildren(element?)` dispatches on `element.kind`. `getTreeItem(element)` dispatches on `element.kind`.

### 1.4 Cursor Tracking Pattern

The cursor follow pattern in `extension.ts` is established:
1. `onDidChangeTextEditorSelection` fires a debounced handler
2. Handler calls `findNodeAtCursor(client, filePath, line, column)`
3. Result is passed to provider via `provider.setRootNode(node)`

For BLAST RADIUS, the same pattern applies: on cursor change, if the node is a `FUNCTION` or `METHOD` (same filter as CALLERS), call `blastRadiusProvider.setRootNode(node)`.

### 1.5 RFDB Client — Available Traversal APIs

The `RFDBClient` (`packages/rfdb/ts/client.ts`) provides the following relevant methods:

**Graph traversal:**
- `getIncomingEdges(id, edgeTypes?)` — returns edges pointing INTO a node (edge.src = caller)
- `getOutgoingEdges(id, edgeTypes?)` — returns edges pointing OUT from a node
- `bfs(startIds, maxDepth, edgeTypes?)` — server-side BFS, returns `string[]` of reachable node IDs
- `reachability(startIds, maxDepth, edgeTypes?, backward?)` — server-side reachability, `backward=true` traverses incoming edges

**Key finding:** `reachability()` with `backward=true` is exactly what we need for "who depends on me." Looking at `findDependentFiles()` in client.ts (line 1257), Grafema already uses:
```typescript
const reachable = await this.reachability(
  nodeIds,
  2,
  ['IMPORTS_FROM', 'DEPENDS_ON', 'CALLS'],
  true,
);
```

However, the `reachability()` call only returns a flat list of node IDs with **no hop information** (no way to distinguish depth-1 from depth-2+). It cannot tell us "via X" chains.

**Conclusion:** We cannot use server-side `reachability()` for the BLAST RADIUS panel because we need:
1. Depth-per-node (direct vs. indirect grouping)
2. "Via X" intermediate path information

We must use **client-side BFS** over `getIncomingEdges()`, exactly the same pattern used in `CallersProvider` and `traceEngine.ts`.

### 1.6 Existing BFS Infrastructure (traceEngine.ts)

`traceEngine.ts` already implements BFS with:
- Visited set for cycle prevention
- Max-depth control
- `MAX_BRANCHING_FACTOR` cap (5 per node)
- `TraceNode` tree with depth and parent edge type

The BLAST RADIUS BFS is structurally similar to `traceForward()` in `traceEngine.ts`, but traverses incoming edges (not outgoing ASSIGNED_FROM/DERIVES_FROM) and uses dependency edge types.

### 1.7 Edge Types for Dependency Traversal

From `packages/types/src/edges.ts`, the relevant incoming edges for "who depends on me":

| Edge Type | Meaning | Traversal direction |
|---|---|---|
| `CALLS` | Function A calls function B. Incoming to B means "callers of B" | getIncomingEdges |
| `IMPORTS_FROM` | Module A imports from module B. Incoming to B means "who imports me" | getIncomingEdges |
| `DEPENDS_ON` | Generic dependency edge | getIncomingEdges |
| `USES` | A uses B (variable, value) | getIncomingEdges |
| `EXTENDS` | Class A extends B | getIncomingEdges |
| `IMPLEMENTS` | A implements B | getIncomingEdges |

**Recommended starting set:** `['CALLS', 'IMPORTS_FROM', 'DEPENDS_ON', 'USES']`

The rationale: CALLS captures direct function dependencies, IMPORTS_FROM captures module-level dependencies, DEPENDS_ON is the generic catch-all, USES captures variable consumers. EXTENDS/IMPLEMENTS are narrower and can be added later if needed.

### 1.8 Guarantee Nodes and How They Reference Code

From `packages/core/src/core/GuaranteeManager.ts` and the `.d.ts` declaration:

- Guarantee nodes use `type: 'GUARANTEE'` and ID format `GUARANTEE:{id}`
- `GOVERNS` edges go FROM guarantee TO module: `GUARANTEE:foo --GOVERNS--> MODULE:src/auth.js`
- `findAffectedGuarantees(nodeId)` finds guarantees by: (1) finding the node's file, (2) finding the MODULE node for that file, (3) finding GOVERNS edges pointing to that module

**This means:** To find "guarantees at risk" for a given node, we:
1. Query `queryNodes({ nodeType: 'GUARANTEE' })` to get all guarantee nodes
2. For each guarantee, get its GOVERNS edges (`getOutgoingEdges(guaranteeId, ['GOVERNS'])`)
3. Check if any governed module matches the root node's file

OR equivalently: get the MODULE node for our target's file, then call `getIncomingEdges(moduleId, ['GOVERNS'])`.

The second approach (file -> module -> incoming GOVERNS) is more efficient. It matches `GuaranteeManager.findAffectedGuarantees()` exactly.

### 1.9 Existing Placeholder (package.json and extension.ts)

`package.json` already declares:
- View `grafemaBlastRadius` with welcome content "Coming in Phase 4."
- Command `grafema.blastRadiusPlaceholder` (just shows an info message)
- Setting `grafema.codeLens.showBlastRadius` (boolean, default false)

`extension.ts` already registers `grafema.blastRadiusPlaceholder`. The welcome content in `viewsWelcome` must be removed or replaced when we register the real provider.

---

## 2. Architecture Decisions

### 2.1 BFS Strategy: Client-Side

**Decision: Client-side BFS over `getIncomingEdges()`**

Rationale:
- Server-side `reachability()` returns flat node ID list with no depth info — cannot distinguish direct (hop 1) from indirect (hop 2+)
- We need the path information for "via X" display on indirect nodes
- The existing `CallersProvider` uses exactly this pattern for call hierarchy (proven approach)
- `traceEngine.ts` already demonstrates BFS with depth tracking and cycle detection

The BFS will use a modified "levels" approach (not recursive DFS):
- Level 0 = root node itself
- Level 1 = direct dependents (nodes reachable via 1 incoming edge)
- Level 2+ = indirect dependents (nodes reachable via 2+ incoming edges), each carrying their "via X" path

**Cap per level:** Use `MAX_BRANCHING_FACTOR` (= 5) from `traceEngine.ts` to avoid runaway traversal.

**Max depth:** Default 3 (same as CALLERS). Keep configurable.

**Performance:** The BFS happens once when the root node is set, eagerly (not lazy). The result is cached in the provider. This is appropriate because blast radius is explicitly triggered (not per-keypress). The panel only updates when cursor moves to a new function node.

### 2.2 BFS Result Shape

We want to collect ALL nodes reachable within N hops upfront (not lazily per expand), because:
1. We need the total count for the summary line
2. We need the impact score upfront (shown at root)
3. The task spec shows a flat grouped list (direct / indirect sections), not an expanding tree per node

The BFS result structure:

```typescript
interface BlastRadiusResult {
  directDependents: BlastNode[];     // hop 1
  indirectDependents: BlastNode[];   // hop 2+
  guaranteesAtRisk: GuaranteeInfo[]; // guarantee nodes
  totalCount: number;
  fileCount: number;
  impactScore: number;
  impactLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

interface BlastNode {
  node: WireNode;
  metadata: NodeMetadata;
  viaPath: string[];  // names of intermediate nodes for "via X" display (empty for direct)
}

interface GuaranteeInfo {
  node: WireNode;         // the GUARANTEE node
  governedFiles: string[]; // files it governs (subset matching root's file)
}
```

### 2.3 Impact Score Formula

Per spec:
- Score = `direct × 3 + indirect × 1 + guarantees × 10`
- LOW = 0–10, MEDIUM = 11–30, HIGH = 31+

Implementation: pure function `computeImpactScore(direct, indirect, guarantees)` returns `{ score, level }`.

Icons for levels:
- LOW: `$(pass)` (green circle) or `$(circle-outline)` — use `$(pass)` with ThemeColor
- MEDIUM: `$(warning)` (yellow)
- HIGH: `$(error)` (red)

### 2.4 Guarantee Discovery

The approach mirrors `GuaranteeManager.findAffectedGuarantees()` but directly against the RFDB client (no GuaranteeManager available in the VSCode extension):

```
1. Get root node's file
2. Query for MODULE nodes with that file: queryNodes({ nodeType: 'MODULE', file: rootFile })
   — or more efficiently: getAllNodes({ nodeType: 'MODULE' }) and filter
   — Actually: use findByAttr({ nodeType: 'MODULE' }) but that returns IDs not WireNodes
   — Best: queryNodes({ nodeType: 'MODULE' }) and filter by file
3. For each matching MODULE node: getIncomingEdges(moduleId, ['GOVERNS'])
4. For each GOVERNS edge: the src is the GUARANTEE node ID; call getNode(guaranteeId)
```

This is O(modules × guarantees) in the worst case, but in practice a file belongs to one MODULE node and a codebase has few guarantees.

### 2.5 Panel Registration

Use Pattern B (`createTreeView`) to support future badge functionality. The provider needs a `setTreeView()` method.

---

## 3. File-by-File Plan

### 3.1 New File: `packages/vscode/src/blastRadiusEngine.ts`

**Purpose:** Pure BFS computation logic for blast radius. Extracted from the provider for testability (mirrors `traceEngine.ts` pattern).

**Contents:**
- `BlastNode` interface (node + metadata + viaPath)
- `GuaranteeInfo` interface
- `BlastRadiusResult` interface
- `DEPENDENCY_EDGE_TYPES` constant: `['CALLS', 'IMPORTS_FROM', 'DEPENDS_ON', 'USES']`
- `computeBlastRadius(client, rootNodeId, maxDepth)` — async function performing the BFS and guarantee discovery
- `computeImpactScore(direct, indirect, guarantees)` — pure function, returns `{ score, level }`

**BFS algorithm sketch:**
```
queue = [(rootNodeId, depth=0, viaPath=[])]
visited = Set{rootNodeId}
directDependents = []
indirectDependents = []

while queue not empty:
  (nodeId, depth, viaPath) = queue.dequeue()
  if depth > maxDepth: continue

  edges = getIncomingEdges(nodeId, DEPENDENCY_EDGE_TYPES)
  for each edge (src = caller):
    if src in visited: continue
    visited.add(src)
    peerNode = getNode(src)
    if depth == 0:
      directDependents.push({node: peerNode, viaPath: []})
      if depth+1 <= maxDepth:
        queue.enqueue((src, depth+1, [peerNode.name]))
    else:
      indirectDependents.push({node: peerNode, viaPath: viaPath})
      if depth+1 <= maxDepth:
        queue.enqueue((src, depth+1, [...viaPath, peerNode.name]))

# Cap both lists at MAX_BRANCHING_FACTOR * maxDepth or a global limit
```

**Guarantee discovery sketch:**
```
file = rootNode.file
if not file: return []
moduleIds = [] from queryNodes({nodeType: 'MODULE'}) filtered by file
for moduleId in moduleIds:
  governsEdges = getIncomingEdges(moduleId, ['GOVERNS'])
  for edge in governsEdges:
    guaranteeNode = getNode(edge.src)
    guaranteesAtRisk.push({node: guaranteeNode, ...})
```

### 3.2 New File: `packages/vscode/src/blastRadiusProvider.ts`

**Purpose:** `TreeDataProvider<BlastRadiusItem>` — the panel view.

**Contents:**

**Type definition** (also needs to be in `types.ts`):
```typescript
export type BlastRadiusItem =
  | { kind: 'root'; node: WireNode; metadata: NodeMetadata; result: BlastRadiusResult }
  | { kind: 'section'; label: string; icon: string; sectionKind: 'direct' | 'indirect' | 'guarantee'; count: number }
  | { kind: 'dependent'; node: WireNode; metadata: NodeMetadata; viaPath: string[]; isIndirect: boolean }
  | { kind: 'guarantee'; node: WireNode; metadata: NodeMetadata }
  | { kind: 'summary'; text: string }
  | { kind: 'status'; message: string }
  | { kind: 'loading' };
```

**Class: `BlastRadiusProvider`**
- `constructor(clientManager: GrafemaClientManager)`
- `setRootNode(node: WireNode | null): void` — triggers async BFS, updates tree
- `setTreeView(view: vscode.TreeView<BlastRadiusItem>): void`
- `refresh(): void`
- `getTreeItem(element)` — dispatches on `element.kind`
- `getChildren(element?)` — dispatches on `element.kind`

**`getChildren(undefined)` — root level:**
- Not connected: `[{ kind: 'status', message: 'Not connected to graph.' }]`
- No root: `[{ kind: 'status', message: 'Move cursor to a function to see its blast radius.' }]`
- Loading: `[{ kind: 'loading' }]`
- Loaded: `[root, section:direct, section:indirect, section:guarantee, summary]`

**`getChildren(section)` — section expansion:**
- `direct` section: returns `dependent` items with `isIndirect=false`
- `indirect` section: returns `dependent` items with `isIndirect=true, viaPath=[...]`
- `guarantee` section: returns `guarantee` items

**`getTreeItem` rendering:**

| Kind | Label | Icon | Collapsible | Command |
|---|---|---|---|---|
| `root` | `FUNCTION "name"` | impact-level icon | None | gotoLocation |
| `section` | `"Direct dependents (N)"` etc. | per kind | Expanded | - |
| `dependent` direct | node.name | `$(circle-filled)` | None | gotoLocation |
| `dependent` indirect | node.name | `$(circle-outline)` | None | gotoLocation |
| `guarantee` | guarantee name | `$(warning)` | None | gotoLocation if has file |
| `summary` | `"8 total · 5 files · 1 guarantee"` | `$(info)` | None | - |
| `loading` | `"Analyzing..."` | `$(loading~spin)` | None | - |

**Root item label:** `FUNCTION "name" [HIGH]` — append the impact level badge to the root label.

**Section labels:**
- `"Direct dependents (N)"` with icon `$(circle-filled)`
- `"Indirect dependents (N)"` with icon `$(circle-outline)`
- `"Guarantees at risk (N)"` with icon `$(warning)`

**Indirect node description:** `"via AuthService, validateToken"` (join viaPath with ", ")

### 3.3 Modified File: `packages/vscode/src/types.ts`

**Add** `BlastRadiusItem` union type at the bottom (matching the pattern of `CallersItem`, `IssueItem`).

**No changes** to existing types — purely additive.

### 3.4 Modified File: `packages/vscode/src/extension.ts`

**Changes required:**
1. Add import of `BlastRadiusProvider`
2. Add `let blastRadiusProvider: BlastRadiusProvider | null = null;` module-level var
3. In `activate()`: instantiate provider, register with `createTreeView`, wire into `context.subscriptions`
4. In `registerCommands()`: add `grafema.refreshBlastRadius` command and `grafema.openBlastRadius` command
5. In `findAndSetBlastRadiusAtCursor()`: new private function, same pattern as `findAndSetCallersAtCursor()` — only triggers on FUNCTION/METHOD nodes
6. In the debounced `onDidChangeTextEditorSelection` handler: add `await findAndSetBlastRadiusAtCursor()`
7. Remove or update the `grafema.blastRadiusPlaceholder` command (now opens the real panel)

### 3.5 Modified File: `packages/vscode/package.json`

**Changes required:**
1. Add `"onView:grafemaBlastRadius"` to `activationEvents`
2. **Remove** the `viewsWelcome` entry for `grafemaBlastRadius` (welcome screen replaced by real provider)
3. **Replace** `grafema.blastRadiusPlaceholder` command with `grafema.refreshBlastRadius` and `grafema.openBlastRadius` commands
4. Add toolbar button for `grafema.refreshBlastRadius` in `view/title` menus for `when: "view == grafemaBlastRadius"`
5. Update `grafema.codeLens.showBlastRadius` behavior: CodeLens blast lens now calls `grafema.openBlastRadius` instead of `grafema.blastRadiusPlaceholder`

**Note on `codeLensProvider.ts`:** The CodeLens "blast: ?" lens currently calls `grafema.blastRadiusPlaceholder`. After Phase 4, update to call `grafema.openBlastRadius` with the node ID argument so it focuses and analyzes the clicked node. This is a small change in `codeLensProvider.ts`.

### 3.6 New File: `packages/vscode/test/unit/blastRadiusProvider.test.ts`

Tests must be written first (TDD).

**Test coverage needed:**
- T1: Empty graph (no incoming edges) — returns status "No dependents found"
- T2: Not connected — returns "Not connected to graph"
- T3: No root — returns "Move cursor to a function"
- T4: Single direct dependent — section 'direct' with 1 item, impact = 3×1 = 3 → LOW
- T5: 4 direct dependents — section 'direct' with 4 items, score = 12 → MEDIUM
- T6: Indirect dependents appear in 'indirect' section with viaPath description
- T7: Guarantee at risk — 'guarantee' section appears, score += 10
- T8: Impact score formula — direct×3 + indirect×1 + guarantees×10
- T9: Summary line format — "N total dependents · M files · K guarantees"
- T10: Cycle detection — visited set prevents infinite BFS
- T11: Reconnect clears cache and fires change event
- T12: gotoLocation command attached to dependent nodes with file+line
- T13: Guarantee node without file — no crash, no gotoLocation command

**Mock setup pattern** (identical to `callersProvider.test.ts`):
- Mock vscode module injected via `require.cache['vscode']`
- `MockClientManager` with `isConnected()`, `getClient()`, `on()`
- `MockRFDBClient` with `getIncomingEdges()`, `getNode()`, `queryNodes()` stubs

### 3.7 New File: `packages/vscode/test/unit/blastRadiusEngine.test.ts`

Tests for the pure BFS engine:
- T1: Empty graph — result has 0 direct, 0 indirect, 0 guarantees
- T2: Single hop direct dependency
- T3: Two-hop indirect dependency with viaPath
- T4: Cycle detection (node X -> node Y -> node X incoming) — no infinite loop
- T5: Impact score: 0 all → LOW, 4 direct → MEDIUM, 11 direct → HIGH
- T6: Guarantee discovery via GOVERNS edge on MODULE
- T7: Node with no file — guarantee discovery returns empty, no crash

---

## 4. Dependencies Check

### 4.1 RFDB Client — What We Need vs. What Exists

| Need | Available | Status |
|---|---|---|
| `getIncomingEdges(id, edgeTypes)` | Yes — `client.getIncomingEdges()` | Ready |
| `getNode(id)` | Yes — `client.getNode()` | Ready |
| `queryNodes({nodeType: 'MODULE'})` | Yes — async generator | Ready |
| Server-side BFS with depth info | No — `bfs()` returns flat list without depth | Not needed (we use client BFS) |
| Server-side reachability with path info | No — `reachability()` returns flat list | Not needed |

**Conclusion:** No RFDB client changes needed. Everything we need is available via `getIncomingEdges()` + `getNode()` + `queryNodes()`. This is exactly how `CallersProvider` and `traceEngine.ts` work today.

### 4.2 Guarantee Node Discovery

The `GuaranteeManager` class is in `packages/core` and is NOT available in the VSCode extension (the extension only depends on `@grafema/rfdb-client` and `@grafema/types`). We must implement guarantee discovery directly via RFDB queries, replicating the logic from `GuaranteeManager.findAffectedGuarantees()`.

**No new package dependencies needed.** The pattern is:
```typescript
// 1. Query MODULE nodes for root node's file
// 2. For each MODULE: getIncomingEdges(moduleId, ['GOVERNS'])
// 3. For each GOVERNS edge: getNode(edge.src) to get the GUARANTEE node
```

### 4.3 `@grafema/types` — Guarantee Node Type

The `GUARANTEE` node type is NOT in `NODE_TYPE` const object in `packages/types/src/nodes.ts`. It appears in the `GuaranteeNodeRecord` interface (type field: `'guarantee:queue' | 'guarantee:api' | 'guarantee:permission'`) and in `GuaranteeManager.ts` as `type: 'GUARANTEE'`.

**This is an inconsistency.** `GuaranteeManager` creates nodes with `type: 'GUARANTEE'` (plain string, not namespaced), but `GuaranteeNodeRecord` shows namespaced types like `'guarantee:queue'`. The query `queryNodes({ nodeType: 'GUARANTEE' })` in GuaranteeManager's `list()` method is the source of truth for what's actually stored.

**Plan:** Query for `nodeType: 'GUARANTEE'` (the string used by GuaranteeManager when creating guarantee nodes), which is what `GuaranteeManager.list()` already uses. Also check for GOVERNS edges as a more reliable discovery method (doesn't depend on nodeType string).

---

## 5. Risk Assessment

### 5.1 Risk: BFS Performance on Large Codebases

**Risk level:** MEDIUM

If the target function has many incoming edges (e.g., a utility function called from 500 places), the BFS will make many sequential `getNode()` calls. Each RFDB call has latency overhead.

**Mitigation:**
- Cap total BFS nodes explored at a global limit (e.g., 50 direct + 100 indirect)
- Show "50+ dependents" truncation marker (same `more` pattern as CALLERS)
- BFS is triggered only when the cursor moves to a FUNCTION/METHOD, and only updates when the node changes (same-node deduplication from `CallersProvider.setRootNode()`)
- The RFDB client supports `reachability()` which is server-side and returns a flat set — if the panel becomes slow, we could do a two-phase approach: `reachability()` for the count/score, then shallow `getIncomingEdges()` for the display

### 5.2 Risk: Guarantee Discovery Correctness

**Risk level:** LOW-MEDIUM

The guarantee discovery relies on GOVERNS edges from GUARANTEE nodes to MODULE nodes. If no guarantee has been created (most projects), this returns an empty list immediately.

If the user's project has GuaranteeAPI-style guarantees (different from GuaranteeManager-style), they may use different edge types. However, both use the `GOVERNS` edge type.

**Mitigation:** Catch all errors in guarantee discovery, return empty array on any failure.

### 5.3 Risk: NODE TYPE String for Guarantee

**Risk level:** LOW

The `GUARANTEE` node type string mismatch (see Section 4.3). The queries by GOVERNS edge (incoming to MODULE) avoid relying on the nodeType string entirely.

**Mitigation:** Primary path is GOVERNS edge discovery, not nodeType query.

### 5.4 Risk: Extension Activation and View ID Collision

**Risk level:** LOW

The `grafemaBlastRadius` view ID is already declared in `package.json`. The `viewsWelcome` welcome content will be replaced when the real provider is registered. This is clean.

**The one change needed:** Remove the `viewsWelcome` entry once the provider is registered, otherwise both the welcome screen and the provider's content will appear.

### 5.5 Risk: "Via X" Chain Length

**Risk level:** LOW

For deeply nested indirect dependencies, the "via X" path could be very long. E.g., "via ServiceA, ControllerB, MiddlewareC, RouterD".

**Mitigation:** Cap viaPath display to first 2 names + "..." if longer than 2. Implementation choice: in `getTreeItem` for indirect dependent items.

---

## 6. Summary: File Change List

| File | Status | What changes |
|---|---|---|
| `packages/vscode/src/blastRadiusEngine.ts` | NEW | BFS engine, impact score computation |
| `packages/vscode/src/blastRadiusProvider.ts` | NEW | TreeDataProvider implementation |
| `packages/vscode/src/types.ts` | MODIFY | Add `BlastRadiusItem` union type |
| `packages/vscode/src/extension.ts` | MODIFY | Register provider, add commands, wire cursor tracking |
| `packages/vscode/package.json` | MODIFY | activationEvents, remove viewsWelcome, update commands, add toolbar button |
| `packages/vscode/src/codeLensProvider.ts` | MODIFY | Update blast CodeLens command to `grafema.openBlastRadius` |
| `packages/vscode/test/unit/blastRadiusProvider.test.ts` | NEW (TDD) | Provider tests |
| `packages/vscode/test/unit/blastRadiusEngine.test.ts` | NEW (TDD) | Engine tests |

**No changes needed in:**
- `packages/rfdb/` (client is sufficient as-is)
- `packages/types/` (existing types cover needs)
- `packages/core/` (guarantee logic reimplemented directly via RFDB queries)
- `packages/mcp/` (unrelated)

---

## 7. Implementation Order (for Rob)

1. Write `blastRadiusEngine.test.ts` (TDD — engine tests first)
2. Write `blastRadiusProvider.test.ts` (TDD — provider tests first)
3. Implement `blastRadiusEngine.ts` — make engine tests pass
4. Add `BlastRadiusItem` to `types.ts`
5. Implement `blastRadiusProvider.ts` — make provider tests pass
6. Wire everything in `extension.ts`
7. Update `package.json`
8. Update `codeLensProvider.ts` (small change: command ID)
9. Build and smoke-test in VSCode

**Commit order:**
- Commit 1: tests for blastRadiusEngine + blastRadiusProvider (tests only, red)
- Commit 2: blastRadiusEngine.ts + types update (tests go green for engine)
- Commit 3: blastRadiusProvider.ts (provider tests go green)
- Commit 4: extension.ts + package.json + codeLensProvider.ts wiring (integration complete)
