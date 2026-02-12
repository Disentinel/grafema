# Track 3: TS RFDB Client v3 Spec

> Date: 2026-02-11
> Input: 004-expert-concerns.md, 002-roadmap.md, current client exploration
> Status: DRAFT — requires expert review + user approval

---

## 1. Current State (As-Is)

### RFDBClient (`packages/rfdb/ts/client.ts`, 752 LOC)

- Unix socket + MessagePack over length-prefixed frames (`[4-byte BE length][msgpack payload]`)
- **FIFO response matching** — no request IDs in responses. Responses must arrive in order.
- 60-second timeout per request
- Sequential request/response (no pipelining, no multiplexing)
- EventEmitter: `connected`, `disconnected`, `error`

### RFDBServerBackend (`packages/core/src/.../RFDBServerBackend.ts`, 791 LOC)

- Wraps RFDBClient, implements `GraphBackend` interface
- **Metadata hacks:**
  - `originalId` on nodes — preserves human-readable ID (RFDB uses u128 internally)
  - `_origSrc`/`_origDst` on edges — preserves original string IDs
  - All non-standard fields stuffed into `metadata` JSON string
- Server auto-start (spawns RFDB process if not running, detached)
- Multi-client architecture (server survives client disconnect)

### Wire Protocol v2 (current)

```
Request:  { cmd: "addNodes", nodes: [...] }
Response: { ok: true } or { error: "message" }
```

~40 commands. No batching transaction, no streaming, no snapshots.

---

## 2. What Changes

### Wire Protocol v3

| Feature | v2 (current) | v3 (target) |
|---------|-------------|-------------|
| Response matching | FIFO | Request ID (optional, FIFO fallback) |
| Transactions | None | BeginBatch → AddNodes/AddEdges → CommitBatch |
| Streaming | None | Chunked responses with `{ chunk, done }` |
| Snapshots | None | TagSnapshot, DiffSnapshots, FindSnapshot |
| ID format | u128 opaque (metadata hacks) | semantic_id string (first-class column) |
| Metadata | JSON string with hacks | Clean JSON (no originalId/_origSrc/_origDst) |

### Removed Commands

| Command | Replacement |
|---------|-------------|
| `deleteNode` | Implicit via CommitBatch (tombstoning) |
| `deleteEdge` | Implicit via CommitBatch (tombstoning) |
| `updateNodeVersion` | Snapshot chain (version = manifest number) |
| `getAllEdges` | Streaming `queryEdges` with filters |

### New Commands

| Command | Purpose |
|---------|---------|
| `beginBatch` | Start write transaction |
| `commitBatch` | Atomic commit, returns delta |
| `abortBatch` | Discard buffered writes |
| `diffSnapshots` | Detailed diff between two snapshots |
| `tagSnapshot` | Tag current snapshot with key-value |
| `findSnapshot` | Resolve tag to snapshot number |
| `listSnapshots` | List snapshots, filter by tag |
| `deleteSnapshot` | Remove snapshot, GC unique segments |

---

## 3. Frame Protocol

### v2 (current — unchanged)

```
[4-byte BE length][MessagePack payload]
```

Stays the same. No breaking change to frame layer.

### Request Format (v3)

```typescript
// With request ID (enables streaming + multiplexing)
{ requestId: "r1", cmd: "queryNodes", query: { nodeType: "FUNCTION" } }

// Without request ID (FIFO matching, backward compat)
{ cmd: "addNodes", nodes: [...] }
```

`requestId` is optional. If omitted → FIFO matching (v2 behavior). If present → response matched by ID.

### Response Format (v3)

```typescript
// Non-streaming (single response)
{ requestId: "r1", nodes: [...] }

// Streaming (chunked)
{ requestId: "r1", chunk: [...100 nodes...], done: false }
{ requestId: "r1", chunk: [...100 nodes...], done: false }
{ requestId: "r1", chunk: [...50 nodes...], done: true }

// Error
{ requestId: "r1", error: "message" }

// FIFO (no requestId)
{ ok: true }
{ error: "message" }
```

---

## 4. RFDBClient v3 API

### Connection (unchanged)

```typescript
const client = new RFDBClient(socketPath);
await client.connect();
await client.close();
```

### Request IDs

```typescript
class RFDBClient {
  private requestCounter = 0;
  private pending: Map<string, PendingRequest>;  // requestId → resolver

  private nextRequestId(): string {
    return `r${++this.requestCounter}`;
  }

  private async send(cmd: string, payload: object, opts?: SendOptions): Promise<Response> {
    const requestId = this.nextRequestId();
    const request = { requestId, cmd, ...payload };
    // ... encode, send, track in pending by requestId
  }
}
```

**Response matching changes:**
- v2: `pending` is Map<number, resolver>, pop from FIFO
- v3: `pending` is Map<string, resolver>, match by `requestId` field in response

**Backward compat:** If response has no `requestId` → FIFO fallback (for old servers).

### Batch API

```typescript
async beginBatch(): Promise<void> {
  await this.send('beginBatch', {});
}

async commitBatch(tags?: Record<string, string>): Promise<CommitDelta> {
  const response = await this.send('commitBatch', { tags });
  return response as CommitDelta;
}

async abortBatch(): Promise<void> {
  await this.send('abortBatch', {});
}
```

```typescript
interface CommitDelta {
  snapshot: number;
  previousSnapshot: number;
  changedFiles: string[];
  nodesAdded: number;
  nodesRemoved: number;
  nodesModified: number;
  removedNodeIds: string[];      // Semantic ID strings (N7)
  edgesAdded: number;
  edgesRemoved: number;
  changedNodeTypes: string[];    // e.g., ["FUNCTION", "VARIABLE"]
  changedEdgeTypes: string[];    // e.g., ["CALLS", "IMPORTS"]
}
```

### Streaming API (I7)

```typescript
async *queryNodesStream(
  query: NodeQuery
): AsyncGenerator<NodeRecord[], void, unknown> {
  const requestId = this.nextRequestId();
  const request = { requestId, cmd: 'queryNodes', query, stream: true };

  // Send request
  this.sendFrame(request);

  // Yield chunks as they arrive
  while (true) {
    const chunk = await this.waitForChunk(requestId);
    yield chunk.nodes;
    if (chunk.done) break;
  }
}
```

**Non-streaming (default):**
```typescript
async queryNodes(query: NodeQuery): Promise<NodeRecord[]> {
  return await this.send('queryNodes', { query });
}
```

**Auto-fallback (I7):** If server returns `streaming: true` header in response (result exceeded threshold), client switches to chunk parsing even without explicit `stream: true` request.

### Snapshot API

```typescript
async diffSnapshots(
  from: number | { tag: string; value: string },
  to: number | { tag: string; value: string }
): Promise<SnapshotDiff> {
  return await this.send('diffSnapshots', { from, to });
}

async tagSnapshot(tags: Record<string, string>): Promise<{ snapshot: number }> {
  return await this.send('tagSnapshot', { tags });
}

async findSnapshot(tag: string, value: string): Promise<{ snapshot: number } | null> {
  return await this.send('findSnapshot', { tag, value });
}

async listSnapshots(filter?: { tag?: string; value?: string }): Promise<SnapshotInfo[]> {
  return await this.send('listSnapshots', filter || {});
}
```

```typescript
interface SnapshotDiff {
  addedNodes: string[];      // Semantic IDs
  removedNodes: string[];
  modifiedNodes: string[];
  addedEdges: EdgeRecord[];
  removedEdges: EdgeRecord[];
}
```

---

## 5. RFDBServerBackend v3

### Metadata Cleanup

**v2 (current):**
```typescript
// addNodes: stuff originalId into metadata
metadata: JSON.stringify({ originalId: String(id), ...rest })

// addEdges: stuff _origSrc/_origDst into metadata
metadata: JSON.stringify({ _origSrc: String(src), _origDst: String(dst), ...rest })

// parseNode: extract originalId back, spread rest
const humanId = metadata.originalId || wireNode.id;
```

**v3 (target):**
```typescript
// addNodes: semantic_id is first-class column, no hack needed
{ semanticId: id, nodeType, name, file, contentHash, metadata: JSON.stringify(rest) }

// addEdges: src/dst are semantic_id strings, no _origSrc/_origDst
{ src: String(src), dst: String(dst), edgeType, metadata: JSON.stringify(rest) }

// parseNode: semantic_id is in response, no extraction needed
{ id: wireNode.semanticId, type: wireNode.nodeType, ...rest }
```

### GraphBackend v2 Interface Changes

```typescript
abstract class GraphBackend {
  // NEW: batch operations
  abstract beginBatch(): Promise<void>;
  abstract commitBatch(tags?: Record<string, string>): Promise<CommitDelta>;
  abstract abortBatch(): Promise<void>;

  // NEW: snapshot operations
  abstract diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<SnapshotDiff>;

  // NEW: streaming queries
  abstract queryNodesStream(query: NodeQuery): AsyncGenerator<NodeRecord[]>;

  // CHANGED: addNodes includes content_hash
  abstract addNodes(nodes: NodeRecord[]): Promise<void>;
  // content_hash is a field on NodeRecord, not separate

  // REMOVED: deleteNode, deleteEdge (handled by CommitBatch)
  // REMOVED: updateNodeVersion (handled by snapshot chain)

  // UNCHANGED: getNode, nodeExists, findByAttr, addEdge, addEdges,
  //            getOutgoingEdges, getIncomingEdges, bfs, flush, getStats, queryNodes
}
```

### Blast Radius Query (C4 support)

```typescript
// New method on GraphBackend for pre-commit blast radius
abstract findDependentFiles(changedFiles: string[]): Promise<string[]>;
```

Implementation:
```typescript
async findDependentFiles(changedFiles: string[]): Promise<string[]> {
  // Query: edges where dst.file ∈ changedFiles AND src.file ∉ changedFiles
  // Returns unique src.file values
  const result = await this.client.send('findDependentFiles', {
    files: changedFiles
  });
  return result.dependentFiles;
}
```

This could be a dedicated RFDB command or composed from existing edge queries. Dedicated command is more efficient (single scan with dst bloom filter).

---

## 6. Backpressure (Q2)

### Socket-Level

TCP/Unix socket has built-in backpressure:
- Socket has OS-level send/receive buffers (~128KB default on macOS)
- When client stops reading → receive buffer fills → sender's write() blocks
- RFDB server (async Rust) → writer task yields when socket buffer full

### Application-Level

```typescript
// Streaming consumer controls pace
for await (const chunk of client.queryNodesStream(query)) {
  await processChunk(chunk);  // Backpressure: next chunk not requested until this completes
}
```

### Timeout Policy

If client doesn't read for 30 seconds → server aborts stream, logs warning. Configurable per-request.

---

## 7. Migration Strategy

### Phase 1: Request IDs (non-breaking)

1. Client sends `requestId` in all requests
2. Old server ignores it, responds FIFO → client detects missing `requestId` in response → FIFO fallback
3. New server echoes `requestId` → client matches by ID
4. Zero breaking changes to existing code

### Phase 2: Semantic ID Column (breaking)

1. Wire format changes: `semanticId` field instead of `id` + `metadata.originalId`
2. **Server must be v3** — no backward compat for this
3. RFDBServerBackend stops stuffing/extracting metadata hacks
4. Migration: version handshake at connect time (`hello` command returns protocol version)

### Phase 3: Batch + Streaming

1. Add `beginBatch`/`commitBatch`/`abortBatch` methods
2. Add streaming response parser
3. Add `CommitDelta` type
4. Orchestrator switches from `addEdges()` → batch protocol

### Phase 4: Snapshots

1. Add snapshot commands
2. Used by orchestrator for DiffSnapshots after CommitBatch

---

## 8. Version Handshake

```typescript
async connect(): Promise<void> {
  await this.socket.connect();
  const hello = await this.send('hello', { clientVersion: 3 });

  this.serverVersion = hello.protocolVersion;  // 2 or 3
  this.features = hello.features;  // ["requestIds", "batch", "streaming", "snapshots"]

  // Adapt behavior based on server capabilities
  this.useRequestIds = this.features.includes('requestIds');
  this.useBatch = this.features.includes('batch');
}
```

Enables gradual rollout: client v3 can talk to server v2 (degraded mode) or server v3 (full features).

---

## 9. Implementation Phases

### Phase A: Request IDs + Response Matching (can start now)

1. Add `requestId` to all outgoing requests
2. Change `pending` Map to match by requestId
3. FIFO fallback for responses without requestId
4. Tests: concurrent requests with requestIds matched correctly

**No server changes needed** — server echoes requestId if present (trivial Rust change).

### Phase B: Semantic ID Wire Format (requires RFDB Phase 0)

1. New `WireNodeV3` / `WireEdgeV3` types with `semanticId`
2. Remove `originalId`/`_origSrc`/`_origDst` hacks
3. Version handshake to detect server capabilities
4. RFDBServerBackend cleanup

### Phase C: Batch API (requires RFDB Phase 4)

1. Add `beginBatch`/`commitBatch`/`abortBatch`
2. Add `CommitDelta` type and parsing
3. Add `findDependentFiles` for C4 blast radius
4. Tests: batch commit returns correct delta

### Phase D: Streaming (requires RFDB Phase 5)

1. Streaming response parser (chunk accumulation)
2. `queryNodesStream()` async generator
3. Auto-fallback detection (server-initiated streaming)
4. Backpressure via async iteration
5. Tests: large result set via streaming = same as non-streaming

### Phase E: Snapshots (requires RFDB Phase 3)

1. `diffSnapshots`, `tagSnapshot`, `findSnapshot`, `listSnapshots`
2. Snapshot reference types (by number or by tag)
3. Tests: tag → find → diff workflow

---

## 10. Dependencies on Other Tracks

| Client Phase | Depends on RFDB Phase | Depends on Orchestrator Phase |
|-------------|----------------------|-------------------------------|
| Phase A (requestIds) | Trivial server change | None |
| Phase B (semanticId) | Phase 0 (segment format) + Phase 5 (wire) | None |
| Phase C (batch) | Phase 4 (CommitBatch) | Phase B (batch protocol) |
| Phase D (streaming) | Phase 5 (streaming) | None |
| Phase E (snapshots) | Phase 1+3 (manifests + snapshots) | None |

**Phase A can start immediately.**

---

## 11. Test Strategy

### Backward Compat Tests

- Client v3 → Server v2: all existing operations work (FIFO mode)
- Client v3 → Server v3: all operations work with requestIds

### Protocol Tests

- Request ID echo: send with requestId → response has same requestId
- FIFO fallback: response without requestId → matched to oldest pending
- Concurrent requests: 10 parallel sends → all responses matched correctly
- Timeout: request with requestId times out → only that request fails, others unaffected

### Batch Tests

- BeginBatch → AddNodes → CommitBatch → delta correct
- BeginBatch → AbortBatch → nothing committed
- AddNodes without BeginBatch → auto-commit (backward compat)
- CommitBatch with tags → tags stored in snapshot

### Streaming Tests

- Small result (<100 nodes) → non-streaming response
- Large result (>1000 nodes) → chunked streaming response
- Server-initiated streaming (auto-fallback) → client handles correctly
- Backpressure: slow consumer → server doesn't OOM
- Stream abort: client cancels → server stops sending

### Integration Tests

- Full workflow: connect → batch → commit → diff → verify
- Blast radius: add nodes → query dependents → correct file set
- Multi-client: two clients → same server → independent batches

---

## 12. Relationship to Concerns

| Concern | Where Addressed | Section |
|---------|----------------|---------|
| I1 | Phase 5 decomposed into Client Phases A-E | §9 |
| I7 | Streaming opt-in + auto-fallback | §4, §6 |
| Q2 | Backpressure via TCP + async iteration | §6 |
| I2 | Enrichment shard file context in CommitBatch | §5 |
| I4 | content_hash as NodeRecord field | §5 |
| N7 | removedNodeIds in CommitDelta | §4 |
