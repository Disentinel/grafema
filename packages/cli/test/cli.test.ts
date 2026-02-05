/**
 * CLI Tests
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const cliPath = join(__dirname, '../dist/cli.js');
const fixturesDir = join(__dirname, 'fixtures');
const testProjectDir = join(fixturesDir, 'test-project');

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [cliPath, ...args], {
      cwd: testProjectDir,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`spawn error: ${err.message}, cwd: ${testProjectDir}, exists: ${existsSync(testProjectDir)}`));
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

describe('CLI', () => {
  before(() => {
    // Create test fixtures
    if (existsSync(fixturesDir)) {
      rmSync(fixturesDir, { recursive: true });
    }
    mkdirSync(testProjectDir, { recursive: true });

    // Create a simple test file
    writeFileSync(
      join(testProjectDir, 'index.js'),
      `
function hello() {
  console.log('hello');
}

module.exports = { hello };
`
    );
  });

  after(() => {
    // Clean up
    if (existsSync(fixturesDir)) {
      rmSync(fixturesDir, { recursive: true });
    }
  });

  describe('--help', () => {
    it('should show help', async () => {
      const { stdout, code } = await runCli(['--help']);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('Grafema code analysis CLI'));
      assert.ok(stdout.includes('analyze'));
      assert.ok(stdout.includes('query'));
      assert.ok(stdout.includes('stats'));
      assert.ok(stdout.includes('check'));
    });
  });

  describe('analyze', () => {
    it('should show analyze help', async () => {
      const { stdout, code } = await runCli(['analyze', '--help']);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('Run project analysis'));
    });
  });

  describe('stats', () => {
    it('should show stats help', async () => {
      const { stdout, code } = await runCli(['stats', '--help']);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('Show project statistics'));
    });

    it('should error when no database exists', async () => {
      const { stderr, code } = await runCli(['stats']);
      assert.strictEqual(code, 1);
      assert.ok(stderr.includes('No database found'));
    });
  });

  describe('query', () => {
    it('should show query help', async () => {
      const { stdout, code } = await runCli(['query', '--help']);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('Execute a Datalog query'));
    });

    it('should error when no database exists', async () => {
      const { stderr, code } = await runCli(['query', 'node(X, _, _, _, _)']);
      assert.strictEqual(code, 1);
      assert.ok(stderr.includes('No database found'));
    });
  });

  describe('check', () => {
    it('should show check help', async () => {
      const { stdout, code } = await runCli(['check', '--help']);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('Check invariants'));
    });

    it('should error when no database exists', async () => {
      const { stderr, code } = await runCli(['check']);
      assert.strictEqual(code, 1);
      assert.ok(stderr.includes('No database found'));
    });
  });

  describe('init', () => {
    const initTestDir = join(fixturesDir, 'init-test');

    before(() => {
      if (existsSync(initTestDir)) {
        rmSync(initTestDir, { recursive: true });
      }
      mkdirSync(initTestDir, { recursive: true });
      writeFileSync(join(initTestDir, 'package.json'), '{"name":"init-test"}');
    });

    after(() => {
      if (existsSync(initTestDir)) {
        rmSync(initTestDir, { recursive: true });
      }
    });

    function runInitCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
      return new Promise((resolve, reject) => {
        const proc = spawn('node', [cliPath, ...args], {
          cwd: initTestDir,
          env: { ...process.env, NO_COLOR: '1' },
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ stdout, stderr, code }));
      });
    }

    it('should show init help with --yes flag', async () => {
      const { stdout, code } = await runInitCli(['init', '--help']);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('Initialize Grafema'), 'help should describe init');
      assert.ok(stdout.includes('-y, --yes'), 'help should show --yes flag');
    });

    it('should show next steps after init', async () => {
      // Clean up from previous run
      if (existsSync(join(initTestDir, '.grafema'))) {
        rmSync(join(initTestDir, '.grafema'), { recursive: true });
      }

      const { stdout, code } = await runInitCli(['init', '--yes']);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('Created .grafema/config.yaml'), 'should confirm config creation');
      assert.ok(stdout.includes('Next steps:'), 'should show next steps header');
      assert.ok(stdout.includes('Review config:'), 'should show review config step');
      assert.ok(stdout.includes('Build graph:'), 'should show build graph step');
      assert.ok(stdout.includes('grafema analyze'), 'should mention analyze command');
      assert.ok(stdout.includes('grafema overview'), 'should mention overview command');
    });

    it('should show next steps when already initialized', async () => {
      // Run init again without --force
      const { stdout, code } = await runInitCli(['init', '--yes']);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('already initialized'), 'should indicate already initialized');
      assert.ok(stdout.includes('Next steps:'), 'should still show next steps');
      assert.ok(stdout.includes('grafema analyze'), 'should still mention analyze');
    });

    it('should skip prompt with --yes flag (non-interactive mode)', async () => {
      // Clean up for fresh init
      if (existsSync(join(initTestDir, '.grafema'))) {
        rmSync(join(initTestDir, '.grafema'), { recursive: true });
      }

      const { stdout, code } = await runInitCli(['init', '--yes']);
      assert.strictEqual(code, 0);
      // If prompt was shown, process would hang. Success means prompt was skipped.
      assert.ok(!stdout.includes('Run analysis now?'), 'should not show prompt with --yes');
    });
  });
});

/**
 * E2E Workflow Tests
 *
 * Tests the complete happy path: init → analyze → query
 * Uses isolated temp directory per test run.
 */
describe('E2E Workflow', { timeout: 60000 }, () => {
  const e2eDir = join(fixturesDir, 'e2e-project');

  function runCliInDir(dir: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', [cliPath, ...args], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1' },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        reject(new Error(`spawn error: ${err.message}, cwd: ${dir}, exists: ${existsSync(dir)}`));
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, code });
      });
    });
  }

  before(() => {
    // Clean up any previous run
    if (existsSync(e2eDir)) {
      rmSync(e2eDir, { recursive: true });
    }
    mkdirSync(e2eDir, { recursive: true });

    // Create package.json (required by init)
    // Note: main field points to src/index.js since that's where our test file is
    writeFileSync(
      join(e2eDir, 'package.json'),
      JSON.stringify({ name: 'e2e-test-project', version: '1.0.0', main: 'src/index.js' }, null, 2)
    );

    // Create src directory
    mkdirSync(join(e2eDir, 'src'), { recursive: true });

    // Create simple JS file with functions
    writeFileSync(
      join(e2eDir, 'src', 'index.js'),
      `
function hello() {
  console.log('Hello, world!');
}

function greet(name) {
  console.log('Hello, ' + name);
}

module.exports = { hello, greet };
`
    );
  });

  after(() => {
    // Clean up
    if (existsSync(e2eDir)) {
      rmSync(e2eDir, { recursive: true });
    }
  });

  it('should complete init → analyze → query workflow', async () => {
    // Step 1: Run init
    const initResult = await runCliInDir(e2eDir, ['init']);
    assert.strictEqual(initResult.code, 0, `init failed: ${initResult.stderr}`);
    assert.ok(initResult.stdout.includes('Found package.json'), 'init should detect package.json');

    // Verify config was created
    const configPath = join(e2eDir, '.grafema', 'config.yaml');
    assert.ok(existsSync(configPath), '.grafema/config.yaml should be created');

    // Step 2: Run analyze with --clear flag
    const analyzeResult = await runCliInDir(e2eDir, ['analyze', '--clear', '--auto-start']);
    assert.strictEqual(analyzeResult.code, 0, `analyze failed: ${analyzeResult.stderr}`);
    assert.ok(analyzeResult.stdout.includes('Analysis complete'), 'analyze should complete');
    assert.ok(analyzeResult.stdout.includes('Nodes:'), 'analyze should show node count');
    assert.ok(analyzeResult.stdout.includes('Edges:'), 'analyze should show edge count');

    // Verify database was created
    const dbPath = join(e2eDir, '.grafema', 'graph.rfdb');
    assert.ok(existsSync(dbPath), 'graph.rfdb should be created');

    // Step 3: Run query for "function hello"
    const queryResult = await runCliInDir(e2eDir, ['query', 'function hello']);
    assert.strictEqual(queryResult.code, 0, `query failed: ${queryResult.stderr}`);
    assert.ok(queryResult.stdout.includes('hello'), 'query should find hello function');
    assert.ok(queryResult.stdout.includes('FUNCTION'), 'query should show function type');
    assert.ok(queryResult.stdout.includes('src/index.js'), 'query should show file path');

    // Step 4: Query for another function to verify multiple functions work
    const greetResult = await runCliInDir(e2eDir, ['query', 'function greet']);
    assert.strictEqual(greetResult.code, 0, `query greet failed: ${greetResult.stderr}`);
    assert.ok(greetResult.stdout.includes('greet'), 'query should find greet function');
    assert.ok(greetResult.stdout.includes('FUNCTION'), 'query should show function type');

    // Step 5: Test JSON output format
    const jsonResult = await runCliInDir(e2eDir, ['query', 'function hello', '--json']);
    assert.strictEqual(jsonResult.code, 0, `query --json failed: ${jsonResult.stderr}`);

    // Extract JSON from output (may have log messages before/after)
    // The JSON array starts with '[\n' (not '[R' from [RFDBServerBackend])
    // And ends with '\n]' (the array closing bracket on its own line)
    const stdout = jsonResult.stdout;
    const jsonStart = stdout.indexOf('[\n');
    // Find the closing ']' that comes after a newline (the array close, not from log messages)
    const jsonEnd = stdout.indexOf('\n]', jsonStart);

    assert.ok(jsonStart !== -1 && jsonEnd > jsonStart,
      `output should contain JSON array, got: ${stdout.slice(0, 300)}`);

    // Include the closing bracket (slice to jsonEnd + 2 to include '\n]')
    const jsonStr = stdout.slice(jsonStart, jsonEnd + 2);

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      assert.fail(`query --json should produce valid JSON, got: ${jsonStr.slice(0, 200)}, error: ${e}`);
    }

    assert.ok(Array.isArray(parsed), 'JSON output should be an array');
    assert.ok(parsed.length > 0, 'JSON output should have results');
    assert.ok(parsed[0].name === 'hello', 'First result should be hello function');
  });
});
