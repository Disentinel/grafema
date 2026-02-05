# REG-335: RFDB Multi-Database Server Mode - Technical Specification

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2026-02-04
**Based on:** Don's Analysis (`001-don-analysis.md`)
**Status:** Ready for Implementation

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Wire Protocol Changes](#2-wire-protocol-changes)
3. [Rust Server Changes](#3-rust-server-changes)
4. [Node.js Client Changes](#4-nodejs-client-changes)
5. [Test Helper API](#5-test-helper-api)
6. [Implementation Order](#6-implementation-order)
7. [Big-O Complexity Analysis](#7-big-o-complexity-analysis)
8. [Answers to Don's Open Questions](#8-answers-to-dons-open-questions)

---

## 1. Executive Summary

This specification details the implementation of multi-database support for RFDB server. The key architectural components are:

1. **DatabaseManager** - Thread-safe registry of open databases
2. **ClientSession** - Per-connection state tracking current database
3. **Protocol Extension** - 6 new commands for database lifecycle
4. **Concurrency** - RwLock on GraphEngine handles concurrent writes at request level

The implementation preserves backwards compatibility by making database selection optional - legacy clients can continue using the server with a single implicit database.

---

## 2. Wire Protocol Changes

### 2.1 Protocol Version Header

Add version negotiation on connection. First message from client after connect:

```
Request (new - optional):
{
  "cmd": "hello",
  "protocolVersion": 2,
  "clientId": "optional-identifier"
}

Response:
{
  "ok": true,
  "protocolVersion": 2,
  "serverVersion": "0.1.0",
  "features": ["multiDatabase", "ephemeral"]
}
```

If client doesn't send `hello`, server assumes protocol version 1 (backwards compatible mode - uses implicit default database).

### 2.2 New Commands

All commands use existing MessagePack framing: `[4-byte length BE][MessagePack payload]`

#### 2.2.1 CreateDatabase

Creates a new database. Does NOT open it.

```
Request:
{
  "cmd": "createDatabase",
  "name": "test-abc123",
  "ephemeral": true  // optional, default false
}

Success Response:
{
  "ok": true,
  "databaseId": "test-abc123"
}

Error Response:
{
  "error": "Database 'test-abc123' already exists"
}
```

#### 2.2.2 OpenDatabase

Opens a database and sets it as current for this session. Acquires lock if mode is "rw".

```
Request:
{
  "cmd": "openDatabase",
  "name": "test-abc123",
  "mode": "rw"  // "rw" | "ro", default "rw"
}

Success Response:
{
  "ok": true,
  "databaseId": "test-abc123",
  "mode": "rw",
  "nodeCount": 0,
  "edgeCount": 0
}

Error Response (not found):
{
  "error": "Database 'test-abc123' does not exist",
  "code": "DATABASE_NOT_FOUND"
}
```

#### 2.2.3 CloseDatabase

Closes current database, decrements connection count. Ephemeral databases are destroyed when no connections remain.

```
Request:
{
  "cmd": "closeDatabase"
}

Success Response:
{
  "ok": true
}

Error Response:
{
  "error": "No database currently open"
}
```

#### 2.2.4 DropDatabase

Permanently deletes a database. Must not be open by any client.

```
Request:
{
  "cmd": "dropDatabase",
  "name": "test-abc123"
}

Success Response:
{
  "ok": true
}

Error Response:
{
  "error": "Database 'test-abc123' is in use",
  "code": "DATABASE_IN_USE"
}
```

#### 2.2.5 ListDatabases

Lists all databases managed by this server.

```
Request:
{
  "cmd": "listDatabases"
}

Response:
{
  "databases": [
    {
      "name": "main",
      "ephemeral": false,
      "nodeCount": 1500,
      "edgeCount": 3200,
      "connectionCount": 3
    },
    {
      "name": "test-abc123",
      "ephemeral": true,
      "nodeCount": 50,
      "edgeCount": 100,
      "connectionCount": 0
    }
  ]
}
```

#### 2.2.6 CurrentDatabase

Returns name of current database for this session.

```
Request:
{
  "cmd": "currentDatabase"
}

Response (has current):
{
  "database": "test-abc123",
  "mode": "rw"
}

Response (no current):
{
  "database": null
}
```

### 2.3 Error Codes

Add structured error codes for programmatic handling:

| Code | Meaning |
|------|---------|
| `DATABASE_NOT_FOUND` | Database doesn't exist |
| `DATABASE_IN_USE` | Cannot drop, database has open sessions |
| `DATABASE_EXISTS` | Cannot create, name already taken |
| `NO_DATABASE_SELECTED` | Operation requires open database |
| `READ_ONLY_MODE` | Write operation in read-only session |
| `INVALID_DATABASE_NAME` | Name validation failed |

### 2.4 Modified Commands

All existing data commands (`addNodes`, `addEdges`, `getNode`, etc.) now operate on the current database from session state. If no database is selected:

```
Error Response:
{
  "error": "No database selected. Use openDatabase first.",
  "code": "NO_DATABASE_SELECTED"
}
```

---

## 3. Rust Server Changes

### 3.1 File Structure

```
packages/rfdb-server/src/
├── bin/
│   └── rfdb_server.rs          # Modified - uses DatabaseManager
├── session.rs                   # NEW - ClientSession struct
├── database_manager.rs          # NEW - DatabaseManager struct
├── error.rs                     # Modified - add new error variants
├── graph/
│   └── engine.rs               # Unchanged
└── ...
```

### 3.2 New File: `src/error.rs` (Modified)

Add new error variants:

```rust
// Add to existing GraphError enum
#[derive(Error, Debug)]
pub enum GraphError {
    // ... existing variants ...

    #[error("Database '{0}' already exists")]
    DatabaseExists(String),

    #[error("Database '{0}' not found")]
    DatabaseNotFound(String),


    #[error("Database '{0}' is in use and cannot be dropped")]
    DatabaseInUse(String),

    #[error("No database selected")]
    NoDatabaseSelected,

    #[error("Operation not allowed in read-only mode")]
    ReadOnlyMode,

    #[error("Invalid database name: {0}")]
    InvalidDatabaseName(String),
}

// Error code mapping for wire protocol
impl GraphError {
    pub fn code(&self) -> &'static str {
        match self {
            GraphError::DatabaseExists(_) => "DATABASE_EXISTS",
            GraphError::DatabaseNotFound(_) => "DATABASE_NOT_FOUND",
            GraphError::DatabaseInUse(_) => "DATABASE_IN_USE",
            GraphError::NoDatabaseSelected => "NO_DATABASE_SELECTED",
            GraphError::ReadOnlyMode => "READ_ONLY_MODE",
            GraphError::InvalidDatabaseName(_) => "INVALID_DATABASE_NAME",
            _ => "INTERNAL_ERROR",
        }
    }
}
```

### 3.3 New File: `src/database_manager.rs`

```rust
//! DatabaseManager - Thread-safe registry of open databases

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::graph::GraphEngine;
use crate::error::{GraphError, Result};

/// Unique identifier for a client connection
pub type ClientId = usize;

/// Access mode for database sessions
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    ReadOnly,
    ReadWrite,
}

impl AccessMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "ro" | "readonly" | "read-only" => AccessMode::ReadOnly,
            _ => AccessMode::ReadWrite,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            AccessMode::ReadOnly => "ro",
            AccessMode::ReadWrite => "rw",
        }
    }

    pub fn is_write(&self) -> bool {
        matches!(self, AccessMode::ReadWrite)
    }
}

/// Database entry in the manager
pub struct Database {
    pub name: String,
    pub engine: RwLock<GraphEngine>,
    pub ephemeral: bool,
    /// Number of active connections to this database
    connection_count: AtomicUsize,
}

impl Database {
    fn new(name: String, engine: GraphEngine, ephemeral: bool) -> Self {
        Self {
            name,
            engine: RwLock::new(engine),
            ephemeral,
            connection_count: AtomicUsize::new(0),
        }
    }

    /// Increment connection count when client opens database
    pub fn add_connection(&self) {
        self.connection_count.fetch_add(1, Ordering::SeqCst);
    }

    /// Decrement connection count when client closes database
    pub fn remove_connection(&self) {
        self.connection_count.fetch_sub(1, Ordering::SeqCst);
    }

    /// Get current connection count
    pub fn connection_count(&self) -> usize {
        self.connection_count.load(Ordering::SeqCst)
    }

    /// Check if database is in use (has any connections)
    pub fn is_in_use(&self) -> bool {
        self.connection_count() > 0
    }

    /// Get node count (for stats)
    pub fn node_count(&self) -> usize {
        self.engine.read().unwrap().node_count()
    }

    /// Get edge count (for stats)
    pub fn edge_count(&self) -> usize {
        self.engine.read().unwrap().edge_count()
    }
}

/// Database information for ListDatabases response
#[derive(Debug, Clone)]
pub struct DatabaseInfo {
    pub name: String,
    pub ephemeral: bool,
    pub node_count: usize,
    pub edge_count: usize,
    pub connection_count: usize,
}

/// DatabaseManager - manages multiple databases
pub struct DatabaseManager {
    /// All open databases
    databases: RwLock<HashMap<String, Arc<Database>>>,
    /// Base path for persistent databases
    base_path: PathBuf,
}

impl DatabaseManager {
    /// Create a new DatabaseManager
    /// base_path: directory where persistent databases are stored
    pub fn new(base_path: PathBuf) -> Self {
        Self {
            databases: RwLock::new(HashMap::new()),
            base_path,
        }
    }

    /// Validate database name
    /// Allowed: [a-zA-Z0-9_-], length 1-128
    fn validate_name(name: &str) -> Result<()> {
        if name.is_empty() || name.len() > 128 {
            return Err(GraphError::InvalidDatabaseName(
                "Name must be 1-128 characters".to_string()
            ));
        }

        let valid = name.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '_' || c == '-'
        });

        if !valid {
            return Err(GraphError::InvalidDatabaseName(
                "Name can only contain a-z, A-Z, 0-9, _, -".to_string()
            ));
        }

        Ok(())
    }

    /// Create a new database
    /// ephemeral: if true, database is in-memory only and deleted on close
    pub fn create_database(&self, name: &str, ephemeral: bool) -> Result<()> {
        Self::validate_name(name)?;

        let mut databases = self.databases.write().unwrap();

        if databases.contains_key(name) {
            return Err(GraphError::DatabaseExists(name.to_string()));
        }

        let engine = if ephemeral {
            // Ephemeral: create in-memory without disk path
            // We use a temp path that won't be used
            GraphEngine::create_ephemeral()?
        } else {
            // Persistent: create at base_path/name.rfdb
            let db_path = self.base_path.join(format!("{}.rfdb", name));
            GraphEngine::create(&db_path)?
        };

        let database = Arc::new(Database::new(name.to_string(), engine, ephemeral));
        databases.insert(name.to_string(), database);

        Ok(())
    }

    /// Get a database by name (for opening)
    pub fn get_database(&self, name: &str) -> Result<Arc<Database>> {
        let databases = self.databases.read().unwrap();
        databases.get(name)
            .cloned()
            .ok_or_else(|| GraphError::DatabaseNotFound(name.to_string()))
    }

    /// Check if a database exists
    pub fn database_exists(&self, name: &str) -> bool {
        self.databases.read().unwrap().contains_key(name)
    }

    /// Drop a database (must not be in use)
    pub fn drop_database(&self, name: &str) -> Result<()> {
        let mut databases = self.databases.write().unwrap();

        let db = databases.get(name)
            .ok_or_else(|| GraphError::DatabaseNotFound(name.to_string()))?;

        if db.is_in_use() {
            return Err(GraphError::DatabaseInUse(name.to_string()));
        }

        // For persistent databases, delete files
        if !db.ephemeral {
            let db_path = self.base_path.join(format!("{}.rfdb", name));
            if db_path.exists() {
                std::fs::remove_dir_all(&db_path)?;
            }
        }

        databases.remove(name);
        Ok(())
    }

    /// List all databases
    pub fn list_databases(&self) -> Vec<DatabaseInfo> {
        let databases = self.databases.read().unwrap();
        databases.values()
            .map(|db| DatabaseInfo {
                name: db.name.clone(),
                ephemeral: db.ephemeral,
                node_count: db.node_count(),
                edge_count: db.edge_count(),
                connection_count: db.connection_count(),
            })
            .collect()
    }

    /// Create default database from legacy db_path
    /// Called during server startup for backwards compatibility
    pub fn create_default_from_path(&self, db_path: &PathBuf) -> Result<()> {
        let engine = if db_path.join("nodes.bin").exists() {
            GraphEngine::open(db_path)?
        } else {
            GraphEngine::create(db_path)?
        };

        let database = Arc::new(Database::new("default".to_string(), engine, false));

        let mut databases = self.databases.write().unwrap();
        databases.insert("default".to_string(), database);

        Ok(())
    }
}
```

### 3.4 New File: `src/session.rs`

```rust
//! ClientSession - Per-connection state

use std::sync::Arc;
use crate::database_manager::{Database, AccessMode, ClientId};

/// Session state for a client connection
pub struct ClientSession {
    /// Unique client ID
    pub id: ClientId,
    /// Currently selected database
    pub current_db: Option<Arc<Database>>,
    /// Access mode for current database
    pub access_mode: AccessMode,
    /// Protocol version negotiated
    pub protocol_version: u32,
}

impl ClientSession {
    pub fn new(id: ClientId) -> Self {
        Self {
            id,
            current_db: None,
            access_mode: AccessMode::ReadWrite,
            protocol_version: 1, // Default to v1 for backwards compat
        }
    }

    /// Set current database
    pub fn set_database(&mut self, db: Arc<Database>, mode: AccessMode) {
        self.current_db = Some(db);
        self.access_mode = mode;
    }

    /// Clear current database
    pub fn clear_database(&mut self) {
        self.current_db = None;
        self.access_mode = AccessMode::ReadWrite;
    }

    /// Get current database name
    pub fn current_db_name(&self) -> Option<&str> {
        self.current_db.as_ref().map(|db| db.name.as_str())
    }

    /// Check if in read-write mode
    pub fn can_write(&self) -> bool {
        self.access_mode.is_write()
    }

    /// Check if a database is selected
    pub fn has_database(&self) -> bool {
        self.current_db.is_some()
    }
}
```

### 3.5 Modified: `src/graph/engine.rs`

Add ephemeral database support:

```rust
impl GraphEngine {
    // ... existing code ...

    /// Create an ephemeral (in-memory only) database
    /// No files are written until flush is called, and even then
    /// it's to a temporary location that gets cleaned up.
    pub fn create_ephemeral() -> Result<Self> {
        // Use a temporary directory that we'll never actually use
        // The engine stores everything in delta_* fields until flush
        let temp_path = std::env::temp_dir()
            .join(format!("rfdb-ephemeral-{}", std::process::id()))
            .join(format!("{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()));

        // Don't create directory - ephemeral databases never flush to disk
        // They stay purely in delta_nodes and delta_edges

        Ok(Self {
            path: temp_path, // Used only for error messages
            nodes_segment: None,
            edges_segment: None,
            delta_log: DeltaLog::new(),
            delta_nodes: HashMap::new(),
            delta_edges: Vec::new(),
            adjacency: HashMap::new(),
            reverse_adjacency: HashMap::new(),
            metadata: GraphMetadata::default(),
            ops_since_flush: 0,
            last_memory_check: None,
            deleted_segment_ids: HashSet::new(),
        })
    }

    /// Check if this is an ephemeral database
    pub fn is_ephemeral(&self) -> bool {
        // Ephemeral databases have no segment files
        self.nodes_segment.is_none() && self.path.to_string_lossy().contains("rfdb-ephemeral")
    }
}
```

### 3.6 Modified: `src/bin/rfdb_server.rs`

Major changes to support multi-database:

```rust
//! RFDB Server - Unix socket server for GraphEngine
//!
//! Now supports multiple databases per server instance.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use serde::{Deserialize, Serialize};

use rfdb::graph::{GraphEngine, GraphStore};
use rfdb::storage::{NodeRecord, EdgeRecord, AttrQuery};
use rfdb::datalog::{parse_program, parse_atom, parse_query, Evaluator};
use rfdb::error::GraphError;

mod database_manager;
mod session;

use database_manager::{DatabaseManager, DatabaseInfo, AccessMode, ClientId};
use session::ClientSession;

// Global client ID counter
static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

// ============================================================================
// Wire Protocol Types (Extended)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum Request {
    // == New Database Management Commands ==
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<u32>,
        #[serde(rename = "clientId")]
        client_id: Option<String>,
    },
    CreateDatabase {
        name: String,
        #[serde(default)]
        ephemeral: bool,
    },
    OpenDatabase {
        name: String,
        #[serde(default = "default_rw_mode")]
        mode: String,
    },
    CloseDatabase,
    DropDatabase { name: String },
    ListDatabases,
    CurrentDatabase,

    // == Existing commands (unchanged) ==
    AddNodes { nodes: Vec<WireNode> },
    AddEdges {
        edges: Vec<WireEdge>,
        #[serde(default, rename = "skipValidation")]
        skip_validation: bool,
    },
    // ... all other existing commands ...
}

fn default_rw_mode() -> String { "rw".to_string() }

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    // == New responses ==
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

    // Structured error with code
    ErrorWithCode {
        error: String,
        code: String,
    },

    // == Existing responses (unchanged) ==
    Ok { ok: bool },
    Error { error: String },
    // ... all other existing responses ...
}

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

// ============================================================================
// Request Handler (Modified)
// ============================================================================

fn handle_request(
    manager: &DatabaseManager,
    session: &mut ClientSession,
    request: Request,
) -> Response {
    match request {
        // == Database Management ==
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
                handle_close_database(session);
            }

            let access_mode = AccessMode::from_str(&mode);

            match manager.get_database(&name) {
                Ok(db) => {
                    // Track connection (no write locking - RwLock handles concurrency)
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

            handle_close_database(session);
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

        // == Data Operations (require database) ==
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

        // ... all other existing commands wrapped with with_engine_read or with_engine_write ...

        Request::Ping => {
            Response::Pong { pong: true, version: env!("CARGO_PKG_VERSION").to_string() }
        }

        Request::Shutdown => {
            Response::Ok { ok: true }
        }

        _ => {
            // For commands requiring a database
            Response::ErrorWithCode {
                error: "Unknown command".to_string(),
                code: "UNKNOWN_COMMAND".to_string(),
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
fn handle_close_database(session: &mut ClientSession) {
    if let Some(db) = &session.current_db {
        db.remove_connection();
        // If ephemeral and no other users, drop it
        // Note: This happens automatically when Arc ref count drops
    }
    session.clear_database();
}

// ============================================================================
// Client Connection Handler (Modified)
// ============================================================================

fn handle_client(
    mut stream: UnixStream,
    manager: Arc<DatabaseManager>,
    client_id: ClientId,
    legacy_mode: bool,
) {
    eprintln!("[rfdb-server] Client {} connected", client_id);

    let mut session = ClientSession::new(client_id);

    // In legacy mode (protocol v1), auto-open "default" database
    if legacy_mode {
        if let Ok(db) = manager.get_database("default") {
            // Open default database with read-write mode
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

        let response = handle_request(&manager, &mut session, request);

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

    // Cleanup: close database and release locks
    handle_close_database(&mut session);
}

// ============================================================================
// Main (Modified)
// ============================================================================

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: rfdb-server <db-path> [--socket <socket-path>] [--data-dir <dir>]");
        eprintln!("");
        eprintln!("Arguments:");
        eprintln!("  <db-path>      Path to default graph database directory");
        eprintln!("  --socket       Unix socket path (default: /tmp/rfdb.sock)");
        eprintln!("  --data-dir     Base directory for multi-database storage");
        std::process::exit(1);
    }

    let db_path = PathBuf::from(&args[1]);
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

    // Remove stale socket
    let _ = std::fs::remove_file(socket_path);

    // Create database manager with data directory
    let manager = Arc::new(DatabaseManager::new(data_dir.clone()));

    // Create "default" database from legacy db_path for backwards compatibility
    eprintln!("[rfdb-server] Opening default database: {:?}", db_path);
    manager.create_default_from_path(&db_path)
        .expect("Failed to create default database");

    eprintln!("[rfdb-server] Data directory for multi-database: {:?}", data_dir);

    // Bind socket
    let listener = UnixListener::bind(socket_path).expect("Failed to bind socket");
    eprintln!("[rfdb-server] Listening on {}", socket_path);

    // Signal handler (unchanged from original)
    // ...

    // Accept connections
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::SeqCst);
                let manager_clone = Arc::clone(&manager);
                thread::spawn(move || {
                    // legacy_mode: true for now, until client sends Hello
                    handle_client(stream, manager_clone, client_id, true);
                });
            }
            Err(e) => {
                eprintln!("[rfdb-server] Accept error: {}", e);
            }
        }
    }
}
```

---

## 4. Node.js Client Changes

### 4.1 File: `packages/rfdb/ts/client.ts`

Add new methods for database management:

```typescript
// Add to IRFDBClient interface in @grafema/types
export interface IRFDBClient {
  // ... existing methods ...

  // Database management
  hello(protocolVersion?: number): Promise<HelloResponse>;
  createDatabase(name: string, ephemeral?: boolean): Promise<void>;
  openDatabase(name: string, mode?: 'rw' | 'ro'): Promise<OpenDatabaseResponse>;
  closeDatabase(): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  listDatabases(): Promise<DatabaseInfo[]>;
  currentDatabase(): Promise<{ database: string | null; mode: string | null }>;
}

export interface HelloResponse {
  protocolVersion: number;
  serverVersion: string;
  features: string[];
}

export interface OpenDatabaseResponse {
  databaseId: string;
  mode: string;
  nodeCount: number;
  edgeCount: number;
}

export interface DatabaseInfo {
  name: string;
  ephemeral: boolean;
  nodeCount: number;
  edgeCount: number;
  connectionCount: number;
}
```

Add implementations to `RFDBClient`:

```typescript
export class RFDBClient extends EventEmitter implements IRFDBClient {
  // ... existing code ...

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Negotiate protocol version with server
   */
  async hello(protocolVersion: number = 2): Promise<HelloResponse> {
    const response = await this._send('hello', { protocolVersion }) as {
      protocolVersion: number;
      serverVersion: string;
      features: string[];
    };
    return {
      protocolVersion: response.protocolVersion,
      serverVersion: response.serverVersion,
      features: response.features,
    };
  }

  /**
   * Create a new database
   * @param name Database name (alphanumeric, _, -)
   * @param ephemeral If true, database is in-memory only
   */
  async createDatabase(name: string, ephemeral: boolean = false): Promise<void> {
    const response = await this._send('createDatabase', { name, ephemeral });
    if ((response as { error?: string }).error) {
      throw new Error((response as { error: string; code?: string }).error);
    }
  }

  /**
   * Open a database and set it as current
   * @param name Database name
   * @param mode Access mode: 'rw' for read-write, 'ro' for read-only
   */
  async openDatabase(name: string, mode: 'rw' | 'ro' = 'rw'): Promise<OpenDatabaseResponse> {
    const response = await this._send('openDatabase', { name, mode }) as {
      databaseId?: string;
      mode?: string;
      nodeCount?: number;
      edgeCount?: number;
      error?: string;
      code?: string;
    };

    if (response.error) {
      const err = new Error(response.error) as Error & { code?: string };
      err.code = response.code;
      throw err;
    }

    return {
      databaseId: response.databaseId!,
      mode: response.mode!,
      nodeCount: response.nodeCount!,
      edgeCount: response.edgeCount!,
    };
  }

  /**
   * Close current database
   */
  async closeDatabase(): Promise<void> {
    const response = await this._send('closeDatabase');
    if ((response as { error?: string }).error) {
      throw new Error((response as { error: string }).error);
    }
  }

  /**
   * Permanently delete a database
   * Database must not be open by any client
   */
  async dropDatabase(name: string): Promise<void> {
    const response = await this._send('dropDatabase', { name });
    if ((response as { error?: string }).error) {
      const res = response as { error: string; code?: string };
      const err = new Error(res.error) as Error & { code?: string };
      err.code = res.code;
      throw err;
    }
  }

  /**
   * List all databases
   */
  async listDatabases(): Promise<DatabaseInfo[]> {
    const response = await this._send('listDatabases') as {
      databases: DatabaseInfo[];
    };
    return response.databases;
  }

  /**
   * Get current database
   */
  async currentDatabase(): Promise<{ database: string | null; mode: string | null }> {
    const response = await this._send('currentDatabase') as {
      database: string | null;
      mode: string | null;
    };
    return response;
  }
}
```

---

## 5. Test Helper API

### 5.1 File: `packages/rfdb/ts/test-helpers.ts`

Create a high-level test helper API:

```typescript
import { RFDBClient } from './client.js';
import type { WireNode, WireEdge } from '@grafema/types';

/**
 * Test database context
 */
export interface TestDatabase {
  name: string;
  client: RFDBClient;
  /** Close and drop the test database */
  dispose(): Promise<void>;
}

/**
 * Test helper options
 */
export interface TestHelperOptions {
  socketPath?: string;
  /** Prefix for generated database names */
  namePrefix?: string;
}

/**
 * Generate a unique test database name
 */
function generateTestDbName(prefix: string = 'test'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Create a test database with automatic cleanup
 *
 * @example
 * ```typescript
 * import { createTestDatabase } from '@grafema/rfdb-client/test-helpers';
 *
 * describe('my test', () => {
 *   let testDb: TestDatabase;
 *
 *   before(async () => {
 *     testDb = await createTestDatabase();
 *   });
 *
 *   after(async () => {
 *     await testDb.dispose();
 *   });
 *
 *   it('should work', async () => {
 *     await testDb.client.addNodes([...]);
 *   });
 * });
 * ```
 */
export async function createTestDatabase(
  options: TestHelperOptions = {}
): Promise<TestDatabase> {
  const socketPath = options.socketPath || '/tmp/rfdb.sock';
  const name = generateTestDbName(options.namePrefix);

  const client = new RFDBClient(socketPath);
  await client.connect();

  // Create ephemeral database
  await client.createDatabase(name, true);
  await client.openDatabase(name, 'rw');

  return {
    name,
    client,
    async dispose() {
      try {
        await client.closeDatabase();
        await client.dropDatabase(name);
      } catch {
        // Best effort cleanup
      }
      await client.close();
    },
  };
}

/**
 * Run a test function with a fresh ephemeral database
 *
 * @example
 * ```typescript
 * import { withTestDatabase } from '@grafema/rfdb-client/test-helpers';
 *
 * it('should work', async () => {
 *   await withTestDatabase(async (client) => {
 *     await client.addNodes([...]);
 *     const count = await client.nodeCount();
 *     assert.equal(count, 1);
 *   });
 * });
 * ```
 */
export async function withTestDatabase(
  fn: (client: RFDBClient) => Promise<void>,
  options: TestHelperOptions = {}
): Promise<void> {
  const testDb = await createTestDatabase(options);
  try {
    await fn(testDb.client);
  } finally {
    await testDb.dispose();
  }
}

/**
 * Create multiple isolated test databases
 * Useful for parallel test execution
 *
 * @example
 * ```typescript
 * const [db1, db2, db3] = await createTestDatabases(3);
 * // Run tests in parallel
 * await Promise.all([
 *   runTest1(db1.client),
 *   runTest2(db2.client),
 *   runTest3(db3.client),
 * ]);
 * // Cleanup
 * await Promise.all([db1.dispose(), db2.dispose(), db3.dispose()]);
 * ```
 */
export async function createTestDatabases(
  count: number,
  options: TestHelperOptions = {}
): Promise<TestDatabase[]> {
  const databases: TestDatabase[] = [];

  for (let i = 0; i < count; i++) {
    const db = await createTestDatabase({
      ...options,
      namePrefix: options.namePrefix ? `${options.namePrefix}-${i}` : `test-${i}`,
    });
    databases.push(db);
  }

  return databases;
}

/**
 * Seed a test database with nodes and edges
 */
export async function seedTestDatabase(
  client: RFDBClient,
  data: {
    nodes?: Array<Partial<WireNode> & { id: string }>;
    edges?: WireEdge[];
  }
): Promise<void> {
  if (data.nodes && data.nodes.length > 0) {
    await client.addNodes(data.nodes);
  }
  if (data.edges && data.edges.length > 0) {
    await client.addEdges(data.edges);
  }
}
```

### 5.2 Usage in Tests

Update test files to use the new helpers:

```typescript
// test/unit/datalog.test.ts (example migration)
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestDatabase, seedTestDatabase } from '@grafema/rfdb-client/test-helpers';
import type { TestDatabase } from '@grafema/rfdb-client/test-helpers';

describe('Datalog Queries', () => {
  let testDb: TestDatabase;

  before(async () => {
    testDb = await createTestDatabase({ namePrefix: 'datalog-test' });

    // Seed with test data
    await seedTestDatabase(testDb.client, {
      nodes: [
        { id: 'FUNC#1', nodeType: 'FUNCTION', name: 'foo', file: 'test.js' },
        { id: 'FUNC#2', nodeType: 'FUNCTION', name: 'bar', file: 'test.js' },
      ],
      edges: [
        { src: 'FUNC#1', dst: 'FUNC#2', edgeType: 'CALLS' },
      ],
    });
  });

  after(async () => {
    await testDb.dispose();
  });

  it('should query nodes by type', async () => {
    const functions = await testDb.client.findByType('FUNCTION');
    assert.equal(functions.length, 2);
  });
});
```

---

## 6. Implementation Order

### Phase 1: Core Infrastructure (3-4 days)

**Step 1.1: Error types** (0.5 day)
- Add new error variants to `src/error.rs`
- Add `code()` method for wire protocol

**Step 1.2: DatabaseManager** (2 days)
- Create `src/database_manager.rs`
- Implement `Database` struct with locking
- Implement `DatabaseManager` with CRUD operations
- Unit tests for manager

**Step 1.3: GraphEngine ephemeral mode** (0.5 day)
- Add `create_ephemeral()` method
- Add `is_ephemeral()` helper

**Step 1.4: ClientSession** (0.5 day)
- Create `src/session.rs`
- Implement session state management

### Phase 2: Protocol Extension (2-3 days)

**Step 2.1: Request/Response types** (0.5 day)
- Add new Request variants
- Add new Response variants
- Add WireDatabaseInfo

**Step 2.2: Request handler** (1.5 days)
- Implement handlers for 6 new commands
- Add `with_engine_read` / `with_engine_write` helpers
- Add `handle_close_database` cleanup

**Step 2.3: Main loop changes** (1 day)
- Initialize DatabaseManager
- Create default database for backwards compat
- Pass manager to client handlers
- Handle legacy mode (protocol v1)

### Phase 3: Node.js Client (2 days)

**Step 3.1: Types** (0.5 day)
- Add new interfaces to `@grafema/types`
- Export from index

**Step 3.2: Client methods** (1 day)
- Implement 7 new methods in RFDBClient
- Handle error codes

**Step 3.3: Test helpers** (0.5 day)
- Create `test-helpers.ts`
- Implement `createTestDatabase`, `withTestDatabase`

### Phase 4: Integration & Testing (2-3 days)

**Step 4.1: Rust unit tests** (1 day)
- DatabaseManager tests
- Session tests
- Locking tests

**Step 4.2: Integration tests** (1.5 days)
- Multi-client scenarios
- Lock conflict handling
- Ephemeral database lifecycle
- Protocol v1 backwards compatibility

**Step 4.3: Migrate existing tests** (0.5 day)
- Update 2-3 test files to use new helpers
- Document migration pattern

### Total: 9-12 days

---

## 7. Big-O Complexity Analysis

### DatabaseManager Operations

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `create_database` | O(1) amortized | HashMap insert + GraphEngine::create |
| `get_database` | O(1) | HashMap lookup |
| `drop_database` | O(1) + O(files) | HashMap remove + fs::remove_dir_all |
| `list_databases` | O(n) | Iterate all databases |
| `database_exists` | O(1) | HashMap contains |

### Connection Tracking

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `add_connection` | O(1) | Atomic increment |
| `remove_connection` | O(1) | Atomic decrement |
| `is_in_use` | O(1) | Atomic read |

**Note:** Write concurrency is handled by `RwLock<GraphEngine>` at request level, not session level. Multiple clients can write to the same database concurrently (requests are serialized by RwLock).

### Memory Usage

| Component | Per Database | Notes |
|-----------|--------------|-------|
| Database struct | ~200 bytes | Fixed overhead |
| GraphEngine (empty) | ~500 bytes | HashMap + Vec structures |
| Per node | ~100 bytes | NodeRecord + delta entry |
| Per edge | ~50 bytes | EdgeRecord + adjacency entry |

For 100 concurrent ephemeral databases with 1000 nodes each:
- ~100KB fixed overhead
- ~10MB node data
- Total: ~10MB (well within 80% memory threshold)

---

## 8. Answers to Don's Open Questions

### 8.1 Ephemeral database storage

**Decision:** Use purely in-memory storage (HashMap in delta_nodes/delta_edges).

**Rationale:**
- Ephemeral databases never call `flush()` to disk
- All data stays in GraphEngine's delta_* fields
- Cleanup is automatic when Database Arc drops (Rust ownership)
- No temp files to manage or clean up

### 8.2 Database name validation

**Decision:** Allow `[a-zA-Z0-9_-]`, length 1-128.

**Rationale:**
- Safe for filesystem paths (no `/`, `\`, `.`, spaces)
- Compatible with most shells without quoting
- Allows meaningful names like `test-user-123-session-456`
- 128 char limit prevents abuse

### 8.3 Connection pooling

**Decision:** Design for it but don't implement yet.

**Current:** Each test creates its own connection + ephemeral database.

**Future-proofing:**
- Session tracks `client_id` (already in spec)
- Multiple connections can share same database (read-only)
- Connection pooling would be in RFDBClient layer, not server

### 8.4 Metrics

**Decision:** Include basic metrics in ListDatabases, defer detailed metrics.

**Included:**
- nodeCount, edgeCount per database
- connectionCount

**Deferred (future issue):**
- Memory usage per database
- Operation counts
- Query latency percentiles

### 8.5 Hot reload

**Decision:** No auto-reopen on restart.

**Rationale:**
- Ephemeral databases are lost by definition
- Persistent databases can be reopened by client
- Tracking "what was open" adds complexity with minimal benefit
- Server restart is rare in test scenarios

---

## Appendix A: Wire Protocol Summary

```
// New commands (protocol v2)
Hello            -> HelloOk
CreateDatabase   -> DatabaseCreated | ErrorWithCode
OpenDatabase     -> DatabaseOpened | ErrorWithCode
CloseDatabase    -> Ok | Error
DropDatabase     -> Ok | ErrorWithCode
ListDatabases    -> DatabaseList
CurrentDatabase  -> CurrentDb

// Existing commands (unchanged, now require open database)
AddNodes, AddEdges, GetNode, FindByType, etc.
  -> Same responses, or ErrorWithCode("NO_DATABASE_SELECTED")

// Error codes
DATABASE_EXISTS, DATABASE_NOT_FOUND,
DATABASE_IN_USE, NO_DATABASE_SELECTED, READ_ONLY_MODE,
INVALID_DATABASE_NAME
```

---

## Appendix B: Files to Create/Modify

**New files:**
- `packages/rfdb-server/src/database_manager.rs`
- `packages/rfdb-server/src/session.rs`
- `packages/rfdb/ts/test-helpers.ts`

**Modified files:**
- `packages/rfdb-server/src/error.rs` (add error variants)
- `packages/rfdb-server/src/graph/engine.rs` (add ephemeral support)
- `packages/rfdb-server/src/bin/rfdb_server.rs` (major refactor)
- `packages/rfdb/ts/client.ts` (add methods)
- `packages/types/src/rfdb.ts` (add interfaces)

---

## Appendix C: Backwards Compatibility

Protocol v1 clients (existing):
1. Connect to server
2. Server auto-opens "default" database
3. All operations work on default database
4. No Hello/CreateDatabase/OpenDatabase needed

Protocol v2 clients (new):
1. Connect to server
2. Send Hello with protocolVersion: 2
3. Create/Open specific database
4. Operations work on selected database
5. Must close/drop when done

The server detects protocol version from first message:
- If `Hello` -> v2 client
- If any other command -> v1 client (use default database)
