/**
 * Test for `grafema wtf <missing> --json` emitting valid JSON.
 *
 * Bug (sibling of the impact --json fix, PR #304 / REG-543 lineage): when the
 * symbol is not found, the not-found path called `exitWithError()` — printing a
 * human-readable message to stderr and `process.exit(1)` with EMPTY stdout —
 * even under `--json`. So `JSON.parse(stdout)` threw "Unexpected end of JSON
 * input". The --json contract is that stdout is always parseable JSON
 * (scripts/agents consume it). On not-found it should emit a null-result object
 * (node:null, results:[]) and the human note goes to stderr.
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

describe('grafema wtf: --json on not-found', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gfm-wtf-json-'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'package.json'),
      JSON.stringify({ name: 'wtf-json-test', version: '1.0.0', main: 'src/m.js' }));
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

  it('emits parseable JSON (node null, empty results) when the symbol is not found', () => {
    const out = runCli(['wtf', 'doesNotExistSymbol', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.node, null, `node should be null for a missing symbol:\n${out}`);
    assert.deepStrictEqual(parsed.results, []);
    assert.strictEqual(parsed.symbol, 'doesNotExistSymbol');
  });
});
