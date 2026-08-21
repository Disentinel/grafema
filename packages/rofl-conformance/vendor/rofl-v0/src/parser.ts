// parser.ts — text → clause objects. Clause objects are a transient parse
// artifact; the evaluator's source of truth is the reflected store (reflect.ts).

import { type Term, mkv, mki, mks, mka, mkf } from './unify.ts';

export type Temporal = 'init' | 'now' | 'next';

export interface Lit {
  rel: string;
  persp: Term;            // atom or variable
  perspExplicit: boolean; // was [p] written in the source?
  args: Term[];
  temporal: Temporal;
}

export type BodyElem =
  | { t: 'pos'; lit: Lit }
  | { t: 'neg'; lit: Lit }
  | { t: 'bi'; op: string; l: Term; r: Term };

export interface Clause { head: Lit; body: BodyElem[]; }

export class ParseError extends Error {}

interface Tok { t: string; v: string; line: number; }

const PUNCT = [':-', '<=', '>=', '!=', '--', '(', ')', '[', ']', ',', '.', '@', '{', '}', '=', '<', '>', '+', '-', '*', '/', '?'];

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') { // comment to end of line
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1, out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      if (j >= n) throw new ParseError(`line ${line}: unterminated string`);
      toks.push({ t: 'str', v: out, line });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      toks.push({ t: 'int', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      toks.push({ t: /[A-Z_]/.test(c) ? 'var' : 'ident', v: w, line });
      i = j;
      continue;
    }
    let matched = '';
    for (const p of PUNCT) if (src.startsWith(p, i) && p.length > matched.length) matched = p;
    if (matched) { toks.push({ t: matched, v: matched, line }); i += matched.length; continue; }
    throw new ParseError(`line ${line}: unexpected character '${c}'`);
  }
  toks.push({ t: 'eof', v: '', line });
  return toks;
}

const CMP_OPS = new Set(['=', '!=', '<', '<=', '>', '>=']);

class P {
  toks: Tok[];
  pos = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  peek(): Tok { return this.toks[this.pos]; }
  next(): Tok { return this.toks[this.pos++]; }
  expect(t: string): Tok {
    const tok = this.next();
    if (tok.t !== t) throw new ParseError(`line ${tok.line}: expected '${t}', got '${tok.v || tok.t}'`);
    return tok;
  }
  err(msg: string): never {
    throw new ParseError(`line ${this.peek().line}: ${msg}`);
  }

  // --- terms ------------------------------------------------------------
  private freshCounter = 0;

  term(): Term {
    const t = this.peek();
    if (t.t === 'var') {
      this.next();
      if (t.v === '_') return mkv(`_$${this.freshCounter++}`);
      return mkv(t.v);
    }
    if (t.t === 'int') { this.next(); return mki(parseInt(t.v, 10)); }
    if (t.t === '-' && this.toks[this.pos + 1].t === 'int') {
      this.next();
      const v = this.next();
      return mki(-parseInt(v.v, 10));
    }
    if (t.t === 'str') { this.next(); return mks(t.v); }
    if (t.t === 'ident') {
      this.next();
      if (this.peek().t === '(') {
        this.next();
        const args = this.termList();
        this.expect(')');
        return mkf(t.v, args);
      }
      return mka(t.v);
    }
    this.err(`expected a term, got '${t.v || t.t}'`);
  }

  termList(): Term[] {
    const out = [this.term()];
    while (this.peek().t === ',') { this.next(); out.push(this.term()); }
    return out;
  }

  // Arithmetic expression: + - over * / mod, primaries are terms and (expr).
  expr(): Term {
    let l = this.mulExpr();
    for (;;) {
      const t = this.peek().t;
      if (t === '+' || t === '-') {
        this.next();
        l = mkf(t, [l, this.mulExpr()]);
      } else return l;
    }
  }
  mulExpr(): Term {
    let l = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.t === '*' || t.t === '/') { this.next(); l = mkf(t.t, [l, this.primary()]); }
      else if (t.t === 'ident' && t.v === 'mod') { this.next(); l = mkf('mod', [l, this.primary()]); }
      else return l;
    }
  }
  primary(): Term {
    if (this.peek().t === '(') {
      this.next();
      const e = this.expr();
      this.expect(')');
      return e;
    }
    return this.term();
  }

  // --- literals ---------------------------------------------------------
  literal(): Lit {
    const rel = this.expect('ident').v;
    return this.literalAfterRel(rel);
  }

  literalAfterRel(rel: string): Lit {
    let persp: Term = mka('main');
    let perspExplicit = false;
    if (this.peek().t === '[') {
      this.next();
      const p = this.next();
      if (p.t === 'ident') persp = mka(p.v);
      else if (p.t === 'var') persp = mkv(p.v);
      else this.err(`bad perspective '${p.v}'`);
      this.expect(']');
      perspExplicit = true;
    }
    this.expect('(');
    const args = this.termList();
    this.expect(')');
    const temporal = this.temporal();
    return { rel, persp, perspExplicit, args, temporal };
  }

  temporal(): Temporal {
    if (this.peek().t !== '@') return 'now';
    this.next();
    const w = this.expect('ident').v;
    if (w === 'init' || w === 'now' || w === 'next') return w;
    if (w === 'async') this.err(`'@async' is reserved syntax, not in v0`);
    this.err(`bad temporal '@${w}'`);
  }

  // --- body elements ----------------------------------------------------
  bodyElem(): BodyElem {
    const t = this.peek();
    if (t.t === 'ident' && t.v === 'not' &&
        (this.toks[this.pos + 1].t === 'ident')) {
      this.next();
      return { t: 'neg', lit: this.literal() };
    }
    // A relational literal starts ident + '[' (perspective form is unambiguous).
    if (t.t === 'ident' && this.toks[this.pos + 1].t === '[') {
      return { t: 'pos', lit: this.literal() };
    }
    // Otherwise parse an expression; if a comparison/'is' operator follows it
    // is a builtin, else it must have been a plain literal rel(args).
    const save = this.pos;
    const e = this.expr();
    const nxt = this.peek();
    if (CMP_OPS.has(nxt.t)) {
      this.next();
      const r = this.expr();
      return { t: 'bi', op: nxt.t, l: e, r };
    }
    if (nxt.t === 'ident' && nxt.v === 'is') {
      this.next();
      const r = this.expr();
      return { t: 'bi', op: 'is', l: e, r };
    }
    // reinterpret as literal
    if (e.k === 'f' && /^[a-z]/.test(e.name)) {
      this.pos = save;
      return { t: 'pos', lit: this.literal() };
    }
    this.err(`expected a literal or builtin`);
  }

  clause(): Clause {
    this.freshCounter = 0; // wildcard names are clause-local => content-addressed
    const head = this.literal();
    if (this.peek().t === '.') { this.next(); return { head, body: [] }; }
    this.expect(':-');
    const body: BodyElem[] = [this.bodyElem()];
    while (this.peek().t === ',') { this.next(); body.push(this.bodyElem()); }
    this.expect('.');
    for (const b of body) {
      if ((b.t === 'pos' || b.t === 'neg') && b.lit.temporal === 'next') {
        this.err(`'@next' is not allowed in rule bodies`);
      }
    }
    if (head.temporal === 'init' && body.length > 0) {
      this.err(`'@init' is not allowed on rule heads`);
    }
    return { head, body };
  }

  program(): Clause[] {
    const out: Clause[] = [];
    while (this.peek().t !== 'eof') out.push(this.clause());
    return out;
  }
}

export function parseProgram(src: string): Clause[] {
  return new P(tokenize(src)).program();
}

/** Parse a single literal (for queries: ?, why, whynot, excise). */
export function parseLiteral(src: string): Lit {
  const p = new P(tokenize(src));
  const lit = p.literal();
  if (p.peek().t === '.') p.next();
  p.expect('eof');
  return lit;
}
