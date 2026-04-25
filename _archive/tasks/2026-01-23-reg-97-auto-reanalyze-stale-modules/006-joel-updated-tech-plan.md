# Joel Spolsky's Updated Technical Specification for REG-97

## Executive Summary

Don's revised plan correctly identifies that automatic reanalysis is required, not just detection. This specification provides exact implementations for:

1. **HashUtils** - Unified hash computation (DRY refactoring)
2. **GraphFreshnessChecker** - Detect stale modules by comparing contentHash
3. **IncrementalReanalyzer** - THE NEW KEY COMPONENT for selective re-analysis

---

## Key Codebase Findings

### Hash Computation Locations (6 copies found)

1. **`packages/core/src/plugins/indexing/JSModuleIndexer.ts`** (line 105-112)
2. **`packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts`** (line 110-117)
3. **`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`** (uses createHash)
4. **`packages/core/src/core/nodes/ModuleNode.ts`** (line 102-104, MD5 for path)
5. **`packages/core/src/core/VersionManager.ts`** (line 15)
6. **`packages/core/src/plugins/vcs/GitPlugin.ts`** (line 15)

### FileNodeManager Pattern (lines 31-73)

The `clearFileNodesIfNeeded` function:
- Takes `graph`, `file`, and `touchedFiles` Set
- Marks file as touched BEFORE clearing (thread-safety)
- Queries nodes by `{ file }` filter
- Deletes all nodes for that file
- Returns count of deleted nodes

### JSASTAnalyzer.analyzeModule Pattern

- Takes `ModuleNode`, `GraphBackend`, `projectPath`
- Creates collections for all AST data
- Uses ScopeTracker for semantic IDs
- Runs multiple visitors (ImportExport, Variable, Function, Class)
- Builds graph via GraphBuilder
- Returns `{ nodes: number, edges: number }`

### Enrichment Plugins

1. **ImportExportLinker** - Phase: ENRICHMENT, Priority: 90, creates IMPORTS and IMPORTS_FROM edges
2. **InstanceOfResolver** - Phase: ENRICHMENT, Priority: 100, resolves INSTANCE_OF edges

---

## Detailed Implementation Specification

### Phase 1: HashUtils (DRY)

**File: `packages/core/src/core/HashUtils.ts`**

```typescript
/**
 * HashUtils - unified hash computation for Grafema
 *
 * WHY THIS EXISTS:
 * - 6 copies of the same hash computation existed across the codebase
 * - Single source of truth ensures consistent hashing everywhere
 * - Makes future algorithm changes (e.g., SHA-256 -> BLAKE3) trivial
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';

const HASH_ALGORITHM = 'sha256';

export function calculateFileHash(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return createHash(HASH_ALGORITHM).update(content).digest('hex');
  } catch {
    return null;
  }
}

export async function calculateFileHashAsync(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return createHash(HASH_ALGORITHM).update(content).digest('hex');
  } catch {
    return null;
  }
}

export function calculateContentHash(content: string): string {
  return createHash(HASH_ALGORITHM).update(content).digest('hex');
}
```

### Phase 2: GraphFreshnessChecker

**File: `packages/core/src/core/GraphFreshnessChecker.ts`**

```typescript
/**
 * GraphFreshnessChecker - checks if graph data matches current files
 */

import { access, constants } from 'fs/promises';
import { calculateFileHashAsync } from './HashUtils.js';
import type { NodeRecord } from '@grafema/types';

export interface StaleModule {
  id: string;
  file: string;
  storedHash: string;
  currentHash: string | null;
  reason: 'changed' | 'deleted' | 'unreadable';
}

export interface FreshnessResult {
  isFresh: boolean;
  staleModules: StaleModule[];
  freshCount: number;
  staleCount: number;
  deletedCount: number;
  checkDurationMs: number;
}

export interface FreshnessGraph {
  queryNodes(query: { type: string }): AsyncGenerator<NodeRecord, void, unknown>;
}

interface ModuleInfo {
  id: string;
  file: string;
  contentHash: string;
}

const BATCH_SIZE = 50;

export class GraphFreshnessChecker {
  async checkFreshness(graph: FreshnessGraph): Promise<FreshnessResult> {
    const startTime = Date.now();

    const modules: ModuleInfo[] = [];
    for await (const node of graph.queryNodes({ type: 'MODULE' })) {
      if (node.file && typeof node.contentHash === 'string') {
        modules.push({
          id: node.id,
          file: node.file,
          contentHash: node.contentHash
        });
      }
    }

    if (modules.length === 0) {
      return {
        isFresh: true,
        staleModules: [],
        freshCount: 0,
        staleCount: 0,
        deletedCount: 0,
        checkDurationMs: Date.now() - startTime
      };
    }

    const staleModules: StaleModule[] = [];
    let freshCount = 0;
    let deletedCount = 0;

    for (let i = 0; i < modules.length; i += BATCH_SIZE) {
      const batch = modules.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(module => this._checkModuleFreshness(module))
      );

      for (const result of results) {
        if (result === null) {
          freshCount++;
        } else {
          staleModules.push(result);
          if (result.reason === 'deleted') {
            deletedCount++;
          }
        }
      }
    }

    return {
      isFresh: staleModules.length === 0,
      staleModules,
      freshCount,
      staleCount: staleModules.length,
      deletedCount,
      checkDurationMs: Date.now() - startTime
    };
  }

  private async _checkModuleFreshness(module: ModuleInfo): Promise<StaleModule | null> {
    const exists = await this._fileExists(module.file);
    if (!exists) {
      return {
        id: module.id,
        file: module.file,
        storedHash: module.contentHash,
        currentHash: null,
        reason: 'deleted'
      };
    }

    const currentHash = await calculateFileHashAsync(module.file);
    if (currentHash === null) {
      return {
        id: module.id,
        file: module.file,
        storedHash: module.contentHash,
        currentHash: null,
        reason: 'unreadable'
      };
    }

    if (currentHash !== module.contentHash) {
      return {
        id: module.id,
        file: module.file,
        storedHash: module.contentHash,
        currentHash,
        reason: 'changed'
      };
    }

    return null;
  }

  private async _fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}
```

### Phase 3: IncrementalReanalyzer (THE KEY COMPONENT)

**File: `packages/core/src/core/IncrementalReanalyzer.ts`**

```typescript
/**
 * IncrementalReanalyzer - selective re-analysis of stale modules
 *
 * HOW IT WORKS:
 * 1. Clear all nodes for stale files (using clearFileNodesIfNeeded)
 * 2. Re-create MODULE nodes with updated contentHash
 * 3. Run JSASTAnalyzer.analyzeModule() for each stale module
 * 4. Re-run enrichment plugins to rebuild cross-file edges
 */

import { relative } from 'path';
import { clearFileNodesIfNeeded } from './FileNodeManager.js';
import { JSASTAnalyzer } from '../plugins/analysis/JSASTAnalyzer.js';
import { InstanceOfResolver } from '../plugins/enrichment/InstanceOfResolver.js';
import { ImportExportLinker } from '../plugins/enrichment/ImportExportLinker.js';
import type { GraphBackend, PluginContext } from '@grafema/types';
import type { StaleModule } from './GraphFreshnessChecker.js';

export interface ReanalysisOptions {
  skipEnrichment?: boolean;
  onProgress?: (info: ReanalysisProgress) => void;
}

export interface ReanalysisProgress {
  phase: 'clearing' | 'indexing' | 'analysis' | 'enrichment';
  current: number;
  total: number;
  currentFile?: string;
}

export interface ReanalysisResult {
  modulesReanalyzed: number;
  modulesDeleted: number;
  nodesCreated: number;
  edgesCreated: number;
  nodesCleared: number;
  durationMs: number;
}

interface ModuleForAnalysis {
  id: string;
  file: string;
  name: string;
  contentHash: string;
  line: number;
  type: 'MODULE';
}

export class IncrementalReanalyzer {
  private graph: GraphBackend;
  private projectPath: string;

  constructor(graph: GraphBackend, projectPath: string) {
    this.graph = graph;
    this.projectPath = projectPath;
  }

  async reanalyze(
    staleModules: StaleModule[],
    options: ReanalysisOptions = {}
  ): Promise<ReanalysisResult> {
    const startTime = Date.now();
    const touchedFiles = new Set<string>();

    let nodesCreated = 0;
    let edgesCreated = 0;
    let nodesCleared = 0;

    const deletedModules = staleModules.filter(m => m.currentHash === null);
    const modifiedModules = staleModules.filter(m => m.currentHash !== null);

    // STEP 1: Clear nodes for ALL stale files FIRST
    for (let i = 0; i < staleModules.length; i++) {
      const module = staleModules[i];
      if (options.onProgress) {
        options.onProgress({
          phase: 'clearing',
          current: i + 1,
          total: staleModules.length,
          currentFile: module.file
        });
      }
      const cleared = await clearFileNodesIfNeeded(this.graph, module.file, touchedFiles);
      nodesCleared += cleared;
    }

    // STEP 2: Re-create MODULE nodes with updated hash
    const modulesToAnalyze: ModuleForAnalysis[] = [];

    for (let i = 0; i < modifiedModules.length; i++) {
      const module = modifiedModules[i];
      const relativePath = relative(this.projectPath, module.file);

      if (options.onProgress) {
        options.onProgress({
          phase: 'indexing',
          current: i + 1,
          total: modifiedModules.length,
          currentFile: module.file
        });
      }

      const moduleNode: ModuleForAnalysis = {
        id: module.id,
        type: 'MODULE',
        name: relativePath,
        file: module.file,
        contentHash: module.currentHash!,
        line: 0
      };

      await this.graph.addNode(moduleNode);
      nodesCreated++;
      modulesToAnalyze.push(moduleNode);
    }

    // STEP 3: Run JSASTAnalyzer for each module
    const analyzer = new JSASTAnalyzer();

    for (let i = 0; i < modulesToAnalyze.length; i++) {
      const module = modulesToAnalyze[i];

      if (options.onProgress) {
        options.onProgress({
          phase: 'analysis',
          current: i + 1,
          total: modulesToAnalyze.length,
          currentFile: module.file
        });
      }

      try {
        const result = await analyzer.analyzeModule(
          module as Parameters<typeof analyzer.analyzeModule>[0],
          this.graph,
          this.projectPath
        );
        nodesCreated += result.nodes;
        edgesCreated += result.edges;
      } catch (err) {
        console.error(`[IncrementalReanalyzer] Failed to analyze ${module.file}:`, (err as Error).message);
      }
    }

    // STEP 4: Re-run enrichment plugins
    if (!options.skipEnrichment && modulesToAnalyze.length > 0) {
      if (options.onProgress) {
        options.onProgress({ phase: 'enrichment', current: 0, total: 2 });
      }

      const pluginContext: PluginContext = {
        graph: this.graph,
        manifest: { projectPath: this.projectPath },
        config: {}
      };

      const instanceOfResolver = new InstanceOfResolver();
      try {
        const result1 = await instanceOfResolver.execute(pluginContext);
        edgesCreated += result1.created.edges;
      } catch (err) {
        console.error(`[IncrementalReanalyzer] InstanceOfResolver error:`, (err as Error).message);
      }

      if (options.onProgress) {
        options.onProgress({ phase: 'enrichment', current: 1, total: 2 });
      }

      const importExportLinker = new ImportExportLinker();
      try {
        const result2 = await importExportLinker.execute(pluginContext);
        edgesCreated += result2.created.edges;
      } catch (err) {
        console.error(`[IncrementalReanalyzer] ImportExportLinker error:`, (err as Error).message);
      }

      if (options.onProgress) {
        options.onProgress({ phase: 'enrichment', current: 2, total: 2 });
      }
    }

    return {
      modulesReanalyzed: modulesToAnalyze.length,
      modulesDeleted: deletedModules.length,
      nodesCreated,
      edgesCreated,
      nodesCleared,
      durationMs: Date.now() - startTime
    };
  }
}
```

### Phase 4: Export from Core Index

**File: `packages/core/src/index.ts`**

```typescript
// Hash utilities
export { calculateFileHash, calculateFileHashAsync, calculateContentHash } from './core/HashUtils.js';

// Freshness checking and incremental reanalysis
export { GraphFreshnessChecker } from './core/GraphFreshnessChecker.js';
export type { FreshnessGraph, FreshnessResult, StaleModule } from './core/GraphFreshnessChecker.js';
export { IncrementalReanalyzer } from './core/IncrementalReanalyzer.js';
export type { ReanalysisOptions, ReanalysisProgress, ReanalysisResult } from './core/IncrementalReanalyzer.js';
```

### Phase 5: CLI Integration

**File: `packages/cli/src/commands/check.ts`**

Add imports:
```typescript
import { GraphFreshnessChecker, IncrementalReanalyzer } from '@grafema/core';
```

Add options:
```typescript
.option('--skip-reanalysis', 'Skip automatic reanalysis of stale modules')
.option('--fail-on-stale', 'Exit with error if stale modules found (CI mode)')
```

Add freshness check after backend.connect():
```typescript
const freshnessChecker = new GraphFreshnessChecker();
const freshness = await freshnessChecker.checkFreshness(backend);

if (!freshness.isFresh) {
  if (options.failOnStale) {
    console.error(`Error: Graph is stale (${freshness.staleCount} module(s) changed)`);
    process.exit(1);
  }

  if (!options.skipReanalysis) {
    console.log(`Reanalyzing ${freshness.staleCount} stale module(s)...`);
    const reanalyzer = new IncrementalReanalyzer(backend, projectPath);
    const result = await reanalyzer.reanalyze(freshness.staleModules);
    console.log(`Reanalyzed ${result.modulesReanalyzed} modules in ${result.durationMs}ms`);
  } else {
    console.warn(`Warning: ${freshness.staleCount} stale module(s) detected.`);
  }
}
```

### Phase 6: Refactor Existing Hash Usages

1. **JSModuleIndexer.ts** - Replace `calculateFileHash` method with import from HashUtils
2. **IncrementalModuleIndexer.ts** - Replace `calculateFileHash` method with import from HashUtils
3. **GitPlugin.ts** - Use `calculateContentHash` from HashUtils

---

## Implementation Order

1. Create `HashUtils.ts`
2. Create `HashUtils.test.js` - Run tests
3. Refactor hash usages in existing files
4. Create `GraphFreshnessChecker.ts`
5. Create `IncrementalReanalyzer.ts`
6. Update `index.ts` exports
7. Create `IncrementalReanalyzer.test.js` - Run tests
8. Update `check.ts` CLI
9. Full test run

## Test Commands

```bash
node --test test/unit/HashUtils.test.js
node --test test/unit/GraphFreshnessChecker.test.js
node --test test/unit/IncrementalReanalyzer.test.js

# Manual integration test
grafema analyze test/fixtures/eval-ban
echo "// change" >> test/fixtures/eval-ban/index.js
grafema check --guarantee=node-creation  # Should auto-reanalyze
```

## Files Summary

| File | Action |
|------|--------|
| `packages/core/src/core/HashUtils.ts` | CREATE |
| `packages/core/src/core/GraphFreshnessChecker.ts` | CREATE |
| `packages/core/src/core/IncrementalReanalyzer.ts` | CREATE |
| `packages/core/src/index.ts` | MODIFY |
| `packages/cli/src/commands/check.ts` | MODIFY |
| `packages/core/src/plugins/indexing/JSModuleIndexer.ts` | MODIFY (use HashUtils) |
| `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts` | MODIFY (use HashUtils) |
| `test/unit/HashUtils.test.js` | CREATE |
| `test/unit/GraphFreshnessChecker.test.js` | CREATE |
| `test/unit/IncrementalReanalyzer.test.js` | CREATE |
