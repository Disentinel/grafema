/**
 * Orchestrator Strict Mode - suppressedCount passthrough (REG-357)
 *
 * Verifies that Orchestrator collects suppressedByIgnore from enrichment
 * plugin results and passes it to StrictModeFailure.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import {
  Orchestrator,
  StrictModeFailure,
  StrictModeError,
  DatabaseError,
} from '@grafema/core';

after(cleanupAllTestDatabases);

/**
 * Minimal enrichment plugin that returns suppressedByIgnore in metadata
 * and optionally produces StrictModeError errors.
 */
function createMockEnrichmentPlugin({ errors = [], suppressedByIgnore = 0 } = {}) {
  return {
    metadata: {
      name: 'MockEnrichmentPlugin',
      phase: 'ENRICHMENT',
      priority: 50,
      creates: { nodes: [], edges: [] },
    },
    execute: async () => ({
      success: true,
      created: { nodes: 0, edges: 0 },
      errors,
      warnings: [],
      metadata: { suppressedByIgnore },
    }),
  };
}

/**
 * Minimal discovery plugin that returns a single service.
 */
function createMockDiscoveryPlugin(projectPath) {
  return {
    metadata: {
      name: 'MockDiscovery',
      phase: 'DISCOVERY',
      priority: 100,
      creates: { nodes: [], edges: [] },
    },
    execute: async () => ({
      success: true,
      created: { nodes: 0, edges: 0 },
      errors: [],
      warnings: [],
      metadata: {
        services: [{
          id: 'svc:test',
          name: 'test',
          path: projectPath,
          metadata: { entrypoint: projectPath + '/index.js' },
        }],
      },
    }),
  };
}

/**
 * No-op indexing plugin
 */
function createMockIndexingPlugin() {
  return {
    metadata: {
      name: 'MockIndexer',
      phase: 'INDEXING',
      priority: 100,
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

describe('Orchestrator strict mode suppressedCount (REG-357)', () => {
  it('should pass suppressedByIgnore from plugin results to StrictModeFailure', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const strictError = new StrictModeError(
        'Cannot resolve: obj.method',
        'STRICT_UNRESOLVED_METHOD',
        { filePath: 'test.js', lineNumber: 1, phase: 'ENRICHMENT', plugin: 'MockEnrichmentPlugin' },
        'Check imports'
      );

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project'),
          createMockIndexingPlugin(),
          createMockEnrichmentPlugin({
            errors: [strictError],
            suppressedByIgnore: 3,
          }),
        ],
        strictMode: true,
        logLevel: 'silent',
      });

      let caughtError = null;
      try {
        await orchestrator.run('/tmp/test-project');
      } catch (e) {
        caughtError = e;
      }

      assert.ok(caughtError instanceof StrictModeFailure, 'Should throw StrictModeFailure');
      assert.strictEqual(caughtError.count, 1, 'Should have 1 error');
      assert.strictEqual(caughtError.suppressedCount, 3, 'Should pass suppressedByIgnore=3 from plugin result');
    } finally {
      await backend.close();
    }
  });

  it('should sum suppressedByIgnore across multiple enrichment plugins', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const strictError = new StrictModeError(
        'Cannot resolve: obj.method',
        'STRICT_UNRESOLVED_METHOD',
        { filePath: 'test.js', lineNumber: 1, phase: 'ENRICHMENT', plugin: 'MockEnrichmentPlugin' },
        'Check imports'
      );

      // First enrichment plugin: 2 suppressed
      const plugin1 = createMockEnrichmentPlugin({
        errors: [strictError],
        suppressedByIgnore: 2,
      });
      plugin1.metadata.name = 'Enricher1';
      plugin1.metadata.priority = 60;

      // Second enrichment plugin: 5 suppressed, no errors
      const plugin2 = createMockEnrichmentPlugin({
        errors: [],
        suppressedByIgnore: 5,
      });
      plugin2.metadata.name = 'Enricher2';
      plugin2.metadata.priority = 40;

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project'),
          createMockIndexingPlugin(),
          plugin1,
          plugin2,
        ],
        strictMode: true,
        logLevel: 'silent',
      });

      let caughtError = null;
      try {
        await orchestrator.run('/tmp/test-project');
      } catch (e) {
        caughtError = e;
      }

      assert.ok(caughtError instanceof StrictModeFailure, 'Should throw StrictModeFailure');
      assert.strictEqual(caughtError.suppressedCount, 7, 'Should sum: 2 + 5 = 7');
    } finally {
      await backend.close();
    }
  });

  it('should default to 0 when no plugin reports suppressedByIgnore', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const strictError = new StrictModeError(
        'Cannot resolve: obj.method',
        'STRICT_UNRESOLVED_METHOD',
        { filePath: 'test.js', lineNumber: 1, phase: 'ENRICHMENT', plugin: 'MockEnrichmentPlugin' },
        'Check imports'
      );

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project'),
          createMockIndexingPlugin(),
          createMockEnrichmentPlugin({
            errors: [strictError],
            // No suppressedByIgnore
          }),
        ],
        strictMode: true,
        logLevel: 'silent',
      });

      let caughtError = null;
      try {
        await orchestrator.run('/tmp/test-project');
      } catch (e) {
        caughtError = e;
      }

      assert.ok(caughtError instanceof StrictModeFailure, 'Should throw StrictModeFailure');
      assert.strictEqual(caughtError.suppressedCount, 0, 'Should default to 0');
    } finally {
      await backend.close();
    }
  });

  it('should not throw StrictModeFailure when no fatal errors exist', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project'),
          createMockIndexingPlugin(),
          createMockEnrichmentPlugin({
            errors: [],
            suppressedByIgnore: 5,
          }),
        ],
        strictMode: true,
        logLevel: 'silent',
      });

      // Should NOT throw - all errors were suppressed
      await orchestrator.run('/tmp/test-project');
      // If we get here, test passes
    } finally {
      await backend.close();
    }
  });

  it('should halt on non-strict fatal errors even in strict mode ENRICHMENT', async () => {
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      // Plugin that returns a non-strict fatal error (DatabaseError)
      const nonStrictFatalPlugin = {
        metadata: {
          name: 'FailingEnricher',
          phase: 'ENRICHMENT',
          priority: 50,
          creates: { nodes: [], edges: [] },
        },
        execute: async () => ({
          success: false,
          created: { nodes: 0, edges: 0 },
          errors: [new DatabaseError('DB corrupted', 'ERR_DATABASE_CORRUPTED')],
          warnings: [],
          metadata: {},
        }),
      };

      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin('/tmp/test-project'),
          createMockIndexingPlugin(),
          nonStrictFatalPlugin,
        ],
        strictMode: true,
        logLevel: 'silent',
      });

      let caughtError = null;
      try {
        await orchestrator.run('/tmp/test-project');
      } catch (e) {
        caughtError = e;
      }

      // Should throw a generic Error, NOT StrictModeFailure
      assert.ok(caughtError !== null, 'Should throw an error');
      assert.ok(!(caughtError instanceof StrictModeFailure), 'Should NOT be StrictModeFailure');
      assert.ok(caughtError.message.includes('DB corrupted'), 'Should contain the fatal error message');
    } finally {
      await backend.close();
    }
  });
});
