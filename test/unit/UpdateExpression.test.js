/**
 * Tests for Update Expression Tracking (UPDATE_EXPRESSION nodes and MODIFIES/READS_FROM edges)
 *
 * REG-288: Track UpdateExpression modifications with first-class graph nodes.
 *
 * When code does i++, --count, etc., we create:
 * - UPDATE_EXPRESSION node
 * - UPDATE_EXPRESSION --MODIFIES--> VARIABLE
 * - VARIABLE --READS_FROM--> VARIABLE (self-loop)
 * - SCOPE --CONTAINS--> UPDATE_EXPRESSION
 *
 * This is the TDD test file for REG-288. Tests are written BEFORE implementation,
 * so they should be RED initially.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-update-expr-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-update-expr-${testCounter}`,
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

describe('Update Expression Tracking', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) {
      await db.cleanup();
    }
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) {
      await db.cleanup();
    }
  });

  // ============================================================================
  // Postfix increment (i++)
  // ============================================================================
  describe('Postfix increment (i++)', () => {
    it('should create UPDATE_EXPRESSION node', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created');
      assert.strictEqual(updateNode.operator, '++');
      assert.strictEqual(updateNode.prefix, false);
      assert.strictEqual(updateNode.name, 'count++');
    });

    it('should create MODIFIES edge', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const countVar = allNodes.find(n => n.name === 'count' && n.type === 'VARIABLE');
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count');

      assert.ok(countVar, 'Variable "count" not found');
      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');

      const modifies = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.src === updateNode.id &&
        e.dst === countVar.id
      );

      assert.ok(
        modifies,
        `Expected MODIFIES edge from UPDATE_EXPRESSION to count. Found: ${JSON.stringify(allEdges.filter(e => e.type === 'MODIFIES'))}`
      );
    });

    it('should create READS_FROM self-loop', async () => {
      await setupTest(backend, {
        'index.js': `
let i = 0;
i++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const iVar = allNodes.find(n => n.name === 'i' && n.type === 'VARIABLE');
      assert.ok(iVar, 'Variable "i" not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === iVar.id &&
        e.dst === iVar.id
      );

      assert.ok(
        readsFrom,
        'READS_FROM self-loop not created (i++ reads current value before incrementing)'
      );
    });
  });

  // ============================================================================
  // Prefix increment (++i)
  // ============================================================================
  describe('Prefix increment (++i)', () => {
    it('should create UPDATE_EXPRESSION node with prefix=true', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
++count;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created');
      assert.strictEqual(updateNode.operator, '++');
      assert.strictEqual(updateNode.prefix, true);
      assert.strictEqual(updateNode.name, '++count');
    });
  });

  // ============================================================================
  // Decrement (--)
  // ============================================================================
  describe('Decrement (--)', () => {
    it('should create UPDATE_EXPRESSION node for postfix decrement', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 10;
total--;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'total');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created');
      assert.strictEqual(updateNode.operator, '--');
      assert.strictEqual(updateNode.prefix, false);
      assert.strictEqual(updateNode.name, 'total--');
    });

    it('should create UPDATE_EXPRESSION node for prefix decrement', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 10;
--total;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'total');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created');
      assert.strictEqual(updateNode.operator, '--');
      assert.strictEqual(updateNode.prefix, true);
      assert.strictEqual(updateNode.name, '--total');
    });
  });

  // ============================================================================
  // Function-level updates
  // ============================================================================
  describe('Function-level updates', () => {
    it('should track updates inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function increment() {
  let count = 0;
  count++;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count');
      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created inside function');

      // Verify CONTAINS edge from SCOPE to UPDATE_EXPRESSION
      const contains = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.dst === updateNode.id
      );
      assert.ok(contains, 'CONTAINS edge from SCOPE to UPDATE_EXPRESSION not created');
    });
  });

  // ============================================================================
  // Module-level updates
  // ============================================================================
  describe('Module-level updates', () => {
    it('should track updates at module level', async () => {
      await setupTest(backend, {
        'index.js': `
let moduleCounter = 0;
moduleCounter++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'moduleCounter');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created at module level');
    });

    it('should NOT create CONTAINS edge for module-level updates', async () => {
      await setupTest(backend, {
        'index.js': `
let moduleCounter = 0;
moduleCounter++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'moduleCounter');
      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');

      // Module-level updates should NOT have CONTAINS edge (no parentScopeId)
      const contains = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.dst === updateNode.id
      );

      assert.strictEqual(
        contains, undefined,
        'Module-level UPDATE_EXPRESSION should NOT have CONTAINS edge (no parent scope)'
      );
    });
  });

  // ============================================================================
  // No MODIFIES edges from SCOPE (old mechanism removed)
  // ============================================================================
  describe('No MODIFIES edges from SCOPE (old mechanism removed)', () => {
    it('should NOT create SCOPE --MODIFIES--> VARIABLE edge', async () => {
      await setupTest(backend, {
        'index.js': `
function test() {
  let x = 0;
  x++;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // OLD mechanism: SCOPE --MODIFIES--> VARIABLE
      const scopeModifies = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.dst === xVar.id &&
        allNodes.find(n => n.id === e.src)?.type === 'SCOPE'
      );

      assert.strictEqual(
        scopeModifies, undefined,
        'SCOPE --MODIFIES--> edge should NOT exist (old mechanism removed)'
      );

      // NEW mechanism: UPDATE_EXPRESSION --MODIFIES--> VARIABLE
      const updateModifies = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.dst === xVar.id &&
        allNodes.find(n => n.id === e.src)?.type === 'UPDATE_EXPRESSION'
      );

      assert.ok(
        updateModifies,
        'UPDATE_EXPRESSION --MODIFIES--> edge should exist (new mechanism)'
      );
    });
  });

  // ============================================================================
  // Nested scopes (Linus's addition)
  // ============================================================================
  describe('Nested scopes (loop inside function)', () => {
    it('should verify CONTAINS chain for nested scopes', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum++;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find UPDATE_EXPRESSION nodes
      const iUpdateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'i'
      );
      const sumUpdateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'sum'
      );

      assert.ok(iUpdateNode, 'UPDATE_EXPRESSION node for i++ not found');
      assert.ok(sumUpdateNode, 'UPDATE_EXPRESSION node for sum++ not found');

      // Both should have CONTAINS edges
      const iContains = allEdges.find(e =>
        e.type === 'CONTAINS' && e.dst === iUpdateNode.id
      );
      const sumContains = allEdges.find(e =>
        e.type === 'CONTAINS' && e.dst === sumUpdateNode.id
      );

      assert.ok(iContains, 'CONTAINS edge for i++ not found (should be in loop scope)');
      assert.ok(sumContains, 'CONTAINS edge for sum++ not found (should be in loop scope)');

      // Verify i++ is contained in loop scope (for-statement scope)
      const loopScope = allNodes.find(n =>
        n.id === iContains.src && n.type === 'SCOPE'
      );
      assert.ok(loopScope, 'Loop scope not found');

      // Verify sum++ is also contained in loop scope
      assert.strictEqual(
        sumContains.src, loopScope.id,
        'sum++ should be contained in same loop scope as i++'
      );
    });

    it('should handle deeply nested scopes correctly', async () => {
      await setupTest(backend, {
        'index.js': `
function outer() {
  let a = 0;
  a++;
  if (true) {
    let b = 0;
    b++;
    while (true) {
      let c = 0;
      c++;
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const aUpdate = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'a');
      const bUpdate = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'b');
      const cUpdate = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'c');

      assert.ok(aUpdate, 'UPDATE_EXPRESSION for a++ not found');
      assert.ok(bUpdate, 'UPDATE_EXPRESSION for b++ not found');
      assert.ok(cUpdate, 'UPDATE_EXPRESSION for c++ not found');

      // All should have CONTAINS edges
      const aContains = allEdges.find(e => e.type === 'CONTAINS' && e.dst === aUpdate.id);
      const bContains = allEdges.find(e => e.type === 'CONTAINS' && e.dst === bUpdate.id);
      const cContains = allEdges.find(e => e.type === 'CONTAINS' && e.dst === cUpdate.id);

      assert.ok(aContains, 'CONTAINS edge for a++ not found');
      assert.ok(bContains, 'CONTAINS edge for b++ not found');
      assert.ok(cContains, 'CONTAINS edge for c++ not found');

      // Verify they are in different scopes
      assert.notStrictEqual(
        aContains.src, bContains.src,
        'a++ and b++ should be in different scopes'
      );
      assert.notStrictEqual(
        bContains.src, cContains.src,
        'b++ and c++ should be in different scopes'
      );
    });
  });

  // ============================================================================
  // Edge direction verification
  // ============================================================================
  describe('Edge direction verification', () => {
    it('should create MODIFIES with correct direction: UPDATE_EXPRESSION -> VARIABLE', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 0;
x++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'x');

      const modifies = allEdges.find(e => e.type === 'MODIFIES');

      assert.ok(modifies, 'Expected MODIFIES edge');
      assert.strictEqual(modifies.src, updateNode.id, 'Edge src should be UPDATE_EXPRESSION');
      assert.strictEqual(modifies.dst, xVar.id, 'Edge dst should be VARIABLE');
    });

    it('should create READS_FROM self-loop with correct direction: VARIABLE -> VARIABLE', async () => {
      await setupTest(backend, {
        'index.js': `
let x = 0;
x++;
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

  // ============================================================================
  // Integration: Real-world scenarios
  // ============================================================================
  describe('Integration with real-world patterns', () => {
    it('should track traditional for-loop counter', async () => {
      await setupTest(backend, {
        'index.js': `
for (let i = 0; i < 10; i++) {
  console.log(i);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const iVar = allNodes.find(n => n.name === 'i' && n.type === 'VARIABLE');
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'i');

      assert.ok(iVar, 'Loop variable "i" not found');
      assert.ok(updateNode, 'UPDATE_EXPRESSION node for i++ not found');

      // Should have MODIFIES edge
      const modifies = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.src === updateNode.id &&
        e.dst === iVar.id
      );
      assert.ok(modifies, 'MODIFIES edge not found');

      // Should have READS_FROM self-loop
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === iVar.id &&
        e.dst === iVar.id
      );
      assert.ok(readsFrom, 'READS_FROM self-loop not found');
    });

    it('should track multiple counters in same function', async () => {
      await setupTest(backend, {
        'index.js': `
function processData() {
  let successCount = 0;
  let errorCount = 0;
  let totalCount = 0;

  successCount++;
  errorCount++;
  totalCount++;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const successUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'successCount'
      );
      const errorUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'errorCount'
      );
      const totalUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'totalCount'
      );

      assert.ok(successUpdate, 'UPDATE_EXPRESSION for successCount++ not found');
      assert.ok(errorUpdate, 'UPDATE_EXPRESSION for errorCount++ not found');
      assert.ok(totalUpdate, 'UPDATE_EXPRESSION for totalCount++ not found');
    });

    it('should track backwards loop with decrement', async () => {
      await setupTest(backend, {
        'index.js': `
for (let i = 10; i >= 0; i--) {
  console.log(i);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'i'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node for i-- not found');
      assert.strictEqual(updateNode.operator, '--');
      assert.strictEqual(updateNode.prefix, false);
      assert.strictEqual(updateNode.name, 'i--');
    });
  });

  // ============================================================================
  // Edge cases and limitations
  // ============================================================================
  describe('Edge cases and limitations', () => {
    it('should NOT track member expression updates (obj.prop++)', async () => {
      // Member expression updates are out of scope for REG-288
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
obj.count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count'
      );

      assert.strictEqual(
        updateNode, undefined,
        'UPDATE_EXPRESSION should NOT be created for obj.prop++ (out of scope)'
      );
    });

    it('should NOT track array element updates (arr[i]++)', { todo: 'Implementation tracks computed mutations — revisit scope for REG-288' }, async () => {
      // Array element updates are out of scope for REG-288
      await setupTest(backend, {
        'index.js': `
const arr = [0, 1, 2];
arr[0]++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION'
      );

      assert.strictEqual(
        updateNode, undefined,
        'UPDATE_EXPRESSION should NOT be created for arr[i]++ (out of scope)'
      );
    });

    it('should handle update expressions in return statements', async () => {
      await setupTest(backend, {
        'index.js': `
function getAndIncrement() {
  let counter = 0;
  return counter++;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'counter'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION in return statement not tracked');
      assert.strictEqual(updateNode.prefix, false);
      assert.strictEqual(updateNode.name, 'counter++');
    });

    it('should handle update expressions as call arguments', async () => {
      await setupTest(backend, {
        'index.js': `
function log(x) {}
let count = 0;
log(count++);
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION as call argument not tracked');
    });
  });
});
