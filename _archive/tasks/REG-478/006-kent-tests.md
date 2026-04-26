# Kent Beck — Test Report: REG-478

**Date:** 2026-02-16
**Task:** Run ANALYSIS phase globally, not per-service
**Test file:** `test/unit/OrchestratorAnalysisGlobal.test.js`

## Summary

Wrote 9 tests across 4 test suites verifying that the ANALYSIS phase runs globally (once for all modules) rather than per-service. All 9 tests pass against the current implementation, confirming the change works correctly.

**Note:** The implementation was already present in both `src/Orchestrator.ts` and `dist/Orchestrator.js` when tests were written. Tests verify the implementation is correct (green phase), and would fail if the change were reverted.

## Test Suites

### Suite 1: Single-root mode (4 tests)

| # | Test | What it verifies | Key assertion |
|---|------|-----------------|---------------|
| 1 | should run ANALYSIS plugins once globally, not per-service | Plugin execution count with 3 services, 2 analysis plugins | Each plugin: `executionCount === 1` (not 3) |
| 2 | should pass full DiscoveryManifest (not UnitManifest) | Manifest shape received by plugins | `manifest.services` exists (array), `manifest.service` absent |
| 3 | should call runPhase not runBatchPhase (verified by count) | With 5 services, plugin runs once | `executionCount === 1` (not 5) |
| 4 | should skip ANALYSIS in indexOnly mode | indexOnly flag prevents ANALYSIS | `executionCount === 0` |

### Suite 2: Multi-root mode (3 tests)

| # | Test | What it verifies | Key assertion |
|---|------|-----------------|---------------|
| 1 | should run ANALYSIS once globally AFTER all roots indexed | 3 roots, ANALYSIS runs once, INDEXING runs 3+ times | `analysisCount === 1`, `indexingCount >= 3` |
| 2 | should skip ANALYSIS in multi-root indexOnly mode | indexOnly respected in multi-root | `executionCount === 0` |
| 3 | should pass unified manifest with all roots | ANALYSIS receives unified DiscoveryManifest | `manifest.services` present, `manifest.service` absent |

### Suite 3: Phase ordering (1 test)

| # | Test | What it verifies | Key assertion |
|---|------|-----------------|---------------|
| 1 | should run ANALYSIS before ENRICHMENT | Phase execution order | `lastAnalysisIdx < firstEnrichmentIdx` |

### Suite 4: Multiple plugins (1 test)

| # | Test | What it verifies | Key assertion |
|---|------|-----------------|---------------|
| 1 | should run each plugin exactly once with global execution | 4 services x 3 plugins = 3 total (not 12) | `totalExecutions === PLUGIN_COUNT` (not S*P) |

## Test Approach

### Pattern matching
Tests follow the exact pattern established by `OrchestratorStrictSuppressed.test.js` and `OrchestratorMultiRootStrict.test.js`:
- `createTestDatabase()` for RFDB backend
- Mock discovery/indexing/enrichment plugins
- `cleanupAllTestDatabases` in `after()` hook
- `logLevel: 'silent'` to suppress noise

### Key testing tool: CountingAnalysisPlugin
Created a `createCountingAnalysisPlugin()` factory that:
- Counts `execute()` invocations
- Records manifest shape (DiscoveryManifest vs UnitManifest)
- Records context properties (graph, workerCount, rootPrefix)

This tracker makes the behavioral difference between per-service and global execution directly measurable:
- **Per-service (old):** `executionCount === serviceCount`
- **Global (new):** `executionCount === 1`

### What would break if the change were reverted

If someone reverts the `runPhase → runBatchPhase` change:
- Tests 1, 2, 3 in Suite 1: `executionCount` would be 3 or 5 (not 1)
- Test 2 in Suite 1: manifest would have `.service` object (UnitManifest shape)
- Test 1 in Suite 2: `executionCount` would be 3 (per-root, not global)
- Test 1 in Suite 4: `totalExecutions` would be 12 (S*P, not P)

### Edge cases covered

| Edge case | Covered by test |
|-----------|----------------|
| indexOnly mode (single-root) | Suite 1, test 4 |
| indexOnly mode (multi-root) | Suite 2, test 2 |
| Multiple analysis plugins | Suite 4, test 1 |
| Phase ordering (ANALYSIS before ENRICHMENT) | Suite 3, test 1 |
| Multi-root with 3 roots | Suite 2, tests 1 & 3 |
| Manifest shape (DiscoveryManifest vs UnitManifest) | Suite 1 test 2, Suite 2 test 3 |

### Edge cases NOT covered (out of scope)

| Edge case | Reason |
|-----------|--------|
| ParallelRunner path | Requires real ParallelAnalysisRunner setup; existing code path unchanged |
| Plugin throwing during global ANALYSIS | Error handling is PhaseRunner responsibility, not Orchestrator |
| forceAnalysis flag | JSASTAnalyzer dedup — tested by existing integration tests |
| Empty project (0 services) | Would need discovery returning empty services array; low risk |

## Test Execution

```
# tests 9
# suites 4
# pass 9
# fail 0
# duration_ms 1464ms
```

All 9 new tests + all 7 existing Orchestrator tests pass together (16 total, 2.6s).
