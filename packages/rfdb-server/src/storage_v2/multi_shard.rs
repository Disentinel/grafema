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
use crate::storage_v2::compaction::{CompactionConfig, CompactionResult};
use crate::storage_v2::index::{build_inverted_indexes, GlobalIndex, IndexEntry, InvertedIndex};
use crate::storage_v2::manifest::{ManifestStore, SegmentDescriptor};
use crate::storage_v2::segment::{self, EdgeSegmentV2, NodeSegmentV2};
use crate::storage_v2::shard::{Shard, TombstoneSet};
use crate::storage_v2::shard_planner::ShardPlanner;
use crate::storage_v2::types::{CommitDelta, EdgeRecordV2, NodeRecordV2, SegmentType, extract_file_context};

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
/// - `upsert_edges()`: routes each edge to the shard owning edge.src
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

    /// Global index for O(log N) point lookups across shards.
    /// Built during compaction from all shards' L1 entries.
    global_index: Option<GlobalIndex>,

    /// Enrichment edge index: maps source node ID to shard IDs
    /// containing enrichment edges FROM that node.
    /// Used for cross-shard edge queries.
    enrichment_edge_to_shard: HashMap<u128, HashSet<u16>>,
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
            global_index: None,
            enrichment_edge_to_shard: HashMap::new(),
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

        // Group L1 segment descriptors by shard_id
        let mut l1_node_descs_by_shard: HashMap<u16, SegmentDescriptor> = HashMap::new();
        let mut l1_edge_descs_by_shard: HashMap<u16, SegmentDescriptor> = HashMap::new();

        for desc in &current.l1_node_segments {
            let shard_id = desc.shard_id.unwrap_or(0);
            l1_node_descs_by_shard.insert(shard_id, desc.clone());
        }
        for desc in &current.l1_edge_segments {
            let shard_id = desc.shard_id.unwrap_or(0);
            l1_edge_descs_by_shard.insert(shard_id, desc.clone());
        }

        // Open each shard
        let mut shards = Vec::with_capacity(config.shard_count as usize);
        for i in 0..config.shard_count {
            let shard_path = shard_dir(db_path, i);
            let node_descs = node_descs_by_shard.remove(&i).unwrap_or_default();
            let edge_descs = edge_descs_by_shard.remove(&i).unwrap_or_default();
            let mut shard = Shard::open_for_shard(
                &shard_path,
                db_path,
                i,
                node_descs,
                edge_descs,
            )?;

            // Load L1 segments if present in manifest
            let l1_node_desc = l1_node_descs_by_shard.remove(&i);
            let l1_edge_desc = l1_edge_descs_by_shard.remove(&i);

            let l1_node_seg = if let Some(desc) = &l1_node_desc {
                let seg_path = shard_path.join(
                    format!("seg_{:06}_nodes.seg", desc.segment_id),
                );
                Some(NodeSegmentV2::open(&seg_path)?)
            } else {
                None
            };

            let l1_edge_seg = if let Some(desc) = &l1_edge_desc {
                let seg_path = shard_path.join(
                    format!("seg_{:06}_edges.seg", desc.segment_id),
                );
                Some(EdgeSegmentV2::open(&seg_path)?)
            } else {
                None
            };

            if l1_node_seg.is_some() || l1_edge_seg.is_some() {
                shard.set_l1_segments(
                    l1_node_seg,
                    l1_node_desc,
                    l1_edge_seg,
                    l1_edge_desc,
                );
            }

            shards.push(shard);
        }

        // Rebuild node_to_shard from all shards
        let mut node_to_shard = HashMap::new();
        for (shard_id, shard) in shards.iter().enumerate() {
            for node_id in shard.all_node_ids() {
                node_to_shard.insert(node_id, shard_id as u16);
            }
        }

        // Rebuild enrichment_edge_to_shard by scanning edge metadata
        let mut enrichment_edge_to_shard: HashMap<u128, HashSet<u16>> = HashMap::new();
        for (shard_id, shard) in shards.iter().enumerate() {
            for src_id in shard.find_enrichment_edge_src_ids() {
                enrichment_edge_to_shard
                    .entry(src_id)
                    .or_default()
                    .insert(shard_id as u16);
            }
        }

        Ok(Self {
            db_path: Some(db_path.to_path_buf()),
            planner: ShardPlanner::new(config.shard_count),
            shards,
            node_to_shard,
            global_index: None,
            enrichment_edge_to_shard,
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
            global_index: None,
            enrichment_edge_to_shard: HashMap::new(),
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

    /// Upsert edges, routing each to the appropriate shard.
    ///
    /// Routing logic:
    /// - If edge metadata has `__file_context` → route to enrichment shard
    ///   (determined by hashing the file_context path via `ShardPlanner`)
    /// - Otherwise → route to source node's shard (existing behavior)
    ///
    /// Returns error if any non-enrichment edge's source node is not found
    /// in `node_to_shard` (node must be added before its outgoing edges).
    pub fn upsert_edges(&mut self, records: Vec<EdgeRecordV2>) -> Result<()> {
        let mut by_shard: HashMap<u16, Vec<EdgeRecordV2>> = HashMap::new();
        let mut skipped = 0u64;
        for edge in records {
            if let Some(file_context) = extract_file_context(&edge.metadata) {
                // Enrichment edge: route to shard determined by file_context
                let shard_id = self.planner.compute_shard_id(&file_context);
                self.enrichment_edge_to_shard
                    .entry(edge.src)
                    .or_default()
                    .insert(shard_id);
                by_shard.entry(shard_id).or_default().push(edge);
            } else {
                // Normal edge: route to source node's shard
                match self.node_to_shard.get(&edge.src).copied() {
                    Some(shard_id) => {
                        by_shard.entry(shard_id).or_default().push(edge);
                    }
                    None => {
                        // Skip edges whose source node is not yet known.
                        // This happens when edges reference nodes from other
                        // batches (e.g., MODULE nodes deleted by a later batch).
                        skipped += 1;
                    }
                }
            }
        }

        if skipped > 0 {
            tracing::warn!("upsert_edges: skipped {} edges with unknown source node", skipped);
        }

        for (shard_id, edges) in by_shard {
            self.shards[shard_id as usize].upsert_edges(edges);
        }

        Ok(())
    }
}

// ── Tombstones ────────────────────────────────────────────────────

impl MultiShardStore {
    /// Apply pending tombstones to all shards.
    ///
    /// Merges the given node IDs and edge keys into each shard's
    /// existing tombstone set. Called by `GraphEngineV2::flush()` to
    /// persist buffered `delete_node`/`delete_edge` operations.
    pub fn set_tombstones(
        &mut self,
        node_ids: &HashSet<u128>,
        edge_keys: &HashSet<(u128, u128, String)>,
    ) {
        for shard in &mut self.shards {
            let mut merged_nodes: HashSet<u128> =
                shard.tombstones().node_ids.iter().copied().collect();
            merged_nodes.extend(node_ids.iter().copied());

            let mut merged_edges: HashSet<(u128, u128, String)> =
                shard.tombstones().edge_keys.iter().cloned().collect();
            merged_edges.extend(edge_keys.iter().cloned());

            shard.set_tombstones(TombstoneSet {
                node_ids: merged_nodes,
                edge_keys: merged_edges,
            });
        }
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
    /// then global index for O(log N) L1 lookup, falls back to fan-out.
    pub fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
        // Fast path: node_to_shard has the mapping (covers write buffer + L0)
        if let Some(&shard_id) = self.node_to_shard.get(&id) {
            return self.shards[shard_id as usize].get_node(id);
        }

        // O(log N) path: global index for L1 direct lookup
        if let Some(global_idx) = &self.global_index {
            if let Some(entry) = global_idx.lookup(id) {
                let shard = &self.shards[entry.shard as usize];
                if let Some(l1) = shard.l1_node_segment() {
                    // Check tombstone before returning
                    if !shard.tombstones().contains_node(id) {
                        return Some(l1.get_record(entry.offset as usize));
                    } else {
                        return None;
                    }
                }
            }
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

    /// Find node IDs by exact node type.
    ///
    /// Nodes are uniquely assigned to one shard, so no cross-shard dedup is
    /// needed on this fast path.
    pub fn find_node_ids_by_type(&self, node_type: &str) -> Vec<u128> {
        let mut results = Vec::new();
        for shard in &self.shards {
            results.extend(shard.find_node_ids_by_type(node_type));
        }
        results
    }

    /// Find node IDs matching AttrQuery-compatible filters without cloning records.
    ///
    /// Same logical filters as `GraphEngineV2::find_by_attr`, but returns IDs
    /// directly for lower allocation overhead on hot query paths.
    pub fn find_node_ids_by_attr(
        &self,
        node_type: Option<&str>,
        node_type_prefix: Option<&str>,
        file: Option<&str>,
        name: Option<&str>,
        exported: Option<bool>,
        metadata_filters: &[(String, String)],
        substring_match: bool,
    ) -> Vec<u128> {
        let mut seen: HashSet<u128> = HashSet::new();
        let mut results: Vec<u128> = Vec::new();

        for shard in &self.shards {
            for id in shard.find_node_ids_by_attr(
                node_type,
                node_type_prefix,
                file,
                name,
                exported,
                metadata_filters,
                substring_match,
            ) {
                if seen.insert(id) {
                    results.push(id);
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
    /// Normal edges are stored in the shard owning the source node.
    /// Enrichment edges may be in different shards (tracked by
    /// `enrichment_edge_to_shard` index). Both are queried and merged.
    /// Falls back to fan-out if node not in any index.
    pub fn get_outgoing_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2> {
        let source_shard = self.node_to_shard.get(&node_id).copied();
        let enrichment_shards = self.enrichment_edge_to_shard.get(&node_id);

        // If node is in neither index, fall back to fan-out
        if source_shard.is_none() && enrichment_shards.is_none() {
            let mut results = Vec::new();
            for shard in &self.shards {
                results.extend(shard.get_outgoing_edges(node_id, edge_types));
            }
            return results;
        }

        // Collect unique shard IDs to query
        let mut shard_ids: HashSet<u16> = HashSet::new();
        if let Some(sid) = source_shard {
            shard_ids.insert(sid);
        }
        if let Some(enrichment) = enrichment_shards {
            shard_ids.extend(enrichment);
        }

        let mut results = Vec::new();
        for sid in shard_ids {
            results.extend(
                self.shards[sid as usize].get_outgoing_edges(node_id, edge_types),
            );
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

// ── Edge Key Discovery ─────────────────────────────────────────────

impl MultiShardStore {
    /// Find edge keys (src, dst, edge_type) where src is in the given ID set,
    /// across all shards.
    ///
    /// Fan-out to all shards, concatenate results.
    ///
    /// Complexity: O(N * S * (K * B + N_matching))
    ///   where N = shard_count
    pub fn find_edge_keys_by_src_ids(
        &self,
        src_ids: &HashSet<u128>,
    ) -> Vec<(u128, u128, String)> {
        let mut keys = Vec::new();
        for shard in &self.shards {
            keys.extend(shard.find_edge_keys_by_src_ids(src_ids));
        }
        keys
    }

    /// Like `find_edge_keys_by_src_ids` but excludes enrichment edges
    /// (edges with `__file_context` in metadata).
    ///
    /// Used during normal file re-analysis to avoid tombstoning
    /// enrichment edges that belong to their enrichment file context.
    pub fn find_non_enrichment_edge_keys_by_src_ids(
        &self,
        src_ids: &HashSet<u128>,
    ) -> Vec<(u128, u128, String)> {
        let mut keys = Vec::new();
        for shard in &self.shards {
            keys.extend(shard.find_non_enrichment_edge_keys_by_src_ids(src_ids));
        }
        keys
    }

    /// Find edge keys (src, dst, edge_type) where edge metadata contains
    /// the given `__file_context`, across all shards.
    ///
    /// Fan-out to all shards, concatenate results.
    /// Must check ALL shards because edges might have been previously
    /// added to the wrong shard (before enrichment routing was added).
    pub fn find_edge_keys_by_file_context(
        &self,
        file_context: &str,
    ) -> Vec<(u128, u128, String)> {
        let mut keys = Vec::new();
        for shard in &self.shards {
            keys.extend(shard.find_edge_keys_by_file_context(file_context));
        }
        keys
    }
}

// ── Batch Commit ───────────────────────────────────────────────────

impl MultiShardStore {
    /// Atomic batch commit: tombstone old data for changed files,
    /// add new nodes/edges, flush, commit manifest with tombstones.
    ///
    /// Returns CommitDelta describing what changed.
    ///
    /// Algorithm (9 phases):
    /// 1. Snapshot old state for delta computation
    /// 2. Compute tombstones (node IDs + edge keys)
    /// 3. Collect changed node/edge types for delta
    /// 4. Apply tombstones to all shards (union with existing)
    /// 5. Add new data (nodes + edges)
    /// 5.5. Remove re-added IDs from tombstones (new data supersedes)
    /// 6. Compute modified count (same id, different content_hash)
    /// 7. Flush shards (inlined from flush_all for tombstone injection)
    /// 8. Build and commit manifest WITH tombstones
    /// 9. Build CommitDelta
    ///
    /// Complexity: O(F * N_per_file + K * S * B + N + E + flush)
    pub fn commit_batch(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        manifest_store: &mut ManifestStore,
    ) -> Result<CommitDelta> {
        // ── Phase 1: Snapshot old state for delta ──
        // Separate enrichment file contexts from normal files.
        // Enrichment file contexts start with "__enrichment__/".
        let mut normal_files: Vec<&String> = Vec::new();
        let mut enrichment_contexts: Vec<&String> = Vec::new();
        for file in changed_files {
            if file.starts_with("__enrichment__/") {
                enrichment_contexts.push(file);
            } else {
                normal_files.push(file);
            }
        }

        let mut old_nodes_by_id: HashMap<u128, NodeRecordV2> = HashMap::new();
        // Snapshot nodes for ALL changed files (including enrichment contexts,
        // which may have nodes in backward-compatible mode).
        for file in changed_files {
            for node in self.find_nodes(None, Some(file)) {
                old_nodes_by_id.insert(node.id, node);
            }
        }
        let old_node_ids: HashSet<u128> = old_nodes_by_id.keys().copied().collect();

        // ── Phase 2: Compute tombstones ──
        // 2a. Node tombstones = all old nodes for ALL changed files
        let tombstone_node_ids: HashSet<u128> = old_node_ids.clone();

        // 2b. Edge tombstones: depends on file type.
        //
        // For normal files: tombstone non-enrichment edges from those nodes.
        //   Enrichment edges from these nodes are NOT tombstoned — they
        //   belong to their enrichment file context.
        //
        // For enrichment file contexts:
        //   - Tombstone ALL edges from enrichment-file nodes (if any, backward compat)
        //   - PLUS edges matching the __file_context metadata (surgical tombstoning)
        let normal_file_node_ids: HashSet<u128> = old_nodes_by_id
            .iter()
            .filter(|(_, n)| !n.file.starts_with("__enrichment__/"))
            .map(|(id, _)| *id)
            .collect();
        let enrichment_file_node_ids: HashSet<u128> = old_nodes_by_id
            .iter()
            .filter(|(_, n)| n.file.starts_with("__enrichment__/"))
            .map(|(id, _)| *id)
            .collect();

        let mut tombstone_edge_keys: Vec<(u128, u128, String)> =
            self.find_non_enrichment_edge_keys_by_src_ids(&normal_file_node_ids);

        if !enrichment_file_node_ids.is_empty() {
            tombstone_edge_keys.extend(
                self.find_edge_keys_by_src_ids(&enrichment_file_node_ids),
            );
        }
        for ctx in &enrichment_contexts {
            tombstone_edge_keys.extend(self.find_edge_keys_by_file_context(ctx));
        }

        // ── Phase 3: Collect changed types ──
        let mut changed_node_types: HashSet<String> = HashSet::new();
        let mut changed_edge_types: HashSet<String> = HashSet::new();

        // From tombstoned nodes/edges
        for node in old_nodes_by_id.values() {
            changed_node_types.insert(node.node_type.clone());
        }
        for (_, _, et) in &tombstone_edge_keys {
            changed_edge_types.insert(et.clone());
        }

        // From new nodes/edges
        for node in &nodes {
            changed_node_types.insert(node.node_type.clone());
        }
        for edge in &edges {
            changed_edge_types.insert(edge.edge_type.clone());
        }

        // ── Phase 4: Apply tombstones to shards ──
        // Build combined tombstone set (existing manifest + new)
        let current = manifest_store.current();
        let mut all_tomb_nodes: HashSet<u128> =
            current.tombstoned_node_ids.iter().copied().collect();
        all_tomb_nodes.extend(&tombstone_node_ids);

        let mut all_tomb_edges: HashSet<(u128, u128, String)> =
            current.tombstoned_edge_keys.iter().cloned().collect();
        all_tomb_edges.extend(tombstone_edge_keys.iter().cloned());

        for shard in &mut self.shards {
            shard.set_tombstones(TombstoneSet {
                node_ids: all_tomb_nodes.clone(),
                edge_keys: all_tomb_edges.clone(),
            });
        }

        // ── Phase 5: Add new data ──
        // Clone edges before upsert_edges (which takes ownership).
        // We need the clone for Phase 5.5 edge tombstone removal.
        let edges_clone: Vec<EdgeRecordV2> = edges.clone();
        self.add_nodes(nodes.clone());
        self.upsert_edges(edges)?;

        // ── Phase 5.5: Remove re-added IDs from tombstones ──
        // New data supersedes tombstones for the same IDs.
        for node in &nodes {
            all_tomb_nodes.remove(&node.id);
        }
        for edge in &edges_clone {
            all_tomb_edges.remove(&(edge.src, edge.dst, edge.edge_type.clone()));
        }

        // Re-apply updated tombstones to shards
        for shard in &mut self.shards {
            shard.set_tombstones(TombstoneSet {
                node_ids: all_tomb_nodes.clone(),
                edge_keys: all_tomb_edges.clone(),
            });
        }

        // ── Phase 6: Compute modified count ──
        let new_nodes_by_id: HashMap<u128, &NodeRecordV2> =
            nodes.iter().map(|n| (n.id, n)).collect();
        let mut nodes_modified: u64 = 0;
        let mut purely_new: u64 = 0;
        for (id, new_node) in &new_nodes_by_id {
            if let Some(old_node) = old_nodes_by_id.get(id) {
                if old_node.content_hash != 0
                    && new_node.content_hash != 0
                    && old_node.content_hash != new_node.content_hash
                {
                    nodes_modified += 1;
                }
            } else {
                purely_new += 1;
            }
        }

        // ── Phase 7: Flush shards (inlined from flush_all) ──
        // We inline flush coordination so we can inject tombstones
        // into the manifest between create_manifest() and commit().
        let shard_count = self.shards.len();
        let mut new_node_descs: Vec<SegmentDescriptor> = Vec::new();
        let mut new_edge_descs: Vec<SegmentDescriptor> = Vec::new();

        for shard_idx in 0..shard_count {
            let shard_id = shard_idx as u16;
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

        // ── Phase 8: Build and commit manifest WITH tombstones ──
        let mut all_node_segs = manifest_store.current().node_segments.clone();
        let mut all_edge_segs = manifest_store.current().edge_segments.clone();
        all_node_segs.extend(new_node_descs);
        all_edge_segs.extend(new_edge_descs);

        let mut manifest = manifest_store.create_manifest(
            all_node_segs,
            all_edge_segs,
            Some(tags),
        )?;

        // Inject tombstones into manifest before commit
        manifest.tombstoned_node_ids = all_tomb_nodes.into_iter().collect();
        manifest.tombstoned_edge_keys = all_tomb_edges.into_iter().collect();

        let manifest_version = manifest.version;
        manifest_store.commit(manifest)?;

        // ── Phase 9: Build CommitDelta ──
        Ok(CommitDelta {
            changed_files: changed_files.to_vec(),
            nodes_added: purely_new,
            nodes_removed: tombstone_node_ids.len() as u64,
            nodes_modified,
            removed_node_ids: tombstone_node_ids.into_iter().collect(),
            changed_node_types,
            changed_edge_types,
            manifest_version,
        })
    }
}

// ── Compaction ─────────────────────────────────────────────────────

impl MultiShardStore {
    /// Run compaction on all shards that exceed the L0 segment threshold.
    ///
    /// For each shard:
    /// 1. Check if L0 segment count >= config threshold
    /// 2. Merge L0 + existing L1 into new L1 segment (in-memory)
    /// 3. Write L1 segment files to shard directory (or in-memory for ephemeral)
    /// 4. Build inverted indexes (by_type, by_file) for the L1 node segment
    /// 5. Swap shard state: set L1, clear L0 + tombstones
    ///
    /// After all shards are processed:
    /// 6. Build global index from all L1 entries for O(log N) point lookups
    ///
    /// Then commit a new manifest with:
    /// - L0 segments removed (compacted into L1)
    /// - L1 segment descriptors added
    /// - Tombstones cleared
    /// - CompactionInfo recorded
    ///
    /// Returns CompactionResult with stats.
    pub fn compact(
        &mut self,
        manifest_store: &mut ManifestStore,
        config: &CompactionConfig,
    ) -> Result<CompactionResult> {
        self.compact_with_threads(manifest_store, config, None)
    }

    /// Run compaction with an explicit thread count (None = auto-detect).
    ///
    /// Three-phase architecture for parallel compaction:
    /// 1. Sequential: classify shards, preserve L1 data for non-compacted shards
    /// 2. Parallel: run `compact_shard()` on shards needing compaction (via rayon)
    /// 3. Sequential: write results to disk, update shard state, commit manifest
    pub fn compact_with_threads(
        &mut self,
        manifest_store: &mut ManifestStore,
        config: &CompactionConfig,
        thread_count: Option<usize>,
    ) -> Result<CompactionResult> {
        use crate::storage_v2::compaction::coordinator::{
            compact_shard, should_compact, ShardCompactionResult,
        };
        use crate::storage_v2::compaction::CompactionInfo;
        use crate::storage_v2::resource::ResourceManager;
        use rayon::prelude::*;
        use std::time::Instant;

        let start = Instant::now();
        let mut shards_compacted = Vec::new();
        let mut total_nodes_merged: u64 = 0;
        let mut total_edges_merged: u64 = 0;
        let mut total_tombstones_removed: u64 = 0;

        // Collect L1 descriptors for manifest
        let mut l1_node_descs: Vec<SegmentDescriptor> = Vec::new();
        let mut l1_edge_descs: Vec<SegmentDescriptor> = Vec::new();

        // Track which shards were compacted so we know which L0 segments to remove
        let mut compacted_shard_ids: HashSet<u16> = HashSet::new();

        // Collect entries for global index from all compacted shards
        let mut global_index_entries: Vec<IndexEntry> = Vec::new();

        // ── Phase 1: Classify shards ────────────────────────────────────
        // Collect non-compacted shard data and identify compaction targets.

        let mut shards_to_compact: Vec<usize> = Vec::new();

        for shard_idx in 0..self.shards.len() {
            let shard_id = shard_idx as u16;

            if !should_compact(&self.shards[shard_idx], config) {
                // Preserve existing L1 descriptors for non-compacted shards
                if let Some(desc) = self.shards[shard_idx].l1_node_descriptor() {
                    l1_node_descs.push(desc.clone());
                }
                if let Some(desc) = self.shards[shard_idx].l1_edge_descriptor() {
                    l1_edge_descs.push(desc.clone());
                }
                // Collect existing L1 entries for global index
                if let Some(l1_seg) = self.shards[shard_idx].l1_node_segment() {
                    let l1_seg_id = self.shards[shard_idx]
                        .l1_node_descriptor()
                        .map_or(0, |d| d.segment_id);
                    for i in 0..l1_seg.record_count() {
                        global_index_entries.push(IndexEntry::new(
                            l1_seg.get_id(i),
                            l1_seg_id,
                            i as u32,
                            shard_id,
                        ));
                    }
                }
                continue;
            }

            shards_to_compact.push(shard_idx);
        }

        // ── Prefetch segment files ─────────────────────────────────────
        // Hint the OS to asynchronously read segment files into the page
        // cache before compaction begins. Best-effort: errors are ignored.

        for &shard_idx in &shards_to_compact {
            if let Some(shard_path) = self.shards[shard_idx].path() {
                for desc in self.shards[shard_idx].l0_node_descriptors() {
                    let p = shard_path.join(format!("seg_{:06}_nodes.seg", desc.segment_id));
                    segment::prefetch_file(&p).ok();
                }
                for desc in self.shards[shard_idx].l0_edge_descriptors() {
                    let p = shard_path.join(format!("seg_{:06}_edges.seg", desc.segment_id));
                    segment::prefetch_file(&p).ok();
                }
                if let Some(desc) = self.shards[shard_idx].l1_node_descriptor() {
                    let p = shard_path.join(format!("seg_{:06}_nodes.seg", desc.segment_id));
                    segment::prefetch_file(&p).ok();
                }
                if let Some(desc) = self.shards[shard_idx].l1_edge_descriptor() {
                    let p = shard_path.join(format!("seg_{:06}_edges.seg", desc.segment_id));
                    segment::prefetch_file(&p).ok();
                }
            }
        }

        // ── Phase 2: Parallel compaction ────────────────────────────────
        // Run compact_shard() in parallel using rayon. Each call reads
        // from &Shard and returns owned ShardCompactionResult.

        let threads = thread_count
            .unwrap_or_else(|| ResourceManager::auto_tune().compaction_threads);

        let compaction_results: Vec<(usize, Result<ShardCompactionResult>)> = if threads <= 1
            || shards_to_compact.len() <= 1
        {
            // Sequential path: no thread pool overhead for single shard/thread
            shards_to_compact
                .iter()
                .map(|&idx| (idx, compact_shard(&self.shards[idx])))
                .collect()
        } else {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .map_err(|e| GraphError::Compaction(format!("rayon pool: {e}")))?;

            pool.install(|| {
                shards_to_compact
                    .par_iter()
                    .map(|&idx| (idx, compact_shard(&self.shards[idx])))
                    .collect()
            })
        };

        // ── Phase 3: Apply results (sequential) ────────────────────────
        // Write segments to disk, update shard state, build indexes.

        for (shard_idx, result) in compaction_results {
            let result = result?;
            let shard_id = shard_idx as u16;
            let shard_path_owned = self.shards[shard_idx].path().map(|p| p.to_path_buf());

            // Build L1 node segment (if any merged nodes)
            let mut l1_node_seg: Option<NodeSegmentV2> = None;
            let mut l1_node_desc: Option<SegmentDescriptor> = None;
            let mut by_type_idx: Option<InvertedIndex> = None;
            let mut by_file_idx: Option<InvertedIndex> = None;

            if let (Some(bytes), Some(meta)) = (&result.node_segment_bytes, &result.node_meta) {
                let seg_id = manifest_store.next_segment_id();

                let seg = if let Some(shard_path) = &shard_path_owned {
                    let seg_path = shard_path.join(format!("seg_{:06}_nodes.seg", seg_id));
                    std::fs::write(&seg_path, bytes)?;
                    NodeSegmentV2::open(&seg_path)?
                } else {
                    NodeSegmentV2::from_bytes(bytes)?
                };

                let desc = SegmentDescriptor::from_meta(
                    seg_id, SegmentType::Nodes, Some(shard_id), meta.clone(),
                );

                // Build inverted indexes from the L1 segment
                let records: Vec<NodeRecordV2> = seg.iter().collect();
                let built = build_inverted_indexes(&records, shard_id, seg_id)?;
                by_type_idx = Some(InvertedIndex::from_bytes(&built.by_type)?);
                by_file_idx = Some(InvertedIndex::from_bytes(&built.by_file)?);

                // Collect entries for global index
                for (offset, record) in records.iter().enumerate() {
                    global_index_entries.push(IndexEntry::new(
                        record.id, seg_id, offset as u32, shard_id,
                    ));
                }

                l1_node_descs.push(desc.clone());
                total_nodes_merged += meta.record_count;
                l1_node_seg = Some(seg);
                l1_node_desc = Some(desc);
            }

            // Build L1 edge segment (if any merged edges)
            let mut l1_edge_seg: Option<EdgeSegmentV2> = None;
            let mut l1_edge_desc: Option<SegmentDescriptor> = None;
            if let (Some(bytes), Some(meta)) = (&result.edge_segment_bytes, &result.edge_meta) {
                let seg_id = manifest_store.next_segment_id();

                let seg = if let Some(shard_path) = &shard_path_owned {
                    let seg_path = shard_path.join(format!("seg_{:06}_edges.seg", seg_id));
                    std::fs::write(&seg_path, bytes)?;
                    EdgeSegmentV2::open(&seg_path)?
                } else {
                    EdgeSegmentV2::from_bytes(bytes)?
                };

                let desc = SegmentDescriptor::from_meta(
                    seg_id, SegmentType::Edges, Some(shard_id), meta.clone(),
                );

                l1_edge_descs.push(desc.clone());
                total_edges_merged += meta.record_count;
                l1_edge_seg = Some(seg);
                l1_edge_desc = Some(desc);
            }

            // Set L1 segments and indexes on shard
            self.shards[shard_idx].set_l1_segments(
                l1_node_seg, l1_node_desc,
                l1_edge_seg, l1_edge_desc,
            );
            self.shards[shard_idx].set_l1_indexes(by_type_idx, by_file_idx);

            total_tombstones_removed += result.tombstones_removed;
            compacted_shard_ids.insert(shard_id);
            shards_compacted.push(shard_id);
        }

        if compacted_shard_ids.is_empty() {
            return Ok(CompactionResult {
                shards_compacted: Vec::new(),
                nodes_merged: 0,
                edges_merged: 0,
                tombstones_removed: 0,
                duration_ms: start.elapsed().as_millis() as u64,
            });
        }

        // Build global index from all L1 entries (compacted + preserved)
        if !global_index_entries.is_empty() {
            self.global_index = Some(GlobalIndex::build(global_index_entries));
        }

        // Build new manifest: keep L0 segments for non-compacted shards only
        let current = manifest_store.current();
        let remaining_node_segs: Vec<SegmentDescriptor> = current
            .node_segments
            .iter()
            .filter(|d| !compacted_shard_ids.contains(&d.shard_id.unwrap_or(0)))
            .cloned()
            .collect();
        let remaining_edge_segs: Vec<SegmentDescriptor> = current
            .edge_segments
            .iter()
            .filter(|d| !compacted_shard_ids.contains(&d.shard_id.unwrap_or(0)))
            .cloned()
            .collect();

        // Create manifest with remaining L0 segments
        let mut manifest = manifest_store.create_manifest(
            remaining_node_segs,
            remaining_edge_segs,
            None,
        )?;

        // Inject L1 descriptors and compaction info
        manifest.l1_node_segments = l1_node_descs;
        manifest.l1_edge_segments = l1_edge_descs;
        manifest.last_compaction = Some(CompactionInfo {
            manifest_version: manifest.version,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            l0_segments_merged: compacted_shard_ids.len() as u32,
        });

        // Clear tombstones in manifest for compacted shards
        // (tombstones were applied during merge)
        manifest.tombstoned_node_ids.clear();
        manifest.tombstoned_edge_keys.clear();

        manifest_store.commit(manifest)?;

        // Clear L0 segments from compacted shards (after manifest commit)
        for &shard_id in &compacted_shard_ids {
            self.shards[shard_id as usize].clear_l0_after_compaction();
        }

        Ok(CompactionResult {
            shards_compacted,
            nodes_merged: total_nodes_merged,
            edges_merged: total_edges_merged,
            tombstones_removed: total_tombstones_removed,
            duration_ms: start.elapsed().as_millis() as u64,
        })
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

    /// Check if any shard's write buffer exceeds the given limits.
    ///
    /// Used by `GraphEngineV2` to trigger auto-flush after `add_nodes()`.
    /// Returns true if any shard's buffer exceeds node count or byte limits.
    pub fn any_shard_needs_flush(&self, node_limit: usize, byte_limit: usize) -> bool {
        self.shards
            .iter()
            .any(|s| s.write_buffer_exceeds(node_limit, byte_limit))
    }

    /// Total node count across all write buffers (unflushed records only).
    pub fn total_write_buffer_nodes(&self) -> usize {
        self.shards.iter().map(|s| s.write_buffer_size().0).sum()
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
    fn test_upsert_edges_routes_to_source_shard() {
        let mut store = MultiShardStore::ephemeral(4);

        let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        let n2 = make_node("src/b/fn2", "FUNCTION", "fn2", "src/b/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone()]);

        // Edge from n1 -> n2 should land in n1's shard
        let edge = make_edge("src/a/fn1", "src/b/fn2", "CALLS");
        store.upsert_edges(vec![edge.clone()]).unwrap();

        // Query outgoing edges from n1 — should find the edge
        let outgoing = store.get_outgoing_edges(n1.id, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].edge_type, "CALLS");
    }

    #[test]
    fn test_upsert_edges_src_not_found_skips_gracefully() {
        let mut store = MultiShardStore::ephemeral(4);

        // Add a valid node for the second edge
        let n1 = make_node("valid-node", "FUNCTION", "fn1", "src/a.js");
        store.add_nodes(vec![n1.clone()]);

        // Try to add two edges: one with unknown src, one with valid src
        let bad_edge = EdgeRecordV2 {
            src: 999,
            dst: 888,
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        };
        let good_edge = EdgeRecordV2 {
            src: n1.id,
            dst: 888,
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        };

        // Should succeed — bad edges are skipped, good edges stored
        let result = store.upsert_edges(vec![bad_edge, good_edge]);
        assert!(result.is_ok());

        // The good edge should be retrievable
        let edges = store.get_outgoing_edges(n1.id, None);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].dst, 888);
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
        store.upsert_edges(vec![edge]).unwrap();

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
        store.upsert_edges(edges).unwrap();

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

        store.upsert_edges(vec![
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
            store.upsert_edges(vec![
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
    fn test_open_existing_db_preserves_metadata() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let mut manifest_store = ManifestStore::create(&db_path).unwrap();

        let mut n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        n1.metadata = r#"{"line":42,"async":true}"#.to_string();
        let n2 = make_node("lib/b/fn2", "FUNCTION", "fn2", "lib/b/file.js");
        let mut e1 = make_edge("src/a/fn1", "lib/b/fn2", "CALLS");
        e1.metadata = r#"{"computedPropertyVar":"k","origin":"analysis"}"#.to_string();

        {
            let mut store = MultiShardStore::create(&db_path, 4).unwrap();
            store.add_nodes(vec![n1.clone(), n2.clone()]);
            store.upsert_edges(vec![e1.clone()]).unwrap();
            store.flush_all(&mut manifest_store).unwrap();
        }

        let store = MultiShardStore::open(&db_path, &manifest_store).unwrap();
        let loaded_n1 = store.get_node(n1.id).expect("node with metadata not found");
        assert_eq!(loaded_n1.metadata, n1.metadata);

        let outgoing = store.get_outgoing_edges(n1.id, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].metadata, e1.metadata);
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
        single.upsert_edges(edges.clone());
        multi.add_nodes(nodes);
        multi.upsert_edges(edges).unwrap();

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
        store.upsert_edges(vec![
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

    // -- find_edge_keys_by_src_ids Tests (RFD-8 T3.1 Commit 2) -------------------

    #[test]
    fn test_find_edge_keys_by_src_ids_multi_shard() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Create nodes in (likely) different shards via different directories
        let n1 = make_node("src/a/caller", "FUNCTION", "caller", "src/a/file.js");
        let n2 = make_node("lib/b/callee", "FUNCTION", "callee", "lib/b/file.js");
        let n3 = make_node("pkg/c/other", "FUNCTION", "other", "pkg/c/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone(), n3.clone()]);

        // Add edges: n1->n2, n1->n3, n2->n3
        let e1 = make_edge("src/a/caller", "lib/b/callee", "CALLS");
        let e2 = make_edge("src/a/caller", "pkg/c/other", "IMPORTS_FROM");
        let e3 = make_edge("lib/b/callee", "pkg/c/other", "CALLS");
        store.upsert_edges(vec![e1.clone(), e2.clone(), e3.clone()]).unwrap();

        // Flush all shards
        store.flush_all(&mut manifest_store).unwrap();

        // Query for edges where src is n1 (caller)
        let src_ids: HashSet<u128> = [n1.id].into_iter().collect();
        let keys = store.find_edge_keys_by_src_ids(&src_ids);

        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&(e1.src, e1.dst, e1.edge_type.clone())));
        assert!(keys.contains(&(e2.src, e2.dst, e2.edge_type.clone())));
        assert!(!keys.contains(&(e3.src, e3.dst, e3.edge_type.clone())));

        // Query for edges where src is n1 or n2
        let src_ids_both: HashSet<u128> = [n1.id, n2.id].into_iter().collect();
        let keys_both = store.find_edge_keys_by_src_ids(&src_ids_both);

        assert_eq!(keys_both.len(), 3);
        assert!(keys_both.contains(&(e1.src, e1.dst, e1.edge_type.clone())));
        assert!(keys_both.contains(&(e2.src, e2.dst, e2.edge_type.clone())));
        assert!(keys_both.contains(&(e3.src, e3.dst, e3.edge_type.clone())));
    }

    #[test]
    fn test_outgoing_edges_type_filter() {
        let mut store = MultiShardStore::ephemeral(2);

        let n1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let n2 = make_node("b/fn2", "FUNCTION", "fn2", "b/file.js");
        let n3 = make_node("c/fn3", "FUNCTION", "fn3", "c/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone(), n3.clone()]);

        store.upsert_edges(vec![
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

    // -- commit_batch Tests (RFD-8 T3.1 Commit 4) --------------------------------

    fn make_node_with_hash(
        semantic_id: &str,
        node_type: &str,
        name: &str,
        file: &str,
        content_hash: u64,
    ) -> NodeRecordV2 {
        let hash = blake3::hash(semantic_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        NodeRecordV2 {
            semantic_id: semantic_id.to_string(),
            id,
            node_type: node_type.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash,
            metadata: String::new(),
        }
    }

    #[test]
    fn test_commit_batch_basic() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        let n1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let n2 = make_node("a/fn2", "FUNCTION", "fn2", "a/file.js");
        let n3 = make_node("a/cls1", "CLASS", "cls1", "a/file.js");
        let e1 = make_edge("a/fn1", "a/fn2", "CALLS");
        let e2 = make_edge("a/fn1", "a/cls1", "CONTAINS");

        let delta = store.commit_batch(
            vec![n1.clone(), n2.clone(), n3.clone()],
            vec![e1.clone(), e2.clone()],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // All nodes queryable
        assert!(store.node_exists(n1.id));
        assert!(store.node_exists(n2.id));
        assert!(store.node_exists(n3.id));

        // Edges queryable
        let outgoing = store.get_outgoing_edges(n1.id, None);
        assert_eq!(outgoing.len(), 2);

        // Manifest version incremented
        assert!(manifest_store.current().version >= 2);

        // Delta is correct (first commit: 3 added, 0 removed)
        assert_eq!(delta.nodes_added, 3);
        assert_eq!(delta.nodes_removed, 0);
        assert_eq!(delta.manifest_version, manifest_store.current().version);
    }

    #[test]
    fn test_commit_batch_tombstones_old_nodes() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit: file "a/file.js" with nodes A, B, C
        let a = make_node("a/nodeA", "FUNCTION", "nodeA", "a/file.js");
        let b = make_node("a/nodeB", "FUNCTION", "nodeB", "a/file.js");
        let c = make_node("a/nodeC", "FUNCTION", "nodeC", "a/file.js");
        store.commit_batch(
            vec![a.clone(), b.clone(), c.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        assert!(store.node_exists(a.id));
        assert!(store.node_exists(b.id));
        assert!(store.node_exists(c.id));

        // Second commit: same file, but only node A (modified) and D (new)
        let a_modified = make_node("a/nodeA", "FUNCTION", "nodeA_v2", "a/file.js");
        let d = make_node("a/nodeD", "FUNCTION", "nodeD", "a/file.js");
        store.commit_batch(
            vec![a_modified.clone(), d.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // B and C should be gone (tombstoned)
        assert!(!store.node_exists(b.id));
        assert!(!store.node_exists(c.id));
        assert_eq!(store.get_node(b.id), None);
        assert_eq!(store.get_node(c.id), None);

        // A (re-added) and D (new) should be visible
        assert!(store.node_exists(a_modified.id));
        assert!(store.node_exists(d.id));

        // find_nodes for the file should return only A and D
        let file_nodes = store.find_nodes(None, Some("a/file.js"));
        assert_eq!(file_nodes.len(), 2);
        let file_ids: HashSet<u128> = file_nodes.iter().map(|n| n.id).collect();
        assert!(file_ids.contains(&a_modified.id));
        assert!(file_ids.contains(&d.id));
    }

    #[test]
    fn test_commit_batch_tombstones_old_edges() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit: nodes A, B in a/file.js with edge A->B
        let a = make_node("a/fnA", "FUNCTION", "fnA", "a/file.js");
        let b = make_node("a/fnB", "FUNCTION", "fnB", "a/file.js");
        let edge_ab = make_edge("a/fnA", "a/fnB", "CALLS");
        store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![edge_ab.clone()],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        assert_eq!(store.get_outgoing_edges(a.id, None).len(), 1);

        // Second commit: re-commit a/file.js with only node A (no edges)
        let a_v2 = make_node("a/fnA", "FUNCTION", "fnA_v2", "a/file.js");
        store.commit_batch(
            vec![a_v2.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Old edge A->B should be tombstoned
        let outgoing = store.get_outgoing_edges(a_v2.id, None);
        assert_eq!(outgoing.len(), 0);
    }

    #[test]
    fn test_commit_batch_delta_counts() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit: 5 nodes
        let nodes_v1: Vec<NodeRecordV2> = (0..5)
            .map(|i| make_node(
                &format!("a/fn{}", i),
                "FUNCTION",
                &format!("fn{}", i),
                "a/file.js",
            ))
            .collect();
        store.commit_batch(
            nodes_v1.clone(),
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Second commit: 3 nodes (2 same id as before, 1 new)
        let nodes_v2 = vec![
            make_node("a/fn0", "FUNCTION", "fn0_v2", "a/file.js"), // same id as fn0
            make_node("a/fn1", "FUNCTION", "fn1_v2", "a/file.js"), // same id as fn1
            make_node("a/fnNEW", "FUNCTION", "fnNEW", "a/file.js"), // new
        ];
        let delta = store.commit_batch(
            nodes_v2,
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Old nodes: 5 tombstoned
        assert_eq!(delta.nodes_removed, 5);
        // New nodes: 1 purely new (fnNEW), 2 re-added (fn0, fn1)
        assert_eq!(delta.nodes_added, 1);
    }

    #[test]
    fn test_commit_batch_delta_changed_types() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit: FUNCTION nodes
        let n1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        store.commit_batch(
            vec![n1.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Second commit: CLASS nodes (replacing FUNCTION)
        let n2 = make_node("a/cls1", "CLASS", "cls1", "a/file.js");
        let delta = store.commit_batch(
            vec![n2.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // changed_node_types should contain both FUNCTION (tombstoned) and CLASS (new)
        assert!(delta.changed_node_types.contains("FUNCTION"));
        assert!(delta.changed_node_types.contains("CLASS"));
    }

    #[test]
    fn test_commit_batch_modified_detection() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit: node A with content_hash=100
        let a_v1 = make_node_with_hash("a/fn1", "FUNCTION", "fn1", "a/file.js", 100);
        store.commit_batch(
            vec![a_v1.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Second commit: same id, different content_hash=200
        let a_v2 = make_node_with_hash("a/fn1", "FUNCTION", "fn1_v2", "a/file.js", 200);
        let delta = store.commit_batch(
            vec![a_v2.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        assert_eq!(delta.nodes_modified, 1);
    }

    #[test]
    fn test_commit_batch_content_hash_zero_skip() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit: node with content_hash=0
        let a_v1 = make_node_with_hash("a/fn1", "FUNCTION", "fn1", "a/file.js", 0);
        store.commit_batch(
            vec![a_v1.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Second commit: same id, also content_hash=0
        let a_v2 = make_node_with_hash("a/fn1", "FUNCTION", "fn1_v2", "a/file.js", 0);
        let delta = store.commit_batch(
            vec![a_v2.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Should NOT count as modified (both hashes are 0 => skip)
        assert_eq!(delta.nodes_modified, 0);
    }

    #[test]
    fn test_commit_batch_multi_file() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit: nodes in two files
        let a1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let b1 = make_node("b/fn1", "FUNCTION", "fn1", "b/file.js");
        store.commit_batch(
            vec![a1.clone(), b1.clone()],
            vec![],
            &["a/file.js".to_string(), "b/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        assert!(store.node_exists(a1.id));
        assert!(store.node_exists(b1.id));

        // Second commit: both files re-analyzed with new nodes
        let a2 = make_node("a/fn2", "FUNCTION", "fn2", "a/file.js");
        let b2 = make_node("b/fn2", "FUNCTION", "fn2", "b/file.js");
        let delta = store.commit_batch(
            vec![a2.clone(), b2.clone()],
            vec![],
            &["a/file.js".to_string(), "b/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Old nodes tombstoned
        assert!(!store.node_exists(a1.id));
        assert!(!store.node_exists(b1.id));

        // New nodes visible
        assert!(store.node_exists(a2.id));
        assert!(store.node_exists(b2.id));

        // Delta: 2 removed (old), 2 added (new)
        assert_eq!(delta.nodes_removed, 2);
        assert_eq!(delta.nodes_added, 2);
    }

    #[test]
    fn test_commit_batch_enrichment_convention() {
        use crate::storage_v2::types::enrichment_file_context;

        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        let enrichment_file = enrichment_file_context("data-flow", "src/a.js");

        // Commit enrichment data
        let enr1 = make_node("enr/df1", "DATAFLOW_EDGE", "df1", &enrichment_file);
        let enr2 = make_node("enr/df2", "DATAFLOW_EDGE", "df2", &enrichment_file);
        store.commit_batch(
            vec![enr1.clone(), enr2.clone()],
            vec![],
            &[enrichment_file.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        assert!(store.node_exists(enr1.id));
        assert!(store.node_exists(enr2.id));

        // Re-commit enrichment with new data (old should be tombstoned)
        let enr3 = make_node("enr/df3", "DATAFLOW_EDGE", "df3", &enrichment_file);
        store.commit_batch(
            vec![enr3.clone()],
            vec![],
            &[enrichment_file.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Old enrichment nodes gone
        assert!(!store.node_exists(enr1.id));
        assert!(!store.node_exists(enr2.id));

        // New enrichment node visible
        assert!(store.node_exists(enr3.id));
    }

    #[test]
    fn test_commit_batch_manifest_has_tombstones() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit
        let a = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let b = make_node("a/fn2", "FUNCTION", "fn2", "a/file.js");
        let edge = make_edge("a/fn1", "a/fn2", "CALLS");
        store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![edge.clone()],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Second commit (replaces a/file.js)
        let c = make_node("a/fn3", "FUNCTION", "fn3", "a/file.js");
        store.commit_batch(
            vec![c.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Manifest should contain tombstones for old nodes
        let manifest = manifest_store.current();
        let tomb_nodes: HashSet<u128> =
            manifest.tombstoned_node_ids.iter().copied().collect();
        assert!(tomb_nodes.contains(&a.id));
        assert!(tomb_nodes.contains(&b.id));

        // Manifest should contain tombstones for old edges
        assert!(
            !manifest.tombstoned_edge_keys.is_empty(),
            "Expected tombstoned edge keys in manifest"
        );
        let tomb_edges: HashSet<(u128, u128, String)> =
            manifest.tombstoned_edge_keys.iter().cloned().collect();
        assert!(tomb_edges.contains(&(edge.src, edge.dst, edge.edge_type.clone())));
    }

    // -- Validation + Integration Tests (RFD-8 T3.1 Commit 5) --------------------

    #[test]
    fn test_commit_batch_idempotent() {
        // Re-committing the same file with identical nodes should produce
        // no modifications and leave the graph in the same state.
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        let a = make_node_with_hash("a/fnA", "FUNCTION", "fnA", "a/file.js", 100);
        let b = make_node_with_hash("a/fnB", "FUNCTION", "fnB", "a/file.js", 200);

        // First commit
        let delta1 = store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        assert_eq!(delta1.nodes_added, 2);
        assert_eq!(delta1.nodes_removed, 0);

        // Snapshot graph state before idempotent re-commit
        assert!(store.node_exists(a.id));
        assert!(store.node_exists(b.id));
        assert_eq!(store.node_count(), 2);

        // Re-commit SAME file with SAME nodes (same content_hash)
        let delta2 = store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // nodes_modified == 0 because content_hash is identical
        assert_eq!(delta2.nodes_modified, 0);

        // Tombstone-then-add: both nodes_removed and the re-add count reflect churn
        // (nodes_removed == 2 from tombstoning old, nodes_added == 0 because same IDs re-added)
        // The important assertion: graph state is logically identical
        assert!(store.node_exists(a.id));
        assert!(store.node_exists(b.id));

        // Note: node_count() is PHYSICAL count (includes old segments), not logical.
        // Use find_nodes to verify the LOGICAL count of visible nodes.
        let visible = store.find_nodes(None, Some("a/file.js"));
        assert_eq!(visible.len(), 2, "Logical visible node count should be 2");

        // Verify data integrity: the nodes are still retrievable with correct values
        let got_a = store.get_node(a.id).unwrap();
        assert_eq!(got_a.content_hash, 100);
        let got_b = store.get_node(b.id).unwrap();
        assert_eq!(got_b.content_hash, 200);
    }

    #[test]
    fn test_commit_batch_atomicity() {
        // All 10 nodes in a single commit_batch must be visible after commit.
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        let nodes: Vec<NodeRecordV2> = (0..10)
            .map(|i| make_node(
                &format!("a/fn{}", i),
                "FUNCTION",
                &format!("fn{}", i),
                "a/file.js",
            ))
            .collect();

        let ids: Vec<u128> = nodes.iter().map(|n| n.id).collect();

        let delta = store.commit_batch(
            nodes,
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        assert_eq!(delta.nodes_added, 10);

        // All 10 must be queryable — no partial commit
        for (i, id) in ids.iter().enumerate() {
            assert!(
                store.node_exists(*id),
                "Node {} (fn{}) not found after atomic commit",
                id,
                i,
            );
            assert!(
                store.get_node(*id).is_some(),
                "get_node failed for fn{}",
                i,
            );
        }

        assert_eq!(store.node_count(), 10);
    }

    #[test]
    fn test_commit_batch_tombstone_accumulation() {
        // Tombstones accumulate across commits: re-committing file A
        // does not affect file B, and manifest contains tombstones from
        // all previous commits.
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Commit 1: "a/file.js" with nodes A, B
        let a = make_node("a/nodeA", "FUNCTION", "nodeA", "a/file.js");
        let b = make_node("a/nodeB", "FUNCTION", "nodeB", "a/file.js");
        store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Commit 2: "b/file.js" with nodes C, D (independent file)
        let c = make_node("b/nodeC", "FUNCTION", "nodeC", "b/file.js");
        let d = make_node("b/nodeD", "FUNCTION", "nodeD", "b/file.js");
        store.commit_batch(
            vec![c.clone(), d.clone()],
            vec![],
            &["b/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Commit 3: Re-commit "a/file.js" with node E (replaces A, B)
        let e = make_node("a/nodeE", "FUNCTION", "nodeE", "a/file.js");
        store.commit_batch(
            vec![e.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Manifest should contain tombstones for A and B
        let manifest = manifest_store.current();
        let tomb_nodes: HashSet<u128> =
            manifest.tombstoned_node_ids.iter().copied().collect();
        assert!(
            tomb_nodes.contains(&a.id),
            "Tombstone for node A missing from manifest"
        );
        assert!(
            tomb_nodes.contains(&b.id),
            "Tombstone for node B missing from manifest"
        );

        // Nodes C, D (from file b) should NOT be tombstoned
        assert!(
            !tomb_nodes.contains(&c.id),
            "Node C should not be tombstoned"
        );
        assert!(
            !tomb_nodes.contains(&d.id),
            "Node D should not be tombstoned"
        );

        // C, D still queryable
        assert!(store.node_exists(c.id));
        assert!(store.node_exists(d.id));

        // E is queryable
        assert!(store.node_exists(e.id));

        // A, B are gone
        assert!(!store.node_exists(a.id));
        assert!(!store.node_exists(b.id));
    }

    #[test]
    fn test_commit_batch_then_query_consistent() {
        // After re-commit, ALL query methods must return consistent results:
        // no stale data from old commit visible via any API.
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // First commit: nodes X, Y with edges X->Y and external node Z with edge Z->X
        let x = make_node("a/fnX", "FUNCTION", "fnX", "a/file.js");
        let y = make_node("a/fnY", "FUNCTION", "fnY", "a/file.js");
        let z = make_node("b/fnZ", "FUNCTION", "fnZ", "b/file.js");
        store.commit_batch(
            vec![x.clone(), y.clone(), z.clone()],
            vec![
                make_edge("a/fnX", "a/fnY", "CALLS"),
                make_edge("b/fnZ", "a/fnX", "IMPORTS_FROM"),
            ],
            &["a/file.js".to_string(), "b/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Verify initial state
        assert_eq!(store.get_outgoing_edges(x.id, None).len(), 1);
        assert_eq!(store.get_incoming_edges(x.id, None).len(), 1);

        // Re-commit: replace all with new nodes P, Q and edge P->Q
        let p = make_node("a/fnP", "FUNCTION", "fnP", "a/file.js");
        let q = make_node("b/fnQ", "FUNCTION", "fnQ", "b/file.js");
        store.commit_batch(
            vec![p.clone(), q.clone()],
            vec![make_edge("a/fnP", "b/fnQ", "CALLS")],
            &["a/file.js".to_string(), "b/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // get_node: old nodes gone, new nodes present
        assert!(store.get_node(x.id).is_none(), "Stale node X visible via get_node");
        assert!(store.get_node(y.id).is_none(), "Stale node Y visible via get_node");
        assert!(store.get_node(z.id).is_none(), "Stale node Z visible via get_node");
        assert!(store.get_node(p.id).is_some(), "New node P not visible via get_node");
        assert!(store.get_node(q.id).is_some(), "New node Q not visible via get_node");

        // find_nodes: only new nodes for these files
        let file_a_nodes = store.find_nodes(None, Some("a/file.js"));
        assert_eq!(file_a_nodes.len(), 1);
        assert_eq!(file_a_nodes[0].id, p.id);

        let file_b_nodes = store.find_nodes(None, Some("b/file.js"));
        assert_eq!(file_b_nodes.len(), 1);
        assert_eq!(file_b_nodes[0].id, q.id);

        // get_outgoing_edges: P->Q exists, old X->Y gone
        let p_outgoing = store.get_outgoing_edges(p.id, None);
        assert_eq!(p_outgoing.len(), 1);
        assert_eq!(p_outgoing[0].dst, q.id);

        let x_outgoing = store.get_outgoing_edges(x.id, None);
        assert_eq!(x_outgoing.len(), 0, "Stale edge X->Y visible via get_outgoing_edges");

        // get_incoming_edges: Q has incoming from P, old X has no incoming
        let q_incoming = store.get_incoming_edges(q.id, None);
        assert_eq!(q_incoming.len(), 1);
        assert_eq!(q_incoming[0].src, p.id);

        let x_incoming = store.get_incoming_edges(x.id, None);
        assert_eq!(x_incoming.len(), 0, "Stale edge Z->X visible via get_incoming_edges");
    }

    #[test]
    fn test_commit_batch_existing_api_unchanged() {
        // Old API (add_nodes + upsert_edges + flush_all) must still work
        // exactly as before — backward compatibility with pre-commit_batch code.
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Use ONLY the old API: add_nodes, upsert_edges, flush_all
        let n1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let n2 = make_node("b/fn2", "FUNCTION", "fn2", "b/file.js");
        let n3 = make_node("c/fn3", "CLASS", "cls1", "c/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone(), n3.clone()]);

        let e1 = make_edge("a/fn1", "b/fn2", "CALLS");
        let e2 = make_edge("b/fn2", "c/fn3", "IMPORTS_FROM");
        store.upsert_edges(vec![e1.clone(), e2.clone()]).unwrap();

        let flushed = store.flush_all(&mut manifest_store).unwrap();
        assert!(flushed > 0, "flush_all should have flushed at least 1 shard");

        // All nodes queryable via get_node
        assert!(store.get_node(n1.id).is_some());
        assert!(store.get_node(n2.id).is_some());
        assert!(store.get_node(n3.id).is_some());

        // node_exists works
        assert!(store.node_exists(n1.id));
        assert!(store.node_exists(n2.id));
        assert!(store.node_exists(n3.id));

        // find_nodes works
        let functions = store.find_nodes(Some("FUNCTION"), None);
        assert_eq!(functions.len(), 2);
        let classes = store.find_nodes(Some("CLASS"), None);
        assert_eq!(classes.len(), 1);

        // Edge queries work
        let outgoing_n1 = store.get_outgoing_edges(n1.id, None);
        assert_eq!(outgoing_n1.len(), 1);
        assert_eq!(outgoing_n1[0].edge_type, "CALLS");

        let outgoing_n2 = store.get_outgoing_edges(n2.id, None);
        assert_eq!(outgoing_n2.len(), 1);
        assert_eq!(outgoing_n2[0].edge_type, "IMPORTS_FROM");

        let incoming_n2 = store.get_incoming_edges(n2.id, None);
        assert_eq!(incoming_n2.len(), 1);
        assert_eq!(incoming_n2[0].src, n1.id);

        let incoming_n3 = store.get_incoming_edges(n3.id, None);
        assert_eq!(incoming_n3.len(), 1);
        assert_eq!(incoming_n3[0].src, n2.id);

        // Counts correct
        assert_eq!(store.node_count(), 3);
        assert_eq!(store.edge_count(), 2);

        // Manifest committed
        assert!(manifest_store.current().version >= 2);

        // No tombstones in manifest (old API doesn't produce them)
        let manifest = manifest_store.current();
        assert!(
            manifest.tombstoned_node_ids.is_empty(),
            "Old API should not produce tombstones"
        );
        assert!(
            manifest.tombstoned_edge_keys.is_empty(),
            "Old API should not produce edge tombstones"
        );
    }

    // -- Compaction Index Integration Tests ------------------------------------

    #[test]
    fn test_compact_builds_indexes() {
        // Setup: ephemeral store with 1 shard, add enough data to trigger compaction
        let mut store = MultiShardStore::ephemeral(1);
        let config = CompactionConfig { segment_threshold: 4 };

        let n1 = make_node("fn_a", "FUNCTION", "a", "src/lib.rs");
        let n2 = make_node("fn_b", "FUNCTION", "b", "src/lib.rs");
        let n3 = make_node("cls_c", "CLASS", "c", "src/main.rs");

        // Create 4 L0 segments to trigger compaction
        store.add_nodes(vec![n1.clone()]);
        store.shards[0].flush_with_ids(Some(1), None).unwrap();

        store.add_nodes(vec![n2.clone()]);
        store.shards[0].flush_with_ids(Some(2), None).unwrap();

        store.add_nodes(vec![n3.clone()]);
        store.shards[0].flush_with_ids(Some(3), None).unwrap();

        // 4th flush to hit threshold
        let n4 = make_node("fn_d", "FUNCTION", "d", "src/lib.rs");
        store.add_nodes(vec![n4.clone()]);
        store.shards[0].flush_with_ids(Some(4), None).unwrap();

        assert_eq!(store.shards[0].l0_node_segment_count(), 4);

        // Create a dummy manifest store for compact
        let tmp = tempfile::tempdir().unwrap();
        let mut manifest_store = ManifestStore::create(tmp.path()).unwrap();

        let result = store.compact(&mut manifest_store, &config).unwrap();
        assert_eq!(result.shards_compacted, vec![0]);
        assert_eq!(result.nodes_merged, 4);

        // Verify shard has L1 segment
        assert!(store.shards[0].l1_node_segment().is_some());

        // Verify inverted indexes were built
        let by_type_idx = store.shards[0].l1_by_type_index();
        assert!(by_type_idx.is_some(), "by_type index should exist after compaction");
        let by_type = by_type_idx.unwrap();
        assert_eq!(by_type.lookup("FUNCTION").len(), 3); // fn_a, fn_b, fn_d
        assert_eq!(by_type.lookup("CLASS").len(), 1);     // cls_c

        let by_file_idx = store.shards[0].l1_by_file_index();
        assert!(by_file_idx.is_some(), "by_file index should exist after compaction");
        let by_file = by_file_idx.unwrap();
        assert_eq!(by_file.lookup("src/lib.rs").len(), 3);  // fn_a, fn_b, fn_d
        assert_eq!(by_file.lookup("src/main.rs").len(), 1); // cls_c

        // Verify global index was built
        assert!(store.global_index.is_some(), "global index should exist after compaction");
        let global = store.global_index.as_ref().unwrap();
        assert_eq!(global.len(), 4);
        assert!(global.lookup(n1.id).is_some());
        assert!(global.lookup(n2.id).is_some());
        assert!(global.lookup(n3.id).is_some());
        assert!(global.lookup(n4.id).is_some());
    }

    #[test]
    fn test_find_nodes_uses_index() {
        // Setup: compact, then find_nodes should return correct results
        // via the inverted index path
        let mut store = MultiShardStore::ephemeral(1);
        let config = CompactionConfig { segment_threshold: 4 };

        let nodes = vec![
            make_node("fn_1", "FUNCTION", "one", "src/a.rs"),
            make_node("fn_2", "FUNCTION", "two", "src/a.rs"),
            make_node("cls_3", "CLASS", "three", "src/b.rs"),
            make_node("met_4", "METHOD", "four", "src/a.rs"),
        ];

        // Add nodes across 4 flushes to trigger compaction
        for (i, node) in nodes.iter().enumerate() {
            store.add_nodes(vec![node.clone()]);
            store.shards[0].flush_with_ids(Some(i as u64 + 1), None).unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let mut manifest_store = ManifestStore::create(tmp.path()).unwrap();
        store.compact(&mut manifest_store, &config).unwrap();

        // After compaction, all data is in L1 with indexes
        assert!(store.shards[0].l1_by_type_index().is_some());

        // find_nodes by node_type should use inverted index
        let funcs = store.find_nodes(Some("FUNCTION"), None);
        assert_eq!(funcs.len(), 2);
        let func_ids: HashSet<u128> = funcs.iter().map(|n| n.id).collect();
        assert!(func_ids.contains(&nodes[0].id));
        assert!(func_ids.contains(&nodes[1].id));

        let classes = store.find_nodes(Some("CLASS"), None);
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].id, nodes[2].id);

        let methods = store.find_nodes(Some("METHOD"), None);
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].id, nodes[3].id);

        // find_nodes by file should use inverted index
        let a_nodes = store.find_nodes(None, Some("src/a.rs"));
        assert_eq!(a_nodes.len(), 3); // fn_1, fn_2, met_4

        let b_nodes = store.find_nodes(None, Some("src/b.rs"));
        assert_eq!(b_nodes.len(), 1);
        assert_eq!(b_nodes[0].id, nodes[2].id);

        // Combined filter: node_type + file
        let funcs_in_a = store.find_nodes(Some("FUNCTION"), Some("src/a.rs"));
        assert_eq!(funcs_in_a.len(), 2);

        let funcs_in_b = store.find_nodes(Some("FUNCTION"), Some("src/b.rs"));
        assert_eq!(funcs_in_b.len(), 0);

        // Missing type returns empty
        let none = store.find_nodes(Some("NONEXISTENT"), None);
        assert!(none.is_empty());

        // get_node via global index
        let got = store.get_node(nodes[0].id);
        assert!(got.is_some());
        assert_eq!(got.unwrap().name, "one");

        // get_node for missing ID
        assert!(store.get_node(999).is_none());
    }

    #[test]
    fn test_global_index_point_lookup_after_compact() {
        let mut store = MultiShardStore::ephemeral(2);
        let config = CompactionConfig { segment_threshold: 4 };

        // Add nodes to different shards (files in different dirs)
        let _n1 = make_node("fn_a", "FUNCTION", "a", "src/a.rs");
        let _n2 = make_node("fn_b", "FUNCTION", "b", "lib/b.rs");

        // Create 4 L0 segments per shard to trigger compaction
        for i in 0..4 {
            store.add_nodes(vec![
                make_node(&format!("fn_{}_a", i), "FUNCTION", "x", "src/a.rs"),
                make_node(&format!("fn_{}_b", i), "FUNCTION", "x", "lib/b.rs"),
            ]);
            // Flush all shards
            for shard_idx in 0..2 {
                let (wb_n, _) = store.shards[shard_idx].write_buffer_size();
                if wb_n > 0 {
                    store.shards[shard_idx]
                        .flush_with_ids(Some(i as u64 * 10 + shard_idx as u64 + 1), None)
                        .unwrap();
                }
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        let mut manifest_store = ManifestStore::create(tmp.path()).unwrap();
        let result = store.compact(&mut manifest_store, &config).unwrap();

        // At least some shards should have been compacted
        assert!(!result.shards_compacted.is_empty());

        // Global index should exist
        assert!(store.global_index.is_some());
        let global = store.global_index.as_ref().unwrap();
        assert!(global.len() > 0);

        // Every node should be findable via global index
        for i in 0..4 {
            let id_a = node_id(&format!("fn_{}_a", i));
            let id_b = node_id(&format!("fn_{}_b", i));
            assert!(
                global.lookup(id_a).is_some(),
                "global index should contain fn_{}_a", i
            );
            assert!(
                global.lookup(id_b).is_some(),
                "global index should contain fn_{}_b", i
            );
        }
    }

    // -- RFD-15: Enrichment Virtual Shards Tests ----------------------------------

    fn make_enrichment_edge(
        src_semantic: &str,
        dst_semantic: &str,
        edge_type: &str,
        file_context: &str,
    ) -> EdgeRecordV2 {
        use crate::storage_v2::types::enrichment_edge_metadata;
        let src = node_id(src_semantic);
        let dst = node_id(dst_semantic);
        EdgeRecordV2 {
            src,
            dst,
            edge_type: edge_type.to_string(),
            metadata: enrichment_edge_metadata(file_context, ""),
        }
    }

    #[test]
    fn test_upsert_edges_enrichment_routes_to_enrichment_shard() {
        use crate::storage_v2::types::enrichment_file_context;

        let mut store = MultiShardStore::ephemeral(4);

        // Create a node in file "src/a.js"
        let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        let n2 = make_node("src/b/fn2", "FUNCTION", "fn2", "src/b/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone()]);

        let file_context = enrichment_file_context("data-flow", "src/a/file.js");

        // Create an enrichment edge with file_context
        let enr_edge = make_enrichment_edge(
            "src/a/fn1",
            "src/b/fn2",
            "FLOWS_INTO",
            &file_context,
        );
        store.upsert_edges(vec![enr_edge.clone()]).unwrap();

        // The enrichment edge should be routed by file_context, not by
        // source node's shard. Verify it's queryable.
        let outgoing = store.get_outgoing_edges(n1.id, None);
        assert!(
            outgoing.iter().any(|e| e.edge_type == "FLOWS_INTO"),
            "Enrichment edge should be queryable via get_outgoing_edges"
        );

        // The enrichment_edge_to_shard index should be populated
        let enrichment_shard_id = store.planner.compute_shard_id(&file_context);
        let source_shard_id = *store.node_to_shard.get(&n1.id).unwrap();

        // Verify the edge was routed to the enrichment shard (which may or
        // may not differ from the source shard depending on hash distribution).
        // What we CAN verify: the enrichment_edge_to_shard index has the entry.
        let enrichment_shards = store.enrichment_edge_to_shard.get(&n1.id).unwrap();
        assert!(
            enrichment_shards.contains(&enrichment_shard_id),
            "enrichment_edge_to_shard should map src to enrichment shard ({}), got {:?}",
            enrichment_shard_id,
            enrichment_shards,
        );

        // If enrichment shard differs from source shard, the edge should
        // NOT be in the source shard's write buffer.
        if enrichment_shard_id != source_shard_id {
            let source_only = store.shards[source_shard_id as usize]
                .get_outgoing_edges(n1.id, Some(&["FLOWS_INTO"]));
            assert!(
                source_only.is_empty(),
                "Enrichment edge should NOT be in source node's shard"
            );
        }
    }

    #[test]
    fn test_upsert_edges_normal_still_routes_to_source_shard() {
        let mut store = MultiShardStore::ephemeral(4);

        let n1 = make_node("src/a/fn1", "FUNCTION", "fn1", "src/a/file.js");
        let n2 = make_node("src/b/fn2", "FUNCTION", "fn2", "src/b/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone()]);

        // Normal edge (no file_context metadata)
        let normal_edge = make_edge("src/a/fn1", "src/b/fn2", "CALLS");
        store.upsert_edges(vec![normal_edge.clone()]).unwrap();

        // Verify the edge is in the source node's shard
        let source_shard_id = *store.node_to_shard.get(&n1.id).unwrap();
        let from_source = store.shards[source_shard_id as usize]
            .get_outgoing_edges(n1.id, Some(&["CALLS"]));
        assert_eq!(from_source.len(), 1);
        assert_eq!(from_source[0].edge_type, "CALLS");

        // enrichment_edge_to_shard should NOT have an entry for this node
        // (no enrichment edges added)
        assert!(
            store.enrichment_edge_to_shard.get(&n1.id).is_none(),
            "Normal edges should not create enrichment_edge_to_shard entries"
        );
    }

    #[test]
    fn test_get_outgoing_edges_includes_enrichment() {
        use crate::storage_v2::types::enrichment_file_context;

        let mut store = MultiShardStore::ephemeral(4);

        let n_a = make_node("src/a/fn_a", "FUNCTION", "fn_a", "src/a/file.js");
        let n_b = make_node("src/b/fn_b", "FUNCTION", "fn_b", "src/b/file.js");
        store.add_nodes(vec![n_a.clone(), n_b.clone()]);

        // Add normal edge A->B
        let normal_edge = make_edge("src/a/fn_a", "src/b/fn_b", "CALLS");
        store.upsert_edges(vec![normal_edge]).unwrap();

        // Add enrichment edge A->B with different edge_type and file_context
        let file_context = enrichment_file_context("data-flow", "src/a/file.js");
        let enr_edge = make_enrichment_edge(
            "src/a/fn_a",
            "src/b/fn_b",
            "FLOWS_INTO",
            &file_context,
        );
        store.upsert_edges(vec![enr_edge]).unwrap();

        // get_outgoing_edges(A) should return BOTH edges
        let outgoing = store.get_outgoing_edges(n_a.id, None);
        assert_eq!(
            outgoing.len(),
            2,
            "Should return both normal and enrichment edges, got {}",
            outgoing.len()
        );

        let edge_types: HashSet<&str> = outgoing.iter().map(|e| e.edge_type.as_str()).collect();
        assert!(edge_types.contains("CALLS"), "Should include normal CALLS edge");
        assert!(edge_types.contains("FLOWS_INTO"), "Should include enrichment FLOWS_INTO edge");
    }

    #[test]
    fn test_get_outgoing_edges_enrichment_only() {
        use crate::storage_v2::types::enrichment_file_context;

        let mut store = MultiShardStore::ephemeral(4);

        let n_a = make_node("src/a/fn_a", "FUNCTION", "fn_a", "src/a/file.js");
        let n_b = make_node("src/b/fn_b", "FUNCTION", "fn_b", "src/b/file.js");
        store.add_nodes(vec![n_a.clone(), n_b.clone()]);

        // Add ONLY enrichment edge (no normal outgoing edges from A)
        let file_context = enrichment_file_context("data-flow", "src/a/file.js");
        let enr_edge = make_enrichment_edge(
            "src/a/fn_a",
            "src/b/fn_b",
            "FLOWS_INTO",
            &file_context,
        );
        store.upsert_edges(vec![enr_edge]).unwrap();

        // Should still find the enrichment edge via get_outgoing_edges
        let outgoing = store.get_outgoing_edges(n_a.id, None);
        assert_eq!(
            outgoing.len(),
            1,
            "Should find enrichment-only edges via index"
        );
        assert_eq!(outgoing[0].edge_type, "FLOWS_INTO");
    }

    #[test]
    fn test_commit_batch_enrichment_surgical_deletion() {
        use crate::storage_v2::types::enrichment_file_context;

        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Step a: Commit nodes A, B to src/a.js
        let a = make_node("src/a/fn_a", "FUNCTION", "fn_a", "src/a/file.js");
        let b = make_node("src/a/fn_b", "FUNCTION", "fn_b", "src/a/file.js");
        store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![],
            &["src/a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Step b: Commit enrichment edges A->B (FLOWS_INTO) with file_context
        let file_context = enrichment_file_context("data-flow", "src/a/file.js");
        let enr_edge_v1 = make_enrichment_edge(
            "src/a/fn_a",
            "src/a/fn_b",
            "FLOWS_INTO",
            &file_context,
        );
        store.commit_batch(
            vec![],
            vec![enr_edge_v1.clone()],
            &[file_context.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Verify enrichment edge exists
        let outgoing = store.get_outgoing_edges(a.id, Some(&["FLOWS_INTO"]));
        assert_eq!(outgoing.len(), 1, "Enrichment edge should exist after first commit");

        // Step c: Commit NEW enrichment edges A->B (FLOWS_INTO_V2) with same file_context
        let enr_edge_v2 = make_enrichment_edge(
            "src/a/fn_a",
            "src/a/fn_b",
            "FLOWS_INTO_V2",
            &file_context,
        );
        store.commit_batch(
            vec![],
            vec![enr_edge_v2.clone()],
            &[file_context.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Step d: Verify
        // Old FLOWS_INTO edge should be tombstoned
        let old_edges = store.get_outgoing_edges(a.id, Some(&["FLOWS_INTO"]));
        assert_eq!(
            old_edges.len(),
            0,
            "Old FLOWS_INTO edge should be tombstoned"
        );

        // New FLOWS_INTO_V2 edge should exist
        let new_edges = store.get_outgoing_edges(a.id, Some(&["FLOWS_INTO_V2"]));
        assert_eq!(
            new_edges.len(),
            1,
            "New FLOWS_INTO_V2 edge should exist"
        );

        // Nodes A and B should still exist (not tombstoned)
        assert!(store.node_exists(a.id), "Node A should still exist");
        assert!(store.node_exists(b.id), "Node B should still exist");
    }

    #[test]
    fn test_commit_batch_enrichment_preserves_other_enrichers() {
        use crate::storage_v2::types::enrichment_file_context;

        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Step a: Commit nodes A, B to src/a.js
        let a = make_node("src/a/fn_a", "FUNCTION", "fn_a", "src/a/file.js");
        let b = make_node("src/a/fn_b", "FUNCTION", "fn_b", "src/a/file.js");
        store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![],
            &["src/a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Step b: Commit enrichment edges from enricher1
        let ctx1 = enrichment_file_context("enricher1", "src/a/file.js");
        let enr1 = make_enrichment_edge(
            "src/a/fn_a",
            "src/a/fn_b",
            "ENRICHER1_EDGE",
            &ctx1,
        );
        store.commit_batch(
            vec![],
            vec![enr1.clone()],
            &[ctx1.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Step c: Commit enrichment edges from enricher2
        let ctx2 = enrichment_file_context("enricher2", "src/a/file.js");
        let enr2 = make_enrichment_edge(
            "src/a/fn_a",
            "src/a/fn_b",
            "ENRICHER2_EDGE",
            &ctx2,
        );
        store.commit_batch(
            vec![],
            vec![enr2.clone()],
            &[ctx2.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Both enricher edges should exist
        let all_outgoing = store.get_outgoing_edges(a.id, None);
        let edge_types: HashSet<&str> = all_outgoing.iter().map(|e| e.edge_type.as_str()).collect();
        assert!(edge_types.contains("ENRICHER1_EDGE"), "enricher1 edge should exist");
        assert!(edge_types.contains("ENRICHER2_EDGE"), "enricher2 edge should exist");

        // Step d: Re-commit enricher1 with new edges
        let enr1_v2 = make_enrichment_edge(
            "src/a/fn_a",
            "src/a/fn_b",
            "ENRICHER1_EDGE_V2",
            &ctx1,
        );
        store.commit_batch(
            vec![],
            vec![enr1_v2.clone()],
            &[ctx1.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // enricher1's old edge should be gone, new edge should exist
        let outgoing = store.get_outgoing_edges(a.id, None);
        let edge_types: HashSet<&str> = outgoing.iter().map(|e| e.edge_type.as_str()).collect();
        assert!(
            !edge_types.contains("ENRICHER1_EDGE"),
            "enricher1 old edge should be tombstoned"
        );
        assert!(
            edge_types.contains("ENRICHER1_EDGE_V2"),
            "enricher1 new edge should exist"
        );

        // enricher2's edge should be PRESERVED
        assert!(
            edge_types.contains("ENRICHER2_EDGE"),
            "enricher2 edge should be preserved"
        );
    }

    #[test]
    fn test_commit_batch_enrichment_preserves_normal_edges() {
        use crate::storage_v2::types::enrichment_file_context;

        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Step a: Commit nodes A, B with normal edge (CALLS)
        let a = make_node("src/a/fn_a", "FUNCTION", "fn_a", "src/a/file.js");
        let b = make_node("src/a/fn_b", "FUNCTION", "fn_b", "src/a/file.js");
        let normal_edge = make_edge("src/a/fn_a", "src/a/fn_b", "CALLS");
        store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![normal_edge.clone()],
            &["src/a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Step b: Commit enrichment edges with file_context
        let file_context = enrichment_file_context("data-flow", "src/a/file.js");
        let enr_edge = make_enrichment_edge(
            "src/a/fn_a",
            "src/a/fn_b",
            "FLOWS_INTO",
            &file_context,
        );
        store.commit_batch(
            vec![],
            vec![enr_edge.clone()],
            &[file_context.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Both edges exist
        let outgoing = store.get_outgoing_edges(a.id, None);
        let edge_types: HashSet<&str> = outgoing.iter().map(|e| e.edge_type.as_str()).collect();
        assert!(edge_types.contains("CALLS"), "Normal edge should exist");
        assert!(edge_types.contains("FLOWS_INTO"), "Enrichment edge should exist");

        // Step c: Re-commit enrichment with new edges
        let enr_edge_v2 = make_enrichment_edge(
            "src/a/fn_a",
            "src/a/fn_b",
            "FLOWS_INTO_V2",
            &file_context,
        );
        store.commit_batch(
            vec![],
            vec![enr_edge_v2.clone()],
            &[file_context.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Normal CALLS edge should still exist
        let outgoing = store.get_outgoing_edges(a.id, None);
        let edge_types: HashSet<&str> = outgoing.iter().map(|e| e.edge_type.as_str()).collect();
        assert!(
            edge_types.contains("CALLS"),
            "Normal CALLS edge should be preserved after enrichment re-commit"
        );
        assert!(
            edge_types.contains("FLOWS_INTO_V2"),
            "New enrichment edge should exist"
        );
        assert!(
            !edge_types.contains("FLOWS_INTO"),
            "Old enrichment edge should be tombstoned"
        );
    }

    #[test]
    fn test_commit_batch_normal_file_preserves_enrichment_edges() {
        use crate::storage_v2::types::enrichment_file_context;

        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest_store = ManifestStore::ephemeral();

        // Step a: Commit nodes A, B to src/a.js with normal edge A->B
        let a = make_node("src/a/fn_a", "FUNCTION", "fn_a", "src/a/file.js");
        let b = make_node("src/a/fn_b", "FUNCTION", "fn_b", "src/a/file.js");
        let normal_edge = make_edge("src/a/fn_a", "src/a/fn_b", "CALLS");
        store.commit_batch(
            vec![a.clone(), b.clone()],
            vec![normal_edge.clone()],
            &["src/a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Step b: Commit enrichment edges for src/a.js
        let file_context = enrichment_file_context("data-flow", "src/a/file.js");
        let enr_edge = make_enrichment_edge(
            "src/a/fn_a",
            "src/a/fn_b",
            "FLOWS_INTO",
            &file_context,
        );
        store.commit_batch(
            vec![],
            vec![enr_edge.clone()],
            &[file_context.clone()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Both edges exist
        let outgoing = store.get_outgoing_edges(a.id, None);
        assert_eq!(outgoing.len(), 2, "Both normal and enrichment edges should exist");

        // Step c: Re-commit src/a.js (normal file) with same nodes and edge
        let a_v2 = make_node("src/a/fn_a", "FUNCTION", "fn_a", "src/a/file.js");
        let b_v2 = make_node("src/a/fn_b", "FUNCTION", "fn_b", "src/a/file.js");
        let normal_edge_v2 = make_edge("src/a/fn_a", "src/a/fn_b", "CALLS");
        store.commit_batch(
            vec![a_v2.clone(), b_v2.clone()],
            vec![normal_edge_v2.clone()],
            &["src/a/file.js".to_string()],
            HashMap::new(),
            &mut manifest_store,
        ).unwrap();

        // Normal edge should be replaced (old tombstoned, new added)
        let outgoing = store.get_outgoing_edges(a.id, None);
        let edge_types: HashSet<&str> = outgoing.iter().map(|e| e.edge_type.as_str()).collect();
        assert!(
            edge_types.contains("CALLS"),
            "Normal CALLS edge should exist after re-commit"
        );

        // Enrichment edge should be PRESERVED (belongs to enrichment file context)
        assert!(
            edge_types.contains("FLOWS_INTO"),
            "Enrichment FLOWS_INTO edge should be preserved after normal file re-commit"
        );

        // Nodes should still exist
        assert!(store.node_exists(a.id), "Node A should still exist");
        assert!(store.node_exists(b.id), "Node B should still exist");
    }

    // -- Parallel Compaction Tests ------------------------------------------------

    #[test]
    fn test_parallel_compaction_correctness() {
        // Verify parallel compaction (threads=4) produces identical results
        // to sequential compaction (threads=1).
        let config = CompactionConfig { segment_threshold: 2 };

        // Build identical stores for sequential and parallel runs
        let build_store = || {
            let mut store = MultiShardStore::ephemeral(4);
            // Distribute nodes across shards via different directories
            for batch in 0..2 {
                let nodes: Vec<NodeRecordV2> = (0..20)
                    .map(|i| {
                        make_node(
                            &format!("dir_{}/fn_{}_{}", i % 4, i, batch),
                            if i % 3 == 0 { "CLASS" } else { "FUNCTION" },
                            &format!("fn_{}_{}", i, batch),
                            &format!("dir_{}/file.js", i % 4),
                        )
                    })
                    .collect();
                store.add_nodes(nodes);

                // Flush all shards to create L0 segments
                for shard in &mut store.shards {
                    let seg_id = (batch * 4 + 1) as u64;
                    shard.flush_with_ids(Some(seg_id + shard.shard_id().unwrap_or(0) as u64), None).unwrap();
                }
            }
            store
        };

        // Sequential compaction
        let mut store_seq = build_store();
        let tmp_seq = tempfile::tempdir().unwrap();
        let mut manifest_seq = ManifestStore::create(tmp_seq.path()).unwrap();
        let result_seq = store_seq
            .compact_with_threads(&mut manifest_seq, &config, Some(1))
            .unwrap();

        // Parallel compaction
        let mut store_par = build_store();
        let tmp_par = tempfile::tempdir().unwrap();
        let mut manifest_par = ManifestStore::create(tmp_par.path()).unwrap();
        let result_par = store_par
            .compact_with_threads(&mut manifest_par, &config, Some(4))
            .unwrap();

        // Compare results: same number of shards compacted
        assert_eq!(
            result_seq.shards_compacted.len(),
            result_par.shards_compacted.len(),
            "same number of shards compacted"
        );
        assert_eq!(result_seq.nodes_merged, result_par.nodes_merged, "same nodes merged");
        assert_eq!(result_seq.edges_merged, result_par.edges_merged, "same edges merged");

        // Compare node counts per shard in L1 segments
        for i in 0..4 {
            let l1_seq = store_seq.shards[i].l1_node_segment();
            let l1_par = store_par.shards[i].l1_node_segment();

            match (l1_seq, l1_par) {
                (Some(s), Some(p)) => {
                    assert_eq!(
                        s.record_count(),
                        p.record_count(),
                        "shard {i}: same L1 node count"
                    );
                    // Verify same records (sorted by id, so order is deterministic)
                    for j in 0..s.record_count() {
                        assert_eq!(s.get_id(j), p.get_id(j), "shard {i} record {j}: same id");
                    }
                }
                (None, None) => {} // Both empty, OK
                _ => panic!("shard {i}: L1 mismatch (one has segments, other doesn't)"),
            }
        }
    }
}
