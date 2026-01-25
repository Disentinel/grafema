//! Comparative benchmark: RFDB vs Neo4j
//!
//! NOTE: Requires running Neo4j on localhost:7687
//! Run: cargo bench --bench neo4j_comparison

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord};
use tempfile::TempDir;

// Placeholder for Neo4j client (requires neo4j crate)
struct Neo4jClient {
    // uri: String,
}

impl Neo4jClient {
    #[allow(dead_code)]
    fn connect(_uri: &str) -> Self {
        // TODO: real connection
        Self {}
    }

    #[allow(dead_code)]
    fn add_nodes(&mut self, _nodes: &[NodeRecord]) {
        // TODO: real Neo4j write
    }

    #[allow(dead_code)]
    fn find_by_type(&self, _node_type: &str) -> Vec<u128> {
        // TODO: real Cypher query
        Vec::new()
    }

    #[allow(dead_code)]
    fn bfs(&self, _start: &[u128], _depth: usize) -> Vec<u128> {
        // TODO: real Cypher query with variable-length path
        Vec::new()
    }
}

fn bench_rust_vs_neo4j_add_nodes(c: &mut Criterion) {
    let mut group = c.benchmark_group("comparison_add_nodes");

    let nodes: Vec<NodeRecord> = (0..1000)
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

    // RFDB engine
    group.bench_function("rfdb", |b| {
        b.iter(|| {
            let dir = TempDir::new().unwrap();
            let mut engine = GraphEngine::create(dir.path()).unwrap();
            engine.add_nodes(black_box(nodes.clone()));
        });
    });

    // Neo4j (commented out, requires running Neo4j)
    /*
    group.bench_function("neo4j", |b| {
        let mut neo4j = Neo4jClient::connect("bolt://localhost:7687");
        b.iter(|| {
            neo4j.add_nodes(black_box(&nodes));
        });
    });
    */

    group.finish();
}

fn bench_rust_vs_neo4j_find_by_type(c: &mut Criterion) {
    let mut group = c.benchmark_group("comparison_find_by_type");

    // RFDB engine
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();

    let nodes: Vec<NodeRecord> = (0..10000)
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

    group.bench_function("rfdb", |b| {
        b.iter(|| {
            let result = engine.find_by_type(black_box("FUNCTION"));
            black_box(result);
        });
    });

    // Neo4j (commented out)
    /*
    let neo4j = Neo4jClient::connect("bolt://localhost:7687");
    group.bench_function("neo4j", |b| {
        b.iter(|| {
            let result = neo4j.find_by_type(black_box("FUNCTION"));
            black_box(result);
        });
    });
    */

    group.finish();
}

fn bench_rust_vs_neo4j_bfs(c: &mut Criterion) {
    let mut group = c.benchmark_group("comparison_bfs");

    // RFDB engine
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();

    // Create graph: chain 1->2->3->...->100
    let nodes: Vec<NodeRecord> = (0..100)
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

    let edges: Vec<EdgeRecord> = (0..99)
        .map(|i| EdgeRecord {
            src: i as u128,
            dst: (i + 1) as u128,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        })
        .collect();

    engine.add_edges(edges, false);

    group.bench_function("rfdb", |b| {
        b.iter(|| {
            let result = engine.bfs(black_box(&[0]), 10, &["CALLS"]);
            black_box(result);
        });
    });

    // Neo4j (commented out)
    /*
    let neo4j = Neo4jClient::connect("bolt://localhost:7687");
    group.bench_function("neo4j", |b| {
        b.iter(|| {
            let result = neo4j.bfs(black_box(&[0]), 10);
            black_box(result);
        });
    });
    */

    group.finish();
}

criterion_group!(
    benches,
    bench_rust_vs_neo4j_add_nodes,
    bench_rust_vs_neo4j_find_by_type,
    bench_rust_vs_neo4j_bfs
);
criterion_main!(benches);
