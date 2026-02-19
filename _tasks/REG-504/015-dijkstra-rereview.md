# Dijkstra Re-Review — REG-504 Fix Verification

**Reviewer:** Edsger Dijkstra (Correctness)
**Date:** 2026-02-19
**Status:** APPROVE

---

## Fix Confirmed

Lines 239–245 of `packages/rfdb-server/src/datalog/utils.rs`:

```rust
_ => {
    // Unknown/derived predicate — always placeable, provides all free Var args.
    // Derived predicates bind variables via their rule head projection,
    // so we must report them as providers to avoid false circular dependencies.
    let provides = free_vars(args, bound);
    (true, provides)
}
```

The `_ =>` arm now returns `(true, free_vars(args, bound))` instead of the prior `(true, HashSet::new())`. This is exactly the change I required.

---

## Proof: Regression Is Resolved

Rule: `foo(X) :- node(X, "CALL").`
Query body: `foo(X), attr(X, "name", N)`

**Before fix:**
- `foo(X)`: `can_place=true`, `provides={}`. X never enters `bound`. `attr(X, ...)` checks `is_bound_or_const(X)` → false → `can_place=false`. No literal can be placed. Error: "circular dependency".

**After fix:**
- `foo(X)`: `can_place=true`, `provides={X}` (X is a free Var in args, not in bound). X enters `bound`.
- `attr(X, "name", N)`: `id_ok = is_bound_or_const(X, {X}) = true`, `name_ok = true` (Const). `can_place=true`. Placed successfully.

The regression is resolved. The proof is complete.

---

## Could the Fix Introduce Incorrect Behavior?

The concern is: a derived predicate advertises `provides={X}` but the actual evaluation may not bind X (e.g., the derived relation is empty, or the rule head does not include X).

**This is not a problem for reordering correctness.** The `reorder_literals` function only decides *placement order* — it does not guarantee that every advertised variable will have a value at runtime. The runtime evaluator is responsible for handling unbound variables and empty result sets. The reorder step merely needs to ensure the intended dependency order is possible; it must not block a query that is structurally valid.

An overly pessimistic `provides={}` is strictly worse than an optimistic `provides=free_vars(...)`. A false "circular dependency" error at reorder time is a hard failure with no recovery. An optimistic placement that results in a runtime empty-result is normal Datalog semantics.

Therefore: the fix makes `provides` optimistic in exactly the same way that `node` and `edge` are already optimistic (both return `(true, free_vars(...))`). Derived predicates and base EDB predicates should be treated symmetrically here.

No new incorrect behavior is introduced.

---

## incoming|path Arm

Lines 213–229. The `incoming | path` arm:
- Requires first arg to be bound or const.
- If placeable, provides all free Vars in `args[1..]`.

This is semantically correct and unchanged by the fix. The arm is behaviorally equivalent to its prior form.

---

## Verdict

**APPROVE.**

The fix is minimal, correct, and consistent with the treatment of base predicates. The previously identified regression is resolved. No new failure modes are introduced.
