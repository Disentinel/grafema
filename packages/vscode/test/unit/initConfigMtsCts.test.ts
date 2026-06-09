/**
 * Unit tests for initConfig.ts — VS Code init must emit a config `include`
 * glob that covers every JS/TS extension the orchestrator indexes.
 *
 * Authoritative source of truth: `is_js_ts_file` in
 * packages/grafema-orchestrator/src/analyzer.rs (js | jsx | ts | tsx | mjs |
 * cjs | mts | cts). The VS Code "Grafema: Init" command writes
 * `.grafema/config.yaml` whose `include` glob is built from
 * SUPPORTED_EXTENSIONS. When that list drifts behind analyzer.rs, the generated
 * glob silently excludes the missing extensions — `.mts`/`.cts` files then never
 * reach analysis even though the analyzer supports them, leaving holes in the
 * graph for an entire class of TypeScript modules.
 *
 * initConfig.ts is pure (no `vscode` import) so these assertions run on the
 * REAL generated config string, not a source-text grep.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_EXTENSIONS, generateConfigYAML } from '../../src/initConfig';

/** The orchestrator's indexed JS/TS extension set (analyzer.rs is_js_ts_file). */
const ORCHESTRATOR_JS_TS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'];

describe('initConfig — JS/TS extension coverage (analyzer.rs drift-guard)', () => {
  it('SUPPORTED_EXTENSIONS covers every JS/TS extension the orchestrator indexes', () => {
    for (const ext of ORCHESTRATOR_JS_TS) {
      assert.ok(
        SUPPORTED_EXTENSIONS.includes(ext),
        `SUPPORTED_EXTENSIONS is missing '${ext}', which analyzer.rs is_js_ts_file indexes — ` +
          `the generated config glob would silently exclude .${ext} files`
      );
    }
  });

  it('generated config.yaml include glob contains .mts and .cts', () => {
    const yaml = generateConfigYAML();
    const globLine = yaml.split('\n').find((l) => l.includes('**/*.{'));
    assert.ok(globLine, 'config.yaml must contain an include glob "**/*.{...}"');

    // Extract the brace group "{js,jsx,...}" and check membership exactly.
    const match = globLine!.match(/\{([^}]+)\}/);
    assert.ok(match, 'include glob must use a brace-expansion extension set');
    const globExts = match![1].split(',');

    for (const ext of ORCHESTRATOR_JS_TS) {
      assert.ok(
        globExts.includes(ext),
        `include glob is missing '${ext}' — .${ext} files would be dropped from analysis`
      );
    }
  });

  it('keeps every previously-listed language extension (no accidental removal)', () => {
    // Representative non-JS/TS extensions that must remain covered.
    const others = ['rs', 'java', 'kt', 'py', 'go', 'hs', 'cpp', 'swift', 'ex', 'erl'];
    for (const ext of others) {
      assert.ok(
        SUPPORTED_EXTENSIONS.includes(ext),
        `SUPPORTED_EXTENSIONS unexpectedly dropped '${ext}'`
      );
    }
  });
});
