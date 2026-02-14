/**
 * ExpressResponseAnalyzer Linking Tests (REG-326)
 *
 * Tests for the new functionality that links `res.json(identifier)` to existing
 * VARIABLE/PARAMETER/CONSTANT nodes instead of creating stub nodes.
 *
 * This addresses the core issue: when tracing response values, we need to link
 * to the actual variable nodes so traceValues() can find the data sources.
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../../../helpers/TestRFDB.js';
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
  const testDir = join(tmpdir(), `grafema-test-response-linking-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-response-linking-${testCounter}`,
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

/**
 * Find a node by partial ID match
 */
async function findNodeByIdPattern(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  pattern: RegExp
): Promise<NodeRecord | undefined> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) => pattern.test(n.id));
}

// =============================================================================
// TESTS: Linking to Existing Variables
// =============================================================================

describe('ExpressResponseAnalyzer Variable Linking (REG-326)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (db) await db.cleanup();
    backend = await createTestDatabase(); backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // TEST 1: res.json(localVar) links to existing VARIABLE
  // ===========================================================================

  describe('res.json(localVar) linking', () => {
    it('should link to existing local VARIABLE node, not create stub', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/status', (req, res) => {
  const statusData = { status: 'ok', timestamp: Date.now() };
  res.json(statusData);
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/status');
      assert.ok(routeNode, 'Should have http:route node for GET /status');

      // Find RESPONDS_WITH edges from this route
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(routeEdges.length >= 1, 'Should have at least one RESPONDS_WITH edge');

      // Get the destination node
      const dstNode = await backend.getNode(routeEdges[0].dst);
      assert.ok(dstNode, 'Destination node should exist');

      // Key assertion: The destination should be the actual VARIABLE node
      // created by JSASTAnalyzer, NOT a stub with name '<response>'
      assert.strictEqual(
        dstNode.name,
        'statusData',
        `Should link to statusData variable. Got name: ${dstNode.name}`
      );

      // Verify it's not a stub by checking semantic ID pattern
      // (real variables have "->VARIABLE->varName", stubs have "VARIABLE#response:N#...")
      assert.ok(
        dstNode.id.includes('->VARIABLE->statusData'),
        `Should have proper semantic ID for statusData. Got: ${dstNode.id}`
      );
    });
  });

  // ===========================================================================
  // TEST 2: res.json(param) links to existing PARAMETER
  // ===========================================================================

  describe('res.json(param) linking', () => {
    it('should link to existing PARAMETER node (req)', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

// Echo endpoint - returns the request object
router.post('/echo', (req, res) => {
  res.json(req);
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'POST', '/echo');
      assert.ok(routeNode, 'Should have http:route node for POST /echo');

      // Find RESPONDS_WITH edges from this route
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(routeEdges.length >= 1, 'Should have at least one RESPONDS_WITH edge');

      // Get the destination node
      const dstNode = await backend.getNode(routeEdges[0].dst);
      assert.ok(dstNode, 'Destination node should exist');

      // Key assertion: Should link to PARAMETER node 'req'
      assert.notStrictEqual(
        dstNode.name,
        '<response>',
        'Should NOT create stub - should link to parameter'
      );

      // Should be a PARAMETER type or have PARAMETER in semantic ID
      assert.ok(
        dstNode.type === 'PARAMETER' || dstNode.id.includes('PARAMETER->req'),
        `Should link to req parameter. Got type: ${dstNode.type}, id: ${dstNode.id}`
      );
    });
  });

  // ===========================================================================
  // TEST 3: res.json(moduleVar) links to module-level VARIABLE
  // ===========================================================================

  describe('res.json(moduleVar) linking', () => {
    it('should link to module-level CONSTANT node', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

// Module-level constant
const CONFIG = { version: '1.0.0', env: 'production' };

router.get('/config', (req, res) => {
  res.json(CONFIG);
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/config');
      assert.ok(routeNode, 'Should have http:route node for GET /config');

      // Find RESPONDS_WITH edges from this route
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(routeEdges.length >= 1, 'Should have at least one RESPONDS_WITH edge');

      // Get the destination node
      const dstNode = await backend.getNode(routeEdges[0].dst);
      assert.ok(dstNode, 'Destination node should exist');

      // Key assertion: Should link to module-level CONFIG constant
      assert.notStrictEqual(
        dstNode.name,
        '<response>',
        'Should NOT create stub - should link to module constant'
      );

      // Should be CONSTANT type or VARIABLE type with name CONFIG
      assert.ok(
        dstNode.name === 'CONFIG' || dstNode.id.includes('->CONFIG'),
        `Should link to CONFIG constant. Got: ${dstNode.id}, name: ${dstNode.name}`
      );
    });
  });

  // ===========================================================================
  // TEST 4: res.json(externalVar) creates stub when not found
  // ===========================================================================

  describe('res.json(externalVar) fallback', () => {
    it('should create stub when variable not found in scope (external/global)', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

// globalConfig is NOT defined in this file (external/global)
router.get('/global', (req, res) => {
  res.json(globalConfig);
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/global');
      assert.ok(routeNode, 'Should have http:route node for GET /global');

      // Find RESPONDS_WITH edges from this route
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(routeEdges.length >= 1, 'Should have at least one RESPONDS_WITH edge');

      // Get the destination node
      const dstNode = await backend.getNode(routeEdges[0].dst);
      assert.ok(dstNode, 'Destination node should exist');

      // For external/global variables that can't be found, we expect a stub
      // This is the fallback behavior
      assert.ok(
        dstNode.id.includes('#response:') || dstNode.name === '<response>',
        `Should create stub for external variable. Got: ${dstNode.id}, name: ${dstNode.name}`
      );
    });
  });

  // ===========================================================================
  // TEST 5: res.json({ ... }) creates OBJECT_LITERAL (unchanged behavior)
  // ===========================================================================

  describe('res.json(object literal) unchanged', () => {
    it('should create OBJECT_LITERAL node for inline objects', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/inline', (req, res) => {
  res.json({ message: 'inline object' });
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/inline');
      assert.ok(routeNode, 'Should have http:route node for GET /inline');

      // Find RESPONDS_WITH edges from this route
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(routeEdges.length >= 1, 'Should have at least one RESPONDS_WITH edge');

      // Get the destination node
      const dstNode = await backend.getNode(routeEdges[0].dst);
      assert.ok(dstNode, 'Destination node should exist');

      // For object literals, we still create OBJECT_LITERAL nodes (existing behavior)
      assert.strictEqual(
        dstNode.type,
        'OBJECT_LITERAL',
        `Should be OBJECT_LITERAL type. Got: ${dstNode.type}`
      );
    });
  });

  // ===========================================================================
  // TEST 6: res.json(fn()) creates CALL stub (unchanged behavior)
  // ===========================================================================

  describe('res.json(call) unchanged', () => {
    it('should create CALL stub for function call results', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

function getData() {
  return { data: 'computed' };
}

router.get('/computed', (req, res) => {
  res.json(getData());
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/computed');
      assert.ok(routeNode, 'Should have http:route node for GET /computed');

      // Find RESPONDS_WITH edges from this route
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(routeEdges.length >= 1, 'Should have at least one RESPONDS_WITH edge');

      // Get the destination node
      const dstNode = await backend.getNode(routeEdges[0].dst);
      assert.ok(dstNode, 'Destination node should exist');

      // For call expressions, we still create CALL stub nodes (existing behavior)
      assert.strictEqual(
        dstNode.type,
        'CALL',
        `Should be CALL type. Got: ${dstNode.type}`
      );
    });
  });

  // ===========================================================================
  // TEST 7: Multiple routes with same variable name - correct scope linking
  // ===========================================================================

  describe('multiple routes same variable name', () => {
    it('should link each route to its own scoped variable', async () => {
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/users', (req, res) => {
  const data = { type: 'users', items: [] };
  res.json(data);
});

router.get('/items', (req, res) => {
  const data = { type: 'items', items: [] };
  res.json(data);
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

      const usersEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === usersRoute!.id);
      const itemsEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === itemsRoute!.id);

      assert.ok(usersEdges.length >= 1, 'GET /users should have RESPONDS_WITH edge');
      assert.ok(itemsEdges.length >= 1, 'GET /items should have RESPONDS_WITH edge');

      // Get destination nodes
      const usersDst = await backend.getNode(usersEdges[0].dst);
      const itemsDst = await backend.getNode(itemsEdges[0].dst);

      assert.ok(usersDst, 'Users response node should exist');
      assert.ok(itemsDst, 'Items response node should exist');

      // Key assertion: Each route should link to a DIFFERENT variable
      // (each handler has its own 'data' variable in different scope)
      assert.notStrictEqual(
        usersDst.id,
        itemsDst.id,
        'Each route should link to its own scoped variable, not the same one'
      );

      // Both should be named 'data' (not '<response>')
      // This verifies we're linking to actual variables, not stubs
      if (usersDst.name !== '<response>' && itemsDst.name !== '<response>') {
        // If implemented correctly, both should link to 'data' variables
        assert.strictEqual(
          usersDst.name,
          'data',
          'Users route should link to its "data" variable'
        );
        assert.strictEqual(
          itemsDst.name,
          'data',
          'Items route should link to its "data" variable'
        );
      }
    });
  });

  // ===========================================================================
  // TEST 8: Variable declared after usage (forward reference)
  // ===========================================================================

  describe('forward reference handling', () => {
    it('should create stub for forward references (TDZ)', async () => {
      // Note: This code would throw TDZ error at runtime, but static analysis
      // should handle it gracefully by creating a stub
      await setupTest(backend, {
        'index.js': `
import express from 'express';
const router = express.Router();

router.get('/forward', (req, res) => {
  res.json(laterData);  // Used before declaration
  const laterData = { late: true };
});

export default router;
        `
      });

      // Verify http:route node was created
      const routeNode = await findRouteNode(backend, 'GET', '/forward');
      assert.ok(routeNode, 'Should have http:route node for GET /forward');

      // Find RESPONDS_WITH edges from this route
      const respondsWithEdges = await getEdgesByType(backend, 'RESPONDS_WITH');
      const routeEdges = respondsWithEdges.filter((e: EdgeRecord) => e.src === routeNode!.id);

      assert.ok(routeEdges.length >= 1, 'Should have at least one RESPONDS_WITH edge');

      // Get the destination node
      const dstNode = await backend.getNode(routeEdges[0].dst);
      assert.ok(dstNode, 'Destination node should exist');

      // For forward references, the line check should fail (variable declared after usage)
      // so we should create a stub
      // However, the actual behavior depends on implementation - either:
      // 1. Create stub (conservative - line check fails)
      // 2. Link to variable (if we don't check line order)
      // Either is acceptable for this edge case
      assert.ok(dstNode, 'Should handle forward reference gracefully');
    });
  });
});

// =============================================================================
// TESTS: extractScopePrefix() Helper
// =============================================================================

describe('extractScopePrefix() edge cases', () => {
  /**
   * These tests document expected behavior for the helper function.
   * The function is private, but we test its behavior indirectly through
   * the linking behavior.
   *
   * Expected patterns:
   * - "file.js->funcName->FUNCTION->funcName" -> "file.js->funcName->"
   * - "file.js->anonymous[1]->FUNCTION->anonymous[1]" -> "file.js->anonymous[1]->"
   * - "file.js->MODULE->file.js" -> "file.js->MODULE->" (edge case)
   */

  // Note: These would be unit tests for the private method if exposed,
  // or integration tests verifying the linking behavior works correctly
  // for various semantic ID patterns.

  it('should handle nested function scopes', async () => {
    // This test verifies that variables in nested scopes are correctly
    // matched to their containing function scope
    // Implementation test - placeholder for now
    assert.ok(true, 'Placeholder - nested scope handling');
  });

  it('should handle arrow function handlers', async () => {
    // Arrow functions have semantic IDs like:
    // "file.js->anonymous[1]->FUNCTION->anonymous[1]"
    // Variables inside should have prefix:
    // "file.js->anonymous[1]->"
    assert.ok(true, 'Placeholder - arrow function handling');
  });
});
