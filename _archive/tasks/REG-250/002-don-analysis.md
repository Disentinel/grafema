# Don Melton Analysis: REG-250

## Root Cause

The issue is in `packages/rfdb-server/src/datalog/eval.rs` in the `eval_attr()` function (lines 387-472).

The predicate requires the **NodeId argument to be bound as a constant**. When you try to use `attr(X, "url", U)` where X is an unbound variable, the function returns early:

```rust
// Line 402-408
let node_id = match id_term {
    Term::Const(id_str) => match id_str.parse::<u128>() {
        Ok(id) => id,
        Err(_) => return vec![],
    },
    _ => return vec![], // ← BLOCKS unbound variables
};
```

## Why This Matters

The query works **only** when evaluated through rule bodies (via `checkGuarantee()`), because:

1. `node(X, "http:request")` executes first and binds X to concrete node IDs
2. `attr(X, "url", U)` is then called with X substituted to a constant
3. Variable U gets properly bound to the attribute value

However:
- Direct queries via `datalogQuery()` only parse single atoms
- Users can't test the attr() pattern directly
- The Value variable U is not being returned in results

## Secondary Issues

1. **When attr() matches a constant value** (line 464): Returns `vec![Bindings::new()]` instead of preserving input bindings
2. **No test coverage** for attr() with variable Value binding

## Key File Locations

- `packages/rfdb-server/src/datalog/eval.rs:387-472` - eval_attr()
- `packages/rfdb-server/src/datalog/eval.rs:141-206` - eval_node() (reference implementation)
- `packages/rfdb-server/src/ffi/napi_bindings.rs:496-570` - API layer

## Recommended Fix

**Option 1: Add Variable Support to eval_attr()**

When Value is a variable, bind it to the actual attribute value in returned bindings.

The current code (line 448-466) handles the value term but doesn't properly bind unbound variables to returned results.

## Architecture Concern

This is a product gap that prevents users from effectively querying graph attributes, which violates the project vision of "AI should query the graph, not read code."
