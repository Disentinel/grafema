// neutral.ts — the .rofl → neutral-JSON front. The vendored v0 parser is the
// ONLY parser in the harness: both tiers and the translator consume its Clause
// objects (plain JSON-safe terms, unify.ts termToJson). This guarantees the
// oracle and the subject read IDENTICAL programs.

import { parseProgram, parseLiteral, type Clause, type Lit, type BodyElem } from '../vendor/rofl-v0/src/parser.ts';
import { termToJson, type Term } from '../vendor/rofl-v0/src/unify.ts';

export type { Clause, Lit, BodyElem, Term };
export { parseProgram, parseLiteral };

export interface NeutralProgram { clauses: unknown[]; }

/** Serialize a parsed program as key-sorted neutral JSON (determinism anchor). */
export function toNeutralJson(clauses: Clause[]): string {
  const enc = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(enc);
    if (o !== null && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(rec).sort()) out[k] = enc(rec[k]);
      return out;
    }
    return o;
  };
  const clausesJson = clauses.map((c) => ({
    head: litToJson(c.head),
    body: c.body.map(bodyToJson),
  }));
  return JSON.stringify(enc({ clauses: clausesJson }));
}

function litToJson(l: Lit): unknown {
  return {
    rel: l.rel,
    persp: termToJson(l.persp),
    perspExplicit: l.perspExplicit,
    args: l.args.map(termToJson),
    temporal: l.temporal,
  };
}

function bodyToJson(b: BodyElem): unknown {
  if (b.t === 'pos' || b.t === 'neg') return { t: b.t, lit: litToJson(b.lit) };
  return { t: 'bi', op: b.op, l: termToJson(b.l), r: termToJson(b.r) };
}
