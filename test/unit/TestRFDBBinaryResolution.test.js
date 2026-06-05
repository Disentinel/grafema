/**
 * Regression: the test harness must resolve the rfdb-server binary the same way
 * production code does — via the canonical `findRfdbBinary` resolver in
 * `@grafema/util` — instead of a hardcoded `target/{release,debug}` list.
 *
 * Why this matters:
 *   - `GRAFEMA_RFDB_SERVER` is the documented override (README "Environment
 *     variables" table) and is honored by every production resolver
 *     (`findRfdbBinary`, `packages/grafema/src/binaries.ts`, the VS Code client,
 *     and `grafema doctor`). A contributor who points it at a locally-built
 *     binary, or who relies on the npm-distributed binary, could not run the
 *     test suite because `TestRFDB._findServerBinary()` ignored all of those
 *     locations and only checked two `cargo`-build paths.
 *   - Archived task RFD-40 already fixed this exact "hardcoded resolution that
 *     ignores GRAFEMA_RFDB_SERVER" DRY violation in the CLI server command; the
 *     test helper was the last remaining sibling instance.
 *
 * This test asserts the documented override wins, which is the discriminating
 * behavior between the old hardcoded list (env var ignored) and delegation to
 * the canonical resolver (env var honored, checked before monorepo build dirs).
 */

import test from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getPlatformDir } from '@grafema/util';

import { _findServerBinary } from '../helpers/TestRFDB.js';

test('TestRFDB._findServerBinary honors the documented GRAFEMA_RFDB_SERVER override', (t) => {
  // Use a real, existing binary as the override target. The committed prebuilt
  // binary for the current platform is the most honest choice (it exists in a
  // fresh clone). Skip on platforms that ship no prebuilt binary.
  const override = join(
    process.cwd(),
    'packages/rfdb-server/prebuilt',
    getPlatformDir(),
    'rfdb-server',
  );
  if (!existsSync(override)) {
    t.skip(`no committed prebuilt rfdb-server for ${getPlatformDir()}`);
    return;
  }

  const original = process.env.GRAFEMA_RFDB_SERVER;
  process.env.GRAFEMA_RFDB_SERVER = override;
  try {
    assert.strictEqual(
      _findServerBinary(),
      override,
      'test helper must delegate to the canonical findRfdbBinary resolver and ' +
        'honor the documented GRAFEMA_RFDB_SERVER override',
    );
  } finally {
    if (original === undefined) delete process.env.GRAFEMA_RFDB_SERVER;
    else process.env.GRAFEMA_RFDB_SERVER = original;
  }
});
