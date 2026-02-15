//! Single-shard read/write unit for RFDB v2 storage.
//!
//! A shard is the primary read/write unit: a directory of immutable columnar
//! segments + an in-memory write buffer. It supports three query patterns
//! (point lookup, attribute search, neighbor queries) and a flush-to-disk
//! write path.
//!
//! Write path: records -> write buffer -> flush -> segment files
//! Read path:  query -> write buffer scan + segment scan -> merge
//!
//! A Shard does NOT own ManifestStore. ManifestStore is a database-level
//! concern (T3.x). Shard receives segment descriptors and returns flush
//! results; the caller updates the manifest.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Cursor};
use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::storage_v2::manifest::SegmentDescriptor;
use crate::storage_v2::segment::{EdgeSegmentV2, NodeSegmentV2};
use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2, SegmentMeta, SegmentType};
use crate::storage_v2::write_buffer::WriteBuffer;
use crate::storage_v2::writer::{EdgeSegmentWriter, NodeSegmentWriter};

// ── Tombstone Set ────────────────────────────────────────────────────

/// Tombstone state for a shard.
///
/// In-memory set of logically deleted node IDs and edge keys.
/// Persisted in manifest, loaded on shard open.
/// Cleared when compaction (T4.x) physically removes records.
///
/// Query paths check this set before returning any record.
/// O(1) per check via HashSet.
pub struct TombstoneSet {
    /// Deleted node IDs. Queries skip records with these IDs.
    pub node_ids: HashSet<u128>,
    /// Deleted edge keys (src, dst, edge_type). Queries skip matching edges.
    pub edge_keys: HashSet<(u128, u128, String)>,
}

impl TombstoneSet {
    /// Create empty tombstone set.
    pub fn new() -> Self {
        Self {
            node_ids: HashSet::new(),
            edge_keys: HashSet::new(),
        }
    }

    /// Create from manifest data (loaded on shard open).
    pub fn from_manifest(
        node_ids: Vec<u128>,
        edge_keys: Vec<(u128, u128, String)>,
    ) -> Self {
        Self {
            node_ids: node_ids.into_iter().collect(),
            edge_keys: edge_keys.into_iter().collect(),
        }
    }

    /// Check if a node ID is tombstoned.
    #[inline]
    pub fn contains_node(&self, id: u128) -> bool {
        self.node_ids.contains(&id)
    }

    /// Check if an edge key is tombstoned.
    #[inline]
    pub fn contains_edge(&self, src: u128, dst: u128, edge_type: &str) -> bool {
        self.edge_keys.contains(&(src, dst, edge_type.to_string()))
    }

    /// Add tombstoned node IDs (union with existing).
    pub fn add_nodes(&mut self, ids: impl IntoIterator<Item = u128>) {
        self.node_ids.extend(ids);
    }

    /// Add tombstoned edge keys (union with existing).
    pub fn add_edges(&mut self, keys: impl IntoIterator<Item = (u128, u128, String)>) {
        self.edge_keys.extend(keys);
    }

    /// Number of tombstoned nodes.
    pub fn node_count(&self) -> usize {
        self.node_ids.len()
    }

    /// Number of tombstoned edges.
    pub fn edge_count(&self) -> usize {
        self.edge_keys.len()
    }

    /// True if no tombstones.
    pub fn is_empty(&self) -> bool {
        self.node_ids.is_empty() && self.edge_keys.is_empty()
    }
}

impl Default for TombstoneSet {
    fn default() -> Self {
        Self::new()
    }
}

// ── Flush Result ─────────────────────────────────────────────────────

/// Result of flushing a write buffer to disk segments.
///
/// Contains metadata for manifest update. The caller is responsible for:
/// 1. Providing segment IDs via ManifestStore::next_segment_id() BEFORE flush
/// 2. Creating SegmentDescriptors from the returned SegmentMeta
/// 3. Committing a new manifest version
pub struct FlushResult {
    /// Metadata about the written node segment. None if buffer had no nodes.
    pub node_meta: Option<SegmentMeta>,

    /// Metadata about the written edge segment. None if buffer had no edges.
    pub edge_meta: Option<SegmentMeta>,

    /// Path to the written node segment file. None for ephemeral or no nodes.
    pub node_segment_path: Option<PathBuf>,

    /// Path to the written edge segment file. None for ephemeral or no edges.
    pub edge_segment_path: Option<PathBuf>,
}

/// A shard is the primary read/write unit for RFDB v2.
///
/// Segments are stored in Vec, ordered by creation time (oldest first,
/// newest last). Reads scan newest-to-oldest so newer data wins on dedup.
pub struct Shard {
    /// Shard directory path. None for ephemeral shards (in-memory only).
    path: Option<PathBuf>,

    /// Optional shard ID for future T3.x multi-shard support.
    /// For T2.2, always None (single shard).
    shard_id: Option<u16>,

    /// In-memory write buffer (unflushed records).
    write_buffer: WriteBuffer,

    /// Loaded node segments, ordered oldest-first (append order).
    /// Invariant: node_segments[i] corresponds to node_descriptors[i].
    node_segments: Vec<NodeSegmentV2>,

    /// Loaded edge segments, ordered oldest-first (append order).
    /// Invariant: edge_segments[i] corresponds to edge_descriptors[i].
    edge_segments: Vec<EdgeSegmentV2>,

    /// Segment descriptors for node segments (from manifest).
    /// Used for zone map pruning at descriptor level (no segment I/O).
    node_descriptors: Vec<SegmentDescriptor>,

    /// Segment descriptors for edge segments (from manifest).
    edge_descriptors: Vec<SegmentDescriptor>,

    /// Tombstone state (loaded from manifest on open).
    tombstones: TombstoneSet,

    /// L1 (compacted) node segment — sorted, deduplicated, tombstones removed.
    /// None if shard has never been compacted.
    l1_node_segment: Option<NodeSegmentV2>,

    /// L1 node segment descriptor (for manifest tracking / zone map pruning).
    l1_node_descriptor: Option<SegmentDescriptor>,

    /// L1 (compacted) edge segment.
    l1_edge_segment: Option<EdgeSegmentV2>,

    /// L1 edge segment descriptor.
    l1_edge_descriptor: Option<SegmentDescriptor>,
}

// -- Constructors -------------------------------------------------------------

impl Shard {
    /// Create new shard backed by a directory.
    /// Creates the directory if it does not exist.
    /// Starts with empty write buffer and no segments.
    pub fn create(path: &Path) -> Result<Self> {
        std::fs::create_dir_all(path)?;
        Ok(Self {
            path: Some(path.to_path_buf()),
            shard_id: None,
            write_buffer: WriteBuffer::new(),
            node_segments: Vec::new(),
            edge_segments: Vec::new(),
            node_descriptors: Vec::new(),
            edge_descriptors: Vec::new(),
            tombstones: TombstoneSet::new(),
            l1_node_segment: None,
            l1_node_descriptor: None,
            l1_edge_segment: None,
            l1_edge_descriptor: None,
        })
    }

    /// Open existing shard from directory, loading segments described
    /// by the provided descriptors.
    ///
    /// For each descriptor, opens the segment file via mmap.
    /// Descriptors must be ordered oldest-first (append order from manifest).
    ///
    /// `db_path` is the database root (for resolving segment file paths
    /// via SegmentDescriptor::file_path()).
    pub fn open(
        path: &Path,
        db_path: &Path,
        node_descriptors: Vec<SegmentDescriptor>,
        edge_descriptors: Vec<SegmentDescriptor>,
    ) -> Result<Self> {
        let mut node_segments = Vec::with_capacity(node_descriptors.len());
        for desc in &node_descriptors {
            let file_path = desc.file_path(db_path);
            let seg = NodeSegmentV2::open(&file_path)?;
            node_segments.push(seg);
        }

        let mut edge_segments = Vec::with_capacity(edge_descriptors.len());
        for desc in &edge_descriptors {
            let file_path = desc.file_path(db_path);
            let seg = EdgeSegmentV2::open(&file_path)?;
            edge_segments.push(seg);
        }

        Ok(Self {
            path: Some(path.to_path_buf()),
            shard_id: None,
            write_buffer: WriteBuffer::new(),
            node_segments,
            edge_segments,
            node_descriptors,
            edge_descriptors,
            tombstones: TombstoneSet::new(),
            l1_node_segment: None,
            l1_node_descriptor: None,
            l1_edge_segment: None,
            l1_edge_descriptor: None,
        })
    }

    /// Create ephemeral shard (in-memory only, no disk I/O).
    /// Flush writes to in-memory byte buffers loaded as segments.
    pub fn ephemeral() -> Self {
        Self {
            path: None,
            shard_id: None,
            write_buffer: WriteBuffer::new(),
            node_segments: Vec::new(),
            edge_segments: Vec::new(),
            node_descriptors: Vec::new(),
            edge_descriptors: Vec::new(),
            tombstones: TombstoneSet::new(),
            l1_node_segment: None,
            l1_node_descriptor: None,
            l1_edge_segment: None,
            l1_edge_descriptor: None,
        }
    }

    /// Create new shard for multi-shard mode (with shard_id).
    ///
    /// The `path` is the shard directory (e.g., `<db_path>/segments/NN/`).
    /// Creates the directory if it does not exist.
    pub fn create_for_shard(path: &Path, shard_id: u16) -> Result<Self> {
        std::fs::create_dir_all(path)?;
        Ok(Self {
            path: Some(path.to_path_buf()),
            shard_id: Some(shard_id),
            write_buffer: WriteBuffer::new(),
            node_segments: Vec::new(),
            edge_segments: Vec::new(),
            node_descriptors: Vec::new(),
            edge_descriptors: Vec::new(),
            tombstones: TombstoneSet::new(),
            l1_node_segment: None,
            l1_node_descriptor: None,
            l1_edge_segment: None,
            l1_edge_descriptor: None,
        })
    }

    /// Open existing shard for multi-shard mode (with shard_id).
    ///
    /// Like `open()` but sets `shard_id` on the shard so flushed segments
    /// get descriptors with the correct shard_id.
    ///
    /// `path` is the shard directory (e.g., `<db_path>/segments/NN/`).
    /// `db_path` is the database root (for resolving segment file paths
    /// via `SegmentDescriptor::file_path()`).
    pub fn open_for_shard(
        path: &Path,
        db_path: &Path,
        shard_id: u16,
        node_descriptors: Vec<SegmentDescriptor>,
        edge_descriptors: Vec<SegmentDescriptor>,
    ) -> Result<Self> {
        let mut node_segments = Vec::with_capacity(node_descriptors.len());
        for desc in &node_descriptors {
            let file_path = desc.file_path(db_path);
            let seg = NodeSegmentV2::open(&file_path)?;
            node_segments.push(seg);
        }

        let mut edge_segments = Vec::with_capacity(edge_descriptors.len());
        for desc in &edge_descriptors {
            let file_path = desc.file_path(db_path);
            let seg = EdgeSegmentV2::open(&file_path)?;
            edge_segments.push(seg);
        }

        Ok(Self {
            path: Some(path.to_path_buf()),
            shard_id: Some(shard_id),
            write_buffer: WriteBuffer::new(),
            node_segments,
            edge_segments,
            node_descriptors,
            edge_descriptors,
            tombstones: TombstoneSet::new(),
            l1_node_segment: None,
            l1_node_descriptor: None,
            l1_edge_segment: None,
            l1_edge_descriptor: None,
        })
    }
}

// -- Write Operations ---------------------------------------------------------

impl Shard {
    /// Add nodes to write buffer. Immediately queryable.
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>) {
        self.write_buffer.add_nodes(records);
    }

    /// Add edges to write buffer. Immediately queryable.
    /// Dedup via edge_keys in WriteBuffer.
    pub fn add_edges(&mut self, records: Vec<EdgeRecordV2>) {
        self.write_buffer.add_edges(records);
    }
}

// -- Tombstone Operations -----------------------------------------------------

impl Shard {
    /// Set tombstone state (called by MultiShardStore after commit).
    ///
    /// Replaces the entire tombstone set. Used when loading from manifest
    /// or after commit_batch updates tombstones.
    ///
    /// Complexity: O(1) (pointer swap)
    pub fn set_tombstones(&mut self, tombstones: TombstoneSet) {
        self.tombstones = tombstones;
    }

    /// Get reference to current tombstone set (for reading).
    pub fn tombstones(&self) -> &TombstoneSet {
        &self.tombstones
    }

    /// Get mutable reference to tombstone set.
    pub fn tombstones_mut(&mut self) -> &mut TombstoneSet {
        &mut self.tombstones
    }

    /// Find edge keys (src, dst, edge_type) where src is in the given ID set.
    ///
    /// Uses bloom filter on each edge segment for pre-filtering:
    /// if no src_id passes the bloom check, the entire segment is skipped.
    /// Also scans the write buffer for unflushed edges.
    ///
    /// Returns Vec of (src, dst, edge_type) tuples for tombstoning.
    ///
    /// Complexity: O(S * (K * B + N_matching))
    ///   where S = edge segments, K = |src_ids|, B = bloom check cost,
    ///   N_matching = records in segments that pass bloom filter
    pub fn find_edge_keys_by_src_ids(
        &self,
        src_ids: &HashSet<u128>,
    ) -> Vec<(u128, u128, String)> {
        let mut keys = Vec::new();

        if src_ids.is_empty() {
            return keys;
        }

        // Step 1: Scan L0 edge segments with bloom pre-filter
        for seg in &self.edge_segments {
            // Bloom check: does this segment maybe contain edges from any src_id?
            let may_match = src_ids.iter().any(|id| seg.maybe_contains_src(*id));
            if !may_match {
                continue;
            }

            // Scan matching segment
            for j in 0..seg.record_count() {
                let src = seg.get_src(j);
                if src_ids.contains(&src) {
                    let dst = seg.get_dst(j);
                    let edge_type = seg.get_edge_type(j).to_string();
                    keys.push((src, dst, edge_type));
                }
            }
        }

        // Step 2: Scan L1 edge segment
        if let Some(l1_seg) = &self.l1_edge_segment {
            let may_match = src_ids.iter().any(|id| l1_seg.maybe_contains_src(*id));
            if may_match {
                for j in 0..l1_seg.record_count() {
                    let src = l1_seg.get_src(j);
                    if src_ids.contains(&src) {
                        let dst = l1_seg.get_dst(j);
                        let edge_type = l1_seg.get_edge_type(j).to_string();
                        keys.push((src, dst, edge_type));
                    }
                }
            }
        }

        // Step 3: Scan write buffer
        for edge in self.write_buffer.iter_edges() {
            if src_ids.contains(&edge.src) {
                keys.push((edge.src, edge.dst, edge.edge_type.clone()));
            }
        }

        keys
    }
}

// -- L1 Accessors + Management ------------------------------------------------

impl Shard {
    /// Number of L0 node segments.
    pub fn l0_node_segment_count(&self) -> usize {
        self.node_segments.len()
    }

    /// Number of L0 edge segments.
    pub fn l0_edge_segment_count(&self) -> usize {
        self.edge_segments.len()
    }

    /// Whether this shard has been compacted (has L1 segments).
    pub fn has_l1(&self) -> bool {
        self.l1_node_segment.is_some() || self.l1_edge_segment.is_some()
    }

    /// Get shard ID.
    pub fn shard_id(&self) -> Option<u16> {
        self.shard_id
    }

    /// Get shard directory path.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Get L1 node descriptor.
    pub fn l1_node_descriptor(&self) -> Option<&SegmentDescriptor> {
        self.l1_node_descriptor.as_ref()
    }

    /// Get L1 edge descriptor.
    pub fn l1_edge_descriptor(&self) -> Option<&SegmentDescriptor> {
        self.l1_edge_descriptor.as_ref()
    }

    /// Get references to L0 node segments (for merge).
    pub fn l0_node_segments(&self) -> &[NodeSegmentV2] {
        &self.node_segments
    }

    /// Get references to L0 edge segments (for merge).
    pub fn l0_edge_segments(&self) -> &[EdgeSegmentV2] {
        &self.edge_segments
    }

    /// Get L1 node segment (for merge input during re-compaction).
    pub fn l1_node_segment(&self) -> Option<&NodeSegmentV2> {
        self.l1_node_segment.as_ref()
    }

    /// Get L1 edge segment (for merge input during re-compaction).
    pub fn l1_edge_segment(&self) -> Option<&EdgeSegmentV2> {
        self.l1_edge_segment.as_ref()
    }

    /// Set L1 segments after compaction or on shard open.
    pub fn set_l1_segments(
        &mut self,
        node_segment: Option<NodeSegmentV2>,
        node_descriptor: Option<SegmentDescriptor>,
        edge_segment: Option<EdgeSegmentV2>,
        edge_descriptor: Option<SegmentDescriptor>,
    ) {
        self.l1_node_segment = node_segment;
        self.l1_node_descriptor = node_descriptor;
        self.l1_edge_segment = edge_segment;
        self.l1_edge_descriptor = edge_descriptor;
    }

    /// Clear L0 segments after compaction (they've been merged into L1).
    /// Also clears tombstones since they were applied during merge.
    pub fn clear_l0_after_compaction(&mut self) {
        self.node_segments.clear();
        self.node_descriptors.clear();
        self.edge_segments.clear();
        self.edge_descriptors.clear();
        self.tombstones = TombstoneSet::new();
    }
}

// -- Flush --------------------------------------------------------------------

impl Shard {
    /// Flush write buffer to disk (or in-memory for ephemeral shards).
    ///
    /// Caller provides segment IDs (from ManifestStore::next_segment_id()).
    /// Pass None for node/edge segment ID if buffer has no nodes/edges
    /// of that type.
    ///
    /// After flush:
    /// - Write buffer is empty
    /// - New segments are loaded into shard's segment vectors
    /// - FlushResult contains SegmentMeta for manifest update
    ///
    /// Returns Ok(None) if write buffer is empty (no-op).
    pub fn flush_with_ids(
        &mut self,
        node_segment_id: Option<u64>,
        edge_segment_id: Option<u64>,
    ) -> Result<Option<FlushResult>> {
        if self.write_buffer.is_empty() {
            return Ok(None);
        }

        let mut result = FlushResult {
            node_meta: None,
            edge_meta: None,
            node_segment_path: None,
            edge_segment_path: None,
        };

        // -- Flush nodes ------------------------------------------------------
        let nodes = self.write_buffer.drain_nodes();
        if !nodes.is_empty() {
            let seg_id = node_segment_id
                .expect("node_segment_id required when buffer has nodes");

            let mut writer = NodeSegmentWriter::new();
            for node in &nodes {
                writer.add(node.clone());
            }

            if let Some(path) = &self.path {
                // Disk shard: write to file
                let seg_path = segment_file_path(path, seg_id, "nodes");
                let file = File::create(&seg_path)?;
                let mut buf_writer = BufWriter::new(file);
                let meta = writer.finish(&mut buf_writer)?;
                result.node_meta = Some(meta.clone());
                result.node_segment_path = Some(seg_path.clone());

                // Load the new segment immediately
                let seg = NodeSegmentV2::open(&seg_path)?;
                let desc = build_descriptor(seg_id, SegmentType::Nodes, self.shard_id, &meta);
                self.node_segments.push(seg);
                self.node_descriptors.push(desc);
            } else {
                // Ephemeral: write to in-memory buffer, load from bytes
                let mut cursor = Cursor::new(Vec::new());
                let meta = writer.finish(&mut cursor)?;
                let bytes = cursor.into_inner();
                result.node_meta = Some(meta.clone());

                let seg = NodeSegmentV2::from_bytes(&bytes)?;
                let desc = build_descriptor(seg_id, SegmentType::Nodes, self.shard_id, &meta);
                self.node_segments.push(seg);
                self.node_descriptors.push(desc);
            }
        }

        // -- Flush edges ------------------------------------------------------
        let edges = self.write_buffer.drain_edges();
        if !edges.is_empty() {
            let seg_id = edge_segment_id
                .expect("edge_segment_id required when buffer has edges");

            let mut writer = EdgeSegmentWriter::new();
            for edge in &edges {
                writer.add(edge.clone());
            }

            if let Some(path) = &self.path {
                let seg_path = segment_file_path(path, seg_id, "edges");
                let file = File::create(&seg_path)?;
                let mut buf_writer = BufWriter::new(file);
                let meta = writer.finish(&mut buf_writer)?;
                result.edge_meta = Some(meta.clone());
                result.edge_segment_path = Some(seg_path.clone());

                let seg = EdgeSegmentV2::open(&seg_path)?;
                let desc = build_descriptor(seg_id, SegmentType::Edges, self.shard_id, &meta);
                self.edge_segments.push(seg);
                self.edge_descriptors.push(desc);
            } else {
                let mut cursor = Cursor::new(Vec::new());
                let meta = writer.finish(&mut cursor)?;
                let bytes = cursor.into_inner();
                result.edge_meta = Some(meta.clone());

                let seg = EdgeSegmentV2::from_bytes(&bytes)?;
                let desc = build_descriptor(seg_id, SegmentType::Edges, self.shard_id, &meta);
                self.edge_segments.push(seg);
                self.edge_descriptors.push(desc);
            }
        }

        Ok(Some(result))
    }
}

// -- Point Lookup -------------------------------------------------------------

impl Shard {
    /// Get node by id. Checks write buffer first, then segments
    /// newest-to-oldest with bloom filter short-circuit.
    /// Returns owned NodeRecordV2 (cloned from buffer or reconstructed
    /// from segment).
    pub fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
        // Step 0: Tombstone check (O(1) HashSet lookup)
        if self.tombstones.contains_node(id) {
            return None;
        }

        // Step 1: Check write buffer (O(1) HashMap lookup)
        if let Some(node) = self.write_buffer.get_node(id) {
            return Some(node.clone());
        }

        // Step 2: Scan L0 segments newest-to-oldest
        for i in (0..self.node_segments.len()).rev() {
            let seg = &self.node_segments[i];

            // Bloom filter: definite-no in O(k) where k=7 hash functions
            if !seg.maybe_contains(id) {
                continue;
            }

            // Linear scan of ID column
            for j in 0..seg.record_count() {
                if seg.get_id(j) == id {
                    return Some(seg.get_record(j));
                }
            }
        }

        // Step 3: Check L1 node segment (oldest, compacted)
        if let Some(l1_seg) = &self.l1_node_segment {
            if l1_seg.maybe_contains(id) {
                for j in 0..l1_seg.record_count() {
                    if l1_seg.get_id(j) == id {
                        return Some(l1_seg.get_record(j));
                    }
                }
            }
        }

        // Step 4: Not found
        None
    }

    /// Check if node exists (same algorithm as get_node, avoids
    /// full record reconstruction).
    pub fn node_exists(&self, id: u128) -> bool {
        // Tombstone check first
        if self.tombstones.contains_node(id) {
            return false;
        }

        if self.write_buffer.get_node(id).is_some() {
            return true;
        }

        // L0 segments newest-to-oldest
        for i in (0..self.node_segments.len()).rev() {
            let seg = &self.node_segments[i];
            if !seg.maybe_contains(id) {
                continue;
            }
            for j in 0..seg.record_count() {
                if seg.get_id(j) == id {
                    return true;
                }
            }
        }

        // L1 segment (oldest, compacted)
        if let Some(l1_seg) = &self.l1_node_segment {
            if l1_seg.maybe_contains(id) {
                for j in 0..l1_seg.record_count() {
                    if l1_seg.get_id(j) == id {
                        return true;
                    }
                }
            }
        }

        false
    }
}

// -- Attribute Search ---------------------------------------------------------

impl Shard {
    /// Find nodes matching optional node_type and/or file filters.
    /// Both None = return all nodes (use with caution).
    ///
    /// Uses zone map pruning at descriptor level, then segment-level
    /// zone map, then columnar scan. Deduplicates by node id
    /// (write buffer wins, newest segment wins).
    pub fn find_nodes(
        &self,
        node_type: Option<&str>,
        file: Option<&str>,
    ) -> Vec<NodeRecordV2> {
        let mut seen_ids: HashSet<u128> = HashSet::new();
        let mut results: Vec<NodeRecordV2> = Vec::new();

        // Step 1: Scan write buffer (authoritative, scanned first)
        // Mark ALL buffer node IDs as seen so segment versions are shadowed,
        // even if the buffer version doesn't match the current filter.
        for node in self.write_buffer.iter_nodes() {
            seen_ids.insert(node.id);

            // Skip tombstoned nodes
            if self.tombstones.contains_node(node.id) {
                continue;
            }

            if let Some(nt) = node_type {
                if node.node_type != nt {
                    continue;
                }
            }
            if let Some(f) = file {
                if node.file != f {
                    continue;
                }
            }
            results.push(node.clone());
        }

        // Step 2: Scan L0 segments newest-to-oldest
        for i in (0..self.node_segments.len()).rev() {
            let desc = &self.node_descriptors[i];
            let seg = &self.node_segments[i];

            // Zone map pruning at descriptor level (O(1), no I/O)
            if !desc.may_contain(node_type, file, None) {
                continue;
            }

            // Zone map pruning at segment level (more precise, O(1))
            if let Some(nt) = node_type {
                if !seg.contains_node_type(nt) {
                    continue;
                }
            }
            if let Some(f) = file {
                if !seg.contains_file(f) {
                    continue;
                }
            }

            // Columnar scan of matching segment
            for j in 0..seg.record_count() {
                let id = seg.get_id(j);

                // Dedup: skip if already seen (buffer or newer segment wins)
                if seen_ids.contains(&id) {
                    continue;
                }

                // Skip tombstoned nodes
                if self.tombstones.contains_node(id) {
                    seen_ids.insert(id);
                    continue;
                }

                // Filter check using columnar accessors
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

                seen_ids.insert(id);
                results.push(seg.get_record(j));
            }
        }

        // Step 3: Scan L1 node segment (oldest, compacted)
        if let (Some(l1_desc), Some(l1_seg)) =
            (&self.l1_node_descriptor, &self.l1_node_segment)
        {
            // Zone map pruning at descriptor level
            if l1_desc.may_contain(node_type, file, None) {
                // Zone map pruning at segment level
                let type_ok = node_type.map_or(true, |nt| l1_seg.contains_node_type(nt));
                let file_ok = file.map_or(true, |f| l1_seg.contains_file(f));

                if type_ok && file_ok {
                    for j in 0..l1_seg.record_count() {
                        let id = l1_seg.get_id(j);

                        if seen_ids.contains(&id) {
                            continue;
                        }

                        if self.tombstones.contains_node(id) {
                            seen_ids.insert(id);
                            continue;
                        }

                        if let Some(nt) = node_type {
                            if l1_seg.get_node_type(j) != nt {
                                continue;
                            }
                        }
                        if let Some(f) = file {
                            if l1_seg.get_file(j) != f {
                                continue;
                            }
                        }

                        seen_ids.insert(id);
                        results.push(l1_seg.get_record(j));
                    }
                }
            }
        }

        results
    }
}

// -- Neighbor Queries ---------------------------------------------------------

impl Shard {
    /// Get outgoing edges from a node, optionally filtered by edge type(s).
    /// Scans write buffer + edge segments with bloom filter on src.
    pub fn get_outgoing_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2> {
        let mut results: Vec<EdgeRecordV2> = Vec::new();
        // Track seen edge keys for dedup across L0 and L1
        let mut seen_edge_keys: HashSet<(u128, u128, String)> = HashSet::new();

        // Step 1: Scan write buffer (authoritative, newest)
        for edge in self.write_buffer.find_edges_by_src(node_id) {
            seen_edge_keys.insert((edge.src, edge.dst, edge.edge_type.clone()));
            // Skip tombstoned edges
            if self.tombstones.contains_edge(edge.src, edge.dst, &edge.edge_type) {
                continue;
            }
            if let Some(types) = edge_types {
                if !types.contains(&edge.edge_type.as_str()) {
                    continue;
                }
            }
            results.push(edge.clone());
        }

        // Step 2: Scan L0 edge segments
        for i in 0..self.edge_segments.len() {
            let seg = &self.edge_segments[i];

            // Bloom filter on src
            if !seg.maybe_contains_src(node_id) {
                continue;
            }

            // Optional zone map check on edge_type
            if let Some(types) = edge_types {
                let has_any = types.iter().any(|t| seg.contains_edge_type(t));
                if !has_any {
                    continue;
                }
            }

            // Linear scan
            for j in 0..seg.record_count() {
                if seg.get_src(j) != node_id {
                    continue;
                }
                let dst = seg.get_dst(j);
                let edge_type = seg.get_edge_type(j);
                let key = (node_id, dst, edge_type.to_string());

                // Dedup: skip if already seen (buffer wins)
                if seen_edge_keys.contains(&key) {
                    continue;
                }
                seen_edge_keys.insert(key);

                // Skip tombstoned edges
                if self.tombstones.contains_edge(node_id, dst, edge_type) {
                    continue;
                }
                if let Some(types) = edge_types {
                    if !types.contains(&edge_type) {
                        continue;
                    }
                }
                results.push(seg.get_record(j));
            }
        }

        // Step 3: Scan L1 edge segment (oldest, compacted)
        if let Some(l1_seg) = &self.l1_edge_segment {
            if l1_seg.maybe_contains_src(node_id) {
                let type_ok = edge_types.map_or(true, |types| {
                    types.iter().any(|t| l1_seg.contains_edge_type(t))
                });
                if type_ok {
                    for j in 0..l1_seg.record_count() {
                        if l1_seg.get_src(j) != node_id {
                            continue;
                        }
                        let dst = l1_seg.get_dst(j);
                        let edge_type = l1_seg.get_edge_type(j);
                        let key = (node_id, dst, edge_type.to_string());

                        if seen_edge_keys.contains(&key) {
                            continue;
                        }
                        seen_edge_keys.insert(key);

                        if self.tombstones.contains_edge(node_id, dst, edge_type) {
                            continue;
                        }
                        if let Some(types) = edge_types {
                            if !types.contains(&edge_type) {
                                continue;
                            }
                        }
                        results.push(l1_seg.get_record(j));
                    }
                }
            }
        }

        results
    }

    /// Get incoming edges to a node, optionally filtered by edge type(s).
    /// Scans write buffer + edge segments with bloom filter on dst.
    pub fn get_incoming_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2> {
        let mut results: Vec<EdgeRecordV2> = Vec::new();
        // Track seen edge keys for dedup across L0 and L1
        let mut seen_edge_keys: HashSet<(u128, u128, String)> = HashSet::new();

        // Step 1: Scan write buffer (authoritative, newest)
        for edge in self.write_buffer.find_edges_by_dst(node_id) {
            seen_edge_keys.insert((edge.src, edge.dst, edge.edge_type.clone()));
            // Skip tombstoned edges
            if self.tombstones.contains_edge(edge.src, edge.dst, &edge.edge_type) {
                continue;
            }
            if let Some(types) = edge_types {
                if !types.contains(&edge.edge_type.as_str()) {
                    continue;
                }
            }
            results.push(edge.clone());
        }

        // Step 2: Scan L0 edge segments
        for i in 0..self.edge_segments.len() {
            let seg = &self.edge_segments[i];

            // Bloom filter on dst
            if !seg.maybe_contains_dst(node_id) {
                continue;
            }

            // Optional zone map check on edge_type
            if let Some(types) = edge_types {
                let has_any = types.iter().any(|t| seg.contains_edge_type(t));
                if !has_any {
                    continue;
                }
            }

            // Linear scan
            for j in 0..seg.record_count() {
                if seg.get_dst(j) != node_id {
                    continue;
                }
                let src = seg.get_src(j);
                let edge_type = seg.get_edge_type(j);
                let key = (src, node_id, edge_type.to_string());

                // Dedup: skip if already seen (buffer wins)
                if seen_edge_keys.contains(&key) {
                    continue;
                }
                seen_edge_keys.insert(key);

                // Skip tombstoned edges
                if self.tombstones.contains_edge(src, node_id, edge_type) {
                    continue;
                }
                if let Some(types) = edge_types {
                    if !types.contains(&edge_type) {
                        continue;
                    }
                }
                results.push(seg.get_record(j));
            }
        }

        // Step 3: Scan L1 edge segment (oldest, compacted)
        if let Some(l1_seg) = &self.l1_edge_segment {
            if l1_seg.maybe_contains_dst(node_id) {
                let type_ok = edge_types.map_or(true, |types| {
                    types.iter().any(|t| l1_seg.contains_edge_type(t))
                });
                if type_ok {
                    for j in 0..l1_seg.record_count() {
                        if l1_seg.get_dst(j) != node_id {
                            continue;
                        }
                        let src = l1_seg.get_src(j);
                        let edge_type = l1_seg.get_edge_type(j);
                        let key = (src, node_id, edge_type.to_string());

                        if seen_edge_keys.contains(&key) {
                            continue;
                        }
                        seen_edge_keys.insert(key);

                        if self.tombstones.contains_edge(src, node_id, edge_type) {
                            continue;
                        }
                        if let Some(types) = edge_types {
                            if !types.contains(&edge_type) {
                                continue;
                            }
                        }
                        results.push(l1_seg.get_record(j));
                    }
                }
            }
        }

        results
    }
}

// -- Stats --------------------------------------------------------------------

impl Shard {
    /// Total node count (write buffer + all node segments + L1).
    /// Note: may overcount if same node ID exists in multiple segments
    /// (exact count requires dedup scan). For stats purposes only.
    pub fn node_count(&self) -> usize {
        let l0_count: usize = self.node_segments.iter().map(|s| s.record_count()).sum();
        let l1_count = self.l1_node_segment.as_ref().map_or(0, |s| s.record_count());
        self.write_buffer.node_count() + l0_count + l1_count
    }

    /// Total edge count (write buffer + all edge segments + L1).
    pub fn edge_count(&self) -> usize {
        let l0_count: usize = self.edge_segments.iter().map(|s| s.record_count()).sum();
        let l1_count = self.l1_edge_segment.as_ref().map_or(0, |s| s.record_count());
        self.write_buffer.edge_count() + l0_count + l1_count
    }

    /// Number of loaded segments: (node_segments, edge_segments).
    /// Includes L1 segments in the count.
    pub fn segment_count(&self) -> (usize, usize) {
        let node_count = self.node_segments.len() + if self.l1_node_segment.is_some() { 1 } else { 0 };
        let edge_count = self.edge_segments.len() + if self.l1_edge_segment.is_some() { 1 } else { 0 };
        (node_count, edge_count)
    }

    /// Write buffer size: (nodes, edges).
    pub fn write_buffer_size(&self) -> (usize, usize) {
        (self.write_buffer.node_count(), self.write_buffer.edge_count())
    }

    /// Return all node IDs (write buffer + segments).
    ///
    /// Used for rebuilding `node_to_shard` map on MultiShardStore::open().
    /// Returns only IDs (16 bytes each), NOT full NodeRecordV2 records
    /// (~200 bytes each).
    pub fn all_node_ids(&self) -> Vec<u128> {
        let mut ids = Vec::new();
        let mut seen = HashSet::new();

        // Write buffer (authoritative, newest)
        for node in self.write_buffer.iter_nodes() {
            seen.insert(node.id);
            if self.tombstones.contains_node(node.id) {
                continue;
            }
            ids.push(node.id);
        }

        // L0 segments
        for seg in &self.node_segments {
            for j in 0..seg.record_count() {
                let id = seg.get_id(j);
                if seen.contains(&id) {
                    continue;
                }
                seen.insert(id);
                if self.tombstones.contains_node(id) {
                    continue;
                }
                ids.push(id);
            }
        }

        // L1 segment (oldest, compacted)
        if let Some(l1_seg) = &self.l1_node_segment {
            for j in 0..l1_seg.record_count() {
                let id = l1_seg.get_id(j);
                if seen.contains(&id) {
                    continue;
                }
                seen.insert(id);
                if self.tombstones.contains_node(id) {
                    continue;
                }
                ids.push(id);
            }
        }

        ids
    }
}

// -- Private Helpers ----------------------------------------------------------

/// Derive file path within shard directory.
///
/// Uses the same naming convention as `SegmentDescriptor::file_path()` but
/// rooted in the shard directory rather than the database root.
fn segment_file_path(shard_path: &Path, seg_id: u64, type_suffix: &str) -> PathBuf {
    shard_path.join(format!("seg_{:06}_{}.seg", seg_id, type_suffix))
}

/// Construct a SegmentDescriptor from flush metadata.
///
/// This is a private helper within shard.rs. Shard builds a local descriptor
/// purely for its own zone map pruning.
fn build_descriptor(
    seg_id: u64,
    seg_type: SegmentType,
    shard_id: Option<u16>,
    meta: &SegmentMeta,
) -> SegmentDescriptor {
    SegmentDescriptor {
        segment_id: seg_id,
        segment_type: seg_type,
        shard_id,
        record_count: meta.record_count,
        byte_size: meta.byte_size,
        node_types: meta.node_types.clone(),
        file_paths: meta.file_paths.clone(),
        edge_types: meta.edge_types.clone(),
    }
}

// -- Tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

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

    fn make_edge(src_id: &str, dst_id: &str, edge_type: &str) -> EdgeRecordV2 {
        let src = u128::from_le_bytes(
            blake3::hash(src_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        let dst = u128::from_le_bytes(
            blake3::hash(dst_id.as_bytes()).as_bytes()[0..16]
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

    // =========================================================================
    // Phase 2: Shard Core + Flush
    // =========================================================================

    #[test]
    fn test_create_empty_shard() {
        let shard = Shard::ephemeral();
        assert_eq!(shard.write_buffer_size(), (0, 0));
        assert_eq!(shard.segment_count(), (0, 0));
        assert_eq!(shard.node_count(), 0);
        assert_eq!(shard.edge_count(), 0);
    }

    #[test]
    fn test_add_nodes_flush_ephemeral() {
        let mut shard = Shard::ephemeral();
        shard.add_nodes(vec![
            make_node("id1", "FUNCTION", "fn1", "file.rs"),
            make_node("id2", "CLASS", "cls1", "file.rs"),
        ]);
        assert_eq!(shard.write_buffer_size(), (2, 0));

        let result = shard.flush_with_ids(Some(1), None).unwrap().unwrap();
        assert!(result.node_meta.is_some());
        assert!(result.edge_meta.is_none());
        assert!(result.node_segment_path.is_none()); // ephemeral
        assert_eq!(shard.segment_count(), (1, 0));
        assert_eq!(shard.write_buffer_size(), (0, 0));
    }

    #[test]
    fn test_add_edges_flush_ephemeral() {
        let mut shard = Shard::ephemeral();
        shard.add_edges(vec![
            make_edge("src1", "dst1", "CALLS"),
            make_edge("src2", "dst2", "IMPORTS_FROM"),
        ]);
        assert_eq!(shard.write_buffer_size(), (0, 2));

        let result = shard.flush_with_ids(None, Some(1)).unwrap().unwrap();
        assert!(result.node_meta.is_none());
        assert!(result.edge_meta.is_some());
        assert_eq!(shard.segment_count(), (0, 1));
    }

    #[test]
    fn test_flush_empty_buffer_noop() {
        let mut shard = Shard::ephemeral();
        let result = shard.flush_with_ids(None, None).unwrap();
        assert!(result.is_none());
        assert_eq!(shard.segment_count(), (0, 0));
    }

    #[test]
    fn test_multiple_flushes() {
        let mut shard = Shard::ephemeral();

        // First flush
        shard.add_nodes(vec![make_node("id1", "FUNCTION", "fn1", "file.rs")]);
        shard.add_edges(vec![make_edge("src1", "dst1", "CALLS")]);
        shard.flush_with_ids(Some(1), Some(2)).unwrap();
        assert_eq!(shard.segment_count(), (1, 1));

        // Second flush
        shard.add_nodes(vec![make_node("id2", "CLASS", "cls1", "file2.rs")]);
        shard.add_edges(vec![make_edge("src2", "dst2", "IMPORTS_FROM")]);
        shard.flush_with_ids(Some(3), Some(4)).unwrap();
        assert_eq!(shard.segment_count(), (2, 2));
    }

    #[test]
    fn test_flush_result_metadata() {
        let mut shard = Shard::ephemeral();
        shard.add_nodes(vec![
            make_node("id1", "FUNCTION", "fn1", "src/main.rs"),
            make_node("id2", "CLASS", "cls1", "src/lib.rs"),
        ]);
        shard.add_edges(vec![make_edge("id1", "id2", "CALLS")]);

        let result = shard.flush_with_ids(Some(1), Some(2)).unwrap().unwrap();

        let node_meta = result.node_meta.unwrap();
        assert_eq!(node_meta.record_count, 2);
        assert!(node_meta.byte_size > 0);
        assert!(node_meta.node_types.contains("FUNCTION"));
        assert!(node_meta.node_types.contains("CLASS"));
        assert!(node_meta.file_paths.contains("src/main.rs"));
        assert!(node_meta.file_paths.contains("src/lib.rs"));

        let edge_meta = result.edge_meta.unwrap();
        assert_eq!(edge_meta.record_count, 1);
        assert!(edge_meta.byte_size > 0);
        assert!(edge_meta.edge_types.contains("CALLS"));
    }

    #[test]
    fn test_flush_disk_shard() {
        let dir = tempfile::TempDir::new().unwrap();
        let shard_path = dir.path().join("shard");
        let mut shard = Shard::create(&shard_path).unwrap();

        shard.add_nodes(vec![make_node("id1", "FUNCTION", "fn1", "file.rs")]);
        shard.add_edges(vec![make_edge("src1", "dst1", "CALLS")]);

        let result = shard.flush_with_ids(Some(1), Some(2)).unwrap().unwrap();

        // Verify segment files exist on disk
        let node_path = result.node_segment_path.unwrap();
        assert!(node_path.exists());
        assert!(node_path.to_string_lossy().contains("seg_000001_nodes.seg"));

        let edge_path = result.edge_segment_path.unwrap();
        assert!(edge_path.exists());
        assert!(edge_path.to_string_lossy().contains("seg_000002_edges.seg"));

        assert_eq!(shard.segment_count(), (1, 1));
    }

    #[test]
    fn test_write_buffer_empty_after_flush() {
        let mut shard = Shard::ephemeral();
        shard.add_nodes(vec![
            make_node("id1", "FUNCTION", "fn1", "file.rs"),
            make_node("id2", "CLASS", "cls1", "file.rs"),
        ]);
        shard.add_edges(vec![make_edge("src1", "dst1", "CALLS")]);

        assert_eq!(shard.write_buffer_size(), (2, 1));
        shard.flush_with_ids(Some(1), Some(2)).unwrap();
        assert_eq!(shard.write_buffer_size(), (0, 0));
    }

    // =========================================================================
    // Phase 3: Point Lookup
    // =========================================================================

    #[test]
    fn test_get_node_from_buffer() {
        let mut shard = Shard::ephemeral();
        let node = make_node("src/main.rs::main", "FUNCTION", "main", "src/main.rs");
        let id = node.id;

        shard.add_nodes(vec![node.clone()]);
        let got = shard.get_node(id).unwrap();
        assert_eq!(got, node);
        assert!(shard.node_exists(id));
    }

    #[test]
    fn test_get_node_from_segment() {
        let mut shard = Shard::ephemeral();
        let node = make_node("src/main.rs::main", "FUNCTION", "main", "src/main.rs");
        let id = node.id;

        shard.add_nodes(vec![node.clone()]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Buffer is now empty, but segment has the node
        assert_eq!(shard.write_buffer_size(), (0, 0));
        let got = shard.get_node(id).unwrap();
        assert_eq!(got, node);
        assert!(shard.node_exists(id));
    }

    #[test]
    fn test_get_node_not_found() {
        let shard = Shard::ephemeral();
        assert!(shard.get_node(12345).is_none());
        assert!(!shard.node_exists(12345));
    }

    #[test]
    fn test_get_node_buffer_wins_over_segment() {
        let mut shard = Shard::ephemeral();
        let node_v1 = make_node("src/main.rs::main", "FUNCTION", "main", "src/main.rs");
        let id = node_v1.id;

        // Add v1 and flush to segment
        shard.add_nodes(vec![node_v1]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Add v2 to buffer (upsert)
        let mut node_v2 = make_node("src/main.rs::main", "METHOD", "main", "src/main.rs");
        node_v2.content_hash = 99;
        shard.add_nodes(vec![node_v2.clone()]);

        // Buffer should win
        let got = shard.get_node(id).unwrap();
        assert_eq!(got.node_type, "METHOD");
        assert_eq!(got.content_hash, 99);
    }

    // =========================================================================
    // Phase 4: Attribute Search
    // =========================================================================

    #[test]
    fn test_find_nodes_by_type_in_buffer() {
        let mut shard = Shard::ephemeral();
        shard.add_nodes(vec![
            make_node("id1", "FUNCTION", "fn1", "file.rs"),
            make_node("id2", "CLASS", "cls1", "file.rs"),
            make_node("id3", "FUNCTION", "fn2", "file.rs"),
        ]);

        let fns = shard.find_nodes(Some("FUNCTION"), None);
        assert_eq!(fns.len(), 2);
        assert!(fns.iter().all(|n| n.node_type == "FUNCTION"));
    }

    #[test]
    fn test_find_nodes_by_type_in_segment() {
        let mut shard = Shard::ephemeral();
        shard.add_nodes(vec![
            make_node("id1", "FUNCTION", "fn1", "file.rs"),
            make_node("id2", "CLASS", "cls1", "file.rs"),
            make_node("id3", "FUNCTION", "fn2", "file.rs"),
        ]);
        shard.flush_with_ids(Some(1), None).unwrap();

        let fns = shard.find_nodes(Some("FUNCTION"), None);
        assert_eq!(fns.len(), 2);
        assert!(fns.iter().all(|n| n.node_type == "FUNCTION"));

        let classes = shard.find_nodes(Some("CLASS"), None);
        assert_eq!(classes.len(), 1);
    }

    #[test]
    fn test_find_nodes_zone_map_prunes() {
        let mut shard = Shard::ephemeral();

        // Flush 1: only src/main.rs
        shard.add_nodes(vec![
            make_node("id1", "FUNCTION", "fn1", "src/main.rs"),
            make_node("id2", "FUNCTION", "fn2", "src/main.rs"),
        ]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Flush 2: only src/lib.rs
        shard.add_nodes(vec![
            make_node("id3", "CLASS", "cls1", "src/lib.rs"),
        ]);
        shard.flush_with_ids(Some(2), None).unwrap();

        // Query by file: should only find nodes from the relevant segments
        let main_nodes = shard.find_nodes(None, Some("src/main.rs"));
        assert_eq!(main_nodes.len(), 2);
        assert!(main_nodes.iter().all(|n| n.file == "src/main.rs"));

        let lib_nodes = shard.find_nodes(None, Some("src/lib.rs"));
        assert_eq!(lib_nodes.len(), 1);
        assert_eq!(lib_nodes[0].file, "src/lib.rs");

        // Query for non-existent file
        let other = shard.find_nodes(None, Some("src/other.rs"));
        assert!(other.is_empty());
    }

    #[test]
    fn test_find_nodes_dedup_buffer_wins() {
        let mut shard = Shard::ephemeral();

        // Add v1 to segment
        shard.add_nodes(vec![
            make_node("id1", "FUNCTION", "fn1", "file.rs"),
        ]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Add v2 to buffer with different type
        shard.add_nodes(vec![
            make_node("id1", "METHOD", "fn1", "file.rs"),
        ]);

        // find_nodes should return only one copy (buffer wins)
        let all = shard.find_nodes(None, None);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].node_type, "METHOD");

        // Searching by old type should return nothing (buffer version has METHOD)
        let fns = shard.find_nodes(Some("FUNCTION"), None);
        assert!(fns.is_empty());

        // Searching by new type should return the buffer version
        let methods = shard.find_nodes(Some("METHOD"), None);
        assert_eq!(methods.len(), 1);
    }

    // =========================================================================
    // Phase 5: Neighbor Queries
    // =========================================================================

    #[test]
    fn test_outgoing_edges_from_buffer() {
        let mut shard = Shard::ephemeral();
        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src1", "dst2", "IMPORTS_FROM");
        let e3 = make_edge("src2", "dst1", "CALLS");

        shard.add_edges(vec![e1.clone(), e2.clone(), e3.clone()]);

        let src1_id = node_id("src1");
        let outgoing = shard.get_outgoing_edges(src1_id, None);
        assert_eq!(outgoing.len(), 2);

        // With type filter
        let calls_only = shard.get_outgoing_edges(src1_id, Some(&["CALLS"]));
        assert_eq!(calls_only.len(), 1);
        assert_eq!(calls_only[0].edge_type, "CALLS");
    }

    #[test]
    fn test_outgoing_edges_from_segment() {
        let mut shard = Shard::ephemeral();
        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src1", "dst2", "IMPORTS_FROM");

        shard.add_edges(vec![e1.clone(), e2.clone()]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        let src1_id = node_id("src1");
        let outgoing = shard.get_outgoing_edges(src1_id, None);
        assert_eq!(outgoing.len(), 2);
    }

    #[test]
    fn test_incoming_edges_with_type_filter() {
        let mut shard = Shard::ephemeral();
        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src2", "dst1", "IMPORTS_FROM");
        let e3 = make_edge("src3", "dst1", "CALLS");
        let e4 = make_edge("src4", "dst2", "CALLS");

        shard.add_edges(vec![e1, e2, e3, e4]);

        let dst1_id = node_id("dst1");
        let incoming_all = shard.get_incoming_edges(dst1_id, None);
        assert_eq!(incoming_all.len(), 3);

        let incoming_calls = shard.get_incoming_edges(dst1_id, Some(&["CALLS"]));
        assert_eq!(incoming_calls.len(), 2);
        assert!(incoming_calls.iter().all(|e| e.edge_type == "CALLS"));

        let incoming_imports = shard.get_incoming_edges(dst1_id, Some(&["IMPORTS_FROM"]));
        assert_eq!(incoming_imports.len(), 1);
    }

    #[test]
    fn test_edges_across_buffer_and_segments() {
        let mut shard = Shard::ephemeral();

        // Flush edges to segment 1
        shard.add_edges(vec![make_edge("src1", "dst1", "CALLS")]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        // Flush more edges to segment 2
        shard.add_edges(vec![make_edge("src1", "dst2", "IMPORTS_FROM")]);
        shard.flush_with_ids(None, Some(2)).unwrap();

        // Add more edges to buffer
        shard.add_edges(vec![make_edge("src1", "dst3", "CONTAINS")]);

        let src1_id = node_id("src1");
        let outgoing = shard.get_outgoing_edges(src1_id, None);
        assert_eq!(outgoing.len(), 3);

        // Verify all three edge types present
        let types: HashSet<&str> = outgoing.iter().map(|e| e.edge_type.as_str()).collect();
        assert!(types.contains("CALLS"));
        assert!(types.contains("IMPORTS_FROM"));
        assert!(types.contains("CONTAINS"));
    }

    // =========================================================================
    // Phase 6: Integration + Equivalence
    // =========================================================================

    #[test]
    fn test_equivalence_point_lookup() {
        // Build reference HashMap and Shard with same 100 nodes
        let mut reference: HashMap<u128, NodeRecordV2> = HashMap::new();
        let mut shard = Shard::ephemeral();

        let mut nodes = Vec::new();
        for i in 0..100 {
            let node = make_node(
                &format!("node_{}", i),
                if i % 3 == 0 { "FUNCTION" } else { "CLASS" },
                &format!("name_{}", i),
                &format!("file_{}.rs", i % 5),
            );
            reference.insert(node.id, node.clone());
            nodes.push(node);
        }
        shard.add_nodes(nodes);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Every node should return identical results
        for (id, expected) in &reference {
            let got = shard.get_node(*id).unwrap();
            assert_eq!(&got, expected, "mismatch for id {}", id);
            assert!(shard.node_exists(*id));
        }

        // Non-existent IDs should return None
        assert!(shard.get_node(0).is_none());
        assert!(shard.get_node(u128::MAX).is_none());
    }

    #[test]
    fn test_equivalence_attribute_search() {
        let mut reference_functions: Vec<NodeRecordV2> = Vec::new();
        let mut all_nodes: Vec<NodeRecordV2> = Vec::new();

        for i in 0..50 {
            let node_type = if i % 2 == 0 { "FUNCTION" } else { "CLASS" };
            let node = make_node(
                &format!("node_{}", i),
                node_type,
                &format!("name_{}", i),
                "file.rs",
            );
            if node_type == "FUNCTION" {
                reference_functions.push(node.clone());
            }
            all_nodes.push(node);
        }

        let mut shard = Shard::ephemeral();
        shard.add_nodes(all_nodes);
        shard.flush_with_ids(Some(1), None).unwrap();

        let shard_functions = shard.find_nodes(Some("FUNCTION"), None);
        assert_eq!(shard_functions.len(), reference_functions.len());

        let shard_ids: HashSet<u128> = shard_functions.iter().map(|n| n.id).collect();
        let ref_ids: HashSet<u128> = reference_functions.iter().map(|n| n.id).collect();
        assert_eq!(shard_ids, ref_ids);
    }

    #[test]
    fn test_full_lifecycle() {
        let mut shard = Shard::ephemeral();

        // Step 1: Add nodes
        let n1 = make_node("app::main", "FUNCTION", "main", "src/main.rs");
        let n2 = make_node("app::helper", "FUNCTION", "helper", "src/lib.rs");
        let n3 = make_node("app::Config", "CLASS", "Config", "src/config.rs");
        shard.add_nodes(vec![n1.clone(), n2.clone(), n3.clone()]);

        // Step 2: Query from buffer
        assert_eq!(shard.get_node(n1.id).unwrap(), n1);
        assert_eq!(shard.find_nodes(Some("FUNCTION"), None).len(), 2);

        // Step 3: Add edges
        let e1 = make_edge("app::main", "app::helper", "CALLS");
        let e2 = make_edge("app::main", "app::Config", "USES");
        shard.add_edges(vec![e1.clone(), e2.clone()]);

        // Step 4: Flush
        shard.flush_with_ids(Some(1), Some(2)).unwrap();
        assert_eq!(shard.write_buffer_size(), (0, 0));
        assert_eq!(shard.segment_count(), (1, 1));

        // Step 5: Query from segments
        assert_eq!(shard.get_node(n2.id).unwrap(), n2);
        let outgoing = shard.get_outgoing_edges(n1.id, None);
        assert_eq!(outgoing.len(), 2);

        // Step 6: Add more data and flush again
        let n4 = make_node("app::Logger", "CLASS", "Logger", "src/logger.rs");
        shard.add_nodes(vec![n4.clone()]);
        shard.add_edges(vec![make_edge("app::main", "app::Logger", "USES")]);
        shard.flush_with_ids(Some(3), Some(4)).unwrap();
        assert_eq!(shard.segment_count(), (2, 2));

        // Step 7: Query across all segments
        assert_eq!(shard.get_node(n4.id).unwrap(), n4);
        let all_nodes = shard.find_nodes(None, None);
        assert_eq!(all_nodes.len(), 4);

        let outgoing_all = shard.get_outgoing_edges(n1.id, None);
        assert_eq!(outgoing_all.len(), 3);
    }

    #[test]
    fn test_multiple_segments_queryable() {
        let mut shard = Shard::ephemeral();

        // Flush 3 batches
        for batch in 0..3 {
            let mut nodes = Vec::new();
            for i in 0..10 {
                nodes.push(make_node(
                    &format!("batch{}_{}", batch, i),
                    "FUNCTION",
                    &format!("fn_{}_{}", batch, i),
                    &format!("file_{}.rs", batch),
                ));
            }
            shard.add_nodes(nodes);
            shard.flush_with_ids(Some(batch as u64 + 1), None).unwrap();
        }

        assert_eq!(shard.segment_count(), (3, 0));

        // All nodes from all segments should be queryable
        let all = shard.find_nodes(None, None);
        assert_eq!(all.len(), 30);

        // Point lookup from each batch
        for batch in 0..3 {
            let id = node_id(&format!("batch{}_{}", batch, 5));
            assert!(shard.node_exists(id), "node from batch {} not found", batch);
        }
    }

    #[test]
    fn test_unflushed_and_flushed_both_visible() {
        let mut shard = Shard::ephemeral();

        // Flush some data
        shard.add_nodes(vec![
            make_node("flushed1", "FUNCTION", "fn1", "file.rs"),
            make_node("flushed2", "CLASS", "cls1", "file.rs"),
        ]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Add more data to buffer (unflushed)
        shard.add_nodes(vec![
            make_node("buffered1", "FUNCTION", "fn2", "file.rs"),
        ]);

        // Both flushed and unflushed should be visible
        let all = shard.find_nodes(None, None);
        assert_eq!(all.len(), 3);

        assert!(shard.node_exists(node_id("flushed1")));
        assert!(shard.node_exists(node_id("flushed2")));
        assert!(shard.node_exists(node_id("buffered1")));
    }

    #[test]
    fn test_open_existing_shard() {
        let dir = tempfile::TempDir::new().unwrap();
        let shard_path = dir.path().join("shard");
        let db_path = dir.path();

        // Phase 1: Create shard, add data, flush
        let node = make_node("persistent", "FUNCTION", "fn1", "file.rs");
        let node_id_val = node.id;
        let flush_result;
        {
            let mut shard = Shard::create(&shard_path).unwrap();
            shard.add_nodes(vec![node.clone()]);
            shard.add_edges(vec![make_edge("persistent", "other", "CALLS")]);
            flush_result = shard.flush_with_ids(Some(1), Some(2)).unwrap().unwrap();
        }

        // Phase 2: Build descriptors (simulating what ManifestStore would do)
        let node_meta = flush_result.node_meta.unwrap();
        let edge_meta = flush_result.edge_meta.unwrap();

        // For disk shards, segment files are inside shard_path
        // We need to create descriptors that resolve to those file paths
        // SegmentDescriptor::file_path(db_path) produces db_path/segments/seg_XXX.seg
        // But our shard wrote to shard_path/seg_XXX.seg
        // For this test, we symlink or just copy the approach

        // The proper way: use segment_file_path to derive names, then create
        // descriptors that will point to the right location when opened.
        // Since Shard::open uses desc.file_path(db_path), we need the segments
        // to be at db_path/segments/seg_000001_nodes.seg

        // Create the segments directory at db_path level
        let segments_dir = db_path.join("segments");
        std::fs::create_dir_all(&segments_dir).unwrap();

        // Copy segment files from shard dir to segments dir
        let node_src = flush_result.node_segment_path.unwrap();
        let edge_src = flush_result.edge_segment_path.unwrap();
        let node_dst_path = segments_dir.join("seg_000001_nodes.seg");
        let edge_dst_path = segments_dir.join("seg_000002_edges.seg");
        std::fs::copy(&node_src, &node_dst_path).unwrap();
        std::fs::copy(&edge_src, &edge_dst_path).unwrap();

        let node_desc = SegmentDescriptor {
            segment_id: 1,
            segment_type: SegmentType::Nodes,
            shard_id: None,
            record_count: node_meta.record_count,
            byte_size: node_meta.byte_size,
            node_types: node_meta.node_types,
            file_paths: node_meta.file_paths,
            edge_types: node_meta.edge_types,
        };
        let edge_desc = SegmentDescriptor {
            segment_id: 2,
            segment_type: SegmentType::Edges,
            shard_id: None,
            record_count: edge_meta.record_count,
            byte_size: edge_meta.byte_size,
            node_types: edge_meta.node_types,
            file_paths: edge_meta.file_paths,
            edge_types: edge_meta.edge_types,
        };

        // Phase 3: Open shard with descriptors
        let shard = Shard::open(
            &shard_path,
            db_path,
            vec![node_desc],
            vec![edge_desc],
        )
        .unwrap();

        assert_eq!(shard.segment_count(), (1, 1));
        assert_eq!(shard.write_buffer_size(), (0, 0));

        // Query should succeed
        let got = shard.get_node(node_id_val).unwrap();
        assert_eq!(got, node);

        let persistent_id = u128::from_le_bytes(
            blake3::hash(b"persistent").as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        let outgoing = shard.get_outgoing_edges(persistent_id, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].edge_type, "CALLS");
    }

    // =========================================================================
    // Tombstone Tests (RFD-8 T3.1 Commit 1)
    // =========================================================================

    #[test]
    fn test_tombstone_set_empty() {
        let ts = TombstoneSet::new();
        assert!(ts.is_empty());
        assert_eq!(ts.node_count(), 0);
        assert_eq!(ts.edge_count(), 0);
        assert!(!ts.contains_node(42));
        assert!(!ts.contains_edge(1, 2, "CALLS"));
    }

    #[test]
    fn test_tombstone_set_from_manifest() {
        let ts = TombstoneSet::from_manifest(
            vec![1, 2, 3],
            vec![(10, 20, "CALLS".to_string())],
        );
        assert!(!ts.is_empty());
        assert_eq!(ts.node_count(), 3);
        assert_eq!(ts.edge_count(), 1);
        assert!(ts.contains_node(1));
        assert!(ts.contains_node(2));
        assert!(ts.contains_node(3));
        assert!(!ts.contains_node(99));
        assert!(ts.contains_edge(10, 20, "CALLS"));
        assert!(!ts.contains_edge(10, 20, "OTHER"));
        assert!(!ts.contains_edge(10, 99, "CALLS"));
    }

    #[test]
    fn test_tombstone_blocks_get_node() {
        let mut shard = Shard::ephemeral();
        let node = make_node("tombstone::target", "FUNCTION", "target", "file.rs");
        let id = node.id;

        shard.add_nodes(vec![node]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Before tombstone: visible
        assert!(shard.get_node(id).is_some());

        // After tombstone: invisible
        let mut ts = TombstoneSet::new();
        ts.add_nodes(vec![id]);
        shard.set_tombstones(ts);

        assert!(shard.get_node(id).is_none());
    }

    #[test]
    fn test_tombstone_blocks_node_exists() {
        let mut shard = Shard::ephemeral();
        let node = make_node("tombstone::exists", "FUNCTION", "exists", "file.rs");
        let id = node.id;

        shard.add_nodes(vec![node]);
        shard.flush_with_ids(Some(1), None).unwrap();

        assert!(shard.node_exists(id));

        let mut ts = TombstoneSet::new();
        ts.add_nodes(vec![id]);
        shard.set_tombstones(ts);

        assert!(!shard.node_exists(id));
    }

    #[test]
    fn test_tombstone_blocks_find_nodes() {
        let mut shard = Shard::ephemeral();
        let n1 = make_node("tomb::a", "FUNCTION", "a", "file.rs");
        let n2 = make_node("tomb::b", "FUNCTION", "b", "file.rs");
        let n3 = make_node("tomb::c", "FUNCTION", "c", "file.rs");
        let id_b = n2.id;

        shard.add_nodes(vec![n1, n2, n3]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Before tombstone: 3 nodes
        assert_eq!(shard.find_nodes(None, None).len(), 3);

        // Tombstone node B
        let mut ts = TombstoneSet::new();
        ts.add_nodes(vec![id_b]);
        shard.set_tombstones(ts);

        let result = shard.find_nodes(None, None);
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|n| n.id != id_b));
    }

    #[test]
    fn test_tombstone_blocks_outgoing_edges() {
        let mut shard = Shard::ephemeral();
        let e1 = make_edge("tomb::src", "tomb::dst1", "CALLS");
        let e2 = make_edge("tomb::src", "tomb::dst2", "CALLS");
        let src_id = node_id("tomb::src");
        let dst1_id = node_id("tomb::dst1");

        shard.add_edges(vec![e1, e2]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        // Before tombstone: 2 outgoing edges
        assert_eq!(shard.get_outgoing_edges(src_id, None).len(), 2);

        // Tombstone edge src->dst1
        let mut ts = TombstoneSet::new();
        ts.add_edges(vec![(src_id, dst1_id, "CALLS".to_string())]);
        shard.set_tombstones(ts);

        let result = shard.get_outgoing_edges(src_id, None);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].dst, node_id("tomb::dst2"));
    }

    #[test]
    fn test_tombstone_blocks_incoming_edges() {
        let mut shard = Shard::ephemeral();
        let e1 = make_edge("tomb::src1", "tomb::target", "CALLS");
        let e2 = make_edge("tomb::src2", "tomb::target", "CALLS");
        let src1_id = node_id("tomb::src1");
        let target_id = node_id("tomb::target");

        shard.add_edges(vec![e1, e2]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        // Before tombstone: 2 incoming edges
        assert_eq!(shard.get_incoming_edges(target_id, None).len(), 2);

        // Tombstone edge src1->target
        let mut ts = TombstoneSet::new();
        ts.add_edges(vec![(src1_id, target_id, "CALLS".to_string())]);
        shard.set_tombstones(ts);

        let result = shard.get_incoming_edges(target_id, None);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].src, node_id("tomb::src2"));
    }

    #[test]
    fn test_tombstone_excludes_from_all_node_ids() {
        let mut shard = Shard::ephemeral();
        let mut nodes = Vec::new();
        let mut ids = Vec::new();
        for i in 0..5 {
            let n = make_node(&format!("tomb::id_{}", i), "FUNCTION", "fn", "file.rs");
            ids.push(n.id);
            nodes.push(n);
        }

        shard.add_nodes(nodes);
        shard.flush_with_ids(Some(1), None).unwrap();

        assert_eq!(shard.all_node_ids().len(), 5);

        // Tombstone 2 of the 5
        let mut ts = TombstoneSet::new();
        ts.add_nodes(vec![ids[1], ids[3]]);
        shard.set_tombstones(ts);

        let result = shard.all_node_ids();
        assert_eq!(result.len(), 3);
        assert!(!result.contains(&ids[1]));
        assert!(!result.contains(&ids[3]));
        assert!(result.contains(&ids[0]));
        assert!(result.contains(&ids[2]));
        assert!(result.contains(&ids[4]));
    }

    #[test]
    fn test_tombstone_empty_set_no_effect() {
        let mut shard = Shard::ephemeral();
        let n1 = make_node("tomb::noop1", "FUNCTION", "fn1", "file.rs");
        let n2 = make_node("tomb::noop2", "CLASS", "cls1", "file.rs");
        let e1 = make_edge("tomb::noop1", "tomb::noop2", "CALLS");

        shard.add_nodes(vec![n1.clone(), n2.clone()]);
        shard.add_edges(vec![e1]);
        shard.flush_with_ids(Some(1), Some(2)).unwrap();

        // Set empty tombstones (should have no effect)
        shard.set_tombstones(TombstoneSet::new());

        assert!(shard.get_node(n1.id).is_some());
        assert!(shard.get_node(n2.id).is_some());
        assert!(shard.node_exists(n1.id));
        assert!(shard.node_exists(n2.id));
        assert_eq!(shard.find_nodes(None, None).len(), 2);
        assert_eq!(shard.get_outgoing_edges(n1.id, None).len(), 1);
        assert_eq!(shard.get_incoming_edges(n2.id, None).len(), 1);
        assert_eq!(shard.all_node_ids().len(), 2);
    }

    #[test]
    fn test_tombstone_set_add_union() {
        let mut ts = TombstoneSet::new();
        ts.add_nodes(vec![1, 2]);
        ts.add_edges(vec![(10, 20, "CALLS".to_string())]);

        assert_eq!(ts.node_count(), 2);
        assert_eq!(ts.edge_count(), 1);

        // Union with overlapping and new
        ts.add_nodes(vec![2, 3]);
        ts.add_edges(vec![
            (10, 20, "CALLS".to_string()),     // duplicate
            (30, 40, "IMPORTS".to_string()),    // new
        ]);

        assert_eq!(ts.node_count(), 3); // {1, 2, 3}
        assert_eq!(ts.edge_count(), 2); // {(10,20,CALLS), (30,40,IMPORTS)}
        assert!(ts.contains_node(1));
        assert!(ts.contains_node(2));
        assert!(ts.contains_node(3));
        assert!(ts.contains_edge(10, 20, "CALLS"));
        assert!(ts.contains_edge(30, 40, "IMPORTS"));
    }

    // =========================================================================
    // find_edge_keys_by_src_ids Tests (RFD-8 T3.1 Commit 2)
    // =========================================================================

    #[test]
    fn test_find_edge_keys_by_src_ids_from_buffer() {
        let mut shard = Shard::ephemeral();

        // Add edges with two different sources to the buffer (unflushed)
        let e1 = make_edge("src_a", "dst1", "CALLS");
        let e2 = make_edge("src_a", "dst2", "IMPORTS_FROM");
        let e3 = make_edge("src_b", "dst3", "CALLS");

        shard.add_edges(vec![e1.clone(), e2.clone(), e3.clone()]);

        // Query for src_a only
        let src_a_id = node_id("src_a");
        let src_ids: HashSet<u128> = [src_a_id].into_iter().collect();
        let keys = shard.find_edge_keys_by_src_ids(&src_ids);

        assert_eq!(keys.len(), 2);
        // Both edges from src_a should be found
        assert!(keys.contains(&(e1.src, e1.dst, e1.edge_type.clone())));
        assert!(keys.contains(&(e2.src, e2.dst, e2.edge_type.clone())));
        // Edge from src_b should NOT be included
        assert!(!keys.contains(&(e3.src, e3.dst, e3.edge_type.clone())));
    }

    #[test]
    fn test_find_edge_keys_by_src_ids_from_segment() {
        let mut shard = Shard::ephemeral();

        let e1 = make_edge("seg_src", "seg_dst1", "CALLS");
        let e2 = make_edge("seg_src", "seg_dst2", "IMPORTS_FROM");
        shard.add_edges(vec![e1.clone(), e2.clone()]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        // Write buffer should now be empty
        assert_eq!(shard.write_buffer_size(), (0, 0));

        let src_id = node_id("seg_src");
        let src_ids: HashSet<u128> = [src_id].into_iter().collect();
        let keys = shard.find_edge_keys_by_src_ids(&src_ids);

        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&(e1.src, e1.dst, e1.edge_type.clone())));
        assert!(keys.contains(&(e2.src, e2.dst, e2.edge_type.clone())));
    }

    #[test]
    fn test_find_edge_keys_by_src_ids_bloom_skips_irrelevant() {
        let mut shard = Shard::ephemeral();

        // Segment 1: edges from src_x
        let e1 = make_edge("bloom_src_x", "bloom_dst1", "CALLS");
        shard.add_edges(vec![e1.clone()]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        // Segment 2: edges from src_y
        let e2 = make_edge("bloom_src_y", "bloom_dst2", "CALLS");
        shard.add_edges(vec![e2.clone()]);
        shard.flush_with_ids(None, Some(2)).unwrap();

        // Query for src_x only — should find only e1
        let src_x_id = node_id("bloom_src_x");
        let src_ids: HashSet<u128> = [src_x_id].into_iter().collect();
        let keys = shard.find_edge_keys_by_src_ids(&src_ids);

        assert_eq!(keys.len(), 1);
        assert!(keys.contains(&(e1.src, e1.dst, e1.edge_type.clone())));
        assert!(!keys.contains(&(e2.src, e2.dst, e2.edge_type.clone())));
    }

    #[test]
    fn test_find_edge_keys_by_src_ids_empty_input() {
        let mut shard = Shard::ephemeral();

        // Add some edges
        shard.add_edges(vec![
            make_edge("empty_src1", "empty_dst1", "CALLS"),
            make_edge("empty_src2", "empty_dst2", "CALLS"),
        ]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        // Empty src_ids should return empty result
        let src_ids: HashSet<u128> = HashSet::new();
        let keys = shard.find_edge_keys_by_src_ids(&src_ids);
        assert!(keys.is_empty());
    }

    #[test]
    fn test_find_edge_keys_by_src_ids_across_segments() {
        let mut shard = Shard::ephemeral();

        // Segment 1: edges from src_a and src_b
        let e1 = make_edge("multi_src_a", "multi_dst1", "CALLS");
        let e2 = make_edge("multi_src_b", "multi_dst2", "IMPORTS_FROM");
        shard.add_edges(vec![e1.clone(), e2.clone()]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        // Segment 2: more edges from src_a
        let e3 = make_edge("multi_src_a", "multi_dst3", "CONTAINS");
        shard.add_edges(vec![e3.clone()]);
        shard.flush_with_ids(None, Some(2)).unwrap();

        // Segment 3: edges from src_c
        let e4 = make_edge("multi_src_c", "multi_dst4", "CALLS");
        shard.add_edges(vec![e4.clone()]);
        shard.flush_with_ids(None, Some(3)).unwrap();

        // Also add an edge to the buffer (unflushed)
        let e5 = make_edge("multi_src_b", "multi_dst5", "CALLS");
        shard.add_edges(vec![e5.clone()]);

        // Query for src_a and src_b — should find e1, e2, e3, e5
        let src_a_id = node_id("multi_src_a");
        let src_b_id = node_id("multi_src_b");
        let src_ids: HashSet<u128> = [src_a_id, src_b_id].into_iter().collect();
        let keys = shard.find_edge_keys_by_src_ids(&src_ids);

        assert_eq!(keys.len(), 4);
        assert!(keys.contains(&(e1.src, e1.dst, e1.edge_type.clone())));
        assert!(keys.contains(&(e2.src, e2.dst, e2.edge_type.clone())));
        assert!(keys.contains(&(e3.src, e3.dst, e3.edge_type.clone())));
        assert!(keys.contains(&(e5.src, e5.dst, e5.edge_type.clone())));
        // e4 (src_c) should NOT be included
        assert!(!keys.contains(&(e4.src, e4.dst, e4.edge_type.clone())));
    }
}
