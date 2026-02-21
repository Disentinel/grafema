/**
 * ServiceConnectionEnricher Tests (REG-256 Phase 5)
 *
 * Tests that ServiceConnectionEnricher correctly:
 * 1. Ports all matching logic from HTTPConnectionEnricher
 * 2. Applies routing transformations (stripPrefix/addPrefix)
 * 3. Resolves service ownership from SERVICE nodes
 * 4. Marks customerFacing routes
 * 5. Falls back to direct matching when no routing config exists
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ServiceConnectionEnricher,
  ResourceRegistryImpl,
  createRoutingMap,
  StrictModeError,
} from '@grafema/core';
import { ROUTING_MAP_RESOURCE_ID } from '@grafema/types';

// =============================================================================
// MOCK GRAPH BACKEND
// =============================================================================

class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  addNode(node) {
    this.nodes.set(node.id, { ...this.nodes.get(node.id), ...node });
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

  async getOutgoingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.src !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }

  async getIncomingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.dst !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }

  getNode(id) {
    return this.nodes.get(id);
  }

  async updateNode(node) {
    this.nodes.set(node.id, { ...this.nodes.get(node.id), ...node });
  }
}

// =============================================================================
// HELPER
// =============================================================================

function createContext(graph, overrides = {}) {
  return {
    graph,
    config: {},
    ...overrides,
  };
}

// =============================================================================
// BASIC MATCHING (ported from HTTPConnectionEnricher tests)
// =============================================================================

describe('ServiceConnectionEnricher', () => {

  describe('Basic matching (ported from HTTPConnectionEnricher)', () => {

    it('should match request to route using fullPath', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/users',
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge, 'Should create INTERACTS_WITH edge');
      assert.strictEqual(edge.src, 'request:fetch-users');
      assert.strictEqual(edge.dst, 'route:get-users');
      assert.strictEqual(edge.metadata.matchType, 'exact');
    });

    it('should NOT match when using only path (without fullPath)', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/users',
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edges.length, 0, 'Should NOT match without fullPath');
    });

    it('should use path when fullPath not set (unmounted route)', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:health',
        type: 'http:route',
        method: 'GET',
        path: '/health',
      });

      graph.addNode({
        id: 'request:health',
        type: 'http:request',
        method: 'GET',
        url: '/health',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edges.length, 1, 'Should match using path fallback');
    });

    it('should match through nested mounts (/api/v1/users)', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:nested-users',
        type: 'http:route',
        method: 'GET',
        path: '/users',
        fullPath: '/api/v1/users',
      });

      graph.addNode({
        id: 'request:nested-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/v1/users',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge);
      assert.strictEqual(edge.dst, 'route:nested-users');
    });

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

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge);
      assert.strictEqual(edge.metadata.matchType, 'parametric');
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

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edges.length, 1, 'Only the literal .json path should match');
      assert.strictEqual(edges[0].src, 'request:file-json');
    });

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

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      assert.strictEqual(graph.edges.filter(e => e.type === 'INTERACTS_WITH').length, 0);
    });

    it('should be case insensitive for methods', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:post-users',
        type: 'http:route',
        method: 'post',
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'request:post-users',
        type: 'http:request',
        method: 'POST',
        url: '/api/users',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      assert.strictEqual(graph.edges.filter(e => e.type === 'INTERACTS_WITH').length, 1);
    });

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

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
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

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { strictMode: false }));

      assert.ok(result.success);
      assert.strictEqual(graph.edges.filter(e => e.type === 'INTERACTS_WITH').length, 0);
    });

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

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      assert.strictEqual(graph.edges.filter(e => e.type === 'INTERACTS_WITH').length, 0);
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
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      assert.strictEqual(graph.edges.filter(e => e.type === 'INTERACTS_WITH').length, 0);
    });

    it('should skip routes without path', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:no-path',
        type: 'http:route',
        method: 'GET',
      });

      graph.addNode({
        id: 'request:api',
        type: 'http:request',
        method: 'GET',
        url: '/api/data',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      assert.strictEqual(graph.edges.filter(e => e.type === 'INTERACTS_WITH').length, 0);
    });
  });

  // ===========================================================================
  // HTTP_RECEIVES edges (ported)
  // ===========================================================================

  describe('HTTP_RECEIVES edges (ported)', () => {

    it('should create HTTP_RECEIVES edge when both responseDataNode and RESPONDS_WITH exist', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/api/users',
      });

      graph.addNode({
        id: 'obj:users-response',
        type: 'OBJECT_LITERAL',
        file: 'server.js',
      });

      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:get-users',
        dst: 'obj:users-response',
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
        responseDataNode: 'call:response-json',
      });

      graph.addNode({
        id: 'call:response-json',
        type: 'CALL',
        object: 'response',
        method: 'json',
        file: 'client.js',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const interactsEdge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(interactsEdge, 'Should create INTERACTS_WITH edge');

      const httpReceivesEdge = graph.edges.find(e => e.type === 'HTTP_RECEIVES');
      assert.ok(httpReceivesEdge, 'Should create HTTP_RECEIVES edge');
      assert.strictEqual(httpReceivesEdge.src, 'call:response-json');
      assert.strictEqual(httpReceivesEdge.dst, 'obj:users-response');
    });

    it('should NOT create HTTP_RECEIVES when responseDataNode is missing', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:get-status',
        type: 'http:route',
        method: 'GET',
        path: '/api/status',
      });

      graph.addNode({
        id: 'obj:status-response',
        type: 'OBJECT_LITERAL',
      });

      await graph.addEdge({
        type: 'RESPONDS_WITH',
        src: 'route:get-status',
        dst: 'obj:status-response',
      });

      graph.addNode({
        id: 'request:check-status',
        type: 'http:request',
        method: 'GET',
        url: '/api/status',
      });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const httpReceivesEdges = graph.edges.filter(e => e.type === 'HTTP_RECEIVES');
      assert.strictEqual(httpReceivesEdges.length, 0);
    });

    it('should NOT create HTTP_RECEIVES when RESPONDS_WITH is missing', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:ping',
        type: 'http:route',
        method: 'GET',
        path: '/api/ping',
      });

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

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const httpReceivesEdges = graph.edges.filter(e => e.type === 'HTTP_RECEIVES');
      assert.strictEqual(httpReceivesEdges.length, 0);
    });

    it('should create multiple HTTP_RECEIVES for multiple RESPONDS_WITH edges', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({
        id: 'route:get-item',
        type: 'http:route',
        method: 'GET',
        path: '/api/item/:id',
      });

      graph.addNode({ id: 'obj:success-response', type: 'OBJECT_LITERAL' });
      graph.addNode({ id: 'obj:error-response', type: 'OBJECT_LITERAL' });

      await graph.addEdge({ type: 'RESPONDS_WITH', src: 'route:get-item', dst: 'obj:success-response' });
      await graph.addEdge({ type: 'RESPONDS_WITH', src: 'route:get-item', dst: 'obj:error-response' });

      graph.addNode({
        id: 'request:fetch-item',
        type: 'http:request',
        method: 'GET',
        url: '/api/item/123',
        responseDataNode: 'call:item-json',
      });

      graph.addNode({ id: 'call:item-json', type: 'CALL' });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const httpReceivesEdges = graph.edges.filter(e => e.type === 'HTTP_RECEIVES');
      assert.strictEqual(httpReceivesEdges.length, 2);

      const dsts = httpReceivesEdges.map(e => e.dst).sort();
      assert.deepStrictEqual(dsts, ['obj:error-response', 'obj:success-response']);
    });

    it('should include HTTP context in edge metadata', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'route:data', type: 'http:route', method: 'GET', path: '/api/data' });
      graph.addNode({ id: 'obj:data-response', type: 'OBJECT_LITERAL' });
      await graph.addEdge({ type: 'RESPONDS_WITH', src: 'route:data', dst: 'obj:data-response' });

      graph.addNode({
        id: 'request:data',
        type: 'http:request',
        method: 'GET',
        url: '/api/data',
        responseDataNode: 'call:data-json',
      });
      graph.addNode({ id: 'call:data-json', type: 'CALL' });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const httpReceivesEdge = graph.edges.find(e => e.type === 'HTTP_RECEIVES');
      assert.ok(httpReceivesEdge);
      assert.strictEqual(httpReceivesEdge.metadata.method, 'GET');
      assert.strictEqual(httpReceivesEdge.metadata.path, '/api/data');
      assert.strictEqual(httpReceivesEdge.metadata.viaRequest, 'request:data');
      assert.strictEqual(httpReceivesEdge.metadata.viaRoute, 'route:data');
    });
  });

  // ===========================================================================
  // Template literal matching (ported)
  // ===========================================================================

  describe('Template literal matching (ported)', () => {

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
        url: '/api/users/${...}',
      });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edges.length, 1);
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
        url: '/api/users/${userId}',
      });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].src, 'request:get-user');
      assert.strictEqual(edges[0].dst, 'route:users-by-id');
    });

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

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].metadata.matchType, 'parametric');
    });

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
        url: '/api/users/123',
      });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].metadata.matchType, 'parametric');
    });

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

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph));

      const edges = graph.edges.filter(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edges.length, 0);
    });
  });

  // ===========================================================================
  // Routing transformation (NEW)
  // ===========================================================================

  describe('Routing transformation', () => {

    it('should transform URL using stripPrefix before matching', async () => {
      const graph = new MockGraphBackend();

      // SERVICE nodes for ownership resolution
      graph.addNode({ id: 'service:frontend', type: 'SERVICE', name: 'frontend', file: '/project/apps/frontend' });
      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      // Backend route: GET /users (without /api prefix)
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/users',
        fullPath: '/users',
        file: '/project/apps/backend/src/routes.js',
      });

      // Frontend request: GET /api/users (with /api prefix)
      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
        file: '/project/apps/frontend/src/api.js',
      });

      // Set up routing map with stripPrefix rule
      const resources = new ResourceRegistryImpl();
      const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
      routingMap.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { resources }));

      assert.ok(result.success);
      const interactsEdge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(interactsEdge, 'Should create INTERACTS_WITH edge after URL transformation');
      assert.strictEqual(interactsEdge.src, 'request:fetch-users');
      assert.strictEqual(interactsEdge.dst, 'route:get-users');
    });

    it('should transform URL using addPrefix', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'service:frontend', type: 'SERVICE', name: 'frontend', file: '/project/apps/frontend' });
      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      // Backend route at /v2/users
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/v2/users',
        file: '/project/apps/backend/src/routes.js',
      });

      // Frontend request at /users
      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/users',
        file: '/project/apps/frontend/src/api.js',
      });

      const resources = new ResourceRegistryImpl();
      const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
      routingMap.addRule({ from: 'frontend', to: 'backend', addPrefix: '/v2' });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { resources }));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge, 'Should match after addPrefix transformation');
    });

    it('should transform URL using stripPrefix + addPrefix', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'service:frontend', type: 'SERVICE', name: 'frontend', file: '/project/apps/frontend' });
      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      // Backend route at /v2/users
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/v2/users',
        file: '/project/apps/backend/src/routes.js',
      });

      // Frontend request at /api/users
      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
        file: '/project/apps/frontend/src/api.js',
      });

      const resources = new ResourceRegistryImpl();
      const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
      routingMap.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api', addPrefix: '/v2' });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { resources }));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge, 'Should match after stripPrefix + addPrefix');
    });

    it('should fall back to direct matching when no routing rules exist', async () => {
      const graph = new MockGraphBackend();

      // No SERVICE nodes, no routing map
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/api/users',
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge, 'Should match via direct path comparison (backward compat)');
    });

    it('should fall back to direct matching when services are not determined', async () => {
      const graph = new MockGraphBackend();

      // Routes and requests without file paths (can't determine service)
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/api/users',
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
      });

      // Routing map exists but won't be used since services can't be determined
      const resources = new ResourceRegistryImpl();
      const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
      routingMap.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { resources }));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge, 'Should fall back to direct matching');
    });

    it('should not transform when rule does not match service pair', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'service:frontend', type: 'SERVICE', name: 'frontend', file: '/project/apps/frontend' });
      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      // Backend route: /users
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/users',
        file: '/project/apps/backend/src/routes.js',
      });

      // Frontend request: /api/users
      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
        file: '/project/apps/frontend/src/api.js',
      });

      // Routing rule for WRONG service pair
      const resources = new ResourceRegistryImpl();
      const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
      routingMap.addRule({ from: 'mobile', to: 'backend', stripPrefix: '/api' });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { resources }));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.strictEqual(edge, undefined, 'Should NOT match because rule is for mobile->backend, not frontend->backend');
    });
  });

  // ===========================================================================
  // Service ownership (NEW)
  // ===========================================================================

  describe('Service ownership', () => {

    it('should determine service from file path using SERVICE nodes', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'service:frontend', type: 'SERVICE', name: 'frontend', file: '/project/apps/frontend' });
      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/users',
        file: '/project/apps/backend/src/routes.js',
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
        file: '/project/apps/frontend/src/api.js',
      });

      const resources = new ResourceRegistryImpl();
      const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
      routingMap.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { resources }));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge, 'Service ownership should enable routing transformation');
    });

    it('should handle routes without file path', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      // Route without file path
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/api/users',
        // no file
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
        file: '/project/apps/frontend/src/api.js',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      // Should still match via direct path comparison (no service resolution)
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge, 'Should match without file path on route');
    });

    it('should use longest prefix match for nested service paths', async () => {
      const graph = new MockGraphBackend();

      // Nested services -- backend/api is more specific than backend
      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });
      graph.addNode({ id: 'service:backend-api', type: 'SERVICE', name: 'backend-api', file: '/project/apps/backend/api' });

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/users',
        file: '/project/apps/backend/api/routes.js',
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
        file: '/project/apps/frontend/src/api.js',
      });

      graph.addNode({ id: 'service:frontend', type: 'SERVICE', name: 'frontend', file: '/project/apps/frontend' });

      const resources = new ResourceRegistryImpl();
      const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
      // Rule for frontend -> backend-api (the more specific service)
      routingMap.addRule({ from: 'frontend', to: 'backend-api', stripPrefix: '/api' });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { resources }));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge, 'Should match using the most specific service (backend-api)');
    });
  });

  // ===========================================================================
  // customerFacing marking (NEW)
  // ===========================================================================

  describe('customerFacing marking', () => {

    it('should mark routes as customerFacing when service has customerFacing: true', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/users',
        file: '/project/apps/backend/src/routes.js',
      });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph, {
        config: {
          services: [
            { name: 'backend', path: 'apps/backend', customerFacing: true },
          ],
        },
      }));

      const updatedRoute = graph.getNode('route:get-users');
      assert.strictEqual(updatedRoute.customerFacing, true);
    });

    it('should NOT mark routes when service has customerFacing: false/undefined', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        fullPath: '/users',
        file: '/project/apps/backend/src/routes.js',
      });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph, {
        config: {
          services: [
            { name: 'backend', path: 'apps/backend' },
          ],
        },
      }));

      const updatedRoute = graph.getNode('route:get-users');
      assert.strictEqual(updatedRoute.customerFacing, undefined);
    });

    it('should handle routes not belonging to any service', async () => {
      const graph = new MockGraphBackend();

      graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

      graph.addNode({
        id: 'route:orphan',
        type: 'http:route',
        method: 'GET',
        fullPath: '/orphan',
        file: '/project/other/routes.js',
      });

      const plugin = new ServiceConnectionEnricher();
      await plugin.execute(createContext(graph, {
        config: {
          services: [
            { name: 'backend', path: 'apps/backend', customerFacing: true },
          ],
        },
      }));

      const updatedRoute = graph.getNode('route:orphan');
      assert.strictEqual(updatedRoute.customerFacing, undefined, 'Route outside any service should not be marked');
    });
  });

  // ===========================================================================
  // Unknown method handling (ported)
  // ===========================================================================

  describe('Unknown method handling', () => {

    it('should emit warning for unknown method in non-strict mode', async () => {
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
        file: 'client.js',
        line: 10,
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { strictMode: false }));

      assert.strictEqual(result.errors.length, 1);
      const error = result.errors[0];
      assert.strictEqual(error.code, 'WARN_HTTP_METHOD_UNKNOWN');
      assert.strictEqual(error.severity, 'warning');
      assert.strictEqual(graph.edges.filter(e => e.type === 'INTERACTS_WITH').length, 0);
    });

    it('should emit StrictModeError in strict mode', async () => {
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
        file: 'client.js',
        line: 10,
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph, { strictMode: true }));

      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0] instanceof StrictModeError);
      assert.strictEqual(graph.edges.filter(e => e.type === 'INTERACTS_WITH').length, 0);
    });
  });

  // ===========================================================================
  // Backward compatibility
  // ===========================================================================

  describe('Backward compatibility', () => {

    it('should work identically to HTTPConnectionEnricher when no routing/services configured', async () => {
      const graph = new MockGraphBackend();

      // No SERVICE nodes, no routing, no resources
      graph.addNode({
        id: 'route:get-users',
        type: 'http:route',
        method: 'GET',
        path: '/api/users',
        fullPath: '/api/users',
      });

      graph.addNode({
        id: 'request:fetch-users',
        type: 'http:request',
        method: 'GET',
        url: '/api/users',
      });

      const plugin = new ServiceConnectionEnricher();
      const result = await plugin.execute(createContext(graph));

      assert.ok(result.success);
      const edge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
      assert.ok(edge);
      assert.strictEqual(edge.src, 'request:fetch-users');
      assert.strictEqual(edge.dst, 'route:get-users');
      assert.strictEqual(edge.metadata.matchType, 'exact');
      assert.strictEqual(result.metadata.connections, 1);
    });
  });
});
