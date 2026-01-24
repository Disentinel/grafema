/**
 * Tests for resolveSourceEntrypoint utility
 *
 * Tests for REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects
 *
 * These tests verify that resolveSourceEntrypoint correctly identifies TypeScript
 * source entrypoints, preferring src/ over compiled dist/ output.
 *
 * Test scenarios:
 * 1. TypeScript project with src/index.ts -> returns src/index.ts
 * 2. TypeScript project with source field in package.json -> returns that path
 * 3. TypeScript project with src/index.tsx -> returns src/index.tsx
 * 4. JavaScript project (no tsconfig.json) -> returns null
 * 5. TypeScript project with no matching source file -> returns null
 * 6. TypeScript project with lib/index.ts -> returns lib/index.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { resolveSourceEntrypoint } from '@grafema/core';

// =============================================================================
// TEST SETUP
// =============================================================================

describe('resolveSourceEntrypoint', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-ts-resolve-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Core Scenarios
  // ===========================================================================

  describe('TypeScript project detection', () => {
    it('should return src/index.ts for TypeScript project with standard structure', () => {
      // Setup: TypeScript project with tsconfig.json and src/index.ts
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.ts'), 'export const x = 1;');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

      assert.strictEqual(result, 'src/index.ts');
    });

    it('should return null for JavaScript project (no tsconfig.json)', () => {
      // Setup: JavaScript project without tsconfig.json
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'js-project', main: 'index.js' }));
      writeFileSync(join(tempDir, 'index.js'), 'module.exports = {};');

      const result = resolveSourceEntrypoint(tempDir, { main: 'index.js' });

      assert.strictEqual(result, null);
    });
  });

  // ===========================================================================
  // Package.json source field
  // ===========================================================================

  describe('package.json source field', () => {
    it('should prefer source field over standard candidates', () => {
      // Setup: Project with custom source field pointing to lib/main.ts
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'lib'));
      writeFileSync(join(tempDir, 'lib/main.ts'), 'export const x = 1;');
      // Also create src/index.ts to verify source field takes precedence
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.ts'), 'export const y = 2;');

      const result = resolveSourceEntrypoint(tempDir, {
        main: 'dist/index.js',
        source: 'lib/main.ts'
      });

      assert.strictEqual(result, 'lib/main.ts');
    });

    it('should ignore source field if file does not exist', () => {
      // Setup: source field points to non-existent file
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.ts'), 'export const x = 1;');

      const result = resolveSourceEntrypoint(tempDir, {
        main: 'dist/index.js',
        source: 'lib/nonexistent.ts'
      });

      // Should fall back to standard candidates
      assert.strictEqual(result, 'src/index.ts');
    });
  });

  // ===========================================================================
  // TSX support (React projects)
  // ===========================================================================

  describe('TSX file support', () => {
    it('should find src/index.tsx for React TypeScript projects', () => {
      // Setup: React TypeScript project with .tsx entry
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.tsx'), 'export const App = () => <div/>;');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

      assert.strictEqual(result, 'src/index.tsx');
    });

    it('should prefer .ts over .tsx when both exist', () => {
      // Setup: Both .ts and .tsx exist in src/
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.ts'), 'export const x = 1;');
      writeFileSync(join(tempDir, 'src/index.tsx'), 'export const App = () => <div/>;');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

      // .ts comes before .tsx in candidates list (standard convention)
      assert.strictEqual(result, 'src/index.ts');
    });
  });

  // ===========================================================================
  // Alternative source locations
  // ===========================================================================

  describe('alternative source locations', () => {
    it('should find lib/index.ts when src/ does not exist', () => {
      // Setup: TypeScript project with lib/ instead of src/
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'lib'));
      writeFileSync(join(tempDir, 'lib/index.ts'), 'export const x = 1;');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

      assert.strictEqual(result, 'lib/index.ts');
    });

    it('should prefer src/ over lib/ when both exist', () => {
      // Setup: Both src/ and lib/ have index.ts
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.ts'), 'export const x = 1;');
      mkdirSync(join(tempDir, 'lib'));
      writeFileSync(join(tempDir, 'lib/index.ts'), 'export const y = 2;');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

      // src/ comes before lib/ in candidates list
      assert.strictEqual(result, 'src/index.ts');
    });

    it('should find root-level index.ts as last resort', () => {
      // Setup: TypeScript project with only root-level index.ts
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      writeFileSync(join(tempDir, 'index.ts'), 'export const x = 1;');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

      assert.strictEqual(result, 'index.ts');
    });
  });

  // ===========================================================================
  // No source files found
  // ===========================================================================

  describe('no source files found', () => {
    it('should return null when TypeScript project has only compiled output', () => {
      // Setup: TypeScript project with only dist/ (no source files)
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'dist'));
      writeFileSync(join(tempDir, 'dist/index.js'), 'exports.x = 1;');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

      assert.strictEqual(result, null);
    });

    it('should return null when no standard source candidates exist', () => {
      // Setup: TypeScript project with non-standard entry file name
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/app.ts'), 'export const x = 1;'); // Not index.ts or main.ts

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/app.js' });

      // app.ts is not in standard candidates, so null is returned
      assert.strictEqual(result, null);
    });
  });

  // ===========================================================================
  // Monorepo support
  // ===========================================================================

  describe('monorepo package support', () => {
    it('should resolve source for individual monorepo package', () => {
      // Setup: Monorepo package with its own tsconfig.json
      const packagePath = join(tempDir, 'packages', 'foo');
      mkdirSync(packagePath, { recursive: true });
      writeFileSync(join(packagePath, 'tsconfig.json'), '{}');
      mkdirSync(join(packagePath, 'src'));
      writeFileSync(join(packagePath, 'src/index.ts'), 'export const foo = 1;');

      const result = resolveSourceEntrypoint(packagePath, { main: 'dist/index.js' });

      assert.strictEqual(result, 'src/index.ts');
    });

    it('should return null for package without tsconfig.json (inherits from root)', () => {
      // Setup: Package that inherits tsconfig from root (no local tsconfig.json)
      const packagePath = join(tempDir, 'packages', 'bar');
      mkdirSync(packagePath, { recursive: true });
      // No tsconfig.json at package level - only at root
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(packagePath, 'src'));
      writeFileSync(join(packagePath, 'src/index.ts'), 'export const bar = 1;');

      const result = resolveSourceEntrypoint(packagePath, { main: 'dist/index.js' });

      // No local tsconfig.json means we cannot determine if this is a TS project
      assert.strictEqual(result, null);
    });
  });

  // ===========================================================================
  // main.ts variants
  // ===========================================================================

  describe('main.ts variants', () => {
    it('should find src/main.ts when index.ts does not exist', () => {
      // Setup: Project using main.ts convention
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/main.ts'), 'export const main = () => {};');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/main.js' });

      assert.strictEqual(result, 'src/main.ts');
    });

    it('should prefer index.ts over main.ts', () => {
      // Setup: Both index.ts and main.ts exist
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.ts'), 'export const x = 1;');
      writeFileSync(join(tempDir, 'src/main.ts'), 'export const main = () => {};');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

      // index.ts comes before main.ts in candidates list
      assert.strictEqual(result, 'src/index.ts');
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty package.json object', () => {
      // Setup: TypeScript project with minimal package.json
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.ts'), 'export const x = 1;');

      const result = resolveSourceEntrypoint(tempDir, {});

      assert.strictEqual(result, 'src/index.ts');
    });

    it('should handle .mts extension', () => {
      // Setup: TypeScript ESM project with .mts extension
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src/index.mts'), 'export const x = 1;');

      const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.mjs' });

      assert.strictEqual(result, 'src/index.mts');
    });
  });
});
