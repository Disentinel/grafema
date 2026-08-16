/**
 * Shared utility for starting rfdb-server
 *
 * Single authoritative function for spawning rfdb-server. All spawn sites
 * (RFDBServerBackend, CLI server command, ParallelAnalysisRunner) delegate here.
 *
 * If pidPath is provided, checks for an existing server via PID file before
 * spawning. Returns null when an existing server is detected (caller should
 * not kill it).
 *
 * REG-1199: "an existing server" is not the same question as "a live process".
 * The server is spawned detached and outlives the CLI, and its socket may live
 * in /tmp (the SUN_LEN fallback), so it also outlives the project directory.
 * Reuse therefore has to establish that the live process still serves THIS
 * database, and the bookkeeping files have to be per-project.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync, openSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { findRfdbBinary } from './findRfdbBinary.js';

export interface StartRfdbServerOptions {
  dbPath: string;
  socketPath: string;
  /** Override binary path; if absent, findRfdbBinary() is called */
  binaryPath?: string;
  /** If provided, PID file is written after spawn and checked before spawn */
  pidPath?: string;
  /** Socket poll timeout in ms (default: 30000) */
  waitTimeoutMs?: number;
  /** Extra CLI arguments to pass to rfdb-server */
  extraArgs?: string[];
  /** Optional logger for debug messages */
  logger?: { debug(msg: string): void };
  /** Internal: dependency injection for testing */
  _deps?: {
    spawn?: typeof spawn;
    findRfdbBinary?: () => string | null;
    existsSync?: (path: string) => boolean;
    unlinkSync?: (path: string) => void;
    writeFileSync?: (path: string, data: string) => void;
    readFileSync?: (path: string, encoding: 'utf8') => string;
    killProcess?: (pid: number, signal: number) => boolean;
    pathIdentity?: (path: string) => string | null;
  };
}

/**
 * PID file for the server that owns `socketPath`.
 *
 * REG-1199: this used to be `join(dirname(socketPath), 'rfdb.pid')`. Sockets
 * are per-project, but that name is not: every project whose socket falls back
 * to `/tmp/grafema-<hash>.sock` shared a single `/tmp/rfdb.pid` (28 sockets
 * against 1 PID file, measured on the reporter's machine), so a liveness check
 * could answer 'alive' from another project's server. Deriving the name from
 * the socket keeps it per-project and leaves the in-project layout
 * (`.grafema/rfdb.sock` → `.grafema/rfdb.pid`) exactly as it was.
 */
export function rfdbPidPath(socketPath: string): string {
  return join(dirname(socketPath), `${basename(socketPath, '.sock')}.pid`);
}

/**
 * Sidecar recording WHICH database the server on `socketPath` was started
 * with. It lives next to the socket (not next to the database) on purpose: the
 * question it answers — "is the database this server holds still there?" —
 * only arises when the project directory is gone.
 */
export function rfdbServerRecordPath(socketPath: string): string {
  return join(dirname(socketPath), `${basename(socketPath, '.sock')}.server.json`);
}

/** What a running server was started against, written at spawn time. */
export interface RfdbServerRecord {
  pid: number;
  /** Absolute path the server was given. */
  dbPath: string;
  /** `dev:ino` of the directory holding the database, or null if unknown. */
  dbDirKey: string | null;
  /** Whether the database itself already existed when the server started. */
  dbExisted: boolean;
  startedAt: string;
}

/**
 * Filesystem identity of a path: `dev:ino`, or null when it does not exist.
 *
 * A path STRING is not an identity — `rm -rf project && mkdir project` gives
 * back the same string with a different inode, which is exactly the case that
 * produced the misleading ENOENT.
 */
export function pathIdentity(path: string): string | null {
  const st = statSync(path, { throwIfNoEntry: false });
  return st ? `${st.dev}:${st.ino}` : null;
}

/** Whether a PID names a live process. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to someone else.
    return !!(err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EPERM');
  }
}

export type ServerDbVerdict =
  | { state: 'ok' }
  /** No record to compare against — the server was started by something else. */
  | { state: 'unverifiable'; reason: string }
  | { state: 'stale'; reason: string; record: RfdbServerRecord };

/**
 * Decide whether the server listening on `socketPath` still serves `dbPath`.
 *
 * Deliberately compares the identity of the DIRECTORY that holds the database
 * plus the database's continued existence, and NOT the database's own inode: a
 * running server may legitimately replace its store file (atomic rename after
 * compaction), and a false "stale" verdict on a healthy setup would be worse
 * than the defect being fixed. Recreating the project always changes the
 * holding directory's inode, so the reported scenario is caught either way.
 */
export function checkServerDatabase(
  socketPath: string,
  dbPath: string,
  deps: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: 'utf8') => string;
    pathIdentity: (path: string) => string | null;
    isProcessAlive?: (pid: number) => boolean;
  },
): ServerDbVerdict {
  const recordPath = rfdbServerRecordPath(socketPath);
  if (!deps.existsSync(recordPath)) {
    return { state: 'unverifiable', reason: `no server record at ${recordPath}` };
  }

  let record: RfdbServerRecord;
  try {
    record = JSON.parse(deps.readFileSync(recordPath, 'utf8')) as RfdbServerRecord;
  } catch {
    return { state: 'unverifiable', reason: `unreadable server record at ${recordPath}` };
  }
  if (!record || typeof record.dbPath !== 'string') {
    return { state: 'unverifiable', reason: `malformed server record at ${recordPath}` };
  }

  // A record whose process is gone describes nothing: whoever is answering on
  // this socket now was started by some other path (the VS Code extension
  // spawns its own server and writes no record). Treating that as 'stale'
  // would refuse a healthy server — the opposite defect.
  const isAlive = deps.isProcessAlive ?? processIsAlive;
  if (typeof record.pid === 'number' && !isAlive(record.pid)) {
    return { state: 'unverifiable', reason: `the recorded server (PID ${record.pid}) is gone` };
  }

  const wanted = resolve(dbPath);
  if (resolve(record.dbPath) !== wanted) {
    return {
      state: 'stale',
      reason: `it was started against ${record.dbPath}, not ${wanted}`,
      record,
    };
  }

  const dbDir = dirname(wanted);
  if (record.dbDirKey !== null) {
    const currentDirKey = deps.pathIdentity(dbDir);
    if (currentDirKey === null) {
      return { state: 'stale', reason: `${dbDir} no longer exists`, record };
    }
    if (currentDirKey !== record.dbDirKey) {
      return {
        state: 'stale',
        reason: `${dbDir} was replaced (a new directory of the same name)`,
        record,
      };
    }
  }

  if (record.dbExisted && !deps.existsSync(wanted)) {
    return { state: 'stale', reason: `${wanted} was removed`, record };
  }

  return { state: 'ok' };
}

/**
 * The diagnosis a caller must show instead of the server's bare ENOENT.
 */
export function staleServerMessage(
  socketPath: string,
  verdict: { reason: string; record: RfdbServerRecord },
): string {
  const { reason, record } = verdict;
  return (
    `Stale rfdb-server on ${socketPath}: the database it was started with is gone — ${reason}.\n` +
    `The detached server (PID ${record.pid}) is still alive and still holding the old database, ` +
    `so writes through it fail with a bare ENOENT that reads as a missing file or binary.\n` +
    `Stop it and retry:\n` +
    `  grafema server stop\n` +
    `  or: kill ${record.pid} && rm -f ${rfdbPidPath(socketPath)} ${socketPath} ${rfdbServerRecordPath(socketPath)}`
  );
}

/**
 * Check if an existing server is running based on PID file.
 *
 * Returns:
 * - 'alive' — PID file exists, process is alive, socket is present
 * - 'stale' — PID file exists but process is dead or PID is invalid
 * - 'none'  — no PID file
 */
export function checkExistingServer(
  pidPath: string,
  socketPath: string,
  deps: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: 'utf8') => string;
    killProcess: (pid: number, signal: number) => boolean;
  },
): 'alive' | 'stale' | 'none' {
  if (!deps.existsSync(pidPath)) return 'none';

  let pidStr: string;
  try {
    pidStr = deps.readFileSync(pidPath, 'utf8').trim();
  } catch {
    return 'stale';
  }

  const pid = parseInt(pidStr, 10);
  if (isNaN(pid) || pid <= 0) return 'stale';

  try {
    deps.killProcess(pid, 0);
    // Process is alive — check socket too
    if (deps.existsSync(socketPath)) {
      return 'alive';
    }
    // PID alive but socket gone (server crashed partially)
    return 'stale';
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ESRCH') {
      return 'stale';
    }
    // Unexpected error — re-throw rather than silently treating as stale
    throw err;
  }
}

/**
 * Start an rfdb-server process (or detect existing one via PID file).
 *
 * 0. Check PID file for existing server (if pidPath provided), and that the
 *    live server still serves this database — throws with the real diagnosis
 *    if it does not (REG-1199)
 * 1. Resolve binary (explicit or via findRfdbBinary)
 * 2. Remove stale socket
 * 3. Spawn detached process
 * 4. Write PID file + server record (if pidPath provided)
 * 5. Poll for socket file up to waitTimeoutMs
 * 6. Return ChildProcess (caller decides whether to kill later)
 *
 * Returns null if an existing server is already running (pidPath + alive PID).
 */
export async function startRfdbServer(options: StartRfdbServerOptions): Promise<ChildProcess | null> {
  const {
    dbPath,
    socketPath,
    pidPath,
    waitTimeoutMs = 30_000,
    logger,
    _deps,
  } = options;

  const _spawn = _deps?.spawn ?? spawn;
  const _findRfdbBinary = _deps?.findRfdbBinary ?? findRfdbBinary;
  const _existsSync = _deps?.existsSync ?? existsSync;
  const _unlinkSync = _deps?.unlinkSync ?? unlinkSync;
  const _writeFileSync = _deps?.writeFileSync ?? writeFileSync;
  const _readFileSync = _deps?.readFileSync ?? readFileSync;
  const _killProcess = _deps?.killProcess ?? ((pid: number, signal: number) => process.kill(pid, signal));
  const _pathIdentity = _deps?.pathIdentity ?? pathIdentity;

  // 0. Check for existing server via PID file
  if (pidPath) {
    const status = checkExistingServer(pidPath, socketPath, {
      existsSync: _existsSync,
      readFileSync: _readFileSync,
      killProcess: _killProcess,
    });
    if (status === 'alive') {
      // A live process is not yet a usable one — it must still serve THIS
      // database (REG-1199).
      const verdict = checkServerDatabase(socketPath, dbPath, {
        existsSync: _existsSync,
        readFileSync: _readFileSync,
        pathIdentity: _pathIdentity,
      });
      if (verdict.state === 'stale') {
        throw new Error(staleServerMessage(socketPath, verdict));
      }
      logger?.debug(`rfdb-server already running (PID file: ${pidPath}), reusing`);
      return null;
    }
    if (status === 'stale') {
      logger?.debug(`Stale PID file found at ${pidPath}, removing`);
      try { _unlinkSync(pidPath); } catch { /* ignore */ }
    }
  }

  // 1. Resolve binary
  const binaryPath = options.binaryPath || _findRfdbBinary();
  if (!binaryPath) {
    throw new Error(
      'RFDB server binary not found.\n' +
      'Install @grafema/rfdb: npm install @grafema/rfdb\n' +
      'Or build from source: cargo build --release --bin rfdb-server'
    );
  }

  // 2. Remove stale socket
  if (_existsSync(socketPath)) {
    _unlinkSync(socketPath);
  }

  const dataDir = dirname(socketPath);
  logger?.debug(`Starting rfdb-server: ${binaryPath} ${dbPath} --socket ${socketPath} --data-dir ${dataDir}`);

  // 3. Spawn server (detached, survives parent exit)
  // Mutable container to capture async spawn errors (Dijkstra amendment B)
  const state = { spawnError: null as Error | null };

  const baseArgs = [dbPath, '--socket', socketPath, '--data-dir', dataDir];
  const args = options.extraArgs ? [...baseArgs, ...options.extraArgs] : baseArgs;

  // Write server logs to rfdb.log in data directory (survives detach)
  const logPath = join(dataDir, 'rfdb.log');
  const logFd = openSync(logPath, 'a');

  const serverProcess = _spawn(binaryPath, args, {
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });

  serverProcess.unref();

  // Wire error handler to capture ENOENT and other spawn failures
  serverProcess.on('error', (err: Error) => {
    state.spawnError = err;
  });

  // 4. Write PID file if requested and pid is available, together with the
  //    record of WHICH database this process was handed (REG-1199) — without
  //    it the next run can only ask whether some process is alive.
  if (pidPath && serverProcess.pid) {
    _writeFileSync(pidPath, String(serverProcess.pid));
    const resolvedDbPath = resolve(dbPath);
    const record: RfdbServerRecord = {
      pid: serverProcess.pid,
      dbPath: resolvedDbPath,
      dbDirKey: _pathIdentity(dirname(resolvedDbPath)),
      dbExisted: _existsSync(resolvedDbPath),
      startedAt: new Date().toISOString(),
    };
    _writeFileSync(rfdbServerRecordPath(socketPath), JSON.stringify(record));
  }

  // 5. Poll for socket file
  const maxAttempts = Math.ceil(waitTimeoutMs / 100);
  let attempts = 0;
  while (!_existsSync(socketPath) && attempts < maxAttempts) {
    if (state.spawnError) {
      throw new Error(
        `RFDB server failed to start: ${state.spawnError.message} — check binary: ${binaryPath}`
      );
    }
    await sleep(100);
    attempts++;
  }

  // 6. Final check
  if (!_existsSync(socketPath)) {
    const detail = state.spawnError ? `: ${state.spawnError.message}` : '';
    throw new Error(
      `RFDB server failed to start after ${waitTimeoutMs}ms${detail} — check binary: ${binaryPath}`
    );
  }

  logger?.debug(`rfdb-server started on ${socketPath}`);
  return serverProcess;
}
