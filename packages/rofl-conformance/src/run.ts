// run.ts — CLI orchestrator: server spawn → tier-0 differential → tier-1
// suite (oracle self-check first) → reports. Exit nonzero on: crash,
// DIVERGENCE, HARNESS_GAP, scenario-count mismatch, tier-0 translator failure.
//
//   node --experimental-strip-types packages/rofl-conformance/src/run.ts \
//     [--seeds N] [--rfdb <binary>] [--only tier0|tier1] [--rules-from-store]
//
// --rules-from-store adds a SECOND tier-0 pass in which each seed's rules are
// first reflected into a fresh per-seed database and the questions are then
// answered with the database reading its rules from the store instead of from
// the request text. Off by default and additive: without the flag not one wire
// call, not one line of report differs from before the flag existed.
// (the round-001 pre-registration gate below is unconditional by design —
//  the ТЗ protocol forbids running against editable expectations)

import { execSync } from 'node:child_process';
import { startServer, StaleBinaryError, DEFAULT_BINARY, type ServerHandle } from './rfdb-server.ts';
import { RfdbClient } from './rfdb-client.ts';
import { runTier0, makeSeedContext, HarnessGap, type Tier0Summary, type StorePassContext } from './differential.ts';
import { runOracleSelfCheck, runSubject, type ScenarioResult } from './suite-runner.ts';
import { buildReport, writeReports } from './report.ts';

function argOf(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const SEEDS = parseInt(argOf('--seeds') ?? '120', 10);
const BINARY = argOf('--rfdb') ?? DEFAULT_BINARY;
const ONLY = argOf('--only');
/** Explicit opt-in — a bare presence flag, so no ordinary invocation can turn it on by
 *  mistyping a value. */
const RULES_FROM_STORE = process.argv.includes('--rules-from-store');

async function main(): Promise<number> {
  const t0 = Date.now();

  // Pre-registration integrity: round-001 must be COMMITTED before the first
  // run — refuse to produce an expected-vs-found join against editable claims.
  try {
    const tracked = execSync('git ls-files run-migration/rounds/round-001.rofl', {
      cwd: new URL('../../..', import.meta.url).pathname, encoding: 'utf8',
    }).trim();
    if (tracked === '') {
      console.error('ABORT: run-migration/rounds/round-001.rofl is not committed — pre-register expectations first (ТЗ protocol)');
      return 3;
    }
  } catch (e) {
    console.error(`ABORT: cannot verify round-001 pre-registration: ${(e as Error).message}`);
    return 3;
  }

  console.log(`[run] starting rfdb-server (${BINARY})`);
  let server: ServerHandle;
  try {
    server = await startServer(BINARY);
  } catch (e) {
    // A binary that cannot be measured against is an ABORT (3), like the
    // pre-registration gate above — the same class of "this run must not
    // happen at all". Exit 1 is reserved for a run that DID happen and found
    // divergences, and conflating the two makes a refusal look like a result.
    if (e instanceof StaleBinaryError) {
      console.error(`ABORT: ${e.message}`);
      return 3;
    }
    console.error(`ABORT: cannot start rfdb-server: ${(e as Error).message}`);
    return 3;
  }
  let exitCode = 0;
  let storeClient: RfdbClient | null = null;
  try {
    const client = await RfdbClient.connect(server.socketPath);
    const hello = await client.hello();
    console.log(`[run] rfdb-server ${hello.serverVersion}, protocol v${hello.protocolVersion}, features: ${hello.features.join(',')}`);

    const seedCtx = makeSeedContext(client);

    // ── tier-0 ──
    let tier0: Tier0Summary = { seedsRun: 0, divergences: [], witnessChecked: 0, witnessFailed: 0, whynotChecked: 0, whynotFailed: 0 };
    if (ONLY !== 'tier1') {
      // The store pass drives per-seed databases on its OWN connection: current-database is
      // per connection, so the text pass above keeps answering off the server's default
      // database and is not disturbed by so much as an open-database.
      let storeCtx: StorePassContext | undefined;
      if (RULES_FROM_STORE) {
        if (!hello.features.includes('rulesAsData')) {
          console.error(
            `ABORT: --rules-from-store was asked for, but this server advertises [${hello.features.join(',')}] ` +
            'and not rulesAsData — reflectProgram/setRuleSource are not on this wire, so the pass would measure nothing',
          );
          return 3;
        }
        storeClient = await RfdbClient.connect(server.socketPath);
        await storeClient.hello();
        storeCtx = { client: storeClient, dbPrefix: `rofl-store-${process.pid}` };
      }
      console.log(`[run] tier-0: ${SEEDS}-seed differential${RULES_FROM_STORE ? ' + rules-from-store pass' : ''}`);
      tier0 = await runTier0(seedCtx, SEEDS, storeCtx);
      console.log(`[run] tier-0 done: ${tier0.seedsRun} seeds, ${tier0.divergences.length} divergences, why ${tier0.witnessChecked - tier0.witnessFailed}/${tier0.witnessChecked} sound, whynot ${tier0.whynotChecked - tier0.whynotFailed}/${tier0.whynotChecked} sound`);
      if (tier0.divergences.length > 0) exitCode = 1;

      const st = tier0.store;
      if (st) {
        // THE NUMBER, and beside it everything needed to tell it apart from a silence:
        // how many programs the store could not carry, how many facts reflection wrote,
        // and the E-code the refusal control produced (proving the refusal path is live).
        console.log(
          `[run] rules-from-store: ${st.agreeWithText}/${st.seedsRun - st.unreflectable.length} seeds answer the SAME with rules from the store as with rules from the text` +
          ` (vs oracle ${st.agreeWithOracle}/${st.seedsRun - st.unreflectable.length}), ` +
          `${st.unreflectable.length} not reflectable [refusal control: ${st.refusalControlCode}], ` +
          `${st.reflectedFactsTotal} rule-facts written, ` +
          `empty-store control passed ${st.emptyStoreControlsPassed}/${st.seedsRun}, mode read back 'store' ${st.storeModeConfirmed}/${st.seedsRun - st.unreflectable.length}, ` +
          `why ${st.witnessChecked - st.witnessFailed}/${st.witnessChecked} sound, whynot ${st.whynotChecked - st.whynotFailed}/${st.whynotChecked} sound`,
        );
        for (const d of st.divergences) {
          console.log(`[run]   STORE DIVERGENCE seed ${d.seed}: vsText=${JSON.stringify(d.diffVsText)} vsOracle=${JSON.stringify(d.diffVsOracle)} why=${JSON.stringify(d.witnessFailed)} whynot=${JSON.stringify(d.whynotFailed)}`);
        }
        for (const u of st.unreflectable) {
          console.log(`[run]   NOT REFLECTABLE seed ${u.seed}: ${u.unreflectable} — ${u.unreflectableDetail}`);
        }
        if (st.divergences.length > 0) exitCode = 1;
      }
    }

    // ── tier-1 ──
    let tier1: ScenarioResult[] = [];
    if (ONLY !== 'tier0') {
      console.log('[run] tier-1 PASS 1: oracle self-check (30 scenarios on vendored v0)');
      await runOracleSelfCheck();
      console.log('[run] oracle self-check: 30/30 pass');
      console.log('[run] tier-1 PASS 2: subject verdicts (RfdbRofl adapter)');
      tier1 = await runSubject(client, seedCtx);
      const counts = { GREEN: 0, RED: 0, DIVERGENCE: 0, HARNESS_GAP: 0 };
      for (const r of tier1) counts[r.verdict]++;
      console.log(`[run] tier-1 done: GREEN ${counts.GREEN} / RED ${counts.RED} / DIVERGENCE ${counts.DIVERGENCE} / HARNESS_GAP ${counts.HARNESS_GAP}`);
      if (counts.DIVERGENCE > 0 || counts.HARNESS_GAP > 0) exitCode = 1;
    }

    const report = buildReport(tier1, tier0, {
      serverVersion: hello.serverVersion,
      protocolVersion: hello.protocolVersion,
      binary: BINARY,
    });
    const { jsonPath, mdPath } = writeReports(report);
    console.log(`[run] reports: ${jsonPath}`);
    console.log(`[run]          ${mdPath}`);
    console.log(`[run] wallclock: ${((Date.now() - t0) / 1000).toFixed(1)}s, exit ${exitCode}`);
    client.close();
    return exitCode;
  } catch (e) {
    if (e instanceof HarnessGap) {
      console.error(`[run] HARNESS_GAP (harness defect, not an engine verdict):\n${e.message}`);
      return 2;
    }
    console.error(`[run] CRASH: ${(e as Error).stack}`);
    return 2;
  } finally {
    storeClient?.close();
    server.stop();
  }
}

process.exitCode = await main();
