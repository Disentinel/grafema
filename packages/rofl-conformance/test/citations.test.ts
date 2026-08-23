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
import * as fs from 'node:fs';
import {
  scanCitations, checkCitation, checkCitations, indexCitableFiles, listCitedSources,
  stripAnchors, stripAnchorsDeep, assertNoAnchors, isUnvendoredUpstream,
  ENGINE_ROOT, ORACLE_TEST_DIR, MIN_ANCHOR_LENGTH, MAX_RANGE_LINES,
  MAX_ANCHOR_OCCURRENCES, type Citation,
} from '../src/citations.ts';

const PKG_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');
const ENGINE_FILES = indexCitableFiles(REPO_ROOT, [ENGINE_ROOT]);

function cite(text: string): Citation {
  const cs = scanCitations(text, 'test/fixture.ts', ENGINE_FILES);
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
    `expected the sources to carry citations, found ${citations.length} — the scanner or the sources changed shape`);
  for (const src of ['src/translate.ts', 'src/adapter.ts']) {
    assert.ok(citations.some((c) => c.origin.endsWith(src)), `no citation found in ${src}`);
  }
});

test('coverage is the whole of src/, read from the directory', () => {
  // The narrow two-file coverage used to be justified in prose ("the rest cites
  // the un-vendored upstream tests"), and that justification was false: 15
  // citations outside it resolved to real files and went unchecked. Coverage is
  // now the directory listing, so a new source file is covered the day it lands.
  const onDisk = fs.readdirSync(path.join(PKG_DIR, 'src')).filter((f) => f.endsWith('.ts')).sort();
  assert.deepEqual(listCitedSources(PKG_DIR), onDisk.map((f) => 'src/' + f));
  const { citations } = checkCitations(REPO_ROOT, PKG_DIR);
  for (const src of ['src/rfdb-client.ts', 'src/report.ts', 'src/canonical.ts', 'src/differential.ts']) {
    assert.ok(citations.some((c) => c.origin.endsWith(src)),
      `${src} carries resolvable citations and must be inside the gate`);
  }
});

test('what the gate cannot verify is named and counted, not hand-waved', () => {
  const { unverifiable } = checkCitations(REPO_ROOT, PKG_DIR);
  assert.ok(unverifiable.length > 0, 'expected the un-vendored upstream test citations to be counted');
  for (const c of unverifiable) {
    assert.match(c.citedPath, /phase\d+\.test\.ts$/,
      `only the un-vendored ROFL v0 test suite may be unverifiable, got ${c.raw} in ${c.origin}`);
  }
  // Positive control: they are unverifiable because the suite is genuinely absent.
  assert.equal(fs.existsSync(path.join(REPO_ROOT, ORACLE_TEST_DIR)), false);
  assert.equal(isUnvendoredUpstream(REPO_ROOT, 'test/phase2.test.ts'), true);
  assert.equal(isUnvendoredUpstream(REPO_ROOT, 'derive/exec.rs'), false);
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

// ── the three ways a green could be bought back, all closed ──

test('widening the range until the anchor is back inside is refused', () => {
  // The cheapest "repair" for a rotted citation: keep the anchor, stretch the
  // range. `datalog/parser.rs:1-400 ⟦fn parse_term⟧` used to be ACCEPTED.
  const p = problemOf('widened (datalog/parser.rs:1-400 ⟦fn parse_term⟧)');
  assert.equal(p?.kind, 'range-too-wide');
  assert.match(p!.message, new RegExp(`ceiling is ${MAX_RANGE_LINES}`));
  // and the honest citation of the same construct still passes
  assert.equal(problemOf('narrow (datalog/parser.rs:146-173 ⟦fn parse_term⟧)'), null);
});

test('an anchor that is all over the file pins nothing and is refused', () => {
  // `⟦self⟧` clears MIN_ANCHOR_LENGTH and used to be ACCEPTED on any Rust range.
  const p = problemOf('generic (datalog/parser.rs:146-173 ⟦self⟧)');
  assert.equal(p?.kind, 'anchor-too-common');
  assert.match(p!.message, new RegExp(`ceiling is ${MAX_ANCHOR_OCCURRENCES}`));
});

test('dropping the line number does not take a claim out of the gate', () => {
  // `plan.rs FactStats` was a live, unchecked claim in translate.ts: the scanner
  // only knew `path:line`, so omitting the line number was a silent exit.
  const bare = cite('ground facts are first-class EDB (plan.rs)');
  assert.equal(bare.citedPath, 'plan.rs');
  assert.equal(bare.start, null);
  assert.equal(checkCitation(REPO_ROOT, indexCitableFiles(REPO_ROOT), bare)?.kind, 'no-anchor');
  // anchored, it is a whole-file citation and holds
  assert.equal(problemOf('ground facts are first-class EDB (plan.rs ⟦struct FactStats⟧)'), null);
  // and it rots like any other
  const rotted = problemOf('ground facts are first-class EDB (plan.rs ⟦struct FactStatistics⟧)');
  assert.equal(rotted?.kind, 'anchor-not-found');
});

test('a bare mention of the frozen vendored oracle is not a citation', () => {
  // vendor/rofl-v0 is a single-commit drop pinned by REV; it does not move under
  // us, so naming the file is not a claim that can rot. The ENGINE does move.
  assert.deepEqual(scanCitations('parsing is reused from unify.ts here', 'f.ts', ENGINE_FILES), []);
  assert.equal(scanCitations('the planner (plan.rs) decides', 'f.ts', ENGINE_FILES).length, 1);
  // with no engine index at all, only ranged citations are found
  assert.deepEqual(scanCitations('the planner (plan.rs) decides', 'f.ts'), []);
});

test('anchors never reach a reader — reports are rendered through stripAnchors', () => {
  assert.equal(
    stripAnchors('v0 keeps the first witness only, store.ts:127 ⟦if (!this.witnesses.has(key))⟧, so'),
    'v0 keeps the first witness only, store.ts:127, so');
  assert.equal(stripAnchors('nothing to strip'), 'nothing to strip');
  // the shape the JSON report carries: escaped quotes inside the anchor
  assert.equal(stripAnchors('cmd (rfdb_server.rs:85 ⟦#[serde(tag = \\"cmd\\")]⟧).'), 'cmd (rfdb_server.rs:85).');
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

// A TRUNCATED anchor is the way this convention destroys a report. Report cells
// are cut to a fixed width; if a cut lands inside ⟦…⟧ the closing bracket is
// gone, and stripping the finished document then deletes everything up to the
// NEXT closing bracket — content from later rows. Measured on the real report:
// ten tier-1 rows vanished. These two tests pin the fix: strip first (deeply),
// truncate second, and refuse to publish anything still carrying an anchor.
test('stripping a document AFTER truncation eats later rows — so it is never done', () => {
  const rows = [
    'row A: the cross-join guard (plan.rs \u27E6cross-join: literal\u27E7) rejects it',
    'row B: the witness struct (exec.rs \u27E6pub struct DerivationWitness\u27E7) is flat',
    'row C: (plan.rs \u27E6struct FactStats\u27E7) survives',
  ];
  // WRONG ORDER: cut each row first, then strip the joined document
  const cutFirst = stripAnchors(rows.map((r) => r.slice(0, 40)).join('\n'));
  assert.equal(cutFirst.includes('row B'), false,
    'positive control: stripping after truncation is supposed to swallow row B');
  assert.equal(cutFirst.includes('row C'), false, 'and row C with it');
  // RIGHT ORDER: strip every string first, then cut
  const stripFirst = stripAnchorsDeep(rows).map((r) => r.slice(0, 40)).join('\n');
  for (const marker of ['row A', 'row B', 'row C']) {
    assert.equal(stripFirst.includes(marker), true, `${marker} survives strip-then-truncate`);
  }
  assert.equal(stripFirst.includes('\u27E6'), false);
});

test('stripAnchorsDeep reaches nested strings, and a leftover anchor refuses to publish', () => {
  const report = {
    tier1: [{ id: 's1', evidence: 'flat witness (exec.rs \u27E6pub struct DerivationWitness\u27E7)', n: 7, ok: true }],
    findings: ['guard (plan.rs \u27E6cross-join: literal\u27E7) holds'],
    nested: { deep: { s: 'a (plan.rs \u27E6struct FactStats\u27E7) b' } },
  };
  const clean = stripAnchorsDeep(report);
  assert.equal(clean.tier1[0].evidence, 'flat witness (exec.rs)');
  assert.equal(clean.tier1[0].n, 7);
  assert.equal(clean.tier1[0].ok, true);
  assert.equal(clean.findings[0], 'guard (plan.rs) holds');
  assert.equal(clean.nested.deep.s, 'a (plan.rs) b');
  assert.equal(assertNoAnchors(JSON.stringify(clean), 'clean report'), JSON.stringify(clean));
  assert.throws(() => assertNoAnchors(JSON.stringify(report), 'dirty report'), /still carries a citation anchor/);
});
