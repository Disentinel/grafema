/**
 * Yield Expression Edges Tests (REG-270)
 *
 * Tests for YIELDS and DELEGATES_TO edge creation from yield expressions to containing generator functions.
 *
 * Edge direction:
 * - For yield:  yieldedExpression --YIELDS--> generatorFunction
 * - For yield*: delegatedCall --DELEGATES_TO--> generatorFunction
 *
 * This enables tracing data flow through generator functions:
 * - Query: "What does this generator yield?"
 * - Answer: Follow YIELDS edges from function to see all possible yielded values
 * - Query: "What generators does this delegate to?"
 * - Answer: Follow DELEGATES_TO edges from function
 *
 * Test cases:
 * 1. Basic yield with literal: `yield 42;` - LITERAL --YIELDS--> FUNCTION
 * 2. Yield with variable: `yield result;` - VARIABLE --YIELDS--> FUNCTION
 * 3. Yield with function call: `yield foo();` - CALL --YIELDS--> FUNCTION
 * 4. Yield with method call: `yield obj.method();` - CALL --YIELDS--> FUNCTION
 * 5. Multiple yields: All create edges
 * 6. yield* with function call: `yield* other();` - CALL --DELEGATES_TO--> FUNCTION
 * 7. yield* with variable: `yield* gen;` - VARIABLE --DELEGATES_TO--> FUNCTION
 * 8. Async generator: `async function* gen() { yield 1; }`
 * 9. Bare yield: `yield;` - NO edge created
 * 10. Yield parameter: `yield x;` where x is parameter - PARAMETER --YIELDS--> FUNCTION
 * 11. Nested function: yields inside callbacks don't create edges for outer function
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

describe('YIELDS/DELEGATES_TO Edges (REG-270)', () => {
  let db;
  let backend;
  let testDir;
  let testCounter = 0;

  /**
   * Create a temporary test directory with specified files
   */
  async function setupTest(files) {
    testDir = join(tmpdir(), `grafema-test-yields-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    // Create package.json to make it a valid project
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-yields-${testCounter}`, type: 'module' })
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

  describe('Basic yield with literal', () => {
    it('should create YIELDS edge for numeric literal yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* numberGen() {
  yield 42;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the generator function
      const func = allNodes.find(n => n.name === 'numberGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function "numberGen" should exist');
      assert.strictEqual(func.generator, true, 'Function should be marked as generator');

      // Find YIELDS edge pointing to function
      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist for numberGen()');

      // Verify source is a LITERAL
      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
      assert.strictEqual(source.value, 42, 'Literal value should be 42');
    });

    it('should create YIELDS edge for string literal yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* stringGen() {
  yield 'hello';
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'stringGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'LITERAL');
      assert.strictEqual(source.value, 'hello');
    });
  });

  describe('Yield with variable', () => {
    it('should create YIELDS edge for variable yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* varGen() {
  const result = 42;
  yield result;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'varGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(['VARIABLE', 'CONSTANT'].includes(source.type), `Expected VARIABLE/CONSTANT, got ${source.type}`);
      assert.strictEqual(source.name, 'result');
    });
  });

  describe('Yield with function call', () => {
    it('should create YIELDS edge for function call yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getValue() { return 42; }
function* callGen() {
  yield getValue();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'callGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'CALL');
      assert.strictEqual(source.name, 'getValue');
    });
  });

  describe('yield* delegation', () => {
    it('should create DELEGATES_TO edge for yield* with function call', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* innerGen() {
  yield 1;
  yield 2;
}
function* outerGen() {
  yield* innerGen();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerFunc = allNodes.find(n => n.name === 'outerGen' && n.type === 'FUNCTION');
      assert.ok(outerFunc, 'Outer generator should exist');

      // Find DELEGATES_TO edge pointing to outerGen
      const delegatesEdge = allEdges.find(e =>
        e.type === 'DELEGATES_TO' && e.dst === outerFunc.id
      );
      assert.ok(delegatesEdge, 'DELEGATES_TO edge should exist for yield*');

      // Verify source is a CALL to innerGen
      const source = allNodes.find(n => n.id === delegatesEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'CALL');
      assert.strictEqual(source.name, 'innerGen');
    });

    it('should create DELEGATES_TO edge for yield* with variable', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* innerGen() { yield 1; }
function* outerGen() {
  const gen = innerGen();
  yield* gen;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerFunc = allNodes.find(n => n.name === 'outerGen' && n.type === 'FUNCTION');
      assert.ok(outerFunc, 'Outer generator should exist');

      const delegatesEdge = allEdges.find(e =>
        e.type === 'DELEGATES_TO' && e.dst === outerFunc.id
      );
      assert.ok(delegatesEdge, 'DELEGATES_TO edge should exist');

      const source = allNodes.find(n => n.id === delegatesEdge.src);
      assert.ok(['VARIABLE', 'CONSTANT'].includes(source.type));
      assert.strictEqual(source.name, 'gen');
    });
  });

  describe('Multiple yields', () => {
    it('should create YIELDS edges for all yields in generator', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* multiGen() {
  yield 1;
  yield 2;
  yield 3;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'multiGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function should exist');

      // Find all YIELDS edges pointing to this function
      const yieldsEdges = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.strictEqual(yieldsEdges.length, 3, 'Should have 3 YIELDS edges');

      // Verify all sources are literals with values 1, 2, 3
      const values = yieldsEdges.map(e => {
        const src = allNodes.find(n => n.id === e.src);
        return src?.value;
      }).sort();
      assert.deepStrictEqual(values, [1, 2, 3]);
    });
  });

  describe('Async generators', () => {
    it('should create YIELDS edges for async generator', async () => {
      const projectPath = await setupTest({
        'index.js': `
async function* asyncGen() {
  yield 1;
  yield 2;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'asyncGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Async generator should exist');
      assert.strictEqual(func.async, true, 'Should be async');
      assert.strictEqual(func.generator, true, 'Should be generator');

      const yieldsEdges = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.strictEqual(yieldsEdges.length, 2, 'Should have 2 YIELDS edges');
    });
  });

  describe('Bare yield', () => {
    it('should NOT create edge for bare yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* bareGen() {
  yield;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'bareGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator should exist');

      // Should NOT have any YIELDS edges
      const yieldsEdges = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.strictEqual(yieldsEdges.length, 0, 'Should have no YIELDS edges for bare yield');
    });
  });

  describe('Yield parameter', () => {
    it('should create YIELDS edge for parameter yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* paramGen(x) {
  yield x;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'paramGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'PARAMETER');
      assert.strictEqual(source.name, 'x');
    });
  });

  describe('Nested functions', () => {
    // SKIP: Grafema doesn't currently track nested function declarations.
    // When this is implemented, this test should verify that yields inside nested functions
    // create YIELDS edges to the inner function, not the outer function.
    it.skip('should NOT create YIELDS edge for yield in nested function', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* outerGen() {
  function* innerGen() {
    yield 'inner';
  }
  yield 'outer';
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerFunc = allNodes.find(n => n.name === 'outerGen' && n.type === 'FUNCTION');
      const innerFunc = allNodes.find(n => n.name === 'innerGen' && n.type === 'FUNCTION');

      assert.ok(outerFunc, 'Outer generator should exist');
      assert.ok(innerFunc, 'Inner generator should exist');

      // Outer should have YIELDS edge for 'outer'
      const outerYields = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === outerFunc.id
      );
      assert.strictEqual(outerYields.length, 1, 'Outer should have 1 YIELDS edge');

      // Inner should have YIELDS edge for 'inner'
      const innerYields = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === innerFunc.id
      );
      assert.strictEqual(innerYields.length, 1, 'Inner should have 1 YIELDS edge');

      // Verify outer yields 'outer' and inner yields 'inner'
      const outerSrc = allNodes.find(n => n.id === outerYields[0].src);
      const innerSrc = allNodes.find(n => n.id === innerYields[0].src);
      assert.strictEqual(outerSrc.value, 'outer');
      assert.strictEqual(innerSrc.value, 'inner');
    });
  });

  describe('Yield with method call', () => {
    it('should create YIELDS edge for method call yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
const obj = { getValue: () => 42 };
function* methodGen() {
  yield obj.getValue();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'methodGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'CALL');
    });
  });

  describe('Edge direction verification', () => {
    it('should create edge from yield value TO function (src=value, dst=function)', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* gen() {
  yield 42;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'gen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator should exist');

      const yieldsEdge = allEdges.find(e => e.type === 'YIELDS');
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      // Verify edge direction: src=value, dst=function
      assert.strictEqual(
        yieldsEdge.dst, func.id,
        'YIELDS edge destination should be the function'
      );

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.notStrictEqual(
        source.type, 'FUNCTION',
        'YIELDS edge source should NOT be the function'
      );
    });
  });

  describe('No duplicates on re-run', () => {
    it('should not create duplicate YIELDS edges when run twice', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* gen() {
  yield 42;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);

      // First run
      await orchestrator.run(projectPath);

      const allEdges1 = await backend.getAllEdges();
      const yieldsEdges1 = allEdges1.filter(e => e.type === 'YIELDS');
      const count1 = yieldsEdges1.length;

      // Second run
      await orchestrator.run(projectPath);

      const allEdges2 = await backend.getAllEdges();
      const yieldsEdges2 = allEdges2.filter(e => e.type === 'YIELDS');
      const count2 = yieldsEdges2.length;

      assert.strictEqual(
        count2, count1,
        `YIELDS edge count should not increase on re-run (was ${count1}, now ${count2})`
      );
    });
  });

  /**
   * Yield expressions (similar to REG-276 for return expressions)
   *
   * Tests for YIELDS edges from complex expressions (BinaryExpression,
   * ConditionalExpression, MemberExpression, etc.) to containing generator functions.
   *
   * When a generator yields a complex expression, we create:
   * 1. An EXPRESSION node representing the yield value
   * 2. DERIVES_FROM edges connecting the EXPRESSION to its source variables/parameters
   * 3. A YIELDS edge connecting the EXPRESSION to the function
   */
  describe('Yield expressions', () => {
    it('should create YIELDS edge for BinaryExpression yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* addGen(a, b) {
  yield a + b;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'addGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator "addGen" should exist');

      // YIELDS edge should exist
      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      // Source should be an EXPRESSION node
      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'EXPRESSION', `Expected EXPRESSION, got ${source.type}`);
      assert.strictEqual(source.expressionType, 'BinaryExpression', 'Should be BinaryExpression');

      // DERIVES_FROM edges to parameters a and b
      const derivesFromEdges = allEdges.filter(e =>
        e.type === 'DERIVES_FROM' && e.src === source.id
      );
      assert.strictEqual(derivesFromEdges.length, 2, 'Should have 2 DERIVES_FROM edges');

      const paramA = allNodes.find(n => n.name === 'a' && n.type === 'PARAMETER');
      const paramB = allNodes.find(n => n.name === 'b' && n.type === 'PARAMETER');
      assert.ok(paramA && paramB, 'Parameters a and b should exist');

      const targetIds = derivesFromEdges.map(e => e.dst);
      assert.ok(targetIds.includes(paramA.id), 'Should derive from parameter a');
      assert.ok(targetIds.includes(paramB.id), 'Should derive from parameter b');
    });

    it('should create YIELDS edge for MemberExpression yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* propGen(obj) {
  yield obj.name;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'propGen' && n.type === 'FUNCTION');
      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'EXPRESSION');
      assert.strictEqual(source.expressionType, 'MemberExpression');

      // Should derive from obj parameter
      const derivesFromEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM' && e.src === source.id
      );
      assert.ok(derivesFromEdge, 'Should have DERIVES_FROM edge');

      const objParam = allNodes.find(n => n.name === 'obj' && n.type === 'PARAMETER');
      assert.strictEqual(derivesFromEdge.dst, objParam.id, 'Should derive from obj');
    });

    it('should create YIELDS edge for ConditionalExpression yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* pickGen(condition, x, y) {
  yield condition ? x : y;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'pickGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator "pickGen" should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'EXPRESSION');
      assert.strictEqual(source.expressionType, 'ConditionalExpression');

      // Should derive from x and y (consequent and alternate)
      const derivesFromEdges = allEdges.filter(e =>
        e.type === 'DERIVES_FROM' && e.src === source.id
      );
      assert.strictEqual(derivesFromEdges.length, 2, 'Should derive from x and y');
    });
  });

  describe('Generator arrow functions', () => {
    // Note: Arrow functions cannot be generators in JavaScript.
    // SKIP: Grafema doesn't currently track anonymous function expressions.
    // The function exists but has no name, so it can't be found by `n.name === 'gen'`.
    // When this is implemented, the function should inherit the variable name.
    it.skip('should create YIELDS edge for generator function expression', async () => {
      const projectPath = await setupTest({
        'index.js': `
const gen = function* () {
  yield 42;
};
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'gen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function expression should exist');
      assert.strictEqual(func.generator, true, 'Should be marked as generator');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');
    });
  });

  describe('Mixed yields and delegations', () => {
    it('should create both YIELDS and DELEGATES_TO edges in same function', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* innerGen() { yield 'inner'; }
function* mixedGen() {
  yield 1;
  yield* innerGen();
  yield 2;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const mixedFunc = allNodes.find(n => n.name === 'mixedGen' && n.type === 'FUNCTION');
      assert.ok(mixedFunc, 'Mixed generator should exist');

      // Should have 2 YIELDS edges (for yield 1 and yield 2)
      const yieldsEdges = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === mixedFunc.id
      );
      assert.strictEqual(yieldsEdges.length, 2, 'Should have 2 YIELDS edges');

      // Should have 1 DELEGATES_TO edge (for yield* innerGen())
      const delegatesEdges = allEdges.filter(e =>
        e.type === 'DELEGATES_TO' && e.dst === mixedFunc.id
      );
      assert.strictEqual(delegatesEdges.length, 1, 'Should have 1 DELEGATES_TO edge');
    });
  });

  describe('Yield in class methods', () => {
    it('should create YIELDS edge for generator method', async () => {
      const projectPath = await setupTest({
        'index.js': `
class Counter {
  *count(n) {
    for (let i = 1; i <= n; i++) {
      yield i;
    }
  }
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the generator method
      const method = allNodes.find(n =>
        n.name === 'count' && (n.type === 'METHOD' || n.type === 'FUNCTION')
      );
      assert.ok(method, 'Generator method "count" should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === method.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist for generator method');

      // Source should be the loop variable i
      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.name, 'i', 'Should yield loop variable i');
    });
  });

  describe('yield* with iterable literals', () => {
    it('should create DELEGATES_TO edge for yield* with array literal', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* arrayGen() {
  yield* [1, 2, 3];
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'arrayGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator should exist');

      // yield* [1,2,3] should create a DELEGATES_TO edge
      const delegatesEdge = allEdges.find(e =>
        e.type === 'DELEGATES_TO' && e.dst === func.id
      );
      assert.ok(delegatesEdge, 'DELEGATES_TO edge should exist for yield* with array');
    });
  });
});
