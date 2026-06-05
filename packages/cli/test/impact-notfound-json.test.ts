/**
 * Test for `grafema impact <target> --json` ALWAYS emitting valid JSON on stdout,
 * including when the target node is not found.
 *
 * Bug (pre-existing, surfaced by impact-class.test.ts:622 "class impact >= single
 * method impact"): when `--json` was set and `findTarget` returned null, impact.ts
 * wrote the "No <type> <name> found" message to *stderr* and emitted nothing on
 * stdout. An agent consuming the documented `--json` contract then does
 * `JSON.parse(stdout)` on an empty string and gets "Unexpected end of JSON input".
 *
 * `--json` is an AI-first machine contract: a not-found result is still a valid
 * answer and must be a parseable JSON object, not an empty stream + a side-channel
 * stderr line. This test pins that contract.
 *
 * Setup note: unlike the sibling impact tests, this one populates a minimal graph
 * directly through RFDBServerBackend instead of running `grafema analyze`. The
 * not-found path is independent of how the graph was built — it only needs a graph
 * to exist and a single FUNCTION node to also exercise the found-target path — so
 * avoiding the language analyzer keeps the test fast and self-contained.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { RFDBServerBackend } from '@grafema/util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '../dist/cli.js');

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [cliPath, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

describe('grafema impact --json: always emits valid JSON', { timeout: 60000 }, () => {
  let tempDir: string;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'gfm-impact-json-'));
    mkdirSync(join(tempDir, '.grafema'), { recursive: true });
    const dbPath = join(tempDir, '.grafema', 'graph.rfdb');

    // Populate a minimal real graph: one FUNCTION node. This creates graph.rfdb
    // (so the command's existsSync check passes) and gives us a found-target case.
    const backend = new RFDBServerBackend({ dbPath, clientName: 'test' });
    await backend.connect();
    await backend.addNodes([
      { id: 'fn:existingFn', type: 'FUNCTION', name: 'existingFn', file: join(tempDir, 'src', 'a.js'), line: 1 },
    ]);
    await backend.flush();
    await backend.close();
  });

  after(() => {
    if (tempDir && existsSync(tempDir)) {
      runCli(['server', 'stop'], tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits valid JSON (target=null) when the target is not found', () => {
    const result = runCli(['impact', 'function NonExistentFn_xyz', '--json'], tempDir);

    assert.strictEqual(result.status, 0, `impact should not crash. stderr: ${result.stderr}`);

    let parsed: any;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(result.stdout);
    }, `--json must emit valid JSON even when the target is not found. stdout=${JSON.stringify(result.stdout)}`);

    // Shape mirrors the success payload so consumers can read these fields
    // unconditionally; target=null + a non-empty error string signal the miss.
    assert.strictEqual(parsed.target, null, 'target should be null when not found');
    assert.strictEqual(parsed.directCallers, 0, 'directCallers should be 0');
    assert.strictEqual(parsed.transitiveCallers, 0, 'transitiveCallers should be 0');
    assert.deepStrictEqual(parsed.affectedModules, {}, 'affectedModules should be empty');
    assert.deepStrictEqual(parsed.callChains, [], 'callChains should be empty');
    assert.ok(
      typeof parsed.error === 'string' && parsed.error.length > 0,
      `should include a human-readable error string. Got: ${JSON.stringify(parsed.error)}`
    );
  });

  it('still emits valid JSON for a target that exists', () => {
    const result = runCli(['impact', 'function existingFn', '--json'], tempDir);

    assert.strictEqual(result.status, 0, `impact should not crash. stderr: ${result.stderr}`);

    let parsed: any;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(result.stdout);
    }, `--json must emit valid JSON for a found target. stdout=${JSON.stringify(result.stdout)}`);

    assert.ok(parsed.target, 'found target should be present');
    assert.strictEqual(parsed.target.name, 'existingFn', 'target name should match');
  });
});
