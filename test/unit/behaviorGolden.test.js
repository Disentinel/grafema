/**
 * behaviorGolden.test.js — Layer 1 of the regression-test infrastructure.
 *
 * Compares the FEATURE → BEHAVIOR.metadata projection of a synthetic
 * test-graph fixture against `test/golden/behaviors.json`. When the golden
 * file is empty `{}`, no regression is detectable — the test passes. When
 * the golden is populated (after a manual `regenerate-behaviors.mjs` run),
 * the test fails on any feature whose hash, effects, coreNodeCount, or depth
 * has drifted. Failure message includes a `regenerate-behaviors.mjs` hint.
 *
 * Fixture: a small synthetic graph seeded into a test DB. Real-world golden
 * regen runs against the live `.grafema/rfdb.sock` instead — see the
 * regen script for that flow.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  diffBehaviors,
  behaviorDiffSize,
  formatBehaviorDiff,
} from '@grafema/util/regression/behaviorDiff';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { collectBehaviors } from './regression-helpers/collectBehaviors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, '..', 'golden', 'behaviors.json');

after(async () => {
  await cleanupAllTestDatabases();
});

describe('behaviorGolden (Layer 1)', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  let backend;
  let client;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    client = backend.client;
  });

  it('current behaviors match golden (empty golden ⇒ no regressions)', async () => {
    // Seed a tiny FEATURE + BEHAVIOR pair so collectBehaviors has something
    // to traverse. The golden is `{}` initially: any drift between {} and
    // the fixture would manifest as `added` entries — which the layer test
    // tolerates when the golden is empty (initial-state semantics).
    await seedFeatureWithBehavior(backend, {
      file: 'cli.ts',
      featureId: 'cli:command:fixture',
      featureType: 'cli:command',
      featureName: 'fixture',
      behaviorHash: 'fixture-hash-deadbeef',
      effects: ['ASYNC'],
      coreNodeCount: 3,
      depth: 10,
    });

    const golden = loadGolden();
    const goldenMap = mapFromObj(golden);
    const current = await collectBehaviors(client);

    const diff = diffBehaviors(goldenMap, current);

    if (goldenMap.size === 0) {
      // Initial state: golden not yet populated. We only verify the
      // collection pipeline works (current.size > 0). No regression
      // detection is possible yet.
      assert.ok(current.size > 0, 'expected fixture to produce at least one behavior');
      return;
    }

    if (behaviorDiffSize(diff) !== 0) {
      assert.fail(
        `Behavior regression detected vs test/golden/behaviors.json:\n` +
          `${formatBehaviorDiff(diff)}\n\n` +
          `If this drift is intentional, regenerate the golden:\n` +
          `  node test/golden/regenerate-behaviors.mjs --rfdb .grafema/rfdb.sock\n`,
      );
    }
  });
});

/** Load test/golden/behaviors.json. Returns `{}` if file is empty. */
function loadGolden() {
  try {
    const raw = readFileSync(GOLDEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Convert plain JSON object to Map<featureId, BehaviorMeta>. */
function mapFromObj(obj) {
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    if (v && typeof v === 'object') m.set(k, v);
  }
  return m;
}

async function seedFeatureWithBehavior(backend, opts) {
  const { file, featureId, featureType, featureName, behaviorHash, effects, coreNodeCount, depth } =
    opts;
  await backend.addNode({
    id: `${file}::module`,
    type: 'MODULE',
    name: file,
    file,
    relativePath: file,
    contentHash: 'h1',
  });
  await backend.addNode({
    id: featureId,
    type: featureType,
    name: featureName,
    file,
    exported: false,
  });
  const behaviorId = `${featureId}::behavior`;
  await backend.addNode({
    id: behaviorId,
    type: 'BEHAVIOR',
    name: featureName,
    file,
    hash: behaviorHash,
    effects,
    coreNodeCount,
    depth,
    effectCount: effects.length,
    featureId,
  });
  await backend.addEdge({ src: featureId, dst: behaviorId, type: 'IMPLEMENTED_BY' });
}
