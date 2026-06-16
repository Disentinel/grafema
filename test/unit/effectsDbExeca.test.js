import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { traceEffects, EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/**
 * Minimal DataflowBackend mock — mirrors test/unit/trace-effects.test.js.
 * Lets us drive traceEffects over a hand-built graph whose leaf is an
 * EXTERNAL_MODULE pointing at an `execa.<fn>` annotation.
 */
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

describe('effects-db: execa', () => {
  describe('direct lookups (effects-db/packages/execa.yaml)', () => {
    it('execa() is an async, throwing process spawn', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('execa', 'execa');
      assert.ok(effects, 'Expected effects for execa.execa');
      assert.ok(effects.includes('IO'), `Expected IO, got: ${effects}`);
      assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN, got: ${effects}`);
      assert.ok(effects.includes('ASYNC'), `Expected ASYNC, got: ${effects}`);
      assert.ok(effects.includes('THROW'), `Expected THROW, got: ${effects}`);
    });

    it('execaSync() spawns synchronously (THROW, no ASYNC)', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('execa', 'execaSync');
      assert.ok(effects, 'Expected effects for execa.execaSync');
      assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN, got: ${effects}`);
      assert.ok(effects.includes('THROW'), `Expected THROW, got: ${effects}`);
      assert.ok(!effects.includes('ASYNC'), `Sync variant must not be ASYNC, got: ${effects}`);
    });

    it('the $ template tag is an async process spawn', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('execa', '$');
      assert.ok(effects, 'Expected effects for execa.$');
      assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN, got: ${effects}`);
      assert.ok(effects.includes('ASYNC'), `Expected ASYNC, got: ${effects}`);
    });

    it('$.sync is a synchronous spawn (THROW, no ASYNC)', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('execa', '$.sync');
      assert.ok(effects, 'Expected effects for execa.$.sync');
      assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN, got: ${effects}`);
      assert.ok(effects.includes('THROW'), `Expected THROW, got: ${effects}`);
      assert.ok(!effects.includes('ASYNC'), `Sync variant must not be ASYNC, got: ${effects}`);
    });

    it('execaCommand / execaNode spawn asynchronously', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      for (const fn of ['execaCommand', 'execaNode']) {
        const effects = lookup.lookup('execa', fn);
        assert.ok(effects, `Expected effects for execa.${fn}`);
        assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN for ${fn}, got: ${effects}`);
        assert.ok(effects.includes('ASYNC'), `Expected ASYNC for ${fn}, got: ${effects}`);
      }
    });

    it('execaCommandSync spawns synchronously (no ASYNC)', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('execa', 'execaCommandSync');
      assert.ok(effects, 'Expected effects for execa.execaCommandSync');
      assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN, got: ${effects}`);
      assert.ok(!effects.includes('ASYNC'), `Sync variant must not be ASYNC, got: ${effects}`);
    });

    it('v5 CJS property forms (.sync/.command/.commandSync/.node) are annotated', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      // async forms
      for (const fn of ['command', 'node']) {
        const effects = lookup.lookup('execa', fn);
        assert.ok(effects, `Expected effects for execa.${fn} (v5 form)`);
        assert.ok(effects.includes('IO:PROCESS:SPAWN'), `Expected IO:PROCESS:SPAWN for ${fn}, got: ${effects}`);
        assert.ok(effects.includes('ASYNC'), `Expected ASYNC for ${fn}, got: ${effects}`);
      }
      // sync forms
      for (const fn of ['sync', 'commandSync']) {
        const effects = lookup.lookup('execa', fn);
        assert.ok(effects, `Expected effects for execa.${fn} (v5 form)`);
        assert.ok(effects.includes('THROW'), `Expected THROW for ${fn}, got: ${effects}`);
        assert.ok(!effects.includes('ASYNC'), `${fn} must not be ASYNC, got: ${effects}`);
      }
    });

    it('execa spawn entries carry channel.binary = arg[0] for bridge detection', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const entry = lookup.getEntry('execa', 'execa');
      assert.ok(entry, 'Expected entry for execa.execa');
      assert.ok(entry.channel, 'Expected channel metadata on execa.execa');
      assert.equal(entry.channel.binary, 'arg[0]');
    });
  });

  describe('functional propagation through traceEffects', () => {
    it('propagates IO:PROCESS:SPAWN from an execa leaf to its caller', async () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'runBuild', file: 'src/build.ts', line: 1 },
        { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'execa.execa', file: undefined },
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
      assert.equal(result.leaf_sources[0].node, 'execa.execa');
    });
  });
});
