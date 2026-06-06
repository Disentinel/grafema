/**
 * Test for `grafema export` emitting a GUIDED error when --feature/--as are
 * omitted, instead of commander's bare "required option ... not specified".
 *
 * Bug (sibling of REG-278 / the `ls --type` fix): export.ts declared --feature
 * and --as as `.requiredOption`, so commander short-circuited with its bare
 * error BEFORE the action ran — which made the author's intended guided error
 * (`exitWithError('Both --feature and --as are required', …)`) unreachable dead
 * code. Per the REG-253 umbrella ("every CLI error guides the user"), omitting a
 * required option must point the user at the fix, not dump commander's raw line.
 *
 * Backend-free: the missing-option guard fires before any `.grafema` db access,
 * so this needs neither `analyze` nor the language-analyzer binaries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '../dist/cli.js');

// The missing-option guard exits before any `.grafema` access, so cwd only has
// to exist — use the OS temp dir and create nothing.
const CWD = tmpdir();

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [cliPath, ...args], { cwd: CWD, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

describe('grafema export: guided error on missing required options', { timeout: 60000 }, () => {
  it('does NOT emit commander\'s bare "required option … not specified"', () => {
    const { stderr, status } = runCli(['export']);
    assert.doesNotMatch(stderr, /required option .* not specified/, `should not leak commander's bare error:\n${stderr}`);
    assert.strictEqual(status, 1);
  });

  it('guides the user when both --feature and --as are missing', () => {
    const { stderr } = runCli(['export']);
    assert.match(stderr, /Missing required option/i, `expected a guided error:\n${stderr}`);
    assert.match(stderr, /--feature/, `should name --feature:\n${stderr}`);
    assert.match(stderr, /--as/, `should name --as:\n${stderr}`);
  });

  it('names only --as (and shows valid formats) when --feature is supplied but --as is not', () => {
    const { stderr } = runCli(['export', '--feature', 'cli:*']);
    assert.doesNotMatch(stderr, /required option .* not specified/, stderr);
    assert.match(stderr, /--as/, `should name the missing --as:\n${stderr}`);
    assert.doesNotMatch(stderr, /Missing required option\(s\)[^\n]*--feature/, `--feature was supplied, must not be listed missing:\n${stderr}`);
    // --as drives the format choice, so the guidance must surface valid formats.
    assert.match(stderr, /openapi-3\.1/, `should list a known format:\n${stderr}`);
  });
});
