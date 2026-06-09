/**
 * Regression: CLI JS/TS extension lists must cover `.mts` / `.cts`.
 *
 * The orchestrator's authoritative set of JS/TS extensions is `is_js_ts_file`
 * (packages/grafema-orchestrator/src/analyzer.rs:326):
 *
 *     matches!(ext, "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts")
 *
 * Two CLI sites hand-maintained shorter JS/TS lists that omitted `.mts`/`.cts`,
 * so TypeScript-ESM (`.mts`) and TypeScript-CommonJS (`.cts`) source files were
 * silently dropped from project discovery / config generation (quickstart) and
 * misclassified as node names rather than file paths (query scope routing).
 *
 * This is the documented follow-up class from PR #372 / #370 for the two
 * remaining standalone CLI sites:
 *   - packages/cli/src/utils/quickstart.ts   (SUPPORTED_EXTENSIONS, scanExtensions, config glob)
 *   - packages/cli/src/commands/query.ts     (isFileScope file-path routing regex)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SUPPORTED_EXTENSIONS, scanExtensions } from '../src/utils/quickstart.js';
import { isFileScope } from '../src/commands/query.js';

// The full JS/TS extension set the orchestrator analyzes (analyzer.rs:326).
const JS_TS_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'];

describe('quickstart SUPPORTED_EXTENSIONS — JS/TS coverage', () => {
  it('covers every JS/TS extension the orchestrator analyzes (incl. .mts/.cts)', () => {
    for (const ext of JS_TS_EXTENSIONS) {
      assert.ok(
        SUPPORTED_EXTENSIONS.includes(ext),
        `SUPPORTED_EXTENSIONS is missing "${ext}" — drifted from analyzer.rs is_js_ts_file`,
      );
    }
  });
});

describe('quickstart scanExtensions — discovers .mts/.cts sources', () => {
  it('counts a .mts file during project discovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grafema-ext-mts-'));
    try {
      writeFileSync(join(dir, 'index.mts'), 'export const a = 1;\n');
      const counts = scanExtensions(dir);
      assert.strictEqual(counts.get('mts'), 1, '.mts source must be discovered, not dropped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a .cts file during project discovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grafema-ext-cts-'));
    try {
      writeFileSync(join(dir, 'legacy.cts'), 'module.exports = {};\n');
      const counts = scanExtensions(dir);
      assert.strictEqual(counts.get('cts'), 1, '.cts source must be discovered, not dropped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('query isFileScope — routes .mts/.cts as file paths', () => {
  it('treats a .mts scope as a file path', () => {
    assert.strictEqual(isFileScope('module.mts'), true);
  });

  it('treats a .cts scope as a file path', () => {
    assert.strictEqual(isFileScope('legacy.cts'), true);
  });

  it('still rejects a bare identifier (no false positives)', () => {
    assert.strictEqual(isFileScope('fetchData'), false);
  });
});
