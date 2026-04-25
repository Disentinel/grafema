# Don's Plan: RFD-16 Orchestrator Batch Protocol

**Date:** 2026-02-15
**Scope:** ~500 LOC, ~20 tests
**Complexity:** Medium-High (touches orchestration core, needs careful type coordination)

## What We're Actually Building

This task is about getting delta-driven selective enrichment working. Everything else is scaffolding.

**Current state:** Every `graph.addEdge()` in an enricher sends an immediate RPC. 1000 edges = 1000 RPCs. Slow, wasteful, no atomicity.

**Target state:** Each enricher wraps its work in a CommitBatch. Get deltas back. Use deltas to figure out which enrichers to run next.

**The insight:** RFDB v2 already HAS the batch API. RFDBClient already HAS the batch methods. We just need to expose them through GraphBackend and wire them into Orchestrator.

## Architecture

### Three-Layer Batch Exposure

```
Enricher
   ↓ calls
GraphBackend (interface) ← ADD batch methods here
   ↓ implemented by
RFDBServerBackend ← expose RFDBClient batch methods
   ↓ delegates to
RFDBClient ← already has beginBatch/commitBatch/abortBatch
   ↓ wire protocol
rfdb-server (Rust) ← already implements CommitBatch
```

**Current gap:** GraphBackend interface doesn't have batch methods. RFDBServerBackend doesn't expose them.

**Fix:** Add batch methods to GraphBackend, implement in RFDBServerBackend by delegating to RFDBClient.

### Orchestrator Changes

**ENRICHMENT phase** (primary target):
1. For each enricher in toposorted order:
   - `graph.beginBatch()`
   - Run enricher (it calls `addEdge/addNode`)
   - `delta = graph.commitBatch(tags: [enricher.name, 'ENRICHMENT'])`
   - Analyze delta to determine which downstream enrichers need to run
   - Queue dependent enrichers

**ANALYSIS phase** (bonus, simpler):
1. Wrap each analyzer in a batch:
   - `graph.beginBatch()`
   - Run analyzer (it calls `addNode/addEdge`)
   - `graph.commitBatch(tags: [analyzer.name, file.path, 'ANALYSIS'])`

**Key difference:** Analysis phase doesn't need selective re-execution (for now). Enrichment phase DOES.

## Phased Approach

### Phase 1: Batch Infrastructure (DO NOW)

**Goal:** Get batch methods exposed and working.

#### 1.1 GraphBackend Interface (`packages/types/src/GraphBackend.ts`)

Add to interface:
```typescript
export interface GraphBackend {
  // ... existing methods

  // Batch operations
  beginBatch(): Promise<void>;
  commitBatch(tags?: string[]): Promise<CommitDelta>;
  abortBatch(): Promise<void>;
}
```

**Why:** Type contract. All backends must implement.

#### 1.2 RFDBServerBackend (`packages/core/src/backends/RFDBServerBackend.ts`)

Implement batch methods by delegating to RFDBClient:

```typescript
async beginBatch(): Promise<void> {
  await this.client.beginBatch();
}

async commitBatch(tags?: string[]): Promise<CommitDelta> {
  return await this.client.commitBatch(tags);
}

async abortBatch(): Promise<void> {
  await this.client.abortBatch();
}
```

**Why:** Simple pass-through. RFDBClient already has the logic.

**Tests:**
- `test/unit/backends/rfdb-batch.test.js`:
  - beginBatch → addEdge × N → commitBatch returns delta with N edges
  - beginBatch → abortBatch → edges not persisted
  - commitBatch with tags → tags appear in delta
  - nested batch throws error (or delegates to RFDB's handling)

**Estimated:** ~50 LOC (trivial delegation), ~5 tests

### Phase 2: Orchestrator Batch Wrapping (DO NOW)

**Goal:** Wrap enricher execution in CommitBatch calls. Get deltas. Don't use them yet.

#### 2.1 Enricher Execution Wrapper (`packages/core/src/Orchestrator.ts`)

New method:
```typescript
private async runEnricherWithBatch(
  enricher: Enricher,
  context: EnrichmentContext,
  phase: 'ANALYSIS' | 'ENRICHMENT'
): Promise<CommitDelta> {
  const tags = [enricher.name, phase];
  if (context.file) tags.push(context.file.path);

  try {
    await this.graph.beginBatch();
    await enricher.enrich(context);
    const delta = await this.graph.commitBatch(tags);
    return delta;
  } catch (error) {
    await this.graph.abortBatch();
    throw error;
  }
}
```

**Why:** Single point for batch wrapping. Error handling. Tag generation.

#### 2.2 Update `runPhase('ENRICHMENT', ...)`

Replace direct enricher calls with batch-wrapped calls:

```typescript
// OLD
for (const enricher of sortedEnrichers) {
  await enricher.enrich(context);
}

// NEW
for (const enricher of sortedEnrichers) {
  const delta = await this.runEnricherWithBatch(enricher, context, 'ENRICHMENT');
  // TODO: use delta for selective enrichment (Phase 3)
  console.log(`[${enricher.name}] committed: +${delta.edgesAdded.length} edges`);
}
```

**Why:** Get deltas flowing. Log them. Don't act on them yet (that's Phase 3).

#### 2.3 Update `runPhase('ANALYSIS', ...)`

Same pattern for analyzers:

```typescript
for (const analyzer of analyzers) {
  const delta = await this.runEnricherWithBatch(analyzer, context, 'ANALYSIS');
  console.log(`[${analyzer.name}] analyzed ${context.file.path}: +${delta.nodesAdded.length} nodes`);
}
```

**Why:** Analysis phase batching is simpler (no selective re-execution). Good warm-up for enrichment logic.

**Tests:**
- `test/unit/orchestrator-batch.test.js`:
  - Enricher adds edges → commitBatch returns delta with those edges
  - Enricher throws → batch aborted, edges not persisted
  - Tags correctly include enricher name + phase + file path
  - Delta includes `changedEdgeTypes` for added edge types

**Estimated:** ~100 LOC (wrapper + phase updates), ~6 tests

### Phase 3: Delta-Driven Selective Enrichment (DO NOW)

**Goal:** Use CommitDelta to figure out which enrichers need to run.

#### 3.1 Enricher Dependency Graph (`packages/core/src/EnricherDependencyGraph.ts`)

**Existing:** `buildDependencyGraph(enrichers)` already computes which enrichers depend on which via `consumes/produces`.

**New method:**
```typescript
export function findAffectedEnrichers(
  delta: CommitDelta,
  enrichers: Enricher[],
  dependencyGraph: Map<string, Set<string>>
): Enricher[] {
  const changedTypes = new Set([
    ...delta.changedNodeTypes,
    ...delta.changedEdgeTypes
  ]);

  const affected = enrichers.filter(e =>
    e.consumes.some(type => changedTypes.has(type))
  );

  return affected;
}
```

**Why:** Given a delta, find which enrichers consume the changed types.

**Edge case:** If delta contains BOTH nodes and edges, enrichers that consume `NodeType` should trigger. `changedNodeTypes` includes node types from `nodesAdded/nodesRemoved`. `changedEdgeTypes` includes edge types from `edgesAdded/edgesRemoved`.

**Tests:**
- Enricher consumes `CALLS` edge → delta has `edgesAdded` with `CALLS` → enricher affected
- Enricher consumes `FUNCTION` node → delta has `nodesAdded` with `FUNCTION` → enricher affected
- Enricher consumes `IMPORTS` → delta has `CALLS` → enricher NOT affected
- Delta is empty → no enrichers affected

**Estimated:** ~50 LOC, ~4 tests

#### 3.2 Orchestrator Selective Enrichment Loop

Replace sequential enrichment with delta-driven loop:

```typescript
private async runEnrichmentPhase(context: EnrichmentContext) {
  const enrichers = this.getEnrichersForContext(context);
  const depGraph = buildDependencyGraph(enrichers);

  // Start with ALL enrichers (first pass)
  let queue: Set<Enricher> = new Set(enrichers);
  const completed = new Set<string>();

  while (queue.size > 0) {
    // Toposort queue based on dependency graph
    const sortedQueue = toposort(queue, depGraph);

    for (const enricher of sortedQueue) {
      if (completed.has(enricher.name)) continue;

      const delta = await this.runEnricherWithBatch(enricher, context, 'ENRICHMENT');
      completed.add(enricher.name);

      // Find downstream enrichers affected by this delta
      const affected = findAffectedEnrichers(delta, enrichers, depGraph);
      affected.forEach(e => {
        if (!completed.has(e.name)) queue.add(e);
      });
    }

    // Next iteration: only run enrichers affected by previous commits
    queue = new Set(
      Array.from(queue).filter(e => !completed.has(e.name))
    );
  }
}
```

**Why:**
- First pass runs all enrichers (nothing in graph yet).
- Each commit produces a delta.
- Delta tells us which downstream enrichers need to run.
- Loop until no new enrichers are affected.

**Key insight:** This is a **fixed-point computation**. Run enrichers → get deltas → queue affected enrichers → repeat until queue is empty.

**Tests:**
- EnricherA produces `CALLS`, EnricherB consumes `CALLS` → both run, in order
- EnricherA produces `IMPORTS`, EnricherB consumes `CALLS` → only EnricherA runs
- EnricherA → EnricherB → EnricherC (chain) → all run in correct order
- Circular dependency → throws error (toposort should catch this)
- Empty delta → no downstream enrichers run

**Estimated:** ~150 LOC (loop logic + toposort integration), ~8 tests

### Phase 4: RFD-15 Integration (DEFER — Do when RFD-15 lands)

**Goal:** Add `file_context` to CommitBatch for enrichment-level tombstoning.

**Blocker:** RFD-15 (Enrichment Virtual Shards) is still In Progress. It adds:
- `file_context` field to `CommitBatch` message
- Rust-side logic to tombstone old data for that shard before committing new data

**When RFD-15 lands:**
1. Update `RFDBClient.commitBatch()` to accept `file_context?: string`
2. Update `GraphBackend.commitBatch()` to accept `file_context?: string`
3. Update `runEnricherWithBatch()` to compute file_context:
   ```typescript
   const file_context = context.file
     ? `__enrichment__/${enricher.name}/${context.file.path}`
     : undefined;
   const delta = await this.graph.commitBatch(tags, file_context);
   ```

**Why defer:** RFD-15 is a Rust-side change. We can't test it until it's done. Design the API now (file_context parameter), implement when Rust side lands.

**Estimated (when ready):** ~30 LOC, ~2 tests

## What We're NOT Doing

### Blast Radius Query (C4)

**Linear subtask:** "Pre-commit blast radius query (C4): query dependents BEFORE commit"

**Reality:** This is about querying `rfdb-server` to find dependent files BEFORE committing a batch. Use case: incremental re-analysis.

**Problem:** This requires:
1. `findDependentFiles()` to work with uncommitted batch data (in-memory changes)
2. Orchestrator logic to decide "should I commit this batch or roll back?"

**Current state:** `findDependentFiles()` exists in RFDBClient, but unclear if it queries committed data or can query batch state.

**Decision:** DEFER to RFD-17 (Enricher Dependency Propagation). Blast radius is about dependency propagation, not batch protocol. Batch protocol is about wrapping work in atomic commits and getting deltas.

**Mitigation:** RFD-16 gets us delta-driven selective enrichment for FULL analysis. Blast radius is for INCREMENTAL re-analysis. Don't conflate them.

### Discovery/Indexing Batching

**Reason:** DISCOVERY and INDEXING are simpler than ENRICHMENT (no dependencies, no selective re-execution). Batch wrapping would only help with RPC count, not correctness.

**Decision:** Focus on ENRICHMENT (where deltas matter). If we have time, add batch wrapping to ANALYSIS. DISCOVERY/INDEXING can wait.

### Nested Batches

**Reason:** RFDB v2 might support nested batches (unclear from exploration). Even if it does, Orchestrator doesn't need them. Each enricher runs independently.

**Decision:** Assume flat batches. If nested batches are needed later, add them.

## File-Level Breakdown

### Files to Change

| File | Changes | LOC | Tests |
|------|---------|-----|-------|
| `packages/types/src/GraphBackend.ts` | Add batch methods to interface | ~10 | N/A (interface) |
| `packages/core/src/backends/RFDBServerBackend.ts` | Implement batch methods (delegation) | ~30 | 5 (batch lifecycle) |
| `packages/core/src/EnricherDependencyGraph.ts` | Add `findAffectedEnrichers()` | ~40 | 4 (delta matching) |
| `packages/core/src/Orchestrator.ts` | Add `runEnricherWithBatch()`, update phases | ~200 | 8 (selective enrichment) |
| `test/unit/backends/rfdb-batch.test.js` | Test batch lifecycle | ~60 | 5 |
| `test/unit/enricher-dependency.test.js` | Test delta → affected enrichers | ~50 | 4 |
| `test/unit/orchestrator-batch.test.js` | Test selective enrichment loop | ~100 | 8 |

**Total:** ~490 LOC, ~21 tests

### Risk: Orchestrator.ts Size

**Current:** 1327 lines.
**After RFD-16:** ~1527 lines (adding ~200 LOC).

**Mitigation:** Extract batch logic to `OrchestrationBatch.ts` if it grows beyond 200 LOC. But for now, keep it in Orchestrator (matches existing pattern of phase runners).

**Uncle Bob checkpoint:** If this pushes Orchestrator.ts over 1500 lines, we split. But 1500 is still under the 300-line file limit... wait, no. 1327 is already OVER the limit.

**STOP. Root Cause Check.**

Orchestrator.ts is 1327 lines. That's 4× the 300-line file limit. This is exactly the problem Uncle Bob is supposed to prevent.

**Question for user:** Should we split Orchestrator.ts FIRST (into `OrchestrationPhases.ts` or similar) before adding batch logic? Or is the 300-line limit too aggressive for Orchestrator specifically?

**Assumption for this plan:** Proceed with batch changes in Orchestrator.ts. Flag for Uncle Bob review. If split is needed, do it in STEP 2.5 (PREPARE).

## Test Strategy

### Unit Tests

**Phase 1 (Batch Infrastructure):**
- `rfdb-batch.test.js`: Batch lifecycle (begin/commit/abort, tags, deltas)

**Phase 2 (Batch Wrapping):**
- `orchestrator-batch.test.js`: Enricher wrapping, error handling, tag generation

**Phase 3 (Selective Enrichment):**
- `enricher-dependency.test.js`: Delta → affected enrichers mapping
- `orchestrator-batch.test.js`: Fixed-point enrichment loop

### Integration Tests

**Not in scope for RFD-16.** Integration tests would require:
- Real RFDB server instance
- Real enrichers with known consumes/produces
- Real deltas from real analysis

**Defer to:** RFD-19 (Enrichment Pipeline Validation) will add integration tests for full pipeline.

## Success Criteria

1. **Batch methods exposed:** GraphBackend has `beginBatch/commitBatch/abortBatch`, RFDBServerBackend implements them.
2. **Enrichers wrapped:** Each enricher runs inside a CommitBatch, produces a delta.
3. **Selective enrichment works:** If EnricherA produces `CALLS` and EnricherB consumes `CALLS`, EnricherB runs after EnricherA. If EnricherC consumes `IMPORTS`, it doesn't run when only `CALLS` changed.
4. **Tests pass:** 21 tests covering batch lifecycle, delta processing, selective enrichment loop.
5. **Performance improvement:** Full analysis uses ~90% fewer RPCs (one commitBatch per enricher instead of one RPC per edge).

## Risks & Mitigations

### Risk 1: Orchestrator.ts Size

**Problem:** Already 1327 lines, adding 200 more.

**Mitigation:** Uncle Bob review at STEP 2.5. If needed, extract to `OrchestrationPhases.ts` before implementation.

### Risk 2: RFD-15 Timing

**Problem:** Task description mentions `file_context`, but RFD-15 isn't done yet.

**Mitigation:** Phase 4 deferred. Design the API now (commitBatch accepts optional file_context), implement when RFD-15 lands. RFD-16 is useful without it (delta-driven selective enrichment still works).

### Risk 3: Toposort Complexity

**Problem:** Fixed-point loop + toposort = potential for infinite loops if dependency graph is wrong.

**Mitigation:**
- `buildDependencyGraph()` already handles cycles (throws error).
- Add max iteration limit (e.g., 100) to loop as sanity check.
- Tests cover circular dependencies.

### Risk 4: Delta Type Matching

**Problem:** `findAffectedEnrichers()` needs to match edge types like `http:request` correctly. What if an enricher consumes `http:*`?

**Mitigation:** For RFD-16, require exact type matching. Wildcard matching is a future enhancement (RFD-17?). Keep it simple.

### Risk 5: Empty Deltas

**Problem:** If an enricher runs but doesn't add/remove anything, delta is empty. Should downstream enrichers still run?

**Mitigation:** No. If delta is empty, no types changed, no downstream enrichers affected. This is CORRECT behavior (saves work).

## Dependencies

**Blocked by:** NONE. All prerequisites are Done.

**Blocks:**
- RFD-17 (Enricher Dependency Propagation) — needs delta-driven selective enrichment working
- RFD-18 (Guarantee Integration) — needs batch commits to tag guarantee violations
- RFD-19 (Enrichment Pipeline Validation) — needs full batch pipeline working

## Estimation

**Complexity:** Medium-High
- Batch infrastructure: trivial (delegation)
- Orchestrator changes: medium (new loop logic, error handling)
- Selective enrichment: high (fixed-point computation, toposort, type matching)

**Timeline:**
- Phase 1 (Batch Infrastructure): ~2 hours (simple delegation)
- Phase 2 (Batch Wrapping): ~4 hours (error handling, tag generation, tests)
- Phase 3 (Selective Enrichment): ~8 hours (loop logic, delta matching, tests)

**Total:** ~14 hours, ~500 LOC, ~21 tests

## Questions for Auto-Review

1. **Orchestrator.ts size:** 1327 lines → ~1527 lines after this task. Is this acceptable or should we split FIRST?
2. **Blast radius (C4):** I'm deferring this to RFD-17. Correct call?
3. **RFD-15 timing:** Designing for file_context but not implementing until RFD-15 lands. Sound approach?
4. **Type matching:** Exact match only (no wildcards). Too limiting or appropriately simple?

## Verdict

This plan:
- ✅ Delivers delta-driven selective enrichment (core goal)
- ✅ Reuses existing infrastructure (RFDBClient batch API, enricher consumes/produces)
- ✅ Phases work logically (infrastructure → wrapping → selective logic)
- ✅ Accounts for RFD-15 not being ready (deferred Phase 4)
- ✅ Identifies key risk (Orchestrator.ts size) and flags for review
- ⚠️ Defers blast radius to RFD-17 (needs confirmation)

**Recommendation:** Proceed with Phases 1-3. Uncle Bob MUST review Orchestrator.ts size before implementation. Phase 4 waits for RFD-15.
