# Joel Spolsky's Technical Specification - REG-313

## Implementation Overview

Based on Don Melton's analysis, we need to add nested path support to the `attr()` predicate. The core approach is:

1. **Try exact key match first** (backward compatibility)
2. **If not found and key contains `.`, try nested path resolution**

The implementation requires modifying two files with nearly identical `eval_attr()` functions. To avoid code duplication, we should extract a shared helper function.

---

## 1. Implementation Steps

### Step 1.1: Create Helper Module for Shared Utilities

**Location:** `packages/rfdb-server/src/datalog/mod.rs`

Add a new private module `utils`:

```rust
mod utils;  // Add after existing module declarations
```

**Create file:** `packages/rfdb-server/src/datalog/utils.rs`

### Step 1.2: Implement `get_metadata_value()` Helper Function

**File:** `packages/rfdb-server/src/datalog/utils.rs`

```rust
//! Shared utilities for Datalog evaluation

use serde_json::Value;

/// Extracts a value from JSON metadata, supporting both direct keys and nested paths.
///
/// Resolution strategy:
/// 1. Try exact key match first (e.g., "cardinality.scale" as literal key)
/// 2. If not found and key contains '.', try nested path (e.g., "foo.bar" -> foo -> bar)
///
/// Returns the value as a String for: String, Number, Bool values.
/// Returns None for: Object, Array, Null, or if path not found.
pub fn get_metadata_value(metadata: &Value, attr_name: &str) -> Option<String> {
    // Step 1: Try exact key match first
    if let Some(value) = metadata.get(attr_name) {
        if let Some(s) = value_to_string(value) {
            return Some(s);
        }
    }

    // Step 2: If contains '.', try nested path
    if attr_name.contains('.') {
        let value = resolve_nested_path(metadata, attr_name);
        if let Some(v) = value {
            return value_to_string(v);
        }
    }

    None
}

/// Resolves a dot-separated path in JSON
fn resolve_nested_path<'a>(metadata: &'a Value, path: &str) -> Option<&'a Value> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = metadata;

    for part in parts {
        match current.get(part) {
            Some(v) => current = v,
            None => return None,
        }
    }

    Some(current)
}

/// Converts a JSON value to String if it's a primitive type
fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None, // Objects, Arrays, Null not supported
    }
}
```

### Step 1.3: Update `eval.rs` to Use Helper

**File:** `packages/rfdb-server/src/datalog/eval.rs`
**Location:** Lines 474-492

Replace with:

```rust
_ => {
    if let Some(ref metadata_str) = node.metadata {
        if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(metadata_str) {
            crate::datalog::utils::get_metadata_value(&metadata, attr_name)
        } else {
            None
        }
    } else {
        None
    }
}
```

### Step 1.4: Update `eval_explain.rs` to Use Helper

**File:** `packages/rfdb-server/src/datalog/eval_explain.rs`
**Location:** Lines 521-538

Apply the same change.

---

## 2. Function Signatures

**Primary helper function:**

```rust
/// Extracts a value from JSON metadata, supporting both direct keys and nested paths.
pub fn get_metadata_value(metadata: &serde_json::Value, attr_name: &str) -> Option<String>
```

**Internal helper functions:**

```rust
fn resolve_nested_path<'a>(metadata: &'a Value, path: &str) -> Option<&'a Value>
fn value_to_string(value: &Value) -> Option<String>
```

---

## 3. Test Cases

### Unit Tests (in `utils.rs`)

| Test Name | Description | Input | Expected Output |
|-----------|-------------|-------|-----------------|
| `test_exact_key_match` | Simple top-level key | `{"foo": "bar"}`, `"foo"` | `Some("bar")` |
| `test_nested_path` | Two-level nesting | `{"config": {"port": 5432}}`, `"config.port"` | `Some("5432")` |
| `test_deep_nested_path` | Three-level nesting | `{"a": {"b": {"c": "d"}}}`, `"a.b.c"` | `Some("d")` |
| `test_exact_key_with_dots_takes_precedence` | Literal key with dots exists | `{"foo.bar": "exact", "foo": {"bar": "nested"}}`, `"foo.bar"` | `Some("exact")` |
| `test_missing_path` | Path does not exist | `{"foo": {"bar": "baz"}}`, `"foo.qux"` | `None` |
| `test_intermediate_not_object` | Path traverses non-object | `{"foo": "string"}`, `"foo.bar"` | `None` |
| `test_bool_value` | Boolean extraction | `{"enabled": true}`, `"enabled"` | `Some("true")` |
| `test_number_value` | Number extraction | `{"count": 42}`, `"count"` | `Some("42")` |
| `test_nested_bool` | Nested boolean | `{"config": {"enabled": true}}`, `"config.enabled"` | `Some("true")` |
| `test_object_returns_none` | Object value not extractable | `{"config": {}}`, `"config"` | `None` |
| `test_array_returns_none` | Array value not extractable | `{"items": [1,2,3]}`, `"items"` | `None` |

### Integration Tests (in `tests.rs`)

- `test_eval_attr_nested_path` - Full query with nested metadata
- `test_eval_attr_nested_number` - Nested number extraction
- `test_eval_attr_literal_key_with_dots` - Backward compatibility
- `test_eval_attr_nested_path_not_found` - Missing path returns empty result

---

## 4. Commit Strategy

**Commit 1:** Add utils module with helper function
```
feat(datalog): Add get_metadata_value helper for nested JSON paths
```

**Commit 2:** Apply helper to eval.rs
```
feat(datalog): Support nested paths in attr() predicate (eval.rs)
```

**Commit 3:** Apply helper to eval_explain.rs
```
feat(datalog): Support nested paths in attr() predicate (eval_explain.rs)
```

**Commit 4:** Add integration tests
```
test(datalog): Add integration tests for nested attr() paths
```

---

## 5. Definition of Done

**Functional Requirements:**
- [ ] `attr(X, "config.database.port", V)` resolves nested paths in metadata
- [ ] `attr(X, "cardinality.scale", V)` still works for literal keys with dots
- [ ] Exact key match takes precedence over nested path resolution
- [ ] Non-primitive values (objects, arrays) return no match
- [ ] Missing paths return no match (silent failure, no errors)
- [ ] Works identically in both `eval.rs` and `eval_explain.rs`

**Test Requirements:**
- [ ] Unit tests for `get_metadata_value()` pass
- [ ] Integration tests for nested paths pass
- [ ] All existing `attr()` tests still pass (backward compatibility)

**Code Quality:**
- [ ] No code duplication between eval.rs and eval_explain.rs
- [ ] Helper function is well-documented
- [ ] `cargo test` passes for rfdb-server package
- [ ] `cargo clippy` has no new warnings

**Verification Commands:**
```bash
cd packages/rfdb-server && cargo test datalog
cd packages/rfdb-server && cargo test utils
cd packages/rfdb-server && cargo test
```

---

## Critical Files

| File | Purpose |
|------|---------|
| `packages/rfdb-server/src/datalog/utils.rs` | **New** - helper function + unit tests |
| `packages/rfdb-server/src/datalog/eval.rs` | Lines 474-492 - replace metadata extraction |
| `packages/rfdb-server/src/datalog/eval_explain.rs` | Lines 521-538 - same change |
| `packages/rfdb-server/src/datalog/mod.rs` | Add `mod utils;` |
| `packages/rfdb-server/src/datalog/tests.rs` | Integration tests |
