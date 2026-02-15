# Don's Plan v2: RFD-16 Orchestrator Batch Protocol

**Date:** 2026-02-15
**Scope:** ~450 LOC, ~18 tests
**Complexity:** Medium (touches orchestration core, needs Orchestrator refactoring first)

## What Changed from v1

**Auto-Review identified 7 critical issues. All fixed:**

1. **File path corrected:** GraphBackend interface is in `packages/types/src/plugins.ts:276-314`, NOT `GraphBackend.ts`
2. **Removed fixed-point loop:** Replaced with single-pass + skip logic. Toposort already handles ordering.
3. **No new file needed:** Removed `findAffectedEnrichers()` entirely. Skip check is inline.
4. **Fixed sync/async:** `beginBatch()` and `abortBatch()` are `void` (sync), only `commitBatch()` is async
5. **Fixed type names:** Using `IPlugin` (from @grafema/types) and `Plugin` (from core)
6. **Added STEP 2.5:** Extract enrichment phase logic to `EnrichmentPipeline.ts` BEFORE adding batch code
7. **Renamed method:** `runPluginWithBatch()` not `runEnricherWithBatch()`

## The Core Issue

**Current state:** Every `graph.addEdge()` in an enricher sends an immediate RPC. 1000 edges = 1000 RPCs. Slow, wasteful, no atomicity.

**Target state:** Each enricher wraps its work in a CommitBatch. Get deltas back. Use deltas to skip enrichers whose consumed types didn't change.

**The insight:** RFDB v2 already HAS the batch API. RFDBClient already HAS `beginBatch/commitBatch/abortBatch`. We just need to expose them through GraphBackend and wire them into Orchestrator.

## Architecture

### Three-Layer Batch Exposure

```
Enricher
   ↓ calls
GraphBackend (packages/types/src/plugins.ts:276-314) ← ADD batch methods here
   ↓ implemented by
RFDBServerBackend ← expose RFDBClient batch methods
   ↓ delegates to
RFDBClient (packages/rfdb/ts/client.ts:1013-1060) ← already has beginBatch/commitBatch/abortBatch
   ↓ wire protocol
rfdb-server (Rust) ← already implements CommitBatch
```

**Gap:** GraphBackend interface doesn't have batch methods. RFDBServerBackend doesn't expose them.

**Fix:** Add batch methods to GraphBackend, implement in RFDBServerBackend by delegating to RFDBClient.

### Single-Pass Architecture (NOT Loop)

**Key correction from v1:** The enrichment phase runs in **toposorted order** (Orchestrator.ts:1005-1006). Toposort GUARANTEES dependencies run before consumers. No loop needed.

**What we add:** Skip logic based on accumulated delta from previous enrichers.

**Algorithm:**
```typescript
// Enrichers already in toposort order
const accumulatedTypes = new Set<string>();

for (const plugin of sortedPlugins) {
  // Level-0 enrichers (consumes: []) always run — they consume analysis nodes
  // Level-1+ enrichers: run only if consumed types appear in accumulated delta
  const isLevel0 = !plugin.metadata.consumes || plugin.metadata.consumes.length === 0;
  const shouldRun = isLevel0 ||
    plugin.metadata.consumes!.some(t => accumulatedTypes.has(t));

  if (!shouldRun) {
    logger.debug(`[SKIP] ${plugin.metadata.name}`);
    continue;
  }

  const delta = await this.runPluginWithBatch(plugin, context, 'ENRICHMENT');

  // Accumulate types for next enricher
  delta.changedNodeTypes.forEach(t => accumulatedTypes.add(t));
  delta.changedEdgeTypes.forEach(t => accumulatedTypes.add(t));
}
```

**Complexity:** O(E) — single pass, NOT O(E²) loop.

**Why this works:**
- Level-0 enrichers (like CallEnricher) have `consumes: []` — they consume analysis nodes (FUNCTION, etc.), always run
- Their deltas populate `accumulatedTypes`
- Level-1+ enrichers check: "Do any of my consumed types appear in accumulatedTypes?"
- If yes → run. If no → skip (optimization).

## Phased Approach

### STEP 2.5 — PREPARE (Refactor-First)

**CRITICAL:** Orchestrator.ts is 1327 lines (4× over 300-line limit). We MUST NOT make it worse.

**Before implementation:**

1. Extract phase execution logic to new file: `packages/core/src/EnrichmentPipeline.ts`
2. Move from Orchestrator.ts:
   - `runPhase()` method (lines 997-1075)
   - Phase-specific context preparation
   - Plugin iteration logic
3. Orchestrator becomes coordinator, delegates to EnrichmentPipeline
4. Tests lock CURRENT behavior before refactoring
5. Tests MUST pass after refactoring — output before = output after

**New structure:**
```typescript
// packages/core/src/EnrichmentPipeline.ts
export class EnrichmentPipeline {
  constructor(
    private plugins: Plugin[],
    private logger: Logger,
    private onProgress: ProgressCallback
  ) {}

  async runPhase(
    phaseName: string,
    context: Partial<PluginContext> & { graph: PluginContext['graph'] }
  ): Promise<void> {
    // Current runPhase logic moves here
  }
}

// packages/core/src/Orchestrator.ts
this.pipeline = new EnrichmentPipeline(this.plugins, this.logger, this.onProgress);
await this.pipeline.runPhase('ENRICHMENT', context);
```

**Estimated:** ~150 LOC extracted, ~5 tests to lock behavior

**Uncle Bob checkpoint:** If refactoring unsafe or takes >20% task time → skip, create tech debt issue.

### Phase 1: Batch Infrastructure

**Goal:** Get batch methods exposed and working.

#### 1.1 GraphBackend Interface (`packages/types/src/plugins.ts`)

Add to interface (line 314, before closing brace):
```typescript
export interface GraphBackend {
  // ... existing methods (lines 277-313)

  // Batch operations
  beginBatch(): void;
  commitBatch(tags?: string[]): Promise<CommitDelta>;
  abortBatch(): void;
}
```

**Why sync/async?**
- `beginBatch()`: sync — just sets local state (RFDBClient:1013)
- `commitBatch()`: async — sends RPC to server (RFDBClient:1026)
- `abortBatch()`: sync — just clears local state (RFDBClient:1047)

**Import:** Add to top of file:
```typescript
import type { CommitDelta } from './rfdb';
```

#### 1.2 RFDBServerBackend (`packages/core/src/storage/backends/RFDBServerBackend.ts`)

Implement batch methods by delegating to RFDBClient:

```typescript
beginBatch(): void {
  this.client.beginBatch();
}

async commitBatch(tags?: string[]): Promise<CommitDelta> {
  return await this.client.commitBatch(tags);
}

abortBatch(): void {
  this.client.abortBatch();
}
```

**Why:** Simple pass-through. RFDBClient already has the logic.

**Tests:**
- `test/unit/backends/rfdb-batch.test.js`:
  - beginBatch → addEdge × N → commitBatch returns delta with N edges
  - beginBatch → abortBatch → edges not persisted
  - commitBatch with tags → tags appear in delta
  - double beginBatch throws error
  - commitBatch without beginBatch throws error

**Estimated:** ~30 LOC (trivial delegation), ~5 tests

### Phase 2: Batch Wrapping

**Goal:** Wrap plugin execution in CommitBatch calls. Get deltas. Don't use them yet.

#### 2.1 Plugin Execution Wrapper (`packages/core/src/EnrichmentPipeline.ts`)

New method:
```typescript
private async runPluginWithBatch(
  plugin: Plugin,
  context: PluginContext,
  phase: string
): Promise<CommitDelta> {
  const tags = [plugin.metadata.name, phase];
  if (context.file) tags.push(context.file.path);

  try {
    context.graph.beginBatch();

    // Run plugin
    if (phase === 'ANALYSIS' && 'analyze' in plugin) {
      await (plugin as { analyze: (ctx: PluginContext) => Promise<void> }).analyze(context);
    } else if (phase === 'ENRICHMENT' && 'enrich' in plugin) {
      await (plugin as { enrich: (ctx: PluginContext) => Promise<void> }).enrich(context);
    }

    const delta = await context.graph.commitBatch(tags);
    return delta;
  } catch (error) {
    context.graph.abortBatch();
    throw error;
  }
}
```

**Why:** Single point for batch wrapping. Error handling. Tag generation.

#### 2.2 Update `runPhase()` for ANALYSIS

Start with ANALYSIS phase (simpler, no selective execution):

```typescript
async runPhase(phaseName: string, context: ...): Promise<void> {
  const phasePlugins = this.plugins.filter(plugin =>
    plugin.metadata.phase === phaseName
  );

  // ... toposort logic (unchanged)

  for (let i = 0; i < phasePlugins.length; i++) {
    const plugin = phasePlugins[i];
    this.onProgress({
      phase: phaseName.toLowerCase(),
      currentPlugin: plugin.metadata.name,
      message: `Running plugin ${i + 1}/${phasePlugins.length}: ${plugin.metadata.name}`
    });

    const pluginContext: PluginContext = { /* ... existing context building */ };

    if (phaseName === 'ANALYSIS') {
      const delta = await this.runPluginWithBatch(plugin, pluginContext, 'ANALYSIS');
      this.logger.debug(
        `[${plugin.metadata.name}] +${delta.nodesAdded} nodes, +${delta.edgesAdded} edges`
      );
    } else {
      // OLD path for other phases (until Phase 3)
      if ('analyze' in plugin) {
        await (plugin as { analyze: (ctx: PluginContext) => Promise<void> }).analyze(pluginContext);
      } else if ('enrich' in plugin) {
        await (plugin as { enrich: (ctx: PluginContext) => Promise<void> }).enrich(pluginContext);
      }
    }
  }
}
```

**Why:** Analysis phase batching is simpler (no dependencies). Good warm-up for enrichment logic.

**Tests:**
- `test/unit/orchestrator-batch.test.js`:
  - Analyzer adds nodes → commitBatch returns delta with those nodes
  - Analyzer throws → batch aborted, nodes not persisted
  - Tags correctly include analyzer name + phase + file path
  - Delta includes `changedNodeTypes` for added node types

**Estimated:** ~100 LOC (wrapper + phase updates), ~5 tests

### Phase 3: Delta-Driven Selective Enrichment

**Goal:** Use CommitDelta to skip enrichers whose consumed types didn't change.

#### 3.1 Update `runPhase()` for ENRICHMENT

Replace sequential enrichment with delta-driven single pass:

```typescript
async runPhase(phaseName: string, context: ...): Promise<void> {
  // ... filter plugins, toposort (unchanged)

  if (phaseName === 'ENRICHMENT') {
    const accumulatedTypes = new Set<string>();

    for (let i = 0; i < phasePlugins.length; i++) {
      const plugin = phasePlugins[i];

      // Level-0 enrichers (consumes: []) always run
      // Level-1+ enrichers: run only if consumed types changed
      const consumes = plugin.metadata.consumes ?? [];
      const isLevel0 = consumes.length === 0;
      const shouldRun = isLevel0 ||
        consumes.some(t => accumulatedTypes.has(t));

      if (!shouldRun) {
        this.logger.debug(
          `[SKIP] ${plugin.metadata.name} — no changes in consumed types [${consumes.join(', ')}]`
        );
        continue;
      }

      this.onProgress({
        phase: phaseName.toLowerCase(),
        currentPlugin: plugin.metadata.name,
        message: `Running plugin ${i + 1}/${phasePlugins.length}: ${plugin.metadata.name}`
      });

      const pluginContext: PluginContext = { /* ... existing context building */ };
      const delta = await this.runPluginWithBatch(plugin, pluginContext, 'ENRICHMENT');

      // Accumulate changed types for next enrichers
      delta.changedNodeTypes.forEach(t => accumulatedTypes.add(t));
      delta.changedEdgeTypes.forEach(t => accumulatedTypes.add(t));

      this.logger.debug(
        `[${plugin.metadata.name}] +${delta.edgesAdded} edges, ` +
        `types: [${[...new Set([...delta.changedNodeTypes, ...delta.changedEdgeTypes])].join(', ')}]`
      );
    }
  } else {
    // ANALYSIS or other phases
    // ... (Phase 2 logic)
  }
}
```

**Why:**
- Single pass in toposorted order (current behavior, keep it)
- Before each enricher, check if consumed types appear in accumulated delta
- If YES → run, accumulate its delta
- If NO → skip (optimization)

**Key insight:** On FIRST full analysis, `accumulatedTypes` starts empty. Level-0 enrichers (consumes: []) always run. Their deltas feed Level-1+ enrichers. This matches the task spec:
- Level-0 enrichers: always run on changed files
- Level-1+ enrichers: use `changedEdgeTypes ∩ consumes`

**Tests:**
- `test/unit/orchestrator-batch.test.js`:
  - EnricherA produces `CALLS`, EnricherB consumes `CALLS` → both run, in order
  - EnricherA produces `IMPORTS`, EnricherB consumes `CALLS` → only EnricherA runs
  - EnricherA → EnricherB → EnricherC (chain) → all run in correct order
  - Level-0 enricher (consumes: []) always runs even with empty delta
  - Skipped enricher logged with consumed types
  - Delta accumulation: EnricherA adds type X, EnricherB consumes X → EnricherB sees X in delta

**Estimated:** ~120 LOC (single-pass logic with skip), ~8 tests

### Phase 4: RFD-15 Integration (DEFER)

**Blocker:** RFD-15 (Enrichment Virtual Shards) is In Progress. It adds `file_context` to `CommitBatch` for enrichment-level tombstoning.

**When RFD-15 lands:**
1. Update `RFDBClient.commitBatch()` to accept `file_context?: string`
2. Update `GraphBackend.commitBatch()` to accept `file_context?: string`
3. Update `runPluginWithBatch()` to compute file_context:
   ```typescript
   const file_context = context.file
     ? `__enrichment__/${plugin.metadata.name}/${context.file.path}`
     : undefined;
   const delta = await context.graph.commitBatch(tags, file_context);
   ```

**Estimated (when ready):** ~20 LOC, ~2 tests

## File-Level Breakdown

### Files to Change

| File | Changes | LOC | Tests |
|------|---------|-----|-------|
| `packages/types/src/plugins.ts` | Add batch methods to GraphBackend interface | ~10 | N/A (interface) |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | Implement batch methods (delegation) | ~30 | 5 (batch lifecycle) |
| `packages/core/src/EnrichmentPipeline.ts` | **NEW FILE** — extract runPhase + add batch logic | ~280 | 8 (selective enrichment) |
| `packages/core/src/Orchestrator.ts` | Delegate to EnrichmentPipeline | ~-80 (removed), +20 (delegation) = -60 net | N/A (refactor) |
| `test/unit/backends/rfdb-batch.test.js` | Test batch lifecycle | ~60 | 5 |
| `test/unit/orchestrator-batch.test.js` | Test selective enrichment | ~100 | 8 |

**Total:** ~450 LOC, ~18 tests

**Net impact on Orchestrator.ts:** -60 LOC (1327 → 1267). Moving in the right direction.

## Test Strategy

### Unit Tests

**STEP 2.5 (Refactoring):**
- `test/unit/orchestrator-refactor.test.js`: Lock current behavior before extracting EnrichmentPipeline

**Phase 1 (Batch Infrastructure):**
- `test/unit/backends/rfdb-batch.test.js`: Batch lifecycle (begin/commit/abort, tags, deltas)

**Phase 2 (Batch Wrapping):**
- `test/unit/orchestrator-batch.test.js`: Plugin wrapping, error handling, tag generation

**Phase 3 (Selective Enrichment):**
- `test/unit/orchestrator-batch.test.js`: Single-pass with skip logic, delta accumulation

### Integration Tests

**Not in scope for RFD-16.** Defer to RFD-19 (Enrichment Pipeline Validation).

## Success Criteria

1. **Batch methods exposed:** GraphBackend has `beginBatch/commitBatch/abortBatch`, RFDBServerBackend implements them
2. **Plugins wrapped:** Each plugin runs inside a CommitBatch, produces a delta
3. **Selective enrichment works:** If EnricherA produces `CALLS` and EnricherB consumes `CALLS`, EnricherB runs. If EnricherC consumes `IMPORTS`, it skips when only `CALLS` changed
4. **Tests pass:** 18 tests covering batch lifecycle, delta processing, selective enrichment
5. **Orchestrator.ts smaller:** -60 LOC (1327 → 1267), logic extracted to EnrichmentPipeline
6. **Performance improvement:** Full analysis uses ~90% fewer RPCs (one commitBatch per plugin instead of one RPC per edge)

## Risks & Mitigations

### Risk 1: Refactoring Safety

**Problem:** Extracting 280 LOC from 1327-line file — high risk of breaking existing behavior.

**Mitigation:**
- Write tests FIRST that lock current behavior
- Run full test suite before and after extraction
- If tests fail after extraction → revert, create tech debt issue
- Uncle Bob review before starting

### Risk 2: RFD-15 Timing

**Problem:** Task description mentions `file_context`, but RFD-15 isn't done yet.

**Mitigation:** Phase 4 deferred. Design the API now (commitBatch accepts optional file_context), implement when RFD-15 lands. RFD-16 is useful without it.

### Risk 3: Empty Deltas

**Problem:** If an enricher runs but doesn't add/remove anything, delta is empty. Should downstream enrichers still run?

**Mitigation:** No. If delta is empty, no types changed, no downstream enrichers affected. This is CORRECT behavior (saves work).

### Risk 4: Type Matching Precision

**Problem:** `findAffectedEnrichers()` needs to match edge types like `http:request` correctly. What if an enricher consumes `http:*`?

**Mitigation:** For RFD-16, require exact type matching. Wildcard matching is a future enhancement. Keep it simple.

## Dependencies

**Blocked by:** NONE. All prerequisites are Done.

**Blocks:**
- RFD-17 (Enricher Dependency Propagation) — needs delta-driven selective enrichment working
- RFD-18 (Guarantee Integration) — needs batch commits to tag guarantee violations
- RFD-19 (Enrichment Pipeline Validation) — needs full batch pipeline working

## Estimation

**Complexity:** Medium
- STEP 2.5 (Refactoring): medium-high (extract 280 LOC safely)
- Phase 1 (Batch Infrastructure): trivial (delegation)
- Phase 2 (Batch Wrapping): medium (error handling, tag generation)
- Phase 3 (Selective Enrichment): medium (skip logic, delta accumulation)

**Timeline:**
- STEP 2.5 (Refactoring): ~4 hours (tests + extraction + verification)
- Phase 1 (Batch Infrastructure): ~2 hours (simple delegation)
- Phase 2 (Batch Wrapping): ~3 hours (error handling, tests)
- Phase 3 (Selective Enrichment): ~5 hours (skip logic, delta accumulation, tests)

**Total:** ~14 hours, ~450 LOC, ~18 tests

## What We're NOT Doing

### Blast Radius Query (C4)

**Linear subtask:** "Pre-commit blast radius query (C4): query dependents BEFORE commit"

**Decision:** DEFER to RFD-17 (Enricher Dependency Propagation). Blast radius is about dependency propagation, not batch protocol. Batch protocol is about wrapping work in atomic commits and getting deltas.

### Discovery/Indexing Batching

**Decision:** Focus on ENRICHMENT (where deltas matter for selective execution). ANALYSIS gets batch wrapping as warm-up. DISCOVERY/INDEXING can wait.

### Nested Batches

**Decision:** Assume flat batches. RFDB v2 might support nested batches, but Orchestrator doesn't need them. Each plugin runs independently.

## Verdict

This plan:
- ✅ Delivers delta-driven selective enrichment (core goal)
- ✅ Reuses existing infrastructure (RFDBClient batch API, enricher consumes/produces)
- ✅ Phases work logically (refactor → infrastructure → wrapping → selective logic)
- ✅ **FIXES Orchestrator.ts size** instead of making it worse (-60 LOC)
- ✅ Uses correct sync/async signatures (beginBatch/abortBatch are void)
- ✅ Uses correct file paths (plugins.ts, not GraphBackend.ts)
- ✅ Uses correct types (IPlugin/Plugin, not Enricher)
- ✅ Uses correct architecture (single-pass O(E), not loop O(E²))
- ✅ Accounts for RFD-15 not being ready (deferred Phase 4)

**Recommendation:** Proceed with STEP 2.5 → Phase 1 → Phase 2 → Phase 3. Uncle Bob MUST review refactoring plan before extraction. Phase 4 waits for RFD-15.
