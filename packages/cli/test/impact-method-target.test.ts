/**
 * Test for `grafema impact <method>` finding METHOD targets (found by dogfooding).
 *
 * Bug: `findTarget` searched only `['FUNCTION', 'CLASS']` (impact.ts:140), so
 * `grafema impact greet` reported `No node "greet" found` even though a `greet`
 * METHOD node exists and `grafema who greet` finds it. impact already has the
 * method machinery (extractMethodName + the findByAttr CALL-by-method fallback),
 * it just never resolved a bare method name to its METHOD node.
 *
 * Fix: include `METHOD` in the default search types. The downstream flow then
 * sets methodName = extractMethodName(target.name) and the findByAttr fallback
 * surfaces the (unresolved) `s.greet()` call site, so `run` shows as affected.
 *
 * Pattern matches impact-class.test.ts (real analyze, assert stdout).
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

describe('grafema impact: METHOD target', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gfm-impact-method-'));
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(tempDir, 'package.json'),
      JSON.stringify({ name: 'impact-method-test', version: '1.0.0', main: 'src/main.js' }));
    writeFileSync(join(srcDir, 'service.js'),
      'export class Service {\n  greet(name) { return `hi ${name}`; }\n}\n');
    writeFileSync(join(srcDir, 'main.js'),
      "import { Service } from './service.js';\nexport function run() {\n  const s = new Service();\n  return s.greet('x');\n}\n");

    const init = runCli(['init'], tempDir);
    assert.strictEqual(init.status, 0, `init failed: ${init.stderr}`);
    const analyze = runCli(['analyze'], tempDir);
    assert.strictEqual(analyze.status, 0, `analyze failed: ${analyze.stderr}`);
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      runCli(['server', 'stop'], tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves a bare method name to its METHOD node (not "No node found")', () => {
    const out = runCli(['impact', 'greet'], tempDir).stdout;
    assert.ok(!/No node/.test(out), `impact should find the 'greet' METHOD node:\n${out}`);
  });

  it('reports the calling function as affected by a method change', () => {
    // `s.greet('x')` is called inside function run(); changing greet impacts run.
    const out = runCli(['impact', 'greet'], tempDir).stdout;
    assert.match(out, /\brun\b/, `impact greet should surface 'run' as affected:\n${out}`);
  });
});
