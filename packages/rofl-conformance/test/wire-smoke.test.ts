// LIVE wire smoke tests against a real rfdb-server: pins the behaviors the
// harness architecture rests on, with evidence in assertions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  startServer,
  checkBinaryFreshness,
  formatFreshnessRefusal,
  ALLOW_STALE_ENV,
  DEFAULT_BINARY,
  type ServerHandle,
} from '../src/rfdb-server.ts';
import { RfdbClient, RfdbError } from '../src/rfdb-client.ts';
import { RfdbRofl } from '../src/adapter.ts';

/**
 * Which server to smoke: this checkout's own debug build, or an explicit override —
 * the same need `run.ts --rfdb` serves when the build lives in another CARGO_TARGET_DIR.
 */
const BINARY = process.env.ROFL_CONFORMANCE_RFDB ?? DEFAULT_BINARY;

/**
 * A checkout with no usable server binary is not a failing engine, and reporting it
 * as thirteen red tests teaches the reader to ignore this file — after which a REAL
 * red one goes unread too. So these live tests skip themselves, carrying the same
 * refusal text a measurement run prints. A measurement run (`run.ts`) still refuses
 * hard: a number is only ever about a binary that provably came from these sources.
 *
 * Decided before any test is registered, because `node:test` reads `skip` then.
 */
function liveSkipReason(): string | null {
  if (!fs.existsSync(BINARY)) {
    return `SKIPPING LIVE TESTS: no rfdb-server at ${BINARY}\n  build one: cd packages/rfdb-server && cargo build\n  or point these tests at a build: ROFL_CONFORMANCE_RFDB=<path> node --test ...`;
  }
  if (process.env[ALLOW_STALE_ENV] === '1') return null;
  const verdict = checkBinaryFreshness(BINARY);
  if (verdict.reason === 'fresh') return null;
  return `SKIPPING LIVE TESTS: this binary cannot be measured against.\n${formatFreshnessRefusal(verdict)}`;
}

const SKIP_LIVE = liveSkipReason();
if (SKIP_LIVE !== null) console.error(SKIP_LIVE);

/** A test that needs a real server behind it. */
function live(name: string, fn: () => Promise<void> | void): void {
  test(name, { skip: SKIP_LIVE ?? false }, fn);
}

let server: ServerHandle;
let client: RfdbClient;

before(async () => {
  if (SKIP_LIVE !== null) return;
  server = await startServer(BINARY);
  client = await RfdbClient.connect(server.socketPath);
  const hello = await client.hello();
  assert.equal(hello.protocolVersion, 3);
  assert.ok(hello.features.includes('datalogDerive'));
});

after(() => {
  client?.close();
  server?.stop();
});

live('recursive anc/parent over program-text EDB: 3 facts, hoisted rule first', async () => {
  const src = 'anc(X, Y) :- parent(X, Y).\nanc(X, Y) :- parent(X, Z), anc(Z, Y).\nparent("a", "b").\nparent("b", "c").\n';
  const rows = await client.executeDatalog(src);
  const tuples = rows.map((b) => `${b['X']},${b['Y']}`).sort();
  assert.deepEqual(tuples, ['a,b', 'a,c', 'b,c']);
});

live('PIN: executeDatalog DOES echo ground facts of the target predicate (mixed EDB/IDB)', async () => {
  const src = 'p0(X) :- p1(X).\np0("c0").\np1("c1").\n';
  const rows = await client.executeDatalog(src);
  const vals = rows.map((b) => b['X']).sort();
  // the derive path returns BOTH the derived c1 AND the EDB-echoed c0 —
  // the adapter's union+dedup with program facts is correct either way
  assert.deepEqual(vals, ['c0', 'c1']);
});

live('PIN: "first rule head" includes FACTS — unhoisted program answers the first fact relation', async () => {
  const src = 'parent("a", "b").\nanc(X, Y) :- parent(X, Y).\n';
  const rows = await client.executeDatalog(src);
  // target became `parent` (const head → no bindings)
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {});
});

live('E-PLAN-003 fires on a disconnected body (structural guard, empty graph)', async () => {
  const src = 'q0(X, Y) :- p0(X), p1(Y).\np0("c0").\np1("c1").\n';
  await assert.rejects(
    () => client.executeDatalog(src),
    (e: Error) => e instanceof RfdbError && e.code === 'E-PLAN-003',
  );
});

live('explainDatalogFact witness shape: ruleAstHash (64-hex) + positive body facts', async () => {
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

live('explainDatalogGap witness shape: flat satisfied-prefix + first failing premise', async () => {
  const src = 'anc(X, Y) :- parent(X, Y).\nparent("a", "b").\n';
  const g = await client.explainDatalogGap(src, 'anc', ['b', 'a']);
  assert.ok(g !== null);
  assert.equal(g!.failingPredicate, 'parent');
  assert.equal(g!.failingIsNegative, false);
  assert.ok(Array.isArray(g!.satisfied));
});

live('PIN (F1 fixed): raw negated wildcard is existential — no adapter projection needed', async () => {
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

live('PIN (F2 fixed): a body literal over an unknown predicate terminates with the correct empty result', async () => {
  // the exact live probe that discovered F2: pre-fix no response in >45s
  // (debug-build stratify panic killed the connection thread)
  const pos = 'q0(X) :- p0(X), p9(X).\np0("c0").\n';
  assert.deepEqual(await client.executeDatalog(pos), []);
  // negated unknown predicate: vacuous pass
  const neg = 'q0(X) :- p0(X), \\+ p9(X).\np0("c0").\n';
  const rows = await client.executeDatalog(neg);
  assert.deepEqual(rows.map((b) => b['X']), ['c0']);
});

live('PIN (F3 fixed): a fully-ground body literal is a filter, safe after planner reordering', async () => {
  // the exact live probe that discovered F3: pre-fix E-PLAN-003 after the
  // planner placed the ground probe first
  const present = 'q0(X) :- p0(X), p1("c1", "c2").\np0("c0").\np1("c1", "c2").\n';
  assert.deepEqual((await client.executeDatalog(present)).map((b) => b['X']), ['c0']);
  const absent = 'q0(X) :- p0(X), p1("c1", "c9").\np0("c0").\np1("c1", "c2").\n';
  assert.deepEqual(await client.executeDatalog(absent), []);
});

live('adapter end-to-end: TC rows in exact v0 rendering', async () => {
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

// A CONSTANT head argument is ground on both engines: v0's safety test passes,
// no demand unfolding happens, and RFDB builds the head the same way. The rows
// below are the vendored v0's OWN answers to the same programs, so this is a
// cross-engine agreement pin. Only a WILDCARD head is a real refusal, and the
// last assertion holds the engine to that — the one thing an anchored citation
// cannot prove is an ABSENCE, so it is probed live.
live('adapter end-to-end: constant head arguments agree with v0, wildcard heads do not', async () => {
  // (1) atom constant in the first head position
  const a = new RfdbRofl(client);
  a.load('p0(a, m).\np0(b, n).\nc0(k, Y) :- p0(X, Y).');
  assert.deepEqual((await a.query('c0(X, Y)')).rows.map((x) => x.text),
    ['X = k, Y = m', 'X = k, Y = n']);
  // (2) INTEGER constant in the head: stays an int through the wire round-trip
  const b = new RfdbRofl(client);
  b.load('p0(a, m).\np0(b, n).\nc1(7, Y) :- p0(X, Y).');
  assert.deepEqual((await b.query('c1(X, Y)')).rows.map((x) => x.text),
    ['X = 7, Y = m', 'X = 7, Y = n']);
  // (3) constant in the BASE rule of a recursion
  const c = new RfdbRofl(client);
  c.load('e0(a, b).\ne0(b, c).\ntc0(r, Y) :- e0(Y, Z).\ntc0(X, Y) :- tc0(X, Z), e0(Z, Y).');
  assert.deepEqual((await c.query('tc0(X, Y)')).rows.map((x) => x.text),
    ['X = r, Y = a', 'X = r, Y = b', 'X = r, Y = c']);
  // (4) the refusal that REMAINS. On the same program v0 demand-unfolds the head
  // and answers ['X = ?X, Y = m'] — an answer row carrying an UNBOUND term, which
  // is the whole of demand mode. RFDB has two observed behaviours here and the
  // assertion admits both, because which one you get depends on how old the
  // rfdb-server build under test is: a build carrying the head-safety check
  // refuses with E-EXEC-004, a build predating it silently answers []. (The
  // anchored source citation for that check lives on the translator's refusal
  // detail, where the citation gate can verify it; a citation written here
  // would not be gated, because the gate scans src/ only.) Neither behaviour is
  // v0's answer, and it is that ABSENCE — the one thing an anchored citation
  // cannot prove — that the refusal records. Measured on both builds.
  let wildcardHead: string;
  try {
    const rows = await client.executeDatalog('k_q(_, V1) :- k_p(V0, V1).\nk_p("a","m").\n');
    wildcardHead = `answered ${JSON.stringify(rows)}`;
    assert.deepEqual(rows, [], wildcardHead);
  } catch (e) {
    wildcardHead = (e as Error).message;
    assert.match(wildcardHead, /E-EXEC-004/);
    assert.match(wildcardHead, /range-restricted/);
  }
  // whichever of the two it was, it is not v0's demand-mode row
  assert.doesNotMatch(wildcardHead, /\?V0|\?X/);
});

// A REPEATED HEAD VARIABLE is a real head construction on BOTH engines: every
// repeated position receives the same value. The expected rows below are the
// vendored v0's OWN answers, measured on the same three programs (in v0's own
// row order), so this test is a cross-engine agreement pin, not a self-check.
live('adapter end-to-end: repeated head variable agrees with v0 row-for-row', async () => {
  // (1) repeat of the FIRST premise column
  const a = new RfdbRofl(client);
  a.load('p0(a, m).\np0(b, n).\nq0(X, X) :- p0(X, Y).');
  assert.deepEqual((await a.query('q0(X, Y)')).rows.map((x) => x.text),
    ['X = a, Y = a', 'X = b, Y = b']);
  // (2) repeat of the SECOND premise column — the case that separates a real
  // head build from a projection of column one (a projection would give a/b)
  const b = new RfdbRofl(client);
  b.load('p0(a, m).\np0(b, n).\nr0(Y, Y) :- p0(X, Y).');
  assert.deepEqual((await b.query('r0(X, Y)')).rows.map((x) => x.text),
    ['X = m, Y = m', 'X = n, Y = n']);
  // (3) repeat next to a distinct variable, arity 3
  const c = new RfdbRofl(client);
  c.load('p0(a, m).\np0(b, n).\nu0(X, Y, X) :- p0(X, Y).');
  assert.deepEqual((await c.query('u0(X, Y, Z)')).rows.map((x) => x.text),
    ['X = a, Y = m, Z = a', 'X = b, Y = n, Z = b']);
});
