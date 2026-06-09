/**
 * Regression: module resolution must be able to resolve `.mts` / `.cts` source
 * files, because the Rust orchestrator's `is_js_ts_file`
 * (`packages/grafema-orchestrator/src/analyzer.rs`) analyzes and indexes them.
 *
 * `DEFAULT_EXTENSIONS` omitted `.mts`/`.cts` and `DEFAULT_INDEX_FILES` omitted
 * `index.mts`/`index.cts`, so an extensionless import (`./foo`) whose only
 * on-disk file is `foo.mts`/`foo.cts`, or a directory import resolving to
 * `index.mts`/`index.cts`, silently failed to resolve (returned null).
 *
 * The `TS_EXTENSION_REDIRECTS` table (`.mjs`->`.mts`, `.cjs`->`.cts`) only fires
 * when the specifier ALREADY carries an extension, so extensionless / directory
 * forms were genuinely unreachable.
 *
 * Hermetic: in-memory resolution mode (`useFilesystem: false` + `fileIndex`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  resolveModulePath,
  DEFAULT_EXTENSIONS,
  DEFAULT_INDEX_FILES,
  JS_TS_EXTENSIONS,
} from '@grafema/util';

const inMemory = (fileIndex) => ({ useFilesystem: false, fileIndex: new Set(fileIndex) });

describe('resolveModulePath — .mts / .cts resolution', () => {
  it('resolves an extensionless import to a .mts file', () => {
    const resolved = resolveModulePath('/app/foo', inMemory(['/app/foo.mts']));
    assert.strictEqual(resolved, '/app/foo.mts');
  });

  it('resolves an extensionless import to a .cts file', () => {
    const resolved = resolveModulePath('/app/legacy', inMemory(['/app/legacy.cts']));
    assert.strictEqual(resolved, '/app/legacy.cts');
  });

  it('resolves a directory import to index.mts', () => {
    const resolved = resolveModulePath('/app/sub', inMemory(['/app/sub/index.mts']));
    assert.strictEqual(resolved, '/app/sub/index.mts');
  });

  it('resolves a directory import to index.cts', () => {
    const resolved = resolveModulePath('/app/sub', inMemory(['/app/sub/index.cts']));
    assert.strictEqual(resolved, '/app/sub/index.cts');
  });

  it('still prefers an exact .ts sibling over a .mts when both exist (order preserved)', () => {
    // .ts precedes .mts in the probe order, so existing first-match behaviour is
    // unchanged for the extensions that already resolved.
    const resolved = resolveModulePath(
      '/app/foo',
      inMemory(['/app/foo.ts', '/app/foo.mts']),
    );
    assert.strictEqual(resolved, '/app/foo.ts');
  });
});

describe('module-resolution extension lists cover the canonical JS/TS set (drift guard)', () => {
  it('DEFAULT_EXTENSIONS covers exactly JS_TS_EXTENSIONS (ignoring the exact-match "")', () => {
    const probed = new Set(DEFAULT_EXTENSIONS.filter(Boolean));
    const canonical = new Set(JS_TS_EXTENSIONS);
    assert.deepStrictEqual(
      [...probed].sort(),
      [...canonical].sort(),
      'DEFAULT_EXTENSIONS must probe every orchestrator-indexed JS/TS extension and no more',
    );
  });

  it('DEFAULT_INDEX_FILES covers exactly index.<ext> for JS_TS_EXTENSIONS', () => {
    const probed = new Set(DEFAULT_INDEX_FILES);
    const canonical = new Set(JS_TS_EXTENSIONS.map((ext) => `index${ext}`));
    assert.deepStrictEqual(
      [...probed].sort(),
      [...canonical].sort(),
      'DEFAULT_INDEX_FILES must probe index.<ext> for every orchestrator-indexed JS/TS extension',
    );
  });
});
