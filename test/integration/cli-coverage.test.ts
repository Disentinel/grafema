/**
 * Integration tests for `grafema coverage` command
 *
 * Tests the full CLI workflow: init -> analyze -> coverage
 * Based on specification: _tasks/2025-01-24-REG-169-coverage-command/005-don-plan-v2.md
 *
 * Tests:
 * - Shows coverage summary for analyzed project
 * - --json outputs valid JSON with all fields
 * - Shows error when no graph.rfdb exists
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { execSync, spawnSync } from 'child_process';
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
// TESTS: grafema coverage (integration)
// =============================================================================

describe('grafema coverage (integration)', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-coverage-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // TESTS: Shows coverage summary for analyzed project
  // ===========================================================================

  describe('Shows coverage summary for analyzed project', () => {
    it('should display coverage after init and analyze', () => {
      // Setup: Create test project
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(
        join(srcDir, 'index.ts'),
        `
        export function main() {
          console.log('Hello');
        }
        `
      );
      writeFileSync(
        join(srcDir, 'utils.ts'),
        `
        export function helper() {}
        `
      );
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      // Run init
      const initResult = runCli(['init'], tempDir);
      assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

      // Run analyze
      const analyzeResult = runCli(['analyze'], tempDir);
      assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);

      // Run coverage
      const coverageResult = runCli(['coverage'], tempDir);
      assert.strictEqual(coverageResult.status, 0, `coverage failed: ${coverageResult.stderr}`);

      // Verify output contains expected sections
      const output = coverageResult.stdout;
      assert.ok(output.includes('Coverage') || output.includes('coverage'), 'Should show Coverage header');
      assert.ok(output.includes('Analyzed') || output.includes('analyzed'), 'Should show analyzed count');
    });

    it('should show breakdown by category', () => {
      // Setup: Create project with mixed files
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);

      // Supported JS/TS files
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;');
      writeFileSync(join(srcDir, 'utils.ts'), 'export const y = 2;');

      // Unsupported files
      writeFileSync(join(srcDir, 'main.go'), 'package main');
      writeFileSync(join(srcDir, 'query.sql'), 'SELECT 1;');

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      // Run init -> analyze -> coverage
      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage'], tempDir);

      assert.strictEqual(result.status, 0, `coverage failed: ${result.stderr}`);

      const output = result.stdout;

      // Should show unsupported files breakdown
      assert.ok(
        output.includes('Unsupported') || output.includes('unsupported') ||
        output.includes('.go') || output.includes('.sql'),
        'Should show unsupported files information'
      );
    });

    it('should show unreachable files (supported but not in graph)', () => {
      // Setup: Create project where not all files are reachable
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);

      // Main entrypoint
      writeFileSync(join(srcDir, 'index.ts'), 'export const main = () => {};');

      // Orphan file (not imported)
      writeFileSync(join(srcDir, 'orphan.ts'), '// This file is not imported');

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage'], tempDir);

      assert.strictEqual(result.status, 0);

      // Output should mention unreachable or show file breakdown
      const output = result.stdout;
      assert.ok(
        output.includes('Unreachable') || output.includes('unreachable') ||
        output.includes('not imported') || output.includes('%'),
        'Should show unreachable files or percentages'
      );
    });
  });

  // ===========================================================================
  // TESTS: --json outputs valid JSON with all fields
  // ===========================================================================

  describe('--json outputs valid JSON with all fields', () => {
    it('should output valid JSON', () => {
      // Setup
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `coverage --json failed: ${result.stderr}`);

      // Should parse as valid JSON
      let parsed: unknown;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.stdout);
      }, 'Output should be valid JSON');

      assert.ok(parsed, 'JSON should not be empty');
    });

    it('should include total count in JSON', () => {
      // Setup
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;');
      writeFileSync(join(srcDir, 'utils.ts'), 'export const y = 2;');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      assert.ok(typeof parsed.total === 'number', 'Should have total count');
    });

    it('should include analyzed section in JSON', () => {
      // Setup
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      assert.ok(typeof parsed.analyzed === 'object', 'Should have analyzed section');
      const analyzed = parsed.analyzed as Record<string, unknown>;
      assert.ok(typeof analyzed.count === 'number', 'analyzed should have count');
      assert.ok(Array.isArray(analyzed.files), 'analyzed should have files array');
    });

    it('should include unsupported section in JSON', () => {
      // Setup with unsupported files
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;');
      writeFileSync(join(srcDir, 'main.go'), 'package main');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      assert.ok(typeof parsed.unsupported === 'object', 'Should have unsupported section');
      const unsupported = parsed.unsupported as Record<string, unknown>;
      assert.ok(typeof unsupported.count === 'number', 'unsupported should have count');
      assert.ok(typeof unsupported.byExtension === 'object', 'unsupported should have byExtension');
    });

    it('should include unreachable section in JSON', () => {
      // Setup
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;');
      writeFileSync(join(srcDir, 'orphan.ts'), 'const dead = true;');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      assert.ok(typeof parsed.unreachable === 'object', 'Should have unreachable section');
      const unreachable = parsed.unreachable as Record<string, unknown>;
      assert.ok(typeof unreachable.count === 'number', 'unreachable should have count');
      assert.ok(typeof unreachable.byExtension === 'object', 'unreachable should have byExtension');
      assert.ok(Array.isArray(unreachable.files), 'unreachable should have files array');
    });

    it('should include percentages section in JSON', () => {
      // Setup
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      assert.ok(typeof parsed.percentages === 'object', 'Should have percentages section');
      const percentages = parsed.percentages as Record<string, unknown>;
      assert.ok(typeof percentages.analyzed === 'number', 'percentages should have analyzed');
      assert.ok(typeof percentages.unsupported === 'number', 'percentages should have unsupported');
      assert.ok(typeof percentages.unreachable === 'number', 'percentages should have unreachable');
    });

    it('should include projectPath in JSON', () => {
      // Setup
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze'], tempDir);
      const result = runCli(['coverage', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      assert.ok(typeof parsed.projectPath === 'string', 'Should have projectPath');
    });
  });

  // ===========================================================================
  // TESTS: Shows error when no graph.rfdb exists
  // ===========================================================================

  describe('Shows error when no graph.rfdb exists', () => {
    it('should show error for unanalyzed project', () => {
      // Setup: Create project but don't run analyze
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      );

      const result = runCli(['coverage'], tempDir);

      // Should fail with non-zero exit code
      assert.strictEqual(result.status, 1, 'Should exit with code 1');

      // Should show meaningful error message
      const output = result.stderr + result.stdout;
      assert.ok(
        output.includes('No database') || output.includes('not found') ||
        output.includes('graph.rfdb') || output.includes('analyze'),
        `Should show error about missing database. Got: ${output}`
      );
    });

    it('should suggest running analyze', () => {
      // Setup: Empty project
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      );

      const result = runCli(['coverage'], tempDir);

      const output = result.stderr + result.stdout;

      // Should suggest running grafema analyze
      assert.ok(
        output.includes('grafema analyze') || output.includes('Run') ||
        output.includes('analyze'),
        'Should suggest running analyze command'
      );
    });

    it('should fail gracefully for non-existent project path', () => {
      const nonExistentPath = join(tempDir, 'does-not-exist');

      const result = runCli(['coverage', '-p', nonExistentPath], tempDir);

      // Should not crash, should show error
      assert.ok(result.status !== 0, 'Should fail for non-existent path');
    });
  });

  // ===========================================================================
  // TESTS: Help text
  // ===========================================================================

  describe('Help text', () => {
    it('should show coverage command in main help', () => {
      const result = runCli(['--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(
        result.stdout.includes('coverage'),
        'Main help should list coverage command'
      );
    });

    it('should show coverage help with --help flag', () => {
      const result = runCli(['coverage', '--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(
        result.stdout.includes('coverage') ||
        result.stdout.includes('Coverage'),
        'Should show coverage command description'
      );
    });
  });
});
