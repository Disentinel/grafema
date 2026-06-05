/**
 * Tests for `grafema who` caller attribution.
 *
 * Two bugs (found by dogfooding, fixed together):
 *
 * 1. `<anonymous>` caller — `who.ts` extracted the enclosing function from the
 *    CALL node's semantic ID by splitting on `->` and looking for a `FUNCTION`/
 *    `METHOD` segment (the OLD v1 id shape). Current ids are v2 URIs of the form
 *    `grafema://…/file#CALL->name[in:enclosingFn,h:xxxx]`, so the walk never
 *    matched and every caller printed as `<anonymous>`. Fixed by parsing the v2
 *    `[in:…]` annotation via `parseSemanticIdV2`.
 *
 * 2. import-as-caller — Strategy 2 listed `IMPORTS_FROM` incoming edges as
 *    callers, so the `import { helper }` line was reported as a bare caller
 *    named `helper`. Imports are uses, not callers; they are reported separately
 *    (Strategy 3, labelled `imports …`), so `IMPORTS_FROM` was dropped here.
 *
 * Pattern matches impact-polymorphic-callers.test.ts (real analyze, assert stdout).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../dist/cli.js');

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

describe('grafema who: caller attribution', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gfm-who-'));
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(tempDir, 'package.json'),
      JSON.stringify({ name: 'who-test', version: '1.0.0', main: 'src/main.js' }));
    writeFileSync(join(srcDir, 'lib.js'), `export function helper(x) {\n  return x * 2;\n}\n`);
    writeFileSync(join(srcDir, 'main.js'),
      `import { helper } from './lib.js';\n\nfunction caller() {\n  return helper(21);\n}\n\nexport function topLevel() {\n  return caller();\n}\n`);

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

  it('attributes a call to its enclosing named function, not <anonymous>', () => {
    // helper() is called inside function caller() at main.js:4
    const out = runCli(['who', 'helper'], tempDir).stdout;
    assert.match(out, /\bcaller\b/, `who helper should name the enclosing function 'caller':\n${out}`);
    // The helper call site must NOT be reported as <anonymous>.
    assert.ok(
      !/main\.js:4\s+<anonymous>/.test(out),
      `helper's call site should be attributed to 'caller', not <anonymous>:\n${out}`
    );
  });

  it('attributes a nested named caller (topLevel calls caller)', () => {
    // caller() is called inside function topLevel() at main.js:8
    const out = runCli(['who', 'caller'], tempDir).stdout;
    assert.match(out, /\btopLevel\b/, `who caller should name the enclosing function 'topLevel':\n${out}`);
    assert.ok(
      !/main\.js:8\s+<anonymous>/.test(out),
      `caller's call site should be attributed to 'topLevel', not <anonymous>:\n${out}`
    );
  });

  it('does not report the import statement as a bare caller of the symbol', () => {
    // `import { helper }` at main.js:1 is a use, not a caller. If listed at all
    // it must be labelled as an import (Strategy 3), never as a plain caller.
    const out = runCli(['who', 'helper'], tempDir).stdout;
    assert.ok(
      !/main\.js:1\s+helper\b/.test(out),
      `the import line should not be reported as a bare caller named 'helper':\n${out}`
    );
  });
});
