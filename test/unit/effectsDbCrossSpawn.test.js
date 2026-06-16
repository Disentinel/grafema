/**
 * effects-db annotation tests for `cross-spawn`.
 *
 * cross-spawn is a near-ubiquitous npm package (a dependency of npm itself and
 * most CLI tooling) and a drop-in replacement for node:child_process spawn /
 * spawnSync. Before this annotation it was UNKNOWN to the effect tracer, so any
 * function spawning a subprocess through cross-spawn lost its IO:PROCESS:SPAWN
 * signal. These tests pin the annotation as a process-spawn carrier that mirrors
 * the node:child_process precedent (node.yaml:257-278) and participates in the
 * subprocess-cli / subprocess-stdio bridges via `channel.binary = arg[0]`.
 *
 * Effect values were derived from a REAL probe of cross-spawn@7.0.6, not memory:
 *   - default export === the spawn function; own keys: spawn, sync, _parse, _enoent
 *   - spawn(cmd, args) returns a ChildProcess SYNCHRONOUSLY (subprocess runs
 *     async, but the call itself does not await) -> no ASYNC, same as node spawn
 *   - spawn(123) / sync(123) THROW synchronously (TypeError from validateString)
 *   - a missing binary emits an async 'error' event (NOT a sync throw)
 *   - _parse / _enoent are underscore-prefixed internals, not public call API
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup, traceEffects } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/** Mock DataflowBackend from arrays of nodes and edges (mirrors trace-effects.test.js). */
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

describe('effects-db: cross-spawn', () => {
  describe('default export (spawn function, keyed module.module like minimatch/express)', () => {
    it('cross-spawn.cross-spawn includes IO', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('cross-spawn', 'cross-spawn');
      assert.ok(effects, 'Expected effects for cross-spawn default export');
      assert.ok(effects.includes('IO'), `Expected IO, got: ${effects}`);
    });

    it('cross-spawn.cross-spawn carries IO:PROCESS:SPAWN', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('cross-spawn', 'cross-spawn');
      assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN, got: ${effects}`);
    });

    it('cross-spawn.cross-spawn THROWs (sync TypeError on bad command arg)', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('cross-spawn', 'cross-spawn');
      assert.ok(effects.includes('THROW'), `Expected THROW, got: ${effects}`);
    });

    it('cross-spawn.cross-spawn is NOT ASYNC (spawn returns ChildProcess synchronously)', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('cross-spawn', 'cross-spawn');
      assert.ok(!effects.includes('ASYNC'), `Expected no ASYNC for sync-returning spawn, got: ${effects}`);
    });
  });

  describe('named property exports (probe: own keys spawn, sync)', () => {
    it('cross-spawn.spawn matches the default export effects exactly', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const dflt = lookup.lookup('cross-spawn', 'cross-spawn');
      const spawn = lookup.lookup('cross-spawn', 'spawn');
      assert.ok(spawn, 'Expected effects for cross-spawn.spawn property');
      assert.deepEqual(spawn, dflt, 'cross-spawn.spawn should equal the default spawn export');
    });

    it('cross-spawn.sync (spawnSync) carries IO:PROCESS:SPAWN + THROW, no ASYNC', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('cross-spawn', 'sync');
      assert.ok(effects, 'Expected effects for cross-spawn.sync');
      assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN, got: ${effects}`);
      assert.ok(effects.includes('THROW'), `Expected THROW, got: ${effects}`);
      assert.ok(!effects.includes('ASYNC'), `Expected no ASYNC for sync form, got: ${effects}`);
    });
  });

  describe('bridge channel metadata (subprocess-cli / subprocess-stdio sender)', () => {
    it('default export declares channel.binary = arg[0] for binary_name matching', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const entry = lookup.getEntry('cross-spawn', 'cross-spawn');
      assert.ok(entry, 'Expected entry for cross-spawn default export');
      assert.ok(entry.channel, 'Expected channel metadata');
      assert.equal(entry.channel.binary, 'arg[0]');
    });

    it('sync form declares channel.binary = arg[0]', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const entry = lookup.getEntry('cross-spawn', 'sync');
      assert.ok(entry.channel, 'Expected channel metadata on sync');
      assert.equal(entry.channel.binary, 'arg[0]');
    });
  });

  describe('internal helpers are not part of the public effect surface', () => {
    it('cross-spawn._parse is not annotated (underscore internal)', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      assert.equal(lookup.lookup('cross-spawn', '_parse'), null);
    });

    it('cross-spawn._enoent is not annotated (underscore internal)', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      assert.equal(lookup.lookup('cross-spawn', '_enoent'), null);
    });
  });

  describe('functional traceEffects over an EXTERNAL_MODULE cross-spawn leaf', () => {
    it('a caller spawning via cross-spawn.sync inherits IO + IO:PROCESS:SPAWN', async () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'runTool', file: 'src/run.ts', line: 1 },
        { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'cross-spawn.sync', file: undefined },
      ];
      const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', lookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(result.transitive.includes('IO'), `Expected IO, got: ${result.transitive}`);
      assert.ok(
        result.transitive.includes('IO:PROCESS:SPAWN'),
        `Expected IO:PROCESS:SPAWN, got: ${result.transitive}`,
      );
      assert.equal(result.leaf_sources[0].node, 'cross-spawn.sync');
    });

    it('a caller spawning via the default cross-spawn export inherits THROW', async () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'launch', file: 'src/run.ts', line: 1 },
        { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'cross-spawn.cross-spawn', file: undefined },
      ];
      const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', lookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(result.transitive.includes('THROW'), `Expected THROW, got: ${result.transitive}`);
    });
  });
});
