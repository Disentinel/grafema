/**
 * Tests for PASSES_ARGUMENT edges on CALL nodes (REG-532, v2 migration)
 *
 * V2 migration: DERIVES_FROM edges on CALL/CONSTRUCTOR_CALL nodes no longer exist.
 * V2 uses PASSES_ARGUMENT edges instead for connecting calls to their arguments.
 * CONSTRUCTOR_CALL type no longer exists - replaced by CALL with isNew:true.
 *
 * PASSES_ARGUMENT edges connect:
 *   CALL node -> PASSES_ARGUMENT -> argument source (VARIABLE, LITERAL, etc.)
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
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `test-derives-from-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-derives-from-${testCounter}`,
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
 * Helper: find CALL nodes by name via Datalog, return their IDs
 */
async function findCallNodeIds(backend, name) {
  const results = await backend.checkGuarantee(`
    violation(X) :- node(X, "CALL"), attr(X, "name", "${name}").
  `);
  return results.map(r => r.bindings.find(b => b.name === 'X')?.value).filter(Boolean);
}

/**
 * Helper: find CALL nodes by method name via Datalog, return their IDs
 */
async function findMethodCallNodeIds(backend, method) {
  const results = await backend.checkGuarantee(`
    violation(X) :- node(X, "CALL"), attr(X, "method", "${method}").
  `);
  return results.map(r => r.bindings.find(b => b.name === 'X')?.value).filter(Boolean);
}

/**
 * V2 helper: find constructor call nodes (CALL with isNew:true) by class name
 */
async function findConstructorCallNodeIds(backend, className) {
  // V2: constructor calls are CALL with isNew=true and name="new ClassName"
  const results = await backend.checkGuarantee(`
    violation(X) :- node(X, "CALL"), attr(X, "isNew", "true"), attr(X, "name", "new ${className}").
  `);
  return results.map(r => r.bindings.find(b => b.name === 'X')?.value).filter(Boolean);
}

describe('PASSES_ARGUMENT edges on CALL nodes (REG-532, v2)', () => {
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
  // CALL nodes with arguments - check PASSES_ARGUMENT (DERIVES_FROM removed in v2)
  // ==========================================================================
  describe('CALL with arguments gets PASSES_ARGUMENT edges', () => {
    it('should create PASSES_ARGUMENT edges from CALL to variable arguments', async () => {
      await setupTest(backend, {
        'index.js': `
function add(a, b) { return a + b; }
const x = 1;
const y = 2;
const result = add(x, y);
        `
      });

      const callIds = await findCallNodeIds(backend, 'add');
      assert.ok(callIds.length >= 1, 'Should have at least one add() call');

      const callId = callIds[0];
      const passesArgEdges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`CALL:add has ${passesArgEdges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(passesArgEdges.length, 2, 'CALL:add should have 2 PASSES_ARGUMENT edges (x, y)');

      // Collect target node names
      const targetNames = [];
      for (const edge of passesArgEdges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  PASSES_ARGUMENT -> ${targetNode?.type}:${targetNode?.name}`);
        if (targetNode?.name) {
          targetNames.push(targetNode.name);
        }
      }

      assert.ok(targetNames.includes('x'), 'Should have PASSES_ARGUMENT edge to variable x');
      assert.ok(targetNames.includes('y'), 'Should have PASSES_ARGUMENT edge to variable y');
    });
  });

  describe('CALL with literal arguments gets PASSES_ARGUMENT edges', () => {
    it('should create PASSES_ARGUMENT edges from CALL to literal arguments', async () => {
      await setupTest(backend, {
        'index.js': `
function process(msg, code) { return msg + code; }
const result = process("hello", 42);
        `
      });

      const callIds = await findCallNodeIds(backend, 'process');
      assert.ok(callIds.length >= 1, 'Should have at least one process() call');

      const callId = callIds[0];
      const passesArgEdges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`CALL:process has ${passesArgEdges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(passesArgEdges.length, 2, 'CALL:process should have 2 PASSES_ARGUMENT edges');

      // Verify targets are LITERAL nodes
      let foundStringLiteral = false;
      let foundNumericLiteral = false;

      for (const edge of passesArgEdges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  PASSES_ARGUMENT -> ${targetNode?.type} value=${targetNode?.value}`);

        if (targetNode?.type === 'LITERAL' && targetNode?.value === 'hello') {
          foundStringLiteral = true;
        }
        if (targetNode?.type === 'LITERAL' && targetNode?.value === 42) {
          foundNumericLiteral = true;
        }
      }

      assert.ok(foundStringLiteral, 'Should have PASSES_ARGUMENT edge to LITERAL("hello")');
      assert.ok(foundNumericLiteral, 'Should have PASSES_ARGUMENT edge to LITERAL(42)');
    });
  });

  // ==========================================================================
  // CALL with no arguments (zero-arg call)
  // ==========================================================================
  describe('CALL with no arguments', () => {
    it('should have no PASSES_ARGUMENT edges for zero-arg call', async () => {
      await setupTest(backend, {
        'index.js': `
const ts = Date.now();
        `
      });

      // Date.now() is a method call; find it by method name
      const callIds = await findMethodCallNodeIds(backend, 'now');
      assert.ok(callIds.length >= 1, 'Should have at least one Date.now() call');

      const callId = callIds[0];
      const passesArgEdges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`CALL:Date.now has ${passesArgEdges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(passesArgEdges.length, 0, 'Zero-arg call should have NO PASSES_ARGUMENT edges');
    });
  });

  // ==========================================================================
  // Constructor call (CALL with isNew:true) with arguments
  // ==========================================================================
  describe('Constructor call with arguments gets PASSES_ARGUMENT edges', () => {
    it('should create PASSES_ARGUMENT edge from constructor call to variable argument', async () => {
      await setupTest(backend, {
        'index.js': `
const items = [1, 2, 3];
const s = new Set(items);
        `
      });

      const ctorIds = await findConstructorCallNodeIds(backend, 'Set');
      assert.ok(ctorIds.length >= 1, 'Should have at least one Set constructor call');

      const ctorId = ctorIds[0];
      const passesArgEdges = await backend.getOutgoingEdges(ctorId, ['PASSES_ARGUMENT']);

      console.log(`CALL(isNew):Set has ${passesArgEdges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(passesArgEdges.length, 1, 'CALL(isNew):Set should have 1 PASSES_ARGUMENT edge');

      const targetNode = await backend.getNode(passesArgEdges[0].dst);
      console.log(`  PASSES_ARGUMENT -> ${targetNode?.type}:${targetNode?.name}`);
      assert.strictEqual(targetNode?.name, 'items', 'Should pass argument "items"');
    });

    it('should create PASSES_ARGUMENT edges for constructor with multiple arguments', async () => {
      await setupTest(backend, {
        'index.js': `
class Connection {
  constructor(host, port) {}
}
const host = "localhost";
const port = 3000;
const conn = new Connection(host, port);
        `
      });

      const ctorIds = await findConstructorCallNodeIds(backend, 'Connection');
      assert.ok(ctorIds.length >= 1, 'Should have at least one Connection constructor call');

      const ctorId = ctorIds[0];
      const passesArgEdges = await backend.getOutgoingEdges(ctorId, ['PASSES_ARGUMENT']);

      console.log(`CALL(isNew):Connection has ${passesArgEdges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(passesArgEdges.length, 2, 'CALL(isNew):Connection should have 2 PASSES_ARGUMENT edges');

      const targetNames = [];
      for (const edge of passesArgEdges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  PASSES_ARGUMENT -> ${targetNode?.type}:${targetNode?.name}`);
        if (targetNode?.name) {
          targetNames.push(targetNode.name);
        }
      }

      assert.ok(targetNames.includes('host'), 'Should have PASSES_ARGUMENT edge to variable "host"');
      assert.ok(targetNames.includes('port'), 'Should have PASSES_ARGUMENT edge to variable "port"');
    });
  });

  // ==========================================================================
  // Constructor call with no arguments
  // ==========================================================================
  describe('Constructor call with no arguments', () => {
    it('should have no PASSES_ARGUMENT edges for zero-arg constructor', async () => {
      await setupTest(backend, {
        'index.js': `
const s = new Set();
        `
      });

      const ctorIds = await findConstructorCallNodeIds(backend, 'Set');
      assert.ok(ctorIds.length >= 1, 'Should have at least one Set constructor call');

      const ctorId = ctorIds[0];
      const passesArgEdges = await backend.getOutgoingEdges(ctorId, ['PASSES_ARGUMENT']);

      console.log(`CALL(isNew):Set (no args) has ${passesArgEdges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(passesArgEdges.length, 0, 'Zero-arg constructor should have NO PASSES_ARGUMENT edges');
    });
  });

  // ==========================================================================
  // Method call with arguments
  // ==========================================================================
  describe('Method call with arguments gets PASSES_ARGUMENT edges', () => {
    it('should create PASSES_ARGUMENT edges for method call arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const output = "hello";
const padded = output.padEnd(10, ' ');
        `
      });

      const callIds = await findMethodCallNodeIds(backend, 'padEnd');
      assert.ok(callIds.length >= 1, 'Should have at least one output.padEnd() call');

      const callId = callIds[0];
      const passesArgEdges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`CALL:output.padEnd has ${passesArgEdges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(passesArgEdges.length, 2, 'Method call should have 2 PASSES_ARGUMENT edges (10 and " ")');

      let foundNumericLiteral = false;
      let foundStringLiteral = false;

      for (const edge of passesArgEdges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  PASSES_ARGUMENT -> ${targetNode?.type} value=${targetNode?.value}`);

        if (targetNode?.type === 'LITERAL' && targetNode?.value === 10) {
          foundNumericLiteral = true;
        }
        if (targetNode?.type === 'LITERAL' && targetNode?.value === ' ') {
          foundStringLiteral = true;
        }
      }

      assert.ok(foundNumericLiteral, 'Should have PASSES_ARGUMENT edge to LITERAL(10)');
      assert.ok(foundStringLiteral, 'Should have PASSES_ARGUMENT edge to LITERAL(" ")');
    });
  });

  // ==========================================================================
  // PASSES_ARGUMENT for calls with arguments
  // ==========================================================================
  describe('PASSES_ARGUMENT edges work for all call types', () => {
    it('should have PASSES_ARGUMENT edges for regular function call with args', async () => {
      await setupTest(backend, {
        'index.js': `
function process(a, b) { return a + b; }
const x = 10;
const y = 20;
const result = process(x, y);
        `
      });

      const callIds = await findCallNodeIds(backend, 'process');
      assert.ok(callIds.length >= 1, 'Should have at least one process() call');

      const callId = callIds[0];

      // Check PASSES_ARGUMENT edges
      const passesArgEdges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);
      console.log(`CALL:process has ${passesArgEdges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(passesArgEdges.length, 2, 'Should have 2 PASSES_ARGUMENT edges');

      // Verify targets are x and y
      const targetNames = [];
      for (const edge of passesArgEdges) {
        const targetNode = await backend.getNode(edge.dst);
        if (targetNode?.name) {
          targetNames.push(targetNode.name);
        }
      }

      assert.ok(targetNames.includes('x'), 'PASSES_ARGUMENT should point to variable x');
      assert.ok(targetNames.includes('y'), 'PASSES_ARGUMENT should point to variable y');
    });

    it('should have PASSES_ARGUMENT for constructor call with arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const entries = [["a", 1]];
const m = new Map(entries);
        `
      });

      const ctorIds = await findConstructorCallNodeIds(backend, 'Map');
      assert.ok(ctorIds.length >= 1, 'Should have at least one Map constructor call');

      const ctorId = ctorIds[0];

      // Check PASSES_ARGUMENT edge
      const passesArgEdges = await backend.getOutgoingEdges(ctorId, ['PASSES_ARGUMENT']);
      console.log(`CALL(isNew):Map has ${passesArgEdges.length} PASSES_ARGUMENT edges`);

      assert.strictEqual(passesArgEdges.length, 1, 'Should have 1 PASSES_ARGUMENT edge');

      // Should point to "entries"
      const passesArgTarget = await backend.getNode(passesArgEdges[0].dst);
      assert.strictEqual(passesArgTarget?.name, 'entries', 'PASSES_ARGUMENT should target entries');
    });
  });
});
