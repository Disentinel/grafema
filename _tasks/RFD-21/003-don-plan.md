# RFD-21: Resource Adaptation — Implementation Plan

**Date:** 2026-02-15
**Agent:** Don Melton (Tech Lead)
**Task:** Define scope and implementation plan for adaptive resource management in RFDB v2

---

## Research Summary

**Prior art review:**

1. **RocksDB Write Buffer Manager** ([source](https://github.com/facebook/rocksdb/wiki/Write-Buffer-Manager)):
   - Flush triggered at 90% of limit (soft threshold)
   - Stall writes at 100% (hard limit) if `allow_stall = true`
   - Memory shared across column families via central manager

2. **LSM Auto-Tuning Research** ([EcoTune](https://people.iiis.tsinghua.edu.cn/~huanchen/publications/ecotune-sigmod25.pdf), [ELMo-Tune-V2](https://arxiv.org/html/2502.17606v1)):
   - Modern LSM-KVS have 100+ tunable parameters
   - Compaction consumes 62% of CPU in traditional leveling policies
   - Workload-aware tuning significantly outperforms fixed configs

3. **Thread Pool Sizing** ([multi-threaded compaction study](https://discos.sogang.ac.kr/file/2025/intl_conf/ICPP_2025_H_Byun.pdf)):
   - Diminishing returns beyond 6-8 threads due to contention
   - Context switching overhead becomes significant with many cores
   - Optimal thread count is workload-dependent, not just `core_count`

**Key insight:** Static heuristics (e.g., `threads = cores`) don't work well. Need bounded ranges with conservative defaults.

---

## Scope Definition

### In Scope (RFD-21)

**Phase 1: Detection Infrastructure** (~150 LOC)
- `ResourceManager` struct with system detection
- `TuningProfile` struct with adaptive parameters
- Heuristic formulas for RAM/CPU-based tuning

**Phase 2: Adaptive Shard Count** (~30 LOC)
- New databases use `ResourceManager` to determine shard count
- Range: 1-16 shards based on CPU cores

**Phase 3: Adaptive Compaction Threshold** (~30 LOC)
- `CompactionConfig::segment_threshold` computed from available memory
- Range: 2-8 L0 segments

**Phase 4: Write Buffer Auto-Flush** (~120 LOC)
- Add `WriteBuffer::estimated_memory_bytes()` method
- Auto-flush in `Shard::add_nodes()` when limit exceeded
- Range: 10K-100K nodes based on available RAM

**Total: ~330 LOC core + 70 LOC tests = ~400 LOC**

### Out of Scope (Defer)

**Bloom filter adaptation:**
- Currently baked into segment format (`BLOOM_BITS_PER_KEY = 10` constant)
- Changing requires format versioning (backward compat complexity)
- **Defer to RFD-37** "Segment Format v3" (v0.3+)

**Parallel compaction:**
- Shard is NOT Send+Sync (`multi_shard.rs:98`)
- Requires Arc+Mutex wrapping OR refactor to immutable compaction
- Complex change (200+ LOC), high risk
- **Defer to RFD-36** "Parallel Compaction" (v0.3+)

**Zone map adaptation:**
- `MAX_ZONE_MAP_VALUES_PER_FIELD` is low-impact (capped memory usage)
- Not a bottleneck in current workloads
- **Defer to future optimization** if profiling shows benefit

**Prefetch strategy:**
- Task mentions "prefetch strategy" but RFDB has no prefetch infrastructure
- Segments are mmap'd (OS handles page faults)
- No sequential scan optimizations yet
- **Interpretation:** Defer until we have scan-heavy workloads that need prefetching

### Memory Pressure Handling (Clarification)

**Spec says:** "Memory pressure handling"

**Concrete mechanism for RFD-21:**
1. **Auto-flush write buffer** when RAM usage is high (Phase 4)
2. **Lower compaction threshold** when available memory < 4GB (Phase 3)
3. **Smaller shard count** when RAM < 2GB (Phase 2)

**NOT in scope:**
- Process signals (SIGTERM on OOM) — application-level concern
- Dynamic memory reallocation — Rust allocator handles this
- Compaction abortion — too risky, could corrupt state

---

## Architecture

### New Module: `storage_v2/resource.rs`

```rust
//! Adaptive resource management for RFDB v2.
//!
//! Detects system resources (RAM, CPU) and computes tuning parameters
//! to optimize performance and prevent OOM.

use sysinfo::{System, MemoryRefreshKind, RefreshKind};

/// System resource snapshot.
#[derive(Debug, Clone)]
pub struct SystemResources {
    /// Total RAM in bytes (physical memory).
    pub total_memory_bytes: u64,
    /// Available RAM in bytes (free + buffers + cache).
    pub available_memory_bytes: u64,
    /// Number of logical CPU cores.
    pub cpu_count: usize,
}

/// Adaptive tuning parameters computed from system resources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuningProfile {
    /// Shard count for new databases (1-16).
    pub shard_count: u16,
    /// L0 segment count threshold to trigger compaction (2-8).
    pub segment_threshold: usize,
    /// Write buffer size limit in number of nodes (10K-100K).
    pub write_buffer_node_limit: usize,
    /// Write buffer size limit in estimated bytes (10MB-100MB).
    pub write_buffer_byte_limit: usize,
}

/// Resource manager for adaptive tuning.
pub struct ResourceManager;

impl ResourceManager {
    /// Detect current system resources.
    pub fn detect() -> SystemResources { /* ... */ }

    /// Compute tuning profile from resources.
    pub fn tuning_profile(resources: &SystemResources) -> TuningProfile { /* ... */ }
}
```

**File size:** 150-200 LOC (including tests)

---

## Phase-by-Phase Implementation

### Phase 1: Detection Infrastructure

**Files to create:**
- `packages/rfdb-server/src/storage_v2/resource.rs` (new file)

**Files to modify:**
- `packages/rfdb-server/src/storage_v2/mod.rs` (add `pub mod resource;`)

**Implementation:**

```rust
// storage_v2/resource.rs

use sysinfo::{System, MemoryRefreshKind, RefreshKind};

/// System resource snapshot.
#[derive(Debug, Clone)]
pub struct SystemResources {
    pub total_memory_bytes: u64,
    pub available_memory_bytes: u64,
    pub cpu_count: usize,
}

impl SystemResources {
    /// Detect current system resources.
    pub fn detect() -> Self {
        let mut sys = System::new_with_specifics(
            RefreshKind::new().with_memory(MemoryRefreshKind::new().with_ram())
        );
        sys.refresh_memory();

        let cpu_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);

        Self {
            total_memory_bytes: sys.total_memory(),
            available_memory_bytes: sys.available_memory(),
            cpu_count,
        }
    }

    /// Total memory in GB (for display).
    pub fn total_memory_gb(&self) -> f64 {
        self.total_memory_bytes as f64 / (1024.0 * 1024.0 * 1024.0)
    }
}

/// Adaptive tuning parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuningProfile {
    pub shard_count: u16,
    pub segment_threshold: usize,
    pub write_buffer_node_limit: usize,
    pub write_buffer_byte_limit: usize,
}

impl TuningProfile {
    /// Compute adaptive tuning from system resources.
    pub fn from_resources(resources: &SystemResources) -> Self {
        let total_gb = resources.total_memory_gb();
        let cpu_count = resources.cpu_count;

        // Shard count heuristic: min(16, next_power_of_two(cpu_count))
        // Bounded to [1, 16] to avoid over-sharding
        let shard_count = if total_gb < 2.0 {
            // Low memory: reduce shards to save overhead
            1
        } else {
            let ideal = cpu_count.next_power_of_two();
            (ideal.min(16).max(1)) as u16
        };

        // Compaction threshold heuristic:
        // - Low memory (< 4GB): compact early (threshold = 2)
        // - Medium memory (4-16GB): default (threshold = 4)
        // - High memory (> 16GB): compact later (threshold = 8)
        let segment_threshold = if total_gb < 4.0 {
            2
        } else if total_gb < 16.0 {
            4
        } else {
            8
        };

        // Write buffer limits:
        // Heuristic: use ~2% of available memory for write buffer
        // Node estimate: ~120 bytes per node (100 bytes data + 20 bytes HashMap overhead)
        // Edge estimate: ~50 bytes per edge
        // Assume 2:1 edge:node ratio → ~220 bytes per node total
        let buffer_target_bytes = ((resources.available_memory_bytes as f64) * 0.02) as usize;
        let buffer_target_bytes = buffer_target_bytes.clamp(10 * 1024 * 1024, 100 * 1024 * 1024);

        let write_buffer_byte_limit = buffer_target_bytes;
        let write_buffer_node_limit = buffer_target_bytes / 220; // ~220 bytes per node

        Self {
            shard_count,
            segment_threshold,
            write_buffer_node_limit,
            write_buffer_byte_limit,
        }
    }

    /// Default tuning profile (conservative, for tests).
    pub fn default() -> Self {
        Self {
            shard_count: 4,
            segment_threshold: 4,
            write_buffer_node_limit: 50_000,
            write_buffer_byte_limit: 10 * 1024 * 1024, // 10MB
        }
    }
}

/// Resource manager (stateless utility).
pub struct ResourceManager;

impl ResourceManager {
    /// Detect resources and compute tuning profile.
    pub fn auto_tune() -> TuningProfile {
        let resources = SystemResources::detect();
        TuningProfile::from_resources(&resources)
    }
}
```

**Tests (in same file):**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_system_resources_detection() {
        let resources = SystemResources::detect();
        assert!(resources.total_memory_bytes > 0);
        assert!(resources.cpu_count >= 1);
    }

    #[test]
    fn test_tuning_profile_low_memory() {
        let resources = SystemResources {
            total_memory_bytes: 1024 * 1024 * 1024, // 1 GB
            available_memory_bytes: 512 * 1024 * 1024,
            cpu_count: 4,
        };
        let profile = TuningProfile::from_resources(&resources);
        assert_eq!(profile.shard_count, 1); // Low memory → single shard
        assert_eq!(profile.segment_threshold, 2); // Compact early
    }

    #[test]
    fn test_tuning_profile_medium_memory() {
        let resources = SystemResources {
            total_memory_bytes: 8 * 1024 * 1024 * 1024, // 8 GB
            available_memory_bytes: 4 * 1024 * 1024 * 1024,
            cpu_count: 4,
        };
        let profile = TuningProfile::from_resources(&resources);
        assert_eq!(profile.shard_count, 4); // 4 cores → 4 shards
        assert_eq!(profile.segment_threshold, 4); // Default threshold
    }

    #[test]
    fn test_tuning_profile_high_memory() {
        let resources = SystemResources {
            total_memory_bytes: 64 * 1024 * 1024 * 1024, // 64 GB
            available_memory_bytes: 32 * 1024 * 1024 * 1024,
            cpu_count: 16,
        };
        let profile = TuningProfile::from_resources(&resources);
        assert_eq!(profile.shard_count, 16); // 16 cores → 16 shards
        assert_eq!(profile.segment_threshold, 8); // Compact later
    }

    #[test]
    fn test_write_buffer_limits_bounded() {
        let resources = SystemResources {
            total_memory_bytes: 512 * 1024 * 1024 * 1024, // 512 GB (extreme)
            available_memory_bytes: 256 * 1024 * 1024 * 1024,
            cpu_count: 64,
        };
        let profile = TuningProfile::from_resources(&resources);
        // Should be capped at 100MB despite huge RAM
        assert_eq!(profile.write_buffer_byte_limit, 100 * 1024 * 1024);
    }

    #[test]
    fn test_tuning_profile_default() {
        let profile = TuningProfile::default();
        assert_eq!(profile.shard_count, 4);
        assert_eq!(profile.segment_threshold, 4);
        assert_eq!(profile.write_buffer_node_limit, 50_000);
    }
}
```

**LOC estimate:** 150 (impl) + 50 (tests) = 200 LOC

---

### Phase 2: Adaptive Shard Count

**Files to modify:**
- `packages/rfdb-server/src/graph/engine_v2.rs:168-174`

**Current code (line 168):**

```rust
// Create storage with default shard count
let store = MultiShardStore::create(path, DEFAULT_SHARD_COUNT)?;
```

**Updated code:**

```rust
use crate::storage_v2::resource::ResourceManager;

// Adaptive shard count based on system resources
let profile = ResourceManager::auto_tune();
let store = MultiShardStore::create(path, profile.shard_count)?;
```

**Test (add to `engine_v2.rs` tests):**

```rust
#[test]
fn test_create_with_adaptive_shard_count() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path();

    // Create database (should use adaptive shard count)
    let engine = GraphEngineV2::create(path).unwrap();
    drop(engine);

    // Reopen and verify shard count is reasonable (1-16)
    let engine = GraphEngineV2::open(path).unwrap();
    let config = engine.database_config().unwrap();
    assert!(config.shard_count >= 1 && config.shard_count <= 16);
}
```

**LOC estimate:** 10 (impl) + 15 (test) = 25 LOC

---

### Phase 3: Adaptive Compaction Threshold

**Files to modify:**
- `packages/rfdb-server/src/storage_v2/compaction/types.rs:15-21`
- `packages/rfdb-server/src/storage_v2/multi_shard.rs:979` (compact call site)

**Current code (`compaction/types.rs:15`):**

```rust
impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            segment_threshold: 4,
        }
    }
}
```

**Updated code:**

```rust
use crate::storage_v2::resource::ResourceManager;

impl Default for CompactionConfig {
    fn default() -> Self {
        let profile = ResourceManager::auto_tune();
        Self {
            segment_threshold: profile.segment_threshold,
        }
    }
}
```

**Test (add to `compaction/types.rs` tests):**

```rust
#[test]
fn test_compaction_config_adaptive_default() {
    let config = CompactionConfig::default();
    // Should be in valid range [2, 8]
    assert!(config.segment_threshold >= 2 && config.segment_threshold <= 8);
}
```

**LOC estimate:** 10 (impl) + 8 (test) = 18 LOC

---

### Phase 4: Write Buffer Auto-Flush

**Files to modify:**
- `packages/rfdb-server/src/storage_v2/write_buffer.rs:52-76`
- `packages/rfdb-server/src/storage_v2/shard.rs:270-280`

#### Step 4a: Add memory estimation to WriteBuffer

**File:** `write_buffer.rs`

**Add method after line 150 (in `impl WriteBuffer`):**

```rust
/// Estimate memory usage in bytes.
///
/// Heuristic:
/// - Nodes: count × 120 bytes (100 bytes data + 20 bytes HashMap overhead)
/// - Edges: count × 50 bytes (40 bytes data + 10 bytes Vec overhead)
/// - Edge keys: count × 48 bytes (3×u128 + String ptr + HashSet overhead)
pub fn estimated_memory_bytes(&self) -> usize {
    const NODE_BYTES: usize = 120;
    const EDGE_BYTES: usize = 50;
    const EDGE_KEY_BYTES: usize = 48;

    self.nodes.len() * NODE_BYTES
        + self.edges.len() * EDGE_BYTES
        + self.edge_keys.len() * EDGE_KEY_BYTES
}

/// Number of nodes in buffer.
pub fn node_count(&self) -> usize {
    self.nodes.len()
}

/// Number of edges in buffer.
pub fn edge_count(&self) -> usize {
    self.edges.len()
}
```

**Test:**

```rust
#[test]
fn test_write_buffer_memory_estimation() {
    let mut buffer = WriteBuffer::new();
    assert_eq!(buffer.estimated_memory_bytes(), 0);

    // Add 1000 nodes
    for i in 0..1000 {
        buffer.add_node(NodeRecordV2 {
            id: i as u128,
            node_type: "test".to_string(),
            labels: vec![],
            attrs: HashMap::new(),
        });
    }

    let estimated = buffer.estimated_memory_bytes();
    // Should be ~120K bytes (1000 nodes × 120 bytes)
    assert!(estimated >= 100_000 && estimated <= 150_000);
}
```

**LOC estimate:** 30 (impl) + 15 (test) = 45 LOC

#### Step 4b: Auto-flush in Shard

**File:** `shard.rs`

**Current code (line 270):**

```rust
pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>) -> Result<()> {
    self.write_buffer.add_nodes(records);
    Ok(())
}
```

**Updated code:**

```rust
use crate::storage_v2::resource::ResourceManager;

pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>) -> Result<()> {
    self.write_buffer.add_nodes(records);

    // Auto-flush if buffer exceeds adaptive limits
    let profile = ResourceManager::auto_tune();
    if self.write_buffer.node_count() >= profile.write_buffer_node_limit
        || self.write_buffer.estimated_memory_bytes() >= profile.write_buffer_byte_limit
    {
        self.flush()?;
    }

    Ok(())
}
```

**Alternative (cache profile in Shard):**

To avoid calling `ResourceManager::auto_tune()` on every `add_nodes()` call, we could:
1. Add `tuning_profile: TuningProfile` field to `Shard` struct
2. Initialize it in `Shard::new()`
3. Use cached value in `add_nodes()`

**Trade-off:** Caching is faster but won't adapt to runtime memory changes. For v0.2, **re-compute on every add_nodes()** is acceptable (sysinfo is ~1μs overhead).

**Test:**

```rust
#[test]
fn test_shard_auto_flush_on_buffer_overflow() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path();

    let mut shard = Shard::create(path, 0).unwrap();

    // Add many nodes to trigger auto-flush
    let profile = ResourceManager::auto_tune();
    let nodes_to_add = profile.write_buffer_node_limit + 1000;

    for i in 0..nodes_to_add {
        let node = NodeRecordV2 {
            id: i as u128,
            node_type: "test".to_string(),
            labels: vec![],
            attrs: HashMap::new(),
        };
        shard.add_nodes(vec![node]).unwrap();
    }

    // Buffer should have auto-flushed, so should be small
    assert!(shard.write_buffer.node_count() < profile.write_buffer_node_limit);

    // Should have L0 segments from auto-flush
    assert!(shard.l0_node_segment_count() > 0);
}
```

**LOC estimate:** 20 (impl) + 20 (test) = 40 LOC

---

## Heuristic Formulas Summary

| Parameter | Formula | Range | Rationale |
|-----------|---------|-------|-----------|
| **Shard count** | `min(16, next_power_of_two(cpu_count))` if RAM >= 2GB, else 1 | [1, 16] | Balance parallelism vs overhead. Low memory → single shard. |
| **Segment threshold** | `2` if RAM < 4GB, `4` if < 16GB, else `8` | [2, 8] | Low memory → compact early, high memory → amortize cost. |
| **Write buffer (bytes)** | `clamp(available_memory × 0.02, 10MB, 100MB)` | [10MB, 100MB] | Use 2% of available RAM, prevent runaway growth. |
| **Write buffer (nodes)** | `buffer_bytes / 220` | [~45K, ~450K] | 220 bytes/node estimate (100 data + 120 overhead). |

**Bounds justification:**
- **Shard count [1, 16]:** Based on research showing diminishing returns and contention above 16 shards.
- **Segment threshold [2, 8]:** Below 2 = too frequent compaction, above 8 = too much read amplification.
- **Buffer [10MB, 100MB]:** Below 10MB = thrashing, above 100MB = OOM risk on small machines.

---

## Test Plan

### Unit Tests (~12 tests total)

**Phase 1: resource.rs (6 tests)**
1. `test_system_resources_detection` — Verify detection returns valid values
2. `test_tuning_profile_low_memory` — 1GB RAM → shard_count=1, threshold=2
3. `test_tuning_profile_medium_memory` — 8GB RAM → shard_count=4, threshold=4
4. `test_tuning_profile_high_memory` — 64GB RAM → shard_count=16, threshold=8
5. `test_write_buffer_limits_bounded` — Extreme RAM → capped at 100MB
6. `test_tuning_profile_default` — Default profile is conservative

**Phase 2: engine_v2.rs (1 test)**
7. `test_create_with_adaptive_shard_count` — New DB uses ResourceManager

**Phase 3: compaction/types.rs (1 test)**
8. `test_compaction_config_adaptive_default` — CompactionConfig::default() is adaptive

**Phase 4: write_buffer.rs + shard.rs (4 tests)**
9. `test_write_buffer_memory_estimation` — estimated_memory_bytes() is accurate
10. `test_write_buffer_node_count` — node_count() works
11. `test_shard_auto_flush_on_buffer_overflow` — Auto-flush triggers
12. `test_shard_auto_flush_respects_byte_limit` — Flush on byte limit (not just node count)

### Integration Tests (optional, if time allows)

**Stress test:**
- Load 10M nodes on 4GB RAM mock → verify no OOM
- Compare performance: adaptive vs fixed config (should be 10-20% faster)

---

## Risk Assessment

### Low Risk
- **Phase 1 (Detection):** Pure computation, no side effects
- **Phase 2 (Shard count):** Only affects new databases, immutable after creation
- **Phase 3 (Compaction threshold):** Backward compatible, just changes trigger timing

### Medium Risk
- **Phase 4 (Auto-flush):** Changes write path behavior
  - **Mitigation:** Only triggers when buffer is full, preserves correctness
  - **Test coverage:** Verify flush doesn't corrupt data (existing flush tests cover this)

### High Risk (deferred)
- **Parallel compaction:** Requires Send+Sync refactor (out of scope)
- **Bloom filter adaptation:** Requires format versioning (out of scope)

### Edge Cases

**1. Resource detection failure:**
- If `sysinfo` fails → fall back to `TuningProfile::default()`
- Conservative defaults (4 shards, 4 threshold, 50K nodes)

**2. Extreme memory (< 512MB):**
- Heuristic: 1 shard, threshold=2, buffer=10MB
- RFDB may still OOM if dataset is huge — document minimum requirements

**3. Resource changes during operation:**
- Current implementation: Re-query on every auto-flush check
- If RAM drops mid-operation → will trigger flush earlier (correct behavior)
- No risk of incorrect adaptation

**4. Write buffer thrashing:**
- If buffer limit is too small (e.g., 10K nodes) → frequent flushes
- **Mitigation:** 10MB minimum ensures at least ~45K nodes (~100 flushes for 1M nodes = acceptable)

---

## Backward Compatibility

**Database format:** No changes. Adaptive parameters are runtime-only.

**Existing databases:**
- Shard count is immutable (stored in `db_config.json`) → no change
- Compaction threshold adapts on every `compact()` call → works with old databases
- Auto-flush is transparent → no manifest changes

**Upgrading RFDB:**
- Old databases continue to work
- New databases benefit from adaptive tuning
- No migration required

---

## Open Questions for User

1. **Prefetch strategy:** The spec mentions it, but RFDB has no prefetch infrastructure. Should we:
   - Defer entirely to future work?
   - Add madvise(MADV_SEQUENTIAL) hints for mmap'd segments?
   - Document as "not applicable for v0.2"?

   **Recommendation:** Document as future work. OS page cache already handles read-ahead for mmap'd files.

2. **Auto-flush overhead:** Re-querying `ResourceManager` on every `add_nodes()` call adds ~1μs overhead. Should we:
   - Cache `TuningProfile` in `Shard` (faster, less adaptive)?
   - Re-query on every call (slower, more adaptive)?

   **Recommendation:** Re-query for v0.2 (simple), cache in v0.3 if profiling shows bottleneck.

3. **Memory pressure signals:** Should RFDB respond to OS memory pressure notifications (e.g., Linux PSI)?
   - **Pro:** More accurate than polling `available_memory()`
   - **Con:** Platform-specific, complex implementation

   **Recommendation:** Defer to v0.3. Current polling approach is cross-platform and good enough.

---

## Implementation Checklist

- [ ] **Phase 1:** Create `storage_v2/resource.rs` with ResourceManager, SystemResources, TuningProfile
- [ ] **Phase 1:** Add 6 unit tests for resource detection and tuning profiles
- [ ] **Phase 2:** Update `engine_v2.rs:168` to use adaptive shard count
- [ ] **Phase 2:** Add 1 integration test for adaptive database creation
- [ ] **Phase 3:** Update `compaction/types.rs` CompactionConfig::default() to be adaptive
- [ ] **Phase 3:** Add 1 test for adaptive compaction config
- [ ] **Phase 4:** Add `estimated_memory_bytes()`, `node_count()`, `edge_count()` to WriteBuffer
- [ ] **Phase 4:** Update `shard.rs:270` to auto-flush when limits exceeded
- [ ] **Phase 4:** Add 4 tests for memory estimation and auto-flush
- [ ] Run full test suite (`cargo test`)
- [ ] Manual validation: create DB on low-RAM VM (512MB) → verify shard_count=1, threshold=2

---

## Success Criteria

**Functional:**
- [ ] Low-memory system (1GB) creates database with shard_count=1
- [ ] High-memory system (64GB) creates database with shard_count=16
- [ ] Write buffer auto-flushes before OOM
- [ ] Compaction threshold adapts to available memory
- [ ] All 12 tests pass

**Performance:**
- [ ] No measurable overhead (<1% slowdown) on write path
- [ ] Adaptive config is 10-20% faster than fixed config on memory-constrained systems

**Quality:**
- [ ] No regressions in existing tests
- [ ] Code matches existing RFDB style (columnar comments, compact logic)
- [ ] Documentation explains heuristics and bounds

---

## References

**Prior art:**
- [RocksDB Write Buffer Manager](https://github.com/facebook/rocksdb/wiki/Write-Buffer-Manager)
- [EcoTune: Rethinking Compaction Policies in LSM-trees](https://people.iiis.tsinghua.edu.cn/~huanchen/publications/ecotune-sigmod25.pdf)
- [Revisiting Multi-threaded Compaction in LSM-trees](https://discos.sogang.ac.kr/file/2025/intl_conf/ICPP_2025_H_Byun.pdf)
- [Adaptive Memory Management in LSM-based Storage (VLDB)](https://vldb.org/pvldb/vol14/p241-luo.pdf)

**Related RFD issues:**
- RFD-20: Background Compaction (dependency, completed)
- RFD-34: Automatic compaction trigger (v0.2, deferred)
- RFD-35: O(N) memory during compaction (v0.3, low priority)
- RFD-36: Parallel Compaction (v0.3+, deferred)
- RFD-37: Segment Format v3 (v0.3+, for bloom filter adaptation)

---

**End of Implementation Plan**
