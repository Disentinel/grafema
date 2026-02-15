/**
 * Selective Enrichment tests (RFD-16, Phase 3)
 *
 * Tests delta-driven selective enrichment in PhaseRunner.runPhase():
 * - Level-0 enrichers (consumes: []) always run
 * - Level-1+ enrichers: check if ANY consumed types ∈ accumulatedTypes
 * - If no consumed types changed → SKIP the enricher
 * - Accumulates changedNodeTypes + changedEdgeTypes from each delta
 * - Only applies when batch is supported (graph has beginBatch/commitBatch)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { CommitDelta } from '@grafema/types';

/**
 * Create a delta object with defaults for all required fields.
 */
function makeDelta(overrides: Partial<CommitDelta> = {}): CommitDelta {
  return {
    changedFiles: [],
    nodesAdded: 0,
    nodesRemoved: 0,
    edgesAdded: 0,
    edgesRemoved: 0,
    changedNodeTypes: [],
    changedEdgeTypes: [],
    ...overrides,
  };
}

/**
 * Create a mock graph backend WITH batch support.
 * The `deltasByPlugin` map controls what CommitDelta each plugin's commitBatch returns.
 * Uses a `currentPlugin` tracker set by the plugin execute wrapper.
 */
function createDeltaMockGraph(deltasByPlugin: Record<string, CommitDelta>) {
  let currentPlugin = '';
  return {
    setCurrentPlugin: (name: string) => { currentPlugin = name; },
    backend: {
      addNode: async () => {},
      addEdge: async () => {},
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
      beginBatch: () => {},
      commitBatch: async (_tags?: string[]) => {
        return deltasByPlugin[currentPlugin] ?? makeDelta();
      },
      abortBatch: () => {},
    },
  };
}

/**
 * Create a mock graph backend WITHOUT batch methods.
 * Used to test fallback behavior (no selective enrichment).
 */
function createNoBatchMockGraph() {
  return {
    backend: {
      addNode: async () => {},
      addEdge: async () => {},
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

/**
 * Create a mock enrichment plugin that tracks execution and sets currentPlugin
 * on the mock graph so commitBatch returns the correct delta.
 */
function createEnrichmentPlugin(
  name: string,
  mockGraph: { setCurrentPlugin: (name: string) => void },
  opts: {
    consumes?: string[];
    produces?: string[];
    executeFn?: () => Promise<any>;
  } = {},
) {
  const calls: any[] = [];
  return {
    calls,
    plugin: {
      metadata: {
        name,
        phase: 'ENRICHMENT',
        creates: { nodes: [], edges: [] },
        consumes: opts.consumes ?? [],
        produces: opts.produces ?? [],
      },
      execute: async (ctx: any) => {
        // Set currentPlugin BEFORE execute completes, because commitBatch
        // is called AFTER execute by runPluginWithBatch.
        mockGraph.setCurrentPlugin(name);
        calls.push(ctx);
        if (opts.executeFn) return opts.executeFn();
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    },
  };
}

describe('Selective enrichment (RFD-16, Phase 3)', () => {

  it('Level-0 enricher always runs (consumes: [])', async () => {
    const mock = createDeltaMockGraph({
      'Level0Enricher': makeDelta({ changedNodeTypes: ['FUNCTION'] }),
    });

    const enricher = createEnrichmentPlugin('Level0Enricher', mock, {
      consumes: [],
      produces: ['FUNCTION'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [enricher.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(enricher.calls.length, 1, 'Level-0 enricher should always execute');
  });

  it('Level-1 enricher runs when consumed type is in delta', async () => {
    const mock = createDeltaMockGraph({
      'EnricherA': makeDelta({ changedEdgeTypes: ['CALLS'] }),
      'EnricherB': makeDelta(),
    });

    const enricherA = createEnrichmentPlugin('EnricherA', mock, {
      consumes: [],
      produces: ['CALLS'],
    });

    const enricherB = createEnrichmentPlugin('EnricherB', mock, {
      consumes: ['CALLS'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [enricherA.plugin as any, enricherB.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(enricherA.calls.length, 1, 'EnricherA (level-0) should execute');
    assert.strictEqual(enricherB.calls.length, 1,
      'EnricherB should execute because CALLS was in the delta from EnricherA');
  });

  it('Level-1 enricher SKIPPED when consumed type NOT in delta', async () => {
    const mock = createDeltaMockGraph({
      'EnricherA': makeDelta({ changedEdgeTypes: ['IMPORTS'] }),
      'EnricherB': makeDelta(),
    });

    const enricherA = createEnrichmentPlugin('EnricherA', mock, {
      consumes: [],
      produces: ['IMPORTS'],
    });

    const enricherB = createEnrichmentPlugin('EnricherB', mock, {
      consumes: ['CALLS'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [enricherA.plugin as any, enricherB.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(enricherA.calls.length, 1, 'EnricherA (level-0) should execute');
    assert.strictEqual(enricherB.calls.length, 0,
      'EnricherB should be SKIPPED because CALLS was not in any delta (only IMPORTS was)');
  });

  it('Chain A→B→C all run when deltas propagate correctly', async () => {
    const executionOrder: string[] = [];

    const mock = createDeltaMockGraph({
      'ChainA': makeDelta({ changedEdgeTypes: ['RESOLVED_CALL'] }),
      'ChainB': makeDelta({ changedEdgeTypes: ['CALLS'] }),
      'ChainC': makeDelta(),
    });

    const chainA = createEnrichmentPlugin('ChainA', mock, {
      consumes: [],
      produces: ['RESOLVED_CALL'],
      executeFn: async () => {
        executionOrder.push('ChainA');
        mock.setCurrentPlugin('ChainA');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const chainB = createEnrichmentPlugin('ChainB', mock, {
      consumes: ['RESOLVED_CALL'],
      produces: ['CALLS'],
      executeFn: async () => {
        executionOrder.push('ChainB');
        mock.setCurrentPlugin('ChainB');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const chainC = createEnrichmentPlugin('ChainC', mock, {
      consumes: ['CALLS'],
      executeFn: async () => {
        executionOrder.push('ChainC');
        mock.setCurrentPlugin('ChainC');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [chainA.plugin as any, chainB.plugin as any, chainC.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.deepStrictEqual(executionOrder, ['ChainA', 'ChainB', 'ChainC'],
      'All three enrichers should execute in chain order');
  });

  it('Skip is logged with enricher name and consumed types', async () => {
    const mock = createDeltaMockGraph({
      'ProducerPlugin': makeDelta({ changedEdgeTypes: ['IMPORTS'] }),
    });

    const producer = createEnrichmentPlugin('ProducerPlugin', mock, {
      consumes: [],
      produces: ['IMPORTS'],
    });

    const skipped = createEnrichmentPlugin('SkippedPlugin', mock, {
      consumes: ['CALLS', 'RESOLVED_CALL'],
    });

    const debugMessages: string[] = [];
    const logger = {
      debug: (msg: string, ..._args: any[]) => { debugMessages.push(msg); },
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [producer.plugin as any, skipped.plugin as any],
      logger: logger as any,
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // Find the SKIP log message
    const skipMsg = debugMessages.find(m => m.includes('[SKIP]'));
    assert.ok(skipMsg !== undefined,
      `Expected a "[SKIP]" debug log message. Got messages: ${JSON.stringify(debugMessages)}`);
    assert.ok(skipMsg!.includes('SkippedPlugin'),
      `SKIP message should contain enricher name "SkippedPlugin". Got: "${skipMsg}"`);
    assert.ok(skipMsg!.includes('CALLS'),
      `SKIP message should contain consumed type "CALLS". Got: "${skipMsg}"`);
    assert.ok(skipMsg!.includes('RESOLVED_CALL'),
      `SKIP message should contain consumed type "RESOLVED_CALL". Got: "${skipMsg}"`);
  });

  it('Delta types accumulate across enrichers (A→B→C via changedNodeTypes)', async () => {
    const mock = createDeltaMockGraph({
      'AccumA': makeDelta({ changedEdgeTypes: ['X'] }),
      'AccumB': makeDelta({ changedNodeTypes: ['Y'] }),
      'AccumC': makeDelta(),
    });

    const accumA = createEnrichmentPlugin('AccumA', mock, {
      consumes: [],
      produces: ['X'],
    });

    const accumB = createEnrichmentPlugin('AccumB', mock, {
      consumes: ['X'],
      produces: ['Y'],
    });

    const accumC = createEnrichmentPlugin('AccumC', mock, {
      consumes: ['Y'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [accumA.plugin as any, accumB.plugin as any, accumC.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(accumA.calls.length, 1, 'AccumA (level-0) should execute');
    assert.strictEqual(accumB.calls.length, 1,
      'AccumB should run because X was in AccumA delta');
    assert.strictEqual(accumC.calls.length, 1,
      'AccumC should run because Y was accumulated from AccumB delta');
  });

  it('All enrichers run without batch support (fallback, no optimization)', async () => {
    const mock = createNoBatchMockGraph();

    // Note: we cannot use createEnrichmentPlugin here because it needs
    // a mock with setCurrentPlugin. Build plugins manually for no-batch scenario.
    const callsA: any[] = [];
    const callsB: any[] = [];

    const pluginA = {
      metadata: {
        name: 'NoBatchA',
        phase: 'ENRICHMENT',
        creates: { nodes: [], edges: [] },
        consumes: [] as string[],
        produces: ['CALLS'],
      },
      execute: async (ctx: any) => {
        callsA.push(ctx);
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    };

    const pluginB = {
      metadata: {
        name: 'NoBatchB',
        phase: 'ENRICHMENT',
        creates: { nodes: [], edges: [] },
        consumes: ['CALLS'],
        produces: [] as string[],
      },
      execute: async (ctx: any) => {
        callsB.push(ctx);
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [pluginA as any, pluginB as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(callsA.length, 1, 'NoBatchA should execute (no batch = no skip optimization)');
    assert.strictEqual(callsB.length, 1,
      'NoBatchB should execute despite consumes not changing — ' +
      'without batch support, selective enrichment is disabled');
  });

  it('Multiple consumed types — runs if ANY matches', async () => {
    const mock = createDeltaMockGraph({
      'MultiProdA': makeDelta({ changedEdgeTypes: ['CALLS'] }),
      'MultiConsB': makeDelta(),
    });

    const multiProdA = createEnrichmentPlugin('MultiProdA', mock, {
      consumes: [],
      produces: ['CALLS'],
    });

    // Consumes both CALLS and IMPORTS, but only CALLS changed
    const multiConsB = createEnrichmentPlugin('MultiConsB', mock, {
      consumes: ['CALLS', 'IMPORTS'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [multiProdA.plugin as any, multiConsB.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(multiProdA.calls.length, 1, 'MultiProdA should execute');
    assert.strictEqual(multiConsB.calls.length, 1,
      'MultiConsB should execute because CALLS matches (even though IMPORTS does not)');
  });

});
