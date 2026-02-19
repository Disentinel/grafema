# REG-504: Dijkstra Re-Verification
# Datalog Query Reordering — Bound Variables First

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-19
**Status:** Re-Verification

---

## Checking Each Blocking Issue and Non-Blocking Improvement

**B1 (Error cascade):** Addressed. The Revision Note and Section 2 now explicitly state the error boundary stops at `eval_derived`. The plan specifies that `eval_derived` catches `Err` from `eval_rule_body` internally, logs it, and continues — keeping its return type `Vec<Bindings>`. Section 3.2 shows the exact match pattern to use. Section 2 explicitly confirms `eval_atom()` and `query()` keep their current return types unchanged. The cascade concern is resolved.

**B2 (EvaluatorExplain return type):** Addressed. The Revision Note and Section 2 explicitly call out that `EvaluatorExplain::eval_query` is NOT parallel to `Evaluator::eval_query`. Section 3.3 explicitly states the new signature is `Result<QueryResult, String>`. The signature table in Section 2 lists it verbatim. The implementation note says "Do NOT change the inner `QueryResult` construction logic." The ambiguity is eliminated.

**B3 (Existing test call sites):** Addressed. Section 3.5 now opens with a bold "B3" instruction that explicitly scans `mod eval_tests` for all existing `eval_query` call sites and updates each to `.unwrap()` the result. The before/after code is shown. The instruction to do this before adding new tests is explicit and correct.

**N2 (reorder_literals unit tests):** Addressed. Section 4 now opens with Tests 0a–0d, which are pure-function unit tests for `reorder_literals` requiring no database: empty input, already-correct order, wrong order, and circular dependency. These directly test the algorithm independent of the evaluator.

**N4 (attr_name in can_place):** Addressed. The predicate table in Section 1 now reads: `attr(id, name, val)` — `can_place` when `id is Const or id_var in bound AND name is Const or name_var in bound`. The `attr_name` requirement is now explicit in the can_place column.

---

## VERDICT: APPROVE

All three blocking issues are resolved with sufficient precision. Both non-blocking improvements are incorporated. The revised plan is now implementable without ambiguity.
