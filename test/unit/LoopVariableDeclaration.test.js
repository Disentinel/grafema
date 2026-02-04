/**
 * Loop Variable Declaration Tests (REG-272)
 *
 * Tests for tracking loop variable declarations in for...of and for...in statements.
 * These tests verify that:
 * 1. Simple loop variables are tracked (for const x of arr)
 * 2. Object destructuring is tracked (for const { a, b } of arr)
 * 3. Array destructuring is tracked (for const [a, b] of arr)
 * 4. DERIVES_FROM edges connect to source collection
 * 5. Variables are scoped correctly to loop body
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
      const xVar = allNodes.find(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(xVar, 'Should find loop variable "x"');

      // Variable should be CONSTANT (const declaration)
      assert.strictEqual(xVar.type, 'CONSTANT',
        `Loop variable with const should be CONSTANT, got ${xVar.type}`);

      // Semantic ID should include for-of scope
      assert.ok(xVar.id.includes('for-of') || xVar.id.includes('for#'),
        `Loop variable ID should include loop scope. Got: ${xVar.id}`);
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
      const xVar = allNodes.find(n =>
        n.name === 'x' && n.type === 'VARIABLE'
      );

      assert.ok(xVar, 'Should find loop variable "x"');

      // Variable should be VARIABLE (let declaration)
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
      const xVar = allNodes.find(n =>
        n.name === 'x' && n.type === 'VARIABLE'
      );

      assert.ok(xVar, 'Should find loop variable "x"');
      assert.strictEqual(xVar.type, 'VARIABLE',
        `Loop variable with var should be VARIABLE, got ${xVar.type}`);
    });

    it('should create DERIVES_FROM edge to source array', async () => {
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

      const numVar = allNodes.find(n => n.name === 'num');
      assert.ok(numVar, 'Should find loop variable "num"');

      const numbersVar = allNodes.find(n => n.name === 'numbers');
      assert.ok(numbersVar, 'Should find source variable "numbers"');

      // Check for DERIVES_FROM edge from num to numbers
      const derivesEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM' &&
        e.src === numVar.id &&
        e.dst === numbersVar.id
      );

      assert.ok(derivesEdge,
        `Loop variable should have DERIVES_FROM edge to source array. ` +
        `Expected edge from ${numVar.id} to ${numbersVar.id}. ` +
        `Found edges from num: ${JSON.stringify(allEdges.filter(e => e.src === numVar.id))}`
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
      const keyVar = allNodes.find(n =>
        n.name === 'key' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(keyVar, 'Should find loop variable "key"');

      // Semantic ID should include for-in scope
      assert.ok(keyVar.id.includes('for-in') || keyVar.id.includes('for#'),
        `Loop variable ID should include loop scope. Got: ${keyVar.id}`);
    });

    it('should create DERIVES_FROM edge to source object', async () => {
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

      const propVar = allNodes.find(n => n.name === 'prop');
      assert.ok(propVar, 'Should find loop variable "prop"');

      const configVar = allNodes.find(n => n.name === 'config');
      assert.ok(configVar, 'Should find source variable "config"');

      // Check for DERIVES_FROM edge from prop to config
      const derivesEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM' &&
        e.src === propVar.id &&
        e.dst === configVar.id
      );

      assert.ok(derivesEdge,
        `Loop variable should have DERIVES_FROM edge to source object. ` +
        `Expected edge from ${propVar.id} to ${configVar.id}. ` +
        `Found edges from prop: ${JSON.stringify(allEdges.filter(e => e.src === propVar.id))}`
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

      const xVar = allNodes.find(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const yVar = allNodes.find(n =>
        n.name === 'y' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(xVar, 'Should find destructured variable "x"');
      assert.ok(yVar, 'Should find destructured variable "y"');

      // Both should be scoped to loop
      assert.ok(xVar.id.includes('for-of') || xVar.id.includes('for#'),
        `Variable "x" should be in loop scope. Got: ${xVar.id}`);
      assert.ok(yVar.id.includes('for-of') || yVar.id.includes('for#'),
        `Variable "y" should be in loop scope. Got: ${yVar.id}`);
    });

    it('should create DERIVES_FROM edges for destructured properties', async () => {
      await setupTest(backend, {
        'index.js': `
const users = [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 30 }];
for (const { name, age } of users) {
  console.log(name, age);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const nameVar = allNodes.find(n => n.name === 'name');
      const ageVar = allNodes.find(n => n.name === 'age');
      const usersVar = allNodes.find(n => n.name === 'users');

      assert.ok(nameVar, 'Should find variable "name"');
      assert.ok(ageVar, 'Should find variable "age"');
      assert.ok(usersVar, 'Should find source variable "users"');

      // Check DERIVES_FROM edges
      // These should point to EXPRESSION nodes representing users.name and users.age
      const nameEdges = allEdges.filter(e =>
        e.type === 'DERIVES_FROM' && e.src === nameVar.id
      );
      const ageEdges = allEdges.filter(e =>
        e.type === 'DERIVES_FROM' && e.src === ageVar.id
      );

      assert.ok(nameEdges.length > 0,
        `Variable "name" should have DERIVES_FROM edge. ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.src === nameVar.id))}`
      );
      assert.ok(ageEdges.length > 0,
        `Variable "age" should have DERIVES_FROM edge. ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.src === ageVar.id))}`
      );

      // The target should be an EXPRESSION node or the source array
      const nameTarget = allNodes.find(n => n.id === nameEdges[0].dst);
      const ageTarget = allNodes.find(n => n.id === ageEdges[0].dst);

      assert.ok(nameTarget,
        `Target for "name" DERIVES_FROM edge should exist. Edge dst: ${nameEdges[0].dst}`
      );
      assert.ok(ageTarget,
        `Target for "age" DERIVES_FROM edge should exist. Edge dst: ${ageEdges[0].dst}`
      );

      // Target should be EXPRESSION or point back to source variable
      const validTypes = ['EXPRESSION', 'VARIABLE', 'CONSTANT'];
      assert.ok(validTypes.includes(nameTarget.type),
        `Target for "name" should be ${validTypes.join('/')}, got ${nameTarget.type}`
      );
      assert.ok(validTypes.includes(ageTarget.type),
        `Target for "age" should be ${validTypes.join('/')}, got ${ageTarget.type}`
      );
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

      const nameVar = allNodes.find(n =>
        n.name === 'name' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(nameVar, 'Should find nested destructured variable "name"');

      // Should be scoped to loop
      assert.ok(nameVar.id.includes('for-of') || nameVar.id.includes('for#'),
        `Nested destructured variable should be in loop scope. Got: ${nameVar.id}`);
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
      const newNameVar = allNodes.find(n =>
        n.name === 'newName' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(newNameVar, 'Should find renamed variable "newName"');

      // Should NOT find variable named 'oldName' from destructuring
      const oldNameVars = allNodes.filter(n =>
        n.name === 'oldName' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      // 'oldName' might exist if there's an 'items' object literal, but not as loop variable
      // We check that newName is the loop variable, not oldName
      assert.ok(newNameVar.id.includes('for-of') || newNameVar.id.includes('for#'),
        `Renamed variable should be in loop scope. Got: ${newNameVar.id}`);
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

      const aVar = allNodes.find(n =>
        n.name === 'a' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const bVar = allNodes.find(n =>
        n.name === 'b' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(aVar, 'Should find destructured variable "a"');
      assert.ok(bVar, 'Should find destructured variable "b"');

      // Both should be scoped to loop
      assert.ok(aVar.id.includes('for-of') || aVar.id.includes('for#'),
        `Variable "a" should be in loop scope. Got: ${aVar.id}`);
      assert.ok(bVar.id.includes('for-of') || bVar.id.includes('for#'),
        `Variable "b" should be in loop scope. Got: ${bVar.id}`);
    });

    it('should create DERIVES_FROM edges for array elements', async () => {
      await setupTest(backend, {
        'index.js': `
const coords = [[10, 20], [30, 40]];
for (const [x, y] of coords) {
  console.log(x, y);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x');
      const yVar = allNodes.find(n => n.name === 'y');
      const coordsVar = allNodes.find(n => n.name === 'coords');

      assert.ok(xVar, 'Should find variable "x"');
      assert.ok(yVar, 'Should find variable "y"');
      assert.ok(coordsVar, 'Should find source variable "coords"');

      // Check DERIVES_FROM edges
      const xEdges = allEdges.filter(e =>
        e.type === 'DERIVES_FROM' && e.src === xVar.id
      );
      const yEdges = allEdges.filter(e =>
        e.type === 'DERIVES_FROM' && e.src === yVar.id
      );

      assert.ok(xEdges.length > 0,
        `Variable "x" should have DERIVES_FROM edge. ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.src === xVar.id))}`
      );
      assert.ok(yEdges.length > 0,
        `Variable "y" should have DERIVES_FROM edge. ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.src === yVar.id))}`
      );
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

      const aVar = allNodes.find(n =>
        n.name === 'a' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const bVar = allNodes.find(n =>
        n.name === 'b' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const cVar = allNodes.find(n =>
        n.name === 'c' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(aVar, 'Should find nested destructured variable "a"');
      assert.ok(bVar, 'Should find nested destructured variable "b"');
      assert.ok(cVar, 'Should find destructured variable "c"');

      // All should be scoped to loop
      assert.ok(aVar.id.includes('for-of') || aVar.id.includes('for#'),
        `Variable "a" should be in loop scope. Got: ${aVar.id}`);
      assert.ok(bVar.id.includes('for-of') || bVar.id.includes('for#'),
        `Variable "b" should be in loop scope. Got: ${bVar.id}`);
      assert.ok(cVar.id.includes('for-of') || cVar.id.includes('for#'),
        `Variable "c" should be in loop scope. Got: ${cVar.id}`);
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

      const firstVar = allNodes.find(n =>
        n.name === 'first' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(firstVar, 'Should find mixed destructured variable "first"');

      // Should be scoped to loop
      assert.ok(firstVar.id.includes('for-of') || firstVar.id.includes('for#'),
        `Mixed destructured variable should be in loop scope. Got: ${firstVar.id}`);
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

      const nameVar = allNodes.find(n =>
        n.name === 'name' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(nameVar, 'Should find mixed destructured variable "name"');

      // Should be scoped to loop
      assert.ok(nameVar.id.includes('for-of') || nameVar.id.includes('for#'),
        `Mixed destructured variable should be in loop scope. Got: ${nameVar.id}`);
    });
  });

  // ===========================================================================
  // Scope verification
  // ===========================================================================

  describe('loop scope verification', () => {
    it('should scope loop variables to loop body, not parent scope', async () => {
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

      const itemVar = allNodes.find(n =>
        n.name === 'item' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

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

      const xVars = allNodes.filter(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      // Should have 2 distinct variables named 'x', each in different loop scope
      assert.strictEqual(xVars.length, 2,
        `Should have 2 distinct loop variables named "x". Found: ${xVars.length}`);

      // IDs should be different
      assert.notStrictEqual(xVars[0].id, xVars[1].id,
        `Loop variables in different loops should have different IDs. ` +
        `Got: ${xVars[0].id} and ${xVars[1].id}`);

      // Both should include for-of scope
      xVars.forEach((xVar, i) => {
        assert.ok(xVar.id.includes('for-of') || xVar.id.includes('for#'),
          `Loop variable ${i} should be in loop scope. Got: ${xVar.id}`);
      });
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

      const rowVar = allNodes.find(n =>
        n.name === 'row' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const xVar = allNodes.find(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(rowVar, 'Should find outer loop variable "row"');
      assert.ok(xVar, 'Should find inner loop variable "x"');

      // Both should be in loop scopes
      assert.ok(rowVar.id.includes('for-of') || rowVar.id.includes('for#'),
        `Outer loop variable should be in loop scope. Got: ${rowVar.id}`);
      assert.ok(xVar.id.includes('for-of') || xVar.id.includes('for#'),
        `Inner loop variable should be in loop scope. Got: ${xVar.id}`);

      // Inner loop variable should have more scope depth
      const rowDepth = (rowVar.id.match(/->/g) || []).length;
      const xDepth = (xVar.id.match(/->/g) || []).length;

      assert.ok(xDepth > rowDepth,
        `Inner loop variable should have deeper scope nesting. ` +
        `row depth: ${rowDepth}, x depth: ${xDepth}. ` +
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

      const xVar = allNodes.find(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

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

      const xVar = allNodes.find(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

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

      const firstVar = allNodes.find(n =>
        n.name === 'first' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const restVar = allNodes.find(n =>
        n.name === 'rest' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(firstVar, 'Should find loop variable "first"');
      assert.ok(restVar, 'Should find rest element variable "rest"');

      // Both should be scoped to loop
      assert.ok(firstVar.id.includes('for-of') || firstVar.id.includes('for#'),
        `Variable "first" should be in loop scope. Got: ${firstVar.id}`);
      assert.ok(restVar.id.includes('for-of') || restVar.id.includes('for#'),
        `Variable "rest" should be in loop scope. Got: ${restVar.id}`);
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

      const keyVar = allNodes.find(n =>
        n.name === 'key' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(keyVar, 'Should find loop variable "key"');

      // key should be usable in computed property access
      // This test just ensures loop variable is tracked, not testing usage
      assert.ok(keyVar.id.includes('for-in') || keyVar.id.includes('for#'),
        `Variable "key" should be in loop scope. Got: ${keyVar.id}`);
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

      const numVar = allNodes.find(n =>
        n.name === 'num' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(numVar, 'Should find loop variable "num" in sumWithForOf');

      // Should be scoped to sumWithForOf -> for-of
      assert.ok(numVar.id.includes('sumWithForOf'),
        `Loop variable should be in function scope. Got: ${numVar.id}`);
      assert.ok(numVar.id.includes('for-of') || numVar.id.includes('for#'),
        `Loop variable should be in loop scope. Got: ${numVar.id}`);
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

      const keyVar = allNodes.find(n =>
        n.name === 'key' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(keyVar, 'Should find loop variable "key" in processObjectKeys');

      // Should be scoped to processObjectKeys -> for-in
      assert.ok(keyVar.id.includes('processObjectKeys'),
        `Loop variable should be in function scope. Got: ${keyVar.id}`);
      assert.ok(keyVar.id.includes('for-in') || keyVar.id.includes('for#'),
        `Loop variable should be in loop scope. Got: ${keyVar.id}`);
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

      const nameVar = allNodes.find(n =>
        n.name === 'name' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const ageVar = allNodes.find(n =>
        n.name === 'age' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(nameVar, 'Should find destructured loop variable "name"');
      assert.ok(ageVar, 'Should find destructured loop variable "age"');

      // Both should be scoped to processUsers -> for-of
      assert.ok(nameVar.id.includes('processUsers'),
        `Loop variable should be in function scope. Got: ${nameVar.id}`);
      assert.ok(nameVar.id.includes('for-of') || nameVar.id.includes('for#'),
        `Loop variable should be in loop scope. Got: ${nameVar.id}`);
      assert.ok(ageVar.id.includes('for-of') || ageVar.id.includes('for#'),
        `Loop variable should be in loop scope. Got: ${ageVar.id}`);
    });
  });
});
