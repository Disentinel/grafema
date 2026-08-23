// binary-freshness.test.ts — the freshness gate must show BOTH outcomes:
// an out-of-date binary is REFUSED, an up-to-date binary starts for real.
// A gate tested only on its happy path proves nothing.
//
// Every case runs against a synthetic cargo layout in /tmp whose source mtimes
// this test owns, so the result never depends on what the checkout's own
// target/ happens to contain at the moment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  startServer,
  checkBinaryFreshness,
  engineCrateRootFor,
  newestEngineSource,
  formatFreshnessRefusal,
  StaleBinaryError,
  ALLOW_STALE_ENV,
  DEFAULT_BINARY,
  DEFAULT_ENGINE_CRATE,
  type FreshnessVerdict,
} from '../src/rfdb-server.ts';

const RELEASE_BINARY = path.join(DEFAULT_ENGINE_CRATE, 'target/release/rfdb-server');

/** A real, runnable rfdb-server to point the synthetic layouts at. */
function realBinary(): string {
  for (const c of [RELEASE_BINARY, DEFAULT_BINARY]) if (fs.existsSync(c)) return c;
  throw new Error(
    `no rfdb-server binary to test against (looked at ${RELEASE_BINARY} and ${DEFAULT_BINARY}) — build one first`,
  );
}

const OLD = new Date('2020-01-01T00:00:00Z');

// This file tests the gate's own semantics, so it must not inherit a decision
// from the shell that launched it: an ambient override would silently turn the
// refusal cases green. Cleared for the file, restored afterwards.
const AMBIENT_OVERRIDE = process.env[ALLOW_STALE_ENV];
before(() => { delete process.env[ALLOW_STALE_ENV]; });
after(() => {
  if (AMBIENT_OVERRIDE === undefined) delete process.env[ALLOW_STALE_ENV];
  else process.env[ALLOW_STALE_ENV] = AMBIENT_OVERRIDE;
});

/**
 * Synthetic `<crate>/target/debug/rfdb-server` next to `<crate>/src/*.rs`, with
 * a sibling package standing in for the conformance harness. The binary is a
 * symlink to a real server, so the "fresh" case can actually boot it.
 */
function makeLayout(sourceMtime: Date): { crate: string; binary: string; harnessFile: string; cleanup: () => void } {
  const root = fs.mkdtempSync('/tmp/rofl-freshness-');
  const crate = path.join(root, 'rfdb-server');
  fs.mkdirSync(path.join(crate, 'src/derive'), { recursive: true });
  fs.mkdirSync(path.join(crate, 'target/debug'), { recursive: true });
  const harnessDir = path.join(root, 'rofl-conformance/src');
  fs.mkdirSync(harnessDir, { recursive: true });

  fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "rfdb"\n');
  fs.writeFileSync(path.join(crate, 'src/lib.rs'), 'pub mod derive;\n');
  fs.writeFileSync(path.join(crate, 'src/derive/exec.rs'), 'pub fn exec() {}\n');
  const harnessFile = path.join(harnessDir, 'report.ts');
  fs.writeFileSync(harnessFile, 'export const x = 1;\n');

  const binary = path.join(crate, 'target/debug/rfdb-server');
  fs.symlinkSync(realBinary(), binary);

  for (const p of ['Cargo.toml', 'src/lib.rs', 'src/derive/exec.rs']) {
    fs.utimesSync(path.join(crate, p), sourceMtime, sourceMtime);
  }
  return { crate, binary, harnessFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// ── outcome 1: OUT OF DATE → REFUSAL ─────────────────────────────────────────

test('OUT OF DATE: a source newer than the binary is a refusal, not a warning', async () => {
  const L = makeLayout(OLD);
  try {
    // an edit that was never committed — no git anywhere in this layout
    const now = new Date();
    fs.writeFileSync(path.join(L.crate, 'src/derive/exec.rs'), 'pub fn exec() { /* edited */ }\n');
    fs.utimesSync(path.join(L.crate, 'src/derive/exec.rs'), now, now);

    const verdict = checkBinaryFreshness(L.binary);
    assert.equal(verdict.reason, 'stale');
    assert.equal(verdict.newestSourcePath, path.join(L.crate, 'src/derive/exec.rs'));
    assert.ok(verdict.newestSourceMs > verdict.binaryBuiltMs);

    // the refusal is what startServer does, not something a caller must opt into
    await assert.rejects(
      () => startServer(L.binary),
      (e: unknown) => {
        assert.ok(e instanceof StaleBinaryError, `expected StaleBinaryError, got ${String(e)}`);
        assert.equal(e.verdict.reason, 'stale');
        return true;
      },
    );

    // and no server process was left behind: the socket dir was never created
    const msg = formatFreshnessRefusal(verdict);
    assert.match(msg, /REFUSING TO RUN/);
    assert.match(msg, /OLDER than the engine sources/);
    assert.ok(msg.includes(L.binary), 'refusal names the stale binary');
    assert.ok(msg.includes('src/derive/exec.rs'), 'refusal names the source that outdates it');
    assert.match(msg, /behind the sources/, 'refusal says by how much');
    assert.match(msg, /cargo build/, 'refusal says how to rebuild');
    assert.ok(msg.includes(ALLOW_STALE_ENV), 'refusal says how to override it deliberately');
  } finally {
    L.cleanup();
  }
});

test('OUT OF DATE: the release profile is told to rebuild with --release', () => {
  const L = makeLayout(OLD);
  try {
    const releaseDir = path.join(L.crate, 'target/release');
    fs.mkdirSync(releaseDir, { recursive: true });
    const releaseBin = path.join(releaseDir, 'rfdb-server');
    fs.symlinkSync(realBinary(), releaseBin);
    const now = new Date();
    fs.utimesSync(path.join(L.crate, 'src/lib.rs'), now, now);

    const msg = formatFreshnessRefusal(checkBinaryFreshness(releaseBin));
    assert.match(msg, /cargo build --release/);
  } finally {
    L.cleanup();
  }
});

// ── outcome 2: UP TO DATE → THE RUN PROCEEDS ─────────────────────────────────

test('UP TO DATE: the gate passes and a real rfdb-server actually starts', async () => {
  const L = makeLayout(OLD); // sources from 2020, binary built today
  try {
    const verdict = checkBinaryFreshness(L.binary);
    assert.equal(verdict.reason, 'fresh');
    assert.ok(verdict.sourcesScanned >= 3, `scanned ${verdict.sourcesScanned} build inputs`);

    const server = await startServer(L.binary);
    try {
      assert.equal(server.binaryPath, L.binary, '--rfdb still selects the binary it was given');
      assert.ok(fs.existsSync(server.socketPath), 'server created its socket — the run proceeds');
      assert.equal(server.proc.exitCode, null, 'server is alive');
    } finally {
      server.stop();
    }
  } finally {
    L.cleanup();
  }
});

// ── scoping: the harness must not declare the engine stale ────────────────────

test('a change in the conformance harness does NOT make the engine binary stale', () => {
  const L = makeLayout(OLD);
  try {
    const now = new Date();
    fs.writeFileSync(L.harnessFile, 'export const x = 2;\n');
    fs.utimesSync(L.harnessFile, now, now);
    assert.equal(checkBinaryFreshness(L.binary).reason, 'fresh');
  } finally {
    L.cleanup();
  }
});

test('only engine build inputs are scanned: .rs under src/, plus Cargo.toml and build.rs', () => {
  const L = makeLayout(OLD);
  try {
    const now = new Date();
    // a non-source file inside the crate is not a build input
    const readme = path.join(L.crate, 'src/NOTES.md');
    fs.writeFileSync(readme, 'notes\n');
    fs.utimesSync(readme, now, now);
    assert.equal(checkBinaryFreshness(L.binary).reason, 'fresh');

    // Cargo.toml is
    fs.utimesSync(path.join(L.crate, 'Cargo.toml'), now, now);
    assert.equal(checkBinaryFreshness(L.binary).reason, 'stale');

    // and so is build.rs
    const fresh = makeLayout(OLD);
    try {
      const buildRs = path.join(fresh.crate, 'build.rs');
      fs.writeFileSync(buildRs, 'fn main() {}\n');
      fs.utimesSync(buildRs, now, now);
      const v = checkBinaryFreshness(fresh.binary);
      assert.equal(v.reason, 'stale');
      assert.equal(v.newestSourcePath, buildRs);
    } finally {
      fresh.cleanup();
    }
  } finally {
    L.cleanup();
  }
});

// ── the deliberate escape hatch ───────────────────────────────────────────────

test('the override is explicit and works both as an option and as an env var', async () => {
  const L = makeLayout(new Date()); // sources newer than the binary
  try {
    assert.equal(checkBinaryFreshness(L.binary).reason, 'stale');

    const viaOption = await startServer(L.binary, { allowStale: true });
    try {
      assert.ok(fs.existsSync(viaOption.socketPath));
    } finally {
      viaOption.stop();
    }

    const previous = process.env[ALLOW_STALE_ENV];
    process.env[ALLOW_STALE_ENV] = '1';
    try {
      const viaEnv = await startServer(L.binary);
      try {
        assert.ok(fs.existsSync(viaEnv.socketPath));
      } finally {
        viaEnv.stop();
      }
    } finally {
      if (previous === undefined) delete process.env[ALLOW_STALE_ENV];
      else process.env[ALLOW_STALE_ENV] = previous;
    }

    // anything other than an explicit "1" is not consent
    process.env[ALLOW_STALE_ENV] = 'true';
    try {
      await assert.rejects(() => startServer(L.binary), StaleBinaryError);
    } finally {
      delete process.env[ALLOW_STALE_ENV];
    }
  } finally {
    L.cleanup();
  }
});

// ── the default path is gated too ────────────────────────────────────────────

test('the default binary is compared against this checkout own engine crate', () => {
  assert.equal(engineCrateRootFor(DEFAULT_BINARY), DEFAULT_ENGINE_CRATE);
  const newest = newestEngineSource(DEFAULT_ENGINE_CRATE);
  assert.ok(newest.scanned > 50, `expected the real engine crate to have many build inputs, got ${newest.scanned}`);
  assert.ok(newest.path !== null && newest.path.startsWith(DEFAULT_ENGINE_CRATE));
});

test('a binary whose sources cannot be located is refused, not assumed fresh', () => {
  const verdict: FreshnessVerdict = {
    reason: 'sources-not-found',
    binaryPath: '/opt/somewhere/rfdb-server',
    binaryBuiltMs: Date.parse('2026-08-23T13:47:30.792Z'),
    crateRoot: null,
    newestSourcePath: null,
    newestSourceMs: 0,
    sourcesScanned: 0,
  };
  const msg = formatFreshnessRefusal(verdict);
  assert.match(msg, /REFUSING TO RUN/);
  assert.match(msg, /cannot verify/);
  assert.ok(msg.includes(ALLOW_STALE_ENV));
});
