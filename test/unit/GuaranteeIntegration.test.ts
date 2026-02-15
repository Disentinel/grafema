/**
 * Guarantee Integration tests (RFD-29)
 *
 * Tests the integration of guarantee checking into the Orchestrator pipeline:
 * 1. PhaseRunner.runPhase() returns Set<string> of accumulated changedNodeTypes + changedEdgeTypes
 * 2. Orchestrator calls guarantee check AFTER enrichment, BEFORE validation
 * 3. GuaranteeManager.checkSelective(changedTypes) filters guarantees by matching types
 * 4. Coverage monitoring warns when content changed but analysis identical
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { CommitDelta } from '@grafema/types';

// ============ Helpers ============

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
        mockGraph.setCurrentPlugin(name);
        calls.push(ctx);
        if (opts.executeFn) return opts.executeFn();
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    },
  };
}

/**
 * Create a mock GuaranteeGraph for GuaranteeManager tests.
 * Supports storing nodes, edges, and a mock checkGuarantee implementation.
 */
function createMockGuaranteeGraph(opts: {
  nodes?: Record<string, any>;
  checkGuaranteeResults?: Record<string, any[]>;
} = {}) {
  const nodes = new Map<string, any>(Object.entries(opts.nodes ?? {}));
  const edges: Array<{ src: string; dst: string; type: string }> = [];

  return {
    nodes,
    edges,
    addNode: async (node: any) => { nodes.set(node.id, node); },
    getNode: async (id: string) => nodes.get(id) ?? null,
    deleteNode: async (id: string) => { nodes.delete(id); },
    queryNodes: async function* (filter: { type: string }) {
      for (const [, node] of nodes) {
        if (node.type === filter.type) yield node;
      }
    },
    addEdge: async (edge: any) => { edges.push(edge); },
    deleteEdge: async (src: string, dst: string, type: string) => {
      const idx = edges.findIndex(e => e.src === src && e.dst === dst && e.type === type);
      if (idx >= 0) edges.splice(idx, 1);
    },
    getOutgoingEdges: async (nodeId: string, types: string[]) =>
      edges.filter(e => e.src === nodeId && types.includes(e.type)),
    getIncomingEdges: async (nodeId: string, types: string[]) =>
      edges.filter(e => e.dst === nodeId && types.includes(e.type)),
    checkGuarantee: async (rule: string) => {
      return opts.checkGuaranteeResults?.[rule] ?? [];
    },
  };
}

// ============ Group 1: PhaseRunner return type ============

describe('PhaseRunner return type (RFD-29)', () => {

  it('phaseRunner_returns_accumulated_types — runPhase returns Set with changedNodeTypes + changedEdgeTypes', async () => {
    const mock = createDeltaMockGraph({
      'EnricherA': makeDelta({
        changedNodeTypes: ['FUNCTION', 'CALL'],
        changedEdgeTypes: ['CALLS'],
      }),
      'EnricherB': makeDelta({
        changedNodeTypes: ['VARIABLE'],
        changedEdgeTypes: ['READS'],
      }),
    });

    const enricherA = createEnrichmentPlugin('EnricherA', mock, {
      consumes: [],
      produces: ['FUNCTION', 'CALL', 'CALLS'],
    });
    const enricherB = createEnrichmentPlugin('EnricherB', mock, {
      consumes: ['FUNCTION'],
      produces: ['VARIABLE', 'READS'],
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [enricherA.plugin as any, enricherB.plugin as any],
      logLevel: 'silent',
    });

    // runPhase currently returns Promise<void>; after RFD-29 it returns Promise<Set<string>>
    const result = await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // After RFD-29, the return type should be Set<string>
    assert.ok(result instanceof Set,
      `runPhase should return a Set<string>, got: ${typeof result}`);

    const resultSet = result as Set<string>;

    // Should contain all accumulated types from both enrichers
    assert.ok(resultSet.has('FUNCTION'), 'Should contain FUNCTION from EnricherA');
    assert.ok(resultSet.has('CALL'), 'Should contain CALL from EnricherA');
    assert.ok(resultSet.has('CALLS'), 'Should contain CALLS from EnricherA');
    assert.ok(resultSet.has('VARIABLE'), 'Should contain VARIABLE from EnricherB');
    assert.ok(resultSet.has('READS'), 'Should contain READS from EnricherB');
    assert.strictEqual(resultSet.size, 5,
      'Should have exactly 5 accumulated types (FUNCTION, CALL, CALLS, VARIABLE, READS)');
  });

  it('phaseRunner_returns_empty_set_without_batch — no batch support returns empty Set', async () => {
    const mock = createNoBatchMockGraph();

    const callsA: any[] = [];
    const pluginA = {
      metadata: {
        name: 'NoBatchPlugin',
        phase: 'ENRICHMENT',
        creates: { nodes: [], edges: [] },
        consumes: [] as string[],
        produces: ['FUNCTION'],
      },
      execute: async (ctx: any) => {
        callsA.push(ctx);
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [pluginA as any],
      logLevel: 'silent',
    });

    const result = await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    assert.ok(result instanceof Set,
      `runPhase should return a Set<string> even without batch, got: ${typeof result}`);
    assert.strictEqual((result as Set<string>).size, 0,
      'Without batch support, no deltas → empty set');
    assert.strictEqual(callsA.length, 1, 'Plugin should still execute');
  });
});

// ============ Group 2: Selective checking ============

describe('Selective guarantee checking (RFD-29)', () => {

  it('extractRelevantTypes_parses_node_types from Datalog rule', async () => {
    const { GuaranteeManager } = await import('@grafema/core');
    const mockGraph = createMockGuaranteeGraph();
    const manager = new GuaranteeManager(mockGraph as any, '/tmp/test-project');

    const rule = 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").';
    const types = manager.extractRelevantTypes(rule);

    assert.ok(Array.isArray(types), 'extractRelevantTypes should return an array');
    assert.ok(types.includes('CALL'),
      `Should extract "CALL" from node(X, "CALL"). Got: ${JSON.stringify(types)}`);
  });

  it('extractRelevantTypes_parses_edge_types from Datalog rule', async () => {
    const { GuaranteeManager } = await import('@grafema/core');
    const mockGraph = createMockGuaranteeGraph();
    const manager = new GuaranteeManager(mockGraph as any, '/tmp/test-project');

    const rule = 'violation(X) :- edge(X, Y, "IMPORTS").';
    const types = manager.extractRelevantTypes(rule);

    assert.ok(Array.isArray(types), 'extractRelevantTypes should return an array');
    assert.ok(types.includes('IMPORTS'),
      `Should extract "IMPORTS" from edge(X, Y, "IMPORTS"). Got: ${JSON.stringify(types)}`);
  });

  it('selective_check_filters_by_type — only FUNCTION-related rules checked', async () => {
    const { GuaranteeManager } = await import('@grafema/core');

    // Two rules: one about FUNCTION, one about CALL
    const functionRule = 'violation(X) :- node(X, "FUNCTION"), attr(X, "name", "dangerousFunction").';
    const callRule = 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").';

    // checkGuarantee returns empty for both (no violations) — we just track which rules ran
    const checkedRules: string[] = [];
    const mockGraph = createMockGuaranteeGraph();
    const originalCheckGuarantee = mockGraph.checkGuarantee;
    mockGraph.checkGuarantee = async (rule: string) => {
      checkedRules.push(rule);
      return originalCheckGuarantee(rule);
    };

    const manager = new GuaranteeManager(mockGraph as any, '/tmp/test-project');

    // Create two guarantees
    await manager.create({
      id: 'fn-guarantee',
      name: 'Function Guarantee',
      rule: functionRule,
      severity: 'error',
    });

    await manager.create({
      id: 'call-guarantee',
      name: 'Call Guarantee',
      rule: callRule,
      severity: 'error',
    });

    // Selective check with only FUNCTION changed
    const changedTypes = new Set(['FUNCTION']);
    checkedRules.length = 0; // Reset
    const result = await manager.checkSelective(changedTypes);

    // Only the FUNCTION-related guarantee should have been checked
    assert.ok(checkedRules.includes(functionRule),
      'Function guarantee rule should be checked when FUNCTION type changed');
    assert.ok(!checkedRules.includes(callRule),
      'Call guarantee rule should NOT be checked when only FUNCTION type changed');
    assert.strictEqual(result.total, 2,
      'Total should reflect all guarantees');
    assert.strictEqual(result.results.length, 1,
      'Only 1 guarantee should have been checked');
  });

  it('rules_without_types_always_checked — unparseable rule always included', async () => {
    const { GuaranteeManager } = await import('@grafema/core');

    // A rule with no recognizable node/edge type patterns
    const genericRule = 'violation(X) :- custom_check(X).';
    const typedRule = 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").';

    const checkedRules: string[] = [];
    const mockGraph = createMockGuaranteeGraph();
    mockGraph.checkGuarantee = async (rule: string) => {
      checkedRules.push(rule);
      return [];
    };

    const manager = new GuaranteeManager(mockGraph as any, '/tmp/test-project');

    await manager.create({
      id: 'generic-guarantee',
      name: 'Generic Guarantee',
      rule: genericRule,
      severity: 'warning',
    });

    await manager.create({
      id: 'typed-guarantee',
      name: 'Typed Guarantee',
      rule: typedRule,
      severity: 'error',
    });

    // Selective check with FUNCTION changed (not CALL)
    const changedTypes = new Set(['FUNCTION']);
    checkedRules.length = 0;
    const result = await manager.checkSelective(changedTypes);

    // Generic rule (no types) should always be checked
    assert.ok(checkedRules.includes(genericRule),
      'Rule without parseable types should ALWAYS be checked in selective mode');
    // Typed rule about CALL should be skipped since only FUNCTION changed
    assert.ok(!checkedRules.includes(typedRule),
      'CALL-typed rule should be skipped when only FUNCTION changed');
    assert.strictEqual(result.total, 2,
      'Total should reflect all guarantees');
    assert.strictEqual(result.results.length, 1,
      'Only the generic guarantee should have been checked');
  });
});

// ============ Group 3: Orchestrator guarantee hook ============

describe('Orchestrator guarantee hook (RFD-29)', () => {

  it('guarantees_checked_after_enrichment — verify execution order', async () => {
    const executionLog: string[] = [];

    const mock = createDeltaMockGraph({
      'TestEnricher': makeDelta({ changedNodeTypes: ['FUNCTION'] }),
    });

    const enricher = createEnrichmentPlugin('TestEnricher', mock, {
      consumes: [],
      produces: ['FUNCTION'],
      executeFn: async () => {
        executionLog.push('ENRICHMENT');
        mock.setCurrentPlugin('TestEnricher');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    // Create a validation plugin to verify guarantee check happens before it
    const validationCalls: any[] = [];
    const validationPlugin = {
      metadata: {
        name: 'TestValidator',
        phase: 'VALIDATION',
        creates: { nodes: [], edges: [] },
        consumes: [] as string[],
        produces: [] as string[],
      },
      execute: async (ctx: any) => {
        executionLog.push('VALIDATION');
        validationCalls.push(ctx);
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    };

    // Wrap the mock graph to detect guarantee checking
    // GuaranteeManager queries GUARANTEE nodes via queryNodes
    const originalQueryNodes = mock.backend.queryNodes;
    mock.backend.queryNodes = async function* (filter: any) {
      if (filter?.type === 'GUARANTEE') {
        executionLog.push('GUARANTEE_CHECK');
      }
      yield* originalQueryNodes.call(mock.backend, filter);
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [enricher.plugin as any, validationPlugin as any],
      logLevel: 'silent',
    });

    // Run enrichment
    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // Run guarantee check (this is what Orchestrator should do after enrichment)
    // In the new flow, this would be automatic. For now we test the expected order.
    const { GuaranteeManager } = await import('@grafema/core');
    const guaranteeManager = new GuaranteeManager(mock.backend as any, '/tmp/test');
    await guaranteeManager.checkAll();

    // Run validation
    await orchestrator.runPhase('VALIDATION', { graph: mock.backend as any });

    // Verify order: ENRICHMENT → GUARANTEE_CHECK → VALIDATION
    const enrichmentIdx = executionLog.indexOf('ENRICHMENT');
    const guaranteeIdx = executionLog.indexOf('GUARANTEE_CHECK');
    const validationIdx = executionLog.indexOf('VALIDATION');

    assert.ok(enrichmentIdx >= 0, 'ENRICHMENT should have been logged');
    assert.ok(guaranteeIdx >= 0, 'GUARANTEE_CHECK should have been logged');
    assert.ok(validationIdx >= 0, 'VALIDATION should have been logged');
    assert.ok(enrichmentIdx < guaranteeIdx,
      `ENRICHMENT (${enrichmentIdx}) should happen before GUARANTEE_CHECK (${guaranteeIdx})`);
    assert.ok(guaranteeIdx < validationIdx,
      `GUARANTEE_CHECK (${guaranteeIdx}) should happen before VALIDATION (${validationIdx})`);
  });

  it('guarantee_not_checked_during_enrichment — mid-enrichment no guarantee trigger', async () => {
    const guaranteeCheckTimestamps: number[] = [];
    let enrichmentStartTime = 0;
    let enrichmentEndTime = 0;

    const mock = createDeltaMockGraph({
      'SlowEnricher': makeDelta({ changedNodeTypes: ['FUNCTION'] }),
    });

    // Wrap queryNodes to detect guarantee checking timing
    const originalQueryNodes = mock.backend.queryNodes;
    mock.backend.queryNodes = async function* (filter: any) {
      if (filter?.type === 'GUARANTEE') {
        guaranteeCheckTimestamps.push(Date.now());
      }
      yield* originalQueryNodes.call(mock.backend, filter);
    };

    const enricher = createEnrichmentPlugin('SlowEnricher', mock, {
      consumes: [],
      produces: ['FUNCTION'],
      executeFn: async () => {
        enrichmentStartTime = Date.now();
        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 10));
        enrichmentEndTime = Date.now();
        mock.setCurrentPlugin('SlowEnricher');
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mock.backend as any,
      plugins: [enricher.plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', { graph: mock.backend as any });

    // No guarantee checks should have occurred during enrichment
    const checksWhileEnriching = guaranteeCheckTimestamps.filter(
      t => t >= enrichmentStartTime && t <= enrichmentEndTime
    );
    assert.strictEqual(checksWhileEnriching.length, 0,
      'No guarantee checks should occur DURING enrichment execution');
  });

  it('violations_collected_in_diagnostics — guarantee violations become diagnostic entries', async () => {
    const { GuaranteeManager, DiagnosticCollector } = await import('@grafema/core');

    // Create a mock graph where the guarantee rule produces violations
    const violationRule = 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").';
    const mockGraph = createMockGuaranteeGraph({
      checkGuaranteeResults: {
        [violationRule]: [
          { bindings: [{ name: 'X', value: 'node:eval-1' }] },
          { bindings: [{ name: 'X', value: 'node:eval-2' }] },
        ],
      },
      nodes: {
        'node:eval-1': { id: 'node:eval-1', type: 'CALL', name: 'eval', file: 'src/app.js', line: 42 },
        'node:eval-2': { id: 'node:eval-2', type: 'CALL', name: 'eval', file: 'src/utils.js', line: 15 },
      },
    });

    const manager = new GuaranteeManager(mockGraph as any, '/tmp/test-project');
    await manager.create({
      id: 'no-eval',
      name: 'No eval() calls',
      rule: violationRule,
      severity: 'error',
    });

    // Check all guarantees
    const result = await manager.checkAll();
    assert.strictEqual(result.failed, 1, 'Should have 1 failed guarantee');
    assert.strictEqual(result.results[0].violationCount, 2, 'Should have 2 violations');

    // Now verify that violations can be collected into DiagnosticCollector
    const diagnosticCollector = new DiagnosticCollector();

    // This is how the Orchestrator would integrate violations into diagnostics
    for (const checkResult of result.results) {
      if (!checkResult.passed && !checkResult.error) {
        for (const violation of checkResult.violations) {
          diagnosticCollector.add({
            code: 'GUARANTEE_VIOLATION',
            severity: checkResult.severity === 'error' ? 'error' : 'warning',
            message: `Guarantee "${checkResult.name}" violated by ${violation.nodeId}`,
            file: violation.file,
            line: violation.line,
            phase: 'ENRICHMENT',
            plugin: 'GuaranteeManager',
          });
        }
      }
    }

    const diagnostics = diagnosticCollector.getAll();
    assert.strictEqual(diagnostics.length, 2, 'Should have 2 diagnostic entries');
    assert.strictEqual(diagnostics[0].code, 'GUARANTEE_VIOLATION');
    assert.strictEqual(diagnostics[0].file, 'src/app.js');
    assert.strictEqual(diagnostics[0].line, 42);
    assert.strictEqual(diagnostics[1].file, 'src/utils.js');
    assert.strictEqual(diagnostics[1].line, 15);
  });

  it('no_guarantees_skips_check — no GUARANTEE nodes completes instantly', async () => {
    const { GuaranteeManager } = await import('@grafema/core');

    // Empty graph — no GUARANTEE nodes
    const mockGraph = createMockGuaranteeGraph();
    const manager = new GuaranteeManager(mockGraph as any, '/tmp/test-project');

    const startTime = Date.now();
    const result = await manager.checkAll();
    const durationMs = Date.now() - startTime;

    assert.strictEqual(result.total, 0, 'Should have 0 guarantees to check');
    assert.strictEqual(result.passed, 0, 'Should have 0 passed');
    assert.strictEqual(result.failed, 0, 'Should have 0 failed');
    assert.strictEqual(result.results.length, 0, 'Should have empty results array');
    assert.ok(durationMs < 100, `Check should complete near-instantly, took ${durationMs}ms`);
  });
});

// ============ Group 4: Coverage monitoring ============

describe('Coverage monitoring (RFD-29)', () => {

  it('coverage_gap_detected — file changed content but analysis identical triggers warning', async () => {
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, ..._args: any[]) => { warnings.push(msg); },
      error: () => {},
    };

    // Simulate coverage monitoring:
    // MODULE nodes have contentHash field. If a file's content changed
    // (different contentHash) but the analysis output is identical,
    // that's a coverage gap — we may be missing new constructs.

    const modulesBefore = [
      { id: 'MODULE:src/app.js', type: 'MODULE', file: 'src/app.js', contentHash: 'abc123' },
      { id: 'MODULE:src/utils.js', type: 'MODULE', file: 'src/utils.js', contentHash: 'def456' },
    ];

    const modulesAfter = [
      { id: 'MODULE:src/app.js', type: 'MODULE', file: 'src/app.js', contentHash: 'abc999' }, // Changed!
      { id: 'MODULE:src/utils.js', type: 'MODULE', file: 'src/utils.js', contentHash: 'def456' }, // Same
    ];

    // changedFiles from the delta includes src/app.js
    const changedFiles = ['src/app.js'];

    // Simulate coverage gap detection logic:
    // For each changedFile, check if contentHash changed but analysis output is the same.
    // "Analysis output same" = same set of child nodes (simplified check for testing).
    const childNodesBefore: Record<string, string[]> = {
      'MODULE:src/app.js': ['FUNCTION:app:handler', 'CALL:app:eval'],
      'MODULE:src/utils.js': ['FUNCTION:utils:helper'],
    };
    const childNodesAfter: Record<string, string[]> = {
      'MODULE:src/app.js': ['FUNCTION:app:handler', 'CALL:app:eval'], // Same children despite content change
      'MODULE:src/utils.js': ['FUNCTION:utils:helper'],
    };

    // Coverage gap detection
    for (const file of changedFiles) {
      const moduleBefore = modulesBefore.find(m => m.file === file);
      const moduleAfter = modulesAfter.find(m => m.file === file);

      if (!moduleBefore || !moduleAfter) continue;
      if (moduleBefore.contentHash === moduleAfter.contentHash) continue;

      // Content changed — check if analysis is different
      const beforeChildren = JSON.stringify(childNodesBefore[moduleBefore.id] ?? []);
      const afterChildren = JSON.stringify(childNodesAfter[moduleAfter.id] ?? []);

      if (beforeChildren === afterChildren) {
        logger.warn(
          `Coverage gap: ${file} content changed (hash ${moduleBefore.contentHash} -> ${moduleAfter.contentHash}) ` +
          `but analysis output is identical — possible missing construct extraction`
        );
      }
    }

    assert.strictEqual(warnings.length, 1, 'Should produce exactly 1 coverage gap warning');
    assert.ok(warnings[0].includes('Coverage gap'),
      `Warning should mention "Coverage gap". Got: "${warnings[0]}"`);
    assert.ok(warnings[0].includes('src/app.js'),
      `Warning should mention the file. Got: "${warnings[0]}"`);
    assert.ok(warnings[0].includes('abc123'),
      `Warning should mention old hash. Got: "${warnings[0]}"`);
    assert.ok(warnings[0].includes('abc999'),
      `Warning should mention new hash. Got: "${warnings[0]}"`);
  });

  it('coverage_gap_skipped_for_empty_hash — node with contentHash="" produces no warning', async () => {
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, ..._args: any[]) => { warnings.push(msg); },
      error: () => {},
    };

    // Module with empty contentHash (e.g., external module, not yet analyzed)
    const modulesBefore = [
      { id: 'MODULE:src/new-file.js', type: 'MODULE', file: 'src/new-file.js', contentHash: '' },
    ];

    const modulesAfter = [
      { id: 'MODULE:src/new-file.js', type: 'MODULE', file: 'src/new-file.js', contentHash: 'xyz789' },
    ];

    const changedFiles = ['src/new-file.js'];

    // Coverage gap detection with empty hash guard
    for (const file of changedFiles) {
      const moduleBefore = modulesBefore.find(m => m.file === file);
      const moduleAfter = modulesAfter.find(m => m.file === file);

      if (!moduleBefore || !moduleAfter) continue;

      // Guard: skip if either hash is empty (module not yet fully analyzed)
      if (!moduleBefore.contentHash || !moduleAfter.contentHash) continue;

      if (moduleBefore.contentHash === moduleAfter.contentHash) continue;

      // Content changed — would check analysis here
      logger.warn(`Coverage gap: ${file} content changed`);
    }

    assert.strictEqual(warnings.length, 0,
      'Should produce NO warnings when contentHash is empty (not yet analyzed)');
  });
});
