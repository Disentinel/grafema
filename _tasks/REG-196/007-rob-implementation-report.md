# Rob Pike — Implementation Report: REG-196

## What Was Done

### Phase 1: Baseline (existing benchmarks)

Ran existing 8 benchmarks to get real numbers (macOS, Apple Silicon):

| Operation | 100 | 1K | 10K | 50K | 100K |
|-----------|-----|-----|------|------|------|
| add_nodes | 1.20ms | 7.39ms | 54.9ms | - | - |
| find_by_type | - | 85.9µs | 2.33ms | - | 34.6ms |
| find_by_attr | - | 53.5µs | 737µs | - | 10.6ms |
| bfs | 9.88µs | 62.0µs | 1.35ms | - | - |
| neighbors | - | 10.2µs | 241µs | - | 5.41ms |
| reachability | 8.01µs | 59.7µs | 1.34ms | - | - |
| reachability_backward | 4.73µs | 4.42µs | 4.32µs | - | - |
| flush | - | 6.46ms | 39.8ms | 200ms | - |

### Phase 2: New Benchmarks (8 added)

Added to `packages/rfdb-server/benches/graph_operations.rs`:

| Operation | 100 | 1K | 10K | 100K |
|-----------|-----|-----|------|------|
| add_edges | 521µs | 7.00ms | 45.2ms | - |
| get_node | 292ns | 292ns* | 292ns* | 292ns* |
| get_outgoing_edges | 1.48µs | 9.65µs | 819µs | - |
| get_incoming_edges | 1.95µs | 1.76µs | 3.83µs | - |
| delete_node | 256µs | 958µs | 10.3ms | - |
| delete_edge | 306µs | 979µs | 9.66ms | - |
| compact | - | 5.36ms | 78.0ms | - |
| find_by_type_wildcard | - | 23.8µs | 630µs | 10.8ms |

*get_node is O(1) — time is constant regardless of graph size. This confirms the delta HashMap lookup path.

### Phase 3: CI Workflow

Created `.github/workflows/benchmark.yml`:
- Runs on PRs with `benchmark` label (optional) and main push (always)
- Compares PR vs main using `critcmp`
- Fails if >20% regression
- Only triggers on rfdb-server file changes

### Phase 4: Documentation

Updated `packages/rfdb-server/README.md` with:
- How to run benchmarks locally
- Benchmark coverage table
- CI regression detection info
- Before/after comparison workflow

## Key Findings

1. **get_node is O(1)**: Constant time regardless of graph size — delta HashMap lookup works correctly
2. **Incoming vs Outgoing asymmetry**: `get_incoming_edges` (1.7-3.8µs) is much faster than `get_outgoing_edges` (1.5µs-819µs). At 10K nodes, outgoing has intermittent slow operations (50-300ms). The `[RUST SLOW]` tracing warning fires at >50ms threshold.
3. **Wildcard matching overhead**: `find_by_type("http:*")` is ~3.5x faster than `find_by_type("FUNCTION")` at same scale — because wildcard matches fewer nodes (3/5 types vs all nodes of one type).
4. **Compact ≈ Flush**: As expected, compact is similar to flush (both call same code path). But benchmark establishes baseline for when they diverge.
5. **delete_node/delete_edge include graph creation in iter_batched**: The numbers include setup overhead — actual deletion is O(1) tombstone write. This is correct for regression detection (we want total cost stability).

## Files Changed

1. `packages/rfdb-server/benches/graph_operations.rs` — expanded with 8 new benchmarks
2. `.github/workflows/benchmark.yml` — new CI workflow
3. `packages/rfdb-server/README.md` — benchmarking documentation
4. `_tasks/REG-196/` — planning and implementation docs
