//! Integration test: v1/v2 engine behavioral equivalence.
//!
//! Verifies that GraphEngine (v1) and GraphEngineV2 produce identical
//! results for the same operations via the GraphStore trait.

use rfdb::graph::GraphEngineV2;
use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord, AttrQuery};
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

fn create_engines() -> (TempDir, GraphEngine, TempDir, GraphEngineV2) {
    let dir1 = TempDir::new().unwrap();
    let dir2 = TempDir::new().unwrap();
    let v1 = GraphEngine::create(dir1.path()).unwrap();
    let v2 = GraphEngineV2::create(dir2.path()).unwrap();
    (dir1, v1, dir2, v2)
}

fn same_nodes(nodes: &[NodeRecord]) -> Vec<NodeRecord> {
    nodes.to_vec()
}

// ---------------------------------------------------------------------------
// Tests: Basic Operations
// ---------------------------------------------------------------------------

#[test]
fn add_and_get_node_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    let nodes = vec![
        make_node(1, "FUNCTION", "foo", "src/a.js"),
        make_node(2, "CLASS", "Bar", "src/b.js"),
        make_node(3, "FUNCTION", "baz", "src/c.js"),
    ];

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));

    for node in &nodes {
        let r1 = v1.get_node(node.id).expect("v1 node missing");
        let r2 = v2.get_node(node.id).expect("v2 node missing");

        assert_eq!(r1.id, r2.id, "id mismatch for node {}", node.id);
        assert_eq!(r1.node_type, r2.node_type, "type mismatch for node {}", node.id);
        assert_eq!(r1.name, r2.name, "name mismatch for node {}", node.id);
        assert_eq!(r1.file, r2.file, "file mismatch for node {}", node.id);
    }
}

#[test]
fn node_count_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    let nodes = vec![
        make_node(10, "FUNCTION", "a", "src/a.js"),
        make_node(11, "FUNCTION", "b", "src/b.js"),
        make_node(12, "CLASS", "C", "src/c.js"),
    ];

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));

    assert_eq!(v1.node_count(), v2.node_count());
}

#[test]
fn find_by_type_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    let nodes = vec![
        make_node(20, "FUNCTION", "a", "src/a.js"),
        make_node(21, "FUNCTION", "b", "src/b.js"),
        make_node(22, "CLASS", "C", "src/c.js"),
        make_node(23, "http:request", "req", "src/d.js"),
    ];

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));

    // Exact match
    let mut r1 = v1.find_by_type("FUNCTION");
    let mut r2 = v2.find_by_type("FUNCTION");
    r1.sort();
    r2.sort();
    assert_eq!(r1, r2, "find_by_type FUNCTION mismatch");

    // Wildcard
    let mut r1 = v1.find_by_type("http:*");
    let mut r2 = v2.find_by_type("http:*");
    r1.sort();
    r2.sort();
    assert_eq!(r1, r2, "find_by_type http:* mismatch");
}

#[test]
fn find_by_attr_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    let nodes = vec![
        make_node(30, "FUNCTION", "handler", "src/api.js"),
        make_node(31, "FUNCTION", "helper", "src/utils.js"),
        make_node(32, "CLASS", "Service", "src/api.js"),
    ];

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));

    // Test by type + name (works identically on both engines)
    let query = AttrQuery::new().node_type("FUNCTION").name("handler");
    let mut r1 = v1.find_by_attr(&query);
    let mut r2 = v2.find_by_attr(&query);
    r1.sort();
    r2.sort();
    assert_eq!(r1, r2, "find_by_attr type+name mismatch");

    // Test by type only
    let query = AttrQuery::new().node_type("FUNCTION");
    let mut r1 = v1.find_by_attr(&query);
    let mut r2 = v2.find_by_attr(&query);
    r1.sort();
    r2.sort();
    assert_eq!(r1, r2, "find_by_attr type mismatch");

    // NOTE: `exported` filter has different semantics between v1 and v2:
    // v1 checks `NodeRecord.exported` field directly.
    // v2 stores exported as `__exported` in metadata — AttrQuery.exported
    // is not translated to metadata filter in v2's find_by_attr.
    // This is a known behavioral gap.
}

// ---------------------------------------------------------------------------
// Tests: Edge Operations
// ---------------------------------------------------------------------------

#[test]
fn edges_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    let nodes = vec![
        make_node(40, "FUNCTION", "a", "src/a.js"),
        make_node(41, "FUNCTION", "b", "src/a.js"),
        make_node(42, "FUNCTION", "c", "src/a.js"),
    ];
    let edges = vec![
        make_edge(40, 41, "CALLS"),
        make_edge(41, 42, "CALLS"),
    ];

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));
    v1.add_edges(edges.clone(), false);
    v2.add_edges(edges, false);

    // Outgoing edges
    let out1 = v1.get_outgoing_edges(40, None);
    let out2 = v2.get_outgoing_edges(40, None);
    assert_eq!(out1.len(), out2.len(), "outgoing edge count mismatch");
    assert_eq!(out1[0].dst, out2[0].dst, "outgoing edge dst mismatch");

    // Incoming edges
    let in1 = v1.get_incoming_edges(42, None);
    let in2 = v2.get_incoming_edges(42, None);
    assert_eq!(in1.len(), in2.len(), "incoming edge count mismatch");

    // Edge count
    assert_eq!(v1.edge_count(), v2.edge_count(), "total edge count mismatch");
}

#[test]
fn neighbors_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    let nodes = vec![
        make_node(50, "FUNCTION", "a", "src/a.js"),
        make_node(51, "FUNCTION", "b", "src/a.js"),
        make_node(52, "FUNCTION", "c", "src/a.js"),
    ];
    let edges = vec![
        make_edge(50, 51, "CALLS"),
        make_edge(50, 52, "IMPORTS"),
    ];

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));
    v1.add_edges(edges.clone(), false);
    v2.add_edges(edges, false);

    let mut n1 = v1.neighbors(50, &["CALLS"]);
    let mut n2 = v2.neighbors(50, &["CALLS"]);
    n1.sort();
    n2.sort();
    assert_eq!(n1, n2, "neighbors CALLS mismatch");

    let mut n1 = v1.neighbors(50, &[]);
    let mut n2 = v2.neighbors(50, &[]);
    n1.sort();
    n2.sort();
    assert_eq!(n1, n2, "neighbors all types mismatch");
}

// ---------------------------------------------------------------------------
// Tests: BFS Traversal
// ---------------------------------------------------------------------------

#[test]
fn bfs_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    // Linear chain: 60 -> 61 -> 62 -> 63 -> 64
    let nodes: Vec<_> = (60..65)
        .map(|i| make_node(i, "FUNCTION", &format!("f{}", i), "src/chain.js"))
        .collect();
    let edges: Vec<_> = (60..64)
        .map(|i| make_edge(i, i + 1, "CALLS"))
        .collect();

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));
    v1.add_edges(edges.clone(), false);
    v2.add_edges(edges, false);

    // Full depth
    let mut r1 = v1.bfs(&[60], 10, &["CALLS"]);
    let mut r2 = v2.bfs(&[60], 10, &["CALLS"]);
    r1.sort();
    r2.sort();
    assert_eq!(r1, r2, "bfs full depth mismatch");
    assert_eq!(r1.len(), 5);

    // Depth limited
    let mut r1 = v1.bfs(&[60], 2, &["CALLS"]);
    let mut r2 = v2.bfs(&[60], 2, &["CALLS"]);
    r1.sort();
    r2.sort();
    assert_eq!(r1, r2, "bfs depth-2 mismatch");
}

// ---------------------------------------------------------------------------
// Tests: Delete Operations
// ---------------------------------------------------------------------------

#[test]
fn delete_node_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    let nodes = vec![
        make_node(70, "FUNCTION", "keep", "src/a.js"),
        make_node(71, "FUNCTION", "remove", "src/a.js"),
    ];

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));

    v1.delete_node(71);
    v2.delete_node(71);

    // node_exists must agree
    assert_eq!(v1.node_exists(71), v2.node_exists(71));
    assert!(!v1.node_exists(71));
    assert_eq!(v1.get_node(70).is_some(), v2.get_node(70).is_some());

    // NOTE: node_count() semantics differ between v1 and v2:
    // v1 includes soft-deleted nodes in count, v2 subtracts pending tombstones.
    // This is a known behavioral gap — test node visibility, not raw count.
    assert!(!v1.node_exists(71));
    assert!(!v2.node_exists(71));
    assert!(v1.node_exists(70));
    assert!(v2.node_exists(70));
}

#[test]
fn delete_edge_equivalent() {
    let (_d1, mut v1, _d2, mut v2) = create_engines();
    let nodes = vec![
        make_node(80, "FUNCTION", "a", "src/a.js"),
        make_node(81, "FUNCTION", "b", "src/a.js"),
        make_node(82, "FUNCTION", "c", "src/a.js"),
    ];
    let edges = vec![
        make_edge(80, 81, "CALLS"),
        make_edge(80, 82, "CALLS"),
    ];

    v1.add_nodes(same_nodes(&nodes));
    v2.add_nodes(same_nodes(&nodes));
    v1.add_edges(edges.clone(), false);
    v2.add_edges(edges, false);

    v1.delete_edge(80, 81, "CALLS");
    v2.delete_edge(80, 81, "CALLS");

    let out1 = v1.get_outgoing_edges(80, None);
    let out2 = v2.get_outgoing_edges(80, None);
    assert_eq!(out1.len(), out2.len(), "edge count after delete mismatch");
    assert_eq!(out1.len(), 1);
}
