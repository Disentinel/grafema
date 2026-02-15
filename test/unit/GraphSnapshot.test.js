/**
 * Graph Snapshot Tests (REG-421)
 *
 * Behavior-locking tests that capture the enriched graph output for
 * fixture projects. Snapshots serve as a safety net for refactoring:
 * if the graph changes unexpectedly, the test fails.
 *
 * To update golden files after intentional changes:
 *   UPDATE_SNAPSHOTS=true node --test test/unit/GraphSnapshot.test.js
 */

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { assertGraph } from '../helpers/GraphAsserter.js';

const SNAPSHOT_DIR = join(import.meta.dirname, '../snapshots');
const UPDATE = process.env.UPDATE_SNAPSHOTS === 'true';

const FIXTURES = [
  'test/fixtures/03-complex-async',
  'test/fixtures/04-control-flow',
  'test/fixtures/nodejs-builtins',
  'test/fixtures/02-api-service',
  'test/fixtures/06-socketio',
  'test/fixtures/07-http-requests',
];

after(cleanupAllTestDatabases);

describe('Graph Snapshots', () => {
  for (const fixture of FIXTURES) {
    const name = basename(fixture);

    it(`snapshot: ${name}`, async () => {
      const db = await createTestDatabase();
      const orchestrator = createTestOrchestrator(db.backend);
      const fixtureAbsPath = resolve(fixture);

      await orchestrator.run(fixtureAbsPath);

      const asserter = await assertGraph(db.backend);
      const snapshot = asserter.toEnrichedSnapshot();

      const goldenPath = join(SNAPSHOT_DIR, `${name}.snapshot.json`);

      if (UPDATE) {
        if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
        writeFileSync(goldenPath, JSON.stringify(snapshot, null, 2) + '\n');
      } else {
        assert.ok(existsSync(goldenPath),
          `Golden file missing: ${goldenPath}. Run UPDATE_SNAPSHOTS=true to create.`);
        const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));
        assert.deepStrictEqual(snapshot, golden,
          `Snapshot mismatch for ${name}. Run UPDATE_SNAPSHOTS=true to update.`);
      }

      await db.cleanup();
    });
  }
});
