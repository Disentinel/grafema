/**
 * Effects-db coverage guard for the `axios` HTTP client.
 *
 * Why this exists:
 *   - The effects-db annotated the HTTP *server* (receiver) side —
 *     `IO:HTTP:LISTEN` on the node.yaml runtime (http.createServer /
 *     Server.listen) — but no popular HTTP *client*. The `http` bridge pattern
 *     (effects-db/bridges.yaml) pairs a sender carrying `IO:HTTP:REQUEST` with a
 *     receiver carrying `IO:HTTP:LISTEN`. Without an annotated client, the
 *     sender-side effect was absent from every package for the
 *     ~50M-weekly-download axios.
 *
 * What this guards:
 *   1. STRUCTURE — the request methods carry IO:HTTP:REQUEST and the pure helpers
 *      stay pure, so a future edit can't silently drop the bridge-sender effect or
 *      mark a pure helper effectful.
 *   2. FUNCTION — the annotations actually flow through the real propagation
 *      engine. `traceEffects` (the code behind the MCP `trace-effects` handler and
 *      behaviorEnricher) is run over a fixture graph: a FUNCTION that calls
 *      `axios.get`, and the transitive effects must include IO:HTTP:REQUEST. This
 *      is the same mock-backend pattern as trace-effects.test.js — no live server.
 *
 * Not covered here (honest scope): a full `grafema analyze` run and the actual
 * materialization of CALLS_REMOTE edges by the http bridge require a live graph
 * (GHC + rfdb-server) and are validated separately.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup, traceEffects } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/** The request methods that perform an outgoing HTTP request. */
const REQUEST_METHODS = [
  'request', 'get', 'delete', 'head', 'options',
  'post', 'put', 'patch', 'postForm', 'putForm', 'patchForm',
];

/** Minimal in-memory DataflowBackend (mirrors trace-effects.test.js). */
function createMockBackend(nodes, edges) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  return {
    async getNode(id) { return nodeMap.get(id) || null; },
    async *queryNodes(filter) {
      for (const n of nodes) {
        if (filter.type && n.type !== filter.type) continue;
        if (filter.name && n.name !== filter.name) continue;
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

// ── STRUCTURE ───────────────────────────────────────────────────────────────

test('axios request methods carry IO:HTTP:REQUEST (http-bridge sender)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const m of REQUEST_METHODS) {
    const effects = lookup.lookup('axios', m);
    assert.ok(effects, `Expected effects for axios.${m}`);
    assert.ok(effects.includes('IO:HTTP:REQUEST'), `axios.${m} must include IO:HTTP:REQUEST, got: ${effects}`);
    assert.ok(effects.includes('IO'), `axios.${m} must include parent IO, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `axios.${m} must include ASYNC, got: ${effects}`);
  }
});

test('axios pure helpers are not effectful', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const helper of ['isAxiosError', 'isCancel', 'getUri', 'toFormData', 'formToJSON', 'spread']) {
    assert.deepEqual(lookup.lookup('axios', helper), ['PURE'], `axios.${helper} must be PURE`);
  }
});

// ── FUNCTION (real engine, fixture graph, no server) ─────────────────────────

test('traceEffects propagates IO:HTTP:REQUEST from an axios.get call', async () => {
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'fetchUser', file: 'src/api.ts', line: 1 },
    { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'axios.get', file: undefined },
  ];
  const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', effectsLookup);
  assert.ok(result, 'Expected non-null result');
  assert.ok(
    result.transitive.includes('IO:HTTP:REQUEST'),
    `Expected IO:HTTP:REQUEST in transitive effects, got: ${result.transitive}`,
  );
  assert.ok(result.transitive.includes('IO'), `Expected parent IO, got: ${result.transitive}`);
  assert.equal(result.leaf_sources[0].node, 'axios.get');
});

// ── REGRESSION: member call on a default-imported external module ────────────
//
// Real-graph shape (verified live on /tmp/sep-test, 2026-06-17). The analyzer
// emits ONE dotted CALL node `axios.get` (object=undefined) whose only CALLS
// edge points at the ecma-global stand-in GLOBAL::get (GLOBAL_DEFINITION,
// effects=PURE) — the receiver was collapsed by the runtime-globals pack. The
// receiver is still reachable:
//   CALL -[DERIVES_FROM]-> PROPERTY_ACCESS {base:"axios"}
//        -[READS_FROM kind:receiver]-> REFERENCE "axios"
//        -[READS_FROM]-> IMPORT_BINDING "axios" {source:"axios"}
// traceEffects must walk that chain, recover module="axios", and consult
// effects-db instead of accepting the PURE global. (PART A of the SEP gap fix.)
function axiosGetGlobalCollapseGraph() {
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'fetchUser', file: 'src/api.ts', line: 1, async: true },
    { id: 'call1', type: 'CALL', name: 'axios.get', file: 'src/api.ts', line: 2 },
    { id: 'GLOBAL::get', type: 'GLOBAL_DEFINITION', name: 'get', source: 'effects-db', effects: 'PURE' },
    { id: 'pa1', type: 'PROPERTY_ACCESS', name: 'get', base: 'axios', file: 'src/api.ts', line: 2 },
    { id: 'ref1', type: 'REFERENCE', name: 'axios', file: 'src/api.ts', line: 2 },
    { id: 'imp1', type: 'IMPORT_BINDING', name: 'axios', source: 'axios', importedName: 'default' },
  ];
  const edges = [
    { src: 'fn1', dst: 'call1', type: 'AWAITS' },
    { src: 'call1', dst: 'GLOBAL::get', type: 'CALLS' },
    { src: 'call1', dst: 'pa1', type: 'DERIVES_FROM', metadata: { kind: 'callee' } },
    { src: 'pa1', dst: 'ref1', type: 'READS_FROM', metadata: { kind: 'receiver' } },
    { src: 'ref1', dst: 'imp1', type: 'READS_FROM' },
  ];
  return { nodes, edges };
}

test('traceEffects recovers axios.get effects through a collapsed PURE global', async () => {
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const { nodes, edges } = axiosGetGlobalCollapseGraph();
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', effectsLookup);
  assert.ok(result, 'Expected non-null result');
  assert.ok(
    result.transitive.includes('IO:HTTP:REQUEST'),
    `Expected IO:HTTP:REQUEST in transitive effects, got: ${result.transitive}`,
  );
  assert.ok(result.transitive.includes('IO'), `Expected parent IO, got: ${result.transitive}`);
  const leaf = result.leaf_sources.find(l => l.node === 'axios.get');
  assert.ok(leaf, `Expected a leaf source for axios.get, got: ${JSON.stringify(result.leaf_sources)}`);
  assert.ok(leaf.effects.includes('IO:HTTP:REQUEST'), `axios.get leaf must carry IO:HTTP:REQUEST, got: ${leaf.effects}`);
});

test('traceEffects does NOT clobber a genuine ecma-global (JSON.parse stays inert)', async () => {
  // JSON.parse resolves onto a PURE/THROW global with NO IMPORT_BINDING behind
  // the receiver — the override must not fire and invent module="JSON" effects.
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'load', file: 'src/api.ts', line: 1 },
    { id: 'call1', type: 'CALL', name: 'JSON.parse', file: 'src/api.ts', line: 2 },
    { id: 'GLOBAL::parse', type: 'GLOBAL_DEFINITION', name: 'parse', source: 'effects-db', effects: 'PURE' },
    // Receiver chain dead-ends at a plain REFERENCE (JSON is a global, not imported).
    { id: 'pa1', type: 'PROPERTY_ACCESS', name: 'parse', base: 'JSON', file: 'src/api.ts', line: 2 },
    { id: 'ref1', type: 'REFERENCE', name: 'JSON', file: 'src/api.ts', line: 2 },
  ];
  const edges = [
    { src: 'fn1', dst: 'call1', type: 'RETURNS' },
    { src: 'call1', dst: 'GLOBAL::parse', type: 'CALLS' },
    { src: 'call1', dst: 'pa1', type: 'DERIVES_FROM', metadata: { kind: 'callee' } },
    { src: 'pa1', dst: 'ref1', type: 'READS_FROM', metadata: { kind: 'receiver' } },
  ];
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', effectsLookup);
  assert.ok(result, 'Expected non-null result');
  // No IMPORT_BINDING → no override → the global's own (PURE) metadata stands.
  assert.deepEqual(result.transitive, ['PURE'], `JSON.parse via PURE global must stay PURE, got: ${result.transitive}`);
});

test('traceEffects does NOT override for a relative-import receiver', async () => {
  // A `helpers.get` member call whose receiver is imported from "./helpers"
  // must NOT be reconciled against effects-db (relative source is rejected).
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'use', file: 'src/api.ts', line: 1 },
    { id: 'call1', type: 'CALL', name: 'axios.get', file: 'src/api.ts', line: 2 },
    { id: 'GLOBAL::get', type: 'GLOBAL_DEFINITION', name: 'get', source: 'effects-db', effects: 'PURE' },
    { id: 'pa1', type: 'PROPERTY_ACCESS', name: 'get', base: 'axios', file: 'src/api.ts', line: 2 },
    { id: 'ref1', type: 'REFERENCE', name: 'axios', file: 'src/api.ts', line: 2 },
    // Local re-name: the identifier `axios` is actually a relative import.
    { id: 'imp1', type: 'IMPORT_BINDING', name: 'axios', source: './local-axios', importedName: 'default' },
  ];
  const edges = [
    { src: 'fn1', dst: 'call1', type: 'RETURNS' },
    { src: 'call1', dst: 'GLOBAL::get', type: 'CALLS' },
    { src: 'call1', dst: 'pa1', type: 'DERIVES_FROM', metadata: { kind: 'callee' } },
    { src: 'pa1', dst: 'ref1', type: 'READS_FROM', metadata: { kind: 'receiver' } },
    { src: 'ref1', dst: 'imp1', type: 'READS_FROM' },
  ];
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', effectsLookup);
  assert.ok(result, 'Expected non-null result');
  assert.deepEqual(result.transitive, ['PURE'], `relative-import receiver must stay PURE, got: ${result.transitive}`);
});

test('traceEffects leaves an axios.getUri call pure (no false IO)', async () => {
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'buildUrl', file: 'src/api.ts', line: 1 },
    { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'axios.getUri', file: undefined },
  ];
  const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', effectsLookup);
  assert.ok(result, 'Expected non-null result');
  assert.deepEqual(result.transitive, ['PURE'], `axios.getUri must trace as PURE, got: ${result.transitive}`);
});
