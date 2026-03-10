//! Cypher runtime values and records.

use std::collections::HashMap;

/// A runtime value in the Cypher execution engine.
#[derive(Clone, Debug)]
pub enum CypherValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    /// A graph node, carrying its fields for property access.
    Node {
        id: u128,
        node_type: String,
        name: String,
        file: String,
        metadata: Option<String>,
        semantic_id: Option<String>,
        exported: bool,
    },
}

impl CypherValue {
    /// Access a property of this value.
    /// For Node values, maps known field names to fields, falls back to metadata JSON.
    pub fn property(&self, prop: &str) -> CypherValue {
        match self {
            CypherValue::Node {
                id,
                node_type,
                name,
                file,
                metadata,
                semantic_id,
                exported,
                ..
            } => match prop {
                "id" => CypherValue::Str(id.to_string()),
                "name" => CypherValue::Str(name.clone()),
                "type" => CypherValue::Str(node_type.clone()),
                "file" => CypherValue::Str(file.clone()),
                "exported" => CypherValue::Bool(*exported),
                "semanticId" | "semantic_id" => match semantic_id {
                    Some(s) => CypherValue::Str(s.clone()),
                    None => CypherValue::Null,
                },
                _ => {
                    // Look up in metadata JSON
                    if let Some(meta_str) = metadata {
                        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(meta_str) {
                            if let Some(val) = meta.get(prop) {
                                return CypherValue::from_json(val);
                            }
                        }
                    }
                    CypherValue::Null
                }
            },
            _ => CypherValue::Null,
        }
    }

    /// Convert from a serde_json::Value.
    pub fn from_json(v: &serde_json::Value) -> CypherValue {
        match v {
            serde_json::Value::Null => CypherValue::Null,
            serde_json::Value::Bool(b) => CypherValue::Bool(*b),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    CypherValue::Int(i)
                } else if let Some(f) = n.as_f64() {
                    CypherValue::Float(f)
                } else {
                    CypherValue::Null
                }
            }
            serde_json::Value::String(s) => CypherValue::Str(s.clone()),
            _ => CypherValue::Str(v.to_string()),
        }
    }

    /// Convert to serde_json::Value for wire protocol.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            CypherValue::Null => serde_json::Value::Null,
            CypherValue::Bool(b) => serde_json::Value::Bool(*b),
            CypherValue::Int(i) => serde_json::json!(*i),
            CypherValue::Float(f) => serde_json::json!(*f),
            CypherValue::Str(s) => serde_json::Value::String(s.clone()),
            CypherValue::Node {
                id,
                node_type,
                name,
                file,
                semantic_id,
                exported,
                ..
            } => {
                let mut map = serde_json::Map::new();
                map.insert(
                    "id".to_string(),
                    serde_json::Value::String(id.to_string()),
                );
                map.insert(
                    "type".to_string(),
                    serde_json::Value::String(node_type.clone()),
                );
                map.insert(
                    "name".to_string(),
                    serde_json::Value::String(name.clone()),
                );
                map.insert(
                    "file".to_string(),
                    serde_json::Value::String(file.clone()),
                );
                map.insert(
                    "exported".to_string(),
                    serde_json::Value::Bool(*exported),
                );
                if let Some(sid) = semantic_id {
                    map.insert(
                        "semanticId".to_string(),
                        serde_json::Value::String(sid.clone()),
                    );
                }
                serde_json::Value::Object(map)
            }
        }
    }

    /// Check if this value is truthy.
    pub fn is_truthy(&self) -> bool {
        match self {
            CypherValue::Null => false,
            CypherValue::Bool(b) => *b,
            CypherValue::Int(i) => *i != 0,
            CypherValue::Float(f) => *f != 0.0,
            CypherValue::Str(s) => !s.is_empty(),
            CypherValue::Node { .. } => true,
        }
    }

    /// Get the node ID if this is a Node value.
    pub fn as_node_id(&self) -> Option<u128> {
        match self {
            CypherValue::Node { id, .. } => Some(*id),
            _ => None,
        }
    }

    /// Compare two values for ordering. Returns None if not comparable.
    pub fn partial_cmp_values(&self, other: &CypherValue) -> Option<std::cmp::Ordering> {
        match (self, other) {
            (CypherValue::Int(a), CypherValue::Int(b)) => a.partial_cmp(b),
            (CypherValue::Float(a), CypherValue::Float(b)) => a.partial_cmp(b),
            (CypherValue::Int(a), CypherValue::Float(b)) => (*a as f64).partial_cmp(b),
            (CypherValue::Float(a), CypherValue::Int(b)) => a.partial_cmp(&(*b as f64)),
            (CypherValue::Str(a), CypherValue::Str(b)) => a.partial_cmp(b),
            (CypherValue::Bool(a), CypherValue::Bool(b)) => a.partial_cmp(b),
            (CypherValue::Null, CypherValue::Null) => Some(std::cmp::Ordering::Equal),
            (CypherValue::Null, _) => Some(std::cmp::Ordering::Less),
            (_, CypherValue::Null) => Some(std::cmp::Ordering::Greater),
            _ => None,
        }
    }
}

impl PartialEq for CypherValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (CypherValue::Null, CypherValue::Null) => true,
            (CypherValue::Bool(a), CypherValue::Bool(b)) => a == b,
            (CypherValue::Int(a), CypherValue::Int(b)) => a == b,
            (CypherValue::Float(a), CypherValue::Float(b)) => a == b,
            (CypherValue::Str(a), CypherValue::Str(b)) => a == b,
            (CypherValue::Int(a), CypherValue::Float(b)) => (*a as f64) == *b,
            (CypherValue::Float(a), CypherValue::Int(b)) => *a == (*b as f64),
            (CypherValue::Node { id: a, .. }, CypherValue::Node { id: b, .. }) => a == b,
            _ => false,
        }
    }
}

/// A record is a map of column names to values, produced by operators.
pub type Record = HashMap<String, CypherValue>;
