# Kevlin Henney's Code Review: REG-115

**Status: REQUEST CHANGES**

## Critical Issue: Type Safety Inconsistency

**Files affected:**
- `packages/types/src/rfdb.ts`
- `packages/rfdb/ts/client.ts`
- `packages/core/src/storage/backends/RFDBServerBackend.ts`

**Problem:**
The `edgeTypes` parameter has conflicting signatures:
- `ReachabilityRequest` interface: `edgeTypes?: EdgeType[]` (optional)
- `IRFDBClient.reachability()`: `edgeTypes: EdgeType[]` (required)

This breaks consistency with `bfs()`/`dfs()` which use optional `edgeTypes`.

**Fix:** Make it consistently optional to match existing pattern.

## Should Fix: Documentation

- `reverse_neighbors()` doc comment doesn't explain empty edge_types behavior
- `reachability()` doc says "find sources" but only when backward=true
- Add: "If backward=false, traverses edges forward (find sinks/reachable targets)."

## Should Fix: Missing Test

Add `test_reachability_backward_with_filter` to cover backward + type filtering combined.

## Strengths

- Clean, idiomatic Rust implementation
- Good test naming communicates intent
- Helper functions reduce boilerplate
- Consistent protocol design
