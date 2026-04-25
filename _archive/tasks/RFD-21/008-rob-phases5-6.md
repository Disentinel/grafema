# Rob Implementation Report: RFD-21 Phases 5-6

**Date:** 2026-02-15
**Agent:** Rob Pike (Implementation Engineer)
**Task:** Implement Phases 5 and 6 of RFD-21: Resource Adaptation

---

## Summary

Implemented parallel compaction (Phase 5) and OS-level prefetch hints (Phase 6) for RFDB v2, completing the full RFD-21 scope.

All changes compile cleanly and pass 661 tests (576 lib + 52 bin + 9 crash_recovery + 4 stress + 9 v1_v2_equivalence + 11 doc-tests, 3 ignored). Zero regressions.

---

## Phase 5: Parallel Compaction

**Files modified:**
- `src/storage_v2/multi_shard.rs` -- refactored `compact()` into three-phase parallel architecture

**Architecture:**

The original `compact()` method had a single sequential loop that interleaved:
1. Checking if shards need compaction
2. Running `compact_shard()` (CPU-intensive merge + sort)
3. Writing results to disk and updating shard state

The refactored version splits into three clean phases:

**Phase 1 (sequential):** Classify shards. For non-compacted shards, preserve their L1 descriptors and global index entries. For compacted shards, add their index to `shards_to_compact`.

**Phase 2 (parallel):** Run `compact_shard()` via rayon on all identified shards. Each call takes `&Shard` (immutable) and returns an owned `ShardCompactionResult`. The key insight: `compact_shard()` already extracts all data it needs into owned Vecs, so parallelism is safe without any new data structures.

**Phase 3 (sequential):** Apply results -- write segments to disk, build inverted indexes, update shard state, commit manifest.

**Thread count:** Uses `TuningProfile::compaction_threads` (1-4 based on RAM/CPU), already implemented in Phase 1. When threads <= 1 or only 1 shard needs compaction, the sequential path runs without rayon thread pool overhead.

**API change:** Added `compact_with_threads()` method that accepts an explicit thread count (used by tests). The original `compact()` delegates to it with `None` (auto-detect).

**Lines changed:** ~35 net (restructured existing ~110 lines, adding parallelism scaffolding)

**Test added:** `test_parallel_compaction_correctness` -- builds two identical 4-shard stores, compacts one with `threads=1` and the other with `threads=4`, verifies identical results (same shard counts, same merged node counts, same L1 record IDs per shard).

---

## Phase 6: Prefetch Strategy

**Files modified:**
- `Cargo.toml` -- added `libc = "0.2"` dependency
- `src/storage_v2/segment.rs` -- added `prefetch_file()` function
- `src/storage_v2/multi_shard.rs` -- added prefetch calls before compaction
- `src/storage_v2/shard.rs` -- added `l0_node_descriptors()` and `l0_edge_descriptors()` accessors

**Implementation:**

`prefetch_file(path)` opens the file and, on Linux, issues `posix_fadvise(fd, 0, 0, POSIX_FADV_WILLNEED)` to trigger asynchronous kernel readahead. On macOS/non-Linux platforms, the function still opens the file (warming the page cache as a side effect) but does not issue advisory calls since macOS lacks `posix_fadvise`.

**Platform handling:** Rather than using `#[cfg(unix)]` with macOS-specific `fcntl(F_RDADVISE)`, I chose `#[cfg(target_os = "linux")]` for the fadvise call since:
- RFDB's production target is Linux servers
- macOS usage is development-only
- The fallback (file open without advisory) still provides some benefit

**Integration:** Prefetch runs between Phase 1 (classify shards) and Phase 2 (parallel compaction) in `compact_with_threads()`. For each shard needing compaction, it prefetches:
- All L0 node segment files
- All L0 edge segment files
- L1 node segment file (if exists)
- L1 edge segment file (if exists)

Errors from prefetch are silently ignored (`.ok()`) -- this is a best-effort optimization with no correctness impact.

**Shard accessors added:** `l0_node_descriptors()` and `l0_edge_descriptors()` expose the private `node_descriptors` and `edge_descriptors` fields needed to construct segment file paths for prefetching.

**Lines changed:** ~30 (prefetch function + integration + accessors)

**Test added:** `test_prefetch_file_smoke` -- writes a segment file to a temp path, calls `prefetch_file()` successfully, then verifies a nonexistent path returns an error (not a crash).

---

## Test Results

| Test Suite | Tests | Result |
|-----------|-------|--------|
| lib (all) | 576 | PASS |
| bin (rfdb_server) | 52 | PASS |
| crash_recovery | 9 | PASS |
| stress | 4 | PASS |
| v1_v2_equivalence | 9 | PASS |
| doc-tests | 11 (3 ignored) | PASS |
| **Total** | **661** | **ALL PASS** |

New tests added in this PR:
- `test_parallel_compaction_correctness` (multi_shard.rs)
- `test_prefetch_file_smoke` (segment.rs)

---

## Files Modified

| File | Lines Added | Lines Changed |
|------|------------|---------------|
| `Cargo.toml` | 3 | 0 |
| `src/storage_v2/segment.rs` | ~35 | 0 |
| `src/storage_v2/shard.rs` | ~10 | 0 |
| `src/storage_v2/multi_shard.rs` | ~100 | ~110 (restructured compact loop) |
| **Total** | **~148** | **~110** |

---

## LOC vs Plan

| Phase | Plan LOC | Actual LOC | Notes |
|-------|----------|------------|-------|
| Phase 5 | ~52 | ~35 impl + ~45 test | No new CompactionTask struct needed -- compact_shard() already returns owned data |
| Phase 6 | ~35 | ~30 impl + ~12 test | Simpler platform handling (Linux-only fadvise, open-only on macOS) |
| **Total** | **~87** | **~65 impl + ~57 test** | Under budget |

---

## Design Decisions

1. **No `CompactionTask` struct:** The plan proposed a new `CompactionTask` struct to extract data from shards before parallel processing. This turned out to be unnecessary because `compact_shard()` already takes `&Shard`, extracts all needed data into owned collections, and returns an owned `ShardCompactionResult`. The parallelism simply required calling `compact_shard()` from multiple rayon threads.

2. **Scoped thread pool per compaction:** Each compaction creates a fresh `rayon::ThreadPoolBuilder` with the adaptive thread count. This avoids global state and ensures thread count adapts to current system conditions.

3. **Sequential fast path:** When `threads <= 1` or only one shard needs compaction, the code skips rayon entirely and runs the sequential path. This avoids thread pool creation overhead for the common case.

4. **Platform-specific prefetch:** Used `#[cfg(target_os = "linux")]` instead of `#[cfg(unix)]` to avoid macOS compilation issues (`posix_fadvise` doesn't exist on Darwin). The function still opens the file on all platforms, providing some page cache warming.

5. **Prefetch placement:** Prefetch runs between shard classification and parallel compaction, maximizing the time window for the OS to complete readahead before the data is needed.
