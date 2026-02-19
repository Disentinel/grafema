## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Assessment

This feature is a GUI surface on top of the graph. The question is: does the GUI surface query the graph, or does it read code?

It queries the graph. Every piece of data shown — callers, callees, call counts in CodeLens — comes from `getIncomingEdges`, `getOutgoingEdges`, `getAllNodes`. No file reading, no regex, no AST parsing in the extension. The graph is the sole source of truth. That is exactly what Grafema is supposed to be.

---

### Vision Alignment

The feature demonstrates the vision correctly. A developer opens a file, and instead of manually tracing calls through source code, the CALLERS panel and CodeLens display the answer instantly from the graph. "Who calls this?" is answered by a graph query, not by grep. This is the thesis made visible.

The CodeLens is particularly well-targeted: it puts graph-derived counts directly in the editor where developers already read code — turning the editing surface into a graph query result viewer. That is vision alignment at the UX level.

The decision to reject `vscode.CallHierarchyProvider` in favor of a custom `TreeDataProvider` is correct. `CallHierarchyProvider` is language-server-coupled. Grafema's graph is independent of language servers. Using the LSP API would have meant pretending Grafema is a language server, which it is not. The custom tree keeps Grafema's data model sovereign.

---

### Architecture

**Graph-first, no shortcuts.** The implementation makes exactly the graph calls that should be made — edge traversal for hierarchy, `getAllNodes({ file })` for CodeLens batch loading. There is no in-extension analysis, no pattern matching against file contents. This is the right shape.

**Lazy loading for hierarchy.** Loading callers on demand per expand is the correct call. Eager loading of a full call graph is `O(nodes * edges)` and would be catastrophic on any non-trivial codebase. Lazy loading bounded by `MAX_BRANCHING_FACTOR` and `maxDepth` keeps query complexity proportional to what the user actually looks at.

**CodeLens batch pattern is correct.** The two-phase approach — placeholder on cold open, batch fetch, cache, re-render on warm — is the right tradeoff. The alternative (blocking `provideCodeLenses` on N sequential RPCs) would produce visible lag on every file open. Parallelizing N edge-count queries per file in the background is correct.

**Cycle detection.** The `visitedIds` Set carried on each `call-node` item prevents infinite traversal on mutual recursion. This is the same pattern used by `EdgesProvider`. Consistency is good.

**MAX_BRANCHING_FACTOR imported from `traceEngine`.** One constant, one definition. Not duplicated. Correct.

---

### Issues Worth Noting (Not Blockers)

**The `totalFiltered` count calculation has a subtle error.** In `fetchCallNodes`:

```typescript
const totalFiltered = edges.length - skippedByFilter;
if (totalFiltered > MAX_BRANCHING_FACTOR) {
  children.push({ kind: 'more', count: totalFiltered - MAX_BRANCHING_FACTOR });
}
```

`edges.length - skippedByFilter` gives the count of edges that passed the filter. But `children.length` stops at `MAX_BRANCHING_FACTOR` (the break fires when `children.length >= MAX_BRANCHING_FACTOR`). After the break, the loop does not finish counting `skippedByFilter` for the remaining edges. So `totalFiltered` is undercounted when filters would have removed some of the edges after the cap point. The "N+ more" number could be off.

This is an edge case in the UX — the count is approximate, and the `more` label already signals truncation rather than an exact remaining count. It does not affect correctness of the feature (no wrong data is shown, no crash). It is a UX precision issue, not an architectural one. For Phase 2 this is acceptable. Flag it for cleanup.

**`findAndSetCallersAtCursor` runs on every cursor movement, in addition to `findAndSetRoot` and `findAndTraceAtCursor`.** Three concurrent graph lookups on every debounced selection change. Each is a `findNodeAtCursor` call followed by more queries. The `setRootNode` guards against same-node re-fetch (`if node.id === this.rootNode.id: return`), which is the critical optimization. This is correct. The debounce at 150ms is appropriate.

**Test file pattern matching is hardcoded string patterns in the extension.** This is a known concern for the Grafema vision — ideally "is this a test file?" would be a graph property, not a string match. However, that requires the analyzer to classify nodes as test/non-test and store it in the graph. Until that gap is closed, client-side pattern matching is the honest fallback. The patterns are defined in one place and are reasonable. This is not a regression — it is the correct response to a graph coverage gap.

---

### Final Call

The implementation follows the architecture, follows the plan, uses the graph as its data source, and applies sensible performance bounds. The `visitedIds`-based cycle detection and the `MAX_BRANCHING_FACTOR` cap mean this does not brute-force on large codebases. The CodeLens batch pattern is production-quality.

No fundamental architectural gaps. No shortcuts that compromise the vision. Ship it.
