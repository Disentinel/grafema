/**
 * Tests for `grafema ls` command - REG-253
 *
 * Tests listing nodes by type:
 * - List nodes of specific type
 * - Limit results
 * - JSON output
 * - Type-specific formatting
 * - Error when type doesn't exist
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../dist/cli.js');

/**
 * Helper to run CLI command and capture output
 */
function runCli(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number | null } {
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
// TESTS: grafema ls command
// =============================================================================

describe('grafema ls command', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-ls-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to set up a test project with various node types
   */
  async function setupTestProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    writeFileSync(
      join(srcDir, 'app.js'),
      `
function hello() {}
function world() {}
function greet(name) {}
class MyClass {}
module.exports = { hello, world, greet, MyClass };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-ls', version: '1.0.0', main: 'src/app.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  // ===========================================================================
  // TESTS: basic functionality
  // ===========================================================================

  describe('basic functionality', () => {
    it('should list nodes of specified type', async () => {
      await setupTestProject();

      const result = runCli(['ls', '--type', 'FUNCTION'], tempDir);

      assert.strictEqual(result.status, 0, `ls failed: ${result.stderr}`);
      assert.ok(result.stdout.includes('[FUNCTION]'), 'Should show type in header');
      assert.ok(result.stdout.includes('hello'), 'Should list hello function');
      assert.ok(result.stdout.includes('world'), 'Should list world function');
      assert.ok(result.stdout.includes('greet'), 'Should list greet function');
    });

    it('should require --type flag', async () => {
      await setupTestProject();

      const result = runCli(['ls'], tempDir);

      assert.strictEqual(result.status, 1, 'Should error without --type');
      assert.ok(
        result.stderr.includes('--type') || result.stderr.includes('required'),
        'Should mention --type is required'
      );
    });

    it('should show help text', async () => {
      const result = runCli(['ls', '--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('List nodes by type'), 'Should describe command');
      assert.ok(result.stdout.includes('--type'), 'Should document --type flag');
      assert.ok(result.stdout.includes('--limit'), 'Should document --limit flag');
    });
  });

  // ===========================================================================
  // TESTS: limit option
  // ===========================================================================

  describe('limit option', () => {
    it('should limit results with --limit', async () => {
      await setupTestProject();

      const result = runCli(['ls', '--type', 'FUNCTION', '--limit', '2'], tempDir);

      assert.strictEqual(result.status, 0);
      // Should show "... X more" message
      assert.ok(
        result.stdout.includes('more') || result.stdout.match(/\(\s*2\s+of\s+3\s*\)/),
        `Should indicate limited results. Got: ${result.stdout}`
      );
    });

    it('should accept short form -l', async () => {
      await setupTestProject();

      const result = runCli(['ls', '-t', 'FUNCTION', '-l', '1'], tempDir);

      assert.strictEqual(result.status, 0);
    });
  });

  // ===========================================================================
  // TESTS: JSON output
  // ===========================================================================

  describe('JSON output', () => {
    it('should output valid JSON with --json', async () => {
      await setupTestProject();

      const result = runCli(['ls', '--type', 'FUNCTION', '--json'], tempDir);

      assert.strictEqual(result.status, 0);

      const jsonStart = result.stdout.indexOf('{');
      const jsonEnd = result.stdout.lastIndexOf('}');
      assert.ok(jsonStart !== -1 && jsonEnd > jsonStart, 'Should contain JSON object');

      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
      assert.strictEqual(parsed.type, 'FUNCTION', 'Should have type field');
      assert.ok(Array.isArray(parsed.nodes), 'Should have nodes array');
      assert.ok(typeof parsed.showing === 'number', 'Should have showing count');
      assert.ok(typeof parsed.total === 'number', 'Should have total count');
    });
  });

  // ===========================================================================
  // TESTS: error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should show helpful error when type not found', async () => {
      await setupTestProject();

      const result = runCli(['ls', '--type', 'nonexistent:type'], tempDir);

      assert.strictEqual(result.status, 1, 'Should error for unknown type');
      assert.ok(
        result.stderr.includes('No nodes of type'),
        'Should mention type not found'
      );
      assert.ok(
        result.stderr.includes('Available types') || result.stderr.includes('FUNCTION'),
        'Should suggest available types'
      );
    });

    it('should error when no database exists', async () => {
      mkdirSync(join(tempDir, 'empty'));

      const result = runCli(['ls', '--type', 'FUNCTION'], join(tempDir, 'empty'));

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes('No graph database found'));
    });
  });

  // ===========================================================================
  // TESTS: main help includes ls command
  // ===========================================================================

  describe('main help', () => {
    it('should show ls command in main help', async () => {
      const result = runCli(['--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('ls'), 'Main help should list ls command');
    });
  });
});
