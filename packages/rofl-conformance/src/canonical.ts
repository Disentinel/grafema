// canonical.ts — canonical fact-set + witness-tree forms shared by both tiers.
//
// Fact form: perspective-stripped `rel(a1,a2)` lines, sorted. The v0 side is
// masked by the phase2.test.ts:56-61 domainFacts port (exclude RESERVED +
// stratum + unstratified) AND restricted to the compared program's relations —
// the differential preloads boot.rofl on the v0 side of negation seeds, and
// boot derives its own vocabulary (dep/reach/rule_known/…) that the program-
// only RFDB side can never contain; the program-rel restriction makes the
// comparison exactly "the generated program's user-visible facts".

import type { Rofl } from '../vendor/rofl-v0/src/api.ts';
import { RESERVED, IFACE } from '../vendor/rofl-v0/src/reflect.ts';
import type { FactWitness, GapWitness } from './rfdb-client.ts';

/** v0 side: canonical user-visible fact lines (domainFacts mask ∩ program rels). */
export function v0FactSet(r: Rofl, programRels?: Set<string>): string[] {
  const out: string[] = [];
  for (const key of r.factKeys()) {
    const rec = r.store.get(key)!;
    if (RESERVED.has(rec.rel) || rec.rel === IFACE.stratum || rec.rel === IFACE.unstratified) continue;
    if (programRels && !programRels.has(rec.rel)) continue;
    out.push(stripPersp(key));
  }
  return out.sort();
}

/** `rel[persp](args)` → `rel(args)` (single-perspective tier-0 comparison form). */
export function stripPersp(factKey: string): string {
  return factKey.replace(/^([A-Za-z0-9_]+)\[[^\]]*\]/, '$1');
}

/** RFDB side: canonical lines from per-rel tuples. */
export function rfdbFactSet(byRel: Map<string, string[][]>): string[] {
  const out: string[] = [];
  for (const [rel, tuples] of byRel) {
    for (const t of tuples) out.push(`${rel}(${t.join(',')})`);
  }
  return [...new Set(out)].sort();
}

/** Map an executeDatalog bindings row onto the hoisted head's positional tuple. */
export function bindingsToTuple(bindings: Record<string, string>, headVars: string[]): string[] {
  return headVars.map((v) => {
    const val = bindings[v];
    if (val === undefined) {
      throw new Error(`bindings missing head variable ${v}: ${JSON.stringify(bindings)}`);
    }
    return val;
  });
}

export function compareFactSets(v0: string[], rfdb: string[]): { equal: boolean; onlyV0: string[]; onlyRfdb: string[] } {
  const a = new Set(v0);
  const b = new Set(rfdb);
  const onlyV0 = v0.filter((x) => !b.has(x));
  const onlyRfdb = rfdb.filter((x) => !a.has(x));
  return { equal: onlyV0.length === 0 && onlyRfdb.length === 0, onlyV0, onlyRfdb };
}

// ── why/whynot tree canonicalization ───────────────────────────────

export interface WhyNode {
  label: string;                    // canonical fact key / demo line
  kind: 'derived' | 'axiom' | 'past-tick' | 'cycle' | 'neg' | 'builtin' | 'whynot' | 'info';
  rule?: string;                    // ruleId (v0) / ruleAstHash (RFDB)
  tick?: number;
  children: WhyNode[];
}

/** Parse v0 why() text (api.ts:250-277 grammar: 2-space indents; node lines
 *  are `<key>  <= <ruleId> @tick <N>` | `<key> [axiom]` | `<key> [past tick]`
 *  | `<key> [cycle]` | `not <key> [finite failure]` | `<desc> [builtin]`;
 *  a neg premise may be followed by an inlined whynot demo indented +2). */
export function parseWhyTree(text: string): WhyNode {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const parse = (line: string): WhyNode => {
    const t = line.trim();
    let m = /^(.*?)\s+<=\s+(\S+)\s+@tick\s+(\d+)$/.exec(t);
    if (m) return { label: m[1], kind: 'derived', rule: m[2], tick: parseInt(m[3], 10), children: [] };
    m = /^(.*)\s\[axiom\]$/.exec(t);
    if (m) return { label: m[1], kind: 'axiom', children: [] };
    m = /^(.*)\s\[past tick\]$/.exec(t);
    if (m) return { label: m[1], kind: 'past-tick', children: [] };
    m = /^(.*)\s\[cycle\]$/.exec(t);
    if (m) return { label: m[1], kind: 'cycle', children: [] };
    m = /^not\s+(.*)\s\[finite failure\]$/.exec(t);
    if (m) return { label: m[1], kind: 'neg', children: [] };
    m = /^(.*)\s\[builtin\]$/.exec(t);
    if (m) return { label: m[1], kind: 'builtin', children: [] };
    if (t.startsWith('whynot ')) return { label: t, kind: 'whynot', children: [] };
    return { label: t, kind: 'info', children: [] };
  };
  const indentOf = (line: string): number => {
    const m = /^( *)/.exec(line)!;
    return Math.floor(m[1].length / 2);
  };
  const root = parse(lines[0]);
  const stack: { node: WhyNode; indent: number }[] = [{ node: root, indent: indentOf(lines[0]) }];
  for (const line of lines.slice(1)) {
    const ind = indentOf(line);
    const node = parse(line);
    while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, indent: ind });
  }
  sortChildren(root);
  return root;
}

function sortChildren(n: WhyNode): void {
  for (const c of n.children) sortChildren(c);
  n.children.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** Map an RFDB DerivationWitness to a 1-level canonical tree (body facts as
 *  leaves, sorted). `unprefix` strips the u_ namespace back to v0 rel names. */
export function witnessToTree(fact: string, w: FactWitness, unprefix: (pred: string) => string): WhyNode {
  const children: WhyNode[] = w.body.map((b) => ({
    label: `${unprefix(b.predicate)}(${b.tuple.join(',')})`,
    kind: 'info' as const,
    children: [],
  }));
  const node: WhyNode = { label: fact, kind: 'derived', rule: w.ruleAstHash, children };
  sortChildren(node);
  return node;
}

export function gapToTree(fact: string, g: GapWitness, unprefix: (pred: string) => string): WhyNode {
  const children: WhyNode[] = g.satisfied.map((b) => ({
    label: `${unprefix(b.predicate)}(${b.tuple.join(',')})`,
    kind: 'info' as const,
    children: [],
  }));
  children.push({
    label: `${g.failingIsNegative ? 'not ' : ''}${unprefix(g.failingPredicate)} [failing]`,
    kind: 'neg',
    children: [],
  });
  const node: WhyNode = { label: `whynot ${fact}`, kind: 'whynot', rule: g.ruleAstHash, children };
  sortChildren(node);
  return node;
}

/** Witness soundness: every positive body fact of the RFDB witness must be in
 *  the v0 canonical fact set (witness EXISTENCE + body ⊆ facts — deliberately
 *  NOT tree identity: v0 keeps only the first witness, store.ts:127). */
export function witnessSound(w: FactWitness, v0Facts: Set<string>, unprefix: (pred: string) => string): { sound: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const b of w.body) {
    const line = `${unprefix(b.predicate)}(${b.tuple.join(',')})`;
    if (!v0Facts.has(line)) missing.push(line);
  }
  return { sound: missing.length === 0, missing };
}

/** Gap-witness soundness — the negative analogue of witnessSound: every
 *  satisfied premise the RFDB gap witness reports must be in the v0 canonical
 *  fact set. satisfied[] carries POSITIVE premises only (live-probed: a
 *  satisfied negated premise — satisfied by absence — is not listed), so the
 *  ⊆-check is well-defined. Deliberately NOT demo-tree identity (the v0
 *  whynot demo shape stays RED missing:whynot-shape). */
export function gapSound(g: GapWitness, v0Facts: Set<string>, unprefix: (pred: string) => string): { sound: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const b of g.satisfied) {
    const line = `${unprefix(b.predicate)}(${b.tuple.join(',')})`;
    if (!v0Facts.has(line)) missing.push(line);
  }
  return { sound: missing.length === 0, missing };
}
