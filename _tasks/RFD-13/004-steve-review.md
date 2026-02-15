# Steve Jobs Review: RFD-13 Full-Stack Streaming

**Date:** 2026-02-15
**Reviewer:** Steve Jobs (High-level Review)
**Plan Author:** Joel Spolsky

---

## VERDICT: REJECT

This plan violates fundamental architectural principles and introduces unacceptable complexity without addressing the real problem.

---

## Critical Issues

### 1. ARCHITECTURAL MISMATCH: Three Code Paths in _handleResponse

Joel's plan creates THREE distinct code paths in `_handleResponse()`:

1. Streaming chunk (`done` field present, `done: false`)
2. Last streaming chunk (`done` field present, `done: true`)
3. Non-streaming response (no `done` field)

**Plus** auto-fallback detection: checking if a non-streaming response arrived for a requestId that was expected to be streaming.

**This is wrong.** The client should have ONE path for receiving responses. The server should tell us ONCE what protocol it uses (via Hello), and then we use the appropriate receiving strategy. We don't dynamically detect on every response.

**The right architecture:**

```
if (server.supportsStreaming) {
  // All responses are potentially chunked - route via StreamQueue
} else {
  // All responses are single-shot - existing Promise resolution
}
```

Not "check every single response to see if it has a `done` field and dynamically figure out what to do with it."

### 2. COMPLEXITY EXPLOSION: Manual Request Building

Look at `queryNodesStream()` (lines 770-812 of Joel's plan):

- Can't use `_send()` because it expects a single response
- Manually constructs MessagePack request
- Manually writes length prefix
- Manually manages timeout
- Registers BOTH in `pending` AND `_pendingStreams`

**Why does this exist?** Because the architecture is fighting itself. The `_send()` method assumes one request = one response. Streaming breaks that assumption. Instead of fixing the abstraction, Joel works around it with 40 lines of copy-pasted framing logic.

**The right fix:** Make `_send()` optionally return a StreamQueue instead of a Promise. Or introduce `_sendStreaming()` that shares the same framing code.

### 3. ROOT CAUSE VIOLATION: Server Lock Duration

From Joel's plan, section 8.2:

> **Server lock duration during streaming** | Read lock held for entire stream. Same as before (single-response path also holds lock). For V1 this is acceptable.

**NO. This is NOT acceptable.**

The entire point of streaming is to avoid holding resources while sending chunks. If we're going to hold the engine read lock for 10 seconds while streaming 50K nodes, we might as well send them all in one giant response — same blocking behavior, simpler code.

Streaming exists to solve TWO problems:
1. **Memory**: don't serialize all results at once
2. **Concurrency**: don't block other operations

Joel's plan fixes (1) but makes (2) WORSE by holding the lock longer.

**Per CLAUDE.md Root Cause Policy:**
> When behavior or architecture doesn't match project vision — STOP. Do not patch or workaround. Fix from the roots.

This is a patch. The root cause is: **the query execution model assumes synchronous, one-shot execution**. Streaming requires async, cursor-based iteration with lock-free chunk fetching.

### 4. MANDATORY COMPLEXITY CHECKLIST FAILURES

Let's apply the checklist from CLAUDE.md:

**1. Complexity Check: What's the iteration space?**

Server streaming path (lines 268-300):
```rust
for chunk_ids in ids.chunks(STREAMING_CHUNK_SIZE) {
    let nodes: Vec<WireNode> = chunk_ids.iter()
        .filter_map(|&id| engine.get_node(id))
        .map(|r| record_to_wire_node(&r))
        .collect();
    // ... serialize and write ...
}
```

This iterates over **all IDs** returned by `find_by_attr()`. That's O(N) where N = total matching nodes.

**But wait** — line 252 already called `engine.find_by_attr()` which returns `Vec<u128>` — ALL matching IDs in memory.

So the streaming path:
1. Collects ALL IDs in memory (line 252)
2. Then chunks them (line 268)
3. Loads each chunk and serializes

**Memory usage:** O(N) ID storage + O(C) node storage = still O(N), just with a smaller constant.

**This is NOT real streaming.** Real streaming would use a cursor that yields IDs lazily without collecting them all first.

**2. Plugin Architecture: Forward registration vs backward scanning?**

Not applicable — this is protocol-level, not plugin architecture.

**3. Extensibility: Adding new streaming types?**

To add `EdgesChunk` streaming (which Joel explicitly defers as "follow-on task"), we need to:
- Add `EdgesChunk` response variant
- Write `handle_query_edges_streaming()`
- Modify `handle_client()` match to intercept `QueryEdges`
- Update `_handleResponse` chunk routing to handle `EdgesChunk`
- Add client method `queryEdgesStream()`

**Copy-paste explosion.** Each new streaming command requires duplicating the entire pattern.

**The right architecture:** Generic `handle_streaming_request<T>()` that takes a query executor and chunking strategy.

**4. Grafema doesn't brute-force?**

The server implementation IS brute-force: collect all IDs, then chunk. It's just batched brute-force.

---

## Specific Technical Flaws

### Threshold & Chunk Size (Concerns 1 & 2)

Joel's plan:
- `STREAMING_THRESHOLD = 100`
- `CHUNK_SIZE = 500`

**The threshold is too low.** 100 nodes serialize to ~10-50KB (depending on metadata). Modern systems handle this trivially. Activating streaming at 100 nodes adds protocol overhead (multiple frames, chunk routing, StreamQueue) for negligible benefit.

**Evidence:** Joel himself says "100 is small enough that a single MessagePack frame is trivially fast to serialize" — so why stream it?

**The chunk size is arbitrary.** 500 nodes → "~50-200KB depending on metadata density" (line 48). But what if nodes have large metadata? 500 nodes could be 2MB. Or 20KB. The chunk size should be based on BYTES, not node count.

**The right approach:**
- Threshold: 10K nodes or 1MB serialized (whichever comes first)
- Chunk size: 256KB target (adaptive — serialize until we hit the byte limit, then send)

### Timeout Model (Concern 4)

From lines 783-788:
```typescript
const timer = setTimeout(() => {
  this._pendingStreams.delete(id);
  this.pending.delete(id);
  streamQueue.fail(new Error(`RFDB queryNodesStream timed out after ${timeoutMs}ms`));
}, timeoutMs);
```

**Single 60-second timeout for the entire streaming operation.**

If streaming 50K nodes takes 70 seconds (slow network, large metadata), the stream is canceled even though it's making progress.

**The right model:** Timeout per chunk. Reset timer on each successful chunk arrival. Fail only if NO data arrives for 60s.

### HandleResult Enum (Concern 6)

Joel introduces `HandleResult` to distinguish "handler returned a response" from "handler already wrote to stream."

**This is a code smell.** It means `handle_query_nodes_streaming()` has side effects (writes to stream) while other handlers are pure (return Response).

**Why is this necessary?** Because the `handle_client()` loop was designed for synchronous request/response. Streaming is bolted on via special-casing.

**The right architecture:** ALL handlers return a `ResponseStream` iterator. Single-response handlers return a 1-element stream. Streaming handlers return multi-element streams. The loop always does:

```rust
for response in handler.execute() {
    write_frame(response);
}
```

No special cases. No `HandleResult` enum. No "handler already wrote to stream" magic.

---

## What This Plan Actually Delivers

Let's be honest about what happens if we ship this:

1. **For small queries (<100 nodes):** Existing behavior, zero benefit from streaming code
2. **For medium queries (100-1K nodes):** Chunked responses with protocol overhead, negligible memory savings (we still collect all IDs), worse concurrency (lock held longer)
3. **For large queries (>10K nodes):** Actually helps with memory, but blocks engine for entire duration, prevents concurrent reads/writes

**The 80% case gets SLOWER. The 20% case gets a bit better.**

This is not a good trade.

---

## The Real Problem

The underlying issue is: **RFDB query execution is not designed for streaming.**

Evidence:
1. `find_by_attr()` returns `Vec<u128>` — all IDs at once
2. Queries acquire engine read lock and hold it until results are returned
3. No cursor abstraction for incremental result fetching
4. No way to release lock between chunks

**Streaming is an architectural feature, not a protocol feature.** Adding chunked responses to a synchronous query engine is like putting a turbocharger on a bicycle — the protocol can stream, but the engine can't.

---

## What Would Make This RIGHT

To do streaming properly:

### Phase 1: Engine-Level Streaming (Rust)

```rust
trait QueryCursor {
    fn next_batch(&mut self, max_items: usize) -> Vec<WireNode>;
    fn is_done(&self) -> bool;
}

impl GraphStore {
    fn stream_query(&self, query: AttrQuery) -> Box<dyn QueryCursor>;
}
```

- Query returns a cursor, not all results
- Cursor fetches IDs lazily, in batches
- Lock is acquired per batch, released between batches
- Concurrency: other requests can run between chunks

### Phase 2: Protocol-Level Streaming

- Handler creates cursor, writes chunks in loop
- Each chunk: acquire lock, fetch batch, release lock, serialize, write
- Client side: StreamQueue receives chunks

### Phase 3: Adaptive Chunking

- Chunk size based on serialized bytes, not node count
- Target: 256KB per chunk (fits in L2 cache, single TCP packet burst)
- Measure serialization size, adjust chunk node count dynamically

### Phase 4: Timeout Per Chunk

- Reset timer on each chunk arrival
- Fail only if no progress for N seconds

---

## Why I'm Rejecting This

From CLAUDE.md:

> **Steve Jobs (High-level Review):** Default stance: REJECT. If approves → escalate to Вадим auto-review.
>
> Primary Questions:
> - Does this align with project vision?
> - Did we cut corners instead of doing it right?
> - Are there fundamental architectural gaps?
> - Would shipping this embarrass us?

**My answers:**

1. **Vision alignment?** NO. Grafema's vision is "AI should query the graph, not read code." Streaming is infrastructure — but infrastructure should be done RIGHT. Shipping half-working streaming that blocks the engine embarrasses us.

2. **Did we cut corners?** YES. The entire `HandleResult` enum, manual request building in `queryNodesStream()`, three-path `_handleResponse`, server lock duration — all corners cut.

3. **Fundamental architectural gaps?** YES. The engine doesn't support cursor-based iteration. We're papering over this with protocol-level chunking.

4. **Would shipping this embarrass us?** YES. Anyone who looks at the code will see:
   - 3 code paths in `_handleResponse`
   - Streaming that still collects all IDs in memory
   - 40 lines of manual framing logic
   - Engine lock held for entire stream

**This looks like junior-level code, not production-ready infrastructure.**

---

## My Recommendation

**Option A (Recommended): Do it right**

1. Stop work on RFD-13
2. Create new task: **RFD-XX: Engine-level streaming with cursor abstraction**
   - Implement `QueryCursor` trait in Rust
   - Modify `find_by_attr()` to return cursor, not Vec
   - Add lock-free batch fetching
   - Estimate: 5-8 points (non-trivial, but necessary)
3. After RFD-XX: Resume RFD-13 with proper engine support
   - Protocol streaming becomes straightforward
   - No `HandleResult` enum needed
   - No architectural hacks

**Option B (Acceptable): Defer streaming entirely**

1. Close RFD-13 as "blocked by engine architecture"
2. Document limitation: queries return all results in single frame
3. Add warning in docs: "Large queries (>10K nodes) may OOM"
4. Revisit streaming after v0.2 when we have production data on typical query sizes

**Option C (NOT acceptable): Ship Joel's plan as-is**

I will veto any attempt to merge this code without addressing the architectural issues.

---

## Summary

Joel's plan is technically competent in the narrow sense — the code would probably work. But it's architecturally wrong. It adds complexity without solving the real problem (engine-level streaming). It creates maintainability debt (three code paths, copy-paste for each streaming command). And it violates the Root Cause Policy by patching symptoms instead of fixing foundations.

**We don't ship code we'd be embarrassed to show.**

**REJECT.**

---

**Next Steps:**

1. Discuss with user: Option A (do it right) or Option B (defer)?
2. If Option A: Joel updates plan to include engine-level cursor abstraction
3. If Option B: Close RFD-13, document limitation, create v0.3+ backlog item

I will not approve any plan that doesn't address the engine architecture issue.

**- Steve**
