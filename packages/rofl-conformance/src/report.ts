// report.ts — emit the machine report (conformance-report.json), the human
// report (_ai/research/rofl-conformance-report.md) and the run-identity sidecar
// (conformance-run-meta.json), including the expected-vs-found join against the
// pre-registered ledger round-001 claims.
//
// Anchors (⟦…⟧, see citations.ts) are SOURCE-SIDE bookkeeping, so prose that
// carries a checkable citation still reads to a human exactly as it did before
// the convention existed. The ORDER is load-bearing: every string is stripped
// BEFORE it is truncated (buildReport returns stripAnchorsDeep(...), and the
// note fields that slice a scenario's evidence strip it first), and the finished
// document is only ASSERTED anchor-free. Stripping a document that has already
// been truncated deletes everything from a half-open ⟦ to the next ⟧ — which
// lands in a LATER table row. Measured, not hypothetical: it swallowed ten rows
// of the tier-1 table before the order was fixed.
//
// conformance-report.json carries NO run identity: two identical-seed runs on
// the same commit produce byte-identical report files (ТЗ A3 reproducibility
// discipline) — run_id/timestamp live in the sidecar, and the ledger records
// the sha256 of the report bytes it archives per round.

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { ScenarioResult } from './suite-runner.ts';
import type { Tier0Summary } from './differential.ts';
import { stripAnchors, stripAnchorsDeep, assertNoAnchors } from './citations.ts';

export interface ExpectedVsFound {
  claim: string;
  expected: string;
  found: string;
  match: boolean;
  note: string;
}

/** Seeds the store pass actually MEASURED: the denominator under every agreement count. */
export function storePassMeasured(st: NonNullable<Tier0Summary['store']>): number {
  return st.seedsRun - st.unreflectable.length;
}

/** Why the store pass's denominator is not the full seed count — or `null` when it is.
 *
 *  THE FLOOR UNDER THE NUMBER, and the reason it exists: every count this pass publishes is
 *  "N of M", and M is computed, not fixed. Let the seeds refuse (a `#requires` the generator
 *  starts emitting, a Projection T that narrows) and M collapses with them — 119 refusals
 *  leave "1/1 agree", which is literally true, reads like a pass, and is a measurement of
 *  almost nothing. Measured on the code as it stood: with 7 of 8 seeds refused the verdict
 *  row came back `green` and the run exited 0.
 *
 *  So a shortfall is a RED verdict and a non-zero exit, not a footnote beside a green one.
 *  Both halves are checked, because the denominator can shrink from either end: seeds that
 *  refused ON THE MERITS (they never reached the store), and seeds the pass never ran at all
 *  (fewer store-pass seeds than text-pass seeds). Refusals stay their own category in the
 *  report — this does not recode them as divergences, it stops them being invisible.
 *
 *  Pinned by `the store pass verdict goes RED when its denominator collapses` in
 *  test/store-pass.test.ts. */
export function storePassShortfall(tier0: Tier0Summary): string | null {
  const st = tier0.store;
  if (!st) return null;
  if (st.seedsRun !== tier0.seedsRun) {
    return `the store pass ran ${st.seedsRun} of the ${tier0.seedsRun} seeds the text pass ran`;
  }
  const measured = storePassMeasured(st);
  if (measured !== st.seedsRun) {
    return `only ${measured} of ${st.seedsRun} seeds were measured (${st.unreflectable.length} refused on the merits)`;
  }
  return null;
}

export interface Report {
  engines: {
    v0: { rev: string };
    rfdb: {
      gitSha: string;
      /** Whether the working tree carried UNCOMMITTED changes THE RUN READ when it
       *  happened. Without it `gitSha` reads as «measured at this commit» when what was
       *  measured was a binary built from that commit plus whatever was in the tree — and
       *  a reader rebuilding from the sha would get a different engine and no warning.
       *  The run's own three report files are discounted: they are what the run WRITES,
       *  and counting them would light the flag on every run after the first. */
      dirtyTree: boolean;
      binary: string;
      /** SHA-256 of the binary that was actually measured. This is the provenance that
       *  cannot drift: the sha above names source, this names the artifact. */
      binarySha256: string;
      serverVersion: string;
      protocolVersion: number;
    };
  };
  tier0: {
    seeds: number;
    divergences: object[];
    witnessChecks: { passed: number; failed: number };
    whynotChecks: { passed: number; failed: number };
    /** The rules-from-store pass. Present ONLY when `--rules-from-store` ran it; a run
     *  without the flag omits the key entirely, so its report bytes are the same bytes it
     *  produced before the pass existed. */
    store?: {
      seeds: number;
      /** Seeds Projection T carried whole — the denominator of the two agreement counts. */
      seedsMeasured: number;
      /** Seeds whose fresh database answered the same selectors with ZERO rows before
       *  reflection, and seeds where the server read the mode back as 'store'. Both are
       *  the anti-silence controls: without them an agreement of two empty answers would
       *  read as agreement. */
      emptyStoreControlsPassed: number;
      storeModeConfirmed: number;
      agreeWithText: number;
      agreeWithOracle: number;
      reflectedFactsTotal: number;
      /** Refused ON THE MERITS. Its own category, never a divergence. */
      unreflectable: object[];
      /** The E-code the deliberately-unreflectable control produced, which is what makes
       *  an `unreflectable: []` a measured zero instead of a door that refuses nothing. */
      refusalControlCode: string;
      divergences: object[];
      witnessChecks: { passed: number; failed: number };
      whynotChecks: { passed: number; failed: number };
    };
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

/** The files THIS RUN rewrites, repo-relative. One list, used both to write them and to
 *  discount them in `dirtyTree` — so the two can never drift apart. */
export const RUN_OUTPUTS: readonly string[] = [
  'packages/rofl-conformance/conformance-report.json',
  'packages/rofl-conformance/conformance-run-meta.json',
  '_ai/research/rofl-conformance-report.md',
];

/** The path a `git status --porcelain` line is about: two status letters, a space, then
 *  the path — quoted when it has odd bytes, and `old -> new` for a rename, where the NEW
 *  name is the one that exists in the tree. */
function porcelainPath(line: string): string {
  let p = line.slice(3);
  const arrow = p.indexOf(' -> ');
  if (arrow >= 0) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p;
}

/**
 * Is anything uncommitted that the measurement actually READ?
 *
 * The run's own three report files are outputs, not inputs: after the first run they sit
 * uncommitted in the tree, and a flag that counted them would read «dirty» on every run
 * from then on — a warning that is always on warns about nothing. Everything else counts,
 * including untracked files, because an untracked `.rs` under the engine is exactly the
 * case the flag exists for.
 */
export function treeDirtyBeyondOwnOutputs(porcelain: string): boolean {
  const own = new Set(RUN_OUTPUTS);
  return porcelain
    .split('\n')
    .filter((l) => l.trim() !== '')
    .some((l) => !own.has(porcelainPath(l)));
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
    out.push({ claim: 'exp_phase1_functor_red', expected: 'red:missing:compound-terms', found, match: r?.verdict === 'RED' && r.reason_code === 'missing:compound-terms', note: r ? stripAnchors(r.evidence).slice(0, 160) : '' });
  }
  {
    const r = byId.get('p1-arith');
    const found = r ? `${r.verdict.toLowerCase()}${r.reason_code ? `:${r.reason_code}` : ''}` : 'missing';
    out.push({ claim: 'exp_phase1_arith_red', expected: 'red:dialect:untranslatable', found, match: r?.verdict === 'RED' && r.reason_code === 'dialect:untranslatable', note: r ? stripAnchors(r.evidence).slice(0, 160) : '' });
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
    out.push({ claim: 'exp_boot_load_red', expected: 'red:missing:rules-as-data', found, match: r?.verdict === 'RED' && r.reason_code === 'missing:rules-as-data', note: r ? stripAnchors(r.evidence).slice(0, 160) : '' });
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
    note: `${tier0.witnessChecked} why witnesses (existence + body ⊆ v0 facts) + ${tier0.whynotChecked} whynot gap witnesses (existence + satisfied ⊆ v0 facts) checked; NOT tree identity — v0 keeps first witness only, store.ts:127 ⟦if (!this.witnesses.has(key)) this.witnesses.set(key, w);⟧`,
  });
  // Pre-registered in ledger round-004-pre BEFORE the de-workaround run: with
  // the F1/F2/F3 translator workarounds REMOVED (negated wildcards, unknown
  // predicates and ground body literals go to the wire as-is), the tier-0
  // differential must stay at zero divergences — the end-to-end proof that the
  // engine fixes, not the workarounds, carry the semantics.
  out.push({
    claim: 'exp_deworkaround_tier0_green',
    expected: 'green',
    found: tier0.divergences.length === 0 && tier0.witnessFailed === 0 && tier0.whynotFailed === 0
      ? 'green'
      : `divergences:${tier0.divergences.length},why=${tier0.witnessFailed},whynot=${tier0.whynotFailed}`,
    match: tier0.divergences.length === 0 && tier0.witnessFailed === 0 && tier0.whynotFailed === 0,
    note: `${tier0.seedsRun} seeds with no translator normalization for F1/F2/F3 (translate.ts workarounds removed; engine fixes regression-pinned in exec.rs/plan.rs/stratify.rs)`,
  });
  // Only when the second pass actually ran: an absent row is honest about a question
  // nobody asked, whereas a row reading "0/0 agree" would look like a measurement.
  if (tier0.store) {
    const st = tier0.store;
    const measured = storePassMeasured(st);
    const shortfall = storePassShortfall(tier0);
    const clean = shortfall === null
      && st.agreeWithText === measured && st.agreeWithOracle === measured && st.divergences.length === 0;
    out.push({
      claim: 'exp_rules_from_store_agrees',
      expected: 'green',
      found: clean
        ? 'green'
        : shortfall !== null
          ? `denominator:${shortfall}`
          : `agreeText:${st.agreeWithText}/${measured},agreeOracle:${st.agreeWithOracle}/${measured},divergences:${st.divergences.length}`,
      match: clean,
      note: `${measured} of ${st.seedsRun} seeds carried whole by Projection T (${st.unreflectable.length} refused on the merits, refusal control ${st.refusalControlCode}); ${st.reflectedFactsTotal} rule-facts written; each seed's answer taken from a fresh database whose SAME selectors returned 0 rows before reflection`,
    });
  }
  return out;
}

export function buildReport(
  tier1: ScenarioResult[],
  tier0: Tier0Summary,
  server: { serverVersion: string; protocolVersion: number; binary: string },
): Report {
  const v0Rev = fs.readFileSync(path.join(PKG, 'vendor/rofl-v0/REV'), 'utf8').trim();
  const gitSha = sh('git rev-parse HEAD');
  const dirtyTree = treeDirtyBeyondOwnOutputs(sh('git status --porcelain'));
  const binarySha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(server.binary))
    .digest('hex');
  return stripAnchorsDeep({
    engines: {
      v0: { rev: v0Rev },
      rfdb: {
        gitSha, dirtyTree, binary: server.binary, binarySha256,
        serverVersion: server.serverVersion, protocolVersion: server.protocolVersion,
      },
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
      ...(tier0.store
        ? {
          store: {
            seeds: tier0.store.seedsRun,
            seedsMeasured: tier0.store.seedsRun - tier0.store.unreflectable.length,
            agreeWithText: tier0.store.agreeWithText,
            agreeWithOracle: tier0.store.agreeWithOracle,
            reflectedFactsTotal: tier0.store.reflectedFactsTotal,
            emptyStoreControlsPassed: tier0.store.emptyStoreControlsPassed,
            storeModeConfirmed: tier0.store.storeModeConfirmed,
            unreflectable: tier0.store.unreflectable.map((u) => ({
              seed: u.seed, ecode: u.unreflectable, detail: u.unreflectableDetail, program: u.program,
            })),
            refusalControlCode: tier0.store.refusalControlCode,
            divergences: tier0.store.divergences.map((d) => ({
              seed: d.seed, program: d.program,
              reflectedFacts: d.reflectedFacts, modeConfirmed: d.modeConfirmed, emptyStoreRows: d.emptyStoreRows,
              diffVsText: d.diffVsText, diffVsOracle: d.diffVsOracle,
              witnessFailed: d.witnessFailed, whynotFailed: d.whynotFailed,
              v0Set: d.v0Set, textSet: d.textSet, storeSet: d.storeSet,
            })),
            witnessChecks: { passed: tier0.store.witnessChecked - tier0.store.witnessFailed, failed: tier0.store.witnessFailed },
            whynotChecks: { passed: tier0.store.whynotChecked - tier0.store.whynotFailed, failed: tier0.store.whynotFailed },
          },
        }
        : {}),
    },
    tier1,
    expectedVsFound: joinExpectations(tier1, tier0),
    discoveredEngineFindings: [
      'F1 FIXED (was: RFDB `\\+ p(X, _)` — wildcard inside a NEGATED literal — silently returned wrong answers; probe q0(X) :- p0(X), \\+ p2(X, _) with p0(c0). p0(c1). p2(c1,c9). returned {c0, c1}, correct {c0}). Engine fix: the negated branch of join_derived in exec.rs ⟦fn join_derived⟧ now anti-joins existentially over the non-wildcard columns (regression test negated_derived_leg_with_wildcard_is_existential in exec.rs ⟦fn negated_derived_leg_with_wildcard_is_existential⟧). The translator\'s aux-predicate projection workaround is REMOVED — negated wildcards go to the wire as-is.',
      'F2 FIXED (was: a body literal over a predicate with NO facts and NO rules gave no response past the 30s EvalLimits deadline — a debug_assert in the stratifier panicked and killed the DEBUG-build connection thread; that assert no longer exists, so there is nothing left to cite). Engine fix: the debug_assert removed, unknown predicate = legal empty relation; deadline abort pinned by the regression test unknown_predicate_leg_expired_deadline_aborts_with_e_exec_001 in exec.rs ⟦fn unknown_predicate_leg_expired_deadline_aborts_with_e_exec_001⟧. The translator\'s empty-predicate elimination workaround is REMOVED — unknown predicates go to the wire as-is.',
      'F3 FIXED (was: a fully-ground body literal in a multi-literal rule tripped E-PLAN-003 after planner reordering; q0(X) :- p0(X), p1("c1","c2"). rejected). Engine fix: shares_no_binding in plan.rs ⟦fn shares_no_binding⟧ treats an empty bound set as "preceding legs were filters", so a ground probe is safe in any position (regression test ground_probe_leg_is_safe_in_any_position in plan.rs ⟦fn ground_probe_leg_is_safe_in_any_position⟧). The translator\'s ground-body-literal rejection is REMOVED; the structural cross-join guard for genuinely disconnected generators remains.',
      'executeDatalog "first rule head" includes ground FACTS (a fact is a bodyless rule): the target predicate\'s first RULE must be hoisted above all facts or the response is the first fact\'s relation with empty bindings. (Wire-protocol dialect rule, NOT a bug — the translator keeps the hoist.)',
    ],
  });
}

export function writeReports(report: Report): { jsonPath: string; mdPath: string; metaPath: string; runId: string } {
  const jsonPath = path.join(REPO, RUN_OUTPUTS[0]);
  fs.writeFileSync(jsonPath, assertNoAnchors(JSON.stringify(report, null, 2), jsonPath) + '\n');

  // Run identity lives in the sidecar so the report file itself is
  // byte-reproducible evidence (same seeds + same commit ⇒ same bytes).
  const metaPath = path.join(REPO, RUN_OUTPUTS[1]);
  const runId = `rofl-conformance-${Date.now()}`;
  fs.writeFileSync(metaPath, JSON.stringify({ run_id: runId, timestamp: new Date().toISOString() }, null, 2) + '\n');

  const mdPath = path.join(REPO, RUN_OUTPUTS[2]);
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
  lines.push(`- oracle: ROFL v0 vendored at \`${report.engines.v0.rev}\` (main); subject: rfdb-server ${report.engines.rfdb.serverVersion} (protocol v${report.engines.rfdb.protocolVersion}, derive engine, repo \`${report.engines.rfdb.gitSha.slice(0, 12)}${report.engines.rfdb.dirtyTree ? '-dirty' : ''}\`, binary sha256 \`${report.engines.rfdb.binarySha256.slice(0, 12)}\`)`);
  lines.push(`- a RED verdict is a SUCCESS of the harness: it is a machine-readable migration-roadmap entry, not a failure. Harness failures are crashes, fake greens, silent skips — gated by the oracle self-check (30/30 must pass on vendored v0) and the scenario-count check.`);
  lines.push('');
  lines.push('## Tier-0 — 120-seed TS↔RFDB differential (common subset)');
  lines.push('');
  lines.push(`- seeds run: **${report.tier0.seeds}** (75% positive, 25% stratified negation with boot preloaded on the v0 side)`);
  lines.push(`- fact-set divergences: **${report.tier0.divergences.length}**`);
  lines.push(stripAnchors(`- why (positive) witness spot-checks: **${report.tier0.witnessChecks.passed} passed / ${report.tier0.witnessChecks.failed} failed** (existence + body ⊆ v0 fact set; deliberately NOT tree identity — v0 stores only the first witness per fact, store.ts:127 ⟦if (!this.witnesses.has(key)) this.witnesses.set(key, w);⟧, and witness choice is mode-dependent, LIMITS.md:48 ⟦and seminaive agree on results⟧; tree-shape parity remains RED missing:whynot-shape)`));
  lines.push(`- whynot (negative) gap spot-checks: **${report.tier0.whynotChecks.passed} passed / ${report.tier0.whynotChecks.failed} failed** (≤5 absent ground tuples per seed over rule-bearing rels: v0 whynot must NOT hold, RFDB explainDatalogGap witness must EXIST, satisfied premises ⊆ v0 fact set, failing predicate must be a program predicate; demo-tree parity stays RED missing:whynot-shape)`);
  lines.push('');
  if (report.tier0.divergences.length > 0) {
    lines.push('### DIVERGENCES (engine disagreement — investigate, never recode as RED)');
    lines.push('```json');
    lines.push(JSON.stringify(report.tier0.divergences, null, 2));
    lines.push('```');
    lines.push('');
  }
  const st = report.tier0.store;
  if (st) {
    lines.push('## Tier-0 rules-from-store — the same seeds answered with the rules read out of the database');
    lines.push('');
    lines.push(`- seeds run: **${st.seeds}**; carried whole by Projection T: **${st.seedsMeasured}**; refused on the merits (not reflectable, NOT a divergence): **${st.seeds - st.seedsMeasured}** — the refusal path is live, a deliberately unreflectable control program came back \`${st.refusalControlCode}\``);
    if (st.seedsMeasured !== st.seeds || st.seeds !== report.tier0.seeds) {
      lines.push(`- ⚠ **DENOMINATOR SHORTFALL** — the ratios below are over ${st.seedsMeasured} seeds, not the ${report.tier0.seeds} the text pass ran. The verdict \`exp_rules_from_store_agrees\` is RED for this reason alone: a shrinking denominator keeps a ratio green while it measures less and less.`);
    }
    lines.push(`- **same answer with rules from the store as with rules from the text: ${st.agreeWithText} / ${st.seedsMeasured}**`);
    lines.push(`- same answer as the ROFL v0 oracle: **${st.agreeWithOracle} / ${st.seedsMeasured}**`);
    lines.push(`- rule-facts written by reflection: **${st.reflectedFactsTotal}**`);
    lines.push(`- why witness spot-checks: **${st.witnessChecks.passed} passed / ${st.witnessChecks.failed} failed**; whynot gap spot-checks: **${st.whynotChecks.passed} passed / ${st.whynotChecks.failed} failed** — the same checks the text pass runs, so the explain surface is measured out of the store too`);
    lines.push(`- anti-silence controls passed: **${st.emptyStoreControlsPassed} / ${st.seeds}** seeds answered ZERO rows to the same selectors before anything was reflected, and **${st.storeModeConfirmed} / ${st.seedsMeasured}** had the server read the rule source back as \`store\` before being asked`);
    lines.push('- anti-silence: each seed gets a FRESH database, and before anything is reflected the very selectors used to ask the questions are run against it in store mode and must return zero rows. A seed whose reflection wrote no facts, whose mode did not read back `store`, or whose answer after reflection is empty, stops the run as a harness gap instead of counting as agreement — two silences are not a match.');
    lines.push('');
    if (st.unreflectable.length > 0) {
      lines.push('### Not reflectable (refused on the merits — their own category)');
      lines.push('```json');
      lines.push(JSON.stringify(st.unreflectable, null, 2));
      lines.push('```');
      lines.push('');
    }
    if (st.divergences.length > 0) {
      lines.push('### STORE DIVERGENCES (rules from the store answered differently)');
      lines.push('```json');
      lines.push(JSON.stringify(st.divergences, null, 2));
      lines.push('```');
      lines.push('');
    }
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
  fs.writeFileSync(mdPath, assertNoAnchors(lines.join('\n'), mdPath));
  return { jsonPath, mdPath };
}
