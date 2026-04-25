# REG-504: Uncle Bob STEP 2.5 Prepare Review
# Datalog Query Reordering

**Author:** Robert Martin (Uncle Bob)
**Date:** 2026-02-19
**Status:** APPROVED — proceed to implementation

---

## Files Reviewed

1. `packages/rfdb-server/src/datalog/utils.rs` (231 lines)
2. `packages/rfdb-server/src/datalog/eval.rs` (868 lines)
3. `packages/rfdb-server/src/datalog/eval_explain.rs` (843 lines)
4. `packages/rfdb-server/src/bin/rfdb_server.rs` (4831 lines)

---

## File-Level Assessment

### utils.rs (231 lines) — CLEAN

Well within the 500-line limit. Single responsibility: utility helpers for metadata value extraction. The new `reorder_literals()` and `literal_can_place_and_provides()` functions fit the module's stated purpose ("Shared utilities for Datalog evaluation"). No pre-implementation refactoring needed.

### eval.rs (868 lines) — OVER LIMIT, note as tech debt

868 lines exceeds the 700-line critical threshold. However, the file has a coherent single responsibility: the Datalog evaluator. The excess is structural: each `eval_*` method is individually straightforward but there are many built-in predicates. Splitting is out of scope for this task — noted as tech debt below.

**Verdict:** Note as tech debt. No action required for THIS task.

### eval_explain.rs (843 lines) — OVER LIMIT, note as tech debt

843 lines, also above 700-line critical threshold. This file is an augmented mirror of `eval.rs` with added instrumentation. The duplication between the two files is pre-existing tech debt; the plan explicitly defers it. Splitting is out of scope.

**Verdict:** Note as tech debt. No action required for THIS task.

### rfdb_server.rs (4831 lines) — SEVERELY OVER LIMIT, note as tech debt

4831 lines, massively over any threshold. However, the plan only touches 4 call sites to add `?`. The changes are mechanical and isolated. No amount of file-level concern changes the approach to these specific edits.

**Verdict:** Note as tech debt. No action required for THIS task.

---

## Methods We Will Directly Modify

### eval.rs — `eval_query()` (lines 130–170, ~40 lines)

**Length:** ~40 lines. Under the 50-line candidate threshold.

**Structure:**
- Initializes `current = vec![Bindings::new()]`
- Loops over `literals`, dispatching on `Literal::Positive` / `Literal::Negative`
- Returns `current`

**Assessment:** Clean. Nesting depth is 2 (for-loop inside match arm). No parameter object needed (1 parameter: `&[Literal]`). The planned change adds a single line at the top (`let ordered = reorder_literals(literals)?;`) and wraps the return in `Ok(...)`. No pre-refactoring required.

### eval.rs — `eval_rule_body()` (lines 788–828, ~40 lines)

**Length:** ~40 lines. Under threshold.

**Structure:** Identical loop structure to `eval_query`. Nesting depth 2.

**Assessment:** Clean. The planned change is the same one-line prefix plus `Ok(current)` wrap. No pre-refactoring required.

**Observation:** `eval_query` and `eval_rule_body` share an identical inner loop. This duplication is pre-existing — the plan correctly calls it out-of-scope. Rob should resist the temptation to extract a helper during implementation; it would widen scope and risk breaking the explain path.

### eval.rs — `eval_derived()` (lines 764–785, ~22 lines)

**Length:** ~22 lines. Well under threshold.

**Structure:** Looks up rules by predicate name, calls `eval_rule_body` per rule, projects to head.

**Assessment:** Clean. The planned change adds a `match` wrapper around the `eval_rule_body` call to catch errors. The nesting will increase to 3 levels locally (for-loop → match on rule_body result → for-loop over body_results) — still within acceptable range. No pre-refactoring required.

### eval_explain.rs — `eval_query()` (lines 154–191, ~38 lines)

**Length:** ~38 lines. Under threshold.

**Important distinction (B2 from plan):** This method currently returns `QueryResult`, not `Vec<Bindings>`. The new return type is `Result<QueryResult, String>` — not `Result<Vec<Bindings>, String>`. The inner loop structure, `finalize_result()` call, and `QueryResult` construction are unchanged. Rob must keep this asymmetry in mind.

**Assessment:** Clean. The planned change adds a one-line reorder prefix and wraps the final return in `Ok(...)`. No pre-refactoring required.

### eval_explain.rs — `eval_rule_body()` (lines 768–804, ~37 lines)

**Length:** ~37 lines. Under threshold. Identical structure to `eval.rs`'s version.

**Assessment:** Clean. Same change pattern. No pre-refactoring required.

### eval_explain.rs — `eval_derived()` (lines 745–765, ~21 lines)

**Length:** ~21 lines. Under threshold.

**Assessment:** Clean. Same error-boundary pattern as `eval.rs`. No pre-refactoring required.

### rfdb_server.rs — 4 call sites

The 4 call sites are in two functions:

- `execute_datalog_query` (lines 1844–1869): 2 call sites
- `execute_datalog` (lines 1877–1935): 2 call sites

Both functions already return `Result<DatalogResponse, String>`. The change is adding `?` after `.eval_query(...)`. The two evaluator types return different inner types after the change (`Vec<Bindings>` vs `QueryResult`) — but both `?`-propagations point to the same outer `Result<DatalogResponse, String>` context. No pre-refactoring needed.

---

## Pre-Implementation Refactoring Decision

**SKIP all refactoring. Proceed directly to implementation.**

Rationale:
- Every method we will modify is under 50 lines
- Nesting depth in affected methods is at most 2 (the new error boundary in `eval_derived` adds 1 level locally, still acceptable)
- Parameter counts are all under 3
- The only issues are file-level overages in `eval.rs`, `eval_explain.rs`, and `rfdb_server.rs` — all pre-existing, all out of scope per the plan
- Refactoring risk on critical execution path is not justified by any method-level smell

---

## Tech Debt Log (Do Not Act On Now)

| Item | File | Severity | Notes |
|------|------|----------|-------|
| File length | `eval.rs` (868 lines) | High | Consider splitting into predicate modules (`eval_builtins.rs`, `eval_derived.rs`, `eval_core.rs`) |
| File length | `eval_explain.rs` (843 lines) | High | Same structure as `eval.rs`, should be addressed together |
| Duplication | `eval.rs` vs `eval_explain.rs` | High | Inner loops in `eval_query` and `eval_rule_body` are identical. Defer until eval_explain refactor is planned |
| File length | `rfdb_server.rs` (4831 lines) | Critical | Major split needed; out of scope for any single feature task |
| `attr_edge` missing from `eval_explain.rs::eval_atom` | `eval_explain.rs` line 254–268 | Medium | Pre-existing gap, plan explicitly excludes it |

---

## Implementation Notes for Rob

1. Add `reorder_literals` and `literal_can_place_and_provides` to `utils.rs` at the bottom, after `value_to_string`. Add required imports (`HashSet`, `Literal`, `Term` from `crate::datalog::types`).

2. In `eval.rs`, the three methods to change are `eval_query`, `eval_rule_body`, and `eval_derived`. All other methods remain untouched. Do not extract the common loop even though the duplication is visible — that's out of scope.

3. In `eval_explain.rs`, the same three method names change. Watch the return type: `eval_query` wraps `QueryResult` in `Result`, not `Vec<Bindings>`.

4. In `rfdb_server.rs`, adding `?` at lines ~1854, ~1858, ~1920, ~1924 is all that is required. Verify the surrounding function return types are `Result<_, String>` (they are: both `execute_datalog_query` and `execute_datalog` return `std::result::Result<DatalogResponse, String>`).

5. The `eprintln!` in the `eval_derived` error boundary is correct per the plan. Do not silently swallow the error.
