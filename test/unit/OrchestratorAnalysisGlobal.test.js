/**
 * Orchestrator ANALYSIS Phase — Global Execution (REG-478)
 *
 * Verifies that the ANALYSIS phase runs globally (once for all modules)
 * rather than per-service/per-unit. This change reduces plugin executions
 * from S×P to P (where S = services, P = analysis plugins).
 *
 * The key behavioral change:
 * - BEFORE: runBatchPhase('ANALYSIS', ...) iterates over each unit,
 *   calling runPhase('ANALYSIS', ...) with a UnitManifest per unit.
 * - AFTER: runPhase('ANALYSIS', ...) is called ONCE with the full
 *   DiscoveryManifest, matching the ENRICHMENT pattern.
 *
 * Test approach: mock ANALYSIS plugins count their execute() calls.
 * With per-service execution: execute() called S times (once per service).
 * With global execution: execute() called exactly once.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { Orchestrator } from '@grafema/core';

after(cleanupAllTestDatabases);

// ============================================================================
// Mock Plugin Factories
// ============================================================================

/**
 * Mock discovery plugin that returns N services.
 * Each service has a unique name and path.
 */
function createMockDiscoveryPlugin(projectPath, serviceCount = 3) {
  const services = [];
  for (let i = 0; i < serviceCount; i++) {
    services.push({
      id: `svc:service-${i}`,
      name: `service-${i}`,
      path: `${projectPath}/service-${i}`,
      metadata: { entrypoint: `${projectPath}/service-${i}/index.js` },
    });
  }

  return {
    metadata: {
      name: 'MockDiscovery',
      phase: 'DISCOVERY',
      creates: { nodes: [], edges: [] },
    },
    execute: async () => ({
      success: true,
      created: { nodes: 0, edges: 0 },
      errors: [],
      warnings: [],
      metadata: { services },
    }),
  };
}

/**
 * No-op indexing plugin.
 */
function createMockIndexingPlugin() {
  return {
    metadata: {
      name: 'MockIndexer',
      phase: 'INDEXING',
      creates: { nodes: [], edges: [] },
    },
    execute: async () => ({
      success: true,
      created: { nodes: 0, edges: 0 },
      errors: [],
      warnings: [],
      metadata: {},
    }),
  };
}

/**
 * ANALYSIS plugin that counts how many times execute() is called.
 *
 * This is the key tool for testing REG-478:
 * - With per-service execution: executionCount === serviceCount
 * - With global execution: executionCount === 1
 *
 * Also records what manifest type it receives:
 * - UnitManifest (has .service field) = per-service call
 * - DiscoveryManifest (has .services array) = global call
 */
function createCountingAnalysisPlugin(name = 'CountingAnalyzer') {
  const tracker = {
    executionCount: 0,
    manifests: [],   // Records each manifest received
    contexts: [],    // Records each full context
  };

  const plugin = {
    metadata: {
      name,
      phase: 'ANALYSIS',
      creates: { nodes: [], edges: [] },
    },
    execute: async (ctx) => {
      tracker.executionCount++;

      // Record manifest shape for assertion
      const manifest = ctx.manifest;
      tracker.manifests.push({
        hasService: manifest && 'service' in manifest && typeof manifest.service === 'object',
        hasServices: manifest && 'services' in manifest && Array.isArray(manifest.services),
        servicesCount: manifest?.services?.length,
        projectPath: manifest?.projectPath,
      });

      tracker.contexts.push({
        hasGraph: !!ctx.graph,
        workerCount: ctx.workerCount,
        rootPrefix: ctx.rootPrefix,
      });

      return {
        success: true,
        created: { nodes: 0, edges: 0 },
        errors: [],
        warnings: [],
        metadata: {},
      };
    },
    tracker,
  };

  return plugin;
}

/**
 * No-op enrichment plugin (needed to complete the pipeline).
 */
function createMockEnrichmentPlugin() {
  return {
    metadata: {
      name: 'MockEnrichment',
      phase: 'ENRICHMENT',
      creates: { nodes: [], edges: [] },
    },
    execute: async () => ({
      success: true,
      created: { nodes: 0, edges: 0 },
      errors: [],
      warnings: [],
      metadata: {},
    }),
  };
}

// ============================================================================
// Tests: Single-root mode
// ============================================================================

describe('ANALYSIS phase global execution — single-root (REG-478)', () => {

  it('should run ANALYSIS plugins once globally, not per-service', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const SERVICE_COUNT = 3;
      const analyzer1 = createCountingAnalysisPlugin('Analyzer1');
      const analyzer2 = createCountingAnalysisPlugin('Analyzer2');

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project', SERVICE_COUNT),
          createMockIndexingPlugin(),
          analyzer1,
          analyzer2,
          createMockEnrichmentPlugin(),
        ],
        logLevel: 'silent',
      });

      await orchestrator.run('/tmp/test-project');

      // KEY ASSERTION: With global execution, each ANALYSIS plugin
      // should be called exactly 1 time (not SERVICE_COUNT times).
      assert.strictEqual(
        analyzer1.tracker.executionCount, 1,
        `Analyzer1 should execute once globally, not ${SERVICE_COUNT} times per-service. ` +
        `Got ${analyzer1.tracker.executionCount} executions.`
      );

      assert.strictEqual(
        analyzer2.tracker.executionCount, 1,
        `Analyzer2 should execute once globally, not ${SERVICE_COUNT} times per-service. ` +
        `Got ${analyzer2.tracker.executionCount} executions.`
      );
    } finally {
      await backend.close();
    }
  });

  it('should pass full DiscoveryManifest (not UnitManifest) to ANALYSIS plugins', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const SERVICE_COUNT = 3;
      const analyzer = createCountingAnalysisPlugin('ManifestChecker');

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project', SERVICE_COUNT),
          createMockIndexingPlugin(),
          analyzer,
          createMockEnrichmentPlugin(),
        ],
        logLevel: 'silent',
      });

      await orchestrator.run('/tmp/test-project');

      // With global execution, the manifest should be DiscoveryManifest
      // (has .services array), NOT UnitManifest (has .service object).
      assert.strictEqual(analyzer.tracker.manifests.length, 1,
        'Should have exactly one manifest recorded');

      const manifest = analyzer.tracker.manifests[0];
      assert.strictEqual(manifest.hasServices, true,
        'Manifest should have .services array (DiscoveryManifest shape)');
      assert.strictEqual(manifest.hasService, false,
        'Manifest should NOT have .service object (UnitManifest shape)');
      assert.strictEqual(manifest.servicesCount, SERVICE_COUNT,
        `Manifest should contain all ${SERVICE_COUNT} services`);
    } finally {
      await backend.close();
    }
  });

  it('should call runPhase not runBatchPhase for ANALYSIS (verified by execution count)', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      // Use 5 services to make the difference obvious
      const SERVICE_COUNT = 5;
      const analyzer = createCountingAnalysisPlugin('ExecutionCounter');

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project', SERVICE_COUNT),
          createMockIndexingPlugin(),
          analyzer,
          createMockEnrichmentPlugin(),
        ],
        logLevel: 'silent',
      });

      await orchestrator.run('/tmp/test-project');

      // With runBatchPhase: executionCount === 5 (one per service)
      // With runPhase (global): executionCount === 1
      // This test will FAIL with the current code (pre-REG-478).
      assert.strictEqual(
        analyzer.tracker.executionCount, 1,
        `ANALYSIS plugin should execute exactly once (global). ` +
        `Found ${analyzer.tracker.executionCount} executions — ` +
        `if this equals ${SERVICE_COUNT}, ANALYSIS is still running per-service.`
      );
    } finally {
      await backend.close();
    }
  });

  it('should skip ANALYSIS in indexOnly mode', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const analyzer = createCountingAnalysisPlugin('IndexOnlyChecker');

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project', 3),
          createMockIndexingPlugin(),
          analyzer,
          createMockEnrichmentPlugin(),
        ],
        indexOnly: true,
        logLevel: 'silent',
      });

      await orchestrator.run('/tmp/test-project');

      // In indexOnly mode, ANALYSIS should be completely skipped.
      assert.strictEqual(
        analyzer.tracker.executionCount, 0,
        'ANALYSIS plugins should not execute in indexOnly mode'
      );
    } finally {
      await backend.close();
    }
  });
});

// ============================================================================
// Tests: Multi-root mode
// ============================================================================

describe('ANALYSIS phase global execution — multi-root (REG-478)', () => {
  const testDir = join(process.cwd(), 'test/fixtures/analysis-global-test');

  function ensureTestDirs() {
    for (const sub of ['root1', 'root2', 'root3']) {
      const dir = join(testDir, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  it('should run ANALYSIS once globally AFTER all roots are indexed', async () => {
    ensureTestDirs();
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const analyzer = createCountingAnalysisPlugin('MultiRootAnalyzer');

      // Track indexing calls to verify ordering
      const indexingTracker = { executionCount: 0 };
      const indexingPlugin = {
        metadata: {
          name: 'TrackingIndexer',
          phase: 'INDEXING',
          creates: { nodes: [], edges: [] },
        },
        execute: async () => {
          indexingTracker.executionCount++;
          return {
            success: true,
            created: { nodes: 0, edges: 0 },
            errors: [],
            warnings: [],
            metadata: {},
          };
        },
      };

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          // Discovery plugin that works per-root
          {
            metadata: {
              name: 'MockDiscovery',
              phase: 'DISCOVERY',
              creates: { nodes: [], edges: [] },
            },
            execute: async (ctx) => ({
              success: true,
              created: { nodes: 0, edges: 0 },
              errors: [],
              warnings: [],
              metadata: {
                services: [{
                  id: `svc:test-${ctx.projectPath}`,
                  name: 'test',
                  path: ctx.projectPath,
                  metadata: { entrypoint: ctx.projectPath + '/index.js' },
                }],
              },
            }),
          },
          indexingPlugin,
          analyzer,
          createMockEnrichmentPlugin(),
        ],
        workspaceRoots: ['root1', 'root2', 'root3'],
        logLevel: 'silent',
      });

      await orchestrator.run(testDir);

      // With 3 roots, each with 1 service:
      // INDEXING should run per-root-per-service (that's correct — 3 times minimum)
      // ANALYSIS should run ONCE globally (not 3 times per-root)
      assert.strictEqual(
        analyzer.tracker.executionCount, 1,
        `ANALYSIS should execute once globally after all roots indexed. ` +
        `Got ${analyzer.tracker.executionCount} executions — ` +
        `if this equals 3 or more, ANALYSIS is still running per-root.`
      );

      // INDEXING should have run (at least once per root)
      assert.ok(
        indexingTracker.executionCount >= 3,
        `INDEXING should run at least once per root (3 roots). ` +
        `Got ${indexingTracker.executionCount} executions.`
      );
    } finally {
      await backend.close();
    }
  });

  it('should skip ANALYSIS in multi-root indexOnly mode', async () => {
    ensureTestDirs();
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const analyzer = createCountingAnalysisPlugin('MultiRootIndexOnly');

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          {
            metadata: {
              name: 'MockDiscovery',
              phase: 'DISCOVERY',
              creates: { nodes: [], edges: [] },
            },
            execute: async (ctx) => ({
              success: true,
              created: { nodes: 0, edges: 0 },
              errors: [],
              warnings: [],
              metadata: {
                services: [{
                  id: `svc:test-${ctx.projectPath}`,
                  name: 'test',
                  path: ctx.projectPath,
                  metadata: { entrypoint: ctx.projectPath + '/index.js' },
                }],
              },
            }),
          },
          createMockIndexingPlugin(),
          analyzer,
          createMockEnrichmentPlugin(),
        ],
        workspaceRoots: ['root1', 'root2'],
        indexOnly: true,
        logLevel: 'silent',
      });

      await orchestrator.run(testDir);

      // In indexOnly mode, ANALYSIS should be completely skipped
      // regardless of single-root or multi-root.
      assert.strictEqual(
        analyzer.tracker.executionCount, 0,
        'ANALYSIS plugins should not execute in multi-root indexOnly mode'
      );
    } finally {
      await backend.close();
    }
  });

  it('should pass unified manifest with all roots to global ANALYSIS', async () => {
    ensureTestDirs();
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const analyzer = createCountingAnalysisPlugin('UnifiedManifestChecker');

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          {
            metadata: {
              name: 'MockDiscovery',
              phase: 'DISCOVERY',
              creates: { nodes: [], edges: [] },
            },
            execute: async (ctx) => ({
              success: true,
              created: { nodes: 0, edges: 0 },
              errors: [],
              warnings: [],
              metadata: {
                services: [{
                  id: `svc:test-${ctx.projectPath}`,
                  name: 'test',
                  path: ctx.projectPath,
                  metadata: { entrypoint: ctx.projectPath + '/index.js' },
                }],
              },
            }),
          },
          createMockIndexingPlugin(),
          analyzer,
          createMockEnrichmentPlugin(),
        ],
        workspaceRoots: ['root1', 'root2', 'root3'],
        logLevel: 'silent',
      });

      await orchestrator.run(testDir);

      // Global ANALYSIS should receive a unified manifest containing
      // services from ALL roots, not a per-root manifest.
      assert.strictEqual(analyzer.tracker.manifests.length, 1,
        'Should have exactly one manifest (global ANALYSIS called once)');

      const manifest = analyzer.tracker.manifests[0];
      assert.strictEqual(manifest.hasServices, true,
        'Multi-root ANALYSIS manifest should have .services array (unified DiscoveryManifest)');
      assert.strictEqual(manifest.hasService, false,
        'Multi-root ANALYSIS manifest should NOT have .service object (UnitManifest)');
    } finally {
      await backend.close();
    }
  });
});

// ============================================================================
// Tests: ANALYSIS runs BEFORE enrichment
// ============================================================================

describe('ANALYSIS phase ordering (REG-478)', () => {

  it('should run ANALYSIS before ENRICHMENT', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      // Track execution order across phases
      const executionOrder = [];

      const analysisPlugin = {
        metadata: {
          name: 'OrderTrackingAnalyzer',
          phase: 'ANALYSIS',
          creates: { nodes: [], edges: [] },
        },
        execute: async () => {
          executionOrder.push('ANALYSIS');
          return {
            success: true,
            created: { nodes: 0, edges: 0 },
            errors: [],
            warnings: [],
            metadata: {},
          };
        },
      };

      const enrichmentPlugin = {
        metadata: {
          name: 'OrderTrackingEnricher',
          phase: 'ENRICHMENT',
          creates: { nodes: [], edges: [] },
        },
        execute: async () => {
          executionOrder.push('ENRICHMENT');
          return {
            success: true,
            created: { nodes: 0, edges: 0 },
            errors: [],
            warnings: [],
            metadata: {},
          };
        },
      };

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project', 2),
          createMockIndexingPlugin(),
          analysisPlugin,
          enrichmentPlugin,
        ],
        logLevel: 'silent',
      });

      await orchestrator.run('/tmp/test-project');

      // Find the LAST ANALYSIS and FIRST ENRICHMENT to verify ordering.
      const lastAnalysisIdx = executionOrder.lastIndexOf('ANALYSIS');
      const firstEnrichmentIdx = executionOrder.indexOf('ENRICHMENT');

      assert.ok(lastAnalysisIdx !== -1, 'ANALYSIS should have executed');
      assert.ok(firstEnrichmentIdx !== -1, 'ENRICHMENT should have executed');
      assert.ok(
        lastAnalysisIdx < firstEnrichmentIdx,
        `All ANALYSIS executions should complete before any ENRICHMENT starts. ` +
        `Order: [${executionOrder.join(', ')}]`
      );
    } finally {
      await backend.close();
    }
  });
});

// ============================================================================
// Tests: Multiple ANALYSIS plugins
// ============================================================================

describe('ANALYSIS phase with multiple plugins (REG-478)', () => {

  it('should run each ANALYSIS plugin exactly once with global execution', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const SERVICE_COUNT = 4;
      const PLUGIN_COUNT = 3;

      // Create N analysis plugins, each tracking its own count
      const analyzers = [];
      for (let i = 0; i < PLUGIN_COUNT; i++) {
        analyzers.push(createCountingAnalysisPlugin(`Analyzer_${i}`));
      }

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project', SERVICE_COUNT),
          createMockIndexingPlugin(),
          ...analyzers,
          createMockEnrichmentPlugin(),
        ],
        logLevel: 'silent',
      });

      await orchestrator.run('/tmp/test-project');

      // Total plugin executions should be PLUGIN_COUNT (not SERVICE_COUNT * PLUGIN_COUNT).
      const totalExecutions = analyzers.reduce((sum, a) => sum + a.tracker.executionCount, 0);

      // With global execution: P = 3 total executions
      // With per-service: S * P = 4 * 3 = 12 total executions
      assert.strictEqual(
        totalExecutions, PLUGIN_COUNT,
        `Total ANALYSIS plugin executions should be ${PLUGIN_COUNT} (P), ` +
        `not ${SERVICE_COUNT * PLUGIN_COUNT} (S*P). Got ${totalExecutions}.`
      );

      // Each individual plugin should execute exactly once
      for (const analyzer of analyzers) {
        assert.strictEqual(
          analyzer.tracker.executionCount, 1,
          `${analyzer.metadata.name} should execute exactly 1 time, ` +
          `got ${analyzer.tracker.executionCount}`
        );
      }
    } finally {
      await backend.close();
    }
  });
});
