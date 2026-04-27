/**
 * Tests for snapshot collection used by `grafema export` (REG-1116, REG-1118).
 *
 * Uses an in-memory mock backend to avoid spinning up RFDB. The traversal
 * logic is straightforward (queryNodes + getOutgoing/Incoming Edges + getNode),
 * so unit-level coverage of the wiring is sufficient.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectFeatureSnapshots,
  parseFeaturePattern,
  resolveCategories,
} from '@grafema/util/exporters/snapshot';

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
    async getOutgoingEdges(nodeId, edgeTypes) {
      return edges.filter((e) => {
        if (e.src !== nodeId) return false;
        if (edgeTypes && edgeTypes.length > 0 && !edgeTypes.includes(e.type)) return false;
        return true;
      });
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
// Pattern parsing
// ---------------------------------------------------------------------------
describe('parseFeaturePattern', () => {
  it('cli:* → category="cli:*", name="*"', () => {
    assert.deepEqual(parseFeaturePattern('cli:*'), { categoryGlob: 'cli:*', nameGlob: '*' });
  });

  it('cli:command → category="cli:command", name="*"', () => {
    assert.deepEqual(parseFeaturePattern('cli:command'), { categoryGlob: 'cli:command', nameGlob: '*' });
  });

  it("cli:command:'analyze' → strips quotes around name", () => {
    assert.deepEqual(parseFeaturePattern("cli:command:'analyze'"), {
      categoryGlob: 'cli:command',
      nameGlob: 'analyze',
    });
  });

  it('mcp:tool:find_* → category="mcp:tool", name="find_*"', () => {
    assert.deepEqual(parseFeaturePattern('mcp:tool:find_*'), {
      categoryGlob: 'mcp:tool',
      nameGlob: 'find_*',
    });
  });

  it('empty pattern → null', () => {
    assert.equal(parseFeaturePattern(''), null);
    assert.equal(parseFeaturePattern('   '), null);
  });
});

describe('resolveCategories', () => {
  it("cli:* matches 'cli:command'", () => {
    assert.deepEqual(resolveCategories('cli:*'), ['cli:command']);
  });
  it("http:* matches 'http:route'", () => {
    assert.deepEqual(resolveCategories('http:*'), ['http:route']);
  });
  it('exact category passes through', () => {
    assert.deepEqual(resolveCategories('mcp:tool'), ['mcp:tool']);
  });
  it('unmatched category → empty', () => {
    assert.deepEqual(resolveCategories('foo:bar'), []);
  });
});

// ---------------------------------------------------------------------------
// Fixture: full feature graph
// ---------------------------------------------------------------------------
function fullGraph() {
  // Two cli:command features sharing a BEHAVIOR with one mcp:tool.
  // One http:route feature on its own.
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  const contractCli = {
    source: 'commander',
    inputs: [{ name: '--config', type: 'string', optional: true }],
    outputs: [{ description: 'Run analysis' }],
    errors: [],
  };
  const contractMcp = {
    source: 'mcp-inputSchema',
    inputs: [{ name: 'query', type: 'string', optional: false }],
    outputs: [],
    errors: [],
  };
  const contractHttp = {
    source: 'http-route',
    inputs: [{ name: 'id', type: 'string', optional: false, description: 'Path parameter from route' }],
    outputs: [{ description: 'GET /users/:id' }],
    errors: [],
  };

  const nodes = [
    // FEATURE nodes
    { id: 'feat:cli:analyze', type: 'cli:command', name: 'analyze', file: 'a.ts' },
    { id: 'feat:mcp:analyze', type: 'mcp:tool', name: 'analyze_project', file: 'b.ts' },
    { id: 'feat:cli:lonely', type: 'cli:command', name: 'lonely', file: 'c.ts' },
    { id: 'feat:http:get-user', type: 'http:route', name: 'getUser', file: 'r.ts' },
    // SPECED_CONTRACT nodes — RFDB-style: metadata fields spread on top.
    { id: 'feat:cli:analyze::sc', type: 'SPECED_CONTRACT', name: 'analyze', file: 'a.ts', ...contractCli },
    { id: 'feat:mcp:analyze::sc', type: 'SPECED_CONTRACT', name: 'analyze_project', file: 'b.ts', ...contractMcp },
    { id: 'feat:http:get-user::sc', type: 'SPECED_CONTRACT', name: 'getUser', file: 'r.ts', ...contractHttp },
    // BEHAVIOR nodes
    { id: 'beh:cli:analyze', type: 'BEHAVIOR', name: 'analyze', file: 'a.ts', hash: HASH_A, effects: ['IO'], coreNodeCount: 12, depth: 5 },
    { id: 'beh:mcp:analyze', type: 'BEHAVIOR', name: 'analyze_project', file: 'b.ts', hash: HASH_A, effects: ['IO'], coreNodeCount: 12, depth: 5 },
    { id: 'beh:cli:lonely', type: 'BEHAVIOR', name: 'lonely', file: 'c.ts', hash: HASH_B, effects: [], coreNodeCount: 1, depth: 1 },
  ];

  const edges = [
    // HAS_SPECED_CONTRACT
    { src: 'feat:cli:analyze', dst: 'feat:cli:analyze::sc', type: 'HAS_SPECED_CONTRACT' },
    { src: 'feat:mcp:analyze', dst: 'feat:mcp:analyze::sc', type: 'HAS_SPECED_CONTRACT' },
    { src: 'feat:http:get-user', dst: 'feat:http:get-user::sc', type: 'HAS_SPECED_CONTRACT' },
    // IMPLEMENTED_BY
    { src: 'feat:cli:analyze', dst: 'beh:cli:analyze', type: 'IMPLEMENTED_BY' },
    { src: 'feat:mcp:analyze', dst: 'beh:mcp:analyze', type: 'IMPLEMENTED_BY' },
    { src: 'feat:cli:lonely', dst: 'beh:cli:lonely', type: 'IMPLEMENTED_BY' },
    // SHARES_BEHAVIOR_WITH (cli:analyze ↔ mcp:analyze)
    { src: 'beh:cli:analyze', dst: 'beh:mcp:analyze', type: 'SHARES_BEHAVIOR_WITH' },
  ];

  return makeBackend(nodes, edges);
}

// ---------------------------------------------------------------------------
// Snapshot collection
// ---------------------------------------------------------------------------
describe('collectFeatureSnapshots', () => {
  it('collects all cli:* features with contracts, behavior, shared-with', async () => {
    const snapshots = await collectFeatureSnapshots(fullGraph(), 'cli:*');
    // Two cli:command features.
    assert.equal(snapshots.length, 2);

    // Sort order: by name asc → 'analyze', 'lonely'
    assert.equal(snapshots[0].name, 'analyze');
    assert.equal(snapshots[1].name, 'lonely');

    const a = snapshots[0];
    assert.equal(a.category, 'cli:command');
    assert.equal(a.contracts.length, 1);
    assert.equal(a.contracts[0].source, 'commander');
    assert.equal(a.contracts[0].inputs[0].name, '--config');
    assert.ok(a.behavior, 'should have behavior');
    assert.equal(a.behavior.coreNodeCount, 12);
    assert.deepEqual(a.behavior.effects, ['IO']);
    assert.equal(a.sharedBehaviorWith.length, 1);
    assert.equal(a.sharedBehaviorWith[0].category, 'mcp:tool');
    assert.equal(a.sharedBehaviorWith[0].name, 'analyze_project');

    const l = snapshots[1];
    assert.equal(l.contracts.length, 0, 'lonely has no SPECED_CONTRACT');
    assert.ok(l.behavior, 'lonely still has BEHAVIOR');
    assert.equal(l.sharedBehaviorWith.length, 0, 'lonely shares with no one');
  });

  it("exact id pattern cli:command:'analyze' returns only that feature", async () => {
    const snapshots = await collectFeatureSnapshots(fullGraph(), "cli:command:'analyze'");
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].name, 'analyze');
  });

  it('http:* returns the route feature with one path-param input', async () => {
    const snapshots = await collectFeatureSnapshots(fullGraph(), 'http:*');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].category, 'http:route');
    assert.equal(snapshots[0].contracts[0].inputs[0].name, 'id');
  });

  it('parses contract metadata when only stored as JSON-string', async () => {
    // RFDBClient may yield raw nodes where metadata is still a JSON string.
    const nodes = [
      { id: 'f1', type: 'cli:command', name: 'foo', file: 'x.ts' },
      {
        id: 'f1::sc',
        type: 'SPECED_CONTRACT',
        name: 'foo',
        file: 'x.ts',
        // No spread fields — only raw metadata string.
        metadata: JSON.stringify({
          source: 'commander',
          inputs: [{ name: '-v' }],
          outputs: [],
          errors: [],
        }),
      },
    ];
    const edges = [{ src: 'f1', dst: 'f1::sc', type: 'HAS_SPECED_CONTRACT' }];
    const snapshots = await collectFeatureSnapshots(makeBackend(nodes, edges), 'cli:*');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].contracts.length, 1);
    assert.equal(snapshots[0].contracts[0].source, 'commander');
    assert.equal(snapshots[0].contracts[0].inputs[0].name, '-v');
  });

  it('returns empty when pattern matches no category', async () => {
    const snapshots = await collectFeatureSnapshots(fullGraph(), 'foo:*');
    assert.deepEqual(snapshots, []);
  });

  it('returns empty when pattern matches a category but no names match', async () => {
    const snapshots = await collectFeatureSnapshots(fullGraph(), 'cli:command:does_not_exist');
    assert.deepEqual(snapshots, []);
  });
});
