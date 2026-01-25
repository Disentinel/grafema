/**
 * Integration tests for `grafema init` command - REG-215
 *
 * Tests error handling when init is run in non-JS projects.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');
const cliPath = join(projectRoot, 'packages/cli/dist/cli.js');

/**
 * Helper to run CLI command and capture output
 */
function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// =============================================================================
// TESTS: grafema init (integration)
// =============================================================================

describe('grafema init (integration)', { timeout: 30000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-init-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Error handling for non-JS projects
  // ===========================================================================

  describe('Shows helpful error for non-JS projects', () => {
    it('should show JS/TS requirement when package.json is missing', () => {
      // Run init in empty directory (no package.json)
      const result = runCli(['init'], tempDir);

      // Should fail
      assert.strictEqual(result.status, 1, 'Should exit with code 1');

      // Error message should explain JS/TS requirement
      assert.match(
        result.stderr,
        /Grafema currently supports JavaScript\/TypeScript projects only/,
        'Should explain JS/TS requirement'
      );

      // Should mention missing package.json with path
      assert.match(
        result.stderr,
        /No package\.json found/,
        'Should mention missing package.json'
      );

      // Should list supported frameworks
      assert.match(
        result.stderr,
        /Supported:/,
        'Should list supported frameworks'
      );

      // Should mention coming soon languages
      assert.match(
        result.stderr,
        /Coming soon:/,
        'Should mention coming soon languages'
      );

      // Should suggest npm init
      assert.match(
        result.stderr,
        /npm init/,
        'Should suggest npm init command'
      );
    });

    it('should include project path in error message', () => {
      const result = runCli(['init'], tempDir);

      // Should include the actual path in the error
      assert.match(
        result.stderr,
        new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'Should include project path in error'
      );
    });
  });

  // ===========================================================================
  // Success case (sanity check)
  // ===========================================================================

  describe('Initializes successfully with package.json', () => {
    it('should succeed when package.json exists', () => {
      // Create package.json
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      );

      const result = runCli(['init'], tempDir);

      assert.strictEqual(result.status, 0, `Should succeed: ${result.stderr}`);
      assert.match(result.stdout, /Found package\.json/, 'Should confirm package.json found');
    });
  });
});
