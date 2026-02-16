# Review of the Benchmark Plan for RFD-22

**Reviewer:** Edsger W. Dijkstra (channeled)
**Date:** 2026-02-16
**Verdict:** The plan contains several serious errors, numerous imprecisions, and at least one measurement methodology so fundamentally flawed that it would produce meaningless numbers. I shall enumerate them.

---

## 1. The Memory Measurement Is Not Merely Imprecise -- It Is Wrong

The plan proposes (Subtask 5, lines 245-261):

```rust
let before = SystemResources::detect();
let (_dir, _engine) = create_v1_graph(size, size * 2);
let after = SystemResources::detect();
let v1_mb = (before.available_memory_bytes - after.available_memory_bytes)
    / (1024 * 1024);
```

**The problem is not imprecision. The problem is that this measures nothing definable.**

`SystemResources::detect()` calls `sysinfo`'s `available_memory()`, which reports the OS's view of system-wide free memory. Between two calls to `available_memory()`:

- Other processes allocate and free memory.
- The OS page cache grows or shrinks based on unrelated I/O.
- The OS may reclaim pages for kernel buffers.
- The benchmark itself is doing file I/O (TempDir, flush) which inflates page cache.
- `mmap`-based files (if any) blur the line between "process memory" and "file cache."

The plan acknowledges "RSS includes OS page cache, not just process memory. Results may vary by 20-30%." This is a breathtaking understatement. On a machine with any background activity, the delta of system-wide available memory between two points in time is *dominated by noise*, not by the process under measurement. A 20-30% error would be a best case; the actual error can be 100% or more, and the sign can even be wrong (available memory could *increase* if other processes release memory during graph construction).

Calling this "good enough for order-of-magnitude comparison" is the kind of hand-waving that passes for reasoning only among those who have never taken a measurement.

**The correct approach:** Measure RSS of the *process itself*. On macOS, `proc_pidinfo` with `PROC_PIDTASKINFO` gives `resident_size` for a specific PID. On Linux, read `/proc/self/statm`. In Rust, the `jemalloc` allocator exposes `allocated` counters via `tikv-jemallocator`, or use `sysinfo::Process::memory()` which returns the RSS of a specific process. Run the graph construction in a fresh child process (fork or `Command::new`) to isolate the measurement from the benchmark harness itself.

Alternatively, since we control the allocator, the most precise approach is to use a custom global allocator wrapper that counts bytes allocated minus bytes freed. This gives you *exactly* how much heap the data structure uses, with zero noise.

**Severity:** CRITICAL. The proposed method will produce numbers that no honest person could defend.

---

## 2. The Reanalysis Benchmark Measures Accumulated State, Not Incremental Cost

The plan proposes (Subtask 3, lines 159-183):

```rust
let engine = create_pre_built_graph(size);
group.bench(|b| {
    b.iter(|| {
        engine.commit_batch(changed_nodes.clone(), vec![], &["src/file_0.js"], HashMap::new())
    });
});
```

Criterion calls the closure *multiple times* to get stable timing. Each iteration calls `commit_batch` on the *same* engine instance. After iteration 1, the graph already contains the "changed" nodes. Iterations 2 through N are committing *the same nodes again* to an engine that already processed them.

This means:
- Iteration 1 measures: "tombstone old nodes + insert new nodes + update indexes."
- Iteration 2 measures: "tombstone the nodes we just inserted + insert them again + update indexes" -- but now with more tombstones and more segments.
- Iteration N measures: an engine bloated with N layers of committed data and tombstones.

You are not measuring "the cost of reanalysis." You are measuring the *average* cost across an increasingly degraded engine state. The number Criterion reports will be some inscrutable mixture of fresh-engine performance and pathological-state performance.

**The correct approach:** Use `iter_batched` with `BatchSize::LargeInput` to create a fresh pre-built graph for each iteration:

```rust
b.iter_batched(
    || {
        let engine = create_pre_built_graph(size);
        (engine, changed_nodes.clone())
    },
    |(mut engine, nodes)| {
        black_box(engine.commit_batch(nodes, vec![], &["src/file_0.js"], HashMap::new()))
    },
    BatchSize::LargeInput,
);
```

The plan already uses `iter_batched` correctly for the compaction benchmark. The inconsistency between these two benchmarks reveals that the author did not think systematically about what "iteration" means in each case.

**Severity:** HIGH. The benchmark measures a quantity that does not correspond to any real-world scenario.

---

## 3. The Compaction Throughput Formula Is Mathematically Nonsensical

The plan states two derived metrics:

### 3a. "Segments/sec = shards_compacted * l0_segments / duration_ms"

This formula is dimensionally incoherent. `shards_compacted` is a count. `l0_segments` is a count. Their product is... what? "Shard-segments"? This is not a meaningful unit. Moreover, dividing by `duration_ms` gives units of "shard-segments per millisecond," which the plan then calls "segments/sec" -- mixing up milliseconds and seconds.

But the deeper problem: what is this metric supposed to *mean*? If I compact 4 shards each with 8 L0 segments in 1000ms, is the "throughput" 32 shard-segments per second? What decision would I make differently if this number were 16 vs 64? Throughput should measure *data processed per unit time*, e.g., `(nodes_merged + edges_merged) / duration_seconds`. That is a meaningful quantity: "records/second."

### 3b. "Space amplification = tombstones_removed / nodes_merged"

The plan states this on line 229, but on line 58 it gives a *different* formula: `(nodes_merged + tombstones) / nodes_merged`. These two formulas are not equal.

Neither formula is correct for space amplification in the standard LSM-tree sense. Space amplification is defined as: `(actual_disk_space - logical_data_size) / logical_data_size`. It measures how much extra disk space you pay for the LSM structure. The ratio `tombstones_removed / nodes_merged` does not give this; a graph with 0 tombstones and 1000 nodes in 10 overlapping segments has high space amplification but this formula returns 0.

**The correct approach for throughput:** `(nodes_merged + edges_merged) / (duration_ms / 1000.0)` -- records per second.

**The correct approach for space amplification:** Either measure actual disk usage before and after compaction (the true definition), or acknowledge you are computing a proxy metric and name it precisely: "tombstone ratio" = `tombstones_removed / (nodes_merged + tombstones_removed)`.

**Severity:** MEDIUM-HIGH. Meaningless derived metrics will be mistaken for meaningful ones, leading to incorrect optimization decisions.

---

## 4. The Compaction Benchmark Cannot Access `CompactionResult`

The plan proposes (line 217):

```rust
let result = engine.compact().unwrap();
black_box(result)
```

But `GraphEngineV2::compact()` implements the `GraphStore` trait method, which returns `Result<()>` (line 85 of `graph/mod.rs`: `fn compact(&mut self) -> Result<()>`). The `CompactionResult` is created inside the `MultiShardStore::compact()` call but is *discarded* by `GraphEngineV2::compact()`, which maps it to `Ok(())`.

Since `GraphEngineV2.store` is a private field (line 152: `store: MultiShardStore`), the benchmark cannot call `self.store.compact()` directly.

The plan's pseudocode `let result = engine.compact().unwrap()` will not compile. `result` would be `()`, and extracting `shards_compacted`, `nodes_merged`, etc. from `()` is, I trust, beyond even the most optimistic type inference.

**The correct approach:** Either:
1. Add a public method `pub fn compact_with_stats(&mut self) -> Result<CompactionResult>` to `GraphEngineV2`, or
2. Add a public getter for the store, or
3. Benchmark `MultiShardStore::compact()` directly (requires constructing a `ManifestStore` and `CompactionConfig` in the benchmark setup).

This is not a minor oversight; it means the compaction throughput file *cannot be implemented as specified*.

**Severity:** HIGH. The plan specifies code that cannot exist.

---

## 5. The Complexity Analysis Contains Errors and Undefined Variables

### 5a. get_node complexity for v2

The plan claims: "get_node: O(1) HashMap lookup (v1 delta) vs O(log S) segment scan (v2)."

What is S? If S is the number of segments, then within each segment you need O(log N_s) to find the node (binary search on sorted data), so the total is O(S * log N_s) in the worst case, or O(log N) with a bloom filter that successfully eliminates most segments. The plan's "O(log S)" suggests a binary search over segments, which is not how LSM-tree point lookups work. They check segments newest-to-oldest and stop at the first hit.

### 5b. Re-analysis complexity

The plan claims: "v2: O(F_changed * N_per_file + K * S * B) -- tombstone old + commit new + update indexes. K = shard count, S = segment count, B = bloom filter update cost."

This mixes per-shard and global quantities without stating which is which. Is S the total segment count or per-shard? Is K multiplied by S because each shard has S segments? If so, the bloom filter update happens only for the shard receiving the data, not all K shards. The formula implies every shard's bloom filter is updated for every file change, which would be architecturally alarming.

### 5c. Compaction complexity

"O(L0_segments * N_per_shard) merge sort + tombstone removal."

Merge sort of L0_segments sorted runs of size N_per_shard/L0_segments each is O(N_per_shard * log(L0_segments)), not O(L0_segments * N_per_shard). The latter would be O(N * L) which overstates the cost by a factor of L/log(L). For 12 segments, this is a factor of ~3.4x overstatement.

**Severity:** MEDIUM. Incorrect complexity claims lead to incorrect performance expectations, which lead to incorrect decisions about what to optimize.

---

## 6. The add_nodes Benchmark Includes Setup Cost

The existing code (which the plan inherits and extends) benchmarks `add_nodes` like this:

```rust
b.iter(|| {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();
    engine.add_nodes(black_box(make_nodes(size)));
});
```

Each iteration creates a temp directory, creates a new engine, AND adds nodes. The reported time includes filesystem operations (temp directory creation) and engine initialization. At small sizes (100, 1000), the `TempDir::new()` + `create()` overhead may dominate the actual `add_nodes` time.

Similarly, `make_nodes(size)` is called inside the timed closure, so node *construction* time (string formatting, memory allocation for Vec) is included in the "add_nodes" measurement.

The plan proposes extending this to 1M nodes without fixing this methodological flaw.

**The correct approach:** Use `iter_batched`:

```rust
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
```

The flush benchmark has the same problem, compounded: it measures TempDir creation + engine creation + add_nodes + flush, and calls this "flush throughput."

**Severity:** MEDIUM. At large sizes the setup cost is amortized; at small sizes the numbers are misleading.

---

## 7. The BFS Benchmark Does Not Control for Graph Topology

BFS with `max_depth=10` starting from node 0 on a graph where edges form the pattern `(i, (i+1) % N)` will traverse a simple chain: 0->1->2->...->10. That is 10 hops, visiting 11 nodes, regardless of whether the graph has 1K, 10K, or 100K nodes. The benchmark is measuring O(depth) = O(10) = O(1), not O(V+E).

If the purpose is to measure BFS scaling with graph size, you must either:
- Remove the depth limit, or
- Construct a graph topology where a depth-10 BFS from node 0 actually reaches a number of nodes proportional to graph size.

With the current edge pattern (essentially a cycle), the benchmark proves only that visiting 11 nodes takes the same time regardless of how many nodes exist. This is trivially true and uninformative.

The existing code has this same flaw. The plan proposes to extend it to 100K without noticing that the numbers will be nearly identical across all sizes, which should have been a red flag that something is wrong.

**Severity:** MEDIUM-HIGH. The benchmark is measuring a constant, not a function of graph size.

---

## 8. The neighbors Benchmark Always Queries Node 0

```rust
b.iter(|| { black_box(engine.neighbors(black_box(0), &["CALLS"])); });
```

Node 0 has a fixed, small number of neighbors determined by the edge construction pattern. Since edges are `(i % N, (i+1) % N)`, node 0 appears as a source for edges where `i % N == 0`, and as a destination for edges where `(i+1) % N == 0`, i.e., `i = N-1, 2N-1, ...`. For a graph with N nodes and 5N edges, node 0 has exactly 5 outgoing edges and 5 incoming edges.

So across graph sizes 1K, 10K, 100K, we are always querying a node with 5 neighbors. The benchmark measures "lookup cost for 5 neighbors" at different graph sizes, which is only interesting if the lookup cost scales with total graph size (it should not, for any reasonable implementation). If the numbers are flat across sizes -- which they should be -- the benchmark confirms nothing useful. If they are not flat, that would be an interesting bug, but the plan does not discuss this expectation.

**Severity:** LOW-MEDIUM. The benchmark could be made useful by querying nodes with varying neighbor counts.

---

## 9. The Report Script Assumes `jq` Availability Without Declaring It

Line 325: "Use `jq` to parse Criterion JSON."

`jq` is not a standard Unix utility. It is not installed by default on macOS or most Linux distributions. The plan lists it under "System tools" but does not add it to any CI/CD configuration, `Makefile`, `flake.nix`, or other dependency declaration. The script will fail silently or with a cryptic error on any machine without `jq`.

**The correct approach:** Either check for `jq` at the start of the script and emit a clear error, or use a Rust binary (which is already the approach for memory profiling) to parse Criterion JSON. Using two different toolchains (Rust for benchmarks, bash+jq for reporting) for what is a single pipeline is architectural incoherence.

**Severity:** LOW. But symptomatic of insufficient rigor.

---

## 10. "Benchmarks Are Self-Testing" Is a Dangerous Falsehood

The plan states (line 329): "Unit tests: None needed. Benchmarks are self-testing (compile + run = pass)."

A benchmark that compiles and runs to completion without panicking can still:
- Measure the wrong thing (see issues 2, 6, 7 above).
- Produce numbers that are off by orders of magnitude due to optimizer elision.
- Return 0 because `black_box` was applied incorrectly.
- Measure setup cost instead of the operation (see issue 6).
- Silently degrade due to Criterion API changes.

"Compiles and doesn't crash" is the lowest bar imaginable. At minimum, a sanity-check test should verify that benchmark helpers produce graphs with the expected node/edge counts, that `CompactionResult` fields are non-zero after compaction, and that the numbers produced are in plausible ranges.

**Severity:** MEDIUM. Not testing benchmark infrastructure means errors discovered only when someone looks at the report and thinks "that can't be right" -- if they notice at all.

---

## 11. No Warmup or Steady-State Considerations for v2

The v2 engine has write buffers, periodic flushes, shard indexes, and bloom filters. Its performance characteristics differ between cold start (empty write buffer, no segments) and steady state (populated indexes, L0 segments from prior flushes). The plan does not discuss which state the benchmarks target.

For query benchmarks, the graphs are built with `add_nodes` + `add_edges` but never flushed before querying. This means v2 queries operate on write-buffer data (hot, in-memory) rather than on-disk segments. In production, data will be in segments after flush. The benchmark flatters v2's query performance by testing a state that only exists transiently.

**The correct approach:** For query benchmarks, flush the engine after construction to ensure data is in its steady-state storage format. The existing code in `v1_v2_comparison.rs` does not call flush before queries either. This should be fixed.

**Severity:** MEDIUM-HIGH. Benchmarking a transient state produces numbers inapplicable to production.

---

## 12. Inconsistent Edge-to-Node Ratios Across Benchmarks

- `bench_find_by_type`: 2x edges per node
- `bench_bfs`: 3x edges per node
- `bench_neighbors`: 5x edges per node
- `bench_get_node`: 2x edges per node

The edge-to-node ratio directly affects memory layout, cache behavior, and lookup structures. Comparing numbers across benchmarks is meaningless when the underlying graphs differ structurally. If `bfs` at 10K with 3x edges is slower than `neighbors` at 10K with 5x edges, is that because BFS is inherently slower, or because the graph structures differ?

**The correct approach:** Either standardize the edge ratio across all benchmarks, or document the rationale for each ratio and ensure no cross-benchmark comparisons are made in the report.

**Severity:** LOW-MEDIUM. Confounding variable that undermines cross-operation comparisons.

---

## Summary of Issues by Severity

| # | Issue | Severity |
|---|-------|----------|
| 1 | Memory measurement uses system-wide available memory, not process RSS | CRITICAL |
| 2 | Reanalysis benchmark accumulates state across iterations | HIGH |
| 4 | Compaction benchmark cannot access `CompactionResult` -- code won't compile | HIGH |
| 3 | Compaction throughput formula is dimensionally incoherent; space amplification formula is wrong | MEDIUM-HIGH |
| 7 | BFS benchmark traverses fixed 10 nodes regardless of graph size | MEDIUM-HIGH |
| 11 | Query benchmarks test write-buffer state, not steady-state segments | MEDIUM-HIGH |
| 5 | Complexity analysis contains errors and undefined variables | MEDIUM |
| 6 | add_nodes/flush benchmarks include setup cost | MEDIUM |
| 10 | "Benchmarks are self-testing" -- no validation of measurement correctness | MEDIUM |
| 8 | neighbors benchmark always queries a node with fixed neighbor count | LOW-MEDIUM |
| 12 | Inconsistent edge-to-node ratios confound cross-operation comparison | LOW-MEDIUM |
| 9 | jq dependency undeclared | LOW |

---

## Closing Remarks

The plan is not without merit in its organizational structure. The decision to separate memory profiling from Criterion benchmarks is correct. The use of `iter_batched` for compaction (but not for reanalysis -- inconsistency!) shows awareness of the pitfall. The choice of separate benchmark files per concern is reasonable.

But the details reveal a pattern of insufficient rigor: formulas written without checking units, measurements designed without considering what is actually being measured, complexity claims stated without derivation. Benchmarking is an experimental science. Every number you publish is a claim about reality. Sloppy methodology does not produce "approximate" results -- it produces *fiction that looks like data*.

I shall not soften this judgment with encouraging platitudes. The issues enumerated above must be addressed before implementation begins. The most dangerous benchmark is one that produces a confident, precise, *wrong* number.

*"Computer Science is no more about computers than astronomy is about telescopes."*
*But if you insist on using the telescope, for heaven's sake, point it at the right part of the sky.*

-- E.W. Dijkstra (channeled)
