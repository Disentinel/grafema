# RFD-20: Background Compaction — Technical Specification

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2026-02-15
**Based on:** Don's design plan (002-don-plan.md)

---

## Critical Design Decisions

### 1. Edge Compaction (Don's plan omitted this)

Edge segments use different dedup key: `(src, dst, edge_type)` not just ID.

```rust
// Node dedup: by node_id (u128)
HashMap<u128, NodeRecordV2>

// Edge dedup: by composite key
HashMap<(u128, u128, String), EdgeRecordV2>  // (src, dst, edge_type)
```

Edge segments sorted by `(src, dst)` tuple for range queries on outgoing edges.

### 2. L1 Format: Same as L0 (reuse existing readers/writers)

**Decision:** L1 uses identical binary format to L0 segments.

**Rationale:**
- Reuses NodeSegmentWriter/EdgeSegmentWriter (0 new writer code)
- Reuses NodeSegmentV2/EdgeSegmentV2 readers (0 new reader code)
- Saves ~400-500 LOC vs new format
- Records are sorted in L1, but linear scan still used (bloom + zone map prune)
- Future: SortedNodeSegmentV2 with binary search (separate task)

### 3. Synchronous Compaction (no background thread)

**Decision:** Compaction triggered by explicit command, runs synchronously.

**Rationale:**
- RFDB is single-threaded — no internal locking infrastructure
- Adding background thread = significant complexity (Arc, Mutex, channel)
- Compaction < 10s for realistic workloads — acceptable blocking
- Future: async compaction in RFD-22

### 4. Index Invalidation Strategy

Two-tier query path after compaction:
1. **L0 segments** (unflushed + post-compaction flushes) — always scanned
2. **L1 segment** (compacted) — queried via inverted index or scan

New L0 segments after compaction coexist with L1 until next compaction.

### 5. GC: Immediate Deletion (no lsof)

**Decision:** Drop old mmaps synchronously during swap, delete files immediately.

**Rationale:**
- Single-threaded model: no concurrent readers
- When shard reloads segments, old NodeSegmentV2/EdgeSegmentV2 are dropped
- Mmap dropped = kernel releases file reference
- No gc/ directory, no lsof, no periodic cleanup
- Simpler, more portable, zero external dependencies

**Fallback safety:** If delete fails (EBUSY on some OSes), move to gc/ and retry on next startup.

### 6. Index File Format

Single file per index type (not one file per attribute value):

```
indexes/
├── by_type.idx      # All node_type → node_id mappings
├── by_file.idx      # All file → node_id mappings
└── global.idx       # node_id → (shard, segment, offset)
```

Each index file is a sorted array with a header + lookup table.

---

## Struct Definitions

### CompactionConfig

```rust
pub struct CompactionConfig {
    /// Minimum L0 segment count to trigger compaction (default: 4)
    pub segment_threshold: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self { segment_threshold: 4 }
    }
}
```

### CompactionResult

```rust
pub struct CompactionResult {
    pub shards_compacted: Vec<u16>,
    pub nodes_merged: u64,
    pub edges_merged: u64,
    pub tombstones_removed: u64,
    pub duration_ms: u64,
}
```

### Manifest Extensions

```rust
// Added to existing Manifest struct
pub struct Manifest {
    // ... existing fields ...

    /// L1 descriptors per shard (None = not compacted)
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub l1_node_segments: HashMap<u16, SegmentDescriptor>,

    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub l1_edge_segments: HashMap<u16, SegmentDescriptor>,

    /// Compaction metadata
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction: Option<CompactionInfo>,
}

pub struct CompactionInfo {
    pub manifest_version: u64,
    pub timestamp_ms: u64,
    pub l0_segments_merged: u32,
}
```

**Backwards compatibility:** `#[serde(default)]` makes old manifests deserialize cleanly.

### Shard Extensions

```rust
pub struct Shard {
    // ... existing fields ...

    /// L1 node segment (sorted, deduplicated). None if not compacted.
    l1_node_segment: Option<NodeSegmentV2>,
    l1_node_descriptor: Option<SegmentDescriptor>,

    /// L1 edge segment (sorted, deduplicated). None if not compacted.
    l1_edge_segment: Option<EdgeSegmentV2>,
    l1_edge_descriptor: Option<SegmentDescriptor>,
}
```

### Index Entry (Binary Format)

```rust
/// 32 bytes, cache-line friendly
#[repr(C)]
pub struct IndexEntry {
    pub node_id: u128,    // 16 bytes — the key
    pub shard: u16,       // 2 bytes
    pub segment_id: u64,  // 8 bytes
    pub offset: u32,      // 4 bytes — record index in segment
    pub _padding: u16,    // 2 bytes — align to 32
}

// Total: 32 bytes per entry
// 1M entries = 32 MB
```

### Index File Layout

```
[IndexFileHeader]           // 32 bytes
[LookupTable]               // variable (for by_type, by_file)
[IndexEntry; entry_count]   // 32 * entry_count bytes

IndexFileHeader {
    magic: [u8; 4],         // b"RIDX"
    version: u32,           // 1
    entry_count: u64,       // total entries
    lookup_count: u32,      // number of lookup table entries
    _reserved: [u8; 12],    // future use
}

LookupTableEntry {
    key_hash: u64,          // xxHash of attribute value (node_type, file)
    offset: u32,            // byte offset into entries array
    count: u32,             // number of entries for this key
}
```

For `global.idx`: no lookup table needed (flat sorted array of IndexEntry).
For `by_type.idx`, `by_file.idx`: lookup table maps attribute hash → entry range.

---

## Algorithms with Big-O Analysis

### Node Merge (per shard)

```
Input:  S segments with N_total records, T tombstones
Output: 1 sorted segment, N_live records (N_total - duplicates - tombstones)

1. Collect: iterate S segments, HashMap insert by node_id
   - Time: O(N_total) — HashMap insert is amortized O(1)
   - Space: O(N_unique) — one entry per unique node_id

2. Filter tombstones: retain(|id| !tombstones.contains(id))
   - Time: O(N_unique) — HashSet lookup O(1)

3. Sort by node_id:
   - Time: O(N_live * log N_live)
   - Space: O(N_live) (in-place sort of Vec)

4. Write segment via NodeSegmentWriter:
   - Time: O(N_live)
   - Space: O(N_live) (writer buffers)

Total Time: O(N_total + N_live * log N_live) ≈ O(N * log N)
Total Space: O(N) where N = max(N_total, N_live)
```

### Edge Merge (per shard)

```
Input:  S segments with M_total edges, T_edge tombstones
Output: 1 sorted segment

1. Collect: HashMap<(u128, u128, String), EdgeRecordV2>
   - Key: (src, dst, edge_type) — composite dedup key
   - Time: O(M_total), Space: O(M_unique)

2. Filter tombstones: retain by edge key
   - Time: O(M_unique)

3. Sort by (src, dst, edge_type):
   - Time: O(M_live * log M_live)

4. Write via EdgeSegmentWriter:
   - Time: O(M_live)

Total: O(M * log M), Space: O(M)
```

### Inverted Index Build

```
Input:  N sorted records with their segment positions
Output: by_type.idx, by_file.idx

1. Group by attribute: HashMap<String, Vec<IndexEntry>>
   - Time: O(N)
   - Space: O(N) (all entries stored)

2. Build lookup table: sort keys by hash
   - Time: O(K * log K) where K = distinct attribute values

3. Write file: header + lookup + entries
   - Time: O(K + N)

Total: O(N + K log K) ≈ O(N) since K << N
```

### Global Index Build

```
Input:  All L1 segments across all shards
Output: global.idx

1. Collect entries from all shards:
   - Time: O(N_total) where N_total = sum of all L1 record counts

2. Sort by node_id:
   - Time: O(N_total * log N_total)

3. Write file:
   - Time: O(N_total)

Total: O(N_total * log N_total)
```

### Index Lookup (query time)

```
by_type lookup:
1. Hash attribute value → O(1)
2. Binary search lookup table → O(log K) where K = distinct types
3. Sequential read of matching entries → O(R) where R = result count

Point lookup via global index:
1. Binary search → O(log N_total)
2. Direct segment access → O(1)

Total: O(log N) for point lookups (vs O(S * bloom_check) currently)
```

---

## File-by-File Change List

### New Files (~1,300 LOC code + ~750 LOC tests)

| File | LOC | Purpose |
|------|-----|---------|
| `compaction/mod.rs` | 30 | Module declarations |
| `compaction/types.rs` | 60 | CompactionConfig, CompactionResult, CompactionInfo |
| `compaction/merge.rs` | 250 | Node merge + Edge merge algorithms |
| `compaction/coordinator.rs` | 150 | should_compact(), compact_shard(), compact_all() |
| `compaction/swap.rs` | 120 | Atomic swap: write tmp → rename → reload |
| `index/mod.rs` | 20 | Module declarations |
| `index/format.rs` | 200 | IndexFileHeader, IndexEntry, LookupTableEntry, read/write |
| `index/builder.rs` | 200 | Build by_type, by_file, global indexes |
| `index/query.rs` | 120 | Index loading, binary search, lookup |
| `index/global.rs` | 150 | Global index build + query |

### Modified Files (~350 LOC changes)

| File | Changes | LOC |
|------|---------|-----|
| `manifest.rs` | Add l1_*_segments, CompactionInfo fields, update create_manifest() | +80 |
| `shard.rs` | Add l1_*_segment fields, modify query path, add segment_count() | +120 |
| `multi_shard.rs` | Add compact(), rebuild_global_index() | +80 |
| `mod.rs` | Add `pub mod compaction; pub mod index;` | +5 |
| `engine_v2.rs` | Wire compact command through GraphEngineV2 | +40 |
| `types.rs` | Add segment_level field to SegmentDescriptor | +25 |

### Test Files (~750 LOC)

| File | Tests | LOC |
|------|-------|-----|
| `compaction/merge.rs` (inline) | 8 | 300 |
| `index/format.rs` (inline) | 4 | 150 |
| `index/builder.rs` (inline) | 3 | 100 |
| Integration test file | 10 | 200 |

**Total: ~2,400 LOC** (code: 1,650 + tests: 750)

---

## Crash Recovery

### Scenario 1: Crash during merge (writing tmp files)

**State:** `.tmp/compaction_NNNN/` exists with partial segments.
**Recovery:** On startup, delete `.tmp/` directory. L0 segments intact, no data loss.

### Scenario 2: Crash after tmp write, before manifest commit

**State:** `.tmp/` has complete L1 segments, but manifest still points to L0.
**Recovery:** Delete `.tmp/`. L0 segments serve queries. No data loss.

### Scenario 3: Crash after rename, before manifest commit

**State:** L1 segment files exist in `segments/`, but manifest doesn't reference them.
**Recovery:** On startup, scan `segments/` for unreferenced segments, delete them. Or: re-compact.

### Scenario 4: Crash after manifest commit

**State:** Everything consistent. New manifest references L1 segments.
**Recovery:** Normal startup. Old L0 segments may still exist (if not yet deleted) — GC cleans up.

**Key insight:** Manifest commit is the linearization point. Before commit = old state. After commit = new state. `.tmp/` is always safe to delete.

---

## Implementation Order (13 atomic commits)

### Phase 1: Infrastructure (3 commits)

**Commit 1: Compaction types + module structure**
- Create `compaction/mod.rs`, `compaction/types.rs`
- Add CompactionConfig, CompactionResult, CompactionInfo
- Add `pub mod compaction;` to `storage_v2/mod.rs`
- ~90 LOC, 0 tests (types only)

**Commit 2: Manifest schema evolution**
- Add `l1_node_segments`, `l1_edge_segments`, `last_compaction` to Manifest
- Add `level` field to SegmentDescriptor
- Backwards compat via `#[serde(default)]`
- ~80 LOC, 3 tests (serialization roundtrip)

**Commit 3: Index file format**
- Create `index/mod.rs`, `index/format.rs`
- IndexFileHeader, IndexEntry, LookupTableEntry
- Serialization/deserialization with validation
- ~220 LOC, 4 tests (roundtrip, alignment, edge cases)

### Phase 2: Core Merge (3 commits)

**Commit 4: Node merge algorithm**
- Create `compaction/merge.rs`
- `merge_node_segments(segments, tombstones) -> Vec<NodeRecordV2>`
- Collect → dedup → filter → sort
- ~150 LOC, 4 tests (dedup, tombstones, sort order, empty)

**Commit 5: Edge merge algorithm**
- Add to `compaction/merge.rs`
- `merge_edge_segments(segments, tombstones) -> Vec<EdgeRecordV2>`
- Composite key dedup: (src, dst, edge_type)
- ~100 LOC, 3 tests (dedup, tombstones, sort)

**Commit 6: Shard compaction coordinator**
- Create `compaction/coordinator.rs`
- `should_compact(shard) -> bool`
- `compact_shard(shard, config, manifest) -> Result<()>`
- Orchestrates: merge → write → swap
- ~150 LOC, 2 tests (trigger threshold, full cycle)

### Phase 3: Swap + Query Path (3 commits)

**Commit 7: Blue/green swap**
- Create `compaction/swap.rs`
- Write to `.tmp/`, rename to final path, update manifest
- Drop old segments, reload new
- Delete old L0 segment files
- ~120 LOC, 2 tests (swap + persistence)

**Commit 8: Query path integration**
- Modify `shard.rs`: add L1 fields, modify find_nodes/get_node/get_edges
- Query order: write_buffer → L0 (newest-first) → L1
- Track seen IDs across L0+L1 for dedup
- ~120 LOC, 4 tests (query equivalence: before/after compact)

**Commit 9: Multi-shard compaction**
- Add `MultiShardStore::compact()` — iterates shards, calls compact_shard
- Add `Shard::segment_count()` method
- Wire through GraphEngineV2
- ~80 LOC, 2 tests (multi-shard cycle)

### Phase 4: Indexes (3 commits)

**Commit 10: Inverted index builder**
- Create `index/builder.rs`
- Build by_type and by_file indexes during compaction
- Write to disk alongside L1 segments
- ~200 LOC, 3 tests (build + correctness)

**Commit 11: Index query path**
- Create `index/query.rs`
- Load indexes on shard open (or lazy)
- `find_nodes_via_index()` method
- Fallback to scan if index missing
- ~120 LOC, 3 tests (lookup, missing index fallback)

**Commit 12: Global index**
- Create `index/global.rs`
- Build after all shards compacted
- Binary search for point lookups
- Fallback to fan-out if index missing
- ~150 LOC, 3 tests (build, lookup, missing)

### Phase 5: Polish (1 commit)

**Commit 13: Wire protocol + cleanup**
- Add `Compact` command to wire protocol
- Error handling, logging, startup cleanup (delete .tmp/)
- ~100 LOC, 2 tests (command roundtrip, crash recovery)

---

## Test Plan Summary

| Category | Count | LOC | Description |
|----------|-------|-----|-------------|
| Merge correctness | 7 | 250 | Dedup, tombstones, sort, empty cases |
| Index format | 4 | 150 | Roundtrip, alignment, edge cases |
| Compaction cycle | 4 | 200 | Full compact + query equivalence |
| Index build + query | 6 | 200 | Build, lookup, fallback |
| Global index | 3 | 100 | Build, lookup, missing |
| Multi-shard | 2 | 100 | Orchestration, persistence |
| Crash recovery | 2 | 100 | .tmp cleanup, manifest consistency |
| **Total** | **28** | **~1,100** | |

---

## Performance Expectations

| Operation | Before | After | Speedup |
|-----------|--------|-------|---------|
| Point lookup (get_node) | O(S * bloom) across shards | O(log N) via global index | ~4x (4 shards) |
| Attribute query (find by type) | O(N) scan all segments | O(R) via inverted index | 10-100x |
| Edge query (outgoing) | O(E) scan all edge segments | O(E_shard) scan L1 only | 2-5x (fewer segments) |
| Compaction time | N/A | O(N log N) | Target: <10s for 1M nodes |

---

**END OF TECH SPEC**
