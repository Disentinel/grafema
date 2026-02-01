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
