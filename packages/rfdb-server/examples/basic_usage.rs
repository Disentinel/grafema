//! Basic usage example for RFDB graph engine
//!
//! Run: cargo run --example basic_usage

use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord, AttrQuery, compute_node_id};
use tempfile::TempDir;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== RFDB Graph Engine - Basic Usage ===\n");

    // Create temporary directory for the graph
    let dir = TempDir::new()?;
    let mut engine = GraphEngine::create(dir.path())?;

    println!("1. Creating graph...");

    // Create nodes with string types
    let user_service_id = compute_node_id("CLASS", "UserService", "MODULE:users.js", "src/api/users.js");
    let get_user_id = compute_node_id("FUNCTION", "getUserById", "UserService", "src/api/users.js");
    let db_query_id = compute_node_id("db:query", "SELECT * FROM users", "getUserById", "src/api/users.js");

    let nodes = vec![
        NodeRecord {
            id: user_service_id,
            node_type: Some("CLASS".to_string()),
            file_id: 1,
            name_offset: 0,
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
            id: get_user_id,
            node_type: Some("FUNCTION".to_string()),
            file_id: 1,
            name_offset: 10,
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
            id: db_query_id,
            node_type: Some("db:query".to_string()), // Namespaced type
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
    println!("  Added {} nodes", engine.node_count());

    // Create edges
    let edges = vec![
        EdgeRecord {
            src: user_service_id,
            dst: get_user_id,
            edge_type: Some("CONTAINS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        },
        EdgeRecord {
            src: get_user_id,
            dst: db_query_id,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        },
    ];

    engine.add_edges(edges, false);
    println!("  Added {} edges", engine.edge_count());

    // Queries
    println!("\n2. Running queries...");

    // Find by type
    let functions = engine.find_by_type("FUNCTION");
    println!("  Functions found: {}", functions.len());

    // Find by namespaced type
    let db_queries = engine.find_by_type("db:query");
    println!("  DB queries found: {}", db_queries.len());

    // Find by attributes
    let query = AttrQuery::new()
        .version("main")
        .exported(true);
    let exported = engine.find_by_attr(&query);
    println!("  Exported nodes: {}", exported.len());

    // BFS traversal
    println!("\n3. BFS traversal from UserService...");
    let endpoints = engine.bfs(&[user_service_id], 10, &["CONTAINS", "CALLS"]);
    println!("  Reached {} nodes:", endpoints.len());

    for (i, node_id) in endpoints.iter().enumerate() {
        if let Some(node) = engine.get_node(*node_id) {
            let type_name = node.node_type.as_deref().unwrap_or("UNKNOWN");
            println!("    {}: {} (id: {})", i + 1, type_name, node_id);
        }
    }

    // Check endpoint
    println!("\n4. Endpoint detection...");
    if engine.is_endpoint(db_query_id) {
        println!("  Database query is detected as endpoint");
    }

    // Version-aware operations
    println!("\n5. Version-aware operations...");

    // Create __local version
    let get_user_local = NodeRecord {
        id: compute_node_id("FUNCTION", "getUserById", "UserService:__local", "src/api/users.js"),
        node_type: Some("FUNCTION".to_string()),
        file_id: 1,
        name_offset: 10,
        version: "__local".to_string(),
        exported: true,
        replaces: Some(get_user_id),
        deleted: false,
        name: Some("getUserById".to_string()),
        file: Some("src/api/users.js".to_string()),
        metadata: None,
        semantic_id: None,
    };

    engine.add_nodes(vec![get_user_local]);

    let main_nodes = engine.get_nodes_by_version("main");
    let local_nodes = engine.get_nodes_by_version("__local");

    println!("  Main version nodes: {}", main_nodes.len());
    println!("  Local version nodes: {}", local_nodes.len());

    // Promote local to main
    println!("\n6. Promoting __local to main...");
    engine.promote_local_to_main();

    let main_nodes_after = engine.get_nodes_by_version("main");
    println!("  Main version nodes after promotion: {}", main_nodes_after.len());

    println!("\nDemo complete!");

    Ok(())
}
