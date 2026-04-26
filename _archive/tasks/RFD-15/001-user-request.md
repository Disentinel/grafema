# RFD-15: T5.1 — Enrichment Virtual Shards

## Task

RFDB Phase 6. Composite file context for enrichment edge ownership.

**~700 LOC, ~18 tests**

## Design

`__enrichment__/{enricher}/{file}` — composite file context. Allows surgical deletion: "delete all edges ImportExportLinker created for src/app.js" without touching other edges.

## Wire Protocol

```rust
CommitBatch {
    file_context: Option<String>,  // enrichment shard context
    tags: Option<HashMap<String, String>>,
    request_id: Option<String>,
}
```

If `file_context` is set → tombstone + write to that context's shard. If None → normal file-based grouping.

## Subtasks

1. Composite file context routing: `__enrichment__/{enricher}/{file}` → shard
2. CommitBatch with enrichment file context → tombstones only enrichment edges
3. Surgical deletion: replace one enricher's edges for one file

## Validation

- Ownership via shard: correct edges in correct shard
- Surgical deletion: only targeted edges replaced
- No collision: analysis shard ≠ enrichment shard
- Enrichment edges visible in normal `get_outgoing_edges` queries
- **Incremental: re-enrich = same as full re-enrich**

## Dependencies

← T4.1 (Working v2 engine) — RFD-11
→ Blocks: RFD-19 (T5.5: Enrichment Pipeline Validation)

## Milestone

M5: Enrichment Pipeline
