// LIVE wire smoke tests against a real rfdb-server: pins the behaviors the
// harness architecture rests on, with evidence in assertions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type ServerHandle } from '../src/rfdb-server.ts';
import { RfdbClient, RfdbError } from '../src/rfdb-client.ts';
import { RfdbRofl } from '../src/adapter.ts';

let server: ServerHandle;
let client: RfdbClient;

before(async () => {
  server = await startServer();
  client = await RfdbClient.connect(server.socketPath);
  const hello = await client.hello();
  assert.equal(hello.protocolVersion, 3);
  assert.ok(hello.features.includes('datalogDerive'));
});

after(() => {
  client?.close();
  server?.stop();
});

test('recursive anc/parent over program-text EDB: 3 facts, hoisted rule first', async () => {
  const src = 'anc(X, Y) :- parent(X, Y).\nanc(X, Y) :- parent(X, Z), anc(Z, Y).\nparent("a", "b").\nparent("b", "c").\n';
  const rows = await client.executeDatalog(src);
  const tuples = rows.map((b) => `${b['X']},${b['Y']}`).sort();
  assert.deepEqual(tuples, ['a,b', 'a,c', 'b,c']);
});

test('PIN: executeDatalog DOES echo ground facts of the target predicate (mixed EDB/IDB)', async () => {
  const src = 'p0(X) :- p1(X).\np0("c0").\np1("c1").\n';
  const rows = await client.executeDatalog(src);
  const vals = rows.map((b) => b['X']).sort();
  // the derive path returns BOTH the derived c1 AND the EDB-echoed c0 —
  // the adapter's union+dedup with program facts is correct either way
  assert.deepEqual(vals, ['c0', 'c1']);
});

test('PIN: "first rule head" includes FACTS — unhoisted program answers the first fact relation', async () => {
  const src = 'parent("a", "b").\nanc(X, Y) :- parent(X, Y).\n';
  const rows = await client.executeDatalog(src);
  // target became `parent` (const head → no bindings)
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {});
});

test('E-PLAN-003 fires on a disconnected body (structural guard, empty graph)', async () => {
  const src = 'q0(X, Y) :- p0(X), p1(Y).\np0("c0").\np1("c1").\n';
  await assert.rejects(
    () => client.executeDatalog(src),
    (e: Error) => e instanceof RfdbError && e.code === 'E-PLAN-003',
  );
});

test('explainDatalogFact witness shape: ruleAstHash (64-hex) + positive body facts', async () => {
  const src = 'anc(X, Y) :- parent(X, Y).\nanc(X, Y) :- parent(X, Z), anc(Z, Y).\nparent("a", "b").\nparent("b", "c").\n';
  const w = await client.explainDatalogFact(src, 'anc', ['a', 'c']);
  assert.ok(w !== null);
  assert.match(w!.ruleAstHash, /^[0-9a-f]{64}$/);
  assert.ok(w!.body.length >= 1);
  for (const b of w!.body) {
    assert.ok(['parent', 'anc'].includes(b.predicate));
    assert.equal(b.tuple.length, 2);
  }
  const none = await client.explainDatalogFact(src, 'anc', ['c', 'a']);
  assert.equal(none, null);
});

test('explainDatalogGap witness shape: flat satisfied-prefix + first failing premise', async () => {
  const src = 'anc(X, Y) :- parent(X, Y).\nparent("a", "b").\n';
  const g = await client.explainDatalogGap(src, 'anc', ['b', 'a']);
  assert.ok(g !== null);
  assert.equal(g!.failingPredicate, 'parent');
  assert.equal(g!.failingIsNegative, false);
  assert.ok(Array.isArray(g!.satisfied));
});

test('PIN (F1 fixed): raw negated wildcard is existential — no adapter projection needed', async () => {
  // the exact live probe that discovered F1: pre-fix the engine returned
  // {c0, c1}; the fix makes \+ p2(X, _) an existential anti-join → {c0}
  const raw = 'q0(X) :- p0(X), \\+ p2(X, _).\np0("c0").\np0("c1").\np2("c1", "c9").\n';
  const rows = await client.executeDatalog(raw);
  assert.deepEqual(rows.map((b) => b['X']).sort(), ['c0'], 'F1 regression: raw negated wildcard must anti-join existentially');
  // adapter path now sends the negated wildcard as-is and agrees
  const adapter = new RfdbRofl(client);
  adapter.load('p0(c0).\np0(c1).\np2(c1, c9).\nq0(X) :- p0(X), not p2(X, _).');
  const q = await adapter.query('q0(X)');
  assert.deepEqual(q.rows.map((r) => r.text), ['X = c0']);
});

test('PIN (F2 fixed): a body literal over an unknown predicate terminates with the correct empty result', async () => {
  // the exact live probe that discovered F2: pre-fix no response in >45s
  // (debug-build stratify panic killed the connection thread)
  const pos = 'q0(X) :- p0(X), p9(X).\np0("c0").\n';
  assert.deepEqual(await client.executeDatalog(pos), []);
  // negated unknown predicate: vacuous pass
  const neg = 'q0(X) :- p0(X), \\+ p9(X).\np0("c0").\n';
  const rows = await client.executeDatalog(neg);
  assert.deepEqual(rows.map((b) => b['X']), ['c0']);
});

test('PIN (F3 fixed): a fully-ground body literal is a filter, safe after planner reordering', async () => {
  // the exact live probe that discovered F3: pre-fix E-PLAN-003 after the
  // planner placed the ground probe first
  const present = 'q0(X) :- p0(X), p1("c1", "c2").\np0("c0").\np1("c1", "c2").\n';
  assert.deepEqual((await client.executeDatalog(present)).map((b) => b['X']), ['c0']);
  const absent = 'q0(X) :- p0(X), p1("c1", "c9").\np0("c0").\np1("c1", "c2").\n';
  assert.deepEqual(await client.executeDatalog(absent), []);
});

test('adapter end-to-end: TC rows in exact v0 rendering', async () => {
  const adapter = new RfdbRofl(client);
  adapter.load('edge(a, b). edge(b, c). edge(c, d).\npath(X, Y) :- edge(X, Y).\npath(X, Y) :- edge(X, Z), path(Z, Y).');
  const rows = (await adapter.query('path(X, Y)')).rows.map((x) => x.text);
  assert.deepEqual(rows, [
    'X = a, Y = b', 'X = a, Y = c', 'X = a, Y = d',
    'X = b, Y = c', 'X = b, Y = d', 'X = c, Y = d',
  ]);
  assert.equal(await adapter.holds('path(a, d)'), true);
  assert.equal(await adapter.holds('path(d, a)'), false);
});
