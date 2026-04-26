/**
 * Scale test for behaviorEnricher — verifies bounded heap usage.
 *
 * Background: on real Grafema (149 FEATURE nodes) the enricher OOMed in the
 * Node.js client even with a 8 GB heap. The leaks were:
 *
 *  1. `traceDataflow` results held arrays of full DataflowNode objects
 *     (thousands per feature) that we only needed `{id, file, type}` from;
 *  2. `traceEffects` results retained large `leaf_sources` / `boundary_crossings`
 *     arrays per feature for the lifetime of the iteration;
 *  3. `fileMetricsCache` was unbounded;
 *  4. No event-loop yield between batches → V8 had no chance to run
 *     incremental GC under heap pressure.
 *
 * This test seeds 200 small-but-distinct FEATUREs, runs the enricher, and
 * verifies completion under a 1 GB heap. Without the fixes this OOMs around
 * feature ~80 with `--max-old-space-size=1024`.
 *
 * Run with: node --max-old-space-size=1024 --test test/unit/behaviorEnricher.scale.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { EffectsLookup } from '@grafema/util';
import { enrichBehaviors } from '@grafema/util/enrichers/behaviorEnricher';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

const FEATURE_COUNT = 200;
/** Each feature gets entry + 5 callees + 2 imports → 200×~9 = ~1800 nodes. */
const CALLEES_PER_FEATURE = 5;
const IMPORTS_PER_FEATURE = 2;

let emptyLookup;

before(() => {
  emptyLookup = EffectsLookup.empty();
});

after(async () => {
  await cleanupAllTestDatabases();
});

/**
 * Seed minimal infrastructure for one feature: MODULE + scope + entry FUNCTION
 * (with body scope) + N callee FUNCTIONs each reachable via CALL.
 */
async function seedFeature(backend, idx) {
  const file = `svc-${idx}.ts`;
  const moduleId = `${file}::module`;
  const scopeId = `${file}::scope`;
  const entryId = `feat-${idx}::entry`;
  const featId = `feat-${idx}::feat`;

  // module + global scope
  await backend.addNode({
    id: moduleId,
    type: 'MODULE',
    name: file,
    file,
    relativePath: file,
    contentHash: `h-${idx}`,
  });
  await backend.addNode({
    id: scopeId,
    type: 'SCOPE',
    name: 'global',
    file,
    scopeType: 'module',
  });
  await backend.addEdge({ src: moduleId, dst: scopeId, type: 'HAS_SCOPE' });

  // entry function with body scope
  await backend.addNode({
    id: entryId,
    type: 'FUNCTION',
    name: `entry${idx}`,
    file,
    async: true,
    generator: false,
    exported: false,
    arrowFunction: true,
  });
  await backend.addNode({
    id: `${entryId}::body`,
    type: 'SCOPE',
    name: 'function',
    file,
    scopeType: 'function',
  });
  await backend.addEdge({ src: entryId, dst: `${entryId}::body`, type: 'HAS_SCOPE' });

  // callees + CALLs from entry
  for (let c = 0; c < CALLEES_PER_FEATURE; c++) {
    const calleeId = `feat-${idx}::callee-${c}`;
    await backend.addNode({
      id: calleeId,
      type: 'FUNCTION',
      name: `callee${idx}_${c}`,
      file,
      async: false,
      generator: false,
      exported: false,
      arrowFunction: false,
    });
    await backend.addNode({
      id: `${calleeId}::body`,
      type: 'SCOPE',
      name: 'function',
      file,
      scopeType: 'function',
    });
    await backend.addEdge({ src: calleeId, dst: `${calleeId}::body`, type: 'HAS_SCOPE' });

    const callId = `feat-${idx}::call-${c}`;
    await backend.addNode({
      id: callId,
      type: 'CALL',
      name: `callee${idx}_${c}`,
      file,
    });
    await backend.addEdge({ src: `${entryId}::body`, dst: callId, type: 'CONTAINS' });
    await backend.addEdge({ src: callId, dst: calleeId, type: 'CALLS' });
    await backend.addEdge({ src: entryId, dst: calleeId, type: 'CALLS' });
  }

  // imports — make them external modules (effect leaves)
  for (let i = 0; i < IMPORTS_PER_FEATURE; i++) {
    const extId = `feat-${idx}::ext-${i}`;
    await backend.addNode({
      id: extId,
      type: 'EXTERNAL_MODULE',
      name: `lib${idx}_${i}.fn`,
      file: '',
    });
    const callId = `feat-${idx}::ext-call-${i}`;
    await backend.addNode({
      id: callId,
      type: 'CALL',
      name: `lib${idx}_${i}.fn`,
      file,
    });
    await backend.addEdge({ src: `${entryId}::body`, dst: callId, type: 'CONTAINS' });
    await backend.addEdge({ src: callId, dst: extId, type: 'CALLS' });
    await backend.addEdge({ src: entryId, dst: extId, type: 'CALLS' });
  }

  // FEATURE node + HANDLES → entry
  await backend.addNode({
    id: featId,
    type: 'cli:command',
    name: `cmd-${idx}`,
    file,
    exported: false,
  });
  await backend.addEdge({ src: featId, dst: entryId, type: 'HANDLES' });
}

describe('behaviorEnricher scale', () => {
  it(`processes ${FEATURE_COUNT} FEATUREs without OOM under bounded heap`, async () => {
    const db = await createTestDatabase();
    try {
      // Seed in waves of 25 so each batch addNodes/addEdges call stays small.
      for (let i = 0; i < FEATURE_COUNT; i++) {
        await seedFeature(db.backend, i);
      }

      const heapBefore = process.memoryUsage().heapUsed;
      const t0 = Date.now();
      const result = await enrichBehaviors(db.backend.client, emptyLookup, {
        maxDepth: 5,
        flushBatchSize: 10,
      });
      const elapsedMs = Date.now() - t0;
      const heapAfter = process.memoryUsage().heapUsed;
      const heapDeltaMb = (heapAfter - heapBefore) / 1024 / 1024;

      // eslint-disable-next-line no-console
      console.log(
        `[scale] features=${FEATURE_COUNT} elapsed=${elapsedMs}ms ` +
        `heapBefore=${(heapBefore / 1024 / 1024).toFixed(0)}MB ` +
        `heapAfter=${(heapAfter / 1024 / 1024).toFixed(0)}MB ` +
        `delta=${heapDeltaMb.toFixed(0)}MB ` +
        `behaviors=${result.behaviorsCreated}`,
      );

      assert.equal(
        result.behaviorsCreated,
        FEATURE_COUNT,
        `expected ${FEATURE_COUNT} BEHAVIORs, got ${result.behaviorsCreated}`,
      );
      // Heap delta sanity check: with the leaks unfixed, the heap grows to the
      // configured limit (1 GB) and the process aborts. With the fix, working
      // set per-feature is ~tens of KB so total delta should be well under
      // 400 MB even in the slowest CI environments.
      assert.ok(
        heapDeltaMb < 400,
        `heap grew by ${heapDeltaMb.toFixed(0)}MB during enrichment — leak suspected`,
      );
    } finally {
      await db.cleanup();
    }
  });
});
