# Steve Jobs Review: RFD-9 Execution

**Verdict: REJECT**

---

## What's Good

The implementation follows the approved plan closely. Types are clean, the wire protocol additions are well-structured, the client-side batch state management is correct, and the tests cover the documented behavior. The TS client's `beginBatch/commitBatch/abortBatch` flow is simple and correct. The `findDependentFiles` has the documented N+1 RPC note as required by the plan review.

None of that matters if the core operation is broken for production databases.

---

## Critical Bug: Segment Edge Deletion is a No-Op

**This is not a minor concern. This is a correctness bug that makes CommitBatch silently corrupt the graph on production (non-ephemeral) databases.**

### The Problem

`handle_commit_batch` calls `engine.delete_edge(src, dst, edge_type)` to remove old edges. But `delete_edge` internally does:

```rust
fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str) {
    let delta = Delta::DeleteEdge { src, dst, edge_type: edge_type.to_string() };
    self.delta_log.push(delta.clone());
    self.apply_delta(&delta);
    self.edge_keys.remove(&(src, dst, edge_type.to_string()));
}
```

And `apply_delta(Delta::DeleteEdge)` does:

```rust
Delta::DeleteEdge { src, dst, edge_type } => {
    for edge in &mut self.delta_edges {
        let matches = edge.src == *src && edge.dst == *dst &&
            edge.edge_type.as_deref() == Some(edge_type.as_str());
        if matches {
            edge.deleted = true;
        }
    }
}
```

This **only marks edges in `self.delta_edges`** as deleted. Edges that have been flushed to segments are NOT in `delta_edges` -- they're in `self.edges_segment`. The segment-level `is_deleted` flag is only set at write time by the `SegmentWriter`, not by `apply_delta`.

Then `flush()` collects segment edges by checking `segment.is_deleted(idx)`, which reflects the persisted flag, not the runtime deletion state. The deleted segment edges pass right through.

### The Consequence

On a production database where prior data has been flushed:

1. `find_by_attr({file: "changed.js"})` correctly finds old node IDs in the segment
2. `get_outgoing_edges(old_node_id)` correctly returns segment edges
3. `delete_edge(src, dst, type)` is a **no-op** for those segment edges
4. `flush()` at the end of `handle_commit_batch` re-writes the segment including those "deleted" edges
5. **Result: dangling edges pointing to deleted nodes survive in the graph**

This corrupts the graph. Queries that traverse these dangling edges will either crash, return garbage, or produce wrong analysis results.

### Why the Tests Don't Catch It

All three Rust tests use `setup_ephemeral_db`. For ephemeral databases, `flush()` is a no-op (`self.delta_log.clear(); return Ok(());`). Data never moves from delta to segments. So `delete_edge` works correctly because edges are always in `delta_edges`.

The tests are testing a fundamentally different code path than what production databases use. This is exactly the kind of testing gap that makes a feature "work in tests, fail in production."

### The Fix

The handler needs to collect old edge keys BEFORE deleting, and pass them to flush, OR the handler should add old edges to `delta_edges` with `deleted = true` so they override segment edges during flush, OR the handler should mark segment edges for deletion through the existing `deleted_segment_ids` pattern (but there's no equivalent for edges -- `deleted_segment_edge_indices` doesn't exist).

The simplest correct fix: in `handle_commit_batch`, instead of calling `engine.delete_edge()` per edge, collect all old node IDs into a HashSet, then during the flush phase, filter out any segment edge whose src OR dst is in that set. But this requires either extending the flush mechanism or doing a two-phase approach where old nodes+edges are deleted and new ones added without relying on `delete_edge` for segment edges.

Alternatively: the handler can avoid the problem entirely by not calling `delete_edge` on individual edges. Instead, it can leverage the fact that `flush()` rebuilds segments from scratch (for non-ephemeral). If the handler deletes old nodes (via `delete_node` which adds to `deleted_segment_ids`), then the flush will exclude those nodes. But edges whose src/dst are deleted nodes will still be written. The flush needs an additional filter: skip segment edges where src or dst is in `deleted_segment_ids`.

---

## Secondary Bug: edges_removed Double-Counting (Segment Edges Only)

For two nodes A and B both in `changedFiles`, if edge A->B exists in the segment:

1. Processing A: `get_outgoing_edges(A)` returns A->B. `delete_edge(A,B,type)` is a no-op (segment edge). `edges_removed += 1`.
2. Processing B: `get_incoming_edges(B)` returns A->B again (still in segment, not deleted). `delete_edge(A,B,type)` is again a no-op. `edges_removed += 1`.

Result: `edges_removed` reports 2 for a single edge.

For delta edges (ephemeral DBs), this doesn't happen because the first `delete_edge` marks the delta edge as deleted, so `get_incoming_edges` doesn't return it. But for segment edges, the double-count is real.

This is a secondary issue compared to the primary bug (edges not actually being deleted), but it means the delta counts are unreliable for cross-file edges in production.

---

## Missing Test: Non-Ephemeral CommitBatch

There is no test that verifies CommitBatch works on a non-ephemeral database. The test infrastructure supports this (the `setup_test_manager` creates a real temp directory). A test that does:

1. Create non-ephemeral DB
2. Add nodes and edges
3. Flush (writes to segment)
4. CommitBatch (replaces nodes)
5. Verify old edges are actually gone (not just counted)

This test would FAIL with the current implementation and would have caught the bug.

---

## Everything Else is Fine

To be clear, the parts that work correctly:

- **TS types**: Clean, well-structured, match the wire format
- **Client batch state management**: Correct. `beginBatch/commitBatch/abortBatch` handle all edge cases properly
- **Client-side buffering in addNodes/addEdges**: Correct bypass of `_send` when batching
- **findDependentFiles**: Correct implementation with documented limitation
- **Wire protocol additions**: Follow existing patterns, forward-compatible `tags` field
- **Backwards compatibility**: Existing callers are unaffected
- **WireCommitDelta vs v2 CommitDelta separation**: Clean

---

## Verdict

**REJECT.** The core operation -- deleting old data for changed files -- does not work for production databases. This is not a performance issue or a cosmetic problem. It is a data corruption bug that would produce silently wrong graphs. The test suite hides the bug by only testing ephemeral databases.

### Required Fixes Before Re-Review

1. **Fix segment edge deletion in CommitBatch handler.** The handler must actually remove segment edges, not just call `delete_edge` which is a no-op for segments. Options:
   - Extend the flush mechanism to skip edges whose src or dst is in `deleted_segment_ids`
   - Or add a `deleted_segment_edge_keys` set (similar to `deleted_segment_ids` for nodes) and check it during flush
   - Or restructure the handler to work within the existing engine contract

2. **Add a non-ephemeral database test** that verifies edges are actually deleted (not just counted) after CommitBatch on data that has been flushed to segments.

3. **Fix the edges_removed double-counting** for edges shared between two nodes in `changedFiles`. Use a `HashSet<(u128, u128, String)>` to track already-counted edges.
