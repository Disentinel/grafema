// scenarios.ts — the 29 v0 tests ported 1:1 (assertion literals verbatim from
// the four phase files, each with file:line provenance) + one boot.rofl-load
// scenario = 30. Each scenario runs UNCHANGED against the oracle (vendored v0,
// PASS 1 self-check) and the subject (RfdbRofl adapter, PASS 2 verdicts); the
// only sanctioned re-point is the two phase2 differential scenarios, which by
// design substitute "naive ≡ seminaive" with "v0 ≡ RFDB" in subject mode (the
// naive flag is engine-internal and not fact-set-observable, LIMITS.md:48).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseProgram } from './neutral.ts';
import { OracleEngine } from './oracle.ts';
import { generateProgram } from './generator.ts';
import { runSeedDifferential, type SeedContext } from './differential.ts';
import { BOOT, SENSORS, COUNTER, TM, TM_DIV } from './fixtures.ts';

/** Duck-typed engine surface: OracleEngine (sync) or RfdbRofl (async).
 *  Scenario code awaits every call, which is a no-op for sync values. */
export type Engine = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};

export interface Ctx {
  /** Construct the engine under test (oracle in PASS 1, adapter in PASS 2). */
  mk(opts?: { naive?: boolean }): Engine;
  /** Restore the engine under test from a v0 snapshot. */
  fromSnapshot(json: string, opts?: { naive?: boolean }): Engine;
  /** Always the vendored v0 engine (differential reference side). */
  mkOracle(opts?: { naive?: boolean }): OracleEngine;
  /** Tier-0 differential context in subject mode; null in oracle mode. */
  seedCtx: SeedContext | null;
}

export interface Scenario {
  id: string;
  sourceRef: string;
  run(ctx: Ctx): Promise<void>;
}

const TC = `
edge(a, b). edge(b, c). edge(c, d).
path(X, Y) :- edge(X, Y).
path(X, Y) :- edge(X, Z), path(Z, Y).
`;

// phase4.test.ts:57-81 — independent TS busy-beaver simulation, verbatim
function simulateTM(deltas: Record<string, [string, number, string]>, maxSteps: number) {
  const tape = new Map<number, number>();
  let pos = 0, state = 'a', steps = 0;
  while (state !== 'halt' && steps < maxSteps) {
    const sym = tape.get(pos) ?? 0;
    const d = deltas[state + sym];
    if (!d) break;
    const [s2, w, dir] = d;
    tape.set(pos, w);
    pos += dir === 'r' ? 1 : -1;
    state = s2;
    steps++;
  }
  const ones = [...tape.values()].filter((v) => v === 1).length;
  const positions = [...tape.keys()];
  const lo = Math.min(...positions), hi = Math.max(...positions);
  const listOf = (xs: number[]) => xs.reduceRight((acc, x) => `cons(${x},${acc})`, 'nil');
  const left: number[] = [];
  for (let i = pos - 1; i >= lo; i--) left.push(tape.get(i) ?? 0);
  const right: number[] = [];
  for (let i = pos + 1; i <= hi; i++) right.push(tape.get(i) ?? 0);
  const head = tape.get(pos) ?? 0;
  return { state, steps, ones, tapeTerm: `tape(${listOf(left)},${head},${listOf(right)})` };
}

export const SCENARIOS: Scenario[] = [
  // ───────────────────────── phase 1 ─────────────────────────
  {
    id: 'p1-tc-seminaive',
    sourceRef: 'test/phase1.test.ts:12',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(TC)).ok, true);
      const rows = (await r.query('path(X, Y)')).rows.map((x: { text: string }) => x.text);
      assert.deepEqual(rows, [
        'X = a, Y = b', 'X = a, Y = c', 'X = a, Y = d',
        'X = b, Y = c', 'X = b, Y = d', 'X = c, Y = d',
      ]);
    },
  },
  {
    id: 'p1-tc-naive',
    sourceRef: 'test/phase1.test.ts:22',
    async run(ctx) {
      const r = ctx.mk({ naive: true });
      assert.equal((await r.load(TC)).ok, true);
      assert.equal((await r.query('path(X, Y)')).rows.length, 6);
      assert.equal(await r.holds('path(a, d)'), true);
      assert.equal(await r.holds('path(d, a)'), false);
    },
  },
  {
    id: 'p1-functor-append',
    sourceRef: 'test/phase1.test.ts:30',
    async run(ctx) {
      const r = ctx.mk();
      const ok = await r.load(`
        app(nil, Ys, Ys) :- Ys = Ys.
        app(cons(H, T), Ys, cons(H, Zs)) :- app(T, Ys, Zs).
      `);
      assert.equal(ok.ok, true);
      const q = await r.query('app(cons(1, cons(2, nil)), cons(3, nil), Z)');
      assert.deepEqual(q.rows.map((x: { text: string }) => x.text), ['Z = cons(1,cons(2,cons(3,nil)))']);
      await r.assert('pair(cons(1, nil), cons(2, nil)).');
      await r.assert('joined(Z) :- pair(X, Y), app(X, Y, Z).');
      assert.deepEqual((await r.query('joined(Z)')).rows.map((x: { text: string }) => x.text), ['Z = cons(1,cons(2,nil))']);
    },
  },
  {
    id: 'p1-async-reject',
    sourceRef: 'test/phase1.test.ts:45',
    async run(ctx) {
      const r = ctx.mk();
      const res = await r.load('later(1) @async.');
      assert.equal(res.ok, false);
      assert.match(res.diagnostics.join(' '), /not in v0/);
    },
  },
  {
    id: 'p1-next-body-reject',
    sourceRef: 'test/phase1.test.ts:52',
    async run(ctx) {
      const r = ctx.mk();
      const res = await r.load('a(X) :- b(X) @next.');
      assert.equal(res.ok, false);
    },
  },
  {
    id: 'p1-arith',
    sourceRef: 'test/phase1.test.ts:58',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(`
        n(7). n(10).
        m(X, Y) :- n(X), Y is X mod 3.
        big(X) :- n(X), X >= 10.
        neg(X, Y) :- n(X), Y is 0 - X, Y <= -7.
      `);
      assert.deepEqual((await r.query('m(X, Y)')).rows.map((x: { text: string }) => x.text), ['X = 10, Y = 1', 'X = 7, Y = 1']);
      assert.deepEqual((await r.query('big(X)')).rows.map((x: { text: string }) => x.text), ['X = 10']);
      assert.deepEqual((await r.query('neg(7, Y)')).rows.map((x: { text: string }) => x.text), ['Y = -7']);
    },
  },
  // ───────────────────────── phase 2 ─────────────────────────
  {
    id: 'p2-diff-positive',
    sourceRef: 'test/phase2.test.ts:63 (re-pointed per design: naive≡seminaive → v0≡RFDB; oracle mode runs the FULL 120 positive seeds of the original, subject mode the 90 positive seeds of the tier-0 75/25 split)',
    async run(ctx) {
      if (ctx.seedCtx === null) {
        // oracle self-check: the original naive ≡ seminaive differential at
        // the referenced test's full strength — 120 positive seeded programs
        for (let seed = 1; seed <= 120; seed++) {
          const prog = generateProgram(seed, 120);
          const a = ctx.mkOracle({ naive: false });
          const b = ctx.mkOracle({ naive: true });
          assert.equal(a.load(prog.text).ok, true, `seed ${seed} seminaive load`);
          assert.equal(b.load(prog.text).ok, true, `seed ${seed} naive load`);
          assert.deepEqual(a.domainFactSet(), b.domainFactSet(), `seed ${seed} diverged`);
        }
      } else {
        for (let seed = 1; seed <= 90; seed++) {
          const prog = generateProgram(seed);
          const res = await runSeedDifferential(prog, ctx.seedCtx);
          assert.equal(res.diverged, false, `seed ${seed} diverged: ${JSON.stringify(res.diff)}`);
        }
      }
    },
  },
  {
    id: 'p2-diff-negation',
    sourceRef: 'test/phase2.test.ts:74 (re-pointed per design: naive≡seminaive → v0≡RFDB)',
    async run(ctx) {
      const bootR = new OracleEngine();
      assert.equal(bootR.load(BOOT).ok, true);
      const bootSnap = bootR.save();
      let qFactsSeen = 0;
      for (let seed = 91; seed <= 120; seed++) {
        const prog = generateProgram(seed);
        assert.equal(prog.hasNegation, true);
        if (ctx.seedCtx === null) {
          const a = OracleEngine.fromSnapshot(bootSnap, { naive: false });
          const b = OracleEngine.fromSnapshot(bootSnap, { naive: true });
          assert.equal(a.load(prog.text).ok, true, `seed ${seed} seminaive load`);
          assert.equal(b.load(prog.text).ok, true, `seed ${seed} naive load`);
          assert.deepEqual(a.domainFactSet(), b.domainFactSet(), `seed ${seed} diverged`);
          qFactsSeen += a.factKeys().filter((k) => bootRelOfKey(k).startsWith('q')).length;
        } else {
          const res = await runSeedDifferential(prog, ctx.seedCtx);
          assert.equal(res.diverged, false, `seed ${seed} diverged: ${JSON.stringify(res.diff)}`);
          qFactsSeen += res.v0Set.filter((l) => l.startsWith('q')).length;
        }
      }
      assert.ok(qFactsSeen > 0, 'negation layer actually derived facts');
    },
  },
  {
    id: 'p2-why-tree',
    sourceRef: 'test/phase2.test.ts:102',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(`
        edge(a, b). edge(b, c).
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge(X, Z), path(Z, Y).
      `);
      const w = await r.why('path(a, c)');
      assert.equal(w.ok, true);
      const lines = w.text.split('\n');
      assert.match(lines[0], /^path\[main\]\(a,c\)\s+<= r[0-9a-f]{8} @tick 0$/);
      const leaves = lines.filter((l: string) => l.includes('[axiom]'));
      assert.ok(leaves.length >= 2, 'tree must bottom out in EDB axioms');
      for (const l of leaves) assert.match(l, /edge\[main\]/);
    },
  },
  {
    id: 'p2-persp-isolation',
    sourceRef: 'test/phase2.test.ts:118',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(`
        secret[vault](s1).
        spy(X) :- secret[open](X).
        honest(X) :- secret[vault](X).
      `);
      assert.deepEqual((await r.query('spy(X)')).rows, []);
      assert.deepEqual((await r.query('honest(X)')).rows.map((x: { text: string }) => x.text), ['X = s1']);
    },
  },
  {
    id: 'p2-stratum-order',
    sourceRef: 'test/phase2.test.ts:129',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      assert.equal((await r.load(`
        node(a). node(b). node(c).
        edge(a, b).
        linked(X) :- edge(X, Y).
        linked(Y) :- edge(X, Y).
        isolated(X) :- node(X), not linked(X).
      `)).ok, true);
      assert.deepEqual((await r.query('isolated(X)')).rows.map((x: { text: string }) => x.text), ['X = c']);
      const stratumFacts = await r.query('stratum(isolated, N)');
      const levels = stratumFacts.rows.map((x: { bindings: Record<string, string> }) => parseInt(x.bindings['N'], 10));
      assert.ok(levels.includes(1), 'boot rules must derive stratum(isolated, 1)');
      const plan = await r.strataPlan();
      const iso = plan.find((p: { rel: string }) => p.rel === 'isolated');
      assert.ok(iso, 'isolated rule present in plan');
      assert.equal(iso!.level, Math.max(...levels), 'engine level == max stratum fact');
    },
  },
  {
    id: 'p2-noboot-null-plan',
    sourceRef: 'test/phase2.test.ts:150',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(`
        node(a). edge(a, a).
        linked(X) :- edge(X, Y).
        isolated(X) :- node(X), not linked(X).
      `);
      const plan = await r.strataPlan();
      assert.equal(plan.find((p: { rel: string }) => p.rel === 'isolated')!.level, null);
    },
  },
  {
    id: 'p2-unstrat-reject',
    sourceRef: 'test/phase2.test.ts:161',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      const res = await r.load(`
        e(1).
        p(X) :- e(X), not p(X).
      `, { budget: 5000 });
      assert.equal(res.ok, false);
      assert.match(res.diagnostics.join('\n'), /unstratified\[main\]\(p\)/);
      assert.match(res.diagnostics.join('\n'), /dep_neg/);
      assert.equal(await r.holds('e(1)'), false);
      assert.deepEqual((await r.query('unstratified(X)')).rows, []);
    },
  },
  {
    id: 'p2-derived-by',
    sourceRef: 'test/phase2.test.ts:176',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(`
        edge(a, b). edge2(a, b).
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge2(X, Y).
      `);
      await r.evaluate();
      const db = await r.query('derived_by(F, R, T)');
      assert.ok(db.rows.length >= 2, 'derived_by facts present');
      assert.ok(db.rows.some((x: { bindings: Record<string, string> }) => x.bindings['F'].includes('path')), 'names the fact');
      assert.equal(await r.supportCount('path[main](a,b)'), 2);
    },
  },
  // ───────────────────────── phase 3 ─────────────────────────
  {
    id: 'p3-kernel-grep',
    sourceRef: 'test/phase3.test.ts:14',
    async run(ctx) {
      const r = ctx.mk();
      const violations = await r.kernelVocabularyCheck();
      assert.deepEqual(violations, [], violations.map((v: { file: string; line: number; what: string }) => `${v.file}:${v.line}: ${v.what}`).join('\n'));
    },
  },
  {
    id: 'p3-runtime-rule',
    sourceRef: 'test/phase3.test.ts:19',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(BOOT);
      await r.assert('edge(a, b).');
      await r.assert('edge(b, c).');
      assert.deepEqual((await r.query('path(X, Y)')).rows, []);
      await r.assert('path(X, Y) :- edge(X, Y).');
      await r.assert('path(X, Y) :- edge(X, Z), path(Z, Y).');
      assert.equal(await r.holds('path(a, c)'), true);
      const ids = (await r.query('concludes(R, path)')).rows.map((x: { bindings: Record<string, string> }) => x.bindings['R']);
      assert.equal(ids.length, 2);
      for (const id of ids) {
        assert.equal(await r.holds(`rule(${id})`), true);
        assert.equal(await r.holds(`has_premise(${id}, 1)`), true);
      }
    },
  },
  {
    id: 'p3-write-protected',
    sourceRef: 'test/phase3.test.ts:38',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(BOOT);
      const res = await r.load('derived_by(X, r0, 0) :- anything(X).');
      assert.equal(res.ok, false);
      assert.match(res.diagnostics.join(' '), /write-protected/);
    },
  },
  {
    id: 'p3-breach',
    sourceRef: 'test/phase3.test.ts:46',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(BOOT);
      await r.assert('concludes(rbad, derived_by).');
      assert.deepEqual((await r.query('breach[audit](R)')).rows.map((x: { text: string }) => x.text), ['R = rbad']);
    },
  },
  {
    id: 'p3-malformed-sibling',
    sourceRef: 'test/phase3.test.ts:55',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      assert.deepEqual((await r.query('malformed[audit](R)')).rows, []);
      const malformedRules = (await r.query('concludes(R, malformed)')).rows.map((x: { bindings: Record<string, string> }) => x.bindings['R']);
      assert.equal(malformedRules.length, 2);
      let m2: string | undefined;
      for (const id of malformedRules) {
        if (await r.holds(`premise_pos(${id}, has_premise)`)) m2 = id;
      }
      const m1 = malformedRules.find((id: string) => id !== m2)!;
      assert.ok(m2 && m1);
      assert.equal((await r.retract(`has_premise(${m2}, 1)`)).ok, true);
      assert.equal((await r.retract(`has_premise(${m2}, 2)`)).ok, true);
      assert.deepEqual((await r.query('malformed[audit](R)')).rows.map((x: { text: string }) => x.text), [`R = ${m2}`]);
      const why = await r.why(`malformed[audit](${m2})`);
      assert.equal(why.ok, true);
      assert.match(why.text.split('\n')[0], new RegExp(`<= ${m1} `), 'condemned by the sibling, not itself');
    },
  },
  {
    id: 'p3-snapshot-roundtrip',
    sourceRef: 'test/phase3.test.ts:75',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      assert.equal((await r.load(SENSORS)).ok, true);
      await r.evaluate();
      const here = {
        temp: (await r.query('temp[verified](t1, V)')).rows.map((x: { text: string }) => x.text),
        outlier: (await r.query('outlier[trust](S)')).rows.map((x: { text: string }) => x.text),
        state: await r.canonicalState(),
      };
      const snapFile = path.join('/tmp', `.rofl-conf-roundtrip-${process.pid}.snapshot.json`);
      fs.writeFileSync(snapFile, await r.save());
      try {
        const out = execFileSync(process.execPath, [
          '--experimental-strip-types', '--no-warnings',
          path.resolve(path.dirname(new URL(import.meta.url).pathname), 'roundtrip-child.ts'), snapFile,
        ], { encoding: 'utf8' });
        const child = JSON.parse(out);
        assert.deepEqual(child.temp, here.temp);
        assert.deepEqual(child.outlier, here.outlier);
        assert.equal(child.state, here.state, 'bit-identical canonical state across processes');
      } finally {
        fs.rmSync(snapFile, { force: true });
      }
    },
  },
  // ───────────────────────── phase 4 ─────────────────────────
  {
    id: 'p4-counter',
    sourceRef: 'test/phase4.test.ts:19',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      assert.equal((await r.load(COUNTER)).ok, true);
      const collected: string[] = [];
      const res = await r.run({ maxTicks: 50, onBoundary: (x: Engine) => {
        for (const row of x.query('emit(N)').rows) collected.push(row.bindings['N']);
      } });
      assert.deepEqual(collected, ['1', '2', '3', '4', '5']);
      assert.equal(res.quiescent, true, 'reaches a silent fixpoint');
      assert.equal(res.partial, false);
      assert.equal(res.ticks, 5, 'world is empty and stable at tick 5');
    },
  },
  {
    id: 'p4-replay',
    sourceRef: 'test/phase4.test.ts:34',
    async run(ctx) {
      const clauses = parseProgram(BOOT + '\n' + SENSORS);
      const states = new Set<string>();
      for (let seed = 1; seed <= 100; seed++) {
        let s = seed;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
        const shuffled = [...clauses];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const r = ctx.mk();
        const res = await r.assertClauses(shuffled);
        assert.deepEqual(res.diagnostics, []);
        await r.evaluate();
        states.add(await r.canonicalState());
      }
      assert.equal(states.size, 1, 'every insertion order yields the same bits');
    },
  },
  {
    id: 'p4-tm',
    sourceRef: 'test/phase4.test.ts:83',
    async run(ctx) {
      const sim = simulateTM({
        a0: ['b', 1, 'r'], a1: ['c', 1, 'l'],
        b0: ['a', 1, 'l'], b1: ['b', 1, 'r'],
        c0: ['b', 1, 'l'], c1: ['halt', 1, 'r'],
      }, 1000);
      assert.equal(sim.state, 'halt');
      assert.equal(sim.ones, 6, 'Sigma(3) = 6');
      assert.equal(sim.steps, 13);

      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      assert.equal((await r.load(TM)).ok, true);
      const res = await r.run({ maxTicks: 100 });
      assert.equal(res.quiescent, true);
      assert.equal(res.partial, false);
      assert.equal(res.ticks, sim.steps, 'one tick per TM step');
      const cfg = await r.query('cfg(halt, T)');
      assert.deepEqual(cfg.rows.map((x: { bindings: Record<string, string> }) => x.bindings['T']), [sim.tapeTerm]);
    },
  },
  {
    id: 'p4-tm-diverge',
    sourceRef: 'test/phase4.test.ts:104',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      assert.equal((await r.load(TM_DIV)).ok, true);
      const res = await r.run({ maxTicks: 1_000_000, budget: 3000 });
      assert.equal(res.partial, true, 'diverging program must yield a partial run');
      const holes = await r.query('hole(Q, Reason)');
      assert.ok(holes.rows.length >= 1);
      assert.match(holes.rows[0].text, /budget_exhausted/);
      const trace = (await r.query('derived_by(F, R, T)')).rows.filter((x: { bindings: Record<string, string> }) => x.bindings['F'].startsWith('$fact(cfg'));
      assert.ok(trace.length >= 3, 'cfg trajectory queryable after exhaustion');
    },
  },
  {
    id: 'p4-boot-audits',
    sourceRef: 'test/phase4.test.ts:119',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      assert.deepEqual((await r.query('unstratified(X)')).rows, []);
      assert.deepEqual((await r.query('malformed[audit](R)')).rows, []);
      assert.deepEqual((await r.query('breach[audit](R)')).rows, []);
      assert.deepEqual((await r.query('leak[audit](A, B)')).rows, []);
      const wn = await r.whynot('unstratified(reach)');
      assert.equal(wn.holds, false);
      assert.match(wn.text, /dep_neg\[main\]\(reach/, 'demonstration goes through dep/reach');
      assert.ok(wn.text.split('\n').length < 20, 'finite demonstration');
    },
  },
  {
    id: 'p4-sensors',
    sourceRef: 'test/phase4.test.ts:133',
    async run(ctx) {
      const r = ctx.mk();
      assert.equal((await r.load(BOOT)).ok, true);
      assert.equal((await r.load(SENSORS)).ok, true);
      assert.deepEqual((await r.query('temp[verified](t1, V)')).rows.map((x: { text: string }) => x.text), ['V = 20', 'V = 21']);
      const w = await r.why('outlier[trust](s3)');
      assert.equal(w.ok, true);
      assert.match(w.text, /not corroborated\[trust\]\(s3\) \[finite failure\]/);
      assert.match(w.text, /whynot corroborated\[trust\]\(s3\)/);
      assert.match(w.text, /close\[main\]\(95,20\)/);
      const e = await r.excise('reading[s1](t1, 20)');
      assert.equal(e.ok, true);
      assert.ok(e.removed.includes('corroborated[trust](s2)'), 'blast radius reaches s2');
      assert.ok(e.removed.includes('temp[verified](t1,21)'), 'temp loses 21');
      assert.ok(e.added.includes('outlier[trust](s2)'), 's2 becomes an outlier');
      assert.equal(await r.holds('temp[verified](t1, 21)'), true);
      const wn = await r.whynot('corroborated[trust](s3)');
      assert.equal(wn.holds, false);
      assert.match(wn.text, /close\[main\]\(95,20\)/);
      assert.match(wn.text, /close\[main\]\(95,21\)/);
      for (const q of ['unstratified(X)', 'malformed[audit](R)', 'breach[audit](R)', 'leak[audit](A, B)', 'forged[audit](F)', 'unmoded[audit](R)']) {
        assert.deepEqual((await r.query(q)).rows, [], q);
      }
    },
  },
  {
    id: 'p4-excise-multi',
    sourceRef: 'test/phase4.test.ts:169',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(`
        e1(a). e2(a).
        p(X) :- e1(X).
        p(X) :- e2(X).
        q(X) :- p(X).
      `);
      const e = await r.excise('e1(a)');
      assert.equal(e.ok, true);
      assert.deepEqual(e.removed, ['e1[main](a)']);
      assert.deepEqual(e.added, []);
    },
  },
  {
    id: 'p4-forged',
    sourceRef: 'test/phase4.test.ts:185',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(BOOT);
      await r.load(SENSORS);
      assert.deepEqual((await r.query('forged[audit](F)')).rows, []);
      await r.assert('reading[s1](t2, 30).', { who: 'mallory' });
      const f = await r.query('forged[audit](F)');
      assert.equal(f.rows.length, 1);
      assert.match(f.rows[0].text, /\$fact\(reading,s1/);
      await r.assert('reading[s2](t2, 31).', { who: 'sensor_net' });
      assert.equal((await r.query('forged[audit](F)')).rows.length, 1);
    },
  },
  {
    id: 'p4-budget-hole',
    sourceRef: 'test/phase4.test.ts:199',
    async run(ctx) {
      const r = ctx.mk();
      await r.load(`
        n(0).
        n(M) :- n(K), K < 100000, M is K + 1.
      `, { budget: 500 });
      const q = await r.query('n(X)', { budget: 500 });
      assert.equal(q.partial, true, 'partial result, not a hang');
      assert.ok(q.rows.length > 0, 'partial result still returned');
      assert.ok((await r.query('hole(Q, R)')).rows.length >= 1, 'hole emitted');
    },
  },
  // ───────────────────────── boot.rofl ─────────────────────────
  {
    id: 'boot-load',
    sourceRef: 'boot.rofl (design: boot.rofl load through adapter)',
    async run(ctx) {
      const r = ctx.mk();
      const res = await r.load(BOOT);
      assert.equal(res.ok, true, `boot.rofl must load clean: ${res.diagnostics.join(' | ')}`);
      assert.deepEqual((await r.query('unstratified(X)')).rows, []);
    },
  },
];

function bootRelOfKey(key: string): string {
  return key.split('[')[0];
}

export const EXPECTED_SCENARIO_COUNT = 30;
