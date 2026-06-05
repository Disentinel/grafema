/**
 * Regression guard (class-not-instance): every test suite that needs the
 * rfdb-server binary must resolve it through the canonical `findRfdbBinary`
 * resolver in `@grafema/util`, NOT through a hardcoded
 * `packages/rfdb-server/target/{release,debug}/rfdb-server` list.
 *
 * Why this matters:
 *   - `GRAFEMA_RFDB_SERVER` is the documented override (README "Environment
 *     variables" table) and is honored by every production resolver
 *     (`findRfdbBinary`, the CLI `server` command, the VS Code client). A
 *     hardcoded `target/{release,debug}` list ignores it, plus the platform
 *     npm package, `PATH`, `~/.grafema/bin`, `~/.local/bin`, and the legacy
 *     `@grafema/rfdb` prebuilt location — so a contributor who points the env
 *     var at a locally-built binary, or relies on the npm-distributed binary,
 *     cannot run these suites at all.
 *   - PR #281 (RFD-40 follow-up) fixed this exact DRY violation in the shared
 *     `test/helpers/TestRFDB.js` harness (covered by
 *     `FindRfdbBinary.test.js`). The four opt-in suites listed below
 *     were the last remaining sibling instances, filed as follow-ups.
 *
 * This test encodes the invariant structurally so a future suite cannot
 * silently reintroduce the hardcoded list. The discriminating behavior of the
 * fix (env override is honored) is proven separately by
 * `FindRfdbBinary.test.js`, which exercises the live resolver.
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = join(__dirname, '..');

// Assemble the forbidden needles from parts so THIS file does not match the
// directory scan below.
const SEG = 'rfdb-server/' + 'target/';
const FORBIDDEN = [SEG + 'release' + '/rfdb-server', SEG + 'debug' + '/rfdb-server'];

// Suites that spawn a real rfdb-server and therefore must use findRfdbBinary().
const SUITES_NEEDING_RESOLVER = [
  'integration/rfdb-federation.test.js',
  'integration/rfdb-websocket.test.ts',
  'scenarios/rfdb-client.test.js',
  'scenarios/rfdb-request-id.test.js',
];

/** Recursively collect every *.test.js / *.test.ts file under test/. */
function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (/\.test\.(js|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test('no test file hardcodes the rfdb-server target/ binary path', () => {
  const selfPath = fileURLToPath(import.meta.url);
  const offenders = [];
  for (const file of collectTestFiles(TEST_ROOT)) {
    if (file === selfPath) continue; // this guard names the pattern in prose
    const src = readFileSync(file, 'utf8');
    for (const needle of FORBIDDEN) {
      if (src.includes(needle)) {
        offenders.push(`${file} contains hardcoded "${needle}"`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'test suites must resolve rfdb-server via findRfdbBinary() (from @grafema/util), ' +
      'not a hardcoded target/{release,debug} path:\n' + offenders.join('\n'),
  );
});

test('rfdb-server suites delegate resolution to findRfdbBinary', () => {
  const missing = [];
  for (const rel of SUITES_NEEDING_RESOLVER) {
    const src = readFileSync(join(TEST_ROOT, rel), 'utf8');
    if (!src.includes('findRfdbBinary')) {
      missing.push(rel);
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    'these suites must import and use findRfdbBinary() from @grafema/util:\n' +
      missing.join('\n'),
  );
});
