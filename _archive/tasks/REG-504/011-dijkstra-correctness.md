# REG-504 Correctness Review — Dijkstra

> "I don't THINK it handles all cases — I PROVE it, by enumeration."

Reviewed files:
- `packages/rfdb-server/src/datalog/utils.rs`
- `packages/rfdb-server/src/datalog/eval.rs`
- `packages/rfdb-server/src/datalog/eval_explain.rs`
- `packages/rfdb-server/src/datalog/tests.rs` (reorder sections)

---

## Section 1: `literal_can_place_and_provides` — Input Enumeration

I enumerate every predicate arm and verify the (can_place, provides) tuple is correct given what the evaluator actually requires.

### 1.1 `"node"` arm

```
(true, free_vars(args, bound))
```

**Claim:** always placeable, provides all unbound Var args.

**Enumeration of eval_node cases:**
- `(Var, Const)` — does full scan. Works with empty bound. Provides the id variable. CORRECT.
- `(Const, Var)` — requires constant id. Since id is a Const here (not a Var), it won't be in `free_vars`. Type variable provided. CORRECT.
- `(Const, Const)` — no variables; provides nothing; always placeable. CORRECT.
- `(Var, Var)` — expensive full scan; both vars provided. CORRECT.

**Verdict:** CORRECT. `node` is always placeable because `eval_node` handles all four combinations without requiring anything to already be in bindings.

---

### 1.2 `"attr"` arm

```
can_place = id_ok && name_ok   (id and name must be bound or const)
provides  = {args[2]} if can_place and args[2] is Var and not already bound
```

**Claim:** requires first two args to be Const or in bound; provides the third.

**Enumeration against eval_attr:**
- `eval_attr` returns `vec![]` if `id_term` is not `Term::Const`. After substitution, a bound Var becomes `Term::Const`. So "in bound" at reorder time → Const at eval time. CORRECT.
- `eval_attr` returns `vec![]` if `attr_term` is not `Term::Const`. Same reasoning. CORRECT.
- Third arg (value): can be Var, Const, or Wildcard. eval_attr handles all three. CORRECT.

**Verdict:** CORRECT.

---

### 1.3 `"attr_edge"` arm

```
can_place = args[0..3] all bound_or_const
provides  = {args[4]} if can_place and args[4] is Var
```

**Claim:** requires first 4 args bound; provides arg[4].

**Enumeration against eval_attr_edge:**
- Requires `src_term`, `dst_term`, `type_term`, `attr_term` to be `Term::Const`. All four checked. CORRECT.
- `value_term` (args[4]) handled as Var/Const/Wildcard. CORRECT.

**Verdict:** CORRECT.

---

### 1.4 `"edge"` arm

```
(true, free_vars(args, bound))
```

**Claim:** always placeable; provides all unbound Var args.

**Enumeration against eval_edge:**
- `(Const(src), ...)` — uses `get_outgoing_edges`. No unbound requirement. Provides dst/type vars. CORRECT.
- `(Var(src), ...)` — enumerates all edges (`get_all_edges`). This IS expensive but works. Provides src, dst, type vars. CORRECT.
- `(Wildcard, ...)` — falls through to `_ => vec![]`. Wildcard is NOT handled in eval_edge.

**BUG FOUND — Issue 1 (Minor):** `is_bound_or_const` returns `true` for `Term::Wildcard`. Therefore `free_vars` never includes wildcards (wildcards are not `Term::Var`). So `edge(_, Dst, "calls")` with `_` as src will be considered always placeable by reorder, which is correct in intent (wildcard src falls to `_ => vec![]` in eval_edge). Actually wait — let me re-examine. `eval_edge` matches on `src_term`:

```rust
match src_term {
    Term::Const(...) => ...
    Term::Var(...) => ...
    _ => vec![],    // Wildcard falls here → returns empty
}
```

So `edge(_, Dst, T)` in a query is marked as placeable (can always place) but at eval time returns `vec![]`. This means a query containing `edge(_, X, "calls")` will be considered "placeable" by reorder, placed wherever the greedy algorithm picks it, and then at eval time it will produce zero results — silently dropping all bindings instead of raising an error.

This is a **semantic inconsistency**: reorder claims the literal is placeable with meaningful output, but the evaluator treats wildcard-src-edge as returning nothing. However, this is arguably a pre-existing limitation of `eval_edge`, not a bug in the reordering logic per se. The reordering does not introduce incorrect behavior that wasn't already present before REG-504; it merely preserves the existing semantics (wildcard source always returned empty even before reordering). I classify this as a **pre-existing gap, not introduced by this PR**.

**Verdict for "edge" arm:** CORRECT within the contract of the existing evaluator.

---

### 1.5 `"incoming"` arm

```
can_place = is_bound_or_const(args[0], bound)
provides  = free Vars from args[1..]  (if can_place)
```

**Claim:** requires dst (args[0]) to be bound; provides src and type.

**Enumeration against eval_incoming:**
- `Term::Const(dst)` — uses `get_incoming_edges`. Provides src/type vars. CORRECT.
- `Term::Var(_dst)` — returns `vec![]`. The reorder rule correctly blocks placement until dst is bound. CORRECT.
- `Term::Wildcard` (dst) — `is_bound_or_const` returns `true` for Wildcard. So wildcard-dst incoming is always placeable. `eval_incoming` falls to `_ => vec![]`. Same pre-existing gap as edge/wildcard noted above. Not introduced by this PR.

**Verdict:** CORRECT within existing evaluator contract.

---

### 1.6 `"path"` arm

```
can_place = is_bound_or_const(args[0], bound)
provides  = free Vars from args[1..]  (if can_place)
```

**Claim:** requires src (args[0]) to be bound.

**Enumeration against eval_path:**
- `(Const, Const)` — ground check. CORRECT.
- `(Const, Var)` — BFS from src. CORRECT.
- `(Const, Wildcard)` — reachability check. CORRECT.
- `(Var, _)` — reorder blocks until bound. `eval_path` falls to `_ => vec![]`. CORRECT: reorder will block placement until src is provided by another literal.
- `(Wildcard, _)` — same pre-existing gap: always placeable but returns empty. Not introduced by this PR.

**Verdict:** CORRECT.

---

### 1.7 `"neq" | "starts_with" | "not_starts_with"` arm

```
can_place = all Vars in args are in bound
provides  = {} (empty)
```

**Claim:** pure filter; requires all variables bound; provides nothing.

**Enumeration against eval_neq / eval_starts_with / eval_not_starts_with:**
- Both args must be `Term::Const` at eval time (after substitution). Returns empty if not. CORRECT.
- These predicates are constraint-only; they never introduce new variables. Providing empty set is CORRECT.

**Verdict:** CORRECT.

---

### 1.8 `_` (unknown predicate) arm

```
(true, HashSet::new())
```

**Claim:** unknown predicates are always placeable; provide nothing.

This is the safety fallback for user-defined (derived) predicates. Derived predicates are evaluated via `eval_derived`, which enumerates rule bodies independently — it does not require the query-level `bound` set to be populated first. Marking derived predicates as always placeable and providing-nothing is a conservative approximation.

**Issue 2 (Design gap):** For a derived predicate `foo(X, Y)`, if the reorder places it early, `eval_derived` will evaluate all matching rule bodies and produce bindings for X and Y. But since `provides = HashSet::new()`, those variables X and Y are NOT added to `bound`. Any subsequent literal that requires X or Y to be bound will not see them in `bound` and may block placement.

**Concrete failing input:**
```
foo(X), attr(X, "name", N)
```
where `foo` is a derived predicate like `foo(X) :- node(X, "CALL").`

The reorder algorithm will:
1. Check `foo(X)`: `_ => (true, {})`. Can place. Places it. `bound` stays `{}`.
2. Check `attr(X, "name", N)`: requires `X` in bound. `X` is NOT in bound (step 1 provided nothing). `can_place = false`.
3. No remaining literal can be placed. Returns `Err("circular dependency")`.

Yet the query is logically valid and should succeed.

**Is this newly introduced by REG-504?** No. This gap was present before: if you wrote `attr(X, "name", N), foo(X)` in the old code without reordering, `attr` would fail because X was unbound. The reorder makes it WORSE by converting a "usually works in correct input order" situation into "always returns an error." The reorder algorithm does not help with derived predicates — it cannot reorder them to be useful because `provides = {}`.

**However:** The old code (before REG-504) simply evaluated left-to-right without reordering. For `foo(X), attr(X, "name", N)` written in correct order, the old code worked. The new code breaks this: reorder places `foo(X)`, records no provides, then fails to place `attr(X, "name", N)` because X is not in `bound`.

**This is a regression introduced by REG-504.**

To prove it: construct this input:
```rust
let foo_rule = parse_rule("foo(X) :- node(X, \"CALL\").").unwrap();
evaluator.add_rule(foo_rule);
let query = parse_query("foo(X), attr(X, \"name\", N)").unwrap();
let result = evaluator.eval_query(&query);
// Expected: Ok with 3 results
// Actual: Err("circular dependency, cannot place: ...")
```

The `attr(X, "name", N)` literal requires `X` to be in `bound`. After placing `foo(X)` (provides nothing), `X` is not in `bound`. The reorder algorithm cannot place `attr`. Returns `Err`.

**This is a correctness regression. REJECT.**

---

## Section 2: Loop Termination

**Claim:** The greedy loop always terminates.

**Proof:** Each iteration either:
- (a) Finds a position `Some(i)`, removes `remaining[i]` — `remaining.len()` decreases by 1, or
- (b) Finds `None` — returns `Err` immediately.

Since `remaining.len()` is finite and strictly decreases on each non-error iteration, the loop terminates. **PROVEN.**

---

## Section 3: Condition Completeness

### 3.1 `literal_can_place_and_provides`

Match on `Literal`:
- `Literal::Negative(atom)` — handled.
- `Literal::Positive(atom)` — handled.

No other variants exist in the `Literal` enum. **COMPLETE.**

### 3.2 `positive_can_place_and_provides`

Match on `pred` (string):
- `"node"`, `"attr"`, `"attr_edge"`, `"edge"`, `"incoming"`, `"path"` — explicit arms.
- `"neq" | "starts_with" | "not_starts_with"` — grouped arm.
- `_` — catch-all.

**COMPLETE.** No input falls through without a match.

### 3.3 `is_bound_or_const`

Match on `Term`:
- `Term::Const(_) | Term::Wildcard` → `true`.
- `Term::Var(v)` → `bound.contains(v)`.

All three variants covered. **COMPLETE.**

### 3.4 `free_vars`

`filter_map` over args, matches `Term::Var(v) if !bound.contains(v)`. All other terms (Const, Wildcard) fall to `_ => None`. **COMPLETE.**

---

## Section 4: Invariant Verification

**Claim:** After `reorder_literals` returns `Ok(ordered)`, evaluating `ordered` left-to-right will never hit "return vec![]" due to unbound variables.

This invariant holds **only for known predicates** where `provides` is correctly computed. For predicates in the `_` fallback arm (derived predicates), the invariant **does not hold**, as proven in Section 1.8.

For the set of known predicates (`node`, `attr`, `attr_edge`, `edge`, `incoming`, `path`, `neq`, `starts_with`, `not_starts_with`), the invariant holds:

- Each predicate's `can_place` condition exactly matches the requirements of the corresponding `eval_*` method for avoiding `vec![]` returns due to unbound variables.
- `provides` correctly captures what new variables are bound after evaluation.
- Therefore, when placed, each literal will have its required variables substituted to `Term::Const` before evaluation.

**PARTIAL:** Invariant holds for known predicates, fails for derived predicates.

---

## Section 5: Edge Cases

### 5.1 Empty input

`reorder_literals(&[])` → loop body never executes → returns `Ok(vec![])`. **CORRECT.** Tested by `test_reorder_empty_input`.

### 5.2 Single literal

A single literal is always the only candidate. If `can_place`, placed immediately → `Ok(vec![lit])`. If not placeable (e.g., `attr(X, "name", N)` alone) → `None` → `Err("circular dependency")`. **CORRECT.** The error is appropriate: a single ungroundable literal has no valid evaluation order.

### 5.3 All constraints (neq/starts_with with no generator)

Example: `[neq(X, Y)]` with X and Y not provided by anything. Reorder returns `Err`. This is correct — such a query is unsatisfiable.

### 5.4 Wildcards

`is_bound_or_const` returns `true` for wildcards. So wildcards are treated as if they are constants. For predicates that handle wildcards in eval (e.g., `eval_edge`'s `Term::Wildcard` dst branch), this is fine. For predicates that return empty on wildcard src (eval_edge's `_ => vec![]`), the reorder places the literal but eval returns empty. Pre-existing gap, not a regression.

### 5.5 Already-all-constants

A query `[attr("1", "name", "foo")]` — all Const. `id_ok = true`, `name_ok = true`, `can_place = true`, `provides = {}`. Placed first. Eval produces `vec![]` or `vec![Bindings::new()]`. CORRECT.

---

## Section 6: `eval.rs` — `eval_derived` Error Boundary

```rust
let body_results = match self.eval_rule_body(rule) {
    Ok(b) => b,
    Err(e) => {
        eprintln!("datalog eval_derived: reorder error for rule {:?}: {}", rule, e);
        continue;
    }
};
```

**Question:** Is `continue` correct here?

`continue` skips the current rule and moves to the next. This means a rule whose body has a circular dependency is silently skipped (after logging to stderr), and other rules for the same predicate are still tried.

**Assessment:** Silently swallowing the error is a questionable design, but it is the correct behavior if we accept that `eval_derived` should be best-effort. The alternative — propagating the error — would cause the entire query to fail when one rule out of many has a bad body ordering. For a Datalog system with multiple rules per predicate, skipping one bad rule and trying others is defensible.

However, the log output goes to `eprintln` (stderr), which is invisible to the caller. The caller has no way to know that a rule was skipped. This could silently produce incorrect results (missing answers). A more correct design would surface this as a warning in the query result.

**Verdict:** Functionally correct in that it won't panic or produce semantically wrong results from rules that ARE evaluated, but it has observability problems. Not a blocker for REG-504's stated goal.

---

## Section 7: `eval_explain.rs` — `eval_query` Return Type

```rust
pub fn eval_query(&mut self, literals: &[Literal]) -> Result<QueryResult, String> {
    let ordered = reorder_literals(literals)?;
    // ...
    Ok(self.finalize_result(current))
}
```

The `?` operator propagates `Err` from `reorder_literals`. `finalize_result` returns `QueryResult` (not a Result). The wrapping `Ok(...)` is therefore correct: `finalize_result` only fails if `reorder_literals` fails (handled by `?`), otherwise returns `Ok(QueryResult)`.

**Verdict:** CORRECT.

---

## Section 8: Missing `"attr_edge"` in `eval_explain.rs`

Examining `eval_explain.rs::eval_atom`:

```rust
let result = match atom.predicate() {
    "node" => self.eval_node(atom),
    "edge" => self.eval_edge(atom),
    "incoming" => self.eval_incoming(atom),
    "path" => self.eval_path(atom),
    "attr" => self.eval_attr(atom),
    "neq" => self.eval_neq(atom),
    "starts_with" => self.eval_starts_with(atom),
    "not_starts_with" => self.eval_not_starts_with(atom),
    _ => self.eval_derived(atom),
};
```

**BUG FOUND — Issue 3:** `"attr_edge"` is **absent** from `eval_explain.rs::eval_atom`. It is present in `eval.rs::eval_atom` but missing here. Queries using `attr_edge` routed through `EvaluatorExplain` will fall through to `eval_derived`, which will find no rules for `"attr_edge"` and return `vec![]`.

This is a pre-existing bug or an oversight in the EvaluatorExplain implementation — it does NOT implement `eval_attr_edge`. The reordering logic in utils.rs correctly handles `attr_edge` (it has an explicit arm in `positive_can_place_and_provides`). So the reorder will correctly place `attr_edge` literals, but the explain evaluator will silently return no results for them.

**Is this introduced by REG-504?** The missing `eval_attr_edge` in `eval_explain.rs` appears to be a pre-existing omission, not introduced by this PR. However, this PR did not add it while adding `attr_edge` support to utils.rs. The inconsistency exists and is now more visible.

---

## Summary of Findings

| # | Finding | Severity | Introduced by REG-504? |
|---|---------|----------|----------------------|
| 1 | Wildcard-src for `edge`/`incoming`/`path`: placeable but returns empty | Minor gap | Pre-existing |
| 2 | Derived predicates (`_` fallback): `provides = {}` breaks queries combining derived + attr | **REGRESSION** | **Yes** |
| 3 | `attr_edge` missing from `eval_explain.rs::eval_atom` | Bug | Pre-existing |

### Critical Issue (Issue 2) — Detailed Reproduction

**Input that breaks:**
```rust
// Setup
let mut evaluator = Evaluator::new(&engine);
let foo_rule = Rule::new(
    Atom::new("foo", vec![Term::var("X")]),
    vec![Literal::positive(Atom::new("node", vec![
        Term::var("X"), Term::constant("CALL")
    ]))]
);
evaluator.add_rule(foo_rule);

// Query: foo(X), attr(X, "name", N) — valid, should return 3 results
let query = vec![
    Literal::positive(Atom::new("foo", vec![Term::var("X")])),
    Literal::positive(Atom::new("attr", vec![
        Term::var("X"), Term::constant("name"), Term::var("N")
    ])),
];
let result = evaluator.eval_query(&query);
// ACTUAL:   Err("datalog reorder: circular dependency, cannot place: ...")
// EXPECTED: Ok with 3 bindings {X: ..., N: "handleRequest"/"handleOrder"/"doWork"}
```

**Root cause:** `reorder_literals` places `foo(X)` (derived predicate, `provides = {}`), then cannot place `attr(X, "name", N)` because `X` is not in `bound`. Returns `Err`.

**Before REG-504:** The query `foo(X), attr(X, "name", N)` written in correct order was evaluated left-to-right. `foo(X)` ran first, bound X, `attr` ran second. It worked.

**After REG-504:** The same query returns `Err` because the reorder algorithm does not know that `foo(X)` binds X.

---

## Verdict

**REJECT**

The implementation contains a correctness regression (Issue 2): queries that combine a user-defined (derived) predicate with predicates requiring bound variables will incorrectly return `Err("circular dependency")` after REG-504, whereas they previously worked correctly when written in the correct order.

The fix requires `literal_can_place_and_provides` to compute `provides` for derived predicates by inspecting the head variables of the matching rules, similar to how `node` provides `free_vars`. Without this, the reorder algorithm is incomplete for derived predicates.
