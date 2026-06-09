/**
 * Regression: the VS Code init discovery list must cover `.mts` / `.cts`.
 *
 * `initRunner.SUPPORTED_EXTENSIONS` is joined into the generated
 * `.grafema/config.yaml` include glob (`**\/*.{js,jsx,...}`) and drives which
 * files a freshly-initialised project will analyze. It hand-maintained a JS/TS
 * list that omitted `.mts`/`.cts`, diverging from the orchestrator's
 * authoritative set in `is_js_ts_file`
 * (packages/grafema-orchestrator/src/analyzer.rs:326):
 *
 *     matches!(ext, "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts")
 *
 * Result: a project whose only sources were `.mts`/`.cts` got a config glob that
 * silently excluded them. This is the documented PR #372 follow-up site
 * `packages/vscode/src/initRunner.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// Mock vscode module — initRunner imports `vscode`, but SUPPORTED_EXTENSIONS
// does not touch any vscode API; a minimal stub satisfies the import.
// ============================================================================

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};

require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    window: {},
    workspace: { workspaceFolders: [] },
  },
} as unknown as NodeModule;

// The full JS/TS extension set the orchestrator analyzes (analyzer.rs:326).
const JS_TS_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'];

describe('initRunner SUPPORTED_EXTENSIONS — JS/TS coverage', () => {
  it('covers every JS/TS extension the orchestrator analyzes (incl. .mts/.cts)', async () => {
    const { SUPPORTED_EXTENSIONS } = await import('../../src/initRunner');
    for (const ext of JS_TS_EXTENSIONS) {
      assert.ok(
        SUPPORTED_EXTENSIONS.includes(ext),
        `SUPPORTED_EXTENSIONS is missing "${ext}" — drifted from analyzer.rs is_js_ts_file`,
      );
    }
  });
});
