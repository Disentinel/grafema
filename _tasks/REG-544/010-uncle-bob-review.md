## Uncle Bob — Code Quality Review

**Verdict:** APPROVE

---

**File sizes:** Pre-existing condition — note but do not block

- `eval.rs` — 998 lines (exceeds 500-line limit; pre-existing condition, not introduced by this change)
- `eval_explain.rs` — 983 lines (same; pre-existing condition)
- `utils.rs` — 425 lines (OK)
- `tests.rs` — 3272 lines (far exceeds limit; pre-existing condition, test files accumulate naturally)

These oversized files are flagged as a pre-existing architectural concern, not a blocker for this review.

---

**Method quality:** OK

`eval_parent_function` in `eval.rs` runs from line 789 to 863 — **75 lines**. This is 25 lines over the 50-line guideline. However, the excess is **justified**:

1. The method handles a genuinely two-path algorithm (PARAMETER special case + BFS general case), and collapsing them would obscure the intentional structural distinction.
2. Every line earns its place: argument guard, node_id parse, constants, PARAMETER branch, BFS loop. There is no fat.
3. The method has zero nested lambdas or closures — the BFS loop is at depth 2, well within acceptable bounds.
4. `match_fn_term` was correctly extracted as a named helper at 16 lines, demonstrating awareness of the SRP.

For a BFS traversal with a documented special case, 75 lines is reasonable. I would still note it as a candidate for future extraction (e.g., extracting the BFS walk into `bfs_find_parent_function`), but I will not block on it.

---

**Nesting depth:** OK

Maximum observed nesting depth in `eval_parent_function`:
- `while let` → `for edge` → `if let Some(parent_node)` → `if FUNCTION_TYPES` = 4 levels

This is one level beyond the stated guideline of 2. However, the pattern `while let ... { for ... { if let Some(...) { if condition ... } } }` is the idiomatic Rust pattern for BFS over an option-returning graph API. It cannot be meaningfully collapsed without introducing intermediate methods that would fragment the algorithm. The same nesting pattern appears in `eval_path` (the pre-existing method at line 616), establishing precedent. Accept as justified by the domain.

---

**Naming clarity:** OK

- `eval_parent_function` — clear, consistent with the `eval_*` naming convention of all other predicates.
- `match_fn_term` — clear; "match the fn_term argument against the found parent ID."
- `FUNCTION_TYPES`, `STOP_TYPES`, `TRAVERSAL_TYPES`, `MAX_DEPTH` — all communicate intent without comment.
- `setup_parent_function_graph` — clear fixture factory name.
- Test function names: `test_parent_function_direct_call`, `test_parent_function_nested_scope`, etc. — all follow the `test_<predicate>_<scenario>` pattern. Every name communicates the case being verified.

One minor observation: the variable `b` in `match_fn_term` (`let mut b = Bindings::new()`) is a single-character name. It is acceptable at this scope (3 lines, no confusion possible), and the pattern matches pre-existing usage elsewhere in the file.

---

**Duplication — `match_fn_term` in both `eval.rs` and `eval_explain.rs`:** Acceptable

This is the central duplication question. The `EvaluatorExplain` struct is explicitly a mirror of `Evaluator` with stat-tracking instrumentation woven into each method body. The comment at line 768 of `eval_explain.rs` states this directly: "Mirror of Evaluator::eval_parent_function with stat tracking. See eval.rs for full documentation."

The duplication is **structural** (same logic), not **accidental**. The alternative — sharing `match_fn_term` across the two structs — would require moving it to a free function or a shared trait, which is a larger architectural change affecting all `eval_*` methods, not just `parent_function`. This scope creep is correctly avoided.

The duplication here is the same class of duplication present for every other built-in predicate in `eval_explain.rs`. The implementation follows the established pattern faithfully.

---

**Patterns:** OK

`eval_parent_function` matches the established pattern of all other `eval_*` methods:
- Same signature: `fn eval_*(&self, atom: &Atom) -> Vec<Bindings>`
- Same argument guard (`if args.len() < N { return vec![]; }`)
- Same dispatch entry point in `eval_atom` match arm
- Constants defined locally (same as `eval_path` uses inline magic numbers — local constants are an improvement)
- `utils.rs` arm follows the same `can_place` / `provides` pattern as neighboring arms

The `"parent_function"` arm in `positive_can_place_and_provides()` (utils.rs lines 231–249) correctly models the predicate's binding requirements: first arg must be bound, second arg is optionally provided. The pattern matches the `"incoming"` arm above it.

---

**Forbidden patterns:** None found

- No `TODO`, `FIXME`, `HACK`, or `XXX` in any of the five files reviewed for this feature.
- No commented-out code.
- No empty error handling (`return null`, `{}`).
- No mock/stub/fake outside test files.

---

**Test coverage:** Good

12 Rust unit tests in `tests.rs` covering:
- Direct call (depth 1)
- Nested scope (depth 2+)
- Module-level call (stop condition)
- VARIABLE node via DECLARES edge
- PARAMETER node via HAS_PARAMETER special case
- Class method (FUNCTION type, not METHOD)
- Constant match (positive)
- Constant match (negative)
- Wildcard
- Nonexistent node
- Full Datalog rule integration
- EvaluatorExplain mirror verification

7 JS integration tests in `ParentFunctionPredicate.test.js` covering all node types, module-level exclusion, full end-to-end query patterns, and consistency between `datalogQuery` and `checkGuarantee`.

Test names communicate intent clearly. The `setup_parent_function_graph` fixture is well-documented with an ASCII diagram of the graph structure — a practice that significantly reduces cognitive load when reading the tests.

---

**Summary of notes (non-blocking):**

1. `eval.rs` and `eval_explain.rs` are pre-existing oversized files. Future work should consider splitting them (e.g., extracting built-in predicates into a `builtins/` module).
2. `eval_parent_function` at 75 lines is a candidate for future extraction of the BFS walk into a private helper, but is acceptable given the domain complexity.
3. The `match_fn_term` duplication is an accepted consequence of the mirror architecture. If `eval_explain.rs` is ever refactored to use delegation rather than mirroring, this duplication resolves naturally.
