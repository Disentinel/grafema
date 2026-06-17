/**
 * Resolution-precision marker CONSUMERS (RFD R2 / R4 / R5).
 *
 * Stacks on the R1 primitive (resolutionPrecision.ts). Three coupled pieces,
 * proven against in-memory FixtureStorageView-style backends (~0.0s, no
 * rfdb-server process) whose node/edge shape mirrors the LIVE /tmp/sep-test
 * graph:
 *
 *   R5  traceEffects surfaces a suspected-unsound MARK for the
 *       axios.get → ecma-GLOBAL::get suffix-collapse defect, AND attaches a
 *       per-leaf precision marker — while still recovering the IO via effects-db
 *       (PART A is complementary).
 *   R2  the precision marker is threaded into find_calls (CallInfo.precision)
 *       and the traceEffects result shape (per-leaf + suspected_unsound).
 *   R4  checkResolutionSoundness HARD-FLAGS the unsound resolution as a
 *       violation — caught even though it passes the ≤1-target guarantee — and
 *       maps the three classes onto the soundness taxonomy.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  traceEffects,
  EffectsLookup,
  findCallsInFunction,
  checkResolutionSoundness,
  soundnessOf,
} from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

// ── In-memory backend (mirrors trace-effects.test.js style) ──

function makeBackend(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  return {
    async getNode(id) { return byId.get(id) ?? null; },
    async *queryNodes(filter) {
      for (const n of nodes) {
        if (filter.type && n.type !== filter.type) continue;
        if (filter.name && n.name !== filter.name) continue;
        if (filter.file && n.file !== filter.file) continue;
        yield n;
      }
    },
    async getOutgoingEdges(id, types) {
      return edges.filter(e => e.src === id && (!types || types.includes(e.type)));
    },
    async getIncomingEdges(id, types) {
      return edges.filter(e => e.dst === id && (!types || types.includes(e.type)));
    },
  };
}

// ── Fixture: fetchUser() { axios.get(...); JSON.parse(...); readFile(...); } ──
//
// fetchUser → (AWAITS) → CALL axios.get  → CALLS → GLOBAL::get  (PURE, runtime-globals)
//                                                  + receiver chain to non-relative import "axios"
//          → (CALLS)  → CALL JSON.parse  → CALLS → GLOBAL::JSON.parse (THROW, receiver preserved)
//          → (CALLS)  → CALL readFile    → CALLS → {GLOBAL::readFile, EXT:fs.readFile, IB:readFile}  (fan-out 3)

const RV_GLOBAL = { resolvedVia: 'runtime-globals', globalCategory: 'ecmascript' };

const NODES = [
  { id: 'FN:fetchUser', type: 'FUNCTION', name: 'fetchUser', file: 'src/api.ts', line: 1 },

  // member-call CALLs (receiver-bearing)
  { id: 'CALL:axios.get', type: 'CALL', name: 'axios.get', file: 'src/api.ts', line: 2 },
  { id: 'CALL:JSON.parse', type: 'CALL', name: 'JSON.parse', file: 'src/api.ts', line: 3 },
  { id: 'CALL:readFile', type: 'CALL', name: 'readFile', file: 'src/api.ts', line: 4 },

  // resolved targets
  { id: 'GLOBAL::get', type: 'GLOBAL_DEFINITION', name: 'get', effects: 'PURE' },
  { id: 'GLOBAL::JSON.parse', type: 'GLOBAL_DEFINITION', name: 'JSON.parse', effects: 'THROW' },
  { id: 'GLOBAL::readFile', type: 'GLOBAL_DEFINITION', name: 'readFile', effects: 'IO' },
  { id: 'EXT:fs.readFile', type: 'EXTERNAL_FUNCTION', name: 'readFile' },
  { id: 'IB:readFile', type: 'IMPORT_BINDING', name: 'readFile', source: 'fs/promises', importedName: 'readFile' },

  // axios.get receiver chain (CALL → PROPERTY_ACCESS → REFERENCE → IMPORT_BINDING "axios")
  { id: 'PA:axios.get', type: 'PROPERTY_ACCESS', name: 'get' },
  { id: 'REF:axios', type: 'REFERENCE', name: 'axios' },
  { id: 'IB:axios', type: 'IMPORT_BINDING', name: 'axios', source: 'axios', importedName: 'default' },
];

const EDGES = [
  // function → its three calls (direct semantic edges; Layout B)
  { src: 'FN:fetchUser', dst: 'CALL:axios.get', type: 'AWAITS' },
  { src: 'FN:fetchUser', dst: 'CALL:JSON.parse', type: 'CALLS' },
  { src: 'FN:fetchUser', dst: 'CALL:readFile', type: 'AWAITS' },

  // axios.get → GLOBAL::get (the defect) + receiver chain
  { src: 'CALL:axios.get', dst: 'GLOBAL::get', type: 'CALLS', metadata: RV_GLOBAL },
  { src: 'CALL:axios.get', dst: 'PA:axios.get', type: 'DERIVES_FROM', metadata: { kind: 'callee' } },
  { src: 'PA:axios.get', dst: 'REF:axios', type: 'READS_FROM', metadata: { kind: 'receiver' } },
  { src: 'REF:axios', dst: 'IB:axios', type: 'READS_FROM', metadata: {} },

  // JSON.parse → GLOBAL::JSON.parse (genuine ecma-global, receiver preserved, NO import binding)
  { src: 'CALL:JSON.parse', dst: 'GLOBAL::JSON.parse', type: 'CALLS', metadata: RV_GLOBAL },

  // readFile → 3 targets (fan-out superset)
  { src: 'CALL:readFile', dst: 'GLOBAL::readFile', type: 'CALLS', metadata: RV_GLOBAL },
  { src: 'CALL:readFile', dst: 'EXT:fs.readFile', type: 'CALLS', metadata: { resolvedVia: 'builtins' } },
  { src: 'CALL:readFile', dst: 'IB:readFile', type: 'CALLS', metadata: { _source: 'analyzer' } },
];

describe('R5 — live suspected-unsound detection in traceEffects', () => {
  it('marks axios.get → GLOBAL::get as suspected-unsound while still recovering effects', async () => {
    const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
    const backend = makeBackend(NODES, EDGES);

    const result = await traceEffects(backend, 'FN:fetchUser', effectsLookup);
    assert.ok(result, 'non-null result');

    // R5: exactly one suspected-unsound resolution, and it is axios.get.
    assert.equal(result.suspected_unsound.length, 1, 'one suspected-unsound');
    const u = result.suspected_unsound[0];
    assert.equal(u.call_name, 'axios.get');
    assert.equal(u.resolved_to, 'GLOBAL::get');
    assert.equal(u.resolved_to_name, 'get');
    assert.equal(u.receiver_module, 'axios');
    assert.deepEqual(u.presented_effects, ['PURE']);

    // The axios.get leaf carries the suspected-unsound precision marker.
    const axiosLeaf = result.leaf_sources.find(l => l.id === 'GLOBAL::get');
    assert.ok(axiosLeaf, 'axios.get leaf present');
    assert.equal(axiosLeaf.precision?.precision, 'suspected-unsound');
    assert.equal(axiosLeaf.precision?.basis, 'imported-default-method-to-ecma-global');
  });

  it('does NOT mis-flag the genuine ecma-global JSON.parse', async () => {
    const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
    const backend = makeBackend(NODES, EDGES);
    const result = await traceEffects(backend, 'FN:fetchUser', effectsLookup);

    const jsonLeaf = result.leaf_sources.find(l => l.id === 'GLOBAL::JSON.parse');
    assert.ok(jsonLeaf, 'JSON.parse leaf present');
    assert.equal(jsonLeaf.precision?.precision, 'precise');
    // JSON.parse is not in the suspected-unsound list.
    assert.ok(!result.suspected_unsound.some(u => u.call_name === 'JSON.parse'));
  });

  it('marks the readFile fan-out as heuristic-superset (sound, noisy)', async () => {
    const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
    const backend = makeBackend(NODES, EDGES);
    const result = await traceEffects(backend, 'FN:fetchUser', effectsLookup);

    const supersetLeaves = result.leaf_sources.filter(
      l => l.precision?.precision === 'heuristic-superset',
    );
    assert.ok(supersetLeaves.length >= 1, 'at least one superset leaf');
    for (const l of supersetLeaves) {
      assert.equal(l.precision.candidateCount, 3);
      assert.equal(l.precision.basis, 'multiple-candidates');
    }
  });
});

describe('R2 — precision marker in find_calls (CallInfo.precision)', () => {
  it('threads precision onto each resolved call; superset on fan-out, precise otherwise', async () => {
    const backend = makeBackend(NODES, EDGES);
    const calls = await findCallsInFunction(backend, 'FN:fetchUser', { transitive: false });

    const byName = Object.fromEntries(calls.map(c => [c.name, c]));

    // JSON.parse: single concrete target → precise.
    assert.equal(byName['JSON.parse'].precision?.precision, 'precise');
    assert.equal(byName['JSON.parse'].precision?.candidateCount, 1);

    // readFile: fan-out 3 → heuristic-superset.
    assert.equal(byName['readFile'].precision?.precision, 'heuristic-superset');
    assert.equal(byName['readFile'].precision?.candidateCount, 3);

    // axios.get: find_calls skips the receiver walk → NOT suspected-unsound here
    // (it reports precise from a single non-superset target; the unsound nuance
    // is reserved for traceEffects / the audit, which run the full walk).
    assert.equal(byName['axios.get'].precision?.precision, 'precise');
    assert.notEqual(byName['axios.get'].precision?.precision, 'suspected-unsound');
  });
});

describe('R4 — soundness taxonomy + util-layer invariant check', () => {
  it('soundnessOf maps the three classes onto the verdict', () => {
    assert.equal(soundnessOf('precise'), 'sound');
    assert.equal(soundnessOf('heuristic-superset'), 'sound-superset');
    assert.equal(soundnessOf('suspected-unsound'), 'unsound');
  });

  it('checkResolutionSoundness HARD-FLAGS the axios.get unsound resolution', async () => {
    const backend = makeBackend(NODES, EDGES);
    const report = await checkResolutionSoundness(backend);

    assert.equal(report.hasUnsound, true, 'has an unsound violation');
    assert.equal(report.violations.length, 1, 'exactly one violation');
    const v = report.violations[0];
    assert.equal(v.callName, 'axios.get');
    assert.equal(v.resolvedTo, 'GLOBAL::get');
    assert.equal(v.receiverModule, 'axios');
    assert.equal(v.verdict, 'unsound');
    assert.equal(v.basis, 'imported-default-method-to-ecma-global');
    assert.deepEqual(v.presentedEffects, ['PURE']);

    // Taxonomy tally: 1 unsound (axios.get→GLOBAL), 3 sound-superset (readFile
    // fan-out), 1 sound (JSON.parse).
    assert.equal(report.bySoundness.unsound, 1);
    assert.equal(report.bySoundness['sound-superset'], 3);
    assert.equal(report.bySoundness.sound, 1);
  });

  it('a clean graph (no defect) reports no violations', async () => {
    // Drop the axios.get defect and its receiver chain → only JSON.parse + readFile.
    const cleanNodes = NODES.filter(n => !n.id.includes('axios'));
    const cleanEdges = EDGES.filter(
      e => !e.src.includes('axios') && !e.dst.includes('axios')
        && !(e.src === 'PA:axios.get') && !(e.dst === 'PA:axios.get'),
    );
    const backend = makeBackend(cleanNodes, cleanEdges);
    const report = await checkResolutionSoundness(backend);
    assert.equal(report.hasUnsound, false);
    assert.equal(report.violations.length, 0);
  });
});
