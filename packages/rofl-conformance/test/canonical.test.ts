// canonical.ts tests: parseWhyTree against VERBATIM vendored-v0 why/whynot
// output, mask correctness on a boot-loaded store, witness soundness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rofl } from '../vendor/rofl-v0/src/api.ts';
import { v0FactSet, stripPersp, parseWhyTree, compareFactSets, witnessSound, gapSound, witnessToTree, gapToTree, bindingsToTuple } from '../src/canonical.ts';
import { BOOT } from '../src/fixtures.ts';

test('parseWhyTree parses real v0 why() output for a recursive derivation', () => {
  const r = new Rofl();
  r.load(`
    edge(a, b). edge(b, c).
    path(X, Y) :- edge(X, Y).
    path(X, Y) :- edge(X, Z), path(Z, Y).
  `);
  const w = r.why('path(a, c)');
  assert.equal(w.ok, true);
  const tree = parseWhyTree(w.text);
  assert.equal(tree.label, 'path[main](a,c)');
  assert.equal(tree.kind, 'derived');
  assert.match(tree.rule!, /^r[0-9a-f]{8}$/);
  assert.equal(tree.tick, 0);
  assert.equal(tree.children.length, 2);
  // children sorted canonically; leaves bottom out in axioms
  const leaves: string[] = [];
  const walk = (n: typeof tree): void => {
    if (n.children.length === 0 && n.kind === 'axiom') leaves.push(n.label);
    n.children.forEach(walk);
  };
  walk(tree);
  assert.ok(leaves.length >= 2);
  for (const l of leaves) assert.match(l, /^edge\[main\]/);
});

test('parseWhyTree handles negation + inlined whynot demo (sensors-style)', () => {
  const r = new Rofl();
  r.load(`
    p(a). q(b).
    good(X) :- p(X), not q(X).
  `);
  const w = r.why('good(a)');
  assert.equal(w.ok, true);
  const tree = parseWhyTree(w.text);
  assert.equal(tree.kind, 'derived');
  const kinds = tree.children.map((c) => c.kind).sort();
  assert.ok(kinds.includes('neg'), `expected a neg child, got ${JSON.stringify(tree, null, 2)}`);
});

test('v0FactSet masks RESERVED + stratum + unstratified on a boot-loaded store', () => {
  const r = new Rofl();
  assert.equal(r.load(BOOT).ok, true);
  assert.equal(r.load('p0(c1).\nq0(X) :- p0(X).').ok, true);
  r.evaluate();
  const all = v0FactSet(r);
  // no kernel/reflection facts survive the mask
  for (const line of all) {
    assert.doesNotMatch(line, /^(derived_by|rule|has_premise|premise_pos|premise_neg|concludes|has_conclusion|reserved|authority|asserted_by|hole|edb|stratum|unstratified|in_perspective)\(/);
  }
  // boot vocabulary (dep/reach/…) is NOT masked without a program-rel filter…
  assert.ok(all.some((l) => l.startsWith('dep(') || l.startsWith('reach(')));
  // …and IS masked with it (the cross-engine comparison form)
  const masked = v0FactSet(r, new Set(['p0', 'q0']));
  assert.deepEqual(masked, ['p0(c1)', 'q0(c1)']);
});

test('stripPersp strips exactly the perspective tag', () => {
  assert.equal(stripPersp('path[main](a,c)'), 'path(a,c)');
  assert.equal(stripPersp('temp[verified](t1,20)'), 'temp(t1,20)');
});

test('compareFactSets reports both directions', () => {
  const r = compareFactSets(['a(1)', 'b(2)'], ['b(2)', 'c(3)']);
  assert.equal(r.equal, false);
  assert.deepEqual(r.onlyV0, ['a(1)']);
  assert.deepEqual(r.onlyRfdb, ['c(3)']);
  assert.equal(compareFactSets(['x(y)'], ['x(y)']).equal, true);
});

test('witnessSound checks body ⊆ fact set with unprefixing', () => {
  const w = { ruleAstHash: 'h', body: [{ predicate: 'u_edge', tuple: ['a', 'b'] }] };
  assert.equal(witnessSound(w, new Set(['edge(a,b)']), (p) => p.replace(/^u_/, '')).sound, true);
  const bad = witnessSound(w, new Set(['edge(a,c)']), (p) => p.replace(/^u_/, ''));
  assert.equal(bad.sound, false);
  assert.deepEqual(bad.missing, ['edge(a,b)']);
});

test('bindingsToTuple is positional and total for distinct-var heads', () => {
  assert.deepEqual(bindingsToTuple({ V0: 'a', V1: 'b' }, ['V0', 'V1']), ['a', 'b']);
  assert.throws(() => bindingsToTuple({ V0: 'a' }, ['V0', 'V1']), /missing head variable/);
});

test('gapSound checks satisfied ⊆ fact set with unprefixing (positive premises only)', () => {
  const unpfx = (p: string): string => p.replace(/^u_/, '');
  const g = {
    ruleAstHash: 'h',
    satisfied: [{ predicate: 'u_p0', tuple: ['c1'] }],
    failingPredicate: 'xp0',
    failingIsNegative: true,
  };
  assert.equal(gapSound(g, new Set(['p0(c1)']), unpfx).sound, true);
  const bad = gapSound(g, new Set(['p0(c0)']), unpfx);
  assert.equal(bad.sound, false);
  assert.deepEqual(bad.missing, ['p0(c1)']);
  // empty satisfied prefix (first premise fails) is trivially sound
  assert.equal(gapSound({ ...g, satisfied: [] }, new Set(), unpfx).sound, true);
});

test('witnessToTree maps an RFDB flat witness to a 1-level canonical tree, children sorted', () => {
  const unpfx = (p: string): string => p.replace(/^u_/, '');
  const w = {
    ruleAstHash: 'abc123',
    body: [
      { predicate: 'u_path', tuple: ['b', 'c'] },
      { predicate: 'u_edge', tuple: ['a', 'b'] },
    ],
  };
  const tree = witnessToTree('path(a,c)', w, unpfx);
  assert.equal(tree.label, 'path(a,c)');
  assert.equal(tree.kind, 'derived');
  assert.equal(tree.rule, 'abc123');
  // canonical ordering: children sorted by label regardless of wire order
  assert.deepEqual(tree.children.map((c) => c.label), ['edge(a,b)', 'path(b,c)']);
  for (const c of tree.children) assert.deepEqual(c.children, []);
});

test('gapToTree maps an RFDB gap witness to a whynot node with the failing premise marked', () => {
  const unpfx = (p: string): string => p.replace(/^u_/, '');
  const g = {
    ruleAstHash: 'def456',
    satisfied: [{ predicate: 'u_p0', tuple: ['c1'] }],
    failingPredicate: 'xp0',
    failingIsNegative: true,
  };
  const tree = gapToTree('q0(c1)', g, unpfx);
  assert.equal(tree.label, 'whynot q0(c1)');
  assert.equal(tree.kind, 'whynot');
  assert.equal(tree.rule, 'def456');
  const failing = tree.children.find((c) => c.kind === 'neg');
  assert.ok(failing, 'failing premise node present');
  assert.equal(failing!.label, 'not xp0 [failing]');
  assert.ok(tree.children.some((c) => c.label === 'p0(c1)'), 'satisfied premise present');
});
