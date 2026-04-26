# RFD-17: Enricher Dependency Propagation — Don's Plan

## Summary

Replace single-pass enrichment loop with queue-based propagation. When enricher A produces delta changes, downstream enrichers consuming those edge types get enqueued and re-run. Queue respects topological order, termination guaranteed by DAG + processed-set deduplication.

## Design Decisions

### 1. Global propagation (not file-scoped)
Current enrichers run once globally (not per-file). The task spec mentions "file X" but this is for future incremental analysis (T6.x). For now: enricher-level propagation only.

### 2. Consumer index in buildDependencyGraph
Extend `buildDependencyGraph()` to return both forward deps (ToposortItem[]) AND reverse consumer index (Map<EdgeType, Set<enricherName>>). Single pass builds both. Keeps dependency logic centralized.

### 3. Propagation method in PhaseRunner
Extract queue-based enrichment as `runEnrichmentWithPropagation()` private method. Non-ENRICHMENT phases and non-batch backends use existing loop unchanged.

### 4. Termination
- DAG guaranteed by Kahn's algorithm (toposort detects cycles)
- Each enricher runs at most once (processed set)
- Dequeue respects topo order → no enricher runs before its dependencies
- Worst case = all enrichers run once = v1 behavior
- Safety bound: MAX_ITERATIONS = enrichers.length (one per enricher)

## Implementation Plan

### Phase 1: buildDependencyGraph.ts (~15 LOC change)

**File:** `packages/core/src/core/buildDependencyGraph.ts` (75 → ~90 lines)

1. Add `EnricherDependencyInfo` interface:
```typescript
export interface EnricherDependencyInfo {
  items: ToposortItem[];
  consumerIndex: Map<string, Set<string>>; // edgeType → Set<enricherName>
}
```

2. Build consumer index during the existing plugin loop:
   - For each plugin with `consumes`, register in consumer map
   - Self-references excluded (same logic as forward deps)

3. Return `{ items, consumerIndex }` instead of plain `ToposortItem[]`

4. Update PhaseRunner caller: `toposort(buildDependencyGraph(...).items)`

### Phase 2: PhaseRunner.ts propagation (~80 LOC new method)

**File:** `packages/core/src/PhaseRunner.ts` (279 → ~370 lines)

1. Extract `runEnrichmentWithPropagation()` private method
2. In `runPhase()`, branch: if ENRICHMENT + batch → use propagation method, else existing loop
3. Propagation algorithm:

```
pending = Set<enricherName>
processed = Set<enricherName>

// Seed: all level-0 enrichers + level-1+ with consumed types in initial delta
for each enricher:
  if level-0: pending.add(name)

while pending not empty:
  enricherName = dequeueNext(pending, sortedIds) // respects topo order
  if processed.has(enricherName): continue

  run enricher → delta
  processed.add(enricherName)

  if delta.changedEdgeTypes non-empty:
    for each edgeType in changedEdgeTypes:
      for each consumer of edgeType (from consumerIndex):
        if not processed: pending.add(consumer)
```

4. Reuse existing context-building, diagnostics, progress reporting
5. `dequeueNextEnricher()`: iterate sorted IDs, return first that's in pending set

### Phase 3: Tests (~150 LOC new file)

**File:** `test/unit/EnrichmentPropagation.test.ts`

Reuse `createDeltaMockGraph`, `createEnrichmentPlugin`, `makeDelta` patterns from SelectiveEnrichment.test.ts.

10 tests per task spec:
1. **propagation_basic** — A produces X, B consumes X, A's delta has X → B runs
2. **propagation_chain** — A→B→C, deltas cascade
3. **propagation_no_change** — A's delta empty → B not triggered
4. **propagation_multiple_files** — SKIP (future T6.x, add placeholder test documenting this)
5. **termination_guaranteed** — diamond pattern A→B,C→D terminates correctly
6. **worst_case_all_rerun** — all produce changes → all run exactly once
7. **no_cycles** — cyclic consumes/produces → toposort throws
8. **topological_order** — B not dequeued before A when B depends on A
9. **independent_enrichers** — A,B both level-0, both enqueued and run
10. **queue_respects_dependencies** — even if C enqueued first, A runs first per topo order

### Phase 4: Update existing callers (~5 LOC)

- `PhaseRunner.ts` line 106: `buildDependencyGraph(phasePlugins)` → `buildDependencyGraph(phasePlugins).items`
- Existing tests should pass without changes (they use Orchestrator, which delegates to PhaseRunner)

## Files Changed

| File | Current LOC | After | Change |
|------|-------------|-------|--------|
| `packages/core/src/core/buildDependencyGraph.ts` | 75 | ~90 | +15 (interface + consumer index) |
| `packages/core/src/PhaseRunner.ts` | 279 | ~370 | +90 (propagation method) |
| `test/unit/EnrichmentPropagation.test.ts` | NEW | ~200 | New test file |

**Total production: ~105 LOC. Total tests: ~200 LOC.**

## Risk Assessment

- **LOW**: No RFDB changes, no plugin contract changes, isolated to PhaseRunner
- **MEDIUM**: PhaseRunner grows to ~370 lines (under 500 limit, acceptable)
- Fallback: non-batch backends still use original loop (zero regression risk)

## Commits

1. `feat(core): add consumer index to buildDependencyGraph (RFD-17 Phase 1)`
2. `feat(core): queue-based enrichment propagation in PhaseRunner (RFD-17 Phase 2)`
3. `test: enrichment propagation tests (RFD-17 Phase 3)`
