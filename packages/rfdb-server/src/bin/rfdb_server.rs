//! RFDB Server - Unix socket server for graph database
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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sysinfo::System;

// WebSocket support (REG-523)
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::protocol::Message;
use futures_util::{StreamExt, SinkExt};

// Import from library
use rfdb::graph::{GraphEngineV2, GraphStore};
use rfdb::storage::{NodeRecord, EdgeRecord, AttrQuery, FieldDecl, FieldType};
use rfdb::datalog::{parse_program, parse_atom, parse_query, Evaluator, EvaluatorExplain, EvalLimits, QueryResult};
use rfdb::database_manager::{DatabaseManager, DatabaseInfo, AccessMode};
use rfdb::session::ClientSession;
use rfdb::metrics::{Metrics, MetricsSnapshot, SLOW_QUERY_THRESHOLD_MS};

// Global client ID counter
static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

/// Server-wide configuration set once at startup.
/// Uses OnceLock so handle_request can read it without parameter changes.
#[derive(Debug)]
struct ServerConfig {
    /// Whether federation mode is active (--federate flag)
    federate: bool,
    /// Absolute path of the project root this shard covers.
    /// In federation mode, this defines the shard's "territory".
    root: Option<PathBuf>,
}

static SERVER_CONFIG: std::sync::OnceLock<ServerConfig> = std::sync::OnceLock::new();

/// Verbose logging: set RFDB_VERBOSE=1 to log every request with timing.
/// Useful with `grafema server start --foreground`.
fn is_verbose() -> bool {
    static VERBOSE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *VERBOSE.get_or_init(|| std::env::var("RFDB_VERBOSE").map(|v| v == "1" || v == "true").unwrap_or(false))
}

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
    /// Get all edges of a given type, optionally filtered by src node IDs.
    /// More efficient than per-node getOutgoingEdges for bulk analysis passes.
    GetEdgesByType {
        #[serde(rename = "edgeType")]
        edge_type: String,
        /// Optional allowlist of src node IDs; edges not in the set are dropped.
        #[serde(rename = "srcFilter")]
        src_filter: Option<Vec<String>>,
        /// Cap the number of returned edges (applied after src_filter).
        limit: Option<usize>,
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
    /// MVCC C2: enter bulk-load mode — defer per-commit fsync until EndBulkLoad.
    BeginBulkLoad,
    /// MVCC C2: run the durable barrier (fsync the full published state) and
    /// restore per-commit durability.
    EndBulkLoad,
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
    /// Query all nodes belonging to a specific file path (exact match).
    QueryNodesByFile { file: String },

    // Datalog queries
    CheckGuarantee {
        #[serde(rename = "ruleSource")]
        rule_source: String,
        #[serde(default)]
        explain: bool,
    },
    DatalogLoadRules { source: String },
    DatalogClearRules,
    DatalogQuery {
        query: String,
        #[serde(default)]
        explain: bool,
    },
    ExecuteDatalog {
        source: String,
        #[serde(default)]
        explain: bool,
    },

    /// Run a derive engine program that carries `@materialize`, committing the materialized
    /// edges (e.g. stdlib `depends.dl` → DEPENDS_ON) in ONE atomic generation. WRITE path,
    /// derive-engine-ONLY: refused with an explicit coded error when `RFDB_DERIVE_ENGINE` is off (the
    /// legacy derivation runs in the orchestrator under P3). Returns the edges-written count.
    MaterializeDatalog {
        source: String,
    },

    /// why() / explain_fact (spec §11, Gate E): explain ONE supporting derivation of a derived
    /// fact `predicate(key)` under a derive program (empty `source` ⇒ the bundled `depends.dl`).
    /// derive-engine-only, kill-switch gated. READ path; provenance computed on demand (nothing stored per
    /// fact). Returns the deriving rule's hash + the positive body facts that satisfied it, or a
    /// null witness when the fact is not derivable by the program.
    ExplainDatalogFact {
        source: String,
        predicate: String,
        /// Ground key tuple as wire strings (all-digits ⇒ node id, else string literal).
        key: Vec<String>,
    },

    /// what-if / sim (spec §6, decision #2): predict the NEW `predicate` facts a hypothetical
    /// overlay of nodes+edges would create under a derive program (empty `source` ⇒ the bundled
    /// `depends.dl`), WITHOUT committing anything — a pure read over a version-pinned snapshot
    /// plus an in-memory overlay (`OverlayStorageView`). Answer = sim ∖ base. derive-engine-only,
    /// kill-switch gated. Edge endpoints may reference existing OR hypothetical node ids.
    SimDatalog {
        source: String,
        predicate: String,
        #[serde(default)]
        nodes: Vec<WireSimNode>,
        #[serde(default)]
        edges: Vec<WireSimEdge>,
    },

    /// why-not / explain_gap (spec §6, Gate E): explain why `predicate(key)` is NOT derived —
    /// the satisfied body-premise prefix + the first premise no binding satisfies (the gap; for
    /// a negated premise the gap closes by REMOVING the blocking fact). derive-engine-only, kill-switch
    /// gated, READ path. A null witness ⇒ the fact IS derivable (no gap) or no clause head
    /// matches the key. The companion to `SimDatalog`: gap names the missing premise, sim
    /// verifies that adding it produces the fact.
    ExplainDatalogGap {
        source: String,
        predicate: String,
        /// Ground key tuple as wire strings (all-digits ⇒ node id, else string literal).
        key: Vec<String>,
    },

    /// Projection T (rules-as-data): reflect a derive program's RULES into THIS database as
    /// facts, and return how many fact nodes were written. WRITE path, derive-engine-ONLY.
    ///
    /// Additive and idempotent: a fact's node id is content-addressed over its canonical
    /// tuple, so re-reflecting the same program hits the same nodes, and reflecting a second
    /// program adds its rules BESIDE the first. There is no retraction — supersession is a
    /// separate line of work.
    ///
    /// REFUSES with a coded error, rather than writing part of a program, one Projection T
    /// cannot carry whole (`#requires`, `@materialize` / `@materialize_node`, a lattice
    /// payload) or one whose 32-bit rule id is already claimed here by a DIFFERENT clause.
    /// The refusal has to reach the client, because a program that never made it into the
    /// store answers EMPTY to every later store-mode query — indistinguishable from an
    /// honest zero.
    ReflectProgram {
        source: String,
    },

    /// Switch where THIS database's rules come from: `"text"` (the program text handed to
    /// each eval entry — the historical default) or `"store"` (the facts `ReflectProgram`
    /// wrote). WRITE path, derive-engine-ONLY. Returns the mode read BACK off the engine, so
    /// a client asserts which mode it actually measured in instead of assuming its request
    /// took effect.
    ///
    /// A durable property of the DATABASE persisted to `db_config.json`, not a per-request
    /// switch, and reversible in BOTH directions — unlike the one-way ROFL marker
    /// (`GraphEngineV2::enable_rofl_mode`), which has no defined exit. Flipping back destroys
    /// nothing: the rule facts stay in the store, so `store → text → store` returns the same
    /// program.
    ///
    /// While the source is `store`, every `@materialize` write-back path refuses with
    /// `E-REFLECT-003` BY DESIGN: Projection T carries no annotations, so a write-back would
    /// find zero directives and commit nothing while reporting success.
    SetRuleSource {
        mode: rfdb::derive::RuleSource,
    },

    /// Read where THIS database's rules come from, WITHOUT changing anything. READ path,
    /// derive-engine-ONLY, same reply shape as `SetRuleSource`.
    ///
    /// Exists because the mode is a durable property of the DATABASE and, until this door,
    /// the only way to find out what it was was to SET it — which is not an observation.
    /// The consequence was a real trap for every client that is not the conformance
    /// harness: a database left in `store` mode answers every ordinary `executeDatalog`
    /// with zero rows (the request text is not the program any more), no error, nothing
    /// different in the Hello handshake — a silence indistinguishable from an honest zero,
    /// which is the exact failure this whole surface was built to make impossible. A client
    /// that gets an unexpected empty answer can now ASK, and get a coded one-word answer.
    ///
    /// Deliberately NOT in the Hello capabilities and NOT in `OpenDatabase`: Hello is
    /// per-CONNECTION and happens before any database is open, while this is a property of
    /// one database, so answering it in the handshake would be answering about nothing.
    GetRuleSource,

    // Cypher queries
    CypherQuery {
        query: String,
        #[serde(default)]
        explain: bool,
    },

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
        /// Node types to preserve during deletion phase (REG-489).
        #[serde(default, rename = "protectedTypes")]
        protected_types: Vec<String>,
    },

    /// Rebuild all secondary indexes from current segment.
    /// Send after a series of deferIndex=true CommitBatch commands.
    RebuildIndexes,

    /// Delete all edges of a given type whose metadata contains
    /// `_source == sourceTag`. Fails if any other `_source` value is
    /// found for that edge type (collision). Used to clear prior output
    /// from secondary writers (e.g. `layout-pack`) before a re-run.
    DeleteEdgesByTypeAndSource {
        #[serde(rename = "edgeType")]
        edge_type: String,
        #[serde(rename = "sourceTag")]
        source_tag: String,
    },

    /// Delete all nodes of a given type whose metadata contains
    /// `_source == sourceTag`. Also deletes outgoing edges from each
    /// matched node. Same collision semantics as
    /// `DeleteEdgesByTypeAndSource`.
    DeleteNodesByTypeAndSource {
        #[serde(rename = "nodeType")]
        node_type: String,
        #[serde(rename = "sourceTag")]
        source_tag: String,
    },

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

    /// Cancel a running query (WebSocket only).
    /// The server sets the cancellation flag on the running evaluator.
    CancelQuery {
        #[serde(rename = "requestId")]
        request_id: String,
    },

    // ========================================================================
    // Federation Commands (Protocol v4)
    // ========================================================================

    /// Identify this shard: what territory it covers, how fresh the data is.
    /// Used by federation router to validate that a discovered shard
    /// actually covers the expected file paths.
    WhoAreYou,

    /// Extract a reachable subgraph from entry points.
    /// Returns visited nodes, traversed edges, and frontier (dangling edges
    /// whose target doesn't exist in this shard — candidates for cross-shard resolution).
    Subgraph {
        /// Semantic IDs of entry point nodes
        entries: Vec<String>,
        /// "forward", "backward", or "both"
        direction: String,
        /// Edge types to traverse (empty = all)
        #[serde(default, rename = "edgeTypes")]
        edge_types: Vec<String>,
        /// Maximum traversal depth
        #[serde(rename = "maxDepth")]
        max_depth: u32,
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

    /// Reply for `DeleteEdgesByTypeAndSource`.
    EdgesDeleted {
        ok: bool,
        deleted: u64,
    },

    /// Reply for `DeleteNodesByTypeAndSource`.
    NodesDeleted {
        ok: bool,
        #[serde(rename = "deletedNodes")]
        deleted_nodes: u64,
        #[serde(rename = "deletedOutgoingEdges")]
        deleted_outgoing_edges: u64,
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
    ExplainResult(WireExplainResult),
    FactWitness { witness: Option<WireFactWitness> },
    /// `SimDatalog` rows: each predicted-NEW fact's ground tuple as wire strings.
    SimResults { rows: Vec<Vec<String>> },
    /// `ExplainDatalogGap` witness (null ⇒ no gap: derivable, or no head matches).
    GapWitness { witness: Option<WireGapWitness> },
    /// Reply for `SetRuleSource`: where this database's rules come from, read BACK off the
    /// engine AFTER the switch — never the echoed request, so a client that got this reply
    /// knows the mode it will actually be measured in.
    ///
    /// `Response` is `#[serde(untagged)]`, so a reply is told apart by its FIELD SET alone.
    /// `ruleSource` is carried by no other variant (checked: the only other `ruleSource` on
    /// the wire is a `CheckGuarantee` REQUEST field), which is what keeps this from being
    /// read as some other reply.
    RuleSourceMode {
        #[serde(rename = "ruleSource")]
        rule_source: rfdb::derive::RuleSource,
    },
    CypherResult {
        columns: Vec<String>,
        rows: Vec<Vec<serde_json::Value>>,
        #[serde(rename = "rowCount")]
        row_count: usize,
    },

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

    /// Federation: subgraph extraction result
    SubgraphResult {
        ok: bool,
        nodes: Vec<WireNode>,
        edges: Vec<WireEdge>,
        /// Dangling edges: target node doesn't exist in this shard.
        /// Each entry has src (semantic ID), dst (semantic ID), edgeType.
        frontier: Vec<WireFrontierEdge>,
    },

    /// Federation: shard identity response
    ShardIdentity {
        ok: bool,
        /// Absolute path of the analysis root this shard covers
        root: String,
        /// Number of analyzed files in this shard
        #[serde(rename = "fileCount")]
        file_count: u64,
        /// Total nodes in the graph
        #[serde(rename = "nodeCount")]
        node_count: u64,
        /// Total edges in the graph
        #[serde(rename = "edgeCount")]
        edge_count: u64,
        /// Analyzer version that produced this graph
        #[serde(rename = "analyzerVersion")]
        analyzer_version: String,
        /// Server version
        #[serde(rename = "serverVersion")]
        server_version: String,
        /// Whether federation mode is active
        federated: bool,
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
        #[serde(rename = "diskBytes")]
        disk_bytes: u64,

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

        // Query limit stats
        #[serde(rename = "timedOutCount")]
        timed_out_count: u64,
        #[serde(rename = "cancelledCount")]
        cancelled_count: u64,

        // Uptime
        #[serde(rename = "uptimeSecs")]
        uptime_secs: u64,

        // Per-shard diagnostics
        #[serde(rename = "shardDiagnostics")]
        shard_diagnostics: Vec<WireShardDiagnostics>,
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

/// A hypothetical node for `SimDatalog` (what-if): decimal-u128 id + the attrs the derive-engine builtin
/// predicates resolve (`node/2` type; `attr/3` name/file). The id may be NEW (not in the base).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireSimNode {
    pub id: String,
    pub node_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub file: String,
}

/// A hypothetical edge for `SimDatalog`: endpoints are decimal-u128 ids, existing OR hypothetical.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireSimEdge {
    pub src: String,
    pub dst: String,
    pub edge_type: String,
}

/// Wire form of a `GapWitness` (why-not/explain_gap, spec §6): the rule whose gap this
/// characterizes, the satisfied premise prefix, and the first unsatisfiable premise — positive
/// (close the gap by ADDING the fact) or negated (`failingIsNegative`: close by REMOVING it).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireGapWitness {
    pub rule_ast_hash: String,
    pub satisfied: Vec<WireBodyFact>,
    pub failing_predicate: String,
    pub failing_is_negative: bool,
}

/// Wire form of a `DerivationWitness` (why()/explain_fact, spec §11): the deriving rule's stable
/// hash + the positive body facts (predicate + ground tuple) that satisfied it for this fact.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFactWitness {
    pub rule_ast_hash: String,
    pub body: Vec<WireBodyFact>,
}

/// One positive body fact of a witness: the literal's predicate + its ground tuple as wire
/// strings (ids → decimal u128, string literals verbatim).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireBodyFact {
    pub predicate: String,
    pub tuple: Vec<String>,
}

/// Explain result for wire protocol (single object per query, not per row)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireExplainResult {
    pub bindings: Vec<HashMap<String, String>>,
    pub stats: WireQueryStats,
    pub profile: WireQueryProfile,
    pub explain_steps: Vec<WireExplainStep>,
    pub warnings: Vec<String>,
}

/// Query statistics for wire protocol
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireQueryStats {
    pub nodes_visited: usize,
    pub edges_traversed: usize,
    pub find_by_type_calls: usize,
    pub get_node_calls: usize,
    pub outgoing_edge_calls: usize,
    pub incoming_edge_calls: usize,
    pub all_edges_calls: usize,
    pub bfs_calls: usize,
    pub total_results: usize,
    pub rule_evaluations: usize,
    pub intermediate_counts: Vec<usize>,
}

/// Query profile for wire protocol
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireQueryProfile {
    pub total_duration_us: u64,
    pub predicate_times: HashMap<String, u64>,
    pub rule_eval_time_us: u64,
    pub projection_time_us: u64,
}

/// Single explain step for wire protocol
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireExplainStep {
    pub step: usize,
    pub operation: String,
    pub predicate: String,
    pub args: Vec<String>,
    pub result_count: usize,
    pub duration_us: u64,
    pub details: Option<String>,
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

/// Frontier edge: a dangling edge whose target doesn't exist in this shard.
/// Used by federation router for cross-shard resolution.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFrontierEdge {
    /// Source node semantic ID (in this shard)
    pub src: String,
    /// Target node ID (hash, not resolved — target doesn't exist locally)
    pub dst: String,
    /// Edge type
    pub edge_type: String,
    /// Edge metadata (JSON string, may contain "source" for IMPORTS_FROM edges)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

/// Attribute query for wire protocol.
/// Known fields are deserialized into typed fields;
/// any extra fields (e.g. "object", "method") are captured in `extra`
/// and used as metadata filters.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAttrQuery {
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub file: Option<String>,
    pub exported: Option<bool>,
    #[serde(default)]
    pub substring_match: bool,
    /// When true, fall back to fuzzy name matching if exact search returns 0 results.
    #[serde(default)]
    pub fuzzy_name_fallback: Option<bool>,
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

/// Per-shard lifecycle diagnostics for wire protocol
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireShardDiagnostics {
    pub shard_id: u16,
    pub node_count: usize,
    pub edge_count: usize,
    pub write_buffer_nodes: usize,
    pub write_buffer_edges: usize,
    pub compacted: bool,
    pub l0_node_segment_count: usize,
    pub l0_edge_segment_count: usize,
    pub l1_node_records: usize,
    pub l1_edge_records: usize,
    pub tombstone_node_count: usize,
    pub tombstone_edge_count: usize,
    pub has_l1_by_type: bool,
    pub has_l1_by_file: bool,
    pub has_l1_by_name: bool,
    pub l1_by_type_keys: usize,
    pub l1_by_file_keys: usize,
    pub l1_by_name_keys: usize,
    pub has_l1_edge_type_index: bool,
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

/// Resolve a string ID to a u128 node ID.
/// 1. Try parsing as numeric u128
/// 2. Try hashing the string and checking if a node exists with that ID
/// 3. Scan for a node whose semantic_id matches (fallback for generated semantic IDs)
fn resolve_node_id(s: &str, engine: &dyn GraphStore) -> u128 {
    // Fast path: numeric ID
    if let Ok(id) = s.parse::<u128>() {
        return id;
    }
    // Try hash — works when the same string was used at node creation
    let hashed = rfdb::graph::string_id_to_u128(s);
    if engine.get_node(hashed).is_some() {
        return hashed;
    }
    // Slow path: scan for matching semantic_id
    // This handles the case where node was created with id="foo" but
    // semantic_id was auto-generated as "TYPE:name@file"
    let query = rfdb::storage::AttrQuery::default();
    for node_id in engine.find_by_attr(&query) {
        if let Some(node) = engine.get_node(node_id) {
            if let Some(ref sid) = node.semantic_id {
                if sid == s {
                    return node_id;
                }
            }
        }
    }
    // Last resort: return the hash (edge will point to non-existent node)
    hashed
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

/// Convert a `WireAttrQuery` (wire format) into an `AttrQuery` (engine format).
///
/// Handles:
/// - mapping known fields (node_type, file, exported, name, substring_match)
/// - converting extra key-value pairs (String/Bool/Number JSON values) into
///   string-based metadata filters that the engine understands
fn wire_to_attr_query(query: WireAttrQuery) -> AttrQuery {
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

    AttrQuery {
        version: None,
        node_type: query.node_type,
        file_id: None,
        file: query.file,
        exported: query.exported,
        name: query.name,
        metadata_filters,
        substring_match: query.substring_match,
        fuzzy_name_fallback: query.fuzzy_name_fallback,
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
        Request::GetEdgesByType { .. } => "GetEdgesByType".to_string(),
        Request::Flush => "Flush".to_string(),
        Request::Compact => "Compact".to_string(),
        Request::NodeCount => "NodeCount".to_string(),
        Request::EdgeCount => "EdgeCount".to_string(),
        Request::GetStats => "GetStats".to_string(),
        Request::CommitBatch { .. } => "CommitBatch".to_string(),
        Request::RebuildIndexes => "RebuildIndexes".to_string(),
        Request::DeleteEdgesByTypeAndSource { .. } => "DeleteEdgesByTypeAndSource".to_string(),
        Request::DeleteNodesByTypeAndSource { .. } => "DeleteNodesByTypeAndSource".to_string(),
        Request::TagSnapshot { .. } => "TagSnapshot".to_string(),
        Request::FindSnapshot { .. } => "FindSnapshot".to_string(),
        Request::ListSnapshots { .. } => "ListSnapshots".to_string(),
        Request::DiffSnapshots { .. } => "DiffSnapshots".to_string(),
        Request::QueryEdges { .. } => "QueryEdges".to_string(),
        Request::FindDependentFiles { .. } => "FindDependentFiles".to_string(),
        Request::CancelQuery { .. } => "CancelQuery".to_string(),
        Request::CypherQuery { .. } => "CypherQuery".to_string(),
        Request::WhoAreYou => "WhoAreYou".to_string(),
        Request::Subgraph { .. } => "Subgraph".to_string(),
        Request::Hello { .. } => "Hello".to_string(),
        Request::Ping => "Ping".to_string(),
        Request::Shutdown => "Shutdown".to_string(),
        Request::OpenDatabase { .. } => "OpenDatabase".to_string(),
        Request::CreateDatabase { .. } => "CreateDatabase".to_string(),
        Request::ListDatabases => "ListDatabases".to_string(),
        Request::CloseDatabase => "CloseDatabase".to_string(),
        Request::DropDatabase { .. } => "DropDatabase".to_string(),
        Request::CurrentDatabase => "CurrentDatabase".to_string(),
        Request::QueryNodes { .. } => "QueryNodes".to_string(),
        Request::QueryNodesByFile { .. } => "QueryNodesByFile".to_string(),
        Request::BeginBatch => "BeginBatch".to_string(),
        Request::AbortBatch => "AbortBatch".to_string(),
        Request::Clear => "Clear".to_string(),
        Request::DeleteNode { .. } => "DeleteNode".to_string(),
        Request::DeleteEdge { .. } => "DeleteEdge".to_string(),
        Request::NodeExists { .. } => "NodeExists".to_string(),
        Request::CountNodesByType { .. } => "CountNodesByType".to_string(),
        Request::CountEdgesByType { .. } => "CountEdgesByType".to_string(),
        Request::GetAllEdges => "GetAllEdges".to_string(),
        Request::DatalogLoadRules { .. } => "DatalogLoadRules".to_string(),
        Request::DatalogClearRules => "DatalogClearRules".to_string(),
        Request::ExecuteDatalog { .. } => "ExecuteDatalog".to_string(),
        Request::MaterializeDatalog { .. } => "MaterializeDatalog".to_string(),
        Request::ExplainDatalogFact { .. } => "ExplainDatalogFact".to_string(),
        Request::SimDatalog { .. } => "SimDatalog".to_string(),
        Request::ExplainDatalogGap { .. } => "ExplainDatalogGap".to_string(),
        Request::ReflectProgram { .. } => "ReflectProgram".to_string(),
        Request::SetRuleSource { .. } => "SetRuleSource".to_string(),
        Request::GetRuleSource => "GetRuleSource".to_string(),
        Request::IsEndpoint { .. } => "IsEndpoint".to_string(),
        Request::GetNodeIdentifier { .. } => "GetNodeIdentifier".to_string(),
        Request::UpdateNodeVersion { .. } => "UpdateNodeVersion".to_string(),
        Request::DeclareFields { .. } => "DeclareFields".to_string(),
        Request::BeginBulkLoad => "BeginBulkLoad".to_string(),
        Request::EndBulkLoad => "EndBulkLoad".to_string(),
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
    handle_request_with_cancel(manager, session, request, metrics, Arc::new(AtomicBool::new(false)))
}

fn handle_request_with_cancel(
    manager: &DatabaseManager,
    session: &mut ClientSession,
    request: Request,
    metrics: &Option<Arc<Metrics>>,
    cancel_flag: Arc<AtomicBool>,
) -> Response {
    match request {
        // ====================================================================
        // Database Management Commands
        // ====================================================================

        Request::Hello { protocol_version, client_id: _ } => {
            session.protocol_version = protocol_version.unwrap_or(2);
            let mut features = vec![
                "multiDatabase".to_string(),
                "ephemeral".to_string(),
                "semanticIds".to_string(),
                "streaming".to_string(),
            ];
            // Advertise the derive @materialize write-back capability ONLY when the derive engine is
            // enabled (the DEFAULT since Final #12; RFDB_DERIVE_ENGINE=off suppresses it), so the
            // orchestrator learns from the SERVER (single source of truth) whether to skip its
            // own legacy DEPENDS_ON derivation. A duplicated env read in the orchestrator
            // process could disagree with the server's actual backend. Servers that do not
            // advertise the feature are refused by the orchestrator's fail-fast capability gate.
            if derive_engine_enabled() {
                features.push("datalogDerive".to_string());
                // Projection T (rules-as-data): `reflectProgram` writes a program's rules into
                // the database as facts, `setRuleSource` makes the engine execute THOSE rules
                // instead of the request's text, `getRuleSource` reads which of the two is in
                // force without changing it. Advertised under the SAME kill switch because
                // both dispatchers are derive-engine paths and refuse when it is off — a
                // client that needs store-mode rules can then refuse UP FRONT instead of
                // discovering it as empty answers, which are indistinguishable from an honest
                // zero once a program failed to reach the store.
                features.push("rulesAsData".to_string());

            }
            Response::HelloOk {
                ok: true,
                protocol_version: 3,
                server_version: env!("CARGO_PKG_VERSION").to_string(),
                features,
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

            // If the database is being loaded in background, wait for it
            let db_result = if manager.is_database_loading(&name) {
                manager.wait_for_database(&name, std::time::Duration::from_secs(60))
            } else {
                manager.get_database(&name)
            };

            match db_result {
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
                let records: Vec<EdgeRecord> = edges.into_iter().map(|edge| {
                    // Resolve src/dst: try numeric parse first, then resolve semantic ID
                    let src = resolve_node_id(&edge.src, engine);
                    let dst = resolve_node_id(&edge.dst, engine);
                    EdgeRecord {
                        src,
                        dst,
                        edge_type: edge.edge_type,
                        version: "main".to_string(),
                        metadata: edge.metadata,
                        deleted: false,
                    }
                }).collect();
                engine.add_edges(records, skip_validation);
                Response::Ok { ok: true }
            })
        }

        Request::DeleteNode { id } => {
            with_engine_write(session, |engine| {
                // ROFL supersede-only: a reflected rule record states what was
                // once believed. It is superseded, never retracted, so the
                // per-node delete door is closed for it — while staying open for
                // every ordinary node.
                let target = string_to_id(&id);
                if let Some(node) = engine.get_node(target) {
                    if node.node_type.as_deref() == Some(rfdb::derive::reflect::REFLECT_NODE_TYPE) {
                        return Response::Error {
                            error: format!(
                                "E-ROFL-NORETRACT: {} is a reflected rule record ({}); rules are superseded, never deleted",
                                id,
                                rfdb::derive::reflect::REFLECT_NODE_TYPE,
                            ),
                        };
                    }
                }
                engine.delete_node(target);
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
                let attr_query = wire_to_attr_query(query);
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

        Request::GetEdgesByType { edge_type, src_filter, limit } => {
            let protocol = session.protocol_version;
            with_engine_read(session, |engine| {
                let mut edges: Vec<WireEdge> = engine.get_edges_by_type(&edge_type)
                    .into_iter()
                    .map(|e| record_to_wire_edge(&e))
                    .collect();
                if let Some(filter) = src_filter.as_ref() {
                    let filter_set: std::collections::HashSet<&str> =
                        filter.iter().map(|s| s.as_str()).collect();
                    edges.retain(|e| filter_set.contains(e.src.as_str()));
                }
                if let Some(lim) = limit {
                    edges.truncate(lim);
                }
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

        Request::BeginBulkLoad => {
            with_engine_write(session, |engine| {
                match engine.begin_bulk_load() {
                    Ok(()) => Response::Ok { ok: true },
                    Err(e) => Response::Error { error: e.to_string() },
                }
            })
        }

        Request::EndBulkLoad => {
            with_engine_write(session, |engine| {
                match engine.end_bulk_load() {
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
            // W8 Part 2: clear is DURABLE on the v2 engine — it truncates the on-disk
            // database (segments + manifest + tombstones + engine caches incl. the D2
            // pins), so a subsequent reload sees an EMPTY graph. The old behavior
            // (ephemeral swap, disk untouched) made `analyze --clear` a placebo: the old
            // disk resurrected on reload. Calling `clear_durable` directly (instead of
            // the infallible trait `clear()`) surfaces a truncation failure to the
            // client as an error instead of an eprintln-only fallback.
            with_engine_write(session, |engine| {
                match engine.as_any_mut().downcast_mut::<GraphEngineV2>() {
                    Some(v2) => match v2.clear_durable() {
                        Ok(()) => Response::Ok { ok: true },
                        Err(e) => Response::Error {
                            error: format!("durable clear failed: {e} (manual fallback: delete the .rfdb directory before starting the server)"),
                        },
                    },
                    None => {
                        engine.clear();
                        Response::Ok { ok: true }
                    }
                }
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
                let attr_query = wire_to_attr_query(query);
                let ids = engine.find_by_attr(&attr_query);
                let nodes: Vec<WireNode> = ids.into_iter()
                    .filter_map(|id| engine.get_node(id))
                    .map(|r| record_to_wire_node(&r))
                    .collect();
                Response::Nodes { nodes }
            })
        }

        Request::QueryNodesByFile { file } => {
            with_engine_read(session, |engine| {
                let attr_query = AttrQuery {
                    file: Some(file),
                    ..AttrQuery::default()
                };
                let ids = engine.find_by_attr(&attr_query);
                let nodes: Vec<WireNode> = ids.into_iter()
                    .filter_map(|id| engine.get_node(id))
                    .map(|r| record_to_wire_node(&r))
                    .collect();
                Response::Nodes { nodes }
            })
        }

        Request::CheckGuarantee { rule_source, explain } => {
            let cf = cancel_flag.clone();
            with_engine_read(session, |engine| {
                match dispatch_check_guarantee(engine, &rule_source, explain, cf) {
                    Ok(DatalogResponse::Violations(violations)) => Response::Violations { violations },
                    Ok(DatalogResponse::Explain(result)) => Response::ExplainResult(result),
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

        Request::DatalogQuery { query, explain } => {
            let cf = cancel_flag.clone();
            with_engine_read(session, |engine| {
                match dispatch_datalog_query(engine, &query, explain, cf) {
                    Ok(DatalogResponse::Violations(results)) => Response::DatalogResults { results },
                    Ok(DatalogResponse::Explain(result)) => Response::ExplainResult(result),
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::ExecuteDatalog { source, explain } => {
            let cf = cancel_flag.clone();
            with_engine_read(session, |engine| {
                match dispatch_execute_datalog(engine, &source, explain, cf) {
                    Ok(DatalogResponse::Violations(results)) => Response::DatalogResults { results },
                    Ok(DatalogResponse::Explain(result)) => Response::ExplainResult(result),
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::MaterializeDatalog { source } => {
            // WRITE path: @materialize ends in commit_batch_ext (&mut self), so it takes the
            // exclusive write lock (mirrors CommitBatch's serial fallback). derive-engine-only and
            // kill-switch-gated inside the dispatcher; refusal is an explicit coded error (I5).
            let cf = cancel_flag.clone();
            with_engine_write(session, |engine| {
                match dispatch_materialize_datalog(engine, &source, cf) {
                    Ok(count) => Response::Count { count: count as u32 },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::ExplainDatalogFact { source, predicate, key } => {
            // READ path: why() is a pure read over the current snapshot (no commit).
            let cf = cancel_flag.clone();
            with_engine_read(session, |engine| {
                match dispatch_explain_datalog_fact(engine, &source, &predicate, &key, cf) {
                    Ok(witness) => Response::FactWitness { witness },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::SimDatalog { source, predicate, nodes, edges } => {
            // READ path: sim never commits (pinned snapshot + in-memory overlay, sim ∖ base).
            let cf = cancel_flag.clone();
            with_engine_read(session, |engine| {
                match dispatch_sim_datalog(engine, &source, &predicate, &nodes, &edges, cf) {
                    Ok(rows) => Response::SimResults { rows },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::ExplainDatalogGap { source, predicate, key } => {
            // READ path: why-not is a pure read over the current snapshot (no commit).
            let cf = cancel_flag.clone();
            with_engine_read(session, |engine| {
                match dispatch_explain_datalog_gap(engine, &source, &predicate, &key, cf) {
                    Ok(witness) => Response::GapWitness { witness },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::ReflectProgram { source } => {
            // WRITE path: reflection ends in `commit_batch_ext` (&mut self), so it takes the
            // exclusive write lock — same shape as MaterializeDatalog. derive-engine-only and
            // kill-switch-gated inside the dispatcher; a refusal is an explicit coded error (I5).
            with_engine_write(session, |engine| {
                match dispatch_reflect_program(engine, &source) {
                    Ok(count) => Response::Count { count: count as u32 },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::SetRuleSource { mode } => {
            // WRITE path, not a session setting: the flag is a durable database property
            // persisted to `db_config.json` (&mut self) and it changes what EVERY later derive
            // call on this database executes, for every session. Taking the write lock is what
            // stops one session flipping the program out from under another mid-query.
            with_engine_write(session, |engine| {
                match dispatch_set_rule_source(engine, mode) {
                    Ok(effective) => Response::RuleSourceMode { rule_source: effective },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::GetRuleSource => {
            // READ path — it takes the read lock and changes nothing, which is the whole
            // point: asking must not be a way of setting.
            with_engine_read(session, |engine| match dispatch_get_rule_source(engine) {
                Ok(mode) => Response::RuleSourceMode { rule_source: mode },
                Err(e) => Response::Error { error: e },
            })
        }

        Request::CypherQuery { query, explain: _ } => {
            let cf = cancel_flag.clone();
            with_engine_read(session, |engine| {
                let mut limits = rfdb::datalog::EvalLimits::default();
                limits.cancelled = Some(cf);
                match rfdb::cypher::execute(engine, &query, limits) {
                    Ok(result) => Response::CypherResult {
                        columns: result.columns,
                        rows: result.rows,
                        row_count: result.row_count,
                    },
                    Err(e) => Response::Error { error: e.to_string() },
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
            let (node_count, edge_count, delta_size, disk_bytes, shard_diags) = if let Some(ref db) = session.current_db {
                let engine = db.engine.read().unwrap();
                let ops = 0u64;
                let disk = engine.disk_size_bytes();
                let diags: Vec<WireShardDiagnostics> = engine.shard_diagnostics()
                    .into_iter()
                    .map(|d| WireShardDiagnostics {
                        shard_id: d.shard_id,
                        node_count: d.node_count,
                        edge_count: d.edge_count,
                        write_buffer_nodes: d.write_buffer_nodes,
                        write_buffer_edges: d.write_buffer_edges,
                        compacted: d.compacted,
                        l0_node_segment_count: d.l0_node_segment_count,
                        l0_edge_segment_count: d.l0_edge_segment_count,
                        l1_node_records: d.l1_node_records,
                        l1_edge_records: d.l1_edge_records,
                        tombstone_node_count: d.tombstone_node_count,
                        tombstone_edge_count: d.tombstone_edge_count,
                        has_l1_by_type: d.has_l1_by_type,
                        has_l1_by_file: d.has_l1_by_file,
                        has_l1_by_name: d.has_l1_by_name,
                        l1_by_type_keys: d.l1_by_type_keys,
                        l1_by_file_keys: d.l1_by_file_keys,
                        l1_by_name_keys: d.l1_by_name_keys,
                        has_l1_edge_type_index: d.has_l1_edge_type_index,
                    })
                    .collect();
                (
                    engine.node_count() as u64,
                    engine.edge_count() as u64,
                    ops,
                    disk,
                    diags,
                )
            } else {
                // No database selected - return zeros
                (0, 0, 0, 0, vec![])
            };

            // Get system memory
            let memory_percent = check_memory_usage();

            Response::Stats {
                node_count,
                edge_count,
                delta_size,
                disk_bytes,
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
                timed_out_count: metrics_snapshot.timed_out_count,
                cancelled_count: metrics_snapshot.cancelled_count,
                uptime_secs: metrics_snapshot.uptime_secs,
                shard_diagnostics: shard_diags,
            }
        }

        Request::CommitBatch { changed_files, nodes, edges, tags: _, file_context, defer_index, mut protected_types } => {
            // ROFL supersede-only: the reflected-rule record type is protected
            // UNCONDITIONALLY, never by client opt-in. A batch whose changedFiles
            // names the virtual rules file would otherwise tombstone every rule
            // record in it — and a superseded rule that stops being FINDABLE is
            // not history. A rule leaves force only by being superseded.
            let reserved = rfdb::derive::reflect::REFLECT_NODE_TYPE;
            if !protected_types.iter().any(|t| t == reserved) {
                protected_types.push(reserved.to_string());
            }

            // MVCC B4: prefer the CONCURRENT V2 commit path. It runs under a
            // SHARED read() lock (so N commits proceed in parallel; only the
            // short manifest commit-point is serialized inside the engine) and
            // requires a disk-backed V2 engine. If the engine is not a
            // disk-backed V2 (ephemeral / V1), fall back to the exclusive
            // write()-lock serial path.
            let concurrent_ok = match &session.current_db {
                Some(db) => {
                    let engine = db.engine.read().unwrap();
                    engine
                        .as_any()
                        .downcast_ref::<GraphEngineV2>()
                        // MVCC C3.a: while bulk-load is armed, force the serial
                        // &mut self path (handle_commit_batch_v2 → commit_batch_ext)
                        // so per-commit auto-compaction fires and bounds the live
                        // segment count. The concurrent &self path cannot compact.
                        .map(|v2| v2.supports_concurrent_commit() && !v2.bulk_load_active())
                        .unwrap_or(false)
                }
                None => false,
            };

            if concurrent_ok {
                if !session.can_write() {
                    Response::ErrorWithCode {
                        error: "Operation not allowed in read-only mode".to_string(),
                        code: "READ_ONLY_MODE".to_string(),
                    }
                } else {
                    let db = session.current_db.as_ref().unwrap();
                    let engine = db.engine.read().unwrap();
                    let v2 = engine.as_any().downcast_ref::<GraphEngineV2>().unwrap();
                    handle_commit_batch_v2_concurrent(
                        v2, changed_files, nodes, edges, file_context, defer_index, protected_types,
                    )
                }
            } else {
                with_engine_write(session, |engine| {
                    // Try V2 native path (O(batch_size) via file_to_node_ids index)
                    match engine.as_any_mut().downcast_mut::<GraphEngineV2>() {
                        Some(v2) => handle_commit_batch_v2(
                            v2, changed_files, nodes, edges, file_context, defer_index, protected_types,
                        ),
                        // Fallback to V1-style individual operations
                        None => handle_commit_batch(
                            engine, changed_files, nodes, edges, file_context, defer_index, protected_types,
                        ),
                    }
                })
            }
        }

        Request::RebuildIndexes => {
            with_engine_write(session, |engine| {
                if let Err(e) = engine.rebuild_indexes() {
                    return Response::Error { error: format!("Index rebuild failed: {}", e) };
                }
                Response::Ok { ok: true }
            })
        }

        Request::DeleteEdgesByTypeAndSource { edge_type, source_tag } => {
            with_engine_write(session, |engine| {
                match rfdb::deletion::delete_edges_by_type_and_source(engine, &edge_type, &source_tag) {
                    Ok(out) => Response::EdgesDeleted { ok: true, deleted: out.deleted as u64 },
                    Err(e) => Response::Error { error: e },
                }
            })
        }

        Request::DeleteNodesByTypeAndSource { node_type, source_tag: _ } if node_type == rfdb::derive::reflect::REFLECT_NODE_TYPE => {
            // ROFL supersede-only: the bulk door, closed for the reserved type.
            Response::Error {
                error: format!(
                    "E-ROFL-NORETRACT: {} is the reflected rule record type; rules are superseded, never deleted",
                    node_type,
                ),
            }
        }

        Request::DeleteNodesByTypeAndSource { node_type, source_tag } => {
            with_engine_write(session, |engine| {
                match rfdb::deletion::delete_nodes_by_type_and_source(engine, &node_type, &source_tag) {
                    Ok(out) => Response::NodesDeleted {
                        ok: true,
                        deleted_nodes: out.deleted_nodes as u64,
                        deleted_outgoing_edges: out.deleted_outgoing_edges as u64,
                    },
                    Err(e) => Response::Error { error: e },
                }
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

        Request::WhoAreYou => {
            let config = SERVER_CONFIG.get();
            let federated = config.map(|c| c.federate).unwrap_or(false);
            let root = config
                .and_then(|c| c.root.as_ref())
                .map(|p| p.display().to_string())
                .unwrap_or_default();

            // Get counts from default database
            let (node_count, edge_count, file_count) = if let Ok(db) = manager.get_database("default") {
                let engine = db.engine.read().unwrap();
                let nc = engine.node_count() as u64;
                let ec = engine.edge_count() as u64;
                // Count unique files: query nodes with type MODULE
                let file_nodes = engine.find_by_type("MODULE");
                let fc = file_nodes.len() as u64;
                (nc, ec, fc)
            } else {
                (0, 0, 0)
            };

            Response::ShardIdentity {
                ok: true,
                root,
                file_count,
                node_count,
                edge_count,
                analyzer_version: String::new(), // populated by orchestrator metadata later
                server_version: env!("CARGO_PKG_VERSION").to_string(),
                federated,
            }
        }

        Request::Subgraph { entries, direction, edge_types, max_depth } => {
            let protocol = session.protocol_version;
            with_engine_read(session, |engine| {
                // Resolve entry point semantic IDs to u128
                let start_ids: Vec<u128> = entries.iter()
                    .map(|s| string_to_id(s))
                    .collect();

                let edge_types_owned: Vec<String> = edge_types.iter().cloned().collect();

                // Build edge getter based on direction
                let get_edges = |node_id: u128| -> Vec<(u128, String, String)> {
                    let types_refs: Vec<&str> = edge_types_owned.iter().map(|s| s.as_str()).collect();
                    let types_opt = if types_refs.is_empty() { None } else { Some(types_refs.as_slice()) };

                    let mut result = Vec::new();

                    if direction == "forward" || direction == "both" {
                        for edge in engine.get_outgoing_edges(node_id, types_opt) {
                            let etype = edge.edge_type.unwrap_or_default();
                            let meta = edge.metadata.unwrap_or_default();
                            result.push((edge.dst, etype, meta));
                        }
                    }
                    if direction == "backward" || direction == "both" {
                        for edge in engine.get_incoming_edges(node_id, types_opt) {
                            let etype = edge.edge_type.unwrap_or_default();
                            let meta = edge.metadata.unwrap_or_default();
                            result.push((edge.src, etype, meta));
                        }
                    }

                    result
                };

                let node_exists = |id: u128| -> bool {
                    engine.node_exists(id)
                };

                let sub = rfdb::graph::traversal::subgraph(
                    &start_ids,
                    max_depth as usize,
                    get_edges,
                    node_exists,
                );

                // Convert node IDs to full WireNodes
                let nodes: Vec<WireNode> = sub.node_ids.iter()
                    .filter_map(|&id| engine.get_node(id).map(|n| record_to_wire_node(&n)))
                    .collect();

                // Convert edges to WireEdges
                let mut edges: Vec<WireEdge> = sub.edges.iter()
                    .map(|(src, dst, etype)| WireEdge {
                        src: id_to_string(*src),
                        dst: id_to_string(*dst),
                        edge_type: Some(etype.clone()),
                        metadata: None,
                    })
                    .collect();

                // Resolve semantic IDs on edges for protocol v3+
                if protocol >= 3 {
                    resolve_edge_semantic_ids(&mut edges, engine);
                }

                // Build frontier with semantic IDs where possible
                let frontier: Vec<WireFrontierEdge> = sub.frontier.iter()
                    .map(|(src, dst, etype, meta)| {
                        let src_id = if protocol >= 3 {
                            engine.get_node(*src)
                                .and_then(|n| n.semantic_id)
                                .unwrap_or_else(|| id_to_string(*src))
                        } else {
                            id_to_string(*src)
                        };
                        // dst doesn't exist locally, so just use hash string
                        let dst_id = id_to_string(*dst);
                        WireFrontierEdge {
                            src: src_id,
                            dst: dst_id,
                            edge_type: etype.clone(),
                            metadata: if meta.is_empty() { None } else { Some(meta.clone()) },
                        }
                    })
                    .collect();

                Response::SubgraphResult {
                    ok: true,
                    nodes,
                    edges,
                    frontier,
                }
            })
        }

        Request::CancelQuery { .. } => {
            // CancelQuery is handled at the transport layer (WebSocket handler).
            // If it reaches handle_request, it means it was sent over unix socket
            // where cancellation is not supported.
            Response::Error { error: "CancelQuery is only supported over WebSocket".to_string() }
        }
    }
}

/// Handle CommitBatch: atomically replace nodes/edges for changed files.
///
/// Uses GraphStore trait methods (delete-then-add) which works correctly
/// for both v1 and v2 engines.
///
/// When `file_context` is provided, the batch operates in enrichment mode:
/// - The file_context is added to `changed_files` so old enrichment edges
///   for that virtual file are tombstoned during deletion phase
/// - Each edge gets `__file_context` injected into its metadata via
///   `enrichment_edge_metadata()`
///
/// Deletion only tombstones OUTGOING edges from deleted nodes (by src).
/// Incoming edges (from other nodes) become orphaned but are filtered
/// out at query time by node tombstone checks (neighbors/reverse_neighbors).
/// Compaction cleans them up permanently.
fn handle_commit_batch(
    engine: &mut dyn GraphStore,
    mut changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    file_context: Option<String>,
    defer_index: bool,
    protected_types: Vec<String>,
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
            substring_match: false,
            fuzzy_name_fallback: None,
        };
        let old_ids = engine.find_by_attr(&attr_query);

        for id in &old_ids {
            // Skip deletion for protected node types (REG-489)
            if !protected_types.is_empty() {
                if let Some(node) = engine.get_node(*id) {
                    if let Some(ref nt) = node.node_type {
                        if protected_types.contains(nt) {
                            continue;
                        }
                    }
                }
            }

            if let Some(node) = engine.get_node(*id) {
                if let Some(ref nt) = node.node_type {
                    changed_node_types.insert(nt.clone());
                }
            }

            // Only delete outgoing edges (indexed by src → efficient).
            // Incoming edges become orphaned but are filtered at query time
            // by node tombstone checks. Compaction cleans them up permanently.
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

    if is_verbose() {
        eprintln!("[rfdb]   commitBatch: +{}n -{}n +{}e -{}e, files={}, flush={}",
            nodes_added, nodes_removed, edges_added, edges_removed,
            changed_files.len(),
            if defer_index { "data-only" } else { "full" });
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

/// Handle CommitBatch using V2 native commit_batch (O(batch_size) via index).
///
/// Converts wire types to V2 record types and delegates to
/// `GraphEngineV2::commit_batch_ext` which uses file_to_node_ids index,
/// shard-targeted edge lookup, and Arc-shared tombstones.
fn handle_commit_batch_v2(
    engine: &mut GraphEngineV2,
    mut changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    file_context: Option<String>,
    _defer_index: bool,
    protected_types: Vec<String>,
) -> Response {
    use rfdb::storage_v2::types::{NodeRecordV2, EdgeRecordV2, enrichment_edge_metadata};

    // If file_context is set, ensure it's included in changed_files
    if let Some(ref ctx) = file_context {
        if !changed_files.contains(ctx) {
            changed_files.push(ctx.clone());
        }
    }

    let edges_added = edges.len() as u64;

    // Convert WireNode → NodeRecordV2
    let v2_nodes: Vec<NodeRecordV2> = nodes
        .into_iter()
        .map(|node| {
            let semantic_id = node.semantic_id.clone().unwrap_or_else(|| node.id.clone());
            let id = string_to_id(&semantic_id);
            // Inject __exported into metadata (V2 doesn't have top-level exported field)
            let mut metadata = node.metadata.unwrap_or_default();
            if node.exported {
                if metadata.is_empty() || metadata == "{}" {
                    metadata = r#"{"__exported":true}"#.to_string();
                } else if !metadata.contains("__exported") {
                    // Insert before closing brace
                    if let Some(pos) = metadata.rfind('}') {
                        let comma = if metadata[..pos].trim_end().ends_with('{') { "" } else { "," };
                        metadata.insert_str(pos, &format!("{comma}\"__exported\":true"));
                    }
                }
            }
            NodeRecordV2 {
                semantic_id,
                id,
                node_type: node.node_type.unwrap_or_default(),
                name: node.name.unwrap_or_default(),
                file: node.file.unwrap_or_default(),
                content_hash: 0,
                metadata,
            }
        })
        .collect();

    // Convert WireEdge → EdgeRecordV2, injecting __file_context if present
    let v2_edges: Vec<EdgeRecordV2> = edges
        .into_iter()
        .map(|edge| {
            let metadata = if let Some(ref ctx) = file_context {
                let existing = edge.metadata.as_deref().unwrap_or("");
                enrichment_edge_metadata(ctx, existing)
            } else {
                edge.metadata.unwrap_or_default()
            };
            EdgeRecordV2 {
                src: string_to_id(&edge.src),
                dst: string_to_id(&edge.dst),
                edge_type: edge.edge_type.unwrap_or_default(),
                metadata,
            }
        })
        .collect();

    // Call V2 native commit_batch
    match engine.commit_batch_ext(
        v2_nodes,
        v2_edges,
        &changed_files,
        HashMap::new(),
        &protected_types,
    ) {
        Ok(delta) => {
            if is_verbose() {
                eprintln!(
                    "[rfdb]   commitBatch(v2): +{}n -{}n +{}e, files={}, mod={}",
                    delta.nodes_added,
                    delta.nodes_removed,
                    edges_added,
                    changed_files.len(),
                    delta.nodes_modified,
                );
            }

            let wire_delta = WireCommitDelta {
                changed_files: delta.changed_files,
                nodes_added: delta.nodes_added,
                nodes_removed: delta.nodes_removed,
                edges_added,
                edges_removed: delta.edges_removed,
                changed_node_types: delta.changed_node_types.into_iter().collect(),
                changed_edge_types: delta.changed_edge_types.into_iter().collect(),
            };

            Response::BatchCommitted { ok: true, delta: wire_delta }
        }
        Err(e) => Response::Error {
            error: format!("V2 commit_batch failed: {}", e),
        },
    }
}

/// MVCC B4: CONCURRENT V2 commit handler (runs under a SHARED read lock).
///
/// Mirrors `handle_commit_batch_v2` but calls the `&self` concurrent commit and
/// retries on a write-write conflict (strict abort-retry, bounded). The retry
/// re-attempts the SAME records: the conflict means another commit published a
/// newer version touching one of our `changed_files` after our snapshot, so we
/// re-snapshot (inside `commit_batch_concurrent`) and recompute. Bounded at
/// `MAX_COMMIT_RETRIES`; on exhaustion returns a hard error (pathological
/// same-file contention — an alarm, not a silent drop).
fn handle_commit_batch_v2_concurrent(
    engine: &GraphEngineV2,
    mut changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    file_context: Option<String>,
    _defer_index: bool,
    protected_types: Vec<String>,
) -> Response {
    use rfdb::storage_v2::types::{NodeRecordV2, EdgeRecordV2, enrichment_edge_metadata};

    const MAX_COMMIT_RETRIES: u32 = 8;

    if let Some(ref ctx) = file_context {
        if !changed_files.contains(ctx) {
            changed_files.push(ctx.clone());
        }
    }

    let edges_added = edges.len() as u64;

    let v2_nodes: Vec<NodeRecordV2> = nodes
        .into_iter()
        .map(|node| {
            let semantic_id = node.semantic_id.clone().unwrap_or_else(|| node.id.clone());
            let id = string_to_id(&semantic_id);
            let mut metadata = node.metadata.unwrap_or_default();
            if node.exported {
                if metadata.is_empty() || metadata == "{}" {
                    metadata = r#"{"__exported":true}"#.to_string();
                } else if !metadata.contains("__exported") {
                    if let Some(pos) = metadata.rfind('}') {
                        let comma = if metadata[..pos].trim_end().ends_with('{') { "" } else { "," };
                        metadata.insert_str(pos, &format!("{comma}\"__exported\":true"));
                    }
                }
            }
            NodeRecordV2 {
                semantic_id,
                id,
                node_type: node.node_type.unwrap_or_default(),
                name: node.name.unwrap_or_default(),
                file: node.file.unwrap_or_default(),
                content_hash: 0,
                metadata,
            }
        })
        .collect();

    let v2_edges: Vec<EdgeRecordV2> = edges
        .into_iter()
        .map(|edge| {
            let metadata = if let Some(ref ctx) = file_context {
                let existing = edge.metadata.as_deref().unwrap_or("");
                enrichment_edge_metadata(ctx, existing)
            } else {
                edge.metadata.unwrap_or_default()
            };
            EdgeRecordV2 {
                src: string_to_id(&edge.src),
                dst: string_to_id(&edge.dst),
                edge_type: edge.edge_type.unwrap_or_default(),
                metadata,
            }
        })
        .collect();

    let mut attempt: u32 = 0;
    loop {
        // Records are re-cloned each attempt (a conflict retry re-runs the
        // whole commit against a fresh snapshot).
        let result = engine.commit_batch_concurrent(
            v2_nodes.clone(),
            v2_edges.clone(),
            &changed_files,
            HashMap::new(),
            &protected_types,
        );

        match result {
            Ok(delta) => {
                if is_verbose() {
                    eprintln!(
                        "[rfdb]   commitBatch(v2,concurrent): +{}n -{}n +{}e, files={}, mod={}, attempt={}",
                        delta.nodes_added, delta.nodes_removed, edges_added,
                        changed_files.len(), delta.nodes_modified, attempt,
                    );
                }
                let wire_delta = WireCommitDelta {
                    changed_files: delta.changed_files,
                    nodes_added: delta.nodes_added,
                    nodes_removed: delta.nodes_removed,
                    edges_added,
                    edges_removed: delta.edges_removed,
                    changed_node_types: delta.changed_node_types.into_iter().collect(),
                    changed_edge_types: delta.changed_edge_types.into_iter().collect(),
                };
                return Response::BatchCommitted { ok: true, delta: wire_delta };
            }
            Err(rfdb::error::GraphError::ConflictedCommit { files, snapshot_version, conflicting_version }) => {
                attempt += 1;
                if attempt >= MAX_COMMIT_RETRIES {
                    tracing::warn!(
                        "commit_conflict_exhausted: files={:?} after {} retries (snapshot v{} < committed v{}) — hard error",
                        files, attempt, snapshot_version, conflicting_version,
                    );
                    return Response::Error {
                        error: format!(
                            "Commit conflict on {:?}: exhausted {} retries (same-file concurrent writes — partition work by file)",
                            files, MAX_COMMIT_RETRIES,
                        ),
                    };
                }
                // Loud per-retry alarm already emitted inside the store; loop to
                // re-snapshot + recompute + re-commit.
                continue;
            }
            Err(e) => {
                return Response::Error {
                    error: format!("V2 commit_batch (concurrent) failed: {}", e),
                };
            }
        }
    }
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

/// Internal return type to distinguish explain vs non-explain results
enum DatalogResponse {
    Violations(Vec<WireViolation>),
    Explain(WireExplainResult),
}

// ============================================================================
// Datalog engine router — RFDB_DERIVE_ENGINE kill switch (spec P3, I8)
// ============================================================================

/// Whether the request should be served by the Datalog **derive** engine
/// (`crate::derive`) rather than the query engine (`crate::datalog`).
///
/// `RFDB_DERIVE_ENGINE` is a **SERVER-side** debug switch: it is read in the server
/// process, **per request at dispatch** (not cached at startup), and never consulted by
/// clients. **The derive engine is the DEFAULT** (Final #12, after Gates A–D + the
/// resolve→derive migration proved it on the live graph): setting `RFDB_DERIVE_ENGINE=off`
/// (case-insensitive) — the defined off-switch — routes wire datalog evaluation
/// (`DatalogQuery`/`ExecuteDatalog`/`CheckGuarantee`) to the query engine for debugging,
/// and disables the derive-only paths (`@materialize`, explain_fact, sim, explain_gap)
/// with explicit coded errors. Unset → derive. `"off"`/`"OFF"` → query engine. Any other
/// value (e.g. `"on"`, `"1"` — the pre-flip opt-ins, now redundant no-ops) → derive. The
/// read is a pure boolean over the environment with no side effects.
///
/// One deliberate exception: `explain` requests are always served by the query engine
/// regardless of this switch (the derive-engine explain recording→wire mapping is a
/// deferred gate; see the dispatchers below) — that routing is explicit and documented,
/// not a silent fall-through.
fn derive_engine_enabled() -> bool {
    match std::env::var("RFDB_DERIVE_ENGINE") {
        Ok(v) => !v.eq_ignore_ascii_case("off"),
        Err(_) => true,
    }
}

/// Map a derive-engine evaluation's positional rows onto the `target` atom's head variable names,
/// producing the same `WireViolation` shape the query-engine handlers emit.
///
/// `Term::Var` columns become `name -> value` entries; `Term::Const` / `Term::Wildcard`
/// columns carry no binding (mirroring v1, which only surfaces variable bindings). Extra
/// value columns past the atom's arity are dropped; missing columns are skipped.
fn v2_rows_to_violations(rows: Vec<Vec<String>>, target: &rfdb::datalog::Atom) -> Vec<WireViolation> {
    let args = target.args();
    rows.into_iter()
        .map(|row| {
            let mut map = std::collections::HashMap::new();
            for (i, term) in args.iter().enumerate() {
                if let rfdb::datalog::Term::Var(name) = term {
                    if let Some(val) = row.get(i) {
                        map.insert(name.clone(), val.clone());
                    }
                }
            }
            WireViolation { bindings: map }
        })
        .collect()
}

/// Route a Datalog evaluation through the **v2** engine for the given `target` head atom.
///
/// Captures a version-pinned view of the engine's `MultiShardStore` snapshot (via
/// `GraphEngineV2::eval_derive`, the single v2 eval entry — no explain fork, I8) and
/// returns the derived `target` facts as `WireViolation`s. Returns `Err` (an explicit
/// coded message, never a silent fall-through to the query engine) when the engine is not a
/// `GraphEngineV2` or the v2 pipeline rejects the program.
fn route_datalog_engine(
    engine: &dyn GraphStore,
    source: &str,
    target: &rfdb::datalog::Atom,
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<DatalogResponse, String> {
    let v2_engine = engine
        .as_any()
        .downcast_ref::<GraphEngineV2>()
        .ok_or_else(|| {
            "RFDB_DERIVE_ENGINE: the derive engine requires a storage_v2 GraphEngineV2 backend"
                .to_string()
        })?;

    let mut limits = EvalLimits::default();
    limits.cancelled = Some(cancel_flag);

    let rows = v2_engine
        .eval_derive(source, target.predicate(), limits)
        .map_err(|e| format!("derive engine error [{}]: {}", e.code(), e))?;

    Ok(DatalogResponse::Violations(v2_rows_to_violations(rows, target)))
}

/// `CheckGuarantee` dispatch: route to the derive engine (the default) or the query engine
/// per the `RFDB_DERIVE_ENGINE`
/// kill switch. The guarantee head is always `violation(X)`. `explain` requests are
/// DELIBERATELY routed to the query engine regardless of the switch: the derive-engine
/// explain *recording*→wire mapping is a deferred gate (I8 keeps the single eval entry,
/// no derive-side explain fork), and with the derive engine now the default an explain
/// refusal would break the product explain surface (MCP `explain` → `checkGuarantee(…,
/// explain: true)`). The query engine remains in the binary as the explain provider — an
/// explicit, documented routing (query ≡ derive on Gate A 51/51), not a silent fall-through.
fn dispatch_check_guarantee(
    engine: &dyn GraphStore,
    rule_source: &str,
    explain: bool,
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<DatalogResponse, String> {
    if derive_engine_enabled() && !explain {
        let target = parse_atom("violation(X)")
            .map_err(|e| format!("Internal error parsing violation query: {}", e))?;
        return route_datalog_engine(engine, rule_source, &target, cancel_flag);
    }
    execute_check_guarantee(engine, rule_source, explain, cancel_flag)
}

/// `DatalogQuery` dispatch: route to the derive engine (the default) or the query engine
/// per the kill switch. The derive-engine target is the first query literal's atom (its
/// variables name the result columns).
/// `explain` → query engine (same deliberate routing as `dispatch_check_guarantee`).
fn dispatch_datalog_query(
    engine: &dyn GraphStore,
    query_source: &str,
    explain: bool,
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<DatalogResponse, String> {
    if derive_engine_enabled() && !explain {
        let literals = parse_query(query_source)
            .map_err(|e| format!("Datalog query parse error: {}", e))?;
        let target = literals
            .first()
            .map(|lit| lit.atom().clone())
            .ok_or_else(|| "derive engine: empty query (no literals)".to_string())?;
        return route_datalog_engine(engine, query_source, &target, cancel_flag);
    }
    execute_datalog_query(engine, query_source, explain, cancel_flag)
}

/// `ExecuteDatalog` dispatch: route to the derive engine (the default) or the query engine
/// per the kill switch. The derive-engine target mirrors the query engine's auto-detect —
/// first rule head when the source is a program with rules, otherwise the first query
/// literal's atom.
/// `explain` → query engine (same deliberate routing as `dispatch_check_guarantee`).
fn dispatch_execute_datalog(
    engine: &dyn GraphStore,
    source: &str,
    explain: bool,
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<DatalogResponse, String> {
    if derive_engine_enabled() && !explain {
        let target = if let Ok(program) = parse_program(source) {
            if !program.rules().is_empty() {
                Some(program.rules()[0].head().clone())
            } else {
                None
            }
        } else {
            None
        };
        let target = match target {
            Some(t) => t,
            None => {
                let literals = parse_query(source)
                    .map_err(|e| format!("Datalog parse error: {}", e))?;
                literals
                    .first()
                    .map(|lit| lit.atom().clone())
                    .ok_or_else(|| "derive engine: empty program (no rules or query)".to_string())?
            }
        };
        return route_datalog_engine(engine, source, &target, cancel_flag);
    }
    execute_datalog(engine, source, explain, cancel_flag)
}

/// Resolve a wire `source` to the derive engine program text — THE pack-resolution contract,
/// shared by every dispatcher that defaults an empty source to the bundled `depends.dl`
/// (`MaterializeDatalog`, `ExplainDatalogFact`, `ExplainDatalogGap`, `SimDatalog`):
/// - `""` (or whitespace) ⇒ the bundled `depends.dl` (the EXISTING orchestrator contract);
/// - `"@stdlib/<name>"` ⇒ the named bundled pack from [`rfdb::derive::stdlib::STDLIB_PACKS`]
///   (`@stdlib/depends` is the named alias of the empty-source default);
/// - an unknown `"@stdlib/<name>"` ⇒ the coded `E-MAT-007` error naming the pack and
///   listing the known packs — never a silent fallback to running `"@stdlib/…"` as
///   program text (I5);
/// - anything else ⇒ explicit program text, passed through untouched.
///
/// Pack ORDER is a contract for sequential callers (`shape_verifier` reads CALLS as EDB,
/// so it must run after `method_calls`) — see the registry docs in `derive/stdlib.rs`.
fn resolve_pack_source(source: &str) -> std::result::Result<&str, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Ok(rfdb::derive::stdlib::DEPENDS_DL);
    }
    if let Some(name) = trimmed.strip_prefix("@stdlib/") {
        return rfdb::derive::stdlib::stdlib_pack(name).ok_or_else(|| {
            let known = rfdb::derive::stdlib::STDLIB_PACKS
                .iter()
                .map(|(n, _)| format!("@stdlib/{n}"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "derive engine pack resolution error [E-MAT-007]: unknown stdlib pack \
                 \"@stdlib/{name}\"; known packs: {known}"
            )
        });
    }
    Ok(source)
}

/// `MaterializeDatalog` dispatch (WRITE path): run a derive-engine `@materialize` program and commit the
/// materialized edges in ONE atomic generation, returning the edges-written count.
///
/// derive-engine-ONLY and kill-switch-gated: when `RFDB_DERIVE_ENGINE` is off this refuses with an explicit
/// coded error (with the derive engine off there is NO derivation path at all) rather than
/// silently doing nothing (I5). The backend must be a `GraphEngineV2` (storage_v2) — anything
/// else is an explicit error, never a silent no-op. There is no v1 materialize path: `@materialize`
/// write-back is a derive-engine capability. The whole run commits via the single atomic flip in
/// [`GraphEngineV2::eval_derive_materialize`] (run isolation, abort-no-commit).
fn dispatch_materialize_datalog(
    engine: &mut dyn GraphStore,
    source: &str,
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<usize, String> {
    if !derive_engine_enabled() {
        return Err("RFDB_DERIVE_ENGINE: @materialize write-back is a derive-engine-only path; with the kill \
                    switch disables ALL derivation — there is no legacy fallback since 0.4.0"
            .to_string());
    }
    let v2 = engine
        .as_any_mut()
        .downcast_mut::<GraphEngineV2>()
        .ok_or_else(|| {
            "RFDB_DERIVE_ENGINE: @materialize requires a storage_v2 GraphEngineV2 backend".to_string()
        })?;

    let mut limits = EvalLimits::default();
    limits.cancelled = Some(cancel_flag);
    // @materialize is a BATCH operation (one-time per analysis, like a build step), not an
    // interactive query — the 30s `EvalLimits::default()` deadline is an interactive-query bound
    // and is too tight for a cold full materialize over a large graph (depends.dl on the ~408k-node
    // dogfood graph exceeds 30s → E-EXEC-001). Give the batch path a generous deadline; cancellation
    // still works via `cancelled` above. Tunable via `RFDB_MATERIALIZE_DEADLINE_SECS` (default 600).
    let materialize_deadline_secs = std::env::var("RFDB_MATERIALIZE_DEADLINE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(600);
    limits.deadline =
        Some(std::time::Instant::now() + std::time::Duration::from_secs(materialize_deadline_secs));

    // Empty source ⇒ the canonical bundled depends.dl; "@stdlib/<name>" ⇒ a named bundled
    // pack (E-MAT-007 when unknown); anything else ⇒ explicit program text. The single
    // source of truth is `resolve_pack_source` — no drift between dispatchers.
    let program = resolve_pack_source(source)?;

    // Gate D2: the cached entry MAINTAINS the derived relations across calls against this
    // long-lived per-database engine (work-proportional on the 2nd+ run) and commits only the
    // edge delta — additions AND tombstones of stale edges, so a reanalysis supersedes obsolete
    // DEPENDS_ON instead of only accreting (the additive full-rewrite path never removed stale
    // edges). First run / restart / a program outside the monotone envelope falls back to a full
    // scratch eval (correctness floor, I5). Reports the edges ADDED this run as the written count.
    v2.eval_derive_materialize_cached(program, limits)
        .map(|(added, _removed)| added)
        .map_err(|e| format!("derive engine materialize error [{}]: {}", e.code(), e))
}

/// `ExplainDatalogFact` dispatch (READ path): explain ONE supporting derivation of
/// `predicate(key)` under a derive program via [`GraphEngineV2::explain_datalog_fact`] (why(), spec
/// §11). derive-engine-ONLY and kill-switch-gated (refused with a coded error when `RFDB_DERIVE_ENGINE` is off,
/// I5 — never a silent empty answer). Empty `source` ⇒ the bundled `depends.dl`. `Ok(None)` ⇒ the
/// fact is not derivable by the program (a true negative, distinct from an error).
fn dispatch_explain_datalog_fact(
    engine: &dyn GraphStore,
    source: &str,
    predicate: &str,
    key: &[String],
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<Option<WireFactWitness>, String> {
    if !derive_engine_enabled() {
        return Err("RFDB_DERIVE_ENGINE: explain_fact is a derive-engine-only path; with the kill switch off \
                    there is no v2 why() provenance"
            .to_string());
    }
    let v2 = engine
        .as_any()
        .downcast_ref::<GraphEngineV2>()
        .ok_or_else(|| {
            "RFDB_DERIVE_ENGINE: explain_fact requires a storage_v2 GraphEngineV2 backend".to_string()
        })?;

    let program = resolve_pack_source(source)?;
    let key_vals: Vec<rfdb::datalog::Value> = key.iter().map(|s| wire_string_to_value(s)).collect();

    let mut limits = EvalLimits::default();
    limits.cancelled = Some(cancel_flag);

    let witness = v2
        .explain_datalog_fact(program, predicate, &key_vals, limits)
        .map_err(|e| format!("derive engine explain_fact error [{}]: {}", e.code(), e))?;

    Ok(witness.map(|w| WireFactWitness {
        rule_ast_hash: w.rule_ast_hash,
        body: w
            .body
            .into_iter()
            .map(|(predicate, tuple)| WireBodyFact {
                predicate,
                tuple: tuple.iter().map(datalog_value_to_wire_string).collect(),
            })
            .collect(),
    }))
}

/// `SimDatalog` dispatch (READ path, what-if): predict the NEW `predicate` facts a hypothetical
/// node/edge overlay would create under a derive program via [`GraphEngineV2::sim_derive`]
/// (spec §6). derive-engine-ONLY and kill-switch-gated (refused with a coded error when `RFDB_DERIVE_ENGINE`
/// is off, I5 — never a silent empty answer). Empty `source` ⇒ the bundled `depends.dl`. The
/// committed store is never touched: pinned snapshot + `OverlayStorageView`, answer = sim ∖ base.
fn dispatch_sim_datalog(
    engine: &dyn GraphStore,
    source: &str,
    predicate: &str,
    nodes: &[WireSimNode],
    edges: &[WireSimEdge],
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<Vec<Vec<String>>, String> {
    if !derive_engine_enabled() {
        return Err("RFDB_DERIVE_ENGINE: sim is a derive-engine-only path; with the kill switch off there is \
                    no v2 what-if overlay"
            .to_string());
    }
    let v2 = engine.as_any().downcast_ref::<GraphEngineV2>().ok_or_else(|| {
        "RFDB_DERIVE_ENGINE: sim requires a storage_v2 GraphEngineV2 backend".to_string()
    })?;

    let program = resolve_pack_source(source)?;

    // Hypothetical ids are decimal u128 on the wire (same shape the read path emits for node
    // ids); a non-numeric id is an explicit input error, not a silent skip.
    fn parse_id(s: &str, what: &str) -> std::result::Result<u128, String> {
        s.parse::<u128>()
            .map_err(|_| format!("sim: {what} id must be a decimal u128 string, got {s:?}"))
    }
    let mut hyp_nodes = Vec::with_capacity(nodes.len());
    for n in nodes {
        hyp_nodes.push((parse_id(&n.id, "node")?, n.node_type.clone(), n.name.clone(), n.file.clone()));
    }
    let mut hyp_edges = Vec::with_capacity(edges.len());
    for e in edges {
        hyp_edges.push((parse_id(&e.src, "edge src")?, parse_id(&e.dst, "edge dst")?, e.edge_type.clone()));
    }

    let mut limits = EvalLimits::default();
    limits.cancelled = Some(cancel_flag);

    v2.sim_derive(program, predicate, &hyp_nodes, &hyp_edges, limits)
        .map_err(|e| format!("derive engine sim error [{}]: {}", e.code(), e))
}

/// `ExplainDatalogGap` dispatch (READ path, why-not): explain why `predicate(key)` is NOT
/// derived via [`GraphEngineV2::explain_datalog_gap`] (spec §6, Gate E). derive-engine-ONLY and
/// kill-switch-gated (coded refusal when off, I5). Empty `source` ⇒ the bundled `depends.dl`.
/// `Ok(None)` ⇒ no gap: the fact is derivable, or no clause head matches the key.
fn dispatch_explain_datalog_gap(
    engine: &dyn GraphStore,
    source: &str,
    predicate: &str,
    key: &[String],
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<Option<WireGapWitness>, String> {
    if !derive_engine_enabled() {
        return Err("RFDB_DERIVE_ENGINE: explain_gap is a derive-engine-only path; with the kill switch off \
                    there is no v2 why-not"
            .to_string());
    }
    let v2 = engine.as_any().downcast_ref::<GraphEngineV2>().ok_or_else(|| {
        "RFDB_DERIVE_ENGINE: explain_gap requires a storage_v2 GraphEngineV2 backend".to_string()
    })?;

    let program = resolve_pack_source(source)?;
    let key_vals: Vec<rfdb::datalog::Value> = key.iter().map(|s| wire_string_to_value(s)).collect();

    let mut limits = EvalLimits::default();
    limits.cancelled = Some(cancel_flag);

    let gap = v2
        .explain_datalog_gap(program, predicate, &key_vals, limits)
        .map_err(|e| format!("derive engine explain_gap error [{}]: {}", e.code(), e))?;

    Ok(gap.map(|g| WireGapWitness {
        rule_ast_hash: g.rule_ast_hash,
        satisfied: g
            .satisfied
            .into_iter()
            .map(|(predicate, tuple)| WireBodyFact {
                predicate,
                tuple: tuple.iter().map(datalog_value_to_wire_string).collect(),
            })
            .collect(),
        failing_predicate: g.failing_predicate,
        failing_is_negative: g.failing_is_negative,
    }))
}

/// `ReflectProgram` dispatch (WRITE path): reflect a derive program's rules into the current
/// database as facts via [`GraphEngineV2::reflect_program`] (Projection T). derive-engine-ONLY
/// and kill-switch-gated (a coded refusal when `RFDB_DERIVE_ENGINE` is off, I5 — never a silent
/// no-op). Returns the number of reflected fact nodes.
///
/// The reflected facts are VISIBLE when this returns, with no `Flush` needed from the caller,
/// and that matters more than it sounds: a client that reflected and then queried a store which
/// had not yet published would decode a store WITHOUT the rules it just wrote and get an EMPTY
/// answer — indistinguishable from an honest zero. It holds because reflection commits through
/// `commit_batch_ext`, and a commit publishes a new manifest version (`graph/engine_v2.rs`
/// ⟦a commit publishes a new manifest version⟧); the buffered `add_nodes` path that does need a
/// flush is a different one. No explicit flush is issued here — the wire test
/// `wire_reflect_program_then_store_mode_answers_from_the_store` sends no `Flush` between
/// reflecting and querying and reads the reflected rule back, which is what makes that a
/// measured fact rather than an assumption.
///
/// The source is program TEXT, not a pack selector: unlike the eval entries there is no
/// `resolve_pack_source` here, because reflecting the bundled packs is what
/// `derive::reflect`'s own round-trip test does in-process — the wire door exists to put a
/// CLIENT's program into the store.
fn dispatch_reflect_program(
    engine: &mut dyn GraphStore,
    source: &str,
) -> std::result::Result<usize, String> {
    if !derive_engine_enabled() {
        return Err("RFDB_DERIVE_ENGINE: reflectProgram is a derive-engine-only path; with the kill \
                    switch off there is no Projection T to reflect rules into"
            .to_string());
    }
    let v2 = engine
        .as_any_mut()
        .downcast_mut::<GraphEngineV2>()
        .ok_or_else(|| {
            "RFDB_DERIVE_ENGINE: reflectProgram requires a storage_v2 GraphEngineV2 backend".to_string()
        })?;

    let written = v2
        .reflect_program(source)
        .map_err(|e| format!("derive engine reflect error [{}]: {}", e.code(), e))?;
    Ok(written)
}

/// `SetRuleSource` dispatch (WRITE path): point this database's rules at the request TEXT or at
/// the STORE via [`GraphEngineV2::set_rule_source`], and return the mode read BACK off the
/// engine. derive-engine-ONLY and kill-switch-gated, like every other Projection T door.
///
/// The return value is re-READ through [`GraphEngineV2::rule_source`] rather than echoed
/// from the argument. Read this for exactly what it is: today the setter is TOTAL — every
/// mode it accepts, it reaches — so the read-back and the echo are the same value on every
/// input, and no test can tell them apart. It is written this way so that the day a mode
/// becomes refusable the reply keeps meaning "the state", not because the difference is
/// observable now.
///
/// A client that needs to CONFIRM the mode must therefore not lean on this reply. It must
/// ask [`Request::GetRuleSource`], which never saw the request — that is the door the
/// conformance harness confirms through
/// (`rofl-conformance/src/differential.ts` ⟦switchRuleSource⟧), and mutating THAT to a
/// constant is caught (`wire_get_rule_source_reads_the_state_and_changes_nothing`).
fn dispatch_set_rule_source(
    engine: &mut dyn GraphStore,
    mode: rfdb::derive::RuleSource,
) -> std::result::Result<rfdb::derive::RuleSource, String> {
    if !derive_engine_enabled() {
        return Err("RFDB_DERIVE_ENGINE: setRuleSource is a derive-engine-only path; with the kill \
                    switch off nothing reads the rule source"
            .to_string());
    }
    let v2 = engine
        .as_any_mut()
        .downcast_mut::<GraphEngineV2>()
        .ok_or_else(|| {
            "RFDB_DERIVE_ENGINE: setRuleSource requires a storage_v2 GraphEngineV2 backend".to_string()
        })?;

    v2.set_rule_source(mode)
        .map_err(|e| format!("derive engine set_rule_source error: {e}"))?;
    Ok(v2.rule_source())
}

/// `GetRuleSource` dispatch (READ path): where this database's rules come from, observed
/// and not altered. derive-engine-ONLY and kill-switch-gated like its two siblings — with
/// the switch off no derive call consults the mode, so there is nothing here to report.
///
/// Takes `&dyn GraphStore`, not `&mut`, and that is the contract rather than an
/// optimisation: the reason this door exists is that SETTING was the only way to find out,
/// and a probe that writes is not a probe.
fn dispatch_get_rule_source(
    engine: &dyn GraphStore,
) -> std::result::Result<rfdb::derive::RuleSource, String> {
    if !derive_engine_enabled() {
        return Err("RFDB_DERIVE_ENGINE: getRuleSource is a derive-engine-only path; with the kill \
                    switch off nothing reads the rule source"
            .to_string());
    }
    let v2 = engine
        .as_any()
        .downcast_ref::<GraphEngineV2>()
        .ok_or_else(|| {
            "RFDB_DERIVE_ENGINE: getRuleSource requires a storage_v2 GraphEngineV2 backend"
                .to_string()
        })?;
    Ok(v2.rule_source())
}

/// Parse a wire term into a datalog [`rfdb::datalog::Value`] — the READ direction of the
/// protocol's value surface (the `key` arrays of `ExplainDatalogFact`/`ExplainDatalogGap`).
///
/// The exact inverse of [`datalog_value_to_wire_string`]; both directions are the single
/// codec in [`rfdb::datalog::wire_string_to_value`]'s module, which documents the tag
/// grammar and the rule that resolves the bare-decimal ambiguity (a bare decimal is a node
/// id; every other variant is tagged; a `Str` is escaped only when the verbatim form would
/// be re-read as something else). Untagged input keeps its legacy reading, so clients that
/// never learn the tags keep working.
fn wire_string_to_value(s: &str) -> rfdb::datalog::Value {
    rfdb::datalog::wire_string_to_value(s)
}

/// Render a datalog [`rfdb::datalog::Value`] to its wire string — the WRITE direction of the
/// protocol's value surface (`WireBodyFact.tuple`).
///
/// The exact inverse of [`wire_string_to_value`]: node ids and ordinary strings render
/// byte-identically to the pre-codec wire, while `Int`/`Float`/`BigInt`/`Term` (and any
/// `Str` whose text would be re-read as another variant) render tagged so the value survives
/// the round trip with its type. See [`rfdb::datalog::value_to_wire_string`]'s module for the
/// grammar and the ambiguity rule.
fn datalog_value_to_wire_string(v: &rfdb::datalog::Value) -> String {
    rfdb::datalog::value_to_wire_string(v)
}

/// Convert a `QueryResult` into a `WireExplainResult`
fn query_result_to_wire_explain(result: QueryResult) -> WireExplainResult {
    WireExplainResult {
        bindings: result.bindings,
        stats: WireQueryStats {
            nodes_visited: result.stats.nodes_visited,
            edges_traversed: result.stats.edges_traversed,
            find_by_type_calls: result.stats.find_by_type_calls,
            get_node_calls: result.stats.get_node_calls,
            outgoing_edge_calls: result.stats.outgoing_edge_calls,
            incoming_edge_calls: result.stats.incoming_edge_calls,
            all_edges_calls: result.stats.all_edges_calls,
            bfs_calls: result.stats.bfs_calls,
            total_results: result.stats.total_results,
            rule_evaluations: result.stats.rule_evaluations,
            intermediate_counts: result.stats.intermediate_counts,
        },
        profile: WireQueryProfile {
            total_duration_us: result.profile.total_duration_us,
            predicate_times: result.profile.predicate_times,
            rule_eval_time_us: result.profile.rule_eval_time_us,
            projection_time_us: result.profile.projection_time_us,
        },
        explain_steps: result.explain_steps.into_iter().map(|s| WireExplainStep {
            step: s.step,
            operation: s.operation,
            predicate: s.predicate,
            args: s.args,
            result_count: s.result_count,
            duration_us: s.duration_us,
            details: s.details,
        }).collect(),
        warnings: result.warnings,
    }
}

/// Execute a guarantee check (violation query)
fn execute_check_guarantee(
    engine: &dyn GraphStore,
    rule_source: &str,
    explain: bool,
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<DatalogResponse, String> {
    let program = parse_program(rule_source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    let violation_query = parse_atom("violation(X)")
        .map_err(|e| format!("Internal error parsing violation query: {}", e))?;

    let mut limits = EvalLimits::default();
    limits.cancelled = Some(cancel_flag);

    if explain {
        let mut evaluator = EvaluatorExplain::with_limits(engine, true, limits);
        for rule in program.rules() {
            evaluator.add_rule(rule.clone());
        }
        let result = evaluator.query(&violation_query);
        Ok(DatalogResponse::Explain(query_result_to_wire_explain(result)))
    } else {
        let mut evaluator = Evaluator::with_limits(engine, limits);
        for rule in program.rules() {
            evaluator.add_rule(rule.clone());
        }
        let bindings = evaluator.query(&violation_query)?;
        let violations: Vec<WireViolation> = bindings.into_iter()
            .map(|b| {
                let mut map = std::collections::HashMap::new();
                for (k, v) in b.iter() {
                    map.insert(k.clone(), v.as_str());
                }
                WireViolation { bindings: map }
            })
            .collect();
        Ok(DatalogResponse::Violations(violations))
    }
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
    explain: bool,
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<DatalogResponse, String> {
    let literals = parse_query(query_source)
        .map_err(|e| format!("Datalog query parse error: {}", e))?;

    let mut limits = EvalLimits::default();
    limits.cancelled = Some(cancel_flag);

    if explain {
        let mut evaluator = EvaluatorExplain::with_limits(engine, true, limits);
        let result = evaluator.eval_query(&literals)?;
        Ok(DatalogResponse::Explain(query_result_to_wire_explain(result)))
    } else {
        let evaluator = Evaluator::with_limits(engine, limits);
        let bindings = evaluator.eval_query(&literals)?;
        let results: Vec<WireViolation> = bindings.into_iter()
            .map(|b| {
                let mut map = std::collections::HashMap::new();
                for (k, v) in b.iter() {
                    map.insert(k.clone(), v.as_str());
                }
                WireViolation { bindings: map }
            })
            .collect();
        Ok(DatalogResponse::Violations(results))
    }
}

/// Execute unified Datalog — auto-detects rules vs direct query.
///
/// If the source parses as a program with rules, load the rules and query
/// using the head predicate of the first rule. Otherwise, fall back to
/// parsing as a direct query.
fn execute_datalog(
    engine: &dyn GraphStore,
    source: &str,
    explain: bool,
    cancel_flag: Arc<AtomicBool>,
) -> std::result::Result<DatalogResponse, String> {
    let mut limits = EvalLimits::default();
    limits.cancelled = Some(cancel_flag.clone());

    // Try parsing as a program first
    if let Ok(program) = parse_program(source) {
        if !program.rules().is_empty() {
            if explain {
                let mut evaluator = EvaluatorExplain::with_limits(engine, true, limits);
                for rule in program.rules() {
                    evaluator.add_rule(rule.clone());
                }
                let head = program.rules()[0].head();
                let result = evaluator.query(head);
                return Ok(DatalogResponse::Explain(query_result_to_wire_explain(result)));
            } else {
                let mut evaluator = Evaluator::with_limits(engine, limits);
                for rule in program.rules() {
                    evaluator.add_rule(rule.clone());
                }
                let head = program.rules()[0].head();
                let bindings = evaluator.query(head)?;
                let results: Vec<WireViolation> = bindings.into_iter()
                    .map(|b| {
                        let mut map = std::collections::HashMap::new();
                        for (k, v) in b.iter() {
                            map.insert(k.clone(), v.as_str());
                        }
                        WireViolation { bindings: map }
                    })
                    .collect();
                return Ok(DatalogResponse::Violations(results));
            }
        }
    }

    // Fall back to direct query
    let literals = parse_query(source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    let mut fallback_limits = EvalLimits::default();
    fallback_limits.cancelled = Some(cancel_flag);

    if explain {
        let mut evaluator = EvaluatorExplain::with_limits(engine, true, fallback_limits);
        let result = evaluator.eval_query(&literals)?;
        Ok(DatalogResponse::Explain(query_result_to_wire_explain(result)))
    } else {
        let evaluator = Evaluator::with_limits(engine, fallback_limits);
        let bindings = evaluator.eval_query(&literals)?;
        let results: Vec<WireViolation> = bindings.into_iter()
            .map(|b| {
                let mut map = std::collections::HashMap::new();
                for (k, v) in b.iter() {
                    map.insert(k.clone(), v.as_str());
                }
                WireViolation { bindings: map }
            })
            .collect();
        Ok(DatalogResponse::Violations(results))
    }
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
    let engine_ref: &dyn GraphStore = &**engine;

    let attr_query = wire_to_attr_query(query);

    // Held-back chunk pattern:
    // We buffer IDs until we know whether total exceeds STREAMING_THRESHOLD.
    // Once it does, we switch to streaming mode with a held-back chunk so
    // the final chunk can be sent with done=true.
    let mut initial_buf: Vec<u128> = Vec::with_capacity(STREAMING_THRESHOLD + STREAMING_CHUNK_SIZE + 1);
    let mut crossed_threshold = false;
    let mut held_back: Option<Vec<WireNode>> = None;
    let mut chunk_index: u32 = 0;
    let mut write_error = false;

    let send_chunk = |nodes: Vec<WireNode>,
                      done: bool,
                      chunk_index: u32,
                      request_id: &Option<String>,
                      stream: &mut UnixStream| -> bool {
        let envelope = ResponseEnvelope {
            request_id: request_id.clone(),
            response: Response::NodesChunk { nodes, done, chunk_index },
        };
        match rmp_serde::to_vec_named(&envelope) {
            Ok(bytes) => {
                if let Err(e) = write_message(stream, &bytes) {
                    eprintln!("[rfdb-server] Write error during streaming (implicit cancel): {}", e);
                    return false;
                }
                true
            }
            Err(e) => {
                eprintln!("[rfdb-server] Serialize error during streaming: {}", e);
                false
            }
        }
    };

    engine_ref.find_by_attr_chunked(&attr_query, STREAMING_CHUNK_SIZE, &mut |ids| {
        if write_error {
            return false;
        }

        if !crossed_threshold {
            // Still accumulating into initial buffer
            initial_buf.extend_from_slice(ids);
            if initial_buf.len() <= STREAMING_THRESHOLD {
                return true; // keep collecting
            }
            // Crossed threshold — switch to streaming mode.
            // Convert everything accumulated so far into chunks.
            crossed_threshold = true;
            for chunk_ids in initial_buf.chunks(STREAMING_CHUNK_SIZE) {
                let nodes: Vec<WireNode> = chunk_ids.iter()
                    .filter_map(|&id| engine_ref.get_node(id))
                    .map(|r| record_to_wire_node(&r))
                    .collect();

                // Send previous held-back chunk (if any) with done=false
                if let Some(prev) = held_back.take() {
                    if !send_chunk(prev, false, chunk_index, request_id, stream) {
                        write_error = true;
                        return false;
                    }
                    chunk_index += 1;
                }
                held_back = Some(nodes);
            }
            // Clear initial_buf — no longer needed
            initial_buf = Vec::new();
            return true;
        }

        // Already in streaming mode — process this chunk
        let nodes: Vec<WireNode> = ids.iter()
            .filter_map(|&id| engine_ref.get_node(id))
            .map(|r| record_to_wire_node(&r))
            .collect();

        // Send previous held-back chunk with done=false
        if let Some(prev) = held_back.take() {
            if !send_chunk(prev, false, chunk_index, request_id, stream) {
                write_error = true;
                return false;
            }
            chunk_index += 1;
        }
        held_back = Some(nodes);
        true
    });

    if write_error {
        return HandleResult::Streamed;
    }

    if !crossed_threshold {
        // Never crossed threshold — return single response
        let nodes: Vec<WireNode> = initial_buf.into_iter()
            .filter_map(|id| engine_ref.get_node(id))
            .map(|r| record_to_wire_node(&r))
            .collect();
        if is_verbose() {
            eprintln!("[rfdb]   queryNodes: {} nodes (single frame)", nodes.len());
        }
        return HandleResult::Single(Response::Nodes { nodes });
    }

    // Send the held-back chunk with done=true
    if let Some(last) = held_back.take() {
        if !send_chunk(last, true, chunk_index, request_id, stream) {
            return HandleResult::Streamed;
        }
        chunk_index += 1;
    }

    if is_verbose() {
        eprintln!("[rfdb]   queryNodes: streamed {} chunks", chunk_index);
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

/// W8 Part 1 (disconnect-cancel): watch a Unix-socket connection for peer closure WHILE a
/// request is being handled synchronously on the connection thread, and raise the shared
/// cancellation flag the instant the client dies.
///
/// Why this exists: the Unix path dispatches each request synchronously in the connection
/// thread, so the thread only re-reads the socket BETWEEN requests — a client killed
/// mid-request (Ctrl-C'd CLI, dead MCP session) was never noticed and the in-flight
/// datalog/cypher eval ground CPU to completion (observed: 15+ min burns, ~5 incidents).
/// The WebSocket path already cancels on disconnect (its async select loop); this brings
/// the production Unix path to parity.
///
/// Mechanism: one watcher thread per connection, owning a `try_clone`d (dup'd) fd so the
/// main thread's stream lifetime is untouched. Every poll round (200 ms timeout) it
/// `poll(2)`s for readability/hangup and distinguishes EOF from pipelined request bytes
/// with a non-blocking 1-byte `MSG_PEEK` (never consumes protocol bytes). EOF ⇒ set the
/// per-connection cancel flag (polled by datalog v1/v2 + cypher evals via
/// `EvalLimits::cancelled`) and exit. The `done` flag stops the watcher when the
/// connection handler exits first. Idle cost: one parked thread + one `poll` wakeup per
/// 200 ms per connection — unmeasurable.
fn spawn_unix_disconnect_watcher(
    stream: &UnixStream,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    client_id: usize,
) {
    use std::os::unix::io::AsRawFd;
    let Ok(watch) = stream.try_clone() else {
        // No watcher ⇒ behavior degrades to the pre-W8 state (no disconnect-cancel),
        // never to a wrong answer.
        eprintln!(
            "[rfdb-server] Client {}: disconnect watcher unavailable (try_clone failed)",
            client_id
        );
        return;
    };
    thread::spawn(move || {
        let fd = watch.as_raw_fd();
        loop {
            if done.load(Ordering::Relaxed) {
                return;
            }
            let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            let n = unsafe { libc::poll(&mut pfd, 1, 200) };
            if n < 0 {
                // poll error (EBADF after an unexpected close, EINTR storms…): stop
                // watching rather than risk a false cancel.
                return;
            }
            if n > 0 {
                // Readable or hung up — peek one byte without consuming it.
                let mut byte = 0u8;
                let r = unsafe {
                    libc::recv(
                        fd,
                        &mut byte as *mut u8 as *mut libc::c_void,
                        1,
                        libc::MSG_PEEK | libc::MSG_DONTWAIT,
                    )
                };
                if r == 0 {
                    // Orderly EOF: the peer closed (or died — the kernel closes its fds).
                    cancel.store(true, Ordering::Relaxed);
                    eprintln!(
                        "[rfdb-server] Client {} disconnected mid-request — cancelling in-flight work",
                        client_id
                    );
                    return;
                }
                if r > 0 {
                    // Pipelined request bytes are waiting for the main thread — don't
                    // spin on POLLIN while it is busy handling the current request.
                    thread::sleep(Duration::from_millis(200));
                }
                if r < 0 {
                    let errno = std::io::Error::last_os_error();
                    match errno.raw_os_error() {
                        // Spurious wakeup / not actually readable yet.
                        Some(libc::EWOULDBLOCK) | Some(libc::EINTR) => {}
                        // ECONNRESET and anything else fatal: the peer is gone.
                        _ => {
                            cancel.store(true, Ordering::Relaxed);
                            eprintln!(
                                "[rfdb-server] Client {} connection error ({}) — cancelling in-flight work",
                                client_id, errno
                            );
                            return;
                        }
                    }
                }
            }
        }
    });
}

fn handle_client_unix(
    mut stream: UnixStream,
    manager: Arc<DatabaseManager>,
    client_id: usize,
    legacy_mode: bool,
    metrics: Option<Arc<Metrics>>,
) {
    eprintln!("[rfdb-server] Client {} connected", client_id);

    let mut session = ClientSession::new(client_id);

    // W8 Part 1: per-connection cancellation, raised by the disconnect watcher the moment
    // the peer closes. Threaded into every request handler below (`EvalLimits::cancelled`
    // polls it inside the datalog v1/v2 and cypher eval loops). One flag for the whole
    // connection is sound: it is only ever raised on disconnect, after which the read
    // loop terminates anyway.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let watcher_done = Arc::new(AtomicBool::new(false));
    spawn_unix_disconnect_watcher(&stream, Arc::clone(&cancel_flag), Arc::clone(&watcher_done), client_id);

    // In legacy mode (protocol v1), auto-open "default" database.
    // wait_for_database blocks until background load finishes (up to 60s).
    if legacy_mode {
        if let Ok(db) = manager.wait_for_database("default", std::time::Duration::from_secs(60)) {
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
                // W8 Part 1: the per-connection cancel flag (raised by the disconnect
                // watcher) reaches the eval loops via `EvalLimits::cancelled`.
                HandleResult::Single(handle_request_with_cancel(
                    &manager,
                    &mut session,
                    other,
                    &metrics,
                    Arc::clone(&cancel_flag),
                ))
            }
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        // Verbose logging: every request with timing (RFDB_VERBOSE=1)
        if is_verbose() {
            eprintln!("[rfdb] {} {}ms (client {})", op_name, duration_ms, client_id);
        }

        // Record metrics if enabled
        if let Some(ref m) = metrics {
            m.record_query(&op_name, duration_ms);

            // Track timeout/cancelled queries
            if let HandleResult::Single(Response::Error { ref error }) = handle_result {
                if error.contains("timeout") || error.contains("deadline exceeded") {
                    m.record_timeout();
                } else if error.contains("cancelled") {
                    m.record_cancelled();
                }
            }

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
            eprintln!("[rfdb-server] Shutdown requested by client {}, flushing...", client_id);
            // Flush all databases before exit (same as signal handler)
            for db_info in manager.list_databases() {
                if let Ok(db) = manager.get_database(&db_info.name) {
                    if let Ok(mut engine) = db.engine.write() {
                        match engine.flush() {
                            Ok(()) => eprintln!("[rfdb-server] Flushed database '{}'", db_info.name),
                            Err(e) => eprintln!("[rfdb-server] Flush failed for '{}': {}", db_info.name, e),
                        }
                    }
                }
            }
            eprintln!("[rfdb-server] Exiting");
            std::process::exit(0);
        }
    }

    // Stop the disconnect watcher (it also exits by itself on peer EOF).
    watcher_done.store(true, Ordering::Relaxed);

    // Cleanup: close database and release connections
    handle_close_database(&manager, &mut session);
}

// ============================================================================
// WebSocket Client Connection Handler (REG-523)
// ============================================================================

/// Send timeout for WebSocket writes. Protects against slow/stalled clients.
const WS_SEND_TIMEOUT: Duration = Duration::from_secs(60);

async fn handle_client_websocket(
    tcp_stream: tokio::net::TcpStream,
    manager: Arc<DatabaseManager>,
    client_id: usize,
    metrics: Option<Arc<Metrics>>,
) {
    eprintln!("[rfdb-server] WebSocket client {} connected", client_id);

    let ws_stream = match tokio_tungstenite::accept_async(tcp_stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[rfdb-server] WebSocket upgrade failed for client {}: {}", client_id, e);
            return;
        }
    };

    let (mut ws_write, mut ws_read) = ws_stream.split();
    let mut session = Some(ClientSession::new(client_id));
    let mut active_cancel_flag: Option<Arc<AtomicBool>> = None;

    // WebSocket clients MUST send Hello first (no legacy mode)

    loop {
        let msg = match ws_read.next().await {
            Some(Ok(Message::Binary(data))) => data,
            Some(Ok(Message::Close(_))) => {
                eprintln!("[rfdb-server] WebSocket client {} disconnected (Close frame)", client_id);
                break;
            }
            Some(Ok(Message::Text(_))) => {
                eprintln!("[rfdb-server] WebSocket client {} sent text frame (expected binary), ignoring", client_id);
                continue;
            }
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {
                continue;
            }
            Some(Ok(Message::Frame(_))) => {
                continue;
            }
            Some(Err(e)) => {
                eprintln!("[rfdb-server] WebSocket client {} read error: {}", client_id, e);
                break;
            }
            None => {
                eprintln!("[rfdb-server] WebSocket client {} stream closed", client_id);
                break;
            }
        };

        let (request_id, request) = match rmp_serde::from_slice::<RequestEnvelope>(&msg) {
            Ok(env) => (env.request_id, env.request),
            Err(e) => {
                eprintln!("[rfdb-server] WebSocket client {} invalid MessagePack: {}", client_id, e);
                let envelope = ResponseEnvelope {
                    request_id: None,
                    response: Response::Error { error: format!("Invalid request: {}", e) },
                };
                if let Ok(resp_bytes) = rmp_serde::to_vec_named(&envelope) {
                    let _ = timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(resp_bytes))).await;
                }
                continue;
            }
        };

        let is_shutdown = matches!(request, Request::Shutdown);

        // Handle CancelQuery at the transport layer
        if let Request::CancelQuery { request_id: cancel_target } = &request {
            if let Some(ref flag) = active_cancel_flag {
                flag.store(true, Ordering::Relaxed);
                eprintln!("[rfdb-server] WebSocket client {}: cancel requested for {}", client_id, cancel_target);
            }
            let envelope = ResponseEnvelope {
                request_id: request_id.clone(),
                response: Response::Ok { ok: true },
            };
            if let Ok(resp_bytes) = rmp_serde::to_vec_named(&envelope) {
                let _ = timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(resp_bytes))).await;
            }
            continue;
        }

        let start = Instant::now();
        let op_name = get_operation_name(&request);

        // Create a cancellation flag for this request
        let cancel_flag = Arc::new(AtomicBool::new(false));
        active_cancel_flag = Some(Arc::clone(&cancel_flag));

        // Wrap in spawn_blocking because handle_request may block.
        let manager_clone = Arc::clone(&manager);
        let metrics_clone = metrics.clone();
        let mut sess = session.take().unwrap();
        let mut blocking_handle = tokio::task::spawn_blocking(move || {
            let resp = handle_request_with_cancel(&manager_clone, &mut sess, request, &metrics_clone, cancel_flag);
            (resp, sess)
        });

        // Use select! to listen for CancelQuery while the query runs.
        // If a cancel message arrives, set the flag and then await the blocking task.
        let result = loop {
            tokio::select! {
                res = &mut blocking_handle => {
                    break res;
                }
                cancel_msg = ws_read.next() => {
                    if let Some(Ok(Message::Binary(data))) = cancel_msg {
                        if let Ok(env) = rmp_serde::from_slice::<RequestEnvelope>(&data) {
                            if let Request::CancelQuery { .. } = env.request {
                                if let Some(ref flag) = active_cancel_flag {
                                    flag.store(true, Ordering::Relaxed);
                                    eprintln!("[rfdb-server] WebSocket client {}: cancel signal sent", client_id);
                                }
                                let cancel_envelope = ResponseEnvelope {
                                    request_id: env.request_id,
                                    response: Response::Ok { ok: true },
                                };
                                if let Ok(resp_bytes) = rmp_serde::to_vec_named(&cancel_envelope) {
                                    let _ = timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(resp_bytes))).await;
                                }
                            }
                            // Non-cancel messages while a query is running are ignored
                        }
                    } else if cancel_msg.is_none() || matches!(cancel_msg, Some(Ok(Message::Close(_)))) {
                        // Client disconnected — set cancel and wait for task
                        if let Some(ref flag) = active_cancel_flag {
                            flag.store(true, Ordering::Relaxed);
                        }
                        break blocking_handle.await;
                    }
                    // For Ping/Pong/Text/Frame, continue the select loop
                }
            }
        };

        active_cancel_flag = None;

        let response;
        match result {
            Ok((resp, sess_back)) => {
                response = resp;
                session = Some(sess_back);
            }
            Err(e) => {
                eprintln!("[rfdb-server] WebSocket client {} handler panic: {}", client_id, e);
                break;
            }
        }

        if let Some(ref m) = metrics {
            let duration_ms = start.elapsed().as_millis() as u64;
            m.record_query(&op_name, duration_ms);

            if let Response::Error { ref error } = response {
                if error.contains("timeout") || error.contains("deadline exceeded") {
                    m.record_timeout();
                } else if error.contains("cancelled") {
                    m.record_cancelled();
                }
            }

            if duration_ms >= SLOW_QUERY_THRESHOLD_MS {
                eprintln!("[RUST SLOW] {}: {}ms (ws client {})", op_name, duration_ms, client_id);
            }
        }

        let envelope = ResponseEnvelope { request_id: request_id.clone(), response };
        let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("[rfdb-server] WebSocket client {} serialize error: {}", client_id, e);
                // Try to send a fallback error so client doesn't hang
                let fallback = ResponseEnvelope {
                    request_id,
                    response: Response::Error {
                        error: format!("Response serialization failed: {}", e),
                    },
                };
                match rmp_serde::to_vec_named(&fallback) {
                    Ok(fallback_bytes) => {
                        let _ = timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(fallback_bytes))).await;
                    }
                    Err(e2) => {
                        eprintln!("[rfdb-server] WebSocket client {} fallback serialize also failed: {}", client_id, e2);
                        break;
                    }
                }
                continue;
            }
        };

        match timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(resp_bytes))).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                eprintln!("[rfdb-server] WebSocket client {} write error: {}", client_id, e);
                break;
            }
            Err(_) => {
                eprintln!("[rfdb-server] WebSocket client {} write timeout ({}s) - closing connection",
                          client_id, WS_SEND_TIMEOUT.as_secs());
                break;
            }
        }

        if is_shutdown {
            eprintln!("[rfdb-server] Shutdown requested by WebSocket client {}, flushing...", client_id);
            for db_info in manager.list_databases() {
                if let Ok(db) = manager.get_database(&db_info.name) {
                    if let Ok(mut engine) = db.engine.write() {
                        match engine.flush() {
                            Ok(()) => eprintln!("[rfdb-server] Flushed database '{}'", db_info.name),
                            Err(e) => eprintln!("[rfdb-server] Flush failed for '{}': {}", db_info.name, e),
                        }
                    }
                }
            }
            eprintln!("[rfdb-server] Exiting");
            std::process::exit(0);
        }
    }

    if let Some(ref mut sess) = session {
        handle_close_database(&manager, sess);
    }
    eprintln!("[rfdb-server] WebSocket client {} cleaned up", client_id);
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() {
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
        println!("Usage: rfdb-server <db-path> [--socket <socket-path>] [--ws-port <port>] [--http-port <port>] [--data-dir <dir>] [--metrics] [--static-dir <path>] [--no-ui]");
        println!();
        println!("Arguments:");
        println!("  <db-path>      Path to default graph database directory");
        println!("  --socket       Unix socket path (default: /tmp/rfdb.sock)");
        println!("  --ws-port      WebSocket port (1-65535, e.g., 7474, localhost-only)");
        println!("  --http-port    HTTP visualization port (e.g., 3333, for HexGraph GUI)");
        println!("  --data-dir     Base directory for multi-database storage");
        println!("  --static-dir   Override UI with filesystem directory (dev mode)");
        println!();
        println!("Flags:");
        println!("  -V, --version  Print version information");
        println!("  -h, --help     Print this help message");
        println!("  --metrics      Enable performance metrics collection");
        println!("  --federate     Enable federation mode (shard discovery + registration)");
        println!("  --root <path>  Project root this shard covers (default: parent of db-path)");
        println!("  --no-ui        Disable the /ui/* HTTP routes entirely (404 on anything under /ui)");
        std::process::exit(0);
    }

    if args.len() < 2 {
        eprintln!("Usage: rfdb-server <db-path> [--socket <socket-path>] [--ws-port <port>] [--data-dir <dir>] [--metrics]");
        eprintln!("");
        eprintln!("Arguments:");
        eprintln!("  <db-path>      Path to default graph database directory");
        eprintln!("  --socket       Unix socket path (default: /tmp/rfdb.sock)");
        eprintln!("  --ws-port      WebSocket port (1-65535, e.g., 7474, localhost-only)");
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

    let ws_port: Option<u16> = args.iter()
        .position(|a| a == "--ws-port")
        .and_then(|i| args.get(i + 1))
        .map(|s| {
            match s.parse::<u16>() {
                Ok(0) => {
                    eprintln!("[rfdb-server] ERROR: --ws-port 0 is not allowed (port must be 1-65535)");
                    std::process::exit(1);
                }
                Ok(port) => port,
                Err(_) => {
                    eprintln!("[rfdb-server] ERROR: Invalid --ws-port value '{}' (must be 1-65535)", s);
                    std::process::exit(1);
                }
            }
        });

    // `--http-port 0` = OS-assigned free port (dynamic allocation).
    // The actual port is written to `<data_dir>/rfdb-http.port` after bind
    // so clients (VS Code extension, etc.) can discover it without relying
    // on a fixed default that may collide with unrelated processes.
    let http_port: Option<u16> = args.iter()
        .position(|a| a == "--http-port")
        .and_then(|i| args.get(i + 1))
        .map(|s| {
            match s.parse::<u16>() {
                Ok(port) => port,
                Err(_) => {
                    eprintln!("[rfdb-server] ERROR: Invalid --http-port value '{}' (must be 0-65535)", s);
                    std::process::exit(1);
                }
            }
        });

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

    // Parse UI flags. These are forwarded to `http_server::ui_config_from_env`
    // via env vars, which keeps the wiring uniform whether the caller drives
    // via CLI or sets the env var directly (e.g. Docker images).
    if args.iter().any(|a| a == "--no-ui") {
        // Safe: done before any thread spawn that might read env.
        unsafe { std::env::set_var("RFDB_NO_UI", "1"); }
        eprintln!("[rfdb-server] UI disabled (--no-ui)");
    }
    if let Some(i) = args.iter().position(|a| a == "--static-dir") {
        match args.get(i + 1) {
            Some(dir) if !dir.starts_with("--") => {
                let path = PathBuf::from(dir);
                if !path.exists() {
                    eprintln!("[rfdb-server] ERROR: --static-dir path does not exist: {}", dir);
                    std::process::exit(1);
                }
                if !path.is_dir() {
                    eprintln!("[rfdb-server] ERROR: --static-dir path is not a directory: {}", dir);
                    std::process::exit(1);
                }
                unsafe { std::env::set_var("RFDB_STATIC_DIR", &path); }
                eprintln!("[rfdb-server] UI served from filesystem: {}", path.display());
            }
            _ => {
                eprintln!("[rfdb-server] ERROR: --static-dir requires a path argument");
                std::process::exit(1);
            }
        }
    }

    // Parse federation flags
    let federate = args.iter().any(|a| a == "--federate");
    let federation_root: PathBuf = args.iter()
        .position(|a| a == "--root")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Default root: grandparent of db_path (db_path is typically .grafema/graph.rfdb)
            db_path.parent()
                .and_then(|p| p.parent())
                .unwrap_or(&db_path)
                .to_path_buf()
        });

    // Canonicalize root path for consistent shard discovery
    let federation_root = std::fs::canonicalize(&federation_root).unwrap_or(federation_root);

    SERVER_CONFIG.set(ServerConfig {
        federate,
        root: Some(federation_root.clone()),
    }).expect("ServerConfig already set");

    // Federation: register shard in /tmp/rfdb-shards/
    let shard_registration_path: Option<PathBuf> = if federate {
        let shards_dir = PathBuf::from("/tmp/rfdb-shards");
        if let Err(e) = std::fs::create_dir_all(&shards_dir) {
            eprintln!("[rfdb-server] WARNING: Cannot create shard registry dir: {}", e);
            None
        } else {
            // Hash root path to create unique filename
            let hash = {
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                federation_root.hash(&mut hasher);
                format!("{:016x}", hasher.finish())
            };
            let reg_path = shards_dir.join(format!("{}.json", hash));
            let started_epoch = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let registration = serde_json::json!({
                "root": federation_root.display().to_string(),
                "socket": socket_path,
                "wsPort": ws_port,
                "pid": std::process::id(),
                "started": started_epoch,
                "serverVersion": env!("CARGO_PKG_VERSION"),
            });
            match std::fs::write(&reg_path, serde_json::to_string_pretty(&registration).unwrap()) {
                Ok(()) => {
                    eprintln!("[rfdb-server] Federation: registered shard at {:?}", reg_path);
                    eprintln!("[rfdb-server] Federation: territory = {:?}", federation_root);
                    Some(reg_path)
                }
                Err(e) => {
                    eprintln!("[rfdb-server] WARNING: Cannot write shard registration: {}", e);
                    None
                }
            }
        }
    } else {
        None
    };

    // Remove stale socket file
    let _ = std::fs::remove_file(socket_path);

    // Create database manager with data directory
    let manager = Arc::new(DatabaseManager::new(data_dir.clone()));

    eprintln!("[rfdb-server] Data directory for multi-database: {:?}", data_dir);

    // Bind Unix socket BEFORE loading database so clients can connect early.
    // Ping/Hello work without a database; DB-dependent requests will block
    // until background load completes (via wait_for_database).
    //
    // SUN_LEN limit: 104 on macOS, 108 on Linux
    let socket_len = socket_path.len();
    let sun_len: usize = if cfg!(target_os = "macos") { 104 } else { 108 };
    if socket_len >= sun_len {
        eprintln!("[rfdb-server] ERROR: Socket path too long ({} bytes, limit {}):", socket_len, sun_len);
        eprintln!("[rfdb-server]   {}", socket_path);
        eprintln!("[rfdb-server] Your project path is too deep. Use --socket with a shorter path:");
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        socket_path.hash(&mut hasher);
        eprintln!("[rfdb-server]   rfdb-server {} --socket /tmp/rfdb-{:x}.sock",
            db_path.display(), hasher.finish());
        std::process::exit(1);
    }
    let listener = match UnixListener::bind(socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[rfdb-server] ERROR: Failed to bind socket at {}: {}", socket_path, e);
            if e.kind() == std::io::ErrorKind::InvalidInput {
                eprintln!("[rfdb-server] Hint: path may exceed OS socket path limit. Use --socket /tmp/rfdb.sock");
            }
            std::process::exit(1);
        }
    };
    eprintln!("[rfdb-server] Listening on {}", socket_path);

    // Load default database in background so the server can respond to
    // Ping/Hello while the (potentially large) DB is still being read.
    eprintln!("[rfdb-server] Opening default database in background: {:?}", db_path);
    manager.load_default_in_background(db_path.clone());

    // HTTP port lockfile path (written after HTTP bind succeeds, removed on
    // graceful shutdown). `data_dir` is the directory Grafema stores per-db
    // state in, so placing the lockfile next to `rfdb.pid` keeps discovery
    // trivial for clients.
    let http_lockfile_path: PathBuf = data_dir.join("rfdb-http.port");

    // Set up signal handler for graceful shutdown
    let manager_for_signal = Arc::clone(&manager);
    let socket_path_for_signal = socket_path.to_string();
    let shard_reg_for_signal = shard_registration_path.clone();
    let http_lockfile_for_signal = http_lockfile_path.clone();
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

            // Remove HTTP port lockfile so stale readers don't point at a
            // dead process. Harmless if the file was never written (e.g.
            // server started without --http-port).
            let _ = std::fs::remove_file(&http_lockfile_for_signal);

            // Federation: remove shard registration
            if let Some(ref reg_path) = shard_reg_for_signal {
                let _ = std::fs::remove_file(reg_path);
                eprintln!("[rfdb-server] Federation: unregistered shard");
            }

            eprintln!("[rfdb-server] Exiting");
            std::process::exit(0);
        }
    });

    // Bind WebSocket listener (if --ws-port provided)
    let ws_listener = if let Some(port) = ws_port {
        let addr = format!("127.0.0.1:{}", port);
        match TcpListener::bind(&addr).await {
            Ok(listener) => {
                eprintln!("[rfdb-server] WebSocket listening on {}", addr);
                Some(listener)
            }
            Err(e) => {
                eprintln!("[rfdb-server] ERROR: Failed to bind WebSocket port {}: {}", port, e);
                eprintln!("[rfdb-server] Hint: Port may be in use. Try a different port.");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    // Spawn Unix socket accept loop in blocking task
    let manager_unix = Arc::clone(&manager);
    let metrics_unix = metrics.clone();
    let unix_handle = tokio::task::spawn_blocking(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::SeqCst);
                    let manager_clone = Arc::clone(&manager_unix);
                    let metrics_clone = metrics_unix.clone();
                    thread::spawn(move || {
                        // legacy_mode: true until client sends Hello
                        handle_client_unix(stream, manager_clone, client_id, true, metrics_clone);
                    });
                }
                Err(e) => {
                    eprintln!("[rfdb-server] Unix socket accept error: {}", e);
                }
            }
        }
    });

    // Spawn HTTP visualization server (if --http-port provided).
    // Warmup is run SYNCHRONOUSLY before the HTTP listener binds so the
    // first browser request does not race with cache construction. The
    // server is "not accepting" for ~13 seconds on cold start, then every
    // request is ~500ms. This gives a clean UX: "server ready" vs "server
    // accepts requests but first one freezes".
    if let Some(port) = http_port {
        let manager_http = Arc::clone(&manager);
        let workspace_name = rfdb::http_server::derive_workspace_name(&db_path);
        eprintln!(
            "[rfdb-server] workspace_name = {:?} (from db path {:?})",
            workspace_name, db_path
        );
        let http_state = rfdb::http_server::new_state(manager_http, workspace_name);
        let warmup_state = http_state.clone();
        let t_warm = std::time::Instant::now();
        eprintln!("[rfdb-server] warmup: building file→nodes cache and loading persisted layout …");
        let warmup_res = tokio::task::spawn_blocking(move || {
            rfdb::http_server::warmup(&warmup_state);
        })
        .await;
        match warmup_res {
            Ok(()) => eprintln!(
                "[rfdb-server] warmup complete in {}ms — HTTP server is now hot",
                t_warm.elapsed().as_millis()
            ),
            Err(e) => eprintln!("[rfdb-server] warmup task failed: {} (HTTP will still start)", e),
        }
        // Bind synchronously so we can read back the actual port (handles
        // --http-port 0 → OS-assigned). Write the lockfile + emit the
        // canonical "HTTP listening on port N" stderr line BEFORE starting
        // to serve so clients polling the lockfile see the port immediately.
        match rfdb::http_server::bind(http_state, port).await {
            Ok((actual_port, serve)) => {
                eprintln!("[rfdb-server] HTTP listening on port {}", actual_port);
                if let Some(parent) = http_lockfile_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(&http_lockfile_path, actual_port.to_string()) {
                    eprintln!(
                        "[rfdb-server] WARN: failed to write HTTP port lockfile {}: {}",
                        http_lockfile_path.display(),
                        e
                    );
                }
                tokio::spawn(serve);
            }
            Err(e) => {
                eprintln!("[rfdb-server] ERROR: Failed to bind HTTP port {}: {}", port, e);
                eprintln!("[rfdb-server] Hint: Port may be in use. Try --http-port 0 for OS-assigned.");
                std::process::exit(1);
            }
        }
    }

    // Spawn WebSocket accept loop (if enabled)
    let ws_handle = if let Some(ws_listener) = ws_listener {
        let manager_ws = Arc::clone(&manager);
        let metrics_ws = metrics.clone();
        Some(tokio::spawn(async move {
            loop {
                match ws_listener.accept().await {
                    Ok((tcp_stream, addr)) => {
                        eprintln!("[rfdb-server] WebSocket connection from {}", addr);
                        let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::SeqCst);
                        let manager_clone = Arc::clone(&manager_ws);
                        let metrics_clone = metrics_ws.clone();
                        tokio::spawn(handle_client_websocket(
                            tcp_stream,
                            manager_clone,
                            client_id,
                            metrics_clone,
                        ));
                    }
                    Err(e) => {
                        eprintln!("[rfdb-server] WebSocket accept error: {}", e);
                    }
                }
            }
        }))
    } else {
        None
    };

    // Wait for both tasks (or just Unix if WebSocket disabled)
    if let Some(ws) = ws_handle {
        let _ = tokio::try_join!(unix_handle, ws);
    } else {
        let _ = unix_handle.await;
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
    // W8 Part 1: Unix disconnect watcher
    // ============================================================================

    /// Peer closes the socket ⇒ the watcher raises the cancel flag within ~1s.
    #[test]
    fn test_disconnect_watcher_raises_cancel_on_peer_close() {
        let (server_side, client_side) = UnixStream::pair().expect("socketpair");
        let cancel = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        spawn_unix_disconnect_watcher(&server_side, Arc::clone(&cancel), Arc::clone(&done), 999);

        // While the peer is alive (idle), no false cancel within two poll rounds.
        thread::sleep(Duration::from_millis(450));
        assert!(!cancel.load(Ordering::Relaxed), "no cancel while the peer is alive");

        drop(client_side); // the client dies
        let t0 = Instant::now();
        while !cancel.load(Ordering::Relaxed) && t0.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            cancel.load(Ordering::Relaxed),
            "watcher must raise cancel after peer close"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(1),
            "cancel must land within ~1s of disconnect (took {:?})",
            t0.elapsed()
        );
        done.store(true, Ordering::Relaxed);
    }

    /// Pipelined bytes sitting unread in the socket buffer (the next request, sent while
    /// the current one is still being handled) must NOT be consumed by the watcher and
    /// must NOT trigger a false cancel.
    #[test]
    fn test_disconnect_watcher_ignores_pipelined_bytes() {
        use std::io::{Read as _, Write as _};
        let (server_side, mut client_side) = UnixStream::pair().expect("socketpair");
        let cancel = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        spawn_unix_disconnect_watcher(&server_side, Arc::clone(&cancel), Arc::clone(&done), 998);

        client_side.write_all(b"NEXT").expect("write pipelined bytes");
        thread::sleep(Duration::from_millis(600)); // several poll rounds over readable data
        assert!(
            !cancel.load(Ordering::Relaxed),
            "pipelined request bytes are not a disconnect"
        );

        // The bytes are still there for the main loop (MSG_PEEK never consumed them).
        let mut buf = [0u8; 4];
        let mut s = server_side.try_clone().unwrap();
        s.read_exact(&mut buf).expect("read pipelined bytes");
        assert_eq!(&buf, b"NEXT");
        done.store(true, Ordering::Relaxed);
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
                query_count, slow_query_count, node_count, edge_count, shard_diagnostics, ..
            } => {
                assert_eq!(query_count, 2);
                assert_eq!(slow_query_count, 1);
                // No database selected
                assert_eq!(node_count, 0);
                assert_eq!(edge_count, 0);
                assert!(shard_diagnostics.is_empty(), "no db = empty shard_diagnostics");
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

        // MVCC: stats reflect published state only — flush to make the node visible
        handle_request(&manager, &mut session, Request::Flush, &metrics);

        let response = handle_request(&manager, &mut session, Request::GetStats, &metrics);

        match response {
            Response::Stats { node_count, shard_diagnostics, .. } => {
                assert_eq!(node_count, 1);
                assert!(!shard_diagnostics.is_empty(), "should have shard diagnostics");
                let total: usize = shard_diagnostics.iter().map(|s| s.node_count).sum();
                assert_eq!(total, 1, "total nodes across shards");
                // No compaction yet
                for s in &shard_diagnostics {
                    assert!(!s.compacted);
                    assert_eq!(s.l1_node_records, 0);
                    assert!(!s.has_l1_by_type);
                }
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
    // Federation: WhoAreYou
    // ============================================================================

    #[test]
    fn test_who_are_you_returns_shard_identity() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        // Initialize ServerConfig if not yet set (tests may race, ignore error)
        let _ = SERVER_CONFIG.set(ServerConfig {
            federate: false,
            root: Some(PathBuf::from("/test/project")),
        });

        let response = handle_request(&manager, &mut session, Request::WhoAreYou, &None);

        match response {
            Response::ShardIdentity { ok, server_version, federated, .. } => {
                assert!(ok);
                assert!(!server_version.is_empty());
                // federated depends on which test runs first (OnceLock)
                let _ = federated;
            }
            other => panic!("Expected ShardIdentity, got {:?}", other),
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

        // MVCC: reads see published state only — flush to make the nodes visible
        handle_request(&manager, &mut session, Request::Flush, &None);

        // findByAttr with extra field "object"="express" via WireAttrQuery
        let mut extra = std::collections::HashMap::new();
        extra.insert("object".to_string(), serde_json::Value::String("express".to_string()));

        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: Some("CALL".to_string()),
                name: None,
                file: None,
                exported: None,
                substring_match: false,
                extra,
            fuzzy_name_fallback: None,
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
                substring_match: false,
                extra,
            fuzzy_name_fallback: None,
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
                substring_match: false,
                extra: std::collections::HashMap::new(),
            fuzzy_name_fallback: None,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 3, "Without metadata filter, all 3 CALL nodes");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    // ============================================================================
    // FindByAttr with substring_match
    // ============================================================================

    #[test]
    fn test_find_by_attr_name_substring() {
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

        // Add a node with name "handleFooBar"
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "1".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("handleFooBar".to_string()),
                    file: Some("app.js".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
            ],
        }, &None);

        // MVCC: reads see published state only — flush to make the node visible
        handle_request(&manager, &mut session, Request::Flush, &None);

        // Query with substring_match: true, partial name "Foo"
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: None,
                name: Some("Foo".to_string()),
                file: None,
                exported: None,
                substring_match: true,
                extra: std::collections::HashMap::new(),
            fuzzy_name_fallback: None,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1, "Substring 'Foo' should match 'handleFooBar'");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    #[test]
    fn test_find_by_attr_file_substring() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: true,
        }, &None);
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Add a node with a deep file path
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "1".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("getUser".to_string()),
                    file: Some("src/controllers/userController.ts".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
            ],
        }, &None);

        // MVCC: reads see published state only — flush to make the node visible
        handle_request(&manager, &mut session, Request::Flush, &None);

        // Query with substring_match: true, partial file path
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: None,
                name: None,
                file: Some("controllers/user".to_string()),
                exported: None,
                substring_match: true,
                extra: std::collections::HashMap::new(),
            fuzzy_name_fallback: None,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1, "Substring 'controllers/user' should match file path");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    #[test]
    fn test_find_by_attr_exact_default() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: true,
        }, &None);
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "1".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("handleFooBar".to_string()),
                    file: Some("app.js".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
            ],
        }, &None);

        // MVCC: reads see published state only — flush to make the node visible
        handle_request(&manager, &mut session, Request::Flush, &None);

        // substring_match defaults to false — partial name must NOT match
        // fuzzy_name_fallback explicitly disabled so fuzzy doesn't kick in
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: None,
                name: Some("Foo".to_string()),
                file: None,
                exported: None,
                substring_match: false,
                extra: std::collections::HashMap::new(),
                fuzzy_name_fallback: Some(false),
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 0, "Exact match for 'Foo' should NOT match 'handleFooBar'");
            }
            _ => panic!("Expected Ids response"),
        }

        // Exact match with full name SHOULD match
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: None,
                name: Some("handleFooBar".to_string()),
                file: None,
                exported: None,
                substring_match: false,
                extra: std::collections::HashMap::new(),
            fuzzy_name_fallback: None,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1, "Exact match for 'handleFooBar' should find the node");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    #[test]
    fn test_find_by_attr_fuzzy_fallback_returns_results() {
        // When exact match returns 0, fuzzy fallback should find similar names
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: true,
        }, &None);
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Add a node with name "HeartbeatService"
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "heartbeat-svc".to_string(),
                    node_type: Some("CLASS".to_string()),
                    name: Some("HeartbeatService".to_string()),
                    file: Some("services/pty.ts".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
            ],
        }, &None);

        // Compact to build token index
        handle_request(&manager, &mut session, Request::Compact, &None);

        // Search for "PtyHostHeartbeatService" — no exact match exists
        // Fuzzy fallback should find "HeartbeatService" via shared tokens
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                name: Some("PtyHostHeartbeatService".to_string()),
                ..Default::default()
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1,
                    "Fuzzy fallback should find HeartbeatService when searching PtyHostHeartbeatService");
            }
            _ => panic!("Expected Ids response"),
        }

        // Verify fuzzy can be explicitly disabled
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                name: Some("PtyHostHeartbeatService".to_string()),
                fuzzy_name_fallback: Some(false),
                ..Default::default()
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 0,
                    "Fuzzy disabled: PtyHostHeartbeatService should NOT match anything");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    #[test]
    fn test_find_by_attr_empty_query_no_match_all() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: true,
        }, &None);
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Add multiple nodes
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "1".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("alpha".to_string()),
                    file: Some("a.js".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
                WireNode {
                    id: "2".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("beta".to_string()),
                    file: Some("b.js".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
                WireNode {
                    id: "3".to_string(),
                    node_type: Some("VARIABLE".to_string()),
                    name: Some("gamma".to_string()),
                    file: Some("c.js".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
            ],
        }, &None);

        // MVCC: reads see published state only — flush to make the nodes visible
        handle_request(&manager, &mut session, Request::Flush, &None);

        // Empty name with substring_match: true — empty string = no filter
        // Should return all FUNCTION nodes (name filter is skipped)
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: Some("FUNCTION".to_string()),
                name: Some("".to_string()),
                file: None,
                exported: None,
                substring_match: true,
                extra: std::collections::HashMap::new(),
            fuzzy_name_fallback: None,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 2, "Empty name + substring_match should skip name filter, returning all FUNCTION nodes");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    #[test]
    fn test_find_by_attr_substring_no_false_positives() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: true,
        }, &None);
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Add two nodes with distinct names
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "1".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("fooBar".to_string()),
                    file: Some("a.js".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
                WireNode {
                    id: "2".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("bazQux".to_string()),
                    file: Some("b.js".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
            ],
        }, &None);

        // MVCC: reads see published state only — flush to make the nodes visible
        handle_request(&manager, &mut session, Request::Flush, &None);

        // Substring "foo" should match only "fooBar", not "bazQux"
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: None,
                name: Some("foo".to_string()),
                file: None,
                exported: None,
                substring_match: true,
                extra: std::collections::HashMap::new(),
            fuzzy_name_fallback: None,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1, "Substring 'foo' should match only 'fooBar'");
                assert_eq!(ids[0], "1", "Should match node id '1' (fooBar)");
            }
            _ => panic!("Expected Ids response"),
        }
    }

    #[test]
    fn test_find_by_attr_substring_after_flush() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        handle_request(&manager, &mut session, Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: true,
        }, &None);
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        }, &None);

        // Add a node
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode {
                    id: "1".to_string(),
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("processUserData".to_string()),
                    file: Some("src/services/userService.ts".to_string()),
                    exported: false,
                    metadata: None,
                    semantic_id: None,
                },
            ],
        }, &None);

        // Flush to segment — data moves from write buffer to on-disk segment
        // This tests that zone map bypass works correctly for flushed segments
        handle_request(&manager, &mut session, Request::Flush, &None);

        // Substring match on name after flush
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: None,
                name: Some("User".to_string()),
                file: None,
                exported: None,
                substring_match: true,
                extra: std::collections::HashMap::new(),
            fuzzy_name_fallback: None,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1, "Substring 'User' should match 'processUserData' after flush");
            }
            _ => panic!("Expected Ids response"),
        }

        // Substring match on file after flush
        let response = handle_request(&manager, &mut session, Request::FindByAttr {
            query: WireAttrQuery {
                node_type: None,
                name: None,
                file: Some("services/user".to_string()),
                exported: None,
                substring_match: true,
                extra: std::collections::HashMap::new(),
            fuzzy_name_fallback: None,
            },
        }, &None);

        match response {
            Response::Ids { ids } => {
                assert_eq!(ids.len(), 1, "Substring 'services/user' should match file path after flush");
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
                substring_match: false,
                extra,
            fuzzy_name_fallback: None,
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
            protected_types: vec![],
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
            protected_types: vec![],
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
            protected_types: vec![],
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
    /// This exercises the deleted_segment_edge_keys path in GraphStore.
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
            protected_types: vec![],
        }, &None);

        // Verify delta counts
        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 2, "s1 and s2 should be removed");
                assert_eq!(delta.nodes_added, 1, "s4 added");
                // Only outgoing edges from the file's nodes are tombstoned.
                // s1→s2 is outgoing from s1 (in a.js). s3→s1 is outgoing from
                // s3 (in c.js) — it becomes orphaned, filtered by node tombstone.
                assert_eq!(delta.edges_removed, 1, "s1->s2 CONTAINS edge removed");
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // Verify the explicitly tombstoned outgoing edge (s1→s2) is gone.
        // The orphaned incoming edge (s3→s1) remains because only outgoing
        // edges from the file's nodes are tombstoned. The orphaned edge's
        // destination (s1) is tombstoned, so it's meaningless but still
        // visible in get_all_edges (which doesn't filter by node tombstones).
        let edges = handle_request(&manager, &mut session, Request::GetAllEdges, &None);
        match edges {
            Response::Edges { edges } => {
                // Only the orphaned s3→s1 edge remains
                assert_eq!(edges.len(), 1, "Only orphaned s3->s1 edge should remain");
                assert_eq!(edges[0].edge_type, Some("IMPORTS_FROM".to_string()));
            }
            _ => panic!("Expected Edges"),
        }

        // Flush again — the orphaned edge should persist (not duplicated)
        handle_request(&manager, &mut session, Request::Flush, &None);

        let edges_after_flush = handle_request(&manager, &mut session, Request::GetAllEdges, &None);
        match edges_after_flush {
            Response::Edges { edges } => {
                assert_eq!(edges.len(), 1, "Orphaned edge persists after flush");
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
            protected_types: vec![],
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
            protected_types: vec![],
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
            protected_types: vec![],
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
            protected_types: vec![],
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
    fn test_v1_database_rejected() {
        let dir = tempdir().unwrap();
        let manager = Arc::new(DatabaseManager::new(dir.path().to_path_buf()));

        // Create a directory with nodes.bin to simulate legacy v1 database
        let v1_path = dir.path().join("default.rfdb");
        std::fs::create_dir_all(&v1_path).unwrap();
        std::fs::write(v1_path.join("nodes.bin"), b"dummy").unwrap();

        // create_default_from_path should reject v1 databases
        let result = manager.create_default_from_path(&v1_path);
        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(err_msg.contains("Legacy v1 database"), "Error should mention legacy v1 database: {}", err_msg);
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

        // MVCC: reads see published state only — flush to make nodes/edges visible
        handle_request(&manager, &mut session, Request::Flush, &None);

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

        // MVCC: reads see published state only — flush to make nodes/edges visible
        handle_request(&manager, &mut session, Request::Flush, &None);

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

        // MVCC: reads see published state only — flush to make nodes/edges visible
        handle_request(&manager, &mut session, Request::Flush, &None);

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

        // MVCC: reads see published state only — flush to make nodes/edges visible
        handle_request(&manager, &mut session, Request::Flush, &None);

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

        // MVCC: reads see published state only — flush to make nodes/edges visible
        handle_request(&manager, &mut session, Request::Flush, &None);

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

        // MVCC: reads see published state only — flush to make nodes/edges visible
        handle_request(&manager, &mut session, Request::Flush, &None);

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
        // MVCC: reads see published state only — flush to make the nodes visible
        handle_request(manager, session, Request::Flush, &None);
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
            substring_match: false,
            fuzzy_name_fallback: None,
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
            substring_match: false,
            fuzzy_name_fallback: None,
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
            substring_match: false,
            fuzzy_name_fallback: None,
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
            substring_match: false,
            fuzzy_name_fallback: None,
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
                substring_match: false,
                extra: HashMap::new(),
            fuzzy_name_fallback: None,
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
            substring_match: false,
            fuzzy_name_fallback: None,
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
            protected_types: vec![],
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
            protected_types: vec![],
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
            protected_types: vec![],
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
            protected_types: vec![],
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
            protected_types: vec![],
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
            protected_types: vec![],
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

    /// Test that V2 engine (used by DatabaseManager) does NOT flush to disk
    /// on each deferIndex=true CommitBatch. Data remains readable from write
    /// buffers throughout, and RebuildIndexes persists everything.
    #[test]
    fn test_commit_batch_defer_index_v2_no_per_file_flush() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "v2_defer_noop");

        // Send 10 deferred commits, verify data accessible after each
        for i in 0..10 {
            let file = format!("src/file_{i}.js");
            let func_id = format!("f{i}");
            let func_name = format!("func{i}");

            let response = handle_request(&manager, &mut session, Request::CommitBatch {
                changed_files: vec![file.clone()],
                nodes: vec![
                    WireNode {
                        semantic_id: None,
                        id: func_id.clone(),
                        node_type: Some("FUNCTION".to_string()),
                        name: Some(func_name),
                        file: Some(file),
                        exported: false,
                        metadata: None,
                    },
                ],
                edges: vec![],
                tags: None,
                file_context: None,
                defer_index: true,
                protected_types: vec![],
            }, &None);

            match response {
                Response::BatchCommitted { ok, .. } => assert!(ok, "batch {i} should succeed"),
                _ => panic!("Expected BatchCommitted for batch {i}, got {:?}", response),
            }

            // Data should be readable immediately (from write buffer)
            let exists = handle_request(&manager, &mut session, Request::NodeExists {
                id: func_id,
            }, &None);
            match exists {
                Response::Bool { value } => assert!(value, "node f{i} should exist after deferred commit"),
                _ => panic!("Expected Bool for NodeExists"),
            }
        }

        // RebuildIndexes persists everything
        let rebuild = handle_request(&manager, &mut session, Request::RebuildIndexes, &None);
        match rebuild {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok for RebuildIndexes"),
        }

        // All 10 nodes should be queryable after rebuild
        let find = handle_request(&manager, &mut session, Request::FindByType {
            node_type: "FUNCTION".to_string(),
        }, &None);
        match find {
            Response::Ids { ids } => assert_eq!(ids.len(), 10, "All 10 deferred nodes should be findable after rebuild"),
            _ => panic!("Expected Ids"),
        }
    }

    // ============================================================================
    // CommitBatch with protected_types (REG-489)
    // ============================================================================

    /// Test that protected_types preserves nodes of specified types during
    /// commitBatch deletion phase. Simulates INDEXING creating MODULE + FUNCTION,
    /// then ANALYSIS replacing FUNCTION while preserving MODULE.
    #[test]
    fn test_commit_batch_protected_types_preserves_nodes() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "protected_types_test");

        // INDEXING phase: create MODULE and FUNCTION nodes for "app.js"
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "mod1".to_string(), node_type: Some("MODULE".to_string()), name: Some("app".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "fn_old".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("oldFunc".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::Flush, &None);

        // ANALYSIS phase: commitBatch with protectedTypes: ["MODULE"]
        // Should delete FUNCTION (not protected), preserve MODULE (protected), add new FUNCTION
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["app.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "fn_new".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("newFunc".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: false,
            protected_types: vec!["MODULE".to_string()],
        }, &None);

        // Verify delta: only 1 node removed (FUNCTION), MODULE was skipped
        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 1, "Only old FUNCTION should be removed, MODULE is protected");
                assert_eq!(delta.nodes_added, 1, "New FUNCTION should be added");
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // MODULE node should still exist
        let mod_exists = handle_request(&manager, &mut session, Request::NodeExists { id: "mod1".to_string() }, &None);
        match mod_exists { Response::Bool { value } => assert!(value, "MODULE node should survive with protectedTypes"), _ => panic!("Expected Bool") }

        // Old FUNCTION should be gone
        let old_fn_exists = handle_request(&manager, &mut session, Request::NodeExists { id: "fn_old".to_string() }, &None);
        match old_fn_exists { Response::Bool { value } => assert!(!value, "Old FUNCTION should be deleted"), _ => panic!("Expected Bool") }

        // New FUNCTION should exist
        let new_fn_exists = handle_request(&manager, &mut session, Request::NodeExists { id: "fn_new".to_string() }, &None);
        match new_fn_exists { Response::Bool { value } => assert!(value, "New FUNCTION should be added"), _ => panic!("Expected Bool") }
    }

    /// Test that empty protected_types = legacy behavior (all nodes deleted).
    /// This ensures backward compatibility: callers not passing protectedTypes
    /// get the same delete-then-add semantics as before REG-489.
    #[test]
    fn test_commit_batch_empty_protected_types_legacy_behavior() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "empty_protected_test");

        // Create MODULE and FUNCTION nodes for "app.js"
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "mod1".to_string(), node_type: Some("MODULE".to_string()), name: Some("app".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "fn1".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("func1".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::Flush, &None);

        // CommitBatch with empty protectedTypes (legacy behavior)
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["app.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "fn_new".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("newFunc".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
            ],
            edges: vec![],
            tags: None,
            file_context: None,
            defer_index: false,
            protected_types: vec![],
        }, &None);

        // Both MODULE and FUNCTION should be deleted (legacy behavior)
        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 2, "Both MODULE and FUNCTION should be removed with empty protectedTypes");
                assert_eq!(delta.nodes_added, 1);
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // MODULE should NOT exist (was deleted -- legacy behavior)
        let mod_exists = handle_request(&manager, &mut session, Request::NodeExists { id: "mod1".to_string() }, &None);
        match mod_exists { Response::Bool { value } => assert!(!value, "MODULE should be deleted with empty protectedTypes"), _ => panic!("Expected Bool") }

        // New FUNCTION should exist
        let new_fn = handle_request(&manager, &mut session, Request::NodeExists { id: "fn_new".to_string() }, &None);
        match new_fn { Response::Bool { value } => assert!(value, "New FUNCTION should be added"), _ => panic!("Expected Bool") }
    }

    /// Test that edges connected to protected nodes are preserved during
    /// commitBatch deletion phase. When MODULE is protected and has a CONTAINS
    /// edge to a FUNCTION, the edge from an external node to MODULE should survive.
    #[test]
    fn test_commit_batch_protected_node_edges_preserved() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);
        setup_ephemeral_db(&manager, &mut session, "protected_edges_test");

        // Create MODULE with outgoing CONTAINS edge to FUNCTION,
        // and a SERVICE node with CONTAINS edge to MODULE
        handle_request(&manager, &mut session, Request::AddNodes {
            nodes: vec![
                WireNode { semantic_id: None, id: "svc1".to_string(), node_type: Some("SERVICE".to_string()), name: Some("myService".to_string()), file: Some("service.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "mod1".to_string(), node_type: Some("MODULE".to_string()), name: Some("app".to_string()), file: Some("app.js".to_string()), exported: false, metadata: None },
                WireNode { semantic_id: None, id: "fn1".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("handler".to_string()), file: Some("app.js".to_string()), exported: true, metadata: None },
            ],
        }, &None);
        handle_request(&manager, &mut session, Request::AddEdges {
            edges: vec![
                // SERVICE -> MODULE (cross-file edge, should survive because MODULE is protected)
                WireEdge { src: "svc1".to_string(), dst: "mod1".to_string(), edge_type: Some("CONTAINS".to_string()), metadata: None },
                // MODULE -> FUNCTION (intra-file edge from protected to non-protected)
                WireEdge { src: "mod1".to_string(), dst: "fn1".to_string(), edge_type: Some("CONTAINS".to_string()), metadata: None },
            ],
            skip_validation: true,
        }, &None);
        handle_request(&manager, &mut session, Request::Flush, &None);

        // ANALYSIS commitBatch: replace FUNCTION nodes for "app.js", protect MODULE
        let response = handle_request(&manager, &mut session, Request::CommitBatch {
            changed_files: vec!["app.js".to_string()],
            nodes: vec![
                WireNode { semantic_id: None, id: "fn_new".to_string(), node_type: Some("FUNCTION".to_string()), name: Some("newHandler".to_string()), file: Some("app.js".to_string()), exported: true, metadata: None },
            ],
            edges: vec![
                // Re-create MODULE -> new FUNCTION edge
                WireEdge { src: "mod1".to_string(), dst: "fn_new".to_string(), edge_type: Some("CONTAINS".to_string()), metadata: None },
            ],
            tags: None,
            file_context: None,
            defer_index: false,
            protected_types: vec!["MODULE".to_string()],
        }, &None);

        match response {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                // Only fn1 deleted, mod1 preserved
                assert_eq!(delta.nodes_removed, 1, "Only FUNCTION should be removed");
                assert_eq!(delta.nodes_added, 1, "New FUNCTION should be added");
            }
            _ => panic!("Expected BatchCommitted, got {:?}", response),
        }

        // MODULE should still exist
        let mod_exists = handle_request(&manager, &mut session, Request::NodeExists { id: "mod1".to_string() }, &None);
        match mod_exists { Response::Bool { value } => assert!(value, "MODULE should survive"), _ => panic!("Expected Bool") }

        // Check SERVICE -> MODULE edge survived (cross-file edge to protected node)
        // Use string_to_id to get the internal numeric ID for comparison
        let mod1_numeric = id_to_string(string_to_id("mod1"));
        let fn_new_numeric = id_to_string(string_to_id("fn_new"));

        let svc_edges = handle_request(&manager, &mut session, Request::GetOutgoingEdges {
            id: "svc1".to_string(),
            edge_types: None,
        }, &None);
        match svc_edges {
            Response::Edges { edges } => {
                let contains_to_mod = edges.iter().find(|e| e.dst == mod1_numeric && e.edge_type.as_deref() == Some("CONTAINS"));
                assert!(contains_to_mod.is_some(),
                    "SERVICE -> MODULE CONTAINS edge should survive because MODULE is protected. Found edges: {:?}", edges);
            }
            _ => panic!("Expected Edges response"),
        }

        // Check MODULE -> new FUNCTION edge was added
        let mod_edges = handle_request(&manager, &mut session, Request::GetOutgoingEdges {
            id: "mod1".to_string(),
            edge_types: None,
        }, &None);
        match mod_edges {
            Response::Edges { edges } => {
                let contains_to_fn = edges.iter().find(|e| e.dst == fn_new_numeric && e.edge_type.as_deref() == Some("CONTAINS"));
                assert!(contains_to_fn.is_some(),
                    "MODULE -> new FUNCTION CONTAINS edge should exist from the batch. Found edges: {:?}", edges);
            }
            _ => panic!("Expected Edges response"),
        }
    }

    // ============================================================================
    // RFDB_DERIVE_ENGINE router — kill switch path selection (spec P3, I8)
    //
    // These assertions check the CHOSEN ENGINE PATH, not result equality between the
    // two engines. Since Final #12, the derive engine is the DEFAULT (unset → derive);
    // the query engine is selected only with the explicit off-switch
    // RFDB_DERIVE_ENGINE=off. Explain requests are the one documented exception:
    // always served by the query engine.
    // ============================================================================

    /// Serialize the env-var mutations: `derive_engine_enabled()` reads a process-global,
    /// and Rust runs tests in parallel, so the two router tests must not race on it.
    static DERIVE_ENGINE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The kill-switch predicate (Final #12 default flip): the derive engine by default,
    /// the query engine only with the explicit off-switch `RFDB_DERIVE_ENGINE=off`.
    #[test]
    fn derive_router_on_by_default() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();

        // Unset → derive (THE default since Final #12).
        std::env::remove_var("RFDB_DERIVE_ENGINE");
        assert!(derive_engine_enabled(), "unset RFDB_DERIVE_ENGINE must select the derive engine (the default)");

        // "off" → query engine (the defined off-switch, case-insensitive).
        std::env::set_var("RFDB_DERIVE_ENGINE", "off");
        assert!(!derive_engine_enabled(), "RFDB_DERIVE_ENGINE=off must select the query engine");
        std::env::set_var("RFDB_DERIVE_ENGINE", "OFF");
        assert!(!derive_engine_enabled(), "RFDB_DERIVE_ENGINE=OFF (case-insensitive) must select the query engine");

        // Anything else (the pre-flip opt-ins, now redundant no-ops) → derive.
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");
        assert!(derive_engine_enabled(), "RFDB_DERIVE_ENGINE=on must select the derive engine");
        std::env::set_var("RFDB_DERIVE_ENGINE", "1");
        assert!(derive_engine_enabled(), "RFDB_DERIVE_ENGINE=1 must select the derive engine (pre-flip opt-in stays on)");

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// Final #12 capability contract: the server advertises `datalogDerive` in Hello
    /// BY DEFAULT (the derive engine is the default), and STOPS advertising it under the
    /// explicit off-switch — which is exactly what the orchestrator's fail-fast capability
    /// gate checks (Wave 6 removed the legacy fallback: a server without the capability
    /// is refused, not worked around).
    #[test]
    fn hello_advertises_derive_materialize_by_default_and_not_when_off() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
        let (_dir, manager) = setup_test_manager();

        let hello = |manager: &DatabaseManager| {
            let mut session = ClientSession::new(1);
            match handle_request(
                manager,
                &mut session,
                Request::Hello { protocol_version: Some(2), client_id: None },
                &None,
            ) {
                Response::HelloOk { features, .. } => features,
                other => panic!("expected HelloOk, got {other:?}"),
            }
        };

        // Default (unset) → the capability is advertised.
        std::env::remove_var("RFDB_DERIVE_ENGINE");
        assert!(
            hello(&manager).contains(&"datalogDerive".to_string()),
            "default Hello must advertise datalogDerive (v2 is the default engine)"
        );

        // Explicit off-switch → NOT advertised; the orchestrator then runs the legacy
        // P3 DEPENDS_ON derivation and retires no first-pass resolve step.
        std::env::set_var("RFDB_DERIVE_ENGINE", "off");
        assert!(
            !hello(&manager).contains(&"datalogDerive".to_string()),
            "RFDB_DERIVE_ENGINE=off must suppress the capability (legacy P3 fallback path)"
        );

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// `MaterializeDatalog` dispatch (the release-blocker write path): kill-switch-gated and
    /// derive-engine-only. With the switch OFF it refuses with an explicit coded error (legacy DEPENDS_ON
    /// runs in the orchestrator, P3) and writes nothing; with it ON, a `@materialize` program
    /// over a committed IMPORTS_FROM graph writes the DEPENDS_ON edge in one generation and a
    /// follow-up v2 read sees it. This is the path the orchestrator will call instead of its
    /// in-process derivation.
    #[test]
    fn dispatch_materialize_datalog_gated_and_writes_edges() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();

        // Real ephemeral v2 engine: module `a` IMPORTS_FROM module `b`.
        let mut engine = GraphEngineV2::create_ephemeral();
        let mk_node = |sid: &str, ty: &str| NodeRecord {
            id: string_to_id(sid),
            node_type: Some(ty.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(sid.to_string()),
            file: Some(format!("{sid}.js")),
            metadata: None,
            semantic_id: Some(sid.to_string()),
        };
        engine.add_nodes(vec![mk_node("a", "MODULE"), mk_node("b", "MODULE")]);
        engine.add_edges(
            vec![EdgeRecord {
                src: string_to_id("a"),
                dst: string_to_id("b"),
                edge_type: Some("IMPORTS_FROM".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            true,
        );
        engine.flush().unwrap();

        let cf = || Arc::new(AtomicBool::new(false));
        // A binary @materialize head projects to a DEPENDS_ON edge per derived pair.
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;

        // ── Switch OFF → refused (coded), nothing written (P3 legacy path owns it). ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "off");
        let off = dispatch_materialize_datalog(&mut engine, src, cf());
        assert!(off.is_err(), "materialize must be refused when the kill switch is off");
        assert!(
            off.unwrap_err().contains("derive-engine-only"),
            "the refusal must be the explicit derive-engine-only coded error (P3), not a silent no-op"
        );

        // ── Switch ON → one DEPENDS_ON edge written in one generation. ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");
        let written = dispatch_materialize_datalog(&mut engine, src, cf())
            .expect("materialize must succeed under the derive engine");
        assert_eq!(written, 1, "exactly one IMPORTS_FROM → one DEPENDS_ON");

        // A follow-up v2 read sees the materialized edge (committed + visible).
        let read_src = r#"result(X, Y) :- edge(X, Y, "DEPENDS_ON")."#;
        match dispatch_execute_datalog(&engine, read_src, false, cf()) {
            Ok(DatalogResponse::Violations(v)) => {
                assert_eq!(v.len(), 1, "the committed DEPENDS_ON edge must be readable");
                assert_eq!(v[0].bindings.get("X").map(String::as_str), Some(string_to_id("a").to_string().as_str()));
                assert_eq!(v[0].bindings.get("Y").map(String::as_str), Some(string_to_id("b").to_string().as_str()));
            }
            Ok(DatalogResponse::Explain(_)) => panic!("expected violations, got an explain result"),
            Err(e) => panic!("v2 read of DEPENDS_ON failed: {e}"),
        }

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// The `@stdlib/` pack-resolution wire contract on the dispatchers: `"@stdlib/depends"`
    /// is the named alias of the empty-source default (same program, idempotent across the
    /// two spellings), every registered pack name resolves and RUNS (zero derivations on a
    /// graph without its inputs — never a resolution error), an unknown `@stdlib/<name>` is
    /// the coded `E-MAT-007` error naming the pack and listing the known packs, and the
    /// READ dispatchers share the same resolver.
    #[test]
    fn dispatch_materialize_datalog_resolves_stdlib_packs() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");

        // Module `a` IMPORTS_FROM module `b` — the depends.dl input shape.
        let mut engine = GraphEngineV2::create_ephemeral();
        let mk_node = |sid: &str, ty: &str| NodeRecord {
            id: string_to_id(sid),
            node_type: Some(ty.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(sid.to_string()),
            file: Some(format!("{sid}.js")),
            metadata: None,
            semantic_id: Some(sid.to_string()),
        };
        engine.add_nodes(vec![mk_node("a", "MODULE"), mk_node("b", "MODULE")]);
        engine.add_edges(
            vec![EdgeRecord {
                src: string_to_id("a"),
                dst: string_to_id("b"),
                edge_type: Some("IMPORTS_FROM".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            true,
        );
        engine.flush().unwrap();
        let cf = || Arc::new(AtomicBool::new(false));

        // "@stdlib/depends" writes the DEPENDS_ON edge; the empty-source spelling then
        // re-runs the SAME program and adds nothing — alias ≡ default, proven on output.
        let written = dispatch_materialize_datalog(&mut engine, "@stdlib/depends", cf())
            .expect("@stdlib/depends must resolve and run");
        assert_eq!(written, 1, "one IMPORTS_FROM → one DEPENDS_ON via the named alias");
        let again = dispatch_materialize_datalog(&mut engine, "", cf())
            .expect("empty source must keep resolving to the bundled depends.dl");
        assert_eq!(again, 0, "the empty-source default is the same program (idempotent)");

        // Every other registered pack resolves and runs (no inputs here → 0 edges).
        for pack in [
            "@stdlib/js_local_refs",
            "@stdlib/js_same_file_calls",
            "@stdlib/js_this_method_calls",
            "@stdlib/rust_calls",
            "@stdlib/rust_cross_methods_ctor",
            "@stdlib/rust_trait_resolve",
            "@stdlib/rust_receiver_typing",
            "@stdlib/js_import_bindings",
            "@stdlib/js_class_inheritance",
            "@stdlib/js_cross_file_calls",
            "@stdlib/js_property_access_ns",
            "@stdlib/js_property_access_full",
            "@stdlib/method_calls",
            "@stdlib/shape_verifier",
            "@stdlib/axum_routes",
        ] {
            let n = dispatch_materialize_datalog(&mut engine, pack, cf())
                .unwrap_or_else(|e| panic!("{pack} must resolve and run: {e}"));
            assert_eq!(n, 0, "{pack} has no inputs on this graph — zero edges, no error");
        }

        // Unknown pack: coded, names the pack, lists the known packs — never silently
        // parsed as program text.
        let err = dispatch_materialize_datalog(&mut engine, "@stdlib/bogus", cf())
            .expect_err("unknown stdlib pack must be a coded error");
        assert!(err.contains("E-MAT-007"), "must carry the E-MAT-007 code: {err}");
        assert!(err.contains("@stdlib/bogus"), "must name the unknown pack: {err}");
        for known in [
            "@stdlib/depends",
            "@stdlib/js_local_refs",
            "@stdlib/js_same_file_calls",
            "@stdlib/js_this_method_calls",
            "@stdlib/rust_calls",
            "@stdlib/rust_cross_methods_ctor",
            "@stdlib/rust_trait_resolve",
            "@stdlib/rust_receiver_typing",
            "@stdlib/js_import_bindings",
            "@stdlib/js_class_inheritance",
            "@stdlib/js_cross_file_calls",
            "@stdlib/js_property_access_ns",
            "@stdlib/js_property_access_full",
            "@stdlib/method_calls",
            "@stdlib/shape_verifier",
            "@stdlib/axum_routes",
        ] {
            assert!(err.contains(known), "must list known pack {known}: {err}");
        }

        // The READ dispatchers share the resolver (factored, not copy-pasted).
        let read_err = dispatch_explain_datalog_fact(&engine, "@stdlib/bogus", "depends", &[], cf())
            .expect_err("explain_fact must reject the unknown pack too");
        assert!(read_err.contains("E-MAT-007"), "shared E-MAT-007 path: {read_err}");

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// Gate E: `ExplainDatalogFact` (why()) returns ONE supporting derivation of a derived fact,
    /// is derive-engine-only (refused with the kill switch off, I5), and yields a NULL witness for a fact the
    /// program cannot derive — a true negative, distinct from an error.
    #[test]
    fn dispatch_explain_datalog_fact_returns_witness_and_gates_off() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();

        // Module `a` (file a.js) imports module `b` (file b.js) → depends(a,b) via depends.dl.
        let mut engine = GraphEngineV2::create_ephemeral();
        let mk_node = |sid: &str, ty: &str| NodeRecord {
            id: string_to_id(sid),
            node_type: Some(ty.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(sid.to_string()),
            file: Some(format!("{sid}.js")),
            metadata: None,
            semantic_id: Some(sid.to_string()),
        };
        engine.add_nodes(vec![mk_node("a", "MODULE"), mk_node("b", "MODULE")]);
        engine.add_edges(
            vec![EdgeRecord {
                src: string_to_id("a"),
                dst: string_to_id("b"),
                edge_type: Some("IMPORTS_FROM".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            true,
        );
        engine.flush().unwrap();

        let cf = || Arc::new(AtomicBool::new(false));
        let a = string_to_id("a").to_string();
        let b = string_to_id("b").to_string();

        // ── Kill switch OFF → refused (coded), no v2 why(). ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "off");
        let off = dispatch_explain_datalog_fact(&engine, "", "depends", &[a.clone(), b.clone()], cf());
        assert!(off.is_err(), "explain_fact must be refused when the kill switch is off");
        assert!(off.unwrap_err().contains("derive-engine-only"), "explicit derive-engine-only coded refusal (P3/I5)");

        // ── Kill switch ON → a derivable fact yields a witness (deriving rule + body facts). ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");
        let witness = dispatch_explain_datalog_fact(&engine, "", "depends", &[a.clone(), b.clone()], cf())
            .expect("explain succeeds under v2")
            .expect("depends(a,b) is derivable → Some witness");
        assert!(!witness.rule_ast_hash.is_empty(), "witness names the deriving rule (its _source hash)");
        assert!(
            witness.body.iter().any(|f| f.predicate == "edge"
                && f.tuple.iter().any(|t| t == "IMPORTS_FROM")),
            "the IMPORTS_FROM base fact supports the derivation: {:?}",
            witness.body
        );

        // ── A non-derivable fact → NULL witness (true negative, not an error). ──
        let none = dispatch_explain_datalog_fact(&engine, "", "depends", &[b, a], cf())
            .expect("explain succeeds under v2");
        assert!(none.is_none(), "depends(b,a) is not derivable (only a→b imports) → null witness");

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// Owner ruling R-14 end-to-end: a TYPED integer key survives the wire and reaches the
    /// engine. The rule head carries a bare `1`, which the derive parser types as
    /// `Value::Int(1)` — so the fact is `numbered(<id>, Int(1))`, NOT `numbered(<id>, Id(1))`.
    /// Before the wire codec the two-arm parser turned every all-digit key into `Value::Id`,
    /// so this fact was unexplainable through the protocol at all; now `~int:1` names it and
    /// the untagged `1` correctly names the DIFFERENT (non-existent) `Id(1)` fact.
    #[test]
    fn explain_fact_reads_a_typed_integer_key_off_the_wire() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");

        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![NodeRecord {
            id: string_to_id("m"),
            node_type: Some("MODULE".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("m".to_string()),
            file: Some("m.js".to_string()),
            metadata: None,
            semantic_id: Some("m".to_string()),
        }]);
        engine.flush().unwrap();

        let src = r#"numbered(X, 1) :- node(X, "MODULE")."#;
        let cf = || Arc::new(AtomicBool::new(false));
        let m = string_to_id("m").to_string();

        // Tagged: the key parses to Value::Int(1) — the value the head literal produces.
        let typed = dispatch_explain_datalog_fact(
            &engine,
            src,
            "numbered",
            &[m.clone(), "~int:1".to_string()],
            cf(),
        )
        .expect("explain succeeds under v2")
        .expect("numbered(m, Int(1)) is derivable → Some witness");
        assert!(
            !typed.rule_ast_hash.is_empty(),
            "witness names the deriving rule"
        );

        // Untagged: the same digits mean the node id Value::Id(1) — a different fact, and one
        // the program does not derive. The two readings are now distinguishable on the wire.
        let as_node_id =
            dispatch_explain_datalog_fact(&engine, src, "numbered", &[m, "1".to_string()], cf())
                .expect("explain succeeds under v2");
        assert!(
            as_node_id.is_none(),
            "untagged `1` is the node id Id(1), which numbered/2 never derives → null witness"
        );

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// R-14, the OTHER half: the query/sim surface and the explain surface speak the SAME
    /// wire grammar, so a value that comes OUT of one can go straight INTO the other.
    ///
    /// This is the property the engine's own what-if loop rests on ("a coverage gap names an
    /// unbound premise; sim proves a candidate edge closes it" — `GraphEngineV2::sim_derive`):
    /// closing it means copying a row element into an `explainDatalogFact` key. It holds only
    /// because `engine_v2::value_to_wire_string` renders through THE codec instead of a local
    /// copy — restore the copy's `Int(i) => i.to_string()` arm and the binding below is `"1"`,
    /// which the explain path reads as the node id `Id(1)`, so the witness comes back `None`.
    #[test]
    fn a_query_row_element_is_a_valid_explain_key_for_the_same_fact() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");

        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![NodeRecord {
            id: string_to_id("m"),
            node_type: Some("MODULE".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("m".to_string()),
            file: Some("m.js".to_string()),
            metadata: None,
            semantic_id: Some("m".to_string()),
        }]);
        engine.flush().unwrap();

        // Two rules on purpose: the inner head carries the integer LITERAL, the outer binds it
        // to a variable — so `N` is a real result column (a constant head column is not
        // surfaced as a binding at all) carrying `Value::Int(1)`.
        let src = r#"numbered(X, N) :- one(X, N).
one(X, 1) :- node(X, "MODULE")."#;
        let cf = || Arc::new(AtomicBool::new(false));
        let m = string_to_id("m").to_string();

        // 1. Ask the QUERY surface (queryDatalog/checkGuarantee → WireViolation bindings).
        let violations = match dispatch_execute_datalog(&engine, src, false, cf())
            .expect("derive-engine query succeeds")
        {
            DatalogResponse::Violations(v) => v,
            _ => panic!("derive-engine query must answer with Violations"),
        };
        assert_eq!(violations.len(), 1, "one MODULE ⇒ one numbered/2 fact");
        let n = violations[0]
            .bindings
            .get("N")
            .expect("column N is bound")
            .clone();

        // 2. It is TYPED on the wire — the integer literal, not a bare decimal that the
        //    explain path would re-read as a node id.
        assert_eq!(
            n, "~int:1",
            "the query surface renders Int(1) through the codec"
        );

        // 3. Paste it straight back in as an explain key. Same text, same fact, real witness.
        let witness =
            dispatch_explain_datalog_fact(&engine, src, "numbered", &[m.clone(), n.clone()], cf())
                .expect("explain succeeds under v2")
                .expect("the query row names a derivable fact → Some witness");
        assert!(
            !witness.rule_ast_hash.is_empty(),
            "witness names the deriving rule"
        );

        // 4. The SIM surface agrees byte-for-byte: a hypothetical MODULE yields the same typed
        //    column, so a predicted row is addressable exactly the same way.
        let sim_rows = dispatch_sim_datalog(
            &engine,
            src,
            "numbered",
            &[WireSimNode {
                id: string_to_id("hypothetical").to_string(),
                node_type: "MODULE".to_string(),
                name: "hypothetical".to_string(),
                file: "h.js".to_string(),
            }],
            &[],
            cf(),
        )
        .expect("sim succeeds under v2");
        assert_eq!(
            sim_rows.len(),
            1,
            "only the hypothetical module's fact is new"
        );
        assert_eq!(
            sim_rows[0][1], n,
            "sim renders the same value with the same bytes as query and explain"
        );

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// Decision #2 wire: `SimDatalog` (what-if) predicts the NEW facts a hypothetical overlay
    /// would create — WITHOUT committing — and is derive-engine-only (coded refusal with the switch off).
    /// Overlay: a hypothetical MODULE `c` + a hypothetical IMPORTS_FROM b→c over a committed
    /// a→b graph ⇒ predicts depends(b,c) (and ONLY the new fact: depends(a,b) is base, excluded
    /// by sim ∖ base). A follow-up read proves nothing was written.
    #[test]
    fn dispatch_sim_datalog_predicts_new_facts_without_commit_and_gates_off() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();

        let mut engine = GraphEngineV2::create_ephemeral();
        let mk_node = |sid: &str, ty: &str| NodeRecord {
            id: string_to_id(sid),
            node_type: Some(ty.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(sid.to_string()),
            file: Some(format!("{sid}.js")),
            metadata: None,
            semantic_id: Some(sid.to_string()),
        };
        engine.add_nodes(vec![mk_node("a", "MODULE"), mk_node("b", "MODULE")]);
        engine.add_edges(
            vec![EdgeRecord {
                src: string_to_id("a"),
                dst: string_to_id("b"),
                edge_type: Some("IMPORTS_FROM".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            true,
        );
        engine.flush().unwrap();

        let cf = || Arc::new(AtomicBool::new(false));
        let b = string_to_id("b").to_string();
        let c_id: u128 = 424242;
        let hyp_nodes = vec![WireSimNode {
            id: c_id.to_string(),
            node_type: "MODULE".to_string(),
            name: "c".to_string(),
            file: "c.js".to_string(),
        }];
        let hyp_edges = vec![WireSimEdge {
            src: b.clone(),
            dst: c_id.to_string(),
            edge_type: "IMPORTS_FROM".to_string(),
        }];

        // ── Kill switch OFF → refused (coded), no v2 sim. ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "off");
        let off = dispatch_sim_datalog(&engine, "", "depends", &hyp_nodes, &hyp_edges, cf());
        assert!(off.is_err(), "sim must be refused when the kill switch is off");
        assert!(off.unwrap_err().contains("derive-engine-only"), "explicit derive-engine-only coded refusal (I5)");

        // ── Kill switch ON → exactly the NEW fact depends(b,c); base depends(a,b) excluded. ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");
        let rows = dispatch_sim_datalog(&engine, "", "depends", &hyp_nodes, &hyp_edges, cf())
            .expect("sim succeeds under v2");
        assert_eq!(
            rows,
            vec![vec![b.clone(), c_id.to_string()]],
            "sim ∖ base = the one predicted fact depends(b,c)"
        );

        // ── Nothing was committed: no DEPENDS_ON edges, and node `c` does not exist. ──
        let read_src = r#"result(X, Y) :- edge(X, Y, "DEPENDS_ON")."#;
        match dispatch_execute_datalog(&engine, read_src, false, cf()) {
            Ok(DatalogResponse::Violations(v)) => {
                assert!(v.is_empty(), "sim must not write anything: {v:?}");
            }
            Ok(DatalogResponse::Explain(_)) => panic!("expected violations, got explain"),
            Err(e) => panic!("post-sim read failed: {e}"),
        }

        // ── A non-numeric hypothetical id is an explicit input error, not a silent skip. ──
        let bad = vec![WireSimEdge {
            src: "not-a-number".to_string(),
            dst: b,
            edge_type: "IMPORTS_FROM".to_string(),
        }];
        let err = dispatch_sim_datalog(&engine, "", "depends", &[], &bad, cf());
        assert!(err.is_err(), "non-numeric wire id must be a coded input error");

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// Decision #2 wire: `ExplainDatalogGap` (why-not) names the first unsatisfiable premise of
    /// a missing fact, returns NULL for a derivable fact (no gap — the dual of explain_fact),
    /// and is derive-engine-only (coded refusal with the switch off, I5).
    #[test]
    fn dispatch_explain_datalog_gap_names_missing_premise_and_gates_off() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();

        let mut engine = GraphEngineV2::create_ephemeral();
        let mk_node = |sid: &str, ty: &str| NodeRecord {
            id: string_to_id(sid),
            node_type: Some(ty.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(sid.to_string()),
            file: Some(format!("{sid}.js")),
            metadata: None,
            semantic_id: Some(sid.to_string()),
        };
        engine.add_nodes(vec![mk_node("a", "MODULE"), mk_node("b", "MODULE")]);
        engine.add_edges(
            vec![EdgeRecord {
                src: string_to_id("a"),
                dst: string_to_id("b"),
                edge_type: Some("IMPORTS_FROM".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            true,
        );
        engine.flush().unwrap();

        let cf = || Arc::new(AtomicBool::new(false));
        let a = string_to_id("a").to_string();
        let b = string_to_id("b").to_string();

        // ── Kill switch OFF → refused (coded), no v2 why-not. ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "off");
        let off = dispatch_explain_datalog_gap(&engine, "", "depends", &[b.clone(), a.clone()], cf());
        assert!(off.is_err(), "explain_gap must be refused when the kill switch is off");
        assert!(off.unwrap_err().contains("derive-engine-only"), "explicit derive-engine-only coded refusal (I5)");

        // ── Kill switch ON → the missing fact depends(b,a) gets a gap witness naming the
        //    unsatisfiable premise (no IMPORTS_FROM b→a). ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");
        let gap = dispatch_explain_datalog_gap(&engine, "", "depends", &[b.clone(), a.clone()], cf())
            .expect("explain_gap succeeds under v2")
            .expect("depends(b,a) is not derivable → Some gap witness");
        assert!(!gap.rule_ast_hash.is_empty(), "the gap names the rule it characterizes");
        assert!(!gap.failing_predicate.is_empty(), "the gap names the unsatisfiable premise");
        assert!(!gap.failing_is_negative, "the missing premise here is positive (an absent edge)");

        // ── A derivable fact → NULL gap (true 'no gap', distinct from an error). ──
        let none = dispatch_explain_datalog_gap(&engine, "", "depends", &[a, b], cf())
            .expect("explain_gap succeeds under v2");
        assert!(none.is_none(), "depends(a,b) IS derivable → no gap");

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// The PROD path: an EMPTY `source` runs the server's bundled canonical `depends.dl`
    /// (file-attr join), so the orchestrator triggers DEPENDS_ON derivation without shipping
    /// the rule text. A module `a` (file a.js) importing module `b` (file b.js) must derive
    /// exactly one `a -DEPENDS_ON-> b` edge — and crucially via the `file` ATTR, the
    /// derivation that is correct on the `MODULE#` sids the legacy parser drops.
    #[test]
    fn dispatch_materialize_empty_source_runs_bundled_depends() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();

        let mut engine = GraphEngineV2::create_ephemeral();
        let mk_node = |sid: &str, file: &str| NodeRecord {
            id: string_to_id(sid),
            node_type: Some("MODULE".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(sid.to_string()),
            file: Some(file.to_string()),
            metadata: None,
            semantic_id: Some(sid.to_string()),
        };
        // Mirror the Haskell shape the legacy parser drops: a `MODULE#`-prefixed sid whose
        // `file` attr is the real path. depends.dl joins on the attr, so it must still resolve.
        engine.add_nodes(vec![
            mk_node("MODULE#a.hs", "a.hs"),
            mk_node("MODULE#b.hs", "b.hs"),
        ]);
        engine.add_edges(
            vec![EdgeRecord {
                src: string_to_id("MODULE#a.hs"),
                dst: string_to_id("MODULE#b.hs"),
                edge_type: Some("IMPORTS_FROM".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            true,
        );
        engine.flush().unwrap();

        std::env::set_var("RFDB_DERIVE_ENGINE", "on");
        let cf = Arc::new(AtomicBool::new(false));
        // Empty source ⇒ bundled stdlib depends.dl.
        let written = dispatch_materialize_datalog(&mut engine, "", cf)
            .expect("bundled depends materialize must succeed");
        assert_eq!(
            written, 1,
            "bundled depends.dl must derive one DEPENDS_ON via the file attr, even for MODULE# sids"
        );

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// End-to-end: the dispatch helper routes non-explain requests through v2 storage by
    /// DEFAULT (Final #12) and through v1 under the off-switch — and `explain` is served
    /// (by the query engine, the deliberate documented routing) under EVERY switch state,
    /// because with v2 the default an explain refusal would break the product explain
    /// surface. A real orphan-FUNCTION program is run against a flushed ephemeral
    /// GraphEngineV2 so the derive path genuinely evaluates over real storage_v2, not the
    /// in-memory fixture.
    #[test]
    fn derive_router_selects_engine_path() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();

        // Build a real ephemeral v2 engine: one CLASS contains fnA; fnB is orphaned.
        let mut engine = GraphEngineV2::create_ephemeral();
        let mk_node = |sid: &str, ty: &str| NodeRecord {
            id: string_to_id(sid),
            node_type: Some(ty.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(sid.to_string()),
            file: Some("f.js".to_string()),
            metadata: None,
            semantic_id: Some(sid.to_string()),
        };
        engine.add_nodes(vec![
            mk_node("cls", "CLASS"),
            mk_node("fnA", "FUNCTION"),
            mk_node("fnB", "FUNCTION"),
        ]);
        engine.add_edges(
            vec![EdgeRecord {
                src: string_to_id("cls"),
                dst: string_to_id("fnA"),
                edge_type: Some("CONTAINS".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            true,
        );
        // v2 reads the PUBLISHED snapshot — flush so the data is visible.
        engine.flush().unwrap();

        let cf = || Arc::new(AtomicBool::new(false));
        let src = r#"violation(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS")."#;

        // ── DEFAULT (unset) → the derive engine serves non-explain requests. ──
        std::env::remove_var("RFDB_DERIVE_ENGINE");

        // The v2 fixpoint runs over real storage and flags exactly the orphan
        // FUNCTION (fnB) over the PUBLISHED snapshot.
        match dispatch_check_guarantee(&engine, src, false, cf()) {
            Ok(DatalogResponse::Violations(violations)) => {
                let ids: Vec<String> = violations
                    .iter()
                    .filter_map(|v| v.bindings.get("X").cloned())
                    .collect();
                assert_eq!(
                    ids,
                    vec![string_to_id("fnB").to_string()],
                    "default (v2) path must flag exactly the orphan FUNCTION"
                );
            }
            other => panic!("expected v2 Violations, got error/explain: {:?}", other.err()),
        }

        // Explain under the default is ACCEPTED and served by the query engine — the
        // deliberate documented routing (the v2 explain recording→wire mapping is a
        // deferred gate; refusing would break MCP explain on a default server).
        match dispatch_check_guarantee(&engine, src, true, cf()) {
            Ok(DatalogResponse::Explain(_)) => {}
            other => panic!(
                "explain must be served (query engine) under the derive default, got {:?}",
                other.err()
            ),
        }

        // ── Off-switch → everything routes through v1, explain included. ──
        std::env::set_var("RFDB_DERIVE_ENGINE", "off");
        match dispatch_check_guarantee(&engine, src, false, cf()) {
            Ok(DatalogResponse::Violations(violations)) => {
                let ids: Vec<String> = violations
                    .iter()
                    .filter_map(|v| v.bindings.get("X").cloned())
                    .collect();
                assert_eq!(
                    ids,
                    vec![string_to_id("fnB").to_string()],
                    "v1 (off-switch) path must flag the same orphan FUNCTION"
                );
            }
            other => panic!("expected v1 Violations, got error/explain: {:?}", other.err()),
        }
        match dispatch_check_guarantee(&engine, src, true, cf()) {
            Ok(DatalogResponse::Explain(_)) => {}
            other => panic!(
                "v1 path must accept explain, got {:?}",
                other.err()
            ),
        }

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    // ========================================================================
    // Projection T on the wire: `ReflectProgram` + `SetRuleSource`
    // ========================================================================

    /// One FUNCTION/CLASS graph on a real database, driven ONLY through `handle_request` —
    /// the wire dispatch layer, which is what is new here (the engine methods were already
    /// covered in `graph::engine_v2`).
    fn rules_as_data_session(
        manager: &DatabaseManager,
    ) -> ClientSession {
        let mut session = ClientSession::new(1);
        handle_request(
            manager,
            &mut session,
            Request::OpenDatabase { name: "default".to_string(), mode: "rw".to_string() },
            &None,
        );
        let mk = |sid: &str, ty: &str| WireNode {
            id: string_to_id(sid).to_string(),
            node_type: Some(ty.to_string()),
            name: Some(sid.to_string()),
            file: Some(format!("{sid}.js")),
            exported: false,
            metadata: None,
            semantic_id: Some(sid.to_string()),
        };
        handle_request(
            manager,
            &mut session,
            Request::AddNodes {
                nodes: vec![mk("f", "FUNCTION"), mk("g", "FUNCTION"), mk("C", "CLASS")],
            },
            &None,
        );
        // MVCC B2: a reader sees only PUBLISHED state.
        handle_request(manager, &mut session, Request::Flush, &None);
        session
    }

    /// Count the rows an `ExecuteDatalog` request returns, failing loudly on an error reply —
    /// a store-mode miss answers EMPTY, so a silent `0` here would look exactly like a real
    /// measurement.
    fn wire_datalog_rows(
        manager: &DatabaseManager,
        session: &mut ClientSession,
        source: &str,
    ) -> usize {
        match handle_request(
            manager,
            session,
            Request::ExecuteDatalog { source: source.to_string(), explain: false },
            &None,
        ) {
            Response::DatalogResults { results } => results.len(),
            other => panic!("expected DatalogResults, got {other:?}"),
        }
    }

    /// THE wire contract of Projection T, end to end through `handle_request`.
    ///
    /// The decisive shape is the same negative control the engine test
    /// `when_text_and_store_disagree_the_answer_follows_the_store` uses, lifted onto the
    /// PROTOCOL: the store gets ONE rule, the query then arrives carrying TWO. If the wire
    /// door silently kept parsing the request text, the extra rule would fire and the count
    /// would be 3 — so `2` is the store winning, not an empty or broken read.
    ///
    /// Also pins three things the wire layer owns and the engine methods do not:
    /// * a reflected program is VISIBLE straight away — no `Flush` request is sent between
    ///   reflecting and querying, so a caller cannot be handed an empty answer that is really
    ///   an unpublished write;
    /// * `SetRuleSource` replies with the mode read BACK off the engine;
    /// * the switch is REVERSIBLE — `store → text` restores the text program in full (3),
    ///   which is also the positive control proving the graph could always yield 3.
    #[test]
    fn wire_reflect_program_then_store_mode_answers_from_the_store() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");

        const IN_STORE: &str = r#"p(X) :- node(X, "FUNCTION")."#;
        const IN_TEXT: &str = r#"p(X) :- node(X, "FUNCTION").
p(X) :- node(X, "CLASS")."#;

        let (_dir, manager) = setup_test_manager();
        let mut session = rules_as_data_session(&manager);

        // ── Reflect: the rules become facts, and the reply counts them. ──
        let reflected = match handle_request(
            &manager,
            &mut session,
            Request::ReflectProgram { source: IN_STORE.to_string() },
            &None,
        ) {
            Response::Count { count } => count,
            other => panic!("expected Count from reflectProgram, got {other:?}"),
        };
        assert!(reflected > 0, "reflecting one rule must write facts, got {reflected}");

        // ── Switch: the reply is the mode read back off the engine. ──
        match handle_request(
            &manager,
            &mut session,
            Request::SetRuleSource { mode: rfdb::derive::RuleSource::Store },
            &None,
        ) {
            Response::RuleSourceMode { rule_source } => {
                assert_eq!(rule_source, rfdb::derive::RuleSource::Store)
            }
            other => panic!("expected RuleSourceMode, got {other:?}"),
        }

        // ── The negative control: the request carries TWO rules, the store holds ONE. ──
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, IN_TEXT),
            2,
            "store mode must answer from the reflected rule (2 FUNCTIONs); the request text's \
             second rule must not fire"
        );

        // ── Reversible, unlike the one-way ROFL marker — and the positive control. ──
        match handle_request(
            &manager,
            &mut session,
            Request::SetRuleSource { mode: rfdb::derive::RuleSource::Text },
            &None,
        ) {
            Response::RuleSourceMode { rule_source } => {
                assert_eq!(rule_source, rfdb::derive::RuleSource::Text)
            }
            other => panic!("expected RuleSourceMode, got {other:?}"),
        }
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, IN_TEXT),
            3,
            "back in text mode the SAME request text adds the CLASS — so the 2 above was the \
             store winning, not a graph that could only ever yield 2"
        );

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// A program Projection T cannot carry whole must come back as a REFUSAL the client can
    /// read, not as silence and not as a dropped connection.
    ///
    /// This is the failure mode the whole door exists to prevent: an annotated program that
    /// never reached the store answers EMPTY to every later store-mode query, which is
    /// indistinguishable from an honest zero. So the reply must (a) be an error rather than a
    /// count, (b) carry the machine code in the `[E-...-NNN]` brackets the conformance client
    /// parses (`rofl-conformance/src/rfdb-client.ts` ⟦extractECode⟧), and (c) leave the
    /// session usable — the very next request is served normally.
    #[test]
    fn wire_reflect_program_refuses_an_annotated_program_as_a_coded_error() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");

        // A well-formed `@materialize` program — it PARSES (the bundled `depends.dl` opens
        // with this exact annotation), so the refusal below is Projection T's own gate and
        // not a syntax error dressed up as one.
        const ANNOTATED: &str = r#"@materialize(edge_type="DEPENDS_ON")
p(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;

        let (_dir, manager) = setup_test_manager();
        let mut session = rules_as_data_session(&manager);

        let error = match handle_request(
            &manager,
            &mut session,
            Request::ReflectProgram { source: ANNOTATED.to_string() },
            &None,
        ) {
            Response::Error { error } => error,
            other => panic!("an unreflectable program must be REFUSED, got {other:?}"),
        };
        assert!(
            error.contains("[E-REFLECT-"),
            "the refusal must carry the machine code in brackets for the client to parse: {error}"
        );

        // The session survives the refusal: the next request is served.
        match handle_request(&manager, &mut session, Request::Ping, &None) {
            Response::Pong { pong, .. } => assert!(pong),
            other => panic!("the session must survive a refusal, got {other:?}"),
        }

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// The READ-ONLY door: `getRuleSource` reports the state and leaves it exactly as it
    /// found it.
    ///
    /// Two properties, and the second is why the door exists at all.
    ///
    /// (1) It reads the STATE, not a constant and not the last request: the same request is
    /// sent three times — before any switch, after `store`, after `text` — and answers
    /// differently each time it should. A door hard-wired to either mode fails one of the
    /// three; a door that echoed the previous `SetRuleSource` argument would still pass, so
    /// the FIRST reading (before any switch was ever sent on this session) is the one that
    /// rules that out.
    ///
    /// (2) Asking is not setting. Between the readings the mode is left alone and a real
    /// derive query is run: the row count must follow the mode that was set, never the
    /// reading in between. Before this door, the only way to learn the mode was to SET it —
    /// which is how a client "checking" would have flipped a production database into
    /// answering every `executeDatalog` with a silent zero.
    #[test]
    fn wire_get_rule_source_reads_the_state_and_changes_nothing() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
        std::env::set_var("RFDB_DERIVE_ENGINE", "on");

        const PROGRAM: &str = r#"p(X) :- node(X, "FUNCTION")."#;

        let (_dir, manager) = setup_test_manager();
        let mut session = rules_as_data_session(&manager);

        let read_mode = |manager: &DatabaseManager, session: &mut ClientSession| {
            match handle_request(manager, session, Request::GetRuleSource, &None) {
                Response::RuleSourceMode { rule_source } => rule_source,
                other => panic!("expected RuleSourceMode from getRuleSource, got {other:?}"),
            }
        };

        // (1a) A database nobody has switched reads `text` — and nothing has been sent for
        // an echo to copy.
        assert_eq!(
            read_mode(&manager, &mut session),
            rfdb::derive::RuleSource::Text,
            "an untouched database must read back as text"
        );
        // The positive control for the row counts below: in text mode the request text IS
        // the program, so it derives the two FUNCTIONs.
        assert_eq!(wire_datalog_rows(&manager, &mut session, PROGRAM), 2);

        match handle_request(
            &manager,
            &mut session,
            Request::SetRuleSource { mode: rfdb::derive::RuleSource::Store },
            &None,
        ) {
            Response::RuleSourceMode { .. } => {}
            other => panic!("expected RuleSourceMode, got {other:?}"),
        }

        // (1b) …and now it reads `store`.
        assert_eq!(
            read_mode(&manager, &mut session),
            rfdb::derive::RuleSource::Store,
            "after the switch the door must report store"
        );
        // (2) Reading twice more must not have set anything: the store is empty, so store
        // mode answers zero to the SAME text that answered 2 above. Were the read a
        // disguised write of `text`, this would be 2.
        assert_eq!(read_mode(&manager, &mut session), rfdb::derive::RuleSource::Store);
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, PROGRAM),
            0,
            "reading the mode must not have moved the database back to text"
        );

        match handle_request(
            &manager,
            &mut session,
            Request::SetRuleSource { mode: rfdb::derive::RuleSource::Text },
            &None,
        ) {
            Response::RuleSourceMode { .. } => {}
            other => panic!("expected RuleSourceMode, got {other:?}"),
        }
        // (1c) Back to text — three different readings from one door rule out a constant.
        assert_eq!(
            read_mode(&manager, &mut session),
            rfdb::derive::RuleSource::Text,
            "the door must follow the state back"
        );
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, PROGRAM),
            2,
            "…and the database itself is back in text mode, so the 0 above was store mode \
             and not a broken graph"
        );

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    /// All THREE Projection T doors are derive-engine paths, so all three are
    /// kill-switch-gated (I5): with `RFDB_DERIVE_ENGINE=off` they refuse EXPLICITLY instead
    /// of writing nothing and reporting success. Advertised to the client as the
    /// `rulesAsData` Hello capability,
    /// which appears by default and disappears under the same switch — so a client that needs
    /// store-mode rules refuses UP FRONT rather than reading empty answers as zeros.
    #[test]
    fn hello_advertises_rules_as_data_and_the_doors_gate_off_together() {
        let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
        let (_dir, manager) = setup_test_manager();

        let hello = |manager: &DatabaseManager| {
            let mut session = ClientSession::new(1);
            match handle_request(
                manager,
                &mut session,
                Request::Hello { protocol_version: Some(3), client_id: None },
                &None,
            ) {
                Response::HelloOk { features, .. } => features,
                other => panic!("expected HelloOk, got {other:?}"),
            }
        };

        std::env::remove_var("RFDB_DERIVE_ENGINE");
        assert!(
            hello(&manager).contains(&"rulesAsData".to_string()),
            "default Hello must advertise rulesAsData (reflectProgram + setRuleSource + \
             getRuleSource are live)"
        );

        std::env::set_var("RFDB_DERIVE_ENGINE", "off");
        assert!(
            !hello(&manager).contains(&"rulesAsData".to_string()),
            "the off-switch must withdraw the capability, matching the doors' own refusal"
        );

        // …and the doors themselves refuse under that same switch, coded, having written
        // nothing.
        let mut session = ClientSession::new(2);
        handle_request(
            &manager,
            &mut session,
            Request::OpenDatabase { name: "default".to_string(), mode: "rw".to_string() },
            &None,
        );
        for (what, request) in [
            ("reflectProgram", Request::ReflectProgram { source: "p(X) :- node(X, \"FUNCTION\").".to_string() }),
            ("setRuleSource", Request::SetRuleSource { mode: rfdb::derive::RuleSource::Store }),
            ("getRuleSource", Request::GetRuleSource),
        ] {
            match handle_request(&manager, &mut session, request, &None) {
                Response::Error { error } => assert!(
                    error.contains("derive-engine-only"),
                    "{what} must refuse explicitly with the switch off: {error}"
                ),
                other => panic!("{what} must be refused with the switch off, got {other:?}"),
            }
        }

        match prev {
            Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
            None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Supersede-only, on the wire (spec §acceptance: «superseding rule →
    // old derivations superseded, history intact; no retract API exists»).
    //
    // THE MEASUREMENT TRAP these tests are built against: a superseded rule
    // answers EMPTY — and so does a program that never arrived, a program
    // that was refused, and a broken query. Emptiness cannot be told from
    // emptiness. So the fixture (`rules_as_data_session`: 2 FUNCTION + 1
    // CLASS) makes FOUR outcomes mutually distinguishable at the same door:
    //   2 rows = the OLD rule is in force
    //   1 row  = the NEW rule is in force, the old one is not
    //   3 rows = BOTH in force (supersession did nothing)
    //   0 rows = nothing arrived / the read is broken
    // Every assertion below lands on a NON-EMPTY count, and each test ends
    // by making the same door produce a DIFFERENT non-empty count.
    // ════════════════════════════════════════════════════════════════════

    /// Hold `RFDB_DERIVE_ENGINE=on` for the length of a test and give it back
    /// afterwards, serialized against the other env-mutating tests.
    struct DeriveEngineOn {
        _guard: std::sync::MutexGuard<'static, ()>,
        prev: Option<String>,
    }

    impl DeriveEngineOn {
        fn new() -> Self {
            let _guard = DERIVE_ENGINE_ENV_LOCK.lock().unwrap();
            let prev = std::env::var("RFDB_DERIVE_ENGINE").ok();
            std::env::set_var("RFDB_DERIVE_ENGINE", "on");
            Self { _guard, prev }
        }
    }

    impl Drop for DeriveEngineOn {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var("RFDB_DERIVE_ENGINE", v),
                None => std::env::remove_var("RFDB_DERIVE_ENGINE"),
            }
        }
    }

    /// WHICH rule records the virtual rules file holds right now, read through
    /// the ORDINARY node-listing door — the store's own answer to «what rules do
    /// you carry», not an internal accessor. Identities, not a count: a count
    /// that stayed the same could be one record swapped for another, whereas a
    /// set that still CONTAINS the old ids is history that is actually intact.
    fn wire_rule_record_ids(
        manager: &DatabaseManager,
        session: &mut ClientSession,
    ) -> std::collections::BTreeSet<String> {
        match handle_request(
            manager,
            session,
            Request::QueryNodesByFile { file: rfdb::derive::reflect::REFLECT_FILE.to_string() },
            &None,
        ) {
            Response::Nodes { nodes } => nodes.into_iter().map(|n| n.id).collect(),
            other => panic!("expected Nodes, got {other:?}"),
        }
    }

    fn wire_rule_records(manager: &DatabaseManager, session: &mut ClientSession) -> usize {
        wire_rule_record_ids(manager, session).len()
    }

    /// The id a supersede directive has to name. It is a pure function of the
    /// rule TEXT (content-addressed, the ROFL v0 `ruleIdOf`), so a client that
    /// once wrote a rule can always compute the id of the rule it wants to
    /// supersede — no server round trip and no id registry needed.
    fn id_of_rule(source: &str) -> String {
        let program = rfdb::derive::parser_ext::parse_ext_program(source).expect("parse");
        let rules = program.rules();
        assert_eq!(rules.len(), 1, "id_of_rule takes exactly one rule");
        rfdb::derive::reflect::rule_id(rules[0])
    }

    fn reflect_on_wire(
        manager: &DatabaseManager,
        session: &mut ClientSession,
        source: &str,
    ) -> u32 {
        match handle_request(
            manager,
            session,
            Request::ReflectProgram { source: source.to_string() },
            &None,
        ) {
            Response::Count { count } => count,
            other => panic!("expected Count from reflectProgram, got {other:?}"),
        }
    }

    const OLD_RULE: &str = r#"p(X) :- node(X, "FUNCTION")."#;
    const NEW_RULE: &str = r#"p(X) :- node(X, "CLASS")."#;
    /// The probe the client sends in store mode. It carries BOTH rules, so if
    /// the wire ever went back to parsing the request text the answer would be
    /// 3 — the count itself tells us which side answered.
    const BOTH_RULES: &str = r#"p(X) :- node(X, "FUNCTION").
p(X) :- node(X, "CLASS")."#;

    /// The acceptance criterion end to end: a rule declared as superseding an
    /// older one takes the old rule's derivations out of force, and the old
    /// rule STAYS in the store.
    #[test]
    fn a_superseding_rule_changes_the_wire_answer_and_the_old_rule_stays_in_the_store() {
        let _env = DeriveEngineOn::new();
        let (_dir, manager) = setup_test_manager();
        let mut session = rules_as_data_session(&manager);

        assert!(reflect_on_wire(&manager, &mut session, OLD_RULE) > 0);
        let ids_with_one_rule = wire_rule_record_ids(&manager, &mut session);
        assert!(
            !ids_with_one_rule.is_empty(),
            "one reflected rule must be visible as records in {}",
            rfdb::derive::reflect::REFLECT_FILE
        );

        match handle_request(
            &manager,
            &mut session,
            Request::SetRuleSource { mode: rfdb::derive::RuleSource::Store },
            &None,
        ) {
            Response::RuleSourceMode { rule_source } => {
                assert_eq!(rule_source, rfdb::derive::RuleSource::Store)
            }
            other => panic!("expected RuleSourceMode, got {other:?}"),
        }

        // BEFORE: non-empty, and the number says WHICH rule answered.
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, BOTH_RULES),
            2,
            "before supersession the store's only rule is the FUNCTION one"
        );

        // The supersession itself: one ordinary rule + one directive naming the
        // old rule's content-addressed id.
        let superseding = format!("{NEW_RULE}\nsupersedes(\"{}\").", id_of_rule(OLD_RULE));
        assert!(reflect_on_wire(&manager, &mut session, &superseding) > 0);

        // AFTER: a DIFFERENT non-empty number at the SAME door. 3 would mean the
        // supersession did nothing, 2 that it did not take, 0 that the read
        // broke — only 1 means «the old rule is out of force, the new one is in».
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, BOTH_RULES),
            1,
            "after supersession only the CLASS rule may fire"
        );

        // HISTORY, part one: the store did not shrink, and it is the SAME records
        // that are still there — every id the old rule was written as survives,
        // now joined by the new rule's records and the supersession claim.
        let ids_after = wire_rule_record_ids(&manager, &mut session);
        assert!(
            ids_with_one_rule.is_subset(&ids_after),
            "every record of the superseded rule must still be in the store: {} -> {}",
            ids_with_one_rule.len(),
            ids_after.len()
        );
        assert!(
            ids_after.len() > ids_with_one_rule.len(),
            "and the door does register growth, so the subset above is not a frozen read"
        );

        // HISTORY, part two: re-reflecting the superseded rule adds NOTHING — its
        // records are content-addressed and already carried. Had supersession
        // erased them, this write would put them back and the id set would grow.
        // (And a re-write is not a resurrection: the claim naming it still holds.)
        reflect_on_wire(&manager, &mut session, OLD_RULE);
        assert_eq!(
            wire_rule_record_ids(&manager, &mut session),
            ids_after,
            "re-writing the superseded rule changed no id — the records never left"
        );
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, BOTH_RULES),
            1,
            "and re-writing it does not put it back in force"
        );

        // Positive control for the 1: back in text mode the SAME probe yields 3,
        // so the graph was always able to produce more than one row.
        handle_request(
            &manager,
            &mut session,
            Request::SetRuleSource { mode: rfdb::derive::RuleSource::Text },
            &None,
        );
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, BOTH_RULES),
            3,
            "the graph can yield 3 — so the 1 above was the supersession, not a ceiling"
        );
    }

    /// «No retract API» at the per-node delete door.
    #[test]
    fn the_wire_refuses_to_delete_a_reflected_rule_record() {
        let _env = DeriveEngineOn::new();
        let (_dir, manager) = setup_test_manager();
        let mut session = rules_as_data_session(&manager);
        assert!(reflect_on_wire(&manager, &mut session, OLD_RULE) > 0);

        let rule_node_id = match handle_request(
            &manager,
            &mut session,
            Request::QueryNodesByFile { file: rfdb::derive::reflect::REFLECT_FILE.to_string() },
            &None,
        ) {
            Response::Nodes { nodes } => {
                assert!(!nodes.is_empty(), "reflection wrote no record to read back");
                nodes[0].id.clone()
            }
            other => panic!("expected Nodes, got {other:?}"),
        };
        let before = wire_rule_records(&manager, &mut session);

        match handle_request(
            &manager,
            &mut session,
            Request::DeleteNode { id: rule_node_id },
            &None,
        ) {
            Response::Error { error } => assert!(
                error.contains("E-ROFL-NORETRACT"),
                "the refusal must name itself: {error}"
            ),
            other => panic!("deleting a rule record must be refused, got {other:?}"),
        }
        assert_eq!(
            wire_rule_records(&manager, &mut session),
            before,
            "a refused delete must not have removed anything either"
        );

        // Positive control: the SAME door still deletes an ordinary node, so the
        // refusal above is about the rule record, not a dead delete path.
        let ordinary = string_to_id("f").to_string();
        match handle_request(
            &manager,
            &mut session,
            Request::DeleteNode { id: ordinary.clone() },
            &None,
        ) {
            Response::Ok { ok } => assert!(ok),
            other => panic!("an ordinary node must still delete, got {other:?}"),
        }
        // MVCC B2: a reader sees only PUBLISHED state, so the tombstone has to land.
        handle_request(&manager, &mut session, Request::Flush, &None);
        match handle_request(&manager, &mut session, Request::NodeExists { id: ordinary }, &None) {
            Response::Bool { value } => assert!(!value, "the ordinary node really went away"),
            other => panic!("expected Bool, got {other:?}"),
        }
    }

    /// «No retract API» at the bulk delete-by-type door.
    #[test]
    fn the_wire_refuses_the_bulk_delete_of_the_reserved_rule_type() {
        let _env = DeriveEngineOn::new();
        let (_dir, manager) = setup_test_manager();
        let mut session = rules_as_data_session(&manager);
        assert!(reflect_on_wire(&manager, &mut session, OLD_RULE) > 0);
        let before = wire_rule_records(&manager, &mut session);
        assert!(before > 0);

        match handle_request(
            &manager,
            &mut session,
            Request::DeleteNodesByTypeAndSource {
                node_type: rfdb::derive::reflect::REFLECT_NODE_TYPE.to_string(),
                source_tag: "anything".to_string(),
            },
            &None,
        ) {
            Response::Error { error } => assert!(
                error.contains("E-ROFL-NORETRACT"),
                "the refusal must name itself: {error}"
            ),
            other => panic!("bulk-deleting the rule type must be refused, got {other:?}"),
        }
        assert_eq!(wire_rule_records(&manager, &mut session), before);

        // Positive control: a real, non-empty bulk delete of an ordinary type.
        handle_request(
            &manager,
            &mut session,
            Request::AddNodes {
                nodes: vec![WireNode {
                    semantic_id: Some("w".to_string()),
                    id: string_to_id("w").to_string(),
                    node_type: Some("WIDGET".to_string()),
                    name: Some("w".to_string()),
                    file: Some("w.js".to_string()),
                    exported: false,
                    metadata: Some(r#"{"_source":"probe"}"#.to_string()),
                }],
            },
            &None,
        );
        handle_request(&manager, &mut session, Request::Flush, &None);
        match handle_request(
            &manager,
            &mut session,
            Request::DeleteNodesByTypeAndSource {
                node_type: "WIDGET".to_string(),
                source_tag: "probe".to_string(),
            },
            &None,
        ) {
            Response::NodesDeleted { ok, deleted_nodes, .. } => {
                assert!(ok);
                assert_eq!(deleted_nodes, 1, "the bulk door itself works and really deletes");
            }
            other => panic!("expected NodesDeleted, got {other:?}"),
        }
    }

    /// The delete-by-file path a batch commit performs: naming the virtual rules
    /// file in `changedFiles` must not tombstone the rules. Protection is
    /// UNCONDITIONAL — the client sends no `protectedTypes` here.
    #[test]
    fn a_commit_batch_naming_the_rules_file_does_not_wipe_the_rules() {
        let _env = DeriveEngineOn::new();
        let (_dir, manager) = setup_test_manager();
        let mut session = rules_as_data_session(&manager);
        assert!(reflect_on_wire(&manager, &mut session, OLD_RULE) > 0);
        let before = wire_rule_records(&manager, &mut session);
        assert!(before > 0);

        handle_request(
            &manager,
            &mut session,
            Request::SetRuleSource { mode: rfdb::derive::RuleSource::Store },
            &None,
        );
        assert_eq!(wire_datalog_rows(&manager, &mut session, BOTH_RULES), 2);

        match handle_request(
            &manager,
            &mut session,
            Request::CommitBatch {
                changed_files: vec![rfdb::derive::reflect::REFLECT_FILE.to_string()],
                nodes: vec![],
                edges: vec![],
                tags: None,
                file_context: None,
                defer_index: false,
                protected_types: vec![],
            },
            &None,
        ) {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(
                    delta.nodes_removed, 0,
                    "a batch naming the rules file must tombstone no rule record"
                );
            }
            other => panic!("expected BatchCommitted, got {other:?}"),
        }

        assert_eq!(wire_rule_records(&manager, &mut session), before);
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, BOTH_RULES),
            2,
            "the rule still fires after the batch — 0 here would be the wipe"
        );

        // Positive control: the SAME request shape, aimed at an ordinary file,
        // does delete — so the zero above is the protection, not a dead path.
        match handle_request(
            &manager,
            &mut session,
            Request::CommitBatch {
                changed_files: vec!["f.js".to_string()],
                nodes: vec![],
                edges: vec![],
                tags: None,
                file_context: None,
                defer_index: false,
                protected_types: vec![],
            },
            &None,
        ) {
            Response::BatchCommitted { ok, delta } => {
                assert!(ok);
                assert_eq!(delta.nodes_removed, 1, "an ordinary file's node is still removed");
            }
            other => panic!("expected BatchCommitted, got {other:?}"),
        }
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, BOTH_RULES),
            1,
            "one FUNCTION node is gone, so the SAME store rule now yields 1 — the read is live"
        );
    }

    /// `datalogClearRules` is the legacy in-memory rule reset. It must be inert
    /// with respect to reflected rules: those live in the store, and the store
    /// is only ever superseded.
    #[test]
    fn datalog_clear_rules_does_not_clear_reflected_rules() {
        let _env = DeriveEngineOn::new();
        let (_dir, manager) = setup_test_manager();
        let mut session = rules_as_data_session(&manager);
        assert!(reflect_on_wire(&manager, &mut session, OLD_RULE) > 0);
        let before = wire_rule_records(&manager, &mut session);
        handle_request(
            &manager,
            &mut session,
            Request::SetRuleSource { mode: rfdb::derive::RuleSource::Store },
            &None,
        );
        assert_eq!(wire_datalog_rows(&manager, &mut session, BOTH_RULES), 2);

        match handle_request(&manager, &mut session, Request::DatalogClearRules, &None) {
            Response::Ok { ok } => assert!(ok),
            other => panic!("expected Ok, got {other:?}"),
        }

        assert_eq!(wire_rule_records(&manager, &mut session), before);
        assert_eq!(
            wire_datalog_rows(&manager, &mut session, BOTH_RULES),
            2,
            "the reflected rule still answers after datalogClearRules"
        );
    }

    /// MECHANICAL GUARD for «no retract API exists».
    ///
    /// WHAT IT PROVES: the wire command set is PINNED. Any command added to
    /// `enum Request` — whatever it is called, so renaming defeats nothing —
    /// turns this test red until a human puts the new name in the list below
    /// and, in doing so, states whether it can take a rule out of the store.
    ///
    /// WHAT IT DOES NOT PROVE (stated here rather than left to be discovered):
    /// * it reads THIS file's text, so a retract door opened in a different
    ///   crate or a different protocol (HTTP surface, an MCP tool) is outside
    ///   its reach;
    /// * it cannot judge a name — `Compact` and `Clear` are in the list and are
    ///   destructive; what makes them not-retraction is argued below, by a
    ///   human, and re-argued whenever the list changes;
    /// * the behavioural half of the criterion is carried by the four tests
    ///   above, not by this one. This test is the alarm, they are the proof.
    #[test]
    fn the_wire_command_set_is_pinned_and_carries_no_rule_retraction_door() {
        let src = include_str!("rfdb_server.rs");
        let head = "pub enum Request {";
        let start = src.find(head).expect("enum Request must be findable in this file");
        let mut depth = 1usize;
        let mut end = start + head.len();
        for c in src[start + head.len()..].chars() {
            end += c.len_utf8();
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
        }
        let block = &src[start..end];
        let mut found: Vec<&str> = Vec::new();
        for line in block.lines() {
            let Some(rest) = line.strip_prefix("    ") else { continue };
            if !rest.starts_with(|c: char| c.is_ascii_uppercase()) {
                continue;
            }
            let name_len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'));
            let (name, tail) = match name_len {
                Some(i) => (&rest[..i], &rest[i..]),
                None => continue,
            };
            if tail.starts_with(" {") || tail.starts_with('{') || tail.starts_with('(')
                || tail.starts_with(',')
            {
                found.push(name);
            }
        }
        found.sort_unstable();

        // Positive control for the parse: a zero or a near-zero here would make
        // the comparison below vacuously true, which is the classic way a guard
        // test goes green while guarding nothing.
        assert!(
            found.len() > 50,
            "the enum parse collapsed — found only {} variants: {found:?}",
            found.len()
        );

        // The pin. Sorted, complete, and every destructive member accounted for:
        //   Clear, DropDatabase — destroy the whole database, not a rule inside
        //     a living one; there is no «keep the graph, drop that rule» form.
        //   Compact — merges segments and applies tombstones; it removes no
        //     record that is not already tombstoned.
        //   DatalogClearRules — resets the legacy in-memory rule set; inert for
        //     reflected rules (proved by the test above).
        //   DeleteNode, DeleteNodesByTypeAndSource — refuse the reflected-rule
        //     record and the reserved type (proved by the two tests above).
        //   DeleteEdge, DeleteEdgesByTypeAndSource — Projection T writes NODES
        //     only, so no edge door can reach a rule.
        // NOTHING in this list retracts a rule. A rule leaves force one way:
        // another rule supersedes it, and the superseded one stays.
        let pinned = [
            "AbortBatch", "AddEdges", "AddNodes", "BeginBatch", "BeginBulkLoad", "Bfs",
            "CancelQuery", "CheckGuarantee", "Clear", "CloseDatabase", "CommitBatch", "Compact",
            "CountEdgesByType", "CountNodesByType", "CreateDatabase", "CurrentDatabase",
            "CypherQuery", "DatalogClearRules", "DatalogLoadRules", "DatalogQuery",
            "DeclareFields", "DeleteEdge", "DeleteEdgesByTypeAndSource", "DeleteNode",
            "DeleteNodesByTypeAndSource", "Dfs", "DiffSnapshots", "DropDatabase", "EdgeCount",
            "EndBulkLoad", "ExecuteDatalog", "ExplainDatalogFact", "ExplainDatalogGap",
            "FindByAttr", "FindByType", "FindDependentFiles", "FindSnapshot", "Flush",
            "GetAllEdges", "GetEdgesByType", "GetIncomingEdges", "GetNode", "GetNodeIdentifier",
            "GetOutgoingEdges", "GetRuleSource", "GetStats", "Hello", "IsEndpoint",
            "ListDatabases", "ListSnapshots", "MaterializeDatalog", "Neighbors", "NodeCount",
            "NodeExists", "OpenDatabase", "Ping", "QueryEdges", "QueryNodes", "QueryNodesByFile",
            "Reachability", "RebuildIndexes", "ReflectProgram", "SetRuleSource", "Shutdown",
            "SimDatalog", "Subgraph", "TagSnapshot", "UpdateNodeVersion", "WhoAreYou",
        ];
        assert_eq!(
            found, pinned,
            "the wire command set changed. Classify every added command: can it take a rule \
             out of the store? If it can, the acceptance criterion «no retract API exists» is \
             broken and the command must go, not the pin."
        );
    }
}
