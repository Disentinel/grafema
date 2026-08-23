// citations.test.ts — the refusal texts must not be allowed to rot.
//
// A refusal in translate.ts / adapter.ts names a reason code, and that code is
// what the blocker matrix counts. When the citation behind a refusal slides onto
// unrelated code, the sentence keeps reading well and the matrix keeps counting
// a reason that no longer exists. This suite is the mechanical stop: it fails
// the moment a citation points at a file that moved, a range that no longer
// exists, or code that no longer contains what the refusal claims — and it also
// fails when a citation is written WITHOUT an anchor, so the convention cannot
// lapse by simply being ignored.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  scanCitations, checkCitation, checkCitations, indexCitableFiles,
  CITED_SOURCES, MIN_ANCHOR_LENGTH, type Citation,
} from '../src/citations.ts';

const PKG_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');

function cite(text: string): Citation {
  const cs = scanCitations(text, 'test/fixture.ts');
  assert.equal(cs.length, 1, `fixture must hold exactly one citation, got ${cs.length}: ${text}`);
  return cs[0];
}

function problemOf(text: string) {
  return checkCitation(REPO_ROOT, indexCitableFiles(REPO_ROOT), cite(text));
}

// ── the scanner itself finds things (a silent zero would fake a green) ──

test('scanner finds an anchored citation and splits it apart', () => {
  const c = cite('... the guard (derive/plan.rs:599-613 ⟦§3 cross-join guard⟧) rejects it');
  assert.equal(c.citedPath, 'derive/plan.rs');
  assert.equal(c.start, 599);
  assert.equal(c.end, 613);
  assert.equal(c.anchor, '§3 cross-join guard');
});

test('scanner accepts a single-line citation and an anchor wrapped onto the next comment line', () => {
  const one = cite('the tag (datalog/wire.rs:30 ⟦"~str:"⟧)');
  assert.equal(one.start, 30);
  assert.equal(one.end, 30);
  const wrapped = cite(' *  value surface, rfdb_server.rs:3202-3213\n *  ⟦resolves the bare-decimal ambiguity⟧): an');
  assert.equal(wrapped.anchor, 'resolves the bare-decimal ambiguity');
});

test('the covered sources really do contain citations', () => {
  const { citations } = checkCitations(REPO_ROOT, PKG_DIR);
  assert.ok(citations.length >= 25,
    `expected the refusal texts to carry citations, found ${citations.length} — the scanner or the sources changed shape`);
  for (const src of CITED_SOURCES) {
    assert.ok(citations.some((c) => c.origin.endsWith(src)), `no citation found in ${src}`);
  }
});

// ── THE GATE: every citation on HEAD holds ──

test('every citation in the refusal texts still points at what it claims', () => {
  const { problems } = checkCitations(REPO_ROOT, PKG_DIR);
  assert.deepEqual(problems.map((p) => p.message), [],
    `\n${problems.map((p) => `  [${p.kind}] ${p.message}`).join('\n')}\n`);
});

// ── each way a citation can be wrong is detected, and named ──

test('a citation with no anchor fails — the convention cannot lapse', () => {
  const p = problemOf('the guard rejects it (derive/plan.rs:599-613)');
  assert.equal(p?.kind, 'no-anchor');
  assert.match(p!.message, /derive\/plan\.rs:599-613/);
});

test('a degenerate anchor fails', () => {
  const p = problemOf('the guard (derive/plan.rs:599-613 ⟦if⟧)');
  assert.equal(p?.kind, 'anchor-too-short');
  assert.match(p!.message, new RegExp(`minimum is ${MIN_ANCHOR_LENGTH}`));
});

test('a citation to a file that no longer exists fails', () => {
  const p = problemOf('gone (derive/no_such_module.rs:1-3 ⟦whatever it was⟧)');
  assert.equal(p?.kind, 'file-not-found');
  assert.match(p!.message, /no_such_module\.rs/);
});

test('a citation whose path matches several files fails as ambiguous', () => {
  const p = problemOf('vague (types.rs:5-7 ⟦pub enum Term⟧)');
  assert.equal(p?.kind, 'file-ambiguous');
  assert.match(p!.message, /datalog\/types\.rs/);
});

test('a citation past the end of the file fails', () => {
  const p = problemOf('past the end (datalog/wire.rs:900000-900001 ⟦anything at all⟧)');
  assert.equal(p?.kind, 'range-out-of-file');
  assert.match(p!.message, /has \d+ lines/);
});

test('a citation whose anchor is elsewhere in the file still fails', () => {
  // `fn parse_term` is real, and it is in datalog/parser.rs — but not in 1-5.
  const p = problemOf('narrow (datalog/parser.rs:1-5 ⟦fn parse_term⟧)');
  assert.equal(p?.kind, 'anchor-not-found');
  assert.match(p!.message, /lines 1-5/);
});

test('re-indenting the cited code does not report a rot', () => {
  // The anchor is matched with whitespace runs collapsed, and it may span lines.
  const p = problemOf('spanning (datalog/parser.rs:154-164 ⟦let s = self.parse_string()?; Ok(Term::Const(s))⟧)');
  assert.equal(p, null);
});

// ── regression corpus: the rots that actually happened here ──
//
// Each entry is a citation that WAS in the sources, with the anchor its own
// prose asserted. Every one of them must be rejected against today's tree.
// Sources: run-migration/R14-stale-translator-citations.md (cases 1-3),
// run-migration/R15-citation-audit.md (case 4), and case 5 — the citation R15
// itself wrote, which rotted within a day.

const HISTORICAL_ROTS: { was: string; claim: string }[] = [
  {
    was: 'all-digit strings re-type to Value::Id (rfdb_server.rs:3205-3210 ⟦Value::Id⟧)',
    claim: 'wire strings re-type to Value::Id',
  },
  {
    was: 'no compound term form (datalog/types.rs:12-14 ⟦Const(String), /// Wildcard (_)⟧)',
    claim: 'the Term enum runs Const straight to Wildcard, so there is no functor form',
  },
  {
    was: 'the cross-join guard rejects it (derive/plan.rs:460-473 ⟦cross-join: literal⟧)',
    claim: 'the §3 cross-join guard lives here',
  },
  {
    was: 'RFDB witness is flat (exec.rs:248 ⟦pub struct DerivationWitness⟧)',
    claim: 'the witness struct lives here',
  },
  {
    was: 'RFDB witness is flat (derive/exec.rs:279-287 ⟦pub struct DerivationWitness⟧)',
    claim: 'the witness struct lives here — written 2026-08-23, rotted the same day',
  },
];

test('every citation that historically rotted here is caught', () => {
  const index = indexCitableFiles(REPO_ROOT);
  const missed: string[] = [];
  for (const rot of HISTORICAL_ROTS) {
    const p = checkCitation(REPO_ROOT, index, cite(rot.was));
    if (p === null) missed.push(`${rot.was} — claim: ${rot.claim}`);
    else assert.equal(p.kind, 'anchor-not-found', `${rot.was}: expected anchor-not-found, got ${p.kind}`);
  }
  assert.deepEqual(missed, [], `these rotted citations were NOT caught:\n  ${missed.join('\n  ')}`);
});
