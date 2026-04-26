# Вадим auto — Completeness Review: REG-544

**Date:** 2026-02-21
**Reviewer:** Вадим auto (Completeness Reviewer)

---

## Verdict: APPROVE

---

## Feature Completeness: OK

### Does `parent_function(C, F)` work for CALL nodes? YES

Implementation in `eval.rs` at line 789 handles CALL nodes via the standard BFS path. The BFS traverses incoming `CONTAINS` / `HAS_SCOPE` / `DECLARES` edges upward. CALL nodes are reached by SCOPE via `CONTAINS`, so the traversal walks `CALL <-[CONTAINS]- SCOPE <-[HAS_SCOPE]- FUNCTION`. Verified by `test_parent_function_direct_call` (CALL(30) → FUNCTION(10)) and `test_parent_function_nested_scope` (CALL(31) via multi-hop SCOPE chain → FUNCTION(10)).

### Does it work for VARIABLE nodes (DECLARES edge)? YES

`TRAVERSAL_TYPES = &["CONTAINS", "HAS_SCOPE", "DECLARES"]` includes `DECLARES`. The path `VARIABLE <-[DECLARES]- SCOPE <-[HAS_SCOPE]- FUNCTION` is correctly traversable. Verified by `test_parent_function_variable_node` (VARIABLE(40) → FUNCTION(10)). The JS integration test suite also tests this (`node(V, "VARIABLE"), parent_function(V, F), attr(F, "name", N)`).

### Does it work for PARAMETER nodes (HAS_PARAMETER special case)? YES

The implementation has a pre-BFS check: if the input node type is `"PARAMETER"`, it calls `get_incoming_edges(node_id, Some(&["HAS_PARAMETER"]))` and reads `edge.src` as the parent FUNCTION directly. This is O(1) — no BFS needed. The edge direction is correct: `FUNCTION(src) -[HAS_PARAMETER]-> PARAMETER(dst)`, so `get_incoming_edges(PARAMETER, ...)` returns the FUNCTION as src. Verified by `test_parent_function_parameter_node` (PARAMETER(50) → FUNCTION(10)) and the JS integration test (`node(P, "PARAMETER"), parent_function(P, F), ...`).

### Does it correctly return empty for module-level nodes? YES

When BFS from CALL(60) finds `MODULE(1)` as its parent, `MODULE` is in `STOP_TYPES = &["FUNCTION", "METHOD", "MODULE", "CLASS"]` and the predicate returns `vec![]`. Verified by `test_parent_function_module_level_returns_empty`. The JS integration test verifies that `allCalls.length > callsWithParent.length` (module-level call is excluded).

### Does `eval_explain.rs` mirror exist (Gap 3 from Dijkstra)? YES

`eval_explain.rs` has `"parent_function" => self.eval_parent_function(atom)` at line 286 and a full mirrored `eval_parent_function(&mut self, ...)` implementation at line 770 with stat tracking (`get_node_calls`, `nodes_visited`, `incoming_edge_calls`, `edges_traversed`, `bfs_calls`). Verified by `test_parent_function_explain_evaluator` which checks `result.bindings[0].get("F") == Some(&"10")` AND that `result.explain_steps` is non-empty, confirming the predicate ran through the dispatch and not through `eval_derived`.

### Does `utils.rs` query planner case exist? YES

`"parent_function"` arm was added to `positive_can_place_and_provides()` at line 231, before the catch-all `_` arm. It correctly requires `args[0]` (NodeId) to be bound and provides `args[1]` (FunctionId) if it is a free variable. Without this, the planner could misorder atoms and place `parent_function` before the atom that binds NodeId, producing empty results.

### Does the example from the task work?

The task example: `attr(C, "method", "addNode"), parent_function(C, F), attr(F, "name", FnName)` — this requires NodeId `C` to be bound by `attr(C, "method", "addNode")` first. With the `utils.rs` planner fix in place, `C` is bound before `parent_function` is evaluated. The implementation correctly handles this ordering. The structurally equivalent query `node(C, "CALL"), parent_function(C, F), attr(F, "name", Name)` is tested end-to-end in `test_parent_function_in_datalog_rule` and in the JS integration tests (`should find functions that call console.log`, `should find functions that call greet()`).

---

## Test Coverage: OK

### Rust unit tests (12/12): meaningful and complete

All 12 tests in `mod parent_function_tests` are behavioral assertions, not just smoke tests:
- Tests 1–2: specific node IDs with exact expected parent ID (`Value::Id(10)`)
- Test 3: empty result for module-level (asserts `len() == 0`)
- Tests 4–5: VARIABLE and PARAMETER cases with expected IDs (verifying gap fixes)
- Test 6: class method stored as FUNCTION type (verifying Gap 4)
- Tests 7–9: const/const match, const mismatch, wildcard — all with precise assertions
- Test 10: non-existent node → empty
- Test 11: end-to-end Datalog rule through `eval_query`, asserting exact output `["myFunc", "myFunc", "myMethod"]` (sorted)
- Test 12: `EvaluatorExplain` path checked with both result correctness and `explain_steps` non-empty

The graph fixture in `setup_parent_function_graph()` is correctly constructed: 13 nodes, 11 edges, class method uses `node_type: "FUNCTION"` (not `"METHOD"`) per `ClassVisitor.ts:358`. Module-level CALL(60) is connected `MODULE(1) -[CONTAINS]-> CALL(60)`, which correctly hits the STOP_TYPES check.

### JS integration tests (10/10): meaningful

Tests exercise real fixture analysis (`01-simple-script/index.js`) with actual graph database queries. They test:
- Direct `datalogQuery` for CALL/VARIABLE/PARAMETER node types
- `checkGuarantee` for rule-based queries
- Module-level exclusion (total CALL count vs. count with parent)
- Full predicate composition (`attr(C, "name", "console.log"), parent_function(C, F), attr(F, "name", FName)`)
- Consistency between direct and rule-based evaluation

Kent's note about the query planner limitation with 5+ atom rules is honest and accurate — the workaround (using `datalogQuery` instead of `checkGuarantee` for the complex "full example" tests) is pragmatic given this is a pre-existing issue, not introduced by REG-544.

---

## Commit Quality: ISSUE (minor — does not warrant REJECT)

The changes are **not committed**. `git status` shows all four Rust files (`eval.rs`, `eval_explain.rs`, `tests.rs`, `utils.rs`) as unstaged modifications, plus `test/unit/ParentFunctionPredicate.test.js` and `_tasks/REG-544/` as untracked. The current branch is `task/REG-532` (a different task), and there is no `task/REG-544` branch.

The task is complete from a functionality and test standpoint, but Rob did not commit the work. This means:
- No commit message to evaluate for atomicity or clarity
- Changes live on the wrong branch (REG-532)

This is a workflow issue, not a correctness issue. The implementation itself is complete and correct. A commit should be created on a `task/REG-544` branch before PR creation.

---

## Summary

| Check | Status |
|-------|--------|
| `parent_function` for CALL nodes | OK |
| `parent_function` for VARIABLE nodes (DECLARES) | OK |
| `parent_function` for PARAMETER nodes (HAS_PARAMETER) | OK |
| Empty for module-level nodes | OK |
| `eval_explain.rs` mirror (Gap 3) | OK |
| `utils.rs` query planner case | OK |
| Task example query works | OK |
| Rust tests meaningful (12 tests) | OK |
| JS integration tests meaningful (10 tests) | OK |
| Changes committed on correct branch | NOT DONE |

**Feature completeness:** Full. All acceptance criteria from the task and Don's plan are satisfied.

**Test coverage:** Full. Both Rust unit tests and JS integration tests are meaningful, cover all node types (CALL, VARIABLE, PARAMETER, module-level), all term modes (Var, Const/match, Const/no-match, Wildcard), and the `eval_explain.rs` path.

**Commit quality:** Cannot evaluate — changes are uncommitted and on the wrong branch (`task/REG-532` instead of `task/REG-544`). This must be resolved before PR creation.

**Final verdict: APPROVE with one required action before PR — create and commit on `task/REG-544` branch.**
