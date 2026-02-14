//! Example of data migration from Neo4j to RFDB
//!
//! Run: cargo run --example migrate_neo4j -- <neo4j_uri> <output_path>

use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord, compute_node_id};
use std::env;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        eprintln!("Usage: {} <neo4j_uri> <output_path>", args[0]);
        eprintln!("Example: {} bolt://localhost:7687 ./graph.rfdb", args[0]);
        std::process::exit(1);
    }

    let neo4j_uri = &args[1];
    let output_path = &args[2];

    println!("=== Neo4j -> RFDB Migration ===");
    println!("Source: {}", neo4j_uri);
    println!("Target: {}", output_path);
    println!();

    // TODO: Connect to Neo4j
    println!("Step 1/4: Connecting to Neo4j...");
    // let neo4j = connect_neo4j(neo4j_uri)?;
    println!("  Connected");

    // Create new RFDB engine
    println!();
    println!("Step 2/4: Creating RFDB engine...");
    let mut engine = GraphEngine::create(output_path)?;
    println!("  Engine created at {}", output_path);

    // Export nodes
    println!();
    println!("Step 3/4: Migrating nodes...");

    // TODO: Real Neo4j export
    // let cypher = "MATCH (n) RETURN n";
    // let result = neo4j.query(cypher)?;

    // Example: create test nodes with string types
    let test_nodes: Vec<NodeRecord> = vec![
        NodeRecord {
            id: compute_node_id("FUNCTION", "getUserById", "MODULE:users.js", "src/api/users.js"),
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
            id: compute_node_id("CLASS", "UserService", "MODULE:users.js", "src/api/users.js"),
            node_type: Some("CLASS".to_string()),
            file_id: 1,
            name_offset: 20,
            version: "main".to_string(),
            exported: true,
            replaces: None,
            deleted: false,
            name: Some("UserService".to_string()),
            file: Some("src/api/users.js".to_string()),
            metadata: None,
            semantic_id: None,
        },
    ];

    engine.add_nodes(test_nodes);
    println!("  Migrated {} nodes", engine.node_count());

    // Export edges
    println!();
    println!("Step 4/4: Migrating edges...");

    // TODO: Real Neo4j export
    // let cypher = "MATCH ()-[r]->() RETURN r, startNode(r).id as src, endNode(r).id as dst";

    let test_edges: Vec<EdgeRecord> = vec![
        EdgeRecord {
            src: compute_node_id("FUNCTION", "getUserById", "MODULE:users.js", "src/api/users.js"),
            dst: compute_node_id("CLASS", "UserService", "MODULE:users.js", "src/api/users.js"),
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        },
    ];

    engine.add_edges(test_edges, false);
    println!("  Migrated {} edges", engine.edge_count());

    // Flush and compact
    println!();
    println!("Finalizing...");
    engine.flush()?;
    engine.compact()?;

    println!();
    println!("Migration complete!");
    println!("  Nodes: {}", engine.node_count());
    println!("  Edges: {}", engine.edge_count());
    println!("  Location: {}", output_path);

    Ok(())
}

/*
// Real implementation for Neo4j (requires neo4j crate)
fn connect_neo4j(uri: &str) -> Result<Neo4jClient, Box<dyn std::error::Error>> {
    use neo4j::*;

    let graph = Graph::new(uri, "neo4j", "password")?;
    Ok(Neo4jClient { graph })
}

struct Neo4jClient {
    graph: Graph,
}

impl Neo4jClient {
    fn query(&self, cypher: &str) -> Result<Vec<Node>, Box<dyn std::error::Error>> {
        let mut result = self.graph.run(cypher)?;
        let nodes = result.fetch_all()?;
        Ok(nodes)
    }
}
*/
