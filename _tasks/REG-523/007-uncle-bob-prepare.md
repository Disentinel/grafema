# Uncle Bob PREPARE Review: REG-523 WebSocket Transport

Review Date: 2026-02-20
Reviewer: Robert Martin (Uncle Bob)

## Summary

Reviewed 5 files that will be modified for WebSocket transport implementation. Found CRITICAL file size violations requiring immediate action before implementation begins.

---

## File 1: packages/rfdb-server/src/bin/rfdb_server.rs

**File size:** 4833 lines — **CRITICAL: MUST SPLIT**

**Verdict:** This file is 9.7x over the 500-line hard limit. It's a God Object containing the entire server: protocol handlers, database management, client session management, main function, and tests.

### File-level Issues

1. **Massive SRP violation**: Single file contains:
   - Request/Response protocol types (lines 1-400)
   - Database manager (400-800)
   - Client session management (800-1200)
   - Command handlers (1200-2000)
   - Connection handling (2000-2200)
   - Main function (2200-2347)
   - Tests (2347-4833)

2. **Minimum split required**:
   - `protocol.rs` — Request/Response types
   - `database_manager.rs` — DatabaseManager
   - `session.rs` — ClientSession
   - `handlers.rs` — handle_request and command handlers
   - `connection.rs` — handle_client, read_message, write_message
   - `main.rs` — main() only
   - Tests should move to separate test files

### Methods to Modify (for WebSocket task)

These are the specific areas that will be touched by REG-523:

**read_message() (lines 2055-2077)** — 23 lines
- Currently reads from UnixStream
- Will need to abstract to trait or be duplicated for WebSocket
- **Recommendation:** Extract transport abstraction BEFORE adding WebSocket

**write_message() (lines 2079-2086)** — 8 lines
- Currently writes to UnixStream
- Will need to abstract to trait or be duplicated for WebSocket
- **Recommendation:** Extract transport abstraction BEFORE adding WebSocket

**handle_client() (lines 2088-2194)** — 107 lines
- **VIOLATES 50-LINE GUIDELINE** (2.1x over)
- Currently takes UnixStream directly
- Contains: session init, message loop, deserialization, request handling, response serialization
- **Recommendation:** REFACTOR BEFORE modification
  - Extract: `initialize_session()`
  - Extract: `process_message_loop()`
  - Extract: `handle_message_error()`
  - Target: Reduce to ~30 lines

**main() (lines 2200-2347)** — 147 lines
- **VIOLATES 50-LINE GUIDELINE** (2.9x over)
- Contains: arg parsing, help text, validation, server setup, signal handlers, accept loop
- **Recommendation:** REFACTOR BEFORE modification
  - Extract: `parse_args() -> ServerConfig`
  - Extract: `setup_database_manager() -> Arc<DatabaseManager>`
  - Extract: `setup_signal_handlers()`
  - Extract: `run_server(config, manager, metrics)`
  - Target: Reduce to ~20 lines

### Scope Impact Analysis

**Time to split properly:** 3-4 hours (6 files + tests)
**Time to add WebSocket without split:** 2 hours
**Tech debt created by not splitting:** HIGH

**Recommendation:** Create tech debt issue for file split. This is >20% of task time, so NOT blocking for REG-523.

### Minimal Refactoring for REG-523

Since full file split is out of scope, perform MINIMAL method-level refactoring:

1. **handle_client() — MANDATORY**
   - Extract session init logic (5 lines)
   - Extract message processing (10 lines)
   - Reduces to 40 lines (acceptable for this task)

2. **main() — SKIP**
   - Only adding 2-3 lines for WebSocket listener
   - Refactoring main() is NOT directly related to WebSocket feature
   - Risk > benefit

**Risk after minimal refactoring:** MEDIUM
**Estimated scope:** ~60 lines modified in rfdb_server.rs

---

## File 2: packages/rfdb/ts/client.ts

**File size:** 1367 lines — **CRITICAL: MUST SPLIT**

**Verdict:** 2.7x over 500-line limit. Single class with 91 methods doing everything.

### File-level Issues

1. **God Class**: RFDBClient handles:
   - Unix socket connection management
   - Message framing
   - Request/response correlation
   - Batch operations
   - Streaming operations
   - Error handling
   - 60+ graph operation methods

2. **Minimum split required**:
   - `base-client.ts` — Abstract base with request/response logic
   - `socket-client.ts` — Unix socket implementation
   - `websocket-client.ts` — NEW WebSocket implementation
   - `batch-handle.ts` — Batch operation wrapper
   - `stream-queue.ts` — ALREADY separate (good!)

### Methods to Modify

**For REG-523: NONE directly**

The task is to CREATE a new file `websocket-client.ts`, not modify this file.

### Reuse Analysis

**Code that SHOULD be shared between socket-client.ts and websocket-client.ts:**

1. **Message correlation** (lines 338-394, ~56 lines):
   - `_send()` method
   - `pending` Map management
   - Request ID generation
   - This is IDENTICAL for both transports

2. **Streaming infrastructure** (lines 195-336, ~140 lines):
   - `_handleResponse()`
   - `_handleStreamingResponse()`
   - `_resetStreamTimer()`
   - `_cleanupStream()`
   - Streaming state management
   - This is IDENTICAL for both transports

3. **All 60+ graph operation methods** (lines 395-1300, ~900 lines):
   - `addNodes()`, `addEdges()`, `getNode()`, etc.
   - Every single method just calls `_send()`
   - This is IDENTICAL for both transports

**Code that DIFFERS between transports:**

1. **Connection setup** (~40 lines):
   - Unix socket: `createConnection(this.socketPath)`
   - WebSocket: `new WebSocket(this.wsUrl)`
   - Event handlers differ

2. **Message framing** (~30 lines):
   - Unix socket: 4-byte length prefix + msgpack
   - WebSocket: Native frames + msgpack (simpler)

### Recommendation: Extract Base Class FIRST

**CRITICAL:** Do NOT create websocket-client.ts as a copy-paste of client.ts.

**Proper approach:**

1. Extract `BaseRFDBClient` (abstract class):
   - All graph operation methods (60+ methods)
   - `_send()` abstract
   - `_handleResponse()` and streaming logic
   - Request correlation

2. Refactor existing client:
   ```
   class RFDBClient extends BaseRFDBClient {
     // Only connection + framing code
     async connect() { /* unix socket */ }
     protected _send() { /* unix socket framing */ }
   }
   ```

3. Create new WebSocket client:
   ```
   class RFDBWebSocketClient extends BaseRFDBClient {
     // Only connection + framing code
     async connect() { /* websocket */ }
     protected _send() { /* websocket framing */ }
   }
   ```

**Time to extract base class:** 2 hours
**Time to duplicate code:** 30 minutes
**Tech debt created by duplication:** CRITICAL (900+ lines duplicated, divergence guaranteed)

**Recommendation:** Base class extraction is MANDATORY for REG-523. Not optional.

**Risk:** LOW (after base class extraction)
**Estimated scope:**
- Extract base: ~100 lines moved, ~50 lines new
- WebSocket client: ~80 lines new
- Total: ~230 lines

---

## File 3: packages/rfdb/ts/index.ts

**File size:** 35 lines — **OK**

**Methods to modify:** None (just adding export)

**File-level:** Clean barrel export file.

**Change required:**
```typescript
export { RFDBWebSocketClient } from './websocket-client.js';
```

**Recommendation:** SKIP review
**Risk:** NONE
**Estimated scope:** 1 line

---

## File 4: packages/vscode/src/grafemaClient.ts

**File size:** 437 lines — **OK** (12% under limit)

**Methods to modify:**

**connect() (lines 90-119)** — 30 lines
- Currently tries Unix socket first, then starts server
- Will add WebSocket connection attempt
- **Recommendation:** Extract helper methods
  - `tryUnixSocket()` — existing logic
  - `tryWebSocket()` — new logic
  - `connect()` orchestrates with clear fallback chain
  - Target: Keep connect() at ~20 lines

**findServerBinary() (lines 152-221)** — 70 lines
- **VIOLATES 50-LINE GUIDELINE** (1.4x over)
- NOT modified by REG-523
- **Recommendation:** SKIP (out of scope)

**startServer() (lines 226-263)** — 38 lines
- May need WebSocket port argument
- Currently acceptable length
- **Recommendation:** SKIP refactoring

### VS Code Config Addition

**package.json** will add:
```json
"grafema.rfdbWebSocketPort": {
  "type": "number",
  "default": 0,
  "description": "WebSocket port (0 = disabled)"
}
```

**Recommendation:** Minor helper extraction in connect()
**Risk:** LOW
**Estimated scope:** ~40 lines modified

---

## File 5: packages/vscode/package.json

**File size:** 378 lines — **OK**

**Methods to modify:** None (JSON file)

**Change required:** Add config property (see above)

**Recommendation:** SKIP review
**Risk:** NONE
**Estimated scope:** 5 lines

---

## Overall Task Recommendations

### CRITICAL BLOCKERS (must address before implementation)

1. **Extract BaseRFDBClient from client.ts**
   - Status: MANDATORY
   - Time: 2 hours
   - Benefit: Prevents 900+ lines of duplication
   - Risk of skipping: CRITICAL tech debt

### RECOMMENDED REFACTORING (should do)

2. **Refactor handle_client() in rfdb_server.rs**
   - Status: RECOMMENDED
   - Time: 30 minutes
   - Benefit: Clearer separation for transport abstraction
   - Risk of skipping: MEDIUM (harder to add WebSocket cleanly)

3. **Extract helpers in grafemaClient.connect()**
   - Status: RECOMMENDED
   - Time: 15 minutes
   - Benefit: Clear fallback logic
   - Risk of skipping: LOW (just readability)

### TECH DEBT TO CREATE

4. **File split: rfdb_server.rs (4833 lines → 6 files)**
   - Create issue: REG-XXX
   - Estimated time: 3-4 hours
   - Priority: HIGH (blocks maintainability)

5. **File split: client.ts (1367 lines → 3 files)**
   - NOTE: Will be partially addressed by BaseRFDBClient extraction
   - Remaining split: batch operations, utilities
   - Create issue: REG-XXX
   - Estimated time: 1-2 hours
   - Priority: MEDIUM

---

## Final Scope Estimate

### Mandatory Work (for REG-523)

| Task | Lines | Time | Risk |
|------|-------|------|------|
| Extract BaseRFDBClient | ~150 | 2h | LOW |
| Create RFDBWebSocketClient | ~80 | 1h | LOW |
| Refactor handle_client() | ~60 | 30m | LOW |
| Add WebSocket handler to server | ~100 | 1.5h | MEDIUM |
| Update grafemaClient.connect() | ~40 | 30m | LOW |
| Config + exports | ~10 | 15m | NONE |

**Total:** ~440 lines, 5.5 hours

### Total Risk: LOW-MEDIUM

**Highest risk area:** Rust server WebSocket integration (concurrent access to DatabaseManager)

---

## Sign-off

Uncle Bob approves CONDITIONAL on:
1. BaseRFDBClient extraction BEFORE websocket-client.ts creation
2. handle_client() refactoring BEFORE WebSocket handler addition

If these conditions are met, code quality will remain acceptable despite file size violations.

Tech debt issues MUST be created for:
- REG-XXX: Split rfdb_server.rs into modules
- REG-XXX: Complete client.ts modularization

**Status:** READY TO PROCEED (with conditions)

---

**Uncle Bob**
Clean Code Guardian
