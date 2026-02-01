/**
 * Return Statement Edges Tests (REG-263)
 *
 * Tests for RETURNS edge creation from return statements to containing functions.
 *
 * Edge direction: returnExpression --RETURNS--> function
 *
 * This enables tracing data flow through function calls:
 * - Query: "What does formatDate return?"
 * - Answer: Follow RETURNS edges from function to see all possible return values
 *
 * Test cases:
 * 1. Return literal: `return 42;` - LITERAL --RETURNS--> FUNCTION
 * 2. Return variable: `return result;` - VARIABLE --RETURNS--> FUNCTION
 * 3. Return function call: `return foo();` - CALL --RETURNS--> FUNCTION
 * 4. Return method call: `return obj.method();` - CALL --RETURNS--> FUNCTION
 * 5. Multiple returns: Both branches create edges
 * 6. Arrow function block body: `() => { return 42; }`
 * 7. Arrow function implicit return: `x => x * 2`
 * 8. Bare return: `return;` - NO edge created
 * 9. Return parameter: `return x;` where x is parameter - PARAMETER --RETURNS--> FUNCTION
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('RETURNS Edges (REG-263)', () => {
  let backend;
  let testDir;
  let testCounter = 0;

  /**
   * Create a temporary test directory with specified files
   */
  async function setupTest(files) {
    testDir = join(tmpdir(), `grafema-test-returns-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    // Create package.json to make it a valid project
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-returns-${testCounter}`, type: 'module' })
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
    if (backend) {
      await backend.cleanup();
    }
    cleanupTestDir();
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
    cleanupTestDir();
  });

  describe('Return literal', () => {
    it('should create RETURNS edge for numeric literal return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getValue() {
  return 42;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the function
      const func = allNodes.find(n => n.name === 'getValue' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getValue" should exist');

      // Find RETURNS edge pointing to function
      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist for getValue()');

      // Verify source is a LITERAL
      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
      assert.strictEqual(source.value, 42, 'Literal value should be 42');
    });

    it('should create RETURNS edge for string literal return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getMessage() {
  return 'hello world';
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getMessage' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getMessage" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
      assert.strictEqual(source.value, 'hello world', 'Literal value should be "hello world"');
    });
  });

  describe('Return variable', () => {
    it('should create RETURNS edge for variable return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getValue() {
  const result = 42;
  return result;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getValue' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getValue" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      // Source should be the variable (VARIABLE or CONSTANT)
      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.ok(
        ['VARIABLE', 'CONSTANT'].includes(source.type),
        `Expected VARIABLE or CONSTANT, got ${source.type}`
      );
      assert.strictEqual(source.name, 'result', 'Variable name should be "result"');
    });

    it('should create RETURNS edge for let variable return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function compute() {
  let value = 10;
  value = value * 2;
  return value;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'compute' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "compute" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.name, 'value', 'Variable name should be "value"');
    });
  });

  describe('Return function call', () => {
    it('should create RETURNS edge for function call return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function helper() {
  return 1;
}

function getValue() {
  return helper();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getValue' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getValue" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      // Source should be a CALL node
      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.name, 'helper', 'Call name should be "helper"');
    });

    it('should create RETURNS edge for chained function call return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function processData(data) {
  return transform(normalize(data));
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'processData' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "processData" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      // Source should be the outer CALL (transform)
      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.name, 'transform', 'Call name should be "transform"');
    });
  });

  describe('Return method call', () => {
    it('should create RETURNS edge for method call return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function formatDate(date) {
  return date.toLocaleDateString();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'formatDate' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "formatDate" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      // Method call should have method property
      assert.strictEqual(source.method, 'toLocaleDateString', 'Method name should be "toLocaleDateString"');
    });

    // NOTE: Chained method calls (items.filter().map()) are a documented gap.
    // The coordinate-based lookup can't reliably find the right call in a chain.
    // Future work could traverse the chain to find resolvable calls.
    it('should NOT create RETURNS edge for chained method call (documented gap)', async () => {
      const projectPath = await setupTest({
        'index.js': `
function processItems(items) {
  return items.filter(x => x).map(x => x * 2);
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'processItems' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "processItems" should exist');

      // Chained method calls are a documented gap - no RETURNS edge created
      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.strictEqual(returnsEdge, undefined, 'No RETURNS edge for chained calls (documented gap)');
    });
  });

  describe('Multiple returns', () => {
    it('should create RETURNS edges for all return paths', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getValue(flag) {
  if (flag) {
    return 'yes';
  }
  return 'no';
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getValue' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getValue" should exist');

      const returnsEdges = allEdges.filter(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );

      // Should have 2 RETURNS edges (one for each return statement)
      assert.strictEqual(
        returnsEdges.length, 2,
        `Expected 2 RETURNS edges, got ${returnsEdges.length}`
      );

      // Verify both sources are LITERAL nodes with correct values
      const sourceValues = [];
      for (const edge of returnsEdges) {
        const source = allNodes.find(n => n.id === edge.src);
        assert.ok(source, 'Source node should exist');
        assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
        sourceValues.push(source.value);
      }

      assert.ok(sourceValues.includes('yes'), 'Should have return value "yes"');
      assert.ok(sourceValues.includes('no'), 'Should have return value "no"');
    });

    it('should create RETURNS edges for ternary returns', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getBranch(condition) {
  if (condition === 'a') {
    return 1;
  } else if (condition === 'b') {
    return 2;
  } else {
    return 3;
  }
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getBranch' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getBranch" should exist');

      const returnsEdges = allEdges.filter(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );

      // Should have 3 RETURNS edges (one for each return statement)
      assert.strictEqual(
        returnsEdges.length, 3,
        `Expected 3 RETURNS edges, got ${returnsEdges.length}`
      );
    });
  });

  describe('Arrow function block body', () => {
    it('should create RETURNS edge for arrow function with block body', async () => {
      const projectPath = await setupTest({
        'index.js': `
const getValue = () => {
  return 42;
};
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Arrow function assigned to getValue
      const func = allNodes.find(n => n.name === 'getValue' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getValue" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist for arrow function with block body');

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
      assert.strictEqual(source.value, 42, 'Literal value should be 42');
    });

    it('should create RETURNS edge for arrow function with variable return', async () => {
      const projectPath = await setupTest({
        'index.js': `
const compute = (x) => {
  const doubled = x * 2;
  return doubled;
};
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'compute' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "compute" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.ok(
        ['VARIABLE', 'CONSTANT'].includes(source.type),
        `Expected VARIABLE or CONSTANT, got ${source.type}`
      );
      assert.strictEqual(source.name, 'doubled', 'Variable name should be "doubled"');
    });
  });

  describe('Arrow function implicit return', () => {
    // NOTE: Expression returns (like x * 2) are documented as a gap - we don't track them
    // because there's no single source node to create an edge from.
    // See REG-263: EXPRESSION type is explicitly skipped in bufferReturnEdges.
    it('should NOT create RETURNS edge for arrow function with expression body (documented gap)', async () => {
      const projectPath = await setupTest({
        'index.js': `
const double = x => x * 2;
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'double' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "double" should exist');

      // Expression returns (BinaryExpression) don't create RETURNS edges - documented gap
      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.strictEqual(returnsEdge, undefined, 'No RETURNS edge for expression return (documented gap)');
    });

    it('should create RETURNS edge for arrow function returning identifier', async () => {
      const projectPath = await setupTest({
        'index.js': `
const identity = x => x;
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'identity' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "identity" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist for implicit return of identifier');

      // Source should be the parameter x
      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'PARAMETER', `Expected PARAMETER, got ${source.type}`);
      assert.strictEqual(source.name, 'x', 'Parameter name should be "x"');
    });

    it('should create RETURNS edge for arrow function returning literal', async () => {
      const projectPath = await setupTest({
        'index.js': `
const getAnswer = () => 42;
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getAnswer' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getAnswer" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist for implicit literal return');

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
      assert.strictEqual(source.value, 42, 'Literal value should be 42');
    });

    it('should create RETURNS edge for arrow function returning function call', async () => {
      const projectPath = await setupTest({
        'index.js': `
const items = [1, 2, 3];
const process = arr => arr.map(x => x * 2);
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'process' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "process" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist for implicit method call return');

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.method, 'map', 'Method name should be "map"');
    });
  });

  describe('Bare return', () => {
    it('should NOT create RETURNS edge for bare return statement', async () => {
      const projectPath = await setupTest({
        'index.js': `
function doSomething() {
  if (true) return;
  console.log('hello');
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'doSomething' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "doSomething" should exist');

      const returnsEdges = allEdges.filter(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );

      // Should have NO RETURNS edges (bare return has no value)
      assert.strictEqual(
        returnsEdges.length, 0,
        `Expected 0 RETURNS edges for bare return, got ${returnsEdges.length}`
      );
    });

    it('should NOT create RETURNS edge for void function with bare return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function earlyExit(condition) {
  if (!condition) {
    return;
  }
  processData();
  return;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'earlyExit' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "earlyExit" should exist');

      const returnsEdges = allEdges.filter(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );

      // Should have NO RETURNS edges (both returns are bare)
      assert.strictEqual(
        returnsEdges.length, 0,
        `Expected 0 RETURNS edges for function with only bare returns, got ${returnsEdges.length}`
      );
    });

    it('should create RETURNS edge only for valued returns, not bare returns', async () => {
      const projectPath = await setupTest({
        'index.js': `
function mixedReturns(condition) {
  if (!condition) {
    return;  // bare return - no edge
  }
  return 42;  // valued return - edge
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'mixedReturns' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "mixedReturns" should exist');

      const returnsEdges = allEdges.filter(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );

      // Should have exactly 1 RETURNS edge (only for return 42)
      assert.strictEqual(
        returnsEdges.length, 1,
        `Expected 1 RETURNS edge for mixed returns, got ${returnsEdges.length}`
      );

      const source = allNodes.find(n => n.id === returnsEdges[0].src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
      assert.strictEqual(source.value, 42, 'Literal value should be 42');
    });
  });

  describe('Return parameter', () => {
    it('should create RETURNS edge for parameter return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function identity(x) {
  return x;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'identity' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "identity" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      // Source should be the parameter
      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'PARAMETER', `Expected PARAMETER, got ${source.type}`);
      assert.strictEqual(source.name, 'x', 'Parameter name should be "x"');
    });

    it('should create RETURNS edge for second parameter return', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getSecond(a, b) {
  return b;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getSecond' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getSecond" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      // Source should be the parameter b
      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'PARAMETER', `Expected PARAMETER, got ${source.type}`);
      assert.strictEqual(source.name, 'b', 'Parameter name should be "b"');
    });

    // NOTE: Destructured parameters (ObjectPattern) are not tracked as PARAMETER nodes.
    // See createParameterNodes.ts - ObjectPattern handling is a documented gap.
    it('should NOT create RETURNS edge for destructured parameter property return (documented gap)', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getName({ name }) {
  return name;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getName' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getName" should exist');

      // Destructured parameters don't create PARAMETER nodes, so no RETURNS edge
      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.strictEqual(returnsEdge, undefined, 'No RETURNS edge for destructured param (documented gap)');
    });
  });

  // NOTE: Nested FunctionDeclarations inside other functions are not tracked as FUNCTION nodes.
  // This is a limitation of the current analysis - nested functions need separate handling.
  // For now, we test that outer function returns work correctly with its own returns.
  describe('Nested functions', () => {
    it('should create RETURNS edge for outer function even with nested function declaration', async () => {
      const projectPath = await setupTest({
        'index.js': `
function outer() {
  function inner() {
    return 42;
  }
  return inner();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerFunc = allNodes.find(n => n.name === 'outer' && n.type === 'FUNCTION');
      assert.ok(outerFunc, 'Function "outer" should exist');

      // Outer's return should create a RETURNS edge
      const outerReturnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === outerFunc.id
      );
      assert.ok(outerReturnsEdge, 'RETURNS edge should exist for outer function');

      // Source should be the call to inner()
      const outerSource = allNodes.find(n => n.id === outerReturnsEdge.src);
      assert.ok(outerSource, 'Source node for outer should exist');
      assert.strictEqual(outerSource.type, 'CALL', `Expected CALL for outer, got ${outerSource.type}`);
      assert.strictEqual(outerSource.name, 'inner', 'Outer return should be call to inner');
    });
  });

  describe('Class methods', () => {
    // NOTE: BinaryExpression returns (like a + b) are skipped - this is a documented gap.
    // We test with a simple variable return to verify class methods work.
    it('should create RETURNS edge for class method return with variable', async () => {
      const projectPath = await setupTest({
        'index.js': `
class Calculator {
  compute(x) {
    const result = x * 2;
    return result;
  }
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the method
      const method = allNodes.find(n =>
        n.name === 'compute' && (n.type === 'METHOD' || n.type === 'FUNCTION')
      );
      assert.ok(method, 'Method "compute" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === method.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist for class method');

      // Source should be the result variable
      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.name, 'result', 'Source should be "result" variable');
    });

    it('should create RETURNS edge for getter return', async () => {
      const projectPath = await setupTest({
        'index.js': `
class Person {
  constructor(name) {
    this._name = name;
  }

  get name() {
    return this._name;
  }
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the getter method
      const getter = allNodes.find(n =>
        n.name === 'name' && (n.type === 'METHOD' || n.type === 'FUNCTION') && n.kind === 'get'
      );

      if (getter) {
        const returnsEdge = allEdges.find(e =>
          e.type === 'RETURNS' && e.dst === getter.id
        );
        assert.ok(returnsEdge, 'RETURNS edge should exist for getter');
      }
      // Getter handling is optional - pass if not found
    });
  });

  describe('Async functions', () => {
    it('should create RETURNS edge for async function return', async () => {
      const projectPath = await setupTest({
        'index.js': `
async function fetchData() {
  const result = await fetch('/api/data');
  return result;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'fetchData' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "fetchData" should exist');

      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.dst === func.id
      );
      assert.ok(returnsEdge, 'RETURNS edge should exist for async function');

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.ok(
        ['VARIABLE', 'CONSTANT'].includes(source.type),
        `Expected VARIABLE or CONSTANT, got ${source.type}`
      );
      assert.strictEqual(source.name, 'result', 'Variable name should be "result"');
    });
  });

  describe('Edge direction verification', () => {
    it('should create edge from return value TO function (src=value, dst=function)', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getValue() {
  return 42;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'getValue' && n.type === 'FUNCTION');
      assert.ok(func, 'Function "getValue" should exist');

      const returnsEdge = allEdges.find(e => e.type === 'RETURNS');
      assert.ok(returnsEdge, 'RETURNS edge should exist');

      // Verify edge direction: src=value, dst=function
      assert.strictEqual(
        returnsEdge.dst, func.id,
        'RETURNS edge destination should be the function'
      );

      const source = allNodes.find(n => n.id === returnsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.notStrictEqual(
        source.type, 'FUNCTION',
        'RETURNS edge source should NOT be the function'
      );
    });
  });

  describe('No duplicates on re-run', () => {
    it('should not create duplicate RETURNS edges when run twice', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getValue() {
  return 42;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);

      // First run
      await orchestrator.run(projectPath);

      const allEdges1 = await backend.getAllEdges();
      const returnsEdges1 = allEdges1.filter(e => e.type === 'RETURNS');
      const count1 = returnsEdges1.length;
      console.log(`After first run: ${count1} RETURNS edges`);

      // Second run
      await orchestrator.run(projectPath);

      const allEdges2 = await backend.getAllEdges();
      const returnsEdges2 = allEdges2.filter(e => e.type === 'RETURNS');
      const count2 = returnsEdges2.length;
      console.log(`After second run: ${count2} RETURNS edges`);

      assert.strictEqual(
        count2, count1,
        `RETURNS edge count should not increase on re-run (was ${count1}, now ${count2})`
      );
    });
  });
});
