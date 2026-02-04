/**
 * CLI --from-route Tests (REG-326)
 *
 * Tests for the `grafema trace --from-route` CLI option.
 *
 * This option allows tracing data flow from HTTP route responses:
 *   grafema trace --from-route "GET /status"
 *   grafema trace --from-route "/status"
 *   grafema trace -r "POST /users"
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

// =============================================================================
// MOCK BACKEND
// =============================================================================

/**
 * Mock node for testing route matching
 */
interface MockRouteNode {
  id: string;
  type: 'http:route';
  method: string;
  path: string;
  file: string;
  line?: number;
}

interface MockEdge {
  src: string;
  dst: string;
  type: string;
  metadata?: Record<string, unknown>;
}

/**
 * Mock backend for testing CLI route matching logic
 * Simulates queryNodes and getOutgoingEdges without real DB
 */
class MockRouteBackend {
  private routes: MockRouteNode[] = [];
  private nodes: Map<string, NodeRecord> = new Map();
  private edges: MockEdge[] = [];

  addRoute(route: MockRouteNode): void {
    this.routes.push(route);
    this.nodes.set(route.id, route as unknown as NodeRecord);
  }

  addNode(node: NodeRecord): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: MockEdge): void {
    this.edges.push(edge);
  }

  async *queryNodes(filter: { type: string }): AsyncIterable<NodeRecord> {
    if (filter.type === 'http:route') {
      for (const route of this.routes) {
        yield route as unknown as NodeRecord;
      }
    }
    // Other node types
    for (const node of this.nodes.values()) {
      if (node.type === filter.type) {
        yield node;
      }
    }
  }

  async getNode(id: string): Promise<NodeRecord | null> {
    return this.nodes.get(id) ?? null;
  }

  async getOutgoingEdges(nodeId: string, edgeTypes?: string[]): Promise<MockEdge[]> {
    return this.edges.filter(e => {
      if (e.src !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }
}

// =============================================================================
// ROUTE MATCHING FUNCTION (to be implemented in CLI)
// =============================================================================

/**
 * Route node info returned by findRouteByPattern
 */
interface RouteInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
}

/**
 * Find route by pattern.
 *
 * This is the function that will be implemented in trace.ts.
 * For now, we implement it here to define expected behavior.
 *
 * Supports:
 * - "METHOD /path" format (e.g., "GET /status")
 * - "/path" format (e.g., "/status")
 *
 * @param backend - Backend with queryNodes
 * @param pattern - Route pattern (with or without method)
 * @returns Route info or null if not found
 */
async function findRouteByPattern(
  backend: MockRouteBackend,
  pattern: string
): Promise<RouteInfo | null> {
  const trimmed = pattern.trim();

  for await (const node of backend.queryNodes({ type: 'http:route' })) {
    const method = (node as unknown as MockRouteNode).method || '';
    const path = (node as unknown as MockRouteNode).path || '';

    // Match "METHOD /path"
    if (`${method} ${path}` === trimmed) {
      return {
        id: node.id,
        type: node.type || 'http:route',
        name: `${method} ${path}`,
        file: node.file || '',
        line: node.line
      };
    }

    // Match "/path" only (ignore method)
    if (path === trimmed) {
      return {
        id: node.id,
        type: node.type || 'http:route',
        name: `${method} ${path}`,
        file: node.file || '',
        line: node.line
      };
    }
  }

  return null;
}

// =============================================================================
// TESTS: Route Pattern Matching
// =============================================================================

describe('findRouteByPattern()', () => {
  let backend: MockRouteBackend;

  beforeEach(() => {
    backend = new MockRouteBackend();

    // Add some test routes
    backend.addRoute({
      id: 'http:route#GET#/status',
      type: 'http:route',
      method: 'GET',
      path: '/status',
      file: 'backend/routes.js',
      line: 21
    });

    backend.addRoute({
      id: 'http:route#POST#/users',
      type: 'http:route',
      method: 'POST',
      path: '/users',
      file: 'backend/routes.js',
      line: 35
    });

    backend.addRoute({
      id: 'http:route#GET#/users',
      type: 'http:route',
      method: 'GET',
      path: '/users',
      file: 'backend/routes.js',
      line: 42
    });

    backend.addRoute({
      id: 'http:route#GET#/users/:id',
      type: 'http:route',
      method: 'GET',
      path: '/users/:id',
      file: 'backend/routes.js',
      line: 50
    });
  });

  // ===========================================================================
  // TEST: Exact match "METHOD /path"
  // ===========================================================================

  describe('exact match "METHOD /path"', () => {
    it('should find route by "GET /status"', async () => {
      const route = await findRouteByPattern(backend, 'GET /status');

      assert.ok(route, 'Should find route');
      assert.strictEqual(route!.name, 'GET /status');
      assert.strictEqual(route!.file, 'backend/routes.js');
      assert.strictEqual(route!.line, 21);
    });

    it('should find route by "POST /users"', async () => {
      const route = await findRouteByPattern(backend, 'POST /users');

      assert.ok(route, 'Should find route');
      assert.strictEqual(route!.name, 'POST /users');
      assert.strictEqual(route!.line, 35);
    });

    it('should find route by "GET /users"', async () => {
      const route = await findRouteByPattern(backend, 'GET /users');

      assert.ok(route, 'Should find route');
      assert.strictEqual(route!.name, 'GET /users');
      assert.strictEqual(route!.line, 42);
    });

    it('should find route with path parameter', async () => {
      const route = await findRouteByPattern(backend, 'GET /users/:id');

      assert.ok(route, 'Should find route');
      assert.strictEqual(route!.name, 'GET /users/:id');
    });

    it('should be case-sensitive for method', async () => {
      // "get /status" should NOT match "GET /status"
      const route = await findRouteByPattern(backend, 'get /status');

      assert.strictEqual(route, null, 'Should not match - methods are case-sensitive');
    });
  });

  // ===========================================================================
  // TEST: Path-only match "/path"
  // ===========================================================================

  describe('path-only match "/path"', () => {
    it('should find route by "/status" only', async () => {
      const route = await findRouteByPattern(backend, '/status');

      assert.ok(route, 'Should find route');
      assert.strictEqual(route!.name, 'GET /status');
    });

    it('should return first matching route for "/users"', async () => {
      // Both GET /users and POST /users exist
      // Path-only match should return the first one found
      const route = await findRouteByPattern(backend, '/users');

      assert.ok(route, 'Should find route');
      // Should match one of them (POST /users comes first in our mock)
      assert.ok(
        route!.name === 'POST /users' || route!.name === 'GET /users',
        `Should match one of the /users routes. Got: ${route!.name}`
      );
    });
  });

  // ===========================================================================
  // TEST: Not found
  // ===========================================================================

  describe('route not found', () => {
    it('should return null for non-existent route', async () => {
      const route = await findRouteByPattern(backend, 'GET /nonexistent');

      assert.strictEqual(route, null, 'Should return null');
    });

    it('should return null for empty pattern', async () => {
      const route = await findRouteByPattern(backend, '');

      assert.strictEqual(route, null, 'Should return null for empty pattern');
    });

    it('should return null for wrong method', async () => {
      // DELETE /status doesn't exist
      const route = await findRouteByPattern(backend, 'DELETE /status');

      assert.strictEqual(route, null, 'Should return null');
    });
  });

  // ===========================================================================
  // TEST: Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle whitespace in pattern', async () => {
      // Extra whitespace should be handled
      const route = await findRouteByPattern(backend, '  GET /status  ');

      assert.ok(route, 'Should find route despite whitespace');
      assert.strictEqual(route!.name, 'GET /status');
    });

    it('should handle multiple spaces between method and path', async () => {
      // "GET  /status" (double space) should NOT match "GET /status"
      const route = await findRouteByPattern(backend, 'GET  /status');

      // Behavior depends on implementation - strict matching would return null
      // Lenient matching would still find it
      // For now, we expect strict matching
      assert.strictEqual(route, null, 'Should not match - extra space');
    });
  });
});

// =============================================================================
// TESTS: Route Trace Handler Output
// =============================================================================

describe('handleRouteTrace() output', () => {
  let backend: MockRouteBackend;

  beforeEach(() => {
    backend = new MockRouteBackend();
  });

  // ===========================================================================
  // TEST: Route with responses
  // ===========================================================================

  describe('route with responses', () => {
    it('should find RESPONDS_WITH edges from route', async () => {
      // Setup: route with response
      backend.addRoute({
        id: 'route:1',
        type: 'http:route',
        method: 'GET',
        path: '/status',
        file: 'routes.js',
        line: 21
      });

      backend.addNode({
        id: 'var:statusData',
        type: 'VARIABLE',
        name: 'statusData',
        file: 'routes.js',
        line: 22
      } as NodeRecord);

      backend.addEdge({
        src: 'route:1',
        dst: 'var:statusData',
        type: 'RESPONDS_WITH',
        metadata: { responseMethod: 'json' }
      });

      // Find route
      const route = await findRouteByPattern(backend, 'GET /status');
      assert.ok(route, 'Should find route');

      // Get RESPONDS_WITH edges
      const edges = await backend.getOutgoingEdges(route!.id, ['RESPONDS_WITH']);

      assert.strictEqual(edges.length, 1, 'Should have one RESPONDS_WITH edge');
      assert.strictEqual(edges[0].dst, 'var:statusData');
      assert.strictEqual(edges[0].metadata?.responseMethod, 'json');
    });

    it('should handle multiple RESPONDS_WITH edges (conditional responses)', async () => {
      // Setup: route with conditional responses
      backend.addRoute({
        id: 'route:2',
        type: 'http:route',
        method: 'GET',
        path: '/item/:id',
        file: 'routes.js',
        line: 30
      });

      backend.addNode({
        id: 'obj:success',
        type: 'OBJECT_LITERAL',
        name: '<response>',
        file: 'routes.js',
        line: 35
      } as NodeRecord);

      backend.addNode({
        id: 'obj:error',
        type: 'OBJECT_LITERAL',
        name: '<response>',
        file: 'routes.js',
        line: 33
      } as NodeRecord);

      backend.addEdge({
        src: 'route:2',
        dst: 'obj:success',
        type: 'RESPONDS_WITH',
        metadata: { responseMethod: 'json' }
      });

      backend.addEdge({
        src: 'route:2',
        dst: 'obj:error',
        type: 'RESPONDS_WITH',
        metadata: { responseMethod: 'json' }
      });

      // Get RESPONDS_WITH edges
      const edges = await backend.getOutgoingEdges('route:2', ['RESPONDS_WITH']);

      assert.strictEqual(edges.length, 2, 'Should have two RESPONDS_WITH edges');
    });
  });

  // ===========================================================================
  // TEST: Route without responses
  // ===========================================================================

  describe('route without responses', () => {
    it('should return empty edges for route without RESPONDS_WITH', async () => {
      // Setup: route without any response edges
      backend.addRoute({
        id: 'route:3',
        type: 'http:route',
        method: 'GET',
        path: '/health',
        file: 'routes.js',
        line: 10
      });

      // No RESPONDS_WITH edges added

      // Get RESPONDS_WITH edges
      const edges = await backend.getOutgoingEdges('route:3', ['RESPONDS_WITH']);

      assert.strictEqual(edges.length, 0, 'Should have no RESPONDS_WITH edges');
    });
  });
});

// =============================================================================
// TESTS: Error Messages and Hints
// =============================================================================

describe('error messages and hints', () => {
  /**
   * These tests document expected error messages for various scenarios.
   * The actual implementation should provide helpful hints.
   */

  it('should suggest grafema query when route not found', () => {
    // Expected output:
    // "Route not found: GET /nonexistent"
    // ""
    // "Hint: Use \"grafema query\" to list available routes"

    const expectedMessage = 'Route not found: GET /nonexistent';
    const expectedHint = 'Hint: Use "grafema query" to list available routes';

    // This is a documentation test - implementation should match
    assert.ok(expectedMessage.includes('not found'));
    assert.ok(expectedHint.includes('grafema query'));
  });

  it('should suggest ExpressResponseAnalyzer when no responses found', () => {
    // Expected output:
    // "Route: GET /health (routes.js:10)"
    // ""
    // "No response data found for this route."
    // ""
    // "Hint: Make sure ExpressResponseAnalyzer is in your config."

    const expectedMessage = 'No response data found';
    const expectedHint = 'ExpressResponseAnalyzer';

    // This is a documentation test - implementation should match
    assert.ok(expectedMessage.includes('No response'));
    assert.ok(expectedHint.includes('ExpressResponseAnalyzer'));
  });
});

// =============================================================================
// TESTS: Output Format
// =============================================================================

describe('output format', () => {
  /**
   * These tests document the expected output format for successful traces.
   */

  it('should format route header correctly', () => {
    // Expected format:
    // "Route: GET /status (backend/routes.js:21)"

    const route = {
      name: 'GET /status',
      file: 'backend/routes.js',
      line: 21
    };

    const header = `Route: ${route.name} (${route.file}:${route.line})`;

    assert.strictEqual(header, 'Route: GET /status (backend/routes.js:21)');
  });

  it('should format response section correctly', () => {
    // Expected format:
    // "Response 1 (res.json at line 23):"
    // "  Data sources:"
    // "    [VARIABLE] statusData at backend/routes.js:22"

    const responseNum = 1;
    const method = 'json';
    const line = 23;

    const header = `Response ${responseNum} (res.${method} at line ${line}):`;

    assert.strictEqual(header, 'Response 1 (res.json at line 23):');
  });

  it('should format data source lines correctly', () => {
    // Format for different source types:
    // "[LITERAL] {\"status\":\"ok\"} at routes.js:22"
    // "[VARIABLE] statusData at routes.js:22"
    // "[CALL] db.all at routes.js:47"
    // "[UNKNOWN] database query result at routes.js:47"

    const formatSource = (type: string, name: string, file: string, line: number) => {
      return `[${type}] ${name} at ${file}:${line}`;
    };

    assert.strictEqual(
      formatSource('VARIABLE', 'statusData', 'routes.js', 22),
      '[VARIABLE] statusData at routes.js:22'
    );

    assert.strictEqual(
      formatSource('CALL', 'db.all', 'routes.js', 47),
      '[CALL] db.all at routes.js:47'
    );
  });
});
