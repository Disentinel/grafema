//! v1 vs v2 engine performance comparison benchmark.
//!
//! Runs identical workloads against GraphEngine (v1) and GraphEngineV2
//! to quantify performance differences.
//!
//! Both engines are accessed via the GraphStore trait, so this measures
//! real-world performance including the v2 adapter layer overhead.
//!
//! Run: cargo bench --bench v1_v2_comparison
//! Report: ./scripts/bench-v1-v2-report.sh

use std::collections::HashMap;
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use rfdb::graph::GraphEngineV2;
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

fn create_v1_graph(node_count: usize, edge_count: usize) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();
    engine.add_nodes(make_nodes(node_count));
    engine.add_edges(make_edges(edge_count, node_count), false);
    (dir, engine)
}

fn create_v2_graph(node_count: usize, edge_count: usize) -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();
    engine.add_nodes(make_nodes(node_count));
    engine.add_edges(make_edges(edge_count, node_count), false);
    (dir, engine)
}

// ---------------------------------------------------------------------------
// Benchmarks: add_nodes
// ---------------------------------------------------------------------------

fn bench_add_nodes(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/add_nodes");
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

    let mut group = c.benchmark_group("v2/add_nodes");
    for size in [100, 1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter(|| {
                let dir = TempDir::new().unwrap();
                let mut engine = GraphEngineV2::create(dir.path()).unwrap();
                engine.add_nodes(black_box(make_nodes(size)));
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
        let (_dir, engine) = create_v1_graph(size, size * 2);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.find_by_type(black_box("FUNCTION"))); });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/find_by_type");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 2);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.find_by_type(black_box("FUNCTION"))); });
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
        let (_dir, engine) = create_v1_graph(size, size * 2);
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
        let (_dir, engine) = create_v2_graph(size, size * 2);
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
// Benchmarks: get_node (point lookup)
// ---------------------------------------------------------------------------

fn bench_get_node(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/get_node");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 2);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            let mut idx: u128 = 0;
            b.iter(|| {
                black_box(engine.get_node(black_box(idx)));
                idx = (idx + 1) % size as u128;
            });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/get_node");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 2);
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
// Benchmarks: bfs traversal
// ---------------------------------------------------------------------------

fn bench_bfs(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/bfs");
    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_v1_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.bfs(black_box(&[0]), 10, &["CALLS"])); });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/bfs");
    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_v2_graph(size, size * 3);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.bfs(black_box(&[0]), 10, &["CALLS"])); });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: neighbors
// ---------------------------------------------------------------------------

fn bench_neighbors(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/neighbors");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v1_graph(size, size * 5);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.neighbors(black_box(0), &["CALLS"])); });
        });
    }
    group.finish();

    let mut group = c.benchmark_group("v2/neighbors");
    for size in [1000, 10000, 100000] {
        let (_dir, engine) = create_v2_graph(size, size * 5);
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| { black_box(engine.neighbors(black_box(0), &["CALLS"])); });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: flush (write to disk)
// ---------------------------------------------------------------------------

fn bench_flush(c: &mut Criterion) {
    let mut group = c.benchmark_group("v1/flush");
    for size in [1000, 10000] {
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

    let mut group = c.benchmark_group("v2/flush");
    for size in [1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter(|| {
                let dir = TempDir::new().unwrap();
                let mut engine = GraphEngineV2::create(dir.path()).unwrap();
                engine.add_nodes(make_nodes(size));
                black_box(engine.flush().unwrap());
            });
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmarks: commit_batch (v2's atomic commit vs v1's add+flush)
// ---------------------------------------------------------------------------

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

fn bench_commit_batch(c: &mut Criterion) {
    // v1 baseline: add_nodes + flush (v1 has no commit_batch)
    let mut group = c.benchmark_group("v1/commit_batch");
    for size in [1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter(|| {
                let dir = TempDir::new().unwrap();
                let mut engine = GraphEngine::create(dir.path()).unwrap();
                engine.add_nodes(make_nodes(size));
                engine.add_edges(make_edges(size * 2, size), false);
                black_box(engine.flush().unwrap());
            });
        });
    }
    group.finish();

    // v2: commit_batch (atomic commit with file-level semantics)
    let mut group = c.benchmark_group("v2/commit_batch");
    for size in [1000, 10000] {
        let v2_nodes = make_v2_nodes(size);
        let files: Vec<String> = (0..100.min(size))
            .map(|i| format!("src/file_{}.js", i))
            .collect();

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let dir = TempDir::new().unwrap();
                let mut engine = GraphEngineV2::create(dir.path()).unwrap();
                black_box(
                    engine.commit_batch(
                        v2_nodes.clone(),
                        vec![],
                        &files,
                        HashMap::new(),
                    ).unwrap()
                );
            });
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
    bench_find_by_type,
    bench_find_by_attr,
    bench_get_node,
    bench_bfs,
    bench_neighbors,
    bench_flush,
    bench_commit_batch,
);
criterion_main!(v1_v2_comparison);
