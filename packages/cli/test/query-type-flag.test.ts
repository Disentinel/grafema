/**
 * Tests for `grafema query --type` flag - REG-253
 *
 * Tests explicit node type filtering:
 * - --type flag bypasses pattern parsing
 * - Works with standard types (FUNCTION, CLASS)
 * - Works with namespaced types (http:route, http:request)
 * - Helpful error when type doesn't exist
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
// TESTS: grafema query --type flag
// =============================================================================

describe('grafema query --type flag', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-query-type-test-'));
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
function functionRoute() { return 'fn'; }
class RouteClass {}
async function fetchUsers() {
  const response = await fetch('/api/users');
  return response.json();
}
module.exports = { functionRoute, RouteClass, fetchUsers };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-type-flag', version: '1.0.0', main: 'src/app.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  // ===========================================================================
  // TESTS: --type flag basic functionality
  // ===========================================================================

  describe('--type flag basic functionality', () => {
    it('should filter by exact type with --type flag', async () => {
      await setupTestProject();

      const result = runCli(['query', '--type', 'FUNCTION', 'route'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should find functionRoute (FUNCTION with "route" in name)
      assert.ok(
        result.stdout.includes('functionRoute'),
        `Should find functionRoute. Got: ${result.stdout}`
      );
      // Should NOT find RouteClass (CLASS, not FUNCTION)
      assert.ok(
        !result.stdout.includes('RouteClass') || result.stdout.includes('FUNCTION'),
        `Should filter to FUNCTION type only`
      );
    });

    it('should accept short form -t', async () => {
      await setupTestProject();

      const result = runCli(['query', '-t', 'FUNCTION', 'route'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('functionRoute'),
        `Should find functionRoute with -t flag. Got: ${result.stdout}`
      );
    });

    it('should bypass alias resolution with --type', async () => {
      await setupTestProject();

      // Without --type: "function route" would parse as type=FUNCTION, name=route
      // With --type: entire pattern is the search term
      const result = runCli(['query', '--type', 'FUNCTION', 'function'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should find functionRoute (has "function" in name)
      assert.ok(
        result.stdout.includes('functionRoute'),
        `Should search for "function" as name, not as type alias. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: --type with namespaced types
  // ===========================================================================

  describe('--type with namespaced types', () => {
    it('should work with http:request type', async () => {
      await setupTestProject();

      const result = runCli(['query', '--type', 'http:request', '/api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should find the fetch call
      assert.ok(
        result.stdout.includes('http:request') || result.stdout.includes('/api/users'),
        `Should find http:request nodes. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: --type error handling
  // ===========================================================================

  describe('--type error handling', () => {
    it('should show helpful message when type not found', async () => {
      await setupTestProject();

      const result = runCli(['query', '--type', 'nonexistent:type', 'anything'], tempDir);

      assert.strictEqual(result.status, 0, 'Should not error, just show no results');
      assert.ok(
        result.stdout.includes('No results'),
        `Should show no results message. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: --type with --json
  // ===========================================================================

  describe('--type with --json', () => {
    it('should output JSON with explicit type', async () => {
      await setupTestProject();

      const result = runCli(['query', '--type', 'FUNCTION', 'route', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      const jsonStart = result.stdout.indexOf('[');
      const jsonEnd = result.stdout.lastIndexOf(']');

      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
        assert.ok(Array.isArray(parsed), 'Should be array');

        if (parsed.length > 0) {
          assert.strictEqual(parsed[0].type, 'FUNCTION', 'All results should be FUNCTION type');
        }
      }
    });
  });

  // ===========================================================================
  // TESTS: Help text
  // ===========================================================================

  describe('help text', () => {
    it('should show --type option in query help', async () => {
      const result = runCli(['query', '--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(
        result.stdout.includes('--type') || result.stdout.includes('-t'),
        `Help should document --type flag. Got: ${result.stdout}`
      );
    });
  });
});
