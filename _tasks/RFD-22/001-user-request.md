# RFD-22: T6.3 Performance Benchmark Suite

## Source
Linear issue RFD-22

## Request
Implement comprehensive performance benchmark suite for RFDB v2 vs v1 comparison.

### Subtasks
1. Write throughput: nodes/sec at various sizes (1K, 10K, 100K, 1M)
2. Query latency: point lookup, attribute search, BFS, neighbors
3. Re-analysis cost: one file change in graph of N files
4. Compaction throughput: segments/sec, space amplification
5. Memory profile: RSS at various graph sizes
6. **Comparison matrix: v1 vs v2 across all metrics**

### Dependencies
- T6.1 (Background Compaction) — Done
- T6.2 (Resource Adaptation) — Done

### Context
- This is a Rust task in the RFDB team
- Milestone: M6 Performance
- Blocks: RFD-24 (Real Codebase Validation), RFD-25 (Stress Test)
