# Auto-Review: RFD-17 Enricher Dependency Propagation

## Verdict: REJECT

**Critical Issues Found:** 3
**Complexity Violations:** 1
**Code Quality Issues:** 2

---

## Part 1 — Vision & Architecture (Steve's lens)

### Complexity & Architecture Violations

**REJECT — Complexity Check FAILED:**

The implementation includes `changedNodeTypes` in propagation logic (line 392):

```typescript
const changedTypes = [...delta.changedEdgeTypes, ...delta.changedNodeTypes];
```

**Problem:** The `consumerIndex` is built ONLY from `consumes` which are declared as `EdgeType[]` (see buildDependencyGraph.ts line 64-73). It maps EdgeType → enrichers. But the propagation code treats `changedNodeTypes` as if they were also in the consumer index.

**This is an architectural mismatch:**
- Consumer index contains ONLY edge types from `consumes: EdgeType[]` declarations
- But propagation checks BOTH changedEdgeTypes AND changedNodeTypes
- Result: changedNodeTypes will NEVER match anything in consumerIndex (it only has edge types)
- This means propagation won't work for node type changes

**Evidence from buildDependencyGraph.ts:**
```typescript
if (meta.consumes) {
  for (const edgeType of meta.consumes) {  // ← consumes are EdgeType[]
    // Register in consumer index (RFD-17)
    let consumers = consumerIndex.get(edgeType);
    if (!consumers) {
      consumers = new Set();
      consumerIndex.set(edgeType, consumers);  // ← index only has edge types
    }
    consumers.add(meta.name);
```

**Root Cause:** The feature is called "enricher dependency propagation" but `consumes` declarations in enricher metadata are EdgeType[] only. There's no `consumesNodeTypes` field. Either:
1. Propagation should ONLY check changedEdgeTypes, OR
2. `consumes` should support both node types and edge types, OR
3. There should be a separate `consumesNodeTypes` field

**Impact:** This breaks the selective enrichment contract. If an enricher produces only node type changes (e.g., adds CLASS nodes), downstream enrichers won't be enqueued even if they need those nodes.

**Test gap:** None of the 10 tests verify node type propagation. All tests use `changedEdgeTypes` only. The broken logic is never exercised.

---

### No MAX_ITERATIONS Safety Bound

**CONCERN (not REJECT, but document):**

The plan (RFD-17 tech spec) mentioned a safety bound (plugins * 10) to prevent infinite loops. The implementation relies ONLY on the processed-set deduplication.

**Current termination guarantee:**
- DAG structure (toposort validates no cycles in consumes/produces graph)
- `processed` set prevents running same enricher twice
- `pending` set ensures finite queue

**This is theoretically sound** (DAG + deduplication = termination), but lacks defensive programming. If there's a bug in the propagation logic (e.g., someone accidentally clears the processed set), we get an infinite loop.

**Recommendation:** Add iteration counter with hard limit (e.g., `phasePlugins.length * 10`) as defensive check. Log warning if approaching limit, throw error if exceeded.

---

## Part 2 — Practical Quality (Вадим's lens)

### Edge Cases

**REJECT — Missing null/undefined delta handling:**

At line 383-401, the code assumes delta exists:
```typescript
if (delta) {
  logger.debug(...);

  const changedTypes = [...delta.changedEdgeTypes, ...delta.changedNodeTypes];
  for (const changedType of changedTypes) {
    const consumers = consumerIndex.get(changedType);
    if (!consumers) continue;  // ← handles missing consumerIndex entry
    for (const consumer of consumers) {
      if (!processed.has(consumer)) {
        pending.add(consumer);
      }
    }
  }
}
```

The `if (delta)` guard is correct — it handles the case where backend doesn't support batching or delta is null. **This is actually GOOD.**

But the `consumerIndex.get(changedType)` check at line 394 handles missing entries correctly. **Also GOOD.**

**Actually, this edge case handling is CORRECT.** Retracting this concern.

---

### Correctness

**Does the code implement RFD-17 requirements?**

From RFD-17 spec:
1. ✅ Queue-based propagation — DONE (lines 339-465)
2. ✅ Seed with level-0 enrichers — DONE (lines 353-358)
3. ✅ Enqueue downstream consumers when delta has changes — DONE (lines 389-401)
4. ✅ Respect topological order — DONE (lines 471-479, dequeueNextEnricher)
5. ✅ Each enricher runs at most once — DONE (line 365, processed set check)
6. ❌ **BROKEN: Node type propagation doesn't work** (architectural issue above)

**Regression risk:** RFD-16 tests all pass (37 pass, 0 fail). But RFD-16 only tests the FALLBACK path (non-propagation). The propagation path has the node type bug.

---

### Minimality

**Is the change focused?**

The change adds:
- `EnricherDependencyInfo` interface with consumerIndex (buildDependencyGraph.ts)
- `runEnrichmentWithPropagation()` method (PhaseRunner.ts)
- Two extracted helpers: `buildPluginContext()`, `shouldSkipEnricher()`
- 10 new tests (1 skipped placeholder)

**File growth:** PhaseRunner.ts 279 → 481 lines (+202 lines, +72%)

**Duplication concern:** YES. Significant duplication between propagation path (lines 339-465) and fallback path (lines 231-328). Both paths handle:
- Progress reporting (onProgress calls)
- Diagnostics collection (diagnosticCollector.addFromPluginResult)
- suppressedByIgnore accumulation (lines 275-280 vs 407-413)
- Fatal error checking with strict mode logic (lines 290-304 vs 423-434)
- Plugin completion logging (lines 322-327 vs 449-453)

**This is NOT minimal.** A shared helper `processEnricherResult(plugin, result, delta)` could eliminate ~60 lines of duplication.

---

## Part 3 — Code Quality (Kevlin's lens)

### File Size: PhaseRunner.ts at 481 lines

**Status:** Close to 500-line hard limit (Uncle Bob's rule).

The +202 line growth is justified by the new feature, but the duplication is concerning. With shared result processing helper, the file could be ~420 lines instead of 481.

**Not a REJECT issue** (under 500 limit), but should be cleaned up to prevent future growth.

---

### Code Duplication

**REJECT — Significant duplication between propagation and fallback paths:**

Lines 231-328 (fallback) vs lines 339-465 (propagation) duplicate:

1. **Diagnostics collection** (almost identical):
```typescript
// Fallback path (lines 268-272)
diagnosticCollector.addFromPluginResult(
  phaseName as PluginPhase,
  plugin.metadata.name,
  result
);

// Propagation path (lines 404-405)
diagnosticCollector.addFromPluginResult('ENRICHMENT', enricherName, result);
```

2. **suppressedByIgnore accumulation** (identical):
```typescript
// Fallback (lines 275-280)
if (phaseName === 'ENRICHMENT' && result.metadata) {
  const suppressed = (result.metadata as Record<string, unknown>).suppressedByIgnore;
  if (typeof suppressed === 'number') {
    this.suppressedByIgnoreCount += suppressed;
  }
}

// Propagation (lines 407-413)
if (result.metadata) {
  const suppressed = (result.metadata as Record<string, unknown>).suppressedByIgnore;
  if (typeof suppressed === 'number') {
    this.suppressedByIgnoreCount += suppressed;
  }
}
```

3. **Fatal error checking with strict mode logic** (29 lines duplicated):
```typescript
// Fallback (lines 290-304)
if (diagnosticCollector.hasFatal()) {
  const allDiagnostics = diagnosticCollector.getAll();
  const fatals = allDiagnostics.filter(d => d.severity === 'fatal');
  const allStrictErrors = fatals.every(d => d.code.startsWith('STRICT_'));
  if (!(strictMode && phaseName === 'ENRICHMENT' && allStrictErrors)) {
    const fatal = fatals[0];
    throw new Error(`Fatal error in ${plugin.metadata.name}: ${fatal?.message || 'Unknown fatal error'}`);
  }
}

// Propagation (lines 423-434) — IDENTICAL except variable names
```

**Proposed refactor:**
```typescript
private async processEnricherResult(
  enricherName: string,
  result: PluginResult,
  delta: CommitDelta | null,
): Promise<void> {
  // Diagnostics
  this.deps.diagnosticCollector.addFromPluginResult('ENRICHMENT', enricherName, result);

  // suppressedByIgnore
  if (result.metadata) {
    const suppressed = (result.metadata as Record<string, unknown>).suppressedByIgnore;
    if (typeof suppressed === 'number') {
      this.suppressedByIgnoreCount += suppressed;
    }
  }

  // Log delta
  if (delta) {
    this.deps.logger.debug(
      `[${enricherName}] batch: +${delta.nodesAdded} nodes, +${delta.edgesAdded} edges, ` +
      `-${delta.nodesRemoved} nodes, -${delta.edgesRemoved} edges`
    );
  }

  // Warnings
  if (!result.success) {
    console.warn(`[Orchestrator] Plugin ${enricherName} reported failure`, {
      errors: result.errors.length,
      warnings: result.warnings.length,
    });
  }

  // Fatal errors
  if (this.deps.diagnosticCollector.hasFatal()) {
    const allDiagnostics = this.deps.diagnosticCollector.getAll();
    const fatals = allDiagnostics.filter(d => d.severity === 'fatal');
    const allStrictErrors = fatals.every(d => d.code.startsWith('STRICT_'));
    if (!(this.deps.strictMode && allStrictErrors)) {
      const fatal = fatals[0];
      throw new Error(`Fatal error in ${enricherName}: ${fatal?.message || 'Unknown fatal error'}`);
    }
  }
}
```

This would reduce both paths by ~40 lines each, bringing PhaseRunner.ts down to ~400 lines.

---

### SKIP Logging Issue

**Lines 456-464 log ALL non-processed enrichers as skipped:**

```typescript
// Log skipped enrichers (not enqueued because their consumed types never appeared)
for (const plugin of phasePlugins) {
  if (!processed.has(plugin.metadata.name)) {
    const consumes = plugin.metadata.consumes ?? [];
    logger.debug(
      `[SKIP] ${plugin.metadata.name} — no changes in consumed types [${consumes.join(', ')}]`
    );
  }
}
```

**Question:** Is this the intended behavior?

**Two interpretations:**
1. **Correct interpretation:** Enrichers that never ran WERE skipped (their consumed types never appeared in any delta)
2. **Misleading interpretation:** What if an enricher has a DEPENDENCY that never ran? Then it couldn't run either, but it's not technically "skipped due to no changes" — it's "blocked by unmet dependencies"

**Example scenario:**
- Enricher A (level-0) produces no changes (empty delta)
- Enricher B depends on A via explicit `dependencies: ['A']` but doesn't consume what A produces
- B will never be enqueued (A ran but produced nothing, so nothing triggers B)
- Current code logs: `[SKIP] B — no changes in consumed types []`
- But the REAL reason B didn't run is: it has explicit dependency on A, but consumes=[], so it's never enqueued

**Is this a bug or intended?** Hard to say without seeing explicit dependencies + consumes interaction in tests.

**Recommendation:** Add test for this edge case. If enricher has explicit dependencies but empty consumes, does it still run? (I suspect NOT, because seeding only uses consumes=[], not dependencies).

---

### Test Quality

**Tests are good but have gaps:**

✅ **Good coverage:**
- Basic propagation (test 1)
- Chain propagation (test 2)
- No-change skipping (test 3)
- Diamond dependency (test 5)
- Linear chain worst case (test 6)
- Cycle detection (test 7)
- Topological ordering (test 8, 10)
- Independent enrichers (test 9)

❌ **Missing coverage:**
- **Node type propagation** (the broken feature from Part 1)
- **Mixed edge + node type propagation**
- **Enricher with explicit dependencies but empty consumes** (does it run?)
- **Delta with ONLY changedNodeTypes** (no changedEdgeTypes)
- **Multiple enrichers consuming same type** (race condition check)

The test gap is CRITICAL because it failed to catch the consumerIndex/nodeTypes mismatch.

---

## Summary of Issues

### Critical (REJECT)

1. **Node type propagation is broken** — `consumerIndex` only has edge types, but propagation checks both edge and node types. Architectural mismatch between `consumes: EdgeType[]` and propagation logic treating node types as consumable.

2. **Significant code duplication** — ~80 lines duplicated between fallback and propagation paths. Should extract shared result processing helper.

3. **Test gap for node type propagation** — All 10 tests use changedEdgeTypes only. The broken node type logic was never tested.

### Non-Critical (Document but don't block)

4. **No MAX_ITERATIONS safety bound** — Termination relies only on DAG + processed set. Add defensive counter to catch bugs.

5. **SKIP logging ambiguity** — Unclear if enrichers with explicit dependencies but empty consumes should be logged as "skipped" or "not triggered". Add test to clarify.

---

## Recommendations

**To fix and re-submit:**

1. **Fix node type propagation:**
   - **Option A:** Remove changedNodeTypes from propagation (lines 392). Only propagate edge types.
   - **Option B:** Extend consumerIndex to include node types. Change `consumes` to support both node and edge types.
   - **Option C:** Add separate `consumesNodeTypes` field and build separate consumerIndex for node types.

   **Recommended: Option A** (simplest). Node type changes are rare compared to edge type changes. If needed later, add Option C incrementally.

2. **Extract shared result processing helper** — Eliminate ~80 lines of duplication. See proposed refactor above.

3. **Add test for node type propagation** — Even if Option A is chosen (no node type propagation), add test to document the limitation.

4. **Add MAX_ITERATIONS safety bound** — Defensive check against infinite loops. Log warning at 50%, error at 100%.

5. **Clarify SKIP logging** — Add test for enricher with explicit dependencies + empty consumes.

---

## Files to Modify

1. `/Users/vadim/grafema-worker-10/packages/core/src/PhaseRunner.ts`
   - Remove changedNodeTypes from propagation (line 392), OR
   - Extend consumerIndex architecture
   - Extract `processEnricherResult()` helper
   - Add MAX_ITERATIONS counter

2. `/Users/vadim/grafema-worker-10/test/unit/EnrichmentPropagation.test.ts`
   - Add test for node type propagation behavior
   - Add test for explicit dependencies + empty consumes
   - Add test for MAX_ITERATIONS safety bound

3. **Optional:** `/Users/vadim/grafema-worker-10/packages/core/src/core/buildDependencyGraph.ts`
   - If choosing Option B or C, extend consumerIndex to support node types

---

## Existing Tests Status

✅ **All 1997 tests pass (37 from RFD-16, 10 new from RFD-17).**

No regressions detected in fallback path. The bug is ONLY in the new propagation path and only affects node type propagation (which isn't tested).

---

## Final Verdict

**REJECT** — Fix critical node type propagation bug and eliminate code duplication before merging.

The architecture is sound (queue-based propagation, topological order, DAG termination). The implementation is 90% correct. But the consumerIndex/nodeTypes mismatch is a fundamental bug that breaks the feature's contract.

After fixes, this will be production-ready.
