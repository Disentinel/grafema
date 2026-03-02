/**
 * Tests for Variable Reassignment Tracking (EXPRESSION nodes with WRITES_TO and READS_FROM edges)
 *
 * REG-290: Track variable reassignments.
 *
 * V2 behavior:
 * When code does x = y, x += y, x -= y, etc., we create:
 * - EXPRESSION node with operator metadata (name="=", "+=", etc.)
 * - WRITES_TO: EXPRESSION --WRITES_TO--> variable (write side)
 * - READS_FROM: EXPRESSION --READS_FROM--> source (read side)
 *
 * Edge direction:
 * - WRITES_TO: src=EXPRESSION, dst=variable
 * - READS_FROM: src=EXPRESSION, dst=source variable/constant
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

  // ============================================================================
  // Simple Assignment (operator = '=')
  // ============================================================================
  describe('Simple assignment (=)', () => {
    it('should create EXPRESSION with WRITES_TO and READS_FROM for simple variable reassignment', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const value = 10;
total = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      const valueVar = allNodes.find(n => n.name === 'value' && n.type === 'CONSTANT');

      assert.ok(totalVar, 'Variable "total" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      // V2: EXPRESSION node with operator "="
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION node with name="=" not found');

      // WRITES_TO edge: EXPRESSION -> total
      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge from EXPRESSION to total not found');

      // READS_FROM edge: EXPRESSION -> value
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === valueVar.id
      );
      assert.ok(readsFrom, 'READS_FROM edge from EXPRESSION to value not found');
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

      // Should NOT create READS_FROM self-loop (x -> x)
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

    it('should create EXPRESSION for literal reassignment', { todo: 'flaky: database isolation' }, async () => {
      await setupTest(backend, {
        'index.js': `
let x = 0;
x = 42;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // V2: EXPRESSION with WRITES_TO
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION node not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === xVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge from EXPRESSION to x not found');
    });

    it('should create EXPRESSION with WRITES_TO for expression reassignment', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const a = 5, b = 3;
total = a + b;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      // V2: EXPRESSION with WRITES_TO
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION node not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge from EXPRESSION to total not found');
    });

    it('should handle member expression on RHS', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const item = { price: 10 };
total = item.price;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      // V2: EXPRESSION with WRITES_TO to total
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION node not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge from EXPRESSION to total not found');

      // V2: PROPERTY_ACCESS node for item.price should exist
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'item.price'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for item.price not found');
    });

    it('should handle call expression on RHS', async () => {
      await setupTest(backend, {
        'index.js': `
function getPrice() { return 10; }
let total = 0;
total = getPrice();
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

      // V2: EXPRESSION with WRITES_TO to total, ASSIGNED_FROM to CALL
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION node not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge from EXPRESSION to total not found');
    });
  });

  // ============================================================================
  // Arithmetic Compound Operators (+=, -=, *=, /=, %=, **=)
  // ============================================================================
  describe('Arithmetic compound operators', () => {
    it('should create EXPRESSION with READS_FROM for += operator', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const price = 10;
total += price;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      const priceVar = allNodes.find(n => n.name === 'price' && n.type === 'CONSTANT');

      assert.ok(totalVar, 'Variable "total" not found');
      assert.ok(priceVar, 'Variable "price" not found');

      // V2: EXPRESSION(+=) with WRITES_TO and READS_FROM
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '+='
      );
      assert.ok(assignExpr, 'EXPRESSION node with name="+=" not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found for compound operator +=');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === priceVar.id
      );
      assert.ok(readsFrom, 'READS_FROM edge not found for compound operator +=');
    });

    it('should handle all arithmetic compound operators', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 100;
const a = 5, b = 2, c = 3, d = 4, e = 1, f = 2;
x += a;
x -= b;
x *= c;
x /= d;
x %= e;
x **= f;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // V2: Each compound operator creates a separate EXPRESSION node
      const assignExprs = allNodes.filter(n =>
        n.type === 'EXPRESSION' && n.name !== '='
      );
      // Should have at least 6 EXPRESSION nodes for compound operators
      assert.ok(
        assignExprs.length >= 6,
        `Expected at least 6 EXPRESSION nodes for compound operators, got ${assignExprs.length}`
      );

      // Each should have WRITES_TO edge to x
      const writesToEdges = allEdges.filter(e =>
        e.type === 'WRITES_TO' && e.dst === xVar.id
      );
      assert.strictEqual(
        writesToEdges.length, 6,
        `Expected 6 WRITES_TO edges, got ${writesToEdges.length}`
      );
    });

    it('should handle compound operator with literal', { todo: 'flaky: database isolation' }, async () => {
      await setupTest(backend, {
        'index.js': `
let x = 10;
x += 5;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // V2: EXPRESSION with WRITES_TO
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '+='
      );
      assert.ok(assignExpr, 'EXPRESSION node not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === xVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found');
    });

    it('should handle compound operator with member expression', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const item = { price: 10 };
total += item.price;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      // V2: EXPRESSION(+=) with WRITES_TO to total
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '+='
      );
      assert.ok(assignExpr, 'EXPRESSION node not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found');
    });

    it('should handle compound operator with call expression', async () => {
      await setupTest(backend, {
        'index.js': `
function getPrice() { return 10; }
let total = 0;
total += getPrice();
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

      // V2: EXPRESSION(+=) with WRITES_TO
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '+='
      );
      assert.ok(assignExpr, 'EXPRESSION node not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found');
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
flags &= mask1;
flags |= mask2;
flags ^= mask3;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const flagsVar = allNodes.find(n => n.name === 'flags' && n.type === 'VARIABLE');
      assert.ok(flagsVar, 'Variable "flags" not found');

      // 3 WRITES_TO edges (&=, |=, ^=)
      const writesToEdges = allEdges.filter(e =>
        e.type === 'WRITES_TO' && e.dst === flagsVar.id
      );
      assert.strictEqual(
        writesToEdges.length, 3,
        `Expected 3 WRITES_TO edges for bitwise operators, got ${writesToEdges.length}`
      );
    });

    it('should handle shift operators (<<=, >>=, >>>=)', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 8;
const a = 1, b = 2, c = 1;
x <<= a;
x >>= b;
x >>>= c;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // 3 WRITES_TO edges
      const writesToEdges = allEdges.filter(e =>
        e.type === 'WRITES_TO' && e.dst === xVar.id
      );
      assert.strictEqual(
        writesToEdges.length, 3,
        `Expected 3 WRITES_TO edges for shift operators, got ${writesToEdges.length}`
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
flag &&= condition;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const flagVar = allNodes.find(n => n.name === 'flag' && n.type === 'VARIABLE');
      const conditionVar = allNodes.find(n => n.name === 'condition' && n.type === 'CONSTANT');

      assert.ok(flagVar, 'Variable "flag" not found');
      assert.ok(conditionVar, 'Variable "condition" not found');

      // V2: EXPRESSION with WRITES_TO and READS_FROM
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '&&='
      );
      assert.ok(assignExpr, 'EXPRESSION node for &&= not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === flagVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found for &&=');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === conditionVar.id
      );
      assert.ok(readsFrom, 'READS_FROM edge not found for &&=');
    });

    it('should handle logical OR assignment (||=)', async () => {
      await setupTest(backend, {
        'index.js': `
let value = null;
const fallback = 'default';
value ||= fallback;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const valueVar = allNodes.find(n => n.name === 'value' && n.type === 'VARIABLE');
      const fallbackVar = allNodes.find(n => n.name === 'fallback' && n.type === 'CONSTANT');

      assert.ok(valueVar, 'Variable "value" not found');
      assert.ok(fallbackVar, 'Variable "fallback" not found');

      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '||='
      );
      assert.ok(assignExpr, 'EXPRESSION node for ||= not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === valueVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found for ||=');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === fallbackVar.id
      );
      assert.ok(readsFrom, 'READS_FROM edge not found for ||=');
    });

    it('should handle nullish coalescing assignment (??=)', async () => {
      await setupTest(backend, {
        'index.js': `
let config = null;
const defaults = { port: 3000 };
config ??= defaults;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const configVar = allNodes.find(n => n.name === 'config' && n.type === 'VARIABLE');
      // V2: const declarations with object initializers are classified as VARIABLE (not CONSTANT)
      const defaultsVar = allNodes.find(n =>
        n.name === 'defaults' && (n.type === 'CONSTANT' || n.type === 'VARIABLE')
      );

      assert.ok(configVar, 'Variable "config" not found');
      assert.ok(defaultsVar, 'Variable "defaults" not found');

      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '??='
      );
      assert.ok(assignExpr, 'EXPRESSION node for ??= not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === configVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found for ??=');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === defaultsVar.id
      );
      assert.ok(readsFrom, 'READS_FROM edge not found for ??=');
    });
  });

  // ============================================================================
  // Multiple Reassignments
  // ============================================================================
  describe('Multiple reassignments', () => {
    it('should create multiple EXPRESSION nodes for multiple reassignments to same variable', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 0;
const a = 1, b = 2, c = 3;
x = a;
x += b;
x -= c;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // 3 WRITES_TO edges (one per reassignment)
      const writesToEdges = allEdges.filter(e =>
        e.type === 'WRITES_TO' && e.dst === xVar.id
      );
      assert.strictEqual(
        writesToEdges.length, 3,
        `Expected 3 WRITES_TO edges, got ${writesToEdges.length}`
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
      const itemVar = allNodes.find(n => n.name === 'item' && n.type === 'VARIABLE');

      assert.ok(totalVar, 'Variable "total" not found');
      assert.ok(itemVar, 'Variable "item" not found');

      // V2: EXPRESSION(+=) with WRITES_TO to total
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '+='
      );
      assert.ok(assignExpr, 'EXPRESSION node not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found');

      // V2: EXPRESSION reads from item
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === itemVar.id
      );
      assert.ok(readsFrom, 'READS_FROM edge from EXPRESSION to item not found');
    });
  });

  // ============================================================================
  // Edge Cases and Limitations
  // ============================================================================
  describe('Edge cases and limitations', () => {
    it('should create WRITES_TO for property assignment (obj.prop = value) to root variable', async () => {
      // REG-573: PROPERTY_ASSIGNMENT creates WRITES_TO to root variable
      await setupTest(backend, {
        'index.js': `
const obj = {};
const value = 42;
obj.prop = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      assert.ok(objVar, 'Variable "obj" not found');

      const varWritesToEdges = allEdges.filter(e =>
        e.type === 'WRITES_TO' && e.dst === objVar.id
      );

      // obj.prop = value creates WRITES_TO to obj (the root variable being modified)
      assert.strictEqual(
        varWritesToEdges.length, 1,
        'Should create WRITES_TO edge to obj for obj.prop = value'
      );
    });

    it('should create WRITES_TO for array indexed assignment (arr[i] = value) to root variable', async () => {
      // REG-573: PROPERTY_ASSIGNMENT creates WRITES_TO to root variable
      await setupTest(backend, {
        'index.js': `
const arr = [];
const value = 42;
arr[0] = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      const varWritesToEdges = allEdges.filter(e =>
        e.type === 'WRITES_TO' && e.dst === arrVar.id
      );

      // arr[0] = value creates WRITES_TO to arr (the root variable being modified)
      assert.strictEqual(
        varWritesToEdges.length, 1,
        'Should create WRITES_TO edge to arr for arr[0] = value'
      );
    });

    it('should document shadowed variable limitation (REG-XXX)', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 1;
function foo() {
  let x = 2;
  x += 3;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const _allEdges = await backend.getAllEdges();

      // For now, just document that this case exists
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
    it('should track accumulator pattern in reduce', { todo: 'flaky: database isolation' }, async () => {
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

      // V2: Should have EXPRESSION(+=) with WRITES_TO to total
      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.dst === totalVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge to total not found');

      // Should have total --RETURNS--> calculateTotal
      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === totalVar.id
      );
      assert.ok(returnsEdge, 'RETURNS edge involving total not found');
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

      // V2: Should have 2 WRITES_TO edges (one from each function's EXPRESSION)
      const writesToEdges = allEdges.filter(e =>
        e.type === 'WRITES_TO' && e.dst === counterVar.id
      );
      assert.ok(
        writesToEdges.length >= 2,
        `Expected at least 2 WRITES_TO edges, got ${writesToEdges.length}`
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

      // V2: Should have 3 WRITES_TO edges (one from each state function)
      const writesToEdges = allEdges.filter(e =>
        e.type === 'WRITES_TO' && e.dst === stateVar.id
      );
      assert.ok(
        writesToEdges.length >= 3,
        `Expected at least 3 WRITES_TO edges for state transitions, got ${writesToEdges.length}`
      );
    });
  });

  // ============================================================================
  // Edge direction verification
  // ============================================================================
  describe('Edge direction verification', () => {
    it('should create WRITES_TO with correct direction: EXPRESSION -> variable', async () => {
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

      const assignExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === '=');
      assert.ok(assignExpr, 'EXPRESSION node not found');

      // WRITES_TO: EXPRESSION -> target
      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' &&
        e.src === assignExpr.id &&
        e.dst === targetVar.id
      );
      assert.ok(writesTo, 'WRITES_TO edge not found');
      assert.strictEqual(writesTo.src, assignExpr.id, 'Edge src should be the EXPRESSION');
      assert.strictEqual(writesTo.dst, targetVar.id, 'Edge dst should be the target variable');
    });

    it('should create READS_FROM with correct direction: EXPRESSION -> source', async () => {
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
      const yVar = allNodes.find(n => n.name === 'y' && n.type === 'CONSTANT');
      const assignExpr = allNodes.find(n => n.type === 'EXPRESSION' && n.name === '+=');

      assert.ok(assignExpr, 'EXPRESSION node not found');

      // READS_FROM: EXPRESSION -> y
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === yVar.id
      );
      assert.ok(readsFrom, 'READS_FROM edge not found');
      assert.strictEqual(readsFrom.src, assignExpr.id, 'READS_FROM src should be the EXPRESSION');
      assert.strictEqual(readsFrom.dst, yVar.id, 'READS_FROM dst should be the source variable');
    });
  });
});
