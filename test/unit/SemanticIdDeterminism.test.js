/**
 * Semantic ID Determinism Tests (REG-421)
 *
 * Verifies that analyzing the same code twice produces identical
 * enriched snapshots. This guarantees that semantic IDs and all
 * derived properties are deterministic across runs.
 */

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { assertGraph } from '../helpers/GraphAsserter.js';

after(cleanupAllTestDatabases);

describe('Semantic ID Determinism', () => {
  it('should produce identical snapshots for same code', async () => {
    const fixture = resolve('test/fixtures/01-simple-script');

    // Run 1
    const db1 = await createTestDatabase();
    const orch1 = createTestOrchestrator(db1.backend);
    await orch1.run(fixture);
    const snap1 = (await assertGraph(db1.backend)).toEnrichedSnapshot();

    // Run 2
    const db2 = await createTestDatabase();
    const orch2 = createTestOrchestrator(db2.backend);
    await orch2.run(fixture);
    const snap2 = (await assertGraph(db2.backend)).toEnrichedSnapshot();

    assert.deepStrictEqual(snap1, snap2, 'Snapshots must be identical for same input');

    await db1.cleanup();
    await db2.cleanup();
  });
});
