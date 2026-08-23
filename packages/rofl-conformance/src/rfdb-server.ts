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
//
// The gate holds the binary against THIS checkout's engine crate, and against
// all of its build inputs — including the 42 `.dl` rule packs that reach the
// binary through `include_str!`, which are exactly what a derive-engine number
// is a measurement of. What it cannot see, it refuses over rather than
// assumes: an include it cannot resolve, or a crate root that is not a crate.

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
  /**
   * Engine sources to compare the binary against. Defaults to THIS checkout's engine
   * crate — see {@link FreshnessOptions}.
   */
  engineCrate?: string;
}

export interface FreshnessOptions {
  /**
   * The sources the binary is held against. Defaults to this checkout's engine crate,
   * and production callers never pass anything else: the harness publishes numbers about
   * THIS checkout's engine, so these are the only sources a verdict about it can mean.
   *
   * It used to be inferred from the binary's own cargo layout, which was a hole rather
   * than a convenience — a binary from a foreign checkout was compared against ITS OWN
   * sources and came back `fresh` however ancient it was (measured: a 2020 binary in a
   * foreign layout, verdict `fresh`). Parameterised only so the gate's own tests can own
   * the sources they measure against.
   */
  engineCrate?: string;
}

/** Explicit "I know, run it as is" escape hatch, for old-vs-new comparison runs. */
export const ALLOW_STALE_ENV = 'ROFL_CONFORMANCE_ALLOW_STALE_BINARY';

export const DEFAULT_BINARY = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../rfdb-server/target/debug/rfdb-server',
);

/** Engine crate of this checkout — THE reference for the freshness gate. */
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
  /** Crate root the binary was compared against; null when it is not a cargo crate. */
  crateRoot: string | null;
  newestSourcePath: string | null;
  newestSourceMs: number;
  sourcesScanned: number;
  /** A build input the scan could not resolve — the reason a verdict is unverifiable. */
  unresolvedInput: string | null;
}

export class StaleBinaryError extends Error {
  readonly verdict: FreshnessVerdict;
  constructor(message: string, verdict: FreshnessVerdict) {
    super(message);
    this.name = 'StaleBinaryError';
    this.verdict = verdict;
  }
}

/** Every `include_str!` / `include_bytes!` whose argument is one plain string literal. */
const INCLUDE_MACRO = /\binclude_(?:str|bytes)!\s*\(([^)]*)\)/g;

/**
 * Newest change among the engine's own build inputs — and ALL of them:
 * - every `.rs` file under `src/`, plus the crate manifest and build script;
 * - every file those `.rs` files pull in with `include_str!` / `include_bytes!`.
 *
 * The include sweep is not a nicety. 42 of this engine's Datalog rule packs
 * (`src/derive/stdlib/*.dl`) reach the binary that way, and they are precisely what this
 * harness measures: editing `depends.dl` changes the derived edges and changes nothing
 * about any `.rs` file, so an extension filter of `.rs` declared the binary `fresh` after
 * the very edit whose effect was about to be reported (measured). Resolved from the
 * source text rather than from an extension list, so an input added tomorrow in a new
 * format is covered without touching this file.
 *
 * An include whose argument is not a plain string literal, or which names a file that is
 * not there, is reported as `unresolved` and makes the whole verdict `sources-not-found`:
 * the gate cannot see that input, and an unverifiable binary is not a fresh binary.
 *
 * Deliberately scoped to the engine crate — a commit in the conformance harness must
 * never declare the engine stale.
 *
 * Measured by filesystem mtime, not by git. Rationale: an uncommitted edit to an engine
 * source invalidates a build exactly as much as a committed one, and git cannot see it;
 * mtime sees both (a checkout rewrites mtimes too). Its one failure mode — an mtime
 * bumped without a content change — errs toward refusing to run, which is the safe
 * direction, and the explicit override exists for precisely that case.
 */
export function newestEngineSource(crateRoot: string): {
  path: string | null;
  mtimeMs: number;
  scanned: number;
  unresolved: string | null;
} {
  let newestPath: string | null = null;
  let newestMs = 0;
  let scanned = 0;
  let unresolved: string | null = null;

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

  /** The compile-time inputs one `.rs` file names, resolved relative to that file. */
  const considerIncludes = (rsFile: string): void => {
    let text: string;
    try {
      text = fs.readFileSync(rsFile, 'utf8');
    } catch {
      return;
    }
    for (const m of text.matchAll(INCLUDE_MACRO)) {
      const arg = m[1].trim();
      const literal = /^"([^"]*)"$/.exec(arg);
      if (literal === null) {
        // concat!/env!/a macro variable: a build input this scan cannot name.
        unresolved ??= `${rsFile}: include argument is not a string literal (${arg})`;
        continue;
      }
      const included = path.resolve(path.dirname(rsFile), literal[1]);
      if (!fs.existsSync(included)) {
        unresolved ??= `${rsFile}: include target does not exist (${included})`;
        continue;
      }
      consider(included);
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
      else if (e.isFile() && p.endsWith('.rs')) {
        consider(p);
        considerIncludes(p);
      }
    }
  };

  walk(path.join(crateRoot, 'src'));
  for (const manifest of ['Cargo.toml', 'build.rs']) {
    const p = path.join(crateRoot, manifest);
    if (fs.existsSync(p)) {
      consider(p);
      if (manifest === 'build.rs') considerIncludes(p);
    }
  }
  return { path: newestPath, mtimeMs: newestMs, scanned, unresolved };
}

/**
 * Compare a binary's build time against the newest engine source change.
 *
 * The reference is ALWAYS this checkout's engine crate (override: {@link FreshnessOptions}).
 * A binary from somewhere else is held against THESE sources, because a number this
 * harness publishes is a claim about THIS engine. That also closes the hole that inferring
 * the crate from the binary's own layout left open, where a foreign build was compared
 * against its own sources and passed however old it was.
 *
 * Residual, stated rather than hidden: mtime cannot tell a foreign binary that happens to
 * be NEWER than these sources from a build of these sources. The verdict says which binary
 * it measured, and `--rfdb <path>` is an explicit act.
 */
export function checkBinaryFreshness(
  binaryPath: string,
  options: FreshnessOptions = {},
): FreshnessVerdict {
  const abs = path.resolve(binaryPath);
  const binaryBuiltMs = fs.statSync(abs).mtimeMs;
  const crateRoot = options.engineCrate ?? DEFAULT_ENGINE_CRATE;
  const isCrate =
    fs.existsSync(path.join(crateRoot, 'Cargo.toml')) && fs.existsSync(path.join(crateRoot, 'src'));
  if (!isCrate) {
    return {
      reason: 'sources-not-found',
      binaryPath: abs,
      binaryBuiltMs,
      crateRoot: null,
      newestSourcePath: null,
      newestSourceMs: 0,
      sourcesScanned: 0,
      unresolvedInput: `${crateRoot} is not a cargo crate with sources`,
    };
  }
  const newest = newestEngineSource(crateRoot);
  if (newest.path === null || newest.unresolved !== null) {
    return {
      reason: 'sources-not-found',
      binaryPath: abs,
      binaryBuiltMs,
      crateRoot,
      newestSourcePath: newest.path,
      newestSourceMs: newest.mtimeMs,
      sourcesScanned: newest.scanned,
      unresolvedInput: newest.unresolved ?? `no build inputs found under ${crateRoot}/src`,
    };
  }
  return {
    // `>=`, not `>`: a source whose mtime lands in the same millisecond as the link is a
    // source that may have been written after it. Ties go to the refusal.
    reason: newest.mtimeMs >= binaryBuiltMs ? 'stale' : 'fresh',
    binaryPath: abs,
    binaryBuiltMs,
    crateRoot,
    newestSourcePath: newest.path,
    newestSourceMs: newest.mtimeMs,
    sourcesScanned: newest.scanned,
    unresolvedInput: null,
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

/**
 * The command that rebuilds THE BINARY UNDER TEST — profile and target directory both
 * taken from where that binary actually sits.
 *
 * The target directory matters: with `--rfdb /tmp/somewhere/debug/rfdb-server` a plain
 * `cargo build` in the crate rebuilds `packages/rfdb-server/target/...` and leaves the
 * binary the harness was told to use exactly as stale as it was — the reader follows the
 * instruction, sees the same refusal, and concludes the gate is broken.
 */
function rebuildCommand(binaryPath: string, crateRoot: string | null): string {
  const profileDir = path.dirname(binaryPath);
  const profile = path.basename(profileDir);
  const where = crateRoot ?? DEFAULT_ENGINE_CRATE;
  const flag = profile === 'release' ? ' --release' : '';
  const targetDir = path.resolve(path.dirname(profileDir));
  const ownTarget = path.resolve(where, 'target');
  const insideOwnTarget = targetDir === ownTarget || targetDir.startsWith(ownTarget + path.sep);
  const env = insideOwnTarget ? '' : `CARGO_TARGET_DIR=${targetDir} `;
  return `cd ${where} && ${env}cargo build${flag}`;
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
    if (v.unresolvedInput !== null) lines.push(`  cannot see    : ${v.unresolvedInput}`);
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
export function assertBinaryFresh(
  binaryPath: string,
  allowStale: boolean,
  options: FreshnessOptions = {},
): FreshnessVerdict {
  const verdict = checkBinaryFreshness(binaryPath, options);
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
  assertBinaryFresh(binaryPath, allowStale, { engineCrate: options.engineCrate });
  const dir = fs.mkdtempSync(`/tmp/rofl-conf-${process.pid}-`);
  const dbPath = path.join(dir, 'db');
  const socketPath = path.join(dir, 'rfdb.sock');
  fs.mkdirSync(dbPath, { recursive: true });
  // stdio all 'ignore': keeps the event loop clean (project test-infra precedent).
  const proc = spawn(binaryPath, [dbPath, '--socket', socketPath], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  // A file that exists but cannot be executed — not an ELF, no exec bit, a zero-byte
  // leftover of an interrupted build — fails as an 'error' EVENT, not a nonzero exit.
  // Unhandled, node re-throws it as an uncaught exception and the run dies mid-spawn on a
  // stack trace about EACCES. Captured here so the caller gets one sentence naming the file
  // (measured: a zero-byte binary passes the freshness gate on mtime alone, so this is the
  // path that has to be the loud one).
  let spawnError: Error | null = null;
  proc.on('error', (e: Error) => { spawnError = e; });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(socketPath)) {
    if (spawnError !== null) {
      throw new Error(`rfdb-server could not be executed: ${binaryPath} — ${(spawnError as Error).message}`);
    }
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
