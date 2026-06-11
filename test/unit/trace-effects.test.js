import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { traceEffects, EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/**
 * Create a mock DataflowBackend from arrays of nodes and edges.
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

describe('traceEffects', () => {
  describe('direct call to external module', () => {
    it('shows effects from effects-db for external module call', async () => {
      const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'myFunc', file: 'src/a.ts', line: 1 },
        { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'fs.readFileSync', file: undefined },
      ];
      const edges = [
        { src: 'fn1', dst: 'ext1', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.transitive.includes('IO'),
        `Expected IO in transitive effects, got: ${result.transitive}`,
      );
      assert.ok(
        result.leaf_sources.length > 0,
        'Expected at least one leaf source',
      );
      assert.equal(result.leaf_sources[0].node, 'fs.readFileSync');
    });
  });

  describe('transitive chain A -> B -> external', () => {
    it('propagates effects transitively through internal calls', async () => {
      const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const nodes = [
        { id: 'fnA', type: 'FUNCTION', name: 'A', file: 'src/a.ts', line: 1 },
        { id: 'fnB', type: 'FUNCTION', name: 'B', file: 'src/a.ts', line: 10 },
        { id: 'ext1', type: 'EXTERNAL_MODULE', name: 'fs.readFileSync', file: undefined },
      ];
      const edges = [
        { src: 'fnA', dst: 'fnB', type: 'CALLS' },
        { src: 'fnB', dst: 'ext1', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fnA', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.transitive.includes('IO'),
        `Expected IO in transitive effects, got: ${result.transitive}`,
      );
      // Leaf is at depth 1 (B calls ext at depth=1 relative to B's DFS entry)
      assert.ok(result.leaf_sources.length > 0, 'Expected leaf sources');
    });
  });

  describe('cycle detection', () => {
    it('terminates without infinite loop on cycles', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'fnA', type: 'FUNCTION', name: 'A', file: 'src/a.ts', line: 1 },
        { id: 'fnB', type: 'FUNCTION', name: 'B', file: 'src/a.ts', line: 10 },
      ];
      const edges = [
        { src: 'fnA', dst: 'fnB', type: 'CALLS' },
        { src: 'fnB', dst: 'fnA', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fnA', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.equal(result.nodes_visited, 2, 'Should visit both nodes exactly once');
    });
  });

  describe('depth limit', () => {
    it('adds UNKNOWN when max depth is reached', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'f1', type: 'FUNCTION', name: 'f1', file: 'src/a.ts', line: 1 },
        { id: 'f2', type: 'FUNCTION', name: 'f2', file: 'src/a.ts', line: 10 },
        { id: 'f3', type: 'FUNCTION', name: 'f3', file: 'src/a.ts', line: 20 },
        { id: 'f4', type: 'FUNCTION', name: 'f4', file: 'src/a.ts', line: 30 },
        { id: 'f5', type: 'FUNCTION', name: 'f5', file: 'src/a.ts', line: 40 },
      ];
      const edges = [
        { src: 'f1', dst: 'f2', type: 'CALLS' },
        { src: 'f2', dst: 'f3', type: 'CALLS' },
        { src: 'f3', dst: 'f4', type: 'CALLS' },
        { src: 'f4', dst: 'f5', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'f1', effectsLookup, { maxDepth: 2 });
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.transitive.includes('UNKNOWN'),
        `Expected UNKNOWN in transitive effects due to depth limit, got: ${result.transitive}`,
      );
      assert.equal(result.max_depth_reached, true, 'max_depth_reached should be true');
    });
  });

  describe('boundary crossings tracked', () => {
    it('records crossing when caller and callee are in different files', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'fnA', type: 'FUNCTION', name: 'A', file: 'src/a.ts', line: 1 },
        { id: 'fnB', type: 'FUNCTION', name: 'B', file: 'src/b.ts', line: 1 },
      ];
      const edges = [
        { src: 'fnA', dst: 'fnB', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fnA', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.boundary_crossings.length > 0,
        'Expected at least one boundary crossing',
      );
      const crossing = result.boundary_crossings[0];
      assert.equal(crossing.from_file, 'src/a.ts');
      assert.equal(crossing.to_file, 'src/b.ts');
      assert.equal(crossing.caller, 'A');
      assert.equal(crossing.callee, 'B');
    });
  });

  describe('pure function', () => {
    it('returns PURE when function has no calls and no metadata effects', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'pure1', type: 'FUNCTION', name: 'pure', file: 'src/a.ts', line: 1 },
      ];
      const edges = [];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'pure1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.deepEqual(result.transitive, ['PURE']);
      assert.deepEqual(result.direct, ['PURE']);
    });
  });

  describe('async function detected from metadata', () => {
    it('includes ASYNC in direct and transitive effects', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'async1', type: 'FUNCTION', name: 'asyncFn', file: 'src/a.ts', line: 1, async: true },
      ];
      const edges = [];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'async1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.direct.includes('ASYNC'),
        `Expected ASYNC in direct effects, got: ${result.direct}`,
      );
      assert.ok(
        result.transitive.includes('ASYNC'),
        `Expected ASYNC in transitive effects, got: ${result.transitive}`,
      );
    });
  });

  describe('node not found', () => {
    it('returns null for nonexistent node', async () => {
      const effectsLookup = EffectsLookup.empty();
      const backend = createMockBackend([], []);

      const result = await traceEffects(backend, 'nonexistent-id', effectsLookup);
      assert.equal(result, null);
    });
  });

  describe('GLOBAL_DEFINITION with metadata effects', () => {
    it('reads effects from node metadata instead of effects-db lookup', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'myFunc', file: 'src/a.hs', line: 1 },
        { id: 'glob1', type: 'GLOBAL_DEFINITION', name: 'hPutStrLn', file: undefined, effects: ['IO'] },
      ];
      const edges = [
        { src: 'fn1', dst: 'glob1', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.transitive.includes('IO'),
        `Expected IO in transitive effects from metadata, got: ${result.transitive}`,
      );
      assert.ok(result.leaf_sources.length > 0, 'Expected leaf sources');
      assert.equal(result.leaf_sources[0].node, 'hPutStrLn');
      assert.deepEqual(result.leaf_sources[0].effects, ['IO']);
    });

    it('uses PURE when metadata effects are all PURE', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'myFunc', file: 'src/a.hs', line: 1 },
        { id: 'glob1', type: 'GLOBAL_DEFINITION', name: 'Just', file: undefined, effects: ['PURE'] },
      ];
      const edges = [
        { src: 'fn1', dst: 'glob1', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.deepEqual(result.transitive, ['PURE']);
      assert.ok(result.leaf_sources.length > 0, 'Expected leaf sources');
      assert.deepEqual(result.leaf_sources[0].effects, ['PURE']);
    });

    // Pins the datalog2 js_runtime_globals_nodes pack contract (Wave 4 DELTA 1):
    // @materialize_node meta() projects string surfaces, so pack-minted
    // GLOBAL_DEFINITION nodes carry effects as a comma-joined STRING, not the
    // legacy JSON array. trace_effects must read leaf effects from that shape.
    it('pack-minted node (comma-joined effects string): reads leaf effects', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'myFunc', file: 'src/a.ts', line: 1 },
        // bare dotless seName ("readFile") — the parseCallTarget fallback would
        // return null for it, so the metadata path MUST carry the effects
        { id: 'glob1', type: 'GLOBAL_DEFINITION', name: 'readFile', file: undefined, effects: 'IO,THROW' },
      ];
      const edges = [
        { src: 'fn1', dst: 'glob1', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.transitive.includes('IO') && result.transitive.includes('THROW'),
        `Expected IO and THROW from comma-joined metadata string, got: ${result.transitive}`,
      );
      assert.ok(result.leaf_sources.length > 0, 'Expected leaf sources');
      assert.equal(result.leaf_sources[0].node, 'readFile');
      assert.deepEqual(result.leaf_sources[0].effects.sort(), ['IO', 'THROW']);
    });

    it('pack-minted node with single PURE effect string resolves to PURE', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'myFunc', file: 'src/a.hs', line: 1 },
        { id: 'glob1', type: 'GLOBAL_DEFINITION', name: 'True', file: undefined, effects: 'PURE' },
      ];
      const edges = [
        { src: 'fn1', dst: 'glob1', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.deepEqual(result.transitive, ['PURE']);
      assert.ok(result.leaf_sources.length > 0, 'Expected leaf sources');
      assert.deepEqual(result.leaf_sources[0].effects, ['PURE']);
    });

    it('falls back to effects-db when metadata effects not present', async () => {
      const effectsLookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const nodes = [
        { id: 'fn1', type: 'FUNCTION', name: 'myFunc', file: 'src/a.ts', line: 1 },
        { id: 'glob1', type: 'GLOBAL_DEFINITION', name: 'fs.readFileSync', file: undefined },
      ];
      const edges = [
        { src: 'fn1', dst: 'glob1', type: 'CALLS' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fn1', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.transitive.includes('IO'),
        `Expected IO from effects-db fallback, got: ${result.transitive}`,
      );
    });
  });

  describe('CALLS_REMOTE edge', () => {
    it('marks boundary crossing same as CALLS', async () => {
      const effectsLookup = EffectsLookup.empty();
      const nodes = [
        { id: 'fnA', type: 'FUNCTION', name: 'A', file: 'src/a.ts', line: 1 },
        { id: 'fnB', type: 'FUNCTION', name: 'B', file: 'src/b.ts', line: 1 },
      ];
      const edges = [
        { src: 'fnA', dst: 'fnB', type: 'CALLS_REMOTE' },
      ];
      const backend = createMockBackend(nodes, edges);

      const result = await traceEffects(backend, 'fnA', effectsLookup);
      assert.ok(result, 'Expected non-null result');
      assert.ok(
        result.boundary_crossings.length > 0,
        'Expected boundary crossing for CALLS_REMOTE edge',
      );
      const crossing = result.boundary_crossings[0];
      assert.equal(crossing.from_file, 'src/a.ts');
      assert.equal(crossing.to_file, 'src/b.ts');
    });
  });
});
