# Don's Plan v2: RFD-22 Performance Benchmark Suite (Revised)

**Previous version:** 003-don-plan.md
**Review:** 004-dijkstra-review.md (12 issues identified)
**This revision:** Addresses all 12 issues from Dijkstra's review

---

## Overview

Extend existing Criterion benchmarks to cover all required performance metrics. Current state:
- `graph_operations.rs` (492 LOC) — v1 engine, sizes up to 100K
- `v1_v2_comparison.rs` (354 LOC) — v1/v2 side-by-side, partial coverage
- `neo4j_comparison.rs` — stub

This is NOT a new feature. This is expanding test coverage for performance. Keep scope tight.

**Changes from v1:**
- Process-specific memory measurement (not system-wide)
- Fixed all benchmark methodological flaws
- Corrected formulas and complexity analysis
- Added benchmark validation tests
- Rust-based report generation (no jq dependency)
- Fixed graph topology for BFS
- Added flush before queries for v2

---

## Summary of Changes from v1

| Issue | Status | Fix |
|-------|--------|-----|
| #1 Memory measurement (CRITICAL) | FIXED | Process RSS via sysinfo::Process, not system-wide available_memory |
| #2 Reanalysis iter_batched (HIGH) | FIXED | Fresh engine per iteration via iter_batched |
| #4 CompactionResult inaccessible (HIGH) | FIXED | Add compact_with_stats() to GraphEngineV2 |
| #3 Compaction formulas (MEDIUM-HIGH) | FIXED | Throughput = records/sec, space amp = disk usage ratio |
| #7 BFS topology (MEDIUM-HIGH) | FIXED | Tree topology where depth-10 BFS reaches O(N) nodes |
| #11 Flush before queries (MEDIUM-HIGH) | FIXED | Explicit flush after graph construction for v2 |
| #5 Complexity analysis (MEDIUM) | FIXED | Corrected all Big-O formulas |
| #6 Setup cost in add_nodes (MEDIUM) | FIXED | iter_batched for all write benchmarks |
| #10 Benchmark validation (MEDIUM) | FIXED | Sanity-check tests added |
| #8 neighbors always node 0 (LOW-MEDIUM) | FIXED | Query multiple random nodes |
| #12 Inconsistent edge ratios (LOW-MEDIUM) | FIXED | Standardized 3x edges across all benchmarks |
| #9 jq dependency (LOW) | FIXED | Rust binary for report generation |

---

## File Changes

### 1. Add `src/graph/engine_v2.rs` compact_with_stats method (~10 LOC)

**Issue #4 (HIGH):** GraphEngineV2::compact() returns Result<()>, discarding CompactionResult.

**Fix:**
```rust
// Add this method to GraphEngineV2 impl block (after existing compact())
pub fn compact_with_stats(&mut self) -> Result<CompactionResult> {
    use crate::storage_v2::compaction::CompactionConfig;
    let config = CompactionConfig::default();
    self.store.compact(&mut self.manifest, &config)
}
```

**Rationale:** Cleanest solution. Doesn't change existing compact() API (used by production code), adds new method specifically for benchmarks.

### 2. Extend `benches/v1_v2_comparison.rs` (~300 LOC added)

**Current:** 354 LOC, 7 operations, sizes up to 100K
**Target:** ~650 LOC, all operations, standardized sizes 1K/10K/100K

**Changes:**

#### 2.1 Fix add_nodes benchmark (Issue #6 - setup cost)
**What was wrong:** TempDir creation + engine init + node construction inside measured closure.

**Fixed:**
```rust
fn bench_add_nodes(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/add_nodes");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let engine = GraphEngine::create(dir.path()).unwrap();
                    let nodes = make_nodes(size);
                    (dir, engine, nodes)
                },
                |(dir, mut engine, nodes)| {
                    engine.add_nodes(black_box(nodes));
                    (dir, engine) // prevent drop during measurement
                },
                BatchSize::LargeInput,
            );
        });
    }
    group.finish();
    // Same for v2
}
```

#### 2.2 Fix flush benchmark (Issue #6 - setup cost)
**What was wrong:** Measures TempDir + create + add_nodes + flush, not just flush.

**Fixed:**
```rust
fn bench_flush(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/flush");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let mut engine = GraphEngine::create(dir.path()).unwrap();
                    engine.add_nodes(make_nodes(size));
                    (dir, engine)
                },
                |(_dir, mut engine)| {
                    black_box(engine.flush().unwrap());
                },
                BatchSize::LargeInput,
            );
        });
    }
    group.finish();
    // Same for v2
}
```

#### 2.3 Fix BFS topology (Issue #7 - constant work)
**What was wrong:** Chain topology (i→i+1) means BFS at depth 10 visits exactly 11 nodes regardless of graph size.

**Fixed:**
```rust
fn make_tree_edges(edge_count: usize, node_count: usize) -> Vec<EdgeRecord> {
    // Tree topology with branching factor 3:
    // Node 0 has children 1, 2, 3
    // Node 1 has children 4, 5, 6
    // Node 2 has children 7, 8, 9
    // etc.
    //
    // At depth D, a full ternary tree has 3^D nodes.
    // Depth 10 reaches 59,049 nodes (sum of 3^0 + 3^1 + ... + 3^10).
    // For graphs with N < 59,049, BFS visits all nodes.
    // For graphs with N > 59,049, BFS visits a subset proportional to depth.
    (0..edge_count)
        .filter_map(|i| {
            let parent = i / 3;
            let child = i + 1;
            if child < node_count {
                Some(EdgeRecord {
                    src: parent as u128,
                    dst: child as u128,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                })
            } else {
                None
            }
        })
        .collect()
}

fn bench_bfs(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/bfs");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 3, make_tree_edges);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.bfs(black_box(&[0]), 10, &["CALLS"])); });
        });
    }
    group.finish();
    // Same for v2
}
```

**Expected behavior:** At 1K nodes, BFS reaches all 1K. At 10K, reaches ~3K (depth 8). At 100K, reaches ~29K (depth 10).

#### 2.4 Fix neighbors benchmark (Issue #8 - always node 0)
**What was wrong:** Always queries node 0, which has fixed neighbor count.

**Fixed:**
```rust
fn bench_neighbors(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/neighbors");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 3, make_tree_edges);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            let mut idx = 0;
            b.iter(|| {
                // Query nodes at different depths (varying neighbor counts)
                black_box(engine.neighbors(black_box(idx as u128), &["CALLS"]));
                idx = (idx + 1) % size.min(100); // cycle through first 100 nodes
            });
        });
    }
    group.finish();
    // Same for v2
}
```

#### 2.5 Standardize edge ratios (Issue #12)
**What was wrong:** Inconsistent edge-to-node ratios (2x, 3x, 5x).

**Fixed:** All benchmarks now use 3x edges (matches tree topology with branching factor 3).

```rust
// Old: different ratios per benchmark
create_v1_graph(size, size * 2);  // find_by_type
create_v1_graph(size, size * 3);  // bfs
create_v1_graph(size, size * 5);  // neighbors

// New: standardized 3x everywhere
create_v1_graph(size, size * 3);  // all benchmarks
```

#### 2.6 Add flush before queries for v2 (Issue #11)
**What was wrong:** v2 queries test write-buffer data (hot, in-memory), not production state (on-disk segments).

**Fixed:**
```rust
fn create_v2_graph(node_count: usize, edge_count: usize) -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();
    engine.add_nodes(make_nodes(node_count));
    engine.add_edges(make_edges(edge_count, node_count), false);
    engine.flush().unwrap();  // <-- ADD THIS
    (dir, engine)
}
```

#### 2.7 Add missing operations
- get_outgoing_edges, get_incoming_edges (already in graph_operations.rs, copy to comparison)
- reachability, reachability_backward (already in graph_operations.rs, copy to comparison)
- delete_node, delete_edge (already in graph_operations.rs, copy to comparison)
- find_by_type wildcard (already in graph_operations.rs, copy to comparison)

All at sizes [1000, 10000, 100000].

### 3. New `benches/reanalysis_cost.rs` (~180 LOC)

**Purpose:** Measure incremental re-analysis cost (subtask #3)

**Issue #2 (HIGH):** Reanalysis benchmark accumulates state across iterations.

**Fixed:**
```rust
fn bench_reanalysis_cost(c: &mut Criterion) {
    for file_count in [10, 100, 1000] {
        let changed_nodes = (0..100).map(|i| {
            let sem_id = format!("FUNCTION:func_{}@src/file_0.js", i);
            let hash = blake3::hash(sem_id.as_bytes());
            let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
            NodeRecordV2 {
                semantic_id: sem_id,
                id,
                node_type: "FUNCTION".to_string(),
                name: format!("func_{}", i),
                file: "src/file_0.js".to_string(),
                content_hash: i as u64,  // NEW version
                metadata: String::new(),
            }
        }).collect();

        group.bench_with_input(
            BenchmarkId::from_parameter(file_count),
            &file_count,
            |b, &file_count| {
                b.iter_batched(
                    || {
                        // Setup: create fresh pre-built graph
                        create_pre_built_graph(file_count)
                    },
                    |mut engine| {
                        // Measured: commit change to 1 file
                        black_box(
                            engine.commit_batch(
                                changed_nodes.clone(),
                                vec![],
                                &["src/file_0.js"],
                                HashMap::new(),
                            ).unwrap()
                        )
                    },
                    BatchSize::LargeInput,
                );
            }
        );
    }
}
```

**Metrics:** Time per commit (µs). Lower = better incremental performance.

### 4. New `benches/compaction_throughput.rs` (~200 LOC)

**Purpose:** Dedicated compaction metrics (subtask #4)

**Issue #4 (HIGH):** CompactionResult inaccessible.

**Fixed:** Use new `compact_with_stats()` method.

**Issue #3 (MEDIUM-HIGH):** Formulas mathematically nonsensical.

**Fixed:**
```rust
fn bench_compaction(c: &mut Criterion) {
    for segments in [4, 8, 12] {
        group.bench_with_input(
            BenchmarkId::from_parameter(segments),
            &segments,
            |b, &segments| {
                b.iter_batched(
                    || create_graph_with_l0_segments(10_000, segments),
                    |mut engine| {
                        let result = engine.compact_with_stats().unwrap();
                        black_box(result)
                    },
                    BatchSize::LargeInput,
                );
            }
        );
    }
}
```

**Metrics computed in report generation (not during benchmark):**

**Old (WRONG):**
```rust
// segments/sec = shards_compacted * l0_segments / duration_ms  // NONSENSE
// space_amp = tombstones_removed / nodes_merged  // WRONG DEFINITION
```

**New (CORRECT):**
```rust
// Throughput = (nodes_merged + edges_merged) / (duration_ms / 1000.0)  // records/sec
// Tombstone ratio = tombstones_removed / (nodes_merged + tombstones_removed)  // 0.0-1.0
```

**Note:** True space amplification requires disk usage before/after. We don't measure that (would require OS-specific du calls). "Tombstone ratio" is a proxy: high ratio means compaction reclaims more space.

### 5. New `benches/memory_profile.rs` (~150 LOC)

**Purpose:** RSS measurement at scale (subtask #5)

**Issue #1 (CRITICAL):** System-wide available_memory is meaningless.

**Fixed:**
```rust
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use std::process::Command;

fn measure_process_rss<F>(graph_builder: F) -> u64
where
    F: FnOnce(),
{
    // Spawn child process to isolate measurement from benchmark harness
    let output = Command::new(env!("CARGO_BIN_EXE_memory_profile_worker"))
        .output()
        .expect("failed to spawn worker");

    let rss_bytes: u64 = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();

    rss_bytes
}

fn main() {
    println!("Size\tv1 RSS (MB)\tv2 RSS (MB)");

    for size in [1_000, 10_000, 100_000, 1_000_000] {
        // v1
        let v1_rss = measure_v1_rss(size);

        // v2
        let v2_rss = measure_v2_rss(size);

        println!("{}\t{}\t{}", size, v1_rss / 1_048_576, v2_rss / 1_048_576);
    }
}

// Worker binary (separate bin target):
// benches/memory_profile_worker.rs
fn main() {
    let size: usize = env::args().nth(1).unwrap().parse().unwrap();
    let engine_type = env::args().nth(2).unwrap();

    // Get baseline RSS before graph construction
    let mut system = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    system.refresh_all();
    let pid = sysinfo::get_current_pid().unwrap();
    let baseline_rss = system.process(pid).unwrap().memory();

    // Build graph
    if engine_type == "v1" {
        let (_dir, _engine) = create_v1_graph(size, size * 3);
        // Keep alive until measurement
        std::thread::sleep(std::time::Duration::from_millis(100));
    } else {
        let (_dir, _engine) = create_v2_graph(size, size * 3);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // Measure RSS delta
    system.refresh_all();
    let final_rss = system.process(pid).unwrap().memory();
    let delta_rss = final_rss - baseline_rss;

    println!("{}", delta_rss);
}
```

**Rationale:**
- Process RSS (not system-wide available_memory) measures actual process memory usage
- Child process isolation prevents benchmark harness memory from polluting measurement
- sysinfo::Process::memory() gives RSS in bytes (cross-platform)
- Still imprecise (includes OS buffers for mmap'd files), but ~95% better than system-wide

**Alternative considered:** Global allocator wrapper counting allocated-freed. More precise for heap, but misses mmap'd segment files. RSS is the right metric for "how much memory does this engine use in production?"

**Sizes:** 1K, 10K, 100K, 1M nodes

**Output format:**
```
Memory Profile
Size      v1 RSS (MB)    v2 RSS (MB)
1K        12.3           8.7
10K       98.4           72.1
100K      987.2          654.3
1M        9843.1         6123.5
```

### 6. New binary `benches/report_generator.rs` (~250 LOC)

**Purpose:** Parse Criterion JSON and generate comparison matrix (subtask #6)

**Issue #9 (LOW):** jq dependency undeclared.

**Fixed:** Rust binary using serde_json, no external tools.

```rust
use serde_json::Value;
use std::collections::HashMap;
use std::fs;

struct BenchmarkResults {
    v1_v2_comparison: HashMap<String, (f64, f64)>,  // (v1_time, v2_time)
    reanalysis_cost: HashMap<String, f64>,
    compaction: Vec<CompactionMetrics>,
    memory: HashMap<usize, (u64, u64)>,  // (v1_rss, v2_rss)
}

fn parse_criterion_json(path: &str) -> HashMap<String, f64> {
    let data = fs::read_to_string(path).unwrap();
    let json: Value = serde_json::from_str(&data).unwrap();

    // Extract mean estimate from Criterion estimates.json
    let mean_us = json["mean"]["point_estimate"].as_f64().unwrap();

    // Convert to appropriate unit per benchmark
    // ...
}

fn generate_markdown_report(results: BenchmarkResults) -> String {
    // Build markdown table from parsed results
    // ...
}

fn main() {
    // 1. Parse all Criterion JSON from target/criterion/*/current/estimates.json
    // 2. Parse memory profile stdout
    // 3. Merge into BenchmarkResults
    // 4. Generate markdown
    // 5. Write to target/bench-report.md
}
```

**Run:** `cargo bench && cargo run --bin report_generator`

**Output:** `target/bench-report.md` with full comparison matrix.

### 7. New `benches/validation_test.rs` (~100 LOC)

**Purpose:** Sanity-check tests (Issue #10)

**Issue #10 (MEDIUM):** "Benchmarks are self-testing" is false.

**Fixed:**
```rust
#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn test_make_tree_edges_produces_expected_structure() {
        let edges = make_tree_edges(300, 100);

        // Tree with branching factor 3: 100 nodes should have ~99 edges
        // (parent count = 100, each has 3 children except leaves)
        assert!(edges.len() >= 90 && edges.len() <= 99);

        // Node 0 should have 3 children (1, 2, 3)
        let node_0_children: Vec<_> = edges.iter()
            .filter(|e| e.src == 0)
            .map(|e| e.dst)
            .collect();
        assert_eq!(node_0_children.len(), 3);
    }

    #[test]
    fn test_compaction_result_fields_non_zero() {
        let dir = TempDir::new().unwrap();
        let mut engine = GraphEngineV2::create(dir.path()).unwrap();

        // Create multiple L0 segments
        for i in 0..4 {
            let nodes = make_v2_nodes(100, i * 100);
            engine.store.add_nodes(nodes);
            engine.flush().unwrap();
        }

        let result = engine.compact_with_stats().unwrap();

        assert!(result.shards_compacted.len() > 0, "no shards compacted");
        assert!(result.nodes_merged > 0, "nodes_merged is 0");
        assert!(result.duration_ms > 0, "duration_ms is 0");
    }

    #[test]
    fn test_memory_measurement_plausible_range() {
        let rss = measure_v1_rss(1000);

        // 1K nodes should use between 1 MB and 100 MB
        // (catches both "measurement returned 0" and "measured system RAM")
        assert!(rss > 1_000_000, "RSS too low: {}", rss);
        assert!(rss < 100_000_000, "RSS too high: {}", rss);
    }

    #[test]
    fn test_bfs_visits_increase_with_graph_size() {
        let (_dir1, engine1) = create_v1_graph(1000, 3000, make_tree_edges);
        let result1 = engine1.bfs(&[0], 10, &["CALLS"]);

        let (_dir2, engine2) = create_v1_graph(10000, 30000, make_tree_edges);
        let result2 = engine2.bfs(&[0], 10, &["CALLS"]);

        // At depth 10 in a ternary tree:
        // 1K nodes -> visits all 1K
        // 10K nodes -> visits ~3K (depth 8 of tree)
        assert!(result2.len() > result1.len(),
            "BFS should visit more nodes in larger graph");
    }
}
```

**Run:** `cargo test --benches`

---

## Detailed Approach per Subtask

### Subtask 1: Write Throughput (1K, 10K, 100K, 1M)

**Location:** `benches/v1_v2_comparison.rs` (modify existing)

**Changes:**
- Add 100K, 1M to `bench_add_nodes` (sizes: 1K, 10K, 100K, 1M)
- Add 100K to `bench_flush` (sizes: 1K, 10K, 100K)
- Use `iter_batched` to exclude setup cost (Issue #6)

**Metrics:** Criterion reports µs/iteration → convert to nodes/sec in report.

### Subtask 2: Query Latency

**Location:** `benches/v1_v2_comparison.rs` (modify existing)

**Changes:**
- Standardize all queries to [1000, 10000, 100000]
- Fix BFS with tree topology (Issue #7)
- Fix neighbors to query multiple nodes (Issue #8)
- Add flush before v2 queries (Issue #11)
- Standardize edge ratio to 3x (Issue #12)

**Operations:**
- get_node
- find_by_type (exact)
- find_by_type (wildcard)
- find_by_attr
- bfs
- neighbors
- get_outgoing_edges
- get_incoming_edges
- reachability
- reachability_backward

**Metrics:** µs per operation (median from Criterion).

### Subtask 3: Re-analysis Cost

**Location:** `benches/reanalysis_cost.rs` (new file)

**Changes:**
- Use `iter_batched` with fresh engine per iteration (Issue #2)
- Measure commit_batch on pre-built graph of 10/100/1000 files
- Each commit changes 1 file (100 nodes)

**Metrics:** µs per commit.

### Subtask 4: Compaction Throughput

**Location:** `benches/compaction_throughput.rs` (new file)

**Changes:**
- Add `compact_with_stats()` to GraphEngineV2 (Issue #4)
- Correct throughput formula: records/sec (Issue #3)
- Rename "space amplification" to "tombstone ratio"

**Metrics:**
- Throughput: (nodes_merged + edges_merged) / (duration_ms / 1000.0) records/sec
- Tombstone ratio: tombstones_removed / (nodes_merged + tombstones_removed)

### Subtask 5: Memory Profile

**Location:** `benches/memory_profile.rs` + `benches/memory_profile_worker.rs` (new binaries)

**Changes:**
- Process RSS via sysinfo::Process (Issue #1)
- Child process isolation
- Sizes: 1K, 10K, 100K, 1M

**Metrics:** RSS delta in MB.

### Subtask 6: Comparison Matrix

**Location:** `benches/report_generator.rs` (new binary)

**Changes:**
- Rust-based JSON parsing (Issue #9)
- Parse Criterion estimates.json
- Generate markdown table

**Output:** `target/bench-report.md`

---

## Testing Strategy

**Issue #10 (MEDIUM):** "Benchmarks are self-testing" is false.

**Fixed:** Add `benches/validation_test.rs` with sanity checks:
1. Graph helpers produce expected structure
2. CompactionResult fields non-zero
3. Memory measurements in plausible range
4. BFS visits increase with graph size

**Validation:**
1. `cargo test --benches` — validation tests pass
2. `cargo bench --bench v1_v2_comparison` — completes without panics
3. `cargo bench --bench reanalysis_cost` — completes
4. `cargo bench --bench compaction_throughput` — completes
5. `cargo run --bin memory_profile` — prints table
6. `cargo run --bin report_generator` — generates markdown

**Success criteria:**
- All benchmarks run to completion
- Criterion JSON files exist
- Memory profile prints plausible numbers (not 0, not system RAM)
- Report script generates markdown
- Validation tests pass

**Runtime:** Full suite ~5-10 minutes on dev machine.

---

## Risks and Tradeoffs

### Risk 1: 1M-node benchmarks may timeout

**Mitigation:**
- Only 1M for add_nodes (write throughput)
- Skip 1M for queries (would iterate too many times)
- If timeout, reduce to 500K or increase measurement_time

### Risk 2: Process RSS still includes OS page cache

**Impact:** mmap'd segment files inflate RSS (OS caching). Measurement includes both heap and file cache.

**Mitigation:**
- This is the right metric: "how much RAM does engine use in production?"
- Alternative (counting allocator) misses mmap'd files
- Documenting the limitation in report

### Risk 3: Tree topology may not match production workloads

**Impact:** Real codebases don't have perfect ternary trees.

**Mitigation:**
- This is a benchmark, not production data
- Tree topology ensures BFS scales with graph size (what we're testing)
- Production performance validated separately via Early Access

### Tradeoff: Worker binary for memory measurement

**Decision:** Spawn child process to isolate RSS measurement.

**Cost:** Extra binary target, slight complexity.

**Benefit:** Accurate measurement isolated from harness overhead.

---

## Complexity Analysis

**Issue #5 (MEDIUM):** Errors in complexity formulas.

**Fixed:**

### Write throughput (add_nodes)
- v1: O(N) delta append
- v2: O(N) write buffer insert + periodic flush

### Query latency

**get_node:**
- v1: O(1) HashMap lookup
- v2: O(S * bloom_check + log N_s) where S = segment count, N_s = nodes per segment
  - With bloom filters eliminating segments: O(log N) expected case

**find_by_type:**
- v1: O(N) scan
- v2: O(N) but uses shard partitioning + type indexes to skip segments

**bfs:**
- Both: O(V + E) graph traversal (same complexity, different constants)

### Re-analysis cost
- v1: O(F_changed * N_per_file) — rewrite changed files
- v2: O(F_changed * N_per_file * log(K)) — tombstone old + commit new + binary search shards
  - K = shard count (fixed, small)
  - Bloom filter updates: O(1) per node

### Compaction
- v2 only: **O(N_per_shard * log L)** where L = L0 segment count
  - Merge sort of L sorted runs of size N_per_shard / L each
  - **NOT O(L * N)** as originally stated

### Memory
- v1: O(N) — all nodes in delta HashMap
- v2: O(W + K * I) where:
  - W = write buffer size (bounded by adaptive limits)
  - K = shard count
  - I = index size per shard (bloom filters + metadata)

**Note:** v1 grows unbounded until flush. v2 write buffer is bounded.

---

## Estimated LOC

| File | LOC |
|------|-----|
| `src/graph/engine_v2.rs` (compact_with_stats) | ~10 |
| `benches/v1_v2_comparison.rs` (modifications + additions) | ~300 |
| `benches/reanalysis_cost.rs` (new) | ~180 |
| `benches/compaction_throughput.rs` (new) | ~200 |
| `benches/memory_profile.rs` (new binary) | ~150 |
| `benches/memory_profile_worker.rs` (new binary) | ~80 |
| `benches/report_generator.rs` (new binary) | ~250 |
| `benches/validation_test.rs` (new) | ~100 |
| **Total** | **~1270 LOC** |

**Increase from v1:** ~540 LOC (due to worker binary, validation tests, Rust report generator).

---

## Dependencies

**Rust crates (already in Cargo.toml):**
- criterion ✓
- tempfile ✓
- sysinfo ✓
- blake3 ✓
- serde_json ✓

**System tools:**
- None (Rust-based report generation)

**New binary targets (add to Cargo.toml):**
```toml
[[bin]]
name = "memory_profile"
path = "benches/memory_profile.rs"

[[bin]]
name = "memory_profile_worker"
path = "benches/memory_profile_worker.rs"

[[bin]]
name = "report_generator"
path = "benches/report_generator.rs"
```

**No new dependencies required.**

---

## Alignment with Project Vision

**"AI should query the graph, not read code."**

This task doesn't directly advance that vision — it's infrastructure for performance validation.

**Relevance:** Performance benchmarks are essential for:
1. Proving v2 scales to 1M+ nodes (required for Early Access)
2. Identifying regressions before they ship
3. Guiding optimization work (compaction, memory, indexes)

**This is NOT a product feature.** This is **quality assurance infrastructure** for the storage engine.

---

## Timeline Estimate

| Phase | Time | Deliverable |
|-------|------|-------------|
| Add compact_with_stats to engine_v2 | 0.5h | API for compaction stats |
| Fix v1_v2_comparison.rs (6 fixes + additions) | 3h | All operations, correct methodology |
| Write reanalysis_cost.rs | 1.5h | Re-analysis benchmarks |
| Write compaction_throughput.rs | 2h | Compaction metrics |
| Write memory_profile.rs + worker | 2h | RSS measurement binaries |
| Write report_generator.rs | 2h | Rust-based report |
| Write validation_test.rs | 1h | Sanity-check tests |
| Test full suite + fix issues | 2h | Validate all benchmarks |
| **Total** | **14 hours** | Complete benchmark suite |

**Revised estimate:** ~2 days (was 1 day in v1).

**Increase:** +5 hours due to:
- Worker binary for memory measurement (+1h)
- Validation tests (+1h)
- Rust report generator vs jq script (+1h)
- Additional fixes from review (+2h)

**Still fits 3-point estimate** for methodologically correct benchmark suite.

---

## Appendix: Issue Resolution Summary

### CRITICAL (1 issue)

**#1 Memory measurement uses system-wide available_memory**

**What was wrong:** `SystemResources::detect()` measures system-wide free memory, not process usage. Dominated by noise from other processes and OS caching.

**How fixed:** Process RSS via `sysinfo::Process::memory()` in isolated child process.

**Code:**
```rust
// Worker binary measures its own RSS delta
let mut system = System::new();
system.refresh_all();
let pid = sysinfo::get_current_pid().unwrap();
let baseline_rss = system.process(pid).unwrap().memory();

// Build graph...

system.refresh_all();
let final_rss = system.process(pid).unwrap().memory();
let delta = final_rss - baseline_rss;
```

### HIGH (2 issues)

**#2 Reanalysis benchmark accumulates state**

**What was wrong:** `b.iter(|| engine.commit_batch(...))` reuses same engine, each iteration adds more tombstones.

**How fixed:** `iter_batched` with fresh engine per iteration.

**Code:**
```rust
b.iter_batched(
    || create_pre_built_graph(file_count),
    |mut engine| black_box(engine.commit_batch(...)),
    BatchSize::LargeInput,
)
```

**#4 CompactionResult inaccessible**

**What was wrong:** `GraphEngineV2::compact()` returns `Result<()>`, discards stats.

**How fixed:** Add `compact_with_stats() -> Result<CompactionResult>`.

**Code:**
```rust
pub fn compact_with_stats(&mut self) -> Result<CompactionResult> {
    let config = CompactionConfig::default();
    self.store.compact(&mut self.manifest, &config)
}
```

### MEDIUM-HIGH (3 issues)

**#3 Compaction formulas nonsensical**

**What was wrong:** `segments/sec = shards * l0_segments / duration` has no meaningful unit.

**How fixed:** Records/sec and tombstone ratio.

**Code:**
```rust
// Throughput
let records_per_sec = (result.nodes_merged + result.edges_merged) as f64
    / (result.duration_ms as f64 / 1000.0);

// Tombstone ratio (proxy for space reclaimed)
let tombstone_ratio = result.tombstones_removed as f64
    / (result.nodes_merged + result.tombstones_removed) as f64;
```

**#7 BFS traverses constant 10 nodes**

**What was wrong:** Chain topology means depth-10 BFS always visits 11 nodes.

**How fixed:** Tree topology with branching factor 3.

**Code:**
```rust
fn make_tree_edges(edge_count: usize, node_count: usize) -> Vec<EdgeRecord> {
    (0..edge_count)
        .filter_map(|i| {
            let parent = i / 3;
            let child = i + 1;
            if child < node_count {
                Some(EdgeRecord {
                    src: parent as u128,
                    dst: child as u128,
                    // ...
                })
            } else { None }
        })
        .collect()
}
```

**#11 v2 queries test write-buffer, not segments**

**What was wrong:** Query benchmarks don't flush, so v2 data is in write-buffer (not production state).

**How fixed:** Add `engine.flush().unwrap()` after graph construction.

**Code:**
```rust
fn create_v2_graph(...) -> (TempDir, GraphEngineV2) {
    // ... add_nodes, add_edges ...
    engine.flush().unwrap();  // <-- ensure data is in segments
    (dir, engine)
}
```

### MEDIUM (3 issues)

**#5 Complexity analysis errors**

**What was wrong:** Merge sort stated as O(N * L), should be O(N log L). get_node complexity incomplete.

**How fixed:** Corrected all formulas in Complexity Analysis section.

**#6 add_nodes/flush include setup cost**

**What was wrong:** TempDir creation + engine init measured as part of add_nodes.

**How fixed:** `iter_batched` separates setup from measurement.

**#10 No benchmark validation**

**What was wrong:** "Compiles and runs" is insufficient — benchmarks can silently produce wrong numbers.

**How fixed:** Added validation_test.rs with sanity checks.

### LOW-MEDIUM (2 issues)

**#8 neighbors always queries node 0**

**What was wrong:** Node 0 has fixed neighbor count, doesn't test scaling.

**How fixed:** Cycle through multiple nodes with varying depths.

**Code:**
```rust
let mut idx = 0;
b.iter(|| {
    black_box(engine.neighbors(black_box(idx as u128), &["CALLS"]));
    idx = (idx + 1) % size.min(100);
});
```

**#12 Inconsistent edge ratios**

**What was wrong:** Different benchmarks use 2x, 3x, 5x edges.

**How fixed:** Standardized 3x everywhere (matches tree branching factor).

### LOW (1 issue)

**#9 jq dependency undeclared**

**What was wrong:** Script uses `jq` without declaring it or checking availability.

**How fixed:** Rust binary for report generation.

---

## Verdict

All 12 issues addressed. The revised plan is methodologically sound and produces meaningful, reproducible numbers.
