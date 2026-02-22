/**
 * startRfdbServer() unit tests (RFD-40 Phase 1)
 *
 * Tests for the unified RFDB server spawn utility.
 * All tests use dependency injection (_deps) to mock spawn/findRfdbBinary —
 * no actual server process is spawned.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

// Import from dist (tests run against built output)
import { startRfdbServer } from '../../packages/core/dist/utils/startRfdbServer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique temp directory per test run to avoid collisions */
const testDir = join(tmpdir(), `startRfdbServer-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
mkdirSync(testDir, { recursive: true });

/**
 * Create a fake ChildProcess-like object returned by our mock spawn.
 * Supports .on(), .unref(), .pid, and emitting 'error'.
 */
function createFakeProcess(options = {}) {
  const proc = new EventEmitter();
  proc.pid = 'pid' in options ? options.pid : 99999;
  proc.unref = () => {};
  proc.kill = () => {};
  proc.stdin = null;
  proc.stdout = null;
  proc.stderr = null;
  return proc;
}

/**
 * Create a mock spawn that returns a given fake process.
 * Records calls for later assertions.
 */
function createMockSpawn(fakeProcess) {
  const calls = [];
  function mockSpawn(command, args, options) {
    calls.push({ command, args, options });
    return fakeProcess;
  }
  mockSpawn.calls = calls;
  return mockSpawn;
}

/**
 * Create a mock existsSync that returns true for socketPath after N calls.
 * This simulates the socket appearing after a polling delay.
 *
 * @param {string} socketPath - the path to simulate appearing
 * @param {number} appearAfter - how many existsSync calls before it "appears"
 *   (0 = immediately on first poll check)
 */
function createMockExistsSync(socketPath, appearAfter = 0) {
  let callCount = 0;
  return function mockExistsSync(path) {
    if (path === socketPath) {
      callCount++;
      // First call is the stale-socket check (before spawn).
      // Polling starts after spawn. We want it to appear on poll iteration `appearAfter`.
      // callCount 1 = stale socket check, callCount 2+ = polling.
      // So appear when callCount > 1 + appearAfter.
      return callCount > 1 + appearAfter;
    }
    // For all other paths, delegate to real existsSync
    return existsSync(path);
  };
}

/**
 * Create a mock existsSync that NEVER returns true for socketPath (timeout scenario).
 */
function createNeverAppearsExistsSync(socketPath) {
  return function mockExistsSync(path) {
    if (path === socketPath) return false;
    return existsSync(path);
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  // Clean up any temp files created during tests
  try {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  } catch {
    // ignore
  }
});

// Final cleanup after all tests
process.on('exit', () => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startRfdbServer', () => {
  describe('binary resolution', () => {
    it('throws descriptive error when binary not found (findRfdbBinary returns null, no binaryPath)', async () => {
      const socketPath = join(testDir, 'test1.sock');
      const fakeProcess = createFakeProcess();
      const mockSpawn = createMockSpawn(fakeProcess);

      await assert.rejects(
        () => startRfdbServer({
          dbPath: '/tmp/test.rfdb',
          socketPath,
          _deps: {
            spawn: mockSpawn,
            findRfdbBinary: () => null,
            existsSync: createMockExistsSync(socketPath, 0),
          },
        }),
        (err) => {
          assert.ok(err instanceof Error, 'Should throw an Error');
          // Error message should clearly indicate binary was not found
          const msg = err.message.toLowerCase();
          assert.ok(
            msg.includes('binary') && (msg.includes('not found') || msg.includes('not available')),
            `Error message should mention binary not found, got: "${err.message}"`
          );
          return true;
        }
      );

      // spawn should NOT have been called since binary resolution failed
      assert.strictEqual(mockSpawn.calls.length, 0, 'spawn should not be called when binary not found');
    });

    it('uses explicit binaryPath when provided (does not call findRfdbBinary)', async () => {
      const socketPath = join(testDir, 'test2.sock');
      const explicitBinary = '/some/explicit/rfdb-server';
      const fakeProcess = createFakeProcess();
      const mockSpawn = createMockSpawn(fakeProcess);

      let findBinaryCalled = false;

      await startRfdbServer({
        dbPath: '/tmp/test.rfdb',
        socketPath,
        binaryPath: explicitBinary,
        _deps: {
          spawn: mockSpawn,
          findRfdbBinary: () => { findBinaryCalled = true; return '/other/path'; },
          existsSync: createMockExistsSync(socketPath, 0),
        },
      });

      // Verify spawn was called with the explicit path
      assert.strictEqual(mockSpawn.calls.length, 1, 'spawn should be called exactly once');
      assert.strictEqual(mockSpawn.calls[0].command, explicitBinary,
        'spawn should use the explicit binaryPath');

      // findRfdbBinary should NOT have been called
      assert.strictEqual(findBinaryCalled, false,
        'findRfdbBinary should not be called when binaryPath is provided');
    });
  });

  describe('stale socket cleanup', () => {
    it('removes stale socket file before spawn', async () => {
      const socketPath = join(testDir, 'stale.sock');
      // Create a file at socketPath to simulate a stale socket
      writeFileSync(socketPath, 'stale-data');
      assert.ok(existsSync(socketPath), 'Stale socket file should exist before test');

      const fakeProcess = createFakeProcess();
      const mockSpawn = createMockSpawn(fakeProcess);

      // Use real existsSync for the stale check + mock for polling.
      // The function should: (1) see stale socket, (2) remove it, (3) spawn, (4) poll.
      // We need existsSync to return true for the initial stale check,
      // then true for the poll (simulating socket appearing).
      let callCount = 0;
      const mockExists = (path) => {
        if (path === socketPath) {
          callCount++;
          if (callCount === 1) {
            // First check: stale socket exists
            return true;
          }
          // Subsequent checks (polling): socket appears immediately
          return true;
        }
        return existsSync(path);
      };

      // Track unlinkSync calls
      let unlinkedPath = null;
      const mockUnlink = (path) => {
        unlinkedPath = path;
        // Actually remove the file so we can verify
        try { unlinkSync(path); } catch { /* ignore */ }
      };

      await startRfdbServer({
        dbPath: '/tmp/test.rfdb',
        socketPath,
        binaryPath: '/usr/bin/rfdb-server',
        _deps: {
          spawn: mockSpawn,
          findRfdbBinary: () => '/usr/bin/rfdb-server',
          existsSync: mockExists,
          unlinkSync: mockUnlink,
        },
      });

      assert.strictEqual(unlinkedPath, socketPath,
        'Should have called unlinkSync on the stale socket path');
    });
  });

  describe('PID file handling', () => {
    it('writes PID file when pidPath provided and process.pid is set', async () => {
      const socketPath = join(testDir, 'pid-test.sock');
      const pidPath = join(testDir, 'rfdb.pid');
      const fakePid = 12345;
      const fakeProcess = createFakeProcess({ pid: fakePid });
      const mockSpawn = createMockSpawn(fakeProcess);

      await startRfdbServer({
        dbPath: '/tmp/test.rfdb',
        socketPath,
        binaryPath: '/usr/bin/rfdb-server',
        pidPath,
        _deps: {
          spawn: mockSpawn,
          findRfdbBinary: () => '/usr/bin/rfdb-server',
          existsSync: createMockExistsSync(socketPath, 0),
        },
      });

      assert.ok(existsSync(pidPath), 'PID file should be created');
      const pidContent = readFileSync(pidPath, 'utf-8').trim();
      assert.strictEqual(pidContent, String(fakePid),
        `PID file should contain "${fakePid}", got "${pidContent}"`);
    });

    it('does NOT write PID file when pidPath is absent', async () => {
      const socketPath = join(testDir, 'no-pid-test.sock');
      const fakeProcess = createFakeProcess({ pid: 12345 });
      const mockSpawn = createMockSpawn(fakeProcess);

      // Track writeFileSync calls
      const writtenFiles = [];
      const mockWriteFile = (path, data) => {
        writtenFiles.push(path);
        writeFileSync(path, data);
      };

      await startRfdbServer({
        dbPath: '/tmp/test.rfdb',
        socketPath,
        binaryPath: '/usr/bin/rfdb-server',
        // NO pidPath
        _deps: {
          spawn: mockSpawn,
          findRfdbBinary: () => '/usr/bin/rfdb-server',
          existsSync: createMockExistsSync(socketPath, 0),
          writeFileSync: mockWriteFile,
        },
      });

      assert.strictEqual(writtenFiles.length, 0,
        'No files should be written when pidPath is absent');
    });

    it('does NOT write PID file when process.pid is undefined', async () => {
      const socketPath = join(testDir, 'no-pid-undef.sock');
      const pidPath = join(testDir, 'should-not-exist.pid');
      // Process with undefined pid (spawn failure edge case)
      const fakeProcess = createFakeProcess({ pid: undefined });
      const mockSpawn = createMockSpawn(fakeProcess);

      await startRfdbServer({
        dbPath: '/tmp/test.rfdb',
        socketPath,
        binaryPath: '/usr/bin/rfdb-server',
        pidPath,
        _deps: {
          spawn: mockSpawn,
          findRfdbBinary: () => '/usr/bin/rfdb-server',
          existsSync: createMockExistsSync(socketPath, 0),
        },
      });

      assert.ok(!existsSync(pidPath),
        'PID file should NOT be created when process.pid is undefined');
    });
  });

  describe('socket polling and timeout', () => {
    it('throws timeout error with binary path and timeout in message', async () => {
      const socketPath = join(testDir, 'timeout.sock');
      const binaryPath = '/opt/custom/rfdb-server';
      const timeoutMs = 200;
      const fakeProcess = createFakeProcess();
      const mockSpawn = createMockSpawn(fakeProcess);

      await assert.rejects(
        () => startRfdbServer({
          dbPath: '/tmp/test.rfdb',
          socketPath,
          binaryPath,
          waitTimeoutMs: timeoutMs,
          _deps: {
            spawn: mockSpawn,
            findRfdbBinary: () => binaryPath,
            existsSync: createNeverAppearsExistsSync(socketPath),
          },
        }),
        (err) => {
          assert.ok(err instanceof Error, 'Should throw an Error');
          const msg = err.message;
          // Error should contain binary path for debugging
          assert.ok(msg.includes(binaryPath),
            `Error message should include binary path "${binaryPath}", got: "${msg}"`);
          // Error should contain timeout info
          assert.ok(msg.includes(String(timeoutMs)) || msg.includes('200'),
            `Error message should include timeout duration, got: "${msg}"`);
          return true;
        }
      );
    });
  });

  describe('logger integration', () => {
    it('calls logger.debug during startup', async () => {
      const socketPath = join(testDir, 'logger.sock');
      const fakeProcess = createFakeProcess();
      const mockSpawn = createMockSpawn(fakeProcess);

      const debugMessages = [];
      const mockLogger = {
        debug: (msg) => debugMessages.push(msg),
      };

      await startRfdbServer({
        dbPath: '/tmp/test.rfdb',
        socketPath,
        binaryPath: '/usr/bin/rfdb-server',
        logger: mockLogger,
        _deps: {
          spawn: mockSpawn,
          findRfdbBinary: () => '/usr/bin/rfdb-server',
          existsSync: createMockExistsSync(socketPath, 0),
        },
      });

      assert.ok(debugMessages.length > 0,
        `logger.debug should have been called at least once, got ${debugMessages.length} calls`);
    });
  });

  describe('process error handling', () => {
    it('wires process.on("error") handler on the spawned process', async () => {
      const socketPath = join(testDir, 'error-handler.sock');
      const fakeProcess = createFakeProcess();
      const mockSpawn = createMockSpawn(fakeProcess);

      // Track .on() calls
      const originalOn = fakeProcess.on.bind(fakeProcess);
      const onCalls = [];
      fakeProcess.on = function (event, handler) {
        onCalls.push({ event, handler });
        return originalOn(event, handler);
      };

      await startRfdbServer({
        dbPath: '/tmp/test.rfdb',
        socketPath,
        binaryPath: '/usr/bin/rfdb-server',
        _deps: {
          spawn: mockSpawn,
          findRfdbBinary: () => '/usr/bin/rfdb-server',
          existsSync: createMockExistsSync(socketPath, 0),
        },
      });

      const errorHandlers = onCalls.filter(c => c.event === 'error');
      assert.ok(errorHandlers.length > 0,
        'process.on("error", handler) should have been called');
      assert.strictEqual(typeof errorHandlers[0].handler, 'function',
        'Error handler should be a function');
    });
  });

  describe('spawn arguments', () => {
    it('passes correct arguments to spawn (dbPath, --socket, socketPath, --data-dir)', async () => {
      const socketPath = join(testDir, 'args.sock');
      const dbPath = '/projects/myapp/.grafema/graph.rfdb';
      const binaryPath = '/usr/bin/rfdb-server';
      const fakeProcess = createFakeProcess();
      const mockSpawn = createMockSpawn(fakeProcess);

      await startRfdbServer({
        dbPath,
        socketPath,
        binaryPath,
        _deps: {
          spawn: mockSpawn,
          findRfdbBinary: () => binaryPath,
          existsSync: createMockExistsSync(socketPath, 0),
        },
      });

      assert.strictEqual(mockSpawn.calls.length, 1, 'spawn should be called once');
      const call = mockSpawn.calls[0];
      assert.strictEqual(call.command, binaryPath);

      // Verify args contain dbPath, --socket, socketPath
      assert.ok(call.args.includes(dbPath), `args should contain dbPath "${dbPath}"`);
      assert.ok(call.args.includes('--socket'), 'args should contain "--socket"');
      assert.ok(call.args.includes(socketPath), `args should contain socketPath "${socketPath}"`);

      // Verify spawn options include detached: true
      assert.strictEqual(call.options.detached, true, 'spawn should use detached: true');
    });
  });
});

// ---------------------------------------------------------------------------
// checkExistingServer tests (RFD-43)
//
// Uses dynamic import so that if checkExistingServer is not yet exported,
// existing startRfdbServer tests are not broken by a failed static import.
// ---------------------------------------------------------------------------

// Eagerly try to import checkExistingServer; set to null if not available yet
let _checkExistingServer = null;
try {
  const _mod = await import('../../packages/core/dist/utils/startRfdbServer.js');
  _checkExistingServer = _mod.checkExistingServer ?? null;
} catch {
  // Module not built yet or export missing — tests will be skipped below
}

describe('checkExistingServer', { skip: !_checkExistingServer ? 'checkExistingServer not yet exported' : false }, () => {
  const checkExistingServer = _checkExistingServer;
  const pidPath = join(testDir, 'rfdb.pid');
  const socketPath = join(testDir, 'rfdb.sock');

  it('returns none when pid file absent', async () => {
    const result = await checkExistingServer(pidPath, socketPath, {
      existsSync: () => false,
      readFileSync: () => { throw new Error('should not be called'); },
      killProcess: () => { throw new Error('should not be called'); },
    });

    assert.strictEqual(result, 'none',
      'Should return "none" when PID file does not exist');
  });

  it('returns alive when pid is live and socket exists', async () => {
    const fakePid = 12345;

    const result = await checkExistingServer(pidPath, socketPath, {
      existsSync: (path) => {
        if (path === pidPath) return true;
        if (path === socketPath) return true;
        return false;
      },
      readFileSync: (path) => {
        if (path === pidPath) return String(fakePid);
        throw new Error(`Unexpected readFileSync: ${path}`);
      },
      killProcess: (pid, signal) => {
        // process.kill(pid, 0) returns true if process is alive
        assert.strictEqual(pid, fakePid, 'Should check the PID from file');
        assert.strictEqual(signal, 0, 'Should use signal 0 for liveness check');
        return true;
      },
    });

    assert.strictEqual(result, 'alive',
      'Should return "alive" when PID is live and socket exists');
  });

  it('returns stale when pid is dead (ESRCH)', async () => {
    const result = await checkExistingServer(pidPath, socketPath, {
      existsSync: (path) => path === pidPath,
      readFileSync: () => '99999',
      killProcess: () => {
        const err = new Error('kill ESRCH');
        err.code = 'ESRCH';
        throw err;
      },
    });

    assert.strictEqual(result, 'stale',
      'Should return "stale" when process.kill throws ESRCH (process is dead)');
  });

  it('returns stale when pid <= 0 (guards against kill(0) / kill(-1))', async () => {
    // PID 0 would signal the entire process group
    const resultZero = await checkExistingServer(pidPath, socketPath, {
      existsSync: (path) => path === pidPath,
      readFileSync: () => '0',
      killProcess: () => { throw new Error('should not be called for pid 0'); },
    });

    assert.strictEqual(resultZero, 'stale',
      'Should return "stale" for PID 0 (would signal entire process group)');

    // PID -1 would signal all processes owned by the user
    const resultNeg = await checkExistingServer(pidPath, socketPath, {
      existsSync: (path) => path === pidPath,
      readFileSync: () => '-1',
      killProcess: () => { throw new Error('should not be called for negative pid'); },
    });

    assert.strictEqual(resultNeg, 'stale',
      'Should return "stale" for negative PID (would signal all user processes)');
  });

  it('returns stale when readFileSync throws EACCES', async () => {
    const result = await checkExistingServer(pidPath, socketPath, {
      existsSync: (path) => path === pidPath,
      readFileSync: () => {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      },
      killProcess: () => { throw new Error('should not be called'); },
    });

    assert.strictEqual(result, 'stale',
      'Should return "stale" when PID file is unreadable (EACCES)');
  });

  it('returns stale when pid file contains NaN', async () => {
    const result = await checkExistingServer(pidPath, socketPath, {
      existsSync: (path) => path === pidPath,
      readFileSync: () => 'not-a-number',
      killProcess: () => { throw new Error('should not be called'); },
    });

    assert.strictEqual(result, 'stale',
      'Should return "stale" when PID file contains non-numeric content');
  });

  it('returns stale when process alive but socket absent', async () => {
    const result = await checkExistingServer(pidPath, socketPath, {
      existsSync: (path) => {
        if (path === pidPath) return true;
        if (path === socketPath) return false; // socket does not exist
        return false;
      },
      readFileSync: () => '12345',
      killProcess: (pid, signal) => {
        // Process is alive but socket is gone (partially crashed server)
        return true;
      },
    });

    assert.strictEqual(result, 'stale',
      'Should return "stale" when PID is alive but socket file is absent');
  });

  it('re-throws non-ESRCH errors from kill', async () => {
    // checkExistingServer is synchronous, so use assert.throws (not assert.rejects)
    assert.throws(
      () => checkExistingServer(pidPath, socketPath, {
        existsSync: (path) => path === pidPath,
        readFileSync: () => '12345',
        killProcess: () => {
          const err = new Error('kill EPERM');
          err.code = 'EPERM';
          throw err;
        },
      }),
      (err) => {
        assert.ok(err instanceof Error, 'Should throw an Error');
        assert.strictEqual(err.code, 'EPERM',
          'Should re-throw the original error with its code');
        return true;
      },
      'Should re-throw non-ESRCH errors from process.kill'
    );
  });
});
