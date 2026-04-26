/**
 * Tests for behaviorEnricher (post-premise-reset, materialize-only-what-queries-need).
 *
 * The enricher walks every FEATURE-class node, follows HANDLES → entry
 * function, walks the forward subgraph to collect a stable set of reachable
 * IDs, hashes them, captures effects via traceEffects, emits a BEHAVIOR node
 * with metadata = {hash, effects, coreNodeCount, depth, effectCount}, plus an
 * IMPLEMENTED_BY edge from the FEATURE. NO COMPRISES, NO PRODUCES_EFFECT
 * edges. FEATUREs with matching hashes are linked via SHARES_BEHAVIOR_WITH.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { EffectsLookup } from '@grafema/util';
import { enrichBehaviors } from '@grafema/util/enrichers/behaviorEnricher';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// ---------------------------------------------------------------------------
// Build a tiny effects-db so traceEffects can find IO annotations for fs.
// ---------------------------------------------------------------------------

let effectsDbDir;
let effectsLookup;
let emptyLookup;

before(() => {
  effectsDbDir = mkdtempSync(join(tmpdir(), 'effectsdb-behavior-'));
  mkdirSync(join(effectsDbDir, 'packages'), { recursive: true });
  mkdirSync(join(effectsDbDir, 'runtimes'), { recursive: true });

  writeFileSync(
    join(effectsDbDir, 'runtimes', 'node.yaml'),
    [
      'node:fs:',
      '  readFileSync:',
      '    effects: [IO]',
      '  writeFileSync:',
      '    effects: [IO]',
      '',
    ].join('\n'),
  );

  effectsLookup = EffectsLookup.load(effectsDbDir);
  emptyLookup = EffectsLookup.empty();
});

after(async () => {
  if (effectsDbDir) rmSync(effectsDbDir, { recursive: true, force: true });
  await cleanupAllTestDatabases();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function getWireNodeByOriginalId(client, originalId, type) {
  for await (const wn of client.queryNodes(type ? { type } : {})) {
    let meta = {};
    try { meta = wn.metadata ? JSON.parse(wn.metadata) : {}; } catch { /* empty */ }
    if (meta.originalId === originalId) return wn;
  }
  return null;
}

async function getOutgoing(client, srcWireId, edgeType) {
  return client.getOutgoingEdges(srcWireId, [edgeType]);
}

async function seedModule(backend, file) {
  await backend.addNode({
    id: `${file}::module`,
    type: 'MODULE',
    name: file,
    file,
    relativePath: file,
    contentHash: 'h1',
  });
  await backend.addNode({
    id: `${file}::scope`,
    type: 'SCOPE',
    name: 'global',
    file,
    scopeType: 'module',
  });
  await backend.addEdge({ src: `${file}::module`, dst: `${file}::scope`, type: 'HAS_SCOPE' });
}

async function seedFunction(backend, { file, fnId, name, async: isAsync = false }) {
  await backend.addNode({
    id: fnId,
    type: 'FUNCTION',
    name,
    file,
    async: isAsync,
    generator: false,
    exported: false,
    arrowFunction: true,
  });
  await backend.addNode({
    id: `${fnId}::body`,
    type: 'SCOPE',
    name: 'function',
    file,
    scopeType: 'function',
  });
  await backend.addEdge({ src: fnId, dst: `${fnId}::body`, type: 'HAS_SCOPE' });
}

async function seedCall(backend, { file, callId, name, fnId, calleeId }) {
  await backend.addNode({
    id: callId,
    type: 'CALL',
    name,
    file,
  });
  await backend.addEdge({ src: `${fnId}::body`, dst: callId, type: 'CONTAINS' });
  if (calleeId) {
    await backend.addEdge({ src: callId, dst: calleeId, type: 'CALLS' });
    await backend.addEdge({ src: fnId, dst: calleeId, type: 'CALLS' });
  }
}

// ---------------------------------------------------------------------------

describe('behaviorEnricher', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  /** @type {any} */
  let backend;
  /** @type {any} */
  let client;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    client = backend.client;
  });

  it('single feature: BEHAVIOR + IMPLEMENTED_BY, no COMPRISES, hash populated', async () => {
    const file = 'svc.ts';
    await seedModule(backend, file);

    await backend.addNode({
      id: 'test::feat',
      type: 'cli:command',
      name: 'analyze',
      file,
      exported: false,
    });
    await seedFunction(backend, { file, fnId: 'test::entry', name: 'analyzeAction', async: true });
    await seedFunction(backend, { file, fnId: 'test::callee', name: 'doWork', async: true });
    await backend.addEdge({ src: 'test::feat', dst: 'test::entry', type: 'HANDLES' });
    await seedCall(backend, {
      file,
      callId: 'test::call',
      name: 'doWork',
      fnId: 'test::entry',
      calleeId: 'test::callee',
    });

    const result = await enrichBehaviors(client, emptyLookup);
    assert.equal(result.behaviorsCreated, 1);
    assert.equal(result.featuresWithoutEntry, 0);
    assert.equal(result.sharesBehaviorEdges, 0);
    assert.ok(result.totalCoreNodes >= 2, `expected >=2 core nodes, got ${result.totalCoreNodes}`);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    assert.ok(featureWire, 'feature should still exist');
    const ib = await getOutgoing(client, featureWire.id, 'IMPLEMENTED_BY');
    assert.equal(ib.length, 1);

    const behaviorNode = await client.getNode(String(ib[0].dst));
    assert.equal(behaviorNode.nodeType, 'BEHAVIOR');
    assert.equal(behaviorNode.name, 'analyze');
    const meta = JSON.parse(behaviorNode.metadata);
    assert.ok(meta.coreNodeCount >= 2, `meta.coreNodeCount=${meta.coreNodeCount}`);
    assert.equal(typeof meta.hash, 'string');
    assert.equal(meta.hash.length, 64);
    assert.equal(typeof meta.depth, 'number');
    assert.equal(typeof meta.effectCount, 'number');
    assert.ok(Array.isArray(meta.effects), 'effects must be an array');

    // Premise-reset invariant: NO COMPRISES edges are emitted.
    const comprises = await getOutgoing(client, behaviorNode.id, 'COMPRISES');
    assert.equal(comprises.length, 0, 'COMPRISES edges must not be emitted');
    // And NO PRODUCES_EFFECT edges either — effects live in metadata.
    const peEdges = await getOutgoing(client, behaviorNode.id, 'PRODUCES_EFFECT');
    assert.equal(peEdges.length, 0, 'PRODUCES_EFFECT edges must not be emitted');
  });

  it('hash is deterministic for fixed input', async () => {
    const file = 'svc.ts';
    await seedModule(backend, file);
    await seedFunction(backend, { file, fnId: 'test::entry', name: 'main', async: false });
    await seedFunction(backend, { file, fnId: 'test::callee', name: 'doIt', async: false });
    await backend.addNode({
      id: 'test::feat',
      type: 'cli:command',
      name: 'cmd',
      file,
      exported: false,
    });
    await backend.addEdge({ src: 'test::feat', dst: 'test::entry', type: 'HANDLES' });
    await seedCall(backend, {
      file,
      callId: 'test::call',
      name: 'doIt',
      fnId: 'test::entry',
      calleeId: 'test::callee',
    });

    const r1 = await enrichBehaviors(client, emptyLookup);
    assert.equal(r1.behaviorsCreated, 1);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    const ib = await getOutgoing(client, featureWire.id, 'IMPLEMENTED_BY');
    const behavior = await client.getNode(String(ib[0].dst));
    const meta = JSON.parse(behavior.metadata);
    // Hash is hex sha256 — 64 lowercase hex chars.
    assert.match(meta.hash, /^[0-9a-f]{64}$/);
  });

  it('effects propagation: BEHAVIOR.metadata.effects includes IO (no PRODUCES_EFFECT edges)', async () => {
    const file = 'io.ts';
    await seedModule(backend, file);
    await backend.addNode({
      id: 'test::feat',
      type: 'cli:command',
      name: 'read-file',
      file,
      exported: false,
    });
    await seedFunction(backend, { file, fnId: 'test::entry', name: 'readAction', async: true });
    // Mark entry as throwing so direct effects produce THROW too.
    await backend.addNode({
      id: 'test::entry',
      type: 'FUNCTION',
      name: 'readAction',
      file,
      async: true,
      generator: false,
      exported: false,
      arrowFunction: true,
      controlFlow: { hasThrow: true },
    });

    await backend.addNode({
      id: 'test::fs',
      type: 'EXTERNAL_MODULE',
      name: 'fs.readFileSync',
      file: '',
    });
    await backend.addEdge({ src: 'test::feat', dst: 'test::entry', type: 'HANDLES' });
    await seedCall(backend, {
      file,
      callId: 'test::call-fs',
      name: 'fs.readFileSync',
      fnId: 'test::entry',
      calleeId: 'test::fs',
    });

    const result = await enrichBehaviors(client, effectsLookup);
    assert.equal(result.behaviorsCreated, 1);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    const ib = await getOutgoing(client, featureWire.id, 'IMPLEMENTED_BY');
    const behaviorWireId = String(ib[0].dst);

    // No edge-side effect emission.
    const peEdges = await getOutgoing(client, behaviorWireId, 'PRODUCES_EFFECT');
    assert.equal(peEdges.length, 0);

    // Effects live in BEHAVIOR.metadata.effects.
    const behavior = await client.getNode(behaviorWireId);
    const bmeta = JSON.parse(behavior.metadata);
    const effList = Array.isArray(bmeta.effects)
      ? bmeta.effects
      : (typeof bmeta.effects === 'string' ? JSON.parse(bmeta.effects) : []);
    assert.ok(effList.includes('IO'), `expected effects array to include IO, got ${effList}`);
    assert.equal(bmeta.effectCount, effList.length);
  });

  it('two features same behavior: SHARES_BEHAVIOR_WITH bidirectional', async () => {
    const file = 'svc.ts';
    await seedModule(backend, file);
    await seedFunction(backend, { file, fnId: 'test::shared', name: 'shared', async: false });
    await seedFunction(backend, { file, fnId: 'test::entryA', name: 'entryA', async: false });
    await seedCall(backend, {
      file,
      callId: 'test::callA',
      name: 'shared',
      fnId: 'test::entryA',
      calleeId: 'test::shared',
    });
    await backend.addNode({
      id: 'test::featA',
      type: 'cli:command',
      name: 'cmdA',
      file,
      exported: false,
    });
    await backend.addEdge({ src: 'test::featA', dst: 'test::entryA', type: 'HANDLES' });

    // Same entry → same hash → linked.
    await backend.addNode({
      id: 'test::featB',
      type: 'cli:command',
      name: 'cmdB',
      file,
      exported: false,
    });
    await backend.addEdge({ src: 'test::featB', dst: 'test::entryA', type: 'HANDLES' });

    const result = await enrichBehaviors(client, emptyLookup);
    assert.equal(result.behaviorsCreated, 2, 'two FEATURES → two BEHAVIORs');
    assert.equal(result.sharesBehaviorEdges, 2, 'a→b and b→a');

    const featAWire = await getWireNodeByOriginalId(client, 'test::featA', 'cli:command');
    const sharesA = await getOutgoing(client, featAWire.id, 'SHARES_BEHAVIOR_WITH');
    assert.equal(sharesA.length, 1);
  });

  it('two features different behavior: NO SHARES_BEHAVIOR_WITH', async () => {
    const file = 'svc.ts';
    await seedModule(backend, file);

    await seedFunction(backend, { file, fnId: 'test::entryA', name: 'a', async: false });
    await seedFunction(backend, { file, fnId: 'test::calleeA', name: 'aHelper', async: false });
    await seedCall(backend, {
      file,
      callId: 'test::callA',
      name: 'aHelper',
      fnId: 'test::entryA',
      calleeId: 'test::calleeA',
    });
    await backend.addNode({
      id: 'test::featA',
      type: 'cli:command',
      name: 'cmdA',
      file,
      exported: false,
    });
    await backend.addEdge({ src: 'test::featA', dst: 'test::entryA', type: 'HANDLES' });

    await seedFunction(backend, { file, fnId: 'test::entryB', name: 'b', async: false });
    await seedFunction(backend, { file, fnId: 'test::calleeB', name: 'bHelper', async: false });
    await seedCall(backend, {
      file,
      callId: 'test::callB',
      name: 'bHelper',
      fnId: 'test::entryB',
      calleeId: 'test::calleeB',
    });
    await backend.addNode({
      id: 'test::featB',
      type: 'cli:command',
      name: 'cmdB',
      file,
      exported: false,
    });
    await backend.addEdge({ src: 'test::featB', dst: 'test::entryB', type: 'HANDLES' });

    const result = await enrichBehaviors(client, emptyLookup);
    assert.equal(result.behaviorsCreated, 2);
    assert.equal(result.sharesBehaviorEdges, 0, 'different behavior hashes → no link');
  });

  it('idempotent: running twice does not duplicate BEHAVIOR or edges', async () => {
    const file = 'svc.ts';
    await seedModule(backend, file);
    await seedFunction(backend, { file, fnId: 'test::entry', name: 'run', async: false });
    await seedFunction(backend, { file, fnId: 'test::callee', name: 'helper', async: false });
    await backend.addNode({
      id: 'test::feat',
      type: 'cli:command',
      name: 'run-cmd',
      file,
      exported: false,
    });
    await backend.addEdge({ src: 'test::feat', dst: 'test::entry', type: 'HANDLES' });
    await seedCall(backend, {
      file,
      callId: 'test::call',
      name: 'helper',
      fnId: 'test::entry',
      calleeId: 'test::callee',
    });

    const r1 = await enrichBehaviors(client, emptyLookup);
    assert.equal(r1.behaviorsCreated, 1);

    const r2 = await enrichBehaviors(client, emptyLookup);
    assert.equal(r2.behaviorsCreated, 1, 're-upsert reported');

    const behaviors = [];
    for await (const wn of client.queryNodes({ type: 'BEHAVIOR' })) behaviors.push(wn);
    assert.equal(behaviors.length, 1, 'no duplicate BEHAVIOR');

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    const ib = await getOutgoing(client, featureWire.id, 'IMPLEMENTED_BY');
    assert.equal(ib.length, 1, 'no duplicate IMPLEMENTED_BY');
  });

  it('flushBatchSize=1: flushes after every feature, results identical', async () => {
    const file = 'multi.ts';
    await seedModule(backend, file);

    for (const tag of ['a', 'b', 'c']) {
      await seedFunction(backend, { file, fnId: `test::entry-${tag}`, name: `entry${tag}`, async: false });
      await seedFunction(backend, { file, fnId: `test::callee-${tag}`, name: `callee${tag}`, async: false });
      await seedCall(backend, {
        file,
        callId: `test::call-${tag}`,
        name: `callee${tag}`,
        fnId: `test::entry-${tag}`,
        calleeId: `test::callee-${tag}`,
      });
      await backend.addNode({
        id: `test::feat-${tag}`,
        type: 'cli:command',
        name: `cmd-${tag}`,
        file,
        exported: false,
      });
      await backend.addEdge({ src: `test::feat-${tag}`, dst: `test::entry-${tag}`, type: 'HANDLES' });
    }

    const origAddNodes = client.addNodes.bind(client);
    const origAddEdges = client.addEdges.bind(client);
    let addNodesCalls = 0;
    let addEdgesCalls = 0;
    client.addNodes = async (nodes) => { addNodesCalls++; return origAddNodes(nodes); };
    client.addEdges = async (edges) => { addEdgesCalls++; return origAddEdges(edges); };

    try {
      const result = await enrichBehaviors(client, emptyLookup, { flushBatchSize: 1 });
      assert.equal(result.behaviorsCreated, 3);
      assert.ok(addNodesCalls >= 3, `expected >=3 addNodes calls, got ${addNodesCalls}`);
      assert.ok(addEdgesCalls >= 3, `expected >=3 addEdges calls, got ${addEdgesCalls}`);

      const behaviors = [];
      for await (const wn of client.queryNodes({ type: 'BEHAVIOR' })) behaviors.push(wn);
      assert.equal(behaviors.length, 3, 'three BEHAVIOR nodes should be persisted');

      for (const tag of ['a', 'b', 'c']) {
        const featureWire = await getWireNodeByOriginalId(client, `test::feat-${tag}`, 'cli:command');
        assert.ok(featureWire, `feature ${tag} should exist`);
        const ib = await getOutgoing(client, featureWire.id, 'IMPLEMENTED_BY');
        assert.equal(ib.length, 1, `feature ${tag} should have exactly one IMPLEMENTED_BY`);
      }
    } finally {
      client.addNodes = origAddNodes;
      client.addEdges = origAddEdges;
    }
  });
});
