/**
 * behaviorGolden.test.js — Layer 1 of the regression-test infrastructure.
 *
 * Compares the FEATURE → BEHAVIOR.metadata projection of a synthetic
 * test-graph fixture against `test/golden/fixture/behaviors.json`. The
 * fixture-golden is the COMMITTED reference for the synthetic fixture and
 * MUST always match (zero-diff). Any non-empty diff means the diff
 * infrastructure itself (helpers, collectors) has regressed.
 *
 * Production goldens at `test/golden/behaviors.json` are a separate concern:
 * captured by `regenerate-behaviors.mjs` against the live Grafema graph and
 * consumed by CI / release-gate flows — NOT by this test.
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
const GOLDEN_PATH = join(__dirname, '..', 'golden', 'fixture', 'behaviors.json');

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

  it('fixture behaviors match committed fixture-golden (zero diff)', async () => {
    // Seed a tiny FEATURE + BEHAVIOR pair so collectBehaviors has something
    // to traverse. The fixture-golden is COMMITTED and must reflect exactly
    // what this fixture produces. Any non-empty diff = diff-infra regressed.
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

    const goldenMap = mapFromObj(loadGolden());
    const current = await collectBehaviors(client);

    assert.ok(
      goldenMap.size > 0,
      `Fixture-golden ${GOLDEN_PATH} is empty. Run:\n` +
        `  node test/golden/regenerate-fixture-goldens.mjs\n`,
    );

    const diff = diffBehaviors(goldenMap, current);
    if (behaviorDiffSize(diff) !== 0) {
      assert.fail(
        `Fixture-projection drifted from test/golden/fixture/behaviors.json:\n` +
          `${formatBehaviorDiff(diff)}\n\n` +
          `This indicates a regression in the diff/projection infrastructure\n` +
          `(collectBehaviors, behaviorDiff, or the fixture seeder). If the\n` +
          `fixture itself was intentionally changed, regenerate:\n` +
          `  node test/golden/regenerate-fixture-goldens.mjs\n`,
      );
    }
  });
});

/** Load test/golden/fixture/behaviors.json. Returns `{}` if file is missing/empty. */
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
