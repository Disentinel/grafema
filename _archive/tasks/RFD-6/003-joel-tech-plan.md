# RFD-6: T2.2 Single-Shard Read/Write -- Joel's Tech Spec

> Date: 2026-02-13
> Author: Joel Spolsky (Implementation Planner)
> Based on: Don's Plan (002-don-plan.md)
> Status: Ready for Steve Jobs review

---

## 0. Scope

Build two new files (`write_buffer.rs`, `shard.rs`) that together implement the
primary read/write unit for RFDB v2. A Shard is a directory of immutable columnar
segments + an in-memory write buffer. It supports three query patterns (point
lookup, attribute search, neighbor queries) and a flush-to-disk write path.

**Total budget:** ~1855 LOC across 6 phases, ~34 tests.

**What this spec does NOT cover:**
- No compaction, no tombstones, no multi-shard, no WAL, no concurrent access
- No adjacency index, no inverted index
- No changes to existing files (except `mod.rs` -- 2 lines)

---

## 1. Exact Data Structures

### 1.1. WriteBuffer (`write_buffer.rs`)

```rust
use std::collections::{HashMap, HashSet};
use crate::storage_v2::types::{NodeRecordV2, EdgeRecordV2};

/// In-memory accumulation buffer for records before flush.
///
/// Analogous to LSM-tree memtable. NOT sorted (L0 segments are unsorted).
/// NOT Send+Sync -- single-writer access assumed.
///
/// Nodes are keyed by id (u128) for O(1) point lookup + upsert semantics.
/// Edges are stored in a Vec (append-only) with a HashSet for deduplication.
pub struct WriteBuffer {
    /// Nodes keyed by u128 id. Upsert: adding a node with an existing id
    /// replaces the previous record (same as v1 delta_nodes pattern).
    nodes: HashMap<u128, NodeRecordV2>,

    /// Append-only edge storage. Linear scan for queries is acceptable
    /// because the buffer is small (flushed regularly).
    edges: Vec<EdgeRecordV2>,

    /// Edge dedup key: (src, dst, edge_type). Matches v1 engine's
    /// `edge_keys: HashSet<(u128, u128, String)>` pattern.
    /// The value is the index into `edges` Vec so we can update in place.
    edge_keys: HashSet<(u128, u128, String)>,
}
```

**Design rationale:**

- `HashMap<u128, NodeRecordV2>` -- Same pattern as v1 `delta_nodes`. O(1) point
  lookup, O(1) upsert (insert-or-replace). Key is `NodeRecordV2.id` (BLAKE3 of
  semantic_id).

- `Vec<EdgeRecordV2>` -- Append-only like v1 `delta_edges`. Neighbor queries
  need full scan of buffer edges regardless of data structure, so a Vec is the
  simplest and most cache-friendly option.

- `HashSet<(u128, u128, String)>` -- Edge dedup. Prevents duplicate edges
  `(src, dst, edge_type)` in the buffer. When `add_edge` encounters a duplicate
  key, it silently skips the edge (idempotent). This mirrors the v1 `edge_keys`
  pattern from `engine.rs`.

### 1.2. FlushResult

```rust
use std::path::PathBuf;
use crate::storage_v2::types::SegmentMeta;

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
```

### 1.3. Shard (`shard.rs`)

```rust
use std::path::PathBuf;
use crate::storage_v2::segment::{NodeSegmentV2, EdgeSegmentV2};
use crate::storage_v2::manifest::SegmentDescriptor;

/// A shard is the primary read/write unit for RFDB v2.
///
/// Write path: records -> write buffer -> flush -> segment files
/// Read path: query -> write buffer scan + segment scan -> merge
///
/// A Shard does NOT own ManifestStore. ManifestStore is a database-level
/// concern (T3.x). Shard receives segment descriptors and returns flush
/// results; the caller updates the manifest.
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
}
```

**Invariants:**

1. `node_segments.len() == node_descriptors.len()` (always)
2. `edge_segments.len() == edge_descriptors.len()` (always)
3. Segment vectors are ordered oldest-first. Read queries iterate `.rev()`
   (newest first) so the first match for a given node ID is authoritative.
4. Write buffer always wins over all segments (contains most recent data).

### 1.4. Interaction with Existing Types

The new code interacts with these existing types:

| Existing Type | Used By | How |
|---|---|---|
| `NodeRecordV2` (types.rs) | WriteBuffer, Shard | Stored in buffer HashMap, returned from queries |
| `EdgeRecordV2` (types.rs) | WriteBuffer, Shard | Stored in buffer Vec, returned from queries |
| `SegmentMeta` (types.rs) | FlushResult | Returned by segment writers, passed back to caller |
| `NodeSegmentWriter` (writer.rs) | Shard::flush | Writes nodes from buffer to segment file |
| `EdgeSegmentWriter` (writer.rs) | Shard::flush | Writes edges from buffer to segment file |
| `NodeSegmentV2` (segment.rs) | Shard | Loaded after flush, queried on reads |
| `EdgeSegmentV2` (segment.rs) | Shard | Loaded after flush, queried on reads |
| `SegmentDescriptor` (manifest.rs) | Shard | Passed to `open()`, stored for zone map pruning |
| `ManifestStore` (manifest.rs) | **Caller** (not Shard) | Caller allocates segment IDs, commits manifests |

---

## 2. Complete API Signatures

### 2.1. WriteBuffer API

```rust
impl WriteBuffer {
    // ── Constructors ─────────────────────────────────────────

    /// Create empty write buffer.
    pub fn new() -> Self;

    // ── Write Operations ─────────────────────────────────────

    /// Add a single node. Upsert: if id already exists, replaces.
    pub fn add_node(&mut self, record: NodeRecordV2);

    /// Add multiple nodes. Each is upserted individually.
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>);

    /// Add a single edge. Dedup: if (src, dst, edge_type) exists, skip.
    /// Returns true if edge was added, false if duplicate.
    pub fn add_edge(&mut self, record: EdgeRecordV2) -> bool;

    /// Add multiple edges. Each is deduped individually.
    /// Returns number of edges actually added (excluding duplicates).
    pub fn add_edges(&mut self, records: Vec<EdgeRecordV2>) -> usize;

    // ── Read Operations (for merge with segments) ────────────

    /// Point lookup by node id. O(1).
    pub fn get_node(&self, id: u128) -> Option<&NodeRecordV2>;

    /// Iterator over all buffered nodes.
    pub fn iter_nodes(&self) -> impl Iterator<Item = &NodeRecordV2>;

    /// Iterator over all buffered edges.
    pub fn iter_edges(&self) -> impl Iterator<Item = &EdgeRecordV2>;

    // ── Query Support ────────────────────────────────────────

    /// Find all nodes with matching node_type. O(N_buf).
    pub fn find_nodes_by_type(&self, node_type: &str) -> Vec<&NodeRecordV2>;

    /// Find all nodes with matching file. O(N_buf).
    pub fn find_nodes_by_file(&self, file: &str) -> Vec<&NodeRecordV2>;

    /// Find all edges with matching src. O(E_buf).
    pub fn find_edges_by_src(&self, src: u128) -> Vec<&EdgeRecordV2>;

    /// Find all edges with matching dst. O(E_buf).
    pub fn find_edges_by_dst(&self, dst: u128) -> Vec<&EdgeRecordV2>;

    /// Find all edges with matching edge_type. O(E_buf).
    pub fn find_edges_by_type(&self, edge_type: &str) -> Vec<&EdgeRecordV2>;

    // ── Buffer Management ────────────────────────────────────

    /// Number of nodes in buffer.
    pub fn node_count(&self) -> usize;

    /// Number of edges in buffer.
    pub fn edge_count(&self) -> usize;

    /// True if buffer contains no nodes AND no edges.
    pub fn is_empty(&self) -> bool;

    /// Remove and return all nodes, leaving buffer empty for nodes.
    /// Also clears the node HashMap.
    pub fn drain_nodes(&mut self) -> Vec<NodeRecordV2>;

    /// Remove and return all edges, leaving buffer empty for edges.
    /// Also clears the edge_keys HashSet.
    pub fn drain_edges(&mut self) -> Vec<EdgeRecordV2>;
}

impl Default for WriteBuffer {
    fn default() -> Self { Self::new() }
}
```

### 2.2. Shard API

```rust
use std::path::Path;
use crate::error::Result;
use crate::storage_v2::manifest::SegmentDescriptor;
use crate::storage_v2::types::{NodeRecordV2, EdgeRecordV2};

impl Shard {
    // ── Constructors ─────────────────────────────────────────

    /// Create new shard backed by a directory.
    /// Creates the directory if it does not exist.
    /// Starts with empty write buffer and no segments.
    pub fn create(path: &Path) -> Result<Self>;

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
    ) -> Result<Self>;

    /// Create ephemeral shard (in-memory only, no disk I/O).
    /// Flush writes to in-memory byte buffers loaded as segments.
    pub fn ephemeral() -> Self;

    // ── Write Operations ─────────────────────────────────────

    /// Add nodes to write buffer. Immediately queryable.
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>);

    /// Add edges to write buffer. Immediately queryable.
    /// Dedup via edge_keys in WriteBuffer.
    pub fn add_edges(&mut self, records: Vec<EdgeRecordV2>);

    // ── Flush ────────────────────────────────────────────────

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
    ) -> Result<Option<FlushResult>>;

    // ── Point Lookup ─────────────────────────────────────────

    /// Get node by id. Checks write buffer first, then segments
    /// newest-to-oldest with bloom filter short-circuit.
    /// Returns owned NodeRecordV2 (cloned from buffer or reconstructed
    /// from segment).
    pub fn get_node(&self, id: u128) -> Option<NodeRecordV2>;

    /// Check if node exists (same algorithm as get_node, avoids
    /// full record reconstruction).
    pub fn node_exists(&self, id: u128) -> bool;

    // ── Attribute Search ─────────────────────────────────────

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
    ) -> Vec<NodeRecordV2>;

    // ── Neighbor Queries ─────────────────────────────────────

    /// Get outgoing edges from a node, optionally filtered by edge type(s).
    /// Scans write buffer + edge segments with bloom filter on src.
    pub fn get_outgoing_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2>;

    /// Get incoming edges to a node, optionally filtered by edge type(s).
    /// Scans write buffer + edge segments with bloom filter on dst.
    pub fn get_incoming_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2>;

    // ── Stats ────────────────────────────────────────────────

    /// Total node count (write buffer + all node segments).
    /// Note: may overcount if same node ID exists in multiple segments
    /// (exact count requires dedup scan). For stats purposes only.
    pub fn node_count(&self) -> usize;

    /// Total edge count (write buffer + all edge segments).
    pub fn edge_count(&self) -> usize;

    /// Number of loaded segments: (node_segments, edge_segments).
    pub fn segment_count(&self) -> (usize, usize);

    /// Write buffer size: (nodes, edges).
    pub fn write_buffer_size(&self) -> (usize, usize);
}
```

---

## 3. Algorithms (Pseudocode)

### 3.1. Point Lookup: `get_node(id: u128) -> Option<NodeRecordV2>`

```
fn get_node(id):
    // Step 1: Check write buffer (O(1) HashMap lookup)
    if let Some(node) = write_buffer.get_node(id):
        return Some(node.clone())

    // Step 2: Scan segments newest-to-oldest
    for i in (0..node_segments.len()).rev():
        let seg = &node_segments[i]

        // Bloom filter: definite-no in O(k) where k=7 hash functions
        if !seg.maybe_contains(id):
            continue  // Bloom says definitely not here

        // Linear scan of ID column (cache-friendly sequential u128 reads)
        for j in 0..seg.record_count():
            if seg.get_id(j) == id:
                return Some(seg.get_record(j))

    // Step 3: Not found anywhere
    return None
```

### 3.2. `node_exists(id: u128) -> bool`

Same as `get_node` but avoids `get_record()` reconstruction:

```
fn node_exists(id):
    if write_buffer.get_node(id).is_some():
        return true

    for i in (0..node_segments.len()).rev():
        let seg = &node_segments[i]
        if !seg.maybe_contains(id):
            continue
        for j in 0..seg.record_count():
            if seg.get_id(j) == id:
                return true

    return false
```

### 3.3. Attribute Search: `find_nodes(node_type, file) -> Vec<NodeRecordV2>`

```
fn find_nodes(node_type: Option<&str>, file: Option<&str>):
    let mut seen_ids: HashSet<u128> = HashSet::new()
    let mut results: Vec<NodeRecordV2> = Vec::new()

    // Step 1: Scan write buffer (authoritative, scanned first)
    for node in write_buffer.iter_nodes():
        if node_type.is_some() && node.node_type != node_type.unwrap():
            continue
        if file.is_some() && node.file != file.unwrap():
            continue
        seen_ids.insert(node.id)
        results.push(node.clone())

    // Step 2: Scan segments newest-to-oldest
    for i in (0..node_segments.len()).rev():
        let desc = &node_descriptors[i]
        let seg  = &node_segments[i]

        // Zone map pruning at descriptor level (O(1), no I/O)
        if !desc.may_contain(node_type, file, None):
            continue  // Segment definitely doesn't have matching records

        // Zone map pruning at segment level (more precise, O(1))
        if let Some(nt) = node_type:
            if !seg.contains_node_type(nt):
                continue
        if let Some(f) = file:
            if !seg.contains_file(f):
                continue

        // Columnar scan of matching segment
        for j in 0..seg.record_count():
            let id = seg.get_id(j)

            // Dedup: skip if already seen (buffer or newer segment wins)
            if seen_ids.contains(&id):
                continue

            // Filter check using columnar accessors (no full record allocation)
            if let Some(nt) = node_type:
                if seg.get_node_type(j) != nt:
                    continue
            if let Some(f) = file:
                if seg.get_file(j) != f:
                    continue

            seen_ids.insert(id)
            results.push(seg.get_record(j))

    return results
```

### 3.4. Neighbor Query: `get_outgoing_edges(node_id, edge_types)`

```
fn get_outgoing_edges(node_id: u128, edge_types: Option<&[&str]>):
    let mut results: Vec<EdgeRecordV2> = Vec::new()

    // Step 1: Scan write buffer
    for edge in write_buffer.find_edges_by_src(node_id):
        if let Some(types) = edge_types:
            if !types.contains(&edge.edge_type.as_str()):
                continue
        results.push(edge.clone())

    // Step 2: Scan edge segments (no ordering requirement for edges,
    //         scan all segments, no dedup needed -- edges don't have unique IDs)
    for i in 0..edge_segments.len():
        let seg = &edge_segments[i]

        // Bloom filter on src
        if !seg.maybe_contains_src(node_id):
            continue

        // Optional zone map check on edge_type
        if let Some(types) = edge_types:
            let has_any = types.iter().any(|t| seg.contains_edge_type(t))
            if !has_any:
                continue

        // Linear scan
        for j in 0..seg.record_count():
            if seg.get_src(j) != node_id:
                continue
            if let Some(types) = edge_types:
                if !types.contains(&seg.get_edge_type(j)):
                    continue
            results.push(seg.get_record(j))

    return results
```

`get_incoming_edges` is identical except uses `dst` instead of `src`,
`maybe_contains_dst` instead of `maybe_contains_src`, and
`find_edges_by_dst` instead of `find_edges_by_src`.

### 3.5. Flush: `flush_with_ids(node_seg_id, edge_seg_id)`

```
fn flush_with_ids(node_segment_id: Option<u64>, edge_segment_id: Option<u64>):
    if write_buffer.is_empty():
        return Ok(None)

    let mut result = FlushResult {
        node_meta: None, edge_meta: None,
        node_segment_path: None, edge_segment_path: None,
    }

    // ── Flush nodes ──────────────────────────────────────────
    let nodes = write_buffer.drain_nodes()
    if !nodes.is_empty():
        let seg_id = node_segment_id
            .expect("node_segment_id required when buffer has nodes")

        let mut writer = NodeSegmentWriter::new()
        for node in &nodes:
            writer.add(node.clone())

        if let Some(path) = &self.path:
            // Disk shard: write to file
            let seg_path = segment_file_path(path, seg_id, "nodes")
            ensure_parent_dir(&seg_path)?
            let file = File::create(&seg_path)?
            let mut buf_writer = BufWriter::new(file)
            let meta = writer.finish(&mut buf_writer)?
            result.node_meta = Some(meta.clone())
            result.node_segment_path = Some(seg_path.clone())

            // Load the new segment immediately
            let seg = NodeSegmentV2::open(&seg_path)?
            let desc = build_descriptor(seg_id, SegmentType::Nodes, self.shard_id, &meta)
            self.node_segments.push(seg)
            self.node_descriptors.push(desc)
        else:
            // Ephemeral: write to in-memory buffer, load from bytes
            let mut cursor = Cursor::new(Vec::new())
            let meta = writer.finish(&mut cursor)?
            let bytes = cursor.into_inner()
            result.node_meta = Some(meta.clone())

            let seg = NodeSegmentV2::from_bytes(&bytes)?
            let desc = build_descriptor(seg_id, SegmentType::Nodes, self.shard_id, &meta)
            self.node_segments.push(seg)
            self.node_descriptors.push(desc)

    // ── Flush edges (same pattern) ───────────────────────────
    let edges = write_buffer.drain_edges()
    if !edges.is_empty():
        let seg_id = edge_segment_id
            .expect("edge_segment_id required when buffer has edges")

        let mut writer = EdgeSegmentWriter::new()
        for edge in &edges:
            writer.add(edge.clone())

        if let Some(path) = &self.path:
            let seg_path = segment_file_path(path, seg_id, "edges")
            ensure_parent_dir(&seg_path)?
            let file = File::create(&seg_path)?
            let mut buf_writer = BufWriter::new(file)
            let meta = writer.finish(&mut buf_writer)?
            result.edge_meta = Some(meta.clone())
            result.edge_segment_path = Some(seg_path.clone())

            let seg = EdgeSegmentV2::open(&seg_path)?
            let desc = build_descriptor(seg_id, SegmentType::Edges, self.shard_id, &meta)
            self.edge_segments.push(seg)
            self.edge_descriptors.push(desc)
        else:
            let mut cursor = Cursor::new(Vec::new())
            let meta = writer.finish(&mut cursor)?
            let bytes = cursor.into_inner()
            result.edge_meta = Some(meta.clone())

            let seg = EdgeSegmentV2::from_bytes(&bytes)?
            let desc = build_descriptor(seg_id, SegmentType::Edges, self.shard_id, &meta)
            self.edge_segments.push(seg)
            self.edge_descriptors.push(desc)

    return Ok(Some(result))
```

**Helper: `build_descriptor`** -- constructs a `SegmentDescriptor` from flush
metadata. This is a private helper within `shard.rs`, NOT the same as
`SegmentDescriptor::from_meta` (which the caller uses for the manifest). Shard
builds a local descriptor purely for its own zone map pruning.

```
fn build_descriptor(seg_id: u64, seg_type: SegmentType, shard_id: Option<u16>, meta: &SegmentMeta) -> SegmentDescriptor:
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
```

**Helper: `segment_file_path`** -- derives file path within shard directory:

```
fn segment_file_path(shard_path: &Path, seg_id: u64, type_suffix: &str) -> PathBuf:
    shard_path.join(format!("seg_{:06}_{}.seg", seg_id, type_suffix))
```

This uses the same naming convention as `SegmentDescriptor::file_path()` but
rooted in the shard directory rather than the database root.

---

## 4. Big-O Complexity Analysis

### 4.1. WriteBuffer Operations

| Operation | Time | Space | Explanation |
|---|---|---|---|
| `add_node(record)` | O(1) amortized | O(1) | HashMap insert/replace |
| `add_nodes(N records)` | O(N) amortized | O(N) | N HashMap inserts |
| `add_edge(record)` | O(1) amortized | O(1) | HashSet check + Vec push |
| `add_edges(N records)` | O(N) amortized | O(N) | N HashSet checks + Vec pushes |
| `get_node(id)` | O(1) | O(1) | HashMap lookup |
| `find_nodes_by_type(t)` | O(N_buf) | O(M) | Full scan of nodes HashMap, M = matches |
| `find_nodes_by_file(f)` | O(N_buf) | O(M) | Full scan of nodes HashMap, M = matches |
| `find_edges_by_src(src)` | O(E_buf) | O(M) | Full scan of edges Vec, M = matches |
| `find_edges_by_dst(dst)` | O(E_buf) | O(M) | Full scan of edges Vec, M = matches |
| `find_edges_by_type(t)` | O(E_buf) | O(M) | Full scan of edges Vec, M = matches |
| `drain_nodes()` | O(N_buf) | O(N_buf) | HashMap drain to Vec |
| `drain_edges()` | O(E_buf) | O(E_buf) | Vec swap (basically free) |
| `node_count()` | O(1) | O(1) | HashMap len |
| `edge_count()` | O(1) | O(1) | Vec len |
| `is_empty()` | O(1) | O(1) | Two len checks |

**Why linear scan is acceptable:** The write buffer is flushed regularly (every
analysis run). Typical buffer size: 1K-50K records. At 50K records, a linear
scan of u128 values takes ~100 microseconds (cache-friendly sequential access).
This is well within our query latency budget.

### 4.2. Shard Operations

Let:
- **N_buf** = nodes in write buffer
- **E_buf** = edges in write buffer
- **S_n** = number of node segments
- **S_e** = number of edge segments
- **N_seg** = average records per node segment
- **E_seg** = average records per edge segment
- **B_fpr** = bloom filter false positive rate (~0.82% = 0.0082)

| Operation | Time | Explanation |
|---|---|---|
| `get_node(id)` | O(1) + O(S_n * B_fpr * N_seg) | Buffer O(1), then bloom rejects ~99.2% of segments; expected scan ~0.008 * S_n segments |
| `node_exists(id)` | same as get_node | Same algorithm, avoids record allocation |
| `find_nodes(type, file)` | O(N_buf + M_n * N_seg) | M_n = segments not pruned by zone map |
| `get_outgoing_edges(id, types)` | O(E_buf + M_e * E_seg) | M_e = segments not pruned by bloom on src |
| `get_incoming_edges(id, types)` | O(E_buf + M_e * E_seg) | M_e = segments not pruned by bloom on dst |
| `add_nodes(records)` | O(len(records)) | Delegates to WriteBuffer |
| `add_edges(records)` | O(len(records)) | Delegates to WriteBuffer |
| `flush_with_ids()` | O(N_buf + E_buf) | Drain buffer + write segments + load segments |
| `node_count()` | O(S_n) | Sum across segments + buffer |
| `edge_count()` | O(S_e) | Sum across segments + buffer |

**Point lookup practical analysis:**

With 10 L0 segments and bloom FPR 0.82%:
- Expected segments that pass bloom = 10 * 0.0082 = 0.082 (usually 0)
- Best case: buffer hit = O(1)
- Typical case: buffer miss, all blooms reject = O(10 * k) where k=7 = O(70) hash operations
- Worst case: buffer miss, 1 bloom FP = O(70) + O(N_seg) scan

With N_seg = 10K: worst case ~10K u128 comparisons = ~160KB sequential read = ~50us.

**Attribute search practical analysis:**

Zone map effectiveness depends on data distribution. Typical Grafema analysis:
- Files from different directories land in different segments (flush per analysis run)
- `file` zone map prunes ~80-90% of segments for single-file queries
- `node_type` has fewer distinct values, less effective pruning (~50%)

---

## 5. Step-by-Step Implementation Phases

### Phase 1: WriteBuffer (~350 LOC, 8 tests)

**New file:** `packages/rfdb-server/src/storage_v2/write_buffer.rs`

**Functions to implement:**

1. `WriteBuffer::new()` -- Initialize empty HashMap, Vec, HashSet
2. `WriteBuffer::add_node(&mut self, record)` -- HashMap insert with `record.id` as key
3. `WriteBuffer::add_nodes(&mut self, records)` -- Loop calling `add_node`
4. `WriteBuffer::add_edge(&mut self, record) -> bool` -- Check edge_keys HashSet, if new: insert key + push to Vec
5. `WriteBuffer::add_edges(&mut self, records) -> usize` -- Loop calling `add_edge`, count successes
6. `WriteBuffer::get_node(&self, id) -> Option<&NodeRecordV2>` -- `self.nodes.get(&id)`
7. `WriteBuffer::iter_nodes()` -- `self.nodes.values()`
8. `WriteBuffer::iter_edges()` -- `self.edges.iter()`
9. `WriteBuffer::find_nodes_by_type(&self, node_type)` -- Filter `iter_nodes()` by `node_type`
10. `WriteBuffer::find_nodes_by_file(&self, file)` -- Filter `iter_nodes()` by `file`
11. `WriteBuffer::find_edges_by_src(&self, src)` -- Filter `iter_edges()` by `src`
12. `WriteBuffer::find_edges_by_dst(&self, dst)` -- Filter `iter_edges()` by `dst`
13. `WriteBuffer::find_edges_by_type(&self, edge_type)` -- Filter `iter_edges()` by `edge_type`
14. `WriteBuffer::node_count()` -- `self.nodes.len()`
15. `WriteBuffer::edge_count()` -- `self.edges.len()`
16. `WriteBuffer::is_empty()` -- `self.nodes.is_empty() && self.edges.is_empty()`
17. `WriteBuffer::drain_nodes()` -- `self.nodes.drain().map(|(_, v)| v).collect()`
18. `WriteBuffer::drain_edges()` -- `std::mem::take(&mut self.edges)` + `self.edge_keys.clear()`
19. `Default` impl

**Tests (in same file, `#[cfg(test)] mod tests`):**

Re-use the `make_node` / `make_edge` helpers from `segment.rs` tests (copy the pattern, these are test-only helpers).

| # | Test Name | What It Verifies |
|---|---|---|
| 1 | `test_empty_buffer` | `new()` returns empty, `is_empty()` true, counts = 0 |
| 2 | `test_add_get_node_roundtrip` | Add node, get by id returns same record |
| 3 | `test_add_get_edges` | Add edges, iter_edges returns them |
| 4 | `test_node_upsert` | Add node with same id twice, second wins |
| 5 | `test_edge_dedup` | Add edge with same (src, dst, type) twice, only one stored |
| 6 | `test_query_by_type_file_src_dst` | `find_nodes_by_type`, `find_nodes_by_file`, `find_edges_by_src`, `find_edges_by_dst`, `find_edges_by_type` all return correct subsets |
| 7 | `test_drain_empties_buffer` | After drain_nodes + drain_edges, buffer is empty; drained vecs contain all records |
| 8 | `test_multiple_edge_types_same_endpoints` | Edges with same (src, dst) but different edge_type are NOT deduped |

### Phase 2: Shard Core + Flush (~400 LOC, 8 tests)

**New file:** `packages/rfdb-server/src/storage_v2/shard.rs`

**Update:** `packages/rfdb-server/src/storage_v2/mod.rs` -- add 2 lines:
```rust
pub mod write_buffer;
pub mod shard;
```
And corresponding re-exports:
```rust
pub use write_buffer::WriteBuffer;
pub use shard::{Shard, FlushResult};
```

**Functions to implement:**

1. `Shard::create(path)` -- Create dir, return Shard with empty buffer + empty segment vecs
2. `Shard::ephemeral()` -- Return Shard with `path: None`, empty everything
3. `Shard::add_nodes(&mut self, records)` -- `self.write_buffer.add_nodes(records)`
4. `Shard::add_edges(&mut self, records)` -- `self.write_buffer.add_edges(records)`
5. `Shard::flush_with_ids(node_seg_id, edge_seg_id) -> Result<Option<FlushResult>>` -- Full flush algorithm (see Section 3.5)
6. Private helpers: `segment_file_path()`, `build_descriptor()`
7. `Shard::write_buffer_size()` -- `(write_buffer.node_count(), write_buffer.edge_count())`
8. `Shard::segment_count()` -- `(node_segments.len(), edge_segments.len())`

**Tests:**

| # | Test Name | What It Verifies |
|---|---|---|
| 1 | `test_create_empty_shard` | Create shard, verify empty buffer + no segments |
| 2 | `test_add_nodes_flush_ephemeral` | Ephemeral shard: add nodes, flush, verify segment_count = (1, 0) |
| 3 | `test_add_edges_flush_ephemeral` | Ephemeral shard: add edges, flush, verify segment_count = (0, 1) |
| 4 | `test_flush_empty_buffer_noop` | Flush with empty buffer returns Ok(None), no segments created |
| 5 | `test_multiple_flushes` | Flush twice, verify segment_count = (2, 2) |
| 6 | `test_flush_result_metadata` | FlushResult contains correct record_count, byte_size, node_types/edge_types |
| 7 | `test_flush_disk_shard` | Disk shard (tempdir): flush, verify segment file exists on disk |
| 8 | `test_write_buffer_empty_after_flush` | After flush, write_buffer_size() = (0, 0) |

### Phase 3: Point Lookup (~150 LOC, 4 tests)

**Add to `shard.rs`:**

1. `Shard::get_node(&self, id)` -- Algorithm from Section 3.1
2. `Shard::node_exists(&self, id)` -- Algorithm from Section 3.2

**Tests:**

| # | Test Name | What It Verifies |
|---|---|---|
| 1 | `test_get_node_from_buffer` | Node in write buffer found by id |
| 2 | `test_get_node_from_segment` | Add nodes, flush, get_node returns correct record from segment |
| 3 | `test_get_node_not_found` | Non-existent id returns None; node_exists returns false |
| 4 | `test_get_node_buffer_wins_over_segment` | Same node id in buffer and segment: buffer version returned |

### Phase 4: Attribute Search (~150 LOC, 4 tests)

**Add to `shard.rs`:**

1. `Shard::find_nodes(&self, node_type, file)` -- Algorithm from Section 3.3
2. `Shard::node_count(&self)` -- Sum write_buffer.node_count() + all segment record_counts

**Tests:**

| # | Test Name | What It Verifies |
|---|---|---|
| 1 | `test_find_nodes_by_type_in_buffer` | Finds nodes by type from write buffer |
| 2 | `test_find_nodes_by_type_in_segment` | Add, flush, find returns correct nodes from segment |
| 3 | `test_find_nodes_zone_map_prunes` | Two flushes with different file sets, query by file only scans relevant segment (verify by checking results, not internals) |
| 4 | `test_find_nodes_dedup_buffer_wins` | Same node id in buffer (updated type) and segment: buffer version in results, no duplicate |

### Phase 5: Neighbor Queries (~200 LOC, 4 tests)

**Add to `shard.rs`:**

1. `Shard::get_outgoing_edges(&self, node_id, edge_types)` -- Algorithm from Section 3.4
2. `Shard::get_incoming_edges(&self, node_id, edge_types)` -- Mirror of outgoing
3. `Shard::edge_count(&self)` -- Sum write_buffer.edge_count() + all segment record_counts

**Tests:**

| # | Test Name | What It Verifies |
|---|---|---|
| 1 | `test_outgoing_edges_from_buffer` | Outgoing edges from write buffer found |
| 2 | `test_outgoing_edges_from_segment` | Add, flush, get_outgoing returns correct edges |
| 3 | `test_incoming_edges_with_type_filter` | get_incoming_edges with edge_types filter returns only matching types |
| 4 | `test_edges_across_buffer_and_segments` | Edges in both buffer and multiple segments all returned |

### Phase 6: Integration + Equivalence Tests (~200 LOC, 6 tests)

**Add to `shard.rs` test module:**

| # | Test Name | What It Verifies |
|---|---|---|
| 1 | `test_equivalence_point_lookup` | Same 1000 nodes in HashMap vs Shard: get_node returns identical results for every id |
| 2 | `test_equivalence_attribute_search` | Same data: find_nodes by type returns same set of records |
| 3 | `test_full_lifecycle` | Add nodes -> query -> add edges -> flush -> query neighbors -> flush again -> query all |
| 4 | `test_multiple_segments_queryable` | Flush 3 times, all 3 segments queryable |
| 5 | `test_unflushed_and_flushed_both_visible` | Some data flushed, some in buffer: both visible in find_nodes |
| 6 | `test_open_existing_shard` | Disk shard: create, add, flush, close. Open with descriptors, query succeeds |

---

## 6. Design Decisions

### 6.1. flush() takes segment IDs from caller

**Decision:** `flush_with_ids(node_segment_id, edge_segment_id)` takes explicit
segment IDs allocated by `ManifestStore::next_segment_id()`.

**Rationale:**
- Segment file naming must be globally unique across all shards (T3.x)
- ManifestStore owns the monotonic ID counter
- Shard generates files using these IDs, naming is consistent with manifest
- No file renames needed (unlike the alternative where Shard generates local names)

**Caller pattern:**
```rust
let node_id = if shard.write_buffer_size().0 > 0 { Some(manifest_store.next_segment_id()) } else { None };
let edge_id = if shard.write_buffer_size().1 > 0 { Some(manifest_store.next_segment_id()) } else { None };
let result = shard.flush_with_ids(node_id, edge_id)?;
```

### 6.2. Shard carries `shard_id: Option<u16>`

**Decision:** The `Shard` struct has a `shard_id: Option<u16>` field.

**For T2.2:** Always `None`. Not used in query logic, file path derivation, or
any read/write operation.

**For T3.x:** Will be `Some(n)` where `n` is the shard index. Used by
`segment_file_path` to create shard-specific subdirectories
(`segments/05/seg_000001_nodes.seg`).

**Why include now:** Adding a field later would require changing the constructor
signatures, which is a breaking API change for any code that depends on Shard.
Better to have the field from day one as `None`.

### 6.3. WriteBuffer enforces edge dedup

**Decision:** `WriteBuffer` enforces edge uniqueness via
`HashSet<(u128, u128, String)>` matching the v1 `edge_keys` pattern.

**Rationale:**
- v1 engine enforces this invariant; v2 should maintain behavioral parity
- Cheap: HashSet insert is O(1) amortized
- Prevents duplicate edges that would accumulate across flushes and require
  cleanup during compaction
- `add_edge` returns `bool` (true = added, false = duplicate) for caller awareness
- Edge key is `(src, dst, edge_type)` -- same edge between same endpoints with
  same type is a duplicate; different types are distinct edges

**Edge case:** After flush, the edge_keys are cleared along with the edges Vec.
If the same edge is added again in the next buffer window, it will be added
(not deduped against flushed segments). This is fine because:
1. Re-analysis of the same file produces identical edges
2. Multiple segments with the same edge don't cause correctness issues
   (neighbor queries return all matches, caller can dedup if needed)
3. Compaction (future task) will merge duplicate edges

### 6.4. Segment ordering and dedup strategy

**Decision:** Segments are ordered oldest-first in the Vec. Reads iterate
`.rev()` (newest-to-oldest). First match wins for node dedup.

**For nodes:** Write buffer > newest segment > older segments. A `HashSet<u128>`
tracks seen IDs during attribute search to skip duplicates.

**For edges:** No dedup needed. Edges don't have unique IDs. All matching edges
from all sources are collected. If the same logical edge appears in multiple
segments (after multiple analyses of the same code), all copies are returned.
This is consistent with the v1 behavior where `edge_keys` only deduped within a
single session.

### 6.5. Ephemeral shard strategy

**Decision:** Ephemeral shards (`path: None`) write to `Cursor<Vec<u8>>` and
load segments from bytes using `NodeSegmentV2::from_bytes()` /
`EdgeSegmentV2::from_bytes()`.

**Rationale:**
- Tests exercise the full flush + query path without temp directories
- Existing `from_bytes()` methods on segment readers handle this perfectly
- No file I/O, no cleanup needed
- Exact same query code path as disk-backed shards

---

## 7. How Shard Reads Existing Segments

### 7.1. On `open()`

The `Shard::open()` constructor receives pre-built segment descriptors from the
caller (which got them from `ManifestStore::current().node_segments` /
`edge_segments`).

```
fn open(path, db_path, node_descriptors, edge_descriptors):
    let mut node_segments = Vec::new()
    for desc in &node_descriptors:
        let file_path = desc.file_path(db_path)
        let seg = NodeSegmentV2::open(&file_path)?
        node_segments.push(seg)

    let mut edge_segments = Vec::new()
    for desc in &edge_descriptors:
        let file_path = desc.file_path(db_path)
        let seg = EdgeSegmentV2::open(&file_path)?
        edge_segments.push(seg)

    Ok(Shard {
        path: Some(path.to_path_buf()),
        shard_id: None,  // T2.2: single shard
        write_buffer: WriteBuffer::new(),
        node_segments,
        edge_segments,
        node_descriptors,
        edge_descriptors,
    })
```

### 7.2. Segment file resolution

`SegmentDescriptor::file_path(db_path)` produces paths like:
- `<db_path>/segments/seg_000001_nodes.seg` (when `shard_id: None`)
- `<db_path>/segments/05/seg_000001_nodes.seg` (when `shard_id: Some(5)`)

This method already exists in `manifest.rs` and handles both cases.

### 7.3. Multiple segments: dedup order

Segments are loaded in the order provided by the caller (which mirrors the
manifest's segment list order -- oldest first). During reads:

- **Point lookup:** Iterates `.rev()` (newest first). First match returned.
  Rationale: newest segment has the most recent version of a node.

- **Attribute search:** Iterates `.rev()` with `HashSet<u128>` for seen IDs.
  Nodes in newer segments shadow those in older segments.

- **Neighbor queries:** Iterates all segments (no ordering requirement). All
  matching edges returned regardless of which segment they're in.

---

## 8. What NOT To Do

These are explicitly out of scope for T2.2 and must NOT be implemented:

| Excluded Feature | Why |
|---|---|
| **Compaction** | Separate task. L0 segments accumulate. |
| **Tombstones / delete** | No delete support. Append-only model. |
| **Multi-shard coordination** | Single shard. Database layer (T3.x) manages multiple shards. |
| **WAL (Write-Ahead Log)** | Re-analysis is recovery. Per architecture doc. |
| **Concurrent access** | Single-writer, single-reader. Thread safety is T3.x. |
| **Adjacency index** | Neighbor queries use linear scan + bloom. Index comes with L1+. |
| **Inverted index** | Attribute search uses columnar scan + zone map. Index comes with L1+. |
| **Sorted segments** | L0 segments are unsorted. Sorting comes with compaction. |
| **Range queries** | Not needed for L0. Binary search requires sorted data. |
| **Shard routing** | `shard_id` field exists but is never used for routing. |
| **Segment eviction / cache** | All segments loaded eagerly on open. LRU cache is T3.x. |

---

## 9. File Changes Summary

| File | Action | Lines Changed |
|---|---|---|
| `storage_v2/write_buffer.rs` | **NEW** | ~350 LOC (struct + impl + tests) |
| `storage_v2/shard.rs` | **NEW** | ~1500 LOC (struct + impl + all tests) |
| `storage_v2/mod.rs` | **UPDATE** | +4 lines (mod declarations + re-exports) |
| **Total** | | **~1855 LOC** |

No other files are modified. All existing types, writers, readers, bloom filters,
zone maps, and manifest code remain unchanged.

---

## 10. Caller Integration Example

This shows how a future Database or Engine layer would use Shard + ManifestStore
together. This code is NOT part of T2.2 -- it's here to demonstrate the
integration pattern.

```rust
// Setup
let db_path = Path::new("/data/my_graph.rfdb");
let mut manifest_store = ManifestStore::create(db_path)?;
let shard_path = db_path.join("segments"); // T2.2: single shard = segments dir
let mut shard = Shard::create(&shard_path)?;

// Write
shard.add_nodes(vec![node1, node2, node3]);
shard.add_edges(vec![edge1, edge2]);

// Query (immediate, from write buffer)
let node = shard.get_node(node1.id);
let edges = shard.get_outgoing_edges(node1.id, None);

// Flush
let has_nodes = shard.write_buffer_size().0 > 0;
let has_edges = shard.write_buffer_size().1 > 0;
let node_seg_id = if has_nodes { Some(manifest_store.next_segment_id()) } else { None };
let edge_seg_id = if has_edges { Some(manifest_store.next_segment_id()) } else { None };

if let Some(result) = shard.flush_with_ids(node_seg_id, edge_seg_id)? {
    // Build descriptors for manifest
    let mut node_descs = manifest_store.current().node_segments.clone();
    if let Some(meta) = result.node_meta {
        node_descs.push(SegmentDescriptor::from_meta(
            node_seg_id.unwrap(), SegmentType::Nodes, None, meta,
        ));
    }
    let mut edge_descs = manifest_store.current().edge_segments.clone();
    if let Some(meta) = result.edge_meta {
        edge_descs.push(SegmentDescriptor::from_meta(
            edge_seg_id.unwrap(), SegmentType::Edges, None, meta,
        ));
    }

    // Commit manifest
    let manifest = manifest_store.create_manifest(node_descs, edge_descs, None)?;
    manifest_store.commit(manifest)?;
}

// Query (from segments now)
let node = shard.get_node(node1.id);  // same API, now reads from segment
```

---

## 11. Risk Register

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Read amplification with many L0 segments | Medium | Low | Bloom FPR ~0.82%. With 10 segments, expected FP scans = 0.08/lookup. Acceptable. Compaction (future) reduces to 1-2 segments. |
| 2 | Node dedup in attribute search is incorrect | Low | High | HashSet<u128> tracks seen IDs. Write buffer scanned first (authoritative). Equivalence test (#1 in Phase 6) catches this. |
| 3 | Segment ordering wrong after multiple flushes | Low | High | Segments appended to Vec in creation order. `.rev()` iterator gives newest-first. Test #4 in Phase 6 verifies. |
| 4 | Empty flush creates empty segment files | Low | Medium | `flush_with_ids` returns `Ok(None)` if buffer is empty. Test #4 in Phase 2 verifies. |
| 5 | Edge dedup HashSet memory grows unbounded | Low | Low | Cleared on `drain_edges()`. Buffer is flushed regularly. |
| 6 | `from_bytes` clones entire segment data | Medium | Low | `NodeSegmentV2::from_bytes` does `bytes.to_vec()`. For ephemeral shards this is fine (test data). For disk shards we use `open()` which mmap's. |

---

## 12. Test Data Strategy

All tests use the same `make_node` / `make_edge` helper pattern from existing
segment tests:

```rust
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
        blake3::hash(src_id.as_bytes()).as_bytes()[0..16].try_into().unwrap()
    );
    let dst = u128::from_le_bytes(
        blake3::hash(dst_id.as_bytes()).as_bytes()[0..16].try_into().unwrap()
    );
    EdgeRecordV2 {
        src, dst,
        edge_type: edge_type.to_string(),
        metadata: String::new(),
    }
}
```

These helpers are duplicated per test module (not shared across files) to keep
test files self-contained, matching the existing pattern in `segment.rs` and
`writer.rs`.

For the equivalence test, a `ReferenceStore` is built as a simple HashMap +
Vec, fed the same data as the Shard, and all query results are compared.
