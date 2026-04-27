#!/usr/bin/env node
/**
 * regenerate-contracts.mjs (REG-1117)
 *
 * Same pattern as regenerate-behaviors.mjs, but writes
 * `test/golden/contracts.json` from FEATURE → SPECED_CONTRACT pairs.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { RFDBClient } from '../../packages/rfdb/dist/client.js';
import { collectContracts } from '../unit/regression-helpers/collectContracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sockArg = parseFlag('--rfdb');
  const sockPath = resolve(sockArg ?? process.env.GRAFEMA_RFDB_SOCK ?? '.grafema/rfdb.sock');
  console.error(`[regen-contracts] connecting to ${sockPath}`);

  const client = new RFDBClient({ socketPath: sockPath });
  await client.connect();

  try {
    const { contracts } = await collectContracts(client);
    const obj = sortObjectKeys(Object.fromEntries(contracts));
    const outPath = join(__dirname, 'contracts.json');
    writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
    console.error(`[regen-contracts] wrote ${contracts.size} entries → ${outPath}`);
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }
}

function parseFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
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
