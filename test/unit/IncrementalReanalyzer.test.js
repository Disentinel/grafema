/**
 * IncrementalReanalyzer Tests (REG-97)
 *
 * Tests the selective re-analysis system that updates stale modules:
 * 1. Single file modification - graph updated correctly
 * 2. Deleted file - nodes cleared, no re-creation
 * 3. Cross-file edges preserved after reanalysis
 * 4. Enrichment phase runs correctly
 *
 * IncrementalReanalyzer is the key component that enables auto-reanalysis
 * when `grafema check` detects stale modules.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// These will be imported after implementation:
// import { IncrementalReanalyzer, GraphFreshnessChecker } from '@grafema/core';

let IncrementalReanalyzer;
let GraphFreshnessChecker;
let testCounter = 0;

/**
 * Create a unique test directory with package.json
 */
function createTestDir() {
  const testDir = join(tmpdir(), `grafema-reanalyzer-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-reanalyzer-${testCounter}`,
      type: 'module'
    })
  );

  return testDir;
}

/**
 * Try to import the actual implementation
 */
async function loadImplementation() {
  try {
    const core = await import('@grafema/core');
    IncrementalReanalyzer = core.IncrementalReanalyzer;
    GraphFreshnessChecker = core.GraphFreshnessChecker;
    // Check that both classes are actually exported and are constructors
    return !!(
      IncrementalReanalyzer && typeof IncrementalReanalyzer === 'function' &&
      GraphFreshnessChecker && typeof GraphFreshnessChecker === 'function'
    );
  } catch {
    return false;
  }
}

describe('IncrementalReanalyzer (REG-97)', () => {
  let implementationAvailable = false;
  let db;
  let backend;

  before(async () => {
    implementationAvailable = await loadImplementation();
  });

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('Single file modification', () => {
    it('should update graph when a single file is modified', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const filePath = join(testDir, 'index.js');
      writeFileSync(filePath, `
        export function foo() { return 1; }
      `);

      // Initial analysis
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Verify initial state - should have foo function
      const fns1 = await backend.getAllNodes({ type: 'FUNCTION' });
      const fooNode = fns1.find(f => f.name === 'foo');
      assert.ok(fooNode, 'Should have foo function initially');

      // Modify file - add bar function
      writeFileSync(filePath, `
        export function foo() { return 1; }
        export function bar() { return 2; }
      `);

      // Detect stale modules
      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      assert.strictEqual(freshness.isFresh, false,
        'Graph should be stale after modification');

      // Reanalyze
      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      const result = await reanalyzer.reanalyze(freshness.staleModules);

      assert.strictEqual(result.modulesReanalyzed, 1,
        'Should have reanalyzed 1 module');
      assert.ok(result.nodesCreated > 0,
        'Should have created nodes');

      // Verify new state - should have both foo and bar
      const fns2 = await backend.getAllNodes({ type: 'FUNCTION' });
      const fooNode2 = fns2.find(f => f.name === 'foo' && f.file?.includes('index.js'));
      const barNode = fns2.find(f => f.name === 'bar' && f.file?.includes('index.js'));

      assert.ok(fooNode2, 'foo function should still exist');
      assert.ok(barNode, 'bar function should now exist');

      // Verify freshness after reanalysis
      const freshness2 = await checker.checkFreshness(backend);
      assert.strictEqual(freshness2.isFresh, true,
        'Graph should be fresh after reanalysis');
    });

    it('should update function body when content changes', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const filePath = join(testDir, 'calc.js');
      writeFileSync(filePath, `
        export function calculate() {
          return 1 + 2;
        }
      `);
      // index.js imports calc.js so it gets discovered
      writeFileSync(join(testDir, 'index.js'), `import { calculate } from './calc.js';
export const result = calculate();`);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Modify function body
      writeFileSync(filePath, `
        export function calculate() {
          console.log("calculating...");
          return 1 + 2 + 3;
        }
      `);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      await reanalyzer.reanalyze(freshness.staleModules);

      // Verify the call site exists for console.log
      const callSites = await backend.getAllNodes({ type: 'CALL' });
      const consoleLogCall = callSites.find(c =>
        c.name === 'console.log' && c.file?.includes('calc.js')
      );

      assert.ok(consoleLogCall,
        'Should have console.log call site after reanalysis');
    });

    it('should remove deleted code from graph', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const filePath = join(testDir, 'index.js');
      writeFileSync(filePath, `
        export function keepMe() { return 1; }
        export function deleteMe() { return 2; }
      `);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Verify both functions exist
      const fns1 = await backend.getAllNodes({ type: 'FUNCTION' });
      assert.ok(fns1.find(f => f.name === 'keepMe'), 'keepMe should exist');
      assert.ok(fns1.find(f => f.name === 'deleteMe'), 'deleteMe should exist');

      // Remove deleteMe function
      writeFileSync(filePath, `
        export function keepMe() { return 1; }
      `);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      const result = await reanalyzer.reanalyze(freshness.staleModules);

      assert.ok(result.nodesCleared > 0,
        'Should have cleared some nodes');

      // Verify deleteMe is gone, keepMe remains
      const fns2 = await backend.getAllNodes({ type: 'FUNCTION' });
      const keepMeNode = fns2.find(f => f.name === 'keepMe' && f.file?.includes('index.js'));
      const deleteMeNode = fns2.find(f => f.name === 'deleteMe' && f.file?.includes('index.js'));

      assert.ok(keepMeNode, 'keepMe should still exist');
      assert.ok(!deleteMeNode, 'deleteMe should be deleted');
    });
  });

  describe('Deleted file handling', () => {
    it('should clear nodes when file is deleted', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const toDeletePath = join(testDir, 'to-delete.js');
      const keepPath = join(testDir, 'keep.js');
      const indexPath = join(testDir, 'index.js');

      writeFileSync(toDeletePath, 'export function deleted() { return 1; }');
      writeFileSync(keepPath, 'export function kept() { return 2; }');
      // index.js imports both files so they are discovered
      writeFileSync(indexPath, `import { deleted } from './to-delete.js';
import { kept } from './keep.js';
export const result = deleted() + kept();`);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Verify both files are analyzed
      const fns1 = await backend.getAllNodes({ type: 'FUNCTION' });
      assert.ok(fns1.find(f => f.name === 'deleted'), 'deleted() should exist');
      assert.ok(fns1.find(f => f.name === 'kept'), 'kept() should exist');

      // Delete the file
      unlinkSync(toDeletePath);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      assert.strictEqual(freshness.deletedCount, 1,
        'Should detect 1 deleted file');

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      const result = await reanalyzer.reanalyze(freshness.staleModules);

      assert.strictEqual(result.modulesDeleted, 1,
        'Should report 1 module deleted');
      assert.strictEqual(result.modulesReanalyzed, 0,
        'Should not reanalyze deleted modules');

      // Verify deleted function is gone, kept function remains
      const fns2 = await backend.getAllNodes({ type: 'FUNCTION' });
      const deletedNode = fns2.find(f => f.name === 'deleted');
      const keptNode = fns2.find(f => f.name === 'kept');

      assert.ok(!deletedNode, 'deleted() should be removed');
      assert.ok(keptNode, 'kept() should still exist');
    });

    it('should not recreate nodes for deleted files', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const filePath = join(testDir, 'deleted.js');

      writeFileSync(filePath, `
        export function willBeDeleted() { return 1; }
        export const VALUE = 42;
      `);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Count initial nodes
      const modules1 = await backend.getAllNodes({ type: 'MODULE' });
      const moduleCount1 = modules1.filter(m => m.file?.includes('deleted.js')).length;

      // Delete file
      unlinkSync(filePath);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      await reanalyzer.reanalyze(freshness.staleModules);

      // Verify MODULE node is removed
      const modules2 = await backend.getAllNodes({ type: 'MODULE' });
      const moduleCount2 = modules2.filter(m => m.file?.includes('deleted.js')).length;

      assert.strictEqual(moduleCount2, 0,
        'MODULE node for deleted file should be removed');
    });
  });

  describe('Cross-file edges preservation', () => {
    it('should preserve IMPORTS_FROM edges after reanalysis', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();

      // utils.js is written first
      writeFileSync(join(testDir, 'utils.js'), `
        export function helper() { return 'help'; }
      `);

      // index.js imports utils.js - this creates the dependency relationship
      writeFileSync(join(testDir, 'index.js'), `
        import { helper } from './utils.js';
        console.log(helper());
      `);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Verify IMPORTS_FROM edges exist
      const edges1 = await backend.getAllEdges();
      const importsFromEdges1 = edges1.filter(e => e.type === 'IMPORTS_FROM');
      assert.ok(importsFromEdges1.length > 0,
        'Should have IMPORTS_FROM edges initially');

      // Modify index.js (but keep the import)
      writeFileSync(join(testDir, 'index.js'), `
        import { helper } from './utils.js';
        console.log('calling helper:', helper());
      `);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      await reanalyzer.reanalyze(freshness.staleModules);

      // Verify IMPORTS_FROM edges are preserved
      const edges2 = await backend.getAllEdges();
      const importsFromEdges2 = edges2.filter(e => e.type === 'IMPORTS_FROM');

      assert.strictEqual(importsFromEdges2.length, importsFromEdges1.length,
        'IMPORTS_FROM edges should be preserved after reanalysis');
    });

    it('should update edges when imports change', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();

      // utils.js exports both helpers
      writeFileSync(join(testDir, 'utils.js'), `
        export function helperA() { return 'A'; }
        export function helperB() { return 'B'; }
      `);

      // index.js initially imports helperA
      writeFileSync(join(testDir, 'index.js'), `
        import { helperA } from './utils.js';
        console.log(helperA());
      `);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Change import from helperA to helperB
      writeFileSync(join(testDir, 'index.js'), `
        import { helperB } from './utils.js';
        console.log(helperB());
      `);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      await reanalyzer.reanalyze(freshness.staleModules);

      // Verify IMPORT nodes are updated
      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const indexImports = imports.filter(i => i.file?.includes('index.js'));

      const hasHelperA = indexImports.some(i => i.local === 'helperA');
      const hasHelperB = indexImports.some(i => i.local === 'helperB');

      assert.ok(!hasHelperA, 'helperA import should be removed');
      assert.ok(hasHelperB, 'helperB import should exist');
    });

    it('should handle new cross-file imports', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();

      // utils.js exports helper
      writeFileSync(join(testDir, 'utils.js'), `
        export function helper() { return 'help'; }
      `);

      // index.js initially imports utils but doesn't use it much
      // (we need the import for file discovery)
      writeFileSync(join(testDir, 'index.js'), `
        import { helper } from './utils.js';
        console.log('no usage yet');
      `);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Get initial IMPORTS edges count for index.js
      const edges1 = await backend.getAllEdges();
      const modules1 = await backend.getAllNodes({ type: 'MODULE' });
      const indexModule = modules1.find(m => m.file?.includes('index.js'));
      const initialImports = edges1.filter(e =>
        e.type === 'IMPORTS' && e.src === indexModule?.id
      );

      // Update index.js to actually use the helper
      writeFileSync(join(testDir, 'index.js'), `
        import { helper } from './utils.js';
        console.log(helper());
      `);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      await reanalyzer.reanalyze(freshness.staleModules);

      // Should still have cross-file edges after reanalysis
      const edges2 = await backend.getAllEdges();
      const importsEdges = edges2.filter(e => e.type === 'IMPORTS');
      const importsFromEdges = edges2.filter(e => e.type === 'IMPORTS_FROM');

      assert.ok(importsEdges.length >= initialImports.length,
        'Should preserve IMPORTS edges after reanalysis');
      assert.ok(importsFromEdges.length > 0,
        'Should have IMPORTS_FROM edges');
    });
  });

  describe('Enrichment phase', () => {
    it('should run enrichment plugins after reanalysis', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();

      // exported.js is written first
      writeFileSync(join(testDir, 'exported.js'), `
        export function exportedFn() { return 'exported'; }
      `);

      // index.js imports exported.js
      writeFileSync(join(testDir, 'index.js'), `
        import { exportedFn } from './exported.js';
        exportedFn();
      `);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Modify index.js
      writeFileSync(join(testDir, 'index.js'), `
        import { exportedFn } from './exported.js';
        console.log(exportedFn());
      `);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      const result = await reanalyzer.reanalyze(freshness.staleModules);

      assert.ok(result.edgesCreated > 0,
        'Enrichment should create edges');

      // Verify enrichment edges exist
      const edges = await backend.getAllEdges();
      const importsFromEdges = edges.filter(e => e.type === 'IMPORTS_FROM');

      assert.ok(importsFromEdges.length > 0,
        'ImportExportLinker enrichment should create IMPORTS_FROM edges');
    });

    it('should allow skipping enrichment with option', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), 'export const x = 1;');

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      writeFileSync(join(testDir, 'index.js'), 'export const x = 2;');

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      const result = await reanalyzer.reanalyze(freshness.staleModules, {
        skipEnrichment: true
      });

      // Should complete without running enrichment
      assert.ok(result.modulesReanalyzed >= 1,
        'Should reanalyze modules even with skipEnrichment');
    });
  });

  describe('Progress reporting', () => {
    it('should report progress during reanalysis', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      writeFileSync(join(testDir, 'a.js'), 'export const a = 1;');
      writeFileSync(join(testDir, 'b.js'), 'export const b = 2;');
      // index.js imports both files so they are discovered
      writeFileSync(join(testDir, 'index.js'), `import { a } from './a.js';
import { b } from './b.js';
export const sum = a + b;`);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Modify both files
      writeFileSync(join(testDir, 'a.js'), 'export const a = 10;');
      writeFileSync(join(testDir, 'b.js'), 'export const b = 20;');

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const progressUpdates = [];
      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      await reanalyzer.reanalyze(freshness.staleModules, {
        onProgress: (info) => {
          progressUpdates.push(info);
        }
      });

      assert.ok(progressUpdates.length > 0,
        'Should receive progress updates');

      const phases = new Set(progressUpdates.map(p => p.phase));
      assert.ok(phases.has('clearing'),
        'Should report clearing phase');
      assert.ok(phases.has('indexing'),
        'Should report indexing phase');
      assert.ok(phases.has('analysis'),
        'Should report analysis phase');
      assert.ok(phases.has('enrichment'),
        'Should report enrichment phase');
    });
  });

  describe('Result statistics', () => {
    it('should return accurate statistics', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const modified = join(testDir, 'modified.js');
      const deleted = join(testDir, 'deleted.js');
      const indexPath = join(testDir, 'index.js');

      writeFileSync(modified, 'export function mod() { return 1; }');
      writeFileSync(deleted, 'export function del() { return 2; }');
      // index.js imports both files so they are discovered
      writeFileSync(indexPath, `import { mod } from './modified.js';
import { del } from './deleted.js';
export const result = mod() + del();`);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Modify one, delete another
      writeFileSync(modified, 'export function mod() { return 10; }');
      unlinkSync(deleted);

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      const result = await reanalyzer.reanalyze(freshness.staleModules);

      assert.strictEqual(result.modulesReanalyzed, 1,
        'Should report 1 module reanalyzed');
      assert.strictEqual(result.modulesDeleted, 1,
        'Should report 1 module deleted');
      assert.ok(result.nodesCleared > 0,
        'Should report nodes cleared');
      assert.ok(result.durationMs >= 0,
        'Should report duration');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty staleModules array', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const reanalyzer = new IncrementalReanalyzer(backend, testDir);
      const result = await reanalyzer.reanalyze([]);

      assert.strictEqual(result.modulesReanalyzed, 0,
        'Should handle empty array gracefully');
      assert.strictEqual(result.modulesDeleted, 0,
        'Should have 0 deleted');
      assert.strictEqual(result.nodesCleared, 0,
        'Should have 0 cleared');
    });

    it('should handle syntax errors in modified files', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const filePath = join(testDir, 'index.js');
      writeFileSync(filePath, 'export const x = 1;');

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Introduce syntax error
      writeFileSync(filePath, 'export const x = {{{INVALID}}}');

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);

      // Should not throw, should handle gracefully
      const result = await reanalyzer.reanalyze(freshness.staleModules);

      assert.ok(result,
        'Should return result even with syntax errors');
    });

    it('should handle concurrent reanalysis of same module', async (t) => {
      if (!implementationAvailable) {
        t.skip('IncrementalReanalyzer not yet implemented');
        return;
      }

      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), 'export const x = 1;');

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      writeFileSync(join(testDir, 'index.js'), 'export const x = 2;');

      const checker = new GraphFreshnessChecker();
      const freshness = await checker.checkFreshness(backend);

      const reanalyzer = new IncrementalReanalyzer(backend, testDir);

      // Try concurrent reanalysis (should not corrupt graph)
      const [result1, result2] = await Promise.all([
        reanalyzer.reanalyze(freshness.staleModules),
        reanalyzer.reanalyze(freshness.staleModules)
      ]);

      // Both should complete without error
      assert.ok(result1, 'First reanalysis should complete');
      assert.ok(result2, 'Second reanalysis should complete');
    });
  });
});
