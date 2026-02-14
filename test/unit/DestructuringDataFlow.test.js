/**
 * Destructuring Data Flow Tests
 *
 * Tests for preserving data flow through destructuring patterns:
 * - ObjectPattern: const { method } = config
 * - ArrayPattern: const [first] = arr
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync } from 'fs';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { analyzeProject } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(files) {
  const testDir = join(tmpdir(), `navi-test-destruct-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(join(testDir, 'package.json'), JSON.stringify({
    name: 'destructuring-test',
    version: '1.0.0'
  }));

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(testDir, name), content);
  }

  const db = await createTestDatabase();
  const backend = db.backend;
  await analyzeProject(backend, testDir);

  return { backend, db, testDir };
}

async function cleanup(db) {
  await db.cleanup();
}

describe('Destructuring Data Flow', () => {
  describe('ObjectPattern', () => {
    it('should create ASSIGNED_FROM edge to EXPRESSION(config.method) for simple destructuring', async () => {
      // REG-201: const { method } = config should create:
      // method -> ASSIGNED_FROM -> EXPRESSION(config.method)
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const config = { method: 'save', timeout: 1000 };
const { method } = config;
`
      });

      try {
        // Find VARIABLE 'method'
        let methodVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'method') {
            methodVar = node;
            break;
          }
        }
        // Also check CONSTANT (for const declarations with literals)
        if (!methodVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'method') {
              methodVar = node;
              break;
            }
          }
        }

        assert.ok(methodVar, 'Should find variable "method"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(methodVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge');

        // The edge should point to an EXPRESSION representing config.method
        const targetId = edges[0].dst;
        const target = await backend.getNode(targetId);
        assert.ok(target, 'ASSIGNED_FROM target should exist');

        // REG-201 requirement: Target MUST be EXPRESSION with expressionType='MemberExpression'
        // representing config.method, NOT just the variable 'config'
        assert.strictEqual(target.type, 'EXPRESSION',
          `Expected EXPRESSION node for destructured property, got ${target.type}`);
        assert.strictEqual(target.expressionType, 'MemberExpression',
          `Expected MemberExpression, got ${target.expressionType}`);
        assert.strictEqual(target.object, 'config',
          `Expected object='config', got ${target.object}`);
        assert.strictEqual(target.property, 'method',
          `Expected property='method', got ${target.property}`);

        // REG-201 bug fix: EXPRESSION must have DERIVES_FROM edge to source variable
        const derivesEdges = await backend.getOutgoingEdges(target.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'EXPRESSION should DERIVES_FROM source variable');
        const sourceVar = await backend.getNode(derivesEdges[0].dst);
        assert.ok(sourceVar, 'Source variable should exist');
        assert.strictEqual(sourceVar.name, 'config', 'Should derive from config');
      } finally {
        await cleanup(db);
      }
    });

    it('should create ASSIGNED_FROM edge to EXPRESSION(response.data.user.name) for nested destructuring', async () => {
      // REG-201: const { data: { user: { name } } } = response should create:
      // name -> ASSIGNED_FROM -> EXPRESSION(response.data.user.name)
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const response = { data: { user: { name: 'John' } } };
const { data: { user: { name } } } = response;
`
      });

      try {
        // Find VARIABLE 'name'
        let nameVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'name') {
            nameVar = node;
            break;
          }
        }
        if (!nameVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'name') {
              nameVar = node;
              break;
            }
          }
        }

        assert.ok(nameVar, 'Should find variable "name"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(nameVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge for nested destructuring');

        // REG-201 requirement: Target MUST be EXPRESSION representing response.data.user.name
        const target = await backend.getNode(edges[0].dst);
        assert.ok(target, 'ASSIGNED_FROM target should exist');
        assert.strictEqual(target.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${target.type}`);
        assert.strictEqual(target.expressionType, 'MemberExpression',
          `Expected MemberExpression, got ${target.expressionType}`);
        assert.strictEqual(target.object, 'response',
          `Expected object='response', got ${target.object}`);
        // For nested destructuring, propertyPath should contain full path
        assert.deepStrictEqual(target.propertyPath, ['data', 'user', 'name'],
          `Expected propertyPath=['data', 'user', 'name'], got ${JSON.stringify(target.propertyPath)}`);

        // REG-201 bug fix: EXPRESSION must have DERIVES_FROM edge to source variable
        const derivesEdges = await backend.getOutgoingEdges(target.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'EXPRESSION should DERIVES_FROM source variable');
        const sourceVar = await backend.getNode(derivesEdges[0].dst);
        assert.ok(sourceVar, 'Source variable should exist');
        assert.strictEqual(sourceVar.name, 'response', 'Should derive from response');
      } finally {
        await cleanup(db);
      }
    });

    it('should create ASSIGNED_FROM edge to EXPRESSION(obj.oldName) for renaming destructuring', async () => {
      // REG-201: const { oldName: newName } = obj should create:
      // newName -> ASSIGNED_FROM -> EXPRESSION(obj.oldName)
      // The variable name is 'newName' but it reads from obj.oldName
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const obj = { oldName: 'value' };
const { oldName: newName } = obj;
`
      });

      try {
        // Find VARIABLE 'newName' (the renamed variable)
        let newNameVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'newName') {
            newNameVar = node;
            break;
          }
        }
        if (!newNameVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'newName') {
              newNameVar = node;
              break;
            }
          }
        }

        assert.ok(newNameVar, 'Should find variable "newName"');

        // Get ASSIGNED_FROM edges - should point to obj.oldName
        const edges = await backend.getOutgoingEdges(newNameVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge');

        // REG-201 requirement: Target MUST be EXPRESSION for obj.oldName (NOT obj.newName)
        const target = await backend.getNode(edges[0].dst);
        assert.ok(target, 'ASSIGNED_FROM target should exist');
        assert.strictEqual(target.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${target.type}`);
        assert.strictEqual(target.expressionType, 'MemberExpression',
          `Expected MemberExpression, got ${target.expressionType}`);
        assert.strictEqual(target.object, 'obj',
          `Expected object='obj', got ${target.object}`);
        assert.strictEqual(target.property, 'oldName',
          `Expected property='oldName' (original key, not renamed), got ${target.property}`);

        // REG-201 bug fix: EXPRESSION must have DERIVES_FROM edge to source variable
        const derivesEdges = await backend.getOutgoingEdges(target.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'EXPRESSION should DERIVES_FROM source variable');
        const sourceVar = await backend.getNode(derivesEdges[0].dst);
        assert.ok(sourceVar, 'Source variable should exist');
        assert.strictEqual(sourceVar.name, 'obj', 'Should derive from obj');
      } finally {
        await cleanup(db);
      }
    });

    it('should create ASSIGNED_FROM edge with default value', async () => {
      // REG-201 Edge Case: const { x = 5 } = obj should still create:
      // x -> ASSIGNED_FROM -> EXPRESSION(obj.x)
      // Default value doesn't change the data flow source
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const obj = { y: 10 };
const { x = 5 } = obj;
`
      });

      try {
        // Find VARIABLE 'x'
        let xVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'x') {
            xVar = node;
            break;
          }
        }
        if (!xVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'x') {
              xVar = node;
              break;
            }
          }
        }

        assert.ok(xVar, 'Should find variable "x"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(xVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge even with default value');

        // REG-201 requirement: Target MUST be EXPRESSION for obj.x
        const target = await backend.getNode(edges[0].dst);
        assert.ok(target, 'ASSIGNED_FROM target should exist');
        assert.strictEqual(target.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${target.type}`);
        assert.strictEqual(target.expressionType, 'MemberExpression',
          `Expected MemberExpression, got ${target.expressionType}`);
        assert.strictEqual(target.object, 'obj',
          `Expected object='obj', got ${target.object}`);
        assert.strictEqual(target.property, 'x',
          `Expected property='x', got ${target.property}`);

        // REG-201 bug fix: EXPRESSION must have DERIVES_FROM edge to source variable
        const derivesEdges = await backend.getOutgoingEdges(target.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'EXPRESSION should DERIVES_FROM source variable');
        const sourceVar = await backend.getNode(derivesEdges[0].dst);
        assert.ok(sourceVar, 'Source variable should exist');
        assert.strictEqual(sourceVar.name, 'obj', 'Should derive from obj');
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('ArrayPattern', () => {
    it('should create ASSIGNED_FROM edges to EXPRESSION(arr[0]) and EXPRESSION(arr[1]) for array destructuring', async () => {
      // REG-201: const [a, b] = arr should create:
      // a -> ASSIGNED_FROM -> EXPRESSION(arr[0]) with computed=true
      // b -> ASSIGNED_FROM -> EXPRESSION(arr[1]) with computed=true
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const arr = ['first', 'second', 'third'];
const [a, b] = arr;
`
      });

      try {
        // Find VARIABLE 'a' (first element, index 0)
        let aVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'a') {
            aVar = node;
            break;
          }
        }
        if (!aVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'a') {
              aVar = node;
              break;
            }
          }
        }

        assert.ok(aVar, 'Should find variable "a"');

        // Get ASSIGNED_FROM edges for 'a'
        const aEdges = await backend.getOutgoingEdges(aVar.id, ['ASSIGNED_FROM']);
        assert.ok(aEdges.length > 0, 'Should have ASSIGNED_FROM edge for array element a');

        // REG-201 requirement: Target MUST be EXPRESSION for arr[0]
        const aTarget = await backend.getNode(aEdges[0].dst);
        assert.ok(aTarget, 'ASSIGNED_FROM target for a should exist');
        assert.strictEqual(aTarget.type, 'EXPRESSION',
          `Expected EXPRESSION node for a, got ${aTarget.type}`);
        assert.strictEqual(aTarget.expressionType, 'MemberExpression',
          `Expected MemberExpression for a, got ${aTarget.expressionType}`);
        assert.strictEqual(aTarget.object, 'arr',
          `Expected object='arr', got ${aTarget.object}`);
        assert.strictEqual(aTarget.computed, true,
          `Expected computed=true for array access, got ${aTarget.computed}`);
        assert.strictEqual(aTarget.arrayIndex, 0,
          `Expected arrayIndex=0 for first element, got ${aTarget.arrayIndex}`);

        // REG-201 bug fix: EXPRESSION must have DERIVES_FROM edge to source variable
        const aDerivesEdges = await backend.getOutgoingEdges(aTarget.id, ['DERIVES_FROM']);
        assert.strictEqual(aDerivesEdges.length, 1, 'EXPRESSION for a should DERIVES_FROM source variable');
        const aSourceVar = await backend.getNode(aDerivesEdges[0].dst);
        assert.ok(aSourceVar, 'Source variable for a should exist');
        assert.strictEqual(aSourceVar.name, 'arr', 'Should derive from arr');

        // Find VARIABLE 'b' (second element, index 1)
        let bVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'b') {
            bVar = node;
            break;
          }
        }
        if (!bVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'b') {
              bVar = node;
              break;
            }
          }
        }

        assert.ok(bVar, 'Should find variable "b"');

        // Get ASSIGNED_FROM edges for 'b'
        const bEdges = await backend.getOutgoingEdges(bVar.id, ['ASSIGNED_FROM']);
        assert.ok(bEdges.length > 0, 'Should have ASSIGNED_FROM edge for array element b');

        // REG-201 requirement: Target MUST be EXPRESSION for arr[1]
        const bTarget = await backend.getNode(bEdges[0].dst);
        assert.ok(bTarget, 'ASSIGNED_FROM target for b should exist');
        assert.strictEqual(bTarget.type, 'EXPRESSION',
          `Expected EXPRESSION node for b, got ${bTarget.type}`);
        assert.strictEqual(bTarget.arrayIndex, 1,
          `Expected arrayIndex=1 for second element, got ${bTarget.arrayIndex}`);

        // REG-201 bug fix: EXPRESSION must have DERIVES_FROM edge to source variable
        const bDerivesEdges = await backend.getOutgoingEdges(bTarget.id, ['DERIVES_FROM']);
        assert.strictEqual(bDerivesEdges.length, 1, 'EXPRESSION for b should DERIVES_FROM source variable');
        const bSourceVar = await backend.getNode(bDerivesEdges[0].dst);
        assert.ok(bSourceVar, 'Source variable for b should exist');
        assert.strictEqual(bSourceVar.name, 'arr', 'Should derive from arr');
      } finally {
        await cleanup(db);
      }
    });

    it('should create ASSIGNED_FROM edge to whole array for rest element', async () => {
      // REG-201 Edge Case: const [first, ...rest] = arr
      // For rest elements, we create edge to the whole source (imprecise but not wrong)
      // rest -> ASSIGNED_FROM -> VARIABLE(arr) (not EXPRESSION)
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const arr = [1, 2, 3, 4, 5];
const [first, ...rest] = arr;
`
      });

      try {
        // Find VARIABLE 'rest'
        let restVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'rest') {
            restVar = node;
            break;
          }
        }
        if (!restVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'rest') {
              restVar = node;
              break;
            }
          }
        }

        assert.ok(restVar, 'Should find variable "rest"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(restVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge for rest element');

        // REG-201: Rest element should point to whole source (VARIABLE/CONSTANT arr)
        // Not to a specific index expression
        const target = await backend.getNode(edges[0].dst);
        assert.ok(target, 'ASSIGNED_FROM target should exist');

        // Rest elements get edge to the whole source variable (could be VARIABLE or CONSTANT)
        assert.ok(['VARIABLE', 'CONSTANT'].includes(target.type),
          `Expected rest element to point to VARIABLE or CONSTANT (whole array), got ${target.type}`);
        assert.strictEqual(target.name, 'arr',
          `Expected target to be 'arr', got ${target.name}`);
      } finally {
        await cleanup(db);
      }
    });

    it('should create ASSIGNED_FROM edge to whole object for object rest element', async () => {
      // REG-201 Edge Case: const { x, ...rest } = obj
      // rest -> ASSIGNED_FROM -> VARIABLE(obj)
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const obj = { x: 1, y: 2, z: 3 };
const { x, ...rest } = obj;
`
      });

      try {
        // Find VARIABLE 'rest'
        let restVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'rest') {
            restVar = node;
            break;
          }
        }
        if (!restVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'rest') {
              restVar = node;
              break;
            }
          }
        }

        assert.ok(restVar, 'Should find variable "rest"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(restVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge for object rest element');

        // REG-201: Object rest element should point to whole source object
        const target = await backend.getNode(edges[0].dst);
        assert.ok(target, 'ASSIGNED_FROM target should exist');
        assert.ok(['VARIABLE', 'CONSTANT'].includes(target.type),
          `Expected rest element to point to VARIABLE or CONSTANT (whole object), got ${target.type}`);
        assert.strictEqual(target.name, 'obj',
          `Expected target to be 'obj', got ${target.name}`);
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('Mixed destructuring patterns', () => {
    it('should create ASSIGNED_FROM edge for mixed object/array: const { items: [first] } = data', async () => {
      // REG-201: Mixed destructuring: const { items: [first] } = data
      // first -> ASSIGNED_FROM -> EXPRESSION representing data.items[0]
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const data = { items: ['apple', 'banana', 'cherry'] };
const { items: [first] } = data;
`
      });

      try {
        // Find VARIABLE 'first'
        let firstVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'first') {
            firstVar = node;
            break;
          }
        }
        if (!firstVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'first') {
              firstVar = node;
              break;
            }
          }
        }

        assert.ok(firstVar, 'Should find variable "first"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(firstVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge for mixed destructuring');

        // REG-201 requirement: Target should represent data.items[0]
        // The propertyPath should be ['items'] and arrayIndex should be 0
        const target = await backend.getNode(edges[0].dst);
        assert.ok(target, 'ASSIGNED_FROM target should exist');
        assert.strictEqual(target.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${target.type}`);
        assert.strictEqual(target.expressionType, 'MemberExpression',
          `Expected MemberExpression, got ${target.expressionType}`);
        assert.strictEqual(target.object, 'data',
          `Expected object='data', got ${target.object}`);
        // Should have both propertyPath and arrayIndex for mixed pattern
        assert.deepStrictEqual(target.propertyPath, ['items'],
          `Expected propertyPath=['items'], got ${JSON.stringify(target.propertyPath)}`);
        assert.strictEqual(target.arrayIndex, 0,
          `Expected arrayIndex=0, got ${target.arrayIndex}`);

        // REG-201 bug fix: EXPRESSION must have DERIVES_FROM edge to source variable
        const derivesEdges = await backend.getOutgoingEdges(target.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'EXPRESSION should DERIVES_FROM source variable');
        const sourceVar = await backend.getNode(derivesEdges[0].dst);
        assert.ok(sourceVar, 'Source variable should exist');
        assert.strictEqual(sourceVar.name, 'data', 'Should derive from data');
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('Value Domain Analysis integration', () => {
    it('should trace value through object destructuring to literal', async () => {
      // Integration test: verify destructuring data flow enables value tracing
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const config = { method: 'save' };
const { method } = config;

const obj = {
  save() { return 'saved'; },
  delete() { return 'deleted'; }
};

obj[method]();  // Should resolve to obj.save() if data flow is preserved
`
      });

      try {
        // Find CALL with computed member access
        let computedCall = null;
        for await (const node of backend.queryNodes({ type: 'CALL' })) {
          if (node.computed === true) {
            computedCall = node;
            break;
          }
        }

        // If data flow is preserved through destructuring,
        // ValueDomainAnalyzer should be able to resolve this
        // (requires both destructuring data flow AND ValueDomainAnalyzer)
        assert.ok(computedCall, 'Should find computed call obj[method]()');
      } finally {
        await cleanup(db);
      }
    });
  });
});

/**
 * Helper function to find a variable by name
 * Searches both VARIABLE and CONSTANT nodes
 */
async function findVariable(backend, name) {
  for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
    if (node.name === name) return node;
  }
  for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
    if (node.name === name) return node;
  }
  return null;
}

describe('Complex Init Expressions (REG-223)', () => {
  describe('Basic CallExpression', () => {
    it('should create ASSIGNED_FROM edge to EXPRESSION for simple call', async () => {
      // REG-223: const { apiKey } = getConfig() should create:
      // apiKey -> ASSIGNED_FROM -> EXPRESSION(getConfig().apiKey)
      // EXPRESSION -> DERIVES_FROM -> CALL_SITE(getConfig)
      const { backend, db, testDir } = await setupTest({
        'index.js': `
function getConfig() {
  return { apiKey: 'secret', timeout: 1000 };
}
const { apiKey } = getConfig();
`
      });

      try {
        // Find variable 'apiKey'
        const apiKeyVar = await findVariable(backend, 'apiKey');
        assert.ok(apiKeyVar, 'Should find variable "apiKey"');

        // Check ASSIGNED_FROM edge
        const edges = await backend.getOutgoingEdges(apiKeyVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have exactly one ASSIGNED_FROM edge');

        // Verify EXPRESSION node
        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${expr.type}`);
        assert.strictEqual(expr.expressionType, 'MemberExpression',
          `Expected MemberExpression, got ${expr.expressionType}`);
        assert.strictEqual(expr.object, 'getConfig()',
          `Expected object='getConfig()', got ${expr.object}`);
        assert.strictEqual(expr.property, 'apiKey',
          `Expected property='apiKey', got ${expr.property}`);

        // Verify DERIVES_FROM edge to CALL_SITE
        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'Should have DERIVES_FROM edge');

        const callSite = await backend.getNode(derivesEdges[0].dst);
        assert.strictEqual(callSite.type, 'CALL',
          `Expected CALL node, got ${callSite.type}`);
        assert.strictEqual(callSite.name, 'getConfig',
          `Expected name='getConfig', got ${callSite.name}`);
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('AwaitExpression', () => {
    it('should handle await unwrapping', async () => {
      // REG-223: const { name } = await fetchUser() should create:
      // name -> ASSIGNED_FROM -> EXPRESSION(fetchUser().name)
      // EXPRESSION -> DERIVES_FROM -> CALL_SITE(fetchUser) [NOT the await]
      const { backend, db, testDir } = await setupTest({
        'index.js': `
async function fetchUser() {
  return { id: 1, name: 'Alice' };
}
async function main() {
  const { name } = await fetchUser();
}
`
      });

      try {
        const nameVar = await findVariable(backend, 'name');
        assert.ok(nameVar, 'Should find variable "name"');

        const edges = await backend.getOutgoingEdges(nameVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${expr.type}`);
        assert.strictEqual(expr.object, 'fetchUser()',
          `Expected object='fetchUser()' (await unwrapped), got ${expr.object}`);

        // DERIVES_FROM should point to fetchUser CALL_SITE (after await unwrapping)
        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1,
          'Should have DERIVES_FROM edge (await should be unwrapped)');

        const callSite = await backend.getNode(derivesEdges[0].dst);
        assert.strictEqual(callSite.type, 'CALL',
          `Expected CALL node, got ${callSite.type}`);
        assert.strictEqual(callSite.name, 'fetchUser',
          `Expected name='fetchUser', got ${callSite.name}`);
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('Method Call', () => {
    it('should handle method calls', async () => {
      // REG-223: const [first] = arr.filter(x => x > 0) should create:
      // first -> ASSIGNED_FROM -> EXPRESSION(arr.filter()[0])
      // EXPRESSION -> DERIVES_FROM -> CALL(arr.filter)
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const arr = [1, 2, 3];
const [first] = arr.filter(x => x > 0);
`
      });

      try {
        const firstVar = await findVariable(backend, 'first');
        assert.ok(firstVar, 'Should find variable "first"');

        const edges = await backend.getOutgoingEdges(firstVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${expr.type}`);
        assert.strictEqual(expr.object, 'arr.filter()',
          `Expected object='arr.filter()', got ${expr.object}`);
        assert.strictEqual(expr.property, '0',
          `Expected property='0' (array index), got ${expr.property}`);
        assert.strictEqual(expr.computed, true,
          `Expected computed=true for array access, got ${expr.computed}`);

        // DERIVES_FROM should point to CALL node
        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'Should have DERIVES_FROM edge');

        const methodCall = await backend.getNode(derivesEdges[0].dst);
        assert.strictEqual(methodCall.type, 'CALL',
          `Expected CALL node, got ${methodCall.type}`);
        assert.ok(methodCall.name.includes('filter'),
          `Expected name to include 'filter', got ${methodCall.name}`);
      } finally {
        await cleanup(db);
      }
    });

    it('should handle object method call: const { x } = obj.getConfig()', async () => {
      // REG-223: MemberExpression callee
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const obj = {
  getConfig() {
    return { x: 1, y: 2 };
  }
};
const { x } = obj.getConfig();
`
      });

      try {
        const xVar = await findVariable(backend, 'x');
        assert.ok(xVar, 'Should find variable "x"');

        const edges = await backend.getOutgoingEdges(xVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${expr.type}`);
        assert.strictEqual(expr.object, 'obj.getConfig()',
          `Expected object='obj.getConfig()', got ${expr.object}`);
        assert.strictEqual(expr.property, 'x',
          `Expected property='x', got ${expr.property}`);

        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'Should have DERIVES_FROM edge');

        const methodCall = await backend.getNode(derivesEdges[0].dst);
        assert.strictEqual(methodCall.type, 'CALL',
          `Expected CALL node, got ${methodCall.type}`);
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('Nested Destructuring with Call', () => {
    it('should handle nested destructuring from call', async () => {
      // REG-223: const { user: { name } } = fetchData() should create:
      // name -> ASSIGNED_FROM -> EXPRESSION(fetchData().user.name)
      const { backend, db, testDir } = await setupTest({
        'index.js': `
function fetchData() {
  return { user: { id: 1, name: 'Bob' }, timestamp: 123 };
}
const { user: { name } } = fetchData();
`
      });

      try {
        const nameVar = await findVariable(backend, 'name');
        assert.ok(nameVar, 'Should find variable "name"');

        const edges = await backend.getOutgoingEdges(nameVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${expr.type}`);
        assert.strictEqual(expr.object, 'fetchData()',
          `Expected object='fetchData()', got ${expr.object}`);
        assert.strictEqual(expr.path, 'fetchData().user.name',
          `Expected path='fetchData().user.name', got ${expr.path}`);

        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'Should have DERIVES_FROM edge');

        const callSite = await backend.getNode(derivesEdges[0].dst);
        assert.strictEqual(callSite.type, 'CALL',
          `Expected CALL node, got ${callSite.type}`);
        assert.strictEqual(callSite.name, 'fetchData',
          `Expected name='fetchData', got ${callSite.name}`);
      } finally {
        await cleanup(db);
      }
    });

    it('should handle nested await destructuring: const { user: { name } } = await fetchProfile()', async () => {
      const { backend, db, testDir } = await setupTest({
        'index.js': `
async function fetchProfile() {
  return { user: { name: 'Alice', email: 'a@b.com' } };
}
async function main() {
  const { user: { name } } = await fetchProfile();
}
`
      });

      try {
        const nameVar = await findVariable(backend, 'name');
        assert.ok(nameVar, 'Should find variable "name"');

        const edges = await backend.getOutgoingEdges(nameVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.object, 'fetchProfile()',
          `Expected object='fetchProfile()' (await unwrapped), got ${expr.object}`);
        assert.deepStrictEqual(expr.propertyPath, ['user', 'name'],
          `Expected propertyPath=['user', 'name'], got ${JSON.stringify(expr.propertyPath)}`);

        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'Should have DERIVES_FROM edge');

        const callSite = await backend.getNode(derivesEdges[0].dst);
        assert.strictEqual(callSite.name, 'fetchProfile',
          `Expected name='fetchProfile', got ${callSite.name}`);
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('Mixed Pattern with Call', () => {
    it('should handle mixed object and array destructuring from call', async () => {
      // REG-223: const { items: [first] } = getResponse() should create:
      // first -> ASSIGNED_FROM -> EXPRESSION(getResponse().items[0])
      const { backend, db, testDir } = await setupTest({
        'index.js': `
function getResponse() {
  return { items: [{ id: 1 }, { id: 2 }], status: 'ok' };
}
const { items: [first] } = getResponse();
`
      });

      try {
        const firstVar = await findVariable(backend, 'first');
        assert.ok(firstVar, 'Should find variable "first"');

        const edges = await backend.getOutgoingEdges(firstVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${expr.type}`);
        assert.strictEqual(expr.object, 'getResponse()',
          `Expected object='getResponse()', got ${expr.object}`);
        assert.strictEqual(expr.arrayIndex, 0,
          `Expected arrayIndex=0, got ${expr.arrayIndex}`);
        assert.deepStrictEqual(expr.propertyPath, ['items'],
          `Expected propertyPath=['items'], got ${JSON.stringify(expr.propertyPath)}`);

        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'Should have DERIVES_FROM edge');

        const callSite = await backend.getNode(derivesEdges[0].dst);
        assert.strictEqual(callSite.type, 'CALL',
          `Expected CALL node, got ${callSite.type}`);
        assert.strictEqual(callSite.name, 'getResponse',
          `Expected name='getResponse', got ${callSite.name}`);
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('Rest Element with Call', () => {
    it('should create direct CALL_SITE assignment for rest element', async () => {
      // REG-223: const { a, ...rest } = getConfig() should create:
      // rest -> ASSIGNED_FROM -> CALL(getConfig) directly (not EXPRESSION)
      const { backend, db, testDir } = await setupTest({
        'index.js': `
function getConfig() {
  return { a: 1, b: 2, c: 3 };
}
const { a, ...rest } = getConfig();
`
      });

      try {
        const restVar = await findVariable(backend, 'rest');
        assert.ok(restVar, 'Should find variable "rest"');

        const edges = await backend.getOutgoingEdges(restVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        // Rest should point directly to CALL_SITE, not EXPRESSION
        const target = await backend.getNode(edges[0].dst);
        assert.strictEqual(target.type, 'CALL',
          `Expected rest element to point to CALL node, got ${target.type}`);
        assert.strictEqual(target.name, 'getConfig',
          `Expected name='getConfig', got ${target.name}`);
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('REG-201 Regression Test', () => {
    it('should NOT break existing simple destructuring (REG-201)', async () => {
      // REG-223 must NOT break REG-201 functionality
      const { backend, db, testDir } = await setupTest({
        'index.js': `
const config = { apiKey: 'secret' };
const { apiKey } = config;
`
      });

      try {
        const apiKeyVar = await findVariable(backend, 'apiKey');
        assert.ok(apiKeyVar, 'Should find variable "apiKey"');

        const edges = await backend.getOutgoingEdges(apiKeyVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${expr.type}`);
        assert.strictEqual(expr.object, 'config',
          `Expected object='config' (NOT 'config()'), got ${expr.object}`);
        assert.strictEqual(expr.property, 'apiKey',
          `Expected property='apiKey', got ${expr.property}`);

        // DERIVES_FROM should point to VARIABLE, not CALL_SITE
        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1, 'EXPRESSION should DERIVES_FROM source');

        const source = await backend.getNode(derivesEdges[0].dst);
        assert.ok(['VARIABLE', 'CONSTANT'].includes(source.type),
          `Expected VARIABLE or CONSTANT for simple destructuring, got ${source.type}`);
        assert.strictEqual(source.name, 'config',
          `Expected name='config', got ${source.name}`);
      } finally {
        await cleanup(db);
      }
    });
  });

  describe('Coordinate Validation (REVISION 2)', () => {
    it('should handle await with correct coordinate lookup', async () => {
      // Test coordinate mapping: await on different line than call
      const { backend, db, testDir } = await setupTest({
        'index.js': `
async function fetchUser() {
  return { id: 1, name: 'Alice' };
}
async function main() {
  const { id } =
    await fetchUser();
}
`
      });

      try {
        // Verify DERIVES_FROM edge exists (if missing, coordinate lookup failed)
        const idVar = await findVariable(backend, 'id');
        assert.ok(idVar, 'Should find variable "id"');

        const edges = await backend.getOutgoingEdges(idVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

        const expr = await backend.getNode(edges[0].dst);
        assert.strictEqual(expr.type, 'EXPRESSION',
          `Expected EXPRESSION node, got ${expr.type}`);
        assert.strictEqual(expr.object, 'fetchUser()',
          `Expected object='fetchUser()', got ${expr.object}`);

        // CRITICAL: Verify DERIVES_FROM edge exists
        const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
        assert.strictEqual(derivesEdges.length, 1,
          'Coordinate lookup must succeed for await expression - if this fails, ' +
          'AwaitExpression coordinates are being used instead of CallExpression coordinates');

        const callSite = await backend.getNode(derivesEdges[0].dst);
        assert.strictEqual(callSite.type, 'CALL',
          `Expected CALL node, got ${callSite.type}`);
        assert.strictEqual(callSite.name, 'fetchUser',
          `Expected name='fetchUser', got ${callSite.name}`);
      } finally {
        await cleanup(db);
      }
    });

    it('should handle multiple calls on same line with correct disambiguation', async () => {
      // Test function name disambiguation when multiple calls on same line
      const { backend, db, testDir } = await setupTest({
        'index.js': `
function f1() { return { x: 1 }; }
function f2() { return { y: 2 }; }
const { x } = f1(), { y } = f2();
`
      });

      try {
        // Verify both destructurings create correct DERIVES_FROM edges
        const xVar = await findVariable(backend, 'x');
        assert.ok(xVar, 'Should find variable "x"');

        const xEdges = await backend.getOutgoingEdges(xVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(xEdges.length, 1, 'x should have ASSIGNED_FROM edge');

        const xExpr = await backend.getNode(xEdges[0].dst);
        const xDerives = await backend.getOutgoingEdges(xExpr.id, ['DERIVES_FROM']);
        assert.strictEqual(xDerives.length, 1, 'x should have DERIVES_FROM edge');

        const xCall = await backend.getNode(xDerives[0].dst);
        assert.strictEqual(xCall.name, 'f1',
          `x should derive from f1, not f2. Got ${xCall.name}`);

        const yVar = await findVariable(backend, 'y');
        assert.ok(yVar, 'Should find variable "y"');

        const yEdges = await backend.getOutgoingEdges(yVar.id, ['ASSIGNED_FROM']);
        assert.strictEqual(yEdges.length, 1, 'y should have ASSIGNED_FROM edge');

        const yExpr = await backend.getNode(yEdges[0].dst);
        const yDerives = await backend.getOutgoingEdges(yExpr.id, ['DERIVES_FROM']);
        assert.strictEqual(yDerives.length, 1, 'y should have DERIVES_FROM edge');

        const yCall = await backend.getNode(yDerives[0].dst);
        assert.strictEqual(yCall.name, 'f2',
          `y should derive from f2, not f1. Got ${yCall.name}`);
      } finally {
        await cleanup(db);
      }
    });
  });
});

export { setupTest, cleanup, findVariable };
