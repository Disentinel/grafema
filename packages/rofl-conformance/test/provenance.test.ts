// provenance.test.ts — the report's own claim about the tree it measured.
//
// `dirtyTree` exists so a reader cannot mistake `gitSha` for «exactly this commit was
// measured». That only works while the flag can be OFF: if the run's own report files
// counted as dirt, every run after the first would light it, and an always-on warning
// warns about nothing. These tests pin both halves — own outputs are discounted, and
// anything else in the tree is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { RUN_OUTPUTS, treeDirtyBeyondOwnOutputs } from '../src/report.ts';

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = path.resolve(PKG, '../..');

test('a clean tree is not dirty', () => {
  assert.equal(treeDirtyBeyondOwnOutputs(''), false);
});

test('the run\'s own report files do not count as dirt', () => {
  const porcelain = RUN_OUTPUTS.map((p) => ` M ${p}`).join('\n');
  assert.equal(treeDirtyBeyondOwnOutputs(porcelain), false);
});

test('an engine source counts as dirt', () => {
  assert.equal(
    treeDirtyBeyondOwnOutputs(' M packages/rfdb-server/src/derive/reflect.rs'),
    true,
  );
});

test('an engine source counts even next to the run\'s own outputs', () => {
  const porcelain = [
    ' M packages/rofl-conformance/conformance-report.json',
    ' M packages/rfdb-server/src/bin/rfdb_server.rs',
    ' M _ai/research/rofl-conformance-report.md',
  ].join('\n');
  assert.equal(treeDirtyBeyondOwnOutputs(porcelain), true);
});

test('an untracked file counts as dirt', () => {
  assert.equal(treeDirtyBeyondOwnOutputs('?? packages/rfdb-server/src/derive/sneak.rs'), true);
});

test('a renamed file is judged by the name that now exists', () => {
  // Rename INTO one of the run's own outputs: the file in the tree is an own output.
  assert.equal(
    treeDirtyBeyondOwnOutputs('R  some/old/name.json -> packages/rofl-conformance/conformance-report.json'),
    false,
  );
  // Rename OUT of an own output: what sits in the tree now is a foreign name, so it counts.
  assert.equal(
    treeDirtyBeyondOwnOutputs('R  packages/rofl-conformance/conformance-report.json -> some/new/name.json'),
    true,
  );
});

test('a quoted path is unquoted before it is judged', () => {
  assert.equal(
    treeDirtyBeyondOwnOutputs(' M "packages/rofl-conformance/conformance-report.json"'),
    false,
  );
});

test('every path the run writes is on the discount list, and every discounted path is real', () => {
  // Both directions, so the list cannot quietly stop describing the files it names:
  // the writer uses RUN_OUTPUTS itself, and each entry must exist after a run.
  assert.equal(RUN_OUTPUTS.length, 3);
  for (const rel of RUN_OUTPUTS) {
    assert.equal(fs.existsSync(path.join(REPO, rel)), true, `${rel} is named but not there`);
  }
});
