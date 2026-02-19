# REG-504: Kent Beck Test Report
# Datalog Query Reordering — Tests

**Author:** Kent Beck (Test Engineer)
**Date:** 2026-02-19
**Status:** Tests written, awaiting Rob's implementation to compile

---

## Summary

Two categories of changes made to `packages/rfdb-server/src/datalog/tests.rs`:

### Part 1: Updated Existing Call Sites (B3)

Updated **10 existing `eval_query()` call sites** to append `.unwrap()`, matching the new `Result` return type:

| Line (approx) | Evaluator Type | Context |
|----------------|----------------|---------|
| 1358 | `Evaluator` | `test_eval_query_single_atom` |
| 1371 | `Evaluator` | `test_eval_query_conjunction` |
| 1424 | `Evaluator` | `test_eval_query_attr_value_binding` |
| 1485 | `Evaluator` | `test_eval_query_attr_with_filter` |
| 1500 | `Evaluator` | `test_eval_query_with_negation` |
| 1909 | `EvaluatorExplain` | `test_explain_eval_query_produces_steps` |
| 1923 | `EvaluatorExplain` | `test_explain_eval_query_no_explain_empty_steps` |
| 1951 | `Evaluator` | `test_explain_bindings_match_plain_evaluator` |
| 1956 | `EvaluatorExplain` | `test_explain_bindings_match_plain_evaluator` |
| 1985 | `EvaluatorExplain` | `test_explain_stats_populated` |

### Part 2: New Tests Added

**12 new test functions** added at the end of `mod eval_tests`.

#### Unit tests (nested `mod reorder_tests`, 4 tests)

These import `reorder_literals` from `crate::datalog::utils` and test the pure function directly with no graph setup:

| Test | What it verifies |
|------|-----------------|
| `test_reorder_empty_input` (0a) | `reorder_literals(&[])` returns `Ok(vec![])` |
| `test_reorder_already_correct_order` (0b) | `[node(X,"CALL"), attr(X,"name",V)]` preserved as-is |
| `test_reorder_wrong_order_fixed` (0c) | `[attr(X,"name",V), node(X,"CALL")]` reordered to node-first |
| `test_reorder_circular_dependency_returns_err` (0d) | `[attr(X,"n",Y), attr(Y,"n",X)]` returns `Err` containing "circular" |

#### Integration tests (8 tests)

These use a dedicated `setup_reorder_test_graph()` helper with 5 nodes (3 CALL, 1 FUNCTION, 1 queue:publish) and 2 edges forming a chain `1->3->4`:

| Test | What it verifies |
|------|-----------------|
| `test_reorder_attr_before_node_gives_same_results` (1) | `attr(X,"name",N), node(X,"CALL")` matches correct order results |
| `test_reorder_negation_before_positive_gives_same_results` (2) | `\+ path(X,_), node(X,"queue:publish")` matches correct order |
| `test_reorder_already_correct_order_still_works` (3) | Correct order returns expected 3 CALL nodes with names |
| `test_reorder_circular_dependency_returns_err` (4) | `eval_query` returns `Err` for circular attr dependencies |
| `test_reorder_multi_variable_chain` (5) | 4-literal chain in wrong order matches correct order |
| `test_reorder_constraint_predicates_after_bindings` (6) | `neq(X,Y)` before `node` bindings produces same 6 pairs |
| `test_reorder_rule_body` (7) | Rule with `attr` and `starts_with` before `node` still finds 2 results |
| `test_reorder_incoming_with_unbound_dst` (8) | `incoming(X,Src,"calls")` before `node(X,"FUNCTION")` reordered correctly |

---

## Design Decisions

1. **Separate `setup_reorder_test_graph()`** rather than reusing `setup_test_graph()` -- the reorder tests need specific node types (CALL, FUNCTION) and edge types ("calls") to exercise the full reordering pipeline. Keeps test intent clear.

2. **Comparison strategy for integration tests**: Run wrong-order and correct-order queries, sort bound values, assert equality. This is order-independent and robust against non-deterministic iteration.

3. **Test 4 uses manual `Literal` construction** instead of `parse_query()` because the pathological pattern `attr(X,"k",Y), attr(Y,"k",X)` requires precisely constructed circular deps that are clearer when built explicitly.

4. **Test 7 uses `evaluator.query()` (not `eval_query`)** to exercise rule body reordering through `eval_derived -> eval_rule_body`, matching the actual production code path.

---

## Compilation Note

These tests will NOT compile until Rob completes the implementation:
- `reorder_literals` does not exist yet in `utils.rs`
- `eval_query()` still returns `Vec<Bindings>` (not `Result`)
- `eval_rule_body()` still returns `Vec<Bindings>` (not `Result`)

This is expected per TDD: tests written first, implementation follows.
