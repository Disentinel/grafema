/**
 * Regression guard (class-not-instance): the RFDB client's connection-error
 * hint must not direct users to the removed auto-start flag.
 *
 * Why this matters:
 *   - `RFDBClient._enhanceConnectionError()` (packages/rfdb/ts/client.ts)
 *     rewrites low-level socket errors (ENOENT / ECONNREFUSED / EPIPE /
 *     ECONNRESET) into a human-readable hint about getting the server running.
 *   - It historically told users to use the opt-in auto-start flag. That flag
 *     was removed: auto-start is now the DEFAULT and only the negation
 *     `--no-auto-start` remains (see packages/cli/src/commands/analyze.ts; the
 *     sibling guard test/unit/AnalyzeAutoStartFlag.test.js encodes this for the
 *     `analyze` test suites).
 *   - Commander rejects unknown options, so a user who follows the stale hint
 *     and re-runs `grafema analyze` with that flag gets
 *     `error: unknown option` — the guidance actively breaks.
 *
 * This is the runtime-message sibling of AnalyzeAutoStartFlag.test.js: that one
 * guards the test suites, this one guards the user-facing client error hint.
 *
 * Premise check: if `analyze` ever re-introduces a real auto-start option, the
 * ban auto-relaxes (the flag becomes valid again), exactly like the sibling.
 *
 * Note the removed flag's leading-`--` form is NOT a substring of the valid
 * `--no-auto-start` (the leading `--` sits before `no`), so a literal scan of
 * the assembled flag does not false-match the surviving negation. The banned
 * literal is assembled from parts below so this guard does not flag itself.
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// Assemble the flag from parts so THIS guard file does not match its own scan
// (and so the sibling AnalyzeAutoStartFlag guard does not flag this file).
const FLAG = '--auto' + '-start';
const ANALYZE_CMD_SRC = join(REPO_ROOT, 'packages/cli/src/commands/analyze.ts');
const CLIENT_SRC = join(REPO_ROOT, 'packages/rfdb/ts/client.ts');

/** Whether the `analyze` command currently defines the auto-start flag as an option. */
function analyzeDefinesAutoStart() {
  const src = readFileSync(ANALYZE_CMD_SRC, 'utf8');
  return src.includes(`.option('${FLAG}'`) || src.includes(`.option("${FLAG}"`);
}

/**
 * Source of the `_enhanceConnectionError` method body (the hint strings only).
 *
 * Anchors on the method DEFINITION, not the earlier call site, and starts after
 * the doc comment — so an explanatory doc comment that names the removed flag to
 * record its history does not false-trip this scan. We only inspect the runtime
 * hint strings the user actually sees.
 */
function enhanceConnectionErrorSource() {
  const src = readFileSync(CLIENT_SRC, 'utf8');
  const def = src.indexOf('private _enhanceConnectionError');
  assert.notStrictEqual(def, -1, 'expected client.ts to define _enhanceConnectionError');
  // Capture a generous window covering the method body (short, self-contained).
  return src.slice(def, def + 1500);
}

test('RFDB client connection-error hint does not name the removed auto-start flag', () => {
  if (analyzeDefinesAutoStart()) {
    // The flag is a real option again — nothing to ban.
    return;
  }

  const body = enhanceConnectionErrorSource();
  assert.ok(
    !body.includes(FLAG),
    `_enhanceConnectionError references the removed ${FLAG} flag; commander rejects it ` +
      'as an unknown option. Auto-start is the default — point users at `rfdb-server start` ' +
      'instead.',
  );
});

test('RFDB client connection-error hint still points at a working remedy', () => {
  const body = enhanceConnectionErrorSource();
  assert.ok(
    body.includes('rfdb-server start'),
    'the connection-error hint should tell the user how to start the server (`rfdb-server start`)',
  );
});
