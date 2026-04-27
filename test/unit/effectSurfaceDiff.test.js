/**
 * effectSurfaceDiff.test.js — Layer 4 of the regression-test infrastructure.
 *
 * Projects FEATURE → effects-array from BEHAVIOR.metadata, compares against
 * `test/golden/effect-surfaces.json`. Empty golden ⇒ no regressions
 * detectable, test passes. With populated golden, fails on any effect-set
 * change. ESCALATION-class diffs (added FS_WRITE / NETWORK_OUT / DB_WRITE)
 * are explicitly tagged in the failure message.
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
const GOLDEN_PATH = join(__dirname, '..', 'golden', 'effect-surfaces.json');

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

  it('current effect-surfaces match golden (empty golden ⇒ no regressions)', async () => {
    // Seed via a BEHAVIOR node — collectEffectSurfaces reuses
    // collectBehaviors so any FEATURE→IMPLEMENTED_BY→BEHAVIOR triple works.
    await seedFeatureWithBehavior(backend, {
      file: 'cli.ts',
      featureId: 'cli:command:fixture',
      featureType: 'cli:command',
      featureName: 'fixture',
      effects: ['ASYNC', 'IO'],
    });

    const golden = loadGolden();
    const goldenMap = mapFromObj(golden);
    const current = await collectEffectSurfaces(client);

    if (goldenMap.size === 0) {
      assert.ok(current.size > 0, 'expected fixture to produce at least one effect surface');
      return;
    }

    const diff = diffEffects(goldenMap, current);
    if (effectDiffSize(diff) !== 0) {
      assert.fail(
        `Effect-surface regression detected vs test/golden/effect-surfaces.json:\n` +
          `${formatEffectDiff(diff)}\n\n` +
          `If this drift is intentional, regenerate the golden:\n` +
          `  node test/golden/regenerate-effect-surfaces.mjs --rfdb .grafema/rfdb.sock\n`,
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
