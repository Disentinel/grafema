# REG-313: Datalog - support nested paths in attr() predicate

## Problem

Current `attr(NodeId, AttrName, Value)` predicate doesn't support nested JSON paths.

**Current behavior:**

```datalog
attr(X, "cardinality.scale", V)  -- returns nothing
```

**Expected:**

```datalog
attr(X, "cardinality.scale", V)  -- returns V = "nodes" from metadata.cardinality.scale
```

## Technical Details

File: `packages/rfdb-server/src/datalog/eval.rs`

Current implementation in `eval_attr()`:

```rust
metadata.get(attr_name)  // only top-level keys
```

Need to support dot notation:

```rust
fn get_nested_attr(metadata: &Value, path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = metadata;
    for part in parts {
        current = current.get(part)?;
    }
    // convert to string
}
```

## Acceptance Criteria

- [ ] `attr(X, "foo.bar.baz", V)` resolves nested JSON paths
- [ ] Backward compatible — `attr(X, "name", V)` still works
- [ ] Tests for nested path resolution
- [ ] Performance: no significant overhead for non-nested paths
