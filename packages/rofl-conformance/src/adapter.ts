// adapter.ts — RfdbRofl: the v0 Rofl API surface backed ENTIRELY by the RFDB
// derive engine over the wire. Every ANSWER comes from RFDB (fact extensions
// via executeDatalog dump rules, witnesses via explainDatalogFact/Gap); the
// vendored v0 parser/unify are reused only as MATCHING/PARSING code over
// RFDB-returned tuples — never as a fallback engine. Every operation outside
// the translatable subset throws UnsupportedFeature with a code from the
// closed taxonomy — the adapter never simulates missing engine features.

import { parseProgram, parseLiteral, type Clause, type Lit } from './neutral.ts';
import { ParseError } from '../vendor/rofl-v0/src/parser.ts';
import { mkf, unify, resolve, canonTerm, varsOf, isGround, type Term, type Subst } from '../vendor/rofl-v0/src/unify.ts';
import {
  translate, renderSource, renderDumpSource, checkLitMeta, checkLitTerms,
  wireToCanon, canonToTerm, constToWireKey,
  UnsupportedFeature, USER_PREFIX, type Translation,
} from './translate.ts';
import type { RfdbClient } from './rfdb-client.ts';
import { type FactWitness, type GapWitness } from './rfdb-client.ts';
import { bindingsToTuple } from './canonical.ts';

export interface QueryRow { text: string; bindings: Record<string, string>; }
export interface QueryResult { rows: QueryRow[]; partial: boolean; error?: string; }

export function unprefix(pred: string): string {
  return pred.startsWith(USER_PREFIX) ? pred.slice(USER_PREFIX.length) : pred;
}

export class RfdbRofl {
  private client: RfdbClient;
  private clauses: Clause[] = [];
  private translation: Translation | null = null;
  diagnostics: string[] = [];

  constructor(client: RfdbClient, opts: { naive?: boolean } = {}) {
    if (opts.naive) {
      throw new UnsupportedFeature('dialect:untranslatable',
        'naive evaluation mode is a v0 engine-internal toggle; RFDB has a single evaluation mode (v0 modes agree on fact sets, LIMITS.md:48 ⟦and seminaive agree on results⟧)');
    }
    this.client = client;
  }

  static fromSnapshot(_json: string, _opts: { naive?: boolean } = {}): RfdbRofl {
    throw new UnsupportedFeature('missing:snapshot',
      'RFDB has no canonicalState/save/restore surface (its determinism anchors are rule_ast_hash and sorted commits — different artifacts)');
  }

  save(): string {
    throw new UnsupportedFeature('missing:snapshot', 'RFDB has no canonicalState/save surface');
  }

  canonicalState(): string {
    throw new UnsupportedFeature('missing:snapshot', 'RFDB has no canonicalState surface');
  }

  // ── loading / asserting ─────────────────────────────────────────

  private retranslate(next: Clause[]): Translation {
    const t = translate(next);
    if (!t.ok) throw new UnsupportedFeature(t.code, t.detail);
    return t;
  }

  private guardOpts(opts: { who?: string; budget?: number }, what: string): void {
    if (opts.budget !== undefined) {
      throw new UnsupportedFeature('missing:holes',
        `${what} with an evaluation budget: v0 commits partial results + hole/2 facts on exhaustion (engine.ts:188-198 ⟦this.store.add(V.hole, MAIN⟧); RFDB aborts without committing (E-codes, engine_v2.rs:681-684 ⟦stays intact (abort-no-commit)⟧) — the known policy contradiction, ТЗ P1 mandates holes`);
    }
    if (opts.who !== undefined) {
      throw new UnsupportedFeature('missing:rules-as-data',
        `${what} with who-provenance: asserted_by/authority are reflection-vocabulary facts RFDB does not have`);
    }
  }

  load(text: string, opts: { who?: string; budget?: number } = {}): { ok: boolean; diagnostics: string[] } {
    this.guardOpts(opts, 'load');
    let clauses: Clause[];
    try {
      clauses = parseProgram(text);
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, diagnostics: [e.message] };
      throw e;
    }
    // v0 load is transactional: on rejection nothing is kept
    const next = [...this.clauses, ...clauses];
    this.translation = this.retranslate(next); // throws UnsupportedFeature on untranslatable input
    this.clauses = next;
    return { ok: true, diagnostics: [] };
  }

  assert(text: string, opts: { who?: string } = {}): { ok: boolean; diagnostics: string[] } {
    this.guardOpts(opts, 'assert');
    let clauses: Clause[];
    try {
      clauses = parseProgram(text);
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, diagnostics: [e.message] };
      throw e;
    }
    const next = [...this.clauses, ...clauses];
    this.translation = this.retranslate(next);
    this.clauses = next;
    return { ok: true, diagnostics: [] };
  }

  assertClauses(clauses: Clause[], opts: { who?: string } = {}): { ok: boolean; diagnostics: string[] } {
    this.guardOpts(opts, 'assertClauses');
    const next = [...this.clauses, ...clauses];
    this.translation = this.retranslate(next);
    this.clauses = next;
    return { ok: true, diagnostics: [] };
  }

  retract(_text: string): { ok: boolean; diagnostics: string[] } {
    throw new UnsupportedFeature('missing:retract', 'RFDB derive programs are stateless reads; there is no base-fact retraction surface for program-text EDB');
  }

  // ── evaluation ──────────────────────────────────────────────────

  evaluate(budget?: number): { partial: boolean } {
    if (budget !== undefined) {
      throw new UnsupportedFeature('missing:holes', 'budgeted evaluation: RFDB aborts (no partial+hole commit)');
    }
    // Evaluation is per-query on the wire; nothing to precompute here.
    return { partial: false };
  }

  private t(): Translation {
    if (!this.translation) this.translation = this.retranslate(this.clauses);
    return this.translation;
  }

  /** Full extension of one original relation, DELEGATED to the engine: a fresh
   *  `xdump(V…) :- u_rel(V…).` rule leads the program, executeDatalog answers
   *  for it (first-rule-head contract), and the program's own ground facts are
   *  unioned in (dedup) — correct whether or not the derive path echoes EDB. */
  async dumpRel(rel: string): Promise<string[][]> {
    const t = this.t();
    const seen = new Set<string>();
    const out: string[][] = [];
    const dump = renderDumpSource(t, rel);
    if (dump !== null) {
      const rows = await this.client.executeDatalog(dump.source);
      for (const b of rows) {
        // engine rows carry WIRE values — an integer comes back tagged
        // `~int:N` (live-probed R15/P1a) — so decode to the v0-canonical form
        // the harness compares in, before the union with the program's own facts.
        const tuple = bindingsToTuple(b, dump.headVars).map(wireToCanon);
        const key = tuple.join('\x00');
        if (!seen.has(key)) { seen.add(key); out.push(tuple); }
      }
    }
    for (const tuple of t.groundFacts.get(rel) ?? []) {
      const key = tuple.join('\x00');
      if (!seen.has(key)) { seen.add(key); out.push(tuple); }
    }
    return out;
  }

  async dumpAll(): Promise<Map<string, string[][]>> {
    const t = this.t();
    const out = new Map<string, string[][]>();
    for (const rel of t.programRels) out.set(rel, await this.dumpRel(rel));
    return out;
  }

  // ── queries ─────────────────────────────────────────────────────

  private checkQueryLit(lit: Lit, what: string): void {
    const meta = checkLitMeta(lit, what);
    if (meta) throw new UnsupportedFeature(meta.code, meta.detail);
    const terms = checkLitTerms(lit, what);
    if (terms) throw new UnsupportedFeature(terms.code, terms.detail);
  }

  async query(text: string, opts: { budget?: number } = {}): Promise<QueryResult> {
    if (opts.budget !== undefined) {
      throw new UnsupportedFeature('missing:holes', 'budgeted query: v0 returns partial+hole; RFDB aborts without committing');
    }
    let lit: Lit;
    try {
      lit = parseLiteral(text);
    } catch (e) {
      if (e instanceof ParseError) return { rows: [], partial: false, error: e.message };
      throw e;
    }
    this.checkQueryLit(lit, `query '${text.trim()}'`);
    const tuples = await this.dumpRel(lit.rel);
    // vendored-unify matching over RFDB-returned tuples (matching code reuse,
    // facts always RFDB's) + the exact v0 row rendering (api.ts:206-223 ⟦vars.length === 0 ? 'true'⟧)
    const vars = [...varsOf(lit.persp, varsOf(mkf('$t', lit.args)))].sort();
    const rows = new Map<string, QueryRow>();
    for (const tuple of tuples) {
      if (tuple.length !== lit.args.length) continue;
      const factTerm = mkf('$t', tuple.map(canonToTerm));
      const s: Subst | null = unify(mkf('$t', lit.args), factTerm, new Map());
      if (s === null) continue;
      const bindings: Record<string, string> = {};
      for (const v of vars) bindings[v] = canonTerm(resolve({ k: 'v', name: v } as Term, s));
      const rtext = vars.length === 0 ? 'true' : vars.map((v) => `${v} = ${bindings[v]}`).join(', ');
      if (!rows.has(rtext)) rows.set(rtext, { text: rtext, bindings });
    }
    return { rows: [...rows.keys()].sort().map((k) => rows.get(k)!), partial: false };
  }

  async holds(text: string): Promise<boolean> {
    return (await this.query(text)).rows.length > 0;
  }

  // ── why / whynot ────────────────────────────────────────────────

  /** Structured witness (harness surface; tier-0 spot-checks use this). */
  async whyWitness(text: string): Promise<{ witness: FactWitness | null; factLine: string }> {
    const lit = parseLiteral(text);
    if (lit.persp.k !== 'a' || !lit.args.every(isGround)) {
      throw new Error('whyWitness needs a ground literal');
    }
    this.checkQueryLit(lit, `why '${text.trim()}'`);
    const t = this.t();
    const key = lit.args.map(constToWireKey);
    const witness = await this.client.explainDatalogFact(renderSource(t), USER_PREFIX + lit.rel, key);
    return { witness, factLine: `${lit.rel}(${lit.args.map(canonTerm).join(',')})` };
  }

  async whynotWitness(text: string): Promise<{ witness: GapWitness | null; factLine: string }> {
    const lit = parseLiteral(text);
    if (lit.persp.k !== 'a' || !lit.args.every(isGround)) {
      throw new Error('whynotWitness needs a ground literal');
    }
    this.checkQueryLit(lit, `whynot '${text.trim()}'`);
    const t = this.t();
    const key = lit.args.map(constToWireKey);
    const witness = await this.client.explainDatalogGap(renderSource(t), USER_PREFIX + lit.rel, key);
    return { witness, factLine: `${lit.rel}(${lit.args.map(canonTerm).join(',')})` };
  }

  /** v0 API why(): the v0 contract is a recursive indented witness TREE with
   *  content-addressed rule ids and ticks (api.ts:250-277 ⟦w.tick⟧). RFDB's witness is
   *  a flat {ruleAstHash, body[]} — the SHAPE is unrepresentable, so this
   *  throws missing:whynot-shape (after delegating existence to the engine,
   *  carried in the detail for evidence). */
  async why(text: string, opts: { budget?: number } = {}): Promise<{ ok: boolean; text: string }> {
    if (opts.budget !== undefined) {
      throw new UnsupportedFeature('missing:holes', 'budgeted why: RFDB aborts (no partial+hole)');
    }
    const { witness, factLine } = await this.whyWitness(text);
    throw new UnsupportedFeature('missing:whynot-shape',
      `v0 why() is a recursive tree '<key> <= r<fnv1a> @tick N' (api.ts:250-277 ⟦w.tick⟧); RFDB witness for ${factLine} is flat {ruleAstHash, body[]} (derive/exec.rs:298-306 ⟦pub struct DerivationWitness⟧) — witness ${witness ? 'EXISTS' : 'is null'} but the tree shape is unrepresentable. Live-probed R15/P5a: explainDatalogFact on u_r ← u_q ← u_p returns ONE level (body=[u_q(a)], no nesting into u_p) and carries no tick, and the rule id is a 64-hex ast hash, not v0's r<fnv1a>`);
  }

  async whynot(text: string, opts: { budget?: number } = {}): Promise<{ holds: boolean; text: string }> {
    if (opts.budget !== undefined) {
      throw new UnsupportedFeature('missing:holes', 'budgeted whynot: RFDB aborts (no partial+hole)');
    }
    const { witness, factLine } = await this.whynotWitness(text);
    throw new UnsupportedFeature('missing:whynot-shape',
      `v0 whynot() demonstrates per-rule failed premises as an indented text demo (api.ts:290-345 ⟦failed premise:⟧); RFDB gap witness for ${factLine} is flat single-rule/first-premise (${witness ? 'gap EXISTS' : 'no gap'}) — the demo shape is unrepresentable`);
  }

  excise(_text: string, _opts: { budget?: number } = {}): { ok: boolean; removed: string[]; added: string[] } {
    throw new UnsupportedFeature('missing:excise',
      'v0 excise = clean re-evaluation on EDB minus one fact (api.ts:348 ⟦excise(text: string⟧); RFDB sim_derive is overlay-ADD, there is no minus-one-fact counterpart');
  }

  // ── time ────────────────────────────────────────────────────────

  tickAdvance(_opts: object = {}): { advanced: boolean; quiescent: boolean; partial: boolean } {
    throw new UnsupportedFeature('missing:temporal', '@init/@next tick semantics (api.ts:393-421 ⟦tickAdvance(⟧) have no RFDB counterpart');
  }

  run(_opts: object = {}): { ticks: number; quiescent: boolean; partial: boolean } {
    throw new UnsupportedFeature('missing:temporal', 'multi-tick run-to-quiescence has no RFDB counterpart');
  }

  // ── introspection ───────────────────────────────────────────────

  async factKeys(rel?: string): Promise<string[]> {
    const t = this.t();
    const out: string[] = [];
    const rels = rel !== undefined ? [rel] : t.programRels;
    for (const r of rels) {
      for (const tuple of await this.dumpRel(r)) {
        out.push(`${r}[main](${tuple.join(',')})`);
      }
    }
    return out.sort();
  }

  /** Canonical persp-stripped fact lines for all program relations. */
  async domainFactSet(): Promise<string[]> {
    const t = this.t();
    const out: string[] = [];
    for (const r of t.programRels) {
      for (const tuple of await this.dumpRel(r)) out.push(`${r}(${tuple.join(',')})`);
    }
    return [...new Set(out)].sort();
  }

  strataPlan(): { rule: string; rel: string; level: number | null }[] {
    throw new UnsupportedFeature('missing:rules-as-data',
      'v0 strata come from boot-derived stratum/2 + unstratified/1 FACTS (engine.ts:2-4 ⟦READ from stratum/2 facts⟧, boot.rofl:17-21 ⟦stratum(Rel, 0)⟧); RFDB stratification is internal, not queryable');
  }

  supportCount(_key: string): number {
    throw new UnsupportedFeature('missing:rules-as-data',
      'v0 support counting reads derived_by/firings provenance; RFDB stores no per-fact provenance (witnesses are computed on demand)');
  }

  kernelVocabularyCheck(): { file: string; line: number; what: string }[] {
    throw new UnsupportedFeature('missing:rules-as-data',
      'the kernel-grep vocabulary contract is about the v0 reflection vocabulary as the kernel API; RFDB has no reflection vocabulary to check');
  }

  /** Program ground facts of one rel (translator view; used by tests). */
  groundFactsOf(rel: string): string[][] {
    return this.t().groundFacts.get(rel) ?? [];
  }

  /** Original rels with ≥1 translated rule. Gap witnesses exist only
   *  THROUGH rules — explainDatalogGap returns null for EDB-only rels
   *  (live-probed), so the tier-0 whynot spot-check targets these rels. */
  ruleRels(): string[] {
    return [...new Set(this.t().rules.map((r) => r.rel))];
  }
}
