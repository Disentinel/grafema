/**
 * Tests for `grafema query` HTTP requests functionality - REG-249
 *
 * Tests HTTP request (fetch/axios) searching functionality:
 * - Type aliases (request, fetch, api)
 * - Method matching (GET, POST)
 * - URL matching (/api/users)
 * - Combined method+url matching (GET /api/users)
 * - Display formatting
 * - JSON output with method/url fields
 * - No results case
 * - General search includes requests
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
// TESTS: grafema query - HTTP requests
// =============================================================================

describe('grafema query - HTTP requests', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-query-requests-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to set up a test project with fetch/axios calls
   */
  async function setupFetchProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    // Create file with fetch/axios calls
    writeFileSync(
      join(srcDir, 'api.js'),
      `
// Using fetch API
async function fetchUsers() {
  const response = await fetch('/api/users');
  return response.json();
}

async function createUser(data) {
  const response = await fetch('/api/users', {
    method: 'POST',
    body: JSON.stringify(data)
  });
  return response.json();
}

// Using axios
const axios = require('axios');

async function getInvitations() {
  const response = await axios.get('/api/invitations');
  return response.data;
}

async function sendInvitation(data) {
  const response = await axios.post('/api/invitations', data);
  return response.data;
}

// Function that has "fetch" in its name (should NOT match HTTP request search)
function fetchConfig() {
  return { apiUrl: '/api' };
}

module.exports = { fetchUsers, createUser, getInvitations, sendInvitation, fetchConfig };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-fetch', version: '1.0.0', main: 'src/api.js' })
    );

    // Run init and analyze
    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  // ===========================================================================
  // TESTS: Type aliases (request, fetch, api)
  // ===========================================================================

  describe('type aliases', () => {
    it('should find requests with "request" alias', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'request /api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('/api') || result.stdout.includes('http:request'),
        `Should find requests with /api. Got: ${result.stdout}`
      );
    });

    it('should find requests with "fetch" alias', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'fetch /api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('/api') || result.stdout.includes('http:request'),
        `Should find requests with /api. Got: ${result.stdout}`
      );
    });

    it('should find requests with "api" alias', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'api /users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('/users') || result.stdout.includes('http:request'),
        `Should find requests with /users. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: URL matching
  // ===========================================================================

  describe('URL matching', () => {
    it('should find requests by partial URL', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'request /users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('/users') || result.stdout.includes('http:request'),
        `Should find /users requests. Got: ${result.stdout}`
      );
    });

    it('should find requests by URL prefix', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'request /api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should find multiple requests under /api
      assert.ok(
        result.stdout.includes('/api') || result.stdout.includes('http:request'),
        `Should find /api requests. Got: ${result.stdout}`
      );
    });

    it('should find requests for invitations', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'request invitations'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('invitations') || result.stdout.includes('http:request'),
        `Should find invitations requests. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Display formatting
  // ===========================================================================

  describe('display formatting', () => {
    it('should display requests as [http:request] METHOD URL', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'request /api/users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Check format: [http:request] GET /api/users or similar
      assert.ok(
        result.stdout.includes('[http:request]') ||
        result.stdout.includes('http:request'),
        `Should display with [http:request] type. Got: ${result.stdout}`
      );
    });

    it('should include location in request display', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'request /api/users'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should show file location
      assert.ok(
        result.stdout.includes('src/api.js') || result.stdout.includes('Location'),
        `Should show file path. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: JSON output
  // ===========================================================================

  describe('JSON output', () => {
    it('should include method and url in JSON output', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'request /api/users', '--json'], tempDir);

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

      // If we have results, check they have method and url
      if (parsed.length > 0) {
        const request = parsed[0] as { method?: string; url?: string };
        assert.ok(request.method, `Should have method field. Got: ${JSON.stringify(request)}`);
        assert.ok(request.url, `Should have url field. Got: ${JSON.stringify(request)}`);
        assert.ok(
          ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method?.toUpperCase() || ''),
          `Method should be HTTP method. Got: ${request.method}`
        );
      }
    });
  });

  // ===========================================================================
  // TESTS: No results case
  // ===========================================================================

  describe('no results', () => {
    it('should handle no matching requests gracefully', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'request /nonexistent/path'], tempDir);

      assert.strictEqual(result.status, 0, 'Should exit with code 0');
      assert.ok(
        result.stdout.includes('No results') || result.stdout.includes('No'),
        `Should show no results message. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: General search includes requests
  // ===========================================================================

  describe('general search includes requests', () => {
    it('should find requests when searching without type specifier', async () => {
      await setupFetchProject();

      const result = runCli(['query', '/api/invitations'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should find http:request nodes in general search
      assert.ok(
        result.stdout.includes('http:request') || result.stdout.includes('/api/invitations'),
        `Should find HTTP requests in general search. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Request search should NOT match functions (similar to routes test)
  // ===========================================================================

  describe('request search isolation', () => {
    /**
     * Searching for requests should NOT match a function named "fetchConfig"
     */
    it('should NOT match function named "fetchConfig" when searching for HTTP requests', async () => {
      await setupFetchProject();

      // Search for requests specifically
      const result = runCli(['query', 'request /api', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      const output = result.stdout;

      // Should NOT include fetchConfig function
      assert.ok(
        !output.includes('"name":"fetchConfig"'),
        `Should NOT match fetchConfig function when searching for requests. Got: ${output}`
      );
    });

    /**
     * But general function search should still find fetchConfig
     */
    it('should find fetchConfig when searching for functions', async () => {
      await setupFetchProject();

      const result = runCli(['query', 'function fetchConfig'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      // Function search should still find fetchConfig
      assert.ok(
        result.stdout.includes('fetchConfig') || result.stdout.includes('FUNCTION'),
        `Function search should find fetchConfig. Got: ${result.stdout}`
      );
    });
  });
});
