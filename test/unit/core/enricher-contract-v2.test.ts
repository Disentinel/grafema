/**
 * Tests for Enricher Contract v2 (RFD-2, REG-409).
 *
 * Validates:
 * - buildDependencyGraph() — converts consumes/produces metadata to ToposortItem[]
 * - Enricher metadata validation — all enrichment plugins declare consumes/produces
 * - Orchestrator integration — runPhase('ENRICHMENT') respects consumes/produces ordering
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildDependencyGraph, toposort } from '@grafema/core';
import type { EdgeType } from '@grafema/types';

// ============================================================
// 1. buildDependencyGraph() tests
// ============================================================

describe('buildDependencyGraph', () => {

  it('should return empty array for empty input', () => {
    const result = buildDependencyGraph([]);
    assert.deepStrictEqual(result, []);
  });

  it('should return item with no deps when plugin has no consumes/produces', () => {
    const result = buildDependencyGraph([
      {
        metadata: {
          name: 'LonePlugin',
        },
      },
    ]);
    assert.deepStrictEqual(result, [
      { id: 'LonePlugin', dependencies: [] },
    ]);
  });

  it('should create dependency when A produces CALLS and B consumes CALLS', () => {
    const result = buildDependencyGraph([
      {
        metadata: {
          name: 'Producer',
          produces: ['CALLS'] as EdgeType[],
        },
      },
      {
        metadata: {
          name: 'Consumer',
          consumes: ['CALLS'] as EdgeType[],
        },
      },
    ]);

    // Consumer should depend on Producer
    const consumerItem = result.find(item => item.id === 'Consumer');
    assert.ok(consumerItem, 'Consumer should be in result');
    assert.ok(
      consumerItem.dependencies.includes('Producer'),
      'Consumer should depend on Producer'
    );

    // Producer should have no deps (from consumes/produces logic)
    const producerItem = result.find(item => item.id === 'Producer');
    assert.ok(producerItem, 'Producer should be in result');
    assert.deepStrictEqual(producerItem.dependencies, []);
  });

  it('should exclude self-reference when plugin both consumes and produces same edge type', () => {
    const result = buildDependencyGraph([
      {
        metadata: {
          name: 'SelfRef',
          consumes: ['INSTANCE_OF'] as EdgeType[],
          produces: ['INSTANCE_OF'] as EdgeType[],
        },
      },
    ]);

    const item = result.find(r => r.id === 'SelfRef');
    assert.ok(item, 'SelfRef should be in result');
    // Must NOT have self-dependency
    assert.ok(
      !item.dependencies.includes('SelfRef'),
      'Should not have self-dependency'
    );
    assert.deepStrictEqual(item.dependencies, []);
  });

  it('should handle multiple producers for same edge type', () => {
    const result = buildDependencyGraph([
      {
        metadata: {
          name: 'ProducerA',
          produces: ['CALLS'] as EdgeType[],
        },
      },
      {
        metadata: {
          name: 'ProducerB',
          produces: ['CALLS'] as EdgeType[],
        },
      },
      {
        metadata: {
          name: 'Consumer',
          consumes: ['CALLS'] as EdgeType[],
        },
      },
    ]);

    const consumerItem = result.find(item => item.id === 'Consumer');
    assert.ok(consumerItem, 'Consumer should be in result');
    assert.ok(
      consumerItem.dependencies.includes('ProducerA'),
      'Consumer should depend on ProducerA'
    );
    assert.ok(
      consumerItem.dependencies.includes('ProducerB'),
      'Consumer should depend on ProducerB'
    );
  });

  it('should merge explicit deps with consumes/produces deps', () => {
    const result = buildDependencyGraph([
      {
        metadata: {
          name: 'ProducerA',
          produces: ['CALLS'] as EdgeType[],
        },
      },
      {
        metadata: {
          name: 'Consumer',
          consumes: ['CALLS'] as EdgeType[],
          dependencies: ['External'],
        },
      },
    ]);

    const consumerItem = result.find(item => item.id === 'Consumer');
    assert.ok(consumerItem, 'Consumer should be in result');
    // Should have both the inferred dep (ProducerA) and explicit dep (External)
    assert.ok(
      consumerItem.dependencies.includes('ProducerA'),
      'Consumer should depend on ProducerA (inferred from consumes/produces)'
    );
    assert.ok(
      consumerItem.dependencies.includes('External'),
      'Consumer should depend on External (explicit dependency)'
    );
  });

  it('should use only explicit deps when consumes/produces are undefined (V1-style)', () => {
    const result = buildDependencyGraph([
      {
        metadata: {
          name: 'V1Plugin',
          dependencies: ['JSASTAnalyzer', 'ImportExportLinker'],
        },
      },
    ]);

    const item = result.find(r => r.id === 'V1Plugin');
    assert.ok(item, 'V1Plugin should be in result');
    assert.deepStrictEqual(
      item.dependencies.sort(),
      ['ImportExportLinker', 'JSASTAnalyzer'],
      'Should preserve explicit dependencies for V1-style plugins'
    );
  });

  it('should integrate with toposort: 3 plugins in chain via consumes/produces', () => {
    const graph = buildDependencyGraph([
      {
        metadata: {
          name: 'Linker',
          produces: ['IMPORTS_FROM'] as EdgeType[],
        },
      },
      {
        metadata: {
          name: 'Resolver',
          consumes: ['IMPORTS_FROM'] as EdgeType[],
          produces: ['CALLS'] as EdgeType[],
        },
      },
      {
        metadata: {
          name: 'Tracker',
          consumes: ['CALLS'] as EdgeType[],
        },
      },
    ]);

    const order = toposort(graph);

    assert.ok(
      order.indexOf('Linker') < order.indexOf('Resolver'),
      'Linker should come before Resolver'
    );
    assert.ok(
      order.indexOf('Resolver') < order.indexOf('Tracker'),
      'Resolver should come before Tracker'
    );
  });

  it('should produce correct ordering for real enricher set with consumes/produces', () => {
    // Mock the enrichers with their actual consumes/produces/dependencies.
    // Matches the real metadata declared in each enricher class.
    const graph = buildDependencyGraph([
      {
        metadata: {
          name: 'ImportExportLinker',
          consumes: [] as EdgeType[],
          produces: ['IMPORTS', 'IMPORTS_FROM'] as EdgeType[],
          dependencies: ['JSASTAnalyzer'],
        },
      },
      {
        metadata: {
          name: 'FunctionCallResolver',
          consumes: ['IMPORTS_FROM'] as EdgeType[],
          produces: ['CALLS'] as EdgeType[],
          dependencies: ['ImportExportLinker'],
        },
      },
      {
        metadata: {
          name: 'MethodCallResolver',
          consumes: ['CONTAINS', 'INSTANCE_OF', 'DERIVES_FROM'] as EdgeType[],
          produces: ['CALLS'] as EdgeType[],
          dependencies: ['ImportExportLinker'],
        },
      },
      {
        metadata: {
          name: 'CallbackCallResolver',
          consumes: ['PASSES_ARGUMENT', 'IMPORTS_FROM'] as EdgeType[],
          produces: ['CALLS'] as EdgeType[],
          dependencies: ['ImportExportLinker', 'FunctionCallResolver'],
        },
      },
      {
        metadata: {
          name: 'ExternalCallResolver',
          consumes: ['CALLS'] as EdgeType[],
          produces: ['CALLS'] as EdgeType[],
          dependencies: ['FunctionCallResolver'],
        },
      },
      {
        metadata: {
          name: 'AliasTracker',
          consumes: ['ASSIGNED_FROM', 'CONTAINS', 'INSTANCE_OF'] as EdgeType[],
          produces: ['CALLS', 'ALIAS_OF'] as EdgeType[],
          dependencies: ['MethodCallResolver'],
        },
      },
      {
        metadata: {
          name: 'ValueDomainAnalyzer',
          consumes: ['ASSIGNED_FROM', 'FLOWS_INTO', 'CONTAINS'] as EdgeType[],
          produces: ['CALLS', 'FLOWS_INTO'] as EdgeType[],
          dependencies: ['AliasTracker'],
        },
      },
      {
        metadata: {
          name: 'ArgumentParameterLinker',
          consumes: ['PASSES_ARGUMENT', 'CALLS', 'HAS_PARAMETER', 'RECEIVES_ARGUMENT'] as EdgeType[],
          produces: ['RECEIVES_ARGUMENT'] as EdgeType[],
          dependencies: ['JSASTAnalyzer', 'MethodCallResolver'],
        },
      },
      {
        metadata: {
          name: 'InstanceOfResolver',
          consumes: ['INSTANCE_OF'] as EdgeType[],
          produces: ['INSTANCE_OF'] as EdgeType[],
          dependencies: ['JSASTAnalyzer'],
        },
      },
      {
        metadata: {
          name: 'ClosureCaptureEnricher',
          consumes: [] as EdgeType[],
          produces: ['CAPTURES'] as EdgeType[],
          dependencies: ['JSASTAnalyzer'],
        },
      },
      {
        metadata: {
          name: 'MountPointResolver',
          consumes: [] as EdgeType[],
          produces: [] as EdgeType[],
          dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'ExpressRouteAnalyzer'],
        },
      },
      {
        metadata: {
          name: 'PrefixEvaluator',
          consumes: ['DEFINES'] as EdgeType[],
          produces: [] as EdgeType[],
          dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'MountPointResolver'],
        },
      },
      {
        metadata: {
          name: 'NodejsBuiltinsResolver',
          consumes: ['IMPORTS_FROM'] as EdgeType[],
          produces: ['CALLS', 'IMPORTS_FROM'] as EdgeType[],
          dependencies: ['JSASTAnalyzer', 'ImportExportLinker'],
        },
      },
      {
        metadata: {
          name: 'HTTPConnectionEnricher',
          consumes: ['RESPONDS_WITH'] as EdgeType[],
          produces: ['INTERACTS_WITH', 'HTTP_RECEIVES'] as EdgeType[],
          dependencies: ['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer'],
        },
      },
    ]);

    const order = toposort(graph);

    // Verify the key ordering constraints:
    assert.ok(
      order.indexOf('ImportExportLinker') < order.indexOf('FunctionCallResolver'),
      'ImportExportLinker before FunctionCallResolver'
    );
    assert.ok(
      order.indexOf('FunctionCallResolver') < order.indexOf('CallbackCallResolver'),
      'FunctionCallResolver before CallbackCallResolver'
    );
    assert.ok(
      order.indexOf('MethodCallResolver') < order.indexOf('AliasTracker'),
      'MethodCallResolver before AliasTracker'
    );
    assert.ok(
      order.indexOf('AliasTracker') < order.indexOf('ValueDomainAnalyzer'),
      'AliasTracker before ValueDomainAnalyzer'
    );

    // Additional constraints implied by consumes/produces:
    assert.ok(
      order.indexOf('ImportExportLinker') < order.indexOf('MethodCallResolver'),
      'ImportExportLinker before MethodCallResolver'
    );
    assert.ok(
      order.indexOf('ImportExportLinker') < order.indexOf('NodejsBuiltinsResolver'),
      'ImportExportLinker before NodejsBuiltinsResolver'
    );
    assert.ok(
      order.indexOf('MountPointResolver') < order.indexOf('PrefixEvaluator'),
      'MountPointResolver before PrefixEvaluator'
    );
  });

});


// ============================================================
// 2. Enricher metadata validation tests
// ============================================================

describe('Enricher metadata validation', () => {

  // Dynamically import all enrichment plugins so the test
  // stays accurate as plugins are added or removed.
  async function getEnrichmentPlugins() {
    const {
      ImportExportLinker,
      FunctionCallResolver,
      MethodCallResolver,
      AliasTracker,
      ValueDomainAnalyzer,
      ExternalCallResolver,
      CallbackCallResolver,
      ArgumentParameterLinker,
      MountPointResolver,
      PrefixEvaluator,
      InstanceOfResolver,
      ClosureCaptureEnricher,
      HTTPConnectionEnricher,
      NodejsBuiltinsResolver,
      RustFFIEnricher,
      RejectionPropagationEnricher,
      ExpressHandlerLinker,
    } = await import('@grafema/core');

    return [
      new ImportExportLinker(),
      new FunctionCallResolver(),
      new MethodCallResolver(),
      new AliasTracker(),
      new ValueDomainAnalyzer(),
      new ExternalCallResolver(),
      new CallbackCallResolver(),
      new ArgumentParameterLinker(),
      new MountPointResolver(),
      new PrefixEvaluator(),
      new InstanceOfResolver(),
      new ClosureCaptureEnricher(),
      new HTTPConnectionEnricher(),
      new NodejsBuiltinsResolver(),
      new RustFFIEnricher(),
      new RejectionPropagationEnricher(),
      new ExpressHandlerLinker(),
    ];
  }

  it('all ENRICHMENT-phase plugins should have consumes array', async () => {
    const plugins = await getEnrichmentPlugins();
    for (const plugin of plugins) {
      const meta = plugin.metadata;
      assert.strictEqual(meta.phase, 'ENRICHMENT', `${meta.name} should be ENRICHMENT phase`);
      assert.ok(
        Array.isArray((meta as any).consumes),
        `${meta.name} must declare consumes: EdgeType[] (got ${typeof (meta as any).consumes})`
      );
    }
  });

  it('all ENRICHMENT-phase plugins should have produces array', async () => {
    const plugins = await getEnrichmentPlugins();
    for (const plugin of plugins) {
      const meta = plugin.metadata;
      assert.ok(
        Array.isArray((meta as any).produces),
        `${meta.name} must declare produces: EdgeType[] (got ${typeof (meta as any).produces})`
      );
    }
  });

  it('produces arrays should match creates.edges where both exist', async () => {
    const plugins = await getEnrichmentPlugins();
    for (const plugin of plugins) {
      const meta = plugin.metadata;
      const produces = (meta as any).produces as EdgeType[] | undefined;
      const createsEdges = meta.creates?.edges;

      if (produces && createsEdges && createsEdges.length > 0) {
        // Every edge in creates.edges should also be in produces
        for (const edge of createsEdges) {
          assert.ok(
            produces.includes(edge),
            `${meta.name}: creates.edges includes '${edge}' but produces does not. ` +
            `produces=${JSON.stringify(produces)}, creates.edges=${JSON.stringify(createsEdges)}`
          );
        }
      }
    }
  });

  it('dependency graph from real enrichers should have no cycles', async () => {
    const plugins = await getEnrichmentPlugins();

    const graph = buildDependencyGraph(
      plugins.map(p => ({
        metadata: {
          name: p.metadata.name,
          consumes: (p.metadata as any).consumes,
          produces: (p.metadata as any).produces,
          dependencies: p.metadata.dependencies,
        },
      }))
    );

    // toposort throws CycleError if cycles exist
    assert.doesNotThrow(
      () => toposort(graph),
      'Enricher dependency graph should be acyclic'
    );

    // Also verify we get all plugins in the result
    const order = toposort(graph);
    assert.strictEqual(
      order.length,
      plugins.length,
      'Sorted order should include all enrichment plugins'
    );
  });

});


// ============================================================
// 3. Orchestrator integration tests
// ============================================================

describe('Orchestrator ENRICHMENT phase with consumes/produces', () => {

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

  // Shared execution log across all plugins in a test
  function createV2PluginSet() {
    const executionOrder: string[] = [];

    function makePlugin(name: string, opts: {
      consumes?: EdgeType[];
      produces?: EdgeType[];
      dependencies?: string[];
    } = {}) {
      return {
        config: {},
        get metadata() {
          return {
            name,
            phase: 'ENRICHMENT' as const,
            consumes: opts.consumes,
            produces: opts.produces,
            dependencies: opts.dependencies,
          };
        },
        async execute() {
          executionOrder.push(name);
          return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
        },
      };
    }

    return { executionOrder, makePlugin };
  }

  // A fake discovery plugin to prevent Orchestrator from auto-adding SimpleProjectDiscovery
  function createFakeDiscoveryPlugin() {
    return {
      config: {},
      get metadata() {
        return { name: 'FakeDiscovery', phase: 'DISCOVERY' as const };
      },
      async execute() {
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    };
  }

  it('should order V2 enrichers by consumes/produces during ENRICHMENT phase', async () => {
    const mock = createMockGraph();
    const { executionOrder, makePlugin } = createV2PluginSet();

    // Linker produces IMPORTS_FROM, Resolver consumes it and produces CALLS,
    // Tracker consumes CALLS. Expected order: Linker -> Resolver -> Tracker
    const linker = makePlugin('Linker', {
      produces: ['IMPORTS_FROM'] as EdgeType[],
    });
    const tracker = makePlugin('Tracker', {
      consumes: ['CALLS'] as EdgeType[],
    });
    const resolver = makePlugin('Resolver', {
      consumes: ['IMPORTS_FROM'] as EdgeType[],
      produces: ['CALLS'] as EdgeType[],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        createFakeDiscoveryPlugin() as any,
        // Register in WRONG order to verify toposort corrects it
        tracker as any,
        resolver as any,
        linker as any,
      ],
      logLevel: 'silent',
    });

    // Run just the ENRICHMENT phase
    await (orchestrator as any).runPhase('ENRICHMENT', {
      manifest: { services: [], entrypoints: [], projectPath: '/test' },
      graph: mock.backend,
      workerCount: 1,
    });

    // Verify execution order respects consumes/produces
    assert.ok(
      executionOrder.indexOf('Linker') < executionOrder.indexOf('Resolver'),
      `Linker should run before Resolver. Actual order: ${executionOrder.join(' -> ')}`
    );
    assert.ok(
      executionOrder.indexOf('Resolver') < executionOrder.indexOf('Tracker'),
      `Resolver should run before Tracker. Actual order: ${executionOrder.join(' -> ')}`
    );
  });

  it('should still work with V1-style enrichers (no consumes/produces)', async () => {
    const mock = createMockGraph();
    const { executionOrder, makePlugin } = createV2PluginSet();

    // V1-style: only explicit dependencies, no consumes/produces
    const pluginA = makePlugin('PluginA', {
      dependencies: [],
    });
    const pluginB = makePlugin('PluginB', {
      dependencies: ['PluginA'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        createFakeDiscoveryPlugin() as any,
        pluginB as any,
        pluginA as any,
      ],
      logLevel: 'silent',
    });

    await (orchestrator as any).runPhase('ENRICHMENT', {
      manifest: { services: [], entrypoints: [], projectPath: '/test' },
      graph: mock.backend,
      workerCount: 1,
    });

    assert.ok(
      executionOrder.indexOf('PluginA') < executionOrder.indexOf('PluginB'),
      `PluginA should run before PluginB (explicit deps). Actual order: ${executionOrder.join(' -> ')}`
    );
  });

});
