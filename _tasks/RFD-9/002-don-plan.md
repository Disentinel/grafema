# Don Melton - High-Level Plan: RFD-9 Client Batch API

## Architecture Decision

**Client-side batch state, single CommitBatch command to server (Option A).**

Why: The Rust server uses GraphEngine (v1), NOT MultiShardStore (v2). The `commit_batch()` from RFD-8 lives on MultiShardStore only. There is no path from wire protocol to that code today. Rather than wiring v2 storage into the server (a much larger task), we implement batch semantics using v1 GraphEngine primitives: `find_by_attr`, `delete_node`, `delete_edge`, `add_nodes`, `add_edges`, `flush`.

The client buffers nodes/edges locally during a batch. On `commitBatch()`, it sends a single `CommitBatch` command with all buffered data + the list of changed files. The server handler does the delete-old-add-new-flush-compute-delta dance atomically under a write lock.

This keeps the ~200 LOC budget, avoids session state on the server, and the client already has the data.

## Design Overview

```
TS Client (batch state)              Rust Server (stateless handler)
  beginBatch()
  addNodes([...]) → buffers locally
  addEdges([...]) → buffers locally
  commitBatch(tags?)                  → CommitBatch { changedFiles, nodes, edges, tags }
                                        1. find nodes by file → collect old IDs
                                        2. find edges from/to old IDs → delete
                                        3. delete old nodes
                                        4. add new nodes
                                        5. add new edges (skipValidation=true)
                                        6. flush
                                        7. compute delta (counts, types)
                                      ← BatchCommitted { delta: WireCommitDelta }
  abortBatch()   → clears buffers
```

## Layer 1: Rust Server (~60 LOC)

### 1.1 Wire Types (rfdb_server.rs)

Add to `Request` enum:
```rust
CommitBatch {
    #[serde(rename = "changedFiles")]
    changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    #[serde(default)]
    tags: Option<Vec<String>>,
}
```

Add to `Response` enum:
```rust
BatchCommitted {
    ok: bool,
    delta: WireCommitDelta,
}
```

New wire type:
```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCommitDelta {
    pub changed_files: Vec<String>,
    pub nodes_added: u64,
    pub nodes_removed: u64,
    pub edges_added: u64,
    pub edges_removed: u64,
    pub changed_node_types: Vec<String>,
    pub changed_edge_types: Vec<String>,
}
```

**Design note on WireCommitDelta vs storage_v2 CommitDelta:** The wire type is a simplified version. The v2 `CommitDelta` has `removed_node_ids: Vec<u128>`, `nodes_modified`, and `manifest_version` -- these are v2-storage concepts that don't apply to GraphEngine. The wire delta focuses on what the TS pipeline needs: counts and affected types/files. When the server eventually migrates to v2 storage, the wire type stays stable; only the server handler internals change.

### 1.2 Handler (rfdb_server.rs)

Add to `handle_request` match:
```rust
Request::CommitBatch { changed_files, nodes, edges, tags: _ } => {
    with_engine_write(session, |engine| {
        handle_commit_batch(engine, changed_files, nodes, edges)
    })
}
```

New function `handle_commit_batch`:
1. For each file in `changed_files`, find all nodes with that file using `find_by_attr({ file })`.
2. Collect all old node IDs. For each old node, get its outgoing and incoming edges.
3. Delete all old edges (both outgoing and incoming from/to old nodes).
4. Delete all old nodes.
5. Add new nodes (`add_nodes`).
6. Add new edges (`add_edges`, `skip_validation=true`).
7. Call `flush()`.
8. Build `WireCommitDelta` from the counts.

**Complexity:** O(F * N_per_file + E_per_node). F = number of changed files, N_per_file = nodes in those files, E_per_node = edges per node. This is NOT O(N_total) -- we use `find_by_attr({ file })` which uses file index when available, and we only process edges for affected nodes.

### 1.3 Metrics (rfdb_server.rs)

Add `"CommitBatch"` to `get_operation_name` match.

## Layer 2: TS Types (~30 LOC)

### 2.1 Commands (packages/types/src/rfdb.ts)

Add to `RFDBCommand` union:
```typescript
| 'commitBatch'
```

Note: `beginBatch` and `abortBatch` are client-only operations (no wire command needed).

### 2.2 CommitDelta Interface

```typescript
export interface CommitDelta {
  changedFiles: string[];
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  changedNodeTypes: string[];
  changedEdgeTypes: string[];
}
```

### 2.3 Request/Response Types

```typescript
export interface CommitBatchRequest extends RFDBRequest {
  cmd: 'commitBatch';
  changedFiles: string[];
  nodes: WireNode[];
  edges: WireEdge[];
  tags?: string[];
}

export interface CommitBatchResponse extends RFDBResponse {
  ok: boolean;
  delta: CommitDelta;
}
```

### 2.4 IRFDBClient Interface

Add to interface:
```typescript
// Batch operations
beginBatch(): void;
commitBatch(tags?: string[]): Promise<CommitDelta>;
abortBatch(): void;
isBatching(): boolean;
```

## Layer 3: TS Client (~80 LOC)

### 3.1 Batch State (client.ts)

Private fields:
```typescript
private _batching: boolean = false;
private _batchNodes: WireNode[] = [];
private _batchEdges: WireEdge[] = [];
private _batchFiles: Set<string> = new Set();
```

### 3.2 beginBatch()

```typescript
beginBatch(): void {
  if (this._batching) throw new Error('Batch already in progress');
  this._batching = true;
  this._batchNodes = [];
  this._batchEdges = [];
  this._batchFiles = new Set();
}
```

### 3.3 Modified addNodes() / addEdges()

When `_batching` is true, buffer locally instead of sending to server:
- Extract file paths from nodes → add to `_batchFiles`
- Push to `_batchNodes` / `_batchEdges`
- Return `{ ok: true }` immediately

When `_batching` is false, send to server as before (unchanged behavior).

### 3.4 commitBatch(tags?)

```typescript
async commitBatch(tags?: string[]): Promise<CommitDelta> {
  if (!this._batching) throw new Error('No batch in progress');

  const response = await this._send('commitBatch', {
    changedFiles: [...this._batchFiles],
    nodes: this._batchNodes,
    edges: this._batchEdges,
    tags,
  });

  this._batching = false;
  this._batchNodes = [];
  this._batchEdges = [];
  this._batchFiles = new Set();

  return (response as CommitBatchResponse).delta;
}
```

### 3.5 abortBatch()

```typescript
abortBatch(): void {
  this._batching = false;
  this._batchNodes = [];
  this._batchEdges = [];
  this._batchFiles = new Set();
}
```

### 3.6 Auto-Commit Detection

When `addNodes` is called outside a batch, this is the "legacy" mode -- today's behavior. No change needed for backwards compatibility. The auto-commit detection mentioned in the task spec is about the *pipeline* detecting this pattern and potentially warning -- NOT about forcing batch usage.

For now: `addNodes` outside a batch continues to work exactly as before (sends directly to server). We add a `isBatching()` method so callers can check. The pipeline can evolve to use batches incrementally.

**Rationale:** Breaking existing callers by requiring batches would be a catastrophic change. Every analyzer, enricher, and the Orchestrator itself calls `addNodes` directly. The batch API is opt-in.

### 3.7 findDependentFiles(changedFiles)

Client-side helper that queries the graph to find files affected by changes to `changedFiles`:

```typescript
async findDependentFiles(changedFiles: string[]): Promise<string[]> {
  // 1. Find all node IDs in changedFiles
  const nodeIds: string[] = [];
  for (const file of changedFiles) {
    const ids = await this.findByAttr({ file });
    nodeIds.push(...ids);
  }

  // 2. Backward reachability: who depends on nodes in changed files?
  if (nodeIds.length === 0) return [];
  const reachable = await this.reachability(
    nodeIds,
    2,  // depth 2: direct dependents + their files
    ['IMPORTS_FROM', 'DEPENDS_ON', 'CALLS'],
    true  // backward
  );

  // 3. Get file paths of reachable nodes
  const files = new Set<string>();
  for (const id of reachable) {
    const node = await this.getNode(id);
    if (node?.file && !changedFiles.includes(node.file)) {
      files.add(node.file);
    }
  }

  return [...files];
}
```

**Complexity:** O(|changedFiles| * find_by_attr_cost + reachability_cost). Reachability at depth 2 is bounded. This uses existing graph traversal -- no new iteration over all nodes.

**Performance note:** For large change sets, this could be optimized by batching the `findByAttr` calls into a single query. That's a future improvement, not needed for the ~200 LOC target.

## Layer 4: Tests (~15 tests)

### 4.1 Client Unit Tests (TS, ~7 tests)

1. **beginBatch sets state** -- `isBatching()` returns true
2. **addNodes during batch buffers locally** -- no `_send` call
3. **addEdges during batch buffers locally** -- no `_send` call
4. **commitBatch sends buffered data** -- verify payload structure
5. **abortBatch clears buffers** -- verify empty state, `isBatching()` false
6. **double beginBatch throws** -- error on nested batch
7. **commitBatch without beginBatch throws** -- error on no batch

These are pure unit tests that mock `_send`. They verify client-side batch state management.

### 4.2 CommitDelta Type Tests (TS, ~2 tests)

8. **CommitDelta interface shape** -- type guard / assertion
9. **findDependentFiles returns correct files** -- mock graph with known edges

### 4.3 Rust Handler Tests (~3 tests)

10. **CommitBatch replaces nodes for changed files** -- add nodes, commit with same files, verify old removed
11. **CommitBatch returns correct delta** -- verify counts and types in response
12. **CommitBatch with empty changedFiles** -- just adds, no deletion

### 4.4 Integration Tests (~3 tests)

13. **Batch round-trip: TS client -> Rust server** -- begin, add, commit, verify delta
14. **Abort discards: TS client -> Rust server** -- begin, add, abort, verify nothing changed
15. **addNodes without batch still works** -- legacy behavior preserved

## Commit Strategy

| Commit | Scope | LOC |
|--------|-------|-----|
| C1 | TS types: `CommitDelta`, `commitBatch` command, request/response types, `IRFDBClient` additions | ~30 |
| C2 | Rust: `CommitBatch` request/response + handler + `WireCommitDelta` + metrics entry + Rust tests | ~60 |
| C3 | TS client: batch state, `beginBatch/commitBatch/abortBatch`, `isBatching`, modified addNodes/addEdges | ~60 |
| C4 | TS client: `findDependentFiles` + unit tests + integration tests | ~50 |

**Total: ~200 LOC, 15 tests.**

## Risks & Mitigations

1. **find_by_attr({file}) performance for many files** -- Current GraphEngine uses file index (built on flush). For pre-flush delta nodes, it scans delta_nodes HashMap (fast, in-memory). Not a concern for typical batch sizes (1-50 files).

2. **Edge cleanup completeness** -- Must delete both outgoing AND incoming edges for old nodes. Missing incoming edges would leave dangling references. The handler explicitly collects both via `get_outgoing_edges` and `get_incoming_edges`.

3. **Atomicity** -- GraphEngine write lock (`db.engine.write().unwrap()`) ensures the entire commit is atomic. No other client can read inconsistent state during the delete-add-flush sequence.

4. **Backwards compatibility** -- Zero changes to existing `addNodes`/`addEdges` behavior when not batching. All existing callers continue to work unchanged.

## What This Does NOT Do

- **No server-side session state** -- All batch state lives in the TS client.
- **No migration to v2 storage** -- Uses GraphEngine v1 primitives.
- **No forced batch mode** -- Legacy `addNodes` without batch still works.
- **No `tags` processing** -- The `tags` field is accepted but ignored (placeholder for future metadata tagging on commits). Wire format includes it for forward compatibility.
