/**
 * crossModalityEquivalence.test.js — Layer 3 of the regression-test infra.
 *
 * For every cluster of FEATUREs that SHARES_BEHAVIOR_WITH each other in the
 * synthetic test fixture, assert their SPECED_CONTRACT inputs/outputs are
 * equivalent (same field names, types, optional flags). Errors are also
 * compared by `type`.
 *
 * The fixture is designed to produce ZERO mismatches against the COMMITTED
 * fixture-divergence allowlist at
 * `test/golden/fixture/cross-modality-divergence.json`. Any failure means
 * the diff/equivalence infrastructure itself has regressed.
 *
 * Production divergence allowlist lives at
 * `test/golden/cross-modality-divergence.json` (live-graph), used by CI
 * release-gate flows — NOT by this test.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { collectContracts } from './regression-helpers/collectContracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIVERGENCE_PATH = join(
  __dirname,
  '..',
  'golden',
  'fixture',
  'cross-modality-divergence.json',
);

after(async () => {
  await cleanupAllTestDatabases();
});

describe('crossModalityEquivalence (Layer 3)', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  let backend;
  let client;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    client = backend.client;
  });

  it('SHARES_BEHAVIOR_WITH clusters have equivalent contracts (or are listed as divergences)', async () => {
    // Seed a cluster: cli:command + mcp:tool with same shape. The graph has
    // a single FEATURE pair sharing a behavior; their contracts are
    // structurally identical so the test must pass with zero mismatches.
    await seedClusterPair(backend);

    const divergences = loadDivergences();
    const { contracts } = await collectContracts(client);
    const clusters = await loadClusters(client);

    assert.ok(
      clusters.length > 0,
      'Fixture must produce at least one SHARES_BEHAVIOR_WITH cluster — ' +
        'collectContracts/cluster traversal regressed.',
    );

    /** @type {string[]} */
    const failures = [];

    for (const cluster of clusters) {
      // Pairwise compare members.
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          const a = cluster[i];
          const b = cluster[j];
          const pairKey = [a, b].sort().join(' || ');
          if (divergences.has(pairKey)) continue;

          const ca = contracts.get(a);
          const cb = contracts.get(b);
          // If either side is missing a contract, we can't compare; skip.
          if (!ca || !cb) continue;

          const mismatches = compareContracts(ca, cb);
          if (mismatches.length > 0) {
            failures.push(`Pair ${pairKey}:\n  ${mismatches.join('\n  ')}`);
          }
        }
      }
    }

    if (failures.length > 0) {
      assert.fail(
        `Cross-modality contract equivalence violated for ${failures.length} pair(s):\n\n` +
          `${failures.join('\n\n')}\n\n` +
          `Fixture-projection drifted from\n` +
          `test/golden/fixture/cross-modality-divergence.json — this indicates\n` +
          `a regression in the cluster/contract equivalence infrastructure.\n` +
          `If the fixture was intentionally changed, regenerate:\n` +
          `  node test/golden/regenerate-fixture-goldens.mjs\n`,
      );
    }
  });
});

/** Load divergence allowlist as Set<pairKey>. */
function loadDivergences() {
  try {
    const raw = readFileSync(DIVERGENCE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const obj = parsed?.divergences ?? {};
    return new Set(Object.keys(obj));
  } catch {
    return new Set();
  }
}

/**
 * Walk SHARES_BEHAVIOR_WITH edges and group connected FEATUREs into
 * clusters. Returns array of arrays of featureKey (`${type}:${name}`).
 */
async function loadClusters(client) {
  // Map wireFeatureId → featureKey, plus inverse.
  const wireToKey = new Map();
  for (const t of ['cli:command', 'mcp:tool', 'vscode:command', 'package:export', 'http:route']) {
    for await (const wn of client.queryNodes({ type: t })) {
      const key = `${wn.nodeType ?? wn.type}:${wn.name ?? ''}`;
      wireToKey.set(String(wn.id), key);
    }
  }

  // Build adjacency.
  const adj = new Map();
  for (const wireId of wireToKey.keys()) {
    const edges = await client.getOutgoingEdges(wireId, ['SHARES_BEHAVIOR_WITH']);
    for (const e of edges) {
      const key = wireToKey.get(String(e.src));
      const otherKey = wireToKey.get(String(e.dst));
      if (!key || !otherKey) continue;
      if (!adj.has(key)) adj.set(key, new Set());
      adj.get(key).add(otherKey);
    }
  }

  // Connected components via BFS.
  const visited = new Set();
  const clusters = [];
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const cluster = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift();
      cluster.push(cur);
      for (const nbr of adj.get(cur) ?? []) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      }
    }
    if (cluster.length >= 2) {
      cluster.sort();
      clusters.push(cluster);
    }
  }
  return clusters;
}

/**
 * Structural equivalence on inputs/outputs/errors. Returns a list of
 * mismatch descriptions (empty if equivalent).
 */
function compareContracts(a, b) {
  const out = [];

  // Inputs: same names, types, optional.
  const aIn = new Map(a.inputs.map((i) => [i.name, i]));
  const bIn = new Map(b.inputs.map((i) => [i.name, i]));
  for (const [n, ai] of aIn) {
    const bi = bIn.get(n);
    if (!bi) {
      out.push(`input missing on B: ${n}`);
      continue;
    }
    if ((ai.type ?? '') !== (bi.type ?? '')) {
      out.push(`input ${n} type differs: A=${ai.type ?? '?'} vs B=${bi.type ?? '?'}`);
    }
    if (!!ai.optional !== !!bi.optional) {
      out.push(`input ${n} optional differs: A=${!!ai.optional} vs B=${!!bi.optional}`);
    }
  }
  for (const n of bIn.keys()) {
    if (!aIn.has(n)) out.push(`input missing on A: ${n}`);
  }

  // Outputs: same name+type set.
  const aOut = new Map(a.outputs.map((o) => [keyOfOutput(o), o]));
  const bOut = new Map(b.outputs.map((o) => [keyOfOutput(o), o]));
  for (const k of aOut.keys()) {
    if (!bOut.has(k)) out.push(`output missing on B: ${k}`);
  }
  for (const k of bOut.keys()) {
    if (!aOut.has(k)) out.push(`output missing on A: ${k}`);
  }

  // Errors by type.
  const aErr = new Set(a.errors.map((e) => e.type));
  const bErr = new Set(b.errors.map((e) => e.type));
  for (const t of aErr) if (!bErr.has(t)) out.push(`error missing on B: ${t}`);
  for (const t of bErr) if (!aErr.has(t)) out.push(`error missing on A: ${t}`);

  return out;
}

function keyOfOutput(o) {
  return `${o.name ?? ''}::${o.type ?? ''}`;
}

/** Seed a 2-feature cluster with structurally identical contracts. */
async function seedClusterPair(backend) {
  const file = 'lib.ts';
  await backend.addNode({
    id: `${file}::module`,
    type: 'MODULE',
    name: file,
    file,
    relativePath: file,
    contentHash: 'h1',
  });

  // Two features.
  await backend.addNode({
    id: 'cli:command:foo',
    type: 'cli:command',
    name: 'foo',
    file,
    exported: false,
  });
  await backend.addNode({
    id: 'mcp:tool:foo',
    type: 'mcp:tool',
    name: 'foo',
    file,
    exported: false,
  });

  // Each gets the same SPECED_CONTRACT shape.
  const data = {
    inputs: [{ name: '--config', type: 'string', optional: true }],
    outputs: [],
    errors: [],
  };
  await backend.addNode({
    id: 'cli:command:foo::specedContract',
    type: 'SPECED_CONTRACT',
    name: 'foo',
    file,
    source: 'commander',
    ...data,
  });
  await backend.addNode({
    id: 'mcp:tool:foo::specedContract',
    type: 'SPECED_CONTRACT',
    name: 'foo',
    file,
    source: 'mcp-inputSchema',
    ...data,
  });
  await backend.addEdge({
    src: 'cli:command:foo',
    dst: 'cli:command:foo::specedContract',
    type: 'HAS_SPECED_CONTRACT',
  });
  await backend.addEdge({
    src: 'mcp:tool:foo',
    dst: 'mcp:tool:foo::specedContract',
    type: 'HAS_SPECED_CONTRACT',
  });

  // SHARES_BEHAVIOR_WITH edges (both directions, mirroring real enricher).
  await backend.addEdge({
    src: 'cli:command:foo',
    dst: 'mcp:tool:foo',
    type: 'SHARES_BEHAVIOR_WITH',
  });
  await backend.addEdge({
    src: 'mcp:tool:foo',
    dst: 'cli:command:foo',
    type: 'SHARES_BEHAVIOR_WITH',
  });
}
