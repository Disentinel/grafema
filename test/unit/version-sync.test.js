/**
 * Version synchronization tests (RFD-41)
 *
 * Ensures version numbers stay in sync across the monorepo:
 * - All publishable package.json versions match the root version
 * - rfdb-server Cargo.toml version matches its package.json version
 *
 * These are static file checks — no build or runtime needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
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
  'packages/core',
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
});
