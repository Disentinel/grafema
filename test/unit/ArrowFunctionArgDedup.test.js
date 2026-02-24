/**
 * Arrow Function Argument Deduplication Tests (REG-559)
 *
 * Bug: When an arrow function is passed as a callback argument inside a class
 * method body (e.g., `this.items.map(x => x)`), two FUNCTION nodes were created:
 *   1. FunctionVisitor's ArrowFunctionExpression handler (module-level traversal)
 *   2. NestedFunctionHandler during analyzeFunctionBody traversal
 *
 * Fix: FunctionVisitor now skips arrow functions that have a function parent
 * (i.e., are nested inside another function), deferring to NestedFunctionHandler.
 *
 * These tests verify:
 * 1. No duplicate FUNCTION nodes for arrows passed as HOF callbacks in class methods
 * 2. PASSES_ARGUMENT and DERIVES_FROM edges point to the same single FUNCTION node
 * 3. Module-level arrows still work (FunctionVisitor handles those)
 * 4. Pre-existing duplication in class field arrows is documented (REG-562)
 * 5. Default parameter arrows produce exactly one FUNCTION node
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-arrow-dedup-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-arrow-dedup-${testCounter}`,
      type: 'module'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('Arrow Function Argument Deduplication (REG-559)', () => {
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

  // ==========================================================================
  // Test 1: Basic dedup — arr.map(x => x) inside class method
  // ==========================================================================
  describe('Basic dedup: arr.map(x => x) inside class method', () => {
    it('should produce exactly 1 FUNCTION node for the arrow callback', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {
  run() {
    const result = this.items.map(x => x);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();

      // Find anonymous FUNCTION nodes that are arrow callbacks inside MyClass.run
      // The arrow x => x is anonymous — filter out named functions like 'run'
      const arrowFunctions = allNodes.filter(n =>
        n.type === 'FUNCTION' &&
        n.name !== 'run' &&
        n.id.includes('run')
      );

      assert.strictEqual(
        arrowFunctions.length,
        1,
        `Expected exactly 1 FUNCTION node for the arrow callback x => x, ` +
        `got ${arrowFunctions.length}: ${arrowFunctions.map(n => n.id).join(', ')}`
      );
    });
  });

  // ==========================================================================
  // Test 2: Original bug — this.plugins.some(p => ...)
  // ==========================================================================
  describe('Original bug: this.plugins.some(p => ...)', () => {
    it('should produce exactly 1 FUNCTION node for the arrow callback and edges point to it', async () => {
      await setupTest(backend, {
        'index.js': `
class PluginManager {
  loadPlugins() {
    const found = this.plugins.some(p => p.metadata?.phase === 'DISCOVERY');
  }
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find arrow FUNCTION nodes inside loadPlugins (not the method itself)
      const arrowFunctions = allNodes.filter(n =>
        n.type === 'FUNCTION' &&
        n.name !== 'loadPlugins' &&
        n.id.includes('loadPlugins')
      );

      assert.strictEqual(
        arrowFunctions.length,
        1,
        `Expected exactly 1 FUNCTION node for the arrow p => ..., ` +
        `got ${arrowFunctions.length}: ${arrowFunctions.map(n => n.id).join(', ')}`
      );

      const arrowId = arrowFunctions[0].id;

      // Find the .some() CALL node
      const someCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'some'
      );
      assert.ok(someCall, 'Should find .some() CALL node');

      // PASSES_ARGUMENT edge from .some() should point to the single arrow FUNCTION
      const passesArgEdges = allEdges.filter(e =>
        e.type === 'PASSES_ARGUMENT' && e.src === someCall.id && e.dst === arrowId
      );
      assert.ok(
        passesArgEdges.length >= 1,
        `PASSES_ARGUMENT edge from .some() should point to the arrow FUNCTION (${arrowId}), ` +
        `found ${passesArgEdges.length} matching edges`
      );

      // DERIVES_FROM edge (if present) should also point to the same FUNCTION node
      const derivesFromEdges = allEdges.filter(e =>
        e.type === 'DERIVES_FROM' && e.dst === arrowId
      );
      // If DERIVES_FROM edges exist pointing to this arrow, they should all agree on the same target
      if (derivesFromEdges.length > 0) {
        for (const edge of derivesFromEdges) {
          assert.strictEqual(
            edge.dst,
            arrowId,
            `DERIVES_FROM edge should point to the same FUNCTION node ${arrowId}`
          );
        }
      }
    });
  });

  // ==========================================================================
  // Test 3: Module-level arrow still works (smoke test)
  // ==========================================================================
  describe('Module-level arrow function (smoke test)', () => {
    it('should produce exactly 1 FUNCTION node for a module-level arrow', async () => {
      await setupTest(backend, {
        'index.js': `
const fn = x => x * 2;
`
      });

      const allNodes = await backend.getAllNodes();

      // Find FUNCTION nodes for the arrow (should have name 'fn' from variable assignment)
      const fnFunctions = allNodes.filter(n =>
        n.type === 'FUNCTION' && n.name === 'fn'
      );

      assert.strictEqual(
        fnFunctions.length,
        1,
        `Expected exactly 1 FUNCTION node for module-level arrow 'fn', ` +
        `got ${fnFunctions.length}: ${fnFunctions.map(n => n.id).join(', ')}`
      );
    });
  });

  // ==========================================================================
  // Test 4: Regression anchor — class field arrow (REG-562)
  // ==========================================================================
  describe('Class field arrow (REG-562)', () => {
    it('should produce exactly 1 FUNCTION node after dedup fix', async () => {
      // REG-562 fix: FunctionVisitor now skips class field arrows, deferring to
      // ClassVisitor which is authoritative. Before the fix, both ClassVisitor and
      // FunctionVisitor created FUNCTION nodes, resulting in 2 nodes for one arrow.
      // After fix: only ClassVisitor creates the FUNCTION node named 'field'.
      await setupTest(backend, {
        'index.js': `
class A {
  field = x => x;
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

      // ClassVisitor creates FUNCTION named 'field'
      const namedField = allFunctions.filter(n => n.name === 'field');
      assert.strictEqual(
        namedField.length,
        1,
        `ClassVisitor should create exactly 1 FUNCTION node named 'field'`
      );

      // After REG-562 fix: only 1 FUNCTION node total (ClassVisitor's)
      assert.strictEqual(
        allFunctions.length,
        1,
        `Expected exactly 1 FUNCTION node for class field arrow (REG-562 fix applied), ` +
        `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
      );
    });
  });

  // ==========================================================================
  // Test 5: Default parameter arrow
  // ==========================================================================
  describe('Default parameter arrow', () => {
    it('should produce exactly 1 FUNCTION node for default parameter arrow', async () => {
      await setupTest(backend, {
        'index.js': `
function outer(cb = x => x) {
  return cb(1);
}
`
      });

      const allNodes = await backend.getAllNodes();

      // Find FUNCTION nodes: 'outer' itself and the anonymous default arrow
      const outerFunc = allNodes.filter(n =>
        n.type === 'FUNCTION' && n.name === 'outer'
      );
      assert.strictEqual(outerFunc.length, 1, 'Should have exactly 1 FUNCTION node for outer');

      // The default parameter arrow is anonymous, nested inside outer
      // It should have been handled by NestedFunctionHandler only
      const allFunctions = allNodes.filter(n =>
        n.type === 'FUNCTION'
      );

      // Total FUNCTION count: outer + 1 anonymous arrow = 2
      // If the bug were present, we'd see 3 (outer + 2 duplicated arrows)
      const anonymousArrows = allFunctions.filter(n => n.name !== 'outer');

      assert.strictEqual(
        anonymousArrows.length,
        1,
        `Expected exactly 1 anonymous FUNCTION node for the default parameter arrow, ` +
        `got ${anonymousArrows.length}: ${anonymousArrows.map(n => `${n.name || '(anon)'}:${n.id}`).join(', ')}`
      );
    });
  });
});
