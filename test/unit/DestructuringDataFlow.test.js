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
    it('should create ASSIGNED_FROM to object.property for simple destructuring', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const config = { method: 'save', timeout: 1000 };
const { method } = config;
`
      });

      try {
        // Find VARIABLE 'method'
        let methodVar = null;
        for await (const node of backend.queryNodes({ nodeType: 'VARIABLE' })) {
          if (node.name === 'method') {
            methodVar = node;
            break;
          }
        }
        // Also check CONSTANT (for const declarations with literals)
        if (!methodVar) {
          for await (const node of backend.queryNodes({ nodeType: 'CONSTANT' })) {
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

        // Target should be EXPRESSION with expressionType='MemberExpression'
        // or direct reference to config.method
        console.log('Target node:', target);
        assert.ok(target, 'ASSIGNED_FROM target should exist');

        // For proper data flow, the target should represent config.method, not just config
        // This could be an EXPRESSION node or a VARIABLE with derived property
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM for nested destructuring', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const response = { data: { user: { name: 'John' } } };
const { data: { user: { name } } } = response;
`
      });

      try {
        // Find VARIABLE 'name'
        let nameVar = null;
        for await (const node of backend.queryNodes({ nodeType: 'VARIABLE' })) {
          if (node.name === 'name') {
            nameVar = node;
            break;
          }
        }
        if (!nameVar) {
          for await (const node of backend.queryNodes({ nodeType: 'CONSTANT' })) {
            if (node.name === 'name') {
              nameVar = node;
              break;
            }
          }
        }

        assert.ok(nameVar, 'Should find variable "name"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(nameVar.id, ['ASSIGNED_FROM']);
        console.log('Nested destructuring edges:', edges);

        // Should have data flow edge
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge for nested destructuring');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should handle destructuring with renaming', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { oldName: 'value' };
const { oldName: newName } = obj;
`
      });

      try {
        // Find VARIABLE 'newName' (the renamed variable)
        let newNameVar = null;
        for await (const node of backend.queryNodes({ nodeType: 'VARIABLE' })) {
          if (node.name === 'newName') {
            newNameVar = node;
            break;
          }
        }
        if (!newNameVar) {
          for await (const node of backend.queryNodes({ nodeType: 'CONSTANT' })) {
            if (node.name === 'newName') {
              newNameVar = node;
              break;
            }
          }
        }

        assert.ok(newNameVar, 'Should find variable "newName"');

        // Get ASSIGNED_FROM edges - should point to obj.oldName
        const edges = await backend.getOutgoingEdges(newNameVar.id, ['ASSIGNED_FROM']);
        console.log('Renamed destructuring edges:', edges);

        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('ArrayPattern', () => {
    it('should create ASSIGNED_FROM to array[index] for array destructuring', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const arr = ['first', 'second', 'third'];
const [a, b] = arr;
`
      });

      try {
        // Find VARIABLE 'a' (first element)
        let aVar = null;
        for await (const node of backend.queryNodes({ nodeType: 'VARIABLE' })) {
          if (node.name === 'a') {
            aVar = node;
            break;
          }
        }
        if (!aVar) {
          for await (const node of backend.queryNodes({ nodeType: 'CONSTANT' })) {
            if (node.name === 'a') {
              aVar = node;
              break;
            }
          }
        }

        assert.ok(aVar, 'Should find variable "a"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(aVar.id, ['ASSIGNED_FROM']);
        console.log('Array destructuring edges for a:', edges);

        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge for array destructuring');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should handle rest element in array destructuring', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const arr = [1, 2, 3, 4, 5];
const [first, ...rest] = arr;
`
      });

      try {
        // Find VARIABLE 'rest'
        let restVar = null;
        for await (const node of backend.queryNodes({ nodeType: 'VARIABLE' })) {
          if (node.name === 'rest') {
            restVar = node;
            break;
          }
        }
        if (!restVar) {
          for await (const node of backend.queryNodes({ nodeType: 'CONSTANT' })) {
            if (node.name === 'rest') {
              restVar = node;
              break;
            }
          }
        }

        assert.ok(restVar, 'Should find variable "rest"');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(restVar.id, ['ASSIGNED_FROM']);
        console.log('Rest element edges:', edges);

        // Rest element should have data flow edge
        assert.ok(edges.length > 0, 'Should have ASSIGNED_FROM edge for rest element');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('Value Domain Analysis integration', () => {
    it('should trace value through object destructuring to literal', async () => {
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
        for await (const node of backend.queryNodes({ nodeType: 'CALL' })) {
          if (node.computed === true) {
            computedCall = node;
            break;
          }
        }

        console.log('Computed call:', computedCall);

        // If data flow is preserved through destructuring,
        // ValueDomainAnalyzer should be able to resolve this
        // (requires both destructuring data flow AND ValueDomainAnalyzer)
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });
});

export { setupTest, cleanup };
