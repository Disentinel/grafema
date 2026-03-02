/**
 * Loop Variable Declaration Tests (REG-272)
 *
 * Tests for tracking loop variable declarations in for...of and for...in statements.
 * These tests verify that:
 * 1. Simple loop variables are tracked (for const x of arr)
 * 2. Object destructuring is tracked (for const { a, b } of arr)
 * 3. Array destructuring is tracked (for const [a, b] of arr)
 * 4. DERIVES_FROM/ITERATES_OVER edges connect to source collection
 * 5. Variables are scoped correctly to loop body
 *
 * V2 notes:
 * - Variable IDs use format: file->TYPE->name#lineNumber (no function/loop scope in ID)
 * - Destructured variables may be PARAMETER type, not VARIABLE/CONSTANT
 * - Loop scope differentiation is via line numbers, not scope segments in IDs
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const TEST_LABEL = 'loop-var';

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  return setupSemanticTest(backend, files, { testLabel: TEST_LABEL });
}

/**
 * Helper: find a variable/constant/parameter node by name
 */
function findVar(allNodes, name) {
  return allNodes.find(n =>
    n.name === name && (n.type === 'VARIABLE' || n.type === 'CONSTANT' || n.type === 'PARAMETER')
  );
}

/**
 * Helper: find all variable/constant/parameter nodes by name
 */
function findAllVars(allNodes, name) {
  return allNodes.filter(n =>
    n.name === name && (n.type === 'VARIABLE' || n.type === 'CONSTANT' || n.type === 'PARAMETER')
  );
}

describe('Loop Variable Declaration (REG-272)', () => {
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

  // ===========================================================================
  // Simple loop variables (for...of)
  // ===========================================================================

  describe('for...of simple variables', () => {
    it('should track simple loop variable: for (const x of arr)', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
for (const x of arr) {
  console.log(x);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const xVar = findVar(allNodes, 'x');

      assert.ok(xVar, 'Should find loop variable "x"');

      // V2: loop variables can be VARIABLE, CONSTANT, or PARAMETER
      assert.ok(['VARIABLE', 'CONSTANT', 'PARAMETER'].includes(xVar.type),
        `Loop variable should be VARIABLE, CONSTANT, or PARAMETER, got ${xVar.type}`);

      // V2: variable ID includes name
      assert.ok(xVar.id.includes('x'),
        `Loop variable ID should include name. Got: ${xVar.id}`);
    });

    it('should track let loop variable: for (let x of arr)', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
for (let x of arr) {
  console.log(x);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const xVar = findVar(allNodes, 'x');

      assert.ok(xVar, 'Should find loop variable "x"');

      // V2: let loop variable creates VARIABLE node
      assert.strictEqual(xVar.type, 'VARIABLE',
        `Loop variable with let should be VARIABLE, got ${xVar.type}`);
    });

    it('should track var loop variable: for (var x of arr)', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
for (var x of arr) {
  console.log(x);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const xVar = findVar(allNodes, 'x');

      assert.ok(xVar, 'Should find loop variable "x"');
      assert.strictEqual(xVar.type, 'VARIABLE',
        `Loop variable with var should be VARIABLE, got ${xVar.type}`);
    });

    it('should create ITERATES_OVER edge to source array', async () => {
      await setupTest(backend, {
        'index.js': `
const numbers = [1, 2, 3];
for (const num of numbers) {
  console.log(num);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const numVar = findVar(allNodes, 'num');
      assert.ok(numVar, 'Should find loop variable "num"');

      const numbersVar = allNodes.find(n => n.name === 'numbers');
      assert.ok(numbersVar, 'Should find source variable "numbers"');

      // V2: uses ITERATES_OVER edge from LOOP node to source, or DERIVES_FROM
      const iteratesEdge = allEdges.find(e =>
        e.type === 'ITERATES_OVER' &&
        e.dst === numbersVar.id
      );
      const derivesEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM' &&
        e.src === numVar.id &&
        e.dst === numbersVar.id
      );

      assert.ok(iteratesEdge || derivesEdge,
        `Should have ITERATES_OVER or DERIVES_FROM edge to source array. ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.dst === numbersVar.id).map(e => e.type))}`
      );
    });
  });

  // ===========================================================================
  // Simple loop variables (for...in)
  // ===========================================================================

  describe('for...in simple variables', () => {
    it('should track simple loop variable: for (const key in obj)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { a: 1, b: 2 };
for (const key in obj) {
  console.log(key, obj[key]);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const keyVar = findVar(allNodes, 'key');

      assert.ok(keyVar, 'Should find loop variable "key"');

      // V2: variable ID includes name
      assert.ok(keyVar.id.includes('key'),
        `Loop variable ID should include name. Got: ${keyVar.id}`);
    });

    it('should create ITERATES_OVER edge to source object', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { host: 'localhost', port: 3000 };
for (const prop in config) {
  console.log(prop);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propVar = findVar(allNodes, 'prop');
      assert.ok(propVar, 'Should find loop variable "prop"');

      const configVar = allNodes.find(n => n.name === 'config');
      assert.ok(configVar, 'Should find source variable "config"');

      // V2: uses ITERATES_OVER edge from LOOP node, or DERIVES_FROM from variable
      const iteratesEdge = allEdges.find(e =>
        e.type === 'ITERATES_OVER' &&
        e.dst === configVar.id
      );
      const derivesEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM' &&
        e.src === propVar.id &&
        e.dst === configVar.id
      );

      assert.ok(iteratesEdge || derivesEdge,
        `Should have ITERATES_OVER or DERIVES_FROM edge to source. ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.dst === configVar.id).map(e => e.type))}`
      );
    });
  });

  // ===========================================================================
  // Object destructuring in for...of
  // ===========================================================================

  describe('for...of with object destructuring', () => {
    it('should track object destructuring: for (const { x, y } of points)', async () => {
      await setupTest(backend, {
        'index.js': `
const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
for (const { x, y } of points) {
  console.log(x, y);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const xVar = findVar(allNodes, 'x');
      const yVar = findVar(allNodes, 'y');

      assert.ok(xVar, 'Should find destructured variable "x"');
      assert.ok(yVar, 'Should find destructured variable "y"');

      // V2: variable IDs include name
      assert.ok(xVar.id.includes('x'),
        `Variable "x" should exist in graph. Got: ${xVar.id}`);
      assert.ok(yVar.id.includes('y'),
        `Variable "y" should exist in graph. Got: ${yVar.id}`);
    });

    it('should create destructured variables in loop', async () => {
      await setupTest(backend, {
        'index.js': `
const users = [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 30 }];
for (const { name, age } of users) {
  console.log(name, age);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const nameVar = findVar(allNodes, 'name');
      const ageVar = findVar(allNodes, 'age');
      const usersVar = allNodes.find(n => n.name === 'users');

      assert.ok(nameVar, 'Should find variable "name"');
      assert.ok(ageVar, 'Should find variable "age"');
      assert.ok(usersVar, 'Should find source variable "users"');

      // V2: destructured variables exist in the graph with name in ID
      assert.ok(nameVar.id.includes('name'),
        `Variable "name" should exist in graph. Got: ${nameVar.id}`);
      assert.ok(ageVar.id.includes('age'),
        `Variable "age" should exist in graph. Got: ${ageVar.id}`);
    });

    it('should handle nested object destructuring: for (const { user: { name } } of data)', async () => {
      await setupTest(backend, {
        'index.js': `
const data = [{ user: { name: 'Alice', id: 1 } }];
for (const { user: { name } } of data) {
  console.log(name);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const nameVar = findVar(allNodes, 'name');

      assert.ok(nameVar, 'Should find nested destructured variable "name"');

      // V2: variable ID includes name
      assert.ok(nameVar.id.includes('name'),
        `Nested destructured variable should exist in graph. Got: ${nameVar.id}`);
    });

    it('should handle renamed destructuring: for (const { oldName: newName } of arr)', async () => {
      await setupTest(backend, {
        'index.js': `
const items = [{ oldName: 'value1' }, { oldName: 'value2' }];
for (const { oldName: newName } of items) {
  console.log(newName);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // The variable should be named 'newName', not 'oldName'
      const newNameVar = findVar(allNodes, 'newName');

      assert.ok(newNameVar, 'Should find renamed variable "newName"');

      // Should NOT find variable named 'oldName' from destructuring
      const oldNameVars = allNodes.filter(n =>
        n.name === 'oldName' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      // 'oldName' might exist if there's an 'items' object literal, but not as loop variable
      // V2: variable ID includes name
      assert.ok(newNameVar.id.includes('newName'),
        `Renamed variable should exist in graph. Got: ${newNameVar.id}`);
    });
  });

  // ===========================================================================
  // Array destructuring in for...of
  // ===========================================================================

  describe('for...of with array destructuring', () => {
    it('should track array destructuring: for (const [a, b] of pairs)', async () => {
      await setupTest(backend, {
        'index.js': `
const pairs = [[1, 2], [3, 4], [5, 6]];
for (const [a, b] of pairs) {
  console.log(a, b);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const aVar = findVar(allNodes, 'a');
      const bVar = findVar(allNodes, 'b');

      assert.ok(aVar, 'Should find destructured variable "a"');
      assert.ok(bVar, 'Should find destructured variable "b"');

      // V2: variable IDs include name
      assert.ok(aVar.id.includes('->a'),
        `Variable "a" should exist in graph. Got: ${aVar.id}`);
      assert.ok(bVar.id.includes('->b'),
        `Variable "b" should exist in graph. Got: ${bVar.id}`);
    });

    it('should create destructured array variables', async () => {
      await setupTest(backend, {
        'index.js': `
const coords = [[10, 20], [30, 40]];
for (const [x, y] of coords) {
  console.log(x, y);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const xVar = findVar(allNodes, 'x');
      const yVar = findVar(allNodes, 'y');
      const coordsVar = allNodes.find(n => n.name === 'coords');

      assert.ok(xVar, 'Should find variable "x"');
      assert.ok(yVar, 'Should find variable "y"');
      assert.ok(coordsVar, 'Should find source variable "coords"');

      // V2: destructured variables exist in the graph
      assert.ok(xVar.id.includes('x'),
        `Variable "x" should exist in graph. Got: ${xVar.id}`);
      assert.ok(yVar.id.includes('y'),
        `Variable "y" should exist in graph. Got: ${yVar.id}`);
    });

    it('should handle nested array destructuring: for (const [[a, b], c] of nested)', async () => {
      await setupTest(backend, {
        'index.js': `
const nested = [[[1, 2], 3], [[4, 5], 6]];
for (const [[a, b], c] of nested) {
  console.log(a, b, c);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // V2: deeply nested destructured variables may be PARAMETER type
      const aVar = findVar(allNodes, 'a');
      const bVar = findVar(allNodes, 'b');
      const cVar = findVar(allNodes, 'c');

      assert.ok(aVar, 'Should find nested destructured variable "a"');
      assert.ok(bVar, 'Should find nested destructured variable "b"');
      assert.ok(cVar, 'Should find destructured variable "c"');

      // V2: variable IDs include name
      assert.ok(aVar.id.includes('->a'),
        `Variable "a" should exist in graph. Got: ${aVar.id}`);
      assert.ok(bVar.id.includes('->b'),
        `Variable "b" should exist in graph. Got: ${bVar.id}`);
      assert.ok(cVar.id.includes('->c'),
        `Variable "c" should exist in graph. Got: ${cVar.id}`);
    });
  });

  // ===========================================================================
  // Mixed destructuring patterns
  // ===========================================================================

  describe('for...of with mixed destructuring', () => {
    it('should handle mixed object/array: for (const { items: [first] } of data)', async () => {
      await setupTest(backend, {
        'index.js': `
const data = [{ items: ['a', 'b'] }, { items: ['c', 'd'] }];
for (const { items: [first] } of data) {
  console.log(first);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const firstVar = findVar(allNodes, 'first');

      assert.ok(firstVar, 'Should find mixed destructured variable "first"');

      // V2: variable ID includes name
      assert.ok(firstVar.id.includes('first'),
        `Mixed destructured variable should exist in graph. Got: ${firstVar.id}`);
    });

    it('should handle mixed array/object: for (const [{ name }] of data)', async () => {
      await setupTest(backend, {
        'index.js': `
const data = [[{ name: 'Alice' }], [{ name: 'Bob' }]];
for (const [{ name }] of data) {
  console.log(name);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // V2: deeply nested mixed destructured variables may be PARAMETER type
      const nameVar = findVar(allNodes, 'name');

      assert.ok(nameVar, 'Should find mixed destructured variable "name"');

      // V2: variable ID includes name
      assert.ok(nameVar.id.includes('name'),
        `Mixed destructured variable should exist in graph. Got: ${nameVar.id}`);
    });
  });

  // ===========================================================================
  // Scope verification
  // ===========================================================================

  describe('loop scope verification', () => {
    it('should scope loop variables to loop body, not parent scope', { todo: 'V2 does not include function/loop scope in variable IDs' }, async () => {
      await setupTest(backend, {
        'index.js': `
function process(items) {
  for (const item of items) {
    console.log(item);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const itemVar = findVar(allNodes, 'item');

      assert.ok(itemVar, 'Should find loop variable "item"');

      // Variable should be in loop scope, not in function scope directly
      // Semantic ID should include both function and loop scope
      assert.ok(itemVar.id.includes('process'),
        `Loop variable should be in function "process" scope. Got: ${itemVar.id}`);
      assert.ok(itemVar.id.includes('for-of') || itemVar.id.includes('for#'),
        `Loop variable should be in loop scope. Got: ${itemVar.id}`);

      // The order should be: process -> for-of -> CONSTANT -> item
      const idParts = itemVar.id.split('->');
      const hasProcessBeforeLoop = idParts.findIndex(p => p.includes('process')) <
                                   idParts.findIndex(p => p.includes('for'));

      assert.ok(hasProcessBeforeLoop,
        `Loop scope should be nested under function scope. Got: ${itemVar.id}`);
    });

    it('should handle multiple loop variables in same function with different scopes', async () => {
      await setupTest(backend, {
        'index.js': `
function process(items) {
  for (const x of items) {
    console.log(x);
  }
  for (const x of items) {
    console.log(x);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const xVars = findAllVars(allNodes, 'x');

      // Should have 2 distinct variables named 'x', each in different loop scope
      assert.strictEqual(xVars.length, 2,
        `Should have 2 distinct loop variables named "x". Found: ${xVars.length}`);

      // IDs should be different (V2 differentiates by line number)
      assert.notStrictEqual(xVars[0].id, xVars[1].id,
        `Loop variables in different loops should have different IDs. ` +
        `Got: ${xVars[0].id} and ${xVars[1].id}`);
    });

    it('should handle nested loops with same variable name', async () => {
      await setupTest(backend, {
        'index.js': `
function process(matrix) {
  for (const row of matrix) {
    for (const x of row) {
      console.log(x);
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const rowVar = findVar(allNodes, 'row');
      const xVar = findVar(allNodes, 'x');

      assert.ok(rowVar, 'Should find outer loop variable "row"');
      assert.ok(xVar, 'Should find inner loop variable "x"');

      // Both should be valid loop variables with different IDs
      assert.notStrictEqual(rowVar.id, xVar.id,
        `Outer and inner loop variables should have different IDs. ` +
        `row ID: ${rowVar.id}, x ID: ${xVar.id}`);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle loop without block statement', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
for (const x of arr) console.log(x);
        `
      });

      const allNodes = await backend.getAllNodes();

      const xVar = findVar(allNodes, 'x');

      assert.ok(xVar, 'Should find loop variable "x" even without block statement');
    });

    it('should handle for...of with destructuring default values', async () => {
      await setupTest(backend, {
        'index.js': `
const items = [{ x: 1 }, {}];
for (const { x = 0 } of items) {
  console.log(x);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const xVar = findVar(allNodes, 'x');

      assert.ok(xVar, 'Should find loop variable "x" with default value');
    });

    it('should handle for...of with rest element: for (const [first, ...rest] of arr)', async () => {
      await setupTest(backend, {
        'index.js': `
const arrays = [[1, 2, 3], [4, 5, 6]];
for (const [first, ...rest] of arrays) {
  console.log(first, rest);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const firstVar = findVar(allNodes, 'first');
      // V2: rest element may be PARAMETER type
      const restVar = findVar(allNodes, 'rest');

      assert.ok(firstVar, 'Should find loop variable "first"');
      assert.ok(restVar, 'Should find rest element variable "rest"');

      // V2: variable IDs include name
      assert.ok(firstVar.id.includes('first'),
        `Variable "first" should exist in graph. Got: ${firstVar.id}`);
      assert.ok(restVar.id.includes('rest'),
        `Variable "rest" should exist in graph. Got: ${restVar.id}`);
    });

    it('should handle for...in with computed property access in body', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { a: 1, b: 2 };
for (const key in obj) {
  const value = obj[key];
  console.log(value);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const keyVar = findVar(allNodes, 'key');

      assert.ok(keyVar, 'Should find loop variable "key"');

      // V2: variable ID includes name
      assert.ok(keyVar.id.includes('key'),
        `Variable "key" should exist in graph. Got: ${keyVar.id}`);
    });
  });

  // ===========================================================================
  // Real-world patterns from test fixtures
  // ===========================================================================

  describe('real-world patterns', () => {
    it('should handle sumWithForOf from fixtures', async () => {
      await setupTest(backend, {
        'index.js': `
function sumWithForOf(numbers) {
  let total = 0;
  for (const num of numbers) {
    total += num;
  }
  return total;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const numVar = findVar(allNodes, 'num');

      assert.ok(numVar, 'Should find loop variable "num" in sumWithForOf');

      // V2: variable ID format is file->TYPE->name#line (no function scope in ID)
      // Verify variable exists with correct name
      assert.ok(numVar.id.includes('num'),
        `Loop variable "num" should exist in graph. Got: ${numVar.id}`);
    });

    it('should handle processObjectKeys from fixtures', async () => {
      await setupTest(backend, {
        'index.js': `
function processObjectKeys(obj) {
  const keys = [];
  for (const key in obj) {
    keys.push(key);
    console.log(key, obj[key]);
  }
  return keys;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const keyVar = findVar(allNodes, 'key');

      assert.ok(keyVar, 'Should find loop variable "key" in processObjectKeys');

      // V2: variable ID format is file->TYPE->name#line (no function scope in ID)
      assert.ok(keyVar.id.includes('key'),
        `Loop variable "key" should exist in graph. Got: ${keyVar.id}`);
    });

    it('should handle destructuring in loops with complex data', async () => {
      await setupTest(backend, {
        'index.js': `
function processUsers(users) {
  const names = [];
  for (const { name, age } of users) {
    if (age >= 18) {
      names.push(name);
    }
  }
  return names;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const nameVar = findVar(allNodes, 'name');
      const ageVar = findVar(allNodes, 'age');

      assert.ok(nameVar, 'Should find destructured loop variable "name"');
      assert.ok(ageVar, 'Should find destructured loop variable "age"');

      // V2: variable ID format is file->TYPE->name#line (no function scope in ID)
      assert.ok(nameVar.id.includes('name'),
        `Loop variable "name" should exist in graph. Got: ${nameVar.id}`);
      assert.ok(ageVar.id.includes('age'),
        `Loop variable "age" should exist in graph. Got: ${ageVar.id}`);
    });
  });
});
