/**
 * effectsDbUuid.test.js — effects-db annotation coverage for the `uuid` package.
 *
 * `uuid` is one of the most-depended-upon npm packages; before this entry its
 * generators were UNKNOWN to the effect tracer. The random/time-based factories
 * (v1/v4/v6/v7) are NONDETERMINISTIC — matching the runtime convention already
 * used for `crypto.randomUUID` (effects-db/runtimes/node.yaml) — while the
 * name-based factories (v3/v5) and the parse/stringify/validate helpers are PURE
 * (the validating helpers additionally THROW on malformed input).
 *
 * Verification is functional and backend-free: we drive `traceEffects` over a
 * mock graph whose EXTERNAL_MODULE leaf is a real `uuid.*` call name, and assert
 * the effects resolved from effects-db. This is the verifiable path per the
 * effects-db PR convention (plain effect arrays, no receiver-tracing entries).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { traceEffects, EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/** Create a mock DataflowBackend from arrays of nodes and edges. */
function createMockBackend(nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    async getNode(id) {
      return nodeMap.get(id) || null;
    },
    async *queryNodes(filter) {
      for (const n of nodes) {
        if (filter.type && n.type !== filter.type) continue;
        if (filter.name && n.name !== filter.name) continue;
        yield n;
      }
    },
    async getOutgoingEdges(id, types) {
      return edges.filter((e) => e.src === id && (!types || types.includes(e.type)));
    },
    async getIncomingEdges(id, types) {
      return edges.filter((e) => e.dst === id && (!types || types.includes(e.type)));
    },
  };
}

/** Trace a caller FUNCTION that calls a single EXTERNAL_MODULE named `callName`. */
async function traceSingleCall(callName) {
  const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const nodes = [
    { id: 'caller', type: 'FUNCTION', name: 'caller', file: 'src/a.ts', line: 1 },
    { id: 'ext', type: 'EXTERNAL_MODULE', name: callName, file: undefined },
  ];
  const edges = [{ src: 'caller', dst: 'ext', type: 'CALLS' }];
  return traceEffects(createMockBackend(nodes, edges), 'caller', effectsLookup);
}

describe('effects-db: uuid', () => {
  describe('direct EffectsLookup', () => {
    const lookup = EffectsLookup.load(EFFECTS_DB_PATH);

    it('random/time-based generators are NONDETERMINISTIC', () => {
      for (const fn of ['v1', 'v4', 'v6', 'v7']) {
        assert.deepEqual(
          lookup.lookup('uuid', fn),
          ['NONDETERMINISTIC'],
          `uuid.${fn} should be NONDETERMINISTIC`,
        );
      }
    });

    it('name-based generators (v3/v5) are PURE but may THROW on bad namespace', () => {
      for (const fn of ['v3', 'v5']) {
        const effects = lookup.lookup('uuid', fn);
        assert.ok(effects.includes('PURE'), `uuid.${fn} should include PURE, got: ${effects}`);
        assert.ok(effects.includes('THROW'), `uuid.${fn} should include THROW, got: ${effects}`);
        assert.ok(
          !effects.includes('NONDETERMINISTIC'),
          `uuid.${fn} is deterministic, should NOT be NONDETERMINISTIC`,
        );
      }
    });

    it('validating helpers parse/stringify/version are PURE + THROW', () => {
      for (const fn of ['parse', 'stringify', 'version']) {
        const effects = lookup.lookup('uuid', fn);
        assert.ok(effects, `uuid.${fn} should be annotated`);
        assert.ok(effects.includes('THROW'), `uuid.${fn} should include THROW, got: ${effects}`);
      }
    });

    it('validate is PURE (never throws)', () => {
      assert.deepEqual(lookup.lookup('uuid', 'validate'), ['PURE']);
    });

    it('resolves via lookupByCallName for a qualified call name', () => {
      assert.deepEqual(lookup.lookupByCallName('uuid.v4'), ['NONDETERMINISTIC']);
    });
  });

  describe('functional traceEffects', () => {
    it('uuid.v4 call surfaces NONDETERMINISTIC transitively', async () => {
      const result = await traceSingleCall('uuid.v4');
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.transitive.includes('NONDETERMINISTIC'),
        `Expected NONDETERMINISTIC in transitive effects, got: ${result.transitive}`,
      );
      assert.equal(result.leaf_sources[0].node, 'uuid.v4');
    });

    it('uuid.v5 call is deterministic (never NONDETERMINISTIC)', async () => {
      const result = await traceSingleCall('uuid.v5');
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        !result.transitive.includes('NONDETERMINISTIC'),
        `uuid.v5 is a deterministic hash, got: ${result.transitive}`,
      );
    });

    it('uuid.parse call surfaces THROW transitively', async () => {
      const result = await traceSingleCall('uuid.parse');
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.transitive.includes('THROW'),
        `Expected THROW in transitive effects, got: ${result.transitive}`,
      );
    });
  });
});
