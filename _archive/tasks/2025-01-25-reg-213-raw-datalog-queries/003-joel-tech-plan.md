# Joel Spolsky Technical Plan: REG-213 Raw Datalog Queries

## Summary

The issue is a documentation and UX gap, not a bug. The `--raw` flag works, but users are using incorrect syntax (`type(N, T)` instead of `node(N, T)`). The fix involves three components:

1. Add `type` predicate as alias in Rust evaluator
2. Update CLI help with predicate documentation
3. Consider error feedback for unknown predicates (deferred - see rationale)

## Files to Modify

| File | Change | LOC |
|------|--------|-----|
| `rust-engine/src/datalog/eval.rs` | Add `type` alias in `eval_atom` | +1 |
| `rust-engine/src/datalog/eval_explain.rs` | Add `type` alias in `eval_atom` | +1 |
| `rust-engine/src/datalog/tests.rs` | Add test for `type` predicate | +20 |
| `packages/cli/src/commands/query.ts` | Update help text with predicates | +30 |

## Detailed Implementation Steps

### Step 1: Add `type` predicate alias in `eval.rs`

**Location**: `rust-engine/src/datalog/eval.rs`, line 128-138

**Current code**:
```rust
pub fn eval_atom(&self, atom: &Atom) -> Vec<Bindings> {
    match atom.predicate() {
        "node" => self.eval_node(atom),
        "edge" => self.eval_edge(atom),
        ...
    }
}
```

**Change**: Add `"type"` as alias for `node`:
```rust
"node" | "type" => self.eval_node(atom),
```

### Step 2: Add `type` predicate alias in `eval_explain.rs`

**Location**: `rust-engine/src/datalog/eval_explain.rs`, line 213-222

Same change - this file duplicates the evaluator with explain/profiling support.

### Step 3: Add test for `type` predicate

**Location**: `rust-engine/src/datalog/tests.rs`

Add tests verifying `type` works identically to `node` for all argument patterns.

### Step 4: Update CLI help text

**Location**: `packages/cli/src/commands/query.ts`

Update the `--raw` option description to include:
- Available predicates list
- Usage examples

## Error Handling Discussion

**Why NOT to change error handling now**:
1. Datalog semantics allow user-defined predicates via rules
2. Warning on "unknown" predicates would break valid derived predicates
3. The UX fix (alias + docs) addresses the immediate user pain point

**Recommendation**: Defer error handling to separate issue.

## Testing Strategy

1. **Unit tests** (Rust): Test `type` predicate works same as `node`
2. **Integration test** (manual): Verify both predicates return same results
3. **Help text verification**: Check --help shows new documentation

## Acceptance Criteria Checklist

- [ ] `grafema query --raw 'type(N, T)'` works (via new alias)
- [ ] `grafema query --raw 'node(N, T)'` continues to work
- [ ] Help text documents all available predicates
- [ ] Help text includes examples
- [ ] (Deferred) Error messages for unknown predicates - separate issue

## Risk Assessment

**Low risk**: Change is additive, existing behavior preserved.
