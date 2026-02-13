# RFD-6: T2.2 Single-Shard Read/Write — Don's Plan

> Date: 2026-02-13
> Author: Don Melton (Tech Lead)
> Status: Plan for review

---

## 0. Executive Summary

Build `Shard` — the primary read/write unit for RFDB v2. A shard is a directory containing immutable columnar segments + an in-memory write buffer. All three query patterns (point lookup, attribute search, neighbors) scan write buffer + segments and merge results. The write path accumulates records in memory, then flushes to a new segment file + manifest update.

This is the core engine that replaces the v1 `GraphEngine`'s HashMap + delta log pattern with an LSM-tree-inspired design: write buffer (memtable analog) -> flush -> immutable segments (SSTable analog).

**Key design constraint:** No compaction in T2.2. Level 0 only. All segments are unsorted, bloom filter + zone map for skip. Compaction comes in a later task.

---

## 1. Prior Art & Context

### 1.1. LSM-Tree Pattern (grounded in real systems)

The standard LSM-tree pattern (RocksDB, LevelDB, ScyllaDB) uses:
1. **Memtable** (in-memory write buffer) — all writes go here first
2. **Flush** — when buffer hits threshold, write to immutable SSTable on disk
3. **Read** — scan memtable first, then SSTables newest-to-oldest, merge results
4. **Compaction** — background merge of SSTables to reduce read amplification

RFDB v2 follows this pattern but simplifies for our use case:
- No WAL (re-analysis = recovery, per architecture doc)
- No sorted SSTables at L0 (columnar segments with bloom + zone map instead)
- No compaction yet (T2.2 is L0-only; compaction is a separate task)
- Separate node/edge segments (not mixed KV)

Sources:
- [Building an LSM-Tree from Scratch](https://medium.com/@rahulhind/building-an-lsm-tree-from-scratch-implementing-memtable-sstable-and-wal-805e2660664b)
- [LSM-tree Wikipedia](https://en.wikipedia.org/wiki/Log-structured_merge-tree)
- [ScyllaDB LSM Glossary](https://www.scylladb.com/glossary/log-structured-merge-tree/)

### 1.2. What We Already Have (T1.1 + T2.1)

| Component | File | Status |
|-----------|------|--------|
| `NodeRecordV2`, `EdgeRecordV2` | `types.rs` | DONE |
| `NodeSegmentWriter`, `EdgeSegmentWriter` | `writer.rs` | DONE |
| `NodeSegmentV2`, `EdgeSegmentV2` (readers) | `segment.rs` | DONE |
| `BloomFilter` | `bloom.rs` | DONE |
| `ZoneMap` | `zone_map.rs` | DONE |
| `StringTableV2` | `string_table.rs` | DONE |
| `ManifestStore`, `Manifest`, `SegmentDescriptor` | `manifest.rs` | DONE |

**What we need to build:** The `Shard` struct that ties all of these together into a coherent read/write engine.

### 1.3. V1 Engine Pattern (what we're replacing)

The v1 `GraphEngine` uses:
- `delta_nodes: HashMap<u128, NodeRecord>` — in-memory write buffer for nodes
- `delta_edges: Vec<EdgeRecord>` — in-memory write buffer for edges
- `nodes_segment: Option<NodesSegment>` — single mmap segment for nodes
- `edges_segment: Option<EdgesSegment>` — single mmap segment for edges
- `adjacency: HashMap<u128, Vec<usize>>` — in-memory forward adjacency list
- `reverse_adjacency: HashMap<u128, Vec<usize>>` — in-memory reverse adjacency list
- `edge_keys: HashSet<(u128, u128, String)>` — edge deduplication

Key insight: v1 can only have ONE segment per type. v2 supports multiple segments (L0 segments accumulate before compaction).

---

## 2. File Organization

### 2.1. New Files

```
packages/rfdb-server/src/storage_v2/
├── mod.rs              # UPDATE: add `pub mod shard; pub mod write_buffer;`
├── shard.rs            # NEW: ~800 LOC — Shard struct + read/write/query
├── write_buffer.rs     # NEW: ~350 LOC — WriteBuffer (in-memory accumulation)
└── (existing files unchanged)
```

### 2.2. Why Two Files, Not One

- **`write_buffer.rs`**: Pure in-memory data structure. No I/O, no manifest awareness. Clean separation of concerns. Easy to test in isolation.
- **`shard.rs`**: Orchestrates write buffer + segments + manifest. Handles the read path merge logic and the write path flush-to-disk.

This matches the LSM-tree memtable/SSTable split.

---

## 3. Data Structures

### 3.1. WriteBuffer (`write_buffer.rs`)

```rust
/// In-memory accumulation buffer for records before flush.
///
/// Analogous to LSM-tree memtable. Holds both nodes and edges.
/// NOT sorted — L0 segments are unsorted.
///
/// Thread safety: NOT Send+Sync. Single-writer access assumed.
pub struct WriteBuffer {
    nodes: HashMap<u128, NodeRecordV2>,   // Keyed by id for O(1) point lookup
    edges: Vec<EdgeRecordV2>,             // Append-only
    node_count: usize,                    // Live count (excluding tombstones, if any)
    edge_count: usize,
}
```

**Why `HashMap<u128, NodeRecordV2>` for nodes?**
- Point lookup in write buffer must be O(1) — same as v1 `delta_nodes`
- Node ID is unique — HashMap enforces this
- `add_node` with existing ID = upsert (replace)

**Why `Vec<EdgeRecordV2>` for edges?**
- Edges are not unique by any single field (multiple edges between same src/dst with different types)
- Neighbor queries need full scan of write buffer edges anyway
- Simple append is fastest write path

**WriteBuffer API:**

```rust
impl WriteBuffer {
    pub fn new() -> Self;

    // Write operations
    pub fn add_node(&mut self, record: NodeRecordV2);
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>);
    pub fn add_edge(&mut self, record: EdgeRecordV2);
    pub fn add_edges(&mut self, records: Vec<EdgeRecordV2>);

    // Read operations (for merge with segments)
    pub fn get_node(&self, id: u128) -> Option<&NodeRecordV2>;
    pub fn iter_nodes(&self) -> impl Iterator<Item = &NodeRecordV2>;
    pub fn iter_edges(&self) -> impl Iterator<Item = &EdgeRecordV2>;

    // Query support
    pub fn find_nodes_by_type(&self, node_type: &str) -> Vec<&NodeRecordV2>;
    pub fn find_nodes_by_file(&self, file: &str) -> Vec<&NodeRecordV2>;
    pub fn find_edges_by_src(&self, src: u128) -> Vec<&EdgeRecordV2>;
    pub fn find_edges_by_dst(&self, dst: u128) -> Vec<&EdgeRecordV2>;
    pub fn find_edges_by_type(&self, edge_type: &str) -> Vec<&EdgeRecordV2>;

    // Buffer management
    pub fn node_count(&self) -> usize;
    pub fn edge_count(&self) -> usize;
    pub fn is_empty(&self) -> bool;
    pub fn clear(&mut self);

    // Drain for flush (consumes buffer contents)
    pub fn drain_nodes(&mut self) -> Vec<NodeRecordV2>;
    pub fn drain_edges(&mut self) -> Vec<EdgeRecordV2>;
}
```

**Complexity:**
- `add_node`: O(1) amortized
- `add_edge`: O(1) amortized
- `get_node(id)`: O(1) — HashMap lookup
- `find_edges_by_src(src)`: O(E_buf) — linear scan of write buffer edges
- `find_nodes_by_type(t)`: O(N_buf) — linear scan of write buffer nodes

This is fine because write buffer is small (flushed regularly). For L0, linear scans on small in-memory data are faster than index lookups.

### 3.2. Shard (`shard.rs`)

```rust
/// A shard is a directory containing segments + a write buffer.
///
/// This is the primary read/write unit for RFDB v2.
/// Write path: records -> write buffer -> flush -> segment files + manifest update
/// Read path: query -> write buffer scan + segment scan -> merge results
///
/// A Shard does NOT own the ManifestStore. The ManifestStore is shared
/// across all shards and managed by the database layer (T3.x).
/// Shard receives segment descriptors and manifest updates happen externally.
pub struct Shard {
    /// Shard directory path (None for ephemeral shards)
    path: Option<PathBuf>,

    /// In-memory write buffer (unflushed records)
    write_buffer: WriteBuffer,

    /// Loaded node segments (from disk, mmap'd or in-memory)
    node_segments: Vec<NodeSegmentV2>,

    /// Loaded edge segments (from disk, mmap'd or in-memory)
    edge_segments: Vec<EdgeSegmentV2>,

    /// Segment descriptors (from manifest, for zone map pruning)
    node_descriptors: Vec<SegmentDescriptor>,
    edge_descriptors: Vec<SegmentDescriptor>,
}
```

**Key design decisions:**

1. **Shard does NOT own ManifestStore.** ManifestStore is a database-level concern (T3.x will have a `Database` that owns ManifestStore + multiple Shards). For T2.2, Shard receives segment info and returns flush results; the caller updates the manifest.

2. **Segments stored in `Vec<NodeSegmentV2>`.** Multiple L0 segments per shard. Newest segments at the end (append order). Reads scan all segments.

3. **Descriptors parallel to segments.** `node_descriptors[i]` corresponds to `node_segments[i]`. Descriptors carry zone map data for segment skipping without opening the segment.

4. **Ephemeral shards** (`path: None`) — for testing. Write buffer never flushes to disk; flush writes to in-memory byte buffers that are loaded as segments.

---

## 4. Write Path

### 4.1. Accumulate in Write Buffer

```
add_nodes(records) -> write_buffer.add_nodes(records)
add_edges(records) -> write_buffer.add_edges(records)
```

No I/O. No manifest update. Records are immediately queryable via write buffer.

### 4.2. Flush to Segment

```
flush() ->
  1. Drain nodes from write buffer -> NodeSegmentWriter -> write to file
  2. Drain edges from write buffer -> EdgeSegmentWriter -> write to file
  3. Return (SegmentMeta for nodes, SegmentMeta for edges)
  4. Caller creates SegmentDescriptors + updates manifest
  5. Load new segments into shard's segment vectors
```

**Flush protocol (detailed):**

```rust
/// Flush write buffer to disk segments.
///
/// Returns FlushResult containing segment metadata for manifest update.
/// The caller is responsible for:
/// 1. Allocating segment IDs via ManifestStore::next_segment_id()
/// 2. Creating SegmentDescriptors from the metadata
/// 3. Committing a new manifest version
///
/// After flush, the write buffer is empty and the new segments are
/// loaded and queryable.
pub fn flush(&mut self) -> Result<FlushResult>;

pub struct FlushResult {
    pub node_meta: Option<SegmentMeta>,   // None if no nodes in buffer
    pub edge_meta: Option<SegmentMeta>,   // None if no edges in buffer
    pub node_segment_path: Option<PathBuf>,
    pub edge_segment_path: Option<PathBuf>,
}
```

**Ephemeral flush:** Instead of writing to disk, write to `Cursor<Vec<u8>>`, then load from bytes. This lets tests exercise the full flush + query path without temp directories.

**File naming convention:** Uses segment IDs from ManifestStore. But since Shard doesn't own ManifestStore, the flush method takes segment IDs as parameters:

```rust
pub fn flush_with_ids(
    &mut self,
    node_segment_id: Option<u64>,  // None if buffer has no nodes
    edge_segment_id: Option<u64>,  // None if buffer has no edges
) -> Result<FlushResult>;
```

Alternative: simpler `flush()` that uses sequential naming within the shard directory (`seg_0001_nodes.seg`, etc.) and returns metadata. Caller maps to global segment IDs. **I prefer the explicit ID approach** — it keeps naming consistent with the manifest and avoids renaming files.

### 4.3. Segment File Paths

Per the existing `SegmentDescriptor::file_path()`:
- Phase 1 (no sharding): `segments/seg_000001_nodes.seg`
- T2.2 (with shard_id): `segments/05/seg_000001_nodes.seg`

Shard creates its subdirectory under `segments/` on first flush.

---

## 5. Read Path

### 5.1. Point Lookup: `get_node(id: u128) -> Option<NodeRecordV2>`

```
1. Check write buffer: write_buffer.get_node(id)
   -> Found? Return it. (Write buffer has latest data.)

2. Check segments newest-to-oldest:
   for segment in node_segments.iter().rev():
     if segment.maybe_contains(id):     // Bloom filter O(1)
       for i in 0..segment.record_count():
         if segment.get_id(i) == id:
           return Some(segment.get_record(i))

3. Not found -> None
```

**Complexity:**
- Write buffer: O(1) HashMap lookup
- Per segment: O(1) bloom check + O(N_seg) scan (if bloom says maybe)
- Total: O(1) + O(S * N_seg) worst case where S = segments that pass bloom
- In practice: bloom FPR < 1%, so typically 0-1 segment scans

**Why scan instead of binary search?**
- L0 segments are unsorted (no sort key). Binary search not applicable.
- Segments are typically small at L0 (few thousand records).
- Columnar layout means ID column scan is cache-friendly (sequential u128 reads).
- Binary search comes with L1+ compacted segments (future task).

**IMPORTANT: Newest-to-oldest scan order.** If the same node ID appears in multiple segments (after re-analysis), the newest segment's version wins. Write buffer > newest segment > older segments.

### 5.2. Attribute Search: `find_nodes(node_type, file) -> Vec<NodeRecordV2>`

```
1. Scan write buffer:
   write_buffer.find_nodes_by_type(node_type)
   write_buffer.find_nodes_by_file(file)
   -> Collect matching records

2. For each node segment + descriptor:
   // Zone map pruning at descriptor level (no segment open needed)
   if !descriptor.may_contain(node_type, file, None):
     skip segment

   // Zone map pruning at segment level (more precise)
   if node_type.is_some() && !segment.contains_node_type(node_type):
     skip segment
   if file.is_some() && !segment.contains_file(file):
     skip segment

   // Columnar scan of matching segment
   for i in 0..segment.record_count():
     if matches(segment, i, node_type, file):
       results.push(segment.get_record(i))

3. Deduplicate by ID (write buffer wins over segments, newest segment wins)
```

**Complexity:**
- Write buffer: O(N_buf)
- Per matching segment: O(N_seg) columnar scan
- Total: O(N_buf + M * N_seg) where M = segments not pruned by zone map
- Zone map prunes effectively: segments from different directories have disjoint `file` values

**Two-level zone map pruning:** First check `SegmentDescriptor.may_contain()` (from manifest, O(1), no I/O). Then check `NodeSegmentV2.contains_node_type()` / `contains_file()` (from loaded segment footer, O(1)). The descriptor-level check is a coarser optimization that can skip segments without even loading them from disk. For T2.2 (single shard), all segments are already loaded, so both levels are effectively O(1). But the descriptor-level check will matter in T3.x when we have multiple shards and don't load all segments eagerly.

### 5.3. Neighbor Query: `get_edges(src, direction) -> Vec<EdgeRecordV2>`

```
1. Scan write buffer:
   if direction == Outgoing:
     write_buffer.find_edges_by_src(src)
   else:
     write_buffer.find_edges_by_dst(dst)

2. For each edge segment:
   // Bloom filter check
   if direction == Outgoing && !segment.maybe_contains_src(src):
     skip segment
   if direction == Incoming && !segment.maybe_contains_dst(dst):
     skip segment

   // Scan matching segment
   for i in 0..segment.record_count():
     if direction == Outgoing && segment.get_src(i) == src:
       results.push(segment.get_record(i))
     if direction == Incoming && segment.get_dst(i) == dst:
       results.push(segment.get_record(i))

3. Return results (no dedup needed — edges don't have unique IDs)
```

**Complexity:**
- Write buffer: O(E_buf)
- Per matching segment: O(E_seg) columnar scan
- Total: O(E_buf + M * E_seg) where M = segments not pruned by bloom
- Bloom on src/dst is very effective: ~1% FPR per segment

**Edge type filtering:** Can combine bloom check with zone map edge_type check:
```
if edge_types.is_some() && !segment.contains_edge_type(et): skip
```

---

## 6. Shard Public API

```rust
impl Shard {
    // ── Constructors ─────────────────────────────────────────
    pub fn create(path: &Path) -> Result<Self>;
    pub fn open(path: &Path, descriptors: &[SegmentDescriptor]) -> Result<Self>;
    pub fn ephemeral() -> Self;

    // ── Write Operations ─────────────────────────────────────
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>);
    pub fn add_edges(&mut self, records: Vec<EdgeRecordV2>);

    // ── Flush ────────────────────────────────────────────────
    pub fn flush_with_ids(
        &mut self,
        node_segment_id: Option<u64>,
        edge_segment_id: Option<u64>,
    ) -> Result<FlushResult>;

    // ── Point Lookup ─────────────────────────────────────────
    pub fn get_node(&self, id: u128) -> Option<NodeRecordV2>;
    pub fn node_exists(&self, id: u128) -> bool;

    // ── Attribute Search ─────────────────────────────────────
    pub fn find_nodes(
        &self,
        node_type: Option<&str>,
        file: Option<&str>,
    ) -> Vec<NodeRecordV2>;

    // ── Neighbor Queries ─────────────────────────────────────
    pub fn get_outgoing_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2>;

    pub fn get_incoming_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2>;

    // ── Stats ────────────────────────────────────────────────
    pub fn node_count(&self) -> usize;
    pub fn edge_count(&self) -> usize;
    pub fn segment_count(&self) -> (usize, usize);  // (node_segments, edge_segments)
    pub fn write_buffer_size(&self) -> (usize, usize);  // (nodes, edges)
}
```

---

## 7. Manifest Integration

T2.2 uses ManifestStore but does NOT couple Shard to it. The integration pattern:

```rust
// Usage pattern (by caller, not inside Shard):
let mut shard = Shard::create(shard_path)?;
let mut manifest_store = ManifestStore::create(db_path)?;

// Add data
shard.add_nodes(nodes);
shard.add_edges(edges);

// Flush
let node_seg_id = manifest_store.next_segment_id();
let edge_seg_id = manifest_store.next_segment_id();
let flush_result = shard.flush_with_ids(Some(node_seg_id), Some(edge_seg_id))?;

// Update manifest
let node_desc = SegmentDescriptor::from_meta(
    node_seg_id, SegmentType::Nodes, Some(shard_id), flush_result.node_meta.unwrap()
);
let edge_desc = SegmentDescriptor::from_meta(
    edge_seg_id, SegmentType::Edges, Some(shard_id), flush_result.edge_meta.unwrap()
);
let manifest = manifest_store.create_manifest(
    vec![node_desc], vec![edge_desc], None
)?;
manifest_store.commit(manifest)?;
```

This keeps Shard simple and testable — no need to mock ManifestStore in Shard tests.

---

## 8. Implementation Phases

### Phase 1: WriteBuffer (~350 LOC, ~8 tests)

**New file:** `write_buffer.rs`

1. `WriteBuffer` struct with `HashMap<u128, NodeRecordV2>` + `Vec<EdgeRecordV2>`
2. Write operations: `add_node`, `add_nodes`, `add_edge`, `add_edges`
3. Read operations: `get_node`, `iter_nodes`, `iter_edges`
4. Query support: `find_nodes_by_type`, `find_nodes_by_file`, `find_edges_by_src`, `find_edges_by_dst`, `find_edges_by_type`
5. Drain operations: `drain_nodes`, `drain_edges`

**Tests:**
- Empty buffer returns no results
- Add/get node roundtrip
- Add/get edges
- Upsert (add same node ID twice, second wins)
- Query by type / file / src / dst
- Drain empties buffer
- Counts are accurate
- Multiple edge types between same src/dst

### Phase 2: Shard Core + Flush (~400 LOC, ~8 tests)

**New file:** `shard.rs`

1. `Shard` struct with write buffer + segment vectors
2. Constructors: `create`, `ephemeral`
3. Write operations: `add_nodes`, `add_edges`
4. Flush: write buffer -> segment writers -> segment files (or in-memory for ephemeral)
5. Load flushed segments into segment vectors

**Tests:**
- Create empty shard
- Add nodes + flush + verify segment exists
- Add edges + flush + verify
- Flush empty buffer = no-op (no empty segments)
- Multiple flushes create multiple segments
- Ephemeral shard flush works (in-memory)
- FlushResult contains correct metadata
- Segment file paths follow naming convention

### Phase 3: Point Lookup (~150 LOC, ~4 tests)

1. `get_node(id)` — write buffer check + bloom filter + segment scan
2. `node_exists(id)` — same algorithm, returns bool

**Tests:**
- Node in write buffer found
- Node in segment found (after flush)
- Node not found (bloom rejects)
- Node in both buffer and segment: buffer wins (latest data)

### Phase 4: Attribute Search (~150 LOC, ~4 tests)

1. `find_nodes(node_type, file)` — zone map pruning + columnar scan + merge

**Tests:**
- Find by type in write buffer
- Find by type in segment (after flush)
- Find by file with zone map pruning (segment without matching file skipped)
- Find across buffer + multiple segments, dedup by ID

### Phase 5: Neighbor Queries (~200 LOC, ~4 tests)

1. `get_outgoing_edges(node_id, edge_types)` — bloom on src + scan
2. `get_incoming_edges(node_id, edge_types)` — bloom on dst + scan

**Tests:**
- Outgoing edges from write buffer
- Outgoing edges from segment (after flush)
- Incoming edges with edge type filter
- Edges across buffer + multiple segments

### Phase 6: Equivalence + Integration Tests (~4 tests)

1. **Equivalence test:** Same data in v1-style HashMap vs v2 Shard -> identical query results
2. **Full CRUD:** add nodes -> query -> verify -> add edges -> neighbors -> verify
3. **Multiple segments:** flush twice -> both queryable
4. **Write buffer + segment:** unflushed + flushed -> both visible in queries

---

## 9. Test Strategy

### 9.1. Test Categories (~28 tests total)

| Category | Count | Focus |
|----------|-------|-------|
| WriteBuffer unit | 8 | Pure in-memory operations |
| Shard flush | 8 | Write buffer -> segment -> load |
| Point lookup | 4 | Bloom + scan + buffer merge |
| Attribute search | 4 | Zone map + columnar scan |
| Neighbor queries | 4 | Edge bloom + scan |
| Equivalence + integration | 4 | End-to-end correctness |

### 9.2. Test Data Strategy

Use existing `make_node` / `make_edge` helpers from segment tests. Extend with:

```rust
fn make_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2;
fn make_edge(src_id: &str, dst_id: &str, edge_type: &str) -> EdgeRecordV2;
```

### 9.3. Equivalence Testing Approach

Build a simple HashMap-based reference implementation:

```rust
struct ReferenceStore {
    nodes: HashMap<u128, NodeRecordV2>,
    edges: Vec<EdgeRecordV2>,
}
```

Feed same data to both ReferenceStore and Shard. Compare all query results. This catches any merge/dedup/ordering bugs.

### 9.4. Benchmark Approach (Validation)

Simple timing comparison, not a full benchmark framework:

```rust
#[test]
fn bench_point_lookup_vs_hashmap() {
    let n = 10_000;
    // Build both stores with same data
    // Time 1000 random lookups on each
    // Assert shard_time < 2 * hashmap_time
}
```

Must be within 2x of v1 HashMap performance for L0. This is achievable because:
- Write buffer uses HashMap (same as v1 for unflushed data)
- Segment bloom filter rejects non-matching segments in O(1)
- Columnar ID scan is cache-friendly (sequential memory access)

---

## 10. LOC Estimate

| Component | Estimated LOC |
|-----------|---------------|
| `write_buffer.rs` (struct + impl + tests) | ~350 |
| `shard.rs` (struct + constructors + flush) | ~400 |
| `shard.rs` (point lookup + attribute search) | ~300 |
| `shard.rs` (neighbor queries + stats) | ~200 |
| `shard.rs` (tests — all phases) | ~600 |
| `mod.rs` update | ~5 |
| **Total** | **~1855** |

Fits within ~2000 LOC budget.

---

## 11. Risks & Mitigations

### 11.1. Read Amplification (Multiple L0 Segments)

**Risk:** After many flushes without compaction, point lookup scans many segments.

**Mitigation:** Bloom filters. With 1% FPR and 10 segments, expected false positive scans = 0.1 per lookup. Acceptable for L0.

**Future:** Compaction (separate task) reduces to 1-2 segments.

### 11.2. Deduplication in Attribute Search

**Risk:** Same node ID in write buffer + segment. Must not appear twice in results.

**Mitigation:** Collect IDs in a `HashSet<u128>` during scan. Write buffer scanned first (its data is authoritative). Skip segment records whose ID is already in the set.

### 11.3. Segment Ordering

**Risk:** Which segment's version of a node is "correct" when the same ID appears in multiple segments?

**Mitigation:** Segments ordered by creation time (newest last in the vector, matching append order). Scan newest-to-oldest, first match wins. Write buffer always wins over all segments.

### 11.4. Empty Flush

**Risk:** Flushing an empty write buffer creates empty segment files.

**Mitigation:** `flush()` checks `write_buffer.is_empty()` and returns early with `FlushResult { node_meta: None, edge_meta: None }`. No empty segments ever written.

---

## 12. What T2.2 Does NOT Do

These are explicitly out of scope:

1. **No compaction** — L0 segments accumulate. Compaction is a separate task.
2. **No tombstones** — Delete operations not supported in T2.2. Append-only.
3. **No multi-shard coordination** — Single shard only. Database layer (T3.x) manages multiple shards.
4. **No WAL** — Re-analysis is recovery. Per architecture doc.
5. **No concurrent access** — Single-writer, single-reader. Thread safety is a T3.x concern.
6. **No adjacency index** — Neighbor queries use linear scan + bloom. Adjacency index comes with compaction (L1+).
7. **No inverted index** — Attribute search uses columnar scan + zone map. Inverted index comes with compaction (L1+).

---

## 13. Open Questions for Review

1. **Should `flush()` take segment IDs or generate them internally?** I prefer explicit IDs from ManifestStore (keeps naming consistent, avoids file renames). Alternative: Shard generates local names, caller maps to global IDs.

2. **Should Shard own its shard_id?** For T2.2, shard_id is always `None` (single shard). But the struct should have a field for it to prepare for T3.x. I'll add `shard_id: Option<u16>` but not use it in query logic yet.

3. **Edge deduplication in write buffer?** v1 has `edge_keys: HashSet<(u128, u128, String)>` for dedup. Should WriteBuffer also enforce this? **Recommendation: Yes**, add edge dedup to WriteBuffer. It's cheap (HashSet insert) and prevents duplicate edges that would require cleanup later.
