/**
 * Regression guard: SPAWN and MESSAGE_PASSING survive traceEffects propagation.
 *
 * Why this exists:
 *   effects-db/taxonomy.yaml v2 (+ the REG-1097 additions) defines two
 *   concurrency effects — SPAWN and MESSAGE_PASSING — used by the elixir/erlang
 *   runtimes (effects-db/runtimes/elixir.yaml: `send: [MESSAGE_PASSING]`,
 *   `spawn: [SPAWN]`, `GenServer.cast`, ...) and now by the ioredis package
 *   (Redis pub/sub). But the TypeScript effect model (packages/util manifest
 *   types) originally listed only PURE/MUTATION/IO/THROW/ASYNC/NONDETERMINISTIC/
 *   UNKNOWN in `VALID_EFFECTS`. `traceEffects` calls `isValidEffect(e)` on every
 *   leaf effect and silently DROPS anything not in that set — so an Elixir `send`
 *   or a Redis `publish` traced as PURE, hiding genuine message-passing / spawn
 *   behavior. This guard pins that both effects now propagate, via the two leaf
 *   shapes traceEffects accepts:
 *     1. node metadata effects (comma-joined string) — the beam-analyzer / Haskell
 *        resolver / pack-minted EXTERNAL_MODULE path;
 *     2. effects-db lookup — the npm-package path.
 *
 * It asserts GRAPH-INDEPENDENT facts only (a fixture graph + the real propagation
 * engine), no live analyze.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { traceEffects, EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

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

test('traceEffects propagates SPAWN + MESSAGE_PASSING from node metadata effects (beam-analyzer path)', async () => {
  // Mirrors an Elixir `spawn_link` / `GenServer.cast` leaf minted with comma-joined
  // effects metadata (the shape derive packs / the Haskell resolver emit).
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'startWorker', file: 'lib/worker.ex', line: 1 },
    { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'Kernel.spawn_link', file: undefined, effects: 'SPAWN,MESSAGE_PASSING' },
  ];
  const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', EffectsLookup.empty());
  assert.ok(result, 'Expected non-null result');
  assert.ok(result.transitive.includes('SPAWN'), `Expected SPAWN in transitive, got: ${result.transitive}`);
  assert.ok(
    result.transitive.includes('MESSAGE_PASSING'),
    `Expected MESSAGE_PASSING in transitive, got: ${result.transitive}`,
  );
  assert.deepEqual(result.leaf_sources[0].effects.sort(), ['MESSAGE_PASSING', 'SPAWN']);
});

test('traceEffects propagates MESSAGE_PASSING from an effects-db package lookup (ioredis pub/sub)', async () => {
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'emit', file: 'src/bus.ts', line: 1 },
    { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'ioredis.Redis.publish', file: undefined },
  ];
  const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', effectsLookup);
  assert.ok(result, 'Expected non-null result');
  assert.ok(
    result.transitive.includes('MESSAGE_PASSING'),
    `Expected MESSAGE_PASSING in transitive, got: ${result.transitive}`,
  );
});
