//! RFDB Server - Unix socket server for GraphEngine
//!
//! Provides a MessagePack-based protocol for graph operations.
//! Multiple clients can connect and share the same graph.
//!
//! Usage:
//!   rfdb-server /path/to/graph.rfdb [--socket /tmp/rfdb.sock]
//!
//! Protocol:
//!   Request:  [4-byte length BE] [MessagePack payload]
//!   Response: [4-byte length BE] [MessagePack payload]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use serde::{Deserialize, Serialize};

// Import from library
use rfdb::graph::{GraphEngine, GraphStore};
use rfdb::storage::{NodeRecord, EdgeRecord, AttrQuery};
use rfdb::datalog::{parse_program, parse_atom, Evaluator};

// ============================================================================
// Wire Protocol Types
// ============================================================================

/// Request from client
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum Request {
    // Write operations
    AddNodes { nodes: Vec<WireNode> },
    AddEdges {
        edges: Vec<WireEdge>,
        #[serde(default, rename = "skipValidation")]
        skip_validation: bool,
    },
    DeleteNode { id: String },
    DeleteEdge {
        src: String,
        dst: String,
        #[serde(rename = "edgeType")]
        edge_type: String,
    },

    // Read operations
    GetNode { id: String },
    NodeExists { id: String },
    FindByType {
        #[serde(rename = "nodeType")]
        node_type: String,
    },
    FindByAttr { query: WireAttrQuery },

    // Graph traversal
    Neighbors {
        id: String,
        #[serde(rename = "edgeTypes")]
        edge_types: Vec<String>,
    },
    Bfs {
        #[serde(rename = "startIds")]
        start_ids: Vec<String>,
        #[serde(rename = "maxDepth")]
        max_depth: u32,
        #[serde(rename = "edgeTypes")]
        edge_types: Vec<String>,
    },
    Reachability {
        #[serde(rename = "startIds")]
        start_ids: Vec<String>,
        #[serde(rename = "maxDepth")]
        max_depth: u32,
        #[serde(rename = "edgeTypes")]
        edge_types: Vec<String>,
        #[serde(default)]
        backward: bool,
    },
    Dfs {
        #[serde(rename = "startIds")]
        start_ids: Vec<String>,
        #[serde(rename = "maxDepth")]
        max_depth: u32,
        #[serde(rename = "edgeTypes")]
        edge_types: Vec<String>,
    },
    GetOutgoingEdges {
        id: String,
        #[serde(rename = "edgeTypes")]
        edge_types: Option<Vec<String>>,
    },
    GetIncomingEdges {
        id: String,
        #[serde(rename = "edgeTypes")]
        edge_types: Option<Vec<String>>,
    },

    // Stats
    NodeCount,
    EdgeCount,
    CountNodesByType { types: Option<Vec<String>> },
    CountEdgesByType {
        #[serde(rename = "edgeTypes")]
        edge_types: Option<Vec<String>>,
    },

    // Control
    Flush,
    Compact,
    Clear,
    Ping,
    Shutdown,

    // Bulk operations
    GetAllEdges,
    QueryNodes { query: WireAttrQuery },

    // Datalog queries
    CheckGuarantee {
        #[serde(rename = "ruleSource")]
        rule_source: String,
    },
    DatalogLoadRules { source: String },
    DatalogClearRules,
    DatalogQuery { query: String },

    // Node utility
    IsEndpoint { id: String },
    GetNodeIdentifier { id: String },
    UpdateNodeVersion { id: String, version: String },
}

/// Response to client
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Ok { ok: bool },
    Error { error: String },
    Node { node: Option<WireNode> },
    Nodes { nodes: Vec<WireNode> },
    Edges { edges: Vec<WireEdge> },
    Ids { ids: Vec<String> },
    Bool { value: bool },
    Count { count: u32 },
    Counts { counts: HashMap<String, usize> },
    Pong { pong: bool, version: String },
    Violations { violations: Vec<WireViolation> },
    Identifier { identifier: Option<String> },
    DatalogResults { results: Vec<WireViolation> },
}

/// Violation from guarantee check
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireViolation {
    pub bindings: HashMap<String, String>,
}

/// Node representation for wire protocol
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireNode {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default)]
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

/// Edge representation for wire protocol
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEdge {
    pub src: String,
    pub dst: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

/// Attribute query for wire protocol
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAttrQuery {
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub file: Option<String>,
    pub exported: Option<bool>,
}

// ============================================================================
// ID Conversion (string <-> u128)
// ============================================================================

fn string_to_id(s: &str) -> u128 {
    // Try parsing as number first
    if let Ok(id) = s.parse::<u128>() {
        return id;
    }
    // Otherwise hash the string
    rfdb::graph::string_id_to_u128(s)
}

fn id_to_string(id: u128) -> String {
    format!("{}", id)
}

// ============================================================================
// Conversion functions
// ============================================================================

fn wire_node_to_record(node: WireNode) -> NodeRecord {
    NodeRecord {
        id: string_to_id(&node.id),
        node_type: node.node_type,
        file_id: 0,
        name_offset: 0,
        version: "main".to_string(),
        exported: node.exported,
        replaces: None,
        deleted: false,
        name: node.name,
        file: node.file,
        metadata: node.metadata,
    }
}

fn record_to_wire_node(record: &NodeRecord) -> WireNode {
    WireNode {
        id: id_to_string(record.id),
        node_type: record.node_type.clone(),
        name: record.name.clone(),
        file: record.file.clone(),
        exported: record.exported,
        metadata: record.metadata.clone(),
    }
}

fn wire_edge_to_record(edge: WireEdge) -> EdgeRecord {
    EdgeRecord {
        src: string_to_id(&edge.src),
        dst: string_to_id(&edge.dst),
        edge_type: edge.edge_type,
        version: "main".to_string(),
        metadata: edge.metadata,
        deleted: false,
    }
}

fn record_to_wire_edge(record: &EdgeRecord) -> WireEdge {
    WireEdge {
        src: id_to_string(record.src),
        dst: id_to_string(record.dst),
        edge_type: record.edge_type.clone(),
        metadata: record.metadata.clone(),
    }
}

// ============================================================================
// Request Handler
// ============================================================================

fn handle_request(engine: &mut GraphEngine, request: Request) -> Response {
    match request {
        // Write operations
        Request::AddNodes { nodes } => {
            let records: Vec<NodeRecord> = nodes.into_iter().map(wire_node_to_record).collect();
            engine.add_nodes(records);
            Response::Ok { ok: true }
        }
        Request::AddEdges { edges, skip_validation } => {
            let records: Vec<EdgeRecord> = edges.into_iter().map(wire_edge_to_record).collect();
            engine.add_edges(records, skip_validation);
            Response::Ok { ok: true }
        }
        Request::DeleteNode { id } => {
            engine.delete_node(string_to_id(&id));
            Response::Ok { ok: true }
        }
        Request::DeleteEdge { src, dst, edge_type } => {
            engine.delete_edge(string_to_id(&src), string_to_id(&dst), &edge_type);
            Response::Ok { ok: true }
        }

        // Read operations
        Request::GetNode { id } => {
            let node = engine.get_node(string_to_id(&id)).map(|r| record_to_wire_node(&r));
            Response::Node { node }
        }
        Request::NodeExists { id } => {
            Response::Bool { value: engine.node_exists(string_to_id(&id)) }
        }
        Request::FindByType { node_type } => {
            let ids: Vec<String> = engine.find_by_type(&node_type)
                .into_iter()
                .map(id_to_string)
                .collect();
            Response::Ids { ids }
        }
        Request::FindByAttr { query } => {
            let attr_query = AttrQuery {
                version: None,
                node_type: query.node_type,
                file_id: None,
                file: query.file,
                exported: query.exported,
                name: query.name,
            };
            let ids: Vec<String> = engine.find_by_attr(&attr_query)
                .into_iter()
                .map(id_to_string)
                .collect();
            Response::Ids { ids }
        }

        // Graph traversal
        Request::Neighbors { id, edge_types } => {
            let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
            let ids: Vec<String> = engine.neighbors(string_to_id(&id), &edge_types_refs)
                .into_iter()
                .map(id_to_string)
                .collect();
            Response::Ids { ids }
        }
        Request::Bfs { start_ids, max_depth, edge_types } => {
            let start: Vec<u128> = start_ids.iter().map(|s| string_to_id(s)).collect();
            let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
            let ids: Vec<String> = engine.bfs(&start, max_depth as usize, &edge_types_refs)
                .into_iter()
                .map(id_to_string)
                .collect();
            Response::Ids { ids }
        }
        Request::Reachability { start_ids, max_depth, edge_types, backward } => {
            let start: Vec<u128> = start_ids.iter().map(|s| string_to_id(s)).collect();
            let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
            let ids: Vec<String> = engine.reachability(&start, max_depth as usize, &edge_types_refs, backward)
                .into_iter()
                .map(id_to_string)
                .collect();
            Response::Ids { ids }
        }
        Request::Dfs { start_ids, max_depth, edge_types } => {
            let start: Vec<u128> = start_ids.iter().map(|s| string_to_id(s)).collect();
            let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
            // DFS using the standalone traversal function
            let ids: Vec<String> = rfdb::graph::traversal::dfs(
                &start,
                max_depth as usize,
                |id| engine.neighbors(id, &edge_types_refs),
            )
                .into_iter()
                .map(id_to_string)
                .collect();
            Response::Ids { ids }
        }
        Request::GetOutgoingEdges { id, edge_types } => {
            let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                .map(|v| v.iter().map(|s| s.as_str()).collect());
            let edges: Vec<WireEdge> = engine.get_outgoing_edges(string_to_id(&id), edge_types_refs.as_deref())
                .into_iter()
                .map(|e| record_to_wire_edge(&e))
                .collect();
            Response::Edges { edges }
        }
        Request::GetIncomingEdges { id, edge_types } => {
            let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                .map(|v| v.iter().map(|s| s.as_str()).collect());
            let edges: Vec<WireEdge> = engine.get_incoming_edges(string_to_id(&id), edge_types_refs.as_deref())
                .into_iter()
                .map(|e| record_to_wire_edge(&e))
                .collect();
            Response::Edges { edges }
        }

        // Stats
        Request::NodeCount => {
            Response::Count { count: engine.node_count() as u32 }
        }
        Request::EdgeCount => {
            Response::Count { count: engine.edge_count() as u32 }
        }
        Request::CountNodesByType { types } => {
            Response::Counts { counts: engine.count_nodes_by_type(types.as_deref()) }
        }
        Request::CountEdgesByType { edge_types } => {
            Response::Counts { counts: engine.count_edges_by_type(edge_types.as_deref()) }
        }

        // Control
        Request::Flush => {
            match engine.flush() {
                Ok(()) => Response::Ok { ok: true },
                Err(e) => Response::Error { error: e.to_string() },
            }
        }
        Request::Compact => {
            match engine.compact() {
                Ok(()) => Response::Ok { ok: true },
                Err(e) => Response::Error { error: e.to_string() },
            }
        }
        Request::Clear => {
            engine.clear();
            Response::Ok { ok: true }
        }
        Request::Ping => {
            Response::Pong { pong: true, version: env!("CARGO_PKG_VERSION").to_string() }
        }
        Request::Shutdown => {
            // This will be handled specially in the main loop
            Response::Ok { ok: true }
        }

        // Bulk operations
        Request::GetAllEdges => {
            let edges: Vec<WireEdge> = engine.get_all_edges()
                .into_iter()
                .map(|e| record_to_wire_edge(&e))
                .collect();
            Response::Edges { edges }
        }
        Request::QueryNodes { query } => {
            let attr_query = AttrQuery {
                version: None,
                node_type: query.node_type,
                file_id: None,
                file: query.file,
                exported: query.exported,
                name: query.name,
            };
            // find_by_attr returns Vec<u128> IDs, we need to get each node
            let ids = engine.find_by_attr(&attr_query);
            let nodes: Vec<WireNode> = ids.into_iter()
                .filter_map(|id| engine.get_node(id))
                .map(|r| record_to_wire_node(&r))
                .collect();
            Response::Nodes { nodes }
        }

        // Datalog queries
        Request::CheckGuarantee { rule_source } => {
            match execute_check_guarantee(engine, &rule_source) {
                Ok(violations) => Response::Violations { violations },
                Err(e) => Response::Error { error: e },
            }
        }
        Request::DatalogLoadRules { source } => {
            match execute_datalog_load_rules(engine, &source) {
                Ok(count) => Response::Count { count },
                Err(e) => Response::Error { error: e },
            }
        }
        Request::DatalogClearRules => {
            // Rules are session-specific, nothing to clear at server level
            Response::Ok { ok: true }
        }
        Request::DatalogQuery { query } => {
            match execute_datalog_query(engine, &query) {
                Ok(results) => Response::DatalogResults { results },
                Err(e) => Response::Error { error: e },
            }
        }

        // Node utility
        Request::IsEndpoint { id } => {
            Response::Bool { value: engine.is_endpoint(string_to_id(&id)) }
        }
        Request::GetNodeIdentifier { id } => {
            let node = engine.get_node(string_to_id(&id));
            let identifier = node.and_then(|n| {
                n.name.clone().or_else(|| Some(format!("{}:{}", n.node_type.as_deref().unwrap_or("UNKNOWN"), id)))
            });
            Response::Identifier { identifier }
        }
        Request::UpdateNodeVersion { id: _, version: _ } => {
            // Note: update_node_version is not implemented in GraphEngine
            // Version management is done through delete_version + add with new version
            Response::Ok { ok: true }
        }
    }
}

/// Execute a guarantee check (violation query)
fn execute_check_guarantee(
    engine: &GraphEngine,
    rule_source: &str,
) -> std::result::Result<Vec<WireViolation>, String> {
    // Parse the program
    let program = parse_program(rule_source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    // Create evaluator
    let mut evaluator = Evaluator::new(engine);

    // Load all rules
    for rule in program.rules() {
        evaluator.add_rule(rule.clone());
    }

    // Query for violations
    let violation_query = parse_atom("violation(X)")
        .map_err(|e| format!("Internal error parsing violation query: {}", e))?;

    // Execute query
    let bindings = evaluator.query(&violation_query);

    // Convert to wire format
    let violations: Vec<WireViolation> = bindings.into_iter()
        .map(|b| {
            let mut map = std::collections::HashMap::new();
            for (k, v) in b.iter() {
                map.insert(k.clone(), v.as_str());
            }
            WireViolation { bindings: map }
        })
        .collect();

    Ok(violations)
}

/// Execute datalog load rules (returns count of loaded rules)
fn execute_datalog_load_rules(
    _engine: &GraphEngine,
    source: &str,
) -> std::result::Result<u32, String> {
    // Parse the program to validate and count rules
    let program = parse_program(source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    Ok(program.rules().len() as u32)
}

/// Execute a datalog query
fn execute_datalog_query(
    engine: &GraphEngine,
    query_source: &str,
) -> std::result::Result<Vec<WireViolation>, String> {
    // Parse the query atom
    let query_atom = parse_atom(query_source)
        .map_err(|e| format!("Datalog query parse error: {}", e))?;

    // Create evaluator
    let evaluator = Evaluator::new(engine);

    // Execute query
    let bindings = evaluator.query(&query_atom);

    // Convert to wire format
    let results: Vec<WireViolation> = bindings.into_iter()
        .map(|b| {
            let mut map = std::collections::HashMap::new();
            for (k, v) in b.iter() {
                map.insert(k.clone(), v.as_str());
            }
            WireViolation { bindings: map }
        })
        .collect();

    Ok(results)
}

// ============================================================================
// Client Connection Handler
// ============================================================================

fn read_message(stream: &mut UnixStream) -> std::io::Result<Option<Vec<u8>>> {
    // Read 4-byte length prefix (big-endian)
    let mut len_buf = [0u8; 4];
    match stream.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 100 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Message too large: {} bytes", len),
        ));
    }

    // Read payload
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf)?;

    Ok(Some(buf))
}

fn write_message(stream: &mut UnixStream, data: &[u8]) -> std::io::Result<()> {
    // Write 4-byte length prefix (big-endian)
    let len = data.len() as u32;
    stream.write_all(&len.to_be_bytes())?;
    stream.write_all(data)?;
    stream.flush()?;
    Ok(())
}

fn handle_client(
    mut stream: UnixStream,
    engine: Arc<std::sync::RwLock<GraphEngine>>,
    client_id: usize,
) {
    eprintln!("[rfdb-server] Client {} connected", client_id);

    loop {
        // Read request
        let msg = match read_message(&mut stream) {
            Ok(Some(msg)) => msg,
            Ok(None) => {
                eprintln!("[rfdb-server] Client {} disconnected", client_id);
                break;
            }
            Err(e) => {
                eprintln!("[rfdb-server] Client {} read error: {}", client_id, e);
                break;
            }
        };

        // Deserialize request
        let request: Request = match rmp_serde::from_slice(&msg) {
            Ok(req) => req,
            Err(e) => {
                let response = Response::Error { error: format!("Invalid request: {}", e) };
                let resp_bytes = rmp_serde::to_vec(&response).unwrap();
                let _ = write_message(&mut stream, &resp_bytes);
                continue;
            }
        };

        // Check for shutdown
        let is_shutdown = matches!(request, Request::Shutdown);

        // Handle request
        let response = {
            let mut engine_guard = engine.write().unwrap();
            handle_request(&mut engine_guard, request)
        };

        // Serialize and send response (use to_vec_named for proper field names)
        let resp_bytes = match rmp_serde::to_vec_named(&response) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("[rfdb-server] Serialize error: {}", e);
                continue;
            }
        };

        if let Err(e) = write_message(&mut stream, &resp_bytes) {
            eprintln!("[rfdb-server] Client {} write error: {}", client_id, e);
            break;
        }

        if is_shutdown {
            eprintln!("[rfdb-server] Shutdown requested by client {}", client_id);
            std::process::exit(0);
        }
    }
}

// ============================================================================
// Main
// ============================================================================

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: rfdb-server <db-path> [--socket <socket-path>]");
        eprintln!("");
        eprintln!("Arguments:");
        eprintln!("  <db-path>      Path to graph database directory");
        eprintln!("  --socket       Unix socket path (default: /tmp/rfdb.sock)");
        std::process::exit(1);
    }

    let db_path = PathBuf::from(&args[1]);
    let socket_path = args.iter()
        .position(|a| a == "--socket")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
        .unwrap_or("/tmp/rfdb.sock");

    // Remove stale socket file
    let _ = std::fs::remove_file(socket_path);

    // Open or create database
    eprintln!("[rfdb-server] Opening database: {:?}", db_path);
    let engine = if db_path.join("nodes.bin").exists() {
        GraphEngine::open(&db_path).expect("Failed to open database")
    } else {
        GraphEngine::create(&db_path).expect("Failed to create database")
    };
    let engine = Arc::new(std::sync::RwLock::new(engine));

    eprintln!("[rfdb-server] Database opened: {} nodes, {} edges",
        engine.read().unwrap().node_count(),
        engine.read().unwrap().edge_count());

    // Bind Unix socket
    let listener = UnixListener::bind(socket_path).expect("Failed to bind socket");
    eprintln!("[rfdb-server] Listening on {}", socket_path);

    // Set up signal handler for graceful shutdown
    let engine_for_signal = Arc::clone(&engine);
    let socket_path_for_signal = socket_path.to_string();
    let mut signals = signal_hook::iterator::Signals::new(&[
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
    ]).expect("Failed to register signal handlers");

    thread::spawn(move || {
        for sig in signals.forever() {
            eprintln!("[rfdb-server] Received signal {}, flushing...", sig);

            if let Ok(mut guard) = engine_for_signal.write() {
                match guard.flush() {
                    Ok(()) => eprintln!("[rfdb-server] Flush complete"),
                    Err(e) => eprintln!("[rfdb-server] Flush failed: {}", e),
                }
            }

            let _ = std::fs::remove_file(&socket_path_for_signal);
            eprintln!("[rfdb-server] Exiting");
            std::process::exit(0);
        }
    });

    // Accept connections
    let mut client_id = 0;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                client_id += 1;
                let engine_clone = Arc::clone(&engine);
                thread::spawn(move || {
                    handle_client(stream, engine_clone, client_id);
                });
            }
            Err(e) => {
                eprintln!("[rfdb-server] Accept error: {}", e);
            }
        }
    }
}
