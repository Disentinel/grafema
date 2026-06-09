/**
 * JS/TS extension-set coverage for `.mts` / `.cts` (ESM/CJS TypeScript).
 *
 * The orchestrator's authoritative `is_js_ts_file`
 * (packages/grafema-orchestrator/src/analyzer.rs) indexes
 * `js | jsx | ts | tsx | mjs | cjs | mts | cts`. Any CLI-side extension
 * list that is supposed to mirror that set MUST include `.mts`/`.cts`,
 * otherwise files the orchestrator happily indexes become invisible to
 * the CLI surface.
 *
 * This test pins the two `@grafema/cli` sites that drifted from that set:
 *   1. `quickstart.ts` SUPPORTED_EXTENSIONS — drives `grafema init` /
 *      `analyze --quickstart` discovery + the generated analysis glob.
 *      Missing `.mts`/`.cts` ⇒ such files are never discovered/analyzed.
 *   2. `query.ts` isFileScope — routes `grafema query "X in foo.mts"`.
 *      Missing `.mts`/`.cts` ⇒ the file scope is misread as a symbol scope.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isFileScope } from '../src/commands/query.js';
import {
  SUPPORTED_EXTENSIONS,
  scanExtensions,
  generateSmartConfig,
} from '../src/utils/quickstart.js';

describe('isFileScope (query.ts) — .mts/.cts file-scope routing', () => {
  it('recognizes a .mts file as a file scope', () => {
    assert.equal(isFileScope('app.mts'), true);
  });

  it('recognizes a .cts file as a file scope', () => {
    assert.equal(isFileScope('config.cts'), true);
  });

  // Controls: the previously-working cases must stay unchanged.
  it('still recognizes a .ts file as a file scope', () => {
    assert.equal(isFileScope('app.ts'), true);
  });

  it('does not treat a bare identifier as a file scope', () => {
    assert.equal(isFileScope('UserService'), false);
  });
});

describe('SUPPORTED_EXTENSIONS / discovery (quickstart.ts) — .mts/.cts', () => {
  it('SUPPORTED_EXTENSIONS includes mts and cts', () => {
    assert.ok(SUPPORTED_EXTENSIONS.includes('mts'), 'expected "mts" in SUPPORTED_EXTENSIONS');
    assert.ok(SUPPORTED_EXTENSIONS.includes('cts'), 'expected "cts" in SUPPORTED_EXTENSIONS');
  });

  it('scanExtensions counts .mts/.cts source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grafema-mtscts-'));
    try {
      writeFileSync(join(dir, 'esm.mts'), 'export const x = 1;\n');
      writeFileSync(join(dir, 'cjs.cts'), 'module.exports = {};\n');
      writeFileSync(join(dir, 'plain.ts'), 'export const y = 2;\n'); // control

      const counts = scanExtensions(dir);
      assert.equal(counts.get('mts'), 1, '.mts file must be discovered');
      assert.equal(counts.get('cts'), 1, '.cts file must be discovered');
      assert.equal(counts.get('ts'), 1, '.ts control must still be discovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generateSmartConfig include glob covers detected .mts/.cts', () => {
    const counts = new Map<string, number>([
      ['mts', 1],
      ['cts', 1],
    ]);
    const cfg = generateSmartConfig(counts);
    assert.match(cfg, /mts/, 'generated include glob must contain mts');
    assert.match(cfg, /cts/, 'generated include glob must contain cts');
  });
});
