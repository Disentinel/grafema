# REG-388: Batch IPC calls in analysis plugins (eliminate N+1 overhead)

## User Request

Batch all singular `addNode()` / `addEdge()` calls in analysis and enrichment plugins to use batch `addNodes()` / `addEdges()` instead, eliminating N+1 IPC overhead.

## Context

REG-124 profiling showed 96.7% of analysis time is IPC overhead from N+1 calls. GraphBuilder already batches (1.3s for 12K nodes), but 20+ other plugins use singular calls (84.8s total).

## Scope

35 files, 112 call sites. Buffer nodes/edges per plugin, flush once at end.

## Acceptance Criteria

- All plugins use batch `addNodes()` / `addEdges()` instead of singular calls
- No functional regressions (all tests pass)
- Profiling comparison: before/after on Jammers
