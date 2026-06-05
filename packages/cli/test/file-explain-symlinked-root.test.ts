/**
 * Tests for `grafema file` / `grafema explain` under a SYMLINKED project root.
 *
 * Bug (found by dogfooding): both commands realpath the resolved FILE path
 * (`absoluteFilePath = realpathSync(resolvedPath)`) but compute the project-
 * relative path against a NON-realpath'd `projectPath = resolve(options.project)`.
 * When the project root is a symlink (e.g. macOS `/tmp` -> `/private/tmp`, `/var`,
 * a symlinked checkout), `relative(projectPath, absoluteFilePath)` crosses the
 * symlink and yields a wrong path (`../../private/...`), so the MODULE node is
 * never matched and the command reports `NOT_ANALYZED` for an analyzed file.
 *
 * This test reproduces it deterministically on any platform via an explicit
 * symlink to the (realpath'd) project dir. Red before the fix, green after.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '../dist/cli.js');

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [cliPath, ...args], { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

describe('grafema file/explain: symlinked project root', { timeout: 90000 }, () => {
  let realRoot: string;   // the real (realpath'd) project directory
  let linkRoot: string;   // a symlink pointing at realRoot

  before(() => {
    // realpath the temp base so `realRoot` is the canonical path.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'gfm-sym-')));
    realRoot = join(base, 'proj');
    mkdirSync(join(realRoot, 'src'), { recursive: true });
    writeFileSync(join(realRoot, 'package.json'),
      JSON.stringify({ name: 'sym-test', version: '1.0.0', main: 'src/main.js' }));
    writeFileSync(join(realRoot, 'grafema.config.yaml'), 'root: "."\ninclude: ["src/**/*.js"]\nexclude: []\n');
    writeFileSync(join(realRoot, 'src', 'main.js'), 'export function run() {\n  return 42;\n}\n');

    const analyze = spawnSync('node', [cliPath, 'analyze', '.', '--clear'],
      { cwd: realRoot, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
    assert.strictEqual(analyze.status, 0, `analyze failed: ${analyze.stderr}`);

    // A symlink pointing at the real project root. Passing this as --project
    // gives a non-realpath'd projectPath that triggers the bug.
    linkRoot = join(base, 'link');
    symlinkSync(realRoot, linkRoot);
  });

  after(() => {
    runCli(['server', 'stop', '--project', realRoot]);
    const base = realRoot && dirname(realRoot);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('`file` reports ANALYZED via a symlinked project root', () => {
    const out = runCli(['file', 'src/main.js', '--project', linkRoot]).stdout;
    assert.ok(!/NOT_ANALYZED/.test(out), `file should not report NOT_ANALYZED via symlinked root:\n${out}`);
    assert.match(out, /\brun\b/, `file should list the analyzed function 'run':\n${out}`);
  });

  it('`explain` finds the analyzed file via a symlinked project root', () => {
    const out = runCli(['explain', 'src/main.js', '--project', linkRoot]).stdout;
    assert.ok(
      !/not been analyzed|No nodes found|NOT_ANALYZED/i.test(out),
      `explain should find the analyzed file via symlinked root:\n${out}`
    );
    assert.match(out, /\brun\b/, `explain should mention the analyzed function 'run':\n${out}`);
  });
});
