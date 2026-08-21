// translate.ts unit tests: per-reason-code rejections + golden translations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram } from '../src/neutral.ts';
import { translate, renderSource, renderDumpSource, type Translation } from '../src/translate.ts';
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

test('rejects in-range integer constants → dialect:untranslatable (wire collapse)', () => {
  const r = t('n(7).\nm(X) :- n(X).');
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

test('rejects ground body literal in a multi-literal rule → dialect:untranslatable', () => {
  const r = t('p0(c0).\np1(c1, c2).\nq0(X) :- p0(X), p1(c1, c2).');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'dialect:untranslatable');
});

test('golden: atoms → quoted strings, user rels prefixed, not → \\+', () => {
  const tr = okT('edge(a, b).\npath(X, Y) :- edge(X, Y).\nblocked(X) :- node2(X), not path(X, X).\nnode2(a).');
  assert.equal(tr.ok, true);
  const src = renderSource(tr);
  assert.match(src, /u_edge\("a", "b"\)\./);
  assert.match(src, /u_path\(V0, V1\) :- u_edge\(V0, V1\)\./);
  assert.match(src, /u_blocked\(V0\) :- u_node2\(V0\), \\\+ u_path\(V0, V0\)\./);
});

test('golden: negated wildcard is projected through an aux predicate', () => {
  const tr = okT('p0(c0).\np2(c1, c9).\nq0(X) :- p0(X), not p2(X, _).');
  const src = renderSource(tr);
  assert.match(src, /xp0\(V0\) :- u_p2\(V0, _\)\./);
  assert.match(src, /u_q0\(V0\) :- u_p0\(V0\), \\\+ xp0\(V0\)/);
});

test('empty-predicate elimination: positive-empty drops the rule, negated-empty drops the literal', () => {
  // p9 has no facts and no rules → rule with positive p9 dropped;
  // not p9(X) removed from the other rule
  const tr = okT('p0(c0).\nq0(X) :- p0(X), p9(X).\nq1(X) :- p0(X), not p9(X).');
  const src = renderSource(tr);
  assert.doesNotMatch(src, /u_p9/);
  assert.doesNotMatch(src, /u_q0\(/);
  assert.match(src, /u_q1\(V0\) :- u_p0\(V0\)\./);
  assert.equal(tr.droppedRules, 1);
  assert.ok(tr.emptyRels.has('p9'));
  assert.ok(tr.emptyRels.has('q0'));
});

test('empty-predicate elimination runs to fixpoint (cascade)', () => {
  // p9 empty → q0 rule dropped → q0 empty → q1 rule dropped
  const tr = okT('p0(c0).\nq0(X) :- p0(X), p9(X).\nq1(X) :- q0(X).');
  assert.ok(tr.emptyRels.has('q1'));
  assert.equal(tr.droppedRules, 2);
});

test('renderDumpSource hoists a fresh xdump rule; null for empty rels', () => {
  const tr = okT('edge(a, b).\npath(X, Y) :- edge(X, Y).');
  const d = renderDumpSource(tr, 'path')!;
  assert.ok(d.source.startsWith('xdump(V0, V1) :- u_path(V0, V1).'));
  assert.deepEqual(d.headVars, ['V0', 'V1']);
  const dEdge = renderDumpSource(tr, 'edge')!;
  assert.ok(dEdge.source.startsWith('xdump(V0, V1) :- u_edge(V0, V1).'));
  const tr2 = okT('p0(c0).\nq0(X) :- p0(X), p9(X).');
  assert.equal(renderDumpSource(tr2, 'p9'), null);
  assert.equal(renderDumpSource(tr2, 'q0'), null);
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
