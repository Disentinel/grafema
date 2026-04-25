## Dijkstra Correctness Review

**Verdict:** REJECT

**Functions reviewed:**

| Function | Verdict |
|---|---|
| `formatFilePath` | APPROVE (with noted edge cases) |
| `EdgesProvider.buildEdgeItems` | REJECT — `edge.edgeType` undefined crash |
| `EdgesProvider.loadBookmarks` | REJECT — cast without item validation |
| `EdgesProvider.addBookmark` | APPROVE |
| `EdgesProvider.removeBookmark` | APPROVE |
| `EdgesProvider.getChildren` (root level) | REJECT — `filterEdgeTypes` "none checked" early return bug |
| `EdgesProvider.getTreeItem` (bookmark/bookmark-section) | REJECT — `element.node.file` crash when file is empty string |
| `extension.ts filterEdgeTypes command` | REJECT — "none checked" silently aborts instead of hiding all |
| `extension.ts bookmarkNode command` | APPROVE (with noted gap) |
| `package.json when clauses` | APPROVE |

---

## Detailed Enumeration

### `formatFilePath(filePath: string)`

**All inputs:**

| Input | `parts` array | `parts.length <= 2` | Result |
|---|---|---|---|
| `""` (empty string) | `[""]` | length=1, true | `""` — returns input unchanged |
| `"login.js"` | `["login.js"]` | length=1, true | `"login.js"` — correct |
| `"auth/login.js"` | `["auth","login.js"]` | length=2, true | `"auth/login.js"` — correct |
| `"src/auth/login.js"` | `["src","auth","login.js"]` | length=3, false | `"auth/login.js"` — correct |
| `"a/b/c/d/e.js"` | 5 parts | false | `"d/e.js"` — correct |
| `"/abs/path/login.js"` | `["","abs","path","login.js"]` | length=4, false | `"path/login.js"` — correct |
| `"path/with trailing/"` | `["path","with trailing",""]` | length=3, false | `"trailing/"` — semantically odd but not a crash |
| Windows path `"src\\auth\\login.js"` | `["src\\auth\\login.js"]` | length=1, true | returns entire string unchanged — **no backslash splitting**. On Windows this produces a very long label. This is a known limitation of the platform split-on-`/` approach. Not a crash, but a display issue on Windows. |

**Verdict:** APPROVE. Empty string and Windows paths produce suboptimal display but no crash. The function never throws.

---

### `EdgesProvider.buildEdgeItems(client, rawEdges, direction, seenEdges, visitedNodeIds, out)`

Location: `edgesProvider.ts` lines 421-446.

**Input enumeration for `edge.edgeType`:**

The type signature is `WireEdge & Record<string, unknown>`. `WireEdge` presumably has `edgeType: string`, but `Record<string, unknown>` does not guarantee it. If a wire response comes from the server with a missing `edgeType` field, the value is `undefined`.

Line 435:
```ts
if (this.hiddenEdgeTypes.has(edge.edgeType)) continue;
```

`Set.prototype.has(undefined)` returns `false` — so the guard does NOT crash; it falls through to the `getNode` call and pushes the edge to `out`.

Line 431:
```ts
const edgeKey = `${direction}:${edge.edgeType}:${targetId}`;
```

With `edge.edgeType = undefined`, `edgeKey` becomes `"outgoing:undefined:someId"`. The deduplication still works (consistently produces the same key for the same undefined-type edge), so no crash. But the downstream `getTreeItem` will render the label as:

```
"undefined → NODE_TYPE "name""
```

This is a correctness defect — undefined edge type propagates to the user-visible tree label. Not a crash, but incorrect behavior that will confuse users.

**What if `rawEdges` is empty?**

`for (const edge of [])` — loop body never executes, function returns immediately. `out` unchanged (still `[]`). Correct.

**What if `client.getNode(targetId)` throws?**

The `await client.getNode(targetId)` is NOT wrapped in try/catch inside `buildEdgeItems`. If it throws, the exception propagates out of `buildEdgeItems`, which is called inside the `try` block in `getChildren` (lines 366-375). That outer catch handles it with `setStatusMessage('Error fetching edges')`. So the throw IS handled. Correct.

**What if `client.getNode(targetId)` returns `null`?**

Line 442: `targetNode: targetNode ?? undefined` — null is coerced to undefined. The edge item is pushed with `targetNode: undefined`. `getTreeItem` then renders `(unresolved)` for the label. This is the intentional path. Correct.

**What if `direction` is neither `'outgoing'` nor `'incoming'`?**

The type restricts it to the union, so TypeScript prevents this at compile time. No runtime issue.

**Issue found:**
- `[buildEdgeItems:line 431-435]` — `edge.edgeType` being `undefined` (possible with a malformed server response) produces the string `"undefined"` in the tree label. `hiddenEdgeTypes.has(undefined)` returns false, so the undefined-typed edge always appears and cannot be filtered.

**Verdict:** REJECT (undefined edgeType produces visible garbage label, and such edges are immune to the filter).

---

### `EdgesProvider.loadBookmarks()`

Location: `edgesProvider.ts` lines 545-551.

```ts
private loadBookmarks(): void {
  if (!this.context) return;
  const stored = this.context.workspaceState.get<unknown>('grafema.bookmarks');
  if (Array.isArray(stored)) {
    this.bookmarks = stored as WireNode[];
  }
}
```

**Input enumeration for `stored`:**

| `stored` value | `Array.isArray(stored)` | Result |
|---|---|---|
| `undefined` (key never written) | false | `this.bookmarks` stays `[]` — correct |
| `null` | false | `this.bookmarks` stays `[]` — correct |
| `42` (number) | false | `this.bookmarks` stays `[]` — correct |
| `"string"` | false | `this.bookmarks` stays `[]` — correct |
| `{}` (plain object) | false | `this.bookmarks` stays `[]` — correct |
| `[]` (empty array) | true | `this.bookmarks = [] as WireNode[]` — correct |
| `[{id:"x", name:"foo", ...valid WireNode}]` | true | cast and assign — correct |
| `[null]` — array with null item | true | `this.bookmarks = [null] as WireNode[]` — **null is stored in the bookmarks array** |
| `[{id: 123}]` — array with wrong-shaped object | true | **cast succeeds at runtime** (TypeScript cast is erased), object with `id=123` (number, not string) stored as WireNode |
| `[42, "string"]` — array of primitives | true | primitives stored as WireNode — downstream crash when `b.id` is accessed on a number |

The `as WireNode[]` cast is a type assertion — it performs no runtime validation. After a workspace state corruption, any array is accepted.

**Downstream impact of invalid items:**

`addBookmark` calls `this.bookmarks.some((b) => b.id === node.id)`. If `b` is `null`, this crashes with `TypeError: Cannot read properties of null (reading 'id')`.

`getChildren` for `bookmark-section` calls `this.bookmarks.map((node) => ({ kind: 'bookmark', node, metadata: parseNodeMetadata(node) }))`. If `node` is `null`, `parseNodeMetadata(null)` calls `JSON.parse(null.metadata)` — crash.

`getTreeItem` for `bookmark` calls `element.node.file` — crash if node is null.

**Issue found:**
- `[loadBookmarks:line 549]` — `stored as WireNode[]` performs no item-level validation. An array containing `null`, primitives, or structurally invalid objects is silently accepted. Downstream accesses to `.id`, `.file`, `.metadata` on corrupt entries will crash. This is a correctness defect: any workspace state corruption (or a future format change) can permanently brick the Explorer panel for that user until they manually clear workspace state.

**Verdict:** REJECT.

---

### `EdgesProvider.addBookmark(node: WireNode)`

Location: `edgesProvider.ts` lines 564-572.

**Input enumeration:**

| `node.id` | `bookmarks` state | Result |
|---|---|---|
| Already in `bookmarks` | `some((b) => b.id === node.id)` returns true | returns early — no duplicate added. Correct. |
| Not in `bookmarks`, `bookmarks.length < 20` | push, no shift | added to end. Correct. |
| Not in `bookmarks`, `bookmarks.length === 20` | push makes length 21, then `shift()` removes first | FIFO eviction: oldest is dropped, newest added. Correct. |
| `node` is `null` | `this.bookmarks.some((b) => b.id === null.id)` — crash | TypeScript signature says `WireNode`, but command handler does no null guard (see extension.ts). The `bookmarkNode` command handler checks `item.kind === 'node'` before calling `addBookmark`, so VSCode context menu protects against this. However, `addBookmark` is a public method — external callers can pass null. No in-function guard. |

The public surface of `addBookmark` is unguarded but all current callers properly type-check the argument. This is a latent issue, not a current defect.

**Verdict:** APPROVE (current callers are safe; no defensive guard is a minor concern, not a defect).

---

### `EdgesProvider.removeBookmark(nodeId: string)`

Location: `edgesProvider.ts` lines 577-581.

**Input enumeration:**

| `nodeId` | `bookmarks` state | Result |
|---|---|---|
| ID that exists | filter removes matching entry | correct |
| ID that does not exist | filter returns unchanged array | no error, correct behavior |
| `bookmarks` is `[]` | filter over empty array | returns `[]`, no error, correct |
| `nodeId` is `undefined` (runtime, not TypeScript) | `b.id !== undefined` — all entries pass the filter | nothing is removed. Silent no-op. Correct. |

**Verdict:** APPROVE.

---

### `EdgesProvider.getChildren()` — root level (lines 322-338)

**All four combinations of `bookmarks` and `rootNode`:**

| `bookmarks.length` | `rootNode` | `items` built |
|---|---|---|
| 0 | null | `[]` — empty tree. Correct. |
| 0 | set | `[{kind:'node',...}]` — just the root node. Correct. |
| >0 | null | `[{kind:'bookmark-section',...}]` — section visible, no node. Correct. |
| >0 | set | `[{kind:'bookmark-section',...}, {kind:'node',...}]` — both visible. Correct. |

The root-level logic is correct for all four combinations.

---

### `EdgesProvider.getTreeItem()` — bookmark kind (lines 188-204)

```ts
if (element.kind === 'bookmark') {
  const label = formatNodeLabel(element.node);
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = formatFilePath(element.node.file);
  ...
  if (element.metadata.line !== undefined) {
    item.command = { ... arguments: [element.node.file, element.metadata.line, element.metadata.column ?? 0] };
  }
  return item;
}
```

**Input enumeration:**

| `element.node.file` | `element.metadata` | Result |
|---|---|---|
| Non-empty string | `{ line: 10 }` | description set, command set. Correct. |
| Non-empty string | `{}` (no line) | description set, no command. Node label visible but click does nothing. Acceptable. |
| `""` (empty string) | anything | `formatFilePath("")` returns `""`. `item.description = ""`. This is visually confusing (no path shown) but not a crash. |
| **If `element.node` is null** (from corrupted loadBookmarks) | — | `formatNodeLabel(null)` calls `null.nodeType` — **crash**. `element.node.file` — **crash**. |

The null case is only reachable via the `loadBookmarks` corruption path already identified above. Both bugs share a root cause.

**Verdict:** REJECT (linked to `loadBookmarks` defect).

---

### `extension.ts filterEdgeTypes command` (lines 451-478)

```ts
const picked = await vscode.window.showQuickPick(items, { canPickMany: true, ... });

if (!picked) return; // cancelled

if (picked.length === 0) {
  vscode.window.showInformationMessage('All edge types hidden');
  return;
}
```

**Input enumeration:**

| User action | `picked` value | Effect |
|---|---|---|
| User cancels (presses Escape) | `undefined` | `!picked` is true, early return — correct |
| User confirms with all 14 types checked | `picked` = array of 14 items | `pickedLabels` has all 14, `newHidden` is empty Set — all edges visible. Correct. |
| User confirms with some checked | `picked` = subset | unchecked types added to `newHidden`, filter applied. Correct. |
| User confirms with **none checked** (unchecks everything, hits Enter) | `picked` = `[]` | `picked.length === 0` — shows info message **and returns early WITHOUT calling `setHiddenEdgeTypes`**. |

**This is the critical defect:** When the user explicitly selects "no edge types visible" by unchecking all items and confirming, the filter is NOT applied. The tree keeps its previous hidden set unchanged. The user sees a message "All edge types hidden" but the tree does not reflect this — it shows the same edges as before. The message is a lie.

The semantically correct behavior is: `picked = []` means the user wants ALL types hidden. The early return discards this intent.

**Issue found:**
- `[filterEdgeTypes:lines 467-470]` — when user confirms with zero items selected (`picked.length === 0`), the code shows an info message but does NOT apply the filter (`setHiddenEdgeTypes` is never called). The tree remains unchanged, contradicting the displayed message. The fix is to call `edgesProvider.setHiddenEdgeTypes(new Set(COMMON_EDGE_TYPES))` before returning.

**Verdict:** REJECT.

---

### `extension.ts bookmarkNode command` (lines 481-489)

```ts
disposables.push(vscode.commands.registerCommand(
  'grafema.bookmarkNode',
  (item: GraphTreeItem) => {
    if (!edgesProvider) return;
    if (item.kind === 'node') {
      edgesProvider.addBookmark(item.node);
    }
  }
));
```

**Input enumeration for `item`:**

| `item` | `item.kind` | Effect |
|---|---|---|
| A `node` item | `'node'` | `addBookmark` called. Correct. |
| An `edge` item | `'edge'` | guard fails, nothing happens. Correct (command should only apply to nodes). |
| A `bookmark` item | `'bookmark'` | guard fails, nothing happens. Correct (re-bookmarking a bookmark is a no-op). |
| A `bookmark-section` item | `'bookmark-section'` | guard fails, nothing happens. Correct. |
| `null` (if VSCode passes undefined item — e.g., command palette invocation) | accessing `null.kind` — **crash** | No null guard. |

The command is only surfaced in `view/item/context` with `viewItem == grafemaNode`, so normal VSCode UI paths cannot reach it with a null item. Command palette invocation without an argument would pass `undefined`, which crashes on `undefined.kind`. This is a latent risk.

**Verdict:** APPROVE (current call sites are safe; null-from-palette is a latent concern not a shipped bug).

---

### `package.json when clauses` — contextValue matching

**Enumeration of all `contextValue` strings set in `edgesProvider.ts`:**

| Location | `contextValue` set |
|---|---|
| `getTreeItem`, bookmark-section (line 184) | `'grafemaBookmarkSection'` |
| `getTreeItem`, bookmark (line 193) | `'grafemaBookmark'` |
| `getTreeItem`, node (line 216) | `'grafemaNode'` |
| `getTreeItem`, edge (line 272) | `'grafemaEdge'` |

**Enumeration of all `viewItem ==` comparisons in `package.json`:**

| `when` clause value | Used for command |
|---|---|
| `grafemaNode` | `setAsRoot` (context + inline), `bookmarkNode` (context) |
| `grafemaEdge` | `setAsRoot` (context + inline) |
| `grafemaBookmark` | `removeBookmark` (context), `setAsRoot` (inline) |

**Check: `grafemaBookmarkSection` — is it used anywhere?**

Set in code at line 184, but NO `when` clause in `package.json` references `grafemaBookmarkSection`. This is expected — there are no context-menu commands on the section header. Not a defect.

**Check: `grafemaBookmark` used in inline menu for `setAsRoot`.**

`package.json` line 292: `"when": "view == grafemaExplore && viewItem == grafemaBookmark"` for `setAsRoot` inline. The code sets `contextValue = 'grafemaBookmark'` on bookmark items. Strings match exactly. Correct.

**Check: `bookmarkNode` context menu scoped to `grafemaNode`.**

`package.json` line 271: `viewItem == grafemaNode`. Code sets `contextValue = 'grafemaNode'` for node items. Exact match. Correct.

**Check: `removeBookmark` scoped to `grafemaBookmark`.**

`package.json` line 277: `viewItem == grafemaBookmark`. Code sets `contextValue = 'grafemaBookmark'`. Exact match. Correct.

**Verdict:** APPROVE — all contextValue strings match exactly.

---

## Summary of Issues Found

### REJECT Issue 1 — `buildEdgeItems`: undefined `edgeType` produces garbage label (edgesProvider.ts line 431)

`edge.edgeType` can be `undefined` if the server returns a malformed edge. The deduplication key becomes `"outgoing:undefined:targetId"`, and the rendered tree label becomes `"undefined → NODE_TYPE "name""`. Additionally, `hiddenEdgeTypes.has(undefined)` returns `false`, meaning undefined-typed edges are immune to the edge type filter.

### REJECT Issue 2 — `loadBookmarks`: array items are not validated (edgesProvider.ts line 549)

`stored as WireNode[]` is a TypeScript cast with no runtime validation. An array containing `null`, numbers, or structurally invalid objects (from workspace state corruption or format migration) is silently accepted into `this.bookmarks`. Subsequent accesses to `.id`, `.file`, `.metadata` on corrupt entries crash the tree view.

### REJECT Issue 3 — `filterEdgeTypes` command: "none checked" confirmation does not apply filter (extension.ts lines 467-470)

When the user unchecks all edge types and confirms (pressing Enter on an empty multi-select), `picked` is `[]` and the code executes an early `return` after showing an info message, without ever calling `setHiddenEdgeTypes`. The tree remains unchanged. The displayed message "All edge types hidden" is incorrect. The user cannot hide all edge types via this UI path.
