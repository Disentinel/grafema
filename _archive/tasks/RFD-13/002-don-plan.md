# RFD-13: T4.3 Client Streaming -- Don Melton's Analysis & Plan

## 1. The Elephant in the Room: Server-Side Streaming Does Not Exist

### What RFD-11 Actually Delivered

I've audited the full Rust server codebase. The RFD-11 description mentioned:
- "Streaming: 50K nodes -> chunked, client reassembles"
- "Response: streaming `EdgesChunk { edges, done, request_id }`"

**None of this was implemented.** Here is what I found:

1. **`handle_request()` returns exactly one `Response` per `Request`** -- always (line 713: `fn handle_request(...) -> Response`). There is no mechanism to return multiple frames.

2. **`handle_client()` loop** (lines 1672-1738) reads one message, dispatches to `handle_request()`, gets ONE `Response`, serializes it, writes ONE frame. Done. Next request.

3. **`QueryNodes` handler** (lines 1047-1076) collects ALL matching nodes into `Vec<WireNode>`, returns `Response::Nodes { nodes }` -- a single response containing every result.

4. **No `NodesChunk`/`EdgesChunk` response variants exist** in the `Response` enum. No `done` field. No multi-frame response capability.

5. **The `features` advertised by `Hello`** are `["multiDatabase", "ephemeral"]` -- no "streaming" feature.

**Conclusion:** RFD-11 delivered the engine switchover (v1->v2), new protocol commands (snapshots, batch, QueryEdges), but streaming was descoped. This is not a criticism -- RFD-11 was already massive (538 tests, 8 commits). But the dependency chain is broken.

### Root Cause Policy Assessment

Per CLAUDE.md Root Cause Policy: "When behavior or architecture doesn't match project vision -- STOP. Do not patch or workaround."

**Is this a Root Cause Policy violation?** Let me analyze carefully.

The question is: **can we deliver meaningful value for RFD-13 without server-side streaming?** This is not about patching -- it's about understanding what "client streaming" actually means in the context of what we have.

### What "Client Streaming" Means Without Server Streaming

The current client already has a fake async generator:

```typescript
async *queryNodes(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
  const response = await this._send('queryNodes', { query: serverQuery });
  const nodes = (response as { nodes?: WireNode[] }).nodes || [];
  for (const node of nodes) {
    yield node;
  }
}
```

This yields nodes one-by-one from a bulk response. The consumer sees an async generator API, but there is no streaming -- all data arrives in one frame, sits in memory, and is yielded lazily.

**The real streaming problem has two sides:**
1. **Server sends chunks** -- requires Rust changes (new Response type, modified `handle_client` loop)
2. **Client consumes chunks** -- requires TS changes (chunk accumulation, async generator bridge)

Without (1), building (2) is engineering theater. A `StreamQueue` adapter sitting between `_handleResponse` and the async generator adds complexity for zero benefit when the server always sends one giant response.

## 2. The Right Decision

### Option A: Build Both Server + Client Streaming (REJECT)

- Server streaming is a Rust task (Track 1), RFD-13 is Track 3 (TS)
- Mixing tracks violates the roadmap structure
- Server streaming is non-trivial: modify `handle_client` loop, add chunked response type, implement cursor-based iteration over query results, handle request cancellation
- Estimated: 400-600 LOC Rust + 250 LOC TS = too large for a 2-point ticket

### Option B: Build Client-Only "Future-Ready" Streaming (REJECT)

- Build `StreamQueue`, chunk accumulation, `queryNodesStream()` that handles multi-frame responses
- But the server never sends multi-frame responses
- Untestable against real server -- would require mock server
- Violates "no mock in production paths" (Kent Beck rule)
- Over-engineering for a hypothetical future
- Steve Jobs would reject this: "Would shipping this embarrass us?" -- shipping streaming infrastructure that doesn't stream is embarrassing

### Option C: Pragmatic Scope Reduction (RECOMMENDED)

Split RFD-13 into what can be delivered NOW and what needs server work:

**RFD-13 (THIS TASK): Client streaming protocol readiness**
- Add streaming feature detection via `hello()` response
- Add `queryNodesStream()` method that:
  - Checks server capabilities from `hello()`
  - If server supports streaming: use chunked protocol (future)
  - If server does NOT support streaming (current): gracefully falls back to current bulk behavior via `queryNodes()`
- Define the chunk protocol types in `@grafema/types`
- Client-side `StreamQueue` adapter for push->pull bridging (will be needed when server ships streaming)

**RFD-XX (NEW TASK): Server-side streaming for QueryNodes**
- Modify `handle_client` loop to support multi-frame responses
- Add `NodesChunk` response variant with `done` flag
- Implement cursor-based iteration in `QueryNodes` handler
- Advertise "streaming" in `hello()` features
- Test with large node sets

**Why this is RIGHT:**
1. The protocol types and feature detection are genuinely useful -- they define the contract
2. The fallback behavior makes `queryNodesStream()` usable immediately -- callers get the async generator API they want
3. When server streaming ships, the client is ready -- just remove the fallback
4. No engineering theater -- we don't pretend to stream
5. The `StreamQueue` is a well-understood data structure that can be tested in isolation with unit tests (not integration tests requiring a streaming server)

## 3. Detailed Plan

### Phase 1: Protocol Types & Feature Detection (~60 LOC TS, ~10 LOC Rust)

**Goal:** Define the streaming chunk protocol and make it negotiable.

**1.1. Add streaming types to `@grafema/types`** (~30 LOC)

```typescript
// New response types for streaming protocol
export interface NodesChunk extends RFDBResponse {
  nodes: WireNode[];
  done: boolean;     // true = last chunk for this requestId
  chunkIndex: number; // 0-based, for ordering verification
}

export interface EdgesChunk extends RFDBResponse {
  edges: WireEdge[];
  done: boolean;
  chunkIndex: number;
}
```

**1.2. Update `hello()` feature detection** (~10 LOC)

Client should check for `"streaming"` in the `features` array returned by `hello()`. No Rust changes yet -- the server doesn't advertise it. But the client code is ready to detect it.

```typescript
private _supportsStreaming: boolean = false;

async hello(protocolVersion: number = 2): Promise<HelloResponse> {
  const response = await this._send('hello', { protocolVersion });
  const hello = response as HelloResponse;
  this._supportsStreaming = hello.features?.includes('streaming') ?? false;
  return hello;
}

get supportsStreaming(): boolean {
  return this._supportsStreaming;
}
```

**1.3. Rust server: add "streaming" to features (commented/disabled)** (~10 LOC)

Add a comment in `handle_request` for `Hello` showing where `"streaming"` will be added when server-side streaming ships. No actual change -- documentation of intent.

### Phase 2: StreamQueue Data Structure (~80 LOC TS)

**Goal:** Push-pull adapter that bridges the gap between `_handleResponse` (push-based, data arrives from socket) and async generators (pull-based, consumer iterates).

This is a pure data structure. Tested in isolation. No server dependency.

**Design (based on [queueable library](https://slikts.github.io/queueable/) pattern):**

```typescript
class StreamQueue<T> {
  private buffer: T[];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }>;
  private done: boolean;
  private error: Error | null;

  push(item: T): void;      // Called by _handleResponse when chunk arrives
  end(): void;               // Called when done=true chunk arrives
  fail(error: Error): void;  // Called on error
  pull(): Promise<IteratorResult<T>>; // Called by async generator

  // AsyncIterableIterator protocol
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
  next(): Promise<IteratorResult<T>>;
  return(): Promise<IteratorResult<T, void>>; // Consumer abort
}
```

**Backpressure model:** When the consumer is slow, `push()` buffers items. When the consumer is fast, `pull()` returns a pending Promise that resolves on next `push()`. This is the standard "channel" pattern.

**No bounded buffer needed yet:** Since the server sends one response (not a stream), the buffer will contain at most one batch of nodes. When server streaming ships, we can add bounded buffering with flow control signals.

**Complexity:** O(1) amortized per push/pull operation.

### Phase 3: `queryNodesStream()` with Fallback (~60 LOC TS)

**Goal:** Public API method that returns a true async generator, with automatic fallback when server doesn't support streaming.

```typescript
async *queryNodesStream(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
  if (!this._supportsStreaming) {
    // Fallback: use existing bulk queryNodes
    yield* this.queryNodes(query);
    return;
  }

  // Streaming path (future -- when server supports it):
  // 1. Send queryNodesStream request
  // 2. Create StreamQueue for this requestId
  // 3. Register chunk handler in pending map
  // 4. Yield from StreamQueue
  // 5. On consumer abort: send cancel signal to server
}
```

**Why `yield* this.queryNodes(query)` is the correct fallback:**
- `queryNodes()` is already an async generator (yields nodes one by one from bulk response)
- Consumer code sees the same API
- When server adds streaming, we flip the feature flag and the streaming path activates
- Zero behavior change for existing callers

**Important:** `queryNodesStream()` is added as a NEW method, not replacing `queryNodes()`. The existing method continues to work unchanged. This follows "Reuse Before Build" -- we extend, don't replace.

### Phase 4: Modify `_handleResponse` for Multi-Frame Support (~50 LOC TS)

**Goal:** When the server eventually sends chunked responses, the client can route them correctly.

**Current behavior:** Each response resolves/rejects a pending Promise, then removes it from the `pending` Map.

**New behavior:** For streaming responses (detected by `done` field), keep the pending entry alive until `done: true`.

```typescript
private _handleResponse(response: RFDBResponse): void {
  // ... existing requestId matching ...

  // Check if this is a streaming chunk
  if ('done' in response && response.done === false) {
    // Streaming chunk -- push to StreamQueue, don't resolve yet
    const stream = this._streamQueues.get(id);
    if (stream) {
      const chunk = response as NodesChunk | EdgesChunk;
      if ('nodes' in chunk) {
        for (const node of chunk.nodes) stream.push(node);
      } else if ('edges' in chunk) {
        for (const edge of chunk.edges) stream.push(edge);
      }
    }
    return; // Don't remove from pending
  }

  if ('done' in response && response.done === true) {
    // Last chunk -- push remaining items, end the stream
    const stream = this._streamQueues.get(id);
    if (stream) {
      // Push final items if any
      const chunk = response as NodesChunk | EdgesChunk;
      if ('nodes' in chunk) {
        for (const node of chunk.nodes) stream.push(node);
      }
      stream.end();
    }
    this.pending.delete(id);
    return;
  }

  // Non-streaming response -- existing behavior
  // ...
}
```

**This code is dormant until the server sends streaming responses.** But having it in place means zero client changes when server streaming ships.

### Phase 5: Tests (~12 tests)

**5.1. StreamQueue unit tests** (~6 tests)
- `push then pull` -- item available immediately
- `pull then push` -- Promise resolves when item arrives
- `end()` -- iterator terminates
- `fail()` -- iterator throws
- `return()` -- consumer abort, cleans up
- `multiple items` -- order preservation

**5.2. Feature detection tests** (~2 tests)
- `hello()` without streaming feature -> `supportsStreaming === false`
- `hello()` with streaming feature -> `supportsStreaming === true`

**5.3. queryNodesStream fallback tests** (~2 tests)
- When `!supportsStreaming`: yields same results as `queryNodes()`
- Equivalence: `queryNodesStream()` results === `queryNodes()` results

**5.4. _handleResponse chunk routing tests** (~2 tests)
- Non-streaming response: existing behavior preserved
- Streaming chunks (simulated): StreamQueue receives items in order

**Test approach:** StreamQueue tests are pure unit tests (no server). Feature detection and fallback tests use a mock `_send` override or a minimal mock server (already established pattern in existing tests -- they create RFDBClient with nonexistent socket and test client-side logic).

## 4. What We Explicitly DO NOT Do

1. **No Rust server changes** -- server streaming is a separate Track 1 task
2. **No bounded buffer / flow control** -- unnecessary without real streaming
3. **No `getAllEdgesStream()`** -- scope limit, edges streaming can follow the same pattern later
4. **No breaking changes to `queryNodes()`** -- new method `queryNodesStream()` is additive
5. **No mock server for streaming integration tests** -- StreamQueue tests in isolation, fallback tests against existing API

## 5. Scope Assessment

| Phase | LOC | Tests | Risk |
|-------|-----|-------|------|
| Phase 1: Protocol types + feature detection | ~40 | 2 | LOW |
| Phase 2: StreamQueue | ~80 | 6 | LOW |
| Phase 3: queryNodesStream fallback | ~30 | 2 | LOW |
| Phase 4: _handleResponse chunk routing | ~50 | 2 | MEDIUM |
| **Total** | **~200** | **12** | **LOW** |

This fits the 2-point estimate. The risk is LOW because we're building isolated components that don't modify existing behavior.

## 6. New Linear Issue Required

**RFD-XX: Server-side streaming for QueryNodes/QueryEdges**

The RFD-11 description promised streaming but it was not delivered. The server currently sends all results in a single response frame. For large graphs (50K+ nodes), this:
- Requires serializing the entire result set into memory before sending
- Prevents the client from processing results incrementally
- Makes backpressure impossible

**Subtasks:**
1. Add `NodesChunk`/`EdgesChunk` response variants to `Response` enum
2. Modify `handle_client` loop to support multi-frame responses per request
3. Implement cursor-based iteration in `QueryNodes`/`QueryEdges` handlers (configurable chunk size)
4. Add `"streaming"` to `Hello` features when enabled
5. Stream cancellation: client sends cancel frame, server stops sending chunks
6. Backpressure: respect TCP/socket flow control (server blocks on `write_all` when client isn't reading)

**Dependencies:** None (can be done independently now that v2 engine is in place)
**Estimate:** 3-5 points
**Priority:** v0.2 (needed for Early Access -- large codebases will hit OOM on bulk responses)

## 7. Research Notes

Approaches researched for this plan:

**Push-pull channel pattern:**
- The [queueable library](https://slikts.github.io/queueable/) provides TypeScript push-pull adapters with buffering strategies
- The [Channel](https://slikts.github.io/queueable/classes/Channel.html) class implements exactly the pattern we need for StreamQueue
- Key insight: async generators are pull-based, event sources are push-based. A channel bridges them.

**Backpressure in Node.js:**
- [Node.js backpressure documentation](https://nodejs.org/en/learn/modules/backpressuring-in-streams) covers the drain event pattern
- For our use case, the natural backpressure comes from `async for...of` -- the generator only yields when the consumer calls `next()`
- [Backpressure in JavaScript](https://blog.gaborkoos.com/posts/2026-01-06-Backpressure-in-JavaScript-the-Hidden-Force-Behind-Streams-Fetch-and-Async-Code/) explains how async iterables maintain backpressure without explicit flow control

**MessagePack framing:**
- [Protocol framing with Tokio and MsgPack](https://snoozetime.github.io/2019/02/20/TCP-framing-protocol.html) -- existing framing supports multi-message streams naturally
- Our 4-byte length prefix + MessagePack already supports multiple independent frames per connection
- [msgpack-rpc spec](https://github.com/msgpack-rpc/msgpack-rpc/blob/master/spec.md) uses `requestId` for multiplexing -- we already have this

**Multi-frame response multiplexing:**
- [HTTP/2 stream multiplexing](https://hpbn.co/http2/) -- stream ID per frame, interleaved frames, flow control
- Our `requestId` already serves as a stream identifier
- The `done` field pattern is standard (gRPC uses `END_STREAM` flag, HTTP/2 uses `END_STREAM`)

**gRPC backpressure patterns:**
- [gRPC flow control](https://github.com/grpc/grpc-java/issues/1549) -- `isReady()` check before sending
- For Unix sockets, TCP flow control provides natural backpressure -- `write_all()` blocks when the socket buffer is full
- No need for application-level flow control in our protocol -- socket-level is sufficient

## 8. Open Questions for Discussion

1. **Should `queryNodesStream()` be added to `IRFDBClient` interface?** If yes, all implementations (including potential future non-socket implementations) must provide it. I lean YES -- the interface should reflect the intended API.

2. **Should we rename the existing `queryNodes()` async generator?** Currently it pretends to be a generator but always resolves in one shot. Options:
   - Keep as-is (backward compat)
   - Make `queryNodes()` return `Promise<WireNode[]>` (breaking), add `queryNodesStream()` as the generator
   - Keep both with documentation explaining the difference
   I lean toward keeping both with documentation.

3. **Server-side streaming priority:** Should RFD-XX (server streaming) be created as v0.2 or v0.3? For Early Access (v0.2), how many nodes can fit in a single response frame before we hit practical limits?

---

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-15
**Status:** Ready for discussion with user before proceeding
