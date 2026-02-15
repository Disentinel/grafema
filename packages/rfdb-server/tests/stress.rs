//! Integration test: stress test with large graphs.
//!
//! Validates correctness under load — not a performance benchmark.
//! Tests that the engine handles 100K nodes + 700K edges without
//! data corruption or panics.

use std::collections::HashMap;
use rfdb::graph::GraphEngineV2;
use rfdb::storage_v2::types::NodeRecordV2;
use rfdb::{GraphStore, NodeRecord, EdgeRecord};
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_nodes(count: usize) -> Vec<NodeRecord> {
    (0..count)
        .map(|i| NodeRecord {
            id: i as u128,
            node_type: Some(format!("TYPE_{}", i % 5)),
            file_id: (i % 200) as u32,
            name_offset: i as u32,
            version: "main".to_string(),
            exported: i % 10 == 0,
            replaces: None,
            deleted: false,
            name: Some(format!("node_{}", i)),
            file: Some(format!("src/file_{}.js", i % 200)),
            metadata: None,
            semantic_id: None,
        })
        .collect()
}

fn make_edges(count: usize, node_count: usize) -> Vec<EdgeRecord> {
    (0..count)
        .map(|i| EdgeRecord {
            src: (i % node_count) as u128,
            dst: ((i * 7 + 13) % node_count) as u128,
            edge_type: Some(format!("EDGE_{}", i % 3)),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn stress_100k_nodes_700k_edges() {
    let dir = TempDir::new().unwrap();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();

    let node_count = 100_000;
    let edge_count = 700_000;

    // Add in batches to avoid excessive memory
    let batch_size = 10_000;
    for start in (0..node_count).step_by(batch_size) {
        let end = (start + batch_size).min(node_count);
        let nodes: Vec<NodeRecord> = (start..end)
            .map(|i| NodeRecord {
                id: i as u128,
                node_type: Some(format!("TYPE_{}", i % 5)),
                file_id: (i % 200) as u32,
                name_offset: i as u32,
                version: "main".to_string(),
                exported: i % 10 == 0,
                replaces: None,
                deleted: false,
                name: Some(format!("node_{}", i)),
                file: Some(format!("src/file_{}.js", i % 200)),
                metadata: None,
                semantic_id: None,
            })
            .collect();
        engine.add_nodes(nodes);
    }

    assert_eq!(engine.node_count(), node_count);

    // Add edges in batches
    let edge_batch = 50_000;
    for start in (0..edge_count).step_by(edge_batch) {
        let end = (start + edge_batch).min(edge_count);
        let edges: Vec<EdgeRecord> = (start..end)
            .map(|i| EdgeRecord {
                src: (i % node_count) as u128,
                dst: ((i * 7 + 13) % node_count) as u128,
                edge_type: Some(format!("EDGE_{}", i % 3)),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            })
            .collect();
        engine.add_edges(edges, true);
    }

    // Verify node queries work at scale
    let type_0 = engine.find_by_type("TYPE_0");
    assert_eq!(type_0.len(), node_count / 5, "TYPE_0 should have 1/5 of nodes");

    let type_4 = engine.find_by_type("TYPE_4");
    assert_eq!(type_4.len(), node_count / 5, "TYPE_4 should have 1/5 of nodes");

    // Verify point lookup works
    let node = engine.get_node(42).expect("node 42 must exist");
    assert_eq!(node.name, Some("node_42".to_string()));

    // Verify BFS doesn't panic on large graph
    let bfs_result = engine.bfs(&[0], 3, &["EDGE_0"]);
    assert!(!bfs_result.is_empty(), "BFS should find reachable nodes");

    // Verify neighbors work
    let neighbors = engine.neighbors(0, &[]);
    assert!(!neighbors.is_empty(), "node 0 should have neighbors");
}

#[test]
fn stress_flush_and_reload_100k() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("stress.rfdb");
    let node_count = 100_000;

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.add_nodes(make_nodes(node_count));
        engine.add_edges(make_edges(node_count * 3, node_count), true);
        engine.flush().unwrap();
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(engine.node_count(), node_count, "all nodes must survive flush+reload");

        // Spot-check a few nodes
        for i in [0, 999, 50_000, 99_999] {
            let node = engine.get_node(i as u128).unwrap_or_else(|| {
                panic!("node {} must exist after reload", i)
            });
            assert_eq!(node.name, Some(format!("node_{}", i)));
        }
    }
}

#[test]
fn stress_large_batch_commit() {
    let mut engine = GraphEngineV2::create_ephemeral();
    let node_count = 50_000;

    // Single large batch via GraphStore trait
    engine.add_nodes(make_nodes(node_count));
    engine.add_edges(make_edges(node_count * 5, node_count), true);

    assert_eq!(engine.node_count(), node_count);

    // Delete 10% of nodes
    for i in (0..node_count).step_by(10) {
        engine.delete_node(i as u128);
    }

    let remaining = engine.node_count();
    let expected = node_count - (node_count / 10);
    assert_eq!(remaining, expected, "90% of nodes should remain");
}

#[test]
fn stress_commit_batch_tombstones_survive_restart() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("tombstone-stress.rfdb");
    let total = 10_000;
    let tombstone_count = 1_000;

    // Build v2 nodes with deterministic semantic IDs
    let all_nodes: Vec<NodeRecordV2> = (0..total)
        .map(|i| {
            let sem_id = format!("FUNCTION:fn_{}@src/file_{}.js", i, i % 100);
            let hash = blake3::hash(sem_id.as_bytes());
            let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
            NodeRecordV2 {
                semantic_id: sem_id,
                id,
                node_type: "FUNCTION".to_string(),
                name: format!("fn_{}", i),
                file: format!("src/file_{}.js", i % 100),
                content_hash: 0,
                metadata: String::new(),
            }
        })
        .collect();

    // Collect IDs for nodes that will be tombstoned
    let tombstoned_ids: Vec<u128> = all_nodes[..tombstone_count].iter().map(|n| n.id).collect();
    let kept_ids: Vec<u128> = all_nodes[tombstone_count..].iter().map(|n| n.id).collect();

    // Gather all files for commit_batch
    let files: Vec<String> = (0..100).map(|i| format!("src/file_{}.js", i)).collect();

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();

        // First commit: all nodes
        engine.commit_batch(
            all_nodes.clone(),
            vec![],
            &files,
            HashMap::new(),
        ).unwrap();

        // Verify all nodes exist
        for &id in &tombstoned_ids[..5] {
            assert!(engine.node_exists(id), "initial: node {} must exist", id);
        }

        // Second commit: only kept nodes (first 1000 become tombstones)
        engine.commit_batch(
            all_nodes[tombstone_count..].to_vec(),
            vec![],
            &files,
            HashMap::new(),
        ).unwrap();

        // Verify tombstoned nodes are gone in-session
        for &id in &tombstoned_ids[..10] {
            assert!(!engine.node_exists(id), "in-session: tombstoned node {} must not exist", id);
        }
        // Verify kept nodes still exist in-session
        for &id in &kept_ids[..10] {
            assert!(engine.node_exists(id), "in-session: kept node {} must exist", id);
        }
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();

        // Verify tombstoned nodes stay deleted after restart
        for &id in &tombstoned_ids[..10] {
            assert!(!engine.node_exists(id), "after restart: tombstoned node {} must not exist", id);
        }

        // Verify kept nodes survive restart
        for &id in &kept_ids[..10] {
            assert!(engine.node_exists(id), "after restart: kept node {} must exist", id);
        }
    }
}
