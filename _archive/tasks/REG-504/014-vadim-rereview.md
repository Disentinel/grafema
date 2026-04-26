# REG-504: Вадим auto Re-Review (Post-Fix)

**Reviewer:** Вадим auto
**Date:** 2026-02-19
**Files reviewed:** `packages/rfdb-server/src/datalog/utils.rs`

---

## Changes Verified

### Fix 1: Derived predicates provide all free Var args

Before: `_ =>` arm returned `(true, HashSet::new())` — no bindings provided.

After (line 239-244):
```rust
_ => {
    // Unknown/derived predicate — always placeable, provides all free Var args.
    // Derived predicates bind variables via their rule head projection,
    // so we must report them as providers to avoid false circular dependencies.
    let provides = free_vars(args, bound);
    (true, provides)
}
```

Correct. A derived predicate like `ancestor(X, Y)` does bind X and Y via its rule head. Returning empty `provides` was causing the reorderer to think those variables were still unbound, triggering a false "circular dependency" error for any rule that used a user-defined derived predicate. The fix is logically sound and consistent with how `node` and `edge` are handled.

### Fix 2: Combined `incoming | path` match arms

Before: two identical arms `"incoming" => { ... }` and `"path" => { ... }`.

After (line 213):
```rust
"incoming" | "path" => {
    // incoming(dst, src, type) / path(src, dst) — requires first arg bound
    ...
}
```

DRY fix. Both predicates have the same semantics for reordering: require first arg bound, provide remaining free vars. The combined arm is correct and eliminates duplication.

---

## AC-by-AC Check (Quick Pass)

- **AC1** (auto-reorder): Still pass. `reorder_literals` logic unchanged. Fix 1 removes a regression where user-defined rules would hit false circular dependency; it does not alter the sort algorithm.
- **AC2** (negation after positives): Still pass. `Literal::Negative` branch unchanged.
- **AC3** (no-op if already ordered): Still pass. Greedy picks first placeable; already-ordered input traverses in same order.
- **AC4** (clear error on circular): Still pass. `Err("circular dependency...")` path unchanged. Fix 1 only changes what the default arm provides — if a genuine circular exists, no literal will be placeable and the error fires normally.
- **AC5** (wrong order = correct order): Still pass. Fix 1 enables derived predicate rules to reorder correctly rather than error. This strictly expands correct behavior; no existing tests are invalidated.

---

## No Regressions

Both changes are strictly additive corrections:
- Fix 1 closes a correctness hole for user-defined rules (false circular error → correct reorder).
- Fix 2 is a structural cleanup with no semantic change.

No other logic in `utils.rs` was touched. No new forbidden patterns.

---

**APPROVE**
