/**
 * PhaseRunner locking tests (REG-435)
 *
 * Locks the behavior of Orchestrator.runPhase() before extracting it
 * into a separate PhaseRunner class. These tests verify:
 *
 * 1. ENRICHMENT plugins execute in toposorted order (consumes/produces)
 * 2. PluginContext is enriched with Orchestrator state
 * 3. onProgress called twice per plugin (start + completion)
 * 4. Fatal error stops subsequent plugin execution
 * 5. suppressedByIgnoreCount accumulated across ENRICHMENT plugins
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

/**
 * Create a mock plugin with configurable phase, execute behavior, and metadata.
 * The execute spy captures the PluginContext it receives for assertion.
 */
function createMockPlugin(
  name: string,
  phase: string,
  opts: {
    produces?: string[];
    consumes?: string[];
    dependencies?: string[];
    result?: Record<string, unknown>;
    executeFn?: (ctx: any) => Promise<any>;
  } = {}
) {
  const calls: any[] = [];
  const defaultResult = {
    success: true,
    created: { nodes: 0, edges: 0 },
    errors: [],
    warnings: [],
  };
  const plugin = {
    metadata: {
      name,
      phase,
      creates: { nodes: [], edges: [] },
      ...(opts.produces ? { produces: opts.produces } : {}),
      ...(opts.consumes ? { consumes: opts.consumes } : {}),
      ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
    },
    execute: async (ctx: any) => {
      calls.push(ctx);
      if (opts.executeFn) {
        return opts.executeFn(ctx);
      }
      return { ...defaultResult, ...opts.result };
    },
    calls,
  };
  return plugin;
}

describe('Orchestrator.runPhase — locking tests (REG-435)', () => {

  it('should execute ENRICHMENT plugins in toposorted order (producer before consumer)', async () => {
    const mock = createMockGraph();
    const executionOrder: string[] = [];

    // C consumes RESOLVED_CALL (produced by A), B consumes CALLS (produced by C)
    // Expected order: A -> C -> B
    const pluginA = createMockPlugin('PluginA', 'ENRICHMENT', {
      produces: ['RESOLVED_CALL'],
      executeFn: async () => {
        executionOrder.push('PluginA');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });
    const pluginB = createMockPlugin('PluginB', 'ENRICHMENT', {
      consumes: ['CALLS'],
      executeFn: async () => {
        executionOrder.push('PluginB');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });
    const pluginC = createMockPlugin('PluginC', 'ENRICHMENT', {
      consumes: ['RESOLVED_CALL'],
      produces: ['CALLS'],
      executeFn: async () => {
        executionOrder.push('PluginC');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      // Pass plugins in non-sorted order deliberately
      plugins: [pluginB as any, pluginC as any, pluginA as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // A produces RESOLVED_CALL, C consumes it -> A before C
    // C produces CALLS, B consumes it -> C before B
    // So: A -> C -> B
    assert.strictEqual(executionOrder.length, 3, 'All 3 plugins should execute');
    const indexA = executionOrder.indexOf('PluginA');
    const indexB = executionOrder.indexOf('PluginB');
    const indexC = executionOrder.indexOf('PluginC');
    assert.ok(indexA < indexC, `PluginA (idx ${indexA}) must run before PluginC (idx ${indexC})`);
    assert.ok(indexC < indexB, `PluginC (idx ${indexC}) must run before PluginB (idx ${indexB})`);
  });

  it('should enrich PluginContext with Orchestrator state (forceAnalysis, logger, strictMode, resources)', async () => {
    const mock = createMockGraph();
    let capturedContext: any = null;

    const plugin = createMockPlugin('ContextChecker', 'ENRICHMENT', {
      executeFn: async (ctx: any) => {
        capturedContext = ctx;
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [plugin as any],
      forceAnalysis: true,
      strictMode: true,
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.ok(capturedContext !== null, 'Plugin should have been called');
    assert.strictEqual(capturedContext.forceAnalysis, true, 'forceAnalysis should be passed through');
    assert.strictEqual(capturedContext.strictMode, true, 'strictMode should be passed through');
    assert.ok(capturedContext.logger !== undefined, 'logger should be present in context');
    assert.ok(capturedContext.resources !== undefined, 'resources (ResourceRegistry) should be present in context');
    assert.ok(typeof capturedContext.onProgress === 'function', 'onProgress callback should be present');
  });

  it('should call onProgress twice per plugin (start message + completion message)', async () => {
    const mock = createMockGraph();
    const progressCalls: any[] = [];

    const pluginA = createMockPlugin('AlphaPlugin', 'ENRICHMENT');
    const pluginB = createMockPlugin('BetaPlugin', 'ENRICHMENT');

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [pluginA as any, pluginB as any],
      onProgress: (info: any) => { progressCalls.push(info); },
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // 2 plugins x 2 calls each = 4 total progress calls
    assert.strictEqual(progressCalls.length, 4, 'Should have 4 progress calls (2 per plugin)');

    // First plugin: start message
    assert.ok(
      progressCalls[0].message.includes('AlphaPlugin'),
      `First call should mention AlphaPlugin: "${progressCalls[0].message}"`
    );
    assert.ok(
      progressCalls[0].message.includes('Running plugin'),
      'First call should be a "Running plugin" message'
    );

    // First plugin: completion message
    assert.ok(
      progressCalls[1].message.includes('AlphaPlugin'),
      `Second call should mention AlphaPlugin: "${progressCalls[1].message}"`
    );
    assert.ok(
      progressCalls[1].message.includes('complete'),
      'Second call should be a completion message'
    );

    // Second plugin: start message
    assert.ok(
      progressCalls[2].message.includes('BetaPlugin'),
      `Third call should mention BetaPlugin: "${progressCalls[2].message}"`
    );

    // Second plugin: completion message
    assert.ok(
      progressCalls[3].message.includes('BetaPlugin'),
      `Fourth call should mention BetaPlugin: "${progressCalls[3].message}"`
    );
  });

  it('should stop execution after fatal error — second plugin must NOT run', async () => {
    const mock = createMockGraph();
    const executionOrder: string[] = [];

    const { DatabaseError } = await import('@grafema/core');

    const fatalPlugin = createMockPlugin('FatalPlugin', 'ANALYSIS', {
      dependencies: [],
      executeFn: async () => {
        executionOrder.push('FatalPlugin');
        return {
          success: false,
          created: { nodes: 0, edges: 0 },
          errors: [new DatabaseError('DB corrupted', 'ERR_DATABASE_CORRUPTED')],
          warnings: [],
        };
      },
    });

    const secondPlugin = createMockPlugin('SecondPlugin', 'ANALYSIS', {
      dependencies: [],
      executeFn: async () => {
        executionOrder.push('SecondPlugin');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [fatalPlugin as any, secondPlugin as any],
      logLevel: 'silent',
    });

    let thrownError: Error | null = null;
    try {
      await orchestrator.runPhase('ANALYSIS', { graph: mock.backend as any });
    } catch (e) {
      thrownError = e as Error;
    }

    assert.ok(thrownError !== null, 'Should throw an error on fatal diagnostic');
    assert.ok(
      thrownError!.message.includes('Fatal error in FatalPlugin'),
      `Error message should reference FatalPlugin: "${thrownError!.message}"`
    );
    assert.deepStrictEqual(
      executionOrder,
      ['FatalPlugin'],
      'Only FatalPlugin should have executed — SecondPlugin must be skipped'
    );
  });

  it('should accumulate suppressedByIgnoreCount from multiple ENRICHMENT plugin results', async () => {
    const mock = createMockGraph();

    const enricher1 = createMockPlugin('Enricher1', 'ENRICHMENT', {
      result: {
        metadata: { suppressedByIgnore: 3 },
      },
    });

    const enricher2 = createMockPlugin('Enricher2', 'ENRICHMENT', {
      result: {
        metadata: { suppressedByIgnore: 7 },
      },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [enricher1 as any, enricher2 as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // Access suppressedByIgnoreCount through the phaseRunner (moved from Orchestrator in RFD-16)
    const count = (orchestrator as any).phaseRunner.getSuppressedByIgnoreCount();
    assert.strictEqual(count, 10, 'suppressedByIgnoreCount should be 3 + 7 = 10');
  });
});
