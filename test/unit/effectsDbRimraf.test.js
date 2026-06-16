import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { traceEffects, EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/**
 * Create a mock DataflowBackend from arrays of nodes and edges.
 * Mirrors trace-effects.test.js so the rimraf annotation is exercised
 * through the real traceEffects propagation path, not just raw lookup.
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

/**
 * REG/effects-db: rimraf annotation.
 *
 * rimraf is `rm -rf` — recursive filesystem delete. The closest runtime
 * precedent is node:fs `rm`/`rmSync` which the effects-db annotates as
 * [IO, ASYNC, MUTATION] / [IO, MUTATION] — deliberately NOT IO:FILE:WRITE
 * (delete is a filesystem mutation, not a content write) and NOT THROW.
 * rimraf mirrors that precedent for cross-source consistency: `rm -rf`
 * via node:fs and via rimraf must report identical effects.
 */
describe('effects-db: rimraf', () => {
  const lookup = () => EffectsLookup.load(EFFECTS_DB_PATH);

  describe('async delete forms → [IO, ASYNC, MUTATION]', () => {
    for (const fn of ['rimraf', 'native', 'manual', 'posix', 'windows', 'moveRemove']) {
      it(`rimraf.${fn} mirrors node:fs rm`, () => {
        const effects = lookup().lookup('rimraf', fn);
        assert.ok(effects, `Expected effects for rimraf.${fn}`);
        assert.deepEqual(effects, ['IO', 'ASYNC', 'MUTATION']);
      });
    }
  });

  describe('sync delete forms → [IO, MUTATION] (no ASYNC)', () => {
    for (const fn of ['rimrafSync', 'sync', 'nativeSync', 'manualSync', 'posixSync', 'windowsSync', 'moveRemoveSync']) {
      it(`rimraf.${fn} mirrors node:fs rmSync`, () => {
        const effects = lookup().lookup('rimraf', fn);
        assert.ok(effects, `Expected effects for rimraf.${fn}`);
        assert.deepEqual(effects, ['IO', 'MUTATION']);
        assert.ok(!effects.includes('ASYNC'), `sync form must not be ASYNC, got: ${effects}`);
      });
    }
  });

  describe('option helpers', () => {
    it('isRimrafOptions is PURE (type guard, returns bool, never throws)', () => {
      const effects = lookup().lookup('rimraf', 'isRimrafOptions');
      assert.deepEqual(effects, ['PURE']);
    });

    it('assertRimrafOptions is THROW (validator, throws on invalid options)', () => {
      const effects = lookup().lookup('rimraf', 'assertRimrafOptions');
      assert.deepEqual(effects, ['THROW']);
    });
  });

  describe('NOT a file-ipc bridge sender (delete ≠ content write)', () => {
    it('no rimraf delete form carries IO:FILE:WRITE', () => {
      const l = lookup();
      for (const fn of ['rimraf', 'rimrafSync', 'native', 'manual', 'moveRemove']) {
        const effects = l.lookup('rimraf', fn);
        assert.ok(
          !effects.includes('IO:FILE:WRITE'),
          `rimraf.${fn} must mirror node rm (plain IO, not IO:FILE:WRITE), got: ${effects}`,
        );
      }
    });
  });

  describe('traceEffects propagation through a real EXTERNAL_MODULE leaf', () => {
    it('async rimraf propagates IO + ASYNC + MUTATION to the caller', async () => {
      const effectsLookup = lookup();
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'cleanup', file: 'src/a.ts', line: 1 },
        { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'rimraf.rimraf', file: undefined },
      ];
      const edges = [{ src: 'fn1', dst: 'ext1', type: 'CALLS' }];
      const result = await traceEffects(createMockBackend(nodes, edges), 'fn1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(result.transitive.includes('IO'), `Expected IO, got: ${result.transitive}`);
      assert.ok(result.transitive.includes('ASYNC'), `Expected ASYNC, got: ${result.transitive}`);
      assert.ok(result.transitive.includes('MUTATION'), `Expected MUTATION, got: ${result.transitive}`);
      assert.equal(result.leaf_sources[0].node, 'rimraf.rimraf');
    });

    it('sync rimrafSync propagates IO + MUTATION but not ASYNC', async () => {
      const effectsLookup = lookup();
      const nodes = [
        { id: 'fn2', type: 'FUNCTION', name: 'cleanupSync', file: 'src/a.ts', line: 1 },
        { id: 'ext2', type: 'EXTERNAL_MODULE', name: 'rimraf.rimrafSync', file: undefined },
      ];
      const edges = [{ src: 'fn2', dst: 'ext2', type: 'CALLS' }];
      const result = await traceEffects(createMockBackend(nodes, edges), 'fn2', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(result.transitive.includes('IO'), `Expected IO, got: ${result.transitive}`);
      assert.ok(result.transitive.includes('MUTATION'), `Expected MUTATION, got: ${result.transitive}`);
      assert.ok(!result.transitive.includes('ASYNC'), `Sync form must not be ASYNC, got: ${result.transitive}`);
    });
  });
});
