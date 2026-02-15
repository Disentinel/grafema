/**
 * RFDBServerBackend Semantic ID Preservation Test (REG-445 Bug 1)
 *
 * Verifies that node semantic IDs are preserved in v1 format through the
 * write/read cycle, even when the RFDB server uses v3 protocol internally.
 *
 * Bug context:
 * - RFDB v3 server can synthesize IDs in TYPE:name@file format for nodes
 *   that lack a client-provided semanticId
 * - The fix ensures _parseNode prefers metadata.semanticId (v1 format)
 *   over wireNode.semanticId (which may be synthesized v3 format)
 * - For v3 clients, addNodes should also store semanticId in metadata
 *   as a fallback
 *
 * Test approach:
 * - Uses RFDBServerBackend (negotiates v3) to test real protocol behavior
 * - Adds nodes with v1 format IDs, retrieves them, verifies ID preservation
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { RFDBServerBackend, parseSemanticId, parseSemanticIdV2 } from '@grafema/core';

let testCounter = 0;

/**
 * Create unique test paths for each test run
 */
function createTestPaths() {
  const testId = `semantic-id-${Date.now()}-${testCounter++}`;
  const testDir = join(tmpdir(), `.grafema-test-${testId}`);
  const dbPath = join(testDir, 'graph.rfdb');
  const socketPath = join(testDir, 'rfdb.sock');

  mkdirSync(testDir, { recursive: true });

  return { testDir, dbPath, socketPath };
}

describe('RFDBServerBackend Semantic ID Preservation (REG-445 Bug 1)', () => {
  let testPaths;

  before(() => {
    testPaths = createTestPaths();
  });

  after(async () => {
    if (testPaths?.testDir) {
      try {
        rmSync(testPaths.testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should preserve v1 format ID through getNode', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    const originalId = 'src/app.ts->global->FUNCTION->authenticate';

    await backend.addNodes([
      {
        id: originalId,
        type: 'FUNCTION',
        name: 'authenticate',
        file: 'src/app.ts',
        exported: true,
        async: true,
      },
    ]);
    await backend.flush();

    const node = await backend.getNode(originalId);

    assert.ok(node, 'Node should be found');
    assert.strictEqual(
      node.id,
      originalId,
      `Node ID should be preserved in v1 format. Got: ${node.id}`
    );

    // Verify the ID is parseable by the v1 parser
    const parsed = parseSemanticId(node.id);
    assert.ok(parsed, 'Node ID should be parseable by v1 parser');
    assert.strictEqual(parsed.file, 'src/app.ts');
    assert.strictEqual(parsed.type, 'FUNCTION');
    assert.strictEqual(parsed.name, 'authenticate');

    await backend.close();
  });

  it('should preserve v1 format ID through queryNodes', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    const originalId = 'src/utils.ts->global->VARIABLE->config';

    await backend.addNodes([
      {
        id: originalId,
        type: 'VARIABLE',
        name: 'config',
        file: 'src/utils.ts',
        exported: true,
        kind: 'const',
      },
    ]);
    await backend.flush();

    const nodes = [];
    for await (const node of backend.queryNodes({ nodeType: 'VARIABLE' })) {
      if (node.name === 'config') {
        nodes.push(node);
      }
    }

    assert.strictEqual(nodes.length, 1, 'Should find exactly one config node');
    assert.strictEqual(
      nodes[0].id,
      originalId,
      `Node ID from queryNodes should be v1 format. Got: ${nodes[0].id}`
    );

    await backend.close();
  });

  it('should preserve v2 format ID through getNode', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    const originalId = 'src/service.ts->FUNCTION->processRequest[in:UserService,h:a1b2]';

    await backend.addNodes([
      {
        id: originalId,
        type: 'FUNCTION',
        name: 'processRequest',
        file: 'src/service.ts',
        exported: false,
      },
    ]);
    await backend.flush();

    const node = await backend.getNode(originalId);

    assert.ok(node, 'Node with v2 ID should be found');
    assert.strictEqual(
      node.id,
      originalId,
      `v2 format ID should be preserved. Got: ${node.id}`
    );

    // Verify the ID is parseable by the v2 parser
    const parsed = parseSemanticIdV2(node.id);
    assert.ok(parsed, 'Node ID should be parseable by v2 parser');
    assert.strictEqual(parsed.file, 'src/service.ts');
    assert.strictEqual(parsed.type, 'FUNCTION');
    assert.strictEqual(parsed.name, 'processRequest');
    assert.strictEqual(parsed.namedParent, 'UserService');

    await backend.close();
  });

  it('should NOT return synthesized TYPE:name@file format', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    const originalId = 'src/handlers.ts->global->FUNCTION->handleError';

    await backend.addNodes([
      {
        id: originalId,
        type: 'FUNCTION',
        name: 'handleError',
        file: 'src/handlers.ts',
        exported: true,
      },
    ]);
    await backend.flush();

    const node = await backend.getNode(originalId);

    assert.ok(node, 'Node should exist');

    // The bug was: node.id would be "FUNCTION:handleError@src/handlers.ts" (v3 synthesized)
    // After fix: node.id should be the original v1 format
    assert.ok(
      !node.id.includes(':') || node.id.includes('->'),
      `Node ID should not be in synthesized TYPE:name@file format. Got: ${node.id}`
    );
    assert.strictEqual(
      node.id,
      originalId,
      'Node ID should match the original v1 format exactly'
    );

    await backend.close();
  });

  it('should preserve IDs for multiple node types', async () => {
    const { dbPath, socketPath } = testPaths;
    const backend = new RFDBServerBackend({ dbPath, socketPath });
    await backend.connect();

    const testNodes = [
      {
        id: 'src/types.ts->global->INTERFACE->GraphBackend',
        type: 'INTERFACE',
        name: 'GraphBackend',
        file: 'src/types.ts',
      },
      {
        id: 'src/types.ts->global->TYPE->NodeRecord',
        type: 'TYPE',
        name: 'NodeRecord',
        file: 'src/types.ts',
      },
      {
        id: 'src/types.ts->global->ENUM->Priority',
        type: 'ENUM',
        name: 'Priority',
        file: 'src/types.ts',
      },
      {
        id: 'src/app.ts->global->CLASS->UserService',
        type: 'CLASS',
        name: 'UserService',
        file: 'src/app.ts',
        exported: true,
      },
    ];

    await backend.addNodes(testNodes);
    await backend.flush();

    for (const expected of testNodes) {
      const node = await backend.getNode(expected.id);
      assert.ok(node, `Node ${expected.name} should exist`);
      assert.strictEqual(
        node.id,
        expected.id,
        `${expected.type} node ID should be preserved. Got: ${node.id}`
      );
    }

    await backend.close();
  });
});
