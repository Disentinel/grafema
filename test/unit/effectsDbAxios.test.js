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
