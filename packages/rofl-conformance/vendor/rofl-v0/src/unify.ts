// unify.ts — terms, substitutions, matching, canonical serialization.
// Part of the ROFL kernel. Zero dependencies.

export type Term =
  | { k: 'v'; name: string }                    // variable
  | { k: 'i'; v: number }                       // integer
  | { k: 's'; v: string }                       // string
  | { k: 'a'; name: string }                    // atom
  | { k: 'f'; name: string; args: Term[] };     // functor(term, ...)

export const mkv = (name: string): Term => ({ k: 'v', name });
export const mki = (v: number): Term => ({ k: 'i', v });
export const mks = (v: string): Term => ({ k: 's', v });
export const mka = (name: string): Term => ({ k: 'a', name });
export const mkf = (name: string, args: Term[]): Term => ({ k: 'f', name, args });

// A substitution maps variable names to terms.
export type Subst = Map<string, Term>;

/** Follow variable bindings until a non-variable or an unbound variable. */
export function walk(t: Term, s: Subst): Term {
  while (t.k === 'v') {
    const b = s.get(t.name);
    if (b === undefined) return t;
    t = b;
  }
  return t;
}

/** Deeply apply a substitution. */
export function resolve(t: Term, s: Subst): Term {
  t = walk(t, s);
  if (t.k === 'f') return mkf(t.name, t.args.map((a) => resolve(a, s)));
  return t;
}

/** Syntactic unification. No occurs-check (documented v0 omission).
 *  Returns an extended copy of the substitution, or null. */
export function unify(a: Term, b: Term, s: Subst): Subst | null {
  const out = new Map(s);
  if (unifyInto(a, b, out)) return out;
  return null;
}

function unifyInto(a: Term, b: Term, s: Subst): boolean {
  a = walk(a, s);
  b = walk(b, s);
  if (a.k === 'v') {
    if (b.k === 'v' && b.name === a.name) return true;
    s.set(a.name, b);
    return true;
  }
  if (b.k === 'v') { s.set(b.name, a); return true; }
  if (a.k === 'i' && b.k === 'i') return a.v === b.v;
  if (a.k === 's' && b.k === 's') return a.v === b.v;
  if (a.k === 'a' && b.k === 'a') return a.name === b.name;
  if (a.k === 'f' && b.k === 'f') {
    if (a.name !== b.name || a.args.length !== b.args.length) return false;
    for (let i = 0; i < a.args.length; i++) if (!unifyInto(a.args[i], b.args[i], s)) return false;
    return true;
  }
  return false;
}

export function isGround(t: Term): boolean {
  if (t.k === 'v') return false;
  if (t.k === 'f') return t.args.every(isGround);
  return true;
}

export function varsOf(t: Term, into: Set<string> = new Set()): Set<string> {
  if (t.k === 'v') into.add(t.name);
  else if (t.k === 'f') for (const a of t.args) varsOf(a, into);
  return into;
}

/** Canonical serialization of a term. Total, injective on distinct terms.
 *  Lexicographic order of these strings is the kernel's canonical order. */
export function canonTerm(t: Term): string {
  switch (t.k) {
    case 'v': return '?' + t.name;
    case 'i': return String(t.v);
    case 's': return JSON.stringify(t.v);
    case 'a': return t.name;
    case 'f': return t.name + '(' + t.args.map(canonTerm).join(',') + ')';
  }
}

export function termEq(a: Term, b: Term): boolean {
  return canonTerm(a) === canonTerm(b);
}

/** Evaluate an arithmetic expression term to an integer, or null if it
 *  contains unbound variables / non-arithmetic leaves. Operators: + - * / mod.
 *  Division truncates toward zero. */
export function evalArith(t: Term, s: Subst): number | null {
  t = walk(t, s);
  if (t.k === 'i') return t.v;
  if (t.k === 'f' && t.args.length === 2) {
    const l = evalArith(t.args[0], s);
    if (l === null) return null;
    const r = evalArith(t.args[1], s);
    if (r === null) return null;
    switch (t.name) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return r === 0 ? null : Math.trunc(l / r);
      case 'mod': return r === 0 ? null : l - r * Math.trunc(l / r);
    }
  }
  return null;
}

export const ARITH_OPS = new Set(['+', '-', '*', '/', 'mod']);

/** FNV-1a 32-bit hash, hex encoded. Used for content-addressed rule ids. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Structural JSON encoding for snapshots (terms only). */
export function termToJson(t: Term): unknown {
  switch (t.k) {
    case 'v': return { k: 'v', name: t.name };
    case 'i': return { k: 'i', v: t.v };
    case 's': return { k: 's', v: t.v };
    case 'a': return { k: 'a', name: t.name };
    case 'f': return { k: 'f', name: t.name, args: t.args.map(termToJson) };
  }
}

export function termFromJson(j: any): Term {
  switch (j.k) {
    case 'v': return mkv(j.name);
    case 'i': return mki(j.v);
    case 's': return mks(j.v);
    case 'a': return mka(j.name);
    case 'f': return mkf(j.name, j.args.map(termFromJson));
    default: throw new Error('bad term json');
  }
}
