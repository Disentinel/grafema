/**
 * Tests for `grafema query` HTTP routes functionality - REG-207
 *
 * Tests HTTP route searching functionality:
 * - Type aliases (route, endpoint, http)
 * - Method matching (GET, POST, DELETE)
 * - Path matching (/api, /users)
 * - Combined method+path matching (GET /api/users)
 * - Display formatting
 * - JSON output with method/path fields
 * - No results case
 * - General search includes routes
 * - Method search does NOT match functions with similar names
 *
 * Based on:
 * - Joel's tech plan: _tasks/2025-01-25-reg-207-http-routes-query/003-joel-tech-plan.md
 * - Linus review: _tasks/2025-01-25-reg-207-http-routes-query/004-linus-plan-review.md
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
// TESTS: grafema query - HTTP routes
// =============================================================================

describe('grafema query - HTTP routes', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-query-routes-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to set up a test Express project with HTTP routes
   */
  async function setupExpressProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    // Create Express app with routes
    writeFileSync(
      join(srcDir, 'app.js'),
      `
const express = require('express');
const app = express();

// GET endpoints
app.get('/api/users', (req, res) => {
  res.json([]);
});

app.get('/api/posts', (req, res) => {
  res.json([]);
});

// POST endpoint
app.post('/api/users', (req, res) => {
  res.json({ created: true });
});

// DELETE endpoint
app.delete('/api/users/:id', (req, res) => {
  res.json({ deleted: true });
});

// Function that has "post" in its name (should NOT match HTTP POST search)
function postMessage(text) {
  console.log('Posted:', text);
}

// Another function with "get" in name
function getMessage() {
  return 'hello';
}

module.exports = { app, postMessage, getMessage };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-express', version: '1.0.0', main: 'src/app.js' })
    );

    // Run init and analyze
    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  // ===========================================================================
  // TESTS: Type aliases (route, endpoint, http)
  // ===========================================================================

  describe('type aliases', () => {
    it('should find routes with "route" alias', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route /api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] METHOD PATH
      assert.ok(
        result.stdout.includes('[http:route]') && result.stdout.includes('/api'),
        `Should display as [http:route] METHOD /api. Got: ${result.stdout}`
      );
    });

    it('should find routes with "endpoint" alias', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'endpoint /api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] METHOD PATH
      assert.ok(
        result.stdout.includes('[http:route]') && result.stdout.includes('/api'),
        `Should display as [http:route] METHOD /api. Got: ${result.stdout}`
      );
    });

    it('should find routes with "http" alias', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'http /users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] METHOD PATH
      assert.ok(
        result.stdout.includes('[http:route]') && result.stdout.includes('/users'),
        `Should display as [http:route] METHOD /users. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Method matching (GET, POST, DELETE)
  // ===========================================================================

  describe('method matching', () => {
    it('should find all POST endpoints when searching "POST"', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route POST'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] POST PATH
      assert.ok(
        result.stdout.includes('[http:route] POST'),
        `Should display as [http:route] POST /path. Got: ${result.stdout}`
      );
    });

    it('should find all GET endpoints when searching "GET"', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route GET'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] GET PATH
      assert.ok(
        result.stdout.includes('[http:route] GET'),
        `Should display as [http:route] GET /path. Got: ${result.stdout}`
      );
    });

    it('should find DELETE endpoints', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route DELETE'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] DELETE PATH
      assert.ok(
        result.stdout.includes('[http:route] DELETE'),
        `Should display as [http:route] DELETE /path. Got: ${result.stdout}`
      );
    });

    it('should be case-insensitive for method search', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route post'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] POST PATH (even with lowercase input)
      assert.ok(
        result.stdout.includes('[http:route] POST'),
        `Should display as [http:route] POST /path. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Path matching
  // ===========================================================================

  describe('path matching', () => {
    it('should find routes by partial path', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route /users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] METHOD /users...
      assert.ok(
        result.stdout.includes('[http:route]') && result.stdout.includes('/users'),
        `Should display as [http:route] METHOD /users. Got: ${result.stdout}`
      );
    });

    it('should find routes by path prefix', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route /api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] METHOD /api...
      assert.ok(
        result.stdout.includes('[http:route]') && result.stdout.includes('/api'),
        `Should display as [http:route] METHOD /api... Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Combined method + path
  // ===========================================================================

  describe('combined method and path', () => {
    it('should find specific GET /api/users combination', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route GET /api/users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] GET /api/users
      assert.ok(
        result.stdout.includes('[http:route] GET /api/users'),
        `Should display as [http:route] GET /api/users. Got: ${result.stdout}`
      );
    });

    it('should find POST /api/users specifically', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route POST /api/users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] POST /api/users
      assert.ok(
        result.stdout.includes('[http:route] POST /api/users'),
        `Should display as [http:route] POST /api/users. Got: ${result.stdout}`
      );
    });

    it('should NOT return POST routes when searching for GET /api/users', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route GET /api/users', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      // Parse JSON output to verify only GET routes are returned
      const jsonStart = result.stdout.indexOf('[');
      const jsonEnd = result.stdout.lastIndexOf(']');

      if (jsonStart === -1 || jsonEnd <= jsonStart) {
        assert.fail(`Should have JSON array output. Got: ${result.stdout}`);
      }

      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
      assert.ok(Array.isArray(parsed), 'Should be valid JSON array');

      // If we have results, verify they are all GET
      if (parsed.length > 0) {
        const hasPost = parsed.some((r: { method?: string }) =>
          r.method?.toUpperCase() === 'POST'
        );
        assert.ok(
          !hasPost,
          'Should NOT include POST routes when searching for GET'
        );
      }
    });
  });

  // ===========================================================================
  // TESTS: Display formatting
  // ===========================================================================

  describe('display formatting', () => {
    it('should display routes as [http:route] METHOD PATH', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route /api/users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify output format: [http:route] METHOD PATH
      assert.ok(
        result.stdout.includes('[http:route]') && result.stdout.includes('/api/users'),
        `Should display as [http:route] METHOD /api/users. Got: ${result.stdout}`
      );
    });

    it('should include location in route display', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route /api/users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify location line: Location: src/app.js:LINE
      assert.ok(
        result.stdout.includes('Location:') && result.stdout.includes('src/app.js'),
        `Should display Location: src/app.js:LINE. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: JSON output
  // ===========================================================================

  describe('JSON output', () => {
    it('should include method and path in JSON output', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route /api/users', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      // Find JSON array in output
      const jsonStart = result.stdout.indexOf('[');
      const jsonEnd = result.stdout.lastIndexOf(']');

      if (jsonStart === -1 || jsonEnd <= jsonStart) {
        // No JSON output yet - feature not implemented, test should fail
        assert.fail(`Should have JSON array output. Got: ${result.stdout}`);
      }

      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
      assert.ok(Array.isArray(parsed), 'Should be array');

      // If we have results, check they have method and path
      if (parsed.length > 0) {
        const route = parsed[0] as { method?: string; path?: string };
        assert.ok(route.method, `Should have method field. Got: ${JSON.stringify(route)}`);
        assert.ok(route.path, `Should have path field. Got: ${JSON.stringify(route)}`);
        assert.ok(
          ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(route.method?.toUpperCase() || ''),
          `Method should be HTTP method. Got: ${route.method}`
        );
      }
    });
  });

  // ===========================================================================
  // TESTS: No results case
  // ===========================================================================

  describe('no results', () => {
    it('should handle no matching routes gracefully', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route PUT /nonexistent'], tempDir);

      assert.strictEqual(result.status, 0, 'Should exit with code 0');
      // Verify "No results" message and absence of route output
      assert.ok(
        result.stdout.includes('No results') && !result.stdout.includes('[http:route]'),
        `Should show "No results" message. Got: ${result.stdout}`
      );
    });

    it('should handle searching for non-existent method', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route PATCH'], tempDir);

      // Should not crash
      assert.strictEqual(result.status, 0, 'Should exit with code 0');
    });
  });

  // ===========================================================================
  // TESTS: General search includes routes
  // ===========================================================================

  describe('general search includes routes', () => {
    it('should find routes when searching without type specifier', async () => {
      await setupExpressProject();

      const result = runCli(['query', '/api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Verify http:route nodes appear in general search with proper format
      assert.ok(
        result.stdout.includes('[http:route]') && result.stdout.includes('/api'),
        `Should display as [http:route] METHOD /api in general search. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Method search should NOT match functions (Linus requirement)
  // ===========================================================================

  describe('method search isolation', () => {
    /**
     * CRITICAL TEST (from Linus review):
     * Searching for HTTP method "POST" should NOT match a function named "postMessage"
     */
    it('should NOT match function named "postMessage" when searching for HTTP POST', async () => {
      await setupExpressProject();

      // Search for POST routes specifically
      const result = runCli(['query', 'route POST', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      const output = result.stdout;

      // Should NOT include postMessage function
      assert.ok(
        !output.includes('postMessage'),
        `Should NOT match postMessage function when searching for POST routes. Got: ${output}`
      );

      // Parse JSON output to verify no functions matched
      const jsonStart = output.indexOf('[');
      const jsonEnd = output.lastIndexOf(']');

      if (jsonStart === -1 || jsonEnd <= jsonStart) {
        assert.fail(`Should have JSON array output. Got: ${output}`);
      }

      const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
      assert.ok(Array.isArray(parsed), 'Should be valid JSON array');

      // Verify none of the results are the postMessage function
      if (parsed.length > 0) {
        const hasPostMessageFunc = parsed.some(
          (r: { name?: string; type?: string }) =>
            r.name === 'postMessage' && r.type === 'FUNCTION'
        );
        assert.ok(
          !hasPostMessageFunc,
          'Results should not include postMessage function'
        );
      }
    });

    /**
     * Similarly, "GET" search should not match "getMessage" function
     */
    it('should NOT match function named "getMessage" when searching for HTTP GET', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'route GET', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      const output = result.stdout;

      // Should NOT include getMessage function
      assert.ok(
        !output.includes('getMessage'),
        `Should NOT match getMessage function when searching for GET routes. Got: ${output}`
      );
    });

    /**
     * But general function search should still find postMessage
     */
    it('should find postMessage when searching for functions', async () => {
      await setupExpressProject();

      const result = runCli(['query', 'function postMessage'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      // Verify function output format: [FUNCTION] postMessage
      assert.ok(
        result.stdout.includes('[FUNCTION] postMessage'),
        `Should display as [FUNCTION] postMessage. Got: ${result.stdout}`
      );
    });
  });
});
