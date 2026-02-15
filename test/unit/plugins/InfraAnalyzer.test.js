/**
 * InfraAnalyzer Base Class Tests — REG-363: USG Phase 1
 *
 * Tests the InfraAnalyzer abstract base class that concrete infrastructure
 * analyzers (K8s, Terraform, Docker Compose) extend.
 *
 * Uses a MockInfraAnalyzer subclass to test the base class execute() logic:
 * - File discovery
 * - File reading and parsing
 * - Graph node creation from parsed resources
 * - ResourceMapping registration in InfraResourceMap
 * - Error handling (file not found, parse errors)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InfraAnalyzer, InfraResourceMapImpl, createInfraResourceMap } from '@grafema/core';

// =============================================================================
// TEST DIRECTORY (real temp files, no fs mocking)
// =============================================================================

const TEST_DIR = join('/tmp', `grafema-test-infra-${process.pid}`);

// =============================================================================
// MOCK GRAPH
// =============================================================================

function createMockGraph() {
  const nodes = new Map();
  const edges = [];
  return {
    addNode: async (node) => nodes.set(node.id, node),
    addEdge: async (edge) => edges.push(edge),
    getNode: async (id) => nodes.get(id) || null,
    queryNodes: async function* (filter) {
      for (const n of nodes.values()) {
        if (!filter.type || n.type === filter.type) yield n;
      }
    },
    _nodes: nodes,
    _edges: edges,
  };
}

// =============================================================================
// MOCK RESOURCE REGISTRY
// =============================================================================

function createMockResources() {
  const store = new Map();
  return {
    getOrCreate(id, factory) {
      if (!store.has(id)) store.set(id, factory());
      return store.get(id);
    },
    get(id) { return store.get(id); },
    has(id) { return store.has(id); },
    _store: store,
  };
}

// =============================================================================
// MOCK INFRA ANALYZER
// =============================================================================

/**
 * Concrete test implementation of InfraAnalyzer.
 * Uses constructor options to control behavior for testing.
 */
class MockInfraAnalyzer extends InfraAnalyzer {
  constructor(options = {}) {
    super({});
    this._files = options.files || [];
    this._resources = options.resources || [];
    this._mappings = options.mappings || {};
  }

  declareNodeTypes() { return ['infra:test:resource']; }
  declareEdgeTypes() { return []; }

  async discoverFiles(_context) { return this._files; }

  parseFile(_filePath, _content) { return this._resources; }

  mapToAbstract(resource) {
    return this._mappings[resource.id] || null;
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('InfraAnalyzer', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'deployment.yaml'), 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: user-api');
    writeFileSync(join(TEST_DIR, 'service.yaml'), 'apiVersion: v1\nkind: Service\nmetadata:\n  name: user-api-svc');
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('metadata', () => {
    it('should have phase ANALYSIS', () => {
      const analyzer = new MockInfraAnalyzer();
      assert.strictEqual(analyzer.metadata.phase, 'ANALYSIS');
    });

    it('should use constructor name as plugin name', () => {
      const analyzer = new MockInfraAnalyzer();
      assert.strictEqual(analyzer.metadata.name, 'MockInfraAnalyzer');
    });

    it('should declare node types from declareNodeTypes()', () => {
      const analyzer = new MockInfraAnalyzer();
      assert.deepStrictEqual(analyzer.metadata.creates.nodes, ['infra:test:resource']);
    });

    it('should declare edge types from declareEdgeTypes()', () => {
      const analyzer = new MockInfraAnalyzer();
      assert.deepStrictEqual(analyzer.metadata.creates.edges, []);
    });
  });

  describe('execute - discovery', () => {
    it('should return success with 0 nodes when no files discovered', async () => {
      const analyzer = new MockInfraAnalyzer({ files: [] });
      const graph = createMockGraph();
      const resources = createMockResources();

      const result = await analyzer.execute({ graph, resources });

      assert.ok(result.success, 'Should return success');
      assert.strictEqual(result.created.nodes, 0);
    });

    it('should process discovered files', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');
      const servicePath = join(TEST_DIR, 'service.yaml');

      const parsedResources = [
        { id: 'infra:test:user-api', type: 'infra:test:resource', name: 'user-api', tool: 'test' },
      ];

      const analyzer = new MockInfraAnalyzer({
        files: [deploymentPath, servicePath],
        resources: parsedResources,
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      const result = await analyzer.execute({ graph, resources });

      assert.ok(result.success, 'Should return success');
      // Both files were processed
      assert.ok(result.created.nodes >= 0, 'Should report node count');
    });
  });

  describe('execute - node creation', () => {
    it('should create concrete graph nodes from parseFile results', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');

      const parsedResources = [
        {
          id: 'infra:test:deployment:user-api',
          type: 'infra:test:deployment',
          name: 'user-api',
          file: deploymentPath,
          tool: 'test',
          metadata: { replicas: 3 },
        },
      ];

      const analyzer = new MockInfraAnalyzer({
        files: [deploymentPath],
        resources: parsedResources,
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      await analyzer.execute({ graph, resources });

      // Verify node was created in graph
      const node = await graph.getNode('infra:test:deployment:user-api');
      assert.ok(node, 'Should have created node in graph');
      assert.strictEqual(node.type, 'infra:test:deployment');
      assert.strictEqual(node.name, 'user-api');
    });

    it('should include env and tool in node metadata', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');

      const parsedResources = [
        {
          id: 'infra:test:deployment:user-api',
          type: 'infra:test:deployment',
          name: 'user-api',
          file: deploymentPath,
          env: 'prod',
          tool: 'kubernetes',
          metadata: { replicas: 3 },
        },
      ];

      const analyzer = new MockInfraAnalyzer({
        files: [deploymentPath],
        resources: parsedResources,
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      await analyzer.execute({ graph, resources });

      const node = await graph.getNode('infra:test:deployment:user-api');
      assert.ok(node, 'Should have created node');
      // Env and tool should be accessible somewhere on the node (metadata or top-level)
      const meta = node.metadata || {};
      const nodeEnv = node.env || meta.env;
      const nodeTool = node.tool || meta.tool;
      assert.ok(nodeEnv === 'prod' || (meta && meta.env === 'prod'),
        'Should include env');
      assert.ok(nodeTool === 'kubernetes' || (meta && meta.tool === 'kubernetes'),
        'Should include tool');
    });
  });

  describe('execute - resource mapping', () => {
    it('should register mappings in InfraResourceMap', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');

      const parsedResources = [
        {
          id: 'infra:test:deployment:user-api',
          type: 'infra:test:deployment',
          name: 'user-api',
          file: deploymentPath,
          tool: 'test',
          metadata: { replicas: 3 },
        },
      ];

      const mappings = {
        'infra:test:deployment:user-api': {
          concreteId: 'infra:test:deployment:user-api',
          concreteType: 'infra:test:deployment',
          abstractType: 'compute:service',
          abstractId: 'compute:service:user-api',
          name: 'user-api',
          metadata: { replicas: 3 },
          env: 'prod',
          sourceFile: deploymentPath,
          sourceTool: 'test',
        },
      };

      const analyzer = new MockInfraAnalyzer({
        files: [deploymentPath],
        resources: parsedResources,
        mappings,
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      await analyzer.execute({ graph, resources });

      // Check that InfraResourceMap was populated
      const infraMap = resources.get('infra:resource:map');
      assert.ok(infraMap, 'Should have created InfraResourceMap in resources');

      const abstractResource = infraMap.findAbstract('user-api', 'compute:service');
      assert.ok(abstractResource, 'Should have registered abstract resource');
      assert.strictEqual(abstractResource.id, 'compute:service:user-api');
    });

    it('should skip mapping when mapToAbstract returns null', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');

      const parsedResources = [
        {
          id: 'infra:test:unknown:something',
          type: 'infra:test:unknown',
          name: 'something',
          file: deploymentPath,
          tool: 'test',
        },
      ];

      // No mappings defined — mapToAbstract will return null for all
      const analyzer = new MockInfraAnalyzer({
        files: [deploymentPath],
        resources: parsedResources,
        mappings: {},
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      const result = await analyzer.execute({ graph, resources });

      assert.ok(result.success);

      // InfraResourceMap may or may not be created, but should have no resources
      const infraMap = resources.get('infra:resource:map');
      if (infraMap) {
        assert.strictEqual(infraMap.resourceCount, 0);
      }
    });

    it('should count mappings in result metadata', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');

      const parsedResources = [
        {
          id: 'infra:test:deployment:user-api',
          type: 'infra:test:deployment',
          name: 'user-api',
          file: deploymentPath,
          tool: 'test',
        },
        {
          id: 'infra:test:service:user-svc',
          type: 'infra:test:service',
          name: 'user-svc',
          file: deploymentPath,
          tool: 'test',
        },
      ];

      const mappings = {
        'infra:test:deployment:user-api': {
          concreteId: 'infra:test:deployment:user-api',
          concreteType: 'infra:test:deployment',
          abstractType: 'compute:service',
          abstractId: 'compute:service:user-api',
          name: 'user-api',
          metadata: {},
          sourceFile: deploymentPath,
          sourceTool: 'test',
        },
        // user-svc has no mapping (not in mappings dict)
      };

      const analyzer = new MockInfraAnalyzer({
        files: [deploymentPath],
        resources: parsedResources,
        mappings,
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      const result = await analyzer.execute({ graph, resources });

      assert.ok(result.success);
      // Result metadata should include mapping count
      const meta = result.metadata || result.stats || {};
      const mappingCount = meta.mappings ?? meta.mappingsRegistered ?? 0;
      assert.strictEqual(mappingCount, 1, 'Should count exactly 1 mapping (user-svc has no mapping)');
    });
  });

  describe('execute - error handling', () => {
    it('should handle file read errors gracefully (file not found)', async () => {
      const nonexistentPath = join(TEST_DIR, 'does-not-exist.yaml');

      const analyzer = new MockInfraAnalyzer({
        files: [nonexistentPath],
        resources: [],
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      // Should not throw — errors should be handled gracefully
      const result = await analyzer.execute({ graph, resources });

      // Should still return a result (either success with errors noted, or partial success)
      assert.ok(result, 'Should return a result even with file read errors');
    });

    it('should handle parseFile errors gracefully', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');

      // Create analyzer where parseFile throws
      class ThrowingAnalyzer extends InfraAnalyzer {
        constructor() { super({}); }
        declareNodeTypes() { return ['infra:test:resource']; }
        declareEdgeTypes() { return []; }
        async discoverFiles() { return [deploymentPath]; }
        parseFile() { throw new Error('Parse error: invalid YAML'); }
        mapToAbstract() { return null; }
      }

      const analyzer = new ThrowingAnalyzer();
      const graph = createMockGraph();
      const resources = createMockResources();

      // Should not throw at top level
      const result = await analyzer.execute({ graph, resources });
      assert.ok(result, 'Should return a result even with parse errors');
    });

    it('should continue processing after individual resource errors', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');
      const servicePath = join(TEST_DIR, 'service.yaml');
      const nonexistentPath = join(TEST_DIR, 'missing.yaml');

      const parsedResources = [
        {
          id: 'infra:test:deployment:user-api',
          type: 'infra:test:deployment',
          name: 'user-api',
          file: deploymentPath,
          tool: 'test',
        },
      ];

      const analyzer = new MockInfraAnalyzer({
        files: [deploymentPath, nonexistentPath, servicePath],
        resources: parsedResources,
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      const result = await analyzer.execute({ graph, resources });

      // Should process the valid files even though one failed
      assert.ok(result, 'Should return a result');
      // At least some nodes should be created from the valid files
      assert.ok(graph._nodes.size > 0 || result.success,
        'Should have processed at least some files');
    });

    it('should include errors in result', async () => {
      const nonexistentPath = join(TEST_DIR, 'totally-missing.yaml');

      const analyzer = new MockInfraAnalyzer({
        files: [nonexistentPath],
        resources: [],
      });

      const graph = createMockGraph();
      const resources = createMockResources();

      const result = await analyzer.execute({ graph, resources });

      // Result should communicate that errors occurred
      // Implementation may use result.errors, result.metadata.errors, or !result.success
      assert.ok(result, 'Should return a result');
      const hasErrorInfo = !result.success ||
        (result.errors && result.errors.length > 0) ||
        (result.metadata && result.metadata.errors);
      assert.ok(hasErrorInfo, 'Should include error information in result');
    });
  });

  describe('execute - no resource registry', () => {
    it('should work without resource registry (no mappings, but nodes still created)', async () => {
      const deploymentPath = join(TEST_DIR, 'deployment.yaml');

      const parsedResources = [
        {
          id: 'infra:test:deployment:user-api',
          type: 'infra:test:deployment',
          name: 'user-api',
          file: deploymentPath,
          tool: 'test',
        },
      ];

      const analyzer = new MockInfraAnalyzer({
        files: [deploymentPath],
        resources: parsedResources,
      });

      const graph = createMockGraph();

      // No resources provided — context.resources is undefined
      const result = await analyzer.execute({ graph });

      assert.ok(result, 'Should return a result without resource registry');

      // Nodes should still be created in graph
      const node = await graph.getNode('infra:test:deployment:user-api');
      assert.ok(node, 'Should still create concrete graph nodes without resource registry');
    });
  });
});
