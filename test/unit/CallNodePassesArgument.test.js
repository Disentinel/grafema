/**
 * Tests for CALL node PASSES_ARGUMENT edges (REG-556)
 *
 * REG-556 fixed gaps where CALL nodes were missing PASSES_ARGUMENT edges:
 *   Gap #1: Direct function calls inside function bodies
 *   Gap #2: Module-level `new Foo(arg)` constructor calls
 *   Gap #3: Function-body `new Foo(arg)` constructor calls
 *
 * PASSES_ARGUMENT edges connect:
 *   CALL/CONSTRUCTOR_CALL node --PASSES_ARGUMENT--> argument source (VARIABLE, LITERAL, EXPRESSION, etc.)
 *
 * These tests verify all gaps are closed and regressions are guarded.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files, run analysis, and return graph access.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-call-passes-arg-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-call-passes-arg-${testCounter}`,
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

/**
 * Helper: find all CALL or CONSTRUCTOR_CALL nodes with a given name attribute.
 */
function findCallNodes(allNodes, name) {
  return allNodes.filter(n =>
    (n.type === 'CALL' || n.type === 'CONSTRUCTOR_CALL') && n.name === name
  );
}

/**
 * Helper: get PASSES_ARGUMENT edges originating from a given node id.
 */
function getPassesArgumentEdges(allEdges, nodeId) {
  return allEdges.filter(e => e.type === 'PASSES_ARGUMENT' && e.src === nodeId);
}

describe('CALL node PASSES_ARGUMENT edges (REG-556)', () => {
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
  // Test 1: Core acceptance criteria
  // ==========================================================================
  describe('Core acceptance: mixed argument types', () => {
    it('should create 3 PASSES_ARGUMENT edges for foo(a, b.c, new X())', async () => {
      await setupTest(backend, {
        'index.js': `
const a = 1;
const b = { c: 2 };
function foo(x, y, z) {}
class X {}
foo(a, b.c, new X());
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CALL node for 'foo'
      const fooCalls = findCallNodes(allNodes, 'foo');
      assert.ok(fooCalls.length >= 1, `Should have CALL node for foo. Found: ${JSON.stringify(fooCalls)}`);

      const fooCallId = fooCalls[0].id;
      const passesArgEdges = getPassesArgumentEdges(allEdges, fooCallId);

      assert.strictEqual(
        passesArgEdges.length, 3,
        `foo(a, b.c, new X()) should have 3 PASSES_ARGUMENT edges, got ${passesArgEdges.length}. ` +
        `Edges from foo CALL: ${JSON.stringify(allEdges.filter(e => e.src === fooCallId))}`
      );

      // Verify argument targets exist and have sensible types
      for (const edge of passesArgEdges) {
        const targetNode = allNodes.find(n => n.id === edge.dst);
        assert.ok(
          targetNode,
          `PASSES_ARGUMENT edge dst ${edge.dst} should point to an existing node`
        );
      }
    });
  });

  // ==========================================================================
  // Test 2: Direct function call inside function body (Gap #1)
  // ==========================================================================
  describe('Function-body direct call (Gap #1)', () => {
    it('should create PASSES_ARGUMENT edge for inner(val) inside outer()', async () => {
      await setupTest(backend, {
        'index.js': `
function outer() {
  const val = 42;
  inner(val);
}
function inner(x) {}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CALL node for 'inner'
      const innerCalls = findCallNodes(allNodes, 'inner');
      assert.ok(
        innerCalls.length >= 1,
        `Should have CALL node for inner. All CALL nodes: ${JSON.stringify(allNodes.filter(n => n.type === 'CALL').map(n => n.name))}`
      );

      const innerCallId = innerCalls[0].id;
      const passesArgEdges = getPassesArgumentEdges(allEdges, innerCallId);

      assert.strictEqual(
        passesArgEdges.length, 1,
        `inner(val) should have 1 PASSES_ARGUMENT edge, got ${passesArgEdges.length}`
      );

      // Verify the target is 'val' variable
      const targetNode = allNodes.find(n => n.id === passesArgEdges[0].dst);
      assert.ok(targetNode, 'Target node should exist');
      assert.strictEqual(
        targetNode.name, 'val',
        `Argument should point to variable 'val', got '${targetNode.name}'`
      );
    });
  });

  // ==========================================================================
  // Test 3: Module-level new Foo(arg) (Gap #2)
  // ==========================================================================
  describe('Module-level constructor call (Gap #2)', () => {
    it('should create PASSES_ARGUMENT edge for new Logger(opts) at module level', async () => {
      await setupTest(backend, {
        'index.js': `
class Logger {}
const opts = { level: 'info' };
const logger = new Logger(opts);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CONSTRUCTOR_CALL node for 'Logger'
      const loggerCalls = allNodes.filter(n =>
        n.type === 'CONSTRUCTOR_CALL' && n.className === 'Logger'
      );
      assert.ok(
        loggerCalls.length >= 1,
        `Should have CONSTRUCTOR_CALL node for Logger. ` +
        `All constructor calls: ${JSON.stringify(allNodes.filter(n => n.type === 'CONSTRUCTOR_CALL'))}`
      );

      const loggerCallId = loggerCalls[0].id;
      const passesArgEdges = getPassesArgumentEdges(allEdges, loggerCallId);

      assert.strictEqual(
        passesArgEdges.length, 1,
        `new Logger(opts) should have 1 PASSES_ARGUMENT edge, got ${passesArgEdges.length}`
      );

      // Verify the target is 'opts' variable
      const targetNode = allNodes.find(n => n.id === passesArgEdges[0].dst);
      assert.ok(targetNode, 'Target node should exist');
      assert.strictEqual(
        targetNode.name, 'opts',
        `Argument should point to variable 'opts', got '${targetNode.name}'`
      );
    });
  });

  // ==========================================================================
  // Test 4: Function-body new Foo(arg) (Gap #3)
  // ==========================================================================
  describe('Function-body constructor call (Gap #3)', () => {
    it('should create PASSES_ARGUMENT edge for new Plugin(config) inside setup()', async () => {
      await setupTest(backend, {
        'index.js': `
class Plugin {}
function setup() {
  const config = {};
  const p = new Plugin(config);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CONSTRUCTOR_CALL node for 'Plugin'
      const pluginCalls = allNodes.filter(n =>
        n.type === 'CONSTRUCTOR_CALL' && n.className === 'Plugin'
      );
      assert.ok(
        pluginCalls.length >= 1,
        `Should have CONSTRUCTOR_CALL node for Plugin. ` +
        `All constructor calls: ${JSON.stringify(allNodes.filter(n => n.type === 'CONSTRUCTOR_CALL'))}`
      );

      const pluginCallId = pluginCalls[0].id;
      const passesArgEdges = getPassesArgumentEdges(allEdges, pluginCallId);

      assert.strictEqual(
        passesArgEdges.length, 1,
        `new Plugin(config) should have 1 PASSES_ARGUMENT edge, got ${passesArgEdges.length}`
      );

      // Verify the target is 'config' variable
      const targetNode = allNodes.find(n => n.id === passesArgEdges[0].dst);
      assert.ok(targetNode, 'Target node should exist');
      assert.strictEqual(
        targetNode.name, 'config',
        `Argument should point to variable 'config', got '${targetNode.name}'`
      );
    });
  });

  // ==========================================================================
  // Test 5: Logical expression argument (regression guard)
  // ==========================================================================
  describe('Expression argument (regression guard)', () => {
    it('should create PASSES_ARGUMENT edge for process(x || y) pointing to EXPRESSION', async () => {
      await setupTest(backend, {
        'index.js': `
function process(val) {}
const x = true;
const y = false;
process(x || y);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CALL node for 'process'
      const processCalls = findCallNodes(allNodes, 'process');
      assert.ok(
        processCalls.length >= 1,
        `Should have CALL node for process. All CALL nodes: ${JSON.stringify(allNodes.filter(n => n.type === 'CALL').map(n => n.name))}`
      );

      const processCallId = processCalls[0].id;
      const passesArgEdges = getPassesArgumentEdges(allEdges, processCallId);

      assert.strictEqual(
        passesArgEdges.length, 1,
        `process(x || y) should have 1 PASSES_ARGUMENT edge, got ${passesArgEdges.length}`
      );

      // Verify the target is an EXPRESSION node
      const targetNode = allNodes.find(n => n.id === passesArgEdges[0].dst);
      assert.ok(targetNode, 'Target node should exist');
      assert.strictEqual(
        targetNode.type, 'EXPRESSION',
        `Argument for logical expression should be EXPRESSION, got '${targetNode.type}'`
      );
    });
  });

  // ==========================================================================
  // Test 6: No arguments -> no PASSES_ARGUMENT edges (regression guard)
  // ==========================================================================
  describe('No arguments (regression guard)', () => {
    it('should create 0 PASSES_ARGUMENT edges for noop()', async () => {
      await setupTest(backend, {
        'index.js': `
function noop() {}
noop();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CALL node for 'noop'
      const noopCalls = findCallNodes(allNodes, 'noop');
      assert.ok(
        noopCalls.length >= 1,
        `Should have CALL node for noop. All CALL nodes: ${JSON.stringify(allNodes.filter(n => n.type === 'CALL').map(n => n.name))}`
      );

      const noopCallId = noopCalls[0].id;
      const passesArgEdges = getPassesArgumentEdges(allEdges, noopCallId);

      assert.strictEqual(
        passesArgEdges.length, 0,
        `noop() with no arguments should have 0 PASSES_ARGUMENT edges, got ${passesArgEdges.length}`
      );
    });
  });
});
