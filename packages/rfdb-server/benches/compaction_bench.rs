//! Compaction throughput benchmark.
//!
//! Measures L0->L1 compaction performance with varying numbers of L0 segments.
//! Reports segments/sec, records/sec, and tombstone removal efficiency.
//!
//! Run: cargo bench --bench compaction_bench

use criterion::{black_box, criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion};
use rfdb::graph::GraphEngineV2;
use rfdb::{EdgeRecord, GraphStore, NodeRecord};
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_nodes(count: usize, offset: usize) -> Vec<NodeRecord> {
    (0..count)
        .map(|i| {
            let idx = offset + i;
            NodeRecord {
                id: idx as u128,
                node_type: Some("FUNCTION".to_string()),
                file_id: (idx % 100) as u32,
                name_offset: idx as u32,
                version: "main".to_string(),
                exported: idx % 10 == 0,
                replaces: None,
                deleted: false,
                name: Some(format!("func_{}", idx)),
                file: Some(format!("src/file_{}.js", idx % 100)),
                metadata: None,
                semantic_id: None,
            }
        })
        .collect()
}

fn make_edges(count: usize, node_count: usize, offset: usize) -> Vec<EdgeRecord> {
    (0..count)
        .map(|i| EdgeRecord {
            src: ((offset + i) % node_count) as u128,
            dst: ((offset + i + 1) % node_count) as u128,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        })
        .collect()
}

/// Create a graph engine with `segment_count` L0 segments, each containing
/// an equal share of `total_nodes` nodes. Edges (3x node count) are added
/// in the first batch only.
fn create_graph_with_l0_segments(
    total_nodes: usize,
    segment_count: usize,
) -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();

    let nodes_per_segment = total_nodes / segment_count;

    for seg in 0..segment_count {
        let offset = seg * nodes_per_segment;
        let batch_size = if seg == segment_count - 1 {
            // Last segment picks up remainder
            total_nodes - offset
        } else {
            nodes_per_segment
        };

        engine.add_nodes(make_nodes(batch_size, offset));

        // Add edges only in the first batch to avoid duplicates
        if seg == 0 {
            let edge_count = total_nodes * 3;
            engine.add_edges(make_edges(edge_count, total_nodes, 0), false);
        }

        engine.flush().unwrap();
    }

    (dir, engine)
}

/// Create a graph with tombstones for benchmarking tombstone removal.
///
/// 1. Creates `total_nodes` nodes + edges, flushes (L0 segment 1)
/// 2. Deletes `delete_count` nodes (creates tombstones)
/// 3. Flushes again (L0 segment 2 with tombstones)
fn create_graph_with_tombstones(
    total_nodes: usize,
    delete_count: usize,
) -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();

    // First flush: all nodes + edges
    engine.add_nodes(make_nodes(total_nodes, 0));
    engine.add_edges(make_edges(total_nodes * 3, total_nodes, 0), false);
    engine.flush().unwrap();

    // Delete some nodes (creates tombstones)
    for i in 0..delete_count {
        engine.delete_node(i as u128);
    }

    // Second flush: persists tombstones
    engine.flush().unwrap();

    (dir, engine)
}

// ---------------------------------------------------------------------------
// Benchmarks: compaction with varying L0 segment counts
// ---------------------------------------------------------------------------

fn bench_compact_segments(c: &mut Criterion) {
    let mut group = c.benchmark_group("compact");

    for segments in [4, 8, 12] {
        group.bench_with_input(
            BenchmarkId::new("segments", segments),
            &segments,
            |b, &segments| {
                b.iter_batched(
                    || create_graph_with_l0_segments(10_000, segments),
                    |(_dir, mut engine)| black_box(engine.compact_with_stats().unwrap()),
                    BatchSize::LargeInput,
                );
            },
        );
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmark: compaction with tombstones
// ---------------------------------------------------------------------------

fn bench_compact_with_tombstones(c: &mut Criterion) {
    let mut group = c.benchmark_group("compact_tombstones");

    // 10K nodes, delete 2K -> tombstones
    group.bench_function("10k_nodes_2k_deleted", |b| {
        b.iter_batched(
            || create_graph_with_tombstones(10_000, 2_000),
            |(_dir, mut engine)| black_box(engine.compact_with_stats().unwrap()),
            BatchSize::LargeInput,
        );
    });

    // 10K nodes, delete 5K -> heavy tombstones
    group.bench_function("10k_nodes_5k_deleted", |b| {
        b.iter_batched(
            || create_graph_with_tombstones(10_000, 5_000),
            |(_dir, mut engine)| black_box(engine.compact_with_stats().unwrap()),
            BatchSize::LargeInput,
        );
    });

    group.finish();
}

// ---------------------------------------------------------------------------
// Post-benchmark: print compaction stats to stderr
// ---------------------------------------------------------------------------

fn print_compaction_stats(c: &mut Criterion) {
    // Run a single compaction to capture and print stats (not timed by criterion).
    let mut group = c.benchmark_group("compact_stats_capture");
    group.sample_size(10);

    group.bench_function("print_stats", |b| {
        b.iter_batched(
            || create_graph_with_l0_segments(10_000, 8),
            |(_dir, mut engine)| {
                let result = engine.compact_with_stats().unwrap();
                black_box(&result);
                result
            },
            BatchSize::LargeInput,
        );
    });

    group.finish();

    // One extra run outside criterion to print human-readable stats
    let (_dir, mut engine) = create_graph_with_l0_segments(10_000, 8);
    let result = engine.compact_with_stats().unwrap();

    eprintln!();
    eprintln!("=== Compaction Stats (8 L0 segments, 10K nodes) ===");
    eprintln!("Shards compacted: {}", result.shards_compacted.len());
    eprintln!("Nodes merged: {}", result.nodes_merged);
    eprintln!("Edges merged: {}", result.edges_merged);
    eprintln!("Tombstones removed: {}", result.tombstones_removed);
    eprintln!("Duration: {}ms", result.duration_ms);
    if result.duration_ms > 0 {
        let total_records = (result.nodes_merged + result.edges_merged) as f64;
        let seconds = result.duration_ms as f64 / 1000.0;
        eprintln!("Throughput: {:.0} records/sec", total_records / seconds);
    }
    if result.nodes_merged + result.tombstones_removed > 0 {
        eprintln!(
            "Tombstone ratio: {:.2}",
            result.tombstones_removed as f64
                / (result.nodes_merged + result.tombstones_removed) as f64
        );
    }

    // Also print tombstone compaction stats
    let (_dir2, mut engine2) = create_graph_with_tombstones(10_000, 2_000);
    let result2 = engine2.compact_with_stats().unwrap();

    eprintln!();
    eprintln!("=== Compaction Stats (10K nodes, 2K deleted) ===");
    eprintln!("Shards compacted: {}", result2.shards_compacted.len());
    eprintln!("Nodes merged: {}", result2.nodes_merged);
    eprintln!("Edges merged: {}", result2.edges_merged);
    eprintln!("Tombstones removed: {}", result2.tombstones_removed);
    eprintln!("Duration: {}ms", result2.duration_ms);
    if result2.duration_ms > 0 {
        let total_records = (result2.nodes_merged + result2.edges_merged) as f64;
        let seconds = result2.duration_ms as f64 / 1000.0;
        eprintln!("Throughput: {:.0} records/sec", total_records / seconds);
    }
    if result2.nodes_merged + result2.tombstones_removed > 0 {
        eprintln!(
            "Tombstone ratio: {:.2}",
            result2.tombstones_removed as f64
                / (result2.nodes_merged + result2.tombstones_removed) as f64
        );
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

criterion_group!(
    compaction,
    bench_compact_segments,
    bench_compact_with_tombstones,
    print_compaction_stats,
);
criterion_main!(compaction);

// ---------------------------------------------------------------------------
// Validation test
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{create_graph_with_l0_segments, create_graph_with_tombstones};

    #[test]
    fn test_compact_result_non_zero() {
        let (_dir, mut engine) = create_graph_with_l0_segments(1_000, 4);
        let result = engine.compact_with_stats().unwrap();

        assert!(
            result.nodes_merged > 0,
            "Expected nodes_merged > 0, got {}",
            result.nodes_merged
        );
        assert!(
            !result.shards_compacted.is_empty(),
            "Expected at least one shard compacted"
        );
    }

    #[test]
    fn test_compact_tombstones_removed() {
        let (_dir, mut engine) = create_graph_with_tombstones(1_000, 200);
        let result = engine.compact_with_stats().unwrap();

        assert!(
            result.nodes_merged > 0,
            "Expected nodes_merged > 0 after tombstone compaction"
        );
        // Tombstones should have been removed during compaction.
        // The exact count depends on shard distribution, but should be > 0.
        assert!(
            result.tombstones_removed > 0,
            "Expected tombstones_removed > 0, got {}",
            result.tombstones_removed
        );
    }
}
