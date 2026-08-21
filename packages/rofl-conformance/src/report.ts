// report.ts — emit the machine report (conformance-report.json), the human
// report (_ai/research/rofl-conformance-report.md) and the run-identity sidecar
// (conformance-run-meta.json), including the expected-vs-found join against the
// pre-registered ledger round-001 claims.
//
// conformance-report.json carries NO run identity: two identical-seed runs on
// the same commit produce byte-identical report files (ТЗ A3 reproducibility
// discipline) — run_id/timestamp live in the sidecar, and the ledger records
// the sha256 of the report bytes it archives per round.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { ScenarioResult } from './suite-runner.ts';
import type { Tier0Summary } from './differential.ts';

export interface ExpectedVsFound {
  claim: string;
  expected: string;
  found: string;
  match: boolean;
  note: string;
}

export interface Report {
  engines: {
    v0: { rev: string };
    rfdb: { gitSha: string; binary: string; serverVersion: string; protocolVersion: number };
  };
  tier0: {
    seeds: number;
    divergences: object[];
    witnessChecks: { passed: number; failed: number };
    whynotChecks: { passed: number; failed: number };
  };
  tier1: ScenarioResult[];
  expectedVsFound: ExpectedVsFound[];
  discoveredEngineFindings: string[];
}

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = path.resolve(PKG, '../..');

function sh(cmd: string): string {
  return execSync(cmd, { cwd: REPO, encoding: 'utf8' }).trim();
}

/** Join actual results against the round-001 pre-registered claims. */
export function joinExpectations(tier1: ScenarioResult[], tier0: Tier0Summary): ExpectedVsFound[] {
  const byId = new Map(tier1.map((r) => [r.id, r]));
  const verdictOf = (ids: string[]): { allGreen: boolean; allRed: boolean; summary: string } => {
    const rs = ids.map((i) => byId.get(i)).filter((r): r is ScenarioResult => r !== undefined);
    return {
      allGreen: rs.every((r) => r.verdict === 'GREEN'),
      allRed: rs.every((r) => r.verdict === 'RED'),
      summary: rs.map((r) => `${r.id}=${r.verdict}${r.reason_code ? `(${r.reason_code})` : ''}`).join(', '),
    };
  };
  const out: ExpectedVsFound[] = [];
  {
    // exp_phase1_tc_parse_green: TC seminaive + the two parse rejects GREEN
    const v = verdictOf(['p1-tc-seminaive', 'p1-async-reject', 'p1-next-body-reject']);
    out.push({ claim: 'exp_phase1_tc_parse_green', expected: 'green', found: v.allGreen ? 'green' : 'not-green', match: v.allGreen, note: v.summary });
  }
  {
    const r = byId.get('p1-functor-append');
    const found = r ? `${r.verdict.toLowerCase()}${r.reason_code ? `:${r.reason_code}` : ''}` : 'missing';
    out.push({ claim: 'exp_phase1_functor_red', expected: 'red:missing:compound-terms', found, match: r?.verdict === 'RED' && r.reason_code === 'missing:compound-terms', note: r?.evidence.slice(0, 160) ?? '' });
  }
  {
    const r = byId.get('p1-arith');
    const found = r ? `${r.verdict.toLowerCase()}${r.reason_code ? `:${r.reason_code}` : ''}` : 'missing';
    out.push({ claim: 'exp_phase1_arith_red', expected: 'red:dialect:untranslatable', found, match: r?.verdict === 'RED' && r.reason_code === 'dialect:untranslatable', note: r?.evidence.slice(0, 160) ?? '' });
  }
  {
    const v = verdictOf(['p2-diff-positive', 'p2-diff-negation']);
    out.push({ claim: 'exp_phase2_differentials_green', expected: 'green', found: v.allGreen ? 'green' : 'not-green', match: v.allGreen, note: v.summary });
  }
  {
    const v = verdictOf(['p2-why-tree', 'p2-persp-isolation', 'p2-stratum-order', 'p2-noboot-null-plan', 'p2-unstrat-reject', 'p2-derived-by']);
    out.push({ claim: 'exp_phase2_whytree_persp_strata_red', expected: 'red', found: v.allRed ? 'red' : 'mixed', match: v.allRed, note: v.summary });
  }
  {
    const v = verdictOf(['p3-kernel-grep', 'p3-runtime-rule', 'p3-write-protected', 'p3-breach', 'p3-malformed-sibling', 'p3-snapshot-roundtrip']);
    out.push({ claim: 'exp_phase3_reflection_snapshot_red', expected: 'red', found: v.allRed ? 'red' : 'mixed', match: v.allRed, note: v.summary });
  }
  {
    const v = verdictOf(['p4-counter', 'p4-replay', 'p4-tm', 'p4-tm-diverge', 'p4-boot-audits', 'p4-sensors', 'p4-excise-multi', 'p4-forged', 'p4-budget-hole']);
    out.push({ claim: 'exp_phase4_time_budget_boot_red', expected: 'red', found: v.allRed ? 'red' : 'mixed', match: v.allRed, note: v.summary });
  }
  {
    const r = byId.get('boot-load');
    const found = r ? `${r.verdict.toLowerCase()}${r.reason_code ? `:${r.reason_code}` : ''}` : 'missing';
    out.push({ claim: 'exp_boot_load_red', expected: 'red:missing:rules-as-data', found, match: r?.verdict === 'RED' && r.reason_code === 'missing:rules-as-data', note: r?.evidence.slice(0, 160) ?? '' });
  }
  out.push({
    claim: 'exp_tier0_differential_green',
    expected: 'green',
    found: tier0.divergences.length === 0 ? 'green' : `divergences:${tier0.divergences.length}`,
    match: tier0.divergences.length === 0,
    note: `${tier0.seedsRun} seeds run`,
  });
  out.push({
    claim: 'exp_tier0_witness_green',
    expected: 'green',
    found: tier0.witnessFailed === 0 && tier0.whynotFailed === 0
      ? 'green'
      : `failed:why=${tier0.witnessFailed},whynot=${tier0.whynotFailed}`,
    match: tier0.witnessFailed === 0 && tier0.whynotFailed === 0,
    note: `${tier0.witnessChecked} why witnesses (existence + body ⊆ v0 facts) + ${tier0.whynotChecked} whynot gap witnesses (existence + satisfied ⊆ v0 facts) checked; NOT tree identity — v0 keeps first witness only, store.ts:127`,
  });
  return out;
}

export function buildReport(
  tier1: ScenarioResult[],
  tier0: Tier0Summary,
  server: { serverVersion: string; protocolVersion: number; binary: string },
): Report {
  const v0Rev = fs.readFileSync(path.join(PKG, 'vendor/rofl-v0/REV'), 'utf8').trim();
  const gitSha = sh('git rev-parse HEAD');
  return {
    engines: {
      v0: { rev: v0Rev },
      rfdb: { gitSha, binary: server.binary, serverVersion: server.serverVersion, protocolVersion: server.protocolVersion },
    },
    tier0: {
      seeds: tier0.seedsRun,
      divergences: tier0.divergences.map((d) => ({
        seed: d.seed, ecode: d.ecode, diff: d.diff, witnessFailed: d.witnessFailed,
        whynotFailed: d.whynotFailed, program: d.program,
        v0Set: d.v0Set, rfdbSet: d.rfdbSet,
      })),
      witnessChecks: { passed: tier0.witnessChecked - tier0.witnessFailed, failed: tier0.witnessFailed },
      whynotChecks: { passed: tier0.whynotChecked - tier0.whynotFailed, failed: tier0.whynotFailed },
    },
    tier1,
    expectedVsFound: joinExpectations(tier1, tier0),
    discoveredEngineFindings: [
      'RFDB `\\+ p(X, _)` (wildcard inside a NEGATED literal) silently returns wrong answers: probe q0(X) :- p0(X), \\+ p2(X, _) with p0(c0). p0(c1). p2(c1,c9). returned {c0, c1}; correct is {c0}. Positive wildcards are correct. The harness translator works around it by projecting negated wildcards through an auxiliary predicate (documented, not masked).',
      'A body literal over a predicate with NO facts and NO rules HANGS rfdb-server past the 30s EvalLimits deadline (probe: q0(X) :- p0(X), p9(X). — no response in >45s). The translator eliminates statically-empty predicates to fixpoint before hitting the wire.',
      'A fully-ground body literal in a multi-literal rule trips E-PLAN-003 after planner reordering (the ground leg is placed first, the var leg then shares no binding): q0(X) :- p0(X), p1("c1","c2"). rejected. shares_no_binding treats ground probes as safe (plan.rs:1506-1520) but only in the written order.',
      'executeDatalog "first rule head" includes ground FACTS (a fact is a bodyless rule): the target predicate\'s first RULE must be hoisted above all facts or the response is the first fact\'s relation with empty bindings.',
    ],
  };
}

export function writeReports(report: Report): { jsonPath: string; mdPath: string; metaPath: string; runId: string } {
  const jsonPath = path.join(PKG, 'conformance-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');

  // Run identity lives in the sidecar so the report file itself is
  // byte-reproducible evidence (same seeds + same commit ⇒ same bytes).
  const metaPath = path.join(PKG, 'conformance-run-meta.json');
  const runId = `rofl-conformance-${Date.now()}`;
  fs.writeFileSync(metaPath, JSON.stringify({ run_id: runId, timestamp: new Date().toISOString() }, null, 2) + '\n');

  const mdPath = path.join(REPO, '_ai/research/rofl-conformance-report.md');
  const t1 = report.tier1;
  const green = t1.filter((r) => r.verdict === 'GREEN');
  const red = t1.filter((r) => r.verdict === 'RED');
  const div = t1.filter((r) => r.verdict === 'DIVERGENCE');
  const gap = t1.filter((r) => r.verdict === 'HARNESS_GAP');
  const byCode = new Map<string, number>();
  for (const r of red) byCode.set(r.reason_code!, (byCode.get(r.reason_code!) ?? 0) + 1);

  const lines: string[] = [];
  lines.push('# ROFL v0 ↔ RFDB conformance report (P0 harness)');
  lines.push('');
  lines.push(`- run: \`${runId}\` (identity in \`conformance-run-meta.json\`; the machine report \`conformance-report.json\` is byte-reproducible and carries no run identity)`);
  lines.push(`- oracle: ROFL v0 vendored at \`${report.engines.v0.rev}\` (main); subject: rfdb-server ${report.engines.rfdb.serverVersion} (protocol v${report.engines.rfdb.protocolVersion}, derive engine, repo \`${report.engines.rfdb.gitSha.slice(0, 12)}\`)`);
  lines.push(`- a RED verdict is a SUCCESS of the harness: it is a machine-readable migration-roadmap entry, not a failure. Harness failures are crashes, fake greens, silent skips — gated by the oracle self-check (30/30 must pass on vendored v0) and the scenario-count check.`);
  lines.push('');
  lines.push('## Tier-0 — 120-seed TS↔RFDB differential (common subset)');
  lines.push('');
  lines.push(`- seeds run: **${report.tier0.seeds}** (75% positive, 25% stratified negation with boot preloaded on the v0 side)`);
  lines.push(`- fact-set divergences: **${report.tier0.divergences.length}**`);
  lines.push(`- why (positive) witness spot-checks: **${report.tier0.witnessChecks.passed} passed / ${report.tier0.witnessChecks.failed} failed** (existence + body ⊆ v0 fact set; deliberately NOT tree identity — v0 stores only the first witness per fact, store.ts:127, and witness choice is mode-dependent, LIMITS.md:48; tree-shape parity remains RED missing:whynot-shape)`);
  lines.push(`- whynot (negative) gap spot-checks: **${report.tier0.whynotChecks.passed} passed / ${report.tier0.whynotChecks.failed} failed** (≤5 absent ground tuples per seed over rule-bearing rels: v0 whynot must NOT hold, RFDB explainDatalogGap witness must EXIST, satisfied premises ⊆ v0 fact set, failing predicate must be a program/aux predicate; demo-tree parity stays RED missing:whynot-shape)`);
  lines.push('');
  if (report.tier0.divergences.length > 0) {
    lines.push('### DIVERGENCES (engine disagreement — investigate, never recode as RED)');
    lines.push('```json');
    lines.push(JSON.stringify(report.tier0.divergences, null, 2));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Tier-1 — the 29 v0 tests + boot.rofl');
  lines.push('');
  lines.push(`- GREEN ${green.length} / RED ${red.length} / DIVERGENCE ${div.length} / HARNESS_GAP ${gap.length} (of ${t1.length})`);
  lines.push(`- RED by reason code: ${[...byCode.entries()].map(([c, n]) => `\`${c}\`×${n}`).join(', ')}`);
  lines.push('');
  lines.push('| scenario | source | verdict | reason code | evidence |');
  lines.push('|---|---|---|---|---|');
  for (const r of t1) {
    lines.push(`| ${r.id} | ${r.sourceRef.split(' ')[0]} | ${r.verdict} | ${r.reason_code ?? '—'} | ${r.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220)} |`);
  }
  lines.push('');
  lines.push('## Expected vs found (join against ledger round-001 pre-registrations)');
  lines.push('');
  lines.push('| claim | expected | found | match | note |');
  lines.push('|---|---|---|---|---|');
  for (const e of report.expectedVsFound) {
    lines.push(`| ${e.claim} | ${e.expected} | ${e.found} | ${e.match ? '✓' : '✗'} | ${e.note.replace(/\|/g, '\\|').slice(0, 200)} |`);
  }
  lines.push('');
  lines.push('## Engine findings discovered by the harness (probe evidence)');
  lines.push('');
  for (const f of report.discoveredEngineFindings) lines.push(`- ${f}`);
  lines.push('');
  lines.push('## Comparison-mode statement');
  lines.push('');
  lines.push('Tier-0 compares canonicalized USER-visible fact sets: perspective-stripped `rel(args)` lines, sorted; the v0 side is masked by the phase2.test.ts:56-61 domainFacts port (RESERVED + stratum + unstratified excluded) intersected with the generated program\'s relations (boot is preloaded on the v0 side of negation seeds and derives its own vocabulary the RFDB side can never contain). Witness comparison covers BOTH directions: positive (why — witness existence + body ⊆ v0 facts) and negative (whynot — gap-witness existence for absent tuples + satisfied premises ⊆ v0 facts + failing-predicate sanity), NOT tree identity. why/whynot TREE parity is out of tier-0 scope by design (missing:whynot-shape).');
  lines.push('');
  fs.writeFileSync(mdPath, lines.join('\n'));
  return { jsonPath, mdPath };
}
