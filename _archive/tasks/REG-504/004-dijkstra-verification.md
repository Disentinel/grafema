# REG-504: Dijkstra Verification Report
# Datalog Query Reordering — Bound Variables First

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-19
**Status:** Verification Complete

> "I don't THINK it handles all cases — I PROVE it, by enumeration."

---

## Verification Methodology

I read every predicate implementation in `eval.rs` and `eval_explain.rs` line by line. I enumerated every call site that must change. I checked every edge case. I do not estimate — I enumerate.

---

## 1. Completeness Table for Predicate Classification

For each predicate in `eval_atom()`, I verify the plan's `can_place` and `provides` classification against the actual code.

### eval.rs — match arms in eval_atom() (lines 174–185)

```
"node"          => eval_node
"edge"          => eval_edge
"incoming"      => eval_incoming
"path"          => eval_path
"attr"          => eval_attr
"attr_edge"     => eval_attr_edge
"neq"           => eval_neq
"starts_with"   => eval_starts_with
"not_starts_with" => eval_not_starts_with
_               => eval_derived
```

**Count: 9 named predicates + derived fallback.**

### eval_explain.rs — match arms in eval_atom() (lines 258–267)

```
"node"          => eval_node
"edge"          => eval_edge
"incoming"      => eval_incoming
"path"          => eval_path
"attr"          => eval_attr
"neq"           => eval_neq
"starts_with"   => eval_starts_with
"not_starts_with" => eval_not_starts_with
_               => eval_derived
```

**Count: 8 named predicates + derived fallback. `attr_edge` is ABSENT — falls through to `eval_derived`.**

Don noted this divergence. The verification table below covers both evaluators.

---

### Predicate-by-Predicate Verification

**Predicate: `node(Id, Type)`**

Actual code (eval.rs:198–252):
- `(Var, Const)` → `find_by_type(type)`, provides `Id`. Can always execute.
- `(Const, Var)` → `get_node(id)`, provides `Type`. Can always execute.
- `(Const, Const)` → existence check. No free vars. Can always execute.
- `(Var, Var)` → `count_nodes_by_type` + `find_by_type` for each, provides both. Can always execute (full scan).
- `(Wildcard, *)` or `(*, Wildcard)` → falls through to `_ => vec![]`. **Returns empty silently.**

Plan says: `node(V_id, Const)` — always, provides `{V_id}`. **MATCH.**
Plan says: `node(Const, V_type)` — always, provides `{V_type}`. **MATCH.**
Plan says: `node(V1, V2)` both free — always (full scan), provides `{V1, V2}`. **MATCH.**
Plan says: `node(Const, Const)` — always, provides `{}`. **MATCH.**

**GAP FOUND:** When either position is `Wildcard`, `eval_node` returns `vec![]` (hits the `_ => vec![]` arm). The plan does not mention the Wildcard case for `node`. In practice, well-formed Datalog programs do not put wildcards in `node` head or id positions since they provide no useful bindings, so this is unlikely to be a real-world issue. However, the `can_place` table should acknowledge this: `node(_, Const)` will always return empty and the plan does not say so. **Minor gap, low severity.**

---

**Predicate: `attr(NodeId, AttrName, Value)`**

Actual code (eval.rs:438–512):
- `id_term` anything other than `Const` → `return vec![]` (line 454).
- `attr_term` anything other than `Const` → `return vec![]` (line 466).
- `value_term`: Var binds, Const filters, Wildcard succeeds if attr exists.

Plan says: `attr(id, name, val)` — `can_place` when `id` is Const OR id_var in bound. Provides `val_var` if free.

**Verification:** The code checks `id_term` for `Const` only. After `substitute_atom()`, a bound Var becomes `Const`. So the condition "id_var in bound" is correctly implemented via the substitution mechanism — not via a run-time check in `eval_attr`. The `can_place` classification in `reorder_literals` must check whether the variable is in `bound`, which is correct in the plan. **MATCH.**

**GAP FOUND:** The plan's classification table omits the `attr_term` (the attribute name at position 1). The code also returns empty if `attr_term` is not `Const` (line 466). In standard Datalog usage, attribute names are always constants, so this is effectively never an issue. However, for correctness, the `can_place` function must also verify `attr_term` is `Const` or in `bound`. The plan only mentions `id`. **Minor gap.**

---

**Predicate: `attr_edge(Src, Dst, EdgeType, AttrName, Value)`**

Actual code (eval.rs:524–607):
- `src_term` must be `Const` (line 542) — else `return vec![]`.
- `dst_term` must be `Const` (line 552) — else `return vec![]`.
- `type_term` must be `Const` (line 558) — else `return vec![]`.
- `attr_term` must be `Const` (line 564) — else `return vec![]`.
- `value_term`: Var binds, Const filters, Wildcard succeeds.

Plan says: `attr_edge(src, dst, etype, name, val)` — `can_place` when src, dst, etype all Const or in bound. Provides `val_var`.

**GAP FOUND:** The plan omits `AttrName` (position 3). The code also requires `attr_term` to be Const. This is practically always true, but the `can_place` predicate as specified in the plan is incomplete. Same observation as for `attr`. **Minor gap.**

**GAP FOUND (more significant):** `attr_edge` is absent from `eval_explain.rs::eval_atom()`. When a user writes `attr_edge(...)` and uses `EvaluatorExplain`, it falls through to `eval_derived()`, which looks for a user-defined rule named `attr_edge` — finding none, returns empty. This means that in explain mode, ANY reordering involving `attr_edge` may produce wrong results for the `EvaluatorExplain` path. The plan says "do NOT touch the pre-existing `attr_edge` absence in `eval_explain.rs::eval_atom()` — out of scope." This is correct scoping for this task, but the `reorder_literals()` function in `utils.rs` will classify `attr_edge` as "requires Src, Dst, EdgeType bound" — and in `eval_explain`, even when those ARE bound, `eval_atom` will still return empty (via `eval_derived` finding no rule). **Pre-existing bug, not introduced by this plan. Acknowledged. Out of scope.**

---

**Predicate: `edge(Src, Dst, Type)`**

Actual code (eval.rs:256–368):
- `src_term == Const` → `get_outgoing_edges(src_id)`, provides Dst (and Type) if Var. Efficient.
- `src_term == Var` → `get_all_edges()`, full scan, provides Src and Dst if Var.
- `src_term == Wildcard` → hits `_ => vec![]`, returns empty.

Plan says: `edge(Const, V_dst, ...)` — always, provides `{V_dst}` if free, type_var if free. **MATCH.**
Plan says: `edge(V_src, V_dst, ...)` src free — always (full scan), provides free vars. **MATCH.**

**GAP FOUND:** Wildcard in Src position returns empty. Not covered in plan. Same as node — unlikely in practice but technically missing. **Low severity.**

---

**Predicate: `incoming(Dst, Src, Type)`**

Actual code (eval.rs:371–432):
- `dst_term == Const` → `get_incoming_edges(dst_id)`, provides Src and Type if Var. Efficient.
- `dst_term == Var` → `return vec![]` (line 426–429).
- `dst_term == Wildcard` → hits `_ => vec![]`.

Plan says: `incoming(Const, V_src, ...)` — always, provides `{V_src}`. **MATCH.**
Plan says: `incoming(V_dst, ...)` dst free — dst_var in bound (cannot place if free). **MATCH.** Returns empty if dst is unbound, so `can_place` must require dst to be in `bound`.

**Verification of can_place logic:** The plan correctly identifies that `incoming` with unbound dst cannot be placed first — doing so returns empty. The algorithm must wait until dst is bound. **CORRECT.**

---

**Predicate: `path(Src, Dst)`**

Actual code (eval.rs:609–677):
- `(Const, Const)` → BFS check.
- `(Const, Var)` → BFS, provides Dst.
- `(Const, Wildcard)` → BFS, any reachable?
- `(_, *)` where Src is Var or Wildcard → `_ => vec![]`.

Plan says: `path(Const, V_dst)` — always, provides `{V_dst}`. **MATCH.**
Plan says: `path(V_src, *)` src free — src_var in bound, provides `{}`. **MATCH.**

**CRITICAL GAP FOUND:** The plan's provides row for `path(V_src, *)` says `provides {}`. This is correct (path is a pure check when Dst is already bound or wildcard, and you cannot bind Src from path). BUT: the can_place condition says "src_var in bound." This means when src IS bound (has been substituted to Const), path(Const, V_dst) CAN be placed and PROVIDES V_dst. The plan captures this correctly. **MATCH.**

---

**Predicate: `neq(X, Y)`**

Actual code (eval.rs:680–707):
- Both `args[0]` and `args[1]` must be `Const` — else `return vec![]`.
- Returns `Bindings::new()` if not equal, else `vec![]`. Provides nothing.

Plan says: `neq(...)` — `can_place` when all Var args in bound. Provides `{}`. **MATCH.**

---

**Predicate: `starts_with(X, Prefix)`**

Actual code (eval.rs:709–734):
- Both `args[0]` and `args[1]` must be `Const` — else `return vec![]`.

Plan says: all Var args in bound, provides `{}`. **MATCH.**

---

**Predicate: `not_starts_with(X, Prefix)`**

Actual code (eval.rs:736–761):
- Both `args[0]` and `args[1]` must be `Const` — else `return vec![]`.

Plan says: all Var args in bound, provides `{}`. **MATCH.**

---

**Predicate: Derived (user-defined)**

Actual code (eval.rs:764–785):
- Looks up `self.rules.get(atom.predicate())`.
- If no rules: `return vec![]`.
- Evaluates each matching rule body, projects to head.
- eval_rule_body is also affected by reordering.

Plan says: unknown predicates — always (safe fallback), provides `{}`.

**GAP FOUND (SIGNIFICANT):** The plan's fallback for unknown predicates says "always (safe fallback), provides `{}`." This is incorrect in an important case. If a user-defined derived predicate `foo(X)` is used and X is free, the `reorder_literals` will treat it as "always placeable" and "provides nothing." This means X will remain unbound after evaluating `foo(X)`, and any subsequent literal requiring X will be placed before `foo(X)` binds nothing. The plan acknowledges unknown predicates but does not reason about what variables they provide.

**The correct behavior for user-defined predicates** should be: the predicate provides all Var arguments in its head arity, regardless of which are currently free. More precisely, after `eval_derived` returns bindings, those bindings contain exactly the variables that were projected from the matching rule's head (see `project_to_head` at line 851). So if `foo(X)` is a derived predicate, its evaluation CAN provide X.

However, to implement this correctly, `reorder_literals` would need to know the arity and variable positions of derived predicates — which requires parsing rule heads or maintaining a schema. The plan's safe fallback of "always, provides `{}`" will at minimum not deadlock (the literal can always be placed), but it will NOT correctly advance the bound set. If `foo(X)` can only meaningfully provide X after being evaluated, subsequent uses of X may be misclassified as "requires X bound" and get blocked.

**Risk assessment:** The consequence is that for derived predicates, the reordering may produce suboptimal or incorrect ordering. For example:
```
attr(X, "name", N), foo(X)
```
If `foo(X)` is derived and provides X (via its rule), the plan would say `attr` cannot be placed (X not bound) and `foo` can be placed (always). `foo` goes first, X gets bound, then `attr` goes. This is actually correct behavior! The plan's fallback accidentally works because `foo` is always placeable, so it will be placed before constraints requiring X.

The failure case: if the derived predicate provides nothing meaningful (returns empty bindings for all args), then placing it early is harmless. If it does provide variables, placing it early is beneficial. The only real problem is if a derived predicate REQUIRES variables to be bound to function correctly (like `attr` does) — but user-defined Datalog rules don't have this property: their body gets reordered internally by `eval_rule_body` (which also calls `reorder_literals`).

**Revised assessment:** The fallback is safe but incomplete for the `provides` side. Since derived predicates will have their own `eval_rule_body` reordered, and they always attempt evaluation regardless of bindings, the worst case is a full scan for derived predicates with unbound args — but not incorrectness. **Medium severity gap in documentation/correctness, low practical impact.**

---

### Summary Table

| Predicate | Plan `can_place` | Plan `provides` | Code behavior | Plan correct? |
|-----------|-----------------|-----------------|---------------|---------------|
| `node(Var, Const)` | always | `{V_id}` | find_by_type | YES |
| `node(Const, Var)` | always | `{V_type}` | get_node | YES |
| `node(Var, Var)` | always | `{V1, V2}` | full scan | YES |
| `node(Const, Const)` | always | `{}` | existence check | YES |
| `node(Wildcard, *)` | [not addressed] | [not addressed] | returns `vec![]` | MISSING (minor) |
| `attr(id, name, val)` | id Const or in bound | `val_var` if free | needs id Const; also needs name Const | INCOMPLETE (name omitted) |
| `attr_edge(...)` | src,dst,etype Const/bound | `val_var` | also needs attr_name Const | INCOMPLETE (attr_name omitted) |
| `edge(Const, Dst, Type)` | always | Dst,Type if Var | efficient lookup | YES |
| `edge(Var, Dst, Type)` | always | Src,Dst,Type if Var | full scan | YES |
| `incoming(Const, Src, Type)` | always | Src,Type if Var | efficient lookup | YES |
| `incoming(Var, ...)` | Var in bound | `{}` | returns empty if Var | YES |
| `path(Const, Var)` | always | `{Dst}` | BFS | YES |
| `path(Var, *)` | Var in bound | `{}` | returns empty if Var | YES |
| `neq(...)` | all Vars in bound | `{}` | returns empty if non-Const | YES |
| `starts_with(...)` | all Vars in bound | `{}` | returns empty if non-Const | YES |
| `not_starts_with(...)` | all Vars in bound | `{}` | returns empty if non-Const | YES |
| `Negative(atom)` | all Vars in atom in bound | `{}` | semantics require bound | YES |
| Unknown/derived | always (safe fallback) | `{}` | attempts eval | INCOMPLETE (may provide vars) |

---

## 2. Algorithm Correctness

### Claim: The greedy approach always finds a valid ordering when one exists.

**Proof by invariant:**

Let `S` be the set of all literals in the query body. Define a valid ordering as a permutation `L_1, ..., L_n` of `S` such that for every `i`, `can_place(L_i, bound(L_1, ..., L_{i-1}))` is true.

**Invariant:** After placing `k` literals, the set `bound_k` contains all variables that were provided by those `k` literals. Any literal that was placeable at step `k` but not chosen remains in `remaining`.

**Greedy step:** At each step, find ANY literal in `remaining` where `can_place(L, bound_k)`. Place it. Extend `bound`.

**Correctness claim:** If a valid ordering exists, greedy always finds one.

**Proof:** Suppose valid ordering exists: `L_1, ..., L_n`. At step 1, `L_1` must be placeable with empty `bound`. Greedy finds some `L_j` that is also placeable. After greedy places `L_j`, we need to show a valid ordering still exists from the remaining literals.

Exchange argument: If `L_j != L_1`, we can reorder: `L_j, L_1, ..., L_{j-1}, L_{j+1}, ..., L_n`. The key question: does `L_1` remain placeable after `L_j` has extended `bound`?

Since `L_1` was placeable with empty `bound`, and greedy extended `bound` with `provides(L_j)`, `bound` has grown. Any literal placeable with the empty set is still placeable with a larger set (because `can_place` checks whether required vars ARE in bound, and a superset of bound satisfies more requirements). Therefore `L_1` remains placeable.

By induction, if a valid ordering exists, greedy finds one. **Proof complete.**

### Can greedy report false "circular dependency"?

No. Greedy reports error only when no literal in `remaining` is placeable. This means for EVERY remaining literal `L_i`, `can_place(L_i, bound_k)` is false. For this to happen when a valid ordering exists would require some remaining literal to have become un-placeable — but as shown above, placeability is monotone in `bound` (adding more bindings never makes a placeable literal unplaceable). Therefore if the greedy algorithm halts with an error, NO valid ordering exists. **Proven.**

### Can greedy produce an INCORRECT ordering (wrong semantics)?

Only if the `provides` classification is wrong. Specifically: if `provides(L)` under-reports (misses a variable that L actually binds), then `bound` will not include that variable, and subsequent literals requiring it may be misclassified as unplaceable or placed in wrong order.

**The attr_name omission:** For `attr`, the plan says `can_place` when `id` is bound. The code also requires `attr_name` to be Const (line 466). In practice, users always write `attr(X, "name", V)` with constant attr names, so `attr_name` is always Const and this gap does not produce wrong results. But a user-defined atom `attr(X, Y, V)` with variable attr_name would fail silently. **Acceptable risk given current Datalog practice.**

---

## 3. Edge Cases

**Empty literal list (no body):**
The algorithm: `remaining.is_empty()` → returns `Ok(result)` immediately. `result` is `[]`. Callers then iterate over `[]` of literals — the loop does nothing, `current` stays as `[Bindings::new()]`. Result: one empty binding. This is correct (facts always hold). **HANDLED correctly.**

**Single literal body:**
Greedy: one literal in `remaining`, checks `can_place`. If placeable, places it, done. If not placeable (e.g., `attr(X, "name", N)` with X free and no other literals), returns `Err`. This is correct — such a query is unsatisfiable. **HANDLED correctly.**

**All literals are constraints (neq/starts_with/not_starts_with) — no providers:**
Example: `neq(X, Y), starts_with(Z, "prefix")`. None of these provide bindings. All require all vars to be in `bound`. With empty initial `bound`, none are placeable. Returns `Err("circular dependency")`.

**CORRECTNESS ISSUE:** This is a legitimate query if X, Y, Z are somehow bound externally (not possible in the current system) or if there are constants everywhere: `neq("a", "b"), starts_with("abc", "prefix")`. In the constant-only case, the vars ARE Const (not Var), so `can_place` returns true (no free vars to require). **Correct for that case.**

For the genuine all-constraint-no-producer case with free variables, returning `Err` is the correct behavior — the query is unsatisfiable. **HANDLED correctly.**

**Variable appears only in head, not body (free variable in head):**
`reorder_literals` operates only on the body literals. Head variables are irrelevant to reordering. The `Rule::is_safe()` method (types.rs:206–216) checks that all head vars appear in positive body literals — this is a separate concern. If a rule is unsafe (head var not in body), that's a semantic error caught at rule-load time, not at query time. `reorder_literals` does not need to handle this. **NOT AN ISSUE for reordering.**

**Wildcard (`_`) in various positions:**
- `node(X, _)`: `_` in type position. In `eval_node`, this hits the `(Term::Var, Term::Wildcard)` arm... wait.

**CRITICAL GAP:** Looking at `eval_node` again:
```rust
match (id_term, type_term) {
    (Term::Var(var), Term::Const(node_type)) => { ... }
    (Term::Const(id_str), Term::Var(var)) => { ... }
    (Term::Const(id_str), Term::Const(expected_type)) => { ... }
    (Term::Var(id_var), Term::Var(type_var)) => { ... }
    _ => vec![],
}
```

The `(Term::Var(var), Term::Wildcard)` case hits `_ => vec![]`. This means `node(X, _)` returns **empty**, even though semantically it should find all nodes (binding X to each node id). This is a pre-existing limitation in the evaluator, not caused by reordering. However, the plan's `provides` classification assumes `node(V1, Wildcard)` would provide V1 — but the code would return empty. The plan does not address this.

**The wildcard issue is pre-existing and out of scope for this PR**, but the `reorder_literals` function should NOT classify `node(X, _)` as "always, provides {X}" because the evaluator will return empty for it. The correct classification is "always, provides {}" — it can be placed but provides nothing (and returns empty, eliminating all bindings).

In practice: users rarely write `node(X, _)` since it returns empty. But if they do, the reordering won't help — the empty result kills the query regardless of order. **The plan should document this limitation; currently it does not. Low practical severity.**

**Constants in all positions (no variables at all):**
`node("123", "CALL"), attr("123", "name", "foo")`. All terms are Const. `can_place` returns true immediately for both (no free vars). `provides` returns `{}` for both. The algorithm places them in original order. Correct. **HANDLED.**

**Mixed: some args Const, some Var, some Wildcard:**
`edge("123", X, _)`. Src is Const, Dst is Var, Type is Wildcard. `eval_edge` with Const src calls `get_outgoing_edges`, iterates. For each edge, `dst_term == Var(X)` binds X. `type_term == Wildcard` is handled via `if let Some(Term::Var(var)) = type_term` which is false for Wildcard, so type is not bound. Returns bindings with X only.

Plan's classification: `edge(Const, V_dst, ...)` — always, provides `{V_dst}` if free, type_var if free. With Wildcard for type, no type var is free/provided. **CORRECTLY handled by the "if free" qualification.**

**Predicate not in the known list (user-defined derived predicates):**
As analyzed in Section 1 — fallback is "always, provides `{}`". This is safe but may miss variables the predicate would provide. **Documented gap.**

---

## 4. Result Type Change Impact

### Critical Finding: EvaluatorExplain::eval_query() returns QueryResult, NOT Vec<Bindings>

This is the most significant gap in the plan.

Looking at the actual signatures:

**eval.rs:**
```rust
pub fn eval_query(&self, literals: &[Literal]) -> Vec<Bindings>   // current
```

**eval_explain.rs:**
```rust
pub fn eval_query(&mut self, literals: &[Literal]) -> QueryResult  // current
```

The plan says both should become:
```rust
pub fn eval_query(&self, literals: &[Literal]) -> Result<Vec<Bindings>, String>
```

**But `EvaluatorExplain::eval_query()` currently returns `QueryResult`, not `Vec<Bindings>`.** The plan treats them as parallel, but they have different return types RIGHT NOW.

The plan must specify: does `EvaluatorExplain::eval_query()` become `Result<QueryResult, String>`, or does it change in some other way?

Looking at `rfdb_server.rs` call sites:
- Line 1854: `let result = evaluator.eval_query(&literals);` then `query_result_to_wire_explain(result)` — consuming `QueryResult`.
- Line 1858: `let bindings = evaluator.eval_query(&literals);` then `.into_iter()` — consuming `Vec<Bindings>`.

These two call sites have DIFFERENT expectations right now. The plan needs to be explicit:

1. `Evaluator::eval_query` → becomes `Result<Vec<Bindings>, String>`. Caller at line 1858 adds `?`.
2. `EvaluatorExplain::eval_query` → becomes `Result<QueryResult, String>`. Caller at line 1854 adds `?` and passes the inner `QueryResult` to `query_result_to_wire_explain`.

**The plan section 3.2 correctly identifies the change for eval.rs but section 3.3 is ambiguous** — it says "Identical changes" but the return type is NOT identical because EvaluatorExplain currently wraps in `QueryResult`. The implementor must not apply identical changes. **This is a SIGNIFICANT clarity gap that could cause a wrong implementation.**

### eval_explain.rs::eval_rule_body and eval_derived

`eval_explain.rs::eval_rule_body` (line 768) currently returns `Vec<Bindings>`. This is internal (not pub). The plan says change to `Result<Vec<Bindings>, String>`.

`eval_explain.rs::eval_derived` (line 745) currently returns `Vec<Bindings>`. The plan says propagate `?` from `eval_rule_body`.

The `eval_explain.rs::eval_atom()` takes `&mut self` and returns `Vec<Bindings>`. `eval_derived` is called from there. If `eval_derived` becomes `Result<Vec<Bindings>, String>`, then `eval_atom` must also become `Result` — which changes the entire call chain including `record_step`. **The plan does not address this cascade.** This could either be:
- Propagate all the way up through `eval_atom` to `eval_query` (large change), or
- Convert errors at `eval_rule_body` boundary (keep `eval_atom` returning `Vec<Bindings>`, handle errors internally)

The plan is silent on this architectural choice. **This is a significant implementation gap.**

### rfdb_server.rs call sites — complete enumeration

The plan lists 4 call sites (lines ~1854, ~1858, ~1920, ~1924). Let me verify against the actual code:

- Line 1854: `evaluator.eval_query(&literals)` → `QueryResult`. CORRECT in plan's list.
- Line 1858: `evaluator.eval_query(&literals)` → `Vec<Bindings>`. CORRECT in plan's list.
- Line 1920: `evaluator.eval_query(&literals)` → `QueryResult`. CORRECT in plan's list.
- Line 1924: `evaluator.eval_query(&literals)` → `Vec<Bindings>`. CORRECT in plan's list.

Also at rfdb_server.rs line 1891: `evaluator.query(head)` — this is `EvaluatorExplain::query()`, not `eval_query()`. Returns `QueryResult` directly via `eval_atom`. NOT affected by the reordering of `eval_query` since it uses `eval_atom` directly. **However, if the user calls query with a derived predicate, `eval_rule_body` IS invoked.** This is a call path: `query → eval_atom → eval_derived → eval_rule_body`. If `eval_rule_body` returns `Result`, this chain must handle it.

Lines 1898–1899: `evaluator.query(head)` for plain `Evaluator`. Same concern.

**Additional call path through NAPI (napi_bindings.rs):**
The `check_guarantee` function (line 539) calls `evaluator.query(&violation_query)` which calls `eval_atom` which may call `eval_derived` which calls `eval_rule_body`. If `eval_rule_body` changes to `Result`, `eval_derived` must handle it, and `eval_atom` must handle it, and `query` must handle it.

**The plan identifies `eval_derived` as needing `?` propagation (section 3.2), but does NOT mention the impact on `query()` and `eval_atom()`.** If `eval_rule_body` → `Result`, and `eval_derived` propagates `?`, then `eval_derived` returns `Result`. Then `eval_atom` must return `Result`. Then `query()` must return `Result`. This means NAPI's `check_guarantee` must also change.

**This is a CASCADE EFFECT the plan DOES NOT address.**

Two possible resolutions:
1. Only propagate the error in `eval_query` and `eval_rule_body`, and in `eval_derived` convert errors to empty results (log the error). This limits the cascade but loses error information.
2. Propagate all the way — larger change, correct.

The plan chooses neither explicitly. **This is the most significant gap in the plan.**

### napi_bindings.rs

The plan says "napi_bindings.rs does not call eval_query() directly." This is correct for direct `eval_query` calls. But as shown above, it calls `evaluator.query()` → `eval_atom()` → `eval_derived()` → `eval_rule_body()`. If the cascade changes, NAPI is affected. **The plan's claim is partially correct but the indirect impact is unaddressed.**

### tests.rs

Tests call `evaluator.eval_query()` directly. After the return type change, tests must handle `Result`. The plan notes this in section 3.5 but does not explicitly say to update existing tests to unwrap/handle the new Result. The 1500+ lines of existing tests in `mod eval_tests` will FAIL TO COMPILE if `eval_query` returns `Result` and they do not handle it. **Plan needs to explicitly state: update existing test call sites.**

---

## 5. Test Coverage Gaps

### Tests the plan provides (8 tests)

**Test 1 (attr before node):** Correct. This is the primary bug. Good.

**Test 2 (negation before positive):** Correct. Tests stratification.

**Test 3 (already correct order):** Correct. Regression guard.

**Test 4 (circular dependency returns Err):** Correct. BUT the example given `attr(X, .., Y), attr(Y, .., X)` may not actually be "circular" in the sense meant. With the plan's classification, both `attr(X, .., Y)` and `attr(Y, .., X)` require their first arg to be bound. Neither X nor Y starts bound. Neither can be placed. So `Err` is returned. This IS a correct circular dependency scenario. The test is valid.

**Test 5 (multi-variable chain):** Correct. Tests chained dependencies: node → attr → edge → attr. Good.

**Test 6 (constraints after bindings):** Correct. Tests constraint predicates.

**Test 7 (rule body reordering):** Correct. Tests `eval_rule_body` path.

**Test 8 (incoming with unbound dst):** Correct.

### Missing tests

**Missing Test A: reorder_literals unit test (pure function test)**
The plan tests `eval_query` end-to-end. There are no unit tests for `reorder_literals` itself. Unit tests should verify:
- `reorder_literals` on wrong-order literals returns them in correct order.
- `reorder_literals` on already-correct order preserves order.
- `reorder_literals` on empty list returns `Ok([])`.
- `reorder_literals` on circular dependency returns `Err`.
Direct unit tests of `reorder_literals` would make the algorithm's correctness independently verifiable without needing a graph database.

**Missing Test B: Wildcard handling in reordered queries**
No test for queries containing `_` wildcards, e.g., `path(X, _), node(X, "CALL")`.

**Missing Test C: Derived predicate with reordering**
Test 7 tests `starts_with` which is a built-in. There is no test where a user-defined derived predicate appears in wrong order relative to its dependencies. Example:
```
caller(X) :- foo(X, N), node(X, "CALL").
foo(X, N) :- attr(X, "name", N).
```
When `foo(X, N)` is in the rule body before `node(X, "CALL")`, does reordering correctly place `node` first, allowing `foo` to bind X?
Actually, with the plan's "derived predicate — always placeable, provides nothing" fallback, `foo(X, N)` would be placed first (always placeable), X remains unbound afterward, and `node(X, "CALL")` also gets placed (always placeable), providing X. But `attr(X, ...)` inside `foo`'s rule body would then fail because X is still unbound at the time `foo` is evaluated (before `node`). This illustrates the derived predicate `provides {}` gap.

**Missing Test D: attr with Wildcard value**
`attr(X, "name", _)` — wildcarded value. Code handles Wildcard at value_term (line 508: `Term::Wildcard => vec![Bindings::new()]`). Reordering should still place `node(X, ...)` before this. No test for this.

**Missing Test E: Verify existing tests still pass after Result type change**
The plan says add new tests, but existing tests must also be updated to handle `Result<Vec<Bindings>, String>` instead of `Vec<Bindings>`. This is compilation-level but should be explicitly planned.

**Missing Test F: path with reordering**
No explicit test for `path(X, _), node(X, "CALL")` reordering. Test 2 uses `\+ path(X, _)` (negative), but there is no test for positive `path` with wrong ordering.

---

## 6. Additional Architectural Observations

### EvaluatorExplain takes `&mut self` but Evaluator takes `&self`

The plan proposes:
```rust
// eval.rs
pub fn eval_query(&self, literals: &[Literal]) -> Result<Vec<Bindings>, String>

// eval_explain.rs
pub fn eval_query(&mut self, literals: &[Literal]) -> Result<Vec<Bindings>, String>
```

But `EvaluatorExplain::eval_query` currently returns `QueryResult`, not `Vec<Bindings>`. The "identical changes" instruction in section 3.3 is wrong. The implementor needs explicit guidance: `EvaluatorExplain::eval_query` returns `Result<QueryResult, String>`, not `Result<Vec<Bindings>, String>`.

### The `reorder_literals` function is independent of both evaluators

This is correctly placed in `utils.rs`. The function takes `&[Literal]` and returns `Result<Vec<Literal>, String>`. It does not touch `self`, the engine, or any bindings. **This is correct design.**

### Idempotency when already ordered

The plan claims: "if the input is already correctly ordered, the greedy algorithm will always pick the first remaining literal at each step, producing the same order."

**Proof:** If at each step the first literal in `remaining` is placeable, greedy picks it (since it scans from position 0). Input order is preserved. **Correct claim.**

But: if the first literal is NOT placeable but the second IS, greedy picks the second. This means even for "mostly correct" orderings with one out-of-place literal, the algorithm may reorder more than the minimum necessary. This is acceptable but the plan's phrasing "zero overhead" is misleading for the case where a non-minimal shuffle happens. Semantically correct in all cases.

---

## 7. Final Verdict

### Blocking Issues (MUST fix before implementation)

**B1. Return type cascade for eval_derived/eval_atom/query() chain:**
The plan says `eval_derived` propagates `?` from `eval_rule_body`. If `eval_rule_body` returns `Result`, then `eval_derived` must return `Result`, then `eval_atom` must return `Result`, then `query()` must return `Result`. The plan does not specify how to handle this cascade. Without explicit guidance, the implementor will either:
- Break NAPI and the server's `query()` path, or
- Make an ad-hoc choice that may not match the team's intent.

**The implementor must decide and document:** Does the error boundary stop at `eval_query()`/`eval_rule_body()` (errors converted to empty results internally in `eval_derived`), or does it propagate all the way through `eval_atom` and `query()`?

Recommendation: Stop at `eval_rule_body`. In `eval_derived`, if `eval_rule_body` returns `Err`, treat as empty results (log the error). This minimizes the cascade and keeps `eval_atom` and `query()` at their current types. Then `eval_query` propagates via `?` cleanly. **This must be explicitly stated in the plan.**

**B2. EvaluatorExplain::eval_query return type ambiguity:**
The plan says "Identical changes" for `eval_explain.rs` but `EvaluatorExplain::eval_query` currently returns `QueryResult`, not `Vec<Bindings>`. The correct new signature is `Result<QueryResult, String>`, not `Result<Vec<Bindings>, String>`. The plan must explicitly state this difference.

**B3. Existing test call sites:**
After `eval_query` changes to return `Result`, all existing tests that call `evaluator.eval_query(...)` without handling `Result` will fail to compile. The plan must explicitly state: update existing test call sites to unwrap the result (e.g., `.unwrap()` or `.expect("...")`).

### Non-Blocking Issues (should be addressed but do not block)

**N1. Derived predicate `provides` classification:**
The plan says derived predicates provide `{}`. This is safe but suboptimal. The implementor should be aware that derived predicates CAN provide variables (they do — via `project_to_head`). The "always, provides `{}`" fallback means derived predicates are always placed as early as possible, which is actually beneficial for bottom-up evaluation. Low impact on correctness.

**N2. Missing unit tests for `reorder_literals` itself:**
Add direct tests for the `reorder_literals` function in `utils.rs`, independent of the evaluator. This is good engineering practice that the plan omits.

**N3. Wildcard behavior documentation:**
The plan does not document that `node(X, _)`, `edge(_, Y, ...)`, etc., with wildcards in binding positions return empty from the current evaluator. Reordering these queries will not help because the underlying evaluator already returns empty.

**N4. attr_name (second arg to attr) in can_place:**
The `can_place` check for `attr` should also verify the attribute name is constant (or in bound), not just the node id. In practice, attribute names are always constants so this has no real impact.

---

## VERDICT: REJECT

The plan has two blocking issues that could cause the implementor to produce a broken implementation:

1. **The cascade from `eval_rule_body → eval_derived → eval_atom → query()` is unaddressed.** Without explicit guidance on where errors are caught, the implementor will make a potentially wrong ad-hoc decision.

2. **`EvaluatorExplain::eval_query` currently returns `QueryResult`, not `Vec<Bindings>`.** The plan's "identical changes" instruction is wrong and will cause a compilation error or incorrect signature.

The plan is otherwise sound: the algorithm is correct (proven), the predicate classifications are mostly correct, the test plan is comprehensive (though missing unit tests for `reorder_literals`), and the architecture (placing the function in `utils.rs`) is correct.

**Required fixes before approval:**
1. Explicitly state the error boundary decision: errors from `eval_rule_body` are caught inside `eval_derived` and converted to empty results (or alternative explicit decision).
2. Fix section 3.3 to explicitly state that `EvaluatorExplain::eval_query` changes to `Result<QueryResult, String>`, NOT `Result<Vec<Bindings>, String>`.
3. Add explicit instruction to update existing test call sites to handle the new `Result` type.
4. Add unit tests for `reorder_literals` as a standalone function (no graph required).
