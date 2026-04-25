# Steve Jobs Review: RFD-5 Plan v2

**VERDICT: APPROVE WITH CONDITION**

## Objection Resolutions

1. **[RESOLVED]** O(N) list_snapshots → ManifestIndex, O(N) in-memory filter
2. **[RESOLVED]** O(N) find_snapshot → tag_index HashMap, O(1) lookup
3. **[RESOLVED]** Sharding extensibility → segment_id + shard_id (Option), derived paths
4. **[RESOLVED]** GC O(R×S + F) → referenced_segments HashSet, O(F)
5. **[RESOLVED]** Fsync → DurabilityMode { Strict, Relaxed }

## Condition: Index Consistency Check

**Required before implementation:**

On `ManifestStore::open()`, validate index consistency:
1. Load current pointer + index
2. If `index.latest_version > current_pointer.version` → crash during commit
3. Rebuild index from manifests/ directory (one-time repair)
4. Proceed normally

Without this, a crash between writing index and current pointer leaves index corrupt.

## Approved Architecture

- ManifestIndex solves O(N) → O(1) for list/find/GC
- Derived paths (segment_id + shard_id) future-proof for T2.2 sharding
- DurabilityMode makes fsync configurable
- Commit order: manifest → index → current (crash-safe with consistency check)
- Conservative GC (no manifest deletion in Phase 1)

## Complexity

| Operation | Old | New |
|-----------|-----|-----|
| list_snapshots | O(M×S) | O(N) in-memory |
| find_snapshot | O(N×S) | O(1) |
| gc_collect | O(R×S+F) | O(F) |
| commit | O(S) | O(S+I) slight overhead |

Trade-off: slightly slower commits for massively faster queries. Correct trade-off.
