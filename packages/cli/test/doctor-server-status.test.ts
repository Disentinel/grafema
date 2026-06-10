/**
 * Tests for `checkServerStatus` socket-staleness discrimination.
 *
 * Regression guard for the destructive false-positive in the diagnostic check:
 * `grafema doctor` must only delete `.grafema/rfdb.sock` when the socket is
 * genuinely STALE (no listener bound). A live server that accepted the
 * connection but is slow/unresponsive to `ping` (e.g. under RFDB write-lock
 * contention, where reads can time out at 60s) must NOT have its socket file
 * removed — doing so breaks new connections to a healthy server.
 *
 * Discriminator: if `client.connect()` resolves, a listener is bound to the
 * socket, so the socket is NOT stale regardless of a later ping failure.
 *
 * Backend-free: drives `checkServerStatus` directly with an in-process
 * `net` server. No CLI spawn, no native binary.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkServerStatus } from '../src/commands/doctor/checks.ts';

describe('checkServerStatus — socket staleness discrimination', () => {
  let projectPath: string;
  let socketPath: string;
  let server: Server | undefined;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'grafema-doctor-'));
    mkdirSync(join(projectPath, '.grafema'), { recursive: true });
    socketPath = join(projectPath, '.grafema', 'rfdb.sock');
    server = undefined;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('warns (does not crash) when no socket file exists', async () => {
    const result = await checkServerStatus(projectPath);
    assert.strictEqual(result.status, 'warn');
    assert.match(result.message, /not running/i);
  });

  it('removes a genuinely stale socket (no listener bound)', async () => {
    // A leftover file at the socket path with nothing listening: connect() must
    // fail, so the file is stale and should be removed.
    writeFileSync(socketPath, '');
    assert.ok(existsSync(socketPath));

    const result = await checkServerStatus(projectPath);

    assert.strictEqual(result.status, 'warn');
    assert.match(result.message, /stale socket removed/i);
    assert.ok(!existsSync(socketPath), 'stale socket file should be removed');
  });

  it('does NOT remove the socket of a live server that is unresponsive to ping', async () => {
    // A server that accepts the connection but drops it (stand-in for a live
    // but unresponsive server whose ping would time out). connect() resolves,
    // so the listener is alive — the socket must be preserved.
    server = createServer((sock) => {
      setTimeout(() => sock.destroy(), 50);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, () => resolve());
    });
    assert.ok(existsSync(socketPath));

    const result = await checkServerStatus(projectPath);

    assert.ok(
      existsSync(socketPath),
      'socket of a live (connection-accepting) server must not be deleted'
    );
    assert.strictEqual(result.status, 'warn');
    assert.doesNotMatch(
      result.message,
      /stale socket removed/i,
      'a live server must not be reported as a removed stale socket'
    );
  });
});
