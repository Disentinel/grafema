# Don Melton's Revised Plan for REG-97: Full Auto-Reanalysis

## What Linus Got Right

Linus correctly identified that my original plan punted on the hard part. The acceptance criteria is explicit:

> "Изменённые файлы переанализируются перед проверкой"

This means **automatic reanalysis**, not just detection. The `--skip-reanalysis` flag implies there IS default reanalysis to skip.

## Architecture Discovery

After exploring the codebase, I found all the building blocks already exist:

1. **`JSASTAnalyzer.analyzeModule(module, graph, projectPath)`** - Can analyze a single module independently
2. **`clearFileNodesIfNeeded(graph, file, touchedFiles)`** - Clears all nodes for a file before re-analysis (FileNodeManager.ts)
3. **`graph.deleteNode(id)`** - Available in RFDBServerBackend
4. **`graph.queryNodes({ file })`** - Can find all nodes for a specific file
5. **6 copies of hash calculation** - All doing `createHash('sha256').update(content).digest('hex')` - this MUST be unified

## The Challenge: Cross-File Edges

The critical complexity is that ENRICHMENT phase creates **cross-file edges**:
- `ImportExportLinker` creates IMPORTS_FROM edges between files
- `InstanceOfResolver` links instances to classes across files
- `MethodCallResolver` resolves method calls across modules

When we re-analyze just a few files, these edges might become stale or point to deleted nodes.

## Solution Architecture

### Phase 1: Hash Utility (DRY)

Create `packages/core/src/core/HashUtils.ts`:
```typescript
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export function calculateFileHash(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export function calculateContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
```

Then refactor all 6 usages to use this shared utility.

### Phase 2: GraphFreshnessChecker

```typescript
// packages/core/src/core/GraphFreshnessChecker.ts

interface StaleModule {
  id: string;           // MODULE node id (semantic ID)
  file: string;         // Absolute file path
  storedHash: string;   // Hash stored in graph
  currentHash: string | null; // Current file hash (null = deleted)
}

interface FreshnessResult {
  isFresh: boolean;
  staleModules: StaleModule[];
  freshCount: number;
  staleCount: number;
  deletedCount: number;
  checkDurationMs: number;
}

export class GraphFreshnessChecker {
  async checkFreshness(
    graph: GraphBackend,
    projectPath: string
  ): Promise<FreshnessResult>;
}
```

### Phase 3: IncrementalReanalyzer - THE KEY COMPONENT

This is what was missing. The reanalyzer must:

1. **Clear stale nodes** - Use `clearFileNodesIfNeeded` for each stale file
2. **Re-index stale modules** - Update MODULE nodes with new hash
3. **Re-analyze stale modules** - Run `JSASTAnalyzer.analyzeModule()` for each
4. **Selective enrichment** - Run ImportExportLinker and other enrichers

```typescript
// packages/core/src/core/IncrementalReanalyzer.ts

interface ReanalysisOptions {
  plugins?: Plugin[];          // Override default plugins
  skipEnrichment?: boolean;    // Skip enrichment phase (for testing)
  onProgress?: ProgressCallback;
}

interface ReanalysisResult {
  modulesReanalyzed: number;
  nodesCreated: number;
  edgesCreated: number;
  durationMs: number;
}

export class IncrementalReanalyzer {
  constructor(private graph: GraphBackend, private projectPath: string);

  async reanalyze(
    staleModules: StaleModule[],
    options?: ReanalysisOptions
  ): Promise<ReanalysisResult>;
}
```

**Implementation Strategy for `reanalyze()`:**

```typescript
async reanalyze(staleModules: StaleModule[], options = {}): Promise<ReanalysisResult> {
  const touchedFiles = new Set<string>();
  const analyzer = new JSASTAnalyzer();
  let nodesCreated = 0;
  let edgesCreated = 0;

  // Step 1: Clear nodes for all stale files FIRST (before any creation)
  for (const module of staleModules) {
    if (module.currentHash !== null) {  // File still exists
      await clearFileNodesIfNeeded(this.graph, module.file, touchedFiles);
    } else {
      // File deleted - clear all nodes including MODULE
      await clearFileNodesIfNeeded(this.graph, module.file, touchedFiles);
    }
  }

  // Step 2: Re-create MODULE nodes with updated hash (for non-deleted files)
  for (const module of staleModules) {
    if (module.currentHash !== null) {
      await this.graph.addNode({
        id: module.id,  // Same semantic ID
        type: 'MODULE',
        name: relative(this.projectPath, module.file),
        file: module.file,
        contentHash: module.currentHash,
        line: 0
      });
    }
  }

  // Step 3: Run JSASTAnalyzer for each non-deleted module
  const modulesToAnalyze = staleModules
    .filter(m => m.currentHash !== null)
    .map(m => ({
      id: m.id,
      file: m.file,
      name: relative(this.projectPath, m.file),
      contentHash: m.currentHash
    }));

  for (const module of modulesToAnalyze) {
    const result = await analyzer.analyzeModule(
      module as ModuleNode,
      this.graph,
      this.projectPath
    );
    nodesCreated += result.nodes;
    edgesCreated += result.edges;
  }

  // Step 4: Re-run enrichment plugins (they process globally)
  if (!options.skipEnrichment) {
    const enrichers = [
      new InstanceOfResolver(),
      new ImportExportLinker(),
    ];

    for (const enricher of enrichers) {
      const result = await enricher.execute({
        graph: this.graph,
        manifest: { projectPath: this.projectPath }
      });
      edgesCreated += result.created.edges;
    }
  }

  return { modulesReanalyzed: modulesToAnalyze.length, nodesCreated, edgesCreated, durationMs };
}
```

### Phase 4: CLI Integration

```typescript
// packages/cli/src/commands/check.ts

export const checkCommand = new Command('check')
  .option('--skip-reanalysis', 'Skip automatic reanalysis of stale modules')
  .option('--fail-on-stale', 'Fail immediately if stale modules detected (CI mode)')
  .action(async (rule, options) => {
    // ... setup ...

    // Check freshness BEFORE any validation
    const freshnessChecker = new GraphFreshnessChecker();
    const freshness = await freshnessChecker.checkFreshness(backend, resolvedPath);

    if (!freshness.isFresh) {
      if (options.failOnStale) {
        console.error(`Found ${freshness.staleCount} stale module(s). Run 'grafema analyze' first.`);
        process.exit(1);
      }

      if (!options.skipReanalysis) {
        console.log(`Reanalyzing ${freshness.staleCount} stale module(s)...`);

        const reanalyzer = new IncrementalReanalyzer(backend, resolvedPath);
        const result = await reanalyzer.reanalyze(freshness.staleModules);

        console.log(`Reanalyzed ${result.modulesReanalyzed} modules in ${result.durationMs}ms`);
      } else {
        console.warn(`Warning: ${freshness.staleCount} stale module(s) detected.`);
      }
    }

    // Proceed with validation
    // ...
  });
```

## Edge Cases Handled

1. **Deleted files**: Clear nodes, don't re-create MODULE node
2. **New files**: Not handled (would need re-discovery, out of scope)
3. **Permission errors**: Treat as stale, log warning
4. **Empty graph**: Warning to run `grafema analyze` first
5. **CI mode**: `--fail-on-stale` for fast failure without reanalysis

## Performance

- Hash checking: Batch with Promise.all in groups of 50 files
- Target: < 1 second for 1000 files (feasible with parallel I/O)
- Re-analysis: Only stale files, not entire codebase
- Enrichment: Full pass but quick on small delta

## What This Plan Fixes

1. **Actually implements reanalysis** - Not just detection
2. **Unifies hash calculation** - Single source of truth (DRY)
3. **Handles both code paths** - Both built-in validators and YAML guarantees
4. **Proper flag semantics** - `--skip-reanalysis` actually has something to skip
5. **Efficient incremental approach** - Only re-processes changed files

## Files to Create

1. `packages/core/src/core/HashUtils.ts` - Unified hash computation
2. `packages/core/src/core/GraphFreshnessChecker.ts` - Freshness detection
3. `packages/core/src/core/IncrementalReanalyzer.ts` - Selective reanalysis
4. `test/unit/GraphFreshnessChecker.test.js` - Unit tests
5. `test/unit/IncrementalReanalyzer.test.js` - Unit tests

## Files to Modify

1. `packages/core/src/index.ts` - Export new classes
2. `packages/cli/src/commands/check.ts` - Integrate freshness + reanalysis
3. `packages/core/src/plugins/indexing/JSModuleIndexer.ts` - Use HashUtils
4. `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts` - Use HashUtils
5. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Use HashUtils
6. `packages/core/src/plugins/vcs/GitPlugin.ts` - Use HashUtils
7. `packages/core/src/core/VersionManager.ts` - Use HashUtils

## Critical Files for Implementation

| File | Purpose |
|------|---------|
| `packages/core/src/core/FileNodeManager.ts` | Pattern for clearing nodes by file |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | `analyzeModule()` for selective reanalysis |
| `packages/core/src/plugins/enrichment/ImportExportLinker.ts` | Cross-file edge enrichment |
| `packages/cli/src/commands/check.ts` | CLI integration point |
| `packages/core/src/index.ts` | Export location |
