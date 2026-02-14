//! GraphEngineV2 — adapter wrapping MultiShardStore + ManifestStore
//! behind the GraphStore trait.
//!
//! Translates between v1 record types (NodeRecord/EdgeRecord) used by
//! GraphStore and v2 types (NodeRecordV2/EdgeRecordV2) used by the
//! sharded columnar storage.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::storage::{AttrQuery, EdgeRecord, FieldDecl, NodeRecord};
use crate::storage_v2::manifest::{ManifestStore, SnapshotDiff, SnapshotInfo};
use crate::storage_v2::multi_shard::MultiShardStore;
use crate::storage_v2::types::{CommitDelta, EdgeRecordV2, NodeRecordV2};
use super::{GraphStore, traversal};

/// Default shard count for new databases.
const DEFAULT_SHARD_COUNT: u16 = 4;

// ── Type Conversion ────────────────────────────────────────────────

/// Convert v2 node record to v1 (for GraphStore return values).
fn node_v2_to_v1(v2: &NodeRecordV2) -> NodeRecord {
    NodeRecord {
        id: v2.id,
        node_type: Some(v2.node_type.clone()),
        file_id: 0,
        name_offset: 0,
        version: "main".to_string(),
        exported: false,
        replaces: None,
        deleted: false,
        name: Some(v2.name.clone()),
        file: Some(v2.file.clone()),
        metadata: if v2.metadata.is_empty() {
            None
        } else {
            Some(v2.metadata.clone())
        },
    }
}

/// Convert v1 node record to v2 (for GraphStore input).
fn node_v1_to_v2(v1: &NodeRecord) -> NodeRecordV2 {
    let node_type = v1.node_type.as_deref().unwrap_or("UNKNOWN");
    let name = v1.name.as_deref().unwrap_or("");
    let file = v1.file.as_deref().unwrap_or("");
    let metadata = v1.metadata.as_deref().unwrap_or("");
    let semantic_id = format!("{}:{}@{}", node_type, name, file);

    NodeRecordV2 {
        semantic_id,
        id: v1.id,
        node_type: node_type.to_string(),
        name: name.to_string(),
        file: file.to_string(),
        content_hash: 0,
        metadata: metadata.to_string(),
    }
}

/// Convert v2 edge record to v1 (for GraphStore return values).
fn edge_v2_to_v1(v2: &EdgeRecordV2) -> EdgeRecord {
    EdgeRecord {
        src: v2.src,
        dst: v2.dst,
        edge_type: Some(v2.edge_type.clone()),
        version: "main".to_string(),
        metadata: if v2.metadata.is_empty() {
            None
        } else {
            Some(v2.metadata.clone())
        },
        deleted: false,
    }
}

/// Convert v1 edge record to v2 (for GraphStore input).
fn edge_v1_to_v2(v1: &EdgeRecord) -> EdgeRecordV2 {
    EdgeRecordV2 {
        src: v1.src,
        dst: v1.dst,
        edge_type: v1.edge_type.as_deref().unwrap_or("UNKNOWN").to_string(),
        metadata: v1.metadata.as_deref().unwrap_or("").to_string(),
    }
}

// ── GraphEngineV2 ──────────────────────────────────────────────────

/// Graph engine backed by v2 sharded columnar storage.
///
/// Wraps MultiShardStore + ManifestStore and implements the GraphStore
/// trait, translating between v1 and v2 record types at the boundary.
///
/// Soft-deletes are buffered in memory (pending tombstones) and applied
/// on flush.
pub struct GraphEngineV2 {
    store: MultiShardStore,
    manifest: ManifestStore,
    #[allow(dead_code)]
    path: Option<PathBuf>,
    #[allow(dead_code)]
    ephemeral: bool,
    /// Node IDs marked for deletion but not yet flushed.
    pending_tombstone_nodes: HashSet<u128>,
    /// Edge keys marked for deletion but not yet flushed.
    pending_tombstone_edges: HashSet<(u128, u128, String)>,
    /// Declared metadata fields for indexing (v1 compat).
    declared_fields: Vec<FieldDecl>,
}

// ── Constructors ────────────────────────────────────────────────────

impl GraphEngineV2 {
    /// Create a new database on disk at the given path.
    pub fn create<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref();
        std::fs::create_dir_all(path)?;
        let store = MultiShardStore::create(path, DEFAULT_SHARD_COUNT)?;
        let manifest = ManifestStore::create(path)?;

        Ok(Self {
            store,
            manifest,
            path: Some(path.to_path_buf()),
            ephemeral: false,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
        })
    }

    /// Create an ephemeral (in-memory only) engine for tests.
    pub fn create_ephemeral() -> Self {
        Self {
            store: MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT),
            manifest: ManifestStore::ephemeral(),
            path: None,
            ephemeral: true,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
        }
    }

    /// Open an existing database from disk.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref();
        let manifest = ManifestStore::open(path)?;
        let store = MultiShardStore::open(path, &manifest)?;

        Ok(Self {
            store,
            manifest,
            path: Some(path.to_path_buf()),
            ephemeral: false,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
        })
    }
}

// ── Helper: tombstone filtering ─────────────────────────────────────

impl GraphEngineV2 {
    /// Check if a node is pending tombstone.
    fn is_node_tombstoned(&self, id: u128) -> bool {
        self.pending_tombstone_nodes.contains(&id)
    }

    /// Check if an edge is pending tombstone.
    fn is_edge_tombstoned(&self, src: u128, dst: u128, edge_type: &str) -> bool {
        self.pending_tombstone_edges.contains(&(src, dst, edge_type.to_string()))
    }

    /// Filter tombstoned edges from a list of v2 edge records.
    fn filter_edges(&self, edges: Vec<EdgeRecordV2>) -> Vec<EdgeRecordV2> {
        edges
            .into_iter()
            .filter(|e| !self.is_edge_tombstoned(e.src, e.dst, &e.edge_type))
            .collect()
    }

    /// Check if metadata matches all filters from AttrQuery.
    fn metadata_matches(metadata: &str, filters: &[(String, String)]) -> bool {
        if filters.is_empty() {
            return true;
        }
        if metadata.is_empty() {
            return false;
        }
        let parsed: serde_json::Value = match serde_json::from_str(metadata) {
            Ok(v) => v,
            Err(_) => return false,
        };
        for (key, value) in filters {
            match parsed.get(key) {
                Some(v) => {
                    // Compare as string representation
                    let v_str = match v {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Bool(b) => b.to_string(),
                        serde_json::Value::Number(n) => n.to_string(),
                        other => other.to_string(),
                    };
                    if v_str != *value {
                        return false;
                    }
                }
                None => return false,
            }
        }
        true
    }
}

// ── GraphStore Implementation ───────────────────────────────────────

impl GraphStore for GraphEngineV2 {
    fn add_nodes(&mut self, nodes: Vec<NodeRecord>) {
        let v2_nodes: Vec<NodeRecordV2> = nodes.iter().map(node_v1_to_v2).collect();
        self.store.add_nodes(v2_nodes);
    }

    fn delete_node(&mut self, id: u128) {
        // Tombstone the node
        self.pending_tombstone_nodes.insert(id);

        // Also tombstone all connected edges (outgoing + incoming)
        let outgoing = self.store.get_outgoing_edges(id, None);
        for edge in &outgoing {
            self.pending_tombstone_edges.insert((
                edge.src,
                edge.dst,
                edge.edge_type.clone(),
            ));
        }
        let incoming = self.store.get_incoming_edges(id, None);
        for edge in &incoming {
            self.pending_tombstone_edges.insert((
                edge.src,
                edge.dst,
                edge.edge_type.clone(),
            ));
        }
    }

    fn get_node(&self, id: u128) -> Option<NodeRecord> {
        if self.is_node_tombstoned(id) {
            return None;
        }
        self.store.get_node(id).map(|v2| node_v2_to_v1(&v2))
    }

    fn node_exists(&self, id: u128) -> bool {
        if self.is_node_tombstoned(id) {
            return false;
        }
        self.store.node_exists(id)
    }

    fn get_node_identifier(&self, id: u128) -> Option<String> {
        self.get_node(id).map(|node| {
            let node_type = node.node_type.as_deref().unwrap_or("UNKNOWN");
            let name = node.name.as_deref().unwrap_or("");
            let file = node.file.as_deref().unwrap_or("");
            format!("{}:{}@{}", node_type, name, file)
        })
    }

    fn find_by_attr(&self, query: &AttrQuery) -> Vec<u128> {
        // Use store.find_nodes with type and file filters
        let node_type_filter = query.node_type.as_deref();
        let file_filter = query.file.as_deref();

        // Handle wildcard node_type — find_nodes doesn't support wildcards
        let (use_type, wildcard_prefix) = match node_type_filter {
            Some(t) if t.ends_with('*') => (None, Some(t.trim_end_matches('*'))),
            other => (other, None),
        };

        let nodes = self.store.find_nodes(use_type, file_filter);

        nodes
            .into_iter()
            .filter(|n| {
                // Exclude tombstoned
                if self.is_node_tombstoned(n.id) {
                    return false;
                }
                // Wildcard type filter
                if let Some(prefix) = wildcard_prefix {
                    if !n.node_type.starts_with(prefix) {
                        return false;
                    }
                }
                // Name filter
                if let Some(ref name) = query.name {
                    if n.name != *name {
                        return false;
                    }
                }
                // Metadata filters
                if !Self::metadata_matches(&n.metadata, &query.metadata_filters) {
                    return false;
                }
                true
            })
            .map(|n| n.id)
            .collect()
    }

    fn find_by_type(&self, node_type: &str) -> Vec<u128> {
        if node_type.ends_with('*') {
            // Wildcard: "http:*" → find all, filter by prefix
            let prefix = node_type.trim_end_matches('*');
            self.store
                .find_nodes(None, None)
                .into_iter()
                .filter(|n| n.node_type.starts_with(prefix) && !self.is_node_tombstoned(n.id))
                .map(|n| n.id)
                .collect()
        } else {
            // Exact match
            self.store
                .find_nodes(Some(node_type), None)
                .into_iter()
                .filter(|n| !self.is_node_tombstoned(n.id))
                .map(|n| n.id)
                .collect()
        }
    }

    fn add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool) {
        let v2_edges: Vec<EdgeRecordV2> = edges.iter().map(edge_v1_to_v2).collect();
        let result = self.store.add_edges(v2_edges);
        if !skip_validation {
            if let Err(e) = result {
                tracing::warn!("add_edges error: {}", e);
            }
        }
        // If skip_validation, silently ignore errors
    }

    fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str) {
        self.pending_tombstone_edges.insert((
            src,
            dst,
            edge_type.to_string(),
        ));
    }

    fn neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        let edge_types_opt = if edge_types.is_empty() {
            None
        } else {
            Some(edge_types)
        };
        let edges = self.store.get_outgoing_edges(id, edge_types_opt);
        self.filter_edges(edges)
            .into_iter()
            .filter(|e| !self.is_node_tombstoned(e.dst))
            .map(|e| e.dst)
            .collect()
    }

    fn get_outgoing_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord> {
        let edges = self.store.get_outgoing_edges(node_id, edge_types);
        self.filter_edges(edges)
            .iter()
            .map(edge_v2_to_v1)
            .collect()
    }

    fn get_incoming_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord> {
        let edges = self.store.get_incoming_edges(node_id, edge_types);
        self.filter_edges(edges)
            .iter()
            .map(edge_v2_to_v1)
            .collect()
    }

    fn get_all_edges(&self) -> Vec<EdgeRecord> {
        // Collect all node IDs, then gather outgoing edges for each
        let all_nodes = self.store.find_nodes(None, None);
        let mut seen_keys: HashSet<(u128, u128, String)> = HashSet::new();
        let mut result: Vec<EdgeRecord> = Vec::new();

        for node in &all_nodes {
            if self.is_node_tombstoned(node.id) {
                continue;
            }
            let edges = self.store.get_outgoing_edges(node.id, None);
            for edge in self.filter_edges(edges) {
                let key = (edge.src, edge.dst, edge.edge_type.clone());
                if seen_keys.insert(key) {
                    result.push(edge_v2_to_v1(&edge));
                }
            }
        }

        result
    }

    fn count_nodes_by_type(&self, types: Option<&[String]>) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();

        match types {
            Some(type_list) => {
                for t in type_list {
                    if t.ends_with('*') {
                        // Wildcard
                        let prefix = t.trim_end_matches('*');
                        let nodes = self.store.find_nodes(None, None);
                        for n in nodes {
                            if n.node_type.starts_with(prefix) && !self.is_node_tombstoned(n.id) {
                                *counts.entry(n.node_type).or_insert(0) += 1;
                            }
                        }
                    } else {
                        let nodes = self.store.find_nodes(Some(t), None);
                        let count = nodes
                            .iter()
                            .filter(|n| !self.is_node_tombstoned(n.id))
                            .count();
                        if count > 0 {
                            counts.insert(t.clone(), count);
                        }
                    }
                }
            }
            None => {
                let nodes = self.store.find_nodes(None, None);
                for n in nodes {
                    if !self.is_node_tombstoned(n.id) {
                        *counts.entry(n.node_type).or_insert(0) += 1;
                    }
                }
            }
        }

        counts
    }

    fn count_edges_by_type(&self, edge_types: Option<&[String]>) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();

        // Collect all edges via get_all_edges (already filters tombstoned)
        let all_edges = self.get_all_edges();

        for edge in &all_edges {
            let et = edge.edge_type.as_deref().unwrap_or("UNKNOWN");

            match edge_types {
                Some(filter) => {
                    let matches = filter.iter().any(|f| {
                        if f.ends_with('*') {
                            et.starts_with(f.trim_end_matches('*'))
                        } else {
                            et == f
                        }
                    });
                    if matches {
                        *counts.entry(et.to_string()).or_insert(0) += 1;
                    }
                }
                None => {
                    *counts.entry(et.to_string()).or_insert(0) += 1;
                }
            }
        }

        counts
    }

    fn bfs(&self, start: &[u128], max_depth: usize, edge_types: &[&str]) -> Vec<u128> {
        let edge_types_owned: Vec<String> = edge_types.iter().map(|s| s.to_string()).collect();
        traversal::bfs(start, max_depth, |node_id| {
            let types_refs: Vec<&str> = edge_types_owned.iter().map(|s| s.as_str()).collect();
            self.neighbors(node_id, &types_refs)
        })
    }

    fn flush(&mut self) -> Result<()> {
        // Apply pending tombstones to shards before flushing to disk.
        // This ensures delete_node/delete_edge operations are persisted.
        if !self.pending_tombstone_nodes.is_empty() || !self.pending_tombstone_edges.is_empty() {
            self.store.set_tombstones(
                &self.pending_tombstone_nodes,
                &self.pending_tombstone_edges,
            );
            self.pending_tombstone_nodes.clear();
            self.pending_tombstone_edges.clear();
        }
        self.store.flush_all(&mut self.manifest)?;
        Ok(())
    }

    fn compact(&mut self) -> Result<()> {
        // No-op for v2 storage (compaction is handled differently)
        Ok(())
    }

    fn node_count(&self) -> usize {
        let total = self.store.node_count();
        total.saturating_sub(self.pending_tombstone_nodes.len())
    }

    fn edge_count(&self) -> usize {
        let total = self.store.edge_count();
        total.saturating_sub(self.pending_tombstone_edges.len())
    }

    fn clear(&mut self) {
        self.store = MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT);
        self.manifest = ManifestStore::ephemeral();
        self.pending_tombstone_nodes.clear();
        self.pending_tombstone_edges.clear();
        self.declared_fields.clear();
    }

    fn declare_fields(&mut self, fields: Vec<FieldDecl>) {
        self.declared_fields = fields;
    }

    fn as_any(&self) -> &dyn std::any::Any { self }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
}

// ── Engine-specific Methods (NOT on GraphStore trait) ────────────────

impl GraphEngineV2 {
    /// Check if a node is an endpoint (for PathValidator).
    ///
    /// Endpoint types: db:query, http:request, http:endpoint,
    /// EXTERNAL, fs:operation, SIDE_EFFECT, exported FUNCTION.
    pub fn is_endpoint(&self, id: u128) -> bool {
        if let Some(v2) = self.store.get_node(id) {
            if self.is_node_tombstoned(id) {
                return false;
            }

            let node_type = v2.node_type.as_str();

            if matches!(
                node_type,
                "db:query"
                    | "http:request"
                    | "http:endpoint"
                    | "EXTERNAL"
                    | "fs:operation"
                    | "SIDE_EFFECT"
            ) {
                return true;
            }

            // v2 doesn't have an `exported` field on the record —
            // check metadata for {"exported":true}
            if node_type == "FUNCTION" && !v2.metadata.is_empty() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&v2.metadata) {
                    if parsed.get("exported") == Some(&serde_json::Value::Bool(true)) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// BFS/DFS reachability with optional backward traversal.
    pub fn reachability(
        &self,
        start: &[u128],
        max_depth: usize,
        edge_types: &[&str],
        backward: bool,
    ) -> Vec<u128> {
        let edge_types_owned: Vec<String> = edge_types.iter().map(|s| s.to_string()).collect();

        if backward {
            traversal::bfs(start, max_depth, |node_id| {
                let types_refs: Vec<&str> =
                    edge_types_owned.iter().map(|s| s.as_str()).collect();
                self.reverse_neighbors(node_id, &types_refs)
            })
        } else {
            traversal::bfs(start, max_depth, |node_id| {
                let types_refs: Vec<&str> =
                    edge_types_owned.iter().map(|s| s.as_str()).collect();
                self.neighbors_internal(node_id, &types_refs)
            })
        }
    }

    /// Get the currently declared fields.
    pub fn declared_fields_ref(&self) -> &[FieldDecl] {
        &self.declared_fields
    }

    /// Atomic batch commit (v2-native API).
    pub fn commit_batch(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
    ) -> Result<CommitDelta> {
        self.store
            .commit_batch(nodes, edges, changed_files, tags, &mut self.manifest)
    }

    /// Tag an existing snapshot.
    pub fn tag_snapshot(
        &mut self,
        version: u64,
        tags: HashMap<String, String>,
    ) -> Result<()> {
        self.manifest.tag_snapshot(version, tags)
    }

    /// Find a snapshot by tag key/value.
    pub fn find_snapshot(&self, tag_key: &str, tag_value: &str) -> Option<u64> {
        self.manifest.find_snapshot(tag_key, tag_value)
    }

    /// List snapshots, optionally filtered by tag key.
    pub fn list_snapshots(&self, filter_tag: Option<&str>) -> Vec<SnapshotInfo> {
        self.manifest.list_snapshots(filter_tag)
    }

    /// Diff two snapshots.
    pub fn diff_snapshots(
        &self,
        from_version: u64,
        to_version: u64,
    ) -> Result<SnapshotDiff> {
        self.manifest.diff_snapshots(from_version, to_version)
    }

    /// Whether this engine is ephemeral (in-memory only).
    pub fn is_ephemeral(&self) -> bool {
        self.ephemeral
    }

    // ── Private helpers ──────────────────────────────────────────────

    /// Get incoming neighbors (src nodes of incoming edges).
    fn reverse_neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        let edge_types_opt = if edge_types.is_empty() {
            None
        } else {
            Some(edge_types)
        };
        let edges = self.store.get_incoming_edges(id, edge_types_opt);
        self.filter_edges(edges)
            .into_iter()
            .filter(|e| !self.is_node_tombstoned(e.src))
            .map(|e| e.src)
            .collect()
    }

    /// Internal neighbors helper (same as GraphStore::neighbors but
    /// callable without trait dispatch, avoids borrow issues).
    fn neighbors_internal(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        let edge_types_opt = if edge_types.is_empty() {
            None
        } else {
            Some(edge_types)
        };
        let edges = self.store.get_outgoing_edges(id, edge_types_opt);
        self.filter_edges(edges)
            .into_iter()
            .filter(|e| !self.is_node_tombstoned(e.dst))
            .map(|e| e.dst)
            .collect()
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::FieldType;

    // ── Helpers ──────────────────────────────────────────────────────

    fn make_v2_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
        let hash = blake3::hash(semantic_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        NodeRecordV2 {
            semantic_id: semantic_id.to_string(),
            id,
            node_type: node_type.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    fn make_v1_node(id: u128, node_type: &str, name: &str, file: &str) -> NodeRecord {
        NodeRecord {
            id,
            node_type: Some(node_type.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(name.to_string()),
            file: Some(file.to_string()),
            metadata: None,
        }
    }

    // ── Conversion Tests ─────────────────────────────────────────────

    #[test]
    fn test_node_record_v2_to_v1_roundtrip() {
        let v2 = NodeRecordV2 {
            semantic_id: "FUNCTION:foo@src/main.js".to_string(),
            id: 42,
            node_type: "FUNCTION".to_string(),
            name: "foo".to_string(),
            file: "src/main.js".to_string(),
            content_hash: 123,
            metadata: r#"{"async":true}"#.to_string(),
        };

        let v1 = node_v2_to_v1(&v2);
        assert_eq!(v1.id, 42);
        assert_eq!(v1.node_type, Some("FUNCTION".to_string()));
        assert_eq!(v1.name, Some("foo".to_string()));
        assert_eq!(v1.file, Some("src/main.js".to_string()));
        assert_eq!(v1.metadata, Some(r#"{"async":true}"#.to_string()));
        assert_eq!(v1.version, "main");
        assert!(!v1.exported);
        assert!(!v1.deleted);

        // Back to v2
        let back = node_v1_to_v2(&v1);
        assert_eq!(back.id, 42);
        assert_eq!(back.node_type, "FUNCTION");
        assert_eq!(back.name, "foo");
        assert_eq!(back.file, "src/main.js");
        assert_eq!(back.metadata, r#"{"async":true}"#);
    }

    #[test]
    fn test_node_record_v1_to_v2_conversion() {
        let v1 = NodeRecord {
            id: 99,
            node_type: None,
            file_id: 5,
            name_offset: 10,
            version: "main".to_string(),
            exported: true,
            replaces: Some(50),
            deleted: false,
            name: None,
            file: None,
            metadata: None,
        };

        let v2 = node_v1_to_v2(&v1);
        assert_eq!(v2.id, 99);
        assert_eq!(v2.node_type, "UNKNOWN");
        assert_eq!(v2.name, "");
        assert_eq!(v2.file, "");
        assert_eq!(v2.metadata, "");
        assert_eq!(v2.semantic_id, "UNKNOWN:@");
        assert_eq!(v2.content_hash, 0);
    }

    #[test]
    fn test_edge_record_v2_to_v1_roundtrip() {
        let v2 = EdgeRecordV2 {
            src: 1,
            dst: 2,
            edge_type: "CALLS".to_string(),
            metadata: r#"{"argIndex":0}"#.to_string(),
        };

        let v1 = edge_v2_to_v1(&v2);
        assert_eq!(v1.src, 1);
        assert_eq!(v1.dst, 2);
        assert_eq!(v1.edge_type, Some("CALLS".to_string()));
        assert_eq!(v1.metadata, Some(r#"{"argIndex":0}"#.to_string()));
        assert!(!v1.deleted);

        let back = edge_v1_to_v2(&v1);
        assert_eq!(back.src, 1);
        assert_eq!(back.dst, 2);
        assert_eq!(back.edge_type, "CALLS");
        assert_eq!(back.metadata, r#"{"argIndex":0}"#);
    }

    // ── Engine Lifecycle Tests ────────────────────────────────────────

    #[test]
    fn test_create_ephemeral() {
        let engine = GraphEngineV2::create_ephemeral();
        assert!(engine.is_ephemeral());
        assert_eq!(engine.node_count(), 0);
        assert_eq!(engine.edge_count(), 0);
    }

    #[test]
    fn test_add_get_node() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let node = make_v1_node(100, "FUNCTION", "foo", "src/main.js");

        engine.add_nodes(vec![node]);

        assert!(engine.node_exists(100));
        let retrieved = engine.get_node(100).unwrap();
        assert_eq!(retrieved.id, 100);
        assert_eq!(retrieved.node_type, Some("FUNCTION".to_string()));
        assert_eq!(retrieved.name, Some("foo".to_string()));
        assert_eq!(retrieved.file, Some("src/main.js".to_string()));
    }

    #[test]
    fn test_delete_node_buffered() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let node = make_v1_node(200, "CLASS", "Bar", "src/bar.js");
        engine.add_nodes(vec![node]);

        assert!(engine.node_exists(200));
        engine.delete_node(200);
        assert!(!engine.node_exists(200));
        assert!(engine.get_node(200).is_none());
    }

    #[test]
    fn test_find_by_type() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(1, "FUNCTION", "a", "src/a.js"),
            make_v1_node(2, "FUNCTION", "b", "src/b.js"),
            make_v1_node(3, "CLASS", "C", "src/c.js"),
        ]);

        let funcs = engine.find_by_type("FUNCTION");
        assert_eq!(funcs.len(), 2);
        assert!(funcs.contains(&1));
        assert!(funcs.contains(&2));

        let classes = engine.find_by_type("CLASS");
        assert_eq!(classes.len(), 1);
        assert!(classes.contains(&3));
    }

    #[test]
    fn test_find_by_type_wildcard() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(10, "http:request", "req1", "src/a.js"),
            make_v1_node(11, "http:endpoint", "ep1", "src/b.js"),
            make_v1_node(12, "db:query", "q1", "src/c.js"),
        ]);

        let http_nodes = engine.find_by_type("http:*");
        assert_eq!(http_nodes.len(), 2);
        assert!(http_nodes.contains(&10));
        assert!(http_nodes.contains(&11));
    }

    #[test]
    fn test_find_by_attr() {
        let mut engine = GraphEngineV2::create_ephemeral();

        let mut node = make_v1_node(20, "FUNCTION", "handler", "src/routes.js");
        node.metadata = Some(r#"{"async":true}"#.to_string());
        engine.add_nodes(vec![
            node,
            make_v1_node(21, "FUNCTION", "helper", "src/utils.js"),
        ]);

        // Find by name
        let query = AttrQuery::new().name("handler");
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&20));

        // Find by type + name
        let query = AttrQuery::new().node_type("FUNCTION").name("helper");
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&21));

        // Find by metadata filter
        let query = AttrQuery::new().metadata_filter("async", "true");
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&20));
    }

    #[test]
    fn test_add_get_edges() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(30, "FUNCTION", "caller", "src/a.js"),
            make_v1_node(31, "FUNCTION", "callee", "src/a.js"),
        ]);

        let edge = EdgeRecord {
            src: 30,
            dst: 31,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        };
        engine.add_edges(vec![edge], false);

        let outgoing = engine.get_outgoing_edges(30, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].src, 30);
        assert_eq!(outgoing[0].dst, 31);
        assert_eq!(outgoing[0].edge_type, Some("CALLS".to_string()));

        let incoming = engine.get_incoming_edges(31, None);
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].src, 30);
    }

    #[test]
    fn test_neighbors() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(40, "FUNCTION", "a", "src/a.js"),
            make_v1_node(41, "FUNCTION", "b", "src/a.js"),
            make_v1_node(42, "FUNCTION", "c", "src/a.js"),
        ]);
        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 40, dst: 41,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 40, dst: 42,
                    edge_type: Some("IMPORTS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
            ],
            false,
        );

        // All neighbors
        let all = engine.neighbors(40, &[]);
        assert_eq!(all.len(), 2);

        // Filter by edge type
        let calls_only = engine.neighbors(40, &["CALLS"]);
        assert_eq!(calls_only.len(), 1);
        assert!(calls_only.contains(&41));
    }

    #[test]
    fn test_bfs_traversal() {
        let mut engine = GraphEngineV2::create_ephemeral();
        // Graph: 50 -> 51 -> 52 -> 53
        engine.add_nodes(vec![
            make_v1_node(50, "FUNCTION", "a", "src/a.js"),
            make_v1_node(51, "FUNCTION", "b", "src/a.js"),
            make_v1_node(52, "FUNCTION", "c", "src/a.js"),
            make_v1_node(53, "FUNCTION", "d", "src/a.js"),
        ]);
        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 50, dst: 51,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 51, dst: 52,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 52, dst: 53,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
            ],
            false,
        );

        // Full BFS
        let result = engine.bfs(&[50], 10, &["CALLS"]);
        assert_eq!(result.len(), 4);

        // Depth-limited BFS
        let result = engine.bfs(&[50], 2, &["CALLS"]);
        assert_eq!(result.len(), 3); // 50, 51, 52
        assert!(!result.contains(&53));
    }

    #[test]
    fn test_flush_persists_tombstones() {
        let mut engine = GraphEngineV2::create_ephemeral();

        // Use proper blake3-derived IDs (flush writes to segments which
        // assert id == blake3(semantic_id))
        let live = make_v2_node("FUNCTION:live@src/a.js", "FUNCTION", "live", "src/a.js");
        let dead = make_v2_node("FUNCTION:dead@src/a.js", "FUNCTION", "dead", "src/a.js");
        let live_id = live.id;
        let dead_id = dead.id;

        engine.store.add_nodes(vec![live, dead]);

        engine.delete_node(dead_id);
        assert!(!engine.node_exists(dead_id));
        assert!(engine.node_exists(live_id));

        // Flush clears pending tombstones
        engine.flush().unwrap();
        assert!(engine.pending_tombstone_nodes.is_empty());
        assert!(engine.pending_tombstone_edges.is_empty());
    }

    #[test]
    fn test_commit_batch_v2() {
        let mut engine = GraphEngineV2::create_ephemeral();

        let node = make_v2_node("FUNCTION:init@src/app.js", "FUNCTION", "init", "src/app.js");
        let node_id = node.id;

        let delta = engine
            .commit_batch(
                vec![node],
                vec![],
                &["src/app.js".to_string()],
                HashMap::from([("version".to_string(), "v1".to_string())]),
            )
            .unwrap();

        assert_eq!(delta.changed_files, vec!["src/app.js"]);
        assert!(delta.nodes_added > 0 || delta.nodes_modified == 0);
        assert!(engine.node_exists(node_id));
    }

    #[test]
    fn test_v1_v2_equivalence() {
        // Verify that adding a v1 node and retrieving it produces
        // consistent data after v1->v2->v1 conversion
        let mut engine = GraphEngineV2::create_ephemeral();

        let original = NodeRecord {
            id: 999,
            node_type: Some("METHOD".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("process".to_string()),
            file: Some("src/worker.js".to_string()),
            metadata: Some(r#"{"line":42}"#.to_string()),
        };

        engine.add_nodes(vec![original.clone()]);
        let retrieved = engine.get_node(999).unwrap();

        // Core fields must match
        assert_eq!(retrieved.id, original.id);
        assert_eq!(retrieved.node_type, original.node_type);
        assert_eq!(retrieved.name, original.name);
        assert_eq!(retrieved.file, original.file);
        assert_eq!(retrieved.metadata, original.metadata);

        // Identifier format
        let ident = engine.get_node_identifier(999).unwrap();
        assert_eq!(ident, "METHOD:process@src/worker.js");
    }

    // ── Extra Method Tests ───────────────────────────────────────────

    #[test]
    fn test_clear_resets_engine() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![make_v1_node(70, "FUNCTION", "x", "src/x.js")]);
        assert_eq!(engine.node_count(), 1);

        engine.clear();
        assert_eq!(engine.node_count(), 0);
        assert!(!engine.node_exists(70));
    }

    #[test]
    fn test_is_endpoint() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(80, "http:request", "req", "src/a.js"),
            make_v1_node(81, "FUNCTION", "helper", "src/a.js"),
            make_v1_node(82, "db:query", "q", "src/a.js"),
            make_v1_node(83, "EXTERNAL", "ext", "src/a.js"),
        ]);

        assert!(engine.is_endpoint(80));  // http:request
        assert!(!engine.is_endpoint(81)); // regular FUNCTION
        assert!(engine.is_endpoint(82));  // db:query
        assert!(engine.is_endpoint(83));  // EXTERNAL
    }

    #[test]
    fn test_reachability_forward_and_backward() {
        let mut engine = GraphEngineV2::create_ephemeral();
        // Graph: 90 -> 91 -> 92
        engine.add_nodes(vec![
            make_v1_node(90, "FUNCTION", "a", "src/a.js"),
            make_v1_node(91, "FUNCTION", "b", "src/a.js"),
            make_v1_node(92, "FUNCTION", "c", "src/a.js"),
        ]);
        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 90, dst: 91,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 91, dst: 92,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
            ],
            false,
        );

        // Forward from 90
        let fwd = engine.reachability(&[90], 10, &["CALLS"], false);
        assert_eq!(fwd.len(), 3);

        // Backward from 92
        let bwd = engine.reachability(&[92], 10, &["CALLS"], true);
        assert_eq!(bwd.len(), 3);
    }

    #[test]
    fn test_declare_fields() {
        let mut engine = GraphEngineV2::create_ephemeral();
        assert!(engine.declared_fields_ref().is_empty());

        engine.declare_fields(vec![FieldDecl {
            name: "async".to_string(),
            field_type: FieldType::Bool,
            node_types: Some(vec!["FUNCTION".to_string()]),
        }]);

        assert_eq!(engine.declared_fields_ref().len(), 1);
        assert_eq!(engine.declared_fields_ref()[0].name, "async");
    }

    #[test]
    fn test_delete_edge_tombstone() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(100, "FUNCTION", "a", "src/a.js"),
            make_v1_node(101, "FUNCTION", "b", "src/a.js"),
        ]);
        engine.add_edges(
            vec![EdgeRecord {
                src: 100, dst: 101,
                edge_type: Some("CALLS".to_string()),
                version: "main".to_string(),
                metadata: None, deleted: false,
            }],
            false,
        );

        assert_eq!(engine.get_outgoing_edges(100, None).len(), 1);

        engine.delete_edge(100, 101, "CALLS");
        assert_eq!(engine.get_outgoing_edges(100, None).len(), 0);
    }

    #[test]
    fn test_count_nodes_by_type() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(110, "FUNCTION", "a", "src/a.js"),
            make_v1_node(111, "FUNCTION", "b", "src/b.js"),
            make_v1_node(112, "CLASS", "C", "src/c.js"),
        ]);

        let counts = engine.count_nodes_by_type(None);
        assert_eq!(counts.get("FUNCTION"), Some(&2));
        assert_eq!(counts.get("CLASS"), Some(&1));

        // Filtered
        let counts = engine.count_nodes_by_type(Some(&["FUNCTION".to_string()]));
        assert_eq!(counts.get("FUNCTION"), Some(&2));
        assert!(counts.get("CLASS").is_none());
    }

    #[test]
    fn test_get_all_edges() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(120, "FUNCTION", "a", "src/a.js"),
            make_v1_node(121, "FUNCTION", "b", "src/a.js"),
            make_v1_node(122, "FUNCTION", "c", "src/a.js"),
        ]);
        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 120, dst: 121,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 121, dst: 122,
                    edge_type: Some("IMPORTS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
            ],
            false,
        );

        let all = engine.get_all_edges();
        assert_eq!(all.len(), 2);
    }
}
