# Don Melton's Analysis - REG-313

## 1. Current Implementation Analysis

The `eval_attr()` function is implemented in two places that will need updates:
- `packages/rfdb-server/src/datalog/eval.rs` (lines 433-519)
- `packages/rfdb-server/src/datalog/eval_explain.rs` (lines 486-563)

**Current behavior** (lines 474-493 in eval.rs):
```rust
_ => {
    if let Some(ref metadata_str) = node.metadata {
        if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(metadata_str) {
            metadata.get(attr_name).and_then(|v| {
                match v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    serde_json::Value::Bool(b) => Some(b.to_string()),
                    _ => None,
                }
            })
        } else {
            None
        }
    } else {
        None
    }
}
```

The code currently uses `metadata.get(attr_name)` which only accesses top-level keys.

## 2. Data Model

**NodeRecord** (storage/mod.rs):
- `metadata: Option<String>` - JSON string stored in node
- Examples of metadata seen in tests:
  - `{"object":"arr","method":"map"}`
  - `{"url": "/api/users", "method": "GET"}`
  - `{"async":true}`

## 3. serde_json Capabilities

serde_json provides `Value::pointer()` method for JSON Pointer syntax (`/foo/bar`), but the issue requests **dot notation** (`foo.bar`). The project uses `serde_json = "1.0"`.

## 4. Identified Risks and Edge Cases

1. **Key names containing dots**: If a top-level key is literally `"cardinality.scale"`, the nested path lookup would fail incorrectly.
   - Example: `{"cardinality.scale": "value"}` should still work for `attr(X, "cardinality.scale", V)`

2. **Array indexing**: Not mentioned in the issue, but `items[0].name` style access is a natural extension.

3. **Intermediate path doesn't exist**: Need graceful handling (return empty, not error).

4. **Code duplication**: Same logic exists in `eval.rs` and `eval_explain.rs`. Should extract shared utility.

5. **Built-in attributes**: Current code has special cases for `"name"`, `"file"`, `"type"` - these must remain unchanged.

## 5. High-Level Approach

**MVP Scope (recommended)**:
1. Add `get_nested_value()` helper function that:
   - First tries exact key match (`metadata.get(attr_name)`) for backward compatibility
   - If not found and attr_name contains '.', try splitting and walking the path
2. Apply to both `eval.rs` and `eval_explain.rs` (or extract shared function)
3. Add tests for nested path resolution

**Performance optimization**:
- For non-nested paths (no dot), the cost is one extra `contains('.')` check
- For nested paths, the cost is proportional to path depth

**Full JSONPath support (future scope)**:
- Array indexing: `items[0].name`
- Wildcards: `items[*].id`
- This should be a separate issue if needed

## 6. Questions for Clarification

1. **Escaping dots in key names**: Should we support escaping like `"key\.with\.dots"` to match a literal key name `"key.with.dots"`? Or is "try exact match first, then try nested" sufficient?

2. **Array indexing**: Is `items[0].name` in scope for MVP or future enhancement?

3. **Error handling**: If the path is malformed (e.g., trailing dot `foo.bar.`), should it silently return no match or warn?

## 7. Recommendation

The MVP approach is correct:
- "Try exact match first, then try nested" handles backward compatibility elegantly
- Array indexing is out of MVP scope
- Malformed paths silently return no match (consistent with current behavior)

## Critical Files

| File | Purpose |
|------|---------|
| `packages/rfdb-server/src/datalog/eval.rs` | Main `eval_attr()` implementation (lines 433-519) |
| `packages/rfdb-server/src/datalog/eval_explain.rs` | Duplicate `eval_attr()` implementation (lines 486-563) |
| `packages/rfdb-server/src/datalog/tests.rs` | Test patterns for `attr()` predicate |
