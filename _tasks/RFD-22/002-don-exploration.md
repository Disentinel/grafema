## Don Exploration Report: RFD-22

### Executive Summary

RFDB v2 has a **solid existing benchmark foundation** (3 Criterion bench files, CI integration). RFD-22 should focus on **expanding coverage** per the 6 subtasks.

### Current Coverage

**`benches/graph_operations.rs`** — GraphStore trait ops benchmarked:
- add_nodes/edges (100, 1K, 10K)
- get_node point lookup (100, 1K, 10K, 100K)
- find_by_type, find_by_attr (1K, 10K, 100K)
- get_outgoing/incoming_edges, neighbors (100, 1K, 10K)
- bfs, reachability (100, 1K, 10K)
- delete_node/edge (100, 1K, 10K)
- flush, compact (1K, 10K, 50K)

**`benches/v1_v2_comparison.rs`** — Engine parity benchmarks:
- add_nodes, find_by_type, find_by_attr, get_node, bfs, neighbors, flush, commit_batch

### Gaps (mapped to RFD-22 subtasks)

1. **Write throughput 1M** — max current size is 50K. Need 100K, 1M.
2. **Query latency** — covered for small/medium. Need 100K+ for all operations.
3. **Re-analysis cost** — NOT benchmarked. commit_batch with file tombstoning.
4. **Compaction throughput** — basic bench exists, no segments/sec or space amplification.
5. **Memory profile** — NOT benchmarked. Need RSS tracking at various sizes.
6. **Comparison matrix** — partial (v1_v2_comparison.rs). Need full matrix across all sizes.

### Architecture Summary

- v1: Delta-log, single-file segments, no sharding
- v2: LSM-tree, multi-shard, L0→L1 compaction, bloom filters, zone maps
- Both engines implement GraphStore trait
- Criterion framework with HTML reports, CI integration

### Recommendation

2-point estimate → focused scope. Extend existing bench files rather than creating many new ones. Priority:

1. Extend size ranges to 100K, 1M
2. Add re-analysis (commit_batch) benchmark
3. Add compaction metrics (segments/sec, space amplification)
4. Add memory profiling (RSS tracking)
5. Extend v1_v2_comparison with all operations and sizes

### Next Steps

1. Uncle Bob reviews benchmark file structure
2. Kent writes new benchmark harnesses (parametric sizes)
3. Rob extends existing benches, adds new measurements
4. Auto-review for soundness, no artificial optimizations
