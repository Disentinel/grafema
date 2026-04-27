#!/usr/bin/env node
/**
 * regenerate-fixture-goldens.mjs (REG-1117)
 *
 * Regenerates the COMMITTED fixture-goldens at `test/golden/fixture/*.json`.
 *
 * These goldens are the reference projection of the SYNTHETIC fixture used
 * by the layer tests at `test/unit/{behaviorGolden,contractDiff,
 * crossModalityEquivalence,effectSurfaceDiff}.test.js`. They MUST always
 * match what the fixture produces — the layer tests assert zero diff.
 * Failures indicate a regression in the diff infrastructure (helpers,
 * collectors, projection logic) — NOT a real-world regression.
 *
 * Production goldens at `test/golden/{behaviors,contracts,effect-surfaces,
 * cross-modality-divergence}.json` are a separate concern; they are
 * regenerated against the live Grafema graph by `regenerate-behaviors.mjs`,
 * `regenerate-contracts.mjs`, and `regenerate-effect-surfaces.mjs`.
 *
 * Usage:
 *   node test/golden/regenerate-fixture-goldens.mjs
 *
 * No live RFDB needed. Uses TestRFDB to seed an ephemeral database with
 * the same fixtures the layer tests use, then dumps the projection.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createTestDatabase,
  cleanupAllTestDatabases,
} from '../helpers/TestRFDB.js';
import { collectBehaviors } from '../unit/regression-helpers/collectBehaviors.js';
import { collectContracts } from '../unit/regression-helpers/collectContracts.js';
import { collectEffectSurfaces } from '../unit/regression-helpers/collectEffectSurfaces.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixture');

async function main() {
  await regenBehaviors();
  await regenContracts();
  await regenEffectSurfaces();
  writeDivergence();
  await cleanupAllTestDatabases();
  console.error('[regen-fixture] all four fixture-goldens written');
}

async function regenBehaviors() {
  const db = await createTestDatabase();
  try {
    await seedFeatureWithBehavior(db.backend, {
      file: 'cli.ts',
      featureId: 'cli:command:fixture',
      featureType: 'cli:command',
      featureName: 'fixture',
      behaviorHash: 'fixture-hash-deadbeef',
      effects: ['ASYNC'],
      coreNodeCount: 3,
      depth: 10,
    });
    const map = await collectBehaviors(db.backend.client);
    const obj = sortObjectKeys(Object.fromEntries(map));
    const outPath = join(FIXTURE_DIR, 'behaviors.json');
    writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
    console.error(`[regen-fixture] wrote ${map.size} behavior(s) → ${outPath}`);
  } finally {
    await db.cleanup();
  }
}

async function regenContracts() {
  const db = await createTestDatabase();
  try {
    await seedFeatureWithContract(db.backend, {
      file: 'cli.ts',
      featureId: 'cli:command:fixture',
      featureType: 'cli:command',
      featureName: 'fixture',
      data: {
        source: 'commander',
        inputs: [{ name: '--config', type: 'string', optional: true }],
        outputs: [],
        errors: [],
      },
    });
    const { contracts } = await collectContracts(db.backend.client);
    const obj = sortObjectKeys(Object.fromEntries(contracts));
    const outPath = join(FIXTURE_DIR, 'contracts.json');
    writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
    console.error(`[regen-fixture] wrote ${contracts.size} contract(s) → ${outPath}`);
  } finally {
    await db.cleanup();
  }
}

async function regenEffectSurfaces() {
  const db = await createTestDatabase();
  try {
    await seedFeatureWithBehavior(db.backend, {
      file: 'cli.ts',
      featureId: 'cli:command:fixture',
      featureType: 'cli:command',
      featureName: 'fixture',
      behaviorHash: 'fixture-hash',
      effects: ['ASYNC', 'IO'],
      coreNodeCount: 1,
      depth: 10,
    });
    const surfaces = await collectEffectSurfaces(db.backend.client);
    const obj = sortObjectKeys(Object.fromEntries(surfaces));
    const outPath = join(FIXTURE_DIR, 'effect-surfaces.json');
    writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
    console.error(`[regen-fixture] wrote ${surfaces.size} surface(s) → ${outPath}`);
  } finally {
    await db.cleanup();
  }
}

/**
 * The cross-modality divergence allowlist is, by design, empty for the
 * fixture: `seedClusterPair` produces structurally-identical contracts so
 * no pair needs to be allowlisted. We still write the file so the path
 * exists and the layer test doesn't fall back to defaults.
 */
function writeDivergence() {
  const outPath = join(FIXTURE_DIR, 'cross-modality-divergence.json');
  const payload = {
    _comment:
      'Fixture-allowlist for crossModalityEquivalence. The synthetic ' +
      'fixture seeds two structurally-identical contracts so no divergences ' +
      'are expected. Empty by design.',
    divergences: {},
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  console.error(`[regen-fixture] wrote divergence allowlist → ${outPath}`);
}

// ----- fixture seeders (mirror the layer tests) -----

async function seedFeatureWithBehavior(backend, opts) {
  const {
    file,
    featureId,
    featureType,
    featureName,
    behaviorHash,
    effects,
    coreNodeCount,
    depth,
  } = opts;
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

async function seedFeatureWithContract(backend, opts) {
  const { file, featureId, featureType, featureName, data } = opts;
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
  const contractId = `${featureId}::specedContract`;
  await backend.addNode({
    id: contractId,
    type: 'SPECED_CONTRACT',
    name: featureName,
    file,
    source: data.source,
    inputs: data.inputs,
    outputs: data.outputs,
    errors: data.errors,
  });
  await backend.addEdge({ src: featureId, dst: contractId, type: 'HAS_SPECED_CONTRACT' });
}

function sortObjectKeys(o) {
  const keys = Object.keys(o).sort();
  const out = {};
  for (const k of keys) out[k] = o[k];
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
