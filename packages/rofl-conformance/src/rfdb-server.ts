// rfdb-server.ts — spawn/teardown of one rfdb-server per harness run.
// One long-lived server on one empty tmp DB serves the whole run: executeDatalog
// with ground facts in the program text is a stateless read (REG-1196 FactStats),
// so no per-seed database dance is needed (live-proven, no createDatabase either).
//
// FRESHNESS GATE: a conformance number is only ever about the engine that
// produced it. A binary older than the engine sources yields plausible,
// quotable, WRONG numbers — the most expensive failure mode this harness has.
// So a stale binary is a hard refusal, never a warning in the log: a warning
// gets read every other time, a refusal gets read every time.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ServerHandle {
  socketPath: string;
  binaryPath: string;
  proc: ChildProcess;
  stop: () => void;
}

export interface StartServerOptions {
  /** Deliberately measure an older build (e.g. an old-vs-new comparison run). */
  allowStale?: boolean;
}

/** Explicit "I know, run it as is" escape hatch, for old-vs-new comparison runs. */
export const ALLOW_STALE_ENV = 'ROFL_CONFORMANCE_ALLOW_STALE_BINARY';

export const DEFAULT_BINARY = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../rfdb-server/target/debug/rfdb-server',
);

/** Engine crate of this checkout — the fallback reference for the freshness gate. */
export const DEFAULT_ENGINE_CRATE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../rfdb-server',
);

export type FreshnessReason = 'fresh' | 'stale' | 'sources-not-found';

export interface FreshnessVerdict {
  reason: FreshnessReason;
  binaryPath: string;
  /** Binary mtime = link time of the build, ms since epoch. */
  binaryBuiltMs: number;
  /** Crate root the binary was compared against; null when it could not be located. */
  crateRoot: string | null;
  newestSourcePath: string | null;
  newestSourceMs: number;
  sourcesScanned: number;
}

export class StaleBinaryError extends Error {
  readonly verdict: FreshnessVerdict;
  constructor(message: string, verdict: FreshnessVerdict) {
    super(message);
    this.name = 'StaleBinaryError';
    this.verdict = verdict;
  }
}

/**
 * Locate the engine crate a binary was built from, by walking up the cargo
 * layout: `<crate>/target/<profile>/<bin>` and `<crate>/target/<triple>/<profile>/<bin>`.
 * Falls back to this checkout's engine crate — the harness reports on THIS
 * checkout's engine, so that is the honest reference when the layout is unusual.
 * Returns null only when no candidate is a cargo crate with sources.
 */
export function engineCrateRootFor(binaryPath: string): string | null {
  const abs = path.resolve(binaryPath);
  const candidates = [
    path.resolve(abs, '../../..'), // <crate>/target/<profile>/<bin>
    path.resolve(abs, '../../../..'), // <crate>/target/<triple>/<profile>/<bin>
    DEFAULT_ENGINE_CRATE,
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'Cargo.toml')) && fs.existsSync(path.join(c, 'src'))) return c;
  }
  return null;
}

/**
 * Newest change among the engine's own build inputs: every `.rs` file under
 * `src/`, plus the crate manifest and build script. Deliberately scoped to the
 * engine crate — a commit in the conformance harness must never declare the
 * engine stale.
 *
 * Measured by filesystem mtime, not by git. Rationale: an uncommitted edit to
 * an engine source invalidates a build exactly as much as a committed one, and
 * git cannot see it; mtime sees both (a checkout rewrites mtimes too). Its one
 * failure mode — an mtime bumped without a content change — errs toward
 * refusing to run, which is the safe direction, and the explicit override
 * exists for precisely that case.
 */
export function newestEngineSource(crateRoot: string): {
  path: string | null;
  mtimeMs: number;
  scanned: number;
} {
  let newestPath: string | null = null;
  let newestMs = 0;
  let scanned = 0;

  const consider = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return; // vanished mid-scan (a concurrent build) — not evidence of anything
    }
    scanned++;
    if (st.mtimeMs > newestMs) {
      newestMs = st.mtimeMs;
      newestPath = p;
    }
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith('.rs')) consider(p);
    }
  };

  walk(path.join(crateRoot, 'src'));
  for (const manifest of ['Cargo.toml', 'build.rs']) {
    const p = path.join(crateRoot, manifest);
    if (fs.existsSync(p)) consider(p);
  }
  return { path: newestPath, mtimeMs: newestMs, scanned };
}

/** Compare a binary's build time against the newest engine source change. */
export function checkBinaryFreshness(binaryPath: string): FreshnessVerdict {
  const abs = path.resolve(binaryPath);
  const binaryBuiltMs = fs.statSync(abs).mtimeMs;
  const crateRoot = engineCrateRootFor(abs);
  if (crateRoot === null) {
    return {
      reason: 'sources-not-found',
      binaryPath: abs,
      binaryBuiltMs,
      crateRoot: null,
      newestSourcePath: null,
      newestSourceMs: 0,
      sourcesScanned: 0,
    };
  }
  const newest = newestEngineSource(crateRoot);
  if (newest.path === null) {
    return {
      reason: 'sources-not-found',
      binaryPath: abs,
      binaryBuiltMs,
      crateRoot,
      newestSourcePath: null,
      newestSourceMs: 0,
      sourcesScanned: newest.scanned,
    };
  }
  return {
    reason: newest.mtimeMs > binaryBuiltMs ? 'stale' : 'fresh',
    binaryPath: abs,
    binaryBuiltMs,
    crateRoot,
    newestSourcePath: newest.path,
    newestSourceMs: newest.mtimeMs,
    sourcesScanned: newest.scanned,
  };
}

function humanizeGap(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** `cargo build` / `cargo build --release`, matching the profile the binary sits in. */
function rebuildCommand(binaryPath: string, crateRoot: string | null): string {
  const profile = path.basename(path.dirname(binaryPath));
  const where = crateRoot ?? 'packages/rfdb-server';
  const flag = profile === 'release' ? ' --release' : '';
  return `cd ${where} && cargo build${flag}`;
}

/** Best-effort, refusal-path only: which engine commits landed after the build. */
function commitsSince(crateRoot: string, sinceMs: number): string[] {
  try {
    const out = execFileSync(
      'git',
      ['log', '--oneline', `--since=${new Date(sinceMs).toISOString()}`, '--', path.join(crateRoot, 'src')],
      { cwd: crateRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\n').filter((l) => l.trim() !== '');
  } catch {
    return []; // not a git checkout, or git unavailable — the mtime evidence stands alone
  }
}

export function formatFreshnessRefusal(v: FreshnessVerdict): string {
  const lines: string[] = [];
  if (v.reason === 'sources-not-found') {
    lines.push('REFUSING TO RUN: cannot verify the rfdb-server binary against engine sources.');
    lines.push('');
    lines.push(`  binary        : ${v.binaryPath}`);
    lines.push(`  built         : ${new Date(v.binaryBuiltMs).toISOString()}`);
    lines.push(`  engine crate  : ${v.crateRoot ?? '<not found>'}`);
    lines.push('');
    lines.push('  An unverified binary is not a fresh binary: its numbers would look like');
    lines.push('  a measurement of the current engine without being one.');
  } else {
    lines.push('REFUSING TO RUN: the rfdb-server binary is OLDER than the engine sources.');
    lines.push('  Its numbers would describe an engine that no longer exists.');
    lines.push('');
    lines.push(`  binary        : ${v.binaryPath}`);
    lines.push(`  built         : ${new Date(v.binaryBuiltMs).toISOString()}`);
    lines.push(`  newest source : ${v.newestSourcePath}`);
    lines.push(`  changed       : ${new Date(v.newestSourceMs).toISOString()}`);
    lines.push(
      `  the binary is ${humanizeGap(v.newestSourceMs - v.binaryBuiltMs)} behind the sources ` +
        `(${v.sourcesScanned} engine build inputs scanned)`,
    );
    const commits = commitsSince(v.crateRoot!, v.binaryBuiltMs);
    if (commits.length > 0) {
      lines.push('');
      lines.push(`  ${commits.length} commit(s) touched the engine sources after that build:`);
      for (const c of commits.slice(0, 10)) lines.push(`    ${c}`);
      if (commits.length > 10) lines.push(`    ... and ${commits.length - 10} more`);
    }
  }
  lines.push('');
  lines.push(`  rebuild with: ${rebuildCommand(v.binaryPath, v.crateRoot)}`);
  lines.push('  or point the harness at another build:  --rfdb <path/to/rfdb-server>');
  lines.push('');
  lines.push('  If you deliberately want to measure THIS build (an old-vs-new comparison),');
  lines.push(`  say so explicitly: ${ALLOW_STALE_ENV}=1 <your command>`);
  return lines.join('\n');
}

/** Hard gate: throws StaleBinaryError unless the binary is provably not older than the sources. */
export function assertBinaryFresh(binaryPath: string, allowStale: boolean): FreshnessVerdict {
  const verdict = checkBinaryFreshness(binaryPath);
  if (verdict.reason === 'fresh' || allowStale) return verdict;
  throw new StaleBinaryError(formatFreshnessRefusal(verdict), verdict);
}

export async function startServer(
  binaryPath: string = DEFAULT_BINARY,
  options: StartServerOptions = {},
): Promise<ServerHandle> {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`rfdb-server binary not found: ${binaryPath} (build: cd packages/rfdb-server && cargo build)`);
  }
  const allowStale = options.allowStale ?? process.env[ALLOW_STALE_ENV] === '1';
  assertBinaryFresh(binaryPath, allowStale);
  const dir = fs.mkdtempSync(`/tmp/rofl-conf-${process.pid}-`);
  const dbPath = path.join(dir, 'db');
  const socketPath = path.join(dir, 'rfdb.sock');
  fs.mkdirSync(dbPath, { recursive: true });
  // stdio all 'ignore': keeps the event loop clean (project test-infra precedent).
  const proc = spawn(binaryPath, [dbPath, '--socket', socketPath], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(socketPath)) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`rfdb-server did not create ${socketPath} within 15s`);
    }
    if (proc.exitCode !== null) {
      throw new Error(`rfdb-server exited early with code ${proc.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const stop = (): void => {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort tmp cleanup */ }
  };
  return { socketPath, binaryPath, proc, stop };
}
