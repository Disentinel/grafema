# User Request: REG-478

**Date:** 2026-02-16
**Workflow:** Full MLA (subtask of REG-477)
**Source:** REG-478 (Linear)

## Request

Run ANALYSIS phase globally, not per-service.

## Context

Parent issue REG-477 identified O(services × plugins × all_modules) bottleneck.
Knuth Big-O analysis (`_tasks/REG-477/003-knuth-bigo-analysis.md`) confirmed:

- Orchestrator.runBatchPhase('ANALYSIS') runs ALL 16 plugins once PER SERVICE
- 745 services × 16 plugins = 11,920 plugin executions
- Every plugin queries ALL modules globally via `getModules()` — ignoring service context
- 12 plugins × 745 invocations = 8,940 identical IPC calls returning 4,101 modules each

## Expected Outcome

Change Orchestrator to run ANALYSIS plugins ONCE globally instead of once per service.
Expected: 745× fewer plugin executions, 745× fewer graph queries.

## Constraints

- Plugins already ignore service context — low risk change
- Must not break ENRICHMENT/VALIDATION phases (they already run globally)
- All existing tests must pass
