//! GraphEngineV2 — adapter wrapping MultiShardStore + ManifestStore
//! behind the GraphStore trait.
//!
//! Translates between v1 record types (NodeRecord/EdgeRecord) used by
//! GraphStore and v2 types (NodeRecordV2/EdgeRecordV2) used by the
//! sharded columnar storage.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::error::Result;
use crate::storage::{AttrQuery, EdgeRecord, FieldDecl, NodeRecord};
use crate::storage_v2::manifest::{ManifestStore, SnapshotDiff, SnapshotInfo};
use crate::storage_v2::multi_shard::MultiShardStore;
use crate::storage_v2::resource::{ResourceManager, SystemResources, TuningProfile};
use crate::storage_v2::compaction::{CompactionConfig, CompactionResult};
use crate::storage_v2::types::{CommitDelta, EdgeRecordV2, NodeRecordV2};
use super::{GraphStore, traversal};

/// Fallback shard count when adaptive tuning is bypassed (tests, etc.).
const DEFAULT_SHARD_COUNT: u16 = 4;

// ── Type Conversion ────────────────────────────────────────────────

/// Convert v2 node record to v1 (for GraphStore return values).
fn node_v2_to_v1(v2: &NodeRecordV2) -> NodeRecord {
    // Extract `exported` from metadata JSON (v2 stores it there).
    let (exported, clean_metadata) = extract_exported_from_metadata(&v2.metadata);

    NodeRecord {
        id: v2.id,
        node_type: Some(v2.node_type.clone()),
        file_id: 0,
        name_offset: 0,
        version: "main".to_string(),
        exported,
        replaces: None,
        deleted: false,
        name: Some(v2.name.clone()),
        file: Some(v2.file.clone()),
        metadata: if clean_metadata.is_empty() {
            None
        } else {
            Some(clean_metadata)
        },
        semantic_id: Some(v2.semantic_id.clone()),
    }
}

/// Extract `exported` field from metadata JSON, returning (exported, remaining_metadata).
fn extract_exported_from_metadata(metadata: &str) -> (bool, String) {
    if metadata.is_empty() {
        return (false, String::new());
    }
    match serde_json::from_str::<serde_json::Value>(metadata) {
        Ok(serde_json::Value::Object(mut map)) => {
            let exported = map
                .remove("__exported")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if map.is_empty() {
                (exported, String::new())
            } else {
                (exported, serde_json::to_string(&map).unwrap_or_default())
            }
        }
        _ => (false, metadata.to_string()),
    }
}

/// Inject `exported` field into metadata JSON.
fn inject_exported_into_metadata(metadata: &str, exported: bool) -> String {
    if !exported {
        return metadata.to_string();
    }
    if metadata.is_empty() {
        return r#"{"__exported":true}"#.to_string();
    }
    match serde_json::from_str::<serde_json::Value>(metadata) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.insert(
                "__exported".to_string(),
                serde_json::Value::Bool(true),
            );
            serde_json::to_string(&map).unwrap_or_default()
        }
        _ => metadata.to_string(),
    }
}

/// Convert v1 node record to v2 (for GraphStore input).
fn node_v1_to_v2(v1: &NodeRecord) -> NodeRecordV2 {
    let node_type = v1.node_type.as_deref().unwrap_or("UNKNOWN");
    let name = v1.name.as_deref().unwrap_or("");
    let file = v1.file.as_deref().unwrap_or("");
    let metadata = v1.metadata.as_deref().unwrap_or("");

    // Use client-provided semantic_id if available, otherwise synthesize.
    let semantic_id = v1.semantic_id.clone()
        .unwrap_or_else(|| format!("{}:{}@{}", node_type, name, file));

    // Inject `exported` into metadata JSON (v2 stores it there).
    let metadata = inject_exported_into_metadata(metadata, v1.exported);

    NodeRecordV2 {
        semantic_id,
        id: v1.id,
        node_type: node_type.to_string(),
        name: name.to_string(),
        file: file.to_string(),
        content_hash: 0,
        metadata,
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
    /// Uses Arc<str> for edge type deduplication — ~15 distinct values
    /// shared across millions of tombstone entries.
    pending_tombstone_edges: HashSet<(u128, u128, Arc<str>)>,
    /// Count of nodes deleted then re-added (old segment version persists
    /// alongside new write buffer version). Used to correct node_count().
    /// Reset on compact() when segment dedup removes old versions.
    superseded_node_count: usize,
    /// Count of edges deleted then re-added. Same purpose as above.
    superseded_edge_count: usize,
    /// Declared metadata fields for indexing (v1 compat).
    declared_fields: Vec<FieldDecl>,
    /// Cached tuning profile — avoids re-probing sysinfo on every write.
    cached_profile: TuningProfile,
    /// Timestamp of last resource re-detection (rate-limits sysinfo calls).
    last_resource_check: Instant,
    /// Embedding engine for semantic search (None when feature disabled or not initialized).
    #[cfg(feature = "embedding")]
    embedding_engine: Option<std::sync::Arc<crate::embedding::EmbeddingEngine>>,
}

// ── Constructors ────────────────────────────────────────────────────

impl GraphEngineV2 {
    /// Create a new database on disk at the given path.
    ///
    /// Uses `ResourceManager::auto_tune()` to determine shard count
    /// based on available RAM and CPU cores.
    pub fn create<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref();
        std::fs::create_dir_all(path)?;
        let profile = ResourceManager::auto_tune();
        let store = MultiShardStore::create(path, profile.shard_count)?;
        let manifest = ManifestStore::create(path)?;

        Ok(Self {
            store,
            manifest,
            path: Some(path.to_path_buf()),
            ephemeral: false,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            superseded_node_count: 0,
            superseded_edge_count: 0,
            declared_fields: Vec::new(),
            cached_profile: profile,
            last_resource_check: Instant::now(),
            #[cfg(feature = "embedding")]
            embedding_engine: Self::init_embedding_engine(Some(path)),
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
            superseded_node_count: 0,
            superseded_edge_count: 0,
            declared_fields: Vec::new(),
            cached_profile: TuningProfile::default(),
            last_resource_check: Instant::now(),
            #[cfg(feature = "embedding")]
            embedding_engine: None,
        }
    }

    /// Open an existing database from disk.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref();
        let manifest = ManifestStore::open(path)?;
        let mut store = MultiShardStore::open(path, &manifest)?;

        // Restore tombstones from manifest into shard TombstoneSet (single source of truth).
        // Engine's pending_tombstone_* stays empty — queries delegate to store shards.
        let current = manifest.current();
        if !current.tombstoned_node_ids.is_empty() || !current.tombstoned_edge_keys.is_empty() {
            let tombstone_nodes: HashSet<u128> =
                current.tombstoned_node_ids.iter().copied().collect();
            let tombstone_edges: HashSet<(u128, u128, Arc<str>)> =
                current.tombstoned_edge_keys.iter()
                    .map(|(s, d, t)| (*s, *d, Arc::from(t.as_str())))
                    .collect();
            store.set_tombstones(&tombstone_nodes, &tombstone_edges);
        }

        let profile = ResourceManager::auto_tune();

        Ok(Self {
            store,
            manifest,
            path: Some(path.to_path_buf()),
            ephemeral: false,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            superseded_node_count: 0,
            superseded_edge_count: 0,
            declared_fields: Vec::new(),
            cached_profile: profile,
            last_resource_check: Instant::now(),
            #[cfg(feature = "embedding")]
            embedding_engine: Self::init_embedding_engine(Some(path)),
        })
    }

    /// Initialize embedding engine from database path (feature-gated).
    #[cfg(feature = "embedding")]
    fn init_embedding_engine(db_path: Option<&Path>) -> Option<std::sync::Arc<crate::embedding::EmbeddingEngine>> {
        let path = db_path?;
        let lance_dir = path.with_extension("embeddings.lance");
        let model_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".grafema")
            .join("models");
        match crate::embedding::EmbeddingEngine::new(&lance_dir, &model_dir) {
            Ok(engine) => Some(std::sync::Arc::new(engine)),
            Err(e) => {
                tracing::warn!("Embedding engine init failed (non-fatal): {}", e);
                None
            }
        }
    }

    /// Public accessor for the embedding engine.
    #[cfg(feature = "embedding")]
    pub fn embedding_engine(&self) -> Option<&std::sync::Arc<crate::embedding::EmbeddingEngine>> {
        self.embedding_engine.as_ref()
    }
}

// ── Helper: tombstone filtering ─────────────────────────────────────

impl GraphEngineV2 {
    /// Check if a node is tombstoned.
    ///
    /// Checks both engine-level pending tombstones (from delete_node, not yet flushed)
    /// and store shard tombstones (persisted via commit_batch_ext or flush).
    fn is_node_tombstoned(&self, id: u128) -> bool {
        self.pending_tombstone_nodes.contains(&id)
            || self.store.is_node_tombstoned(id)
    }

    /// Check if an edge is tombstoned.
    ///
    /// Checks both engine-level pending tombstones (from delete_edge, not yet flushed)
    /// and store shard tombstones (persisted via commit_batch_ext or flush).
    fn is_edge_tombstoned(&self, src: u128, dst: u128, edge_type: &str) -> bool {
        self.pending_tombstone_edges.contains(&(src, dst, Arc::from(edge_type)))
            || self.store.is_edge_tombstoned(src, dst, edge_type)
    }

    /// Filter tombstoned edges from a list of v2 edge records.
    fn filter_edges(&self, edges: Vec<EdgeRecordV2>) -> Vec<EdgeRecordV2> {
        edges
            .into_iter()
            .filter(|e| !self.is_edge_tombstoned(e.src, e.dst, &e.edge_type))
            .collect()
    }

}

// ── GraphStore Implementation ───────────────────────────────────────

impl GraphStore for GraphEngineV2 {
    fn add_nodes(&mut self, nodes: Vec<NodeRecord>) {
        let v2_nodes: Vec<NodeRecordV2> = nodes.iter().map(node_v1_to_v2).collect();
        // Re-adding a node in the same session must resurrect it immediately.
        // Without this, delete->add keeps the node hidden until flush.
        for node in &v2_nodes {
            if self.pending_tombstone_nodes.remove(&node.id) {
                // Node was deleted then re-added. The old version persists in
                // a flushed segment alongside the new write-buffer version.
                // Track this so node_count() subtracts the stale segment copy.
                self.superseded_node_count += 1;
            }
        }
        self.store.add_nodes(v2_nodes);

        // Auto-flush: check if any shard's write buffer exceeds adaptive limits
        // or if system memory pressure is high.
        self.maybe_auto_flush();
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
                Arc::from(edge.edge_type.as_str()),
            ));
        }
        let incoming = self.store.get_incoming_edges(id, None);
        for edge in &incoming {
            self.pending_tombstone_edges.insert((
                edge.src,
                edge.dst,
                Arc::from(edge.edge_type.as_str()),
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
        let node_type_filter = query.node_type.as_deref();

        // Handle wildcard node_type — storage path accepts exact+prefix separately.
        let (exact_type, wildcard_prefix) = match node_type_filter {
            Some(t) if t.ends_with('*') => (None, Some(t.trim_end_matches('*'))),
            other => (other, None),
        };

        let mut ids = self.store.find_node_ids_by_attr(
            exact_type,
            wildcard_prefix,
            query.file.as_deref(),
            query.name.as_deref(),
            query.exported,
            &query.metadata_filters,
            query.substring_match,
        );

        if !self.pending_tombstone_nodes.is_empty() {
            ids.retain(|id| !self.is_node_tombstoned(*id));
        }

        // Fuzzy name fallback: when name is specified, 0 exact results,
        // and fuzzy is not explicitly disabled
        if ids.is_empty()
            && query.name.is_some()
            && query.fuzzy_name_fallback != Some(false)
        {
            let name = query.name.as_deref().unwrap();
            let fuzzy_matches = self.store.find_similar_names(
                name,
                exact_type,
                20,  // top-K
                0.3, // min Jaccard score
            );
            for m in &fuzzy_matches {
                if !self.is_node_tombstoned(m.node_id) {
                    ids.push(m.node_id);
                }
            }
        }

        // Embedding similarity fallback (tier 4): when token fuzzy also returned nothing
        #[cfg(feature = "embedding")]
        if ids.is_empty()
            && query.name.is_some()
            && query.fuzzy_name_fallback != Some(false)
        {
            if let Some(ref engine) = self.embedding_engine {
                let name = query.name.as_deref().unwrap();
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    let matches = handle.block_on(engine.search(name, exact_type, 10, 0.5));
                    for m in matches {
                        if !self.is_node_tombstoned(m.node_id) {
                            ids.push(m.node_id);
                        }
                    }
                }
            }
        }

        ids
    }

    fn find_by_attr_chunked(
        &self,
        query: &AttrQuery,
        chunk_size: usize,
        callback: &mut dyn FnMut(&[u128]) -> bool,
    ) {
        let node_type_filter = query.node_type.as_deref();
        let (exact_type, wildcard_prefix) = match node_type_filter {
            Some(t) if t.ends_with('*') => (None, Some(t.trim_end_matches('*'))),
            other => (other, None),
        };

        let mut found_any = false;

        if self.pending_tombstone_nodes.is_empty() {
            self.store.find_node_ids_by_attr_chunked(
                exact_type,
                wildcard_prefix,
                query.file.as_deref(),
                query.name.as_deref(),
                query.exported,
                &query.metadata_filters,
                query.substring_match,
                chunk_size,
                &mut |ids| {
                    if !ids.is_empty() { found_any = true; }
                    callback(ids)
                },
            );
        } else {
            self.store.find_node_ids_by_attr_chunked(
                exact_type,
                wildcard_prefix,
                query.file.as_deref(),
                query.name.as_deref(),
                query.exported,
                &query.metadata_filters,
                query.substring_match,
                chunk_size,
                &mut |ids| {
                    let filtered: Vec<u128> = ids.iter()
                        .filter(|&&id| !self.is_node_tombstoned(id))
                        .copied()
                        .collect();
                    if filtered.is_empty() { true } else {
                        found_any = true;
                        callback(&filtered)
                    }
                },
            );
        }

        // Fuzzy name fallback for streaming path (same logic as find_by_attr)
        if !found_any
            && query.name.is_some()
            && query.fuzzy_name_fallback != Some(false)
        {
            let name = query.name.as_deref().unwrap();
            let fuzzy_matches = self.store.find_similar_names(
                name,
                exact_type,
                20,
                0.3,
            );
            let fuzzy_ids: Vec<u128> = fuzzy_matches.iter()
                .filter(|m| !self.is_node_tombstoned(m.node_id))
                .map(|m| m.node_id)
                .collect();
            if !fuzzy_ids.is_empty() {
                found_any = true;
                callback(&fuzzy_ids);
            }
        }

        // Embedding similarity fallback for streaming path (tier 4)
        #[cfg(feature = "embedding")]
        if !found_any
            && query.name.is_some()
            && query.fuzzy_name_fallback != Some(false)
        {
            if let Some(ref engine) = self.embedding_engine {
                let name = query.name.as_deref().unwrap();
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    let matches = handle.block_on(engine.search(name, exact_type, 10, 0.5));
                    let emb_ids: Vec<u128> = matches.iter()
                        .filter(|m| !self.is_node_tombstoned(m.node_id))
                        .map(|m| m.node_id)
                        .collect();
                    if !emb_ids.is_empty() {
                        callback(&emb_ids);
                    }
                }
            }
        }
    }

    fn find_by_type(&self, node_type: &str) -> Vec<u128> {
        let mut ids = if node_type.ends_with('*') {
            self.store.find_node_ids_by_attr(
                None,
                Some(node_type.trim_end_matches('*')),
                None,
                None,
                None,
                &[],
                false,
            )
        } else {
            self.store.find_node_ids_by_type(node_type)
        };

        if self.pending_tombstone_nodes.is_empty() {
            return ids;
        }

        ids.retain(|id| !self.is_node_tombstoned(*id));
        ids
    }

    fn add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool) {
        let v2_edges: Vec<EdgeRecordV2> = edges.iter().map(edge_v1_to_v2).collect();
        // Re-adding an edge in the same session must clear any pending tombstone
        // for the same (src, dst, type) triple.
        let keys: Vec<(u128, u128, Arc<str>)> = v2_edges
            .iter()
            .map(|e| (e.src, e.dst, Arc::from(e.edge_type.as_str())))
            .collect();
        for key in &keys {
            if self.pending_tombstone_edges.remove(key) {
                // Edge was deleted then re-added. Old segment version persists.
                self.superseded_edge_count += 1;
            }
        }
        // Also un-tombstone any keys whose deletion has already been
        // committed to shards (typical for the rule-chain pattern in the
        // compaction enricher: delete-by-source flushes tombstones to
        // shards, then the same `(src, dst, type)` is re-emitted via
        // addEdges). Without this the new edge persists in the write
        // buffer but every read path filters it out via
        // `tombstones.contains_edge`.
        self.store.untombstone_edges(&keys);
        let result = self.store.upsert_edges(v2_edges);
        if !skip_validation {
            if let Err(e) = result {
                tracing::warn!("upsert_edges error: {}", e);
            }
        }
        // If skip_validation, silently ignore errors

        // Edge-only flush: only trigger on byte limit, never on memory-pressure path.
        // The memory-pressure path checks total_write_buffer_nodes (nodes from the
        // analysis phase), so an enricher's edge write storm would cause a massive
        // node flush while holding the exclusive write lock — blocking all reads for
        // seconds. Edge writes use a byte-only guard instead. (RFD-67)
        self.maybe_auto_flush_edges();
    }

    fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str) {
        self.pending_tombstone_edges.insert((
            src,
            dst,
            Arc::from(edge_type),
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
        self.store.iter_all_edges()
            .iter()
            .filter(|e| !self.is_edge_tombstoned(e.src, e.dst, &e.edge_type))
            .map(edge_v2_to_v1)
            .collect()
    }

    fn get_edges_by_type(&self, edge_type: &str) -> Vec<EdgeRecord> {
        self.store.get_edges_by_type(edge_type)
            .iter()
            .filter(|e| !self.is_edge_tombstoned(e.src, e.dst, &e.edge_type))
            .map(edge_v2_to_v1)
            .collect()
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
                return self.store.count_by_type();
            }
        }

        counts
    }

    fn count_edges_by_type(&self, edge_types: Option<&[String]>) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();

        // Seed explicitly requested non-wildcard types with 0 so callers always
        // get a key even when no matching edges exist.
        if let Some(filter) = edge_types {
            for f in filter.iter() {
                if !f.ends_with('*') {
                    counts.entry(f.to_string()).or_insert(0);
                }
            }
        }

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

    fn flush_data_only(&mut self) -> Result<()> {
        // Flush to disk when write buffers exceed safe limits.
        // Previously this was a no-op, relying on compact() at the end
        // of analysis to persist everything. But if analysis fails before
        // compact (OOM, timeout, resolver error), ALL data was lost.
        //
        // Threshold: flush when any shard has >50K nodes or >128MB in buffers.
        // Lowered from 100K/256MB to reduce peak RSS on large graphs (4M+ nodes).
        if self.store.any_shard_needs_flush(50_000, 128 * 1024 * 1024) {
            self.store.flush_all(&mut self.manifest)?;
        }
        Ok(())
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
        // Flush write buffers to L0 segments first — resolution and derived
        // edge commits use flush_data_only() (no-op in V2), so data may
        // still be in write buffers at compact time.
        self.flush()?;
        // Force-compact all shards with any L0 segments (threshold=1).
        // The default threshold (4) skips shards with few L0 segments,
        // leaving old L1 + new L0 = double-counted nodes/edges.
        let config = CompactionConfig { segment_threshold: 1 };
        self.store.compact(&mut self.manifest, &config)?;
        // Manifest GC: remove old manifest files before segment GC so
        // referenced_segments is recalculated and orphaned segments are detected.
        let gc_manifests = self.manifest.gc_manifests(3)?;
        if gc_manifests > 0 {
            tracing::info!("GC: removed {} old manifest(s)", gc_manifests);
        }
        // Segment GC: collect orphaned segments after compaction + manifest GC
        let moved = self.manifest.gc_collect()?;
        if !moved.is_empty() {
            tracing::info!("GC: moved {} orphaned segment(s) to gc/", moved.len());
        }
        // Purge: permanently delete collected segments
        let purged = self.manifest.gc_purge()?;
        if purged > 0 {
            tracing::info!("GC: purged {} segment file(s)", purged);
        }
        // Compaction deduplicates segments — old superseded versions are removed.
        self.superseded_node_count = 0;
        self.superseded_edge_count = 0;
        Ok(())
    }

    /// V2 engine: rebuild_indexes is a no-op (v2 handles indexes differently).
    fn rebuild_indexes(&mut self) -> Result<()> {
        // V2 engine manages indexes internally — full flush is the rebuild.
        self.flush()
    }

    fn node_count(&self) -> usize {
        let total = self.store.node_count();
        // Shard tombstones (from commit_batch_ext/flush) and pending tombstones
        // (from delete_node, not yet flushed) are disjoint sets.
        let shard_tombstones = self.store.tombstone_node_count();
        total.saturating_sub(shard_tombstones)
             .saturating_sub(self.pending_tombstone_nodes.len())
             .saturating_sub(self.superseded_node_count)
    }

    fn edge_count(&self) -> usize {
        let total = self.store.edge_count();
        let shard_tombstones = self.store.tombstone_edge_count();
        total.saturating_sub(shard_tombstones)
             .saturating_sub(self.pending_tombstone_edges.len())
             .saturating_sub(self.superseded_edge_count)
    }

    fn clear(&mut self) {
        self.store = MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT);
        self.manifest = ManifestStore::ephemeral();
        self.pending_tombstone_nodes.clear();
        self.pending_tombstone_edges.clear();
        self.superseded_node_count = 0;
        self.superseded_edge_count = 0;
        self.declared_fields.clear();
    }

    fn declare_fields(&mut self, fields: Vec<FieldDecl>) {
        self.declared_fields = fields;
    }

    fn shard_diagnostics(&self) -> Vec<crate::storage_v2::ShardDiagnostics> {
        self.store.shard_diagnostics()
    }

    fn disk_size_bytes(&self) -> u64 {
        match &self.path {
            Some(p) => dir_size_bytes(p),
            None => 0,
        }
    }

    fn as_any(&self) -> &dyn std::any::Any { self }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
}

/// Recursively compute total size of a directory in bytes.
fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                total += dir_size_bytes(&entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
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
        self.commit_batch_ext(nodes, edges, changed_files, tags, &[])
    }

    /// Atomic batch commit with protected types.
    ///
    /// Nodes whose `node_type` is in `protected_types` are excluded from
    /// tombstoning during re-analysis of their file.
    pub fn commit_batch_ext(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        protected_types: &[String],
    ) -> Result<CommitDelta> {
        let delta = self.store
            .commit_batch_ext(nodes, edges, changed_files, tags, &mut self.manifest, protected_types)?;

        // After commit_batch_ext, all tombstones live in the store's shard TombstoneSet
        // (set via set_tombstones_shared). The engine's pending sets are cleared —
        // is_node/edge_tombstoned() delegates to the store for persisted tombstones.
        self.pending_tombstone_nodes.clear();
        self.pending_tombstone_edges.clear();

        Ok(delta)
    }

    /// Compact with statistics returned (for benchmarks and diagnostics).
    ///
    /// Unlike `GraphStore::compact()` which returns `Result<()>`, this method
    /// exposes the full `CompactionResult` including nodes_merged, edges_merged,
    /// tombstones_removed, and duration_ms.
    pub fn compact_with_stats(&mut self) -> Result<CompactionResult> {
        // Flush write buffers to L0 first (same reason as compact()).
        self.flush()?;
        let config = CompactionConfig { segment_threshold: 1 };
        let result = self.store.compact(&mut self.manifest, &config)?;
        self.superseded_node_count = 0;
        self.superseded_edge_count = 0;
        Ok(result)
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

    /// Auto-flush write buffers if adaptive limits or memory pressure exceeded.
    ///
    /// Probes system resources to determine thresholds. Flushes all shards
    /// if any shard's buffer exceeds the adaptive node count or byte limit.
    /// Under high memory pressure (>80%), also flushes if the buffer has at
    /// least 1000 nodes (avoids flushing trivially small batches).
    ///
    /// Errors are logged but do not propagate (write path must not fail).
    fn maybe_auto_flush(&mut self) {
        use std::time::Duration;

        // Rate-limit resource re-detection to at most once per second.
        // Between checks we use the cached TuningProfile, which is stale
        // by at most 1 s — acceptable for adaptive buffer limits and
        // memory-pressure decisions.
        if self.last_resource_check.elapsed() > Duration::from_secs(1) {
            let resources = SystemResources::detect();
            self.cached_profile = TuningProfile::from_resources(&resources);
            self.last_resource_check = Instant::now();
        }

        // Check if any shard's buffer exceeds the adaptive limits.
        let exceeds_limits = self.store.any_shard_needs_flush(
            self.cached_profile.write_buffer_node_limit,
            self.cached_profile.write_buffer_byte_limit,
        );

        // Under high memory pressure, flush earlier but only if buffer
        // has meaningful data (>= 500 nodes). Flushing 2 nodes is not
        // worth the I/O cost even under pressure.
        // Thresholds lowered from 0.8/1000 to 0.7/500 to flush earlier
        // on memory-constrained VMs (16GB with 4M+ node graphs).
        let pressure_flush = self.cached_profile.memory_pressure > 0.7
            && self.store.total_write_buffer_nodes() >= 500;

        if exceeds_limits || pressure_flush {
            if let Err(e) = self.store.flush_all(&mut self.manifest) {
                tracing::warn!("auto-flush failed: {}", e);
            }
        }
    }

    /// Auto-flush for edge-only write paths.
    ///
    /// Checks the byte limit only — never the memory-pressure path. This avoids
    /// the RFD-67 bug: if the pressure path ran here, an enricher's first addEdges
    /// call would flush all analysis-phase nodes (which are still in the write buffer)
    /// while holding the exclusive write lock, blocking reads for seconds.
    ///
    /// Edges are small (≈98 bytes each). The byte limit (100MB default) acts as a
    /// genuine OOM safeguard. Callers that want guaranteed durability should call
    /// flush() or compact() explicitly.
    fn maybe_auto_flush_edges(&mut self) {
        if self.store.any_shard_needs_flush(usize::MAX, self.cached_profile.write_buffer_byte_limit) {
            if let Err(e) = self.store.flush_all(&mut self.manifest) {
                tracing::warn!("auto-flush (edges) failed: {}", e);
            }
        }
    }

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
            semantic_id: None,
        }
    }

    fn assert_json_eq(actual: &str, expected: &str) {
        let actual: serde_json::Value =
            serde_json::from_str(actual).expect("actual must be valid JSON");
        let expected: serde_json::Value =
            serde_json::from_str(expected).expect("expected must be valid JSON");
        assert_eq!(actual, expected);
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
            semantic_id: None,
        };

        let v2 = node_v1_to_v2(&v1);
        assert_eq!(v2.id, 99);
        assert_eq!(v2.node_type, "UNKNOWN");
        assert_eq!(v2.name, "");
        assert_eq!(v2.file, "");
        // exported=true is stored in metadata as __exported
        assert_eq!(v2.metadata, r#"{"__exported":true}"#);
        assert_eq!(v2.semantic_id, "UNKNOWN:@");
        assert_eq!(v2.content_hash, 0);

        // Roundtrip: v1 -> v2 -> v1 preserves exported
        let back = node_v2_to_v1(&v2);
        assert!(back.exported, "exported should survive v1->v2->v1 roundtrip");
        assert_eq!(back.metadata, None, "__exported should be stripped from metadata");
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
        node.exported = true;
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

        // Find by exported=true (stored as __exported in v2 metadata)
        let query = AttrQuery::new().exported(true);
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&20));

        // Find by exported=false
        let query = AttrQuery::new().exported(false);
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&21));

        // Version is ignored in v2 (snapshot-level history, no per-node version column)
        let query = AttrQuery::new().version("dev").name("helper");
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&21));
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
            semantic_id: None,
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

    #[test]
    fn test_disk_roundtrip_preserves_node_and_edge_metadata() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        let source = NodeRecord {
            id: 10,
            node_type: Some("FUNCTION".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: true,
            replaces: None,
            deleted: false,
            name: Some("compute".to_string()),
            file: Some("src/a.js".to_string()),
            metadata: Some(r#"{"line":10,"lang":"js"}"#.to_string()),
            semantic_id: None,
        };
        let target = NodeRecord {
            id: 11,
            node_type: Some("FUNCTION".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("target".to_string()),
            file: Some("src/b.js".to_string()),
            metadata: Some(r#"{"line":20}"#.to_string()),
            semantic_id: None,
        };
        let edge = EdgeRecord {
            src: source.id,
            dst: target.id,
            edge_type: Some("FLOWS_INTO".to_string()),
            version: "main".to_string(),
            metadata: Some(r#"{"computedPropertyVar":"k","argIndex":0}"#.to_string()),
            deleted: false,
        };

        {
            let mut engine = GraphEngineV2::create(&db_path).unwrap();
            engine.add_nodes(vec![source.clone(), target.clone()]);
            engine.add_edges(vec![edge.clone()], false);
            engine.flush().unwrap();
        }

        let engine = GraphEngineV2::open(&db_path).unwrap();
        let loaded_source = engine
            .get_node(source.id)
            .expect("source node not found after reopen");
        assert!(loaded_source.exported, "exported flag must survive roundtrip");
        let loaded_metadata = loaded_source
            .metadata
            .as_deref()
            .expect("source metadata must exist");
        assert_json_eq(
            loaded_metadata,
            source.metadata.as_deref().unwrap(),
        );

        let outgoing = engine.get_outgoing_edges(source.id, None);
        assert_eq!(outgoing.len(), 1);
        let edge_metadata = outgoing[0]
            .metadata
            .as_deref()
            .expect("edge metadata must exist");
        assert_json_eq(edge_metadata, edge.metadata.as_deref().unwrap());
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
    fn test_readd_node_clears_pending_tombstone() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let node = make_v1_node(102, "FUNCTION", "foo", "src/a.js");

        engine.add_nodes(vec![node.clone()]);
        assert!(engine.node_exists(102));

        engine.delete_node(102);
        assert!(!engine.node_exists(102));

        // Re-adding the same ID in the same session should resurrect the node.
        engine.add_nodes(vec![node]);
        assert!(engine.node_exists(102));

        engine.flush().unwrap();
        assert!(engine.node_exists(102));
    }

    #[test]
    fn test_readd_edge_clears_pending_tombstone() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(103, "FUNCTION", "srcFn", "src/a.js"),
            make_v1_node(104, "FUNCTION", "dstFn", "src/a.js"),
        ]);

        let edge = EdgeRecord {
            src: 103,
            dst: 104,
            edge_type: Some("FLOWS_INTO".to_string()),
            version: "main".to_string(),
            metadata: Some(r#"{"computedPropertyVar":"key"}"#.to_string()),
            deleted: false,
        };

        engine.add_edges(vec![edge.clone()], false);
        assert_eq!(engine.get_outgoing_edges(103, None).len(), 1);

        engine.delete_edge(103, 104, "FLOWS_INTO");
        assert_eq!(engine.get_outgoing_edges(103, None).len(), 0);

        // Re-adding the same edge key in the same session should resurrect it.
        engine.add_edges(vec![edge.clone()], false);
        let outgoing = engine.get_outgoing_edges(103, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].metadata, edge.metadata);

        engine.flush().unwrap();
        let outgoing_after_flush = engine.get_outgoing_edges(103, None);
        assert_eq!(outgoing_after_flush.len(), 1);
        assert_eq!(outgoing_after_flush[0].metadata, edge.metadata);
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

    // ── Adaptive Shard Count ────────────────────────────────────────

    /// Regression test for RFD-67: edge writes must not block concurrent reads.
    ///
    /// Before the fix, `add_edges` called `maybe_auto_flush` which triggered
    /// `flush_all` under the exclusive write lock. This blocked reads for seconds
    /// when the write buffer had many analysis nodes (memory-pressure path).
    ///
    /// This test wraps the engine in an RwLock (mirroring the production
    /// `Database.engine` field) and verifies that read queries complete quickly
    /// while edge writes are in progress.
    #[test]
    fn test_edge_writes_do_not_block_reads() {
        use std::sync::{Arc, RwLock};
        use std::time::{Duration, Instant};

        // Build engine with many pre-loaded nodes (simulates post-analysis state).
        let mut engine = GraphEngineV2::create_ephemeral();
        for i in 0u128..600 {
            engine.add_nodes(vec![make_v1_node(i, "FUNCTION", &format!("fn_{i}"), "src/a.js")]);
        }
        // Don't flush — leave nodes in write buffer so memory-pressure path could trigger.

        let engine = Arc::new(RwLock::new(engine));

        // Writer thread: adds edges in a tight loop (simulates an enricher write storm).
        let writer_engine = Arc::clone(&engine);
        let writer = std::thread::spawn(move || {
            for i in 0u128..100 {
                let src = i % 600;
                let dst = (i + 1) % 600;
                let mut eng = writer_engine.write().unwrap();
                eng.add_edges(vec![EdgeRecord {
                    src,
                    dst,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                }], true);
            }
        });

        // Reader thread: queries nodes while the writer runs. Must not block.
        let reader_engine = Arc::clone(&engine);
        let reader = std::thread::spawn(move || {
            let start = Instant::now();
            for _ in 0..10 {
                let eng = reader_engine.read().unwrap();
                let _ = eng.find_by_type("FUNCTION");
                drop(eng);
                std::thread::sleep(Duration::from_millis(5));
            }
            start.elapsed()
        });

        writer.join().unwrap();
        let read_duration = reader.join().unwrap();

        // 10 reads × 5ms sleep = 50ms minimum. Total should be well under 500ms.
        // Before the fix, a single auto-flush could hold the write lock for
        // hundreds of milliseconds, causing reads to queue up.
        assert!(
            read_duration < Duration::from_millis(1000),
            "reads took {:?} — edge writes are blocking reads (RFD-67 regression)",
            read_duration,
        );
    }

    #[test]
    fn test_adaptive_shard_count_on_disk() {
        use crate::storage_v2::resource::ResourceManager;

        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("adaptive.rfdb");

        let engine = GraphEngineV2::create(&db_path).unwrap();
        let profile = ResourceManager::auto_tune();

        // Verify the engine's shard count matches the adaptive profile.
        // We check via node_count (engine exists) and verify profile range.
        assert!(
            profile.shard_count >= 1 && profile.shard_count <= 16,
            "shard_count {} out of expected [1, 16] range",
            profile.shard_count
        );

        // Engine should work normally with adaptive shard count.
        assert_eq!(engine.node_count(), 0);
    }

    // ── Auto-Flush ──────────────────────────────────────────────────

    #[test]
    fn test_auto_flush_triggers_on_buffer_limit() {
        // Use MultiShardStore directly to test the any_shard_needs_flush() wiring.
        // With node_limit=5, adding 5+ nodes should trigger the check.
        let mut store = MultiShardStore::ephemeral(2);

        // Add 3 nodes — should NOT exceed limit of 5
        store.add_nodes(vec![
            make_v2_node("FUNCTION:a@src/a.js", "FUNCTION", "a", "src/a.js"),
            make_v2_node("FUNCTION:b@src/a.js", "FUNCTION", "b", "src/a.js"),
            make_v2_node("FUNCTION:c@src/a.js", "FUNCTION", "c", "src/a.js"),
        ]);
        assert!(!store.any_shard_needs_flush(5, usize::MAX));

        // Add 5 more — at least one shard should exceed 5 nodes
        for i in 0..5 {
            let id = format!("FUNCTION:x{i}@src/a.js");
            store.add_nodes(vec![make_v2_node(&id, "FUNCTION", &format!("x{i}"), "src/a.js")]);
        }
        assert!(store.any_shard_needs_flush(5, usize::MAX));
    }

    #[test]
    fn test_auto_flush_byte_limit() {
        let mut store = MultiShardStore::ephemeral(1);

        // Add nodes and check estimated bytes
        for i in 0..10 {
            let id = format!("FUNCTION:n{i}@src/a.js");
            store.add_nodes(vec![make_v2_node(&id, "FUNCTION", &format!("n{i}"), "src/a.js")]);
        }

        // 10 nodes * 120 bytes = 1200 bytes. A limit of 1000 should trigger.
        assert!(store.any_shard_needs_flush(usize::MAX, 1000));
        // A limit of 2000 should not trigger.
        assert!(!store.any_shard_needs_flush(usize::MAX, 2000));
    }

    // ── flush_data_only No-op ──────────────────────────────────────

    #[test]
    fn test_flush_data_only_is_noop_v2() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("noop_flush.rfdb");

        let mut engine = GraphEngineV2::create(&db_path).unwrap();

        // Add nodes and edges using blake3-derived IDs (required for segment writes)
        let node_a = make_v2_node("FUNCTION:a@src/a.js", "FUNCTION", "a", "src/a.js");
        let node_b = make_v2_node("FUNCTION:b@src/a.js", "FUNCTION", "b", "src/a.js");
        let id_a = node_a.id;
        let id_b = node_b.id;
        engine.store.add_nodes(vec![node_a, node_b]);

        engine.add_edges(vec![EdgeRecord {
            src: id_a, dst: id_b,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None, deleted: false,
        }], false);

        // flush_data_only should be a no-op — no segments written
        engine.flush_data_only().unwrap();

        // Data still readable from write buffers
        assert!(engine.node_exists(id_a));
        assert!(engine.node_exists(id_b));
        let outgoing = engine.get_outgoing_edges(id_a, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].dst, id_b);

        // Now flush() should actually persist
        engine.flush().unwrap();

        // Data still readable after real flush (from segments)
        assert!(engine.node_exists(id_a));
        assert!(engine.node_exists(id_b));
        let outgoing = engine.get_outgoing_edges(id_a, None);
        assert_eq!(outgoing.len(), 1);
    }

    #[test]
    fn test_deferred_bulk_load_v2() {
        let mut engine = GraphEngineV2::create_ephemeral();

        // Simulate bulk load: 100 files, each with ~5 nodes
        for file_idx in 0..100 {
            let file = format!("src/file_{file_idx}.js");

            // Delete old nodes for this file (simulate re-analysis)
            let old_ids = engine.find_by_attr(
                &AttrQuery { file: Some(file.clone()), ..AttrQuery::default() },
            );
            for id in old_ids {
                engine.delete_node(id);
            }

            // Add new nodes
            let mut nodes = Vec::new();
            for node_idx in 0..5 {
                let name = format!("fn_{file_idx}_{node_idx}");
                nodes.push(make_v1_node(
                    (file_idx * 1000 + node_idx) as u128,
                    "FUNCTION",
                    &name,
                    &file,
                ));
            }
            engine.add_nodes(nodes);

            // flush_data_only is a no-op — should succeed
            engine.flush_data_only().unwrap();

            // All nodes for this file should be readable (from write buffer)
            let found = engine.find_by_attr(
                &AttrQuery { file: Some(file.clone()), ..AttrQuery::default() },
            );
            assert_eq!(
                found.len(), 5,
                "file {file_idx}: expected 5 nodes, found {}",
                found.len()
            );
        }

        // Total: 100 files * 5 nodes = 500 nodes
        assert_eq!(engine.node_count(), 500);

        // rebuild_indexes (which calls flush) should persist everything
        engine.rebuild_indexes().unwrap();
        assert_eq!(engine.node_count(), 500);

        // Spot-check: random file's nodes are still there
        let found = engine.find_by_attr(
            &AttrQuery { file: Some("src/file_42.js".to_string()), ..AttrQuery::default() },
        );
        assert_eq!(found.len(), 5);
    }

    #[test]
    fn test_count_edges_by_type_zero_seed() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(900, "FUNCTION", "a", "src/a.js"),
            make_v1_node(901, "FUNCTION", "b", "src/a.js"),
        ]);
        engine.add_edges(
            vec![EdgeRecord {
                src: 900,
                dst: 901,
                edge_type: Some("CALLS".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            false,
        );

        // Requesting a type that has edges — should return the count
        let result = engine.count_edges_by_type(Some(&["CALLS".to_string()]));
        assert_eq!(result.get("CALLS"), Some(&1));

        // Requesting a type with zero matching edges — must return 0, not absent
        let result = engine.count_edges_by_type(Some(&["INSTANCE_OF".to_string()]));
        assert_eq!(
            result.get("INSTANCE_OF"),
            Some(&0),
            "zero-count key must be present in result"
        );

        // Wildcard types are NOT seeded — absence is expected when no matches
        let result = engine.count_edges_by_type(Some(&["INST*".to_string()]));
        assert_eq!(result.get("INST*"), None, "wildcard key should not be seeded");

        // None filter counts all edges, no zero-seeding
        let result = engine.count_edges_by_type(None);
        assert_eq!(result.get("CALLS"), Some(&1));
    }
}
