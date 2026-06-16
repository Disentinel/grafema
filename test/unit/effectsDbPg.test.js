// effectsDbPg.test.js — characterizes the `pg` (node-postgres) effects-db
// annotation (effects-db/packages/pg.yaml). `pg` was UNKNOWN to the effect
// tracer before this; it is the first DATABASE client in the registry and a
// socket-bridge sender (Client/Pool.connect = IO:SOCKET:CONNECT, query/end =
// IO:SOCKET:WRITE — the unix-socket bridge sender pair in bridges.yaml).
//
// Every effect below was derived from a REAL API probe of pg@8.21.0 (not
// memory): connect()/query()/end() each return a Promise (ASYNC) and do
// network IO over the DB socket. The Client-vs-Pool THROW divergence is the
// adversarial Round-A catch and is asserted explicitly: `Client.query()` with
// no argument THROWS synchronously (TypeError from the query-config builder),
// but `Pool.query()` with no argument does NOT — it forwards the bad call to a
// pooled client asynchronously, so the failure surfaces as a rejection, not a
// synchronous throw. escapeIdentifier/escapeLiteral coerce non-strings (e.g.
// escapeLiteral(undefined) === "''") and never throw → PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { traceEffects, EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/** Mock DataflowBackend from node/edge arrays (mirrors trace-effects.test.js). */
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

describe('effects-db: pg (node-postgres)', () => {
  const lookup = () => EffectsLookup.load(EFFECTS_DB_PATH);

  describe('Client lifecycle — DB socket IO', () => {
    it('Client.connect opens a socket connection (ASYNC)', () => {
      const e = lookup().lookup('pg', 'Client.connect');
      assert.ok(e, 'pg Client.connect must be annotated');
      assert.ok(e.includes('IO'), `expected IO, got ${e}`);
      assert.ok(e.includes('IO:SOCKET:CONNECT'), `expected IO:SOCKET:CONNECT, got ${e}`);
      assert.ok(e.includes('ASYNC'), `expected ASYNC, got ${e}`);
    });

    it('Client.query writes over the socket, is ASYNC, and sync-THROWs on bad arg', () => {
      const e = lookup().lookup('pg', 'Client.query');
      assert.ok(e, 'pg Client.query must be annotated');
      assert.ok(e.includes('IO'), `expected IO, got ${e}`);
      assert.ok(e.includes('IO:SOCKET:WRITE'), `expected IO:SOCKET:WRITE, got ${e}`);
      assert.ok(e.includes('ASYNC'), `expected ASYNC, got ${e}`);
      assert.ok(e.includes('THROW'), `expected THROW (client.query() no-arg throws sync TypeError), got ${e}`);
    });

    it('Client.end closes the connection (socket write, ASYNC)', () => {
      const e = lookup().lookup('pg', 'Client.end');
      assert.ok(e, 'pg Client.end must be annotated');
      assert.ok(e.includes('IO') && e.includes('IO:SOCKET:WRITE') && e.includes('ASYNC'), `got ${e}`);
    });
  });

  describe('Pool lifecycle — and the Client-vs-Pool THROW divergence', () => {
    it('Pool.connect acquires a pooled socket connection (ASYNC)', () => {
      const e = lookup().lookup('pg', 'Pool.connect');
      assert.ok(e, 'pg Pool.connect must be annotated');
      assert.ok(e.includes('IO:SOCKET:CONNECT') && e.includes('ASYNC'), `got ${e}`);
    });

    it('Pool.query is ASYNC socket-write but does NOT carry THROW (no sync throw)', () => {
      const e = lookup().lookup('pg', 'Pool.query');
      assert.ok(e, 'pg Pool.query must be annotated');
      assert.ok(e.includes('IO') && e.includes('IO:SOCKET:WRITE') && e.includes('ASYNC'), `got ${e}`);
      assert.ok(
        !e.includes('THROW'),
        `Pool.query() forwards to a pooled client and does NOT sync-throw — THROW must be absent, got ${e}`,
      );
    });

    it('Pool.end drains the pool (IO, ASYNC)', () => {
      const e = lookup().lookup('pg', 'Pool.end');
      assert.ok(e, 'pg Pool.end must be annotated');
      assert.ok(e.includes('IO') && e.includes('ASYNC'), `got ${e}`);
    });
  });

  describe('construction and pure helpers', () => {
    it('Client.new / Pool.new are PURE (no IO at construct time)', () => {
      const c = lookup().lookup('pg', 'Client.new');
      const p = lookup().lookup('pg', 'Pool.new');
      assert.deepEqual(c, ['PURE'], `Client.new got ${c}`);
      assert.deepEqual(p, ['PURE'], `Pool.new got ${p}`);
    });

    it('escapeIdentifier / escapeLiteral are PURE (coerce, never throw)', () => {
      const l = lookup();
      assert.deepEqual(l.lookup('pg', 'escapeIdentifier'), ['PURE']);
      assert.deepEqual(l.lookup('pg', 'escapeLiteral'), ['PURE']);
      // The Client.prototype forms exist on real pg too.
      assert.deepEqual(l.lookup('pg', 'Client.escapeIdentifier'), ['PURE']);
      assert.deepEqual(l.lookup('pg', 'Client.escapeLiteral'), ['PURE']);
    });

    it('setTypeParser mutates the type registry (MUTATION); getTypeParser is PURE', () => {
      const l = lookup();
      assert.deepEqual(l.lookup('pg', 'Client.setTypeParser'), ['MUTATION']);
      assert.deepEqual(l.lookup('pg', 'Client.getTypeParser'), ['PURE']);
    });
  });

  describe('functional propagation via traceEffects', () => {
    it('a function calling pg.Client.query inherits IO + IO:SOCKET:WRITE', async () => {
      const effectsLookup = lookup();
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'runQuery', file: 'src/db.ts', line: 1 },
        { id: 'ext1', type: 'EXTERNAL_FUNCTION', name: 'pg.Client.query', file: undefined },
      ];
      const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', effectsLookup);
      assert.ok(result, 'expected non-null trace result');
      assert.ok(result.transitive.includes('IO'), `expected IO, got ${result.transitive}`);
      assert.ok(
        result.transitive.includes('IO:SOCKET:WRITE'),
        `expected IO:SOCKET:WRITE in transitive, got ${result.transitive}`,
      );
      assert.ok(result.leaf_sources.length > 0, 'expected a leaf source');
      assert.equal(result.leaf_sources[0].node, 'pg.Client.query');
    });
  });
});
