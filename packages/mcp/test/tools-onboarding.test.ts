/**
 * Tests for onboarding-related MCP tools.
 *
 * Verifies:
 * - handleReadProjectStructure: reading directory structure
 * - handleWriteConfig: writing config with validation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleReadProjectStructure, handleWriteConfig } from '../dist/handlers.js';
import { setProjectPath } from '../dist/state.js';

describe('Onboarding Tools', () => {
  let testDir: string;
  let originalProjectPath: string;

  beforeEach(() => {
    // Create temp directory for each test
    testDir = mkdtempSync(join(tmpdir(), 'grafema-test-'));

    // Point state to test directory
    // Store original to restore later if needed
    originalProjectPath = process.cwd();
    setProjectPath(testDir);
  });

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    // Restore original project path
    setProjectPath(originalProjectPath);
  });

  describe('handleReadProjectStructure', () => {
    it('should read root directory structure', async () => {
      // Setup: create test files and directories
      mkdirSync(join(testDir, 'src'));
      mkdirSync(join(testDir, 'test'));
      writeFileSync(join(testDir, 'package.json'), '{}');
      writeFileSync(join(testDir, 'src', 'index.js'), '// code');

      const result = await handleReadProjectStructure({ path: '.' });

      assert.ok(result.isError === false || result.isError === undefined);
      assert.ok(result.content);

      const content = Array.isArray(result.content)
        ? result.content[0].text
        : result.content;

      assert.ok(content.includes('src/'));
      assert.ok(content.includes('test/'));
      assert.ok(content.includes('package.json'));
    });

    it('should respect depth parameter', async () => {
      // Setup: create nested structure
      mkdirSync(join(testDir, 'a'));
      mkdirSync(join(testDir, 'a', 'b'));
      mkdirSync(join(testDir, 'a', 'b', 'c'));
      writeFileSync(join(testDir, 'a', 'b', 'c', 'deep.js'), '// deep');

      // Depth 1: should not see b/
      const result1 = await handleReadProjectStructure({ path: '.', depth: 1 });
      const content1 = Array.isArray(result1.content)
        ? result1.content[0].text
        : result1.content;
      assert.ok(content1.includes('a/'));
      assert.ok(!content1.includes('b/'));

      // Depth 3: should see c/
      const result3 = await handleReadProjectStructure({ path: '.', depth: 3 });
      const content3 = Array.isArray(result3.content)
        ? result3.content[0].text
        : result3.content;
      assert.ok(content3.includes('c/'));
    });

    it('should exclude common build directories', async () => {
      // Setup: create excluded directories
      mkdirSync(join(testDir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(testDir, '.git'));
      mkdirSync(join(testDir, 'dist'));
      mkdirSync(join(testDir, 'src'));
      writeFileSync(join(testDir, 'node_modules', 'pkg', 'index.js'), '// module');

      const result = await handleReadProjectStructure({ path: '.' });
      const content = Array.isArray(result.content)
        ? result.content[0].text
        : result.content;

      // Should include src
      assert.ok(content.includes('src/'));

      // Should NOT include excluded dirs
      assert.ok(!content.includes('node_modules'));
      assert.ok(!content.includes('.git'));
      assert.ok(!content.includes('dist'));
    });

    it('should support include_files parameter', async () => {
      mkdirSync(join(testDir, 'src'));
      writeFileSync(join(testDir, 'src', 'index.js'), '// code');
      writeFileSync(join(testDir, 'README.md'), '# readme');

      // With files (default)
      const withFiles = await handleReadProjectStructure({
        path: '.',
        include_files: true
      });
      const contentWith = Array.isArray(withFiles.content)
        ? withFiles.content[0].text
        : withFiles.content;
      assert.ok(contentWith.includes('README.md'));

      // Without files
      const withoutFiles = await handleReadProjectStructure({
        path: '.',
        include_files: false
      });
      const contentWithout = Array.isArray(withoutFiles.content)
        ? withoutFiles.content[0].text
        : withoutFiles.content;
      assert.ok(!contentWithout.includes('README.md'));
    });

    it('should return error for non-existent path', async () => {
      const result = await handleReadProjectStructure({
        path: 'nonexistent-dir'
      });

      assert.strictEqual(result.isError, true);
      const content = Array.isArray(result.content)
        ? result.content[0].text
        : result.content;
      assert.ok(content.includes('does not exist'));
    });

    it('should return error for file path (not directory)', async () => {
      writeFileSync(join(testDir, 'file.txt'), 'content');

      const result = await handleReadProjectStructure({
        path: 'file.txt'
      });

      assert.strictEqual(result.isError, true);
      const content = Array.isArray(result.content)
        ? result.content[0].text
        : result.content;
      assert.ok(content.includes('not a directory'));
    });
  });

  describe('handleWriteConfig', () => {
    it('should write basic config with services', async () => {
      // Create the service directory first
      mkdirSync(join(testDir, 'src', 'api'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'api', 'index.js'), '// code');

      const result = await handleWriteConfig({
        services: [
          { name: 'api', path: 'src/api', entrypoints: ['index.js'] }
        ]
      });

      assert.ok(result.isError === false || result.isError === undefined);

      // Verify file was created
      const configPath = join(testDir, '.grafema', 'config.yaml');
      assert.ok(existsSync(configPath));

      // Verify content
      const content = readFileSync(configPath, 'utf-8');
      assert.ok(content.includes('services:'));
      assert.ok(content.includes('name: api'));
      assert.ok(content.includes('path: src/api'));
      assert.ok(content.includes('- index.js'));
    });

    it('should write config with patterns', async () => {
      const result = await handleWriteConfig({
        include: ['src/**/*.js'],
        exclude: ['**/*.test.js']
      });

      assert.ok(result.isError === false || result.isError === undefined);

      const configPath = join(testDir, '.grafema', 'config.yaml');
      const content = readFileSync(configPath, 'utf-8');

      assert.ok(content.includes('include:'));
      assert.ok(content.includes('- src/**/*.js'));
      assert.ok(content.includes('exclude:'));
      assert.ok(content.includes('- "**/*.test.js"') || content.includes("- '**/*.test.js'"));
    });

    it('should write config with workspace roots', async () => {
      // Create workspace directories
      mkdirSync(join(testDir, 'packages', 'core'), { recursive: true });
      mkdirSync(join(testDir, 'packages', 'utils'), { recursive: true });

      const result = await handleWriteConfig({
        workspace: {
          roots: ['packages/core', 'packages/utils']
        }
      });

      assert.ok(result.isError === false || result.isError === undefined);

      const configPath = join(testDir, '.grafema', 'config.yaml');
      const content = readFileSync(configPath, 'utf-8');

      assert.ok(content.includes('workspace:'));
      assert.ok(content.includes('packages/core'));
      assert.ok(content.includes('packages/utils'));
    });

    it('should create .grafema directory if missing', async () => {
      const grafemaDir = join(testDir, '.grafema');
      assert.ok(!existsSync(grafemaDir));

      // Create service directory
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'main.js'), '// code');

      await handleWriteConfig({
        services: [
          { name: 'app', path: 'src', entrypoints: ['main.js'] }
        ]
      });

      assert.ok(existsSync(grafemaDir));
      assert.ok(existsSync(join(grafemaDir, 'config.yaml')));
    });

    it('should return error for invalid service path', async () => {
      const result = await handleWriteConfig({
        services: [
          { name: 'api', path: 'nonexistent-path', entrypoints: ['index.js'] }
        ]
      });

      assert.strictEqual(result.isError, true);
      const content = Array.isArray(result.content)
        ? result.content[0].text
        : result.content;
      assert.ok(content.includes('Failed to write config'));
    });

    it('should include header comments in config file', async () => {
      // Create service directory
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.js'), '// code');

      await handleWriteConfig({
        services: [
          { name: 'test', path: 'src', entrypoints: ['index.js'] }
        ]
      });

      const configPath = join(testDir, '.grafema', 'config.yaml');
      const content = readFileSync(configPath, 'utf-8');

      assert.ok(content.includes('# Grafema Configuration'));
      assert.ok(content.includes('# Generated by Grafema onboarding'));
      assert.ok(content.includes('# Documentation:'));
    });

    it('should return summary with next steps', async () => {
      // Create service directory
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'main.js'), '// code');

      const result = await handleWriteConfig({
        services: [
          { name: 'app', path: 'src', entrypoints: ['main.js'] }
        ]
      });

      const content = Array.isArray(result.content)
        ? result.content[0].text
        : result.content;

      assert.ok(content.includes('Configuration written'));
      assert.ok(content.includes('Services: app'));
      assert.ok(content.includes('Next step: run analyze_project'));
    });
  });
});
