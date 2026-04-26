# Uncle Bob Review: RFD-17 Pre-Implementation

**Date:** 2026-02-15
**Reviewer:** Robert Martin (Uncle Bob)
**Task:** RFD-17 Enricher Dependency Propagation

---

## File 1: packages/core/src/PhaseRunner.ts

**File size:** 279 lines — **OK** (will grow to ~370, still under 500 threshold)
**Methods to modify:** `runPhase()` (lines 95-277, 183 lines)

### File-level

**Status:** OK — Under 500 line hard limit even after adding propagation method (~370 projected).

**Single Responsibility:** PhaseRunner has ONE job — execute plugin phases with proper ordering, batching, and error handling. Adding propagation logic fits this responsibility (it's part of "execute phases correctly").

**Concerns:**
- File will grow from 279 → ~370 lines. Still safe, but getting substantial.
- Future growth should be carefully monitored. At 450 lines, consider extraction.

### Method-level: runPhase()

**Current state:** 183 lines (lines 95-277)
**Recommendation:** **REFACTOR** — Extract context-building logic before adding propagation

**Issues:**

1. **Context building (lines 146-174)** — 29 lines of pluginContext assembly
   - Mixed concerns: merging config, setting up reportIssue, handling rootPrefix
   - Makes method harder to scan
   - Will get harder to read when propagation logic added

2. **Selective enrichment block (lines 129-138)** — 10 lines of skip logic
   - Clear candidate for extraction (already well-isolated)
   - Would improve readability of main loop

**Proposed refactoring:**

```typescript
// Extract context building to private method
private buildPluginContext(
  baseContext: Partial<PluginContext> & { graph: PluginContext['graph'] },
  phaseName: string,
  plugin: Plugin
): PluginContext {
  const { onProgress, forceAnalysis, logger, strictMode, resourceRegistry, configServices, routing } = this.deps;

  const pluginContext: PluginContext = {
    ...baseContext,
    onProgress: onProgress as unknown as PluginContext['onProgress'],
    forceAnalysis,
    logger,
    strictMode,
    rootPrefix: (baseContext as { rootPrefix?: string }).rootPrefix,
    resources: resourceRegistry,
  };

  // Merge config with routing and services
  if (!pluginContext.config) {
    pluginContext.config = {
      projectPath: (baseContext as { manifest?: { projectPath?: string } }).manifest?.projectPath ?? '',
      services: configServices,
      routing,
    };
  } else {
    const cfg = pluginContext.config as unknown as Record<string, unknown>;
    if (routing && !cfg.routing) cfg.routing = routing;
    if (configServices && !cfg.services) cfg.services = configServices;
  }

  // Add reportIssue for VALIDATION phase
  if (phaseName === 'VALIDATION') {
    pluginContext.reportIssue = async (issue: IssueSpec): Promise<string> => {
      const node = NodeFactory.createIssue(
        issue.category,
        issue.severity as IssueSeverity,
        issue.message,
        plugin.metadata.name,
        issue.file,
        issue.line,
        issue.column || 0,
        { context: issue.context }
      );
      await baseContext.graph.addNode(node);
      if (issue.targetNodeId) {
        await baseContext.graph.addEdge({
          src: node.id,
          dst: issue.targetNodeId,
          type: 'AFFECTS',
        });
      }
      return node.id;
    };
  }

  return pluginContext;
}

// Extract selective enrichment check to private method
private shouldSkipEnricher(
  plugin: Plugin,
  phaseName: string,
  accumulatedTypes: Set<string>,
  supportsBatch: boolean
): boolean {
  if (phaseName !== 'ENRICHMENT' || !supportsBatch) return false;

  const consumes = plugin.metadata.consumes ?? [];
  const isLevel0 = consumes.length === 0;

  return !isLevel0 && !consumes.some(t => accumulatedTypes.has(t));
}
```

**Impact after extraction:**
- `runPhase()` drops from 183 lines → ~140 lines (under 50-line ideal)
- Main loop becomes scannable:
  ```typescript
  for (const plugin of phasePlugins) {
    if (this.shouldSkipEnricher(plugin, phaseName, accumulatedTypes, supportsBatch)) {
      logger.debug(`[SKIP] ${plugin.metadata.name} — no changes`);
      continue;
    }

    const pluginContext = this.buildPluginContext(context, phaseName, plugin);
    const { result, delta } = await this.runPluginWithBatch(plugin, pluginContext, phaseName);

    // Handle delta, diagnostics, errors...
  }
  ```
- Adding propagation logic becomes much cleaner

**Other observations:**

3. **Parameter count:** `runPhase(phaseName, context)` — only 2 params, GOOD
4. **Nesting depth:** Max 3 levels (for-try-if) — acceptable but at limit
5. **Error handling (lines 253-268)** — clean, well-structured

**Risk assessment:** **LOW**
- Context building is pure data transformation, no complex logic
- Skip check is already isolated with clear boolean logic
- Tests exist that lock current behavior (RFD-16 added tests)
- Extraction won't change behavior, just structure

**Estimated scope:** ~60 lines moved (context building + skip check), net reduction in `runPhase()` of ~40 lines

---

## File 2: packages/core/src/core/buildDependencyGraph.ts

**File size:** 75 lines — **OK**
**Methods to modify:** `buildDependencyGraph()` (lines 27-74, 48 lines)

### File-level

**Status:** OK — Small, focused file with single responsibility.

**Concerns:** None. Will grow by ~15 lines (add producer propagation), still well under 100.

### Method-level: buildDependencyGraph()

**Current state:** 48 lines
**Recommendation:** **SKIP** — Method is clean and well-structured

**Observations:**

1. **Clarity:** Two-step algorithm clearly separated (build index, compute deps)
2. **Naming:** Excellent — `producers`, `edgeProducers`, `deps` all self-documenting
3. **Nesting:** Max 2 levels — well within limits
4. **Comments:** Helpful inline comments explain Layer 1/Layer 2
5. **Complexity:** O(E + P) documented, straightforward implementation

**Why no refactoring needed:**

- Method does ONE thing: build dependency graph from plugin metadata
- Adding propagation logic (lines 60.5) fits naturally between Layer 1 and Layer 2
- Current structure makes the insertion point obvious
- No readability issues

**Projected state after RFD-17:**
- Lines 27-74 → lines 27-89 (~63 lines total)
- Still under 50-line target, still very readable

---

## Summary

### Files to Refactor

| File | Action | Why |
|------|--------|-----|
| `PhaseRunner.ts` | Extract 2 methods | Reduce `runPhase()` from 183→140 lines, improve clarity |
| `buildDependencyGraph.ts` | No changes | Already clean |

### Refactoring Scope

**Before adding RFD-17 code:**

1. Extract `buildPluginContext()` — move lines 146-174 context assembly
2. Extract `shouldSkipEnricher()` — move lines 129-138 skip logic

**Benefits:**
- `runPhase()` becomes scannable (~140 lines, clear structure)
- Adding propagation method won't push file into danger zone
- Test coverage already exists (RFD-16 locked behavior)
- Zero behavior change — pure structural improvement

**Estimated effort:** 30-45 minutes (extract, verify tests pass)

### Risk Assessment

**Overall risk:** **LOW**

- Refactoring target (context building) is pure data transformation
- Tests already cover `runPhase()` behavior
- No architectural changes, just method extraction
- `buildDependencyGraph.ts` needs no changes

### Approval

**Status:** PROCEED with refactoring

**Sequence:**
1. Kent writes tests locking `runPhase()` behavior (if gaps exist)
2. Rob extracts `buildPluginContext()` and `shouldSkipEnricher()`
3. Verify tests pass (no behavior change)
4. Then add RFD-17 propagation code

**Hard limits still respected:**
- PhaseRunner.ts: 279 → ~320 after refactor → ~370 after RFD-17 (under 500 ✓)
- buildDependencyGraph.ts: 75 → ~90 after RFD-17 (under 100 ✓)

---

**Signed:** Robert Martin (Uncle Bob)
**Model:** Sonnet
**Timestamp:** 2026-02-15
