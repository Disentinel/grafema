# Don's Plan: RFD-22 Performance Benchmark Suite

## Overview

Extend existing Criterion benchmarks to cover all required performance metrics. Current state:
- `graph_operations.rs` (492 LOC) — v1 engine, sizes up to 100K
- `v1_v2_comparison.rs` (354 LOC) — v1/v2 side-by-side, partial coverage
- `neo4j_comparison.rs` — stub

This is NOT a new feature. This is expanding test coverage for performance. Keep scope tight.

## File Changes

### 1. Extend `benches/v1_v2_comparison.rs` (~200 LOC added)
**Current:** 354 LOC, 7 operations, sizes up to 100K
**Target:** ~550 LOC, all operations, standardized sizes 1K/10K/100K

**Changes:**
- Add 1M size tier for write throughput benchmarks (add_nodes, flush)
- Standardize query benchmarks to 1K/10K/100K (currently inconsistent)
- Add missing operations from graph_operations.rs that aren't yet in comparison:
  - get_outgoing_edges, get_incoming_edges
  - reachability, reachability_backward
  - delete_node, delete_edge
  - wildcard type matching

**Rationale:** This file already has the v1/v2 split structure. Extend it rather than create new files.

### 2. New `benches/reanalysis_cost.rs` (~150 LOC)
**Purpose:** Measure incremental re-analysis cost (subtask #3)

**Benchmarks:**
- `v1/reanalysis` — v1 baseline (add new nodes, flush)
- `v2/reanalysis` — commit_batch on pre-built graph of 1K/10K/100K files

**Approach:**
1. Build graph with N files (100 nodes per file)
2. Modify 1 file (replace 100 nodes with new versions)
3. Measure time to commit the change

**Why separate file:** commit_batch is v2-only, doesn't fit comparison structure.

### 3. New `benches/compaction_throughput.rs` (~180 LOC)
**Purpose:** Dedicated compaction metrics (subtask #4)

**Benchmarks:**
- Build graph with N nodes across 4 shards
- Flush multiple times to create L0 segments (4, 8, 12 segments)
- Measure compaction time
- Extract metrics from CompactionResult:
  - shards_compacted
  - nodes_merged, edges_merged
  - tombstones_removed
  - duration_ms

**Metrics computed post-benchmark:**
- Segments/sec = shards_compacted * l0_segments / duration_ms
- Space amplification = (nodes_merged + tombstones) / nodes_merged

**Why separate file:** Compaction setup requires multi-flush cycles, doesn't fit add/query pattern.

### 4. New `benches/memory_profile.rs` (~120 LOC)
**Purpose:** RSS measurement at scale (subtask #5)

**NOT using Criterion:** Memory profiling requires different measurement approach.

**Approach:**
1. Use SystemResources::detect() before/after graph build
2. Measure delta in total_memory_bytes
3. Print table to stdout (not Criterion JSON)

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

**Why separate file:** RSS measurement doesn't fit Criterion's iteration model.

### 5. New script `scripts/bench-report.sh` (~80 LOC)
**Purpose:** Run all benchmarks and generate comparison matrix (subtask #6)

**Flow:**
1. `cargo bench --bench v1_v2_comparison` → parse Criterion JSON
2. `cargo bench --bench reanalysis_cost` → parse Criterion JSON
3. `cargo bench --bench compaction_throughput` → parse Criterion JSON
4. `cargo run --release --bin memory_profile` → parse stdout table
5. Merge into single markdown table

**Output:** `target/bench-report.md` with full v1 vs v2 comparison matrix

**Rationale:** Benchmark results are scattered. Need single command to generate dashboard.

## Detailed Approach per Subtask

### Subtask 1: Write Throughput (1K, 10K, 100K, 1M)
**Location:** `benches/v1_v2_comparison.rs` (modify existing)

**Current state:**
- `bench_add_nodes`: sizes [100, 1000, 10000]
- `bench_flush`: sizes [1000, 10000]

**Changes:**
- Add 100K, 1M to `bench_add_nodes` (measure nodes/sec)
- Add 100K to `bench_flush` (measure flush throughput)
- Skip 1M for flush (would take >60s, Criterion timeout)

**Metrics:** Criterion reports iterations/sec → convert to nodes/sec in report script.

### Subtask 2: Query Latency
**Location:** `benches/v1_v2_comparison.rs` (modify existing)

**Current state:** Inconsistent sizes across operations
- get_node: [1000, 10000, 100000] ✓
- find_by_type: [1000, 10000, 100000] ✓
- find_by_attr: [1000, 10000, 100000] ✓
- bfs: [100, 1000, 10000] ✗
- neighbors: [1000, 10000, 100000] ✓

**Changes:**
- Standardize bfs to [1000, 10000, 100000] (drop 100, add 100K)
- Add get_outgoing_edges, get_incoming_edges at [1000, 10000, 100000]
- Add reachability variants at [1000, 10000, 100000]

**Rationale:** 1K/10K/100K covers representative scale. 100-node graphs are toy tests, not benchmarks.

### Subtask 3: Re-analysis Cost
**Location:** `benches/reanalysis_cost.rs` (new file)

**Setup:**
```rust
fn create_pre_built_graph(file_count: usize) -> GraphEngineV2 {
    let nodes = (0..file_count * 100).map(|i| NodeRecordV2 {
        semantic_id: format!("FUNCTION:func_{}@src/file_{}.js", i, i / 100),
        id: hash(&semantic_id),
        node_type: "FUNCTION",
        name: format!("func_{}", i),
        file: format!("src/file_{}.js", i / 100),
        content_hash: 0,
        metadata: "".to_string(),
    }).collect();

    let files: Vec<String> = (0..file_count)
        .map(|i| format!("src/file_{}.js", i))
        .collect();

    engine.commit_batch(nodes, vec![], &files, HashMap::new());
    engine
}
```

**Benchmark:**
```rust
fn bench_reanalysis_cost(c: &mut Criterion) {
    for size in [10, 100, 1000] {  // file count
        let engine = create_pre_built_graph(size);

        // Change 1 file = replace 100 nodes
        let changed_nodes = (0..100).map(|i| NodeRecordV2 {
            semantic_id: format!("FUNCTION:func_{}@src/file_0.js", i),
            id: hash(&semantic_id),
            // ... new version
        }).collect();

        group.bench(|b| {
            b.iter(|| {
                engine.commit_batch(
                    changed_nodes.clone(),
                    vec![],
                    &["src/file_0.js"],
                    HashMap::new()
                )
            });
        });
    }
}
```

**Metrics:** Time per commit (µs). Lower = better incremental performance.

### Subtask 4: Compaction Throughput
**Location:** `benches/compaction_throughput.rs` (new file)

**Setup:**
```rust
fn create_graph_with_l0_segments(
    node_count: usize,
    segment_count: usize
) -> GraphEngineV2 {
    let mut engine = GraphEngineV2::create(path)?;

    let nodes_per_segment = node_count / segment_count;
    for i in 0..segment_count {
        let batch = make_nodes(nodes_per_segment, i * nodes_per_segment);
        engine.add_nodes(batch);
        engine.flush()?;  // Create L0 segment
    }

    engine
}
```

**Benchmark:**
```rust
fn bench_compaction(c: &mut Criterion) {
    for segments in [4, 8, 12] {
        group.bench(|b| {
            b.iter_batched(
                || create_graph_with_l0_segments(10_000, segments),
                |mut engine| {
                    let result = engine.compact().unwrap();
                    black_box(result)
                },
                BatchSize::LargeInput,
            );
        });
    }
}
```

**Metrics from CompactionResult:**
- Throughput: shards_compacted / (duration_ms / 1000.0) segments/sec
- Space amplification: tombstones_removed / nodes_merged

**Output:** Custom reporter extracts these from CompactionResult.

### Subtask 5: Memory Profile
**Location:** `benches/memory_profile.rs` (new binary, not benchmark)

**Why binary not benchmark:** Criterion iterates to find stable timing. We need ONE measurement per size.

**Implementation:**
```rust
fn main() {
    println!("Size\tv1 RSS (MB)\tv2 RSS (MB)");

    for size in [1_000, 10_000, 100_000, 1_000_000] {
        // v1
        let before = SystemResources::detect();
        let (_dir, _engine) = create_v1_graph(size, size * 2);
        let after = SystemResources::detect();
        let v1_mb = (before.available_memory_bytes - after.available_memory_bytes)
            / (1024 * 1024);

        // v2
        let before = SystemResources::detect();
        let (_dir, _engine) = create_v2_graph(size, size * 2);
        let after = SystemResources::detect();
        let v2_mb = (before.available_memory_bytes - after.available_memory_bytes)
            / (1024 * 1024);

        println!("{}\t{}\t{}", size, v1_mb, v2_mb);
    }
}
```

**Limitation:** RSS measurement via sysinfo is imprecise (includes OS caching). Good enough for order-of-magnitude comparison.

**Run:** `cargo run --release --bin memory_profile > target/memory_profile.txt`

### Subtask 6: Comparison Matrix
**Location:** `scripts/bench-report.sh` (new script)

**Flow:**
1. Run all benchmarks:
   ```bash
   cargo bench --bench v1_v2_comparison -- --save-baseline current
   cargo bench --bench reanalysis_cost -- --save-baseline current
   cargo bench --bench compaction_throughput -- --save-baseline current
   cargo run --release --bin memory_profile > target/memory_profile.txt
   ```

2. Parse Criterion JSON from `target/criterion/*/current/estimates.json`

3. Merge into markdown table:
   ```markdown
   # RFDB Performance Report

   ## Write Throughput (nodes/sec)
   | Size | v1 | v2 | Speedup |
   |------|----|----|---------|
   | 1K   | ... | ... | ...x |
   | 10K  | ... | ... | ...x |
   | 100K | ... | ... | ...x |
   | 1M   | ... | ... | ...x |

   ## Query Latency (µs)
   | Operation | Size | v1 | v2 | Speedup |
   |-----------|------|----|----|---------|
   | get_node  | 10K  | ... | ... | ...x |
   | find_by_type | 10K | ... | ... | ...x |
   | bfs | 10K | ... | ... | ...x |

   ## Re-analysis Cost (µs per file)
   | Files | v1 | v2 | Speedup |
   |-------|----|----|---------|
   | 10    | ... | ... | ...x |
   | 100   | ... | ... | ...x |
   | 1000  | ... | ... | ...x |

   ## Compaction Throughput
   | L0 Segments | Segments/sec | Space Amplification |
   |-------------|--------------|---------------------|
   | 4           | ...          | ...x                |
   | 8           | ...          | ...x                |
   | 12          | ...          | ...x                |

   ## Memory Profile (MB)
   | Size | v1 | v2 | Reduction |
   |------|----|----|-----------|
   | 1K   | ... | ... | ...% |
   | 10K  | ... | ... | ...% |
   | 100K | ... | ... | ...% |
   | 1M   | ... | ... | ...% |
   ```

4. Write to `target/bench-report.md`

**Tooling:** Use `jq` to parse Criterion JSON. Script is ~80 LOC bash + jq.

## Testing Strategy

**Unit tests:** None needed. Benchmarks are self-testing (compile + run = pass).

**Validation:**
1. `cargo bench --bench v1_v2_comparison` — must complete without panics
2. `cargo bench --bench reanalysis_cost` — must complete
3. `cargo bench --bench compaction_throughput` — must complete
4. `cargo run --release --bin memory_profile` — must print table
5. `./scripts/bench-report.sh` — must generate markdown file

**Success criteria:**
- All benchmarks run to completion
- Criterion JSON files exist in `target/criterion/`
- Report script merges results into single table
- No panics, no infinite loops

**Runtime:** Full suite ~5-10 minutes on dev machine (MacBook Pro M3).

## Risks and Tradeoffs

### Risk 1: 1M-node benchmarks may timeout
**Impact:** Criterion default timeout is 60s. 1M-node add_nodes may exceed this.

**Mitigation:**
- Only benchmark 1M for write throughput (add_nodes)
- Skip 1M for queries (they would iterate too many times)
- If timeout occurs, reduce to 500K or use `measurement_time(Duration::from_secs(120))`

### Risk 2: Memory profiling via sysinfo is imprecise
**Impact:** RSS includes OS page cache, not just process memory. Results may vary by 20-30%.

**Mitigation:**
- This is order-of-magnitude comparison, not precise measurement
- Alternative (perf/valgrind) would require Linux, not portable
- Good enough for "v2 uses ~40% less memory than v1"

### Risk 3: CompactionResult doesn't exist yet
**Check:** Grep shows CompactionResult is defined in `storage_v2/compaction/types.rs` ✓

**Fields available:**
- shards_compacted ✓
- nodes_merged ✓
- edges_merged ✓
- tombstones_removed ✓
- duration_ms ✓

**No risk:** API exists, already implemented.

### Risk 4: Benchmark JSON parsing fragility
**Impact:** Criterion JSON format may change, script breaks.

**Mitigation:**
- Use well-tested jq patterns
- If JSON changes, update script (not benchmarks)
- Worst case: manually read Criterion HTML reports

### Tradeoff: Custom binary vs Criterion for memory profiling
**Decision:** Use custom binary (not Criterion).

**Rationale:**
- Criterion iterates to find stable timing → measures many allocations, not one graph build
- We need RSS delta for single graph construction
- Custom binary: simpler, clearer, correct measurement

**Cost:** No Criterion HTML report for memory. Acceptable — we print table to stdout.

## Complexity Analysis

**Write throughput (add_nodes):**
- v1: O(N) delta append
- v2: O(N) write buffer insert + periodic flush

**Query latency:**
- get_node: O(1) HashMap lookup (v1 delta) vs O(log S) segment scan (v2)
- find_by_type: O(N) scan (both engines, v2 uses indexes to skip segments)
- bfs: O(V + E) graph traversal (same complexity, different constants)

**Re-analysis cost:**
- v1: O(F_changed * N_per_file) — rewrite changed files
- v2: O(F_changed * N_per_file + K * S * B) — tombstone old + commit new + update indexes
  - K = shard count, S = segment count, B = bloom filter update cost

**Compaction:**
- v2 only: O(L0_segments * N_per_shard) merge sort + tombstone removal

**Memory:**
- v1: O(N) delta HashMap (all nodes in memory until flush)
- v2: O(W) write buffer + O(K * I) shard indexes (W = write buffer size, K = shard count, I = index size per shard)

## Estimated LOC

| File | LOC |
|------|-----|
| `benches/v1_v2_comparison.rs` (additions) | ~200 |
| `benches/reanalysis_cost.rs` (new) | ~150 |
| `benches/compaction_throughput.rs` (new) | ~180 |
| `benches/memory_profile.rs` (new) | ~120 |
| `scripts/bench-report.sh` (new) | ~80 |
| **Total** | **~730 LOC** |

## Dependencies

**Rust crates (already in Cargo.toml):**
- criterion ✓
- tempfile ✓
- sysinfo ✓

**System tools (for report script):**
- jq (JSON parsing)
- bash

**No new dependencies required.**

## Alignment with Project Vision

**"AI should query the graph, not read code."**

This task doesn't directly advance that vision — it's infrastructure for performance validation.

**Relevance:** Performance benchmarks are essential for:
1. Proving v2 scales to 1M+ nodes (required for Early Access)
2. Identifying regressions before they ship
3. Guiding optimization work (compaction, memory, indexes)

**This is NOT a product feature.** This is **quality assurance infrastructure** for the storage engine.

## Timeline Estimate

| Phase | Time | Deliverable |
|-------|------|-------------|
| Extend v1_v2_comparison.rs | 2h | All operations at 1K/10K/100K |
| Write reanalysis_cost.rs | 1.5h | v1/v2 re-analysis benchmarks |
| Write compaction_throughput.rs | 2h | Compaction metrics |
| Write memory_profile.rs | 1h | RSS measurement binary |
| Write bench-report.sh | 1.5h | Unified report generator |
| Test full suite | 1h | Validate all benchmarks run |
| **Total** | **9 hours** | Complete benchmark suite |

**Fits 2-point estimate:** This is 1 day of focused work for a Rust developer familiar with Criterion.
