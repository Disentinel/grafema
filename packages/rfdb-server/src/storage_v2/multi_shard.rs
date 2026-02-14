//! Multi-shard store for RFDB v2 storage.
//!
//! Wraps N independent `Shard` instances and provides the same query
//! interface as a single shard, with automatic routing:
//!
//! - **Nodes** are routed to shards by file directory hash
//!   (via `ShardPlanner`).
//! - **Edges** are routed to the shard that owns the source node.
//! - **Queries** fan out to all shards and merge results.
//!
//! # Storage Layout
//!
//! ```text
//! <name>.rfdb/
//! +-- db_config.json          # DatabaseConfig (shard_count)
//! +-- current.json            # Manifest pointer
//! +-- manifest_index.json     # ManifestIndex
//! +-- manifests/
//! +-- segments/
//! |   +-- 00/                 # Shard 0
//! |   |   +-- seg_000001_nodes.seg
//! |   |   +-- seg_000002_edges.seg
//! |   +-- 01/                 # Shard 1
//! |   |   +-- seg_000003_nodes.seg
//! |   +-- ...
//! ```

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{GraphError, Result};
use crate::storage_v2::manifest::{ManifestStore, SegmentDescriptor};
use crate::storage_v2::shard::Shard;
use crate::storage_v2::shard_planner::ShardPlanner;
use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2, SegmentType};

// ── Database Config ────────────────────────────────────────────────

/// Persistent database configuration.
///
/// Written once at database creation time to `db_config.json`.
/// Read on every open to determine shard count.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseConfig {
    /// Number of shards for this database.
    pub shard_count: u16,
}

impl DatabaseConfig {
    /// Read config from database root. Returns None if file doesn't exist.
    pub fn read_from(db_path: &Path) -> Result<Option<Self>> {
        let path = db_path.join("db_config.json");
        if !path.exists() {
            return Ok(None);
        }
        let contents = std::fs::read_to_string(&path)?;
        let config: Self = serde_json::from_str(&contents)?;
        Ok(Some(config))
    }

    /// Write config to database root.
    pub fn write_to(&self, db_path: &Path) -> Result<()> {
        let path = db_path.join("db_config.json");
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, json)?;
        Ok(())
    }
}

// ── Shard Stats ────────────────────────────────────────────────────

/// Per-shard statistics for monitoring.
#[derive(Debug, Clone)]
pub struct ShardStats {
    pub shard_id: u16,
    pub node_count: usize,
    pub edge_count: usize,
    pub node_segments: usize,
    pub edge_segments: usize,
    pub write_buffer_nodes: usize,
    pub write_buffer_edges: usize,
}

// ── Multi-Shard Store ──────────────────────────────────────────────

/// Multi-shard store wrapping N independent Shard instances.
///
/// Provides the same query interface as a single shard:
/// - `add_nodes()`: routes each node to its shard by file directory hash
/// - `add_edges()`: routes each edge to the shard owning edge.src
/// - `get_node()`, `find_nodes()`, edge queries: fan out to all shards, merge
///
/// NOT Send+Sync by default. For multi-threaded access, wrap in
/// `Arc<Mutex<MultiShardStore>>`.
pub struct MultiShardStore {
    /// Database root path. None for ephemeral stores.
    /// Used by create/open constructors; will be needed for future
    /// operations (e.g., shard rebalancing).
    #[allow(dead_code)]
    db_path: Option<PathBuf>,

    /// Shard planner for routing nodes to shards.
    planner: ShardPlanner,

    /// N independent Shard instances, indexed by shard_id (0..shard_count).
    shards: Vec<Shard>,

    /// Reverse index: node_id -> shard_id.
    /// Built during add_nodes() and rebuilt from all_node_ids() on open().
    node_to_shard: HashMap<u128, u16>,
}

// ── Constructors ───────────────────────────────────────────────────

impl MultiShardStore {
    /// Create a new multi-shard database on disk.
    ///
    /// Creates shard directories under `<db_path>/segments/NN/`.
    /// Writes `db_config.json` with the shard count.
    ///
    /// Does NOT create ManifestStore — caller manages that separately.
    pub fn create(db_path: &Path, shard_count: u16) -> Result<Self> {
        assert!(shard_count > 0, "shard_count must be > 0");

        let config = DatabaseConfig { shard_count };
        config.write_to(db_path)?;

        let mut shards = Vec::with_capacity(shard_count as usize);
        for i in 0..shard_count {
            let shard_path = shard_dir(db_path, i);
            let shard = Shard::create_for_shard(&shard_path, i)?;
            shards.push(shard);
        }

        Ok(Self {
            db_path: Some(db_path.to_path_buf()),
            planner: ShardPlanner::new(shard_count),
            shards,
            node_to_shard: HashMap::new(),
        })
    }

    /// Open an existing multi-shard database from disk.
    ///
    /// Reads `db_config.json`, groups manifest descriptors by shard_id,
    /// opens each shard, and rebuilds `node_to_shard` via `all_node_ids()`.
    pub fn open(db_path: &Path, manifest_store: &ManifestStore) -> Result<Self> {
        let config = DatabaseConfig::read_from(db_path)?
            .ok_or_else(|| GraphError::InvalidFormat(
                "Missing db_config.json".to_string(),
            ))?;

        let current = manifest_store.current();

        // Group segment descriptors by shard_id
        let mut node_descs_by_shard: HashMap<u16, Vec<SegmentDescriptor>> = HashMap::new();
        let mut edge_descs_by_shard: HashMap<u16, Vec<SegmentDescriptor>> = HashMap::new();

        for desc in &current.node_segments {
            let shard_id = desc.shard_id.unwrap_or(0);
            node_descs_by_shard
                .entry(shard_id)
                .or_default()
                .push(desc.clone());
        }
        for desc in &current.edge_segments {
            let shard_id = desc.shard_id.unwrap_or(0);
            edge_descs_by_shard
                .entry(shard_id)
                .or_default()
                .push(desc.clone());
        }

        // Open each shard
        let mut shards = Vec::with_capacity(config.shard_count as usize);
        for i in 0..config.shard_count {
            let shard_path = shard_dir(db_path, i);
            let node_descs = node_descs_by_shard.remove(&i).unwrap_or_default();
            let edge_descs = edge_descs_by_shard.remove(&i).unwrap_or_default();
            let shard = Shard::open_for_shard(
                &shard_path,
                db_path,
                i,
                node_descs,
                edge_descs,
            )?;
            shards.push(shard);
        }

        // Rebuild node_to_shard from all shards
        let mut node_to_shard = HashMap::new();
        for (shard_id, shard) in shards.iter().enumerate() {
            for node_id in shard.all_node_ids() {
                node_to_shard.insert(node_id, shard_id as u16);
            }
        }

        Ok(Self {
            db_path: Some(db_path.to_path_buf()),
            planner: ShardPlanner::new(config.shard_count),
            shards,
            node_to_shard,
        })
    }

    /// Create ephemeral multi-shard store (in-memory only).
    ///
    /// Used for unit tests and temporary analysis graphs.
    pub fn ephemeral(shard_count: u16) -> Self {
        assert!(shard_count > 0, "shard_count must be > 0");

        let shards = (0..shard_count).map(|_| Shard::ephemeral()).collect();

        Self {
            db_path: None,
            planner: ShardPlanner::new(shard_count),
            shards,
            node_to_shard: HashMap::new(),
        }
    }
}

// ── Write Operations ───────────────────────────────────────────────

impl MultiShardStore {
    /// Add nodes, routing each to its shard by file directory hash.
    ///
    /// Updates `node_to_shard` for subsequent edge routing.
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>) {
        // Group nodes by shard
        let mut by_shard: HashMap<u16, Vec<NodeRecordV2>> = HashMap::new();
        for node in records {
            let shard_id = self.planner.compute_shard_id(&node.file);
            self.node_to_shard.insert(node.id, shard_id);
            by_shard.entry(shard_id).or_default().push(node);
        }

        // Dispatch to each shard
        for (shard_id, nodes) in by_shard {
            self.shards[shard_id as usize].add_nodes(nodes);
        }
    }

    /// Add edges, routing each to the shard owning the source node.
    ///
    /// Returns error if any edge's source node is not found in
    /// `node_to_shard` (node must be added before its outgoing edges).
    pub fn add_edges(&mut self, records: Vec<EdgeRecordV2>) -> Result<()> {
        let mut by_shard: HashMap<u16, Vec<EdgeRecordV2>> = HashMap::new();
        for edge in records {
            let shard_id = self.node_to_shard.get(&edge.src)
                .copied()
                .ok_or(GraphError::NodeNotFound(edge.src))?;
            by_shard.entry(shard_id).or_default().push(edge);
        }

        for (shard_id, edges) in by_shard {
            self.shards[shard_id as usize].add_edges(edges);
        }

        Ok(())
    }
}

// ── Flush ──────────────────────────────────────────────────────────

impl MultiShardStore {
    /// Flush all shards and commit a new manifest version.
    ///
    /// Uses the correct two-step ManifestStore protocol:
    /// 1. Start with current manifest's segments
    /// 2. Extend with NEW segments from flush
    /// 3. Create manifest (takes FULL list)
    /// 4. Commit the manifest
    ///
    /// Returns the number of shards that actually flushed data.
    pub fn flush_all(&mut self, manifest_store: &mut ManifestStore) -> Result<usize> {
        let shard_count = self.shards.len();
        let mut new_node_descs: Vec<SegmentDescriptor> = Vec::new();
        let mut new_edge_descs: Vec<SegmentDescriptor> = Vec::new();
        let mut flushed_count = 0;

        for shard_idx in 0..shard_count {
            let shard_id = shard_idx as u16;

            // Determine segment IDs before flush
            let (wb_nodes, wb_edges) = self.shards[shard_idx].write_buffer_size();
            let node_seg_id = if wb_nodes > 0 {
                Some(manifest_store.next_segment_id())
            } else {
                None
            };
            let edge_seg_id = if wb_edges > 0 {
                Some(manifest_store.next_segment_id())
            } else {
                None
            };

            let flush_result = self.shards[shard_idx]
                .flush_with_ids(node_seg_id, edge_seg_id)?;

            if let Some(result) = flush_result {
                flushed_count += 1;

                if let (Some(meta), Some(seg_id)) = (&result.node_meta, node_seg_id) {
                    new_node_descs.push(SegmentDescriptor::from_meta(
                        seg_id,
                        SegmentType::Nodes,
                        Some(shard_id),
                        meta.clone(),
                    ));
                }
                if let (Some(meta), Some(seg_id)) = (&result.edge_meta, edge_seg_id) {
                    new_edge_descs.push(SegmentDescriptor::from_meta(
                        seg_id,
                        SegmentType::Edges,
                        Some(shard_id),
                        meta.clone(),
                    ));
                }
            }
        }

        if flushed_count == 0 {
            return Ok(0);
        }

        // Two-step ManifestStore protocol:
        // Step 1: Start with current segments
        let mut all_node_segs = manifest_store.current().node_segments.clone();
        let mut all_edge_segs = manifest_store.current().edge_segments.clone();

        // Step 2: Extend with NEW segments
        all_node_segs.extend(new_node_descs);
        all_edge_segs.extend(new_edge_descs);

        // Step 3: Create manifest (full list)
        let manifest = manifest_store.create_manifest(
            all_node_segs,
            all_edge_segs,
            None,
        )?;

        // Step 4: Commit
        manifest_store.commit(manifest)?;

        Ok(flushed_count)
    }
}

// ── Point Lookup ───────────────────────────────────────────────────

impl MultiShardStore {
    /// Get node by id. Checks node_to_shard first for O(1) routing,
    /// falls back to fan-out if not found in index.
    pub fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
        // Fast path: node_to_shard has the mapping
        if let Some(&shard_id) = self.node_to_shard.get(&id) {
            return self.shards[shard_id as usize].get_node(id);
        }

        // Slow path: fan-out (node might exist in a segment not yet
        // indexed in node_to_shard — shouldn't happen in normal flow,
        // but defensive)
        for shard in &self.shards {
            if let Some(node) = shard.get_node(id) {
                return Some(node);
            }
        }

        None
    }

    /// Check if node exists across all shards.
    pub fn node_exists(&self, id: u128) -> bool {
        if let Some(&shard_id) = self.node_to_shard.get(&id) {
            return self.shards[shard_id as usize].node_exists(id);
        }

        self.shards.iter().any(|s| s.node_exists(id))
    }
}

// ── Attribute Search ───────────────────────────────────────────────

impl MultiShardStore {
    /// Find nodes matching optional node_type and/or file filters.
    ///
    /// Fans out to all shards and merges results.
    /// Deduplicates by node id (same node can't be in multiple shards
    /// in normal operation, but defensive dedup is cheap).
    pub fn find_nodes(
        &self,
        node_type: Option<&str>,
        file: Option<&str>,
    ) -> Vec<NodeRecordV2> {
        let mut seen: HashSet<u128> = HashSet::new();
        let mut results: Vec<NodeRecordV2> = Vec::new();

        for shard in &self.shards {
            for node in shard.find_nodes(node_type, file) {
                if seen.insert(node.id) {
                    results.push(node);
                }
            }
        }

        results
    }
}

// ── Neighbor Queries ───────────────────────────────────────────────

impl MultiShardStore {
    /// Get outgoing edges from a node.
    ///
    /// Edges are stored in the shard owning the source node, so this
    /// can be a targeted query when node_to_shard has the mapping.
    /// Falls back to fan-out otherwise.
    pub fn get_outgoing_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2> {
        // Fast path: edges live in the source node's shard
        if let Some(&shard_id) = self.node_to_shard.get(&node_id) {
            return self.shards[shard_id as usize]
                .get_outgoing_edges(node_id, edge_types);
        }

        // Slow path: fan-out
        let mut results = Vec::new();
        for shard in &self.shards {
            results.extend(shard.get_outgoing_edges(node_id, edge_types));
        }
        results
    }

    /// Get incoming edges to a node.
    ///
    /// Incoming edges can be in ANY shard (because edge is stored in
    /// the source node's shard, and any node from any shard can point
    /// to this node). Must always fan out.
    pub fn get_incoming_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2> {
        let mut results = Vec::new();
        for shard in &self.shards {
            results.extend(shard.get_incoming_edges(node_id, edge_types));
        }
        results
    }
}

// ── Stats ──────────────────────────────────────────────────────────

impl MultiShardStore {
    /// Total node count across all shards.
    pub fn node_count(&self) -> usize {
        self.shards.iter().map(|s| s.node_count()).sum()
    }

    /// Total edge count across all shards.
    pub fn edge_count(&self) -> usize {
        self.shards.iter().map(|s| s.edge_count()).sum()
    }

    /// Number of shards.
    pub fn shard_count(&self) -> u16 {
        self.shards.len() as u16
    }

    /// Per-shard statistics for monitoring.
    pub fn shard_stats(&self) -> Vec<ShardStats> {
        self.shards
            .iter()
            .enumerate()
            .map(|(i, shard)| {
                let (node_segs, edge_segs) = shard.segment_count();
                let (wb_nodes, wb_edges) = shard.write_buffer_size();
                ShardStats {
                    shard_id: i as u16,
                    node_count: shard.node_count(),
                    edge_count: shard.edge_count(),
                    node_segments: node_segs,
                    edge_segments: edge_segs,
                    write_buffer_nodes: wb_nodes,
                    write_buffer_edges: wb_edges,
                }
            })
            .collect()
    }
}

// ── Private Helpers ────────────────────────────────────────────────

/// Compute shard directory path: `<db_path>/segments/<shard_id>/`
fn shard_dir(db_path: &Path, shard_id: u16) -> PathBuf {
    db_path.join("segments").join(format!("{:02}", shard_id))
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_v2::manifest::ManifestStore;

    // -- Test Helpers ----------------------------------------------------------

    fn make_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
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

    fn make_edge(src_semantic: &str, dst_semantic: &str, edge_type: &str) -> EdgeRecordV2 {
        let src = u128::from_le_bytes(
            blake3::hash(src_semantic.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        let dst = u128::from_le_bytes(
            blake3::hash(dst_semantic.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        EdgeRecordV2 {
            src,
            dst,
            edge_type: edge_type.to_string(),
            metadata: String::new(),
        }
    }

    fn node_id(semantic_id: &str) -> u128 {
        u128::from_le_bytes(
            blake3::hash(semantic_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        )
    }

    // -- DatabaseConfig Tests --------------------------------------------------

    #[test]
    fn test_config_roundtrip() {
        let dir = tempfile::TempDir::new().unwrap();
        let config = DatabaseConfig { shard_count: 8 };
        config.write_to(dir.path()).unwrap();

        let loaded = DatabaseConfig::read_from(dir.path()).unwrap().unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn test_config_read_nonexistent() {
        let dir = tempfile::TempDir::new().unwrap();
        let result = DatabaseConfig::read_from(dir.path()).unwrap();
        assert!(result.is_none());
    }

    // -- Ephemeral MultiShardStore Tests ---------------------------------------

    #[test]
    fn test_ephemeral_multi_shard_add_query() {
        let mut store = MultiShardStore::ephemeral(4);

        let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        let n2 = make_node("src/b/fn2", "FUNCTION", "fn2", "src/b/file.js");
        let id1 = n1.id;
        let id2 = n2.id;

        store.add_nodes(vec![n1.clone(), n2.clone()]);

        assert_eq!(store.get_node(id1).unwrap(), n1);
        assert_eq!(store.get_node(id2).unwrap(), n2);
        assert!(store.node_exists(id1));
        assert!(store.node_exists(id2));
        assert!(!store.node_exists(12345));
    }

    #[test]
    fn test_add_nodes_distributes_by_directory() {
        let mut store = MultiShardStore::ephemeral(4);

        // Add nodes from different directories
        let nodes: Vec<NodeRecordV2> = (0..20)
            .map(|i| {
                make_node(
                    &format!("dir_{}/fn_{}", i % 5, i),
                    "FUNCTION",
                    &format!("fn_{}", i),
                    &format!("dir_{}/file.js", i % 5),
                )
            })
            .collect();

        store.add_nodes(nodes);

        // Total should be 20
        assert_eq!(store.node_count(), 20);

        // At least 2 shards should have data (with 5 directories, 4 shards)
        let stats = store.shard_stats();
        let non_empty = stats.iter().filter(|s| s.node_count > 0).count();
        assert!(
            non_empty >= 2,
            "Expected at least 2 non-empty shards, got {}",
            non_empty,
        );
    }

    #[test]
    fn test_add_edges_routes_to_source_shard() {
        let mut store = MultiShardStore::ephemeral(4);

        let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        let n2 = make_node("src/b/fn2", "FUNCTION", "fn2", "src/b/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone()]);

        // Edge from n1 -> n2 should land in n1's shard
        let edge = make_edge("src/a/fn1", "src/b/fn2", "CALLS");
        store.add_edges(vec![edge.clone()]).unwrap();

        // Query outgoing edges from n1 — should find the edge
        let outgoing = store.get_outgoing_edges(n1.id, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].edge_type, "CALLS");
    }

    #[test]
    fn test_add_edges_src_not_found() {
        let mut store = MultiShardStore::ephemeral(4);

        // Try to add edge without adding source node first
        let edge = EdgeRecordV2 {
            src: 999,
            dst: 888,
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        };

        let result = store.add_edges(vec![edge]);
        assert!(result.is_err());
        match result.unwrap_err() {
            GraphError::NodeNotFound(id) => assert_eq!(id, 999),
            other => panic!("Expected NodeNotFound, got: {:?}", other),
        }
    }

    #[test]
    fn test_flush_all_commits_manifest() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        store.add_nodes(vec![n1]);

        let flushed = store.flush_all(&mut manifest_store).unwrap();
        assert!(flushed > 0);

        // Manifest should have been committed (version 2)
        assert_eq!(manifest_store.current().version, 2);

        // Segments should be in the manifest
        let total_node_segs = manifest_store.current().node_segments.len();
        assert!(total_node_segs > 0);
    }

    #[test]
    fn test_flush_empty_shards_skipped() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // No data — flush should be no-op
        let flushed = store.flush_all(&mut manifest_store).unwrap();
        assert_eq!(flushed, 0);
        assert_eq!(manifest_store.current().version, 1); // unchanged
    }

    #[test]
    fn test_get_node_across_shards() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Add nodes to different shards, flush, then query
        let nodes: Vec<NodeRecordV2> = (0..10)
            .map(|i| {
                make_node(
                    &format!("dir_{}/fn_{}", i, i),
                    "FUNCTION",
                    &format!("fn_{}", i),
                    &format!("dir_{}/file.js", i),
                )
            })
            .collect();

        let ids: Vec<u128> = nodes.iter().map(|n| n.id).collect();
        store.add_nodes(nodes);
        store.flush_all(&mut manifest_store).unwrap();

        // All nodes should be findable after flush
        for id in &ids {
            assert!(
                store.node_exists(*id),
                "Node {} not found after flush",
                id,
            );
        }
    }

    #[test]
    fn test_node_exists_across_shards() {
        let mut store = MultiShardStore::ephemeral(2);

        let n1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let n2 = make_node("b/fn2", "FUNCTION", "fn2", "b/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone()]);

        assert!(store.node_exists(n1.id));
        assert!(store.node_exists(n2.id));
        assert!(!store.node_exists(99999));
    }

    #[test]
    fn test_find_nodes_fan_out() {
        let mut store = MultiShardStore::ephemeral(4);

        let nodes: Vec<NodeRecordV2> = (0..8)
            .map(|i| {
                let node_type = if i % 2 == 0 { "FUNCTION" } else { "CLASS" };
                make_node(
                    &format!("dir_{}/item_{}", i, i),
                    node_type,
                    &format!("item_{}", i),
                    &format!("dir_{}/file.js", i),
                )
            })
            .collect();

        store.add_nodes(nodes);

        // find_nodes by type should aggregate across all shards
        let functions = store.find_nodes(Some("FUNCTION"), None);
        assert_eq!(functions.len(), 4);
        assert!(functions.iter().all(|n| n.node_type == "FUNCTION"));

        let classes = store.find_nodes(Some("CLASS"), None);
        assert_eq!(classes.len(), 4);

        let all = store.find_nodes(None, None);
        assert_eq!(all.len(), 8);
    }

    #[test]
    fn test_cross_shard_edges() {
        let mut store = MultiShardStore::ephemeral(4);

        // Create nodes in (likely) different shards
        let n1 = make_node("src/a/caller", "FUNCTION", "caller", "src/a/file.js");
        let n2 = make_node("lib/b/callee", "FUNCTION", "callee", "lib/b/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone()]);

        // Cross-shard edge: n1 -> n2
        let edge = make_edge("src/a/caller", "lib/b/callee", "CALLS");
        store.add_edges(vec![edge]).unwrap();

        // Outgoing from n1 should work
        let outgoing = store.get_outgoing_edges(n1.id, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].dst, n2.id);

        // Incoming to n2 should work (fan-out)
        let incoming = store.get_incoming_edges(n2.id, None);
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].src, n1.id);
    }

    #[test]
    fn test_incoming_edges_fan_out() {
        let mut store = MultiShardStore::ephemeral(4);

        // Create 4 nodes in different directories
        let target = make_node("lib/target", "FUNCTION", "target", "lib/file.js");
        let callers: Vec<NodeRecordV2> = (0..4)
            .map(|i| {
                make_node(
                    &format!("src_{}/caller_{}", i, i),
                    "FUNCTION",
                    &format!("caller_{}", i),
                    &format!("src_{}/file.js", i),
                )
            })
            .collect();

        let caller_ids: Vec<u128> = callers.iter().map(|n| n.id).collect();
        let mut all_nodes = vec![target.clone()];
        all_nodes.extend(callers);
        store.add_nodes(all_nodes);

        // Each caller calls target
        let edges: Vec<EdgeRecordV2> = caller_ids
            .iter()
            .map(|src| EdgeRecordV2 {
                src: *src,
                dst: target.id,
                edge_type: "CALLS".to_string(),
                metadata: String::new(),
            })
            .collect();
        store.add_edges(edges).unwrap();

        // Incoming edges to target should find all 4 (from different shards)
        let incoming = store.get_incoming_edges(target.id, None);
        assert_eq!(incoming.len(), 4);
    }

    #[test]
    fn test_node_count_edge_count() {
        let mut store = MultiShardStore::ephemeral(4);

        assert_eq!(store.node_count(), 0);
        assert_eq!(store.edge_count(), 0);

        let n1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let n2 = make_node("b/fn2", "FUNCTION", "fn2", "b/file.js");
        store.add_nodes(vec![n1, n2]);

        assert_eq!(store.node_count(), 2);

        store.add_edges(vec![
            make_edge("a/fn1", "b/fn2", "CALLS"),
        ]).unwrap();

        assert_eq!(store.edge_count(), 1);
    }

    #[test]
    fn test_shard_stats() {
        let mut store = MultiShardStore::ephemeral(4);

        let nodes: Vec<NodeRecordV2> = (0..8)
            .map(|i| {
                make_node(
                    &format!("dir_{}/fn_{}", i, i),
                    "FUNCTION",
                    &format!("fn_{}", i),
                    &format!("dir_{}/file.js", i),
                )
            })
            .collect();
        store.add_nodes(nodes);

        let stats = store.shard_stats();
        assert_eq!(stats.len(), 4);

        let total_nodes: usize = stats.iter().map(|s| s.node_count).sum();
        assert_eq!(total_nodes, 8);

        for stat in &stats {
            assert!(stat.shard_id < 4);
        }
    }

    #[test]
    fn test_create_disk_db() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let store = MultiShardStore::create(&db_path, 4).unwrap();
        assert_eq!(store.shard_count(), 4);

        // db_config.json should exist
        let config = DatabaseConfig::read_from(&db_path).unwrap().unwrap();
        assert_eq!(config.shard_count, 4);

        // Shard directories should exist
        for i in 0..4u16 {
            let shard_path = db_path.join("segments").join(format!("{:02}", i));
            assert!(shard_path.exists(), "Shard dir {:02} missing", i);
        }
    }

    #[test]
    fn test_open_existing_db() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let mut manifest_store = ManifestStore::create(&db_path).unwrap();

        // Create, add data, flush
        {
            let mut store = MultiShardStore::create(&db_path, 4).unwrap();
            let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
            let n2 = make_node("lib/b/fn2", "FUNCTION", "fn2", "lib/b/file.js");
            store.add_nodes(vec![n1, n2]);
            store.add_edges(vec![
                make_edge("src/a/fn1", "lib/b/fn2", "CALLS"),
            ]).unwrap();
            store.flush_all(&mut manifest_store).unwrap();
        }

        // Reopen
        let store = MultiShardStore::open(&db_path, &manifest_store).unwrap();
        assert_eq!(store.shard_count(), 4);
        assert_eq!(store.node_count(), 2);
        assert_eq!(store.edge_count(), 1);

        // Nodes should be queryable
        let id1 = node_id("src/a/fn1");
        let id2 = node_id("lib/b/fn2");
        assert!(store.node_exists(id1));
        assert!(store.node_exists(id2));

        // Edges should be queryable
        let outgoing = store.get_outgoing_edges(id1, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].edge_type, "CALLS");
    }

    #[test]
    fn test_equivalence_single_vs_multi() {
        // Same data added to both a single shard and multi-shard store
        // should produce the same query results.
        use crate::storage_v2::shard::Shard;

        let mut single = Shard::ephemeral();
        let mut multi = MultiShardStore::ephemeral(4);

        // Build test data
        let nodes: Vec<NodeRecordV2> = (0..20)
            .map(|i| {
                let node_type = if i % 3 == 0 { "FUNCTION" } else { "CLASS" };
                make_node(
                    &format!("dir_{}/item_{}", i % 4, i),
                    node_type,
                    &format!("item_{}", i),
                    &format!("dir_{}/file.js", i % 4),
                )
            })
            .collect();

        let edges: Vec<EdgeRecordV2> = (0..19)
            .map(|i| {
                make_edge(
                    &format!("dir_{}/item_{}", i % 4, i),
                    &format!("dir_{}/item_{}", (i + 1) % 4, i + 1),
                    "CALLS",
                )
            })
            .collect();

        single.add_nodes(nodes.clone());
        single.add_edges(edges.clone());
        multi.add_nodes(nodes);
        multi.add_edges(edges).unwrap();

        // Node counts must match
        assert_eq!(single.node_count(), multi.node_count());
        assert_eq!(single.edge_count(), multi.edge_count());

        // find_nodes results must match
        let single_fns = single.find_nodes(Some("FUNCTION"), None);
        let multi_fns = multi.find_nodes(Some("FUNCTION"), None);
        assert_eq!(single_fns.len(), multi_fns.len());

        let single_ids: HashSet<u128> = single_fns.iter().map(|n| n.id).collect();
        let multi_ids: HashSet<u128> = multi_fns.iter().map(|n| n.id).collect();
        assert_eq!(single_ids, multi_ids);

        // Point lookups must match
        for i in 0..20 {
            let id = node_id(&format!("dir_{}/item_{}", i % 4, i));
            assert_eq!(
                single.get_node(id).is_some(),
                multi.get_node(id).is_some(),
                "Mismatch for node {}",
                i,
            );
        }
    }

    #[test]
    fn test_empty_shards_ok() {
        // Even with 8 shards and 1 node, should work fine
        let mut store = MultiShardStore::ephemeral(8);
        let mut manifest_store = ManifestStore::ephemeral();

        let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        store.add_nodes(vec![n1.clone()]);
        store.flush_all(&mut manifest_store).unwrap();

        assert_eq!(store.node_count(), 1);
        assert!(store.node_exists(n1.id));

        // Most shards should be empty
        let stats = store.shard_stats();
        let empty_count = stats.iter().filter(|s| s.node_count == 0).count();
        assert!(empty_count >= 6, "Expected most shards empty, got {} non-empty", 8 - empty_count);
    }

    #[test]
    fn test_node_to_shard_rebuilt_on_open() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let mut manifest_store = ManifestStore::create(&db_path).unwrap();

        // Create, add, flush
        let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        let n2 = make_node("lib/b/fn2", "FUNCTION", "fn2", "lib/b/file.js");
        {
            let mut store = MultiShardStore::create(&db_path, 4).unwrap();
            store.add_nodes(vec![n1.clone(), n2.clone()]);
            store.flush_all(&mut manifest_store).unwrap();
        }

        // Reopen — node_to_shard should be rebuilt from all_node_ids()
        let store = MultiShardStore::open(&db_path, &manifest_store).unwrap();

        // Verify node_to_shard works for edge routing
        assert!(store.node_exists(n1.id));
        assert!(store.node_exists(n2.id));

        // get_node should use fast path (node_to_shard)
        assert_eq!(store.get_node(n1.id).unwrap().name, "fn1");
        assert_eq!(store.get_node(n2.id).unwrap().name, "fn2");
    }

    #[test]
    fn test_multiple_flush_cycles() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Cycle 1
        store.add_nodes(vec![
            make_node("a/fn1", "FUNCTION", "fn1", "a/file.js"),
        ]);
        store.flush_all(&mut manifest_store).unwrap();
        assert_eq!(manifest_store.current().version, 2);

        // Cycle 2
        store.add_nodes(vec![
            make_node("b/fn2", "FUNCTION", "fn2", "b/file.js"),
        ]);
        store.add_edges(vec![
            make_edge("a/fn1", "b/fn2", "CALLS"),
        ]).unwrap();
        store.flush_all(&mut manifest_store).unwrap();
        assert_eq!(manifest_store.current().version, 3);

        // All data should be queryable
        assert_eq!(store.node_count(), 2);
        assert_eq!(store.edge_count(), 1);

        // Manifest should have accumulated segments
        let current = manifest_store.current();
        assert!(current.node_segments.len() >= 2);
    }

    #[test]
    fn test_outgoing_edges_type_filter() {
        let mut store = MultiShardStore::ephemeral(2);

        let n1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let n2 = make_node("b/fn2", "FUNCTION", "fn2", "b/file.js");
        let n3 = make_node("c/fn3", "FUNCTION", "fn3", "c/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone(), n3.clone()]);

        store.add_edges(vec![
            make_edge("a/fn1", "b/fn2", "CALLS"),
            make_edge("a/fn1", "c/fn3", "IMPORTS_FROM"),
        ]).unwrap();

        let all = store.get_outgoing_edges(n1.id, None);
        assert_eq!(all.len(), 2);

        let calls_only = store.get_outgoing_edges(n1.id, Some(&["CALLS"]));
        assert_eq!(calls_only.len(), 1);
        assert_eq!(calls_only[0].edge_type, "CALLS");

        let imports_only = store.get_outgoing_edges(n1.id, Some(&["IMPORTS_FROM"]));
        assert_eq!(imports_only.len(), 1);
        assert_eq!(imports_only[0].edge_type, "IMPORTS_FROM");
    }
}
