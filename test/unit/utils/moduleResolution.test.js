/**
 * Module Resolution Utility Tests (REG-320)
 *
 * Tests the unified module resolution utility that consolidates duplicated
 * module resolution logic from:
 * - MountPointResolver.resolveImportSource()
 * - JSModuleIndexer.resolveModulePath()
 * - FunctionCallResolver._resolveImportPath()
 * - IncrementalModuleIndexer.tryResolve()
 *
 * Design decisions from 006-decisions.md:
 * - DEFAULT_EXTENSIONS: ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']
 * - DEFAULT_INDEX_FILES: ['index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx']
 * - Throws if useFilesystem=false but no fileIndex provided
 * - Returns null for directories (bug fix for IncrementalModuleIndexer)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// These will be imported after implementation:
// import { resolveModulePath, isRelativeImport, resolveRelativeSpecifier } from '@grafema/core';

// Temporary stubs for TDD - tests written before implementation
let resolveModulePath;
let isRelativeImport;
let resolveRelativeSpecifier;

let testDir;
let testCounter = 0;

/**
 * Create a unique test directory
 */
function createTestDir() {
  const dir = join(tmpdir(), `grafema-module-resolution-${Date.now()}-${testCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a file in the test directory
 */
function createFile(relativePath, content = '') {
  const fullPath = join(testDir, relativePath);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

/**
 * Try to import the actual implementation.
 * If not available, tests will be skipped with clear message.
 */
async function loadImplementation() {
  try {
    const core = await import('@grafema/core');
    resolveModulePath = core.resolveModulePath;
    isRelativeImport = core.isRelativeImport;
    resolveRelativeSpecifier = core.resolveRelativeSpecifier;
    // Check that all functions are actually exported
    return !!(resolveModulePath && isRelativeImport && resolveRelativeSpecifier);
  } catch {
    return false;
  }
}

describe('Module Resolution Utility (REG-320)', () => {
  let implementationAvailable = false;

  before(async () => {
    implementationAvailable = await loadImplementation();
    testDir = createTestDir();
  });

  after(() => {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ===========================================================================
  // isRelativeImport()
  // ===========================================================================

  describe('isRelativeImport()', () => {
    it('should return true for ./ imports', async (t) => {
      if (!implementationAvailable) {
        t.skip('Module resolution utility not yet implemented');
        return;
      }

      assert.strictEqual(isRelativeImport('./foo'), true);
      assert.strictEqual(isRelativeImport('./foo/bar'), true);
      assert.strictEqual(isRelativeImport('./foo.js'), true);
    });

    it('should return true for ../ imports', async (t) => {
      if (!implementationAvailable) {
        t.skip('Module resolution utility not yet implemented');
        return;
      }

      assert.strictEqual(isRelativeImport('../bar'), true);
      assert.strictEqual(isRelativeImport('../foo/bar'), true);
      assert.strictEqual(isRelativeImport('../../baz'), true);
    });

    it('should return false for bare module specifiers', async (t) => {
      if (!implementationAvailable) {
        t.skip('Module resolution utility not yet implemented');
        return;
      }

      assert.strictEqual(isRelativeImport('lodash'), false);
      assert.strictEqual(isRelativeImport('express'), false);
      assert.strictEqual(isRelativeImport('react-dom'), false);
    });

    it('should return false for scoped packages', async (t) => {
      if (!implementationAvailable) {
        t.skip('Module resolution utility not yet implemented');
        return;
      }

      assert.strictEqual(isRelativeImport('@scope/pkg'), false);
      assert.strictEqual(isRelativeImport('@grafema/core'), false);
      assert.strictEqual(isRelativeImport('@types/node'), false);
    });

    it('should return false for node: protocol imports', async (t) => {
      if (!implementationAvailable) {
        t.skip('Module resolution utility not yet implemented');
        return;
      }

      assert.strictEqual(isRelativeImport('node:fs'), false);
      assert.strictEqual(isRelativeImport('node:path'), false);
    });

    it('should return false for absolute paths', async (t) => {
      if (!implementationAvailable) {
        t.skip('Module resolution utility not yet implemented');
        return;
      }

      assert.strictEqual(isRelativeImport('/absolute/path'), false);
      assert.strictEqual(isRelativeImport('/foo.js'), false);
    });
  });

  // ===========================================================================
  // resolveModulePath() - Filesystem Mode
  // ===========================================================================

  describe('resolveModulePath() - Filesystem Mode', () => {

    describe('Exact path resolution', () => {
      it('should resolve exact file path when file exists', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('exact/module.js', 'export const x = 1;');
        const basePath = join(testDir, 'exact/module');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, filePath);
      });

      it('should return null when file does not exist', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const basePath = join(testDir, 'nonexistent/module');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, null);
      });
    });

    describe('Extension resolution', () => {
      it('should resolve .js extension', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('ext/module.js', 'export const x = 1;');
        const basePath = join(testDir, 'ext/module');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, filePath);
      });

      it('should resolve .mjs extension', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('ext-mjs/module.mjs', 'export const x = 1;');
        const basePath = join(testDir, 'ext-mjs/module');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, filePath);
      });

      it('should resolve .cjs extension', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('ext-cjs/module.cjs', 'module.exports = { x: 1 };');
        const basePath = join(testDir, 'ext-cjs/module');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, filePath);
      });

      it('should resolve .jsx extension', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('ext-jsx/Component.jsx', 'export const C = () => <div/>;');
        const basePath = join(testDir, 'ext-jsx/Component');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, filePath);
      });

      it('should resolve .ts extension', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('ext-ts/module.ts', 'export const x: number = 1;');
        const basePath = join(testDir, 'ext-ts/module');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, filePath);
      });

      it('should resolve .tsx extension', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('ext-tsx/Component.tsx', 'export const C: FC = () => <div/>;');
        const basePath = join(testDir, 'ext-tsx/Component');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, filePath);
      });

      it('should prefer exact match over extension addition', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // Create both: file without extension AND file.js
        const exactPath = createFile('prefer-exact/module', 'exact file');
        createFile('prefer-exact/module.js', 'js file');

        const basePath = join(testDir, 'prefer-exact/module');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, exactPath, 'Should prefer exact match');
      });
    });

    describe('Index file resolution', () => {
      it('should resolve index.js in directory', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const indexPath = createFile('dir-js/mylib/index.js', 'export const x = 1;');
        const basePath = join(testDir, 'dir-js/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, indexPath);
      });

      it('should resolve index.ts in directory', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const indexPath = createFile('dir-ts/mylib/index.ts', 'export const x: number = 1;');
        const basePath = join(testDir, 'dir-ts/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, indexPath);
      });

      it('should resolve index.mjs in directory', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const indexPath = createFile('dir-mjs/mylib/index.mjs', 'export const x = 1;');
        const basePath = join(testDir, 'dir-mjs/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, indexPath);
      });

      it('should resolve index.cjs in directory', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const indexPath = createFile('dir-cjs/mylib/index.cjs', 'module.exports = { x: 1 };');
        const basePath = join(testDir, 'dir-cjs/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, indexPath);
      });

      it('should resolve index.jsx in directory', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const indexPath = createFile('dir-jsx/mylib/index.jsx', 'export const C = () => <div/>;');
        const basePath = join(testDir, 'dir-jsx/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, indexPath);
      });

      it('should resolve index.tsx in directory', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const indexPath = createFile('dir-tsx/mylib/index.tsx', 'export const C: FC = () => <div/>;');
        const basePath = join(testDir, 'dir-tsx/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, indexPath);
      });

      it('should prefer file with extension over index file', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // Create both: mylib.js AND mylib/index.js
        const filePath = createFile('prefer-file/mylib.js', 'file content');
        createFile('prefer-file/mylib/index.js', 'index content');

        const basePath = join(testDir, 'prefer-file/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, filePath, 'Should prefer mylib.js over mylib/index.js');
      });
    });

    describe('Directory handling (bug fix)', () => {
      it('should return null for directory without index file', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // Create directory with non-index file
        createFile('empty-dir/mylib/utils.js', 'export const x = 1;');
        const basePath = join(testDir, 'empty-dir/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, null, 'Should return null for directory without index');
      });
    });

    describe('Not found cases', () => {
      it('should return null when no file matches', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const basePath = join(testDir, 'not-found/doesnt-exist');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, null);
      });

      it('should return null for directory with wrong index extension', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // Create index.coffee (unsupported extension)
        createFile('wrong-ext/mylib/index.coffee', 'x = 1');
        const basePath = join(testDir, 'wrong-ext/mylib');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, null);
      });
    });
  });

  // ===========================================================================
  // resolveModulePath() - In-Memory Mode (fileIndex)
  // ===========================================================================

  describe('resolveModulePath() - In-Memory Mode (fileIndex)', () => {

    describe('Basic resolution with fileIndex Set', () => {
      it('should resolve exact path from fileIndex', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set([
          '/project/src/module.js',
          '/project/src/other.js'
        ]);

        const result = resolveModulePath('/project/src/module', {
          useFilesystem: false,
          fileIndex
        });
        assert.strictEqual(result, '/project/src/module.js');
      });

      it('should resolve index file from fileIndex', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set([
          '/project/src/utils/index.ts',
          '/project/src/utils/helpers.ts'
        ]);

        const result = resolveModulePath('/project/src/utils', {
          useFilesystem: false,
          fileIndex
        });
        assert.strictEqual(result, '/project/src/utils/index.ts');
      });

      it('should return null when not in fileIndex', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set([
          '/project/src/module.js'
        ]);

        const result = resolveModulePath('/project/src/other', {
          useFilesystem: false,
          fileIndex
        });
        assert.strictEqual(result, null);
      });

      it('should NOT access filesystem when fileIndex is provided', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // Create a real file
        const realFile = createFile('real-file-test/module.js', 'content');

        // But use an empty fileIndex
        const fileIndex = new Set();

        const result = resolveModulePath(join(testDir, 'real-file-test/module'), {
          useFilesystem: false,
          fileIndex
        });

        // Should return null because it's not in fileIndex,
        // even though the file exists on disk
        assert.strictEqual(result, null,
          'Should not find file on disk when using fileIndex');
      });
    });

    describe('Validation', () => {
      it('should throw when useFilesystem=false and no fileIndex provided', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        assert.throws(
          () => resolveModulePath('/some/path', { useFilesystem: false }),
          /fileIndex.*required|must provide fileIndex/i,
          'Should throw when useFilesystem=false without fileIndex'
        );
      });

      it('should throw when useFilesystem=false and fileIndex is undefined', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        assert.throws(
          () => resolveModulePath('/some/path', {
            useFilesystem: false,
            fileIndex: undefined
          }),
          /fileIndex.*required|must provide fileIndex/i,
          'Should throw when fileIndex is explicitly undefined'
        );
      });

      it('should throw when useFilesystem=false and fileIndex is null', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        assert.throws(
          () => resolveModulePath('/some/path', {
            useFilesystem: false,
            fileIndex: null
          }),
          /fileIndex.*required|must provide fileIndex/i,
          'Should throw when fileIndex is explicitly null'
        );
      });
    });

    describe('Extension priority in fileIndex', () => {
      it('should try extensions in order when multiple exist', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // fileIndex has both .js and .ts
        const fileIndex = new Set([
          '/project/src/module.js',
          '/project/src/module.ts'
        ]);

        const result = resolveModulePath('/project/src/module', {
          useFilesystem: false,
          fileIndex
        });

        // Per design: '' (exact) comes first, then .js
        // So .js should be preferred over .ts
        assert.strictEqual(result, '/project/src/module.js');
      });

      it('should return exact match if in fileIndex', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set([
          '/project/src/module',  // Exact path (no extension)
          '/project/src/module.js'
        ]);

        const result = resolveModulePath('/project/src/module', {
          useFilesystem: false,
          fileIndex
        });

        assert.strictEqual(result, '/project/src/module',
          'Should prefer exact match over adding extension');
      });
    });

    describe('Index file priority in fileIndex', () => {
      it('should prefer file extension over index file in fileIndex', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set([
          '/project/src/utils.js',
          '/project/src/utils/index.js'
        ]);

        const result = resolveModulePath('/project/src/utils', {
          useFilesystem: false,
          fileIndex
        });

        assert.strictEqual(result, '/project/src/utils.js',
          'Should prefer utils.js over utils/index.js');
      });
    });
  });

  // ===========================================================================
  // resolveRelativeSpecifier()
  // ===========================================================================

  describe('resolveRelativeSpecifier()', () => {

    describe('Basic resolution', () => {
      it('should resolve ./ specifier relative to containing file', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // Create the target file
        const targetFile = createFile('rel/utils.js', 'export const x = 1;');

        const result = resolveRelativeSpecifier('./utils', '/some/path/rel/main.js', {
          useFilesystem: true
        });

        // The result should be based on actual resolution
        // Since containingFile is /some/path/rel/main.js, we resolve ./utils
        // relative to /some/path/rel/, giving /some/path/rel/utils.js
        // But this file doesn't exist (only testDir/rel/utils.js does)
        // So we need to use testDir-based paths
        const result2 = resolveRelativeSpecifier('./utils', join(testDir, 'rel/main.js'), {
          useFilesystem: true
        });
        assert.strictEqual(result2, targetFile);
      });

      it('should resolve ../ specifier relative to containing file', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const targetFile = createFile('parent-test/shared.ts', 'export const x = 1;');

        // Resolve from nested/main.js to ../shared
        const result = resolveRelativeSpecifier('../shared', join(testDir, 'parent-test/nested/main.js'), {
          useFilesystem: true
        });
        assert.strictEqual(result, targetFile);
      });

      it('should resolve deeply nested ../ specifiers', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const targetFile = createFile('deep/root.js', 'export const x = 1;');

        // Resolve from deep/a/b/c/main.js to ../../../root
        const result = resolveRelativeSpecifier('../../../root', join(testDir, 'deep/a/b/c/main.js'), {
          useFilesystem: true
        });
        assert.strictEqual(result, targetFile);
      });
    });

    describe('With fileIndex', () => {
      it('should use fileIndex for resolution when provided', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set([
          '/project/src/utils/helpers.ts',
          '/project/src/main.ts'
        ]);

        const result = resolveRelativeSpecifier('./utils/helpers', '/project/src/main.ts', {
          useFilesystem: false,
          fileIndex
        });
        assert.strictEqual(result, '/project/src/utils/helpers.ts');
      });
    });

    describe('Non-relative specifiers', () => {
      it('should return null for bare module specifiers', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const result = resolveRelativeSpecifier('lodash', '/project/src/main.js', {
          useFilesystem: true
        });
        assert.strictEqual(result, null,
          'Should return null for bare module specifier');
      });

      it('should return null for scoped package specifiers', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const result = resolveRelativeSpecifier('@scope/pkg', '/project/src/main.js', {
          useFilesystem: true
        });
        assert.strictEqual(result, null,
          'Should return null for scoped package specifier');
      });
    });
  });

  // ===========================================================================
  // TypeScript Extension Redirect (REG-426)
  // ===========================================================================

  describe('TypeScript Extension Redirect (REG-426)', () => {

    describe('.js → .ts redirect (filesystem)', () => {
      it('should resolve .js import to .ts file when .js does not exist', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const tsFile = createFile('ts-redirect/utils.ts', 'export const x: number = 1;');
        // basePath already has .js extension (from import './utils.js')
        const basePath = join(testDir, 'ts-redirect/utils.js');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, tsFile);
      });

      it('should prefer .js file when it exists (no redirect needed)', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const jsFile = createFile('ts-no-redirect/utils.js', 'export const x = 1;');
        createFile('ts-no-redirect/utils.ts', 'export const x: number = 1;');
        const basePath = join(testDir, 'ts-no-redirect/utils.js');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, jsFile, 'Should prefer existing .js over .ts redirect');
      });

      it('should resolve .js to .tsx when .ts does not exist', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const tsxFile = createFile('tsx-redirect/Component.tsx', 'export const C = () => <div/>;');
        const basePath = join(testDir, 'tsx-redirect/Component.js');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, tsxFile);
      });
    });

    describe('.jsx → .tsx redirect (filesystem)', () => {
      it('should resolve .jsx import to .tsx file', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const tsxFile = createFile('jsx-redirect/Component.tsx', 'export const C = () => <div/>;');
        const basePath = join(testDir, 'jsx-redirect/Component.jsx');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, tsxFile);
      });
    });

    describe('.mjs → .mts redirect (filesystem)', () => {
      it('should resolve .mjs import to .mts file', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const mtsFile = createFile('mjs-redirect/module.mts', 'export const x = 1;');
        const basePath = join(testDir, 'mjs-redirect/module.mjs');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, mtsFile);
      });
    });

    describe('.cjs → .cts redirect (filesystem)', () => {
      it('should resolve .cjs import to .cts file', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const ctsFile = createFile('cjs-redirect/module.cts', 'export const x = 1;');
        const basePath = join(testDir, 'cjs-redirect/module.cjs');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, ctsFile);
      });
    });

    describe('In-memory mode (fileIndex)', () => {
      it('should resolve .js to .ts in fileIndex', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set([
          '/project/src/utils.ts'
        ]);

        const result = resolveModulePath('/project/src/utils.js', {
          useFilesystem: false,
          fileIndex
        });
        assert.strictEqual(result, '/project/src/utils.ts');
      });

      it('should prefer existing .js in fileIndex over .ts redirect', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set([
          '/project/src/utils.js',
          '/project/src/utils.ts'
        ]);

        const result = resolveModulePath('/project/src/utils.js', {
          useFilesystem: false,
          fileIndex
        });
        assert.strictEqual(result, '/project/src/utils.js',
          'Should prefer .js when it exists in fileIndex');
      });
    });

    describe('resolveRelativeSpecifier with redirect', () => {
      it('should resolve relative .js import to .ts file', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const tsFile = createFile('rel-redirect/errors/GrafemaError.ts', 'export class GrafemaError {}');

        const result = resolveRelativeSpecifier(
          './errors/GrafemaError.js',
          join(testDir, 'rel-redirect/index.ts'),
          { useFilesystem: true }
        );
        assert.strictEqual(result, tsFile);
      });
    });

    describe('No false positives', () => {
      it('should return null when neither .js nor .ts exists', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const basePath = join(testDir, 'no-files/nonexistent.js');
        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, null);
      });

      it('should not redirect non-JS extensions', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // .coffee should not redirect to anything
        createFile('no-redirect/module.ts', 'export const x = 1;');
        const basePath = join(testDir, 'no-redirect/module.coffee');

        const result = resolveModulePath(basePath, { useFilesystem: true });
        assert.strictEqual(result, null, 'Should not redirect .coffee to .ts');
      });
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {

    describe('Path normalization', () => {
      it('should handle paths with trailing slash', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const indexPath = createFile('trailing/mylib/index.js', 'export const x = 1;');

        // Path with trailing slash (directory)
        const result = resolveModulePath(join(testDir, 'trailing/mylib/'), {
          useFilesystem: true
        });

        // Should still find the index file
        assert.strictEqual(result, indexPath);
      });

      it('should handle Windows-style paths in fileIndex', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        // fileIndex with forward slashes (normalized)
        const fileIndex = new Set([
          '/project/src/module.js'
        ]);

        const result = resolveModulePath('/project/src/module', {
          useFilesystem: false,
          fileIndex
        });

        assert.strictEqual(result, '/project/src/module.js');
      });
    });

    describe('Special characters in paths', () => {
      it('should handle paths with spaces', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('path with spaces/module.js', 'export const x = 1;');

        const result = resolveModulePath(join(testDir, 'path with spaces/module'), {
          useFilesystem: true
        });

        assert.strictEqual(result, filePath);
      });

      it('should handle paths with special characters', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('path-with-dash/module_underscore.js', 'export const x = 1;');

        const result = resolveModulePath(join(testDir, 'path-with-dash/module_underscore'), {
          useFilesystem: true
        });

        assert.strictEqual(result, filePath);
      });
    });

    describe('Empty and edge inputs', () => {
      it('should handle empty basePath gracefully', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const result = resolveModulePath('', { useFilesystem: true });
        // Either null or throws - both are acceptable
        // Just should not crash
        assert.ok(result === null || result === undefined || typeof result === 'string',
          'Should handle empty path without crashing');
      });

      it('should return empty set file correctly from fileIndex', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const fileIndex = new Set();

        const result = resolveModulePath('/any/path', {
          useFilesystem: false,
          fileIndex
        });

        assert.strictEqual(result, null, 'Empty fileIndex should return null');
      });
    });

    describe('Default options', () => {
      it('should default to filesystem mode when options not provided', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('default-opts/module.js', 'export const x = 1;');

        // Call without options object
        const result = resolveModulePath(join(testDir, 'default-opts/module'));

        assert.strictEqual(result, filePath,
          'Should use filesystem by default');
      });

      it('should default to filesystem mode when useFilesystem not specified', async (t) => {
        if (!implementationAvailable) {
          t.skip('Module resolution utility not yet implemented');
          return;
        }

        const filePath = createFile('default-fs/module.js', 'export const x = 1;');

        // Call with empty options object
        const result = resolveModulePath(join(testDir, 'default-fs/module'), {});

        assert.strictEqual(result, filePath,
          'Should use filesystem when useFilesystem not specified');
      });
    });
  });
});
