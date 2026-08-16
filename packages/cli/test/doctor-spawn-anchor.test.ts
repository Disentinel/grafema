/**
 * REG-1198 follow-up — doctor must not present ONE resolution as the answer
 * when the answer depends on who is asking.
 *
 * Node resolution is anchored at the asking module, so there is no single true
 * arrow: measured on this machine, @grafema/grafema-darwin-x64 resolves from
 * packages/cli and packages/grafema but is MODULE_NOT_FOUND from packages/util.
 * Doctor lives in the CLI, the server is spawned through @grafema/util's
 * findBinary — so a cli-anchored arrow names a binary that never runs. The
 * first fix made doctor overstate the problem exactly as far as the original
 * defect understated it.
 *
 * GROUND TRUTH here is not another resolver call: a real server is started for
 * a temp project and the executable of the process holding THAT project's
 * socket is read out of `ps`. Doctor's claim about "what actually spawns" is
 * checked against that process.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

import { checkBinaries } from '../src/commands/doctor/checks.ts';
import { RFDBServerBackend, findRfdbBinary, getPlatformPackageName } from '@grafema/util';

const skip = findRfdbBinary() ? false : 'rfdb-server binary not found';

/** argv[0] of the process listening on this socket — what actually runs. */
function executableServing(socketPath: string): string | null {
  let pids: number[];
  try {
    pids = execFileSync('pgrep', ['-f', socketPath], { encoding: 'utf8' })
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((p) => p > 0 && p !== process.pid);
  } catch {
    return null;
  }
  for (const pid of pids) {
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      const argv0 = cmd.split(' ')[0];
      if (argv0.endsWith('rfdb-server')) return argv0;
    } catch {
      /* process gone */
    }
  }
  return null;
}

/**
 * What the CLI's own anchor resolves — computed here with this test file's
 * `createRequire`, which shares the CLI's node_modules chain, so the
 * expectation does not come from the code under test.
 */
const CLI_ANCHORED: string | null = (() => {
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_(getPlatformPackageName());
    const p = pkg.rfdbServerPath ?? (pkg.binDir ? join(pkg.binDir, 'rfdb-server') : null);
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

describe('REG-1198 doctor spawn anchor', { skip, timeout: 120_000 }, () => {
  let projectPath: string;
  let socketPath: string;
  let actualBinary: string | null = null;

  before(async () => {
    projectPath = mkdtempSync(join(tmpdir(), 'grafema-anchor-'));
    mkdirSync(join(projectPath, '.grafema'), { recursive: true });
    const backend = new RFDBServerBackend({
      dbPath: join(projectPath, '.grafema', 'graph.rfdb'),
      silent: true,
    });
    socketPath = backend.socketPath;
    await backend.connect();
    actualBinary = executableServing(socketPath);
    await backend.close();
  });

  after(() => {
    if (socketPath) {
      try {
        for (const pid of execFileSync('pgrep', ['-f', socketPath], { encoding: 'utf8' })
          .split('\n')
          .map((s) => parseInt(s.trim(), 10))
          .filter((p) => p > 0)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* none running */
      }
    }
    if (projectPath) rmSync(projectPath, { recursive: true, force: true });
  });

  it('measured a live server, so the ground truth is a process and not another resolver call', () => {
    assert.ok(actualBinary, `could not read the executable serving ${socketPath}`);
    assert.ok(
      actualBinary!.endsWith('rfdb-server'),
      `expected an rfdb-server executable, got ${actualBinary}`,
    );
  });

  it('names the binary the server is actually spawned with, not the one its own anchor resolves', async () => {
    const result = await checkBinaries();
    const spawnLines = result.message
      .split('\n')
      .filter((l) => /actual spawn/i.test(l) && /rfdb-server/.test(l));

    assert.strictEqual(
      spawnLines.length,
      1,
      `doctor must state, once, which binary actually spawns. Got ${spawnLines.length} such lines in:\n${result.message}`,
    );
    assert.ok(
      spawnLines[0].includes(actualBinary!),
      `doctor claims a different binary than the one running.\n  running: ${actualBinary}\n  doctor:  ${spawnLines[0]}`,
    );

    const spawn = (result.details as { spawn?: Record<string, { path: string | null }> }).spawn;
    assert.ok(spawn, 'the JSON report must carry the actual spawn binary too');
    assert.strictEqual(
      spawn!['rfdb-server'].path,
      actualBinary,
      'details.spawn must match the process that is running',
    );
  });

  it('reports the outcome for every anchor, so no single arrow stands in for all of them', async () => {
    const result = await checkBinaries();
    for (const anchor of ['@grafema/util', '@grafema/cli', 'grafema']) {
      assert.match(
        result.message,
        new RegExp(anchor.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
        `every anchor must be accounted for; missing ${anchor} in:\n${result.message}`,
      );
    }

    const anchors = (result.details as {
      anchors?: Record<string, Record<string, { path: string | null; unavailable?: string }>>;
    }).anchors;
    assert.ok(anchors, 'the JSON report must carry the per-anchor outcomes');
    for (const anchor of ['@grafema/util', '@grafema/cli', 'grafema']) {
      const row = anchors!['rfdb-server'][anchor];
      assert.ok(
        row && (row.path !== null || row.unavailable),
        `anchor ${anchor} must report a path or say why it has none, got ${JSON.stringify(row)}`,
      );
    }
  });

  it(
    'flags that consumers do not all get the same binary',
    {
      skip:
        CLI_ANCHORED && CLI_ANCHORED !== findRfdbBinary()
          ? false
          : 'anchors agree on this machine — nothing to flag',
    },
    async () => {
      // Live on this machine: the CLI anchor resolves the platform package
      // (0.3.28) while the spawn goes through @grafema/util (0.4.1).
      const result = await checkBinaries();
      assert.notStrictEqual(result.status, 'pass', `a real divergence must not read as healthy:\n${result.message}`);
      assert.match(
        result.message,
        /depends on (the asking module|which package asks)/i,
        `the report must name anchor-dependence as the problem:\n${result.message}`,
      );
      assert.ok(
        result.message.includes(CLI_ANCHORED!),
        `the diverging candidate must be shown: ${CLI_ANCHORED}\n${result.message}`,
      );
    },
  );
});
