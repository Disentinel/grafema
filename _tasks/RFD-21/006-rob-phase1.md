# Rob Pike - Phase 1 Implementation Report: Resource Detection

**Date:** 2026-02-15
**Phase:** 1 - Detection Infrastructure
**Files changed:** 3

---

## What Was Built

New file `packages/rfdb-server/src/storage_v2/resource.rs` (~150 LOC) containing:

### `SystemResources` struct
- Detects total RAM, available RAM, and CPU count via `sysinfo` crate
- `detect()` method probes the live system
- `memory_pressure()` returns 0.0-1.0 ratio: `1.0 - (available / total)`
- Edge case: returns 1.0 if total memory is 0

### `TuningProfile` struct
Adaptive parameters computed from resources with these heuristics:

| Parameter | Formula | Range |
|-----------|---------|-------|
| `shard_count` | `min(16, next_power_of_two(cpu_count))` if RAM >= 2GB, else 1 | [1, 16] |
| `segment_threshold` | RAM < 4GB -> 2, < 16GB -> 4, else 8 | [2, 8] |
| `write_buffer_byte_limit` | `clamp(available * 0.02, 10MB, 100MB)` | [10MB, 100MB] |
| `write_buffer_node_limit` | `buffer_bytes / 220` | derived |
| `compaction_threads` | RAM < 4GB -> 1, else `clamp(cpu / 2, 1, 4)` | [1, 4] |

`Default` impl provides conservative values for tests: 4 shards, 4 threshold, 50K nodes, 10MB buffer, 1 thread.

### `ResourceManager` utility
Stateless combinator: `auto_tune()` calls `detect()` then `from_resources()`.

## Additional Fix

Fixed pre-existing compilation error in `compaction/coordinator.rs:272,276`: test called `shard.add_edges()` which doesn't exist on `Shard` (correct method is `upsert_edges()`). This was blocking all test compilation in the crate.

## Tests (8/8 passing)

1. `test_system_resources_detection` - live detection returns valid values
2. `test_tuning_profile_low_memory` - 1GB/4CPU -> shard=1, threshold=2, threads=1
3. `test_tuning_profile_medium_memory` - 8GB/4CPU -> shard=4, threshold=4, threads=2
4. `test_tuning_profile_high_memory` - 64GB/16CPU -> shard=16, threshold=8, threads=4
5. `test_write_buffer_limits_bounded` - 512GB -> capped at 100MB
6. `test_write_buffer_limits_minimum` - 256MB available -> floored at 10MB
7. `test_tuning_profile_default` - default() returns expected conservative values
8. `test_memory_pressure` - 1GB total / 256MB available -> pressure = 0.75

## Files

| File | Action | Lines |
|------|--------|-------|
| `packages/rfdb-server/src/storage_v2/resource.rs` | Created | ~200 (impl + tests) |
| `packages/rfdb-server/src/storage_v2/mod.rs` | Modified | +2 lines (module + re-export) |
| `packages/rfdb-server/src/storage_v2/compaction/coordinator.rs` | Fixed | 2 lines (pre-existing bug) |

## Style Notes

- Matched existing RFDB patterns: section comments with `// -- Section --`, doc comments on all public items
- Constants extracted to module-level with descriptive names
- Tests use a `make_resources()` helper to construct synthetic inputs (matches `make_node()`/`make_edge()` pattern in write_buffer.rs)
- No external dependencies added (sysinfo already in Cargo.toml)
