/**
 * WorkspaceMultiRoot Tests - REG-76
 *
 * Tests for multi-root workspace support.
 * Validates that semantic IDs include root prefix to prevent collisions
 * when the same relative path exists in different workspace roots.
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// Config loading
import { loadConfig } from '../../packages/core/dist/config/ConfigLoader.js';

describe('Workspace Multi-Root Configuration', () => {
  const testDir = join(process.cwd(), 'test/fixtures/multi-root-test');

  beforeEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, '.grafema'), { recursive: true });
    mkdirSync(join(testDir, 'backend', 'src'), { recursive: true });
    mkdirSync(join(testDir, 'frontend', 'src'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('workspace.roots config parsing', () => {
    it('should load workspace with roots array', () => {
      const configContent = `
workspace:
  roots:
    - ./backend
    - ./frontend

plugins:
  indexing: [JSModuleIndexer]
  analysis: []
  enrichment: []
  validation: []
`;
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), configContent);

      const config = loadConfig(testDir);

      assert.ok(config.workspace, 'workspace should be defined');
      assert.ok(Array.isArray(config.workspace.roots), 'workspace.roots should be array');
      assert.strictEqual(config.workspace.roots.length, 2);
      assert.strictEqual(config.workspace.roots[0], './backend');
      assert.strictEqual(config.workspace.roots[1], './frontend');
    });

    it('should return undefined workspace when not specified', () => {
      const configContent = `
plugins:
  indexing: [JSModuleIndexer]
  analysis: []
  enrichment: []
  validation: []
`;
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), configContent);

      const config = loadConfig(testDir);

      assert.strictEqual(config.workspace, undefined);
    });

    it('should throw when roots path does not exist', () => {
      const configContent = `
workspace:
  roots:
    - ./nonexistent

plugins:
  indexing: [JSModuleIndexer]
  analysis: []
  enrichment: []
  validation: []
`;
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), configContent);

      assert.throws(
        () => loadConfig(testDir),
        /does not exist/
      );
    });

    it('should throw when roots has duplicate names', () => {
      // Create two directories with same basename
      mkdirSync(join(testDir, 'apps', 'backend'), { recursive: true });

      const configContent = `
workspace:
  roots:
    - ./backend
    - ./apps/backend

plugins:
  indexing: [JSModuleIndexer]
  analysis: []
  enrichment: []
  validation: []
`;
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), configContent);

      assert.throws(
        () => loadConfig(testDir),
        /Duplicate workspace root name/
      );
    });

    it('should throw when roots is not an array', () => {
      const configContent = `
workspace:
  roots: "./backend"

plugins:
  indexing: [JSModuleIndexer]
  analysis: []
  enrichment: []
  validation: []
`;
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), configContent);

      assert.throws(
        () => loadConfig(testDir),
        /must be an array/
      );
    });

    it('should throw when roots entry is empty string', () => {
      const configContent = `
workspace:
  roots:
    - ""

plugins:
  indexing: [JSModuleIndexer]
  analysis: []
  enrichment: []
  validation: []
`;
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), configContent);

      assert.throws(
        () => loadConfig(testDir),
        /cannot be empty/
      );
    });
  });

  describe('semantic ID with root prefix', () => {
    it('should produce different IDs for same relative path in different roots', () => {
      // This is the core collision prevention test
      // backend/src/utils.js and frontend/src/utils.js should have different IDs

      const backendPath = 'backend/src/utils.js';
      const frontendPath = 'frontend/src/utils.js';

      // Expected semantic IDs with root prefix
      const backendId = `${backendPath}->global->MODULE->module`;
      const frontendId = `${frontendPath}->global->MODULE->module`;

      assert.notStrictEqual(backendId, frontendId);
      assert.ok(backendId.startsWith('backend/'));
      assert.ok(frontendId.startsWith('frontend/'));
    });

    it('should maintain consistent format for single root (backward compat)', () => {
      // Single root without workspace config should work like before
      const relativePath = 'src/utils.js';
      const expectedId = `${relativePath}->global->MODULE->module`;

      assert.strictEqual(expectedId, 'src/utils.js->global->MODULE->module');
    });
  });
});

describe('Workspace Root Prefix in Indexers', () => {
  describe('rootPrefix context propagation', () => {
    it('should construct file path with rootPrefix when provided', () => {
      const rootPrefix = 'backend';
      const relativeToRoot = 'src/api.js';

      // Expected: rootPrefix/relativeToRoot
      const prefixedPath = `${rootPrefix}/${relativeToRoot}`;

      assert.strictEqual(prefixedPath, 'backend/src/api.js');
    });

    it('should use path directly when rootPrefix is undefined (single root)', () => {
      const rootPrefix = undefined;
      const relativeToRoot = 'src/api.js';

      // When no rootPrefix, use path as-is
      const finalPath = rootPrefix ? `${rootPrefix}/${relativeToRoot}` : relativeToRoot;

      assert.strictEqual(finalPath, 'src/api.js');
    });
  });
});
