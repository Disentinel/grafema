# Kent Beck Test Report: REG-544

**Date:** 2026-02-21
**Author:** Kent Beck (Test Engineer)
**Phase:** STEP 3 — test writing for `parent_function` Datalog predicate

---

## Summary

Added 12 tests in a `mod parent_function_tests` block inside the `eval_tests` module in `packages/rfdb-server/src/datalog/tests.rs`. All tests compile and pass.

**Note:** The `parent_function` predicate implementation already exists in both `eval.rs` (line 789) and `eval_explain.rs`. The tests serve as behavioral verification of the existing implementation, confirming correctness across all specified scenarios.

---

## Graph Setup Pattern

A dedicated `setup_parent_function_graph()` helper builds a graph with 13 nodes and 11 edges, following the exact pattern established by `setup_test_graph()` and `setup_reorder_test_graph()` in the same file:

```
MODULE(id=1)
  -[CONTAINS]-> FUNCTION(id=10, name="myFunc")
    -[HAS_SCOPE]-> SCOPE(id=20)
      -[CONTAINS]-> CALL(id=30, method="doSomething")
      -[CONTAINS]-> SCOPE(id=21)       // nested if-block
        -[CONTAINS]-> CALL(id=31)      // nested call
      -[DECLARES]-> VARIABLE(id=40)
    -[HAS_PARAMETER]-> PARAMETER(id=50, name="x")
  -[CONTAINS]-> CALL(id=60)            // module-level call

CLASS(id=2)
  -[CONTAINS]-> FUNCTION(id=11, name="myMethod")
    -[HAS_SCOPE]-> SCOPE(id=22)
      -[CONTAINS]-> CALL(id=32)
```

All `NodeRecord` fields match the existing pattern:
- `file_id: 0`, `name_offset: 0`, `version: "main".into()`, `exported: false`
- `replaces: None`, `deleted: false`, `metadata: None`, `semantic_id: None`
- Class method uses `node_type: "FUNCTION"` (not `"METHOD"`) per ClassVisitor.ts:358

---

## Tests Written (12 total)

| # | Test Name | What It Verifies | Result |
|---|-----------|-----------------|--------|
| 1 | `test_parent_function_direct_call` | CALL(30) in function body SCOPE(20) -> FUNCTION(10) | PASS |
| 2 | `test_parent_function_nested_scope` | CALL(31) in nested SCOPE(21) -> FUNCTION(10) via multi-hop BFS | PASS |
| 3 | `test_parent_function_module_level_returns_empty` | CALL(60) at module level -> empty (MODULE is STOP_TYPE) | PASS |
| 4 | `test_parent_function_variable_node` | VARIABLE(40) via DECLARES edge -> FUNCTION(10) (Gap 1 fix) | PASS |
| 5 | `test_parent_function_parameter_node` | PARAMETER(50) via HAS_PARAMETER -> FUNCTION(10) (Gap 2 fix) | PASS |
| 6 | `test_parent_function_class_method_call` | CALL(32) in class method -> FUNCTION(11) (Gap 4: FUNCTION not METHOD) | PASS |
| 7 | `test_parent_function_constant_fn_id_match` | `parent_function(30, "10")` -> one empty Bindings (const match) | PASS |
| 8 | `test_parent_function_constant_fn_id_no_match` | `parent_function(30, "999")` -> empty (wrong const) | PASS |
| 9 | `test_parent_function_wildcard` | `parent_function(30, _)` -> one empty Bindings (wildcard) | PASS |
| 10 | `test_parent_function_nonexistent_node` | `parent_function("99999", F)` -> empty (node does not exist) | PASS |
| 11 | `test_parent_function_in_datalog_rule` | Full Datalog rule end-to-end via `eval_query` with `add_rule` | PASS |
| 12 | `test_parent_function_explain_evaluator` | Same as #1 but through `EvaluatorExplain` (Gap 3 fix) | PASS |

---

## Test Details

### Test 11 (Datalog rule integration)

Uses `parse_rule` + `add_rule` + `query` pattern (same as `test_guarantee_all_variables_assigned`):

```datalog
answer(Name) :- node(C, "CALL"), parent_function(C, F), attr(F, "name", Name).
```

Expects 3 results: `["myFunc", "myFunc", "myMethod"]` — one for each CALL node with a parent function. CALL(60) at module level correctly produces no result.

### Test 12 (EvaluatorExplain)

Uses `EvaluatorExplain::new(&engine, true)` with `&mut self` (consistent with eval_explain.rs conventions). Verifies:
1. `result.bindings.len() == 1` — correct result count
2. `result.bindings[0].get("F") == Some(&"10".to_string())` — correct function ID (note: EvaluatorExplain returns `HashMap<String, String>`, not `Bindings`)
3. `result.explain_steps` is non-empty — confirms the predicate went through `eval_atom` dispatch, not silently fell through to `eval_derived`

---

## Compilation

- `cargo test --no-run` succeeds with no new warnings (only pre-existing warnings about unused imports in `writer.rs` and dead code in `segment.rs`)
- `cargo test parent_function` runs all 12 tests successfully: `test result: ok. 12 passed; 0 failed`
- No structural or import errors

---

## Gap Coverage Verification

| Gap | Test(s) | Status |
|-----|---------|--------|
| Gap 1 (DECLARES traversal) | #4 `test_parent_function_variable_node` | Covered |
| Gap 2 (PARAMETER special case) | #5 `test_parent_function_parameter_node` | Covered |
| Gap 3 (eval_explain.rs mirror) | #12 `test_parent_function_explain_evaluator` | Covered |
| Gap 4 (CLASS method as FUNCTION) | #6 `test_parent_function_class_method_call` | Covered |
