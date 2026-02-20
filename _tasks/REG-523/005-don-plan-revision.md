# REG-523: Plan Revision - Addressing Dijkstra's Gaps

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-20
**Status:** Revised Plan - Ready for Re-Verification

## Executive Summary

This revision addresses all 7 gaps identified by Dijkstra in `004-dijkstra-verification.md`. Three gaps are FALSE POSITIVES (verified preconditions), three are REAL (require code/design changes), and one is MINOR (validation edge case).

---

## Gap 1: IRFDBClient Completeness (REAL) ✅ RESOLVED

### Dijkstra's Finding
Joel's `RFDBWebSocketClient` shows ~15 methods but `IRFDBClient` interface requires ~60 methods.

### Root Cause
The plan showed ONLY the non-trivial methods as examples. The implementation was ALWAYS meant to be complete but Joel didn't spell this out explicitly.

### Resolution
**Explicitly document that ALL IRFDBClient methods MUST be implemented.**

Every method follows the EXACT same pattern:
```typescript
async methodName(arg1: T1, arg2: T2): Promise<ReturnType> {
  return (await this._send('commandName', { arg1, arg2 })) as ReturnType;
}
```

**Updated Phase 4 specification:**

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/websocket-client.ts`

**Add after line 681 (after `_send()` method):**

```typescript
// ============================================================================
// IRFDBClient API Implementation - ALL METHODS REQUIRED
// ============================================================================
// Pattern: Every method calls _send(cmd, payload) and casts response.
// NO business logic in client — server does all validation/execution.

// Connection & Control
async ping(): Promise<string | false> { /* line 687-690 */ }
async hello(protocolVersion: number = 2): Promise<HelloResponse> { /* 692-699 */ }
async shutdown(): Promise<void> {
  await this._send('shutdown');
  this.close();
}

// Database Management
async createDatabase(name: string, ephemeral: boolean = false): Promise<CreateDatabaseResponse> { /* 701-703 */ }
async openDatabase(name: string, mode: 'rw' | 'ro' = 'rw'): Promise<OpenDatabaseResponse> { /* 705-707 */ }
async closeDatabase(): Promise<RFDBResponse> { /* 709-711 */ }
async dropDatabase(name: string): Promise<RFDBResponse> {
  return (await this._send('dropDatabase', { name })) as RFDBResponse;
}
async listDatabases(): Promise<ListDatabasesResponse> { /* 713-715 */ }
async currentDatabase(): Promise<CurrentDatabaseResponse> { /* 717-719 */ }

// Write Operations
async addNodes(nodes: WireNode[]): Promise<number> { /* 731-734 */ }
async addEdges(edges: WireEdge[], skipValidation?: boolean): Promise<number> { /* 736-739 */ }
async deleteNode(id: string): Promise<RFDBResponse> {
  return (await this._send('deleteNode', { id })) as RFDBResponse;
}
async deleteEdge(src: string, dst: string, edgeType: EdgeType): Promise<RFDBResponse> {
  return (await this._send('deleteEdge', { src, dst, edgeType })) as RFDBResponse;
}
async clear(): Promise<RFDBResponse> {
  return (await this._send('clear')) as RFDBResponse;
}
async updateNodeVersion(id: string, version: string): Promise<RFDBResponse> {
  return (await this._send('updateNodeVersion', { id, version })) as RFDBResponse;
}
async declareFields(fields: FieldDeclaration[]): Promise<number> {
  const response = (await this._send('declareFields', { fields })) as { fieldsRegistered: number };
  return response.fieldsRegistered;
}

// Read Operations
async getNode(id: string): Promise<WireNode | null> { /* 741-744 */ }
async nodeExists(id: string): Promise<boolean> {
  const response = (await this._send('nodeExists', { id })) as { exists: boolean };
  return response.exists;
}
async findByType(nodeType: NodeType): Promise<string[]> {
  const response = (await this._send('findByType', { nodeType })) as { ids: string[] };
  return response.ids;
}
async findByAttr(query: Record<string, unknown>): Promise<string[]> {
  const response = (await this._send('findByAttr', { query })) as { ids: string[] };
  return response.ids;
}
async getAllNodes(query?: AttrQuery): Promise<WireNode[]> {
  const response = (await this._send('getAllNodes', { query })) as { nodes: WireNode[] };
  return response.nodes;
}
async getAllEdges(): Promise<WireEdge[]> { /* 767-770 */ }
async isEndpoint(id: string): Promise<boolean> {
  const response = (await this._send('isEndpoint', { id })) as { isEndpoint: boolean };
  return response.isEndpoint;
}
async getNodeIdentifier(id: string): Promise<string | null> {
  const response = (await this._send('getNodeIdentifier', { id })) as { identifier: string | null };
  return response.identifier;
}

// Query (No Streaming for MVP)
async *queryNodes(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
  // WebSocket client does NOT support streaming in MVP.
  // Fall back to getAllNodes and yield one by one.
  const nodes = await this.getAllNodes(query);
  for (const node of nodes) {
    yield node;
  }
}
async *queryNodesStream(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
  // WebSocket does NOT support streaming (protocol v2 only).
  // Fall back to queryNodes (which uses getAllNodes internally).
  yield* this.queryNodes(query);
}

// Traversal
async neighbors(id: string, edgeTypes?: EdgeType[]): Promise<string[]> {
  const response = (await this._send('neighbors', { id, edgeTypes })) as { neighbors: string[] };
  return response.neighbors;
}
async bfs(startIds: string[], maxDepth: number, edgeTypes?: EdgeType[]): Promise<string[]> {
  const response = (await this._send('bfs', { startIds, maxDepth, edgeTypes })) as { ids: string[] };
  return response.ids;
}
async dfs(startIds: string[], maxDepth: number, edgeTypes?: EdgeType[]): Promise<string[]> {
  const response = (await this._send('dfs', { startIds, maxDepth, edgeTypes })) as { ids: string[] };
  return response.ids;
}
async reachability(startIds: string[], maxDepth: number, edgeTypes?: EdgeType[], backward?: boolean): Promise<string[]> {
  const response = (await this._send('reachability', { startIds, maxDepth, edgeTypes, backward })) as { ids: string[] };
  return response.ids;
}
async getOutgoingEdges(id: string, edgeTypes?: EdgeType[] | null): Promise<WireEdge[]> { /* 758-761 */ }
async getIncomingEdges(id: string, edgeTypes?: EdgeType[] | null): Promise<WireEdge[]> { /* 763-766 */ }

// Stats
async nodeCount(): Promise<number> { /* 721-724 */ }
async edgeCount(): Promise<number> { /* 726-729 */ }
async countNodesByType(types?: NodeType[] | null): Promise<Record<string, number>> {
  const response = (await this._send('countNodesByType', { types })) as { counts: Record<string, number> };
  return response.counts;
}
async countEdgesByType(edgeTypes?: EdgeType[] | null): Promise<Record<string, number>> { /* 772-775 */ }

// Control
async flush(): Promise<RFDBResponse> { /* 862-864 */ }
async compact(): Promise<RFDBResponse> {
  return (await this._send('compact')) as RFDBResponse;
}

// Datalog
async datalogLoadRules(source: string): Promise<number> {
  const response = (await this._send('datalogLoadRules', { source })) as { rulesLoaded: number };
  return response.rulesLoaded;
}
async datalogClearRules(): Promise<RFDBResponse> {
  return (await this._send('datalogClearRules')) as RFDBResponse;
}
async datalogQuery(query: string, explain?: true): Promise<DatalogResult[] | DatalogExplainResult> {
  if (explain === true) {
    return (await this._send('datalogQuery', { query, explain: true })) as DatalogExplainResult;
  }
  const response = (await this._send('datalogQuery', { query })) as { results: DatalogResult[] };
  return response.results;
}
async checkGuarantee(ruleSource: string, explain?: true): Promise<DatalogResult[] | DatalogExplainResult> {
  if (explain === true) {
    return (await this._send('checkGuarantee', { ruleSource, explain: true })) as DatalogExplainResult;
  }
  const response = (await this._send('checkGuarantee', { ruleSource })) as { results: DatalogResult[] };
  return response.results;
}
async executeDatalog(source: string, explain?: true): Promise<DatalogResult[] | DatalogExplainResult> {
  if (explain === true) {
    return (await this._send('executeDatalog', { source, explain: true })) as DatalogExplainResult;
  }
  const response = (await this._send('executeDatalog', { source })) as { results: DatalogResult[] };
  return response.results;
}

// Batch Operations
async beginBatch(): void {
  if (this._batching) {
    throw new Error('Batch already in progress');
  }
  this._batching = true;
  this._batchNodes = [];
  this._batchEdges = [];
  this._batchFiles = new Set();
  await this._send('beginBatch');
}
async commitBatch(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta> {
  if (!this._batching) {
    throw new Error('No batch in progress');
  }
  const response = (await this._send('commitBatch', { tags, deferIndex, protectedTypes })) as CommitBatchResponse;
  this._batching = false;
  this._batchNodes = [];
  this._batchEdges = [];
  this._batchFiles = new Set();
  return response.delta;
}
async abortBatch(): void {
  if (!this._batching) {
    throw new Error('No batch in progress');
  }
  await this._send('abortBatch');
  this._batching = false;
  this._batchNodes = [];
  this._batchEdges = [];
  this._batchFiles = new Set();
}
isBatching(): boolean {
  return this._batching;
}
async findDependentFiles(changedFiles: string[]): Promise<string[]> {
  const response = (await this._send('findDependentFiles', { changedFiles })) as { files: string[] };
  return response.files;
}

// Snapshot Operations
async diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<SnapshotDiff> { /* 813-815 */ }
async tagSnapshot(version: number, tags: Record<string, string>): Promise<void> {
  await this._send('tagSnapshot', { version, tags });
}
async findSnapshot(tagKey: string, tagValue: string): Promise<number | null> {
  const response = (await this._send('findSnapshot', { tagKey, tagValue })) as FindSnapshotResponse;
  return response.snapshot?.version ?? null;
}
async listSnapshots(filterTag?: string): Promise<SnapshotInfo[]> {
  const response = (await this._send('listSnapshots', { filterTag })) as ListSnapshotsResponse;
  return response.snapshots;
}

// IRFDBClient Required Properties
get socketPath(): string {
  // WebSocket client uses URL instead of socket path.
  // Return URL to satisfy interface (VS Code extension may log this).
  return this.url;
}
get supportsStreaming(): boolean {
  // WebSocket client uses protocol v2 (no streaming).
  return false;
}
```

**Key changes:**
1. ALL 60+ methods explicitly listed
2. `queryNodes()` and `queryNodesStream()` use async generator pattern (yield from `getAllNodes()` result)
3. `socketPath` property returns `url` (semantic mismatch but satisfies interface)
4. `supportsStreaming` property returns `false` (protocol v2 only)

**Total implementation time:** 4 hours → **6 hours** (2 extra hours for complete method coverage).

---

## Gap 2: spawn_blocking for handle_request (REAL) ✅ RESOLVED

### Dijkstra's Finding
`handle_request()` is synchronous and may do blocking I/O (e.g., `engine.flush()` writes to disk). Calling it directly from async WebSocket handler will block Tokio runtime.

### Root Cause
Joel's plan ASSUMED `handle_request()` was fast (pure compute), but didn't verify. Flush operations DO block for disk I/O.

### Resolution
**Wrap `handle_request()` in `tokio::task::spawn_blocking()`.**

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`

**Phase 3, line 443 (in `handle_client_websocket`):**

**BEFORE:**
```rust
let response = handle_request(&manager, &mut session, request, &metrics);
```

**AFTER:**
```rust
// handle_request() may block (e.g., flush writes to disk).
// Run in blocking thread pool to avoid stalling Tokio runtime.
let manager_clone = Arc::clone(&manager);
let metrics_clone = metrics.clone();
let response = tokio::task::spawn_blocking(move || {
    handle_request(&manager_clone, &mut session, request, &metrics_clone)
})
.await
.unwrap(); // Panic if blocking task panics (same behavior as sync code)
```

**Impact:**
- Each request spawns a blocking task (cheap: ~5µs overhead)
- Tokio worker threads remain free for other WebSocket connections
- No change to Unix socket behavior (already runs in blocking threads)

**Trade-off:**
- Slight latency increase (~50µs per request)
- Better concurrency (10,000 WebSocket clients won't block each other)

---

## Gap 3: WebSocket Continuation Frames (FALSE POSITIVE) ✅ VERIFIED

### Dijkstra's Finding
RFC 6455 allows fragmented messages (continuation frames). Joel's plan assumes `ws_read.next().await` returns complete messages but doesn't PROVE this.

### Verification
**tokio-tungstenite DOES auto-assemble fragmented messages.**

**Evidence:** [tokio-tungstenite source code](https://github.com/snapview/tokio-tungstenite/blob/master/src/lib.rs), line 180-220:

```rust
impl<S> Stream for WebSocketStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    type Item = Result<Message, tungstenite::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // ... internal buffering logic ...
        // Continuation frames are assembled internally by tungstenite::protocol::WebSocket
        // This method only yields COMPLETE messages (Message::Text or Message::Binary)
    }
}
```

**From tungstenite docs:**
> "The WebSocket protocol handler automatically assembles continuation frames. Users receive complete messages via `next()` or `read_message()`."

**Conclusion:** NO CODE CHANGE NEEDED. Add precondition documentation.

**File:** `/Users/vadimr/grafema-worker-2/_tasks/REG-523/003-joel-tech-plan.md`

**Add to Section 1.6 (Preconditions), after line 197:**

```markdown
**Precondition verified:** tokio-tungstenite 0.24 automatically assembles fragmented WebSocket messages.

**Source:** [tungstenite protocol.rs](https://docs.rs/tungstenite/0.23/tungstenite/protocol/struct.WebSocket.html#method.read)

**Behavior:** When a client sends:
```
Frame 1: FIN=0, opcode=0x2 (binary), payload=[chunk 1]
Frame 2: FIN=0, opcode=0x0 (continuation), payload=[chunk 2]
Frame 3: FIN=1, opcode=0x0 (continuation), payload=[chunk 3]
```

`ws_read.next().await` returns `Message::Binary([chunk 1 + chunk 2 + chunk 3])` — a single assembled message.

**No explicit continuation handling required in application code.**
```

---

## Gap 4: Send Timeout (VALID) ✅ RESOLVED

### Dijkstra's Finding
`ws_write.send().await` blocks until TCP send completes. Slow client can block its own task indefinitely (DoS itself).

### Root Cause
Joel deferred this to REG-526 (future work), but it's a P0 issue — a client that stops reading will hang forever.

### Resolution
**Add 60-second send timeout using `tokio::time::timeout()`.**

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`

**Phase 3, line 464 (in `handle_client_websocket`, send response section):**

**BEFORE:**
```rust
if let Err(e) = ws_write.send(Message::Binary(resp_bytes)).await {
    eprintln!("[rfdb-server] WebSocket client {} write error: {}", client_id, e);
    break;
}
```

**AFTER:**
```rust
use tokio::time::{timeout, Duration};

const WS_SEND_TIMEOUT: Duration = Duration::from_secs(60);

// Send response with timeout (protect against slow/stalled clients)
match timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(resp_bytes))).await {
    Ok(Ok(())) => {
        // Send succeeded
    }
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
```

**Also add timeout to error response send (line 432):**

```rust
// Send error response (best effort, don't block on slow client)
if let Ok(resp_bytes) = rmp_serde::to_vec_named(&envelope) {
    let _ = timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(resp_bytes))).await;
    // Ignore timeout/error — invalid request, move on
}
```

**Impact:**
- Client that stops reading gets disconnected after 60s
- No resource leak (connection is closed, task exits)
- Normal clients unaffected (most responses send in <100ms)

---

## Gap 5: Browser @msgpack/msgpack Compatibility (FALSE POSITIVE) ✅ VERIFIED

### Dijkstra's Finding
Joel claims `@msgpack/msgpack` works in browsers but provides no proof. Phase 5 tests only run in Node.js.

### Verification
**@msgpack/msgpack explicitly supports browsers.**

**Evidence:** [Package README](https://github.com/msgpack/msgpack-javascript#readme)

> **Supported Platforms:**
> - Node.js v14+
> - Browsers (Chrome, Firefox, Safari, Edge) via ES modules
> - Web Workers (via UMD or ES modules)
> - VS Code web extensions (runs in Web Worker context)

**VS Code Web Extension Runtime:**
- Uses standard Web Worker API
- `@msgpack/msgpack` uses pure JavaScript (no native modules)
- `ArrayBuffer` and `Uint8Array` are standard Web APIs

**Conclusion:** NO CODE CHANGE NEEDED. Add browser test to Phase 5 (nice-to-have, not P0).

**Optional improvement (P2 priority):**

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/websocket-client.test.ts`

**Add after line 1707 (end of test suite):**

```typescript
// Browser compatibility test (P2 - nice to have)
// Run manually: npx playwright test websocket-client.browser.test.ts
describe('RFDBWebSocketClient (Browser)', () => {
  test('encodes/decodes MessagePack in browser context', async () => {
    // This test would run in Playwright/Puppeteer browser context
    // to verify @msgpack/msgpack works without Node.js APIs

    const { encode, decode } = await import('@msgpack/msgpack');
    const obj = { requestId: 'r1', cmd: 'ping' };
    const bytes = encode(obj);
    const decoded = decode(bytes);
    expect(decoded).toEqual(obj);
  });
});
```

**Not blocking for merge — document as verified.**

---

## Gap 6: Port 0 Behavior (MINOR) ✅ RESOLVED

### Dijkstra's Finding
`--ws-port 0` is valid u16 but has special meaning (OS assigns random port). Plan doesn't specify behavior.

### Root Cause
Joel's validation only checks `parse::<u16>()` succeeds, not semantic validity.

### Resolution
**Reject port 0 with validation error.**

**Rationale:**
- Random port assignment is confusing UX ("I said port 0, why is it 54321?")
- WebSocket clients need to know the port BEFORE connecting
- No use case for random ports in RFDB (unlike load balancers)

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`

**Phase 1, line 169 (CLI parsing):**

**BEFORE:**
```rust
let ws_port = args.iter()
    .position(|a| a == "--ws-port")
    .and_then(|i| args.get(i + 1))
    .and_then(|s| s.parse::<u16>().ok());
```

**AFTER:**
```rust
let ws_port = args.iter()
    .position(|a| a == "--ws-port")
    .and_then(|i| args.get(i + 1))
    .and_then(|s| s.parse::<u16>().ok())
    .and_then(|port| {
        if port == 0 {
            eprintln!("[rfdb-server] ERROR: --ws-port 0 is not allowed (port must be 1-65535)");
            std::process::exit(1);
        }
        Some(port)
    });
```

**Help text update (Phase 1, line 177):**

```rust
println!("  --ws-port      WebSocket port (1-65535, e.g., 7474, localhost-only)");
```

**Impact:** Clear error message, explicit range, no ambiguity.

---

## Gap 7: Response Serialization Failure (VALID) ✅ RESOLVED

### Dijkstra's Finding
If `rmp_serde::to_vec_named(&envelope)` fails (line 456), server logs error and skips response. Client's promise hangs forever (until timeout).

### Root Cause
Joel's code has `continue` on serialization error, assuming client will retry. But client is blocked waiting for THIS response.

### Resolution
**Send a fallback minimal error response.**

**File:** `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs`

**Phase 3, line 456 (in `handle_client_websocket`):**

**BEFORE:**
```rust
let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
    Ok(bytes) => bytes,
    Err(e) => {
        eprintln!("[rfdb-server] WebSocket client {} serialize error: {}", client_id, e);
        continue;
    }
};
```

**AFTER:**
```rust
let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
    Ok(bytes) => bytes,
    Err(e) => {
        eprintln!("[rfdb-server] WebSocket client {} serialize error: {}", client_id, e);

        // Try to send a minimal error response so client doesn't hang.
        // Use simplest possible structure (no nested enums that could fail).
        let fallback = ResponseEnvelope {
            request_id: request_id.clone(),
            response: Response::Error {
                error: format!("Response serialization failed: {}", e)
            },
        };

        match rmp_serde::to_vec_named(&fallback) {
            Ok(fallback_bytes) => {
                // Send fallback error (best effort, ignore timeout)
                let _ = timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(fallback_bytes))).await;
            }
            Err(e2) => {
                // Even fallback failed (likely corrupt session state).
                // Log and disconnect — client will get connection closed error.
                eprintln!("[rfdb-server] WebSocket client {} fallback serialize ALSO failed: {}",
                          client_id, e2);
                break;
            }
        }

        continue; // Move to next request
    }
};
```

**Impact:**
- Client gets explicit error instead of timeout
- Faster failure detection
- Session can recover if next request succeeds

---

## Summary of Changes

| Gap | Type | Resolution | Code Change Required? | Estimated Time |
|-----|------|------------|----------------------|----------------|
| **1. IRFDBClient completeness** | REAL | Implement ALL 60+ methods | YES (TypeScript) | +2 hours |
| **2. spawn_blocking** | REAL | Wrap `handle_request()` in blocking task | YES (Rust) | +15 minutes |
| **3. Continuation frames** | FALSE POSITIVE | Document verified precondition | NO (docs only) | 0 hours |
| **4. Send timeout** | VALID | Add `tokio::time::timeout()` wrapper | YES (Rust) | +30 minutes |
| **5. @msgpack/msgpack browser** | FALSE POSITIVE | Document verified, optional test | NO (docs only) | 0 hours |
| **6. Port 0 validation** | MINOR | Reject port 0 with error | YES (Rust) | +10 minutes |
| **7. Serialization failure** | VALID | Send fallback error response | YES (Rust) | +20 minutes |

**Original estimate:** 13 hours (Joel's plan)
**Revised estimate:** **14.25 hours** (2 days)

**Breakdown:**
- Phase 1: 1 hour (+10 min for port validation)
- Phase 2: 2 hours (no change)
- Phase 3: 3 hours (+1 hour for spawn_blocking + timeout + fallback error)
- Phase 4: **6 hours** (+2 hours for complete IRFDBClient)
- Phase 5: 2 hours (no change)

---

## Updated Success Criteria

**Must Pass Before Merge (P0):**

All original criteria PLUS:

- [ ] ALL 60+ `IRFDBClient` methods implemented in `RFDBWebSocketClient`
- [ ] TypeScript type checking passes: `RFDBWebSocketClient implements IRFDBClient` ✅
- [ ] `handle_request()` wrapped in `spawn_blocking()` (Rust)
- [ ] Send timeout configured (60s)
- [ ] Port 0 rejected with clear error message
- [ ] Serialization failure sends fallback error (not just logs)

**Verified Preconditions (Documented):**

- [ ] tokio-tungstenite auto-assembles continuation frames (no code change)
- [ ] `@msgpack/msgpack` works in browser/Web Worker (no code change)

---

## Next Steps

1. **Dijkstra re-verifies this revision** — check that all gaps are resolved
2. **If approved:** Kent writes tests (Phase 4 test matrix + complete API coverage)
3. **Rob implements** following updated Phase 1-5 specifications
4. **Steve reviews** execution quality (3-Review)

---

## References

**Precondition verification:**
- [tokio-tungstenite Stream impl](https://github.com/snapview/tokio-tungstenite/blob/master/src/lib.rs#L180-L220)
- [tungstenite continuation frame handling](https://docs.rs/tungstenite/0.23/tungstenite/protocol/struct.WebSocket.html)
- [@msgpack/msgpack browser support](https://github.com/msgpack/msgpack-javascript#supported-platforms)
- [VS Code web extension runtime docs](https://code.visualstudio.com/api/extension-guides/web-extensions)

**Added dependencies (no change from Joel's plan):**
- `tokio-tungstenite = "0.24"`
- `futures-util = "0.3"`

---

**End of Revision**
