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
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{GraphError, Result};
use crate::storage_v2::compaction::{CompactionConfig, CompactionResult};
use crate::storage_v2::index::{build_inverted_indexes, GlobalIndex, IndexEntry, InvertedIndex};
use crate::storage_v2::index::token::{TokenIndex, TokenMatch, tokenize_name, tokenize_text};
use crate::storage_v2::manifest::{ManifestEdit, ManifestStore, SegmentDescriptor};
use crate::storage_v2::read_snapshot::{ReadSnapshot, SegmentCache};
use crate::storage_v2::segment::{self, EdgeSegmentV2, NodeSegmentV2};
use crate::storage_v2::shard::{Shard, ShardDiagnostics, TombstoneSet};
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

/// Backward-compatible alias — old callers that used ShardStats
/// now get the richer ShardDiagnostics struct (superset of old fields).
pub type ShardStats = ShardDiagnostics;

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

    /// File-to-node-IDs index: maps file path to the set of node IDs
    /// in that file. Used by commit_batch Phase 1 for O(batch_size) lookups
    /// instead of O(total_nodes) find_nodes scans.
    file_to_node_ids: HashMap<String, HashSet<u128>>,

    /// Intern pool for edge type strings. Edge types have ~15 distinct values,
    /// so interning saves ~40 bytes per tombstone entry (4M+ entries on large graphs).
    edge_type_intern: HashMap<String, Arc<str>>,

    /// MVCC segment cache (RFD-71 B1): `segment_id -> Arc<opened immutable segment>`.
    /// Decouples version-pinned reads from whether the owning `Shard` still holds
    /// the segment open. Disk-backed only; ephemeral stores resolve via the live
    /// shard. Thread-safe (interior `RwLock`s) so reads stay `&self`.
    segment_cache: SegmentCache,

    /// MVCC B4: `file -> last-committed manifest version` for write-write
    /// conflict detection at the concurrent commit point. Interior-mutable so
    /// `commit_batch_private(&self)` can read it (lock-free build is unaffected)
    /// and update it under the manifest mutex (the single serialized section).
    /// Empty on open; reconstructed lazily as commits flow (a missing entry
    /// means "no committed version has touched this file since open" — which is
    /// conflict-free for any snapshot, the correct conservative default).
    file_last_committed_version: std::sync::Mutex<HashMap<String, u64>>,

    /// MVCC B4: monotonic count of conflict-driven commit retries (every abort
    /// at the commit point increments this). Exposed for diagnostics / the B4
    /// acceptance test; a rising value is a work-distribution alarm.
    commit_conflict_retries: Arc<std::sync::atomic::AtomicU64>,

    /// MVCC B4: live count of commits currently inside the LOCK-FREE build/flush
    /// region (phases 1–7 of `commit_batch_private`) — i.e. NOT holding the
    /// manifest commit-point mutex. Incremented on entry to the lock-free region
    /// and decremented before the phase-8 commit point.
    commit_build_in_flight: Arc<std::sync::atomic::AtomicU64>,
    /// Peak value ever observed for `commit_build_in_flight`. This is the
    /// rigorous parallelism witness: peak > 1 PROVES two commits executed the
    /// no-lock build/flush phase SIMULTANEOUSLY — structurally impossible under
    /// the abandoned 2PL path (which held a global + per-shard lock across the
    /// whole commit, so at most one commit body ran at a time). Distinct from a
    /// probe wrapping the whole call, which 2PL would also trip (3 threads block
    /// on the lock while 1 runs). This counter excludes the serialized region.
    commit_build_peak: Arc<std::sync::atomic::AtomicU64>,
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
            file_to_node_ids: HashMap::new(),
            edge_type_intern: HashMap::new(),
            segment_cache: SegmentCache::new(),
            file_last_committed_version: std::sync::Mutex::new(HashMap::new()),
            commit_conflict_retries: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            commit_build_in_flight: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            commit_build_peak: Arc::new(std::sync::atomic::AtomicU64::new(0)),
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

        // Rebuild node_to_shard and file_to_node_ids from all shards
        let mut node_to_shard = HashMap::new();
        let mut file_to_node_ids: HashMap<String, HashSet<u128>> = HashMap::new();
        for (shard_id, shard) in shards.iter().enumerate() {
            for (node_id, file) in shard.all_node_ids_with_file() {
                node_to_shard.insert(node_id, shard_id as u16);
                file_to_node_ids.entry(file).or_default().insert(node_id);
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
            file_to_node_ids,
            edge_type_intern: HashMap::new(),
            segment_cache: SegmentCache::new(),
            file_last_committed_version: std::sync::Mutex::new(HashMap::new()),
            commit_conflict_retries: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            commit_build_in_flight: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            commit_build_peak: Arc::new(std::sync::atomic::AtomicU64::new(0)),
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
            file_to_node_ids: HashMap::new(),
            edge_type_intern: HashMap::new(),
            segment_cache: SegmentCache::new(),
            file_last_committed_version: std::sync::Mutex::new(HashMap::new()),
            commit_conflict_retries: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            commit_build_in_flight: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            commit_build_peak: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }
}

// ── Edge Type Interning ────────────────────────────────────────────

impl MultiShardStore {
    /// Intern an edge type string. Returns a shared Arc<str> for deduplication.
    ///
    /// Edge types have ~15 distinct values ("CALLS", "IMPORTS_FROM", etc.).
    /// Interning avoids storing millions of individual String allocations
    /// in tombstone sets — each entry shares the same Arc<str>.
    fn intern_edge_type(&mut self, edge_type: &str) -> Arc<str> {
        if let Some(interned) = self.edge_type_intern.get(edge_type) {
            Arc::clone(interned)
        } else {
            let interned: Arc<str> = Arc::from(edge_type);
            self.edge_type_intern.insert(edge_type.to_string(), Arc::clone(&interned));
            interned
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
            self.file_to_node_ids
                .entry(node.file.clone())
                .or_default()
                .insert(node.id);
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
        edge_keys: &HashSet<(u128, u128, Arc<str>)>,
    ) {
        let tombstones = TombstoneSet {
            node_ids: node_ids.clone(),
            edge_keys: edge_keys.clone(),
        };
        let shared = Arc::new(tombstones);
        for shard in &mut self.shards {
            shard.set_tombstones_shared(Arc::clone(&shared));
        }
    }

    /// Check if a node is tombstoned in the per-shard mirror.
    ///
    /// MVCC B3: the version authority is the manifest; this consults the
    /// per-shard mirror, which `commit_batch_ext`/`flush` keep equal to the
    /// current version's cumulative set. All shards share one Arc, so shard 0
    /// is representative.
    ///
    /// MVCC B4 (residual closed): the CONCURRENT commit path
    /// (`commit_batch_private`) reads tombstones from the version snapshot and
    /// NEVER writes this mirror. The mirror is therefore mutated ONLY by the
    /// exclusive `&mut self` paths (`commit_batch_ext` / `flush`, which run under
    /// the server's exclusive `write()` lock) and read ONLY by exclusive-path or
    /// dead callers. No path that runs concurrently with a `commit_batch_private`
    /// either reads or writes it ⇒ no race window remains. (The snapshot authority
    /// is the only tombstone source on the concurrent path.)
    pub fn is_node_tombstoned(&self, id: u128) -> bool {
        if self.shards.is_empty() { return false; }
        self.shards[0].tombstones().contains_node(id)
    }

    /// Check if an edge is tombstoned in the per-shard mirror.
    ///
    /// All shards share the same Arc<TombstoneSet>, so checking shard 0 is sufficient.
    pub fn is_edge_tombstoned(&self, src: u128, dst: u128, edge_type: &str) -> bool {
        if self.shards.is_empty() { return false; }
        self.shards[0].tombstones().contains_edge(src, dst, edge_type)
    }

    /// Count of tombstoned nodes in the shard TombstoneSet.
    pub fn tombstone_node_count(&self) -> usize {
        if self.shards.is_empty() { return 0; }
        self.shards[0].tombstones().node_count()
    }

    /// Count of tombstoned edges in the shard TombstoneSet.
    pub fn tombstone_edge_count(&self) -> usize {
        if self.shards.is_empty() { return 0; }
        self.shards[0].tombstones().edge_count()
    }

    /// Remove edge keys from the shared tombstone set across every shard.
    ///
    /// Used when a previously-deleted edge is re-added (e.g. enricher
    /// rule chains: delete-by-source then re-emit the same `(src, dst,
    /// type)` triple). Without this the upserted edge is silently
    /// shadowed by the stale tombstone.
    ///
    /// Clone-on-write: clones the current tombstone set, removes the
    /// keys, and re-broadcasts a fresh Arc to all shards. Cost is
    /// O(|tombstones|) for the clone — same order as `set_tombstones`,
    /// so consistent with the existing tombstone-mutation cost model.
    pub fn untombstone_edges(&mut self, keys: &[(u128, u128, Arc<str>)]) {
        if self.shards.is_empty() || keys.is_empty() { return; }
        let mut ts: TombstoneSet = (*self.shards[0].tombstones()).clone();
        let before = ts.edge_count();
        ts.remove_edges(keys.iter());
        if ts.edge_count() == before { return; } // no-op, skip rebroadcast
        let shared = Arc::new(ts);
        for shard in &mut self.shards {
            shard.set_tombstones_shared(Arc::clone(&shared));
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

    /// Check if a specific live edge exists (tombstone-aware).
    ///
    /// Mirrors `node_exists` liveness semantics for edges: returns true only
    /// if the `(src, dst, edge_type)` triple resolves to a live (non-tombstoned)
    /// edge in the source node's shard. Used by the engine to determine which
    /// pending (not-yet-flushed) edge tombstones still cover a live edge.
    pub fn edge_exists(&self, src: u128, dst: u128, edge_type: &str) -> bool {
        let types = [edge_type];
        self.get_outgoing_edges(src, Some(&types))
            .iter()
            .any(|e| e.dst == dst && e.edge_type == edge_type)
    }
}

// ── MVCC Snapshot Reads (RFD-71 B1) ────────────────────────────────

impl MultiShardStore {
    /// Capture a version-pinned [`ReadSnapshot`] of the current published
    /// manifest version: its segment descriptor set + that version's cumulative
    /// tombstones (the runtime shard set, since the manifest clears its own).
    ///
    /// The snapshot is immutable; later commits do not affect it. Reads resolved
    /// through it (the `*_at` methods below) never observe the live, uncommitted
    /// `Shard.write_buffer` — only the version's committed, immutable segments.
    pub fn snapshot(&self, manifest: &ManifestStore) -> ReadSnapshot {
        // MVCC B3: tombstones are version state. Take the current published
        // version's cumulative tombstone set from the manifest authority (the
        // derived Arc), NOT from any per-shard broadcast set. Cloning the Arc is
        // O(1) and freezes the version's tombstones immutably into the snapshot.
        let tombstones = manifest.current_tombstones();
        ReadSnapshot::capture(manifest, tombstones)
    }

    /// Resolve a node segment descriptor to an opened segment and run `f`.
    ///
    /// Disk store: open (or hit cache) via [`SegmentCache`]. Ephemeral store:
    /// borrow the live in-memory segment from the owning shard. Returns `None`
    /// (treated as "segment absent / skip") if the segment cannot be resolved.
    fn with_node_segment<R>(
        &self,
        desc: &SegmentDescriptor,
        f: impl FnOnce(&NodeSegmentV2) -> R,
    ) -> Option<R> {
        if let Some(db_path) = &self.db_path {
            match self.segment_cache.get_node_segment(db_path, desc) {
                Ok(seg) => Some(f(&seg)),
                Err(_) => None,
            }
        } else {
            let shard_id = desc.shard_id.unwrap_or(0) as usize;
            self.shards
                .get(shard_id)
                .and_then(|s| s.node_segment_by_id(desc.segment_id))
                .map(f)
        }
    }

    /// Edge-segment companion to [`Self::with_node_segment`].
    fn with_edge_segment<R>(
        &self,
        desc: &SegmentDescriptor,
        f: impl FnOnce(&EdgeSegmentV2) -> R,
    ) -> Option<R> {
        if let Some(db_path) = &self.db_path {
            match self.segment_cache.get_edge_segment(db_path, desc) {
                Ok(seg) => Some(f(&seg)),
                Err(_) => None,
            }
        } else {
            let shard_id = desc.shard_id.unwrap_or(0) as usize;
            self.shards
                .get(shard_id)
                .and_then(|s| s.edge_segment_by_id(desc.segment_id))
                .map(f)
        }
    }

    /// Get a node by id resolved through `snap` (version-pinned).
    ///
    /// Mirrors `Shard::get_node` EXACTLY except it never consults the write
    /// buffer: tombstone-first, then L0 newest→oldest (reverse of the snapshot's
    /// oldest-first descriptor list, with bloom short-circuit), then L1.
    pub fn get_node_at(&self, snap: &ReadSnapshot, id: u128) -> Option<NodeRecordV2> {
        // Step 0: tombstone check (definitive).
        if snap.tombstones.contains_node(id) {
            return None;
        }

        // Step 1: L0 segments newest→oldest. Descriptors are oldest-first, so
        // iterate in reverse; gather this shard-agnostic id across all shards.
        for desc in snap.node_segments.iter().rev() {
            let found = self.with_node_segment(desc, |seg| {
                if !seg.maybe_contains(id) {
                    return None;
                }
                for j in 0..seg.record_count() {
                    if seg.get_id(j) == id {
                        return Some(seg.get_record(j));
                    }
                }
                None
            });
            if let Some(Some(rec)) = found {
                return Some(rec);
            }
        }

        // Step 2: L1 segments (oldest, compacted).
        for desc in &snap.l1_node_segments {
            let found = self.with_node_segment(desc, |seg| {
                if !seg.maybe_contains(id) {
                    return None;
                }
                for j in 0..seg.record_count() {
                    if seg.get_id(j) == id {
                        return Some(seg.get_record(j));
                    }
                }
                None
            });
            if let Some(Some(rec)) = found {
                return Some(rec);
            }
        }

        None
    }

    /// Existence check resolved through `snap`. Mirrors `Shard::node_exists`
    /// minus the write-buffer step.
    pub fn node_exists_at(&self, snap: &ReadSnapshot, id: u128) -> bool {
        if snap.tombstones.contains_node(id) {
            return false;
        }
        for desc in snap.node_segments.iter().rev() {
            let hit = self.with_node_segment(desc, |seg| {
                if !seg.maybe_contains(id) {
                    return false;
                }
                (0..seg.record_count()).any(|j| seg.get_id(j) == id)
            });
            if matches!(hit, Some(true)) {
                return true;
            }
        }
        for desc in &snap.l1_node_segments {
            let hit = self.with_node_segment(desc, |seg| {
                if !seg.maybe_contains(id) {
                    return false;
                }
                (0..seg.record_count()).any(|j| seg.get_id(j) == id)
            });
            if matches!(hit, Some(true)) {
                return true;
            }
        }
        false
    }

    /// Find nodes matching optional `node_type` / `file` filters, resolved
    /// through `snap`. Reproduces `Shard::find_nodes` dedup + tombstone +
    /// zone-map semantics across all shards, minus the write buffer.
    pub fn find_nodes_at(
        &self,
        snap: &ReadSnapshot,
        node_type: Option<&str>,
        file: Option<&str>,
    ) -> Vec<NodeRecordV2> {
        let mut seen: HashSet<u128> = HashSet::new();
        let mut results: Vec<NodeRecordV2> = Vec::new();

        // L0 newest→oldest.
        for desc in snap.node_segments.iter().rev() {
            // Descriptor-level zone-map pruning (no I/O).
            if !desc.may_contain(node_type, file, None) {
                continue;
            }
            self.with_node_segment(desc, |seg| {
                if let Some(nt) = node_type {
                    if !seg.contains_node_type(nt) {
                        return;
                    }
                }
                if let Some(f) = file {
                    if !seg.contains_file(f) {
                        return;
                    }
                }
                for j in 0..seg.record_count() {
                    let id = seg.get_id(j);
                    if seen.contains(&id) {
                        continue;
                    }
                    if snap.tombstones.contains_node(id) {
                        seen.insert(id);
                        continue;
                    }
                    if let Some(nt) = node_type {
                        if seg.get_node_type(j) != nt {
                            continue;
                        }
                    }
                    if let Some(f) = file {
                        if seg.get_file(j) != f {
                            continue;
                        }
                    }
                    seen.insert(id);
                    results.push(seg.get_record(j));
                }
            });
        }

        // L1 (oldest). No inverted-index path here — snapshot reads scan the
        // descriptor's segment directly (indexes live on the live Shard).
        for desc in &snap.l1_node_segments {
            if !desc.may_contain(node_type, file, None) {
                continue;
            }
            self.with_node_segment(desc, |seg| {
                if let Some(nt) = node_type {
                    if !seg.contains_node_type(nt) {
                        return;
                    }
                }
                if let Some(f) = file {
                    if !seg.contains_file(f) {
                        return;
                    }
                }
                for j in 0..seg.record_count() {
                    let id = seg.get_id(j);
                    if seen.contains(&id) {
                        continue;
                    }
                    if snap.tombstones.contains_node(id) {
                        seen.insert(id);
                        continue;
                    }
                    if let Some(nt) = node_type {
                        if seg.get_node_type(j) != nt {
                            continue;
                        }
                    }
                    if let Some(f) = file {
                        if seg.get_file(j) != f {
                            continue;
                        }
                    }
                    seen.insert(id);
                    results.push(seg.get_record(j));
                }
            });
        }

        results
    }

    /// Count of LIVE nodes resolved through `snap`. Reproduces
    /// `Shard::node_count` dedup + tombstone semantics across all shards, minus
    /// the write buffer (full O(records) scan).
    pub fn node_count_at(&self, snap: &ReadSnapshot) -> usize {
        let mut seen: HashSet<u128> = HashSet::new();
        let mut count = 0usize;

        for desc in snap.node_segments.iter().rev() {
            self.with_node_segment(desc, |seg| {
                for j in 0..seg.record_count() {
                    let id = seg.get_id(j);
                    if !seen.insert(id) {
                        continue;
                    }
                    if snap.tombstones.contains_node(id) {
                        continue;
                    }
                    count += 1;
                }
            });
        }
        for desc in &snap.l1_node_segments {
            self.with_node_segment(desc, |seg| {
                for j in 0..seg.record_count() {
                    let id = seg.get_id(j);
                    if !seen.insert(id) {
                        continue;
                    }
                    if snap.tombstones.contains_node(id) {
                        continue;
                    }
                    count += 1;
                }
            });
        }
        count
    }

    /// Per-type live node counts resolved through `snap`. Reproduces
    /// `Shard::count_by_type` minus the write buffer.
    pub fn count_by_type_at(&self, snap: &ReadSnapshot) -> HashMap<String, usize> {
        let mut seen: HashSet<u128> = HashSet::new();
        let mut counts: HashMap<String, usize> = HashMap::new();

        for desc in snap.node_segments.iter().rev() {
            self.with_node_segment(desc, |seg| {
                for j in 0..seg.record_count() {
                    let id = seg.get_id(j);
                    if !seen.insert(id) {
                        continue;
                    }
                    if snap.tombstones.contains_node(id) {
                        continue;
                    }
                    *counts.entry(seg.get_node_type(j).to_string()).or_insert(0) += 1;
                }
            });
        }
        for desc in &snap.l1_node_segments {
            self.with_node_segment(desc, |seg| {
                for j in 0..seg.record_count() {
                    let id = seg.get_id(j);
                    if !seen.insert(id) {
                        continue;
                    }
                    if snap.tombstones.contains_node(id) {
                        continue;
                    }
                    *counts.entry(seg.get_node_type(j).to_string()).or_insert(0) += 1;
                }
            });
        }
        counts
    }

    /// Outgoing edges from `node_id` resolved through `snap`, optionally
    /// filtered by `edge_types`. Mirrors `Shard::get_outgoing_edges` (L0 forward,
    /// then L1; bloom + zone-map short-circuits; dedup by `(src,dst,type)`,
    /// tombstone filter) across all shards, minus the write buffer.
    pub fn get_outgoing_edges_at(
        &self,
        snap: &ReadSnapshot,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2> {
        let mut results: Vec<EdgeRecordV2> = Vec::new();
        let mut seen: HashSet<(u128, u128, String)> = HashSet::new();

        // L0 in descriptor (oldest-first) order, matching the live shard which
        // scans its L0 Vec forward.
        for desc in &snap.edge_segments {
            self.with_edge_segment(desc, |seg| {
                if !seg.maybe_contains_src(node_id) {
                    return;
                }
                if let Some(types) = edge_types {
                    if !types.iter().any(|t| seg.contains_edge_type(t)) {
                        return;
                    }
                }
                for j in 0..seg.record_count() {
                    if seg.get_src(j) != node_id {
                        continue;
                    }
                    let dst = seg.get_dst(j);
                    let et = seg.get_edge_type(j);
                    let key = (node_id, dst, et.to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    if snap.tombstones.contains_edge(node_id, dst, et) {
                        continue;
                    }
                    if let Some(types) = edge_types {
                        if !types.contains(&et) {
                            continue;
                        }
                    }
                    results.push(seg.get_record(j));
                }
            });
        }

        for desc in &snap.l1_edge_segments {
            self.with_edge_segment(desc, |seg| {
                if !seg.maybe_contains_src(node_id) {
                    return;
                }
                if let Some(types) = edge_types {
                    if !types.iter().any(|t| seg.contains_edge_type(t)) {
                        return;
                    }
                }
                for j in 0..seg.record_count() {
                    if seg.get_src(j) != node_id {
                        continue;
                    }
                    let dst = seg.get_dst(j);
                    let et = seg.get_edge_type(j);
                    let key = (node_id, dst, et.to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    if snap.tombstones.contains_edge(node_id, dst, et) {
                        continue;
                    }
                    if let Some(types) = edge_types {
                        if !types.contains(&et) {
                            continue;
                        }
                    }
                    results.push(seg.get_record(j));
                }
            });
        }

        results
    }

    /// Incoming edges to `node_id` resolved through `snap`. Mirrors
    /// `Shard::get_incoming_edges` (bloom on dst) across all shards, minus the
    /// write buffer.
    pub fn get_incoming_edges_at(
        &self,
        snap: &ReadSnapshot,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2> {
        let mut results: Vec<EdgeRecordV2> = Vec::new();
        let mut seen: HashSet<(u128, u128, String)> = HashSet::new();

        for desc in &snap.edge_segments {
            self.with_edge_segment(desc, |seg| {
                if !seg.maybe_contains_dst(node_id) {
                    return;
                }
                if let Some(types) = edge_types {
                    if !types.iter().any(|t| seg.contains_edge_type(t)) {
                        return;
                    }
                }
                for j in 0..seg.record_count() {
                    if seg.get_dst(j) != node_id {
                        continue;
                    }
                    let src = seg.get_src(j);
                    let et = seg.get_edge_type(j);
                    let key = (src, node_id, et.to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    if snap.tombstones.contains_edge(src, node_id, et) {
                        continue;
                    }
                    if let Some(types) = edge_types {
                        if !types.contains(&et) {
                            continue;
                        }
                    }
                    results.push(seg.get_record(j));
                }
            });
        }

        for desc in &snap.l1_edge_segments {
            self.with_edge_segment(desc, |seg| {
                if !seg.maybe_contains_dst(node_id) {
                    return;
                }
                if let Some(types) = edge_types {
                    if !types.iter().any(|t| seg.contains_edge_type(t)) {
                        return;
                    }
                }
                for j in 0..seg.record_count() {
                    if seg.get_dst(j) != node_id {
                        continue;
                    }
                    let src = seg.get_src(j);
                    let et = seg.get_edge_type(j);
                    let key = (src, node_id, et.to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    if snap.tombstones.contains_edge(src, node_id, et) {
                        continue;
                    }
                    if let Some(types) = edge_types {
                        if !types.contains(&et) {
                            continue;
                        }
                    }
                    results.push(seg.get_record(j));
                }
            });
        }

        results
    }

    /// All live edges resolved through `snap`. Mirrors `Shard::iter_all_edges`
    /// (L0 newest→oldest, then L1; dedup by key; tombstone filter) across all
    /// shards, minus the write buffer.
    pub fn iter_all_edges_at(&self, snap: &ReadSnapshot) -> Vec<EdgeRecordV2> {
        let mut results: Vec<EdgeRecordV2> = Vec::new();
        let mut seen: HashSet<(u128, u128, String)> = HashSet::new();

        for desc in snap.edge_segments.iter().rev() {
            self.with_edge_segment(desc, |seg| {
                for j in 0..seg.record_count() {
                    let src = seg.get_src(j);
                    let dst = seg.get_dst(j);
                    let et = seg.get_edge_type(j);
                    let key = (src, dst, et.to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    if snap.tombstones.contains_edge(src, dst, et) {
                        continue;
                    }
                    results.push(seg.get_record(j));
                }
            });
        }
        for desc in &snap.l1_edge_segments {
            self.with_edge_segment(desc, |seg| {
                for j in 0..seg.record_count() {
                    let src = seg.get_src(j);
                    let dst = seg.get_dst(j);
                    let et = seg.get_edge_type(j);
                    let key = (src, dst, et.to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    if snap.tombstones.contains_edge(src, dst, et) {
                        continue;
                    }
                    results.push(seg.get_record(j));
                }
            });
        }
        results
    }

    /// Edges of one `edge_type` resolved through `snap`. Mirrors
    /// `Shard::get_edges_by_type` (L0 newest→oldest, then L1) across all shards,
    /// minus the write buffer.
    pub fn get_edges_by_type_at(&self, snap: &ReadSnapshot, edge_type: &str) -> Vec<EdgeRecordV2> {
        let mut results: Vec<EdgeRecordV2> = Vec::new();
        let mut seen: HashSet<(u128, u128, String)> = HashSet::new();

        for desc in snap.edge_segments.iter().rev() {
            if !desc.edge_types.is_empty() && !desc.edge_types.contains(edge_type) {
                continue;
            }
            self.with_edge_segment(desc, |seg| {
                if !seg.contains_edge_type(edge_type) {
                    return;
                }
                for j in 0..seg.record_count() {
                    let et = seg.get_edge_type(j);
                    if et != edge_type {
                        continue;
                    }
                    let src = seg.get_src(j);
                    let dst = seg.get_dst(j);
                    let key = (src, dst, et.to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    if snap.tombstones.contains_edge(src, dst, et) {
                        continue;
                    }
                    results.push(seg.get_record(j));
                }
            });
        }
        for desc in &snap.l1_edge_segments {
            if !desc.edge_types.is_empty() && !desc.edge_types.contains(edge_type) {
                continue;
            }
            self.with_edge_segment(desc, |seg| {
                if !seg.contains_edge_type(edge_type) {
                    return;
                }
                for j in 0..seg.record_count() {
                    let et = seg.get_edge_type(j);
                    if et != edge_type {
                        continue;
                    }
                    let src = seg.get_src(j);
                    let dst = seg.get_dst(j);
                    let key = (src, dst, et.to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    if snap.tombstones.contains_edge(src, dst, et) {
                        continue;
                    }
                    results.push(seg.get_record(j));
                }
            });
        }
        results
    }

    /// Existence check for a live edge resolved through `snap`. MVCC twin of
    /// [`Self::edge_exists`] — never consults the write buffer.
    pub fn edge_exists_at(
        &self,
        snap: &ReadSnapshot,
        src: u128,
        dst: u128,
        edge_type: &str,
    ) -> bool {
        let types = [edge_type];
        self.get_outgoing_edges_at(snap, src, Some(&types))
            .iter()
            .any(|e| e.dst == dst && e.edge_type == edge_type)
    }

    /// Live edge count resolved through `snap`. MVCC twin of
    /// [`Self::edge_count`]: dedups `(src,dst,type)` across the version's
    /// segments and excludes tombstoned edges, never reading the write buffer.
    pub fn edge_count_at(&self, snap: &ReadSnapshot) -> usize {
        // iter_all_edges_at already dedups by (src,dst,type) and filters
        // tombstones, so its length is the live edge count for the version.
        self.iter_all_edges_at(snap).len()
    }

    /// Node IDs of exact `node_type` resolved through `snap`. MVCC twin of
    /// [`Self::find_node_ids_by_type`], scanning version-pinned segments
    /// (L0 newest→oldest, then L1) instead of the live shard.
    pub fn find_node_ids_by_type_at(&self, snap: &ReadSnapshot, node_type: &str) -> Vec<u128> {
        self.find_node_ids_by_attr_at(
            snap,
            Some(node_type),
            None,
            None,
            None,
            None,
            &[],
            false,
        )
    }

    /// Node IDs matching AttrQuery-compatible filters resolved through `snap`.
    /// MVCC twin of [`Self::find_node_ids_by_attr`]: replicates
    /// `Shard::for_each_matching_id` filter + dedup + tombstone semantics
    /// against the version's segment set, never the write buffer.
    #[allow(clippy::too_many_arguments)]
    pub fn find_node_ids_by_attr_at(
        &self,
        snap: &ReadSnapshot,
        node_type: Option<&str>,
        node_type_prefix: Option<&str>,
        file: Option<&str>,
        name: Option<&str>,
        exported: Option<bool>,
        metadata_filters: &[(String, String)],
        substring_match: bool,
    ) -> Vec<u128> {
        let mut results: Vec<u128> = Vec::new();
        self.find_node_ids_by_attr_chunked_at(
            snap,
            node_type,
            node_type_prefix,
            file,
            name,
            exported,
            metadata_filters,
            substring_match,
            usize::MAX,
            &mut |chunk| {
                results.extend_from_slice(chunk);
                true
            },
        );
        results
    }

    /// Chunked variant of [`Self::find_node_ids_by_attr_at`]. MVCC twin of
    /// [`Self::find_node_ids_by_attr_chunked`].
    #[allow(clippy::too_many_arguments)]
    pub fn find_node_ids_by_attr_chunked_at(
        &self,
        snap: &ReadSnapshot,
        node_type: Option<&str>,
        node_type_prefix: Option<&str>,
        file: Option<&str>,
        name: Option<&str>,
        exported: Option<bool>,
        metadata_filters: &[(String, String)],
        substring_match: bool,
        chunk_size: usize,
        callback: &mut dyn FnMut(&[u128]) -> bool,
    ) {
        let mut seen: HashSet<u128> = HashSet::new();
        let mut buffer: Vec<u128> = Vec::with_capacity(chunk_size.min(65536));
        let mut stopped = false;

        // Substring file matching can't use the exact-path zone map.
        let prune_file = if substring_match { None } else { file };

        // Scan one segment, emitting matching ids into the chunk buffer.
        let mut scan_seg = |seg: &NodeSegmentV2,
                            seen: &mut HashSet<u128>,
                            buffer: &mut Vec<u128>,
                            stopped: &mut bool| {
            for j in 0..seg.record_count() {
                let id = seg.get_id(j);
                if !seen.insert(id) {
                    continue; // newer segment / buffer-equivalent already won
                }
                if snap.tombstones.contains_node(id) {
                    continue;
                }
                if !Shard::matches_attr_filters(
                    seg.get_node_type(j),
                    seg.get_file(j),
                    seg.get_name(j),
                    seg.get_metadata(j),
                    node_type,
                    node_type_prefix,
                    file,
                    name,
                    exported,
                    metadata_filters,
                    substring_match,
                ) {
                    continue;
                }
                buffer.push(id);
                if buffer.len() >= chunk_size {
                    if !callback(buffer) {
                        *stopped = true;
                        return;
                    }
                    buffer.clear();
                }
            }
        };

        // L0 newest→oldest (descriptors are oldest-first ⇒ iterate reversed).
        for desc in snap.node_segments.iter().rev() {
            if stopped {
                break;
            }
            // Descriptor-level zone-map pruning (no I/O).
            if let Some(nt) = node_type {
                if !desc.may_contain(Some(nt), prune_file, None) {
                    continue;
                }
            } else if !desc.may_contain(None, prune_file, None) {
                continue;
            }
            if let Some(prefix) = node_type_prefix {
                if !desc.node_types.is_empty()
                    && !desc.node_types.iter().any(|t| t.starts_with(prefix))
                {
                    continue;
                }
            }
            self.with_node_segment(desc, |seg| {
                scan_seg(seg, &mut seen, &mut buffer, &mut stopped);
            });
        }

        // L1 (oldest, compacted).
        for desc in &snap.l1_node_segments {
            if stopped {
                break;
            }
            if let Some(nt) = node_type {
                if !desc.may_contain(Some(nt), prune_file, None) {
                    continue;
                }
            } else if !desc.may_contain(None, prune_file, None) {
                continue;
            }
            if let Some(prefix) = node_type_prefix {
                if !desc.node_types.is_empty()
                    && !desc.node_types.iter().any(|t| t.starts_with(prefix))
                {
                    continue;
                }
            }
            self.with_node_segment(desc, |seg| {
                scan_seg(seg, &mut seen, &mut buffer, &mut stopped);
            });
        }

        if !stopped && !buffer.is_empty() {
            callback(&buffer);
        }
    }

    /// Fuzzy name search resolved through `snap`. MVCC twin of
    /// [`Self::find_similar_names`] — searches each shard's committed L1 token
    /// index (the last published compaction) but NEVER scans the live write
    /// buffer, filters by the version's tombstone set, and resolves the
    /// optional `node_type` filter via `get_node_at` (version-pinned).
    pub fn find_similar_names_at(
        &self,
        snap: &ReadSnapshot,
        query: &str,
        node_type: Option<&str>,
        k: usize,
        min_score: f32,
    ) -> Vec<TokenMatch> {
        let mut all_matches: Vec<TokenMatch> = Vec::new();
        let mut seen_ids: HashSet<u128> = HashSet::new();

        for shard in &self.shards {
            if let Some(token_idx) = shard.l1_token_index() {
                let matches = token_idx.search(query, k * 2, min_score); // over-fetch for dedup
                for m in matches {
                    if snap.tombstones.contains_node(m.node_id) {
                        continue;
                    }
                    if !seen_ids.insert(m.node_id) {
                        continue;
                    }
                    if let Some(nt) = node_type {
                        match self.get_node_at(snap, m.node_id) {
                            Some(node) if node.node_type == nt => {}
                            _ => continue,
                        }
                    }
                    all_matches.push(m);
                }
            }
        }

        all_matches.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        all_matches.truncate(k);
        all_matches
    }
}

// ── Type Counts ───────────────────────────────────────────────────

impl MultiShardStore {
    /// Count nodes by type across all shards without loading full records.
    ///
    /// Fan-out to all shards and merge counts.
    /// Since nodes are unique per shard (no cross-shard duplicates),
    /// simple addition is correct.
    pub fn count_by_type(&self) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for shard in &self.shards {
            for (node_type, count) in shard.count_by_type() {
                *counts.entry(node_type).or_insert(0) += count;
            }
        }
        counts
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
            for node in shard.find_nodes(node_type, file, None) {
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
        let mut results: Vec<u128> = Vec::new();
        self.find_node_ids_by_attr_chunked(
            node_type, node_type_prefix, file, name,
            exported, metadata_filters, substring_match,
            usize::MAX,
            &mut |chunk| { results.extend_from_slice(chunk); true },
        );
        results
    }

    /// Iterate matching node IDs in chunks via callback, without materializing all results.
    ///
    /// Iterates shards calling `for_each_matching_id`, deduplicates across shards,
    /// buffers into chunks of `chunk_size`, and calls `callback` per full chunk.
    /// Remaining items are flushed after all shards are scanned.
    ///
    /// Return `false` from `callback` to stop iteration early.
    pub fn find_node_ids_by_attr_chunked(
        &self,
        node_type: Option<&str>,
        node_type_prefix: Option<&str>,
        file: Option<&str>,
        name: Option<&str>,
        exported: Option<bool>,
        metadata_filters: &[(String, String)],
        substring_match: bool,
        chunk_size: usize,
        callback: &mut dyn FnMut(&[u128]) -> bool,
    ) {
        let mut seen: HashSet<u128> = HashSet::new();
        let mut buffer: Vec<u128> = Vec::with_capacity(chunk_size.min(65536));
        let mut stopped = false;

        for shard in &self.shards {
            if stopped {
                break;
            }
            shard.for_each_matching_id(
                node_type, node_type_prefix, file, name,
                exported, metadata_filters, substring_match,
                &mut |id| {
                    if !seen.insert(id) {
                        return true; // duplicate, skip
                    }
                    buffer.push(id);
                    if buffer.len() >= chunk_size {
                        if !callback(&buffer) {
                            stopped = true;
                            return false;
                        }
                        buffer.clear();
                    }
                    true
                },
            );
        }

        // Flush remaining buffer
        if !stopped && !buffer.is_empty() {
            callback(&buffer);
        }
    }

    /// Find nodes with names similar to the query via token-based fuzzy matching.
    ///
    /// Searches all shards' token indexes and write buffers, returning
    /// top-k matches above `min_score`, sorted by score descending.
    pub fn find_similar_names(
        &self,
        query: &str,
        node_type: Option<&str>,
        k: usize,
        min_score: f32,
    ) -> Vec<TokenMatch> {
        let mut all_matches: Vec<TokenMatch> = Vec::new();
        let mut seen_ids: HashSet<u128> = HashSet::new();
        let mut query_tokens: HashSet<String> = tokenize_name(query).into_iter().collect();
        for t in tokenize_text(query) {
            query_tokens.insert(t);
        }

        // Search L1 token indexes on each shard
        for shard in &self.shards {
            if let Some(token_idx) = shard.l1_token_index() {
                let matches = token_idx.search(query, k * 2, min_score); // over-fetch for dedup
                for m in matches {
                    if self.is_node_tombstoned(m.node_id) {
                        continue;
                    }
                    if !seen_ids.insert(m.node_id) {
                        continue;
                    }
                    // Apply node_type filter if specified
                    if let Some(nt) = node_type {
                        if let Some(node) = self.get_node(m.node_id) {
                            if node.node_type != nt {
                                continue;
                            }
                        } else {
                            continue;
                        }
                    }
                    all_matches.push(m);
                }
            }

            // Also scan write buffer names
            if !query_tokens.is_empty() {
                for record in shard.write_buffer_iter_nodes() {
                    if record.name.is_empty() || self.is_node_tombstoned(record.id) {
                        continue;
                    }
                    if !seen_ids.insert(record.id) {
                        continue;
                    }
                    if let Some(nt) = node_type {
                        if record.node_type != nt {
                            continue;
                        }
                    }
                    let mut name_tokens: HashSet<String> = tokenize_name(&record.name).into_iter().collect();
                    for t in tokenize_text(&record.name) {
                        name_tokens.insert(t);
                    }
                    if name_tokens.is_empty() {
                        continue;
                    }
                    let intersection = query_tokens.intersection(&name_tokens).count();
                    let union = query_tokens.union(&name_tokens).count();
                    let score = intersection as f32 / union as f32;
                    if score >= min_score {
                        all_matches.push(TokenMatch {
                            node_id: record.id,
                            name: record.name.clone(),
                            score,
                        });
                    }
                }
            }
        }

        // Sort by score descending, take top k
        all_matches.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        all_matches.truncate(k);
        all_matches
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

    /// Iterate all edges across all shards.
    /// Each shard handles its own dedup and tombstone filtering.
    pub fn iter_all_edges(&self) -> Vec<EdgeRecordV2> {
        let mut results = Vec::new();
        for shard in &self.shards {
            results.extend(shard.iter_all_edges());
        }
        results
    }

    /// Get edges by type across all shards, using per-shard edge-type index.
    pub fn get_edges_by_type(&self, edge_type: &str) -> Vec<EdgeRecordV2> {
        let mut results = Vec::new();
        for shard in &self.shards {
            results.extend(shard.get_edges_by_type(edge_type));
        }
        results
    }
}

// ── Edge Key Discovery ─────────────────────────────────────────────

impl MultiShardStore {
    /// Find edge keys (src, dst, edge_type) where src is in the given ID set.
    ///
    /// Shard-targeted: groups src_ids by their owning shard via `node_to_shard`,
    /// scanning only the relevant shard for each node. Falls back to all-shard
    /// scan for IDs not in `node_to_shard`.
    ///
    /// Complexity: O(1 shard × scan) per mapped node, O(N_shards × scan) per unmapped
    pub fn find_edge_keys_by_src_ids(
        &self,
        src_ids: &HashSet<u128>,
    ) -> Vec<(u128, u128, String)> {
        self.find_edge_keys_by_src_ids_targeted(src_ids, false)
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
        self.find_edge_keys_by_src_ids_targeted(src_ids, true)
    }

    /// Internal: shard-targeted edge key discovery.
    fn find_edge_keys_by_src_ids_targeted(
        &self,
        src_ids: &HashSet<u128>,
        exclude_enrichment: bool,
    ) -> Vec<(u128, u128, String)> {
        // Group src_ids by their owning shard
        let mut ids_by_shard: HashMap<u16, HashSet<u128>> = HashMap::new();
        let mut unmapped_ids: HashSet<u128> = HashSet::new();
        for &id in src_ids {
            if let Some(&shard_id) = self.node_to_shard.get(&id) {
                ids_by_shard.entry(shard_id).or_default().insert(id);
            } else {
                unmapped_ids.insert(id);
            }
        }

        let mut keys = Vec::new();

        // Scan only the relevant shard for mapped IDs
        for (shard_id, ids) in &ids_by_shard {
            if exclude_enrichment {
                keys.extend(
                    self.shards[*shard_id as usize]
                        .find_non_enrichment_edge_keys_by_src_ids(ids),
                );
            } else {
                keys.extend(
                    self.shards[*shard_id as usize]
                        .find_edge_keys_by_src_ids(ids),
                );
            }
        }

        // Fallback: scan all shards for unmapped IDs
        if !unmapped_ids.is_empty() {
            for shard in &self.shards {
                if exclude_enrichment {
                    keys.extend(
                        shard.find_non_enrichment_edge_keys_by_src_ids(&unmapped_ids),
                    );
                } else {
                    keys.extend(shard.find_edge_keys_by_src_ids(&unmapped_ids));
                }
            }
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

    // ── MVCC B4: snapshot-pinned edge-key finders ──────────────────────
    //
    // These mirror the live-shard finders above but resolve through a
    // version-pinned `ReadSnapshot` (immutable segments via the SegmentCache).
    // The concurrent commit path (`commit_batch_private`) uses ONLY these so a
    // commit never reads the live, concurrently-mutated `Shard` state.

    /// Snapshot-pinned variant of [`Self::find_edge_keys_by_src_ids`] /
    /// [`Self::find_non_enrichment_edge_keys_by_src_ids`]. Scans the version's
    /// L0 + L1 edge segments only (no live write buffer — committed data only).
    fn find_edge_keys_by_src_ids_at(
        &self,
        snap: &ReadSnapshot,
        src_ids: &HashSet<u128>,
        exclude_enrichment: bool,
    ) -> Vec<(u128, u128, String)> {
        let mut keys = Vec::new();
        if src_ids.is_empty() {
            return keys;
        }
        let descs = snap.edge_segments.iter().chain(snap.l1_edge_segments.iter());
        for desc in descs {
            self.with_edge_segment(desc, |seg| {
                let may_match = src_ids.iter().any(|id| seg.maybe_contains_src(*id));
                if !may_match {
                    return;
                }
                for j in 0..seg.record_count() {
                    let src = seg.get_src(j);
                    if !src_ids.contains(&src) {
                        continue;
                    }
                    if exclude_enrichment {
                        let metadata = seg.get_metadata(j);
                        if crate::storage_v2::types::extract_file_context(metadata).is_some() {
                            continue;
                        }
                    }
                    let dst = seg.get_dst(j);
                    let edge_type = seg.get_edge_type(j).to_string();
                    keys.push((src, dst, edge_type));
                }
            });
        }
        keys
    }

    /// Snapshot-pinned variant of [`Self::find_edge_keys_by_file_context`].
    fn find_edge_keys_by_file_context_at(
        &self,
        snap: &ReadSnapshot,
        file_context: &str,
    ) -> Vec<(u128, u128, String)> {
        let mut keys = Vec::new();
        let descs = snap.edge_segments.iter().chain(snap.l1_edge_segments.iter());
        for desc in descs {
            self.with_edge_segment(desc, |seg| {
                for j in 0..seg.record_count() {
                    let metadata = seg.get_metadata(j);
                    if let Some(ctx) = crate::storage_v2::types::extract_file_context(metadata) {
                        if ctx == file_context {
                            let src = seg.get_src(j);
                            let dst = seg.get_dst(j);
                            let edge_type = seg.get_edge_type(j).to_string();
                            keys.push((src, dst, edge_type));
                        }
                    }
                }
            });
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
    /// Backward-compatible wrapper — calls `commit_batch_ext` with no protected types.
    pub fn commit_batch(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        manifest_store: &mut ManifestStore,
    ) -> Result<CommitDelta> {
        self.commit_batch_ext(nodes, edges, changed_files, tags, manifest_store, &[])
    }

    /// Atomic batch commit with protected types.
    ///
    /// Nodes whose `node_type` is in `protected_types` are excluded from
    /// tombstoning (they survive the re-analysis of their file).
    ///
    /// Algorithm (9 phases):
    /// 1. Snapshot old state via file_to_node_ids index (O(batch_size))
    /// 2. Compute tombstones (node IDs + edge keys), respecting protected_types
    /// 3. Collect changed node/edge types for delta
    /// 4. Apply tombstones to all shards via Arc sharing (O(1) per shard)
    /// 5. Add new data (nodes + edges), update file_to_node_ids
    /// 5.5. Remove re-added IDs from tombstones (new data supersedes)
    /// 6. Compute modified count (same id, different content_hash)
    /// 7. Flush shards (inlined from flush_all for tombstone injection)
    /// 8. Build and commit manifest WITH tombstones
    /// 9. Build CommitDelta
    pub fn commit_batch_ext(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        manifest_store: &mut ManifestStore,
        protected_types: &[String],
    ) -> Result<CommitDelta> {
        use std::time::Instant;

        // ── Phase 1: Snapshot old state for delta ──
        let t_phase1 = Instant::now();

        // Separate enrichment file contexts from normal files.
        let mut normal_files: Vec<&String> = Vec::new();
        let mut enrichment_contexts: Vec<&String> = Vec::new();
        for file in changed_files {
            if file.starts_with("__enrichment__/") {
                enrichment_contexts.push(file);
            } else {
                normal_files.push(file);
            }
        }

        // Use file_to_node_ids index for O(batch_size) lookup instead of
        // O(total_nodes) find_nodes scan.
        let mut old_nodes_by_id: HashMap<u128, NodeRecordV2> = HashMap::new();
        for file in changed_files {
            if let Some(ids) = self.file_to_node_ids.get(file.as_str()) {
                for &id in ids {
                    if let Some(node) = self.get_node(id) {
                        old_nodes_by_id.insert(node.id, node);
                    }
                }
            }
        }
        let old_node_ids: HashSet<u128> = old_nodes_by_id.keys().copied().collect();

        tracing::debug!(
            "commit_batch phase1_find_old: {}ms, {} nodes",
            t_phase1.elapsed().as_millis(),
            old_nodes_by_id.len()
        );

        // ── Phase 2: Compute tombstones ──
        let t_phase2 = Instant::now();

        // 2a. Node tombstones = old nodes, excluding protected types
        let tombstone_node_ids: HashSet<u128> = if protected_types.is_empty() {
            old_node_ids.clone()
        } else {
            old_nodes_by_id
                .iter()
                .filter(|(_, node)| !protected_types.contains(&node.node_type))
                .map(|(id, _)| *id)
                .collect()
        };

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
            .filter(|(id, _)| tombstone_node_ids.contains(id))
            .map(|(id, _)| *id)
            .collect();
        let enrichment_file_node_ids: HashSet<u128> = old_nodes_by_id
            .iter()
            .filter(|(_, n)| n.file.starts_with("__enrichment__/"))
            .filter(|(id, _)| tombstone_node_ids.contains(id))
            .map(|(id, _)| *id)
            .collect();

        let mut raw_tombstone_edge_keys: Vec<(u128, u128, String)> =
            self.find_non_enrichment_edge_keys_by_src_ids(&normal_file_node_ids);

        if !enrichment_file_node_ids.is_empty() {
            raw_tombstone_edge_keys.extend(
                self.find_edge_keys_by_src_ids(&enrichment_file_node_ids),
            );
        }
        for ctx in &enrichment_contexts {
            raw_tombstone_edge_keys.extend(self.find_edge_keys_by_file_context(ctx));
        }
        let edges_removed = raw_tombstone_edge_keys.len() as u64;

        // Intern edge type strings for tombstone deduplication
        let tombstone_edge_keys: Vec<(u128, u128, Arc<str>)> = raw_tombstone_edge_keys
            .into_iter()
            .map(|(s, d, t)| {
                let interned = self.intern_edge_type(&t);
                (s, d, interned)
            })
            .collect();

        tracing::debug!(
            "commit_batch phase2_tombstones: {}ms, {} node_tombs, {} edge_tombs",
            t_phase2.elapsed().as_millis(),
            tombstone_node_ids.len(),
            edges_removed
        );

        // ── Phase 3: Collect changed types ──
        let mut changed_node_types: HashSet<String> = HashSet::new();
        let mut changed_edge_types: HashSet<String> = HashSet::new();

        // From tombstoned nodes/edges
        for node in old_nodes_by_id.values() {
            changed_node_types.insert(node.node_type.clone());
        }
        for (_, _, et) in &tombstone_edge_keys {
            changed_edge_types.insert(et.to_string());
        }

        // From new nodes/edges
        for node in &nodes {
            changed_node_types.insert(node.node_type.clone());
        }
        for edge in &edges {
            changed_edge_types.insert(edge.edge_type.clone());
        }

        // ── Phase 4: Compute the next version's cumulative tombstone set ──
        let t_phase4 = Instant::now();

        // MVCC B3: the BASE cumulative set comes from the manifest VERSION (the
        // authority), not from a per-shard broadcast. next = base + this commit's
        // additions (phase 5.5 below subtracts re-added ids). No per-shard
        // broadcast here — the snapshot reads the manifest, and the legacy
        // shard mirror is published ONCE at the commit point (phase 5.5).
        let mut all_tomb_nodes: HashSet<u128> = manifest_store
            .current()
            .tombstoned_node_ids
            .iter()
            .copied()
            .collect();
        all_tomb_nodes.extend(&tombstone_node_ids);

        let mut all_tomb_edges: HashSet<(u128, u128, Arc<str>)> = manifest_store
            .current()
            .tombstoned_edge_keys
            .iter()
            .map(|(s, d, t)| (*s, *d, Arc::from(t.as_str())))
            .collect();
        all_tomb_edges.extend(tombstone_edge_keys.iter().cloned());

        tracing::debug!(
            "commit_batch phase4_compute_tombstones: {}ms",
            t_phase4.elapsed().as_millis()
        );

        // ── Phase 4.5: Update file_to_node_ids for changed files ──
        // Remove old entries before add_nodes adds new ones.
        for file in changed_files {
            self.file_to_node_ids.remove(file.as_str());
        }

        // ── Phase 5: Add new data ──
        let t_phase5 = Instant::now();

        // Clone edges before upsert_edges (which takes ownership).
        // We need the clone for Phase 5.5 edge tombstone removal.
        let edges_clone: Vec<EdgeRecordV2> = edges.clone();
        self.add_nodes(nodes.clone());
        self.upsert_edges(edges)?;

        tracing::debug!(
            "commit_batch phase5_add_data: {}ms, {} nodes, {} edges",
            t_phase5.elapsed().as_millis(),
            nodes.len(),
            edges_clone.len()
        );

        // ── Phase 5.5: Remove re-added IDs from tombstones ──
        // New data supersedes tombstones for the same IDs. Collect the IDs we
        // actually un-tombstone so the manifest edit carries the precise
        // O(batch) delta (replay removes exactly these from the cumulative set).
        let mut untombstoned_nodes: Vec<u128> = Vec::new();
        for node in &nodes {
            if all_tomb_nodes.remove(&node.id) {
                untombstoned_nodes.push(node.id);
            }
        }
        let mut untombstoned_edges: Vec<(u128, u128, String)> = Vec::new();
        for edge in &edges_clone {
            let interned_type = self.intern_edge_type(&edge.edge_type);
            let key = (edge.src, edge.dst, interned_type);
            if all_tomb_edges.remove(&key) {
                untombstoned_edges.push((key.0, key.1, key.2.to_string()));
            }
        }

        // MVCC B3: publish the next version's cumulative set to the per-shard
        // mirror ONCE, at the serialized commit point. This is NOT the snapshot
        // authority (snapshots read the manifest version) — it only backs the
        // legacy live-read paths in Shard and the compaction-merge filter that
        // still consult `Shard.tombstones`. Single broadcast, no intermediate
        // shared-mutable race window.
        let shared_tombstones = Arc::new(TombstoneSet {
            node_ids: all_tomb_nodes.clone(),
            edge_keys: all_tomb_edges.clone(),
        });
        for shard in &mut self.shards {
            shard.set_tombstones_shared(Arc::clone(&shared_tombstones));
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
        let t_phase7 = Instant::now();

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

        tracing::debug!(
            "commit_batch phase7_flush: {}ms",
            t_phase7.elapsed().as_millis()
        );

        // ── Phase 8: Build and commit manifest WITH tombstones ──
        let t_phase8 = Instant::now();

        // O(Δ) commit: build only the delta, never the full segment list.
        // `commit_edit` advances the in-memory snapshot in place via replay and
        // writes a full checkpoint only every `checkpoint_interval` versions.
        let manifest_version = manifest_store.current().version + 1;

        // Resulting stats computed incrementally from current + this commit's
        // added segments (a normal re-analysis commit removes no segments).
        let mut stats = manifest_store.current().stats.clone();
        for s in &new_node_descs {
            stats.total_nodes += s.record_count;
            stats.node_segment_count += 1;
        }
        for s in &new_edge_descs {
            stats.total_edges += s.record_count;
            stats.edge_segment_count += 1;
        }

        // Full cumulative tombstone set — passed for checkpoint snapshots only.
        let cp_tomb_nodes: Vec<u128> = all_tomb_nodes.into_iter().collect();
        let cp_tomb_edges: Vec<(u128, u128, String)> = all_tomb_edges
            .into_iter()
            .map(|(s, d, t)| (s, d, t.to_string()))
            .collect();

        let edit = ManifestEdit {
            version: manifest_version,
            parent_version: manifest_version.saturating_sub(1),
            base_checkpoint: 0, // advisory; open() locates the base by dir scan
            created_at: 0,      // stamped by commit_edit
            added_node_segments: new_node_descs,
            added_edge_segments: new_edge_descs,
            removed_node_segment_ids: Vec::new(),
            removed_edge_segment_ids: Vec::new(),
            added_tombstone_nodes: tombstone_node_ids.iter().copied().collect(),
            removed_tombstone_nodes: untombstoned_nodes,
            added_tombstone_edges: tombstone_edge_keys
                .iter()
                .map(|(s, d, t)| (*s, *d, t.to_string()))
                .collect(),
            removed_tombstone_edges: untombstoned_edges,
            l1_node_segments: None,
            l1_edge_segments: None,
            last_compaction: None,
            tags,
            stats,
        };

        manifest_store.commit_edit(edit, &cp_tomb_nodes, &cp_tomb_edges)?;

        tracing::debug!(
            "commit_batch phase8_manifest: {}ms",
            t_phase8.elapsed().as_millis()
        );

        // ── Phase 9: Build CommitDelta ──
        Ok(CommitDelta {
            changed_files: changed_files.to_vec(),
            nodes_added: purely_new,
            nodes_removed: tombstone_node_ids.len() as u64,
            nodes_modified,
            removed_node_ids: tombstone_node_ids.into_iter().collect(),
            edges_removed,
            changed_node_types,
            changed_edge_types,
            manifest_version,
        })
    }
}

// ── MVCC B4: concurrent commit (private buffers, lock-free build/flush) ──
//
// `commit_batch_private(&self)` is the concurrency payoff. Unlike
// `commit_batch_ext(&mut self)` it:
//   - reads ALL old state through a version-pinned snapshot (immutable
//     segments via the SegmentCache) — never the live, concurrently-mutated
//     `Shard`;
//   - builds this commit's output into PRIVATE per-shard segment writers and
//     flushes them to NEW immutable segment files — never the shared
//     `Shard.write_buffer` / `Shard.node_segments`;
//   - holds NO lock across the build/flush (phases 0–7);
//   - serializes ONLY phase 8 (conflict-check + manifest version append) under
//     the one manifest mutex supplied by the caller.
//
// Because no lock spans the build/flush, two concurrent commits on disjoint
// files run fully in parallel and cannot form a lock cycle — deadlock-free by
// construction. Same-file concurrent commits collide at the conflict check and
// one aborts (strict abort-retry, §4 of the MVCC design).
//
// Disk-backed only: the private-flush + SegmentCache path needs real segment
// files. Ephemeral (in-memory) stores fall back to the serial `commit_batch_ext`
// (single-threaded tests), so this method asserts a `db_path`.
impl MultiShardStore {
    /// Number of conflict-driven commit retries observed so far (MVCC B4).
    pub fn commit_conflict_retries(&self) -> u64 {
        self.commit_conflict_retries
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// MVCC B4 parallelism witness: peak number of commits that executed the
    /// LOCK-FREE build/flush region (phases 1–7 of `commit_batch_private`)
    /// SIMULTANEOUSLY. `> 1` proves real disjoint-commit overlap that the 2PL
    /// path structurally could not produce.
    pub fn commit_build_peak(&self) -> u64 {
        self.commit_build_peak
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// True if this store can take the concurrent commit path (disk-backed).
    pub fn supports_concurrent_commit(&self) -> bool {
        self.db_path.is_some()
    }

    /// Concurrent, deadlock-free commit. See module-level B4 notes.
    ///
    /// `manifest` is the engine's shared `Mutex<ManifestStore>`; this method
    /// locks it ONLY for the short phase-8 commit point. `protected_types`
    /// matches `commit_batch_ext`. On a write-write conflict it returns
    /// `GraphError::ConflictedCommit` (the caller retries with a fresh
    /// snapshot); the private segment files written for the aborted attempt are
    /// orphaned (unreferenced by any version) and reaped by manifest GC.
    pub fn commit_batch_private(
        &self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        manifest: &std::sync::Mutex<ManifestStore>,
        protected_types: &[String],
    ) -> Result<CommitDelta> {
        use std::io::BufWriter;
        use crate::storage_v2::writer::{EdgeSegmentWriter, NodeSegmentWriter};

        let db_path = self
            .db_path
            .as_ref()
            .expect("commit_batch_private requires a disk-backed store");

        // ── Phase 0: capture a version-pinned snapshot (atomic, short lock) ──
        // Lock the manifest only long enough to clone the current version's
        // descriptors + tombstone Arc. Released immediately — NOT held across
        // build/flush.
        let snap = {
            let m = manifest.lock().unwrap();
            self.snapshot(&m)
        };
        let snapshot_version = snap.version;

        // MVCC B4 parallelism witness: mark entry into the LOCK-FREE build/flush
        // region (phases 1–7, which hold NO shared lock) and track the peak
        // simultaneous occupancy. peak>1 proves two commit bodies ran the no-lock
        // phase at the same time — the property 2PL structurally could not have.
        // A guard ensures we always decrement (even on the `?`/conflict early
        // returns below) so the in-flight gauge never leaks.
        struct BuildGuard<'a>(&'a std::sync::atomic::AtomicU64);
        impl Drop for BuildGuard<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let _build_guard = {
            use std::sync::atomic::Ordering::SeqCst;
            let cur = self.commit_build_in_flight.fetch_add(1, SeqCst) + 1;
            let mut p = self.commit_build_peak.load(SeqCst);
            while cur > p {
                match self
                    .commit_build_peak
                    .compare_exchange(p, cur, SeqCst, SeqCst)
                {
                    Ok(_) => break,
                    Err(actual) => p = actual,
                }
            }
            BuildGuard(&self.commit_build_in_flight)
        };

        // ── Phase 1: old state of changed_files, from the snapshot ──
        // No file_to_node_ids dependency: scan the snapshot's segments by file.
        let mut old_nodes_by_id: HashMap<u128, NodeRecordV2> = HashMap::new();
        for file in changed_files {
            for node in self.find_nodes_at(&snap, None, Some(file.as_str())) {
                old_nodes_by_id.insert(node.id, node);
            }
        }
        let old_node_ids: HashSet<u128> = old_nodes_by_id.keys().copied().collect();

        // Separate enrichment file contexts from normal files.
        let enrichment_contexts: Vec<&String> = changed_files
            .iter()
            .filter(|f| f.starts_with("__enrichment__/"))
            .collect();

        // ── Phase 2: compute tombstones (snapshot-pinned edge finders) ──
        let tombstone_node_ids: HashSet<u128> = if protected_types.is_empty() {
            old_node_ids.clone()
        } else {
            old_nodes_by_id
                .iter()
                .filter(|(_, node)| !protected_types.contains(&node.node_type))
                .map(|(id, _)| *id)
                .collect()
        };

        let normal_file_node_ids: HashSet<u128> = old_nodes_by_id
            .iter()
            .filter(|(_, n)| !n.file.starts_with("__enrichment__/"))
            .filter(|(id, _)| tombstone_node_ids.contains(id))
            .map(|(id, _)| *id)
            .collect();
        let enrichment_file_node_ids: HashSet<u128> = old_nodes_by_id
            .iter()
            .filter(|(_, n)| n.file.starts_with("__enrichment__/"))
            .filter(|(id, _)| tombstone_node_ids.contains(id))
            .map(|(id, _)| *id)
            .collect();

        let mut raw_tombstone_edge_keys: Vec<(u128, u128, String)> =
            self.find_edge_keys_by_src_ids_at(&snap, &normal_file_node_ids, true);
        if !enrichment_file_node_ids.is_empty() {
            raw_tombstone_edge_keys
                .extend(self.find_edge_keys_by_src_ids_at(&snap, &enrichment_file_node_ids, false));
        }
        for ctx in &enrichment_contexts {
            raw_tombstone_edge_keys
                .extend(self.find_edge_keys_by_file_context_at(&snap, ctx));
        }
        let edges_removed = raw_tombstone_edge_keys.len() as u64;

        // Intern edge types locally (no shared edge_type_intern mutation on the
        // concurrent path — a per-commit map is enough for dedup here).
        let mut local_intern: HashMap<String, Arc<str>> = HashMap::new();
        let mut intern = |t: &str| -> Arc<str> {
            if let Some(a) = local_intern.get(t) {
                return Arc::clone(a);
            }
            let a: Arc<str> = Arc::from(t);
            local_intern.insert(t.to_string(), Arc::clone(&a));
            a
        };
        let tombstone_edge_keys: Vec<(u128, u128, Arc<str>)> = raw_tombstone_edge_keys
            .into_iter()
            .map(|(s, d, t)| {
                let it = intern(&t);
                (s, d, it)
            })
            .collect();

        // ── Phase 3: changed types (for the CommitDelta) ──
        let mut changed_node_types: HashSet<String> = HashSet::new();
        let mut changed_edge_types: HashSet<String> = HashSet::new();
        for node in old_nodes_by_id.values() {
            changed_node_types.insert(node.node_type.clone());
        }
        for (_, _, et) in &tombstone_edge_keys {
            changed_edge_types.insert(et.to_string());
        }
        for node in &nodes {
            changed_node_types.insert(node.node_type.clone());
        }
        for edge in &edges {
            changed_edge_types.insert(edge.edge_type.clone());
        }

        // ── Phase 4: tombstone-removal delta for re-added entities ──
        // A re-added node/edge supersedes ANY tombstone on its id. The published
        // edit replays as `set.extend(added_tombstones); set.remove(removed)`
        // (Manifest::apply), so `removed_tombstone_*` (this var) must cancel a
        // tombstone whether it came from (a) the prior cumulative set OR (b) THIS
        // commit's own `tombstone_*_ids` (added in the same edit — phase 1/2
        // tombstones the file's OLD nodes, which for a re-analysis share ids with
        // the NEW nodes). Restricting to the snapshot base alone (case a) lost
        // re-added rows under same-file re-analysis: the edit added the id to
        // tombstones and never removed it, so replay/reopen (and even the
        // in-memory non-checkpoint version) hid the freshly re-added node.
        // Listing EVERY re-added id as removed is always correct — a re-added
        // entity is live by definition, and conflict detection guarantees no
        // other commit owns these files after our snapshot. (apply's order
        // extend-then-remove makes the remove authoritative.)
        let untombstoned_nodes: Vec<u128> = nodes.iter().map(|n| n.id).collect();
        let untombstoned_edges: Vec<(u128, u128, String)> = edges
            .iter()
            .map(|e| (e.src, e.dst, e.edge_type.clone()))
            .collect();

        // ── Phase 5–7: build PRIVATE per-shard segments, flush to NEW files ──
        // Route nodes by file; edges by source-node's shard (local map first,
        // then snapshot lookup). NO shared Shard / routing-map mutation.
        let mut local_node_shard: HashMap<u128, u16> = HashMap::new();
        let mut nodes_by_shard: HashMap<u16, Vec<NodeRecordV2>> = HashMap::new();
        for node in &nodes {
            let shard_id = self.planner.compute_shard_id(&node.file);
            local_node_shard.insert(node.id, shard_id);
            nodes_by_shard
                .entry(shard_id)
                .or_default()
                .push(node.clone());
        }

        let mut edges_by_shard: HashMap<u16, Vec<EdgeRecordV2>> = HashMap::new();
        for edge in &edges {
            let shard_id = if let Some(ctx) = extract_file_context(&edge.metadata) {
                // Enrichment edge: route by file_context.
                self.planner.compute_shard_id(&ctx)
            } else if let Some(&sid) = local_node_shard.get(&edge.src) {
                sid
            } else if let Some(src_node) = self.get_node_at(&snap, edge.src) {
                self.planner.compute_shard_id(&src_node.file)
            } else {
                // Source unknown in this commit and in the snapshot — skip
                // (matches upsert_edges' skip-unknown-source behavior).
                continue;
            };
            edges_by_shard
                .entry(shard_id)
                .or_default()
                .push(edge.clone());
        }

        // Allocate IDs + write private segment files. Segment IDs come from the
        // lock-free atomic counter (no manifest lock needed for allocation).
        let mut new_node_descs: Vec<SegmentDescriptor> = Vec::new();
        let mut new_edge_descs: Vec<SegmentDescriptor> = Vec::new();
        // Opened segments to register in the cache AFTER a successful publish.
        let mut opened_nodes: Vec<(u64, Arc<NodeSegmentV2>)> = Vec::new();
        let mut opened_edges: Vec<(u64, Arc<EdgeSegmentV2>)> = Vec::new();

        let next_seg_id = || -> u64 {
            let g = manifest.lock().unwrap();
            g.next_segment_id()
        };

        for (shard_id, shard_nodes) in &nodes_by_shard {
            if shard_nodes.is_empty() {
                continue;
            }
            let seg_id = next_seg_id();
            let mut writer = NodeSegmentWriter::new();
            for n in shard_nodes {
                writer.add(n.clone());
            }
            let shard_path = shard_dir(db_path, *shard_id);
            let seg_path = shard_path.join(format!("seg_{:06}_nodes.seg", seg_id));
            let file = std::fs::File::create(&seg_path)?;
            let mut bw = BufWriter::new(file);
            let meta = writer.finish(&mut bw)?;
            drop(bw);
            let seg = Arc::new(NodeSegmentV2::open(&seg_path)?);
            let desc = SegmentDescriptor::from_meta(
                seg_id,
                SegmentType::Nodes,
                Some(*shard_id),
                meta,
            );
            opened_nodes.push((seg_id, seg));
            new_node_descs.push(desc);
        }

        for (shard_id, shard_edges) in &edges_by_shard {
            if shard_edges.is_empty() {
                continue;
            }
            let seg_id = next_seg_id();
            let mut writer = EdgeSegmentWriter::new();
            for e in shard_edges {
                writer.add(e.clone());
            }
            let shard_path = shard_dir(db_path, *shard_id);
            let seg_path = shard_path.join(format!("seg_{:06}_edges.seg", seg_id));
            let file = std::fs::File::create(&seg_path)?;
            let mut bw = BufWriter::new(file);
            let meta = writer.finish(&mut bw)?;
            drop(bw);
            let seg = Arc::new(EdgeSegmentV2::open(&seg_path)?);
            let desc = SegmentDescriptor::from_meta(
                seg_id,
                SegmentType::Edges,
                Some(*shard_id),
                meta,
            );
            opened_edges.push((seg_id, seg));
            new_edge_descs.push(desc);
        }

        // ── Phase 6: modified-vs-new counts (vs snapshot old state) ──
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

        // Leave the LOCK-FREE region BEFORE taking the commit-point mutex: a
        // thread blocked on `manifest.lock()` is serialized, NOT overlapping, so
        // it must not inflate the build/flush parallelism witness.
        drop(_build_guard);

        // ── Phase 8: commit point (serialized under the manifest mutex) ──
        let manifest_version = {
            let mut m = manifest.lock().unwrap();

            // 8a. Conflict check: did a version published AFTER our snapshot
            // touch any of our changed_files? (strict abort-retry, §4)
            {
                let conflict_map = self.file_last_committed_version.lock().unwrap();
                for file in changed_files {
                    if let Some(&last_v) = conflict_map.get(file.as_str()) {
                        if last_v > snapshot_version {
                            drop(conflict_map);
                            self.commit_conflict_retries
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            tracing::warn!(
                                "commit_conflict: file={}, last_committed_version={}, my_snapshot={} — aborting for retry",
                                file, last_v, snapshot_version
                            );
                            return Err(GraphError::ConflictedCommit {
                                files: vec![file.clone()],
                                snapshot_version,
                                conflicting_version: last_v,
                            });
                        }
                    }
                }
            }

            // 8b. Recompute the published cumulative tombstone set from the
            // THEN-current version (not our snapshot) so disjoint concurrent
            // commits compose correctly.
            let manifest_version = m.current().version + 1;
            let mut all_tomb_nodes: HashSet<u128> =
                m.current().tombstoned_node_ids.iter().copied().collect();
            all_tomb_nodes.extend(&tombstone_node_ids);
            let mut all_tomb_edges: HashSet<(u128, u128, Arc<str>)> = m
                .current()
                .tombstoned_edge_keys
                .iter()
                .map(|(s, d, t)| (*s, *d, Arc::from(t.as_str())))
                .collect();
            all_tomb_edges.extend(tombstone_edge_keys.iter().cloned());
            // Re-added nodes/edges supersede their tombstones.
            for n in &nodes {
                all_tomb_nodes.remove(&n.id);
            }
            for e in &edges {
                let key = (e.src, e.dst, intern(&e.edge_type));
                all_tomb_edges.remove(&key);
            }

            // 8c. Incremental stats.
            let mut stats = m.current().stats.clone();
            for s in &new_node_descs {
                stats.total_nodes += s.record_count;
                stats.node_segment_count += 1;
            }
            for s in &new_edge_descs {
                stats.total_edges += s.record_count;
                stats.edge_segment_count += 1;
            }

            let cp_tomb_nodes: Vec<u128> = all_tomb_nodes.into_iter().collect();
            let cp_tomb_edges: Vec<(u128, u128, String)> = all_tomb_edges
                .into_iter()
                .map(|(s, d, t)| (s, d, t.to_string()))
                .collect();

            let edit = ManifestEdit {
                version: manifest_version,
                parent_version: manifest_version.saturating_sub(1),
                base_checkpoint: 0,
                created_at: 0,
                added_node_segments: new_node_descs.clone(),
                added_edge_segments: new_edge_descs.clone(),
                removed_node_segment_ids: Vec::new(),
                removed_edge_segment_ids: Vec::new(),
                added_tombstone_nodes: tombstone_node_ids.iter().copied().collect(),
                removed_tombstone_nodes: untombstoned_nodes.clone(),
                added_tombstone_edges: tombstone_edge_keys
                    .iter()
                    .map(|(s, d, t)| (*s, *d, t.to_string()))
                    .collect(),
                removed_tombstone_edges: untombstoned_edges.clone(),
                l1_node_segments: None,
                l1_edge_segments: None,
                last_compaction: None,
                tags,
                stats,
            };

            m.commit_edit(edit, &cp_tomb_nodes, &cp_tomb_edges)?;

            // 8d. Update the conflict map for our changed_files → new version.
            {
                let mut conflict_map = self.file_last_committed_version.lock().unwrap();
                for file in changed_files {
                    conflict_map.insert(file.clone(), manifest_version);
                }
            }

            manifest_version
        };

        // 8e. Register the freshly-written segments in the cache (post-publish,
        // so a reader at V+1 gets a hit instead of re-opening).
        for (id, seg) in opened_nodes {
            self.segment_cache.insert_node_segment(id, seg);
        }
        for (id, seg) in opened_edges {
            self.segment_cache.insert_edge_segment(id, seg);
        }

        Ok(CommitDelta {
            changed_files: changed_files.to_vec(),
            nodes_added: purely_new,
            nodes_removed: tombstone_node_ids.len() as u64,
            nodes_modified,
            removed_node_ids: tombstone_node_ids.into_iter().collect(),
            edges_removed,
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
            let mut by_name_idx: Option<InvertedIndex> = None;
            let mut token_idx: Option<TokenIndex> = None;

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
                by_name_idx = Some(InvertedIndex::from_bytes(&built.by_name)?);
                token_idx = Some(TokenIndex::from_bytes(&built.by_token)?);

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
            self.shards[shard_idx].set_l1_indexes(by_type_idx, by_file_idx, by_name_idx, token_idx);

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
    /// Per-shard diagnostics for lifecycle visibility.
    pub fn shard_diagnostics(&self) -> Vec<ShardDiagnostics> {
        self.shards
            .iter()
            .enumerate()
            .map(|(i, shard)| shard.diagnostics(i as u16))
            .collect()
    }

    /// Backward-compatible alias for `shard_diagnostics()`.
    pub fn shard_stats(&self) -> Vec<ShardStats> {
        self.shard_diagnostics()
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
    fn test_shard_diagnostics_ephemeral() {
        let mut store = MultiShardStore::ephemeral(2);

        let nodes: Vec<NodeRecordV2> = (0..4)
            .map(|i| make_node(
                &format!("dir_{}/fn_{}", i, i),
                "FUNCTION",
                &format!("fn_{}", i),
                &format!("dir_{}/file.js", i),
            ))
            .collect();
        store.add_nodes(nodes);

        let diags = store.shard_diagnostics();
        assert_eq!(diags.len(), 2);

        let total: usize = diags.iter().map(|d| d.node_count).sum();
        assert_eq!(total, 4);

        for d in &diags {
            // Ephemeral, no compaction
            assert!(!d.compacted);
            assert_eq!(d.l0_node_segment_count, 0);
            assert_eq!(d.l1_node_records, 0);
            assert!(!d.has_l1_by_type);
            assert!(!d.has_l1_by_file);
            assert!(!d.has_l1_by_name);
            assert_eq!(d.tombstone_node_count, 0);
            assert_eq!(d.tombstone_edge_count, 0);
        }
    }

    #[test]
    fn test_shard_diagnostics_after_compaction() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("diag_compact.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let mut store = MultiShardStore::create(&db_path, 2).unwrap();
        let mut manifest = ManifestStore::create(&db_path).unwrap();

        // Flush 4 times to create enough L0 segments (threshold=4)
        for batch in 0..4 {
            let nodes: Vec<NodeRecordV2> = (0..3)
                .map(|i| {
                    let idx = batch * 3 + i;
                    make_node(
                        &format!("dir_{}/fn_{}", idx, idx),
                        "FUNCTION",
                        &format!("fn_{}", idx),
                        &format!("dir_{}/file.js", idx),
                    )
                })
                .collect();
            store.add_nodes(nodes);
            store.flush_all(&mut manifest).unwrap();
        }

        let config = CompactionConfig::default();
        store.compact(&mut manifest, &config).unwrap();

        let diags = store.shard_diagnostics();
        let has_compacted = diags.iter().any(|d| d.compacted);
        assert!(has_compacted, "at least one shard should be compacted");

        for d in &diags {
            if d.compacted {
                assert!(d.l1_node_records > 0, "compacted shard should have L1 node records");
                assert_eq!(d.l0_node_segment_count, 0, "L0 should be cleared after compaction");
                assert!(d.has_l1_by_type, "compacted shard should have by_type index");
            }
        }
    }

    #[test]
    fn test_shard_diagnostics_tombstones() {
        let mut store = MultiShardStore::ephemeral(2);

        let nodes: Vec<NodeRecordV2> = (0..6)
            .map(|i| make_node(
                &format!("dir_{}/fn_{}", i, i),
                "FUNCTION",
                &format!("fn_{}", i),
                &format!("dir_{}/file.js", i),
            ))
            .collect();
        let ids: Vec<u128> = nodes.iter().map(|n| n.id).collect();
        store.add_nodes(nodes);

        // Tombstone 2 nodes — set_tombstones broadcasts to all shards,
        // so each shard gets both tombstone IDs.
        let tombstone_ids: std::collections::HashSet<u128> = ids[..2].iter().copied().collect();
        let tombstone_edges: std::collections::HashSet<(u128, u128, Arc<str>)> = std::collections::HashSet::new();
        store.set_tombstones(&tombstone_ids, &tombstone_edges);

        let diags = store.shard_diagnostics();
        // Each shard gets all tombstones (broadcast), so total = 2 * shard_count
        let total_tombstones: usize = diags.iter().map(|d| d.tombstone_node_count).sum();
        assert_eq!(total_tombstones, 2 * 2, "each shard gets all tombstone IDs");
        // But each individual shard should have exactly 2
        for d in &diags {
            assert_eq!(d.tombstone_node_count, 2);
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
        let single_fns = single.find_nodes(Some("FUNCTION"), None, None);
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

        // MVCC B3: the manifest VERSION is the tombstone authority and KEEPS its
        // cumulative set in memory (previously these were cleared after commit;
        // the per-shard set was the source of truth). The re-analysis of
        // a/file.js dropped fn1 + fn2 + the CALLS edge → all tombstoned.
        let manifest = manifest_store.current();
        assert!(
            manifest.tombstoned_node_ids.contains(&a.id),
            "manifest version must hold the cumulative node tombstones (B3 authority)"
        );
        assert!(
            manifest.tombstoned_node_ids.contains(&b.id),
            "manifest version must hold the cumulative node tombstones (B3 authority)"
        );
        assert!(
            manifest
                .tombstoned_edge_keys
                .iter()
                .any(|(s, d, t)| *s == edge.src && *d == edge.dst && t == &edge.edge_type),
            "manifest version must hold the cumulative edge tombstones (B3 authority)"
        );

        // The derived current_tombstones Arc (what snapshots read) agrees.
        let cur_tomb = manifest_store.current_tombstones();
        assert!(cur_tomb.contains_node(a.id));
        assert!(cur_tomb.contains_node(b.id));
        assert!(cur_tomb.contains_edge(edge.src, edge.dst, &edge.edge_type));

        // The per-shard mirror is kept consistent with the version for the
        // legacy live-read paths.
        assert!(store.is_node_tombstoned(a.id));
        assert!(store.is_node_tombstoned(b.id));
        assert!(store.is_edge_tombstoned(edge.src, edge.dst, &edge.edge_type));
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

        // Shard TombstoneSet should contain tombstones for A and B
        // (manifest Vecs are cleared after commit to save memory)
        assert!(
            store.is_node_tombstoned(a.id),
            "Tombstone for node A missing from shard TombstoneSet"
        );
        assert!(
            store.is_node_tombstoned(b.id),
            "Tombstone for node B missing from shard TombstoneSet"
        );

        // Nodes C, D (from file b) should NOT be tombstoned
        assert!(
            !store.is_node_tombstoned(c.id),
            "Node C should not be tombstoned"
        );
        assert!(
            !store.is_node_tombstoned(d.id),
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

    #[test]
    fn test_chunked_callback_receives_correct_chunks() {
        let mut store = MultiShardStore::ephemeral(2);
        let mut nodes = Vec::new();
        for i in 0..25 {
            nodes.push(make_node(
                &format!("fn{i}"),
                "FUNCTION",
                &format!("func_{i}"),
                &format!("src/f{}.js", i % 3),
            ));
        }
        store.add_nodes(nodes);
        // Nodes are queryable from write buffer; no flush needed.

        // Verify chunked produces same total as non-chunked
        let all_ids = store.find_node_ids_by_attr(
            Some("FUNCTION"), None, None, None, None, &[], false,
        );

        let mut chunked_ids: Vec<u128> = Vec::new();
        let mut chunk_count = 0;
        let mut max_chunk_size = 0;
        store.find_node_ids_by_attr_chunked(
            Some("FUNCTION"), None, None, None, None, &[], false,
            7, // small chunk size to verify multiple callbacks
            &mut |chunk| {
                chunk_count += 1;
                if chunk.len() > max_chunk_size {
                    max_chunk_size = chunk.len();
                }
                chunked_ids.extend_from_slice(chunk);
                true
            },
        );

        // Same IDs, same order
        assert_eq!(all_ids, chunked_ids, "Chunked should produce same IDs as non-chunked");
        assert!(chunk_count > 1, "Should have multiple chunks with chunk_size=7 and 25 nodes");
        assert!(max_chunk_size <= 7, "No chunk should exceed chunk_size");
    }

    #[test]
    fn test_chunked_callback_early_stop() {
        let mut store = MultiShardStore::ephemeral(2);
        let mut nodes = Vec::new();
        for i in 0..20 {
            nodes.push(make_node(
                &format!("n{i}"),
                "VARIABLE",
                &format!("var_{i}"),
                "src/x.js",
            ));
        }
        store.add_nodes(nodes);
        // Nodes are queryable from write buffer; no flush needed.

        let mut collected: Vec<u128> = Vec::new();
        store.find_node_ids_by_attr_chunked(
            Some("VARIABLE"), None, None, None, None, &[], false,
            5,
            &mut |chunk| {
                collected.extend_from_slice(chunk);
                // Stop after first chunk
                false
            },
        );

        assert_eq!(collected.len(), 5, "Should stop after first chunk of 5");
    }

    // ── RFD-51: Optimization Tests ────────────────────────────────────

    #[test]
    fn test_file_to_node_ids_maintained() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut ms = ManifestStore::ephemeral();

        // Add nodes for 3 files
        let n1 = make_node("a/f1", "FUNCTION", "f1", "a/file.js");
        let n2 = make_node("a/f2", "FUNCTION", "f2", "a/file.js");
        let n3 = make_node("b/g1", "FUNCTION", "g1", "b/file.js");
        let n4 = make_node("c/h1", "CLASS", "h1", "c/file.js");
        store.add_nodes(vec![n1.clone(), n2.clone(), n3.clone(), n4.clone()]);

        // Verify file_to_node_ids index
        let a_ids = store.file_to_node_ids.get("a/file.js").unwrap();
        assert_eq!(a_ids.len(), 2);
        assert!(a_ids.contains(&n1.id));
        assert!(a_ids.contains(&n2.id));

        let b_ids = store.file_to_node_ids.get("b/file.js").unwrap();
        assert_eq!(b_ids.len(), 1);
        assert!(b_ids.contains(&n3.id));

        let c_ids = store.file_to_node_ids.get("c/file.js").unwrap();
        assert_eq!(c_ids.len(), 1);
        assert!(c_ids.contains(&n4.id));

        // commit_batch re-analyzing a/file.js with new nodes
        let n5 = make_node("a/f3", "FUNCTION", "f3", "a/file.js");
        store.commit_batch(
            vec![n5.clone()],
            vec![],
            &["a/file.js".to_string()],
            HashMap::new(),
            &mut ms,
        ).unwrap();

        // After commit: a/file.js should have only n5
        let a_ids_new = store.file_to_node_ids.get("a/file.js").unwrap();
        assert_eq!(a_ids_new.len(), 1);
        assert!(a_ids_new.contains(&n5.id));

        // b and c untouched
        assert_eq!(store.file_to_node_ids.get("b/file.js").unwrap().len(), 1);
        assert_eq!(store.file_to_node_ids.get("c/file.js").unwrap().len(), 1);
    }

    #[test]
    fn test_file_to_node_ids_on_open() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let mut ms = ManifestStore::create(&db_path).unwrap();

        // Create, add nodes, flush
        {
            let mut store = MultiShardStore::create(&db_path, 4).unwrap();
            let n1 = make_node("src/a", "FUNCTION", "a", "src/a.js");
            let n2 = make_node("src/b", "FUNCTION", "b", "src/b.js");
            store.add_nodes(vec![n1.clone(), n2.clone()]);
            store.flush_all(&mut ms).unwrap();
        }

        // Reopen and verify file_to_node_ids rebuilt correctly
        let store = MultiShardStore::open(&db_path, &ms).unwrap();
        assert!(store.file_to_node_ids.get("src/a.js").unwrap().len() == 1);
        assert!(store.file_to_node_ids.get("src/b.js").unwrap().len() == 1);
    }

    #[test]
    fn test_arc_tombstone_sharing() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut ms = ManifestStore::ephemeral();

        let n1 = make_node("src/a/f1", "FUNCTION", "f1", "src/a/f.js");
        store.add_nodes(vec![n1.clone()]);

        // Commit batch — should use Arc-shared tombstones
        let n2 = make_node("src/a/f2", "FUNCTION", "f2", "src/a/f.js");
        store.commit_batch(
            vec![n2],
            vec![],
            &["src/a/f.js".to_string()],
            HashMap::new(),
            &mut ms,
        ).unwrap();

        // All shards should have the same tombstone set (n1 tombstoned, n2 re-added)
        // Verify tombstones are consistent across shards
        let shard0_tomb = store.shards[0].tombstones().node_count();
        for shard in &store.shards[1..] {
            assert_eq!(
                shard.tombstones().node_count(),
                shard0_tomb,
                "All shards should have same tombstone count"
            );
        }
    }

    #[test]
    fn test_commit_batch_with_protected_types() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut ms = ManifestStore::ephemeral();

        let m1 = make_node("app.js->MODULE", "MODULE", "app", "app.js");
        let f1 = make_node("app.js->FUNCTION->init", "FUNCTION", "init", "app.js");
        store.add_nodes(vec![m1.clone(), f1.clone()]);

        // Re-analyze app.js with protected MODULE type
        let f2 = make_node("app.js->FUNCTION->initV2", "FUNCTION", "initV2", "app.js");
        let delta = store.commit_batch_ext(
            vec![f2.clone()],
            vec![],
            &["app.js".to_string()],
            HashMap::new(),
            &mut ms,
            &["MODULE".to_string()],
        ).unwrap();

        // MODULE node should survive (protected), FUNCTION tombstoned
        assert!(store.get_node(m1.id).is_some(), "MODULE should be protected");
        assert!(store.get_node(f1.id).is_none(), "Old FUNCTION should be tombstoned");
        assert!(store.get_node(f2.id).is_some(), "New FUNCTION should exist");

        // nodes_removed should NOT include the protected MODULE
        assert_eq!(delta.nodes_removed, 1, "Only FUNCTION should be removed");
    }

    #[test]
    fn test_commit_batch_edges_removed_count() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut ms = ManifestStore::ephemeral();

        let n1 = make_node("a.js->f1", "FUNCTION", "f1", "a.js");
        let n2 = make_node("a.js->f2", "FUNCTION", "f2", "a.js");
        store.add_nodes(vec![n1.clone(), n2.clone()]);

        let e1 = EdgeRecordV2 {
            src: n1.id, dst: n2.id,
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        };
        store.upsert_edges(vec![e1]).unwrap();

        // Re-analyze a.js — should report 1 edge removed
        let n3 = make_node("a.js->f3", "FUNCTION", "f3", "a.js");
        let delta = store.commit_batch(
            vec![n3],
            vec![],
            &["a.js".to_string()],
            HashMap::new(),
            &mut ms,
        ).unwrap();

        assert_eq!(delta.edges_removed, 1, "n1→n2 CALLS edge should be removed");
        assert_eq!(delta.nodes_removed, 2, "n1 and n2 should be removed");
    }

    #[test]
    fn test_commit_batch_performance_scaling() {
        // Regression test: 25 sequential batches should NOT degrade O(N²).
        // Last batch should be within 5x of first batch.
        use std::time::Instant;

        let mut store = MultiShardStore::ephemeral(4);
        let mut ms = ManifestStore::ephemeral();

        let batch_count = 25;
        let nodes_per_batch = 50;
        let mut batch_times: Vec<u128> = Vec::new();

        for batch_idx in 0..batch_count {
            let file = format!("src/batch_{}.js", batch_idx);
            let nodes: Vec<NodeRecordV2> = (0..nodes_per_batch)
                .map(|i| {
                    make_node(
                        &format!("{}->{}", file, i),
                        "FUNCTION",
                        &format!("fn_{}", i),
                        &file,
                    )
                })
                .collect();

            let t = Instant::now();
            store
                .commit_batch(nodes, vec![], &[file], HashMap::new(), &mut ms)
                .unwrap();
            batch_times.push(t.elapsed().as_micros());
        }

        let first = batch_times[0] as f64;
        let last = *batch_times.last().unwrap() as f64;

        // With O(N²), last/first ratio would be ~25x.
        // With O(N), last/first should be ~1-2x.
        let ratio = last / first;
        assert!(
            ratio < 5.0,
            "Last batch took {:.1}x the first batch ({:.0}µs vs {:.0}µs). \
             O(N²) regression detected.",
            ratio,
            last,
            first,
        );
    }

    // -- MVCC Snapshot Reads (RFD-71 B1) ----------------------------------------

    /// Equivalence: snapshot reads on the CURRENT version must match the live
    /// read path for all committed data (nodes, edges, counts, by-type).
    /// The only difference (write-buffer freshness) is invisible here because
    /// commit_batch flushes the buffer to immutable segments before publishing.
    #[test]
    fn test_snapshot_reads_equivalent_to_live() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest = ManifestStore::ephemeral();

        let n1 = make_node("a/fn1", "FUNCTION", "fn1", "a/file.js");
        let n2 = make_node("a/fn2", "FUNCTION", "fn2", "a/file.js");
        let n3 = make_node("b/cls1", "CLASS", "cls1", "b/file.js");
        let e1 = make_edge("a/fn1", "a/fn2", "CALLS");
        let e2 = make_edge("a/fn1", "b/cls1", "CONTAINS");

        store
            .commit_batch(
                vec![n1.clone(), n2.clone(), n3.clone()],
                vec![e1.clone(), e2.clone()],
                &["a/file.js".to_string(), "b/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();

        let snap = store.snapshot(&manifest);

        // get_node / node_exists
        for n in [&n1, &n2, &n3] {
            assert_eq!(store.get_node_at(&snap, n.id), store.get_node(n.id));
            assert!(store.get_node_at(&snap, n.id).is_some());
            assert_eq!(store.node_exists_at(&snap, n.id), store.node_exists(n.id));
        }
        assert!(store.get_node_at(&snap, 0xdead_beef).is_none());
        assert!(!store.node_exists_at(&snap, 0xdead_beef));

        // node_count + count_by_type
        let live_total: usize = store.count_by_type().values().sum();
        assert_eq!(store.node_count_at(&snap), 3);
        assert_eq!(store.node_count_at(&snap), live_total);
        assert_eq!(store.count_by_type_at(&snap), store.count_by_type());

        // find_nodes (all, by type, by file)
        let mut snap_all: Vec<u128> =
            store.find_nodes_at(&snap, None, None).iter().map(|n| n.id).collect();
        let mut live_all: Vec<u128> =
            store.find_nodes(None, None).iter().map(|n| n.id).collect();
        snap_all.sort_unstable();
        live_all.sort_unstable();
        assert_eq!(snap_all, live_all);

        let snap_fns = store.find_nodes_at(&snap, Some("FUNCTION"), None);
        assert_eq!(snap_fns.len(), 2);
        assert!(snap_fns.iter().all(|n| n.node_type == "FUNCTION"));
        let snap_b = store.find_nodes_at(&snap, None, Some("b/file.js"));
        assert_eq!(snap_b.len(), 1);
        assert_eq!(snap_b[0].id, n3.id);

        // outgoing / incoming / by-type / iter_all
        let mut snap_out: Vec<u128> = store
            .get_outgoing_edges_at(&snap, n1.id, None)
            .iter()
            .map(|e| e.dst)
            .collect();
        let mut live_out: Vec<u128> =
            store.get_outgoing_edges(n1.id, None).iter().map(|e| e.dst).collect();
        snap_out.sort_unstable();
        live_out.sort_unstable();
        assert_eq!(snap_out, live_out);
        assert_eq!(snap_out.len(), 2);

        let calls_only = store.get_outgoing_edges_at(&snap, n1.id, Some(&["CALLS"]));
        assert_eq!(calls_only.len(), 1);
        assert_eq!(calls_only[0].edge_type, "CALLS");

        let incoming = store.get_incoming_edges_at(&snap, n2.id, None);
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].src, n1.id);

        assert_eq!(store.get_edges_by_type_at(&snap, "CALLS").len(), 1);
        assert_eq!(store.get_edges_by_type_at(&snap, "CONTAINS").len(), 1);
        assert_eq!(store.iter_all_edges_at(&snap).len(), 2);
    }

    /// The CORE MVCC property: a captured snapshot is version-pinned. After more
    /// commits (add + re-analyze/tombstone), reads through the OLD snapshot still
    /// return the OLD version's state; a FRESH snapshot returns the new state.
    #[test]
    fn test_snapshot_version_isolation() {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest = ManifestStore::ephemeral();

        // Commit 1: file a/file.js has nodeA + nodeB, with an edge A->B.
        let a_v1 = make_node_with_hash("a/nodeA", "FUNCTION", "nodeA", "a/file.js", 11);
        let b = make_node_with_hash("a/nodeB", "FUNCTION", "nodeB", "a/file.js", 22);
        let ab = make_edge("a/nodeA", "a/nodeB", "CALLS");
        store
            .commit_batch(
                vec![a_v1.clone(), b.clone()],
                vec![ab.clone()],
                &["a/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();

        // Pin the snapshot of version V (2 nodes, 1 edge, A has hash 11).
        let snap_v1 = store.snapshot(&manifest);
        assert_eq!(store.node_count_at(&snap_v1), 2);
        assert_eq!(store.get_node_at(&snap_v1, a_v1.id).unwrap().content_hash, 11);
        assert_eq!(store.iter_all_edges_at(&snap_v1).len(), 1);

        // Commit 2: re-analyze a/file.js — nodeA gets a NEW content hash (33),
        // nodeB is DROPPED (so it must be tombstoned), edge A->B removed, and a
        // brand-new file b/file.js adds nodeC.
        let a_v2 = make_node_with_hash("a/nodeA", "FUNCTION", "nodeA", "a/file.js", 33);
        let c = make_node_with_hash("b/nodeC", "CLASS", "nodeC", "b/file.js", 44);
        store
            .commit_batch(
                vec![a_v2.clone(), c.clone()],
                vec![],
                &["a/file.js".to_string(), "b/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();

        // ── OLD snapshot is UNCHANGED (version isolation) ──
        assert_eq!(
            store.node_count_at(&snap_v1),
            2,
            "old snapshot must still see exactly the v1 node set"
        );
        // A still has the OLD hash; B is still alive; C does not exist yet.
        assert_eq!(
            store.get_node_at(&snap_v1, a_v1.id).unwrap().content_hash,
            11,
            "old snapshot must see A's v1 content hash, not the re-analyzed one"
        );
        assert!(
            store.node_exists_at(&snap_v1, b.id),
            "old snapshot must still see nodeB (tombstoned only in the new version)"
        );
        assert!(
            store.get_node_at(&snap_v1, c.id).is_none(),
            "old snapshot must NOT see nodeC from the later commit"
        );
        assert_eq!(
            store.iter_all_edges_at(&snap_v1).len(),
            1,
            "old snapshot must still see the A->B edge"
        );

        // ── FRESH snapshot sees the NEW state ──
        let snap_v2 = store.snapshot(&manifest);
        assert!(snap_v2.version > snap_v1.version, "new snapshot is a later version");
        assert_eq!(
            store.node_count_at(&snap_v2),
            2,
            "new version: A (re-analyzed) + C; B tombstoned"
        );
        assert_eq!(
            store.get_node_at(&snap_v2, a_v1.id).unwrap().content_hash,
            33,
            "new snapshot sees A's re-analyzed content hash"
        );
        assert!(
            !store.node_exists_at(&snap_v2, b.id),
            "new snapshot must NOT see tombstoned nodeB"
        );
        assert!(
            store.node_exists_at(&snap_v2, c.id),
            "new snapshot sees the newly added nodeC"
        );
        assert_eq!(
            store.iter_all_edges_at(&snap_v2).len(),
            0,
            "new version dropped the A->B edge"
        );

        // Sanity: the FRESH snapshot matches the LIVE read path.
        let live_total: usize = store.count_by_type().values().sum();
        assert_eq!(store.node_count_at(&snap_v2), live_total);
        assert_eq!(store.get_node_at(&snap_v2, a_v1.id), store.get_node(a_v1.id));
        assert_eq!(store.node_exists_at(&snap_v2, b.id), store.node_exists(b.id));
    }

    /// Disk-backed equivalent of version isolation: exercises the SegmentCache
    /// (real `NodeSegmentV2::open` from files) rather than the ephemeral live-shard
    /// fallback, and proves the captured snapshot stays pinned across commits.
    #[test]
    fn test_snapshot_version_isolation_disk() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path();
        let mut store = MultiShardStore::create(db_path, 4).unwrap();
        let mut manifest = ManifestStore::create(db_path).unwrap();

        let a_v1 = make_node_with_hash("a/nodeA", "FUNCTION", "nodeA", "a/file.js", 11);
        let b = make_node_with_hash("a/nodeB", "FUNCTION", "nodeB", "a/file.js", 22);
        store
            .commit_batch(
                vec![a_v1.clone(), b.clone()],
                vec![make_edge("a/nodeA", "a/nodeB", "CALLS")],
                &["a/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();

        let snap_v1 = store.snapshot(&manifest);
        assert_eq!(store.node_count_at(&snap_v1), 2);
        assert_eq!(store.get_node_at(&snap_v1, a_v1.id).unwrap().content_hash, 11);
        assert_eq!(store.get_node_at(&snap_v1, a_v1.id), store.get_node(a_v1.id));

        // Re-analyze: A new hash, B dropped (tombstoned).
        let a_v2 = make_node_with_hash("a/nodeA", "FUNCTION", "nodeA", "a/file.js", 33);
        store
            .commit_batch(
                vec![a_v2.clone()],
                vec![],
                &["a/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();

        // Old snapshot pinned: A=11, B alive, 1 edge.
        assert_eq!(store.node_count_at(&snap_v1), 2);
        assert_eq!(store.get_node_at(&snap_v1, a_v1.id).unwrap().content_hash, 11);
        assert!(store.node_exists_at(&snap_v1, b.id));
        assert_eq!(store.iter_all_edges_at(&snap_v1).len(), 1);

        // Fresh snapshot: A=33, B tombstoned, edge gone.
        let snap_v2 = store.snapshot(&manifest);
        assert!(snap_v2.version > snap_v1.version);
        assert_eq!(store.get_node_at(&snap_v2, a_v1.id).unwrap().content_hash, 33);
        assert!(!store.node_exists_at(&snap_v2, b.id));
        assert_eq!(store.node_count_at(&snap_v2), 1);
        assert_eq!(store.iter_all_edges_at(&snap_v2).len(), 0);

        // SegmentCache actually opened segments (disk path exercised).
        assert!(!store.segment_cache.is_empty());
    }

    // ── MVCC B4: concurrent commit (commit_batch_private) ──────────────

    /// Single-thread sanity: a `commit_batch_private` re-analysis tombstones the
    /// old node and adds the new one, exactly like the serial path, with reads
    /// resolved through a fresh snapshot.
    #[test]
    fn b4_private_commit_single_thread_replaces_node() {
        use std::sync::Mutex;
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("b4_single.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let store = MultiShardStore::create(&db_path, 4).unwrap();
        let manifest = Mutex::new(ManifestStore::create(&db_path).unwrap());

        let file = "src/x.js".to_string();
        let v1 = make_node("FUNCTION:old@src/x.js", "FUNCTION", "old", &file);
        store
            .commit_batch_private(vec![v1.clone()], vec![], &[file.clone()], HashMap::new(), &manifest, &[])
            .unwrap();

        // Re-analyze the file: drop `old`, add `new`.
        let v2 = make_node("FUNCTION:new@src/x.js", "FUNCTION", "new", &file);
        let delta = store
            .commit_batch_private(vec![v2.clone()], vec![], &[file.clone()], HashMap::new(), &manifest, &[])
            .unwrap();
        assert_eq!(delta.nodes_added, 1, "new node is purely new");
        assert_eq!(delta.nodes_removed, 1, "old node tombstoned");

        let snap = store.snapshot(&manifest.lock().unwrap());
        assert!(!store.node_exists_at(&snap, v1.id), "old node gone");
        assert!(store.node_exists_at(&snap, v2.id), "new node present");
        assert_eq!(store.node_count_at(&snap), 1);
    }

    /// Concurrency integrity + liveness: N threads each repeatedly commit their
    /// OWN disjoint file via `commit_batch_private`. After the storm the live
    /// node count == an independent oracle and no deadlock/hang occurred.
    ///
    /// MANDATORY in-process watchdog: aborts the process after a hard timeout so
    /// a deadlock FAILS LOUD instead of hanging (per B4 acceptance).
    #[test]
    fn b4_private_commit_concurrent_disjoint_integrity() {
        use std::sync::{Arc as StdArc, Mutex};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::thread;
        use std::time::{Duration, Instant};

        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("b4_concurrent.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let store = StdArc::new(MultiShardStore::create(&db_path, 8).unwrap());
        let manifest = StdArc::new(Mutex::new(ManifestStore::create(&db_path).unwrap()));

        // ── Watchdog ──
        let done = StdArc::new(AtomicBool::new(false));
        let done_w = StdArc::clone(&done);
        let watchdog = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(60);
            while Instant::now() < deadline {
                if done_w.load(Ordering::Relaxed) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            eprintln!("B4 WATCHDOG: concurrent disjoint test exceeded 60s — DEADLOCK. Aborting.");
            std::process::abort();
        });

        const THREADS: usize = 12;
        const ROUNDS: usize = 8;

        let handles: Vec<_> = (0..THREADS)
            .map(|t| {
                let store = StdArc::clone(&store);
                let manifest = StdArc::clone(&manifest);
                thread::spawn(move || {
                    let file = format!("src/dir{}/file{}.js", t, t);
                    for r in 0..ROUNDS {
                        // Each round re-analyzes this thread's file with 1 fresh node.
                        let node = make_node(
                            &format!("FUNCTION:f{}_{}@{}", t, r, file),
                            "FUNCTION",
                            &format!("f{}_{}", t, r),
                            &file,
                        );
                        // Disjoint files ⇒ never conflicts; .unwrap() asserts that.
                        store
                            .commit_batch_private(
                                vec![node],
                                vec![],
                                &[file.clone()],
                                HashMap::new(),
                                &manifest,
                                &[],
                            )
                            .expect("disjoint-file commit must not conflict");
                    }
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }
        done.store(true, Ordering::Relaxed);
        watchdog.join().unwrap();

        // Oracle: each thread re-analyzed its file ROUNDS times, each commit
        // tombstones the prior round's node and adds one ⇒ exactly THREADS live
        // nodes survive (the last round of each file).
        let snap = store.snapshot(&manifest.lock().unwrap());
        assert_eq!(
            store.node_count_at(&snap),
            THREADS,
            "live node count must equal #threads (one surviving node per disjoint file)"
        );
        // No conflicts on disjoint files.
        assert_eq!(store.commit_conflict_retries(), 0, "disjoint files must not conflict");

        // Reopen fidelity ×1: the published version replays bit-faithfully.
        drop(snap);
        let reopened_manifest = ManifestStore::open(&db_path).unwrap();
        let reopened = MultiShardStore::open(&db_path, &reopened_manifest).unwrap();
        let rsnap = reopened.snapshot(&reopened_manifest);
        assert_eq!(
            reopened.node_count_at(&rsnap),
            THREADS,
            "reopen must preserve the live node count"
        );
    }

    /// Conflict-retry: two threads hammer the SAME file concurrently. The store
    /// must detect write-write conflicts (counter increments), exactly one wins
    /// per round, and the final state is correct (no corruption, no lost file).
    #[test]
    fn b4_private_commit_same_file_conflict_retry() {
        use std::sync::{Arc as StdArc, Mutex};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::thread;
        use std::time::{Duration, Instant};

        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("b4_conflict.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();

        let store = StdArc::new(MultiShardStore::create(&db_path, 4).unwrap());
        let manifest = StdArc::new(Mutex::new(ManifestStore::create(&db_path).unwrap()));

        // Seed the file once so a conflict-map entry exists.
        let file = "src/hot.js".to_string();
        store
            .commit_batch_private(
                vec![make_node("FUNCTION:seed@src/hot.js", "FUNCTION", "seed", &file)],
                vec![],
                &[file.clone()],
                HashMap::new(),
                &manifest,
                &[],
            )
            .unwrap();

        let done = StdArc::new(AtomicBool::new(false));
        let done_w = StdArc::clone(&done);
        let watchdog = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(60);
            while Instant::now() < deadline {
                if done_w.load(Ordering::Relaxed) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            eprintln!("B4 WATCHDOG: same-file conflict test exceeded 60s — DEADLOCK. Aborting.");
            std::process::abort();
        });

        const THREADS: usize = 4;
        const ROUNDS: usize = 10;

        let handles: Vec<_> = (0..THREADS)
            .map(|t| {
                let store = StdArc::clone(&store);
                let manifest = StdArc::clone(&manifest);
                let file = file.clone();
                thread::spawn(move || {
                    for r in 0..ROUNDS {
                        let node = make_node(
                            &format!("FUNCTION:w{}_{}@{}", t, r, file),
                            "FUNCTION",
                            &format!("w{}_{}", t, r),
                            &file,
                        );
                        // Bounded retry-on-conflict (the caller contract).
                        let mut attempt = 0;
                        loop {
                            match store.commit_batch_private(
                                vec![node.clone()],
                                vec![],
                                &[file.clone()],
                                HashMap::new(),
                                &manifest,
                                &[],
                            ) {
                                Ok(_) => break,
                                Err(GraphError::ConflictedCommit { .. }) => {
                                    attempt += 1;
                                    assert!(attempt < 64, "retry bound exceeded — livelock");
                                    continue;
                                }
                                Err(e) => panic!("unexpected commit error: {}", e),
                            }
                        }
                    }
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }
        done.store(true, Ordering::Relaxed);
        watchdog.join().unwrap();

        // Same-file contention ⇒ the conflict counter MUST have fired.
        assert!(
            store.commit_conflict_retries() > 0,
            "concurrent same-file commits must produce conflict-retries (got 0)"
        );

        // Final state correct: exactly ONE live node remains for the file (each
        // commit tombstones the file's prior node and adds one — last writer
        // wins per round, no corruption, no lost file).
        let snap = store.snapshot(&manifest.lock().unwrap());
        assert_eq!(
            store.node_count_at(&snap),
            1,
            "exactly one surviving node for the single hot file"
        );
    }

    /// REAL parallelism measurement (B4 acceptance #2). N threads each commit
    /// DISJOINT files repeatedly; compare wall-clock to the SAME work serialized
    /// on one thread. Prints the speedup. The build+flush (segment I/O) runs
    /// fully outside any lock, so it should overlap across cores. Asserts a
    /// modest lower bound to guard against accidental re-serialization.
    ///
    /// `#[ignore]` by default (it's a timing probe; run with `--ignored`).
    #[test]
    #[ignore]
    fn b4_private_commit_parallelism_speedup() {
        use std::sync::{Arc as StdArc, Mutex};
        use std::thread;
        use std::time::Instant;
        use crate::storage_v2::manifest::DurabilityMode;

        const THREADS: usize = 8;
        const COMMITS_PER_THREAD: usize = 8;
        const NODES_PER_COMMIT: usize = 4000;
        // Production uses Strict (fsync per commit). The fsync'd commit-point
        // append serializes, but the lock-free build+flush (the bulk of a real
        // whole-file re-analysis commit) overlaps across cores. With realistic
        // commit sizes the build dominates ⇒ real speedup even under Strict.
        let durability = DurabilityMode::Strict;

        // Build the per-thread workload up front (excluded from timing).
        let make_workload = |t: usize| -> Vec<(String, Vec<NodeRecordV2>)> {
            (0..COMMITS_PER_THREAD)
                .map(|c| {
                    let file = format!("src/d{}/f{}_{}.js", t, t, c);
                    let nodes: Vec<NodeRecordV2> = (0..NODES_PER_COMMIT)
                        .map(|n| {
                            make_node(
                                &format!("FUNCTION:t{}c{}n{}@{}", t, c, n, file),
                                "FUNCTION",
                                &format!("t{}c{}n{}", t, c, n),
                                &file,
                            )
                        })
                        .collect();
                    (file, nodes)
                })
                .collect()
        };

        // ── Serial baseline ──
        let serial = {
            let dir = tempfile::TempDir::new().unwrap();
            let db_path = dir.path().join("b4_serial.rfdb");
            std::fs::create_dir_all(&db_path).unwrap();
            let store = MultiShardStore::create(&db_path, THREADS as u16).unwrap();
            let manifest = Mutex::new(ManifestStore::create_with_config(&db_path, durability).unwrap());
            let workloads: Vec<_> = (0..THREADS).map(make_workload).collect();
            let t0 = Instant::now();
            for wl in &workloads {
                for (file, nodes) in wl {
                    store
                        .commit_batch_private(nodes.clone(), vec![], &[file.clone()], HashMap::new(), &manifest, &[])
                        .unwrap();
                }
            }
            t0.elapsed()
        };

        // ── Concurrent ──
        let concurrent = {
            let dir = tempfile::TempDir::new().unwrap();
            let db_path = dir.path().join("b4_par.rfdb");
            std::fs::create_dir_all(&db_path).unwrap();
            let store = StdArc::new(MultiShardStore::create(&db_path, THREADS as u16).unwrap());
            let manifest = StdArc::new(Mutex::new(ManifestStore::create_with_config(&db_path, durability).unwrap()));
            let workloads: Vec<_> = (0..THREADS).map(make_workload).collect();
            let t0 = Instant::now();
            let handles: Vec<_> = workloads
                .into_iter()
                .map(|wl| {
                    let store = StdArc::clone(&store);
                    let manifest = StdArc::clone(&manifest);
                    thread::spawn(move || {
                        for (file, nodes) in wl {
                            store
                                .commit_batch_private(nodes, vec![], &[file], HashMap::new(), &manifest, &[])
                                .unwrap();
                        }
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }
            t0.elapsed()
        };

        let speedup = serial.as_secs_f64() / concurrent.as_secs_f64();
        eprintln!(
            "B4 parallelism: serial={:?}, concurrent={:?}, speedup={:.2}x ({} threads, {} commits/thread, {} nodes/commit)",
            serial, concurrent, speedup, THREADS, COMMITS_PER_THREAD, NODES_PER_COMMIT,
        );
        assert!(
            speedup > 1.3,
            "expected >1.3x speedup from concurrent commits, got {:.2}x (serial={:?}, concurrent={:?})",
            speedup, serial, concurrent
        );
    }
}
