//! v1 vs v2 engine performance comparison benchmark.
//!
//! Runs identical workloads against GraphEngine (v1) and GraphEngineV2
//! to quantify performance differences.
//!
//! Both engines are accessed via the GraphStore trait, so this measures
//! real-world performance including the v2 adapter layer overhead.
//!
//! Methodology:
//! - Write benchmarks (add_nodes, flush, delete_*) use `iter_batched`
//!   to separate setup (TempDir/engine creation) from measurement.
//! - BFS/reachability use tree topology (ternary tree) for predictable depth.
//! - Point lookups cycle through first 100 nodes to avoid cache bias.
//! - All benchmarks standardize on 3x edge ratio (edges = nodes * 3).
//! - v2 queries run against flushed engines (on-disk segments).
//!
//! Run: cargo bench --bench v1_v2_comparison
//! Report: ./scripts/bench-v1-v2-report.sh

use std::collections::HashMap;
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId, BatchSize};
use rfdb::graph::{GraphEngineV2, reachability};
use rfdb::storage_v2::types::NodeRecordV2;
use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord, AttrQuery};
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_nodes(count: usize) -> Vec<NodeRecord> {
    (0..count)
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

/// Ternary tree edges: parent i has children 3i+1, 3i+2, 3i+3.
/// Produces a tree with predictable depth for BFS/reachability benchmarks.
fn make_tree_edges(node_count: usize) -> Vec<EdgeRecord> {
    let mut edges = Vec::new();
    for i in 0..node_count {
        for child_offset in 1..=3 {
            let child = 3 * i + child_offset;
            if child < node_count {
                edges.push(EdgeRecord {
                    src: i as u128,
                    dst: child as u128,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                });
            }
        }
    }
    edges
}

/// Create multi-type nodes for wildcard benchmarks.
/// Types: "http:request", "http:response", "http:middleware", "db:query", "db:connection"
fn make_multi_type_nodes(count: usize) -> Vec<NodeRecord> {
    let types = [
        "http:request", "http:response", "http:middleware",
        "db:query", "db:connection",
    ];
    (0..count)
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
        .collect()
}

fn make_v2_nodes(count: usize) -> Vec<NodeRecordV2> {
    (0..count)
        .map(|i| {
            let sem_id = format!("FUNCTION:func_{}@src/file_{}.js", i, i % 100);
            let hash = blake3::hash(sem_id.as_bytes());
            let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
            NodeRecordV2 {
                semantic_id: sem_id,
                id,
                node_type: "FUNCTION".to_string(),
                name: format!("func_{}", i),
                file: format!("src/file_{}.js", i % 100),
                content_hash: 0,
                metadata: String::new(),
            }
        })
        .collect()
}

/// Create v1 graph with linear edges (src=i, dst=i+1 mod n).
fn create_v1_graph(node_count: usize, edge_count: usize) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();
    engine.add_nodes(make_nodes(node_count));
    engine.add_edges(make_edges(edge_count, node_count), false);
    (dir, engine)
}

/// Create v2 graph with linear edges. Flushes to disk before returning
/// so queries benchmark on-disk segments, not just in-memory delta.
fn create_v2_graph(node_count: usize, edge_count: usize) -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();
    engine.add_nodes(make_nodes(node_count));
    engine.add_edges(make_edges(edge_count, node_count), false);
    engine.flush().unwrap();
    (dir, engine)
}

/// Create v1 graph with ternary tree edges for BFS/reachability.
fn create_v1_tree(node_count: usize) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();
    engine.add_nodes(make_nodes(node_count));
    engine.add_edges(make_tree_edges(node_count), false);
    (dir, engine)
}

/// Create v2 graph with ternary tree edges for BFS/reachability.
/// Flushes to disk before returning.
fn create_v2_tree(node_count: usize) -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();
    engine.add_nodes(make_nodes(node_count));
    engine.add_edges(make_tree_edges(node_count), false);
    engine.flush().unwrap();
    (dir, engine)
}

/// Create v1 graph with multi-type nodes for wildcard benchmarks.
fn create_v1_multi_type(node_count: usize, edge_count: usize) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();
    engine.add_nodes(make_multi_type_nodes(node_count));
    engine.add_edges(make_edges(edge_count, node_count), false);
    (dir, engine)
}

/// Create v2 graph with multi-type nodes for wildcard benchmarks.
/// Flushes to disk before returning.
fn create_v2_multi_type(node_count: usize, edge_count: usize) -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();
    engine.add_nodes(make_multi_type_nodes(node_count));
    engine.add_edges(make_edges(edge_count, node_count), false);
    engine.flush().unwrap();
    (dir, engine)
}

// ---------------------------------------------------------------------------
// Benchmarks: add_nodes (iter_batched, up to 1M)
// ---------------------------------------------------------------------------

fn bench_add_nodes(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/add_nodes");
    for size in [1000, 10000, 100000, 1000000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let engine = GraphEngine::create(dir.path()).unwrap();
                    let nodes = make_nodes(size);
                    (dir, engine, nodes)
                },
                |(_dir, mut engine, nodes)| {
                    engine.add_nodes(black_box(nodes));
                },
                BatchSize::PerIteration,
            );
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/add_nodes");
    for size in [1000, 10000, 100000, 1000000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let engine = GraphEngineV2::create(dir.path()).unwrap();
                    let nodes = make_nodes(size);
                    (dir, engine, nodes)
                },
                |(_dir, mut engine, nodes)| {
                    engine.add_nodes(black_box(nodes));
                },
                BatchSize::PerIteration,
            );
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: flush (iter_batched)
// ---------------------------------------------------------------------------

fn bench_flush(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/flush");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let mut engine = GraphEngine::create(dir.path()).unwrap();
                    engine.add_nodes(make_nodes(size));
                    engine.add_edges(make_edges(size * 3, size), false);
                    (dir, engine)
                },
                |(_dir, mut engine)| {
                    black_box(engine.flush().unwrap());
                },
                BatchSize::PerIteration,
            );
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/flush");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let mut engine = GraphEngineV2::create(dir.path()).unwrap();
                    engine.add_nodes(make_nodes(size));
                    engine.add_edges(make_edges(size * 3, size), false);
                    (dir, engine)
                },
                |(_dir, mut engine)| {
                    black_box(engine.flush().unwrap());
                },
                BatchSize::PerIteration,
            );
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: get_node (cyclic point lookup through first 100 nodes)
// ---------------------------------------------------------------------------

fn bench_get_node(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/get_node");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.get_node(black_box(idx)));
                idx = (idx + 1) % 100;
            });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/get_node");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.get_node(black_box(idx)));
                idx = (idx + 1) % 100;
            });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: find_by_type (exact match)
// ---------------------------------------------------------------------------

fn bench_find_by_type(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/find_by_type");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.find_by_type(black_box("FUNCTION"))); });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/find_by_type");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.find_by_type(black_box("FUNCTION"))); });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: find_by_type (wildcard "http:*") — multi-type graph
// ---------------------------------------------------------------------------

fn bench_find_by_type_wildcard(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/find_by_type_wildcard");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_multi_type(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.find_by_type(black_box("http:*"))); });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/find_by_type_wildcard");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_multi_type(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.find_by_type(black_box("http:*"))); });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: find_by_type (narrow result — exact match on multi-type graph, ~20% hit rate)
// ---------------------------------------------------------------------------

fn bench_find_by_type_narrow(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/find_by_type_narrow");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_multi_type(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.find_by_type(black_box("db:connection"))); });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/find_by_type_narrow");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_multi_type(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.find_by_type(black_box("db:connection"))); });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: find_by_attr
// ---------------------------------------------------------------------------

fn bench_find_by_attr(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/find_by_attr");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 3);
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

    let mut group = c.benchmark_group("v2/find_by_attr");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 3);
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

// ---------------------------------------------------------------------------
// Benchmarks: bfs (tree topology, depth 10)
// ---------------------------------------------------------------------------

fn bench_bfs(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/bfs");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_tree(size);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.bfs(black_box(&[0]), 10, &["CALLS"])); });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/bfs");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_tree(size);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.bfs(black_box(&[0]), 10, &["CALLS"])); });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: neighbors (cycle through first 100 nodes)
// ---------------------------------------------------------------------------

fn bench_neighbors(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/neighbors");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.neighbors(black_box(idx), &["CALLS"]));
                idx = (idx + 1) % 100;
            });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/neighbors");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.neighbors(black_box(idx), &["CALLS"]));
                idx = (idx + 1) % 100;
            });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: get_outgoing_edges (cycle through first 100 nodes)
// ---------------------------------------------------------------------------

fn bench_get_outgoing_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/get_outgoing_edges");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.get_outgoing_edges(black_box(idx), None));
                idx = (idx + 1) % 100;
            });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/get_outgoing_edges");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.get_outgoing_edges(black_box(idx), None));
                idx = (idx + 1) % 100;
            });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: get_incoming_edges (cycle through first 100 nodes)
// ---------------------------------------------------------------------------

fn bench_get_incoming_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/get_incoming_edges");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.get_incoming_edges(black_box(idx), None));
                idx = (idx + 1) % 100;
            });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/get_incoming_edges");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.get_incoming_edges(black_box(idx), None));
                idx = (idx + 1) % 100;
            });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: reachability forward (tree topology)
// ---------------------------------------------------------------------------

fn bench_reachability_forward(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/reachability_forward");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_tree(size);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(reachability(&engine, black_box(&[0]), 10, &["CALLS"], false));
            });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/reachability_forward");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_tree(size);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(reachability(&engine, black_box(&[0]), 10, &["CALLS"], false));
            });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: reachability backward (tree topology)
// ---------------------------------------------------------------------------

fn bench_reachability_backward(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/reachability_backward");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_tree(size);
        // Start from a leaf node (last node in the tree)
        let start_node = (size - 1) as u128;
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(reachability(&engine, black_box(&[start_node]), 10, &["CALLS"], true));
            });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/reachability_backward");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_tree(size);
        let start_node = (size - 1) as u128;
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                black_box(reachability(&engine, black_box(&[start_node]), 10, &["CALLS"], true));
            });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: delete_node (iter_batched)
// ---------------------------------------------------------------------------

fn bench_delete_node(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/delete_node");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || create_v1_graph(size, size * 3),
                |(_dir, mut engine)| {
                    engine.delete_node(black_box(0));
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/delete_node");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || create_v2_graph(size, size * 3),
                |(_dir, mut engine)| {
                    engine.delete_node(black_box(0));
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: delete_edge (iter_batched)
// ---------------------------------------------------------------------------

fn bench_delete_edge(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/delete_edge");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || create_v1_graph(size, size * 3),
                |(_dir, mut engine)| {
                    engine.delete_edge(black_box(0), black_box(1), "CALLS");
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/delete_edge");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || create_v2_graph(size, size * 3),
                |(_dir, mut engine)| {
                    engine.delete_edge(black_box(0), black_box(1), "CALLS");
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: commit_batch (v2 atomic commit vs v1 add_nodes+flush baseline)
// ---------------------------------------------------------------------------

fn bench_commit_batch(c: &mut Criterion) {
    // v1 baseline: add_nodes + add_edges + flush (v1 has no commit_batch)
    let mut group = c.benchmark_group("v1/commit_batch");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let engine = GraphEngine::create(dir.path()).unwrap();
                    let nodes = make_nodes(size);
                    let edges = make_edges(size * 3, size);
                    (dir, engine, nodes, edges)
                },
                |(_dir, mut engine, nodes, edges)| {
                    engine.add_nodes(nodes);
                    engine.add_edges(edges, false);
                    black_box(engine.flush().unwrap());
                },
                BatchSize::PerIteration,
            );
        });
    }
    group.finish();

    // v2: commit_batch (atomic commit with file-level semantics)
    let mut group = c.benchmark_group("v2/commit_batch");
    for size in [1000, 10000, 100000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            let v2_nodes = make_v2_nodes(size);
            let files: Vec<String> = (0..100.min(size))
                .map(|i| format!("src/file_{}.js", i))
                .collect();
            b.iter_batched(
                || {
                    let dir = TempDir::new().unwrap();
                    let engine = GraphEngineV2::create(dir.path()).unwrap();
                    (dir, engine, v2_nodes.clone(), files.clone())
                },
                |(_dir, mut engine, nodes, files)| {
                    black_box(
                        engine.commit_batch(
                            nodes,
                            vec![],
                            &files,
                            HashMap::new(),
                        ).unwrap()
                    );
                },
                BatchSize::PerIteration,
            );
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

criterion_group!(
    v1_v2_comparison,
    bench_add_nodes,
    bench_flush,
    bench_get_node,
    bench_find_by_type,
    bench_find_by_type_wildcard,
    bench_find_by_type_narrow,
    bench_find_by_attr,
    bench_bfs,
    bench_neighbors,
    bench_get_outgoing_edges,
    bench_get_incoming_edges,
    bench_reachability_forward,
    bench_reachability_backward,
    bench_delete_node,
    bench_delete_edge,
    bench_commit_batch,
);
criterion_main!(v1_v2_comparison);

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::{make_tree_edges, create_v1_tree};
    #[allow(unused_imports)]
    use rfdb::GraphStore;

    #[test]
    fn test_make_tree_edges_produces_tree() {
        let edges = make_tree_edges(100);

        // Node 0 should have 3 children: 1, 2, 3
        let children_of_0: Vec<u128> = edges.iter()
            .filter(|e| e.src == 0)
            .map(|e| e.dst)
            .collect();
        assert_eq!(children_of_0, vec![1, 2, 3], "root should have children 1, 2, 3");

        // Node 1 should have 3 children: 4, 5, 6
        let children_of_1: Vec<u128> = edges.iter()
            .filter(|e| e.src == 1)
            .map(|e| e.dst)
            .collect();
        assert_eq!(children_of_1, vec![4, 5, 6], "node 1 should have children 4, 5, 6");

        // Every node except root should appear exactly once as a dst (tree property)
        let mut dst_counts = std::collections::HashMap::new();
        for e in &edges {
            *dst_counts.entry(e.dst).or_insert(0usize) += 1;
        }
        for (&dst, &count) in &dst_counts {
            assert_eq!(count, 1, "node {} appears as dst {} times, expected 1", dst, count);
        }

        // Root (0) should never appear as dst
        assert!(!dst_counts.contains_key(&0), "root should not be a child of any node");

        // All dst nodes should be < 100
        for e in &edges {
            assert!(e.dst < 100, "child {} exceeds node_count", e.dst);
        }
    }

    #[test]
    fn test_bfs_visits_increase_with_size() {
        // BFS on a 1000-node tree should visit more nodes than on a 100-node tree
        let (_dir_small, engine_small) = create_v1_tree(100);
        let visited_small = engine_small.bfs(&[0], 10, &["CALLS"]);

        let (_dir_large, engine_large) = create_v1_tree(1000);
        let visited_large = engine_large.bfs(&[0], 10, &["CALLS"]);

        assert!(
            visited_large.len() > visited_small.len(),
            "BFS on 1K tree ({} nodes) should visit more than 100-node tree ({} nodes)",
            visited_large.len(),
            visited_small.len(),
        );
    }
}
