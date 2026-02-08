/**
 * HTTPConnectionEnricher unknown method alarm tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { HTTPConnectionEnricher, StrictModeError } from '@grafema/core';

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

  async getOutgoingEdges() {
    return [];
  }
}

describe('HTTPConnectionEnricher unknown method alarms', () => {
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

    const plugin = new HTTPConnectionEnricher();
    const result = await plugin.execute({ graph, strictMode: false });

    assert.strictEqual(result.errors.length, 1, 'Should emit one warning');
    const error = result.errors[0];
    const code = (error && typeof error === 'object') ? error.code : undefined;
    const severity = (error && typeof error === 'object') ? error.severity : undefined;

    assert.strictEqual(code, 'WARN_HTTP_METHOD_UNKNOWN');
    assert.strictEqual(severity, 'warning');
    assert.strictEqual(graph.edges.length, 0, 'Should not create edges for unknown method');
  });

  it('should fail in strict mode for unknown method', async () => {
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

    const plugin = new HTTPConnectionEnricher();
    const result = await plugin.execute({ graph, strictMode: true });

    assert.strictEqual(result.errors.length, 1, 'Should emit one strict error');
    assert.ok(result.errors[0] instanceof StrictModeError, 'Should emit StrictModeError');
    assert.strictEqual(graph.edges.length, 0, 'Should not create edges for unknown method');
  });
});
