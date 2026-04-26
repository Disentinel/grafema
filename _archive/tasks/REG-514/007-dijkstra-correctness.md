## Dijkstra Correctness Review

**Verdict:** REJECT

**Functions reviewed:**
- `fetchCallNodes()` — REJECT (visitedIds mutation aliasing; "more" counter is wrong)
- `getChildren()` exhaustive dispatch — APPROVE (all 5 kinds handled)
- `cycleDirection()` — APPROVE
- `setMaxDepth()` — APPROVE
- `resolveCodeLens()` — APPROVE (conditional on "loading" string, documented below)
- `batchFetchCounts()` — APPROVE (race condition is benign, see below)
- `buildPlaceholderLenses()` / `buildResolvedLenses()` — APPROVE
- `buildCommand()` — APPROVE with observation

---

## Issues Found

### ISSUE 1 [fetchCallNodes:370] — visitedIds aliasing breaks cycle detection across siblings

**Location:** `callersProvider.ts`, line 370 (push into `children` array)

**The defect:**

```
const newVisited = new Set(parentVisitedIds);  // line 330
newVisited.add(parentNode.id);                  // line 331
...
children.push({
  ...
  visitedIds: newVisited,   // line 371 — same Set reference for ALL siblings
});
```

`newVisited` is a single Set object constructed once per `fetchCallNodes` call. Every `call-node` item pushed into `children` receives **a reference to the same Set object**. The Set is not copied per child.

**Enumeration of what happens when sibling B is expanded:**

Suppose `parentNode` has children A, B, C. All three receive `visitedIds = newVisited` (same reference). When the user expands A, `fetchCallNodes` is called with `parentVisitedIds = newVisited`. Inside that call:

```
const newVisited2 = new Set(parentVisitedIds);  // copies newVisited correctly
newVisited2.add(A.id);
```

This is fine at first glance — each expansion copies. So the defect is not that expansion corrupts state.

**The actual problem is subtler but real:**

The same `newVisited` Set is shared between siblings A, B, and C as their `visitedIds`. When A's expansion creates `newVisited2 = new Set(newVisited)` and then the user expands B, B's expansion also creates `new Set(newVisited)` — since `newVisited` was never mutated after construction, this is actually correct.

Wait — I need to re-examine. Let me enumerate precisely:

- After `fetchCallNodes(direction, parent, parentVisitedIds)`:
  - `newVisited = {all ancestors} ∪ {parent.id}`
  - All children items store `visitedIds: newVisited`
- When child A is expanded: `fetchCallNodes(direction, A.node, A.visitedIds)` where `A.visitedIds === newVisited`
  - Inside: `newVisited_A = new Set(newVisited)` — snapshot at that moment, then `newVisited_A.add(A.id)`
  - A's children store `visitedIds: newVisited_A`
- `newVisited` (the parent-level Set) is **never mutated after construction** in this path.

On this analysis, sibling isolation is actually correct. The sharing of a single Set reference is safe because the Set is never mutated after children are built. **I initially flagged this but the immutability holds.**

Revising: this is NOT a defect for the sibling isolation case. Withdrawing ISSUE 1 as a critical bug. Recording it as an observation: the code's correctness depends on the invariant that `newVisited` is never mutated after line 331. That invariant holds in the current code, but is fragile — any future mutation of the shared Set would break cycle detection for all siblings at once.

---

### ISSUE 1 (revised) [fetchCallNodes:375-377] — "more" counter is computed incorrectly

**Location:** `callersProvider.ts`, lines 337-376

```typescript
for (const edge of edges) {
  if (children.length >= MAX_BRANCHING_FACTOR) {
    break;           // stops at MAX_BRANCHING_FACTOR accepted children
  }

  const peerId = direction === 'incoming' ? edge.src : edge.dst;

  if (newVisited.has(peerId)) {
    continue;        // cycle: skip without incrementing skippedByFilter
  }

  const peerNode = await client.getNode(peerId);
  if (!peerNode) {
    continue;        // missing node: skip without incrementing skippedByFilter
  }

  if (this.hideTestFiles && isTestFile(peerFile)) {
    skippedByFilter++;
    continue;
  }
  if (this.hideNodeModules && peerFile.includes('node_modules/')) {
    skippedByFilter++;
    continue;
  }

  children.push({ ... });
}

const totalFiltered = edges.length - skippedByFilter;  // line 375
if (totalFiltered > MAX_BRANCHING_FACTOR) {
  children.push({ kind: 'more', count: totalFiltered - MAX_BRANCHING_FACTOR });
}
```

**Enumeration of cases for `totalFiltered`:**

`totalFiltered = edges.length - skippedByFilter`

`skippedByFilter` counts only edges that were skipped by the **test/node_modules filters**. It does NOT count:
1. Edges skipped because `newVisited.has(peerId)` (cycles)
2. Edges skipped because `peerNode` was null (missing nodes)
3. Edges that were never reached because `children.length >= MAX_BRANCHING_FACTOR` caused early `break`

**Concrete counter-example:**

- `edges.length = 10`, `MAX_BRANCHING_FACTOR = 5`
- Edges 1-5: all pass filters, all get added to children. `children.length` reaches 5.
- Loop breaks. `skippedByFilter = 0`.
- `totalFiltered = 10 - 0 = 10`
- `10 > 5` → `more` item with `count = 10 - 5 = 5`

This seems correct in this case. But consider:

- `edges.length = 10`, `MAX_BRANCHING_FACTOR = 5`
- Edges 1-3: pass filters, added to children (`children.length = 3`)
- Edge 4: cycle, `newVisited.has(peerId)` → skipped. `skippedByFilter` unchanged (still 0).
- Edge 5: missing node → skipped. `skippedByFilter` unchanged.
- Edges 6-8: pass filters, added to children (`children.length = 6 → breaks after 5`)
  Actually: edge 6 brings children to 4, edge 7 to 5 → break. Edges 8,9,10 never processed.
- `skippedByFilter = 0`
- `totalFiltered = 10 - 0 = 10`
- `10 > 5` → `more: count = 5`

But actually edges 4 and 5 were cycles/missing — they should NOT be counted as "hidden" callers the user could navigate to. The "more" node tells the user "5 more callers exist beyond what's shown." But edges 4 (cycle) and 5 (missing) are not actually reachable callers.

**Also consider the early-break scenario:**

- `edges.length = 8`, `MAX_BRANCHING_FACTOR = 5`
- Edges 1-5 all pass filters. `children.length = 5`. Loop breaks at edge 6 (never fetched).
- `skippedByFilter = 0`
- `totalFiltered = 8 - 0 = 8`
- `8 > 5` → `more: count = 3`

Edges 6, 7, 8 were never fetched (loop broke). Were any of them cycles? Were any test files? We don't know — and `skippedByFilter` doesn't account for them. The count `3` is an upper bound, not exact. The "more" node will show at most `3` but it could be `0` if all three remaining edges were cycles or test files.

**Verdict on ISSUE 1:** The "more" counter over-counts in the presence of cycles or missing nodes among the edges, and cannot account for unprocessed edges after early break. The displayed count is an upper bound, not a precise count. This is a correctness defect: the invariant "more.count = number of reachable, non-filtered callers beyond MAX_BRANCHING_FACTOR" is not guaranteed.

Severity: **MEDIUM** — The tree shows a "5+ more" indicator when the true count could be smaller. Not a data corruption issue, but misleads the user.

---

### ISSUE 2 [fetchCallNodes:333] — depth computation is wrong

**Location:** `callersProvider.ts`, line 333

```typescript
const depth = parentVisitedIds.size; // depth = number of ancestors visited
```

**Enumeration:**

At the section level, `fetchCallNodes` is called with `parentVisitedIds = new Set()` (line 296):

```typescript
return this.fetchCallNodes(element.direction, this.rootNode, new Set());
```

- `parentVisitedIds.size = 0`
- `newVisited = {rootNode.id}`, size = 1
- `depth = parentVisitedIds.size = 0`
- Children of root get `depth = 0`, `visitedIds = newVisited` (size 1)

When a `call-node` at depth 0 is expanded (line 304):

```typescript
return this.fetchCallNodes(element.direction, element.node, element.visitedIds);
```

- `element.visitedIds.size = 1` (contains root)
- `parentVisitedIds.size = 1`
- `newVisited = {root, parent}`, size = 2
- `depth = parentVisitedIds.size = 1`
- Children get `depth = 1`

This means:
- Root's direct children: depth = 0
- Their children: depth = 1
- Their children's children: depth = 2

**Depth boundary check in `getTreeItem` (line 211):**

```typescript
element.depth + 1 >= this.maxDepth
  ? vscode.TreeItemCollapsibleState.None
  : vscode.TreeItemCollapsibleState.Collapsed
```

With `maxDepth = 3`:
- depth=0: 0+1=1 >= 3? No → Collapsed (can expand) ✓
- depth=1: 1+1=2 >= 3? No → Collapsed (can expand) ✓
- depth=2: 2+1=3 >= 3? Yes → None (cannot expand) ✓

**Depth boundary check in `getChildren` (line 301):**

```typescript
if (element.depth + 1 >= this.maxDepth) {
  return [];
}
```

With `maxDepth = 3`, a node at depth=2 has `2+1=3 >= 3 → true → return []`.

So children at depth=0 can expand (depth becomes 1), depth=1 can expand (depth becomes 2), depth=2 cannot expand. With maxDepth=3, we see 3 levels of call-nodes (depths 0, 1, 2). This matches the intent.

**But there is an edge case:** `maxDepth = 1`.

- `setMaxDepth` clamps to `Math.max(1, ...)` so `maxDepth = 1` is valid.
- Root's direct children (depth=0): depth+1 = 1 >= 1 → None (cannot expand). Correct — only 1 level shown.

The depth enumeration is correct.

---

### ISSUE 3 [fetchCallNodes:338-339] — branching cap applied before filtering

**Location:** `callersProvider.ts`, lines 337-339

```typescript
for (const edge of edges) {
  if (children.length >= MAX_BRANCHING_FACTOR) {
    break;
  }
  ...
  if (this.hideTestFiles && isTestFile(peerFile)) {
    skippedByFilter++;
    continue;
  }
  ...
  children.push({ ... });
}
```

**The branching cap `children.length >= MAX_BRANCHING_FACTOR` is checked before filters are applied.** But children are only added after passing filters. So the cap on `children.length` is actually on the number of **accepted** (post-filter) children, which is correct.

However, the loop `break` causes all remaining edges to be unprocessed — including edges that would have been filtered. Combined with ISSUE 1, this means the "more" count is inflated by edges that would have been filtered.

**Concrete example:**
- 8 edges total. Edges 1-5 are all test files (filtered). Edges 6-8 pass filters.
- Loop processes edges 1-5: each is filtered (`skippedByFilter = 5`, `children.length = 0`).
- Edges 6-8 are processed: children becomes 3. Loop ends normally (no break).
- `totalFiltered = 8 - 5 = 3`. `3 > 5`? No. No "more" node. Correct.

Alternative:
- 8 edges. Edges 1-5 pass filters (added). Loop breaks before edge 6.
- `skippedByFilter = 0`. `totalFiltered = 8`. `8 > 5`. `more: count = 3`.
- Edges 6-8 are never inspected. Edge 6 might be a test file, so the true "more" count could be 1 or 2.
- This confirms ISSUE 1.

This is not a separate issue — it is the same root cause as ISSUE 1, documented here for completeness.

---

### ISSUE 4 [resolveCodeLens:101] — "loading" string matching is fragile

**Location:** `codeLensProvider.ts`, line 101

```typescript
if (codeLens.command && !codeLens.command.title.includes('loading')) {
  return codeLens;
}
```

**Input enumeration for `codeLens.command.title`:**

1. Placeholder lens created by `buildPlaceholderLenses`: title = `'callers: ...'` or `'callees: ...'` or `'blast: ?'`
2. Resolved lens created by `buildResolvedLenses` via `buildCommand`: title = `'N callers'` or `'N callees'` or `'blast: ?'`

None of these titles contain the string `'loading'`. The check `!title.includes('loading')` will be `true` for ALL lens titles — both placeholder and resolved. This means `resolveCodeLens` will always return the lens as-is on the first branch, without ever reaching the cache lookup below.

**Enumeration:**

- Title = `'callers: ...'`: does NOT include 'loading' → returns as-is. The cache lookup (lines 105-118) is NEVER reached.
- Title = `'5 callers'`: does NOT include 'loading' → returns as-is. Correct (already resolved).
- Title = `'blast: ?'`: does NOT include 'loading' → returns as-is. Correct (blast is always placeholder, no resolution needed).

**Result:** The `resolveCodeLens` method's cache path is dead code. The "loading" string that the guard checks for is never produced by `buildPlaceholderLenses`. The placeholders use `'callers: ...'` (three dots), not `'callers: loading'`.

**Is this a correctness defect?** The function is supposed to resolve placeholders by looking up the cache. Because the guard fails to identify placeholders, resolution never happens through `resolveCodeLens`. However, the system works because:
1. `batchFetchCounts` fires `onDidChangeCodeLenses` when done.
2. VSCode calls `provideCodeLenses` again.
3. `provideCodeLenses` now finds the cache warm and calls `buildResolvedLenses`, returning fully-resolved lenses directly.

So the system correctness is preserved by the re-render path. `resolveCodeLens` being a no-op does not cause visible errors. But it means the "resolveCodeLens optimization" is broken — VSCode will always need the full `provideCodeLenses` re-run to get real counts, rather than the lighter `resolveCodeLens` path.

**Severity:** MEDIUM — correctness of displayed counts is maintained, but the optimization path is dead. The comment on line 8-10 documents this optimization as intentional design. The implementation does not match the stated design.

---

### ISSUE 5 [batchFetchCounts:264-276] — race condition in Promise.all writes to shared `counts` Map

**Location:** `codeLensProvider.ts`, lines 264-276

```typescript
const counts = new Map<string, FunctionCounts>();

await Promise.all(funcNodes.map(async (node) => {
  try {
    const [incoming, outgoing] = await Promise.all([...]);
    counts.set(node.id, { callers: incoming.length, callees: outgoing.length });
  } catch {
    counts.set(node.id, { callers: 0, callees: 0 });
  }
}));
```

Multiple async closures write to the same `counts` Map concurrently. In JavaScript's single-threaded event loop, `Map.set` operations are atomic between `await` points — there is no interleaving within a single synchronous step. All `counts.set(node.id, ...)` calls are each one synchronous step that cannot be interrupted. Therefore the concurrent writes are safe.

**Verdict on ISSUE 5:** No race condition. The single-threaded event loop prevents true concurrent mutations. This is correct.

---

### OBSERVATION [batchFetchCounts] — reconnect clears inFlight but in-flight requests still complete

When `clientManager` emits `'reconnected'`, `this.inFlight.clear()` is called (line 42). If a `batchFetchCounts` is in progress at that moment:

1. `inFlight` is cleared.
2. The in-flight batch continues running (it has a reference to `client` from before reconnect).
3. When it completes, `this.cache.set(filePath, counts)` runs (line 279) — populating the cache with data from the OLD connection.
4. `_onDidChangeCodeLenses.fire()` triggers a re-render with stale data.

Then, the next `provideCodeLenses` call sees the cache as warm (stale data) and returns it without refetching.

**Severity:** LOW — this only happens during reconnect, and the stale cache would be from the same graph database (reconnect typically means the socket dropped and re-established). In most reconnect scenarios the data is the same. But if the database was updated between disconnect and reconnect, stale counts may be shown until the file is re-opened or the cache is manually invalidated.

The `'reconnected'` handler clears `cache` AND `inFlight` synchronously. If the in-flight batch then writes to `cache` after the clear, the cleared state is overwritten. This is a genuine race between async batch and synchronous reconnect handler.

**Enumeration of invariant violation:**
- Pre: `cache` cleared, `inFlight` cleared on reconnect
- Async batch from old connection completes: `cache.set(filePath, oldCounts)` — invariant "cache is empty after reconnect" is violated

---

## Summary Table

| # | Location | Category | Severity | Verdict |
|---|----------|----------|----------|---------|
| 1 | `fetchCallNodes:375-377` | Incorrect "more" count | Medium | REJECT |
| 2 | depth computation | Correct | — | APPROVE |
| 3 | branching cap before filter | Root cause of #1 | — | (same as #1) |
| 4 | `resolveCodeLens:101` | Dead optimization path | Medium | REJECT |
| 5 | `batchFetchCounts:264` | No race (single-thread) | — | APPROVE |
| 6 | Reconnect + in-flight batch | Stale cache possible | Low | Observation |

**Primary reject reason:** Two issues require fixes before the implementation can be considered correct.

1. `fetchCallNodes` produces an incorrect "more" count that inflates the number of unshown callers/callees by including cycle edges, missing-node edges, and unprocessed edges.

2. `resolveCodeLens` has a guard condition `!title.includes('loading')` that matches no lens title produced by this code, making the entire cache-resolution path dead. The stated design intent (two-phase: placeholder then resolve) is not implemented as described.
