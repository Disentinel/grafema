# RFD-19: Enrichment Pipeline Integration Tests & Benchmarks

**Author:** Don Melton (Tech Lead)  
**Date:** 2026-02-15  
**Status:** Planning

## Context

The enrichment pipeline (T5.1-T5.4) is fully implemented across four files:
- **PhaseRunner.ts** (449 LOC) — Selective enrichment, propagation queue
- **GuaranteeManager.ts** (650 LOC) — Guarantee checking with selective filtering
- **Orchestrator.ts** (1247 LOC) — Pipeline coordination, guarantee hook
- **buildDependencyGraph.ts** (99 LOC) — Enricher dependency resolution

Existing tests validate individual features (SelectiveEnrichment.test.ts, GuaranteeIntegration.test.ts) but lack end-to-end validation. This task adds ~15 integration tests covering the full pipeline flow and a benchmark comparing selective vs full re-enrichment.

## Test Strategy

### Location: test/integration/

**Why integration/ not unit/**:
- Integration tests validate full pipeline flow (INDEXING → ANALYSIS → ENRICHMENT → GUARANTEE → VALIDATION)
- Unit tests already cover individual components (PhaseRunner, GuaranteeManager)
- Similar to existing cross-service-tracing.test.ts pattern

### Test Structure

Use **real Orchestrator + real RFDB backend** (TestBackend helper from test/helpers/TestRFDB.js):
- More realistic than mocking PhaseRunner
- Catches integration bugs between components
- Validates batch protocol (beginBatch/commitBatch)
- Allows testing against real graph state

### Fixture Design

Create `test/fixtures/enrichment-pipeline/`:
```
enrichment-pipeline/
├── src/
│   ├── module-a.js       # Original file
│   ├── module-b.js       # Imports from A
│   └── utils.js          # Utility functions
├── package.json
└── .grafemaignore        # For testing ignore patterns
```

Fixture files will be simple JS with identifiable patterns (function calls, imports) to validate blast radius and selective enrichment.

## Test Plan (~15 tests)

### File: test/integration/EnrichmentPipeline.test.ts

**Group 1: End-to-End Flow (4 tests)**

1. **e2e_first_run_all_enrichers_execute**
   - Run full analysis on fixture
   - Verify all enrichers executed (check logs or plugin execution count)
   - Verify guarantee check ran after enrichment
   - Verify graph has expected nodes/edges

2. **e2e_file_edit_triggers_selective_enrichment**
   - Initial run (full analysis)
   - Simulate file edit (modify module-a.js content)
   - Re-run analysis with forceAnalysis=false
   - Verify ONLY downstream enrichers re-ran (not level-0)
   - Check delta contains changed types

3. **e2e_guarantee_violation_detected**
   - Create guarantee (e.g., "no eval() calls")
   - Add eval() to fixture file
   - Run analysis
   - Verify guarantee check AFTER enrichment
   - Verify violation appears in diagnostics

4. **e2e_guarantee_selective_check**
   - Create two guarantees: one for FUNCTION nodes, one for CALL nodes
   - Enrichment changes only FUNCTION types
   - Verify only FUNCTION guarantee checked (not CALL)
   - Check result.results.length matches expected count

**Group 2: Watch Mode Simulation (3 tests)**

5. **watch_sequence_of_changes**
   - Initial run (full)
   - Change module-a.js → verify blast radius (module-b affected)
   - Change module-b.js → verify blast radius (only module-b)
   - Change utils.js → verify blast radius (both A and B if imported)
   - Assert incremental updates are correct

6. **watch_no_change_skip_all**
   - Initial run
   - Re-run with same content (no file changes)
   - Verify all enrichers skipped (accumulatedTypes empty)
   - Verify guarantee check still runs (checkAll fallback)

7. **watch_ignored_file_no_reanalysis**
   - Add pattern to .grafemaignore (e.g., "*.test.js")
   - Create file matching pattern
   - Run analysis
   - Verify file NOT indexed (no MODULE node)

**Group 3: Edge Cases (4 tests)**

8. **edge_file_deleted_cleanup**
   - Initial run (module-a.js exists)
   - Delete module-a.js from fixture
   - Re-run analysis
   - Verify MODULE node removed
   - Verify all edges from/to module-a removed

9. **edge_enricher_added_triggers_rerun**
   - Initial run with enricher set A
   - Add new enricher B that consumes types from A
   - Re-run analysis
   - Verify new enricher B executed
   - Verify graph has new edges from B

10. **edge_enricher_removed_stale_data**
    - Initial run with enricher set A
    - Remove enricher from pipeline
    - Re-run with forceAnalysis=true (clear graph)
    - Verify graph does NOT have edges from removed enricher

11. **edge_circular_dependency_prevention**
    - Create two files with circular imports (A imports B, B imports A)
    - Run analysis
    - Verify no infinite loop (termination guaranteed by toposort + processed set)
    - Verify both files indexed correctly

**Group 4: Coverage Monitoring (2 tests)**

12. **coverage_gap_warning_content_changed_no_delta**
    - Initial run (extract function from module-a)
    - Modify module-a content (add comment only, no AST change)
    - Re-run analysis
    - Verify enrichment produces no delta (no new nodes)
    - Check for coverage canary warning in logs

13. **coverage_no_warning_when_delta_present**
    - Initial run
    - Modify module-a (add new function, real AST change)
    - Re-run analysis
    - Verify enrichment produces delta (changedNodeTypes has FUNCTION)
    - Verify NO coverage gap warning

**Group 5: Benchmark (2 tests)**

14. **benchmark_selective_vs_full_small_change**
    - Initial run on fixture (5-10 files)
    - Measure full re-enrichment time (clear graph, re-run)
    - Change 1 file (small blast radius)
    - Measure selective enrichment time
    - Assert: selective < full (speedup ≥ 2x for small change)

15. **benchmark_selective_vs_full_large_change**
    - Initial run on fixture
    - Change multiple files (large blast radius, 50%+ of files)
    - Measure selective enrichment time
    - Assert: selective ≈ full (speedup ~1.1-1.3x, overhead from skip checks)

### File: test/integration/EnrichmentBenchmark.md (benchmark report)

Output format (generated by tests):
```markdown
# Enrichment Pipeline Benchmark

**Date:** 2026-02-15  
**Fixture:** enrichment-pipeline (10 files, ~500 LOC)

## Scenario 1: Small Change (1 file, 10% blast radius)

| Metric | Full Re-enrichment | Selective Enrichment | Speedup |
|--------|-------------------|---------------------|---------|
| Time (ms) | 450 | 180 | 2.5x |
| Enrichers run | 12 | 5 | — |
| Guarantees checked | 3 (all) | 1 (selective) | — |

## Scenario 2: Large Change (5 files, 50% blast radius)

| Metric | Full Re-enrichment | Selective Enrichment | Speedup |
|--------|-------------------|---------------------|---------|
| Time (ms) | 450 | 380 | 1.18x |
| Enrichers run | 12 | 10 | — |
| Guarantees checked | 3 (all) | 3 (selective matched all) | — |

## Interpretation

- **Small changes** (typical watch mode): Selective enrichment provides 2-3x speedup
- **Large changes** (initial analysis or major refactor): Selective enrichment overhead negligible (1.1-1.3x)
- **Guarantee filtering**: Reduces redundant checks by ~66% when types don't overlap
```

## Implementation Steps

### STEP 1: Prepare Fixture (Kent will create in parallel with Rob)

**test/fixtures/enrichment-pipeline/**:
- 5-10 JS files with imports, function calls, eval() calls (for guarantee tests)
- package.json (marks as project root)
- .grafemaignore with patterns for testing ignore logic

### STEP 2: Write Integration Tests (Kent)

**test/integration/EnrichmentPipeline.test.ts**:
- Use describe/it from node:test (project standard)
- TestBackend helper for RFDB backend (from test/helpers/TestRFDB.js)
- Orchestrator with minimal plugin set (JSModuleIndexer, JSASTAnalyzer, MethodCallResolver, ImportExportLinker)
- createTestOrchestrator helper (similar to cross-service-tracing.test.ts pattern)

**Helper functions**:
```typescript
// Create orchestrator with custom plugins for testing
function createEnrichmentOrchestrator(backend, plugins?) {
  return new Orchestrator({
    graph: backend,
    plugins: plugins ?? [
      new JSModuleIndexer(),
      new JSASTAnalyzer(),
      new MethodCallResolver(),
      new ImportExportLinker(),
    ],
    logLevel: 'silent', // Reduce noise in tests
  });
}

// Simulate file edit by modifying content hash
async function simulateFileEdit(backend, filePath, newContent) {
  // Update MODULE node's contentHash field
  // Or use forceAnalysis=true to trigger re-analysis
}

// Count enricher executions (via debug logs or graph plugin nodes)
function countEnricherExecutions(orchestrator) {
  // Parse logs or query PLUGIN nodes with execution count
}
```

### STEP 3: Benchmark Tests (Kent)

**Benchmark structure**:
- NOT using dedicated benchmark tool (node --test doesn't have built-in benchmarks)
- Simple timing: `const start = Date.now(); await orchestrator.run(); const duration = Date.now() - start;`
- Run each scenario 3 times, take median (reduce variance)
- Write results to EnrichmentBenchmark.md (or assert speedup thresholds)

**Benchmark assertions**:
```typescript
assert.ok(selectiveTime < fullTime * 0.5, 
  `Selective enrichment should be <50% of full for small change. Got: ${selectiveTime}ms vs ${fullTime}ms`);
```

### STEP 4: Coverage Gap Tests (Kent)

**Coverage canary validation**:
- Modify file content WITHOUT changing AST (add comment)
- Run analysis
- Check logs for coverage gap warning
- Current implementation: Orchestrator.checkCoverageGaps() logs warning if changedTypes.size === 0

**Note**: Full per-file delta tracking (RFD-19+) not yet implemented. These tests validate the canary warning only.

## File Checklist (for Implementation)

**New files**:
- test/integration/EnrichmentPipeline.test.ts (~500-700 LOC)
- test/fixtures/enrichment-pipeline/src/*.js (5-10 files, ~50-100 LOC total)
- test/fixtures/enrichment-pipeline/package.json (~20 LOC)
- test/fixtures/enrichment-pipeline/.grafemaignore (~5 LOC)
- _tasks/RFD-19/EnrichmentBenchmark.md (~100 LOC, generated by benchmark tests)

**Modified files**:
- None (integration tests are additive)

## Key Decisions

### 1. Integration vs Unit Tests
**Decision:** Integration tests in test/integration/  
**Rationale:** Testing full pipeline flow requires real Orchestrator + RFDB. Mocking PhaseRunner would miss integration bugs. Similar to cross-service-tracing.test.ts pattern.

### 2. Orchestrator vs PhaseRunner
**Decision:** Test via Orchestrator (real graph backend)  
**Rationale:** PhaseRunner is an implementation detail extracted from Orchestrator. Integration tests should validate user-facing API (Orchestrator.run()). Unit tests already cover PhaseRunner internals.

### 3. Fixture Structure
**Decision:** Small JS fixture (5-10 files) in test/fixtures/enrichment-pipeline/  
**Rationale:** Large enough to test blast radius, small enough for fast tests. JS (not TS) avoids type system complexity.

### 4. Benchmark Approach
**Decision:** Simple Date.now() timing, no dedicated benchmark tool  
**Rationale:** node --test has no built-in benchmarks. External tools (benchmark.js) add dependency. Simple timing sufficient for regression detection. Write results to markdown for manual review.

### 5. Coverage Gap Detection
**Decision:** Test canary warning only (changedTypes.size === 0)  
**Rationale:** Full per-file delta tracking (comparing contentHash before/after) requires RFD-19+ storage. Current implementation logs warning if enrichment produces no types. Tests validate this warning appears/disappears correctly.

## Risk Analysis

**LOW RISK**:
- Integration tests are additive (no existing code changes)
- Fixture is isolated (no impact on other tests)
- Benchmark output is informational (no assertions on absolute values, only relative speedup)

**MEDIUM RISK**:
- Benchmark timing may be flaky in CI (virtualized environment, noisy neighbors)
- **Mitigation:** Run 3 times, take median. Relax thresholds (2x → 1.5x for small change).

**NO RISK**:
- No architectural changes
- No refactoring required
- No existing behavior modification

## Success Criteria

1. All 15 tests pass
2. Benchmark shows selective enrichment 2-3x faster for small changes
3. Coverage gap warning correctly detected/absent
4. Tests run in <10 seconds total (fast feedback loop)

## Open Questions

**Q1:** Should benchmark results be committed (EnrichmentBenchmark.md) or printed to console only?  
**A1:** Commit to _tasks/RFD-19/ as documentation. Not part of test suite (informational only).

**Q2:** Should we test parallel analysis (queue-based) or only sequential?  
**A2:** Sequential only. Parallel analysis is separate feature (REG-xxx) with own tests. This task validates enrichment pipeline logic, not execution model.

**Q3:** Should guarantee violations fail tests or just verify they appear in diagnostics?  
**A3:** Verify in diagnostics only (don't throw). Tests validate guarantee system integration, not specific rule logic.

## Dependencies

**Blocked by:** None (T5.1-T5.4 complete)  
**Blocks:** None (validation task)

## Estimated Scope

- **Fixture creation:** 1-2 hours
- **Integration tests (15 tests):** 6-8 hours
- **Benchmark tests + report:** 2-3 hours
- **Total:** 9-13 hours (11-13 days in original estimate)

## Alignment with Vision

**"AI should query the graph, not read code"** — These tests validate that incremental analysis correctly maintains graph state. Selective enrichment ensures watch mode performance scales, making the graph the fastest way to understand code changes.

**TDD** — Tests written first will lock pipeline behavior before future refactoring (e.g., moving to RFDBv2, adding more enrichers).

**Dogfooding** — Could use Grafema MCP to explore test structure patterns, but direct file reads are fine for test implementation (no exploratory phase needed).

---

**Next:** Hand off to Kent (tests) and Rob (fixture creation, can run in parallel).
