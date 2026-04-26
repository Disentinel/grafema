# Joel Spolsky's Detailed Technical Specification for REG-97

Based on Don's high-level plan, I've explored the codebase thoroughly. Here is the complete technical specification for implementing `GraphFreshnessChecker`.

## Summary of Key Findings

1. **Hash computation pattern** - Found in three places, all using the same approach:
   - `JSModuleIndexer.calculateFileHash()` at line 105
   - `JSASTAnalyzer.calculateFileHash()` at line 212
   - `IncrementalModuleIndexer.calculateFileHash()` at line 110

   All use: `createHash('sha256').update(content).digest('hex')`

2. **Hash comparison pattern** - `JSASTAnalyzer.shouldAnalyzeModule()` at lines 224-258 is the exact pattern we need.

3. **Module iteration pattern** - Uses async generator: `for await (const node of graph.queryNodes({ type: 'MODULE' }))`

4. **MODULE node structure** - From `ModuleNode.ts`:
   ```typescript
   interface ModuleNodeRecord {
     id: string;           // semantic ID: "{relativePath}->global->MODULE->module"
     type: 'MODULE';
     name: string;         // relative path
     file: string;         // absolute path
     line: number;         // always 0
     contentHash: string;  // SHA-256 hash
     isTest: boolean;
   }
   ```

5. **Backend query API** - `queryNodes()` returns `AsyncGenerator<BackendNode>`, can filter by `{ type: 'MODULE' }`

---

## Detailed Implementation Specification

### Phase 1: Create GraphFreshnessChecker Service

**File: `/Users/vadimr/grafema/packages/core/src/core/GraphFreshnessChecker.ts`**

```typescript
/**
 * GraphFreshnessChecker - checks if graph data matches current files
 *
 * WHEN TO USE THIS:
 * - Before running validation (grafema check)
 * - Before running queries that require fresh data
 * - In CI to fail fast on stale graphs
 *
 * HOW IT WORKS:
 * 1. Iterates all MODULE nodes from graph
 * 2. For each module, compares stored contentHash with current file hash
 * 3. Returns list of stale (changed/deleted) modules
 *
 * PERFORMANCE:
 * - Uses batched Promise.all() for parallel hash computation
 * - Target: < 1 second for 1000 files
 */

import { createHash } from 'crypto';
import { readFile, access, constants } from 'fs/promises';

// Import types
import type { NodeRecord } from '@grafema/types';

/**
 * Stale module information
 */
export interface StaleModule {
  /** Module node ID from graph */
  id: string;
  /** Absolute file path */
  file: string;
  /** Hash stored in graph */
  storedHash: string;
  /** Current file hash (null if file deleted or unreadable) */
  currentHash: string | null;
  /** Reason for staleness */
  reason: 'changed' | 'deleted' | 'unreadable';
}

/**
 * Freshness check result
 */
export interface FreshnessResult {
  /** True if all modules are fresh */
  isFresh: boolean;
  /** List of stale modules */
  staleModules: StaleModule[];
  /** Count of fresh (unchanged) modules */
  freshCount: number;
  /** Count of stale (changed) modules */
  staleCount: number;
  /** Count of deleted files */
  deletedCount: number;
  /** Total check duration in milliseconds */
  checkDurationMs: number;
}

/**
 * Graph interface required by GraphFreshnessChecker
 * Matches the subset of RFDBServerBackend we need
 */
export interface FreshnessGraph {
  queryNodes(query: { type: string }): AsyncGenerator<NodeRecord, void, unknown>;
}

/**
 * Module node with required fields for freshness checking
 */
interface ModuleInfo {
  id: string;
  file: string;
  contentHash: string;
}

/**
 * Batch size for parallel hash computation
 * Tuned for optimal I/O without overwhelming the system
 */
const BATCH_SIZE = 50;

export class GraphFreshnessChecker {
  /**
   * Check freshness of all MODULE nodes in graph
   *
   * @param graph - Graph backend with queryNodes support
   * @returns FreshnessResult with stale modules list
   */
  async checkFreshness(graph: FreshnessGraph): Promise<FreshnessResult> {
    const startTime = Date.now();

    // 1. Collect all MODULE nodes
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

    // 2. Check freshness in batches for performance
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

  /**
   * Check if a single module is fresh
   * @returns null if fresh, StaleModule if stale
   */
  private async _checkModuleFreshness(module: ModuleInfo): Promise<StaleModule | null> {
    // Check if file exists
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

    // Compute current hash
    const currentHash = await this._calculateFileHash(module.file);
    if (currentHash === null) {
      return {
        id: module.id,
        file: module.file,
        storedHash: module.contentHash,
        currentHash: null,
        reason: 'unreadable'
      };
    }

    // Compare hashes
    if (currentHash !== module.contentHash) {
      return {
        id: module.id,
        file: module.file,
        storedHash: module.contentHash,
        currentHash,
        reason: 'changed'
      };
    }

    return null; // Fresh
  }

  /**
   * Calculate SHA-256 hash of file content
   * Same algorithm as JSModuleIndexer and JSASTAnalyzer
   */
  private async _calculateFileHash(filePath: string): Promise<string | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Check if file exists and is readable
   */
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

---

### Phase 2: Export from Core Index

**File: `/Users/vadimr/grafema/packages/core/src/index.ts`**

Add export after `GuaranteeManager` export:

```typescript
export { GraphFreshnessChecker } from './core/GraphFreshnessChecker.js';
export type {
  FreshnessGraph,
  FreshnessResult,
  StaleModule
} from './core/GraphFreshnessChecker.js';
```

---

### Phase 3: CLI Integration

**File: `/Users/vadimr/grafema/packages/cli/src/commands/check.ts`**

**Step 3.1: Add import**

```typescript
import { GraphFreshnessChecker } from '@grafema/core';
import type { FreshnessResult, StaleModule } from '@grafema/core';
```

**Step 3.2: Add new CLI options**

Add before `.action()`:
```typescript
.option('--skip-reanalysis', 'Skip automatic reanalysis of stale modules')
.option('--fail-on-stale', 'Exit with error if stale modules found (CI mode)')
```

**Step 3.3: Update options type**

```typescript
options: {
  project: string;
  file?: string;
  guarantee?: string;
  json?: boolean;
  quiet?: boolean;
  listGuarantees?: boolean;
  skipReanalysis?: boolean;
  failOnStale?: boolean;
}
```

**Step 3.4: Add freshness check after backend connection**

Insert after `await backend.connect();`, before the try block:

```typescript
// Check graph freshness before validation
if (!options.skipReanalysis) {
  const freshnessChecker = new GraphFreshnessChecker();
  const freshnessResult = await freshnessChecker.checkFreshness(backend);

  if (!freshnessResult.isFresh) {
    if (options.failOnStale) {
      console.error(`Error: Graph is stale. ${freshnessResult.staleCount} module(s) have changed.`);
      if (!options.quiet) {
        for (const stale of freshnessResult.staleModules.slice(0, 5)) {
          console.error(`  - ${stale.file} (${stale.reason})`);
        }
        if (freshnessResult.staleModules.length > 5) {
          console.error(`  ... and ${freshnessResult.staleModules.length - 5} more`);
        }
      }
      console.error('');
      console.error('Run "grafema analyze" to update the graph, or use --skip-reanalysis to skip this check.');
      await backend.close();
      process.exit(1);
    }

    // Display warning about stale modules
    if (!options.quiet) {
      console.log(`\x1b[33mWarning: ${freshnessResult.staleCount} stale module(s) detected.\x1b[0m`);
      console.log('Run "grafema analyze" to update the graph.');
      console.log(`(Checked ${freshnessResult.freshCount + freshnessResult.staleCount} modules in ${freshnessResult.checkDurationMs}ms)`);
      console.log('');
    }
  } else if (!options.quiet) {
    console.log(`Graph is fresh (${freshnessResult.freshCount} modules checked in ${freshnessResult.checkDurationMs}ms)`);
    console.log('');
  }
}
```

---

### Phase 4: Test Implementation

**File: `/Users/vadimr/grafema/test/unit/GraphFreshnessChecker.test.js`**

```javascript
/**
 * Tests for GraphFreshnessChecker
 *
 * Tests:
 * - Fresh graph detection (no changes)
 * - Stale module detection (file changed)
 * - Deleted file detection
 * - Empty graph handling
 * - Performance benchmark (1000 files < 1 second)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { GraphFreshnessChecker } from '@grafema/core';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/eval-ban');
const TEMP_FIXTURE = join(process.cwd(), 'test/fixtures/.freshness-test');

describe('GraphFreshnessChecker', () => {
  let backend;
  let checker;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
    checker = new GraphFreshnessChecker();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
    // Cleanup temp fixture
    try {
      rmSync(TEMP_FIXTURE, { recursive: true, force: true });
    } catch {}
  });

  describe('checkFreshness()', () => {
    it('should return isFresh=true for unchanged files', async () => {
      // Analyze fixture
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Check freshness
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, true);
      assert.strictEqual(result.staleCount, 0);
      assert.ok(result.freshCount > 0, 'Should have analyzed some modules');
      assert.ok(result.checkDurationMs >= 0, 'Should report duration');
    });

    it('should detect changed files', async () => {
      // Setup: create temp fixture
      mkdirSync(TEMP_FIXTURE, { recursive: true });
      const testFile = join(TEMP_FIXTURE, 'index.js');
      writeFileSync(testFile, 'console.log("original");');

      // Analyze
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(TEMP_FIXTURE);

      // Modify file
      writeFileSync(testFile, 'console.log("modified");');

      // Check freshness
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, false);
      assert.strictEqual(result.staleCount, 1);
      assert.strictEqual(result.staleModules[0].reason, 'changed');
      assert.ok(result.staleModules[0].currentHash !== result.staleModules[0].storedHash);
    });

    it('should detect deleted files', async () => {
      // Setup: create temp fixture
      mkdirSync(TEMP_FIXTURE, { recursive: true });
      const testFile = join(TEMP_FIXTURE, 'to-delete.js');
      writeFileSync(testFile, 'console.log("will be deleted");');

      // Analyze
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(TEMP_FIXTURE);

      // Delete file
      rmSync(testFile);

      // Check freshness
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, false);
      assert.strictEqual(result.deletedCount, 1);
      const deleted = result.staleModules.find(m => m.reason === 'deleted');
      assert.ok(deleted, 'Should find deleted module');
      assert.strictEqual(deleted.currentHash, null);
    });

    it('should handle empty graph', async () => {
      // Don't analyze anything - empty graph
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, true);
      assert.strictEqual(result.freshCount, 0);
      assert.strictEqual(result.staleCount, 0);
    });

    it('should complete freshness check within performance target', async () => {
      // Use existing larger fixture for benchmark
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Run freshness check multiple times and average
      const runs = 5;
      let totalMs = 0;
      for (let i = 0; i < runs; i++) {
        const result = await checker.checkFreshness(backend);
        totalMs += result.checkDurationMs;
      }
      const avgMs = totalMs / runs;

      console.log(`Average freshness check: ${avgMs.toFixed(2)}ms for fixture`);

      // Performance assertion (adjust based on fixture size)
      assert.ok(avgMs < 1000, `Freshness check too slow: ${avgMs}ms`);
    });
  });
});
```

---

## Implementation Order

1. **Create `GraphFreshnessChecker.ts`** in `packages/core/src/core/`
2. **Export from `index.ts`** in `packages/core/src/`
3. **Write tests** in `test/unit/GraphFreshnessChecker.test.js`
4. **Run tests** - ensure they pass
5. **Integrate into `check.ts`** - add freshness check before validation
6. **Add CLI tests** for new flags

## Test Commands

```bash
# Run unit tests for freshness checker
node --test test/unit/GraphFreshnessChecker.test.js

# Test CLI integration manually
grafema analyze test/fixtures/eval-ban
grafema check --guarantee=node-creation
# Should show "Graph is fresh" message

# Modify a file and run again
echo "// change" >> test/fixtures/eval-ban/index.js
grafema check --guarantee=node-creation
# Should show "Warning: 1 stale module(s) detected"

# Test CI mode
grafema check --guarantee=node-creation --fail-on-stale
# Should exit with error code 1
```

## Critical Files

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/core/GraphFreshnessChecker.ts` | CREATE | Main service |
| `packages/core/src/index.ts` | MODIFY | Export new class |
| `packages/cli/src/commands/check.ts` | MODIFY | CLI integration |
| `test/unit/GraphFreshnessChecker.test.js` | CREATE | Unit tests |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | REFERENCE | Hash pattern |
