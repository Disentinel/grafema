// translate.ts unit tests: per-reason-code rejections + golden translations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram } from '../src/neutral.ts';
import {
  translate, renderSource, renderDumpSource,
  wireToCanon, canonToTerm, constToWireKey, type Translation,
} from '../src/translate.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const t = (src: string) => translate(parseProgram(src));
const okT = (src: string): Translation => {
  const r = t(src);
  assert.equal(r.ok, true, (r as { detail?: string }).detail);
  return r as Translation;
};

test('rejects reflection vocabulary → missing:rules-as-data (before perspectives)', () => {
  const r = t('malformed[audit](R) :- rule_known(R), not has_premise(R, _).\nrule_known(R) :- has_conclusion(R, _).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:rules-as-data');
});

test('boot.rofl → missing:rules-as-data', () => {
  const boot = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../vendor/rofl-v0/boot.rofl'), 'utf8');
  const r = t(boot);
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:rules-as-data');
});

test('rejects non-default perspective → missing:perspectives', () => {
  const r = t('secret[vault](s1).\nspy(X) :- secret[open](X).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:perspectives');
});

test('explicit [main] is the default perspective and translates', () => {
  okT('p0[main](c0).\nq0(X) :- p0(X).');
});

test('rejects @init/@next → missing:temporal', () => {
  const r = t('counter(1) @init.');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:temporal');
});

test('rejects functors → missing:compound-terms (before builtins)', () => {
  const r = t('app(nil, Ys, Ys) :- Ys = Ys.\napp(cons(H, T), Ys, cons(H, Zs)) :- app(T, Ys, Zs).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:compound-terms');
});

test('rejects out-of-range integers → missing:bignum', () => {
  const r = t('big(295147905179352825856).'); // 2^68
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:bignum');
});

test('rejects builtins → dialect:untranslatable', () => {
  const r = t('n(7).\nm(X, Y) :- n(X), Y is X mod 3.');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'dialect:untranslatable');
});

test('in-range integer constants TRANSLATE as bare numeric literals (R15)', () => {
  // The engine types a bare number as Value::Int, distinct from a quoted const
  // and from a node id (datalog/parser.rs:165-223; live-probed R15/P1: `u_p(1)`
  // and `u_p("1")` dump as `~int:1` and `1` and do NOT join).
  const tr = okT('n(7).\nn(-3).\nm(X) :- n(X).');
  const src = renderSource(tr);
  assert.ok(src.includes('u_n(7).'), src);
  assert.ok(src.includes('u_n(-3).'), src);
  assert.ok(!src.includes('u_n("7").'), `an int must NOT be quoted (that is a node id): ${src}`);
  assert.deepEqual(tr.groundFacts.get('n'), [['7'], ['-3']]);
});

test('an integer constant inside a rule body stays a bare literal (R15)', () => {
  const tr = okT('pair(a, 1).\npair(b, 2).\nq(X) :- pair(X, 1).');
  const src = renderSource(tr);
  assert.ok(src.includes('u_q(V0) :- u_pair(V0, 1).'), src);
});

test('atoms and integers survive the wire round-trip distinctly (R15)', () => {
  assert.equal(wireToCanon('~int:1'), '1');
  assert.equal(wireToCanon('~int:-7'), '-7');
  assert.equal(wireToCanon('one'), 'one');
  assert.deepEqual(canonToTerm('1'), { k: 'i', v: 1 });
  assert.deepEqual(canonToTerm('one'), { k: 'a', name: 'one' });
  assert.equal(constToWireKey({ k: 'i', v: 1 }), '~int:1');
  assert.equal(constToWireKey({ k: 'a', name: 'one' }), 'one');
});

test('string constants are STILL untranslatable (one quoted-const surface)', () => {
  const r = t('s("hello").\nm(X) :- s(X).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'dialect:untranslatable');
});

test('rejects unsafe heads → missing:demand-mode', () => {
  const r = t('p0(c0).\nq0(X, Y) :- p0(X).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:demand-mode');
});

test('rejects repeated head vars → missing:demand-mode', () => {
  const r = t('p0(c0, c1).\nq0(X, X) :- p0(X, Y).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:demand-mode');
});

test('rejects unsafe negation vars → missing:demand-mode', () => {
  const r = t('p0(c0).\np2(c1, c2).\nq0(X) :- p0(X), not p2(X, Y).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'missing:demand-mode');
});

test('rejects disconnected bodies → dialect:untranslatable', () => {
  const r = t('p0(c0).\np1(c1).\nq0(X, Y) :- p0(X), p1(Y).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'dialect:untranslatable');
});

test('ground body literal is a filter and translates in any position (F3 fixed)', () => {
  const tr = okT('p0(c0).\np1(c1, c2).\nq0(X) :- p0(X), p1(c1, c2).');
  const src = renderSource(tr);
  assert.match(src, /u_q0\(V0\) :- u_p0\(V0\), u_p1\("c1", "c2"\)\./);
});

test('golden: atoms → quoted strings, user rels prefixed, not → \\+', () => {
  const tr = okT('edge(a, b).\npath(X, Y) :- edge(X, Y).\nblocked(X) :- node2(X), not path(X, X).\nnode2(a).');
  assert.equal(tr.ok, true);
  const src = renderSource(tr);
  assert.match(src, /u_edge\("a", "b"\)\./);
  assert.match(src, /u_path\(V0, V1\) :- u_edge\(V0, V1\)\./);
  assert.match(src, /u_blocked\(V0\) :- u_node2\(V0\), \\\+ u_path\(V0, V0\)\./);
});

test('golden: negated wildcard goes to the wire as-is (F1 fixed, no aux projection)', () => {
  const tr = okT('p0(c0).\np2(c1, c9).\nq0(X) :- p0(X), not p2(X, _).');
  const src = renderSource(tr);
  assert.match(src, /u_q0\(V0\) :- u_p0\(V0\), \\\+ u_p2\(V0, _\)\./);
  assert.doesNotMatch(src, /xp\d/);
});

test('unknown predicates stay on the wire — no rule/literal elimination (F2 fixed)', () => {
  // p9 has no facts and no rules → a legal EMPTY relation, served by the
  // engine (positive leg → no rows, negated leg → vacuous pass)
  const tr = okT('p0(c0).\nq0(X) :- p0(X), p9(X).\nq1(X) :- p0(X), not p9(X).');
  const src = renderSource(tr);
  assert.match(src, /u_q0\(V0\) :- u_p0\(V0\), u_p9\(V0\)\./);
  assert.match(src, /u_q1\(V0\) :- u_p0\(V0\), \\\+ u_p9\(V0\)\./);
  assert.ok(tr.programRels.includes('p9'));
});

test('renderDumpSource hoists a fresh xdump rule; empty rels dump through the engine', () => {
  const tr = okT('edge(a, b).\npath(X, Y) :- edge(X, Y).');
  const d = renderDumpSource(tr, 'path')!;
  assert.ok(d.source.startsWith('xdump(V0, V1) :- u_path(V0, V1).'));
  assert.deepEqual(d.headVars, ['V0', 'V1']);
  const dEdge = renderDumpSource(tr, 'edge')!;
  assert.ok(dEdge.source.startsWith('xdump(V0, V1) :- u_edge(V0, V1).'));
  const tr2 = okT('p0(c0).\nq0(X) :- p0(X), p9(X).');
  const dP9 = renderDumpSource(tr2, 'p9')!;
  assert.ok(dP9.source.startsWith('xdump(V0) :- u_p9(V0).'));
  const dQ0 = renderDumpSource(tr2, 'q0')!;
  assert.ok(dQ0.source.startsWith('xdump(V0) :- u_q0(V0).'));
  // only a rel the program never mentions has no arity to project
  assert.equal(renderDumpSource(tr2, 'zzz'), null);
});

test('duplicate ground facts are deduped', () => {
  const tr = okT('p0(c0).\np0(c0).\nq0(X) :- p0(X).');
  assert.equal(tr.groundFacts.get('p0')!.length, 1);
});

test('mixed arity → dialect:untranslatable', () => {
  const r = t('p0(c0).\np0(c0, c1).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'dialect:untranslatable');
});
