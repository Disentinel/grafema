/**
 * initRunner — generated config must include every JS/TS extension the
 * orchestrator indexes.
 *
 * The VS Code `Grafema: Initialize` command (`runInit`) writes
 * `.grafema/config.yaml` whose `include` glob decides which on-disk files reach
 * the analysis pipeline. Its `SUPPORTED_EXTENSIONS` list is a hand-maintained
 * port of the CLI's (`packages/cli/src/utils/quickstart.ts`) and MUST keep its
 * JS/TS subset aligned with the orchestrator's authoritative `is_js_ts_file`
 * (`packages/grafema-orchestrator/src/analyzer.rs`:
 * `js | jsx | ts | tsx | mjs | cjs | mts | cts`).
 *
 * The list historically omitted `.mts`/`.cts`. As a result a project
 * initialized from VS Code produced an `include` glob without `mts`/`cts`, so
 * ESM/CJS TypeScript files (`*.mts` / `*.cts`) were never added to the analysis
 * set and silently dropped out of the graph — even though the orchestrator
 * would have indexed them had they reached it.
 *
 * Acceptance (BDD):
 *   Given a workspace initialized via runInit,
 *   When the generated .grafema/config.yaml is read,
 *   Then its include glob contains every JS/TS extension from is_js_ts_file
 *        (js, jsx, ts, tsx, mjs, cjs, mts, cts),
 *   And the previously-present extensions are unchanged (no regression).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Mock vscode module — runInit references vscode.window.showWarningMessage
// (only on overwrite prompt, which force=true on a fresh dir skips). We inject
// a minimal mock before importing the module under test.
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    window: { showWarningMessage: async () => 'Overwrite' },
  },
} as any;

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { runInit } = require('../../src/initRunner');

// The JS/TS extensions the orchestrator indexes (analyzer.rs is_js_ts_file).
const JS_TS_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'];

let dir: string;
let includeGlob: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'grafema-vscode-init-'));
  await runInit(dir, true);
  const config = readFileSync(join(dir, '.grafema', 'config.yaml'), 'utf-8');
  // The include line looks like:  - "**/*.{js,jsx,...}"
  const match = config.match(/\*\*\/\*\.\{([^}]+)\}/);
  assert.ok(match, 'config.yaml must contain a "**/*.{...}" include glob');
  includeGlob = match[1];
});

after(() => {
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('runInit — generated include glob covers is_js_ts_file', () => {
  for (const ext of JS_TS_EXTENSIONS) {
    it(`includes "${ext}" in the analysis glob`, () => {
      const exts = includeGlob.split(',');
      assert.ok(
        exts.includes(ext),
        `include glob "{${includeGlob}}" must contain "${ext}" (orchestrator indexes *.${ext})`
      );
    });
  }
});
