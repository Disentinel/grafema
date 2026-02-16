/**
 * Plugin applicability filter tests (REG-482)
 *
 * Tests the ANALYSIS phase plugin skip logic based on `plugin.metadata.covers`
 * matching against service package.json dependencies.
 *
 * 1. extractServiceDependencies() — extracts dependency names from manifest
 * 2. Plugin skip logic — skips ANALYSIS plugins when covers don't match service deps
 * 3. Backward compatibility — plugins without covers always run
 * 4. Phase isolation — filter only applies to ANALYSIS, not ENRICHMENT
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Create a minimal mock graph backend (no batch support needed for these tests).
 */
function createMockGraph() {
  return {
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
  };
}

/**
 * Create a mock ANALYSIS plugin that tracks execution calls.
 * Supports `covers` metadata for the applicability filter.
 */
function createAnalysisPlugin(
  name: string,
  opts: {
    covers?: string[];
    dependencies?: string[];
  } = {},
) {
  const calls: any[] = [];
  const plugin = {
    metadata: {
      name,
      phase: 'ANALYSIS',
      creates: { nodes: [], edges: [] },
      ...(opts.covers !== undefined ? { covers: opts.covers } : {}),
      ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
    },
    execute: async (ctx: any) => {
      calls.push(ctx);
      return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
    },
    calls,
  };
  return plugin;
}

/**
 * Create a mock ENRICHMENT plugin that tracks execution calls.
 * Used to verify the filter does NOT apply to ENRICHMENT phase.
 */
function createEnrichmentPlugin(
  name: string,
  opts: {
    covers?: string[];
    consumes?: string[];
    produces?: string[];
  } = {},
) {
  const calls: any[] = [];
  const plugin = {
    metadata: {
      name,
      phase: 'ENRICHMENT',
      creates: { nodes: [], edges: [] },
      consumes: opts.consumes ?? [],
      produces: opts.produces ?? [],
      ...(opts.covers !== undefined ? { covers: opts.covers } : {}),
    },
    execute: async (ctx: any) => {
      calls.push(ctx);
      return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
    },
    calls,
  };
  return plugin;
}

/**
 * Build a context with manifest containing service metadata and packageJson.
 * Mirrors UnitManifest structure from Orchestrator.runBatchPhase().
 */
function buildContextWithDeps(
  graph: any,
  deps: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  },
) {
  return {
    graph,
    manifest: {
      projectPath: '/test/project',
      service: {
        id: 'svc-1',
        name: 'test-service',
        path: '/test/project/src/index.ts',
        metadata: {
          entrypoint: 'src/index.ts',
          packageJson: {
            name: 'test-service',
            version: '1.0.0',
            ...deps,
          },
        },
      },
      modules: [],
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests for extractServiceDependencies (tested indirectly through plugin skip behavior)
// ──────────────────────────────────────────────────────────────────────────────

describe('Plugin applicability filter — extractServiceDependencies (REG-482)', () => {

  it('service with dependencies — plugin with matching covers RUNS', async () => {
    const graph = createMockGraph();
    const plugin = createAnalysisPlugin('ExpressAnalyzer', { covers: ['express'] });

    const context = buildContextWithDeps(graph, {
      dependencies: { express: '4.18.0', lodash: '4.17.21' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(plugin.calls.length, 1,
      'Plugin should run when service has matching dependency');
  });

  it('service with devDependencies + peerDependencies — merges all dependency types', async () => {
    const graph = createMockGraph();
    const plugin = createAnalysisPlugin('ReactAnalyzer', { covers: ['react'] });

    const context = buildContextWithDeps(graph, {
      dependencies: { lodash: '4.17.21' },
      devDependencies: { jest: '29.0.0' },
      peerDependencies: { react: '18.2.0' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(plugin.calls.length, 1,
      'Plugin should run when covered package is in peerDependencies');
  });

  it('service without packageJson — plugin with covers is SKIPPED', async () => {
    const graph = createMockGraph();
    const plugin = createAnalysisPlugin('ExpressAnalyzer', { covers: ['express'] });

    // Manifest with service that has no metadata.packageJson
    const context = {
      graph,
      manifest: {
        projectPath: '/test/project',
        service: {
          id: 'svc-1',
          name: 'bare-service',
          path: '/test/project/src/index.ts',
        },
        modules: [],
      },
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(plugin.calls.length, 0,
      'Plugin with covers should be SKIPPED when service has no packageJson');
  });

  it('service with empty dependencies object — plugin with covers is SKIPPED', async () => {
    const graph = createMockGraph();
    const plugin = createAnalysisPlugin('ExpressAnalyzer', { covers: ['express'] });

    const context = buildContextWithDeps(graph, {
      dependencies: {},
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(plugin.calls.length, 0,
      'Plugin should be SKIPPED when service has empty dependencies and no match');
  });

  it('non-service unit (no metadata) — plugin with covers is SKIPPED', async () => {
    const graph = createMockGraph();
    const plugin = createAnalysisPlugin('ExpressAnalyzer', { covers: ['express'] });

    // Minimal context without any service metadata — simulates raw entrypoint
    const context = {
      graph,
      manifest: {
        projectPath: '/test/project',
        service: {
          id: 'entry-1',
          name: 'standalone-script',
          path: '/test/project/script.js',
        },
        modules: [],
      },
    };

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [plugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(plugin.calls.length, 0,
      'Plugin with covers should be SKIPPED for units without metadata');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests for plugin skip logic in PhaseRunner.runPhase()
// ──────────────────────────────────────────────────────────────────────────────

describe('Plugin applicability filter — skip logic (REG-482)', () => {

  it('plugin with covers matching service dep RUNS, non-matching SKIPS', async () => {
    const graph = createMockGraph();

    // ExpressAnalyzer matches, NestJS does not
    const expressPlugin = createAnalysisPlugin('ExpressAnalyzer', { covers: ['express'] });
    const nestPlugin = createAnalysisPlugin('NestJSRouteAnalyzer', { covers: ['@nestjs/common', '@nestjs/core'] });

    const context = buildContextWithDeps(graph, {
      dependencies: { express: '4.18.0' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [expressPlugin as any, nestPlugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(expressPlugin.calls.length, 1,
      'ExpressAnalyzer should RUN — express is in service dependencies');
    assert.strictEqual(nestPlugin.calls.length, 0,
      'NestJSRouteAnalyzer should be SKIPPED — @nestjs/common, @nestjs/core not in deps');
  });

  it('plugin with multiple covers — runs if ANY matches (OR logic)', async () => {
    const graph = createMockGraph();

    // DatabaseAnalyzer covers pg, mysql, mysql2 — service has mysql
    const dbPlugin = createAnalysisPlugin('DatabaseAnalyzer', { covers: ['pg', 'mysql', 'mysql2'] });

    const context = buildContextWithDeps(graph, {
      dependencies: { mysql: '2.18.1', express: '4.18.0' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [dbPlugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(dbPlugin.calls.length, 1,
      'DatabaseAnalyzer should RUN — mysql matches (OR logic across covers)');
  });

  it('plugin WITHOUT covers field — always runs (backward compat)', async () => {
    const graph = createMockGraph();

    // JSASTAnalyzer has no covers — should always run
    const basePlugin = createAnalysisPlugin('JSASTAnalyzer');

    const context = buildContextWithDeps(graph, {
      dependencies: { express: '4.18.0' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [basePlugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(basePlugin.calls.length, 1,
      'Plugin without covers should always run for backward compatibility');
  });

  it('plugin with covers: [] (empty array) — always runs', async () => {
    const graph = createMockGraph();

    const emptyCoversPlugin = createAnalysisPlugin('SomePlugin', { covers: [] });

    const context = buildContextWithDeps(graph, {
      dependencies: { express: '4.18.0' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [emptyCoversPlugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(emptyCoversPlugin.calls.length, 1,
      'Plugin with empty covers array should always run');
  });

  it('scoped packages match correctly (@nestjs/common)', async () => {
    const graph = createMockGraph();

    const nestPlugin = createAnalysisPlugin('NestJSRouteAnalyzer', {
      covers: ['@nestjs/common', '@nestjs/core'],
    });

    const context = buildContextWithDeps(graph, {
      dependencies: { '@nestjs/common': '10.0.0', '@nestjs/core': '10.0.0' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [nestPlugin as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.strictEqual(nestPlugin.calls.length, 1,
      'Plugin should match scoped package names correctly');
  });

  it('multiple plugins — mixed run/skip based on service deps', async () => {
    const graph = createMockGraph();
    const executionOrder: string[] = [];

    // JSASTAnalyzer: no covers (always runs)
    const jsAst = createAnalysisPlugin('JSASTAnalyzer');
    const originalJsAstExecute = jsAst.execute;
    jsAst.execute = async (ctx: any) => {
      executionOrder.push('JSASTAnalyzer');
      return originalJsAstExecute(ctx);
    };

    // ExpressAnalyzer: covers express (should run)
    const express = createAnalysisPlugin('ExpressAnalyzer', {
      covers: ['express'],
      dependencies: ['JSASTAnalyzer'],
    });
    const originalExpressExecute = express.execute;
    express.execute = async (ctx: any) => {
      executionOrder.push('ExpressAnalyzer');
      return originalExpressExecute(ctx);
    };

    // ReactAnalyzer: covers react (should skip — no react in deps)
    const react = createAnalysisPlugin('ReactAnalyzer', {
      covers: ['react'],
      dependencies: ['JSASTAnalyzer'],
    });
    const originalReactExecute = react.execute;
    react.execute = async (ctx: any) => {
      executionOrder.push('ReactAnalyzer');
      return originalReactExecute(ctx);
    };

    // SocketIOAnalyzer: covers socket.io (should skip)
    const socketio = createAnalysisPlugin('SocketIOAnalyzer', {
      covers: ['socket.io'],
      dependencies: ['JSASTAnalyzer'],
    });
    const originalSocketExecute = socketio.execute;
    socketio.execute = async (ctx: any) => {
      executionOrder.push('SocketIOAnalyzer');
      return originalSocketExecute(ctx);
    };

    const context = buildContextWithDeps(graph, {
      dependencies: { express: '4.18.0', lodash: '4.17.21' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [jsAst as any, express as any, react as any, socketio as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    assert.ok(executionOrder.includes('JSASTAnalyzer'),
      'JSASTAnalyzer (no covers) should run');
    assert.ok(executionOrder.includes('ExpressAnalyzer'),
      'ExpressAnalyzer (express in deps) should run');
    assert.ok(!executionOrder.includes('ReactAnalyzer'),
      'ReactAnalyzer (react NOT in deps) should be skipped');
    assert.ok(!executionOrder.includes('SocketIOAnalyzer'),
      'SocketIOAnalyzer (socket.io NOT in deps) should be skipped');

    assert.strictEqual(executionOrder.length, 2,
      'Only 2 of 4 plugins should execute (JSASTAnalyzer + ExpressAnalyzer)');
  });

  it('skip is logged with plugin name and covered packages', async () => {
    const graph = createMockGraph();

    const plugin = createAnalysisPlugin('NestJSRouteAnalyzer', {
      covers: ['@nestjs/common', '@nestjs/core'],
    });

    const context = buildContextWithDeps(graph, {
      dependencies: { express: '4.18.0' },
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
      graph: graph as any,
      plugins: [plugin as any],
      logger: logger as any,
    });

    await orchestrator.runPhase('ANALYSIS', context as any);

    const skipMsg = debugMessages.find(m => m.includes('[SKIP]'));
    assert.ok(skipMsg !== undefined,
      `Expected a "[SKIP]" debug log. Got messages: ${JSON.stringify(debugMessages)}`);
    assert.ok(skipMsg!.includes('NestJSRouteAnalyzer'),
      `SKIP message should contain plugin name. Got: "${skipMsg}"`);
    assert.ok(
      skipMsg!.includes('covered packages') || skipMsg!.includes('no covered'),
      `SKIP message should mention covered packages. Got: "${skipMsg}"`);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Phase isolation: filter only applies to ANALYSIS, not ENRICHMENT
// ──────────────────────────────────────────────────────────────────────────────

describe('Plugin applicability filter — phase isolation (REG-482)', () => {

  it('ENRICHMENT plugins with covers are NOT filtered — they always run', async () => {
    const graph = createMockGraph();

    // An enrichment plugin with covers — should NOT be filtered
    const enricher = createEnrichmentPlugin('SomeEnricher', {
      covers: ['nonexistent-package'],
      consumes: [],
      produces: [],
    });

    const context = buildContextWithDeps(graph, {
      dependencies: { express: '4.18.0' },
    });

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: graph as any,
      plugins: [enricher as any],
      logLevel: 'silent',
    });

    await orchestrator.runPhase('ENRICHMENT', context as any);

    assert.strictEqual(enricher.calls.length, 1,
      'ENRICHMENT plugin with non-matching covers should still run — filter is ANALYSIS-only');
  });
});
