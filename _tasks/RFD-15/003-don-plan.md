# Don Melton — Implementation Plan: RFD-15 Enrichment Virtual Shards

## Summary

Track edge ownership via `file_context` in metadata JSON, route enrichment edges to enrichment shards, enable surgical tombstoning by file context, and fix cross-shard queries.

**~700 LOC, ~23 tests across 5 phases.**

## Architectural Decision: Metadata-Based File Context

Store `file_context` in edge metadata JSON (`__file_context` field), not as a new EdgeRecordV2 column.

**Rationale:**
- types.rs line 276 already documents: `_owner for enrichment edges goes in metadata, not as a column`
- No storage format migration needed
- Backward compatible: existing edges have `metadata: ""` → no file_context
- Can migrate to dedicated field in future storage format version

## Phases

### Phase 1: Metadata Helpers (types.rs, 40 LOC, 4 tests)
- `enrichment_edge_metadata(file_context)` → JSON with `__file_context`
- `extract_file_context(metadata)` → Option<String>

### Phase 2: Edge Routing (multi_shard.rs, 280 LOC, 12 tests)
- `add_edges()` routes by metadata file_context when present (enrichment shard)
- Add `enrichment_edge_to_shard: HashMap<u128, Vec<u16>>` index
- Modify `get_outgoing_edges()` to check enrichment shards via index
- Modify `commit_batch()` Phase 2: if changed_file starts with `__enrichment__/`, use `find_edge_keys_by_file_context()` instead of node-based tombstoning

### Phase 3: Shard-Level Edge Search (shard.rs, 80 LOC)
- `find_edge_keys_by_file_context()` — scans write buffer + segments

### Phase 4: Wire Protocol (rfdb_server.rs, 80 LOC, 2 tests)
- Add `file_context: Option<String>` to CommitBatch
- Handler injects file_context into edge metadata + overrides changed_files

### Phase 5: Integration Tests (enrichment_shards.rs, 100 LOC, 5 tests)
- End-to-end validation of all spec requirements

## Files Changed

| File | LOC | Tests | Risk |
|------|-----|-------|------|
| `src/storage_v2/types.rs` | 40 | 4 | LOW |
| `src/storage_v2/multi_shard.rs` | 280 | 12 | MEDIUM |
| `src/storage_v2/shard.rs` | 80 | 0 | LOW |
| `src/bin/rfdb_server.rs` | 80 | 2 | LOW |
| `tests/enrichment_shards.rs` | 100 | 5 | LOW |
| **TOTAL** | **580** | **23** | |

## Validation Checklist

- Ownership via shard: enrichment edges route to enrichment shard
- Surgical deletion: re-enrich file A → only A's edges replaced
- No collision: analysis shard ≠ enrichment shard
- Enrichment edges visible in get_outgoing_edges
- Incremental = full re-enrich
