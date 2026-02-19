## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

The ISSUES panel is a direct expression of the core thesis. Every item shown in the panel comes from querying ISSUE nodes in the graph — not from reading source files, not from running a linter, not from static analysis at display time. The graph IS the source of truth. The VS Code extension is a read-only window into it.

The three groups (Violations, Connectivity, Warnings) map cleanly to categories that the graph engine already produces. An AI agent using Grafema can ask "what issues exist?" and get the answer from `countNodesByType` + `queryNodes({ nodeType: 'issue:...' })`. This panel does exactly that and shows it to the human developer. That is the product vision working end-to-end.

The decision to defer "Analysis Warnings" (parse failures, skipped files) is the right call. Those events are not in the graph. Don identified this gap honestly rather than faking it with a sidecar file. This is the correct response to missing graph data: acknowledge the gap, defer it, do not work around it.

The DiagnosticCollection integration (Problems panel, squiggly underlines) is a multiplier on the value of the graph. When Grafema's graph knows about a violation, that knowledge now propagates automatically into the standard VS Code developer workflow. One source of truth, many surfaces. That is exactly right.

---

### Architecture

**Query strategy is sound.** The two-pass approach — `countNodesByType` first, then targeted `queryNodes` per known category — avoids the O(N) `getAllNodes` scan in the common case. The fallback to `getAllNodes` for unknown/plugin-defined categories is the correct extension point: new issue categories added by plugins just work, without requiring changes to the VS Code extension. This satisfies the "new plugin support requires only a new plugin" principle from the architecture checklist.

**No brute-force scan in the hot path.** `countNodesByType` is a metadata call, not a graph traversal. `queryNodes({ nodeType })` is indexed. The O(N) `getAllNodes` path is explicitly gated behind the unknown-category detection — it only runs if a plugin has introduced a category not in KNOWN_ISSUE_CATEGORIES. In practice, this path never runs. The design is O(k) where k is the number of active issue categories, not O(total nodes).

**Follows existing patterns.** The class structure mirrors `CallersProvider`: constructor injects `GrafemaClientManager`, listens to `reconnected` event, uses a cache-and-fire pattern with `_onDidChangeTreeData`, has a `refresh()` method. The `setTreeView` / `setDiagnosticCollection` injection pattern is a clean solution to the VS Code registration order constraint. The deviation from `registerTreeDataProvider` to `createTreeView` is necessary for badge support and is correctly explained.

**Separation of concerns.** The `IssuesProvider` class only knows about querying and presenting. It does not own the diagnostic collection or the tree view — it receives them as injected references. `extension.ts` owns the lifecycle of all VS Code resources. This is correct.

**The `parseNodeMetadata` call in `getChildren(section)` (line 208-209)** parses metadata twice — once in `loadIssues` (for severity classification) and again here when building issue items. This is a minor inefficiency but not a correctness issue and not an architectural flaw. The cached `metadata` on the `IssueItem` means `getTreeItem()` never re-parses, which is where it matters.

---

### One Observation (Not a Blocker)

The `fetchAllIssueNodes` method calls `getAllNodes({})` for unknown categories. In a very large codebase, this is a full graph scan. The guard (`unknownTypes.length > 0`) means this only fires when a plugin-defined issue category exists. In practice this should be rare. If it becomes a problem, the fix is to extend `countNodesByType` or `queryNodes` to support prefix matching on the server side — that is a future gap to track, not a reason to reject this implementation.

---

### Summary

This implementation serves the vision cleanly. The graph is the source of truth. The UI is a view into the graph. The query strategy is targeted, not brute-force. The architecture follows established patterns. The scope decision (defer parse-failure warnings) shows disciplined thinking about what belongs in the graph versus what does not.

Ship it.
