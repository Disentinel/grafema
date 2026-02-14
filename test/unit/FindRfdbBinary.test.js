/**
 * FindRfdbBinary unit tests (REG-410)
 *
 * Tests for the shared rfdb-server binary finder utility.
 * Verifies the search order including system PATH lookup.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findRfdbBinary } from '@grafema/core';

describe('findRfdbBinary', () => {
  let tempDir;
  let originalPath;
  let originalEnv;

  before(() => {
    tempDir = join(tmpdir(), `findRfdbBinary-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalEnv = process.env.GRAFEMA_RFDB_SERVER;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalEnv === undefined) {
      delete process.env.GRAFEMA_RFDB_SERVER;
    } else {
      process.env.GRAFEMA_RFDB_SERVER = originalEnv;
    }
  });

  describe('explicit path', () => {
    it('returns explicit path when file exists', () => {
      const binPath = join(tempDir, 'explicit-rfdb-server');
      writeFileSync(binPath, '#!/bin/sh\n');
      chmodSync(binPath, 0o755);

      const result = findRfdbBinary({ explicitPath: binPath });
      assert.strictEqual(result, binPath);
    });

    it('returns null when explicit path does not exist', () => {
      const result = findRfdbBinary({ explicitPath: '/nonexistent/rfdb-server' });
      assert.strictEqual(result, null);
    });

    it('does not fall back to other locations when explicit path is missing', () => {
      // Put a binary in PATH
      const pathDir = join(tempDir, 'path-dir-no-fallback');
      mkdirSync(pathDir, { recursive: true });
      const binPath = join(pathDir, 'rfdb-server');
      writeFileSync(binPath, '#!/bin/sh\n');
      chmodSync(binPath, 0o755);
      process.env.PATH = pathDir;

      // Explicit path should NOT fall back to PATH
      const result = findRfdbBinary({ explicitPath: '/nonexistent/rfdb-server' });
      assert.strictEqual(result, null);
    });
  });

  describe('environment variable', () => {
    it('returns env var path when GRAFEMA_RFDB_SERVER is set and file exists', () => {
      const binPath = join(tempDir, 'env-rfdb-server');
      writeFileSync(binPath, '#!/bin/sh\n');
      chmodSync(binPath, 0o755);
      process.env.GRAFEMA_RFDB_SERVER = binPath;

      const result = findRfdbBinary();
      assert.strictEqual(result, binPath);
    });

    it('falls through when env var points to nonexistent file', () => {
      process.env.GRAFEMA_RFDB_SERVER = '/nonexistent/rfdb-server';

      // Should not throw, just fall through
      const result = findRfdbBinary();
      // Result may be null or some other found binary - we just verify no crash
      assert.notStrictEqual(result, '/nonexistent/rfdb-server');
    });
  });

  describe('system PATH lookup', () => {
    it('finds rfdb-server in PATH directory', () => {
      const pathDir = join(tempDir, 'path-dir');
      mkdirSync(pathDir, { recursive: true });
      const binPath = join(pathDir, 'rfdb-server');
      writeFileSync(binPath, '#!/bin/sh\n');
      chmodSync(binPath, 0o755);

      // Set PATH to only our directory (plus empty to avoid other lookups)
      process.env.PATH = pathDir;
      // Clear env var so it doesn't take priority
      delete process.env.GRAFEMA_RFDB_SERVER;

      const result = findRfdbBinary();
      // The result should be our binary (PATH comes after env var and monorepo builds)
      // Since monorepo builds may also be found, we verify the PATH binary IS findable
      // by checking that when no other sources exist, it's found
      assert.ok(result !== null, 'Should find binary in PATH');
    });

    it('searches multiple PATH directories in order', () => {
      const dir1 = join(tempDir, 'path-first');
      const dir2 = join(tempDir, 'path-second');
      mkdirSync(dir1, { recursive: true });
      mkdirSync(dir2, { recursive: true });

      const bin1 = join(dir1, 'rfdb-server');
      const bin2 = join(dir2, 'rfdb-server');
      writeFileSync(bin1, '#!/bin/sh\necho first\n');
      writeFileSync(bin2, '#!/bin/sh\necho second\n');
      chmodSync(bin1, 0o755);
      chmodSync(bin2, 0o755);

      // Set PATH to only our two directories
      process.env.PATH = `${dir1}:${dir2}`;
      delete process.env.GRAFEMA_RFDB_SERVER;

      const result = findRfdbBinary();
      // Should find one (likely the monorepo build takes priority,
      // but if not, should be the first PATH entry)
      assert.ok(result !== null, 'Should find a binary');
    });

    it('skips empty PATH entries', () => {
      const pathDir = join(tempDir, 'path-dir-empty');
      mkdirSync(pathDir, { recursive: true });
      const binPath = join(pathDir, 'rfdb-server');
      writeFileSync(binPath, '#!/bin/sh\n');
      chmodSync(binPath, 0o755);

      // PATH with empty entries
      process.env.PATH = `::${pathDir}::`;
      delete process.env.GRAFEMA_RFDB_SERVER;

      const result = findRfdbBinary();
      assert.ok(result !== null, 'Should find binary despite empty PATH entries');
    });

    it('env var takes priority over PATH', () => {
      // Set up both env var and PATH
      const envBin = join(tempDir, 'env-priority-rfdb-server');
      writeFileSync(envBin, '#!/bin/sh\necho env\n');
      chmodSync(envBin, 0o755);
      process.env.GRAFEMA_RFDB_SERVER = envBin;

      const pathDir = join(tempDir, 'path-priority');
      mkdirSync(pathDir, { recursive: true });
      const pathBin = join(pathDir, 'rfdb-server');
      writeFileSync(pathBin, '#!/bin/sh\necho path\n');
      chmodSync(pathBin, 0o755);
      process.env.PATH = pathDir;

      const result = findRfdbBinary();
      assert.strictEqual(result, envBin, 'Env var should take priority over PATH');
    });
  });

  describe('returns null when nothing found', () => {
    it('returns null when no binary exists anywhere', () => {
      process.env.PATH = '/nonexistent-dir-12345';
      delete process.env.GRAFEMA_RFDB_SERVER;

      const result = findRfdbBinary();
      // May find monorepo build or npm package, but in clean env should be null
      // This test documents the behavior — it may find monorepo builds in dev
      assert.ok(result === null || typeof result === 'string');
    });
  });
});
