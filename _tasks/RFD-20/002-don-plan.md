# RFD-20: Background Compaction System - Design Plan

**Author:** Don Melton (Tech Lead)  
**Date:** 2026-02-15  
**Status:** Design Review  

---

## Executive Summary

Design for LSM-style background compaction in RFDB v2: merge unsorted L0 segments → sorted, deduplicated L1 segments with inverted indexes and global node index. Based on RocksDB's tiered+leveled hybrid and Cloudflare's mmap-sync blue/green pattern.

**Key decisions:**
- **Compaction policy:** Size-tiered for L0 (4+ segments trigger), leveled for L1
- **Inverted indexes:** Built during compaction, stored as separate mmap files
- **Global index:** Sorted (node_id, shard, segment, offset) array, binary search
- **Blue/green swap:** Build in `.tmp/`, atomic rename, mmap handles keep old files alive
- **GC safety:** Move old segments to `gc/`, periodic cleanup checks `lsof` (no active mmaps)

**Target performance:** 5-10x query speedup post-compaction (measured via benchmarks).

---

## 1. Prior Art Research

### 1.1 LSM Compaction Strategies

**Sources consulted:**
- [LSM Compaction Mechanisms - Alibaba Cloud](https://www.alibabacloud.com/blog/an-in-depth-discussion-on-the-lsm-compaction-mechanism_596780)
- [LSM Design Space - VLDB](https://vldb.org/pvldb/vol14/p2216-sarkar.pdf)
- [RocksDB Compaction Wiki](https://github.com/facebook/rocksdb/wiki/Compaction)
- [LSM Strategies - Medium](https://medium.com/@rastogi.shivank16/lsm-tree-database-compaction-strategies-when-to-use-size-tiered-leveled-or-time-windowed-f40b5f839e3c)

**Key findings:**
1. **Size-tiered vs Leveled:**
   - Size-tiered: Each level accumulates T runs before merge. Lower write amplification (WA), higher read amplification (RA).
   - Leveled: Each level has ≤1 run. T× higher WA, but T× lower RA.
   - Hybrid (RocksDB): Tiered for L0, leveled for L1+. Best of both.

2. **Tiered+Leveled Hybrid:** Lower WA than pure leveled, lower space amp than pure tiered.

3. **Compaction Trigger:** Segment count threshold (simple), size-based (more complex), or time-windowed (for time-series).

**Decision for RFDB:**
- **L0:** Size-tiered (unsorted segments, append-only write path)
- **L1:** Leveled (single sorted run per shard, inverted indexes)
- **Trigger:** Segment count ≥ 4 per shard (configurable)

**Rationale:** RFDB write path is infrequent (analysis runs, not transactional). Optimizing for read latency > write throughput. Leveled L1 enables sorted scans and inverted indexes.

---

### 1.2 Inverted Index in LSM Systems

**Sources:**
- [ScyllaDB Leveled Compaction](https://www.scylladb.com/2018/01/31/compaction-series-leveled-compaction/)
- [Deep Dive LSM - Medium](https://medium.com/@aqilzeka99/deep-dive-lsm-tree-internals-of-cassandra-leveldb-rocksdb-scylladb-2c4149db8d92)

**Key findings:**
1. LevelDB/RocksDB do NOT build inverted indexes (they're key-value stores). Indexes are application-layer (e.g., via prefix scanning).
2. ScyllaDB (Cassandra fork) builds secondary indexes separately, NOT during compaction.

**Decision for RFDB:**
- Build inverted indexes **during compaction** (when data is already being read/written).
- Indexes are **separate mmap files** (not embedded in segments), so they can be rebuilt without rewriting data.

**Index types:**
1. `by_type/{node_type}.idx` → sorted list of (node_id, shard, segment, offset)
2. `by_name/{name_hash}.idx` → sorted list of (node_id, shard, segment, offset)
3. `by_file/{file_hash}.idx` → sorted list of (node_id, shard, segment, offset)

**Format:** Each index is a flat array of `IndexEntry { node_id: u128, shard: u16, segment: u64, offset: u32 }` (26 bytes packed). Binary search for queries.

---

### 1.3 Blue/Green Swap with Concurrent Readers

**Sources:**
- [Cloudflare mmap-sync](https://github.com/cloudflare/mmap-sync)
- [Linux mmap safety](https://man7.org/linux/man-pages/man2/mmap.2.html)
- [RCU pattern](https://lwn.net/Articles/906852/)

**Key findings:**
1. **mmap semantics:** File handle keeps pages alive even after `unlink()`. New readers see old version until all old mmaps close.
2. **Cloudflare pattern:** Write to blue/green copies, swap atomic pointer (via atomic rename), wait for readers to drain.
3. **No reference counting needed:** UNIX semantics provide implicit refcount (mmap keeps file alive).

**Decision for RFDB:**
1. **Build phase:** Write new segments to `.tmp/compaction_NNNN/`
2. **Swap phase:** Atomic rename to final paths
3. **GC phase:** Move old segments to `gc/`, delete when no active mmaps (check via `lsof`)

**Concurrency model:**
- Single-threaded storage layer (no internal locks needed)
- Compaction runs in background thread (communicates via message passing)
- Query threads hold mmap references (implicit refcount)

---

### 1.4 Tombstone Filtering and GC Safety

**Sources:**
- [Cassandra Tombstones](https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html)
- [Yugabyte Tombstone Performance](https://www.yugabyte.com/blog/keep-tombstones-data-markers-slowing-scan-performance/)
- [LSM Compaction GC](https://www.alibabacloud.com/blog/an-in-depth-discussion-on-the-lsm-compaction-mechanism_596780)

**Key findings:**
1. **Tombstone removal:** Only safe when reaching last level AND all queries that might reference the key have completed.
2. **GC condition:** Tombstone is "old enough" (snapshot-based TTL or explicit flush).

**Decision for RFDB:**
- **L0 → L1 compaction:** Remove tombstones AND their corresponding records (physical deletion).
- **Safety:** Tombstones are flushed to manifest BEFORE compaction. Compaction reads from manifest, applies filters.
- **No TTL needed:** Single-version storage (no MVCC), tombstones cleared immediately on compaction.

---

## 2. Compaction System Design

### 2.1 Storage Tiers

**L0 (Unsorted, Write-Optimized):**
- Segments written by `flush()` (append-only, unsorted)
- Bloom filters + zone maps for pruning
- Query scans all L0 segments newest-first (dedup by ID)

**L1 (Sorted, Read-Optimized):**
- One sorted segment per shard (or multiple for large datasets, but single-run)
- Records sorted by node_id (enables binary search)
- Inverted indexes (by_type, by_name, by_file) for attribute queries
- Global index (node_id → shard, segment, offset) for point lookups
- Tombstones physically removed

**Compaction:** L0 segments → L1 sorted segment (k-way merge with dedup and tombstone filtering).

---

### 2.2 Trigger Policy

**Per-shard trigger:**
```rust
fn should_compact(shard: &Shard) -> bool {
    let (node_seg_count, edge_seg_count) = shard.segment_count();
    let threshold = config.compaction_threshold; // default: 4
    node_seg_count >= threshold || edge_seg_count >= threshold
}
```

**Global coordinator:**
- Background thread polls all shards every 60 seconds (configurable)
- Compacts shards independently (no cross-shard coordination)
- Skips compaction if another is in progress (simple mutex)

**Future:** Size-based trigger (compact when L0 total size > 100MB), or time-based (nightly).

---

### 2.3 Merge Algorithm (k-way merge with dedup)

**Input:** N unsorted L0 segments (per shard)  
**Output:** 1 sorted L1 segment

**Algorithm:**
```rust
// Step 1: Collect all records from L0 segments
let mut records: HashMap<u128, NodeRecordV2> = HashMap::new();
for seg in l0_segments {
    for record in seg.iter() {
        // Dedup: newer segment wins (segments ordered newest-first)
        records.entry(record.id).or_insert(record);
    }
}

// Step 2: Filter tombstones (from manifest)
let tombstones = manifest.tombstoned_node_ids;
records.retain(|id, _| !tombstones.contains(id));

// Step 3: Sort by node_id
let mut sorted: Vec<_> = records.into_values().collect();
sorted.sort_by_key(|r| r.id);

// Step 4: Write L1 segment
let mut writer = NodeSegmentWriter::new();
for record in sorted {
    writer.add(record);
}
writer.finish(&mut file)?;
```

**Complexity:**
- Time: O(N log N) where N = total records in L0
- Space: O(N) (all records in memory)
- For 1M nodes (~200 bytes each) → 200MB RAM (acceptable)

**Future optimization:** External sort for datasets > 10M nodes.

---

### 2.4 Inverted Index Design

**Index types:**
1. **by_type:** node_type → sorted list of node_ids
2. **by_name:** name → sorted list of node_ids (hash-based sharding for large cardinality)
3. **by_file:** file_path → sorted list of node_ids

**File format:**
```rust
// <db_path>/indexes/by_type/{node_type}.idx
// Binary format: [IndexEntry; N]
#[repr(C, packed)]
struct IndexEntry {
    node_id: u128,      // 16 bytes
    shard: u16,         // 2 bytes
    segment: u64,       // 8 bytes
    offset: u32,        // 4 bytes
} // 30 bytes total

// File layout:
// [Header: magic + version + entry_count]
// [Entries: sorted by node_id]
```

**Build during compaction:**
```rust
// After sorting records by node_id:
let mut by_type: HashMap<String, Vec<IndexEntry>> = HashMap::new();
let mut by_file: HashMap<String, Vec<IndexEntry>> = HashMap::new();

for (offset, record) in sorted_records.iter().enumerate() {
    let entry = IndexEntry {
        node_id: record.id,
        shard: shard_id,
        segment: l1_segment_id,
        offset: offset as u32,
    };
    by_type.entry(record.node_type.clone()).or_default().push(entry);
    by_file.entry(record.file.clone()).or_default().push(entry);
}

// Write each index to disk
for (node_type, entries) in by_type {
    let path = db_path.join(format!("indexes/by_type/{}.idx", node_type));
    write_index(&path, &entries)?;
}
```

**Query usage:**
```rust
// Old (scan all segments):
fn find_nodes(&self, node_type: Option<&str>) -> Vec<NodeRecordV2> {
    // Scan all segments, apply zone maps, bloom filters, then columnar scan
}

// New (use inverted index):
fn find_nodes_indexed(&self, node_type: &str) -> Vec<NodeRecordV2> {
    let index = load_index(&format!("indexes/by_type/{}.idx", node_type))?;
    let mut results = Vec::new();
    for entry in index.entries {
        let shard = &self.shards[entry.shard as usize];
        let segment = &shard.l1_segment; // L1 is sorted
        let record = segment.get_record(entry.offset as usize);
        results.push(record);
    }
    results
}
```

**Expected speedup:** 10-100x for attribute queries (index lookup vs full scan).

---

### 2.5 Global Index Design

**Purpose:** O(log N) point lookup instead of O(S) fan-out (S = shard count).

**Format:**
```rust
// <db_path>/indexes/global.idx
// Sorted array of (node_id, location)
#[repr(C, packed)]
struct GlobalIndexEntry {
    node_id: u128,      // 16 bytes
    shard: u16,         // 2 bytes
    segment: u64,       // 8 bytes
    offset: u32,        // 4 bytes
} // 30 bytes total

// File layout:
// [Header: magic + version + entry_count]
// [Entries: sorted by node_id]
```

**Build during compaction:**
```rust
// After compacting all shards, merge all L1 segment entries:
let mut global_entries = Vec::new();
for (shard_id, l1_seg) in all_l1_segments {
    for (offset, record) in l1_seg.iter().enumerate() {
        global_entries.push(GlobalIndexEntry {
            node_id: record.id,
            shard: shard_id,
            segment: l1_seg.id,
            offset: offset as u32,
        });
    }
}
global_entries.sort_by_key(|e| e.node_id);
write_global_index(&global_entries)?;
```

**Query usage:**
```rust
// Old (fan-out to all shards):
fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
    for shard in &self.shards {
        if let Some(node) = shard.get_node(id) {
            return Some(node);
        }
    }
    None
}

// New (binary search global index):
fn get_node_indexed(&self, id: u128) -> Option<NodeRecordV2> {
    let entry = global_index.binary_search(id)?;
    let shard = &self.shards[entry.shard as usize];
    let segment = &shard.l1_segment;
    Some(segment.get_record(entry.offset as usize))
}
```

**Expected speedup:** 4x for point lookups (log₂N vs S shards).

---

### 2.6 Blue/Green Swap Mechanism

**Build phase:**
```rust
// 1. Create temp directory
let tmp_dir = db_path.join(format!(".tmp/compaction_{}", timestamp));
fs::create_dir_all(&tmp_dir)?;

// 2. Write new L1 segment to tmp
let l1_path_tmp = tmp_dir.join(format!("seg_{:06}_nodes.seg", new_seg_id));
let mut writer = NodeSegmentWriter::new();
for record in sorted_records {
    writer.add(record);
}
writer.finish(&mut File::create(&l1_path_tmp)?)?;

// 3. Build indexes in tmp
build_inverted_indexes(&tmp_dir, &sorted_records)?;
build_global_index(&tmp_dir, &all_shards)?;
```

**Swap phase (atomic):**
```rust
// 4. Atomic rename (moves file to final location, old readers still see old mmap)
let l1_path_final = db_path.join(format!("segments/{:02}/seg_{:06}_nodes.seg", shard_id, new_seg_id));
fs::rename(&l1_path_tmp, &l1_path_final)?;

// 5. Update manifest (atomic commit via current.json rename)
let new_manifest = manifest_store.create_manifest(
    vec![new_l1_descriptor], // L1 replaces all L0
    vec![],
    None,
)?;
manifest_store.commit(new_manifest)?;

// 6. Reload shard (new mmap references new file)
shard.reload_segments(&new_manifest.node_segments)?;
```

**Concurrent query safety:**
- Old queries hold mmap to old segments (files stay alive via kernel refcount)
- New queries mmap new segments
- No torn reads (atomic pointer swap via manifest + current.json rename)

---

### 2.7 GC Strategy

**Move to gc/ (immediate):**
```rust
// After swap, move old L0 segments to gc/
for old_seg in old_l0_segments {
    let gc_path = db_path.join(format!("gc/seg_{:06}_nodes.seg", old_seg.id));
    fs::rename(&old_seg.path, &gc_path)?;
}
```

**Periodic cleanup (every 5 minutes):**
```rust
fn gc_collect(db_path: &Path) -> Result<usize> {
    let gc_dir = db_path.join("gc");
    let mut deleted = 0;

    for entry in fs::read_dir(&gc_dir)? {
        let path = entry?.path();
        
        // Check if file is open by any process (via lsof)
        let output = Command::new("lsof")
            .arg(&path)
            .output()?;
        
        if output.stdout.is_empty() {
            // No active mmaps → safe to delete
            fs::remove_file(&path)?;
            deleted += 1;
        }
    }
    
    Ok(deleted)
}
```

**Future:** Replace `lsof` with Rust-native solution (track mmap references in-process, or use `Arc<Mmap>` refcounting).

---

## 3. Integration with Existing System

### 3.1 Manifest Changes

**New fields in `Manifest`:**
```rust
pub struct Manifest {
    // ... existing fields ...
    
    /// L1 segment per shard (None if not compacted yet)
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub l1_segments: HashMap<u16, SegmentDescriptor>,
    
    /// Compaction metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction_info: Option<CompactionInfo>,
}

pub struct CompactionInfo {
    pub last_compaction_version: u64,
    pub last_compaction_timestamp: u64,
    pub l0_segments_compacted: u32,
    pub l1_segments_created: u32,
}
```

**Backwards compatibility:** Old manifests deserialize with `l1_segments: HashMap::new()`, `compaction_info: None`.

---

### 3.2 Shard Changes

**New field:**
```rust
pub struct Shard {
    // ... existing fields ...
    
    /// L1 segment (sorted, deduplicated, indexed). None if not compacted.
    l1_segment: Option<NodeSegmentV2>,
    l1_descriptor: Option<SegmentDescriptor>,
}
```

**Query path changes:**
```rust
// Old: scan all L0 segments
pub fn find_nodes(&self, node_type: Option<&str>) -> Vec<NodeRecordV2> {
    // 1. Scan write buffer
    // 2. Scan all L0 segments newest-first
}

// New: check L1 first, fallback to L0
pub fn find_nodes(&self, node_type: Option<&str>) -> Vec<NodeRecordV2> {
    // 1. Scan write buffer (always authoritative)
    
    // 2. If L1 exists AND has inverted index → use index
    if let Some(l1) = &self.l1_segment {
        if let Some(index) = try_load_inverted_index(node_type) {
            return query_via_index(index);
        }
    }
    
    // 3. Fallback: scan L1 + L0 segments
    // L1 is sorted → can use binary search for point lookups
    // L0 still needs full scan
}
```

---

### 3.3 MultiShardStore Changes

**New methods:**
```rust
impl MultiShardStore {
    /// Trigger background compaction for all shards above threshold
    pub fn trigger_compaction(&mut self, manifest_store: &mut ManifestStore) -> Result<CompactionResult> {
        let mut compacted_shards = Vec::new();
        
        for (shard_id, shard) in self.shards.iter_mut().enumerate() {
            if should_compact(shard) {
                compact_shard(shard, shard_id as u16, manifest_store)?;
                compacted_shards.push(shard_id as u16);
            }
        }
        
        // Rebuild global index (all shards)
        if !compacted_shards.is_empty() {
            rebuild_global_index(&self.shards, manifest_store)?;
        }
        
        Ok(CompactionResult { compacted_shards })
    }
}
```

---

## 4. Validation Strategy

### 4.1 Query Equivalence Testing

**Before compaction:**
```rust
let results_before = shard.find_nodes(Some("FUNCTION"), None);
```

**After compaction:**
```rust
let results_after = shard.find_nodes(Some("FUNCTION"), None);
assert_eq!(results_before, results_after);
```

**Test coverage:**
- Point lookups (get_node)
- Attribute queries (find_nodes by type/file)
- Edge queries (get_outgoing_edges, get_incoming_edges)
- Tombstone filtering (deleted nodes should NOT appear)

**Property tests (proptest):**
- Generate random insertions + deletions + queries
- Compact after each batch
- Verify query results match reference HashMap

---

### 4.2 Inverted Index Validation

**Post-compaction check:**
```rust
// For each index entry, verify it points to correct record
for (node_type, index_path) in inverted_indexes {
    let index = load_index(&index_path)?;
    for entry in index.entries {
        let shard = &shards[entry.shard as usize];
        let segment = &shard.l1_segment.unwrap();
        let record = segment.get_record(entry.offset as usize);
        
        assert_eq!(record.id, entry.node_id);
        assert_eq!(record.node_type, node_type);
    }
}
```

**Equivalence check:**
```rust
// Index query should match scan query
let via_scan = shard.find_nodes(Some("FUNCTION"), None);
let via_index = shard.find_nodes_indexed("FUNCTION");
assert_eq!(via_scan, via_index);
```

---

### 4.3 Global Index Validation

**Post-compaction check:**
```rust
// Every node in L1 should be in global index
let global_index = load_global_index(&db_path)?;
for shard in &shards {
    if let Some(l1) = &shard.l1_segment {
        for record in l1.iter() {
            let entry = global_index.binary_search(record.id).unwrap();
            assert_eq!(entry.shard, shard.id);
            assert_eq!(entry.segment, l1.id);
        }
    }
}
```

---

### 4.4 Concurrent Safety Testing

**Test plan:**
```rust
// Start background compaction
let compaction_handle = thread::spawn(move || {
    multi_shard.trigger_compaction(&mut manifest_store).unwrap();
});

// Run concurrent queries (10 threads × 1000 queries each)
let query_handles: Vec<_> = (0..10).map(|_| {
    thread::spawn(move || {
        for _ in 0..1000 {
            let node = multi_shard.get_node(random_id());
            // Verify node is valid (no torn reads)
        }
    })
}).collect();

// Wait for compaction + queries to complete
compaction_handle.join().unwrap();
for h in query_handles { h.join().unwrap(); }
```

---

### 4.5 Benchmark Suite

**Pre-compaction baseline:**
```rust
// 1M nodes across 4 shards (250k each), 100 L0 segments per shard
let pre_compact = Instant::now();
for _ in 0..10_000 {
    shard.find_nodes(Some("FUNCTION"), None);
}
let pre_latency = pre_compact.elapsed() / 10_000;
```

**Post-compaction measurement:**
```rust
multi_shard.trigger_compaction(&mut manifest_store)?;

let post_compact = Instant::now();
for _ in 0..10_000 {
    shard.find_nodes(Some("FUNCTION"), None);
}
let post_latency = post_compact.elapsed() / 10_000;

let speedup = pre_latency.as_micros() / post_latency.as_micros();
assert!(speedup >= 5); // Target: 5-10x improvement
```

**Metrics to track:**
- Point lookup latency (p50, p95, p99)
- Attribute query latency
- Edge query latency
- Compaction duration (wall time)
- Compaction I/O (bytes read/written)
- Space amplification (disk usage before/after)

---

## 5. Implementation Plan

### Phase 1: Core Compaction (5 days)
**Goal:** L0 → L1 merge without indexes.

**Subtasks:**
1. **Compaction coordinator** (1 day, 150 LOC)
   - Background thread polling shards
   - Trigger policy (segment count threshold)
   - File: `packages/rfdb-server/src/storage_v2/compaction/coordinator.rs`

2. **k-way merge algorithm** (2 days, 300 LOC)
   - Collect records from L0 segments
   - Dedup by node_id (HashMap)
   - Filter tombstones (from manifest)
   - Sort by node_id
   - File: `packages/rfdb-server/src/storage_v2/compaction/merge.rs`

3. **L1 segment writer** (1 day, 100 LOC)
   - Reuse `NodeSegmentWriter`, but sort records first
   - Write to `.tmp/compaction_NNNN/`
   - File: `packages/rfdb-server/src/storage_v2/compaction/writer.rs`

4. **Blue/green swap** (1 day, 150 LOC)
   - Atomic rename `.tmp/` → `segments/`
   - Update manifest (new L1 descriptor, remove old L0)
   - Reload shard (new mmap)
   - File: `packages/rfdb-server/src/storage_v2/compaction/swap.rs`

**Dependencies:** None (uses existing Shard, ManifestStore APIs).

**Tests:**
- Unit: k-way merge correctness
- Integration: compact ephemeral shard, verify query equivalence
- Benchmark: pre/post latency for find_nodes

**Deliverable:** Compaction works, but no indexes yet (still O(N) scan on L1).

---

### Phase 2: Inverted Indexes (3 days)
**Goal:** Build by_type, by_file indexes during compaction.

**Subtasks:**
1. **Index file format** (1 day, 200 LOC)
   - `IndexEntry` struct (node_id, shard, segment, offset)
   - Serialize/deserialize (binary format)
   - Write to `indexes/by_type/{node_type}.idx`
   - File: `packages/rfdb-server/src/storage_v2/index/format.rs`

2. **Index builder** (1 day, 150 LOC)
   - Build during compaction (after sorting)
   - Write indexes to `.tmp/`, rename with segment
   - File: `packages/rfdb-server/src/storage_v2/index/builder.rs`

3. **Index loader + query path** (1 day, 200 LOC)
   - Load index on shard open (mmap)
   - `find_nodes_indexed()` method (binary search index)
   - File: `packages/rfdb-server/src/storage_v2/index/query.rs`

**Dependencies:** Phase 1 (compaction must work first).

**Tests:**
- Unit: index serialization roundtrip
- Integration: build index during compaction, verify via query
- Validation: index query = scan query (equivalence)
- Benchmark: indexed query vs scan (expect 10-100x speedup)

**Deliverable:** Attribute queries use inverted indexes.

---

### Phase 3: Global Index (2 days)
**Goal:** O(log N) point lookups via global index.

**Subtasks:**
1. **Global index builder** (1 day, 150 LOC)
   - Merge all L1 segments' entries
   - Sort by node_id
   - Write to `indexes/global.idx`
   - File: `packages/rfdb-server/src/storage_v2/index/global.rs`

2. **Query path integration** (1 day, 100 LOC)
   - `get_node_indexed()` (binary search global index)
   - Fallback to fan-out if index missing
   - File: `packages/rfdb-server/src/storage_v2/multi_shard.rs` (modify existing)

**Dependencies:** Phase 2 (index infrastructure).

**Tests:**
- Unit: global index build + binary search
- Integration: point lookup via global index
- Validation: every L1 node is in global index
- Benchmark: indexed vs fan-out (expect 4x speedup for 4 shards)

**Deliverable:** Point lookups use global index.

---

### Phase 4: GC Safety (2 days)
**Goal:** Safe deletion of old segments.

**Subtasks:**
1. **Move to gc/** (0.5 days, 50 LOC)
   - After swap, `fs::rename()` old segments to `gc/`
   - File: `packages/rfdb-server/src/storage_v2/compaction/gc.rs`

2. **Periodic GC cleanup** (1 day, 150 LOC)
   - Background task (every 5 minutes)
   - Check `lsof` for active mmaps
   - Delete if no references
   - File: `packages/rfdb-server/src/storage_v2/compaction/gc.rs`

3. **GC stats + logging** (0.5 days, 50 LOC)
   - Track: bytes freed, files deleted, failed deletions
   - Log warnings if GC dir grows > 1GB

**Dependencies:** Phase 1 (swap mechanism).

**Tests:**
- Integration: compact, verify old segments moved to gc/
- Concurrent: query during GC, ensure no panics
- Manual: verify `lsof` check works

**Deliverable:** Old segments safely deleted after compaction.

---

### Phase 5: Validation + Benchmarks (1 day)
**Goal:** End-to-end testing + performance validation.

**Subtasks:**
1. **Query equivalence tests** (0.5 days)
   - All query types (point, attribute, edge)
   - Pre/post compaction equivalence
   - Tombstone filtering correctness

2. **Benchmark suite** (0.5 days)
   - Measure: point lookup, attribute query, edge query
   - Compare: pre-compaction vs post-compaction
   - Verify: 5-10x speedup target met

**Deliverable:** Documented performance improvements.

---

### Phase 6: Documentation + CLI (1 day)
**Goal:** User-facing compaction control.

**Subtasks:**
1. **CLI command** (0.5 days, 100 LOC)
   - `rfdb-cli compact <db_path>`
   - Option: `--threshold <N>` (segment count trigger)
   - File: `packages/rfdb-server/src/cli/compact.rs`

2. **Documentation** (0.5 days)
   - Update `_readme/rfdb-v2-architecture.md`
   - Add "Compaction" section with diagrams
   - Document manual vs automatic compaction

**Deliverable:** Users can trigger compaction via CLI.

---

## 6. Risks and Mitigations

### Risk 1: Memory usage during compaction
**Scenario:** Compacting 10M nodes → 2GB RAM (all records in memory).

**Mitigation:**
- **Short-term:** Document limit (recommend max 5M nodes per shard).
- **Long-term (post-v0.2):** External sort (spill to disk if > 1GB).

**Detection:** Track peak memory during compaction (log warnings).

---

### Risk 2: Index rebuild cost
**Scenario:** Compacting 4 shards × 1M nodes → 4s to rebuild global index.

**Mitigation:**
- **Incremental updates:** Only rebuild indexes for compacted shards.
- **Lazy loading:** Load indexes on first query (not on shard open).

**Benchmark:** Measure index build time, set target < 1s per shard.

---

### Risk 3: Concurrent compaction + flush
**Scenario:** Background compaction starts, then user calls `flush()`.

**Mitigation:**
- **Mutex guard:** `compaction_in_progress: Arc<Mutex<bool>>`
- **Flush waits:** If compaction running, flush queues until compaction completes.
- **Compaction waits:** If flush in progress, compaction delays start.

**Test:** Spawn compaction thread, trigger flush, verify no deadlock.

---

### Risk 4: lsof dependency for GC
**Scenario:** `lsof` not installed, or slow on large `/proc`.

**Mitigation:**
- **Fallback:** If `lsof` fails, delay GC (retry next cycle).
- **Future:** Replace with Rust-native solution (track `Arc<Mmap>` refcounts).

**Detection:** Log warnings if `lsof` fails.

---

### Risk 5: Disk space during compaction
**Scenario:** Building L1 requires 2× disk space (old L0 + new L1).

**Mitigation:**
- **Pre-flight check:** Estimate L1 size, abort if < 2× free space.
- **Progressive GC:** Delete old segments immediately after swap (don't wait for periodic GC).

**Detection:** Log disk usage before/after compaction.

---

## 7. Success Metrics

**Performance targets:**
- Point lookup: 5-10x faster (via global index)
- Attribute query: 10-100x faster (via inverted indexes)
- Edge query: 2-5x faster (sorted L1 enables better pruning)

**Resource targets:**
- Compaction time: < 10s for 1M nodes
- Memory usage: < 500MB for 1M nodes (2× safety margin)
- Disk usage: < 2× during compaction (temporary spike)

**Reliability targets:**
- Zero query failures during concurrent compaction
- Zero data loss (validation tests must pass)
- GC must not delete active segments (no panics)

---

## 8. Future Work (Post-RFD-20)

### 8.1 Incremental Compaction
**Problem:** Compacting 10M nodes takes 30s, blocks writes.

**Solution:** Incremental compaction (compact 1M nodes at a time, merge results).

**Complexity:** Medium (requires partial index updates).

---

### 8.2 External Sort
**Problem:** 10M nodes × 200 bytes = 2GB RAM.

**Solution:** Spill to disk when memory > 1GB, use external merge sort.

**Complexity:** High (requires temp file management).

---

### 8.3 Multi-Level Compaction (L0 → L1 → L2)
**Problem:** L1 grows to 100M nodes, queries slow again.

**Solution:** Add L2 tier (10× size ratio), compact L1 → L2.

**Complexity:** High (requires leveled compaction scheduler).

---

### 8.4 Parallel Compaction
**Problem:** Compacting 4 shards serially takes 4× time.

**Solution:** Compact shards in parallel (Rayon threadpool).

**Complexity:** Medium (requires careful manifest coordination).

---

## Critical Files for Implementation

Based on exploration of the current codebase, these are the most critical files for implementing compaction:

1. **`/Users/vadim/grafema-worker-14/packages/rfdb-server/src/storage_v2/shard.rs`** (1908 LOC)
   - **Reason:** Contains Shard struct and query methods. Compaction must integrate with existing flush/query paths. Will add `l1_segment` field and modify query logic.

2. **`/Users/vadim/grafema-worker-14/packages/rfdb-server/src/storage_v2/manifest.rs`** (500+ LOC)
   - **Reason:** Defines Manifest and SegmentDescriptor. Must add `l1_segments` and `CompactionInfo` fields. Compaction commits new manifests via ManifestStore.

3. **`/Users/vadim/grafema-worker-14/packages/rfdb-server/src/storage_v2/multi_shard.rs`** (400+ LOC)
   - **Reason:** Wraps multiple shards. Compaction coordinator will call `MultiShardStore::trigger_compaction()`. Global index builder needs access to all shards.

4. **`/Users/vadim/grafema-worker-14/packages/rfdb-server/src/storage_v2/segment.rs`** (1026 LOC)
   - **Reason:** NodeSegmentV2 and EdgeSegmentV2 readers. Compaction reads from L0 segments, writes L1 segments. Iterator API used for k-way merge.

5. **`/Users/vadim/grafema-worker-14/packages/rfdb-server/src/storage_v2/writer.rs`** (300+ LOC)
   - **Reason:** NodeSegmentWriter creates segment files. Compaction reuses this to write sorted L1 segments. Understanding existing write path critical for correctness.

**New files to create:**
- `packages/rfdb-server/src/storage_v2/compaction/mod.rs` (coordinator, merge, swap)
- `packages/rfdb-server/src/storage_v2/index/mod.rs` (inverted index, global index)
- `packages/rfdb-server/src/storage_v2/compaction/gc.rs` (garbage collection)

---

**END OF PLAN**

