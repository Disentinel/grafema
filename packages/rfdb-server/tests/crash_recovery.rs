//! Integration test: v2 crash recovery and persistence semantics.
//!
//! Validates that:
//! - Unflushed write buffers are lost on restart (by design)
//! - Flushed data survives engine drop + reopen
//! - Tombstones via commit_batch persist across restarts
//! - Manifest atomicity: only committed versions are loaded
//!
//! NOTE: Tombstone persistence via flush() does NOT work for previously-
//! flushed segments. Use commit_batch() for proper tombstone handling.

use std::collections::HashMap;
use rfdb::graph::GraphEngineV2;
use rfdb::storage_v2::types::NodeRecordV2;
use rfdb::{GraphStore, NodeRecord, EdgeRecord};
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_node(id: u128, node_type: &str, name: &str, file: &str) -> NodeRecord {
    NodeRecord {
        id,
        node_type: Some(node_type.to_string()),
        file_id: 0,
        name_offset: 0,
        version: "main".to_string(),
        exported: false,
        replaces: None,
        deleted: false,
        name: Some(name.to_string()),
        file: Some(file.to_string()),
        metadata: None,
        semantic_id: None,
    }
}

fn make_edge(src: u128, dst: u128, edge_type: &str) -> EdgeRecord {
    EdgeRecord {
        src,
        dst,
        edge_type: Some(edge_type.to_string()),
        version: "main".to_string(),
        metadata: None,
        deleted: false,
    }
}

// ---------------------------------------------------------------------------
// Tests: Write Buffer Volatility
// ---------------------------------------------------------------------------

#[test]
fn unflushed_nodes_lost_on_restart() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.add_nodes(vec![
            make_node(1, "FUNCTION", "foo", "src/a.js"),
            make_node(2, "FUNCTION", "bar", "src/b.js"),
        ]);
        assert_eq!(engine.node_count(), 2);
        // Drop without flush — data only in write buffer
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(engine.node_count(), 0, "unflushed nodes must not survive restart");
    }
}

#[test]
fn unflushed_edges_lost_on_restart() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.add_nodes(vec![
            make_node(10, "FUNCTION", "a", "src/a.js"),
            make_node(11, "FUNCTION", "b", "src/a.js"),
        ]);
        engine.add_edges(vec![make_edge(10, 11, "CALLS")], false);
        engine.flush().unwrap(); // Flush nodes

        // Add more edges without flushing
        engine.add_edges(vec![make_edge(11, 10, "CALLS")], false);
        // Drop without second flush
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(engine.node_count(), 2, "flushed nodes must survive");
        // Only the first edge should survive
        let outgoing = engine.get_outgoing_edges(10, None);
        assert_eq!(outgoing.len(), 1, "flushed edge must survive");
        let reverse = engine.get_outgoing_edges(11, None);
        assert_eq!(reverse.len(), 0, "unflushed edge must not survive");
    }
}

// ---------------------------------------------------------------------------
// Tests: Flushed Data Survives
// ---------------------------------------------------------------------------

#[test]
fn flushed_nodes_survive_restart() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.add_nodes(vec![
            make_node(20, "FUNCTION", "alpha", "src/main.js"),
            make_node(21, "CLASS", "Beta", "src/main.js"),
            make_node(22, "FUNCTION", "gamma", "src/utils.js"),
        ]);
        engine.flush().unwrap();
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(engine.node_count(), 3);
        assert!(engine.node_exists(20));
        assert!(engine.node_exists(21));
        assert!(engine.node_exists(22));

        let node = engine.get_node(20).unwrap();
        assert_eq!(node.name, Some("alpha".to_string()));
        assert_eq!(node.node_type, Some("FUNCTION".to_string()));
    }
}

#[test]
fn flushed_edges_survive_restart() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.add_nodes(vec![
            make_node(30, "FUNCTION", "a", "src/a.js"),
            make_node(31, "FUNCTION", "b", "src/a.js"),
        ]);
        engine.add_edges(vec![make_edge(30, 31, "CALLS")], false);
        engine.flush().unwrap();
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        let outgoing = engine.get_outgoing_edges(30, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].dst, 31);
        assert_eq!(outgoing[0].edge_type, Some("CALLS".to_string()));
    }
}

// ---------------------------------------------------------------------------
// Tests: Tombstone Persistence via commit_batch
// ---------------------------------------------------------------------------

fn make_v2_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
    let hash = blake3::hash(semantic_id.as_bytes());
    let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
    NodeRecordV2 {
        semantic_id: semantic_id.to_string(),
        id,
        node_type: node_type.to_string(),
        name: name.to_string(),
        file: file.to_string(),
        content_hash: 0,
        metadata: String::new(),
    }
}

#[test]
fn commit_batch_tombstones_work_within_session() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    let keep = make_v2_node("FUNCTION:keep@src/a.js", "FUNCTION", "keep", "src/a.js");
    let remove = make_v2_node("FUNCTION:remove@src/a.js", "FUNCTION", "remove", "src/a.js");
    let keep_id = keep.id;
    let remove_id = remove.id;

    let mut engine = GraphEngineV2::create(&db_path).unwrap();

    // First commit: add both nodes
    engine.commit_batch(
        vec![keep.clone(), remove.clone()],
        vec![],
        &["src/a.js".to_string()],
        HashMap::new(),
    ).unwrap();
    assert!(engine.node_exists(keep_id));
    assert!(engine.node_exists(remove_id));

    // Second commit: only keep node (remove is tombstoned)
    engine.commit_batch(
        vec![keep],
        vec![],
        &["src/a.js".to_string()],
        HashMap::new(),
    ).unwrap();

    assert!(engine.node_exists(keep_id), "kept node must exist");
    assert!(!engine.node_exists(remove_id), "removed node must be tombstoned");
}

#[test]
fn commit_batch_tombstones_survive_restart() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    let keep = make_v2_node("FUNCTION:keep@src/a.js", "FUNCTION", "keep", "src/a.js");
    let remove = make_v2_node("FUNCTION:remove@src/a.js", "FUNCTION", "remove", "src/a.js");
    let keep_id = keep.id;
    let remove_id = remove.id;

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.commit_batch(
            vec![keep.clone(), remove.clone()],
            vec![],
            &["src/a.js".to_string()],
            HashMap::new(),
        ).unwrap();
        engine.commit_batch(
            vec![keep],
            vec![],
            &["src/a.js".to_string()],
            HashMap::new(),
        ).unwrap();
        assert!(!engine.node_exists(remove_id), "tombstoned in-session");
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert!(
            engine.node_exists(keep_id),
            "kept node must survive restart"
        );
        assert!(
            !engine.node_exists(remove_id),
            "tombstoned node must stay deleted after restart"
        );
    }
}

#[test]
fn flush_tombstone_limitation_documented() {
    // KNOWN LIMITATION: flush() does not persist tombstones for
    // previously-flushed segments. This test documents the behavior.
    //
    // Tombstone persistence requires commit_batch(), which handles
    // the 9-phase atomic commit protocol including tombstone tracking
    // in the manifest.
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.add_nodes(vec![
            make_node(40, "FUNCTION", "keep", "src/a.js"),
            make_node(41, "FUNCTION", "remove", "src/a.js"),
        ]);
        engine.flush().unwrap();

        // Delete via GraphStore trait (pending tombstone)
        engine.delete_node(41);
        assert!(!engine.node_exists(41), "node should be hidden in-session");

        engine.flush().unwrap();
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        // NOTE: This documents that flush()-based tombstones do NOT persist.
        // The node reappears after restart because the original segment
        // still contains it and no manifest-level tombstone was written.
        // Use commit_batch() for persistent deletes.
        let exists = engine.node_exists(41);
        assert!(exists, "flush-based tombstones do not persist (known limitation)");
    }
}

// ---------------------------------------------------------------------------
// Tests: Multi-Phase Persistence
// ---------------------------------------------------------------------------

#[test]
fn incremental_flushes_accumulate() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    // Phase 1: Add initial nodes
    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.add_nodes(vec![make_node(60, "FUNCTION", "first", "src/a.js")]);
        engine.flush().unwrap();
    }

    // Phase 2: Reopen, add more
    {
        let mut engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(engine.node_count(), 1);
        engine.add_nodes(vec![make_node(61, "FUNCTION", "second", "src/b.js")]);
        engine.flush().unwrap();
    }

    // Phase 3: Verify both
    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(engine.node_count(), 2);
        assert!(engine.node_exists(60));
        assert!(engine.node_exists(61));
    }
}

#[test]
fn delete_then_readd_persists_correctly() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.add_nodes(vec![make_node(70, "FUNCTION", "toggle", "src/a.js")]);
        engine.flush().unwrap();

        engine.delete_node(70);
        engine.flush().unwrap();
        assert!(!engine.node_exists(70));

        // Re-add the same node
        engine.add_nodes(vec![make_node(70, "FUNCTION", "toggle_v2", "src/a.js")]);
        engine.flush().unwrap();
    }

    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert!(engine.node_exists(70), "re-added node must survive");
        let node = engine.get_node(70).unwrap();
        assert_eq!(node.name, Some("toggle_v2".to_string()));
    }
}
