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
import { buildReport, storePassShortfall } from '../src/report.ts';

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

/** Explicit "yes, I am running this suite without an engine" acknowledgement. */
const ALLOW_SKIPPED_LIVE_ENV = 'ROFL_CONFORMANCE_ALLOW_SKIPPED_LIVE_TESTS';

let liveTestsRegistered = 0;
function live(name: string, fn: () => Promise<void> | void): void {
  liveTestsRegistered++;
  test(name, { skip: SKIP_LIVE ?? false }, fn);
}

/** A skipped live test is a FAILURE of this suite, not a pass with a note.
 *
 *  Every line of the wire door and of the store pass is exercised only by the live tests
 *  below. When they skip, `npm test` still exits 0 with "# fail 0" — a suite that executed
 *  none of the code it is about, reporting the same green as a suite that executed all of
 *  it. That is the "silent skip" this harness names as a harness failure in its own report
 *  (`report.ts` ⟦crashes, fake greens, silent skips⟧), and it is worth more than a warning:
 *  the default binary can go stale under an ordinary edit, and the green would be read as
 *  a measurement.
 *
 *  Two ways out, both loud: build the engine (or point `ROFL_CONFORMANCE_RFDB` at a fresh
 *  build), or set the acknowledgement below to say the skip is deliberate. */
test('the live tests must not skip silently', () => {
  if (SKIP_LIVE === null) return;
  if (process.env[ALLOW_SKIPPED_LIVE_ENV] === '1') return;
  assert.fail(
    `${liveTestsRegistered} live tests did NOT run, so nothing in this suite measured the ` +
    `engine.\n${SKIP_LIVE}\n` +
    `Fix it (rebuild, or ROFL_CONFORMANCE_RFDB=<fresh binary>), or say so on purpose with ` +
    `${ALLOW_SKIPPED_LIVE_ENV}=1.`,
  );
});

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

live('the mode can be READ without being set — and reading it does not set it', async () => {
  await withDb('sp-read-only-door', async () => {
    // The door answers about the DATABASE, and it answers before anything has been sent
    // for an echo to copy.
    assert.equal(await client.getRuleSource(), 'text', 'a fresh database is in text mode');
    assert.equal(await client.setRuleSource('store'), 'store');
    assert.equal(await client.getRuleSource(), 'store');

    // Reading twice more must change nothing: the store is empty, so the selector answers
    // nothing. Were the read a disguised write of 'text', the reflected program below would
    // be irrelevant and this would answer from the request text instead.
    assert.equal(await client.getRuleSource(), 'store');
    const adapter = new RfdbRofl(client, { ruleSource: 'store' });
    assert.equal(adapter.load(TINY).ok, true);
    assert.deepEqual(await adapter.domainFactSet(), [], 'reading the mode must not have moved the database');

    assert.equal(await client.setRuleSource('text'), 'text');
    assert.equal(await client.getRuleSource(), 'text', 'the door follows the state back — so it is not a constant');
  });
});

test('the store pass verdict goes RED when its denominator collapses', () => {
  // The trap: every count the pass publishes is "N of M" with M computed. Let the seeds
  // refuse and M shrinks with them, so 1 seed measured out of 120 reads "1/1 agree".
  const refused = (seed: number) => ({
    seed, program: 'p(X) :- q(X).', unreflectable: 'E-REFLECT-003', unreflectableDetail: 'refused',
    reflectedFacts: 0, modeConfirmed: null, emptyStoreRows: 0,
    storeSet: [], textSet: [], v0Set: ['q(a)'],
    agreesWithText: false, agreesWithOracle: false, diffVsText: null, diffVsOracle: null,
    witnessChecked: 0, witnessFailed: [], whynotChecked: 0, whynotFailed: [],
  });
  const collapsed: Tier0Summary = {
    seedsRun: 8, divergences: [], witnessChecked: 0, witnessFailed: 0, whynotChecked: 0, whynotFailed: 0,
    store: {
      seedsRun: 8, agreeWithText: 1, agreeWithOracle: 1,
      unreflectable: [1, 2, 3, 4, 5, 6, 7].map(refused),
      divergences: [], reflectedFactsTotal: 5,
      emptyStoreControlsPassed: 8, storeModeConfirmed: 1,
      witnessChecked: 0, witnessFailed: 0, whynotChecked: 0, whynotFailed: 0,
      refusalControlCode: 'E-REFLECT-003',
    },
  };
  assert.match(storePassShortfall(collapsed)!, /only 1 of 8 seeds were measured/);
  const row = buildReport([], collapsed, { serverVersion: '0.4.1', protocolVersion: 3, binary: BINARY })
    .expectedVsFound.find((e) => e.claim === 'exp_rules_from_store_agrees');
  assert.equal(row!.match, false, '1 of 8 seeds measured, with every ratio at 1/1, must NOT be green');
  assert.match(row!.found, /denominator/);

  // …and the same shape with nothing refused IS green, so the row can still go green at all.
  const whole: Tier0Summary = {
    ...collapsed,
    store: { ...collapsed.store!, unreflectable: [], agreeWithText: 8, agreeWithOracle: 8, storeModeConfirmed: 8 },
  };
  assert.equal(storePassShortfall(whole), null);
  const greenRow = buildReport([], whole, { serverVersion: '0.4.1', protocolVersion: 3, binary: BINARY })
    .expectedVsFound.find((e) => e.claim === 'exp_rules_from_store_agrees');
  assert.equal(greenRow!.match, true);

  // The other end the denominator can shrink from: a pass that never ran some seeds at all.
  const short: Tier0Summary = { ...whole, seedsRun: 120 };
  assert.match(storePassShortfall(short)!, /ran 8 of the 120 seeds/);
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
