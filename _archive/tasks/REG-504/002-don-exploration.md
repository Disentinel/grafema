# REG-504: Don Melton Exploration Report
# Datalog Query Reordering — Bound Variables First

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-19
**Status:** Exploration complete

---

## 1. Codebase Location

All Datalog code lives in:

```
packages/rfdb-server/src/datalog/
  mod.rs        — module declarations, re-exports
  types.rs      — Term, Atom, Literal, Rule, Program data structures
  parser.rs     — hand-written recursive-descent parser
  eval.rs       — main Evaluator (plain, no instrumentation)
  eval_explain.rs — EvaluatorExplain (profiling + explain steps)
  utils.rs      — get_metadata_value() helper for JSON metadata
  tests.rs      — all tests (2103 lines)
```

---

## 2. Data Structures

### `Term` (`types.rs:7-62`)
```rust
pub enum Term {
    Var(String),    // uppercase identifier, e.g. X, Queue
    Const(String),  // quoted string, e.g. "queue:publish"
    Wildcard,       // _
}
```

### `Atom` (`types.rs:65-107`)
```rust
pub struct Atom {
    predicate: String,
    args: Vec<Term>,
}
```
Has `variables() -> HashSet<String>` which collects only `Var` terms.

### `Literal` (`types.rs:110-148`)
```rust
pub enum Literal {
    Positive(Atom),   // atom
    Negative(Atom),   // \+ atom
}
```

### `Rule` (`types.rs:151-217`)
```rust
pub struct Rule {
    head: Atom,
    body: Vec<Literal>,
}
```
`body()` returns `&[Literal]` — **this is the sequence that must be reordered.**

### `Bindings` (`eval.rs:47-91`)
```rust
pub struct Bindings {
    map: HashMap<String, Value>,
}
```
`extend()` merges two bindings, returning `None` on conflict (same var, different value).

### `Value` (`eval.rs:11-43`)
```rust
pub enum Value {
    Id(u128),
    Str(String),
}
```

---

## 3. The Evaluator

### `Evaluator` (`eval.rs:94-868`)

Two public entry points that process literals in sequence:

**`eval_query()` (line 130-170):** Takes `&[Literal]`, used for raw conjunctive queries.

```rust
pub fn eval_query(&self, literals: &[Literal]) -> Vec<Bindings> {
    let mut current = vec![Bindings::new()];
    for literal in literals {       // <--- LEFT-TO-RIGHT, NO REORDERING
        let mut next = vec![];
        for bindings in &current {
            match literal {
                Literal::Positive(atom) => {
                    let substituted = self.substitute_atom(atom, bindings);
                    let results = self.eval_atom(&substituted);
                    for result in results {
                        if let Some(merged) = bindings.extend(&result) {
                            next.push(merged);
                        }
                    }
                }
                Literal::Negative(atom) => {
                    let substituted = self.substitute_atom(atom, bindings);
                    let results = self.eval_atom(&substituted);
                    if results.is_empty() {
                        next.push(bindings.clone());
                    }
                }
            }
        }
        current = next;
        if current.is_empty() { break; }
    }
    current
}
```

**`eval_rule_body()` (line 788-828):** Identical logic, used when evaluating user-defined rules.

Both functions share the same literal-iteration pattern — **the fix must go in both places** (or be extracted to a shared helper that both call after reordering).

**`substitute_atom()` (line 831-848):** Before calling `eval_atom()`, known bindings are substituted into the atom — variables that are already bound become constants. This is why order matters: a Var that hasn't been substituted yet remains a Var, triggering the expensive/empty fallback paths.

### `EvaluatorExplain` (`eval_explain.rs`)

Parallel implementation that additionally:
- Collects `ExplainStep` records per predicate call
- Tracks `QueryStats` (nodes_visited, edges_traversed, etc.)
- Times each predicate with `Instant::now()`

`eval_query()` (line 154-191) and `eval_rule_body()` (line 768-804) are **structurally identical** to `Evaluator` — same loop, same left-to-right order. Both also need the fix.

**Note:** `eval_explain.rs` does NOT include `attr_edge` in its `eval_atom()` match (line 258-268). `eval.rs` does. This is a pre-existing divergence, not our concern for REG-504.

---

## 4. Predicate Semantics: What Each Provides and Requires

This is the critical analysis for the reordering algorithm.

### `node(Id, Type)` (`eval.rs:189-253`)
| Pattern | Id Binding | Type Binding | Behavior |
|---------|-----------|--------------|----------|
| `node(Var, Const)` | **PROVIDES** Id | already bound | `find_by_type(type)` — efficient |
| `node(Const, Var)` | already bound | **PROVIDES** Type | `get_node(id)` |
| `node(Const, Const)` | already bound | already bound | check existence |
| `node(Var, Var)` | **PROVIDES** Id, Type | — | enumerate ALL nodes — very expensive |

**Requires:** At least the type to be constant for efficient lookup. With both free, does a full scan.
**Provides:** Id and/or Type depending on which are Var.

### `attr(NodeId, AttrName, Value)` (`eval.rs:438-512`)
**Requires:** NodeId to be a bound constant. Returns empty if unbound.
**Provides:** Value (if it's a Var and the attribute exists).
**Requires:** AttrName to be a constant.

```rust
let node_id = match id_term {
    Term::Const(id_str) => ...,
    _ => return vec![], // Need bound ID for now
};
```

This is the central bug: if `attr(X, ...)` comes before `node(X, "TYPE")`, X is still a `Var` when attr is evaluated.

### `attr_edge(Src, Dst, EdgeType, AttrName, Value)` (`eval.rs:524-607`)
**Requires:** Src, Dst, EdgeType, AttrName all bound (constants). Returns empty if any is unbound.

### `edge(Src, Dst, Type)` (`eval.rs:256-368`)
| Src | Behavior |
|-----|----------|
| `Const` | `get_outgoing_edges(src_id)` — efficient |
| `Var` | `get_all_edges()` + filter — expensive full scan |

**Provides:** Dst and/or Type (if Var).
**Requires:** For efficiency, Src should be bound. Works with unbound Src via full scan.

### `incoming(Dst, Src, Type)` (`eval.rs:371-432`)
| Dst | Behavior |
|-----|----------|
| `Const` | `get_incoming_edges(dst_id)` — efficient |
| `Var` | Returns `vec![]` immediately — **broken if unbound** |

**Requires:** Dst bound (returns empty if not).
**Provides:** Src, Type.

### `path(Src, Dst)` (`eval.rs:609-677`)
| Pattern | Behavior |
|---------|----------|
| `(Const, Const)` | BFS check |
| `(Const, Var)` | BFS, bind all reachable |
| `(Const, Wildcard)` | BFS, any reachable? |
| `(Var, *)` | Returns `vec![]` — **broken if Src unbound** |

**Requires:** Src bound.
**Provides:** Dst (if Var).

### `neq(X, Y)` (`eval.rs:680-707`)
**Requires:** Both arguments bound (constants). Returns empty if either is Var.
**Provides:** Nothing (pure filter/constraint).

### `starts_with(X, Prefix)` / `not_starts_with(X, Prefix)` (`eval.rs:709-761`)
**Requires:** Both arguments bound (constants). Returns empty if either is Var.
**Provides:** Nothing (pure filter/constraint).

---

## 5. Variable Binding Flow: The Core Problem

In `eval_query()` / `eval_rule_body()`, before calling `eval_atom()` the evaluator calls `substitute_atom()` which replaces bound variables with their values. So a variable `X` becomes `Const("123")` once it's been bound by a previous literal. **The binding state is carried in `bindings: &Bindings` which grows as literals are processed in order.**

**The bug:**
```datalog
violation(X) :- attr(X, "name", "eval"), node(X, "CALL").
```

1. Step 1: `attr(X, "name", "eval")` — X is unbound → `substitute_atom` leaves X as `Term::Var("X")` → `eval_attr` hits `_ => return vec![]` at line 454 → returns empty → current becomes empty → loop breaks early with empty result.

**The fix:** Before processing, reorder so that `node(X, "CALL")` (which provides X) comes before `attr(X, "name", "eval")` (which requires X).

---

## 6. Topological Sort Algorithm Design

Based on this analysis, here is the precise classification:

### Variable Provision Rules

For each literal, given the current set of bound variables:

| Predicate | Provides | Requires (for non-empty result) |
|-----------|----------|--------------------------------|
| `node(V, Const)` | V | nothing (can enumerate) |
| `node(V1, V2)` | V1, V2 | nothing (full scan, expensive) |
| `node(Const, V)` | V | nothing |
| `node(Const, Const)` | nothing | nothing |
| `attr(V_id, Const, V_val)` | V_val | V_id **must be bound** |
| `attr_edge(V1,V2,Const,Const,V_val)` | V_val | V1, V2 must be bound |
| `edge(Const, V_dst, ...)` | V_dst | nothing (has bound Src) |
| `edge(V_src, V_dst, ...)` | V_src, V_dst | nothing (full scan) |
| `incoming(Const, V_src, ...)` | V_src | nothing |
| `incoming(V_dst, ...)` | — | V_dst **must be bound** |
| `path(Const, V)` | V | nothing |
| `path(V, *)` | — | V **must be bound** |
| `neq(...)` | nothing | both args **must be bound** |
| `starts_with(...)` | nothing | both args **must be bound** |
| `not_starts_with(...)` | nothing | both args **must be bound** |

**Key insight:** The provision/requirement of each literal is **dynamic** — it depends on which variables are already bound when the literal is evaluated. The reordering must do a greedy topological sort:

```
bound = {} (empty set initially)
result = []
remaining = all literals

repeat:
  find any literal L in remaining such that:
    - L is positive AND L can be evaluated with current `bound` set
    - OR L is negative AND all vars in L's atom appear in `bound`
  if found:
    result.append(L)
    bound.extend(L.provides(bound))
    remaining.remove(L)
  else:
    error("circular dependency or unsatisfiable ordering")
until remaining is empty
```

The "can be evaluated" predicate per literal is:
- `attr(id_term, ...)`: id_term must be a Const OR be in `bound`
- `attr_edge(...)`: all of Src, Dst, EdgeType must be Const or in `bound`
- `incoming(dst_term, ...)`: dst_term must be Const or in `bound`
- `path(src_term, ...)`: src_term must be Const or in `bound`
- `neq`, `starts_with`, `not_starts_with`: all Var args must be in `bound`
- `node`, `edge`: always executable (can enumerate), but prefer after binding reduces cost
- Negative (`\+`): all Var terms in atom must be in `bound` (standard stratification requirement)

---

## 7. Where To Implement

The fix has **two insertion points**, both must be changed:

### Primary: `eval.rs`

**`eval_query()` — line 130:** Called from:
- `rfdb_server.rs:1854`, `1858`, `1920`, `1924` — the Unix socket server
- `tests.rs` — test suite

Add reordering as the first step:
```rust
pub fn eval_query(&self, literals: &[Literal]) -> Vec<Bindings> {
    let ordered = reorder_literals(literals)?;  // NEW
    let mut current = vec![Bindings::new()];
    for literal in &ordered {   // use ordered, not literals
        ...
    }
}
```

**`eval_rule_body()` — line 788:** Called from `eval_derived()` (line 774). Same change:
```rust
fn eval_rule_body(&self, rule: &Rule) -> Vec<Bindings> {
    let ordered = reorder_literals(rule.body())?;  // NEW
    ...
}
```

### Secondary: `eval_explain.rs`

**`eval_query()` — line 154** and **`eval_rule_body()` — line 768** — structurally identical, need the same change.

### Where to put the reordering logic

Options:
1. **New function in `eval.rs`**: `fn reorder_literals(literals: &[Literal]) -> Result<Vec<Literal>, ReorderError>`
2. **New function in `utils.rs`**: shared utility visible to both `eval.rs` and `eval_explain.rs`
3. **New module `reorder.rs`**: if logic is complex enough

**Recommendation:** Put in `utils.rs` as a `pub(crate)` function — it's already the shared utility module, and both evaluators import from it. This avoids duplication and keeps both `eval.rs` and `eval_explain.rs` in sync automatically.

---

## 8. Zero-Overhead Requirement (AC #3)

The acceptance criteria says "Order doesn't change if literals are already correctly ordered."

The topological sort naturally handles this: if the input is already correctly ordered, the greedy algorithm will always pick the first remaining literal at each step, producing the same order. The algorithm is `O(n²)` in the number of literals (or `O(n * p)` where p is the number of predicates), but queries are small (typically 3-10 literals), so this is irrelevant in practice.

The "zero overhead" criterion means **semantically correct results**, not necessarily zero computational cost. A comment clarifying this would help.

---

## 9. Negation Stratification (AC #2)

The standard requirement: negation must come **after** all positive literals that bind the same variables.

This is handled automatically by the topological sort if we classify negative literals as requiring ALL their free variables to be bound before they can be placed. Example:

```datalog
orphan(X) :- \+ path(X, _), node(X, "queue:publish").
```

- `\+ path(X, _)`: requires X in `bound`. At start, X not bound → can't place yet.
- `node(X, "queue:publish")`: can always execute. Provides X.

After sorting: `node(X, "queue:publish"), \+ path(X, _)` — correct.

---

## 10. Circular Dependency Error (AC #4)

If after trying all remaining literals none can be placed, there's a circular or unsatisfiable dependency. Return a clear error:

```rust
pub enum ReorderError {
    CircularDependency { stuck_literals: Vec<String> },
}
```

Example that could trigger it (pathological, not valid Datalog):
```
attr(X, "k", Y), attr(Y, "k", X)
```
Both require the other's variable. Neither can go first.

In practice, well-formed queries won't hit this because `node(X, type)` or `edge(X, Y, t)` always serve as "seed" producers with no requirements.

---

## 11. Existing Tests

`tests.rs` has the following structure relevant to REG-504:

- `mod eval_tests` (line 366): All evaluator tests, 1500+ lines
- Existing tests all use **correctly ordered** literals (e.g., `node` before `attr`)
- No tests exist that explicitly test wrong-order queries — **these are the tests we must add**

Test patterns to add (per AC #5):
```rust
// Wrong order: attr before node
let wrong_order = parse_query("attr(X, \"name\", N), node(X, \"CALL\")").unwrap();
let correct_order = parse_query("node(X, \"CALL\"), attr(X, \"name\", N)").unwrap();
assert_eq!(evaluator.eval_query(&wrong_order), evaluator.eval_query(&correct_order));

// Wrong order: \+ before positive
let wrong_neg = parse_query("\\+ path(X, _), node(X, \"queue:publish\")").unwrap();
let correct_neg = parse_query("node(X, \"queue:publish\"), \\+ path(X, _)").unwrap();
assert_eq!(evaluator.eval_query(&wrong_neg), evaluator.eval_query(&correct_neg));

// Already correct order: same result, check it doesn't break
let already_correct = parse_query("node(X, \"CALL\"), attr(X, \"name\", N)").unwrap();
// ... verify unchanged
```

---

## 12. eval vs eval_explain: Relationship

These are **independent implementations** that share no code. Both `Evaluator` and `EvaluatorExplain` implement all predicates independently. The `eval_explain.rs` version adds:
- `stats: QueryStats` — counter tracking
- `explain_steps: Vec<ExplainStep>` — step recording via `record_step()`
- `predicate_times: HashMap<String, Duration>` — per-predicate timing

The reordering logic, when implemented, must be added to **both evaluators** independently. This is the DRY violation to watch for — if we extract to `utils.rs`, both can call the same function.

**Important divergence:** `eval_explain.rs::eval_atom()` (line 254-274) does NOT handle `attr_edge` — it falls through to `eval_derived()`. This is a separate pre-existing bug, not our concern.

---

## 13. Integration Points Summary

All callers of the affected functions:

| Caller | File | Line | Function Called |
|--------|------|------|-----------------|
| `execute_datalog_query()` | `rfdb_server.rs` | 1854 | `EvaluatorExplain::eval_query()` |
| `execute_datalog_query()` | `rfdb_server.rs` | 1858 | `Evaluator::eval_query()` |
| `execute_datalog()` | `rfdb_server.rs` | 1920 | `EvaluatorExplain::eval_query()` |
| `execute_datalog()` | `rfdb_server.rs` | 1924 | `Evaluator::eval_query()` |
| `eval_derived()` | `eval.rs` | 774 | `eval_rule_body()` |
| `eval_derived()` | `eval_explain.rs` | 755 | `eval_rule_body()` |
| Tests | `tests.rs` | various | both |

`napi_bindings.rs` uses only `evaluator.query(&atom)` (for single atoms) and does not call `eval_query()` directly. However, `check_guarantee()` uses `evaluator.query()` → `eval_atom()` → `eval_derived()` → `eval_rule_body()` — so rule bodies used via NAPI are also affected.

---

## 14. Key Observations and Risks

1. **Both `eval.rs` and `eval_explain.rs` need changes** — duplicated structure is a maintenance risk. The reorder function in `utils.rs` keeps them in sync.

2. **The reordering cannot change semantics for correctly-ordered queries** — the greedy algorithm preserves order when no reordering is needed.

3. **`eval_explain.rs` missing `attr_edge`** is pre-existing, out of scope, but worth noting in a comment.

4. **Error type**: The evaluator currently returns `Vec<Bindings>` with no error channel. For circular dependency errors, two options:
   - Return `Result<Vec<Bindings>, ReorderError>` — requires changing call sites
   - Panic (not acceptable in production)
   - Return empty `Vec<Bindings>` with a log — acceptable but silent failure
   - Best: change return type to `Result` — `rfdb_server.rs` already handles `Result<DatalogResponse, String>` at lines 1844-1869, so propagation is clean.

5. **Rule body reordering** (`eval_rule_body`) should also be done at rule load time rather than per-evaluation to avoid repeated reordering of static rules. Optional optimization for a follow-up.

---

## 15. Implementation Plan (Recommended Approach)

1. Add `reorder_literals(literals: &[Literal]) -> Result<Vec<Literal>, String>` to `utils.rs`
   - Greedy topological sort
   - Track `bound: HashSet<String>` of currently-bound variables
   - For each step: find the earliest literal in remaining that can be evaluated given `bound`
   - If none found: return `Err("circular dependency: cannot determine safe evaluation order")`

2. Update `Evaluator::eval_query()` (`eval.rs:130`) to call `reorder_literals()` first
   - Return type change: `pub fn eval_query(&self, literals: &[Literal]) -> Result<Vec<Bindings>, String>`
   - Or keep `Vec<Bindings>` and log the error, returning empty on circular deps

3. Update `Evaluator::eval_rule_body()` (`eval.rs:788`) same way

4. Update `EvaluatorExplain::eval_query()` (`eval_explain.rs:154`) same way

5. Update `EvaluatorExplain::eval_rule_body()` (`eval_explain.rs:768`) same way

6. Update all callers in `rfdb_server.rs` to handle the new Result type

7. Add tests to `tests.rs` under `mod eval_tests` for:
   - Wrong-order query gives same result as correct-order
   - Negation after positive literals
   - Already-correct order unchanged
   - Circular dependency returns clear error

---

## 16. Files To Touch

| File | Change |
|------|--------|
| `packages/rfdb-server/src/datalog/utils.rs` | Add `reorder_literals()` |
| `packages/rfdb-server/src/datalog/eval.rs` | Call reorder in `eval_query()` and `eval_rule_body()` |
| `packages/rfdb-server/src/datalog/eval_explain.rs` | Same as eval.rs |
| `packages/rfdb-server/src/datalog/tests.rs` | Add wrong-order tests |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Handle updated Result type if changed |
