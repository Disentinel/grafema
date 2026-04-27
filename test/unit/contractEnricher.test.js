/**
 * Tests for contractEnricher (plan: atomic-purring-rivest Phase B).
 *
 * The enricher walks every FEATURE-class node (cli:command, mcp:tool,
 * vscode:command), follows its HANDLES edge to the handler FUNCTION, and
 * extracts a CONTRACT node carrying inputs/outputs/errors based on the
 * function's RECEIVES_ARGUMENT, RETURNS, and THROWS edges.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { enrichContracts } from '@grafema/util/enrichers/contractEnricher';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(async () => {
  await cleanupAllTestDatabases();
});

/** Find a single WireNode by its TestRFDB-stored originalId. */
async function getWireNodeByOriginalId(client, originalId, type) {
  for await (const wn of client.queryNodes(type ? { type } : {})) {
    let meta = {};
    try { meta = wn.metadata ? JSON.parse(wn.metadata) : {}; } catch { /* empty */ }
    if (meta.originalId === originalId) return wn;
  }
  return null;
}

async function getEdges(client, srcWireId, edgeType) {
  return client.getOutgoingEdges(srcWireId, [edgeType]);
}

/**
 * Seed a feature + handler scaffold and return the wire IDs of the feature
 * and the handler function.
 *
 * Layout:
 *   FEATURE(featureType, name=featureName)  -- HANDLES --> FUNCTION(handlerName)
 *
 * Both are seeded under module/scope `file`.
 */
async function seedFeatureAndHandler(backend, {
  file,
  featureType,
  featureId,
  featureName,
  handlerId,
  handlerName,
}) {
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

  await backend.addNode({
    id: featureId,
    type: featureType,
    name: featureName,
    file,
    exported: false,
  });
  await backend.addNode({
    id: handlerId,
    type: 'FUNCTION',
    name: handlerName,
    file,
    async: false,
    generator: false,
    exported: false,
    arrowFunction: true,
  });
  await backend.addEdge({ src: featureId, dst: handlerId, type: 'HANDLES' });
}

describe('contractEnricher', () => {
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

  it('feature with simple params: 2 PARAMETERs become 2 ordered inputs', async () => {
    await seedFeatureAndHandler(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::feat',
      featureName: 'analyze',
      handlerId: 'test::handler',
      handlerName: 'analyzeAction',
    });

    // Two parameters: first untyped, second with typeAnnotation
    await backend.addNode({
      id: 'test::param-options',
      type: 'PARAMETER',
      name: 'options',
      file: 'cli.ts',
    });
    await backend.addNode({
      id: 'test::param-args',
      type: 'PARAMETER',
      name: 'args',
      file: 'cli.ts',
      typeAnnotation: 'string[]',
    });
    await backend.addEdge({ src: 'test::handler', dst: 'test::param-options', type: 'RECEIVES_ARGUMENT' });
    await backend.addEdge({ src: 'test::handler', dst: 'test::param-args', type: 'RECEIVES_ARGUMENT' });

    const result = await enrichContracts(client);
    assert.equal(result.contractsCreated, 1);
    assert.equal(result.inputsTotal, 2);
    assert.equal(result.featuresWithoutEntry, 0);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    assert.ok(featureWire, 'feature should still exist');
    const has = await getEdges(client, featureWire.id, 'HAS_CONTRACT');
    assert.equal(has.length, 1, 'one HAS_CONTRACT edge expected');

    const contractNode = await client.getNode(String(has[0].dst));
    assert.ok(contractNode, 'CONTRACT node should be readable');
    assert.equal(contractNode.nodeType, 'CONTRACT');
    assert.equal(contractNode.name, 'analyze');

    const meta = JSON.parse(contractNode.metadata);
    assert.equal(meta.inputs.length, 2);
    assert.equal(meta.inputs[0].name, 'options');
    assert.equal(meta.inputs[0].index, 0);
    assert.equal(meta.inputs[1].name, 'args');
    assert.equal(meta.inputs[1].index, 1);
    assert.equal(meta.inputs[1].typeAnnotation, 'string[]');
    assert.deepEqual(meta.outputs, []);
    assert.deepEqual(meta.errors, []);
  });

  it('feature with returns: RETURNS edge target appears in outputs', async () => {
    await seedFeatureAndHandler(backend, {
      file: 'mcp.ts',
      featureType: 'mcp:tool',
      featureId: 'test::feat',
      featureName: 'find_nodes',
      handlerId: 'test::handler',
      handlerName: 'handleFindNodes',
    });

    await backend.addNode({
      id: 'test::ret-call',
      type: 'CALL',
      name: 'kb.queryNodes',
      file: 'mcp.ts',
    });
    await backend.addEdge({ src: 'test::handler', dst: 'test::ret-call', type: 'RETURNS' });

    const result = await enrichContracts(client);
    assert.equal(result.contractsCreated, 1);
    assert.equal(result.outputsTotal, 1);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'mcp:tool');
    const has = await getEdges(client, featureWire.id, 'HAS_CONTRACT');
    const contractNode = await client.getNode(String(has[0].dst));
    const meta = JSON.parse(contractNode.metadata);

    assert.equal(meta.outputs.length, 1);
    assert.equal(meta.outputs[0].targetType, 'CALL');
    assert.equal(meta.outputs[0].targetName, 'kb.queryNodes');
  });

  it('feature with throws: THROWS edge target appears in errors', async () => {
    await seedFeatureAndHandler(backend, {
      file: 'mcp.ts',
      featureType: 'mcp:tool',
      featureId: 'test::feat',
      featureName: 'find_nodes',
      handlerId: 'test::handler',
      handlerName: 'handleFindNodes',
    });

    // throw new ValidationError("...") — analyzer records the constructor CALL
    await backend.addNode({
      id: 'test::throw-call',
      type: 'CALL',
      name: 'ValidationError',
      file: 'mcp.ts',
      kind: 'new',
    });
    await backend.addEdge({ src: 'test::handler', dst: 'test::throw-call', type: 'THROWS' });

    const result = await enrichContracts(client);
    assert.equal(result.contractsCreated, 1);
    assert.equal(result.errorsTotal, 1);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'mcp:tool');
    const has = await getEdges(client, featureWire.id, 'HAS_CONTRACT');
    const contractNode = await client.getNode(String(has[0].dst));
    const meta = JSON.parse(contractNode.metadata);

    assert.equal(meta.errors.length, 1);
    assert.equal(meta.errors[0].targetType, 'CALL');
    assert.equal(meta.errors[0].targetName, 'ValidationError');
  });

  it('optional parameter: PARAMETER with outgoing ASSIGNED_FROM is marked optional', async () => {
    await seedFeatureAndHandler(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::feat',
      featureName: 'serve',
      handlerId: 'test::handler',
      handlerName: 'serveAction',
    });

    // function serveAction(port = 3000) { ... }
    await backend.addNode({
      id: 'test::param-port',
      type: 'PARAMETER',
      name: 'port',
      file: 'cli.ts',
      typeAnnotation: 'number',
    });
    await backend.addNode({
      id: 'test::default-3000',
      type: 'LITERAL',
      name: '3000',
      file: 'cli.ts',
      value: '3000',
    });
    await backend.addEdge({ src: 'test::handler', dst: 'test::param-port', type: 'RECEIVES_ARGUMENT' });
    await backend.addEdge({ src: 'test::param-port', dst: 'test::default-3000', type: 'ASSIGNED_FROM' });

    const result = await enrichContracts(client);
    assert.equal(result.contractsCreated, 1);
    assert.equal(result.inputsTotal, 1);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    const has = await getEdges(client, featureWire.id, 'HAS_CONTRACT');
    const contractNode = await client.getNode(String(has[0].dst));
    const meta = JSON.parse(contractNode.metadata);

    assert.equal(meta.inputs.length, 1);
    assert.equal(meta.inputs[0].name, 'port');
    assert.equal(meta.inputs[0].optional, true, 'param with ASSIGNED_FROM should be optional');
    assert.equal(meta.inputs[0].typeAnnotation, 'number');
  });

  it('feature without HANDLES: featuresWithoutEntry incremented, no CONTRACT created', async () => {
    // Seed module/scope and a FEATURE node, but NO handler / HANDLES edge.
    await backend.addNode({
      id: 'orphan.ts::module',
      type: 'MODULE',
      name: 'orphan.ts',
      file: 'orphan.ts',
      relativePath: 'orphan.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'orphan.ts::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'orphan.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'orphan.ts::module', dst: 'orphan.ts::scope', type: 'HAS_SCOPE' });

    await backend.addNode({
      id: 'test::orphan',
      type: 'cli:command',
      name: 'orphan',
      file: 'orphan.ts',
      exported: false,
    });

    const result = await enrichContracts(client);
    assert.equal(result.contractsCreated, 0);
    assert.equal(result.featuresWithoutEntry, 1);

    const contracts = [];
    for await (const wn of client.queryNodes({ type: 'CONTRACT' })) contracts.push(wn);
    assert.equal(contracts.length, 0, 'no CONTRACT node should be created');
  });

  it('package:export with FUNCTION target: contract extracted like cli:command', async () => {
    await seedFeatureAndHandler(backend, {
      file: 'pkg.ts',
      featureType: 'package:export',
      featureId: 'test::feat',
      featureName: 'parseConfig',
      handlerId: 'test::handler',
      handlerName: 'parseConfig',
    });

    await backend.addNode({
      id: 'test::param-input',
      type: 'PARAMETER',
      name: 'input',
      file: 'pkg.ts',
      typeAnnotation: 'string',
    });
    await backend.addEdge({ src: 'test::handler', dst: 'test::param-input', type: 'RECEIVES_ARGUMENT' });

    const result = await enrichContracts(client);
    assert.equal(result.contractsCreated, 1);
    assert.equal(result.inputsTotal, 1);
    assert.equal(result.nonCallableTargets, 0);

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'package:export');
    assert.ok(featureWire, 'package:export feature should exist');
    const has = await getEdges(client, featureWire.id, 'HAS_CONTRACT');
    assert.equal(has.length, 1);
  });

  it('package:export with CLASS target: skipped, nonCallableTargets incremented', async () => {
    // Module + scope scaffold.
    await backend.addNode({
      id: 'cls.ts::module',
      type: 'MODULE',
      name: 'cls.ts',
      file: 'cls.ts',
      relativePath: 'cls.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'cls.ts::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'cls.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'cls.ts::module', dst: 'cls.ts::scope', type: 'HAS_SCOPE' });

    // package:export → CLASS (ambiguous semantics; v1 skips).
    await backend.addNode({
      id: 'test::feat',
      type: 'package:export',
      name: 'MyClass',
      file: 'cls.ts',
      exported: true,
    });
    await backend.addNode({
      id: 'test::cls',
      type: 'CLASS',
      name: 'MyClass',
      file: 'cls.ts',
      exported: true,
    });
    await backend.addEdge({ src: 'test::feat', dst: 'test::cls', type: 'HANDLES' });

    const result = await enrichContracts(client);
    assert.equal(result.contractsCreated, 0, 'CLASS target → no contract');
    assert.equal(result.nonCallableTargets, 1);
    assert.equal(result.featuresWithoutEntry, 0, 'entry exists, just non-callable');

    const contracts = [];
    for await (const wn of client.queryNodes({ type: 'CONTRACT' })) contracts.push(wn);
    assert.equal(contracts.length, 0);
  });

  it('idempotent: running twice does not duplicate CONTRACT nodes or HAS_CONTRACT edges', async () => {
    await seedFeatureAndHandler(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::feat',
      featureName: 'analyze',
      handlerId: 'test::handler',
      handlerName: 'analyzeAction',
    });
    await backend.addNode({
      id: 'test::param-x',
      type: 'PARAMETER',
      name: 'x',
      file: 'cli.ts',
    });
    await backend.addEdge({ src: 'test::handler', dst: 'test::param-x', type: 'RECEIVES_ARGUMENT' });

    const r1 = await enrichContracts(client);
    assert.equal(r1.contractsCreated, 1);

    const r2 = await enrichContracts(client);
    assert.equal(r2.contractsCreated, 1, 'second run should report 1 (re-upsert), but…');

    // …regardless of what the result counter says, the graph state must not
    // have grown: still one CONTRACT, still one HAS_CONTRACT edge.
    const contracts = [];
    for await (const wn of client.queryNodes({ type: 'CONTRACT' })) contracts.push(wn);
    assert.equal(contracts.length, 1, 'no duplicate CONTRACT nodes');

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    const has = await getEdges(client, featureWire.id, 'HAS_CONTRACT');
    assert.equal(has.length, 1, 'no duplicate HAS_CONTRACT edges');
  });
});
