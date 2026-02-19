# REG-504: Rob Pike Implementation Report
# Datalog Query Reordering — Bound Variables First

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2026-02-19
**Status:** Implementation complete

---

## Summary

Implemented the greedy topological sort for Datalog query literal reordering as specified in Don's plan (003-don-plan.md, revised). The reordering ensures predicates requiring bound variables are evaluated after the predicates that provide those bindings.

## Changes Made

### 1. `packages/rfdb-server/src/datalog/utils.rs`

Added imports: `std::collections::HashSet`, `super::types::{Literal, Term}`.

Added four functions at the bottom of the file (before `#[cfg(test)]`):

- **`pub(crate) fn reorder_literals(literals: &[Literal]) -> Result<Vec<Literal>, String>`** — Greedy topological sort. Tracks a `bound: HashSet<String>` of known-bound variable names. At each step, picks the first literal from `remaining` whose requirements are satisfied by `bound`. Returns `Err` if no literal can be placed (circular dependency).

- **`fn literal_can_place_and_provides(literal: &Literal, bound: &HashSet<String>) -> (bool, HashSet<String>)`** — Dispatches to negative (all vars must be bound, provides nothing) vs positive classification.

- **`fn positive_can_place_and_provides(atom: &Atom, bound: &HashSet<String>) -> (bool, HashSet<String>)`** — Per-predicate classification exactly matching the plan's table:
  - `node` / `edge` — always placeable, provides free vars
  - `attr` — requires id AND name bound
  - `attr_edge` — requires src, dst, etype, name bound
  - `incoming` — requires dst bound
  - `path` — requires src bound
  - `neq` / `starts_with` / `not_starts_with` — all vars must be bound
  - Unknown predicates — always placeable (safe fallback), provides nothing

- **`fn is_bound_or_const(term: &Term, bound: &HashSet<String>) -> bool`** and **`fn free_vars(args: &[Term], bound: &HashSet<String>) -> HashSet<String>`** — Small helpers.

### 2. `packages/rfdb-server/src/datalog/eval.rs`

- Added `use super::utils::reorder_literals;`
- **`eval_query()`**: Changed return type from `Vec<Bindings>` to `Result<Vec<Bindings>, String>`. Added `let ordered = reorder_literals(literals)?;` at entry. Iterates over `&ordered`. Returns `Ok(current)`.
- **`eval_rule_body()`**: Same pattern — returns `Result<Vec<Bindings>, String>`, reorders at entry.
- **`eval_derived()`**: Return type unchanged (`Vec<Bindings>`). Catches `Err` from `eval_rule_body` with `match`, logs via `eprintln!`, and `continue`s (error boundary as specified).

### 3. `packages/rfdb-server/src/datalog/eval_explain.rs`

- Added `use super::utils::reorder_literals;`
- **`eval_query()`**: Changed return type from `QueryResult` to `Result<QueryResult, String>`. Added reorder at entry. Returns `Ok(self.finalize_result(current))`.
- **`eval_rule_body()`**: Same pattern as eval.rs.
- **`eval_derived()`**: Same error boundary pattern as eval.rs.

### 4. `packages/rfdb-server/src/bin/rfdb_server.rs`

Added `?` at all 4 `eval_query()` call sites:
- Line ~1854: `EvaluatorExplain::eval_query` in `execute_datalog_query`
- Line ~1858: `Evaluator::eval_query` in `execute_datalog_query`
- Line ~1920: `EvaluatorExplain::eval_query` in `execute_datalog` (fallback path)
- Line ~1924: `Evaluator::eval_query` in `execute_datalog` (fallback path)

All are inside `Result<DatalogResponse, String>`-returning functions, so `?` propagates cleanly.

## What Was NOT Touched

- `tests.rs` — Kent's responsibility
- `parser.rs` — no parser changes (reordering is evaluator-side)
- `query()` / `eval_atom()` — signatures unchanged per plan
- NAPI bindings — unaffected (uses `query()`, not `eval_query()`)

## Verification

- `cargo check` — compiles with no new warnings (4 pre-existing storage warnings only)
- `cargo test -- datalog` — all 114 datalog tests pass (including Kent's reorder tests)
- Binary compilation verified (`cargo check --bin rfdb-server`)
