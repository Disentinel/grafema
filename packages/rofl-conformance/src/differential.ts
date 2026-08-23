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

  // Witness spot-check: ≤5 derived facts (dump ∖ program ground facts) —
  // existence + body-soundness, NOT tree identity (v0 first-witness-only,
  // store.ts:127 ⟦if (!this.witnesses.has(key)) this.witnesses.set(key, w);⟧;
  // witness choice is mode-dependent, LIMITS.md:48 ⟦and seminaive agree on results⟧)
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
  if (result.witnessFailed.length > 0) result.diverged = true;

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
  if (result.whynotFailed.length > 0) result.diverged = true;
  return result;
}

export interface Tier0Summary {
  seedsRun: number;
  divergences: SeedResult[];
  witnessChecked: number;
  witnessFailed: number;
  whynotChecked: number;
  whynotFailed: number;
}

export async function runTier0(ctx: SeedContext, nSeeds: number): Promise<Tier0Summary> {
  const positive = Math.round(nSeeds * 0.75);
  const summary: Tier0Summary = {
    seedsRun: 0, divergences: [],
    witnessChecked: 0, witnessFailed: 0,
    whynotChecked: 0, whynotFailed: 0,
  };
  for (let seed = 1; seed <= nSeeds; seed++) {
    const prog = generateProgram(seed, positive);
    const res = await runSeedDifferential(prog, ctx);
    summary.seedsRun++;
    summary.witnessChecked += res.witnessChecked;
    summary.witnessFailed += res.witnessFailed.length;
    summary.whynotChecked += res.whynotChecked;
    summary.whynotFailed += res.whynotFailed.length;
    if (res.diverged) summary.divergences.push(res);
  }
  return summary;
}
