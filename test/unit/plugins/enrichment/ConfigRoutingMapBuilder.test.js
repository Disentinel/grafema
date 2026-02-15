/**
 * ConfigRoutingMapBuilder Tests (REG-256 Phase 4)
 *
 * Tests that routing rules from config are loaded into the RoutingMap Resource.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ConfigRoutingMapBuilder,
  ResourceRegistryImpl,
  createRoutingMap,
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

// =============================================================================
// TESTS
// =============================================================================

describe('ConfigRoutingMapBuilder', () => {

  it('should load routing rules from config into RoutingMap resource', async () => {
    const graph = new MockGraphBackend();
    const resources = new ResourceRegistryImpl();

    const plugin = new ConfigRoutingMapBuilder();
    const result = await plugin.execute({
      graph,
      resources,
      config: {
        routing: [
          { from: 'frontend', to: 'backend', stripPrefix: '/api' },
        ],
      },
    });

    assert.ok(result.success);
    assert.strictEqual(result.metadata.rulesLoaded, 1);

    const routingMap = resources.get(ROUTING_MAP_RESOURCE_ID);
    assert.ok(routingMap, 'RoutingMap should be created');
    assert.strictEqual(routingMap.ruleCount, 1);
  });

  it('should return rulesLoaded=0 when no routing rules in config', async () => {
    const graph = new MockGraphBackend();
    const resources = new ResourceRegistryImpl();

    const plugin = new ConfigRoutingMapBuilder();
    const result = await plugin.execute({
      graph,
      resources,
      config: {
        routing: [],
      },
    });

    assert.ok(result.success);
    assert.strictEqual(result.metadata.rulesLoaded, 0);

    const routingMap = resources.get(ROUTING_MAP_RESOURCE_ID);
    assert.strictEqual(routingMap, undefined, 'RoutingMap should not be created for empty rules');
  });

  it('should return rulesLoaded=0 when config is undefined', async () => {
    const graph = new MockGraphBackend();
    const resources = new ResourceRegistryImpl();

    const plugin = new ConfigRoutingMapBuilder();
    const result = await plugin.execute({
      graph,
      resources,
      config: {},
    });

    assert.ok(result.success);
    assert.strictEqual(result.metadata.rulesLoaded, 0);
  });

  it('should skip gracefully when ResourceRegistry is not available', async () => {
    const graph = new MockGraphBackend();

    const plugin = new ConfigRoutingMapBuilder();
    const result = await plugin.execute({
      graph,
      config: {
        routing: [
          { from: 'frontend', to: 'backend', stripPrefix: '/api' },
        ],
      },
    });

    assert.ok(result.success);
    assert.strictEqual(result.metadata.rulesLoaded, 0);
  });

  it('should set source to "config" on rules without explicit source', async () => {
    const graph = new MockGraphBackend();
    const resources = new ResourceRegistryImpl();

    const plugin = new ConfigRoutingMapBuilder();
    await plugin.execute({
      graph,
      resources,
      config: {
        routing: [
          { from: 'frontend', to: 'backend', stripPrefix: '/api' },
        ],
      },
    });

    const routingMap = resources.get(ROUTING_MAP_RESOURCE_ID);
    const rules = routingMap.getAllRules();
    assert.strictEqual(rules[0].source, 'config');
  });

  it('should preserve existing source on rules that have one', async () => {
    const graph = new MockGraphBackend();
    const resources = new ResourceRegistryImpl();

    const plugin = new ConfigRoutingMapBuilder();
    await plugin.execute({
      graph,
      resources,
      config: {
        routing: [
          { from: 'frontend', to: 'backend', stripPrefix: '/api', source: 'nginx' },
        ],
      },
    });

    const routingMap = resources.get(ROUTING_MAP_RESOURCE_ID);
    const rules = routingMap.getAllRules();
    assert.strictEqual(rules[0].source, 'nginx');
  });

  it('should handle multiple routing rules', async () => {
    const graph = new MockGraphBackend();
    const resources = new ResourceRegistryImpl();

    const plugin = new ConfigRoutingMapBuilder();
    const result = await plugin.execute({
      graph,
      resources,
      config: {
        routing: [
          { from: 'frontend', to: 'backend', stripPrefix: '/api' },
          { from: 'frontend', to: 'auth-service', stripPrefix: '/auth' },
          { from: 'mobile', to: 'backend', stripPrefix: '/v2/api', addPrefix: '/api' },
        ],
      },
    });

    assert.ok(result.success);
    assert.strictEqual(result.metadata.rulesLoaded, 3);

    const routingMap = resources.get(ROUTING_MAP_RESOURCE_ID);
    assert.strictEqual(routingMap.ruleCount, 3);
  });

  it('should create RoutingMap resource if it does not exist', async () => {
    const graph = new MockGraphBackend();
    const resources = new ResourceRegistryImpl();

    assert.strictEqual(resources.has(ROUTING_MAP_RESOURCE_ID), false);

    const plugin = new ConfigRoutingMapBuilder();
    await plugin.execute({
      graph,
      resources,
      config: {
        routing: [
          { from: 'frontend', to: 'backend', stripPrefix: '/api' },
        ],
      },
    });

    assert.strictEqual(resources.has(ROUTING_MAP_RESOURCE_ID), true);
  });

  it('should add to existing RoutingMap resource if it already exists', async () => {
    const graph = new MockGraphBackend();
    const resources = new ResourceRegistryImpl();

    // Pre-create RoutingMap with a rule
    const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
    routingMap.addRule({ from: 'nginx', to: 'backend', stripPrefix: '/proxy' });
    assert.strictEqual(routingMap.ruleCount, 1);

    const plugin = new ConfigRoutingMapBuilder();
    await plugin.execute({
      graph,
      resources,
      config: {
        routing: [
          { from: 'frontend', to: 'backend', stripPrefix: '/api' },
        ],
      },
    });

    assert.strictEqual(routingMap.ruleCount, 2);
  });
});
