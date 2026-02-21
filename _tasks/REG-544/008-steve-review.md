## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK
**Query planner issue:** acceptable — does not block shipping
**Complexity:** OK

---

### Vision Alignment

The vision is "AI queries the graph, not reads code." This predicate is a direct enabler of that vision.

Before `parent_function`, to answer "which function contains this call?" an AI agent had to either: (a) read source code, or (b) write a multi-hop traversal through scope chains that is impractical to express in a single Datalog rule. The task description confirms this — the team discovered the gap while writing a guarantee for REG-541 and found it "невозможно выразить в одном Datalog правиле."

The motivating example is clean and real:

```datalog
answer(FnName) :-
  node(C, "CALL"),
  attr(C, "method", "addNode"),
  parent_function(C, F),
  attr(F, "name", FnName).
```

This closes a real graph expressiveness gap. Without this predicate, answering "what functions call X?" requires reading code or writing traversal code outside Datalog. With it, the graph is the superior way to answer a fundamental structural question about any codebase. This is exactly what we should be shipping.

---

### Architecture

Built-in predicate implemented directly in `eval.rs` and mirrored in `eval_explain.rs` is the correct choice. The alternative of a derived rule would require adding explicit edges to the graph during analysis (precomputed `parentFunctionId`) — that is premature optimization and creates coupling between the analysis pipeline and the query language. A built-in predicate is the right level of abstraction: graph structure stays clean, traversal logic stays in the evaluator.

The `utils.rs` registration (`positive_can_place_and_provides`) is properly done. Without it, the query planner falls through to the catch-all arm which treats `parent_function` as "always placeable" — meaning it would be placed before the atom that binds `NodeId`, and every query using `parent_function` with an unbound first argument would silently return empty results. The team identified this and fixed it correctly.

The duplication between `eval.rs` and `eval_explain.rs` is a pre-existing architectural pattern in this codebase — not introduced by this task. It is tech debt, but it is the established pattern and the correct action for this task is to follow it. The plan explicitly notes this and calls for a future `DatalogEvalCore` trait refactor as separate work. Acceptable.

---

### Query Planner Issue

Kent's finding: rules with 5+ atoms trigger a pre-existing query planner atom-ordering issue, so complex `checkGuarantee` rules with `parent_function` may be misreordered. The workaround is to use `datalogQuery` directly, which works correctly for all tested cases.

This does NOT block shipping. Here is why:

1. The issue is pre-existing — it exists today for other predicates with 4+ atom rules. `parent_function` did not introduce it.

2. The issue affects only `checkGuarantee` rules with 5+ atoms, and only when the atoms are written in a pathological order that the planner fails to correct. `datalogQuery` works correctly.

3. The primary use case — `node(C, "CALL"), attr(C, "method", X), parent_function(C, F), attr(F, "name", N)` — is a 4-atom query. Tests confirm this works correctly in both `datalogQuery` and `checkGuarantee`.

4. The query planner bug is independently trackable as a separate issue. Shipping `parent_function` and then filing a focused bug for the planner reorder logic is the right sequence. Blocking `parent_function` to wait for a planner fix would be a mistake — the predicate is correct, the planner bug is orthogonal.

The test design decision to use `datalogQuery` for complex examples is pragmatic, not a corner cut that hides a `parent_function` defect.

---

### Complexity

The algorithm is O(depth) BFS where depth is bounded by real-world nesting structure (MAX_DEPTH=20, practical nesting is 3-10 levels). Each hop costs one `get_incoming_edges()` call on a filtered edge type — not a scan over all graph nodes or all edges.

The PARAMETER special case is O(1) — one edge lookup, no BFS.

There is no full-scan over all nodes of any type. The predicate is invoked with a bound `NodeId` (enforced by the query planner registration), so it always starts from a specific node and walks upward. This is as efficient as the `findContainingFunction.ts` TypeScript implementation it mirrors.

Complexity: OK.

---

### Would Shipping This Embarrass Us?

No. The opposite: not shipping this would embarrass us. "Find the function containing this call" is the most basic structural question anyone asks about code. If Grafema cannot answer it in a single Datalog rule, we are asking AI agents to work around our graph. This predicate closes that gap cleanly.

The implementation is thorough: handles all function-like node types (all are stored as FUNCTION), handles the PARAMETER edge direction asymmetry, handles VARIABLE via DECLARES, correctly stops at MODULE and CLASS boundaries, mirrors `findContainingFunction.ts` exactly, and registers properly with the query planner. Dijkstra's three HIGH-severity gaps from the first review are all addressed in the revised plan.

Ship it.
