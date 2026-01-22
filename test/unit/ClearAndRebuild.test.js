/**
 * Clear-and-Rebuild Tests (REG-118)
 *
 * Verifies that re-analysis produces idempotent results by clearing
 * existing nodes before rebuilding. This fixes the node duplication bug
 * where running `grafema analyze` twice would double the node count.
 *
 * Key behaviors tested:
 * 1. Re-analysis produces identical graph (idempotency)
 * 2. Node count doesn't grow on repeated analysis
 * 3. MODULE nodes (from Indexer) are preserved across re-analysis
 * 4. EXTERNAL_MODULE nodes are preserved (shared across files)
 * 5. Singleton nodes (net:stdio, net:request) survive re-analysis
 * 6. Cross-file edges are recreated correctly
 * 7. Modified files update the graph correctly
 * 8. Deleted code is removed from the graph
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Create a unique test directory with package.json
 */
function createTestDir() {
  const testDir = join(tmpdir(), `grafema-clear-rebuild-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-clear-rebuild-${testCounter}`,
      type: 'module'
    })
  );

  return testDir;
}

/**
 * Helper to create a test project with given files and analyze it
 */
async function setupTest(backend, files) {
  const testDir = createTestDir();

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(testDir, filename);
    const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (fileDir !== testDir) {
      mkdirSync(fileDir, { recursive: true });
    }
    writeFileSync(filePath, content);
  }

  // forceAnalysis: true to bypass cache and test clear-and-rebuild
  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir, orchestrator };
}

/**
 * Create orchestrator with forceAnalysis to bypass caching
 * This is critical for testing clear-and-rebuild behavior
 */
function createForcedOrchestrator(backend) {
  return createTestOrchestrator(backend, { forceAnalysis: true });
}

describe('Clear-and-Rebuild (REG-118)', () => {
  let backend;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  describe('Idempotency', () => {
    it('should produce identical graph on re-analysis', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), `
        function hello() { return "world"; }
        const x = 1;
      `);

      // First analysis with fresh orchestrator
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);
      const state1 = await backend.export();
      const nodeCount1 = state1.nodes.length;
      const edgeCount1 = state1.edges.length;

      // Second analysis with NEW orchestrator (simulates running CLI twice)
      // This is critical - each `grafema analyze` invocation creates a new Orchestrator
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);
      const state2 = await backend.export();
      const nodeCount2 = state2.nodes.length;
      const edgeCount2 = state2.edges.length;

      // Counts should be identical
      assert.strictEqual(nodeCount2, nodeCount1,
        `Node count should not change on re-analysis. First: ${nodeCount1}, Second: ${nodeCount2}`);
      assert.strictEqual(edgeCount2, edgeCount1,
        `Edge count should not change on re-analysis. First: ${edgeCount1}, Second: ${edgeCount2}`);
    });
  });

  describe('Node count stability', () => {
    it('should not grow node count on repeated analysis', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), `
        import fs from 'fs';
        function readFile() { return fs.readFileSync('x'); }
      `);

      // First analysis - baseline
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);
      const baselineCount = await backend.nodeCount();

      // Analyze 3 more times with NEW orchestrators each time
      // This simulates running `grafema analyze` 3 more times from CLI
      for (let i = 0; i < 3; i++) {
        const orch = createForcedOrchestrator(backend);
        await orch.run(testDir);
      }

      const finalCount = await backend.nodeCount();

      assert.strictEqual(finalCount, baselineCount,
        `Node count should equal baseline after 4 analyses. Baseline: ${baselineCount}, Final: ${finalCount}`);
    });
  });

  describe('MODULE node preservation', () => {
    it('should preserve MODULE nodes across re-analysis', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), `const x = 1;`);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);
      const modules1 = await backend.getAllNodes({ type: 'MODULE' });
      const moduleIds1 = modules1.map(m => m.id).sort();
      const moduleCount1 = modules1.length;

      assert.ok(moduleCount1 > 0, 'Should have at least one MODULE node after first analysis');

      // Second analysis with NEW orchestrator
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);
      const modules2 = await backend.getAllNodes({ type: 'MODULE' });
      const moduleIds2 = modules2.map(m => m.id).sort();
      const moduleCount2 = modules2.length;

      // MODULE nodes should be preserved (same IDs)
      assert.deepStrictEqual(moduleIds2, moduleIds1,
        'MODULE node IDs should be preserved across re-analysis');

      // Count should be same
      assert.strictEqual(moduleCount2, moduleCount1,
        `MODULE count should not change. First: ${moduleCount1}, Second: ${moduleCount2}`);
    });
  });

  describe('EXTERNAL_MODULE preservation', () => {
    it('should preserve EXTERNAL_MODULE nodes across re-analysis', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), `
        import React from 'react';
        import lodash from 'lodash';
        const x = 1;
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);
      const externals1 = await backend.getAllNodes({ type: 'EXTERNAL_MODULE' });
      const externalIds1 = externals1.map(m => m.id).sort();

      assert.ok(externals1.length >= 2,
        `Should have at least 2 EXTERNAL_MODULE nodes, got ${externals1.length}`);

      // Second analysis with NEW orchestrator
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);
      const externals2 = await backend.getAllNodes({ type: 'EXTERNAL_MODULE' });
      const externalIds2 = externals2.map(m => m.id).sort();

      // EXTERNAL_MODULE count should not grow (not duplicated)
      assert.strictEqual(externals2.length, externals1.length,
        `EXTERNAL_MODULE count should not grow. First: ${externals1.length}, Second: ${externals2.length}`);

      // Same IDs should exist
      assert.deepStrictEqual(externalIds2, externalIds1,
        'EXTERNAL_MODULE node IDs should be preserved');
    });
  });

  describe('Singleton node survival', () => {
    it('should preserve net:stdio singleton across re-analysis', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), `
        function log() {
          console.log('hello');
          console.error('error');
        }
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);
      const stdioNodes1 = await backend.getAllNodes({ type: 'net:stdio' });

      assert.strictEqual(stdioNodes1.length, 1,
        `Should have exactly 1 net:stdio node, got ${stdioNodes1.length}`);
      assert.strictEqual(stdioNodes1[0].id, 'net:stdio#__stdio__',
        'net:stdio node should have expected singleton ID');

      // Second analysis with NEW orchestrator
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);
      const stdioNodes2 = await backend.getAllNodes({ type: 'net:stdio' });

      // Should still have exactly 1 stdio node (not duplicated)
      assert.strictEqual(stdioNodes2.length, 1,
        `Should still have exactly 1 net:stdio node after re-analysis, got ${stdioNodes2.length}`);
      assert.strictEqual(stdioNodes2[0].id, 'net:stdio#__stdio__',
        'net:stdio singleton ID should be preserved');
    });

    it('should preserve net:request singleton across re-analysis', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), `
        function fetchData() {
          fetch('https://api.example.com/data');
        }
      `);

      // First analysis
      const orchestrator1 = createForcedOrchestrator(backend);
      await orchestrator1.run(testDir);
      const networkNodes1 = await backend.getAllNodes({ type: 'net:request' });

      assert.strictEqual(networkNodes1.length, 1,
        `Should have exactly 1 net:request node, got ${networkNodes1.length}`);

      // Second analysis with NEW orchestrator
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);
      const networkNodes2 = await backend.getAllNodes({ type: 'net:request' });

      // Should still have exactly 1 network node (not duplicated)
      assert.strictEqual(networkNodes2.length, 1,
        `Should still have exactly 1 net:request node after re-analysis, got ${networkNodes2.length}`);
    });
  });

  describe('Cross-file edges', () => {
    it('should recreate cross-file edges on re-analysis', async () => {
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
      const importsEdges1 = edges1.filter(e => e.type === 'IMPORTS' || e.type === 'IMPORTS_FROM');

      assert.ok(importsEdges1.length > 0,
        'Should have import edges after first analysis');

      // Re-analyze with NEW orchestrator
      const orchestrator2 = createForcedOrchestrator(backend);
      await orchestrator2.run(testDir);
      const edges2 = await backend.getAllEdges();
      const importsEdges2 = edges2.filter(e => e.type === 'IMPORTS' || e.type === 'IMPORTS_FROM');

      // Import edges should still exist with same count
      assert.strictEqual(importsEdges2.length, importsEdges1.length,
        `Import edge count should be preserved. First: ${importsEdges1.length}, Second: ${importsEdges2.length}`);
    });
  });

  describe('Modified file updates', () => {
    it('should update graph when file is modified (adding a function)', async () => {
      const testDir = createTestDir();
      const filePath = join(testDir, 'index.js');

      // Initial version - one function
      writeFileSync(filePath, `
        function foo() { return 1; }
      `);

      // Use forceAnalysis to bypass caching and test clear-and-rebuild
      const orchestrator = createForcedOrchestrator(backend);
      await orchestrator.run(testDir);

      const fns1 = await backend.getAllNodes({ type: 'FUNCTION' });
      const fooNode = fns1.find(f => f.name === 'foo');
      assert.ok(fooNode, 'Should have foo function after first analysis');

      // Modified version - add bar function
      writeFileSync(filePath, `
        function foo() { return 1; }
        function bar() { return 2; }
      `);
      await orchestrator.run(testDir);

      const fns2 = await backend.getAllNodes({ type: 'FUNCTION' });
      const fooNode2 = fns2.find(f => f.name === 'foo');
      const barNode = fns2.find(f => f.name === 'bar');

      assert.ok(fooNode2, 'foo function should still exist after modification');
      assert.ok(barNode, 'bar function should exist after adding it');

      // Should have exactly 2 functions (not 3 due to duplication)
      const fileFunctions = fns2.filter(f => f.file && f.file.includes('index.js'));
      assert.strictEqual(fileFunctions.length, 2,
        `Should have exactly 2 functions in index.js, got ${fileFunctions.length}`);
    });
  });

  describe('Deleted code removal', () => {
    it('should remove nodes when code is deleted', async () => {
      const testDir = createTestDir();
      const filePath = join(testDir, 'index.js');

      // Initial version with two functions
      writeFileSync(filePath, `
        function foo() { return 1; }
        function bar() { return 2; }
      `);

      // Use forceAnalysis to bypass caching and test clear-and-rebuild
      const orchestrator = createForcedOrchestrator(backend);
      await orchestrator.run(testDir);

      const fns1 = await backend.getAllNodes({ type: 'FUNCTION' });
      const fileFunctions1 = fns1.filter(f => f.file && f.file.includes('index.js'));
      assert.strictEqual(fileFunctions1.length, 2, 'Should have 2 functions initially');

      // Modified version - remove bar
      writeFileSync(filePath, `
        function foo() { return 1; }
      `);
      await orchestrator.run(testDir);

      const fns2 = await backend.getAllNodes({ type: 'FUNCTION' });
      const fileFunctions2 = fns2.filter(f => f.file && f.file.includes('index.js'));

      assert.strictEqual(fileFunctions2.length, 1,
        `Should have 1 function after deletion, got ${fileFunctions2.length}`);
      assert.strictEqual(fileFunctions2[0].name, 'foo',
        'Remaining function should be foo');

      // bar should NOT exist
      const barNode = fns2.find(f => f.name === 'bar' && f.file && f.file.includes('index.js'));
      assert.ok(!barNode, 'bar function should have been deleted');
    });

    it('should remove variable nodes when variables are deleted', async () => {
      const testDir = createTestDir();
      const filePath = join(testDir, 'index.js');

      // Initial version with multiple variables
      writeFileSync(filePath, `
        const a = 1;
        const b = 2;
        const c = 3;
      `);

      // Use forceAnalysis to bypass caching and test clear-and-rebuild
      const orchestrator = createForcedOrchestrator(backend);
      await orchestrator.run(testDir);

      const vars1 = await backend.getAllNodes({ type: 'CONSTANT' });
      const fileVars1 = vars1.filter(v => v.file && v.file.includes('index.js'));
      assert.strictEqual(fileVars1.length, 3, 'Should have 3 constants initially');

      // Modified version - keep only 'a'
      writeFileSync(filePath, `
        const a = 1;
      `);
      await orchestrator.run(testDir);

      const vars2 = await backend.getAllNodes({ type: 'CONSTANT' });
      const fileVars2 = vars2.filter(v => v.file && v.file.includes('index.js'));

      assert.strictEqual(fileVars2.length, 1,
        `Should have 1 constant after deletion, got ${fileVars2.length}`);
      assert.strictEqual(fileVars2[0].name, 'a',
        'Remaining constant should be "a"');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty file correctly', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), ``);

      // Use forceAnalysis to bypass caching and test clear-and-rebuild
      const orchestrator = createForcedOrchestrator(backend);

      // First analysis of empty file
      await orchestrator.run(testDir);
      const count1 = await backend.nodeCount();

      // Second analysis
      await orchestrator.run(testDir);
      const count2 = await backend.nodeCount();

      assert.strictEqual(count2, count1,
        'Empty file should produce stable node count');
    });

    it('should handle file with only imports', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), `
        import React from 'react';
        import { useState, useEffect } from 'react';
      `);

      // Use forceAnalysis to bypass caching and test clear-and-rebuild
      const orchestrator = createForcedOrchestrator(backend);

      // First analysis
      await orchestrator.run(testDir);
      const imports1 = await backend.getAllNodes({ type: 'IMPORT' });
      const importCount1 = imports1.length;

      // Second analysis
      await orchestrator.run(testDir);
      const imports2 = await backend.getAllNodes({ type: 'IMPORT' });
      const importCount2 = imports2.length;

      assert.strictEqual(importCount2, importCount1,
        `Import count should be stable. First: ${importCount1}, Second: ${importCount2}`);
    });

    it('should handle multiple files correctly', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'a.js'), `export const a = 1;`);
      writeFileSync(join(testDir, 'b.js'), `export const b = 2;`);
      writeFileSync(join(testDir, 'c.js'), `export const c = 3;`);

      // Use forceAnalysis to bypass caching and test clear-and-rebuild
      const orchestrator = createForcedOrchestrator(backend);

      // First analysis
      await orchestrator.run(testDir);
      const count1 = await backend.nodeCount();

      // Second analysis
      await orchestrator.run(testDir);
      const count2 = await backend.nodeCount();

      assert.strictEqual(count2, count1,
        `Node count should be stable with multiple files. First: ${count1}, Second: ${count2}`);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle class declarations correctly on re-analysis', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), `
        class MyClass {
          constructor() {
            this.value = 1;
          }
          getValue() {
            return this.value;
          }
        }
      `);

      // Use forceAnalysis to bypass caching and test clear-and-rebuild
      const orchestrator = createForcedOrchestrator(backend);

      // First analysis
      await orchestrator.run(testDir);
      const classes1 = await backend.getAllNodes({ type: 'CLASS' });
      const classCount1 = classes1.filter(c => c.file && c.file.includes('index.js')).length;

      // Second analysis
      await orchestrator.run(testDir);
      const classes2 = await backend.getAllNodes({ type: 'CLASS' });
      const classCount2 = classes2.filter(c => c.file && c.file.includes('index.js')).length;

      assert.strictEqual(classCount2, classCount1,
        `Class count should be stable. First: ${classCount1}, Second: ${classCount2}`);
    });

    it('should handle interface declarations (TypeScript) on re-analysis', async () => {
      const testDir = createTestDir();
      writeFileSync(join(testDir, 'types.ts'), `
        interface User {
          id: string;
          name: string;
        }
        interface Admin extends User {
          permissions: string[];
        }
      `);

      // Use forceAnalysis to bypass caching and test clear-and-rebuild
      const orchestrator = createForcedOrchestrator(backend);

      // First analysis
      await orchestrator.run(testDir);
      const interfaces1 = await backend.getAllNodes({ type: 'INTERFACE' });
      const ifaceCount1 = interfaces1.filter(i => i.file && i.file.includes('types.ts')).length;

      // Second analysis
      await orchestrator.run(testDir);
      const interfaces2 = await backend.getAllNodes({ type: 'INTERFACE' });
      const ifaceCount2 = interfaces2.filter(i => i.file && i.file.includes('types.ts')).length;

      assert.strictEqual(ifaceCount2, ifaceCount1,
        `Interface count should be stable. First: ${ifaceCount1}, Second: ${ifaceCount2}`);
    });
  });
});
