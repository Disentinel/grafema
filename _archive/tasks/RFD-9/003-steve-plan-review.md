# Steve Jobs Review: RFD-9 Client Batch API Plan

**Verdict: APPROVE** (with one mandatory fix before implementation)

---

## Vision Alignment

This plan aligns with the project vision. The batch API is a necessary primitive for "AI should query the graph, not read code" -- agents analyzing code need to commit file-level changes atomically, get back a delta describing what changed, then use that delta to determine what needs re-analysis. Without batch semantics, every `addNodes` call is fire-and-forget with no feedback loop. This closes a real gap.

## Architecture Analysis

### Client-Side Batch State (GOOD)

The decision to buffer on the client side and keep the server stateless is the right call. Server-side session state would mean:
- Server crashes lose batch state
- Connection drops leave orphaned sessions
- More complex error handling

Client-side buffering is simpler, safer, and naturally handles disconnects (client just aborts).

### Using v1 GraphEngine primitives (ACCEPTABLE)

The plan correctly identifies that `commit_batch()` from RFD-8 lives on `MultiShardStore` (v2), not on `GraphEngine` (v1) which the server actually uses. Building batch semantics from v1 primitives (`find_by_attr`, `delete_node`, `delete_edge`, `add_nodes`, `add_edges`, `flush`) is pragmatic. The alternative -- wiring v2 storage into the server -- would be a much larger undertaking that would derail this task.

The wire type (`WireCommitDelta`) is correctly designed as a stable API boundary. When the server eventually migrates to v2 storage, only the handler internals change. The plan explicitly documents this. Good.

### Complexity Check: PASS

1. **CommitBatch handler:** O(F * N_per_file + E_per_node). Uses `find_by_attr({ file })` which hits the file index (segment) or scans delta_nodes (in-memory HashMap). This is NOT O(N_total). It only touches nodes belonging to changed files. For typical batch sizes (1-50 files, hundreds of nodes), this is fine.

2. **Edge cleanup:** Uses `get_outgoing_edges` and `get_incoming_edges` per old node. Both use adjacency/reverse_adjacency lists, which are O(degree). Not O(E_total).

3. **findDependentFiles:** Uses existing `reachability()` at depth 2 on the server (single RPC). The reachability result is bounded by depth. The only concern is the individual `getNode` calls per reachable node (see mandatory fix below).

### Plugin Architecture Check: PASS

- No backward pattern scanning
- Reuses existing GraphEngine methods (find_by_attr, delete_node, delete_edge, add_nodes, add_edges, flush)
- Reuses existing wire protocol patterns (Request enum, Response enum, RequestEnvelope)
- Adding new batch-aware callers requires zero changes to the server handler

### Extensibility Check: PASS

- `WireCommitDelta` is a stable wire type that survives v2 migration
- `tags` field in the request is forward-compatible (accepted, ignored for now)
- `findDependentFiles` uses configurable edge types for backward reachability

### Backwards Compatibility: PASS

- `addNodes`/`addEdges` outside a batch work exactly as before
- No existing caller needs to change
- Batch API is opt-in

## Concern-by-Concern Evaluation

### Concern 1: Partial state during write lock

**Not an issue.** The entire `handle_commit_batch` runs inside `with_engine_write`, which holds `db.engine.write().unwrap()`. This is a `RwLock` write guard -- no concurrent reads are possible. The plan correctly identifies this.

### Concern 2: Edge cleanup -- both outgoing AND incoming

**Correct and necessary.** When deleting old nodes for a changed file, you must delete:
- Outgoing edges FROM old nodes (obvious)
- Incoming edges TO old nodes (critical -- otherwise other files' edges would point at deleted nodes, creating dangling references)

The plan explicitly handles both directions. This is the right approach.

### Concern 3: findDependentFiles -- O(N) individual getNode RPCs

**MANDATORY FIX REQUIRED.** The plan shows:

```typescript
for (const id of reachable) {
  const node = await this.getNode(id);
  if (node?.file && !changedFiles.includes(node.file)) {
    files.add(node.file);
  }
}
```

This is N sequential RPCs over Unix socket for N reachable nodes. For a large codebase with many dependents, this could be hundreds or thousands of individual round-trips.

**Fix:** Use `queryNodes` or batch `findByAttr` or simply have the server return file information from the reachability result. The simplest fix within the ~200 LOC budget: collect all reachable IDs, then use a single `queryNodes` call to get their file attributes in one RPC, or better yet -- use the existing `getNode` calls but batch them. Actually, looking at the existing API, the cleanest approach is to extract files from nodes by collecting reachable IDs and calling `getAllNodes` with an ID filter, or even simpler: do the file extraction on the server side (add a `findDependentFiles` command that returns file paths directly).

However -- this is a client-side helper, and the reachability at depth 2 is naturally bounded. For a practical MVP, the loop over `getNode` is acceptable IF we document the known performance limitation and create a follow-up issue. The depth-2 bound means at most hundreds of nodes in typical codebases.

**Revised verdict on Concern 3:** Acceptable for MVP. The depth-2 bound on reachability provides a natural cap. But this MUST be called out as a known limitation with a plan to optimize (e.g., server-side `findDependentFiles` command returning file paths directly).

### Concern 4: Tags field accepted but ignored

**Acceptable.** This is forward-compatible wire design. The field is documented as a placeholder. It doesn't add dead code or complexity -- it's a single `tags: _` in the match arm. No dead feature, just future-proofing the wire protocol.

### Concern 5: Reuse Before Build

**PASS.** The plan reuses:
- Existing `Request`/`Response` enum pattern
- Existing `with_engine_write` helper
- Existing `find_by_attr`, `delete_node`, `delete_edge`, `add_nodes`, `add_edges`, `flush` methods
- Existing `reachability` for `findDependentFiles`
- Existing wire protocol infrastructure (MessagePack, length-prefix framing, RequestEnvelope)

No new subsystems are created. This is exactly the right approach.

## What I Verified in the Codebase

1. **GraphEngine has all required methods:** `find_by_attr` (line 783), `delete_node` (line 725), `delete_edge` (line 1022), `add_nodes` (line 715), `add_edges` (line 992), `flush` (line 1073), `get_outgoing_edges` (line 1283), `get_incoming_edges` (line 1350). All confirmed present and usable.

2. **find_by_attr uses file index:** The segment search path uses `index_set.find_by_file()` when a file query is present (confirmed in engine.rs around line 836-840). Delta nodes are searched in-memory via HashMap iteration. This is not a full scan.

3. **get_incoming_edges uses reverse_adjacency:** Confirmed at line 1355. This is O(degree), not O(E_total).

4. **Wire protocol pattern is established:** Request enum is `#[serde(tag = "cmd")]`, Response is `#[serde(untagged)]`, envelope captures `requestId`. Adding `CommitBatch` variant follows existing patterns exactly.

5. **TS client has `_send` method for new commands:** Confirmed the client sends commands via `_send(cmd, payload)` pattern. Adding `commitBatch` follows the same path.

## Commit Strategy Review

The 4-commit plan is clean:
- C1: Types only (no behavior change)
- C2: Rust handler (self-contained, testable)
- C3: TS client batch state (uses C1 types, talks to C2 server)
- C4: findDependentFiles + integration tests

Each commit is atomic and independently testable. Good.

## Summary

The plan is architecturally sound. It makes the right pragmatic choice (v1 primitives over premature v2 migration), reuses existing infrastructure, maintains backwards compatibility, and has correct complexity characteristics. The `findDependentFiles` performance concern is bounded by depth-2 reachability and acceptable for MVP if documented.

**One mandatory documentation requirement:** Add a comment in `findDependentFiles` noting the N-RPC pattern and that a server-side optimization (single command returning file paths) should be considered when this becomes a hot path.
