# Rob Implementation Report: RFD-21 Phases 2-4

**Date:** 2026-02-15
**Agent:** Rob Pike (Implementation Engineer)
**Task:** Implement Phases 2, 3, and 4 of RFD-21: Resource Adaptation

---

## Summary

Implemented three phases of adaptive resource management for RFDB v2, building on the Phase 1 foundation (`resource.rs` with `SystemResources`, `TuningProfile`, `ResourceManager`).

All changes compile cleanly and pass 359+ targeted tests (28 engine_v2, 331 storage_v2) plus 22 integration tests. The only test failure observed is a pre-existing flaky test in the v1 engine (`test_find_by_attr_file_filter_delta`) caused by memory pressure on the host machine, unrelated to these changes.

---

## Phase 2: Adaptive Shard Count

**File:** `packages/rfdb-server/src/graph/engine_v2.rs`

**Change:** `GraphEngineV2::create()` now uses `ResourceManager::auto_tune()` to determine shard count based on system RAM and CPU cores, instead of the hardcoded `DEFAULT_SHARD_COUNT = 4`.

- `create()` uses adaptive shard count (production path)
- `create_ephemeral()` and `clear()` retain `DEFAULT_SHARD_COUNT` for test determinism
- `DEFAULT_SHARD_COUNT` kept as a fallback constant

**Lines changed:** ~5 (net)

**Test added:** `test_adaptive_shard_count_on_disk` -- creates a disk DB, verifies shard_count is in [1, 16].

---

## Phase 3: Adaptive Compaction Threshold

**File:** `packages/rfdb-server/src/storage_v2/compaction/types.rs`

**Change:** Added `CompactionConfig::from_profile()` constructor that creates a config from a `TuningProfile`. The existing `Default` impl is left untouched (no side-effectful Default).

```rust
impl CompactionConfig {
    pub fn from_profile(profile: &TuningProfile) -> Self {
        Self { segment_threshold: profile.segment_threshold }
    }
}
```

**Lines changed:** ~12 (impl + import)

**Tests added:** 3 tests
- `test_compaction_config_from_profile_low_memory` -- 1 GB RAM -> threshold = 2
- `test_compaction_config_from_profile_high_memory` -- 64 GB RAM -> threshold = 8
- `test_compaction_config_from_profile_range` -- verifies threshold is always in [2, 8]

---

## Phase 4: Write Buffer Auto-Flush + Memory Pressure

### Step 4a: WriteBuffer memory estimation

**File:** `packages/rfdb-server/src/storage_v2/write_buffer.rs`

Added two methods:
- `estimated_memory_bytes()` -- approximate memory usage based on entry counts
- `exceeds_limits(node_limit, byte_limit)` -- check if buffer exceeds adaptive limits

`node_count()` and `edge_count()` already existed.

**Lines changed:** ~20

**Tests added:** 4 tests
- `test_estimated_memory_bytes_empty` -- empty buffer = 0 bytes
- `test_estimated_memory_bytes_nodes_only` -- 2 nodes = 240 bytes
- `test_estimated_memory_bytes_mixed` -- 1 node + 1 edge = 218 bytes
- `test_estimated_memory_bytes_proportional` -- 20 nodes = 2x of 10 nodes

### Step 4b: Auto-flush in engine

**Architecture decision:** The plan suggested adding auto-flush in `Shard::add_nodes()`, but `flush_with_ids()` requires segment IDs from the manifest, which `Shard` intentionally does not own. Rather than storing manifest references in Shard (breaking the clean separation of concerns), I implemented auto-flush at the `GraphEngineV2` level, which is the only place that has both `MultiShardStore` and `ManifestStore`.

**Files modified:**

1. **`shard.rs`** -- Added `write_buffer_exceeds()` method (delegates to `WriteBuffer::exceeds_limits()`)

2. **`multi_shard.rs`** -- Added two methods:
   - `any_shard_needs_flush(node_limit, byte_limit)` -- checks if any shard's buffer exceeds limits
   - `total_write_buffer_nodes()` -- total unflushed node count across all shards

3. **`engine_v2.rs`** -- Added `maybe_auto_flush()` private method called from `add_nodes()`:
   - Probes system resources via `SystemResources::detect()`
   - Computes adaptive limits via `TuningProfile::from_resources()`
   - Flushes if any shard exceeds node count or byte limits
   - Under high memory pressure (>80%), flushes if buffer has >= 1000 nodes
   - Errors are logged but do not propagate (write path must not fail)

**Key design choice:** The memory pressure flush requires a minimum of 1000 buffered nodes. Without this floor, systems running at high memory usage (common on macOS) would flush after every tiny `add_nodes()` call, which breaks the write-buffering optimization. The 1000-node threshold ensures pressure-based flush only triggers when there's meaningful data worth flushing.

**Lines changed:** ~35

**Tests added:** 2 tests
- `test_auto_flush_triggers_on_buffer_limit` -- verifies `any_shard_needs_flush()` logic with node count
- `test_auto_flush_byte_limit` -- verifies byte-based limit checking

---

## Test Results

| Test Suite | Tests | Result |
|-----------|-------|--------|
| engine_v2 (all) | 28 | PASS |
| storage_v2 (all) | 331 | PASS |
| crash_recovery | 9 | PASS |
| stress | 4 | PASS |
| v1_v2_equivalence | 9 | PASS |

**Pre-existing flaky test:** `graph::engine::tests::test_find_by_attr_file_filter_delta` fails in the full suite under memory pressure (v1 engine) but passes in isolation. Not caused by these changes.

---

## Files Modified

| File | Lines Added | Lines Changed |
|------|------------|---------------|
| `src/graph/engine_v2.rs` | ~65 | ~5 |
| `src/storage_v2/compaction/types.rs` | ~50 | 0 |
| `src/storage_v2/write_buffer.rs` | ~60 | 0 |
| `src/storage_v2/shard.rs` | ~10 | 0 |
| `src/storage_v2/multi_shard.rs` | ~15 | 0 |
| **Total** | **~200** | **~5** |

---

## LOC vs Plan

| Phase | Plan LOC | Actual LOC | Notes |
|-------|----------|------------|-------|
| Phase 2 | ~25 | ~5 impl + ~15 test | Simpler than planned: only `create()` needed changing |
| Phase 3 | ~18 | ~12 impl + ~45 test | More tests than planned (3 vs 1) |
| Phase 4 | ~75 | ~65 impl + ~65 test | Architecture adapted: flush at engine level, not shard |
| **Total** | **~118** | **~82 impl + ~125 test** | Within budget, more test coverage |
