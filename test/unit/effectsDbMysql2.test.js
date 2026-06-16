/**
 * effects-db: mysql2 annotation (TDD acceptance).
 *
 * mysql2 is the second relational DB client in effects-db (sibling to pg) and a
 * SOCKET-bridge sender (bridges.yaml unix-socket pattern: connect=IO:SOCKET:CONNECT,
 * query/execute/end=IO:SOCKET:WRITE).
 *
 * Every effect asserted here is grounded in a REAL behavioral probe of mysql2@3.22.5
 * (see PR body), not from memory:
 *   - createConnection() EAGERLY opens the socket (async ECONNREFUSED fires without
 *     calling .connect()) → [IO, IO:SOCKET:CONNECT, ASYNC]. Distinct from pg, where
 *     `new Client()` is PURE.
 *   - createPool() is LAZY (no eager connect) → [PURE].
 *   - Connection.query() no-arg SYNC-THROWS (TypeError) → THROW; Pool.query() forwards
 *     async and does NOT sync-throw → no THROW (mirrors pg's exact divergence).
 *   - Connection.execute() does NOT sync-throw (queues a command) → no THROW.
 *   - escape/escapeId/format/raw coerce inputs and never throw → PURE.
 *
 * Tests exercise BOTH the static lookup path (EffectsLookup.lookup) and the functional
 * traceEffects path over an EXTERNAL_MODULE leaf, mirroring trace-effects.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { traceEffects, EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/** Mock DataflowBackend from arrays of nodes and edges (same shape as trace-effects.test.js). */
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

describe('effects-db: mysql2', () => {
  const lookup = () => EffectsLookup.load(EFFECTS_DB_PATH);

  describe('connection lifecycle (socket connect, eager)', () => {
    it('createConnection eagerly opens a socket → IO:SOCKET:CONNECT, ASYNC', () => {
      const e = lookup().lookup('mysql2', 'createConnection');
      assert.ok(e, 'Expected effects for mysql2.createConnection');
      assert.ok(e.includes('IO'), `Expected IO, got: ${e}`);
      assert.ok(e.includes('IO:SOCKET:CONNECT'), `Expected IO:SOCKET:CONNECT, got: ${e}`);
      assert.ok(e.includes('ASYNC'), `Expected ASYNC, got: ${e}`);
    });

    it('connect is the same socket-connect surface as createConnection', () => {
      const e = lookup().lookup('mysql2', 'connect');
      assert.ok(e, 'Expected effects for mysql2.connect (alias of createConnection)');
      assert.ok(e.includes('IO:SOCKET:CONNECT'), `Expected IO:SOCKET:CONNECT, got: ${e}`);
    });

    it('Connection.connect → IO:SOCKET:CONNECT, ASYNC', () => {
      const e = lookup().lookup('mysql2', 'Connection.connect');
      assert.ok(e && e.includes('IO:SOCKET:CONNECT') && e.includes('ASYNC'), `got: ${e}`);
    });
  });

  describe('createPool is lazy (no eager IO)', () => {
    it('createPool → PURE (constructs a lazy pool, no socket at call time)', () => {
      const e = lookup().lookup('mysql2', 'createPool');
      assert.ok(e, 'Expected effects for mysql2.createPool');
      assert.deepEqual(e, ['PURE'], `Expected [PURE] (lazy pool), got: ${e}`);
    });
  });

  describe('query/execute write the socket (THROW divergence)', () => {
    it('Connection.query → IO:SOCKET:WRITE, ASYNC, THROW (no-arg sync-throws)', () => {
      const e = lookup().lookup('mysql2', 'Connection.query');
      assert.ok(e, 'Expected effects for mysql2.Connection.query');
      assert.ok(e.includes('IO:SOCKET:WRITE'), `Expected IO:SOCKET:WRITE, got: ${e}`);
      assert.ok(e.includes('ASYNC'), `Expected ASYNC, got: ${e}`);
      assert.ok(e.includes('THROW'), `Expected THROW (no-arg sync-throws), got: ${e}`);
    });

    it('Connection.execute → IO:SOCKET:WRITE, ASYNC but NO THROW (queues command)', () => {
      const e = lookup().lookup('mysql2', 'Connection.execute');
      assert.ok(e, 'Expected effects for mysql2.Connection.execute');
      assert.ok(e.includes('IO:SOCKET:WRITE'), `Expected IO:SOCKET:WRITE, got: ${e}`);
      assert.ok(!e.includes('THROW'), `Expected NO THROW for execute (no sync-throw), got: ${e}`);
    });

    it('Pool.query → IO:SOCKET:WRITE, ASYNC but NO THROW (forwards async, mirrors pg)', () => {
      const e = lookup().lookup('mysql2', 'Pool.query');
      assert.ok(e, 'Expected effects for mysql2.Pool.query');
      assert.ok(e.includes('IO:SOCKET:WRITE'), `Expected IO:SOCKET:WRITE, got: ${e}`);
      assert.ok(!e.includes('THROW'), `Expected NO THROW for Pool.query, got: ${e}`);
    });

    it('Pool.getConnection → IO:SOCKET:CONNECT, ASYNC', () => {
      const e = lookup().lookup('mysql2', 'Pool.getConnection');
      assert.ok(e && e.includes('IO:SOCKET:CONNECT') && e.includes('ASYNC'), `got: ${e}`);
    });
  });

  describe('teardown', () => {
    it('Connection.end → IO:SOCKET:WRITE, ASYNC (sends COM_QUIT)', () => {
      const e = lookup().lookup('mysql2', 'Connection.end');
      assert.ok(e && e.includes('IO:SOCKET:WRITE') && e.includes('ASYNC'), `got: ${e}`);
    });
    it('Connection.destroy → IO, MUTATION (mirror Socket.destroy)', () => {
      const e = lookup().lookup('mysql2', 'Connection.destroy');
      assert.ok(e && e.includes('IO') && e.includes('MUTATION'), `got: ${e}`);
    });
    it('Pool.releaseConnection → MUTATION (pool bookkeeping, no socket IO)', () => {
      const e = lookup().lookup('mysql2', 'Pool.releaseConnection');
      assert.deepEqual(e, ['MUTATION'], `got: ${e}`);
    });
  });

  describe('pure SQL helpers (coerce, never throw)', () => {
    for (const fn of ['escape', 'escapeId', 'format', 'raw']) {
      it(`${fn} → PURE`, () => {
        const e = lookup().lookup('mysql2', fn);
        assert.deepEqual(e, ['PURE'], `Expected [PURE] for mysql2.${fn}, got: ${e}`);
      });
    }
  });

  describe('server side', () => {
    it('createServer → IO:SOCKET:LISTEN (mirror node net.createServer)', () => {
      const e = lookup().lookup('mysql2', 'createServer');
      assert.ok(e && e.includes('IO:SOCKET:LISTEN'), `got: ${e}`);
    });
  });

  describe('mysql2/promise (modern async/await API)', () => {
    it('createConnection → IO:SOCKET:CONNECT, ASYNC', () => {
      const e = lookup().lookup('mysql2/promise', 'createConnection');
      assert.ok(e && e.includes('IO:SOCKET:CONNECT') && e.includes('ASYNC'), `got: ${e}`);
    });
    it('createPool → PURE (lazy)', () => {
      const e = lookup().lookup('mysql2/promise', 'createPool');
      assert.deepEqual(e, ['PURE'], `got: ${e}`);
    });
    it('Pool.query → IO:SOCKET:WRITE, ASYNC, NO THROW (promise rejects, not sync-throw)', () => {
      const e = lookup().lookup('mysql2/promise', 'Pool.query');
      assert.ok(e && e.includes('IO:SOCKET:WRITE') && !e.includes('THROW'), `got: ${e}`);
    });
    it('escape → PURE', () => {
      const e = lookup().lookup('mysql2/promise', 'escape');
      assert.deepEqual(e, ['PURE'], `got: ${e}`);
    });
  });

  describe('functional traceEffects over an EXTERNAL_MODULE leaf', () => {
    it('a function calling mysql2.Connection.query inherits IO:SOCKET:WRITE transitively', async () => {
      const effectsLookup = lookup();
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'runQuery', file: 'src/db.ts', line: 1 },
        { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'mysql2.Connection.query', file: undefined },
      ];
      const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', effectsLookup);
      assert.ok(result, 'Expected non-null traceEffects result');
      assert.ok(
        result.transitive.includes('IO'),
        `Expected IO in transitive effects, got: ${result.transitive}`,
      );
      assert.ok(
        result.transitive.includes('IO:SOCKET:WRITE'),
        `Expected IO:SOCKET:WRITE transitively, got: ${result.transitive}`,
      );
      assert.equal(result.leaf_sources[0].node, 'mysql2.Connection.query');
    });
  });
});
