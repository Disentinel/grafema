//! Manifest chain + snapshot management for RFDB v2 storage.
//!
//! Implements Delta Lake transaction log pattern: immutable manifests +
//! cached index + atomic pointer swap = ACID commits with O(1) metadata
//! operations.
//!
//! # Storage Layout
//!
//! ```text
//! <name>.rfdb/
//! +-- current.json                  # Atomic pointer: {"version": 5}
//! +-- manifest_index.json           # Index: snapshot metadata + tag index + referenced segments
//! +-- manifests/
//! |   +-- 000001.json               # Manifest v1 (immutable after commit)
//! |   +-- 000002.json
//! |   +-- ...
//! +-- segments/
//! |   +-- seg_000001_nodes.seg      # Immutable segments
//! |   +-- seg_000001_edges.seg
//! |   +-- ...
//! +-- gc/                           # Segments pending deletion
//! ```
//!
//! # Commit Protocol
//!
//! 1. Write `manifests/{version:06}.json` (atomic: temp + fsync + rename)
//! 2. Update in-memory index
//! 3. Write `manifest_index.json` (atomic: temp + fsync + rename)
//! 4. Write `current.json` (atomic: temp + fsync + rename)
//! 5. Update in-memory cache
//!
//! Crash at any step leaves the database in a consistent state:
//! - Before step 4: old current pointer, old index (both valid)
//! - After step 4: new current pointer, new index (both valid)

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{GraphError, Result};
use crate::storage_v2::compaction::CompactionInfo;
use crate::storage_v2::shard::TombstoneSet;
use crate::storage_v2::types::{SegmentMeta, SegmentType};

// ── Durability Mode ────────────────────────────────────────────────

/// Durability mode for manifest writes.
///
/// Strict: Full fsync protocol (manifest + current pointer + directory).
///         Ensures crash safety at cost of ~5-10ms commit latency.
///
/// Relaxed: Skip fsync (OS buffers writes). Best-effort durability.
///          Faster commits (~1ms), but crash may lose recent commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DurabilityMode {
    /// Fsync everything (safe default)
    #[default]
    Strict,
    /// Skip fsync (OS handles flush)
    Relaxed,
}

// ── VersionPins (MVCC B5) ──────────────────────────────────────────

/// Live-reader version pin registry (MVCC B5).
///
/// Every live [`ReadSnapshot`](crate::storage_v2::read_snapshot::ReadSnapshot)
/// pins the manifest version it captured. GC/compaction must NEVER reclaim a
/// segment file referenced by a version that a live reader still pins
/// (deleting a segment under a live `mmap` is a use-after-free / UB hazard).
///
/// Implementation: a refcount per pinned version. A snapshot increments its
/// version's count on capture (and clone) and decrements on drop. The store
/// queries [`Self::min_pinned`] — the smallest version with a non-zero count —
/// and the GC retention rule keeps every version `>= min_pinned`.
///
/// Shared via `Arc` between the `ManifestStore` (which the GC runs on) and
/// every `ReadSnapshot` (which may outlive any borrow of the store), so the
/// pin survives independently of the manifest lock.
#[derive(Debug, Default)]
pub struct VersionPins {
    /// version -> live-reader refcount. Only non-zero entries are retained;
    /// a count that reaches zero removes the key (so `keys().min()` is the
    /// minimum live-pinned version directly).
    counts: std::sync::Mutex<std::collections::BTreeMap<u64, usize>>,
}

impl VersionPins {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register one live reader on `version` (called by `ReadSnapshot::capture`
    /// and its `Clone`). Saturating add: a refcount overflow is treated as
    /// "pinned forever" (conservative — never under-counts a live pin).
    pub fn pin(&self, version: u64) {
        let mut g = self.counts.lock().unwrap();
        let c = g.entry(version).or_insert(0);
        *c = c.saturating_add(1);
    }

    /// Release one live reader on `version` (called by `ReadSnapshot::drop`).
    /// Removes the entry when the count reaches zero. Underflow (more unpins
    /// than pins) is impossible by construction (every unpin pairs with a pin),
    /// but is handled defensively by removing the entry — never wraps to a huge
    /// count that would pin forever.
    pub fn unpin(&self, version: u64) {
        let mut g = self.counts.lock().unwrap();
        if let Some(c) = g.get_mut(&version) {
            *c = c.saturating_sub(1);
            if *c == 0 {
                g.remove(&version);
            }
        }
    }

    /// The smallest version still pinned by a live reader, or `None` if no
    /// reader is live. GC retains every version `>= min_pinned`.
    pub fn min_pinned(&self) -> Option<u64> {
        self.counts.lock().unwrap().keys().next().copied()
    }

    /// Total number of distinct pinned versions (diagnostics/tests).
    pub fn pinned_version_count(&self) -> usize {
        self.counts.lock().unwrap().len()
    }
}

// ── Manifest ───────────────────────────────────────────────────────

/// serde `skip_serializing_if` predicate for `Arc<Vec<_>>` fields (MVCC C3.b).
/// Matches the prior `Vec::is_empty` behaviour so the on-disk JSON is byte-for-byte
/// identical to the pre-Arc format (empty L1 lists are omitted).
fn arc_vec_is_empty<T>(v: &Arc<Vec<T>>) -> bool {
    v.is_empty()
}

/// Manifest: immutable snapshot descriptor.
///
/// Each manifest represents a consistent point-in-time view of the database.
/// Manifests are immutable after commit except for tags (which can be modified
/// atomically via separate write).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    /// Manifest version (sequential, monotonic, gaps allowed after crash recovery)
    pub version: u64,

    /// Creation timestamp (Unix epoch seconds)
    pub created_at: u64,

    /// Active node segments in this snapshot.
    ///
    /// MVCC C3.b: held behind `Arc` so `ReadSnapshot::capture` is O(1)
    /// (`Arc::clone`, no deep clone of the descriptor `Vec` + its per-descriptor
    /// zone-map `HashSet`s). Copy-on-write: a version that changes the segment
    /// set rebuilds a fresh `Arc<Vec>` (via `Arc::make_mut`), so older snapshots
    /// that hold an `Arc::clone` keep observing their own immutable set.
    pub node_segments: Arc<Vec<SegmentDescriptor>>,

    /// Active edge segments in this snapshot (see [`Self::node_segments`] for the
    /// MVCC C3.b `Arc` copy-on-write rationale).
    pub edge_segments: Arc<Vec<SegmentDescriptor>>,

    /// Optional tags for snapshot identification.
    /// Empty HashMap = no tags. Common tags:
    /// - "analysis_run": "success" | "failed"
    /// - "commit_sha": git commit hash
    /// - "build_number": CI build identifier
    #[serde(default)]
    pub tags: HashMap<String, String>,

    /// Pre-computed aggregate statistics
    pub stats: ManifestStats,

    /// Previous manifest version (None for first manifest, v1)
    /// Enables chain traversal without directory scanning.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_version: Option<u64>,

    /// Tombstoned node IDs (logically deleted).
    /// Query path skips records matching these IDs.
    /// Cleared by compaction (T4.x).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tombstoned_node_ids: Vec<u128>,

    /// Tombstoned edge keys (src, dst, edge_type).
    /// Query path skips matching edges.
    /// Cleared by compaction (T4.x).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tombstoned_edge_keys: Vec<(u128, u128, String)>,

    /// L1 (compacted) node segment descriptors — at most one per shard.
    /// Populated by compaction, empty before first compaction.
    /// MVCC C3.b: `Arc` for O(1) snapshot capture (see [`Self::node_segments`]).
    #[serde(default, skip_serializing_if = "arc_vec_is_empty")]
    pub l1_node_segments: Arc<Vec<SegmentDescriptor>>,

    /// L1 (compacted) edge segment descriptors — at most one per shard.
    /// MVCC C3.b: `Arc` for O(1) snapshot capture (see [`Self::node_segments`]).
    #[serde(default, skip_serializing_if = "arc_vec_is_empty")]
    pub l1_edge_segments: Arc<Vec<SegmentDescriptor>>,

    /// Metadata about the last compaction (None if never compacted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction: Option<CompactionInfo>,
}

// ── Manifest Edit (incremental / delta) ────────────────────────────

/// Commits between full checkpoints. Between checkpoints each commit writes
/// only a `ManifestEdit` (O(Δ)); `open()` replays at most this many edits on
/// top of the latest checkpoint to rebuild the full snapshot.
pub const MANIFEST_CHECKPOINT_INTERVAL: u64 = 32;

/// One incremental manifest change — Delta-Lake / LevelDB VersionEdit style.
///
/// Written per commit as `manifests/{version:06}.edit.json` instead of a full
/// `Manifest` snapshot, so per-commit write cost is O(Δ) (segments and
/// tombstones changed *this* commit) rather than O(total segments). The full
/// active state is reconstructed by replaying edits on top of the latest
/// checkpoint (a full `Manifest` written every `MANIFEST_CHECKPOINT_INTERVAL`).
///
/// Backward compatible: a database whose every version is a full snapshot
/// (pre-delta format) is just a degenerate chain where every version is a
/// checkpoint and no edits exist.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestEdit {
    /// Version this edit produces.
    pub version: u64,
    /// Parent version (must equal the manifest version this edit applies to).
    pub parent_version: u64,
    /// Advisory: checkpoint version this edit chain replays from. `open()`
    /// locates the actual base by directory scan, so this is a debug hint only.
    pub base_checkpoint: u64,
    /// Creation timestamp (Unix epoch seconds).
    pub created_at: u64,

    /// L0 segments added this commit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_node_segments: Vec<SegmentDescriptor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_edge_segments: Vec<SegmentDescriptor>,
    /// Segment ids removed this commit (e.g. compacted away).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_node_segment_ids: Vec<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_edge_segment_ids: Vec<u64>,

    /// Tombstone deltas. `added_*` newly tombstoned this commit; `removed_*`
    /// un-tombstoned (a deleted id re-added, or cleared by compaction).
    /// Replayed onto the checkpoint's cumulative tombstone set.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_tombstone_nodes: Vec<u128>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_tombstone_nodes: Vec<u128>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_tombstone_edges: Vec<(u128, u128, String)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_tombstone_edges: Vec<(u128, u128, String)>,

    /// Full L1 segment lists when compaction rewrote them (None = unchanged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l1_node_segments: Option<Vec<SegmentDescriptor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l1_edge_segments: Option<Vec<SegmentDescriptor>>,
    /// Compaction metadata when this commit was a compaction (None = unchanged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction: Option<CompactionInfo>,

    /// Tags merged into the snapshot at this version.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub tags: HashMap<String, String>,
    /// Aggregate stats for the resulting snapshot (computed by the caller).
    pub stats: ManifestStats,
}

impl Manifest {
    /// Apply an incremental edit in place, advancing this manifest to
    /// `edit.version`. Replaying the full edit chain on top of a checkpoint
    /// reproduces exactly the snapshot a full-write commit would have produced.
    pub fn apply(&mut self, edit: &ManifestEdit) {
        // Segment removals (by segment_id) then additions.
        // MVCC C3.b: copy-on-write. `Arc::make_mut` clones the inner Vec only when
        // another snapshot still shares this Arc (so that snapshot keeps its own
        // immutable descriptor set); when this manifest holds the sole reference
        // it mutates in place. Only touched when this edit actually changes the
        // node/edge segment set — a tombstone-/tag-only edit leaves the Arc shared
        // (and an unrelated snapshot's capture stays O(1)).
        if !edit.removed_node_segment_ids.is_empty() || !edit.added_node_segments.is_empty() {
            let v = Arc::make_mut(&mut self.node_segments);
            if !edit.removed_node_segment_ids.is_empty() {
                let rm: HashSet<u64> = edit.removed_node_segment_ids.iter().copied().collect();
                v.retain(|s| !rm.contains(&s.segment_id));
            }
            v.extend(edit.added_node_segments.iter().cloned());
        }
        if !edit.removed_edge_segment_ids.is_empty() || !edit.added_edge_segments.is_empty() {
            let v = Arc::make_mut(&mut self.edge_segments);
            if !edit.removed_edge_segment_ids.is_empty() {
                let rm: HashSet<u64> = edit.removed_edge_segment_ids.iter().copied().collect();
                v.retain(|s| !rm.contains(&s.segment_id));
            }
            v.extend(edit.added_edge_segments.iter().cloned());
        }

        // Tombstone delta replay onto cumulative set.
        if !edit.added_tombstone_nodes.is_empty() || !edit.removed_tombstone_nodes.is_empty() {
            let mut set: HashSet<u128> = self.tombstoned_node_ids.iter().copied().collect();
            set.extend(edit.added_tombstone_nodes.iter().copied());
            for id in &edit.removed_tombstone_nodes {
                set.remove(id);
            }
            self.tombstoned_node_ids = set.into_iter().collect();
        }
        if !edit.added_tombstone_edges.is_empty() || !edit.removed_tombstone_edges.is_empty() {
            let mut set: HashSet<(u128, u128, String)> =
                self.tombstoned_edge_keys.iter().cloned().collect();
            set.extend(edit.added_tombstone_edges.iter().cloned());
            for k in &edit.removed_tombstone_edges {
                set.remove(k);
            }
            self.tombstoned_edge_keys = set.into_iter().collect();
        }

        // L1 / compaction: full replace when present (fresh Arc — old snapshots
        // keep their prior L1 set, MVCC C3.b copy-on-write).
        if let Some(l1n) = &edit.l1_node_segments {
            self.l1_node_segments = Arc::new(l1n.clone());
        }
        if let Some(l1e) = &edit.l1_edge_segments {
            self.l1_edge_segments = Arc::new(l1e.clone());
        }
        if edit.last_compaction.is_some() {
            self.last_compaction = edit.last_compaction.clone();
        }

        // Tags: an edit carries the FULL tag set for its version (not a delta),
        // so replace — matching the legacy create_manifest reset-per-commit
        // semantics and keeping live writes, replay, and checkpoints consistent.
        self.tags = edit.tags.clone();

        // Version bookkeeping + precomputed stats.
        self.parent_version = Some(edit.parent_version);
        self.version = edit.version;
        self.created_at = edit.created_at;
        self.stats = edit.stats.clone();
    }
}

/// Reconstruct the full manifest at `target_version` by replaying `edits`
/// (ascending, contiguous by version) on top of `checkpoint`. Errors if the
/// chain is non-contiguous or does not reach `target_version`.
pub fn reconstruct_manifest(
    checkpoint: Manifest,
    edits: &[ManifestEdit],
    target_version: u64,
) -> Result<Manifest> {
    let mut m = checkpoint;
    for edit in edits {
        if edit.parent_version != m.version {
            return Err(GraphError::InvalidFormat(format!(
                "manifest edit chain broken: edit v{} parent {} != current v{}",
                edit.version, edit.parent_version, m.version
            )));
        }
        m.apply(edit);
    }
    if m.version != target_version {
        return Err(GraphError::InvalidFormat(format!(
            "manifest replay reached v{} but target is v{}",
            m.version, target_version
        )));
    }
    Ok(m)
}

// ── Segment Descriptor ─────────────────────────────────────────────

/// Segment descriptor: segment identity + zone map summary.
///
/// Bridges from ephemeral SegmentMeta (returned by writer) to serializable
/// manifest format. Includes zone map data for query planning without opening
/// segments.
///
/// File path is DERIVED at runtime from segment_id + shard_id + segment_type.
/// This enables sharding without manifest rewrites (T2.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentDescriptor {
    /// Unique segment ID (globally monotonic within database).
    /// Generated by ManifestStore::next_segment_id()
    pub segment_id: u64,

    /// Segment type (nodes or edges)
    pub segment_type: SegmentType,

    /// Optional shard ID (None = flat segments/ directory, Some(n) = segments/0n/).
    /// Phase 1: always None. T2.2 adds sharding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shard_id: Option<u16>,

    /// Record count (nodes or edges)
    pub record_count: u64,

    /// File size in bytes
    pub byte_size: u64,

    /// Zone map: node types (empty for edge segments)
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    pub node_types: HashSet<String>,

    /// Zone map: file paths (empty for edge segments)
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    pub file_paths: HashSet<String>,

    /// Zone map: edge types (empty for node segments)
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    pub edge_types: HashSet<String>,
}

impl SegmentDescriptor {
    /// Convert SegmentMeta (from writer) to SegmentDescriptor (for manifest).
    ///
    /// Called after segment writer finishes:
    /// ```ignore
    /// let meta = writer.finish(&mut file)?;
    /// let descriptor = SegmentDescriptor::from_meta(
    ///     store.next_segment_id(),
    ///     SegmentType::Nodes,
    ///     None, // shard_id (Phase 1: always None)
    ///     meta,
    /// );
    /// ```
    pub fn from_meta(
        segment_id: u64,
        segment_type: SegmentType,
        shard_id: Option<u16>,
        meta: SegmentMeta,
    ) -> Self {
        Self {
            segment_id,
            segment_type,
            shard_id,
            record_count: meta.record_count,
            byte_size: meta.byte_size,
            node_types: meta.node_types,
            file_paths: meta.file_paths,
            edge_types: meta.edge_types,
        }
    }

    /// Derive file path from segment_id, shard_id, segment_type.
    ///
    /// Phase 1: shard_id = None -> "segments/seg_000001_nodes.seg"
    /// T2.2: shard_id = Some(5) -> "segments/05/seg_000001_nodes.seg"
    pub fn file_path(&self, db_path: &Path) -> PathBuf {
        let type_suffix = match self.segment_type {
            SegmentType::Nodes => "nodes",
            SegmentType::Edges => "edges",
        };

        let filename = format!("seg_{:06}_{}.seg", self.segment_id, type_suffix);

        if let Some(shard_id) = self.shard_id {
            db_path
                .join("segments")
                .join(format!("{:02}", shard_id))
                .join(filename)
        } else {
            db_path.join("segments").join(filename)
        }
    }

    /// Derive relative path string for logging/debugging.
    pub fn relative_path(&self) -> String {
        let type_suffix = match self.segment_type {
            SegmentType::Nodes => "nodes",
            SegmentType::Edges => "edges",
        };
        let filename = format!("seg_{:06}_{}.seg", self.segment_id, type_suffix);

        if let Some(shard_id) = self.shard_id {
            format!("segments/{:02}/{}", shard_id, filename)
        } else {
            format!("segments/{}", filename)
        }
    }

    /// Check if segment might contain records matching filters.
    /// Returns true if zone maps indicate potential match (false = definite miss).
    pub fn may_contain(
        &self,
        node_type: Option<&str>,
        file_path: Option<&str>,
        edge_type: Option<&str>,
    ) -> bool {
        if let Some(nt) = node_type {
            if !self.node_types.is_empty() && !self.node_types.contains(nt) {
                return false;
            }
        }
        if let Some(fp) = file_path {
            if !self.file_paths.is_empty() && !self.file_paths.contains(fp) {
                return false;
            }
        }
        if let Some(et) = edge_type {
            if !self.edge_types.is_empty() && !self.edge_types.contains(et) {
                return false;
            }
        }
        true
    }
}

// ── Manifest Stats ─────────────────────────────────────────────────

/// Aggregate statistics for a manifest (sum of all segment descriptors).
///
/// Pre-computed to avoid scanning segment list on every query.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestStats {
    /// Total node count across all node segments
    pub total_nodes: u64,

    /// Total edge count across all edge segments
    pub total_edges: u64,

    /// Number of node segments
    pub node_segment_count: u32,

    /// Number of edge segments
    pub edge_segment_count: u32,
}

impl ManifestStats {
    /// Compute stats from segment descriptors.
    pub fn from_segments(
        node_segments: &[SegmentDescriptor],
        edge_segments: &[SegmentDescriptor],
    ) -> Self {
        Self {
            total_nodes: node_segments.iter().map(|s| s.record_count).sum(),
            total_edges: edge_segments.iter().map(|s| s.record_count).sum(),
            node_segment_count: node_segments.len() as u32,
            edge_segment_count: edge_segments.len() as u32,
        }
    }

    /// Validate stats match segment descriptors (debug builds only).
    #[cfg(debug_assertions)]
    pub fn validate(
        &self,
        node_segments: &[SegmentDescriptor],
        edge_segments: &[SegmentDescriptor],
    ) {
        let expected = Self::from_segments(node_segments, edge_segments);
        debug_assert_eq!(
            self.total_nodes, expected.total_nodes,
            "stats mismatch: total_nodes"
        );
        debug_assert_eq!(
            self.total_edges, expected.total_edges,
            "stats mismatch: total_edges"
        );
        debug_assert_eq!(
            self.node_segment_count, expected.node_segment_count,
            "stats mismatch: node_segment_count"
        );
        debug_assert_eq!(
            self.edge_segment_count, expected.edge_segment_count,
            "stats mismatch: edge_segment_count"
        );
    }
}

// ── Snapshot Info ──────────────────────────────────────────────────

/// Lightweight snapshot information for list operations.
///
/// Does NOT include full segment lists (saves memory when listing
/// thousands of snapshots).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotInfo {
    pub version: u64,
    pub created_at: u64,
    pub tags: HashMap<String, String>,
    pub stats: ManifestStats,
}

impl SnapshotInfo {
    /// Extract snapshot info from full manifest.
    pub fn from_manifest(manifest: &Manifest) -> Self {
        Self {
            version: manifest.version,
            created_at: manifest.created_at,
            tags: manifest.tags.clone(),
            stats: manifest.stats,
        }
    }
}

// ── Manifest Index ─────────────────────────────────────────────────

/// ManifestIndex: cached metadata for all snapshots + tag index + GC
/// reference tracking.
///
/// Single-file index that eliminates O(N) operations:
/// - list_snapshots() -> O(1) (read index)
/// - find_snapshot() -> O(1) (tag index lookup)
/// - gc_collect() -> O(F) (scan segments/ dir, check referenced set)
///
/// Updated atomically during commit (written to manifest_index.json.tmp,
/// then renamed).
///
/// Pattern: Apache Iceberg's manifest list file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestIndex {
    /// Latest manifest version (redundant with current.json, but convenient)
    pub latest_version: u64,

    /// All snapshot metadata (sorted by version ascending).
    /// Contains version, created_at, tags, stats for every manifest ever created.
    pub snapshots: Vec<SnapshotInfo>,

    /// Tag index: tag_key -> tag_value -> version.
    /// Enables O(1) find_snapshot() lookup.
    #[serde(default)]
    pub tag_index: HashMap<String, HashMap<String, u64>>,

    /// All segment IDs referenced by ANY active manifest (union across all versions).
    /// Used by GC: segments NOT in this set are unreferenced -> safe to collect.
    pub referenced_segments: HashSet<u64>,
}

impl Default for ManifestIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl ManifestIndex {
    /// Create empty index (for new database).
    pub fn new() -> Self {
        Self {
            latest_version: 0,
            snapshots: Vec::new(),
            tag_index: HashMap::new(),
            referenced_segments: HashSet::new(),
        }
    }

    /// Add snapshot to index (called during commit).
    ///
    /// Complexity: O(T + S) where T = tags, S = segments
    pub fn add_snapshot(&mut self, manifest: &Manifest) {
        self.snapshots.push(SnapshotInfo::from_manifest(manifest));

        for (key, value) in &manifest.tags {
            self.tag_index
                .entry(key.clone())
                .or_default()
                .insert(value.clone(), manifest.version);
        }

        for seg in manifest
            .node_segments
            .iter()
            .chain(manifest.edge_segments.iter())
            .chain(manifest.l1_node_segments.iter())
            .chain(manifest.l1_edge_segments.iter())
        {
            self.referenced_segments.insert(seg.segment_id);
        }

        self.latest_version = manifest.version;
    }

    /// Remove old snapshot from index (called during manifest GC).
    ///
    /// Complexity: O(M + T) where M = snapshots, T = tag entries
    pub fn remove_snapshot(&mut self, version: u64) {
        self.snapshots.retain(|info| info.version != version);

        for tag_values in self.tag_index.values_mut() {
            tag_values.retain(|_, v| *v != version);
        }
        self.tag_index.retain(|_, values| !values.is_empty());
    }

    /// Recalculate referenced_segments from the remaining snapshots' segment data.
    /// Must be called after removing snapshots to keep segment GC accurate.
    pub fn set_referenced_segments(&mut self, segments: HashSet<u64>) {
        self.referenced_segments = segments;
    }

    /// Find snapshot by tag (O(1) lookup).
    pub fn find_by_tag(&self, tag_key: &str, tag_value: &str) -> Option<u64> {
        self.tag_index
            .get(tag_key)
            .and_then(|values| values.get(tag_value))
            .copied()
    }

    /// List snapshots (O(N) where N = matching snapshots).
    pub fn list_snapshots(&self, filter_tag: Option<&str>) -> Vec<SnapshotInfo> {
        if let Some(tag_key) = filter_tag {
            self.snapshots
                .iter()
                .filter(|info| info.tags.contains_key(tag_key))
                .cloned()
                .collect()
        } else {
            self.snapshots.clone()
        }
    }
}

// ── Current Pointer ────────────────────────────────────────────────

/// Atomic pointer to current manifest version.
///
/// Stored in `current.json` at database root. Updated via atomic rename
/// (write to `current.json.tmp`, then rename to `current.json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CurrentPointer {
    /// Current manifest version
    pub version: u64,
}

impl CurrentPointer {
    pub fn new(version: u64) -> Self {
        Self { version }
    }

    /// Read current pointer from database root.
    pub fn read_from(db_path: &Path) -> Result<Self> {
        let path = db_path.join("current.json");
        read_json(&path)
    }

    /// Write current pointer atomically.
    /// Uses temp file + rename pattern for atomicity.
    pub fn write_to(&self, db_path: &Path, durability: DurabilityMode) -> Result<()> {
        let path = db_path.join("current.json");
        atomic_write_json(&path, self, durability)?;

        if durability == DurabilityMode::Strict {
            fsync_directory(db_path)?;
        }

        Ok(())
    }
}

// ── Snapshot Diff ──────────────────────────────────────────────────

/// Diff between two snapshots (from_version -> to_version).
///
/// Computed via HashSet-based set difference on segment IDs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDiff {
    pub from_version: u64,
    pub to_version: u64,

    /// Node segments added in to_version (not in from_version)
    pub added_node_segments: Vec<SegmentDescriptor>,

    /// Node segments removed in to_version (in from_version, not in to_version)
    pub removed_node_segments: Vec<SegmentDescriptor>,

    /// Edge segments added in to_version
    pub added_edge_segments: Vec<SegmentDescriptor>,

    /// Edge segments removed in to_version
    pub removed_edge_segments: Vec<SegmentDescriptor>,

    /// Stats for from_version
    pub stats_from: ManifestStats,

    /// Stats for to_version
    pub stats_to: ManifestStats,
}

impl SnapshotDiff {
    /// Compute diff between two manifests.
    ///
    /// Algorithm: HashSet-based set difference.
    /// Complexity: O(S) where S = total segments in both manifests.
    pub fn compute(from: &Manifest, to: &Manifest) -> Self {
        let from_node_ids: HashSet<u64> = from
            .node_segments
            .iter()
            .map(|s| s.segment_id)
            .collect();
        let to_node_ids: HashSet<u64> =
            to.node_segments.iter().map(|s| s.segment_id).collect();

        let added_node_segments: Vec<SegmentDescriptor> = to
            .node_segments
            .iter()
            .filter(|s| !from_node_ids.contains(&s.segment_id))
            .cloned()
            .collect();

        let removed_node_segments: Vec<SegmentDescriptor> = from
            .node_segments
            .iter()
            .filter(|s| !to_node_ids.contains(&s.segment_id))
            .cloned()
            .collect();

        let from_edge_ids: HashSet<u64> = from
            .edge_segments
            .iter()
            .map(|s| s.segment_id)
            .collect();
        let to_edge_ids: HashSet<u64> =
            to.edge_segments.iter().map(|s| s.segment_id).collect();

        let added_edge_segments: Vec<SegmentDescriptor> = to
            .edge_segments
            .iter()
            .filter(|s| !from_edge_ids.contains(&s.segment_id))
            .cloned()
            .collect();

        let removed_edge_segments: Vec<SegmentDescriptor> = from
            .edge_segments
            .iter()
            .filter(|s| !to_edge_ids.contains(&s.segment_id))
            .cloned()
            .collect();

        Self {
            from_version: from.version,
            to_version: to.version,
            added_node_segments,
            removed_node_segments,
            added_edge_segments,
            removed_edge_segments,
            stats_from: from.stats,
            stats_to: to.stats,
        }
    }

    /// Number of segments changed (added + removed).
    pub fn change_count(&self) -> usize {
        self.added_node_segments.len()
            + self.removed_node_segments.len()
            + self.added_edge_segments.len()
            + self.removed_edge_segments.len()
    }

    /// Is this a no-op diff (no changes)?
    pub fn is_empty(&self) -> bool {
        self.change_count() == 0
    }
}

// ── Manifest Store ─────────────────────────────────────────────────

/// ManifestStore: manages manifest chain + index + current pointer +
/// segment ID allocation.
///
/// NOT `Send + Sync` by default (contains PathBuf, cached Manifest).
/// For multi-threaded access, wrap in `Arc<Mutex<ManifestStore>>`.
pub struct ManifestStore {
    /// Database root path (None for ephemeral databases)
    db_path: Option<PathBuf>,

    /// Current manifest (cached in memory)
    current: Manifest,

    /// Manifest index (cached in memory)
    index: ManifestIndex,

    /// Next segment ID to allocate (thread-safe atomic counter)
    next_segment_id: AtomicU64,

    /// Durability mode (Strict = fsync, Relaxed = no fsync)
    durability: DurabilityMode,

    /// Commits between full checkpoints for the delta-manifest write path
    /// (`commit_edit`). Default `MANIFEST_CHECKPOINT_INTERVAL`; overridable
    /// for tests via `set_checkpoint_interval`.
    checkpoint_interval: u64,

    /// MVCC (RFD-71 B3): the current published version's cumulative tombstone
    /// set, as the authoritative source of truth — a derived `Arc<TombstoneSet>`
    /// mirror of `self.current.tombstoned_node_ids` / `tombstoned_edge_keys`.
    ///
    /// Rebuilt at every commit (and on open) from the in-memory current version.
    /// Snapshots clone this `Arc` (O(1)) so a `ReadSnapshot` freezes exactly the
    /// version's tombstones — no per-shard broadcast, no shared-mutable set. This
    /// is what replaces the old per-shard `Shard.tombstones` broadcast as the
    /// snapshot/version authority.
    current_tombstones: Arc<TombstoneSet>,

    /// MVCC B5: live-reader version pin registry. Shared (`Arc`) with every
    /// `ReadSnapshot` so a pin outlives any borrow of this store. GC consults
    /// `min_pinned()` and retains every version `>= min_pinned`, guaranteeing a
    /// segment file referenced by a live reader's version is never reclaimed.
    version_pins: Arc<VersionPins>,
}

// ── ManifestStore: Constructors ────────────────────────────────────

impl ManifestStore {
    /// Open existing database with specified durability mode.
    ///
    /// Algorithm:
    /// 1. Read current.json -> get version
    /// 2. Load manifests/{version:06}.json
    /// 3. Load manifest_index.json
    /// 4. Validate index consistency (crash recovery)
    /// 5. Initialize next_segment_id = max(index.referenced_segments) + 1
    ///
    /// Complexity: O(S + I) where S = segments in current manifest, I = index size
    pub fn open_with_config(db_path: &Path, durability: DurabilityMode) -> Result<Self> {
        let current_pointer = CurrentPointer::read_from(db_path)?;

        // Delta-manifest reconstruction: locate the latest checkpoint (full
        // snapshot file whose stem parses as a bare version) at or below the
        // current version, then replay any `.edit.json` deltas on top.
        //
        // Backward compatible: a pre-delta database has a full snapshot at
        // every version, so the checkpoint == current version and zero edits
        // are replayed — identical to the old single-file load.
        let current = load_current_with_replay(db_path, current_pointer.version)?;

        let index_path = db_path.join("manifest_index.json");
        let mut index: ManifestIndex = read_json(&index_path)?;

        // Validate index consistency (crash recovery).
        // If the index is out of sync with the current pointer (e.g., crash
        // happened after writing current.json but before writing index, or
        // vice versa), rebuild the index from the manifests/ directory.
        if index.latest_version != current_pointer.version {
            index = rebuild_index(db_path)?;
        }

        let max_segment_id = index.referenced_segments.iter().max().copied().unwrap_or(0);
        let next_segment_id = AtomicU64::new(max_segment_id + 1);

        // MVCC B3: derive the authoritative version tombstone set from the
        // replayed current manifest (load_current_with_replay reconstructs the
        // cumulative set into current.tombstoned_*).
        let current_tombstones = Arc::new(TombstoneSet::from_manifest(
            current.tombstoned_node_ids.clone(),
            current.tombstoned_edge_keys.clone(),
        ));

        Ok(Self {
            db_path: Some(db_path.to_path_buf()),
            current,
            index,
            next_segment_id,
            durability,
            checkpoint_interval: MANIFEST_CHECKPOINT_INTERVAL,
            current_tombstones,
            version_pins: Arc::new(VersionPins::new()),
        })
    }

    /// Open existing database with default durability (Strict).
    pub fn open(db_path: &Path) -> Result<Self> {
        Self::open_with_config(db_path, DurabilityMode::Strict)
    }

    /// Create new database with specified durability mode.
    ///
    /// Creates directories, writes first manifest (v1), empty index, and
    /// current pointer.
    ///
    /// Complexity: O(1)
    pub fn create_with_config(db_path: &Path, durability: DurabilityMode) -> Result<Self> {
        if db_path.join("current.json").exists() {
            return Err(GraphError::InvalidFormat(
                "Database already exists at path".to_string(),
            ));
        }

        std::fs::create_dir_all(db_path.join("manifests"))?;
        std::fs::create_dir_all(db_path.join("segments"))?;
        std::fs::create_dir_all(db_path.join("gc"))?;

        let manifest = Manifest {
            version: 1,
            created_at: current_timestamp(),
            node_segments: Arc::new(Vec::new()),
            edge_segments: Arc::new(Vec::new()),
            tags: HashMap::new(),
            stats: ManifestStats {
                total_nodes: 0,
                total_edges: 0,
                node_segment_count: 0,
                edge_segment_count: 0,
            },
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: Arc::new(Vec::new()),
            l1_edge_segments: Arc::new(Vec::new()),
            last_compaction: None,
        };

        let mut index = ManifestIndex::new();
        index.add_snapshot(&manifest);

        let manifest_path = manifest_file_path(db_path, 1);
        atomic_write_json(&manifest_path, &manifest, durability)?;

        let index_path = db_path.join("manifest_index.json");
        atomic_write_json(&index_path, &index, durability)?;

        let current_pointer = CurrentPointer::new(1);
        current_pointer.write_to(db_path, durability)?;

        Ok(Self {
            db_path: Some(db_path.to_path_buf()),
            current: manifest,
            index,
            next_segment_id: AtomicU64::new(1),
            durability,
            checkpoint_interval: MANIFEST_CHECKPOINT_INTERVAL,
            // Fresh database: no tombstones yet.
            current_tombstones: Arc::new(TombstoneSet::new()),
            version_pins: Arc::new(VersionPins::new()),
        })
    }

    /// Create new database with default durability (Strict).
    pub fn create(db_path: &Path) -> Result<Self> {
        Self::create_with_config(db_path, DurabilityMode::Strict)
    }

    /// Create ephemeral store (in-memory, no disk writes).
    ///
    /// Used for unit tests, temporary analysis graphs, and query-only
    /// databases (no persistence).
    ///
    /// Complexity: O(1)
    pub fn ephemeral() -> Self {
        let manifest = Manifest {
            version: 1,
            created_at: current_timestamp(),
            node_segments: Arc::new(Vec::new()),
            edge_segments: Arc::new(Vec::new()),
            tags: HashMap::new(),
            stats: ManifestStats {
                total_nodes: 0,
                total_edges: 0,
                node_segment_count: 0,
                edge_segment_count: 0,
            },
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: Arc::new(Vec::new()),
            l1_edge_segments: Arc::new(Vec::new()),
            last_compaction: None,
        };

        let mut index = ManifestIndex::new();
        index.add_snapshot(&manifest);

        Self {
            db_path: None,
            current: manifest,
            index,
            next_segment_id: AtomicU64::new(1),
            durability: DurabilityMode::Strict,
            checkpoint_interval: MANIFEST_CHECKPOINT_INTERVAL,
            // Fresh ephemeral store: no tombstones yet.
            current_tombstones: Arc::new(TombstoneSet::new()),
            version_pins: Arc::new(VersionPins::new()),
        }
    }

    /// Override the checkpoint interval (commits between full snapshots) for
    /// the delta-manifest write path. Primarily for tests.
    pub fn set_checkpoint_interval(&mut self, interval: u64) {
        assert!(interval > 0, "checkpoint_interval must be > 0");
        self.checkpoint_interval = interval;
    }
}

// ── ManifestStore: Core Operations ─────────────────────────────────

impl ManifestStore {
    /// Get current manifest (borrowed reference).
    ///
    /// Complexity: O(1) (cached in memory)
    pub fn current(&self) -> &Manifest {
        &self.current
    }

    /// The configured durability mode (Strict = fsync, Relaxed = no fsync).
    ///
    /// Exposed so the lock-free segment-write phase (MVCC C1) can fsync the
    /// immutable segment files BEFORE they become visible via the manifest
    /// commit, without re-serializing the build path through the manifest mutex.
    pub fn durability(&self) -> DurabilityMode {
        self.durability
    }

    /// Runtime durability switch (MVCC C2.1 — bulk-load mode).
    ///
    /// Flips `self.durability`, which the commit/publish point reads under the
    /// manifest Mutex (`multi_shard.rs` reads `m.durability()` while holding the
    /// lock). Always invoked via the engine write lock (`with_engine_write`),
    /// which serializes against all in-flight commits — so there is no race on
    /// the field: any commit that grabs the lock AFTER this call observes the
    /// new mode; a commit already past its `durability()` read finishes in its
    /// old mode (at worst one extra/skipped fsync at the boundary — never a
    /// correctness issue, since `make_durable` re-fsyncs everything anyway).
    ///
    /// `&mut self`: exclusive borrow (callers hold `manifest.get_mut()` or an
    /// engine write lock), so the mutation needs no further synchronization.
    pub fn set_durability(&mut self, mode: DurabilityMode) -> Result<()> {
        self.durability = mode;
        Ok(())
    }

    /// Durable barrier (MVCC C2.2 — end of bulk load).
    ///
    /// Makes the ENTIRE current published manifest version durable in one pass,
    /// regardless of what `Relaxed` mode skipped during the bulk phase. After
    /// this returns `Ok`, a reopen from disk sees the full current state,
    /// bit-faithful (the C2.4 guarantee for "crash AFTER EndBulkLoad").
    ///
    /// Steps (in stable-storage dependency order — data before pointer):
    /// 1. Fsync every segment file referenced by the CURRENT published version
    ///    (all shards, L0 + L1, nodes + edges). These files were already written
    ///    during the bulk phase (only their fsync was deferred).
    /// 2. Re-persist the manifest-chain artifacts of the current version under
    ///    `Strict` (the checkpoint `{v}.json`, every replayed `{v}.edit.json`,
    ///    and `manifest_index.json`) — in `Relaxed` these were written with the
    ///    rename but without the fsync, so their bytes may still be in page cache.
    /// 3. Fsync each unique shard directory + the manifests directory + db root
    ///    (dir-entry durability on ext4/XFS; no-op on macOS/Windows).
    /// 4. Re-persist the manifest pointer `current.json` under `Strict` (one
    ///    fsync) so the version pointer itself is on stable storage.
    ///
    /// O(segments + chain-length), but ONCE. Conservative on partial failure:
    /// it does NOT early-return on the first segment fsync error — it records
    /// the first error, continues fsyncing the rest (so a single missing/corrupt
    /// segment does not leave most of the state un-flushed), and returns the
    /// aggregate failure at the end. The caller (`end_bulk_load`) must NOT flip
    /// the mode back to `Strict` if this returns `Err`.
    ///
    /// Risk note (C2 risk #1): segments are enumerated from `self.current()` —
    /// the immutable published snapshot — NOT from live shard write buffers.
    /// Unflushed live writes are intentionally ignored; only the published
    /// version is made durable. Safe because this runs under an exclusive borrow
    /// (engine write lock), so no commit can publish a new version concurrently.
    pub fn make_durable(&mut self) -> Result<()> {
        // Ephemeral store: nothing on disk to fsync.
        let Some(db_path) = self.db_path.clone() else {
            return Ok(());
        };

        let mut first_err: Option<GraphError> = None;
        let mut shard_dirs: HashSet<u16> = HashSet::new();

        // Step 1: fsync every segment of the current published version.
        // Enumerate from the immutable snapshot (risk #1: not live shard state).
        let current = &self.current;
        let all_segments = current
            .node_segments
            .iter()
            .chain(current.edge_segments.iter())
            .chain(current.l1_node_segments.iter())
            .chain(current.l1_edge_segments.iter());

        for desc in all_segments {
            let shard_id = desc.shard_id.unwrap_or(0);
            shard_dirs.insert(shard_id);
            let suffix = match desc.segment_type {
                SegmentType::Nodes => "nodes",
                SegmentType::Edges => "edges",
            };
            let seg_path = db_path
                .join("segments")
                .join(format!("{:02}", shard_id))
                .join(format!("seg_{:06}_{}.seg", desc.segment_id, suffix));
            // Conservative (risk #2 / #6): on a per-segment fsync failure, record
            // the first error and keep going — do NOT early-return, so the rest
            // of the state still reaches stable storage.
            if let Err(e) = fsync_path(&seg_path) {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }

        // Step 2: re-persist the manifest-chain artifacts of the current version
        // under Strict (in Relaxed they were renamed but not fsync'd). Re-write
        // by reading + atomic_write_json(Strict) so the on-disk tail is durable.
        let version = current.version;
        let checkpoint = highest_checkpoint_at_or_below(&db_path, version)?;
        // The checkpoint full-snapshot file.
        if let Err(e) =
            resync_json_strict(&manifest_file_path(&db_path, checkpoint))
        {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }
        // Every replayed edit file on top of the checkpoint.
        for v in (checkpoint + 1)..=version {
            if let Err(e) =
                resync_json_strict(&manifest_edit_file_path(&db_path, v))
            {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
        // The manifest index.
        if let Err(e) =
            resync_json_strict(&db_path.join("manifest_index.json"))
        {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }

        // Step 3: fsync each unique shard dir + manifests dir + db root.
        for shard_id in &shard_dirs {
            let dir = db_path.join("segments").join(format!("{:02}", shard_id));
            if let Err(e) = fsync_directory(&dir) {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
        if let Err(e) = fsync_directory(&db_path.join("manifests")) {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }
        if let Err(e) = fsync_directory(&db_path) {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }

        // Step 4: re-persist the version pointer under Strict (one fsync). Do
        // this LAST so current.json is only durable once everything it points at
        // is durable — preserving the "visibility never advances past
        // durability" invariant even across the barrier.
        let pointer = CurrentPointer::new(version);
        if let Err(e) = pointer.write_to(&db_path, DurabilityMode::Strict) {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }

        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// The current published version's cumulative tombstone set (MVCC B3).
    ///
    /// This is the authoritative version-state tombstone set. A snapshot clones
    /// the returned `Arc` (O(1)) to freeze the version's tombstones immutably;
    /// later commits build a fresh `Arc`, so old snapshots are unaffected.
    ///
    /// Complexity: O(1) (cached `Arc`)
    pub fn current_tombstones(&self) -> Arc<TombstoneSet> {
        Arc::clone(&self.current_tombstones)
    }

    /// Shared handle to the live-reader version pin registry (MVCC B5).
    ///
    /// A `ReadSnapshot` clones this `Arc` at capture so its pin (and the unpin
    /// on drop) outlive any borrow of the store / hold of the manifest lock.
    pub fn version_pins(&self) -> Arc<VersionPins> {
        Arc::clone(&self.version_pins)
    }

    /// The smallest manifest version still pinned by a live reader, or `None`
    /// if no reader is live (MVCC B5). The GC retains every version `>= this`.
    pub fn min_pinned_version(&self) -> Option<u64> {
        self.version_pins.min_pinned()
    }

    /// The latest delta-manifest CHECKPOINT version at or below `version` (MVCC
    /// B5 retention). A checkpoint is a full-snapshot manifest (`{v}.json`);
    /// `load_current_with_replay` replays edit deltas on top of it. To keep an
    /// edit version `version` loadable, its base checkpoint must survive — this
    /// computes that base. Mirrors the `is_checkpoint` rule in `commit_edit`
    /// (`v == 1 || v % checkpoint_interval == 0`).
    fn checkpoint_at_or_below(&self, version: u64) -> u64 {
        if version <= 1 {
            return 1;
        }
        let ci = self.checkpoint_interval;
        let floor = (version / ci) * ci;
        if floor == 0 {
            1
        } else {
            floor
        }
    }

    /// Rebuild the cached `current_tombstones` `Arc` from `self.current`'s
    /// in-memory cumulative tombstone fields. Called after every commit that
    /// changes the cumulative set, and on open. Produces a fresh `Arc` so any
    /// snapshot still holding the previous `Arc` keeps its own immutable view.
    fn rebuild_current_tombstones(&mut self) {
        self.current_tombstones = Arc::new(TombstoneSet::from_manifest(
            self.current.tombstoned_node_ids.clone(),
            self.current.tombstoned_edge_keys.clone(),
        ));
    }

    /// Merge new tombstone deltas into the current version's cumulative set
    /// in memory, ahead of the next commit (MVCC B3).
    ///
    /// Used by the `flush()` path, which persists buffered `delete_node` /
    /// `delete_edge` tombstones. The subsequent `flush_all` → `create_manifest`
    /// carries the updated cumulative set forward into the new version, and
    /// `commit` writes it to disk — so flush-path deletions become part of the
    /// version authority (and survive reopen), not only the per-shard set.
    ///
    /// `added_*` are newly tombstoned. Refreshes the derived `Arc` so a snapshot
    /// taken before the next version commit already sees the new tombstones
    /// (in-session delete visibility). Returns `true` if the cumulative set
    /// actually changed (the caller uses this to decide whether to force a
    /// version commit even when no segments were flushed).
    pub fn extend_tombstones(
        &mut self,
        added_nodes: &HashSet<u128>,
        added_edges: &HashSet<(u128, u128, Arc<str>)>,
    ) -> bool {
        if added_nodes.is_empty() && added_edges.is_empty() {
            return false;
        }
        let before_nodes = self.current.tombstoned_node_ids.len();
        let before_edges = self.current.tombstoned_edge_keys.len();

        let mut node_set: HashSet<u128> =
            self.current.tombstoned_node_ids.iter().copied().collect();
        node_set.extend(added_nodes.iter().copied());
        self.current.tombstoned_node_ids = node_set.into_iter().collect();

        let mut edge_set: HashSet<(u128, u128, String)> =
            self.current.tombstoned_edge_keys.iter().cloned().collect();
        edge_set.extend(
            added_edges
                .iter()
                .map(|(s, d, t)| (*s, *d, t.to_string())),
        );
        self.current.tombstoned_edge_keys = edge_set.into_iter().collect();

        let changed = self.current.tombstoned_node_ids.len() != before_nodes
            || self.current.tombstoned_edge_keys.len() != before_edges;
        if changed {
            self.rebuild_current_tombstones();
        }
        changed
    }

    /// Commit a tombstone-only new version (MVCC B3).
    ///
    /// The `flush()` deletion path stages tombstones into the current version
    /// via `extend_tombstones`, but `flush_all` only advances the version when
    /// it flushes segments. When a delete+flush has nothing to flush (write
    /// buffers already drained by a prior commit), the deletion would otherwise
    /// never be persisted as its own version. This advances the version with no
    /// segment changes, carrying the (already-updated) cumulative tombstone set
    /// onto disk so the delete survives reopen.
    pub fn commit_tombstone_only(&mut self) -> Result<()> {
        // No segment change ⇒ create_manifest's fresh Arc will share nothing with
        // older snapshots, but the descriptor set is identical. Clone the inner
        // Vec (the set is unchanged so correctness is unaffected; this path is
        // rare — only an empty-flush delete commit).
        let node_segments = (*self.current.node_segments).clone();
        let edge_segments = (*self.current.edge_segments).clone();
        // create_manifest carries forward L1 + the cumulative tombstone set
        // (already updated by extend_tombstones), so the new version persists it.
        let manifest = self.create_manifest(node_segments, edge_segments, None)?;
        self.commit(manifest)
    }

    /// Remove node ids from the current version's cumulative tombstone set in
    /// memory (MVCC B3). Used when a previously-deleted node is re-added: the
    /// un-tombstone must reach the version authority, or the next flush would
    /// re-persist the stale tombstone and the re-added node would stay hidden
    /// (and disappear after reopen). Refreshes the derived `Arc`. Idempotent.
    pub fn remove_tombstone_nodes(&mut self, ids: &HashSet<u128>) {
        if ids.is_empty() || self.current.tombstoned_node_ids.is_empty() {
            return;
        }
        let before = self.current.tombstoned_node_ids.len();
        self.current.tombstoned_node_ids.retain(|id| !ids.contains(id));
        if self.current.tombstoned_node_ids.len() != before {
            self.rebuild_current_tombstones();
        }
    }

    /// Remove edge keys from the current version's cumulative tombstone set in
    /// memory (MVCC B3). Used when a previously-deleted edge is re-added (the
    /// enricher delete-by-source then re-emit pattern): the un-tombstone must
    /// reach the version authority, not only the per-shard mirror, or the next
    /// flush would re-broadcast the stale tombstone and snapshots would keep
    /// filtering the live edge.
    ///
    /// Refreshes the derived `Arc` so any snapshot taken before the next commit
    /// already sees the edge as live. Idempotent — missing keys are no-ops.
    pub fn remove_tombstone_edges(&mut self, keys: &[(u128, u128, Arc<str>)]) {
        if keys.is_empty() || self.current.tombstoned_edge_keys.is_empty() {
            return;
        }
        let rm: HashSet<(u128, u128, String)> = keys
            .iter()
            .map(|(s, d, t)| (*s, *d, t.to_string()))
            .collect();
        let before = self.current.tombstoned_edge_keys.len();
        self.current
            .tombstoned_edge_keys
            .retain(|k| !rm.contains(k));
        if self.current.tombstoned_edge_keys.len() != before {
            self.rebuild_current_tombstones();
        }
    }

    /// Create new manifest (not yet committed).
    ///
    /// Constructs manifest with version = current.version + 1 and provided
    /// segments/tags. Does NOT write to disk or update self.current.
    ///
    /// Complexity: O(S) where S = total segments (for computing stats)
    pub fn create_manifest(
        &self,
        node_segments: Vec<SegmentDescriptor>,
        edge_segments: Vec<SegmentDescriptor>,
        tags: Option<HashMap<String, String>>,
    ) -> Result<Manifest> {
        let mut seen_ids = HashSet::new();
        for seg in node_segments.iter().chain(edge_segments.iter()) {
            if !seen_ids.insert(seg.segment_id) {
                return Err(GraphError::InvalidFormat(format!(
                    "Duplicate segment_id: {}",
                    seg.segment_id
                )));
            }
        }

        let version = self.current.version + 1;
        let stats = ManifestStats::from_segments(&node_segments, &edge_segments);

        // Carry forward L1 segments from the current manifest. Compaction
        // overrides these explicitly after calling create_manifest. Without
        // this, every commit after compaction silently drops L1 data and
        // open() loads only the new delta — making post-compaction data
        // disappear from queries.
        // MVCC C3.b: `Arc::clone` shares the current version's immutable L1 set
        // (O(1)). Compaction overrides these with a fresh Arc after this call.
        let l1_node_segments = Arc::clone(&self.current.l1_node_segments);
        let l1_edge_segments = Arc::clone(&self.current.l1_edge_segments);

        // MVCC B3: carry forward the cumulative tombstone set. The manifest
        // version is the authority for tombstones now, so a plain flush commit
        // (which adds no deletions) must preserve the current version's set.
        // Compaction overrides these to empty explicitly after this call (the
        // merged L1 segments no longer contain the tombstoned records).
        let tombstoned_node_ids = self.current.tombstoned_node_ids.clone();
        let tombstoned_edge_keys = self.current.tombstoned_edge_keys.clone();

        Ok(Manifest {
            version,
            created_at: current_timestamp(),
            node_segments: Arc::new(node_segments),
            edge_segments: Arc::new(edge_segments),
            tags: tags.unwrap_or_default(),
            stats,
            parent_version: Some(self.current.version),
            tombstoned_node_ids,
            tombstoned_edge_keys,
            l1_node_segments,
            l1_edge_segments,
            last_compaction: None,
        })
    }

    /// Atomically commit manifest version (swap current pointer).
    ///
    /// Write order:
    /// 1. Write manifest file
    /// 2. Update index in memory + write index file
    /// 3. Write current pointer (atomic commit marker)
    /// 4. Update in-memory cache
    ///
    /// If ephemeral: only update cache, no disk writes.
    ///
    /// Complexity: O(S + I) where S = segments in manifest, I = index size
    pub fn commit(&mut self, manifest: Manifest) -> Result<()> {
        if self.db_path.is_none() {
            self.index.add_snapshot(&manifest);
            self.current = manifest;
            // MVCC B3: the in-memory current version is the tombstone authority;
            // keep its cumulative set and refresh the derived Arc.
            self.rebuild_current_tombstones();
            return Ok(());
        }

        let db_path = self.db_path.as_ref().unwrap();

        if manifest.version != self.current.version + 1 {
            return Err(GraphError::InvalidFormat(format!(
                "Cannot commit version {} (current: {})",
                manifest.version, self.current.version
            )));
        }

        // 1. Write manifest file
        let manifest_path = manifest_file_path(db_path, manifest.version);
        atomic_write_json(&manifest_path, &manifest, self.durability)?;

        // 2. Update index in memory + write index file
        self.index.add_snapshot(&manifest);
        let index_path = db_path.join("manifest_index.json");
        atomic_write_json(&index_path, &self.index, self.durability)?;

        // 3. Write + rename current pointer
        let current_pointer = CurrentPointer::new(manifest.version);
        current_pointer.write_to(db_path, self.durability)?;

        // 4. Update cache
        self.current = manifest;

        // 5. MVCC B3: the in-memory current version is the tombstone authority
        // (snapshots read its derived Arc). The full set was just persisted to
        // disk in the manifest file above, so keep it in memory and refresh the
        // derived Arc — do NOT clear it (clearing would make snapshots blind to
        // the version's deletions).
        self.rebuild_current_tombstones();

        // 6. Periodic manifest GC — prevent unbounded growth during long analysis runs.
        // Keep last 3 manifests (current + 2 for safety). Runs every 10 commits.
        const MANIFEST_GC_INTERVAL: u64 = 10;
        const MANIFEST_GC_KEEP: usize = 3;
        if self.current.version % MANIFEST_GC_INTERVAL == 0 {
            let removed = self.gc_manifests(MANIFEST_GC_KEEP)?;
            if removed > 0 {
                tracing::info!("Manifest GC: removed {} old manifest(s)", removed);
            }
        }

        Ok(())
    }

    /// Commit a new version using the delta-manifest write path.
    ///
    /// Writes a full checkpoint snapshot every `checkpoint_interval` versions
    /// (and at v1) and a compact `.edit.json` delta otherwise, so per-commit
    /// disk cost is O(Δ) (segments/tombstones changed this commit) instead of
    /// O(total segments).
    ///
    /// `edit` is the precomputed O(Δ) delta for this commit. `self.current` is
    /// advanced in place by replaying it (no O(total-segments) clone), then
    /// written verbatim at checkpoint boundaries. At a checkpoint the full
    /// cumulative tombstone set must be on disk, so the caller passes it via
    /// `checkpoint_tombstone_nodes`/`_edges` (it already holds them for the
    /// shard TombstoneSet broadcast); between checkpoints the edit's tombstone
    /// delta is what's persisted and replayed.
    ///
    /// Invariant: replaying the edit chain since the last checkpoint reproduces
    /// the snapshot a full-write commit would have produced.
    pub fn commit_edit(
        &mut self,
        mut edit: ManifestEdit,
        checkpoint_tombstone_nodes: &[u128],
        checkpoint_tombstone_edges: &[(u128, u128, String)],
    ) -> Result<()> {
        if edit.version != self.current.version + 1 {
            return Err(GraphError::InvalidFormat(format!(
                "Cannot commit version {} (current: {})",
                edit.version, self.current.version
            )));
        }
        if edit.parent_version != self.current.version {
            return Err(GraphError::InvalidFormat(format!(
                "Edit parent {} != current version {}",
                edit.parent_version, self.current.version
            )));
        }

        edit.created_at = current_timestamp();
        let version = edit.version;
        let is_checkpoint = version == 1 || version % self.checkpoint_interval == 0;

        // Advance the in-memory snapshot in place (O(Δ) segment splice). The
        // edit's tombstone delta is replayed onto self.current's cumulative set
        // by apply(), so after this self.current.tombstoned_* IS the version's
        // authoritative cumulative tombstone set (MVCC B3 — we no longer clear
        // it). At checkpoints we re-materialise the full set from the caller's
        // copy (identical, but it is what we persist verbatim to disk).
        self.current.apply(&edit);

        // Ephemeral: cache only, no disk artifacts. Keep the cumulative set in
        // memory (apply already maintained it) and refresh the derived Arc.
        if self.db_path.is_none() {
            self.index.add_snapshot(&self.current);
            self.rebuild_current_tombstones();
            return Ok(());
        }

        let db_path = self.db_path.as_ref().unwrap().clone();

        if is_checkpoint {
            // Materialize the full cumulative tombstone set for the snapshot,
            // then write self.current verbatim (the replay base for later edits).
            self.current.tombstoned_node_ids = checkpoint_tombstone_nodes.to_vec();
            self.current.tombstoned_edge_keys = checkpoint_tombstone_edges.to_vec();
            let manifest_path = manifest_file_path(&db_path, version);
            atomic_write_json(&manifest_path, &self.current, self.durability)?;
            self.index.add_snapshot(&self.current);
        } else {
            // Delta only — O(Δ) write.
            let edit_path = manifest_edit_file_path(&db_path, version);
            atomic_write_json(&edit_path, &edit, self.durability)?;
            // Keep the index coherent so open() does not see a stale
            // latest_version and trigger a (correct but costly) rebuild.
            for seg in edit
                .added_node_segments
                .iter()
                .chain(edit.added_edge_segments.iter())
            {
                self.index.referenced_segments.insert(seg.segment_id);
            }
            self.index.latest_version = version;
        }

        // MVCC B3: keep the cumulative tombstone set in memory (it is the
        // version authority that snapshots read) and refresh the derived Arc.
        // Between checkpoints the on-disk artifact is the O(Δ) edit delta; the
        // full set is reconstructed on open by replaying edits onto the latest
        // checkpoint, so memory and disk stay consistent.
        self.rebuild_current_tombstones();

        // Persist index (updated in both branches).
        let index_path = db_path.join("manifest_index.json");
        atomic_write_json(&index_path, &self.index, self.durability)?;

        // Commit marker (atomic rename).
        let current_pointer = CurrentPointer::new(version);
        current_pointer.write_to(&db_path, self.durability)?;

        // Periodic checkpoint-aware GC (also reaps orphaned edit files).
        const MANIFEST_GC_INTERVAL: u64 = 10;
        const MANIFEST_GC_KEEP: usize = 3;
        if version % MANIFEST_GC_INTERVAL == 0 {
            let removed = self.gc_manifests(MANIFEST_GC_KEEP)?;
            if removed > 0 {
                tracing::info!("Manifest GC: removed {} old manifest(s)", removed);
            }
        }

        Ok(())
    }

    /// Load specific manifest version from disk.
    ///
    /// Complexity: O(S) where S = segments in manifest (JSON deserialization)
    pub fn load_manifest(&self, version: u64) -> Result<Manifest> {
        if let Some(db_path) = &self.db_path {
            // Reconstruct via replay so edit (non-checkpoint) versions resolve
            // too. For pre-delta DBs this loads the single checkpoint file.
            load_current_with_replay(db_path, version)
        } else if version == self.current.version {
            Ok(self.current.clone())
        } else {
            Err(GraphError::InvalidFormat(format!(
                "Ephemeral database has no version {}",
                version
            )))
        }
    }

    /// Allocate next segment ID (thread-safe).
    ///
    /// Uses atomic fetch_add for lock-free concurrency.
    ///
    /// Complexity: O(1)
    pub fn next_segment_id(&self) -> u64 {
        self.next_segment_id.fetch_add(1, Ordering::SeqCst)
    }
}

// ── ManifestStore: Snapshot Operations ─────────────────────────────

impl ManifestStore {
    /// Find snapshot by tag (O(1) index lookup).
    pub fn find_snapshot(&self, tag_key: &str, tag_value: &str) -> Option<u64> {
        self.index.find_by_tag(tag_key, tag_value)
    }

    /// List all snapshots (optionally filtered by tag key).
    ///
    /// Complexity: O(N) where N = snapshots in index (in-memory filter)
    pub fn list_snapshots(&self, filter_tag: Option<&str>) -> Vec<SnapshotInfo> {
        self.index.list_snapshots(filter_tag)
    }

    /// Tag existing snapshot (modifies manifest file atomically, updates index).
    ///
    /// Tags are merged: new tags overwrite existing keys, other keys preserved.
    ///
    /// Complexity: O(S + I) where S = segments in manifest, I = index size
    pub fn tag_snapshot(
        &mut self,
        version: u64,
        tags: HashMap<String, String>,
    ) -> Result<()> {
        if self.db_path.is_none() {
            return Err(GraphError::InvalidFormat(
                "Cannot tag ephemeral snapshot".to_string(),
            ));
        }

        let db_path = self.db_path.as_ref().unwrap().clone();
        let manifest_path = manifest_file_path(&db_path, version);

        // Reconstruct via replay so an edit (non-checkpoint) version can be
        // tagged; writing the full .json below materialises it as a checkpoint.
        let mut manifest = self.load_manifest(version)?;

        for (key, value) in &tags {
            manifest.tags.insert(key.clone(), value.clone());
        }

        atomic_write_json(&manifest_path, &manifest, self.durability)?;

        for (key, value) in tags {
            self.index
                .tag_index
                .entry(key)
                .or_default()
                .insert(value, version);
        }

        let index_path = db_path.join("manifest_index.json");
        atomic_write_json(&index_path, &self.index, self.durability)?;

        if version == self.current.version {
            self.current = manifest;
        }

        Ok(())
    }

    /// Compute diff between two snapshots.
    ///
    /// Complexity: O(S) where S = total segments in both manifests
    pub fn diff_snapshots(
        &self,
        from_version: u64,
        to_version: u64,
    ) -> Result<SnapshotDiff> {
        let from = self.load_manifest(from_version)?;
        let to = self.load_manifest(to_version)?;
        Ok(SnapshotDiff::compute(&from, &to))
    }
}

// ── ManifestStore: Garbage Collection ──────────────────────────────

impl ManifestStore {
    /// Collect unreferenced segments (move to gc/ directory).
    ///
    /// Uses index.referenced_segments to determine live segments, then
    /// scans segments/ directory for files not in the referenced set.
    ///
    /// Safety: Two-phase GC (collect -> purge). If logic is wrong, files
    /// are in gc/ (recoverable), not deleted (permanent).
    ///
    /// Complexity: O(F) where F = files in segments/ directory
    pub fn gc_collect(&self) -> Result<Vec<String>> {
        if self.db_path.is_none() {
            return Ok(Vec::new());
        }

        let db_path = self.db_path.as_ref().unwrap();
        let segments_dir = db_path.join("segments");
        let gc_dir = db_path.join("gc");

        std::fs::create_dir_all(&gc_dir)?;

        // MVCC B5: the live retained set is every segment referenced by a
        // retained manifest version PLUS every segment referenced by a version
        // a live reader still pins. `gc_manifests` already refuses to drop
        // pinned versions from the index (so their segments stay in
        // `referenced_segments`), but compute the pinned union explicitly here
        // as defense-in-depth: even if `gc_collect` is called without a prior
        // `gc_manifests`, a pinned reader's segment file is never reclaimed.
        let mut referenced_ids: HashSet<u64> = self.index.referenced_segments.clone();
        if let Some(min_pinned) = self.version_pins.min_pinned() {
            for info in &self.index.snapshots {
                if info.version >= min_pinned {
                    if let Ok(manifest) = self.load_manifest(info.version) {
                        for seg in manifest
                            .node_segments
                            .iter()
                            .chain(manifest.edge_segments.iter())
                            .chain(manifest.l1_node_segments.iter())
                            .chain(manifest.l1_edge_segments.iter())
                        {
                            referenced_ids.insert(seg.segment_id);
                        }
                    }
                }
            }
        }
        let mut moved = Vec::new();

        // Multi-shard disk layout writes per-shard segment files under
        // `segments/NN/` (see `SegmentDescriptor::file_path`); legacy/unsharded
        // layout writes directly under `segments/`. Scan BOTH: top-level `.seg`
        // files and one level of shard subdirectories. Orphaned files are moved
        // into a mirrored `gc/` (or `gc/NN/`) tree, preserving the relative
        // path so `gc_purge` and any recovery keep the shard association.
        for entry in std::fs::read_dir(&segments_dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;

            if file_type.is_dir() {
                // Shard subdirectory: scan its `.seg` files.
                let shard_name = entry.file_name();
                for sub in std::fs::read_dir(&path)? {
                    let sub = sub?;
                    let sub_path = sub.path();
                    if sub_path.extension().and_then(|s| s.to_str()) != Some("seg") {
                        continue;
                    }
                    if let Some(segment_id) = parse_segment_id_from_filename(
                        sub_path.file_name().unwrap().to_str().unwrap(),
                    ) {
                        if !referenced_ids.contains(&segment_id) {
                            let gc_shard_dir = gc_dir.join(&shard_name);
                            std::fs::create_dir_all(&gc_shard_dir)?;
                            let gc_path = gc_shard_dir.join(sub_path.file_name().unwrap());
                            std::fs::rename(&sub_path, &gc_path)?;
                            moved.push(gc_path.to_string_lossy().to_string());
                        }
                    }
                }
                continue;
            }

            if path.extension().and_then(|s| s.to_str()) != Some("seg") {
                continue;
            }

            if let Some(segment_id) =
                parse_segment_id_from_filename(path.file_name().unwrap().to_str().unwrap())
            {
                if !referenced_ids.contains(&segment_id) {
                    let filename = path.file_name().unwrap();
                    let gc_path = gc_dir.join(filename);
                    std::fs::rename(&path, &gc_path)?;
                    moved.push(gc_path.to_string_lossy().to_string());
                }
            }
        }

        Ok(moved)
    }

    /// Purge files from gc/ directory (permanent deletion).
    ///
    /// Complexity: O(F) where F = files in gc/
    pub fn gc_purge(&self) -> Result<usize> {
        if self.db_path.is_none() {
            return Ok(0);
        }

        let db_path = self.db_path.as_ref().unwrap();
        let gc_dir = db_path.join("gc");

        if !gc_dir.exists() {
            return Ok(0);
        }

        let mut deleted = 0;

        // Purge both top-level `gc/*.seg` and shard-mirrored `gc/NN/*.seg`
        // (gc_collect stages per-shard orphans under `gc/NN/`). Unlinking a
        // file here is safe ONLY because gc_collect's pin guard already ensured
        // no live reader's version references it (MVCC B5 — no unlink under a
        // live mmap).
        for entry in std::fs::read_dir(&gc_dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;

            if file_type.is_dir() {
                for sub in std::fs::read_dir(&path)? {
                    let sub = sub?;
                    let sub_path = sub.path();
                    if sub_path.extension().and_then(|s| s.to_str()) != Some("seg") {
                        continue;
                    }
                    std::fs::remove_file(&sub_path)?;
                    deleted += 1;
                }
                continue;
            }

            if path.extension().and_then(|s| s.to_str()) != Some("seg") {
                continue;
            }

            std::fs::remove_file(&path)?;
            deleted += 1;
        }

        Ok(deleted)
    }

    /// Remove old manifest files, keeping only the last `keep_last` versions.
    ///
    /// 1. Remove old snapshot entries from index
    /// 2. Delete manifest JSON files from disk
    /// 3. Recalculate referenced_segments from remaining manifests
    /// 4. Write updated index to disk
    ///
    /// Complexity: O(R + K*S) where R = removed manifests, K = kept manifests,
    /// S = segments per manifest (for recalculating referenced set)
    pub fn gc_manifests(&mut self, keep_last: usize) -> Result<usize> {
        if self.db_path.is_none() {
            return Ok(0);
        }

        let snapshot_count = self.index.snapshots.len();
        if snapshot_count <= keep_last {
            return Ok(0);
        }

        let db_path = self.db_path.as_ref().unwrap().clone();

        // MVCC B5: never remove a manifest version that a live reader pins (or
        // anything newer than the minimum live-pinned version). Keeping the
        // manifest JSON keeps that version's segments in `referenced_segments`
        // after the recalculation below, so `gc_collect`/`gc_purge` will not
        // reclaim a pinned reader's segment files. Conservative: retain MORE
        // (every version >= the retention floor) rather than risk deleting a
        // pinned one.
        //
        // The delta-manifest write path stores most versions as `.edit.json`
        // deltas replayed on top of the latest checkpoint `<= version`. So a
        // pinned EDIT version V is only loadable if its base checkpoint (and the
        // edits between it and V) survive. The retention floor is therefore the
        // latest checkpoint `<= min_pinned`, NOT min_pinned itself — otherwise
        // gc_collect's `load_manifest(pinned)` fails and the pin guard silently
        // misses the pinned version's segments (a use-after-free hazard, since
        // the segment is then GC'd while a live reader's mmap is open).
        let min_pinned = self.version_pins.min_pinned();
        let retention_floor = min_pinned.map(|mp| self.checkpoint_at_or_below(mp));

        let versions_to_remove: Vec<u64> = self
            .index
            .snapshots
            .iter()
            .take(snapshot_count - keep_last)
            .map(|s| s.version)
            .filter(|v| match retention_floor {
                Some(floor) => *v < floor,
                None => true,
            })
            .collect();

        if versions_to_remove.is_empty() {
            return Ok(0);
        }

        let mut removed = 0;
        for version in &versions_to_remove {
            self.index.remove_snapshot(*version);

            let path = manifest_file_path(&db_path, *version);
            if path.exists() {
                std::fs::remove_file(&path)?;
                removed += 1;
            }
        }

        // Reap orphaned edit (.edit.json) deltas below the oldest kept
        // checkpoint — they are unreachable for replay, since open() always
        // replays from the latest checkpoint <= current version.
        let oldest_kept = self.index.snapshots.first().map(|s| s.version).unwrap_or(0);
        if oldest_kept > 0 {
            if let Ok(entries) = std::fs::read_dir(db_path.join("manifests")) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if let Some(prefix) = name.strip_suffix(".edit.json") {
                        if let Ok(v) = prefix.parse::<u64>() {
                            if v < oldest_kept {
                                let _ = std::fs::remove_file(entry.path());
                                removed += 1;
                            }
                        }
                    }
                }
            }
        }

        // Recalculate referenced_segments from remaining manifests
        let mut referenced = HashSet::new();
        for info in &self.index.snapshots {
            if let Ok(manifest) = self.load_manifest(info.version) {
                for seg in manifest
                    .node_segments
                    .iter()
                    .chain(manifest.edge_segments.iter())
                    .chain(manifest.l1_node_segments.iter())
                    .chain(manifest.l1_edge_segments.iter())
                {
                    referenced.insert(seg.segment_id);
                }
            }
        }
        self.index.set_referenced_segments(referenced);

        // Persist updated index
        let index_path = db_path.join("manifest_index.json");
        atomic_write_json(&index_path, &self.index, self.durability)?;

        Ok(removed)
    }
}

// ── Helper Functions ───────────────────────────────────────────────

/// Write JSON to file atomically via temp file + rename.
///
/// Atomicity: Rename is atomic on POSIX (single syscall).
fn atomic_write_json<T: Serialize>(
    path: &Path,
    data: &T,
    durability: DurabilityMode,
) -> Result<()> {
    let temp_path = path.with_extension("tmp");

    let file = File::create(&temp_path)?;
    serde_json::to_writer_pretty(&file, data)?;

    if durability == DurabilityMode::Strict {
        file.sync_all()?;
    }

    std::fs::rename(&temp_path, path)?;

    Ok(())
}

/// Read and deserialize JSON from file.
fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = File::open(path)?;
    Ok(serde_json::from_reader(file)?)
}

/// Fsync a single file's data to stable storage (MVCC C2 durable barrier).
///
/// Opens the existing file read-only and `sync_all`s it. Used by
/// `make_durable` to flush segment files whose fsync was deferred in
/// `Relaxed` mode.
fn fsync_path(path: &Path) -> Result<()> {
    let file = File::open(path)?;
    file.sync_all()?;
    Ok(())
}

/// Re-fsync an already-written JSON artifact in place (MVCC C2 durable barrier).
///
/// In `Relaxed` mode `atomic_write_json` renamed the file into place but did
/// not fsync its data, so the bytes may still be in page cache. Opening it and
/// `sync_all`-ing flushes the existing on-disk file to stable storage without
/// rewriting it (no temp/rename — the content is already correct, only its
/// durability was deferred).
fn resync_json_strict(path: &Path) -> Result<()> {
    fsync_path(path)
}

/// Fsync directory to persist directory entry changes.
///
/// Required after rename operations on ext4/XFS to ensure directory
/// metadata is flushed to disk.
#[cfg(target_os = "linux")]
fn fsync_directory(path: &Path) -> Result<()> {
    let dir = File::open(path)?;
    dir.sync_all()?;
    Ok(())
}

/// No-op on macOS/Windows (directory metadata auto-persisted).
#[cfg(not(target_os = "linux"))]
fn fsync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

/// Get manifest file path: {db_path}/manifests/{version:06}.json
fn manifest_file_path(db_path: &Path, version: u64) -> PathBuf {
    db_path
        .join("manifests")
        .join(format!("{:06}.json", version))
}

/// Load manifest file from disk with validation.
fn load_manifest_file(db_path: &Path, version: u64) -> Result<Manifest> {
    let path = manifest_file_path(db_path, version);
    let manifest: Manifest = read_json(&path)?;

    if manifest.version != version {
        return Err(GraphError::InvalidFormat(format!(
            "Manifest version mismatch: expected {}, got {}",
            version, manifest.version
        )));
    }

    #[cfg(debug_assertions)]
    manifest
        .stats
        .validate(&manifest.node_segments, &manifest.edge_segments);

    Ok(manifest)
}

/// Edit (delta) file path: {db_path}/manifests/{version:06}.edit.json
fn manifest_edit_file_path(db_path: &Path, version: u64) -> PathBuf {
    db_path
        .join("manifests")
        .join(format!("{:06}.edit.json", version))
}

/// Highest checkpoint version (full snapshot) at or below `version`.
///
/// Checkpoint files are `{v:06}.json` whose stem parses as a bare u64; edit
/// files `{v:06}.edit.json` have stem `{v:06}.edit` and are naturally skipped.
fn highest_checkpoint_at_or_below(db_path: &Path, version: u64) -> Result<u64> {
    let manifests_dir = db_path.join("manifests");
    let mut best: Option<u64> = None;
    for entry in std::fs::read_dir(&manifests_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Ok(v) = stem.parse::<u64>() {
            if v <= version && best.map_or(true, |b| v > b) {
                best = Some(v);
            }
        }
    }
    best.ok_or_else(|| {
        GraphError::InvalidFormat(format!(
            "no checkpoint manifest at or below version {}",
            version
        ))
    })
}

/// Load the full manifest at `version` by loading the latest checkpoint at or
/// below it and replaying the `.edit.json` deltas on top.
///
/// Backward compatible: a pre-delta database has a checkpoint at every version,
/// so the base equals `version` and zero edits are replayed (single-file load).
fn load_current_with_replay(db_path: &Path, version: u64) -> Result<Manifest> {
    let base = highest_checkpoint_at_or_below(db_path, version)?;
    let mut manifest = load_manifest_file(db_path, base)?;
    for v in (base + 1)..=version {
        let edit_path = manifest_edit_file_path(db_path, v);
        let edit: ManifestEdit = read_json(&edit_path)?;
        if edit.parent_version != manifest.version {
            return Err(GraphError::InvalidFormat(format!(
                "manifest edit chain broken at v{}: parent {} != current v{}",
                v, edit.parent_version, manifest.version
            )));
        }
        manifest.apply(&edit);
    }
    if manifest.version != version {
        return Err(GraphError::InvalidFormat(format!(
            "manifest replay reached v{} but current pointer is v{}",
            manifest.version, version
        )));
    }
    Ok(manifest)
}

/// Parse segment ID from filename: seg_000123_nodes.seg -> 123
fn parse_segment_id_from_filename(filename: &str) -> Option<u64> {
    let parts: Vec<&str> = filename.split('_').collect();
    if parts.len() >= 3 && parts[0] == "seg" {
        parts[1].parse::<u64>().ok()
    } else {
        None
    }
}

/// Rebuild ManifestIndex from manifests/ directory (crash recovery).
///
/// Scans all .json files in manifests/, loads each manifest, and rebuilds
/// the index from scratch. Writes the rebuilt index to disk.
///
/// Called when open_with_config() detects index.latest_version != current_pointer.version.
fn rebuild_index(db_path: &Path) -> Result<ManifestIndex> {
    let manifests_dir = db_path.join("manifests");
    let mut index = ManifestIndex::new();

    let mut versions: Vec<u64> = Vec::new();

    for entry in std::fs::read_dir(&manifests_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }

        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if let Ok(version) = stem.parse::<u64>() {
                versions.push(version);
            }
        }
    }

    // Sort ascending so index.snapshots are in version order
    versions.sort_unstable();

    for version in versions {
        let manifest = load_manifest_file(db_path, version)?;
        index.add_snapshot(&manifest);
    }

    // Persist rebuilt index
    let index_path = db_path.join("manifest_index.json");
    atomic_write_json(&index_path, &index, DurabilityMode::Strict)?;

    Ok(index)
}

/// Get current Unix timestamp (seconds since epoch).
fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;

    // ── Helpers ────────────────────────────────────────────────────

    fn make_node_descriptor(id: u64, record_count: u64) -> SegmentDescriptor {
        SegmentDescriptor {
            segment_id: id,
            segment_type: SegmentType::Nodes,
            shard_id: None,
            record_count,
            byte_size: record_count * 100,
            node_types: HashSet::from(["FUNCTION".to_string()]),
            file_paths: HashSet::from(["src/main.rs".to_string()]),
            edge_types: HashSet::new(),
        }
    }

    fn make_edge_descriptor(id: u64, record_count: u64) -> SegmentDescriptor {
        SegmentDescriptor {
            segment_id: id,
            segment_type: SegmentType::Edges,
            shard_id: None,
            record_count,
            byte_size: record_count * 80,
            node_types: HashSet::new(),
            file_paths: HashSet::new(),
            edge_types: HashSet::from(["CALLS".to_string()]),
        }
    }

    // ── Manifest Edit (delta) helpers + tests ─────────────────────

    fn checkpoint_v1() -> Manifest {
        let nodes = vec![make_node_descriptor(1, 100)];
        Manifest {
            version: 1,
            created_at: 1000,
            node_segments: Arc::new(nodes.clone()),
            edge_segments: Arc::new(Vec::new()),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&nodes, &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: Arc::new(Vec::new()),
            l1_edge_segments: Arc::new(Vec::new()),
            last_compaction: None,
        }
    }

    fn empty_edit(version: u64, parent: u64) -> ManifestEdit {
        ManifestEdit {
            version,
            parent_version: parent,
            base_checkpoint: 1,
            created_at: 1000 + version,
            added_node_segments: Vec::new(),
            added_edge_segments: Vec::new(),
            removed_node_segment_ids: Vec::new(),
            removed_edge_segment_ids: Vec::new(),
            added_tombstone_nodes: Vec::new(),
            removed_tombstone_nodes: Vec::new(),
            added_tombstone_edges: Vec::new(),
            removed_tombstone_edges: Vec::new(),
            l1_node_segments: None,
            l1_edge_segments: None,
            last_compaction: None,
            tags: HashMap::new(),
            stats: ManifestStats {
                total_nodes: 0,
                total_edges: 0,
                node_segment_count: 0,
                edge_segment_count: 0,
            },
        }
    }

    /// Canonicalize unordered fields (segments by id, tombstones sorted) so
    /// two logically-equal manifests compare equal under derived PartialEq.
    fn norm(m: &mut Manifest) {
        Arc::make_mut(&mut m.node_segments).sort_by_key(|s| s.segment_id);
        Arc::make_mut(&mut m.edge_segments).sort_by_key(|s| s.segment_id);
        Arc::make_mut(&mut m.l1_node_segments).sort_by_key(|s| s.segment_id);
        Arc::make_mut(&mut m.l1_edge_segments).sort_by_key(|s| s.segment_id);
        m.tombstoned_node_ids.sort();
        m.tombstoned_edge_keys.sort();
    }

    #[test]
    fn test_edit_serde_roundtrip() {
        let mut e = empty_edit(7, 6);
        e.added_node_segments = vec![make_node_descriptor(9, 10)];
        e.removed_edge_segment_ids = vec![3, 4];
        e.added_tombstone_nodes = vec![1, 2, 3];
        e.added_tombstone_edges = vec![(1, 2, "CALLS".to_string())];
        e.tags = HashMap::from([("k".to_string(), "v".to_string())]);
        let json = serde_json::to_string_pretty(&e).unwrap();
        let back: ManifestEdit = serde_json::from_str(&json).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn test_apply_add_and_remove_segments() {
        let mut m = checkpoint_v1(); // node seg 1
        let mut e = empty_edit(2, 1);
        e.added_node_segments = vec![make_node_descriptor(2, 200)];
        e.added_edge_segments = vec![make_edge_descriptor(3, 50)];
        e.removed_node_segment_ids = vec![1];
        m.apply(&e);

        assert_eq!(m.version, 2);
        assert_eq!(m.parent_version, Some(1));
        let node_ids: Vec<u64> = m.node_segments.iter().map(|s| s.segment_id).collect();
        assert_eq!(node_ids, vec![2], "seg 1 removed, seg 2 added");
        let edge_ids: Vec<u64> = m.edge_segments.iter().map(|s| s.segment_id).collect();
        assert_eq!(edge_ids, vec![3]);
    }

    #[test]
    fn test_apply_tombstone_delta() {
        let mut m = checkpoint_v1();
        m.tombstoned_node_ids = vec![1, 2];
        let mut e = empty_edit(2, 1);
        e.added_tombstone_nodes = vec![3];
        e.removed_tombstone_nodes = vec![1]; // re-added → un-tombstoned
        m.apply(&e);
        m.tombstoned_node_ids.sort();
        assert_eq!(m.tombstoned_node_ids, vec![2, 3]);
    }

    #[test]
    fn test_apply_l1_compaction_replace() {
        let mut m = checkpoint_v1();
        let mut e = empty_edit(2, 1);
        e.l1_node_segments = Some(vec![make_node_descriptor(100, 999)]);
        e.last_compaction = None; // stays None
        m.apply(&e);
        assert_eq!(m.l1_node_segments.len(), 1);
        assert_eq!(m.l1_node_segments[0].segment_id, 100);
    }

    #[test]
    fn test_reconstruct_chain_equals_full_snapshot() {
        // checkpoint v1: node seg 1
        // v2: + node seg 2, + tombstone node 10
        // v3: + edge seg 3, - node seg 1, + tombstone node 20, - tombstone node 10
        let mut e2 = empty_edit(2, 1);
        e2.added_node_segments = vec![make_node_descriptor(2, 200)];
        e2.added_tombstone_nodes = vec![10];

        let mut e3 = empty_edit(3, 2);
        e3.added_edge_segments = vec![make_edge_descriptor(3, 50)];
        e3.removed_node_segment_ids = vec![1];
        e3.added_tombstone_nodes = vec![20];
        e3.removed_tombstone_nodes = vec![10];

        // Final segment set drives stats.
        let final_nodes = vec![make_node_descriptor(2, 200)];
        let final_edges = vec![make_edge_descriptor(3, 50)];
        e3.stats = ManifestStats::from_segments(&final_nodes, &final_edges);

        let mut got =
            reconstruct_manifest(checkpoint_v1(), &[e2, e3], 3).expect("replay ok");

        let mut expected = Manifest {
            version: 3,
            created_at: 1003,
            node_segments: Arc::new(final_nodes.clone()),
            edge_segments: Arc::new(final_edges.clone()),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&final_nodes, &final_edges),
            parent_version: Some(2),
            tombstoned_node_ids: vec![20],
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: Arc::new(Vec::new()),
            l1_edge_segments: Arc::new(Vec::new()),
            last_compaction: None,
        };

        norm(&mut got);
        norm(&mut expected);
        assert_eq!(got, expected, "replayed chain must equal full snapshot");
    }

    #[test]
    fn test_reconstruct_broken_chain_errors() {
        let e3 = empty_edit(3, 2); // parent 2, but checkpoint is v1 → gap
        let err = reconstruct_manifest(checkpoint_v1(), std::slice::from_ref(&e3), 3);
        assert!(err.is_err(), "non-contiguous chain must error");
    }

    #[test]
    fn test_reconstruct_wrong_target_errors() {
        let e2 = empty_edit(2, 1);
        let err = reconstruct_manifest(checkpoint_v1(), std::slice::from_ref(&e2), 5);
        assert!(err.is_err(), "target not reached must error");
    }

    #[test]
    fn test_reconstruct_empty_chain_is_checkpoint() {
        let got = reconstruct_manifest(checkpoint_v1(), &[], 1).expect("ok");
        assert_eq!(got, checkpoint_v1(), "no edits → checkpoint unchanged");
    }

    // ── commit_edit + open() replay (on-disk) ─────────────────────

    /// Commit `count` versions via the delta path, each adding one node
    /// segment (segment_id = version*10). The `edit` carries just that commit's
    /// delta; `commit_edit` advances the in-memory snapshot incrementally.
    fn commit_n_edits(store: &mut ManifestStore, count: u64) {
        for _ in 0..count {
            let v = store.current().version + 1;
            let mut e = empty_edit(v, v - 1);
            e.added_node_segments = vec![make_node_descriptor(v * 10, 100)];
            // Resulting stats for the edit (compute on a throwaway clone).
            let mut m = store.current().clone();
            m.apply(&e);
            e.stats = ManifestStats::from_segments(&m.node_segments, &m.edge_segments);
            store.commit_edit(e, &[], &[]).unwrap();
        }
    }

    fn sorted_node_ids(m: &Manifest) -> Vec<u64> {
        let mut v: Vec<u64> = m.node_segments.iter().map(|s| s.segment_id).collect();
        v.sort_unstable();
        v
    }

    #[test]
    fn test_commit_edit_reopen_at_edit_version() {
        let dir = TempDir::new().unwrap();
        let mut store = ManifestStore::create(dir.path()).unwrap();
        store.set_checkpoint_interval(8); // v2,v3,v4 are all edits
        commit_n_edits(&mut store, 3);
        assert_eq!(store.current().version, 4);
        assert_eq!(store.current().node_segments.len(), 3);

        // Reopen must replay edits v2..v4 on top of the v1 checkpoint.
        let store2 = ManifestStore::open(dir.path()).unwrap();
        assert_eq!(store2.current().version, 4);
        assert_eq!(sorted_node_ids(store2.current()), vec![20, 30, 40]);
    }

    #[test]
    fn test_commit_edit_reopen_at_checkpoint_version() {
        let dir = TempDir::new().unwrap();
        let mut store = ManifestStore::create(dir.path()).unwrap();
        store.set_checkpoint_interval(4); // v4 is a checkpoint
        commit_n_edits(&mut store, 4); // v2,v3 edits, v4 checkpoint, v5 edit
        assert_eq!(store.current().version, 5);

        let store2 = ManifestStore::open(dir.path()).unwrap();
        assert_eq!(store2.current().version, 5);
        assert_eq!(sorted_node_ids(store2.current()), vec![20, 30, 40, 50]);
    }

    #[test]
    fn test_open_legacy_snapshot_format_still_works() {
        // Database written entirely via the legacy full-snapshot commit().
        let dir = TempDir::new().unwrap();
        let mut store = ManifestStore::create(dir.path()).unwrap();
        let m2 = store
            .create_manifest(vec![make_node_descriptor(5, 100)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();
        let m3 = store
            .create_manifest(
                vec![make_node_descriptor(5, 100), make_node_descriptor(6, 100)],
                vec![],
                None,
            )
            .unwrap();
        store.commit(m3).unwrap();

        let store2 = ManifestStore::open(dir.path()).unwrap();
        assert_eq!(store2.current().version, 3);
        assert_eq!(sorted_node_ids(store2.current()), vec![5, 6]);
    }

    #[test]
    fn test_commit_edit_tombstones_survive_reopen() {
        let dir = TempDir::new().unwrap();
        let mut store = ManifestStore::create(dir.path()).unwrap();
        store.set_checkpoint_interval(8); // v2 is an edit

        let mut e = empty_edit(2, 1);
        e.added_node_segments = vec![make_node_descriptor(20, 100)];
        e.added_tombstone_nodes = vec![777];
        let mut m = store.current().clone();
        m.apply(&e);
        e.stats = ManifestStats::from_segments(&m.node_segments, &m.edge_segments);
        // v2 is an edit (interval 8): the tombstone delta in the edit replays on
        // reopen, so no checkpoint tombstone set is needed here.
        store.commit_edit(e, &[], &[]).unwrap();

        // Reopen reconstructs the cumulative tombstone set from the delta so
        // open() can feed it into the shard TombstoneSet.
        let store2 = ManifestStore::open(dir.path()).unwrap();
        assert_eq!(store2.current().version, 2);
        assert!(
            store2.current().tombstoned_node_ids.contains(&777),
            "tombstone delta must replay into the reopened manifest"
        );
    }

    #[test]
    fn test_gc_with_edits_preserves_replay() {
        let dir = TempDir::new().unwrap();
        let mut store = ManifestStore::create(dir.path()).unwrap();
        store.set_checkpoint_interval(4); // checkpoints at v4,8,12,16,20
        commit_n_edits(&mut store, 21); // through v22; GC fires at v10, v20

        // v22 is an edit on top of checkpoint v20; old checkpoints (1,4,8) and
        // their edits were GC'd, but replay base v20 + edits 21,22 still works.
        let store2 = ManifestStore::open(dir.path()).unwrap();
        assert_eq!(store2.current().version, 22);
        assert_eq!(
            store2.current().node_segments.len(),
            21,
            "all 21 added segments (v2..v22) must survive GC + replay"
        );
    }

    // ── Phase 1: Data Structures + Serde ──────────────────────────

    #[test]
    fn test_manifest_serde_roundtrip() {
        let manifest = Manifest {
            version: 5,
            created_at: 1707826800,
            node_segments: std::sync::Arc::new(vec![make_node_descriptor(1, 100)]),
            edge_segments: std::sync::Arc::new(vec![make_edge_descriptor(2, 50)]),
            tags: HashMap::from([("commit_sha".to_string(), "abc123".to_string())]),
            stats: ManifestStats {
                total_nodes: 100,
                total_edges: 50,
                node_segment_count: 1,
                edge_segment_count: 1,
            },
            parent_version: Some(4),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let deserialized: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(manifest, deserialized);
    }

    #[test]
    fn test_manifest_stats_computation() {
        let nodes = vec![make_node_descriptor(1, 100), make_node_descriptor(2, 200)];
        let edges = vec![make_edge_descriptor(3, 50)];

        let stats = ManifestStats::from_segments(&nodes, &edges);
        assert_eq!(stats.total_nodes, 300);
        assert_eq!(stats.total_edges, 50);
        assert_eq!(stats.node_segment_count, 2);
        assert_eq!(stats.edge_segment_count, 1);
    }

    #[test]
    fn test_segment_descriptor_from_meta() {
        let meta = SegmentMeta {
            record_count: 42,
            byte_size: 4200,
            segment_type: SegmentType::Nodes,
            node_types: HashSet::from(["CLASS".to_string()]),
            file_paths: HashSet::from(["lib.rs".to_string()]),
            edge_types: HashSet::new(),
        };

        let desc = SegmentDescriptor::from_meta(7, SegmentType::Nodes, None, meta);
        assert_eq!(desc.segment_id, 7);
        assert_eq!(desc.segment_type, SegmentType::Nodes);
        assert_eq!(desc.shard_id, None);
        assert_eq!(desc.record_count, 42);
        assert_eq!(desc.byte_size, 4200);
        assert!(desc.node_types.contains("CLASS"));
        assert!(desc.file_paths.contains("lib.rs"));
        assert!(desc.edge_types.is_empty());
    }

    #[test]
    fn test_segment_descriptor_file_path_flat() {
        let desc = make_node_descriptor(1, 100);
        let path = desc.file_path(Path::new("/db"));
        assert_eq!(path, PathBuf::from("/db/segments/seg_000001_nodes.seg"));
    }

    #[test]
    fn test_segment_descriptor_file_path_sharded() {
        let mut desc = make_node_descriptor(1, 100);
        desc.shard_id = Some(5);
        let path = desc.file_path(Path::new("/db"));
        assert_eq!(path, PathBuf::from("/db/segments/05/seg_000001_nodes.seg"));
    }

    #[test]
    fn test_segment_descriptor_file_path_edges() {
        let desc = make_edge_descriptor(3, 50);
        let path = desc.file_path(Path::new("/db"));
        assert_eq!(path, PathBuf::from("/db/segments/seg_000003_edges.seg"));
    }

    #[test]
    fn test_segment_descriptor_relative_path() {
        let desc = make_node_descriptor(1, 100);
        assert_eq!(desc.relative_path(), "segments/seg_000001_nodes.seg");

        let mut sharded = make_node_descriptor(1, 100);
        sharded.shard_id = Some(12);
        assert_eq!(sharded.relative_path(), "segments/12/seg_000001_nodes.seg");
    }

    #[test]
    fn test_segment_descriptor_may_contain() {
        let desc = SegmentDescriptor {
            segment_id: 1,
            segment_type: SegmentType::Nodes,
            shard_id: None,
            record_count: 100,
            byte_size: 1000,
            node_types: HashSet::from(["FUNCTION".to_string(), "CLASS".to_string()]),
            file_paths: HashSet::from(["src/main.rs".to_string()]),
            edge_types: HashSet::new(),
        };

        assert!(desc.may_contain(Some("FUNCTION"), None, None));
        assert!(desc.may_contain(Some("CLASS"), None, None));
        assert!(!desc.may_contain(Some("MODULE"), None, None));
        assert!(desc.may_contain(None, Some("src/main.rs"), None));
        assert!(!desc.may_contain(None, Some("src/lib.rs"), None));
        assert!(desc.may_contain(None, None, None));
        // Edge type filter on node segment (empty edge_types = no filter)
        assert!(desc.may_contain(None, None, Some("CALLS")));
    }

    #[test]
    fn test_manifest_index_add_snapshot() {
        let mut index = ManifestIndex::new();
        assert_eq!(index.latest_version, 0);
        assert!(index.snapshots.is_empty());

        let m1 = Manifest {
            version: 1,
            created_at: 100,
            node_segments: std::sync::Arc::new(vec![make_node_descriptor(1, 10)]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&[make_node_descriptor(1, 10)], &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };
        index.add_snapshot(&m1);
        assert_eq!(index.latest_version, 1);
        assert_eq!(index.snapshots.len(), 1);
        assert!(index.referenced_segments.contains(&1));

        let m2 = Manifest {
            version: 2,
            created_at: 200,
            node_segments: std::sync::Arc::new(vec![make_node_descriptor(1, 10), make_node_descriptor(2, 20)]),
            edge_segments: std::sync::Arc::new(vec![make_edge_descriptor(3, 5)]),
            tags: HashMap::from([("tag".to_string(), "val".to_string())]),
            stats: ManifestStats::from_segments(
                &[make_node_descriptor(1, 10), make_node_descriptor(2, 20)],
                &[make_edge_descriptor(3, 5)],
            ),
            parent_version: Some(1),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };
        index.add_snapshot(&m2);
        assert_eq!(index.latest_version, 2);
        assert_eq!(index.snapshots.len(), 2);
        assert!(index.referenced_segments.contains(&1));
        assert!(index.referenced_segments.contains(&2));
        assert!(index.referenced_segments.contains(&3));
    }

    #[test]
    fn test_manifest_index_find_by_tag() {
        let mut index = ManifestIndex::new();

        let m = Manifest {
            version: 5,
            created_at: 500,
            node_segments: std::sync::Arc::new(vec![]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::from([("commit_sha".to_string(), "abc123".to_string())]),
            stats: ManifestStats::from_segments(&[], &[]),
            parent_version: Some(4),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };
        index.add_snapshot(&m);

        assert_eq!(index.find_by_tag("commit_sha", "abc123"), Some(5));
        assert_eq!(index.find_by_tag("commit_sha", "other"), None);
        assert_eq!(index.find_by_tag("nonexistent", "abc123"), None);
    }

    #[test]
    fn test_manifest_index_list_snapshots() {
        let mut index = ManifestIndex::new();

        for v in 1..=3 {
            let tags = if v == 2 {
                HashMap::from([("release".to_string(), "v1.0".to_string())])
            } else {
                HashMap::new()
            };
            let m = Manifest {
                version: v,
                created_at: v * 100,
                node_segments: std::sync::Arc::new(vec![]),
                edge_segments: std::sync::Arc::new(vec![]),
                tags,
                stats: ManifestStats::from_segments(&[], &[]),
                parent_version: if v > 1 { Some(v - 1) } else { None },
                tombstoned_node_ids: Vec::new(),
                tombstoned_edge_keys: Vec::new(),
                l1_node_segments: std::sync::Arc::new(Vec::new()),
                l1_edge_segments: std::sync::Arc::new(Vec::new()),
                last_compaction: None,
            };
            index.add_snapshot(&m);
        }

        assert_eq!(index.list_snapshots(None).len(), 3);
        let filtered = index.list_snapshots(Some("release"));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].version, 2);
    }

    #[test]
    fn test_manifest_index_remove_snapshot() {
        let mut index = ManifestIndex::new();
        let m = Manifest {
            version: 1,
            created_at: 100,
            node_segments: std::sync::Arc::new(vec![]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::from([("key".to_string(), "val".to_string())]),
            stats: ManifestStats::from_segments(&[], &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };
        index.add_snapshot(&m);
        assert_eq!(index.snapshots.len(), 1);
        assert_eq!(index.find_by_tag("key", "val"), Some(1));

        index.remove_snapshot(1);
        assert!(index.snapshots.is_empty());
        assert_eq!(index.find_by_tag("key", "val"), None);
        assert!(index.tag_index.is_empty());
    }

    // ── Phase 2: File I/O Helpers ─────────────────────────────────

    #[test]
    fn test_atomic_write_json_strict_mode() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.json");
        let data = CurrentPointer::new(42);
        atomic_write_json(&path, &data, DurabilityMode::Strict).unwrap();
        assert!(path.exists());
        let loaded: CurrentPointer = read_json(&path).unwrap();
        assert_eq!(loaded.version, 42);
    }

    #[test]
    fn test_atomic_write_json_relaxed_mode() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.json");
        let data = CurrentPointer::new(99);
        atomic_write_json(&path, &data, DurabilityMode::Relaxed).unwrap();
        assert!(path.exists());
        let loaded: CurrentPointer = read_json(&path).unwrap();
        assert_eq!(loaded.version, 99);
    }

    #[test]
    fn test_read_json_missing_file() {
        let result: std::result::Result<CurrentPointer, _> =
            read_json(Path::new("/nonexistent/path/file.json"));
        assert!(result.is_err());
    }

    #[test]
    fn test_fsync_directory_no_error() {
        let dir = TempDir::new().unwrap();
        fsync_directory(dir.path()).unwrap();
    }

    #[test]
    fn test_parse_segment_id_from_filename() {
        assert_eq!(
            parse_segment_id_from_filename("seg_000123_nodes.seg"),
            Some(123)
        );
        assert_eq!(
            parse_segment_id_from_filename("seg_000001_edges.seg"),
            Some(1)
        );
        assert_eq!(
            parse_segment_id_from_filename("seg_999999_nodes.seg"),
            Some(999999)
        );
        assert_eq!(parse_segment_id_from_filename("not_a_segment.seg"), None);
        assert_eq!(parse_segment_id_from_filename("seg_abc_nodes.seg"), None);
        assert_eq!(parse_segment_id_from_filename(""), None);
    }

    #[test]
    fn test_durability_mode_default() {
        assert_eq!(DurabilityMode::default(), DurabilityMode::Strict);
    }

    // ── Phase 3: ManifestStore Core ───────────────────────────────

    #[test]
    fn test_manifest_store_ephemeral() {
        let store = ManifestStore::ephemeral();
        assert!(store.db_path.is_none());
        assert_eq!(store.current().version, 1);
        assert!(store.current().node_segments.is_empty());
    }

    #[test]
    fn test_manifest_store_create_new_database() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let store = ManifestStore::create(&db_path).unwrap();

        assert_eq!(store.current().version, 1);
        assert!(db_path.join("current.json").exists());
        assert!(db_path.join("manifests").join("000001.json").exists());
        assert!(db_path.join("manifest_index.json").exists());
        assert!(db_path.join("segments").exists());
        assert!(db_path.join("gc").exists());
    }

    #[test]
    fn test_manifest_store_create_writes_index() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        ManifestStore::create(&db_path).unwrap();

        let index: ManifestIndex =
            read_json(&db_path.join("manifest_index.json")).unwrap();
        assert_eq!(index.latest_version, 1);
        assert_eq!(index.snapshots.len(), 1);
        assert_eq!(index.snapshots[0].version, 1);
    }

    #[test]
    fn test_manifest_store_create_already_exists() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        ManifestStore::create(&db_path).unwrap();

        let result = ManifestStore::create(&db_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_manifest_store_open_existing() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        {
            let _store = ManifestStore::create(&db_path).unwrap();
        }

        let store = ManifestStore::open(&db_path).unwrap();
        assert_eq!(store.current().version, 1);
    }

    #[test]
    fn test_manifest_store_open_loads_index() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        {
            let mut store = ManifestStore::create(&db_path).unwrap();
            let m = store
                .create_manifest(
                    vec![make_node_descriptor(1, 100)],
                    vec![],
                    None,
                )
                .unwrap();
            store.commit(m).unwrap();
        }

        let store = ManifestStore::open(&db_path).unwrap();
        let snapshots = store.list_snapshots(None);
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].version, 1);
        assert_eq!(snapshots[1].version, 2);
    }

    #[test]
    fn test_manifest_store_commit_updates_index() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        let m = store
            .create_manifest(
                vec![make_node_descriptor(1, 50)],
                vec![make_edge_descriptor(2, 25)],
                None,
            )
            .unwrap();
        store.commit(m).unwrap();

        let snapshots = store.list_snapshots(None);
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[1].stats.total_nodes, 50);
        assert_eq!(snapshots[1].stats.total_edges, 25);
    }

    #[test]
    fn test_manifest_store_commit_sequential() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        let m2 = store
            .create_manifest(vec![make_node_descriptor(1, 10)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();
        assert_eq!(store.current().version, 2);

        let m3 = store
            .create_manifest(
                vec![make_node_descriptor(1, 10), make_node_descriptor(2, 20)],
                vec![],
                None,
            )
            .unwrap();
        store.commit(m3).unwrap();
        assert_eq!(store.current().version, 3);
    }

    #[test]
    fn test_manifest_store_commit_monotonicity_check() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        // Manually construct a manifest with wrong version
        let bad_manifest = Manifest {
            version: 1, // same as current, should fail
            created_at: current_timestamp(),
            node_segments: std::sync::Arc::new(vec![]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&[], &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let result = store.commit(bad_manifest);
        assert!(result.is_err());
    }

    #[test]
    fn test_manifest_store_commit_duplicate_segment_id() {
        let store = ManifestStore::ephemeral();
        let result = store.create_manifest(
            vec![make_node_descriptor(1, 10), make_node_descriptor(1, 20)],
            vec![],
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_manifest_store_load_manifest() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        let m2 = store
            .create_manifest(vec![make_node_descriptor(1, 42)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();

        let loaded_v1 = store.load_manifest(1).unwrap();
        assert_eq!(loaded_v1.version, 1);
        assert!(loaded_v1.node_segments.is_empty());

        let loaded_v2 = store.load_manifest(2).unwrap();
        assert_eq!(loaded_v2.version, 2);
        assert_eq!(loaded_v2.node_segments.len(), 1);
        assert_eq!(loaded_v2.node_segments[0].record_count, 42);
    }

    #[test]
    fn test_manifest_store_load_manifest_ephemeral() {
        let store = ManifestStore::ephemeral();
        let loaded = store.load_manifest(1).unwrap();
        assert_eq!(loaded.version, 1);

        let err = store.load_manifest(99);
        assert!(err.is_err());
    }

    #[test]
    fn test_manifest_store_next_segment_id_increments() {
        let store = ManifestStore::ephemeral();
        assert_eq!(store.next_segment_id(), 1);
        assert_eq!(store.next_segment_id(), 2);
        assert_eq!(store.next_segment_id(), 3);
    }

    // ── Phase 4: Snapshot Operations ──────────────────────────────

    #[test]
    fn test_find_snapshot_by_tag_via_index() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        let m2 = store
            .create_manifest(
                vec![make_node_descriptor(1, 10)],
                vec![],
                Some(HashMap::from([
                    ("commit_sha".to_string(), "abc123".to_string()),
                ])),
            )
            .unwrap();
        store.commit(m2).unwrap();

        assert_eq!(store.find_snapshot("commit_sha", "abc123"), Some(2));
        assert_eq!(store.find_snapshot("commit_sha", "other"), None);
        assert_eq!(store.find_snapshot("nonexistent", "abc123"), None);
    }

    #[test]
    fn test_find_snapshot_not_found() {
        let store = ManifestStore::ephemeral();
        assert_eq!(store.find_snapshot("key", "value"), None);
    }

    #[test]
    fn test_list_snapshots_all_via_index() {
        let mut store = ManifestStore::ephemeral();

        let m2 = store
            .create_manifest(vec![make_node_descriptor(1, 10)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();

        let m3 = store
            .create_manifest(vec![make_node_descriptor(2, 20)], vec![], None)
            .unwrap();
        store.commit(m3).unwrap();

        let all = store.list_snapshots(None);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].version, 1);
        assert_eq!(all[1].version, 2);
        assert_eq!(all[2].version, 3);
    }

    #[test]
    fn test_list_snapshots_filtered_by_tag() {
        let mut store = ManifestStore::ephemeral();

        let m2 = store
            .create_manifest(
                vec![],
                vec![],
                Some(HashMap::from([
                    ("release".to_string(), "v1.0".to_string()),
                ])),
            )
            .unwrap();
        store.commit(m2).unwrap();

        let m3 = store.create_manifest(vec![], vec![], None).unwrap();
        store.commit(m3).unwrap();

        let filtered = store.list_snapshots(Some("release"));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].version, 2);
    }

    #[test]
    fn test_tag_snapshot_updates_index() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        store
            .tag_snapshot(
                1,
                HashMap::from([("env".to_string(), "prod".to_string())]),
            )
            .unwrap();

        assert_eq!(store.find_snapshot("env", "prod"), Some(1));
        // Current manifest cache should be updated
        assert_eq!(
            store.current().tags.get("env").map(|s| s.as_str()),
            Some("prod")
        );
    }

    #[test]
    fn test_tag_snapshot_persists_after_reopen() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        {
            let mut store = ManifestStore::create(&db_path).unwrap();
            store
                .tag_snapshot(
                    1,
                    HashMap::from([("env".to_string(), "staging".to_string())]),
                )
                .unwrap();
        }

        let store = ManifestStore::open(&db_path).unwrap();
        assert_eq!(store.find_snapshot("env", "staging"), Some(1));
        assert_eq!(
            store.current().tags.get("env").map(|s| s.as_str()),
            Some("staging")
        );
    }

    #[test]
    fn test_tag_snapshot_ephemeral_errors() {
        let mut store = ManifestStore::ephemeral();
        let result = store.tag_snapshot(1, HashMap::from([("k".into(), "v".into())]));
        assert!(result.is_err());
    }

    // ── Phase 5: Diff Computation ─────────────────────────────────

    #[test]
    fn test_diff_empty_to_populated() {
        let from = Manifest {
            version: 1,
            created_at: 100,
            node_segments: std::sync::Arc::new(vec![]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&[], &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let to_nodes = vec![make_node_descriptor(1, 10), make_node_descriptor(2, 20)];
        let to_edges = vec![make_edge_descriptor(3, 5)];
        let to = Manifest {
            version: 2,
            created_at: 200,
            node_segments: std::sync::Arc::new(to_nodes.clone()),
            edge_segments: std::sync::Arc::new(to_edges.clone()),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&to_nodes, &to_edges),
            parent_version: Some(1),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let diff = SnapshotDiff::compute(&from, &to);
        assert_eq!(diff.added_node_segments.len(), 2);
        assert_eq!(diff.removed_node_segments.len(), 0);
        assert_eq!(diff.added_edge_segments.len(), 1);
        assert_eq!(diff.removed_edge_segments.len(), 0);
        assert_eq!(diff.change_count(), 3);
        assert!(!diff.is_empty());
    }

    #[test]
    fn test_diff_same_version() {
        let nodes = vec![make_node_descriptor(1, 10)];
        let m = Manifest {
            version: 1,
            created_at: 100,
            node_segments: std::sync::Arc::new(nodes.clone()),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&nodes, &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let diff = SnapshotDiff::compute(&m, &m);
        assert!(diff.is_empty());
        assert_eq!(diff.change_count(), 0);
    }

    #[test]
    fn test_diff_mixed_changes() {
        let from_nodes = vec![make_node_descriptor(1, 10), make_node_descriptor(2, 20)];
        let from = Manifest {
            version: 1,
            created_at: 100,
            node_segments: std::sync::Arc::new(from_nodes.clone()),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&from_nodes, &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        // Remove segment 2, add segments 3 and 4
        let to_nodes = vec![make_node_descriptor(1, 10), make_node_descriptor(3, 30)];
        let to_edges = vec![make_edge_descriptor(4, 15)];
        let to = Manifest {
            version: 2,
            created_at: 200,
            node_segments: std::sync::Arc::new(to_nodes.clone()),
            edge_segments: std::sync::Arc::new(to_edges.clone()),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&to_nodes, &to_edges),
            parent_version: Some(1),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let diff = SnapshotDiff::compute(&from, &to);
        assert_eq!(diff.added_node_segments.len(), 1); // seg 3
        assert_eq!(diff.added_node_segments[0].segment_id, 3);
        assert_eq!(diff.removed_node_segments.len(), 1); // seg 2
        assert_eq!(diff.removed_node_segments[0].segment_id, 2);
        assert_eq!(diff.added_edge_segments.len(), 1); // seg 4
        assert_eq!(diff.removed_edge_segments.len(), 0);
    }

    #[test]
    fn test_diff_stats_match() {
        let from_nodes = vec![make_node_descriptor(1, 100)];
        let from = Manifest {
            version: 1,
            created_at: 100,
            node_segments: std::sync::Arc::new(from_nodes.clone()),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&from_nodes, &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let to_nodes = vec![make_node_descriptor(2, 200)];
        let to = Manifest {
            version: 2,
            created_at: 200,
            node_segments: std::sync::Arc::new(to_nodes.clone()),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&to_nodes, &[]),
            parent_version: Some(1),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let diff = SnapshotDiff::compute(&from, &to);
        assert_eq!(diff.stats_from.total_nodes, 100);
        assert_eq!(diff.stats_to.total_nodes, 200);
    }

    #[test]
    fn test_diff_snapshots_via_store() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        let m2 = store
            .create_manifest(vec![make_node_descriptor(1, 50)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();

        let diff = store.diff_snapshots(1, 2).unwrap();
        assert_eq!(diff.added_node_segments.len(), 1);
        assert_eq!(diff.removed_node_segments.len(), 0);
    }

    // ── Phase 6: Garbage Collection ───────────────────────────────

    #[test]
    fn test_gc_collect_unreferenced() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        // Commit v2 with segment 1
        let m2 = store
            .create_manifest(vec![make_node_descriptor(1, 10)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();

        // Commit v3 with segment 2 (segment 1 no longer referenced by current,
        // but still in index.referenced_segments because index tracks ALL)
        let m3 = store
            .create_manifest(vec![make_node_descriptor(2, 20)], vec![], None)
            .unwrap();
        store.commit(m3).unwrap();

        // Create fake segment files
        let seg_dir = db_path.join("segments");
        std::fs::write(seg_dir.join("seg_000001_nodes.seg"), b"data1").unwrap();
        std::fs::write(seg_dir.join("seg_000002_nodes.seg"), b"data2").unwrap();
        std::fs::write(seg_dir.join("seg_000099_nodes.seg"), b"orphan").unwrap();

        // seg 1 and 2 are referenced, seg 99 is not
        let moved = store.gc_collect().unwrap();
        assert_eq!(moved.len(), 1);
        assert!(moved[0].contains("seg_000099"));

        // Original should be gone, gc/ should have it
        assert!(!seg_dir.join("seg_000099_nodes.seg").exists());
        assert!(db_path.join("gc").join("seg_000099_nodes.seg").exists());
    }

    #[test]
    fn test_gc_collect_preserves_referenced() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        let m2 = store
            .create_manifest(vec![make_node_descriptor(1, 10)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();

        let seg_dir = db_path.join("segments");
        std::fs::write(seg_dir.join("seg_000001_nodes.seg"), b"data1").unwrap();

        let moved = store.gc_collect().unwrap();
        assert!(moved.is_empty());
        assert!(seg_dir.join("seg_000001_nodes.seg").exists());
    }

    #[test]
    fn test_gc_purge_deletes_files() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let store = ManifestStore::create(&db_path).unwrap();

        let gc_dir = db_path.join("gc");
        std::fs::write(gc_dir.join("seg_000001_nodes.seg"), b"old1").unwrap();
        std::fs::write(gc_dir.join("seg_000002_edges.seg"), b"old2").unwrap();
        std::fs::write(gc_dir.join("seg_000003_nodes.seg"), b"old3").unwrap();

        let deleted = store.gc_purge().unwrap();
        assert_eq!(deleted, 3);

        assert!(!gc_dir.join("seg_000001_nodes.seg").exists());
        assert!(!gc_dir.join("seg_000002_edges.seg").exists());
        assert!(!gc_dir.join("seg_000003_nodes.seg").exists());
    }

    #[test]
    fn test_gc_ephemeral_no_op() {
        let store = ManifestStore::ephemeral();
        assert!(store.gc_collect().unwrap().is_empty());
        assert_eq!(store.gc_purge().unwrap(), 0);
    }

    #[test]
    fn test_gc_manifests_removes_old_files() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        // Commit versions 2..=6 (v1 is the initial empty manifest)
        for i in 1..=5 {
            let m = store
                .create_manifest(vec![make_node_descriptor(i, 10)], vec![], None)
                .unwrap();
            store.commit(m).unwrap();
        }

        // Should have 6 manifests on disk (v1..=v6)
        let manifests_dir = db_path.join("manifests");
        let count_before = std::fs::read_dir(&manifests_dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().path().extension().map_or(false, |ext| ext == "json"))
            .count();
        assert_eq!(count_before, 6);

        // GC keeping last 2
        let removed = store.gc_manifests(2).unwrap();
        assert_eq!(removed, 4);

        // Should have 2 manifest files remaining
        let count_after = std::fs::read_dir(&manifests_dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().path().extension().map_or(false, |ext| ext == "json"))
            .count();
        assert_eq!(count_after, 2);

        // Latest manifest (v6) must still exist
        assert!(manifest_file_path(&db_path, 6).exists());
        assert!(manifest_file_path(&db_path, 5).exists());
        assert!(!manifest_file_path(&db_path, 1).exists());

        // Index should only have 2 snapshots
        assert_eq!(store.index.snapshots.len(), 2);
    }

    #[test]
    fn test_gc_manifests_recalculates_referenced_segments() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        // v2: segment 1
        let m2 = store
            .create_manifest(vec![make_node_descriptor(1, 10)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();

        // v3: segment 2 (replacing segment 1)
        let m3 = store
            .create_manifest(vec![make_node_descriptor(2, 20)], vec![], None)
            .unwrap();
        store.commit(m3).unwrap();

        // Before GC: both segments 1 and 2 are referenced (union of all manifests)
        assert!(store.index.referenced_segments.contains(&1));
        assert!(store.index.referenced_segments.contains(&2));

        // GC keeping only latest (v3)
        store.gc_manifests(1).unwrap();

        // After GC: only segment 2 is referenced (from v3 manifest)
        assert!(!store.index.referenced_segments.contains(&1));
        assert!(store.index.referenced_segments.contains(&2));
    }

    #[test]
    fn test_gc_manifests_no_op_when_fewer_than_keep() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let mut store = ManifestStore::create(&db_path).unwrap();

        // Only v1 exists, keep_last=3 → no-op
        let removed = store.gc_manifests(3).unwrap();
        assert_eq!(removed, 0);
    }

    #[test]
    fn test_gc_manifests_ephemeral_no_op() {
        let mut store = ManifestStore::ephemeral();
        assert_eq!(store.gc_manifests(3).unwrap(), 0);
    }

    // ── Phase 7: Index Consistency ────────────────────────────────

    #[test]
    fn test_index_consistency_rebuild_on_open() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        // Create database and commit v2
        {
            let mut store = ManifestStore::create(&db_path).unwrap();
            let m2 = store
                .create_manifest(
                    vec![make_node_descriptor(1, 10)],
                    vec![],
                    Some(HashMap::from([
                        ("key".to_string(), "value".to_string()),
                    ])),
                )
                .unwrap();
            store.commit(m2).unwrap();
        }

        // Simulate crash: corrupt the index by writing an old version
        let stale_index = ManifestIndex {
            latest_version: 1, // out of sync with current.json (version 2)
            snapshots: vec![],
            tag_index: HashMap::new(),
            referenced_segments: HashSet::new(),
        };
        atomic_write_json(
            &db_path.join("manifest_index.json"),
            &stale_index,
            DurabilityMode::Relaxed,
        )
        .unwrap();

        // Open should detect inconsistency and rebuild
        let store = ManifestStore::open(&db_path).unwrap();
        assert_eq!(store.current().version, 2);

        // Rebuilt index should have both snapshots
        let snapshots = store.list_snapshots(None);
        assert_eq!(snapshots.len(), 2);

        // Tags should be recovered
        assert_eq!(store.find_snapshot("key", "value"), Some(2));

        // Referenced segments should be recovered
        assert!(store.index.referenced_segments.contains(&1));
    }

    #[test]
    fn test_current_pointer_roundtrip() {
        let dir = TempDir::new().unwrap();
        let ptr = CurrentPointer::new(42);
        ptr.write_to(dir.path(), DurabilityMode::Relaxed).unwrap();
        let loaded = CurrentPointer::read_from(dir.path()).unwrap();
        assert_eq!(loaded.version, 42);
    }

    #[test]
    fn test_snapshot_info_from_manifest() {
        let m = Manifest {
            version: 3,
            created_at: 300,
            node_segments: std::sync::Arc::new(vec![make_node_descriptor(1, 100)]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::from([("env".to_string(), "test".to_string())]),
            stats: ManifestStats::from_segments(&[make_node_descriptor(1, 100)], &[]),
            parent_version: Some(2),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let info = SnapshotInfo::from_manifest(&m);
        assert_eq!(info.version, 3);
        assert_eq!(info.created_at, 300);
        assert_eq!(info.tags.get("env").map(|s| s.as_str()), Some("test"));
        assert_eq!(info.stats.total_nodes, 100);
    }

    #[test]
    fn test_manifest_file_path() {
        let path = manifest_file_path(Path::new("/db"), 42);
        assert_eq!(path, PathBuf::from("/db/manifests/000042.json"));

        let path = manifest_file_path(Path::new("/db"), 1);
        assert_eq!(path, PathBuf::from("/db/manifests/000001.json"));
    }

    #[test]
    fn test_ephemeral_commit_no_monotonicity_check() {
        // Ephemeral stores skip version monotonicity since there's no disk
        let mut store = ManifestStore::ephemeral();
        let m2 = store.create_manifest(vec![], vec![], None).unwrap();
        store.commit(m2).unwrap();
        assert_eq!(store.current().version, 2);

        let m3 = store.create_manifest(vec![], vec![], None).unwrap();
        store.commit(m3).unwrap();
        assert_eq!(store.current().version, 3);
    }

    #[test]
    fn test_next_segment_id_after_open() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        {
            let mut store = ManifestStore::create(&db_path).unwrap();
            let m2 = store
                .create_manifest(
                    vec![make_node_descriptor(5, 10)],
                    vec![make_edge_descriptor(10, 5)],
                    None,
                )
                .unwrap();
            store.commit(m2).unwrap();
        }

        let store = ManifestStore::open(&db_path).unwrap();
        // max referenced segment ID is 10, so next should be 11
        assert_eq!(store.next_segment_id(), 11);
        assert_eq!(store.next_segment_id(), 12);
    }

    // ── Integration: Crash Simulation ────────────────────────────

    #[test]
    fn test_crash_simulation_manifest_written_but_not_current() {
        // Simulate crash: manifest v2 written to disk, but current.json
        // still points to v1 (crash before current pointer update).
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        let mut store =
            ManifestStore::create_with_config(&db_path, DurabilityMode::Relaxed).unwrap();
        let m2 = store
            .create_manifest(
                vec![make_node_descriptor(1, 100)],
                vec![],
                Some(HashMap::from([("run".into(), "second".into())])),
            )
            .unwrap();
        store.commit(m2).unwrap();
        drop(store);

        // Now manually simulate crash: write manifest v3 file but
        // revert current.json back to v2
        let manifest_v3 = Manifest {
            version: 3,
            created_at: current_timestamp(),
            node_segments: std::sync::Arc::new(vec![make_node_descriptor(2, 200)]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::from([("run".into(), "third".into())]),
            stats: ManifestStats::from_segments(
                &[make_node_descriptor(2, 200)],
                &[],
            ),
            parent_version: Some(2),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };
        let manifest_path = manifest_file_path(&db_path, 3);
        atomic_write_json(&manifest_path, &manifest_v3, DurabilityMode::Relaxed).unwrap();

        // current.json still points to v2 (crash before pointer update)
        // index may or may not be updated — doesn't matter, consistency
        // check on open() will fix it.

        // Reopen — must succeed, pointing to v2
        let store = ManifestStore::open(&db_path).unwrap();
        assert_eq!(store.current().version, 2);
        assert_eq!(store.current().node_segments.len(), 1);
        assert_eq!(store.current().node_segments[0].segment_id, 1);
    }

    #[test]
    fn test_crash_simulation_index_written_but_not_current() {
        // Simulate crash: index updated to v3, but current.json still
        // points to v2. On reopen, index must be rebuilt to match v2.
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        let mut store =
            ManifestStore::create_with_config(&db_path, DurabilityMode::Relaxed).unwrap();
        let m2 = store
            .create_manifest(vec![make_node_descriptor(1, 100)], vec![], None)
            .unwrap();
        store.commit(m2).unwrap();
        drop(store);

        // Corrupt index: set latest_version to 3 (ahead of current=2)
        let index_path = db_path.join("manifest_index.json");
        let mut index: ManifestIndex = read_json(&index_path).unwrap();
        index.latest_version = 3;
        atomic_write_json(&index_path, &index, DurabilityMode::Relaxed).unwrap();

        // Reopen — should detect mismatch and rebuild
        let store = ManifestStore::open(&db_path).unwrap();
        assert_eq!(store.current().version, 2);

        // Index should be rebuilt correctly
        let snapshots = store.list_snapshots(None);
        assert_eq!(snapshots.len(), 2); // v1 + v2
        assert_eq!(snapshots[0].version, 1);
        assert_eq!(snapshots[1].version, 2);
    }

    #[test]
    fn test_crash_simulation_current_json_always_valid() {
        // Verify that no matter what state the DB is in after a partial
        // commit, current.json always points to a valid manifest.
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        let mut store =
            ManifestStore::create_with_config(&db_path, DurabilityMode::Relaxed).unwrap();

        // Commit 5 versions successfully
        for i in 0..5 {
            let m = store
                .create_manifest(
                    vec![make_node_descriptor(i + 1, (i + 1) * 10)],
                    vec![],
                    None,
                )
                .unwrap();
            store.commit(m).unwrap();
        }
        assert_eq!(store.current().version, 6);
        drop(store);

        // current.json always points to a loadable manifest
        let pointer = CurrentPointer::read_from(&db_path).unwrap();
        let manifest = load_manifest_file(&db_path, pointer.version).unwrap();
        assert_eq!(manifest.version, pointer.version);

        // Reopen succeeds
        let store = ManifestStore::open(&db_path).unwrap();
        assert_eq!(store.current().version, 6);
    }

    // ── Integration: Concurrent Reader Isolation ─────────────────

    #[test]
    fn test_concurrent_reader_isolation() {
        // Reader loads manifest v1. Writer commits v2. Reader still
        // sees v1 (snapshot isolation via immutable files).
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        let mut store =
            ManifestStore::create_with_config(&db_path, DurabilityMode::Relaxed).unwrap();
        let m2 = store
            .create_manifest(
                vec![make_node_descriptor(1, 100)],
                vec![],
                None,
            )
            .unwrap();
        store.commit(m2).unwrap();
        drop(store);

        // "Reader" opens DB, gets snapshot of v2
        let reader_path = db_path.clone();
        let reader_handle = std::thread::spawn(move || {
            let reader_store = ManifestStore::open(&reader_path).unwrap();
            let snapshot_version = reader_store.current().version;
            let snapshot_nodes = reader_store.current().stats.total_nodes;

            // Sleep to let writer commit
            std::thread::sleep(std::time::Duration::from_millis(50));

            // Reader still sees its original snapshot
            let reloaded = reader_store.load_manifest(snapshot_version).unwrap();
            assert_eq!(reloaded.version, snapshot_version);
            assert_eq!(reloaded.stats.total_nodes, snapshot_nodes);

            snapshot_version
        });

        // Give reader time to open
        std::thread::sleep(std::time::Duration::from_millis(10));

        // "Writer" opens same DB and commits v3
        let mut writer_store = ManifestStore::open(&db_path).unwrap();
        let m3 = writer_store
            .create_manifest(
                vec![make_node_descriptor(2, 200), make_node_descriptor(3, 300)],
                vec![],
                None,
            )
            .unwrap();
        writer_store.commit(m3).unwrap();
        assert_eq!(writer_store.current().version, 3);

        // Reader completes — it should have seen v2 (its snapshot)
        let reader_version = reader_handle.join().unwrap();
        assert_eq!(reader_version, 2);

        // Writer sees v3
        assert_eq!(writer_store.current().version, 3);
    }

    #[test]
    fn test_concurrent_manifest_files_immutable() {
        // Verify that committing a new version doesn't modify old
        // manifest files (immutability guarantee).
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        let mut store =
            ManifestStore::create_with_config(&db_path, DurabilityMode::Relaxed).unwrap();

        // Commit v2
        let m2 = store
            .create_manifest(
                vec![make_node_descriptor(1, 100)],
                vec![],
                None,
            )
            .unwrap();
        store.commit(m2).unwrap();

        // Read v1 manifest file content
        let v1_before: Manifest =
            read_json(&manifest_file_path(&db_path, 1)).unwrap();

        // Commit v3
        let m3 = store
            .create_manifest(
                vec![make_node_descriptor(2, 200)],
                vec![],
                None,
            )
            .unwrap();
        store.commit(m3).unwrap();

        // v1 manifest file must be unchanged
        let v1_after: Manifest =
            read_json(&manifest_file_path(&db_path, 1)).unwrap();
        assert_eq!(v1_before, v1_after);

        // v2 manifest file must be unchanged
        let v2_loaded: Manifest =
            read_json(&manifest_file_path(&db_path, 2)).unwrap();
        assert_eq!(v2_loaded.version, 2);
        assert_eq!(v2_loaded.node_segments[0].segment_id, 1);
    }

    // ── Tombstone Serde Tests (RFD-8 T3.1) ──────────────────────

    #[test]
    fn test_manifest_serde_with_tombstones() {
        let manifest = Manifest {
            version: 10,
            created_at: 1707826800,
            node_segments: std::sync::Arc::new(vec![make_node_descriptor(1, 50)]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&[make_node_descriptor(1, 50)], &[]),
            parent_version: Some(9),
            tombstoned_node_ids: vec![100, 200, 300],
            tombstoned_edge_keys: vec![
                (10, 20, "CALLS".to_string()),
                (30, 40, "IMPORTS".to_string()),
            ],
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let deserialized: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(manifest, deserialized);
        assert_eq!(deserialized.tombstoned_node_ids, vec![100, 200, 300]);
        assert_eq!(deserialized.tombstoned_edge_keys.len(), 2);
    }

    #[test]
    fn test_manifest_serde_backward_compat() {
        // Simulate old manifest JSON without tombstone fields
        let json = r#"{
            "version": 1,
            "created_at": 1707826800,
            "node_segments": [],
            "edge_segments": [],
            "tags": {},
            "stats": {
                "total_nodes": 0,
                "total_edges": 0,
                "node_segment_count": 0,
                "edge_segment_count": 0
            }
        }"#;

        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.version, 1);
        assert!(manifest.tombstoned_node_ids.is_empty());
        assert!(manifest.tombstoned_edge_keys.is_empty());
    }

    // ── Compaction / L1 Segment Tests (RFD-20) ──────────────────

    #[test]
    fn test_manifest_backward_compat_without_l1_fields() {
        // Simulate an OLD manifest JSON created before compaction support.
        // Must deserialize without errors; L1 fields default to empty.
        let json = r#"{
            "version": 5,
            "created_at": 1707826800,
            "node_segments": [
                {
                    "segment_id": 1,
                    "segment_type": "Nodes",
                    "record_count": 100,
                    "byte_size": 10000,
                    "node_types": ["FUNCTION"],
                    "file_paths": ["src/main.rs"]
                }
            ],
            "edge_segments": [
                {
                    "segment_id": 2,
                    "segment_type": "Edges",
                    "record_count": 50,
                    "byte_size": 4000,
                    "edge_types": ["CALLS"]
                }
            ],
            "tags": {"commit_sha": "abc123"},
            "stats": {
                "total_nodes": 100,
                "total_edges": 50,
                "node_segment_count": 1,
                "edge_segment_count": 1
            },
            "parent_version": 4
        }"#;

        let manifest: Manifest = serde_json::from_str(json).unwrap();

        // Core fields present
        assert_eq!(manifest.version, 5);
        assert_eq!(manifest.node_segments.len(), 1);
        assert_eq!(manifest.edge_segments.len(), 1);
        assert_eq!(manifest.parent_version, Some(4));

        // L1 fields default to empty / None
        assert!(manifest.l1_node_segments.is_empty());
        assert!(manifest.l1_edge_segments.is_empty());
        assert!(manifest.last_compaction.is_none());
    }

    #[test]
    fn test_manifest_with_l1_segments_roundtrip() {
        let l1_node = SegmentDescriptor {
            segment_id: 100,
            segment_type: SegmentType::Nodes,
            shard_id: Some(0),
            record_count: 500,
            byte_size: 50000,
            node_types: HashSet::from(["FUNCTION".to_string(), "CLASS".to_string()]),
            file_paths: HashSet::from(["src/main.rs".to_string(), "src/lib.rs".to_string()]),
            edge_types: HashSet::new(),
        };

        let l1_edge = SegmentDescriptor {
            segment_id: 101,
            segment_type: SegmentType::Edges,
            shard_id: Some(0),
            record_count: 200,
            byte_size: 16000,
            node_types: HashSet::new(),
            file_paths: HashSet::new(),
            edge_types: HashSet::from(["CALLS".to_string(), "IMPORTS_FROM".to_string()]),
        };

        let compaction_info = CompactionInfo {
            manifest_version: 5,
            timestamp_ms: 1707826800000,
            l0_segments_merged: 4,
        };

        let manifest = Manifest {
            version: 6,
            created_at: 1707826900,
            node_segments: std::sync::Arc::new(vec![make_node_descriptor(10, 50)]),
            edge_segments: std::sync::Arc::new(vec![make_edge_descriptor(11, 25)]),
            tags: HashMap::new(),
            stats: ManifestStats {
                total_nodes: 550,
                total_edges: 225,
                node_segment_count: 2,
                edge_segment_count: 2,
            },
            parent_version: Some(5),
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(vec![l1_node]),
            l1_edge_segments: std::sync::Arc::new(vec![l1_edge]),
            last_compaction: Some(compaction_info),
        };

        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let deserialized: Manifest = serde_json::from_str(&json).unwrap();

        assert_eq!(manifest, deserialized);

        // Verify L1 fields survived roundtrip
        assert_eq!(deserialized.l1_node_segments.len(), 1);
        assert_eq!(deserialized.l1_node_segments[0].segment_id, 100);
        assert_eq!(deserialized.l1_node_segments[0].record_count, 500);
        assert!(deserialized.l1_node_segments[0].node_types.contains("FUNCTION"));
        assert!(deserialized.l1_node_segments[0].node_types.contains("CLASS"));

        assert_eq!(deserialized.l1_edge_segments.len(), 1);
        assert_eq!(deserialized.l1_edge_segments[0].segment_id, 101);
        assert!(deserialized.l1_edge_segments[0].edge_types.contains("CALLS"));

        let lc = deserialized.last_compaction.unwrap();
        assert_eq!(lc.manifest_version, 5);
        assert_eq!(lc.timestamp_ms, 1707826800000);
        assert_eq!(lc.l0_segments_merged, 4);
    }

    #[test]
    fn test_manifest_l1_segments_skip_serializing_if_empty() {
        // When l1 fields are empty, they should be omitted from JSON
        // (via skip_serializing_if = "Vec::is_empty" / Option::is_none)
        let manifest = Manifest {
            version: 1,
            created_at: 100,
            node_segments: std::sync::Arc::new(vec![]),
            edge_segments: std::sync::Arc::new(vec![]),
            tags: HashMap::new(),
            stats: ManifestStats::from_segments(&[], &[]),
            parent_version: None,
            tombstoned_node_ids: Vec::new(),
            tombstoned_edge_keys: Vec::new(),
            l1_node_segments: std::sync::Arc::new(Vec::new()),
            l1_edge_segments: std::sync::Arc::new(Vec::new()),
            last_compaction: None,
        };

        let json = serde_json::to_string(&manifest).unwrap();

        // Fields should not appear in serialized JSON when empty
        assert!(!json.contains("l1_node_segments"));
        assert!(!json.contains("l1_edge_segments"));
        assert!(!json.contains("last_compaction"));
    }
}
