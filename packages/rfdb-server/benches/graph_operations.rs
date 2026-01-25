//! Benchmark suite for graph operations

use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord, AttrQuery};
use tempfile::TempDir;

fn create_test_graph(node_count: usize, edge_count: usize) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();

    // Create nodes
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
        })
        .collect();

    engine.add_nodes(nodes);

    // Create edges (random graph)
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

fn bench_add_nodes(c: &mut Criterion) {
    let mut group = c.benchmark_group("add_nodes");

    for size in [100, 1000, 10000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter(|| {
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

                engine.add_nodes(black_box(nodes));
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
                let result = engine.find_by_type(black_box("FUNCTION"));
                black_box(result);
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
                let result = engine.find_by_attr(black_box(&query));
                black_box(result);
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
                let result = engine.bfs(black_box(&[0]), 10, &["CALLS"]);
                black_box(result);
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
                let result = engine.neighbors(black_box(0), &["CALLS"]);
                black_box(result);
            });
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_add_nodes,
    bench_find_by_type,
    bench_find_by_attr,
    bench_bfs,
    bench_neighbors
);
criterion_main!(benches);
