# REG-489: Fix MODULE node loss caused by REG-487 deferred indexing

## Problem

REG-487 introduced deferred indexing for O(n^2) performance fix (5.2x faster analysis).
However, it caused a regression: 42.9% of nodes are now disconnected (was <10%).

## Root Cause

`commitBatch`'s delete-then-add semantics destroys MODULE nodes:

1. **INDEXING phase** creates MODULE + IMPORT + EXPORT nodes for file `X.ts`
2. **ANALYSIS phase** (JSASTAnalyzer) creates FUNCTION/SCOPE/BRANCH for `X.ts`, calls `commitBatch`
3. Server sees `changedFiles: ["X.ts"]` → deletes ALL nodes with `file === "X.ts"` (including MODULE from indexing)
4. Server adds only analysis nodes (no MODULE) → MODULE lost, connectivity chain broken

### Evidence

- 330 modules indexed, only 14 MODULE nodes survive
- Surviving 14 are files JSASTAnalyzer never processed (no batch commit)
- Ghost nodes: edges point to deleted MODULE nodes (getNode returns null, but getOutgoingEdges returns 12 edges)
- SCOPE ← FUNCTION ← NULL pattern confirmed across all disconnected nodes

### Impact

- 29,891 unreachable nodes (42.9%)
- Broken types: SCOPE(7486), PROPERTY_ACCESS(11451), BRANCH(5227), PARAMETER(2968), LOOP(912), etc.
- Graph queries for MODULE-level operations return incomplete results
- Cross-file enrichment that depends on MODULE connectivity fails

## Performance Baseline (must preserve)

- Analysis: 7m48s total (was 40m19s) — 5.2x improvement from REG-487
- Analysis phase: 5m41s (was ~35m)
- Stable ~1s/module (no O(n^2) degradation)
- Graph: 69,677 nodes / 97,934 edges

## Acceptance Criteria

1. All MODULE nodes survive through analysis (330/330)
2. Disconnected nodes < 10% (pre-REG-487 level)
3. No performance regression from REG-487 fix (analysis time within 20%)
4. Ghost edges eliminated (no edges pointing to non-existent nodes)
