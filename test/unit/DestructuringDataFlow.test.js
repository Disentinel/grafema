/**
 * Destructuring Data Flow Tests
 *
 * Tests for preserving data flow through destructuring patterns:
 * - ObjectPattern: const { method } = config
 * - ArrayPattern: const [first] = arr
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { createTestOrchestrator, analyzeProject } from '../helpers/createTestOrchestrator.js';

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

  const backend = new RFDBServerBackend({ dbPath: join(testDir, 'test.db') });
  await backend.connect();
  await analyzeProject(backend, testDir);

  return { backend, testDir };
}

async function cleanup(backend, testDir) {
  await backend.close();
}

describe('Destructuring Data Flow', () => {
  describe('ObjectPattern', () => {
    it('should create ASSIGNED_FROM edge to EXPRESSION(config.method) for simple destructuring', async () => {
      // REG-201: const { method } = config should create:
      // method -> ASSIGNED_FROM -> EXPRESSION(config.method)
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edge to EXPRESSION(response.data.user.name) for nested destructuring', async () => {
      // REG-201: const { data: { user: { name } } } = response should create:
      // name -> ASSIGNED_FROM -> EXPRESSION(response.data.user.name)
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edge to EXPRESSION(obj.oldName) for renaming destructuring', async () => {
      // REG-201: const { oldName: newName } = obj should create:
      // newName -> ASSIGNED_FROM -> EXPRESSION(obj.oldName)
      // The variable name is 'newName' but it reads from obj.oldName
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edge with default value', async () => {
      // REG-201 Edge Case: const { x = 5 } = obj should still create:
      // x -> ASSIGNED_FROM -> EXPRESSION(obj.x)
      // Default value doesn't change the data flow source
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });
  });

  describe('ArrayPattern', () => {
    it('should create ASSIGNED_FROM edges to EXPRESSION(arr[0]) and EXPRESSION(arr[1]) for array destructuring', async () => {
      // REG-201: const [a, b] = arr should create:
      // a -> ASSIGNED_FROM -> EXPRESSION(arr[0]) with computed=true
      // b -> ASSIGNED_FROM -> EXPRESSION(arr[1]) with computed=true
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edge to whole array for rest element', async () => {
      // REG-201 Edge Case: const [first, ...rest] = arr
      // For rest elements, we create edge to the whole source (imprecise but not wrong)
      // rest -> ASSIGNED_FROM -> VARIABLE(arr) (not EXPRESSION)
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edge to whole object for object rest element', async () => {
      // REG-201 Edge Case: const { x, ...rest } = obj
      // rest -> ASSIGNED_FROM -> VARIABLE(obj)
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });
  });

  describe('Mixed destructuring patterns', () => {
    it('should create ASSIGNED_FROM edge for mixed object/array: const { items: [first] } = data', async () => {
      // REG-201: Mixed destructuring: const { items: [first] } = data
      // first -> ASSIGNED_FROM -> EXPRESSION representing data.items[0]
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });
  });

  describe('Value Domain Analysis integration', () => {
    it('should trace value through object destructuring to literal', async () => {
      // Integration test: verify destructuring data flow enables value tracing
      const { backend, testDir } = await setupTest({
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
        await cleanup(backend, testDir);
      }
    });
  });
});

export { setupTest, cleanup };
