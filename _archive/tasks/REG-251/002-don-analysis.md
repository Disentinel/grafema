# Don Melton - Technical Analysis: REG-251

## Problem Analysis

The Datalog `edge(X, Y, Type)` predicate returns no results when the source node (first argument) is a variable. This is a **known limitation** explicitly marked in the code:

```rust
// packages/rfdb-server/src/datalog/eval.rs:264-267
Term::Var(_var) => {
    // Would need to enumerate all edges - expensive
    // For now, return empty (requires bound source)
    vec![]
}
```

The same code exists in `eval_explain.rs:362-365`.

## Root Cause

The implementation only handles the case where source is a constant (bound value). When source is a variable, it returns empty immediately instead of using `get_all_edges()` to enumerate all edges.

## Impact Assessment

Without this fix, users cannot:
- Query all edges of a type: `edge(X, Y, "CALLS")`
- Find all incoming edges to a node: `edge(X, 123, T)`
- Enumerate all edges: `edge(X, Y, T)`

This renders the `edge()` predicate largely useless since most graph exploration queries need unbound sources.

## Solution

Implement the variable source case using `get_all_edges()` with filtering:

1. When `src_term` is `Term::Var`:
   - Call `self.engine.get_all_edges()`
   - Filter by edge type if `type_term` is a constant
   - Filter by destination if `dst_term` is a constant
   - Create bindings for all variable positions

## Files to Modify

1. `packages/rfdb-server/src/datalog/eval.rs` - main evaluator
2. `packages/rfdb-server/src/datalog/eval_explain.rs` - explain evaluator (same fix)

## Test Cases Required

- `edge(X, Y, "CALLS")` - variable source, variable dest, constant type
- `edge(X, 2, T)` - variable source, constant dest, variable type
- `edge(X, Y, T)` - all variables (enumerate all edges)

## Alignment with Vision

This directly supports Grafema's vision: "AI should query the graph, not read code." Without working edge queries, the Datalog interface is crippled for graph exploration.

## Recommendation

Proceed with implementation. This is a straightforward fix completing an explicitly marked TODO.
