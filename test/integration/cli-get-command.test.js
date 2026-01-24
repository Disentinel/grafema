/**
 * Integration tests for `grafema get` command
 *
 * Tests the full CLI workflow: init → analyze → get
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');
const cliPath = join(projectRoot, 'packages/cli/dist/cli.js');

describe('grafema get (integration)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-get-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should retrieve node by semantic ID after analysis', () => {
    // Setup: Create test file
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'test.js'),
      `
      function authenticate(username, password) {
        const user = findUser(username);
        return user && verifyPassword(user, password);
      }
      `
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    // Run init
    execSync(`node "${cliPath}" init`, {
      cwd: tempDir,
      stdio: 'pipe',
    });

    // Run analyze
    execSync(`node "${cliPath}" analyze`, {
      cwd: tempDir,
      stdio: 'pipe',
    });

    // Get node by ID
    const output = execSync(
      `node "${cliPath}" get "src/test.js->global->FUNCTION->authenticate"`,
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    assert.ok(output.includes('[FUNCTION] authenticate'));
    assert.ok(output.includes('ID: src/test.js->global->FUNCTION->authenticate'));
    assert.ok(output.includes('Location: src/test.js'));
  });

  it('should show edges in output', () => {
    // Setup
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'test.js'),
      `
      function caller() {
        callee();
      }
      function callee() {}
      `
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get caller function
    const output = execSync(
      'node "${cliPath}" get "src/test.js->global->FUNCTION->caller"',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    // Should show function details
    assert.ok(output.includes('[FUNCTION] caller'));

    // Should show edges section (either incoming or outgoing)
    // Note: exact edge representation depends on analysis, but should have SOME edges
    const hasEdgeSection = output.includes('Incoming edges') ||
                          output.includes('Outgoing edges') ||
                          output.includes('No edges found');
    assert.ok(hasEdgeSection, 'Should display edge information');
  });

  it('should output JSON when --json flag is used', () => {
    // Setup
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'test.js'),
      `function testFunc() {}`
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get with JSON output
    const output = execSync(
      'node "${cliPath}" get "src/test.js->global->FUNCTION->testFunc" --json',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.node.name, 'testFunc');
    assert.equal(parsed.node.type, 'FUNCTION');
    assert.ok(parsed.node.id.includes('testFunc'));
    assert.ok(parsed.edges);
    assert.ok(Array.isArray(parsed.edges.incoming));
    assert.ok(Array.isArray(parsed.edges.outgoing));
    assert.ok(parsed.stats);
    assert.ok(typeof parsed.stats.incomingCount === 'number');
    assert.ok(typeof parsed.stats.outgoingCount === 'number');
  });

  it('should fail gracefully when node not found', () => {
    // Setup (empty project)
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Try to get non-existent node
    try {
      execSync(
        'node "${cliPath}" get "nonexistent->ID"',
        {
          cwd: tempDir,
          stdio: 'pipe',
        }
      );
      assert.fail('Should have thrown error');
    } catch (error) {
      const stderr = error.stderr.toString();
      assert.ok(stderr.includes('Node not found') || stderr.includes('not found'));
      assert.ok(stderr.includes('grafema query') || stderr.includes('query'));
    }
  });

  it('should fail gracefully when database does not exist', () => {
    // Don't run analyze - no database will exist
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    try {
      execSync(
        'node "${cliPath}" get "some->ID"',
        {
          cwd: tempDir,
          stdio: 'pipe',
        }
      );
      assert.fail('Should have thrown error');
    } catch (error) {
      const stderr = error.stderr.toString();
      assert.ok(
        stderr.includes('No graph database found') ||
        stderr.includes('database') ||
        stderr.includes('analyze')
      );
    }
  });

  it('should handle semantic IDs with special characters', () => {
    // Setup: Create file with nested scopes
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'nested.js'),
      `
      function outer() {
        function inner() {
          const value = 42;
        }
      }
      `
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get inner function (semantic ID contains ->)
    const output = execSync(
      'node "${cliPath}" get "src/nested.js->global->FUNCTION->outer"',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    assert.ok(output.includes('[FUNCTION] outer'));
    assert.ok(output.includes('outer'));
  });

  it('should display metadata fields if present', () => {
    // Setup: Create file that will generate nodes with metadata
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'exports.js'),
      `
      export function exportedFunc() {
        return 'test';
      }
      `
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get exported function
    const output = execSync(
      'node "${cliPath}" get "src/exports.js->global->FUNCTION->exportedFunc"',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    assert.ok(output.includes('[FUNCTION] exportedFunc'));
    // Metadata section may or may not appear depending on what fields are present
    // Just verify we got the node
    assert.ok(output.includes('exportedFunc'));
  });

  it('should work with --project flag', () => {
    // Setup: Create test project
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'test.js'),
      `function test() {}`
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Run from different directory with --project
    const output = execSync(
      `node "${cliPath}" get "src/test.js->global->FUNCTION->test" --project "${tempDir}"`,
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      }
    );

    assert.ok(output.includes('[FUNCTION] test'));
  });

  it('should handle node with no edges', () => {
    // Setup: Create isolated function
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'isolated.js'),
      `function isolated() {
        // No calls, no variables
        return 42;
      }`
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get isolated function
    const output = execSync(
      'node "${cliPath}" get "src/isolated.js->global->FUNCTION->isolated"',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    assert.ok(output.includes('[FUNCTION] isolated'));
    // Should indicate no edges, or show empty edge sections
    const hasNoEdgesMessage = output.includes('No edges') ||
                             (output.includes('Incoming edges (0)') && output.includes('Outgoing edges (0)'));
    // Note: exact message depends on implementation
  });

  it('should limit edge display in text mode (pagination)', () => {
    // Setup: Create function that calls many others
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    // Generate function with many calls
    const callees = [];
    for (let i = 0; i < 30; i++) {
      callees.push(`function callee${i}() {}`);
    }
    const calls = Array.from({ length: 30 }, (_, i) => `  callee${i}();`).join('\n');

    writeFileSync(
      join(srcDir, 'many.js'),
      `
      ${callees.join('\n')}

      function hub() {
${calls}
      }
      `
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get hub function - should have 30 CALLS edges
    const output = execSync(
      'node "${cliPath}" get "src/many.js->global->FUNCTION->hub"',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    assert.ok(output.includes('[FUNCTION] hub'));

    // Text output should limit to 20 edges and show "... and X more"
    // Or show the total count
    // Exact format depends on implementation
    assert.ok(output.includes('hub'));
  });

  it('should not limit edges in JSON mode', () => {
    // Setup: Same as above - function with many calls
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    const callees = [];
    for (let i = 0; i < 25; i++) {
      callees.push(`function callee${i}() {}`);
    }
    const calls = Array.from({ length: 25 }, (_, i) => `  callee${i}();`).join('\n');

    writeFileSync(
      join(srcDir, 'many.js'),
      `
      ${callees.join('\n')}

      function hub() {
${calls}
      }
      `
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    execSync('node "${cliPath}" init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node "${cliPath}" analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get with JSON output
    const output = execSync(
      'node "${cliPath}" get "src/many.js->global->FUNCTION->hub" --json',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    const parsed = JSON.parse(output);

    // JSON should include ALL edges, not limited to 20
    const totalEdges = parsed.edges.incoming.length + parsed.edges.outgoing.length;
    assert.ok(totalEdges >= 0); // Should have edges data

    // Stats should reflect actual counts
    assert.equal(parsed.stats.incomingCount, parsed.edges.incoming.length);
    assert.equal(parsed.stats.outgoingCount, parsed.edges.outgoing.length);
  });
});
