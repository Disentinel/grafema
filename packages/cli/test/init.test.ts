/**
 * Tests for `grafema init` command - REG-385
 *
 * Validates:
 * - runAnalyze() uses process.execPath instead of 'node' to avoid
 *   PATH lookup failures when nvm isn't loaded in the shell.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('grafema init', () => {
  describe('REG-385: spawn uses process.execPath', () => {
    it('should use process.execPath instead of hardcoded "node" for subprocess', () => {
      // Read the compiled init.js to verify the spawn call uses process.execPath.
      // This prevents PATH lookup failures when nvm isn't loaded.
      const initPath = join(__dirname, '../dist/commands/init.js');
      const initSource = readFileSync(initPath, 'utf-8');

      assert.ok(
        initSource.includes('process.execPath'),
        'init.js should use process.execPath for spawning the analyze subprocess'
      );

      // Verify we don't have the old pattern: spawn('node', [...])
      // Match spawn call with literal 'node' as first argument
      const hasHardcodedNode = /spawn\(\s*['"]node['"]/.test(initSource);
      assert.ok(
        !hasHardcodedNode,
        'init.js should NOT use hardcoded "node" in spawn() — use process.execPath instead'
      );
    });
  });
});
