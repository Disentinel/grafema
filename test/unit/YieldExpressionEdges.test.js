/**
 * Yield Expression Edges Tests (REG-270)
 *
 * Tests for YIELDS and DELEGATES_TO edge creation from yield expressions.
 *
 * V2 edge direction:
 * - For yield:  EXPRESSION(yield) --YIELDS--> yielded_value
 * - For yield*: FUNCTION --DELEGATES_TO--> EXPRESSION(yield*)
 *               EXPRESSION(yield*) --YIELDS--> delegated_value
 *
 * This enables tracing data flow through generator functions:
 * - Query: "What does this generator yield?"
 * - Answer: Find EXPRESSION(yield) nodes contained by the function, follow YIELDS edges to values
 * - Query: "What generators does this delegate to?"
 * - Answer: Follow DELEGATES_TO edges from function to yield* expressions
 *
 * Test cases:
 * 1. Basic yield with literal: `yield 42;` - EXPRESSION(yield) --YIELDS--> LITERAL(42)
 * 2. Yield with variable: `yield result;` - EXPRESSION(yield) --YIELDS--> VARIABLE(result)
 * 3. Yield with function call: `yield foo();` - EXPRESSION(yield) --YIELDS--> CALL(foo)
 * 4. Yield with method call: `yield obj.method();` - EXPRESSION(yield) --YIELDS--> CALL(obj.method)
 * 5. Multiple yields: All create YIELDS edges
 * 6. yield* with function call: FUNCTION --DELEGATES_TO--> EXPRESSION(yield*)
 * 7. yield* with variable: FUNCTION --DELEGATES_TO--> EXPRESSION(yield*)
 * 8. Async generator: `async function* gen() { yield 1; }`
 * 9. Bare yield: `yield;` - NO YIELDS edge created
 * 10. Yield parameter: `yield x;` where x is parameter - EXPRESSION(yield) --YIELDS--> PARAMETER(x)
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

      // V2: YIELDS edge direction is EXPRESSION(yield) -> yielded_value
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
      assert.ok(yieldsEdges.length > 0, 'YIELDS edge should exist for numberGen()');

      // Verify the yielded value is a LITERAL with value 42
      const yieldedValues = yieldsEdges.map(e => allNodes.find(n => n.id === e.dst));
      const literal42 = yieldedValues.find(n => n && n.type === 'LITERAL' && n.value === 42);
      assert.ok(literal42, 'Should yield LITERAL 42');
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

      // V2: YIELDS edge direction is EXPRESSION(yield) -> yielded_value
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
      assert.ok(yieldsEdges.length > 0, 'YIELDS edge should exist');

      const yieldedValues = yieldsEdges.map(e => allNodes.find(n => n.id === e.dst));
      const helloLiteral = yieldedValues.find(n => n && n.type === 'LITERAL' && n.value === 'hello');
      assert.ok(helloLiteral, 'Should yield LITERAL "hello"');
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

      // V2: YIELDS edge direction is EXPRESSION(yield) -> yielded_value
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
      assert.ok(yieldsEdges.length > 0, 'YIELDS edge should exist');

      const yieldedValues = yieldsEdges.map(e => allNodes.find(n => n.id === e.dst));
      const resultVar = yieldedValues.find(n => n && ['VARIABLE', 'CONSTANT'].includes(n.type) && n.name === 'result');
      assert.ok(resultVar, 'Should yield variable "result"');
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

      // V2: YIELDS edge direction is EXPRESSION(yield) -> yielded_value
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
      assert.ok(yieldsEdges.length > 0, 'YIELDS edge should exist');

      const yieldedValues = yieldsEdges.map(e => allNodes.find(n => n.id === e.dst));
      const getValueCall = yieldedValues.find(n => n && n.type === 'CALL' && n.name === 'getValue');
      assert.ok(getValueCall, 'Should yield CALL to getValue');
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

      // V2: DELEGATES_TO direction is FUNCTION -> EXPRESSION(yield*)
      const delegatesEdge = allEdges.find(e =>
        e.type === 'DELEGATES_TO' && e.src === outerFunc.id
      );
      assert.ok(delegatesEdge, 'DELEGATES_TO edge should exist for yield*');

      // Verify destination is an EXPRESSION(yield*) node
      const dst = allNodes.find(n => n.id === delegatesEdge.dst);
      assert.ok(dst, 'Destination node should exist');
      assert.strictEqual(dst.type, 'EXPRESSION');

      // V2 also creates a YIELDS edge from the yield* EXPRESSION to the delegated CALL
      const yieldsFromDelegate = allEdges.find(e =>
        e.type === 'YIELDS' && e.src === dst.id
      );
      assert.ok(yieldsFromDelegate, 'yield* should also create YIELDS edge to delegated call');

      const yieldedCall = allNodes.find(n => n.id === yieldsFromDelegate.dst);
      assert.ok(yieldedCall, 'Yielded call should exist');
      assert.strictEqual(yieldedCall.type, 'CALL');
      assert.strictEqual(yieldedCall.name, 'innerGen');
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

      // V2: DELEGATES_TO direction is FUNCTION -> EXPRESSION(yield*)
      const delegatesEdge = allEdges.find(e =>
        e.type === 'DELEGATES_TO' && e.src === outerFunc.id
      );
      assert.ok(delegatesEdge, 'DELEGATES_TO edge should exist');

      const dst = allNodes.find(n => n.id === delegatesEdge.dst);
      assert.strictEqual(dst.type, 'EXPRESSION');

      // V2: YIELDS edge from yield* expression to the variable
      const yieldsFromDelegate = allEdges.find(e =>
        e.type === 'YIELDS' && e.src === dst.id
      );
      assert.ok(yieldsFromDelegate, 'yield* should create YIELDS edge to delegated value');

      const yieldedValue = allNodes.find(n => n.id === yieldsFromDelegate.dst);
      assert.ok(['VARIABLE', 'CONSTANT'].includes(yieldedValue.type));
      assert.strictEqual(yieldedValue.name, 'gen');
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

      // V2: YIELDS direction is EXPRESSION(yield) -> value
      // Find all YIELDS edges in the graph
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
      assert.strictEqual(yieldsEdges.length, 3, 'Should have 3 YIELDS edges');

      // Verify all destinations are literals with values 1, 2, 3
      const values = yieldsEdges.map(e => {
        const dst = allNodes.find(n => n.id === e.dst);
        return dst?.value;
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

      // V2: YIELDS direction is EXPRESSION(yield) -> value
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
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
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
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

      // V2: YIELDS direction is EXPRESSION(yield) -> value
      const yieldsEdge = allEdges.find(e => e.type === 'YIELDS');
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const destination = allNodes.find(n => n.id === yieldsEdge.dst);
      assert.strictEqual(destination.type, 'PARAMETER');
      assert.strictEqual(destination.name, 'x');
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

      // Verify yields are correctly scoped
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
      assert.strictEqual(yieldsEdges.length, 2, 'Should have 2 YIELDS edges');
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

      // V2: YIELDS direction is EXPRESSION(yield) -> value
      const yieldsEdge = allEdges.find(e => e.type === 'YIELDS');
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const destination = allNodes.find(n => n.id === yieldsEdge.dst);
      assert.strictEqual(destination.type, 'CALL');
    });
  });

  describe('Edge direction verification', () => {
    it('should create edge from EXPRESSION(yield) TO yielded value (src=expression, dst=value)', async () => {
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

      // V2: Edge direction: src=EXPRESSION(yield), dst=value
      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'EXPRESSION', 'YIELDS edge source should be EXPRESSION');

      const destination = allNodes.find(n => n.id === yieldsEdge.dst);
      assert.ok(destination, 'Destination node should exist');
      assert.strictEqual(destination.type, 'LITERAL', 'YIELDS edge destination should be LITERAL');
      assert.strictEqual(destination.value, 42, 'YIELDS edge destination should be LITERAL 42');
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
   * V2 behavior: When a generator yields a complex expression, we create:
   * 1. A YIELDS edge from EXPRESSION(yield) to the value node
   * 2. The value node may be an EXPRESSION(+), PROPERTY_ACCESS, etc.
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

      // V2: YIELDS edge from EXPRESSION(yield) to EXPRESSION(+)
      const yieldsEdge = allEdges.find(e => e.type === 'YIELDS');
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      // Source should be an EXPRESSION(yield) node
      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'EXPRESSION', `Expected EXPRESSION, got ${source.type}`);

      // Destination should be an EXPRESSION(+) node representing the binary expression
      const destination = allNodes.find(n => n.id === yieldsEdge.dst);
      assert.ok(destination, 'Destination node should exist');
      assert.strictEqual(destination.type, 'EXPRESSION', `Expected EXPRESSION, got ${destination.type}`);
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
      const yieldsEdge = allEdges.find(e => e.type === 'YIELDS');
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      // V2: destination is a PROPERTY_ACCESS node for obj.name
      const destination = allNodes.find(n => n.id === yieldsEdge.dst);
      assert.strictEqual(destination.type, 'PROPERTY_ACCESS');
      assert.strictEqual(destination.name, 'obj.name');
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

      const yieldsEdge = allEdges.find(e => e.type === 'YIELDS');
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      // V2: source is EXPRESSION(yield), destination is the conditional value
      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'EXPRESSION');

      const destination = allNodes.find(n => n.id === yieldsEdge.dst);
      assert.ok(destination, 'Destination node should exist');
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

      const yieldsEdge = allEdges.find(e => e.type === 'YIELDS');
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

      // V2: YIELDS edges go from EXPRESSION(yield) -> value
      // For mixedGen: yield 1, yield 2, and yield* innerGen() all create YIELDS edges
      const yieldsEdges = allEdges.filter(e => e.type === 'YIELDS');
      // innerGen has 1 yield ('inner'), mixedGen has yield 1, yield 2, and yield* innerGen()
      // yield* creates a YIELDS edge too
      assert.ok(yieldsEdges.length >= 3, `Should have at least 3 YIELDS edges (got ${yieldsEdges.length})`);

      // V2: DELEGATES_TO direction is FUNCTION -> EXPRESSION(yield*)
      const delegatesEdges = allEdges.filter(e =>
        e.type === 'DELEGATES_TO' && e.src === mixedFunc.id
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

      // V2: Generator method creates a METHOD node
      const method = allNodes.find(n =>
        n.name === 'count' && (n.type === 'METHOD' || n.type === 'FUNCTION')
      );
      assert.ok(method, 'Generator method "count" should exist');

      // V2: YIELDS from EXPRESSION(yield) -> VARIABLE(i)
      const yieldsEdge = allEdges.find(e => e.type === 'YIELDS');
      assert.ok(yieldsEdge, 'YIELDS edge should exist for generator method');

      // Destination should be the loop variable i
      const destination = allNodes.find(n => n.id === yieldsEdge.dst);
      assert.ok(destination, 'Destination node should exist');
      assert.strictEqual(destination.name, 'i', 'Should yield loop variable i');
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

      // V2: DELEGATES_TO direction is FUNCTION -> EXPRESSION(yield*)
      const delegatesEdge = allEdges.find(e =>
        e.type === 'DELEGATES_TO' && e.src === func.id
      );
      assert.ok(delegatesEdge, 'DELEGATES_TO edge should exist for yield* with array');
    });
  });
});
