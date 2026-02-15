/**
 * Enrichment Propagation tests (RFD-17)
 *
 * Tests queue-based enricher dependency propagation in PhaseRunner:
 * - When enricher A's delta has changedEdgeTypes, downstream enrichers
 *   consuming those types get enqueued and re-run
 * - Queue respects topological order from consumes/produces declarations
 * - Each enricher runs at most once per propagation cycle
 * - Cycles in consumes/produces graph are detected and rejected
 * - Independent enrichers (level-0, no consumes) always run
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

describe('Enrichment propagation (RFD-17)', () => {

  // Test 1: propagation_basic
  // A (level-0, produces X) runs, delta has changedEdgeTypes=['X'].
  // B (consumes X) should run.
  it('propagation_basic: downstream enricher runs when upstream delta contains its consumed type', async () => {
    const mock = createDeltaMockGraph({
      'ProducerA': makeDelta({ changedEdgeTypes: ['X'] }),
      'ConsumerB': makeDelta(),
    });

    const producerA = createEnrichmentPlugin('ProducerA', mock, {
      consumes: [],
      produces: ['X'],
    });

    const consumerB = createEnrichmentPlugin('ConsumerB', mock, {
      consumes: ['X'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [producerA.plugin as any, consumerB.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(producerA.calls.length, 1,
      'ProducerA (level-0) should execute');
    assert.strictEqual(consumerB.calls.length, 1,
      'ConsumerB should execute because X was in ProducerA delta');
  });

  // Test 2: propagation_chain
  // A->B->C chain. A produces X (delta has X), B consumes X produces Y (delta has Y),
  // C consumes Y. All three should run in order A, B, C.
  it('propagation_chain: A->B->C chain propagates through all levels in order', async () => {
    const executionOrder: string[] = [];

    const mock = createDeltaMockGraph({
      'ChainA': makeDelta({ changedEdgeTypes: ['X'] }),
      'ChainB': makeDelta({ changedEdgeTypes: ['Y'] }),
      'ChainC': makeDelta(),
    });

    const chainA = createEnrichmentPlugin('ChainA', mock, {
      consumes: [],
      produces: ['X'],
      executeFn: async () => {
        executionOrder.push('ChainA');
        mock.setCurrentPlugin('ChainA');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const chainB = createEnrichmentPlugin('ChainB', mock, {
      consumes: ['X'],
      produces: ['Y'],
      executeFn: async () => {
        executionOrder.push('ChainB');
        mock.setCurrentPlugin('ChainB');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const chainC = createEnrichmentPlugin('ChainC', mock, {
      consumes: ['Y'],
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
      'All three enrichers should execute in chain order A -> B -> C');
  });

  // Test 3: propagation_no_change
  // A (level-0, produces X) runs, but delta has changedEdgeTypes=[] (empty).
  // B (consumes X) should NOT run.
  it('propagation_no_change: downstream enricher skipped when upstream delta is empty', async () => {
    const mock = createDeltaMockGraph({
      'NoChangeA': makeDelta({ changedEdgeTypes: [] }),
      'NoChangeB': makeDelta(),
    });

    const noChangeA = createEnrichmentPlugin('NoChangeA', mock, {
      consumes: [],
      produces: ['X'],
    });

    const noChangeB = createEnrichmentPlugin('NoChangeB', mock, {
      consumes: ['X'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [noChangeA.plugin as any, noChangeB.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(noChangeA.calls.length, 1,
      'NoChangeA (level-0) should execute');
    assert.strictEqual(noChangeB.calls.length, 0,
      'NoChangeB should NOT execute because no X appeared in any delta');
  });

  // Test 4: propagation_multiple_files
  // File-scoped propagation is future work (T6.x). Placeholder only.
  it.skip('propagation_multiple_files: file-scoped propagation (future T6.x)', async () => {
    // File-scoped propagation is not yet implemented.
    // When T6.x lands, this test should verify that propagation
    // can be scoped to specific files changed by upstream enrichers,
    // rather than triggering a full re-run of downstream enrichers.
  });

  // Test 5: termination_guaranteed
  // Diamond pattern: A->B, A->C, B->D, C->D.
  // A produces X (consumed by B,C). B produces Y (consumed by D).
  // C produces Z (consumed by D). All produce deltas.
  // Verify: all 4 enrichers run exactly once, D runs last.
  it('termination_guaranteed: diamond A->B,C->D all run exactly once, D last', async () => {
    const executionOrder: string[] = [];

    const mock = createDeltaMockGraph({
      'DiamondA': makeDelta({ changedEdgeTypes: ['X'] }),
      'DiamondB': makeDelta({ changedEdgeTypes: ['Y'] }),
      'DiamondC': makeDelta({ changedEdgeTypes: ['Z'] }),
      'DiamondD': makeDelta(),
    });

    const diamondA = createEnrichmentPlugin('DiamondA', mock, {
      consumes: [],
      produces: ['X'],
      executeFn: async () => {
        executionOrder.push('DiamondA');
        mock.setCurrentPlugin('DiamondA');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const diamondB = createEnrichmentPlugin('DiamondB', mock, {
      consumes: ['X'],
      produces: ['Y'],
      executeFn: async () => {
        executionOrder.push('DiamondB');
        mock.setCurrentPlugin('DiamondB');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const diamondC = createEnrichmentPlugin('DiamondC', mock, {
      consumes: ['X'],
      produces: ['Z'],
      executeFn: async () => {
        executionOrder.push('DiamondC');
        mock.setCurrentPlugin('DiamondC');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const diamondD = createEnrichmentPlugin('DiamondD', mock, {
      consumes: ['Y', 'Z'],
      executeFn: async () => {
        executionOrder.push('DiamondD');
        mock.setCurrentPlugin('DiamondD');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        diamondA.plugin as any,
        diamondB.plugin as any,
        diamondC.plugin as any,
        diamondD.plugin as any,
      ],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // All four enrichers must run exactly once
    assert.strictEqual(diamondA.calls.length, 1, 'DiamondA should run exactly once');
    assert.strictEqual(diamondB.calls.length, 1, 'DiamondB should run exactly once');
    assert.strictEqual(diamondC.calls.length, 1, 'DiamondC should run exactly once');
    assert.strictEqual(diamondD.calls.length, 1, 'DiamondD should run exactly once');

    // D must run last (after both B and C)
    const dIndex = executionOrder.indexOf('DiamondD');
    const bIndex = executionOrder.indexOf('DiamondB');
    const cIndex = executionOrder.indexOf('DiamondC');
    const aIndex = executionOrder.indexOf('DiamondA');

    assert.ok(aIndex < bIndex, 'DiamondA must run before DiamondB');
    assert.ok(aIndex < cIndex, 'DiamondA must run before DiamondC');
    assert.ok(bIndex < dIndex, 'DiamondB must run before DiamondD');
    assert.ok(cIndex < dIndex, 'DiamondC must run before DiamondD');
    assert.strictEqual(dIndex, executionOrder.length - 1,
      'DiamondD must be the last enricher to run');
  });

  // Test 6: worst_case_all_rerun
  // Linear chain A->B->C->D->E (5 enrichers). Each produces changes.
  // All should run exactly once in order.
  it('worst_case_all_rerun: linear chain of 5 enrichers all run exactly once in order', async () => {
    const executionOrder: string[] = [];

    const mock = createDeltaMockGraph({
      'LinearA': makeDelta({ changedEdgeTypes: ['T1'] }),
      'LinearB': makeDelta({ changedEdgeTypes: ['T2'] }),
      'LinearC': makeDelta({ changedEdgeTypes: ['T3'] }),
      'LinearD': makeDelta({ changedEdgeTypes: ['T4'] }),
      'LinearE': makeDelta(),
    });

    const makeLinearPlugin = (name: string, consumes: string[], produces: string[]) =>
      createEnrichmentPlugin(name, mock, {
        consumes,
        produces,
        executeFn: async () => {
          executionOrder.push(name);
          mock.setCurrentPlugin(name);
          return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
        },
      });

    const linearA = makeLinearPlugin('LinearA', [], ['T1']);
    const linearB = makeLinearPlugin('LinearB', ['T1'], ['T2']);
    const linearC = makeLinearPlugin('LinearC', ['T2'], ['T3']);
    const linearD = makeLinearPlugin('LinearD', ['T3'], ['T4']);
    const linearE = makeLinearPlugin('LinearE', ['T4'], []);

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        linearA.plugin as any,
        linearB.plugin as any,
        linearC.plugin as any,
        linearD.plugin as any,
        linearE.plugin as any,
      ],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.deepStrictEqual(executionOrder, ['LinearA', 'LinearB', 'LinearC', 'LinearD', 'LinearE'],
      'All 5 enrichers should execute exactly once in linear order');

    // Verify each ran exactly once
    assert.strictEqual(linearA.calls.length, 1, 'LinearA should run exactly once');
    assert.strictEqual(linearB.calls.length, 1, 'LinearB should run exactly once');
    assert.strictEqual(linearC.calls.length, 1, 'LinearC should run exactly once');
    assert.strictEqual(linearD.calls.length, 1, 'LinearD should run exactly once');
    assert.strictEqual(linearE.calls.length, 1, 'LinearE should run exactly once');
  });

  // Test 7: no_cycles
  // A consumes Y produces X, B consumes X produces Y. This creates a cycle.
  // Toposort should throw a CycleError. Test that Orchestrator throws
  // when running ENRICHMENT phase.
  it('no_cycles: cyclic consumes/produces dependency throws CycleError', async () => {
    const mock = createDeltaMockGraph({
      'CycleA': makeDelta(),
      'CycleB': makeDelta(),
    });

    const cycleA = createEnrichmentPlugin('CycleA', mock, {
      consumes: ['Y'],
      produces: ['X'],
    });

    const cycleB = createEnrichmentPlugin('CycleB', mock, {
      consumes: ['X'],
      produces: ['Y'],
    });

    const { Orchestrator, CycleError } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [cycleA.plugin as any, cycleB.plugin as any],
      logLevel: 'silent',
    });

    await assert.rejects(
      () => orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any }),
      (err: any) => {
        // Should be a CycleError from toposort
        assert.ok(err instanceof CycleError,
          `Expected CycleError but got ${err.constructor.name}: ${err.message}`);
        assert.ok(err.message.includes('cycle'),
          `Error message should mention cycle. Got: "${err.message}"`);
        return true;
      },
      'ENRICHMENT with cyclic dependencies should throw CycleError',
    );
  });

  // Test 8: topological_order
  // A (level-0, produces X), B (consumes X), C (level-0, produces Y), D (consumes Y).
  // A and C are independent. Verify: A before B, C before D.
  it('topological_order: independent chains maintain correct ordering', async () => {
    const executionOrder: string[] = [];

    const mock = createDeltaMockGraph({
      'TopoA': makeDelta({ changedEdgeTypes: ['X'] }),
      'TopoB': makeDelta(),
      'TopoC': makeDelta({ changedEdgeTypes: ['Y'] }),
      'TopoD': makeDelta(),
    });

    const makeTopoPlugin = (name: string, consumes: string[], produces: string[]) =>
      createEnrichmentPlugin(name, mock, {
        consumes,
        produces,
        executeFn: async () => {
          executionOrder.push(name);
          mock.setCurrentPlugin(name);
          return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
        },
      });

    const topoA = makeTopoPlugin('TopoA', [], ['X']);
    const topoB = makeTopoPlugin('TopoB', ['X'], []);
    const topoC = makeTopoPlugin('TopoC', [], ['Y']);
    const topoD = makeTopoPlugin('TopoD', ['Y'], []);

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [
        topoA.plugin as any,
        topoB.plugin as any,
        topoC.plugin as any,
        topoD.plugin as any,
      ],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // All four should run
    assert.strictEqual(topoA.calls.length, 1, 'TopoA should run');
    assert.strictEqual(topoB.calls.length, 1, 'TopoB should run');
    assert.strictEqual(topoC.calls.length, 1, 'TopoC should run');
    assert.strictEqual(topoD.calls.length, 1, 'TopoD should run');

    // Ordering constraints: A before B, C before D
    const aIdx = executionOrder.indexOf('TopoA');
    const bIdx = executionOrder.indexOf('TopoB');
    const cIdx = executionOrder.indexOf('TopoC');
    const dIdx = executionOrder.indexOf('TopoD');

    assert.ok(aIdx < bIdx,
      `TopoA (idx ${aIdx}) must run before TopoB (idx ${bIdx}). Order: ${executionOrder.join(', ')}`);
    assert.ok(cIdx < dIdx,
      `TopoC (idx ${cIdx}) must run before TopoD (idx ${dIdx}). Order: ${executionOrder.join(', ')}`);
  });

  // Test 9: independent_enrichers
  // A and B both level-0 (no consumes). Both should run regardless of delta.
  it('independent_enrichers: two level-0 enrichers both run regardless of delta', async () => {
    const mock = createDeltaMockGraph({
      'IndependentA': makeDelta({ changedEdgeTypes: ['FOO'] }),
      'IndependentB': makeDelta({ changedEdgeTypes: ['BAR'] }),
    });

    const independentA = createEnrichmentPlugin('IndependentA', mock, {
      consumes: [],
      produces: ['FOO'],
    });

    const independentB = createEnrichmentPlugin('IndependentB', mock, {
      consumes: [],
      produces: ['BAR'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [independentA.plugin as any, independentB.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.strictEqual(independentA.calls.length, 1,
      'IndependentA (level-0) should always execute');
    assert.strictEqual(independentB.calls.length, 1,
      'IndependentB (level-0) should always execute');
  });

  // Test 10: queue_respects_dependencies
  // A (level-0, produces X), B (consumes X, produces Y), C (consumes Y).
  // Even though all are enqueued eventually, they must run in order A->B->C.
  it('queue_respects_dependencies: enqueued enrichers execute in topological order', async () => {
    const executionOrder: string[] = [];

    const mock = createDeltaMockGraph({
      'QueueA': makeDelta({ changedEdgeTypes: ['X'] }),
      'QueueB': makeDelta({ changedEdgeTypes: ['Y'] }),
      'QueueC': makeDelta(),
    });

    // Register plugins in REVERSE order to verify that toposort
    // overrides registration order and enforces dependency ordering.
    const queueC = createEnrichmentPlugin('QueueC', mock, {
      consumes: ['Y'],
      executeFn: async () => {
        executionOrder.push('QueueC');
        mock.setCurrentPlugin('QueueC');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const queueB = createEnrichmentPlugin('QueueB', mock, {
      consumes: ['X'],
      produces: ['Y'],
      executeFn: async () => {
        executionOrder.push('QueueB');
        mock.setCurrentPlugin('QueueB');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const queueA = createEnrichmentPlugin('QueueA', mock, {
      consumes: [],
      produces: ['X'],
      executeFn: async () => {
        executionOrder.push('QueueA');
        mock.setCurrentPlugin('QueueA');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      // Deliberately pass in reverse order: C, B, A
      plugins: [queueC.plugin as any, queueB.plugin as any, queueA.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // Despite reverse registration order, toposort must enforce A -> B -> C
    assert.deepStrictEqual(executionOrder, ['QueueA', 'QueueB', 'QueueC'],
      'Queue must respect topological order A -> B -> C despite reverse registration');

    assert.strictEqual(queueA.calls.length, 1, 'QueueA should run exactly once');
    assert.strictEqual(queueB.calls.length, 1, 'QueueB should run exactly once');
    assert.strictEqual(queueC.calls.length, 1, 'QueueC should run exactly once');
  });

});
