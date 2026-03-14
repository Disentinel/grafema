//! RFDB client: MessagePack over unix socket, protocol v3.
//!
//! Implements length-prefixed MessagePack framing over a Unix domain socket.
//! Commands: Hello, CreateDatabase, OpenDatabase, CommitBatch, DatalogQuery, Ping.
//!
//! The client sends requests as `{ "requestId": "rN", "cmd": "...", ...params }` and
//! receives responses discriminated by field presence (ok, error, results, pong).

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::UnixStream;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/// Errors specific to the RFDB client.
#[derive(Debug)]
pub enum RfdbError {
    /// Server returned an error response.
    Server {
        message: String,
        code: Option<String>,
    },

    /// Protocol version mismatch during handshake.
    ProtocolMismatch { expected: u32, got: u32 },

    /// Connection to the server failed.
    Connect {
        path: String,
        source: std::io::Error,
    },

    /// I/O error during send or receive.
    Io(std::io::Error),

    /// MessagePack encoding error.
    Encode(rmp_serde::encode::Error),

    /// MessagePack decoding error.
    Decode(rmp_serde::decode::Error),

    /// Message exceeds the maximum allowed size.
    MessageTooLarge { size: usize, max: usize },
}

impl std::fmt::Display for RfdbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Server { message, code } => {
                write!(f, "RFDB server error: {message} (code: {code:?})")
            }
            Self::ProtocolMismatch { expected, got } => {
                write!(f, "Protocol version mismatch: expected {expected}, got {got}")
            }
            Self::Connect { path, source } => {
                write!(f, "Failed to connect to RFDB at {path}: {source}")
            }
            Self::Io(e) => write!(f, "RFDB I/O error: {e}"),
            Self::Encode(e) => write!(f, "MessagePack encode error: {e}"),
            Self::Decode(e) => write!(f, "MessagePack decode error: {e}"),
            Self::MessageTooLarge { size, max } => {
                write!(f, "Message too large: {size} bytes (max {max})")
            }
        }
    }
}

impl std::error::Error for RfdbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Connect { source, .. } => Some(source),
            Self::Io(e) => Some(e),
            Self::Encode(e) => Some(e),
            Self::Decode(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for RfdbError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<rmp_serde::encode::Error> for RfdbError {
    fn from(e: rmp_serde::encode::Error) -> Self {
        Self::Encode(e)
    }
}

impl From<rmp_serde::decode::Error> for RfdbError {
    fn from(e: rmp_serde::decode::Error) -> Self {
        Self::Decode(e)
    }
}

/// Maximum message size: 100 MB.
const MAX_MESSAGE_SIZE: usize = 100 * 1024 * 1024;

/// Protocol version this client speaks.
const PROTOCOL_VERSION: u32 = 3;

/// Client identifier sent in the Hello handshake.
const CLIENT_ID: &str = "grafema-orchestrator";

/// Chunk size for CommitBatch: max nodes/edges per request.
const COMMIT_CHUNK_SIZE: usize = 10_000;

// ---------------------------------------------------------------------------
// Wire types — request envelope
// ---------------------------------------------------------------------------

/// Generic request envelope. All commands share this shape on the wire.
/// Additional fields are flattened from the `params` map.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestEnvelope {
    request_id: String,
    cmd: String,
    #[serde(flatten)]
    params: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Wire types — node & edge
// ---------------------------------------------------------------------------

/// A node as sent over the wire to RFDB.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireNode {
    /// Semantic ID string (server will hash to u128 via BLAKE3).
    pub id: String,
    /// Optional explicit semantic ID (if different from `id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_id: Option<String>,
    /// Node type, e.g. "FUNCTION", "CLASS", "VARIABLE".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_type: Option<String>,
    /// Human-readable name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Source file path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// Whether the symbol is exported.
    pub exported: bool,
    /// JSON-encoded metadata string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

/// An edge as sent over the wire to RFDB.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEdge {
    /// Source node ID (semantic ID string).
    pub src: String,
    /// Destination node ID (semantic ID string).
    pub dst: String,
    /// Edge type, e.g. "CALLS", "IMPORTS", "CONTAINS".
    pub edge_type: String,
    /// JSON-encoded metadata string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

// ---------------------------------------------------------------------------
// Wire types — responses
// ---------------------------------------------------------------------------

/// Raw response from the server. We deserialize into this untagged shape
/// and then interpret based on which fields are present.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawResponse {
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    pong: Option<bool>,

    // Hello fields
    #[serde(default)]
    protocol_version: Option<u32>,
    #[serde(default)]
    server_version: Option<String>,
    #[serde(default)]
    features: Option<Vec<String>>,

    // Database fields
    #[serde(default)]
    database_id: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    node_count: Option<u64>,
    #[serde(default)]
    edge_count: Option<u64>,

    // CommitBatch delta
    #[serde(default)]
    delta: Option<CommitDelta>,

    // DatalogQuery results
    #[serde(default)]
    results: Option<Vec<DatalogResult>>,

    // QueryNodes results
    #[serde(default)]
    nodes: Option<Vec<WireNode>>,
}

impl RawResponse {
    /// Check for server error and convert to `RfdbError::Server` if present.
    fn check_error(&self) -> Result<(), RfdbError> {
        if let Some(ref msg) = self.error {
            Err(RfdbError::Server {
                message: msg.clone(),
                code: self.code.clone(),
            })
        } else {
            Ok(())
        }
    }
}

/// Response from the Hello handshake.
#[derive(Debug, Clone)]
pub struct HelloResponse {
    pub protocol_version: u32,
    pub server_version: String,
    pub features: Vec<String>,
}

/// Response from CreateDatabase.
#[derive(Debug, Clone)]
pub struct CreateDatabaseResponse {
    pub database_id: String,
}

/// Response from OpenDatabase.
#[derive(Debug, Clone)]
pub struct OpenDatabaseResponse {
    pub database_id: String,
    pub mode: String,
    pub node_count: u64,
    pub edge_count: u64,
}

/// Delta returned by CommitBatch, describing what changed.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDelta {
    #[serde(default)]
    pub nodes_added: u64,
    #[serde(default)]
    pub nodes_removed: u64,
    #[serde(default)]
    pub edges_added: u64,
    #[serde(default)]
    pub edges_removed: u64,
    #[serde(default)]
    pub changed_node_types: Vec<String>,
    #[serde(default)]
    pub changed_edge_types: Vec<String>,
}

/// A single result row from a Datalog query.
#[derive(Debug, Clone, Deserialize)]
pub struct DatalogResult {
    /// Variable bindings for this result row.
    pub bindings: HashMap<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// RfdbClient
// ---------------------------------------------------------------------------

/// RFDB client connection over a Unix domain socket.
///
/// Communicates using length-prefixed MessagePack frames (4-byte big-endian
/// length prefix followed by the MessagePack payload).
///
/// Use [`RfdbClient::connect`] to establish a connection and perform the
/// protocol handshake. The client is NOT thread-safe for concurrent sends;
/// wrap in a `Mutex` if needed.
pub struct RfdbClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: BufWriter<tokio::net::unix::OwnedWriteHalf>,
    req_counter: AtomicU64,
    /// Server version string from the Hello handshake.
    pub server_version: String,
    /// Feature flags reported by the server.
    pub features: Vec<String>,
}

impl RfdbClient {
    /// Connect to the RFDB server at the given Unix socket path.
    ///
    /// Performs the protocol v3 Hello handshake. Returns an error if the
    /// connection fails or the server reports an incompatible protocol version.
    pub async fn connect(socket: &Path) -> Result<Self> {
        let stream = UnixStream::connect(socket).await.map_err(|e| {
            RfdbError::Connect {
                path: socket.display().to_string(),
                source: e,
            }
        })?;

        let (read_half, write_half) = stream.into_split();
        let reader = BufReader::new(read_half);
        let writer = BufWriter::new(write_half);

        let mut client = Self {
            reader,
            writer,
            req_counter: AtomicU64::new(0),
            server_version: String::new(),
            features: Vec::new(),
        };

        // Perform handshake
        let hello = client.hello().await?;
        client.server_version = hello.server_version;
        client.features = hello.features;

        Ok(client)
    }

    // -----------------------------------------------------------------------
    // Framing: send & receive
    // -----------------------------------------------------------------------

    /// Generate the next request ID string ("r0", "r1", ...).
    fn next_request_id(&self) -> String {
        let id = self.req_counter.fetch_add(1, Ordering::Relaxed);
        format!("r{id}")
    }

    /// Send a length-prefixed MessagePack frame.
    async fn send_raw(&mut self, payload: &[u8]) -> Result<(), RfdbError> {
        if payload.len() > MAX_MESSAGE_SIZE {
            return Err(RfdbError::MessageTooLarge {
                size: payload.len(),
                max: MAX_MESSAGE_SIZE,
            });
        }
        let len = payload.len() as u32;
        self.writer.write_all(&len.to_be_bytes()).await?;
        self.writer.write_all(payload).await?;
        self.writer.flush().await?;
        Ok(())
    }

    /// Receive a single length-prefixed MessagePack frame and decode it.
    async fn recv_raw(&mut self) -> Result<RawResponse, RfdbError> {
        let mut len_buf = [0u8; 4];
        self.reader.read_exact(&mut len_buf).await?;
        let len = u32::from_be_bytes(len_buf) as usize;

        if len > MAX_MESSAGE_SIZE {
            return Err(RfdbError::MessageTooLarge {
                size: len,
                max: MAX_MESSAGE_SIZE,
            });
        }

        let mut buf = vec![0u8; len];
        self.reader.read_exact(&mut buf).await?;

        let response: RawResponse = rmp_serde::from_slice(&buf)?;
        Ok(response)
    }

    /// Send a command with the given parameters and receive the response.
    async fn send_command(
        &mut self,
        cmd: &str,
        params: serde_json::Value,
    ) -> Result<RawResponse, RfdbError> {
        let envelope = RequestEnvelope {
            request_id: self.next_request_id(),
            cmd: cmd.to_string(),
            params,
        };
        let payload = rmp_serde::to_vec_named(&envelope)?;
        self.send_raw(&payload).await?;
        let response = self.recv_raw().await?;
        response.check_error()?;
        Ok(response)
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    /// Perform the Hello handshake with the server.
    ///
    /// This is called automatically by [`connect`](Self::connect); you normally
    /// do not need to call it directly.
    async fn hello(&mut self) -> Result<HelloResponse, RfdbError> {
        let params = serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientId": CLIENT_ID,
        });
        let resp = self.send_command("hello", params).await?;

        let server_version = resp
            .protocol_version
            .unwrap_or(0);

        if server_version != PROTOCOL_VERSION {
            return Err(RfdbError::ProtocolMismatch {
                expected: PROTOCOL_VERSION,
                got: server_version,
            });
        }

        Ok(HelloResponse {
            protocol_version: server_version,
            server_version: resp.server_version.unwrap_or_default(),
            features: resp.features.unwrap_or_default(),
        })
    }

    /// Create a new database. If `ephemeral` is true, the database is
    /// not persisted to disk.
    ///
    /// Handles "already exists" gracefully by returning the existing database ID.
    pub async fn create_database(
        &mut self,
        name: &str,
        ephemeral: bool,
    ) -> Result<CreateDatabaseResponse> {
        let params = serde_json::json!({
            "name": name,
            "ephemeral": ephemeral,
        });

        let resp = match self.send_command("createDatabase", params).await {
            Ok(r) => r,
            Err(RfdbError::Server { ref code, .. })
                if code.as_deref() == Some("DATABASE_EXISTS") =>
            {
                return Ok(CreateDatabaseResponse {
                    database_id: name.to_string(),
                });
            }
            Err(e) => return Err(e.into()),
        };

        Ok(CreateDatabaseResponse {
            database_id: resp.database_id.unwrap_or_else(|| name.to_string()),
        })
    }

    /// Open an existing database.
    ///
    /// `mode` is typically `"rw"` (read-write) or `"ro"` (read-only).
    pub async fn open_database(
        &mut self,
        name: &str,
        mode: &str,
    ) -> Result<OpenDatabaseResponse> {
        let params = serde_json::json!({
            "name": name,
            "mode": mode,
        });
        let resp = self.send_command("openDatabase", params).await?;

        Ok(OpenDatabaseResponse {
            database_id: resp.database_id.unwrap_or_else(|| name.to_string()),
            mode: resp.mode.unwrap_or_else(|| mode.to_string()),
            node_count: resp.node_count.unwrap_or(0),
            edge_count: resp.edge_count.unwrap_or(0),
        })
    }

    /// Atomically commit a batch of nodes and edges for the given changed files.
    ///
    /// If the number of nodes or edges exceeds [`COMMIT_CHUNK_SIZE`] (10,000),
    /// the batch is split into multiple requests, matching the JS client behavior.
    /// The returned [`CommitDelta`] merges all chunk deltas.
    ///
    /// When `defer_index` is true, the server skips expensive index rebuilds
    /// and only writes data. Caller must send [`rebuild_indexes`] after all
    /// deferred commits complete.
    pub async fn commit_batch(
        &mut self,
        changed_files: &[String],
        nodes: &[WireNode],
        edges: &[WireEdge],
        defer_index: bool,
    ) -> Result<CommitDelta> {
        // Small batch — single request
        if nodes.len() <= COMMIT_CHUNK_SIZE && edges.len() <= COMMIT_CHUNK_SIZE {
            return self
                .send_commit_batch_chunk(changed_files, nodes, edges, defer_index)
                .await;
        }

        // Large batch — chunk it
        let max_chunks = std::cmp::max(
            (nodes.len() + COMMIT_CHUNK_SIZE - 1) / COMMIT_CHUNK_SIZE,
            (edges.len() + COMMIT_CHUNK_SIZE - 1) / COMMIT_CHUNK_SIZE,
        )
        .max(1);

        let mut merged = CommitDelta::default();
        let mut node_types = std::collections::HashSet::new();
        let mut edge_types = std::collections::HashSet::new();

        for i in 0..max_chunks {
            let node_start = i * COMMIT_CHUNK_SIZE;
            let node_end = std::cmp::min(node_start + COMMIT_CHUNK_SIZE, nodes.len());
            let edge_start = i * COMMIT_CHUNK_SIZE;
            let edge_end = std::cmp::min(edge_start + COMMIT_CHUNK_SIZE, edges.len());

            let chunk_nodes = if node_start < nodes.len() {
                &nodes[node_start..node_end]
            } else {
                &[]
            };
            let chunk_edges = if edge_start < edges.len() {
                &edges[edge_start..edge_end]
            } else {
                &[]
            };

            // Only send changedFiles in the first chunk
            let files: &[String] = if i == 0 { changed_files } else { &[] };

            let delta = self
                .send_commit_batch_chunk(files, chunk_nodes, chunk_edges, defer_index)
                .await?;

            merged.nodes_added += delta.nodes_added;
            merged.nodes_removed += delta.nodes_removed;
            merged.edges_added += delta.edges_added;
            merged.edges_removed += delta.edges_removed;
            for t in delta.changed_node_types {
                node_types.insert(t);
            }
            for t in delta.changed_edge_types {
                edge_types.insert(t);
            }
        }

        merged.changed_node_types = node_types.into_iter().collect();
        merged.changed_edge_types = edge_types.into_iter().collect();

        Ok(merged)
    }

    /// Rebuild all secondary indexes after a series of deferred commits.
    ///
    /// Must be called after one or more `commit_batch(.., defer_index=true)` calls
    /// to make the committed data queryable.
    pub async fn rebuild_indexes(&mut self) -> Result<()> {
        self.send_command("rebuildIndexes", serde_json::json!({}))
            .await?;
        Ok(())
    }

    /// Compact the graph storage, merging segments and deduplicating nodes/edges.
    ///
    /// Should be called after `rebuild_indexes` to ensure that re-analyzed files
    /// don't cause duplicate counts (old segment + new segment for same node ID).
    pub async fn compact(&mut self) -> Result<()> {
        self.send_command("compact", serde_json::json!({}))
            .await?;
        Ok(())
    }

    /// Send a single CommitBatch chunk to the server.
    async fn send_commit_batch_chunk(
        &mut self,
        changed_files: &[String],
        nodes: &[WireNode],
        edges: &[WireEdge],
        defer_index: bool,
    ) -> Result<CommitDelta> {
        let params = serde_json::json!({
            "changedFiles": changed_files,
            "nodes": nodes,
            "edges": edges,
            "deferIndex": defer_index,
        });
        let resp = self.send_command("commitBatch", params).await?;

        Ok(resp.delta.unwrap_or_default())
    }

    /// Execute a Datalog query and return the result bindings.
    ///
    /// Uses the unified `executeDatalog` wire command which auto-detects
    /// whether the source contains rules (program) or a direct query.
    /// This allows plugins to use both `violation(X) :- ...` rule syntax
    /// and direct query syntax like `node(X, "CALL"), attr(X, "name", N)`.
    pub async fn datalog_query(&mut self, query: &str) -> Result<Vec<DatalogResult>> {
        let params = serde_json::json!({
            "source": query,
            "explain": false,
        });
        let resp = self.send_command("executeDatalog", params).await?;

        Ok(resp.results.unwrap_or_default())
    }

    /// Query nodes by type from RFDB.
    ///
    /// Returns all nodes matching the given `node_type` string.
    /// Uses the QueryNodes wire command with a type filter.
    pub async fn query_nodes_by_type(&mut self, node_type: &str) -> Result<Vec<WireNode>> {
        let params = serde_json::json!({
            "query": {
                "nodeType": node_type
            }
        });
        let resp = self.send_command("queryNodes", params).await?;
        Ok(resp.nodes.unwrap_or_default())
    }

    /// Health-check ping. Returns `Ok(true)` if the server responds with `pong`.
    pub async fn ping(&mut self) -> Result<bool> {
        let resp = self.send_command("ping", serde_json::json!({})).await?;
        Ok(resp.pong.unwrap_or(false))
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/// Convert a semantic ID string to u128 via BLAKE3.
///
/// Takes the first 16 bytes of the BLAKE3 hash and interprets them as a
/// little-endian u128. This matches the server's ID hashing scheme.
pub fn semantic_id_to_u128(id: &str) -> u128 {
    let hash = blake3::hash(id.as_bytes());
    let bytes = hash.as_bytes();
    u128::from_le_bytes(bytes[..16].try_into().unwrap())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_semantic_id_deterministic() {
        let a = semantic_id_to_u128("test.js->FUNCTION->foo");
        let b = semantic_id_to_u128("test.js->FUNCTION->foo");
        assert_eq!(a, b);
    }

    #[test]
    fn test_semantic_id_different_inputs() {
        let a = semantic_id_to_u128("test.js->FUNCTION->foo");
        let b = semantic_id_to_u128("test.js->FUNCTION->bar");
        assert_ne!(a, b);
    }

    #[test]
    fn test_request_id_format() {
        let counter = AtomicU64::new(0);
        let id0 = {
            let n = counter.fetch_add(1, Ordering::Relaxed);
            format!("r{n}")
        };
        let id1 = {
            let n = counter.fetch_add(1, Ordering::Relaxed);
            format!("r{n}")
        };
        assert_eq!(id0, "r0");
        assert_eq!(id1, "r1");
    }

    #[test]
    fn test_wire_node_serialization() {
        let node = WireNode {
            id: "FUNCTION:foo:src/main.js".to_string(),
            semantic_id: None,
            node_type: Some("FUNCTION".to_string()),
            name: Some("foo".to_string()),
            file: Some("src/main.js".to_string()),
            exported: false,
            metadata: Some(r#"{"line":10}"#.to_string()),
        };
        let json = serde_json::to_value(&node).unwrap();
        assert_eq!(json["id"], "FUNCTION:foo:src/main.js");
        assert_eq!(json["nodeType"], "FUNCTION");
        assert_eq!(json["name"], "foo");
        assert_eq!(json["file"], "src/main.js");
        assert_eq!(json["exported"], false);
        // semanticId should be absent (skip_serializing_if = None)
        assert!(json.get("semanticId").is_none());
    }

    #[test]
    fn test_wire_node_optional_fields_skipped() {
        let node = WireNode {
            id: "minimal".to_string(),
            semantic_id: None,
            node_type: None,
            name: None,
            file: None,
            exported: true,
            metadata: None,
        };
        let json = serde_json::to_value(&node).unwrap();
        assert_eq!(json["id"], "minimal");
        assert_eq!(json["exported"], true);
        assert!(json.get("semanticId").is_none());
        assert!(json.get("nodeType").is_none());
        assert!(json.get("name").is_none());
        assert!(json.get("file").is_none());
        assert!(json.get("metadata").is_none());
    }

    #[test]
    fn test_wire_edge_serialization() {
        let edge = WireEdge {
            src: "node_a".to_string(),
            dst: "node_b".to_string(),
            edge_type: "CALLS".to_string(),
            metadata: Some(r#"{"argIndex":0}"#.to_string()),
        };
        let json = serde_json::to_value(&edge).unwrap();
        assert_eq!(json["src"], "node_a");
        assert_eq!(json["dst"], "node_b");
        assert_eq!(json["edgeType"], "CALLS");
        assert_eq!(json["metadata"], r#"{"argIndex":0}"#);
    }

    #[test]
    fn test_wire_edge_no_metadata() {
        let edge = WireEdge {
            src: "a".to_string(),
            dst: "b".to_string(),
            edge_type: "IMPORTS".to_string(),
            metadata: None,
        };
        let json = serde_json::to_value(&edge).unwrap();
        assert!(json.get("metadata").is_none());
    }

    #[test]
    fn test_request_envelope_serialization() {
        let envelope = RequestEnvelope {
            request_id: "r42".to_string(),
            cmd: "ping".to_string(),
            params: serde_json::json!({}),
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["requestId"], "r42");
        assert_eq!(json["cmd"], "ping");
    }

    #[test]
    fn test_request_envelope_with_params() {
        let envelope = RequestEnvelope {
            request_id: "r0".to_string(),
            cmd: "hello".to_string(),
            params: serde_json::json!({
                "protocolVersion": 3,
                "clientId": "grafema-orchestrator",
            }),
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["requestId"], "r0");
        assert_eq!(json["cmd"], "hello");
        assert_eq!(json["protocolVersion"], 3);
        assert_eq!(json["clientId"], "grafema-orchestrator");
    }

    #[test]
    fn test_commit_delta_default() {
        let delta = CommitDelta::default();
        assert_eq!(delta.nodes_added, 0);
        assert_eq!(delta.nodes_removed, 0);
        assert_eq!(delta.edges_added, 0);
        assert_eq!(delta.edges_removed, 0);
        assert!(delta.changed_node_types.is_empty());
        assert!(delta.changed_edge_types.is_empty());
    }

    #[test]
    fn test_raw_response_check_error_ok() {
        let resp = RawResponse {
            request_id: Some("r0".to_string()),
            error: None,
            code: None,
            ok: Some(true),
            pong: None,
            protocol_version: None,
            server_version: None,
            features: None,
            database_id: None,
            mode: None,
            node_count: None,
            edge_count: None,
            delta: None,
            results: None,
            nodes: None,
        };
        assert!(resp.check_error().is_ok());
    }

    #[test]
    fn test_raw_response_check_error_with_error() {
        let resp = RawResponse {
            request_id: Some("r0".to_string()),
            error: Some("something went wrong".to_string()),
            code: Some("BAD_REQUEST".to_string()),
            ok: None,
            pong: None,
            protocol_version: None,
            server_version: None,
            features: None,
            database_id: None,
            mode: None,
            node_count: None,
            edge_count: None,
            delta: None,
            results: None,
            nodes: None,
        };
        let err = resp.check_error().unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("something went wrong"));
        assert!(msg.contains("BAD_REQUEST"));
    }

    #[test]
    fn test_msgpack_round_trip_request() {
        let envelope = RequestEnvelope {
            request_id: "r5".to_string(),
            cmd: "ping".to_string(),
            params: serde_json::json!({}),
        };
        let bytes = rmp_serde::to_vec_named(&envelope).unwrap();
        // Decode back as a generic map to verify named fields
        let decoded: serde_json::Value = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded["requestId"], "r5");
        assert_eq!(decoded["cmd"], "ping");
    }

    #[test]
    fn test_msgpack_round_trip_wire_node() {
        let node = WireNode {
            id: "test_id".to_string(),
            semantic_id: Some("FUNCTION:test:file.js".to_string()),
            node_type: Some("FUNCTION".to_string()),
            name: Some("test".to_string()),
            file: Some("file.js".to_string()),
            exported: true,
            metadata: Some(r#"{"line":1}"#.to_string()),
        };
        let bytes = rmp_serde::to_vec_named(&node).unwrap();
        let decoded: WireNode = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded.id, node.id);
        assert_eq!(decoded.semantic_id, node.semantic_id);
        assert_eq!(decoded.node_type, node.node_type);
        assert_eq!(decoded.name, node.name);
        assert_eq!(decoded.file, node.file);
        assert_eq!(decoded.exported, node.exported);
        assert_eq!(decoded.metadata, node.metadata);
    }

    #[test]
    fn test_error_display() {
        let err = RfdbError::Server {
            message: "not found".to_string(),
            code: Some("NOT_FOUND".to_string()),
        };
        assert_eq!(
            err.to_string(),
            "RFDB server error: not found (code: Some(\"NOT_FOUND\"))"
        );

        let err2 = RfdbError::ProtocolMismatch {
            expected: 3,
            got: 2,
        };
        assert_eq!(
            err2.to_string(),
            "Protocol version mismatch: expected 3, got 2"
        );

        let err3 = RfdbError::MessageTooLarge {
            size: 200_000_000,
            max: MAX_MESSAGE_SIZE,
        };
        assert!(err3.to_string().contains("200000000"));
    }

    #[test]
    fn test_commit_chunk_size_constant() {
        assert_eq!(COMMIT_CHUNK_SIZE, 10_000);
    }
}
