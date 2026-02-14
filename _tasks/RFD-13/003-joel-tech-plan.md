# RFD-13: Full-Stack Streaming -- Joel Spolsky's Technical Spec

## 0. Scope Clarification

User chose **full-stack streaming**: both Rust server AND TypeScript client. Don's plan (002) was written before this decision and proposed client-only work. This spec supersedes Don's phasing and implements the complete vertical slice.

**What we build:**
1. Server (Rust): chunked `NodesChunk` responses for `QueryNodes` with streaming threshold
2. Client (TypeScript): `StreamQueue<T>`, chunk routing in `_handleResponse`, `queryNodesStream()` with auto-fallback
3. Types: streaming protocol types in `@grafema/types`
4. Feature detection: `"streaming"` in Hello features

**What we do NOT build:**
- `EdgesChunk` / `getAllEdgesStream()` -- follow-on task, same pattern
- Explicit `CancelStream` command -- connection close = implicit cancel in V1
- Bounded buffering / application-level flow control -- TCP backpressure suffices
- Changes to existing `queryNodes()` -- new `queryNodesStream()` is additive

---

## 1. Wire Protocol Specification

### 1.1 New Response Variant: `NodesChunk`

```
{
  requestId: string,       // echoed from original QueryNodes request
  nodes: WireNode[],       // 0..CHUNK_SIZE nodes
  done: boolean,           // false = more chunks coming; true = last chunk
  chunkIndex: number       // 0-based, monotonically increasing per stream
}
```

**Framing:** Each chunk is a separate framed message (4-byte BE length prefix + MessagePack payload). Multiple chunks share the same `requestId`. The client matches them to the originating request via `requestId`.

**Discrimination:** The client distinguishes `NodesChunk` from `Nodes` by the presence of the `done` field. If `done` is present, it is a streaming chunk. If absent, it is a legacy single-response `Nodes { nodes }`.

### 1.2 Streaming Threshold

```
STREAMING_THRESHOLD = 100  // nodes
CHUNK_SIZE = 500           // nodes per chunk
```

- If `|results| <= STREAMING_THRESHOLD` (100): send a single `Response::Nodes { nodes }` (existing behavior, zero overhead).
- If `|results| > STREAMING_THRESHOLD`: send N chunks of up to `CHUNK_SIZE` (500) nodes each, with `done: false` for all but the last, and `done: true` on the final chunk.

**Why 100/500:** 100 is small enough that a single MessagePack frame is trivially fast to serialize. 500 is a chunk that serializes to ~50-200KB depending on metadata density, well within socket buffer sizes. Both are tunable constants.

### 1.3 Feature Advertisement

The `Hello` response `features` array adds `"streaming"` when the server supports chunked responses:

```
features: ["multiDatabase", "ephemeral", "streaming"]
```

Clients that don't understand `"streaming"` ignore it (additive, non-breaking).

---

## 2. Implementation Order

The implementation MUST follow this order due to dependencies:

```
Phase 1: Types (@grafema/types)           -- no dependencies
Phase 2: Server streaming (Rust)          -- depends on Phase 1 for contract
Phase 3: StreamQueue (TypeScript)         -- no dependencies (pure data structure)
Phase 4: Client chunk routing (TypeScript) -- depends on Phase 1 + Phase 3
Phase 5: queryNodesStream + fallback      -- depends on Phase 4
Phase 6: Tests                            -- parallel with each phase (TDD)
```

Phases 1 and 3 can be done in parallel. Phase 2 and Phase 3 can be done in parallel.

---

## 3. Phase 1: Protocol Types (`packages/types/src/rfdb.ts`)

### 3.1 New Types (~25 LOC)

Add after the existing `RFDBResponse` section (after line 184):

```typescript
// === STREAMING RESPONSE TYPES ===

/**
 * A chunk of nodes in a streaming QueryNodes response.
 *
 * Sent by the server when the result set exceeds the streaming threshold.
 * Multiple NodesChunk messages share the same requestId. The client
 * accumulates chunks until `done === true`.
 *
 * Discrimination: if a response has a `done` field, it is a streaming chunk.
 * If it does not, it is a legacy single-shot `Nodes { nodes }` response.
 */
export interface NodesChunkResponse extends RFDBResponse {
  nodes: WireNode[];
  /** true = last chunk for this requestId; false = more chunks coming */
  done: boolean;
  /** 0-based chunk index for ordering verification */
  chunkIndex: number;
}
```

### 3.2 Update `IRFDBClient` Interface

Add after the existing `queryNodes` entry (after line 444):

```typescript
  /** Stream nodes matching query. Falls back to bulk when server lacks streaming support. */
  queryNodesStream(query: AttrQuery): AsyncGenerator<WireNode, void, unknown>;

  /** Whether the server advertises streaming support (set after hello()) */
  readonly supportsStreaming: boolean;
```

### 3.3 Complexity Analysis

- No algorithms in this phase. Type definitions only.
- O(1) -- compile-time type checking.

---

## 4. Phase 2: Server Streaming (Rust)

### File: `packages/rfdb-server/src/bin/rfdb_server.rs`

### 4.1 Constants (~5 LOC)

Add after the `NEXT_CLIENT_ID` static (line 43):

```rust
/// Streaming threshold: queries returning more than this many nodes
/// will use chunked streaming instead of a single Response::Nodes.
const STREAMING_THRESHOLD: usize = 100;

/// Maximum nodes per streaming chunk.
const STREAMING_CHUNK_SIZE: usize = 500;
```

### 4.2 New Response Variant: `NodesChunk` (~10 LOC)

Add a new variant to the `Response` enum (after the `Files` variant, around line 373):

```rust
    /// Streaming chunk of nodes for QueryNodes
    /// Discriminated from Nodes by presence of `done` field.
    NodesChunk {
        nodes: Vec<WireNode>,
        done: bool,
        #[serde(rename = "chunkIndex")]
        chunk_index: u32,
    },
```

**IMPORTANT serde note:** The `Response` enum uses `#[serde(untagged)]`. This means serde will try each variant in order. `NodesChunk` has fields `nodes`, `done`, and `chunkIndex`, while `Nodes` only has `nodes`. As long as `NodesChunk` appears BEFORE `Nodes` in the enum, serde serialization works correctly (serialization always uses the correct variant; deserialization is not needed for Response since the server only serializes, never deserializes responses). Since we control which variant we construct, the ordering only matters for clarity. Place `NodesChunk` BEFORE `Nodes` in the enum.

### 4.3 Update Hello Features (~5 LOC)

In the `Request::Hello` handler (line 723-731), change:

```rust
// BEFORE:
features: vec!["multiDatabase".to_string(), "ephemeral".to_string()],

// AFTER:
features: vec![
    "multiDatabase".to_string(),
    "ephemeral".to_string(),
    "streaming".to_string(),
],
```

### 4.4 New `HandleResult` Enum (~10 LOC)

The core architectural change: `handle_request()` returns a single `Response`. Streaming requires writing multiple frames. We introduce `HandleResult` to distinguish between "return this single response" and "I already wrote to the stream myself".

Add before `handle_request()` (before line 712):

```rust
/// Result of handling a request.
///
/// `Single(Response)` -- the caller serializes and writes one response frame.
/// `Streamed` -- the handler already wrote multiple frames directly to the stream.
///               The caller does NOT write anything.
enum HandleResult {
    Single(Response),
    Streamed,
}
```

### 4.5 New `handle_query_nodes_streaming()` Function (~60 LOC)

This function handles the streaming path for QueryNodes. It acquires the engine read lock, gets IDs, and writes chunks directly to the stream.

Add as a new function (before `handle_client`, around line 1615):

```rust
/// Handle QueryNodes with streaming: write multiple NodesChunk frames
/// directly to the stream. Returns `HandleResult::Streamed` on success,
/// or `HandleResult::Single(error)` if the database is not available.
///
/// Streaming protocol:
/// 1. Get all matching IDs from engine (in-memory, just ID list)
/// 2. For each chunk of STREAMING_CHUNK_SIZE IDs:
///    a. Load nodes from engine
///    b. Serialize NodesChunk { nodes, done: false, chunk_index }
///    c. Write frame to stream
/// 3. Final chunk: done: true
/// 4. If write fails at any point: stop sending (implicit cancel)
fn handle_query_nodes_streaming(
    session: &ClientSession,
    query: WireAttrQuery,
    request_id: &Option<String>,
    stream: &mut UnixStream,
    metrics: &Option<Arc<Metrics>>,
) -> HandleResult {
    let db = match &session.current_db {
        Some(db) => db,
        None => return HandleResult::Single(Response::ErrorWithCode {
            error: "No database selected. Use openDatabase first.".to_string(),
            code: "NO_DATABASE_SELECTED".to_string(),
        }),
    };

    let engine = db.engine.read().unwrap();

    // Build AttrQuery from wire format
    let metadata_filters: Vec<(String, String)> = query.extra.into_iter()
        .filter_map(|(k, v)| {
            match v {
                serde_json::Value::String(s) => Some((k, s)),
                serde_json::Value::Bool(b) => Some((k, b.to_string())),
                serde_json::Value::Number(n) => Some((k, n.to_string())),
                _ => None,
            }
        })
        .collect();

    let attr_query = AttrQuery {
        version: None,
        node_type: query.node_type,
        file_id: None,
        file: query.file,
        exported: query.exported,
        name: query.name,
        metadata_filters,
    };

    let ids = engine.find_by_attr(&attr_query);
    let total = ids.len();

    // Below threshold: single response (delegate back to non-streaming path)
    if total <= STREAMING_THRESHOLD {
        let nodes: Vec<WireNode> = ids.into_iter()
            .filter_map(|id| engine.get_node(id))
            .map(|r| record_to_wire_node(&r))
            .collect();
        return HandleResult::Single(Response::Nodes { nodes });
    }

    // Streaming path: send chunks
    let start = Instant::now();
    let mut chunk_index: u32 = 0;

    for chunk_ids in ids.chunks(STREAMING_CHUNK_SIZE) {
        let nodes: Vec<WireNode> = chunk_ids.iter()
            .filter_map(|&id| engine.get_node(id))
            .map(|r| record_to_wire_node(&r))
            .collect();

        let is_last = (chunk_index as usize + 1) * STREAMING_CHUNK_SIZE >= total;
        let response = Response::NodesChunk {
            nodes,
            done: is_last,
            chunk_index,
        };

        let envelope = ResponseEnvelope {
            request_id: request_id.clone(),
            response,
        };

        let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("[rfdb-server] Serialize error during streaming: {}", e);
                return HandleResult::Streamed; // Partial stream sent, nothing we can do
            }
        };

        if let Err(e) = write_message(stream, &resp_bytes) {
            eprintln!("[rfdb-server] Write error during streaming (implicit cancel): {}", e);
            return HandleResult::Streamed; // Client disconnected, stop sending
        }

        chunk_index += 1;
    }

    // Record metrics for the entire streaming operation
    if let Some(ref m) = metrics {
        let duration_ms = start.elapsed().as_millis() as u64;
        m.record_query("QueryNodes:stream", duration_ms);
    }

    HandleResult::Streamed
}
```

### 4.6 Modify `handle_client()` Loop (~40 LOC changed)

The `handle_client()` loop (lines 1672-1738) currently:
1. Reads message
2. Calls `handle_request()` -> gets one `Response`
3. Serializes and writes one frame

We need to intercept `QueryNodes` BEFORE it reaches `handle_request()`, so we can pass the stream to `handle_query_nodes_streaming()`.

**Modified handle_client loop (lines 1698-1738):**

```rust
        let is_shutdown = matches!(request, Request::Shutdown);

        // Time the request for metrics
        let start = Instant::now();
        let op_name = get_operation_name(&request);

        // Streaming commands: handle directly (need stream access)
        let handle_result = match request {
            Request::QueryNodes { query } => {
                handle_query_nodes_streaming(
                    &session,
                    query,
                    &request_id,
                    &mut stream,
                    &metrics,
                )
            }
            other => {
                HandleResult::Single(
                    handle_request(&manager, &mut session, other, &metrics)
                )
            }
        };

        // Record metrics if enabled
        if let Some(ref m) = metrics {
            let duration_ms = start.elapsed().as_millis() as u64;
            m.record_query(&op_name, duration_ms);
        }

        // For Single responses, serialize and write the frame
        match handle_result {
            HandleResult::Single(response) => {
                let envelope = ResponseEnvelope { request_id, response };
                let resp_bytes = match rmp_serde::to_vec_named(&envelope) {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        eprintln!("[rfdb-server] Serialize error: {}", e);
                        continue;
                    }
                };

                if let Err(e) = write_message(&mut stream, &resp_bytes) {
                    eprintln!("[rfdb-server] Client {} write error: {}", client_id, e);
                    break;
                }
            }
            HandleResult::Streamed => {
                // Handler already wrote to stream directly
            }
        }

        if is_shutdown {
            eprintln!("[rfdb-server] Shutdown requested by client {}", client_id);
            std::process::exit(0);
        }
```

### 4.7 Remove QueryNodes from `handle_request()`

Since `QueryNodes` is now intercepted in `handle_client()` before reaching `handle_request()`, the `Request::QueryNodes` arm in `handle_request()` (lines 1047-1076) becomes unreachable. However, to be defensive, keep it as a fallback that returns the non-streaming response. This ensures that if `handle_query_nodes_streaming()` is bypassed for any reason, the system still works. No code removal needed.

**Actually, reconsider:** The `match request` in the new `handle_client()` already destructures `QueryNodes` and routes it. The `other` arm captures everything else and passes to `handle_request`. Since `QueryNodes` is matched first, it will NEVER reach `handle_request`. We should leave the existing `QueryNodes` arm in `handle_request` with a comment:

```rust
        // NOTE: QueryNodes is now handled in handle_client() for streaming support.
        // This arm is kept as defensive fallback but should not be reached
        // in normal operation.
        Request::QueryNodes { query } => {
            // ... existing code unchanged ...
        }
```

### 4.8 Complexity Analysis (Server)

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `find_by_attr()` | O(N) where N = nodes matching filter | Existing behavior, unchanged |
| `get_node(id)` per node | O(1) amortized | HashMap/segment lookup |
| Chunk iteration | O(N/C) chunks, C = CHUNK_SIZE | Each chunk: O(C) node loads + O(C) serialization |
| `write_message()` per chunk | O(C * S) where S = avg serialized node size | I/O bound, not CPU |
| **Total streaming path** | **O(N)** | Same as non-streaming, but memory is O(C) instead of O(N) |

**Key improvement:** Memory usage drops from O(N) (collect all nodes into Vec) to O(C) (one chunk in memory at a time). For 50K nodes with C=500, that is 100x reduction in peak memory during serialization.

**Lock duration:** The read lock on the engine is held for the ENTIRE streaming operation (all chunks). This is the same as before (single-response path also holds the lock for the full query). Future optimization: release and re-acquire the lock per chunk. This is safe because we only need read access and results are not transactional. But for V1, keeping the lock simplifies the implementation and matches existing behavior.

---

## 5. Phase 3: StreamQueue (`packages/rfdb/ts/stream-queue.ts`)

### New File: ~80 LOC

```typescript
/**
 * StreamQueue<T> -- Push-pull adapter for bridging event-driven data
 * arrival (socket responses) to pull-based async iteration (for...await).
 *
 * Used by RFDBClient to bridge _handleResponse (push) to
 * queryNodesStream() (pull via async generator).
 *
 * Backpressure model:
 * - Producer is faster: items buffer in `queue` (unbounded for V1)
 * - Consumer is faster: consumer waits on a pending Promise
 *
 * Lifecycle:
 * 1. Create StreamQueue
 * 2. Producer calls push() for each item, end() when done
 * 3. Consumer iterates with for-await-of
 * 4. Consumer can call return() to abort early
 */
export class StreamQueue<T> {
  private queue: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T, undefined>) => void;
    reject: (error: Error) => void;
  }> = [];
  private done: boolean = false;
  private error: Error | null = null;

  /**
   * Push an item into the queue. O(1) amortized.
   * If a consumer is waiting, resolves immediately. Otherwise buffers.
   */
  push(item: T): void {
    if (this.done) return; // Stream already ended, ignore
    if (this.waiters.length > 0) {
      // Consumer is waiting -- resolve immediately
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: item, done: false });
    } else {
      // Buffer the item
      this.queue.push(item);
    }
  }

  /**
   * Signal that no more items will be pushed. O(W) where W = waiting consumers.
   * Resolves all waiting consumers with done=true.
   */
  end(): void {
    this.done = true;
    // Resolve all waiting consumers
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /**
   * Signal an error. O(W) where W = waiting consumers.
   * Rejects all waiting consumers and marks stream as failed.
   */
  fail(error: Error): void {
    this.error = error;
    this.done = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.reject(error);
    }
  }

  /**
   * Pull the next item. O(1) amortized.
   * Returns immediately if items are buffered. Otherwise waits.
   */
  next(): Promise<IteratorResult<T, undefined>> {
    // Error: reject immediately
    if (this.error) {
      return Promise.reject(this.error);
    }

    // Buffered item available
    if (this.queue.length > 0) {
      const item = this.queue.shift()!;
      return Promise.resolve({ value: item, done: false });
    }

    // Stream ended and buffer empty
    if (this.done) {
      return Promise.resolve({ value: undefined, done: true as const });
    }

    // No items, not done -- wait for push/end/fail
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Consumer abort. Clears buffer and marks stream as done.
   * O(1) plus GC for buffer contents.
   */
  return(): Promise<IteratorResult<T, undefined>> {
    this.done = true;
    this.queue = [];
    this.waiters = [];
    return Promise.resolve({ value: undefined, done: true as const });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
```

### 5.1 Complexity Analysis (StreamQueue)

| Operation | Time | Space |
|-----------|------|-------|
| `push()` | O(1) amortized | O(1) per item buffered |
| `end()` | O(W) where W = number of waiting consumers (typically 0 or 1) | O(1) |
| `fail()` | O(W) | O(1) |
| `next()` | O(1) amortized | O(1) |
| `return()` | O(1) | Frees buffer |
| **Steady state** | O(1) per item | O(min(production_rate - consumption_rate, N)) |

In practice, `W` is at most 1 (only one consumer typically). The buffer grows only if the producer (socket) is faster than the consumer (async generator iteration), which is the expected case -- network delivers chunks faster than application processes them.

---

## 6. Phase 4: Client Chunk Routing (`packages/rfdb/ts/client.ts`)

### 6.1 New Instance Fields (~5 LOC)

Add to the `RFDBClient` class, after the existing `private _batchFiles` field (line 55):

```typescript
  // Streaming state
  private _supportsStreaming: boolean = false;
  private _pendingStreams: Map<number, StreamQueue<WireNode>> = new Map();
```

### 6.2 Import StreamQueue

Add import at the top of the file:

```typescript
import { StreamQueue } from './stream-queue.js';
```

### 6.3 Public Accessor for Feature Detection (~3 LOC)

Add as a public getter:

```typescript
  /**
   * Whether the connected server supports streaming responses.
   * Set after calling hello(). Defaults to false.
   */
  get supportsStreaming(): boolean {
    return this._supportsStreaming;
  }
```

### 6.4 Modify `hello()` Method (~5 LOC changed)

Current (lines 705-708):

```typescript
  async hello(protocolVersion: number = 2): Promise<HelloResponse> {
    const response = await this._send('hello' as RFDBCommand, { protocolVersion });
    return response as HelloResponse;
  }
```

New:

```typescript
  async hello(protocolVersion: number = 2): Promise<HelloResponse> {
    const response = await this._send('hello' as RFDBCommand, { protocolVersion });
    const hello = response as HelloResponse;
    this._supportsStreaming = hello.features?.includes('streaming') ?? false;
    return hello;
  }
```

### 6.5 Modify `_handleResponse()` for Chunk Routing (~30 LOC added)

The current `_handleResponse` (lines 173-202) resolves a single Promise per requestId and deletes the pending entry. For streaming, we need:

1. Detect streaming chunks (presence of `done` field).
2. Route chunk data to the `StreamQueue` for that requestId.
3. Keep the pending entry alive until `done: true`.
4. On `done: true`, call `stream.end()` and clean up.
5. Non-streaming responses: existing behavior unchanged.
6. **Auto-fallback:** If a streaming request (requestId in `_pendingStreams`) receives a non-streaming `Nodes` response (server doesn't support streaming), convert to single-batch delivery into the StreamQueue.

**New `_handleResponse` (replaces lines 173-202):**

```typescript
  private _handleResponse(response: RFDBResponse): void {
    if (this.pending.size === 0 && this._pendingStreams.size === 0) {
      this.emit('error', new Error('Received response with no pending request'));
      return;
    }

    let id: number;

    if (response.requestId) {
      const parsed = this._parseRequestId(response.requestId);
      if (parsed === null) {
        this.emit('error', new Error(`Received response for unknown requestId: ${response.requestId}`));
        return;
      }
      id = parsed;
    } else {
      // FIFO fallback for servers that don't echo requestId
      if (this.pending.size > 0) {
        id = (this.pending.entries().next().value as [number, PendingRequest])[0];
      } else {
        this.emit('error', new Error('Received response with no pending request'));
        return;
      }
    }

    // Check if this requestId is a streaming request
    const streamQueue = this._pendingStreams.get(id);

    if (streamQueue) {
      // This is a streaming request

      // Check if server sent a streaming chunk (has `done` field)
      if ('done' in response) {
        const chunk = response as unknown as { nodes?: WireNode[]; done: boolean; chunkIndex: number };
        const nodes = chunk.nodes || [];
        for (const node of nodes) {
          streamQueue.push(node);
        }

        if (chunk.done) {
          // Last chunk -- end the stream and clean up
          streamQueue.end();
          this._pendingStreams.delete(id);
          this.pending.delete(id);
        }
        // If !done, keep pending entry alive for next chunk
        return;
      }

      // Auto-fallback: server sent a non-streaming Nodes response
      // for a request we expected to be streamed.
      // This happens when the server doesn't support streaming.
      const nodesResponse = response as unknown as { nodes?: WireNode[] };
      const nodes = nodesResponse.nodes || [];
      for (const node of nodes) {
        streamQueue.push(node);
      }
      streamQueue.end();
      this._pendingStreams.delete(id);
      this.pending.delete(id);
      return;
    }

    // Non-streaming response -- existing behavior
    if (!this.pending.has(id)) {
      this.emit('error', new Error(`Received response for unknown requestId: ${response.requestId}`));
      return;
    }

    const { resolve, reject } = this.pending.get(id)!;
    this.pending.delete(id);

    if (response.error) {
      reject(new Error(response.error));
    } else {
      resolve(response);
    }
  }
```

### 6.6 Modify Socket Close Handler (~5 LOC added)

In the `close` event handler (lines 91-99), add cleanup for pending streams:

```typescript
      this.socket.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        // Reject all pending requests
        for (const [, { reject }] of this.pending) {
          reject(new Error('Connection closed'));
        }
        this.pending.clear();
        // Fail all pending streams
        for (const [, stream] of this._pendingStreams) {
          stream.fail(new Error('Connection closed'));
        }
        this._pendingStreams.clear();
      });
```

### 6.7 Complexity Analysis (Client Chunk Routing)

| Operation | Complexity |
|-----------|-----------|
| `_handleResponse` chunk detection | O(1) -- field presence check |
| Push N nodes from chunk to StreamQueue | O(N) per chunk, O(total) overall |
| Pending map lookup | O(1) -- Map.get() |
| Auto-fallback detection | O(1) -- same path |
| Connection close cleanup | O(S) where S = active streams |

No change to Big-O of existing non-streaming path. Streaming adds O(1) overhead per non-streaming response (one Map.get that returns undefined).

---

## 7. Phase 5: `queryNodesStream()` Method

### 7.1 New Method on RFDBClient (~40 LOC)

Add after `queryNodes()` (after line 583):

```typescript
  /**
   * Stream nodes matching query with true streaming support.
   *
   * Behavior depends on server capabilities:
   * - Server supports streaming: sends queryNodes, receives chunked NodesChunk
   *   responses via StreamQueue. Nodes are yielded as they arrive in chunks.
   * - Server does NOT support streaming (fallback): delegates to queryNodes()
   *   which sends one request, gets all results, yields them one by one.
   *
   * Usage:
   *   for await (const node of client.queryNodesStream({ nodeType: 'FUNCTION' })) {
   *     console.log(node.name);
   *   }
   *
   * The generator can be aborted by breaking out of the loop or calling .return().
   */
  async *queryNodesStream(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
    if (!this._supportsStreaming) {
      // Fallback: use existing bulk queryNodes
      yield* this.queryNodes(query);
      return;
    }

    // Streaming path: send request and consume via StreamQueue
    const serverQuery: Record<string, unknown> = {};
    if (query.nodeType) serverQuery.nodeType = query.nodeType;
    if (query.type) serverQuery.nodeType = query.type;
    if (query.name) serverQuery.name = query.name;
    if (query.file) serverQuery.file = query.file;
    if (query.exported !== undefined) serverQuery.exported = query.exported;

    // Create StreamQueue and register it BEFORE sending request
    // (response might arrive before _send's Promise resolves)
    const id = this.reqId++;
    const streamQueue = new StreamQueue<WireNode>();
    this._pendingStreams.set(id, streamQueue);

    // Build and send the request manually (can't use _send because
    // _send expects a single response and would resolve/reject the Promise)
    const request = { requestId: `r${id}`, cmd: 'queryNodes', query: serverQuery };
    const msgBytes = encode(request);

    const header = Buffer.alloc(4);
    header.writeUInt32BE(msgBytes.length);

    // Register in pending map for error handling / timeout
    const timeoutMs = RFDBClient.DEFAULT_TIMEOUT_MS;
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

    this.socket!.write(Buffer.concat([header, Buffer.from(msgBytes)]));

    // Yield from StreamQueue
    try {
      for await (const node of streamQueue) {
        yield node;
      }
      clearTimeout(timer);
    } finally {
      // Cleanup on consumer abort (break, return, throw)
      clearTimeout(timer);
      this._pendingStreams.delete(id);
      this.pending.delete(id);
    }
  }
```

### 7.2 Complexity Analysis

| Operation | Complexity |
|-----------|-----------|
| Fallback path | Same as existing `queryNodes()`: O(N) |
| Streaming path setup | O(1) |
| Per-node yield | O(1) amortized (StreamQueue.next) |
| Total streaming | O(N) where N = total nodes |
| Memory (streaming) | O(C) where C = chunk size (500 nodes max buffered at once) |
| Memory (fallback) | O(N) -- all nodes in memory |

---

## 8. Risk Assessment

### 8.1 Low Risk

| Risk | Mitigation |
|------|-----------|
| StreamQueue is a new data structure | Well-understood pattern (CSP channel). Exhaustively unit-tested. |
| `queryNodesStream()` fallback path | Delegates to battle-tested `queryNodes()`. Zero new logic. |
| Type additions to @grafema/types | Additive. No existing types modified. |
| `"streaming"` in Hello features | Clients that don't check for it are unaffected. |

### 8.2 Medium Risk

| Risk | Mitigation |
|------|-----------|
| **Server lock duration during streaming** | Read lock held for entire stream. Same as before (single-response path also holds lock). For V1 this is acceptable. If long-running streams block writers, we can release/re-acquire per chunk in a follow-up. |
| **`_handleResponse` complexity increase** | The function now has three paths (streaming chunk, streaming fallback, non-streaming). Each path is short and well-delineated. The streaming check is O(1) and doesn't affect non-streaming responses. |
| **Timeout for streaming requests** | A streaming request that delivers chunks slowly might hit the 60s timeout before all chunks arrive. Mitigation: the timer is set when the request starts. For very large result sets, chunks arrive quickly (500 nodes per chunk, serialization is fast). If this becomes an issue, we can reset the timer on each chunk arrival. |
| **`#[serde(untagged)]` enum ordering** | `NodesChunk` and `Nodes` both have `nodes` field. Since the server constructs the enum variant explicitly, serialization always produces the correct output. The `untagged` attribute only matters for deserialization, and we never deserialize `Response` on the server. No actual risk. |

### 8.3 High Risk

None identified. All changes are additive. Existing `queryNodes()` is untouched. Server sends single response for small results (< 100 nodes) exactly as before.

---

## 9. Test Plan

### 9.1 StreamQueue Unit Tests (6 tests)

**File: `packages/rfdb/ts/stream-queue.test.ts`** (new file)

```
Test 1: push-then-pull
  - push(1), push(2)
  - next() -> { value: 1, done: false }
  - next() -> { value: 2, done: false }

Test 2: pull-then-push (async wait)
  - Start next() -- returns pending Promise
  - push(42)
  - Promise resolves to { value: 42, done: false }

Test 3: end() terminates iteration
  - push(1), end()
  - next() -> { value: 1, done: false }
  - next() -> { value: undefined, done: true }

Test 4: fail() rejects waiting consumers
  - Start next() -- pending
  - fail(new Error('test'))
  - Promise rejects with 'test'

Test 5: return() aborts stream (consumer-initiated)
  - push(1), push(2)
  - return() -> { value: undefined, done: true }
  - next() -> { value: undefined, done: true }  (stream is done)

Test 6: for-await-of integration
  - push(1), push(2), push(3), end()
  - for await (const item of queue) { collect(item) }
  - collected === [1, 2, 3]
```

### 9.2 Feature Detection Tests (2 tests)

**File: `packages/rfdb/ts/client.test.ts`** (append to existing file)

```
Test 7: supportsStreaming defaults to false
  - Create RFDBClient
  - assert supportsStreaming === false

Test 8: hello() with streaming feature sets supportsStreaming
  - This test verifies the _supportsStreaming field is set correctly.
  - Since we can't call hello() without a server, test the mapping logic:
    - Simulate hello response with features: ["multiDatabase", "ephemeral", "streaming"]
    - Verify that 'streaming' in features -> supportsStreaming = true
    - Simulate hello response with features: ["multiDatabase", "ephemeral"]
    - Verify -> supportsStreaming = false
```

### 9.3 _handleResponse Chunk Routing Tests (3 tests)

**File: `packages/rfdb/ts/client.test.ts`** (append to existing file)

These test the StreamQueue + _handleResponse integration without a server.

```
Test 9: Non-streaming response -- existing behavior preserved
  - Verify that a response WITHOUT `done` field follows existing resolve/reject path
  - Type check: response with { nodes: [...] } but no done -> Nodes response

Test 10: Streaming chunk routing -- chunks pushed to StreamQueue
  - Create StreamQueue, register in _pendingStreams
  - Simulate _handleResponse with { requestId: "r1", nodes: [...], done: false, chunkIndex: 0 }
  - Verify nodes pushed to StreamQueue
  - Simulate { requestId: "r1", nodes: [...], done: true, chunkIndex: 1 }
  - Verify StreamQueue ended

Test 11: Auto-fallback -- non-streaming response for streaming request
  - Create StreamQueue, register in _pendingStreams
  - Simulate _handleResponse with { requestId: "r1", nodes: [...] } (no done field)
  - Verify all nodes pushed to StreamQueue AND stream ended
```

### 9.4 queryNodesStream Fallback Tests (2 tests)

**File: `packages/rfdb/ts/client.test.ts`** (append to existing file)

```
Test 12: queryNodesStream fallback when !supportsStreaming
  - Create client with _supportsStreaming = false
  - Verify queryNodesStream delegates to queryNodes (same results)
  - Since both need a server, test at the logic level:
    verify the method yields the same nodes as queryNodes would

Test 13: queryNodesStream is an async generator
  - Type check: return type is AsyncGenerator<WireNode, void, unknown>
  - Verify it implements Symbol.asyncIterator
```

### 9.5 Server Integration Tests (Rust -- `cargo test`)

**File: `packages/rfdb-server/src/bin/rfdb_server.rs`** (add #[cfg(test)] module or integration test file)

```
Test 14: Hello features includes "streaming"
  - Connect to server, send Hello
  - Assert features contains "streaming"

Test 15: QueryNodes small result -- single Nodes response
  - Add 50 nodes, QueryNodes
  - Receive single Response::Nodes (no done field, no chunking)

Test 16: QueryNodes large result -- streamed NodesChunk responses
  - Add 200 nodes (> STREAMING_THRESHOLD of 100)
  - Send QueryNodes
  - Receive multiple NodesChunk frames with done=false, final with done=true
  - Verify total nodes across all chunks === 200
  - Verify chunk_index is monotonically increasing starting from 0

Test 17: QueryNodes large result -- chunk sizes
  - Add 1200 nodes (> STREAMING_THRESHOLD)
  - QueryNodes
  - Expect 3 chunks: [500, 500, 200] nodes (with CHUNK_SIZE=500)
  - Verify last chunk has done=true, others have done=false

Test 18: Stream abort -- client disconnects mid-stream
  - Add 5000 nodes
  - Send QueryNodes, read first chunk, close connection
  - Server should log implicit cancel and not crash
```

---

## 10. File Change Summary

| File | Changes | LOC |
|------|---------|-----|
| `packages/types/src/rfdb.ts` | Add `NodesChunkResponse`, update `IRFDBClient` | ~25 |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Constants, `NodesChunk` variant, `HandleResult` enum, `handle_query_nodes_streaming()`, modified `handle_client()`, Hello features | ~130 |
| `packages/rfdb/ts/stream-queue.ts` | **NEW FILE** -- `StreamQueue<T>` class | ~80 |
| `packages/rfdb/ts/client.ts` | Import StreamQueue, add `_supportsStreaming` + `_pendingStreams`, modify `hello()`, modify `_handleResponse()`, add `queryNodesStream()`, modify close handler | ~100 |
| `packages/rfdb/ts/stream-queue.test.ts` | **NEW FILE** -- StreamQueue unit tests | ~80 |
| `packages/rfdb/ts/client.test.ts` | Add streaming feature detection + chunk routing tests | ~60 |
| Server integration tests | Hello features, small/large result, chunk sizes, abort | ~100 |
| **Total** | | **~575** |

---

## 11. Implementation Notes for Kent and Rob

### For Kent (Tests)

1. **StreamQueue tests first.** This is a pure data structure -- no dependencies, no mocking. Write all 6 tests before Rob implements.
2. **Client tests use the established pattern** in existing `client.test.ts`: create `RFDBClient` with nonexistent socket, test client-side logic without server. For chunk routing tests, you may need to expose `_handleResponse` or test through the public API.
3. **Server tests:** Use the existing integration test infrastructure in the Rust crate. The Hello test should be trivial. The streaming tests need a helper that reads multiple framed messages from the socket.

### For Rob (Implementation)

1. **Start with Phase 1 (types)** -- fastest, unblocks both server and client work.
2. **Server Phase 2:** The key architectural decision is the `HandleResult` enum. The `handle_query_nodes_streaming` function is a copy of the QueryNodes handler with chunk iteration added.
3. **Client Phase 4 (`_handleResponse`):** Be careful with the auto-fallback path. If the server sends a non-streaming `Nodes` response to a requestId that has a StreamQueue, push all nodes and end the stream. This makes the client work correctly with BOTH streaming and non-streaming servers.
4. **Phase 5 (`queryNodesStream`):** The tricky part is that we can't use `_send()` because it creates a Promise that expects a single resolution. Instead, manually build the request, write to socket, and register in both `pending` and `_pendingStreams`. The `pending` entry is used for error handling / timeout; the `_pendingStreams` entry is used for chunk routing.
5. **Build `pnpm build` before running TS tests.** Tests run against `dist/`, not `src/`.

### For Rob (Rust-specific)

1. **The `#[serde(untagged)]` enum:** Place `NodesChunk` BEFORE `Nodes` in the enum definition to avoid any ambiguity. Since we only serialize (never deserialize) `Response`, this is a style choice, not a correctness issue.
2. **The `is_last` calculation** in `handle_query_nodes_streaming`: use `ids.chunks()` which returns a `ChunksExact` iterator. The last chunk is the one where `chunk_start + STREAMING_CHUNK_SIZE >= total`. Use the `chunks()` method on slices (not iterators) since we already have `ids: Vec<u128>`.
3. **Metrics:** The streaming path records one `"QueryNodes:stream"` metric for the entire operation. The non-streaming path (small results) still goes through the existing metrics recording in `handle_client`.
4. **Error handling during streaming:** If `write_message` fails mid-stream (client disconnected), log and return `HandleResult::Streamed`. The partial stream is the best we can do -- the client will see a connection error and the StreamQueue will be failed.

---

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2026-02-15
**Status:** Ready for Steve Jobs review
