# REG-335: RFDB Multi-Database Server Mode - Technical Analysis

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-04
**Status:** Analysis Complete

---

## 1. Problem Statement

The current RFDB server architecture requires one server process per database. Each test that needs an isolated database must:

1. Spawn a new rfdb-server process (~5 seconds startup overhead)
2. Wait for the server to be ready
3. Run the test
4. Shut down the server

With a growing test suite, this results in 30+ minutes for the full test run, making TDD workflows painful.

**Goal:** Enable a single RFDB server process to manage multiple databases, allowing tests to:
- Share a single server process
- Each get their own isolated database
- Run in parallel without interference
- Have near-zero overhead for database creation/destruction

---

## 2. Prior Art Research

### 2.1 Redis Multi-Database Model

Redis supports [16 logical databases](https://redis.io/docs/latest/commands/select/) (numbered 0-15) via the `SELECT` command. Key characteristics:

- **Connection-scoped selection:** The selected database is a property of the connection
- **Shared persistence:** All databases share the same RDB/AOF files
- **Namespace isolation:** Different databases can have keys with the same name
- **Commands like FLUSHDB, SWAPDB work on specific databases**

However, Redis creator Salvatore Sanfilippo considers this ["one of the worst design decisions"](https://medium.com/@stockholmux/in-defense-of-select-dbs-in-redis-947e1a2d86e) because:
- It complicates internals without real isolation
- Modern Redis Cluster doesn't support SELECT (only database 0)
- Redis Enterprise doesn't support logical databases

**Lesson:** A simpler model with true database isolation is preferred over numbered database slots.

### 2.2 SQLite ATTACH DATABASE

SQLite's [ATTACH DATABASE](https://sqlite.org/lang_attach.html) allows multiple database files within one connection:

- Each database gets a schema name (`main`, `temp`, or custom alias)
- Cross-database queries work via qualified table names
- [SQLite serializes writes](https://sqlite.org/lockingv3.html) - only one writer at a time per database
- Different connections can access different databases concurrently

Key insight from SQLite's [isolation documentation](https://sqlite.org/isolation.html):
> "If the same database is being read and written using two different database connections... the reader is only able to see complete committed transactions from the writer."

**Lesson:** Per-database write serialization is the right model for ACID guarantees.

### 2.3 PostgreSQL Multi-Database

PostgreSQL runs multiple databases within one cluster:
- Each database has its own namespace, schema, and connections
- `CREATE DATABASE` / `DROP DATABASE` for lifecycle
- Connections target a specific database at connection time
- Supports multiple isolation levels (READ COMMITTED, REPEATABLE READ, SERIALIZABLE)

**Lesson:** Named databases with explicit open/close lifecycle is cleaner than numbered slots.

---

## 3. Current RFDB Server Architecture

### 3.1 Server Structure (`src/bin/rfdb_server.rs`)

```rust
// Current single-database model
fn main() {
    let db_path = PathBuf::from(&args[1]);      // Single DB path
    let engine = GraphEngine::open(&db_path)?;  // One engine
    let engine = Arc<RwLock<GraphEngine>>;      // Shared across threads

    // Accept connections, each spawns thread with Arc clone
    for stream in listener.incoming() {
        let engine_clone = Arc::clone(&engine);
        thread::spawn(move || {
            handle_client(stream, engine_clone, client_id);
        });
    }
}
```

Key observations:
- **Single GraphEngine per server process**
- **Arc<RwLock<GraphEngine>> for thread-safe access**
- **All clients share the same engine**
- **RwLock allows concurrent reads, serialized writes**

### 3.2 GraphEngine Structure (`src/graph/engine.rs`)

```rust
pub struct GraphEngine {
    path: PathBuf,                              // Database directory
    nodes_segment: Option<NodesSegment>,        // mmap'd nodes
    edges_segment: Option<EdgesSegment>,        // mmap'd edges
    delta_log: DeltaLog,                        // Pending changes
    delta_nodes: HashMap<u128, NodeRecord>,     // In-memory cache
    delta_edges: Vec<EdgeRecord>,
    adjacency: HashMap<u128, Vec<usize>>,
    reverse_adjacency: HashMap<u128, Vec<usize>>,
    // ...
}
```

Key operations:
- `GraphEngine::create(path)` - Create new empty database
- `GraphEngine::open(path)` - Open existing database
- `flush()` - Write delta to disk
- `clear()` - Reset database state

### 3.3 Wire Protocol

MessagePack-based request/response over Unix socket:
- Request: `[4-byte length BE][MessagePack payload]`
- Commands: `AddNodes`, `GetNode`, `FindByType`, `Flush`, `Shutdown`, etc.

---

## 4. Proposed Multi-Database Architecture

### 4.1 Core Concept

Instead of one `Arc<RwLock<GraphEngine>>`, the server maintains:

```rust
struct DatabaseManager {
    databases: RwLock<HashMap<String, Arc<Database>>>,
    base_path: PathBuf,
}

struct Database {
    name: String,
    engine: RwLock<GraphEngine>,  // Handles concurrent access at request level
    connection_count: AtomicUsize,
}
```

### 4.2 Client Session Model

Each client connection has:

```rust
struct ClientSession {
    id: ClientId,
    current_db: Option<String>,
    access_mode: AccessMode,  // ReadOnly | ReadWrite
}

enum AccessMode {
    ReadOnly,
    ReadWrite,
}
```

### 4.3 New Protocol Commands

| Command | Description | Parameters |
|---------|-------------|------------|
| `CreateDatabase` | Create new empty database | `name: String` |
| `OpenDatabase` | Open and switch to database | `name: String, mode: "rw" \| "ro"` |
| `CloseDatabase` | Close current database | - |
| `DropDatabase` | Delete database permanently | `name: String` |
| `ListDatabases` | List all available databases | - |
| `CurrentDatabase` | Get name of current database | - |

### 4.4 Concurrency Model

**Existing RwLock on GraphEngine (Preserved):**

The current RFDB architecture already handles concurrent access correctly:

```rust
// Current model - KEEP AS IS
struct Database {
    engine: RwLock<GraphEngine>,  // Multiple readers OR one writer per request
}
```

**Key insight:** Locking happens at the REQUEST level, not SESSION level:
- Multiple clients can interleave writes (each request acquires/releases lock)
- This is exactly what parallel analysis workers need
- No additional session-level locking required

**Why NOT single-writer-per-session:**
- ANALYSIS phase runs N parallel workers writing to same graph
- Single-writer would serialize all analysis → defeat purpose of parallelization
- This is why we moved to client-server architecture in the first place

**Access Mode (Advisory Only):**
- `mode: "rw" | "ro"` in OpenDatabase is a HINT, not enforced
- Useful for: monitoring, debugging, future optimizations
- Does NOT block other writers

### 4.5 Database Lifecycle

```
CreateDatabase("test-123")
    ↓
[Database created at base_path/test-123.rfdb/]
    ↓
OpenDatabase("test-123", "rw")
    ↓
[Client session bound to test-123, connection count++]
    ↓
AddNodes, AddEdges, etc. [work on test-123, RwLock serializes requests]
    ↓
CloseDatabase
    ↓
[Connection count--, session unbound]
    ↓
DropDatabase("test-123")
    ↓
[Directory removed from disk]
```

### 4.6 Protocol Changes

**Before (current):**
```json
{ "cmd": "AddNodes", "nodes": [...] }
```

**After (unchanged for backwards compatibility):**
```json
{ "cmd": "AddNodes", "nodes": [...] }
```

Operations work on `current_db` from session. If no database selected, return error:
```json
{ "error": "No database selected. Use OpenDatabase first." }
```

---

## 5. Implementation Plan

### 5.1 Phase 1: Database Manager (3-4 days)

1. **DatabaseManager struct** with thread-safe database registry
2. **Database struct** wrapping GraphEngine with access control
3. **In-memory database creation** (ephemeral mode for tests)
4. Unit tests for manager lifecycle

### 5.2 Phase 2: Session Management (2-3 days)

1. **ClientSession struct** tracking current database and access mode
2. Per-connection session state in `handle_client`
3. Session cleanup on disconnect (release locks)
4. Unit tests for session lifecycle

### 5.3 Phase 3: Protocol Extension (2-3 days)

1. Add new Request variants: `CreateDatabase`, `OpenDatabase`, etc.
2. Update `handle_request` to check session state
3. Error responses for invalid operations
4. Integration tests with multiple databases

### 5.4 Phase 4: Node.js Client Update (2-3 days)

1. Update `packages/core/src/rfdb-client.ts` with new commands
2. Session management helpers
3. Test helper utilities (createTestDatabase, withTestDatabase)
4. Integration tests

**Total: 9-13 days** (reduced - no custom write locking needed)

---

## 6. Detailed Design Decisions

### 6.1 Why Not Numbered Databases Like Redis?

Redis's numbered databases (0-15) are:
- Fixed limit (16)
- Confusing to track ("what's in db 7?")
- Deprecated in Redis Cluster

Named databases are:
- Unlimited (bounded by disk/memory)
- Self-documenting ("test-123", "user-alice-session")
- Easy to debug (list databases shows names)

### 6.2 Why No Session-Level Write Locking?

**Decision:** Rely on existing `RwLock<GraphEngine>` for concurrency.

**Reason:** Parallel analysis workers need concurrent write access:
- ANALYSIS phase runs N workers writing to same graph
- Session-level locking would serialize analysis → defeat purpose
- RwLock already provides request-level serialization
- This is exactly why we moved to client-server architecture

**For tests:** Isolation comes from separate databases, not locks.

### 6.3 Why Not In-Memory Mode?

User explicitly requested client-server architecture preserved:
> "Client-server architecture preserved (not in-memory mode)"

Benefits of keeping client-server:
- Realistic testing (same path as production)
- Can test client reconnection
- Can test concurrent client scenarios
- Database files can be inspected for debugging

### 6.4 Ephemeral vs Persistent Databases

For tests, we want ephemeral databases that:
- Are created quickly (in-memory delta, no disk I/O initially)
- Are destroyed on close (optional, via flag)
- Don't persist across server restarts

```rust
enum DatabaseMode {
    Persistent { path: PathBuf },
    Ephemeral,
}

struct CreateDatabaseRequest {
    name: String,
    ephemeral: bool,  // Default true for tests
}
```

Ephemeral databases:
- Live only in memory (delta log never flushed)
- Automatically dropped on `CloseDatabase` or disconnect
- No disk cleanup needed

### 6.5 Base Path Configuration

Server startup:
```bash
rfdb-server --data-dir /tmp/rfdb-test-data --socket /tmp/rfdb.sock
```

New flag `--data-dir` specifies where persistent databases live.
- Ephemeral databases don't use this path
- Each persistent database is a subdirectory: `/tmp/rfdb-test-data/mydb.rfdb/`

---

## 7. Risk Assessment

### 7.1 Low Risk

| Risk | Mitigation |
|------|------------|
| Breaking existing protocol | All new commands, existing unchanged |
| Memory pressure from many DBs | Ephemeral DBs are lightweight until populated |

### 7.2 Medium Risk

| Risk | Mitigation |
|------|------------|
| Session state complexity | Explicit state machine, cleanup on disconnect |
| Orphaned databases | TTL for ephemeral DBs, cleanup on server restart |
| Thread contention | Per-DB RwLock, not global |

### 7.3 High Risk (Needs Careful Design)

| Risk | Mitigation |
|------|------------|
| Memory leaks from unclosed DBs | Reference counting, periodic GC sweep |
| Port exhaustion from many connections | Connection pooling in client (future) |

---

## 8. Test Strategy

### 8.1 Unit Tests (Rust)

1. DatabaseManager create/open/close/drop
2. Session lifecycle
3. Concurrent access (multiple clients writing to same DB)
4. Ephemeral database cleanup

### 8.2 Integration Tests (Node.js)

1. Create database, add data, query, drop
2. Multiple clients accessing different databases
3. Multiple clients writing to same database (parallel analysis)
4. Disconnect cleanup
5. Parallel test execution

### 8.3 Performance Tests

1. Database creation overhead (target: <10ms)
2. 100 concurrent databases
3. Switch database latency (target: <1ms)
4. Memory usage per database

---

## 9. Alignment with Project Vision

### 9.1 AI-First Tool

Multi-database support enables:
- Faster test execution (AI agents can run tests quickly)
- Parallel analysis of multiple codebases
- Isolated experimentation without affecting main data

### 9.2 Massive Legacy Codebases

Each legacy system can have its own database:
- Development, staging, production graphs
- Per-branch analysis databases
- Historical snapshots for comparison

### 9.3 TDD Workflow

This is the primary driver:
- Tests must be fast (<30s for full suite goal)
- Each test isolated (no shared state)
- Parallel execution (8+ workers)

---

## 10. Open Questions for Joel

1. **Ephemeral database storage:** Should we use a temporary directory or purely in-memory HashMap for ephemeral databases?

2. **Database name validation:** What characters are allowed? Suggest: `[a-zA-Z0-9_-]`, max 128 chars.

3. **Connection pooling:** Should we design for future connection pooling in the client? This affects session ID assignment.

4. **Metrics:** Should we expose database-level metrics (node count, edge count, memory usage)?

5. **Hot reload:** If server restarts, should we auto-reopen databases that were open? Persistent only, or also track ephemeral?

---

## 11. Conclusion

The multi-database architecture is well-suited for RFDB:

1. **Named databases** are clearer than numbered slots
2. **RwLock on GraphEngine** already handles concurrent writes (no custom locking needed)
3. **Ephemeral mode** enables fast, zero-cleanup tests
4. **Test isolation** via separate databases, not session locks
5. **Minimal protocol changes** - all additions, no modifications

The implementation is estimated at **9-13 days** (reduced from original estimate since no custom write locking needed) and should reduce full test suite time from 30+ minutes to under 1 minute (assuming 8 parallel workers, ~5s per test with database operations).

---

## References

- [Redis SELECT Command](https://redis.io/docs/latest/commands/select/)
- [SQLite ATTACH DATABASE](https://sqlite.org/lang_attach.html)
- [SQLite Isolation](https://sqlite.org/isolation.html)
- [SQLite Locking](https://sqlite.org/lockingv3.html)
- [Redis Multiple Databases Defense](https://medium.com/@stockholmux/in-defense-of-select-dbs-in-redis-947e1a2d86e)
