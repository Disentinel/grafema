// citations.ts — makes this package's prose about engine/oracle code
// mechanically falsifiable.
//
// THE PROBLEM. Every refusal in translate.ts / adapter.ts justifies itself by
// pointing at engine or oracle code: "... the derive program parser has no
// functor form (datalog/parser.rs:146-173 ⟦fn parse_term⟧)". The engine moves,
// the line range slides onto unrelated code, and the sentence keeps sounding
// convincing. That is not a cosmetic defect: the reason code attached to each
// refusal is what the blocker matrix counts, so a rotted justification
// mis-plans the whole roadmap. Measured on this package: 4 of 5 engine-side
// citations were dead, and a fresh one rotted within a day of being written.
//
// THE CONVENTION. Two citation forms, both of which MUST carry a verbatim
// ANCHOR in white square brackets — a literal snippet that has to be present
// in the cited code:
//
//   RANGED     (datalog/parser.rs:146-173 ⟦fn parse_term⟧)   anchor must sit
//                                                            inside those lines
//   WHOLE-FILE (derive/plan.rs ⟦struct FactStats⟧)           anchor must sit
//                                                            somewhere in the file
//
// The delimiters are U+27E6 / U+27E7 (see ANCHOR_OPEN / ANCHOR_CLOSE); they
// occur nowhere else in the sources and survive inside single-quoted strings,
// template literals and comments alike. They are SOURCE-SIDE bookkeeping:
// stripAnchors() removes them from anything this package renders for a reader
// (see report.ts), so the convention never leaks into the deliverable.
//
// checkCitations() then decides without understanding a word of the prose:
//   1. the anchor is present at all — an UNANCHORED citation is itself a
//      failure, so the convention cannot quietly lapse by omission;
//   2. the cited path resolves to exactly one file under CITATION_ROOTS;
//   3. a ranged citation's lines exist and span at most MAX_RANGE_LINES, so
//      "widen the range until the anchor is back inside" stops being the
//      cheapest way to silence this check;
//   4. the anchor occurs inside the cited lines (whitespace runs collapsed to a
//      single space, so re-indentation alone never reports a rot) and occurs at
//      most MAX_ANCHOR_OCCURRENCES times in the whole file, so a generic token
//      (`self`, `Ok(T`) cannot stand in for a real landmark.
//
// WHY A BARE FILE NAME IS ALSO A CITATION. Dropping the `:line` used to take a
// claim out of this check entirely — `plan.rs ⟦struct FactStats⟧` named a
// construct and nothing verified it. So a bare mention of an ENGINE file
// (ENGINE_ROOT) is a whole-file citation and needs an anchor too. A bare mention of the vendored
// oracle is NOT: vendor/rofl-v0 is a frozen drop (single commit c64138ce, the
// upstream revision pinned in vendor/rofl-v0/REV) — it does not move under us,
// while packages/rfdb-server/src moves daily and is where all four measured
// rots happened. Ranged citations are checked in BOTH roots.
//
// WHAT AN ANCHOR CAN AND CANNOT PROVE. An anchor proves PRESENCE. A refusal
// that claims an ABSENCE ("the parser has no functor form") cannot be anchored
// on the absent thing. Anchor such a claim on the CLOSED CONSTRUCT that makes
// the absence checkable — the dispatch function, the enum head — and, when the
// claim is "these cases and nothing else", let the anchor SPAN the boundary of
// the enumeration (`Const(String), /// Wildcard (_)`), so inserting a new case
// in the middle breaks the anchor. Beyond that, absence stays a probe's job.
// A HISTORICAL claim ("the fix REMOVED that debug_assert") must not cite the
// file at all — there is nothing left in it to anchor on.
//
// COVERAGE. Every .ts file in src/ is scanned (listCitedSources reads the
// directory, so a new file is covered the day it is added). What this check
// cannot reach is named, not hand-waved: citations into the ROFL v0 upstream
// test suite (test/phaseN.test.ts), which this repo does not vendor —
// vendor/rofl-v0 holds only src/, LIMITS.md, boot.rofl, examples/, scripts/
// and REV. Those come back as `unverifiable`, are counted, and start being
// checked for real the moment that test directory is vendored.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ANCHOR_OPEN = '⟦';
export const ANCHOR_CLOSE = '⟧';

/** The engine: moves daily, source of every measured citation rot. Bare file
 *  mentions of it count as whole-file citations. Repo-root-relative. */
export const ENGINE_ROOT = 'packages/rfdb-server/src';
/** The vendored oracle: a frozen drop pinned by vendor/rofl-v0/REV. */
export const ORACLE_ROOT = 'packages/rofl-conformance/vendor/rofl-v0';

/** Roots a cited path is resolved against, as a path SUFFIX (so `datalog/wire.rs`
 *  ⟦"~term:"⟧ and `engine.ts` both work). */
export const CITATION_ROOTS = [ENGINE_ROOT, ORACLE_ROOT];

/** The ROFL v0 upstream test suite, not vendored here. A citation into it is
 *  reported as unverifiable rather than checked — unless the directory shows
 *  up, in which case the citations start being checked like any other. */
export const ORACLE_TEST_DIR = ORACLE_ROOT + '/test';
const UPSTREAM_TEST_RE = /(^|\/)phase\d+\.test\.ts$/;

const CITED_EXTENSIONS = ['rs', 'ts', 'md', 'rofl'];

/** A path with a citable extension, optionally followed by `:line` or `:from-to`. */
const CITATION_RE = new RegExp(
  `([A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:${CITED_EXTENSIONS.join('|')}))(?::(\\d+)(?:-(\\d+))?)?`,
  'g',
);

// An anchor may sit right after the citation, after the backtick that prose
// often wraps a path in, or wrap onto the next comment line.
const ANCHOR_RE = new RegExp(
  '^[ \\t]*`?[ \\t]*' +
    `(?:\\r?\\n[ \\t]*(?:\\/\\/|\\*)[ \\t]*)?${ANCHOR_OPEN}([^${ANCHOR_CLOSE}]*)${ANCHOR_CLOSE}`,
);

/** Shortest anchor accepted, in normalized characters. */
export const MIN_ANCHOR_LENGTH = 4;

/** How many times an anchor may occur in the cited FILE. An anchor that is all
 *  over the file pins nothing: the range can slide anywhere and still contain
 *  it. Measured on the 27 anchors this convention started with: all but one sat
 *  at 1-2 occurrences, while a bare `self` in datalog/parser.rs
 *  ⟦fn parse_term⟧ sits at 121 — too common to be citable at all. */
export const MAX_ANCHOR_OCCURRENCES = 3;

/** Widest line range accepted. A citation points at a construct, not at a
 *  module; without a ceiling the cheapest repair for a rotted citation is to
 *  widen it until the anchor is back inside. Measured: the widest honest
 *  citation in this package spans 59 lines
 *  (datalog/parser.rs:165-223 ⟦Value::Int(i)⟧). */
export const MAX_RANGE_LINES = 80;

export interface Citation {
  /** File the citation was written in, repo-root-relative. */
  origin: string;
  /** Line within `origin` where the citation text starts. */
  originLine: number;
  /** The citation as written, e.g. `datalog/parser.rs:146-173`
   *  ⟦fn parse_term⟧ or `plan.rs` ⟦struct FactStats⟧. */
  raw: string;
  /** Cited path as written (a suffix of a real path). */
  citedPath: string;
  /** Line range, or null for a whole-file citation. */
  start: number | null;
  end: number | null;
  /** Anchor text as written, or null when the citation carries none. */
  anchor: string | null;
}

export type ProblemKind =
  | 'no-anchor'
  | 'anchor-too-short'
  | 'anchor-too-common'
  | 'file-not-found'
  | 'file-ambiguous'
  | 'bad-range'
  | 'range-out-of-file'
  | 'range-too-wide'
  | 'anchor-not-found';

export interface CitationProblem {
  kind: ProblemKind;
  citation: Citation;
  /** Human-readable, names THIS citation and THIS defect. */
  message: string;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Remove anchor markup from text meant for a reader. Anchors are source-side
 *  bookkeeping; a rendered report must read exactly as it did before the
 *  convention existed. */
export function stripAnchors(s: string): string {
  return s.replace(
    new RegExp(`[ \\t]*${ANCHOR_OPEN}[^${ANCHOR_CLOSE}]*${ANCHOR_CLOSE}`, 'g'),
    '',
  );
}

/** Strip anchors from every string inside a value, recursively.
 *
 *  WHY THIS EXISTS AND WHY IT IS NOT `stripAnchors(renderedDocument)`: report
 *  text is TRUNCATED for display (table cells are cut at 200-220 chars), and a
 *  cut can land inside an anchor. Stripping afterwards then sees a half-open
 *  `ANCHOR_OPEN` and, because the closing bracket is missing, deletes everything
 *  up to the next one — which in a rendered document is a LATER ROW. Measured:
 *  stripping the finished markdown swallowed ten table rows. So anchors come off
 *  every string BEFORE anything is cut, and the finished document is then only
 *  ASSERTED anchor-free (`assertNoAnchors`), never edited. */
export function stripAnchorsDeep<T>(value: T): T {
  if (typeof value === 'string') return stripAnchors(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => stripAnchorsDeep(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripAnchorsDeep(v);
    return out as unknown as T;
  }
  return value;
}

/** Refuse to publish a document that still carries an anchor. An anchor is
 *  source-side bookkeeping for the citation gate; a reader must never see one,
 *  and a surviving one means some string reached the page without passing
 *  through `stripAnchorsDeep`. */
export function assertNoAnchors(text: string, what: string): string {
  const open = text.indexOf(ANCHOR_OPEN);
  const at = open >= 0 ? open : text.indexOf(ANCHOR_CLOSE);
  if (at >= 0) {
    throw new Error(
      `${what} still carries a citation anchor at offset ${at}: ` +
        JSON.stringify(text.slice(Math.max(0, at - 100), at + 100)),
    );
  }
  return text;
}

/** True for a path that names the un-vendored ROFL v0 upstream test suite. */
export function isUnvendoredUpstream(repoRoot: string, citedPath: string): boolean {
  if (!UPSTREAM_TEST_RE.test(citedPath)) return false;
  return !fs.existsSync(path.join(repoRoot, ORACLE_TEST_DIR));
}

/**
 * Pull every citation out of one source text: ranged (`path:from-to`) always,
 * and bare `path` when it names a file under `engineFiles` — the engine is the
 * side that moves, so a bare mention of it is a whole-file citation.
 */
export function scanCitations(text: string, origin: string, engineFiles: string[] = []): Citation[] {
  const out: Citation[] = [];
  CITATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(text)) !== null) {
    const citedPath = m[1];
    const ranged = m[2] !== undefined;
    if (!ranged && !engineFiles.some((f) => f === citedPath || f.endsWith('/' + citedPath))) continue;
    const rest = text.slice(m.index + m[0].length);
    const am = ANCHOR_RE.exec(rest);
    const anchorRaw = am ? am[1] : null;
    out.push({
      origin,
      originLine: text.slice(0, m.index).split('\n').length,
      raw: m[0],
      citedPath,
      start: ranged ? Number(m[2]) : null,
      end: ranged ? (m[3] === undefined ? Number(m[2]) : Number(m[3])) : null,
      anchor: anchorRaw !== null && normalize(anchorRaw).length > 0 ? anchorRaw : null,
    });
  }
  return out;
}

function listFiles(dir: string, acc: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'target' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, acc);
    else if (CITED_EXTENSIONS.includes(path.extname(e.name).slice(1))) acc.push(full);
  }
}

/** Every citable file under `roots`, repo-root-relative, with `/` separators. */
export function indexCitableFiles(repoRoot: string, roots: string[] = CITATION_ROOTS): string[] {
  const acc: string[] = [];
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    if (fs.existsSync(abs)) listFiles(abs, acc);
  }
  return acc.map((f) => path.relative(repoRoot, f).split(path.sep).join('/')).sort();
}

/** Every .ts file in the package's src/, package-relative — read from the
 *  directory so a newly added file is covered without editing a list. */
export function listCitedSources(packageDir: string): string[] {
  return fs
    .readdirSync(path.join(packageDir, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => 'src/' + f);
}

/** Check one citation against the tree. Returns null when it holds. */
export function checkCitation(
  repoRoot: string,
  index: string[],
  c: Citation,
): CitationProblem | null {
  const at = `${c.origin}:${c.originLine} cites ${c.raw}`;
  const problem = (kind: ProblemKind, why: string): CitationProblem => ({
    kind,
    citation: c,
    message: `${at} — ${why}`,
  });

  if (c.anchor === null) {
    return problem(
      'no-anchor',
      `no anchor. Every citation must be followed by ${ANCHOR_OPEN}verbatim snippet${ANCHOR_CLOSE} ` +
        `that is present in the cited code, otherwise nothing can tell whether the citation still holds`,
    );
  }
  const needle = normalize(c.anchor);
  if (needle.length < MIN_ANCHOR_LENGTH) {
    return problem(
      'anchor-too-short',
      `anchor ${ANCHOR_OPEN}${needle}${ANCHOR_CLOSE} is ${needle.length} chars, ` +
        `minimum is ${MIN_ANCHOR_LENGTH} — a shorter one matches almost any range`,
    );
  }

  const hits = index.filter((f) => f === c.citedPath || f.endsWith('/' + c.citedPath));
  if (hits.length === 0) {
    return problem(
      'file-not-found',
      `no file under ${CITATION_ROOTS.join(' or ')} ends with '${c.citedPath}' — the file was renamed, moved or removed`,
    );
  }
  if (hits.length > 1) {
    return problem(
      'file-ambiguous',
      `'${c.citedPath}' matches ${hits.length} files (${hits.join(', ')}) — add enough leading path to make it unique`,
    );
  }
  const target = hits[0];
  const lines = fs.readFileSync(path.join(repoRoot, target), 'utf8').split('\n');

  if (c.start !== null && c.end !== null) {
    if (c.start < 1 || c.end < c.start) {
      return problem('bad-range', `line range ${c.start}-${c.end} is not a range`);
    }
    if (c.end > lines.length) {
      return problem(
        'range-out-of-file',
        `${target} has ${lines.length} lines, the citation asks for ${c.start}-${c.end}`,
      );
    }
    const span = c.end - c.start + 1;
    if (span > MAX_RANGE_LINES) {
      return problem(
        'range-too-wide',
        `line range ${c.start}-${c.end} spans ${span} lines, the ceiling is ${MAX_RANGE_LINES} — ` +
          `a citation points at a construct, not at a module; widening a range is not a repair`,
      );
    }
  }

  const whole = normalize(lines.join('\n'));
  const occurrences = countOccurrences(whole, needle);
  if (occurrences === 0) {
    return problem(
      'anchor-not-found',
      `anchor ${ANCHOR_OPEN}${needle}${ANCHOR_CLOSE} is NOT anywhere in ${target} — ` +
        `the cited code moved, so the justification no longer says what it claims`,
    );
  }
  if (occurrences > MAX_ANCHOR_OCCURRENCES) {
    return problem(
      'anchor-too-common',
      `anchor ${ANCHOR_OPEN}${needle}${ANCHOR_CLOSE} occurs ${occurrences} times in ${target}, ` +
        `the ceiling is ${MAX_ANCHOR_OCCURRENCES} — an anchor that common pins nothing, ` +
        `pick a snippet that only the cited code carries`,
    );
  }

  if (c.start !== null && c.end !== null) {
    const haystack = normalize(lines.slice(c.start - 1, c.end).join('\n'));
    if (!haystack.includes(needle)) {
      return problem(
        'anchor-not-found',
        `anchor ${ANCHOR_OPEN}${needle}${ANCHOR_CLOSE} is NOT in ${target} lines ${c.start}-${c.end} — ` +
          `the cited code moved, so the justification no longer says what it claims`,
      );
    }
  }
  return null;
}

export interface CitationReport {
  /** Citations that were checked. */
  citations: Citation[];
  /** Citations into the un-vendored ROFL v0 upstream test suite: named,
   *  counted, and not checkable until that suite is vendored. */
  unverifiable: Citation[];
  problems: CitationProblem[];
}

/** Scan `sources` (package-relative) and check every citation they contain. */
export function checkCitations(
  repoRoot: string,
  packageDir: string,
  sources: string[] = listCitedSources(packageDir),
): CitationReport {
  const index = indexCitableFiles(repoRoot);
  const engineFiles = indexCitableFiles(repoRoot, [ENGINE_ROOT]);
  const citations: Citation[] = [];
  const unverifiable: Citation[] = [];
  for (const rel of sources) {
    const abs = path.join(packageDir, rel);
    const origin = path.relative(repoRoot, abs).split(path.sep).join('/');
    for (const c of scanCitations(fs.readFileSync(abs, 'utf8'), origin, engineFiles)) {
      if (isUnvendoredUpstream(repoRoot, c.citedPath)) unverifiable.push(c);
      else citations.push(c);
    }
  }
  const problems: CitationProblem[] = [];
  for (const c of citations) {
    const p = checkCitation(repoRoot, index, c);
    if (p) problems.push(p);
  }
  return { citations, unverifiable, problems };
}
