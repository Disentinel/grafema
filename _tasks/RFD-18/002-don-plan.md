# Don's Plan: RFD-18 Guarantee Integration

## Summary

Move guarantee checking from VALIDATION phase to a standalone post-enrichment hook. Add selective checking based on changed types and coverage monitoring via content_hash canary.

**Config:** Mini-MLA (Don → Uncle Bob → Kent ∥ Rob → Auto-Review → Vadim)

## Current State

- `GuaranteeManager.ts` (583 LOC) — standalone class, `checkAll()` / `check()` methods work on fully enriched graph
- `Orchestrator.ts` — pipeline: ANALYSIS → ENRICHMENT → strict mode barrier → VALIDATION
- `PhaseRunner.ts` (279 LOC) — executes plugins with batch/delta support (RFD-16)
- Guarantees are NOT currently auto-checked in pipeline — only on-demand via MCP/CLI
- VALIDATION phase only creates ISSUE nodes — no guarantee checking there
- `CommitDelta` with `changedNodeTypes`/`changedEdgeTypes` already available from RFD-16

## Design Decisions

### D1: Guarantee check = standalone method in Orchestrator (not a phase)
Guarantees are not plugins — they're Datalog rules stored in graph. Adding them as a method call between ENRICHMENT and VALIDATION is cleaner than a pseudo-phase.

### D2: PhaseRunner.runPhase() returns accumulated delta types
Currently returns `void`. Change to return `Set<string>` with accumulated changedNodeTypes + changedEdgeTypes from all plugins in the phase. Only ENRICHMENT phase result matters for guarantees.

### D3: GuaranteeManager gets `checkSelective(changedTypes)` method
Parses Datalog rules for referenced node/edge type names, filters guarantees by matching `changedTypes`. Falls back to `checkAll()` when no delta available.

### D4: Coverage monitoring as separate method in Orchestrator
Checks if `changedFiles` from delta have content changes but identical analysis output. Logs warnings — no ISSUE nodes yet (future work per spec).

## Changes

### 1. PhaseRunner.ts — return accumulated types (~15 LOC)

**Change:** `runPhase()` return type from `Promise<void>` to `Promise<Set<string>>`

```typescript
async runPhase(phaseName: string, context: ...): Promise<Set<string>> {
  // ... existing code ...
  const accumulatedTypes = new Set<string>();
  // ... existing delta accumulation logic unchanged ...
  return accumulatedTypes;
}
```

### 2. Orchestrator.ts — add guarantee hook (~60 LOC)

**In `run()` method**, between strict mode barrier and VALIDATION:

```typescript
// After ENRICHMENT, before VALIDATION:
const enrichmentTypes = await this.runPhase('ENRICHMENT', { ... });

// ... strict mode barrier (unchanged) ...

// POST-ENRICHMENT: Guarantee checking
await this.runGuaranteeCheck(enrichmentTypes);

// VALIDATION (unchanged)
await this.runPhase('VALIDATION', { ... });
```

**New private method `runGuaranteeCheck(changedTypes)`:**
1. Check if guarantees file exists → skip if not
2. Import guarantees from YAML (if not already in graph)
3. If changedTypes non-empty → `checkSelective(changedTypes)`, else `checkAll()`
4. Collect violations into `diagnosticCollector`
5. Log summary

**In `reanalyze()` method** — same pattern, add guarantee check after enrichment.

### 3. GuaranteeManager.ts — add selective checking (~50 LOC)

**New method `checkSelective(changedTypes: Set<string>)`:**

```typescript
async checkSelective(changedTypes: Set<string>): Promise<CheckAllResult> {
  const guarantees = await this.list();
  const relevant = guarantees.filter(g => {
    const types = this.extractRelevantTypes(g.rule);
    return types.length === 0 || types.some(t => changedTypes.has(t));
  });
  // Check only relevant guarantees
  // Return CheckAllResult with total = all, results = only relevant checked
}
```

**New private method `extractRelevantTypes(rule: string): string[]`:**
Parse Datalog rule for type references:
- `node(X, "TYPE")` → extracts TYPE
- `edge(X, Y, "EDGE_TYPE")` → extracts EDGE_TYPE

Guarantees with no extractable types = always check (conservative).

### 4. Coverage monitoring (~30 LOC)

**New private method in Orchestrator `checkCoverageGaps(enrichmentDelta)`:**
- For each file in changedFiles: if content changed but no new/removed nodes → warn
- Skip files without contentHash (EXTERNAL_MODULE etc.)
- Log warnings only (per spec: "Future: create ISSUE nodes")

### 5. Orchestrator.runPhase() wrapper — propagate return value (~5 LOC)

The `Orchestrator.runPhase()` proxy method needs to return the `Set<string>` from PhaseRunner:

```typescript
async runPhase(phaseName: string, context: ...): Promise<Set<string>> {
  return this.phaseRunner.runPhase(phaseName, context);
}
```

## Files Modified

| File | Changes | LOC |
|------|---------|-----|
| `packages/core/src/PhaseRunner.ts` | Return accumulated types | ~15 |
| `packages/core/src/Orchestrator.ts` | Guarantee hook + coverage monitoring | ~90 |
| `packages/core/src/core/GuaranteeManager.ts` | `checkSelective()` + `extractRelevantTypes()` | ~50 |
| `test/unit/GuaranteeIntegration.test.ts` | New test file | ~300 |

**Total: ~155 LOC production + ~300 LOC tests**

## Test Plan

Following task spec test plan (12 tests):

| # | Test | What it verifies |
|---|------|------------------|
| 1 | `guarantees_after_enrichment` | Guarantee check called AFTER all enrichers complete |
| 2 | `guarantee_not_during_enrichment` | No guarantee checks between enricher runs |
| 3 | `selective_check_by_type` | Change FUNCTION → only FUNCTION-rules checked |
| 4 | `selective_no_match_skips` | Change CALL → FUNCTION-only rules skipped |
| 5 | `all_rules_without_delta` | No delta → all guarantees checked (conservative) |
| 6 | `rules_without_types_always_checked` | Rules with no parseable types → always check |
| 7 | `coverage_gap_detected` | Content changed + analysis same → warning logged |
| 8 | `coverage_gap_not_for_empty_hash` | contentHash='' → no coverage warning |
| 9 | `violations_in_diagnostics` | Violations collected in DiagnosticCollector |
| 10 | `extractRelevantTypes_parses_rule` | Unit test for Datalog type extraction |
| 11 | `phaseRunner_returns_accumulated_types` | runPhase() returns Set<string> with changed types |
| 12 | `reanalyze_checks_guarantees` | Reanalyze path also runs guarantee check |

Test approach: Mock graph + mock GuaranteeManager, similar to SelectiveEnrichment.test.ts pattern. No integration tests needed — existing GuaranteeManager.test.js already validates Datalog execution.

## Risk Assessment

**LOW risk:**
- PhaseRunner return type change is backward-compatible (callers that ignore return value still work)
- GuaranteeManager additions are new methods, no existing behavior changes
- All existing guarantee tests pass (they test the manager in isolation)
- Orchestrator changes are additive (new method + 2 call sites)

## Execution Order

1. Kent writes tests (GuaranteeIntegration.test.ts)
2. Rob implements PhaseRunner return type → GuaranteeManager.checkSelective() → Orchestrator hook + coverage monitoring
3. Build + run tests
