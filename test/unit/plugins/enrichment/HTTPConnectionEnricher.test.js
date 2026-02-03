/**
 * HTTPConnectionEnricher Tests - REG-248: Router mount prefix support
 *
 * Tests INTERACTS_WITH edge creation between http:request and http:route nodes.
 * Key fix: HTTPConnectionEnricher should use route.fullPath || route.path
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// =============================================================================
// MOCK GRAPH BACKEND
// =============================================================================

class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  addNode(node) {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge) {
    this.edges.push(edge);
  }

  async *queryNodes(filter) {
    for (const node of this.nodes.values()) {
      if (filter?.type && node.type !== filter.type) continue;
      yield node;
    }
  }

  getEdges() {
    return this.edges;
  }

  findEdge(type, src, dst) {
    return this.edges.find(e => e.type === type && e.src === src && e.dst === dst);
  }
}

// =============================================================================
// SIMPLIFIED ENRICHER LOGIC (for testing the fix)
// =============================================================================

/**
 * Simplified pathsMatch (same logic as HTTPConnectionEnricher)
 */
function pathsMatch(requestUrl, routePath) {
  if (requestUrl === routePath) return true;
  if (!routePath.includes(':')) return false;

  const regexPattern = routePath
    .replace(/:[^/]+/g, '[^/]+')
    .replace(/\//g, '\\/');
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(requestUrl);
}

function hasParams(path) {
  return Boolean(path && path.includes(':'));
}

/**
 * Core matching logic - THE FIX IS HERE
 */
async function matchRequestsToRoutes(graph) {
  const routes = [];
  for await (const node of graph.queryNodes({ type: 'http:route' })) {
    routes.push(node);
  }

  const requests = [];
  for await (const node of graph.queryNodes({ type: 'http:request' })) {
    requests.push(node);
  }

  // Deduplicate
  const uniqueRoutes = [...new Map(routes.map(r => [r.id, r])).values()];
  const uniqueRequests = [...new Map(requests.map(r => [r.id, r])).values()];

  const edges = [];

  for (const request of uniqueRequests) {
    if (request.url === 'dynamic' || !request.url) continue;

    const method = (request.method || 'GET').toUpperCase();
    const url = request.url;

    for (const route of uniqueRoutes) {
      const routeMethod = (route.method || 'GET').toUpperCase();

      // THE FIX: Use fullPath if available, fallback to path
      const routePath = route.fullPath || route.path;

      if (routePath && method === routeMethod && pathsMatch(url, routePath)) {
        edges.push({
          type: 'INTERACTS_WITH',
          src: request.id,
          dst: route.id,
          matchType: hasParams(routePath) ? 'parametric' : 'exact'
        });
        break; // One request → one route
      }
    }
  }

  return edges;
}

// =============================================================================
// TESTS
// =============================================================================

describe('HTTPConnectionEnricher - Mount Prefix Support', () => {

  describe('Basic mounted route matching', () => {

    it('should match request to route using fullPath', async () => {
      const graph = new MockGraphBackend();

      // Route with fullPath (set by MountPointResolver)
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/users',           // Local path
        fullPath: '/api/users',   // Full path with mount prefix
      });

      // Request to full path
      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 1, 'Should create 1 edge');
      assert.strictEqual(edges[0].src, 'request:fetch-users');
      assert.strictEqual(edges[0].dst, 'route:get-users');
      assert.strictEqual(edges[0].matchType, 'exact');
    });

    it('should NOT match when using only path (without fullPath)', async () => {
      const graph = new MockGraphBackend();

      // Route WITHOUT fullPath (simulating current broken behavior)
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/users',  // Local path only
        // NO fullPath
      });

      // Request to full path
      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
      });

      const edges = await matchRequestsToRoutes(graph);

      // Without fullPath, '/users' !== '/api/users', so no match
      assert.strictEqual(edges.length, 0, 'Should NOT match without fullPath');
    });
  });

  describe('Fallback to path', () => {

    it('should use path when fullPath not set (unmounted route)', async () => {
      const graph = new MockGraphBackend();

      // Unmounted route (path is the full path)
      graph.addNode({
        id: 'route:health',
        type: 'http:route',
        method: 'GET',
        path: '/health',
        // No fullPath (unmounted)
      });

      graph.addNode({
        id: 'request:health',
        type: 'http:request',
        method: 'GET',
        url: '/health',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 1, 'Should match using path fallback');
    });
  });

  describe('Nested mount points', () => {

    it('should match through nested mounts (/api/v1/users)', async () => {
      const graph = new MockGraphBackend();

      // Route with accumulated fullPath from nested mounts
      graph.addNode({
        id: 'route:nested-users',
        type: 'http:route',
        method: 'GET',
        path: '/users',             // Local path
        fullPath: '/api/v1/users',  // Accumulated: /api + /v1 + /users
      });

      graph.addNode({
        id: 'request:nested-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/v1/users',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].dst, 'route:nested-users');
    });
  });

  describe('Parametric routes with mount prefix', () => {

    it('should match parametric route with fullPath', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:get-item',
        type: 'http:route',
        method: 'GET',
        path: '/:id',
        fullPath: '/api/:id',
      });

      graph.addNode({
        id: 'request:get-123',
        type: 'http:request',
        method: 'GET',
        url: '/api/123',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].matchType, 'parametric');
    });
  });

  describe('Method matching', () => {

    it('should NOT match different methods', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:post-users',
        type: 'http:route',
        method: 'POST',
        path: '/users',
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'request:get-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 0, 'POST and GET should not match');
    });

    it('should be case insensitive', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:post-users',
        type: 'http:route',
        method: 'post',  // lowercase
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'request:post-users',
        type: 'http:request',
        method: 'POST',  // uppercase
        url: '/api/users',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 1);
    });
  });

  describe('Edge cases', () => {

    it('should skip dynamic URLs', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:api',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/data',
      });

      graph.addNode({
        id: 'request:dynamic',
        type: 'http:request',
        method: 'GET',
        url: 'dynamic',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 0);
    });

    it('should skip requests without url', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:api',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/data',
      });

      graph.addNode({
        id: 'request:no-url',
        type: 'http:request',
        method: 'GET',
        // no url
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 0);
    });

    it('should skip routes without path', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:no-path',
        type: 'http:route',
        method: 'GET',
        // no path, no fullPath
      });

      graph.addNode({
        id: 'request:api',
        type: 'http:request',
        method: 'GET',
        url: '/api/data',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 0);
    });
  });
});

// =============================================================================
// HTTP_RECEIVES EDGE TESTS (REG-252 Phase C)
// =============================================================================

/**
 * Extended MockGraphBackend with getOutgoingEdges support for HTTP_RECEIVES tests.
 */
class ExtendedMockGraphBackend extends MockGraphBackend {
  async getOutgoingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.src !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }
}

/**
 * Core logic for creating HTTP_RECEIVES edges.
 * This is the logic that HTTPConnectionEnricher should implement.
 *
 * For each matched request->route pair:
 * 1. Get request.responseDataNode (the response.json() CALL node)
 * 2. Get route's RESPONDS_WITH edges (the backend response data)
 * 3. Create HTTP_RECEIVES edge from responseDataNode to each RESPONDS_WITH destination
 */
async function createHttpReceivesEdges(graph, request, route) {
  const edges = [];

  // Skip if no responseDataNode
  const responseDataNode = request.responseDataNode;
  if (!responseDataNode) {
    return edges;
  }

  // Get RESPONDS_WITH edges from the route
  const respondsWithEdges = await graph.getOutgoingEdges(route.id, ['RESPONDS_WITH']);
  if (respondsWithEdges.length === 0) {
    return edges;
  }

  // Create HTTP_RECEIVES edge for each RESPONDS_WITH edge
  for (const respEdge of respondsWithEdges) {
    edges.push({
      type: 'HTTP_RECEIVES',
      src: responseDataNode,
      dst: respEdge.dst,
      metadata: {
        method: request.method,
        path: request.url,
        viaRequest: request.id,
        viaRoute: route.id
      }
    });
  }

  return edges;
}

/**
 * Full matching logic with HTTP_RECEIVES edge creation.
 */
async function matchRequestsToRoutesWithHttpReceives(graph) {
  const routes = [];
  for await (const node of graph.queryNodes({ type: 'http:route' })) {
    routes.push(node);
  }

  const requests = [];
  for await (const node of graph.queryNodes({ type: 'http:request' })) {
    requests.push(node);
  }

  const uniqueRoutes = [...new Map(routes.map(r => [r.id, r])).values()];
  const uniqueRequests = [...new Map(requests.map(r => [r.id, r])).values()];

  const interactsWithEdges = [];
  const httpReceivesEdges = [];

  for (const request of uniqueRequests) {
    if (request.url === 'dynamic' || !request.url) continue;

    const method = (request.method || 'GET').toUpperCase();
    const url = request.url;

    for (const route of uniqueRoutes) {
      const routeMethod = (route.method || 'GET').toUpperCase();
      const routePath = route.fullPath || route.path;

      if (routePath && method === routeMethod && pathsMatch(url, routePath)) {
        // Create INTERACTS_WITH edge (existing)
        interactsWithEdges.push({
          type: 'INTERACTS_WITH',
          src: request.id,
          dst: route.id,
          matchType: hasParams(routePath) ? 'parametric' : 'exact'
        });

        // Create HTTP_RECEIVES edges (NEW)
        const httpEdges = await createHttpReceivesEdges(graph, request, route);
        httpReceivesEdges.push(...httpEdges);

        break;
      }
    }
  }

  return { interactsWithEdges, httpReceivesEdges };
}

describe('HTTPConnectionEnricher - HTTP_RECEIVES Edges (REG-252 Phase C)', () => {

  describe('Basic HTTP_RECEIVES edge creation', () => {

    /**
     * WHY: When frontend fetches from backend endpoint, and both:
     * - Frontend has responseDataNode (response.json() CALL)
     * - Backend has RESPONDS_WITH edge to response data
     * Then HTTP_RECEIVES edge should connect them.
     */
    it('should create HTTP_RECEIVES edge when both responseDataNode and RESPONDS_WITH exist', async () => {
      const graph = new ExtendedMockGraphBackend();

      // Backend route
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/api/users',
      });

      // Backend response data (OBJECT_LITERAL)
      graph.addNode({
        id: 'obj:users-response',
        type: 'OBJECT_LITERAL',
        file: 'server.js',
      });

      // RESPONDS_WITH edge from route to response data
      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:get-users',
        dst: 'obj:users-response',
      });

      // Frontend request with responseDataNode
      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
        responseDataNode: 'call:response-json',  // The response.json() CALL
      });

      // Frontend CALL node (response.json())
      graph.addNode({
        id: 'call:response-json',
        type: 'CALL',
        object: 'response',
        method: 'json',
        file: 'client.js',
      });

      const { interactsWithEdges, httpReceivesEdges } = await matchRequestsToRoutesWithHttpReceives(graph);

      // Should have INTERACTS_WITH edge
      assert.strictEqual(interactsWithEdges.length, 1, 'Should create INTERACTS_WITH edge');

      // Should have HTTP_RECEIVES edge
      assert.strictEqual(httpReceivesEdges.length, 1, 'Should create HTTP_RECEIVES edge');

      const httpReceives = httpReceivesEdges[0];
      assert.strictEqual(httpReceives.type, 'HTTP_RECEIVES');
      assert.strictEqual(httpReceives.src, 'call:response-json', 'Source should be responseDataNode');
      assert.strictEqual(httpReceives.dst, 'obj:users-response', 'Destination should be RESPONDS_WITH target');
    });
  });

  describe('Missing responseDataNode', () => {

    /**
     * WHY: If frontend doesn't consume response (no response.json()),
     * then there's no responseDataNode, so no HTTP_RECEIVES edge should be created.
     */
    it('should NOT create HTTP_RECEIVES when responseDataNode is missing', async () => {
      const graph = new ExtendedMockGraphBackend();

      // Backend route
      graph.addNode({
        id: 'route:get-status',
        type: 'http:route',
        method: 'GET',
        path: '/api/status',
      });

      // Backend response data
      graph.addNode({
        id: 'obj:status-response',
        type: 'OBJECT_LITERAL',
      });

      // RESPONDS_WITH edge
      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:get-status',
        dst: 'obj:status-response',
      });

      // Frontend request WITHOUT responseDataNode
      graph.addNode({
        id: 'request:check-status',
        type: 'http:request',
        method: 'GET',
        url: '/api/status',
        // No responseDataNode
      });

      const { httpReceivesEdges } = await matchRequestsToRoutesWithHttpReceives(graph);

      assert.strictEqual(
        httpReceivesEdges.length,
        0,
        'Should NOT create HTTP_RECEIVES when responseDataNode is missing'
      );
    });
  });

  describe('Missing RESPONDS_WITH', () => {

    /**
     * WHY: If backend doesn't have RESPONDS_WITH edge (no res.json()),
     * then we don't know what data backend sends, so no HTTP_RECEIVES edge.
     */
    it('should NOT create HTTP_RECEIVES when RESPONDS_WITH is missing', async () => {
      const graph = new ExtendedMockGraphBackend();

      // Backend route WITHOUT RESPONDS_WITH edge
      graph.addNode({
        id: 'route:ping',
        type: 'http:route',
        method: 'GET',
        path: '/api/ping',
      });
      // No RESPONDS_WITH edge added

      // Frontend request with responseDataNode
      graph.addNode({
        id: 'request:ping',
        type: 'http:request',
        method: 'GET',
        url: '/api/ping',
        responseDataNode: 'call:ping-json',
      });

      graph.addNode({
        id: 'call:ping-json',
        type: 'CALL',
        object: 'response',
        method: 'json',
      });

      const { httpReceivesEdges } = await matchRequestsToRoutesWithHttpReceives(graph);

      assert.strictEqual(
        httpReceivesEdges.length,
        0,
        'Should NOT create HTTP_RECEIVES when RESPONDS_WITH is missing'
      );
    });
  });

  describe('Multiple RESPONDS_WITH edges', () => {

    /**
     * WHY: Backend route with conditional responses (e.g., error vs success)
     * creates multiple RESPONDS_WITH edges. HTTP_RECEIVES should connect
     * to ALL of them.
     */
    it('should create multiple HTTP_RECEIVES for multiple RESPONDS_WITH edges', async () => {
      const graph = new ExtendedMockGraphBackend();

      // Backend route
      graph.addNode({
        id: 'route:get-item',
        type: 'http:route',
        method: 'GET',
        path: '/api/item/:id',
      });

      // Success response
      graph.addNode({
        id: 'obj:success-response',
        type: 'OBJECT_LITERAL',
      });

      // Error response
      graph.addNode({
        id: 'obj:error-response',
        type: 'OBJECT_LITERAL',
      });

      // Two RESPONDS_WITH edges
      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:get-item',
        dst: 'obj:success-response',
      });
      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:get-item',
        dst: 'obj:error-response',
      });

      // Frontend request with responseDataNode
      graph.addNode({
        id: 'request:fetch-item',
        type: 'http:request',
        method: 'GET',
        url: '/api/item/123',
        responseDataNode: 'call:item-json',
      });

      graph.addNode({
        id: 'call:item-json',
        type: 'CALL',
        object: 'response',
        method: 'json',
      });

      const { httpReceivesEdges } = await matchRequestsToRoutesWithHttpReceives(graph);

      assert.strictEqual(
        httpReceivesEdges.length,
        2,
        'Should create HTTP_RECEIVES edge for each RESPONDS_WITH edge'
      );

      const dsts = httpReceivesEdges.map(e => e.dst).sort();
      assert.deepStrictEqual(
        dsts,
        ['obj:error-response', 'obj:success-response'],
        'Should include both success and error responses'
      );
    });
  });

  describe('Edge metadata', () => {

    /**
     * WHY: HTTP_RECEIVES edge should include metadata for debugging and tracing.
     */
    it('should include HTTP context in HTTP_RECEIVES edge metadata', async () => {
      const graph = new ExtendedMockGraphBackend();

      graph.addNode({
        id: 'route:data',
        type: 'http:route',
        method: 'GET',
        path: '/api/data',
      });

      graph.addNode({
        id: 'obj:data-response',
        type: 'OBJECT_LITERAL',
      });

      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:data',
        dst: 'obj:data-response',
      });

      graph.addNode({
        id: 'request:data',
        type: 'http:request',
        method: 'GET',
        url: '/api/data',
        responseDataNode: 'call:data-json',
      });

      graph.addNode({
        id: 'call:data-json',
        type: 'CALL',
      });

      const { httpReceivesEdges } = await matchRequestsToRoutesWithHttpReceives(graph);

      assert.strictEqual(httpReceivesEdges.length, 1);

      const metadata = httpReceivesEdges[0].metadata;
      assert.ok(metadata, 'Should have metadata');
      assert.strictEqual(metadata.method, 'GET', 'Should include HTTP method');
      assert.strictEqual(metadata.path, '/api/data', 'Should include request path');
      assert.strictEqual(metadata.viaRequest, 'request:data', 'Should include request node ID');
      assert.strictEqual(metadata.viaRoute, 'route:data', 'Should include route node ID');
    });
  });

  describe('INTERACTS_WITH preservation', () => {

    /**
     * WHY: Adding HTTP_RECEIVES should NOT break existing INTERACTS_WITH edge creation.
     */
    it('should still create INTERACTS_WITH edge alongside HTTP_RECEIVES', async () => {
      const graph = new ExtendedMockGraphBackend();

      graph.addNode({
        id: 'route:test',
        type: 'http:route',
        method: 'GET',
        path: '/api/test',
      });

      graph.addNode({
        id: 'obj:test-response',
        type: 'OBJECT_LITERAL',
      });

      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:test',
        dst: 'obj:test-response',
      });

      graph.addNode({
        id: 'request:test',
        type: 'http:request',
        method: 'GET',
        url: '/api/test',
        responseDataNode: 'call:test-json',
      });

      graph.addNode({
        id: 'call:test-json',
        type: 'CALL',
      });

      const { interactsWithEdges, httpReceivesEdges } = await matchRequestsToRoutesWithHttpReceives(graph);

      assert.strictEqual(interactsWithEdges.length, 1, 'Should create INTERACTS_WITH edge');
      assert.strictEqual(httpReceivesEdges.length, 1, 'Should also create HTTP_RECEIVES edge');
    });
  });

  describe('POST request with response', () => {

    /**
     * WHY: HTTP_RECEIVES should work for all HTTP methods, not just GET.
     */
    it('should create HTTP_RECEIVES for POST request', async () => {
      const graph = new ExtendedMockGraphBackend();

      graph.addNode({
        id: 'route:create-user',
        type: 'http:route',
        method: 'POST',
        path: '/api/users',
      });

      graph.addNode({
        id: 'obj:created-user',
        type: 'OBJECT_LITERAL',
      });

      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:create-user',
        dst: 'obj:created-user',
      });

      graph.addNode({
        id: 'request:create-user',
        type: 'http:request',
        method: 'POST',
        url: '/api/users',
        responseDataNode: 'call:create-json',
      });

      graph.addNode({
        id: 'call:create-json',
        type: 'CALL',
      });

      const { httpReceivesEdges } = await matchRequestsToRoutesWithHttpReceives(graph);

      assert.strictEqual(httpReceivesEdges.length, 1, 'Should create HTTP_RECEIVES for POST');
      assert.strictEqual(httpReceivesEdges[0].metadata.method, 'POST');
    });
  });
});
