/**
 * Unit test for `resolveProjectRoot` (REG-1154) — extracted from the identical
 * realpath/project-root block that `file.ts` and `explain.ts` each duplicated.
 *
 * The behavior that matters: realpath the project root so it shares a base with
 * the realpath'd file paths the graph stores (a symlinked root like macOS
 * `/tmp` -> `/private/tmp` otherwise makes files read NOT_ANALYZED), and fall
 * back to the plain resolved path (no throw) when the directory does not exist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { resolveProjectRoot } from '../dist/utils/pathUtils.js';

describe('resolveProjectRoot (REG-1154)', () => {
  it('follows a symlinked root to its realpath', () => {
    const parent = mkdtempSync(join(tmpdir(), 'rpr-'));
    try {
      const real = join(parent, 'real');
      mkdirSync(real);
      const link = join(parent, 'link');
      symlinkSync(real, link);
      assert.strictEqual(resolveProjectRoot(link), realpathSync(real));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('returns the resolved path (no throw) for a non-existent directory', () => {
    const missing = join(tmpdir(), '__rpr_missing__', 'nope');
    assert.strictEqual(resolveProjectRoot(missing), resolve(missing));
  });
});
