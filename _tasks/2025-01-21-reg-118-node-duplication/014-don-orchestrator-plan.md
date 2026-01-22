# Don Melton: RE-PLAN - Clear at Orchestrator Level

**Date:** 2025-01-22
**Task:** REG-118 Node Duplication Fix
**Status:** RE-PLANNING after discovering architectural issue

---

## What Went Wrong

Previous plan placed clear logic in `GraphBuilder.build()` (ANALYSIS phase). But the issue is deeper:

1. **JSModuleIndexer** (INDEXING phase) creates MODULE and SERVICE nodes
2. **JSASTAnalyzer** (ANALYSIS phase) creates FUNCTION, CLASS, etc. nodes
3. GraphBuilder clears nodes, but MODULE nodes were explicitly EXCLUDED from clearing
4. On re-analysis, JSModuleIndexer creates duplicate MODULE nodes (it doesn't know they exist)

**Root cause:** Clear was implemented at the wrong level of abstraction. Each phase creates its own nodes, so clearing at phase level doesn't prevent cross-phase duplication.

---

## Architectural Investigation

### File Processing Flow

```
Orchestrator.run(projectPath)
|
+-- DISCOVERY phase (runs once)
|   |-- SimpleProjectDiscovery
|   +-- returns: { services, entrypoints, projectPath }
|
+-- Build indexingUnits from discovery result
|   +-- unitsToProcess: [{id, name, path, type: 'service'|'entrypoint'}, ...]
|
+-- INDEXING phase (per unit, batched parallel)
|   |
|   +-- JSModuleIndexer.execute(unitContext)
|       |-- Creates SERVICE node (line 87 in ServiceDetector)
|       |-- DFS from entrypoint
|       +-- Creates MODULE nodes for each file (line 289-295 JSModuleIndexer)
|
+-- ANALYSIS phase (per unit, batched parallel)
|   |
|   +-- JSASTAnalyzer.execute(unitContext)
|       |-- For each MODULE node in graph:
|       +-- analyzeModule() -> GraphBuilder.build()
|           |-- [OLD] Clears non-MODULE nodes for file
|           +-- Creates FUNCTION, CLASS, SCOPE, etc.
|
+-- ENRICHMENT phase (global)
+-- VALIDATION phase (global)
```

### The Problem

When `forceAnalysis=true` triggers re-analysis:

1. **INDEXING phase** runs again
   - JSModuleIndexer calls `graph.addNode(moduleNode)` for each file
   - MODULE nodes are created WITH HASH-BASED IDs: `MODULE:${fileHash}`
   - **If file unchanged:** Same ID, but `addNode` might still insert (depending on backend behavior)
   - **If file changed:** Different ID, old node remains, new node added = DUPLICATE

2. **ANALYSIS phase** runs again
   - GraphBuilder clears non-MODULE nodes (previous implementation)
   - But MODULE nodes weren't cleared (by design - wrong design!)

### Key Insight from Tarjan

> "File-based partitioning: each file owns its nodes. Clear ALL nodes for file before re-processing."

This is correct, but **the clear must happen BEFORE the first phase that creates nodes for that file**.

---

## Solution: Clear at Orchestrator Level

### Hook Point

The Orchestrator controls phase execution. We need to clear **before INDEXING** for the file being processed.

```typescript
// In Orchestrator.run(), before INDEXING phase
for (let batchStart = 0; batchStart < unitsToProcess.length; batchStart += BATCH_SIZE) {
  const batch = unitsToProcess.slice(batchStart, batchStart + BATCH_SIZE);

  await Promise.all(batch.map(async (unit) => {
    // NEW: Clear ALL nodes for this unit's entrypoint file
    await this.clearNodesForUnit(unit, this.graph);

    // Then run INDEXING
    await this.runPhase('INDEXING', { manifest: unitManifest, graph: this.graph });
  }));
}
```

**Wait, that's not quite right either.** Let me trace the actual data flow more carefully.

### What JSModuleIndexer Actually Does

Looking at JSModuleIndexer.execute():

1. Gets `service` from context (unit)
2. DFS from `service.path` (entrypoint file)
3. For **each discovered file** (via imports/requires):
   - Creates MODULE node: `NodeFactory.createModule(currentFile, ...)`
   - Creates CONTAINS edge: `SERVICE -> MODULE`
   - Queues DEPENDS_ON edges for later

So **one indexing unit can create MODULE nodes for MANY files** (its entire dependency tree).

### The Real Challenge

If we clear by file at orchestrator level, we need to know ALL files that will be processed. But we don't know that until we run the DFS!

**Options:**

#### Option A: Two-Pass Approach
1. First pass: Run JSModuleIndexer with `dryRun=true` to collect file list
2. Clear all nodes for collected files
3. Second pass: Run JSModuleIndexer for real

**Problem:** Doubles indexing time, complex.

#### Option B: Clear Inside JSModuleIndexer
1. Before creating MODULE node, check if it exists
2. If exists AND forceAnalysis, clear all nodes for that file
3. Then create MODULE node

**Problem:** Still spreads clear logic across phases. ANALYSIS phase also needs to know what was cleared.

#### Option C: Clear Entire Graph Before Run (Simplest)

When `forceAnalysis=true`:
1. Clear the ENTIRE graph before any phase runs
2. Let all phases recreate everything from scratch

**Pros:**
- Simplest implementation
- Guaranteed correct
- No coordination needed between phases

**Cons:**
- Can't do incremental analysis
- Entire graph rebuilt even for single-file change

**Verdict:** This is actually fine for `forceAnalysis` use case. The flag means "ignore cache, rebuild everything."

#### Option D: Clear Per-File BEFORE First Touch (Recommended)

Add a `FileNodeManager` abstraction that:
1. Tracks which files have been "touched" in this analysis run
2. Before first touch of a file, clears all its nodes
3. Subsequent touches do nothing

```typescript
class FileNodeManager {
  private touchedFiles = new Set<string>();

  async touchFile(graph: GraphBackend, file: string): Promise<void> {
    if (this.touchedFiles.has(file)) return;

    // Clear all nodes for this file (including MODULE, SERVICE, etc.)
    await this.clearAllNodesForFile(graph, file);

    this.touchedFiles.add(file);
  }

  private async clearAllNodesForFile(graph: GraphBackend, file: string): Promise<void> {
    if (!graph.deleteNode) return;

    const nodesToDelete: string[] = [];
    for await (const node of graph.queryNodes({ file })) {
      nodesToDelete.push(node.id);
    }

    for (const id of nodesToDelete) {
      await graph.deleteNode(id);
    }
  }
}
```

**Usage in JSModuleIndexer:**
```typescript
// Before creating MODULE node
await context.fileNodeManager?.touchFile(graph, currentFile);
const moduleNode = NodeFactory.createModule(currentFile, ...);
await graph.addNode(moduleNode);
```

**Usage in JSASTAnalyzer:**
```typescript
// Before analyzing module
await context.fileNodeManager?.touchFile(graph, module.file);
// ... analyze and build graph
```

**Pros:**
- Correct clearing before first touch
- Works for incremental (only changed files are cleared)
- Single responsibility (FileNodeManager)

**Cons:**
- Requires passing context through all phases
- Adds complexity

---

## Recommended Approach: Option D with Simplification

### Simplification

Instead of a separate `FileNodeManager`, add the logic directly to Orchestrator and pass a `touchedFiles` Set through context.

### Implementation Plan

#### 1. Add `touchedFiles` to PluginContext

```typescript
// packages/types/src/plugins.ts
export interface PluginContext {
  // ... existing fields
  touchedFiles?: Set<string>;  // Files already cleared in this run
}
```

#### 2. Add `clearFileNodes` Utility to Orchestrator

```typescript
// packages/core/src/Orchestrator.ts

/**
 * Clear all nodes belonging to a file before re-processing.
 * Called once per file per analysis run.
 */
private async clearFileNodes(file: string): Promise<number> {
  if (!this.graph.deleteNode) return 0;

  const nodesToDelete: string[] = [];
  for await (const node of this.graph.queryNodes({ file })) {
    nodesToDelete.push(node.id);
  }

  for (const id of nodesToDelete) {
    await this.graph.deleteNode(id);
  }

  return nodesToDelete.length;
}

/**
 * Touch a file - clear if not already touched in this run.
 */
private async touchFile(file: string, touchedFiles: Set<string>): Promise<void> {
  if (touchedFiles.has(file)) return;

  const deleted = await this.clearFileNodes(file);
  if (deleted > 0) {
    console.log(`[Orchestrator] Cleared ${deleted} nodes for ${file}`);
  }

  touchedFiles.add(file);
}
```

#### 3. Pass `touchedFiles` Through Context

In `Orchestrator.run()`:
```typescript
// Create touchedFiles set for this run
const touchedFiles = this.forceAnalysis ? new Set<string>() : undefined;

// Pass in context to all phases
const pluginContext: PluginContext = {
  manifest: unitManifest,
  graph: this.graph,
  touchedFiles,
  forceAnalysis: this.forceAnalysis,
  // ...
};

await this.runPhase('INDEXING', pluginContext);
// ...
await this.runPhase('ANALYSIS', pluginContext);
```

#### 4. Use in JSModuleIndexer

```typescript
// JSModuleIndexer.execute()

// Before creating MODULE node for a file
const { touchedFiles, graph } = context;
if (touchedFiles) {
  // Clear existing nodes before creating new ones
  await clearFileNodesIfNeeded(graph, currentFile, touchedFiles);
}

const moduleNode = NodeFactory.createModule(currentFile, ...);
await graph.addNode(moduleNode);
```

#### 5. Use in GraphBuilder (Replace Current Clear Logic)

```typescript
// GraphBuilder.build()

async build(module: ModuleNode, graph: GraphBackend, projectPath: string, data: ASTCollections, context?: BuildContext): Promise<BuildResult> {
  // Clear if touchedFiles provided (via context) and file not yet touched
  if (context?.touchedFiles) {
    await clearFileNodesIfNeeded(graph, module.file, context.touchedFiles);
  }

  // Remove the old _clearFileNodes call
  // ... rest of build
}
```

**But wait** - GraphBuilder doesn't have access to PluginContext. It's called from JSASTAnalyzer.analyzeModule().

#### 6. Pass touchedFiles Through Call Chain

Option 6a: Add to GraphBuilder constructor or build() params
Option 6b: Let JSASTAnalyzer handle clearing before calling GraphBuilder

**Recommendation:** Option 6b - JSASTAnalyzer already has PluginContext

```typescript
// JSASTAnalyzer.analyzeModule()

async analyzeModule(module: ModuleNode, graph: GraphBackend, projectPath: string, touchedFiles?: Set<string>): Promise<{ nodes: number; edges: number }> {
  // Clear before analysis if forceAnalysis
  if (touchedFiles) {
    await clearFileNodesIfNeeded(graph, module.file, touchedFiles);
  }

  // ... rest of analysis
  // GraphBuilder.build() no longer clears
}
```

---

## Final Implementation Plan

### Phase 1: Create Shared Utility

**File:** `packages/core/src/core/FileNodeManager.ts`

```typescript
/**
 * Manages file node clearing for idempotent re-analysis.
 *
 * Problem: Multiple phases create nodes for the same file (INDEXING creates MODULE,
 * ANALYSIS creates FUNCTION/CLASS/etc). When re-analyzing, we need to clear
 * existing nodes BEFORE any phase creates new nodes for that file.
 *
 * Solution: Track "touched" files. First touch clears all nodes for that file.
 * Subsequent touches (from other phases) are no-ops.
 */

export async function clearFileNodesIfNeeded(
  graph: GraphBackend,
  file: string,
  touchedFiles: Set<string>
): Promise<number> {
  // Already touched in this run - nothing to clear
  if (touchedFiles.has(file)) {
    return 0;
  }

  // Mark as touched BEFORE clearing (even if deleteNode not supported)
  touchedFiles.add(file);

  // Skip if backend doesn't support deletion
  if (!graph.deleteNode) {
    return 0;
  }

  // Collect all nodes for this file
  const nodesToDelete: string[] = [];
  for await (const node of graph.queryNodes({ file })) {
    nodesToDelete.push(node.id);
  }

  // Delete all of them - NO EXCLUSIONS
  // MODULE nodes will be recreated by INDEXING phase
  // FUNCTION/CLASS/etc will be recreated by ANALYSIS phase
  for (const id of nodesToDelete) {
    try {
      await graph.deleteNode(id);
    } catch (err) {
      // Log but continue - node might already be deleted
      console.warn(`[FileNodeManager] Failed to delete ${id}:`, (err as Error).message);
    }
  }

  if (nodesToDelete.length > 0) {
    console.log(`[FileNodeManager] Cleared ${nodesToDelete.length} nodes for ${file.split('/').pop()}`);
  }

  return nodesToDelete.length;
}
```

### Phase 2: Modify PluginContext

**File:** `packages/types/src/plugins.ts`

Add:
```typescript
export interface PluginContext {
  // ... existing
  touchedFiles?: Set<string>;  // For clear-before-write tracking
}
```

### Phase 3: Modify Orchestrator

**File:** `packages/core/src/Orchestrator.ts`

1. Create `touchedFiles` when `forceAnalysis=true`
2. Pass it through context to all phases

```typescript
async run(projectPath: string): Promise<DiscoveryManifest> {
  // ...

  // Track touched files for idempotent re-analysis
  const touchedFiles = this.forceAnalysis ? new Set<string>() : undefined;

  // INDEXING phase - pass touchedFiles
  for (let batchStart = 0; ...) {
    await Promise.all(batch.map(async (unit) => {
      const unitManifest = { ... };

      await this.runPhase('INDEXING', {
        manifest: unitManifest,
        graph: this.graph,
        touchedFiles,
        forceAnalysis: this.forceAnalysis,
      });
    }));
  }

  // ANALYSIS phase - same touchedFiles set continues
  for (let batchStart = 0; ...) {
    await Promise.all(batch.map(async (unit) => {
      const unitManifest = { ... };

      await this.runPhase('ANALYSIS', {
        manifest: unitManifest,
        graph: this.graph,
        touchedFiles,
        forceAnalysis: this.forceAnalysis,
      });
    }));
  }

  // ...
}
```

### Phase 4: Modify JSModuleIndexer

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

Before creating each MODULE node:
```typescript
// In the DFS loop, before creating MODULE node
if (context.touchedFiles) {
  await clearFileNodesIfNeeded(graph, currentFile, context.touchedFiles);
}

const moduleNode = NodeFactory.createModule(currentFile, ...);
await graph.addNode(moduleNode);
```

### Phase 5: Modify JSASTAnalyzer

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Before calling analyzeModule:
```typescript
// In execute(), before analyzeModule
if (context.touchedFiles) {
  await clearFileNodesIfNeeded(graph, module.file, context.touchedFiles);
}

// analyzeModule doesn't need to clear anymore
```

### Phase 6: Remove Clear from GraphBuilder

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

Remove the `_clearFileNodes` method and its call in `build()`. The clearing is now handled at the plugin level.

### Phase 7: Handle SERVICE Nodes

**Important edge case:** SERVICE nodes are created by ServiceDetector (INDEXING phase) but they have `file = servicePath` (the directory path, not individual files).

SERVICE nodes need special handling:
- They are created ONCE per service/unit
- They should be cleared when the service is re-analyzed

**Option A:** Clear SERVICE node explicitly in Orchestrator before INDEXING batch
**Option B:** SERVICE nodes use path, not file attribute - might not match file queries

Let me check ServiceDetector again...

Looking at ServiceDetector (lines 86-98):
```typescript
await graph.addNode({
  id: service.id,          // e.g., "SERVICE:apps/api"
  type: 'SERVICE',
  name: service.name,
  file: service.path,      // e.g., "/abs/path/apps/api"
  metadata: { ... }
});
```

The SERVICE node has `file = /abs/path/apps/api` (directory path).

When we query `graph.queryNodes({ file: '/abs/path/apps/api/src/index.js' })`:
- This WON'T match the SERVICE node (different path)

So SERVICE nodes need explicit clearing:

```typescript
// In Orchestrator, before INDEXING batch
if (this.forceAnalysis && touchedFiles) {
  // Clear SERVICE node for this unit
  const serviceId = unit.id; // e.g., "SERVICE:apps/api"
  if (this.graph.deleteNode) {
    try {
      await this.graph.deleteNode(serviceId);
    } catch (e) {
      // Might not exist on fresh analysis
    }
  }
}
```

---

## Edge Cases

### 1. EXTERNAL_MODULE Nodes

Nodes like `EXTERNAL_MODULE:lodash` have no `file` property. They won't be matched by `queryNodes({ file })`.

**Action:** No change needed. They're singletons, never duplicated.

### 2. Singleton Nodes (net:stdio, net:request)

These also have no `file` property.

**Action:** No change needed. GraphBuilder's `_createdSingletons` Set already dedupes within a single analysis.

### 3. Concurrent Batch Processing

Multiple files in same batch might share dependencies. File A and B both import C.

**Risk:** Both might try to clear C's nodes simultaneously.

**Mitigation:** The `touchedFiles` Set is shared across the batch. First one to touch C clears it, second one sees it's already touched.

**But wait:** `Promise.all` runs in parallel. Race condition?

**Solution:** Use synchronous check + async clear:
```typescript
// In clearFileNodesIfNeeded
if (touchedFiles.has(file)) return 0;  // Sync check
touchedFiles.add(file);                  // Sync add
// Now safe to clear - other concurrent calls will see it's touched
```

### 4. Cross-File Edges

Edge from node in file A to node in file B.

When A is cleared:
- Node in A is deleted
- Edge A->B becomes orphaned (source deleted)

When A is recreated:
- New node in A created
- New edge A->B created (points to existing B node)

**Risk:** If B is also being re-analyzed simultaneously, B's target node might be deleted between edge creation and B's clear.

**Mitigation:** RFDB handles dangling edges gracefully. They're filtered on query.

### 5. RustAnalyzer

RustAnalyzer also creates nodes. Same pattern should apply:
```typescript
// In RustAnalyzer, before creating nodes
if (context.touchedFiles) {
  await clearFileNodesIfNeeded(graph, rustFile, context.touchedFiles);
}
```

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/types/src/plugins.ts` | Add `touchedFiles?: Set<string>` to PluginContext |
| `packages/core/src/core/FileNodeManager.ts` | NEW - clearFileNodesIfNeeded utility |
| `packages/core/src/Orchestrator.ts` | Create touchedFiles, clear SERVICE nodes, pass through context |
| `packages/core/src/plugins/indexing/JSModuleIndexer.ts` | Call clearFileNodesIfNeeded before creating MODULE |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Call clearFileNodesIfNeeded before analyzeModule |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | REMOVE _clearFileNodes and its call |
| `packages/core/src/plugins/analysis/RustAnalyzer.ts` | Call clearFileNodesIfNeeded before creating Rust nodes |

---

## Testing Strategy

### Unit Tests

1. **Re-analysis idempotency (MODULE nodes)**
   ```javascript
   // Analyze project
   await orchestrator.run(projectPath);
   const modules1 = await countModuleNodes(graph);

   // Re-analyze with forceAnalysis
   await orchestrator.run(projectPath, { forceAnalysis: true });
   const modules2 = await countModuleNodes(graph);

   assert.equal(modules1, modules2, 'MODULE count should be identical');
   ```

2. **Re-analysis idempotency (all nodes)**
   ```javascript
   await orchestrator.run(projectPath);
   const count1 = await graph.nodeCount();

   await orchestrator.run(projectPath, { forceAnalysis: true });
   const count2 = await graph.nodeCount();

   assert.equal(count1, count2, 'Total node count should be identical');
   ```

3. **Cross-file edges preserved**
   ```javascript
   // File A imports B
   await orchestrator.run(projectPath);
   const imports1 = await getImportEdges(graph, fileA, fileB);

   await orchestrator.run(projectPath, { forceAnalysis: true });
   const imports2 = await getImportEdges(graph, fileA, fileB);

   assert.equal(imports1.length, imports2.length, 'Import edges should be recreated');
   ```

4. **touchedFiles tracking**
   ```javascript
   const touchedFiles = new Set();

   await clearFileNodesIfNeeded(graph, fileA, touchedFiles);
   // First call should clear

   await clearFileNodesIfNeeded(graph, fileA, touchedFiles);
   // Second call should be no-op

   assert(touchedFiles.has(fileA));
   ```

---

## Success Criteria

1. `grafema analyze --force` twice = identical node count
2. `grafema analyze --force` twice = identical edge count
3. No MODULE node duplication
4. No SERVICE node duplication
5. All existing tests pass
6. Cross-file edges work correctly after re-analysis

---

## Open Questions for Joel

1. **touchedFiles thread safety** - Is the JavaScript Set safe for concurrent access in Promise.all context?
   - Don's belief: Yes, because all operations are sync (check + add happen before await)

2. **Should we clear at service/unit level instead of file level?**
   - Don's opinion: No, file-level is more granular and correct

3. **What about ServiceDetector creating SERVICE nodes?**
   - See Phase 7 above - needs explicit handling

---

## Summary

The previous plan failed because clear was at the wrong level (GraphBuilder, ANALYSIS phase only). The fix is to:

1. Track touched files across ALL phases
2. Clear on first touch (which happens in INDEXING, before ANALYSIS)
3. Remove the incomplete clear from GraphBuilder

This ensures that **all** nodes for a file (MODULE, FUNCTION, CLASS, etc.) are cleared before **any** phase recreates them.

**Ready for Joel's technical spec.**
