# Vadim Auto Review — REG-518

**Reviewer:** Вадим auto (Completeness Reviewer)
**Verdict:** APPROVE with one noted gap (out of scope for this PR, but must be tracked)

---

## Summary

The acceptance criterion is precisely met. All three Rust dispatch tables now treat `"type"` as an alias for `"node"`, and the TypeScript `"did you mean"` regex was extended to match both predicates. The two new Rust tests are meaningful and cover the correct cases.

---

## Verification by File

### `packages/rfdb-server/src/datalog/eval.rs` line 180
```rust
"node" | "type" => self.eval_node(atom),
```
Correct. The match arm uses Rust's `|` pattern, which is idiomatic and has no runtime overhead. Both predicates route to exactly the same function.

### `packages/rfdb-server/src/datalog/eval_explain.rs` line 265
```rust
"node" | "type" => self.eval_node(atom),
```
Correct. Explain mode now matches eval mode exactly for these two predicates.

### `packages/rfdb-server/src/datalog/utils.rs` line 166
```rust
"node" | "type" => {
    // node is always placeable — provides free Var args
    let provides = free_vars(args, bound);
    (true, provides)
}
```
Correct. The REG-504 auto-reorder logic now classifies `type()` with the same planning semantics as `node()`: always placeable, provides free variables. Without this, queries like `type(X, "FUNCTION"), attr(X, "name", N)` would have been misclassified in the planner.

### `packages/mcp/src/handlers/query-handlers.ts` line 56
```typescript
const typeMatch = query.match(/(?:node|type)\([^,]+,\s*"([^"]+)"\)/);
```
Correct. The "did you mean" hint logic now fires for `type(X, "misspeled")` as well as `node(X, "misspeled")`.

### `packages/rfdb-server/src/datalog/tests.rs`

**`test_type_alias_returns_same_results_as_node`**: Tests the primary requirement — that `type(X, "queue:publish")` and `node(X, "queue:publish")` return identical result sets. Sorts IDs before comparing to avoid false negatives from ordering differences. Count assertion (`== 2`) also verifies the test graph is in the expected state.

**`test_type_alias_by_id`**: Tests the reverse lookup — `type(1, Type)` returning the type of a known node. This covers the `(Const, Var)` arm of `eval_node` and complements the existing `test_eval_node_by_id` test.

Both tests use `setup_test_graph()` which creates a real ephemeral engine with actual node data — not mocks.

---

## Edge Cases Checked

- `type(X, Y)` (both variables): routed to `eval_node`, which handles `(Var, Var)` via full scan. Covered implicitly by the full-scan path tested in the existing `test_eval_node_basic`.
- `type("id", "type")` (both constants): routed to `eval_node`, which handles `(Const, Const)` as existence check. Not directly tested but the dispatch is identical to `node()` so the existing node tests provide coverage.
- Query reordering with `type()` as first literal: classified as always-placeable. No regression possible here since the planning behavior is now symmetric.

---

## Noted Gap (Out of Scope — Must Be Tracked Separately)

`GuaranteeManager.extractRelevantTypes()` in `packages/core/src/core/GuaranteeManager.ts` line 355 uses a regex that only matches `node(`:

```typescript
const nodePattern = /node\(\s*\w+\s*,\s*"([^"]+)"\s*\)/g;
```

If a guarantee rule is written using `type()` instead of `node()`, `extractRelevantTypes()` will return an empty list, which causes `checkSelective()` to conservatively re-check that guarantee on every graph change (the `relevantTypes.length === 0` branch). This is not a correctness bug — the guarantee still runs and produces correct results — but it defeats the selective-check optimization introduced for incremental analysis.

This is **not introduced by this PR** and is **out of scope for the acceptance criterion**, which only asked for the Rust dispatch table fix. However it should be tracked as a follow-up: `extractRelevantTypes()` should be updated to also match `type(` patterns.

---

## No Scope Creep, No Loose Ends

- No TODOs, FIXMEs, or commented-out code introduced.
- The change is minimal: 3 Rust lines changed (one in each dispatch table), 1 TypeScript regex extended, 2 Rust tests added.
- No pre-existing issues introduced or worsened.
- The pre-existing asymmetry between `eval.rs` and `eval_explain.rs` regarding `attr_edge` is not touched (correctly left alone — out of scope).

---

## Verdict

**APPROVE.** The implementation is correct, complete within scope, and tests are meaningful. The `GuaranteeManager.extractRelevantTypes()` gap should be filed as a separate follow-up issue.
