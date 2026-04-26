## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

"Did you mean" suggestions are a direct enabler of the core thesis. An AI agent writing `node(X, "FUNCTON")` gets silence today — no results, no clue why. With this feature it gets an immediate, actionable course correction: `Did you mean: FUNCTION?` The agent iterates in one shot instead of two or three. That's the graph becoming more usable, not less.

The feature is strictly additive — it activates only on zero-result queries and only when the query contains type literals. It never fires on legitimate empty results with no typed predicates. That's the right boundary condition.

### Architecture

**`extractQueriedTypes()`** is a pure regex function — no I/O, no state, O(predicates in query). Clean.

**`findSimilarTypes()`** iterates over `availableTypes`. The input is `Object.keys(countNodesByType())` or `Object.keys(countEdgesByType())` — those return aggregated counts, not full node scans. The key space is bounded by the taxonomy of the codebase (dozens to low hundreds of distinct types in practice, not millions). O(k) where k is distinct types. Not a scan.

**Lazy fetch in `handleQueryGraph()`:** Edge counts are only fetched when the query actually contains edge type literals (`edgeCounts = edgeTypes.length > 0 ? await db.countEdgesByType() : {}`). Node counts are always fetched on zero-result (to show total graph size in the footer anyway). Tight.

**CLI duplication:** `queryHints.ts` is an acknowledged copy of the MCP logic. The comment is explicit about why (dependency direction: CLI cannot import @grafema/mcp) and flags the maintenance obligation. This is the right call — the alternative (a shared package for two small functions) would be over-engineering. The note is honest and the risk is low.

**One real observation, not a blocker:** The `countNodesByType()` call happens unconditionally on every zero-result path (line 57 in query-handlers.ts) regardless of whether `hasQueriedTypes` is true. It's used at the end to render the "Graph: N nodes" footer. That call costs one DB round-trip on every empty query. In the context of a graph tool it's negligible, but if this becomes a hotspot it's the one line to revisit. Not blocking — the feature is correct as written.

**Tests:** The test suite covers `extractQueriedTypes` exhaustively (node, edge, `incoming`, multi-predicate, no false positives for `attr`, unquoted variables, the excluded `type()` predicate, empty input). `findSimilarTypes` cases cover exact match, case-only mismatch, typo at distance 1, distance > 2, and empty available list. Integration tests wire through the real DB. Coverage is solid.

### Summary

This is a small, focused feature that makes the graph meaningfully more useful to agents. No scope creep, no new subsystems, no workarounds. It fits cleanly into the existing query handler path. Ship it.
