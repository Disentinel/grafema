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

use std::collections::{HashMap, HashSet};
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
use rfdb::graph::{GraphEngine, GraphEngineV2, GraphStore};
use rfdb::storage::{NodeRecord, EdgeRecord, AttrQuery, FieldDecl, FieldType};
use rfdb::datalog::{parse_program, parse_atom, parse_query, Evaluator};
use rfdb::database_manager::{DatabaseManager, DatabaseInfo, AccessMode};
use rfdb::session::ClientSession;
use rfdb::metrics::{Metrics, MetricsSnapshot, SLOW_QUERY_THRESHOLD_MS};

// Global client ID counter
static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

/// Streaming threshold: queries returning more than this many nodes
/// will use chunked streaming instead of a single Response::Nodes.
/// Only active when the client negotiated protocol version >= 3.
const STREAMING_THRESHOLD: usize = 100;

/// Maximum nodes per streaming chunk.
const STREAMING_CHUNK_SIZE: usize = 500;

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
    ExecuteDatalog { source: String },

    // Node utility
    IsEndpoint { id: String },
    GetNodeIdentifier { id: String },
    UpdateNodeVersion { id: String, version: String },

    // Schema declaration
    DeclareFields { fields: Vec<WireFieldDecl> },

    // Batch operations
    CommitBatch {
        #[serde(rename = "changedFiles")]
        changed_files: Vec<String>,
        nodes: Vec<WireNode>,
        edges: Vec<WireEdge>,
        #[serde(default)]
        tags: Option<Vec<String>>,
        #[serde(default, rename = "fileContext")]
        file_context: Option<String>,
        /// When true, write data to disk but skip index rebuild.
        /// Caller must send RebuildIndexes after all deferred commits complete.
        #[serde(default, rename = "deferIndex")]
        defer_index: bool,
    },

    /// Rebuild all secondary indexes from current segment.
    /// Send after a series of deferIndex=true CommitBatch commands.
    RebuildIndexes,

    // ========================================================================
    // Protocol v3 Commands
    // ========================================================================

    /// Begin a batch operation (session-level state)
    BeginBatch,

    /// Abort the current batch operation
    AbortBatch,

    /// Tag a snapshot version with key-value pairs (v2 engine only)
    TagSnapshot {
        version: u64,
        tags: HashMap<String, String>,
    },

    /// Find a snapshot by tag key/value (v2 engine only)
    FindSnapshot {
        #[serde(rename = "tagKey")]
        tag_key: String,
        #[serde(rename = "tagValue")]
        tag_value: String,
    },

    /// List snapshots, optionally filtered by tag key (v2 engine only)
    ListSnapshots {
        #[serde(rename = "filterTag")]
        filter_tag: Option<String>,
    },

    /// Diff two snapshots (v2 engine only)
    DiffSnapshots {
        #[serde(rename = "fromVersion")]
        from_version: u64,
        #[serde(rename = "toVersion")]
        to_version: u64,
    },

    /// Enhanced edge query with direction and optional limit
    QueryEdges {
        id: String,
        /// "outgoing", "incoming", or "both"
        direction: String,
        #[serde(rename = "edgeTypes")]
        edge_types: Option<Vec<String>>,
        limit: Option<u32>,
    },

    /// Find files that depend on a node/file
    FindDependentFiles {
        id: String,
        #[serde(rename = "edgeTypes")]
        edge_types: Option<Vec<String>>,
    },
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

    BatchCommitted {
        ok: bool,
        delta: WireCommitDelta,
    },

    Ok { ok: bool },
    Error { error: String },
    Node { node: Option<WireNode> },
    /// Streaming chunk of nodes for QueryNodes.
    /// Discriminated from Nodes by presence of `done` field.
    NodesChunk {
        nodes: Vec<WireNode>,
        done: bool,
        #[serde(rename = "chunkIndex")]
        chunk_index: u32,
    },
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

    // ========================================================================
    // Protocol v3 Responses
    // ========================================================================

    /// Response for BeginBatch
    BatchStarted {
        ok: bool,
        #[serde(rename = "batchId")]
        batch_id: String,
    },

    /// Response for snapshot version lookup
    SnapshotVersion {
        version: Option<u64>,
    },

    /// Response for ListSnapshots
    SnapshotList {
        snapshots: Vec<WireSnapshotInfo>,
    },

    /// Response for DiffSnapshots
    SnapshotDiffResult {
        diff: WireSnapshotDiff,
    },

    /// Response for FindDependentFiles
    Files {
        files: Vec<String>,
    },

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

/// Request envelope: captures requestId alongside the tagged Request.
#[derive(Deserialize)]
struct RequestEnvelope {
    #[serde(default, rename = "requestId")]
    request_id: Option<String>,
    #[serde(flatten)]
    request: Request,
}

/// Response envelope: wraps Response with optional requestId for echo-back.
#[derive(Serialize)]
struct ResponseEnvelope {
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(flatten)]
    response: Response,
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
    /// Semantic ID string — first-class in v3 wire format.
    /// Populated on read from v2 storage; used on write to preserve real semantic ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub semantic_id: Option<String>,
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

/// Attribute query for wire protocol.
/// Known fields are deserialized into typed fields;
/// any extra fields (e.g. "object", "method") are captured in `extra`
/// and used as metadata filters.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAttrQuery {
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub file: Option<String>,
    pub exported: Option<bool>,
    /// Extra fields are matched against node metadata JSON.
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

/// Field declaration for metadata indexing (wire protocol)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFieldDecl {
    pub name: String,
    #[serde(default)]
    pub field_type: Option<String>,
    #[serde(default)]
    pub node_types: Option<Vec<String>>,
}

/// Structured diff returned by CommitBatch handler.
///
/// Simplified wire version of storage_v2::CommitDelta — focuses on what
/// the TS pipeline needs (counts + affected types/files) without v2-specific
/// fields like manifest_version or removed_node_ids.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCommitDelta {
    pub changed_files: Vec<String>,
    pub nodes_added: u64,
    pub nodes_removed: u64,
    pub edges_added: u64,
    pub edges_removed: u64,
    pub changed_node_types: Vec<String>,
    pub changed_edge_types: Vec<String>,
}

/// Snapshot info for wire protocol (v2 engine only)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireSnapshotInfo {
    pub version: u64,
    pub created_at: u64,
    pub tags: HashMap<String, String>,
    pub total_nodes: u64,
    pub total_edges: u64,
}

/// Snapshot diff for wire protocol (v2 engine only)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireSnapshotDiff {
    pub from_version: u64,
    pub to_version: u64,
    pub added_node_segments: u64,
    pub removed_node_segments: u64,
    pub added_edge_segments: u64,
    pub removed_edge_segments: u64,
    pub stats_from: WireManifestStats,
    pub stats_to: WireManifestStats,
}

/// Manifest stats for wire protocol
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireManifestStats {
    pub total_nodes: u64,
    pub total_edges: u64,
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
    // If client sends semanticId (v3), use it for both the semantic_id field
    // and to compute the u128 hash (ensuring consistency).
    let id = if node.semantic_id.is_some() {
        string_to_id(node.semantic_id.as_ref().unwrap())
    } else {
        string_to_id(&node.id)
    };
    NodeRecord {
        id,
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
        semantic_id: node.semantic_id,
    }
}

fn record_to_wire_node(record: &NodeRecord) -> WireNode {
    WireNode {
        id: id_to_string(record.id),
        semantic_id: record.semantic_id.clone(),
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

/// Resolve u128 edge endpoints to semantic ID strings using node lookups.
/// For v3 protocol: replaces numeric src/dst with human-readable semantic IDs.
fn resolve_edge_semantic_ids(edges: &mut [WireEdge], engine: &dyn GraphStore) {
    for edge in edges.iter_mut() {
        if let Ok(src_id) = edge.src.parse::<u128>() {
            if let Some(node) = engine.get_node(src_id) {
                if let Some(sid) = node.semantic_id {
                    edge.src = sid;
                }
            }
        }
        if let Ok(dst_id) = edge.dst.parse::<u128>() {
            if let Some(node) = engine.get_node(dst_id) {
                if let Some(sid) = node.semantic_id {
                    edge.dst = sid;
                }
            }
        }
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
        Request::CommitBatch { .. } => "CommitBatch".to_string(),
        Request::RebuildIndexes => "RebuildIndexes".to_string(),
        Request::TagSnapshot { .. } => "TagSnapshot".to_string(),
        Request::FindSnapshot { .. } => "FindSnapshot".to_string(),
        Request::ListSnapshots { .. } => "ListSnapshots".to_string(),
        Request::DiffSnapshots { .. } => "DiffSnapshots".to_string(),
        Request::QueryEdges { .. } => "QueryEdges".to_string(),
        Request::FindDependentFiles { .. } => "FindDependentFiles".to_string(),
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
                protocol_version: 3,
                server_version: env!("CARGO_PKG_VERSION").to_string(),
                features: vec!["multiDatabase".to_string(), "ephemeral".to_string(), "semanticIds".to_string(), "streaming".to_string()],
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
                // Convert extra wire fields to metadata filters
                let metadata_filters: Vec<(String, String)> = query.extra.into_iter()
                    .filter_map(|(k, v)| {
                        // Convert JSON values to string for matching
                        match v {
                            serde_json::Value::String(s) => Some((k, s)),
                            serde_json::Value::Bool(b) => Some((k, b.to_string())),
                            serde_json::Value::Number(n) => Some((k, n.to_string())),
                            _ => None, // Skip null, arrays, objects
                        }
                    })
                    .collect();

                let attr_query = AttrQuery {
                    version: None,
                    node_type: query.node_type,
                    file_id: None,
                    file: query.file,
                    exported: query.exported,
                    name: query.name,
                    metadata_filters,
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
                let ids: Vec<String> = rfdb::graph::reachability(engine, &start, max_depth as usize, &edge_types_refs, backward)
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
            let protocol = session.protocol_version;
            with_engine_read(session, |engine| {
                let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());
                let mut edges: Vec<WireEdge> = engine.get_outgoing_edges(string_to_id(&id), edge_types_refs.as_deref())
                    .into_iter()
                    .map(|e| record_to_wire_edge(&e))
                    .collect();
                if protocol >= 3 {
                    resolve_edge_semantic_ids(&mut edges, engine);
                }
                Response::Edges { edges }
            })
        }

        Request::GetIncomingEdges { id, edge_types } => {
            let protocol = session.protocol_version;
            with_engine_read(session, |engine| {
                let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());
                let mut edges: Vec<WireEdge> = engine.get_incoming_edges(string_to_id(&id), edge_types_refs.as_deref())
                    .into_iter()
                    .map(|e| record_to_wire_edge(&e))
                    .collect();
                if protocol >= 3 {
                    resolve_edge_semantic_ids(&mut edges, engine);
                }
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
            let protocol = session.protocol_version;
            with_engine_read(session, |engine| {
                let mut edges: Vec<WireEdge> = engine.get_all_edges()
                    .into_iter()
                    .map(|e| record_to_wire_edge(&e))
                    .collect();
                if protocol >= 3 {
                    resolve_edge_semantic_ids(&mut edges, engine);
                }
                Response::Edges { edges }
            })
        }

        Request::QueryNodes { query } => {
            with_engine_read(session, |engine| {
                let metadata_filters: Vec<(String, String)> = query.extra.into_iter()
                    .filter_map(|(k, v)| {
                        match v {
                            serde_json::Value::String(s) => Some((k, s)),
                            serde_json::Value::Bool(b) => Some((k, b.to_string())),
                            serde_json::Value::Number(n) => Some((k, n.to_string())),
                            _ => None,
                        }
                    })
                    .collect();

                let attr_query = AttrQuery {
                    version: None,
                    node_type: query.node_type,
                    file_id: None,
                    file: query.file,
                    exported: query.exported,
                    name: query.name,
                    metadata_filters,
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

        Request::ExecuteDatalog { source } => {
            with_engine_read(session, |engine| {
                match execute_datalog(engine, &source) {
                    Ok(results) => Response::DatalogResults { results },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::IsEndpoint { id } => {
            with_engine_read(session, |engine| {
                Response::Bool { value: rfdb::graph::is_endpoint(engine, string_to_id(&id)) }
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

        Request::DeclareFields { fields } => {
            with_engine_write(session, |engine| {
                let field_decls: Vec<FieldDecl> = fields.into_iter().map(|f| {
                    let field_type = match f.field_type.as_deref() {
                        Some("bool") => FieldType::Bool,
                        Some("int") => FieldType::Int,
                        Some("id") => FieldType::Id,
                        _ => FieldType::String,
                    };
                    FieldDecl {
                        name: f.name,
                        field_type,
                        node_types: f.node_types,
                    }
                }).collect();
                let count = field_decls.len() as u32;
                engine.declare_fields(field_decls);
                Response::Count { count }
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
                let ops = if let Some(v1) = engine.as_any().downcast_ref::<GraphEngine>() {
                    v1.ops_since_flush as u64
                } else {
                    0 // v2 engine doesn't track ops_since_flush
                };
                (
                    engine.node_count() as u64,
                    engine.edge_count() as u64,
                    ops,
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

        Request::CommitBatch { changed_files, nodes, edges, tags: _, file_context, defer_index } => {
            with_engine_write(session, |engine| {
                handle_commit_batch(engine, changed_files, nodes, edges, file_context, defer_index)
            })
        }

        Request::RebuildIndexes => {
            with_engine_write(session, |engine| {
                if let Err(e) = engine.rebuild_indexes() {
                    return Response::Error { error: format!("Index rebuild failed: {}", e) };
                }
                Response::Ok { ok: true }
            })
        }

        // ====================================================================
        // Protocol v3 Commands
        // ====================================================================

        Request::BeginBatch => {
            match session.begin_batch() {
                Some(batch_id) => Response::BatchStarted { ok: true, batch_id },
                None => Response::Error {
                    error: format!(
                        "Batch already in progress: {}",
                        session.pending_batch_id.as_deref().unwrap_or("unknown")
                    ),
                },
            }
        }

        Request::AbortBatch => {
            match session.abort_batch() {
                Some(_) => Response::Ok { ok: true },
                None => Response::Error {
                    error: "No batch in progress".to_string(),
                },
            }
        }

        Request::TagSnapshot { version, tags } => {
            with_engine_write(session, |engine| {
                match engine.as_any_mut().downcast_mut::<GraphEngineV2>() {
                    Some(v2) => {
                        match v2.tag_snapshot(version, tags) {
                            Ok(()) => Response::Ok { ok: true },
                            Err(e) => Response::Error { error: e.to_string() },
                        }
                    }
                    None => Response::ErrorWithCode {
                        error: "TagSnapshot requires v2 engine".to_string(),
                        code: "V2_REQUIRED".to_string(),
                    },
                }
            })
        }

        Request::FindSnapshot { tag_key, tag_value } => {
            with_engine_read(session, |engine| {
                match engine.as_any().downcast_ref::<GraphEngineV2>() {
                    Some(v2) => {
                        let version = v2.find_snapshot(&tag_key, &tag_value);
                        Response::SnapshotVersion { version }
                    }
                    None => Response::ErrorWithCode {
                        error: "FindSnapshot requires v2 engine".to_string(),
                        code: "V2_REQUIRED".to_string(),
                    },
                }
            })
        }

        Request::ListSnapshots { filter_tag } => {
            with_engine_read(session, |engine| {
                match engine.as_any().downcast_ref::<GraphEngineV2>() {
                    Some(v2) => {
                        let snapshots = v2.list_snapshots(filter_tag.as_deref());
                        let wire_snapshots: Vec<WireSnapshotInfo> = snapshots.into_iter()
                            .map(|s| WireSnapshotInfo {
                                version: s.version,
                                created_at: s.created_at,
                                tags: s.tags,
                                total_nodes: s.stats.total_nodes,
                                total_edges: s.stats.total_edges,
                            })
                            .collect();
                        Response::SnapshotList { snapshots: wire_snapshots }
                    }
                    None => Response::ErrorWithCode {
                        error: "ListSnapshots requires v2 engine".to_string(),
                        code: "V2_REQUIRED".to_string(),
                    },
                }
            })
        }

        Request::DiffSnapshots { from_version, to_version } => {
            with_engine_read(session, |engine| {
                match engine.as_any().downcast_ref::<GraphEngineV2>() {
                    Some(v2) => {
                        match v2.diff_snapshots(from_version, to_version) {
                            Ok(diff) => Response::SnapshotDiffResult {
                                diff: WireSnapshotDiff {
                                    from_version: diff.from_version,
                                    to_version: diff.to_version,
                                    added_node_segments: diff.added_node_segments.len() as u64,
                                    removed_node_segments: diff.removed_node_segments.len() as u64,
                                    added_edge_segments: diff.added_edge_segments.len() as u64,
                                    removed_edge_segments: diff.removed_edge_segments.len() as u64,
                                    stats_from: WireManifestStats {
                                        total_nodes: diff.stats_from.total_nodes,
                                        total_edges: diff.stats_from.total_edges,
                                    },
                                    stats_to: WireManifestStats {
                                        total_nodes: diff.stats_to.total_nodes,
                                        total_edges: diff.stats_to.total_edges,
                                    },
                                },
                            },
                            Err(e) => Response::Error { error: e.to_string() },
                        }
                    }
                    None => Response::ErrorWithCode {
                        error: "DiffSnapshots requires v2 engine".to_string(),
                        code: "V2_REQUIRED".to_string(),
                    },
                }
            })
        }

        Request::QueryEdges { id, direction, edge_types, limit } => {
            with_engine_read(session, |engine| {
                let node_id = string_to_id(&id);
                let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());

                let mut edges: Vec<WireEdge> = match direction.as_str() {
                    "outgoing" => {
                        engine.get_outgoing_edges(node_id, edge_types_refs.as_deref())
                            .into_iter()
                            .map(|e| record_to_wire_edge(&e))
                            .collect()
                    }
                    "incoming" => {
                        engine.get_incoming_edges(node_id, edge_types_refs.as_deref())
                            .into_iter()
                            .map(|e| record_to_wire_edge(&e))
                            .collect()
                    }
                    "both" | _ => {
                        let mut all = engine.get_outgoing_edges(node_id, edge_types_refs.as_deref());
                        all.extend(engine.get_incoming_edges(node_id, edge_types_refs.as_deref()));
                        all.into_iter()
                            .map(|e| record_to_wire_edge(&e))
                            .collect()
                    }
                };

                if let Some(lim) = limit {
                    edges.truncate(lim as usize);
                }

                Response::Edges { edges }
            })
        }

        Request::FindDependentFiles { id, edge_types } => {
            with_engine_read(session, |engine| {
                let node_id = string_to_id(&id);
                let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());

                // Find incoming edges to this node — sources are dependents
                let incoming = engine.get_incoming_edges(node_id, edge_types_refs.as_deref());

                let mut files: HashSet<String> = HashSet::new();
                for edge in &incoming {
                    if let Some(node) = engine.get_node(edge.src) {
                        if let Some(ref file) = node.file {
                            files.insert(file.clone());
                        }
                    }
                }

                let mut files_vec: Vec<String> = files.into_iter().collect();
                files_vec.sort();

                Response::Files { files: files_vec }
            })
        }
    }
}

/// Handle CommitBatch: atomically replace nodes/edges for changed files.
///
/// Uses GraphStore trait methods (delete-then-add) which works correctly
/// for both v1 and v2 engines. The v2-native commit_batch path will be
/// activated when clients negotiate protocol v3 with semantic IDs.
///
/// When `file_context` is provided, the batch operates in enrichment mode:
/// - The file_context is added to `changed_files` so old enrichment edges
///   for that virtual file are tombstoned during deletion phase
/// - Each edge gets `__file_context` injected into its metadata via
///   `enrichment_edge_metadata()`
fn handle_commit_batch(
    engine: &mut dyn GraphStore,
    mut changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    file_context: Option<String>,
    defer_index: bool,
) -> Response {
    // If file_context is set, ensure it's included in changed_files
    // so the deletion phase tombstones old enrichment edges for this context.
    if let Some(ref ctx) = file_context {
        if !changed_files.contains(ctx) {
            changed_files.push(ctx.clone());
        }
    }

    let mut nodes_removed: u64 = 0;
    let mut edges_removed: u64 = 0;
    let mut changed_node_types: HashSet<String> = HashSet::new();
    let mut changed_edge_types: HashSet<String> = HashSet::new();
    let mut deleted_edge_keys: HashSet<(u128, u128, String)> = HashSet::new();

    for file in &changed_files {
        let attr_query = AttrQuery {
            version: None,
            node_type: None,
            file_id: None,
            file: Some(file.clone()),
            exported: None,
            name: None,
            metadata_filters: vec![],
        };
        let old_ids = engine.find_by_attr(&attr_query);

        for id in &old_ids {
            if let Some(node) = engine.get_node(*id) {
                if let Some(ref nt) = node.node_type {
                    changed_node_types.insert(nt.clone());
                }
            }

            for edge in engine.get_outgoing_edges(*id, None) {
                let edge_key = (edge.src, edge.dst, edge.edge_type.clone().unwrap_or_default());
                if deleted_edge_keys.insert(edge_key) {
                    if let Some(ref et) = edge.edge_type {
                        changed_edge_types.insert(et.clone());
                    }
                    engine.delete_edge(edge.src, edge.dst, edge.edge_type.as_deref().unwrap_or(""));
                    edges_removed += 1;
                }
            }

            for edge in engine.get_incoming_edges(*id, None) {
                let edge_key = (edge.src, edge.dst, edge.edge_type.clone().unwrap_or_default());
                if deleted_edge_keys.insert(edge_key) {
                    if let Some(ref et) = edge.edge_type {
                        changed_edge_types.insert(et.clone());
                    }
                    engine.delete_edge(edge.src, edge.dst, edge.edge_type.as_deref().unwrap_or(""));
                    edges_removed += 1;
                }
            }

            engine.delete_node(*id);
            nodes_removed += 1;
        }
    }

    let nodes_added = nodes.len() as u64;
    let edges_added = edges.len() as u64;

    for node in &nodes {
        if let Some(ref nt) = node.node_type {
            changed_node_types.insert(nt.clone());
        }
    }
    for edge in &edges {
        if let Some(ref et) = edge.edge_type {
            changed_edge_types.insert(et.clone());
        }
    }

    let node_records: Vec<NodeRecord> = nodes.into_iter().map(wire_node_to_record).collect();
    engine.add_nodes(node_records);

    // When file_context is set, inject __file_context into each edge's metadata
    let edge_records: Vec<EdgeRecord> = if let Some(ref ctx) = file_context {
        use rfdb::storage_v2::types::enrichment_edge_metadata;
        edges.into_iter().map(|edge| {
            let existing_metadata = edge.metadata.as_deref().unwrap_or("");
            let enriched = enrichment_edge_metadata(ctx, existing_metadata);
            let mut record = wire_edge_to_record(edge);
            record.metadata = Some(enriched);
            record
        }).collect()
    } else {
        edges.into_iter().map(wire_edge_to_record).collect()
    };
    engine.add_edges(edge_records, true);

    let flush_result = if defer_index {
        engine.flush_data_only()
    } else {
        engine.flush()
    };
    if let Err(e) = flush_result {
        return Response::Error { error: format!("Flush failed during commit: {}", e) };
    }

    let delta = WireCommitDelta {
        changed_files,
        nodes_added,
        nodes_removed,
        edges_added,
        edges_removed,
        changed_node_types: changed_node_types.into_iter().collect(),
        changed_edge_types: changed_edge_types.into_iter().collect(),
    };

    Response::BatchCommitted { ok: true, delta }
}

/// Helper: execute read operation on current database
fn with_engine_read<F>(session: &ClientSession, f: F) -> Response
where
    F: FnOnce(&dyn GraphStore) -> Response,
{
    match &session.current_db {
        Some(db) => {
            let engine = db.engine.read().unwrap();
            f(&**engine)
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
    F: FnOnce(&mut dyn GraphStore) -> Response,
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
            f(&mut **engine)
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
    engine: &dyn GraphStore,
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
    _engine: &dyn GraphStore,
    source: &str,
) -> std::result::Result<u32, String> {
    let program = parse_program(source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    Ok(program.rules().len() as u32)
}

/// Execute a datalog query
fn execute_datalog_query(
    engine: &dyn GraphStore,
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

/// Execute unified Datalog — auto-detects rules vs direct query.
///
/// If the source parses as a program with rules, load the rules and query
/// using the head predicate of the first rule. Otherwise, fall back to
/// parsing as a direct query.
fn execute_datalog(
    engine: &dyn GraphStore,
    source: &str,
) -> std::result::Result<Vec<WireViolation>, String> {
    // Try parsing as a program first
    if let Ok(program) = parse_program(source) {
        if !program.rules().is_empty() {
            let mut evaluator = Evaluator::new(engine);

            for rule in program.rules() {
                evaluator.add_rule(rule.clone());
            }

            // Query using the head atom of the first rule
            let head = program.rules()[0].head();
            let bindings = evaluator.query(head);

            let results: Vec<WireViolation> = bindings.into_iter()
                .map(|b| {
                    let mut map = std::collections::HashMap::new();
                    for (k, v) in b.iter() {
                        map.insert(k.clone(), v.as_str());
                    }
                    WireViolation { bindings: map }
                })
                .collect();

            return Ok(results);
        }
    }

    // Fall back to direct query
    let literals = parse_query(source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

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
// Streaming Support
// ============================================================================

/// Result of handling a request.
///
/// `Single(Response)` — the caller serializes and writes one response frame.
/// `Streamed` — the handler already wrote multiple frames directly to the stream.
#[derive(Debug)]
enum HandleResult {
    Single(Response),
    Streamed,
}

/// Handle QueryNodes with streaming: write multiple NodesChunk frames
/// directly to the stream when the result set exceeds the threshold
/// and the client negotiated protocol v3+.
///
/// Returns `HandleResult::Streamed` on success (chunks written),
/// or `HandleResult::Single(response)` for small results or errors.
fn handle_query_nodes_streaming(
    session: &ClientSession,
    query: WireAttrQuery,
    request_id: &Option<String>,
    stream: &mut UnixStream,
) -> HandleResult {
    let db = match &session.current_db {
        Some(db) => db,
        None => return HandleResult::Single(Response::ErrorWithCode {
            error: "No database selected. Use openDatabase first.".to_string(),
            code: "NO_DATABASE_SELECTED".to_string(),
        }),
    };

    let engine = db.engine.read().unwrap();

    // Build AttrQuery from wire format (same as non-streaming path)
    let metadata_filters: Vec<(String, String)> = query.extra.into_iter()
        .filter_map(|(k, v)| {
            match v {
                serde_json::Value::String(s) => Some((k, s)),
                serde_json::Value::Bool(b) => Some((k, b.to_string())),
                serde_json::Value::Number(n) => Some((k, n.to_string())),
                _ => None,
            }
        })
        .collect();

    let attr_query = AttrQuery {
        version: None,
        node_type: query.node_type,
        file_id: None,
        file: query.file,
        exported: query.exported,
        name: query.name,
        metadata_filters,
    };

    let ids = engine.find_by_attr(&attr_query);
    let total = ids.len();

    // Below threshold: single response (existing behavior)
    if total <= STREAMING_THRESHOLD {
        let nodes: Vec<WireNode> = ids.into_iter()
            .filter_map(|id| engine.get_node(id))
            .map(|r| record_to_wire_node(&r))
            .collect();
        return HandleResult::Single(Response::Nodes { nodes });
    }

    // Streaming path: send chunks
    let mut chunk_index: u32 = 0;
    let num_chunks = (total + STREAMING_CHUNK_SIZE - 1) / STREAMING_CHUNK_SIZE;

    for chunk_ids in ids.chunks(STREAMING_CHUNK_SIZE) {
        let nodes: Vec<WireNode> = chunk_ids.iter()
            .filter_map(|&id| engine.get_node(id))
            .map(|r| record_to_wire_node(&r))
            .collect();

        let is_last = (chunk_index as usize + 1) >= num_chunks;
        let response = Response::NodesChunk {
            nodes,
            done: is_last,
            chunk_index,
        };

        let envelope = ResponseEnvelope {
            request_id: request_id.clone(),
            response,
        };

        let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("[rfdb-server] Serialize error during streaming: {}", e);
                return HandleResult::Streamed;
            }
        };

        if let Err(e) = write_message(stream, &resp_bytes) {
            eprintln!("[rfdb-server] Write error during streaming (implicit cancel): {}", e);
            return HandleResult::Streamed;
        }

        chunk_index += 1;
    }

    HandleResult::Streamed
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

        let (request_id, request) = match rmp_serde::from_slice::<RequestEnvelope>(&msg) {
            Ok(env) => (env.request_id, env.request),
            Err(e) => {
                let envelope = ResponseEnvelope {
                    request_id: None,
                    response: Response::Error { error: format!("Invalid request: {}", e) },
                };
                let resp_bytes = rmp_serde::to_vec_named(&envelope).unwrap();
                let _ = write_message(&mut stream, &resp_bytes);
                continue;
            }
        };

        let is_shutdown = matches!(request, Request::Shutdown);

        // Time the request for metrics
        let start = Instant::now();
        let op_name = get_operation_name(&request);

        // Streaming commands: handle directly (need stream access for multi-frame writes).
        // Only stream when client negotiated protocol v3+.
        let handle_result = match request {
            Request::QueryNodes { query } if session.protocol_version >= 3 => {
                handle_query_nodes_streaming(&session, query, &request_id, &mut stream)
            }
            other => {
                HandleResult::Single(handle_request(&manager, &mut session, other, &metrics))
            }
        };

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

        // For Single responses, serialize and write the frame.
        // Streamed responses were already written by the handler.
        match handle_result {
            HandleResult::Single(response) => {
                let envelope = ResponseEnvelope { request_id, response };

                let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
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
            }
            HandleResult::Streamed => {
                // Handler already wrote frames directly to stream
            }
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
    eprintln!("[rfdb-server] Starting rfdb-server v{}", env!("CARGO_PKG_VERSION"));
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
                assert_eq!(protocol_version, 3);
                assert!(!server_version.is_empty());
                assert!(features.contains(&"multiDatabase".to_string()));
                assert!(features.contains(&"ephemeral".to_string()));
                assert!(features.contains(&"semanticIds".to_string()));
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
            semantic_id: None,
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

    // ============================================================================
    // FindByAttr with Metadata Filters
    // ============================================================================

    #[test]
    fn test_find_by_attr_with_metadata_filters() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        // Create ephemeral database
        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: true,
        }, &None);

        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Add nodes with metadata
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "1".to_string(),
                    node_type: Some("CALL".to_string()),
                    name: Some("app.get".to_string()),
                    file: Some("app.js".to_string()),
                    exported: false,
                    metadata: Some(r#"{"object":"express","method":"get"}"#.to_string()),
                    semantic_id: None,
                },
                WireNode {
                    id: "2".to_string(),
                    node_type: Some("CALL".to_string()),
                    name: Some("app.post".to_string()),
                    file: Some("app.js".to_string()),
                    exported: false,
                    metadata: Some(r#"{"object":"express","method":"post"}"#.to_string()),
                    semantic_id: None,
                },
                WireNode {
                    id: "3".to_string(),
                    node_type: Some("CALL".to_string()),
                    name: Some("db.query".to_string()),
                    file: Some("db.js".to_string()),
                    exported: false,
                    metadata: Some(r#"{"object":"knex","method":"query"}"#.to_string()),
                    semantic_id: None,
                },
            ],
        }, &None);

        // findByAttr with extra field "object"="express" via WireAttrQuery
        let mut extra = std::collections::HashMap::new();
        extra.insert("object".to_string(), serde_json::Value::String("express".to_string()));

        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: Some("CALL".to_string()),
                name: None,
                file: None,
                exported: None,
                extra,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 2, "Should find 2 express CALL nodes");
            }
            _ => panic!("Expected Ids response"),
        }

        // findByAttr with two extra fields: object=express AND method=get
        let mut extra = std::collections::HashMap::new();
        extra.insert("object".to_string(), serde_json::Value::String("express".to_string()));
        extra.insert("method".to_string(), serde_json::Value::String("get".to_string()));

        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: Some("CALL".to_string()),
                name: None,
                file: None,
                exported: None,
                extra,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1, "Should find only GET handler");
            }
            _ => panic!("Expected Ids response"),
        }

        // findByAttr with no extra fields (backwards compatible)
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: Some("CALL".to_string()),
                name: None,
                file: None,
                exported: None,
                extra: std::collections::HashMap::new(),
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 3, "Without metadata filter, all 3 CALL nodes");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    #[test]
    fn test_declare_fields_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        // Create and open ephemeral database
        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: true,
        }, &None);

        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Declare fields
        let response = handle_request(&manager, &mut session, Request::DeclareFields {
            fields: vec![
                WireFieldDecl { name: "object".to_string(), field_type: Some("string".to_string()), node_types: None },
                WireFieldDecl { name: "method".to_string(), field_type: Some("string".to_string()), node_types: None },
            ],
        }, &None);

        match response {
            Response::Count { count } => {
                assert_eq!(count, 2, "Should report 2 declared fields");
            }
            _ => panic!("Expected Count response"),
        }

        // Add nodes with metadata
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "1".to_string(),
                    node_type: Some("CALL".to_string()),
                    name: Some("app.get".to_string()),
                    file: None,
                    exported: false,
                    metadata: Some(r#"{"object":"express","method":"get"}"#.to_string()),
                    semantic_id: None,
                },
                WireNode {
                    id: "2".to_string(),
                    node_type: Some("CALL".to_string()),
                    name: Some("app.post".to_string()),
                    file: None,
                    exported: false,
                    metadata: Some(r#"{"object":"express","method":"post"}"#.to_string()),
                    semantic_id: None,
                },
            ],
        }, &None);

        // Flush to build field indexes
        handle_request(&manager, &mut session, Request::Flush, &None);

        // Query using field-indexed metadata filter
        let mut extra = std::collections::HashMap::new();
        extra.insert("object".to_string(), serde_json::Value::String("express".to_string()));

        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: Some("CALL".to_string()),
                name: None,
                file: None,
                exported: None,
                extra,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 2, "Should find 2 express CALL nodes via field index");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    // ============================================================================
    // CommitBatch Command
    // ============================================================================

    /// Helper: create and open an ephemeral database for testing
    fn setup_ephemeral_db(manager: &Arc<DatabaseManager>, session: &mut ClientSession, name: &str) {
        handle_request(manager, session, Request::CreateDatabase {
            name: name.to_string(),
            ephemeral: true,
        }, &None);
        handle_request(manager, session, Request::OpenDatabase {
            name: name.to_string(),
            mode: "rw".to_string(),
        }, &None);
    }

    #[test]
    fn test_commit_batch_replaces_nodes() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "batchdb");

        // Add initial nodes for "app.js"
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "1".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("foo".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "2".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("bar".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::Flush, &None);

        // CommitBatch with new nodes for same file
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["app.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "3".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("baz".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: false,
        }, &None);

        // Verify delta
        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 2);
                assert_eq!(delta.nodes_added, 1);
                assert_eq!(delta.changed_files, vec!["app.js".to_string()]);
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // Verify old nodes are gone, new node exists
        let old1 = handle_request(&manager, &mut session, Request::NodeExists { id: "1".to_string() }, &None);
        match old1 { Response::Bool { value } => assert!(!value), _ => panic!("Expected Bool") }

        let new1 = handle_request(&manager, &mut session, Request::NodeExists { id: "3".to_string() }, &None);
        match new1 { Response::Bool { value } => assert!(value), _ => panic!("Expected Bool") }
    }

    #[test]
    fn test_commit_batch_delta_counts() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "batchdb2");

        // Add nodes and edges
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "n1".to_string(), node_type: Some("MODULE".to_string()), name: Some("m1".to_string()), file: Some("src/a.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "n2".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("f1".to_string()), file: Some("src/a.js".to_string()), exported: true, metadata: None },
                WireNode { semantic_id: None, id: "n3".to_string(), node_type: Some("MODULE".to_string()), name: Some("m2".to_string()), file: Some("src/b.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "n1".to_string(), dst: "n2".to_string(), edge_type: Some("CONTAINS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);
        handle_request(&manager, &mut session, Request::Flush, &None);

        // CommitBatch replacing only src/a.js
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["src/a.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "n4".to_string(), node_type: Some("MODULE".to_string()), name: Some("m1v2".to_string()), file: Some("src/a.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: false,
        }, &None);

        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 2, "Old n1 and n2 should be removed");
                assert_eq!(delta.nodes_added, 1, "n4 added");
                assert_eq!(delta.edges_removed, 1, "n1->n2 CONTAINS edge removed");
                assert_eq!(delta.edges_added, 0);
                assert!(delta.changed_node_types.contains(&"MODULE".to_string()));
                assert!(delta.changed_node_types.contains(&"FUNCTION".to_string()));
                assert!(delta.changed_edge_types.contains(&"CONTAINS".to_string()));
            }
            _ => panic!("Expected BatchCommitted"),
        }

        // Verify src/b.js node untouched
        let n3 = handle_request(&manager, &mut session, Request::NodeExists { id: "n3".to_string() }, &None);
        match n3 { Response::Bool { value } => assert!(value, "n3 in b.js should still exist"), _ => panic!("Expected Bool") }
    }

    #[test]
    fn test_commit_batch_empty_changed_files() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "batchdb3");

        // CommitBatch with no changed files — just adds
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec![],
            nodes: vec![
                WireNode { semantic_id: None, id: "x1".to_string(), node_type: Some("VARIABLE".to_string()), name: Some("x".to_string()), file: Some("new.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: false,
        }, &None);

        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 0);
                assert_eq!(delta.nodes_added, 1);
            }
            _ => panic!("Expected BatchCommitted"),
        }

        // Verify node was added
        let exists = handle_request(&manager, &mut session, Request::NodeExists { id: "x1".to_string() }, &None);
        match exists { Response::Bool { value } => assert!(value), _ => panic!("Expected Bool") }
    }

    /// Non-ephemeral test: verifies segment edge deletion survives flush.
    /// This exercises the deleted_segment_edge_keys path in GraphEngine.
    #[test]
    fn test_commit_batch_segment_edge_deletion() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        // Create a NON-ephemeral database (data goes to disk segments on flush)
        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "segtest".to_string(),
            ephemeral: false,
        }, &None);
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "segtest".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Add nodes and edges, then flush to segments
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "s1".to_string(), node_type: Some("MODULE".to_string()), name: Some("mod_a".to_string()), file: Some("a.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "s2".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("func_b".to_string()), file: Some("a.js".to_string()), exported: true, metadata: None },
                WireNode { semantic_id: None, id: "s3".to_string(), node_type: Some("MODULE".to_string()), name: Some("mod_c".to_string()), file: Some("c.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "s1".to_string(), dst: "s2".to_string(), edge_type: Some("CONTAINS".to_string()), metadata: None },
                WireEdge { src: "s3".to_string(), dst: "s1".to_string(), edge_type: Some("IMPORTS_FROM".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);

        // Flush — nodes and edges are now in segment (on-disk), not in delta
        handle_request(&manager, &mut session, Request::Flush, &None);

        // CommitBatch replacing a.js — should delete segment edges too
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["a.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "s4".to_string(), node_type: Some("MODULE".to_string()), name: Some("mod_a_v2".to_string()), file: Some("a.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: false,
        }, &None);

        // Verify delta counts
        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 2, "s1 and s2 should be removed");
                assert_eq!(delta.nodes_added, 1, "s4 added");
                assert_eq!(delta.edges_removed, 2, "s1->s2 and s3->s1 edges removed");
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // Verify old edges are actually gone (not just claimed to be removed)
        let edges = handle_request(&manager, &mut session, Request::GetAllEdges, &None);
        match edges {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 0, "All edges should be gone after commit batch");
            }
            _ => panic!("Expected Edges"),
        }

        // Verify countEdgesByType also reflects deletion
        let counts = handle_request(&manager, &mut session, Request::CountEdgesByType { edge_types: None }, &None);
        match counts {
            Response::Counts { counts } => {
                let total: usize = counts.values().sum();
                assert_eq!(total, 0, "countEdgesByType should return 0 after deletion");
            }
            _ => panic!("Expected Counts"),
        }

        // Flush again — edges must stay gone (not reappear from segment)
        handle_request(&manager, &mut session, Request::Flush, &None);

        let edges_after_flush = handle_request(&manager, &mut session, Request::GetAllEdges, &None);
        match edges_after_flush {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 0, "Edges must not reappear after second flush");
            }
            _ => panic!("Expected Edges"),
        }

        // Verify s3 (c.js) still exists, s1/s2 are gone
        let s3_exists = handle_request(&manager, &mut session, Request::NodeExists { id: "s3".to_string() }, &None);
        match s3_exists { Response::Bool { value } => assert!(value, "s3 in c.js should still exist"), _ => panic!("Expected Bool") }

        let s1_exists = handle_request(&manager, &mut session, Request::NodeExists { id: "s1".to_string() }, &None);
        match s1_exists { Response::Bool { value } => assert!(!value, "s1 should be deleted"), _ => panic!("Expected Bool") }
    }

    /// Test that shared edges between two nodes in changedFiles are not double-counted.
    #[test]
    fn test_commit_batch_shared_edge_dedup() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "dedupdb");

        // Two nodes in different files, connected by an edge
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "d1".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("a".to_string()), file: Some("x.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "d2".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("b".to_string()), file: Some("y.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "d1".to_string(), dst: "d2".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);

        // CommitBatch replacing BOTH files — the shared edge should be counted once
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["x.js".to_string(), "y.js".to_string()],
            nodes: vec![],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: false,
        }, &None);

        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.edges_removed, 1, "Shared edge should be counted exactly once");
                assert_eq!(delta.nodes_removed, 2);
            }
            _ => panic!("Expected BatchCommitted"),
        }
    }

    // ============================================================================
    // CommitBatch with file_context (enrichment virtual shards)
    // ============================================================================

    #[test]
    fn test_commit_batch_wire_with_file_context() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "enrichdb");

        // Add two nodes that edges will connect
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "e1".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("src_fn".to_string()), file: Some("src/app.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "e2".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("dst_fn".to_string()), file: Some("src/lib.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::Flush, &None);

        let file_ctx = "__enrichment__/data-flow/src/app.js".to_string();

        // CommitBatch with file_context — edges should get __file_context injected
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec![],
            nodes: vec![],
            edges: vec![
                WireEdge { src: "e1".to_string(), dst: "e2".to_string(), edge_type: Some("DATA_FLOW".to_string()), metadata: None },
            ],
            tags: None,
            file_context: Some(file_ctx.clone()),
            defer_index: false,
        }, &None);

        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.edges_added, 1);
                // file_context should be added to changed_files
                assert!(delta.changed_files.contains(&file_ctx));
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // Verify the edge has __file_context in its metadata
        let edges_resp = handle_request(&manager, &mut session, Request::GetAllEdges, &None);
        match edges_resp {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 1);
                let meta = edges[0].metadata.as_ref().expect("Edge should have metadata");
                let parsed: serde_json::Value = serde_json::from_str(meta).unwrap();
                assert_eq!(parsed["__file_context"], file_ctx);
            }
            _ => panic!("Expected Edges"),
        }

        // Re-send with same file_context but different edge — old edge should be gone
        // (The file_context virtual file has no real nodes, so the delete-by-file phase
        //  won't find them, but the enrichment tombstoning mechanism works at storage
        //  level when commit_batch is used. For the GraphStore trait path, the
        //  file_context in changed_files triggers node lookup which finds nothing,
        //  so we verify the new edges are added correctly.)
        let response2 = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec![],
            nodes: vec![],
            edges: vec![
                WireEdge { src: "e2".to_string(), dst: "e1".to_string(), edge_type: Some("DATA_FLOW_REVERSE".to_string()), metadata: Some(r#"{"weight": 5}"#.to_string()) },
            ],
            tags: None,
            file_context: Some(file_ctx.clone()),
            defer_index: false,
        }, &None);

        match response2 {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.edges_added, 1);
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response2),
        }

        // Verify the new edge preserves existing metadata AND has __file_context
        let edges_resp2 = handle_request(&manager, &mut session, Request::GetAllEdges, &None);
        match edges_resp2 {
            Response::Edges { edges } => {
                // Find the new edge (e2->e1)
                let new_edge = edges.iter().find(|e| e.edge_type.as_deref() == Some("DATA_FLOW_REVERSE"));
                assert!(new_edge.is_some(), "New enrichment edge should exist");
                let meta = new_edge.unwrap().metadata.as_ref().expect("Edge should have metadata");
                let parsed: serde_json::Value = serde_json::from_str(meta).unwrap();
                assert_eq!(parsed["__file_context"], file_ctx);
                assert_eq!(parsed["weight"], 5, "Existing metadata should be preserved");
            }
            _ => panic!("Expected Edges"),
        }
    }

    #[test]
    fn test_commit_batch_wire_backward_compat() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "compatdb");

        // Add initial nodes
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "c1".to_string(), node_type: Some("MODULE".to_string()), name: Some("mod1".to_string()), file: Some("index.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "c2".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("fn1".to_string()), file: Some("index.js".to_string()), exported: true, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::Flush, &None);

        // CommitBatch WITHOUT file_context — existing behavior, no __file_context injection
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["index.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "c3".to_string(), node_type: Some("MODULE".to_string()), name: Some("mod1v2".to_string()), file: Some("index.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![
                WireEdge { src: "c3".to_string(), dst: "c3".to_string(), edge_type: Some("SELF_REF".to_string()), metadata: Some(r#"{"info":"test"}"#.to_string()) },
            ],
            tags: None,
            file_context: None,
            defer_index: false,
        }, &None);

        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 2, "Old c1 and c2 removed");
                assert_eq!(delta.nodes_added, 1, "c3 added");
                assert_eq!(delta.edges_added, 1);
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // Verify edge metadata does NOT have __file_context
        let edges_resp = handle_request(&manager, &mut session, Request::GetAllEdges, &None);
        match edges_resp {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 1);
                let meta = edges[0].metadata.as_ref().expect("Edge should have metadata");
                let parsed: serde_json::Value = serde_json::from_str(meta).unwrap();
                assert!(parsed.get("__file_context").is_none(), "No __file_context should be injected without file_context param");
                assert_eq!(parsed["info"], "test", "Original metadata should be preserved");
            }
            _ => panic!("Expected Edges"),
        }

        // Verify node replacement worked
        let c1 = handle_request(&manager, &mut session, Request::NodeExists { id: "c1".to_string() }, &None);
        match c1 { Response::Bool { value } => assert!(!value, "c1 should be gone"), _ => panic!("Expected Bool") }

        let c3 = handle_request(&manager, &mut session, Request::NodeExists { id: "c3".to_string() }, &None);
        match c3 { Response::Bool { value } => assert!(value, "c3 should exist"), _ => panic!("Expected Bool") }
    }

    // ============================================================================
    // BeginBatch / AbortBatch Commands
    // ============================================================================

    #[test]
    fn test_begin_batch() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let response = handle_request(&manager, &mut session, Request::BeginBatch, &None);

        match response {
            Response::BatchStarted { ok, batch_id } => {
                assert!(ok);
                assert!(!batch_id.is_empty());
                assert!(session.pending_batch_id.is_some());
            }
            _ => panic!("Expected BatchStarted response"),
        }
    }

    #[test]
    fn test_begin_batch_already_in_progress() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        // Start first batch
        handle_request(&manager, &mut session, Request::BeginBatch, &None);

        // Try to start second batch
        let response = handle_request(&manager, &mut session, Request::BeginBatch, &None);

        match response {
            Response::Error { error } => {
                assert!(error.contains("already in progress"));
            }
            _ => panic!("Expected Error response"),
        }
    }

    #[test]
    fn test_abort_batch() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        // Start batch
        handle_request(&manager, &mut session, Request::BeginBatch, &None);
        assert!(session.pending_batch_id.is_some());

        // Abort it
        let response = handle_request(&manager, &mut session, Request::AbortBatch, &None);

        match response {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok response"),
        }
        assert!(session.pending_batch_id.is_none());
    }

    #[test]
    fn test_abort_batch_none_pending() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let response = handle_request(&manager, &mut session, Request::AbortBatch, &None);

        match response {
            Response::Error { error } => {
                assert!(error.contains("No batch"));
            }
            _ => panic!("Expected Error response"),
        }
    }

    // ============================================================================
    // Snapshot Commands (v2 engine only)
    // ============================================================================

    /// Helper: create and open an ephemeral v2 database for testing
    fn setup_v2_ephemeral_db(manager: &Arc<DatabaseManager>, session: &mut ClientSession, name: &str) {
        // Ephemeral databases created via DatabaseManager use v2 engine
        handle_request(manager, session, Request::CreateDatabase {
            name: name.to_string(),
            ephemeral: true,
        }, &None);
        handle_request(manager, session, Request::OpenDatabase {
            name: name.to_string(),
            mode: "rw".to_string(),
        }, &None);
    }

    #[test]
    fn test_list_snapshots_v2() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_v2_ephemeral_db(&manager, &mut session, "snap_test");

        let response = handle_request(&manager, &mut session, Request::ListSnapshots {
            filter_tag: None,
        }, &None);

        match response {
            Response::SnapshotList { snapshots } => {
                // Ephemeral v2 engine may have 0 or 1 snapshots depending on impl
                // The important thing is it doesn't error
                assert!(snapshots.len() <= 1);
            }
            _ => panic!("Expected SnapshotList response, got {:?}", response),
        }
    }

    #[test]
    fn test_find_snapshot_v2() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_v2_ephemeral_db(&manager, &mut session, "snap_find_test");

        // Find non-existent snapshot
        let response = handle_request(&manager, &mut session, Request::FindSnapshot {
            tag_key: "name".to_string(),
            tag_value: "nonexistent".to_string(),
        }, &None);

        match response {
            Response::SnapshotVersion { version } => {
                assert!(version.is_none());
            }
            _ => panic!("Expected SnapshotVersion response, got {:?}", response),
        }
    }

    #[test]
    fn test_snapshot_ops_on_v1_engine() {
        let dir = tempdir().unwrap();
        let manager = Arc::new(DatabaseManager::new(dir.path().to_path_buf()));

        // Create a v1 database by placing a nodes.bin marker
        let v1_path = dir.path().join("default.rfdb");
        std::fs::create_dir_all(&v1_path).unwrap();
        // Create a v1 engine and flush to produce nodes.bin
        let mut v1_engine = GraphEngine::create(&v1_path).unwrap();
        // Add a dummy node so flush writes nodes.bin
        v1_engine.add_nodes(vec![NodeRecord {
            id: 1,
            node_type: Some("DUMMY".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("dummy".to_string()),
            file: Some("dummy.js".to_string()),
            metadata: None,
        semantic_id: None,
        }]);
        v1_engine.flush().unwrap();
        // Drop v1_engine so the file is not locked
        drop(v1_engine);

        // Now create default from this path — detects nodes.bin and uses v1
        manager.create_default_from_path(&v1_path).unwrap();

        let mut session = ClientSession::new(1);
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "default".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // ListSnapshots should return V2_REQUIRED error
        let response = handle_request(&manager, &mut session, Request::ListSnapshots {
            filter_tag: None,
        }, &None);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("v2 engine"));
                assert_eq!(code, "V2_REQUIRED");
            }
            _ => panic!("Expected ErrorWithCode response, got {:?}", response),
        }

        // FindSnapshot should also return V2_REQUIRED error
        let response = handle_request(&manager, &mut session, Request::FindSnapshot {
            tag_key: "name".to_string(),
            tag_value: "test".to_string(),
        }, &None);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("v2 engine"));
                assert_eq!(code, "V2_REQUIRED");
            }
            _ => panic!("Expected ErrorWithCode response, got {:?}", response),
        }
    }

    // ============================================================================
    // QueryEdges Command
    // ============================================================================

    #[test]
    fn test_query_edges_outgoing() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "qe_test");

        // Add nodes and edges
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "a".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("a".to_string()), file: Some("a.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "b".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("b".to_string()), file: Some("b.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "c".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("c".to_string()), file: Some("c.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "a".to_string(), dst: "b".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
                WireEdge { src: "a".to_string(), dst: "c".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
                WireEdge { src: "b".to_string(), dst: "a".to_string(), edge_type: Some("IMPORTS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);

        // Query outgoing edges from "a"
        let response = handle_request(&manager, &mut session, Request::QueryEdges {
            id: "a".to_string(),
            direction: "outgoing".to_string(),
            edge_types: None,
            limit: None,
        }, &None);

        match response {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 2, "Node 'a' should have 2 outgoing edges");
            }
            _ => panic!("Expected Edges response"),
        }
    }

    #[test]
    fn test_query_edges_incoming() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "qe_in_test");

        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "a".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("a".to_string()), file: Some("a.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "b".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("b".to_string()), file: Some("b.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "b".to_string(), dst: "a".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);

        let response = handle_request(&manager, &mut session, Request::QueryEdges {
            id: "a".to_string(),
            direction: "incoming".to_string(),
            edge_types: None,
            limit: None,
        }, &None);

        match response {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 1, "Node 'a' should have 1 incoming edge");
            }
            _ => panic!("Expected Edges response"),
        }
    }

    #[test]
    fn test_query_edges_both_with_limit() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "qe_both_test");

        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "a".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("a".to_string()), file: Some("a.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "b".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("b".to_string()), file: Some("b.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "c".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("c".to_string()), file: Some("c.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "a".to_string(), dst: "b".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
                WireEdge { src: "c".to_string(), dst: "a".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);

        // Query both directions with limit=1
        let response = handle_request(&manager, &mut session, Request::QueryEdges {
            id: "a".to_string(),
            direction: "both".to_string(),
            edge_types: None,
            limit: Some(1),
        }, &None);

        match response {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 1, "Limit should truncate to 1 edge");
            }
            _ => panic!("Expected Edges response"),
        }
    }

    #[test]
    fn test_query_edges_with_type_filter() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "qe_filter_test");

        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "a".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("a".to_string()), file: Some("a.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "b".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("b".to_string()), file: Some("b.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "a".to_string(), dst: "b".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
                WireEdge { src: "a".to_string(), dst: "b".to_string(), edge_type: Some("IMPORTS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);

        // Filter by CALLS only
        let response = handle_request(&manager, &mut session, Request::QueryEdges {
            id: "a".to_string(),
            direction: "outgoing".to_string(),
            edge_types: Some(vec!["CALLS".to_string()]),
            limit: None,
        }, &None);

        match response {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 1, "Should only return CALLS edges");
                assert_eq!(edges[0].edge_type.as_deref(), Some("CALLS"));
            }
            _ => panic!("Expected Edges response"),
        }
    }

    // ============================================================================
    // FindDependentFiles Command
    // ============================================================================

    #[test]
    fn test_find_dependent_files() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "dep_test");

        // Create a graph: a.js -> target.js, b.js -> target.js
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "target".to_string(), node_type: Some("MODULE".to_string()), name: Some("target".to_string()), file: Some("target.js".to_string()), exported: true, metadata: None },
                WireNode { semantic_id: None, id: "dep1".to_string(), node_type: Some("MODULE".to_string()), name: Some("dep1".to_string()), file: Some("a.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "dep2".to_string(), node_type: Some("MODULE".to_string()), name: Some("dep2".to_string()), file: Some("b.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "unrelated".to_string(), node_type: Some("MODULE".to_string()), name: Some("unrelated".to_string()), file: Some("c.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "dep1".to_string(), dst: "target".to_string(), edge_type: Some("IMPORTS".to_string()), metadata: None },
                WireEdge { src: "dep2".to_string(), dst: "target".to_string(), edge_type: Some("IMPORTS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);

        let response = handle_request(&manager, &mut session, Request::FindDependentFiles {
            id: "target".to_string(),
            edge_types: None,
        }, &None);

        match response {
            Response::Files { files } => {
                assert_eq!(files.len(), 2);
                assert!(files.contains(&"a.js".to_string()));
                assert!(files.contains(&"b.js".to_string()));
                // Should NOT contain c.js (unrelated)
                assert!(!files.contains(&"c.js".to_string()));
            }
            _ => panic!("Expected Files response"),
        }
    }

    #[test]
    fn test_find_dependent_files_with_edge_type_filter() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "dep_filter_test");

        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "target".to_string(), node_type: Some("MODULE".to_string()), name: Some("target".to_string()), file: Some("target.js".to_string()), exported: true, metadata: None },
                WireNode { semantic_id: None, id: "importer".to_string(), node_type: Some("MODULE".to_string()), name: Some("importer".to_string()), file: Some("imp.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "caller".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("caller".to_string()), file: Some("call.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                WireEdge { src: "importer".to_string(), dst: "target".to_string(), edge_type: Some("IMPORTS".to_string()), metadata: None },
                WireEdge { src: "caller".to_string(), dst: "target".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);

        // Only find IMPORTS dependents
        let response = handle_request(&manager, &mut session, Request::FindDependentFiles {
            id: "target".to_string(),
            edge_types: Some(vec!["IMPORTS".to_string()]),
        }, &None);

        match response {
            Response::Files { files } => {
                assert_eq!(files.len(), 1);
                assert!(files.contains(&"imp.js".to_string()));
                // call.js uses CALLS edge, should not be included
                assert!(!files.contains(&"call.js".to_string()));
            }
            _ => panic!("Expected Files response"),
        }
    }

    #[test]
    fn test_find_dependent_files_no_deps() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "dep_empty_test");

        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "lonely".to_string(), node_type: Some("MODULE".to_string()), name: Some("lonely".to_string()), file: Some("lonely.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);

        let response = handle_request(&manager, &mut session, Request::FindDependentFiles {
            id: "lonely".to_string(),
            edge_types: None,
        }, &None);

        match response {
            Response::Files { files } => {
                assert!(files.is_empty(), "Node with no incoming edges should have no dependent files");
            }
            _ => panic!("Expected Files response"),
        }
    }

    // ============================================================================
    // Backward Compatibility Stubs
    // ============================================================================

    #[test]
    fn test_update_node_version_noop() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "compat_test");

        let response = handle_request(&manager, &mut session, Request::UpdateNodeVersion {
            id: "1".to_string(),
            version: "v2".to_string(),
        }, &None);

        match response {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok response for UpdateNodeVersion stub"),
        }
    }

    #[test]
    fn test_compact_noop() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "compact_test");

        let response = handle_request(&manager, &mut session, Request::Compact, &None);

        match response {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok response for Compact"),
        }
    }

    // ============================================================================
    // Streaming (Protocol v3+)
    // ============================================================================

    /// Helper: add N nodes of the given type to the session's database.
    fn add_n_nodes(manager: &Arc<DatabaseManager>, session: &mut ClientSession, n: usize, node_type: &str) {
        // Add in batches to keep individual requests reasonable
        let batch_size = 500;
        for start in (0..n).step_by(batch_size) {
            let end = std::cmp::min(start + batch_size, n);
            let nodes: Vec<WireNode> = (start..end)
                .map(|i| WireNode {
                    id: format!("n{}", i),
                    semantic_id: None,
                    node_type: Some(node_type.to_string()),
                    name: Some(format!("node_{}", i)),
                    file: None,
                    exported: false,
                    metadata: None,
                })
                .collect();
            handle_request(manager, session, Request::AddNodes { nodes }, &None);
        }
    }

    #[test]
    fn test_hello_features_includes_streaming() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let response = handle_request(&manager, &mut session, Request::Hello {
            protocol_version: Some(3),
            client_id: Some("streaming-test".to_string()),
        }, &None);

        match response {
            Response::HelloOk { features, protocol_version, .. } => {
                assert_eq!(protocol_version, 3);
                assert!(features.contains(&"streaming".to_string()),
                    "Hello features must include 'streaming', got: {:?}", features);
            }
            _ => panic!("Expected HelloOk response"),
        }
    }

    #[test]
    fn test_streaming_below_threshold_returns_single() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "stream_small");
        session.protocol_version = 3;

        // Add exactly STREAMING_THRESHOLD nodes (should NOT stream)
        add_n_nodes(&manager, &mut session, STREAMING_THRESHOLD, "FUNCTION");

        let (mut writer, _reader) = UnixStream::pair().unwrap();

        let query = WireAttrQuery {
            node_type: Some("FUNCTION".to_string()),
            name: None,
            file: None,
            exported: None,
            extra: HashMap::new(),
        };

        let result = handle_query_nodes_streaming(&session, query, &None, &mut writer);

        match result {
            HandleResult::Single(Response::Nodes { nodes }) => {
                assert_eq!(nodes.len(), STREAMING_THRESHOLD,
                    "At threshold, should return single response with all {} nodes", STREAMING_THRESHOLD);
            }
            HandleResult::Single(other) => panic!("Expected Nodes response, got: {:?}", other),
            HandleResult::Streamed => panic!("Should not stream at threshold ({} nodes)", STREAMING_THRESHOLD),
        }
    }

    /// Helper: read a chunk frame from a UnixStream and return (nodes_count, done, chunk_index, request_id).
    /// Uses serde_json::Value to avoid needing Deserialize on ResponseEnvelope.
    fn read_chunk_frame(reader: &mut UnixStream) -> Option<(usize, bool, u32, Option<String>)> {
        let msg = match read_message(reader) {
            Ok(Some(msg)) => msg,
            Ok(None) => return None,
            Err(e) => panic!("Read error: {}", e),
        };
        // Deserialize msgpack to JSON value
        let value: serde_json::Value = rmp_serde::from_slice(&msg)
            .expect("Failed to deserialize chunk frame");
        let request_id = value.get("requestId").and_then(|v| v.as_str()).map(String::from);
        let nodes = value.get("nodes").and_then(|v| v.as_array())
            .expect("Chunk must have 'nodes' array");
        let done = value.get("done").and_then(|v| v.as_bool())
            .expect("Chunk must have 'done' bool");
        let chunk_index = value.get("chunkIndex").and_then(|v| v.as_u64())
            .expect("Chunk must have 'chunkIndex'") as u32;
        Some((nodes.len(), done, chunk_index, request_id))
    }

    #[test]
    fn test_streaming_above_threshold_sends_chunks() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "stream_large");
        session.protocol_version = 3;

        let node_count = STREAMING_THRESHOLD + 1; // Just above threshold
        add_n_nodes(&manager, &mut session, node_count, "VARIABLE");

        let (mut writer, mut reader) = UnixStream::pair().unwrap();

        let query = WireAttrQuery {
            node_type: Some("VARIABLE".to_string()),
            name: None,
            file: None,
            exported: None,
            extra: HashMap::new(),
        };

        // Spawn a reader thread to drain chunks concurrently.
        // Without this, handle_query_nodes_streaming blocks on write
        // when the socket buffer fills up.
        let reader_handle = std::thread::spawn(move || {
            let mut chunk_data: Vec<(usize, bool, u32)> = Vec::new();
            let mut total_nodes = 0;
            loop {
                match read_chunk_frame(&mut reader) {
                    Some((count, done, idx, req_id)) => {
                        assert_eq!(req_id.as_deref(), Some("req-1"),
                            "All chunks must carry the original request_id");
                        total_nodes += count;
                        chunk_data.push((count, done, idx));
                        if done { break; }
                    }
                    None => break,
                }
            }
            (chunk_data, total_nodes)
        });

        let result = handle_query_nodes_streaming(&session, query, &Some("req-1".to_string()), &mut writer);

        match result {
            HandleResult::Streamed => { /* expected */ }
            HandleResult::Single(_) => panic!("Expected Streamed for {} nodes (above threshold {})",
                node_count, STREAMING_THRESHOLD),
        }

        // Drop writer so reader thread sees EOF after the chunks
        drop(writer);

        let (chunk_data, total_nodes) = reader_handle.join().expect("Reader thread panicked");

        assert_eq!(total_nodes, node_count,
            "Total nodes across chunks must equal original count");
        assert!(chunk_data.last().unwrap().1, "Last chunk must have done=true");

        // Verify chunk indices are sequential 0, 1, 2, ...
        for (i, chunk) in chunk_data.iter().enumerate() {
            assert_eq!(chunk.2, i as u32, "Chunk index should be sequential");
        }

        // All chunks except the last should have done=false
        for chunk in &chunk_data[..chunk_data.len() - 1] {
            assert!(!chunk.1, "Non-last chunks must have done=false");
        }
    }

    #[test]
    fn test_streaming_chunk_sizes_1200_nodes() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "stream_1200");
        session.protocol_version = 3;

        // 1200 nodes → 3 chunks: [500, 500, 200]
        add_n_nodes(&manager, &mut session, 1200, "CLASS");

        let (mut writer, mut reader) = UnixStream::pair().unwrap();

        let query = WireAttrQuery {
            node_type: Some("CLASS".to_string()),
            name: None,
            file: None,
            exported: None,
            extra: HashMap::new(),
        };

        // Spawn reader thread to drain chunks concurrently (prevents socket buffer deadlock)
        let reader_handle = std::thread::spawn(move || {
            let mut chunk_sizes: Vec<usize> = Vec::new();
            loop {
                match read_chunk_frame(&mut reader) {
                    Some((count, done, _, _)) => {
                        chunk_sizes.push(count);
                        if done { break; }
                    }
                    None => break,
                }
            }
            chunk_sizes
        });

        let result = handle_query_nodes_streaming(&session, query, &None, &mut writer);
        assert!(matches!(result, HandleResult::Streamed));
        drop(writer);

        let chunk_sizes = reader_handle.join().expect("Reader thread panicked");

        assert_eq!(chunk_sizes.len(), 3, "1200 nodes / 500 per chunk = 3 chunks");
        assert_eq!(chunk_sizes[0], STREAMING_CHUNK_SIZE);
        assert_eq!(chunk_sizes[1], STREAMING_CHUNK_SIZE);
        assert_eq!(chunk_sizes[2], 200);
        let total: usize = chunk_sizes.iter().sum();
        assert_eq!(total, 1200);
    }

    #[test]
    fn test_streaming_no_database_returns_error() {
        let (_dir, _manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        session.protocol_version = 3;
        // Don't open any database

        let (mut writer, _reader) = UnixStream::pair().unwrap();

        let query = WireAttrQuery {
            node_type: Some("FUNCTION".to_string()),
            name: None,
            file: None,
            exported: None,
            extra: HashMap::new(),
        };

        let result = handle_query_nodes_streaming(&session, query, &None, &mut writer);

        match result {
            HandleResult::Single(Response::ErrorWithCode { code, .. }) => {
                assert_eq!(code, "NO_DATABASE_SELECTED");
            }
            other => panic!("Expected ErrorWithCode, got: {:?}", other),
        }
    }

    #[test]
    fn test_protocol_v2_does_not_stream() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "stream_v2");

        // Negotiate protocol v2 (not v3)
        handle_request(&manager, &mut session, Request::Hello {
            protocol_version: Some(2),
            client_id: Some("old-client".to_string()),
        }, &None);

        // Add nodes above streaming threshold
        add_n_nodes(&manager, &mut session, STREAMING_THRESHOLD + 50, "MODULE");

        // QueryNodes through handle_request should NOT stream (protocol v2)
        let response = handle_request(&manager, &mut session, Request::QueryNodes {
            query: WireAttrQuery {
                node_type: Some("MODULE".to_string()),
                name: None,
                file: None,
                exported: None,
                extra: HashMap::new(),
            },
        }, &None);

        match response {
            Response::Nodes { nodes } => {
                assert_eq!(nodes.len(), STREAMING_THRESHOLD + 50,
                    "Protocol v2 should get all nodes in single Nodes response");
            }
            _ => panic!("Expected Nodes response for protocol v2, got: {:?}", response),
        }
    }

    #[test]
    fn test_streaming_request_id_propagated() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "stream_reqid");
        session.protocol_version = 3;

        add_n_nodes(&manager, &mut session, STREAMING_THRESHOLD + 1, "LITERAL");

        let (mut writer, mut reader) = UnixStream::pair().unwrap();

        let query = WireAttrQuery {
            node_type: Some("LITERAL".to_string()),
            name: None,
            file: None,
            exported: None,
            extra: HashMap::new(),
        };

        // Spawn reader thread to drain chunks concurrently (prevents socket buffer deadlock)
        let reader_handle = std::thread::spawn(move || {
            let mut chunk_count = 0;
            loop {
                match read_chunk_frame(&mut reader) {
                    Some((_, done, _, req_id)) => {
                        assert_eq!(req_id.as_deref(), Some("stream-req-42"),
                            "Each chunk must carry the original request_id");
                        chunk_count += 1;
                        if done { break; }
                    }
                    None => break,
                }
            }
            chunk_count
        });

        let req_id = Some("stream-req-42".to_string());
        let result = handle_query_nodes_streaming(&session, query, &req_id, &mut writer);
        assert!(matches!(result, HandleResult::Streamed));
        drop(writer);

        let chunk_count = reader_handle.join().expect("Reader thread panicked");
        assert!(chunk_count > 0, "Should have received at least one chunk");
    }

    // ============================================================================
    // REG-487: Deferred Indexing Protocol Tests
    // ============================================================================

    /// Test that CommitBatch with deferIndex=true is accepted and data is persisted.
    /// Note: DatabaseManager creates V2 engines where flush_data_only falls back
    /// to full flush. The actual deferred indexing optimization runs on V1 engine
    /// (tested in engine.rs tests). This test verifies protocol plumbing.
    #[test]
    fn test_commit_batch_with_defer_index() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "defer_idx_test");

        // CommitBatch with deferIndex=true
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["mod_a.js".to_string()],
            nodes: vec![
                WireNode {
                    semantic_id: None,
                    id: "d1".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("deferredFunc".to_string()),
                    file: Some("mod_a.js".to_string()),
                    exported: false,
                    metadata: None,
                },
                WireNode {
                    semantic_id: None,
                    id: "d2".to_string(),
                    node_type: Some("CLASS".to_string()),
                    name: Some("deferredClass".to_string()),
                    file: Some("mod_a.js".to_string()),
                    exported: true,
                    metadata: None,
                },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: true,
        }, &None);

        // Verify: CommitBatch succeeds with correct delta
        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_added, 2, "Should report 2 nodes added");
                assert_eq!(delta.changed_files, vec!["mod_a.js".to_string()]);
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // Send RebuildIndexes — should succeed
        let rebuild_response = handle_request(
            &manager,
            &mut session,
            Request::RebuildIndexes,
            &None,
        );
        match rebuild_response {
            Response::Ok { ok } => assert!(ok, "RebuildIndexes should return Ok"),
            _ => panic!("Expected Ok response for RebuildIndexes, got {:?}", rebuild_response),
        }

        // After rebuild, nodes should be findable
        let find_response = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "FUNCTION".to_string(),
        }, &None);
        match find_response {
            Response::Ids { ids } => {
                assert_eq!(
                    ids.len(), 1,
                    "FindByType(FUNCTION) should return 1 result after RebuildIndexes"
                );
            }
            _ => panic!("Expected Ids response"),
        }

        let find_class = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "CLASS".to_string(),
        }, &None);
        match find_class {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1, "FindByType(CLASS) should return 1 result after RebuildIndexes");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    /// Test that CommitBatch with defer_index=false (the default) immediately
    /// makes nodes findable — existing behavior preserved.
    #[test]
    fn test_commit_batch_default_index_behavior() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "default_idx_test");

        // CommitBatch with defer_index=false (the default)
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["app.js".to_string()],
            nodes: vec![
                WireNode {
                    semantic_id: None,
                    id: "n1".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("immediateFunc".to_string()),
                    file: Some("app.js".to_string()),
                    exported: false,
                    metadata: None,
                },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: false,
        }, &None);

        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_added, 1);
            }
            _ => panic!("Expected BatchCommitted"),
        }

        // Verify: nodes ARE immediately findable (existing behavior)
        let find_response = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "FUNCTION".to_string(),
        }, &None);
        match find_response {
            Response::Ids { ids } => {
                assert_eq!(
                    ids.len(), 1,
                    "FindByType should return 1 result immediately with defer_index=false"
                );
            }
            _ => panic!("Expected Ids response"),
        }
    }

    /// Test that multiple commits with deferIndex=true followed by RebuildIndexes
    /// produces correct results. Verifies protocol-level deferred commit accumulation.
    #[test]
    fn test_multiple_deferred_commits_then_rebuild() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "multi_defer_test");

        // First deferred commit
        handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["a.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "m1".to_string(), node_type: Some("MODULE".to_string()), name: Some("modA".to_string()), file: Some("a.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "f1".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("funcA".to_string()), file: Some("a.js".to_string()), exported: true, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: true,
        }, &None);

        // Second deferred commit
        handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["b.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "m2".to_string(), node_type: Some("MODULE".to_string()), name: Some("modB".to_string()), file: Some("b.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "f2".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("funcB".to_string()), file: Some("b.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![
                WireEdge { src: "f1".to_string(), dst: "f2".to_string(), edge_type: Some("CALLS".to_string()), metadata: None },
            ],
            tags: None,
            file_context: None,
            defer_index: true,
        }, &None);

        // Third deferred commit
        handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["c.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "c1".to_string(), node_type: Some("CLASS".to_string()), name: Some("MyClass".to_string()), file: Some("c.js".to_string()), exported: true, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: true,
        }, &None);

        // Rebuild
        let rebuild = handle_request(&manager, &mut session, Request::RebuildIndexes, &None);
        match rebuild {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok for RebuildIndexes"),
        }

        // ALL data from all three commits should be findable after rebuild
        let find_modules = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "MODULE".to_string(),
        }, &None);
        match find_modules {
            Response::Ids { ids } => assert_eq!(ids.len(), 2, "Should find 2 MODULEs after rebuild"),
            _ => panic!("Expected Ids"),
        }

        let find_functions = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "FUNCTION".to_string(),
        }, &None);
        match find_functions {
            Response::Ids { ids } => assert_eq!(ids.len(), 2, "Should find 2 FUNCTIONs after rebuild"),
            _ => panic!("Expected Ids"),
        }

        let find_classes = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "CLASS".to_string(),
        }, &None);
        match find_classes {
            Response::Ids { ids } => assert_eq!(ids.len(), 1, "Should find 1 CLASS after rebuild"),
            _ => panic!("Expected Ids"),
        }
    }

    /// Test that RebuildIndexes on an empty database is a safe no-op.
    #[test]
    fn test_rebuild_indexes_on_empty_graph() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "empty_rebuild_test");

        // RebuildIndexes on empty database should succeed
        let response = handle_request(&manager, &mut session, Request::RebuildIndexes, &None);
        match response {
            Response::Ok { ok } => assert!(ok, "RebuildIndexes on empty graph should succeed"),
            _ => panic!("Expected Ok for RebuildIndexes on empty graph, got {:?}", response),
        }
    }

    /// Test that RebuildIndexes is idempotent at the protocol level.
    #[test]
    fn test_rebuild_indexes_idempotent_protocol() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "idempotent_rebuild");

        // Add data
        handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["x.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "x1".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("f1".to_string()), file: Some("x.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "x2".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("f2".to_string()), file: Some("x.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: true,
        }, &None);

        // First rebuild
        handle_request(&manager, &mut session, Request::RebuildIndexes, &None);
        let find1 = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "FUNCTION".to_string(),
        }, &None);
        let count1 = match find1 {
            Response::Ids { ids } => ids.len(),
            _ => panic!("Expected Ids"),
        };

        // Second rebuild (should produce same results)
        handle_request(&manager, &mut session, Request::RebuildIndexes, &None);
        let find2 = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "FUNCTION".to_string(),
        }, &None);
        let count2 = match find2 {
            Response::Ids { ids } => ids.len(),
            _ => panic!("Expected Ids"),
        };

        assert_eq!(count1, count2, "RebuildIndexes should be idempotent: same result count after two rebuilds");
        assert_eq!(count1, 2, "Should find 2 FUNCTIONs");
    }
}
