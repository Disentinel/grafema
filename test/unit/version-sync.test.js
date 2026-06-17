/**
 * Version synchronization tests (RFD-41)
 *
 * Ensures version numbers stay in sync across the monorepo:
 * - All publishable package.json versions match the root version
 * - rfdb-server Cargo.toml version matches its package.json version
 * - Internal `@grafema/*` exact-version pins (platform-binary optionalDeps)
 *   match the root version — version connascence guard (RFD-75)
 *
 * These are static file checks — no build or runtime needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/**
 * Publishable packages that must share the root version.
 * Order matches release.sh for consistency.
 */
const PACKAGES = [
  'packages/types',
  'packages/rfdb',
  'packages/util',
  'packages/mcp',
  'packages/api',
  'packages/cli',
  'packages/rfdb-server',
];

/**
 * Read and parse a package.json, returning its version string.
 */
function readPackageVersion(pkgDir) {
  const raw = readFileSync(join(ROOT, pkgDir, 'package.json'), 'utf-8');
  return JSON.parse(raw).version;
}

/**
 * Extract the `version = "..."` value from a Cargo.toml file.
 */
function readCargoVersion(cargoPath) {
  const raw = readFileSync(join(ROOT, cargoPath), 'utf-8');
  const match = raw.match(/^version = "([^"]*)"$/m);
  assert.ok(match, `Could not find version field in ${cargoPath}`);
  return match[1];
}

const PIN_DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** Matches an exact semver pin (e.g. `0.4.1`, `0.4.1-rc.1`), not `workspace:*` or ranges. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Discover every concrete (exact-semver) `@grafema/*` dependency pin across the
 * whole monorepo (root + every `packages/*`). These are chiefly the
 * platform-binary `optionalDependencies`. Each MUST move in lockstep with the
 * root version: a stale pin makes `npm i <pkg>` resolve a binary of the wrong
 * version, which is silently broken at runtime.
 *
 * RFD-75 (connascence of value): the 0.4.0→0.4.1 release shipped `@grafema/cli`
 * with its binary optionalDeps pinned at `0.3.29` while the meta package and the
 * binaries themselves were `0.4.x` → wrong-binary install. `release.sh` re-injects
 * these pins from a single source of truth at release time (`PIN_PACKAGES`), but
 * that list is maintained by hand — `@grafema/mcp` was omitted and silently kept a
 * stale `0.3.29` pin through 0.4.1. This check DISCOVERS pin-bearing packages by
 * scanning rather than trusting a hand-maintained list, so the same omission can
 * never silently re-enter for any current or future package.
 *
 * Returns an array of `{ pkgDir, field, name, spec }` records.
 */
function discoverExactGrafemaPins() {
  const pins = [];
  const dirs = ['.'];
  const packagesRoot = join(ROOT, 'packages');
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot)) {
      dirs.push(join('packages', entry));
    }
  }
  for (const pkgDir of dirs) {
    const pkgPath = join(ROOT, pkgDir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    for (const field of PIN_DEP_FIELDS) {
      const deps = pkg[field] || {};
      for (const [name, spec] of Object.entries(deps)) {
        if (!name.startsWith('@grafema/')) continue;
        if (typeof spec !== 'string' || !EXACT_SEMVER.test(spec)) continue; // skip workspace:* and ranges
        pins.push({ pkgDir, field, name, spec });
      }
    }
  }
  return pins;
}

/**
 * Discover every version string `pnpm-lock.yaml` references for the platform-binary
 * packages (`@grafema/grafema-{linux,darwin}-{x64,arm64}`), across both the
 * `importers:` blocks (`specifier:`/`version:` lines) and the resolved `packages:`
 * section keys (`@grafema/grafema-…@<version>:`).
 *
 * Why this is a separate guard from the package.json check: CI installs with
 * `pnpm install --no-frozen-lockfile`, which silently REGENERATES the lockfile, so a
 * committed lockfile that contradicts a package.json bump is never surfaced by the
 * install step. The package.json connascence check alone would stay green while
 * `pnpm-lock.yaml` keeps a stale pin (exactly the gap a half-done bump leaves — a
 * manifest updated to the new version, the lockfile importer block left behind).
 * This scan is the only thing that catches a stale binary pin inside the committed
 * lockfile.
 *
 * Returns an array of `{ where, version }` records.
 */
function discoverLockfileBinaryVersions() {
  const lockPath = join(ROOT, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) return [];
  const lines = readFileSync(lockPath, 'utf-8').split('\n');
  const refs = [];
  const importerKey = /^\s*'@grafema\/grafema-(?:darwin|linux)-(?:x64|arm64)':\s*$/;
  const packageKey = /^\s*'@grafema\/grafema-(?:darwin|linux)-(?:x64|arm64)@([^']+)':/;
  const valueLine = /^\s*(specifier|version):\s*'?([^'\s]+)'?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const pk = lines[i].match(packageKey);
    if (pk) {
      refs.push({ where: `packages: ${lines[i].trim()}`, version: pk[1] });
      continue;
    }
    if (importerKey.test(lines[i])) {
      // The `specifier:`/`version:` pair lives on the next 1-2 indented lines.
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const v = lines[j].match(valueLine);
        if (!v) break;
        refs.push({ where: `importer ${lines[i].trim()} ${v[1]}`, version: v[2] });
      }
    }
  }
  return refs;
}

describe('version-sync', () => {
  const rootVersion = readPackageVersion('.');

  describe('all publishable package.json versions match root version', () => {
    for (const pkg of PACKAGES) {
      it(`${pkg}/package.json version matches root (${rootVersion})`, () => {
        const pkgVersion = readPackageVersion(pkg);
        assert.strictEqual(
          pkgVersion,
          rootVersion,
          `${pkg}/package.json version "${pkgVersion}" does not match root version "${rootVersion}"`
        );
      });
    }
  });

  describe('rfdb-server Cargo.toml version matches package.json', () => {
    it('Cargo.toml version matches packages/rfdb-server/package.json version', () => {
      const cargoVersion = readCargoVersion('packages/rfdb-server/Cargo.toml');
      const npmVersion = readPackageVersion('packages/rfdb-server');
      assert.strictEqual(
        cargoVersion,
        npmVersion,
        `Cargo.toml version "${cargoVersion}" does not match rfdb-server package.json version "${npmVersion}"`
      );
    });
  });

  describe('internal @grafema/* exact-version pins match root version', () => {
    const pins = discoverExactGrafemaPins();

    it('at least one exact @grafema/* pin is discovered (guards the scanner)', () => {
      assert.ok(
        pins.length > 0,
        'No exact-semver @grafema/* pins found — the platform-binary optionalDependencies ' +
        'should be discoverable. The scanner is likely broken or pointed at the wrong root.'
      );
    });

    for (const { pkgDir, field, name, spec } of pins) {
      it(`${pkgDir} [${field}] ${name} (${spec}) matches root (${rootVersion})`, () => {
        assert.strictEqual(
          spec,
          rootVersion,
          `${pkgDir} ${field}.${name} is pinned at "${spec}" but the root version is ` +
          `"${rootVersion}" — version-connascence drift (RFD-75). A stale pin ships a ` +
          `wrong-version binary on \`npm i\`. Bump the pin and add the package to ` +
          `PIN_PACKAGES in scripts/release.sh so it stays in lockstep.`
        );
      });
    }
  });

  describe('pnpm-lock.yaml @grafema/* platform-binary versions match root version', () => {
    const refs = discoverLockfileBinaryVersions();

    it('at least one lockfile binary version is discovered (guards the scanner)', () => {
      assert.ok(
        refs.length > 0,
        'No @grafema/grafema-* binary versions found in pnpm-lock.yaml — the scanner is ' +
        'likely broken or the lockfile format changed.'
      );
    });

    it('no @grafema/* platform-binary pin in pnpm-lock.yaml is stale', () => {
      const stale = refs.filter((r) => r.version !== rootVersion);
      assert.deepStrictEqual(
        stale,
        [],
        `pnpm-lock.yaml references @grafema/grafema-* binaries at a version other than the ` +
        `root "${rootVersion}" — stale lockfile pin (RFD-75). CI installs with ` +
        `--no-frozen-lockfile, so this is not caught at install time; a half-done bump (manifest ` +
        `updated, lockfile not) lands here. Regenerate with \`pnpm install --lockfile-only\`. ` +
        `Offenders: ${JSON.stringify(stale, null, 2)}`
      );
    });
  });
});
