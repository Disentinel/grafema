# RFD-8: T3.1 Tombstones + Batch Commit

## Summary

RFDB Phase 4. Atomic multi-file commit with tombstones and delta computation.

~600 LOC, ~35 tests

## Subtasks

1. Tombstone segments: mark deleted node/edge IDs
2. Query path: skip tombstoned records
3. BeginBatch / CommitBatch / AbortBatch protocol
4. File grouping: nodes grouped by `file` field → shard operations
5. Edge ownership via bloom-assisted `query_edges_by_src_ids()`
6. Enrichment file context: `__enrichment__/{enricher}/{source_file}`
7. Atomic manifest swap for entire batch
8. Auto-commit without BeginBatch (backward compat)
9. CommitDelta: changedFiles, nodesAdded/Removed/Modified, removedNodeIds, changedNodeTypes, **changedEdgeTypes** (from both new and old tombstoned edges)
10. Modified detection via content_hash (I4)

## Key Design: BatchState per Connection

`BatchState` lives in `ConnectionState`, NOT in `GraphEngineV2`. `commit_batch()` takes `(nodes, edges, tags)` as params.

## Key Design: Bloom-Assisted Edge Tombstoning

Collect node IDs for file → check src bloom on each edge segment → scan only matching segments. O(edge_segments × bloom_check) instead of O(all_edges).

## Validation

- Idempotency: re-analyze same file → graph unchanged
- Delta correctness: modify 1 function → only that function's nodes change
- Batch atomicity: 10 AddNodes → all-or-nothing
- Delta accuracy: CommitBatch delta matches DiffSnapshots(prev, current)
- changedEdgeTypes populated from both new and tombstoned edges

## Dependencies

← T2.1 (Manifest), T2.2 (Single-Shard)
