/**
 * REG-1197 — a failed `analyze` run must not leave a "these files are parsed"
 * mark behind.
 *
 * The defect: the orchestrator persists the generation tracker (per-file mtimes)
 * in the MIDDLE of the pipeline — `packages/grafema-orchestrator/src/main.rs`,
 * step 7 — while several phases (resolution, user plugins, rule packs,
 * diagnostics, compaction) still lie ahead. When one of those later phases
 * aborts the run, the mtimes are already on disk. The next `analyze` compares
 * them, finds nothing changed, logs
 *
 *     Filtered files for analysis changed=0 skipped=1 generation=2
 *     All files up to date, nothing to analyze
 *
 * and exits 0 with a graph that was never finished. A loud failure becomes a
 * quiet success — which is worse than the failure, because `check`, `query` and
 * the MCP tools then answer honestly over an empty graph.
 *
 * Fault injection. The test needs a phase that (a) runs strictly AFTER the
 * tracker write and (b) can be made to fail from outside, without touching
 * production code. The user-plugin DAG (step 8m, main.rs) is exactly that: a
 * batch plugin whose command exits non-zero aborts the run
 * (`plugin::check_plugin_result`), and 8m sits ~600 lines after the step-7
 * tracker write. Whether the phase that dies is the plugin DAG or the rule-pack
 * phase of REG-1196 is irrelevant to the invariant under test: NO phase after
 * the tracker write may leave the tracker claiming the files are done.
 *
 * What makes this test red before the fix:
 *   - run 2 exits 0 ("Analysis complete") after run 1 aborted;
 *   - run 3, with the fault removed, still reports "up to date" and an empty
 *     graph, because the poisoned mtimes are never revisited.
 *
 * Both assertions below fail on the pre-fix binary.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../dist/cli.js');

/** Plugin name used by the injected fault — asserted on, so keep it distinctive. */
const FAULT_PLUGIN = 'reg1197-fault';

/**
 * A batch plugin that always exits 1. `run_batch_plugin` splits the command on
 * whitespace and execs it directly, so a bare `false` is the whole contract.
 */
const FAULT_YAML = `
plugins:
  - name: ${FAULT_PLUGIN}
    command: "false"
    mode: batch
`;

interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
  /** stdout + stderr — the orchestrator logs to stderr, the CLI summary to stdout. */
  output: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return { stdout, stderr, status: result.status, output: stdout + stderr };
}

/** Parse the `  Nodes: N` line the CLI prints on a successful analyze. */
function nodeCount(result: CliResult): number {
  const m = /^\s*Nodes:\s*(\d+)\s*$/m.exec(result.stdout);
  return m ? Number(m[1]) : -1;
}

/** A one-file JS project plus a `.grafema/config.yaml`, ready for `analyze`. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grafema-reg1197-'));
  const srcDir = join(dir, 'src');
  mkdirSync(srcDir);
  writeFileSync(
    join(srcDir, 'app.js'),
    `function alpha() { return beta(); }
function beta() { return 42; }
module.exports = { alpha, beta };
`
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'reg1197-fixture', version: '1.0.0', main: 'src/app.js' })
  );

  const init = runCli(['init'], dir);
  assert.strictEqual(init.status, 0, `init failed: ${init.output}`);
  return dir;
}

function configPathOf(projectDir: string): string {
  return join(projectDir, '.grafema', 'config.yaml');
}

/** Append the always-failing plugin to the project's config. */
function injectFault(projectDir: string): void {
  const p = configPathOf(projectDir);
  writeFileSync(p, readFileSync(p, 'utf-8') + FAULT_YAML);
}

/** Remove the injected plugin block again (everything we appended). */
function removeFault(projectDir: string): void {
  const p = configPathOf(projectDir);
  const text = readFileSync(p, 'utf-8');
  const idx = text.indexOf(FAULT_YAML);
  assert.notStrictEqual(idx, -1, 'fault block not found in config — test bug');
  writeFileSync(p, text.slice(0, idx) + text.slice(idx + FAULT_YAML.length));
}

/** Stop the auto-started RFDB server and drop the temp tree. */
function teardown(projectDir: string | undefined): void {
  if (!projectDir) return;
  try {
    runCli(['server', 'stop'], projectDir);
  } catch {
    // Best effort — an orphan server must not fail the suite.
  }
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

describe('REG-1197: a failed analyze run must not report "up to date" next time', { timeout: 240000 }, () => {
  // ---------------------------------------------------------------------
  // Premise. If `analyze` cannot succeed on this fixture in this
  // environment, every "the run failed" assertion below is vacuous — it
  // would be measuring a broken toolchain, not the defect.
  // ---------------------------------------------------------------------
  describe('premise: the fixture analyzes cleanly when no phase is dropped', () => {
    let dir: string | undefined;
    before(() => {
      dir = makeProject();
    });
    after(() => teardown(dir));

    it('analyze succeeds and builds a non-empty graph', () => {
      const run = runCli(['analyze'], dir!);
      assert.strictEqual(run.status, 0, `analyze failed on a clean fixture: ${run.output}`);
      assert.ok(
        nodeCount(run) > 1,
        `clean analyze produced a degenerate graph (Nodes: ${nodeCount(run)})\n${run.stdout}`
      );
    });
  });

  // ---------------------------------------------------------------------
  // The regression itself.
  // ---------------------------------------------------------------------
  describe('with a phase dropped after the tracker write', () => {
    let dir: string | undefined;
    before(() => {
      dir = makeProject();
      injectFault(dir);
    });
    after(() => teardown(dir));

    it('the second run must not report success, and the graph must recover', () => {
      // --- run 1: aborts at the injected phase -------------------------
      const first = runCli(['analyze'], dir!);
      assert.notStrictEqual(
        first.status,
        0,
        `fault injection did not fail the run — nothing is being tested:\n${first.output}`
      );
      assert.ok(
        first.output.includes(FAULT_PLUGIN),
        `run 1 failed for the wrong reason (expected the injected plugin to abort it):\n${first.output}`
      );

      // --- run 2: THE ASSERTION ----------------------------------------
      // The same command, unchanged sources. The previous run never
      // finished, so this one may re-analyze, or refuse with an explicit
      // message — but it may not claim success.
      const second = runCli(['analyze'], dir!);
      assert.notStrictEqual(
        second.status,
        0,
        `a repeat run after an aborted analyze reported SUCCESS — the failure was masked:\n${second.output}`
      );
      assert.ok(
        !/nothing to analyze/i.test(second.output),
        `a repeat run after an aborted analyze skipped analysis as "up to date":\n${second.output}`
      );

      // --- run 3: the graph is actually rebuilt -------------------------
      // Removing the fault must produce a COMPLETE graph, which means the run
      // has to do the work — not inherit whatever the aborted run happened to
      // leave in the database. Before the fix the poisoned mtimes survive here
      // too, so run 3 skips analysis as "up to date" and the phases that never
      // ran (rule packs, plugins, diagnostics) still have not run.
      //
      // Both halves matter: `status === 0` would also hold for a no-op skip, and
      // a fix that merely wedged the project into permanent failure would die on
      // it. The "did not skip" check is what distinguishes rebuilt from stale.
      removeFault(dir!);
      const third = runCli(['analyze'], dir!);
      assert.strictEqual(
        third.status,
        0,
        `analyze did not recover once the failing phase was removed:\n${third.output}`
      );
      assert.ok(
        !/nothing to analyze/i.test(third.output),
        `the recovery run skipped analysis as "up to date" — the aborted run's mtimes were never revisited, so the phases it never reached still have not run:\n${third.output}`
      );
      assert.ok(
        nodeCount(third) > 1,
        `recovery run left a degenerate graph (Nodes: ${nodeCount(third)}):\n${third.stdout}`
      );
    });
  });
});
