/**
 * Tests for Member Expression Update Tracking (obj.prop++, arr[i]++, this.count++)
 *
 * REG-312: Track member expression updates with UPDATE_EXPRESSION nodes.
 *
 * When code does obj.prop++, arr[i]++, this.count++, we need to create:
 * - UPDATE_EXPRESSION node with targetType='MEMBER_EXPRESSION'
 * - MODIFIES edge: UPDATE_EXPRESSION --MODIFIES--> VARIABLE(object)
 * - READS_FROM self-loop: VARIABLE(object) --READS_FROM--> VARIABLE(object)
 * - CONTAINS edge: SCOPE --CONTAINS--> UPDATE_EXPRESSION
 *
 * Edge direction:
 * - MODIFIES: src=UPDATE_EXPRESSION, dst=VARIABLE(object)
 * - READS_FROM: src=VARIABLE(object), dst=VARIABLE(object) (self-loop)
 *
 * This is the TDD test file for REG-312. Tests are written BEFORE implementation,
 * so they should be RED initially.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-update-member-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-update-member-${testCounter}`,
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

describe('UpdateExpression - Member Expressions (REG-312)', () => {
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
  // Basic Member Expression Updates (4.1)
  // ============================================================================
  describe('Basic member expression updates', () => {
    it('should create UPDATE_EXPRESSION node for obj.count++', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
obj.count++;
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj' &&
        n.propertyName === 'count'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for obj.count++');
      assert.strictEqual(updateNode.targetType, 'MEMBER_EXPRESSION', 'targetType should be MEMBER_EXPRESSION');
      assert.strictEqual(updateNode.objectName, 'obj', 'objectName should be "obj"');
      assert.strictEqual(updateNode.propertyName, 'count', 'propertyName should be "count"');
      assert.strictEqual(updateNode.mutationType, 'property', 'mutationType should be "property"');
      assert.strictEqual(updateNode.operator, '++', 'operator should be ++');
      assert.strictEqual(updateNode.prefix, false, 'prefix should be false for postfix');
    });

    it('should create UPDATE_EXPRESSION node for ++obj.count (prefix)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
++obj.count;
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj' &&
        n.propertyName === 'count'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for ++obj.count');
      assert.strictEqual(updateNode.prefix, true, 'prefix should be true for prefix increment');
      assert.strictEqual(updateNode.operator, '++', 'operator should be ++');
    });

    it('should create UPDATE_EXPRESSION node for obj.count-- (decrement)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
obj.count--;
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj' &&
        n.propertyName === 'count'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for obj.count--');
      assert.strictEqual(updateNode.operator, '--', 'operator should be --');
      assert.strictEqual(updateNode.prefix, false, 'prefix should be false for postfix');
    });

    it('should create UPDATE_EXPRESSION node for --obj.count (prefix decrement)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
--obj.count;
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj' &&
        n.propertyName === 'count'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for --obj.count');
      assert.strictEqual(updateNode.operator, '--', 'operator should be --');
      assert.strictEqual(updateNode.prefix, true, 'prefix should be true for prefix decrement');
    });

    it('should create MODIFIES edge from UPDATE_EXPRESSION to object VARIABLE', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
obj.count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj'
      );
      const objVar = allNodes.find(n => n.name === 'obj' && n.type === 'CONSTANT');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');
      assert.ok(objVar, 'Object VARIABLE not found');

      const modifiesEdge = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.src === updateNode.id &&
        e.dst === objVar.id
      );

      assert.ok(
        modifiesEdge,
        `Expected MODIFIES edge from UPDATE_EXPRESSION to obj. Found edges: ${JSON.stringify(allEdges.filter(e => e.type === 'MODIFIES'))}`
      );
    });

    it('should create READS_FROM self-loop on object VARIABLE', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
obj.count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj' && n.type === 'CONSTANT');
      assert.ok(objVar, 'Object VARIABLE not found');

      const readsFromSelfLoop = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === objVar.id &&
        e.dst === objVar.id
      );

      assert.ok(
        readsFromSelfLoop,
        'Expected READS_FROM self-loop on obj (obj reads current value before increment)'
      );
    });
  });

  // ============================================================================
  // Computed Property Updates (4.2)
  // ============================================================================
  describe('Computed property updates', () => {
    it('should create UPDATE_EXPRESSION node for arr[0]++ (numeric literal)', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
arr[0]++;
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'arr'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for arr[0]++');
      assert.strictEqual(updateNode.objectName, 'arr', 'objectName should be "arr"');
      assert.strictEqual(updateNode.mutationType, 'computed', 'mutationType should be "computed"');
      assert.strictEqual(updateNode.propertyName, '<computed>', 'propertyName should be "<computed>"');
    });

    it('should create UPDATE_EXPRESSION node for arr[i]++ (variable index)', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
let i = 0;
arr[i]++;
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'arr'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for arr[i]++');
      assert.strictEqual(updateNode.objectName, 'arr', 'objectName should be "arr"');
      assert.strictEqual(updateNode.mutationType, 'computed', 'mutationType should be "computed"');
      assert.strictEqual(updateNode.propertyName, '<computed>', 'propertyName should be "<computed>"');
      assert.strictEqual(updateNode.computedPropertyVar, 'i', 'computedPropertyVar should be "i"');
    });

    it('should create UPDATE_EXPRESSION node for obj["key"]++ (string literal)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { key: 0 };
obj["key"]++;
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj' &&
        n.propertyName === 'key'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for obj["key"]++');
      assert.strictEqual(updateNode.objectName, 'obj', 'objectName should be "obj"');
      assert.strictEqual(updateNode.propertyName, 'key', 'propertyName should be "key" (static string)');
      assert.strictEqual(updateNode.mutationType, 'property', 'mutationType should be "property" for static string');
    });

    it('should create UPDATE_EXPRESSION node for obj[key]++ (variable key)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { a: 1, b: 2 };
const key = 'a';
obj[key]++;
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for obj[key]++');
      assert.strictEqual(updateNode.objectName, 'obj', 'objectName should be "obj"');
      assert.strictEqual(updateNode.mutationType, 'computed', 'mutationType should be "computed"');
      assert.strictEqual(updateNode.computedPropertyVar, 'key', 'computedPropertyVar should be "key"');
    });
  });

  // ============================================================================
  // This Reference Updates (4.3)
  // ============================================================================
  describe('This reference updates', () => {
    it('should create UPDATE_EXPRESSION node for this.counter++ in class method', async () => {
      await setupTest(backend, {
        'index.js': `
class Counter {
  constructor() {
    this.value = 0;
  }
  increment() {
    this.value++;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'this' &&
        n.propertyName === 'value'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for this.value++');
      assert.strictEqual(updateNode.objectName, 'this', 'objectName should be "this"');
      assert.strictEqual(updateNode.propertyName, 'value', 'propertyName should be "value"');
      assert.strictEqual(updateNode.mutationType, 'property', 'mutationType should be "property"');
    });

    it('should create MODIFIES edge pointing to CLASS node for this.prop++', async () => {
      await setupTest(backend, {
        'index.js': `
class Counter {
  constructor() {
    this.value = 0;
  }
  increment() {
    this.value++;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'this' &&
        n.propertyName === 'value'
      );
      const classNode = allNodes.find(n => n.name === 'Counter' && n.type === 'CLASS');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');
      assert.ok(classNode, 'CLASS node not found');

      const modifiesEdge = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.src === updateNode.id &&
        e.dst === classNode.id
      );

      assert.ok(
        modifiesEdge,
        'Expected MODIFIES edge from UPDATE_EXPRESSION to CLASS node for this.value++'
      );
    });

    it('should capture enclosingClassName for this.prop++', async () => {
      await setupTest(backend, {
        'index.js': `
class Stats {
  constructor() {
    this.hits = 0;
  }
  record() {
    this.hits++;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'this' &&
        n.propertyName === 'hits'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');
      assert.strictEqual(updateNode.enclosingClassName, 'Stats', 'enclosingClassName should be "Stats"');
    });
  });

  // ============================================================================
  // Scope Integration (4.4)
  // ============================================================================
  describe('Scope integration', () => {
    it('should create UPDATE_EXPRESSION at module level with no CONTAINS edge', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
obj.count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');

      // Module-level should NOT have CONTAINS edge
      const containsEdge = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.dst === updateNode.id
      );

      assert.strictEqual(
        containsEdge, undefined,
        'Module-level UPDATE_EXPRESSION should NOT have CONTAINS edge'
      );
    });

    it('should create CONTAINS edge for UPDATE_EXPRESSION inside function', async () => {
      await setupTest(backend, {
        'index.js': `
function increment() {
  const obj = { count: 0 };
  obj.count++;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj'
      );
      // Function body scope is named "${functionName}:body"
      const functionScope = allNodes.find(n => n.type === 'SCOPE' && n.name === 'increment:body');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');
      assert.ok(functionScope, 'Function SCOPE not found (looking for increment:body)');

      const containsEdge = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.src === functionScope.id &&
        e.dst === updateNode.id
      );

      assert.ok(
        containsEdge,
        'Expected CONTAINS edge from function scope to UPDATE_EXPRESSION'
      );
    });

    it('should create CONTAINS edge for UPDATE_EXPRESSION inside nested scope', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  const obj = { count: 0 };
  if (true) {
    obj.count++;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj'
      );

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');

      // Should have CONTAINS edge from if-block scope
      const containsEdge = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.dst === updateNode.id
      );

      assert.ok(
        containsEdge,
        'Expected CONTAINS edge from nested scope to UPDATE_EXPRESSION'
      );
    });
  });

  // ============================================================================
  // Edge Cases (4.5)
  // ============================================================================
  describe('Edge cases and limitations', () => {
    it('should NOT create UPDATE_EXPRESSION for chained access (obj.nested.prop++)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { nested: { prop: 0 } };
obj.nested.prop++;
        `
      });

      const allNodes = await backend.getAllNodes();

      // Should NOT create UPDATE_EXPRESSION for chained access
      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION'
      );

      assert.strictEqual(
        updateNode, undefined,
        'UPDATE_EXPRESSION should NOT be created for chained access (documented limitation)'
      );
    });

    it('should NOT create UPDATE_EXPRESSION for complex object expressions', async () => {
      await setupTest(backend, {
        'index.js': `
const obj1 = { count: 0 };
const obj2 = { count: 1 };
(obj1 || obj2).count++;
        `
      });

      const allNodes = await backend.getAllNodes();

      // Should NOT create UPDATE_EXPRESSION for complex expressions
      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION'
      );

      assert.strictEqual(
        updateNode, undefined,
        'UPDATE_EXPRESSION should NOT be created for complex object expressions (documented limitation)'
      );
    });

    it('should handle mixed identifier and member expression updates', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { i: 0 };
let i = 0;
i++;       // IDENTIFIER update
obj.i++;   // MEMBER_EXPRESSION update
        `
      });

      const allNodes = await backend.getAllNodes();

      const identifierUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'IDENTIFIER' &&
        n.variableName === 'i'
      );

      const memberUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'obj' &&
        n.propertyName === 'i'
      );

      assert.ok(identifierUpdate, 'IDENTIFIER UPDATE_EXPRESSION not created for i++');
      assert.ok(memberUpdate, 'MEMBER_EXPRESSION UPDATE_EXPRESSION not created for obj.i++');
    });
  });

  // ============================================================================
  // Real-World Patterns (4.6)
  // ============================================================================
  describe('Real-world patterns', () => {
    it('should track array element increment in for-loop', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
for (let i = 0; i < arr.length; i++) {
  arr[i]++;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Should create UPDATE_EXPRESSION for arr[i]++
      const memberUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'arr' &&
        n.computedPropertyVar === 'i'
      );

      // Should create UPDATE_EXPRESSION for i++
      const identifierUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'IDENTIFIER' &&
        n.variableName === 'i'
      );

      assert.ok(memberUpdate, 'UPDATE_EXPRESSION not created for arr[i]++');
      assert.ok(identifierUpdate, 'UPDATE_EXPRESSION not created for i++');
    });

    it('should track counter in object literal', async () => {
      await setupTest(backend, {
        'index.js': `
const stats = { hits: 0, misses: 0 };

function recordHit() {
  stats.hits++;
}

function recordMiss() {
  stats.misses++;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const hitsUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'stats' &&
        n.propertyName === 'hits'
      );

      const missesUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'stats' &&
        n.propertyName === 'misses'
      );

      assert.ok(hitsUpdate, 'UPDATE_EXPRESSION not created for stats.hits++');
      assert.ok(missesUpdate, 'UPDATE_EXPRESSION not created for stats.misses++');
    });

    it('should track multiple properties on same object', async () => {
      await setupTest(backend, {
        'index.js': `
const coords = { x: 0, y: 0, z: 0 };
coords.x++;
coords.y++;
coords.z++;
        `
      });

      const allNodes = await backend.getAllNodes();

      const xUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'coords' &&
        n.propertyName === 'x'
      );

      const yUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'coords' &&
        n.propertyName === 'y'
      );

      const zUpdate = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION' &&
        n.objectName === 'coords' &&
        n.propertyName === 'z'
      );

      assert.ok(xUpdate, 'UPDATE_EXPRESSION not created for coords.x++');
      assert.ok(yUpdate, 'UPDATE_EXPRESSION not created for coords.y++');
      assert.ok(zUpdate, 'UPDATE_EXPRESSION not created for coords.z++');

      // All should modify the same object
      const allEdges = await backend.getAllEdges();
      const coordsVar = allNodes.find(n => n.name === 'coords' && n.type === 'CONSTANT');

      const xModifies = allEdges.find(e =>
        e.type === 'MODIFIES' && e.src === xUpdate.id && e.dst === coordsVar.id
      );
      const yModifies = allEdges.find(e =>
        e.type === 'MODIFIES' && e.src === yUpdate.id && e.dst === coordsVar.id
      );
      const zModifies = allEdges.find(e =>
        e.type === 'MODIFIES' && e.src === zUpdate.id && e.dst === coordsVar.id
      );

      assert.ok(xModifies, 'MODIFIES edge not created for coords.x++');
      assert.ok(yModifies, 'MODIFIES edge not created for coords.y++');
      assert.ok(zModifies, 'MODIFIES edge not created for coords.z++');
    });
  });

  // ============================================================================
  // Edge Direction Verification
  // ============================================================================
  describe('Edge direction verification', () => {
    it('should verify MODIFIES edge direction (src=UPDATE_EXPRESSION, dst=VARIABLE)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
obj.count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n =>
        n.type === 'UPDATE_EXPRESSION' &&
        n.targetType === 'MEMBER_EXPRESSION'
      );
      const objVar = allNodes.find(n => n.name === 'obj' && n.type === 'CONSTANT');

      const modifiesEdge = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.src === updateNode.id &&
        e.dst === objVar.id
      );

      assert.ok(modifiesEdge, 'MODIFIES edge not found');
      assert.strictEqual(modifiesEdge.src, updateNode.id, 'MODIFIES src should be UPDATE_EXPRESSION');
      assert.strictEqual(modifiesEdge.dst, objVar.id, 'MODIFIES dst should be VARIABLE(obj)');
    });

    it('should verify READS_FROM edge direction (src=VARIABLE, dst=VARIABLE)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { count: 0 };
obj.count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj' && n.type === 'CONSTANT');

      const readsFromSelfLoop = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === objVar.id &&
        e.dst === objVar.id
      );

      assert.ok(readsFromSelfLoop, 'READS_FROM self-loop not found');
      assert.strictEqual(readsFromSelfLoop.src, objVar.id, 'READS_FROM src should be VARIABLE(obj)');
      assert.strictEqual(readsFromSelfLoop.dst, objVar.id, 'READS_FROM dst should be VARIABLE(obj)');
    });
  });
});
