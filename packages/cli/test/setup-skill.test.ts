/**
 * Tests for `grafema setup-skill` command - REG-414
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const cliPath = join(__dirname, '../dist/cli.js');
const fixturesDir = join(__dirname, 'fixtures');
const testDir = join(fixturesDir, 'setup-skill-test');

function runCli(args: string[], cwd: string = testDir): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [cliPath, ...args], {
      cwd,
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

describe('setup-skill command', () => {
  before(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('should show help', async () => {
    const { stdout, code } = await runCli(['setup-skill', '--help']);
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes('Install Grafema Agent Skill'), 'help should describe command');
    assert.ok(stdout.includes('--platform'), 'help should show --platform option');
    assert.ok(stdout.includes('--force'), 'help should show --force option');
  });

  it('should install skill to default .claude/skills/ directory', async () => {
    const skillDir = join(testDir, '.claude', 'skills', 'grafema-codebase-analysis');

    const { stdout, code } = await runCli(['setup-skill', testDir]);
    assert.strictEqual(code, 0, `setup-skill failed: stdout=${stdout}`);
    assert.ok(stdout.includes('Grafema skill installed'), 'should confirm installation');

    // Verify SKILL.md exists and has correct content
    const skillMd = join(skillDir, 'SKILL.md');
    assert.ok(existsSync(skillMd), 'SKILL.md should exist');
    const content = readFileSync(skillMd, 'utf-8');
    assert.ok(content.includes('name: grafema-codebase-analysis'), 'SKILL.md should have correct name');
    assert.ok(content.includes('description:'), 'SKILL.md should have description');

    // Verify reference files exist
    assert.ok(
      existsSync(join(skillDir, 'references', 'node-edge-types.md')),
      'node-edge-types.md should exist'
    );
    assert.ok(
      existsSync(join(skillDir, 'references', 'query-patterns.md')),
      'query-patterns.md should exist'
    );
  });

  it('should skip if already installed with same version', async () => {
    const { stdout, code } = await runCli(['setup-skill', testDir]);
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes('already installed'), 'should indicate already installed');
  });

  it('should overwrite with --force', async () => {
    const { stdout, code } = await runCli(['setup-skill', testDir, '--force']);
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes('Grafema skill installed'), 'should confirm fresh install');
  });

  it('should support --platform gemini', async () => {
    const geminiDir = join(testDir, '.gemini', 'skills', 'grafema-codebase-analysis');

    const { stdout, code } = await runCli(['setup-skill', testDir, '--platform', 'gemini']);
    assert.strictEqual(code, 0);
    assert.ok(existsSync(join(geminiDir, 'SKILL.md')), 'SKILL.md should exist in .gemini/skills/');
  });

  it('should support custom --output-dir', async () => {
    const customDir = join(testDir, 'custom-skills');
    const targetDir = join(customDir, 'grafema-codebase-analysis');

    const { stdout, code } = await runCli(['setup-skill', testDir, '--output-dir', customDir]);
    assert.strictEqual(code, 0);
    assert.ok(existsSync(join(targetDir, 'SKILL.md')), 'SKILL.md should exist in custom dir');
  });
});

describe('init auto-installs skill', () => {
  const initDir = join(fixturesDir, 'init-skill-test');

  before(() => {
    if (existsSync(initDir)) {
      rmSync(initDir, { recursive: true });
    }
    mkdirSync(initDir, { recursive: true });
    // init requires package.json
    writeFileSync(join(initDir, 'package.json'), '{"name":"skill-test"}');
  });

  after(() => {
    if (existsSync(initDir)) {
      rmSync(initDir, { recursive: true });
    }
  });

  it('should auto-install skill during grafema init', async () => {
    const { stdout, code } = await runCli(['init', '--yes'], initDir);
    assert.strictEqual(code, 0, `init failed: stdout=${stdout}`);
    assert.ok(stdout.includes('Agent Skill'), 'should mention Agent Skill installation');

    const skillPath = join(initDir, '.claude', 'skills', 'grafema-codebase-analysis', 'SKILL.md');
    assert.ok(existsSync(skillPath), 'SKILL.md should be auto-installed by init');
  });
});
