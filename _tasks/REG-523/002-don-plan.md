# REG-523: WebSocket Transport Implementation Plan

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-20
**Status:** Ready for Implementation

## Executive Summary

Add WebSocket transport to RFDB server to enable browser-based clients (VS Code web extensions). The server will run **both** Unix socket and WebSocket listeners simultaneously on different ports. The existing message protocol (MessagePack with length-prefixed framing) will be preserved, with WebSocket using **binary frames** containing the same MessagePack payloads.

## 1. Current Architecture Analysis

### 1.1 Rust Server Architecture

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs` (4833 lines)

**Entry Point (`main`, line 2200):**
```
1. Parse CLI args manually (no clap/structopt — just std::env::args)
   - db_path (positional, required)
   - --socket <path> (default: /tmp/rfdb.sock)
   - --data-dir <path> (default: parent of db_path)
   - --metrics (flag)

2. Create DatabaseManager (Arc<DatabaseManager>)
3. Bind UnixListener at socket_path
4. Spawn signal handler thread (SIGINT/SIGTERM → flush → exit)
5. Accept loop: for stream in listener.incoming()
   - Spawn thread::spawn for each connection
   - Pass (stream, manager, client_id, legacy_mode=true, metrics)
```

**Connection Handler (`handle_client`, line 2088):**
```rust
fn handle_client(
    mut stream: UnixStream,
    manager: Arc<DatabaseManager>,
    client_id: usize,
    legacy_mode: bool,
    metrics: Option<Arc<Metrics>>,
)
```

**Per-client loop:**
1. `read_message(&mut stream)` — read 4-byte BE length prefix + payload
2. Deserialize MessagePack → `RequestEnvelope { request_id, request }`
3. Route request → `handle_request()` or `handle_query_nodes_streaming()`
4. Serialize response → MessagePack
5. `write_message(&mut stream, &bytes)` — write 4-byte BE length + payload
6. Repeat until disconnect or shutdown

**Message Framing Functions (lines 2055-2086):**
```rust
fn read_message(stream: &mut UnixStream) -> std::io::Result<Option<Vec<u8>>>
fn write_message(stream: &mut UnixStream, data: &[u8]) -> std::io::Result<()>
```
- **Protocol:** `[4-byte length BE][MessagePack payload]`
- Max message size: 100 MB
- Streaming support (protocol v3): `NodesChunk` responses for large queries

**Concurrency Model:**
- NOT using Tokio async runtime for connections (despite tokio being in Cargo.toml)
- `std::thread::spawn` for each client
- Synchronous blocking I/O (std::io::Read/Write)
- Arc for shared DatabaseManager state

**Cargo.toml dependencies:**
```toml
tokio = { version = "1.38", features = ["full"] }  # Available but unused for connections
rmp-serde = "1.3"  # MessagePack serialization
signal-hook = "0.3"
```

### 1.2 TypeScript Client Architecture

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/client.ts` (1368 lines)

**Class:** `RFDBClient`
```typescript
constructor(socketPath: string = '/tmp/rfdb.sock')
connect(): Promise<void>  // createConnection(socketPath)
```

**Transport:**
- Node.js `net.createConnection()` for Unix socket
- Same framing: 4-byte BE length prefix + MessagePack payload
- Request format: `{ requestId: "r123", cmd: "addNodes", ...payload }`
- Response format: `{ requestId: "r123", ...response }` (echo requestId back)

**Key methods:**
```typescript
private _send(cmd, payload, timeout): Promise<RFDBResponse>
  → encode({ requestId, cmd, ...payload })
  → write length prefix + msgpack bytes
  → wait for response (pending.get(id))

private _handleData(chunk: Buffer)
  → parse length prefix, extract message
  → decode(msgBytes) as RFDBResponse
  → match requestId, resolve promise
```

**Streaming support (protocol v3):**
- `queryNodesStream()` uses `StreamQueue<WireNode>`
- Server sends multiple `NodesChunk` frames for large result sets
- Client routes chunks to StreamQueue based on requestId

### 1.3 VS Code Extension Integration

**File:** `/Users/vadimr/grafema-worker-2/packages/vscode/src/grafemaClient.ts`

**Class:** `GrafemaClientManager`
```typescript
constructor(workspaceRoot, explicitBinaryPath?, explicitSocketPath?)
  this.client = new RFDBClient(socketPath)

connect():
  1. Check if .grafema/graph.rfdb exists
  2. Try RFDBClient.connect()
  3. If fails, spawn rfdb-server process
  4. Retry connect
```

**Key observations:**
- Extension uses `RFDBClient` from `@grafema/rfdb` package
- No transport abstraction layer — hardcoded Unix socket
- Socket path: `.grafema/rfdb.sock` in workspace root

### 1.4 Wire Protocol

**Message Envelope (Rust):**
```rust
#[derive(Deserialize)]
struct RequestEnvelope {
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    #[serde(flatten)]
    request: Request,  // enum with tag="cmd"
}

#[derive(Serialize)]
struct ResponseEnvelope {
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(flatten)]
    response: Response,  // untagged enum
}
```

**Request enum:**
```rust
#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Request {
    AddNodes { nodes: Vec<WireNode> },
    GetNode { id: String },
    // ... 50+ variants
}
```

**Transport framing:**
```
Unix Socket:  [4-byte BE length][MessagePack bytes]
              ↓
              Read exact 4 bytes → parse length → read exact length bytes
```

## 2. WebSocket Transport Design

### 2.1 Why tokio-tungstenite?

**Rationale:**
1. **Tokio integration** — Project already has `tokio = { version = "1.38", features = ["full"] }` in Cargo.toml
2. **Mature ecosystem** — tokio-tungstenite is the de facto standard for Tokio + WebSocket ([docs.rs](https://docs.rs/tokio-tungstenite), [GitHub](https://github.com/snapview/tokio-tungstenite))
3. **Binary frame support** — Native support for binary WebSocket frames (required for MessagePack)
4. **Streaming compatibility** — Implements `Stream`/`Sink` traits, compatible with async framing
5. **Minimal dependencies** — Pure Rust, no C dependencies

**Alternative considered:** `axum` (web framework with WebSocket support)
- **Rejected:** Overkill for this use case. We only need raw WebSocket, not HTTP routing, middleware, etc.
- tokio-tungstenite is lighter and more direct

### 2.2 Framing Strategy

**WebSocket Message = Single RFDB Message**

Each WebSocket binary frame contains:
```
WebSocket Binary Frame: [MessagePack bytes]
                        ↑
                        NO length prefix needed — WebSocket handles framing
```

**Why no length prefix?**
- WebSocket protocol already handles message boundaries
- Each `ws.send(binary_data)` becomes a discrete frame
- Receiver gets complete messages via `stream.next().await`

**MessagePack encoding:** IDENTICAL to current protocol
```
Client  → WebSocket → Binary Frame [rmp_serde::to_vec_named(&RequestEnvelope)]
Server  → WebSocket → Binary Frame [rmp_serde::to_vec_named(&ResponseEnvelope)]
```

**Streaming (NodesChunk):** Same as Unix socket
- Multiple binary frames, each containing one `NodesChunk` response
- Client routes by `requestId`

### 2.3 Connection Handling

**Two separate accept loops running concurrently:**

```rust
// main.rs
#[tokio::main]  // NEW: Make main async
async fn main() {
    // ... existing setup ...

    let unix_listener = UnixListener::bind(socket_path)?;
    let ws_listener = TcpListener::bind("127.0.0.1:ws_port").await?;

    // Spawn Unix socket handler (existing code, run in blocking task)
    let unix_handle = tokio::task::spawn_blocking(move || {
        for stream in unix_listener.incoming() {
            let stream = stream.unwrap();
            let manager = manager.clone();
            std::thread::spawn(move || {
                handle_client_unix(stream, manager, ...);
            });
        }
    });

    // Spawn WebSocket handler (new async code)
    let ws_handle = tokio::spawn(async move {
        loop {
            let (tcp_stream, addr) = ws_listener.accept().await.unwrap();
            let manager = manager.clone();
            tokio::spawn(handle_client_ws(tcp_stream, manager, ...));
        }
    });

    tokio::try_join!(unix_handle, ws_handle).unwrap();
}
```

**Critical design decision:** Keep Unix socket handler as-is (blocking I/O + threads)
- **Why:** Minimal code churn, preserve existing battle-tested logic
- **Trade-off:** Two different concurrency models in same binary (OK for this use case)

### 2.4 Message Handler Abstraction

**Problem:** `handle_client()` currently takes `UnixStream` and calls `read_message`/`write_message` directly.

**Solution:** Extract I/O operations into a trait.

```rust
// NEW: Transport abstraction
trait Transport {
    fn read_message(&mut self) -> std::io::Result<Option<Vec<u8>>>;
    fn write_message(&mut self, data: &[u8]) -> std::io::Result<()>;
}

// Existing implementation for Unix socket
struct UnixTransport(UnixStream);

impl Transport for UnixTransport {
    fn read_message(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        // existing read_message logic (4-byte length prefix)
    }

    fn write_message(&mut self, data: &[u8]) -> std::io::Result<()> {
        // existing write_message logic (4-byte length prefix)
    }
}

// NEW: WebSocket implementation
struct WebSocketTransport {
    stream: WebSocketStream<TcpStream>,  // tokio_tungstenite::WebSocketStream
}

impl Transport for WebSocketTransport {
    fn read_message(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        // block_on(stream.next()) → extract binary data
        // (or make trait async — see Risk #2 below)
    }

    fn write_message(&mut self, data: &[u8]) -> std::io::Result<()> {
        // block_on(stream.send(Message::Binary(data.to_vec())))
    }
}
```

**Alternative:** Make `handle_client` generic over Transport trait (cleaner but more refactoring).

## 3. Implementation Plan

### Phase 1: Add WebSocket Dependencies & CLI Flag

**File:** `packages/rfdb-server/Cargo.toml`

**Add:**
```toml
tokio-tungstenite = "0.24"  # WebSocket for tokio
futures-util = "0.3"        # For stream combinators (StreamExt)
```

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs` (main function, line 2200)

**Add CLI parsing:**
```rust
let ws_port = args.iter()
    .position(|a| a == "--ws-port")
    .and_then(|i| args.get(i + 1))
    .and_then(|s| s.parse::<u16>().ok());
```

**Update help text:**
```
--ws-port <port>   Enable WebSocket transport on specified port (e.g., 7474)
```

**Validation:**
- If `--ws-port` not provided → skip WebSocket setup (backward compatible)
- If provided → validate port is valid u16

**Tests:**
```bash
cargo build
./target/debug/rfdb-server --help  # verify help text
./target/debug/rfdb-server ./test.rfdb --ws-port 7474 --socket /tmp/test.sock
```

### Phase 2: Implement WebSocket Accept Loop

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs`

**Changes:**

1. **Make main async:**
```rust
#[tokio::main]
async fn main() {
    // ... existing arg parsing ...
}
```

2. **Bind WebSocket listener (after Unix socket setup):**
```rust
let ws_listener = if let Some(port) = ws_port {
    let addr = format!("127.0.0.1:{}", port);
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => {
            eprintln!("[rfdb-server] WebSocket listening on {}", addr);
            Some(listener)
        }
        Err(e) => {
            eprintln!("[rfdb-server] Failed to bind WebSocket port: {}", e);
            std::process::exit(1);
        }
    }
} else {
    None
};
```

3. **Spawn Unix socket handler in blocking task:**
```rust
let unix_handle = tokio::task::spawn_blocking(move || {
    for stream in unix_listener.incoming() {
        match stream {
            Ok(stream) => {
                let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::SeqCst);
                let manager_clone = Arc::clone(&manager);
                let metrics_clone = metrics.clone();
                std::thread::spawn(move || {
                    handle_client_unix(stream, manager_clone, client_id, true, metrics_clone);
                });
            }
            Err(e) => eprintln!("[rfdb-server] Accept error: {}", e),
        }
    }
});
```

4. **Spawn WebSocket accept loop (if enabled):**
```rust
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
                Err(e) => eprintln!("[rfdb-server] WebSocket accept error: {}", e),
            }
        }
    }))
} else {
    None
};
```

5. **Join both tasks:**
```rust
if let Some(ws) = ws_handle {
    let _ = tokio::try_join!(unix_handle, ws);
} else {
    let _ = unix_handle.await;
}
```

**Tests:**
```bash
# Start server with both transports
./target/debug/rfdb-server ./test.rfdb --socket /tmp/test.sock --ws-port 7474

# Verify both listeners are active (separate terminal)
lsof -i :7474  # should show rfdb-server
ls -la /tmp/test.sock  # should exist

# Connect via Unix socket (existing test)
node -e "const {RFDBClient} = require('@grafema/rfdb'); const c = new RFDBClient('/tmp/test.sock'); c.connect().then(() => console.log('OK'))"
```

### Phase 3: Implement WebSocket Message Handler

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs`

**Add async WebSocket handler (after existing `handle_client`):**

```rust
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use futures_util::{StreamExt, SinkExt};

async fn handle_client_websocket(
    tcp_stream: tokio::net::TcpStream,
    manager: Arc<DatabaseManager>,
    client_id: usize,
    metrics: Option<Arc<Metrics>>,
) {
    eprintln!("[rfdb-server] WebSocket client {} connected", client_id);

    // Upgrade to WebSocket
    let ws_stream = match accept_async(tcp_stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[rfdb-server] WebSocket upgrade failed: {}", e);
            return;
        }
    };

    let (mut ws_write, mut ws_read) = ws_stream.split();
    let mut session = ClientSession::new(client_id);

    // Protocol v2: client must send Hello first (no legacy mode for WebSocket)
    // Auto-opening "default" database only happens in Unix socket legacy mode

    loop {
        // Read next WebSocket message
        let msg = match ws_read.next().await {
            Some(Ok(Message::Binary(data))) => data,
            Some(Ok(Message::Close(_))) => {
                eprintln!("[rfdb-server] WebSocket client {} disconnected", client_id);
                break;
            }
            Some(Ok(_)) => continue, // Ignore text/ping/pong
            Some(Err(e)) => {
                eprintln!("[rfdb-server] WebSocket client {} read error: {}", client_id, e);
                break;
            }
            None => {
                eprintln!("[rfdb-server] WebSocket client {} stream closed", client_id);
                break;
            }
        };

        // Deserialize MessagePack (same as Unix socket)
        let (request_id, request) = match rmp_serde::from_slice::<RequestEnvelope>(&msg) {
            Ok(env) => (env.request_id, env.request),
            Err(e) => {
                let envelope = ResponseEnvelope {
                    request_id: None,
                    response: Response::Error { error: format!("Invalid request: {}", e) },
                };
                let resp_bytes = rmp_serde::to_vec_named(&envelope).unwrap();
                let _ = ws_write.send(Message::Binary(resp_bytes)).await;
                continue;
            }
        };

        let is_shutdown = matches!(request, Request::Shutdown);
        let start = Instant::now();
        let op_name = get_operation_name(&request);

        // Handle request (same logic as Unix socket)
        // NOTE: Streaming needs special handling — see Phase 4
        let response = handle_request(&manager, &mut session, request, &metrics);

        // Record metrics
        if let Some(ref m) = metrics {
            let duration_ms = start.elapsed().as_millis() as u64;
            m.record_query(&op_name, duration_ms);
            if duration_ms >= SLOW_QUERY_THRESHOLD_MS {
                eprintln!("[RUST SLOW] {}: {}ms (ws client {})", op_name, duration_ms, client_id);
            }
        }

        // Send response
        let envelope = ResponseEnvelope { request_id, response };
        let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("[rfdb-server] Serialize error: {}", e);
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

    // Cleanup
    handle_close_database(&manager, &mut session);
}
```

**Rename existing handler:**
```rust
// OLD: fn handle_client(...)
// NEW:
fn handle_client_unix(
    mut stream: UnixStream,
    // ... same signature
) {
    // ... existing code unchanged
}
```

**Tests:**
```bash
# Use websocat to test (install: cargo install websocat)
websocat ws://127.0.0.1:7474

# In websocat terminal, send binary MessagePack ping request
# (need to encode manually or use test script — see Phase 5)
```

### Phase 4: Add Streaming Support for WebSocket

**Problem:** Current `handle_query_nodes_streaming` writes directly to `UnixStream`.

**Solution:** Extract streaming logic to support both transports.

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs`

**Changes:**

1. **Refactor streaming handler to be async and return chunks:**
```rust
async fn stream_query_nodes_chunks(
    session: &ClientSession,
    query: WireAttrQuery,
    request_id: &Option<String>,
) -> Result<Vec<(Vec<WireNode>, bool, u32)>, String> {
    // ... existing logic from handle_query_nodes_streaming ...
    // Returns vector of (nodes_chunk, is_done, chunk_index)
}
```

2. **Update WebSocket handler to call streaming logic:**
```rust
// In handle_client_websocket loop:
let handle_result = match request {
    Request::QueryNodes { query } if session.protocol_version >= 3 => {
        // Stream chunks over WebSocket
        match stream_query_nodes_chunks(&session, query, &request_id).await {
            Ok(chunks) => {
                for (nodes, done, chunk_index) in chunks {
                    let response = Response::NodesChunk { nodes, done, chunk_index };
                    let envelope = ResponseEnvelope {
                        request_id: request_id.clone(),
                        response,
                    };
                    let bytes = rmp_serde::to_vec_named(&envelope).unwrap();
                    ws_write.send(Message::Binary(bytes)).await?;
                }
                continue; // Skip normal response send
            }
            Err(e) => HandleResult::Single(Response::Error { error: e }),
        }
    }
    other => HandleResult::Single(handle_request(&manager, &mut session, other, &metrics)),
};
```

**Alternative (simpler for MVP):** Disable streaming for WebSocket initially
- Check `session.protocol_version` and downgrade to single-response mode
- Add streaming in follow-up iteration

**Recommendation:** Ship without streaming first, add in REG-524 (follow-up task).

### Phase 5: TypeScript WebSocket Client

**File:** `packages/rfdb/ts/websocket-client.ts` (NEW)

**Class:** `RFDBWebSocketClient` (extends EventEmitter, implements IRFDBClient)

```typescript
import { encode, decode } from '@msgpack/msgpack';
import type { RFDBCommand, RFDBResponse, IRFDBClient } from '@grafema/types';

export class RFDBWebSocketClient extends EventEmitter implements IRFDBClient {
  private ws: WebSocket | null = null;
  private pending: Map<number, { resolve: Function, reject: Function }> = new Map();
  private reqId: number = 0;
  connected: boolean = false;

  constructor(private url: string) {  // e.g., "ws://localhost:7474"
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';  // CRITICAL: receive as ArrayBuffer

      this.ws.onopen = () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      };

      this.ws.onerror = (err) => {
        if (!this.connected) reject(err);
        else this.emit('error', err);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emit('disconnected');
        for (const [, { reject }] of this.pending) {
          reject(new Error('Connection closed'));
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
      if (id === null) return;

      const pending = this.pending.get(id);
      if (!pending) return;

      this.pending.delete(id);
      if (response.error) {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve(response);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  private async _send(
    cmd: RFDBCommand,
    payload: Record<string, unknown> = {},
    timeoutMs: number = 60_000
  ): Promise<RFDBResponse> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected');
    }

    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const request = { requestId: `r${id}`, cmd, ...payload };
      const msgBytes = encode(request);

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      this.ws!.send(msgBytes);
    });
  }

  // ... implement all IRFDBClient methods (same as RFDBClient) ...
  async ping(): Promise<string | false> {
    const response = await this._send('ping') as { pong?: boolean; version?: string };
    return response.pong && response.version ? response.version : false;
  }

  // ... rest of API methods ...
}
```

**Export from index:**
```typescript
// packages/rfdb/ts/index.ts
export { RFDBClient } from './client.js';
export { RFDBWebSocketClient } from './websocket-client.js';
export type { IRFDBClient } from '@grafema/types';
```

**Tests:**
```typescript
// packages/rfdb/ts/websocket-client.test.ts
import { RFDBWebSocketClient } from './websocket-client.js';

test('WebSocket client connects and pings', async () => {
  const client = new RFDBWebSocketClient('ws://localhost:7474');
  await client.connect();
  const version = await client.ping();
  expect(version).toBeTruthy();
  await client.close();
});
```

### Phase 6: VS Code Extension Configuration

**File:** `packages/vscode/package.json`

**Add configuration:**
```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "grafema.rfdbTransport": {
          "type": "string",
          "enum": ["unix", "websocket"],
          "default": "unix",
          "description": "RFDB transport protocol (unix socket or WebSocket)"
        },
        "grafema.rfdbWebSocketUrl": {
          "type": "string",
          "default": "ws://localhost:7474",
          "description": "RFDB WebSocket URL (when transport is 'websocket')"
        }
      }
    }
  }
}
```

**File:** `packages/vscode/src/grafemaClient.ts`

**Update `GrafemaClientManager`:**
```typescript
import { RFDBClient } from '@grafema/rfdb';
import { RFDBWebSocketClient } from '@grafema/rfdb';
import type { IRFDBClient } from '@grafema/types';

export class GrafemaClientManager extends EventEmitter {
  private client: IRFDBClient | null = null;  // Use interface, not concrete class

  async connect(): Promise<void> {
    const config = vscode.workspace.getConfiguration('grafema');
    const transport = config.get<string>('rfdbTransport') || 'unix';

    if (transport === 'websocket') {
      const wsUrl = config.get<string>('rfdbWebSocketUrl') || 'ws://localhost:7474';
      this.setState({ status: 'connecting' });
      const client = new RFDBWebSocketClient(wsUrl);
      await client.connect();
      const pong = await client.ping();
      if (!pong) throw new Error('Server did not respond');
      this.client = client;
      this.setState({ status: 'connected' });
      // NOTE: No server auto-start for WebSocket (server must be started manually)
    } else {
      // ... existing Unix socket logic ...
    }
  }
}
```

**Documentation (README):**
```markdown
## VS Code Web Extension Support

For browser-based VS Code (vscode.dev, github.dev):

1. Start RFDB server with WebSocket transport:
   ```bash
   rfdb-server ./path/to/graph.rfdb --ws-port 7474
   ```

2. Configure extension settings:
   - `grafema.rfdbTransport`: "websocket"
   - `grafema.rfdbWebSocketUrl`: "ws://localhost:7474"

3. Reload VS Code window

Note: Auto-start is not supported for WebSocket. Server must be started manually.
```

## 4. Risk Assessment

### Risk #1: Async/Sync Mixing (MEDIUM)

**Issue:** Main function becomes `#[tokio::main]` async, but existing Unix socket code is synchronous.

**Mitigation:**
- Use `tokio::task::spawn_blocking` for Unix socket accept loop
- Keep existing thread-per-connection model for Unix socket
- Only WebSocket handler is async

**Test:** Run both transports under load, verify no panics/deadlocks.

### Risk #2: WebSocket Connection Limits (LOW)

**Issue:** Tokio async tasks are cheaper than threads, but still consume resources.

**Mitigation:**
- Document recommended concurrent connection limits
- Add `--ws-max-connections` flag in follow-up (REG-525)
- For MVP, rely on OS limits

### Risk #3: Message Size Limits (LOW)

**Issue:** WebSocket has default max frame size (varies by impl).

**Mitigation:**
- tokio-tungstenite default max message size: 64 MB (larger than our 100 MB limit)
- Can configure via `WebSocketConfig::max_message_size`
- Same chunking strategy as Unix socket (10k nodes per CommitBatch chunk)

### Risk #4: Streaming Complexity (MEDIUM)

**Issue:** `handle_query_nodes_streaming` writes directly to `UnixStream` (blocking). WebSocket needs async.

**Mitigation:**
- **Phase 4 Option A:** Refactor to async (complex, high churn)
- **Phase 4 Option B:** Disable streaming for WebSocket in MVP (ship faster)

**Recommendation:** Option B. Ship REG-523 without streaming, add in REG-524.

### Risk #5: CORS / Security (HIGH for production, LOW for MVP)

**Issue:** WebSocket from browser requires CORS headers (HTTP upgrade handshake).

**Mitigation:**
- **MVP:** Bind to `127.0.0.1` only (localhost, no external access)
- **Production:** Add `--ws-allow-origin` flag, implement Origin header validation
- tokio-tungstenite supports custom HTTP response during handshake

**Action:** Document in README that WebSocket is localhost-only for MVP.

### Risk #6: Graceful Shutdown (LOW)

**Issue:** Signal handler (SIGINT/SIGTERM) currently only knows about Unix socket connections.

**Mitigation:**
- WebSocket connections are tracked by Tokio runtime
- Tokio shutdown will drop all tasks, closing WebSocket connections
- Existing `handle_close_database` cleanup still runs in Drop handlers

**Test:** Send SIGTERM to server with active WebSocket client, verify flush occurs.

## 5. Testing Strategy

### Unit Tests (Rust)

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs` (add `#[cfg(test)]` module)

```rust
#[cfg(test)]
mod websocket_tests {
    use super::*;

    #[tokio::test]
    async fn test_websocket_ping() {
        let manager = setup_test_manager();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_client_websocket(stream, manager, 1, None).await;
        });

        let (ws_stream, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
            .await.unwrap();

        let request = RequestEnvelope {
            request_id: Some("r1".into()),
            request: Request::Ping,
        };
        let msg_bytes = rmp_serde::to_vec_named(&request).unwrap();

        ws_stream.send(Message::Binary(msg_bytes)).await.unwrap();

        let response = ws_stream.next().await.unwrap().unwrap();
        let Response::PingOk { .. } = /* deserialize */ else { panic!() };
    }
}
```

### Integration Tests (TypeScript)

**File:** `packages/rfdb/ts/websocket-client.test.ts`

```typescript
describe('RFDBWebSocketClient', () => {
  let server: ChildProcess;

  beforeAll(async () => {
    server = spawn('rfdb-server', ['./test.rfdb', '--ws-port', '7475']);
    await sleep(1000); // Wait for server startup
  });

  afterAll(() => {
    server.kill();
  });

  test('connect and ping', async () => {
    const client = new RFDBWebSocketClient('ws://localhost:7475');
    await client.connect();
    const version = await client.ping();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('addNodes and getNode', async () => {
    const client = new RFDBWebSocketClient('ws://localhost:7475');
    await client.connect();
    await client.hello(3);
    await client.createDatabase('test', true);
    await client.openDatabase('test');

    await client.addNodes([{ id: 'n1', type: 'TEST' }]);
    const node = await client.getNode('n1');
    expect(node.id).toBe('n1');
  });
});
```

### Manual Testing

```bash
# Terminal 1: Start server
cd packages/rfdb-server
cargo build
./target/debug/rfdb-server ./test.rfdb --socket /tmp/test.sock --ws-port 7474

# Terminal 2: Test Unix socket (existing client)
node -e "
  const {RFDBClient} = require('@grafema/rfdb');
  const c = new RFDBClient('/tmp/test.sock');
  c.connect().then(() => c.ping()).then(v => console.log('Unix socket:', v));
"

# Terminal 3: Test WebSocket (new client)
node -e "
  const {RFDBWebSocketClient} = require('@grafema/rfdb');
  const c = new RFDBWebSocketClient('ws://localhost:7474');
  c.connect().then(() => c.ping()).then(v => console.log('WebSocket:', v));
"

# Terminal 4: Monitor connections
watch -n 1 'lsof -i :7474 && echo "---" && ls -la /tmp/test.sock'
```

## 6. Implementation Sequence

**DO THIS IN ORDER:**

1. **Phase 1: CLI Flag + Dependencies** (1 hour)
   - Add `tokio-tungstenite` to Cargo.toml
   - Add `--ws-port` flag parsing
   - Test: `--help` shows new flag

2. **Phase 2: WebSocket Accept Loop** (2 hours)
   - Make `main` async with `#[tokio::main]`
   - Add `TcpListener::bind` + accept loop
   - Spawn blocking task for Unix socket
   - Test: Both listeners start, accept connections (use `nc` or `websocat`)

3. **Phase 3: WebSocket Message Handler** (3 hours)
   - Implement `handle_client_websocket`
   - Rename existing to `handle_client_unix`
   - Copy-paste logic, adapt for async WebSocket
   - Test: Send MessagePack ping via websocat, get pong

4. **Phase 5: TypeScript Client** (4 hours)
   - Create `websocket-client.ts`
   - Implement `IRFDBClient` interface
   - Add unit tests
   - Test: Full CRUD operations work

5. **Phase 6: VS Code Extension** (2 hours)
   - Add `rfdbTransport` config
   - Update `GrafemaClientManager`
   - Test: Extension connects via WebSocket

6. **Phase 4: Streaming (OPTIONAL)** (4 hours)
   - Refactor streaming logic
   - Add WebSocket streaming support
   - OR: Skip for MVP, file REG-524

**Total Estimate:** 12-16 hours (2 days) without streaming, 16-20 hours with streaming.

## 7. Files to Modify

### Rust Server

- `/Users/vadimr/grafema-worker-2/packages/rfdb-server/Cargo.toml`
  - Add `tokio-tungstenite`, `futures-util`

- `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`
  - Lines 2200-2350: Refactor `main` to async, add WebSocket listener
  - Lines 2088-2194: Rename `handle_client` → `handle_client_unix`
  - NEW: Add `handle_client_websocket` (async)
  - Lines 2055-2086: Keep `read_message`/`write_message` (used by Unix transport)

### TypeScript Client

- `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/websocket-client.ts` (NEW)
  - Full `RFDBWebSocketClient` implementation

- `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/index.ts`
  - Export `RFDBWebSocketClient`

- `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/websocket-client.test.ts` (NEW)
  - Integration tests

### VS Code Extension

- `/Users/vadimr/grafema-worker-2/packages/vscode/package.json`
  - Add `rfdbTransport`, `rfdbWebSocketUrl` config

- `/Users/vadimr/grafema-worker-2/packages/vscode/src/grafemaClient.ts`
  - Update `connect()` to support WebSocket transport

### Documentation

- `/Users/vadimr/grafema-worker-2/packages/rfdb-server/README.md` (if exists)
  - Document `--ws-port` flag

- `/Users/vadimr/grafema-worker-2/packages/vscode/README.md`
  - Add WebSocket setup instructions

## 8. Open Questions for User

1. **Port number convention:** Should we use a specific default port (e.g., 7474 like Neo4j)? Or require explicit `--ws-port`?
   - **Recommendation:** Require explicit port (no default) to avoid conflicts.

2. **CORS handling:** Do we need Origin validation for MVP, or localhost-only is acceptable?
   - **Recommendation:** Localhost-only for MVP (127.0.0.1 binding).

3. **TLS support:** Should we support `wss://` (WebSocket Secure) from day 1?
   - **Recommendation:** No. File as REG-526 (WebSocket TLS support). Use SSH tunnel for now if needed.

4. **Streaming priority:** Ship without streaming (simpler), or include in REG-523?
   - **Recommendation:** Skip streaming for REG-523. File REG-524 (WebSocket streaming support).

## 9. Success Criteria

- [ ] `rfdb-server --ws-port 7474` starts both Unix and WebSocket listeners
- [ ] Existing Unix socket clients work unchanged
- [ ] `RFDBWebSocketClient` connects from Node.js and sends/receives messages
- [ ] VS Code extension can switch between Unix and WebSocket via config
- [ ] All existing integration tests pass (Unix socket path unchanged)
- [ ] New WebSocket tests pass (client.test.ts)
- [ ] Documentation updated

## 10. References

### Rust Libraries
- [tokio-tungstenite documentation](https://docs.rs/tokio-tungstenite)
- [tokio-tungstenite GitHub](https://github.com/snapview/tokio-tungstenite)
- [Tokio TcpListener docs](https://docs.rs/tokio/latest/tokio/net/struct.TcpListener.html)
- [Tokio UnixListener docs](https://docs.rs/tokio/latest/tokio/net/struct.UnixListener.html)

### JavaScript/TypeScript
- [@msgpack/msgpack library](https://github.com/msgpack/msgpack-javascript)
- [msgpack-rpc-websockets](https://github.com/zo-el/msgpack-rpc-websockets)
- [WebSocket Binary Messages Guide](https://oneuptime.com/blog/post/2026-01-24-websocket-binary-messages/view)
- [JavaScript WebSocket Implementation Guide](https://websocket.org/guides/languages/javascript/)

---

**Next Step:** Review plan with user. If approved, start Phase 1 (CLI flag + dependencies).
