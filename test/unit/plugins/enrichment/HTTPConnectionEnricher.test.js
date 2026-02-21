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
  const normRequest = normalizeUrl(requestUrl);
  const normRoute = normalizeUrl(routePath);

  if (normRequest === normRoute) return true;
  if (!hasParamsNormalized(normRoute)) return false;

  return buildParamRegex(normRoute).test(normRequest);
}

function hasParams(path) {
  return Boolean(path && (path.includes(':') || path.includes('${')));
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

    const methodSource = request.methodSource || 'explicit';
    const method = request.method ? request.method.toUpperCase() : null;
    const url = request.url;

    for (const route of uniqueRoutes) {
      const routeMethod = route.method ? route.method.toUpperCase() : null;

      // THE FIX: Use fullPath if available, fallback to path
      const routePath = route.fullPath || route.path;

      if (!routeMethod) continue;
      if (methodSource === 'unknown') continue;
      if (methodSource === 'default' && routeMethod !== 'GET') continue;
      if (methodSource === 'explicit' && (!method || method !== routeMethod)) continue;

      if (routePath && pathsMatch(url, routePath)) {
        edges.push({
          type: 'INTERACTS_WITH',
          src: request.id,
          dst: route.id,
          metadata: { matchType: hasParams(routePath) ? 'parametric' : 'exact' }
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
      assert.strictEqual(edges[0].metadata.matchType, 'exact');
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
      assert.strictEqual(edges[0].metadata.matchType, 'parametric');
    });

    it('should treat dots in routes as literal characters', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:file-json',
        type: 'http:route',
        method: 'GET',
        path: '/files/:id.json',
        fullPath: '/api/files/:id.json',
      });

      graph.addNode({
        id: 'request:file-json',
        type: 'http:request',
        method: 'GET',
        url: '/api/files/123.json',
      });

      graph.addNode({
        id: 'request:file-json-wrong',
        type: 'http:request',
        method: 'GET',
        url: '/api/files/123xjson',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 1, 'Only the literal .json path should match');
      assert.strictEqual(edges[0].src, 'request:file-json');
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

  describe('Method source fallback', () => {

    it('should match default GET only when route is GET', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'route:post-users',
        type: 'http:route',
        method: 'POST',
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'request:default-get',
        type: 'http:request',
        method: 'GET',
        methodSource: 'default',
        url: '/api/users',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 1, 'Default GET should match only GET routes');
      assert.strictEqual(edges[0].dst, 'route:get-users');
    });

    it('should skip matching when method is unknown', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'request:unknown',
        type: 'http:request',
        method: 'UNKNOWN',
        methodSource: 'unknown',
        url: '/api/users',
      });

      const edges = await matchRequestsToRoutes(graph);

      assert.strictEqual(edges.length, 0, 'Unknown method should not match any route');
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
          metadata: { matchType: hasParams(routePath) ? 'parametric' : 'exact' }
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

// =============================================================================
// TEMPLATE LITERAL MATCHING TESTS - REG-318
// =============================================================================

/**
 * REG-318: URL normalization for template literal matching
 *
 * Problem: Template literals like `/api/users/${id}` don't match Express params like `:id`
 * Solution: Normalize both to canonical form `{param}` before comparison
 */

/**
 * Normalize URL to canonical form for comparison.
 * Converts both Express params (:id) and template literals (${...}) to {param}.
 */
function normalizeUrl(url) {
  return url
    .replace(/:[A-Za-z0-9_]+/g, '{param}')      // :id -> {param}
    .replace(/\$\{[^}]*\}/g, '{param}'); // ${...} -> {param}, ${userId} -> {param}
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildParamRegex(normalizedRoute) {
  const parts = normalizedRoute.split('{param}');
  const pattern = parts.map(escapeRegExp).join('[^/]+');
  return new RegExp(`^${pattern}$`);
}

/**
 * Check if URL has any parameter placeholders (after normalization)
 */
function hasParamsNormalized(normalizedUrl) {
  return normalizedUrl.includes('{param}');
}

/**
 * Check if path has parameters (for edge matchType metadata)
 * Updated to handle both Express params and template literals
 */
function hasParamsNew(path) {
  if (!path) return false;
  return path.includes(':') || path.includes('${');
}

/**
 * Check if request URL matches route path.
 * Supports:
 * - Exact match
 * - Express params (:id)
 * - Template literals (${...})
 * - Concrete values matching params (/users/123 matches /users/:id)
 */
function pathsMatchNormalized(requestUrl, routePath) {
  // Normalize both to canonical form
  const normRequest = normalizeUrl(requestUrl);
  const normRoute = normalizeUrl(routePath);

  // If both normalize to same string, they match
  if (normRequest === normRoute) {
    return true;
  }

  // If route has no params after normalization, require exact match
  if (!hasParamsNormalized(normRoute)) {
    return false;
  }

  // Handle case where request has concrete value (e.g., '/users/123')
  // and route has param (e.g., '/users/{param}')
  return buildParamRegex(normRoute).test(normRequest);
}

/**
 * Core matching logic WITH template literal support
 */
async function matchRequestsToRoutesNormalized(graph) {
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

    const methodSource = request.methodSource || 'explicit';
    const method = request.method ? request.method.toUpperCase() : null;
    const url = request.url;

    for (const route of uniqueRoutes) {
      const routeMethod = route.method ? route.method.toUpperCase() : null;
      const routePath = route.fullPath || route.path;

      if (!routeMethod) continue;
      if (methodSource === 'unknown') continue;
      if (methodSource === 'default' && routeMethod !== 'GET') continue;
      if (methodSource === 'explicit' && (!method || method !== routeMethod)) continue;

      if (routePath && pathsMatchNormalized(url, routePath)) {
        edges.push({
          type: 'INTERACTS_WITH',
          src: request.id,
          dst: route.id,
          metadata: { matchType: hasParamsNew(routePath) || hasParamsNew(url) ? 'parametric' : 'exact' }
        });
        break; // One request → one route
      }
    }
  }

  return edges;
}

describe('HTTPConnectionEnricher - Template Literal Matching (REG-318)', () => {

  describe('Template literal ${...} matches Express :param', () => {

    it('should match template literal ${...} to :param', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:users-by-id',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/:id',
      });

      graph.addNode({
        id: 'request:get-user',
        type: 'http:request',
        method: 'GET',
        url: '/api/users/${...}',  // Template literal (unnamed)
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1, 'Should match template literal to param');
      assert.strictEqual(edges[0].metadata.matchType, 'parametric');
    });

    it('should match named template literal ${userId} to :id', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:users-by-id',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/:id',
      });

      graph.addNode({
        id: 'request:get-user',
        type: 'http:request',
        method: 'GET',
        url: '/api/users/${userId}',  // Named template variable
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1, 'Should match named template literal to param');
      assert.strictEqual(edges[0].src, 'request:get-user');
      assert.strictEqual(edges[0].dst, 'route:users-by-id');
    });
  });

  describe('Multiple params in path', () => {

    it('should match paths with multiple params', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:user-posts',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/:userId/posts/:postId',
      });

      graph.addNode({
        id: 'request:user-posts',
        type: 'http:request',
        method: 'GET',
        url: '/api/users/${userId}/posts/${postId}',
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1, 'Should match multiple params');
      assert.strictEqual(edges[0].metadata.matchType, 'parametric');
    });

    it('should match mixed params (:id and ${value})', async () => {
      const graph = new MockGraphBackend();

      // Route uses Express params
      graph.addNode({
        id: 'route:nested',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/:orgId/teams/:teamId',
      });

      // Request uses template literals
      graph.addNode({
        id: 'request:nested',
        type: 'http:request',
        method: 'GET',
        url: '/api/${orgId}/teams/${teamId}',
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1);
    });
  });

  describe('Concrete value matches param', () => {

    it('should match concrete value to :param', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:user-by-id',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/:id',
      });

      graph.addNode({
        id: 'request:user-123',
        type: 'http:request',
        method: 'GET',
        url: '/api/users/123',  // Concrete value
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1, 'Should match concrete value to param');
      assert.strictEqual(edges[0].metadata.matchType, 'parametric');
    });

    it('should match concrete UUID to :param', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:resource',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/resources/:resourceId',
      });

      graph.addNode({
        id: 'request:resource-uuid',
        type: 'http:request',
        method: 'GET',
        url: '/api/resources/550e8400-e29b-41d4-a716-446655440000',
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1);
    });

    it('should match multiple concrete values to multiple params', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:user-post',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/:userId/posts/:postId',
      });

      graph.addNode({
        id: 'request:specific-post',
        type: 'http:request',
        method: 'GET',
        url: '/api/users/42/posts/7',  // Two concrete values
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].metadata.matchType, 'parametric');
    });
  });

  describe('No false positives', () => {

    it('should NOT match different base paths', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'request:posts',
        type: 'http:request',
        method: 'GET',
        url: '/api/posts/${id}',
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 0, 'Different base paths should not match');
    });

    it('should NOT match different path structures', async () => {
      const graph = new MockGraphBackend();

      // Route: /api/users/:id
      graph.addNode({
        id: 'route:user-by-id',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/:id',
      });

      // Request: /api/users/profile/settings (different structure)
      graph.addNode({
        id: 'request:settings',
        type: 'http:request',
        method: 'GET',
        url: '/api/users/profile/settings',
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 0, 'Different path structures should not match');
    });

    it('should NOT match /api/users/:id with /api/users (missing param)', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:user-by-id',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/:id',
      });

      graph.addNode({
        id: 'request:list-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',  // No param value
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 0, 'Missing param segment should not match');
    });

    it('should NOT match when route has no params and paths differ', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:specific',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/admin',  // No params
      });

      graph.addNode({
        id: 'request:different',
        type: 'http:request',
        method: 'GET',
        url: '/api/users/guest',  // Different concrete path
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 0, 'Different concrete paths should not match');
    });
  });

  describe('Edge cases', () => {

    it('should handle root path correctly', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:root',
        type: 'http:route',
        method: 'GET',
        fullPath: '/',
      });

      graph.addNode({
        id: 'request:root',
        type: 'http:request',
        method: 'GET',
        url: '/',
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].metadata.matchType, 'exact');
    });

    it('should handle empty template literal ${} correctly', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:param',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/:id',
      });

      graph.addNode({
        id: 'request:empty-template',
        type: 'http:request',
        method: 'GET',
        url: '/api/${}',  // Empty template literal
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      // ${} should normalize to {param} and match
      assert.strictEqual(edges.length, 1);
    });

    it('should handle complex template expressions ${user.id} correctly', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:user',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users/:userId',
      });

      graph.addNode({
        id: 'request:complex-template',
        type: 'http:request',
        method: 'GET',
        url: '/api/users/${user.id}',  // Complex expression
      });

      const edges = await matchRequestsToRoutesNormalized(graph);

      assert.strictEqual(edges.length, 1);
    });
  });
});

describe('URL Normalization Unit Tests', () => {

  it('should normalize Express :param to {param}', () => {
    assert.strictEqual(normalizeUrl('/api/users/:id'), '/api/users/{param}');
    assert.strictEqual(normalizeUrl('/api/:org/teams/:team'), '/api/{param}/teams/{param}');
  });

  it('should normalize template literal ${...} to {param}', () => {
    assert.strictEqual(normalizeUrl('/api/users/${id}'), '/api/users/{param}');
    assert.strictEqual(normalizeUrl('/api/users/${userId}'), '/api/users/{param}');
    assert.strictEqual(normalizeUrl('/api/users/${...}'), '/api/users/{param}');
  });

  it('should normalize mixed params to same form', () => {
    const expressPath = normalizeUrl('/api/:orgId/teams/:teamId');
    const templatePath = normalizeUrl('/api/${orgId}/teams/${teamId}');

    assert.strictEqual(expressPath, templatePath);
    assert.strictEqual(expressPath, '/api/{param}/teams/{param}');
  });

  it('should not modify paths without params', () => {
    assert.strictEqual(normalizeUrl('/api/users'), '/api/users');
    assert.strictEqual(normalizeUrl('/health'), '/health');
    assert.strictEqual(normalizeUrl('/'), '/');
  });

  it('should detect params correctly', () => {
    assert.strictEqual(hasParamsNew('/api/users/:id'), true);
    assert.strictEqual(hasParamsNew('/api/users/${id}'), true);
    assert.strictEqual(hasParamsNew('/api/users'), false);
    assert.strictEqual(hasParamsNew('/api/users/123'), false);
  });
});
