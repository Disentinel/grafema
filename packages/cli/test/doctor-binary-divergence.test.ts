/**
 * REG-1198 — `grafema doctor` must be able to observe a binary version
 * divergence, and must walk the same resolution order as the code it
 * diagnoses.
 *
 * Measured state that started this: consumers connecting through
 * RFDBServerBackend loaded rfdb-server 0.3.28 out of the platform package
 * (@grafema/grafema-darwin-x64, whose package.json says 0.4.1), while
 * `grafema doctor` in the same tree reported
 *
 *   ✓ Binaries: rfdb-server (monorepo (release)), ...
 *
 * Both statements were true of their own path: findBinary checks the platform
 * package BEFORE the monorepo builds, doctor checked the monorepo first and
 * never looked at the platform package at all. A check that cannot see one of
 * the two possible outcomes can only answer "fine".
 *
 * The fixture stands two real executables on disk that report different
 * versions and hands them to the check as candidates. Version reading,
 * comparison, verdict and rendering are the production ones.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

import { checkBinaries, listCandidatesForDoctor } from '../src/commands/doctor/checks.ts';
import {
  listBinaryCandidates,
  findBinary,
  getPlatformPackageName,
  GRAFEMA_VERSION,
  getSchemaVersion,
} from '@grafema/util';

const EXPECTED = getSchemaVersion(GRAFEMA_VERSION);

/**
 * The platform-package binary as resolved from the CLI's own module location —
 * computed here independently of the code under test, so the assertion cannot
 * be satisfied by the same mistake it is meant to catch.
 */
const PLATFORM_BINARY: string | null = (() => {
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_(getPlatformPackageName());
    const p = pkg.rfdbServerPath ?? (pkg.binDir ? join(pkg.binDir, 'rfdb-server') : null);
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();
/** Three months behind, the version actually found in the platform package. */
const OLD = '0.3.28';

function writeFakeBinary(path: string, name: string, version: string): void {
  writeFileSync(path, `#!/bin/sh\necho "${name} ${version}"\n`);
  chmodSync(path, 0o755);
}

describe('REG-1198 doctor binary resolution', { timeout: 60_000 }, () => {
  let tempDir: string;
  let platformBinary: string;
  let monorepoBinary: string;
  let orchestratorBinary: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-reg1198-'));
    mkdirSync(join(tempDir, 'platform'), { recursive: true });
    mkdirSync(join(tempDir, 'monorepo'), { recursive: true });
    platformBinary = join(tempDir, 'platform', 'rfdb-server');
    monorepoBinary = join(tempDir, 'monorepo', 'rfdb-server');
    orchestratorBinary = join(tempDir, 'monorepo', 'grafema-orchestrator');
    writeFakeBinary(platformBinary, 'rfdb-server', OLD);
    writeFakeBinary(monorepoBinary, 'rfdb-server', EXPECTED);
    writeFakeBinary(orchestratorBinary, 'grafema-orchestrator', '0.1.0');
  });

  after(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  /** The state the ticket says doctor must find. */
  const divergentCandidates = (binaryName: string) =>
    binaryName === 'rfdb-server'
      ? [
          { source: 'platform package @grafema/grafema-darwin-x64', path: platformBinary },
          { source: 'monorepo (release)', path: monorepoBinary },
        ]
      : [{ source: 'monorepo (release)', path: orchestratorBinary }];

  it('finds a platform-package binary whose version differs from the expected one', async () => {
    const result = await checkBinaries({ listCandidates: divergentCandidates });

    assert.notStrictEqual(
      result.status,
      'pass',
      `doctor must not pass while the winning binary is v${OLD} and v${EXPECTED} is expected:\n${result.message}`,
    );
    assert.match(
      result.message,
      new RegExp(`expected v${EXPECTED.replace(/\./g, '\\.')}`),
      `the verdict must name the expected version:\n${result.message}`,
    );
    assert.match(
      result.message,
      /platform package/,
      `the verdict must name WHERE the wrong binary came from:\n${result.message}`,
    );
  });

  it('lists every candidate with its version, not just the winner', async () => {
    const result = await checkBinaries({ listCandidates: divergentCandidates });

    for (const needle of [platformBinary, monorepoBinary, OLD, EXPECTED, 'monorepo (release)']) {
      assert.match(
        result.message,
        new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `every candidate and version must be shown; missing "${needle}":\n${result.message}`,
      );
    }

    const candidates = (result.details as { candidates: Record<string, unknown[]> }).candidates;
    assert.strictEqual(candidates['rfdb-server'].length, 2, 'both candidates must reach the report');
  });

  it('reports agreement as a pass, still listing the candidates', async () => {
    const agreeing = (binaryName: string) =>
      binaryName === 'rfdb-server'
        ? [{ source: 'monorepo (release)', path: monorepoBinary }]
        : [{ source: 'monorepo (release)', path: orchestratorBinary }];

    const result = await checkBinaries({ listCandidates: agreeing });
    assert.strictEqual(result.status, 'pass', `expected a pass, got:\n${result.message}`);
    assert.match(result.message, new RegExp(`rfdb-server ${EXPECTED.replace(/\./g, '\\.')}`));
    // grafema-orchestrator carries its own crate version; comparing it against
    // GRAFEMA_VERSION would only ever print noise.
    assert.match(result.message, /grafema-orchestrator 0\.1\.0/);
  });

  it('flags candidates that disagree with each other even without an expected version', async () => {
    const twoOrchestrators = (binaryName: string) =>
      binaryName === 'rfdb-server'
        ? [{ source: 'monorepo (release)', path: monorepoBinary }]
        : [
            { source: 'platform package @grafema/grafema-darwin-x64', path: orchestratorBinary },
            { source: 'monorepo (release)', path: join(tempDir, 'monorepo', 'grafema-orchestrator-2') },
          ];
    writeFakeBinary(join(tempDir, 'monorepo', 'grafema-orchestrator-2'), 'grafema-orchestrator', '0.2.0');

    const result = await checkBinaries({ listCandidates: twoOrchestrators });
    assert.strictEqual(result.status, 'warn', `expected a warning, got:\n${result.message}`);
    assert.match(
      result.message,
      /resolves to different versions depending on which package asks/,
      `divergence between candidates must be named:\n${result.message}`,
    );
  });

  it('walks the same order as findBinary — doctor cannot consult a private list', () => {
    // One enumerator: findBinary is defined as the first candidate, so the
    // order doctor prints and the order consumers get cannot drift apart.
    const candidates = listBinaryCandidates('rfdb-server');
    assert.strictEqual(
      findBinary('rfdb-server'),
      candidates[0]?.path ?? null,
      'findBinary must be the first candidate of the shared list',
    );

    // And the documented order puts the platform package ahead of monorepo
    // builds — the order that produced the reported divergence.
    const seen = listBinaryCandidates(
      'rfdb-server',
      {},
      {
        existsSync: () => true,
        env: { GRAFEMA_RFDB_SERVER: '/env/rfdb-server', PATH: '/usr/bin', HOME: '/home/u' },
        platformPackagePath: () => '/platform/rfdb-server',
        legacyRfdbPath: () => null,
      },
    ).map((c) => c.source);

    const platformIdx = seen.findIndex((s) => s.startsWith('platform package'));
    const monorepoIdx = seen.findIndex((s) => s.startsWith('monorepo'));
    assert.ok(platformIdx >= 0, `platform package must be a candidate, got ${JSON.stringify(seen)}`);
    assert.ok(monorepoIdx >= 0, `monorepo builds must be candidates, got ${JSON.stringify(seen)}`);
    assert.ok(
      platformIdx < monorepoIdx,
      `platform package must precede monorepo builds, got ${JSON.stringify(seen)}`,
    );
    assert.strictEqual(seen[0], '$GRAFEMA_RFDB_SERVER', `env var wins, got ${JSON.stringify(seen)}`);
  });

  it('never sees fewer candidates than the plain resolver', () => {
    // Node resolution is anchored at the asking module, so doctor asks with its
    // own anchor for the platform package on top of @grafema/util's. It may see
    // MORE than the plain resolver; it must never see less.
    for (const name of ['rfdb-server', 'grafema-orchestrator'] as const) {
      const plain = listBinaryCandidates(name).map((c) => c.path);
      const doctor = listCandidatesForDoctor(name).map((c) => c.path);
      for (const path of plain) {
        assert.ok(
          doctor.includes(path),
          `doctor dropped a candidate the resolver has: ${path}\n  doctor: ${JSON.stringify(doctor)}`,
        );
      }
    }
  });

  it(
    'sees the platform package the CLI can resolve, which @grafema/util cannot',
    { skip: PLATFORM_BINARY ? false : `${getPlatformPackageName()} not resolvable from the CLI here` },
    () => {
      // The candidate at the heart of REG-1198. Measured in this tree:
      // @grafema/grafema-darwin-x64 resolves from packages/cli and
      // packages/grafema but is MODULE_NOT_FOUND from packages/util — so
      // "at least what util sees" is NOT enough to pin this. Doctor must list
      // the binary that installed consumers are actually handed.
      const doctor = listCandidatesForDoctor('rfdb-server');
      assert.ok(
        doctor.some((c) => c.path === PLATFORM_BINARY),
        `doctor must list the platform-package binary ${PLATFORM_BINARY}, got:\n` +
          doctor.map((c) => `  ${c.source} ${c.path}`).join('\n'),
      );
      assert.ok(
        doctor.some((c) => c.source.startsWith('platform package')),
        'the platform package must be labelled as such, not folded into another source',
      );
    },
  );
});
