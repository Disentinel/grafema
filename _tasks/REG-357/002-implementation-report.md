# REG-357 Implementation Report

## Changes

### 1. Orchestrator.ts — Three changes

**a) Added `suppressedByIgnoreCount` field (line 173)**
Accumulates `suppressedByIgnore` from enrichment plugin result metadata.

**b) In `runPhase()` — Extract suppressedByIgnore from ENRICHMENT results (after line 892)**
When phase is ENRICHMENT, reads `result.metadata.suppressedByIgnore` and adds to accumulator.

**c) In `runPhase()` — Don't halt on strict mode errors during ENRICHMENT (line 902-907)**
The `hasFatal()` check was terminating the ENRICHMENT phase immediately on the first
strict mode error (code starting with `STRICT_`), preventing:
- Collection of errors from subsequent enrichment plugins
- The strict mode barrier from ever firing

Now, strict mode fatal errors during ENRICHMENT are accumulated (not halted), and the
strict mode barrier at line 444-452 handles them collectively — throwing `StrictModeFailure`
with the full diagnostics list and suppressed count.

**d) In the strict mode barrier (line 451)**
Pass `this.suppressedByIgnoreCount` as second argument to `StrictModeFailure`.

### 2. Test file: OrchestratorStrictSuppressed.test.js

Four tests:
1. Single plugin: `suppressedByIgnore=3` → `StrictModeFailure.suppressedCount === 3`
2. Multiple plugins: sums across plugins (2 + 5 = 7)
3. No metadata: defaults to 0
4. No errors: doesn't throw even with suppressions

## Root Cause Finding

The strict mode barrier (lines 444-452) was effectively dead code because `runPhase()`'s
`hasFatal()` check (line 902) would halt on the first fatal diagnostic — including
`STRICT_*` errors from enrichment plugins. This means:
- Errors from subsequent enrichment plugins were never collected
- `StrictModeFailure` was never thrown
- CLI's `formatStrict()` was never reached

The fix addresses both the original issue (passing `suppressedCount`) AND the root cause
(strict mode errors being halted prematurely).
