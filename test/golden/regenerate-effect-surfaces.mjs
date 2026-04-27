#!/usr/bin/env node
/**
 * regenerate-effect-surfaces.mjs (REG-1117)
 *
 * Writes `test/golden/effect-surfaces.json` — FEATURE → effect[] from
 * BEHAVIOR.metadata.effects. Used by Layer 4 (effectSurfaceDiff.test.js).
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { RFDBClient } from '../../packages/rfdb/dist/client.js';
import { collectEffectSurfaces } from '../unit/regression-helpers/collectEffectSurfaces.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sockArg = parseFlag('--rfdb');
  const sockPath = resolve(sockArg ?? process.env.GRAFEMA_RFDB_SOCK ?? '.grafema/rfdb.sock');
  console.error(`[regen-effect-surfaces] connecting to ${sockPath}`);

  const client = new RFDBClient(sockPath, 'regen-effects');
  await client.connect();

  try {
    const surfaces = await collectEffectSurfaces(client);
    const obj = sortObjectKeys(Object.fromEntries(surfaces));
    const outPath = join(__dirname, 'effect-surfaces.json');
    writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
    console.error(`[regen-effect-surfaces] wrote ${surfaces.size} entries → ${outPath}`);
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
