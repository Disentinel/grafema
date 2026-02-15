# RFD-13: Вадим Auto-Review

## Verdict: REJECT

## Reason

The plan introduces a critical correctness bug in the timeout mechanism and has several edge cases that aren't adequately handled. Memory unbounded buffering poses a real risk for production use.

---

## Critical Issues

### 1. Timeout Bug — Timer Never Cleared on Success

**File:** `packages/rfdb/ts/client.ts`, `queryNodesStream()` method (lines 783-811)

**Problem:**
```typescript
const timer = setTimeout(() => {
  this._pendingStreams.delete(id);
  this.pending.delete(id);
  streamQueue.fail(new Error(`RFDB queryNodesStream timed out after ${timeoutMs}ms`));
}, timeoutMs);

this.pending.set(id, {
  resolve: () => { clearTimeout(timer); },
  reject: (error) => {
    clearTimeout(timer);
    streamQueue.fail(error);
  },
});

// ... write to socket ...

try {
  for await (const node of streamQueue) {
    yield node;
  }
  clearTimeout(timer);  // <-- ONLY cleared AFTER all chunks consumed
} finally {
  clearTimeout(timer);  // <-- cleared on abort
  this._pendingStreams.delete(id);
  this.pending.delete(id);
}
```

**Issue:** The timer is only cleared when the ENTIRE stream completes (all chunks consumed). If streaming takes longer than 60 seconds (e.g., 50K nodes delivered slowly), the timeout fires WHILE THE STREAM IS STILL ACTIVE, causing:
1. `streamQueue.fail()` called mid-stream
2. Consumer gets error while iterating
3. Data corruption

**Expected behavior:** The timer should be cleared on FIRST chunk arrival (or on each chunk), not on stream completion.

**Fix:**
```typescript
this.pending.set(id, {
  resolve: () => { clearTimeout(timer); },  // called on first chunk
  reject: (error) => {
    clearTimeout(timer);
    streamQueue.fail(error);
  },
});
```

But `resolve()` is never called in `_handleResponse` for streaming chunks. The `pending` entry's `resolve` callback is designed for single-response requests.

**Root cause:** Streaming requests shouldn't use the `pending` map at all — it's designed for single-response Promise resolution. Using it for timeout tracking creates this bug.

**Correct architecture:**
- Store timeout handle separately (e.g., `Map<requestId, NodeJS.Timeout>`)
- Clear timer on FIRST chunk arrival
- Delete timer on stream end or error

---

### 2. Unbounded Memory Buffer — DoS Vector

**File:** `packages/rfdb/ts/stream-queue.ts`, `StreamQueue` class

**Problem:**
```typescript
push(item: T): void {
  if (this.done) return;
  if (this.waiters.length > 0) {
    const waiter = this.waiters.shift()!;
    waiter.resolve({ value: item, done: false });
  } else {
    this.queue.push(item);  // <-- UNBOUNDED
  }
}
```

**Risk:** If the consumer is slow (or stops consuming), the buffer grows without limit. For a 50K node result set, if the network delivers chunks faster than the consumer processes them, all 50K nodes accumulate in memory.

**Validation criteria not met:**
> Backpressure: slow consumer → server doesn't OOM

This handles "server doesn't OOM" (server chunks), but the CLIENT OOMs instead. The backpressure model fails.

**Mitigation options:**
1. **Bounded buffer** — Block `push()` when buffer reaches threshold (e.g., 2 chunks = 1000 nodes)
2. **Discard excess** — Drop oldest items (not applicable for database queries)
3. **Abort stream** — Fail stream if buffer exceeds threshold
4. **Application-level flow control** — Pause socket reading when buffer full

**What Joel says:**
> Bounded buffering / application-level flow control -- TCP backpressure suffices

**Reality check:** TCP backpressure only works if the consumer is reading from the socket. The StreamQueue decouples socket reading from application consumption. TCP sees the socket as "ready to read" because the event loop is processing frames, even if the application hasn't consumed them yet.

**Recommendation:** Either:
- Add bounded buffer (max 2-3 chunks = 1000-1500 nodes) + fail stream on overflow
- OR document this limitation clearly and accept OOM risk for V1

---

### 3. Validation Criteria — Not All Addressed

**Original validation:**
```
* Small result (<100) → non-streaming ✓
* Large result (>1000) → chunked ✓
* Backpressure: slow consumer → server doesn't OOM ✗ (client OOMs)
* Stream abort: client cancels → server stops ✗ (not tested)
* Streaming result = non-streaming result (equivalence) ✗ (not tested)
```

**Missing tests:**

#### Test: Stream Abort → Server Stops
Joel includes Test 18 (server Rust test):
> Test 18: Stream abort -- client disconnects mid-stream

But this tests that the server "doesn't crash". It does NOT verify that the server STOPS SENDING. The spec says:
> If write fails at any point: stop sending (implicit cancel)

**Question:** Does `write_message` actually fail when the client disconnects? Or does it buffer in the OS? If the latter, the server keeps chunking even after client abort.

**What's needed:** Server test that verifies the server stops iterating after client disconnect. This requires observing server behavior (e.g., log statements, metrics).

#### Test: Streaming = Non-Streaming Equivalence
No test validates that:
```typescript
const bulk = await client.queryNodes(query);
const streamed = [];
for await (const node of client.queryNodesStream(query)) {
  streamed.push(node);
}
assert.deepEqual(bulk.nodes, streamed);
```

This is a CRITICAL correctness property. Without it, we don't know if chunking introduces ordering issues, duplicates, or missing nodes.

**Recommendation:** Add integration test (requires server) that validates equivalence for various result sizes.

---

## Edge Cases — Gaps in Test Plan

### 4. Exactly 100 Nodes (Boundary)

**Threshold:** `STREAMING_THRESHOLD = 100`

**Expected:** Result with exactly 100 nodes → non-streaming (single `Nodes` response)

**Test 15:**
> Test 15: QueryNodes small result -- single Nodes response
>   - Add 50 nodes, QueryNodes

This tests 50 nodes, not 100. The boundary case (exactly 100) is not tested.

**Add:** Test with exactly 100 nodes, verify single response.

### 5. Exactly 101 Nodes (Just Over Threshold)

**Expected:** 101 nodes → streaming with 1 chunk (101 nodes, done=true)

**Not tested.**

**Add:** Test with 101 nodes, verify 1 chunk with done=true.

### 6. Empty Result Set

**Expected:** `ids.len() == 0` → what happens?

**Code path:**
```rust
if total <= STREAMING_THRESHOLD {
  let nodes: Vec<WireNode> = ids.into_iter()
    .filter_map(|id| engine.get_node(id))
    .map(|r| record_to_wire_node(&r))
    .collect();
  return HandleResult::Single(Response::Nodes { nodes });
}
```

**Result:** Empty result (0 nodes) → single `Nodes { nodes: [] }` response. Correct, but not tested.

**Add:** Test with query that matches 0 nodes.

### 7. Server Disconnects Mid-Stream

**Expected:** Client's `StreamQueue` should fail with "Connection closed".

**Covered by:** Client close handler (lines 700-713) calls `stream.fail(new Error('Connection closed'))`.

**Status:** Covered in code, but not explicitly tested.

**Add:** Integration test — start streaming, kill server mid-stream, verify client gets error.

### 8. Multiple Concurrent Streaming Requests

**Scenario:** Client sends 2 `queryNodesStream()` calls in parallel (different requestIds).

**Expected:** Both streams multiplex correctly (chunks routed by requestId).

**Code review:**
- `_pendingStreams` is a Map keyed by requestId → ✓
- `_handleResponse` routes by requestId → ✓
- No global state shared between streams → ✓

**Status:** Should work, but not tested.

**Add:** Integration test with concurrent streams.

### 9. queryNodesStream() Without hello() First

**Scenario:**
```typescript
const client = new RFDBClient(socket);
for await (const node of client.queryNodesStream({ nodeType: 'FUNCTION' })) { ... }
```

**Expected behavior:**
- `_supportsStreaming` defaults to false
- Falls back to `queryNodes()`
- Works correctly (assuming `queryNodes()` works without `hello()`)

**Code review:**
```typescript
if (!this._supportsStreaming) {
  yield* this.queryNodes(query);
  return;
}
```

**Status:** Correct fallback, but not tested.

**Question:** Does `queryNodes()` work before `hello()`? If not, this fails silently. Check existing client behavior.

### 10. Timer Behavior for Very Slow Streaming

**Scenario:** Streaming 200 nodes (2 chunks of 100 each), but server is extremely slow (30s between chunks).

**Expected:** Should NOT timeout if chunks keep arriving.

**Actual (per bug #1):** Times out after 60s total, even if chunks are arriving every 30s.

**Already covered by bug #1.** Fix that, and this works.

---

## Minimality Check

**Claimed:** ~575 LOC total

**Breakdown:**
- Types: 25 LOC → reasonable
- Server: 130 LOC → reasonable (chunking logic + HandleResult enum)
- StreamQueue: 80 LOC → could be smaller if we removed `Symbol.asyncIterator` (5 LOC), but fair
- Client: 100 LOC → reasonable for chunk routing + new method
- Tests: 240 LOC → reasonable for 18 tests

**Scope creep check:**
- No "while I'm here" changes → ✓
- No unrelated refactoring → ✓
- No feature additions beyond spec → ✓

**Verdict on minimality:** PASS. The LOC count is justified.

---

## Test Coverage — Gaps

**Total tests:** 18

**Coverage analysis:**

| Area | Tests | Gaps |
|------|-------|------|
| StreamQueue | 6 | None — comprehensive |
| Feature detection | 2 | Missing: hello() without "streaming" feature |
| Chunk routing | 3 | Missing: error responses in streaming mode |
| Fallback | 2 | Missing: fallback when server sends partial stream then single response (malformed) |
| Server Hello | 1 | OK |
| Server small result | 1 | Missing: boundary (100 nodes) |
| Server large result | 2 | Missing: boundary (101 nodes), empty result |
| Server abort | 1 | Missing: verify server STOPS sending |
| **Critical missing:** | | Streaming = non-streaming equivalence test |
| **Critical missing:** | | Concurrent streams |
| **Critical missing:** | | Mid-stream server disconnect |

**Recommendation:** Add at least 7 more tests (gaps above) to cover critical paths.

---

## Backward Compatibility

**Claim:** "All changes are additive. Existing `queryNodes()` is untouched."

**Code review:**

1. **Types:** Added `NodesChunkResponse`, added methods to `IRFDBClient` → ✓ additive
2. **Server:** Added `NodesChunk` variant, added `"streaming"` to features → ✓ additive
3. **Client:** New method `queryNodesStream()`, `queryNodes()` unchanged → ✓ additive

**Old clients talking to new server:**
- New server sends `"streaming"` in features → ignored by old client → ✓
- New server sends chunked responses for large results → old client can't parse `done` field → **BREAKS**

**Wait, check:**

Old client expects `Response::Nodes { nodes }`. New server sends `Response::NodesChunk { nodes, done, chunkIndex }`.

**Serde untagged enum:** Client deserializes based on field presence. Old client's type definition doesn't have `NodesChunkResponse`, so it tries to deserialize as `Nodes { nodes }`. Extra fields (`done`, `chunkIndex`) are ignored by serde (default behavior).

**Result:** Old client sees `{ nodes: [...] }` and ignores `done` / `chunkIndex` → Works for FIRST chunk, but breaks for subsequent chunks (old client doesn't expect multiple responses with same requestId).

**Mitigation:** The validation criteria say:
> Small result (<100) → non-streaming

If the server only streams for large results, and old clients typically query small results, breakage is limited. But this is NOT "backward compatible" — it's "backward compatible for small queries only".

**Recommendation:** Document this limitation OR make server streaming opt-in via Hello negotiation.

**Alternative:** Add protocol version check. If client says `protocolVersion: 2`, server doesn't stream. If client says `protocolVersion: 3`, server streams. This makes it truly backward compatible.

Joel's spec says:
```typescript
async hello(protocolVersion: number = 2): Promise<HelloResponse>
```

The client defaults to version 2. The server should check `protocolVersion` and only stream if version >= 3.

**Missing from Joel's plan:** Protocol version gating.

---

## Does It Match the Task Requirements?

**Original task (001-user-request.md):**
```
Client Phase D. Streaming response support for large query results.

~250 LOC, ~12 tests
```

**Joel's plan:**
- Full-stack (server + client), not just client
- ~575 LOC, 18 tests

**Scope expansion:** Joel's plan is 2.3x the original estimate (LOC). This was approved by user ("full-stack streaming"), so it's OK.

**Does it deliver the feature?** YES, assuming bugs are fixed.

---

## Final Recommendation

**REJECT** — Fix critical bugs and add missing tests:

1. **Fix timeout bug:** Clear timer on first chunk, not on stream completion
2. **Fix unbounded buffer:** Add bounded buffer (max 1500 nodes) + fail on overflow, OR document OOM risk
3. **Add protocol version gating:** Only stream if client negotiates version >= 3
4. **Add missing tests:**
   - Boundary cases (100, 101, 0 nodes)
   - Streaming = non-streaming equivalence
   - Concurrent streams
   - Mid-stream server disconnect
   - Server stops sending after client abort (verify, not just "doesn't crash")

**After fixes:** Re-review. The plan is fundamentally sound, but the bugs make it unsafe for production.

---

**Reviewer:** Вадим Решетников (Auto)
**Date:** 2026-02-15
**Status:** REJECTED — bugs must be fixed before implementation
