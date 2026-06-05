/**
 * Test for `grafema impact <missing> --json` emitting valid JSON.
 *
 * Bug: when the target node is not found, the --json path wrote a message to
 * stderr and returned with EMPTY stdout, so `JSON.parse(stdout)` threw
 * "Unexpected end of JSON input". The --json contract is that stdout is always
 * parseable JSON (scripts/agents consume it). On not-found it should emit a
 * zero-impact object with target:null. (This also unblocks impact-class.test.ts's
 * "class impact >= single method impact", which parses `impact function findById
 * --json` for a method searched as FUNCTION → not found.)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '../dist/cli.js');

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [cliPath, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

describe('grafema impact: --json on not-found', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gfm-impact-json-'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'package.json'),
      JSON.stringify({ name: 'impact-json-test', version: '1.0.0', main: 'src/m.js' }));
    writeFileSync(join(tempDir, 'src', 'm.js'), 'export function foo() { return 1; }\n');
    assert.strictEqual(runCli(['init'], tempDir).status, 0);
    assert.strictEqual(runCli(['analyze'], tempDir).status, 0);
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      runCli(['server', 'stop'], tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits parseable JSON (target null, zero impact) when the target is not found', () => {
    const out = runCli(['impact', 'doesNotExist', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.target, null, `target should be null for a missing node:\n${out}`);
    assert.strictEqual(parsed.directCallers, 0);
    assert.strictEqual(parsed.transitiveCallers, 0);
  });
});
