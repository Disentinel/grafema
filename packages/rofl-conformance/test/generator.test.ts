// generator.ts tests: determinism, range-restriction, connectivity,
// stratified negation, v0-legality of every seed in the default range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateProgram } from '../src/generator.ts';
import { parseProgram } from '../src/neutral.ts';
import { translate } from '../src/translate.ts';
import { Rofl } from '../vendor/rofl-v0/src/api.ts';
import { BOOT } from '../src/fixtures.ts';

test('same seed ⇒ byte-identical program', () => {
  for (const seed of [1, 17, 42, 90, 91, 105, 120]) {
    assert.equal(generateProgram(seed).text, generateProgram(seed).text, `seed ${seed}`);
  }
});

test('every generated rule is range-restricted, distinct-var-headed, connected (via the translator gate)', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const prog = generateProgram(seed);
    const r = translate(parseProgram(prog.text));
    assert.equal(r.ok, true, `seed ${seed}: ${(r as { code?: string; detail?: string }).code}: ${(r as { detail?: string }).detail}\n${prog.text}`);
  }
});

test('seeds 1-90 are negation-free; seeds 91-120 have the q-layer negating only p2/p3', () => {
  for (let seed = 1; seed <= 90; seed++) {
    const prog = generateProgram(seed);
    assert.equal(prog.hasNegation, false);
    assert.doesNotMatch(prog.text, /\bnot\b/);
  }
  for (let seed = 91; seed <= 120; seed++) {
    const prog = generateProgram(seed);
    assert.equal(prog.hasNegation, true);
    const negs = [...prog.text.matchAll(/not (p\d)/g)].map((m) => m[1]);
    assert.ok(negs.length === 3, `seed ${seed}: 3 negated premises`);
    for (const n of negs) assert.ok(n === 'p2' || n === 'p3', `seed ${seed}: negates only lower layer, got ${n}`);
    assert.match(prog.text, /q0\(X\) :- p[01]\(X(, _)?\), not p[23]\(X(, _)?\)\./);
  }
});

test('every seed loads clean on the v0 oracle (negation seeds over boot)', () => {
  const bootR = new Rofl();
  assert.equal(bootR.load(BOOT).ok, true);
  const bootSnap = bootR.save();
  for (let seed = 1; seed <= 120; seed++) {
    const prog = generateProgram(seed);
    const r = prog.hasNegation ? Rofl.fromSnapshot(bootSnap) : new Rofl();
    const res = r.load(prog.text);
    assert.equal(res.ok, true, `seed ${seed}: ${res.diagnostics.join(' | ')}`);
  }
});
