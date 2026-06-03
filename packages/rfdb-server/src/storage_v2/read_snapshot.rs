//! MVCC version-pinned read path (RFD-71 phase B1).
//!
//! A [`ReadSnapshot`] is an immutable view of ONE published manifest version:
//! its segment descriptor set (L0 + optional L1, per shard) plus that version's
//! cumulative tombstone set. Reads resolved through a snapshot see exactly the
//! committed data of that version — never the live, mutable `Shard.write_buffer`
//! (the in-flight memtable), and never a newer commit's segments.
//!
//! This decouples a read from the live shard state and is the foundation of
//! snapshot isolation (B2/B4 build on it). In the single-writer B1 base the
//! result is behaviourally equivalent to the live read path for COMMITTED data,
//! with one deliberate semantic break: a snapshot does NOT observe uncommitted
//! writes still sitting in the write buffer (there are none after a
//! `commit_batch`, since phase 7 flushes the buffer to immutable segments and
//! phase 8 publishes them).
//!
//! ## SegmentCache
//! Segment files are immutable once written, so an opened segment is valid for
//! the life of the file. [`SegmentCache`] memoises `segment_id -> Arc<segment>`
//! so a read never depends on whether the owning `Shard` still holds the segment
//! open. For ephemeral (in-memory) stores there is no file to open; the snapshot
//! read falls back to borrowing the live segment from the shard
//! (`Shard::node_segment_by_id` / `edge_segment_by_id`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::error::Result;
use crate::storage_v2::manifest::{ManifestStore, SegmentDescriptor, VersionPins};
use crate::storage_v2::segment::{EdgeSegmentV2, NodeSegmentV2};
use crate::storage_v2::shard::TombstoneSet;

// ── SegmentCache ───────────────────────────────────────────────────

/// Store-level cache of opened immutable segments, keyed by `segment_id`.
///
/// Thread-safe (guarded `HashMap`s). Reads are single-threaded in B1, but the
/// cache is `Sync` so B4 concurrency can share it. A cached `Arc<segment>` is
/// valid forever because segment files are immutable; entries are only added
/// (B5 will add eviction tied to live-reader epochs).
#[derive(Default)]
pub struct SegmentCache {
    node_cache: RwLock<HashMap<u64, Arc<NodeSegmentV2>>>,
    edge_cache: RwLock<HashMap<u64, Arc<EdgeSegmentV2>>>,
}

impl SegmentCache {
    /// Create an empty cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// Get an opened node segment by `segment_id`, opening + caching on miss.
    ///
    /// `desc` provides the file path derivation (`segment_id` + `shard_id` +
    /// type) relative to `db_path`. Only valid for disk-backed stores; ephemeral
    /// callers resolve via the live shard instead.
    pub fn get_node_segment(
        &self,
        db_path: &Path,
        desc: &SegmentDescriptor,
    ) -> Result<Arc<NodeSegmentV2>> {
        if let Some(seg) = self.node_cache.read().unwrap().get(&desc.segment_id) {
            return Ok(Arc::clone(seg));
        }
        let path: PathBuf = desc.file_path(db_path);
        let seg = Arc::new(NodeSegmentV2::open(&path)?);
        self.node_cache
            .write()
            .unwrap()
            .insert(desc.segment_id, Arc::clone(&seg));
        Ok(seg)
    }

    /// Get an opened edge segment by `segment_id`, opening + caching on miss.
    pub fn get_edge_segment(
        &self,
        db_path: &Path,
        desc: &SegmentDescriptor,
    ) -> Result<Arc<EdgeSegmentV2>> {
        if let Some(seg) = self.edge_cache.read().unwrap().get(&desc.segment_id) {
            return Ok(Arc::clone(seg));
        }
        let path: PathBuf = desc.file_path(db_path);
        let seg = Arc::new(EdgeSegmentV2::open(&path)?);
        self.edge_cache
            .write()
            .unwrap()
            .insert(desc.segment_id, Arc::clone(&seg));
        Ok(seg)
    }

    /// Register an already-opened node segment under `segment_id` (MVCC B4).
    ///
    /// The concurrent commit path writes a private segment file, opens it once,
    /// and registers the `Arc` here so the first post-publish read is a cache
    /// hit instead of a re-open. Idempotent: inserting the same immutable
    /// segment id twice is harmless (segments are content-stable).
    pub fn insert_node_segment(&self, segment_id: u64, seg: Arc<NodeSegmentV2>) {
        self.node_cache.write().unwrap().insert(segment_id, seg);
    }

    /// Edge companion to [`Self::insert_node_segment`].
    pub fn insert_edge_segment(&self, segment_id: u64, seg: Arc<EdgeSegmentV2>) {
        self.edge_cache.write().unwrap().insert(segment_id, seg);
    }

    /// Number of cached (node, edge) segments. For diagnostics/tests.
    pub fn len(&self) -> (usize, usize) {
        (
            self.node_cache.read().unwrap().len(),
            self.edge_cache.read().unwrap().len(),
        )
    }

    /// True if nothing is cached yet.
    pub fn is_empty(&self) -> bool {
        let (n, e) = self.len();
        n == 0 && e == 0
    }
}

impl std::fmt::Debug for SegmentCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (n, e) = self.len();
        f.debug_struct("SegmentCache")
            .field("node_segments", &n)
            .field("edge_segments", &e)
            .finish()
    }
}

// ── ReadSnapshot ───────────────────────────────────────────────────

/// Immutable, version-pinned view of one published manifest version.
///
/// Captured atomically from `ManifestStore::current()` (segment descriptors,
/// newest-last per shard, matching the live shard's append order) plus the
/// version's cumulative tombstone set (`Arc::clone` of the manifest's
/// `current_tombstones` — the version authority, MVCC B3; the manifest holds
/// the cumulative set in memory and snapshots freeze its Arc immutably).
///
/// Holding a `ReadSnapshot` pins the version: the descriptors reference
/// immutable segments, and the tombstone `Arc` is frozen at capture time. Later
/// commits produce new segments / new tombstone `Arc`s that this snapshot does
/// not see.
///
/// ## MVCC B5 — version pinning
/// Construction registers a live-reader pin on `version` with the store's
/// shared [`VersionPins`] registry; [`Drop`] releases it. While ANY snapshot
/// pins a version, GC/compaction must not reclaim that version's segment files
/// (deleting a file under a live `mmap` is undefined behaviour). Cloning a
/// snapshot registers an additional pin (it is another live view of the same
/// version). The `Clone` and `Drop` impls are hand-written for exactly this
/// reason — a derived `Clone` would copy the `Arc` without bumping the
/// refcount, and the segment could be reclaimed while a clone is still live.
pub struct ReadSnapshot {
    /// Manifest version this snapshot is pinned to.
    pub version: u64,
    /// L0 node segment descriptors (oldest-first, as in the manifest).
    pub node_segments: Vec<SegmentDescriptor>,
    /// L0 edge segment descriptors (oldest-first).
    pub edge_segments: Vec<SegmentDescriptor>,
    /// L1 (compacted) node segment descriptors — at most one per shard.
    pub l1_node_segments: Vec<SegmentDescriptor>,
    /// L1 (compacted) edge segment descriptors — at most one per shard.
    pub l1_edge_segments: Vec<SegmentDescriptor>,
    /// The version's cumulative tombstone set (frozen at capture).
    pub tombstones: Arc<TombstoneSet>,
    /// MVCC B5: shared pin registry. `Some` for snapshots captured from a real
    /// store (the common path); the pin on `version` is held for the life of
    /// this snapshot and released on drop. `None` only for synthetic snapshots
    /// constructed without a store (none exist in current code, but the field
    /// is an `Option` so a future test helper need not fabricate a registry).
    pins: Option<Arc<VersionPins>>,
}

impl ReadSnapshot {
    /// Capture the current published version's descriptor set + tombstones, and
    /// register a live-reader pin on that version (MVCC B5).
    ///
    /// `tombstones` is the version authority (MVCC B3) — the manifest's
    /// `current_tombstones` Arc, frozen here for the life of the snapshot. The
    /// pin (cloned from the manifest's shared [`VersionPins`]) guarantees the
    /// version's segment files survive until this snapshot (and all its clones)
    /// drop.
    pub fn capture(manifest: &ManifestStore, tombstones: Arc<TombstoneSet>) -> Self {
        let m = manifest.current();
        let version = m.version;
        let pins = manifest.version_pins();
        // Pin BEFORE the snapshot is observable to any GC: capture runs inside
        // the manifest lock (see `MultiShardStore::snapshot`), and GC also takes
        // the manifest mutably, so registering here is serialized w.r.t. GC's
        // min_pinned read — no window where GC sees version V eligible while a
        // reader is mid-capture of V.
        pins.pin(version);
        Self {
            version,
            node_segments: m.node_segments.clone(),
            edge_segments: m.edge_segments.clone(),
            l1_node_segments: m.l1_node_segments.clone(),
            l1_edge_segments: m.l1_edge_segments.clone(),
            tombstones,
            pins: Some(pins),
        }
    }

    /// L0 node descriptors owned by `shard_id` (descriptors carry their shard).
    pub fn shard_node_descriptors(&self, shard_id: u16) -> impl Iterator<Item = &SegmentDescriptor> {
        self.node_segments
            .iter()
            .filter(move |d| d.shard_id.unwrap_or(0) == shard_id)
    }

    /// L0 edge descriptors owned by `shard_id`.
    pub fn shard_edge_descriptors(&self, shard_id: u16) -> impl Iterator<Item = &SegmentDescriptor> {
        self.edge_segments
            .iter()
            .filter(move |d| d.shard_id.unwrap_or(0) == shard_id)
    }

    /// L1 node descriptor for `shard_id`, if any (≤ 1 per shard).
    pub fn shard_l1_node_descriptor(&self, shard_id: u16) -> Option<&SegmentDescriptor> {
        self.l1_node_segments
            .iter()
            .find(|d| d.shard_id.unwrap_or(0) == shard_id)
    }

    /// L1 edge descriptor for `shard_id`, if any.
    pub fn shard_l1_edge_descriptor(&self, shard_id: u16) -> Option<&SegmentDescriptor> {
        self.l1_edge_segments
            .iter()
            .find(|d| d.shard_id.unwrap_or(0) == shard_id)
    }

    /// Distinct shard IDs that appear anywhere in this snapshot's descriptors.
    pub fn shard_ids(&self) -> Vec<u16> {
        let mut set: HashSet<u16> = HashSet::new();
        for d in self
            .node_segments
            .iter()
            .chain(self.edge_segments.iter())
            .chain(self.l1_node_segments.iter())
            .chain(self.l1_edge_segments.iter())
        {
            set.insert(d.shard_id.unwrap_or(0));
        }
        let mut v: Vec<u16> = set.into_iter().collect();
        v.sort_unstable();
        v
    }
}

/// MVCC B5: a clone is another live view of the same version — it must register
/// an ADDITIONAL pin so the version is not reclaimed while the clone is alive.
/// (A derived `Clone` would copy the `Arc<VersionPins>` without incrementing the
/// per-version refcount, under-counting live readers.)
impl Clone for ReadSnapshot {
    fn clone(&self) -> Self {
        if let Some(pins) = &self.pins {
            pins.pin(self.version);
        }
        Self {
            version: self.version,
            node_segments: self.node_segments.clone(),
            edge_segments: self.edge_segments.clone(),
            l1_node_segments: self.l1_node_segments.clone(),
            l1_edge_segments: self.l1_edge_segments.clone(),
            tombstones: Arc::clone(&self.tombstones),
            pins: self.pins.clone(),
        }
    }
}

/// MVCC B5: releasing the live-reader pin is the whole point — once the last
/// snapshot (and clones) of a version drop, GC may reclaim that version's
/// segments.
impl Drop for ReadSnapshot {
    fn drop(&mut self) {
        if let Some(pins) = &self.pins {
            pins.unpin(self.version);
        }
    }
}

impl std::fmt::Debug for ReadSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadSnapshot")
            .field("version", &self.version)
            .field("node_segments", &self.node_segments.len())
            .field("edge_segments", &self.edge_segments.len())
            .field("l1_node_segments", &self.l1_node_segments.len())
            .field("l1_edge_segments", &self.l1_edge_segments.len())
            .field("tombstone_nodes", &self.tombstones.node_count())
            .field("tombstone_edges", &self.tombstones.edge_count())
            .finish()
    }
}
