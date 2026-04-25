/**
 * Tests for behaviorEnricher (plan: atomic-purring-rivest Phase C/D).
 *
 * The enricher walks every FEATURE-class node, follows HANDLES → entry
 * function, runs forward-slice dataflow to collect a subgraph, classifies
 * core/periphery via per-file metrics, captures effects via traceEffects,
 * emits a BEHAVIOR node + IMPLEMENTED_BY/COMPRISES/PRODUCES_EFFECT edges,
 * and links FEATUREs that share a behavior hash via SHARES_BEHAVIOR_WITH.
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

  // Annotate a couple of node:fs entries — that's enough for the IO test.
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

/**
 * Seed module + global scope for a file.
 */
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

/**
 * Seed a FUNCTION with a body scope, so findCallsInFunction (Layout A) can
 * walk HAS_SCOPE → CONTAINS → CALL.
 */
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

/**
 * Seed a CALL inside fn's body scope, optionally linked to a callee FUNCTION
 * via CALLS.
 */
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
    // Also direct FUNCTION→CALLS→FUNCTION for traceEffects fallback (Strategy 2).
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

  it('single feature, simple subgraph: BEHAVIOR + COMPRISES edges', async () => {
    const file = 'svc.ts';
    await seedModule(backend, file);

    // FEATURE
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

    const comprises = await getOutgoing(client, behaviorNode.id, 'COMPRISES');
    assert.ok(comprises.length >= 2, `expected >=2 COMPRISES, got ${comprises.length}`);
  });

  it('core/periphery classification: library file goes to periphery', async () => {
    // svc.ts: high-coupling, async/throwing functions → "domain" (core)
    await seedModule(backend, 'svc.ts');
    await seedFunction(backend, { file: 'svc.ts', fnId: 'test::entry', name: 'serve', async: true });
    await seedFunction(backend, { file: 'svc.ts', fnId: 'test::svcB', name: 'helperB', async: true });
    // intra-file CALLS to lift coupling above zero
    await backend.addEdge({ src: 'test::entry', dst: 'test::svcB', type: 'CALLS' });
    await backend.addEdge({ src: 'test::svcB', dst: 'test::entry', type: 'CALLS' });

    // lib/utils.ts: zero coupling, synchronous, no throws → library (periphery)
    await seedModule(backend, 'lib/utils.ts');
    await seedFunction(backend, { file: 'lib/utils.ts', fnId: 'test::lib', name: 'format', async: false });

    // FEATURE → entry → calls helperB and lib.format
    await backend.addNode({
      id: 'test::feat',
      type: 'cli:command',
      name: 'serve-cmd',
      file: 'svc.ts',
      exported: false,
    });
    await backend.addEdge({ src: 'test::feat', dst: 'test::entry', type: 'HANDLES' });
    await seedCall(backend, {
      file: 'svc.ts',
      callId: 'test::call-lib',
      name: 'format',
      fnId: 'test::entry',
      calleeId: 'test::lib',
    });

    const result = await enrichBehaviors(client, emptyLookup);
    assert.equal(result.behaviorsCreated, 1);
    assert.ok(result.totalPeripheryNodes >= 1, `expected >=1 periphery, got ${result.totalPeripheryNodes}`);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    const ib = await getOutgoing(client, featureWire.id, 'IMPLEMENTED_BY');
    const behaviorWireId = String(ib[0].dst);

    const comprises = await getOutgoing(client, behaviorWireId, 'COMPRISES');
    let coreCount = 0;
    let peripheryCount = 0;
    for (const e of comprises) {
      const meta = e.metadata ? (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata) : {};
      // role is at top-level after parseEdge spread, or in metadata
      const role = e.role ?? meta.role;
      if (role === 'core') coreCount++;
      else if (role === 'periphery') peripheryCount++;
    }
    assert.ok(coreCount >= 1, `expected >=1 core role edge, got ${coreCount}`);
    assert.ok(peripheryCount >= 1, `expected >=1 periphery role edge, got ${peripheryCount}`);
  });

  it('effects propagation: PRODUCES_EFFECT edge with metadata.effect', async () => {
    const file = 'io.ts';
    await seedModule(backend, file);
    await backend.addNode({
      id: 'test::feat',
      type: 'cli:command',
      name: 'read-file',
      file,
      exported: false,
    });
    // Mark entry as throwing so direct effects produce THROW.
    await seedFunction(backend, { file, fnId: 'test::entry', name: 'readAction', async: true });
    // Add controlFlow.hasThrow to entry metadata via re-add
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

    // EXTERNAL_MODULE node "fs" so traceEffects looks it up via effects-db.
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
    assert.ok(result.effectEdgesEmitted >= 1, `expected effect edges, got ${result.effectEdgesEmitted}`);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    const ib = await getOutgoing(client, featureWire.id, 'IMPLEMENTED_BY');
    const behaviorWireId = String(ib[0].dst);

    const effects = await getOutgoing(client, behaviorWireId, 'PRODUCES_EFFECT');
    assert.ok(effects.length >= 1);
    const effectNames = new Set();
    for (const e of effects) {
      const meta = e.metadata ? (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata) : {};
      const eff = e.effect ?? meta.effect;
      if (eff) effectNames.add(eff);
    }
    assert.ok(effectNames.has('IO'), `expected IO effect, got ${[...effectNames]}`);

    // BEHAVIOR metadata.effects should also include IO.
    const behavior = await client.getNode(behaviorWireId);
    const bmeta = JSON.parse(behavior.metadata);
    const effList = Array.isArray(bmeta.effects)
      ? bmeta.effects
      : (typeof bmeta.effects === 'string' ? JSON.parse(bmeta.effects) : []);
    assert.ok(effList.includes('IO'), `expected effects array to include IO, got ${effList}`);
  });

  it('two features same behavior: SHARES_BEHAVIOR_WITH bidirectional', async () => {
    const file = 'svc.ts';
    await seedModule(backend, file);
    // Single shared callee — both entries reach the same set of nodes.
    await seedFunction(backend, { file, fnId: 'test::shared', name: 'shared', async: false });

    // Entry A
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

    // Entry B — must reach the SAME set of nodes for hashes to match.
    // Trick: make entryA and entryB both call only `shared`, AND have the same
    // structure. Forward slice from entryA = {entryA, callA, shared}.
    // Forward slice from entryB = {entryB, callB, shared}. Hashes will differ
    // because callA/callB and entryA/entryB have different IDs. To force a
    // collision, point both FEATURES to the same entry.
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

    // Two completely separate slices.
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

  it('periphery cap: peripheryEdgeCap limits COMPRISES to periphery nodes', async () => {
    const file = 'app.ts';
    await seedModule(backend, file);
    // app.ts: domain (entry has async:true and intra-file connections).
    await seedFunction(backend, { file, fnId: 'test::entry', name: 'main', async: true });
    await seedFunction(backend, { file, fnId: 'test::main2', name: 'main2', async: true });
    await backend.addEdge({ src: 'test::entry', dst: 'test::main2', type: 'CALLS' });
    await backend.addEdge({ src: 'test::main2', dst: 'test::entry', type: 'CALLS' });

    // lib.ts: 100 zero-coupling, sync helpers → all periphery.
    const libFile = 'lib.ts';
    await seedModule(backend, libFile);
    for (let i = 0; i < 60; i++) {
      const id = `test::lib-${i}`;
      await seedFunction(backend, { file: libFile, fnId: id, name: `helper${i}`, async: false });
      await seedCall(backend, {
        file,
        callId: `test::call-${i}`,
        name: `helper${i}`,
        fnId: 'test::entry',
        calleeId: id,
      });
    }

    await backend.addNode({
      id: 'test::feat',
      type: 'cli:command',
      name: 'cmd',
      file,
      exported: false,
    });
    await backend.addEdge({ src: 'test::feat', dst: 'test::entry', type: 'HANDLES' });

    const result = await enrichBehaviors(client, emptyLookup, { peripheryEdgeCap: 10 });
    assert.equal(result.behaviorsCreated, 1);
    assert.ok(
      result.totalPeripheryNodes <= 10,
      `expected <=10 periphery edges, got ${result.totalPeripheryNodes}`,
    );
  });
});
