/**
 * Tests for specedContractEnricher (REG-1111 framework).
 *
 * The framework iterates FEATURE-class nodes (cli:command, mcp:tool,
 * vscode:command, package:export, http:route) and dispatches each one to a
 * registered SpecedContractExtractor by category. This test suite uses mock
 * extractors with deterministic data — actual per-category extractors are
 * implemented in follow-up issues (REG-1112/1113/1114/1115).
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { enrichSpecedContracts } from '@grafema/util/enrichers/specedContractEnricher';
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

/** Seed a minimal module/scope scaffold + a FEATURE node. */
async function seedFeature(backend, { file, featureType, featureId, featureName }) {
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
}

/** Build a deterministic mock extractor. */
function makeMockExtractor(category, source, data) {
  return {
    category,
    source,
    extract: async (_client, _feature) => data,
  };
}

/** Build a mock extractor that always returns null. */
function makeNullExtractor(category, source) {
  return {
    category,
    source,
    extract: async () => null,
  };
}

describe('specedContractEnricher', () => {
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

  it('no extractors registered: every FEATURE counts toward featuresWithoutExtractor', async () => {
    await seedFeature(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::feat1',
      featureName: 'analyze',
    });
    await seedFeature(backend, {
      file: 'mcp.ts',
      featureType: 'mcp:tool',
      featureId: 'test::feat2',
      featureName: 'find_nodes',
    });

    const result = await enrichSpecedContracts(client, []);
    assert.equal(result.contractsCreated, 0);
    assert.equal(result.featuresWithoutExtractor, 2);
    assert.equal(result.featuresWithoutSpec, 0);

    const contracts = [];
    for await (const wn of client.queryNodes({ type: 'SPECED_CONTRACT' })) contracts.push(wn);
    assert.equal(contracts.length, 0, 'no SPECED_CONTRACT nodes should be created');
  });

  it('extractor returns null for all features: featuresWithoutSpec incremented, no nodes created', async () => {
    await seedFeature(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::feat1',
      featureName: 'analyze',
    });
    await seedFeature(backend, {
      file: 'cli2.ts',
      featureType: 'cli:command',
      featureId: 'test::feat2',
      featureName: 'serve',
    });

    const extractor = makeNullExtractor('cli:command', 'commander');
    const result = await enrichSpecedContracts(client, [extractor]);

    assert.equal(result.contractsCreated, 0);
    assert.equal(result.featuresWithoutSpec, 2);
    assert.equal(result.featuresWithoutExtractor, 0);

    const contracts = [];
    for await (const wn of client.queryNodes({ type: 'SPECED_CONTRACT' })) contracts.push(wn);
    assert.equal(contracts.length, 0);
  });

  it('mock extractor returns deterministic data: SPECED_CONTRACT created with metadata + edge', async () => {
    await seedFeature(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::feat',
      featureName: 'analyze',
    });

    const data = {
      source: 'commander',
      inputs: [
        { name: '--config', type: 'string', optional: true, description: 'Config path' },
        { name: '--verbose', type: 'boolean', optional: true },
      ],
      outputs: [{ name: 'exitCode', type: 'number' }],
      errors: [{ type: 'AnalysisError', description: 'Analyze failed' }],
    };
    const extractor = makeMockExtractor('cli:command', 'commander', data);

    const result = await enrichSpecedContracts(client, [extractor]);
    assert.equal(result.contractsCreated, 1);
    assert.equal(result.inputsTotal, 2);
    assert.equal(result.outputsTotal, 1);
    assert.equal(result.errorsTotal, 1);
    assert.equal(result.featuresWithoutExtractor, 0);
    assert.equal(result.featuresWithoutSpec, 0);
    assert.deepEqual(result.byCategory, { 'cli:command': 1 });

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    assert.ok(featureWire, 'feature should still exist');
    const has = await getEdges(client, featureWire.id, 'HAS_SPECED_CONTRACT');
    assert.equal(has.length, 1, 'one HAS_SPECED_CONTRACT edge expected');

    // Edge metadata should include source label.
    const edgeMeta = has[0].metadata ? JSON.parse(has[0].metadata) : {};
    const edgeSource =
      edgeMeta.source ??
      /** @type {any} */ (has[0]).source; // base-client may flatten metadata fields
    assert.equal(edgeSource, 'commander');

    const contractNode = await client.getNode(String(has[0].dst));
    assert.ok(contractNode, 'SPECED_CONTRACT node should be readable');
    assert.equal(contractNode.nodeType, 'SPECED_CONTRACT');
    assert.equal(contractNode.name, 'analyze');
    assert.equal(contractNode.file, 'cli.ts');

    const meta = JSON.parse(contractNode.metadata);
    assert.equal(meta.source, 'commander');
    assert.equal(meta.inputs.length, 2);
    assert.equal(meta.inputs[0].name, '--config');
    assert.equal(meta.outputs.length, 1);
    assert.equal(meta.errors.length, 1);
    assert.equal(meta.errors[0].type, 'AnalysisError');
  });

  it('multi-category: two extractors, two categories, byCategory breakdown correct', async () => {
    await seedFeature(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::cli1',
      featureName: 'analyze',
    });
    await seedFeature(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::cli2',
      featureName: 'serve',
    });
    await seedFeature(backend, {
      file: 'mcp.ts',
      featureType: 'mcp:tool',
      featureId: 'test::mcp1',
      featureName: 'find_nodes',
    });

    const cliExtractor = makeMockExtractor('cli:command', 'commander', {
      source: 'commander',
      inputs: [{ name: '--flag' }],
      outputs: [],
      errors: [],
    });
    const mcpExtractor = makeMockExtractor('mcp:tool', 'mcp-inputSchema', {
      source: 'mcp-inputSchema',
      inputs: [{ name: 'query', type: 'string' }, { name: 'limit', type: 'number' }],
      outputs: [{ name: 'nodes', type: 'array' }],
      errors: [],
    });

    const result = await enrichSpecedContracts(client, [cliExtractor, mcpExtractor]);
    assert.equal(result.contractsCreated, 3);
    assert.equal(result.inputsTotal, 1 + 1 + 2); // cli×2 (1 each) + mcp×1 (2)
    assert.equal(result.outputsTotal, 1);
    assert.deepEqual(result.byCategory, { 'cli:command': 2, 'mcp:tool': 1 });

    // Verify mcp contract edge metadata carries 'mcp-inputSchema' source.
    const mcpFeature = await getWireNodeByOriginalId(client, 'test::mcp1', 'mcp:tool');
    const mcpHas = await getEdges(client, mcpFeature.id, 'HAS_SPECED_CONTRACT');
    assert.equal(mcpHas.length, 1);
    const mcpContract = await client.getNode(String(mcpHas[0].dst));
    const mcpMeta = JSON.parse(mcpContract.metadata);
    assert.equal(mcpMeta.source, 'mcp-inputSchema');

    // Verify cli contract carries 'commander' source.
    const cliFeature = await getWireNodeByOriginalId(client, 'test::cli1', 'cli:command');
    const cliHas = await getEdges(client, cliFeature.id, 'HAS_SPECED_CONTRACT');
    const cliContract = await client.getNode(String(cliHas[0].dst));
    const cliMeta = JSON.parse(cliContract.metadata);
    assert.equal(cliMeta.source, 'commander');
  });

  it('idempotent: running twice does not duplicate SPECED_CONTRACT nodes or edges', async () => {
    await seedFeature(backend, {
      file: 'cli.ts',
      featureType: 'cli:command',
      featureId: 'test::feat',
      featureName: 'analyze',
    });

    const extractor = makeMockExtractor('cli:command', 'commander', {
      source: 'commander',
      inputs: [{ name: '--x' }],
      outputs: [],
      errors: [],
    });

    const r1 = await enrichSpecedContracts(client, [extractor]);
    assert.equal(r1.contractsCreated, 1);

    const r2 = await enrichSpecedContracts(client, [extractor]);
    assert.equal(r2.contractsCreated, 1, 'second run should re-upsert the same id');

    // Graph state must not have grown.
    const contracts = [];
    for await (const wn of client.queryNodes({ type: 'SPECED_CONTRACT' })) contracts.push(wn);
    assert.equal(contracts.length, 1, 'no duplicate SPECED_CONTRACT nodes');

    const featureWire = await getWireNodeByOriginalId(client, 'test::feat', 'cli:command');
    const has = await getEdges(client, featureWire.id, 'HAS_SPECED_CONTRACT');
    assert.equal(has.length, 1, 'no duplicate HAS_SPECED_CONTRACT edges');
  });

  it('empty graph: no FEATUREs, all counts zero, no crash', async () => {
    const extractor = makeMockExtractor('cli:command', 'commander', {
      source: 'commander',
      inputs: [],
      outputs: [],
      errors: [],
    });

    const result = await enrichSpecedContracts(client, [extractor]);
    assert.equal(result.contractsCreated, 0);
    assert.equal(result.inputsTotal, 0);
    assert.equal(result.outputsTotal, 0);
    assert.equal(result.errorsTotal, 0);
    assert.equal(result.featuresWithoutExtractor, 0);
    assert.equal(result.featuresWithoutSpec, 0);
    assert.deepEqual(result.byCategory, {});

    const contracts = [];
    for await (const wn of client.queryNodes({ type: 'SPECED_CONTRACT' })) contracts.push(wn);
    assert.equal(contracts.length, 0);
  });
});
