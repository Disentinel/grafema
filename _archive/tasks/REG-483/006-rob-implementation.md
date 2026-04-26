# REG-483 Implementation Report: Remove GraphBuilder Buffer Layer

**Agent:** Rob Pike (Implementation)
**Date:** 2026-02-16

## Summary

Removed the redundant buffer layer from `GraphBuilder`. Nodes and edges are now written directly to the graph during the RFDBClient batch window, eliminating the intermediate arrays (`_nodeBuffer`, `_edgeBuffer`) that duplicated data already being batched by RFDBClient.

Only FUNCTION nodes remain deferred in a `_pendingFunctions` Map, because `ModuleRuntimeBuilder` mutates their metadata (rejectionPatterns) after buffering but before flush.

## Files Changed

### 1. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Removed:**
- `_nodeBuffer: GraphNode[]` array
- `_edgeBuffer: GraphEdge[]` array
- `_flushNodes()` method (branded all nodes in batch, wrote to graph)
- `_flushEdges()` method (wrote all edges with `skip_validation` cast)

**Added:**
- `_graph: GraphBackend | null` field -- set during `build()`, cleared after return
- `_pendingFunctions: Map<string, GraphNode>` -- holds only FUNCTION nodes until domain builders finish
- `_directNodeCount` / `_directEdgeCount` counters -- track writes for `BuildResult`
- `_flushPendingFunctions()` method -- flushes deferred FUNCTION nodes after domain builders complete

**Changed:**
- `_bufferNode()` -- now brands immediately and either writes directly to graph (non-FUNCTION) or stores in `_pendingFunctions` (FUNCTION)
- `_bufferEdge()` -- writes directly to graph via `this._graph!.addEdges()`
- `_createContext().findBufferedNode` -- now uses `Map.get()` instead of `Array.find()` (O(1) vs O(n))
- `build()` reset section -- sets `_graph` reference and clears counters instead of resetting arrays
- `build()` flush section -- calls `_flushPendingFunctions()` instead of `_flushNodes()` + `_flushEdges()`
- `build()` return -- computes totals from `_directNodeCount + functionsCreated` and `_directEdgeCount + classAssignmentEdges`
- Top-level file comment updated to reflect new architecture

### 2. `packages/core/src/plugins/analysis/ast/builders/types.ts`

**Changed:**
- Comment on `findBufferedNode` updated: "Pending function node lookup (for metadata updates by ModuleRuntimeBuilder)"

## Type Issue Resolved

`GraphEdge` (concrete interface with named fields) is not directly assignable to `InputEdge` (has `[key: string]: unknown` index signature). The old `_flushEdges()` worked around this with a cast through `GraphBackend & { addEdges(e: GraphEdge[], skip?: boolean) }`. The new `_bufferEdge()` uses `edge as unknown as Parameters<GraphBackend['addEdges']>[0][number]` which is type-safe and doesn't require inventing a synthetic interface.

## Behavioral Invariants Preserved

1. **Node branding** -- `brandNodeInternal()` is called on every node before graph write (was in `_flushNodes`, now in `_bufferNode`)
2. **FUNCTION metadata mutation** -- `findBufferedNode()` returns the same object reference from the Map, so in-place mutation by ModuleRuntimeBuilder still works
3. **Build order** -- functions buffered first, then other nodes, then domain builders, then flush pending functions. Same logical order as before.
4. **BuildResult counts** -- `nodes` and `edges` counts are accurate via direct counters + flush return value
5. **Graph reference lifecycle** -- set at start of `build()`, cleared before return. No stale references.

## Build Status

`pnpm build` passes clean. No TypeScript errors in any package.
