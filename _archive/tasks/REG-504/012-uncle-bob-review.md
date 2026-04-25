# REG-504: Uncle Bob (Clean Code) Review

**Reviewer:** Robert Martin (Uncle Bob)
**Date:** 2026-02-19
**Files reviewed:**
- `packages/rfdb-server/src/datalog/utils.rs` — new reorder_literals() and helpers
- `packages/rfdb-server/src/datalog/eval.rs` — modified methods (eval_query, eval_rule_body)
- `packages/rfdb-server/src/datalog/eval_explain.rs` — modified methods (eval_query, eval_rule_body)
- `packages/rfdb-server/src/bin/rfdb_server.rs` — call sites
- `packages/rfdb-server/src/datalog/tests.rs` — new reorder tests

---

## Summary

The implementation is clean, well-structured, and disciplined. It follows existing patterns, stays in scope, and the algorithm is clearly communicated. There are two issues to address: a structural duplication in `positive_can_place_and_provides` and a missing predicate in `eval_explain.rs`. Both are concrete, fixable findings.

---

## utils.rs — New Functions

### `reorder_literals` (lines 102–134)

**Length:** 32 lines. Good.
**Nesting:** 2 levels max. Good.
**Naming:** `bound`, `result`, `remaining`, `pos` — all clear and intention-revealing.
**Algorithm clarity:** Greedy topological sort, well-commented. The three-state loop (`remaining`, `bound`, `result`) communicates intent cleanly. The early-exit pattern on `None` (stuck case) is correct and readable.

One minor observation: calling `literal_can_place_and_provides` twice on the selected literal (lines 109 and 116) is a consequence of not storing the result in the closure. This is an intentional trade-off given `Literal: Clone` and the simplicity of the closure. Acceptable. If this becomes hot code, one refactoring would be to return the `provides` set directly from `position()`, but that is premature here.

**Verdict:** Clean.

### `literal_can_place_and_provides` (lines 138–155)

**Length:** 17 lines. Good.
**Naming:** Self-explanatory.
**Dispatch:** Clean delegation to `positive_can_place_and_provides` and inline for negative. The negative literal semantics (requires all args bound, provides nothing) are correctly encoded and commented.

**Verdict:** Clean.

### `positive_can_place_and_provides` (lines 158–262)

**Length:** 104 lines. This is the largest new function, and it has a structural issue.

**ISSUE 1 — Duplication: `incoming` and `path` branches are identical code.**

Lines 213–229 (`incoming`) and lines 231–247 (`path`) are character-for-character identical except for the comment. Both:
- Guard on `args.is_empty()`
- Call `is_bound_or_const(&args[0], bound)` for `can_place`
- Iterate `args.iter().skip(1)` to collect free vars into `provides`

This is textbook duplication. The rule: same pattern 3 times = extract helper. Two is already a violation when the copies are this exact. The correct pattern is a shared helper `requires_first_bound(args, bound)` or folding both arms into `"incoming" | "path"`.

The fix is a single line: `"incoming" | "path" =>` with the shared body. This is a straightforward mechanical change with zero behavioral risk.

**Other branches:** `node`, `edge`, `attr`, `attr_edge`, `neq`/`starts_with`/`not_starts_with`, `_` — each is distinct and correct. The `attr_edge` branch (lines 189–207) correctly models its 5-arg constraint (first 4 must be bound, 5th is the provided value variable). This is precise.

**Free-variable helpers `is_bound_or_const` and `free_vars`:** Both are minimal, single-purpose functions with clear names. Good.

**Verdict on `positive_can_place_and_provides`:** REJECT due to `incoming`/`path` duplication. Fix: merge into `"incoming" | "path" => { ... }`.

---

## eval.rs — Modified Methods

### `eval_query` (lines 134–175)

**Length:** 42 lines. Within limit.
**Change:** Single added line: `let ordered = reorder_literals(literals)?;` followed by iteration over `&ordered` instead of `literals`. This is the correct minimal-footprint integration pattern. The `?` propagation is clean.

The loop body is unchanged. The comment on `eval_query` was updated to document the reordering behavior. The doc comment accurately describes what happens.

**Verdict:** Clean.

### `eval_rule_body` (lines 801–842)

**Length:** 42 lines. Within limit.
**Change:** Same single-line addition: `let ordered = reorder_literals(rule.body())?;` with `?` propagation. The error is surfaced via `eprintln!` in `eval_derived` — an appropriate degraded-graceful pattern (log and skip the broken rule rather than aborting the entire query).

The comment "Reorders body literals before evaluation to ensure correct variable binding order" is precise.

**Verdict:** Clean.

### Duplication between `eval_query` and `eval_rule_body`

Both methods contain identical literal-evaluation loops (lines 138–172 and 805–839 respectively). This pre-existing duplication is noted here but was flagged as pre-existing tech debt in PREPARE and is explicitly out of scope for this task. No action required.

---

## eval_explain.rs — Modified Methods

### `eval_query` (lines 158–197)

**Change:** Same pattern: `reorder_literals(literals)?;` then iterate `&ordered`. Clean. The reset sequence (`stats`, `explain_steps`, `step_counter`, `predicate_times`) before evaluation is correct — prevents contamination from prior calls.

**Verdict:** Clean.

### `eval_rule_body` (lines 782–819)

**Change:** Same single-line addition. Clean. Error propagation same as eval.rs. Correct.

**Verdict:** Clean.

### ISSUE 2 — Missing `attr_edge` dispatch in `EvaluatorExplain::eval_atom`

`eval.rs` line 185 dispatches `"attr_edge"` to `eval_attr_edge`. `eval_explain.rs` line 264–274 (`eval_atom`) has no `"attr_edge"` arm — it falls through to `eval_derived`, which will silently return empty results for `attr_edge` queries in explain mode.

This is a pre-existing gap (not introduced by REG-504), but REG-504 adds `reorder_literals` to `eval_explain.rs::eval_query` and `eval_rule_body`, which means explain-mode queries containing `attr_edge` will now be correctly ordered but still silently fail to evaluate `attr_edge`. The reordering makes the gap more visible and reachable.

**REG-504 did not introduce this gap** — it predates this task. However, since this review must decide approve/reject based on what is delivered, and since the task description says "Readability and clarity" and "Code matches existing patterns", the pattern divergence between `eval.rs` and `eval_explain.rs` is a legitimate finding.

**Severity:** Medium. `attr_edge` in explain mode silently returns empty instead of erroring. A user querying `attr_edge(..., V)` in explain mode would get no results and no error — pure silent failure.

**Recommendation:** File as a follow-on issue (REG-5xx). The fix is adding an `eval_attr_edge` method to `EvaluatorExplain` mirroring `eval.rs`. This is out of scope for REG-504 but must be tracked.

---

## rfdb_server.rs — Call Sites

Four call sites were checked (lines 1854, 1858, 1920, 1924). Each follows the same pattern:
```rust
let bindings = evaluator.eval_query(&literals)?;
```
The `?` propagation is correct — parsing errors and circular dependency errors surface to the caller cleanly. The error path ends in a protocol error response, which is the right behavior.

No changes in logic, no new complexity. Clean integration.

**Verdict:** Clean.

---

## Tests

### Unit tests in `reorder_tests` mod (utils.rs lines 2110–2188)

- `test_reorder_empty_input` (0a) — Covers empty input. Correct.
- `test_reorder_already_correct_order` (0b) — Verifies order preservation when already valid.
- `test_reorder_wrong_order_fixed` (0c) — Tests the core reordering logic directly against the function. This is the right level of unit test.
- `test_reorder_circular_dependency_returns_err` (0d) — Tests the error path and asserts on message content. Good. The `assert!(err_msg.contains("circular"), ...)` pattern with a helpful failure message is clean.

Four focused, independent, well-named unit tests. Each has a comment identifying what it is testing.

### Integration tests (tests.rs lines 2192–2519)

`setup_reorder_test_graph` is a well-designed fixture. The graph deliberately encodes the necessary variety: nodes of different types, edges forming paths (1->3->4), names with "handle" prefix and without. The fixture comments explain what each node is for.

- Tests 1–8 follow a consistent pattern: "wrong order" vs "correct order" should produce identical results. This is the right framing — it tests invariant behavior, not implementation detail.
- Test 5 (multi-variable chain) is the most thorough — a 4-predicate chain reordered from reverse.
- Test 6 (neq) and Test 7 (rule body) cover constraint predicates and derived rules respectively.
- Test 8 (incoming) is important: it tests the `incoming` predicate specifically, which is one of the predicates classified as "requires first arg bound" in `positive_can_place_and_provides`.

**Test naming:** All test names follow `test_reorder_<scenario>` convention. Clear and consistent.

**Test comments:** Each test has a brief intent comment ("Test N: ..."). Good.

**Assertion messages:** Most `assert_eq!` calls include a descriptive string. Where they don't (e.g., `assert_eq!(result.len(), 2)`), the test name provides sufficient context.

**Minor observation:** Tests 1, 2, 5, 8 verify only count equality and value equality between wrong/correct orderings. They don't verify that reordering actually happened (i.e., that the wrong-order input was indeed reordered). This is fine — the unit tests in `reorder_tests` mod cover the reordering function directly. The integration tests correctly focus on observable behavior.

**Verdict on tests:** Clean.

---

## Forbidden Patterns

- No `TODO`, `FIXME`, `HACK`, `XXX` found.
- No commented-out code found.
- No empty implementations (`return null`, `{}`).
- No `mock`/`stub`/`fake` outside tests.

---

## Method-Level Checklist Summary

| Method | Length | Params | Nesting | Issues |
|--------|--------|--------|---------|--------|
| `reorder_literals` | 32 | 1 | 2 | None |
| `literal_can_place_and_provides` | 17 | 2 | 2 | None |
| `positive_can_place_and_provides` | 104 | 2 | 3 | **Duplication: incoming/path** |
| `is_bound_or_const` | 6 | 2 | 1 | None |
| `free_vars` | 6 | 2 | 1 | None |
| `eval.rs::eval_query` | 42 | 1 | 3 | None |
| `eval.rs::eval_rule_body` | 42 | 1 | 3 | None |
| `eval_explain.rs::eval_query` | 40 | 1 | 3 | None |
| `eval_explain.rs::eval_rule_body` | 38 | 1 | 3 | None |

---

## Required Fixes

### Fix 1 (REQUIRED — Clean Code violation): Merge `incoming` and `path` branches

In `positive_can_place_and_provides`, lines 213–247 in `utils.rs`:

```rust
// Current: two identical branches
"incoming" => { /* identical body */ }
"path" => { /* identical body */ }

// Fix:
"incoming" | "path" => {
    // first arg (dst or src) must be bound; remaining args are provided
    if args.is_empty() {
        return (true, HashSet::new());
    }
    let can_place = is_bound_or_const(&args[0], bound);
    let mut provides = HashSet::new();
    if can_place {
        for arg in args.iter().skip(1) {
            if let Term::Var(v) = arg {
                if !bound.contains(v) {
                    provides.insert(v.clone());
                }
            }
        }
    }
    (can_place, provides)
}
```

### Fix 2 (TRACK — Pre-existing gap surfaced by this task): `attr_edge` missing from `EvaluatorExplain::eval_atom`

Create a follow-on Linear issue to add `eval_attr_edge` to `EvaluatorExplain`. This is not a blocker for REG-504 merge, but must not be forgotten.

---

## Verdict

**REJECT**

Fix 1 is a mandatory clean code requirement — identical 15-line blocks are a DRY violation. The fix is a one-line change (`"incoming" | "path" =>`). Resubmit after applying it.

Fix 2 does not block this review but a Linear issue should be filed before closing REG-504.
