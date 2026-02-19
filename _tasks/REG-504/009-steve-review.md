# REG-504: Steve Jobs Vision Review
**Reviewer:** Steve Jobs (Vision Reviewer)
**Date:** 2026-02-19
**Status:** APPROVE

---

## Vision Alignment

This is exactly the right feature to build. Grafema's thesis is that AI should query the graph, not read code. A Datalog interface where users have to manually order predicates to avoid wrong results is an embarrassment — it makes the query language a trap for anyone who doesn't know the evaluator's internals. Fixing predicate ordering at the evaluator level is the correct level of abstraction. Users write what they mean; the evaluator figures out the right order. This is vision-aligned.

---

## Complexity Check

`reorder_literals` is O(n²) where n = number of literals in a rule body. Each outer iteration scans the remaining list to find a placeable literal. In practice, Datalog rule bodies have 3–10 literals. O(n²) on n=10 is 100 operations. This is not a concern. The algorithm is correct and the complexity is negligible.

There is one minor inefficiency: `literal_can_place_and_provides` is called **twice** per placed literal — once inside the `position()` closure to find the index, and once after removal to get the `provides` set. Given the trivial n, this is not a problem in practice. But it is slightly inelegant. This does not rise to a blocking issue.

---

## Architecture Assessment

### What's right

1. **Placement in utils.rs is correct.** The function is pure, has no graph dependency, and belongs alongside `get_metadata_value` as a shared evaluator utility.

2. **Error boundary at `eval_derived` is correct.** The decision to propagate `Result` from `eval_query` and `eval_rule_body`, but absorb errors at `eval_derived`, is sound. Ad-hoc queries written by AI agents get proper errors. User-defined rules that are malformed fail silently on that rule only, not the entire query. The `eprintln!` provides visibility.

3. **`query()` and `eval_atom()` signatures unchanged.** The NAPI `check_guarantee` path is unaffected. No hidden blast radius.

4. **All four call sites in rfdb_server.rs updated cleanly with `?`.** No manual error string construction, no inconsistency.

5. **`eval_explain.rs` returns `Result<QueryResult, String>`, not `Result<Vec<Bindings>, String>`.** The plan explicitly called this out (B2) and the implementation respects it.

6. **`Wildcard` treated as bound in `is_bound_or_const`.** This is correct — wildcards are anonymous constants, not unbound variables.

### One real issue: `attr_edge` missing from `eval_explain.rs::eval_atom()`

The plan explicitly notes: "Do NOT touch the pre-existing `attr_edge` absence in `eval_explain.rs::eval_atom()` — out of scope."

I verified this is true — `eval_explain.rs::eval_atom()` has no `"attr_edge"` arm. The `reorder_literals` function correctly classifies `attr_edge` as needing src/dst/etype/name to be bound. So the reordering logic for `attr_edge` is **implemented correctly** — but when `eval_explain.rs` actually evaluates the query, `attr_edge` will fall through to `eval_derived`, find no rules, and return empty.

This is a **pre-existing bug, not introduced by this PR**. The plan correctly identifies it as out of scope. I agree. But I want it on record: REG-504 correctly handles the reordering classification for `attr_edge`, meaning when the eval bug is eventually fixed, the ordering will already work.

---

## Test Coverage

The test coverage is good and covers the right scenarios:

- **Tests 0a–0d** in `reorder_tests` mod test the pure function directly — empty, already-correct order, wrong order, and circular dependency. These are the right unit tests.
- **Tests 1–8** cover the full integration: attr-before-node, negation-before-positive, already-correct order is stable, circular error propagation, multi-variable chain (node→attr→edge→attr), neq constraints, rule body reordering, and incoming-with-unbound-dst.
- Existing test call sites correctly updated to `.unwrap()`.

The test graph (`setup_reorder_test_graph`) has the right structure to exercise all these cases.

**One gap I notice:** There is no test that sends a query with an `attr_edge` literal in wrong order through `eval_query`. Given `attr_edge` is absent from `eval_explain.rs`, this would expose the pre-existing bug. The plan correctly excludes this, so it's not a blocking issue for this PR.

---

## Would shipping this embarrass us?

No. The implementation is clean, the algorithm is correct, the error handling is principled, the tests are thorough, and the plan was revised to address all of Dijkstra's blocking issues. The code reads simply and does exactly what it says.

---

## APPROVE
