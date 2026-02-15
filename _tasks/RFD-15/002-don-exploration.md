# Don Melton — Exploration Report: RFD-15 Enrichment Virtual Shards

## Executive Summary

The current RFDB v2 architecture already has **most** of the foundation needed for enrichment virtual shards. The `enrichment_file_context()` helper exists and is tested, the shard-based storage is working, and `commit_batch()` already handles surgical deletion by file context.

**Key Finding:** The task design proposes a wire protocol change that may not be necessary. The enrichment file context pattern already works through the existing `changed_files` parameter in `commit_batch()`. However, there are architectural gaps that need addressing for true enrichment shard isolation.

## Architecture Overview

### Current File Context → Shard Routing

**File:** `src/storage_v2/shard_planner.rs`

`ShardPlanner` routes nodes to shards based on **parent directory hash**:
- `enrichment_file_context("data-flow", "src/app.js")` → `__enrichment__/data-flow/src/app.js`
- Parent directory: `__enrichment__/data-flow/src/`
- **This already routes to a consistent shard!**

### Current commit_batch()

**File:** `src/storage_v2/multi_shard.rs` (line 532-679)

```rust
pub fn commit_batch(
    &mut self,
    nodes: Vec<NodeRecordV2>,
    edges: Vec<EdgeRecordV2>,
    changed_files: &[String],
    tags: HashMap<String, String>,
    manifest_store: &mut ManifestStore,
) -> Result<CommitDelta>
```

Phase 1→7 pipeline: snapshot → tombstone → apply → add → flush.

Test `test_commit_batch_enrichment_convention()` proves surgical deletion already works.

### Wire Protocol

**File:** `src/bin/rfdb_server.rs` (line 213-220)

```rust
CommitBatch {
    changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    tags: Option<Vec<String>>,
}
```

## Architectural Gaps

### Gap 1: Enrichment Edges Not Visible in get_outgoing_edges()

`get_outgoing_edges()` fast path checks `node_to_shard` index → returns only from that shard. Enrichment edges in a different shard are MISSED.

### Gap 2: Edge Routing Assumes Source Node's Shard

`add_edges()` routes to shard owning `edge.src`, not enrichment file context. Breaks enrichment shard isolation.

### Gap 3: No File Context on Edge Records

`EdgeRecordV2` has no `file` field. Can't determine which enricher created an edge.

## Recommended Approach

**Option A (Minimal):** Extend commit_batch() with metadata-based file_context tracking:
1. Add `__file_context` metadata to enrichment edges
2. Route edges by metadata file_context when present
3. Add enrichment edge index for fast queries

**Option B (Clean):** New `commit_enrichment_batch()` method with explicit enricher+source_file params.

**Option C (Hybrid, Recommended):** Use Option A for Phase 1 (this task), migrate to Option B later.

## Critical Files

1. `src/storage_v2/multi_shard.rs` — edge routing + query logic
2. `src/storage_v2/types.rs` — data structures, already has `enrichment_file_context()`
3. `src/storage_v2/shard.rs` — shard-level operations
4. `src/storage_v2/shard_planner.rs` — routing (already works correctly)
5. `src/bin/rfdb_server.rs` — wire protocol
6. `tests/enrichment_shards.rs` — new test file

## Risks

1. **Query perf** — mitigated by enrichment edge index
2. **Shard count** — manageable (~400 with 4 enrichers)
3. **Backward compat** — metadata is opaque JSON, safe to add fields
