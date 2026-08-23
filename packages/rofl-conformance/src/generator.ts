// generator.ts — seeded random tier-0 programs. LCG + shape ported from the
// v0 differential generator (phase2.test.ts:21-54: rels p0-p3, arity 1-2,
// consts c0-c5, 8-19 facts, 3-7 rules, 1-3 premises) with TWO constraints the
// v0 generator lacks, both required by the RFDB planner (design tier0_subset):
//
//  (a) RANGE-RESTRICTED DISTINCT-VAR HEADS — every head arg is a distinct
//      variable bound by a positive premise (RANGE RESTRICTION is the real
//      constraint: v0 tolerates unsafe heads via demand mode, RFDB has none.
//      DISTINCTNESS is kept for SEED STABILITY only — a repeated head variable
//      is legal on both engines and they agree on it tuple-for-tuple, pinned by
//      wire-smoke's 'repeated head variable agrees with v0 row-for-row', but
//      relaxing it would change every seed's byte-identical program text);
//  (b) CONNECTED BODIES with ≥1 named variable per premise — premise j>0
//      reuses ≥1 already-bound variable (RFDB E-PLAN-003 structural cross-join
//      guard; ≥1 named var per premise is kept for SEED STABILITY — the F3
//      planner fix made variable-free filter legs legal, but changing the
//      constraint would change every seed's byte-identical program text).
//
// Seeds 1..90: positive programs. Seeds 91..120: + a stratified-by-construction
// negation layer q0-q2 negating only strictly-lower p-relations (port of
// phase2.test.ts:74-100, same `, _` arity pad). Same seed ⇒ byte-identical text.

export interface GeneratedProgram {
  seed: number;
  text: string;
  arity: Map<string, number>;
  hasNegation: boolean;
  rels: string[];
}

export const POSITIVE_SEEDS = 90;
export const NEGATION_SEEDS = 30;

/** LCG ported verbatim from phase2.test.ts:13-19. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function generateProgram(seed: number, totalPositive: number = POSITIVE_SEEDS): GeneratedProgram {
  const hasNegation = seed > totalPositive;
  const rnd = lcg(seed || 1);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const rels = ['p0', 'p1', 'p2', 'p3'];
  const arity = new Map(rels.map((r) => [r, 1 + Math.floor(rnd() * 2)]));
  const consts = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
  const lines: string[] = [];
  const nFacts = 8 + Math.floor(rnd() * 12);
  for (let i = 0; i < nFacts; i++) {
    const rel = pick(rels);
    const args = Array.from({ length: arity.get(rel)! }, () => pick(consts));
    lines.push(`${rel}(${args.join(', ')}).`);
  }
  const nRules = 3 + Math.floor(rnd() * 5);
  for (let i = 0; i < nRules; i++) {
    const nPrems = 1 + Math.floor(rnd() * 3);
    const vars = ['X', 'Y', 'Z', 'W'];
    const prems: { rel: string; args: string[] }[] = [];
    // bound = variables ACTUALLY present in the premises placed so far
    // (recomputed from final args — a fix-up may overwrite a drawn var)
    const boundOf = (): string[] => [...new Set(prems.flatMap((p) => p.args.filter((a) => vars.includes(a))))];
    for (let j = 0; j < nPrems; j++) {
      const rel = pick(rels);
      const args = Array.from({ length: arity.get(rel)! }, () => {
        if (rnd() < 0.7) return pick(vars);
        return pick(consts);
      });
      // constraint (b): every premise carries ≥1 named variable, and premise
      // j>0 shares ≥1 variable with the accumulated bound set
      const argVars = args.filter((a) => vars.includes(a));
      if (j === 0) {
        if (argVars.length === 0) args[0] = pick(vars);
      } else {
        const bound = boundOf();
        const connected = argVars.some((a) => bound.includes(a));
        if (!connected || argVars.length === 0) {
          args[0] = pick(bound);
        }
      }
      prems.push({ rel, args });
    }
    const bodyVars = prems.flatMap((p) => p.args.filter((a) => vars.includes(a)));
    // constraint (a): head = distinct bound variables only; repick the head
    // rel deterministically if its arity exceeds the distinct-var supply, and
    // if NO rel fits (all arity 2, one distinct body var), deterministically
    // widen a premise by turning a const/duplicate-var slot into a fresh var
    let distinct = [...new Set(bodyVars)];
    let headRel = pick(rels);
    if (arity.get(headRel)! > distinct.length) {
      let fitting = rels.filter((r) => arity.get(r)! <= distinct.length);
      while (fitting.length === 0) {
        // pass 1: a constant slot (safe: adds a var without removing any link);
        // pass 2: a WITHIN-premise duplicate var slot (the premise keeps its
        // other occurrence, so cross-premise connectivity is preserved)
        let widened = false;
        const fresh = vars.find((v) => !distinct.includes(v))!;
        outer: for (const pass of [1, 2]) {
          for (const p of prems) {
            for (let k = 0; k < p.args.length; k++) {
              const a = p.args[k];
              const constSlot = !vars.includes(a);
              const withinDup = vars.includes(a) && p.args.filter((x) => x === a).length > 1;
              if ((pass === 1 && constSlot) || (pass === 2 && withinDup)) {
                p.args[k] = fresh;
                bodyVars.push(fresh);
                distinct = [...new Set(bodyVars)];
                widened = true;
                break outer;
              }
            }
          }
        }
        if (!widened) throw new Error(`generator invariant: cannot widen rule (seed ${seed})`);
        fitting = rels.filter((r) => arity.get(r)! <= distinct.length);
      }
      headRel = fitting[Math.floor(rnd() * fitting.length)];
    }
    const headArgs: string[] = [];
    const pool = distinct.slice();
    for (let k = 0; k < arity.get(headRel)!; k++) {
      const idx = Math.floor(rnd() * pool.length);
      headArgs.push(pool[idx]);
      pool.splice(idx, 1);
    }
    lines.push(`${headRel}(${headArgs.join(', ')}) :- ${prems.map((p) => `${p.rel}(${p.args.join(', ')})`).join(', ')}.`);
  }
  const outRels = rels.slice();
  if (hasNegation) {
    // port of phase2.test.ts:80-90 (negation layer over a distinct LCG stream)
    const rnd2 = lcg(seed * 7919);
    const pick2 = <T>(xs: T[]): T => xs[Math.floor(rnd2() * xs.length)];
    const pad = (rel: string): string => (arity.get(rel)! === 2 ? ', _' : '');
    for (let i = 0; i < 3; i++) {
      const posRel = pick2(['p0', 'p1']);
      const negRel = pick2(['p2', 'p3']);
      lines.push(`q${i}(X) :- ${posRel}(X${pad(posRel)}), not ${negRel}(X${pad(negRel)}).`);
      arity.set(`q${i}`, 1);
      if (!outRels.includes(`q${i}`)) outRels.push(`q${i}`);
    }
  }
  return { seed, text: lines.join('\n'), arity, hasNegation, rels: outRels };
}
