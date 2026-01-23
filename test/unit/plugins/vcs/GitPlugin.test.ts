/**
 * GitPlugin Error Handling Tests
 *
 * Tests for REG-146: GitPlugin error handling with GrafemaError
 *
 * These tests verify that GitPlugin methods throw FileAccessError
 * with appropriate codes and suggestions instead of returning
 * silent fallback values.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

import { GitPlugin, FileAccessError, GrafemaError } from '@grafema/core';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a GitPlugin with mocked _exec method
 */
function createMockedGitPlugin(
  execMock: (command: string) => Promise<{ stdout: string; stderr: string }>
): GitPlugin {
  const plugin = new GitPlugin({ rootPath: '/test/project' });

  // Override the private _exec method
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any)._exec = execMock;

  return plugin;
}

/**
 * Create a mock that throws an error
 */
function createFailingExecMock(errorMessage = 'Command failed'): () => Promise<never> {
  return async () => {
    throw new Error(errorMessage);
  };
}

/**
 * Create a mock that returns specific output
 */
function createSuccessExecMock(
  stdout: string,
  stderr = ''
): () => Promise<{ stdout: string; stderr: string }> {
  return async () => ({ stdout, stderr });
}

// =============================================================================
// TESTS: getChangedFiles() error handling
// =============================================================================

describe('GitPlugin', () => {
  describe('getChangedFiles()', () => {
    it('should throw FileAccessError when git status fails', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('git: command not found'));

      await assert.rejects(
        async () => plugin.getChangedFiles(),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.strictEqual(error.code, 'ERR_GIT_ACCESS_DENIED');
          assert.ok(error.message.includes('Failed to get changed files'));
          assert.ok(error.message.includes('git: command not found'));
          assert.strictEqual(error.context.plugin, 'GitPlugin');
          assert.ok(error.suggestion?.includes('git'));
          return true;
        }
      );
    });

    it('should throw FileAccessError with ERR_GIT_ACCESS_DENIED code', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('permission denied'));

      await assert.rejects(
        async () => plugin.getChangedFiles(),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.strictEqual(error.code, 'ERR_GIT_ACCESS_DENIED');
          return true;
        }
      );
    });

    it('should return empty array when no changes (not throw)', async () => {
      const plugin = createMockedGitPlugin(createSuccessExecMock(''));

      const result = await plugin.getChangedFiles();
      assert.deepStrictEqual(result, []);
    });
  });

  // ===========================================================================
  // TESTS: getFileDiff() error handling
  // ===========================================================================

  describe('getFileDiff()', () => {
    it('should throw FileAccessError when git diff fails', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('fatal: not a git repository'));

      await assert.rejects(
        async () => plugin.getFileDiff('src/app.js'),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.strictEqual(error.code, 'ERR_GIT_ACCESS_DENIED');
          assert.ok(error.message.includes('Failed to get diff for src/app.js'));
          assert.strictEqual(error.context.filePath, 'src/app.js');
          assert.strictEqual(error.context.plugin, 'GitPlugin');
          return true;
        }
      );
    });

    it('should include file path in error context', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('error'));

      await assert.rejects(
        async () => plugin.getFileDiff('path/to/file.ts'),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.strictEqual(error.context.filePath, 'path/to/file.ts');
          return true;
        }
      );
    });

    it('should return empty hunks when no diff (not throw)', async () => {
      const plugin = createMockedGitPlugin(createSuccessExecMock(''));

      const result = await plugin.getFileDiff('unchanged.js');
      assert.deepStrictEqual(result, { path: 'unchanged.js', hunks: [] });
    });
  });

  // ===========================================================================
  // TESTS: getCurrentBranch() error handling
  // ===========================================================================

  describe('getCurrentBranch()', () => {
    it('should throw FileAccessError when git rev-parse fails', async () => {
      const plugin = createMockedGitPlugin(
        createFailingExecMock('fatal: not a git repository')
      );

      await assert.rejects(
        async () => plugin.getCurrentBranch(),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.strictEqual(error.code, 'ERR_GIT_ACCESS_DENIED');
          assert.ok(error.message.includes('Failed to get current branch'));
          assert.strictEqual(error.context.plugin, 'GitPlugin');
          assert.ok(error.suggestion?.includes('git repository'));
          return true;
        }
      );
    });

    it('should NOT return "unknown" on failure (breaking change)', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('error'));

      // Should throw, not return 'unknown'
      await assert.rejects(async () => plugin.getCurrentBranch());
    });

    it('should return branch name on success', async () => {
      const plugin = createMockedGitPlugin(createSuccessExecMock('main\n'));

      const result = await plugin.getCurrentBranch();
      assert.strictEqual(result, 'main');
    });
  });

  // ===========================================================================
  // TESTS: getLastCommitHash() error handling
  // ===========================================================================

  describe('getLastCommitHash()', () => {
    it('should throw FileAccessError when git rev-parse HEAD fails', async () => {
      const plugin = createMockedGitPlugin(
        createFailingExecMock("fatal: ambiguous argument 'HEAD'")
      );

      await assert.rejects(
        async () => plugin.getLastCommitHash(),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.strictEqual(error.code, 'ERR_GIT_NOT_FOUND');
          assert.ok(error.message.includes('Failed to get last commit hash'));
          assert.strictEqual(error.context.plugin, 'GitPlugin');
          assert.ok(error.suggestion?.includes('commit'));
          return true;
        }
      );
    });

    it('should NOT return null on failure (breaking change)', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('error'));

      // Should throw, not return null
      await assert.rejects(async () => plugin.getLastCommitHash());
    });

    it('should return commit hash on success', async () => {
      const plugin = createMockedGitPlugin(
        createSuccessExecMock('abc123def456\n')
      );

      const result = await plugin.getLastCommitHash();
      assert.strictEqual(result, 'abc123def456');
    });
  });

  // ===========================================================================
  // TESTS: getAllTrackedFiles() error handling
  // ===========================================================================

  describe('getAllTrackedFiles()', () => {
    it('should throw FileAccessError when git ls-files fails', async () => {
      const plugin = createMockedGitPlugin(
        createFailingExecMock('fatal: not a git repository')
      );

      await assert.rejects(
        async () => plugin.getAllTrackedFiles(),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.strictEqual(error.code, 'ERR_GIT_ACCESS_DENIED');
          assert.ok(error.message.includes('Failed to get tracked files'));
          assert.strictEqual(error.context.plugin, 'GitPlugin');
          return true;
        }
      );
    });

    it('should NOT return empty array on failure (breaking change)', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('error'));

      // Should throw, not return []
      await assert.rejects(async () => plugin.getAllTrackedFiles());
    });

    it('should return file list on success', async () => {
      const plugin = createMockedGitPlugin(
        createSuccessExecMock('file1.js\nfile2.ts\n')
      );

      const result = await plugin.getAllTrackedFiles();
      assert.deepStrictEqual(result, ['file1.js', 'file2.ts']);
    });
  });

  // ===========================================================================
  // TESTS: getLastCommitInfo() error handling
  // ===========================================================================

  describe('getLastCommitInfo()', () => {
    it('should throw FileAccessError when git log fails', async () => {
      const plugin = createMockedGitPlugin(
        createFailingExecMock("fatal: your current branch 'main' does not have any commits yet")
      );

      await assert.rejects(
        async () => plugin.getLastCommitInfo(),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.strictEqual(error.code, 'ERR_GIT_NOT_FOUND');
          assert.ok(error.message.includes('Failed to get last commit info'));
          assert.strictEqual(error.context.plugin, 'GitPlugin');
          assert.ok(error.suggestion?.includes('commit'));
          return true;
        }
      );
    });

    it('should NOT return null on failure (breaking change)', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('error'));

      // Should throw, not return null
      await assert.rejects(async () => plugin.getLastCommitInfo());
    });

    it('should return commit info on success', async () => {
      const plugin = createMockedGitPlugin(
        createSuccessExecMock('abc123\nJohn Doe\njohn@example.com\n1700000000\nTest commit')
      );

      const result = await plugin.getLastCommitInfo();
      assert.ok(result);
      assert.strictEqual(result.hash, 'abc123');
      assert.strictEqual(result.author, 'John Doe');
      assert.strictEqual(result.email, 'john@example.com');
      assert.strictEqual(result.message, 'Test commit');
    });
  });

  // ===========================================================================
  // TESTS: Methods that SHOULD keep returning fallback values
  // ===========================================================================

  describe('isAvailable()', () => {
    it('should return false on failure (NOT throw)', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('error'));

      // isAvailable checks availability - returning false is correct behavior
      const result = await plugin.isAvailable();
      assert.strictEqual(result, false);
    });
  });

  describe('isTracked()', () => {
    it('should return false when file is not tracked (NOT throw)', async () => {
      const plugin = createMockedGitPlugin(
        createFailingExecMock('error: pathspec did not match any file(s)')
      );

      // isTracked uses --error-unmatch which exits non-zero for untracked
      const result = await plugin.isTracked('untracked-file.js');
      assert.strictEqual(result, false);
    });
  });

  describe('getCommittedContent()', () => {
    it('should return null when file does not exist in HEAD (NOT throw)', async () => {
      let callCount = 0;
      const plugin = createMockedGitPlugin(async (command: string) => {
        callCount++;
        if (command.includes('ls-files')) {
          return { stdout: 'new-file.js\n', stderr: '' };
        }
        if (command.includes('git show')) {
          throw new Error("fatal: path 'new-file.js' does not exist in 'HEAD'");
        }
        return { stdout: '', stderr: '' };
      });

      // New files don't exist in HEAD - returning null is correct
      const result = await plugin.getCommittedContent('new-file.js');
      assert.strictEqual(result, null);
    });
  });

  // ===========================================================================
  // TESTS: Error structure and instanceof checks
  // ===========================================================================

  describe('Error structure', () => {
    it('thrown errors should be instanceof GrafemaError', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('error'));

      await assert.rejects(
        async () => plugin.getChangedFiles(),
        (error: unknown) => {
          assert.ok(error instanceof GrafemaError);
          assert.ok(error instanceof FileAccessError);
          assert.ok(error instanceof Error);
          return true;
        }
      );
    });

    it('thrown errors should have all required properties', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('test error'));

      await assert.rejects(
        async () => plugin.getCurrentBranch(),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          assert.ok('code' in error);
          assert.ok('severity' in error);
          assert.ok('message' in error);
          assert.ok('context' in error);
          assert.ok('suggestion' in error);
          return true;
        }
      );
    });

    it('thrown errors should be serializable via toJSON()', async () => {
      const plugin = createMockedGitPlugin(createFailingExecMock('serialization test'));

      await assert.rejects(
        async () => plugin.getAllTrackedFiles(),
        (error: unknown) => {
          assert.ok(error instanceof FileAccessError);
          const json = error.toJSON();
          assert.strictEqual(json.code, 'ERR_GIT_ACCESS_DENIED');
          assert.strictEqual(json.severity, 'error');
          assert.ok(json.message.includes('Failed to get tracked files'));
          assert.strictEqual(json.context.plugin, 'GitPlugin');
          return true;
        }
      );
    });
  });
});
