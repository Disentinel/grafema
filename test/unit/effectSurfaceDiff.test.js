/**
 * effectSurfaceDiff.test.js — Layer 4 of the regression-test infrastructure.
 *
 * Projects FEATURE → effects-array from BEHAVIOR.metadata, compares against
 * the COMMITTED fixture-golden at `test/golden/fixture/effect-surfaces.json`.
 * Zero-diff is required — drift means the diff infrastructure regressed.
 *
 * Production goldens (live-graph snapshot at
 * `test/golden/effect-surfaces.json`) are owned by regenerate-effect-surfaces
 * and CI release-gate flows.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  diffEffects,
  effectDiffSize,
  formatEffectDiff,
} from '@grafema/util/regression/effectDiff';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { collectEffectSurfaces } from './regression-helpers/collectEffectSurfaces.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, '..', 'golden', 'fixture', 'effect-surfaces.json');

after(async () => {
  await cleanupAllTestDatabases();
});

describe('effectSurfaceDiff (Layer 4)', () => {
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

  it('fixture effect-surfaces match committed fixture-golden (zero diff)', async () => {
    // Seed via a BEHAVIOR node — collectEffectSurfaces reuses
    // collectBehaviors so any FEATURE→IMPLEMENTED_BY→BEHAVIOR triple works.
    await seedFeatureWithBehavior(backend, {
      file: 'cli.ts',
      featureId: 'cli:command:fixture',
      featureType: 'cli:command',
      featureName: 'fixture',
      effects: ['ASYNC', 'IO'],
    });

    const goldenMap = mapFromObj(loadGolden());
    const current = await collectEffectSurfaces(client);

    assert.ok(
      goldenMap.size > 0,
      `Fixture-golden ${GOLDEN_PATH} is empty. Run:\n` +
        `  node test/golden/regenerate-fixture-goldens.mjs\n`,
    );

    const diff = diffEffects(goldenMap, current);
    if (effectDiffSize(diff) !== 0) {
      assert.fail(
        `Fixture-projection drifted from test/golden/fixture/effect-surfaces.json:\n` +
          `${formatEffectDiff(diff)}\n\n` +
          `This indicates a regression in the diff/projection infrastructure\n` +
          `(collectEffectSurfaces, effectDiff, or the fixture seeder). If the\n` +
          `fixture itself was intentionally changed, regenerate:\n` +
          `  node test/golden/regenerate-fixture-goldens.mjs\n`,
      );
    }
  });
});

function loadGolden() {
  try {
    const raw = readFileSync(GOLDEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mapFromObj(obj) {
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    if (Array.isArray(v)) m.set(k, v);
  }
  return m;
}

async function seedFeatureWithBehavior(backend, opts) {
  const { file, featureId, featureType, featureName, effects } = opts;
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
    hash: 'fixture-hash',
    effects,
    coreNodeCount: 1,
    depth: 10,
    effectCount: effects.length,
  });
  await backend.addEdge({ src: featureId, dst: behaviorId, type: 'IMPLEMENTED_BY' });
}
