/**
 * Delete/Update Expression Edges Tests (REG-602)
 *
 * Tests for two fixes:
 * 1. `delete obj.prop` — should create WRITES_TO edge to root variable, not scope_lookup on property name
 * 2. `obj.prop++` / `obj.prop--` — should create WRITES_TO edge to root variable (currently missing)
 *
 * Edge direction: EXPRESSION(delete/++/--) --WRITES_TO--> root VARIABLE/PARAMETER
 *
 * This enables tracing mutation data flow:
 * - Query: "What variables does this delete/update modify?"
 * - Answer: Follow WRITES_TO edges from the expression to see affected variables
 *
 * Test cases:
 *  1. delete obj.prop — basic member expression delete
 *  2. delete obj[key] — computed member expression delete
 *  3. delete obj?.prop — optional member expression delete
 *  4. delete a.b.c — nested member expression, targets root variable `a`
 *  5. delete this.prop — no WRITES_TO expected (this is not a variable)
 *  6. No scope_lookup on property name — regression test
 *  7. obj.prop++ — member expression update
 *  8. obj[key]-- — computed member expression update
 *  9. this.x++ — no WRITES_TO expected (this is not a variable)
 * 10. a.b.c++ — nested member expression update, targets root `a`
 * 11. i++ — plain identifier update (unchanged behavior, regression guard)
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

describe('Delete/Update Expression Edges (REG-602)', () => {
  let db;
  let backend;
  let testDir;
  let testCounter = 0;

  /**
   * Create a temporary test directory with specified files
   */
  async function setupTest(files) {
    testDir = join(tmpdir(), `grafema-test-delete-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    // Create package.json to make it a valid project
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-delete-${testCounter}`, type: 'module' })
    );

    // Write test files
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }

    return testDir;
  }

  /**
   * Clean up test directory
   */
  function cleanupTestDir() {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      testDir = null;
    }
  }

  beforeEach(async () => {
    if (db) await db.cleanup();
    cleanupTestDir();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
    cleanupTestDir();
  });

  describe('Delete expression', () => {
    it('should create WRITES_TO edge for delete obj.prop', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(obj) {
  delete obj.prop;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the delete EXPRESSION node
      const deleteExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'delete');
      assert.ok(deleteExpr, 'EXPRESSION node with name "delete" should exist');

      // Find WRITES_TO edge from delete expression
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === deleteExpr.id
      );
      assert.ok(writesToEdge, 'WRITES_TO edge should exist from delete expression');

      // Target should be the parameter `obj`
      const target = allNodes.find(n => n.id === writesToEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.ok(
        ['VARIABLE', 'PARAMETER'].includes(target.type),
        `Expected VARIABLE or PARAMETER, got ${target.type}`
      );
      assert.strictEqual(target.name, 'obj', 'WRITES_TO should target "obj"');

      // PROPERTY_ACCESS node should exist for obj.prop
      const propAccess = allNodes.find(n => n.type === 'PROPERTY_ACCESS' && n.name === 'obj.prop');
      assert.ok(propAccess, 'PROPERTY_ACCESS node should exist for obj.prop');
    });

    it('should create WRITES_TO edge for delete obj[key]', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(obj, key) {
  delete obj[key];
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the delete EXPRESSION node
      const deleteExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'delete');
      assert.ok(deleteExpr, 'EXPRESSION node with name "delete" should exist');

      // Find WRITES_TO edge from delete expression
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === deleteExpr.id
      );
      assert.ok(writesToEdge, 'WRITES_TO edge should exist from delete expression');

      // Target should be the parameter `obj`
      const target = allNodes.find(n => n.id === writesToEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.ok(
        ['VARIABLE', 'PARAMETER'].includes(target.type),
        `Expected VARIABLE or PARAMETER, got ${target.type}`
      );
      assert.strictEqual(target.name, 'obj', 'WRITES_TO should target "obj"');
    });

    it('should create WRITES_TO edge for delete obj?.prop', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(obj) {
  delete obj?.prop;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the delete EXPRESSION node
      const deleteExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'delete');
      assert.ok(deleteExpr, 'EXPRESSION node with name "delete" should exist');

      // Find WRITES_TO edge from delete expression
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === deleteExpr.id
      );
      assert.ok(writesToEdge, 'WRITES_TO edge should exist from delete expression');

      // Target should be the parameter `obj`
      const target = allNodes.find(n => n.id === writesToEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.ok(
        ['VARIABLE', 'PARAMETER'].includes(target.type),
        `Expected VARIABLE or PARAMETER, got ${target.type}`
      );
      assert.strictEqual(target.name, 'obj', 'WRITES_TO should target "obj"');
    });

    it('should target root variable for delete a.b.c (nested)', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(a) {
  delete a.b.c;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the delete EXPRESSION node
      const deleteExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'delete');
      assert.ok(deleteExpr, 'EXPRESSION node with name "delete" should exist');

      // Find WRITES_TO edge from delete expression
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === deleteExpr.id
      );
      assert.ok(writesToEdge, 'WRITES_TO edge should exist from delete expression');

      // Target should be the root variable `a`, not `b`
      const target = allNodes.find(n => n.id === writesToEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.ok(
        ['VARIABLE', 'PARAMETER'].includes(target.type),
        `Expected VARIABLE or PARAMETER, got ${target.type}`
      );
      assert.strictEqual(target.name, 'a', 'WRITES_TO should target root variable "a", not "b"');
    });

    it('should NOT create WRITES_TO edge for delete this.prop', async () => {
      const projectPath = await setupTest({
        'index.js': `
class C {
  method() {
    delete this.prop;
  }
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the delete EXPRESSION node
      const deleteExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'delete');
      assert.ok(deleteExpr, 'EXPRESSION node with name "delete" should exist');

      // There should be NO WRITES_TO edge from the delete expression
      // because `this` is not a variable/parameter
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === deleteExpr.id
      );
      assert.strictEqual(
        writesToEdge,
        undefined,
        'No WRITES_TO edge should exist for delete this.prop (this is not a variable)'
      );
    });

    it('should NOT create edge from delete expression to shadowing variable with same name as property', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(obj) {
  const prop = 1;
  delete obj.prop;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the delete EXPRESSION node
      const deleteExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'delete');
      assert.ok(deleteExpr, 'EXPRESSION node with name "delete" should exist');

      // Find the local variable `prop`
      const propVar = allNodes.find(n =>
        (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'prop'
      );
      assert.ok(propVar, 'Variable "prop" should exist');

      // There should be NO edge of any type from the delete expression to the `prop` variable
      // The property name in `obj.prop` is NOT a scope lookup — it's a property access
      const edgeToProp = allEdges.find(e =>
        e.src === deleteExpr.id && e.dst === propVar.id
      );
      assert.strictEqual(
        edgeToProp,
        undefined,
        'No edge should exist from delete expression to variable "prop" — property name is not a scope lookup'
      );

      // But WRITES_TO should still target `obj`
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === deleteExpr.id
      );
      assert.ok(writesToEdge, 'WRITES_TO edge should exist from delete expression');

      const target = allNodes.find(n => n.id === writesToEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.strictEqual(target.name, 'obj', 'WRITES_TO should target "obj", not "prop"');
    });
  });

  describe('Update expression (++/--)', () => {
    it('should create WRITES_TO edge for obj.prop++', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(obj) {
  obj.prop++;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the ++ EXPRESSION node
      const updateExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === '++');
      assert.ok(updateExpr, 'EXPRESSION node with name "++" should exist');

      // Find WRITES_TO edge from update expression
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === updateExpr.id
      );
      assert.ok(writesToEdge, 'WRITES_TO edge should exist from ++ expression');

      // Target should be the parameter `obj`
      const target = allNodes.find(n => n.id === writesToEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.ok(
        ['VARIABLE', 'PARAMETER'].includes(target.type),
        `Expected VARIABLE or PARAMETER, got ${target.type}`
      );
      assert.strictEqual(target.name, 'obj', 'WRITES_TO should target "obj"');
    });

    it('should create WRITES_TO edge for obj[key]--', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(obj, key) {
  obj[key]--;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the -- EXPRESSION node
      const updateExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === '--');
      assert.ok(updateExpr, 'EXPRESSION node with name "--" should exist');

      // Find WRITES_TO edge from update expression
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === updateExpr.id
      );
      assert.ok(writesToEdge, 'WRITES_TO edge should exist from -- expression');

      // Target should be the parameter `obj`
      const target = allNodes.find(n => n.id === writesToEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.ok(
        ['VARIABLE', 'PARAMETER'].includes(target.type),
        `Expected VARIABLE or PARAMETER, got ${target.type}`
      );
      assert.strictEqual(target.name, 'obj', 'WRITES_TO should target "obj"');
    });

    it('should NOT create WRITES_TO edge for this.x++', async () => {
      const projectPath = await setupTest({
        'index.js': `
class C {
  method() {
    this.x++;
  }
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the ++ EXPRESSION node
      const updateExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === '++');
      assert.ok(updateExpr, 'EXPRESSION node with name "++" should exist');

      // There should be NO WRITES_TO edge from the ++ expression
      // because `this` is not a variable/parameter
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === updateExpr.id
      );
      assert.strictEqual(
        writesToEdge,
        undefined,
        'No WRITES_TO edge should exist for this.x++ (this is not a variable)'
      );
    });

    it('should target root variable for a.b.c++ (nested)', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(a) {
  a.b.c++;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the ++ EXPRESSION node
      const updateExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === '++');
      assert.ok(updateExpr, 'EXPRESSION node with name "++" should exist');

      // Find WRITES_TO edge from update expression
      const writesToEdge = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === updateExpr.id
      );
      assert.ok(writesToEdge, 'WRITES_TO edge should exist from ++ expression');

      // Target should be the root variable `a`, not `b`
      const target = allNodes.find(n => n.id === writesToEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.ok(
        ['VARIABLE', 'PARAMETER'].includes(target.type),
        `Expected VARIABLE or PARAMETER, got ${target.type}`
      );
      assert.strictEqual(target.name, 'a', 'WRITES_TO should target root variable "a", not "b"');
    });

    it('should create MODIFIES edge for plain i++ (regression guard)', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f() {
  let i = 0;
  i++;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the ++ EXPRESSION node
      const updateExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === '++');
      assert.ok(updateExpr, 'EXPRESSION node with name "++" should exist');

      // Find the variable `i`
      const iVar = allNodes.find(n => n.type === 'VARIABLE' && n.name === 'i');
      assert.ok(iVar, 'Variable "i" should exist');

      // MODIFIES edge should exist from ++ to variable i
      const modifiesEdge = allEdges.find(e =>
        e.type === 'MODIFIES' && e.src === updateExpr.id && e.dst === iVar.id
      );
      assert.ok(
        modifiesEdge,
        'MODIFIES edge should exist from ++ expression to variable "i" (plain identifier update)'
      );
    });
  });
});
