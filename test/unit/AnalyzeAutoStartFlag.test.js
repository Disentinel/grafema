/**
 * Regression guard (class-not-instance): no test suite may invoke
 * `grafema analyze` with the `--auto-start` flag, because the `analyze` command
 * no longer defines it.
 *
 * Why this matters:
 *   - `analyze` historically had an opt-in `--auto-start` flag (REG-435). It
 *     was later changed so auto-start is the DEFAULT and only the negation
 *     `--no-auto-start` remains (see `packages/cli/src/commands/analyze.ts`).
 *   - Commander rejects unknown options, so `grafema analyze --auto-start`
 *     exits 1 with `error: unknown option '--auto-start'` BEFORE any analysis
 *     or server work runs. Every `beforeEach` that did
 *     `runCli(['analyze', '--auto-start'], ...)` therefore failed its
 *     `assert.strictEqual(status, 0)` setup step unconditionally, in every
 *     environment — silently disabling ~11 CLI command-test files plus the
 *     `semantic-id-stability` integration test. (These package/integration
 *     suites are not in CI's `test/unit/*.test.js` coverage path, so the
 *     breakage went unnoticed.)
 *   - The fix dropped the redundant flag from those suites (auto-start is the
 *     default, so the flag was a pure no-op even when it had existed). This
 *     guard encodes the invariant structurally so a future suite cannot
 *     silently reintroduce the dead flag.
 *
 * Premise check below: if `analyze` ever re-introduces a real `--auto-start`
 * option, the ban auto-relaxes (the flag becomes valid again).
 *
 * Note `--auto-start` is NOT a substring of the valid `--no-auto-start` (the
 * leading `--` sits before `no`), so a literal scan does not false-match it.
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// Assemble the flag from parts so THIS guard file does not match its own scan.
const FLAG = '--auto' + '-start';
const ANALYZE_CMD_SRC = join(REPO_ROOT, 'packages/cli/src/commands/analyze.ts');

/** Whether the `analyze` command currently defines `--auto-start` as an option. */
function analyzeDefinesAutoStart() {
  const src = readFileSync(ANALYZE_CMD_SRC, 'utf8');
  // A commander option is registered via `.option('--auto-start', ...)`.
  return src.includes(`.option('${FLAG}'`) || src.includes(`.option("${FLAG}"`);
}

/** Recursively collect every *.test.js / *.test.ts file, skipping vendored/build dirs. */
function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (/\.test\.(js|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test('no test suite invokes `grafema analyze` with the removed `--auto-start` flag', () => {
  if (analyzeDefinesAutoStart()) {
    // The flag is a real option again — nothing to ban.
    return;
  }

  const selfPath = fileURLToPath(import.meta.url);
  const offenders = [];
  for (const file of collectTestFiles(REPO_ROOT)) {
    if (file === selfPath) continue; // this guard names the flag in prose
    const src = readFileSync(file, 'utf8');
    if (src.includes(FLAG)) {
      offenders.push(
        `${file} passes the removed \`${FLAG}\` flag to \`grafema analyze\` — ` +
          'commander rejects it as an unknown option (exit 1), failing setup. ' +
          'Auto-start is the default; drop the flag.',
      );
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'test suites must not pass the removed `--auto-start` flag to `grafema analyze`:\n' +
      offenders.join('\n'),
  );
});
