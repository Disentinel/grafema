# REG-504: Вадим auto (Completeness) Review

**Reviewer:** Вадим auto
**Date:** 2026-02-19
**Files reviewed:**
- `packages/rfdb-server/src/datalog/utils.rs`
- `packages/rfdb-server/src/datalog/eval.rs` (lines 1-10, 120-175, 768-842)
- `packages/rfdb-server/src/datalog/eval_explain.rs` (lines 1-15, 140-197, 750-819)
- `packages/rfdb-server/src/bin/rfdb_server.rs` (eval_query call sites)
- `packages/rfdb-server/src/datalog/tests.rs` (all reorder tests + existing call sites)

---

## AC-by-AC Verification

### AC1: Evaluator auto-reorders literals so predicates with unbound variables come after those that bind them
**PASS.** `reorder_literals()` in `utils.rs` implements a correct greedy topological sort. Both `eval.rs::eval_query`, `eval.rs::eval_rule_body`, `eval_explain.rs::eval_query`, and `eval_explain.rs::eval_rule_body` call `reorder_literals()` at entry before executing any literals. The predicate-specific `can_place` logic in `literal_can_place_and_provides()` covers all predicates in the evaluator: `node`, `attr`, `attr_edge`, `edge`, `incoming`, `path`, `neq`, `starts_with`, `not_starts_with`, `Negative`, and unknown (safe fallback).

### AC2: Negation (`\+`) always comes after all positive literals that bind its variables
**PASS.** `Literal::Negative` branch in `literal_can_place_and_provides()` requires ALL Var args to be in `bound` before placing. Wildcard terms (`Term::Wildcard`) satisfy the condition unconditionally, which is correct — they don't need binding. Tests 0b-0c and Test 2 cover this directly.

### AC3: Order not changed if already correct (zero overhead)
**PASS.** The algorithm is greedy and picks the first already-placeable literal at each step. If literals are already in valid order, each iteration selects `remaining[0]` — same order is preserved. The overhead is one linear pass through `remaining` per literal (O(n^2) worst case, but no extra allocations beyond the output Vec). Test 3 (`test_reorder_already_correct_order_still_works`) explicitly verifies correct results for already-ordered input. Test 0b verifies order preservation in the pure-function unit test.

### AC4: Circular dependency produces a clear error
**PASS.** When no literal can be placed (all `can_place = false`), `reorder_literals` returns `Err("datalog reorder: circular dependency, cannot place: [...]")`. The error message contains "circular dependency". Tests 0d and Test 4 both assert `result.is_err()` and `err_msg.contains("circular")`.

The error propagates cleanly:
- `eval_query()` propagates via `?`
- `eval_rule_body()` propagates via `?`
- `eval_derived()` catches the error at the boundary (logs + `continue`), keeping its `Vec<Bindings>` return type
- `rfdb_server.rs` call sites use `?` within `Result<DatalogResponse, String>` functions — the error reaches the wire correctly

### AC5: Tests confirm wrong-order query gives same result as correct-order query
**PASS.** Tests 1, 2, 5, 6, 8 all follow the pattern: construct wrong-order and correct-order queries, run both, assert equal lengths and equal bound values. The test graph (`setup_reorder_test_graph`) is well-constructed with: 3 CALL nodes (ids 1, 2, 5 with distinct names), 1 FUNCTION node (id 3), 1 queue:publish node (id 4), and "calls" edges (1→3, 3→4). All test assertions are non-trivial (verified against expected counts).

---

## Edge Cases and Correctness

**`attr` `can_place` logic (plan N4 incorporated):** Both `id` (args[0]) AND `attr_name` (args[1]) must be Const or in bound. This correctly prevents scanning the entire attribute store with an unbound name. `provides` is only the value variable (args[2]) when free — correct.

**`path` with Const first arg:** `is_bound_or_const(&args[0], bound)` → true → always placeable. `provides` collects remaining free args (just the dst arg for a 2-arg path). Correct.

**`incoming` with unbound dst:** `is_bound_or_const(&args[0], bound)` → false when dst is unbound Var → cannot place. Requires binding first. Test 8 covers this.

**`edge` always placeable:** Correct — the evaluator handles full scans for edge when src is unbound. It provides all free variable args.

**Double `literal_can_place_and_provides` call:** The implementation calls `literal_can_place_and_provides` twice per selected literal — once for the `can_place` check, once for `provides`. This is a minor inefficiency but not a correctness issue. It is acceptable for the current scope (plan section 5 says no cost-based optimization).

**`eval_derived` error boundary:** Both `eval.rs` and `eval_explain.rs` implement the same boundary pattern correctly: `match self.eval_rule_body(rule) { Ok(b) => b, Err(e) => { eprintln!(...); continue; } }`. The `eprintln!` is appropriate for a server-side log.

---

## Test Quality

**Unit tests (0a-0d):** Located in `mod reorder_tests` inside `mod eval_tests` in `tests.rs`. Cover: empty input, already-correct order, wrong-order fix, circular dependency. All test the pure function directly without a database. These are the most targeted tests.

**Integration tests (1-8):** All 8 planned tests are implemented. Coverage includes:
- Simple 2-predicate reorder (test 1)
- Negation ordering (test 2)
- Zero-change path (test 3)
- Circular error from `eval_query` (test 4)
- Multi-variable chain (test 5)
- Constraint predicates (test 6)
- Rule body reordering (test 7)
- `incoming` with unbound dst (test 8)

**Existing `eval_query` call sites:** All 12 call sites in `tests.rs` were updated to add `.unwrap()`. Verified by grep — no bare `evaluator.eval_query(&...)` without `.unwrap()` exists.

**`rfdb_server.rs` call sites:** All 4 call sites correctly use `?` operator.

---

## Scope Creep Check

The change is tightly scoped:
- `utils.rs`: new functions `reorder_literals`, `literal_can_place_and_provides`, `is_bound_or_const`, `free_vars` added at bottom. No existing code modified.
- `eval.rs`: `eval_query` and `eval_rule_body` return types changed to `Result`. `eval_derived` error boundary added. `use super::utils::reorder_literals` import added. No other changes.
- `eval_explain.rs`: same pattern as `eval.rs`. No other changes.
- `rfdb_server.rs`: `?` added at 4 call sites. No other changes.
- `tests.rs`: `.unwrap()` added to existing call sites + new test block.

No forbidden patterns found (`TODO`, `FIXME`, `HACK`, `XXX`, commented-out code).

---

## One Concern (Non-Blocking)

**Test 5 reorder result vs "correct order" comment:** The test comment says the correct reorder of `attr(Dst,"name",L), edge(X,Dst,"calls"), attr(X,"name",N), node(X,"CALL")` should be `node(X,"CALL"), attr(X,"name",N), edge(X,Dst,"calls"), attr(Dst,"name",L)`. But the greedy algorithm will actually pick `edge(X,Dst,"calls")` first (it's always-placeable) rather than `node(X,"CALL")`. The test does NOT assert the specific reordered sequence — it only asserts that results match. This is correct behavior: there can be multiple valid orderings, and the test is checking semantic equivalence, not a specific permutation. The comment is slightly misleading but the test itself is sound.

---

## Summary

All 5 acceptance criteria are fully implemented and tested. The algorithm is correct, the error handling matches the plan exactly (B1, B2, B3 all addressed), the test suite covers happy paths and failure modes, and there is no scope creep or forbidden code.

**APPROVE**
