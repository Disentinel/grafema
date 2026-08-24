// differential.ts — tier-0: the TS↔RFDB fact-set differential + witness
// spot-checks in BOTH directions (why on derived facts, whynot on absent
// tuples). Per seed: build a constrained tier-0 program; run it on the
// vendored v0 engine (negation seeds from a boot snapshot — v0 stratification
// is boot-DATA-driven, engine.ts:2-4 ⟦READ from stratum/2 facts⟧; running them bootless would silently
// change v0 semantics); run it through the RfdbRofl adapter; compare
// canonical fact sets byte-for-byte. ANY difference or unexpected E-code is
// an engine DIVERGENCE (run fails with a full repro dump), never a RED.

import { OracleEngine } from './oracle.ts';
import { RfdbRofl, unprefix } from './adapter.ts';
import type { RfdbClient } from './rfdb-client.ts';
import { RfdbError } from './rfdb-client.ts';
import { UnsupportedFeature } from './translate.ts';
import { v0FactSet, compareFactSets, witnessSound, gapSound } from './canonical.ts';
import { generateProgram, type GeneratedProgram } from './generator.ts';
import { BOOT } from './fixtures.ts';

/** A harness defect (not an engine verdict): generator/translator bug,
 *  oracle self-check failure, silently skipped scenario, … */
export class HarnessGap extends Error {}

export interface SeedContext {
  client: RfdbClient;
  bootSnap: string;
}

export interface SeedResult {
  seed: number;
  diverged: boolean;
  diff: { onlyV0: string[]; onlyRfdb: string[] } | null;
  ecode: string | null;
  v0Set: string[];
  rfdbSet: string[];
  program: string;
  witnessChecked: number;
  witnessFailed: string[];
  whynotChecked: number;
  whynotFailed: string[];
}

export function makeSeedContext(client: RfdbClient): SeedContext {
  const bootR = new OracleEngine();
  const res = bootR.load(BOOT);
  if (!res.ok) throw new HarnessGap(`boot.rofl failed to load on the vendored oracle: ${res.diagnostics.join(' | ')}`);
  return { client, bootSnap: bootR.save() };
}

export async function runSeedDifferential(prog: GeneratedProgram, ctx: SeedContext): Promise<SeedResult> {
  // v0 side (negation seeds MUST have boot preloaded — hard harness invariant)
  if (prog.hasNegation && !ctx.bootSnap) {
    throw new HarnessGap(`seed ${prog.seed}: negation seed without a boot snapshot — v0 negation would be UNCHECKED`);
  }
  const v0 = prog.hasNegation ? OracleEngine.fromSnapshot(ctx.bootSnap) : new OracleEngine();
  const load = v0.load(prog.text);
  if (!load.ok) {
    throw new HarnessGap(`seed ${prog.seed}: generated program rejected by the v0 oracle: ${load.diagnostics.join(' | ')}\n${prog.text}`);
  }
  const v0Set = v0FactSet(v0.r, new Set(prog.rels));

  // RFDB side through the adapter — a generated seed MUST translate
  const adapter = new RfdbRofl(ctx.client);
  try {
    const res = adapter.load(prog.text);
    if (!res.ok) throw new HarnessGap(`seed ${prog.seed}: adapter parse failure: ${res.diagnostics.join(' | ')}`);
  } catch (e) {
    if (e instanceof UnsupportedFeature) {
      throw new HarnessGap(`seed ${prog.seed}: tier-0 program failed to translate (${e.code}): ${e.detail}\n${prog.text}`);
    }
    throw e;
  }

  let rfdbSet: string[];
  try {
    rfdbSet = await adapter.domainFactSet();
  } catch (e) {
    if (e instanceof RfdbError) {
      return {
        seed: prog.seed, diverged: true, diff: null, ecode: e.code ?? 'uncoded-error',
        v0Set, rfdbSet: [], program: prog.text, witnessChecked: 0,
        witnessFailed: [`wire error: ${e.message}`],
        whynotChecked: 0, whynotFailed: [],
      };
    }
    throw e;
  }

  const cmp = compareFactSets(v0Set, rfdbSet);
  const result: SeedResult = {
    seed: prog.seed,
    diverged: !cmp.equal,
    diff: cmp.equal ? null : { onlyV0: cmp.onlyV0, onlyRfdb: cmp.onlyRfdb },
    ecode: null,
    v0Set, rfdbSet,
    program: prog.text,
    witnessChecked: 0,
    witnessFailed: [],
    whynotChecked: 0,
    whynotFailed: [],
  };
  if (result.diverged) return result;

  await spotCheckWitnesses(adapter, prog, v0, v0Set, rfdbSet, result);
  if (result.witnessFailed.length > 0) result.diverged = true;
  await spotCheckGaps(adapter, prog, v0, new Set(v0Set), result);
  if (result.whynotFailed.length > 0) result.diverged = true;
  return result;
}

/** The BOTH-DIRECTIONS witness spot-checks, factored out so the text pass and the
 *  rules-from-store pass are checked by literally the same code rather than by two
 *  copies that could drift into flattering the newer one. */
interface WitnessTally {
  witnessChecked: number;
  witnessFailed: string[];
  whynotChecked: number;
  whynotFailed: string[];
}

// Witness spot-check: ≤5 derived facts (dump ∖ program ground facts) —
// existence + body-soundness, NOT tree identity (v0 first-witness-only,
// store.ts:127 ⟦if (!this.witnesses.has(key)) this.witnesses.set(key, w);⟧;
// witness choice is mode-dependent, LIMITS.md:48 ⟦and seminaive agree on results⟧)
async function spotCheckWitnesses(
  adapter: RfdbRofl,
  prog: GeneratedProgram,
  v0: OracleEngine,
  v0Set: string[],
  rfdbSet: string[],
  result: WitnessTally,
): Promise<void> {
  const groundLines = new Set<string>();
  for (const rel of prog.rels) {
    for (const t of adapter.groundFactsOf(rel)) groundLines.add(`${rel}(${t.join(',')})`);
  }
  const derived = rfdbSet.filter((l) => !groundLines.has(l));
  const v0Facts = new Set(v0Set);
  for (const line of derived.slice(0, 5)) {
    result.witnessChecked++;
    const w0 = v0.why(line);
    if (!w0.ok) {
      result.witnessFailed.push(`${line}: v0 why() not ok: ${w0.text}`);
      continue;
    }
    const { witness } = await adapter.whyWitness(line);
    if (witness === null) {
      result.witnessFailed.push(`${line}: RFDB witness is null for a derived fact`);
      continue;
    }
    const sound = witnessSound(witness, v0Facts, unprefix);
    if (!sound.sound) {
      result.witnessFailed.push(`${line}: witness body facts not in v0 set: ${sound.missing.join(', ')}`);
    }
  }
}

// Whynot spot-check — the NEGATIVE half of the ТЗ differential: ≤5 ground
// tuples ABSENT from the canonical fact set, over rels with ≥1 translated
// rule (gap witnesses exist only through rules; EDB-only rels return null
// gaps — live-probed). Checks per tuple:
//   • v0 whynot(...).holds === false (canonical-set/oracle consistency);
//   • RFDB explainDatalogGap witness EXISTS (null = engine claims derivable);
//   • gap soundness: satisfied premises ⊆ v0 fact set (positive-only in
//     satisfied[], live-probed) + failing predicate is a program predicate.
// Demo-TREE parity stays out of scope by design (missing:whynot-shape).
// 'c9' first: the generator draws consts from c0-c5 only and every derived
// constant originates in the EDB, so a c9-tuple is absent on both sides.
async function spotCheckGaps(
  adapter: RfdbRofl,
  prog: GeneratedProgram,
  v0: OracleEngine,
  v0Facts: Set<string>,
  result: WitnessTally,
): Promise<void> {
  const absentConsts = ['c9', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
  outer: for (const rel of adapter.ruleRels()) {
    const relArity = prog.arity.get(rel);
    if (relArity === undefined) continue;
    let pickedForRel = 0;
    for (const c of absentConsts) {
      if (result.whynotChecked >= 5) break outer;
      if (pickedForRel >= 2) break;
      const tuple = Array.from({ length: relArity }, () => c);
      const line = `${rel}(${tuple.join(',')})`;
      if (v0Facts.has(line)) continue;
      pickedForRel++;
      result.whynotChecked++;
      const wn = v0.whynot(line);
      if (wn.holds !== false) {
        result.whynotFailed.push(`${line}: v0 whynot HOLDS for a fact absent from the canonical set`);
        continue;
      }
      const { witness } = await adapter.whynotWitness(line);
      if (witness === null) {
        result.whynotFailed.push(`${line}: RFDB gap witness is null (= claims derivable) for a fact absent from both extensions`);
        continue;
      }
      const gs = gapSound(witness, v0Facts, unprefix);
      if (!gs.sound) {
        result.whynotFailed.push(`${line}: gap satisfied-premises not in v0 fact set: ${gs.missing.join(', ')}`);
        continue;
      }
      const failing = unprefix(witness.failingPredicate);
      if (!prog.rels.includes(failing)) {
        result.whynotFailed.push(`${line}: gap failing predicate '${witness.failingPredicate}' is not a program rel`);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// The rules-from-store pass (ТЗ criterion B, second half)
// ════════════════════════════════════════════════════════════════════
//
// The pass above proves RFDB ≡ ROFL v0 with the program riding along in every
// request. That is only half of what the ТЗ asks for: its anti-fake ground rule
// says the rules must be read FROM THE STORE, not from the request. This
// pass runs the same 120 programs a second time with the rules living in the
// database as facts, and answers the one question the first pass cannot:
// does the engine derive the same thing when it is not handed the program?
//
// EVERY equality here is guarded, because the failure mode is silence. A program
// that never reached the store answers EMPTY to every question, an empty answer
// looks exactly like an honest "nothing follows", and two silences compared to
// each other produce a beautiful, meaningless 120/120. So a seed counts as
// agreeing only when ALL of the following were measured first:
//
//   • the empty-store control: the SAME selector, sent to the same database in
//     store mode BEFORE anything is reflected, comes back with zero rows. This
//     is what makes a non-empty answer afterwards evidence rather than
//     coincidence — a request carrying no rules and no facts has nothing else
//     to have come from;
//   • reflection wrote a positive number of facts;
//   • the server, asked, READ BACK 'store' off its engine (`setRuleSource`
//     returns the state, not an echo of the request);
//   • the oracle's own fact set for this seed is non-empty, so "the two sides
//     agree" cannot be two empty sets;
//   • the store-mode fact set is non-empty.
//
// Any of these failing is a HARNESS_GAP — the run stops with exit 2. It is never
// a match and never a divergence: a measurement that did not happen has no
// verdict to report.

/** One database per seed, on its OWN connection.
 *
 *  Two reasons it cannot share the tier-0 connection and database. Reflection is additive —
 *  a second program's rules land BESIDE the first, and only an explicit `supersedes`
 *  directive takes one out of force (`engine_v2.rs:1455-1456`
 *  ⟦ADDITIVE — reflecting a second program adds its rules beside the first⟧), so
 *  seed 8 would execute seed 7's rules as well as its own; and the 32-bit rule id would
 *  accumulate ~3000 clauses in one store, turning the collision gate from a formality into a
 *  real risk. The separate connection keeps the text pass's session pointed at the server's
 *  default database, so the ordinary run is not disturbed by so much as an open-database. */
export interface StorePassContext {
  client: RfdbClient;
  /** Database name prefix; the seed number is appended. */
  dbPrefix: string;
}

export interface StoreSeedResult {
  seed: number;
  program: string;
  /** The E-code when Projection T refused the program ON THE MERITS (`#requires`, an
   *  `@materialize` annotation, a lattice head) — its own category, NOT a divergence. */
  unreflectable: string | null;
  unreflectableDetail: string | null;
  /** Facts written by reflection. The positive control: zero is a harness gap. */
  reflectedFacts: number;
  /** The mode read back out of the database through the READ-ONLY door
   *  (`getRuleSource`), which never saw the switch request — see {@link switchRuleSource}. */
  modeConfirmed: 'text' | 'store' | null;
  /** Rows the same selectors returned against the store BEFORE reflection. Must be 0. */
  emptyStoreRows: number;
  storeSet: string[];
  textSet: string[];
  v0Set: string[];
  agreesWithText: boolean;
  agreesWithOracle: boolean;
  diffVsText: { onlyText: string[]; onlyStore: string[] } | null;
  diffVsOracle: { onlyV0: string[]; onlyStore: string[] } | null;
  witnessChecked: number;
  witnessFailed: string[];
  whynotChecked: number;
  whynotFailed: string[];
}

/** The oracle for one seed, built exactly as {@link runSeedDifferential} builds it —
 *  negation seeds from the boot snapshot, because v0 stratification is boot-DATA-driven
 *  and a bootless run would silently change v0 semantics. */
function oracleFor(prog: GeneratedProgram, ctx: SeedContext): OracleEngine {
  if (prog.hasNegation && !ctx.bootSnap) {
    throw new HarnessGap(`seed ${prog.seed}: negation seed without a boot snapshot — v0 negation would be UNCHECKED`);
  }
  const v0 = prog.hasNegation ? OracleEngine.fromSnapshot(ctx.bootSnap) : new OracleEngine();
  const load = v0.load(prog.text);
  if (!load.ok) {
    throw new HarnessGap(`seed ${prog.seed}: generated program rejected by the v0 oracle: ${load.diagnostics.join(' | ')}\n${prog.text}`);
  }
  return v0;
}

/** A program Projection T must refuse — the POSITIVE CONTROL for the refusal detector.
 *
 *  Without it, "0 programs were unreflectable" is unfalsifiable: a door that refused nothing
 *  at all would produce the same zero. The annotation is the same one the bundled
 *  `depends.dl` opens with, so it PARSES — what comes back is Projection T's own gate and
 *  not a syntax error wearing its clothes (`rfdb_server.rs:9106-9108` ⟦A well-formed `@materialize` program — it PARSES⟧). */
const UNREFLECTABLE_CONTROL = '@materialize(edge_type="DEPENDS_ON")\np(X, Y) :- edge(X, Y, "IMPORTS_FROM").';

/** Prove the refusal path is live before counting how many programs it refused. */
export async function assertRefusalDetectorWorks(store: StorePassContext): Promise<string> {
  const db = `${store.dbPrefix}-refusal-control`;
  await store.client.createDatabase(db, true);
  await store.client.openDatabase(db);
  try {
    let count: number | null = null;
    try {
      count = await store.client.reflectProgram(UNREFLECTABLE_CONTROL);
    } catch (e) {
      if (!(e instanceof RfdbError) || e.code === null) throw e;
      return e.code;
    }
    throw new HarnessGap(
      `the unreflectable-program control was ACCEPTED (${count} facts written) instead of refused. ` +
      'Every "not reflectable" count this pass reports would then be a zero produced by a door ' +
      `that refuses nothing. Control program:\n${UNREFLECTABLE_CONTROL}`,
    );
  } finally {
    // Closing the last connection to an ephemeral database IS the deletion
    // (`rfdb_server.rs:3075-3079` ⟦Cleanup ephemeral database if no connections remain⟧) —
    // measured: a dropDatabase after this close answers "Database … not found".
    await store.client.closeDatabase();
  }
}

/** Switch the rule source and CONFIRM it through the read-only door, returning the mode the
 *  database says it is in.
 *
 *  The confirmation deliberately does not use `setRuleSource`'s own reply. That reply is a
 *  reply to the request: the server-side setter is total, so its read-back and a plain echo
 *  of the argument are the same value on every input, and a harness leaning on it would be
 *  confirming its own ask. `getRuleSource` is a separate READ that never saw the request, so
 *  a server that ignored the switch — or one that acknowledged one mode while sitting in the
 *  other — is caught here. Both answers are demanded to agree, which is the only place in
 *  the pass where the two doors are held against each other.
 *
 *  Throws {@link HarnessGap}, never returns a wrong mode: every question asked after this
 *  point would otherwise be answered by the wrong program, and the answer would look like an
 *  ordinary result. */
async function switchRuleSource(
  client: RfdbClient,
  want: 'text' | 'store',
  seed: number,
  when: string,
): Promise<'text' | 'store'> {
  const acked = await client.setRuleSource(want);
  const observed = await client.getRuleSource();
  if (observed !== want) {
    throw new HarnessGap(
      `seed ${seed}: asked for rule source '${want}' ${when}, but the database reads '${observed}' — ` +
      'every question after this point would be answered by the other program',
    );
  }
  if (acked !== observed) {
    throw new HarnessGap(
      `seed ${seed}: the switch acknowledged '${acked}' ${when} while the database reads '${observed}' — ` +
      'the acknowledgement is not the state',
    );
  }
  return observed;
}

/** Run one seed with the rules coming out of the store, and compare three ways:
 *  store vs the ORACLE (the ТЗ differential) and store vs the TEXT answer measured by
 *  {@link runSeedDifferential} on the same seed (which catches an encode/decode error that
 *  is self-consistent — a round trip that produces a different but coherent program would
 *  pass against the oracle alone only by luck, and would pass against nothing if it did not). */
export async function runSeedStorePass(
  prog: GeneratedProgram,
  ctx: SeedContext,
  store: StorePassContext,
  textSet: string[],
): Promise<StoreSeedResult> {
  const v0 = oracleFor(prog, ctx);
  const v0Set = v0FactSet(v0.r, new Set(prog.rels));
  if (v0Set.length === 0) {
    throw new HarnessGap(
      `seed ${prog.seed}: the oracle's fact set is EMPTY, so "store agrees with oracle" would compare two ` +
      `empty sets and mean nothing. The generator emits 8-19 ground facts per program.\n${prog.text}`,
    );
  }

  const result: StoreSeedResult = {
    seed: prog.seed, program: prog.text,
    unreflectable: null, unreflectableDetail: null,
    reflectedFacts: 0, modeConfirmed: null, emptyStoreRows: -1,
    storeSet: [], textSet, v0Set,
    agreesWithText: false, agreesWithOracle: false,
    diffVsText: null, diffVsOracle: null,
    witnessChecked: 0, witnessFailed: [], whynotChecked: 0, whynotFailed: [],
  };

  const db = `${store.dbPrefix}-seed-${prog.seed}`;
  await store.client.createDatabase(db, true);
  await store.client.openDatabase(db);
  try {
    const adapter = new RfdbRofl(store.client, { ruleSource: 'store' });
    try {
      const load = adapter.load(prog.text);
      if (!load.ok) throw new HarnessGap(`seed ${prog.seed}: adapter parse failure: ${load.diagnostics.join(' | ')}`);
    } catch (e) {
      if (e instanceof UnsupportedFeature) {
        throw new HarnessGap(`seed ${prog.seed}: tier-0 program failed to translate (${e.code}): ${e.detail}\n${prog.text}`);
      }
      throw e;
    }

    // ── the empty-store control ──
    // Same selectors, same database, store mode, nothing reflected yet. The selectors carry
    // no rules and no facts of their own, so an EMPTY store must answer nothing at all;
    // anything other than zero means the engine is not reading the store.
    //
    // What this control does NOT do, and the pass would be misdescribed if it claimed
    // otherwise: it does not by itself tell the two modes apart, because on an empty
    // database the text mode returns zero for these selectors too. Two other things do
    // that, and they are what the pass actually rests on — (a) the same selectors turn
    // NON-empty after reflection, which only the store can explain, and (b) the store
    // selector `u_p(V0, V1)` names a predicate with no rule in the request at all, so the
    // text mode has no program to run for it. This control's job is narrower and still
    // necessary: it proves the database each seed measures in starts EMPTY, so the answer
    // below cannot be the previous seed's.
    await switchRuleSource(store.client, 'store', prog.seed, 'before the empty-store control');
    result.emptyStoreRows = (await adapter.domainFactSet()).length;
    if (result.emptyStoreRows !== 0) {
      throw new HarnessGap(
        `seed ${prog.seed}: the EMPTY store answered ${result.emptyStoreRows} facts. The selectors carry no ` +
        'rules and no facts, so a non-empty answer means this database was not fresh — every ' +
        `later agreement on this seed could be the previous seed's.\n${prog.text}`,
      );
    }

    // ── reflect, then switch ──
    await switchRuleSource(store.client, 'text', prog.seed, 'to reflect');
    try {
      result.reflectedFacts = await adapter.reflectIntoStore();
    } catch (e) {
      if (e instanceof RfdbError && e.code !== null && e.code.startsWith('E-REFLECT')) {
        // A refusal ON THE MERITS: Projection T cannot carry this program whole. Its own
        // category — the engines did not disagree about anything, they were never asked.
        result.unreflectable = e.code;
        result.unreflectableDetail = e.message;
        return result;
      }
      throw e;
    }
    if (result.reflectedFacts <= 0) {
      throw new HarnessGap(
        `seed ${prog.seed}: reflection wrote ${result.reflectedFacts} facts without refusing. A store that ` +
        'received nothing answers empty to everything, which is indistinguishable from an honest zero.\n' +
        prog.text,
      );
    }
    result.modeConfirmed = await switchRuleSource(
      store.client, 'store', prog.seed, 'before the questions below',
    );

    // ── ask ──
    result.storeSet = await adapter.domainFactSet();
    if (result.storeSet.length === 0) {
      throw new HarnessGap(
        `seed ${prog.seed}: ${result.reflectedFacts} facts were reflected and the mode read back 'store', yet the ` +
        `store-mode answer is EMPTY while the oracle derives ${v0Set.length} facts. That is a silence, not a result.\n${prog.text}`,
      );
    }

    const vsOracle = compareFactSets(v0Set, result.storeSet);
    result.agreesWithOracle = vsOracle.equal;
    if (!vsOracle.equal) result.diffVsOracle = { onlyV0: vsOracle.onlyV0, onlyStore: vsOracle.onlyRfdb };

    const vsText = compareFactSets(textSet, result.storeSet);
    result.agreesWithText = vsText.equal;
    if (!vsText.equal) result.diffVsText = { onlyText: vsText.onlyV0, onlyStore: vsText.onlyRfdb };

    // Witnesses, through the same checks the text pass runs — why() and why-not() both
    // assemble the program from the pinned view in store mode
    // (`engine_v2.rs:902-905` ⟦decoded FROM that view⟧), so the
    // explain surface is measured out of the store too, not assumed to follow.
    await spotCheckWitnesses(adapter, prog, v0, v0Set, result.storeSet, result);
    await spotCheckGaps(adapter, prog, v0, new Set(v0Set), result);
    return result;
  } finally {
    // The ephemeral database dies with its last connection
    // (`rfdb_server.rs:3075-3079` ⟦Cleanup ephemeral database if no connections remain⟧);
    // {@link runTier0} proves at the end of the pass that none of them survived.
    await store.client.closeDatabase();
  }
}

export interface Tier0StoreSummary {
  seedsRun: number;
  /** THE NUMBER: seeds whose store-mode fact set equals the text-mode fact set. */
  agreeWithText: number;
  /** Seeds whose store-mode fact set equals the ROFL v0 oracle's. */
  agreeWithOracle: number;
  /** Seeds Projection T refused to carry — NOT divergences. */
  unreflectable: StoreSeedResult[];
  /** Seeds that disagreed with the text answer, the oracle, or a witness check. */
  divergences: StoreSeedResult[];
  reflectedFactsTotal: number;
  /** Seeds whose FRESH database answered the very same selectors with zero rows before
   *  anything was reflected into it. This is the discriminator that separates an answer
   *  from a silence, so the count is reported beside the agreement numbers rather than
   *  left implicit in "the run did not abort". */
  emptyStoreControlsPassed: number;
  /** Seeds where the database itself, asked through the read-only `getRuleSource` door,
   *  said 'store' before being asked anything — a switch the server ignored would otherwise
   *  leave the questions answered from the request text. */
  storeModeConfirmed: number;
  witnessChecked: number;
  witnessFailed: number;
  whynotChecked: number;
  whynotFailed: number;
  /** The E-code the refusal-detector control produced, proving the category is measurable. */
  refusalControlCode: string;
}

export interface Tier0Summary {
  seedsRun: number;
  divergences: SeedResult[];
  witnessChecked: number;
  witnessFailed: number;
  whynotChecked: number;
  whynotFailed: number;
  /** The rules-from-store pass — present ONLY when a caller passed a {@link StorePassContext}.
   *  An ordinary run leaves it undefined, so nothing downstream (report, exit code) can even
   *  see that the second pass exists. */
  store?: Tier0StoreSummary;
}

/** Tier-0. With `store` supplied, every seed is measured TWICE: once the ordinary way
 *  (rules in the request text) and once with the same program's rules read back out of a
 *  fresh per-seed database. The text pass runs first and unchanged — its answer becomes the
 *  store pass's second reference, beside the oracle. */
export async function runTier0(
  ctx: SeedContext,
  nSeeds: number,
  store?: StorePassContext,
): Promise<Tier0Summary> {
  const positive = Math.round(nSeeds * 0.75);
  const summary: Tier0Summary = {
    seedsRun: 0, divergences: [],
    witnessChecked: 0, witnessFailed: 0,
    whynotChecked: 0, whynotFailed: 0,
  };
  let storeSummary: Tier0StoreSummary | null = null;
  if (store) {
    storeSummary = {
      seedsRun: 0, agreeWithText: 0, agreeWithOracle: 0,
      unreflectable: [], divergences: [], reflectedFactsTotal: 0,
      emptyStoreControlsPassed: 0, storeModeConfirmed: 0,
      witnessChecked: 0, witnessFailed: 0, whynotChecked: 0, whynotFailed: 0,
      refusalControlCode: await assertRefusalDetectorWorks(store),
    };
  }
  for (let seed = 1; seed <= nSeeds; seed++) {
    const prog = generateProgram(seed, positive);
    const res = await runSeedDifferential(prog, ctx);
    summary.seedsRun++;
    summary.witnessChecked += res.witnessChecked;
    summary.witnessFailed += res.witnessFailed.length;
    summary.whynotChecked += res.whynotChecked;
    summary.whynotFailed += res.whynotFailed.length;
    if (res.diverged) summary.divergences.push(res);

    if (store && storeSummary) {
      const sres = await runSeedStorePass(prog, ctx, store, res.rfdbSet);
      storeSummary.seedsRun++;
      storeSummary.reflectedFactsTotal += sres.reflectedFacts;
      if (sres.emptyStoreRows === 0) storeSummary.emptyStoreControlsPassed++;
      if (sres.modeConfirmed === 'store') storeSummary.storeModeConfirmed++;
      storeSummary.witnessChecked += sres.witnessChecked;
      storeSummary.witnessFailed += sres.witnessFailed.length;
      storeSummary.whynotChecked += sres.whynotChecked;
      storeSummary.whynotFailed += sres.whynotFailed.length;
      if (sres.unreflectable !== null) {
        storeSummary.unreflectable.push(sres);
        continue;
      }
      if (sres.agreesWithText) storeSummary.agreeWithText++;
      if (sres.agreesWithOracle) storeSummary.agreeWithOracle++;
      const witnessTrouble = sres.witnessFailed.length > 0 || sres.whynotFailed.length > 0;
      if (!sres.agreesWithText || !sres.agreesWithOracle || witnessTrouble) {
        storeSummary.divergences.push(sres);
      }
    }
  }
  if (store && storeSummary !== null) {
    // No per-seed database may outlive the pass. A survivor would mean a seed's database
    // stayed open, and the NEXT seed's "fresh, empty store" would then be somebody else's.
    const left = (await store.client.listDatabases()).filter((n) => n.startsWith(`${store.dbPrefix}-`));
    if (left.length > 0) {
      throw new HarnessGap(`the store pass left ${left.length} of its databases behind: ${left.join(', ')}`);
    }
    summary.store = storeSummary;
  }
  return summary;
}
