# REG-523: WebSocket Transport - Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2026-02-20
**Status:** Implementation Complete

## Summary

Implemented WebSocket transport for RFDB server across three layers: Rust server, TypeScript client, and VS Code extension. All existing tests pass (2109 JS tests, 683 Rust tests, 0 failures).

## Changes by Phase

### Phase 0: TypeScript Base Class Extraction (STEP 2.5 refactoring)

**Goal:** Extract reusable base from `RFDBClient` to avoid 900+ lines of duplication.

**New file:** `packages/rfdb/ts/base-client.ts`
- Abstract class `BaseRFDBClient extends EventEmitter implements IRFDBClient`
- Abstract methods: `_send()`, `connect()`, `close()`
- Contains ALL 60+ graph operation methods (addNodes, getNode, queryNodes, neighbors, datalogQuery, commitBatch, etc.)
- Contains batch operation logic (_sendCommitBatch with chunking)
- Contains shared utilities (_buildServerQuery, _resolveSnapshotRef, _parseExplainResponse)

**Modified file:** `packages/rfdb/ts/client.ts`
- `RFDBClient` now extends `BaseRFDBClient` instead of `EventEmitter`
- Moved all graph operation methods to base class
- Kept Unix-socket-specific code: `connect()`, `_send()`, `_handleData()`, `_handleResponse()`, streaming support, `close()`
- Override `hello()` to set `_supportsStreaming` flag
- Override `queryNodes()` and `queryNodesStream()` for streaming support

**Modified file:** `packages/rfdb/ts/index.ts`
- Added exports: `BaseRFDBClient`, `RFDBWebSocketClient`

### Phase 1-3: Rust Server (CLI + Accept Loop + WebSocket Handler)

**Modified file:** `packages/rfdb-server/Cargo.toml`
- Added: `tokio-tungstenite = "0.24"`, `futures-util = "0.3"`

**Modified file:** `packages/rfdb-server/src/bin/rfdb_server.rs`

1. **Imports:** Added `tokio::net::TcpListener`, `tokio::time::{timeout, Duration}`, `tokio_tungstenite`, `futures_util::{StreamExt, SinkExt}`

2. **CLI:** Added `--ws-port <port>` argument parsing with validation:
   - Port 0 rejected with clear error message
   - Invalid values rejected with error
   - Updated help text in both `--help` and usage error paths

3. **Renamed:** `handle_client` -> `handle_client_unix` (existing Unix socket handler unchanged)

4. **New function:** `handle_client_websocket` (async)
   - Accepts TCP, upgrades to WebSocket via `tokio_tungstenite::accept_async`
   - Splits into read/write halves
   - Loop: read binary frame -> deserialize MessagePack -> `handle_request()` via `spawn_blocking` -> serialize response -> send binary frame
   - Session moved into/out of `spawn_blocking` via `Option<ClientSession>` pattern
   - 60-second send timeout via `tokio::time::timeout` on all writes
   - Fallback error response on serialization failure (client doesn't hang)
   - Text frames ignored with log warning
   - Ping/Pong frames auto-handled by library
   - Close frame breaks loop cleanly
   - Cleanup: `handle_close_database` on connection end

5. **Main function:**
   - Changed to `#[tokio::main] async fn main()`
   - Unix socket accept loop wrapped in `tokio::task::spawn_blocking`
   - WebSocket accept loop in `tokio::spawn` (only if `--ws-port` provided)
   - Both tasks joined with `tokio::try_join!`

### Phase 4: TypeScript WebSocket Client

**New file:** `packages/rfdb/ts/websocket-client.ts`
- `RFDBWebSocketClient extends BaseRFDBClient`
- Constructor takes URL (e.g., "ws://localhost:7474")
- `connect()`: Creates WebSocket with `binaryType = 'arraybuffer'`, handles open/error/close/message events
- `_send()`: Encodes to MessagePack binary, sends via WebSocket (NO length prefix)
- `_handleMessage()`: Decodes MessagePack from ArrayBuffer, matches requestId, resolves promise
- Request timeout with configurable duration (default 60s)
- `hello()` override forces protocol v2 (no streaming for WebSocket MVP)
- `close()`: Closes WebSocket with code 1000
- `socketPath` property returns URL to satisfy IRFDBClient interface

### Phase 5: VS Code Extension Configuration

**Modified file:** `packages/vscode/package.json`
- Added `grafema.rfdbTransport`: enum ["unix", "websocket"], default "unix"
- Added `grafema.rfdbWebSocketUrl`: string, default "ws://localhost:7474"

**Modified file:** `packages/vscode/src/grafemaClient.ts`
- Imported `RFDBWebSocketClient` from `@grafema/rfdb-client`
- Updated `client` type to `RFDBClient | RFDBWebSocketClient | null`
- Updated `getClient()` return type
- Updated `withReconnect()` parameter type
- `connect()` checks `grafema.rfdbTransport` config:
  - "websocket": Creates `RFDBWebSocketClient`, connects, pings, no auto-start
  - "unix": Existing logic unchanged (auto-start server if needed)

## Design Decisions

1. **No streaming for WebSocket MVP:** WebSocket client always uses protocol v2. Streaming (NodesChunk) is deferred to REG-524.

2. **spawn_blocking for handle_request:** Prevents blocking the Tokio runtime when handle_request does disk I/O (flush). Session is moved into/out of the blocking task via Option pattern.

3. **60-second send timeout:** Protects against slow/stalled WebSocket clients that stop reading. Connection is dropped after timeout.

4. **Fallback error on serialization failure:** If the main response can't be serialized, a minimal Error response is sent so the client's promise doesn't hang forever.

5. **Port 0 rejected:** No random port assignment for WebSocket (confusing UX, client needs to know port upfront).

6. **Localhost-only binding:** WebSocket binds to `127.0.0.1` only. External access requires SSH tunnel.

## Test Results

- **TypeScript:** 2109 pass, 0 fail, 5 skipped, 22 todo
- **Rust lib:** 614 pass, 0 fail
- **Rust protocol:** 60 pass, 0 fail
- **Rust crash recovery:** 9 pass, 0 fail
- **Build:** Clean (all packages, Rust + TypeScript + VS Code)

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `packages/rfdb/ts/base-client.ts` | NEW | ~570 |
| `packages/rfdb/ts/websocket-client.ts` | NEW | ~170 |
| `packages/rfdb/ts/client.ts` | MODIFIED | Reduced from 1367 to ~350 (methods moved to base) |
| `packages/rfdb/ts/index.ts` | MODIFIED | +2 exports |
| `packages/rfdb-server/Cargo.toml` | MODIFIED | +3 lines (dependencies) |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | MODIFIED | +~160 lines (handler + main refactor) |
| `packages/vscode/package.json` | MODIFIED | +14 lines (config properties) |
| `packages/vscode/src/grafemaClient.ts` | MODIFIED | +~30 lines (WebSocket connect path) |

## Follow-up Tasks

- **REG-524:** WebSocket streaming support (NodesChunk over WebSocket)
- **REG-525:** WebSocket configuration/limits (max-connections, idle-timeout)
- **REG-526:** WebSocket security (bind-addr, allow-origin, TLS)
- **Tech debt:** Split rfdb_server.rs into modules (4833+ lines)
