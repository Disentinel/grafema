# Kent Beck — Tests Report: Plugin Applicability Filter (REG-482)

## Summary

Wrote 13 unit tests in a new test file `test/unit/PluginApplicabilityFilter.test.ts` that lock the behavior of the ANALYSIS phase plugin applicability filter. All 13 tests pass against the current implementation.

## Test File

**Location:** `/Users/vadimr/grafema-worker-1/test/unit/PluginApplicabilityFilter.test.ts`

## Test Structure

Three `describe` blocks covering three concerns:

### 1. extractServiceDependencies (5 tests)

Tests the dependency extraction from manifest, verified indirectly through plugin execution behavior:

| # | Test | Asserts |
|---|------|---------|
| 1 | Service with dependencies — matching covers RUNS | Plugin executes when `express` is in `dependencies` |
| 2 | Service with devDependencies + peerDependencies — merges all | Plugin executes when covered package is in `peerDependencies` |
| 3 | Service without packageJson — SKIPPED | Plugin skipped when no packageJson on service |
| 4 | Service with empty dependencies — SKIPPED | Plugin skipped when `dependencies: {}` |
| 5 | Non-service unit (no metadata) — SKIPPED | Plugin skipped for raw entrypoints without metadata |

### 2. Plugin skip logic (7 tests)

Tests the filter behavior in `PhaseRunner.runPhase()`:

| # | Test | Asserts |
|---|------|---------|
| 1 | Matching covers RUNS, non-matching SKIPS | Express runs, NestJS skips when only express in deps |
| 2 | Multiple covers — OR logic | DatabaseAnalyzer runs when `mysql` matches (from `['pg', 'mysql', 'mysql2']`) |
| 3 | No covers field — always runs (backward compat) | JSASTAnalyzer always executes |
| 4 | Empty covers array — always runs | `covers: []` treated as "no filter" |
| 5 | Scoped packages match | `@nestjs/common` matched correctly via `Set.has()` |
| 6 | Multiple plugins — mixed run/skip | 4 plugins, 2 run, 2 skip based on service deps |
| 7 | Skip is logged | `[SKIP]` debug message contains plugin name |

### 3. Phase isolation (1 test)

| # | Test | Asserts |
|---|------|---------|
| 1 | ENRICHMENT plugins with covers NOT filtered | Enrichment plugin with non-matching covers still runs |

## Observations

- **Implementation already present.** The filter logic was already in `PhaseRunner.ts` (lines 355-367) and `extractServiceDependencies()` (lines 176-194) when I wrote these tests. All 13 tests pass immediately.
- **Three dependency types merged.** The implementation correctly merges `dependencies`, `devDependencies`, and `peerDependencies` — confirmed by test #2 in the extractServiceDependencies suite.
- **Existing tests unaffected.** All 5 PhaseRunner locking tests (REG-435) and all 8 SelectiveEnrichment tests (RFD-16) continue to pass.

## Test Patterns Used

- Followed existing patterns from `PhaseRunner.test.ts` and `SelectiveEnrichment.test.ts`
- Uses `node:test` + `node:assert` (project standard)
- Creates `Orchestrator` with mock graph + mock plugins, calls `orchestrator.runPhase()`
- Mock plugins track calls via `calls[]` array for execution verification
- Custom logger captures debug messages for log assertion tests

## Run Command

```bash
node --test test/unit/PluginApplicabilityFilter.test.ts
```

**Result:** 13 pass, 0 fail, ~2.7s
