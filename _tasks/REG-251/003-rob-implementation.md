# Rob Pike - Implementation Report: REG-251

## Changes Made

### 1. Fixed `eval_edge()` in `packages/rfdb-server/src/datalog/eval.rs`

**Lines 264-318:** Replaced the empty return with full implementation:

```rust
Term::Var(src_var) => {
    // Enumerate all edges when source is unbound
    let all_edges = self.engine.get_all_edges();

    // Get edge type filter if constant
    let type_filter: Option<&str> = type_term.and_then(|t| match t {
        Term::Const(s) => Some(s.as_str()),
        _ => None,
    });

    // Get destination filter if constant
    let dst_filter: Option<u128> = match dst_term {
        Term::Const(s) => s.parse::<u128>().ok(),
        _ => None,
    };

    all_edges
        .into_iter()
        .filter(|e| {
            // Filter by edge type if specified
            if let Some(filter_type) = type_filter {
                if e.edge_type.as_deref() != Some(filter_type) {
                    return false;
                }
            }
            // Filter by destination if specified
            if let Some(filter_dst) = dst_filter {
                if e.dst != filter_dst {
                    return false;
                }
            }
            true
        })
        .map(|e| {
            let mut b = Bindings::new();
            b.set(src_var, Value::Id(e.src));

            if let Term::Var(var) = dst_term {
                b.set(var, Value::Id(e.dst));
            }

            if let Some(Term::Var(var)) = type_term {
                if let Some(etype) = e.edge_type {
                    b.set(var, Value::Str(etype));
                }
            }

            b
        })
        .collect()
}
```

### 2. Fixed `eval_edge()` in `packages/rfdb-server/src/datalog/eval_explain.rs`

Same fix as above, but with added statistics tracking:

```rust
self.stats.all_edges_calls += 1;
let all_edges = self.engine.get_all_edges();
self.stats.edges_traversed += all_edges.len();
```

### 3. Added `all_edges_calls` field to `QueryStats`

**Line 32:** Added new stats field for tracking `get_all_edges()` calls:

```rust
/// Number of get_all_edges calls
pub all_edges_calls: usize,
```

### 4. Added Tests in `packages/rfdb-server/src/datalog/tests.rs`

**Lines 1061-1131:** Three new test cases:

- `test_eval_edge_variable_source` - `edge(X, Y, "CALLS")`
- `test_eval_edge_variable_source_constant_dest` - `edge(X, 4, T)`
- `test_eval_edge_all_variables` - `edge(X, Y, T)`

## Test Results

All 59 datalog tests pass:
- 4 edge-related tests (including 3 new ones)
- All existing tests still pass

## Now Supported Queries

| Query | Description | Status |
|-------|-------------|--------|
| `edge(123, X, "CALLS")` | Edges from node 123 with type CALLS | Already worked |
| `edge(X, Y, "CALLS")` | All edges of type CALLS | **NOW WORKS** |
| `edge(X, 123, T)` | All edges to node 123 | **NOW WORKS** |
| `edge(X, Y, T)` | All edges in graph | **NOW WORKS** |
| `edge(X, Y)` | All edges (no type binding) | **NOW WORKS** |

## Performance Note

The variable source case uses `get_all_edges()` which loads all edges into memory. For large graphs, this can be expensive. The stats tracking (`all_edges_calls`) allows users to identify such queries when profiling.
