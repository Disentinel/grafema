# Joel Spolsky: Technical Specification - Clear on First Touch

**Date:** 2025-01-22
**Task:** REG-118 Node Duplication Fix
**Status:** Implementation-ready specification

---

## Overview

This spec implements Don's "Clear on First Touch" approach to fix node duplication on re-analysis. The core idea:

1. Track `touchedFiles: Set<string>` across all phases
2. First phase to touch a file clears ALL its nodes
3. Subsequent phases see it's touched and skip clearing

This ensures MODULE nodes (created by INDEXING) and FUNCTION/CLASS nodes (created by ANALYSIS) are both properly cleared before recreation.

---

## File-by-File Changes

### 1. `packages/types/src/plugins.ts` - Add touchedFiles to PluginContext

**Location:** Line 34-43 (PluginContext interface)

**Current code:**
```typescript
export interface PluginContext {
  manifest?: unknown;
  graph: GraphBackend;
  config?: OrchestratorConfig;
  phase?: PluginPhase;
  projectPath?: string;  // Available during DISCOVERY phase
  onProgress?: (info: Record<string, unknown>) => void;
  forceAnalysis?: boolean;
  workerCount?: number;
}
```

**Change to:**
```typescript
export interface PluginContext {
  manifest?: unknown;
  graph: GraphBackend;
  config?: OrchestratorConfig;
  phase?: PluginPhase;
  projectPath?: string;  // Available during DISCOVERY phase
  onProgress?: (info: Record<string, unknown>) => void;
  forceAnalysis?: boolean;
  workerCount?: number;
  /**
   * Set of file paths already processed ("touched") in this analysis run.
   * Used for idempotent re-analysis: first touch clears all nodes for that file,
   * subsequent touches are no-ops. Only populated when forceAnalysis=true.
   */
  touchedFiles?: Set<string>;
}
```

---

### 2. NEW FILE: `packages/core/src/core/FileNodeManager.ts` - Utility Function

**Create new file with the following content:**

```typescript
/**
 * FileNodeManager - utility for idempotent file node clearing
 *
 * Problem: Multiple phases create nodes for the same file:
 * - INDEXING creates MODULE nodes
 * - ANALYSIS creates FUNCTION, CLASS, SCOPE, etc. nodes
 *
 * When re-analyzing with forceAnalysis=true, we need to clear existing
 * nodes BEFORE any phase creates new nodes for that file.
 *
 * Solution: Track "touched" files. First touch clears all nodes for that file.
 * Subsequent touches (from other phases) are no-ops.
 */

import type { GraphBackend } from '@grafema/types';

/**
 * Clear all nodes for a file if it hasn't been touched yet in this analysis run.
 *
 * Thread-safety note: The touchedFiles Set is shared across concurrent Promise.all
 * calls, but this is safe because:
 * 1. The check (has) and add are synchronous operations
 * 2. We add to the set BEFORE the async clear operation
 * 3. Other concurrent calls will see the file as touched immediately
 *
 * @param graph - Graph backend with deleteNode support
 * @param file - Absolute file path to clear nodes for
 * @param touchedFiles - Set tracking files already touched in this run
 * @returns Number of nodes deleted (0 if file was already touched or backend doesn't support delete)
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

  // Mark as touched BEFORE clearing (sync operation, makes subsequent concurrent calls no-op)
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
      // Log but continue - node might already be deleted by concurrent operation
      console.warn(`[FileNodeManager] Failed to delete ${id}:`, (err as Error).message);
    }
  }

  if (nodesToDelete.length > 0) {
    const fileName = file.split('/').pop() || file;
    console.log(`[FileNodeManager] Cleared ${nodesToDelete.length} nodes for ${fileName}`);
  }

  return nodesToDelete.length;
}

/**
 * Clear a SERVICE node by ID.
 * SERVICE nodes have file=directory_path (not individual files), so they need
 * explicit clearing separate from file-based clearing.
 *
 * @param graph - Graph backend with deleteNode support
 * @param serviceId - SERVICE node ID (e.g., "SERVICE:apps/api")
 * @returns true if node was deleted, false otherwise
 */
export async function clearServiceNodeIfExists(
  graph: GraphBackend,
  serviceId: string
): Promise<boolean> {
  if (!graph.deleteNode) {
    return false;
  }

  try {
    await graph.deleteNode(serviceId);
    console.log(`[FileNodeManager] Cleared SERVICE node: ${serviceId}`);
    return true;
  } catch (err) {
    // Node might not exist on fresh analysis - that's OK
    return false;
  }
}
```

**Export from index:**
Add to `packages/core/src/index.ts`:
```typescript
export { clearFileNodesIfNeeded, clearServiceNodeIfExists } from './core/FileNodeManager.js';
```

---

### 3. `packages/core/src/Orchestrator.ts` - Pass touchedFiles Through Context

**Change 1:** Add import at top of file (around line 11):

```typescript
import { clearServiceNodeIfExists } from './core/FileNodeManager.js';
```

**Change 2:** In `run()` method, after line 202 (after `unitsToProcess` is determined), add:

```typescript
    // Track touched files for idempotent re-analysis (clear-before-write)
    // Only create when forceAnalysis is enabled
    const touchedFiles = this.forceAnalysis ? new Set<string>() : undefined;
```

**Change 3:** In INDEXING phase batch loop (around line 233), modify to clear SERVICE nodes and pass touchedFiles:

Current code (lines 233-246):
```typescript
      await Promise.all(batch.map(async (unit, idx) => {
        const unitStart = Date.now();
        const unitManifest: UnitManifest = {
          projectPath: manifest.projectPath,
          service: {
            ...unit,  // Pass all unit fields
            id: unit.id,
            name: unit.name,
            path: unit.path
          },
          modules: []
        };

        await this.runPhase('INDEXING', { manifest: unitManifest, graph: this.graph, workerCount: 1 });
```

Change to:
```typescript
      await Promise.all(batch.map(async (unit, idx) => {
        const unitStart = Date.now();

        // Clear SERVICE node before re-indexing (if forceAnalysis)
        if (this.forceAnalysis && touchedFiles) {
          await clearServiceNodeIfExists(this.graph, unit.id);
        }

        const unitManifest: UnitManifest = {
          projectPath: manifest.projectPath,
          service: {
            ...unit,  // Pass all unit fields
            id: unit.id,
            name: unit.name,
            path: unit.path
          },
          modules: []
        };

        await this.runPhase('INDEXING', {
          manifest: unitManifest,
          graph: this.graph,
          workerCount: 1,
          touchedFiles,  // Pass for file-level clearing
        });
```

**Change 4:** In ANALYSIS phase batch loop (around line 303-316), add touchedFiles:

Current code:
```typescript
        await this.runPhase('ANALYSIS', { manifest: unitManifest, graph: this.graph, workerCount: 1 });
```

Change to:
```typescript
        await this.runPhase('ANALYSIS', {
          manifest: unitManifest,
          graph: this.graph,
          workerCount: 1,
          touchedFiles,  // Same set - files touched in INDEXING won't be re-cleared
        });
```

**Change 5:** Update `runPhase` method signature (line 471) to include touchedFiles:

Current:
```typescript
  async runPhase(phaseName: string, context: Partial<PluginContext> & { graph: PluginContext['graph'] }): Promise<void> {
```

No change needed - `Partial<PluginContext>` already allows touchedFiles since we added it to PluginContext.

**Change 6:** In `runPhase`, ensure touchedFiles is passed to plugins (line 491-494):

Current:
```typescript
      const pluginContext: PluginContext = {
        ...context,
        onProgress: this.onProgress as unknown as PluginContext['onProgress'],
        forceAnalysis: this.forceAnalysis
      };
```

No change needed - the spread `...context` already includes touchedFiles if present.

---

### 4. `packages/core/src/plugins/indexing/JSModuleIndexer.ts` - Clear Before Creating MODULE

**Change 1:** Add import at top (after line 8):

```typescript
import { clearFileNodesIfNeeded } from '../../core/FileNodeManager.js';
```

**Change 2:** In `execute()` method, before creating MODULE node (around line 288-295).

Find this code block:
```typescript
        // Создаём MODULE ноду для текущего файла
        const fileHash = this.calculateFileHash(currentFile);
        const moduleId = `MODULE:${fileHash}`; // StableID-based for deduplication

        // Используем NodeFactory для создания MODULE ноды
        // ВСЕГДА создаём ноду в графе (граф может быть пустой после force)
        const isTest = this.isTestFile(currentFile);
        const moduleNode = NodeFactory.createModule(currentFile, projectPath, {
          contentHash: fileHash ?? undefined,
          isTest
        });

        console.log(`[JSModuleIndexer] Creating MODULE node: ${moduleNode.id}`);
        await graph.addNode(moduleNode);
```

Change to:
```typescript
        // Создаём MODULE ноду для текущего файла
        const fileHash = this.calculateFileHash(currentFile);
        const moduleId = `MODULE:${fileHash}`; // StableID-based for deduplication

        // Clear existing nodes for this file before creating new ones (if forceAnalysis)
        const touchedFiles = (context as { touchedFiles?: Set<string> }).touchedFiles;
        if (touchedFiles) {
          await clearFileNodesIfNeeded(graph, currentFile, touchedFiles);
        }

        // Используем NodeFactory для создания MODULE ноды
        // ВСЕГДА создаём ноду в графе (граф может быть пустой после force)
        const isTest = this.isTestFile(currentFile);
        const moduleNode = NodeFactory.createModule(currentFile, projectPath, {
          contentHash: fileHash ?? undefined,
          isTest
        });

        console.log(`[JSModuleIndexer] Creating MODULE node: ${moduleNode.id}`);
        await graph.addNode(moduleNode);
```

---

### 5. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Clear Before Analysis

**Change 1:** Add import at top (after line 50):

```typescript
import { clearFileNodesIfNeeded } from '../../core/FileNodeManager.js';
```

**Change 2:** Update `AnalyzeContext` interface (line 154-160) to include touchedFiles:

Current:
```typescript
interface AnalyzeContext extends PluginContext {
  manifest?: AnalysisManifest;
  forceAnalysis?: boolean;
  workerCount?: number;
  // Use base onProgress type for compatibility
  onProgress?: (info: Record<string, unknown>) => void;
}
```

Change to:
```typescript
interface AnalyzeContext extends PluginContext {
  manifest?: AnalysisManifest;
  forceAnalysis?: boolean;
  workerCount?: number;
  touchedFiles?: Set<string>;  // For clear-before-write tracking
  // Use base onProgress type for compatibility
  onProgress?: (info: Record<string, unknown>) => void;
}
```

**Change 3:** In `execute()` method, extract touchedFiles from context (around line 252-254):

Find:
```typescript
      const { manifest, graph, forceAnalysis = false } = context;
```

Change to:
```typescript
      const { manifest, graph, forceAnalysis = false, touchedFiles } = context;
```

**Change 4:** In the module processing loop (around line 290-304), add clearing before analysis:

Find:
```typescript
        if (await this.shouldAnalyzeModule(module, graph, forceAnalysis)) {
          modulesToAnalyze.push(module);
        } else {
          skippedCount++;
        }
```

Change to:
```typescript
        if (await this.shouldAnalyzeModule(module, graph, forceAnalysis)) {
          // Clear existing nodes for this file before analysis (if forceAnalysis)
          // Note: This might be a no-op if INDEXING already touched this file
          if (touchedFiles && module.file) {
            await clearFileNodesIfNeeded(graph, module.file, touchedFiles);
          }
          modulesToAnalyze.push(module);
        } else {
          skippedCount++;
        }
```

---

### 6. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - NO CHANGES NEEDED

The current GraphBuilder has no clearing logic. Don's previous attempt added `_clearFileNodes` but that code doesn't exist in the current file. The new approach handles clearing at the plugin level (JSModuleIndexer, JSASTAnalyzer), so GraphBuilder remains focused on node/edge creation.

**Verification:** No `_clearFileNodes` method exists (grep confirmed). GraphBuilder is already clean.

---

## Test Plan

### Existing Test File: `test/unit/ClearAndRebuild.test.js`

The existing tests should pass with the new implementation. Key tests that verify the fix:

1. **Idempotency test** (line 97-124): Analyzes twice, expects same node/edge count
2. **Node count stability** (line 127-152): Analyzes 4 times, expects stable count
3. **MODULE preservation** (line 154-182): MODULE node IDs should be stable
4. **EXTERNAL_MODULE preservation** (line 185-216): No duplication
5. **Singleton survival** (line 219-275): net:stdio, net:request stay unique
6. **Modified file updates** (line 311-346): Adding function works correctly
7. **Deleted code removal** (line 349-419): Removing code removes nodes

### Additional Test Verification

After implementation, verify with real project:
```bash
cd /path/to/test-project
grafema analyze --force
# Note node count
grafema analyze --force
# Node count should be identical
```

---

## Implementation Order

### Step 1: Types (no dependencies)
- Edit `packages/types/src/plugins.ts`
- Add `touchedFiles?: Set<string>` to PluginContext

### Step 2: Utility Function (depends on Step 1)
- Create `packages/core/src/core/FileNodeManager.ts`
- Add export to `packages/core/src/index.ts`

### Step 3: JSModuleIndexer (depends on Step 2)
- Add import for clearFileNodesIfNeeded
- Add clearing call before creating MODULE node

### Step 4: JSASTAnalyzer (depends on Step 2)
- Add import for clearFileNodesIfNeeded
- Add touchedFiles to AnalyzeContext
- Add clearing call before analyzing module

### Step 5: Orchestrator (depends on Step 2)
- Add import for clearServiceNodeIfExists
- Create touchedFiles Set when forceAnalysis=true
- Clear SERVICE nodes before INDEXING
- Pass touchedFiles through context to all phases

### Step 6: Tests
- Run existing ClearAndRebuild.test.js
- All tests should pass

---

## Definition of Done

- [ ] `packages/types/src/plugins.ts` - touchedFiles added to PluginContext
- [ ] `packages/core/src/core/FileNodeManager.ts` - New file created with clearFileNodesIfNeeded
- [ ] `packages/core/src/index.ts` - FileNodeManager exported
- [ ] `packages/core/src/plugins/indexing/JSModuleIndexer.ts` - Clears before MODULE creation
- [ ] `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Clears before analysis
- [ ] `packages/core/src/Orchestrator.ts` - Creates touchedFiles, clears SERVICE, passes context
- [ ] All existing tests pass: `node --test test/unit/ClearAndRebuild.test.js`
- [ ] Manual verification: `grafema analyze --force` twice produces identical counts
- [ ] No MODULE node duplication (verified by test "MODULE preservation")
- [ ] No SERVICE node duplication (verified by counting SERVICE nodes)
- [ ] TypeScript compiles without errors: `npm run build`

---

## Edge Cases Handled

1. **SERVICE nodes**: Cleared explicitly by Orchestrator before INDEXING (they have file=directory, not individual files)
2. **EXTERNAL_MODULE nodes**: Have no file property, won't be matched by queryNodes({file}), remain as singletons
3. **Singleton nodes (net:stdio, net:request)**: Have no file property, protected by GraphBuilder's _createdSingletons Set
4. **Concurrent batch processing**: touchedFiles.add() is sync, happens before async clear, preventing race conditions
5. **Backend without deleteNode**: clearFileNodesIfNeeded returns 0 gracefully

---

## Notes for Kent and Rob

1. **Kent**: Write tests FIRST. The existing ClearAndRebuild.test.js tests should pass after implementation. If any fail, that indicates a bug in implementation, not in tests.

2. **Rob**: Follow the implementation order strictly. The utility function must exist before Orchestrator/plugins can import it.

3. **Both**: The key insight is that clearing happens at the FIRST TOUCH of a file, not at a specific phase. JSModuleIndexer touches files first during INDEXING, so most clearing happens there. JSASTAnalyzer's clear calls are usually no-ops (file already touched).
