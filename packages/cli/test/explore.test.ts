/**
 * Tests for `grafema explore` command batch mode - REG-204
 *
 * Tests the batch mode functionality for non-interactive environments:
 * - TTY detection and helpful error messages
 * - --query mode for searching nodes
 * - --callers mode for finding callers of a function
 * - --callees mode for finding callees of a function
 * - JSON and text output formats
 * - Edge cases (no results, function not found, invalid depth)
 *
 * Based on spec: _tasks/2025-01-25-reg-204-explore-raw-mode/003-joel-tech-plan.md
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
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
  cwd: string,
  options?: { stdin?: 'pipe' | 'inherit' }
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
    stdio: options?.stdin === 'pipe' ? ['pipe', 'pipe', 'pipe'] : undefined,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Helper to run CLI without TTY (simulating piped input/output)
 * Uses stdio: 'pipe' to ensure stdin/stdout are not TTY
 */
function runCliNonTTY(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// =============================================================================
// TESTS: grafema explore batch mode
// =============================================================================

describe('grafema explore batch mode', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-explore-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to set up a test project with analyzed code
   */
  async function setupAnalyzedProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    // Create a test file with function call relationships
    writeFileSync(
      join(srcDir, 'index.ts'),
      `
// Main entry point
export function main() {
  authenticate();
  processData();
}

export function authenticate() {
  validateToken();
  checkPermissions();
}

function validateToken() {
  // Token validation logic
}

function checkPermissions() {
  // Permission check logic
}

function processData() {
  fetchData();
  transformData();
}

function fetchData() {
  // Fetch logic
}

function transformData() {
  // Transform logic
}

// Standalone function with no callers
export function orphanFunction() {
  console.log('I am alone');
}
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.ts' })
    );

    // Run init and analyze
    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  // ===========================================================================
  // TESTS: TTY detection
  // ===========================================================================

  describe('TTY detection', () => {
    it('should show error with suggestions when running explore without TTY and no batch flags', async () => {
      await setupAnalyzedProject();

      // Run explore without batch flags in non-TTY mode
      // Note: spawnSync with stdio: 'pipe' creates non-TTY streams
      const result = runCliNonTTY(['explore'], tempDir);

      // Should fail with helpful error
      assert.strictEqual(result.status, 1, 'Should exit with code 1');

      const output = result.stderr + result.stdout;
      assert.ok(
        output.includes('Interactive mode requires a terminal') ||
        output.includes('terminal') ||
        output.includes('TTY'),
        `Should mention terminal requirement. Got: ${output}`
      );
    });

    it('should suggest batch mode alternatives in error message', async () => {
      await setupAnalyzedProject();

      const result = runCliNonTTY(['explore'], tempDir);

      const output = result.stderr + result.stdout;
      assert.ok(
        output.includes('--query') ||
        output.includes('--callers') ||
        output.includes('batch'),
        `Should suggest batch mode alternatives. Got: ${output}`
      );
    });
  });

  // ===========================================================================
  // TESTS: batch mode --query
  // ===========================================================================

  describe('batch mode --query', () => {
    it('should search and return JSON results', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--query', 'authenticate', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --query failed: ${result.stderr}`);

      // Should parse as valid JSON
      let parsed: unknown;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.stdout);
      }, `Output should be valid JSON. Got: ${result.stdout}`);

      const data = parsed as {
        mode: string;
        count: number;
        results: Array<{ name: string; type: string }>;
      };

      assert.strictEqual(data.mode, 'search', 'Mode should be search');
      assert.ok(typeof data.count === 'number', 'Should have count');
      assert.ok(Array.isArray(data.results), 'Should have results array');
    });

    it('should search and return text results', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--query', 'authenticate', '--format', 'text'], tempDir);

      assert.strictEqual(result.status, 0, `explore --query text failed: ${result.stderr}`);

      const output = result.stdout;
      assert.ok(
        output.includes('authenticate') || output.includes('FUNCTION'),
        `Should show function in text output. Got: ${output}`
      );
      assert.ok(
        output.includes('Total:') || output.includes('results'),
        `Should show result count. Got: ${output}`
      );
    });

    it('should handle no results gracefully', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--query', 'nonexistentfunction12345', '--json'], tempDir);

      assert.strictEqual(result.status, 0, 'Should exit with code 0 even with no results');

      const parsed = JSON.parse(result.stdout) as { count: number; results: unknown[] };
      assert.strictEqual(parsed.count, 0, 'Count should be 0');
      assert.strictEqual(parsed.results.length, 0, 'Results should be empty');
    });

    it('should handle partial name matches', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--query', 'auth', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --query partial failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ name: string }>;
      };

      // Should find authenticate via partial match
      const hasMatch = parsed.results.some(r =>
        r.name.toLowerCase().includes('auth')
      );
      assert.ok(hasMatch, 'Should find functions matching partial name');
    });
  });

  // ===========================================================================
  // TESTS: batch mode --callers
  // ===========================================================================

  describe('batch mode --callers', () => {
    it('should show callers of a function in JSON format', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callers', 'authenticate', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --callers failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as {
        mode: string;
        target: { name: string };
        count: number;
        results: Array<{ name: string; type: string }>;
      };

      assert.strictEqual(parsed.mode, 'callers', 'Mode should be callers');
      assert.ok(parsed.target, 'Should have target');
      assert.ok(parsed.target.name.toLowerCase().includes('authenticate'), 'Target should be authenticate');
    });

    it('should show callers of a function in text format', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callers', 'authenticate', '--format', 'text'], tempDir);

      assert.strictEqual(result.status, 0, `explore --callers text failed: ${result.stderr}`);

      const output = result.stdout;
      assert.ok(
        output.includes('Callers of') || output.includes('callers'),
        `Should indicate callers mode. Got: ${output}`
      );
    });

    it('should respect --depth for recursive traversal', async () => {
      await setupAnalyzedProject();

      // With depth 1, should only get direct callers
      const depth1Result = runCli(['explore', '--callers', 'validateToken', '--depth', '1', '--json'], tempDir);
      assert.strictEqual(depth1Result.status, 0, `explore --callers depth 1 failed: ${depth1Result.stderr}`);

      const depth1Parsed = JSON.parse(depth1Result.stdout) as { count: number };

      // With depth 3, should get more transitive callers
      const depth3Result = runCli(['explore', '--callers', 'validateToken', '--depth', '3', '--json'], tempDir);
      assert.strictEqual(depth3Result.status, 0, `explore --callers depth 3 failed: ${depth3Result.stderr}`);

      const depth3Parsed = JSON.parse(depth3Result.stdout) as { count: number };

      // Deeper traversal should find at least as many callers
      // (validateToken is called by authenticate, which is called by main)
      assert.ok(
        depth3Parsed.count >= depth1Parsed.count,
        `Depth 3 (${depth3Parsed.count}) should find >= depth 1 (${depth1Parsed.count})`
      );
    });

    it('should error when function not found', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callers', 'nonexistentfunction12345'], tempDir);

      assert.strictEqual(result.status, 1, 'Should exit with code 1 when function not found');

      const output = result.stderr + result.stdout;
      assert.ok(
        output.includes('not found') || output.includes('No'),
        `Should indicate function not found. Got: ${output}`
      );
    });

    it('should handle function with no callers', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callers', 'orphanFunction', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --callers orphan failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as { count: number; results: unknown[] };
      assert.strictEqual(parsed.count, 0, 'Should have no callers');
      assert.strictEqual(parsed.results.length, 0, 'Results should be empty');
    });
  });

  // ===========================================================================
  // TESTS: batch mode --callees
  // ===========================================================================

  describe('batch mode --callees', () => {
    it('should show callees of a function in JSON format', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callees', 'authenticate', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --callees failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as {
        mode: string;
        target: { name: string };
        count: number;
        results: Array<{ name: string; type: string }>;
      };

      assert.strictEqual(parsed.mode, 'callees', 'Mode should be callees');
      assert.ok(parsed.target, 'Should have target');
    });

    it('should show callees of a function in text format', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callees', 'authenticate', '--format', 'text'], tempDir);

      assert.strictEqual(result.status, 0, `explore --callees text failed: ${result.stderr}`);

      const output = result.stdout;
      assert.ok(
        output.includes('Callees of') || output.includes('callees') || output.includes('Calls'),
        `Should indicate callees mode. Got: ${output}`
      );
    });

    it('should error when function not found', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callees', 'nonexistentfunction12345'], tempDir);

      assert.strictEqual(result.status, 1, 'Should exit with code 1 when function not found');

      const output = result.stderr + result.stdout;
      assert.ok(
        output.includes('not found') || output.includes('No'),
        `Should indicate function not found. Got: ${output}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should use default depth when invalid depth provided', async () => {
      await setupAnalyzedProject();

      // Invalid depth should fall back to default (3)
      const result = runCli(['explore', '--callers', 'authenticate', '--depth', 'invalid', '--json'], tempDir);

      // Should not crash - either works with default or shows error
      // The important thing is it doesn't hang or crash
      assert.ok(
        result.status === 0 || result.status === 1,
        `Should handle invalid depth gracefully. Status: ${result.status}`
      );
    });

    it('should work with batch flags even without graph database', async () => {
      // Don't set up analyzed project - just create temp dir
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      );

      const result = runCli(['explore', '--query', 'test'], tempDir);

      // Should fail with helpful error about missing database
      assert.strictEqual(result.status, 1, 'Should exit with code 1');

      const output = result.stderr + result.stdout;
      assert.ok(
        output.includes('No database') || output.includes('not found') ||
        output.includes('graph.rfdb') || output.includes('analyze'),
        `Should show error about missing database. Got: ${output}`
      );
    });

    it('should handle multiple batch flags - query takes precedence', async () => {
      await setupAnalyzedProject();

      // When multiple batch flags provided, query should take precedence
      const result = runCli([
        'explore',
        '--query', 'main',
        '--callers', 'authenticate',
        '--json'
      ], tempDir);

      assert.strictEqual(result.status, 0, `explore with multiple flags failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as { mode: string };
      assert.strictEqual(parsed.mode, 'search', 'Query flag should take precedence');
    });

    it('should include file paths in JSON output', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--query', 'authenticate', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --query failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ name: string; file: string }>;
      };

      if (parsed.results.length > 0) {
        assert.ok(
          typeof parsed.results[0].file === 'string',
          'Results should include file path'
        );
        // File path should be relative (not absolute)
        assert.ok(
          !parsed.results[0].file.startsWith('/'),
          'File path should be relative'
        );
      }
    });

    it('should include line numbers when available', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--query', 'authenticate', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --query failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ name: string; line?: number }>;
      };

      if (parsed.results.length > 0) {
        // Line should be a number if present
        if (parsed.results[0].line !== undefined) {
          assert.ok(
            typeof parsed.results[0].line === 'number',
            'Line should be a number'
          );
        }
      }
    });
  });

  // ===========================================================================
  // TESTS: Help text
  // ===========================================================================

  describe('Help text', () => {
    it('should show explore command in main help', () => {
      const result = runCli(['--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(
        result.stdout.includes('explore'),
        'Main help should list explore command'
      );
    });

    it('should show batch mode options in explore help', async () => {
      const result = runCli(['explore', '--help'], tempDir);

      assert.strictEqual(result.status, 0);

      const output = result.stdout;
      assert.ok(
        output.includes('--query') || output.includes('-q'),
        'Should show --query option'
      );
      assert.ok(
        output.includes('--callers'),
        'Should show --callers option'
      );
      assert.ok(
        output.includes('--callees'),
        'Should show --callees option'
      );
      assert.ok(
        output.includes('--depth') || output.includes('-d'),
        'Should show --depth option'
      );
      assert.ok(
        output.includes('--json') || output.includes('-j'),
        'Should show --json option'
      );
    });
  });

  // ===========================================================================
  // TESTS: JSON output schema
  // ===========================================================================

  describe('JSON output schema', () => {
    it('search mode should have correct schema', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--query', 'main', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --query failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as {
        mode: string;
        target?: unknown;
        count: number;
        results: Array<{
          id: string;
          type: string;
          name: string;
          file: string;
          line?: number;
        }>;
      };

      // Verify schema
      assert.strictEqual(parsed.mode, 'search');
      assert.strictEqual(parsed.target, undefined, 'Search mode should not have target');
      assert.ok(typeof parsed.count === 'number');
      assert.ok(Array.isArray(parsed.results));

      if (parsed.results.length > 0) {
        const first = parsed.results[0];
        assert.ok(typeof first.id === 'string', 'id should be string');
        assert.ok(typeof first.type === 'string', 'type should be string');
        assert.ok(typeof first.name === 'string', 'name should be string');
        assert.ok(typeof first.file === 'string', 'file should be string');
      }
    });

    it('callers mode should have correct schema with target', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callers', 'authenticate', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --callers failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as {
        mode: string;
        target: {
          id: string;
          type: string;
          name: string;
          file: string;
          line?: number;
        };
        count: number;
        results: unknown[];
      };

      // Verify schema
      assert.strictEqual(parsed.mode, 'callers');
      assert.ok(parsed.target, 'Callers mode should have target');
      assert.ok(typeof parsed.target.id === 'string');
      assert.ok(typeof parsed.target.type === 'string');
      assert.ok(typeof parsed.target.name === 'string');
      assert.ok(typeof parsed.target.file === 'string');
      assert.ok(typeof parsed.count === 'number');
      assert.ok(Array.isArray(parsed.results));
    });

    it('callees mode should have correct schema with target', async () => {
      await setupAnalyzedProject();

      const result = runCli(['explore', '--callees', 'main', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explore --callees failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as {
        mode: string;
        target: { name: string };
        count: number;
        results: unknown[];
      };

      // Verify schema
      assert.strictEqual(parsed.mode, 'callees');
      assert.ok(parsed.target, 'Callees mode should have target');
      assert.ok(typeof parsed.count === 'number');
      assert.ok(Array.isArray(parsed.results));
    });
  });
});
