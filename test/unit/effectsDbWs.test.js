// effectsDbWs.test.js — characterizes the `ws` (WebSocket) effects-db
// annotation (effects-db/packages/ws.yaml). `ws` was UNKNOWN to the effect
// tracer before this; it is the first FULL-DUPLEX NETWORK SOCKET package in the
// registry — both a client (WebSocket) and a server (WebSocketServer). It is a
// socket-bridge sender AND receiver per bridges.yaml: the client connects
// (IO:SOCKET:CONNECT) and writes frames (IO:SOCKET:WRITE); the server listens
// (IO:SOCKET:LISTEN). This mirrors node:net Socket.connect / Socket.write /
// Socket.end / Server.listen (node.yaml:294-308) and net.createServer
// (node.yaml:284, IO:SOCKET:LISTEN).
//
// Every effect below was derived from a REAL API probe of ws@8.21.0 (not
// memory). The non-obvious THROW splits, all verified live:
//   * `new WebSocket(url)` sync-THROWs on a missing/invalid URL (SyntaxError),
//     but connects ASYNCHRONOUSLY — the handshake failure is an async 'error'
//     event, not a sync throw.
//   * `send()/ping()/pong()` sync-THROW when the socket is not OPEN ("WebSocket
//     is not open: readyState 0 (CONNECTING)") — verified this throws EVEN when
//     a completion callback is supplied; when OPEN they write the socket and
//     accept a callback (ASYNC).
//   * `close(code)` sync-THROWs on an invalid close code (TypeError) and sends a
//     close frame (IO:SOCKET:WRITE, ASYNC closing handshake).
//   * `new WebSocketServer(opts)` sync-THROWs when none of port/server/noServer
//     is given (TypeError); with `{port}` it binds and listens (IO:SOCKET:LISTEN).
//   * `WebSocketServer.shouldHandle(req)` returns a boolean and never throws →
//     PURE. `terminate/pause/resume` mirror node Socket.destroy/pause/resume
//     ([IO, MUTATION]). Listener registration (on/once/addEventListener) mirrors
//     node EventEmitter.on ([MUTATION], node.yaml:465).
//   * `createWebSocketStream(ws)` attaches listeners to the passed socket
//     (MUTATION) and sync-THROWs on a bad arg — it does no socket IO itself at
//     call time (the returned Duplex is where read/write IO happens).

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

describe('effects-db: ws (WebSocket)', () => {
  const lookup = () => EffectsLookup.load(EFFECTS_DB_PATH);

  describe('WebSocket client — connect / socket-write IO', () => {
    it('WebSocket.new opens a socket connection (ASYNC) and sync-THROWs on bad URL', () => {
      const e = lookup().lookup('ws', 'WebSocket.new');
      assert.ok(e, 'ws WebSocket.new must be annotated');
      assert.ok(e.includes('IO'), `expected IO, got ${e}`);
      assert.ok(e.includes('IO:SOCKET:CONNECT'), `expected IO:SOCKET:CONNECT, got ${e}`);
      assert.ok(e.includes('ASYNC'), `expected ASYNC, got ${e}`);
      assert.ok(e.includes('THROW'), `expected THROW (bad/missing URL sync-throws), got ${e}`);
    });

    it('WebSocket.send writes the socket, is ASYNC, and sync-THROWs when not OPEN', () => {
      const e = lookup().lookup('ws', 'WebSocket.send');
      assert.ok(e, 'ws WebSocket.send must be annotated');
      assert.ok(e.includes('IO'), `expected IO, got ${e}`);
      assert.ok(e.includes('IO:SOCKET:WRITE'), `expected IO:SOCKET:WRITE, got ${e}`);
      assert.ok(e.includes('ASYNC'), `expected ASYNC, got ${e}`);
      assert.ok(e.includes('THROW'), `expected THROW (send when not OPEN throws), got ${e}`);
    });

    it('WebSocket.ping / WebSocket.pong are socket-write, ASYNC, THROW (same path as send)', () => {
      const l = lookup();
      for (const fn of ['WebSocket.ping', 'WebSocket.pong']) {
        const e = l.lookup('ws', fn);
        assert.ok(e, `ws ${fn} must be annotated`);
        assert.ok(
          e.includes('IO:SOCKET:WRITE') && e.includes('ASYNC') && e.includes('THROW'),
          `${fn} expected IO:SOCKET:WRITE+ASYNC+THROW, got ${e}`,
        );
      }
    });

    it('WebSocket.close sends a close frame (socket-write, ASYNC) and THROWs on invalid code', () => {
      const e = lookup().lookup('ws', 'WebSocket.close');
      assert.ok(e, 'ws WebSocket.close must be annotated');
      assert.ok(
        e.includes('IO:SOCKET:WRITE') && e.includes('ASYNC') && e.includes('THROW'),
        `close expected IO:SOCKET:WRITE+ASYNC+THROW, got ${e}`,
      );
    });

    it('WebSocket.terminate / pause / resume mirror node Socket.destroy/pause/resume ([IO, MUTATION])', () => {
      const l = lookup();
      for (const fn of ['WebSocket.terminate', 'WebSocket.pause', 'WebSocket.resume']) {
        const e = l.lookup('ws', fn);
        assert.deepEqual(e, ['IO', 'MUTATION'], `${fn} got ${e}`);
      }
    });

    it('WebSocket listener registration (on/once/addEventListener) is MUTATION (EventEmitter precedent)', () => {
      const l = lookup();
      for (const fn of ['WebSocket.on', 'WebSocket.once', 'WebSocket.off', 'WebSocket.addEventListener', 'WebSocket.removeEventListener']) {
        const e = l.lookup('ws', fn);
        assert.deepEqual(e, ['MUTATION'], `${fn} got ${e}`);
      }
    });
  });

  describe('WebSocketServer — listen / upgrade IO (and the Server alias)', () => {
    it('WebSocketServer.new binds+listens (IO:SOCKET:LISTEN, ASYNC) and THROWs on missing port/server/noServer', () => {
      const e = lookup().lookup('ws', 'WebSocketServer.new');
      assert.ok(e, 'ws WebSocketServer.new must be annotated');
      assert.ok(e.includes('IO'), `expected IO, got ${e}`);
      assert.ok(e.includes('IO:SOCKET:LISTEN'), `expected IO:SOCKET:LISTEN, got ${e}`);
      assert.ok(e.includes('ASYNC'), `expected ASYNC, got ${e}`);
      assert.ok(e.includes('THROW'), `expected THROW (misconfigured options sync-throw), got ${e}`);
    });

    it('Server is an alias of WebSocketServer (same effects)', () => {
      const l = lookup();
      assert.deepEqual(
        l.lookup('ws', 'Server.new'),
        l.lookup('ws', 'WebSocketServer.new'),
        'Server.new must mirror WebSocketServer.new',
      );
    });

    it('WebSocketServer.close stops listening (IO, ASYNC)', () => {
      const e = lookup().lookup('ws', 'WebSocketServer.close');
      assert.ok(e && e.includes('IO') && e.includes('ASYNC'), `got ${e}`);
    });

    it('WebSocketServer.handleUpgrade writes the handshake response (IO:SOCKET:WRITE, ASYNC)', () => {
      const e = lookup().lookup('ws', 'WebSocketServer.handleUpgrade');
      assert.ok(e && e.includes('IO:SOCKET:WRITE') && e.includes('ASYNC'), `got ${e}`);
    });

    it('WebSocketServer.address is IO; shouldHandle is PURE (returns bool, never throws)', () => {
      const l = lookup();
      assert.deepEqual(l.lookup('ws', 'WebSocketServer.address'), ['IO'], 'address');
      assert.deepEqual(l.lookup('ws', 'WebSocketServer.shouldHandle'), ['PURE'], 'shouldHandle');
    });
  });

  describe('createWebSocketStream — wires a socket into a Duplex', () => {
    it('createWebSocketStream attaches listeners (MUTATION) and THROWs on a bad arg; no socket IO at call time', () => {
      const e = lookup().lookup('ws', 'createWebSocketStream');
      assert.ok(e, 'ws createWebSocketStream must be annotated');
      assert.ok(e.includes('MUTATION'), `expected MUTATION, got ${e}`);
      assert.ok(e.includes('THROW'), `expected THROW (no-arg throws), got ${e}`);
      assert.ok(
        !e.some(t => t === 'IO' || t.startsWith('IO:')),
        `createWebSocketStream itself does no socket IO at call time, got ${e}`,
      );
    });
  });

  describe('functional propagation via traceEffects', () => {
    it('a function calling ws.WebSocket.send inherits IO + IO:SOCKET:WRITE', async () => {
      const effectsLookup = lookup();
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'pushFrame', file: 'src/realtime.ts', line: 1 },
        { id: 'ext1', type: 'EXTERNAL_FUNCTION', name: 'ws.WebSocket.send', file: undefined },
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
      assert.equal(result.leaf_sources[0].node, 'ws.WebSocket.send');
    });

    it('a function calling ws.WebSocketServer.new inherits IO + IO:SOCKET:LISTEN', async () => {
      const effectsLookup = lookup();
      const nodes = [
        { id: 'fn2', type: 'FUNCTION', name: 'startServer', file: 'src/server.ts', line: 1 },
        { id: 'ext2', type: 'EXTERNAL_FUNCTION', name: 'ws.WebSocketServer.new', file: undefined },
      ];
      const edges = [{ src: 'fn2', dst: 'ext2', type: 'CALLS' }];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn2', effectsLookup);
      assert.ok(result, 'expected non-null trace result');
      assert.ok(
        result.transitive.includes('IO:SOCKET:LISTEN'),
        `expected IO:SOCKET:LISTEN in transitive, got ${result.transitive}`,
      );
    });
  });
});
