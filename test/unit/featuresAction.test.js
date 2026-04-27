/**
 * Tests for `grafema features --duplicates` action logic.
 *
 * REG-1119: surface FEATUREs that share a BEHAVIOR.
 *
 * Uses an in-memory mock backend that satisfies `FeaturesBackendLike`. We
 * deliberately don't spin up RFDB here — the algorithm is simple bucketing +
 * incoming-edge expansion and tests only the pure logic. The companion
 * MCP test (handleFindSharedBehaviors.test.js) exercises the same fixture
 * shape via the MCP handler logic, providing symmetry across channels.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findSharedBehaviorClusters,
  formatSharedBehaviorClusters,
} from '../../packages/cli/dist/commands/featuresAction.js';

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

function makeBackend(nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    async *queryNodes(query) {
      const wanted = query?.type ?? query?.nodeType ?? null;
      for (const n of nodes) {
        if (wanted && n.type !== wanted) continue;
        yield n;
      }
    },
    async getNode(id) {
      return nodeMap.get(id) ?? null;
    },
    async getIncomingEdges(nodeId, edgeTypes) {
      return edges.filter((e) => {
        if (e.dst !== nodeId) return false;
        if (edgeTypes && edgeTypes.length > 0 && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** No BEHAVIOR nodes at all — empty graph. */
function emptyGraph() {
  return makeBackend([], []);
}

/** Two FEATUREs sharing one hash → one cluster of size 2. */
function singleClusterGraph() {
  const nodes = [
    { id: 'feat:cli:analyze', type: 'cli:command', name: 'analyze', file: 'src/cli.ts' },
    { id: 'feat:mcp:analyze', type: 'mcp:tool', name: 'analyze_project', file: 'src/mcp.ts' },
    {
      id: 'feat:cli:analyze::behavior',
      type: 'BEHAVIOR',
      name: 'analyze',
      file: 'src/cli.ts',
      hash: 'a'.repeat(64),
      effects: ['IO'],
      coreNodeCount: 12,
    },
    {
      id: 'feat:mcp:analyze::behavior',
      type: 'BEHAVIOR',
      name: 'analyze_project',
      file: 'src/mcp.ts',
      hash: 'a'.repeat(64),
      effects: ['IO'],
      coreNodeCount: 12,
    },
  ];
  const edges = [
    { src: 'feat:cli:analyze', dst: 'feat:cli:analyze::behavior', type: 'IMPLEMENTED_BY' },
    { src: 'feat:mcp:analyze', dst: 'feat:mcp:analyze::behavior', type: 'IMPLEMENTED_BY' },
  ];
  return makeBackend(nodes, edges);
}

/**
 * Two clusters of size 2 + one solo behavior. Includes an effects array
 * encoded as JSON-string to verify defensive parsing.
 */
function multiClusterGraph() {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const HASH_SOLO = 'c'.repeat(64);

  const nodes = [
    // Cluster A: cli:foo + vscode:foo
    { id: 'cli:foo', type: 'cli:command', name: 'foo', file: 'a.ts' },
    { id: 'vscode:foo', type: 'vscode:command', name: 'foo', file: 'b.ts' },
    { id: 'cli:foo::behavior', type: 'BEHAVIOR', name: 'foo', file: 'a.ts', hash: HASH_A, effects: ['IO', 'THROW'], coreNodeCount: 5 },
    { id: 'vscode:foo::behavior', type: 'BEHAVIOR', name: 'foo', file: 'b.ts', hash: HASH_A, effects: ['IO', 'THROW'], coreNodeCount: 5 },
    // Cluster B: mcp:bar + cli:bar (effects encoded as JSON string)
    { id: 'mcp:bar', type: 'mcp:tool', name: 'bar', file: 'c.ts' },
    { id: 'cli:bar', type: 'cli:command', name: 'bar', file: 'd.ts' },
    { id: 'mcp:bar::behavior', type: 'BEHAVIOR', name: 'bar', file: 'c.ts', hash: HASH_B, effects: '["MUTATION"]', coreNodeCount: 3 },
    { id: 'cli:bar::behavior', type: 'BEHAVIOR', name: 'bar', file: 'd.ts', hash: HASH_B, effects: '["MUTATION"]', coreNodeCount: 3 },
    // Solo: not a duplicate
    { id: 'cli:solo', type: 'cli:command', name: 'solo', file: 'e.ts' },
    { id: 'cli:solo::behavior', type: 'BEHAVIOR', name: 'solo', file: 'e.ts', hash: HASH_SOLO, effects: [], coreNodeCount: 1 },
  ];
  const edges = [
    { src: 'cli:foo', dst: 'cli:foo::behavior', type: 'IMPLEMENTED_BY' },
    { src: 'vscode:foo', dst: 'vscode:foo::behavior', type: 'IMPLEMENTED_BY' },
    { src: 'mcp:bar', dst: 'mcp:bar::behavior', type: 'IMPLEMENTED_BY' },
    { src: 'cli:bar', dst: 'cli:bar::behavior', type: 'IMPLEMENTED_BY' },
    { src: 'cli:solo', dst: 'cli:solo::behavior', type: 'IMPLEMENTED_BY' },
  ];
  return makeBackend(nodes, edges);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('features --duplicates: findSharedBehaviorClusters', () => {
  it('empty graph returns no clusters', async () => {
    const result = await findSharedBehaviorClusters(emptyGraph());
    assert.deepEqual(result, []);
  });

  it('one cluster of size 2 across cli/mcp', async () => {
    const result = await findSharedBehaviorClusters(singleClusterGraph());
    assert.equal(result.length, 1);
    const cluster = result[0];
    assert.equal(cluster.features.length, 2);
    assert.equal(cluster.coreNodeCount, 12);
    assert.deepEqual(cluster.effects, ['IO']);

    // Features sorted by type then name — cli:command < mcp:tool alphabetically.
    assert.equal(cluster.features[0].type, 'cli:command');
    assert.equal(cluster.features[0].name, 'analyze');
    assert.equal(cluster.features[1].type, 'mcp:tool');
    assert.equal(cluster.features[1].name, 'analyze_project');

    // Hash is 64 hex chars.
    assert.match(cluster.hash, /^[0-9a-f]{64}$/);
  });

  it('multi-cluster: returns both, solo behaviors excluded; effects parsed from string', async () => {
    const result = await findSharedBehaviorClusters(multiClusterGraph());
    assert.equal(result.length, 2, 'only multi-feature clusters surface');

    // Both clusters have size 2 → tie broken by hash ascending (a... < b...).
    assert.ok(result[0].hash.startsWith('a'), 'cluster ordered by hash on equal sizes');
    assert.deepEqual(result[0].effects, ['IO', 'THROW']);
    assert.deepEqual(result[1].effects, ['MUTATION'], 'JSON-string-encoded effects must be parsed');

    // Solo behavior must NOT appear anywhere.
    for (const cluster of result) {
      for (const f of cluster.features) {
        assert.notEqual(f.name, 'solo', 'solo FEATURE must not appear');
      }
    }
  });

  it('respects minClusterSize threshold', async () => {
    const backend = multiClusterGraph();
    const result = await findSharedBehaviorClusters(backend, { minClusterSize: 3 });
    // No cluster has 3 features in our fixture.
    assert.equal(result.length, 0);
  });

  it('respects limit option', async () => {
    const backend = multiClusterGraph();
    const result = await findSharedBehaviorClusters(backend, { limit: 1 });
    assert.equal(result.length, 1, 'limit truncates result list');
  });

  it('clamps minClusterSize < 2 up to 2', async () => {
    const backend = singleClusterGraph();
    const result = await findSharedBehaviorClusters(backend, { minClusterSize: 0 });
    // Clamped to 2 → still finds the single shared cluster.
    assert.equal(result.length, 1);
  });

  it('format: empty result returns explanatory message', () => {
    const text = formatSharedBehaviorClusters([]);
    assert.match(text, /No FEATUREs share/);
  });

  it('format: non-empty result includes cluster count + feature list', () => {
    const clusters = [
      {
        hash: 'a'.repeat(64),
        effects: ['IO'],
        coreNodeCount: 5,
        features: [
          { id: 'cli:foo', type: 'cli:command', name: 'foo', file: 'a.ts' },
          { id: 'mcp:foo', type: 'mcp:tool', name: 'foo', file: 'b.ts' },
        ],
      },
    ];
    const text = formatSharedBehaviorClusters(clusters);
    assert.match(text, /Shared-behavior clusters: 1/);
    assert.match(text, /cli:command\s+foo/);
    assert.match(text, /mcp:tool\s+foo/);
    assert.match(text, /coreNodeCount: 5/);
  });
});
