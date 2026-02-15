/**
 * Batch wrapping tests for PhaseRunner.runPluginWithBatch (RFD-16, Phase 2)
 *
 * Verifies that PhaseRunner wraps every plugin.execute() in a batch:
 * 1. beginBatch() before execute, commitBatch(tags) after execute
 * 2. Fallback when backend lacks batch methods
 * 3. abortBatch() called on plugin error
 * 4. commitBatch receives correct tags (plugin name + phase)
 * 5. Delta logged after commit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Create a mock graph backend WITH batch support.
 * Tracks which batch methods were called and in what order.
 */
function createBatchMockGraph() {
  const calls: string[] = [];
  let commitTags: string[] | undefined;
  return {
    calls,
    getCommitTags: () => commitTags,
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
      beginBatch: () => { calls.push('beginBatch'); },
      commitBatch: async (tags?: string[]) => {
        calls.push('commitBatch');
        commitTags = tags;
        return {
          changedFiles: [],
          nodesAdded: 0,
          nodesRemoved: 0,
          edgesAdded: 0,
          edgesRemoved: 0,
          changedNodeTypes: [],
          changedEdgeTypes: [],
        };
      },
      abortBatch: () => { calls.push('abortBatch'); },
    },
  };
}

/**
 * Create a mock graph backend WITHOUT batch support.
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
 * Create a mock plugin with configurable phase and execute behavior.
 */
function createMockPlugin(name: string, phase: string, opts: {
  executeFn?: (ctx: any) => Promise<any>;
} = {}) {
  let executed = false;
  return {
    metadata: {
      name,
      phase,
      creates: { nodes: [], edges: [] },
    },
    execute: async (ctx: any) => {
      executed = true;
      if (opts.executeFn) return opts.executeFn(ctx);
      return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
    },
    wasExecuted: () => executed,
  };
}

describe('PhaseRunner batch wrapping (RFD-16, Phase 2)', () => {

  it('should call beginBatch before execute and commitBatch after execute when backend supports batching', async () => {
    const mock = createBatchMockGraph();
    const executionOrder: string[] = [];

    const plugin = createMockPlugin('TestEnricher', 'ENRICHMENT', {
      executeFn: async () => {
        executionOrder.push('execute');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    // Intercept batch calls to track ordering relative to execute
    const originalBeginBatch = mock.backend.beginBatch;
    mock.backend.beginBatch = () => {
      executionOrder.push('beginBatch');
      originalBeginBatch();
    };
    const originalCommitBatch = mock.backend.commitBatch;
    mock.backend.commitBatch = async (tags?: string[]) => {
      executionOrder.push('commitBatch');
      return originalCommitBatch(tags);
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // Verify order: beginBatch -> execute -> commitBatch
    assert.deepStrictEqual(executionOrder, ['beginBatch', 'execute', 'commitBatch'],
      'Batch lifecycle must be: beginBatch -> execute -> commitBatch');

    // abortBatch must NOT have been called
    assert.ok(!mock.calls.includes('abortBatch'),
      'abortBatch should not be called on success');
  });

  it('should fall back to direct execute when backend lacks batch methods', async () => {
    const mock = createNoBatchMockGraph();

    const plugin = createMockPlugin('SimplePlugin', 'ENRICHMENT');

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    // Should not throw — graceful fallback
    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.ok(plugin.wasExecuted(), 'Plugin execute should have been called');
  });

  it('should call abortBatch (not commitBatch) when plugin throws an error', async () => {
    const mock = createBatchMockGraph();
    const pluginError = new Error('Plugin crashed');

    const plugin = createMockPlugin('CrashingPlugin', 'ENRICHMENT', {
      executeFn: async () => { throw pluginError; },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    let thrownError: Error | null = null;
    try {
      await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });
    } catch (e) {
      thrownError = e as Error;
    }

    assert.ok(thrownError !== null, 'Error should have been re-thrown');
    assert.ok(mock.calls.includes('beginBatch'), 'beginBatch should have been called');
    assert.ok(mock.calls.includes('abortBatch'), 'abortBatch should have been called on error');
    assert.ok(!mock.calls.includes('commitBatch'), 'commitBatch should NOT be called on error');
  });

  it('should pass correct tags (plugin name + phase) to commitBatch', async () => {
    const mock = createBatchMockGraph();

    const plugin = createMockPlugin('ImportExportLinker', 'ENRICHMENT');

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    const tags = mock.getCommitTags();
    assert.ok(tags !== undefined, 'commitBatch should have received tags');
    assert.ok(tags!.includes('ImportExportLinker'),
      `Tags should contain plugin name "ImportExportLinker", got: ${JSON.stringify(tags)}`);
    assert.ok(tags!.includes('ENRICHMENT'),
      `Tags should contain phase name "ENRICHMENT", got: ${JSON.stringify(tags)}`);
  });

  it('should log delta details after commitBatch returns', async () => {
    const mock = createBatchMockGraph();

    // Override commitBatch to return a non-zero delta
    mock.backend.commitBatch = async (tags?: string[]) => {
      mock.calls.push('commitBatch');
      return {
        changedFiles: [],
        nodesAdded: 5,
        nodesRemoved: 0,
        edgesAdded: 3,
        edgesRemoved: 0,
        changedNodeTypes: [],
        changedEdgeTypes: [],
      };
    };

    const plugin = createMockPlugin('DeltaPlugin', 'ENRICHMENT');

    const logMessages: string[] = [];
    const logger = {
      debug: (msg: string) => logMessages.push(msg),
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [plugin as any],
      logger: logger as any,
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // Find the debug message that contains the delta info
    const deltaMsg = logMessages.find(m => m.includes('5') && m.includes('3'));
    assert.ok(deltaMsg !== undefined,
      `Logger should have received a debug message mentioning "5 nodes" and "3 edges". ` +
      `Got messages: ${JSON.stringify(logMessages)}`);
    assert.ok(deltaMsg!.includes('DeltaPlugin'),
      `Delta log should reference the plugin name. Got: "${deltaMsg}"`);
  });
});
