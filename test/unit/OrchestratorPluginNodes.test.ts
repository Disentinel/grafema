/**
 * Orchestrator plugin node registration - REG-386
 *
 * Verifies that the Orchestrator creates grafema:plugin nodes
 * for all loaded plugins before analysis begins.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

function createMockGraph() {
  const addedNodes: any[] = [];
  const addedEdges: any[] = [];
  return {
    nodes: addedNodes,
    edges: addedEdges,
    backend: {
      addNode: async (n: any) => { addedNodes.push(n); },
      addEdge: async (e: any) => { addedEdges.push(e); },
      addNodes: async () => {},
      addEdges: async () => {},
      getNode: async () => null,
      queryNodes: async function* () {},
      getAllNodes: async () => [],
      getOutgoingEdges: async () => [],
      getIncomingEdges: async () => [],
      nodeCount: async () => 0,
      edgeCount: async () => 0,
      countNodesByType: async () => ({}),
      countEdgesByType: async () => ({}),
      clear: async () => {},
    },
  };
}

function createTestPlugin(name: string, phase: string, opts: {
  priority?: number;
  creates?: { nodes?: string[]; edges?: string[] };
  dependencies?: string[];
  sourceFile?: string;
} = {}) {
  const config: Record<string, unknown> = {};
  if (opts.sourceFile) {
    config.sourceFile = opts.sourceFile;
  }
  return {
    config,
    get metadata() {
      return {
        name,
        phase,
        priority: opts.priority ?? 0,
        creates: opts.creates,
        dependencies: opts.dependencies,
      };
    },
    async execute() {
      return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
    },
  };
}

// A fake discovery plugin to prevent Orchestrator from auto-adding SimpleProjectDiscovery
function createFakeDiscoveryPlugin() {
  return createTestPlugin('FakeDiscovery', 'DISCOVERY');
}

describe('Orchestrator.registerPluginNodes', () => {
  it('should create grafema:plugin nodes for each plugin', async () => {
    const mock = createMockGraph();

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        createFakeDiscoveryPlugin() as any,
        createTestPlugin('TestAnalyzer', 'ANALYSIS', {
          priority: 80,
          creates: { nodes: ['FUNCTION'], edges: ['CALLS'] },
        }) as any,
        createTestPlugin('TestEnricher', 'ENRICHMENT', {
          priority: 50,
          creates: { edges: ['INTERACTS_WITH'] },
          dependencies: ['TestAnalyzer'],
        }) as any,
      ],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    const pluginNodes = mock.nodes.filter((n: any) => n.type === 'grafema:plugin');
    assert.strictEqual(pluginNodes.length, 3); // FakeDiscovery + TestAnalyzer + TestEnricher

    const analyzerNode = pluginNodes.find((n: any) => n.name === 'TestAnalyzer');
    assert.ok(analyzerNode);
    assert.strictEqual(analyzerNode.id, 'grafema:plugin#TestAnalyzer');
    assert.strictEqual(analyzerNode.phase, 'ANALYSIS');
    assert.strictEqual(analyzerNode.priority, 80);
    assert.deepStrictEqual(analyzerNode.createsNodes, ['FUNCTION']);

    const enricherNode = pluginNodes.find((n: any) => n.name === 'TestEnricher');
    assert.ok(enricherNode);
    assert.strictEqual(enricherNode.id, 'grafema:plugin#TestEnricher');
    assert.strictEqual(enricherNode.phase, 'ENRICHMENT');

    // Verify DEPENDS_ON edge
    const dependsOnEdges = mock.edges.filter((e: any) =>
      e.type === 'DEPENDS_ON' &&
      e.src === 'grafema:plugin#TestEnricher' &&
      e.dst === 'grafema:plugin#TestAnalyzer'
    );
    assert.strictEqual(dependsOnEdges.length, 1);
  });

  it('should handle plugins with no dependencies gracefully', async () => {
    const mock = createMockGraph();

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        createFakeDiscoveryPlugin() as any,
        createTestPlugin('LonePlugin', 'VALIDATION', { priority: 10 }) as any,
      ],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    const pluginNodes = mock.nodes.filter((n: any) => n.type === 'grafema:plugin');
    assert.strictEqual(pluginNodes.length, 2); // FakeDiscovery + LonePlugin
    assert.strictEqual(mock.edges.length, 0);

    const lonePlugin = pluginNodes.find((n: any) => n.name === 'LonePlugin');
    assert.ok(lonePlugin);
    assert.deepStrictEqual(lonePlugin.dependencies, []);
  });

  it('should skip dependency edges when target plugin is not loaded', async () => {
    const mock = createMockGraph();

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        createFakeDiscoveryPlugin() as any,
        createTestPlugin('Orphan', 'ENRICHMENT', {
          dependencies: ['NonexistentPlugin'],
        }) as any,
      ],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    // No edges for NonexistentPlugin, only FakeDiscovery has no deps either
    assert.strictEqual(mock.edges.length, 0);
  });

  it('should mark custom plugins as non-builtin', async () => {
    const mock = createMockGraph();

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        createFakeDiscoveryPlugin() as any,
        createTestPlugin('Custom', 'ANALYSIS', {
          sourceFile: '/project/.grafema/plugins/Custom.js',
        }) as any,
      ],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    const customNode = mock.nodes.find((n: any) => n.name === 'Custom');
    assert.ok(customNode);
    assert.strictEqual(customNode.builtin, false);
    assert.strictEqual(customNode.file, '/project/.grafema/plugins/Custom.js');
  });

  it('should mark builtin plugins correctly', async () => {
    const mock = createMockGraph();

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        createFakeDiscoveryPlugin() as any,
        createTestPlugin('BuiltinAnalyzer', 'ANALYSIS') as any,
      ],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    const builtinNode = mock.nodes.find((n: any) => n.name === 'BuiltinAnalyzer');
    assert.ok(builtinNode);
    assert.strictEqual(builtinNode.builtin, true);
    assert.strictEqual(builtinNode.file, '');
  });

  it('should skip plugins without metadata name', async () => {
    const mock = createMockGraph();

    const pluginWithoutName = {
      config: {},
      get metadata() {
        return { name: '', phase: 'ANALYSIS' };
      },
      async execute() {
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        createFakeDiscoveryPlugin() as any,
        pluginWithoutName as any,
      ],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    // Only FakeDiscovery should be registered, the nameless one is skipped
    const pluginNodes = mock.nodes.filter((n: any) => n.type === 'grafema:plugin');
    assert.strictEqual(pluginNodes.length, 1);
    assert.strictEqual(pluginNodes[0].name, 'FakeDiscovery');
  });
});
