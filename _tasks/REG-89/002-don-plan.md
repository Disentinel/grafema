# REG-89: Track RFDB Performance Bottlenecks - Technical Plan

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-06

## Research Summary

### Industry Best Practices (from WebSearch)

**Rust Metrics Instrumentation:**
- [metrics.rs](https://metrics.rs/) - High-performance, protocol-agnostic instrumentation with near-zero overhead when disabled
- [OpenTelemetry for Rust](https://www.datadoghq.com/blog/monitor-rust-otel/) - Standardized observability with tracing crate integration
- Key principle: "pay-for-what-you-use" - metrics should have minimal impact when not being collected

**Graph Database Metrics (from Memgraph, TigerGraph, FalkorDB research):**
- [Memgraph Prometheus Monitoring](https://memgraph.com/blog/use-prometheus-monitoring-memgraph-performance-metrics) - Query latency, memory, throughput
- [Graph DB Performance](https://hypermode.com/blog/graph-db-performance) - Latency (especially p99), resource efficiency
- Key metrics: query latency distribution (p50, p95, p99), memory usage, throughput (ops/sec)

### Current State Analysis

**Existing Infrastructure:**
1. **Benchmark Suite**: Already exists in `benches/graph_operations.rs` using Criterion
   - Covers: `add_nodes`, `find_by_type`, `find_by_attr`, `bfs`, `neighbors`
   - Good foundation to extend

2. **Debug Logging Pattern**: `[RUST TAG]` format via `eprintln!`
   - Already tracking flush operations and slow queries (>50ms in `get_outgoing_edges`)
   - Uses `NAVI_DEBUG` env var for conditional debug output

3. **Memory Monitoring**: `sysinfo` crate already integrated for memory-triggered flushes
   - `check_memory_usage()` function exists
   - Threshold-based auto-flush at 80%

4. **Tracing Infrastructure**: `tracing` and `tracing-subscriber` in dependencies
   - Used minimally (only for `info!` level logging)
   - Ready for structured telemetry

**Key Hotspots Identified:**

| Operation | Location | Current Instrumentation |
|-----------|----------|------------------------|
| Query execution | `handle_request()` in `rfdb_server.rs` | None |
| Datalog evaluation | `eval.rs` | None |
| BFS/DFS traversal | `engine.rs`, `traversal.rs` | None |
| Flush to disk | `engine.rs:flush()` | Timing exists via `eprintln!` |
| Edge lookup | `get_outgoing_edges()` | Slow query warning at 50ms |

## Vision Alignment

**Core Thesis: "AI should query the graph, not read code"**

Performance bottlenecks directly undermine this vision. If queries are slow:
- Agents fall back to reading code
- Trust in Grafema degrades
- Adoption stalls

Metrics are prerequisites for optimization, not premature optimization themselves. We need data before making changes.

## Proposed Architecture

### Principle: Minimal Viable Metrics

Following "Measure, don't guess" principle and avoiding over-engineering:

```
                    +-------------------+
                    |   Metrics Layer   |
                    |  (lightweight)    |
                    +-------------------+
                           |
         +--------+--------+--------+--------+
         |        |        |        |        |
     +-------+ +-------+ +-------+ +-------+ +-------+
     |Query  | |Graph  | |Memory | |Flush  | |Server |
     |Timing | |Stats  | |Usage  | |Ops    | |Stats  |
     +-------+ +-------+ +-------+ +-------+ +-------+
```

### Metrics Categories

**1. Graph Size Metrics (Static/Cheap)**
- `graph.node_count` - Total nodes
- `graph.edge_count` - Total edges
- `graph.delta_size` - Unflushed operations
- Already have: `node_count()`, `edge_count()`, `ops_since_flush`

**2. Query Latency Metrics (Per-Request)**
- `query.duration_ms` - Time per query
- `query.slow_count` - Queries > threshold
- Track by operation type: `Bfs`, `Neighbors`, `FindByType`, `DatalogQuery`, etc.

**3. Memory Metrics (Periodic)**
- `memory.system_percent` - System memory usage
- `memory.delta_nodes` - Nodes in delta log
- `memory.delta_edges` - Edges in delta log
- Already have: `check_memory_usage()`, `delta_nodes.len()`

**4. Flush Metrics (Per-Flush)**
- `flush.duration_ms` - Flush time
- `flush.nodes_written` - Nodes persisted
- `flush.edges_written` - Edges persisted

### Slow Query Detection

Existing pattern (50ms threshold in `get_outgoing_edges`) to extend:

```rust
// Current pattern in engine.rs
let elapsed = start.elapsed();
if elapsed.as_millis() > 50 {
    eprintln!("[RUST SLOW] get_outgoing_edges: {}ms", elapsed.as_millis());
}
```

Extend to:
- All operations in `handle_request()`
- Datalog query evaluation
- Threshold: 100ms (as specified in requirements)

### Exposure Mechanism

**Option Analysis:**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| CLI flag `--metrics` | Simple, no protocol changes | Requires server restart | Good for dev |
| Stats command | Query anytime | Adds protocol complexity | Best UX |
| Stderr logging | Zero changes | Hard to consume programmatically | Already doing |
| Prometheus endpoint | Industry standard | Adds HTTP dependency | Overkill for now |

**Recommended: Hybrid Approach**
1. **CLI flag `--log-slow-queries`** - Enable slow query logging (default: off)
2. **Stats command** - New `GetStats` request type returning metrics JSON
3. **Env var `RFDB_METRICS=1`** - Enable detailed metrics output

This matches existing patterns (`NAVI_DEBUG`, stderr logging) while adding structured access.

### Dashboard Design

Simple terminal output (no GUI for v1):

```
=== RFDB Performance Dashboard ===
Graph Size: 145,230 nodes | 892,105 edges | 1,234 delta ops
Memory: 23.4% system | 12.5 MB delta

Query Latency (last 1000):
  p50: 2.3ms | p95: 15.2ms | p99: 45.8ms
  Slow (>100ms): 3 queries

Flush Stats (last flush):
  Duration: 234ms | Nodes: 5,230 | Edges: 12,340

Top Slow Queries:
  1. DatalogQuery: 523ms
  2. Bfs (depth=100): 234ms
  3. FindByAttr: 156ms
```

## Implementation Plan

### Phase 1: Metrics Infrastructure (Core)

**1.1 Add `Metrics` struct in new `src/metrics.rs`**
- Counters, histograms, timestamps
- Thread-safe via atomics
- Zero-cost when disabled

**1.2 Integrate with `GraphEngine`**
- Add `metrics: Option<Arc<Metrics>>`
- Update `create()`, `open()` to optionally enable

**1.3 CLI flag support**
- `--metrics` flag in `rfdb_server.rs`
- Pass to `DatabaseManager`

### Phase 2: Instrumentation Points

**2.1 Request Handler Timing**
- Wrap `handle_request()` with timing
- Categorize by request type
- Log slow queries to stderr

**2.2 Datalog Evaluation**
- Add timing to `Evaluator::query()`
- Track rule evaluation depth

**2.3 Traversal Operations**
- Time `bfs()`, `dfs()`, `reachability()`
- Track nodes visited

**2.4 Flush Operations**
- Already partially instrumented
- Add to metrics struct

### Phase 3: Exposure

**3.1 GetStats Command**
```rust
Request::GetStats => {
    Response::Stats {
        node_count, edge_count, delta_size,
        memory_percent, query_latency_p50, p95, p99,
        slow_query_count, last_flush_ms
    }
}
```

**3.2 Dashboard Command**
- Local CLI command: `rfdb-server --dashboard`
- Polls GetStats every second, renders to terminal

### Phase 4: Benchmark Extension

**4.1 Extend existing benchmark suite**
- Add datalog query benchmarks
- Add reachability benchmarks
- Add concurrent operation benchmarks

**4.2 Memory profiling benchmarks**
- Track memory growth over operations
- Measure delta log overhead

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Metrics overhead | Degrades performance | Feature-flag, atomic ops |
| Complex protocol changes | Breaking change | Additive only (new commands) |
| Scope creep to full APM | Over-engineering | Stick to "simple benchmark suite" |

## Out of Scope (Explicitly)

- Prometheus/Grafana integration (future, if needed)
- Distributed tracing (single server for now)
- Query optimization (this is measurement, not optimization)
- GUI dashboard (terminal output sufficient)

## Success Criteria

1. Can answer: "What is the current graph size?"
2. Can answer: "How long do queries take on average?"
3. Can answer: "Which queries are slow?"
4. Can answer: "How much memory is RFDB using?"
5. Benchmarks run and produce actionable data
6. Zero performance impact when metrics disabled

## Estimated Effort

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Infrastructure | 2-3 hours | None |
| Phase 2: Instrumentation | 3-4 hours | Phase 1 |
| Phase 3: Exposure | 2-3 hours | Phase 2 |
| Phase 4: Benchmarks | 2-3 hours | Parallel with Phase 2-3 |

**Total: 9-13 hours (2 days)**

## Next Steps

1. **Joel Spolsky** - Expand into detailed implementation spec
2. **Kent Beck** - Write tests for metrics collection
3. **Rob Pike** - Implement, matching existing patterns
4. **Steve Jobs** - Review for vision alignment
5. **Vadim** - Final approval
