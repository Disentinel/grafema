// reflect.ts — rules ⇄ subgraphs in the SAME store.
// After parsing, every rule is stored as facts; the evaluator reads rules
// only from the store (decodeRules). This file is the single place where
// the kernel's relation vocabulary appears — see scripts/kernel_grep.ts.

import { type Term, mka, mks, mkv, mkf, canonTerm, fnv1a } from './unify.ts';
import type { Clause, Lit, BodyElem, Temporal } from './parser.ts';
import { type Store } from './store.ts';

/** §2 kernel vocabulary: reserved, write-protected relations. */
export const V = {
  derived_by: 'derived_by',
  rule: 'rule',
  has_premise: 'has_premise',
  premise_pos: 'premise_pos',
  premise_neg: 'premise_neg',
  concludes: 'concludes',
  has_conclusion: 'has_conclusion',
  reads_from: 'reads_from',
  writes_to: 'writes_to',
  mode: 'mode',
  reserved: 'reserved',
  authority: 'authority',
  asserted_by: 'asserted_by',
  hole: 'hole',
  edb: 'edb',
  // reflection detail relations (documented §2 extension, per Appendix A note)
  bridge_decl: 'bridge_decl',
  in_perspective: 'in_perspective',
  uses_builtin: 'uses_builtin',
  premise_lit: 'premise_lit',
  conclusion_lit: 'conclusion_lit',
} as const;

export const RESERVED: ReadonlySet<string> = new Set(Object.values(V));

/** Stratification interface: the kernel READS these, boot.rofl writes them.
 *  Not reserved (rules may conclude into them). Documented in README. */
export const IFACE = { stratum: 'stratum', unstratified: 'unstratified' } as const;

export const MAIN = 'main';
export const KERNEL_WHO = '$kernel';
export const ANY_PERSP = '$any';
export const BUDGET_REASON = 'budget_exhausted';

export const BUILTIN_OPS = ['=', '!=', '<', '<=', '>', '>=', 'is'] as const;

// ---------------------------------------------------------------------------
// term-level reification helpers

export function list(items: Term[]): Term {
  let t: Term = mka('$nil');
  for (let i = items.length - 1; i >= 0; i--) t = mkf('$cons', [items[i], t]);
  return t;
}

export function unlist(t: Term): Term[] {
  const out: Term[] = [];
  while (t.k === 'f' && t.name === '$cons') { out.push(t.args[0]); t = t.args[1]; }
  return out;
}

export function reifyTerm(t: Term): Term {
  if (t.k === 'v') return mkf('$var', [mks(t.name)]);
  if (t.k === 'f') return mkf(t.name, t.args.map(reifyTerm));
  return t;
}

export function unreifyTerm(t: Term): Term {
  if (t.k === 'f' && t.name === '$var' && t.args.length === 1 && t.args[0].k === 's') {
    return mkv(t.args[0].v);
  }
  if (t.k === 'f') return mkf(t.name, t.args.map(unreifyTerm));
  return t;
}

export function reifyLit(l: Lit): Term {
  return mkf('$lit', [mka(l.rel), reifyTerm(l.persp), list(l.args.map(reifyTerm)), mka('$' + l.temporal)]);
}

export function unreifyLit(t: Term): Lit {
  if (t.k !== 'f' || t.name !== '$lit' || t.args.length !== 4) throw new Error('bad reified literal: ' + canonTerm(t));
  const [rel, persp, args, tmp] = t.args;
  if (rel.k !== 'a' || tmp.k !== 'a') throw new Error('bad reified literal: ' + canonTerm(t));
  return {
    rel: rel.name,
    persp: unreifyTerm(persp),
    perspExplicit: true,
    args: unlist(args).map(unreifyTerm),
    temporal: tmp.name.slice(1) as Temporal,
  };
}

export function reifyBodyElem(b: BodyElem): Term {
  if (b.t === 'pos') return reifyLit(b.lit);
  if (b.t === 'neg') return mkf('$not', [reifyLit(b.lit)]);
  return mkf('$builtin', [mks(b.op), list([reifyTerm(b.l), reifyTerm(b.r)])]);
}

export function unreifyBodyElem(t: Term): BodyElem {
  if (t.k === 'f' && t.name === '$not') return { t: 'neg', lit: unreifyLit(t.args[0]) };
  if (t.k === 'f' && t.name === '$builtin') {
    const [op, args] = t.args;
    if (op.k !== 's') throw new Error('bad reified builtin');
    const [l, r] = unlist(args).map(unreifyTerm);
    return { t: 'bi', op: op.v, l, r };
  }
  return { t: 'pos', lit: unreifyLit(t) };
}

/** Ground fact as a term, for derived_by / in_perspective / asserted_by. */
export function factTerm(rel: string, persp: string, args: Term[]): Term {
  return mkf('$fact', [mka(rel), mka(persp), list(args)]);
}

// ---------------------------------------------------------------------------
// canonical clause serialization and content-addressed rule ids

export function canonLit(l: Lit): string {
  return `${l.rel}[${canonTerm(l.persp)}](${l.args.map(canonTerm).join(',')})@${l.temporal}`;
}

export function canonBodyElem(b: BodyElem): string {
  if (b.t === 'pos') return canonLit(b.lit);
  if (b.t === 'neg') return 'not ' + canonLit(b.lit);
  return `${canonTerm(b.l)} ${b.op} ${canonTerm(b.r)}`;
}

export function canonClause(c: Clause): string {
  if (c.body.length === 0) return canonLit(c.head);
  return canonLit(c.head) + ' :- ' + c.body.map(canonBodyElem).join(', ');
}

export function ruleIdOf(c: Clause): string {
  return 'r' + fnv1a(canonClause(c));
}

// ---------------------------------------------------------------------------
// encoding: rule clause → reflection facts

export interface EncFact { rel: string; args: Term[]; }

function perspAudit(p: Term): Term {
  return p.k === 'a' ? p : mka(ANY_PERSP);
}

/** Reflection facts for one rule. All land in [main], timeless, base. */
export function encodeRule(c: Clause): { id: string; facts: EncFact[] } {
  const id = ruleIdOf(c);
  const rid = mka(id);
  const facts: EncFact[] = [];
  facts.push({ rel: V.rule, args: [rid] });
  facts.push({ rel: V.has_conclusion, args: [rid, { k: 'i', v: 1 }] });
  facts.push({ rel: V.conclusion_lit, args: [rid, { k: 'i', v: 1 }, reifyLit(c.head)] });
  facts.push({ rel: V.concludes, args: [rid, mka(c.head.rel)] });
  const headP = perspAudit(c.head.persp);
  facts.push({ rel: V.writes_to, args: [rid, headP] });
  const readPersps = new Map<string, Term>();
  c.body.forEach((b, i) => {
    const k = i + 1;
    facts.push({ rel: V.has_premise, args: [rid, { k: 'i', v: k }] });
    facts.push({ rel: V.premise_lit, args: [rid, { k: 'i', v: k }, reifyBodyElem(b)] });
    if (b.t === 'pos') facts.push({ rel: V.premise_pos, args: [rid, mka(b.lit.rel)] });
    if (b.t === 'neg') facts.push({ rel: V.premise_neg, args: [rid, mka(b.lit.rel)] });
    if (b.t === 'pos' || b.t === 'neg') {
      const pa = perspAudit(b.lit.persp);
      readPersps.set(canonTerm(pa), pa);
    }
    if (b.t === 'bi') facts.push({ rel: V.uses_builtin, args: [rid, mks(b.op)] });
  });
  for (const [pk, pa] of [...readPersps.entries()].sort()) {
    facts.push({ rel: V.reads_from, args: [rid, pa] });
    if (c.head.perspExplicit && pk !== canonTerm(headP)) {
      facts.push({ rel: V.bridge_decl, args: [rid, pa, headP] });
    }
  }
  return { id, facts };
}

// ---------------------------------------------------------------------------
// decoding: store → executable rules (the evaluator's only rule source)

export interface DRule { id: string; clause: Clause; canon: string; }

export function decodeRules(store: Store): { rules: DRule[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const conc = new Map<string, Term>();
  for (const f of store.relAll(V.conclusion_lit)) {
    if (f.args[0].k === 'a') conc.set(f.args[0].name, f.args[2]);
  }
  const prems = new Map<string, { k: number; t: Term }[]>();
  for (const f of store.relAll(V.premise_lit)) {
    if (f.args[0].k !== 'a' || f.args[1].k !== 'i') continue;
    const id = f.args[0].name;
    let arr = prems.get(id);
    if (!arr) { arr = []; prems.set(id, arr); }
    arr.push({ k: f.args[1].v, t: f.args[2] });
  }
  const rules: DRule[] = [];
  for (const f of store.relAll(V.rule)) {
    if (f.args[0].k !== 'a') continue;
    const id = f.args[0].name;
    const headT = conc.get(id);
    if (!headT) { diagnostics.push(`rule ${id}: missing conclusion reflection; skipped`); continue; }
    try {
      const head = unreifyLit(headT);
      const body = (prems.get(id) ?? []).sort((a, b) => a.k - b.k).map((p) => unreifyBodyElem(p.t));
      const clause: Clause = { head, body };
      rules.push({ id, clause, canon: canonClause(clause) });
    } catch (e) {
      diagnostics.push(`rule ${id}: undecodable reflection (${(e as Error).message}); skipped`);
    }
  }
  rules.sort((a, b) => (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0));
  return { rules, diagnostics };
}

// ---------------------------------------------------------------------------
// kernel bootstrap: reserved table, builtin modes, edb marks

export function bootstrapKernel(store: Store): void {
  const rels = [...RESERVED].sort();
  for (const r of rels) {
    store.add(V.reserved, MAIN, [mka(r)], { scope: 'timeless', base: true });
    store.add(V.edb, MAIN, [mka(r)], { scope: 'timeless', base: true });
  }
  const anyMode = list([mka('any'), mka('any')]);
  const inMode = list([mka('in'), mka('in')]);
  const isMode = list([mka('out'), mka('in')]);
  for (const op of BUILTIN_OPS) {
    const m = op === 'is' ? isMode : op === '=' ? anyMode : inMode;
    store.add(V.mode, MAIN, [mks(op), m], { scope: 'timeless', base: true });
  }
  registerPersp(store, MAIN);
}

/** First use of a perspective registers it under kernel authority, making
 *  perspective/1 and reflexive visibility well-defined for boot's audits. */
export function registerPersp(store: Store, p: string): void {
  store.add(V.authority, MAIN, [mka(p), mka(KERNEL_WHO)], { scope: 'timeless', base: true });
}

/** Kernel-emitted metadata for an asserted base fact. */
export function factMetaFacts(rel: string, persp: string, args: Term[], who?: string): EncFact[] {
  const f = factTerm(rel, persp, args);
  const out: EncFact[] = [{ rel: V.in_perspective, args: [f, mka(persp)] }];
  if (who) out.push({ rel: V.asserted_by, args: [f, mka(who)] });
  return out;
}
