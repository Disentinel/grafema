//! Shared utilities for Datalog evaluation
//!
//! This module provides helper functions used across the Datalog evaluator,
//! particularly for extracting values from JSON metadata.

use std::collections::HashSet;
use serde_json::Value;

use super::types::{Literal, Term};

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

/// Reorder query literals so that predicates requiring bound variables come after
/// the predicates that provide those bindings.
///
/// Uses a greedy topological sort: at each step, pick the first literal in `remaining`
/// whose variable requirements are satisfied by the current `bound` set.
///
/// Returns `Err` if no progress can be made (circular dependency).
pub(crate) fn reorder_literals(literals: &[Literal]) -> Result<Vec<Literal>, String> {
    let mut bound: HashSet<String> = HashSet::new();
    let mut result: Vec<Literal> = Vec::with_capacity(literals.len());
    let mut remaining: Vec<Literal> = literals.to_vec();

    while !remaining.is_empty() {
        let pos = remaining.iter().position(|lit| {
            let (can_place, _) = literal_can_place_and_provides(lit, &bound);
            can_place
        });

        match pos {
            Some(i) => {
                let lit = remaining.remove(i);
                let (_, provides) = literal_can_place_and_provides(&lit, &bound);
                bound.extend(provides);
                result.push(lit);
            }
            None => {
                let stuck: Vec<String> = remaining
                    .iter()
                    .map(|l| format!("{:?}", l))
                    .collect();
                return Err(format!(
                    "datalog reorder: circular dependency, cannot place: {:?}",
                    stuck,
                ));
            }
        }
    }

    Ok(result)
}

/// Determine whether a literal can be placed given the current set of bound variables,
/// and which new variables it provides if placed.
fn literal_can_place_and_provides(
    literal: &Literal,
    bound: &HashSet<String>,
) -> (bool, HashSet<String>) {
    match literal {
        Literal::Negative(atom) => {
            // Negative literals require ALL Var args to be in bound
            let all_bound = atom.args().iter().all(|t| match t {
                Term::Var(v) => bound.contains(v),
                _ => true,
            });
            (all_bound, HashSet::new())
        }
        Literal::Positive(atom) => {
            positive_can_place_and_provides(atom, bound)
        }
    }
}

/// Classification for positive literals.
fn positive_can_place_and_provides(
    atom: &super::types::Atom,
    bound: &HashSet<String>,
) -> (bool, HashSet<String>) {
    let args = atom.args();
    let pred = atom.predicate();

    match pred {
        "node" | "type" => {
            // node is always placeable — provides free Var args
            let provides = free_vars(args, bound);
            (true, provides)
        }
        "attr" => {
            // attr(id, name, val) — requires id AND name to be Const or in bound
            if args.len() < 3 {
                return (true, HashSet::new());
            }
            let id_ok = is_bound_or_const(&args[0], bound);
            let name_ok = is_bound_or_const(&args[1], bound);
            let can_place = id_ok && name_ok;
            let mut provides = HashSet::new();
            if can_place {
                if let Term::Var(v) = &args[2] {
                    if !bound.contains(v) {
                        provides.insert(v.clone());
                    }
                }
            }
            (can_place, provides)
        }
        "attr_edge" => {
            // attr_edge(src, dst, etype, name, val) — requires src, dst, etype, name
            if args.len() < 5 {
                return (true, HashSet::new());
            }
            let can_place = is_bound_or_const(&args[0], bound)
                && is_bound_or_const(&args[1], bound)
                && is_bound_or_const(&args[2], bound)
                && is_bound_or_const(&args[3], bound);
            let mut provides = HashSet::new();
            if can_place {
                if let Term::Var(v) = &args[4] {
                    if !bound.contains(v) {
                        provides.insert(v.clone());
                    }
                }
            }
            (can_place, provides)
        }
        "edge" => {
            // edge is always placeable (full scan if src unbound)
            let provides = free_vars(args, bound);
            (true, provides)
        }
        "incoming" | "path" => {
            // incoming(dst, src, type) / path(src, dst) — requires first arg bound
            if args.is_empty() {
                return (true, HashSet::new());
            }
            let can_place = is_bound_or_const(&args[0], bound);
            let mut provides = HashSet::new();
            if can_place {
                for arg in args.iter().skip(1) {
                    if let Term::Var(v) = arg {
                        if !bound.contains(v) {
                            provides.insert(v.clone());
                        }
                    }
                }
            }
            (can_place, provides)
        }
        "parent_function" => {
            // parent_function(node_id, fn_id) — requires first arg bound.
            // If bound, provides second arg (FunctionId) if it is a free variable.
            if args.is_empty() {
                return (true, HashSet::new());
            }
            let can_place = is_bound_or_const(&args[0], bound);
            let mut provides = HashSet::new();
            if can_place {
                if let Some(arg) = args.get(1) {
                    if let Term::Var(v) = arg {
                        if !bound.contains(v) {
                            provides.insert(v.clone());
                        }
                    }
                }
            }
            (can_place, provides)
        }
        "neq" | "starts_with" | "not_starts_with" => {
            // All Var args must be in bound
            let all_bound = args.iter().all(|t| match t {
                Term::Var(v) => bound.contains(v),
                _ => true,
            });
            (all_bound, HashSet::new())
        }
        _ => {
            // Unknown/derived predicate — always placeable, provides all free Var args.
            // Derived predicates bind variables via their rule head projection,
            // so we must report them as providers to avoid false circular dependencies.
            let provides = free_vars(args, bound);
            (true, provides)
        }
    }
}

/// Check if a term is a Const or a Var that is already in bound.
fn is_bound_or_const(term: &Term, bound: &HashSet<String>) -> bool {
    match term {
        Term::Const(_) | Term::Wildcard => true,
        Term::Var(v) => bound.contains(v),
    }
}

/// Collect all free Var names from args (Var names not yet in bound).
fn free_vars(args: &[Term], bound: &HashSet<String>) -> HashSet<String> {
    args.iter()
        .filter_map(|t| match t {
            Term::Var(v) if !bound.contains(v) => Some(v.clone()),
            _ => None,
        })
        .collect()
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
