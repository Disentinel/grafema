/**
 * Test the `--json` not-found / empty-result contract for `query` and `types`.
 *
 * Bug class (siblings of impact #304 / wtf #307 / get·context·describe·ls #308 /
 * explain·file #311 / check·trace #313): when a command produces no rows, its
 * empty path printed a HUMAN string to stdout (or exited with empty stdout) even
 * under `--json`, so a consumer doing `JSON.parse(stdout)` got
 * "Unexpected end of JSON input" / "Unexpected token N in JSON".
 *
 * Two remaining violators found by the Round-C sweep:
 *   - `query "<no-match>" --json` printed `No results for "..."` (query.ts) — the
 *     `nodes.length === 0` early-return sat BEFORE the `if (options.json)` branch.
 *   - `types --json` on an empty graph printed `No nodes in graph...` (types.ts) —
 *     the `entries.length === 0` early-return sat BEFORE the `if (options.json)`
 *     branch.
 *
 * Contract: under `--json`, stdout is ALWAYS parseable JSON. On empty result each
 * command emits the SAME shape it emits on success (an array for `query`, the
 * `{ types, totalTypes, totalNodes }` object for `types`) and the human note goes
 * to stderr.
 *
 * The graph fixture is built directly via {@link RFDBServerBackend} rather than
 * `grafema analyze`, so the test exercises the stdout-routing contract without
 * depending on the language-analyzer binaries (faster, hermetic, and runnable in
 * environments where the analyzer toolchain is unavailable).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { RFDBServerBackend } from '@grafema/util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '../dist/cli.js');

interface FixtureNode {
  id: string;
  type: string;
  name: string;
  file: string;
  line: number;
}

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [cliPath, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

/**
 * Build the graph fixture by writing nodes straight to RFDB (no `analyze`).
 * Passing an empty array leaves a connected-but-empty graph on disk, which is
 * exactly the state the `types`/`query` empty-result paths must handle.
 */
async function populateGraph(cwd: string, nodes: FixtureNode[]): Promise<void> {
  const dbPath = join(cwd, '.grafema', 'graph.rfdb');
  const backend = new RFDBServerBackend({ dbPath, clientName: 'test-setup' });
  await backend.connect();
  try {
    for (const n of nodes) await backend.addNode(n);
    await backend.flush();
  } finally {
    await backend.close();
  }
}

const FOO: FixtureNode = { id: 'FUNCTION#src/m.js#foo', type: 'FUNCTION', name: 'foo', file: 'src/m.js', line: 1 };

describe('CLI --json empty-result contract (query/types)', { timeout: 90000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gfm-json-qt-'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'package.json'),
      JSON.stringify({ name: 'json-qt-test', version: '1.0.0', main: 'src/m.js' }));
    writeFileSync(join(tempDir, 'src', 'm.js'), 'export function foo() { return 1; }\n');
    assert.strictEqual(runCli(['init'], tempDir).status, 0);
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      runCli(['server', 'stop'], tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('query "<no-match>" --json → parseable JSON, empty array', async () => {
    await populateGraph(tempDir, [FOO]);
    const out = runCli(['query', '__missing__', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    // Success shape is a JSON array of nodes; empty result must mirror it.
    assert.ok(Array.isArray(parsed), `expected an array:\n${out}`);
    assert.strictEqual(parsed.length, 0, `expected empty array:\n${out}`);
  });

  it('query "<match>" --json → array still populated (success path unaffected)', async () => {
    await populateGraph(tempDir, [FOO]);
    const out = runCli(['query', 'foo', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed), `expected an array:\n${out}`);
    assert.strictEqual(parsed.length, 1, `expected one match:\n${out}`);
    assert.strictEqual(parsed[0].name, 'foo');
  });

  it('types --json (empty graph) → parseable JSON, empty shape mirrors success', async () => {
    await populateGraph(tempDir, []); // connected but zero nodes
    const out = runCli(['types', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out); // must not throw
    // Must mirror the success shape ({ types, totalTypes, totalNodes }) so a
    // consumer reading those fields on success doesn't get undefined here.
    assert.deepStrictEqual(parsed.types, [], `types should be empty:\n${out}`);
    assert.strictEqual(parsed.totalTypes, 0, `totalTypes:\n${out}`);
    assert.strictEqual(parsed.totalNodes, 0, `totalNodes:\n${out}`);
  });

  it('types --json (non-empty) → success shape unaffected', async () => {
    await populateGraph(tempDir, [FOO]);
    const out = runCli(['types', '--json'], tempDir).stdout;
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.totalNodes, 1, `totalNodes:\n${out}`);
    assert.ok(parsed.types.some((t: { type: string; count: number }) => t.type === 'FUNCTION'),
      `expected FUNCTION type:\n${out}`);
  });
});
