// store.ts — fact store. Map-based, perspective-tagged, deterministic.
// The store is generic: it knows no relation names at all.

import { type Term, canonTerm, termToJson, termFromJson } from './unify.ts';

export type Scope = 'timeless' | 'tick';

export interface FactRec {
  key: string;
  rel: string;
  persp: string;
  args: Term[];
  scope: Scope;
  base: boolean;    // asserted (EDB / kernel-emitted) rather than rule-derived
  frozen: boolean;  // provenance from completed ticks; survives re-evaluation
}

export type PremRef =
  | { t: 'fact'; key: string }
  | { t: 'neg'; key: string }      // canonical key of the absent fact pattern
  | { t: 'bi'; desc: string };

export interface Witness { ruleId: string; tick: number; prems: PremRef[]; }

export function factKey(rel: string, persp: string, args: Term[]): string {
  return `${rel}[${persp}](${args.map(canonTerm).join(',')})`;
}

export class Store {
  tick = 0;
  facts = new Map<string, FactRec>();
  witnesses = new Map<string, Witness>();
  firings = new Map<string, Set<string>>();     // fact key -> firing signatures (support)
  tickLog: string[] = [];
  dirty = true;          // derived layer out of date w.r.t. base facts
  partialEval = false;   // last evaluation hit its budget

  private idx = new Map<string, Map<string, string[]>>(); // rel -> persp -> sorted keys

  /** Add a fact. Returns true if it was new. */
  add(rel: string, persp: string, args: Term[], opts: { scope: Scope; base: boolean; frozen?: boolean }): boolean {
    const key = factKey(rel, persp, args);
    const existing = this.facts.get(key);
    if (existing) {
      // base assertion wins over an earlier derived copy
      if (opts.base && !existing.base) existing.base = true;
      return false;
    }
    this.facts.set(key, { key, rel, persp, args, scope: opts.scope, base: opts.base, frozen: opts.frozen ?? false });
    let byP = this.idx.get(rel);
    if (!byP) { byP = new Map(); this.idx.set(rel, byP); }
    let arr = byP.get(persp);
    if (!arr) { arr = []; byP.set(persp, arr); }
    // binary insertion keeps every index canonically sorted at all times
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < key) lo = mid + 1; else hi = mid;
    }
    arr.splice(lo, 0, key);
    return true;
  }

  has(key: string): boolean { return this.facts.has(key); }
  get(key: string): FactRec | undefined { return this.facts.get(key); }

  remove(key: string): boolean {
    const rec = this.facts.get(key);
    if (!rec) return false;
    this.facts.delete(key);
    this.witnesses.delete(key);
    this.firings.delete(key);
    const arr = this.idx.get(rec.rel)?.get(rec.persp);
    if (arr) {
      const i = arr.indexOf(key);
      if (i >= 0) arr.splice(i, 1);
    }
    return true;
  }

  /** All facts of a relation in one perspective, canonically sorted. */
  relPersp(rel: string, persp: string): FactRec[] {
    const arr = this.idx.get(rel)?.get(persp);
    if (!arr || arr.length === 0) return [];
    return arr.map((k) => this.facts.get(k)!).filter(Boolean);
  }

  /** All facts of a relation across perspectives, canonically sorted. */
  relAll(rel: string): FactRec[] {
    const byP = this.idx.get(rel);
    if (!byP) return [];
    const persps = [...byP.keys()].sort();
    const out: FactRec[] = [];
    for (const p of persps) out.push(...this.relPersp(rel, p));
    return out;
  }

  perspectivesOf(rel: string): string[] {
    const byP = this.idx.get(rel);
    return byP ? [...byP.keys()].sort() : [];
  }

  relCount(rel: string): number {
    let n = 0;
    const byP = this.idx.get(rel);
    if (byP) for (const arr of byP.values()) n += arr.length;
    return n;
  }

  /** Drop the derived (non-base, non-frozen) layer before re-evaluation. */
  clearDerived(): void {
    const toDrop: string[] = [];
    for (const rec of this.facts.values()) {
      if (!rec.base && !rec.frozen) toDrop.push(rec.key);
    }
    for (const k of toDrop) this.remove(k);
    this.partialEval = false;
  }

  /** Record a firing supporting a fact; keeps the first witness only.
   *  Returns true if this firing signature was new. */
  support(key: string, sig: string, w: Witness): boolean {
    let set = this.firings.get(key);
    if (!set) { set = new Set(); this.firings.set(key, set); }
    if (set.has(sig)) return false;
    set.add(sig);
    if (!this.witnesses.has(key)) this.witnesses.set(key, w);
    return true;
  }

  supportCount(key: string): number { return this.firings.get(key)?.size ?? 0; }

  /** End the current tick: freeze provenance, drop tick-scoped facts,
   *  install the staged next-tick base facts, advance the clock. */
  advanceTick(staged: { rel: string; persp: string; args: Term[] }[]): void {
    for (const rec of this.facts.values()) {
      if (!rec.base && rec.scope === 'timeless') rec.frozen = true;
    }
    const toDrop: string[] = [];
    for (const rec of this.facts.values()) if (rec.scope === 'tick') toDrop.push(rec.key);
    const keptWitnessKeys = new Set(staged.map((f) => factKey(f.rel, f.persp, f.args)));
    for (const k of toDrop) {
      const keepW = keptWitnessKeys.has(k);
      const w = this.witnesses.get(k);
      const f = this.firings.get(k);
      this.remove(k);
      if (keepW && w) this.witnesses.set(k, w);
      if (keepW && f) this.firings.set(k, f);
    }
    this.tick++;
    for (const f of staged) this.add(f.rel, f.persp, f.args, { scope: 'tick', base: true });
    this.dirty = true;
  }

  /** Canonical serialization of everything an observer can distinguish. */
  canonicalState(): string {
    const keys = [...this.facts.keys()].sort();
    const lines: string[] = [`tick ${this.tick}`];
    for (const k of keys) {
      const r = this.facts.get(k)!;
      lines.push(`${k} ${r.scope} ${r.base ? 'base' : 'drv'}${r.frozen ? ' frozen' : ''} support=${this.supportCount(k)}`);
    }
    const wkeys = [...this.witnesses.keys()].sort();
    for (const k of wkeys) {
      const w = this.witnesses.get(k)!;
      lines.push(`wit ${k} <- ${w.ruleId}@${w.tick} [${w.prems.map((p) => p.t + ':' + (p.t === 'bi' ? p.desc : p.key)).join('; ')}]`);
    }
    lines.push(...this.tickLog);
    return lines.join('\n');
  }

  snapshot(): string {
    const facts = [...this.facts.keys()].sort().map((k) => {
      const r = this.facts.get(k)!;
      return { rel: r.rel, persp: r.persp, args: r.args.map(termToJson), scope: r.scope, base: r.base, frozen: r.frozen };
    });
    const wits = [...this.witnesses.keys()].sort().map((k) => {
      const w = this.witnesses.get(k)!;
      return { key: k, ruleId: w.ruleId, tick: w.tick, prems: w.prems };
    });
    const firings = [...this.firings.keys()].sort().map((k) => ({ key: k, sigs: [...this.firings.get(k)!].sort() }));
    return JSON.stringify({ tick: this.tick, facts, wits, firings, tickLog: this.tickLog });
  }

  static restore(json: string): Store {
    const d = JSON.parse(json);
    const s = new Store();
    s.tick = d.tick;
    s.tickLog = d.tickLog ?? [];
    for (const f of d.facts) {
      s.add(f.rel, f.persp, f.args.map(termFromJson), { scope: f.scope, base: f.base, frozen: f.frozen });
    }
    for (const w of d.wits ?? []) s.witnesses.set(w.key, { ruleId: w.ruleId, tick: w.tick, prems: w.prems });
    for (const f of d.firings ?? []) s.firings.set(f.key, new Set(f.sigs));
    s.dirty = true;
    return s;
  }

  /** Deep copy (used for load rollback and excise). */
  clone(): Store {
    return Store.restore(this.snapshot());
  }
}
