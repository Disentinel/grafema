/**
 * REG-1199 — a detached rfdb-server that outlived its database must not be
 * silently reused.
 *
 * Shape of the defect (measured, ticket row 2): the server is spawned
 * detached and survives the CLI. Its socket lives in /tmp (the SUN_LEN
 * fallback in resolveSocketPath), so it OUTLIVES the project directory. Delete
 * the project and recreate it under the same name and the next run connects
 * straight back to the old process, which still holds the deleted
 * `graph.rfdb` — and the first write fails with
 *
 *   RFDB server error: V2 commit_batch failed: IO error: No such file or
 *   directory (os error 2)
 *
 * which reads as "a file is missing" and sends the reader after the binary
 * resolver instead of the live process.
 *
 * Two things are asserted here, and only the message assertions discriminate:
 * a bare "it failed" is satisfied by the defect itself.
 *
 * NOTE: this test spawns the real rfdb-server binary. It is skipped when the
 * binary cannot be resolved rather than reported as a pass.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { RFDBServerBackend, findRfdbBinary } from '@grafema/util';

const binary = findRfdbBinary();
const skip = binary ? false : 'rfdb-server binary not found';

/**
 * A project path deep enough that `<dir>/rfdb.sock` exceeds SUN_LEN (104 on
 * darwin), which is what makes resolveSocketPath fall back to
 * /tmp/grafema-<hash>.sock. That fallback is the production shape in which the
 * socket survives `rm -rf` of the project (28 such sockets were counted on the
 * reporter's machine).
 */
function deepProjectPath() {
  const tag = randomBytes(4).toString('hex');
  return join(
    tmpdir(),
    `grafema-stale-${tag}`,
    'nested-directory-level-one-padding-to-exceed-sun-len',
    'nested-directory-level-two-padding-to-exceed-sun-len',
    'project',
  );
}

/** PID file the server lifecycle keeps for a given socket. */
function pidPathFor(socketPath) {
  return join(dirname(socketPath), `${basename(socketPath, '.sock')}.pid`);
}

/**
 * PIDs of the servers listening on this socket, found by command line rather
 * than by PID file: before the fix the PID file is the SHARED /tmp/rfdb.pid,
 * and killing whatever it points at would take down an unrelated project's
 * server — the very collision this ticket is about.
 */
function pidsForSocket(socketPath) {
  try {
    return execFileSync('pgrep', ['-f', socketPath], { encoding: 'utf8' })
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((p) => p > 0 && p !== process.pid);
  } catch {
    return [];
  }
}

describe('REG-1199 stale detached rfdb-server', { skip, timeout: 120_000 }, () => {
  let projectPath;
  let grafemaDir;
  let dbPath;
  let socketPath;
  const spawnedPids = new Set();

  before(() => {
    projectPath = deepProjectPath();
    grafemaDir = join(projectPath, '.grafema');
    dbPath = join(grafemaDir, 'graph.rfdb');
    mkdirSync(grafemaDir, { recursive: true });
  });

  after(() => {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (socketPath) {
      for (const pid of pidsForSocket(socketPath)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      for (const leftover of [
        socketPath,
        pidPathFor(socketPath),
        join(dirname(socketPath), `${basename(socketPath, '.sock')}.server.json`),
      ]) {
        try {
          rmSync(leftover, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    if (projectPath) rmSync(dirname(dirname(dirname(projectPath))), { recursive: true, force: true });
  });

  it('writes a PID file that is unique per socket, not the shared /tmp/rfdb.pid', async () => {
    const backend = new RFDBServerBackend({ dbPath, silent: true });
    socketPath = backend.socketPath;
    assert.ok(
      socketPath.startsWith('/tmp/grafema-'),
      `expected the SUN_LEN /tmp fallback socket, got ${socketPath}`,
    );

    await backend.connect();
    backend.beginBatch();
    await backend.addNodes([
      { id: 'fn-1', nodeType: 'FUNCTION', name: 'alive', file: 'a.js', exported: false, metadata: '{}' },
    ]);
    await backend.commitBatch(['reg-1199']);
    await backend.close();

    for (const pid of pidsForSocket(socketPath)) spawnedPids.add(pid);

    const pidPath = pidPathFor(socketPath);
    assert.ok(
      existsSync(pidPath),
      `PID file must be per-project (derived from the socket): expected ${pidPath}. ` +
        'A single /tmp/rfdb.pid is shared by every project that falls back to a /tmp socket.',
    );
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    assert.ok(pid > 0, 'PID file must hold a live PID');
    spawnedPids.add(pid);
  });

  it('reports the stale server, not ENOENT, when the project was recreated under the same name', async () => {
    // Row 2 of the ticket's matrix: same path, directory deleted and recreated,
    // server left alive. The /tmp socket survives, so the next run reconnects
    // to a process still holding the deleted graph.rfdb.
    rmSync(projectPath, { recursive: true, force: true });
    mkdirSync(grafemaDir, { recursive: true });
    assert.ok(existsSync(socketPath), 'precondition: the detached server socket outlives the project');

    const backend = new RFDBServerBackend({ dbPath, silent: true });
    let error = null;
    try {
      await backend.connect();
      backend.beginBatch();
      await backend.addNodes([
        { id: 'fn-2', nodeType: 'FUNCTION', name: 'after-recreate', file: 'b.js', exported: false, metadata: '{}' },
      ]);
      await backend.commitBatch(['reg-1199']);
    } catch (e) {
      error = e;
    } finally {
      try {
        await backend.close();
      } catch {
        /* the connection may already be unusable */
      }
    }

    assert.ok(error, 'writing through a server that holds a deleted database must not silently succeed');

    // The discriminating assertions. "It threw" is satisfied by the defect.
    assert.match(
      error.message,
      /database it was started with is gone|stale rfdb-server/i,
      `error must name the real cause (a stale server), got:\n${error.message}`,
    );
    assert.match(
      error.message,
      new RegExp(socketPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `error must name the socket to act on, got:\n${error.message}`,
    );
    assert.doesNotMatch(
      error.message,
      /No such file or directory/,
      `ENOENT is the misleading symptom, not the diagnosis:\n${error.message}`,
    );
  });
});
