/**
 * Orchestrator Multi-Root Strict Mode Barrier (REG-391)
 *
 * Verifies that runMultiRoot() has the same strict mode barrier
 * after ENRICHMENT as the single-root run() path.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import {
  Orchestrator,
  StrictModeFailure,
  StrictModeError,
} from '@grafema/core';

after(cleanupAllTestDatabases);

/** Mock discovery plugin that returns a single service per root */
function createMockDiscoveryPlugin() {
  return {
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
  };
}

/** No-op indexing plugin */
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

/** Enrichment plugin that produces strict mode errors */
function createMockEnrichmentPlugin({ errors = [], suppressedByIgnore = 0 } = {}) {
  return {
    metadata: {
      name: 'MockEnrichmentPlugin',
      phase: 'ENRICHMENT',
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

describe('Multi-root strict mode barrier (REG-391)', () => {
  const testDir = join(process.cwd(), 'test/fixtures/multi-root-strict-test');

  function ensureTestDirs() {
    for (const sub of ['root1', 'root2']) {
      const dir = join(testDir, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  it('should throw StrictModeFailure in multi-root path when strict errors exist', async () => {
    ensureTestDirs();
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
          createMockDiscoveryPlugin(),
          createMockIndexingPlugin(),
          createMockEnrichmentPlugin({
            errors: [strictError],
            suppressedByIgnore: 2,
          }),
        ],
        strictMode: true,
        workspaceRoots: ['root1', 'root2'],
        logLevel: 'silent',
      });

      let caughtError = null;
      try {
        await orchestrator.run(testDir);
      } catch (e) {
        caughtError = e;
      }

      assert.ok(caughtError instanceof StrictModeFailure, 'Should throw StrictModeFailure');
      assert.strictEqual(caughtError.count, 1, 'Should have 1 error');
      assert.strictEqual(caughtError.suppressedCount, 2, 'Should pass suppressedByIgnore from plugin result');
    } finally {
      await backend.close();
    }
  });

  it('should not throw when no strict errors in multi-root path', async () => {
    ensureTestDirs();
    const db = await createTestDatabase();
    const backend = db.backend;

    try {
      const orchestrator = new Orchestrator({
        graph: backend,
        plugins: [
          createMockDiscoveryPlugin(),
          createMockIndexingPlugin(),
          createMockEnrichmentPlugin({
            errors: [],
            suppressedByIgnore: 5,
          }),
        ],
        strictMode: true,
        workspaceRoots: ['root1', 'root2'],
        logLevel: 'silent',
      });

      // Should NOT throw
      await orchestrator.run(testDir);
    } finally {
      await backend.close();
    }
  });
});
