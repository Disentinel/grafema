# Don Melton — High-Level Plan for RFD-3: Client Request IDs

## Executive Summary

Add `requestId` field to RFDB wire protocol to enable request-response matching by ID instead of FIFO ordering. This is foundational work for future concurrent/multiplexed requests.

**Scope:** ~150 LOC TypeScript + ~30 LOC Rust. Small, well-defined change with clear validation criteria.

## Architecture Context

### Current State (FIFO Matching)

**TypeScript Client** (`packages/rfdb/ts/client.ts`):
- `pending: Map<number, PendingRequest>` — local numeric ID → promise handlers
- `reqId: number` — local counter (NOT sent over wire)
- `_send()` line 194: creates `{ cmd, ...payload }` — no requestId in wire
- `_handleResponse()` lines 159-174: **FIFO matching** — `this.pending.entries().next().value` takes oldest pending entry
- Per-request timeout with cleanup on timeout/error

**Rust Server** (`packages/rfdb-server/src/bin/rfdb_server.rs`):
- Request: `enum Request` with `#[serde(tag = "cmd")]` — no requestId field
- Response: `enum Response` with `#[serde(untagged)]` — no requestId field
- `handle_request()` lines 536-1025: pure function, no request state tracking
- `handle_client()` lines 1190-1273: simple loop: read → handle → write

**Wire Protocol:**
- Request: `{ cmd: string, ...payload }` (MessagePack, 4-byte BE length prefix)
- Response: `{ ok?: bool, error?: string, ...data }` (MessagePack)

**Key Insight:** Server is stateless per-request. It just deserializes, handles, serializes, writes. Echo pattern is trivial.

## Design Decisions

### 1. requestId Format: String `r${counter}`

**Rationale:**
- String format allows future extensions (e.g., `c1r42` for client-tagged IDs in multi-client scenarios)
- Numeric counter starts at 0, wraps safely (JavaScript numbers are safe up to 2^53)
- Prefix `r` makes IDs self-documenting in logs/debugging

**Alternative considered:** Numeric ID. Rejected — less flexible for future extensions.

### 2. pending Map: Keep Numeric Keys

**Current:** `Map<number, PendingRequest>`

**Decision:** Keep as-is. `reqId` (numeric counter) remains the Map key. `requestId` (string) is derived: `r${reqId}`.

**Rationale:**
- Numeric Map keys are more efficient than string keys
- No need to parse strings back to numbers
- Clean separation: numeric counter for internal bookkeeping, string for wire protocol

### 3. Backward Compatibility: FIFO Fallback

**Strategy:**
- If response has `requestId` → match by ID
- If response lacks `requestId` → FIFO matching (current behavior)

**Rationale:**
- Allows client to work with older v2 servers that don't echo requestId
- Zero-risk deployment: existing tests pass unchanged
- Graceful degradation: client gets benefit when server supports it, falls back otherwise

**Implementation detail:**
```typescript
private _handleResponse(response: RFDBResponse & { requestId?: string }): void {
  if (response.requestId) {
    // Match by ID
    const id = this._parseRequestId(response.requestId);
    if (!this.pending.has(id)) {
      this.emit('error', new Error(`Received response for unknown requestId: ${response.requestId}`));
      return;
    }
    const { resolve, reject } = this.pending.get(id)!;
    this.pending.delete(id);
    // ... resolve/reject
  } else {
    // FIFO fallback (current behavior)
    if (this.pending.size === 0) { ... }
    const [id, { resolve, reject }] = this.pending.entries().next().value;
    this.pending.delete(id);
    // ... resolve/reject
  }
}
```

### 4. Rust Server: Echo requestId if Present

**Change:** Add optional `request_id` field to Request enum and Response enum.

**Serde handling:**
- Request: `#[serde(default, rename = "requestId")] request_id: Option<String>`
- Response: Add `request_id` field to all response variants (or create wrapper)

**Strategy:** Use serde flatten to avoid touching all response constructors.

```rust
// Add to Request enum (at top level, outside tag/content):
#[serde(default, rename = "requestId", skip_serializing_if = "Option::is_none")]
request_id: Option<String>,

// Wrapper for responses:
#[derive(Serialize)]
struct ResponseEnvelope {
    #[serde(flatten)]
    response: Response,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}
```

**Alternative:** Add `request_id: Option<String>` to every Response variant. Rejected — too much boilerplate, error-prone.

**Better alternative:** Store requestId in local variable, wrap response at serialization point. Clean separation.

### 5. Types Update

**Location:** `packages/types/src/rfdb.ts`

**Changes:**
```typescript
export interface RFDBRequest {
  cmd: RFDBCommand;
  requestId?: string;  // NEW
  [key: string]: unknown;
}

export interface RFDBResponse {
  error?: string;
  requestId?: string;  // NEW
  [key: string]: unknown;
}
```

## Order of Implementation

**Principle:** Server-first, then client. This ensures we can test server echo behavior before client matching logic.

### Phase 1: Type Definitions (Foundation)
1. Update `packages/types/src/rfdb.ts`
   - Add optional `requestId?: string` to `RFDBRequest`
   - Add optional `requestId?: string` to `RFDBResponse`
   - No behavior change, pure type extension

### Phase 2: Rust Server (Echo)
2. Update `packages/rfdb-server/src/bin/rfdb_server.rs`
   - Extract requestId from Request (add field to enum)
   - Echo requestId in response (wrap at serialization point)
   - **Validation:** Manual test with `echo '{"cmd":"ping","requestId":"r42"}' | msgpack-cli` → verify response has `requestId: "r42"`

### Phase 3: TypeScript Client (Matching)
3. Update `packages/rfdb/ts/client.ts`
   - `_send()`: Add `requestId: \`r${id}\`` to request payload
   - `_handleResponse()`: Match by requestId if present, else FIFO
   - Add `_parseRequestId(requestId: string): number` helper
   - **Validation:** Existing tests pass (FIFO fallback), new tests for ID matching

### Phase 4: Tests
4. Add tests to `test/scenarios/rfdb-client.test.js`
   - Request ID echo: send with requestId → response has same requestId
   - FIFO fallback: mock old server (strip requestId from response) → verify FIFO works
   - Concurrent requests: 10 parallel sends → all matched correctly
   - Timeout with requestId: timeout only affects that specific request
   - **Validation:** All tests green

## Risk Areas & Mitigation

### Risk 1: Serde Complexity in Rust
**Risk:** Adding requestId to `#[serde(tag = "cmd")]` enum is tricky. Tagged enums expect all non-tag fields to be part of variant content.

**Mitigation:**
- Store requestId separately during deserialization
- Pass it through `handle_request()` as a parameter (or store in context struct)
- Wrap response at serialization point

**Fallback:** If serde complications arise, accept that we'll touch all response constructors. ~30 LOC becomes ~50 LOC, still manageable.

### Risk 2: ID Parsing Edge Cases
**Risk:** Client receives malformed requestId (not matching `r${number}` pattern).

**Mitigation:**
- `_parseRequestId()` validates format, returns null on parse failure
- If parse fails → emit error, treat as FIFO (graceful degradation)
- Log warning for debugging

**Code:**
```typescript
private _parseRequestId(requestId: string): number | null {
  if (!requestId.startsWith('r')) return null;
  const id = parseInt(requestId.slice(1), 10);
  return isNaN(id) ? null : id;
}
```

### Risk 3: Backward Compatibility Regression
**Risk:** FIFO fallback path breaks existing tests.

**Mitigation:**
- Implement FIFO path first (no changes)
- Add requestId matching as separate branch
- Run existing test suite (`test/scenarios/rfdb-client.test.js`) before adding new tests
- **Validation criterion:** "All existing client tests pass (FIFO mode)" explicitly listed in requirements

### Risk 4: Counter Wrap-Around
**Risk:** After 2^53 requests, counter wraps or becomes unsafe.

**Mitigation:**
- JavaScript numbers safe up to 2^53-1 (9 quadrillion)
- At 1M requests/sec, takes 285 years to wrap
- If wrap becomes real concern (long-lived connections in future), counter can reset on reconnect or use BigInt
- **Decision:** Not a concern for this phase. Document in code comment.

## Codebase-Specific Findings

### 1. Timeout Handling is Clean
Current timeout implementation (lines 200-204) works per-request:
```typescript
const timer = setTimeout(() => {
  this.pending.delete(id);  // Clean removal by numeric ID
  reject(new Error(...));
}, timeoutMs);
```

**Impact:** No changes needed. Timeout cleanup by numeric ID continues to work. When timeout fires, it deletes the Map entry; `_handleResponse()` will emit error if late response arrives (ID not found).

### 2. Error Handler Cleanup Pattern
Lines 207-212 attach per-request error handlers and clean them up on resolution.

**Impact:** No changes needed. Works with both FIFO and ID matching.

### 3. Connection Close Cleanup
Line 81-84: on disconnect, reject all pending requests.

**Impact:** No changes needed. Iterates over Map, rejects all. Works regardless of matching strategy.

### 4. Existing Test Coverage
`test/scenarios/rfdb-client.test.js` has basic integration tests (ping, addNodes, findByType, BFS).

**Observation:** No existing tests for concurrent requests or timeout edge cases. This is expected — current FIFO model doesn't support concurrency.

**Plan:** New tests will be the FIRST to exercise concurrent request scenarios.

## Success Criteria (from Requirements)

1. **Request ID echo** — ✅ Phase 2 (server) + Phase 4 (tests)
2. **FIFO fallback** — ✅ Phase 3 (client backward compat) + Phase 4 (tests)
3. **Concurrent requests** — ✅ Phase 4 (tests: 10 parallel sends)
4. **Timeout with requestId** — ✅ Phase 4 (tests: verify timeout only affects one request)
5. **All existing client tests pass** — ✅ Phase 3 validation + Phase 4 regression check

## What's NOT in Scope

This RFD is explicitly **foundation work**. NOT included:
- Concurrent request execution (no changes to server processing)
- Request pipelining or multiplexing (future work)
- Streaming responses (future work)
- Client-side request queue management (future work)

**After this RFD:** Wire protocol supports ID-based matching. This unblocks future work on concurrency.

## Summary

**Changes:**
1. Types: Add optional `requestId` to request/response interfaces
2. Rust server: Echo requestId if present (~30 LOC, mostly serde wrangling)
3. TypeScript client: Match by ID if present, else FIFO (~120 LOC including tests)
4. Tests: Validate echo, fallback, concurrency, timeout (~30 LOC)

**Risk Level:** Low. Backward compatible, incremental, well-tested.

**Key Insight:** This is additive work. Existing behavior (FIFO) remains untouched as fallback path. New behavior (ID matching) activates only when both client and server support it.

**Alignment with Vision:** Grafema's RFDB is moving toward high-performance, concurrent graph queries. Request IDs are the foundation. Without this, multiplexing is impossible. With this, we unlock streaming query responses, parallel requests, and better timeout granularity.

---

**Next Step:** Joel expands this into detailed technical spec with specific implementation steps.
