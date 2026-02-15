# RFD-20: T6.1 Background Compaction

## User Request

Implement background compaction for RFDB v2 — LSM-style L0 → L1 merge with inverted indexes.

## From Linear

~1500 LOC, ~25 tests

### Subtasks

1. Compaction trigger: segment count threshold per shard
2. Merge: L0 segments → L1 (sorted, deduplicated, tombstones applied)
3. Inverted index built during compaction (by_type, by_name, by_file)
4. Global index: sorted mmap array (node_id → shard, segment, offset)
5. GC: old segments → gc/, deleted after no readers
6. Blue/green: build → swap → delete

### Validation

- Query equivalence: before compaction = after compaction
- Tombstone application: compacted = no tombstoned records
- Inverted index: index query = scan query
- Global index: every node reachable
- Concurrent safety: compaction during queries → no torn reads
- Benchmark: post-compaction query latency (target: 5-10x improvement)

### Dependencies

- RFD-11 (T4.1: Wire Protocol v3 Integration) — Done
