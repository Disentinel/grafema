/**
 * contractDiff.test.js — Layer 2 of the regression-test infrastructure.
 *
 * Compares FEATURE → SPECED_CONTRACT data of a synthetic test-graph
 * fixture against the COMMITTED fixture-golden at
 * `test/golden/fixture/contracts.json`. Zero-diff is required — any drift
 * indicates the diff infrastructure itself regressed.
 *
 * Production goldens (live-graph snapshot at `test/golden/contracts.json`)
 * are a separate concern, owned by the regenerate-contracts.mjs script and
 * CI release-gate flows.
 *
 * NOTE: this is the CI/test entry point that wraps the pure helper
 * `@grafema/util/regression/contractDiff`. The helper has its own focused
 * tests under `test/unit/regression/contractDiff.test.js`.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  diffContracts,
  contractDiffSize,
  formatContractDiff,
} from '@grafema/util/regression/contractDiff';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { collectContracts } from './regression-helpers/collectContracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, '..', 'golden', 'fixture', 'contracts.json');

after(async () => {
  await cleanupAllTestDatabases();
});

describe('contractDiff (Layer 2)', () => {
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

  it('fixture contracts match committed fixture-golden (zero diff)', async () => {
    await seedFeatureWithContract(backend, {
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

    const goldenMap = mapFromObj(loadGolden());
    const { contracts: current, categories } = await collectContracts(client);

    assert.ok(
      goldenMap.size > 0,
      `Fixture-golden ${GOLDEN_PATH} is empty. Run:\n` +
        `  node test/golden/regenerate-fixture-goldens.mjs\n`,
    );

    const diff = diffContracts(goldenMap, current, categories);
    if (contractDiffSize(diff) !== 0) {
      assert.fail(
        `Fixture-projection drifted from test/golden/fixture/contracts.json:\n` +
          `${formatContractDiff(diff)}\n\n` +
          `This indicates a regression in the diff/projection infrastructure\n` +
          `(collectContracts, contractDiff, or the fixture seeder). If the\n` +
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
    if (v && typeof v === 'object') m.set(k, v);
  }
  return m;
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
  // The enricher stores the SpecedContractData fields as the metadata payload.
  // We do the same here.
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
