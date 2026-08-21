// suite-runner.ts — tier-1: run the 30 scenarios in two passes.
//
// PASS 1 (oracle self-check): every scenario runs against the vendored v0
// engine and MUST pass, and the scenario count MUST equal 30 — a failing or
// missing scenario is a HARNESS defect (broken port / silent skip), and the
// run aborts. This is the anti-fake-green / anti-silent-skip gate.
//
// PASS 2 (subject verdicts): each scenario runs against the RfdbRofl adapter.
//   pass                         → GREEN
//   UnsupportedFeature(code)     → RED { reason_code }   (harness SUCCESS)
//   assertion failure / E-code
//     on fully-translatable path → DIVERGENCE            (run fails, repro)
//   anything else                → HARNESS_GAP           (run fails)

import { AssertionError } from 'node:assert';
import { SCENARIOS, EXPECTED_SCENARIO_COUNT, type Ctx, type Scenario } from './scenarios.ts';
import { OracleEngine } from './oracle.ts';
import { RfdbRofl } from './adapter.ts';
import { RfdbClient, RfdbError } from './rfdb-client.ts';
import { UnsupportedFeature } from './translate.ts';
import { HarnessGap, makeSeedContext, type SeedContext } from './differential.ts';

export type Verdict = 'GREEN' | 'RED' | 'DIVERGENCE' | 'HARNESS_GAP';

export interface ScenarioResult {
  id: string;
  sourceRef: string;
  tier: 'tier1';
  verdict: Verdict;
  reason_code: string | null;
  evidence: string;
}

function oracleCtx(): Ctx {
  return {
    mk: (opts) => new OracleEngine(opts),
    fromSnapshot: (json, opts) => OracleEngine.fromSnapshot(json, opts),
    mkOracle: (opts) => new OracleEngine(opts),
    seedCtx: null,
  };
}

function subjectCtx(client: RfdbClient, seedCtx: SeedContext): Ctx {
  return {
    mk: (opts) => new RfdbRofl(client, opts),
    fromSnapshot: (json, opts) => RfdbRofl.fromSnapshot(json, opts),
    mkOracle: (opts) => new OracleEngine(opts),
    seedCtx,
  };
}

export async function runOracleSelfCheck(): Promise<void> {
  if (SCENARIOS.length !== EXPECTED_SCENARIO_COUNT) {
    throw new HarnessGap(`scenario count ${SCENARIOS.length} ≠ ${EXPECTED_SCENARIO_COUNT} — a v0 test was silently skipped or duplicated`);
  }
  const ids = new Set(SCENARIOS.map((s) => s.id));
  if (ids.size !== SCENARIOS.length) throw new HarnessGap('duplicate scenario ids');
  for (const s of SCENARIOS) {
    try {
      await s.run(oracleCtx());
    } catch (e) {
      throw new HarnessGap(`oracle self-check FAILED for ${s.id} (${s.sourceRef}): the port is broken, aborting before any subject verdict.\n${(e as Error).stack}`);
    }
  }
}

export async function runSubject(client: RfdbClient, seedCtx: SeedContext): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    out.push(await runOneSubject(s, client, seedCtx));
  }
  return out;
}

async function runOneSubject(s: Scenario, client: RfdbClient, seedCtx: SeedContext): Promise<ScenarioResult> {
  const base = { id: s.id, sourceRef: s.sourceRef, tier: 'tier1' as const };
  const callsBefore = client.callCount;
  try {
    await s.run(subjectCtx(client, seedCtx));
    // Honest per-scenario evidence: a GREEN that never produced a wire
    // round-trip (parse-reject scenarios stop at the SHARED vendored v0
    // parser) must not claim engine delegation.
    const wireCalls = client.callCount - callsBefore;
    return {
      ...base, verdict: 'GREEN', reason_code: null,
      evidence: wireCalls > 0
        ? `all ported assertions passed against the RfdbRofl adapter (answers delegated to rfdb-server over the wire; ${wireCalls} wire round-trips)`
        : 'all ported assertions passed via the SHARED vendored v0 parser front-end (rejection at load(); no engine delegation involved — zero wire round-trips)',
    };
  } catch (e) {
    if (e instanceof UnsupportedFeature) {
      return { ...base, verdict: 'RED', reason_code: e.code, evidence: e.detail };
    }
    if (e instanceof AssertionError) {
      return { ...base, verdict: 'DIVERGENCE', reason_code: null, evidence: `assertion failed on translatable input: ${e.message}` };
    }
    if (e instanceof RfdbError) {
      return { ...base, verdict: 'DIVERGENCE', reason_code: e.code, evidence: `unexpected engine error on translatable input: ${e.message}` };
    }
    if (e instanceof HarnessGap) {
      return { ...base, verdict: 'HARNESS_GAP', reason_code: null, evidence: e.message };
    }
    return { ...base, verdict: 'HARNESS_GAP', reason_code: null, evidence: `unexpected harness exception: ${(e as Error).stack}` };
  }
}

export { makeSeedContext };
