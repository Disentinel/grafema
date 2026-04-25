# RFD-6: T2.2 Single-Shard Read/Write

## Linear Issue
- **ID:** RFD-6
- **Title:** T2.2: Single-Shard Read/Write
- **Milestone:** M2: Storage Engine
- **Estimate:** 8 Points
- **Labels:** Track 1: Rust
- **Dependencies:** ← T1.1 (Segment Format) DONE, T2.1 (Manifest) DONE

## Scope

RFDB Phase 2. Single shard with write buffer, point lookup, attribute search, neighbor queries.

**~2000 LOC, ~28 tests**

### Subtasks

1. Shard = directory containing segments
2. Write path: Vec<NodeRecord> → segment file + manifest update
3. Point lookup: bloom filter check → segment scan → found/not found
4. Attribute search: zone map pruning → columnar scan
5. Neighbors query: edge segment scan (bloom on src/dst)
6. Write buffer: in-memory accumulation before flush

### Validation

* **Equivalence tests: same data in v1 HashMap vs v2 shard → identical query results**
* Full CRUD: add nodes → query → verify → add edges → neighbors → verify
* Multiple segments: flush twice → both queryable
* Write buffer + segment: unflushed + flushed → both visible
* **Benchmark: query latency vs v1 (must be within 2x for L0)**
