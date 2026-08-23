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
  assertBinaryFresh,
  newestEngineSource,
  formatFreshnessRefusal,
  StaleBinaryError,
  ALLOW_STALE_ENV,
  DEFAULT_BINARY,
  DEFAULT_ENGINE_CRATE,
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
function makeLayout(sourceMtime: Date): {
  crate: string;
  binary: string;
  harnessFile: string;
  rulePack: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync('/tmp/rofl-freshness-');
  const crate = path.join(root, 'rfdb-server');
  fs.mkdirSync(path.join(crate, 'src/derive/stdlib'), { recursive: true });
  fs.mkdirSync(path.join(crate, 'target/debug'), { recursive: true });
  const harnessDir = path.join(root, 'rofl-conformance/src');
  fs.mkdirSync(harnessDir, { recursive: true });

  fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "rfdb"\n');
  fs.writeFileSync(path.join(crate, 'src/lib.rs'), 'pub mod derive;\n');
  // The engine reaches its rule packs through include_str!, exactly as the real
  // crate does — so the layout can exercise that input, not just `.rs` files.
  fs.writeFileSync(
    path.join(crate, 'src/derive/exec.rs'),
    'pub const PACK: &str = include_str!("stdlib/depends.dl");\n',
  );
  const rulePack = path.join(crate, 'src/derive/stdlib/depends.dl');
  fs.writeFileSync(rulePack, 'depends(A, B) :- imports(A, B).\n');
  const harnessFile = path.join(harnessDir, 'report.ts');
  fs.writeFileSync(harnessFile, 'export const x = 1;\n');

  const binary = path.join(crate, 'target/debug/rfdb-server');
  fs.symlinkSync(realBinary(), binary);

  for (const p of ['Cargo.toml', 'src/lib.rs', 'src/derive/exec.rs', 'src/derive/stdlib/depends.dl']) {
    fs.utimesSync(path.join(crate, p), sourceMtime, sourceMtime);
  }
  return { crate, binary, harnessFile, rulePack, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Give the layout a binary that is only ever stat'ed, with an mtime this test owns.
 *
 * makeLayout hands out a SYMLINK to a real rfdb-server so the "fresh" case can boot
 * it — but `fs.utimes` follows symlinks, so back-dating that path back-dates the real
 * binary in the checkout (measured: it set the checkout's release binary to 2020).
 * Cases that never spawn the server get a plain file instead.
 */
function detachBinary(L: { binary: string }, mtime: Date): void {
  fs.rmSync(L.binary);
  fs.writeFileSync(L.binary, 'not an ELF, and never executed\n');
  fs.utimesSync(L.binary, mtime, mtime);
}

// ── outcome 1: OUT OF DATE → REFUSAL ─────────────────────────────────────────

test('OUT OF DATE: a source newer than the binary is a refusal, not a warning', async () => {
  const L = makeLayout(OLD);
  try {
    // an edit that was never committed — no git anywhere in this layout
    const now = new Date();
    fs.writeFileSync(path.join(L.crate, 'src/derive/exec.rs'), 'pub fn exec() { /* edited */ }\n');
    fs.utimesSync(path.join(L.crate, 'src/derive/exec.rs'), now, now);

    const verdict = checkBinaryFreshness(L.binary, { engineCrate: L.crate });
    assert.equal(verdict.reason, 'stale');
    assert.equal(verdict.newestSourcePath, path.join(L.crate, 'src/derive/exec.rs'));
    assert.ok(verdict.newestSourceMs > verdict.binaryBuiltMs);

    // the refusal is what startServer does, not something a caller must opt into
    await assert.rejects(
      () => startServer(L.binary, { engineCrate: L.crate }),
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

    const msg = formatFreshnessRefusal(checkBinaryFreshness(releaseBin, { engineCrate: L.crate }));
    assert.match(msg, /cargo build --release/);
  } finally {
    L.cleanup();
  }
});

test('OUT OF DATE: a binary outside the crate own target is told which target dir to rebuild', () => {
  const L = makeLayout(OLD);
  const elsewhere = fs.mkdtempSync('/tmp/rofl-alt-target-');
  try {
    const altProfileDir = path.join(elsewhere, 'debug');
    fs.mkdirSync(altProfileDir, { recursive: true });
    const altBin = path.join(altProfileDir, 'rfdb-server');
    fs.symlinkSync(realBinary(), altBin);
    const now = new Date();
    fs.utimesSync(path.join(L.crate, 'src/lib.rs'), now, now);

    const msg = formatFreshnessRefusal(checkBinaryFreshness(altBin, { engineCrate: L.crate }));
    // a plain `cargo build` would rebuild the crate's own target/ and leave THIS
    // binary exactly as stale as it was
    assert.ok(
      msg.includes(`CARGO_TARGET_DIR=${elsewhere} cargo build`),
      `refusal must name the target dir of the binary under test:\n${msg}`,
    );

    // and the crate's own target/ is not decorated with a redundant env var
    const own = formatFreshnessRefusal(checkBinaryFreshness(L.binary, { engineCrate: L.crate }));
    assert.ok(!own.includes('CARGO_TARGET_DIR'), own);
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
    L.cleanup();
  }
});

// ── outcome 2: UP TO DATE → THE RUN PROCEEDS ─────────────────────────────────

test('UP TO DATE: the gate passes and a real rfdb-server actually starts', async () => {
  const L = makeLayout(OLD); // sources from 2020, binary built today
  try {
    const verdict = checkBinaryFreshness(L.binary, { engineCrate: L.crate });
    assert.equal(verdict.reason, 'fresh');
    assert.ok(verdict.sourcesScanned >= 3, `scanned ${verdict.sourcesScanned} build inputs`);

    const server = await startServer(L.binary, { engineCrate: L.crate });
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
    assert.equal(checkBinaryFreshness(L.binary, { engineCrate: L.crate }).reason, 'fresh');
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
    assert.equal(checkBinaryFreshness(L.binary, { engineCrate: L.crate }).reason, 'fresh');

    // Cargo.toml is
    fs.utimesSync(path.join(L.crate, 'Cargo.toml'), now, now);
    assert.equal(checkBinaryFreshness(L.binary, { engineCrate: L.crate }).reason, 'stale');

    // and so is build.rs
    const fresh = makeLayout(OLD);
    try {
      const buildRs = path.join(fresh.crate, 'build.rs');
      fs.writeFileSync(buildRs, 'fn main() {}\n');
      fs.utimesSync(buildRs, now, now);
      const v = checkBinaryFreshness(fresh.binary, { engineCrate: fresh.crate });
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
    assert.equal(checkBinaryFreshness(L.binary, { engineCrate: L.crate }).reason, 'stale');

    const viaOption = await startServer(L.binary, { allowStale: true, engineCrate: L.crate });
    try {
      assert.ok(fs.existsSync(viaOption.socketPath));
    } finally {
      viaOption.stop();
    }

    const previous = process.env[ALLOW_STALE_ENV];
    process.env[ALLOW_STALE_ENV] = '1';
    try {
      const viaEnv = await startServer(L.binary, { engineCrate: L.crate });
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
      await assert.rejects(() => startServer(L.binary, { engineCrate: L.crate }), StaleBinaryError);
    } finally {
      delete process.env[ALLOW_STALE_ENV];
    }
  } finally {
    L.cleanup();
  }
});

// ── inputs that are not .rs files ─────────────────────────────────────────────

test('OUT OF DATE: editing a .dl rule pack reached by include_str! makes the binary stale', () => {
  const L = makeLayout(OLD);
  try {
    assert.equal(checkBinaryFreshness(L.binary, { engineCrate: L.crate }).reason, 'fresh');

    // the only edit: a rule pack. No .rs file is touched.
    const now = new Date();
    fs.writeFileSync(L.rulePack, 'depends(A, B) :- imports(A, B), reachable(B).\n');
    fs.utimesSync(L.rulePack, now, now);

    const verdict = checkBinaryFreshness(L.binary, { engineCrate: L.crate });
    assert.equal(verdict.reason, 'stale', 'a rule-pack edit is an engine change');
    assert.equal(verdict.newestSourcePath, L.rulePack);
    assert.ok(formatFreshnessRefusal(verdict).includes('depends.dl'));
  } finally {
    L.cleanup();
  }
});

// ── the binary is held against THIS checkout, not against its own neighbours ──

test('OUT OF DATE: a binary in a foreign cargo layout is judged by these sources', () => {
  // The foreign checkout is entirely from 2020 — binary and sources alike, so
  // held against ITSELF it would pass. The reference crate is edited now.
  const foreign = makeLayout(OLD);
  const reference = makeLayout(OLD);
  try {
    detachBinary(foreign, new Date('2020-02-01T00:00:00Z')); // linked AFTER its own 2020 sources
    assert.equal(
      checkBinaryFreshness(foreign.binary, { engineCrate: foreign.crate }).reason,
      'fresh',
      'positive control: against its own 2020 sources the ancient binary looks fine',
    );

    const now = new Date();
    fs.utimesSync(path.join(reference.crate, 'src/lib.rs'), now, now);

    const verdict = checkBinaryFreshness(foreign.binary, { engineCrate: reference.crate });
    assert.equal(verdict.reason, 'stale');
    assert.equal(verdict.crateRoot, reference.crate, 'compared against the reference crate');
    assert.equal(verdict.newestSourcePath, path.join(reference.crate, 'src/lib.rs'));
  } finally {
    foreign.cleanup();
    reference.cleanup();
  }
});

test('the default binary is compared against this checkout own engine crate', () => {
  const someBinary = realBinary();
  assert.equal(checkBinaryFreshness(someBinary).crateRoot, DEFAULT_ENGINE_CRATE);
  const newest = newestEngineSource(DEFAULT_ENGINE_CRATE);
  assert.ok(newest.scanned > 50, `expected the real engine crate to have many build inputs, got ${newest.scanned}`);
  assert.ok(newest.path !== null && newest.path.startsWith(DEFAULT_ENGINE_CRATE));
  // positive control for the include sweep on the REAL crate: every include_str!
  // target resolves, and rule packs are among the inputs it scanned.
  assert.equal(newest.unresolved, null, `real crate has an unresolvable build input: ${newest.unresolved}`);
  const packs = fs.readdirSync(path.join(DEFAULT_ENGINE_CRATE, 'src/derive/stdlib')).filter((f) => f.endsWith('.dl'));
  assert.ok(packs.length > 10, `expected many .dl rule packs, found ${packs.length}`);
  assert.ok(
    newest.scanned > packs.length,
    `scanned ${newest.scanned} inputs, which must exceed the ${packs.length} rule packs alone`,
  );
});

// ── a boundary and an unverifiable input ─────────────────────────────────────

test('a source that lands in the same millisecond as the link counts as newer', () => {
  const L = makeLayout(OLD);
  try {
    const linked = new Date('2026-08-23T13:47:30.792Z');
    detachBinary(L, linked);
    fs.utimesSync(path.join(L.crate, 'src/lib.rs'), linked, linked);
    const verdict = checkBinaryFreshness(L.binary, { engineCrate: L.crate });
    assert.equal(verdict.newestSourceMs, verdict.binaryBuiltMs, 'the tie is exact');
    assert.equal(verdict.reason, 'stale', 'a tie goes to the refusal, not to the run');
  } finally {
    L.cleanup();
  }
});

test('a build input the scan cannot resolve is refused, not assumed fresh', async () => {
  const L = makeLayout(OLD);
  try {
    // A real pattern: the path is computed, so the scan cannot name the file.
    fs.writeFileSync(
      path.join(L.crate, 'src/derive/exec.rs'),
      'pub const PACK: &str = include_str!(concat!(env!("OUT_DIR"), "/generated.dl"));\n',
    );
    fs.utimesSync(path.join(L.crate, 'src/derive/exec.rs'), OLD, OLD);

    const verdict = checkBinaryFreshness(L.binary, { engineCrate: L.crate });
    assert.equal(verdict.reason, 'sources-not-found', 'an input it cannot see is not a fresh verdict');
    assert.ok(verdict.unresolvedInput !== null && verdict.unresolvedInput.includes('exec.rs'));

    const msg = formatFreshnessRefusal(verdict);
    assert.match(msg, /REFUSING TO RUN/);
    assert.match(msg, /cannot verify/);
    assert.ok(msg.includes('cannot see'), 'the refusal names what it could not resolve');
    assert.ok(msg.includes(ALLOW_STALE_ENV));

    // and it is a refusal in the running system, not only in the formatter
    await assert.rejects(() => startServer(L.binary, { engineCrate: L.crate }), StaleBinaryError);
  } finally {
    L.cleanup();
  }
});

test('an include that names a file which is not there is refused too', () => {
  const L = makeLayout(OLD);
  try {
    fs.rmSync(L.rulePack);
    const verdict = checkBinaryFreshness(L.binary, { engineCrate: L.crate });
    assert.equal(verdict.reason, 'sources-not-found');
    assert.ok(verdict.unresolvedInput !== null && verdict.unresolvedInput.includes('depends.dl'));
  } finally {
    L.cleanup();
  }
});

test('a file the gate passes but the OS cannot execute fails with one sentence', async () => {
  const L = makeLayout(OLD);
  try {
    // The zero-byte leftover of an interrupted build, stamped with a fresh mtime. The
    // gate has only mtime to go on, so it passes — which is exactly why the spawn has to
    // be the loud one. Unhandled, this arrives as an 'error' EVENT and node re-throws it
    // as an uncaught EACCES stack trace mid-run.
    detachBinary(L, new Date());
    assert.equal(checkBinaryFreshness(L.binary, { engineCrate: L.crate }).reason, 'fresh');

    await assert.rejects(
      () => startServer(L.binary, { engineCrate: L.crate }),
      (e: unknown) => {
        assert.ok(e instanceof Error, `expected an Error, got ${String(e)}`);
        assert.match(e.message, /could not be executed/);
        assert.ok(e.message.includes(L.binary), 'the message names the file');
        return true;
      },
    );
  } finally {
    L.cleanup();
  }
});

test('a crate root that is not a crate is refused, not assumed fresh', () => {
  const L = makeLayout(OLD);
  try {
    const notACrate = fs.mkdtempSync('/tmp/rofl-not-a-crate-');
    try {
      const verdict = checkBinaryFreshness(L.binary, { engineCrate: notACrate });
      assert.equal(verdict.reason, 'sources-not-found');
      assert.equal(verdict.crateRoot, null);
      assert.equal(verdict.sourcesScanned, 0);
      assert.throws(() => assertBinaryFresh(L.binary, false, { engineCrate: notACrate }), StaleBinaryError);
      // the deliberate override still applies to an unverifiable binary
      assert.equal(
        assertBinaryFresh(L.binary, true, { engineCrate: notACrate }).reason,
        'sources-not-found',
      );
    } finally {
      fs.rmSync(notACrate, { recursive: true, force: true });
    }
  } finally {
    L.cleanup();
  }
});
