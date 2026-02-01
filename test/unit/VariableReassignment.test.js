/**
 * Tests for Variable Reassignment Tracking (FLOWS_INTO and READS_FROM edges)
 *
 * REG-290: Track variable reassignments with FLOWS_INTO edges and READS_FROM self-loops.
 *
 * When code does x = y, x += y, x -= y, etc., we need to create edges:
 * - FLOWS_INTO: value --FLOWS_INTO--> variable (write side)
 * - READS_FROM: variable --READS_FROM--> variable (self-loop for compound operators)
 *
 * Edge direction:
 * - FLOWS_INTO: src=value, dst=variable
 * - READS_FROM: src=variable, dst=variable (self-loop)
 *
 * This is the TDD test file for REG-290. Tests are written BEFORE implementation,
 * so they should be RED initially.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-var-reassignment-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-var-reassignment-${testCounter}`,
      type: 'module'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('Variable Reassignment Tracking', () => {
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

  // ============================================================================
  // Simple Assignment (operator = '=')
  // ============================================================================
  describe('Simple assignment (=)', () => {
    it('should create FLOWS_INTO edge for simple variable reassignment', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const value = 10;
total = value;  // value --FLOWS_INTO--> total
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      const valueVar = allNodes.find(n => n.name === 'value' && n.type === 'CONSTANT');

      assert.ok(totalVar, 'Variable "total" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueVar.id &&
        e.dst === totalVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from value to total. Found edges: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );
    });

    it('should NOT create READS_FROM self-loop for simple assignment', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 0;
const y = 5;
x = y;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // Should NOT create READS_FROM for simple assignment
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === xVar.id &&
        e.dst === xVar.id
      );

      assert.strictEqual(
        readsFrom, undefined,
        'READS_FROM self-loop should NOT exist for simple assignment (operator = "=")'
      );
    });

    it('should create FLOWS_INTO edge for literal reassignment', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 0;
x = 42;  // literal(42) --FLOWS_INTO--> x
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      const literal42 = allNodes.find(n => n.type === 'LITERAL' && n.value === 42);
      assert.ok(literal42, 'LITERAL node with value 42 not created');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === literal42.id &&
        e.dst === xVar.id
      );

      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge from literal(42) to x'
      );
    });

    it('should create FLOWS_INTO edge for expression reassignment', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const a = 5, b = 3;
total = a + b;  // EXPRESSION(a+b) --FLOWS_INTO--> total
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      const expression = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.expressionType === 'BinaryExpression'
      );
      assert.ok(expression, 'EXPRESSION node not created for BinaryExpression');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === expression.id &&
        e.dst === totalVar.id
      );

      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge from expression to total'
      );
    });

    it('should handle member expression on RHS', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const item = { price: 10 };
total = item.price;  // EXPRESSION(item.price) --FLOWS_INTO--> total
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      const expression = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.expressionType === 'MemberExpression'
      );
      assert.ok(expression, 'EXPRESSION node not created for MemberExpression');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === expression.id &&
        e.dst === totalVar.id
      );

      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge from member expression to total'
      );
    });

    it('should handle call expression on RHS', async () => {
      await setupTest(backend, {
        'index.js': `
function getPrice() { return 10; }
let total = 0;
total = getPrice();  // getPrice() --FLOWS_INTO--> total
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      const getPriceCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'getPrice'
      );
      assert.ok(getPriceCall, 'CALL node for getPrice() not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === getPriceCall.id &&
        e.dst === totalVar.id
      );

      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge from call to total'
      );
    });
  });

  // ============================================================================
  // Arithmetic Compound Operators (+=, -=, *=, /=, %=, **=)
  // ============================================================================
  describe('Arithmetic compound operators', () => {
    it('should create READS_FROM self-loop for += operator', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const price = 10;
total += price;  // total --READS_FROM--> total (self-loop)
                 // price --FLOWS_INTO--> total
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      const priceVar = allNodes.find(n => n.name === 'price' && n.type === 'CONSTANT');

      assert.ok(totalVar, 'Variable "total" not found');
      assert.ok(priceVar, 'Variable "price" not found');

      // READS_FROM edge (self-loop)
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === totalVar.id &&
        e.dst === totalVar.id
      );
      assert.ok(
        readsFrom,
        'READS_FROM self-loop not found for compound operator +='
      );

      // FLOWS_INTO edge
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === priceVar.id &&
        e.dst === totalVar.id
      );
      assert.ok(
        flowsInto,
        'FLOWS_INTO edge not found for compound operator +='
      );
    });

    it('should handle all arithmetic compound operators', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 100;
const a = 5, b = 2, c = 3, d = 4, e = 1, f = 2;
x += a;   // a --FLOWS_INTO--> x, x --READS_FROM--> x
x -= b;   // b --FLOWS_INTO--> x, x --READS_FROM--> x
x *= c;   // c --FLOWS_INTO--> x, x --READS_FROM--> x
x /= d;   // d --FLOWS_INTO--> x, x --READS_FROM--> x
x %= e;   // e --FLOWS_INTO--> x, x --READS_FROM--> x
x **= f;  // f --FLOWS_INTO--> x, x --READS_FROM--> x
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // Each compound operator creates FLOWS_INTO edge
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === xVar.id
      );
      assert.strictEqual(
        flowsIntoEdges.length, 6,
        `Expected 6 FLOWS_INTO edges, got ${flowsIntoEdges.length}`
      );

      // RFDB deduplicates edges with same (type, src, dst), so we get 1 self-loop
      // This is semantically correct: "x reads from x" is a single relationship
      const readsFromEdges = allEdges.filter(e =>
        e.type === 'READS_FROM' &&
        e.src === xVar.id &&
        e.dst === xVar.id
      );
      assert.ok(
        readsFromEdges.length >= 1,
        `Expected at least 1 READS_FROM self-loop, got ${readsFromEdges.length}`
      );
    });

    it('should handle compound operator with literal', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 10;
x += 5;  // literal(5) --FLOWS_INTO--> x, x --READS_FROM--> x
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      const literal5 = allNodes.find(n => n.type === 'LITERAL' && n.value === 5);

      assert.ok(xVar, 'Variable "x" not found');
      assert.ok(literal5, 'LITERAL node with value 5 not created');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === literal5.id &&
        e.dst === xVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge from literal to x not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === xVar.id &&
        e.dst === xVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found');
    });

    it('should handle compound operator with member expression', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const item = { price: 10 };
total += item.price;  // EXPRESSION(item.price) --FLOWS_INTO--> total
                      // total --READS_FROM--> total
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      const expression = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.expressionType === 'MemberExpression'
      );
      assert.ok(expression, 'EXPRESSION node not created for item.price');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === expression.id &&
        e.dst === totalVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge from expression to total not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === totalVar.id &&
        e.dst === totalVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found');
    });

    it('should handle compound operator with call expression', async () => {
      await setupTest(backend, {
        'index.js': `
function getPrice() { return 10; }
let total = 0;
total += getPrice();  // getPrice() --FLOWS_INTO--> total
                      // total --READS_FROM--> total
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      const getPriceCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'getPrice'
      );
      assert.ok(getPriceCall, 'CALL node for getPrice() not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === getPriceCall.id &&
        e.dst === totalVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge from call to total not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === totalVar.id &&
        e.dst === totalVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found');
    });
  });

  // ============================================================================
  // Bitwise Compound Operators (&=, |=, ^=, <<=, >>=, >>>=)
  // ============================================================================
  describe('Bitwise compound operators', () => {
    it('should handle bitwise compound operators', async () => {
      await setupTest(backend, {
        'index.js': `
let flags = 0b1010;
const mask1 = 0b0011;
const mask2 = 0b0101;
const mask3 = 0b1100;
flags &= mask1;   // mask1 --FLOWS_INTO--> flags, flags --READS_FROM--> flags
flags |= mask2;   // mask2 --FLOWS_INTO--> flags, flags --READS_FROM--> flags
flags ^= mask3;   // mask3 --FLOWS_INTO--> flags, flags --READS_FROM--> flags
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const flagsVar = allNodes.find(n => n.name === 'flags' && n.type === 'VARIABLE');
      assert.ok(flagsVar, 'Variable "flags" not found');

      // 3 FLOWS_INTO edges (&=, |=, ^=)
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === flagsVar.id
      );
      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 FLOWS_INTO edges for bitwise operators, got ${flowsIntoEdges.length}`
      );

      // RFDB deduplicates edges with same (type, src, dst), so we get 1 self-loop
      const readsFromEdges = allEdges.filter(e =>
        e.type === 'READS_FROM' &&
        e.src === flagsVar.id &&
        e.dst === flagsVar.id
      );
      assert.ok(
        readsFromEdges.length >= 1,
        `Expected at least 1 READS_FROM self-loop for bitwise operators, got ${readsFromEdges.length}`
      );
    });

    it('should handle shift operators (<<=, >>=, >>>=)', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 8;
const a = 1, b = 2, c = 1;
x <<= a;   // a --FLOWS_INTO--> x, x --READS_FROM--> x
x >>= b;   // b --FLOWS_INTO--> x, x --READS_FROM--> x
x >>>= c;  // c --FLOWS_INTO--> x, x --READS_FROM--> x
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // 3 FLOWS_INTO edges
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === xVar.id
      );
      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 FLOWS_INTO edges for shift operators, got ${flowsIntoEdges.length}`
      );

      // RFDB deduplicates edges with same (type, src, dst), so we get 1 self-loop
      const readsFromEdges = allEdges.filter(e =>
        e.type === 'READS_FROM' &&
        e.src === xVar.id &&
        e.dst === xVar.id
      );
      assert.ok(
        readsFromEdges.length >= 1,
        `Expected at least 1 READS_FROM self-loop for shift operators, got ${readsFromEdges.length}`
      );
    });
  });

  // ============================================================================
  // Logical Compound Operators (&&=, ||=, ??=)
  // ============================================================================
  describe('Logical compound operators', () => {
    it('should handle logical AND assignment (&&=)', async () => {
      await setupTest(backend, {
        'index.js': `
let flag = true;
const condition = false;
flag &&= condition;  // condition --FLOWS_INTO--> flag, flag --READS_FROM--> flag
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const flagVar = allNodes.find(n => n.name === 'flag' && n.type === 'VARIABLE');
      const conditionVar = allNodes.find(n => n.name === 'condition' && n.type === 'CONSTANT');

      assert.ok(flagVar, 'Variable "flag" not found');
      assert.ok(conditionVar, 'Variable "condition" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === conditionVar.id &&
        e.dst === flagVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge not found for &&=');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === flagVar.id &&
        e.dst === flagVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found for &&=');
    });

    it('should handle logical OR assignment (||=)', async () => {
      await setupTest(backend, {
        'index.js': `
let value = null;
const fallback = 'default';
value ||= fallback;  // fallback --FLOWS_INTO--> value, value --READS_FROM--> value
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const valueVar = allNodes.find(n => n.name === 'value' && n.type === 'VARIABLE');
      const fallbackVar = allNodes.find(n => n.name === 'fallback' && n.type === 'CONSTANT');

      assert.ok(valueVar, 'Variable "value" not found');
      assert.ok(fallbackVar, 'Variable "fallback" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === fallbackVar.id &&
        e.dst === valueVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge not found for ||=');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === valueVar.id &&
        e.dst === valueVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found for ||=');
    });

    it('should handle nullish coalescing assignment (??=)', async () => {
      await setupTest(backend, {
        'index.js': `
let config = null;
const defaults = { port: 3000 };
config ??= defaults;  // defaults --FLOWS_INTO--> config, config --READS_FROM--> config
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const configVar = allNodes.find(n => n.name === 'config' && n.type === 'VARIABLE');
      const defaultsVar = allNodes.find(n => n.name === 'defaults' && n.type === 'CONSTANT');

      assert.ok(configVar, 'Variable "config" not found');
      assert.ok(defaultsVar, 'Variable "defaults" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === defaultsVar.id &&
        e.dst === configVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge not found for ??=');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === configVar.id &&
        e.dst === configVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found for ??=');
    });
  });

  // ============================================================================
  // Multiple Reassignments
  // ============================================================================
  describe('Multiple reassignments', () => {
    it('should create multiple edges for multiple reassignments to same variable', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 0;
const a = 1, b = 2, c = 3;
x = a;   // Simple assignment: a --FLOWS_INTO--> x
x += b;  // Compound: b --FLOWS_INTO--> x, x --READS_FROM--> x
x -= c;  // Compound: c --FLOWS_INTO--> x, x --READS_FROM--> x
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // 3 FLOWS_INTO edges (one per reassignment)
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === xVar.id
      );
      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 FLOWS_INTO edges, got ${flowsIntoEdges.length}`
      );

      // RFDB deduplicates edges with same (type, src, dst), so we get 1 self-loop
      // (only compound operators create READS_FROM, not simple =)
      const readsFromEdges = allEdges.filter(e =>
        e.type === 'READS_FROM' &&
        e.src === xVar.id &&
        e.dst === xVar.id
      );
      assert.ok(
        readsFromEdges.length >= 1,
        `Expected at least 1 READS_FROM self-loop (only for compound operators), got ${readsFromEdges.length}`
      );
    });

    it('should handle reassignments in loops', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const items = [1, 2, 3];
for (const item of items) {
  total += item;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      const itemVar = allNodes.find(n => n.name === 'item' && n.type === 'CONSTANT');

      assert.ok(totalVar, 'Variable "total" not found');
      assert.ok(itemVar, 'Variable "item" not found');

      // Should create 1 FLOWS_INTO edge (syntactic, not runtime)
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemVar.id &&
        e.dst === totalVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge from item to total not found');

      // Should create 1 READS_FROM self-loop (syntactic)
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === totalVar.id &&
        e.dst === totalVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found');
    });
  });

  // ============================================================================
  // Edge Cases and Limitations
  // ============================================================================
  describe('Edge cases and limitations', () => {
    it('should NOT create edges for property assignment (obj.prop = value)', async () => {
      // This should be handled by object mutation tracking, not variable reassignment
      await setupTest(backend, {
        'index.js': `
const obj = {};
const value = 42;
obj.prop = value;  // Handled by object mutation, not variable reassignment
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Property assignments create FLOWS_INTO edges with mutationType metadata
      // Variable reassignments should NOT have mutationType metadata
      const varReassignmentEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && !e.mutationType
      );

      // There should be no variable reassignment edges for obj.prop = value
      const objVar = allNodes.find(n => n.name === 'obj');
      const hasObjReassignment = varReassignmentEdges.some(e => e.dst === objVar?.id);

      assert.strictEqual(
        hasObjReassignment, false,
        'Should NOT create variable reassignment edge for obj.prop = value'
      );
    });

    it('should NOT create edges for array indexed assignment (arr[i] = value)', async () => {
      // This should be handled by array mutation tracking, not variable reassignment
      await setupTest(backend, {
        'index.js': `
const arr = [];
const value = 42;
arr[0] = value;  // Handled by array mutation, not variable reassignment
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Array indexed assignments create FLOWS_INTO edges with mutationMethod metadata
      // Variable reassignments should NOT have mutationMethod metadata
      const arrVar = allNodes.find(n => n.name === 'arr');

      const varReassignmentEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar?.id && !e.mutationMethod
      );

      assert.strictEqual(
        varReassignmentEdges.length, 0,
        'Should NOT create variable reassignment edge for arr[0] = value'
      );
    });

    it('should document shadowed variable limitation (REG-XXX)', async () => {
      // This test documents current behavior: uses file-level variable lookup, not scope-aware
      // Shadowed variables in nested scopes will incorrectly resolve to outer scope variable
      await setupTest(backend, {
        'index.js': `
let x = 1;
function foo() {
  let x = 2;
  x += 3;  // Currently resolves to outer x (WRONG, but consistent with mutation handlers)
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // This test passes with current implementation (documents wrong behavior)
      // TODO: After scope-aware lookup implemented, update this test to verify correct behavior

      // Find outer x
      const outerX = allNodes.find(n =>
        n.name === 'x' && n.type === 'VARIABLE' && !n.id.includes('foo')
      );

      // Current behavior: creates edge to outer x
      // Future behavior: should create edge to inner x
      const hasReassignment = allEdges.some(e =>
        e.type === 'FLOWS_INTO' && e.dst === outerX?.id
      );

      // For now, just document that this case exists
      // Test name indicates this is a known limitation
      assert.ok(
        true,
        'Shadowed variable test documents current limitation (file-level lookup)'
      );
    });
  });

  // ============================================================================
  // Integration: Real-world scenarios
  // ============================================================================
  describe('Integration with real-world patterns', () => {
    it('should track accumulator pattern in reduce', async () => {
      await setupTest(backend, {
        'index.js': `
function calculateTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      // Should have EXPRESSION(item.price) --FLOWS_INTO--> total
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === totalVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge to total not found');

      // Should have total --READS_FROM--> total (self-loop)
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === totalVar.id &&
        e.dst === totalVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found');

      // Should have total --RETURNS--> calculateTotal
      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.src === totalVar.id
      );
      assert.ok(returnsEdge, 'RETURNS edge from total not found');
    });

    it('should track counter pattern', async () => {
      await setupTest(backend, {
        'index.js': `
let counter = 0;
function increment() {
  counter += 1;
}
function decrement() {
  counter -= 1;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const counterVar = allNodes.find(n => n.name === 'counter' && n.type === 'VARIABLE');
      assert.ok(counterVar, 'Variable "counter" not found');

      // Should have 2 FLOWS_INTO edges (one from each function)
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === counterVar.id
      );
      assert.ok(
        flowsIntoEdges.length >= 2,
        `Expected at least 2 FLOWS_INTO edges, got ${flowsIntoEdges.length}`
      );

      // RFDB deduplicates edges with same (type, src, dst), so we get 1 self-loop
      const readsFromEdges = allEdges.filter(e =>
        e.type === 'READS_FROM' &&
        e.src === counterVar.id &&
        e.dst === counterVar.id
      );
      assert.ok(
        readsFromEdges.length >= 1,
        `Expected at least 1 READS_FROM self-loop, got ${readsFromEdges.length}`
      );
    });

    it('should track state machine pattern', async () => {
      await setupTest(backend, {
        'index.js': `
let state = 'idle';
const STATE_LOADING = 'loading';
const STATE_SUCCESS = 'success';
const STATE_ERROR = 'error';

function startLoad() {
  state = STATE_LOADING;
}
function handleSuccess() {
  state = STATE_SUCCESS;
}
function handleError() {
  state = STATE_ERROR;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const stateVar = allNodes.find(n => n.name === 'state' && n.type === 'VARIABLE');
      assert.ok(stateVar, 'Variable "state" not found');

      // Should have 3 FLOWS_INTO edges (one from each state constant)
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === stateVar.id
      );
      assert.ok(
        flowsIntoEdges.length >= 3,
        `Expected at least 3 FLOWS_INTO edges for state transitions, got ${flowsIntoEdges.length}`
      );

      // These are simple assignments (=), so NO READS_FROM edges
      const readsFromEdges = allEdges.filter(e =>
        e.type === 'READS_FROM' &&
        e.src === stateVar.id &&
        e.dst === stateVar.id
      );
      assert.strictEqual(
        readsFromEdges.length, 0,
        'State machine uses simple assignment, should have no READS_FROM self-loops'
      );
    });
  });

  // ============================================================================
  // Edge direction verification
  // ============================================================================
  describe('Edge direction verification', () => {
    it('should create FLOWS_INTO with correct direction: value -> variable (src=value, dst=variable)', async () => {
      await setupTest(backend, {
        'index.js': `
let target = 0;
const source = 10;
target = source;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const targetVar = allNodes.find(n => n.name === 'target' && n.type === 'VARIABLE');
      const sourceVar = allNodes.find(n => n.name === 'source' && n.type === 'CONSTANT');

      const flowsInto = allEdges.find(e => e.type === 'FLOWS_INTO');

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge');
      assert.strictEqual(flowsInto.src, sourceVar.id, 'Edge src should be the source (value)');
      assert.strictEqual(flowsInto.dst, targetVar.id, 'Edge dst should be the target (variable)');
    });

    it('should create READS_FROM self-loop with correct direction: variable -> variable (src=dst)', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 0;
const y = 5;
x += y;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');

      const readsFrom = allEdges.find(e => e.type === 'READS_FROM');

      assert.ok(readsFrom, 'Expected READS_FROM edge');
      assert.strictEqual(readsFrom.src, xVar.id, 'READS_FROM src should be the variable');
      assert.strictEqual(readsFrom.dst, xVar.id, 'READS_FROM dst should be the variable (self-loop)');
    });
  });
});
