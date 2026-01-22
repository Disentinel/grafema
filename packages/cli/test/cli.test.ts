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
  return new Promise((resolve) => {
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
});
