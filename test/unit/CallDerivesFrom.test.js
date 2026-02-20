/**
 * Tests for DERIVES_FROM edges on CALL and CONSTRUCTOR_CALL nodes (REG-532)
 *
 * DERIVES_FROM edges connect:
 *   CALL/CONSTRUCTOR_CALL node -> DERIVES_FROM -> argument source (VARIABLE, LITERAL, etc.)
 *
 * These edges indicate that a call's result is derived from its arguments,
 * enabling data flow tracking through function calls. They coexist with
 * PASSES_ARGUMENT edges (which track argument passing for parameter resolution).
 *
 * Bug context:
 *   - CALL nodes were missing DERIVES_FROM edges to their arguments
 *   - CONSTRUCTOR_CALL nodes were missing argument extraction entirely
 *   - DataFlowValidator had a type string mismatch preventing proper validation
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
 * Helper: find CONSTRUCTOR_CALL nodes by className via Datalog, return their IDs
 */
async function findConstructorCallNodeIds(backend, className) {
  const results = await backend.checkGuarantee(`
    violation(X) :- node(X, "CONSTRUCTOR_CALL"), attr(X, "className", "${className}").
  `);
  return results.map(r => r.bindings.find(b => b.name === 'X')?.value).filter(Boolean);
}

describe('DERIVES_FROM edges on CALL and CONSTRUCTOR_CALL nodes (REG-532)', () => {
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
  // CALL nodes with arguments
  // ==========================================================================
  describe('CALL with arguments gets DERIVES_FROM edges', () => {
    it('should create DERIVES_FROM edges from CALL to variable arguments', async () => {
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
      const derivesEdges = await backend.getOutgoingEdges(callId, ['DERIVES_FROM']);

      console.log(`CALL:add has ${derivesEdges.length} DERIVES_FROM edges`);
      assert.strictEqual(derivesEdges.length, 2, 'CALL:add should have 2 DERIVES_FROM edges (x, y)');

      // Collect target node names
      const targetNames = [];
      for (const edge of derivesEdges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  DERIVES_FROM -> ${targetNode?.type}:${targetNode?.name}`);
        if (targetNode?.name) {
          targetNames.push(targetNode.name);
        }
      }

      assert.ok(targetNames.includes('x'), 'Should have DERIVES_FROM edge to variable x');
      assert.ok(targetNames.includes('y'), 'Should have DERIVES_FROM edge to variable y');
    });
  });

  describe('CALL with literal arguments gets DERIVES_FROM edges', () => {
    it('should create DERIVES_FROM edges from CALL to literal arguments', async () => {
      await setupTest(backend, {
        'index.js': `
function process(msg, code) { return msg + code; }
const result = process("hello", 42);
        `
      });

      const callIds = await findCallNodeIds(backend, 'process');
      assert.ok(callIds.length >= 1, 'Should have at least one process() call');

      const callId = callIds[0];
      const derivesEdges = await backend.getOutgoingEdges(callId, ['DERIVES_FROM']);

      console.log(`CALL:process has ${derivesEdges.length} DERIVES_FROM edges`);
      assert.strictEqual(derivesEdges.length, 2, 'CALL:process should have 2 DERIVES_FROM edges');

      // Verify targets are LITERAL nodes
      let foundStringLiteral = false;
      let foundNumericLiteral = false;

      for (const edge of derivesEdges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  DERIVES_FROM -> ${targetNode?.type} value=${targetNode?.value}`);

        if (targetNode?.type === 'LITERAL' && targetNode?.value === 'hello') {
          foundStringLiteral = true;
        }
        if (targetNode?.type === 'LITERAL' && targetNode?.value === 42) {
          foundNumericLiteral = true;
        }
      }

      assert.ok(foundStringLiteral, 'Should have DERIVES_FROM edge to LITERAL("hello")');
      assert.ok(foundNumericLiteral, 'Should have DERIVES_FROM edge to LITERAL(42)');
    });
  });

  // ==========================================================================
  // CALL with no arguments (zero-arg call)
  // ==========================================================================
  describe('CALL with no arguments', () => {
    it('should have no DERIVES_FROM edges for zero-arg call', async () => {
      await setupTest(backend, {
        'index.js': `
const ts = Date.now();
        `
      });

      // Date.now() is a method call; find it by method name
      const callIds = await findMethodCallNodeIds(backend, 'now');
      assert.ok(callIds.length >= 1, 'Should have at least one Date.now() call');

      const callId = callIds[0];
      const derivesEdges = await backend.getOutgoingEdges(callId, ['DERIVES_FROM']);

      console.log(`CALL:Date.now has ${derivesEdges.length} DERIVES_FROM edges`);
      assert.strictEqual(derivesEdges.length, 0, 'Zero-arg call should have NO DERIVES_FROM edges');
    });
  });

  // ==========================================================================
  // CONSTRUCTOR_CALL with arguments
  // ==========================================================================
  describe('CONSTRUCTOR_CALL with arguments gets DERIVES_FROM edges', () => {
    it('should create DERIVES_FROM edge from CONSTRUCTOR_CALL to variable argument', async () => {
      await setupTest(backend, {
        'index.js': `
const items = [1, 2, 3];
const s = new Set(items);
        `
      });

      const ctorIds = await findConstructorCallNodeIds(backend, 'Set');
      assert.ok(ctorIds.length >= 1, 'Should have at least one Set constructor call');

      const ctorId = ctorIds[0];
      const derivesEdges = await backend.getOutgoingEdges(ctorId, ['DERIVES_FROM']);

      console.log(`CONSTRUCTOR_CALL:Set has ${derivesEdges.length} DERIVES_FROM edges`);
      assert.strictEqual(derivesEdges.length, 1, 'CONSTRUCTOR_CALL:Set should have 1 DERIVES_FROM edge');

      const targetNode = await backend.getNode(derivesEdges[0].dst);
      console.log(`  DERIVES_FROM -> ${targetNode?.type}:${targetNode?.name}`);
      assert.strictEqual(targetNode?.name, 'items', 'Should derive from variable "items"');
    });

    it('should create DERIVES_FROM edges for constructor with multiple arguments', async () => {
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
      const derivesEdges = await backend.getOutgoingEdges(ctorId, ['DERIVES_FROM']);

      console.log(`CONSTRUCTOR_CALL:Connection has ${derivesEdges.length} DERIVES_FROM edges`);
      assert.strictEqual(derivesEdges.length, 2, 'CONSTRUCTOR_CALL:Connection should have 2 DERIVES_FROM edges');

      const targetNames = [];
      for (const edge of derivesEdges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  DERIVES_FROM -> ${targetNode?.type}:${targetNode?.name}`);
        if (targetNode?.name) {
          targetNames.push(targetNode.name);
        }
      }

      assert.ok(targetNames.includes('host'), 'Should have DERIVES_FROM edge to variable "host"');
      assert.ok(targetNames.includes('port'), 'Should have DERIVES_FROM edge to variable "port"');
    });
  });

  // ==========================================================================
  // CONSTRUCTOR_CALL with no arguments
  // ==========================================================================
  describe('CONSTRUCTOR_CALL with no arguments', () => {
    it('should have no DERIVES_FROM edges for zero-arg constructor', async () => {
      await setupTest(backend, {
        'index.js': `
const s = new Set();
        `
      });

      const ctorIds = await findConstructorCallNodeIds(backend, 'Set');
      assert.ok(ctorIds.length >= 1, 'Should have at least one Set constructor call');

      const ctorId = ctorIds[0];
      const derivesEdges = await backend.getOutgoingEdges(ctorId, ['DERIVES_FROM']);

      console.log(`CONSTRUCTOR_CALL:Set (no args) has ${derivesEdges.length} DERIVES_FROM edges`);
      assert.strictEqual(derivesEdges.length, 0, 'Zero-arg constructor should have NO DERIVES_FROM edges');
    });
  });

  // ==========================================================================
  // Method call with arguments
  // ==========================================================================
  describe('Method call with arguments gets DERIVES_FROM edges', () => {
    it('should create DERIVES_FROM edges for method call arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const output = "hello";
const padded = output.padEnd(10, ' ');
        `
      });

      const callIds = await findMethodCallNodeIds(backend, 'padEnd');
      assert.ok(callIds.length >= 1, 'Should have at least one output.padEnd() call');

      const callId = callIds[0];
      const derivesEdges = await backend.getOutgoingEdges(callId, ['DERIVES_FROM']);

      console.log(`CALL:output.padEnd has ${derivesEdges.length} DERIVES_FROM edges`);
      assert.strictEqual(derivesEdges.length, 2, 'Method call should have 2 DERIVES_FROM edges (10 and " ")');

      let foundNumericLiteral = false;
      let foundStringLiteral = false;

      for (const edge of derivesEdges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  DERIVES_FROM -> ${targetNode?.type} value=${targetNode?.value}`);

        if (targetNode?.type === 'LITERAL' && targetNode?.value === 10) {
          foundNumericLiteral = true;
        }
        if (targetNode?.type === 'LITERAL' && targetNode?.value === ' ') {
          foundStringLiteral = true;
        }
      }

      assert.ok(foundNumericLiteral, 'Should have DERIVES_FROM edge to LITERAL(10)');
      assert.ok(foundStringLiteral, 'Should have DERIVES_FROM edge to LITERAL(" ")');
    });
  });

  // ==========================================================================
  // PASSES_ARGUMENT and DERIVES_FROM coexistence
  // ==========================================================================
  describe('Both PASSES_ARGUMENT and DERIVES_FROM coexist', () => {
    it('should have both PASSES_ARGUMENT and DERIVES_FROM edges to same argument targets', async () => {
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

      // Check DERIVES_FROM edges
      const derivesFromEdges = await backend.getOutgoingEdges(callId, ['DERIVES_FROM']);
      console.log(`CALL:process has ${derivesFromEdges.length} DERIVES_FROM edges`);
      assert.strictEqual(derivesFromEdges.length, 2, 'Should have 2 DERIVES_FROM edges');

      // Collect destination IDs from both edge types
      const passesArgDsts = new Set(passesArgEdges.map(e => e.dst));
      const derivesFromDsts = new Set(derivesFromEdges.map(e => e.dst));

      // Both edge types should point to the same argument nodes
      for (const dst of derivesFromDsts) {
        assert.ok(
          passesArgDsts.has(dst),
          `DERIVES_FROM target ${dst} should also be a PASSES_ARGUMENT target`
        );
      }

      // Verify targets are x and y
      const targetNames = [];
      for (const edge of derivesFromEdges) {
        const targetNode = await backend.getNode(edge.dst);
        if (targetNode?.name) {
          targetNames.push(targetNode.name);
        }
      }

      assert.ok(targetNames.includes('x'), 'Both edge types should point to variable x');
      assert.ok(targetNames.includes('y'), 'Both edge types should point to variable y');
    });

    it('should have both edge types for CONSTRUCTOR_CALL with arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const entries = [["a", 1]];
const m = new Map(entries);
        `
      });

      const ctorIds = await findConstructorCallNodeIds(backend, 'Map');
      assert.ok(ctorIds.length >= 1, 'Should have at least one Map constructor call');

      const ctorId = ctorIds[0];

      // Check both edge types exist
      const passesArgEdges = await backend.getOutgoingEdges(ctorId, ['PASSES_ARGUMENT']);
      const derivesFromEdges = await backend.getOutgoingEdges(ctorId, ['DERIVES_FROM']);

      console.log(`CONSTRUCTOR_CALL:Map has ${passesArgEdges.length} PASSES_ARGUMENT and ${derivesFromEdges.length} DERIVES_FROM edges`);

      assert.strictEqual(passesArgEdges.length, 1, 'Should have 1 PASSES_ARGUMENT edge');
      assert.strictEqual(derivesFromEdges.length, 1, 'Should have 1 DERIVES_FROM edge');

      // Both should point to "entries"
      const passesArgTarget = await backend.getNode(passesArgEdges[0].dst);
      const derivesFromTarget = await backend.getNode(derivesFromEdges[0].dst);

      assert.strictEqual(passesArgTarget?.name, 'entries', 'PASSES_ARGUMENT should target entries');
      assert.strictEqual(derivesFromTarget?.name, 'entries', 'DERIVES_FROM should target entries');
    });
  });
});
