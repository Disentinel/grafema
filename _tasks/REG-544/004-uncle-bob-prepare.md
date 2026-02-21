# Uncle Bob PREPARE Review: REG-544

**Date:** 2026-02-21
**Author:** Robert Martin (Uncle Bob)
**Phase:** PREPARE — review files we will directly touch before implementation begins

---

## Uncle Bob PREPARE Review: `packages/rfdb-server/src/datalog/eval.rs`

**File size:** 883 lines — MUST SPLIT (>300 line limit)

**Methods to modify:**
- `eval_atom()` — lines 178–191, **14 lines**. The match dispatch table. Adding one arm (`"parent_function" => self.eval_parent_function(atom),`) is a one-liner. No structural change.
- `eval_parent_function()` — **new method**, ~100 lines per the plan's code snippet (lines 202–301 of the plan). This is the bulk of the work.
- `match_fn_term()` — **new helper method**, ~20 lines per the plan. Extracted from the plan to avoid duplication between PARAMETER case and BFS case.

**File-level:** The file is already 883 lines, which exceeds the 300-line threshold. However, this is a pre-existing violation — the file was already over-limit before this task. The plan correctly adds only focused, cohesive new code (one predicate implementation + its helper). Splitting the file is out of scope for this task per the Root Cause Policy and the explicit PREPARE-phase constraint.

**Method-level:**
- `eval_atom()` modification is trivial: one new match arm, one line. No concern.
- `eval_parent_function()` at ~100 lines is above the 50-line candidate-for-split threshold. However, the method has a clear single responsibility (evaluate the `parent_function` predicate) and its structure is inherently sequential: guard check → PARAMETER special case → BFS loop. The length is driven by essential complexity (constants, inline comments explaining the algorithm, three distinct cases), not accidental complexity. Splitting it would create artificial helpers with no reuse value.
- `match_fn_term()` at ~20 lines is well within limits.
- Nesting depth in `eval_parent_function()`: the BFS `while let` loop contains a `for edge in edges` loop containing an `if let Some(parent_node)` block containing an `if/else if/else` chain. That is 4 levels of nesting inside the method body. Acceptable — mirrors the `eval_path()` BFS pattern already in the file.
- Parameter count: `eval_parent_function(&self, atom: &Atom)` — 2 parameters (self + atom). Fine.
- `match_fn_term(fn_term: &Term, parent_id: u128)` — 2 parameters. Fine. Note: this is a static method (`fn`, not `&self`), consistent with it being a pure projection helper.

**Recommendation:** SKIP refactoring. Proceed with implementation as planned.

**Risk:** LOW. `eval_atom()` modification is a one-line addition to an existing match. New methods are isolated. No existing methods are structurally altered.

---

## Uncle Bob PREPARE Review: `packages/rfdb-server/src/datalog/eval_explain.rs`

**File size:** 873 lines — MUST SPLIT (>300 line limit)

**Methods to modify:**
- `eval_atom()` — lines 274–293, **20 lines**. The instrumented dispatch table. Adding one arm (`"parent_function" => self.eval_parent_function(atom),`) is a one-liner. No structural change.
- `eval_parent_function()` — **new method**, ~120 lines (identical to eval.rs version plus stat-tracking lines per plan section "Gap V4"). Above the 50-line candidate threshold.
- `match_fn_term()` — **new helper method**, ~20 lines. Same as in eval.rs (same static helper, duplicated by the established pattern).

**File-level:** 873 lines, pre-existing violation. Same situation as eval.rs. The duplication between eval.rs and eval_explain.rs is documented tech debt (noted explicitly in the plan, Gap V4). Deduplication belongs in a separate task. Not a blocker for this task.

**Method-level:**
- `eval_atom()` modification: one new match arm. Trivial.
- `eval_parent_function()` in eval_explain.rs will be ~120 lines because it must add stat tracking calls (`self.stats.get_node_calls += 1`, `self.stats.nodes_visited += 1`, `self.stats.incoming_edge_calls += 1`, `self.stats.edges_traversed += edges.len()`, `self.stats.bfs_calls += 1`). This pushes it further over the 50-line threshold. The additional lines are mechanical stat instrumentation, not logic complexity — consistent with how all other predicates are instrumented in this file (e.g., `eval_node`, `eval_edge`, `eval_path` are all 60-80 lines each in eval_explain.rs due to stat lines).
- Nesting depth: same as eval.rs. Acceptable.
- Parameter count: `eval_parent_function(&mut self, atom: &Atom)` — `&mut self` required (for stat updates) + atom. Fine.

**One flag for the implementer:** `eval_atom()` in eval_explain.rs currently takes `&mut self` (line 274), whereas in eval.rs it takes `&self`. The new `eval_parent_function` in eval_explain.rs must also be `&mut self` to update `self.stats`. This is consistent with all other predicate methods in eval_explain.rs (they are all `&mut self`). The implementer should not accidentally declare `eval_parent_function` as `&self` in eval_explain.rs.

**Recommendation:** SKIP refactoring. Proceed with implementation as planned.

**Risk:** LOW. The `&mut self` consistency requirement is a straightforward convention already established in the file.

---

## Uncle Bob PREPARE Review: `packages/rfdb-server/src/datalog/utils.rs`

**File size:** 407 lines — MUST SPLIT (>300 line limit). However, 139 lines (lines 267–407) are `#[cfg(test)]` test code within the same file. The production-logic portion is lines 1–266 = 266 lines, which is within limits.

**Methods to modify:**
- `positive_can_place_and_provides()` — lines 158–247, **90 lines**. The match dispatch for query planning. Adding one new match arm before the catch-all `_`.

**File-level:** The file has inline tests in `#[cfg(test)]`. The production logic is under 300 lines. No structural concern.

**Method-level:**
- `positive_can_place_and_provides()` is 90 lines, which exceeds the 50-line candidate-for-split threshold. However, this is a pre-existing condition — it was 90 lines before REG-544. The new `"parent_function"` arm adds ~16 lines, taking the method to ~106 lines. The method is a match dispatch table where each arm handles one predicate. This is the canonical Rust pattern for predicate dispatch; splitting the match would not improve clarity.
- The `"parent_function"` arm structure (16 lines) is nearly identical to the `"incoming" | "path"` arm (lines 213–230, 18 lines). The pattern is consistent and readable.
- Parameter count: `(atom: &Atom, bound: &HashSet<String>)` — 2 parameters. Fine.
- Nesting depth inside the new arm: `if args.is_empty()` → early return; then `if can_place` block containing `if let Some(arg)` containing `if let Term::Var(v)` containing `if !bound.contains(v)`. That is 4 levels inside the arm. Acceptable — identical structure to the existing `"attr"` arm.

**Recommendation:** SKIP refactoring. Proceed with implementation as planned.

**Risk:** LOW. The change is additive: one new match arm before the `_` catch-all, following an established pattern. No existing arms are modified.

---

## Uncle Bob PREPARE Review: `packages/rfdb-server/src/datalog/tests.rs`

**File size:** 2704 lines — CRITICAL (far exceeds 300-line limit)

**Methods to modify:**
- `setup_test_graph()` — lines 372–458, **87 lines**. This function is NOT directly modified. A new `setup_parent_function_graph()` will be added inside the new `mod parent_function_tests` submodule.
- No existing test methods are modified. The plan adds a new `mod parent_function_tests` block containing 12 new test functions and one new setup function.

**File-level:** 2704 lines is far beyond any reasonable single-file limit. This is a pre-existing violation — the file grew organically as tests were added. The existing structure uses nested `mod` blocks (e.g., `mod eval_tests`, `mod reorder_tests` inside `mod eval_tests`) to organize tests. The new `mod parent_function_tests` follows this established pattern and does not worsen the structural situation.

The `eval_tests` module spans lines 366–2704 (the end of the file) = **2338 lines**. This module contains all evaluator tests including `mod reorder_tests` (a submodule at line 2160). Adding `mod parent_function_tests` inside `eval_tests` is consistent with how `reorder_tests` was added.

**Method-level:**
- `setup_parent_function_graph()` (new): estimated ~100 lines based on the graph described in the plan (8 nodes, ~10 edges, each requiring a `NodeRecord` struct). This is a test helper, not production code. Test helper length is less critical than production method length, but 100 lines is notable. The helper is unavoidably long because RFDB requires fully specified `NodeRecord` and `EdgeRecord` structs — there is no builder API.
- Each test function: estimated 10-20 lines. All 12 tests are within limits.
- Total addition: ~350-400 lines of new test code.

**One observation (not blocking):** The `setup_test_graph()` pattern in `eval_tests` builds the graph inline with full `NodeRecord` structs. The new `setup_parent_function_graph()` must follow the same pattern for consistency. The implementer should match the `NodeRecord` field layout exactly (note the slightly inconsistent indentation of `semantic_id: None` on line 391 vs other fields — this is a pre-existing style quirk, not introduced by REG-544).

**Recommendation:** SKIP refactoring. The file size is a pre-existing violation. Adding the new module follows the established pattern and does not make the situation meaningfully worse. A dedicated test file split is a separate tech debt task.

**Risk:** LOW. No existing test functions are modified. New code is isolated in a new submodule.

---

## Summary

| File | Lines | Status | Methods Touched | Risk |
|------|-------|--------|-----------------|------|
| `eval.rs` | 883 | MUST SPLIT (pre-existing) | `eval_atom` (+1 line), `eval_parent_function` (new ~100L), `match_fn_term` (new ~20L) | LOW |
| `eval_explain.rs` | 873 | MUST SPLIT (pre-existing) | `eval_atom` (+1 line), `eval_parent_function` (new ~120L), `match_fn_term` (new ~20L) | LOW |
| `utils.rs` | 407 (266 prod) | OK (prod logic) | `positive_can_place_and_provides` (+16 lines, now ~106L total) | LOW |
| `tests.rs` | 2704 | CRITICAL (pre-existing) | No existing methods modified; new `mod parent_function_tests` added | LOW |

**All violations are pre-existing.** REG-544 does not introduce new structural debt; it follows established patterns throughout. No refactoring is required before proceeding to implementation.

**One actionable flag for the implementer:**
In `eval_explain.rs`, ensure `eval_parent_function` is declared `fn eval_parent_function(&mut self, atom: &Atom)` (with `&mut self`) to allow stat counter updates. Do not accidentally copy the `&self` signature from `eval.rs`.
