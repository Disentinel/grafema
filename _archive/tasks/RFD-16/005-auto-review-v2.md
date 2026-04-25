# Auto-Review: RFD-16 Plan v2

**Date:** 2026-02-15
**Reviewer:** Combined Auto-Review (Sonnet)

## Verdict: REJECT

The revised plan fixes most issues from v1, but introduces **5 critical architectural problems** that must be resolved before implementation.

---

## Part 1 — Vision & Architecture

### ❌ CRITICAL ISSUE 1: Plugin Method Names Are Wrong

**Problem:** Plan references `analyze()` and `enrich()` methods (lines 208-212):

```typescript
if (phase === 'ANALYSIS' && 'analyze' in plugin) {
  await (plugin as { analyze: (ctx: PluginContext) => Promise<void> }).analyze(context);
} else if (phase === 'ENRICHMENT' && 'enrich' in plugin) {
  await (plugin as { enrich: (ctx: PluginContext) => Promise<void> }).enrich(context);
}
```

**Reality:** `Plugin` base class (packages/core/src/plugins/Plugin.ts:53) has only **`execute()`** method:

```typescript
abstract execute(context: PluginContext): Promise<PluginResult>;
```

**Impact:** Code won't compile. All plugins use `execute()`, not phase-specific methods.

**Fix Required:**
```typescript
const result = await plugin.execute(pluginContext);
```

**Architecture Gap:** The distinction between "analyzer" and "enricher" methods doesn't exist in the current plugin system. Plugins are generic and phase-agnostic.

---

### ❌ CRITICAL ISSUE 2: `context.file` Does Not Exist

**Problem:** Plan references `context.file` for tag generation (line 202):

```typescript
const tags = [plugin.metadata.name, phase];
if (context.file) tags.push(context.file.path);
```

**Reality:** `PluginContext` interface (packages/types/src/plugins.ts:86-137) has **NO `file` property**.

Available properties:
- `manifest`, `graph`, `config`, `phase`, `projectPath`
- `onProgress`, `forceAnalysis`, `workerCount`
- `touchedFiles`, `logger`, `reportIssue`, `strictMode`, `rootPrefix`, `resources`

**Impact:** Code won't compile.

**Evidence:** ANALYSIS phase invocation (Orchestrator.ts:534-538):
```typescript
await this.runPhase('ANALYSIS', {
  manifest: unitManifest,  // Contains file info
  graph: this.graph,
  workerCount: 1,
});
```

File path is in `manifest`, not `context.file`.

**Fix Required:**
```typescript
const tags = [plugin.metadata.name, phase];
const manifest = context.manifest as { path?: string } | undefined;
if (manifest?.path) tags.push(manifest.path);
```

---

### ❌ CRITICAL ISSUE 3: Batch Methods Should Be Optional

**Problem:** Plan adds batch methods as **required** to GraphBackend interface (line 142-145):

```typescript
export interface GraphBackend {
  // ... existing methods
  beginBatch(): void;
  commitBatch(tags?: string[]): Promise<CommitDelta>;
  abortBatch(): void;
}
```

**Reality:** GraphBackend interface (plugins.ts:276-314) has **optional methods** for advanced features:

```typescript
getAllEdges?(): Promise<EdgeRecord[]>;
findByType?(type: string): Promise<string[]>;
deleteNode?(id: string): Promise<void>;
flush?(): Promise<void>;
```

Pattern: Features not supported by all backends are **optional**.

**Impact:** Breaks all non-RFDB backends (InMemoryBackend, future backends). They would need to implement batch methods or fail type checking.

**Fix Required:**
```typescript
beginBatch?(): void;
commitBatch?(tags?: string[]): Promise<CommitDelta>;
abortBatch?(): void;
```

**Additional check needed in runPluginWithBatch:**
```typescript
if (!context.graph.beginBatch) {
  // Fallback: run without batching
  const result = await plugin.execute(pluginContext);
  return { /* empty delta */ };
}
```

---

### ❌ CRITICAL ISSUE 4: CommitDelta Import Path Wrong

**Problem:** Plan says (line 154-156):

```typescript
import type { CommitDelta } from './rfdb';
```

**Reality:** `CommitDelta` is in `packages/types/src/rfdb.ts:263`, which is correct.

But plugins.ts imports are at the top (lines 1-9):
```typescript
import type { NodeType, NodeRecord } from './nodes.js';
import type { EdgeType, EdgeRecord } from './edges.js';
import type { FieldDeclaration } from './rfdb.js';  // <-- rfdb.js, not rfdb
import type { ResourceRegistry } from './resources.js';
import type { RoutingRule } from './routing.js';
```

**Impact:** Minor — import should be:
```typescript
import type { FieldDeclaration, CommitDelta } from './rfdb.js';
```

Note `.js` extension (TypeScript project convention in this codebase).

**Fix Required:** Add to existing rfdb import, not a new one.

---

### ⚠️ CONCERN 5: ENRICHMENT Phase Has No File Context

**Problem:** Plan assumes ENRICHMENT phase runs per-file and can tag with file path (line 202).

**Reality:** ENRICHMENT phase is **global** (Orchestrator.ts:724-730):

```typescript
this.profiler.start('ENRICHMENT');
await this.runPhase('ENRICHMENT', {
  manifest: unifiedManifest,  // All services, not per-file
  graph: this.graph,
  workerCount: this.workerCount
});
```

No file-level iteration in ENRICHMENT. It runs **once per analysis**, not per file.

**Impact on delta tagging:**
- ANALYSIS phase: can extract file from `manifest.path` (runs per unit)
- ENRICHMENT phase: no file context, tags are just `[plugin.name, 'ENRICHMENT']`

**This is not a blocker**, but plan should clarify: file tags only available in ANALYSIS.

**Fix Required:** Document in plan that enrichment batches have no file tags.

---

### ✅ Architecture Positives

1. **Single-pass O(E) approach**: Correct fix from v1's O(E²) loop
2. **Toposort reuse**: Good — enrichers already sorted, no new dependencies
3. **Refactor-first (STEP 2.5)**: Correct approach to avoid making 1327-line file worse
4. **CommitDelta accumulation**: Sound logic for skip optimization
5. **Phase 4 deferral**: Pragmatic — RFD-15 integration can wait

---

## Part 2 — Practical Quality

### ❌ Correctness Issues

1. **Plugin execution wrong**: Using non-existent `analyze()`/`enrich()` methods
2. **Context.file wrong**: Accessing non-existent property
3. **Required batch methods**: Breaks non-RFDB backends

### ✅ Correctness Positives

1. **Batch lifecycle**: beginBatch/commitBatch/abortBatch signatures match RFDBClient
2. **Error handling**: try/catch with abortBatch on error (line 216-219)
3. **Delta structure**: Correctly uses `changedNodeTypes` and `changedEdgeTypes` from CommitDelta
4. **Skip logic**: Level-0 (consumes: []) always run, Level-1+ check accumulated types

---

## Part 3 — Code Quality

### ⚠️ Test Coverage Gaps

Plan claims 18 tests (line 5), but breakdown shows:
- Phase 1: 5 tests (batch lifecycle)
- Phase 2: 5 tests (plugin wrapping)
- Phase 3: 8 tests (selective enrichment)
- STEP 2.5: "~5 tests" mentioned at line 127, not in total

**Actual total: 18 tests (Phase 1-3) + 5 tests (refactoring) = 23 tests.**

Minor discrepancy, but should be clarified.

### ✅ Quality Positives

1. **Clear file breakdown**: 6 files, LOC estimates
2. **Risk analysis**: 4 risks with mitigations
3. **Dependencies**: Correctly identifies no blockers, 3 blocked tasks
4. **Test strategy**: Unit tests per phase, integration deferred to RFD-19

---

## Required Changes Before Implementation

### 1. Fix Plugin Execution
```diff
-    if (phase === 'ANALYSIS' && 'analyze' in plugin) {
-      await (plugin as { analyze: (ctx: PluginContext) => Promise<void> }).analyze(context);
-    } else if (phase === 'ENRICHMENT' && 'enrich' in plugin) {
-      await (plugin as { enrich: (ctx: PluginContext) => Promise<void> }).enrich(pluginContext);
-    }
+    const result = await plugin.execute(pluginContext);
```

### 2. Fix Tag Generation
```diff
-  const tags = [plugin.metadata.name, phase];
-  if (context.file) tags.push(context.file.path);
+  const tags = [plugin.metadata.name, phase];
+  const manifest = context.manifest as { path?: string } | undefined;
+  if (manifest?.path) tags.push(manifest.path);
```

### 3. Make Batch Methods Optional
```diff
 export interface GraphBackend {
   // ... existing methods
-  beginBatch(): void;
-  commitBatch(tags?: string[]): Promise<CommitDelta>;
-  abortBatch(): void;
+  beginBatch?(): void;
+  commitBatch?(tags?: string[]): Promise<CommitDelta>;
+  abortBatch?(): void;
 }
```

Add fallback in runPluginWithBatch:
```typescript
if (!context.graph.beginBatch || !context.graph.commitBatch || !context.graph.abortBatch) {
  // Backend doesn't support batching — run without delta
  const result = await plugin.execute(pluginContext);
  return {
    changedFiles: [],
    nodesAdded: 0,
    nodesRemoved: 0,
    edgesAdded: 0,
    edgesRemoved: 0,
    changedNodeTypes: [],
    changedEdgeTypes: [],
  };
}
```

### 4. Fix Import Statement
```diff
-import type { CommitDelta } from './rfdb';
+import type { FieldDeclaration, CommitDelta } from './rfdb.js';
```

(Merge with existing rfdb import at line 7)

### 5. Clarify File Tag Limitations

Add to plan under "Phase 2: Batch Wrapping":
> **Note:** File tags only available in ANALYSIS phase. ENRICHMENT phase runs globally (no per-file context), so tags are `[plugin.name, 'ENRICHMENT']` without file path.

---

## Summary

**Why REJECT:**
- 3 critical compilation errors (methods, properties, types)
- 1 architectural gap (optional batch methods)
- 1 minor import issue

**Why not APPROVE:**
- Cannot implement as written — code won't compile
- Breaking change to GraphBackend interface would fail type checking in other backends
- Plugin contract violated (analyze/enrich don't exist)

**What needs to happen:**
1. Don revises plan with fixes above
2. Auto-review re-runs on v3
3. If v3 passes → present to user

**Estimated fix time:** 30 minutes (straightforward corrections, no architecture rethink needed)

---

## Positive Notes

The core architecture is **sound**:
- Single-pass with delta accumulation
- Toposort dependency ordering
- Refactor-first to avoid file bloat
- Phased approach (infrastructure → wrapping → selective logic)

The issues are **implementation details**, not fundamental design flaws. Fix the 5 issues above and this plan is ready.
