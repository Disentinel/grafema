# Joel Spolsky — Technical Specification for REG-196

## Overview

This spec expands Don's high-level plan into implementation-ready details for comprehensive RFDB benchmarking with regression detection.

**Goal:** Cover ALL GraphStore trait operations (20+ methods) with benchmarks, baseline tracking, and CI regression detection at 10% threshold.

## Architecture

### 1. Shared Benchmark Utilities

**Location:** `packages/rfdb-server/benches/common/mod.rs`

**Purpose:** DRY principle for test data generation across all benchmark files.

#### 1.1 Test Data Generator

```rust
use rfdb::{NodeRecord, EdgeRecord, GraphEngine, GraphStore};
use tempfile::TempDir;

/// Graph topology types for test data generation
pub enum GraphTopology {
    /// Chain: A->B->C->D (linear sequence)
    Chain,
    /// FanOut: A->B, A->C, A->D (star pattern from first node)
    FanOut,
    /// Random: edges distributed randomly (existing pattern)
    Random { edge_multiplier: usize },
}

/// Deterministic RNG for reproducible benchmarks
/// Uses Linear Congruential Generator (glibc parameters)
pub struct BenchRng {
    state: u64,
}

impl BenchRng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// Next random u64 (LCG: a=1103515245, c=12345, m=2^31)
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(1103515245).wrapping_add(12345);
        (self.state / 65536) % 2147483648
    }

    /// Random usize in range [0, max)
    pub fn next_usize(&mut self, max: usize) -> usize {
        (self.next_u64() % max as u64) as usize
    }
}

/// Create test graph with deterministic data
///
/// # Parameters
/// - `node_count`: Number of nodes to create
/// - `edge_count`: Number of edges to create
/// - `topology`: Graph structure (Chain, FanOut, Random)
/// - `node_type_prefix`: Prefix for node types (e.g., "FUNCTION", "CLASS")
///
/// # Returns
/// (TempDir, GraphEngine) — TempDir must be kept alive for engine to work
pub fn create_test_graph(
    node_count: usize,
    edge_count: usize,
    topology: GraphTopology,
    node_type_prefix: &str,
) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();

    // Create nodes with deterministic IDs
    let nodes: Vec<NodeRecord> = (0..node_count)
        .map(|i| NodeRecord {
            id: i as u128,
            node_type: Some(format!("{}_{}", node_type_prefix, i % 5)), // 5 type variants
            file_id: (i % 100) as u32,
            name_offset: i as u32,
            version: "main".to_string(),
            exported: i % 10 == 0, // 10% exported
            replaces: None,
            deleted: false,
            name: Some(format!("item_{}", i)),
            file: Some(format!("src/file_{}.js", i % 100)),
            metadata: None,
        })
        .collect();

    engine.add_nodes(nodes);

    // Create edges based on topology
    let edges: Vec<EdgeRecord> = match topology {
        GraphTopology::Chain => {
            // A->B->C->D linear chain
            (0..edge_count.min(node_count - 1))
                .map(|i| EdgeRecord {
                    src: i as u128,
                    dst: (i + 1) as u128,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                })
                .collect()
        }
        GraphTopology::FanOut => {
            // Node 0 connects to all others
            (0..edge_count.min(node_count - 1))
                .map(|i| EdgeRecord {
                    src: 0,
                    dst: (i + 1) as u128,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                })
                .collect()
        }
        GraphTopology::Random { edge_multiplier } => {
            // Random edges (deterministic via LCG)
            let mut rng = BenchRng::new(42);
            (0..edge_count)
                .map(|_| EdgeRecord {
                    src: rng.next_usize(node_count) as u128,
                    dst: rng.next_usize(node_count) as u128,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                })
                .collect()
        }
    };

    engine.add_edges(edges, false);

    (dir, engine)
}

/// Standard dataset sizes for benchmarks
pub const SIZES_SMALL: &[usize] = &[100, 1_000, 10_000];
pub const SIZES_MEDIUM: &[usize] = &[1_000, 10_000, 100_000];
pub const SIZES_LARGE: &[usize] = &[10_000, 100_000];
```

**Complexity Analysis:**
- `create_test_graph`: O(n + m) where n=nodes, m=edges
- `BenchRng::next_u64`: O(1)
- Memory: O(n + m) temporary vectors

**Why LCG instead of external RNG?**
- No dependencies (rand crate not needed)
- Deterministic (same seed = same graph)
- Fast (single multiply + add)
- Good enough for benchmark data (not cryptographic)

#### 1.2 Cargo.toml Updates

Add to `[dev-dependencies]`:
```toml
# No new dependencies needed — reuse tempfile from existing benchmarks
```

Add new benchmark entries:
```toml
[[bench]]
name = "mutation_operations"
harness = false

[[bench]]
name = "lookup_operations"
harness = false

[[bench]]
name = "aggregation_operations"
harness = false

[[bench]]
name = "maintenance_operations"
harness = false

[[bench]]
name = "mixed_workloads"
harness = false
```

---

### 2. New Benchmark Files

#### 2.1 `benches/mutation_operations.rs`

**Operations covered:**
- `delete_node` (soft delete)
- `delete_edge`
- `update_node_version`
- `add_edges` (separate from add_nodes)

**Benchmarks:**

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord};
use tempfile::TempDir;

mod common;
use common::{create_test_graph, GraphTopology, SIZES_MEDIUM};

/// Benchmark: add_edges (batch operation)
/// Measures: Time to add N edges to existing graph
/// Setup: Create graph with nodes only
/// Complexity: O(m log m) — m edges, log m for index updates
fn bench_add_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("add_edges");

    for &size in SIZES_MEDIUM {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    // Setup: graph with nodes but no edges
                    let dir = TempDir::new().unwrap();
                    let mut engine = GraphEngine::create(dir.path()).unwrap();
                    let nodes: Vec<NodeRecord> = (0..size)
                        .map(|i| NodeRecord {
                            id: i as u128,
                            node_type: Some("FUNCTION".to_string()),
                            file_id: 1,
                            name_offset: i as u32,
                            version: "main".to_string(),
                            exported: false,
                            replaces: None,
                            deleted: false,
                            name: Some(format!("func_{}", i)),
                            file: Some("src/test.js".to_string()),
                            metadata: None,
                        })
                        .collect();
                    engine.add_nodes(nodes);

                    // Prepare edges to add
                    let edges: Vec<EdgeRecord> = (0..size)
                        .map(|i| EdgeRecord {
                            src: (i % size) as u128,
                            dst: ((i + 1) % size) as u128,
                            edge_type: Some("CALLS".to_string()),
                            version: "main".to_string(),
                            metadata: None,
                            deleted: false,
                        })
                        .collect();

                    (dir, engine, edges)
                },
                |(_, mut engine, edges)| {
                    // Measure only add_edges
                    engine.add_edges(black_box(edges), false);
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

/// Benchmark: delete_node
/// Measures: Time to soft-delete N nodes (one per iteration)
/// Setup: Create graph, pick random nodes to delete
/// Complexity: O(1) — tombstone write to delta log
fn bench_delete_node(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_node");

    for &size in &[1_000, 10_000, 100_000] {
        let (_dir, mut engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut node_idx = 0;
            b.iter(|| {
                // Delete nodes sequentially (avoid deleting same node twice)
                engine.delete_node(black_box(node_idx as u128));
                node_idx = (node_idx + 1) % size;
            });
        });
    }

    group.finish();
}

/// Benchmark: delete_edge
/// Measures: Time to delete edges (one per iteration)
/// Setup: Create graph with edges, delete them sequentially
/// Complexity: O(log m) — index update for edge removal
fn bench_delete_edge(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_edge");

    for &size in &[1_000, 10_000, 100_000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    // Setup: fresh graph for each iteration
                    create_test_graph(
                        size,
                        size * 2,
                        GraphTopology::Random { edge_multiplier: 2 },
                        "FUNCTION",
                    )
                },
                |(_, mut engine)| {
                    // Delete first edge
                    engine.delete_edge(black_box(0), black_box(1), "CALLS");
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

/// Benchmark: update_node_version
/// Measures: Time to update node version (creates new version via tombstone + new record)
/// Setup: Graph with nodes, update versions sequentially
/// Complexity: O(1) — delta log append (tombstone + new record)
fn bench_update_node_version(c: &mut Criterion) {
    let mut group = c.benchmark_group("update_node_version");

    for &size in &[1_000, 10_000, 100_000] {
        let (_dir, mut engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut node_idx = 0;
            b.iter(|| {
                engine.update_node_version(black_box(node_idx as u128), "feature-branch");
                node_idx = (node_idx + 1) % size;
            });
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_add_edges,
    bench_delete_node,
    bench_delete_edge,
    bench_update_node_version
);
criterion_main!(benches);
```

**Notes:**
- `delete_node` / `update_node_version`: no batched setup needed (ops are cheap, graph persists across iterations)
- `delete_edge`: uses `iter_batched` to ensure edge exists for each deletion
- `add_edges`: measures pure edge insertion (nodes pre-created)

---

#### 2.2 `benches/lookup_operations.rs`

**Operations covered:**
- `get_node`
- `node_exists`
- `get_outgoing_edges`
- `get_incoming_edges`
- `get_all_edges`
- `get_node_identifier`

**Benchmarks:**

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use rfdb::{GraphEngine, GraphStore};

mod common;
use common::{create_test_graph, GraphTopology, SIZES_MEDIUM};

/// Benchmark: get_node
/// Measures: Time to fetch single node by ID
/// Setup: Graph with N nodes
/// Complexity: O(log n) — sled index lookup + potential delta log scan
fn bench_get_node(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_node");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.get_node(black_box(42));
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: node_exists
/// Measures: Time to check if node exists (no data fetch)
/// Setup: Graph with N nodes
/// Complexity: O(log n) — index lookup only (faster than get_node)
fn bench_node_exists(c: &mut Criterion) {
    let mut group = c.benchmark_group("node_exists");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.node_exists(black_box(42));
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: get_outgoing_edges
/// Measures: Time to fetch all outgoing edges from a node
/// Setup: Graph with high fan-out (node 0 -> many others)
/// Complexity: O(k log m) — k outgoing edges, m total edges
fn bench_get_outgoing_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_outgoing_edges");

    for &size in &[1_000, 10_000, 100_000] {
        // FanOut topology: node 0 has maximum outgoing edges
        let (_dir, engine) = create_test_graph(
            size,
            size - 1, // node 0 -> all others
            GraphTopology::FanOut,
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.get_outgoing_edges(black_box(0), None);
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: get_incoming_edges
/// Measures: Time to fetch all incoming edges to a node
/// Setup: Graph with FanOut (all nodes -> node 1)
/// Complexity: O(k log m) — k incoming edges, m total edges
fn bench_get_incoming_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_incoming_edges");

    for &size in &[1_000, 10_000, 100_000] {
        // Modified FanOut: all nodes point TO node 1 instead of FROM node 0
        let (_dir, mut engine) = create_test_graph(
            size,
            0, // no edges initially
            GraphTopology::Chain,
            "FUNCTION",
        );

        // Add edges: all nodes -> node 1
        use rfdb::EdgeRecord;
        let edges: Vec<EdgeRecord> = (2..size)
            .map(|i| EdgeRecord {
                src: i as u128,
                dst: 1,
                edge_type: Some("CALLS".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            })
            .collect();
        engine.add_edges(edges, false);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.get_incoming_edges(black_box(1), None);
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: get_all_edges
/// Measures: Time to fetch ALL edges from graph
/// Setup: Graph with M edges
/// Complexity: O(m) — full edge table scan
fn bench_get_all_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_all_edges");

    for &size in &[1_000, 10_000, 100_000] {
        let (_dir, engine) = create_test_graph(
            size,
            size * 3, // 3x edges
            GraphTopology::Random { edge_multiplier: 3 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.get_all_edges();
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: get_node_identifier
/// Measures: Time to construct "TYPE:name@file" identifier string
/// Setup: Graph with N nodes
/// Complexity: O(log n) — node lookup + string formatting
fn bench_get_node_identifier(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_node_identifier");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.get_node_identifier(black_box(42));
                black_box(result);
            });
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_get_node,
    bench_node_exists,
    bench_get_outgoing_edges,
    bench_get_incoming_edges,
    bench_get_all_edges,
    bench_get_node_identifier
);
criterion_main!(benches);
```

**Notes:**
- `get_outgoing_edges` / `get_incoming_edges`: use FanOut topology to maximize edge count for single node
- `get_all_edges`: O(m) operation — expected to be slow at 100K edges, but necessary to benchmark
- Lookups share same graph across iterations (read-only, no mutation)

---

#### 2.3 `benches/aggregation_operations.rs`

**Operations covered:**
- `node_count`
- `edge_count`
- `count_nodes_by_type` (with/without wildcard)
- `count_edges_by_type` (with/without wildcard)

**Benchmarks:**

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use rfdb::{GraphEngine, GraphStore};

mod common;
use common::{create_test_graph, GraphTopology, SIZES_MEDIUM};

/// Benchmark: node_count
/// Measures: Time to count total nodes
/// Setup: Graph with N nodes
/// Complexity: O(1) if cached, O(n) if scanning
fn bench_node_count(c: &mut Criterion) {
    let mut group = c.benchmark_group("node_count");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.node_count();
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: edge_count
/// Measures: Time to count total edges
/// Setup: Graph with M edges
/// Complexity: O(1) if cached, O(m) if scanning
fn bench_edge_count(c: &mut Criterion) {
    let mut group = c.benchmark_group("edge_count");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.edge_count();
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: count_nodes_by_type (no filter)
/// Measures: Time to count nodes grouped by type
/// Setup: Graph with 5 node type variants
/// Complexity: O(n) — full scan with HashMap aggregation
fn bench_count_nodes_by_type_all(c: &mut Criterion) {
    let mut group = c.benchmark_group("count_nodes_by_type_all");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.count_nodes_by_type(None);
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: count_nodes_by_type (with wildcard filter)
/// Measures: Time to count nodes matching "FUNCTION_*" pattern
/// Setup: Graph with 5 node type variants (all match wildcard)
/// Complexity: O(n) — full scan + regex/wildcard matching
fn bench_count_nodes_by_type_wildcard(c: &mut Criterion) {
    let mut group = c.benchmark_group("count_nodes_by_type_wildcard");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let filter = vec!["FUNCTION_*".to_string()];
                let result = engine.count_nodes_by_type(Some(&filter));
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: count_edges_by_type (no filter)
/// Measures: Time to count edges grouped by type
/// Setup: Graph with single edge type "CALLS"
/// Complexity: O(m) — full edge scan
fn bench_count_edges_by_type_all(c: &mut Criterion) {
    let mut group = c.benchmark_group("count_edges_by_type_all");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.count_edges_by_type(None);
                black_box(result);
            });
        });
    }

    group.finish();
}

/// Benchmark: count_edges_by_type (with filter)
/// Measures: Time to count edges of specific types
/// Setup: Graph with "CALLS" edges
/// Complexity: O(m) — filtered edge scan
fn bench_count_edges_by_type_filtered(c: &mut Criterion) {
    let mut group = c.benchmark_group("count_edges_by_type_filtered");

    for &size in SIZES_MEDIUM {
        let (_dir, engine) = create_test_graph(
            size,
            size * 2,
            GraphTopology::Random { edge_multiplier: 2 },
            "FUNCTION",
        );

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let filter = vec!["CALLS".to_string()];
                let result = engine.count_edges_by_type(Some(&filter));
                black_box(result);
            });
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_node_count,
    bench_edge_count,
    bench_count_nodes_by_type_all,
    bench_count_nodes_by_type_wildcard,
    bench_count_edges_by_type_all,
    bench_count_edges_by_type_filtered
);
criterion_main!(benches);
```

**Notes:**
- Aggregation ops are O(n) or O(m) — inherently expensive
- Wildcard benchmarks test regex performance overhead
- If counts are cached, benchmarks will show O(1) behavior (good to know!)

---

#### 2.4 `benches/maintenance_operations.rs`

**Operations covered:**
- `flush`
- `compact`

**Benchmarks:**

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use rfdb::{GraphEngine, GraphStore, NodeRecord};
use tempfile::TempDir;

/// Benchmark: flush
/// Measures: Time to flush delta log to disk
/// Setup: Graph with N nodes in delta log (unflushed)
/// Complexity: O(n + m) — write all delta entries to disk
fn bench_flush(c: &mut Criterion) {
    let mut group = c.benchmark_group("flush");

    for &size in &[1_000, 10_000, 50_000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    // Setup: fresh engine with unflushed data
                    let dir = TempDir::new().unwrap();
                    let mut engine = GraphEngine::create(dir.path()).unwrap();

                    let nodes: Vec<NodeRecord> = (0..size)
                        .map(|i| NodeRecord {
                            id: i as u128,
                            node_type: Some("FUNCTION".to_string()),
                            file_id: (i % 100) as u32,
                            name_offset: i as u32,
                            version: "main".to_string(),
                            exported: false,
                            replaces: None,
                            deleted: false,
                            name: Some(format!("func_{}", i)),
                            file: Some(format!("src/file_{}.js", i % 100)),
                            metadata: None,
                        })
                        .collect();

                    engine.add_nodes(nodes);
                    (dir, engine)
                },
                |(_, mut engine)| {
                    // Measure flush only
                    black_box(engine.flush().unwrap());
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

/// Benchmark: compact
/// Measures: Time to compact delta log into immutable segments
/// Setup: Graph with multiple flush cycles (simulates fragmented delta log)
/// Complexity: O(n + m) — currently alias for flush(), may diverge in future
fn bench_compact(c: &mut Criterion) {
    let mut group = c.benchmark_group("compact");

    for &size in &[1_000, 10_000, 50_000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    // Setup: engine with data + flush, then add more data
                    let dir = TempDir::new().unwrap();
                    let mut engine = GraphEngine::create(dir.path()).unwrap();

                    let nodes: Vec<NodeRecord> = (0..size)
                        .map(|i| NodeRecord {
                            id: i as u128,
                            node_type: Some("FUNCTION".to_string()),
                            file_id: 1,
                            name_offset: i as u32,
                            version: "main".to_string(),
                            exported: false,
                            replaces: None,
                            deleted: false,
                            name: Some(format!("func_{}", i)),
                            file: Some("src/test.js".to_string()),
                            metadata: None,
                        })
                        .collect();

                    engine.add_nodes(nodes);
                    engine.flush().unwrap();

                    // Add more nodes (creates delta log entries)
                    let more_nodes: Vec<NodeRecord> = (size..size * 2)
                        .map(|i| NodeRecord {
                            id: i as u128,
                            node_type: Some("CLASS".to_string()),
                            file_id: 2,
                            name_offset: i as u32,
                            version: "main".to_string(),
                            exported: false,
                            replaces: None,
                            deleted: false,
                            name: Some(format!("class_{}", i)),
                            file: Some("src/other.js".to_string()),
                            metadata: None,
                        })
                        .collect();
                    engine.add_nodes(more_nodes);

                    (dir, engine)
                },
                |(_, mut engine)| {
                    // Measure compact only
                    black_box(engine.compact().unwrap());
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

criterion_group!(benches, bench_flush, bench_compact);
criterion_main!(benches);
```

**Notes:**
- Both use `iter_batched` to create fresh state for each iteration
- `compact` currently = `flush()`, but benchmarking separately future-proofs for divergence
- 50K max size (larger datasets make flush too slow for CI)

---

#### 2.5 `benches/mixed_workloads.rs`

**Purpose:** Simulate realistic usage patterns (read + write interleaved).

**Benchmarks:**

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord, AttrQuery};
use tempfile::TempDir;

mod common;
use common::{create_test_graph, GraphTopology, BenchRng};

/// Benchmark: read-heavy workload (90% reads, 10% writes)
/// Measures: Throughput of mixed operations
/// Setup: Graph with 10K nodes, perform 100 ops (90 reads, 10 writes)
/// Complexity: Depends on mix (mostly O(log n) lookups + occasional O(1) writes)
fn bench_read_heavy_workload(c: &mut Criterion) {
    let mut group = c.benchmark_group("workload_read_heavy");

    let size = 10_000;
    group.bench_function("10k_nodes", |b| {
        b.iter_batched(
            || {
                create_test_graph(
                    size,
                    size * 2,
                    GraphTopology::Random { edge_multiplier: 2 },
                    "FUNCTION",
                )
            },
            |(_, mut engine)| {
                let mut rng = BenchRng::new(123);

                // 100 operations: 90 reads, 10 writes
                for i in 0..100 {
                    if i % 10 == 0 {
                        // Write: add new node
                        let new_node = NodeRecord {
                            id: (size + i) as u128,
                            node_type: Some("TEMP".to_string()),
                            file_id: 999,
                            name_offset: i as u32,
                            version: "main".to_string(),
                            exported: false,
                            replaces: None,
                            deleted: false,
                            name: Some(format!("temp_{}", i)),
                            file: Some("src/temp.js".to_string()),
                            metadata: None,
                        };
                        engine.add_nodes(vec![new_node]);
                    } else {
                        // Read: random node lookup
                        let node_id = rng.next_usize(size) as u128;
                        black_box(engine.get_node(node_id));
                    }
                }
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.finish();
}

/// Benchmark: write-heavy workload (50% reads, 50% writes)
/// Measures: Throughput when writes dominate
/// Setup: Graph with 10K nodes, perform 100 ops (50/50 split)
/// Complexity: Mixed O(log n) + O(1) ops
fn bench_write_heavy_workload(c: &mut Criterion) {
    let mut group = c.benchmark_group("workload_write_heavy");

    let size = 10_000;
    group.bench_function("10k_nodes", |b| {
        b.iter_batched(
            || {
                create_test_graph(
                    size,
                    size * 2,
                    GraphTopology::Random { edge_multiplier: 2 },
                    "FUNCTION",
                )
            },
            |(_, mut engine)| {
                let mut rng = BenchRng::new(456);

                // 100 operations: 50 reads, 50 writes
                for i in 0..100 {
                    if i % 2 == 0 {
                        // Write: add edge
                        let src = rng.next_usize(size) as u128;
                        let dst = rng.next_usize(size) as u128;
                        let edge = EdgeRecord {
                            src,
                            dst,
                            edge_type: Some("TEMP_CALL".to_string()),
                            version: "main".to_string(),
                            metadata: None,
                            deleted: false,
                        };
                        engine.add_edges(vec![edge], false);
                    } else {
                        // Read: neighbors query
                        let node_id = rng.next_usize(size) as u128;
                        black_box(engine.neighbors(node_id, &["CALLS"]));
                    }
                }
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.finish();
}

/// Benchmark: analytical workload (complex queries on stable graph)
/// Measures: Time for BFS + aggregation queries
/// Setup: Graph with 10K nodes, run 10 analytical queries
/// Complexity: O(n) aggregations + O(k) BFS traversals
fn bench_analytical_workload(c: &mut Criterion) {
    let mut group = c.benchmark_group("workload_analytical");

    let size = 10_000;
    let (_dir, engine) = create_test_graph(
        size,
        size * 3,
        GraphTopology::Random { edge_multiplier: 3 },
        "FUNCTION",
    );

    group.bench_function("10k_nodes", |b| {
        b.iter(|| {
            // Query 1: Count all nodes by type
            black_box(engine.count_nodes_by_type(None));

            // Query 2: BFS from node 0
            black_box(engine.bfs(&[0], 5, &["CALLS"]));

            // Query 3: Find exported functions
            let query = AttrQuery::new().exported(true);
            black_box(engine.find_by_attr(&query));

            // Query 4: Get all edges of type CALLS
            black_box(engine.count_edges_by_type(Some(&[
                "CALLS".to_string()
            ])));

            // Query 5: Reachability from multiple roots
            black_box(engine.reachability(&[0, 100, 200], 10, &["CALLS"], false));
        });
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_read_heavy_workload,
    bench_write_heavy_workload,
    bench_analytical_workload
);
criterion_main!(benches);
```

**Notes:**
- Mixed workloads simulate realistic usage (not isolated ops)
- Read-heavy = typical AI agent queries
- Write-heavy = initial graph construction
- Analytical = complex queries (what Grafema is built for)

---

### 3. Modifications to `graph_operations.rs`

**Changes:**

1. **Move `add_edges` benchmark** → `mutation_operations.rs` (already moved above)
2. **Keep existing benchmarks** (don't break current baselines)
3. **Add missing `reachability` variant** (already exists, no changes needed)

**Result:** `graph_operations.rs` remains as-is. No modifications needed.

**Rationale:** Existing file has stable baselines. Adding new files doesn't invalidate old benchmarks.

---

### 4. CI Workflow

**File:** `.github/workflows/benchmark.yml`

```yaml
name: RFDB Benchmarks

on:
  push:
    branches: [main]
    paths:
      - 'packages/rfdb-server/**'
      - '.github/workflows/benchmark.yml'
  pull_request:
    branches: [main]
    types: [opened, synchronize, labeled]
    paths:
      - 'packages/rfdb-server/**'

jobs:
  benchmark:
    # Only run on PRs with 'benchmark' label OR always on main
    if: |
      github.event_name == 'push' ||
      (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'benchmark'))

    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Need history for baseline comparison

      - name: Setup Rust toolchain
        uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
          profile: minimal
          override: true

      - name: Cache Cargo registry
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            target
          key: ${{ runner.os }}-cargo-bench-${{ hashFiles('**/Cargo.lock') }}
          restore-keys: |
            ${{ runner.os }}-cargo-bench-

      - name: Run benchmarks
        working-directory: packages/rfdb-server
        run: |
          cargo bench --bench graph_operations -- --save-baseline current
          cargo bench --bench mutation_operations -- --save-baseline current
          cargo bench --bench lookup_operations -- --save-baseline current
          cargo bench --bench aggregation_operations -- --save-baseline current
          cargo bench --bench maintenance_operations -- --save-baseline current
          cargo bench --bench mixed_workloads -- --save-baseline current

      - name: Store benchmark results
        uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'criterion'
          output-file-path: packages/rfdb-server/target/criterion/**/estimates.json

          # Fail workflow if regression detected
          fail-on-alert: true
          alert-threshold: '110%'  # 10% regression = alert

          # Comment on PR with results
          comment-on-alert: ${{ github.event_name == 'pull_request' }}

          # GitHub token for commenting
          github-token: ${{ secrets.GITHUB_TOKEN }}

          # Auto-push baseline updates (only on main)
          auto-push: ${{ github.ref == 'refs/heads/main' }}

          # Store baseline in gh-pages branch
          gh-pages-branch: gh-pages
          benchmark-data-dir-path: benchmarks

      - name: Upload Criterion HTML reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: criterion-reports
          path: packages/rfdb-server/target/criterion
          retention-days: 30
```

**Key features:**
- Runs on main push (always) + PR with `benchmark` label (optional)
- Saves baseline to `gh-pages` branch (automated via github-action-benchmark)
- Fails workflow if >10% regression
- Comments on PR with comparison results
- Uploads HTML reports as artifacts

**Expected runtime:** ~12-15 minutes (6 benchmark files × 2-2.5 min each)

---

### 5. Baseline Management

#### 5.1 Baseline Storage

**Strategy:** Use github-action-benchmark's automatic gh-pages storage.

**How it works:**
1. On main push: benchmark runs, results pushed to `gh-pages` branch under `benchmarks/` directory
2. On PR: benchmark compares against latest `gh-pages` baseline
3. No manual JSON files needed (github-action-benchmark handles it)

#### 5.2 Manual Baseline Inspection

If needed, baseline JSON is accessible at:
```
https://raw.githubusercontent.com/reginavibe/grafema/gh-pages/benchmarks/data.js
```

#### 5.3 Versioned Baselines (for releases)

**Script:** `scripts/benchmark-release.sh`

```bash
#!/usr/bin/env bash
# Create versioned benchmark baseline snapshot on release

set -euo pipefail

VERSION="$1"  # e.g., "v0.3.0"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 v0.3.0"
  exit 1
fi

cd "$(dirname "$0")/../packages/rfdb-server"

echo "Running full benchmark suite for $VERSION..."
cargo bench --bench graph_operations -- --save-baseline "$VERSION"
cargo bench --bench mutation_operations -- --save-baseline "$VERSION"
cargo bench --bench lookup_operations -- --save-baseline "$VERSION"
cargo bench --bench aggregation_operations -- --save-baseline "$VERSION"
cargo bench --bench maintenance_operations -- --save-baseline "$VERSION"
cargo bench --bench mixed_workloads -- --save-baseline "$VERSION"

echo "✅ Baseline saved as: target/criterion/**/base/$VERSION"
echo "To compare against this baseline later:"
echo "  cargo bench --bench <name> -- --baseline $VERSION"
```

**Usage:**
```bash
./scripts/benchmark-release.sh v0.3.0
```

**Result:** Baseline saved in `target/criterion/**/base/v0.3.0/` (local only, not committed).

#### 5.4 Comparing Baselines Locally

```bash
# Compare current code against v0.3.0 baseline
cd packages/rfdb-server
cargo bench --bench graph_operations -- --baseline v0.3.0

# Criterion will output comparison table:
#   v0.3.0 baseline: 128.5 µs
#   current:         125.2 µs
#   change:          -2.6% (improvement)
```

---

### 6. Documentation

#### 6.1 `packages/rfdb-server/README.md` Addition

Add section after "Building" section:

```markdown
## Benchmarking

RFDB includes comprehensive benchmarks for all GraphStore operations.

### Running Benchmarks Locally

```bash
cd packages/rfdb-server

# Run all benchmarks
cargo bench

# Run specific benchmark file
cargo bench --bench graph_operations
cargo bench --bench mutation_operations
cargo bench --bench lookup_operations
cargo bench --bench aggregation_operations
cargo bench --bench maintenance_operations
cargo bench --bench mixed_workloads

# Save baseline for future comparison
cargo bench -- --save-baseline my-baseline

# Compare against saved baseline
cargo bench -- --baseline my-baseline
```

### Interpreting Results

Criterion outputs:
- **time**: Mean execution time with confidence interval
- **change**: % change from previous run (if baseline exists)
- **thrpt**: Throughput (operations per second)

**Example output:**
```
graph_operations/add_nodes/1000
  time:   [127.45 µs 128.12 µs 128.89 µs]
  change: [-2.1% -1.5% -0.8%] (improvement)
  thrpt:  7,806 ops/sec
```

HTML reports are generated in `target/criterion/` for detailed analysis.

### CI Regression Detection

Benchmarks run automatically on:
- Every push to `main` (updates baseline)
- PRs with `benchmark` label (compares against main baseline)

**Regression threshold:** 10% degradation triggers workflow failure.

To trigger benchmarks on your PR:
1. Add `benchmark` label to PR
2. CI will run full suite and comment with results

### Baseline Management

**Creating release baseline:**
```bash
./scripts/benchmark-release.sh v0.3.0
```

**Comparing against release baseline:**
```bash
cargo bench --bench graph_operations -- --baseline v0.3.0
```

Baselines are stored in:
- **CI:** `gh-pages` branch (automatic via github-action-benchmark)
- **Local:** `target/criterion/**/base/<baseline-name>/`

### Benchmark Coverage

All GraphStore trait operations are benchmarked:
- **Node ops:** add_nodes, delete_node, get_node, node_exists, find_by_type, find_by_attr
- **Edge ops:** add_edges, delete_edge, neighbors, get_outgoing_edges, get_incoming_edges, get_all_edges
- **Aggregation:** node_count, edge_count, count_nodes_by_type, count_edges_by_type
- **Traversal:** bfs, reachability
- **Maintenance:** flush, compact
- **Mixed workloads:** read-heavy, write-heavy, analytical

### Performance Expectations

Target performance (as of v0.3.0):

| Operation | Dataset | Target |
|-----------|---------|--------|
| add_nodes | 10K | <5ms |
| get_node | 100K graph | <50µs |
| bfs (depth=10) | 10K graph | <2ms |
| find_by_type | 100K graph | <10ms |
| flush | 10K nodes | <20ms |

These are guidelines, not hard requirements. Actual performance varies by hardware.
```

#### 6.2 Root `CONTRIBUTING.md` Addition

Add section under "Development Workflow":

```markdown
### Performance Testing

Before submitting performance-sensitive changes (graph algorithms, storage layer, indexes):

1. **Benchmark locally:**
   ```bash
   cd packages/rfdb-server
   cargo bench -- --save-baseline before
   # Make your changes
   cargo bench -- --baseline before
   ```

2. **Check for regressions:**
   - <5% slower: acceptable (noise)
   - 5-10% slower: explain in PR why this is necessary
   - >10% slower: **investigate before submitting**

3. **Add `benchmark` label to PR** to trigger CI benchmarks.

**When benchmarks fail in CI:**
- Review the comparison comment on your PR
- If regression is expected (e.g., added feature has cost), explain in PR description
- If regression is unexpected, investigate root cause

**Performance is a feature.** Regressions without justification will not be merged.
```

---

## Implementation Checklist

### Phase 1: Shared Infrastructure (2-3 hours)

- [ ] Create `packages/rfdb-server/benches/common/mod.rs`
  - [ ] `BenchRng` struct with LCG implementation
  - [ ] `GraphTopology` enum (Chain, FanOut, Random)
  - [ ] `create_test_graph` function
  - [ ] Export `SIZES_SMALL`, `SIZES_MEDIUM`, `SIZES_LARGE` constants
- [ ] Update `Cargo.toml` with new `[[bench]]` entries (5 new files)

### Phase 2: New Benchmark Files (8-10 hours)

- [ ] `benches/mutation_operations.rs`
  - [ ] bench_add_edges
  - [ ] bench_delete_node
  - [ ] bench_delete_edge
  - [ ] bench_update_node_version
- [ ] `benches/lookup_operations.rs`
  - [ ] bench_get_node
  - [ ] bench_node_exists
  - [ ] bench_get_outgoing_edges
  - [ ] bench_get_incoming_edges
  - [ ] bench_get_all_edges
  - [ ] bench_get_node_identifier
- [ ] `benches/aggregation_operations.rs`
  - [ ] bench_node_count
  - [ ] bench_edge_count
  - [ ] bench_count_nodes_by_type_all
  - [ ] bench_count_nodes_by_type_wildcard
  - [ ] bench_count_edges_by_type_all
  - [ ] bench_count_edges_by_type_filtered
- [ ] `benches/maintenance_operations.rs`
  - [ ] bench_flush
  - [ ] bench_compact
- [ ] `benches/mixed_workloads.rs`
  - [ ] bench_read_heavy_workload
  - [ ] bench_write_heavy_workload
  - [ ] bench_analytical_workload

### Phase 3: CI Integration (2-3 hours)

- [ ] Create `.github/workflows/benchmark.yml`
- [ ] Test workflow on PR (verify trigger logic)
- [ ] Verify baseline storage in gh-pages branch
- [ ] Test regression detection (introduce intentional slowdown)
- [ ] Verify PR comment functionality

### Phase 4: Baseline Tooling (1-2 hours)

- [ ] Create `scripts/benchmark-release.sh`
- [ ] Test baseline creation: `./scripts/benchmark-release.sh v0.3.0`
- [ ] Test baseline comparison: `cargo bench -- --baseline v0.3.0`
- [ ] Verify HTML reports generation

### Phase 5: Documentation (2-3 hours)

- [ ] Update `packages/rfdb-server/README.md` with Benchmarking section
- [ ] Update root `CONTRIBUTING.md` with Performance Testing section
- [ ] Add inline code comments explaining benchmark design choices
- [ ] Document expected performance targets in README table

### Phase 6: Validation (1-2 hours)

- [ ] Run full benchmark suite locally (verify all benchmarks complete without errors)
- [ ] Verify Criterion HTML reports are generated correctly
- [ ] Check benchmark execution time (<15 min total)
- [ ] Confirm baseline comparison works (compare against saved baseline)
- [ ] Test CI workflow end-to-end (push to main, verify gh-pages update)

---

## Complexity Analysis Summary

| Operation | Complexity | Notes |
|-----------|------------|-------|
| **add_nodes** | O(n) | Batch write to delta log |
| **add_edges** | O(m log m) | Batch write + index updates |
| **delete_node** | O(1) | Tombstone append |
| **delete_edge** | O(log m) | Index update |
| **get_node** | O(log n) | Index lookup + delta scan |
| **node_exists** | O(log n) | Index lookup only (faster than get_node) |
| **find_by_type** | O(n) | Full node scan with filter |
| **find_by_attr** | O(n) | Full node scan with query |
| **neighbors** | O(k log m) | k = neighbor count, m = total edges |
| **get_outgoing_edges** | O(k log m) | k = outgoing edge count |
| **get_incoming_edges** | O(k log m) | k = incoming edge count |
| **get_all_edges** | O(m) | Full edge table scan |
| **node_count** | O(1) or O(n) | Depends on caching |
| **edge_count** | O(1) or O(m) | Depends on caching |
| **count_nodes_by_type** | O(n) | Full scan + HashMap aggregation |
| **count_edges_by_type** | O(m) | Full scan + HashMap aggregation |
| **bfs** | O(V + E) | V = visited nodes, E = edges traversed |
| **reachability** | O(V + E) | Similar to BFS |
| **flush** | O(n + m) | Write all delta entries to disk |
| **compact** | O(n + m) | Currently alias for flush |

**Dataset size limits:**
- **100K nodes** = upper bound (realistic for single-file analysis)
- **300K edges** = 3× edge multiplier (typical for interconnected code)
- **Execution time target:** <30 sec per benchmark function

---

## Risk Mitigation

### Risk 1: Benchmarks too slow for CI

**Symptom:** Workflow exceeds 15 minutes.

**Mitigation:**
- Reduce dataset sizes (100K → 50K for largest tests)
- Parallelize benchmark jobs (split 6 files into 2 parallel jobs)
- Make PR benchmarks optional (require label)

### Risk 2: Noisy CI environment

**Symptom:** False positive regressions (10% threshold too sensitive).

**Mitigation:**
- Increase threshold to 115% (15% regression)
- Run benchmarks multiple times, take median
- Criterion already does statistical outlier detection (helps)

### Risk 3: Missing GraphStore operations

**Symptom:** Trait adds new method, no benchmark exists.

**Mitigation:**
- Add TODO comment in trait definition: "Add benchmark when implementing"
- Code review checklist: "Did you add benchmark for new GraphStore method?"

### Risk 4: Baseline drift over hardware changes

**Symptom:** GHA runner upgrade causes all benchmarks to change.

**Mitigation:**
- Accept the drift, re-baseline on main
- Document in commit: "Re-baseline after GHA runner upgrade"
- Historical baselines become incomparable (acceptable tradeoff)

---

## Success Criteria

1. ✅ All 20+ GraphStore operations have benchmarks
2. ✅ Benchmarks run successfully in CI (<15 min total)
3. ✅ Baseline stored in gh-pages branch
4. ✅ Regression detection works (10% threshold, fails workflow)
5. ✅ PR comments show benchmark comparison
6. ✅ Documentation complete (README + CONTRIBUTING)
7. ✅ Versioned baseline script exists (`benchmark-release.sh`)
8. ✅ HTML reports generated for local analysis

---

## Timeline Estimate

| Phase | Estimated Time |
|-------|----------------|
| Phase 1: Shared Infrastructure | 2-3 hours |
| Phase 2: New Benchmark Files | 8-10 hours |
| Phase 3: CI Integration | 2-3 hours |
| Phase 4: Baseline Tooling | 1-2 hours |
| Phase 5: Documentation | 2-3 hours |
| Phase 6: Validation | 1-2 hours |
| **Total** | **16-23 hours** |

**Rounded estimate:** 2-3 working days (including review cycles).

---

## Next Steps

1. **Kent Beck:** Write meta-tests that verify benchmarks run without errors
2. **Rob Pike:** Implement benchmark files following this spec
3. **Kevlin Henney:** Review code quality, naming, structure
4. **Steve Jobs:** Verify alignment with vision (performance = core feature)
5. **Вадим:** Final approval before merge

---

## Open Questions

1. **Should we benchmark `get_node_identifier` separately or combine with `get_node`?**
   - **Answer:** Separate. Identifier construction has string formatting overhead (different perf characteristics).

2. **Should wildcard benchmarks test real regex complexity or simple prefix match?**
   - **Answer:** Use simple wildcard (`FUNCTION_*`) for now. Real regex benchmarking is separate concern.

3. **Should we benchmark soft-deleted nodes separately (e.g., get_node on deleted node)?**
   - **Answer:** No. Tombstone handling is implementation detail, not user-facing API variance.

4. **Should we add benchmarks for invalid inputs (e.g., get_node with non-existent ID)?**
   - **Answer:** No. Benchmarks measure happy path. Error handling benchmarks are separate (future work if needed).

---

## References

- [Criterion.rs User Guide](https://bheisler.github.io/criterion.rs/book/) — Statistical benchmarking methodology
- [github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark) — CI regression detection
- [GHA Benchmark Noise Analysis](https://labs.quansight.org/blog/2021/08/github-actions-benchmarks) — Expected variance in CI environments

---

**End of Technical Specification**
