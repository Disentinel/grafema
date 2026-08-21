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
//   • a negated literal may contain NO wildcard and NO free variable
//     (wildcard: silently wrong answers, live-probed; free var: E-PLAN-002)
//     → wildcard-carrying negated literals are PROJECTED through an auxiliary
//     predicate `xp<i>(BoundVars) :- u_rel(...)`;
//   • a body literal over a predicate with no facts and no rules HANGS the
//     server (live-probed, >45s no abort) → empty-predicate elimination to
//     fixpoint (drop rule on positive-empty, drop literal on negated-empty —
//     a semantics-preserving datalog normalization);
//   • all-digit wire strings re-type to Value::Id (rfdb_server.rs:3205-3210)
//     and v0 atom/int/string all collapse to wire strings → only ATOM
//     constants translate; int/string constants are dialect:untranslatable
//     in P0 (ints beyond i64/2^53 are missing:bignum, checked first).

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
  /** Translated rules (surviving empty-predicate elimination), original order,
   *  followed by aux projection rules; use with facts via renderSource(). */
  rules: TransRule[];
  auxRules: string[];
  /** original rel → deduped ground-fact tuples (atom names, positional). */
  groundFacts: Map<string, string[][]>;
  /** original rel → arity. */
  relArity: Map<string, number>;
  /** all original rels mentioned anywhere in the program. */
  programRels: string[];
  /** rels whose entire extension is statically empty (unknown predicates). */
  emptyRels: Set<string>;
  droppedRules: number;
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

/** Check a single literal's terms for untranslatable constants; returns a
 *  failure or null. Shared by translate() and the adapter's query-literal path. */
export function checkLitTerms(lit: Lit, where: string): TranslationFailure | null {
  for (const a of lit.args) {
    if (a.k === 'f') {
      return fail('missing:compound-terms', `functor term '${a.name}(…)' in ${where}: RFDB v1 has no compound term form (datalog/types.rs:12-14)`);
    }
    if (a.k === 'i') {
      const abs = BigInt(Math.abs(a.v));
      if (abs > I64_MAX || Math.abs(a.v) > Number.MAX_SAFE_INTEGER) {
        return fail('missing:bignum', `integer ${a.v} in ${where} exceeds the i64/2^53 range representable by both engines`);
      }
      return fail('dialect:untranslatable', `integer constant ${a.v} in ${where}: v0 atom/int/string collapse to RFDB wire strings (all-digit strings re-type to Value::Id, rfdb_server.rs:3205-3210); numeric-constant round-trip is unverified P1 work`);
    }
    if (a.k === 's') {
      return fail('dialect:untranslatable', `string constant ${JSON.stringify(a.v)} in ${where}: collides with the atom→quoted-string encoding; reverse mapping ambiguous in P0`);
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
          return fail('missing:bignum', `integer ${a.v} in clause ${ci + 1} exceeds the i64/2^53 range representable by both engines`);
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
  for (const [ci, c] of clauses.entries()) {
    if (c.body.length < 2) continue;
    const posLits = c.body.filter((b): b is Extract<BodyElem, { t: 'pos' }> => b.t === 'pos');
    const negLits = c.body.filter((b): b is Extract<BodyElem, { t: 'neg' }> => b.t === 'neg');
    for (const b of [...posLits, ...negLits]) {
      const hasVar = b.lit.args.some((a) => a.k === 'v' && !isWildcard(a));
      if (!hasVar && c.body.length >= 2) {
        return fail('dialect:untranslatable', `ground body literal '${b.lit.rel}(…)' in clause ${ci + 1}: the RFDB planner reorders it first and then rejects the rest as a cross-join (E-PLAN-003, live-probed)`);
      }
    }
    // connectivity of positive literals via shared named variables
    if (posLits.length >= 2) {
      const varSets = posLits.map((b) => new Set(b.lit.args.filter((a) => a.k === 'v' && !isWildcard(a)).map((a) => (a as { name: string }).name)));
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
      if (reached.size !== posLits.length) {
        return fail('dialect:untranslatable', `disconnected rule body in clause ${ci + 1}: a positive premise shares no variable with the rest — RFDB's structural cross-join guard rejects it (E-PLAN-003, plan.rs:460-473)`);
      }
    }
  }

  // ── Construction ───────────────────────────────────────────────
  const groundFacts = new Map<string, string[][]>();
  const factSeen = new Set<string>();
  const rules: TransRule[] = [];
  const auxRules: string[] = [];
  let auxCounter = 0;

  for (const c of clauses) {
    if (c.body.length === 0) {
      const rel = c.head.rel;
      const args = c.head.args.map((a) => (a as { name: string }).name); // atoms only (checked)
      const key = `${rel}(${args.join(',')})`;
      if (!factSeen.has(key)) {
        factSeen.add(key);
        if (!groundFacts.has(rel)) groundFacts.set(rel, []);
        groundFacts.get(rel)!.push(args);
      }
      continue;
    }
    // rename variables clause-locally: V0, V1, … in order of first occurrence
    const varMap = new Map<string, string>();
    const rn = (t: Term): string => {
      if (t.k === 'a') return `"${t.name}"`;
      if (t.k === 'v') {
        if (isWildcard(t)) return '_';
        if (!varMap.has(t.name)) varMap.set(t.name, `V${varMap.size}`);
        return varMap.get(t.name)!;
      }
      throw new Error(`unreachable term kind ${t.k} after checks`);
    };
    const headArgs = c.head.args.map(rn);
    const bodyParts: string[] = [];
    for (const b of c.body) {
      if (b.t === 'pos') {
        bodyParts.push(`${PFX}${b.lit.rel}(${b.lit.args.map(rn).join(', ')})`);
      } else if (b.t === 'neg') {
        const hasWildcard = b.lit.args.some(isWildcard);
        if (hasWildcard) {
          // PROJECT: `not rel(X, _)` → aux `xpN(X) :- u_rel(X, _).` + `\+ xpN(X)`
          // (negated wildcards are silently mis-evaluated by RFDB — live-probed;
          //  positive wildcards work, so the aux positive rule is sound)
          const keptIdx = b.lit.args.map((a, i) => (isWildcard(a) ? -1 : i)).filter((i) => i >= 0);
          const aux = `xp${auxCounter++}`;
          const auxHead = keptIdx.map((i) => rn(b.lit.args[i]));
          const auxBody = b.lit.args.map((a) => rn(a));
          auxRules.push(`${aux}(${auxHead.join(', ')}) :- ${PFX}${b.lit.rel}(${auxBody.join(', ')}).`);
          bodyParts.push(`\\+ ${aux}(${auxHead.join(', ')})`);
        } else {
          bodyParts.push(`\\+ ${PFX}${b.lit.rel}(${b.lit.args.map(rn).join(', ')})`);
        }
      }
    }
    rules.push({
      rel: c.head.rel,
      text: `${PFX}${c.head.rel}(${headArgs.join(', ')}) :- ${bodyParts.join(', ')}.`,
      headVars: headArgs,
    });
  }

  // ── Empty-predicate elimination to fixpoint ────────────────────
  // (a body literal over an unknown predicate hangs the server; dropping a
  //  rule with a positive-empty premise / a negated-empty literal preserves
  //  datalog semantics: the premise can never / can always be satisfied)
  const parseAuxBodyPreds = (text: string): { neg: boolean; pred: string }[] => {
    const body = text.split(':-')[1];
    const out: { neg: boolean; pred: string }[] = [];
    const re = /(\\\+\s*)?([a-z][A-Za-z0-9_]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.push({ neg: !!m[1], pred: m[2] });
    return out;
  };
  let droppedRules = 0;
  let liveRules = rules.slice();
  let liveAux = auxRules.slice();
  for (;;) {
    const known = new Set<string>();
    for (const rel of groundFacts.keys()) known.add(PFX + rel);
    for (const r of liveRules) known.add(PFX + r.rel);
    for (const a of liveAux) known.add(a.split('(')[0]);
    const surviveRule = (bodyPreds: { neg: boolean; pred: string }[]): { keep: boolean; body: { neg: boolean; pred: string }[] } => {
      const kept = bodyPreds.filter((p) => !(p.neg && !known.has(p.pred)));
      if (kept.some((p) => !p.neg && !known.has(p.pred))) return { keep: false, body: kept };
      return { keep: true, body: kept };
    };
    let changed = false;
    const nextRules: TransRule[] = [];
    for (const r of liveRules) {
      const preds = parseAuxBodyPreds(r.text);
      const s = surviveRule(preds);
      if (!s.keep) { droppedRules++; changed = true; continue; }
      if (s.body.length !== preds.length) {
        // negated-empty literal(s) removed: rebuild the rule text
        const bodyText = rebuildBody(r.text, known);
        if (bodyText === null) { droppedRules++; changed = true; continue; }
        nextRules.push({ ...r, text: bodyText });
        changed = true;
      } else nextRules.push(r);
    }
    const nextAux: string[] = [];
    for (const a of liveAux) {
      const preds = parseAuxBodyPreds(a);
      if (preds.some((p) => !p.neg && !known.has(p.pred))) { changed = true; continue; }
      nextAux.push(a);
    }
    liveRules = nextRules;
    liveAux = nextAux;
    if (!changed) break;
  }

  const programRels = [...new Set(clauses.flatMap((c) => litsOf(c).map((l) => l.rel)))];
  const known = new Set<string>();
  for (const rel of groundFacts.keys()) known.add(rel);
  for (const r of liveRules) known.add(r.rel);
  const emptyRels = new Set(programRels.filter((r) => !known.has(r)));

  return {
    ok: true,
    rules: liveRules,
    auxRules: liveAux,
    groundFacts,
    relArity,
    programRels,
    emptyRels,
    droppedRules,
  };
}

/** Rebuild a translated rule's body dropping negated literals over unknown
 *  predicates. Returns null if no body literal survives (defensive; a rule
 *  always keeps its positive legs here because surviveRule checked them). */
function rebuildBody(text: string, known: Set<string>): string | null {
  const [head, body] = text.split(' :- ');
  const parts = splitBodyParts(body.replace(/\.\s*$/, ''));
  const kept = parts.filter((p) => {
    const m = /^(\\\+\s*)?([a-zA-Z0-9_]+)\(/.exec(p.trim());
    if (!m) return true;
    if (m[1] && !known.has(m[2])) return false;
    return true;
  });
  if (kept.length === 0) return null;
  return `${head} :- ${kept.join(', ')}.`;
}

/** Split a rule body on top-level commas (arguments contain commas inside parens). */
function splitBodyParts(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Render the full RFDB program: rules (optionally hoisting one rel's first
 *  rule — executeDatalog answers for the FIRST rule head's predicate), then
 *  aux projection rules, then facts (sorted, deterministic). */
export function renderSource(t: Translation, hoistRel?: string): string {
  let ordered = t.rules;
  if (hoistRel !== undefined) {
    const i = t.rules.findIndex((r) => r.rel === hoistRel);
    if (i > 0) ordered = [t.rules[i], ...t.rules.slice(0, i), ...t.rules.slice(i + 1)];
  }
  const lines: string[] = ordered.map((r) => r.text);
  lines.push(...t.auxRules);
  const factLines: string[] = [];
  for (const [rel, tuples] of t.groundFacts) {
    for (const args of tuples) {
      factLines.push(`${PFX}${rel}(${args.map((a) => `"${a}"`).join(', ')}).`);
    }
  }
  factLines.sort();
  lines.push(...factLines);
  return lines.join('\n') + '\n';
}

/** Render the dump program for one rel: a fresh dump predicate whose single
 *  rule projects the rel's FULL extension (EDB + IDB) through the engine.
 *  `xdump` leads, so executeDatalog answers for it. Returns null when the rel
 *  is statically empty (unknown predicate = server hang, live-probed). */
export function renderDumpSource(t: Translation, rel: string): { source: string; headVars: string[] } | null {
  if (t.emptyRels.has(rel)) return null;
  if (!t.relArity.has(rel)) return null;
  const arity = t.relArity.get(rel)!;
  const vars = Array.from({ length: arity }, (_, i) => `V${i}`);
  const dumpRule = `xdump(${vars.join(', ')}) :- ${PFX}${rel}(${vars.join(', ')}).`;
  return { source: dumpRule + '\n' + renderSource(t), headVars: vars };
}

export const USER_PREFIX = PFX;
