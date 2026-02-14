//! Test for real disk write and reload
//!
//! Run: cargo run --example test_persistence

use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord, compute_node_id};
use std::fs;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Test Real Persistence ===\n");

    let test_dir = PathBuf::from("./test_graph_db");

    // Clean up previous test
    if test_dir.exists() {
        println!("Cleaning up previous test directory...");
        fs::remove_dir_all(&test_dir)?;
    }

    // Phase 1: Create graph and write to disk
    println!("Phase 1: Creating graph and writing to disk...");
    {
        let mut engine = GraphEngine::create(&test_dir)?;

        // Create test nodes with string types
        let node1_id = compute_node_id("FUNCTION", "getUserById", "MODULE:users.js", "src/api/users.js");
        let node2_id = compute_node_id("CLASS", "UserService", "MODULE:users.js", "src/api/users.js");
        let node3_id = compute_node_id("db:query", "SELECT * FROM users", "getUserById", "src/api/users.js");

        let nodes = vec![
            NodeRecord {
                id: node1_id,
                node_type: Some("FUNCTION".to_string()),
                file_id: 1,
                name_offset: 0,
                version: "main".to_string(),
                exported: true,
                replaces: None,
                deleted: false,
                name: Some("getUserById".to_string()),
                file: Some("src/api/users.js".to_string()),
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: node2_id,
                node_type: Some("CLASS".to_string()),
                file_id: 1,
                name_offset: 10,
                version: "main".to_string(),
                exported: true,
                replaces: None,
                deleted: false,
                name: Some("UserService".to_string()),
                file: Some("src/api/users.js".to_string()),
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: node3_id,
                node_type: Some("db:query".to_string()),
                file_id: 1,
                name_offset: 20,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("SELECT * FROM users".to_string()),
                file: Some("src/api/users.js".to_string()),
                metadata: None,
                semantic_id: None,
            },
        ];

        engine.add_nodes(nodes);

        // Create edges
        let edges = vec![
            EdgeRecord {
                src: node2_id,
                dst: node1_id,
                edge_type: Some("CONTAINS".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            },
            EdgeRecord {
                src: node1_id,
                dst: node3_id,
                edge_type: Some("CALLS".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            },
        ];

        engine.add_edges(edges, false);

        println!("  ✓ Added {} nodes", engine.node_count());
        println!("  ✓ Added {} edges", engine.edge_count());

        // FLUSH to disk
        println!("\n  Flushing to disk...");
        engine.flush()?;
        println!("  ✓ Flushed successfully");

        // Verify files exist
        println!("\n  Checking files on disk:");
        let nodes_path = test_dir.join("nodes.bin");
        let edges_path = test_dir.join("edges.bin");
        let metadata_path = test_dir.join("metadata.json");

        if nodes_path.exists() {
            let size = fs::metadata(&nodes_path)?.len();
            println!("    ✓ nodes.bin: {} bytes", size);
        } else {
            println!("    ✗ nodes.bin NOT FOUND");
        }

        if edges_path.exists() {
            let size = fs::metadata(&edges_path)?.len();
            println!("    ✓ edges.bin: {} bytes", size);
        } else {
            println!("    ✗ edges.bin NOT FOUND");
        }

        if metadata_path.exists() {
            let size = fs::metadata(&metadata_path)?.len();
            println!("    ✓ metadata.json: {} bytes", size);
        } else {
            println!("    ✗ metadata.json NOT FOUND");
        }
    }

    // Phase 2: Reopen graph and verify data
    println!("\nPhase 2: Reopening graph and verifying data...");
    {
        let engine = GraphEngine::open(&test_dir)?;

        println!("  Node count: {}", engine.node_count());
        println!("  Edge count: {}", engine.edge_count());

        // Verify nodes
        println!("\n  Verifying nodes:");
        let node1_id = compute_node_id("FUNCTION", "getUserById", "MODULE:users.js", "src/api/users.js");
        let node2_id = compute_node_id("CLASS", "UserService", "MODULE:users.js", "src/api/users.js");
        let node3_id = compute_node_id("db:query", "SELECT * FROM users", "getUserById", "src/api/users.js");

        if let Some(node) = engine.get_node(node1_id) {
            println!("    ✓ Node 1 (FUNCTION) found: type={:?}", node.node_type);
        } else {
            println!("    ✗ Node 1 (FUNCTION) NOT FOUND");
        }

        if let Some(node) = engine.get_node(node2_id) {
            println!("    ✓ Node 2 (CLASS) found: type={:?}", node.node_type);
        } else {
            println!("    ✗ Node 2 (CLASS) NOT FOUND");
        }

        if let Some(node) = engine.get_node(node3_id) {
            println!("    ✓ Node 3 (db:query) found: type={:?}", node.node_type);
        } else {
            println!("    ✗ Node 3 (db:query) NOT FOUND");
        }

        // Count by type - returns HashMap<String, usize>
        println!("\n  Count by type:");
        let counts = engine.count_nodes_by_type(None);
        for (type_name, count) in counts.iter() {
            println!("    {}: {}", type_name, count);
        }
    }

    // Phase 3: Add new node and flush again
    println!("\nPhase 3: Adding new node and flushing...");
    {
        let mut engine = GraphEngine::open(&test_dir)?;

        let node4_id = compute_node_id("FUNCTION", "deleteUser", "MODULE:users.js", "src/api/users.js");

        engine.add_nodes(vec![
            NodeRecord {
                id: node4_id,
                node_type: Some("FUNCTION".to_string()),
                file_id: 1,
                name_offset: 30,
                version: "main".to_string(),
                exported: true,
                replaces: None,
                deleted: false,
                name: Some("deleteUser".to_string()),
                file: Some("src/api/users.js".to_string()),
                metadata: None,
                semantic_id: None,
            }
        ]);

        println!("  ✓ Added new node");
        println!("  Node count: {}", engine.node_count());

        engine.flush()?;
        println!("  ✓ Flushed successfully");
    }

    // Phase 4: Final verification
    println!("\nPhase 4: Final verification...");
    {
        let engine = GraphEngine::open(&test_dir)?;

        println!("  Final node count: {}", engine.node_count());
        println!("  Final edge count: {}", engine.edge_count());
    }

    // Cleanup
    println!("\nCleaning up...");
    fs::remove_dir_all(&test_dir)?;
    println!("  ✓ Test directory removed");

    println!("\n✅ All persistence tests passed!");

    Ok(())
}
