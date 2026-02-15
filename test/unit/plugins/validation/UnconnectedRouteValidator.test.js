/**
 * UnconnectedRouteValidator Tests (REG-256 Phase 6)
 *
 * Tests that UnconnectedRouteValidator creates ISSUE nodes for
 * customer-facing routes that have no INTERACTS_WITH incoming edges.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { UnconnectedRouteValidator } from '@grafema/core';

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

  async getIncomingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.dst !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function createMockReportIssue() {
  const issues = [];
  const reportIssue = async (issue) => {
    issues.push(issue);
    return `issue:connectivity#mock-${issues.length}`;
  };
  return { reportIssue, issues };
}

// =============================================================================
// TESTS
// =============================================================================

describe('UnconnectedRouteValidator', () => {

  it('should create issue for customer-facing route with no INTERACTS_WITH edges', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:get-users',
      type: 'http:route',
      method: 'GET',
      fullPath: '/users',
      customerFacing: true,
      file: 'routes.js',
      line: 10,
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    const result = await plugin.execute({ graph, reportIssue });

    assert.ok(result.success);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].category, 'connectivity');
    assert.strictEqual(issues[0].severity, 'warning');
    assert.ok(issues[0].message.includes('GET /users'));
    assert.strictEqual(result.metadata.issueCount, 1);
  });

  it('should NOT create issue for non-customer-facing routes', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:internal',
      type: 'http:route',
      method: 'GET',
      fullPath: '/internal/health',
      // No customerFacing flag
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    const result = await plugin.execute({ graph, reportIssue });

    assert.ok(result.success);
    assert.strictEqual(issues.length, 0);
    assert.strictEqual(result.metadata.issueCount, 0);
  });

  it('should NOT create issue for customer-facing route WITH INTERACTS_WITH edges', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:get-users',
      type: 'http:route',
      method: 'GET',
      fullPath: '/users',
      customerFacing: true,
    });

    // Simulate a frontend consumer
    await graph.addEdge({
      type: 'INTERACTS_WITH',
      src: 'request:fetch-users',
      dst: 'route:get-users',
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    const result = await plugin.execute({ graph, reportIssue });

    assert.ok(result.success);
    assert.strictEqual(issues.length, 0);
  });

  it('should include route method and path in issue message', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:post-items',
      type: 'http:route',
      method: 'POST',
      fullPath: '/api/items',
      customerFacing: true,
      file: 'routes.js',
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    await plugin.execute({ graph, reportIssue });

    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].message.includes('POST'));
    assert.ok(issues[0].message.includes('/api/items'));
  });

  it('should set issue category to "connectivity"', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:get-users',
      type: 'http:route',
      method: 'GET',
      fullPath: '/users',
      customerFacing: true,
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    await plugin.execute({ graph, reportIssue });

    assert.strictEqual(issues[0].category, 'connectivity');
  });

  it('should set issue severity to "warning"', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:get-users',
      type: 'http:route',
      method: 'GET',
      fullPath: '/users',
      customerFacing: true,
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    await plugin.execute({ graph, reportIssue });

    assert.strictEqual(issues[0].severity, 'warning');
  });

  it('should set targetNodeId for AFFECTS edge creation', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:get-users',
      type: 'http:route',
      method: 'GET',
      fullPath: '/users',
      customerFacing: true,
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    await plugin.execute({ graph, reportIssue });

    assert.strictEqual(issues[0].targetNodeId, 'route:get-users');
  });

  it('should handle routes without file/line gracefully', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:no-location',
      type: 'http:route',
      method: 'GET',
      fullPath: '/users',
      customerFacing: true,
      // no file, no line
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    const result = await plugin.execute({ graph, reportIssue });

    assert.ok(result.success);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].file, '');
    assert.strictEqual(issues[0].line, 0);
  });

  it('should count issues correctly in result metadata', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:a',
      type: 'http:route',
      method: 'GET',
      fullPath: '/a',
      customerFacing: true,
    });

    graph.addNode({
      id: 'route:b',
      type: 'http:route',
      method: 'POST',
      fullPath: '/b',
      customerFacing: true,
    });

    graph.addNode({
      id: 'route:c',
      type: 'http:route',
      method: 'GET',
      fullPath: '/c',
      // NOT customer-facing
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    const result = await plugin.execute({ graph, reportIssue });

    assert.ok(result.success);
    assert.strictEqual(issues.length, 2);
    assert.strictEqual(result.metadata.issueCount, 2);
  });

  it('should work when reportIssue is not available (no-op)', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:get-users',
      type: 'http:route',
      method: 'GET',
      fullPath: '/users',
      customerFacing: true,
    });

    const plugin = new UnconnectedRouteValidator();
    const result = await plugin.execute({ graph });

    assert.ok(result.success);
    assert.strictEqual(result.metadata.issueCount, 0);
  });

  it('should use fullPath over path in issue message', async () => {
    const graph = new MockGraphBackend();

    graph.addNode({
      id: 'route:mounted',
      type: 'http:route',
      method: 'GET',
      path: '/users',
      fullPath: '/api/users',
      customerFacing: true,
    });

    const { reportIssue, issues } = createMockReportIssue();
    const plugin = new UnconnectedRouteValidator();
    await plugin.execute({ graph, reportIssue });

    assert.ok(issues[0].message.includes('/api/users'));
  });
});
