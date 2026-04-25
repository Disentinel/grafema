# RFD-39: node_count()/edge_count() double-count after memory flush

## Bug

`node_count()` and `edge_count()` use naive `segment + delta` sum without deduplication.
After memory-triggered flush, nodes/edges that exist in both segment and delta are counted twice.

## Impact

On real project with 700+ services:
- nodeCount: 83,821 (inflated ~29x vs actual 2,915)
- edgeCount: 572,772 (inflated ~147x vs actual 3,886)

Data is NOT corrupted — only count functions are wrong.

## Files

- `packages/rfdb-server/src/graph/engine.rs:1311-1317`
