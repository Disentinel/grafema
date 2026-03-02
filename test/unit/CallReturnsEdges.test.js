/**
 * CALL_RETURNS Edges & traceValues Through Function Calls (REG-576)
 *
 * Tests for CALL_RETURNS edge creation and traceValues following through
 * function calls to return values.
 *
 * Edge direction: CALL --CALL_RETURNS--> FUNCTION (the called function)
 * Data flow:      CALL --CALL_RETURNS--> FUNCTION --RETURNS--> value
 *
 * Test cases:
 * 1. CALL_RETURNS edge exists for same-file call
 * 2. No CALL_RETURNS for constructor (target is CLASS)
 * 3. No CALL_RETURNS for unresolved call
 * 4. traceValues: single literal return
 * 5. traceValues: multiple conditional returns
 * 6. traceValues: nested calls (a → b → value)
 * 7. traceValues: implicit undefined (no return statement)
 * 8. traceValues: followCallReturns=false opt-out
 * 9. Cycle protection (recursive function)
 * 10. Cross-file call through import
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { traceValues, aggregateValues } from '@grafema/core';

after(cleanupAllTestDatabases);

describe('CALL_RETURNS Edges (REG-576)', () => {
  let db;
  let backend;
  let testDir;
  let testCounter = 0;

  async function setupTest(files) {
    testDir = join(tmpdir(), `grafema-test-call-returns-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-call-returns-${testCounter}`, type: 'module' })
    );

    for (const [filename, content] of Object.entries(files)) {
      const filePath = join(testDir, filename);
      const dir = join(filePath, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, content);
    }

    return testDir;
  }

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

  // ─── Edge creation tests ────────────────────────────────────────────

  describe('Edge creation', () => {
    it('should create CALL_RETURNS edge for same-file function call', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f() { return 42; }
const x = f();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'f' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "f" should exist');

      const call = allNodes.find(n => n.name === 'f' && n.type === 'CALL');
      assert.ok(call, 'CALL node for f() should exist');

      const callReturnsEdge = allEdges.find(e =>
        e.type === 'CALL_RETURNS' && e.src === call.id && e.dst === func.id
      );
      assert.ok(callReturnsEdge, 'CALL_RETURNS edge should exist from CALL:f to FUNCTION:f');
    });

    it('should NOT create CALL_RETURNS for constructor call (new X())', async () => {
      const projectPath = await setupTest({
        'index.js': `
class Foo { constructor() {} }
const x = new Foo();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allEdges = await backend.getAllEdges();

      const callReturnsEdges = allEdges.filter(e => e.type === 'CALL_RETURNS');
      assert.strictEqual(callReturnsEdges.length, 0,
        'No CALL_RETURNS edges should exist for constructor calls');
    });

    it('should NOT create CALL_RETURNS for unresolved/external call', async () => {
      const projectPath = await setupTest({
        'index.js': `
const x = someExternalFunction();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allEdges = await backend.getAllEdges();

      const callReturnsEdges = allEdges.filter(e => e.type === 'CALL_RETURNS');
      assert.strictEqual(callReturnsEdges.length, 0,
        'No CALL_RETURNS edges should exist for unresolved calls');
    });
  });

  // ─── traceValues tests ──────────────────────────────────────────────

  describe('traceValues through function calls', () => {
    it('should trace single literal return value', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f() { return 42; }
const x = f();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const variable = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(variable, 'Variable "x" should exist');

      const traced = await traceValues(backend, variable.id);
      const result = aggregateValues(traced);

      assert.deepStrictEqual(result.values, [42],
        'Should trace through f() to find return value 42');
      assert.strictEqual(result.hasUnknown, false,
        'Should not have unknown values');
    });

    it('should trace multiple conditional return values', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f(c) {
  if (c) return 1;
  return 2;
}
const x = f();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const variable = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(variable, 'Variable "x" should exist');

      const traced = await traceValues(backend, variable.id);
      const result = aggregateValues(traced);

      assert.strictEqual(result.values.length, 2, 'Should find 2 return values');
      assert.ok(result.values.includes(1), 'Should include return value 1');
      assert.ok(result.values.includes(2), 'Should include return value 2');
    });

    it('should trace nested function calls', async () => {
      const projectPath = await setupTest({
        'index.js': `
function a() { return 1; }
function b() { return a(); }
const x = b();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const variable = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(variable, 'Variable "x" should exist');

      const traced = await traceValues(backend, variable.id);
      const result = aggregateValues(traced);

      assert.deepStrictEqual(result.values, [1],
        'Should trace through b() → a() to find value 1');
    });

    it('should return implicit_return for function with no return statement', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f() { console.log('hi'); }
const x = f();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const variable = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(variable, 'Variable "x" should exist');

      const traced = await traceValues(backend, variable.id);

      const implicitReturn = traced.find(t => t.reason === 'implicit_return');
      assert.ok(implicitReturn, 'Should have implicit_return reason');
      assert.strictEqual(implicitReturn.isUnknown, true, 'implicit_return should be unknown');
    });

    it('should respect followCallReturns=false opt-out', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f() { return 42; }
const x = f();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const variable = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(variable, 'Variable "x" should exist');

      const traced = await traceValues(backend, variable.id, { followCallReturns: false });

      const callResult = traced.find(t => t.reason === 'call_result');
      assert.ok(callResult, 'Should have call_result reason when followCallReturns=false');
      assert.strictEqual(callResult.isUnknown, true);
    });

    it('should handle recursive functions without hanging (cycle protection)', async () => {
      const projectPath = await setupTest({
        'index.js': `
function f() { return f(); }
const x = f();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const variable = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(variable, 'Variable "x" should exist');

      // Should not hang — visited set prevents infinite loop
      const traced = await traceValues(backend, variable.id);
      // Result may be empty (cycle detected, no terminal value) or max_depth
      assert.ok(Array.isArray(traced), 'Should return an array (not hang)');
    });
  });

  // ─── Cross-file tests ──────────────────────────────────────────────

  describe('Cross-file CALL_RETURNS', () => {
    it('should trace through imported function call', async () => {
      testDir = join(tmpdir(), `grafema-test-call-returns-${Date.now()}-${testCounter++}`);
      mkdirSync(join(testDir, 'src'), { recursive: true });

      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ name: 'test-cross-file', type: 'module', main: 'src/index.js' })
      );
      writeFileSync(join(testDir, 'src/lib.js'),
        'export function getAnswer() { return 42; }');
      writeFileSync(join(testDir, 'src/index.js'),
        "import { getAnswer } from './lib.js';\nconst x = getAnswer();");

      const projectPath = testDir;

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Verify CALL_RETURNS edge exists (through import resolution)
      const func = allNodes.find(n => n.name === 'getAnswer' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getAnswer" should exist in lib.js');

      const call = allNodes.find(n => n.name === 'getAnswer' && n.type === 'CALL');
      assert.ok(call, 'CALL node for getAnswer() should exist in index.js');

      const callReturnsEdge = allEdges.find(e =>
        e.type === 'CALL_RETURNS' && e.src === call.id && e.dst === func.id
      );
      assert.ok(callReturnsEdge,
        'CALL_RETURNS edge should resolve through IMPORT to FUNCTION');

      // Verify traceValues works end-to-end
      const variable = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(variable, 'Variable "x" should exist');

      const traced = await traceValues(backend, variable.id);
      const result = aggregateValues(traced);

      assert.deepStrictEqual(result.values, [42],
        'Should trace through cross-file import to find value 42');
    });
  });
});
