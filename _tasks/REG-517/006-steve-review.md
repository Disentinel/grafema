## Steve Jobs — Vision Review

**Verdict:** APPROVE (with one structural note)

---

**Vision alignment:** OK

The core thesis is "AI should query the graph, not read code." These four features serve that thesis directly. They make the graph *more navigable*, not more readable as code. Every one of the four improvements — better labels, exported badge in search, edge type filtering, bookmarks — is about helping a user (human or AI agent) move through the graph efficiently. That is exactly the right direction.

The exported flag surfacing is particularly on-point: it signals graph topology (what is visible at module boundary) without requiring the user to open a file. That is the graph being the source of truth, not the code. Good.

---

**Architecture:** OK, with one concern on edge filtering

**Feature 1 — Improved node labels (`formatNodeLabel`, `formatFilePath`)**

Clean. `formatNodeLabel` returns `NODE_TYPE "name"` and `formatFilePath` returns last 2 path segments. Both are pure functions in `types.ts` and `edgesProvider.ts` respectively. Zero complexity. O(1). The exported badge appended to `item.description` in `getTreeItem` is a one-liner. Nothing to object to.

**Feature 2 — Search label improvement (exported badge in QuickPick)**

In `openSearchNodes` in `extension.ts` line 709:
```typescript
const exportedTag = node.exported ? ' [exported]' : '';
```
This is one string append per result. The result set is already capped at `SEARCH_MAX_RESULTS = 50`. O(50) worst case. Fine.

**Feature 3 — Edge type filter**

This is the feature to scrutinize on the complexity check.

The filter list is a hardcoded constant `COMMON_EDGE_TYPES` (14 types). The QuickPick shows these 14 items — O(14), not O(all edge types in the graph). That is acceptable.

The filtering happens in `buildEdgeItems` at line 435:
```typescript
if (this.hiddenEdgeTypes.has(edge.edgeType)) continue;
```

This runs over the edges of a *single node's* outgoing/incoming edges — not over all edges in the graph. Set lookup is O(1). So the filter is O(edges of current node), which is exactly right. No global scan.

The concern: the 14 edge types are hardcoded in `extension.ts` (lines 445-449). If the graph has domain-specific edge types that aren't in this list, they cannot be filtered. They will always show up and cannot be hidden. This is a product gap, not a correctness bug. It means the feature is incomplete at the edges of the schema, but it is not architecturally wrong. The right fix later would be to fetch actual edge types from the graph (a `getEdgeTypes()` API call), but the hardcoded list is a reasonable v1 approximation. Not a reason to reject.

**Feature 4 — Bookmarks**

Bookmarks are stored as `WireNode[]` in `workspaceState`. The data model is correct: we store graph node objects, not file paths or source references. When the user clicks a bookmark, we navigate to location from node metadata — not by re-reading source. This is graph-first storage.

Complexity: `addBookmark` does `this.bookmarks.some()` — O(MAX_BOOKMARKS = 20). `removeBookmark` does `filter` — O(20). Trivially bounded.

The `loadBookmarks` safety check (line 548) is good defensive code:
```typescript
if (Array.isArray(stored)) {
  this.bookmarks = stored as WireNode[];
}
```

One structural note: bookmarks are stored as full serialized `WireNode` objects. If the graph is re-analyzed and node IDs change, bookmarks become stale — the stored node objects will point to outdated data. This is an accepted limitation for a v1 implementation, and the workspaceState persistence model makes sense given VSCode's architecture. Noted but not a blocker.

**Command organization**

The `registerCommands()` function in `extension.ts` is now 324 lines and handles commands for Explorer, ValueTrace, Callers, BlastRadius, Issues, and the status bar. This is accumulating debt. It is a single flat function with all commands for all panels. At some point this needs to be decomposed per-panel. But that is pre-existing debt from Phase 4, not introduced by Phase 5. Scope of this review is the four Phase 5 features.

**Toolbar icon count**

The Explorer panel toolbar now has 8 icons (indices navigation@0 through navigation@7). This is approaching saturation for a toolbar. Users may not discover `filterEdgeTypes` (navigation@6) buried at position 7. Consider whether some commands belong in a "..." overflow or context menu instead. Minor UX note, not a reject.

---

**Would we be proud to ship this?**

Yes. The four features are small, correct, and coherent with the product vision. The implementation is conservative — no new abstractions, no new node types, no new graph queries for the filtering itself. The exported flag in labels is a genuine usability improvement that reinforces the "graph is the source of truth" thesis. The bookmarks feature is practical and stored correctly as graph data.

The hardcoded edge type list is the only thing that could come back to embarrass us — if a user opens a large legacy codebase with custom edge types (the exact target audience) and cannot filter them. That should be a follow-up issue.

**Ship it.**
