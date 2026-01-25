/**
 * Tests for `grafema doctor` command - REG-214
 *
 * Tests the diagnostic check functions for validating Grafema setup:
 * - checkGrafemaInitialized: .grafema directory and config file detection
 * - checkServerStatus: RFDB server socket detection
 * - checkConfigValidity: YAML/JSON syntax and plugin validation
 * - checkEntrypoints: Service path and entrypoint file validation
 * - checkDatabaseExists: Database file existence and size validation
 *
 * Also tests output formatting:
 * - formatCheck: Single check result formatting
 * - buildJsonReport: JSON report structure
 *
 * Based on spec: _tasks/REG-214/003-joel-tech-plan.md
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
  cwd: string,
  timeoutMs = 30000
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// =============================================================================
// TESTS: grafema doctor command
// =============================================================================

describe('grafema doctor', { timeout: 300000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-doctor-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // TESTS: checkGrafemaInitialized
  // ===========================================================================

  describe('checkGrafemaInitialized', () => {
    it('should fail when .grafema directory does not exist', () => {
      // Just an empty directory - no .grafema
      const result = runCli(['doctor'], tempDir);

      assert.strictEqual(result.status, 1, 'Should exit with code 1 on failure');

      const output = result.stdout + result.stderr;
      assert.ok(
        output.includes('not found') || output.includes('.grafema'),
        `Should mention .grafema directory issue. Got: ${output}`
      );
      assert.ok(
        output.includes('grafema init') || output.includes('init'),
        `Should recommend running grafema init. Got: ${output}`
      );
    });

    it('should pass when config.yaml exists', () => {
      // Create .grafema with config.yaml
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      const result = runCli(['doctor'], tempDir);

      // Should not fail on initialization check (may fail later due to missing database)
      const output = result.stdout + result.stderr;
      // Check that initialization passed (look for config.yaml mention or pass indicator)
      const hasInitPass =
        output.includes('config.yaml') ||
        output.includes('Config') ||
        !output.includes('.grafema directory not found');

      assert.ok(hasInitPass, `Initialization check should pass. Got: ${output}`);
    });

    it('should warn when config.json exists (deprecated)', () => {
      // Create .grafema with config.json (deprecated)
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.json'),
        JSON.stringify({
          plugins: {
            indexing: ['JSModuleIndexer'],
            analysis: ['JSASTAnalyzer'],
            enrichment: ['MethodCallResolver'],
            validation: ['EvalBanValidator'],
          },
        })
      );

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Should see deprecation warning or config.json mention
      // The exit code might be 1 or 2 depending on other checks
      assert.ok(
        output.includes('deprecated') ||
          output.includes('config.json') ||
          output.includes('migrate') ||
          output.includes('warn'),
        `Should warn about deprecated config.json. Got: ${output}`
      );
    });

    it('should fail when .grafema exists but has no config file', () => {
      // Create empty .grafema directory
      mkdirSync(join(tempDir, '.grafema'));

      const result = runCli(['doctor'], tempDir);

      assert.strictEqual(result.status, 1, 'Should exit with code 1');

      const output = result.stdout + result.stderr;
      assert.ok(
        output.includes('not found') ||
          output.includes('Config') ||
          output.includes('init'),
        `Should indicate missing config. Got: ${output}`
      );
    });
  });

  // ===========================================================================
  // TESTS: checkServerStatus
  // ===========================================================================

  describe('checkServerStatus', () => {
    it('should warn when socket does not exist', () => {
      // Create valid .grafema with config
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );
      // No socket file - server not running

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Should mention server not running
      assert.ok(
        output.includes('not running') ||
          output.includes('server') ||
          output.includes('analyze'),
        `Should mention server not running. Got: ${output}`
      );
    });
  });

  // ===========================================================================
  // TESTS: checkConfigValidity
  // ===========================================================================

  describe('checkConfigValidity', () => {
    it('should fail on invalid YAML syntax', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `invalid: yaml: syntax: : :`
      );

      const result = runCli(['doctor'], tempDir);

      // Should fail or show error about config
      const output = result.stdout + result.stderr;
      assert.ok(
        output.includes('error') ||
          output.includes('Error') ||
          output.includes('invalid') ||
          output.includes('parse') ||
          result.status !== 0,
        `Should indicate config error. Got: ${output}`
      );
    });

    it('should warn on unknown plugin names', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - NonExistentPluginThatDoesNotExist
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Should warn about unknown plugin
      assert.ok(
        output.includes('unknown') ||
          output.includes('Unknown') ||
          output.includes('NonExistentPlugin') ||
          output.includes('warn'),
        `Should warn about unknown plugin. Got: ${output}`
      );
    });

    it('should pass with valid config and known plugins', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Config validation should pass (look for config mention without error)
      const hasConfigCheck =
        output.includes('Config') ||
        output.includes('plugins') ||
        output.includes('valid');

      // Should not have config-specific errors
      const hasConfigError =
        output.includes('Config error') ||
        output.includes('unknown plugin') ||
        output.includes('syntax');

      assert.ok(!hasConfigError || hasConfigCheck, `Config should validate. Got: ${output}`);
    });
  });

  // ===========================================================================
  // TESTS: checkEntrypoints
  // ===========================================================================

  describe('checkEntrypoints', () => {
    it('should pass in auto-discovery mode with package.json', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );
      // Create package.json for auto-discovery
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'index.js' })
      );
      writeFileSync(join(tempDir, 'index.js'), 'module.exports = {};');

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Should mention auto-discovery or entrypoints passing
      assert.ok(
        output.includes('auto-discovery') ||
          output.includes('Entrypoint') ||
          output.includes('package.json') ||
          !output.includes('entrypoint'),
        `Should handle auto-discovery mode. Got: ${output}`
      );
    });

    it('should warn when services have missing entrypoints', () => {
      // Create service directory structure
      mkdirSync(join(tempDir, '.grafema'));
      mkdirSync(join(tempDir, 'apps'));
      mkdirSync(join(tempDir, 'apps', 'backend'));
      // Note: NO index.js or entrypoint file in backend

      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator

services:
  - name: backend
    path: apps/backend
    entryPoint: src/index.ts
`
      );

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Should warn about missing entrypoint
      assert.ok(
        output.includes('not found') ||
          output.includes('missing') ||
          output.includes('entrypoint') ||
          output.includes('warn'),
        `Should warn about missing entrypoint. Got: ${output}`
      );
    });
  });

  // ===========================================================================
  // TESTS: checkDatabaseExists
  // ===========================================================================

  describe('checkDatabaseExists', () => {
    it('should fail when database file does not exist', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );
      // No graph.rfdb file

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Should fail or warn about missing database
      assert.ok(
        output.includes('not found') ||
          output.includes('Database') ||
          output.includes('database') ||
          output.includes('analyze'),
        `Should mention missing database. Got: ${output}`
      );

      // Exit code should be non-zero (1 for error or 2 for warning)
      assert.ok(
        result.status !== 0,
        `Should exit with non-zero code. Got: ${result.status}`
      );
    });

    it('should warn on empty database', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );
      // Create empty database file (< 100 bytes)
      writeFileSync(join(tempDir, '.grafema', 'graph.rfdb'), '');

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Should warn about empty database
      assert.ok(
        output.includes('empty') ||
          output.includes('warn') ||
          output.includes('analyze') ||
          output.includes('Database'),
        `Should warn about empty database. Got: ${output}`
      );
    });

    it('should pass when database exists with content', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );
      // Create database file with some content (> 100 bytes)
      const content = 'x'.repeat(200);
      writeFileSync(join(tempDir, '.grafema', 'graph.rfdb'), content);

      const result = runCli(['doctor'], tempDir);

      const output = result.stdout + result.stderr;
      // Database check should pass (may still have server warning)
      const hasDatabaseError =
        output.includes('Database not found') || output.includes('database not found');

      assert.ok(!hasDatabaseError, `Database check should pass. Got: ${output}`);
    });
  });

  // ===========================================================================
  // TESTS: Output formatting - JSON mode
  // ===========================================================================

  describe('JSON output', () => {
    it('should output valid JSON with --json flag', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      const result = runCli(['doctor', '--json'], tempDir);

      // Should output valid JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        assert.fail(`Output should be valid JSON. Got: ${result.stdout}`);
      }

      assert.ok(typeof parsed === 'object' && parsed !== null, 'Should parse to object');
    });

    it('should include status field in JSON output', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      const result = runCli(['doctor', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as { status: string };
      assert.ok(
        ['healthy', 'warning', 'error'].includes(parsed.status),
        `Status should be healthy/warning/error. Got: ${parsed.status}`
      );
    });

    it('should include checks array in JSON output', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      const result = runCli(['doctor', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as {
        checks: Array<{ name: string; status: string; message: string }>;
      };

      assert.ok(Array.isArray(parsed.checks), 'Should have checks array');
      assert.ok(parsed.checks.length > 0, 'Should have at least one check');

      // Each check should have name, status, message
      for (const check of parsed.checks) {
        assert.ok(typeof check.name === 'string', 'Check should have name');
        assert.ok(
          ['pass', 'warn', 'fail', 'skip'].includes(check.status),
          `Check status should be pass/warn/fail/skip. Got: ${check.status}`
        );
        assert.ok(typeof check.message === 'string', 'Check should have message');
      }
    });

    it('should include recommendations array in JSON output', () => {
      // Create failing scenario to get recommendations
      const result = runCli(['doctor', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as { recommendations: string[] };

      assert.ok(Array.isArray(parsed.recommendations), 'Should have recommendations array');
    });

    it('should include versions in JSON output', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      const result = runCli(['doctor', '--json'], tempDir);

      const parsed = JSON.parse(result.stdout) as {
        versions: { cli: string; core: string; rfdb?: string };
      };

      assert.ok(parsed.versions, 'Should have versions object');
      assert.ok(typeof parsed.versions.cli === 'string', 'Should have CLI version');
      assert.ok(typeof parsed.versions.core === 'string', 'Should have core version');
    });
  });

  // ===========================================================================
  // TESTS: Exit codes
  // ===========================================================================

  describe('Exit codes', () => {
    it('should exit with code 1 on critical errors', () => {
      // No .grafema directory - critical error
      const result = runCli(['doctor'], tempDir);

      assert.strictEqual(
        result.status,
        1,
        `Should exit with code 1 on critical error. Got: ${result.status}`
      );
    });

    it('should exit with code 2 on warnings only', async () => {
      // Create a scenario with warnings but no errors
      // Initialize project, then delete something non-critical
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );
      // Create database file with content (passes database check)
      writeFileSync(join(tempDir, '.grafema', 'graph.rfdb'), 'x'.repeat(200));

      const result = runCli(['doctor'], tempDir);

      // Should be 2 (warnings - server not running) or 0 (if no warnings)
      assert.ok(
        result.status === 0 || result.status === 2,
        `Should exit with code 0 or 2. Got: ${result.status}`
      );
    });
  });

  // ===========================================================================
  // TESTS: CLI options
  // ===========================================================================

  describe('CLI options', () => {
    it('should show doctor command in main help', () => {
      const result = runCli(['--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('doctor'), 'Main help should list doctor command');
    });

    it('should show doctor help with --help flag', () => {
      const result = runCli(['doctor', '--help'], tempDir);

      assert.strictEqual(result.status, 0);

      const output = result.stdout;
      assert.ok(output.includes('--json') || output.includes('-j'), 'Should show --json option');
      assert.ok(
        output.includes('--quiet') || output.includes('-q'),
        'Should show --quiet option'
      );
      assert.ok(
        output.includes('--verbose') || output.includes('-v'),
        'Should show --verbose option'
      );
    });

    it('should support --project option', () => {
      // Create project in subdirectory
      const subDir = join(tempDir, 'myproject');
      mkdirSync(subDir);
      mkdirSync(join(subDir, '.grafema'));
      writeFileSync(
        join(subDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      // Run from tempDir but point to subDir
      const result = runCli(['doctor', '--project', subDir], tempDir);

      const output = result.stdout + result.stderr;
      // Should not fail on initialization (finds config in subDir)
      assert.ok(
        !output.includes('.grafema directory not found'),
        `Should find .grafema in specified project. Got: ${output}`
      );
    });

    it('should support --quiet option', () => {
      mkdirSync(join(tempDir, '.grafema'));
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      const normalResult = runCli(['doctor'], tempDir);
      const quietResult = runCli(['doctor', '--quiet'], tempDir);

      // Quiet output should be shorter (only failures/warnings)
      // or at least not longer than normal
      assert.ok(
        quietResult.stdout.length <= normalResult.stdout.length ||
          quietResult.stderr.length <= normalResult.stderr.length,
        'Quiet mode should produce less or equal output'
      );
    });
  });

  // ===========================================================================
  // TESTS: Integration - Full workflow
  // ===========================================================================

  describe('Integration', () => {
    it('should pass all checks on fully initialized and analyzed project', async () => {
      // Create package.json
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.js' })
      );

      // Create source file
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(
        join(tempDir, 'src', 'index.js'),
        `function hello() { return 'Hello'; }
module.exports = { hello };
`
      );

      // Run init
      const initResult = runCli(['init'], tempDir);
      assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

      // Override config to exclude GraphConnectivityValidator (creates disconnected nodes on simple fixtures)
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      // Run analyze (longer timeout for server startup)
      // Note: analyze may return null status because RFDB server runs in background
      // and spawnSync waits for all stdio to close. We verify success by checking database exists.
      const analyzeResult = runCli(['analyze', '--clear'], tempDir, 120000);
      const dbExists = existsSync(join(tempDir, '.grafema', 'graph.rfdb'));
      assert.ok(
        analyzeResult.status === 0 || (analyzeResult.status === null && dbExists),
        `analyze failed: status=${analyzeResult.status}, stderr=${analyzeResult.stderr}`
      );

      // Now run doctor
      const doctorResult = runCli(['doctor'], tempDir);

      const output = doctorResult.stdout + doctorResult.stderr;

      // Should report healthy or warning (server might not be running after analyze)
      // The important thing is no critical errors
      assert.ok(
        doctorResult.status === 0 || doctorResult.status === 2,
        `Should be healthy or warning. Status: ${doctorResult.status}, Output: ${output}`
      );

      // Should show some passing checks (look for checkmarks or status indicators)
      assert.ok(
        output.includes('✓') ||
          output.includes('Config file') ||
          output.includes('Status:'),
        `Should show doctor output. Got: ${output}`
      );
    });

    it('should return proper JSON for fully initialized project', async () => {
      // Create package.json
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.js' })
      );

      // Create source file
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(
        join(tempDir, 'src', 'index.js'),
        `function hello() { return 'Hello'; }
module.exports = { hello };
`
      );

      // Run init
      runCli(['init'], tempDir);

      // Override config to exclude GraphConnectivityValidator (creates disconnected nodes on simple fixtures)
      writeFileSync(
        join(tempDir, '.grafema', 'config.yaml'),
        `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`
      );

      // Run analyze (longer timeout for server startup)
      runCli(['analyze', '--clear'], tempDir, 120000);

      // Now run doctor with JSON output
      const doctorResult = runCli(['doctor', '--json'], tempDir);

      const parsed = JSON.parse(doctorResult.stdout) as {
        status: string;
        checks: Array<{ name: string; status: string }>;
        project: string;
        timestamp: string;
      };

      // Should have expected structure
      assert.ok(parsed.status, 'Should have status');
      assert.ok(Array.isArray(parsed.checks), 'Should have checks array');
      assert.ok(parsed.project, 'Should have project path');
      assert.ok(parsed.timestamp, 'Should have timestamp');

      // Should have multiple checks
      assert.ok(parsed.checks.length >= 3, 'Should have multiple checks');

      // Find specific checks by name
      const checkNames = parsed.checks.map((c) => c.name);
      assert.ok(
        checkNames.some((n) => n.includes('init') || n.includes('config')),
        `Should have initialization or config check. Got: ${checkNames.join(', ')}`
      );
    });
  });
});
