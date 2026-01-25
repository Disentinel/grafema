//! Deterministic ID generation via BLAKE3

use blake3::Hasher;

/// Convert string ID to u128
///
/// Used to convert IDs like "SERVICE:name" or "MODULE:hash" to u128
///
/// # Examples
/// ```
/// use rfdb::graph::string_id_to_u128;
///
/// let id = string_id_to_u128("SERVICE:my-service");
/// assert_ne!(id, 0);
/// ```
pub fn string_id_to_u128(id: &str) -> u128 {
    let mut hasher = Hasher::new();
    hasher.update(id.as_bytes());
    let hash = hasher.finalize();
    u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap())
}

/// Compute deterministic node ID
///
/// ID = BLAKE3(type|name|scope|path) -> u128 (first 16 bytes)
/// node_type - string type (e.g., "FUNCTION", "CLASS", "http:route")
///
/// # Examples
/// ```
/// use rfdb::graph::compute_node_id;
///
/// let id = compute_node_id("FUNCTION", "getUserById", "MODULE:users.js", "src/api/users.js");
/// assert_ne!(id, 0);
/// ```
pub fn compute_node_id(
    node_type: &str,
    name: &str,
    scope: &str,
    path: &str,
) -> u128 {
    let mut hasher = Hasher::new();

    // Добавляем компоненты (все как строки)
    hasher.update(node_type.as_bytes());
    hasher.update(b"|"); // separator
    hasher.update(name.as_bytes());
    hasher.update(b"|");
    hasher.update(scope.as_bytes());
    hasher.update(b"|");
    hasher.update(path.as_bytes());

    // Берём первые 16 байт hash'а
    let hash = hasher.finalize();
    u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap())
}

/// Вычислить stable ID (без версии)
/// node_type теперь строка (e.g., "FUNCTION", "CLASS", "http:route")
/// Используем # как разделитель компонентов (чтобы не путать с : в namespace)
pub fn compute_stable_id(node_type: &str, name: &str, file: &str) -> String {
    match node_type {
        // FUNCTION, CLASS
        "FUNCTION" | "CLASS" => format!("{}#{}#{}", node_type, name, file),

        // VARIABLE - добавляем line placeholder
        "VARIABLE" => format!("{}#{}#{}#??", node_type, name, file),

        // Остальные (включая namespaced типы вроде http:route)
        _ => format!("{}#{}#{}#??", node_type, file, name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deterministic_id() {
        let id1 = compute_node_id("FUNCTION", "getUserById", "MODULE:users.js", "src/api/users.js");
        let id2 = compute_node_id("FUNCTION", "getUserById", "MODULE:users.js", "src/api/users.js");
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_different_names_different_ids() {
        let id1 = compute_node_id("FUNCTION", "getUserById", "MODULE:users.js", "src/api/users.js");
        let id2 = compute_node_id("FUNCTION", "getOrderById", "MODULE:users.js", "src/api/users.js");
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_different_types_different_ids() {
        let id1 = compute_node_id("FUNCTION", "handler", "MODULE:api.js", "src/api.js");
        let id2 = compute_node_id("http:route", "handler", "MODULE:api.js", "src/api.js");
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_stable_id_function() {
        let stable = compute_stable_id("FUNCTION", "getUserById", "src/api/users.js");
        assert_eq!(stable, "FUNCTION#getUserById#src/api/users.js");
    }

    #[test]
    fn test_stable_id_with_namespace() {
        // # как разделитель не конфликтует с : в namespace
        let stable = compute_stable_id("http:route", "/api/users", "src/routes.js");
        assert_eq!(stable, "http:route#src/routes.js#/api/users#??");
    }

    #[test]
    fn test_string_id_to_u128() {
        let id1 = string_id_to_u128("SERVICE:my-service");
        let id2 = string_id_to_u128("SERVICE:my-service");
        assert_eq!(id1, id2);

        let id3 = string_id_to_u128("SERVICE:other-service");
        assert_ne!(id1, id3);
    }
}
