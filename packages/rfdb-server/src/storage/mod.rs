//! Columnar binary storage

pub mod segment;
pub mod delta;
pub mod string_table;
pub mod writer;

use serde::{Deserialize, Serialize};

pub use writer::{SegmentWriter, GraphMetadata};

/// Node record in columnar format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRecord {
    /// Deterministic ID (BLAKE3 hash)
    pub id: u128,

    /// Node type as string (e.g., "FUNCTION", "CLASS", "http:route", "express:mount")
    /// Base types: UNKNOWN, PROJECT, SERVICE, FILE, MODULE, FUNCTION, CLASS, METHOD,
    ///             VARIABLE, PARAMETER, CONSTANT, SCOPE, CALL, IMPORT, EXPORT, EXTERNAL, SIDE_EFFECT
    /// With namespace: http:route, http:endpoint, http:request, db:query, fs:operation, etc.
    #[serde(default)]
    pub node_type: Option<String>,

    /// File ID in string table (computed during flush)
    pub file_id: u32,

    /// Name offset in string table (computed during flush)
    pub name_offset: u32,

    /// Version ("main" or "__local")
    pub version: String,

    /// Whether exported (for MODULE_BOUNDARY detection)
    pub exported: bool,

    /// Stable ID of the node being replaced (for version-aware)
    pub replaces: Option<u128>,

    /// Tombstone flag (soft delete)
    pub deleted: bool,

    /// Entity name (function name, class name, etc.) - stored temporarily until flush
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// File path - stored temporarily until flush
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,

    /// JSON metadata (async, generator, arrowFunction, line, etc.) - stored temporarily until flush
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,

    /// Semantic ID string (populated from v2 storage, None for v1)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub semantic_id: Option<String>,
}

/// Edge record in columnar format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeRecord {
    /// Source node ID
    pub src: u128,

    /// Target node ID
    pub dst: u128,

    /// Edge type as string (e.g., "CALLS", "CONTAINS", "http:routes_to")
    /// Similar to node_type - base types are UPPERCASE, namespaced via ':'
    #[serde(default)]
    pub edge_type: Option<String>,

    /// Edge version
    pub version: String,

    /// JSON metadata (argIndex, isSpread, etc.) - similar to node metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,

    /// Tombstone flag
    pub deleted: bool,
}

/// Query for filtering nodes by attributes
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AttrQuery {
    /// Deprecated node-level version filter.
    /// Kept for wire compatibility; v2 query engine ignores this field.
    pub version: Option<String>,
    /// Node type as string. Supports wildcard: "http:*" for all http types
    pub node_type: Option<String>,
    pub file_id: Option<u32>,
    /// File path for filtering (alternative to file_id)
    pub file: Option<String>,
    pub exported: Option<bool>,
    pub name: Option<String>,
    /// Metadata field filters: (key, value) pairs matched against node metadata JSON.
    /// All filters must match (AND semantics).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub metadata_filters: Vec<(String, String)>,
}

impl AttrQuery {
    pub fn new() -> Self {
        Self::default()
    }

    /// Deprecated builder for legacy node-level version filter.
    /// Kept for API compatibility; v2 query engine ignores this field.
    pub fn version(mut self, v: impl Into<String>) -> Self {
        self.version = Some(v.into());
        self
    }

    pub fn node_type(mut self, t: impl Into<String>) -> Self {
        self.node_type = Some(t.into());
        self
    }

    pub fn file_id(mut self, f: u32) -> Self {
        self.file_id = Some(f);
        self
    }

    pub fn exported(mut self, e: bool) -> Self {
        self.exported = Some(e);
        self
    }

    pub fn name(mut self, n: impl Into<String>) -> Self {
        self.name = Some(n.into());
        self
    }

    pub fn metadata_filter(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata_filters.push((key.into(), value.into()));
        self
    }
}

/// Declaration of a metadata field to be indexed.
///
/// Plugins declare which metadata fields they write. RFDB builds
/// in-memory secondary indexes for these fields, enabling O(1) lookup
/// by metadata value instead of O(n) JSON parsing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldDecl {
    /// Field name as it appears in metadata JSON (e.g. "object", "method", "async")
    pub name: String,
    /// Field type hint (for future segment v2 columnar storage)
    #[serde(default)]
    pub field_type: FieldType,
    /// Restrict indexing to specific node types (optimization).
    /// If None, the field is indexed for all node types.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_types: Option<Vec<String>>,
}

/// Type hint for declared metadata fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    #[default]
    String,
    Bool,
    Int,
    Id,
}
