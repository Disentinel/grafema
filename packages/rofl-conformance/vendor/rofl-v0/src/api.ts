// api.ts — load, assert, retract, ?, why, whynot, excise, ticks, snapshots.

import { type Term, mka, mkf, mki, canonTerm, resolve, isGround, varsOf, type Subst } from './unify.ts';
import { parseProgram, parseLiteral, type Clause, type Lit } from './parser.ts';
import { Store, factKey } from './store.ts';
import {
  V, RESERVED, IFACE, MAIN, encodeRule, bootstrapKernel, registerPersp,
  factMetaFacts, factTerm, canonClause, BUDGET_REASON,
} from './reflect.ts';
import { Evaluation, StratificationError, BudgetExhausted, type StagedFact, sigOf } from './engine.ts';

export interface LoadResult { ok: boolean; diagnostics: string[]; }
export interface QueryRow { text: string; bindings: Record<string, string>; }
export interface QueryResult { rows: QueryRow[]; partial: boolean; error?: string; }

const DEFAULT_BUDGET = 100_000;

export class Rofl {
  store: Store;
  naive: boolean;
  diagnostics: string[] = [];
  private qn = 0;
  private loadn = 0;
  private lastStaged: StagedFact[] = [];
  private lastSteps = 0;

  constructor(opts: { naive?: boolean } = {}) {
    this.naive = opts.naive ?? false;
    this.store = new Store();
    bootstrapKernel(this.store);
  }

  static fromSnapshot(json: string, opts: { naive?: boolean } = {}): Rofl {
    const r = new Rofl(opts);
    r.store = Store.restore(json);
    bootstrapKernel(r.store); // idempotent
    return r;
  }

  save(): string {
    return this.store.snapshot();
  }

  // -------------------------------------------------------------------------
  // loading & asserting (rules become reflection facts through this one path)

  load(text: string, opts: { who?: string; budget?: number } = {}): LoadResult {
    this.loadn++;
    const holeId = mkf('$load', [mki(this.loadn)]);
    let clauses: Clause[];
    try {
      clauses = parseProgram(text);
    } catch (e) {
      return { ok: false, diagnostics: [(e as Error).message] };
    }
    const backup = this.store.clone();
    const diags: string[] = [];
    for (const c of clauses) {
      const err = this.addClause(c, opts.who);
      if (err) diags.push(err);
    }
    if (diags.length > 0) {
      this.store = backup;
      return { ok: false, diagnostics: diags };
    }
    try {
      this.ensure(opts.budget ?? DEFAULT_BUDGET, holeId);
    } catch (e) {
      if (e instanceof StratificationError) {
        this.store = backup;
        return { ok: false, diagnostics: [e.message, e.demo] };
      }
      throw e;
    }
    return { ok: true, diagnostics: [] };
  }

  /** Assert a single clause (fact or rule) through the same path as load. */
  assert(text: string, opts: { who?: string } = {}): LoadResult {
    let clauses: Clause[];
    try {
      clauses = parseProgram(text);
    } catch (e) {
      return { ok: false, diagnostics: [(e as Error).message] };
    }
    const diags: string[] = [];
    for (const c of clauses) {
      const err = this.addClause(c, opts.who);
      if (err) diags.push(err);
    }
    return { ok: diags.length === 0, diagnostics: diags };
  }

  /** Assert already-parsed clauses through the same path (tests, replay). */
  assertClauses(clauses: Clause[], opts: { who?: string } = {}): LoadResult {
    const diags: string[] = [];
    for (const c of clauses) {
      const err = this.addClause(c, opts.who);
      if (err) diags.push(err);
    }
    return { ok: diags.length === 0, diagnostics: diags };
  }

  private addClause(c: Clause, who?: string): string | null {
    if (c.body.length === 0) {
      const h = c.head;
      if (h.persp.k !== 'a') return `fact ${canonClause(c)}: perspective must be an atom`;
      if (!h.args.every(isGround)) return `fact ${canonClause(c)}: must be ground`;
      if (h.temporal === 'next') return `fact ${canonClause(c)}: '@next' facts are not assertable`;
      if (h.temporal === 'init' && this.store.tick !== 0) {
        this.diagnostics.push(`fact ${canonClause(c)}: '@init' ignored after tick 0`);
        return null;
      }
      const persp = h.persp.name;
      registerPersp(this.store, persp);
      const scope = RESERVED.has(h.rel) ? 'timeless' as const : 'tick' as const;
      this.store.add(h.rel, persp, h.args, { scope, base: true });
      if (!RESERVED.has(h.rel)) {
        this.store.add(V.edb, MAIN, [mka(h.rel)], { scope: 'timeless', base: true });
      }
      for (const m of factMetaFacts(h.rel, persp, h.args, who)) {
        this.store.add(m.rel, MAIN, m.args, { scope: 'timeless', base: true });
      }
      this.store.dirty = true;
      return null;
    }
    // rule clause
    if (RESERVED.has(c.head.rel)) {
      return `rule rejected: '${c.head.rel}' is a kernel relation (write-protected): ${canonClause(c)}`;
    }
    if (c.head.persp.k === 'a') registerPersp(this.store, c.head.persp.name);
    for (const b of c.body) {
      if ((b.t === 'pos' || b.t === 'neg') && b.lit.persp.k === 'a') {
        registerPersp(this.store, b.lit.persp.name);
      }
    }
    const enc = encodeRule(c);
    for (const f of enc.facts) {
      this.store.add(f.rel, MAIN, f.args, { scope: 'timeless', base: true });
    }
    this.store.dirty = true;
    return null;
  }

  /** Retract a base fact (god-mode API; used by tests and the REPL). */
  retract(text: string): { ok: boolean; diagnostics: string[] } {
    let lit: Lit;
    try { lit = parseLiteral(text); } catch (e) { return { ok: false, diagnostics: [(e as Error).message] }; }
    if (lit.persp.k !== 'a' || !lit.args.every(isGround)) {
      return { ok: false, diagnostics: ['retract needs a ground fact'] };
    }
    const key = factKey(lit.rel, lit.persp.name, lit.args);
    const rec = this.store.get(key);
    if (!rec) return { ok: false, diagnostics: [`no such fact: ${key}`] };
    if (!rec.base) return { ok: false, diagnostics: [`${key} is derived; retract its supports instead`] };
    this.store.remove(key);
    const ft = factTerm(lit.rel, lit.persp.name, lit.args);
    for (const rel of [V.in_perspective, V.asserted_by]) {
      for (const f of this.store.relAll(rel)) {
        if (canonTerm(f.args[0]) === canonTerm(ft)) this.store.remove(f.key);
      }
    }
    this.store.dirty = true;
    return { ok: true, diagnostics: [] };
  }

  // -------------------------------------------------------------------------
  // evaluation

  private ensure(budget: number, holeId: Term): { partial: boolean } {
    if (!this.store.dirty) return { partial: this.store.partialEval };
    const ev = new Evaluation(this.store, { budget, naive: this.naive, holeId });
    const out = ev.run();
    this.lastStaged = out.staged;
    this.lastSteps = ev.steps;
    this.diagnostics.push(...out.diags);
    return { partial: out.partial };
  }

  /** Evaluate now (mainly for tests); throws on unstratifiable programs. */
  evaluate(budget: number = DEFAULT_BUDGET): { partial: boolean } {
    return this.ensure(budget, mka('$adhoc'));
  }

  private prepared(budget: number): Evaluation {
    return new Evaluation(this.store, { budget, naive: this.naive, holeId: mka('$adhoc') });
  }

  // -------------------------------------------------------------------------
  // queries

  query(text: string, opts: { budget?: number } = {}): QueryResult {
    this.qn++;
    const holeId = mkf('$q', [mki(this.qn)]);
    const budget = opts.budget ?? DEFAULT_BUDGET;
    let lit: Lit;
    try { lit = parseLiteral(text); } catch (e) { return { rows: [], partial: false, error: (e as Error).message }; }
    let partial = false;
    try {
      partial = this.ensure(budget, holeId).partial;
    } catch (e) {
      if (e instanceof StratificationError) return { rows: [], partial: false, error: e.message + '\n' + e.demo };
      throw e;
    }
    const ev = this.prepared(budget);
    const vars = [...varsOf(lit.persp, varsOf(mkf('$t', lit.args)))].sort();
    let ms: { s: Subst }[] = [];
    try {
      ms = ev.matchPremise(lit, new Map(), 0, null);
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        this.store.add(V.hole, MAIN, [holeId, mka(BUDGET_REASON)], { scope: 'timeless', base: true, frozen: true });
        partial = true;
      } else throw e;
    }
    const rows = new Map<string, QueryRow>();
    for (const m of ms) {
      const bindings: Record<string, string> = {};
      for (const v of vars) bindings[v] = canonTerm(resolve({ k: 'v', name: v }, m.s));
      const rtext = vars.length === 0 ? 'true' : vars.map((v) => `${v} = ${bindings[v]}`).join(', ');
      if (!rows.has(rtext)) rows.set(rtext, { text: rtext, bindings });
    }
    return { rows: [...rows.keys()].sort().map((k) => rows.get(k)!), partial };
  }

  holds(text: string): boolean {
    return this.query(text).rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // why / whynot / excise

  why(text: string, opts: { budget?: number } = {}): { ok: boolean; text: string } {
    const budget = opts.budget ?? DEFAULT_BUDGET;
    let lit: Lit;
    try { lit = parseLiteral(text); } catch (e) { return { ok: false, text: (e as Error).message }; }
    if (lit.persp.k !== 'a' || !lit.args.every(isGround)) return { ok: false, text: 'why needs a ground literal' };
    try { this.ensure(budget, mka('$adhoc')); } catch (e) {
      if (e instanceof StratificationError) return { ok: false, text: e.message + '\n' + e.demo };
      throw e;
    }
    const key = factKey(lit.rel, lit.persp.name, lit.args);
    if (!this.store.has(key)) {
      return { ok: false, text: `${key} does not hold; try: whynot ${text}` };
    }
    const ev = this.prepared(budget);
    return { ok: true, text: this.renderWhy(ev, key, 0, new Set(), true) };
  }

  private renderWhy(ev: Evaluation, key: string, indent: number, visited: Set<string>, expandNeg: boolean): string {
    const pad = '  '.repeat(indent);
    if (visited.has(key)) return pad + key + ' [cycle]';
    visited.add(key);
    const rec = this.store.get(key);
    const w = this.store.witnesses.get(key);
    let out: string;
    if (!w) {
      out = pad + key + (rec ? ' [axiom]' : ' [past tick]');
    } else {
      const lines = [pad + key + `  <= ${w.ruleId} @tick ${w.tick}`];
      for (const p of w.prems) {
        if (p.t === 'fact') lines.push(this.renderWhy(ev, p.key, indent + 1, visited, expandNeg));
        else if (p.t === 'neg') {
          lines.push('  '.repeat(indent + 1) + 'not ' + p.key + ' [finite failure]');
          if (expandNeg && !p.key.includes('?')) {
            try {
              const sub = this.whynotStruct(p.key, ev, false);
              lines.push(sub.text.split('\n').map((l) => '  '.repeat(indent + 2) + l).join('\n'));
            } catch { /* demo elided */ }
          }
        } else lines.push('  '.repeat(indent + 1) + p.desc + ' [builtin]');
      }
      out = lines.join('\n');
    }
    visited.delete(key);
    return out;
  }

  whynot(text: string, opts: { budget?: number } = {}): { holds: boolean; text: string } {
    const budget = opts.budget ?? DEFAULT_BUDGET;
    try { this.ensure(budget, mka('$adhoc')); } catch (e) {
      if (e instanceof StratificationError) return { holds: false, text: e.message + '\n' + e.demo };
      throw e;
    }
    const ev = this.prepared(budget);
    const r = this.whynotStruct(text, ev, true);
    return { holds: r.holds, text: r.text };
  }

  private whynotStruct(text: string, ev: Evaluation, expandNeg: boolean): { holds: boolean; text: string } {
    const lit = parseLiteral(text);
    const ms = ev.matchPremise(lit, new Map(), 0, null);
    if (ms.length > 0) {
      return { holds: true, text: `${text.trim()} holds; nothing to demonstrate` };
    }
    const rules = ev.rules.filter((r) => r.clause.head.rel === lit.rel);
    const lines: string[] = [`whynot ${ev.resolvedLitKey(lit, new Map())}:`];
    if (rules.length === 0) {
      lines.push(`  no rule concludes '${lit.rel}' and no matching base fact exists`);
      return { holds: false, text: lines.join('\n') };
    }
    for (const r of rules) {
      const rn = (ev as any).renameClause(r.clause) as Clause;
      let s: Subst | null = new Map();
      s = ev.evalBuiltin({ op: '=', l: rn.head.persp, r: lit.persp }, s);
      for (let i = 0; s && i < Math.min(rn.head.args.length, lit.args.length); i++) {
        s = ev.evalBuiltin({ op: '=', l: rn.head.args[i], r: lit.args[i] }, s);
      }
      if (!s || rn.head.args.length !== lit.args.length) {
        lines.push(`  rule ${r.id}: head does not unify`);
        continue;
      }
      const failures = new Set<string>();
      let nodes = 0;
      const explore = (k: number, s0: Subst): void => {
        if (nodes++ > 2000) return;
        if (k >= rn.body.length) return; // a derivation branch survives (demand)
        const b = rn.body[k];
        if (b.t === 'pos') {
          const mm = ev.matchPremise(b.lit, s0, 0, null);
          if (mm.length === 0) failures.add(ev.resolvedLitKey(b.lit, s0));
          else for (const m of mm.slice(0, 16)) explore(k + 1, m.s);
        } else if (b.t === 'neg') {
          const mm = ev.matchPremise(b.lit, s0, 0, null);
          if (mm.length > 0) {
            const witness = mm[0].ref.t === 'fact' ? mm[0].ref.key : ev.resolvedLitKey(b.lit, mm[0].s);
            failures.add(`not ${ev.resolvedLitKey(b.lit, s0)} -- blocked: ${witness} holds`);
          } else explore(k + 1, s0);
        } else {
          const s2 = ev.evalBuiltin(b, s0);
          if (!s2) failures.add(`${canonTerm(resolve(b.l, s0))} ${b.op} ${canonTerm(resolve(b.r, s0))} [builtin fails]`);
          else explore(k + 1, s2);
        }
      };
      try { explore(0, s); } catch (e) {
        if (e instanceof BudgetExhausted) failures.add('[demonstration truncated: budget]');
        else throw e;
      }
      lines.push(`  rule ${r.id}: ${r.canon}`);
      const fs = [...failures].sort().slice(0, 12);
      if (fs.length === 0) lines.push(`    (no failing premise found within exploration bounds)`);
      for (const f of fs) lines.push(`    failed premise: ${f}`);
    }
    return { holds: false, text: lines.join('\n') };
  }

  /** excise: clean re-evaluation on EDB \ {fact}; the diff IS the blast radius. */
  excise(text: string, opts: { budget?: number } = {}): { ok: boolean; removed: string[]; added: string[]; error?: string } {
    const budget = opts.budget ?? DEFAULT_BUDGET;
    let lit: Lit;
    try { lit = parseLiteral(text); } catch (e) { return { ok: false, removed: [], added: [], error: (e as Error).message }; }
    if (lit.persp.k !== 'a' || !lit.args.every(isGround)) {
      return { ok: false, removed: [], added: [], error: 'excise needs a ground fact' };
    }
    const key = factKey(lit.rel, lit.persp.name, lit.args);
    const rec = this.store.get(key);
    if (!rec || !rec.base) return { ok: false, removed: [], added: [], error: `${key} is not a base fact` };
    try { this.ensure(budget, mka('$adhoc')); } catch (e) {
      if (e instanceof StratificationError) return { ok: false, removed: [], added: [], error: e.message };
      throw e;
    }
    const scratch = new Rofl({ naive: this.naive });
    scratch.store = this.store.clone();
    scratch.store.remove(key);
    const ft = factTerm(lit.rel, lit.persp.name, lit.args);
    for (const rel of [V.in_perspective, V.asserted_by]) {
      for (const f of scratch.store.relAll(rel)) {
        if (canonTerm(f.args[0]) === canonTerm(ft)) scratch.store.remove(f.key);
      }
    }
    scratch.store.dirty = true;
    try { scratch.ensure(budget, mka('$adhoc')); } catch (e) {
      if (e instanceof StratificationError) return { ok: false, removed: [], added: [], error: e.message };
      throw e;
    }
    const visible = (s: Store) => new Set(
      [...s.facts.values()]
        .filter((f) => !RESERVED.has(f.rel) && f.rel !== IFACE.stratum && f.rel !== IFACE.unstratified)
        .map((f) => f.key));
    const before = visible(this.store);
    const after = visible(scratch.store);
    const removed = [...before].filter((k) => !after.has(k)).sort();
    const added = [...after].filter((k) => !before.has(k)).sort();
    return { ok: true, removed, added };
  }

  // -------------------------------------------------------------------------
  // time

  /** Run the current tick to fixpoint, then advance if not quiescent.
   *  onFixpoint (the tick-boundary hook) observes the tick at fixpoint,
   *  before the world advances. */
  tickAdvance(opts: { budget?: number; onFixpoint?: (r: Rofl) => void } = {}):
      { advanced: boolean; quiescent: boolean; partial: boolean } {
    const budget = opts.budget ?? DEFAULT_BUDGET;
    const holeId = mkf('$tick', [mki(this.store.tick)]);
    const { partial } = this.ensure(budget, holeId);
    if (partial) return { advanced: false, quiescent: false, partial: true };
    opts.onFixpoint?.(this);
    const staged = this.lastStaged;
    const curBase = [...this.store.facts.values()]
      .filter((f) => f.scope === 'tick' && f.base).map((f) => f.key).sort();
    const stagedKeys = staged.map((f) => f.key);
    if (curBase.length === stagedKeys.length && curBase.every((k, i) => k === stagedKeys[i])) {
      return { advanced: false, quiescent: true, partial: false };
    }
    this.store.advanceTick(staged.map(({ rel, persp, args }) => ({ rel, persp, args })));
    const t = this.store.tick;
    this.store.tickLog.push(`tick ${t}: ${stagedKeys.join(' ') || '(empty)'}`);
    for (const f of staged) {
      const sig = f.ruleId + '|' + f.prems.map(sigOf).join('|');
      this.store.support(f.key, sig, { ruleId: f.ruleId, tick: t, prems: f.prems });
      this.store.add(V.derived_by, MAIN, [factTerm(f.rel, f.persp, f.args), mka(f.ruleId), mki(t)],
        { scope: 'timeless', base: false, frozen: true });
    }
    this.lastStaged = [];
    return { advanced: true, quiescent: false, partial: false };
  }

  /** Advance ticks until quiescence, budget exhaustion, or maxTicks. */
  run(opts: { maxTicks?: number; budget?: number; onBoundary?: (r: Rofl) => void } = {}):
      { ticks: number; quiescent: boolean; partial: boolean } {
    const maxTicks = opts.maxTicks ?? 1000;
    let left = opts.budget ?? DEFAULT_BUDGET;
    for (let i = 0; i < maxTicks; i++) {
      const res = this.tickAdvance({ budget: left, onFixpoint: opts.onBoundary });
      left -= this.lastSteps;
      if (res.partial) return { ticks: this.store.tick, quiescent: false, partial: true };
      if (res.quiescent) return { ticks: this.store.tick, quiescent: true, partial: false };
      if (left <= 0) {
        this.store.add(V.hole, MAIN, [mkf('$tick', [mki(this.store.tick)]), mka(BUDGET_REASON)],
          { scope: 'timeless', base: true, frozen: true });
        return { ticks: this.store.tick, quiescent: false, partial: true };
      }
    }
    return { ticks: this.store.tick, quiescent: false, partial: false };
  }

  // -------------------------------------------------------------------------
  // introspection helpers (tests, REPL)

  factKeys(rel?: string): string[] {
    const out = [...this.store.facts.keys()].filter((k) => !rel || this.store.get(k)!.rel === rel);
    return out.sort();
  }

  strataPlan(): { rule: string; rel: string; level: number | null }[] {
    return this.prepared(DEFAULT_BUDGET).strataPlan();
  }
}
