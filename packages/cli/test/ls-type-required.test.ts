/**
 * Tests for `grafema ls` missing --type error message — REG-278
 *
 * Backend-free: the missing-`--type` usage error is emitted before any
 * database/backend access, so this file needs no `analyze` run and is
 * safe for the CI unit gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../dist/cli.js');

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

describe('grafema ls — missing --type (REG-278)', () => {
  it('exits non-zero with a helpful message guiding to `grafema types`', () => {
    const { stderr, status } = runCli(['ls']);

    assert.strictEqual(status, 1, `expected exit 1, got ${status}`);
    assert.match(stderr, /Type filter required for 'ls' command/, `got: ${stderr}`);
    assert.match(stderr, /grafema types/, 'should point to `grafema types`');
    assert.match(stderr, /grafema ls --type/, 'should show correct usage');
  });

  it('does NOT emit commander\'s bare "required option" error', () => {
    const { stderr } = runCli(['ls']);
    assert.doesNotMatch(
      stderr,
      /required option .* not specified/,
      'should replace the raw commander error with a guided message',
    );
  });
});
