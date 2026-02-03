/**
 * ExpressRouteAnalyzer HANDLED_BY Edge Tests (REG-322)
 *
 * Tests that HANDLED_BY edges connect to the correct handler function,
 * not nested anonymous functions inside the handler.
 *
 * Problem scenario:
 * ```typescript
 * router.post('/:id', async (req, res) => {     // line 1, col 20 - handler
 *   const data = await new Promise((resolve) => { // line 2, col 30 - nested
 *     resolve(42);
 *   });
 * });
 * ```
 *
 * HANDLED_BY should point to the handler (line 1, col 20), not the Promise callback.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../helpers/createTestOrchestrator.js';
import { ExpressRouteAnalyzer } from '@grafema/core';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

async function setupTest(
  backend: ReturnType<typeof createTestBackend>,
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-handled-by-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-handled-by-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, {
    forceAnalysis: true,
    extraPlugins: [new ExpressRouteAnalyzer()]
  });
  await orchestrator.run(testDir);

  return { testDir };
}

async function getNodesByType(
  backend: ReturnType<typeof createTestBackend>,
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

async function getEdgesByType(
  backend: ReturnType<typeof createTestBackend>,
  edgeType: string
): Promise<EdgeRecord[]> {
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];

  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  return allEdges.filter(e => e.type === edgeType);
}

// =============================================================================
// TESTS
// =============================================================================

describe('ExpressRouteAnalyzer HANDLED_BY Edge (REG-322)', () => {
  let backend: ReturnType<typeof createTestBackend> & { cleanup?: () => Promise<void> };

  beforeEach(async () => {
    if (backend?.cleanup) {
      await backend.cleanup();
    }
    backend = createTestBackend() as ReturnType<typeof createTestBackend> & { cleanup?: () => Promise<void> };
    await backend.connect();
  });

  after(async () => {
    if (backend?.cleanup) {
      await backend.cleanup();
    }
  });

  it('should link HANDLED_BY to handler function, not nested Promise callback', async () => {
    // Code with nested anonymous function inside handler
    const code = `
import express from 'express';
const router = express.Router();

router.post('/:id/accept', async (req, res) => {
  const result = await new Promise((resolve, reject) => {
    setTimeout(() => resolve('done'), 100);
  });
  res.json({ result });
});

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    // Get http:route nodes
    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const route = routes[0];
    assert.strictEqual(route.method, 'POST');
    assert.strictEqual(route.path, '/:id/accept');

    // Get HANDLED_BY edges
    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    assert.strictEqual(handledByEdges.length, 1, 'Should have 1 HANDLED_BY edge');

    const edge = handledByEdges[0];
    assert.strictEqual(edge.src, route.id, 'HANDLED_BY should start from http:route');

    // Get the target function
    const targetNode = await backend.getNode(edge.dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');

    // The handler is the arrow function at line 5 (async (req, res) => ...)
    // The nested Promise callback is at line 6 ((resolve, reject) => ...)
    // HANDLED_BY should point to line 5, not line 6
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to handler at line 5, not nested function at line 6. Got line ${targetNode.line}`
    );
  });

  it('should handle multiple nested functions and link to outermost handler', async () => {
    const code = `
import express from 'express';
const router = express.Router();

router.get('/users', async (req, res) => {
  const users = await Promise.all(
    [1, 2, 3].map(async (id) => {
      return await fetch(\`/api/user/\${id}\`).then((r) => r.json());
    })
  );
  res.json(users);
});

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    assert.strictEqual(handledByEdges.length, 1, 'Should have 1 HANDLED_BY edge');

    const targetNode = await backend.getNode(handledByEdges[0].dst);
    assert(targetNode, 'Target function should exist');

    // Handler is at line 5, nested callbacks are at lines 7-8
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to handler at line 5, got line ${targetNode.line}`
    );
  });

  it('should handle handler defined on same line as route method', async () => {
    const code = `
import express from 'express';
const app = express();

app.get('/health', (req, res) => { res.json({ ok: true }); });

export default app;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    assert.strictEqual(handledByEdges.length, 1, 'Should have 1 HANDLED_BY edge');

    const targetNode = await backend.getNode(handledByEdges[0].dst);
    assert(targetNode, 'Target function should exist');

    // Handler is at line 5, same line as app.get
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to handler at line 5, got line ${targetNode.line}`
    );
  });
});
