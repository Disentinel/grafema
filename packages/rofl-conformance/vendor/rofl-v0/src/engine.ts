// engine.ts — seminaive fixpoint, strata, ticks, provenance emission, budgets.
// The evaluator reads rules ONLY from the reflected store (decodeRules).
// Stratum assignment is READ from stratum/2 facts (computed by boot.rofl's
// stratum-0 rules); the kernel contains no stratification checker.

import {
  type Term, type Subst, mka, mki, canonTerm, resolve, unify, walk, isGround, varsOf, evalArith,
} from './unify.ts';
import type { Lit, BodyElem, Clause } from './parser.ts';
import { type Store, type FactRec, type PremRef, factKey } from './store.ts';
import {
  V, IFACE, RESERVED, decodeRules, type DRule, factTerm, canonBodyElem, canonLit,
  BUDGET_REASON, MAIN,
} from './reflect.ts';

export class BudgetExhausted extends Error {
  constructor() { super('budget exhausted'); }
}

export class StratificationError extends Error {
  demo: string;
  constructor(msg: string, demo: string) { super(msg); this.demo = demo; }
}

export interface ERule extends DRule {
  safe: boolean;          // materializable bottom-up in written premise order
  hasNeg: boolean;
  posRels: string[];
  hasDemandPrem: boolean; // some positive premise targets a demand-backed relation
  triggerRels: Set<string>;
}

export interface StagedFact {
  key: string; rel: string; persp: string; args: Term[];
  ruleId: string; prems: PremRef[];
}

export interface EvalOutcome { partial: boolean; staged: StagedFact[]; diags: string[]; }

const MAX_DEPTH = 512;

interface Sol { s: Subst; prems: PremRef[]; }
interface FrontInfo { keys: Set<string>; rels: Set<string>; }

export class Evaluation {
  store: Store;
  budget: number;
  naive: boolean;
  holeId: Term;
  steps = 0;
  diags: string[] = [];
  rules: ERule[] = [];
  demandRels = new Map<string, ERule[]>();
  private active: ERule[] = [];
  private staged = new Map<string, StagedFact>();
  private renameCounter = 0;
  private curFront: FrontInfo = { keys: new Set(), rels: new Set() };

  constructor(store: Store, opts: { budget?: number; naive?: boolean; holeId?: Term } = {}) {
    this.store = store;
    this.budget = opts.budget ?? 100_000;
    this.naive = opts.naive ?? false;
    this.holeId = opts.holeId ?? mka('$adhoc');
    this.prepare();
  }

  /** Decode rules from the store and classify them. Read-only. */
  prepare(): void {
    const { rules, diagnostics } = decodeRules(this.store);
    this.diags.push(...diagnostics);
    const kept: ERule[] = [];
    for (const r of rules) {
      if (RESERVED.has(r.clause.head.rel)) {
        this.diags.push(`rule ${r.id} concludes into a kernel relation; not executable`);
        continue;
      }
      kept.push(this.classify(r));
    }
    this.rules = kept;
    // A relation is demand-backed (unfolded at call sites) when some @now
    // rule defining it is unsafe, or transitively depends on a demand-backed
    // relation through a positive premise. @next rules never unfold.
    const nowRulesByRel = new Map<string, ERule[]>();
    for (const r of kept) {
      if (r.clause.head.temporal === 'next') continue;
      let arr = nowRulesByRel.get(r.clause.head.rel);
      if (!arr) { arr = []; nowRulesByRel.set(r.clause.head.rel, arr); }
      arr.push(r);
    }
    const unfoldable = new Set<string>();
    for (const [rel, rs] of nowRulesByRel) if (rs.some((r) => !r.safe)) unfoldable.add(rel);
    for (;;) {
      let grew = false;
      for (const [rel, rs] of nowRulesByRel) {
        if (unfoldable.has(rel)) continue;
        for (const r of rs) {
          if (r.posRels.some((x) => unfoldable.has(x))) { unfoldable.add(rel); grew = true; break; }
        }
      }
      if (!grew) break;
    }
    this.demandRels = new Map();
    for (const rel of [...unfoldable].sort()) {
      this.demandRels.set(rel, nowRulesByRel.get(rel)!);
    }
    // demand closure per relation, then trigger relations per rule
    const closure = new Map<string, Set<string>>();
    const closeRel = (rel: string, seen: Set<string>): Set<string> => {
      const cached = closure.get(rel);
      if (cached) return cached;
      const out = new Set<string>([rel]);
      if (!seen.has(rel)) {
        seen.add(rel);
        for (const dr of this.demandRels.get(rel) ?? []) {
          for (const b of dr.clause.body) {
            if (b.t === 'pos') for (const x of closeRel(b.lit.rel, seen)) out.add(x);
          }
        }
      }
      closure.set(rel, out);
      return out;
    };
    for (const r of kept) {
      r.hasDemandPrem = r.posRels.some((x) => this.demandRels.has(x));
      r.triggerRels = new Set();
      for (const p of r.posRels) for (const x of closeRel(p, new Set())) r.triggerRels.add(x);
    }
  }

  private classify(r: DRule): ERule {
    const bound = new Set<string>();
    let safe = true;
    let hasNeg = false;
    const posRels: string[] = [];
    const groundIn = (t: Term) => [...varsOf(t)].every((v) => bound.has(v));
    const bindAll = (t: Term) => { for (const v of varsOf(t)) bound.add(v); };
    for (const b of r.clause.body) {
      if (b.t === 'pos') {
        posRels.push(b.lit.rel);
        for (const a of b.lit.args) bindAll(a);
        bindAll(b.lit.persp);
      } else if (b.t === 'neg') {
        hasNeg = true;
      } else {
        if (b.op === '=') {
          if (groundIn(b.l)) bindAll(b.r);
          else if (groundIn(b.r)) bindAll(b.l);
          else safe = false;
        } else if (b.op === 'is') {
          if (groundIn(b.r)) bindAll(b.l);
          else safe = false;
        } else {
          if (!groundIn(b.l) || !groundIn(b.r)) safe = false;
        }
      }
    }
    const h = r.clause.head;
    if (!h.args.every(groundIn) || !groundIn(h.persp)) safe = false;
    return { ...r, safe, hasNeg, posRels, hasDemandPrem: false, triggerRels: new Set() };
  }

  // -------------------------------------------------------------------------
  // pipeline

  /** Evaluate the current tick to fixpoint. Throws StratificationError when
   *  the loaded program is demonstrably unstratifiable. */
  run(): EvalOutcome {
    this.store.clearDerived();
    this.active = [];
    this.staged.clear();
    this.steps = 0;
    let partial = false;
    const safeRules = this.rules.filter((r) => r.safe);
    const mono = safeRules.filter((r) => !r.hasNeg);
    const negRules = safeRules.filter((r) => r.hasNeg);
    try {
      // phase A: monotone rules to fixpoint
      this.activate(mono);
      this.checkUnstratified(negRules.length > 0);
      // strata read from the store; unknown strata run in a final pass
      const strat = this.readStrata();
      const levelOf = (r: ERule) => strat.get(r.clause.head.rel) ?? Infinity;
      const levels = [...new Set(negRules.map(levelOf))].sort((a, b) => a - b);
      for (const lv of levels) {
        this.activate(negRules.filter((r) => levelOf(r) === lv));
      }
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        this.checkUnstratified(negRules.length > 0);
        partial = true;
        this.store.add(V.hole, MAIN, [this.holeId, mka(BUDGET_REASON)],
          { scope: 'timeless', base: true, frozen: true });
      } else throw e;
    }
    this.store.dirty = false;
    this.store.partialEval = partial;
    const stagedSorted = [...this.staged.keys()].sort().map((k) => this.staged.get(k)!);
    return { partial, staged: partial ? [] : stagedSorted, diags: this.diags };
  }

  private checkUnstratified(programHasNegation: boolean): void {
    if (!programHasNegation) return;
    const un = this.store.relAll(IFACE.unstratified);
    if (un.length === 0) return;
    const first = un[0];
    const demo = this.whyText(first.key);
    throw new StratificationError(
      `program rejected: ${un.map((f) => f.key).join(', ')}`, demo);
  }

  readStrata(): Map<string, number> {
    const out = new Map<string, number>();
    for (const f of this.store.relAll(IFACE.stratum)) {
      const [rel, n] = f.args;
      if (rel.k !== 'a' || n.k !== 'i') continue;
      const cur = out.get(rel.name);
      if (cur === undefined || n.v > cur) out.set(rel.name, n.v);
    }
    return out;
  }

  /** For tests: the stratum plan actually used, straight from the store. */
  strataPlan(): { rule: string; rel: string; level: number | null }[] {
    const strat = this.readStrata();
    return this.rules.filter((r) => r.safe && r.hasNeg).map((r) => ({
      rule: r.id,
      rel: r.clause.head.rel,
      level: strat.get(r.clause.head.rel) ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // fixpoint machinery

  private activate(rules: ERule[]): void {
    if (rules.length === 0) return;
    const sorted = [...rules].sort((a, b) => (a.canon < b.canon ? -1 : 1));
    this.active.push(...sorted);
    this.active.sort((a, b) => (a.canon < b.canon ? -1 : 1));
    const front: FrontInfo = { keys: new Set(), rels: new Set() };
    this.curFront = front;
    for (const r of sorted) this.fireRule(r, null, front);
    this.propagate(front);
  }

  private propagate(front: FrontInfo): void {
    while (front.keys.size > 0) {
      const cur = front;
      const next: FrontInfo = { keys: new Set(), rels: new Set() };
      this.curFront = next;
      for (const r of this.active) {
        if (this.naive) { this.fireRule(r, null, next); continue; }
        let relevant = false;
        for (const rel of r.triggerRels) if (cur.rels.has(rel)) { relevant = true; break; }
        if (!relevant) continue;
        if (r.hasDemandPrem) this.fireRule(r, null, next);
        else this.fireRuleFront(r, cur, next);
      }
      front = next;
    }
  }

  private fireRule(r: ERule, frontAt: { pos: number; keys: Set<string> } | null, out: FrontInfo): void {
    const sols = this.solveBody(r.clause.body, new Map(), 0, frontAt);
    for (const sol of sols) this.conclude(r, sol, out);
  }

  private fireRuleFront(r: ERule, cur: FrontInfo, out: FrontInfo): void {
    r.clause.body.forEach((b, i) => {
      if (b.t !== 'pos') return;
      if (!cur.rels.has(b.lit.rel)) return;
      this.fireRule(r, { pos: i, keys: cur.keys }, out);
    });
  }

  private conclude(r: ERule, sol: Sol, out: FrontInfo): void {
    const h = r.clause.head;
    const perspT = walk(h.persp, sol.s);
    const args = perspT.k === 'a' ? h.args.map((a) => resolve(a, sol.s)) : [];
    if (perspT.k !== 'a' || !args.every(isGround)) {
      // expected for demand-backed heads matched bottom-up with open bindings;
      // a genuine mode error for anything else
      if (!this.demandRels.has(h.rel)) {
        const msg = `rule ${r.id}: non-ground or open conclusion skipped (${h.rel})`;
        if (!this.diags.includes(msg)) this.diags.push(msg);
      }
      return;
    }
    const persp = perspT.name;
    const key = factKey(h.rel, persp, args);
    const sig = r.id + '|' + sol.prems.map(sigOf).join('|');
    if (h.temporal === 'next') {
      if (!this.staged.has(key)) {
        this.staged.set(key, { key, rel: h.rel, persp, args, ruleId: r.id, prems: sol.prems });
        this.bumpSteps();
      }
      return;
    }
    const isNew = this.store.add(h.rel, persp, args, { scope: 'tick', base: false });
    const newFiring = this.store.support(key, sig, { ruleId: r.id, tick: this.store.tick, prems: sol.prems });
    if (newFiring) {
      this.bumpSteps();
      const dbArgs = [factTerm(h.rel, persp, args), mka(r.id), mki(this.store.tick)];
      const dbNew = this.store.add(V.derived_by, MAIN, dbArgs, { scope: 'timeless', base: false });
      if (dbNew) {
        const dbKey = factKey(V.derived_by, MAIN, dbArgs);
        out.keys.add(dbKey); out.rels.add(V.derived_by);
      }
    }
    if (isNew) { out.keys.add(key); out.rels.add(h.rel); }
  }

  private bumpSteps(): void {
    this.steps++;
    if (this.steps > this.budget) throw new BudgetExhausted();
  }

  // -------------------------------------------------------------------------
  // body solving (shared by bottom-up firing, demand unfolding, and whynot)

  solveBody(body: BodyElem[], s0: Subst, depth: number,
            frontAt: { pos: number; keys: Set<string> } | null = null): Sol[] {
    let acc: Sol[] = [{ s: s0, prems: [] }];
    for (let i = 0; i < body.length; i++) {
      const b = body[i];
      const next: Sol[] = [];
      for (const a of acc) {
        if (b.t === 'pos') {
          const only = frontAt && frontAt.pos === i ? frontAt.keys : null;
          for (const m of this.matchPremise(b.lit, a.s, depth, only)) {
            next.push({ s: m.s, prems: [...a.prems, m.ref] });
          }
        } else if (b.t === 'neg') {
          if (this.matchPremise(b.lit, a.s, depth, null).length === 0) {
            const inst = this.resolvedLitKey(b.lit, a.s);
            next.push({ s: a.s, prems: [...a.prems, { t: 'neg', key: inst }] });
          }
        } else {
          const s2 = this.evalBuiltin(b, a.s);
          if (s2) {
            const desc = `${canonTerm(resolve(b.l, s2))} ${b.op} ${canonTerm(resolve(b.r, s2))}`;
            next.push({ s: s2, prems: [...a.prems, { t: 'bi', desc }] });
          }
        }
      }
      acc = next;
      if (acc.length === 0) break;
    }
    return acc;
  }

  resolvedLitKey(lit: Lit, s: Subst): string {
    const p = walk(lit.persp, s);
    return `${lit.rel}[${canonTerm(p)}](${lit.args.map((a) => canonTerm(resolve(a, s))).join(',')})`;
  }

  /** Matches for one positive premise: store facts plus demand unfolding. */
  matchPremise(lit: Lit, s: Subst, depth: number,
               only: Set<string> | null): { s: Subst; ref: PremRef }[] {
    if (lit.temporal === 'init' && this.store.tick !== 0) return [];
    const perspT = walk(lit.persp, s);
    let cands: FactRec[];
    if (only) {
      // seminaive: iterate the (small) front, not the whole relation
      cands = [...only].sort()
        .map((k) => this.store.get(k))
        .filter((f): f is FactRec => !!f && f.rel === lit.rel &&
          (perspT.k !== 'a' || f.persp === perspT.name));
    } else {
      cands = perspT.k === 'a'
        ? this.store.relPersp(lit.rel, perspT.name)
        : this.store.relAll(lit.rel);
    }
    const out: { s: Subst; ref: PremRef }[] = [];
    const seen = new Set<string>();
    for (const f of cands) {
      let s2: Subst | null = perspT.k === 'a' ? s : unify(perspT, mka(f.persp), s);
      if (!s2) continue;
      if (f.args.length !== lit.args.length) continue;
      for (let i = 0; i < f.args.length && s2; i++) s2 = unify(lit.args[i], f.args[i], s2);
      if (!s2) continue;
      if (!seen.has(f.key)) { seen.add(f.key); out.push({ s: s2, ref: { t: 'fact', key: f.key } }); }
    }
    const drs = this.demandRels.get(lit.rel);
    if (drs) {
      for (const dr of drs) {
        for (const m of this.solveDemandRule(dr, lit, s, depth)) {
          const dk = m.ref.t === 'fact' ? m.ref.key : this.resolvedLitKey(lit, m.s);
          if (only && m.ref.t === 'fact' && !only.has(m.ref.key) && this.store.has(m.ref.key)) {
            // already-materialized demand result outside the front window
            if (seen.has(dk)) continue;
          }
          if (!seen.has(dk)) { seen.add(dk); out.push(m); }
        }
      }
    }
    out.sort((a, b) => {
      const ka = a.ref.t === 'fact' ? a.ref.key : this.resolvedLitKey(lit, a.s);
      const kb = b.ref.t === 'fact' ? b.ref.key : this.resolvedLitKey(lit, b.s);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return out;
  }

  /** Top-down unfolding of a moded (demand) rule at a call site. Ground
   *  results are materialized into the store with full provenance. */
  private solveDemandRule(r: ERule, call: Lit, s: Subst, depth: number): { s: Subst; ref: PremRef }[] {
    this.bumpSteps();
    if (depth > MAX_DEPTH) throw new BudgetExhausted();
    const rn = this.renameClause(r.clause);
    const h = rn.head;
    if (h.rel !== call.rel || h.args.length !== call.args.length) return [];
    let s2: Subst | null = unify(h.persp, walk(call.persp, s), s);
    if (!s2) return [];
    for (let i = 0; i < h.args.length && s2; i++) s2 = unify(h.args[i], call.args[i], s2);
    if (!s2) return [];
    const sols = this.solveBody(rn.body, s2, depth + 1);
    const out: { s: Subst; ref: PremRef }[] = [];
    for (const sol of sols) {
      const persp = walk(h.persp, sol.s);
      const args = h.args.map((a) => resolve(a, sol.s));
      if (persp.k === 'a' && args.every(isGround)) {
        const key = factKey(call.rel, persp.name, args);
        const isNew = this.store.add(call.rel, persp.name, args, { scope: 'tick', base: false });
        const sig = r.id + '|' + sol.prems.map(sigOf).join('|');
        const newFiring = this.store.support(key, sig, { ruleId: r.id, tick: this.store.tick, prems: sol.prems });
        if (newFiring) {
          const dbArgs = [factTerm(call.rel, persp.name, args), mka(r.id), mki(this.store.tick)];
          this.store.add(V.derived_by, MAIN, dbArgs, { scope: 'timeless', base: false });
        }
        if (isNew) { this.curFront.keys.add(key); this.curFront.rels.add(call.rel); }
        out.push({ s: sol.s, ref: { t: 'fact', key } });
      } else {
        out.push({ s: sol.s, ref: { t: 'bi', desc: 'open ' + this.resolvedLitKey(call, sol.s) } });
      }
    }
    return out;
  }

  renameClause(c: Clause): Clause {
    const n = this.renameCounter++;
    const rt = (t: Term): Term => {
      if (t.k === 'v') return { k: 'v', name: t.name + '#' + n };
      if (t.k === 'f') return { k: 'f', name: t.name, args: t.args.map(rt) };
      return t;
    };
    const rl = (l: Lit): Lit => ({ ...l, persp: rt(l.persp), args: l.args.map(rt) });
    return {
      head: rl(c.head),
      body: c.body.map((b) =>
        b.t === 'bi' ? { ...b, l: rt(b.l), r: rt(b.r) } : { ...b, lit: rl(b.lit) }),
    };
  }

  evalBuiltin(b: { op: string; l: Term; r: Term }, s: Subst): Subst | null {
    switch (b.op) {
      case '=': return unify(b.l, b.r, s);
      case '!=': {
        const l = resolve(b.l, s), r = resolve(b.r, s);
        if (!isGround(l) || !isGround(r)) return null;
        return canonTerm(l) !== canonTerm(r) ? s : null;
      }
      case 'is': {
        const rv = evalArith(b.r, s);
        if (rv === null) return null;
        return unify(b.l, mki(rv), s);
      }
      default: {
        const lv = evalArith(b.l, s), rv = evalArith(b.r, s);
        if (lv === null || rv === null) return null;
        const ok = b.op === '<' ? lv < rv : b.op === '<=' ? lv <= rv
          : b.op === '>' ? lv > rv : b.op === '>=' ? lv >= rv : false;
        return ok ? s : null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // explanation support (used by api's why)

  whyText(key: string, indent = 0, visited: Set<string> = new Set()): string {
    const pad = '  '.repeat(indent);
    const rec = this.store.get(key);
    const w = this.store.witnesses.get(key);
    if (visited.has(key)) return pad + key + ' [cycle]';
    visited.add(key);
    if (rec && rec.base && !w) return pad + key + ' [axiom]';
    if (!w) return pad + key + (rec ? ' [axiom]' : ' [not present]');
    const lines = [pad + key + `  <= ${w.ruleId} @tick ${w.tick}`];
    for (const p of w.prems) {
      if (p.t === 'fact') lines.push(this.whyText(p.key, indent + 1, visited));
      else if (p.t === 'neg') lines.push('  '.repeat(indent + 1) + 'not ' + p.key + ' [absent]');
      else lines.push('  '.repeat(indent + 1) + p.desc + ' [builtin]');
    }
    visited.delete(key);
    return lines.join('\n');
  }
}

export function sigOf(p: PremRef): string {
  return p.t === 'bi' ? 'b:' + p.desc : p.t + ':' + p.key;
}
