## Dijkstra Correctness Review — REG-499 (Round 2)

**Verdict:** APPROVE

**Functions reviewed:**
- `buildTreeState()` — APPROVE
- `registerCommands()` — APPROVE
- `nodeToStateInfo()` — APPROVE
- `socketPath` getter and `startWatching()` — previously reviewed in round 1 (011-dijkstra-review.md), verdict unchanged

---

### 1. `buildTreeState()` — selected-node ternary chain

The refactored logic:

```typescript
const selectedNode = selectedItem?.kind === 'node'
  ? selectedItem.node
  : selectedItem?.kind === 'edge'
    ? selectedItem.targetNode ?? null
    : null;

if (selectedNode) {
  state.selectedNode = nodeToStateInfo(selectedNode);
}

// Fetch visible edges for selected node if connected
if (selectedItem?.kind === 'node' && clientManager.isConnected()) {
  // ... fetch edges for selectedItem.node.id ...
}
```

Versus the original if/else-if:

```typescript
if (selectedItem?.kind === 'node') {
  const node = selectedItem.node;
  // set state.selectedNode
  // if connected: fetch edges for node.id
} else if (selectedItem?.kind === 'edge') {
  const targetNode = selectedItem.targetNode;
  if (targetNode) {
    // set state.selectedNode to targetNode
  }
}
```

**Input universe for `selectedItem`:**

| `selectedItem` value | Original behavior | New behavior | Equivalent? |
|----------------------|-------------------|--------------|-------------|
| `null` | No selectedNode set, no edges fetched | `selectedNode = null` → no set, no edges fetched | YES |
| `undefined` | Same as null (optional chaining short-circuits) | Same — ternary third arm returns `null` | YES |
| `{ kind: 'node', node: WireNode }` | Sets selectedNode from `node`; fetches edges if connected | `selectedNode = selectedItem.node` (WireNode, always truthy); sets selectedNode; fetches edges if connected | YES |
| `{ kind: 'edge', targetNode: WireNode }` | Sets selectedNode from `targetNode` | `selectedNode = targetNode ?? null = targetNode` (WireNode, truthy); sets selectedNode; edges NOT fetched (correct — edge items never triggered edge fetching in original) | YES |
| `{ kind: 'edge', targetNode: undefined }` | `targetNode` is falsy — no selectedNode set | `selectedNode = undefined ?? null = null` — no selectedNode set | YES |
| `{ kind: 'edge', targetNode: null }` | Not possible — `targetNode?: WireNode` cannot be `null` per type definition; type is `WireNode \| undefined`. `??` correctly handles `undefined` only. | `undefined ?? null = null` — no selectedNode set | YES (null not possible for this field) |

**Edge fetching guard:**

Original: edge-fetching was nested inside `if (selectedItem?.kind === 'node')`. New: `if (selectedItem?.kind === 'node' && clientManager.isConnected())` — the connected check moved outside the inner try, but the condition is still `kind === 'node'` only. For `kind === 'edge'` items, no edges are fetched in either version. Semantically equivalent.

**One notable behavioral difference found — ACCEPTABLE:**

In the original code for `kind === 'edge'` items, the `_edge` variable was declared but unused (`const _edge = selectedItem.edge`). The new code does not declare this unused variable. This is a removal of dead code, not a behavioral change.

**Verdict: APPROVE.** The ternary chain is semantically equivalent to the original if/else-if across all possible input categories.

---

### 2. `registerCommands()` — command registration completeness

**Input universe — all commands that must be registered:**

From `package.json` commands list (implicit — not diffed, but commands are referenced by string in the implementation):

| Command ID | Registered in new code? | Line in new `registerCommands()` |
|------------|------------------------|----------------------------------|
| `grafema.gotoLocation` | YES | push at line 111 |
| `grafema.findAtCursor` | YES | push at line 129 |
| `grafema.setAsRoot` | YES | push at line 134 |
| `grafema.refreshEdges` | YES | push at line 157 |
| `grafema.goBack` | YES | push at line 162 |
| `grafema.toggleFollowCursor` | YES | push at line 171 |
| `grafema.copyTreeState` | YES | push at line 183 |

**Non-command disposables:**

| Disposable | Registered in new code? | Notes |
|------------|------------------------|-------|
| Status bar item | YES | `disposables.push(statusBarItem)` at line 200 |
| `onDidChangeTextEditorSelection` listener | YES | `disposables.push(...)` at line 203 |

**Count verification:** 7 commands + 1 status bar item + 1 listener = 9 items pushed to `disposables`. All 9 are returned and spread into `context.subscriptions` in `activate()`.

**One pre-existing unregistered disposable (NOT a regression):**

```typescript
treeView.onDidChangeSelection((event) => {
  selectedTreeItem = event.selection[0] ?? null;
});
```

This returns a `Disposable` that is not stored or registered. This was not registered in the original code either — the diff shows no `- ` prefix on this block, meaning it was unchanged by this PR. The consequence is that on extension deactivation, the selection listener leaks. This is a pre-existing issue, not introduced by this PR.

**Ordering change — connection moved after `registerCommands()`:**

In the original `activate()`:
1. Register all commands → push to subscriptions → `await clientManager.connect()`

In the new `activate()`:
1. `registerCommands()` → `await clientManager.connect()` → push subscriptions

The `grafema.toggleFollowCursor` command calls `updateStatusBar()` which reads `statusBarItem` (module-level). The command is registered before `clientManager.connect()` in both versions. Since commands are invoked by users (not by `connect()`), the ordering difference is inconsequential — users cannot invoke commands before the extension activation completes.

The `selectionChangeListener` (cursor follow) is registered before `connect()` in the new code. In the original code it was also registered before `connect()` (they were sequential in the same function). However: the listener fires `findAndSetRoot(false)` which checks `clientManager?.isConnected()` before doing anything. If the listener fires during the connection await, it will safely no-op. Correct behavior preserved.

**Verdict: APPROVE.** All 7 commands, status bar item, and listener are correctly registered as disposables.

---

### 3. `nodeToStateInfo()` — output equivalence

```typescript
function nodeToStateInfo(node: WireNode): NodeStateInfo {
  const metadata = parseNodeMetadata(node);
  return {
    id: node.id,
    type: node.nodeType,
    name: node.name,
    file: node.file,
    line: metadata.line,
  };
}
```

**Original inlined block (for rootNode):**
```typescript
const metadata = parseNodeMetadata(rootNode);
state.rootNode = {
  id: rootNode.id,
  type: rootNode.nodeType,
  name: rootNode.name,
  file: rootNode.file,
  line: metadata.line,
};
```

**Original inlined block (for selectedNode when kind === 'node'):**
```typescript
const metadata = parseNodeMetadata(node);
state.selectedNode = {
  id: node.id,
  type: node.nodeType,
  name: node.name,
  file: node.file,
  line: metadata.line,
};
```

**Original inlined block (for selectedNode when kind === 'edge' and targetNode):**
```typescript
const metadata = parseNodeMetadata(targetNode);
state.selectedNode = {
  id: targetNode.id,
  type: targetNode.nodeType,
  name: targetNode.name,
  file: targetNode.file,
  line: metadata.line,
};
```

All three blocks are structurally identical. `nodeToStateInfo` faithfully captures all five fields from each block. `parseNodeMetadata` is called exactly once per invocation, same as the originals.

**Field-by-field verification:**

| Field | Original source | `nodeToStateInfo` source | Match? |
|-------|----------------|--------------------------|--------|
| `id` | `node.id` | `node.id` | YES |
| `type` | `node.nodeType` | `node.nodeType` | YES |
| `name` | `node.name` | `node.name` | YES |
| `file` | `node.file` | `node.file` | YES |
| `line` | `metadata.line` | `metadata.line` | YES |

**`parseNodeMetadata` behavior:**
- Parses `node.metadata` as JSON
- Returns `{}` on any parse error
- `metadata.line` returns `undefined` if key absent (e.g., empty metadata string `""`)
- In both original and new code, `line` will be `undefined` for nodes without line metadata
- `NodeStateInfo.line` is typed as `line?: number`, so `undefined` is valid

**Verdict: APPROVE.** The helper produces output identical to all three inlined blocks it replaced, across all WireNode inputs including those with malformed or absent metadata.

---

### Issues Found

**None that require rejection.**

**Pre-existing (not introduced by this PR):**
- `treeView.onDidChangeSelection` disposable is leaked (not stored, not registered in subscriptions). Present in original code. Would cause the listener to persist after deactivation. Not a correctness bug in the changed functions — out of scope for this PR.

**Limitations confirmed from round 1 review:**
- `startWatching()` DB_FILE detection silently fails when custom socket is in a different directory than `.grafema/`. Non-blocking — primary reconnect signal (socket file) works.
- Relative paths in `grafema.rfdbSocketPath` resolve against VS Code CWD, not workspace. Non-blocking — setting description implies absolute path.

---

### Precondition Issues

None. The three reviewed functions make no unverified assumptions:
- `nodeToStateInfo` receives a `WireNode` which is guaranteed non-null at all call sites (guarded by `if (rootNode)` and `if (selectedNode)`)
- `registerCommands` receives no parameters; accesses only module-level variables (`edgesProvider`, `clientManager`, `followCursor`, `statusBarItem`) that are initialized before or during `activate()`
- `buildTreeState` receives `clientManager` and `edgesProvider` as non-nullable parameters (enforced by the `if (!clientManager || !edgesProvider)` guard in the calling command)
