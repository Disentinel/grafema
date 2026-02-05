/**
 * Tests for `grafema explain` command - REG-177
 *
 * Tests the CLI command that shows what nodes exist in a file.
 * Purpose: Help users discover graph contents and semantic IDs for querying.
 *
 * Tests:
 * - Shows help with --help flag
 * - Supports --json option for JSON output
 * - Shows error for non-existent file
 * - Shows NOT_ANALYZED status for unanalyzed file
 * - Shows node list with semantic IDs for analyzed file
 * - Annotates scope context (try/catch/if)
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
// TESTS: grafema explain command
// =============================================================================

describe('grafema explain command', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-explain-test-'));
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

    // Create a file with try/catch to test scope detection
    writeFileSync(
      join(srcDir, 'app.js'),
      `
async function fetchData() {
  try {
    const response = await fetch('/api/data');
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function processData(input) {
  if (input) {
    const result = transform(input);
    return result;
  }
  return null;
}

class DataService {
  constructor() {
    this.cache = new Map();
  }

  getData(key) {
    return this.cache.get(key);
  }
}

module.exports = { fetchData, processData, DataService };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-explain', version: '1.0.0', main: 'src/app.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  // ===========================================================================
  // TESTS: Help and basic usage
  // ===========================================================================

  describe('help and basic usage', () => {
    it('should show help with --help flag', async () => {
      const result = runCli(['explain', '--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(
        result.stdout.includes('explain') || result.stdout.includes('Explain'),
        'Should mention explain command'
      );
      assert.ok(
        result.stdout.includes('file') || result.stdout.includes('FILE'),
        'Should mention file argument'
      );
    });

    it('should show error when no file argument provided', async () => {
      await setupTestProject();

      const result = runCli(['explain'], tempDir);

      // Should show usage error or help
      assert.ok(
        result.status !== 0 || result.stderr.includes('required') || result.stdout.includes('Usage'),
        'Should indicate file argument is required'
      );
    });

    it('should be listed in main help', async () => {
      const result = runCli(['--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(
        result.stdout.includes('explain'),
        'Main help should list explain command'
      );
    });
  });

  // ===========================================================================
  // TESTS: File not found
  // ===========================================================================

  describe('error handling - file not found', () => {
    it('should show error for non-existent file', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'nonexistent/file.js'], tempDir);

      assert.strictEqual(result.status, 1, 'Should exit with error code');
      assert.ok(
        result.stderr.includes('not found') ||
        result.stderr.includes('does not exist') ||
        result.stderr.includes('No such file'),
        `Should indicate file not found. Got: ${result.stderr}`
      );
    });
  });

  // ===========================================================================
  // TESTS: NOT_ANALYZED status
  // ===========================================================================

  describe('NOT_ANALYZED status', () => {
    it('should show NOT_ANALYZED for file not in graph', async () => {
      await setupTestProject();

      // Create a new file after analysis
      const newFile = join(tempDir, 'src', 'new-file.js');
      writeFileSync(newFile, 'export const x = 1;');

      const result = runCli(['explain', 'src/new-file.js'], tempDir);

      assert.strictEqual(result.status, 0, 'Should not error for unanalyzed file');
      assert.ok(
        result.stdout.includes('NOT_ANALYZED') || result.stdout.includes('not analyzed'),
        `Should indicate file is not analyzed. Got: ${result.stdout}`
      );
    });

    it('should suggest running analyze for unanalyzed file', async () => {
      await setupTestProject();

      const newFile = join(tempDir, 'src', 'untracked.js');
      writeFileSync(newFile, 'const y = 2;');

      const result = runCli(['explain', 'src/untracked.js'], tempDir);

      assert.ok(
        result.stdout.includes('analyze') || result.stdout.includes('grafema analyze'),
        'Should suggest running grafema analyze'
      );
    });
  });

  // ===========================================================================
  // TESTS: Analyzed file - node listing
  // ===========================================================================

  describe('analyzed file - node listing', () => {
    it('should show node list for analyzed file', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js'], tempDir);

      assert.strictEqual(result.status, 0, `explain failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('ANALYZED') || result.stdout.includes('analyzed'),
        'Should show ANALYZED status'
      );
      assert.ok(
        result.stdout.includes('fetchData'),
        'Should list fetchData function'
      );
    });

    it('should display semantic IDs for querying', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js'], tempDir);

      assert.strictEqual(result.status, 0);
      // Semantic IDs use -> separator
      assert.ok(
        result.stdout.includes('->'),
        'Should display semantic IDs with -> separator'
      );
      // Should show FUNCTION or function type
      assert.ok(
        result.stdout.includes('FUNCTION') || result.stdout.includes('[FUNCTION]'),
        'Should display node types'
      );
    });

    it('should show node count', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js'], tempDir);

      assert.strictEqual(result.status, 0);
      // Should mention number of nodes
      assert.ok(
        result.stdout.match(/\d+\s*(nodes?|Nodes?)/i) ||
        result.stdout.includes('Nodes in graph:') ||
        result.stdout.includes('Total:'),
        `Should display node count. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Scope context annotations
  // ===========================================================================

  describe('scope context annotations', () => {
    it('should annotate variables in try blocks', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js'], tempDir);

      assert.strictEqual(result.status, 0);
      // The 'response' and 'data' variables are inside try block
      // Output should indicate this somehow
      const hasTryAnnotation =
        result.stdout.includes('try') ||
        result.stdout.includes('try#') ||
        result.stdout.includes('inside try');

      assert.ok(
        hasTryAnnotation,
        `Should show try block context in output. Got: ${result.stdout}`
      );
    });

    it('should annotate variables in catch blocks', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js'], tempDir);

      assert.strictEqual(result.status, 0);
      // The 'error' variable is a catch parameter
      const hasCatchAnnotation =
        result.stdout.includes('catch') ||
        result.stdout.includes('catch#') ||
        result.stdout.includes('catch parameter');

      assert.ok(
        hasCatchAnnotation,
        `Should show catch block context in output. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // TESTS: JSON output
  // ===========================================================================

  describe('JSON output', () => {
    it('should output valid JSON with --json flag', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `explain --json failed: ${result.stderr}`);

      // Find JSON in output
      const jsonStart = result.stdout.indexOf('{');
      const jsonEnd = result.stdout.lastIndexOf('}');

      assert.ok(
        jsonStart !== -1 && jsonEnd > jsonStart,
        `Should contain JSON object. Got: ${result.stdout}`
      );

      const jsonStr = result.stdout.slice(jsonStart, jsonEnd + 1);
      let parsed: { file?: string; status?: string; nodes?: unknown[]; totalCount?: number };
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        assert.fail(`Invalid JSON output: ${jsonStr}`);
      }

      // Verify JSON structure
      assert.ok(typeof parsed.file === 'string', 'JSON should have file field');
      assert.ok(typeof parsed.status === 'string', 'JSON should have status field');
      assert.ok(Array.isArray(parsed.nodes), 'JSON should have nodes array');
      assert.ok(typeof parsed.totalCount === 'number', 'JSON should have totalCount');
    });

    it('should include semantic IDs in JSON output', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js', '--json'], tempDir);

      assert.strictEqual(result.status, 0);

      const jsonStart = result.stdout.indexOf('{');
      const jsonEnd = result.stdout.lastIndexOf('}');
      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));

      assert.ok(parsed.nodes.length > 0, 'Should have nodes');

      // Each node should have an id (semantic ID)
      const firstNode = parsed.nodes[0];
      assert.ok(typeof firstNode.id === 'string', 'Node should have id');
      assert.ok(firstNode.id.includes('->'), 'ID should be semantic ID format');
    });

    it('should include byType grouping in JSON output', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js', '--json'], tempDir);

      const jsonStart = result.stdout.indexOf('{');
      const jsonEnd = result.stdout.lastIndexOf('}');
      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));

      assert.ok(
        typeof parsed.byType === 'object',
        'JSON should have byType grouping'
      );
    });
  });

  // ===========================================================================
  // TESTS: Integration with query command
  // ===========================================================================

  describe('integration with query command', () => {
    it('should display IDs that can be used with query command', async () => {
      await setupTestProject();

      // First, get the explain output
      const explainResult = runCli(['explain', 'src/app.js', '--json'], tempDir);
      assert.strictEqual(explainResult.status, 0);

      const jsonStart = explainResult.stdout.indexOf('{');
      const jsonEnd = explainResult.stdout.lastIndexOf('}');
      const parsed = JSON.parse(explainResult.stdout.slice(jsonStart, jsonEnd + 1));

      // Find fetchData function node
      const fetchDataNode = parsed.nodes.find(
        (n: { name: string; type: string }) => n.name === 'fetchData' && n.type === 'FUNCTION'
      );
      assert.ok(fetchDataNode, 'Should find fetchData in explain output');

      // The semantic ID should be usable in queries
      // (This verifies the explain output matches query expectations)
      const semanticId = fetchDataNode.id;
      assert.ok(
        semanticId.includes('fetchData'),
        'Semantic ID should contain function name'
      );
      assert.ok(
        semanticId.includes('FUNCTION'),
        'Semantic ID should contain type'
      );
    });
  });

  // ===========================================================================
  // TESTS: Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle file with no functions or classes', async () => {
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(join(srcDir, 'constants.js'), 'module.exports = { A: 1, B: 2 };');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-explain', version: '1.0.0', main: 'src/constants.js' })
      );

      runCli(['init'], tempDir);
      runCli(['analyze', '--auto-start'], tempDir);

      const result = runCli(['explain', 'src/constants.js'], tempDir);

      // Should not error, even if file has minimal structure
      assert.ok(result.status === 0 || result.stdout.includes('ANALYZED'));
    });

    it('should handle relative file paths', async () => {
      await setupTestProject();

      // Test with relative path
      const result = runCli(['explain', './src/app.js'], tempDir);

      // Should work with relative paths
      assert.strictEqual(result.status, 0, 'Should handle relative paths');
    });

    it('should handle absolute file paths', async () => {
      await setupTestProject();

      // Test with absolute path
      const absolutePath = join(tempDir, 'src', 'app.js');
      const result = runCli(['explain', absolutePath], tempDir);

      // Should work with absolute paths
      assert.strictEqual(result.status, 0, `Should handle absolute paths. Error: ${result.stderr}`);
    });

    it('should error gracefully when no database exists', async () => {
      mkdirSync(join(tempDir, 'empty'));
      writeFileSync(join(tempDir, 'empty', 'file.js'), 'const x = 1;');

      const result = runCli(['explain', 'file.js'], join(tempDir, 'empty'));

      assert.strictEqual(result.status, 1, 'Should error without database');
      assert.ok(
        result.stderr.includes('database') ||
        result.stderr.includes('No graph') ||
        result.stderr.includes('not initialized'),
        'Should mention missing database'
      );
    });
  });

  // ===========================================================================
  // TESTS: Real-world scenario from REG-177
  // ===========================================================================

  describe('real-world scenario: finding variables in try/catch', () => {
    it('should help user find response variable in try block', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js'], tempDir);

      assert.strictEqual(result.status, 0);

      // The user's problem: couldn't find 'response' variable
      // explain should show it with its semantic ID

      // Should list the variable
      assert.ok(
        result.stdout.includes('response'),
        'Should show response variable'
      );

      // Should show the scope context
      const showsScopeInfo =
        result.stdout.includes('try') ||
        result.stdout.includes('fetchData->try');

      assert.ok(
        showsScopeInfo,
        `Should indicate response is inside try block. Got: ${result.stdout}`
      );
    });

    it('should show query examples or hints', async () => {
      await setupTestProject();

      const result = runCli(['explain', 'src/app.js'], tempDir);

      // Should help users understand how to query
      const hasQueryHint =
        result.stdout.includes('query') ||
        result.stdout.includes('grafema query') ||
        result.stdout.includes('To query') ||
        result.stdout.includes('ID:'); // Showing IDs is implicit query hint

      assert.ok(
        hasQueryHint,
        'Should provide some guidance on querying'
      );
    });
  });
});
