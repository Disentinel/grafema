/**
 * Effects-db coverage guard for the `ioredis` Redis client (~5M weekly downloads).
 *
 * Why this exists:
 *   - The `unix-socket` bridge pattern (effects-db/bridges.yaml) pairs a SENDER
 *     carrying `IO:SOCKET:WRITE` / `IO:SOCKET:CONNECT` with a RECEIVER carrying
 *     `IO:SOCKET:LISTEN` / `IO:SOCKET:READ`. Until now no npm *package* annotated
 *     on `main` supplied the socket sender side — `IO:SOCKET:*` lived only in the
 *     node.yaml runtime (net/tls). ioredis is one of the most-used socket clients
 *     on npm; annotating it lights up the socket-bridge sender for every
 *     `new Redis(); redis.get(...)` / `redis.publish(...)` call site.
 *   - ioredis is also the first JS package here to carry `MESSAGE_PASSING`: Redis
 *     pub/sub (`publish` / `subscribe`) is genuine inter-service message passing,
 *     which directly feeds cross-service/cross-repo contract matching (REG-1145).
 *     Plain data commands (get/set/del) are socket writes but NOT message passing —
 *     this test pins that distinction so a future edit can't blur it.
 *
 * What this guards:
 *   1. STRUCTURE — pub/sub carries MESSAGE_PASSING + IO:SOCKET:WRITE; the
 *      constructor carries IO:SOCKET:CONNECT (eager connect); data commands are
 *      socket writes WITHOUT message passing; builders (pipeline/multi) stay PURE;
 *      nothing carries THROW (commands queue and reject asynchronously — a sync
 *      THROW would mis-mark every caller as possibly-throwing).
 *   2. FUNCTION — the annotations flow through the real propagation engine.
 *      `traceEffects` (the code behind the MCP `trace-effects` handler and
 *      behaviorEnricher) is run over a fixture graph and the transitive effects
 *      must reflect the annotation. Same mock-backend pattern as the axios/mysql2
 *      guards — no live server.
 *
 * Not covered here (honest scope): a full `grafema analyze` run and the live
 * materialization of CALLS_REMOTE edges by the socket bridge require a live graph
 * (grafema CLI + rfdb-server) and are validated separately. The exact leaf-naming
 * the analyzer emits for an `new Redis()` instance method (`ioredis.Redis.<m>`) is
 * the documented ClassName.method convention shared with the pg/mysql2 entries;
 * this guard verifies the lookup + propagation mechanism, not analyzer leaf naming.
 *
 * All effects below were derived from a REAL probe of ioredis@5.11.1 (no Redis
 * server): `new Redis()` to a dead port does not sync-throw and emits an async
 * ECONNREFUSED (eager connect); get/set/publish/subscribe/connect/quit all return
 * Promises (ASYNC) and reject asynchronously (no sync THROW); pipeline()/multi()
 * return a Pipeline builder synchronously (no IO until .exec()); disconnect()
 * returns void (sync socket close).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup, traceEffects } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/** Redis pub/sub methods — socket writes that are ALSO message passing. */
const PUBSUB_METHODS = ['publish', 'subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe'];

/** Representative data commands — socket writes, NOT message passing. */
const DATA_COMMANDS = ['get', 'set', 'del', 'hget', 'hset', 'incr', 'expire', 'exists', 'ttl', 'keys', 'scan', 'call', 'sendCommand'];

/** Minimal in-memory DataflowBackend (mirrors trace-effects.test.js / axios guard). */
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

test('ioredis constructor (new Redis / Cluster) is a socket-bridge sender (IO:SOCKET:CONNECT, eager, ASYNC, no THROW)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const ctor of ['Redis', 'Cluster']) {
    const effects = lookup.lookup('ioredis', ctor);
    assert.ok(effects, `Expected effects for ioredis.${ctor}`);
    assert.ok(effects.includes('IO'), `ioredis.${ctor} must include parent IO, got: ${effects}`);
    assert.ok(effects.includes('IO:SOCKET:CONNECT'), `ioredis.${ctor} must include IO:SOCKET:CONNECT (eager connect), got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `ioredis.${ctor} must include ASYNC, got: ${effects}`);
    assert.ok(!effects.includes('THROW'), `ioredis.${ctor} must NOT include THROW (connect fails async), got: ${effects}`);
  }
});

test('ioredis pub/sub methods carry MESSAGE_PASSING + IO:SOCKET:WRITE (cross-service bridge — REG-1145)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const m of PUBSUB_METHODS) {
    const effects = lookup.lookup('ioredis', `Redis.${m}`);
    assert.ok(effects, `Expected effects for ioredis.Redis.${m}`);
    assert.ok(effects.includes('MESSAGE_PASSING'), `ioredis.Redis.${m} must include MESSAGE_PASSING, got: ${effects}`);
    assert.ok(effects.includes('IO:SOCKET:WRITE'), `ioredis.Redis.${m} must include IO:SOCKET:WRITE, got: ${effects}`);
    assert.ok(effects.includes('IO'), `ioredis.Redis.${m} must include parent IO, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `ioredis.Redis.${m} must include ASYNC, got: ${effects}`);
    assert.ok(!effects.includes('THROW'), `ioredis.Redis.${m} must NOT include THROW (rejects async), got: ${effects}`);
  }
});

test('ioredis data commands are socket writes but NOT message passing', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const m of DATA_COMMANDS) {
    const effects = lookup.lookup('ioredis', `Redis.${m}`);
    assert.ok(effects, `Expected effects for ioredis.Redis.${m}`);
    assert.ok(effects.includes('IO:SOCKET:WRITE'), `ioredis.Redis.${m} must include IO:SOCKET:WRITE, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `ioredis.Redis.${m} must include ASYNC, got: ${effects}`);
    assert.ok(
      !effects.includes('MESSAGE_PASSING'),
      `ioredis.Redis.${m} must NOT include MESSAGE_PASSING (data command, not pub/sub), got: ${effects}`,
    );
    assert.ok(!effects.includes('THROW'), `ioredis.Redis.${m} must NOT include THROW (rejects async), got: ${effects}`);
  }
});

test('ioredis quit closes via socket write (async); disconnect is a sync socket close (no ASYNC)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const quit = lookup.lookup('ioredis', 'Redis.quit');
  assert.ok(quit, 'Expected effects for ioredis.Redis.quit');
  assert.ok(quit.includes('IO:SOCKET:WRITE'), `Redis.quit must include IO:SOCKET:WRITE, got: ${quit}`);
  assert.ok(quit.includes('ASYNC'), `Redis.quit must include ASYNC (returns Promise), got: ${quit}`);

  const disconnect = lookup.lookup('ioredis', 'Redis.disconnect');
  assert.ok(disconnect, 'Expected effects for ioredis.Redis.disconnect');
  assert.ok(disconnect.includes('IO'), `Redis.disconnect must include IO, got: ${disconnect}`);
  assert.ok(!disconnect.includes('ASYNC'), `Redis.disconnect must NOT include ASYNC (returns void), got: ${disconnect}`);
});

test('ioredis duplicate opens a new connection (IO:SOCKET:CONNECT, ASYNC)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const effects = lookup.lookup('ioredis', 'Redis.duplicate');
  assert.ok(effects, 'Expected effects for ioredis.Redis.duplicate');
  assert.ok(effects.includes('IO:SOCKET:CONNECT'), `Redis.duplicate must include IO:SOCKET:CONNECT, got: ${effects}`);
  assert.ok(effects.includes('ASYNC'), `Redis.duplicate must include ASYNC, got: ${effects}`);
});

test('ioredis pipeline/multi return a builder — PURE until .exec()', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const m of ['pipeline', 'multi']) {
    assert.deepEqual(
      lookup.lookup('ioredis', `Redis.${m}`),
      ['PURE'],
      `ioredis.Redis.${m} must be PURE (returns a Pipeline builder, no IO until exec)`,
    );
  }
});

test('ioredis pure / value helpers are not effectful (ReplyError); print writes the console', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  assert.deepEqual(lookup.lookup('ioredis', 'ReplyError'), ['PURE'], 'ioredis.ReplyError ctor must be PURE');

  const print = lookup.lookup('ioredis', 'print');
  assert.ok(print, 'Expected effects for ioredis.print');
  assert.ok(print.includes('IO:CONSOLE:WRITE'), `ioredis.print must include IO:CONSOLE:WRITE, got: ${print}`);
});

// ── FUNCTION (real engine, fixture graph, no server) ─────────────────────────

test('traceEffects propagates MESSAGE_PASSING + IO:SOCKET:WRITE from a redis.publish call', async () => {
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'broadcast', file: 'src/bus.ts', line: 1 },
    { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'ioredis.Redis.publish', file: undefined },
  ];
  const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', effectsLookup);
  assert.ok(result, 'Expected non-null result');
  assert.ok(result.transitive.includes('MESSAGE_PASSING'), `Expected MESSAGE_PASSING, got: ${result.transitive}`);
  assert.ok(result.transitive.includes('IO:SOCKET:WRITE'), `Expected IO:SOCKET:WRITE, got: ${result.transitive}`);
  assert.ok(result.transitive.includes('IO'), `Expected parent IO, got: ${result.transitive}`);
  assert.equal(result.leaf_sources[0].node, 'ioredis.Redis.publish');
});

test('traceEffects leaves a redis.pipeline call pure (builder, no false IO)', async () => {
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const nodes = [
    { id: 'fn1', type: 'FUNCTION', name: 'buildBatch', file: 'src/bus.ts', line: 1 },
    { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'ioredis.Redis.pipeline', file: undefined },
  ];
  const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
  const backend = createMockBackend(nodes, edges);

  const result = await traceEffects(backend, 'fn1', effectsLookup);
  assert.ok(result, 'Expected non-null result');
  assert.deepEqual(result.transitive, ['PURE'], `redis.pipeline must trace as PURE, got: ${result.transitive}`);
});
