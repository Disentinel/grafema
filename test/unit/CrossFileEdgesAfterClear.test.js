/**
 * Cross-File Edges After Clear Tests (REG-121)
 *
 * Verifies that cross-file edges (IMPORTS_FROM, MODULE->IMPORTS->MODULE) are
 * correctly recreated after clearing the graph and re-analyzing.
 *
 * ROOT CAUSE: GraphBuilder.createImportExportEdges() queries for target nodes
 * during per-file analysis, but those nodes may not exist yet when files are
 * processed in parallel batches.
 *
 * SOLUTION: Remove cross-file edge creation from GraphBuilder and rely solely
 * on ImportExportLinker (enrichment phase) which runs after all files are analyzed.
 *
 * Key behaviors tested:
 * 1. IMPORTS_FROM edges exist after first analysis
 * 2. IMPORTS_FROM edges persist after clear + re-analysis (THE BUG)
 * 3. MODULE -> IMPORTS -> MODULE edges for relative imports
 * 4. MODULE -> IMPORTS -> EXTERNAL_MODULE edges for npm packages
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { ImportExportLinker } from '@grafema/core';

let testCounter = 0;

/**
 * Create a unique test directory with package.json
 * IMPORTANT: Always includes index.js as entrypoint
 */
function createTestDir() {
  const testDir = join(tmpdir(), `grafema-cross-file-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-cross-file-${testCounter}`,
      type: 'module'
    })
  );

  return testDir;
}

/**
 * Create orchestrator with forceAnalysis to bypass caching
 * This is critical for testing clear-and-rebuild behavior
 *
 * IMPORTANT: Includes ImportExportLinker which creates IMPORTS_FROM edges
 */
function createForcedOrchestrator(backend) {
  return createTestOrchestrator(backend, {
    forceAnalysis: true,
    extraPlugins: [new ImportExportLinker()]
  });
}

describe('Cross-File Edges After Clear (REG-121)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('IMPORTS_FROM edges consistency', () => {
    it('should create IMPORTS_FROM edges on first analysis', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'utils.js'), `
        export function helper() { return 1; }
        export function anotherHelper() { return 2; }
      `);

      // index.js as entrypoint
      writeFileSync(join(testDir, 'index.js'), `
        import { helper, anotherHelper } from './utils.js';
        console.log(helper(), anotherHelper());
      `);

      const orchestrator = createForcedOrchestrator(backend);
      await orchestrator.run(testDir);

      // Get all IMPORTS_FROM edges
      const allEdges = await backend.getAllEdges();
      const importsFromEdges = allEdges.filter(e => e.type === 'IMPORTS_FROM');

      assert.ok(importsFromEdges.length > 0,
        `Should have IMPORTS_FROM edges after first analysis, got ${importsFromEdges.length}`);

      // Should have edges for both named imports
      const helperEdge = importsFromEdges.find(e =>
        e.src.includes(':IMPORT:') && e.src.includes(':helper')
      );
      const anotherHelperEdge = importsFromEdges.find(e =>
        e.src.includes(':IMPORT:') && e.src.includes(':anotherHelper')
      );

      assert.ok(helperEdge,
        'Should have IMPORTS_FROM edge for helper import');
      assert.ok(anotherHelperEdge,
        'Should have IMPORTS_FROM edge for anotherHelper import');
    });

    it('should preserve IMPORTS_FROM edges after clear and re-analysis', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'utils.js'), `
        export function helper() { return 1; }
      `);

      writeFileSync(join(testDir, 'index.js'), `
        import { helper } from './utils.js';
        helper();
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);

      const edges1 = await backend.getAllEdges();
      const importsFromEdges1 = edges1.filter(e => e.type === 'IMPORTS_FROM');
      const count1 = importsFromEdges1.length;

      assert.ok(count1 > 0,
        `Should have IMPORTS_FROM edges after first analysis, got ${count1}`);

      // Second analysis with NEW orchestrator (simulates running CLI twice)
      // This triggers the clear-and-rebuild logic
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);

      const edges2 = await backend.getAllEdges();
      const importsFromEdges2 = edges2.filter(e => e.type === 'IMPORTS_FROM');
      const count2 = importsFromEdges2.length;

      // THE BUG: IMPORTS_FROM edges should be recreated after clear
      assert.strictEqual(count2, count1,
        `IMPORTS_FROM edge count should be preserved after re-analysis. First: ${count1}, Second: ${count2}`);
    });

    it('should create IMPORTS_FROM edges for default imports', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'calculator.js'), `
        export default function calculate(x) { return x * 2; }
      `);

      // index.js imports from calculator.js
      writeFileSync(join(testDir, 'index.js'), `
        import calculate from './calculator.js';
        console.log(calculate(5));
      `);

      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);

      const edges1 = await backend.getAllEdges();
      const importsFromEdges1 = edges1.filter(e => e.type === 'IMPORTS_FROM');

      assert.ok(importsFromEdges1.length > 0,
        'Should have IMPORTS_FROM edge for default import');

      // Verify the edge connects IMPORT to EXPORT
      const defaultImportEdge = importsFromEdges1.find(e =>
        e.src.includes(':IMPORT:')
      );
      assert.ok(defaultImportEdge,
        'Should have IMPORTS_FROM edge from IMPORT node');
      assert.ok(defaultImportEdge.dst.includes(':EXPORT:') || defaultImportEdge.dst.includes('EXPORT'),
        `IMPORTS_FROM edge should point to EXPORT node, got dst: ${defaultImportEdge.dst}`);

      // Re-analyze and verify edges persist
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);

      const edges2 = await backend.getAllEdges();
      const importsFromEdges2 = edges2.filter(e => e.type === 'IMPORTS_FROM');

      assert.strictEqual(importsFromEdges2.length, importsFromEdges1.length,
        'IMPORTS_FROM edges should persist after re-analysis');
    });
  });

  describe('MODULE -> IMPORTS -> MODULE edges for relative imports', () => {
    it('should create MODULE -> IMPORTS -> MODULE edges for relative imports', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'lib.js'), `
        export const VERSION = '1.0.0';
      `);

      // Use index.js as entrypoint
      writeFileSync(join(testDir, 'index.js'), `
        import { VERSION } from './lib.js';
        console.log(VERSION);
      `);

      const orchestrator = createForcedOrchestrator(backend);
      await orchestrator.run(testDir);

      // Get all MODULE nodes
      const modules = await backend.getAllNodes({ type: 'MODULE' });
      const indexModule = modules.find(m => m.file?.includes('index.js'));
      const libModule = modules.find(m => m.file?.includes('lib.js'));

      assert.ok(indexModule, 'Should have index.js MODULE');
      assert.ok(libModule, 'Should have lib.js MODULE');

      // Check for any IMPORTS edges
      const allEdges = await backend.getAllEdges();
      const importsEdges = allEdges.filter(e => e.type === 'IMPORTS');

      // The bug: MODULE -> IMPORTS -> MODULE edges for relative imports may be missing
      // These are created by GraphBuilder.createImportExportEdges() which has timing issues
      // OR should be created by ImportExportLinker (but currently not implemented)
      const moduleImportsEdges = importsEdges.filter(e =>
        e.src === indexModule.id &&
        e.dst === libModule.id
      );

      assert.ok(moduleImportsEdges.length > 0,
        `Should have MODULE -> IMPORTS -> MODULE edge from index.js to lib.js. Found ${importsEdges.length} total IMPORTS edges.`);
    });

    it('should preserve MODULE -> IMPORTS -> MODULE edges after clear and re-analysis', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'utils.js'), `
        export function util() { return 'util'; }
      `);

      writeFileSync(join(testDir, 'index.js'), `
        import { util } from './utils.js';
        util();
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);

      const modules1 = await backend.getAllNodes({ type: 'MODULE' });
      const indexModule = modules1.find(m => m.file?.includes('index.js'));
      const utilsModule = modules1.find(m => m.file?.includes('utils.js'));

      const edges1 = await backend.getAllEdges();
      const moduleImportsEdges1 = edges1.filter(e =>
        e.type === 'IMPORTS' &&
        e.src === indexModule?.id &&
        e.dst === utilsModule?.id
      );

      // Note: This may fail if GraphBuilder timing issues prevent edge creation
      // After the fix, this test should pass
      const baselineCount = moduleImportsEdges1.length;

      // Second analysis
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);

      const modules2 = await backend.getAllNodes({ type: 'MODULE' });
      const indexModule2 = modules2.find(m => m.file?.includes('index.js'));
      const utilsModule2 = modules2.find(m => m.file?.includes('utils.js'));

      const edges2 = await backend.getAllEdges();
      const moduleImportsEdges2 = edges2.filter(e =>
        e.type === 'IMPORTS' &&
        e.src === indexModule2?.id &&
        e.dst === utilsModule2?.id
      );

      // Counts should be the same
      assert.strictEqual(moduleImportsEdges2.length, baselineCount,
        `MODULE IMPORTS edge count should be stable. First: ${baselineCount}, Second: ${moduleImportsEdges2.length}`);
    });

    it('should create MODULE -> IMPORTS -> EXTERNAL_MODULE edges for npm packages', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'index.js'), `
        import React from 'react';
        import lodash from 'lodash';
        console.log(React, lodash);
      `);

      const orchestrator = createForcedOrchestrator(backend);
      await orchestrator.run(testDir);

      const modules = await backend.getAllNodes({ type: 'MODULE' });
      const indexModule = modules.find(m => m.file?.includes('index.js'));
      assert.ok(indexModule, 'Should have index.js MODULE');

      // Get EXTERNAL_MODULE nodes
      const externalModules = await backend.getAllNodes({ type: 'EXTERNAL_MODULE' });
      const reactModule = externalModules.find(m => m.name === 'react');
      const lodashModule = externalModules.find(m => m.name === 'lodash');

      assert.ok(reactModule, 'Should have react EXTERNAL_MODULE');
      assert.ok(lodashModule, 'Should have lodash EXTERNAL_MODULE');

      // Get IMPORTS edges to external modules
      const allEdges = await backend.getAllEdges();
      const externalImportsEdges = allEdges.filter(e =>
        e.type === 'IMPORTS' &&
        e.src === indexModule.id &&
        (e.dst === reactModule.id || e.dst === lodashModule.id)
      );

      assert.ok(externalImportsEdges.length >= 2,
        `Should have IMPORTS edges to EXTERNAL_MODULEs, got ${externalImportsEdges.length}`);
    });
  });

  describe('Complex multi-file scenarios', () => {
    it('should handle chain of imports correctly', async () => {
      const testDir = createTestDir();

      // A imports from B, B imports from C
      writeFileSync(join(testDir, 'c.js'), `
        export function core() { return 'core'; }
      `);

      writeFileSync(join(testDir, 'b.js'), `
        import { core } from './c.js';
        export function wrapper() { return core(); }
      `);

      // index.js is the entrypoint
      writeFileSync(join(testDir, 'index.js'), `
        import { wrapper } from './b.js';
        console.log(wrapper());
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);

      const edges1 = await backend.getAllEdges();
      const importsFromEdges1 = edges1.filter(e => e.type === 'IMPORTS_FROM');
      const moduleImportsEdges1 = edges1.filter(e => e.type === 'IMPORTS');

      // Should have IMPORTS_FROM edges: index->b, b->c
      assert.ok(importsFromEdges1.length >= 2,
        `Should have at least 2 IMPORTS_FROM edges in chain, got ${importsFromEdges1.length}`);

      // Second analysis
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);

      const edges2 = await backend.getAllEdges();
      const importsFromEdges2 = edges2.filter(e => e.type === 'IMPORTS_FROM');
      const moduleImportsEdges2 = edges2.filter(e => e.type === 'IMPORTS');

      assert.strictEqual(importsFromEdges2.length, importsFromEdges1.length,
        `IMPORTS_FROM edge count should be stable in chain. First: ${importsFromEdges1.length}, Second: ${importsFromEdges2.length}`);

      assert.strictEqual(moduleImportsEdges2.length, moduleImportsEdges1.length,
        `MODULE IMPORTS edge count should be stable in chain. First: ${moduleImportsEdges1.length}, Second: ${moduleImportsEdges2.length}`);
    });

    it('should handle circular imports correctly', async () => {
      const testDir = createTestDir();

      // a imports from b, b imports from a
      writeFileSync(join(testDir, 'a.js'), `
        import { funcB } from './b.js';
        export function funcA() { return 'A'; }
        console.log(funcB());
      `);

      writeFileSync(join(testDir, 'b.js'), `
        import { funcA } from './a.js';
        export function funcB() { return 'B'; }
        console.log(funcA());
      `);

      // index.js triggers the circular import
      writeFileSync(join(testDir, 'index.js'), `
        import { funcA } from './a.js';
        console.log(funcA());
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);

      const edges1 = await backend.getAllEdges();
      const importsFromEdges1 = edges1.filter(e => e.type === 'IMPORTS_FROM');

      // Should have IMPORTS_FROM edges for circular imports
      assert.ok(importsFromEdges1.length >= 2,
        `Should have at least 2 IMPORTS_FROM edges for circular imports, got ${importsFromEdges1.length}`);

      // Second analysis
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);

      const edges2 = await backend.getAllEdges();
      const importsFromEdges2 = edges2.filter(e => e.type === 'IMPORTS_FROM');

      assert.strictEqual(importsFromEdges2.length, importsFromEdges1.length,
        `IMPORTS_FROM edges should persist for circular imports. First: ${importsFromEdges1.length}, Second: ${importsFromEdges2.length}`);
    });

    it('should handle mixed relative and external imports', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'local.js'), `
        export const LOCAL_CONST = 42;
      `);

      writeFileSync(join(testDir, 'index.js'), `
        import React from 'react';
        import { LOCAL_CONST } from './local.js';
        console.log(React, LOCAL_CONST);
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);

      const edges1 = await backend.getAllEdges();
      const importsFromEdges1 = edges1.filter(e => e.type === 'IMPORTS_FROM');
      const importsEdges1 = edges1.filter(e => e.type === 'IMPORTS');

      // Should have IMPORTS_FROM for relative import
      assert.ok(importsFromEdges1.length > 0,
        'Should have IMPORTS_FROM edge for relative import');

      // Should have IMPORTS edges for both relative and external
      assert.ok(importsEdges1.length >= 2,
        `Should have at least 2 IMPORTS edges (relative + external), got ${importsEdges1.length}`);

      // Second analysis
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);

      const edges2 = await backend.getAllEdges();
      const importsFromEdges2 = edges2.filter(e => e.type === 'IMPORTS_FROM');
      const importsEdges2 = edges2.filter(e => e.type === 'IMPORTS');

      assert.strictEqual(importsFromEdges2.length, importsFromEdges1.length,
        `IMPORTS_FROM edges should persist. First: ${importsFromEdges1.length}, Second: ${importsFromEdges2.length}`);

      assert.strictEqual(importsEdges2.length, importsEdges1.length,
        `IMPORTS edges should persist. First: ${importsEdges1.length}, Second: ${importsEdges2.length}`);
    });
  });

  describe('Edge correctness verification', () => {
    it('should connect IMPORT node to correct EXPORT node', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'exports.js'), `
        export function funcOne() { return 1; }
        export function funcTwo() { return 2; }
        export default function main() { return 'main'; }
      `);

      writeFileSync(join(testDir, 'index.js'), `
        import mainFunc, { funcOne, funcTwo } from './exports.js';
        console.log(mainFunc(), funcOne(), funcTwo());
      `);

      const orchestrator = createForcedOrchestrator(backend);
      await orchestrator.run(testDir);

      // Get IMPORT nodes
      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const mainImport = imports.find(i => i.local === 'mainFunc' && i.importType === 'default');
      const funcOneImport = imports.find(i => i.local === 'funcOne');
      const funcTwoImport = imports.find(i => i.local === 'funcTwo');

      assert.ok(mainImport, 'Should have mainFunc (default) import');
      assert.ok(funcOneImport, 'Should have funcOne import');
      assert.ok(funcTwoImport, 'Should have funcTwo import');

      // Get EXPORT nodes
      const exports = await backend.getAllNodes({ type: 'EXPORT' });
      const defaultExport = exports.find(e => e.exportType === 'default' && e.file?.includes('exports.js'));
      const funcOneExport = exports.find(e => e.name === 'funcOne' && e.exportType === 'named');
      const funcTwoExport = exports.find(e => e.name === 'funcTwo' && e.exportType === 'named');

      assert.ok(defaultExport, 'Should have default export');
      assert.ok(funcOneExport, 'Should have funcOne export');
      assert.ok(funcTwoExport, 'Should have funcTwo export');

      // Verify IMPORTS_FROM edges connect correctly
      const edges = await backend.getAllEdges();
      const importsFromEdges = edges.filter(e => e.type === 'IMPORTS_FROM');

      // Check default import -> default export
      const defaultEdge = importsFromEdges.find(e =>
        e.src === mainImport.id && e.dst === defaultExport.id
      );
      assert.ok(defaultEdge,
        `Should have IMPORTS_FROM edge from default import to default export`);

      // Check named imports -> named exports
      const funcOneEdge = importsFromEdges.find(e =>
        e.src === funcOneImport.id && e.dst === funcOneExport.id
      );
      assert.ok(funcOneEdge,
        `Should have IMPORTS_FROM edge from funcOne import to funcOne export`);

      const funcTwoEdge = importsFromEdges.find(e =>
        e.src === funcTwoImport.id && e.dst === funcTwoExport.id
      );
      assert.ok(funcTwoEdge,
        `Should have IMPORTS_FROM edge from funcTwo import to funcTwo export`);
    });
  });

  describe('Re-export scenarios', () => {
    it('should handle re-exports correctly', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'original.js'), `
        export function original() { return 'original'; }
      `);

      writeFileSync(join(testDir, 'reexporter.js'), `
        export { original } from './original.js';
      `);

      writeFileSync(join(testDir, 'index.js'), `
        import { original } from './reexporter.js';
        console.log(original());
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);

      const edges1 = await backend.getAllEdges();
      const importsFromEdges1 = edges1.filter(e => e.type === 'IMPORTS_FROM');

      // Should have edges for the re-export chain
      assert.ok(importsFromEdges1.length > 0,
        `Should have IMPORTS_FROM edges for re-exports, got ${importsFromEdges1.length}`);

      // Second analysis
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);

      const edges2 = await backend.getAllEdges();
      const importsFromEdges2 = edges2.filter(e => e.type === 'IMPORTS_FROM');

      assert.strictEqual(importsFromEdges2.length, importsFromEdges1.length,
        `IMPORTS_FROM edges should persist for re-exports. First: ${importsFromEdges1.length}, Second: ${importsFromEdges2.length}`);
    });

    it('should handle export * from correctly', async () => {
      const testDir = createTestDir();

      writeFileSync(join(testDir, 'types.js'), `
        export const TYPE_A = 'A';
        export const TYPE_B = 'B';
      `);

      writeFileSync(join(testDir, 'barrel.js'), `
        export * from './types.js';
      `);

      writeFileSync(join(testDir, 'index.js'), `
        import { TYPE_A, TYPE_B } from './barrel.js';
        console.log(TYPE_A, TYPE_B);
      `);

      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);

      // Verify edges exist
      const edges1 = await backend.getAllEdges();
      const importsEdges1 = edges1.filter(e => e.type === 'IMPORTS');

      // Should have MODULE IMPORTS edges
      assert.ok(importsEdges1.length > 0,
        `Should have IMPORTS edges for export *, got ${importsEdges1.length}`);

      // Second analysis
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);

      const edges2 = await backend.getAllEdges();
      const importsEdges2 = edges2.filter(e => e.type === 'IMPORTS');

      assert.strictEqual(importsEdges2.length, importsEdges1.length,
        `IMPORTS edges should persist. First: ${importsEdges1.length}, Second: ${importsEdges2.length}`);
    });
  });
});
