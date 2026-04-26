# REG-523: WebSocket Transport - Detailed Technical Specification

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2026-02-20
**Status:** Ready for Implementation
**Based on:** Don's Plan (`002-don-plan.md`)

## Executive Summary

This document expands Don's WebSocket transport plan into a detailed implementation specification with precise technical decisions, Big-O complexity analysis, edge case handling, and a comprehensive test matrix. The goal is to make this **immediately implementable** by Kent (tests) and Rob (code) without additional research.

## 1. Resolved Technical Decisions

### 1.1 Streaming Support: SKIP FOR MVP

**Decision:** Do NOT implement streaming (`QueryNodes` with chunked responses) for WebSocket in REG-523.

**Rationale:**
- **Complexity:** Current `handle_query_nodes_streaming` writes directly to `&mut UnixStream` (blocking I/O). Making this async requires refactoring the entire streaming pipeline.
- **Code churn:** High risk of bugs for low immediate value.
- **User impact:** Minimal. Streaming only activates for queries returning >100 nodes. Most VS Code extension queries are small (single node lookups, edge queries).
- **Fallback:** WebSocket clients will receive single `Response::Nodes` for all queries, regardless of size.

**Implementation:**
- In `handle_client_websocket`, do NOT check `session.protocol_version >= 3` for streaming.
- Always call `handle_request()` instead of `handle_query_nodes_streaming()`.
- Client-side: `RFDBWebSocketClient.hello()` should NOT negotiate protocol v3 (keep v2).

**Follow-up task:** File REG-524 (WebSocket Streaming Support) for future iteration.

---

### 1.2 WebSocket Configuration

**Max Message Size:** 100 MB (match current Unix socket limit)
- Configure via `tokio_tungstenite::tungstenite::protocol::WebSocketConfig::max_message_size`
- Rust code: `WebSocketConfig { max_message_size: Some(100 * 1024 * 1024), ..Default::default() }`

**Max Connections:** No limit for MVP
- Future: Add `--ws-max-connections N` flag in REG-525
- For MVP, rely on OS ulimit and Tokio's default task limits

**Timeouts:**
- No explicit ping/pong timeout for MVP
- WebSocket protocol has built-in keepalive (ping/pong frames)
- TCP layer handles connection timeout
- Future: Add `--ws-idle-timeout N` in REG-525

**Bind Address:** `127.0.0.1:<port>` (localhost only)
- **Critical:** Do NOT bind to `0.0.0.0` for MVP (security risk)
- Future: Add `--ws-bind-addr` flag for production deployments

---

### 1.3 Error Protocol

**Question:** Are errors reported the same way as Unix socket?

**Answer:** YES, identical.

**WebSocket Error Response:**
```rust
ResponseEnvelope {
    request_id: Some("r123".to_string()),
    response: Response::Error { error: "message".to_string() }
}
```
OR
```rust
ResponseEnvelope {
    request_id: Some("r123".to_string()),
    response: Response::ErrorWithCode { error: "message".to_string(), code: "NO_DATABASE_SELECTED" }
}
```

**Serialization errors:** Send `Error` response with `request_id: None`.

**Connection-level errors:** Close WebSocket with error code.
- Invalid MessagePack → Send Error response, continue loop
- Protocol violation (text frame when binary expected) → Log, ignore frame, continue
- Deserialization failure on Close frame → Break loop, close connection

---

### 1.4 Session Management

**Question:** Does WebSocket use the same `ClientSession`? Same Hello protocol?

**Answer:** YES.

**Session lifecycle (WebSocket):**
1. Client connects → Server accepts TCP → WebSocket upgrade handshake
2. Server creates `ClientSession::new(client_id)` (default protocol v1, no database)
3. Client sends `{ requestId: "r1", cmd: "hello", protocolVersion: 2 }`
4. Server updates `session.protocol_version = 2` (negotiated version = min(client, server))
5. Client sends `{ cmd: "openDatabase", name: "default", mode: "readwrite" }`
6. Server sets `session.current_db = Some(db)`, `session.access_mode = ReadWrite`

**Key difference from Unix socket:**
- **NO legacy mode** for WebSocket. Unix socket has `legacy_mode: true` (auto-opens "default" db).
- WebSocket always requires explicit Hello + OpenDatabase handshake.

**Rationale:** WebSocket is a new transport, no backwards compat needed. Clean protocol enforcement.

---

### 1.5 Signal Handling

**Question:** How does SIGINT/SIGTERM affect WebSocket connections?

**Current behavior (Unix socket):**
- Signal handler thread catches SIGINT/SIGTERM
- Flushes all databases via `manager.list_databases()` → `engine.flush()`
- Calls `std::process::exit(0)` (abrupt shutdown)
- Connections are NOT gracefully closed (kernel closes sockets)

**WebSocket behavior (MVP):**
- **SAME** as Unix socket. No graceful shutdown.
- Tokio runtime is dropped → All tasks are aborted → WebSocket connections closed
- Kernel sends TCP RST to clients

**Future improvement (REG-526):**
- Graceful shutdown: Broadcast Close frame to all WebSocket clients
- Wait up to 5s for clients to close, then force exit

---

### 1.6 Port Configuration

**Question:** Default port or require explicit `--ws-port`?

**Decision:** REQUIRE explicit `--ws-port` (no default).

**Rationale:**
- Avoids port conflicts (no magic port number)
- Makes WebSocket opt-in (backwards compatible)
- Clear user intent

**Validation:**
- If `--ws-port` not provided → Skip WebSocket setup (Unix socket only)
- If `--ws-port <invalid>` → Print error, exit 1
- If port already in use → Print error, exit 1

**Help text:**
```
--ws-port <port>   Enable WebSocket transport on 127.0.0.1:<port> (e.g., 7474)
                   Note: WebSocket is localhost-only for security
```

---

## 2. Precise Code Changes (Per-Phase)

### Phase 1: Add Dependencies & CLI Flag (1 hour)

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/Cargo.toml`

**Add dependencies after line 35 (after existing `tokio = ...`):**
```toml
# WebSocket support (REG-523)
tokio-tungstenite = "0.24"
futures-util = "0.3"
```

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`

**Add CLI parsing after line 2259 (after existing `--socket` parsing):**
```rust
let ws_port = args.iter()
    .position(|a| a == "--ws-port")
    .and_then(|i| args.get(i + 1))
    .and_then(|s| s.parse::<u16>().ok());
```

**Update help text at line 2215 (insert after `--socket` line):**
```rust
println!("  --ws-port      WebSocket port on 127.0.0.1 (e.g., 7474, localhost-only)");
```

**Update help text at line 2235 (insert after `--socket` line):**
```rust
eprintln!("  --ws-port      WebSocket port on 127.0.0.1 (e.g., 7474, localhost-only)");
```

**Test:**
```bash
cargo build --bin rfdb-server
./target/debug/rfdb-server --help | grep ws-port
# Should show: --ws-port      WebSocket port on 127.0.0.1 (e.g., 7474, localhost-only)
```

---

### Phase 2: Make main() async & Add WebSocket Accept Loop (2 hours)

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`

**Step 2.1:** Change `fn main()` to `async fn main()` at line 2200:

**BEFORE:**
```rust
fn main() {
```

**AFTER:**
```rust
#[tokio::main]
async fn main() {
```

**Step 2.2:** Add imports at top of file (after line 34, before `use rfdb::session::ClientSession;`):
```rust
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use futures_util::{StreamExt, SinkExt};
```

**Step 2.3:** Add WebSocket listener binding after line 2298 (after Unix socket bind):

**Insert at line 2299 (new section):**
```rust
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
```

**Step 2.4:** Wrap Unix socket accept loop in `tokio::task::spawn_blocking` (replace lines 2330-2346):

**BEFORE:**
```rust
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
```

**AFTER:**
```rust
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
                    handle_client(stream, manager_clone, client_id, true, metrics_clone);
                });
            }
            Err(e) => {
                eprintln!("[rfdb-server] Unix socket accept error: {}", e);
            }
        }
    }
});
```

**Step 2.5:** Add WebSocket accept loop (after previous block):

**Insert immediately after `unix_handle` declaration:**
```rust
// Spawn WebSocket accept loop (if enabled)
let ws_handle = if let Some(listener) = ws_listener {
    let manager_ws = Arc::clone(&manager);
    let metrics_ws = metrics.clone();
    Some(tokio::spawn(async move {
        loop {
            match listener.accept().await {
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
```

**Dependency order:**
1. CLI parsing (ws_port extraction) - MUST come first
2. Unix socket binding - can stay synchronous
3. WebSocket binding - MUST be async (`.await`)
4. Signal handler spawn - stays synchronous (thread::spawn)
5. Accept loops - both run concurrently (tokio::spawn)

**Test:**
```bash
cargo build --bin rfdb-server
./target/debug/rfdb-server ./test.rfdb --socket /tmp/test.sock --ws-port 7474

# In another terminal:
lsof -i :7474  # Should show rfdb-server
ls -la /tmp/test.sock  # Should exist
```

---

### Phase 3: Implement WebSocket Message Handler (3 hours)

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`

**Rename existing `handle_client` to `handle_client_unix` (line 2088):**

**BEFORE:**
```rust
fn handle_client(
```

**AFTER:**
```rust
fn handle_client_unix(
```

**Update call site in Phase 2 code (Unix accept loop):**
```rust
handle_client_unix(stream, manager_clone, client_id, true, metrics_clone);
```

**Add new `handle_client_websocket` function after `handle_client_unix` (insert at ~line 2195):**

```rust
async fn handle_client_websocket(
    tcp_stream: tokio::net::TcpStream,
    manager: Arc<DatabaseManager>,
    client_id: usize,
    metrics: Option<Arc<Metrics>>,
) {
    eprintln!("[rfdb-server] WebSocket client {} connected", client_id);

    // Upgrade TCP connection to WebSocket
    let ws_stream = match accept_async(tcp_stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[rfdb-server] WebSocket upgrade failed for client {}: {}", client_id, e);
            return;
        }
    };

    let (mut ws_write, mut ws_read) = ws_stream.split();
    let mut session = ClientSession::new(client_id);

    // WebSocket clients MUST send Hello first (no legacy mode)
    // Protocol v2: client must explicitly open database

    loop {
        // Read next WebSocket message
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
                // Tokio-tungstenite handles ping/pong automatically
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

        // Deserialize MessagePack request (same as Unix socket)
        let (request_id, request) = match rmp_serde::from_slice::<RequestEnvelope>(&msg) {
            Ok(env) => (env.request_id, env.request),
            Err(e) => {
                eprintln!("[rfdb-server] WebSocket client {} invalid MessagePack: {}", client_id, e);
                let envelope = ResponseEnvelope {
                    request_id: None,
                    response: Response::Error { error: format!("Invalid request: {}", e) },
                };
                if let Ok(resp_bytes) = rmp_serde::to_vec_named(&envelope) {
                    let _ = ws_write.send(Message::Binary(resp_bytes)).await;
                }
                continue;
            }
        };

        let is_shutdown = matches!(request, Request::Shutdown);
        let start = Instant::now();
        let op_name = get_operation_name(&request);

        // Handle request (NO streaming for MVP - always single response)
        let response = handle_request(&manager, &mut session, request, &metrics);

        // Record metrics
        if let Some(ref m) = metrics {
            let duration_ms = start.elapsed().as_millis() as u64;
            m.record_query(&op_name, duration_ms);
            if duration_ms >= SLOW_QUERY_THRESHOLD_MS {
                eprintln!("[RUST SLOW] {}: {}ms (ws client {})", op_name, duration_ms, client_id);
            }
        }

        // Serialize and send response
        let envelope = ResponseEnvelope { request_id, response };
        let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("[rfdb-server] WebSocket client {} serialize error: {}", client_id, e);
                continue;
            }
        };

        if let Err(e) = ws_write.send(Message::Binary(resp_bytes)).await {
            eprintln!("[rfdb-server] WebSocket client {} write error: {}", client_id, e);
            break;
        }

        if is_shutdown {
            eprintln!("[rfdb-server] Shutdown requested by WebSocket client {}", client_id);
            std::process::exit(0);
        }
    }

    // Cleanup: close database and release connections
    handle_close_database(&manager, &mut session);
    eprintln!("[rfdb-server] WebSocket client {} cleaned up", client_id);
}
```

**Edge cases handled:**
- Text frame instead of binary → Log, ignore, continue
- MessagePack deserialization failure → Send Error response, continue
- Close frame → Break loop, cleanup
- Ping/Pong frames → Ignore (auto-handled by library)
- Network write error → Break loop, cleanup
- Shutdown request → Flush databases, exit process

**Test:**
```bash
# Install websocat for testing
cargo install websocat

# Start server
./target/debug/rfdb-server ./test.rfdb --ws-port 7474

# In another terminal, send MessagePack ping
# (Need to encode manually - see Phase 5 for proper client test)
```

---

### Phase 4: TypeScript WebSocket Client (4 hours)

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/websocket-client.ts` (NEW)

**Create new file with full implementation:**

```typescript
/**
 * RFDBWebSocketClient - WebSocket client for RFDB server
 *
 * Provides same API as RFDBClient but uses WebSocket transport instead of Unix socket.
 * Designed for browser environments (VS Code web extension, vscode.dev).
 */

import { encode, decode } from '@msgpack/msgpack';
import { EventEmitter } from 'events';
import type {
  RFDBCommand,
  WireNode,
  WireEdge,
  RFDBResponse,
  IRFDBClient,
  AttrQuery,
  FieldDeclaration,
  DatalogResult,
  DatalogExplainResult,
  NodeType,
  EdgeType,
  HelloResponse,
  CreateDatabaseResponse,
  OpenDatabaseResponse,
  ListDatabasesResponse,
  CurrentDatabaseResponse,
  SnapshotRef,
  SnapshotDiff,
  SnapshotInfo,
  DiffSnapshotsResponse,
  FindSnapshotResponse,
  ListSnapshotsResponse,
  CommitDelta,
  CommitBatchResponse,
} from '@grafema/types';

interface PendingRequest {
  resolve: (value: RFDBResponse) => void;
  reject: (error: Error) => void;
}

export class RFDBWebSocketClient extends EventEmitter implements IRFDBClient {
  readonly url: string;
  private ws: WebSocket | null = null;
  connected: boolean = false;
  private pending: Map<number, PendingRequest> = new Map();
  private reqId: number = 0;

  // Batch state (same as RFDBClient)
  private _batching: boolean = false;
  private _batchNodes: WireNode[] = [];
  private _batchEdges: WireEdge[] = [];
  private _batchFiles: Set<string> = new Set();

  constructor(url: string) {
    super();
    this.url = url; // e.g., "ws://localhost:7474"
  }

  /**
   * Connect to RFDB server via WebSocket
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer'; // CRITICAL: receive as ArrayBuffer for MessagePack

      this.ws.onopen = () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      };

      this.ws.onerror = (event) => {
        const error = new Error(`WebSocket connection error: ${this.url}`);
        if (!this.connected) {
          reject(error);
        } else {
          this.emit('error', error);
        }
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this.emit('disconnected');

        // Reject all pending requests
        for (const [id, { reject }] of this.pending) {
          reject(new Error(`Connection closed (code: ${event.code}, reason: ${event.reason})`));
        }
        this.pending.clear();
      };

      this.ws.onmessage = (event) => {
        this._handleMessage(event.data);
      };
    });
  }

  private _handleMessage(data: ArrayBuffer): void {
    try {
      const response = decode(new Uint8Array(data)) as RFDBResponse;
      const id = this._parseRequestId(response.requestId);
      if (id === null) {
        console.warn('[RFDBWebSocketClient] Response missing requestId:', response);
        return;
      }

      const pending = this.pending.get(id);
      if (!pending) {
        console.warn('[RFDBWebSocketClient] No pending request for id:', id);
        return;
      }

      this.pending.delete(id);

      // Check for error response
      if ('error' in response && response.error) {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve(response);
      }
    } catch (err) {
      console.error('[RFDBWebSocketClient] Failed to decode message:', err);
      this.emit('error', err);
    }
  }

  private _parseRequestId(requestId: unknown): number | null {
    if (typeof requestId === 'string' && requestId.startsWith('r')) {
      const num = parseInt(requestId.slice(1), 10);
      return isNaN(num) ? null : num;
    }
    return null;
  }

  private async _send(
    cmd: RFDBCommand,
    payload: Record<string, unknown> = {},
    timeoutMs: number = 60_000
  ): Promise<RFDBResponse> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to RFDB server');
    }

    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const request = { requestId: `r${id}`, cmd, ...payload };
      const msgBytes = encode(request);

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${cmd} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      // Send as binary frame
      this.ws!.send(msgBytes);
    });
  }

  // ============================================================================
  // IRFDBClient API Implementation
  // ============================================================================

  async ping(): Promise<string | false> {
    const response = (await this._send('ping')) as { pong?: boolean; version?: string };
    return response.pong && response.version ? response.version : false;
  }

  async hello(protocolVersion: number = 2): Promise<HelloResponse> {
    // NOTE: WebSocket client uses protocol v2 ONLY (no streaming support in MVP)
    const response = (await this._send('hello', {
      protocolVersion: 2,  // Force v2 (no streaming)
      clientId: 'websocket-client'
    })) as HelloResponse;
    return response;
  }

  async createDatabase(name: string, ephemeral: boolean = false): Promise<CreateDatabaseResponse> {
    return (await this._send('createDatabase', { name, ephemeral })) as CreateDatabaseResponse;
  }

  async openDatabase(name: string, mode: 'readonly' | 'readwrite' = 'readwrite'): Promise<OpenDatabaseResponse> {
    return (await this._send('openDatabase', { name, mode })) as OpenDatabaseResponse;
  }

  async closeDatabase(): Promise<{ ok: boolean }> {
    return (await this._send('closeDatabase')) as { ok: boolean };
  }

  async listDatabases(): Promise<ListDatabasesResponse> {
    return (await this._send('listDatabases')) as ListDatabasesResponse;
  }

  async currentDatabase(): Promise<CurrentDatabaseResponse> {
    return (await this._send('currentDatabase')) as CurrentDatabaseResponse;
  }

  async nodeCount(): Promise<number> {
    const response = (await this._send('nodeCount')) as { count: number };
    return response.count;
  }

  async edgeCount(): Promise<number> {
    const response = (await this._send('edgeCount')) as { count: number };
    return response.count;
  }

  async addNodes(nodes: WireNode[]): Promise<number> {
    const response = (await this._send('addNodes', { nodes })) as { nodesAdded: number };
    return response.nodesAdded;
  }

  async addEdges(edges: WireEdge[]): Promise<number> {
    const response = (await this._send('addEdges', { edges })) as { edgesAdded: number };
    return response.edgesAdded;
  }

  async getNode(id: string): Promise<WireNode | null> {
    const response = (await this._send('getNode', { id })) as { node: WireNode | null };
    return response.node;
  }

  async queryNodes(query: AttrQuery): Promise<WireNode[]> {
    // NOTE: No streaming support - always returns full array
    const response = (await this._send('queryNodes', { query })) as { nodes: WireNode[] };
    return response.nodes;
  }

  async neighbors(nodeId: string, edgeType?: string | null, direction?: 'outgoing' | 'incoming'): Promise<string[]> {
    const response = (await this._send('neighbors', { nodeId, edgeType, direction })) as { neighbors: string[] };
    return response.neighbors;
  }

  async getOutgoingEdges(nodeId: string): Promise<WireEdge[]> {
    const response = (await this._send('getOutgoingEdges', { nodeId })) as { edges: WireEdge[] };
    return response.edges;
  }

  async getIncomingEdges(nodeId: string): Promise<WireEdge[]> {
    const response = (await this._send('getIncomingEdges', { nodeId })) as { edges: WireEdge[] };
    return response.edges;
  }

  async getAllEdges(): Promise<WireEdge[]> {
    const response = (await this._send('getAllEdges')) as { edges: WireEdge[] };
    return response.edges;
  }

  async countEdgesByType(): Promise<Record<string, number>> {
    const response = (await this._send('countEdgesByType')) as { edgeTypeCounts: Record<string, number> };
    return response.edgeTypeCounts;
  }

  async listNodeTypes(): Promise<NodeType[]> {
    const response = (await this._send('listNodeTypes')) as { types: NodeType[] };
    return response.types;
  }

  async listEdgeTypes(): Promise<EdgeType[]> {
    const response = (await this._send('listEdgeTypes')) as { types: EdgeType[] };
    return response.types;
  }

  async registerFields(fields: FieldDeclaration[]): Promise<number> {
    const response = (await this._send('registerFields', { fields })) as { fieldsRegistered: number };
    return response.fieldsRegistered;
  }

  async queryDatalog(program: string): Promise<DatalogResult> {
    return (await this._send('queryDatalog', { program })) as DatalogResult;
  }

  async explainDatalog(program: string): Promise<DatalogExplainResult> {
    return (await this._send('explainDatalog', { program })) as DatalogExplainResult;
  }

  // Snapshot API
  async createSnapshot(name?: string): Promise<{ id: string; name: string }> {
    return (await this._send('createSnapshot', { name })) as { id: string; name: string };
  }

  async listSnapshots(): Promise<ListSnapshotsResponse> {
    return (await this._send('listSnapshots')) as ListSnapshotsResponse;
  }

  async findSnapshot(query: string | number | SnapshotRef): Promise<FindSnapshotResponse> {
    return (await this._send('findSnapshot', { query })) as FindSnapshotResponse;
  }

  async diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<DiffSnapshotsResponse> {
    return (await this._send('diffSnapshots', { from, to })) as DiffSnapshotsResponse;
  }

  async restoreSnapshot(ref: SnapshotRef): Promise<{ ok: boolean; snapshot: SnapshotInfo }> {
    return (await this._send('restoreSnapshot', { ref })) as { ok: boolean; snapshot: SnapshotInfo };
  }

  async deleteSnapshot(ref: SnapshotRef): Promise<{ ok: boolean }> {
    return (await this._send('deleteSnapshot', { ref })) as { ok: boolean };
  }

  // Batch API
  async beginBatch(): Promise<string> {
    if (this._batching) {
      throw new Error('Batch already in progress');
    }
    this._batching = true;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();
    const response = (await this._send('beginBatch')) as { batchId: string };
    return response.batchId;
  }

  async commitBatch(delta?: CommitDelta): Promise<CommitBatchResponse> {
    if (!this._batching) {
      throw new Error('No batch in progress');
    }
    const response = (await this._send('commitBatch', { delta })) as CommitBatchResponse;
    this._batching = false;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();
    return response;
  }

  async abortBatch(): Promise<{ ok: boolean }> {
    if (!this._batching) {
      throw new Error('No batch in progress');
    }
    const response = (await this._send('abortBatch')) as { ok: boolean };
    this._batching = false;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();
    return response;
  }

  async flush(): Promise<{ ok: boolean }> {
    return (await this._send('flush')) as { ok: boolean };
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close(1000, 'Client closed');
      this.ws = null;
    }
    this.connected = false;
    this.pending.clear();
  }
}
```

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/index.ts`

**Add export after line 12:**
```typescript
export { RFDBWebSocketClient } from './websocket-client.js';
```

**Test:**
Create `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/websocket-client.test.ts` (see Test Matrix section).

---

### Phase 5: VS Code Extension Configuration (2 hours)

**File:** `/Users/vadimr/grafema-worker-2/packages/vscode/package.json`

**Add configuration properties after line 41 (inside `contributes` object):**

**Find the `"contributes"` section and add:**
```json
"configuration": {
  "title": "Grafema",
  "properties": {
    "grafema.rfdbTransport": {
      "type": "string",
      "enum": ["unix", "websocket"],
      "default": "unix",
      "description": "RFDB transport protocol (unix socket or WebSocket)",
      "enumDescriptions": [
        "Unix socket (default, local filesystem)",
        "WebSocket (for browser-based VS Code)"
      ]
    },
    "grafema.rfdbWebSocketUrl": {
      "type": "string",
      "default": "ws://localhost:7474",
      "description": "RFDB WebSocket URL (when transport is 'websocket')",
      "pattern": "^wss?://[^\\s]+$"
    },
    "grafema.rfdbBinaryPath": {
      "type": "string",
      "default": "",
      "description": "Path to rfdb-server binary (override auto-detection)"
    },
    "grafema.rfdbSocketPath": {
      "type": "string",
      "default": "",
      "description": "Custom Unix socket path (override default .grafema/rfdb.sock)"
    }
  }
}
```

**File:** `/Users/vadimr/grafema-worker-2/packages/vscode/src/grafemaClient.ts`

**Modify imports (add after line 13):**
```typescript
import { RFDBWebSocketClient } from '@grafema/rfdb-client';
import * as vscode from 'vscode';
```

**Modify class property (line 40):**

**BEFORE:**
```typescript
private client: RFDBClient | null = null;
```

**AFTER:**
```typescript
private client: RFDBClient | RFDBWebSocketClient | null = null;
```

**Modify `connect()` method (replace lines 90-119):**

**BEFORE (existing connect logic):**
```typescript
async connect(): Promise<void> {
    // Check if database exists
    if (!existsSync(this.dbPath)) {
        this.setState({
            status: 'no-database',
            message: 'No graph database. Run `grafema analyze` first.',
        });
        return;
    }

    // Try to connect first (server may already be running)
    this.setState({ status: 'connecting' });

    try {
        await this.tryConnect();
        return;
    } catch {
        // Connection failed, try to start server
    }

    // Start server
    this.setState({ status: 'starting-server' });
    try {
        await this.startServer();
        await this.tryConnect();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setState({ status: 'error', message });
    }
}
```

**AFTER:**
```typescript
async connect(): Promise<void> {
    const config = vscode.workspace.getConfiguration('grafema');
    const transport = config.get<string>('rfdbTransport') || 'unix';

    if (transport === 'websocket') {
        // WebSocket mode: connect directly, no auto-start
        const wsUrl = config.get<string>('rfdbWebSocketUrl') || 'ws://localhost:7474';
        this.setState({ status: 'connecting' });

        try {
            const client = new RFDBWebSocketClient(wsUrl);
            await client.connect();

            // Verify connection with ping
            const pong = await client.ping();
            if (!pong) {
                throw new Error('Server did not respond to ping');
            }

            this.client = client;
            this.setState({ status: 'connected' });
            this.startWatching();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.setState({
                status: 'error',
                message: `WebSocket connection failed: ${message}\n\nMake sure rfdb-server is running with --ws-port flag.`
            });
        }
    } else {
        // Unix socket mode: existing logic with auto-start
        if (!existsSync(this.dbPath)) {
            this.setState({
                status: 'no-database',
                message: 'No graph database. Run `grafema analyze` first.',
            });
            return;
        }

        this.setState({ status: 'connecting' });

        try {
            await this.tryConnect();
            return;
        } catch {
            // Connection failed, try to start server
        }

        this.setState({ status: 'starting-server' });
        try {
            await this.startServer();
            await this.tryConnect();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.setState({ status: 'error', message });
        }
    }
}
```

**Add README section:**

Create `/Users/vadimr/grafema-worker-2/packages/vscode/WEBSOCKET.md`:

```markdown
# WebSocket Transport for VS Code Web Extension

Grafema VS Code extension supports WebSocket transport for browser-based environments (vscode.dev, github.dev, Codespaces).

## Setup

### 1. Start RFDB server with WebSocket

```bash
# In your workspace root
rfdb-server .grafema/graph.rfdb --ws-port 7474
```

### 2. Configure VS Code Extension

Open Settings (Cmd+, or Ctrl+,) and search for "Grafema":

- **RFDB Transport**: `websocket`
- **RFDB WebSocket URL**: `ws://localhost:7474`

### 3. Reload VS Code Window

Command Palette → "Reload Window"

## Limitations

- **No auto-start**: Server must be started manually (extension cannot spawn processes in browser)
- **Localhost only**: Server binds to 127.0.0.1 for security (no external access)
- **No streaming**: Large queries (>100 nodes) return full array instead of chunks (slight performance impact)

## Security Note

WebSocket transport is **localhost-only** in this version. The server binds to `127.0.0.1:<port>`, which is not accessible from external networks.

For remote access, use SSH tunnel:

```bash
# On remote machine
rfdb-server .grafema/graph.rfdb --ws-port 7474

# On local machine (forward port)
ssh -L 7474:localhost:7474 user@remote-host
```

Then configure extension to use `ws://localhost:7474`.
```

---

## 3. Big-O Complexity Analysis

### 3.1 WebSocket Accept Loop

**Complexity:** O(1) per connection (amortized)

**Analysis:**
- `TcpListener::accept().await` → O(1) kernel syscall
- `tokio::spawn(handle_client_websocket(...))` → O(1) task creation
- Tokio runtime schedules tasks on thread pool → O(1) amortized (work-stealing scheduler)

**Memory footprint per connection:**
- Tokio task: ~2 KB overhead
- WebSocket state: ~4 KB (buffers, parser state)
- ClientSession: ~512 bytes
- **Total: ~7 KB per connection** (vs ~8 MB per thread for Unix socket)

**Scalability:**
- Unix socket: ~1000 connections (limited by threads)
- WebSocket: ~10,000 connections (limited by file descriptors, not memory)

---

### 3.2 Message Processing Cost

**Complexity:** O(message_size) for serialization + O(N) for graph operation

**Analysis (same as Unix socket):**
- `accept_async(tcp_stream)` → O(1) (WebSocket upgrade handshake)
- `ws_read.next().await` → O(message_size) (read + deserialize)
- `handle_request()` → O(N) where N = nodes/edges affected
- `rmp_serde::to_vec_named()` → O(response_size) (serialize)
- `ws_write.send()` → O(response_size) (write)

**Example: AddNodes with 1000 nodes**
- Deserialize: O(1000 * avg_node_size) ≈ O(100 KB)
- Insert: O(1000 * log(total_nodes)) ≈ O(1000 * 20) = O(20k operations)
- Serialize: O(response_size) ≈ O(100 bytes)
- **Total: O(N log M)** where N = new nodes, M = existing nodes

**No difference between Unix socket and WebSocket** for message processing.

---

### 3.3 Impact on Unix Socket Performance

**Expected impact:** ZERO

**Reasoning:**
- Unix socket loop runs in `tokio::task::spawn_blocking` (separate thread pool)
- WebSocket loop runs in Tokio async runtime (separate thread pool)
- No shared locks between the two (DatabaseManager uses Arc, which is lock-free for reads)
- DatabaseManager internals use RwLock → readers don't block each other

**Potential contention points:**
- `NEXT_CLIENT_ID.fetch_add()` → O(1) atomic operation, negligible
- `manager.get_database()` → O(1) HashMap lookup with RwLock read guard
- Engine RwLock (write operations) → Same contention as before (multiple Unix socket clients)

**Benchmark target:** Unix socket throughput should NOT decrease by >5% when WebSocket is enabled.

---

### 3.4 Async vs Sync Overhead

**Question:** Is async slower than sync for this workload?

**Answer:** NO, for high-concurrency scenarios.

**Benchmark (theoretical):**
- Sync (Unix socket): 1 thread per connection × 8 MB stack = 8 GB for 1000 clients
- Async (WebSocket): 1 task per connection × 7 KB = 7 MB for 1000 clients
- **Memory win: ~1000x reduction**

**Latency:**
- Sync: ~50 µs per request (no context switch if thread is running)
- Async: ~100 µs per request (includes task scheduling overhead)
- **Latency cost: 2x** (acceptable for I/O-bound workload)

**For RFDB's use case:** Most time is spent in graph operations (O(log N) lookups, O(N) serialization), not I/O. Async overhead is negligible.

---

## 4. Edge Cases

### 4.1 `--ws-port` without `--socket`

**Scenario:** `rfdb-server ./test.rfdb --ws-port 7474` (no `--socket` flag)

**Behavior:**
- `--socket` defaults to `/tmp/rfdb.sock` (line 2259 in current code)
- Both Unix socket AND WebSocket listeners start
- This is **correct behavior** (both transports active)

**No special handling needed.**

---

### 4.2 Port Already in Use

**Scenario:** Another process is using port 7474

**Current behavior (after Phase 2 changes):**
```rust
Err(e) => {
    eprintln!("[rfdb-server] ERROR: Failed to bind WebSocket port {}: {}", port, e);
    eprintln!("[rfdb-server] Hint: Port may be in use. Try a different port.");
    std::process::exit(1);
}
```

**Error message:** Clear, actionable.

**Test:**
```bash
# Terminal 1
nc -l 7474

# Terminal 2
./target/debug/rfdb-server ./test.rfdb --ws-port 7474
# Should print: ERROR: Failed to bind WebSocket port 7474: Address already in use
# Should exit with code 1
```

---

### 4.3 Client Sends Text Frame Instead of Binary

**Scenario:** Client sends `ws.send("hello")`

**Behavior (from Phase 3 code):**
```rust
Some(Ok(Message::Text(_))) => {
    eprintln!("[rfdb-server] WebSocket client {} sent text frame (expected binary), ignoring", client_id);
    continue;
}
```

**Outcome:** Frame is ignored, connection stays open, client can retry.

**Rationale:** Defensive programming. Client might have a bug or be testing connectivity.

---

### 4.4 MessagePack Deserialization Fails

**Scenario:** Client sends binary frame with invalid MessagePack data

**Behavior (from Phase 3 code):**
```rust
Err(e) => {
    eprintln!("[rfdb-server] WebSocket client {} invalid MessagePack: {}", client_id, e);
    let envelope = ResponseEnvelope {
        request_id: None,
        response: Response::Error { error: format!("Invalid request: {}", e) },
    };
    if let Ok(resp_bytes) = rmp_serde::to_vec_named(&envelope) {
        let _ = ws_write.send(Message::Binary(resp_bytes)).await;
    }
    continue;
}
```

**Outcome:** Error response sent, connection stays open.

**Key:** `request_id: None` because we couldn't parse the request.

---

### 4.5 Partial Writes / Backpressure

**Question:** What if client is slow to read and server buffer fills up?

**Answer:** Tokio WebSocket handles this automatically.

**Mechanism:**
- `ws_write.send()` is async and awaits until the write completes
- If TCP send buffer is full, `send().await` blocks (yields to Tokio scheduler)
- Server doesn't send next response until previous write completes
- **No data loss, no panic**

**Downside:** Slow client can block its own task (other clients unaffected).

**Future improvement (REG-526):** Add send timeout, drop slow clients.

---

### 4.6 `handle_client_websocket` Lifetime vs DatabaseManager

**Question:** What if DatabaseManager is dropped while WebSocket connection is active?

**Answer:** Impossible by design.

**Reasoning:**
- `manager` is `Arc<DatabaseManager>` (line 2280 in main)
- Each connection gets `Arc::clone(&manager)` (line 2337 for Unix, Phase 2 for WebSocket)
- `Arc` is reference-counted → DatabaseManager lives as long as ANY connection holds a reference
- When `main()` exits (SIGTERM), all tasks are aborted → connections drop their Arc clones → DatabaseManager drops

**Edge case:** What if `handle_client_websocket` is still running after `main()` exits?

**Answer:** Tokio runtime is dropped when `main()` returns → All tasks are aborted → Drop runs for all local variables → Arc refcount drops.

**No special cleanup needed.**

---

### 4.7 Client Disconnects Mid-Request

**Scenario:** Client sends `AddNodes` request, then immediately closes connection

**Behavior:**
1. Server receives message, deserializes successfully
2. Server calls `handle_request()` → Adds nodes to graph
3. Server serializes response
4. Server calls `ws_write.send().await` → **Error: connection closed**
5. Server breaks loop, calls `handle_close_database()`, cleans up

**Outcome:** Nodes ARE added (write was not transactional). Response is lost.

**Consistency:** Same as Unix socket (RFDB does not have rollback for individual commands).

**Future improvement:** Add request-level transactions (separate Epic).

---

## 5. Test Matrix

| Scenario | Transport | Test Type | Priority | File |
|----------|-----------|-----------|----------|------|
| **Server Startup** | | | | |
| Start with `--ws-port` only | WebSocket | Manual | P0 | N/A |
| Start with both `--socket` and `--ws-port` | Both | Manual | P0 | N/A |
| Start with `--ws-port` on used port | WebSocket | Manual | P1 | N/A |
| `--help` shows `--ws-port` flag | N/A | Unit | P0 | `rfdb_server.rs` (add test) |
| **Connection Lifecycle** | | | | |
| Connect via WebSocket | WebSocket | Integration | P0 | `websocket-client.test.ts` |
| Connect via Unix socket (regression) | Unix | Integration | P0 | Existing tests |
| Multiple simultaneous WebSocket clients | WebSocket | Integration | P1 | `websocket-client.test.ts` |
| WebSocket + Unix socket concurrently | Both | Integration | P1 | New test file |
| **Protocol Compliance** | | | | |
| Ping/Pong | WebSocket | Integration | P0 | `websocket-client.test.ts` |
| Hello handshake (protocol v2) | WebSocket | Integration | P0 | `websocket-client.test.ts` |
| Open database | WebSocket | Integration | P0 | `websocket-client.test.ts` |
| Add/query nodes | WebSocket | Integration | P0 | `websocket-client.test.ts` |
| Datalog query | WebSocket | Integration | P1 | `websocket-client.test.ts` |
| **Error Handling** | | | | |
| Send text frame (should ignore) | WebSocket | Unit | P1 | Rust unit test |
| Send invalid MessagePack | WebSocket | Unit | P1 | Rust unit test |
| Query without opening database | WebSocket | Integration | P1 | `websocket-client.test.ts` |
| Client disconnect mid-request | WebSocket | Manual | P2 | N/A |
| **Edge Cases** | | | | |
| Large message (>1 MB) | WebSocket | Integration | P1 | `websocket-client.test.ts` |
| Query returning 1000+ nodes (no streaming) | WebSocket | Integration | P2 | `websocket-client.test.ts` |
| Shutdown via WebSocket client | WebSocket | Manual | P2 | N/A |
| SIGTERM with active WebSocket clients | Both | Manual | P2 | N/A |
| **VS Code Extension** | | | | |
| Connect via WebSocket config | WebSocket | E2E | P0 | Manual (local) |
| Fallback to Unix socket (default) | Unix | E2E | P0 | Existing behavior |
| Config validation (invalid URL) | N/A | Unit | P1 | Extension tests |
| **Performance** | | | | |
| Throughput: 1000 AddNodes requests | WebSocket | Benchmark | P2 | New benchmark |
| Latency: Single ping roundtrip | WebSocket | Benchmark | P2 | New benchmark |
| Unix socket perf (regression check) | Unix | Benchmark | P1 | Existing benchmarks |

**Priority Legend:**
- **P0:** MUST pass before merge
- **P1:** SHOULD pass before merge (can fix in follow-up if minor)
- **P2:** NICE to have (track as follow-up task)

---

## 6. Detailed Test Implementation

### 6.1 Rust Unit Tests

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`

**Add at end of existing `#[cfg(test)]` module (after line 4350):**

```rust
#[cfg(test)]
mod websocket_tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    use futures_util::{StreamExt, SinkExt};

    // Helper: Setup test DatabaseManager
    fn setup_test_manager() -> (tempfile::TempDir, Arc<DatabaseManager>) {
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(DatabaseManager::new(dir.path().to_path_buf()));
        let db_path = dir.path().join("default.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();
        manager.create_default_from_path(&db_path).unwrap();
        (dir, manager)
    }

    #[tokio::test]
    async fn test_websocket_ping_pong() {
        let (_dir, manager) = setup_test_manager();

        // Bind listener on random port
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // Spawn server handler
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_client_websocket(stream, manager, 999, None).await;
        });

        // Connect client
        let (mut ws_stream, _) = connect_async(format!("ws://{}", addr))
            .await
            .expect("Failed to connect");

        // Send ping request
        let request = RequestEnvelope {
            request_id: Some("r1".to_string()),
            request: Request::Ping,
        };
        let msg_bytes = rmp_serde::to_vec_named(&request).unwrap();
        ws_stream.send(Message::Binary(msg_bytes)).await.unwrap();

        // Read response
        let response_msg = ws_stream.next().await.unwrap().unwrap();
        let response_bytes = match response_msg {
            Message::Binary(data) => data,
            _ => panic!("Expected binary frame"),
        };

        let envelope: ResponseEnvelope = rmp_serde::from_slice(&response_bytes).unwrap();
        assert_eq!(envelope.request_id, Some("r1".to_string()));

        match envelope.response {
            Response::PingOk { pong, version } => {
                assert!(pong);
                assert!(!version.is_empty());
            }
            _ => panic!("Expected PingOk response"),
        }
    }

    #[tokio::test]
    async fn test_websocket_text_frame_ignored() {
        let (_dir, manager) = setup_test_manager();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_client_websocket(stream, manager, 999, None).await;
        });

        let (mut ws_stream, _) = connect_async(format!("ws://{}", addr))
            .await
            .unwrap();

        // Send text frame (should be ignored)
        ws_stream.send(Message::Text("hello".to_string())).await.unwrap();

        // Send valid ping request
        let request = RequestEnvelope {
            request_id: Some("r2".to_string()),
            request: Request::Ping,
        };
        let msg_bytes = rmp_serde::to_vec_named(&request).unwrap();
        ws_stream.send(Message::Binary(msg_bytes)).await.unwrap();

        // Should receive ping response (text frame was ignored)
        let response_msg = ws_stream.next().await.unwrap().unwrap();
        match response_msg {
            Message::Binary(_) => { /* success */ }
            _ => panic!("Expected binary response after text frame ignored"),
        }
    }

    #[tokio::test]
    async fn test_websocket_invalid_msgpack() {
        let (_dir, manager) = setup_test_manager();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_client_websocket(stream, manager, 999, None).await;
        });

        let (mut ws_stream, _) = connect_async(format!("ws://{}", addr))
            .await
            .unwrap();

        // Send invalid MessagePack data
        ws_stream.send(Message::Binary(vec![0xFF, 0xFF, 0xFF])).await.unwrap();

        // Should receive error response
        let response_msg = ws_stream.next().await.unwrap().unwrap();
        let response_bytes = match response_msg {
            Message::Binary(data) => data,
            _ => panic!("Expected binary error response"),
        };

        let envelope: ResponseEnvelope = rmp_serde::from_slice(&response_bytes).unwrap();
        assert_eq!(envelope.request_id, None);

        match envelope.response {
            Response::Error { error } => {
                assert!(error.contains("Invalid request"));
            }
            _ => panic!("Expected Error response for invalid MessagePack"),
        }
    }
}
```

---

### 6.2 TypeScript Integration Tests

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/websocket-client.test.ts` (NEW)

```typescript
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { RFDBWebSocketClient } from './websocket-client.js';

const TEST_PORT = 7475;
const TEST_WS_URL = `ws://localhost:${TEST_PORT}`;
const TEST_DB_PATH = './test-ws.rfdb';

let serverProcess: ChildProcess | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

beforeAll(async () => {
  // Create test database directory
  if (!existsSync(TEST_DB_PATH)) {
    mkdirSync(TEST_DB_PATH, { recursive: true });
  }

  // Find rfdb-server binary
  const binaryPath = process.env.RFDB_SERVER_PATH || './packages/rfdb-server/target/debug/rfdb-server';

  // Start server
  serverProcess = spawn(binaryPath, [TEST_DB_PATH, '--ws-port', TEST_PORT.toString()], {
    stdio: 'pipe',
  });

  serverProcess.stderr?.on('data', (data) => {
    console.log(`[rfdb-server] ${data.toString()}`);
  });

  // Wait for server to start
  await sleep(1000);
}, 10000);

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
});

describe('RFDBWebSocketClient', () => {
  test('connect and ping', async () => {
    const client = new RFDBWebSocketClient(TEST_WS_URL);
    await client.connect();

    const version = await client.ping();
    expect(version).toBeTruthy();
    expect(typeof version).toBe('string');

    await client.close();
  });

  test('hello handshake', async () => {
    const client = new RFDBWebSocketClient(TEST_WS_URL);
    await client.connect();

    const hello = await client.hello(2);
    expect(hello.ok).toBe(true);
    expect(hello.protocolVersion).toBeGreaterThanOrEqual(2);
    expect(hello.serverVersion).toBeTruthy();

    await client.close();
  });

  test('create and open database', async () => {
    const client = new RFDBWebSocketClient(TEST_WS_URL);
    await client.connect();
    await client.hello(2);

    const createResp = await client.createDatabase('test-ws', true);
    expect(createResp.ok).toBe(true);

    const openResp = await client.openDatabase('test-ws', 'readwrite');
    expect(openResp.ok).toBe(true);

    await client.close();
  });

  test('add nodes and query', async () => {
    const client = new RFDBWebSocketClient(TEST_WS_URL);
    await client.connect();
    await client.hello(2);
    await client.createDatabase('test-add-nodes', true);
    await client.openDatabase('test-add-nodes');

    const nodesAdded = await client.addNodes([
      { id: 'n1', type: 'TEST', file: 'test.js', line: 1, column: 0 },
      { id: 'n2', type: 'TEST', file: 'test.js', line: 2, column: 0 },
    ]);
    expect(nodesAdded).toBe(2);

    const node = await client.getNode('n1');
    expect(node).toBeTruthy();
    expect(node?.id).toBe('n1');
    expect(node?.type).toBe('TEST');

    await client.close();
  });

  test('query nodes (no streaming)', async () => {
    const client = new RFDBWebSocketClient(TEST_WS_URL);
    await client.connect();
    await client.hello(2);
    await client.createDatabase('test-query', true);
    await client.openDatabase('test-query');

    // Add 50 nodes
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      id: `node-${i}`,
      type: 'QUERY_TEST',
      file: 'test.js',
      line: i,
      column: 0,
    }));
    await client.addNodes(nodes);

    // Query all nodes (should return full array, no streaming)
    const result = await client.queryNodes({ type: 'QUERY_TEST' });
    expect(result.length).toBe(50);

    await client.close();
  });

  test('large message (>1 MB)', async () => {
    const client = new RFDBWebSocketClient(TEST_WS_URL);
    await client.connect();
    await client.hello(2);
    await client.createDatabase('test-large', true);
    await client.openDatabase('test-large');

    // Create 10,000 nodes with 200-byte metadata each = ~2 MB
    const largeNodes = Array.from({ length: 10000 }, (_, i) => ({
      id: `large-${i}`,
      type: 'LARGE_TEST',
      file: 'large.js',
      line: i,
      column: 0,
      metadata: {
        description: 'x'.repeat(150), // Pad to ~200 bytes per node
      },
    }));

    const added = await client.addNodes(largeNodes);
    expect(added).toBe(10000);

    await client.close();
  }, 30000); // 30s timeout

  test('error handling: query without database', async () => {
    const client = new RFDBWebSocketClient(TEST_WS_URL);
    await client.connect();
    await client.hello(2);
    // Do NOT open database

    await expect(client.queryNodes({ type: 'TEST' })).rejects.toThrow();

    await client.close();
  });

  test('multiple concurrent clients', async () => {
    const clients = await Promise.all([
      RFDBWebSocketClient,
      RFDBWebSocketClient,
      RFDBWebSocketClient,
    ].map(async (ClientClass) => {
      const c = new ClientClass(TEST_WS_URL);
      await c.connect();
      return c;
    }));

    // All clients ping in parallel
    const versions = await Promise.all(clients.map(c => c.ping()));
    expect(versions.every(v => typeof v === 'string')).toBe(true);

    // Close all
    await Promise.all(clients.map(c => c.close()));
  });
});
```

**Run tests:**
```bash
cd packages/rfdb
pnpm test websocket-client.test.ts
```

---

## 7. Implementation Sequence (Revised)

**CRITICAL:** Follow this order exactly. Each phase builds on the previous.

### Phase 1: Dependencies & CLI (1 hour)
1. Add `tokio-tungstenite` and `futures-util` to Cargo.toml
2. Add `--ws-port` CLI parsing
3. Update help text
4. **Verify:** `cargo build`, `--help` shows new flag

### Phase 2: Async Main & Accept Loop (2 hours)
1. Add imports (`tokio::net::TcpListener`, `tokio_tungstenite`, `futures_util`)
2. Change `fn main()` to `#[tokio::main] async fn main()`
3. Add WebSocket listener binding (after Unix socket)
4. Wrap Unix socket accept loop in `tokio::task::spawn_blocking`
5. Add WebSocket accept loop with `tokio::spawn`
6. Join both tasks
7. **Verify:** Both listeners start, `lsof` shows both active

### Phase 3: WebSocket Handler (3 hours)
1. Rename `handle_client` → `handle_client_unix`
2. Update call site in Unix accept loop
3. Implement `handle_client_websocket` (async)
4. **Verify:** Send MessagePack ping via `websocat`, get pong

### Phase 4: TypeScript Client (4 hours)
1. Create `websocket-client.ts`
2. Implement `RFDBWebSocketClient` class
3. Export from `index.ts`
4. Create `websocket-client.test.ts`
5. **Verify:** All tests pass

### Phase 5: VS Code Extension (2 hours)
1. Add configuration properties to `package.json`
2. Update `grafemaClient.ts` imports and types
3. Modify `connect()` method to support WebSocket
4. Create `WEBSOCKET.md` documentation
5. **Verify:** Extension connects via WebSocket config

### Phase 6: Documentation & Cleanup (1 hour)
1. Update main README with WebSocket instructions
2. Add inline comments for future maintainers
3. Run clippy, rustfmt
4. Final smoke test: both transports active

**Total: 13 hours** (2 days of focused work)

---

## 8. Success Criteria (Expanded)

### Must Pass Before Merge (P0)

- [ ] `rfdb-server --help` shows `--ws-port` flag with description
- [ ] `rfdb-server ./test.rfdb --ws-port 7474` starts both listeners
- [ ] `lsof -i :7474` shows rfdb-server process
- [ ] Existing Unix socket tests pass (regression check)
- [ ] `RFDBWebSocketClient.connect()` succeeds from Node.js
- [ ] Ping/pong roundtrip works via WebSocket
- [ ] Hello handshake negotiates protocol v2
- [ ] AddNodes + GetNode works via WebSocket
- [ ] VS Code extension connects with `rfdbTransport: "websocket"` config
- [ ] Multiple WebSocket clients can connect simultaneously
- [ ] Rust unit tests pass (`test_websocket_ping_pong`, etc.)
- [ ] TypeScript integration tests pass (`websocket-client.test.ts`)

### Should Pass Before Merge (P1)

- [ ] Invalid MessagePack → Error response (not crash)
- [ ] Text frame → Ignored (not crash)
- [ ] Port already in use → Clear error message, exit 1
- [ ] Query without database → ErrorWithCode response
- [ ] Large message (>1 MB) → Success
- [ ] Concurrent clients (3+) → All succeed

### Nice to Have (P2)

- [ ] 1000-node query returns full array (no streaming)
- [ ] SIGTERM flushes databases with WebSocket clients active
- [ ] Benchmark: WebSocket latency <200 µs for ping
- [ ] Benchmark: Unix socket throughput unchanged

---

## 9. Follow-Up Tasks

### REG-524: WebSocket Streaming Support
- Refactor `handle_query_nodes_streaming` to async
- Support `NodesChunk` responses over WebSocket
- Update `RFDBWebSocketClient` to handle chunks

### REG-525: WebSocket Configuration & Limits
- Add `--ws-max-connections N` flag
- Add `--ws-idle-timeout N` flag
- Add `--ws-send-timeout N` flag
- Connection pooling / rate limiting

### REG-526: WebSocket Security & Production Hardening
- Add `--ws-bind-addr` flag (allow `0.0.0.0` for production)
- Add `--ws-allow-origin` flag (CORS header validation)
- TLS support (`wss://` with certificate path)
- Graceful shutdown (broadcast Close frames before exit)

---

## 10. Open Questions (Resolved)

All questions from Don's plan have been resolved:

1. **Streaming:** SKIP for MVP ✅
2. **Port default:** REQUIRE explicit `--ws-port` ✅
3. **CORS:** Localhost-only for MVP ✅
4. **TLS:** Not needed for MVP ✅
5. **Error protocol:** Same as Unix socket ✅
6. **Session management:** Same `ClientSession`, no legacy mode ✅
7. **Signal handling:** Same as Unix socket (abrupt shutdown) ✅

---

## 11. Implementation Notes for Kent & Rob

### For Kent (Test Engineer)

**Start here:**
1. Read Section 6 (Test Implementation)
2. Create `websocket-client.test.ts` first (TDD approach)
3. Run tests against stub client (they'll fail)
4. Once Rob completes Phase 3, tests should pass
5. Add Rust unit tests in Phase 3 completion window

**Key insight:** WebSocket tests are IDENTICAL to Unix socket tests, just different transport. Copy existing test patterns.

---

### For Rob (Implementation Engineer)

**Start here:**
1. Read Section 2 (Code Changes) carefully
2. Follow phase order EXACTLY (don't skip ahead)
3. Verify each phase before moving to next
4. Use line numbers as guide, but re-read actual code (file may have changed)

**Critical gotchas:**
- **Async context:** `handle_client_websocket` is async, uses `.await` everywhere
- **Message framing:** WebSocket frames ARE the message boundary (no length prefix)
- **No streaming:** Always call `handle_request()`, never `handle_query_nodes_streaming()`
- **No legacy mode:** WebSocket always requires Hello + OpenDatabase

**When stuck:** Read tokio-tungstenite docs: https://docs.rs/tokio-tungstenite/0.24

---

## 12. Risk Mitigation Summary

| Risk | Severity | Mitigation | Status |
|------|----------|------------|--------|
| Async/Sync mixing causes deadlock | MEDIUM | Use `spawn_blocking` for Unix socket | Designed into Phase 2 |
| WebSocket streaming complexity | MEDIUM | Skip streaming for MVP | Resolved (REG-524) |
| Port conflicts | LOW | Require explicit port, clear error | Implemented in Phase 2 |
| Message size limits | LOW | Configure 100 MB max (same as Unix) | Designed into Phase 3 |
| CORS / Security | HIGH (prod) | Bind localhost only for MVP | Documented, follow-up REG-526 |
| Graceful shutdown | LOW | Same as Unix (abrupt exit) | Accepted trade-off |
| Client disconnect mid-request | LOW | Same consistency as Unix socket | Documented edge case |

---

## Conclusion

This specification provides **complete implementation detail** for REG-523. Kent and Rob should be able to execute this plan without additional research or decision-making. All technical decisions are resolved, edge cases documented, and test coverage defined.

**Expected outcome:** WebSocket transport works identically to Unix socket (same protocol, same API), just different connection method. VS Code web extension can connect via `ws://localhost:7474` configuration.

**Next step:** Present this spec to user for approval, then proceed to implementation.
