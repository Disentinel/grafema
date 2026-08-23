// store-pass.test.ts — the load-bearing claims of the rules-from-store pass,
// each one falsifiable. The pass's whole value rests on being able to tell an
// answer that came out of the store from a SILENCE (an empty answer from a
// program that never got there), so most of what is pinned here is the
// anti-silence machinery, not the happy path.
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
import { RfdbClient } from '../src/rfdb-client.ts';
import { RfdbRofl } from '../src/adapter.ts';
import { translate, renderStoreSelector, renderDumpSource, type Translation } from '../src/translate.ts';
import { parseProgram } from '../src/neutral.ts';
import { generateProgram } from '../src/generator.ts';
import {
  makeSeedContext, runSeedStorePass, assertRefusalDetectorWorks, HarnessGap,
  type StorePassContext, type Tier0Summary,
} from '../src/differential.ts';
import { buildReport } from '../src/report.ts';

const BINARY = process.env.ROFL_CONFORMANCE_RFDB ?? DEFAULT_BINARY;

/** Same rule as wire-smoke: a checkout with no measurable binary skips the live tests
 *  rather than reporting a missing build as a failing engine. */
function liveSkipReason(): string | null {
  if (!fs.existsSync(BINARY)) return `SKIPPING LIVE TESTS: no rfdb-server at ${BINARY}`;
  if (process.env[ALLOW_STALE_ENV] === '1') return null;
  const verdict = checkBinaryFreshness(BINARY);
  if (verdict.reason === 'fresh') return null;
  return `SKIPPING LIVE TESTS: this binary cannot be measured against.\n${formatFreshnessRefusal(verdict)}`;
}
const SKIP_LIVE = liveSkipReason();
if (SKIP_LIVE !== null) console.error(SKIP_LIVE);
function live(name: string, fn: () => Promise<void> | void): void {
  test(name, { skip: SKIP_LIVE ?? false }, fn);
}

/** A two-clause program in the translatable subset: one rule over one ground fact.
 *  Atoms, not quoted strings — the dialect has a single quoted-const surface, so a v0
 *  string is untranslatable and would fail before any of this is measured. */
const TINY = 'p(X, Y) :- q(X, Y).\nq(a, b).\n';

function tr(src: string): Translation {
  const t = translate(parseProgram(src));
  assert.equal(t.ok, true, `translation failed: ${JSON.stringify(t)}`);
  return t as Translation;
}

let server: ServerHandle;
let client: RfdbClient;

before(async () => {
  if (SKIP_LIVE !== null) return;
  server = await startServer(BINARY);
  client = await RfdbClient.connect(server.socketPath);
  const hello = await client.hello();
  assert.ok(hello.features.includes('rulesAsData'), `server must advertise rulesAsData, got [${hello.features.join(',')}]`);
});

after(() => {
  client?.close();
  server?.stop();
});

/** Open a fresh ephemeral database on the shared connection for one test. */
async function withDb<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await client.createDatabase(name, true);
  await client.openDatabase(name);
  try {
    return await fn();
  } finally {
    await client.setRuleSource('text');
    await client.closeDatabase();
  }
}

test('the store selector carries NO rules and NO facts — only a relation name and its arity', () => {
  const t = tr(TINY);
  const sel = renderStoreSelector(t, 'p');
  assert.notEqual(sel, null);
  assert.equal(sel!.source, 'u_p(V0, V1)');
  assert.ok(!sel!.source.includes(':-'), 'a selector with a rule in it would be answerable from the request text');
  assert.ok(!sel!.source.includes('"'), 'a selector with a constant in it would carry EDB along');
  assert.deepEqual(sel!.headVars, ['V0', 'V1']);
  // The text-mode source, for contrast: it leads with a rule that exists only in the request.
  assert.ok(renderDumpSource(t, 'p')!.source.includes(':-'));
});

live('BEFORE reflection the same selectors answer EMPTY — so a later non-empty answer can only have come from the store', async () => {
  await withDb('sp-empty-control', async () => {
    const adapter = new RfdbRofl(client, { ruleSource: 'store' });
    assert.equal(adapter.load(TINY).ok, true);
    assert.equal(await client.setRuleSource('store'), 'store');
    assert.deepEqual(await adapter.domainFactSet(), [], 'the empty store must answer nothing at all');

    assert.equal(await client.setRuleSource('text'), 'text');
    const written = await adapter.reflectIntoStore();
    assert.ok(written > 0, `reflection must write something, wrote ${written}`);
    assert.equal(await client.setRuleSource('store'), 'store');
    assert.deepEqual(await adapter.domainFactSet(), ['p(a,b)', 'q(a,b)']);
  });
});

live('in store mode the REQUEST TEXT is not executed: the text-mode dump source answers empty, the selector answers in full', async () => {
  await withDb('sp-text-ignored', async () => {
    const t = tr(TINY);
    const adapter = new RfdbRofl(client, { ruleSource: 'store' });
    assert.equal(adapter.load(TINY).ok, true);
    await adapter.reflectIntoStore();
    assert.equal(await client.setRuleSource('store'), 'store');

    // xdump exists ONLY in the request text; in store mode there is no such rule.
    const viaText = await client.executeDatalog(renderDumpSource(t, 'p')!.source);
    assert.equal(viaText.length, 0, 'a rule that lives only in the request text must derive nothing in store mode');
    const viaStore = await client.executeDatalog(renderStoreSelector(t, 'p')!.source);
    assert.equal(viaStore.length, 1);
    assert.deepEqual(viaStore[0], { V0: 'a', V1: 'b' });
  });
});

live('the refusal detector is LIVE: a program Projection T cannot carry comes back as a coded refusal', async () => {
  const ctx: StorePassContext = { client, dbPrefix: 'sp-refusal' };
  const code = await assertRefusalDetectorWorks(ctx);
  assert.equal(code, 'E-REFLECT-003');
  assert.deepEqual((await client.listDatabases()).filter((n) => n.startsWith('sp-refusal-')), []);
});

live('each seed gets its OWN database: seed 2 never sees seed 1 rules, and nothing is left behind', async () => {
  const seedCtx = makeSeedContext(client);
  const store: StorePassContext = { client, dbPrefix: 'sp-isolation' };
  // The text side answers on its OWN connection, exactly as the runner arranges it: the
  // store pass closes a database per seed, and a shared connection would be left with no
  // current database the moment the first seed finished.
  const textClient = await RfdbClient.connect(server.socketPath);
  await textClient.hello();
  await textClient.createDatabase('sp-textside', true);
  await textClient.openDatabase('sp-textside');
  const results = [];
  try {
    for (const seed of [1, 2]) {
      const prog = generateProgram(seed, 90);
      const adapter = new RfdbRofl(textClient, { ruleSource: 'text' });
      assert.equal(adapter.load(prog.text).ok, true);
      const textSet = await adapter.domainFactSet();
      results.push(await runSeedStorePass(prog, seedCtx, store, textSet));
    }
  } finally {
    await textClient.closeDatabase();
    textClient.close();
  }
  for (const r of results) {
    assert.equal(r.unreflectable, null);
    assert.equal(r.emptyStoreRows, 0, 'a non-zero here means the previous seed leaked into this one');
    assert.equal(r.modeConfirmed, 'store');
    assert.ok(r.reflectedFacts > 0);
    assert.equal(r.agreesWithText, true);
    assert.equal(r.agreesWithOracle, true);
  }
  assert.notDeepEqual(results[0].storeSet, results[1].storeSet, 'two different seeds must not answer identically — that would mean one database answered twice');
  assert.deepEqual((await client.listDatabases()).filter((n) => n.startsWith('sp-isolation-')), []);
});

live('a store that received the program but answers EMPTY stops the run instead of counting as agreement', async () => {
  // The trap in one test: reflection is skipped, so the questions go to an EMPTY store while
  // the oracle derives facts. Two silences must NOT read as a match.
  const seedCtx = makeSeedContext(client);
  const prog = generateProgram(7, 90);
  const store: StorePassContext = { client, dbPrefix: 'sp-silence' };
  const brokenClient = Object.create(client) as RfdbClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (brokenClient as any).reflectProgram = async () => 0;
  await assert.rejects(
    () => runSeedStorePass(prog, seedCtx, { client: brokenClient, dbPrefix: store.dbPrefix }, []),
    (e: Error) => e instanceof HarnessGap && /reflection wrote 0 facts/.test(e.message),
  );
  assert.deepEqual((await client.listDatabases()).filter((n) => n.startsWith('sp-silence-')), []);
});

test('an ordinary run carries no trace of the pass: no store section in the report', () => {
  const tier0: Tier0Summary = {
    seedsRun: 120, divergences: [], witnessChecked: 325, witnessFailed: 0, whynotChecked: 554, whynotFailed: 0,
  };
  const report = buildReport([], tier0, { serverVersion: '0.4.1', protocolVersion: 3, binary: BINARY });
  assert.equal('store' in report.tier0, false, 'the key must be absent, not present-and-null — an ordinary report must be the same BYTES as before the pass existed');
  assert.equal(JSON.stringify(report).includes('"store"'), false);
  assert.equal(report.expectedVsFound.some((e) => e.claim === 'exp_rules_from_store_agrees'), false);
});
