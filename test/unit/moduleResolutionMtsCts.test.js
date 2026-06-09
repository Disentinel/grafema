/**
 * Module resolution — `.mts` / `.cts` extension coverage.
 *
 * The shared `resolveModulePath` utility (packages/util/src/utils/moduleResolution.ts)
 * is consumed by MountPointResolver, JSModuleIndexer, FunctionCallResolver and
 * IncrementalModuleIndexer. Its candidate-extension set MUST equal the set of
 * JS/TS extensions the orchestrator actually indexes — `is_js_ts_file` in
 * packages/grafema-orchestrator/src/analyzer.rs:326:
 *
 *   matches!(ext, "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts")
 *
 * `DEFAULT_EXTENSIONS` / `DEFAULT_INDEX_FILES` historically omitted `.mts` and
 * `.cts` (the `TS_EXTENSION_REDIRECTS` map only rescued *explicit* `.mjs`/`.cjs`
 * specifiers). As a result an extensionless relative import — `import './foo'` —
 * whose definition lives in `foo.mts` / `foo.cts`, and a directory import whose
 * entry point is `index.mts` / `index.cts`, resolved to `null` even though the
 * orchestrator had indexed those files. This left a real, graph-present
 * definition unreachable to the resolver.
 *
 * Acceptance (BDD):
 *   Given a definition that exists ONLY in a `.mts` (resp. `.cts`) file,
 *   When `resolveModulePath` is asked for the extensionless base path,
 *   Then it resolves to that `.mts` (resp. `.cts`) file.
 *   And the same holds for directory imports resolving to `index.mts`/`index.cts`.
 *   And every previously-resolving case (`.ts`/`.js`/...) is byte-for-byte unchanged.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveModulePath, DEFAULT_EXTENSIONS, DEFAULT_INDEX_FILES } from '@grafema/util';

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'grafema-mr-mtscts-'));

  // Definitions that exist ONLY in .mts / .cts (no JS/TS sibling).
  writeFileSync(join(dir, 'alpha.mts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'beta.cts'), 'export const b = 1;\n');

  // Directory entry points in .mts / .cts.
  mkdirSync(join(dir, 'pkgm'));
  writeFileSync(join(dir, 'pkgm', 'index.mts'), 'export const m = 1;\n');
  mkdirSync(join(dir, 'pkgc'));
  writeFileSync(join(dir, 'pkgc', 'index.cts'), 'export const c = 1;\n');

  // Controls — must keep resolving exactly as before.
  writeFileSync(join(dir, 'gamma.ts'), 'export const g = 1;\n');
  mkdirSync(join(dir, 'pkgts'));
  writeFileSync(join(dir, 'pkgts', 'index.ts'), 'export const t = 1;\n');

  // Preference control: when both .ts and .mts exist, .ts still wins (no regression).
  writeFileSync(join(dir, 'both.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'both.mts'), 'export const x = 2;\n');
});

after(() => {
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('resolveModulePath — .mts / .cts coverage', () => {
  it('resolves an extensionless import to a .mts definition', () => {
    assert.equal(resolveModulePath(join(dir, 'alpha')), join(dir, 'alpha.mts'));
  });

  it('resolves an extensionless import to a .cts definition', () => {
    assert.equal(resolveModulePath(join(dir, 'beta')), join(dir, 'beta.cts'));
  });

  it('resolves a directory import to index.mts', () => {
    assert.equal(resolveModulePath(join(dir, 'pkgm')), join(dir, 'pkgm', 'index.mts'));
  });

  it('resolves a directory import to index.cts', () => {
    assert.equal(resolveModulePath(join(dir, 'pkgc')), join(dir, 'pkgc', 'index.cts'));
  });

  it('still resolves extensionless .ts (control, unchanged)', () => {
    assert.equal(resolveModulePath(join(dir, 'gamma')), join(dir, 'gamma.ts'));
  });

  it('still resolves directory index.ts (control, unchanged)', () => {
    assert.equal(resolveModulePath(join(dir, 'pkgts')), join(dir, 'pkgts', 'index.ts'));
  });

  it('prefers .ts over .mts when both exist (determinism, no regression)', () => {
    assert.equal(resolveModulePath(join(dir, 'both')), join(dir, 'both.ts'));
  });

  it('exposes .mts/.cts in the canonical extension/index lists', () => {
    assert.ok(DEFAULT_EXTENSIONS.includes('.mts'), 'DEFAULT_EXTENSIONS must include .mts');
    assert.ok(DEFAULT_EXTENSIONS.includes('.cts'), 'DEFAULT_EXTENSIONS must include .cts');
    assert.ok(DEFAULT_INDEX_FILES.includes('index.mts'), 'DEFAULT_INDEX_FILES must include index.mts');
    assert.ok(DEFAULT_INDEX_FILES.includes('index.cts'), 'DEFAULT_INDEX_FILES must include index.cts');
  });
});
