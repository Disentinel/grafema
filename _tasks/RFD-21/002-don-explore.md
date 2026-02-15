# RFD-21: Resource Adaptation — Codebase Exploration

**Date:** 2026-02-15
**Agent:** Don Melton (Tech Lead)
**Task:** Explore RFDB v2 architecture for adaptive resource management integration points

---

## Executive Summary

RFDB v2 has a clean LSM-tree architecture with **multiple hardcoded parameters** that should become adaptive based on system resources. RFD-20 just completed background compaction, providing a solid foundation. The codebase has **no existing resource detection infrastructure** beyond basic memory monitoring in the server binary.

**Key Finding:** All parameters are currently compile-time constants or defaults. No runtime adaptation exists.

---

## 1. Current Architecture Overview

### 1.1 Storage Engine Structure

```
MultiShardStore (multi_shard.rs)
├── N × Shard instances (shard.rs)
│   ├── WriteBuffer (in-memory, HashMap + Vec)
│   ├── L0 segments (unsorted, flushed buffers)
│   └── L1 segment (compacted, sorted, indexed)
├── ManifestStore (manifest.rs, atomic commits)
├── GlobalIndex (global.rs, O(log N) point lookups)
└── CompactionCoordinator (coordinator.rs)
```

**Write Path:**
1. Records → WriteBuffer (HashMap for nodes, Vec for edges)
2. Flush trigger → L0 segment files (columnar format)
3. Compaction trigger → L0 + L1 → new L1 (sorted, deduplicated)

**Read Path:**
1. Point lookup: GlobalIndex → shard → segment → offset
2. Attribute scan: WriteBuffer + L0 + L1 (bloom filter pruning)
3. Neighbor queries: edge segments (src/dst bloom filters)

### 1.2 Memory Allocation Patterns

**Hot paths (memory-intensive):**

1. **WriteBuffer** (`write_buffer.rs`):
   - `HashMap<u128, NodeRecordV2>` for nodes (16 bytes key + ~100 bytes value)
   - `Vec<EdgeRecordV2>` for edges (~40 bytes per edge)
   - `HashSet<(u128, u128, String)>` for edge deduplication
   - **No size limits** — grows until flush

2. **Compaction** (`coordinator.rs:75-148`):
   - Loads ALL records from L0 + L1 into memory
   - `Vec<NodeRecordV2>` and `Vec<EdgeRecordV2>`
   - Sorts in-place (O(N log N) time, O(N) space)
   - Writes new segment to in-memory buffer before disk
   - **Linear issue tracked:** RFD-35 "O(N) memory during compaction" (v0.3, Low)

3. **Segment I/O** (`segment.rs`):
   - mmap for read (OS-managed)
   - Bloom filters: ~10 bits/key (1.25 bytes/key)
   - Zone maps: bounded by `MAX_ZONE_MAP_VALUES_PER_FIELD = 10_000`

4. **Global Index** (`global.rs`):
   - Sorted array of `IndexEntry` (24 bytes: u128 id + u64 seg_id + u32 offset + u16 shard_id)
   - Built during compaction from ALL L1 segments
   - In-memory, not mmap'd (could be optimized)

**Memory growth pattern:** Linear with dataset size until flush/compaction.

---

## 2. Hardcoded Parameters (Candidates for Adaptation)

### 2.1 Compaction Configuration

**File:** `storage_v2/compaction/types.rs:10-21`

```rust
pub struct CompactionConfig {
    /// Minimum L0 segment count per shard to trigger compaction (default: 4)
    pub segment_threshold: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            segment_threshold: 4,
        }
    }
}
```

**Why adaptive:**
- Low memory (< 4GB): trigger at 2 segments (compact early, reduce memory pressure)
- High memory (> 16GB): trigger at 8+ segments (amortize compaction cost)
- Current: fixed at 4, no adjustment based on available RAM

### 2.2 Shard Count

**File:** `graph/engine_v2.rs:18-19`

```rust
/// Default shard count for new databases.
const DEFAULT_SHARD_COUNT: u16 = 4;
```

**Why adaptive:**
- Single-core (1-2 CPUs): 1-2 shards (avoid parallelism overhead)
- Many cores (8+): 8-16 shards (maximize compaction parallelism)
- Current: fixed at 4, written to `db_config.json` at creation time

**Trade-off:** Shard count is **immutable after database creation** (written to `DatabaseConfig`, line 49-52 in `multi_shard.rs`). Changing it requires migration.

### 2.3 Bloom Filter Sizing

**File:** `storage_v2/types.rs:34-38`

```rust
/// Bloom filter: bits per key (10 → ~0.82% FPR with k=7)
pub const BLOOM_BITS_PER_KEY: usize = 10;

/// Bloom filter: number of hash functions (optimal for 10 bits/key)
pub const BLOOM_NUM_HASHES: usize = 7;
```

**Why adaptive:**
- Low memory: reduce to 8 bits/key (1.6% FPR, saves 20% space)
- High memory: increase to 12 bits/key (0.4% FPR, better query performance)
- Current: fixed at 10 bits/key

**Impact zone:** Segment writer (`writer.rs:109`), segment reader (`bloom.rs:57-68`)

### 2.4 Zone Map Threshold

**File:** `storage_v2/types.rs:40-42`

```rust
/// Zone map: max distinct values per field before omitting
pub const MAX_ZONE_MAP_VALUES_PER_FIELD: usize = 10_000;
```

**Why adaptive:**
- Low memory: reduce to 5,000 (save space)
- High memory: increase to 50,000 (better pruning)

### 2.5 Write Buffer Size (NOT FOUND — MISSING)

**Current state:** WriteBuffer has **no size limit**. It grows until explicit flush.

**File:** `write_buffer.rs:52-62` — constructor takes no capacity parameter.

```rust
impl WriteBuffer {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: Vec::new(),
            edge_keys: HashSet::new(),
        }
    }
}
```

**Why adaptive:**
- Low memory: flush at 10K nodes (reduce peak memory)
- High memory: flush at 100K nodes (amortize write I/O)
- Current: **infinite** — relies on application-level flush triggers

**Integration point:** `shard.rs` would need to check buffer size before `add_nodes()` and auto-flush.

### 2.6 Compaction Parallelism (NOT FOUND — SEQUENTIAL)

**Current state:** Compaction is **sequential** across shards.

**File:** `multi_shard.rs:1004-1112` — `for shard_idx in 0..self.shards.len()` loop

```rust
for shard_idx in 0..self.shards.len() {
    // ...
    if !should_compact(&self.shards[shard_idx], config) {
        // preserve L1
        continue;
    }

    let result = compact_shard(&self.shards[shard_idx])?;
    // ... write L1 segments, build indexes
}
```

**Why adaptive:**
- Single-core: sequential (current behavior)
- Many cores: parallel via `rayon::par_iter()` (already in Cargo.toml line 20)
- Current: **no parallelism**, even with 8+ shards

**Blocker:** Shards are NOT Send+Sync (line 98-99 in `multi_shard.rs`). Would need Arc+Mutex wrapping or refactor.

---

## 3. Compaction Trigger & Configuration

### 3.1 Trigger Policy

**File:** `compaction/coordinator.rs:25-34`

```rust
pub fn should_compact(shard: &Shard, config: &CompactionConfig) -> bool {
    let total_l0 = shard.l0_node_segment_count() + shard.l0_edge_segment_count();
    total_l0 >= config.segment_threshold
}
```

**Called from:** `multi_shard.rs:1010` during `compact()` operation.

**Current behavior:**
- Check: L0 count >= threshold (default 4)
- No automatic trigger — application must call `compact()` explicitly
- **Linear issue tracked:** RFD-34 "No automatic compaction trigger" (v0.2, Low)

**Adaptive opportunity:** Adjust threshold based on memory pressure. If RAM < 4GB and buffer is full, trigger early compaction even if L0 count < threshold.

### 3.2 Configuration Struct

**File:** `compaction/types.rs:10-13`

```rust
pub struct CompactionConfig {
    pub segment_threshold: usize,
}
```

**Usage:**
- Created in tests with `CompactionConfig { segment_threshold: 4 }`
- Passed to `MultiShardStore::compact(manifest, config)`
- **No persistence** — created fresh each time

**Adaptive integration:** `ResourceManager` could generate `CompactionConfig` based on current memory/CPU.

---

## 4. Existing Configuration Infrastructure

### 4.1 DatabaseConfig (Immutable)

**File:** `multi_shard.rs:48-73`

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseConfig {
    pub shard_count: u16,
}

impl DatabaseConfig {
    pub fn read_from(db_path: &Path) -> Result<Option<Self>> { /* ... */ }
    pub fn write_to(&self, db_path: &Path) -> Result<()> { /* ... */ }
}
```

**Persistence:** Written to `<db_path>/db_config.json` at creation.

**Use case:** Stores **immutable** database parameters (shard count).

**Adaptive opportunity:** Could be extended to store "creation-time" tuning profile (e.g., "low_memory", "high_performance"). But shard count itself cannot change.

### 4.2 ManifestStore (Versioned State)

**File:** `manifest.rs:615-900`

```rust
pub struct ManifestStore {
    current: Arc<RwLock<SnapshotInfo>>,
    // ...
}
```

**Persistence:** Writes versioned `manifest_NNNNNN.json` files.

**Content:** Segment descriptors, tombstones, compaction info.

**Not for config:** Manifest is for data state, not operational tuning.

### 4.3 No Runtime Configuration

**Observation:** RFDB has NO runtime config file (no `rfdb.toml`, no `config.json` for operational parameters).

**All tuning is code-level:**
- Constants in `types.rs`
- Struct defaults in `*Config` types
- Constructor parameters

**Implication:** ResourceManager would need to compute parameters at runtime, not read from config.

---

## 5. System Resource Detection

### 5.1 Existing sysinfo Usage

**Dependency:** `Cargo.toml:23` — `sysinfo = "0.30"` (already present)

**Usage:**

1. **rfdb_server.rs:712-722** (server binary, not library):
   ```rust
   fn check_memory_usage() -> f32 {
       let mut sys = System::new();
       sys.refresh_memory();
       let total = sys.total_memory();
       let used = sys.used_memory();
       (used as f64 / total as f64 * 100.0) as f32
   }
   ```

   Used for: Basic memory monitoring (likely for logging/metrics).

2. **graph/engine.rs:9, 42** (v1 engine, not v2):
   ```rust
   use sysinfo::{System, RefreshKind, MemoryRefreshKind};

   *sys_guard = Some(System::new_with_specifics(
       RefreshKind::new().with_memory(MemoryRefreshKind::everything())
   ));
   ```

   Used for: Memory tracking in v1 engine (unclear purpose, might be legacy).

**No CPU detection:** No usage of `sys.cpus()` or thread count queries.

### 5.2 Available sysinfo APIs

**Relevant for RFD-21:**

- `System::total_memory()` → u64 bytes
- `System::available_memory()` → u64 bytes (free + buffers + cache)
- `System::cpus().len()` → usize (logical core count)
- `std::thread::available_parallelism()` → usize (Rust stdlib, preferred)

**Recommendation:** Use stdlib `available_parallelism()` for CPU, sysinfo for memory.

### 5.3 No Existing ResourceManager

**Searched for:** `ResourceManager`, `Tuner`, `Adaptive`, `SystemInfo` — **none found**.

**Implication:** This is a greenfield addition. Clean slate.

---

## 6. Integration Points for ResourceManager

### 6.1 Proposed Architecture

```rust
// New module: storage_v2/resource.rs

pub struct ResourceManager {
    total_memory: u64,
    available_memory: u64,
    cpu_count: usize,
}

impl ResourceManager {
    pub fn detect() -> Self { /* query sysinfo */ }

    pub fn tuning_profile(&self) -> TuningProfile { /* compute */ }
}

pub struct TuningProfile {
    pub shard_count: u16,           // for new databases
    pub segment_threshold: usize,   // for CompactionConfig
    pub bloom_bits_per_key: usize,  // for segment writer
    pub write_buffer_limit: usize,  // for WriteBuffer auto-flush
    pub compact_parallel: bool,     // enable rayon in compaction
}
```

**Where to call:**

1. **Database creation** (`GraphEngineV2::create`, line 168):
   ```rust
   let profile = ResourceManager::detect().tuning_profile();
   let store = MultiShardStore::create(path, profile.shard_count)?;
   ```

2. **Write buffer flush** (`Shard::add_nodes`, after line 270):
   ```rust
   if self.write_buffer.node_count() >= profile.write_buffer_limit {
       self.flush()?;
   }
   ```

3. **Compaction trigger** (`MultiShardStore::compact`, line 979):
   ```rust
   let profile = ResourceManager::detect().tuning_profile();
   let config = CompactionConfig {
       segment_threshold: profile.segment_threshold,
   };
   ```

4. **Compaction parallelism** (new code in `multi_shard.rs:1004`):
   ```rust
   if profile.compact_parallel {
       // use rayon::par_iter() for shards
   } else {
       // current sequential loop
   }
   ```

### 6.2 Challenges

**1. Shard not Send+Sync:**
   - Current: `multi_shard.rs:98` — "NOT Send+Sync by default"
   - Blocker for parallel compaction
   - Fix: Wrap in Arc<Mutex<Shard>> OR refactor Shard to be Send+Sync

**2. Constants baked into segment format:**
   - `BLOOM_BITS_PER_KEY` used in `writer.rs:109` during segment creation
   - Can't change retroactively for existing segments
   - Fix: Store bits_per_key in segment header (format v3?) OR accept mixed formats

**3. No write buffer size tracking:**
   - WriteBuffer has `node_count()` and `edge_count()` but no byte size estimate
   - Fix: Add `fn memory_usage(&self) -> usize` to WriteBuffer

**4. Compaction is O(N) memory:**
   - RFD-35 tracked, but low priority (v0.3)
   - ResourceManager can't fix this, only mitigate by triggering early

---

## 7. Memory Usage Breakdown (Estimated)

**For a 1M node, 2M edge graph:**

| Component | Size Estimate | Notes |
|---|---|---|
| WriteBuffer (pre-flush) | ~100MB nodes + 80MB edges = 180MB | HashMap + Vec overhead |
| L0 segments (4 × 250K nodes) | ~100MB | Columnar, compressed |
| L1 segment (1M nodes) | ~120MB | Sorted, bloom + zone map |
| Bloom filters (1M nodes) | ~1.25MB | 10 bits/key |
| Global index | ~24MB | 24 bytes per node |
| Zone maps | <1MB | Bounded by MAX_ZONE_MAP_VALUES |
| **Compaction peak** | ~400MB | Load L0 + L1 into memory |

**Total working set:** ~500MB for 1M nodes.

**Scaling:** Linear with node count. 10M nodes = ~5GB.

**Adaptive target:** Keep compaction peak < 50% of available RAM.

---

## 8. Recommendations for RFD-21

### 8.1 Phase 1: Detection Infrastructure

**New file:** `storage_v2/resource.rs`

- `ResourceManager::detect()` using sysinfo + available_parallelism
- `TuningProfile` struct with all adaptive parameters
- Unit tests with mock system info

**Estimated:** 150-200 LOC

### 8.2 Phase 2: Adaptive Shard Count

**Modify:** `graph/engine_v2.rs:171`

- Replace `DEFAULT_SHARD_COUNT` with `ResourceManager::detect().tuning_profile().shard_count`
- Store profile choice in DatabaseConfig as metadata (optional)

**Estimated:** 50 LOC

### 8.3 Phase 3: Adaptive Compaction Threshold

**Modify:** `compaction/types.rs`

- Make `CompactionConfig::default()` call ResourceManager
- Update `multi_shard.rs:979` to use adaptive config

**Estimated:** 30 LOC

### 8.4 Phase 4: Write Buffer Auto-Flush

**Modify:** `shard.rs` + `write_buffer.rs`

- Add `WriteBuffer::memory_usage()` estimate
- Auto-flush in `add_nodes()` when limit exceeded

**Estimated:** 100 LOC

### 8.5 Phase 5: Parallel Compaction (Optional, Stretch Goal)

**Modify:** `multi_shard.rs:1004`

- Refactor Shard to be Send+Sync OR wrap in Arc<Mutex>
- Use `rayon::par_iter()` for shard loop
- Conditional on `profile.compact_parallel`

**Estimated:** 200 LOC (high complexity, may defer to RFD-36)

---

## 9. Known Blockers

1. **Shard mutability during compaction:**
   - Current code holds `&Shard` during compaction read, then mutates via `&mut self.shards[idx]`
   - Prevents borrowing shards in parallel
   - **Fix:** Redesign compaction to return new Shard state, not mutate in-place

2. **Bloom filter constant baked into segments:**
   - Can't change BLOOM_BITS_PER_KEY for existing databases
   - **Fix:** Accept it OR version the format (breaks backward compat)

3. **No metrics for ResourceManager effectiveness:**
   - Need to track: compaction count, buffer flushes, memory high-water mark
   - **Fix:** Extend `metrics.rs` with resource-related counters

---

## 10. Files to Modify (Summary)

| File | Change | LOC Estimate |
|---|---|---|
| `storage_v2/resource.rs` | NEW — ResourceManager + TuningProfile | 150-200 |
| `storage_v2/compaction/types.rs` | Adaptive CompactionConfig::default() | 30 |
| `storage_v2/write_buffer.rs` | Add memory_usage() | 20 |
| `storage_v2/shard.rs` | Auto-flush on buffer limit | 50 |
| `storage_v2/multi_shard.rs` | Use adaptive compaction config | 30 |
| `graph/engine_v2.rs` | Adaptive shard count on create | 30 |
| `metrics.rs` | Resource tracking metrics | 50 |

**Total estimate:** 360-410 LOC (excluding parallel compaction).

---

## 11. Test Strategy

**Unit tests:**
- `ResourceManager::detect()` with mocked sysinfo (proptest)
- `TuningProfile::from_resources()` for different RAM/CPU scenarios
- `WriteBuffer::memory_usage()` accuracy

**Integration tests:**
- Create database with 2GB vs 16GB mock → verify shard count differs
- Compaction threshold adjusts based on available memory
- Auto-flush triggers at buffer limit

**Stress tests:**
- Load 10M nodes on 4GB RAM → verify no OOM
- Compare compaction performance: adaptive vs fixed config

---

## 12. Open Questions

1. **Should shard count be adaptive AFTER creation?**
   - Current: immutable in DatabaseConfig
   - Alternative: Allow shard split/merge (complex, defer to v0.3+)

2. **Should ResourceManager cache detections or re-query every time?**
   - Tradeoff: stale info vs overhead
   - Recommendation: Cache with 1-second TTL

3. **How to handle resource changes during long operations?**
   - Example: compaction starts with 8GB free, drops to 2GB mid-operation
   - Recommendation: Snapshot resources at operation start, don't re-adapt mid-flight

4. **Should bloom bits be stored in segment header?**
   - Pro: Allows mixed-format databases
   - Con: Breaks existing readers if not backward-compatible
   - Recommendation: Defer to RFD-37 "Segment Format v3"

---

## 13. Next Steps

1. Present this exploration to user for confirmation
2. Create detailed technical plan (Joel-level spec) with:
   - TuningProfile heuristics (RAM thresholds, CPU thresholds)
   - Backward compatibility strategy
   - Metrics design
3. Proceed to implementation phases 1-4 (skip phase 5 for now)

**Estimated total task complexity:** 400-500 LOC, ~15-20 tests, 2-3 days work.

---

## Appendix: Constants Reference

| Constant | Location | Current Value | Adaptive Range |
|---|---|---|---|
| `DEFAULT_SHARD_COUNT` | `graph/engine_v2.rs:19` | 4 | 1-16 |
| `segment_threshold` | `compaction/types.rs:18` | 4 | 2-8 |
| `BLOOM_BITS_PER_KEY` | `storage_v2/types.rs:35` | 10 | 8-12 |
| `BLOOM_NUM_HASHES` | `storage_v2/types.rs:38` | 7 | 6-8 |
| `MAX_ZONE_MAP_VALUES_PER_FIELD` | `storage_v2/types.rs:42` | 10,000 | 5,000-50,000 |
| (missing) write_buffer_limit | — | ∞ | 10K-100K nodes |

---

**End of Exploration Report**
