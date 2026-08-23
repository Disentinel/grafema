// citations.ts — makes the harness's refusal texts mechanically falsifiable.
//
// THE PROBLEM. Every refusal in translate.ts / adapter.ts justifies itself by
// pointing at engine or oracle code: "... the derive program parser has no
// functor form (datalog/parser.rs:146-173)". The engine moves, the line range
// slides onto unrelated code, and the sentence keeps sounding convincing. That
// is not a cosmetic defect: the reason code attached to each refusal is what the
// blocker matrix counts, so a rotted justification mis-plans the whole roadmap.
// Measured on this package: 4 of 5 engine-side citations were dead, and a fresh
// one rotted within a day of being written.
//
// THE CONVENTION. A citation is any `path:line` or `path:from-to` occurring in a
// CITED_SOURCES file. Every citation MUST be followed by a verbatim ANCHOR in
// white square brackets — a short literal snippet that has to be present inside
// the cited lines:
//
//     (datalog/parser.rs:146-173 ⟦fn parse_term⟧)
//
// The delimiters are U+27E6 / U+27E7 (see ANCHOR_OPEN / ANCHOR_CLOSE); they were
// picked because they occur nowhere else in the sources and survive inside
// single-quoted strings, template literals and comments alike.
//
// checkCitations() then decides without understanding a word of the prose:
//   1. the anchor is present at all — an UNANCHORED citation is itself a failure,
//      so the convention cannot quietly lapse the moment someone forgets it;
//   2. the cited path resolves to exactly one file under CITATION_ROOTS;
//   3. that file really has those lines;
//   4. the anchor occurs inside them, comparing with whitespace runs collapsed to
//      a single space, so re-indentation alone never reports a rot.
//
// WHAT AN ANCHOR CAN AND CANNOT PROVE. An anchor proves PRESENCE. A refusal that
// claims an ABSENCE ("the parser has no functor form") cannot be anchored on the
// absent thing. Anchor such a claim on the CLOSED CONSTRUCT that makes the
// absence checkable — the dispatch function, the enum head — and, when the claim
// is "these cases and nothing else", let the anchor SPAN the boundary of the
// enumeration (`Const(String), /// Wildcard (_)`), so inserting a new case in the
// middle breaks the anchor. Beyond that, absence stays a probe's job, not a
// citation's.
//
// NOTE: prose in THIS file writes line numbers as N-M on purpose, so that an
// illustration is never mistaken for a citation of its own.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ANCHOR_OPEN = '⟦';
export const ANCHOR_CLOSE = '⟧';

/** Roots a cited path is resolved against, as a path SUFFIX (so `datalog/wire.rs`
 *  and `engine.ts` both work). Repo-root-relative. The engine side is the RFDB
 *  server; the oracle side is the vendored ROFL v0 the harness compares against. */
export const CITATION_ROOTS = [
  'packages/rfdb-server/src',
  'packages/rofl-conformance/vendor/rofl-v0',
];

/** Files whose citations are covered. These are the two files that carry REFUSAL
 *  texts — the sentences that set a scenario's reason code. Other files in src/
 *  cite the ROFL v0 upstream TEST SUITE (`test/phase*.test.ts`), which this repo
 *  does not vendor (vendor/rofl-v0 holds only src/, LIMITS.md, boot.rofl and the
 *  upstream revision in REV), so those citations have nothing to resolve against
 *  here and are out of this check's reach. */
export const CITED_SOURCES = ['src/translate.ts', 'src/adapter.ts'];

const CITED_EXTENSIONS = ['rs', 'ts', 'md', 'rofl'];

const CITATION_RE = new RegExp(
  `([A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:${CITED_EXTENSIONS.join('|')})):(\\d+)(?:-(\\d+))?`,
  'g',
);

// An anchor may sit right after the citation, or wrap onto the next comment line.
const ANCHOR_RE = new RegExp(
  `^[ \\t]*(?:\\r?\\n[ \\t]*(?:\\/\\/|\\*)[ \\t]*)?${ANCHOR_OPEN}([^${ANCHOR_CLOSE}]*)${ANCHOR_CLOSE}`,
);

/** Shortest anchor accepted, in normalized characters. Bars degenerate anchors
 *  like `(` or `fn` that would match almost any range. */
export const MIN_ANCHOR_LENGTH = 4;

export interface Citation {
  /** File the citation was written in, repo-root-relative. */
  origin: string;
  /** Line within `origin` where the citation text starts. */
  originLine: number;
  /** The citation as written, e.g. `datalog/parser.rs:146-173`. */
  raw: string;
  /** Cited path as written (a suffix of a real path). */
  citedPath: string;
  start: number;
  end: number;
  /** Anchor text as written, or null when the citation carries none. */
  anchor: string | null;
}

export type ProblemKind =
  | 'no-anchor'
  | 'anchor-too-short'
  | 'file-not-found'
  | 'file-ambiguous'
  | 'bad-range'
  | 'range-out-of-file'
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

/** Pull every citation (anchored or not) out of one source text. */
export function scanCitations(text: string, origin: string): Citation[] {
  const out: Citation[] = [];
  CITATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    const am = ANCHOR_RE.exec(rest);
    const anchorRaw = am ? am[1] : null;
    out.push({
      origin,
      originLine: text.slice(0, m.index).split('\n').length,
      raw: m[0],
      citedPath: m[1],
      start: Number(m[2]),
      end: m[3] === undefined ? Number(m[2]) : Number(m[3]),
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

/** Every citable file under CITATION_ROOTS, repo-root-relative, with `/` separators. */
export function indexCitableFiles(repoRoot: string): string[] {
  const acc: string[] = [];
  for (const root of CITATION_ROOTS) {
    const abs = path.join(repoRoot, root);
    if (fs.existsSync(abs)) listFiles(abs, acc);
  }
  return acc.map((f) => path.relative(repoRoot, f).split(path.sep).join('/')).sort();
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
        `that is present in the cited lines, otherwise nothing can tell whether the citation still holds`,
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

  if (c.start < 1 || c.end < c.start) {
    return problem('bad-range', `line range ${c.start}-${c.end} is not a range`);
  }
  const lines = fs.readFileSync(path.join(repoRoot, target), 'utf8').split('\n');
  if (c.end > lines.length) {
    return problem(
      'range-out-of-file',
      `${target} has ${lines.length} lines, the citation asks for ${c.start}-${c.end}`,
    );
  }

  const haystack = normalize(lines.slice(c.start - 1, c.end).join('\n'));
  if (!haystack.includes(needle)) {
    return problem(
      'anchor-not-found',
      `anchor ${ANCHOR_OPEN}${needle}${ANCHOR_CLOSE} is NOT in ${target} lines ${c.start}-${c.end} — ` +
        `the cited code moved, so the justification no longer says what it claims`,
    );
  }
  return null;
}

export interface CitationReport {
  citations: Citation[];
  problems: CitationProblem[];
}

/** Scan `sources` (package-relative) and check every citation they contain. */
export function checkCitations(
  repoRoot: string,
  packageDir: string,
  sources: string[] = CITED_SOURCES,
): CitationReport {
  const index = indexCitableFiles(repoRoot);
  const citations: Citation[] = [];
  for (const rel of sources) {
    const abs = path.join(packageDir, rel);
    const origin = path.relative(repoRoot, abs).split(path.sep).join('/');
    citations.push(...scanCitations(fs.readFileSync(abs, 'utf8'), origin));
  }
  const problems: CitationProblem[] = [];
  for (const c of citations) {
    const p = checkCitation(repoRoot, index, c);
    if (p) problems.push(p);
  }
  return { citations, problems };
}
