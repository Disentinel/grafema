#!/usr/bin/env node
/**
 * regenerate-behaviors.mjs (REG-1117)
 *
 * Connects to a live RFDB server, enumerates every FEATURE → BEHAVIOR
 * pair, and writes the projection to `test/golden/behaviors.json` for
 * Layer 1 of the regression-test infrastructure.
 *
 * Usage:
 *   node test/golden/regenerate-behaviors.mjs --rfdb /path/to/rfdb.sock
 *
 * Or via env var:
 *   GRAFEMA_RFDB_SOCK=/path/to/rfdb.sock node test/golden/regenerate-behaviors.mjs
 *
 * Defaults to `.grafema/rfdb.sock` in the current working directory.
 *
 * Output: stable, sorted JSON. Diff-friendly. Commit alongside the change
 * that intentionally drifted the BEHAVIORs.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { RFDBClient } from '../../packages/rfdb/dist/client.js';
import { collectBehaviors } from '../unit/regression-helpers/collectBehaviors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sockArg = parseFlag('--rfdb');
  const sockPath = resolve(sockArg ?? process.env.GRAFEMA_RFDB_SOCK ?? '.grafema/rfdb.sock');
  console.error(`[regen-behaviors] connecting to ${sockPath}`);

  const client = new RFDBClient(sockPath, 'regen-behaviors');
  await client.connect();

  try {
    const map = await collectBehaviors(client);
    const obj = sortObjectKeys(Object.fromEntries(map));
    const outPath = join(__dirname, 'behaviors.json');
    writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
    console.error(`[regen-behaviors] wrote ${map.size} entries → ${outPath}`);
  } finally {
    try {
      await client.close();
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
