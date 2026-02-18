## Dijkstra Re-verification

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-18
**Reviewing:** `005-plan-revision.md` — fixes for Gaps 1, 2, 3, 4, 5, 6

---

**Verdict:** APPROVE

---

**Gap 1:** RESOLVED — The revision adds `eval_query(&mut self, literals: &[Literal]) -> QueryResult` to `EvaluatorExplain`. The implementation shown correctly mirrors `Evaluator::eval_query` (iterate literals, positive/negative branching, binding merge) while wrapping with explain tracking infrastructure (`query_start`, `stats`, `explain_steps`, `step_counter`, `predicate_times` reset). `substitute_atom` is confirmed at line 764 of `eval_explain.rs` — no port needed. Both internal paths in `execute_datalog` (rules path via `query(&atom)`, direct-query path via `eval_query(&literals)`) can now use `EvaluatorExplain` as a drop-in.

**Gap 2:** RESOLVED — JSDoc comment added to overloads documenting that `explain` must be the literal `true` for return type narrowing. Low severity, documentation-only fix, adequate.

**Gap 3:** RESOLVED — `WireExplainResult` is now a single object with `bindings: Vec<HashMap<String, String>>`, `stats`, `profile`, and `explain_steps` at the top level. The response variant is `ExplainResult(WireExplainResult)` (not `Vec<WireExplainResult>`). The TypeScript `DatalogExplainResult` maps 1:1 to Rust `QueryResult`. The JS client overload now returns `Promise<DatalogExplainResult>` (single object) for the explain path, not an array. This is semantically correct and eliminates the N-times duplication. The non-explain overload still returns `DatalogResult[]` — existing callers unchanged.

**Gap 4:** RESOLVED — Regression test added to Step 4: `checkGuarantee without explain still returns violations correctly`. This guards against the refactoring accidentally breaking the non-explain `violations` key path.

**Gap 5:** RESOLVED — The explain path in the MCP handler calls `checkGuarantee(query, true)` and passes the result to `formatExplainOutput`, which iterates `explainSteps` and renders raw `key=value` binding pairs. No `.find()` on bindings. The non-explain path is untouched. The two code paths are fully separated — no possibility of format confusion.

**Gap 6:** RESOLVED — D1 is removed. D2 is the sole governing design decision: non-explain responses return unchanged `Violations`/`DatalogResults` variants; `ExplainResult` is only sent when `explain=true`.

**New concerns:** None. The revised plan is consistent, the structural issues are corrected, and the implementation order is sound (Rust eval_query first, then protocol, then type definitions, then JS layers).
