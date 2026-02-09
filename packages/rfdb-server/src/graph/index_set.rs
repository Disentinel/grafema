//! In-memory secondary indexes over segment data.
//!
//! Rebuilt from scratch on open() and flush() — not persisted to disk.
//! Analogous to adjacency/reverse_adjacency lists in GraphEngine.

use std::collections::HashMap;
use crate::storage::segment::NodesSegment;
use crate::storage::FieldDecl;

/// Secondary indexes for O(1) lookups over mmap segment data.
///
/// Contains:
/// - `id_index`: node ID → segment index (O(1) by-ID lookup)
/// - `type_index`: node_type → segment indices (O(1) by-type lookup)
/// - `file_index`: file_path → segment indices (O(1) by-file lookup)
/// - `field_indexes`: declared metadata field → value → segment indices (O(1) metadata lookup)
///
/// All indexes include deleted nodes — callers check deletion status separately.
pub struct IndexSet {
    /// Node ID → segment index. O(1) lookup replacing O(n) linear scan.
    id_index: HashMap<u128, usize>,

    /// Node type → list of segment indices. O(1) exact type lookup, O(T) wildcard.
    type_index: HashMap<String, Vec<usize>>,

    /// File path → list of segment indices. O(1) file lookup.
    file_index: HashMap<String, Vec<usize>>,

    /// Declared metadata field indexes.
    /// Outer key: field name (e.g. "object", "method")
    /// Inner key: field value as string (e.g. "express", "get")
    /// Value: segment indices of nodes with that field value
    field_indexes: HashMap<String, HashMap<String, Vec<usize>>>,
}

impl IndexSet {
    pub fn new() -> Self {
        Self {
            id_index: HashMap::new(),
            type_index: HashMap::new(),
            file_index: HashMap::new(),
            field_indexes: HashMap::new(),
        }
    }

    /// Rebuild all indexes from segment data in a single pass.
    ///
    /// Called from `GraphEngine::open()` and `GraphEngine::flush()`.
    /// Includes deleted nodes — the caller decides whether to reject them.
    ///
    /// When `declared_fields` is non-empty, also builds metadata field indexes
    /// by parsing metadata JSON for each node.
    pub fn rebuild_from_segment(&mut self, segment: &NodesSegment, declared_fields: &[FieldDecl]) {
        self.id_index.clear();
        self.type_index.clear();
        self.file_index.clear();
        self.field_indexes.clear();

        self.id_index.reserve(segment.node_count());

        let has_field_decls = !declared_fields.is_empty();

        for idx in 0..segment.node_count() {
            if let Some(id) = segment.get_id(idx) {
                self.id_index.insert(id, idx);
            }

            let node_type_str = segment.get_node_type(idx);

            if let Some(node_type) = node_type_str {
                self.type_index
                    .entry(node_type.to_string())
                    .or_insert_with(Vec::new)
                    .push(idx);
            }

            if let Some(file_path) = segment.get_file_path(idx) {
                if !file_path.is_empty() {
                    self.file_index
                        .entry(file_path.to_string())
                        .or_insert_with(Vec::new)
                        .push(idx);
                }
            }

            // Build field indexes from metadata JSON
            if has_field_decls {
                if let Some(metadata_json) = segment.get_metadata(idx) {
                    if !metadata_json.is_empty() {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(metadata_json) {
                            if let Some(obj) = parsed.as_object() {
                                let node_type_ref = node_type_str;
                                for decl in declared_fields {
                                    // Skip if field is restricted to specific node types
                                    // and current node type doesn't match
                                    if let Some(ref restricted_types) = decl.node_types {
                                        if let Some(nt) = node_type_ref {
                                            if !restricted_types.iter().any(|t| t == nt) {
                                                continue;
                                            }
                                        } else {
                                            continue;
                                        }
                                    }

                                    if let Some(val) = obj.get(&decl.name) {
                                        let val_str = match val {
                                            serde_json::Value::String(s) => s.clone(),
                                            serde_json::Value::Bool(b) => b.to_string(),
                                            serde_json::Value::Number(n) => n.to_string(),
                                            _ => continue,
                                        };
                                        self.field_indexes
                                            .entry(decl.name.clone())
                                            .or_insert_with(HashMap::new)
                                            .entry(val_str)
                                            .or_insert_with(Vec::new)
                                            .push(idx);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Clear all indexes.
    pub fn clear(&mut self) {
        self.id_index.clear();
        self.type_index.clear();
        self.file_index.clear();
        self.field_indexes.clear();
    }

    /// Look up segment index for a node ID. O(1).
    pub fn find_node_index(&self, id: u128) -> Option<usize> {
        self.id_index.get(&id).copied()
    }

    /// Get segment indices for an exact node type. O(1).
    ///
    /// Returns empty slice if no nodes of this type exist.
    pub fn find_by_type(&self, node_type: &str) -> &[usize] {
        self.type_index.get(node_type).map_or(&[], |v| v.as_slice())
    }

    /// Get segment indices matching a type prefix (wildcard query like "http:*").
    ///
    /// O(T) where T = number of distinct types. Collects all matching entries.
    pub fn find_by_type_prefix(&self, prefix: &str) -> Vec<usize> {
        let mut result = Vec::new();
        for (key, indices) in &self.type_index {
            if key.starts_with(prefix) {
                result.extend_from_slice(indices);
            }
        }
        result
    }

    /// Get segment indices for an exact file path. O(1).
    ///
    /// Returns empty slice if no nodes for this file exist.
    pub fn find_by_file(&self, file: &str) -> &[usize] {
        self.file_index.get(file).map_or(&[], |v| v.as_slice())
    }

    /// Check if a metadata field has been declared (has an index).
    pub fn has_field_index(&self, field_name: &str) -> bool {
        self.field_indexes.contains_key(field_name)
    }

    /// Get segment indices for a declared metadata field value. O(1).
    ///
    /// Returns None if the field is not declared (no index exists).
    /// Returns Some(empty slice) if declared but no nodes have this value.
    pub fn find_by_field(&self, field_name: &str, value: &str) -> Option<&[usize]> {
        self.field_indexes.get(field_name).map(|values| {
            values.get(value).map_or(&[] as &[usize], |v| v.as_slice())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_index_set_is_empty() {
        let index = IndexSet::new();
        assert_eq!(index.find_node_index(1), None);
        assert!(index.find_by_type("FUNCTION").is_empty());
        assert!(index.find_by_file("test.js").is_empty());
    }

    #[test]
    fn test_clear_empties_all_indexes() {
        let mut index = IndexSet::new();
        index.id_index.insert(42, 0);
        index.type_index.entry("FUNCTION".to_string()).or_default().push(0);
        index.file_index.entry("test.js".to_string()).or_default().push(0);

        index.clear();

        assert_eq!(index.find_node_index(42), None);
        assert!(index.find_by_type("FUNCTION").is_empty());
        assert!(index.find_by_file("test.js").is_empty());
    }

    #[test]
    fn test_rebuild_from_segment() {
        use tempfile::tempdir;
        use crate::storage::{NodeRecord, SegmentWriter};
        use crate::storage::segment::NodesSegment;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path();

        let nodes = vec![
            NodeRecord {
                id: 100,
                node_type: Some("FUNCTION".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("funcA".to_string()),
                file: Some("src/app.js".to_string()),
                metadata: None,
            },
            NodeRecord {
                id: 200,
                node_type: Some("FUNCTION".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: true,
                replaces: None,
                deleted: false,
                name: Some("funcB".to_string()),
                file: Some("src/app.js".to_string()),
                metadata: None,
            },
            NodeRecord {
                id: 300,
                node_type: Some("CLASS".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("ClassC".to_string()),
                file: Some("src/utils.js".to_string()),
                metadata: None,
            },
            NodeRecord {
                id: 400,
                node_type: Some("VARIABLE".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: true,
                name: Some("varD".to_string()),
                file: None,
                metadata: None,
            },
        ];

        let writer = SegmentWriter::new(db_path);
        writer.write_nodes(&nodes).unwrap();

        let segment = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();

        let mut index = IndexSet::new();
        index.rebuild_from_segment(&segment, &[]);

        // ID index
        assert_eq!(index.find_node_index(100), Some(0));
        assert_eq!(index.find_node_index(200), Some(1));
        assert_eq!(index.find_node_index(300), Some(2));
        assert_eq!(index.find_node_index(400), Some(3)); // deleted but indexed
        assert_eq!(index.find_node_index(999), None);

        // Type index
        let functions = index.find_by_type("FUNCTION");
        assert_eq!(functions.len(), 2);
        assert!(functions.contains(&0));
        assert!(functions.contains(&1));

        let classes = index.find_by_type("CLASS");
        assert_eq!(classes.len(), 1);
        assert!(classes.contains(&2));

        let variables = index.find_by_type("VARIABLE");
        assert_eq!(variables.len(), 1); // deleted node still indexed

        assert!(index.find_by_type("NONEXISTENT").is_empty());

        // File index
        let app_nodes = index.find_by_file("src/app.js");
        assert_eq!(app_nodes.len(), 2);

        let utils_nodes = index.find_by_file("src/utils.js");
        assert_eq!(utils_nodes.len(), 1);

        // Node 400 has no file — not in file_index
        assert!(index.find_by_file("").is_empty());
        assert!(index.find_by_file("nonexistent.js").is_empty());
    }

    #[test]
    fn test_find_by_type_prefix() {
        use tempfile::tempdir;
        use crate::storage::{NodeRecord, SegmentWriter};
        use crate::storage::segment::NodesSegment;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path();

        let nodes = vec![
            NodeRecord {
                id: 1,
                node_type: Some("http:route".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: None, file: None, metadata: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("http:request".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: None, file: None, metadata: None,
            },
            NodeRecord {
                id: 3,
                node_type: Some("db:query".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: None, file: None, metadata: None,
            },
        ];

        let writer = SegmentWriter::new(db_path);
        writer.write_nodes(&nodes).unwrap();
        let segment = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();

        let mut index = IndexSet::new();
        index.rebuild_from_segment(&segment, &[]);

        // Wildcard: "http:" prefix matches http:route and http:request
        let http_nodes = index.find_by_type_prefix("http:");
        assert_eq!(http_nodes.len(), 2);
        assert!(http_nodes.contains(&0)); // http:route
        assert!(http_nodes.contains(&1)); // http:request

        // Wildcard: "db:" prefix matches db:query
        let db_nodes = index.find_by_type_prefix("db:");
        assert_eq!(db_nodes.len(), 1);

        // No match
        let fs_nodes = index.find_by_type_prefix("fs:");
        assert!(fs_nodes.is_empty());
    }

    #[test]
    fn test_rebuild_replaces_previous_index() {
        use tempfile::tempdir;
        use crate::storage::{NodeRecord, SegmentWriter};
        use crate::storage::segment::NodesSegment;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path();

        let nodes1 = vec![NodeRecord {
            id: 10,
            node_type: Some("A".to_string()),
            file_id: 0, name_offset: 0,
            version: "main".to_string(),
            exported: false, replaces: None, deleted: false,
            name: None, file: Some("old.js".to_string()), metadata: None,
        }];

        let writer = SegmentWriter::new(db_path);
        writer.write_nodes(&nodes1).unwrap();
        let segment1 = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();

        let mut index = IndexSet::new();
        index.rebuild_from_segment(&segment1, &[]);
        assert_eq!(index.find_node_index(10), Some(0));
        assert_eq!(index.find_by_type("A").len(), 1);
        assert_eq!(index.find_by_file("old.js").len(), 1);

        drop(segment1);

        let nodes2 = vec![NodeRecord {
            id: 20,
            node_type: Some("B".to_string()),
            file_id: 0, name_offset: 0,
            version: "main".to_string(),
            exported: false, replaces: None, deleted: false,
            name: None, file: Some("new.js".to_string()), metadata: None,
        }];

        writer.write_nodes(&nodes2).unwrap();
        let segment2 = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();

        index.rebuild_from_segment(&segment2, &[]);

        // Old data gone
        assert_eq!(index.find_node_index(10), None);
        assert!(index.find_by_type("A").is_empty());
        assert!(index.find_by_file("old.js").is_empty());

        // New data present
        assert_eq!(index.find_node_index(20), Some(0));
        assert_eq!(index.find_by_type("B").len(), 1);
        assert_eq!(index.find_by_file("new.js").len(), 1);
    }

    #[test]
    fn test_field_index_basic() {
        use tempfile::tempdir;
        use crate::storage::{NodeRecord, SegmentWriter, FieldDecl, FieldType};
        use crate::storage::segment::NodesSegment;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path();

        let nodes = vec![
            NodeRecord {
                id: 1,
                node_type: Some("CALL".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: Some("app.get".to_string()),
                file: Some("app.js".to_string()),
                metadata: Some(r#"{"object":"express","method":"get"}"#.to_string()),
            },
            NodeRecord {
                id: 2,
                node_type: Some("CALL".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: Some("app.post".to_string()),
                file: Some("app.js".to_string()),
                metadata: Some(r#"{"object":"express","method":"post"}"#.to_string()),
            },
            NodeRecord {
                id: 3,
                node_type: Some("CALL".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: Some("db.query".to_string()),
                file: Some("db.js".to_string()),
                metadata: Some(r#"{"object":"knex","method":"query"}"#.to_string()),
            },
            NodeRecord {
                id: 4,
                node_type: Some("FUNCTION".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: Some("helper".to_string()),
                file: Some("utils.js".to_string()),
                metadata: None, // no metadata
            },
        ];

        let writer = SegmentWriter::new(db_path);
        writer.write_nodes(&nodes).unwrap();
        let segment = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();

        // Rebuild WITHOUT declared fields — no field indexes
        let mut index = IndexSet::new();
        index.rebuild_from_segment(&segment, &[]);

        assert!(!index.has_field_index("object"));
        assert_eq!(index.find_by_field("object", "express"), None);

        // Rebuild WITH declared fields
        let fields = vec![
            FieldDecl { name: "object".to_string(), field_type: FieldType::String, node_types: None },
            FieldDecl { name: "method".to_string(), field_type: FieldType::String, node_types: None },
        ];
        index.rebuild_from_segment(&segment, &fields);

        assert!(index.has_field_index("object"));
        assert!(index.has_field_index("method"));
        assert!(!index.has_field_index("nonexistent"));

        // object=express → nodes at indices 0, 1
        let express_indices = index.find_by_field("object", "express").unwrap();
        assert_eq!(express_indices.len(), 2);
        assert!(express_indices.contains(&0));
        assert!(express_indices.contains(&1));

        // object=knex → node at index 2
        let knex_indices = index.find_by_field("object", "knex").unwrap();
        assert_eq!(knex_indices.len(), 1);
        assert!(knex_indices.contains(&2));

        // object=nonexistent → empty (field indexed but no matching value)
        let none_indices = index.find_by_field("object", "nonexistent").unwrap();
        assert!(none_indices.is_empty());

        // method=get → node at index 0
        let get_indices = index.find_by_field("method", "get").unwrap();
        assert_eq!(get_indices.len(), 1);
        assert!(get_indices.contains(&0));
    }

    #[test]
    fn test_field_index_with_node_type_filter() {
        use tempfile::tempdir;
        use crate::storage::{NodeRecord, SegmentWriter, FieldDecl, FieldType};
        use crate::storage::segment::NodesSegment;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path();

        let nodes = vec![
            NodeRecord {
                id: 1,
                node_type: Some("CALL".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: None, file: None,
                metadata: Some(r#"{"object":"express"}"#.to_string()),
            },
            NodeRecord {
                id: 2,
                node_type: Some("FUNCTION".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".to_string(),
                exported: false, replaces: None, deleted: false,
                name: None, file: None,
                metadata: Some(r#"{"object":"utils"}"#.to_string()),
            },
        ];

        let writer = SegmentWriter::new(db_path);
        writer.write_nodes(&nodes).unwrap();
        let segment = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();

        // Declare "object" restricted to CALL only
        let fields = vec![
            FieldDecl {
                name: "object".to_string(),
                field_type: FieldType::String,
                node_types: Some(vec!["CALL".to_string()]),
            },
        ];

        let mut index = IndexSet::new();
        index.rebuild_from_segment(&segment, &fields);

        // object=express indexed for CALL node
        let express = index.find_by_field("object", "express").unwrap();
        assert_eq!(express.len(), 1);
        assert!(express.contains(&0));

        // object=utils NOT indexed (FUNCTION node excluded by restriction)
        let utils = index.find_by_field("object", "utils").unwrap();
        assert!(utils.is_empty());
    }
}
