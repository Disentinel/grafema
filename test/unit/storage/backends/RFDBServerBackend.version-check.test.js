/**
 * RFDBServerBackend Version Check Test (RFD-42)
 *
 * Verifies that the client validates the RFDB server version during connect()
 * and logs a warning when client and server schema versions differ.
 *
 * Two test groups:
 * 1. getSchemaVersion() pure function — edge cases for pre-release stripping
 * 2. Integration test — real server connect, capture log output, verify
 *    version mismatch warning appears (Cargo.toml is 0.1.0, npm is 0.2.11)
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { RFDBServerBackend, getSchemaVersion, GRAFEMA_VERSION } from '@grafema/core';

let testCounter = 0;

/**
 * Create unique test paths for each test run
 */
function createTestPaths() {
  const testId = `version-check-${Date.now()}-${testCounter++}`;
  const testDir = join(tmpdir(), `.grafema-test-${testId}`);
  const dbPath = join(testDir, 'graph.rfdb');
  const socketPath = join(testDir, 'rfdb.sock');

  mkdirSync(testDir, { recursive: true });

  return { testDir, dbPath, socketPath };
}

// =============================================================================
// Unit tests: getSchemaVersion()
// =============================================================================

describe('getSchemaVersion()', () => {
  it('should return version unchanged when no pre-release tag', () => {
    assert.strictEqual(getSchemaVersion('0.2.5'), '0.2.5');
  });

  it('should strip simple pre-release tag', () => {
    assert.strictEqual(getSchemaVersion('0.2.5-beta'), '0.2.5');
  });

  it('should strip multi-segment pre-release tag', () => {
    assert.strictEqual(getSchemaVersion('1.0.0-alpha.1'), '1.0.0');
  });

  it('should handle version with only major.minor', () => {
    // Defensive: not standard semver, but should not crash
    assert.strictEqual(getSchemaVersion('0.2'), '0.2');
  });

  it('should return empty string for empty input', () => {
    assert.strictEqual(getSchemaVersion(''), '');
  });

  it('should strip pre-release from version with build metadata', () => {
    // "1.0.0-rc.1" -> "1.0.0" (hyphen splits at first occurrence)
    assert.strictEqual(getSchemaVersion('1.0.0-rc.1'), '1.0.0');
  });
});

// =============================================================================
// Integration test: version mismatch warning on connect
// =============================================================================

describe('RFDBServerBackend version check on connect (RFD-42)', () => {
  let testPaths;

  before(() => {
    testPaths = createTestPaths();
  });

  after(async () => {
    // Kill the RFDB server started by autoStart to prevent test from hanging
    if (testPaths?.socketPath) {
      try {
        const pid = execSync(
          `lsof -t "${testPaths.socketPath}" 2>/dev/null || true`,
          { encoding: 'utf-8' }
        ).trim();
        if (pid) {
          process.kill(Number(pid.split('\n')[0]), 'SIGTERM');
        }
      } catch {
        // Ignore — server may already be stopped
      }
    }
    if (testPaths?.testDir) {
      try {
        rmSync(testPaths.testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should log a version mismatch warning when server version differs from client', async () => {
    const { dbPath, socketPath } = testPaths;

    // Capture log output by intercepting console.log
    const logMessages = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logMessages.push(args.join(' '));
    };

    try {
      const backend = new RFDBServerBackend({
        dbPath,
        socketPath,
        autoStart: true,
        silent: false, // We need log output to verify the warning
      });

      await backend.connect();

      // The server binary reports its Cargo.toml version (currently 0.1.0).
      // The client reads GRAFEMA_VERSION from @grafema/core/package.json (currently 0.2.11).
      // These differ, so _negotiateProtocol() should log a version mismatch warning.

      const clientSchema = getSchemaVersion(GRAFEMA_VERSION);
      assert.ok(
        clientSchema !== '0.1.0',
        `Test precondition: client schema version (${clientSchema}) should differ from server (0.1.0) for this test to be meaningful`
      );

      const mismatchWarning = logMessages.find(
        msg => msg.includes('version mismatch') || msg.includes('Version mismatch')
      );
      assert.ok(
        mismatchWarning,
        `Expected a version mismatch warning in log output.\n` +
        `Client version: ${GRAFEMA_VERSION} (schema: ${clientSchema})\n` +
        `Server version: likely 0.1.0\n` +
        `Log messages captured:\n${logMessages.map(m => `  - ${m}`).join('\n')}`
      );

      // The warning should mention both versions so the user can diagnose
      assert.ok(
        mismatchWarning.includes('0.1') || mismatchWarning.includes(clientSchema),
        `Warning should mention version numbers. Got: ${mismatchWarning}`
      );

      await backend.close();
    } finally {
      console.log = originalLog;
    }
  });

  it('should still connect successfully despite version mismatch', async () => {
    const { dbPath, socketPath } = testPaths;

    // Suppress log output for this test — we only care about connectivity
    const backend = new RFDBServerBackend({
      dbPath,
      socketPath,
      autoStart: true,
      silent: true,
    });

    await backend.connect();

    // Connection should succeed — version mismatch is a warning, not an error
    assert.ok(backend.connected, 'Backend should be connected despite version mismatch');

    // Verify the server is actually functional
    const nodeCount = await backend.nodeCount();
    assert.strictEqual(typeof nodeCount, 'number', 'Should be able to query node count');

    await backend.close();
  });
});
