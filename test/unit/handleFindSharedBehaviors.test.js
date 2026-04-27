/**
 * Tests for MCP `find_shared_behaviors` handler logic — REG-1119.
 *
 * Mirrors the CLI featuresAction tests (same fixture shape, same scenarios)
 * to keep the two surfaces symmetric. We import the internal logic function
 * `findSharedBehaviorsLogic` and exercise it with a mock backend, the same
 * pattern used by mcp-graph-handlers.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findSharedBehaviorsLogic } from '../../packages/mcp/dist/handlers/behavior-handlers.js';

// ---------------------------------------------------------------------------
// Mock backend (same shape as featuresAction.test.js)
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
// Helpers
// ---------------------------------------------------------------------------

function getJson(result) {
  assert.equal(result.isError, undefined, 'result should not be an error');
  const text = result.content[0].text;
  return JSON.parse(text);
}

function isError(result) {
  return result.isError === true;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyGraph() {
  return makeBackend([], []);
}

function singleClusterGraph() {
  const HASH = 'a'.repeat(64);
  const nodes = [
    { id: 'feat:cli:analyze', type: 'cli:command', name: 'analyze', file: 'src/cli.ts' },
    { id: 'feat:mcp:analyze', type: 'mcp:tool', name: 'analyze_project', file: 'src/mcp.ts' },
    { id: 'feat:cli:analyze::behavior', type: 'BEHAVIOR', name: 'analyze', file: 'src/cli.ts', hash: HASH, effects: ['IO'], coreNodeCount: 12 },
    { id: 'feat:mcp:analyze::behavior', type: 'BEHAVIOR', name: 'analyze_project', file: 'src/mcp.ts', hash: HASH, effects: ['IO'], coreNodeCount: 12 },
  ];
  const edges = [
    { src: 'feat:cli:analyze', dst: 'feat:cli:analyze::behavior', type: 'IMPLEMENTED_BY' },
    { src: 'feat:mcp:analyze', dst: 'feat:mcp:analyze::behavior', type: 'IMPLEMENTED_BY' },
  ];
  return makeBackend(nodes, edges);
}

function multiClusterGraph() {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const HASH_SOLO = 'c'.repeat(64);
  const nodes = [
    { id: 'cli:foo', type: 'cli:command', name: 'foo', file: 'a.ts' },
    { id: 'vscode:foo', type: 'vscode:command', name: 'foo', file: 'b.ts' },
    { id: 'cli:foo::behavior', type: 'BEHAVIOR', name: 'foo', file: 'a.ts', hash: HASH_A, effects: ['IO', 'THROW'], coreNodeCount: 5 },
    { id: 'vscode:foo::behavior', type: 'BEHAVIOR', name: 'foo', file: 'b.ts', hash: HASH_A, effects: ['IO', 'THROW'], coreNodeCount: 5 },
    { id: 'mcp:bar', type: 'mcp:tool', name: 'bar', file: 'c.ts' },
    { id: 'cli:bar', type: 'cli:command', name: 'bar', file: 'd.ts' },
    { id: 'mcp:bar::behavior', type: 'BEHAVIOR', name: 'bar', file: 'c.ts', hash: HASH_B, effects: '["MUTATION"]', coreNodeCount: 3 },
    { id: 'cli:bar::behavior', type: 'BEHAVIOR', name: 'bar', file: 'd.ts', hash: HASH_B, effects: '["MUTATION"]', coreNodeCount: 3 },
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

describe('handleFindSharedBehaviors (logic)', () => {
  it('empty graph: 0 clusters, valid JSON shape', async () => {
    const result = await findSharedBehaviorsLogic(emptyGraph(), {});
    const json = getJson(result);
    assert.equal(json.count, 0);
    assert.equal(json.truncated, false);
    assert.deepEqual(json.clusters, []);
    assert.equal(json.minClusterSize, 2);
  });

  it('single cluster of size 2: returns one cluster with matching effects', async () => {
    const result = await findSharedBehaviorsLogic(singleClusterGraph(), {});
    const json = getJson(result);
    assert.equal(json.count, 1);
    assert.equal(json.clusters.length, 1);
    const cluster = json.clusters[0];
    assert.equal(cluster.features.length, 2);
    assert.deepEqual(cluster.effects, ['IO']);
    assert.equal(cluster.coreNodeCount, 12);

    // Sorted by type — cli:command before mcp:tool.
    assert.equal(cluster.features[0].type, 'cli:command');
    assert.equal(cluster.features[1].type, 'mcp:tool');
  });

  it('multi-cluster: returns 2 clusters ordered by hash; solo excluded', async () => {
    const result = await findSharedBehaviorsLogic(multiClusterGraph(), {});
    const json = getJson(result);
    assert.equal(json.count, 2);
    assert.equal(json.clusters[0].hash[0], 'a', 'hash a... ordered before b... at equal size');
    assert.deepEqual(json.clusters[1].effects, ['MUTATION'], 'JSON-string effects parsed');

    for (const cluster of json.clusters) {
      for (const f of cluster.features) {
        assert.notEqual(f.name, 'solo', 'solo FEATURE never appears');
      }
    }
  });

  it('limit option truncates and sets truncated=true', async () => {
    const result = await findSharedBehaviorsLogic(multiClusterGraph(), { limit: 1 });
    const json = getJson(result);
    assert.equal(json.count, 1);
    assert.equal(json.truncated, true);
  });

  it('minClusterSize=3 returns no clusters in 2-feature fixture', async () => {
    const result = await findSharedBehaviorsLogic(multiClusterGraph(), { minClusterSize: 3 });
    const json = getJson(result);
    assert.equal(json.count, 0);
    assert.equal(json.minClusterSize, 3);
  });

  it('rejects negative minClusterSize', async () => {
    const result = await findSharedBehaviorsLogic(emptyGraph(), { minClusterSize: -1 });
    assert.ok(isError(result), 'negative minClusterSize should be an error');
  });

  it('rejects non-positive limit', async () => {
    const result = await findSharedBehaviorsLogic(emptyGraph(), { limit: 0 });
    assert.ok(isError(result), 'limit=0 should be an error');
  });
});
