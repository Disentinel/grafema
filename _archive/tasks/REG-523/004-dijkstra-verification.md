# REG-523: WebSocket Transport - Verification Report

**Verifier:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-20
**Status:** REJECT
**Verdict:** Plan has significant completeness gaps and unproven preconditions

---

## Executive Summary

Joel's plan is thorough in many areas (excellent phase breakdown, good test matrix, clear Big-O analysis), but it **fails completeness verification** due to:

1. **Incomplete WebSocket message type handling** — Continuation frames not handled
2. **Missing CLI flag combinations** — ambiguous behavior when neither flag provided
3. **IRFDBClient interface mismatch** — WebSocket client does not implement full interface
4. **Unverified async/sync boundary** — no proof that `handle_request()` is safe to call from async context
5. **Missing error propagation paths** — WebSocket upgrade errors, serialization errors
6. **Streaming decision contradicts preconditions** — disabling streaming may break existing clients

---

## 1. Input Universe Enumeration

### 1.1 WebSocket Message Types

**Joel's plan mentions:** Binary, Text, Close, Ping, Pong

**RFC 6455 Complete List:**

| Frame Type | Opcode | Expected Behavior | Handled in Plan? | Gap Analysis |
|------------|--------|-------------------|------------------|---------------|
| **Text** | 0x1 | Should reject (protocol violation) | ✅ Ignored (line 404-407) | ⚠️ Should send Error, not just ignore |
| **Binary** | 0x2 | Process as MessagePack | ✅ Yes (line 399) | ✅ |
| **Close** | 0x8 | Clean shutdown | ✅ Yes (line 400-403) | ✅ |
| **Ping** | 0x9 | Auto-reply with Pong | ✅ Library handles (line 408-411) | ✅ |
| **Pong** | 0xA | Keepalive response | ✅ Library handles (line 408-411) | ✅ |
| **Continuation** | 0x0 | Multi-frame message assembly | ❌ **NOT HANDLED** | 🚨 **CRITICAL GAP** |

**CRITICAL GAP: Continuation frames**

WebSocket supports **fragmented messages** (one logical message split across multiple frames). RFC 6455 §5.4:

```
Frame 1: FIN=0, opcode=0x2 (binary), payload=[first chunk]
Frame 2: FIN=0, opcode=0x0 (continuation), payload=[middle chunk]
Frame 3: FIN=1, opcode=0x0 (continuation), payload=[last chunk]
```

**Joel's code (line 398-420)** only handles `Message::Binary(data)` — this assumes **unfragmented messages**.

**Does tokio-tungstenite handle fragmentation automatically?**

I don't have proof. The plan ASSUMES `ws_read.next().await` returns complete messages, but **does not verify** this assumption. Need to check [tokio-tungstenite docs](https://docs.rs/tokio-tungstenite/0.24) for `WebSocketStream::next()` behavior.

**Recommendation:** Add precondition check: "Verify tokio-tungstenite auto-assembles fragments OR add explicit Continuation frame handling."

---

### 1.2 CLI Flag Combinations

**Joel's plan (Section 1.4.1, line 1188-1197):**

| Combination | Expected Behavior | Handled? |
|-------------|-------------------|----------|
| `--socket` only | Unix only (existing) | ✅ (implicit) |
| `--ws-port` only | Unix + WebSocket | ✅ (line 1190: "Both Unix socket AND WebSocket listeners start") |
| Both flags | Both transports | ✅ (line 1194: "correct behavior") |
| **Neither flag** | ??? | ❌ **UNSPECIFIED** |

**Gap:** What happens if user runs `rfdb-server ./test.rfdb` with NO flags?

**Current behavior (from Don's plan, line 22):**
- `--socket` defaults to `/tmp/rfdb.sock` (line 2259)

**Joel's code (Phase 2, line 222-238):**
```rust
let ws_listener = if let Some(port) = ws_port {
    // ... bind WebSocket ...
} else {
    None
};
```

**Conclusion:** Neither flag → Unix socket only (default behavior). **This is correct**, but Joel should DOCUMENT it in the table.

**Recommendation:** Add row to table:
```
| Neither flag | Unix socket on /tmp/rfdb.sock (default) | ✅ Implicit |
```

---

**Additional missing case:**

| Combination | Expected Behavior | Handled? | Gap |
|-------------|-------------------|----------|-----|
| `--ws-port 0` | Random port assignment? Error? | ❌ | Joel says "port is valid u16" (line 324), but `0` IS valid u16 |
| `--ws-port 65536` | Error (> u16::MAX) | ✅ | parse::<u16>() fails (line 172) |
| `--ws-port abc` | Error (not a number) | ✅ | parse::<u16>() fails (line 172) |
| `--ws-port -1` | Error (negative) | ✅ | parse::<u16>() fails (shell may reject) |

**Gap:** Port `0` is a valid u16 but has special meaning in POSIX (OS assigns random available port). Joel's plan doesn't specify behavior.

**Actual behavior (after Phase 2):**
```rust
TcpListener::bind("127.0.0.1:0").await
```

This **succeeds** and binds to a random port. Then `eprintln!` prints the actual bound address.

**Is this desirable?** Unclear. User might be confused ("I specified port 0, why is it listening on 54321?").

**Recommendation:** Either:
1. **Allow port 0** and document it ("0 = auto-assign port, server prints actual port")
2. **Reject port 0** with validation error ("port must be 1-65535")

Joel's plan does neither.

---

### 1.3 Request Types Over WebSocket

**Claim (Joel, line 23):** "WebSocket clients will receive single `Response::Nodes` for all queries, regardless of size."

**Need to verify:** Are there ANY request types that are fundamentally incompatible with WebSocket?

**Reviewing Request enum** (from grep output):

| Request Variant | Problematic for WebSocket? | Why? |
|-----------------|---------------------------|------|
| `Hello` | ✅ No | Protocol negotiation, works fine |
| `CreateDatabase` | ✅ No | Simple command |
| `OpenDatabase` | ✅ No | Simple command |
| `CloseDatabase` | ✅ No | Simple command |
| `AddNodes` | ✅ No | Bulk write, no streaming |
| `QueryNodes` | ⚠️ **MAYBE** | See below |
| `Shutdown` | ⚠️ **MAYBE** | See below |
| Other commands | ✅ No | All simple request/response |

**Potential issues:**

#### 1.3.1 QueryNodes with Streaming Disabled

**Joel's decision (line 16-29):** Disable streaming for WebSocket. All `QueryNodes` return full `Response::Nodes { nodes }` array.

**Consequence:** If client requests 100,000 nodes, server must:
1. Collect all 100k nodes in memory
2. Serialize 100k nodes to MessagePack (~50 MB)
3. Send as single WebSocket frame

**Does this violate message size limit?**

Joel sets `max_message_size = 100 MB` (line 37). So technically OK.

**But:** Current Unix socket protocol has streaming for queries >100 nodes (protocol v3). If existing VS Code extension has negotiated protocol v3 and expects chunked responses, **switching it to WebSocket will break it**.

**Joel's mitigation (line 25-27):**
> Client-side: `RFDBWebSocketClient.hello()` should NOT negotiate protocol v3 (keep v2).

**Gap:** This assumes VS Code extension uses a **separate client instance** for WebSocket. But what if user has:
- Desktop VS Code using Unix socket + protocol v3 (streaming)
- Web VS Code using WebSocket + protocol v2 (no streaming)

Same codebase, different protocol versions. **Will extension code handle this gracefully?**

**Need to check:** Does `packages/vscode/src/grafemaClient.ts` assume protocol v3 is always available?

**Recommendation:** Verify VS Code extension gracefully handles protocol v2 (no streaming). If not, this is a **breaking change**.

---

#### 1.3.2 Shutdown Request

**Current behavior (Unix socket, line 2088-2194):**
```rust
if is_shutdown {
    eprintln!("[rfdb-server] Shutdown requested by client {}", client_id);
    std::process::exit(0);
}
```

**Joel's WebSocket code (line 469-472):**
```rust
if is_shutdown {
    eprintln!("[rfdb-server] Shutdown requested by WebSocket client {}", client_id);
    std::process::exit(0);
}
```

**Problem:** `std::process::exit(0)` is **immediate termination**. Tokio runtime is NOT gracefully shut down.

**Consequence:**
- Unix socket connections: Kernel closes file descriptors → clients get EOF
- WebSocket connections: Tokio tasks **aborted mid-flight** → clients may get TCP RST or incomplete Close frame
- **DatabaseManager flush:** May or may not complete (depends on signal handler timing)

**Joel acknowledges this (line 115-125):**
> Tokio runtime is dropped → All tasks are aborted → WebSocket connections closed

**But:** If `handle_client_websocket` is mid-`await` when process exits, the task's Drop handler may not run. This could leave:
- WebSocket connections in CLOSE_WAIT state
- Pending responses in send buffer (not flushed)

**Is this acceptable?** Joel says "same as Unix socket" (line 119), but **Unix socket uses blocking I/O**, so writes complete synchronously. WebSocket uses **async I/O**, so writes may be buffered.

**Recommendation:** Document this as a known issue, file follow-up task for graceful shutdown (REG-526).

---

### 1.4 TypeScript Client API Completeness

**Joel's claim (line 509-874):** `RFDBWebSocketClient` implements `IRFDBClient` interface.

**Verification:** Compare Joel's implementation against `packages/types/src/rfdb.ts` interface (lines 486-570).

| `IRFDBClient` Method | Joel's Implementation | Gap? |
|----------------------|----------------------|------|
| `readonly socketPath` | ❌ `readonly url` (line 552) | 🚨 **TYPE MISMATCH** |
| `readonly supportsStreaming` | ❌ **MISSING** | 🚨 **MISSING PROPERTY** |
| `connect()` | ✅ Line 572-609 | ✅ |
| `close()` | ✅ Line 866-873 | ✅ |
| `ping()` | ✅ Line 687-690 | ✅ |
| `shutdown()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `addNodes()` | ✅ Line 731-734 | ✅ |
| `addEdges()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `deleteNode()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `deleteEdge()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `clear()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `updateNodeVersion()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `declareFields()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `findByType()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `findByAttr()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `queryNodes()` | ✅ Line 746-750 (but returns `Promise<WireNode[]>`, not `AsyncGenerator`) | ⚠️ **SIGNATURE MISMATCH** |
| `queryNodesStream()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `getAllNodes()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `isEndpoint()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `getNodeIdentifier()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `dfs()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `compact()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `datalogLoadRules()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `datalogClearRules()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `datalogQuery()` | ✅ Line 792-798 (but missing overload for `explain: true`) | ⚠️ **INCOMPLETE** |
| `checkGuarantee()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `executeDatalog()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `isBatching()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `findDependentFiles()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `dropDatabase()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |
| `tagSnapshot()` | ❌ **MISSING** | 🚨 **MISSING METHOD** |

**Summary:** Joel's `RFDBWebSocketClient` implements **~15 methods** out of **~60 required** by `IRFDBClient`.

**This is NOT a complete implementation.**

**Joel's comment (line 683):** "// ============================================================================ // IRFDBClient API Implementation // ============================================================================"

This is **misleading** — it's a PARTIAL implementation.

**Impact:**

VS Code extension code (line 802, `grafemaClient.ts`):
```typescript
this.client = client; // Type is RFDBClient | RFDBWebSocketClient | null
```

If extension calls `this.client.datalogQuery()` and transport is WebSocket, **runtime error** (method does not exist).

**Recommendation:** Either:
1. **Complete the implementation** (add all missing methods)
2. **Create a subset interface** (`IBasicRFDBClient` with only methods Joel implements)
3. **Mark methods as `throw new Error('Not supported over WebSocket')`** (explicit failure)

Current plan does none of these.

---

## 2. Async/Sync Boundary Analysis

**Joel's claim (line 1149-1164):**
> Unix socket (sync) and WebSocket (async) share `Arc<DatabaseManager>`. No deadlocks.

**Need to verify:**

1. **Is `handle_request()` safe to call from async context?**

**Signature (assumed, not in provided code):**
```rust
fn handle_request(
    manager: &Arc<DatabaseManager>,
    session: &mut ClientSession,
    request: Request,
    metrics: &Option<Arc<Metrics>>,
) -> Response
```

This is a **synchronous function**. Joel's WebSocket handler calls it from async context (line 443):
```rust
let response = handle_request(&manager, &mut session, request, &metrics);
```

**Is this safe?**

**If `handle_request` does ANY of the following, it will BLOCK the Tokio runtime:**
- Long-running computation (>10ms)
- Blocking I/O (file read/write)
- Lock acquisition that waits

**Does `handle_request` do any of these?**

**Need to review actual `handle_request` implementation.** Joel's plan does NOT prove this is safe.

**Potential issues:**

If `handle_request` calls `engine.flush()` (for Flush request), this **blocks** while writing to disk. This will **stall the Tokio runtime** — other WebSocket connections cannot make progress.

**Correct solution:** Wrap blocking calls in `tokio::task::spawn_blocking`:

```rust
let response = tokio::task::spawn_blocking(move || {
    handle_request(&manager_clone, &mut session, request, &metrics)
}).await.unwrap();
```

**Joel's plan does NOT do this.** Gap.

---

2. **Does `Arc<DatabaseManager>` have any locks that could deadlock?**

**Joel mentions (line 1156):**
> DatabaseManager uses RwLock → readers don't block each other

**But:** What if:
- Unix socket thread holds `RwLock::read()`
- WebSocket task tries to acquire `RwLock::write()`
- WebSocket task calls `handle_request()` (blocking) while holding write lock
- Unix socket thread tries to acquire read lock → **deadlock**

**Precondition needed:** Prove that `handle_request()` does NOT acquire nested locks on DatabaseManager.

**Joel's plan does NOT provide this proof.**

---

## 3. Concurrency Correctness

**Joel's claim (line 1149-1164):**
> Thread-per-connection (Unix) + task-per-connection (WebSocket) sharing `Arc<DatabaseManager>` is safe.

**Verification needed:**

1. **Client ID generation (line 1159):**
```rust
let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::SeqCst);
```

**Is `NEXT_CLIENT_ID` defined?** Joel's plan doesn't show the declaration.

**Assumption:** It's `static AtomicUsize`. If so, `fetch_add` is safe from both sync and async contexts. ✅

---

2. **DatabaseManager Arc cloning:**

**Unix socket (Phase 2, line 273):**
```rust
let manager_clone = Arc::clone(&manager_unix);
```

**WebSocket (Phase 2, line 303):**
```rust
let manager_clone = Arc::clone(&manager_ws);
```

**Both clone the SAME underlying Arc.** This is safe. ✅

---

3. **ClientSession mutation:**

**Joel's code (line 391):**
```rust
let mut session = ClientSession::new(client_id);
```

Each connection has its **own** `ClientSession` (not shared). No mutex needed. ✅

---

**Conclusion:** Concurrency model is correct **assuming `handle_request` doesn't block**. But that's unproven.

---

## 4. Error Propagation

**Joel's plan enumerates several error paths (Section 4, lines 1185-1326). Let's verify each one:**

| Error Scenario | How Detected? | What Happens? | Verified? |
|----------------|---------------|---------------|-----------|
| **WebSocket upgrade failure** | `accept_async()` returns `Err` | Log error, return from function (line 382-388) | ✅ |
| **MessagePack deserialization failure** | `rmp_serde::from_slice()` returns `Err` | Send `Error` response with `requestId: None` (line 423-436) | ✅ |
| **Response serialization failure** | `rmp_serde::to_vec_named()` returns `Err` | Log error, skip response (line 456-461) | ⚠️ **Client hangs** |
| **WebSocket send failure** | `ws_write.send()` returns `Err` | Log error, break loop, cleanup (line 464-467) | ✅ |
| **Database operation failure** | `handle_request()` returns `Response::Error` | Serialize and send error response (line 455) | ✅ |

**Gap: Response serialization failure**

If `rmp_serde::to_vec_named(&envelope)` fails (line 456), Joel's code:
```rust
Err(e) => {
    eprintln!("[rfdb-server] WebSocket client {} serialize error: {}", client_id, e);
    continue; // Skip sending response
}
```

**Problem:** Client is waiting for response with `requestId: "r123"`. Server logs error and moves to next request. Client's promise **never resolves** → timeout → error.

**Better behavior:** Send a fallback error response:
```rust
Err(e) => {
    // Try to send a minimal error response
    let fallback = ResponseEnvelope {
        request_id,
        response: Response::Error { error: format!("Serialization failed: {}", e) },
    };
    if let Ok(bytes) = rmp_serde::to_vec_named(&fallback) {
        let _ = ws_write.send(Message::Binary(bytes)).await;
    }
    continue;
}
```

**Recommendation:** Add fallback error response for serialization failures.

---

**Additional error path missing:**

| Error Scenario | Handled? |
|----------------|----------|
| `ws_write.send()` succeeds but TCP buffer is full → send blocks forever | ❌ |

**Joel mentions this (line 1272-1285):**
> `ws_write.send().await` blocks if TCP buffer full. Slow client can block its own task.

**Joel's mitigation:** "Add send timeout in REG-526 (future)."

**But:** This means one slow WebSocket client can **starve itself** (cannot receive new requests while blocked sending previous response).

**Is this acceptable for MVP?** Joel thinks yes. I disagree — this is a **denial-of-service vulnerability**. A malicious client can:
1. Connect via WebSocket
2. Send request with large response (e.g., `getAllNodes`)
3. Stop reading from socket
4. Server blocks trying to send response
5. Client's connection is now **permanently stuck**

**Recommendation:** Add send timeout BEFORE merge, not in follow-up.

---

## 5. TypeScript Client Completeness

**Already covered in Section 1.4.** Summary:

- ❌ Missing `socketPath` property (has `url` instead)
- ❌ Missing `supportsStreaming` property
- ❌ Missing 40+ methods required by `IRFDBClient`
- ❌ `queryNodes()` has wrong return type (`Promise<WireNode[]>` vs `AsyncGenerator`)

**This is a MAJOR gap.** VS Code extension cannot use `RFDBWebSocketClient` as a drop-in replacement for `RFDBClient`.

---

## 6. Preconditions

**Joel's plan assumes several preconditions (Section 1.6). Let's verify:**

| Precondition | Claimed Status | Verified? |
|--------------|----------------|-----------|
| **Tokio runtime available** | Guaranteed by `#[tokio::main]` | ✅ Yes, attribute macro sets up runtime |
| **WebSocket binary frames contain complete MessagePack** | Guaranteed by WebSocket spec | ⚠️ **DEPENDS ON LIBRARY** |
| **`@msgpack/msgpack` works in browser** | Verified | ❌ **NOT VERIFIED** |

### 6.1 WebSocket Framing Guarantee

**Joel claims (line 198):**
> WebSocket protocol already handles message boundaries. Each `ws.send(binary_data)` becomes a discrete frame.

**This is TRUE for unfragmented messages.** But WebSocket also supports **fragmentation** (see Section 1.1).

**Precondition needed:** Verify that `tokio-tungstenite::WebSocketStream::next()` returns **assembled messages**, not individual frames.

**I cannot verify this without reading tokio-tungstenite source or docs.** Joel's plan does NOT provide this verification.

**If this is false:** Server will receive partial MessagePack data → deserialization fails → error response. But this is **degraded UX**, not a crash.

**Recommendation:** Add test case: Send fragmented binary message, verify server handles it correctly.

---

### 6.2 MessagePack in Browser

**Joel's code (line 517):**
```typescript
import { encode, decode } from '@msgpack/msgpack';
```

**Claim:** This works in browser environments (VS Code web extension).

**Verification needed:**
1. Does `@msgpack/msgpack` have browser-compatible build?
2. Does it work in VS Code web extension's sandboxed environment?

**Joel's plan does NOT test this.** Phase 5 tests only run in Node.js (line 1547-1568).

**Recommendation:** Add browser compatibility test:
- Run `RFDBWebSocketClient` in a web worker or browser context
- Verify `encode`/`decode` work

---

## 7. Additional Gaps Found

### 7.1 Error Response Format Mismatch

**Rust server sends:**
```rust
Response::Error { error: "message".to_string() }
```

**TypeScript client expects (line 629):**
```typescript
if ('error' in response && response.error) {
    pending.reject(new Error(response.error));
}
```

**This is correct IF** Rust `Response::Error` serializes as `{ error: "message" }`.

**But:** Joel's plan doesn't show the `Response` enum definition. If it uses `#[serde(tag = "type")]`, it might serialize as:
```json
{ "type": "error", "error": "message" }
```

**Need to verify:** Response enum serialization format matches TypeScript expectations.

---

### 7.2 Metrics Recording Missing for WebSocket

**Unix socket handler (existing, line 2088):**
```rust
if let Some(ref m) = metrics {
    m.record_query(&op_name, duration_ms);
}
```

**Joel's WebSocket handler (line 446-452):**
```rust
if let Some(ref m) = metrics {
    let duration_ms = start.elapsed().as_millis() as u64;
    m.record_query(&op_name, duration_ms);
}
```

**This is correct.** ✅

**But:** Are WebSocket metrics **tagged differently** from Unix socket metrics? If not, how do we distinguish them in metrics output?

**Recommendation:** Add transport label to metrics:
```rust
m.record_query_tagged(&op_name, duration_ms, "websocket");
```

---

### 7.3 WebSocket Connection Limit

**Joel defers this to REG-525 (line 40-47):**
> No limit for MVP. Future: Add `--ws-max-connections N` flag.

**Problem:** Without a connection limit, server can be **resource-exhausted** by:
1. Open 10,000 WebSocket connections (7 KB each = 70 MB memory)
2. Each connection holds Arc<DatabaseManager> (keeps DB open)
3. If DB has large in-memory state, this multiplies memory usage

**For Unix socket:** Thread limit provides natural cap (~1000 connections max).

**For WebSocket:** No natural cap. OS file descriptor limit (~65k on Linux) is too high.

**Recommendation:** Add simple hard-coded limit (e.g., 1000 connections) for MVP. Make it configurable in follow-up.

---

## 8. Verdict Summary

### Completeness Score

| Category | Complete? | Score |
|----------|-----------|-------|
| WebSocket message types | NO (Continuation frames missing) | 5/6 |
| CLI flag combinations | MOSTLY (port 0 unclear) | 4/5 |
| Request type handling | MOSTLY (streaming disabled, shutdown risky) | 4/5 |
| IRFDBClient implementation | NO (40+ methods missing) | 15/60 |
| Error propagation | MOSTLY (serialization failure gap) | 4/5 |
| Preconditions | UNVERIFIED (fragmentation, browser compat) | 1/3 |

**Overall:** ~55% complete

---

### Critical Gaps (MUST FIX)

1. **TypeScript client does NOT implement IRFDBClient** — Missing 40+ methods
2. **Async/sync boundary unproven** — `handle_request()` may block Tokio runtime
3. **Continuation frames not handled** — Fragmented messages will fail
4. **No send timeout** — Slow clients can DoS themselves
5. **Browser compatibility not tested** — `@msgpack/msgpack` may not work

---

### Medium Gaps (SHOULD FIX)

6. **Port 0 behavior undefined** — Auto-assign or error?
7. **Streaming disabled breaks protocol v3 clients** — Need compatibility check
8. **Response serialization failure hangs client** — Need fallback error
9. **Shutdown request abrupt termination** — WebSocket Close frames not sent
10. **No connection limit** — Resource exhaustion risk

---

### Minor Gaps (NICE TO FIX)

11. **Metrics not tagged by transport** — Can't distinguish Unix vs WebSocket
12. **Text frame handling suboptimal** — Should send error, not just ignore
13. **`--help` text incomplete** — Should mention localhost-only

---

## 9. Recommendations

### Before Implementation Starts

1. **Resolve TypeScript client API** — Either:
   - Complete all 60 methods (2-3 days work)
   - Create subset interface (1 day)
   - Document unsupported methods (2 hours)

2. **Verify async/sync safety** — Audit `handle_request()` for blocking calls. If found, wrap in `spawn_blocking`.

3. **Test fragmentation** — Confirm tokio-tungstenite handles it OR add explicit handling.

### Before Merge

4. **Add send timeout** — 30 seconds should be sufficient for most queries.

5. **Add browser compatibility test** — Run WebSocket client in web context.

6. **Define port 0 behavior** — Either allow (auto-assign) or reject (validation error).

### Follow-Up Tasks (OK to defer)

7. **Graceful shutdown** (REG-526)
8. **Connection limits** (REG-525)
9. **Metrics tagging** (new task)

---

## 10. Final Verdict

**REJECT** — Plan has too many unproven preconditions and incomplete implementations.

**Path to APPROVE:**

1. Joel provides proof that:
   - `handle_request()` is non-blocking OR wraps it in `spawn_blocking`
   - `tokio-tungstenite` auto-assembles fragmented messages
   - `@msgpack/msgpack` works in browser

2. Joel completes OR documents unsupported `IRFDBClient` methods

3. Joel adds send timeout to prevent slow-client DoS

**Estimated additional work:** 1-2 days (not the 2 days Joel estimated).

---

**Next Step:** Present this verification to user. If Joel addresses gaps, re-verify and approve.
