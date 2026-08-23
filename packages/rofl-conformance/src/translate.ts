// translate.ts — neutral-JSON (v0 Clause objects) → RFDB v1 derive dialect.
//
// Returns a full Translation or a typed failure carrying a reason code from the
// CLOSED taxonomy. The checks run PROGRAM-WIDE in a fixed phase order so the
// reported code is deterministic and matches the migration roadmap semantics
// (e.g. boot.rofl fails at phase 1 with missing:rules-as-data even though it
// also contains [audit] perspectives).
//
// Dialect facts this encoding rests on (all live-probed against rfdb-server):
//   • ground facts in program text are first-class EDB (plan.rs FactStats);
//   • executeDatalog returns the FIRST rule head's predicate → callers hoist;
//   • user predicates are namespaced `u_<rel>`: v0 rel names may collide with
//     RFDB base relations (node/type/edge/incoming/attr — phase1 TC uses
//     `edge`!) and with derive builtins (`path` is a builtin filter name);
//   • a negated literal may contain NO free variable (E-PLAN-002); wildcards
//     in negated literals evaluate existentially over the bound columns
//     (engine fix for ROFL F1 — the former silent mis-evaluation is gone, so
//     the aux-predicate projection workaround was removed);
//   • a body literal over a predicate with no facts and no rules is a legal
//     EMPTY relation: positive leg → no rows, negated leg → vacuous pass
//     (engine fix for ROFL F2 — the former debug-build hang is gone, so the
//     empty-predicate-elimination workaround was removed);
//   • a variable-free body literal (ground probe / all-wildcard leg) is a
//     FILTER, safe in any planner position (engine fix for ROFL F3 — the
//     former post-reorder E-PLAN-003 false reject is gone, so the translator
//     no longer rejects ground body literals); a rule body whose
//     variable-carrying positive premises are DISCONNECTED is still rejected
//     by the structural cross-join guard (E-PLAN-003, by design);
//   • v0 ATOM and v0 INTEGER constants both translate and stay DISTINCT: an
//     atom goes out as a quoted const, an integer as a BARE numeric literal
//     that the program parser types as Value::Int (datalog/parser.rs:165-223)
//     and that comes back tagged `~int:N`. Live-probed (R15/P1, see
//     run-migration/R15-citation-audit.md): `u_p(1)` and `u_p("1")` dump as
//     `~int:1` and `1` and do NOT join; an int literal also works as a body
//     filter, in a rule head, and as an explain key. v0 STRING constants still
//     do NOT translate — program text has a single quoted-const surface, so a
//     v0 string and the v0 atom of the same spelling become one value
//     (live-probed R15/P3a). Integers past i64/2^53 stay missing:bignum: that
//     is the ORACLE's ceiling (LIMITS.md:49-51), checked first.

import type { Clause, Lit, BodyElem, Term } from './neutral.ts';
import { RESERVED, IFACE } from '../vendor/rofl-v0/src/reflect.ts';

export type ReasonCode =
  | 'missing:perspectives'
  | 'missing:rules-as-data'
  | 'missing:holes'
  | 'missing:compound-terms'
  | 'missing:bignum'
  | 'missing:whynot-shape'
  | 'missing:temporal'
  | 'missing:excise'
  | 'missing:retract'
  | 'missing:snapshot'
  | 'missing:demand-mode'
  | 'engine:limit-abort'
  | 'dialect:untranslatable';

export const REASON_CODES: ReasonCode[] = [
  'missing:perspectives', 'missing:rules-as-data', 'missing:holes',
  'missing:compound-terms', 'missing:bignum', 'missing:whynot-shape',
  'missing:temporal', 'missing:excise', 'missing:retract', 'missing:snapshot',
  'missing:demand-mode', 'engine:limit-abort', 'dialect:untranslatable',
];

export class UnsupportedFeature extends Error {
  code: ReasonCode;
  detail: string;
  constructor(code: ReasonCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

const PFX = 'u_';
const I64_MAX = 9223372036854775807n;

interface TransRule {
  rel: string;              // original head rel
  text: string;             // translated RFDB rule line
  headVars: string[];       // renamed head variable names, positional
}

export interface Translation {
  ok: true;
  /** Translated rules, original order; use with facts via renderSource(). */
  rules: TransRule[];
  /** original rel → deduped ground-fact tuples in v0-CANONICAL text
   *  (atom → name, integer → decimal), positional. */
  groundFacts: Map<string, string[][]>;
  /** the same tuples in RFDB PROGRAM text (atom → quoted const, integer → bare
   *  numeric literal) — what renderSource() puts on the wire. */
  groundFactTerms: Map<string, string[][]>;
  /** original rel → arity. */
  relArity: Map<string, number>;
  /** all original rels mentioned anywhere in the program. */
  programRels: string[];
}

export interface TranslationFailure { ok: false; code: ReasonCode; detail: string; }

export type TranslateResult = Translation | TranslationFailure;

function fail(code: ReasonCode, detail: string): TranslationFailure {
  return { ok: false, code, detail };
}

function litsOf(c: Clause): Lit[] {
  const out = [c.head];
  for (const b of c.body) if (b.t === 'pos' || b.t === 'neg') out.push(b.lit);
  return out;
}

function isWildcard(t: Term): boolean {
  return t.k === 'v' && t.name.startsWith('_$');
}

/** RFDB program text for a checked constant term: a v0 atom becomes a quoted
 *  const, a v0 integer a BARE numeric literal, which the program parser types
 *  as `Value::Int` rather than as a string const or a node id
 *  (datalog/parser.rs:165-223). */
function constText(t: Term): string {
  if (t.k === 'a') return `"${t.name}"`;
  if (t.k === 'i') return String(t.v);
  throw new Error(`unreachable constant kind ${t.k} after checks`);
}

/** v0-canonical text for a checked constant term — exactly unify.ts:79-87
 *  canonTerm: an atom renders as its name, an integer as its decimal. The two
 *  never collide, because a v0 atom is lexed as `[a-z][A-Za-z0-9_]*` and can
 *  never be all-digit (a leading digit is lexed as an int, parser.ts:52-63). */
function constCanon(t: Term): string {
  if (t.k === 'a') return t.name;
  if (t.k === 'i') return String(t.v);
  throw new Error(`unreachable constant kind ${t.k} after checks`);
}

/** Wire value → the v0-canonical constant text it denotes. A translated program
 *  can put only two constant shapes on the wire: a quoted const (an atom, echoed
 *  verbatim) and a bare numeric literal (an integer, echoed tagged as `~int:N`,
 *  live-probed R15/P1a). Injective, by the same all-digit argument as
 *  [`constCanon`]. */
export function wireToCanon(w: string): string {
  const m = /^~int:(-?\d+)$/.exec(w);
  return m ? m[1] : w;
}

/** v0-canonical constant text → the v0 Term it denotes; the inverse of
 *  [`constCanon`], used to re-unify engine-returned tuples against a query
 *  literal whose integer args are `{k:'i'}`, not atoms. */
export function canonToTerm(s: string): Term {
  return /^-?\d+$/.test(s) ? { k: 'i', v: Number(s) } : { k: 'a', name: s };
}

/** Checked ground constant → its wire form for an `explain` key (the READ
 *  direction of the protocol's value surface, rfdb_server.rs:3202-3213): an
 *  atom is its bare name, an integer is `~int:N` (live-probed R15/P1f). */
export function constToWireKey(t: Term): string {
  if (t.k === 'a') return t.name;
  if (t.k === 'i') return `~int:${t.v}`;
  throw new Error(`unreachable constant kind ${t.k} in an explain key`);
}

/** Check a single literal's terms for untranslatable constants; returns a
 *  failure or null. Shared by translate() and the adapter's query-literal path. */
export function checkLitTerms(lit: Lit, where: string): TranslationFailure | null {
  for (const a of lit.args) {
    if (a.k === 'f') {
      return fail('missing:compound-terms', `functor term '${a.name}(…)' in ${where}: the derive program parser has no functor form — parse_term accepts wildcard, quoted const, variable, bare const and number, nothing else (datalog/parser.rs:146-173). Live-probed R15/P2: 'u_p(f(a, b)).' in a fact, in a body and in a head each come back "Datalog parse error"; the ~term: tag (datalog/wire.rs:31) is a WIRE form, rejected in program text`);
    }
    if (a.k === 'i') {
      const abs = BigInt(Math.abs(a.v));
      if (abs > I64_MAX || Math.abs(a.v) > Number.MAX_SAFE_INTEGER) {
        return fail('missing:bignum', `integer ${a.v} in ${where} exceeds the safe-integer range the v0 ORACLE can hold (LIMITS.md:49-51 — no bignums, JS safe-integer range), so the two engines would disagree by construction; RFDB itself holds it exactly (live-probed R15/P1e: 2^68 dumps as ~big:295147905179352825856)`);
      }
      continue; // translates as a bare numeric literal — see constText()
    }
    if (a.k === 's') {
      return fail('dialect:untranslatable', `string constant ${JSON.stringify(a.v)} in ${where}: derive program text has exactly ONE quoted-const surface (datalog/parser.rs:154-164), so a v0 string and the v0 atom of the same spelling become the same engine value — live-probed R15/P3a, u_p("hello") joins u_q(hello) and yields a row. The ~str: tag that separates them on the wire (datalog/wire.rs:30) is not program-text syntax (R15/P3c: parse error)`);
    }
  }
  return null;
}

export function checkLitMeta(lit: Lit, where: string): TranslationFailure | null {
  if (lit.rel !== IFACE.stratum && lit.rel !== IFACE.unstratified && RESERVED.has(lit.rel)) {
    return fail('missing:rules-as-data', `reflection-vocabulary relation '${lit.rel}' in ${where}: RFDB has no rules-as-data / provenance relations`);
  }
  if (lit.rel === IFACE.stratum || lit.rel === IFACE.unstratified) {
    return fail('missing:rules-as-data', `stratification-interface relation '${lit.rel}' in ${where}: RFDB stratification is internal, not queryable data`);
  }
  if (lit.persp.k === 'v') {
    return fail('missing:perspectives', `perspective variable in ${where}: RFDB has no perspective dimension`);
  }
  if (lit.persp.k === 'a' && lit.persp.name !== 'main') {
    return fail('missing:perspectives', `perspective [${lit.persp.name}] in ${where}: RFDB has no perspective dimension`);
  }
  if (lit.temporal !== 'now') {
    return fail('missing:temporal', `'@${lit.temporal}' in ${where}: RFDB has no tick semantics`);
  }
  return null;
}

export function translate(clauses: Clause[]): TranslateResult {
  // ── Phase 1: reflection vocabulary ─────────────────────────────
  for (const [ci, c] of clauses.entries()) {
    for (const lit of litsOf(c)) {
      if (RESERVED.has(lit.rel) || lit.rel === IFACE.stratum || lit.rel === IFACE.unstratified) {
        return checkLitMeta(lit, `clause ${ci + 1}`)!;
      }
    }
  }
  // ── Phase 2: perspectives ──────────────────────────────────────
  for (const [ci, c] of clauses.entries()) {
    for (const lit of litsOf(c)) {
      if (lit.persp.k === 'v' || (lit.persp.k === 'a' && lit.persp.name !== 'main')) {
        return checkLitMeta(lit, `clause ${ci + 1}`)!;
      }
    }
  }
  // ── Phase 3: temporal ──────────────────────────────────────────
  for (const [ci, c] of clauses.entries()) {
    for (const lit of litsOf(c)) {
      if (lit.temporal !== 'now') return checkLitMeta(lit, `clause ${ci + 1}`)!;
    }
  }
  // ── Phase 4: compound terms ────────────────────────────────────
  for (const [ci, c] of clauses.entries()) {
    for (const lit of litsOf(c)) {
      for (const a of lit.args) {
        if (a.k === 'f') return checkLitTerms(lit, `clause ${ci + 1}`)!;
      }
    }
  }
  // ── Phase 5: bignum (before the generic int/string rejection) ──
  for (const [ci, c] of clauses.entries()) {
    for (const lit of litsOf(c)) {
      for (const a of lit.args) {
        if (a.k === 'i' && Math.abs(a.v) > Number.MAX_SAFE_INTEGER) {
          return fail('missing:bignum', `integer ${a.v} in clause ${ci + 1} exceeds the safe-integer range the v0 ORACLE can hold (LIMITS.md:49-51 — no bignums, JS safe-integer range), so the two engines would disagree by construction; RFDB itself holds it exactly (live-probed R15/P1e: 2^68 dumps as ~big:295147905179352825856)`);
        }
      }
    }
  }
  // ── Phase 6: builtins ──────────────────────────────────────────
  for (const [ci, c] of clauses.entries()) {
    for (const b of c.body) {
      if (b.t === 'bi') {
        return fail('dialect:untranslatable', `builtin '${b.op}' in clause ${ci + 1}: the v0 arithmetic/comparison semantics (unify.ts:96-113, JS trunc) → RFDB builtin mapping is unverified in P0 (first P1 flip candidate)`);
      }
    }
  }
  for (const [ci, c] of clauses.entries()) {
    for (const lit of litsOf(c)) {
      const f = checkLitTerms(lit, `clause ${ci + 1}`);
      if (f) return f;
    }
  }
  // ── Phase 8: arity consistency ─────────────────────────────────
  const relArity = new Map<string, number>();
  for (const [ci, c] of clauses.entries()) {
    for (const lit of litsOf(c)) {
      const prev = relArity.get(lit.rel);
      if (prev === undefined) relArity.set(lit.rel, lit.args.length);
      else if (prev !== lit.args.length) {
        return fail('dialect:untranslatable', `relation '${lit.rel}' used at arities ${prev} and ${lit.args.length} (clause ${ci + 1}): RFDB predicates are fixed-arity`);
      }
    }
  }
  // ── Phase 9: head shape + negation safety (missing:demand-mode) ─
  for (const [ci, c] of clauses.entries()) {
    if (c.body.length === 0) {
      // ground fact: v0 addClause already requires ground args
      for (const a of c.head.args) {
        if (a.k === 'v') {
          return fail('missing:demand-mode', `non-ground fact in clause ${ci + 1}`);
        }
      }
      continue;
    }
    const posVars = new Set<string>();
    for (const b of c.body) {
      if (b.t === 'pos') for (const a of b.lit.args) if (a.k === 'v' && !isWildcard(a)) posVars.add(a.name);
    }
    const seen = new Set<string>();
    for (const a of c.head.args) {
      if (a.k !== 'v' || isWildcard(a)) {
        return fail('missing:demand-mode', `head argument of clause ${ci + 1} is not a named variable: v0 tolerates such heads via demand/moded evaluation (engine.ts:80-127); RFDB has no demand mode`);
      }
      if (seen.has(a.name)) {
        return fail('missing:demand-mode', `repeated head variable '${a.name}' in clause ${ci + 1}: demand/moded head shapes have no RFDB counterpart`);
      }
      seen.add(a.name);
      if (!posVars.has(a.name)) {
        return fail('missing:demand-mode', `head variable '${a.name}' of clause ${ci + 1} is not bound by a positive premise (not range-restricted): v0 handles this via demand mode`);
      }
    }
    for (const b of c.body) {
      if (b.t === 'neg') {
        for (const a of b.lit.args) {
          if (a.k === 'v' && !isWildcard(a) && !posVars.has(a.name)) {
            return fail('missing:demand-mode', `negated premise variable '${a.name}' in clause ${ci + 1} is not bound by a positive premise (unsafe negation): v0 evaluates it by finite failure; RFDB rejects (E-PLAN-002)`);
          }
        }
      }
    }
  }
  // ── Phase 10: body structure (planner traps) ───────────────────
  // Variable-free positive/negated literals are FILTERS, safe in any planner
  // position (ROFL F3 engine fix) — only the variable-CARRYING positive
  // premises must be connected via shared named variables.
  for (const [ci, c] of clauses.entries()) {
    if (c.body.length < 2) continue;
    const posLits = c.body.filter((b): b is Extract<BodyElem, { t: 'pos' }> => b.t === 'pos');
    const varLits = posLits.filter((b) => b.lit.args.some((a) => a.k === 'v' && !isWildcard(a)));
    if (varLits.length >= 2) {
      const varSets = varLits.map((b) => new Set(b.lit.args.filter((a) => a.k === 'v' && !isWildcard(a)).map((a) => (a as { name: string }).name)));
      const reached = new Set<number>([0]);
      const boundVars = new Set<string>(varSets[0]);
      let grew = true;
      while (grew) {
        grew = false;
        for (let i = 0; i < varSets.length; i++) {
          if (reached.has(i)) continue;
          if ([...varSets[i]].some((v) => boundVars.has(v))) {
            reached.add(i);
            for (const v of varSets[i]) boundVars.add(v);
            grew = true;
          }
        }
      }
      if (reached.size !== varLits.length) {
        return fail('dialect:untranslatable', `disconnected rule body in clause ${ci + 1}: a positive premise shares no variable with the rest — RFDB's §3 structural cross-join guard rejects it (derive/plan.rs:599-613). Live-probed R15/P4: two, three-leg and non-leading shapes all come back "[E-PLAN-003] cross-join: literal \`u_q\` shares no bound variable with the preceding body"`);
      }
    }
  }

  // ── Construction ───────────────────────────────────────────────
  const groundFacts = new Map<string, string[][]>();
  const groundFactTerms = new Map<string, string[][]>();
  const factSeen = new Set<string>();
  const rules: TransRule[] = [];

  for (const c of clauses) {
    if (c.body.length === 0) {
      const rel = c.head.rel;
      const args = c.head.args.map(constCanon);  // atoms and ints only (checked)
      const terms = c.head.args.map(constText);
      const key = `${rel}(${args.join(',')})`;
      if (!factSeen.has(key)) {
        factSeen.add(key);
        if (!groundFacts.has(rel)) groundFacts.set(rel, []);
        groundFacts.get(rel)!.push(args);
        if (!groundFactTerms.has(rel)) groundFactTerms.set(rel, []);
        groundFactTerms.get(rel)!.push(terms);
      }
      continue;
    }
    // rename variables clause-locally: V0, V1, … in order of first occurrence
    const varMap = new Map<string, string>();
    const rn = (t: Term): string => {
      if (t.k === 'v') {
        if (isWildcard(t)) return '_';
        if (!varMap.has(t.name)) varMap.set(t.name, `V${varMap.size}`);
        return varMap.get(t.name)!;
      }
      return constText(t);
    };
    const headArgs = c.head.args.map(rn);
    const bodyParts: string[] = [];
    for (const b of c.body) {
      if (b.t === 'pos') {
        bodyParts.push(`${PFX}${b.lit.rel}(${b.lit.args.map(rn).join(', ')})`);
      } else if (b.t === 'neg') {
        // negated wildcards go to the wire as-is: the engine evaluates them
        // existentially over the bound columns (ROFL F1 fix, regression-pinned
        // by exec.rs::negated_derived_leg_with_wildcard_is_existential)
        bodyParts.push(`\\+ ${PFX}${b.lit.rel}(${b.lit.args.map(rn).join(', ')})`);
      }
    }
    rules.push({
      rel: c.head.rel,
      text: `${PFX}${c.head.rel}(${headArgs.join(', ')}) :- ${bodyParts.join(', ')}.`,
      headVars: headArgs,
    });
  }

  // A body literal over a predicate with no facts and no rules goes to the
  // wire as-is: the engine serves it as a legal EMPTY relation (ROFL F2 fix,
  // regression-pinned by exec.rs::unknown_predicate_leg_terminates_with_empty_result).
  const programRels = [...new Set(clauses.flatMap((c) => litsOf(c).map((l) => l.rel)))];

  return {
    ok: true,
    rules,
    groundFacts,
    groundFactTerms,
    relArity,
    programRels,
  };
}

/** Render the full RFDB program: rules (optionally hoisting one rel's first
 *  rule — executeDatalog answers for the FIRST rule head's predicate), then
 *  facts (sorted, deterministic). */
export function renderSource(t: Translation, hoistRel?: string): string {
  let ordered = t.rules;
  if (hoistRel !== undefined) {
    const i = t.rules.findIndex((r) => r.rel === hoistRel);
    if (i > 0) ordered = [t.rules[i], ...t.rules.slice(0, i), ...t.rules.slice(i + 1)];
  }
  const lines: string[] = ordered.map((r) => r.text);
  const factLines: string[] = [];
  for (const [rel, tuples] of t.groundFactTerms) {
    for (const args of tuples) {
      factLines.push(`${PFX}${rel}(${args.join(', ')}).`);
    }
  }
  factLines.sort();
  lines.push(...factLines);
  return lines.join('\n') + '\n';
}

/** Render the dump program for one rel: a fresh dump predicate whose single
 *  rule projects the rel's FULL extension (EDB + IDB) through the engine.
 *  `xdump` leads, so executeDatalog answers for it. Returns null only for a
 *  rel the program never mentions (no arity to project); a mentioned rel with
 *  no facts and no rules is dumped through the engine and comes back empty
 *  (legal empty relation, ROFL F2 fix). */
export function renderDumpSource(t: Translation, rel: string): { source: string; headVars: string[] } | null {
  if (!t.relArity.has(rel)) return null;
  const arity = t.relArity.get(rel)!;
  const vars = Array.from({ length: arity }, (_, i) => `V${i}`);
  const dumpRule = `xdump(${vars.join(', ')}) :- ${PFX}${rel}(${vars.join(', ')}).`;
  return { source: dumpRule + '\n' + renderSource(t), headVars: vars };
}

export const USER_PREFIX = PFX;
