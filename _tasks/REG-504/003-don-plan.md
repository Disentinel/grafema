# REG-504: Don Melton Implementation Plan
# Datalog Query Reordering — Bound Variables First

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-19
**Status:** Plan (Revised)

---

## Revision Note (2026-02-19)

Dijkstra rejected the original plan with three blocking issues. This revision addresses all of them:

- **B1 (Error cascade):** `eval_derived` now catches errors from `eval_rule_body` internally and converts them to empty results (logs the error). The cascade stops at `eval_derived`. `eval_atom()` and `query()` keep their current return types unchanged. Only `eval_query()` and `eval_rule_body()` change to `Result`.
- **B2 (EvaluatorExplain return type):** Section 2 and 3.3 now explicitly specify `Result<QueryResult, String>` for `EvaluatorExplain::eval_query`, NOT `Result<Vec<Bindings>, String>`. These are not identical changes.
- **B3 (Existing test call sites):** Section 3.5 now explicitly instructs updating all existing `eval_query` call sites in tests to `.unwrap()` the result.

Non-blocking improvements incorporated:
- **N2:** Added unit tests for `reorder_literals` itself (Section 4, Tests 0a–0d).
- **N4:** `can_place` for `attr` now also checks `attr_name` is Const or in bound.

---

## 1. Algorithm: `reorder_literals()`

**Signature:**
```rust
pub(crate) fn reorder_literals(literals: &[Literal]) -> Result<Vec<Literal>, String>
```

**Algorithm:** Greedy topological sort. Iterate until all literals are placed; at each step pick the first literal in `remaining` whose requirements are met by `bound`.

```
bound: HashSet<String> = {}
result: Vec<Literal> = []
remaining: Vec<Literal> = literals.to_vec()

loop:
  if remaining.is_empty(): return Ok(result)
  match remaining.iter().position(|l| can_place(l, &bound)):
    Some(i) =>
      let lit = remaining.remove(i)
      bound.extend(provides(lit, &bound))
      result.push(lit)
    None =>
      return Err(format!(
        "datalog reorder: circular dependency, cannot place: {:?}",
        remaining.iter().map(|l| l.to_string()).collect::<Vec<_>>()
      ))
```

**Helper: `literal_requirements(lit: &Literal, bound: &HashSet<String>) -> (can_place: bool, provides: HashSet<String>)`**

Per-predicate classification (Term::Var name not in `bound` = "free"):

| Literal | `can_place` | `provides` |
|---------|-------------|------------|
| `Positive(node(V_id, Const))` | always | `{V_id}` if V_id free |
| `Positive(node(Const, V_type))` | always | `{V_type}` if V_type free |
| `Positive(node(V1, V2))` — both free | always (full scan) | `{V1, V2}` |
| `Positive(node(Const, Const))` | always | `{}` |
| `Positive(attr(id, name, val))` | id is Const or id_var in bound AND name is Const or name_var in bound | val_var if free |
| `Positive(attr_edge(src, dst, etype, name, val))` | src, dst, etype, name all Const or in bound | val_var if free |
| `Positive(edge(Const, V_dst, ...))` | always | `{V_dst}` if free, type_var if free |
| `Positive(edge(V_src, V_dst, ...))` — src free | always (full scan) | free vars among args |
| `Positive(incoming(Const, V_src, ...))` | always | `{V_src}` if free, type_var if free |
| `Positive(incoming(V_dst, ...))` — dst free | dst_var in bound | free vars among remaining args |
| `Positive(path(Const, V_dst))` | always | `{V_dst}` if free |
| `Positive(path(V_src, ...))` — src free | src_var in bound | `{}` |
| `Positive(neq(...))` | all Var args in bound | `{}` |
| `Positive(starts_with(...))` | all Var args in bound | `{}` |
| `Positive(not_starts_with(...))` | all Var args in bound | `{}` |
| `Negative(atom)` | ALL Var terms in atom in bound | `{}` |
| Any unknown predicate | always (safe fallback) | `{}` |

**Term classification helpers:**
- `is_free(term, bound)`: `matches!(term, Term::Var(v) if !bound.contains(v))`
- `var_name(term)`: `if let Term::Var(v) = term { Some(v) } else { None }`

---

## 2. Error Handling

**Decision: change `eval_query()` and `eval_rule_body()` return types to `Result`. Error boundary stops at `eval_derived`.**

Rationale: `rfdb_server.rs` already handles `Result<DatalogResponse, String>` at every call site (`execute_datalog_query` lines 1844-1869, `execute_datalog` lines ~1920). Propagation is clean via `?`. Silent empty-vec return on circular dependency would hide bugs from callers.

**Error boundary (B1):** `eval_derived` calls `eval_rule_body`. If `eval_rule_body` returns `Err`, `eval_derived` does NOT propagate it — it logs the error and treats that rule as producing empty results. This means:
- `eval_derived` keeps its current return type: `Vec<Bindings>`.
- `eval_atom` keeps its current return type: `Vec<Bindings>`.
- `query()` keeps its current return type (unaffected).
- NAPI `check_guarantee` is unaffected.
- Only `eval_query()` and `eval_rule_body()` change to `Result`.

**New signatures:**
```rust
// eval.rs
pub fn eval_query(&self, literals: &[Literal]) -> Result<Vec<Bindings>, String>  // CHANGED
fn eval_rule_body(&self, rule: &Rule) -> Result<Vec<Bindings>, String>            // CHANGED
fn eval_derived(&self, ...) -> Vec<Bindings>                                      // UNCHANGED: catches Err from eval_rule_body internally

// eval_explain.rs
pub fn eval_query(&mut self, literals: &[Literal]) -> Result<QueryResult, String> // CHANGED — NOTE: returns QueryResult, NOT Vec<Bindings>
fn eval_rule_body(&self, rule: &Rule) -> Result<Vec<Bindings>, String>            // CHANGED
fn eval_derived(&self, ...) -> Vec<Bindings>                                      // UNCHANGED: same boundary as eval.rs
```

**B2 — EvaluatorExplain::eval_query is NOT parallel to Evaluator::eval_query.**
`EvaluatorExplain::eval_query` currently returns `QueryResult`, not `Vec<Bindings>`. Its new signature wraps the existing return type: `Result<QueryResult, String>`. The internal body reorders literals, runs the existing loop, and returns `Ok(query_result)` on success or propagates `Err` from `reorder_literals`. Do NOT change the inner `QueryResult` construction logic.

---

## 3. Files and Changes (Ordered)

### 3.1 `packages/rfdb-server/src/datalog/utils.rs`

Add two `pub(crate)` functions at the bottom of the file:

```rust
pub(crate) fn reorder_literals(literals: &[Literal]) -> Result<Vec<Literal>, String> { ... }

fn literal_can_place_and_provides(
    literal: &Literal,
    bound: &HashSet<String>,
) -> (bool, HashSet<String>) { ... }
```

No existing code is modified.

### 3.2 `packages/rfdb-server/src/datalog/eval.rs`

**`eval_query()` — line ~130:** Add reorder call at entry, change return type:
```rust
pub fn eval_query(&self, literals: &[Literal]) -> Result<Vec<Bindings>, String> {
    let ordered = reorder_literals(literals)?;
    let mut current = vec![Bindings::new()];
    for literal in &ordered {
        // existing loop body unchanged
    }
    Ok(current)
}
```

**`eval_rule_body()` — line ~788:** Same pattern:
```rust
fn eval_rule_body(&self, rule: &Rule) -> Result<Vec<Bindings>, String> {
    let ordered = reorder_literals(rule.body())?;
    // existing loop body, return Ok(current)
}
```

**`eval_derived()` — line ~774:** Return type stays `Vec<Bindings>`. Where it calls `eval_rule_body()`, wrap the call to catch errors at the boundary:
```rust
// Before: let bindings = self.eval_rule_body(rule)?;
// After (inside eval_derived):
let bindings = match self.eval_rule_body(rule) {
    Ok(b) => b,
    Err(e) => {
        eprintln!("datalog eval_derived: reorder error for rule {:?}: {}", rule, e);
        continue; // treat this rule as producing no results
    }
};
```
`eval_atom()` and `query()` remain fully unchanged in signature and behavior.

### 3.3 `packages/rfdb-server/src/datalog/eval_explain.rs`

**`eval_query()` — line ~154:** Add reorder call at entry. Change return type to `Result<QueryResult, String>` (NOT `Result<Vec<Bindings>, String>` — the existing `QueryResult` wrapper is preserved):
```rust
pub fn eval_query(&mut self, literals: &[Literal]) -> Result<QueryResult, String> {
    let ordered = reorder_literals(literals)?;
    // existing loop body unchanged — builds QueryResult as before
    Ok(query_result) // wrap the existing return value
}
```

**`eval_rule_body()` — line ~768:** Same pattern as 3.2 — add reorder call, return `Result<Vec<Bindings>, String>`.

**`eval_derived()` — line ~745:** Same error-boundary pattern as 3.2 — catch `Err` from `eval_rule_body`, log and continue. Return type stays `Vec<Bindings>`.

### 3.4 `packages/rfdb-server/src/bin/rfdb_server.rs`

Four call sites. All are inside `Result`-returning functions — `?` is sufficient. Note the different inner types:

| Line | Evaluator | Return type before | Return type after | Change |
|------|-----------|--------------------|-------------------|--------|
| ~1854 | `EvaluatorExplain` | `QueryResult` | `Result<QueryResult, String>` | add `?` — pass unwrapped `QueryResult` to `query_result_to_wire_explain` |
| ~1858 | `Evaluator` | `Vec<Bindings>` | `Result<Vec<Bindings>, String>` | add `?` |
| ~1920 | `EvaluatorExplain` | `QueryResult` | `Result<QueryResult, String>` | add `?` |
| ~1924 | `Evaluator` | `Vec<Bindings>` | `Result<Vec<Bindings>, String>` | add `?` |

`query()` call sites (lines ~1891, ~1898–1899, NAPI `check_guarantee`) are unaffected — `query()` return type does not change.

### 3.5 `packages/rfdb-server/src/datalog/tests.rs`

**B3 — Update existing test call sites first.** Before adding new tests, scan `mod eval_tests` for every call to `evaluator.eval_query(...)` that does not handle a `Result`. Update each to add `.unwrap()`:
```rust
// Before:
let result = evaluator.eval_query(&literals);
// After:
let result = evaluator.eval_query(&literals).unwrap();
```
This is a mechanical find-and-replace across the existing test suite. Do it before adding new tests to ensure the file compiles.

Add new tests under `mod eval_tests`. See Section 4.

---

## 4. Test Plan

All tests go inside `mod eval_tests` in `tests.rs`. Use the existing test DB setup pattern.

**Tests 0a–0d — `reorder_literals` unit tests (no graph needed)**

These test the pure function directly and do not require a database. Place them in a nested `mod reorder_tests` inside `mod eval_tests`, or as standalone `#[test]` functions near the function definition in `utils.rs`.

```
Test 0a — empty input: reorder_literals(&[]) == Ok([])
Test 0b — already correct: reorder_literals([node(X,T), attr(X,n,V)]) returns same order (node first)
Test 0c — wrong order: reorder_literals([attr(X,n,V), node(X,T)]) returns [node(X,T), attr(X,n,V)]
Test 0d — circular dependency: reorder_literals([attr(X,n,Y), attr(Y,n,X)]) returns Err containing "circular"
```

For 0b and 0c, construct `Literal` values directly using the type constructors — no DB required.

**Test 1 — Wrong order: attr before node**
```
Query A: attr(X, "name", N), node(X, "CALL")   // wrong order
Query B: node(X, "CALL"), attr(X, "name", N)   // correct order
assert eval(A) == eval(B), non-empty
```

**Test 2 — Wrong order: negation before positive**
```
Query A: \+ path(X, _), node(X, "queue:publish")
Query B: node(X, "queue:publish"), \+ path(X, _)
assert eval(A) == eval(B)
```

**Test 3 — Already correct order: no change in results**
```
Query: node(X, "CALL"), attr(X, "name", N)
assert eval(query) == expected_results  // verify it still works
```

**Test 4 — Circular dependency: returns Err**
```
// pathological: attr(X, .., Y), attr(Y, .., X) with no seed
assert eval(circular_query).is_err()
assert error_message.contains("circular dependency")
```

**Test 5 — Multi-variable chain: node → attr → edge → attr**
```
Query (wrong order): attr(Dst, "label", L), edge(X, Dst, "calls"), attr(X, "name", N), node(X, "CALL")
Correct order:       node(X, "CALL"), attr(X, "name", N), edge(X, Dst, "calls"), attr(Dst, "label", L)
assert eval(wrong) == eval(correct), non-empty
```

**Test 6 — Constraint predicates after bindings**
```
Query A: neq(X, Y), node(X, "CALL"), node(Y, "CALL")
Query B: node(X, "CALL"), node(Y, "CALL"), neq(X, Y)
assert eval(A) == eval(B)
```

**Test 7 — Rule body reordering (user-defined rule)**
```
Rule: caller(X) :- attr(X, "name", N), node(X, "CALL"), starts_with(N, "handle").
// attr and starts_with must be reordered after node
assert evaluator.query_rule("caller", ...) returns correct results
```

**Test 8 — incoming with unbound dst reordered**
```
Query (wrong): incoming(X, Src, "calls"), node(X, "queue:publish")
Correct:       node(X, "queue:publish"), incoming(X, Src, "calls")
assert eval(wrong) == eval(correct)
```

---

## 5. What NOT To Do

- Do NOT refactor the duplication between `eval.rs` and `eval_explain.rs` — separate tech debt, out of scope.
- Do NOT change the parser — parser preserves user-written order; reordering is evaluator responsibility.
- Do NOT optimize rule caching (pre-reordering at load time) — follow-up task.
- Do NOT touch the pre-existing `attr_edge` absence in `eval_explain.rs::eval_atom()` — out of scope.
- Do NOT add cost-based optimization (prefer cheaper literals when multiple can be placed) — greedy first-found is sufficient.
