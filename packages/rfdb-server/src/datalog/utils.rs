//! Shared utilities for Datalog evaluation
//!
//! This module provides helper functions used across the Datalog evaluator,
//! particularly for extracting values from JSON metadata.

use serde_json::Value;

/// Extracts a value from JSON metadata, supporting both direct keys and nested paths.
///
/// # Resolution Strategy
///
/// 1. **Exact match first**: Try to get the key as a literal string (e.g., "foo.bar" as a key)
/// 2. **Nested path second**: If not found AND key contains '.', try nested path resolution
///    (e.g., "foo.bar" -> `metadata["foo"]["bar"]`)
///
/// This precedence ensures backward compatibility: existing keys with dots are matched exactly.
///
/// # Return Value
///
/// - Returns `Some(String)` for primitive values: String, Number, Bool
/// - Returns `None` for:
///   - Objects (use nested paths to access their fields)
///   - Arrays (array indexing not supported in this version)
///   - Null values
///   - Missing paths
///   - Malformed paths (empty segments, leading/trailing dots, double dots)
///
/// # Performance
///
/// - O(1) for exact key match
/// - O(path_depth) for nested path resolution
///
/// # Examples
///
/// ```ignore
/// use serde_json::json;
/// use crate::datalog::utils::get_metadata_value;
///
/// let metadata = json!({"config": {"port": 5432}});
/// assert_eq!(get_metadata_value(&metadata, "config.port"), Some("5432".to_string()));
///
/// // Exact key match takes precedence
/// let metadata = json!({"foo.bar": "exact", "foo": {"bar": "nested"}});
/// assert_eq!(get_metadata_value(&metadata, "foo.bar"), Some("exact".to_string()));
/// ```
pub(crate) fn get_metadata_value(metadata: &Value, attr_name: &str) -> Option<String> {
    // Handle empty string early
    if attr_name.is_empty() {
        return None;
    }

    // Step 1: Try exact key match first (backward compatibility)
    if let Some(value) = metadata.get(attr_name) {
        return value_to_string(value);
    }

    // Step 2: If not found and key contains '.', try nested path resolution
    if attr_name.contains('.') {
        let parts: Vec<&str> = attr_name.split('.').collect();

        // Guard against malformed paths: empty segments (leading/trailing/double dots)
        if parts.iter().any(|part| part.is_empty()) {
            return None;
        }

        // Traverse the path
        let mut current = metadata;
        for part in parts {
            match current.get(part) {
                Some(value) => current = value,
                None => return None,
            }
        }

        return value_to_string(current);
    }

    None
}

/// Converts a JSON value to a String for primitive types only.
/// Returns None for Object, Array, and Null values.
fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Object(_) | Value::Array(_) | Value::Null => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ============================================================================
    // Basic Value Extraction Tests
    // ============================================================================

    #[test]
    fn test_exact_key_match() {
        let metadata = json!({"foo": "bar"});
        let result = get_metadata_value(&metadata, "foo");
        assert_eq!(result, Some("bar".to_string()));
    }

    #[test]
    fn test_nested_path() {
        let metadata = json!({"config": {"port": 5432}});
        let result = get_metadata_value(&metadata, "config.port");
        assert_eq!(result, Some("5432".to_string()));
    }

    #[test]
    fn test_deep_nested_path() {
        let metadata = json!({"a": {"b": {"c": "d"}}});
        let result = get_metadata_value(&metadata, "a.b.c");
        assert_eq!(result, Some("d".to_string()));
    }

    #[test]
    fn test_exact_key_with_dots_takes_precedence() {
        // If a literal key "foo.bar" exists, it takes precedence over nested path
        let metadata = json!({
            "foo.bar": "exact",
            "foo": {"bar": "nested"}
        });
        let result = get_metadata_value(&metadata, "foo.bar");
        assert_eq!(result, Some("exact".to_string()));
    }

    // ============================================================================
    // Missing Path Tests
    // ============================================================================

    #[test]
    fn test_missing_path() {
        let metadata = json!({"foo": {"bar": "baz"}});
        let result = get_metadata_value(&metadata, "foo.qux");
        assert_eq!(result, None);
    }

    #[test]
    fn test_intermediate_not_object() {
        // Path traverses through a non-object value
        let metadata = json!({"foo": "string"});
        let result = get_metadata_value(&metadata, "foo.bar");
        assert_eq!(result, None);
    }

    // ============================================================================
    // Value Type Tests
    // ============================================================================

    #[test]
    fn test_bool_value() {
        let metadata = json!({"enabled": true});
        let result = get_metadata_value(&metadata, "enabled");
        assert_eq!(result, Some("true".to_string()));
    }

    #[test]
    fn test_number_value() {
        let metadata = json!({"count": 42});
        let result = get_metadata_value(&metadata, "count");
        assert_eq!(result, Some("42".to_string()));
    }

    #[test]
    fn test_nested_bool() {
        let metadata = json!({"config": {"enabled": true}});
        let result = get_metadata_value(&metadata, "config.enabled");
        assert_eq!(result, Some("true".to_string()));
    }

    #[test]
    fn test_object_returns_none() {
        // Object values should not be extractable as strings
        let metadata = json!({"config": {}});
        let result = get_metadata_value(&metadata, "config");
        assert_eq!(result, None);
    }

    #[test]
    fn test_array_returns_none() {
        // Array values should not be extractable as strings
        let metadata = json!({"items": [1, 2, 3]});
        let result = get_metadata_value(&metadata, "items");
        assert_eq!(result, None);
    }

    // ============================================================================
    // Malformed Path Tests (Linus's required additions)
    // ============================================================================

    #[test]
    fn test_trailing_dot_returns_none() {
        let metadata = json!({"foo": {"bar": "baz"}});
        let result = get_metadata_value(&metadata, "foo.bar.");
        assert_eq!(result, None);
    }

    #[test]
    fn test_leading_dot_returns_none() {
        let metadata = json!({"foo": {"bar": "baz"}});
        let result = get_metadata_value(&metadata, ".foo.bar");
        assert_eq!(result, None);
    }

    #[test]
    fn test_double_dot_returns_none() {
        let metadata = json!({"foo": {"bar": "baz"}});
        let result = get_metadata_value(&metadata, "foo..bar");
        assert_eq!(result, None);
    }

    #[test]
    fn test_empty_string_returns_none() {
        let metadata = json!({"foo": "bar"});
        let result = get_metadata_value(&metadata, "");
        assert_eq!(result, None);
    }

    #[test]
    fn test_single_dot_returns_none() {
        let metadata = json!({"foo": "bar"});
        let result = get_metadata_value(&metadata, ".");
        assert_eq!(result, None);
    }
}
