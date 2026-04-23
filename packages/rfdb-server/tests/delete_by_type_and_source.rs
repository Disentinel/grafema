//! Integration tests for DAI-22 Chunk-0:
//! `delete_{edges,nodes}_by_type_and_source` — source-tagged deletion
//! that powers the LAYOUT_POSITION / REGION lifecycle.

use rfdb::deletion::{
    delete_edges_by_type_and_source, delete_nodes_by_type_and_source,
};
use rfdb::graph::GraphEngineV2;
use rfdb::{EdgeRecord, GraphStore, NodeRecord};
use tempfile::TempDir;

fn make_node(id: u128, node_type: &str, name: &str, file: &str, metadata: Option<&str>) -> NodeRecord {
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
        metadata: metadata.map(|s| s.to_string()),
        semantic_id: Some(format!("{}::{}", node_type, name)),
    }
}

fn make_edge(src: u128, dst: u128, edge_type: &str, metadata: Option<&str>) -> EdgeRecord {
    EdgeRecord {
        src,
        dst,
        edge_type: Some(edge_type.to_string()),
        version: "main".to_string(),
        metadata: metadata.map(|s| s.to_string()),
        deleted: false,
    }
}

fn open_engine() -> (TempDir, GraphEngineV2) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.rfdb");
    let engine = GraphEngineV2::create(&db_path).unwrap();
    (dir, engine)
}

#[test]
fn delete_edges_absent_metadata_is_allowed_different_tag_is_collision() {
    let (_dir, mut engine) = open_engine();

    engine.add_nodes(vec![
        make_node(1, "FUNCTION", "a", "src/a.rs", None),
        make_node(2, "FUNCTION", "b", "src/b.rs", None),
        make_node(3, "FUNCTION", "c", "src/c.rs", None),
        make_node(4, "FUNCTION", "d", "src/d.rs", None),
    ]);

    // Three edges: source=A, no metadata, source=B (unrelated future writer).
    engine.add_edges(
        vec![
            make_edge(1, 2, "LAYOUT_POSITION", Some(r#"{"_source":"layout-pack","q":0,"r":0}"#)),
            make_edge(1, 3, "LAYOUT_POSITION", None),
            make_edge(1, 4, "LAYOUT_POSITION", Some(r#"{"_source":"other-writer","q":9,"r":9}"#)),
        ],
        true,
    );
    engine.flush().unwrap();

    let err = delete_edges_by_type_and_source(&mut engine, "LAYOUT_POSITION", "layout-pack")
        .expect_err("collision with other-writer must fail loudly");
    assert!(err.contains("other-writer"), "error must name colliding tag: {}", err);
    assert!(err.contains("collision"), "error must say collision: {}", err);
}

#[test]
fn delete_edges_happy_path_and_leaves_absent_metadata_edges_alone() {
    let (_dir, mut engine) = open_engine();

    engine.add_nodes(vec![
        make_node(1, "FUNCTION", "a", "src/a.rs", None),
        make_node(2, "FUNCTION", "b", "src/b.rs", None),
        make_node(3, "FUNCTION", "c", "src/c.rs", None),
        make_node(4, "FUNCTION", "d", "src/d.rs", None),
    ]);

    engine.add_edges(
        vec![
            make_edge(1, 2, "LAYOUT_POSITION", Some(r#"{"_source":"layout-pack","q":0,"r":0}"#)),
            make_edge(1, 3, "LAYOUT_POSITION", None),
            // Unrelated analyzer edge, different type — must never be touched.
            make_edge(2, 3, "CALLS", None),
        ],
        true,
    );
    engine.flush().unwrap();

    let before = engine.edge_count();
    let out = delete_edges_by_type_and_source(&mut engine, "LAYOUT_POSITION", "layout-pack")
        .expect("no collision — must succeed");
    assert_eq!(out.deleted, 1, "exactly one layout-pack edge deleted");

    let after = engine.edge_count();
    assert_eq!(after, before - 1);

    // LAYOUT_POSITION edge with no metadata survives.
    let remaining = engine.get_edges_by_type("LAYOUT_POSITION");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].src, 1);
    assert_eq!(remaining[0].dst, 3);

    // CALLS edge untouched.
    let calls = engine.get_edges_by_type("CALLS");
    assert_eq!(calls.len(), 1);

    // Idempotent rerun: no edges match, no collision, zero deleted.
    let out2 = delete_edges_by_type_and_source(&mut engine, "LAYOUT_POSITION", "layout-pack")
        .expect("rerun must succeed");
    assert_eq!(out2.deleted, 0);
}

#[test]
fn delete_nodes_happy_path_removes_node_and_outgoing_edges() {
    let (_dir, mut engine) = open_engine();

    // Two REGION nodes: one layout-pack-owned, one with no metadata (unrelated).
    engine.add_nodes(vec![
        make_node(100, "REGION", "pack-region", "<layout>", Some(r#"{"_source":"layout-pack","depth":0}"#)),
        make_node(101, "REGION", "foreign-region", "<layout>", None),
        make_node(200, "FUNCTION", "sym", "src/x.rs", None),
    ]);
    engine.add_edges(
        vec![
            make_edge(100, 200, "CONTAINS", Some(r#"{"_source":"layout-pack"}"#)),
            make_edge(101, 200, "CONTAINS", None),
        ],
        true,
    );
    engine.flush().unwrap();

    let out = delete_nodes_by_type_and_source(&mut engine, "REGION", "layout-pack")
        .expect("no collision — must succeed");
    assert_eq!(out.deleted_nodes, 1);
    assert_eq!(out.deleted_outgoing_edges, 1);

    // Untagged REGION survives.
    let remaining = engine.find_by_type("REGION");
    assert_eq!(remaining, vec![101]);

    // Its outgoing edge also survives.
    let outg = engine.get_outgoing_edges(101, None);
    assert_eq!(outg.len(), 1);

    // FUNCTION target untouched.
    assert!(engine.get_node(200).is_some());
}

#[test]
fn delete_nodes_collision_fails_loudly() {
    let (_dir, mut engine) = open_engine();

    engine.add_nodes(vec![
        make_node(100, "REGION", "r1", "<layout>", Some(r#"{"_source":"layout-pack"}"#)),
        make_node(101, "REGION", "r2", "<layout>", None),
        make_node(102, "REGION", "r3", "<layout>", Some(r#"{"_source":"other-writer"}"#)),
    ]);
    engine.flush().unwrap();

    let err = delete_nodes_by_type_and_source(&mut engine, "REGION", "layout-pack")
        .expect_err("must fail on collision");
    assert!(err.contains("other-writer"), "error must name colliding tag: {}", err);

    // Nothing was deleted.
    let remaining = engine.find_by_type("REGION");
    assert_eq!(remaining.len(), 3);
}
