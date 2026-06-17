/**
 * Resolution-precision / ambiguity MARKER (RFD R1, spike).
 *
 * Unit-level proof of the marker classifier + audit against an in-memory
 * fixture backend whose node/edge shape mirrors the LIVE /tmp/sep-test graph
 * (probed verbatim 2026-06-17 with fresh #449 binaries):
 *
 *   axios.get  CALL → GLOBAL::get (GLOBAL_DEFINITION, name "get", PURE,
 *              resolvedVia "runtime-globals"); receiver axios is a NON-RELATIVE
 *              default import  ⇒ suspected-unsound (the defect).
 *   JSON.parse CALL → GLOBAL::JSON.parse (receiver "JSON" preserved in target
 *              name; no import binding) ⇒ precise (a genuine ecma-global).
 *   readFile   CALL → 3 targets (GLOBAL + EXTERNAL_FUNCTION + IMPORT_BINDING)
 *              ⇒ heuristic-superset (fan-out > 1).
 *
 * Per the small-fixtures discipline: a FixtureStorageView-style in-memory
 * DataflowBackend keeps the test at ~0.0s and free of any rfdb-server process.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyResolution,
  auditResolutionPrecision,
} from '../../packages/util/dist/queries/index.js';

// ── In-memory DataflowBackend fixture (mirrors /tmp/sep-test) ──

function makeFixtureBackend(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  return {
    async getNode(id) {
      return byId.get(id) ?? null;
    },
    async *queryNodes(filter) {
      for (const n of nodes) {
        if (filter.type && n.type !== filter.type) continue;
        yield n;
      }
    },
    async getOutgoingEdges(id, types) {
      return edges.filter(
        e => e.src === id && (!types || types.includes(e.type)),
      );
    },
    async getIncomingEdges(id, types) {
      return edges.filter(
        e => e.dst === id && (!types || types.includes(e.type)),
      );
    },
  };
}

// Node/edge fixture transcribed from the live sep-test probe.
const NODES = [
  // CALLs
  { id: 'CALL:axios.get', type: 'CALL', name: 'axios.get' },
  { id: 'CALL:JSON.parse', type: 'CALL', name: 'JSON.parse' },
  { id: 'CALL:readFile', type: 'CALL', name: 'readFile' },
  // resolved targets
  { id: 'GLOBAL::get', type: 'GLOBAL_DEFINITION', name: 'get', effects: 'PURE' },
  { id: 'GLOBAL::JSON.parse', type: 'GLOBAL_DEFINITION', name: 'JSON.parse', effects: 'THROW' },
  { id: 'GLOBAL::readFile', type: 'GLOBAL_DEFINITION', name: 'readFile', effects: 'IO' },
  { id: 'EXT:fs.readFile', type: 'EXTERNAL_FUNCTION', name: 'readFile' },
  { id: 'IB:readFile', type: 'IMPORT_BINDING', name: 'readFile', source: 'fs/promises', importedName: 'readFile' },
  // axios.get receiver chain
  { id: 'PA:axios.get', type: 'PROPERTY_ACCESS', name: 'get' },
  { id: 'REF:axios', type: 'REFERENCE', name: 'axios' },
  { id: 'IB:axios', type: 'IMPORT_BINDING', name: 'axios', source: 'axios', importedName: 'default' },
];

const RV_GLOBAL = { resolvedVia: 'runtime-globals', globalCategory: 'ecmascript' };

const EDGES = [
  // axios.get → GLOBAL::get (the defect)  + receiver chain
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

describe('resolution-precision marker (R1)', () => {
  it('classifyResolution: importedDefault.method() → ecma GLOBAL::method = suspected-unsound', () => {
    const m = classifyResolution({
      call: { id: 'CALL:axios.get', type: 'CALL', name: 'axios.get' },
      edge: { src: 'CALL:axios.get', dst: 'GLOBAL::get', type: 'CALLS', metadata: RV_GLOBAL },
      target: { id: 'GLOBAL::get', type: 'GLOBAL_DEFINITION', name: 'get', effects: 'PURE' },
      candidateCount: 1,
      receiverIsExternalImport: true,
    });
    assert.equal(m.precision, 'suspected-unsound');
    assert.equal(m.basis, 'imported-default-method-to-ecma-global');
    assert.equal(m.candidateCount, 1);
    assert.equal(m.resolvedVia, 'runtime-globals');
  });

  it('classifyResolution: genuine ecma-global (receiver preserved, no import) = precise', () => {
    const m = classifyResolution({
      call: { id: 'CALL:JSON.parse', type: 'CALL', name: 'JSON.parse' },
      edge: { src: 'CALL:JSON.parse', dst: 'GLOBAL::JSON.parse', type: 'CALLS', metadata: RV_GLOBAL },
      target: { id: 'GLOBAL::JSON.parse', type: 'GLOBAL_DEFINITION', name: 'JSON.parse', effects: 'THROW' },
      candidateCount: 1,
      receiverIsExternalImport: false,
    });
    assert.equal(m.precision, 'precise');
    assert.equal(m.basis, 'single-concrete-target');
  });

  it('classifyResolution: fan-out > 1 = heuristic-superset', () => {
    const m = classifyResolution({
      call: { id: 'CALL:readFile', type: 'CALL', name: 'readFile' },
      edge: { src: 'CALL:readFile', dst: 'EXT:fs.readFile', type: 'CALLS', metadata: { resolvedVia: 'builtins' } },
      target: { id: 'EXT:fs.readFile', type: 'EXTERNAL_FUNCTION', name: 'readFile' },
      candidateCount: 3,
      receiverIsExternalImport: false,
    });
    assert.equal(m.precision, 'heuristic-superset');
    assert.equal(m.basis, 'multiple-candidates');
  });

  it('classifyResolution: type-unaware rust-cross-method = heuristic-superset', () => {
    const m = classifyResolution({
      call: { id: 'CALL:foo', type: 'CALL', name: 'x.foo' },
      edge: { src: 'CALL:foo', dst: 'M:foo', type: 'CALLS', metadata: { resolvedVia: 'rust-cross-method' } },
      target: { id: 'M:foo', type: 'METHOD', name: 'foo' },
      candidateCount: 1,
      receiverIsExternalImport: false,
    });
    assert.equal(m.precision, 'heuristic-superset');
    assert.equal(m.basis, 'type-unaware-method-superset');
  });

  it('auditResolutionPrecision: flags axios.get on the sep-test fixture shape', async () => {
    const backend = makeFixtureBackend(NODES, EDGES);
    const audit = await auditResolutionPrecision(backend);

    // Exactly one suspected-unsound case: axios.get.
    assert.equal(audit.suspectedUnsound.length, 1, 'one suspected-unsound case');
    const u = audit.suspectedUnsound[0];
    assert.equal(u.callName, 'axios.get');
    assert.equal(u.resolvedTo, 'GLOBAL::get');
    assert.equal(u.receiverModule, 'axios');
    assert.deepEqual(u.presentedEffects, ['PURE']);

    // Counts: 1 suspected-unsound (axios.get→GLOBAL), 3 superset (readFile fan-out),
    // 1 precise (JSON.parse).
    assert.equal(audit.counts['suspected-unsound'], 1);
    assert.equal(audit.counts['heuristic-superset'], 3);
    assert.equal(audit.counts['precise'], 1);

    // JSON.parse is precise, NOT mis-flagged as unsound.
    const jsonRes = audit.resolutions.find(r => r.callName === 'JSON.parse');
    assert.equal(jsonRes.marker.precision, 'precise');
  });
});
