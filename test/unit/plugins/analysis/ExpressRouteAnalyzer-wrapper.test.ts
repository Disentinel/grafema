/**
 * ExpressRouteAnalyzer Wrapper Unwrapping Tests (REG-333)
 *
 * Tests that HANDLED_BY edges correctly point to the inner function
 * when route handlers are wrapped in utility functions like asyncHandler.
 *
 * Problem scenario:
 * ```typescript
 * router.get('/users', asyncHandler(async (req, res) => {  // wrapper
 *   res.json({ users: [] });
 * }));
 * ```
 *
 * Currently: HANDLED_BY points to asyncHandler(...) CallExpression - no FUNCTION node there
 * Expected: HANDLED_BY should point to the inner arrow function (async (req, res) => ...)
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially until ExpressRouteAnalyzer is fixed.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../helpers/createTestOrchestrator.js';
import { ExpressRouteAnalyzer, ExpressResponseAnalyzer } from '@grafema/core';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

async function setupTest(
  backend: ReturnType<typeof createTestBackend>,
  files: Record<string, string>,
  options: { includeResponseAnalyzer?: boolean } = {}
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-wrapper-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-wrapper-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const extraPlugins = [new ExpressRouteAnalyzer()];
  if (options.includeResponseAnalyzer) {
    extraPlugins.push(new ExpressResponseAnalyzer());
  }

  const orchestrator = createTestOrchestrator(backend, {
    forceAnalysis: true,
    extraPlugins
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

async function findRouteNode(
  backend: ReturnType<typeof createTestBackend>,
  method: string,
  path: string
): Promise<NodeRecord | undefined> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) =>
    n.type === 'http:route' &&
    (n as unknown as { method: string }).method === method.toUpperCase() &&
    (n as unknown as { path: string }).path === path
  );
}

// =============================================================================
// TESTS: Wrapper Function Unwrapping
// =============================================================================

describe('ExpressRouteAnalyzer Wrapper Unwrapping (REG-333)', () => {
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

  // ===========================================================================
  // TEST 1: asyncHandler(async (req, res) => {...}) - async arrow function wrapper
  // ===========================================================================

  it('should unwrap asyncHandler(async (req, res) => {...}) and link HANDLED_BY to inner function', async () => {
    // Line numbers are crucial here:
    // Line 5: router.get('/users', asyncHandler(async (req, res) => {
    // The inner arrow function starts on line 5, but at a different column than asyncHandler
    const code = `
import express from 'express';
const router = express.Router();

router.get('/users', asyncHandler(async (req, res) => {
  res.json({ users: [] });
}));

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    // Verify http:route node was created
    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const route = routes[0];
    assert.strictEqual(route.method, 'GET');
    assert.strictEqual(route.path, '/users');

    // Get HANDLED_BY edges
    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    assert.strictEqual(handledByEdges.length, 1, 'Should have 1 HANDLED_BY edge');

    const edge = handledByEdges[0];
    assert.strictEqual(edge.src, route.id, 'HANDLED_BY should start from http:route');

    // Get the target function
    const targetNode = await backend.getNode(edge.dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');

    // The inner arrow function is at line 5 (async (req, res) => ...)
    // NOT pointing to asyncHandler CallExpression
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to inner arrow function at line 5, got line ${targetNode.line}`
    );
  });

  // ===========================================================================
  // TEST 2: catchAsync((req, res) => {...}) - non-async wrapper
  // ===========================================================================

  it('should unwrap catchAsync((req, res) => {...}) - non-async arrow function', async () => {
    const code = `
import express from 'express';
const router = express.Router();

router.post('/items', catchAsync((req, res) => {
  res.status(201).json({ created: true });
}));

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    assert.strictEqual(handledByEdges.length, 1, 'Should have 1 HANDLED_BY edge');

    const targetNode = await backend.getNode(handledByEdges[0].dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');

    // Inner function is at line 5
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to inner arrow function at line 5, got line ${targetNode.line}`
    );
  });

  // ===========================================================================
  // TEST 3: wrapAsync(function handler(req, res) {...}) - FunctionExpression, not arrow
  // ===========================================================================

  it('should unwrap wrapAsync(function handler(req, res) {...}) - FunctionExpression', async () => {
    const code = `
import express from 'express';
const router = express.Router();

router.put('/items/:id', wrapAsync(function updateItem(req, res) {
  res.json({ updated: true });
}));

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    assert.strictEqual(handledByEdges.length, 1, 'Should have 1 HANDLED_BY edge');

    const targetNode = await backend.getNode(handledByEdges[0].dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');

    // Inner FunctionExpression starts at line 5
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to inner function expression at line 5, got line ${targetNode.line}`
    );
  });

  // ===========================================================================
  // TEST 4: Multiple handlers with wrapper as last argument
  // router.get('/path', middleware, asyncHandler(handler))
  // ===========================================================================

  it('should unwrap wrapper in last argument when multiple handlers present', async () => {
    const code = `
import express from 'express';
const router = express.Router();

router.get('/protected', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  res.json({ secret: 'data' });
}));

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    // There should be HANDLED_BY edge for the main handler
    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');

    // Find the edge from the route (not from middleware)
    const routeHandledByEdge = handledByEdges.find(e => e.src === routes[0].id);
    assert(routeHandledByEdge, 'Should have HANDLED_BY edge from http:route');

    const targetNode = await backend.getNode(routeHandledByEdge.dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');

    // Inner arrow function is at line 5
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to inner arrow function at line 5, got line ${targetNode.line}`
    );
  });

  // ===========================================================================
  // TEST 5: Nested wrappers - outer(inner(handler))
  // Should unwrap first level only, revealing inner CallExpression
  // ===========================================================================

  it('should unwrap first level only for nested wrappers outer(inner(handler))', async () => {
    // In this case: outer(inner((req, res) => {...}))
    // After unwrapping outer, we get inner((req, res) => {...}) which is still CallExpression
    // We should unwrap inner too and get to the actual function
    const code = `
import express from 'express';
const router = express.Router();

router.delete('/items/:id', outer(inner((req, res) => {
  res.json({ deleted: true });
})));

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');

    // Find edge from route
    const routeHandledByEdge = handledByEdges.find(e => e.src === routes[0].id);
    assert(routeHandledByEdge, 'Should have HANDLED_BY edge from http:route');

    const targetNode = await backend.getNode(routeHandledByEdge.dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');

    // The inner arrow function is at line 5
    // After unwrapping outer, we find inner(fn) - need to unwrap that too
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to innermost arrow function at line 5, got line ${targetNode.line}`
    );
  });

  // ===========================================================================
  // TEST 6: Non-wrapper CallExpression that doesn't have function as first arg
  // Should not crash, should not create invalid edge
  // ===========================================================================

  it('should handle non-wrapper CallExpression that returns non-function', async () => {
    // validate('/path') returns validation rules, not a function
    // This is middleware, not a wrapper pattern
    const code = `
import express from 'express';
const router = express.Router();

router.post('/items', validate('/items'), (req, res) => {
  res.json({ valid: true });
});

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    // The main handler is the inline arrow function, not validate(...)
    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    const routeHandledByEdge = handledByEdges.find(e => e.src === routes[0].id);
    assert(routeHandledByEdge, 'Should have HANDLED_BY edge from http:route');

    const targetNode = await backend.getNode(routeHandledByEdge.dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');

    // The inline arrow function (req, res) => is at line 5
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to inline handler at line 5, got line ${targetNode.line}`
    );
  });

  // ===========================================================================
  // TEST 7: Direct inline handler (no wrapper) - regression test
  // Should still work after the fix
  // ===========================================================================

  it('should still work for direct inline handlers without wrappers', async () => {
    const code = `
import express from 'express';
const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ ok: true });
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
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');
    assert.strictEqual(targetNode.line, 5, 'Handler should be at line 5');
  });

  // ===========================================================================
  // TEST 8: Integration - ExpressResponseAnalyzer can detect res.json in wrapped handler
  // ===========================================================================

  it('should allow ExpressResponseAnalyzer to detect res.json in wrapped handler', async () => {
    const code = `
import express from 'express';
const router = express.Router();

router.get('/data', asyncHandler(async (req, res) => {
  const data = await fetchData();
  res.json({ result: data });
}));

export default router;
`;

    await setupTest(backend, { 'index.js': code }, { includeResponseAnalyzer: true });

    const routeNode = await findRouteNode(backend, 'GET', '/data');
    assert.ok(routeNode, 'Should have http:route node for GET /data');

    // HANDLED_BY should point to the inner function
    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    const routeHandledByEdge = handledByEdges.find(e => e.src === routeNode!.id);
    assert(routeHandledByEdge, 'Should have HANDLED_BY edge from http:route');

    const targetNode = await backend.getNode(routeHandledByEdge.dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');
    assert.strictEqual(targetNode.line, 5, 'Handler should be at line 5');

    // Now check that ExpressResponseAnalyzer created RESPONDS_WITH edge
    const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
    const routeRespondsWithEdge = respondsWithEdges.find(e => e.src === routeNode!.id);

    assert(
      routeRespondsWithEdge,
      `ExpressResponseAnalyzer should create RESPONDS_WITH edge from wrapped handler. ` +
      `Found edges: ${JSON.stringify(respondsWithEdges.map(e => ({ src: e.src, dst: e.dst })))}`
    );
  });

  // ===========================================================================
  // TEST 9: Wrapper with anonymous function expression (not arrow)
  // ===========================================================================

  it('should unwrap wrapper with anonymous function expression', async () => {
    const code = `
import express from 'express';
const router = express.Router();

router.patch('/items/:id', asyncHandler(async function(req, res) {
  res.json({ patched: true });
}));

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    assert.strictEqual(handledByEdges.length, 1, 'Should have 1 HANDLED_BY edge');

    const targetNode = await backend.getNode(handledByEdges[0].dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');
    assert.strictEqual(
      targetNode.line,
      5,
      `HANDLED_BY should point to anonymous function at line 5, got line ${targetNode.line}`
    );
  });

  // ===========================================================================
  // TEST 10: Wrapper on different line than route call
  // ===========================================================================

  it('should handle wrapper function spanning multiple lines', async () => {
    const code = `
import express from 'express';
const router = express.Router();

router.get(
  '/multiline',
  asyncHandler(
    async (req, res) => {
      res.json({ multiline: true });
    }
  )
);

export default router;
`;

    await setupTest(backend, { 'index.js': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const handledByEdges = await getEdgesByType(backend, 'HANDLED_BY');
    const routeHandledByEdge = handledByEdges.find(e => e.src === routes[0].id);
    assert(routeHandledByEdge, 'Should have HANDLED_BY edge from http:route');

    const targetNode = await backend.getNode(routeHandledByEdge.dst);
    assert(targetNode, 'Target function should exist');
    assert.strictEqual(targetNode.type, 'FUNCTION', 'Target should be FUNCTION');

    // The inner arrow function starts at line 8 (async (req, res) => {)
    assert.strictEqual(
      targetNode.line,
      8,
      `HANDLED_BY should point to inner function at line 8, got line ${targetNode.line}`
    );
  });
});
