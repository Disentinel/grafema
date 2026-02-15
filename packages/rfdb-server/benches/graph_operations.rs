//! Benchmark suite for RFDB graph operations
//!
//! Covers core GraphStore trait operations:
//! - Node: add_nodes, get_node, find_by_type (exact + wildcard), find_by_attr
//! - Edge: add_edges, get_outgoing_edges, get_incoming_edges, delete_node, delete_edge
//! - Traversal: bfs, neighbors, reachability (forward/backward)
//! - Maintenance: flush, compact
//!
//! Run: cargo bench --bench graph_operations

use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId, BatchSize};
use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord, AttrQuery};
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn create_test_graph(node_count: usize, edge_count: usize) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();

    let nodes: Vec<NodeRecord> = (0..node_count)
        .map(|i| NodeRecord {
            id: i as u128,
            node_type: Some("FUNCTION".to_string()),
            file_id: (i % 100) as u32,
            name_offset: i as u32,
            version: "main".to_string(),
            exported: i % 10 == 0,
            replaces: None,
            deleted: false,
            name: Some(format!("func_{}", i)),
            file: Some(format!("src/file_{}.js", i % 100)),
            metadata: None,
            semantic_id: None,
        })
        .collect();

    engine.add_nodes(nodes);

    let edges: Vec<EdgeRecord> = (0..edge_count)
        .map(|i| EdgeRecord {
            src: (i % node_count) as u128,
            dst: ((i + 1) % node_count) as u128,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        })
        .collect();

    engine.add_edges(edges, false);

    (dir, engine)
}

/// Create graph with multiple node types for wildcard benchmarks.
/// Types: "http:request", "http:response", "http:middleware", "db:query", "db:connection"
fn create_multi_type_graph(node_count: usize) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();

    let types = [
        "http:request", "http:response", "http:middleware",
        "db:query", "db:connection",
    ];

    let nodes: Vec<NodeRecord> = (0..node_count)
        .map(|i| NodeRecord {
            id: i as u128,
            node_type: Some(types[i % types.len()].to_string()),
            file_id: (i % 100) as u32,
            name_offset: i as u32,
            version: "main".to_string(),
            exported: i % 10 == 0,
            replaces: None,
            deleted: false,
            name: Some(format!("item_{}", i)),
            file: Some(format!("src/file_{}.js", i % 100)),
            metadata: None,
            semantic_id: None,
        })
        .collect();

    engine.add_nodes(nodes);

    (dir, engine)
}

fn make_nodes(count: usize) -> Vec<NodeRecord> {
    (0..count)
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
            semantic_id: None,
        })
        .collect()
}

fn make_edges(count: usize, node_count: usize) -> Vec<EdgeRecord> {
    (0..count)
        .map(|i| EdgeRecord {
            src: (i % node_count) as u128,
            dst: ((i + 1) % node_count) as u128,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Existing benchmarks (preserved for baseline continuity)
// ---------------------------------------------------------------------------

fn bench_add_nodes(c: &mut Criterion) {
    let mut group = c.benchmark_group("add_nodes");

    for size in [100, 1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter(|| {
                let dir = TempDir::new().unwrap();
                let mut engine = GraphEngine::create(dir.path()).unwrap();
                engine.add_nodes(black_box(make_nodes(size)));
            });
        });
    }

    group.finish();
}

fn bench_find_by_type(c: &mut Criterion) {
    let mut group = c.benchmark_group("find_by_type");

    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_test_graph(size, size * 2);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(engine.find_by_type(black_box("FUNCTION")));
            });
        });
    }

    group.finish();
}

fn bench_find_by_attr(c: &mut Criterion) {
    let mut group = c.benchmark_group("find_by_attr");

    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_test_graph(size, size * 2);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let query = AttrQuery::new()
                    .version("main")
                    .node_type("FUNCTION")
                    .exported(true);
                black_box(engine.find_by_attr(black_box(&query)));
            });
        });
    }

    group.finish();
}

fn bench_bfs(c: &mut Criterion) {
    let mut group = c.benchmark_group("bfs");

    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_test_graph(size, size * 3);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(engine.bfs(black_box(&[0]), 10, &["CALLS"]));
            });
        });
    }

    group.finish();
}

fn bench_neighbors(c: &mut Criterion) {
    let mut group = c.benchmark_group("neighbors");

    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_test_graph(size, size * 5);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(engine.neighbors(black_box(0), &["CALLS"]));
            });
        });
    }

    group.finish();
}

fn bench_reachability(c: &mut Criterion) {
    let mut group = c.benchmark_group("reachability");

    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_test_graph(size, size * 3);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(engine.reachability(black_box(&[0]), 10, &["CALLS"], false));
            });
        });
    }

    group.finish();
}

fn bench_reachability_backward(c: &mut Criterion) {
    let mut group = c.benchmark_group("reachability_backward");

    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_test_graph(size, size * 3);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(engine.reachability(black_box(&[50]), 10, &["CALLS"], true));
            });
        });
    }

    group.finish();
}

fn bench_flush(c: &mut Criterion) {
    let mut group = c.benchmark_group("flush");

    for size in [1000, 10000, 50000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter(|| {
                let dir = TempDir::new().unwrap();
                let mut engine = GraphEngine::create(dir.path()).unwrap();
                engine.add_nodes(make_nodes(size));
                black_box(engine.flush().unwrap());
            });
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// NEW: Edge insertion (separate codepath from add_nodes — adjacency updates)
// ---------------------------------------------------------------------------

fn bench_add_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("add_edges");

    for size in [100, 1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let mut engine = GraphEngine::create(dir.path()).unwrap();
                    engine.add_nodes(make_nodes(size));
                    let edges = make_edges(size * 2, size);
                    (dir, engine, edges)
                },
                |(_dir, mut engine, edges)| {
                    engine.add_edges(black_box(edges), false);
                },
                BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// NEW: Point lookup by ID (O(1) delta HashMap or segment scan)
// ---------------------------------------------------------------------------

fn bench_get_node(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_node");

    for size in [100, 1000, 10000, 100000] {
        let (_dir, engine) = create_test_graph(size, size * 2);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.get_node(black_box(idx)));
                idx = (idx + 1) % size as u128;
            });
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// NEW: Outgoing edges (adjacency list traversal)
// ---------------------------------------------------------------------------

fn bench_get_outgoing_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_outgoing_edges");

    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_test_graph(size, size * 3);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(engine.get_outgoing_edges(black_box(0), None));
            });
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// NEW: Incoming edges (reverse adjacency — verify not slower than outgoing)
// ---------------------------------------------------------------------------

fn bench_get_incoming_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_incoming_edges");

    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_test_graph(size, size * 3);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                // Node 1 has incoming edges from node 0 (due to edge pattern)
                black_box(engine.get_incoming_edges(black_box(1), None));
            });
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// NEW: Delete node (soft-delete via tombstone)
// ---------------------------------------------------------------------------

fn bench_delete_node(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_node");

    for size in [100, 1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || create_test_graph(size, size * 2),
                |(_dir, mut engine)| {
                    // Delete a single node (measure per-operation cost)
                    engine.delete_node(black_box(0));
                },
                BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// NEW: Delete edge (soft-delete, separate tombstone tracking from nodes)
// ---------------------------------------------------------------------------

fn bench_delete_edge(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_edge");

    for size in [100, 1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || create_test_graph(size, size * 2),
                |(_dir, mut engine)| {
                    // Delete edge 0->1 of type CALLS
                    engine.delete_edge(black_box(0), black_box(1), "CALLS");
                },
                BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// NEW: Compact (currently = flush, but benchmarked separately for when it diverges)
// ---------------------------------------------------------------------------

fn bench_compact(c: &mut Criterion) {
    let mut group = c.benchmark_group("compact");

    for size in [1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let mut engine = GraphEngine::create(dir.path()).unwrap();
                    engine.add_nodes(make_nodes(size));
                    engine.add_edges(make_edges(size * 2, size), false);
                    // Flush once, then add more data to create delta entries
                    engine.flush().unwrap();
                    engine.add_nodes(
                        (size..size + size / 2)
                            .map(|i| NodeRecord {
                                id: i as u128,
                                node_type: Some("CLASS".to_string()),
                                file_id: 1,
                                name_offset: i as u32,
                                version: "main".to_string(),
                                exported: false,
                                replaces: None,
                                deleted: false,
                                name: Some(format!("class_{}", i)),
                                file: Some("src/extra.js".to_string()),
                                metadata: None,
                                semantic_id: None,
                            })
                            .collect(),
                    );
                    (dir, engine)
                },
                |(_dir, mut engine)| {
                    black_box(engine.compact().unwrap());
                },
                BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// NEW: Wildcard type matching (regex overhead vs exact match)
// ---------------------------------------------------------------------------

fn bench_find_by_type_wildcard(c: &mut Criterion) {
    let mut group = c.benchmark_group("find_by_type_wildcard");

    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_multi_type_graph(size);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                // Wildcard: match all "http:" prefixed types
                black_box(engine.find_by_type(black_box("http:*")));
            });
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// Criterion group registration
// ---------------------------------------------------------------------------

criterion_group!(
    benches,
    // Existing (preserved for baseline continuity)
    bench_add_nodes,
    bench_find_by_type,
    bench_find_by_attr,
    bench_bfs,
    bench_neighbors,
    bench_reachability,
    bench_reachability_backward,
    bench_flush,
    // New
    bench_add_edges,
    bench_get_node,
    bench_get_outgoing_edges,
    bench_get_incoming_edges,
    bench_delete_node,
    bench_delete_edge,
    bench_compact,
    bench_find_by_type_wildcard,
);
criterion_main!(benches);
