/**
 * contractDiff.test.js — Layer 2 of the regression-test infrastructure.
 *
 * Compares FEATURE → SPECED_CONTRACT data of a synthetic test-graph
 * fixture against `test/golden/contracts.json`. Empty golden ⇒ no
 * regressions detectable, test passes. With populated golden, fails on
 * any contract diff with an explicit BREAKING/MINOR severity tag plus a
 * regenerate hint.
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
const GOLDEN_PATH = join(__dirname, '..', 'golden', 'contracts.json');

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

  it('current contracts match golden (empty golden ⇒ no regressions)', async () => {
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

    const golden = loadGolden();
    const goldenMap = mapFromObj(golden);
    const { contracts: current, categories } = await collectContracts(client);

    if (goldenMap.size === 0) {
      assert.ok(current.size > 0, 'expected fixture to produce at least one contract');
      return;
    }

    const diff = diffContracts(goldenMap, current, categories);
    if (contractDiffSize(diff) !== 0) {
      assert.fail(
        `Contract regression detected vs test/golden/contracts.json:\n` +
          `${formatContractDiff(diff)}\n\n` +
          `If this drift is intentional, regenerate the golden:\n` +
          `  node test/golden/regenerate-contracts.mjs --rfdb .grafema/rfdb.sock\n`,
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
