/**
 * Shared utility for starting rfdb-server
 *
 * Single authoritative function for spawning rfdb-server. All spawn sites
 * (RFDBServerBackend, CLI server command, ParallelAnalysisRunner) delegate here.
 *
 * If pidPath is provided, checks for an existing server via PID file before
 * spawning. Returns null when an existing server is detected (caller should
 * not kill it).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
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
  /** Socket poll timeout in ms (default: 5000) */
  waitTimeoutMs?: number;
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
  };
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
 * 0. Check PID file for existing server (if pidPath provided)
 * 1. Resolve binary (explicit or via findRfdbBinary)
 * 2. Remove stale socket
 * 3. Spawn detached process
 * 4. Write PID file (if pidPath provided)
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
    waitTimeoutMs = 5000,
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

  // 0. Check for existing server via PID file
  if (pidPath) {
    const status = checkExistingServer(pidPath, socketPath, {
      existsSync: _existsSync,
      readFileSync: _readFileSync,
      killProcess: _killProcess,
    });
    if (status === 'alive') {
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

  const serverProcess = _spawn(binaryPath, [dbPath, '--socket', socketPath, '--data-dir', dataDir], {
    stdio: ['ignore', 'ignore', process.stderr.isTTY ? 'inherit' : 'ignore'],
    detached: true,
  });

  serverProcess.unref();

  // Wire error handler to capture ENOENT and other spawn failures
  serverProcess.on('error', (err: Error) => {
    state.spawnError = err;
  });

  // 4. Write PID file if requested and pid is available
  if (pidPath && serverProcess.pid) {
    _writeFileSync(pidPath, String(serverProcess.pid));
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
