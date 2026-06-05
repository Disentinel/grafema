/**
 * Regression guard (class-not-instance): every test suite that creates a
 * throwaway git repo and runs `git commit` in a fixture must disable commit
 * signing locally (`git config commit.gpgsign false`), so the fixture commits
 * never invoke the host's gpg/ssh signing program.
 *
 * Why this matters:
 *   - A host with a global `commit.gpgsign=true` (GitHub Verified-badge setups,
 *     managed CI, the remote-execution environment whose ssh signing program
 *     returns HTTP 400 for synthetic identities like `alice@test.com`) makes
 *     EVERY fixture `git commit` fail with "fatal: failed to write commit
 *     object". In `GitIngest.test.js` this cascaded to 7 failures (2 commit
 *     errors + 5 cancelled subtests) even though the code under test is
 *     correct — a pure environment-leak / non-hermeticity bug.
 *   - The fix is to set `commit.gpgsign false` in the repo's local config
 *     right after `git init`. This guard encodes that invariant structurally
 *     so a future fixture cannot silently reintroduce the leak on a host where
 *     signing happens to be off (where the bug is invisible).
 *
 * The discriminating behavior (the suite goes green under global signing) is
 * proven by running `GitIngest.test.js` itself on a signing-enabled host.
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = join(__dirname, '..');

// Detect a fixture that actually creates commits: an execSync (or similar)
// invocation of `git commit ...`. Assembled from parts so this guard file does
// not match its own scan even before the self-skip below.
const COMMIT_NEEDLE = 'git ' + 'commit';
const SIGNING_DISABLE_NEEDLE = 'commit.gpgsign false';

/** Recursively collect every *.test.js / *.test.ts file under test/. */
function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (/\.test\.(js|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test('test fixtures that run `git commit` disable commit signing locally', () => {
  const selfPath = fileURLToPath(import.meta.url);
  const offenders = [];
  for (const file of collectTestFiles(TEST_ROOT)) {
    if (file === selfPath) continue; // this guard names the pattern in prose
    const src = readFileSync(file, 'utf8');
    if (src.includes(COMMIT_NEEDLE) && !src.includes(SIGNING_DISABLE_NEEDLE)) {
      offenders.push(
        `${file} runs \`git commit\` in a fixture but never sets ` +
          '`commit.gpgsign false` — it will fail on hosts with global commit signing.',
      );
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'git-fixture tests must disable commit signing locally for hermeticity:\n' +
      offenders.join('\n'),
  );
});
