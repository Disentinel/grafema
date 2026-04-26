# Auto-Review: RFD-16 Orchestrator Batch Protocol

**Date:** 2026-02-15
**Reviewer:** Combined Auto-Review (vision + practical + code quality)

## Verdict: REJECT

## Vision & Architecture: CRITICAL ISSUES

### Issue 1: Wrong File for GraphBackend Interface ❌

**Plan says:** Add batch methods to `packages/types/src/GraphBackend.ts`

**Reality:** The GraphBackend interface used by plugins is at `packages/types/src/plugins.ts:276-314`. There is no `GraphBackend.ts` file.

**Fix:** Change all references to the correct file: `packages/types/src/plugins.ts`

---

### Issue 2: Fixed-Point Loop is WRONG Architecture ❌

**Plan says (line 221-253):**
```typescript
while (queue.size > 0) {
  const sortedQueue = toposort(queue, depGraph);
  for (const enricher of sortedQueue) {
    const delta = await this.runEnricherWithBatch(...);
    const affected = findAffectedEnrichers(delta, enrichers, depGraph);
    affected.forEach(e => queue.add(e));
  }
}
```

**This is O(E²) complexity — potentially infinite iterations!**

**The correct approach (already supported by current code):**

Current enrichment already runs in **toposorted order** (line 1005-1006 of Orchestrator.ts). Toposort GUARANTEES that dependencies run before consumers. A fixed-point loop is unnecessary and dangerous.

**What should happen instead:**

1. **Single pass** in toposorted order (current behavior, keep it)
2. **Before each enricher**, check if ANY of its consumed types appear in the **accumulated delta** from previous enrichers
3. If YES → run the enricher
4. If NO → SKIP it (optimization)

**Example:**
- EnricherA produces `CALLS`
- EnricherB consumes `CALLS`, produces `DATAFLOW`
- EnricherC consumes `IMPORTS`

**Execution:**
1. Run EnricherA → delta has `changedEdgeTypes: ['CALLS']`
2. Check EnricherB: consumes `CALLS`, delta has `CALLS` → RUN → delta now has `['CALLS', 'DATAFLOW']`
3. Check EnricherC: consumes `IMPORTS`, delta has `['CALLS', 'DATAFLOW']` → SKIP

**Complexity:** O(E) — single pass, not a loop.

**Why the plan is wrong:**

The plan conflates two concepts:
- **Dependency ordering** (handled by toposort, one-time)
- **Selective execution** (check delta before running)

Toposort already ensures correct order. We just need to add skip logic based on delta.

---

### Issue 3: Incorrect Function Location ❌

**Plan says:** Create new file `EnricherDependencyGraph.ts` for `findAffectedEnrichers()`

**Reality:** `buildDependencyGraph.ts` already exists and handles enricher dependencies. New function should go THERE, not in a new file.

**Why:** DRY principle. Don't scatter dependency logic across multiple files.

---

### Issue 4: Orchestrator.ts Size — Plan Adds to the Problem ❌

**Current size:** 1326 lines (4× over the 300-line limit)

**Plan proposes:** Add 200 LOC to Orchestrator.ts → 1526 lines

**This violates the Root Cause Policy.** The plan correctly identifies the problem (line 349-358) but then proceeds to make it worse!

**Correct approach (STEP 2.5 - PREPARE):**

BEFORE adding batch logic:
1. Extract phase execution to new file: `EnrichmentPipeline.ts` or `PhaseRunner.ts`
2. Move `runPhase()` method and batch logic there
3. Orchestrator becomes a coordinator, delegates to PhaseRunner

**Why this matters:** Adding to a 1326-line file is how we got 6k-line files in the first place. Stop the bleeding NOW.

---

## Practical Quality: MAJOR ISSUES

### Issue 5: `beginBatch()` is SYNC, Plan Says ASYNC ⚠️

**Plan says (line 69, 82):**
```typescript
beginBatch(): Promise<void>;
async beginBatch(): Promise<void> { ... }
```

**Reality (RFDBClient:1013):**
```typescript
beginBatch(): void {
  if (this._batching) throw new Error('Batch already in progress');
  this._batching = true;
  // ...
}
```

**beginBatch is synchronous** — it just sets local state, doesn't touch the server.

**Fix:** Interface should be `beginBatch(): void` (not Promise). RFDBServerBackend delegates synchronously.

**Same issue for `abortBatch()`** — also sync in RFDBClient.

Only `commitBatch()` is async (it sends RPC).

---

### Issue 6: Type Mismatch — "Enricher" vs "Plugin" ⚠️

**Plan uses:** `Enricher` type (lines 114, 117, 187, 192, etc.)

**Reality:** There is NO `Enricher` interface. Enrichers are just `IPlugin` with `metadata.phase === 'ENRICHMENT'`.

**Current code (Orchestrator:999-1001):**
```typescript
const phasePlugins = this.plugins.filter(plugin =>
  plugin.metadata.phase === phaseName
);
```

**Fix:** All references to `Enricher` type should be `IPlugin`. The plan's abstractions don't match reality.

---

### Issue 7: Scope Confusion — "Enricher" vs "Analyzer" ⚠️

**Plan says (line 162):** Wrap analyzers with `runEnricherWithBatch()`

**Reality:** Analyzers are NOT enrichers. They're `phase: 'ANALYSIS'` plugins.

**Method should be called:** `runPluginWithBatch()` (generic), not `runEnricherWithBatch()` (specific to enrichment).

**Or:** Separate methods: `runAnalyzerWithBatch()` and `runEnricherWithBatch()` if logic differs.

**Current conflation is confusing** — enrichers and analyzers have different responsibilities.

---

## Code Quality: MODERATE ISSUES

### Issue 8: Missing Error Handling in Fixed-Point Loop 🔶

Even if we kept the loop (which we shouldn't), the plan's loop (line 221-253) has no:
- Max iteration limit (infinite loop risk)
- Cycle detection beyond toposort (runtime cycles could happen with bad metadata)
- Progress logging (user has no visibility into iterations)

Plan mentions this (line 407-411) but doesn't add it to the code.

**If a loop were needed** (it's not), MUST have:
```typescript
const MAX_ITERATIONS = 100;
let iteration = 0;
while (queue.size > 0 && iteration < MAX_ITERATIONS) {
  iteration++;
  // ... loop body
}
if (iteration >= MAX_ITERATIONS) {
  throw new Error('Enrichment loop exceeded max iterations — circular dependency?');
}
```

---

### Issue 9: Delta Accumulation Logic Missing 🔶

**Plan doesn't explain HOW to accumulate deltas across enrichers.**

Single pass approach needs:
```typescript
const accumulatedChangedTypes = new Set<string>();

for (const enricher of sortedEnrichers) {
  // Check if enricher should run
  const shouldRun = enricher.consumes.some(type =>
    accumulatedChangedTypes.has(type)
  ) || accumulatedChangedTypes.size === 0; // First enricher always runs

  if (!shouldRun) {
    console.log(`[SKIP] ${enricher.name} — no consumed types changed`);
    continue;
  }

  const delta = await this.runPluginWithBatch(enricher, context, 'ENRICHMENT');

  // Accumulate changed types
  delta.changedNodeTypes.forEach(t => accumulatedChangedTypes.add(t));
  delta.changedEdgeTypes.forEach(t => accumulatedChangedTypes.add(t));
}
```

**Plan's `findAffectedEnrichers()` doesn't fit this model** — it's designed for the wrong (looping) approach.

---

### Issue 10: Test Coverage Gaps 🔶

**Plan's tests don't cover:**
- First enricher runs even with empty delta (nothing consumed yet)
- Skipped enrichers logged clearly
- Delta accumulation across multiple enrichers
- Edge case: ALL enrichers skipped (nothing changed)

Tests focus on the loop approach, not the single-pass approach.

---

## Summary of Required Changes

### MANDATORY (before proceeding):

1. **Fix file path:** `GraphBackend.ts` → `plugins.ts` (everywhere)
2. **Remove fixed-point loop:** Replace with single-pass + skip logic based on accumulated delta
3. **Move to existing file:** `findAffectedEnrichers()` → `buildDependencyGraph.ts` (or remove if loop is gone)
4. **Fix sync/async:** `beginBatch()` and `abortBatch()` are `void`, not `Promise<void>`
5. **Fix type names:** `Enricher` → `IPlugin` (everywhere)
6. **Split Orchestrator.ts FIRST:** Extract phase logic to new module BEFORE adding batch code (STEP 2.5)

### RECOMMENDED (improves plan):

7. Rename method: `runEnricherWithBatch()` → `runPluginWithBatch()` (generic)
8. Add delta accumulation logic to single-pass approach
9. Update tests to match single-pass model
10. Add test: first enricher always runs, subsequent enrichers check delta

---

## Architectural Recommendation

**The plan conflates batch wrapping (good) with execution strategy (wrong).**

**What should be built:**

### Phase 1: Batch Infrastructure ✅ (plan is correct)
- Add batch methods to GraphBackend interface
- Implement in RFDBServerBackend (delegation to RFDBClient)
- Tests: batch lifecycle

### Phase 2: Batch Wrapping ✅ (plan is mostly correct, fix sync/async)
- Add `runPluginWithBatch()` method
- Wrap plugin execution with beginBatch/commitBatch
- Return delta, log it, don't act on it yet

### Phase 3: Selective Execution ❌ (plan is architecturally wrong)

**CORRECT approach:**

```typescript
private async runEnrichmentPhase(context: EnrichmentContext) {
  const enrichers = this.getEnrichersForContext(context);
  const sortedEnrichers = toposort(buildDependencyGraph(enrichers));

  const accumulatedTypes = new Set<string>();

  for (const enricher of sortedEnrichers) {
    // First pass: run all (nothing in graph yet)
    // Subsequent passes: run only if consumed types changed
    const shouldRun = accumulatedTypes.size === 0 ||
      enricher.metadata.consumes?.some(t => accumulatedTypes.has(t));

    if (!shouldRun) {
      this.logger.debug(`[SKIP] ${enricher.metadata.name} — no changes in consumed types`);
      continue;
    }

    const delta = await this.runPluginWithBatch(enricher, context, 'ENRICHMENT');

    // Accumulate types for next enricher
    delta.changedNodeTypes.forEach(t => accumulatedTypes.add(t));
    delta.changedEdgeTypes.forEach(t => accumulatedTypes.add(t));

    this.logger.debug(
      `[${enricher.metadata.name}] +${delta.edgesAdded} edges, ` +
      `types: [${[...new Set([...delta.changedNodeTypes, ...delta.changedEdgeTypes])].join(', ')}]`
    );
  }
}
```

**Complexity:** O(E) — single pass over enrichers
**No loop, no `findAffectedEnrichers()`, no queue.**

Toposort already guarantees correct execution order. We just add skip optimization.

---

## Verdict

**REJECT** — Plan has fundamental architectural issues:

1. **Wrong file path** for GraphBackend (fatal, breaks build)
2. **Wrong execution model** (O(E²) loop instead of O(E) single pass)
3. **Wrong abstraction** (loop + queue instead of skip logic)
4. **Makes Orchestrator.ts worse** instead of fixing it first

**The core idea is sound** (batch wrapping, delta-driven selective execution), but the execution strategy is wrong.

**Recommended next steps:**

1. Don updates plan with single-pass approach (not loop)
2. Uncle Bob reviews Orchestrator.ts and proposes split BEFORE implementation
3. Fix all type/file path issues
4. Re-submit for auto-review

**Estimated fix time:** 2-4 hours (rewrite Phase 3 logic, add Orchestrator split to STEP 2.5)
