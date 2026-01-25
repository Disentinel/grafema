/**
 * RFDBServerBackend Type Safety Test (REG-192)
 *
 * Verifies that RFDBServerBackend returns BaseNodeRecord-shaped nodes
 * with proper type safety, eliminating the need for `(node as any)` casts
 * in CLI commands.
 *
 * Key behaviors tested:
 * 1. Nodes have 'type' field (NOT 'nodeType')
 * 2. Nodes have 'exported' field as boolean
 * 3. Metadata is spread to top level
 * 4. No 'nodeType' duplication
 * 5. All BaseNodeRecord fields are accessible without casting
 *
 * Related: REG-192 (RFDB Type Safety)
 * Plans:
 * - /Users/vadimr/grafema-worker-7/_tasks/2025-01-25-reg-192-rfdb-type-safety/002-don-plan.md
 * - /Users/vadimr/grafema-worker-7/_tasks/2025-01-25-reg-192-rfdb-type-safety/003-joel-tech-plan.md
 * - /Users/vadimr/grafema-worker-7/_tasks/2025-01-25-reg-192-rfdb-type-safety/004-linus-plan-review.md
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { RFDBServerBackend } from '@grafema/core';

let testCounter = 0;

/**
 * Create unique test paths for each test run
 */
function createTestPaths() {
  const testId = `type-safety-${Date.now()}-${testCounter++}`;
  const testDir = join(tmpdir(), `.grafema-test-${testId}`);
  const dbPath = join(testDir, 'graph.rfdb');
  const socketPath = join(testDir, 'rfdb.sock');

  mkdirSync(testDir, { recursive: true });

  return { testDir, dbPath, socketPath };
}

describe('RFDBServerBackend Type Safety (REG-192)', () => {
  let testPaths;

  before(() => {
    testPaths = createTestPaths();
  });

  after(async () => {
    // Cleanup test directory
    if (testPaths?.testDir) {
      try {
        rmSync(testPaths.testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should return nodes with "type" field (not "nodeType")', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add a function node
    await backend.addNodes([
      {
        id: 'test.js->FUNCTION->authenticate',
        type: 'FUNCTION',
        name: 'authenticate',
        file: 'test.js',
        exported: true,
        async: true,
        params: ['username', 'password'],
      },
    ]);
    await backend.flush();

    // Retrieve via getNode
    const node = await backend.getNode('test.js->FUNCTION->authenticate');

    assert.ok(node, 'Node should exist');

    // Should have 'type' field
    assert.strictEqual(node.type, 'FUNCTION', 'Node should have type field set to FUNCTION');

    // Should NOT have 'nodeType' field (no duplication)
    assert.strictEqual(
      node.nodeType,
      undefined,
      'Node should NOT have nodeType field - only type field should exist'
    );

    await backend.close();
  });

  it('should return nodes with "exported" field as boolean', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add nodes with different exported values
    await backend.addNodes([
      {
        id: 'test.js->FUNCTION->publicFunc',
        type: 'FUNCTION',
        name: 'publicFunc',
        file: 'test.js',
        exported: true,
      },
      {
        id: 'test.js->FUNCTION->privateFunc',
        type: 'FUNCTION',
        name: 'privateFunc',
        file: 'test.js',
        exported: false,
      },
    ]);
    await backend.flush();

    // Check exported=true node
    const publicNode = await backend.getNode('test.js->FUNCTION->publicFunc');
    assert.ok(publicNode, 'Public node should exist');
    assert.strictEqual(
      publicNode.exported,
      true,
      'exported field should be true (boolean, not unknown)'
    );
    assert.strictEqual(
      typeof publicNode.exported,
      'boolean',
      'exported should be boolean type'
    );

    // Check exported=false node
    const privateNode = await backend.getNode('test.js->FUNCTION->privateFunc');
    assert.ok(privateNode, 'Private node should exist');
    assert.strictEqual(
      privateNode.exported,
      false,
      'exported field should be false (boolean, not unknown)'
    );
    assert.strictEqual(
      typeof privateNode.exported,
      'boolean',
      'exported should be boolean type'
    );

    await backend.close();
  });

  it('should spread metadata to top level (backward compat)', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add a function node with metadata
    await backend.addNodes([
      {
        id: 'test.js->FUNCTION->complexFunc',
        type: 'FUNCTION',
        name: 'complexFunc',
        file: 'test.js',
        exported: true,
        // Metadata fields that should be spread to top level
        async: true,
        generator: false,
        params: ['a', 'b', 'c'],
        line: 42,
        column: 8,
      },
    ]);
    await backend.flush();

    const node = await backend.getNode('test.js->FUNCTION->complexFunc');

    assert.ok(node, 'Node should exist');

    // Metadata should be accessible at top level (not nested in node.metadata)
    assert.strictEqual(node.async, true, 'async should be accessible at top level');
    assert.strictEqual(node.generator, false, 'generator should be accessible at top level');
    assert.deepStrictEqual(node.params, ['a', 'b', 'c'], 'params should be accessible at top level');
    assert.strictEqual(node.line, 42, 'line should be accessible at top level');
    assert.strictEqual(node.column, 8, 'column should be accessible at top level');

    await backend.close();
  });

  it('should return typed nodes from queryNodes without casting', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add multiple nodes of different types
    await backend.addNodes([
      {
        id: 'test.js->FUNCTION->func1',
        type: 'FUNCTION',
        name: 'func1',
        file: 'test.js',
        exported: true,
        async: true,
      },
      {
        id: 'test.js->FUNCTION->func2',
        type: 'FUNCTION',
        name: 'func2',
        file: 'test.js',
        exported: false,
        async: false,
      },
      {
        id: 'test.js->VARIABLE->myVar',
        type: 'VARIABLE',
        name: 'myVar',
        file: 'test.js',
        exported: true,
        kind: 'const',
      },
    ]);
    await backend.flush();

    // Query for FUNCTION nodes
    const functions = [];
    for await (const node of backend.queryNodes({ nodeType: 'FUNCTION' })) {
      functions.push(node);
    }

    assert.strictEqual(functions.length, 2, 'Should find 2 FUNCTION nodes');

    // All nodes should have BaseNodeRecord shape
    for (const node of functions) {
      // Core fields should be accessible without casting
      assert.ok(node.id, 'id should be accessible');
      assert.strictEqual(node.type, 'FUNCTION', 'type should be FUNCTION');
      assert.ok(node.name, 'name should be accessible');
      assert.strictEqual(node.file, 'test.js', 'file should be accessible');

      // exported should be boolean (not unknown via index signature)
      assert.strictEqual(
        typeof node.exported,
        'boolean',
        'exported should be boolean type, not unknown'
      );

      // Should NOT have nodeType duplication
      assert.strictEqual(
        node.nodeType,
        undefined,
        'Should NOT have nodeType field'
      );

      // Metadata should be accessible (async was added to nodes)
      assert.ok(
        node.async === true || node.async === false,
        'async metadata should be accessible at top level'
      );
    }

    await backend.close();
  });

  it('should handle optional fields (line, column) correctly', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add node WITH line/column
    await backend.addNodes([
      {
        id: 'test.js->FUNCTION->withLocation',
        type: 'FUNCTION',
        name: 'withLocation',
        file: 'test.js',
        line: 10,
        column: 5,
      },
    ]);

    // Add node WITHOUT line/column
    await backend.addNodes([
      {
        id: 'test.js->FUNCTION->withoutLocation',
        type: 'FUNCTION',
        name: 'withoutLocation',
        file: 'test.js',
      },
    ]);
    await backend.flush();

    // Node with location
    const nodeWithLocation = await backend.getNode('test.js->FUNCTION->withLocation');
    assert.ok(nodeWithLocation, 'Node with location should exist');
    assert.strictEqual(nodeWithLocation.line, 10, 'line should be 10');
    assert.strictEqual(nodeWithLocation.column, 5, 'column should be 5');

    // Node without location
    const nodeWithoutLocation = await backend.getNode('test.js->FUNCTION->withoutLocation');
    assert.ok(nodeWithoutLocation, 'Node without location should exist');

    // Optional fields should be undefined (safe to access, type: number | undefined)
    assert.ok(
      nodeWithoutLocation.line === undefined || typeof nodeWithoutLocation.line === 'number',
      'line should be undefined or number (optional field)'
    );
    assert.ok(
      nodeWithoutLocation.column === undefined || typeof nodeWithoutLocation.column === 'number',
      'column should be undefined or number (optional field)'
    );

    await backend.close();
  });

  it('should preserve all BaseNodeRecord fields across multiple queries', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add a complex node
    const complexNode = {
      id: 'app.js->CLASS->UserService',
      type: 'CLASS',
      name: 'UserService',
      file: 'app.js',
      exported: true,
      line: 100,
      column: 0,
      superClass: 'BaseService',
    };

    await backend.addNodes([complexNode]);
    await backend.flush();

    // Query via getNode
    const nodeViaGet = await backend.getNode('app.js->CLASS->UserService');
    assert.ok(nodeViaGet, 'Node should exist via getNode');
    assert.strictEqual(nodeViaGet.type, 'CLASS', 'type should be CLASS');
    assert.strictEqual(nodeViaGet.name, 'UserService', 'name should match');
    assert.strictEqual(nodeViaGet.file, 'app.js', 'file should match');
    assert.strictEqual(nodeViaGet.exported, true, 'exported should be true');
    assert.strictEqual(nodeViaGet.line, 100, 'line should match');
    assert.strictEqual(nodeViaGet.superClass, 'BaseService', 'superClass metadata should be accessible');

    // Query via queryNodes
    const nodesViaQuery = [];
    for await (const node of backend.queryNodes({ nodeType: 'CLASS' })) {
      nodesViaQuery.push(node);
    }

    assert.strictEqual(nodesViaQuery.length, 1, 'Should find 1 CLASS node');
    const nodeViaQuery = nodesViaQuery[0];

    // Should have same shape as getNode result
    assert.strictEqual(nodeViaQuery.type, 'CLASS', 'type should be CLASS');
    assert.strictEqual(nodeViaQuery.name, 'UserService', 'name should match');
    assert.strictEqual(nodeViaQuery.file, 'app.js', 'file should match');
    assert.strictEqual(nodeViaQuery.exported, true, 'exported should be true');
    assert.strictEqual(nodeViaQuery.line, 100, 'line should match');
    assert.strictEqual(nodeViaQuery.superClass, 'BaseService', 'superClass metadata should be accessible');

    // Should NOT have nodeType
    assert.strictEqual(nodeViaGet.nodeType, undefined, 'getNode should not return nodeType');
    assert.strictEqual(nodeViaQuery.nodeType, undefined, 'queryNodes should not return nodeType');

    await backend.close();
  });

  it('should handle nested JSON metadata correctly', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add node with nested metadata (arrays, objects)
    await backend.addNodes([
      {
        id: 'test.js->FUNCTION->funcWithMeta',
        type: 'FUNCTION',
        name: 'funcWithMeta',
        file: 'test.js',
        params: ['userId', 'options'],  // array
        paramTypes: ['string', 'object'],  // array
        signature: '(userId: string, options: object) => Promise<User>',  // string
      },
    ]);
    await backend.flush();

    const node = await backend.getNode('test.js->FUNCTION->funcWithMeta');

    assert.ok(node, 'Node should exist');

    // Arrays should be parsed and accessible
    assert.deepStrictEqual(
      node.params,
      ['userId', 'options'],
      'params array should be parsed correctly'
    );
    assert.deepStrictEqual(
      node.paramTypes,
      ['string', 'object'],
      'paramTypes array should be parsed correctly'
    );

    // Strings should remain strings
    assert.strictEqual(
      node.signature,
      '(userId: string, options: object) => Promise<User>',
      'signature string should be preserved'
    );

    await backend.close();
  });

  it('should work with variable nodes (different node type)', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add a VARIABLE node
    await backend.addNodes([
      {
        id: 'config.js->VARIABLE->API_KEY',
        type: 'VARIABLE',
        name: 'API_KEY',
        file: 'config.js',
        exported: true,
        kind: 'const',
        line: 5,
      },
    ]);
    await backend.flush();

    const node = await backend.getNode('config.js->VARIABLE->API_KEY');

    assert.ok(node, 'Variable node should exist');
    assert.strictEqual(node.type, 'VARIABLE', 'type should be VARIABLE');
    assert.strictEqual(node.name, 'API_KEY', 'name should match');
    assert.strictEqual(node.file, 'config.js', 'file should match');
    assert.strictEqual(node.exported, true, 'exported should be true');
    assert.strictEqual(node.kind, 'const', 'kind metadata should be accessible');
    assert.strictEqual(node.line, 5, 'line should match');

    // Should NOT have nodeType
    assert.strictEqual(node.nodeType, undefined, 'Should not have nodeType field');

    await backend.close();
  });

  it('should handle multiple node types in single query', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    // Add diverse node types
    await backend.addNodes([
      {
        id: 'file1.js->FUNCTION->foo',
        type: 'FUNCTION',
        name: 'foo',
        file: 'file1.js',
        exported: true,
      },
      {
        id: 'file1.js->CLASS->Bar',
        type: 'CLASS',
        name: 'Bar',
        file: 'file1.js',
        exported: false,
      },
      {
        id: 'file1.js->VARIABLE->baz',
        type: 'VARIABLE',
        name: 'baz',
        file: 'file1.js',
        exported: true,
      },
    ]);
    await backend.flush();

    // Query all nodes
    const allNodes = [];
    for await (const node of backend.queryNodes({})) {
      allNodes.push(node);
    }

    // Should have at least our 3 nodes
    assert.ok(allNodes.length >= 3, 'Should have at least 3 nodes');

    // Filter our nodes
    const ourNodes = allNodes.filter(n => n.file === 'file1.js');
    assert.strictEqual(ourNodes.length, 3, 'Should find our 3 nodes');

    // All should have BaseNodeRecord shape
    for (const node of ourNodes) {
      assert.ok(node.type, 'Should have type field');
      assert.strictEqual(node.nodeType, undefined, 'Should NOT have nodeType field');
      assert.ok(node.name, 'Should have name field');
      assert.strictEqual(node.file, 'file1.js', 'Should have correct file');
      assert.strictEqual(
        typeof node.exported,
        'boolean',
        'exported should be boolean type'
      );
    }

    // Check specific types
    const funcNode = ourNodes.find(n => n.type === 'FUNCTION');
    const classNode = ourNodes.find(n => n.type === 'CLASS');
    const varNode = ourNodes.find(n => n.type === 'VARIABLE');

    assert.ok(funcNode, 'Should find FUNCTION node');
    assert.ok(classNode, 'Should find CLASS node');
    assert.ok(varNode, 'Should find VARIABLE node');

    assert.strictEqual(funcNode.name, 'foo', 'Function name should match');
    assert.strictEqual(classNode.name, 'Bar', 'Class name should match');
    assert.strictEqual(varNode.name, 'baz', 'Variable name should match');

    await backend.close();
  });
});
