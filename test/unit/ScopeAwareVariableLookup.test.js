/**
 * Tests for Scope-Aware Variable Lookup in Mutations (REG-309)
 *
 * REG-309: Fix scope-aware variable lookup for mutations.
 * Previously, mutation handlers used file-level lookup (file:name), which incorrectly
 * resolved shadowed variables to outer scope. Now mutations use scope chain resolution
 * to mirror JavaScript lexical scoping.
 *
 * When code has shadowed variables:
 *   let x = 1;
 *   function foo() {
 *     let x = 2;
 *     x += 3;  // Should FLOWS_INTO inner x, not outer x
 *   }
 *
 * This file tests that:
 * - Variable reassignments resolve to correct scope
 * - Array mutations resolve to correct scope
 * - Object mutations resolve to correct scope
 * - Parent scope lookup works (mutations in child scope affecting parent variables)
 * - Module-level mutations work (scope path [] matches semantic ID scope ['global'])
 *
 * This is the TDD test file for REG-309. Tests are written BEFORE implementation,
 * so they should be RED initially.
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
  const testDir = join(tmpdir(), `navi-test-scope-aware-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-scope-aware-${testCounter}`,
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

describe('Scope-Aware Variable Lookup', () => {
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
  // Variable Reassignment - Basic Shadowing
  // ============================================================================
  describe('Variable reassignment - basic shadowing', () => {
    it('should resolve mutation to INNER variable in nested scope', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 1;
function foo() {
  let x = 2;
  x += 3;  // Should FLOWS_INTO inner x, NOT outer x
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find both x variables
      const outerX = allNodes.find(n =>
        n.name === 'x' &&
        n.type === 'VARIABLE' &&
        n.id === 'index.js->VARIABLE->x'
      );
      const innerX = allNodes.find(n =>
        n.name === 'x' &&
        n.type === 'VARIABLE' &&
        n.id === 'index.js->foo->VARIABLE->x'
      );

      assert.ok(outerX, 'Outer x not found');
      assert.ok(innerX, 'Inner x not found');

      // CRITICAL: Mutation x += 3 should create edge to INNER x
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === innerX.id
      );
      assert.ok(
        flowsToInner,
        `Expected FLOWS_INTO edge to inner x. Found edges to outer x: ${allEdges.filter(e => e.dst === outerX.id).length}`
      );

      // Verify NO edge goes to outer x from the mutation
      const flowsToOuter = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === outerX.id &&
        e.src !== outerX.id  // Exclude initialization
      );
      assert.strictEqual(
        flowsToOuter, undefined,
        'FLOWS_INTO edge incorrectly goes to outer x (scope resolution bug)'
      );
    });

    it('should resolve mutation to OUTER variable when no shadowing', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
function processItems(items) {
  for (const item of items) {
    total += item.price;  // Should FLOWS_INTO outer total (parent scope)
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n =>
        n.name === 'total' &&
        n.type === 'VARIABLE' &&
        n.id === 'index.js->VARIABLE->total'
      );

      assert.ok(totalVar, 'Variable "total" not found');

      // Mutation should create edge to module-level total
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === totalVar.id
      );
      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge to module-level total (parent scope lookup)'
      );
    });

    it('should handle multiple nesting levels (3+ scopes)', { todo: 'REG-309: 3+ scope nesting not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
let x = 1;
function outer() {
  let x = 2;
  function inner() {
    let x = 3;
    x += 4;  // Should FLOWS_INTO innermost x
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find all three x variables
      // Scope paths: global, outer, outer->inner
      const globalX = allNodes.find(n =>
        n.name === 'x' &&
        n.id === 'index.js->VARIABLE->x'
      );
      const outerX = allNodes.find(n =>
        n.name === 'x' &&
        n.id.includes('->outer->VARIABLE->x') &&
        !n.id.includes('->inner->')
      );
      const innerX = allNodes.find(n =>
        n.name === 'x' &&
        n.id.includes('->outer->inner->VARIABLE->x')
      );

      assert.ok(globalX, 'Global x not found');
      assert.ok(outerX, 'Outer x not found');
      assert.ok(innerX, 'Inner x not found');

      // Mutation should go to innermost x
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === innerX.id
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to innermost x'
      );

      // Verify no edges to outer or global x from mutation
      const flowsToOuter = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        (e.dst === outerX.id || e.dst === globalX.id) &&
        !e.src.includes('LITERAL')  // Exclude initializations
      );
      assert.strictEqual(
        flowsToOuter.length, 0,
        'FLOWS_INTO edges incorrectly go to outer/global x'
      );
    });
  });

  // ============================================================================
  // Module-Level Mutations (CRITICAL TEST)
  // ============================================================================
  describe('Module-level mutations (scope path [] matches semantic ID [global])', () => {
    it('should resolve module-level variable mutation correctly', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
count += 1;  // Module-level mutation, scope path = []
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const countVar = allNodes.find(n =>
        n.name === 'count' &&
        n.type === 'VARIABLE'
      );

      assert.ok(countVar, 'Variable "count" not found');

      // CRITICAL: Module-level mutation must resolve correctly
      // Mutation scope path is [] (empty), but semantic ID scope is ['global']
      // Resolver MUST handle this mapping
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === countVar.id
      );
      assert.ok(
        flowsInto,
        'Module-level mutation failed to resolve (scope path [] vs semantic ID [global] mismatch)'
      );
    });

    it('should handle module-level mutation with compound operator', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const value = 10;
total += value;  // Module-level compound mutation
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
      assert.ok(flowsInto, 'FLOWS_INTO edge not found for module-level compound mutation');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === totalVar.id &&
        e.dst === totalVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found for module-level compound mutation');
    });
  });

  // ============================================================================
  // Array Mutations - Scope Awareness
  // ============================================================================
  describe('Array mutations - scope awareness', () => {
    it('should resolve array mutation to INNER array in nested scope', { todo: 'REG-309: array mutation scope resolution not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
let arr = [];
function foo() {
  let arr = [];
  arr.push(1);  // Should FLOWS_INTO inner arr
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerArr = allNodes.find(n =>
        n.name === 'arr' &&
        n.id === 'index.js->VARIABLE->arr'
      );
      const innerArr = allNodes.find(n =>
        n.name === 'arr' &&
        n.id === 'index.js->foo->VARIABLE->arr'
      );

      assert.ok(outerArr, 'Outer arr not found');
      assert.ok(innerArr, 'Inner arr not found');

      // Array mutation should go to inner arr
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === innerArr.id
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to inner arr from push()'
      );

      // No edge to outer arr from mutation
      const flowsToOuter = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === outerArr.id &&
        !e.src.includes('LITERAL')  // Exclude initialization
      );
      assert.strictEqual(
        flowsToOuter, undefined,
        'FLOWS_INTO edge incorrectly goes to outer arr'
      );
    });

    it('should resolve array mutation to OUTER array when no shadowing', { todo: 'REG-309: array mutation parent scope lookup not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
let results = [];
function collect(item) {
  results.push(item);  // Should FLOWS_INTO outer results
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const resultsVar = allNodes.find(n =>
        n.name === 'results' &&
        n.id === 'index.js->VARIABLE->results'
      );

      assert.ok(resultsVar, 'Variable "results" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === resultsVar.id
      );
      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge to outer results (parent scope lookup)'
      );
    });

    it('should handle array indexed assignment with shadowing', { todo: 'REG-309: array indexed assignment scope not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
let arr = [];
function processArray() {
  let arr = [];
  arr[0] = 42;  // Should FLOWS_INTO inner arr
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerArr = allNodes.find(n =>
        n.name === 'arr' &&
        n.id === 'index.js->VARIABLE->arr'
      );
      const innerArr = allNodes.find(n =>
        n.name === 'arr' &&
        n.id === 'index.js->processArray->VARIABLE->arr'
      );

      assert.ok(outerArr, 'Outer arr not found');
      assert.ok(innerArr, 'Inner arr not found');

      // Indexed assignment should go to inner arr
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === innerArr.id
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to inner arr from indexed assignment'
      );
    });
  });

  // ============================================================================
  // Object Mutations - Scope Awareness
  // ============================================================================
  describe('Object mutations - scope awareness', () => {
    it('should resolve object mutation to INNER object in nested scope', { todo: 'REG-309: object mutation scope resolution not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
let obj = {};
function processObject() {
  let obj = {};
  obj.prop = 1;  // Should FLOWS_INTO inner obj
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerObj = allNodes.find(n =>
        n.name === 'obj' &&
        n.id === 'index.js->VARIABLE->obj'
      );
      const innerObj = allNodes.find(n =>
        n.name === 'obj' &&
        n.id === 'index.js->processObject->VARIABLE->obj'
      );

      assert.ok(outerObj, 'Outer obj not found');
      assert.ok(innerObj, 'Inner obj not found');

      // Object mutation should go to inner obj
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === innerObj.id &&
        e.mutationType === 'property'
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to inner obj from property assignment'
      );
    });

    it('should resolve object mutation to OUTER object when no shadowing', { todo: 'REG-309: object mutation parent scope lookup not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
let config = {};
function setup() {
  config.port = 3000;  // Should FLOWS_INTO outer config
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const configVar = allNodes.find(n =>
        n.name === 'config' &&
        n.id === 'index.js->VARIABLE->config'
      );

      assert.ok(configVar, 'Variable "config" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === configVar.id &&
        e.mutationType === 'property'
      );
      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge to outer config (parent scope lookup)'
      );
    });

    it('should handle Object.assign with shadowing', { todo: 'REG-309: Object.assign scope resolution not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
let obj = {};
function foo() {
  let obj = {};
  Object.assign(obj, { a: 1 });  // Should FLOWS_INTO inner obj
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerObj = allNodes.find(n =>
        n.name === 'obj' &&
        n.id === 'index.js->VARIABLE->obj'
      );
      const innerObj = allNodes.find(n =>
        n.name === 'obj' &&
        n.id.includes('->foo->VARIABLE->obj')
      );

      assert.ok(outerObj, 'Outer obj not found');
      assert.ok(innerObj, 'Inner obj not found');

      // Object.assign should go to inner obj
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === innerObj.id &&
        e.mutationType === 'assign'
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to inner obj from Object.assign'
      );
    });
  });

  // ============================================================================
  // Parameter Mutations in Nested Scopes
  // ============================================================================
  describe('Parameter mutations in nested scopes', () => {
    it('should resolve mutation to parameter in parent scope', async () => {
      await setupTest(backend, {
        'index.js': `
function outer(x) {
  function inner() {
    x += 1;  // Should FLOWS_INTO parameter x in outer scope
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const paramX = allNodes.find(n =>
        n.name === 'x' &&
        n.type === 'PARAMETER'
      );

      assert.ok(paramX, 'Parameter "x" not found');

      // Mutation in inner() should affect parameter in outer()
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === paramX.id
      );
      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge to parameter x (parent scope lookup)'
      );
    });

    it('should resolve to INNER parameter when shadowed by nested function parameter', { todo: 'REG-309: parameter shadowing scope resolution not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
function outer(x) {
  function inner(x) {
    x += 1;  // Should FLOWS_INTO inner parameter, not outer
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerParam = allNodes.find(n =>
        n.name === 'x' &&
        n.type === 'PARAMETER' &&
        n.id.includes('[in:outer]')
      );
      const innerParam = allNodes.find(n =>
        n.name === 'x' &&
        n.type === 'PARAMETER' &&
        n.id.includes('[in:inner]')
      );

      assert.ok(outerParam, 'Outer parameter not found');
      assert.ok(innerParam, 'Inner parameter not found');

      // Mutation should go to inner parameter
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === innerParam.id
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to inner parameter'
      );
    });
  });

  // ============================================================================
  // Arrow Functions - Scope Awareness
  // ============================================================================
  describe('Arrow functions - scope awareness', () => {
    it('should handle shadowing in arrow functions', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 1;
const fn = () => {
  let x = 2;
  x += 1;  // Should FLOWS_INTO inner x
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerX = allNodes.find(n =>
        n.name === 'x' &&
        n.id === 'index.js->VARIABLE->x'
      );
      const innerX = allNodes.find(n =>
        n.name === 'x' &&
        n.id.includes('->fn->VARIABLE->x')
      );

      assert.ok(outerX, 'Outer x not found');
      assert.ok(innerX, 'Inner x not found');

      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === innerX.id
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to inner x in arrow function'
      );
    });

    it('should resolve to outer scope from arrow function when no shadowing', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
const increment = () => {
  count += 1;  // Should FLOWS_INTO outer count
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const countVar = allNodes.find(n =>
        n.name === 'count' &&
        n.id === 'index.js->VARIABLE->count'
      );

      assert.ok(countVar, 'Variable "count" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === countVar.id
      );
      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge to outer count from arrow function'
      );
    });
  });

  // ============================================================================
  // Class Methods - Scope Awareness
  // ============================================================================
  describe('Class methods - scope awareness', () => {
    it('should handle local variables in class methods', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 1;
class Foo {
  method() {
    let x = 2;
    x += 1;  // Should FLOWS_INTO method-scoped x
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const globalX = allNodes.find(n =>
        n.name === 'x' &&
        n.id === 'index.js->VARIABLE->x'
      );
      const methodX = allNodes.find(n =>
        n.name === 'x' &&
        n.id.includes('->method->VARIABLE->x')
      );

      assert.ok(globalX, 'Global x not found');
      assert.ok(methodX, 'Method-scoped x not found');

      const flowsToMethod = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === methodX.id
      );
      assert.ok(
        flowsToMethod,
        'Expected FLOWS_INTO edge to method-scoped x'
      );
    });
  });

  // ============================================================================
  // Integration: Real-world patterns
  // ============================================================================
  describe('Integration with real-world patterns', () => {
    it('should handle accumulator pattern with shadowing risk', { todo: 'REG-309: accumulator scope resolution not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
function processAll(groups) {
  let total = 0;  // Outer total
  function processGroup(group) {
    let total = 0;  // Inner total (shadowing)
    total += group.price;  // Should FLOWS_INTO inner total
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerTotal = allNodes.find(n =>
        n.name === 'total' &&
        n.id.includes('->processAll->VARIABLE->total') &&
        !n.id.includes('->processGroup->')
      );
      const innerTotal = allNodes.find(n =>
        n.name === 'total' &&
        n.id.includes('->processAll->processGroup->VARIABLE->total')
      );

      assert.ok(outerTotal, 'Outer total not found');
      assert.ok(innerTotal, 'Inner total not found');

      // Mutation should go to inner total (in the nested function)
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === innerTotal.id
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to inner total in nested function'
      );
    });

    it('should handle closure capturing with mutations', async () => {
      await setupTest(backend, {
        'index.js': `
function createCounter() {
  let count = 0;
  return function increment() {
    count += 1;  // Should FLOWS_INTO count in outer scope (closure)
  };
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // count is in createCounter scope
      const countVar = allNodes.find(n =>
        n.name === 'count' &&
        n.type === 'VARIABLE' &&
        n.id.includes('->createCounter->VARIABLE->count')
      );

      assert.ok(countVar, 'Variable "count" not found');

      // Mutation in nested function should affect outer count
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === countVar.id
      );
      assert.ok(
        flowsInto,
        'Expected FLOWS_INTO edge to outer count (closure pattern)'
      );
    });

    it('should handle complex nesting with mixed shadowing', { todo: 'REG-309: complex nesting scope resolution not yet implemented' }, async () => {
      await setupTest(backend, {
        'index.js': `
let result = [];
function process(items) {
  let result = [];  // Shadows module-level
  function handleItem(item) {
    let result = [];  // Shadows function-level
    result.push(item.data);  // Should FLOWS_INTO innermost result
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const globalResult = allNodes.find(n =>
        n.name === 'result' &&
        n.id === 'index.js->VARIABLE->result'
      );
      const functionResult = allNodes.find(n =>
        n.name === 'result' &&
        n.id.includes('->process->VARIABLE->result') &&
        !n.id.includes('->handleItem->')
      );
      const innerResult = allNodes.find(n =>
        n.name === 'result' &&
        n.id.includes('->process->handleItem->VARIABLE->result')
      );

      assert.ok(globalResult, 'Global result not found');
      assert.ok(functionResult, 'Function result not found');
      assert.ok(innerResult, 'Inner result not found');

      // push() should go to innermost result
      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === innerResult.id
      );
      assert.ok(
        flowsToInner,
        'Expected FLOWS_INTO edge to innermost result'
      );
    });
  });

  // ============================================================================
  // Scope Path Consistency Verification
  // ============================================================================
  describe('Scope path consistency verification', () => {
    it('should use consistent scope paths between variables and mutations', async () => {
      await setupTest(backend, {
        'index.js': `
function outer() {
  let x = 1;
  function inner() {
    x += 1;  // Mutation scope: ['outer', 'inner']
             // Variable scope: ['outer']
             // Should match via scope chain walk
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n =>
        n.name === 'x' &&
        n.id.includes('->outer->VARIABLE->x')
      );

      assert.ok(xVar, 'Variable "x" not found');

      // Verify semantic ID format
      assert.ok(
        xVar.id.includes('->outer->VARIABLE->x'),
        'Variable semantic ID has incorrect scope format'
      );

      // Mutation from inner scope should still find outer scope variable
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === xVar.id
      );
      assert.ok(
        flowsInto,
        'Scope path consistency issue: mutation from inner scope failed to resolve outer scope variable'
      );
    });
  });
});
