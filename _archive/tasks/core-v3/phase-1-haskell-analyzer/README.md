# Phase 1: Complete Haskell Per-File Analysis

## Goal

`grafema-analyzer` outputs correct `FileAnalysis` with intra-file scope resolution. External contract: `{ nodes, edges, exports }` — no `unresolvedRefs`.

## Current State

- `declareInScope` exists in `Analysis/Scope.hs` but is **never called**
- `drScopeId` is always `Nothing` on all DeferredRef emissions
- REFERENCE and IMPORT_BINDING nodes are already emitted
- `FileAnalysis` has `faUnresolvedRefs :: [DeferredRef]` in external JSON output
- No test suite (placeholder `test/Spec.hs` only)

## Tasks

| Task | Title | Depends On | Status |
|------|-------|------------|--------|
| 1.1 | [Wire up declareInScope calls](1.1-declare-in-scope.md) | — | Todo |
| 1.2 | [Populate drScopeId on DeferredRef](1.2-scope-id-on-deferred-refs.md) | — | Todo |
| 1.3 | [Implement resolveFileRefs](1.3-resolve-file-refs.md) | 1.1, 1.2, 1.5 | Todo |
| 1.4 | [Eliminate unresolvedRefs from output](1.4-eliminate-unresolved-refs.md) | 1.3 | Todo |
| 1.5 | [Add ExportInfo to FileAnalysis](1.5-export-info.md) | — | Todo |
| 1.6 | [Haskell test suite](1.6-haskell-tests.md) | — (parallel) | Todo |

## Dependency Graph

```
1.1 ─┐
1.2 ─┼─ 1.3 ─── 1.4
1.5 ─┘

1.6 runs in parallel (tests for each task as it lands)
```

## Success Criteria

1. `grafema-analyzer` JSON output has no `unresolvedRefs` field
2. Intra-file references produce correct edges (READS_FROM, CALLS, etc.)
3. Cross-file references remain as IMPORT_BINDING or REFERENCE(resolved:false)
4. `cabal test` passes with full coverage of scope resolution scenarios
