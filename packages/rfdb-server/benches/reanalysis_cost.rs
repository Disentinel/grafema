//! Re-analysis cost benchmark.
//!
//! Measures how long it takes to re-analyze a single file when the graph
//! already contains N files.  This is the incremental update scenario:
//! developer edits one file, Grafema re-analyzes only that file and
//! commits the changes via `commit_batch`.
//!
//! Each file contributes 100 nodes.  The benchmark varies the total
//! number of files (10, 100, 1000) and measures the cost of replacing
//! the 100 nodes belonging to file_0.js with updated versions.
//!
//! Run: cargo bench --bench reanalysis_cost

use std::collections::HashMap;
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId, BatchSize};
use rfdb::graph::GraphEngineV2;
use rfdb::{GraphEngine, GraphStore, NodeRecord};
use rfdb::storage_v2::types::NodeRecordV2;
use tempfile::TempDir;

const NODES_PER_FILE: usize = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a v2 node list for a single file.
fn make_v2_file_nodes(file_idx: usize, content_hash: u64) -> Vec<NodeRecordV2> {
    let file = format!("src/file_{}.js", file_idx);
    (0..NODES_PER_FILE)
        .map(|n| {
            let global_idx = file_idx * NODES_PER_FILE + n;
            let sem_id = format!("FUNCTION:func_{}@{}", global_idx, file);
            let hash = blake3::hash(sem_id.as_bytes());
            let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
            NodeRecordV2 {
                semantic_id: sem_id,
                id,
                node_type: "FUNCTION".to_string(),
                name: format!("func_{}", global_idx),
                file: file.clone(),
                content_hash,
                metadata: String::new(),
            }
        })
        .collect()
}

/// Create a v2 graph pre-populated with `file_count` files (100 nodes each).
fn create_pre_built_graph(file_count: usize) -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();

    let all_nodes: Vec<NodeRecordV2> = (0..file_count)
        .flat_map(|f| make_v2_file_nodes(f, 0))
        .collect();

    let all_files: Vec<String> = (0..file_count)
        .map(|f| format!("src/file_{}.js", f))
        .collect();

    engine.commit_batch(
        all_nodes,
        vec![],
        &all_files,
        HashMap::new(),
    ).unwrap();

    engine.flush().unwrap();

    (dir, engine)
}

/// 100 nodes for file_0.js with a changed content_hash (simulating re-analysis).
fn make_changed_nodes() -> Vec<NodeRecordV2> {
    make_v2_file_nodes(0, 999)
}

/// Create v1 nodes for one file.
fn make_v1_file_nodes(file_idx: usize) -> Vec<NodeRecord> {
    let file = format!("src/file_{}.js", file_idx);
    (0..NODES_PER_FILE)
        .map(|n| {
            let global_idx = file_idx * NODES_PER_FILE + n;
            NodeRecord {
                id: global_idx as u128,
                node_type: Some("FUNCTION".to_string()),
                file_id: file_idx as u32,
                name_offset: n as u32,
                version: "main".to_string(),
                exported: n % 10 == 0,
                replaces: None,
                deleted: false,
                name: Some(format!("func_{}", global_idx)),
                file: Some(file.clone()),
                metadata: None,
                semantic_id: None,
            }
        })
        .collect()
}

/// Create a pre-built v1 graph with `file_count` files (100 nodes each).
fn create_pre_built_v1_graph(file_count: usize) -> (TempDir, GraphEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngine::create(dir.path()).unwrap();

    let all_nodes: Vec<NodeRecord> = (0..file_count)
        .flat_map(|f| make_v1_file_nodes(f))
        .collect();

    engine.add_nodes(all_nodes);
    engine.flush().unwrap();

    (dir, engine)
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

fn bench_reanalysis(c: &mut Criterion) {
    let changed_nodes = make_changed_nodes();

    // ── v2: commit_batch re-analysis (file-level atomic replace) ──
    let mut group = c.benchmark_group("v2/reanalysis");
    for file_count in [10, 100, 1000] {
        group.bench_with_input(
            BenchmarkId::from_parameter(file_count),
            &file_count,
            |b, &file_count| {
                let nodes = changed_nodes.clone();
                b.iter_batched(
                    || create_pre_built_graph(file_count),
                    |(_dir, mut engine)| {
                        black_box(
                            engine.commit_batch(
                                nodes.clone(),
                                vec![],
                                &["src/file_0.js".to_string()],
                                HashMap::new(),
                            ).unwrap()
                        )
                    },
                    BatchSize::LargeInput,
                );
            },
        );
    }
    group.finish();

    // ── v1: add_nodes + flush baseline (no file-level semantics) ──
    let mut group = c.benchmark_group("v1/reanalysis");
    for file_count in [10, 100, 1000] {
        group.bench_with_input(
            BenchmarkId::from_parameter(file_count),
            &file_count,
            |b, &file_count| {
                b.iter_batched(
                    || create_pre_built_v1_graph(file_count),
                    |(_dir, mut engine)| {
                        engine.add_nodes(black_box(make_v1_file_nodes(0)));
                        black_box(engine.flush().unwrap());
                    },
                    BatchSize::LargeInput,
                );
            },
        );
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

criterion_group!(reanalysis_cost, bench_reanalysis);
criterion_main!(reanalysis_cost);

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{create_pre_built_graph, NODES_PER_FILE};

    #[test]
    fn test_pre_built_graph_has_correct_node_count() {
        for file_count in [10, 100] {
            let (_dir, engine) = create_pre_built_graph(file_count);
            assert_eq!(
                engine.node_count(),
                file_count * NODES_PER_FILE,
                "graph with {} files should have {} nodes",
                file_count,
                file_count * NODES_PER_FILE,
            );
        }
    }
}
