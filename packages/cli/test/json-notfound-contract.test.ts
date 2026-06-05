/**
 * Test the `--json` not-found contract across CLI commands that query a graph
 * entity: `get`, `context`, `describe`, `ls`.
 *
 * Bug class (siblings of impact #304 / wtf #307): when the queried entity is
 * absent, the not-found path called `exitWithError()` — a human message to
 * stderr plus `process.exit(1)` with EMPTY stdout — even under `--json`. So a
 * consumer doing `JSON.parse(stdout)` got "Unexpected end of JSON input".
 *
 * Contract: under `--json`, stdout is ALWAYS parseable JSON. On not-found each
 * command emits a null/empty object mirroring its success shape (via the shared
 * `emitJsonNotFound` helper) and the human note goes to stderr.
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

describe('CLI --json not-found contract (get/context/describe/ls)', { timeout: 90000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gfm-json-nf-'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'package.json'),
      JSON.stringify({ name: 'json-nf-test', version: '1.0.0', main: 'src/m.js' }));
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

  it('get <missing> --json → parseable JSON, shape mirrors success', () => {
    const out = runCli(['get', '__missing__', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.node, null, `node should be null:\n${out}`);
    // Must mirror the success shape so consumers reading edges.incoming / stats
    // don't crash on not-found (regression guard for the get shape mismatch).
    assert.deepStrictEqual(parsed.edges, { incoming: [], outgoing: [] }, `edges shape:\n${out}`);
    assert.deepStrictEqual(parsed.stats, { incomingCount: 0, outgoingCount: 0 }, `stats shape:\n${out}`);
  });

  it('context <missing> --json → parseable JSON, shape mirrors success', () => {
    const out = runCli(['context', '__missing__', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.node, null, `node should be null:\n${out}`);
    // Must mirror the success NodeContext shape ({ node, source, outgoing,
    // incoming }) so consumers reading source / outgoing / incoming on success
    // don't crash on not-found (regression guard for the context shape mismatch).
    assert.strictEqual(parsed.source, null, `source should be null:\n${out}`);
    assert.deepStrictEqual(parsed.outgoing, [], `outgoing shape:\n${out}`);
    assert.deepStrictEqual(parsed.incoming, [], `incoming shape:\n${out}`);
  });

  it('describe <missing> --json → parseable JSON, target:null', () => {
    const out = runCli(['describe', '__missing__', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.target, null, `target should be null:\n${out}`);
  });

  it('ls --type <missing> --json → parseable JSON, empty result', () => {
    const out = runCli(['ls', '--type', '__MISSING_TYPE__', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.deepStrictEqual(parsed.nodes, [], `nodes should be empty:\n${out}`);
    assert.strictEqual(parsed.total, 0);
  });

  it('explain <missing-file> --json → parseable JSON, NOT_FOUND, empty nodes', () => {
    const out = runCli(['explain', '__nope__.ts', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.status, 'NOT_FOUND', `status should be NOT_FOUND:\n${out}`);
    assert.deepStrictEqual(parsed.nodes, []);
    assert.strictEqual(parsed.totalCount, 0);
  });

  it('file <missing-file> --json → parseable JSON, NOT_FOUND, empty collections', () => {
    const out = runCli(['file', '__nope__.ts', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.status, 'NOT_FOUND', `status should be NOT_FOUND:\n${out}`);
    assert.deepStrictEqual(parsed.functions, []);
    assert.deepStrictEqual(parsed.imports, []);
  });

  it('check --guarantee <unknown> --json → parseable JSON, passed:false (REG-1149)', () => {
    const out = runCli(['check', '--guarantee', '__unknown__', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.guarantee, '__unknown__', `guarantee echoed:\n${out}`);
    assert.strictEqual(parsed.passed, false);
  });

  it('check <unknown-rule> --json → parseable JSON, empty results (REG-1149)', () => {
    // --skip-reanalysis isolates the not-found path from incremental reanalysis.
    const out = runCli(['check', '__unknownRule__', '--skip-reanalysis', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.deepStrictEqual(parsed.results, [], `results should be empty:\n${out}`);
  });

  it('trace --from-route <missing> --json → parseable JSON, route:null (REG-1149)', () => {
    const out = runCli(['trace', '--from-route', '/__missing__', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    assert.strictEqual(parsed.route, null, `route should be null:\n${out}`);
    assert.deepStrictEqual(parsed.responses, []);
  });
});
