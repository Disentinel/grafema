//! RFDB Server - Unix socket server for GraphEngine
//!
//! Multi-database capable graph server. Supports multiple isolated databases
//! per server instance, with ephemeral (in-memory) databases for testing.
//!
//! Usage:
//!   rfdb-server /path/to/default.rfdb [--socket /tmp/rfdb.sock] [--data-dir /data]
//!
//! Protocol:
//!   Request:  [4-byte length BE] [MessagePack payload]
//!   Response: [4-byte length BE] [MessagePack payload]
//!
//! Protocol v1 (legacy):
//!   - Client connects and immediately uses "default" database
//!   - All existing commands work as before
//!
//! Protocol v2 (multi-database):
//!   - Client sends Hello to negotiate version
//!   - Client creates/opens specific databases
//!   - Each session tracks its own current database

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sysinfo::System;

// Import from library
use rfdb::graph::{GraphEngine, GraphStore};
use rfdb::storage::{NodeRecord, EdgeRecord, AttrQuery};
use rfdb::datalog::{parse_program, parse_atom, parse_query, Evaluator};
use rfdb::database_manager::{DatabaseManager, DatabaseInfo, AccessMode};
use rfdb::session::ClientSession;
use rfdb::metrics::{Metrics, MetricsSnapshot, SLOW_QUERY_THRESHOLD_MS};

// Global client ID counter
static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

// ============================================================================
// Wire Protocol Types (Extended for multi-database)
// ============================================================================

/// Request from client
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum Request {
    // ========================================================================
    // Database Management Commands (Protocol v2)
    // ========================================================================

    /// Negotiate protocol version with server
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<u32>,
        #[serde(rename = "clientId")]
        client_id: Option<String>,
    },

    /// Create a new database
    CreateDatabase {
        name: String,
        #[serde(default)]
        ephemeral: bool,
    },

    /// Open a database and set as current for this session
    OpenDatabase {
        name: String,
        #[serde(default = "default_rw_mode")]
        mode: String,
    },

    /// Close current database
    CloseDatabase,

    /// Drop (delete) a database
    DropDatabase { name: String },

    /// List all databases
    ListDatabases,

    /// Get current database for this session
    CurrentDatabase,

    // ========================================================================
    // Existing Commands (unchanged)
    // ========================================================================

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
    /// Get server performance statistics
    ///
    /// Returns metrics about query latency, memory usage, and graph size.
    /// Metrics are collected server-wide, not per-database.
    GetStats,

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

fn default_rw_mode() -> String { "rw".to_string() }

/// Response to client
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    // ========================================================================
    // Database Management Responses (Protocol v2)
    // ========================================================================

    HelloOk {
        ok: bool,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "serverVersion")]
        server_version: String,
        features: Vec<String>,
    },

    DatabaseCreated {
        ok: bool,
        #[serde(rename = "databaseId")]
        database_id: String,
    },

    DatabaseOpened {
        ok: bool,
        #[serde(rename = "databaseId")]
        database_id: String,
        mode: String,
        #[serde(rename = "nodeCount")]
        node_count: u32,
        #[serde(rename = "edgeCount")]
        edge_count: u32,
    },

    DatabaseList {
        databases: Vec<WireDatabaseInfo>,
    },

    CurrentDb {
        database: Option<String>,
        mode: Option<String>,
    },

    /// Structured error with code (for programmatic handling)
    ErrorWithCode {
        error: String,
        code: String,
    },

    // ========================================================================
    // Existing Responses (unchanged)
    // ========================================================================

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

    /// Performance statistics response
    Stats {
        // Graph size
        #[serde(rename = "nodeCount")]
        node_count: u64,
        #[serde(rename = "edgeCount")]
        edge_count: u64,
        #[serde(rename = "deltaSize")]
        delta_size: u64,

        // Memory (system)
        #[serde(rename = "memoryPercent")]
        memory_percent: f32,

        // Query latency
        #[serde(rename = "queryCount")]
        query_count: u64,
        #[serde(rename = "slowQueryCount")]
        slow_query_count: u64,
        #[serde(rename = "queryP50Ms")]
        query_p50_ms: u64,
        #[serde(rename = "queryP95Ms")]
        query_p95_ms: u64,
        #[serde(rename = "queryP99Ms")]
        query_p99_ms: u64,

        // Flush stats
        #[serde(rename = "flushCount")]
        flush_count: u64,
        #[serde(rename = "lastFlushMs")]
        last_flush_ms: u64,
        #[serde(rename = "lastFlushNodes")]
        last_flush_nodes: u64,
        #[serde(rename = "lastFlushEdges")]
        last_flush_edges: u64,

        // Top slow queries
        #[serde(rename = "topSlowQueries")]
        top_slow_queries: Vec<WireSlowQuery>,

        // Uptime
        #[serde(rename = "uptimeSecs")]
        uptime_secs: u64,
    },
}

/// Database information for ListDatabases response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireDatabaseInfo {
    name: String,
    ephemeral: bool,
    node_count: usize,
    edge_count: usize,
    connection_count: usize,
}

impl From<DatabaseInfo> for WireDatabaseInfo {
    fn from(info: DatabaseInfo) -> Self {
        WireDatabaseInfo {
            name: info.name,
            ephemeral: info.ephemeral,
            node_count: info.node_count,
            edge_count: info.edge_count,
            connection_count: info.connection_count,
        }
    }
}

/// Violation from guarantee check
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireViolation {
    pub bindings: HashMap<String, String>,
}

/// Slow query info for wire protocol
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireSlowQuery {
    pub operation: String,
    pub duration_ms: u64,
    pub timestamp_ms: u64,
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
// Memory Check Helper
// ============================================================================

/// Check system memory usage percentage.
///
/// Uses sysinfo crate to query system memory. Returns 0.0 if unable to query.
fn check_memory_usage() -> f32 {
    let mut sys = System::new();
    sys.refresh_memory();
    let total = sys.total_memory();
    if total == 0 {
        return 0.0;
    }
    let used = sys.used_memory();
    (used as f64 / total as f64 * 100.0) as f32
}

// ============================================================================
// Operation Name Helper
// ============================================================================

/// Get operation name for metrics tracking.
///
/// Maps Request variants to string names used by the metrics system.
fn get_operation_name(request: &Request) -> String {
    match request {
        Request::Bfs { .. } => "Bfs".to_string(),
        Request::Dfs { .. } => "Dfs".to_string(),
        Request::Neighbors { .. } => "Neighbors".to_string(),
        Request::Reachability { .. } => "Reachability".to_string(),
        Request::FindByType { .. } => "FindByType".to_string(),
        Request::FindByAttr { .. } => "FindByAttr".to_string(),
        Request::GetNode { .. } => "GetNode".to_string(),
        Request::AddNodes { .. } => "AddNodes".to_string(),
        Request::AddEdges { .. } => "AddEdges".to_string(),
        Request::DatalogQuery { .. } => "DatalogQuery".to_string(),
        Request::CheckGuarantee { .. } => "CheckGuarantee".to_string(),
        Request::GetOutgoingEdges { .. } => "GetOutgoingEdges".to_string(),
        Request::GetIncomingEdges { .. } => "GetIncomingEdges".to_string(),
        Request::Flush => "Flush".to_string(),
        Request::Compact => "Compact".to_string(),
        Request::NodeCount => "NodeCount".to_string(),
        Request::EdgeCount => "EdgeCount".to_string(),
        Request::GetStats => "GetStats".to_string(),
        _ => "Other".to_string(),
    }
}

// ============================================================================
// Request Handler (Multi-database aware)
// ============================================================================

fn handle_request(
    manager: &DatabaseManager,
    session: &mut ClientSession,
    request: Request,
    metrics: &Option<Arc<Metrics>>,
) -> Response {
    match request {
        // ====================================================================
        // Database Management Commands
        // ====================================================================

        Request::Hello { protocol_version, client_id: _ } => {
            session.protocol_version = protocol_version.unwrap_or(2);
            Response::HelloOk {
                ok: true,
                protocol_version: 2,
                server_version: env!("CARGO_PKG_VERSION").to_string(),
                features: vec!["multiDatabase".to_string(), "ephemeral".to_string()],
            }
        }

        Request::CreateDatabase { name, ephemeral } => {
            match manager.create_database(&name, ephemeral) {
                Ok(()) => Response::DatabaseCreated {
                    ok: true,
                    database_id: name,
                },
                Err(e) => Response::ErrorWithCode {
                    error: e.to_string(),
                    code: e.code().to_string(),
                },
            }
        }

        Request::OpenDatabase { name, mode } => {
            // First, close any currently open database
            if session.has_database() {
                handle_close_database(manager, session);
            }

            let access_mode = AccessMode::from_str(&mode);

            match manager.get_database(&name) {
                Ok(db) => {
                    // Track connection
                    db.add_connection();

                    let node_count = db.node_count();
                    let edge_count = db.edge_count();

                    session.set_database(db, access_mode);

                    Response::DatabaseOpened {
                        ok: true,
                        database_id: name,
                        mode: access_mode.as_str().to_string(),
                        node_count: node_count as u32,
                        edge_count: edge_count as u32,
                    }
                }
                Err(e) => Response::ErrorWithCode {
                    error: e.to_string(),
                    code: e.code().to_string(),
                },
            }
        }

        Request::CloseDatabase => {
            if !session.has_database() {
                return Response::Error {
                    error: "No database currently open".to_string(),
                };
            }

            handle_close_database(manager, session);
            Response::Ok { ok: true }
        }

        Request::DropDatabase { name } => {
            match manager.drop_database(&name) {
                Ok(()) => Response::Ok { ok: true },
                Err(e) => Response::ErrorWithCode {
                    error: e.to_string(),
                    code: e.code().to_string(),
                },
            }
        }

        Request::ListDatabases => {
            let databases: Vec<WireDatabaseInfo> = manager.list_databases()
                .into_iter()
                .map(|d| d.into())
                .collect();
            Response::DatabaseList { databases }
        }

        Request::CurrentDatabase => {
            Response::CurrentDb {
                database: session.current_db_name().map(|s| s.to_string()),
                mode: session.current_db.as_ref().map(|_| session.access_mode.as_str().to_string()),
            }
        }

        // ====================================================================
        // Data Operations (require database)
        // ====================================================================

        Request::AddNodes { nodes } => {
            with_engine_write(session, |engine| {
                let records: Vec<NodeRecord> = nodes.into_iter().map(wire_node_to_record).collect();
                engine.add_nodes(records);
                Response::Ok { ok: true }
            })
        }

        Request::AddEdges { edges, skip_validation } => {
            with_engine_write(session, |engine| {
                let records: Vec<EdgeRecord> = edges.into_iter().map(wire_edge_to_record).collect();
                engine.add_edges(records, skip_validation);
                Response::Ok { ok: true }
            })
        }

        Request::DeleteNode { id } => {
            with_engine_write(session, |engine| {
                engine.delete_node(string_to_id(&id));
                Response::Ok { ok: true }
            })
        }

        Request::DeleteEdge { src, dst, edge_type } => {
            with_engine_write(session, |engine| {
                engine.delete_edge(string_to_id(&src), string_to_id(&dst), &edge_type);
                Response::Ok { ok: true }
            })
        }

        Request::GetNode { id } => {
            with_engine_read(session, |engine| {
                let node = engine.get_node(string_to_id(&id)).map(|r| record_to_wire_node(&r));
                Response::Node { node }
            })
        }

        Request::NodeExists { id } => {
            with_engine_read(session, |engine| {
                Response::Bool { value: engine.node_exists(string_to_id(&id)) }
            })
        }

        Request::FindByType { node_type } => {
            with_engine_read(session, |engine| {
                let ids: Vec<String> = engine.find_by_type(&node_type)
                    .into_iter()
                    .map(id_to_string)
                    .collect();
                Response::Ids { ids }
            })
        }

        Request::FindByAttr { query } => {
            with_engine_read(session, |engine| {
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
            })
        }

        Request::Neighbors { id, edge_types } => {
            with_engine_read(session, |engine| {
                let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
                let ids: Vec<String> = engine.neighbors(string_to_id(&id), &edge_types_refs)
                    .into_iter()
                    .map(id_to_string)
                    .collect();
                Response::Ids { ids }
            })
        }

        Request::Bfs { start_ids, max_depth, edge_types } => {
            with_engine_read(session, |engine| {
                let start: Vec<u128> = start_ids.iter().map(|s| string_to_id(s)).collect();
                let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
                let ids: Vec<String> = engine.bfs(&start, max_depth as usize, &edge_types_refs)
                    .into_iter()
                    .map(id_to_string)
                    .collect();
                Response::Ids { ids }
            })
        }

        Request::Reachability { start_ids, max_depth, edge_types, backward } => {
            with_engine_read(session, |engine| {
                let start: Vec<u128> = start_ids.iter().map(|s| string_to_id(s)).collect();
                let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
                let ids: Vec<String> = engine.reachability(&start, max_depth as usize, &edge_types_refs, backward)
                    .into_iter()
                    .map(id_to_string)
                    .collect();
                Response::Ids { ids }
            })
        }

        Request::Dfs { start_ids, max_depth, edge_types } => {
            with_engine_read(session, |engine| {
                let start: Vec<u128> = start_ids.iter().map(|s| string_to_id(s)).collect();
                let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
                let ids: Vec<String> = rfdb::graph::traversal::dfs(
                    &start,
                    max_depth as usize,
                    |id| engine.neighbors(id, &edge_types_refs),
                )
                    .into_iter()
                    .map(id_to_string)
                    .collect();
                Response::Ids { ids }
            })
        }

        Request::GetOutgoingEdges { id, edge_types } => {
            with_engine_read(session, |engine| {
                let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());
                let edges: Vec<WireEdge> = engine.get_outgoing_edges(string_to_id(&id), edge_types_refs.as_deref())
                    .into_iter()
                    .map(|e| record_to_wire_edge(&e))
                    .collect();
                Response::Edges { edges }
            })
        }

        Request::GetIncomingEdges { id, edge_types } => {
            with_engine_read(session, |engine| {
                let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());
                let edges: Vec<WireEdge> = engine.get_incoming_edges(string_to_id(&id), edge_types_refs.as_deref())
                    .into_iter()
                    .map(|e| record_to_wire_edge(&e))
                    .collect();
                Response::Edges { edges }
            })
        }

        Request::NodeCount => {
            with_engine_read(session, |engine| {
                Response::Count { count: engine.node_count() as u32 }
            })
        }

        Request::EdgeCount => {
            with_engine_read(session, |engine| {
                Response::Count { count: engine.edge_count() as u32 }
            })
        }

        Request::CountNodesByType { types } => {
            with_engine_read(session, |engine| {
                Response::Counts { counts: engine.count_nodes_by_type(types.as_deref()) }
            })
        }

        Request::CountEdgesByType { edge_types } => {
            with_engine_read(session, |engine| {
                Response::Counts { counts: engine.count_edges_by_type(edge_types.as_deref()) }
            })
        }

        Request::Flush => {
            with_engine_write(session, |engine| {
                match engine.flush() {
                    Ok(()) => Response::Ok { ok: true },
                    Err(e) => Response::Error { error: e.to_string() },
                }
            })
        }

        Request::Compact => {
            with_engine_write(session, |engine| {
                match engine.compact() {
                    Ok(()) => Response::Ok { ok: true },
                    Err(e) => Response::Error { error: e.to_string() },
                }
            })
        }

        Request::Clear => {
            with_engine_write(session, |engine| {
                engine.clear();
                Response::Ok { ok: true }
            })
        }

        Request::Ping => {
            Response::Pong { pong: true, version: env!("CARGO_PKG_VERSION").to_string() }
        }

        Request::Shutdown => {
            // This will be handled specially in the main loop
            Response::Ok { ok: true }
        }

        Request::GetAllEdges => {
            with_engine_read(session, |engine| {
                let edges: Vec<WireEdge> = engine.get_all_edges()
                    .into_iter()
                    .map(|e| record_to_wire_edge(&e))
                    .collect();
                Response::Edges { edges }
            })
        }

        Request::QueryNodes { query } => {
            with_engine_read(session, |engine| {
                let attr_query = AttrQuery {
                    version: None,
                    node_type: query.node_type,
                    file_id: None,
                    file: query.file,
                    exported: query.exported,
                    name: query.name,
                };
                let ids = engine.find_by_attr(&attr_query);
                let nodes: Vec<WireNode> = ids.into_iter()
                    .filter_map(|id| engine.get_node(id))
                    .map(|r| record_to_wire_node(&r))
                    .collect();
                Response::Nodes { nodes }
            })
        }

        Request::CheckGuarantee { rule_source } => {
            with_engine_read(session, |engine| {
                match execute_check_guarantee(engine, &rule_source) {
                    Ok(violations) => Response::Violations { violations },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::DatalogLoadRules { source } => {
            with_engine_read(session, |engine| {
                match execute_datalog_load_rules(engine, &source) {
                    Ok(count) => Response::Count { count },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::DatalogClearRules => {
            Response::Ok { ok: true }
        }

        Request::DatalogQuery { query } => {
            with_engine_read(session, |engine| {
                match execute_datalog_query(engine, &query) {
                    Ok(results) => Response::DatalogResults { results },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::IsEndpoint { id } => {
            with_engine_read(session, |engine| {
                Response::Bool { value: engine.is_endpoint(string_to_id(&id)) }
            })
        }

        Request::GetNodeIdentifier { id } => {
            with_engine_read(session, |engine| {
                let node = engine.get_node(string_to_id(&id));
                let identifier = node.and_then(|n| {
                    n.name.clone().or_else(|| Some(format!("{}:{}", n.node_type.as_deref().unwrap_or("UNKNOWN"), id)))
                });
                Response::Identifier { identifier }
            })
        }

        Request::UpdateNodeVersion { id: _, version: _ } => {
            with_engine_write(session, |_engine| {
                Response::Ok { ok: true }
            })
        }

        Request::GetStats => {
            // Collect stats from all sources
            let metrics_snapshot = if let Some(ref m) = metrics {
                m.snapshot()
            } else {
                MetricsSnapshot::default()
            };

            // Get graph stats from current database (if any)
            let (node_count, edge_count, delta_size) = if let Some(ref db) = session.current_db {
                let engine = db.engine.read().unwrap();
                (
                    engine.node_count() as u64,
                    engine.edge_count() as u64,
                    engine.ops_since_flush as u64,
                )
            } else {
                // No database selected - return zeros
                (0, 0, 0)
            };

            // Get system memory
            let memory_percent = check_memory_usage();

            Response::Stats {
                node_count,
                edge_count,
                delta_size,
                memory_percent,
                query_count: metrics_snapshot.query_count,
                slow_query_count: metrics_snapshot.slow_query_count,
                query_p50_ms: metrics_snapshot.query_p50_ms,
                query_p95_ms: metrics_snapshot.query_p95_ms,
                query_p99_ms: metrics_snapshot.query_p99_ms,
                flush_count: metrics_snapshot.flush_count,
                last_flush_ms: metrics_snapshot.last_flush_ms,
                last_flush_nodes: metrics_snapshot.last_flush_nodes,
                last_flush_edges: metrics_snapshot.last_flush_edges,
                top_slow_queries: metrics_snapshot.top_slow_queries.into_iter()
                    .map(|sq| WireSlowQuery {
                        operation: sq.operation,
                        duration_ms: sq.duration_ms,
                        timestamp_ms: sq.timestamp_ms,
                    })
                    .collect(),
                uptime_secs: metrics_snapshot.uptime_secs,
            }
        }
    }
}

/// Helper: execute read operation on current database
fn with_engine_read<F>(session: &ClientSession, f: F) -> Response
where
    F: FnOnce(&GraphEngine) -> Response,
{
    match &session.current_db {
        Some(db) => {
            let engine = db.engine.read().unwrap();
            f(&engine)
        }
        None => Response::ErrorWithCode {
            error: "No database selected. Use openDatabase first.".to_string(),
            code: "NO_DATABASE_SELECTED".to_string(),
        },
    }
}

/// Helper: execute write operation on current database
fn with_engine_write<F>(session: &ClientSession, f: F) -> Response
where
    F: FnOnce(&mut GraphEngine) -> Response,
{
    match &session.current_db {
        Some(db) => {
            if !session.can_write() {
                return Response::ErrorWithCode {
                    error: "Operation not allowed in read-only mode".to_string(),
                    code: "READ_ONLY_MODE".to_string(),
                };
            }
            let mut engine = db.engine.write().unwrap();
            f(&mut engine)
        }
        None => Response::ErrorWithCode {
            error: "No database selected. Use openDatabase first.".to_string(),
            code: "NO_DATABASE_SELECTED".to_string(),
        },
    }
}

/// Close current database and decrement connection count
///
/// If the database is ephemeral and no other connections remain,
/// it will be automatically removed from the manager.
fn handle_close_database(manager: &DatabaseManager, session: &mut ClientSession) {
    if let Some(db) = &session.current_db {
        let db_name = db.name.clone();
        db.remove_connection();
        // Cleanup ephemeral database if no connections remain
        manager.cleanup_ephemeral_if_unused(&db_name);
    }
    session.clear_database();
}

// ============================================================================
// Datalog Helpers
// ============================================================================

/// Execute a guarantee check (violation query)
fn execute_check_guarantee(
    engine: &GraphEngine,
    rule_source: &str,
) -> std::result::Result<Vec<WireViolation>, String> {
    let program = parse_program(rule_source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    let mut evaluator = Evaluator::new(engine);

    for rule in program.rules() {
        evaluator.add_rule(rule.clone());
    }

    let violation_query = parse_atom("violation(X)")
        .map_err(|e| format!("Internal error parsing violation query: {}", e))?;

    let bindings = evaluator.query(&violation_query);

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
    let program = parse_program(source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    Ok(program.rules().len() as u32)
}

/// Execute a datalog query
fn execute_datalog_query(
    engine: &GraphEngine,
    query_source: &str,
) -> std::result::Result<Vec<WireViolation>, String> {
    let literals = parse_query(query_source)
        .map_err(|e| format!("Datalog query parse error: {}", e))?;

    let evaluator = Evaluator::new(engine);

    let bindings = evaluator.eval_query(&literals);

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
    manager: Arc<DatabaseManager>,
    client_id: usize,
    legacy_mode: bool,
    metrics: Option<Arc<Metrics>>,
) {
    eprintln!("[rfdb-server] Client {} connected", client_id);

    let mut session = ClientSession::new(client_id);

    // In legacy mode (protocol v1), auto-open "default" database
    if legacy_mode {
        if let Ok(db) = manager.get_database("default") {
            db.add_connection();
            session.set_database(db, AccessMode::ReadWrite);
        }
    }

    loop {
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

        let request: Request = match rmp_serde::from_slice(&msg) {
            Ok(req) => req,
            Err(e) => {
                let response = Response::Error { error: format!("Invalid request: {}", e) };
                let resp_bytes = rmp_serde::to_vec_named(&response).unwrap();
                let _ = write_message(&mut stream, &resp_bytes);
                continue;
            }
        };

        let is_shutdown = matches!(request, Request::Shutdown);

        // Time the request for metrics
        let start = Instant::now();
        let op_name = get_operation_name(&request);

        let response = handle_request(&manager, &mut session, request, &metrics);

        // Record metrics if enabled
        if let Some(ref m) = metrics {
            let duration_ms = start.elapsed().as_millis() as u64;
            m.record_query(&op_name, duration_ms);

            // Log slow queries to stderr (existing pattern)
            if duration_ms >= SLOW_QUERY_THRESHOLD_MS {
                eprintln!("[RUST SLOW] {}: {}ms (client {})",
                         op_name, duration_ms, client_id);
            }
        }

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

    // Cleanup: close database and release connections
    handle_close_database(&manager, &mut session);
}

// ============================================================================
// Main
// ============================================================================

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Handle --version / -V flag
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("rfdb-server {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }

    // Handle --help / -h flag
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("rfdb-server {}", env!("CARGO_PKG_VERSION"));
        println!();
        println!("High-performance disk-backed graph database server for Grafema");
        println!();
        println!("Usage: rfdb-server <db-path> [--socket <socket-path>] [--data-dir <dir>] [--metrics]");
        println!();
        println!("Arguments:");
        println!("  <db-path>      Path to default graph database directory");
        println!("  --socket       Unix socket path (default: /tmp/rfdb.sock)");
        println!("  --data-dir     Base directory for multi-database storage");
        println!();
        println!("Flags:");
        println!("  -V, --version  Print version information");
        println!("  -h, --help     Print this help message");
        println!("  --metrics      Enable performance metrics collection");
        std::process::exit(0);
    }

    if args.len() < 2 {
        eprintln!("Usage: rfdb-server <db-path> [--socket <socket-path>] [--data-dir <dir>] [--metrics]");
        eprintln!("");
        eprintln!("Arguments:");
        eprintln!("  <db-path>      Path to default graph database directory");
        eprintln!("  --socket       Unix socket path (default: /tmp/rfdb.sock)");
        eprintln!("  --data-dir     Base directory for multi-database storage");
        eprintln!("  --metrics      Enable performance metrics collection");
        std::process::exit(1);
    }

    let db_path_str = &args[1];

    // Validate db-path doesn't look like a flag
    if db_path_str.starts_with("--") {
        eprintln!("Error: db-path '{}' looks like a flag, not a path.", db_path_str);
        eprintln!("");
        eprintln!("Correct usage:");
        eprintln!("  rfdb-server ./my-graph.rfdb --socket /tmp/rfdb.sock");
        eprintln!("");
        eprintln!("The first argument must be the database path, not a flag.");
        std::process::exit(1);
    }

    let db_path = PathBuf::from(db_path_str);
    let socket_path = args.iter()
        .position(|a| a == "--socket")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
        .unwrap_or("/tmp/rfdb.sock");

    let data_dir = args.iter()
        .position(|a| a == "--data-dir")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| db_path.parent().unwrap_or(&db_path).to_path_buf());

    // Create metrics collector if --metrics flag is present
    let metrics_enabled = args.iter().any(|a| a == "--metrics");
    let metrics: Option<Arc<Metrics>> = if metrics_enabled {
        eprintln!("[rfdb-server] Metrics collection enabled");
        Some(Arc::new(Metrics::new()))
    } else {
        None
    };

    // Remove stale socket file
    let _ = std::fs::remove_file(socket_path);

    // Create database manager with data directory
    let manager = Arc::new(DatabaseManager::new(data_dir.clone()));

    // Create "default" database from legacy db_path for backwards compatibility
    eprintln!("[rfdb-server] Opening default database: {:?}", db_path);
    manager.create_default_from_path(&db_path)
        .expect("Failed to create default database");

    eprintln!("[rfdb-server] Data directory for multi-database: {:?}", data_dir);

    // Get stats from default database
    if let Ok(db) = manager.get_database("default") {
        eprintln!("[rfdb-server] Default database: {} nodes, {} edges",
            db.node_count(),
            db.edge_count());
    }

    // Bind Unix socket
    let listener = UnixListener::bind(socket_path).expect("Failed to bind socket");
    eprintln!("[rfdb-server] Listening on {}", socket_path);

    // Set up signal handler for graceful shutdown
    let manager_for_signal = Arc::clone(&manager);
    let socket_path_for_signal = socket_path.to_string();
    let mut signals = signal_hook::iterator::Signals::new(&[
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
    ]).expect("Failed to register signal handlers");

    thread::spawn(move || {
        for sig in signals.forever() {
            eprintln!("[rfdb-server] Received signal {}, flushing...", sig);

            // Flush all databases
            for db_info in manager_for_signal.list_databases() {
                if let Ok(db) = manager_for_signal.get_database(&db_info.name) {
                    if let Ok(mut engine) = db.engine.write() {
                        match engine.flush() {
                            Ok(()) => eprintln!("[rfdb-server] Flushed database '{}'", db_info.name),
                            Err(e) => eprintln!("[rfdb-server] Flush failed for '{}': {}", db_info.name, e),
                        }
                    }
                }
            }

            let _ = std::fs::remove_file(&socket_path_for_signal);
            eprintln!("[rfdb-server] Exiting");
            std::process::exit(0);
        }
    });

    // Accept connections
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::SeqCst);
                let manager_clone = Arc::clone(&manager);
                let metrics_clone = metrics.clone();
                thread::spawn(move || {
                    // legacy_mode: true until client sends Hello
                    handle_client(stream, manager_clone, client_id, true, metrics_clone);
                });
            }
            Err(e) => {
                eprintln!("[rfdb-server] Accept error: {}", e);
            }
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use tempfile::tempdir;

    // Helper to create a test manager with default database
    fn setup_test_manager() -> (tempfile::TempDir, Arc<DatabaseManager>) {
        let dir = tempdir().unwrap();
        let manager = Arc::new(DatabaseManager::new(dir.path().to_path_buf()));

        // Create default database for backwards compat testing
        let db_path = dir.path().join("default.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();
        manager.create_default_from_path(&db_path).unwrap();

        (dir, manager)
    }

    // ============================================================================
    // Hello Command
    // ============================================================================

    #[test]
    fn test_hello_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let request = Request::Hello {
            protocol_version: Some(2),
            client_id: Some("test-client".to_string()),
        };

        let response = handle_request(&manager, &mut session, request, &None);

        match response {
            Response::HelloOk { ok, protocol_version, server_version, features } => {
                assert!(ok);
                assert_eq!(protocol_version, 2);
                assert!(!server_version.is_empty());
                assert!(features.contains(&"multiDatabase".to_string()));
                assert!(features.contains(&"ephemeral".to_string()));
            }
            _ => panic!("Expected HelloOk response"),
        }

        assert_eq!(session.protocol_version, 2);
    }

    // ============================================================================
    // CreateDatabase Command
    // ============================================================================

    #[test]
    fn test_create_database_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let request = Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: false,
        };

        let response = handle_request(&manager, &mut session, request, &None);

        match response {
            Response::DatabaseCreated { ok, database_id } => {
                assert!(ok);
                assert_eq!(database_id, "testdb");
            }
            _ => panic!("Expected DatabaseCreated response"),
        }

        assert!(manager.database_exists("testdb"));
    }

    #[test]
    fn test_create_database_already_exists() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("existing", false).unwrap();

        let request = Request::CreateDatabase {
            name: "existing".to_string(),
            ephemeral: false,
        };

        let response = handle_request(&manager, &mut session, request, &None);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("existing"));
                assert_eq!(code, "DATABASE_EXISTS");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    // ============================================================================
    // OpenDatabase Command
    // ============================================================================

    #[test]
    fn test_open_database_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        let request = Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        };

        let response = handle_request(&manager, &mut session, request, &None);

        match response {
            Response::DatabaseOpened { ok, database_id, mode, node_count, edge_count } => {
                assert!(ok);
                assert_eq!(database_id, "testdb");
                assert_eq!(mode, "rw");
                assert_eq!(node_count, 0);
                assert_eq!(edge_count, 0);
            }
            _ => panic!("Expected DatabaseOpened response"),
        }

        assert!(session.has_database());
        assert_eq!(session.current_db_name(), Some("testdb"));

        // Verify connection count incremented
        let db = manager.get_database("testdb").unwrap();
        assert_eq!(db.connection_count(), 1);
    }

    #[test]
    fn test_open_database_not_found() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let request = Request::OpenDatabase {
            name: "nonexistent".to_string(),
            mode: "rw".to_string(),
        };

        let response = handle_request(&manager, &mut session, request, &None);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("nonexistent"));
                assert_eq!(code, "DATABASE_NOT_FOUND");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    #[test]
    fn test_open_database_closes_previous() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("db1", false).unwrap();
        manager.create_database("db2", false).unwrap();

        // Open first database
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "db1".to_string(),
            mode: "rw".to_string(),
        }, &None);

        let db1 = manager.get_database("db1").unwrap();
        assert_eq!(db1.connection_count(), 1);

        // Open second database - should close first
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "db2".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // db1 should have 0 connections now
        assert_eq!(db1.connection_count(), 0);

        let db2 = manager.get_database("db2").unwrap();
        assert_eq!(db2.connection_count(), 1);

        assert_eq!(session.current_db_name(), Some("db2"));
    }

    // ============================================================================
    // CloseDatabase Command
    // ============================================================================

    #[test]
    fn test_close_database_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        // Open database
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Close it
        let response = handle_request(&manager, &mut session, Request::CloseDatabase, &None);

        match response {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok response"),
        }

        assert!(!session.has_database());

        let db = manager.get_database("testdb").unwrap();
        assert_eq!(db.connection_count(), 0);
    }

    #[test]
    fn test_close_database_no_database_open() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let response = handle_request(&manager, &mut session, Request::CloseDatabase, &None);

        match response {
            Response::Error { error } => {
                assert!(error.contains("No database"));
            }
            _ => panic!("Expected Error response"),
        }
    }

    // ============================================================================
    // DropDatabase Command
    // ============================================================================

    #[test]
    fn test_drop_database_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        let response = handle_request(&manager, &mut session, Request::DropDatabase {
            name: "testdb".to_string(),
        }, &None);

        match response {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok response"),
        }

        assert!(!manager.database_exists("testdb"));
    }

    #[test]
    fn test_drop_database_in_use() {
        let (_dir, manager) = setup_test_manager();
        let mut session1 = ClientSession::new(1);
        let mut session2 = ClientSession::new(2);

        manager.create_database("testdb", false).unwrap();

        // Session 1 opens database
        handle_request(&manager, &mut session1, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Session 2 tries to drop
        let response = handle_request(&manager, &mut session2, Request::DropDatabase {
            name: "testdb".to_string(),
        }, &None);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("in use"));
                assert_eq!(code, "DATABASE_IN_USE");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    // ============================================================================
    // ListDatabases Command
    // ============================================================================

    #[test]
    fn test_list_databases_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("db1", false).unwrap();
        manager.create_database("db2", true).unwrap();

        let response = handle_request(&manager, &mut session, Request::ListDatabases, &None);

        match response {
            Response::DatabaseList { databases } => {
                // default + db1 + db2
                assert!(databases.len() >= 2);

                let db1_info = databases.iter().find(|d| d.name == "db1");
                assert!(db1_info.is_some());
                assert!(!db1_info.unwrap().ephemeral);

                let db2_info = databases.iter().find(|d| d.name == "db2");
                assert!(db2_info.is_some());
                assert!(db2_info.unwrap().ephemeral);
            }
            _ => panic!("Expected DatabaseList response"),
        }
    }

    // ============================================================================
    // CurrentDatabase Command
    // ============================================================================

    #[test]
    fn test_current_database_none() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        session.clear_database(); // Ensure no database is set

        let response = handle_request(&manager, &mut session, Request::CurrentDatabase, &None);

        match response {
            Response::CurrentDb { database, mode } => {
                assert!(database.is_none());
                assert!(mode.is_none());
            }
            _ => panic!("Expected CurrentDb response"),
        }
    }

    #[test]
    fn test_current_database_with_open() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "ro".to_string(),
        }, &None);

        let response = handle_request(&manager, &mut session, Request::CurrentDatabase, &None);

        match response {
            Response::CurrentDb { database, mode } => {
                assert_eq!(database, Some("testdb".to_string()));
                assert_eq!(mode, Some("ro".to_string()));
            }
            _ => panic!("Expected CurrentDb response"),
        }
    }

    // ============================================================================
    // Backwards Compatibility (Protocol v1)
    // ============================================================================

    #[test]
    fn test_legacy_client_auto_opens_default() {
        let (_dir, manager) = setup_test_manager();

        // Simulate legacy client connection (legacy_mode = true)
        let mut session = ClientSession::new(1);

        // In legacy mode, session should auto-open "default" database
        let db = manager.get_database("default").unwrap();
        db.add_connection();
        session.set_database(db.clone(), AccessMode::ReadWrite);

        assert!(session.has_database());
        assert_eq!(session.current_db_name(), Some("default"));
    }

    #[test]
    fn test_data_ops_require_database() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        // Protocol v2 client without opening database
        session.protocol_version = 2;
        session.clear_database();

        let request = Request::AddNodes { nodes: vec![] };
        let response = handle_request(&manager, &mut session, request, &None);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("No database"));
                assert_eq!(code, "NO_DATABASE_SELECTED");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    // ============================================================================
    // Read-Only Mode
    // ============================================================================

    #[test]
    fn test_read_only_blocks_writes() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "ro".to_string(),
        }, &None);

        let request = Request::AddNodes { nodes: vec![] };
        let response = handle_request(&manager, &mut session, request, &None);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("read-only"));
                assert_eq!(code, "READ_ONLY_MODE");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    #[test]
    fn test_read_only_allows_reads() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "ro".to_string(),
        }, &None);

        let response = handle_request(&manager, &mut session, Request::NodeCount, &None);

        match response {
            Response::Count { count } => {
                assert_eq!(count, 0);
            }
            _ => panic!("Expected Count response"),
        }
    }

    // ============================================================================
    // GetStats Command
    // ============================================================================

    #[test]
    fn test_get_stats_no_database() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        session.clear_database(); // Ensure no database is set

        let metrics = Some(Arc::new(Metrics::new()));

        // Record some queries
        metrics.as_ref().unwrap().record_query("Bfs", 50);
        metrics.as_ref().unwrap().record_query("Bfs", 150); // slow

        let response = handle_request(&manager, &mut session, Request::GetStats, &metrics);

        match response {
            Response::Stats {
                query_count, slow_query_count, node_count, edge_count, ..
            } => {
                assert_eq!(query_count, 2);
                assert_eq!(slow_query_count, 1);
                // No database selected
                assert_eq!(node_count, 0);
                assert_eq!(edge_count, 0);
            }
            _ => panic!("Expected Stats response"),
        }
    }

    #[test]
    fn test_get_stats_with_database() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        let metrics = Some(Arc::new(Metrics::new()));

        // Open default database
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "default".to_string(),
            mode: "rw".to_string(),
        }, &metrics);

        // Add some nodes
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![WireNode {
                id: "1".to_string(),
                node_type: Some("TEST".to_string()),
                name: Some("test".to_string()),
                file: None,
                exported: false,
                metadata: None,
            }],
        }, &metrics);

        let response = handle_request(&manager, &mut session, Request::GetStats, &metrics);

        match response {
            Response::Stats { node_count, .. } => {
                assert_eq!(node_count, 1);
            }
            _ => panic!("Expected Stats response"),
        }
    }

    #[test]
    fn test_get_stats_metrics_disabled() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        let metrics: Option<Arc<Metrics>> = None; // Disabled

        let response = handle_request(&manager, &mut session, Request::GetStats, &metrics);

        match response {
            Response::Stats { query_count, .. } => {
                // Should return zeros when metrics disabled
                assert_eq!(query_count, 0);
            }
            _ => panic!("Expected Stats response"),
        }
    }
}
