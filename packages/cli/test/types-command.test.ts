/**
 * Tests for `grafema types` command - REG-253
 *
 * Tests listing all node types:
 * - Shows all types with counts
 * - Sorts by count (default) or name
 * - JSON output format
 * - Empty graph handling
 * - CLI options (--help, --project)
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
// TESTS: grafema types command
// =============================================================================

describe('grafema types command', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-types-test-'));
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
class MyClass {}
const config = {};
module.exports = { hello, world, MyClass, config };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-types', version: '1.0.0', main: 'src/app.js' })
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
    it('should list all node types with counts', async () => {
      await setupTestProject();

      const result = runCli(['types'], tempDir);

      assert.strictEqual(result.status, 0, `types failed: ${result.stderr}`);
      assert.ok(result.stdout.includes('Node Types in Graph:'), 'Should have header');
      assert.ok(result.stdout.includes('FUNCTION'), 'Should list FUNCTION type');
      assert.ok(result.stdout.includes('CLASS'), 'Should list CLASS type');
      assert.ok(result.stdout.includes('Total:'), 'Should show total');
    });

    it('should show help text', async () => {
      const result = runCli(['types', '--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('List all node types'), 'Should describe command');
      assert.ok(result.stdout.includes('--json'), 'Should document --json flag');
      assert.ok(result.stdout.includes('--sort'), 'Should document --sort flag');
    });
  });

  // ===========================================================================
  // TESTS: sorting
  // ===========================================================================

  describe('sorting', () => {
    it('should sort by count by default (descending)', async () => {
      await setupTestProject();

      const result = runCli(['types'], tempDir);

      assert.strictEqual(result.status, 0);
      // FUNCTION should appear before CLASS (more functions than classes)
      const funcIndex = result.stdout.indexOf('FUNCTION');
      const classIndex = result.stdout.indexOf('CLASS');
      assert.ok(funcIndex < classIndex, 'FUNCTION should appear before CLASS (higher count)');
    });

    it('should sort alphabetically with --sort name', async () => {
      await setupTestProject();

      const result = runCli(['types', '--sort', 'name'], tempDir);

      assert.strictEqual(result.status, 0);
      // CLASS should appear before FUNCTION alphabetically
      const classIndex = result.stdout.indexOf('CLASS');
      const funcIndex = result.stdout.indexOf('FUNCTION');
      assert.ok(classIndex < funcIndex, 'CLASS should appear before FUNCTION (alphabetically)');
    });
  });

  // ===========================================================================
  // TESTS: JSON output
  // ===========================================================================

  describe('JSON output', () => {
    it('should output valid JSON with --json', async () => {
      await setupTestProject();

      const result = runCli(['types', '--json'], tempDir);

      assert.strictEqual(result.status, 0);

      const jsonStart = result.stdout.indexOf('{');
      const jsonEnd = result.stdout.lastIndexOf('}');
      assert.ok(jsonStart !== -1 && jsonEnd > jsonStart, 'Should contain JSON object');

      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
      assert.ok(Array.isArray(parsed.types), 'Should have types array');
      assert.ok(typeof parsed.totalTypes === 'number', 'Should have totalTypes');
      assert.ok(typeof parsed.totalNodes === 'number', 'Should have totalNodes');

      // Each type entry should have type and count
      const firstType = parsed.types[0];
      assert.ok(typeof firstType.type === 'string', 'Type entry should have type string');
      assert.ok(typeof firstType.count === 'number', 'Type entry should have count number');
    });
  });

  // ===========================================================================
  // TESTS: error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should error when no database exists', async () => {
      mkdirSync(join(tempDir, 'empty'));

      const result = runCli(['types'], join(tempDir, 'empty'));

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes('No graph database found'));
    });
  });

  // ===========================================================================
  // TESTS: main help includes types command
  // ===========================================================================

  describe('main help', () => {
    it('should show types command in main help', async () => {
      const result = runCli(['--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('types'), 'Main help should list types command');
    });
  });
});
