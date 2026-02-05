/**
 * ExpressResponseAnalyzer Tests (REG-252 Phase A)
 *
 * Tests for RESPONDS_WITH edges connecting http:route nodes to response data.
 *
 * What ExpressResponseAnalyzer should do:
 * 1. For each http:route node, follow HANDLED_BY edge to get handler function
 * 2. Traverse handler AST looking for res.json(...), res.send(...) patterns
 * 3. Create RESPONDS_WITH edge from http:route to the response argument node
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../helpers/createTestOrchestrator.js';
import { ExpressRouteAnalyzer, ExpressResponseAnalyzer } from '@grafema/core';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create a test project with given files and run analysis
 * Includes ExpressRouteAnalyzer to create http:route nodes
 */
async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-express-response-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-express-response-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  // Include ExpressRouteAnalyzer to create http:route nodes
  // and ExpressResponseAnalyzer to create RESPONDS_WITH edges
  const orchestrator = createTestOrchestrator(backend, {
    forceAnalysis: true,
    extraPlugins: [
      new ExpressRouteAnalyzer(),
      new ExpressResponseAnalyzer()
    ]
  });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Get all edges from backend
 */
async function getAllEdges(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
): Promise<EdgeRecord[]> {
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];

  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  return allEdges;
}

/**
 * Get edges by type from backend
 */
async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allEdges = await getAllEdges(backend);
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

/**
 * Find http:route node by method and path
 */
async function findRouteNode(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
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
// TESTS: RESPONDS_WITH Edges for Express Response Detection
// =============================================================================

describe('ExpressResponseAnalyzer (REG-252 Phase A)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (db) await db.cleanup();
    backend = await createTestDatabase(); backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // TEST 1: res.json(object) creates RESPONDS_WITH edge
  // ===========================================================================

  describe('res.json(object) detection', () => {
    it('should detect res.json(object) and create RESPONDS_WITH edge', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/users', (req, res) => {
  res.json({ users: [], count: 0 });
});

export default router;
        `
      });

      // Verify http:route node was created (by ExpressRouteAnalyzer)
      const routeNode = await findRouteNode(backend, 'GET', '/users');
      assert.ok(routeNode, 'Should have http:route node for GET /users');

      // Find RESPONDS_WITH edges
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      assert.ok(
        respondsWithEdges.length >= 1,
        `Should have at least one RESPONDS_WITH edge. Found: ${respondsWithEdges.length}`
      );

      // Verify edge connects http:route to response data
      const routeEdge = respondsWithEdges.find((e: EdgeRecord) => e.src === routeNode!.id);
      assert.ok(
        routeEdge,
        `Should have RESPONDS_WITH edge from http:route (${routeNode!.id}). ` +
        `Found edges: ${JSON.stringify(respondsWithEdges.map(e => ({ src: e.src, dst: e.dst })))}`
      );

      // Verify destination is OBJECT_LITERAL or CALL node
      const dstNode = await backend.getNode(routeEdge!.dst);
      assert.ok(dstNode, 'Destination node should exist');
      assert.ok(
        dstNode.type === 'OBJECT_LITERAL' || dstNode.type === 'CALL',
        `Destination should be OBJECT_LITERAL or CALL node, got: ${dstNode.type}`
      );
    });
  });

  // ===========================================================================
  // TEST 2: res.send(variable) creates RESPONDS_WITH edge
  // ===========================================================================

  describe('res.send(variable) detection', () => {
    it('should detect res.send(variable) and create RESPONDS_WITH edge', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/status', (req, res) => {
  const data = { status: 'ok' };
  res.send(data);
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/status');
      assert.ok(routeNode, 'Should have http:route node for GET /status');

      // Find RESPONDS_WITH edges
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');

      // Verify edge from http:route
      const routeEdge = respondsWithEdges.find((e: EdgeRecord) => e.src === routeNode!.id);
      assert.ok(
        routeEdge,
        `Should have RESPONDS_WITH edge from http:route for res.send(variable). ` +
        `Found edges: ${JSON.stringify(respondsWithEdges.map(e => ({ src: e.src, dst: e.dst })))}`
      );
    });
  });

  // ===========================================================================
  // TEST 3: RESPONDS_WITH links to correct http:route node
  // ===========================================================================

  describe('RESPONDS_WITH links to correct route', () => {
    it('should link RESPONDS_WITH to correct http:route node', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/users', (req, res) => {
  res.json({ type: 'users' });
});

router.get('/items', (req, res) => {
  res.json({ type: 'items' });
});

export default router;
        `
      });

      // Get both route nodes
      const usersRoute = await findRouteNode(backend, 'GET', '/users');
      const itemsRoute = await findRouteNode(backend, 'GET', '/items');

      assert.ok(usersRoute, 'Should have http:route for GET /users');
      assert.ok(itemsRoute, 'Should have http:route for GET /items');

      // Find RESPONDS_WITH edges
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');

      // Each route should have exactly one RESPONDS_WITH edge
      const usersEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === usersRoute!.id);
      const itemsEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === itemsRoute!.id);

      assert.ok(
        usersEdges.length >= 1,
        `GET /users should have at least one RESPONDS_WITH edge, got ${usersEdges.length}`
      );
      assert.ok(
        itemsEdges.length >= 1,
        `GET /items should have at least one RESPONDS_WITH edge, got ${itemsEdges.length}`
      );

      // Verify they point to different destinations
      assert.notStrictEqual(
        usersEdges[0].dst,
        itemsEdges[0].dst,
        'Routes should respond with different objects'
      );
    });
  });

  // ===========================================================================
  // TEST 4: Multiple response paths (conditional)
  // ===========================================================================

  describe('Multiple response paths', () => {
    it('should handle multiple response paths (conditional res.json)', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/item/:id', (req, res) => {
  const id = req.params.id;
  if (id === '0') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ id, found: true });
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/item/:id');
      assert.ok(routeNode, 'Should have http:route node for GET /item/:id');

      // Find RESPONDS_WITH edges from this route
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === routeNode!.id);

      // Should have 2 RESPONDS_WITH edges (one for each response path)
      assert.strictEqual(
        routeEdges.length,
        2,
        `Should have 2 RESPONDS_WITH edges for conditional responses, got ${routeEdges.length}. ` +
        `Edges: ${JSON.stringify(routeEdges.map(e => ({ src: e.src, dst: e.dst })))}`
      );
    });
  });

  // ===========================================================================
  // TEST 5: Chained res.status(200).json(data)
  // ===========================================================================

  describe('Chained response detection', () => {
    it('should handle chained res.status(200).json(data)', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.post('/items', (req, res) => {
  const item = { id: 1, name: 'test' };
  res.status(201).json(item);
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'POST', '/items');
      assert.ok(routeNode, 'Should have http:route node for POST /items');

      // Find RESPONDS_WITH edges
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdge = respondsWithEdges.find((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(
        routeEdge,
        `Should have RESPONDS_WITH edge from http:route for chained response. ` +
        `Found edges: ${JSON.stringify(respondsWithEdges.map(e => ({ src: e.src, dst: e.dst })))}`
      );
    });
  });

  // ===========================================================================
  // TEST 6: Named handler function
  // ===========================================================================

  describe('Named handler function', () => {
    it('should detect response in named handler function', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

function handleHealth(req, res) {
  res.json({ healthy: true });
}

router.get('/health', handleHealth);

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/health');
      assert.ok(routeNode, 'Should have http:route node for GET /health');

      // Find RESPONDS_WITH edges
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdge = respondsWithEdges.find((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(
        routeEdge,
        `Should have RESPONDS_WITH edge for named handler function. ` +
        `Found edges: ${JSON.stringify(respondsWithEdges.map(e => ({ src: e.src, dst: e.dst })))}`
      );
    });
  });

  // ===========================================================================
  // TEST 7: Edge metadata verification
  // ===========================================================================

  describe('Edge metadata', () => {
    it('should include response method in RESPONDS_WITH edge metadata', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/test', (req, res) => {
  res.json({ data: 'test' });
});

export default router;
        `
      });

      // Find RESPONDS_WITH edges
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      assert.ok(respondsWithEdges.length >= 1, 'Should have RESPONDS_WITH edge');

      const edge = respondsWithEdges[0];
      const metadata = edge.metadata || {};

      // Metadata should include response method (json, send, etc.)
      assert.ok(
        'responseMethod' in metadata,
        `Edge metadata should include responseMethod. Got: ${JSON.stringify(metadata)}`
      );
    });
  });
});
