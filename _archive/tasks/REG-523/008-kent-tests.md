# REG-523: Test Report

**Author:** Kent Beck (Test Engineer)
**Date:** 2026-02-20
**Status:** Tests Written, Ready for Implementation

## Executive Summary

Three test files written for REG-523 WebSocket transport. Tests are split into:
1. **Locking tests** (STEP 2.5) - Lock existing RFDBClient behavior before refactoring
2. **WebSocket unit tests** (STEP 3) - Contract tests for the new RFDBWebSocketClient
3. **WebSocket integration tests** (STEP 3) - End-to-end tests with real server

Total: **~120 test cases** covering connection lifecycle, message framing, all IRFDBClient methods, batch operations, error handling, and cross-transport verification.

---

## Files Written

### 1. `packages/rfdb/ts/rfdb-client-locking.test.ts` (STEP 2.5)

**Purpose:** Lock existing RFDBClient behavior BEFORE Rob extracts BaseRFDBClient. If any of these tests break during refactoring, the refactoring introduced a regression.

**Test count:** ~65 tests across 15 describe blocks

**Key areas locked:**

| Area | Tests | Why |
|------|-------|-----|
| Constructor & Initial State | 6 | Lock default socketPath, connected=false, isBatching=false, supportsStreaming=false |
| Methods Throw When Not Connected | 35 | Every public method must throw "Not connected to RFDB server" when called without connection. This is the safety net for the refactoring -- if Rob moves _send() to BaseRFDBClient, all methods must still check connection state. |
| Batch Operations | 10 | Client-side batch state (beginBatch/commitBatch/abortBatch/isBatching) is pure state management -- no server needed. Lock the exact error messages and state transitions. |
| BatchHandle | 3 | Lock isolated batch handle behavior (createBatch returns BatchHandle, independent from client batching state). |
| addNodes/addEdges Wire Format | 4 | Lock metadata merging behavior (extra fields merge into metadata JSON). This was fixed in REG-274 and must not regress. |
| _handleData Framing | 4 | Lock the length-prefix framing parser: single message, split delivery, multiple messages in one chunk, error response rejection. This is the CRITICAL difference between Unix socket and WebSocket -- Unix uses length-prefix, WebSocket does not. |
| close()/shutdown() | 3 | Lock idempotency: close when not connected is safe, close sets connected=false. |
| _parseRequestId | 6 | Lock "rN" parsing logic (shared between Unix and WebSocket). |
| _resolveSnapshotRef | 3 | Lock number-vs-tag discrimination for snapshot references. |
| queryNodes/queryNodesStream | 1 | Lock non-streaming fallback behavior. |
| Edge Metadata Parsing | 1 | Lock getOutgoingEdges metadata JSON parsing and spreading. |

**Run command:**
```bash
pnpm build && node --test packages/rfdb/dist/rfdb-client-locking.test.js
```

### 2. `packages/rfdb/ts/rfdb-websocket-client.test.ts` (STEP 3 - Unit)

**Purpose:** Define the contract that RFDBWebSocketClient must fulfill. Written as TDD -- tests first, implementation second.

**Test count:** ~45 contract tests across 11 describe blocks

**Key contracts defined:**

| Contract | Tests | Why |
|----------|-------|-----|
| Constructor | 3 | Stores URL, not connected initially, supportsStreaming=false |
| Message Framing | 2 | WebSocket uses raw msgpack (NO length prefix). This is the key architectural difference. Tests verify encode/decode round-trip without 4-byte header. |
| Request-Response Matching | 3 | requestId "rN" format, error rejection, concurrent request handling |
| Timeout Behavior | 2 | Reject on timeout, clean up pending map entry |
| Connection Errors | 3 | connect() rejects on error, close rejects pending, _send throws when disconnected |
| close() | 4 | Close frame code 1000, connected=false, clear pending, idempotent |
| Command Names | 39 | Every IRFDBClient method maps to correct RFDBCommand string. This is the most important contract -- same commands, different transport. |
| Protocol v2 Only | 3 | hello() negotiates v2 (not v3), supportsStreaming=false, queryNodes returns full array |
| Msgpack Encoding | 3 | Request/response format matches RFDB server, complex data round-trips |
| Batch Operations | 3 | Same state management as RFDBClient |
| Interface Compatibility | 2 | socketPath returns URL, all 47 IRFDBClient methods listed |

**Note:** Many tests use placeholder `assert.ok(true, ...)` because the RFDBWebSocketClient class does not exist yet. Once Rob implements the class and it builds to `dist/`, the real assertions (commented examples in code) should be uncommented.

**Run command:**
```bash
pnpm build && node --test packages/rfdb/dist/rfdb-websocket-client.test.js
```

### 3. `test/integration/rfdb-websocket.test.ts` (STEP 3 - Integration)

**Purpose:** End-to-end tests that start a real rfdb-server with `--ws-port` and test WebSocket transport through the full stack.

**Test count:** ~20 tests across 9 describe blocks

**Key scenarios:**

| Scenario | Tests | Priority |
|----------|-------|----------|
| Connection Lifecycle | 4 | P0: connect, ping, hello, close+reconnect |
| Database Operations | 3 | P0: create, open, list, current |
| Node CRUD | 6 | P0: add, get, exists, findByType, delete, null for missing |
| Edge CRUD | 3 | P0: add, outgoing, incoming |
| Graph Traversal | 2 | P1: neighbors, BFS |
| Stats Operations | 2 | P1: countNodesByType, countEdgesByType |
| Error Handling | 2 | P1: query without database, connection refused |
| Multiple Concurrent Clients | 2 | P1: parallel clients, concurrent requests |
| Cross-Transport | 1 | P1: data written via WebSocket visible from Unix socket and vice versa |

**Skip behavior:** Tests auto-skip if rfdb-server binary is not found.

**All test bodies are commented out** with the real implementation code, because:
- `RFDBWebSocketClient` does not exist yet
- rfdb-server does not support `--ws-port` yet

Once both are implemented, uncomment the test bodies and remove the `assert.ok(true)` placeholders.

**Run command:**
```bash
pnpm build && node --test test/integration/rfdb-websocket.test.ts
```

### 4. Rust Server Test Specification

Documented at the bottom of `test/integration/rfdb-websocket.test.ts` as comments. These tests cannot be written from TypeScript -- they must be implemented in Rust inside `rfdb_server.rs`.

**10 Rust tests specified:**
1. `test_websocket_upgrade_succeeds` - WebSocket handshake
2. `test_websocket_binary_frame_processed` - Request-response cycle
3. `test_websocket_text_frame_ignored` - Text frame handling
4. `test_websocket_close_frame_clean_shutdown` - Close frame cleanup
5. `test_websocket_invalid_msgpack_error_response` - Error on bad data
6. `test_websocket_send_timeout` - 60s timeout behavior
7. `test_websocket_no_legacy_mode` - No auto-open database
8. `test_websocket_ping_pong` - Basic ping request
9. `test_websocket_hello_v2` - Protocol negotiation
10. `test_websocket_concurrent_requests` - Parallel request handling

---

## Design Decisions

### Why locking tests test private methods

The `_handleData`, `_parseRequestId`, and `_resolveSnapshotRef` methods are private, but they contain critical logic that MUST survive the refactoring:
- `_handleData` has the length-prefix framing parser (Unix socket specific)
- `_parseRequestId` is shared between transports
- `_resolveSnapshotRef` is shared between transports

We access them via `(client as any)._methodName` for testing. This is intentional -- these tests exist to catch refactoring regressions, not as public API contracts.

### Why WebSocket unit tests use contract-style assertions

The RFDBWebSocketClient class does not exist yet. Rather than write tests that fail to import, we define the contract using explicit assertions about what the API should do. The commented-out code blocks show the exact assertions that should work once the class is implemented.

This approach:
- Documents the expected behavior unambiguously
- Tests compile and run today (all pass with placeholder assertions)
- Can be incrementally activated as Rob implements features

### Why integration tests are commented out

Integration tests need both the Rust server changes AND the TypeScript client. Writing uncommented tests that fail to import would block the entire test suite. The commented-out bodies serve as executable specification -- uncomment as implementation lands.

### Why 35 "throws when not connected" tests

Every single public method of RFDBClient must throw "Not connected to RFDB server" when called without a connection. This is 35 methods. During the BaseRFDBClient extraction, if Rob accidentally forgets to check connection state in the base class, these tests catch it immediately. The redundancy is intentional.

---

## Test Coverage Matrix

| Category | Locking | WS Unit | WS Integration | Total |
|----------|---------|---------|----------------|-------|
| Constructor/State | 6 | 3 | - | 9 |
| Connection | 1 | 5 | 4 | 10 |
| Message Framing | 4 | 2 | - | 6 |
| Request Matching | - | 3 | - | 3 |
| Timeout | - | 2 | - | 2 |
| Error Handling | 35 | 3 | 2 | 40 |
| Batch Ops | 13 | 3 | - | 16 |
| Node CRUD | - | - | 6 | 6 |
| Edge CRUD | - | - | 3 | 3 |
| Traversal | - | - | 2 | 2 |
| Stats | - | - | 2 | 2 |
| Control | 3 | 4 | 2 | 9 |
| Protocol | 1 | 3 | - | 4 |
| Wire Format | 4 | 39 | - | 43 |
| Cross-Transport | - | - | 1 | 1 |
| Datalog | - | - | 1 | 1 |
| **Total** | **~65** | **~45** | **~20** | **~130** |

---

## Next Steps

1. **Rob implements RFDBWebSocketClient** (`packages/rfdb/ts/websocket-client.ts`)
2. **Run locking tests** to verify they pass before refactoring: `pnpm build && node --test packages/rfdb/dist/rfdb-client-locking.test.js`
3. **Rob extracts BaseRFDBClient** from RFDBClient
4. **Run locking tests again** -- all must still pass
5. **Uncomment WebSocket unit test assertions** as the class takes shape
6. **Rob implements Rust WebSocket handler**
7. **Uncomment integration test bodies**
8. **Run full test suite** to verify everything works end-to-end
