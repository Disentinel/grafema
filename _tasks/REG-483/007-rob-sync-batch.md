# Rob Pike - Sync Batch API Implementation Report

## REG-483: Synchronous Batch API for GraphBuilder

### Summary

Implemented synchronous `batchNode()` / `batchEdge()` methods across 4 files to eliminate the redundant GraphBuilder buffer layer. Nodes and edges now push directly into RFDBClient's batch arrays during the `beginBatch/commitBatch` window, removing the intermediate `_nodeBuffer` / `_edgeBuffer` + async `addNodes/addEdges` flush step.

### Changes

#### 1. `packages/rfdb/ts/client.ts`
- Added `batchNode()`: synchronous method that converts a node to WireNode format and pushes directly to `_batchNodes[]`. Same conversion logic as `addNodes()` but without async wrapper.
- Added `batchEdge()`: synchronous method that converts an edge to WireEdge format and pushes directly to `_batchEdges[]`. Same conversion logic as `addEdges()`.
- Both throw if no batch is in progress (same guard as `commitBatch`).

#### 2. `packages/core/src/storage/backends/RFDBServerBackend.ts`
- Added `batchNode(node: InputNode)`: converts InputNode to wire format (respecting v3 protocol for semanticId) and delegates to `client.batchNode()`.
- Added `batchEdge(edge: InputEdge)`: converts InputEdge to wire format (with edge type tracking) and delegates to `client.batchEdge()`.
- Both match the exact conversion logic of their async counterparts (`addNodes` / `addEdges`).

#### 3. `packages/types/src/plugins.ts`
- Added optional `batchNode?(node: AnyBrandedNode): void` and `batchEdge?(edge: InputEdge): void` to `GraphBackend` interface.
- Placed after existing batch operations section.

#### 4. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
- Added `_useSyncBatch` flag, detected once at start of `build()` via `typeof graph.batchNode === 'function'`.
- Added `_directNodeCount` and `_directEdgeCount` counters for sync batch mode.
- `_bufferNode()`: FUNCTION nodes still go to `_pendingFunctions` Map (deferred for metadata mutation). All other nodes call `graph.batchNode!()` directly in sync mode, or fall back to `_nodeBuffer`.
- `_bufferEdge()`: calls `graph.batchEdge!()` directly in sync mode, or falls back to `_edgeBuffer`.
- Replaced `_flushAll()` with two focused methods:
  - `_flushPendingFunctions()`: iterates Map, brands each, pushes to `batchNode` or `addNodes`.
  - `_flushFallbackBuffers()`: only called in non-sync-batch mode, handles `_nodeBuffer` + `_edgeBuffer`.
- Build return value correctly accounts for both sync and fallback paths.

### Design Decisions

1. **Feature detection over type narrowing**: `typeof graph.batchNode === 'function'` is checked once, stored in boolean. Avoids repeated optional chaining in hot loop.

2. **Graceful fallback**: If backend doesn't support `batchNode`/`batchEdge` (e.g., test backends, future alternative backends), GraphBuilder falls back to the previous buffer+flush approach. Zero behavior change for those paths.

3. **Matching existing conversion logic exactly**: The sync methods replicate the same field extraction, metadata merging, and protocol v3 handling as their async counterparts. No new behavior introduced.

### Test Results

- `CallbackFunctionReference.test.js`: 34/34 pass
- Full suite: 1995/1995 pass, 0 fail (5 skipped, 22 todo - pre-existing)
- Build: clean TypeScript compilation, no errors
