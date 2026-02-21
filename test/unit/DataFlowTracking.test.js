/**
 * Data Flow Tracking TDD Tests
 *
 * ЦЕЛЬ: Проверить что все переменные прослеживаются до листовых узлов
 *
 * ЛИСТОВЫЕ УЗЛЫ (leaf nodes):
 * - LITERAL: примитивные значения (числа, строки, булевы, null, undefined)
 * - EXTERNAL_STDIO: console.log/error
 * - EXTERNAL_DATABASE: database queries
 * - EXTERNAL_NETWORK: HTTP requests, fetch
 * - EXTERNAL_FILESYSTEM: fs.readFile и т.д.
 * - event:listener: события (process.on, app.on)
 *
 * ПРАВИЛО: Каждая переменная должна иметь путь до одного из листовых узлов
 * через ASSIGNED_FROM рёбра
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// Helper to serialize objects with BigInt values
const jsonStringify = (obj) => JSON.stringify(obj, (key, value) =>
  typeof value === 'bigint' ? value.toString() : value
);

describe('Data Flow Tracking', () => {
  let testCounter = 0;

  /**
   * Создаём тестовый проект и анализируем его
   */
  async function setupTest(files) {
    // Создаём уникальную директорию
    const testDir = join(tmpdir(), `navi-test-dataflow-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    // package.json
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({
        name: `test-dataflow-${testCounter}`,
        type: 'module'
      })
    );

    // Создаём файлы
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }

    // Анализируем
    const db = await createTestDatabase();
    const backend = db.backend;

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(testDir);

    return { backend, db, testDir };
  }

  describe('Literal Assignments', () => {
    it('should track number literal assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `const x = 42;`
      });

      try {
        // Ищем переменную x
        const allNodes = await backend.getAllNodes();
        const variable = allNodes.find(n => n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));

        assert.ok(variable, 'Variable "x" not found');

        // Проверяем что есть ASSIGNED_FROM ребро
        const edges = await backend.getAllEdges();
        const assignment = edges.find(e => e.type === 'ASSIGNED_FROM' && e.src === variable.id);

        assert.ok(
          assignment,
          `Variable "x" has no ASSIGNED_FROM edge. Variables must be assigned from something! Found edges: ${jsonStringify(edges.filter(e => e.src === variable.id))}`
        );

        // Проверяем что источник - LITERAL
        const source = allNodes.find(n => n.id === assignment.dst);
        assert.ok(source, `Source node ${assignment.dst} not found`);
        assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
        assert.strictEqual(source.value, 42);
      } finally {
        await backend.close();
      }
    });

    it('should track string literal assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `const name = "hello";`
      });

      try {
        const allNodes = await backend.getAllNodes();
        const variable = allNodes.find(n => n.name === 'name');

        assert.ok(variable, 'Variable "name" not found');

        const edges = await backend.getAllEdges();
        const assignment = edges.find(e => e.type === 'ASSIGNED_FROM' && e.src === variable.id);

        assert.ok(assignment, 'Variable "name" has no ASSIGNED_FROM edge');

        const source = allNodes.find(n => n.id === assignment.dst);
        assert.strictEqual(source.type, 'LITERAL');
        assert.strictEqual(source.value, 'hello');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Method Call Assignments', () => {
    it('should track array.map() assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `
const numbers = [1, 2, 3];
const doubled = numbers.map(x => x * 2);
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();

        console.log('\n=== DEBUG: array.map() test ===');
        console.log('All nodes:', allNodes.map(n => ({ id: n.id, type: n.type, name: n.name })));
        console.log('All edges:', edges.map(e => ({ src: e.src, dst: e.dst, type: e.type })));

        const doubled = allNodes.find(n => n.name === 'doubled');

        assert.ok(doubled, 'Variable "doubled" not found');
        console.log('doubled:', doubled);

        const assignment = edges.find(e => e.type === 'ASSIGNED_FROM' && e.src === doubled.id);

        assert.ok(
          assignment,
          `Variable "doubled" has no ASSIGNED_FROM edge. It should be assigned from numbers.map(). Edges from doubled: ${jsonStringify(edges.filter(e => e.src === doubled.id))}`
        );

        const source = allNodes.find(n => n.id === assignment.dst);
        assert.ok(source, 'Source node not found');
        assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
        assert.ok(source.name.includes('map'), `Expected map method, got ${source.name}`);
      } finally {
        await backend.close();
      }
    });
  });

  describe('Function Call Assignments', () => {
    it('should track function call assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `
function foo() { return 42; }
const result = foo();
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const result = allNodes.find(n => n.name === 'result');

        assert.ok(result, 'Variable "result" not found');

        const edges = await backend.getAllEdges();
        const assignment = edges.find(e => e.type === 'ASSIGNED_FROM' && e.src === result.id);

        assert.ok(assignment, 'Variable "result" has no ASSIGNED_FROM edge');

        const source = allNodes.find(n => n.id === assignment.dst);
        assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      } finally {
        await backend.close();
      }
    });
  });

  describe('NewExpression Assignments', () => {
    it('should track new Class() assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `
class Helper {}
const helper = new Helper();
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();

        const helper = allNodes.find(n => n.name === 'helper');
        assert.ok(helper, 'Variable "helper" not found');

        // REG-546: NewExpression initializer should create VARIABLE, not CONSTANT
        assert.strictEqual(helper.type, 'VARIABLE', 'NewExpression initializer should create VARIABLE node, not CONSTANT');

        const assignment = edges.find(e => e.type === 'ASSIGNED_FROM' && e.src === helper.id);
        assert.ok(assignment, 'Variable "helper" should have ASSIGNED_FROM edge to CLASS node');

        const source = allNodes.find(n => n.id === assignment.dst);
        assert.ok(source, 'Source node not found');
        // NewExpression creates a CONSTRUCTOR_CALL node that may later resolve to CLASS
        assert.ok(
          source.type === 'CLASS' || source.type === 'EXTERNAL_MODULE' || source.type === 'CONSTRUCTOR_CALL',
          `Expected CLASS, EXTERNAL_MODULE, or CONSTRUCTOR_CALL, got ${source.type}`
        );
      } finally {
        await backend.close();
      }
    });

    it('should create VARIABLE node for module-level const x = new Map() (VariableVisitor path)', async () => {
      // Tests the VariableVisitor.ts code path — module-level variable declarations
      const { backend } = await setupTest({
        'index.js': `const myMap = new Map();`
      });

      try {
        const allNodes = await backend.getAllNodes();
        const myMap = allNodes.find(n => n.name === 'myMap');

        assert.ok(myMap, 'Node "myMap" not found in graph');
        assert.strictEqual(
          myMap.type, 'VARIABLE',
          `Module-level "const myMap = new Map()" should create VARIABLE node, got ${myMap.type}`
        );
      } finally {
        await backend.close();
      }
    });

    it('should create VARIABLE node for in-function const x = new Set() (JSASTAnalyzer path)', async () => {
      // Tests the handleVariableDeclaration path in JSASTAnalyzer.ts — in-function declarations
      const { backend } = await setupTest({
        'index.js': `
function buildSet() {
  const mySet = new Set();
  return mySet;
}
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const mySet = allNodes.find(n => n.name === 'mySet');

        assert.ok(mySet, 'Node "mySet" not found in graph');
        assert.strictEqual(
          mySet.type, 'VARIABLE',
          `In-function "const mySet = new Set()" should create VARIABLE node, got ${mySet.type}`
        );
      } finally {
        await backend.close();
      }
    });

    it('should create VARIABLE node for const x = new Map<string, number>() with TypeScript generics', async () => {
      // Verifies that TSTypeParameterInstantiation does not break callee detection;
      // the callee is still Identifier 'Map' even with type params
      const { backend } = await setupTest({
        'index.ts': `const myTypedMap = new Map<string, number>();`
      });

      try {
        const allNodes = await backend.getAllNodes();
        const myTypedMap = allNodes.find(n => n.name === 'myTypedMap');

        assert.ok(myTypedMap, 'Node "myTypedMap" not found in graph');
        assert.strictEqual(
          myTypedMap.type, 'VARIABLE',
          `"const myTypedMap = new Map<string, number>()" should create VARIABLE node, got ${myTypedMap.type}`
        );
      } finally {
        await backend.close();
      }
    });

    it('should preserve INSTANCE_OF edge when const x = new Foo() creates VARIABLE node', async () => {
      // After moving classInstantiations.push() outside the shouldBeConstant guard,
      // INSTANCE_OF edges must still be created for NewExpression assignments
      const { backend } = await setupTest({
        'index.js': `
class Foo {
  constructor() {}
}
const myFoo = new Foo();
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();

        const myFoo = allNodes.find(n => n.name === 'myFoo');
        assert.ok(myFoo, 'Node "myFoo" not found in graph');

        // REG-546: must be VARIABLE, not CONSTANT
        assert.strictEqual(
          myFoo.type, 'VARIABLE',
          `"const myFoo = new Foo()" should create VARIABLE node, got ${myFoo.type}`
        );

        // Verify INSTANCE_OF edge still exists (myFoo -[INSTANCE_OF]-> Foo class)
        const fooClass = allNodes.find(n => n.name === 'Foo' && n.type === 'CLASS');
        assert.ok(fooClass, 'CLASS node "Foo" not found');

        const instanceOfEdge = edges.find(e =>
          e.type === 'INSTANCE_OF' && e.src === myFoo.id && e.dst === fooClass.id
        );
        assert.ok(
          instanceOfEdge,
          `Expected INSTANCE_OF edge from "myFoo" to CLASS "Foo". ` +
          `Edges from myFoo: ${jsonStringify(edges.filter(e => e.src === myFoo.id))}`
        );

        // Also verify ASSIGNED_FROM edge exists (myFoo -[ASSIGNED_FROM]-> CONSTRUCTOR_CALL)
        const assignedFromEdge = edges.find(e =>
          e.type === 'ASSIGNED_FROM' && e.src === myFoo.id
        );
        assert.ok(
          assignedFromEdge,
          `Expected ASSIGNED_FROM edge from "myFoo". ` +
          `Edges from myFoo: ${jsonStringify(edges.filter(e => e.src === myFoo.id))}`
        );
      } finally {
        await backend.close();
      }
    });
  });

  describe('Arrow Function Assignments', () => {
    it('should track arrow function assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `
const add = (a, b) => a + b;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();

        const add = allNodes.find(n => n.name === 'add' && n.type === 'VARIABLE');
        assert.ok(add, 'Variable "add" (VARIABLE) not found');

        const assignment = edges.find(e => e.type === 'ASSIGNED_FROM' && e.src === add.id);
        assert.ok(assignment, 'Variable "add" should have ASSIGNED_FROM edge to FUNCTION node');

        const source = allNodes.find(n => n.id === assignment.dst);
        assert.ok(source, 'Source node not found');
        assert.strictEqual(source.type, 'FUNCTION', `Expected FUNCTION, got ${source.type}`);
      } finally {
        await backend.close();
      }
    });
  });

  describe('All Variables Must Have ASSIGNED_FROM Edges', () => {
    it('should verify all variables have ASSIGNED_FROM edges', async () => {
      const { backend } = await setupTest({
        'index.js': `
const numbers = [1, 2, 3, 4, 5];
const doubled = numbers.map(x => x * 2);
const filtered = doubled.filter(x => x > 5);
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();

        // Находим все переменные
        const variables = allNodes.filter(n =>
          n.type === 'VARIABLE' || n.type === 'CONSTANT'
        );

        console.log(`Found ${variables.length} variables:`, variables.map(v => v.name));

        // Проверяем что у каждой переменной есть ASSIGNED_FROM
        for (const v of variables) {
          const assignment = edges.find(e => e.type === 'ASSIGNED_FROM' && e.src === v.id);

          assert.ok(
            assignment,
            `Variable "${v.name}" (${v.id}) has no ASSIGNED_FROM edge! All variables must be assigned from something.`
          );
        }
      } finally {
        await backend.close();
      }
    });
  });

  describe('Datalog Guarantee Checks', () => {
    it('should verify all variables have ASSIGNED_FROM using Datalog', async () => {
      const { backend } = await setupTest({
        'index.js': `
const numbers = [1, 2, 3, 4, 5];
const doubled = numbers.map(x => x * 2);
const filtered = doubled.filter(x => x > 5);
        `
      });

      try {
        // Use Datalog to check the guarantee:
        // ASSIGNED_FROM edges go FROM variable TO value (src=variable, dst=value)
        // So we need to check for outgoing edges using edge(X, _, "ASSIGNED_FROM")
        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "VARIABLE"), \\+ edge(X, _, "ASSIGNED_FROM").
          violation(X) :- node(X, "CONSTANT"), \\+ edge(X, _, "ASSIGNED_FROM").
        `);

        // If there are any violations, the test should fail
        if (violations.length > 0) {
          // Get node names for better error messages
          const violatingNodes = [];
          for (const v of violations) {
            const nodeId = v.bindings.find(b => b.name === 'X')?.value;
            if (nodeId) {
              const node = await backend.getNode(nodeId);
              violatingNodes.push(node?.name || nodeId);
            }
          }
          assert.fail(
            `Datalog guarantee failed: ${violations.length} variable(s) have no ASSIGNED_FROM edge: ${violatingNodes.join(', ')}`
          );
        }

        console.log('Datalog guarantee check passed: all variables have ASSIGNED_FROM edges');
      } finally {
        await backend.close();
      }
    });

    it('should detect unassigned variables using Datalog', async () => {
      // This test creates a scenario where we expect a violation
      // We simulate by adding a node directly without ASSIGNED_FROM edge
      const { backend, testDir } = await setupTest({
        'index.js': `
// Empty file - we'll add nodes manually to simulate a bug
        `
      });

      try {
        // Manually add a VARIABLE node without ASSIGNED_FROM edge
        await backend.addNode({
          id: 'test-unassigned-var',
          type: 'VARIABLE',
          name: 'unassignedVar',
          file: 'manual.js'
        });

        // Check the guarantee (edge direction: VARIABLE --> VALUE)
        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "VARIABLE"), \\+ edge(X, _, "ASSIGNED_FROM").
        `);

        // Should have exactly one violation
        assert.strictEqual(violations.length, 1, 'Expected exactly one violation');
        console.log('Datalog correctly detected unassigned variable');
      } finally {
        await backend.close();
      }
    });
  });
});
