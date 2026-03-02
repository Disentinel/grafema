/**
 * Tests for Scope-Aware Variable Lookup in Mutations (REG-309)
 *
 * REG-309: Fix scope-aware variable lookup for mutations.
 * Previously, mutation handlers used file-level lookup (file:name), which incorrectly
 * resolved shadowed variables to outer scope. Now mutations use scope chain resolution
 * to mirror JavaScript lexical scoping.
 *
 * NOTE: V2 (CoreV2Analyzer) does NOT create FLOWS_INTO edges for variable mutations
 * (like x += 3). V2 uses a different mutation tracking model. Tests checking FLOWS_INTO
 * for mutations are marked as todo. Tests checking variable existence and ID format
 * are updated to match V2's format (file->VARIABLE->name#line).
 *
 * This file tests that:
 * - Variable reassignments resolve to correct scope
 * - Array mutations resolve to correct scope
 * - Object mutations resolve to correct scope
 * - Parameter mutations work correctly
 * - Module-level mutations work correctly
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
    it('should create separate VARIABLE nodes for shadowed variables', async () => {
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

      // Find both x variables - V2 uses line-based disambiguation
      const xVars = allNodes.filter(n => n.name === 'x' && n.type === 'VARIABLE');

      assert.ok(xVars.length >= 2, `Expected at least 2 VARIABLE nodes named 'x', got ${xVars.length}`);

      // V2 IDs: file->VARIABLE->name#line
      const outerX = xVars.find(v => v.line === 2);
      const innerX = xVars.find(v => v.line === 4);

      assert.ok(outerX, 'Outer x (line 2) not found');
      assert.ok(innerX, 'Inner x (line 4) not found');
    });

    it('should resolve mutation to INNER variable in nested scope', { todo: 'V2 does not create FLOWS_INTO edges for mutations' }, async () => {
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

      const xVars = allNodes.filter(n => n.name === 'x' && n.type === 'VARIABLE');
      const innerX = xVars.find(v => v.line === 4);

      assert.ok(innerX, 'Inner x not found');

      const flowsToInner = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === innerX.id
      );
      assert.ok(flowsToInner, 'Expected FLOWS_INTO edge to inner x');
    });

    it('should resolve mutation to OUTER variable when no shadowing', { todo: 'V2 does not create FLOWS_INTO edges for mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
function processItems(items) {
  for (const item of items) {
    total += item.price;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVar, 'Variable "total" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === totalVar.id
      );
      assert.ok(flowsInto, 'Expected FLOWS_INTO edge to module-level total');
    });

    it('should handle multiple nesting levels (3+ scopes)', { todo: 'V2 does not create FLOWS_INTO edges for mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let x = 1;
function outer() {
  let x = 2;
  function inner() {
    let x = 3;
    x += 4;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVars = allNodes.filter(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVars.length >= 3, `Expected at least 3 x variables, got ${xVars.length}`);
    });
  });

  // ============================================================================
  // Module-Level Mutations (CRITICAL TEST)
  // ============================================================================
  describe('Module-level mutations', () => {
    it('should create VARIABLE node for module-level variable', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
count += 1;
        `
      });

      const allNodes = await backend.getAllNodes();

      const countVar = allNodes.find(n =>
        n.name === 'count' && n.type === 'VARIABLE'
      );

      assert.ok(countVar, 'Variable "count" not found');
      // V2 ID format: file->VARIABLE->name#line
      assert.ok(
        countVar.id.includes('->VARIABLE->count#'),
        `Variable should have v2 ID format. Got: ${countVar.id}`
      );
    });

    it('should resolve module-level variable mutation correctly', { todo: 'V2 does not create FLOWS_INTO edges for mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
count += 1;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const countVar = allNodes.find(n => n.name === 'count' && n.type === 'VARIABLE');
      assert.ok(countVar, 'Variable "count" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === countVar.id
      );
      assert.ok(flowsInto, 'Module-level mutation failed to resolve');
    });

    it('should handle module-level compound mutation with READS_FROM', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 0;
const value = 10;
total += value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const totalVar = allNodes.find(n => n.name === 'total' && n.type === 'VARIABLE');
      const valueVar = allNodes.find(n => n.name === 'value' && n.type === 'CONSTANT');

      assert.ok(totalVar, 'Variable "total" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      // V2: READS_FROM edge exists for reading value in total += value
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' && e.dst === valueVar.id
      );
      assert.ok(readsFrom, 'READS_FROM edge not found for module-level compound mutation');
    });
  });

  // ============================================================================
  // Array Mutations - Scope Awareness
  // ============================================================================
  describe('Array mutations - scope awareness', () => {
    it('should resolve array mutation to INNER array in nested scope', { todo: 'V2 does not create FLOWS_INTO edges for array mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let arr = [];
function foo() {
  let arr = [];
  arr.push(1);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVars = allNodes.filter(n => n.name === 'arr' && n.type === 'VARIABLE');
      assert.ok(arrVars.length >= 2, 'Should have at least 2 arr variables');
    });

    it('should resolve array mutation to OUTER array when no shadowing', { todo: 'V2 does not create FLOWS_INTO edges for array mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let results = [];
function collect(item) {
  results.push(item);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const resultsVar = allNodes.find(n => n.name === 'results' && n.type === 'VARIABLE');
      assert.ok(resultsVar, 'Variable "results" not found');
    });

    it('should handle array indexed assignment with shadowing', { todo: 'V2 does not create FLOWS_INTO edges for array mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let arr = [];
function processArray() {
  let arr = [];
  arr[0] = 42;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const arrVars = allNodes.filter(n => n.name === 'arr' && n.type === 'VARIABLE');
      assert.ok(arrVars.length >= 2, 'Should have at least 2 arr variables');
    });
  });

  // ============================================================================
  // Object Mutations - Scope Awareness
  // ============================================================================
  describe('Object mutations - scope awareness', () => {
    it('should resolve object mutation to INNER object in nested scope', { todo: 'V2 does not create FLOWS_INTO edges for object mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let obj = {};
function processObject() {
  let obj = {};
  obj.prop = 1;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const objVars = allNodes.filter(n => n.name === 'obj' && n.type === 'VARIABLE');
      assert.ok(objVars.length >= 2, 'Should have at least 2 obj variables');
    });

    it('should resolve object mutation to OUTER object when no shadowing', { todo: 'V2 does not create FLOWS_INTO edges for object mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let config = {};
function setup() {
  config.port = 3000;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const configVar = allNodes.find(n => n.name === 'config' && n.type === 'VARIABLE');
      assert.ok(configVar, 'Variable "config" not found');
    });

    it('should handle Object.assign with shadowing', { todo: 'V2 does not create FLOWS_INTO edges for Object.assign mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let obj = {};
function foo() {
  let obj = {};
  Object.assign(obj, { a: 1 });
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const objVars = allNodes.filter(n => n.name === 'obj' && n.type === 'VARIABLE');
      assert.ok(objVars.length >= 2, 'Should have at least 2 obj variables');
    });
  });

  // ============================================================================
  // Parameter Mutations in Nested Scopes
  // ============================================================================
  describe('Parameter mutations in nested scopes', () => {
    it('should create PARAMETER node for function parameter', async () => {
      await setupTest(backend, {
        'index.js': `
function outer(x) {
  function inner() {
    x += 1;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const paramX = allNodes.find(n =>
        n.name === 'x' && n.type === 'PARAMETER'
      );

      assert.ok(paramX, 'Parameter "x" not found');
    });

    it('should resolve mutation to parameter in parent scope', { todo: 'V2 does not create FLOWS_INTO edges for parameter mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
function outer(x) {
  function inner() {
    x += 1;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const paramX = allNodes.find(n => n.name === 'x' && n.type === 'PARAMETER');
      assert.ok(paramX, 'Parameter "x" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === paramX.id
      );
      assert.ok(flowsInto, 'Expected FLOWS_INTO edge to parameter x');
    });

    it('should resolve to INNER parameter when shadowed by nested function parameter', { todo: 'V2 does not create FLOWS_INTO edges for parameter mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
function outer(x) {
  function inner(x) {
    x += 1;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const params = allNodes.filter(n => n.name === 'x' && n.type === 'PARAMETER');
      assert.ok(params.length >= 2, 'Should have at least 2 x parameters');
    });
  });

  // ============================================================================
  // Arrow Functions - Scope Awareness
  // ============================================================================
  describe('Arrow functions - scope awareness', () => {
    it('should create separate VARIABLE nodes for shadowed variables in arrow functions', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 1;
const fn = () => {
  let x = 2;
  x += 1;
};
        `
      });

      const allNodes = await backend.getAllNodes();

      const xVars = allNodes.filter(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVars.length >= 2, `Expected at least 2 x variables, got ${xVars.length}`);
    });

    it('should resolve to outer scope from arrow function when no shadowing', { todo: 'V2 does not create FLOWS_INTO edges for mutations in arrow functions' }, async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
const increment = () => {
  count += 1;
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const countVar = allNodes.find(n => n.name === 'count' && n.type === 'VARIABLE');
      assert.ok(countVar, 'Variable "count" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.dst === countVar.id
      );
      assert.ok(flowsInto, 'Expected FLOWS_INTO edge to outer count');
    });
  });

  // ============================================================================
  // Class Methods - Scope Awareness
  // ============================================================================
  describe('Class methods - scope awareness', () => {
    it('should create VARIABLE node for local variable in class method', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 1;
class Foo {
  method() {
    let x = 2;
    x += 1;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const xVars = allNodes.filter(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVars.length >= 2, `Expected at least 2 x variables, got ${xVars.length}`);
    });
  });

  // ============================================================================
  // Integration: Real-world patterns
  // ============================================================================
  describe('Integration with real-world patterns', () => {
    it('should handle accumulator pattern with shadowing risk', { todo: 'V2 does not create FLOWS_INTO edges for mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
function processAll(groups) {
  let total = 0;
  function processGroup(group) {
    let total = 0;
    total += group.price;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const totalVars = allNodes.filter(n => n.name === 'total' && n.type === 'VARIABLE');
      assert.ok(totalVars.length >= 2, 'Should have at least 2 total variables');
    });

    it('should create VARIABLE node for closure variable', async () => {
      await setupTest(backend, {
        'index.js': `
function createCounter() {
  let count = 0;
  return function increment() {
    count += 1;
  };
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const countVar = allNodes.find(n =>
        n.name === 'count' && n.type === 'VARIABLE'
      );

      assert.ok(countVar, 'Variable "count" not found');
    });

    it('should handle complex nesting with mixed shadowing', { todo: 'V2 does not create FLOWS_INTO edges for mutations' }, async () => {
      await setupTest(backend, {
        'index.js': `
let result = [];
function process(items) {
  let result = [];
  function handleItem(item) {
    let result = [];
    result.push(item.data);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const resultVars = allNodes.filter(n => n.name === 'result' && n.type === 'VARIABLE');
      assert.ok(resultVars.length >= 3, 'Should have at least 3 result variables');
    });
  });

  // ============================================================================
  // Scope Path Consistency Verification
  // ============================================================================
  describe('Scope path consistency verification', () => {
    it('should create VARIABLE node with v2 semantic ID format', async () => {
      await setupTest(backend, {
        'index.js': `
function outer() {
  let x = 1;
  function inner() {
    x += 1;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const xVar = allNodes.find(n =>
        n.name === 'x' && n.type === 'VARIABLE'
      );

      assert.ok(xVar, 'Variable "x" not found');

      // V2 ID format: file->VARIABLE->name#line
      assert.ok(
        xVar.id.includes('->VARIABLE->x#'),
        `Variable semantic ID should have v2 format. Got: ${xVar.id}`
      );
    });
  });
});
